// اجرای هر نوع کار — همان چیزی که server/helper-jobs.js در حالت «محلی» انجام می‌دهد.
// هیچ‌کدام محتوای خوانای مدرسه را باز نمی‌کند (D-21).

import 'dart:async';
import 'dart:io';
import 'dart:isolate';

import 'package:crypto/crypto.dart';

import '../local/s3_client.dart';
import 'helper_box.dart';

/// بررسی یک آدرس از همین دستگاه (در آزمون‌ها جعلی).
typedef EndpointProbe = Future<Map<String, Object?>> Function(Uri url);

/// پیدا کردن IPهای یک نام (در آزمون‌ها جعلی).
typedef AddressLookup = Future<List<String>> Function(String host);

Future<List<String>> _systemLookup(String host) async {
  final r = await InternetAddress.lookup(host);
  return [for (final a in r) a.address];
}

/// HEAD بدون دنبال کردن تغییر مسیر، فقط به IP عمومیِ بررسی‌شده (جلوگیری از کاوش شبکهٔ داخلی
/// و DNS rebinding: اتصال مستقیم به همان IP که بررسی شد).
Future<Map<String, Object?>> probeEndpoint(
  Uri url, {
  AddressLookup lookup = _systemLookup,
  Duration timeout = const Duration(seconds: 8),
  bool allowPrivate = false,
}) async {
  final host = url.host;
  List<String> addrs;
  try {
    addrs = InternetAddress.tryParse(host) != null
        ? [host]
        : await lookup(host).timeout(timeout);
  } on Object {
    addrs = const [];
  }
  if (addrs.isEmpty) return {'reachable': false, 'error': 'dns'};
  if (!allowPrivate && !addrs.every(isPublicIp)) {
    return {'reachable': false, 'error': 'private_address'};
  }
  final target = InternetAddress(addrs.first);
  final sw = Stopwatch()..start();
  final client = HttpClient(context: ownerTrustContext())
    ..connectionTimeout = timeout
    ..findProxy = (_) => 'DIRECT';
  client.connectionFactory = (uri, _, _) async {
    final task = await Socket.startConnect(target, uri.port);
    if (uri.scheme != 'https') return task;
    return ConnectionTask.fromSocket(
      task.socket.then(
        (s) => SecureSocket.secure(
          s,
          host: uri.host,
          context: ownerTrustContext(),
        ),
      ),
      task.cancel,
    );
  };
  try {
    final req = await client.openUrl('HEAD', url).timeout(timeout);
    req.followRedirects = false;
    final res = await req.close().timeout(timeout);
    await res.drain<void>().timeout(timeout);
    return {
      'reachable': res.statusCode < 500,
      'status': res.statusCode,
      'ms': sw.elapsedMilliseconds,
    };
  } on TimeoutException {
    return {
      'reachable': false,
      'error': 'timeout',
      'ms': sw.elapsedMilliseconds,
    };
  } on Object catch (e) {
    final code = e is SocketException
        ? 'network'
        : e is HandshakeException
        ? 'tls'
        : 'network';
    return {'reachable': false, 'error': code, 'ms': sw.elapsedMilliseconds};
  } finally {
    client.close(force: true);
  }
}

/// اجرای یک کار روی همین دستگاه.
final class JobExecutor {
  JobExecutor({
    required this.transport,
    this.bigTransport,
    DateTime Function()? now,
    EndpointProbe? probe,
  }) : _now = now ?? DateTime.now,
       _probe = probe ?? ((u) => probeEndpoint(u));

  /// اتصال برای کارهای کوچک (فهرست، حذف).
  final S3Transport Function() transport;

  /// اتصال برای خواندن فایل‌های بزرگ (object.verify)؛ پیش‌فرض: IoS3Transport با سقف ۵۱۲ مگابایت.
  final S3Transport Function()? bigTransport;
  final DateTime Function() _now;
  final EndpointProbe _probe;

  static const int maxVerifyBytes = 512 * 1024 * 1024;

  Future<Map<String, Object?>> run(
    S3Settings s3,
    String kind,
    Object? params,
  ) async {
    final p = validJobParams(kind, params);
    switch (kind) {
      case 'storage.usage':
        return _usage(s3, p['prefix']! as String);
      case 'object.verify':
        return _verify(s3, p);
      case 'endpoint.check':
        return _probe(Uri.parse(p['url']! as String));
      case 'bucket.gc':
        return gc(s3);
    }
    throw JobRejected('unknown_kind', kind);
  }

