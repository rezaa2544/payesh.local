// پایداری اتصال + چراغ‌های نوار بالا + نسخه (درخواست ۱۴۰۵/۰۸/۲۲).

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/local/local_platform.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_owner/src/net/resilience.dart';
import 'package:payesh_owner/src/status/status_lights.dart';
import 'package:payesh_owner/src/update/owner_update.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_ui/payesh_ui.dart';

/// پاسخ هر میزبان جدا اسکریپت می‌شود؛ پاسخ آخر هر میزبان تکرار می‌شود.
final class HostScript implements S3Transport, ResettableTransport {
  HostScript(this.script);
  final Map<String, List<Object>> script;
  final calls = <(String host, String hostHeader)>[];
  int resets = 0;

  @override
  Future<S3Response> send(
    String method,
    Uri url,
    Map<String, String> headers, [
    List<int>? body,
  ]) async {
    calls.add((url.host, headers['host']!));
    final list = script[url.host] ?? [const SocketException('no route')];
    final r = list.length > 1 ? list.removeAt(0) : list.first;
    if (r is S3Response) return r;
    throw r;
  }

  @override
  void reset() => resets++;

  @override
  void close() {}
}

const _ir = 's3.ir-central1.arvanstorage.ir';
const _com = 's3.ir-central1.arvanstorage.com';
const _old = 's3.ir-thr-at1.arvanstorage.ir';

S3Settings _s(String host) => S3Settings(
  endpoint: Uri(scheme: 'https', host: host),
  accessKey: 'ak-test',
  secretKey: 'sk-test',
  bucket: 'payesh-madrese',
);

const _ok = S3Response(
  200,
  '<ListAllMyBucketsResult></ListAllMyBucketsResult>',
);

void main() {
  setUp(() {
    EndpointRoutes.reset();
    s3RetryPolicy = const RetryPolicy(
      attempts: 3,
      base: Duration(milliseconds: 1),
      max: Duration(milliseconds: 2),
    );
  });
  tearDown(() => s3RetryPolicy = const RetryPolicy());

  group('سیاست تلاش دوباره', () {
    test('فاصلهٔ نمایی با لرزش و سقف', () {
      const p = RetryPolicy(
        base: Duration(milliseconds: 400),
        max: Duration(seconds: 4),
      );
      final r = Random(7);
      for (var i = 0; i < 50; i++) {
        final d = p.delayFor(0, r).inMilliseconds;
        expect(d, inInclusiveRange(200, 400));
        final d3 = p.delayFor(3, r).inMilliseconds; // 3.2s
        expect(d3, inInclusiveRange(1600, 3200));
        final big = p.delayFor(30, r).inMilliseconds; // سقف 4s
        expect(big, inInclusiveRange(2000, 4000));
      }
    });

    test(
      'خطای گذرا ⇒ دوباره؛ غیرگذرا ⇒ فوری؛ تمام شدن تلاش‌ها ⇒ همان خطا',
      () async {
        var n = 0;
        final v = await withRetry((_) async {
          if (++n < 3) throw const SocketException('reset');
          return 'ok';
        }, sleep: (_) async {});
        expect((v, n), ('ok', 3));

        n = 0;
        await expectLater(
          withRetry<void>((_) async {
            n++;
            throw const FormatException('bad');
          }, sleep: (_) async {}),
          throwsFormatException,
        );
        expect(n, 1);

        n = 0;
        await expectLater(
          withRetry<void>(
            (_) async {
              n++;
              throw TimeoutException('slow');
            },
            policy: const RetryPolicy(attempts: 4),
            sleep: (_) async {},
          ),
          throwsA(isA<TimeoutException>()),
        );
        expect(n, 4);
      },
    );

    test('دسته‌بندی خطاها', () {
      expect(isTransientNetworkError(const SocketException('x')), isTrue);
      expect(isTransientNetworkError(TimeoutException('x')), isTrue);
      expect(isTransientNetworkError(const HttpException('closed')), isTrue);
      expect(
        isTransientNetworkError(const HandshakeException('connection reset')),
        isTrue,
      );
      expect(
        isTransientNetworkError(
          const HandshakeException('CERTIFICATE_VERIFY_FAILED'),
        ),
        isFalse,
      );
      expect(isTransientNetworkError(const FormatException('x')), isFalse);
      expect(isTransientStatus(503), isTrue);
      expect(isTransientStatus(429), isTrue);
      expect(isTransientStatus(403), isFalse);
      expect(isTransientStatus(404), isFalse);
    });
  });

  group('آدرس‌های جایگزین', () {
    test('آروان: .ir/.com و نام قدیمی/جدید ناحیه؛ بقیه هیچ', () {
      expect(
        s3EndpointAlternates(Uri.parse('https://$_ir')).map((u) => u.host),
        [_com, _old, 's3.ir-thr-at1.arvanstorage.com'],
      );
      expect(
        s3EndpointAlternates(Uri.parse('https://s3.ir-tbz-sh1.arvanstorage.ir'))
            .map((u) => u.host),
        ['s3.ir-tbz-sh1.arvanstorage.com'],
      );
      expect(
        s3EndpointAlternates(Uri.parse('https://minio.example.ir')),
        <Uri>[],
      );
      expect(regionFor(Uri.parse('https://$_com')), 'ir-central1');
    });

    test('ترتیب: آخرین آدرس سالم اول', () {
      String k(String s) => s;
      expect(EndpointRoutes.order('a', ['b', 'c', 'a'], k), ['a', 'b', 'c']);
      EndpointRoutes.good('a', 'c');
      expect(EndpointRoutes.order('a', ['b', 'c'], k), ['c', 'a', 'b']);
      EndpointRoutes.good('a', 'a');
      expect(EndpointRoutes.order('a', ['b', 'c'], k), ['a', 'b', 'c']);
    });
  });

  group('s3Request پایدار', () {
    test('قطع لحظه‌ای ⇒ با اتصال تازه دوباره و موفق', () async {
      final t = HostScript({
        _ir: [const HttpException('Connection closed'), _ok],
      });
      final r = await testS3Connection(_s(_ir), t);
      expect(r.ok, isTrue);
      expect(t.calls.map((c) => c.$1), [_ir, _ir]);
      expect(t.resets, 1);
    });

    test('۵۰۳ گذرا ⇒ دوباره؛ ۵۰۳ پیاپی ⇒ پیام فارسی با کد', () async {
      final t = HostScript({
        _ir: [
          const S3Response(503, '<Error><Code>SlowDown</Code></Error>'),
          _ok,
        ],
      });
      expect((await testS3Connection(_s(_ir), t)).ok, isTrue);
      expect(t.calls, hasLength(2));

      final t2 = HostScript({
        _ir: [const S3Response(503, '')],
      });
      final r2 = await testS3Connection(_s(_ir), t2);
      expect(r2.error, contains('کد 503'));
      expect(t2.calls, hasLength(3)); // آدرس در دسترس بود ⇒ جایگزین لازم نیست
    });

    test('۴۰۳ ⇒ بدون تلاش دوباره', () async {
      final t = HostScript({
        _ir: [
          const S3Response(
            403,
            '<Error><Code>SignatureDoesNotMatch</Code></Error>',
          ),
        ],
      });
      expect(
        (await testS3Connection(_s(_ir), t)).error,
        contains('Secret Key'),
      );
      expect(t.calls, hasLength(1));
    });

    test('آدرس تنظیم‌شده در دسترس نیست ⇒ جایگزین؛ دفعهٔ بعد اول همان (بدون تغییر دستی آدرس)', () async {
      final t = HostScript({
        _ir: [const SocketException('Failed host lookup')],
        _com: [_ok],
      });
      expect((await testS3Connection(_s(_ir), t)).ok, isTrue);
      expect(t.calls.map((c) => c.$1), [_ir, _ir, _ir, _com]);
      // امضا با همان میزبانی که واقعاً صدا زده شد
      expect(t.calls.last.$2, _com);

      t.calls.clear();
      expect((await testS3Connection(_s(_ir), t)).ok, isTrue);
      expect(t.calls.map((c) => c.$1), [_com]);
    });

    test('همه در دسترس نیستند ⇒ پیام خطای شبکه (نه پاسخ یک جایگزین)', () async {
      final t = HostScript({
        _ir: [TimeoutException('slow')],
        _com: [
          const S3Response(403, '<Error><Code>AccessDenied</Code></Error>'),
        ],
      });
      final r = await testS3Connection(_s(_ir), t);
      expect(r.ok, isFalse);
      expect(r.error, contains('مهلت'));
    });

    test(
      'گواهی نامعتبر ⇒ همان آدرس دوباره امتحان نمی‌شود، جایگزین بله',
      () async {
        final t = HostScript({
          _ir: [const HandshakeException('CERTIFICATE_VERIFY_FAILED')],
          _com: [const HandshakeException('CERTIFICATE_VERIFY_FAILED')],
          _old: [const HandshakeException('CERTIFICATE_VERIFY_FAILED')],
          's3.ir-thr-at1.arvanstorage.com': [
            const HandshakeException('CERTIFICATE_VERIFY_FAILED'),
          ],
        });
        final r = await testS3Connection(_s(_ir), t);
        expect(r.error, contains('TLS'));
        expect(t.calls.where((c) => c.$1 == _ir), hasLength(1));
        expect(t.calls, hasLength(4));
      },
    );
  });

  group('IoS3Transport (اتصال واقعی)', () {
    late HttpServer server;
    var hits = 0;
    var dropFirst = false;

    setUp(() async {
      HttpOverrides.global = null;
      hits = 0;
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((req) async {
        hits++;
        if (dropFirst && hits == 1) {
          // سرور اتصال را وسط کار می‌بندد (مثل keep-alive بسته‌شده یا قطعی لحظه‌ای)
          final s = await req.response.detachSocket(writeHeaders: false);
          s.destroy();
          return;
        }
        req.response
          ..statusCode = 200
          ..write('<ListAllMyBucketsResult></ListAllMyBucketsResult>');
        await req.response.close();
      });
    });

    tearDown(() async {
      dropFirst = false;
      IoS3Transport.forgetAddresses();
      await server.close(force: true);
    });

    test('اتصال قطع‌شده ⇒ اتصال تازه و موفق', () async {
      dropFirst = true;
      final port = server.port;
      final t = IoS3Transport(timeout: const Duration(seconds: 5));
      try {
        final r = await testS3Connection(
          _s('127.0.0.1')
              .withEndpoint(Uri(scheme: 'http', host: '127.0.0.1', port: port)),
          t,
        );
        expect(r.ok, isTrue, reason: r.error);
        expect(hits, 2);
      } finally {
        t.close();
      }
    });

    test('DNS جواب نمی‌دهد ⇒ آخرین IP سالمِ همان میزبان', () async {
      final port = server.port;
      final t = IoS3Transport(timeout: const Duration(seconds: 5));
      final url = Uri.parse('http://payesh-db.invalid:$port/');
      try {
        await expectLater(
          t.send('GET', url, const {}),
          throwsA(isA<SocketException>()),
        );
        IoS3Transport.rememberAddress(
          'payesh-db.invalid',
          InternetAddress.loopbackIPv4,
        );
        final r = await t.send('GET', url, const {});
        expect(r.status, 200);
        expect(hits, 1);
      } finally {
        t.close();
      }
    });

    test(
      'https با IP شناخته‌شده: SNI و بررسی گواهی با همان نام میزبان',
      () async {
        final dir = Directory.systemTemp.createTempSync('owner-tls-');
        try {
          final gen = await Process.run('openssl', [
            'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', //
            '-subj', '/CN=payesh-db.test',
            '-addext', 'subjectAltName=DNS:payesh-db.test',
            '-keyout', '${dir.path}/k.pem', '-out', '${dir.path}/c.pem',
          ]);
          if (gen.exitCode != 0) {
            markTestSkipped('openssl در دسترس نیست');
            return;
          }
          final sctx = SecurityContext()
            ..useCertificateChain('${dir.path}/c.pem')
            ..usePrivateKey('${dir.path}/k.pem');
          final tls = await HttpServer.bindSecure(
            InternetAddress.loopbackIPv4,
            0,
            sctx,
          );
          tls.listen((req) async {
            req.response.write('ok');
            await req.response.close();
          });
          final port = tls.port;
          final cctx = SecurityContext(withTrustedRoots: false)
            ..setTrustedCertificates('${dir.path}/c.pem');
          final t = IoS3Transport(
            timeout: const Duration(seconds: 5),
            context: cctx,
          );
          IoS3Transport.rememberAddress(
            'payesh-db.test',
            InternetAddress.loopbackIPv4,
          );
          IoS3Transport.rememberAddress(
            'wrong-name.test',
            InternetAddress.loopbackIPv4,
          );
          try {
            final r = await t.send(
              'GET',
              Uri.parse('https://payesh-db.test:$port/'),
              const {},
            );
            expect((r.status, r.body), (200, 'ok'));
            // نام دیگر روی همان IP ⇒ گواهی پذیرفته نمی‌شود (بررسی خاموش نشده)
            await expectLater(
              t.send(
                'GET',
                Uri.parse('https://wrong-name.test:$port/'),
                const {},
              ),
              throwsA(isA<HandshakeException>()),
            );
          } finally {
            t.close();
            await tls.close(force: true);
          }
        } finally {
          dir.deleteSync(recursive: true);
        }
      },
    );
  });

  group('سنجش دیتابیس و وصل شدن خودکار', () {
    test(
      'LocalPlatform.probe: قطع ⇒ error، وصل ⇒ synced؛ هر سنجش اعلام می‌شود',
      () async {
        final store = FakeSecureStore();
        await _s(_ir).save(store);
        var down = true;
        final bucket = <String, String>{};
        final p = LocalPlatform(
          secure: store,
          s3Factory: () => _Mem(bucket, () => down),
          now: () => DateTime.utc(2026, 11, 13, 10),
        );
        final seen = <String>[];
        final sub = p.syncChanges.listen((s) => seen.add(s.state));
        expect((await p.probe()).state, 'error');
        down = false;
        expect((await p.probe()).state, 'synced');
        await Future<void>.delayed(Duration.zero);
        expect(seen, containsAllInOrder(['error', 'synced']));
        expect(seen.last, 'synced');
        // نسخهٔ این دستگاه پس از وصل شدن دوباره فرستاده شد
        expect(bucket.keys.single, startsWith('payesh/platform/'));
        await sub.cancel();
      },
    );

    test('سنجش کُند صفحه‌ها را منتظر نمی‌گذارد؛ هنگام قطعی، خواندن‌ها فوری از همین دستگاه', () async {
      final store = FakeSecureStore();
      await _s(_ir).save(store);
      final bucket = <String, String>{};
      Completer<void>? gate;
      var down = false;
      final p = LocalPlatform(
        secure: store,
        s3Factory: () => _Mem(bucket, () => down, () => gate?.future),
        now: () => DateTime.utc(2026, 11, 13, 10),
      )..backgroundProbe = true;
      final api = OwnerApi(
        origin: Uri.parse('https://local.payesh.invalid'),
        http: p,
        now: () => DateTime.utc(2026, 11, 13, 10),
      );
      api.restoreSession(p.signIn('rezaa-test'));
      expect((await api.plans()).ok, isTrue);
      // شبکه گیر کرده: سنجش منتظر می‌ماند، ولی صفحه‌ها نه
      gate = Completer<void>();
      final probing = p.probe();
      final sw = Stopwatch()..start();
      expect((await api.dashboard()).ok, isTrue);
      expect(sw.elapsed, lessThan(const Duration(seconds: 2)));
      down = true;
      gate.complete();
      gate = null;
      expect((await probing).state, 'error');
      // قطع + سنجش پس‌زمینه ⇒ خواندن صفحه‌ها سراغ شبکه نمی‌رود
      final before = _Mem.sends;
      expect((await api.plans()).ok, isTrue);
      expect(_Mem.sends, before);
      down = false;
      expect((await p.probe()).state, 'synced');
    });

    testWidgets('DbMonitor: قطع ⇒ تلاش با فاصلهٔ رو به افزایش؛ وصل ⇒ دوره‌ای', (
      tester,
    ) async {
      final replies = ['error', 'error', 'error', 'synced', 'error'];
      var probes = 0;
      final m = DbMonitor(
        probe: () async => PlatformSync(state: replies[probes++]),
        random: Random(1),
      )..start(first: Duration.zero);
      await tester.pump(const Duration(milliseconds: 1));
      expect((probes, m.state!.state, m.failures), (1, 'error', 1));
      final d1 = m.nextIn!;
      expect(d1.inMilliseconds, inInclusiveRange(2400, 3600));
      await tester.pump(d1);
      expect(m.failures, 2);
      final d2 = m.nextIn!;
      expect(d2.inMilliseconds, inInclusiveRange(4800, 7200));
      await tester.pump(d2);
      await tester.pump(m.nextIn!);
      expect((probes, m.connected, m.failures), (4, true, 0));
      expect(m.nextIn, const Duration(seconds: 60));
      // دو لمس هم‌زمان ⇒ یک سنجش
      final a = m.refresh(), b = m.refresh();
      await tester.pump();
      await Future.wait([a, b]);
      expect(probes, 5);
      m.dispose();
    });

    testWidgets('DbMonitor بدون start: فقط با لمس (بدون زمان‌سنج)', (
      tester,
    ) async {
      var probes = 0;
      final updates = StreamController<PlatformSync>.broadcast();
      final m = DbMonitor(
        probe: () async {
          probes++;
          return const PlatformSync(state: 'synced');
        },
        updates: updates.stream,
      );
      updates.add(const PlatformSync(state: 'error'));
      await tester.pump(const Duration(minutes: 5));
      expect((probes, m.state!.state), (0, 'error'));
      await m.refresh();
      expect((probes, m.connected), (1, true));
      m.dispose();
      unawaited(updates.close());
    });

    testWidgets('چراغ دیتابیس: فقط یک نقطه؛ لمس ⇒ سنجش دوباره', (tester) async {
      var state = 'error';
      var probes = 0;
      final m = DbMonitor(
        probe: () async {
          probes++;
          return PlatformSync(state: state, error: 'x');
        },
      );
      await tester.pumpWidget(_wrap(Center(child: DbLight(monitor: m))));
      expect(find.byKey(const Key('db-light-unknown')), findsOneWidget);
      expect(find.byType(Text), findsNothing); // بدون نوشته
      await tester.tap(find.byKey(const Key('db-light')));
      await tester.pump();
      expect(find.byKey(const Key('db-light-error')), findsOneWidget);
      state = 'synced';
      await tester.tap(find.byKey(const Key('db-light')));
      await tester.pump();
      expect(find.byKey(const Key('db-light-synced')), findsOneWidget);
      expect(probes, 2);
      m.dispose();
    });
  });

  group('نسخه', () {
    test('نسخهٔ نمایشی = pubspec (major.minor) + شمارهٔ ساخت', () {
      final pub = File('pubspec.yaml').readAsStringSync();
      final v = RegExp(
        r'^version:\s*(\d+)\.(\d+)\.',
        multiLine: true,
      ).firstMatch(pub)!;
      expect(ownerVersionBase, '${v.group(1)}.${v.group(2)}');
      expect(versionOf(141), '$ownerVersionBase.141');
      expect(ownerVersion, versionOf(ownerBuild));
    });

    test('CI نسخه را با هر ساخت عوض می‌کند (build-name + نصب‌کننده)', () {
      final ci = File('../../../.github/workflows/native-client.yml')
          .readAsStringSync();
      final base = RegExp.escape(ownerVersionBase);
      expect(
        RegExp(
          'flutter build windows --release --build-name=$base\\.\\\$\\{\\{ github.run_number \\}\\}',
        ).hasMatch(ci),
        isTrue,
      );
      expect(
        RegExp(
          'flutter build apk --release --build-number=\\\$BN --build-name=$base\\.\\\$\\{\\{ github.run_number \\}\\}',
        ).hasMatch(ci),
        isTrue,
      );
      expect(ci, contains('payesh-owner-native.iss'));
      expect(ci, contains('OWNER-VERSION'));
    });
  });
}

Widget _wrap(Widget child) => MaterialApp(
  theme: ThemeData(extensions: const [PayeshTokens.light]),
  home: Directionality(
    textDirection: TextDirection.rtl,
    child: Scaffold(body: child),
  ),
);

/// صندوقچهٔ ساده در حافظه؛ `down` ⇒ خطای شبکه.
final class _Mem implements S3Transport {
  _Mem(this.objects, this.down, [this.wait]);
  final Map<String, String> objects;
  final bool Function() down;
  final Future<void>? Function()? wait;
  static int sends = 0;

  @override
  Future<S3Response> send(
    String method,
    Uri url,
    Map<String, String> headers, [
    List<int>? body,
  ]) async {
    sends++;
    final w = wait?.call();
    if (w != null) await w;
    if (down()) throw const SocketException('Network is unreachable');
    final key = url.pathSegments.skip(1).join('/');
    if (method == 'PUT') {
      objects[key] = utf8.decode(body!);
      return const S3Response(200, '');
    }
    final v = objects[key];
    return v == null ? const S3Response(404, '') : S3Response(200, v);
  }

  @override
  void close() {}
}