  Future<Map<String, Object?>> _usage(S3Settings s3, String prefix) async {
    final t = transport();
    try {
      final (objs, truncated) = await s3ListObjects(s3, t, prefix);
      final groups = <String, Map<String, int>>{};
      var bytes = 0;
      for (final o in objs) {
        final rest = o.key.substring(prefix.length);
        final i = rest.indexOf('/');
        final g = i < 0 ? '(root)' : rest.substring(0, i);
        final m = groups.putIfAbsent(g, () => {'objects': 0, 'bytes': 0});
        m['objects'] = m['objects']! + 1;
        m['bytes'] = m['bytes']! + o.size;
        bytes += o.size;
      }
      return {
        'objects': objs.length,
        'bytes': bytes,
        'groups': groups,
        'truncated': truncated,
      };
    } finally {
      t.close();
    }
  }

  Future<Map<String, Object?>> _verify(
    S3Settings s3,
    Map<String, Object?> p,
  ) async {
    final t =
        bigTransport?.call() ??
        IoS3Transport(
          maxBytes: maxVerifyBytes,
          timeout: const Duration(minutes: 2),
        );
    try {
      final want = p.containsKey('sha256') || p.containsKey('size');
      final b = await s3GetBytes(s3, t, p['key']! as String);
      if (b == null) {
        return {
          'exists': false,
          'size': 0,
          'sha256': null,
          'match': want ? false : null,
        };
      }
      // هش در Isolate جدا: پنجرهٔ برنامه کند نمی‌شود
      final sha = await Isolate.run(() => sha256.convert(b).toString());
      return {
        'exists': true,
        'size': b.length,
        'sha256': sha,
        'match': want
            ? ((p['sha256'] == null || p['sha256'] == sha) &&
                  (p['size'] == null || p['size'] == b.length))
            : null,
      };
    } finally {
      t.close();
    }
  }

  /// پاک کردن فایل‌های کهنهٔ صف، حضورهای قدیمی و آینهٔ کهنهٔ به‌روزرسانی.
  /// پاکتِ کلید دیگر (نامعتبر برای ما) دست‌نخورده می‌ماند.
  Future<Map<String, Object?>> gc(S3Settings s3) async {
    final now = _now();
    final t = transport();
    var jobs = 0, helpers = 0, blobs = 0;
    try {
      for (final d in [HelperDirs.req, HelperDirs.lease, HelperDirs.res]) {
        final (objs, _) = await s3ListObjects(
          s3,
          t,
          '$helperRoot$d',
          maxPages: 5,
        );
        for (final o in objs) {
          final id = nameOfKey(o.key);
          final old =
              !jobIdRe.hasMatch(id) ||
              now.millisecondsSinceEpoch - jobIdMillis(id) >
                  gcJobAge.inMilliseconds;
          if (old) {
            await s3Delete(s3, t, o.key);
            jobs++;
          }
        }
      }
      final (hs, _) = await s3ListObjects(
        s3,
        t,
        '$helperRoot${HelperDirs.helpers}',
        maxPages: 2,
      );
      for (final o in hs) {
        final text = await s3GetText(s3, t, o.key);
        if (text == null) continue;
        final p = await openHelper(s3.secretKey, HelperKinds.presence, text);
        if (p == null) continue; // کلید دیگر: مال ما نیست
        final at = p['at'];
        if (at is int &&
            now.millisecondsSinceEpoch - at <= gcHelperAge.inMilliseconds) {
          continue;
        }
        await s3Delete(s3, t, o.key);
        helpers++;
      }
      final (bs, _) = await s3ListObjects(
        s3,
        t,
        '${helperRoot}updates/owner/',
        maxPages: 5,
      );
      for (final o in bs) {
        final m = o.modified;
        if (m != null && now.difference(m) > gcBlobAge) {
          await s3Delete(s3, t, o.key);
          blobs++;
        }
      }
    } finally {
      t.close();
    }
    return {
      'deleted_jobs': jobs,
      'deleted_helpers': helpers,
      'deleted_blobs': blobs,
    };
  }
}
