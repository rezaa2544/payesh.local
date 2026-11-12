import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:payesh_secure/payesh_secure.dart';

import 'trust_bundle.dart';

/// تنظیمات دیتابیس (فضای ابری سازگار با S3، مثل آروان‌کلاد) که مالک داخل برنامه وارد می‌کند.
/// کل رکورد (از جمله Secret Key) فقط در انبار امن سیستم‌عامل نگه داشته می‌شود.
abstract final class S3Keys {
  static const String settings = 'owner.s3.settings';
}

const String _emptySha256 =
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

final RegExp _hostRe = RegExp(
  r'^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$',
);

bool _isLoopback(String host) =>
    host == '127.0.0.1' || host == 'localhost' || host == '::1';

/// `s3.ir-central1.arvanstorage.ir` یا `https://s3.ir-central1.arvanstorage.ir[/]` ⇒
/// `https://host[:port]`. فقط https (http فقط برای loopback و آزمون)، بدون مسیر/پرس‌وجو.
Uri? normalizeS3Endpoint(String? input) {
  var s = (input ?? '').trim();
  if (s.isEmpty) return null;
  if (!s.contains('://')) s = 'https://$s';
  final Uri u;
  try {
    u = Uri.parse(s);
  } on FormatException {
    return null;
  }
  final host = u.host.toLowerCase();
  if (host.isEmpty || u.userInfo.isNotEmpty) return null;
  if (u.hasQuery || u.hasFragment) return null;
  if (u.path.isNotEmpty && u.path != '/') return null;
  if (u.scheme == 'http') {
    if (!_isLoopback(host)) return null;
  } else if (u.scheme != 'https') {
    return null;
  }
  if (!_isLoopback(host) && !_hostRe.hasMatch(host)) return null;
  return Uri(scheme: u.scheme, host: host, port: u.hasPort ? u.port : null);
}

String endpointText(Uri u) =>
    u.hasPort ? '${u.scheme}://${u.host}:${u.port}' : '${u.scheme}://${u.host}';

/// ناحیهٔ امضا: `s3.<region>.arvanstorage.ir` ⇒ `<region>`؛ در غیر این صورت `us-east-1`.
String regionFor(Uri endpoint) {
  final m = RegExp(r'^s3\.([a-z0-9-]+)\.arvanstorage\.ir$')
      .firstMatch(endpoint.host);
  return m?.group(1) ?? 'us-east-1';
}

final class S3Settings {
  const S3Settings({
    required this.endpoint,
    required this.accessKey,
    required this.secretKey,
  });

  final Uri endpoint;
  final String accessKey;
  final String secretKey;

  String encode() => jsonEncode({
    'v': 1,
    'endpoint': endpointText(endpoint),
    'access_key': accessKey,
    'secret_key': secretKey,
  });

  static S3Settings? decode(String? text) {
    if (text == null) return null;
    final Object? j = jsonDecode(text);
    if (j is! Map<String, Object?> || j['v'] != 1) return null;
    final e = normalizeS3Endpoint(j['endpoint'] as String?);
    final a = j['access_key'], k = j['secret_key'];
    if (e == null || a is! String || k is! String) return null;
    return S3Settings(endpoint: e, accessKey: a, secretKey: k);
  }

  static Future<S3Settings?> load(SecureStore store) async =>
      decode(await store.read(S3Keys.settings));

  Future<void> save(SecureStore store) =>
      store.write(S3Keys.settings, encode());

  static Future<void> clear(SecureStore store) => store.delete(S3Keys.settings);
}

/// خطای اعتبارسنجی فرم دیتابیس (متن فارسی) یا null.
String? validateS3Form({
  required String endpoint,
  required String accessKey,
  required String secretKey,
}) {
  if (normalizeS3Endpoint(endpoint) == null) {
    return 'آدرس دیتابیس معتبر نیست. نمونه: s3.ir-central1.arvanstorage.ir';
  }
  if (accessKey.trim().length < 3 || accessKey.trim().contains(RegExp(r'\s'))) {
    return 'Access Key را درست وارد کنید.';
  }
  if (secretKey.trim().length < 3 || secretKey.trim().contains(RegExp(r'\s'))) {
    return 'Secret Key را درست وارد کنید.';
  }
  return null;
}

String _two(int n) => n.toString().padLeft(2, '0');

/// `YYYYMMDDTHHMMSSZ` (UTC).
String amzDate(DateTime t) {
  final u = t.toUtc();
  return '${u.year}${_two(u.month)}${_two(u.day)}T${_two(u.hour)}${_two(u.minute)}${_two(u.second)}Z';
}

List<int> _hmac(List<int> key, String data) =>
    Hmac(sha256, key).convert(utf8.encode(data)).bytes;

/// سرآیند Authorization در AWS Signature Version 4 (درخواست بدون بدنه و بدون پرس‌وجو).
/// [headers] با نام‌های حروف‌کوچک؛ همهٔ آن‌ها امضا می‌شوند.
String sigV4Authorization({
  required String method,
  required String path,
  required Map<String, String> headers,
  required String payloadHash,
  required String region,
  required String service,
  required String accessKey,
  required String secretKey,
  required String amzDateTime,
}) {
  final names = headers.keys.map((k) => k.toLowerCase()).toList()..sort();
  final lower = {
    for (final e in headers.entries) e.key.toLowerCase(): e.value.trim(),
  };
  final canonicalHeaders = names.map((n) => '$n:${lower[n]}\n').join();
  final signed = names.join(';');
  final canonical = [
    method,
    path,
    '',
    canonicalHeaders,
    signed,
    payloadHash,
  ].join('\n');
  final day = amzDateTime.substring(0, 8);
  final scope = '$day/$region/$service/aws4_request';
  final toSign = [
    'AWS4-HMAC-SHA256',
    amzDateTime,
    scope,
    sha256.convert(utf8.encode(canonical)).toString(),
  ].join('\n');
  var k = _hmac(utf8.encode('AWS4$secretKey'), day);
  k = _hmac(k, region);
  k = _hmac(k, service);
  k = _hmac(k, 'aws4_request');
  final sig = Hmac(sha256, k).convert(utf8.encode(toSign)).toString();
  return 'AWS4-HMAC-SHA256 Credential=$accessKey/$scope, SignedHeaders=$signed, Signature=$sig';
}

final class S3Response {
  const S3Response(this.status, this.body);
  final int status;
  final String body;
}

/// انتقال HTTP (در آزمون‌ها جعلی).
abstract interface class S3Transport {
  Future<S3Response> get(Uri url, Map<String, String> headers);
  void close();
}

/// ریشه‌های سیستم + زنجیر رسمی Let's Encrypt (trust_bundle.dart). گواهی‌ای که از قبل در انبار
/// باشد خطای «تکراری» می‌دهد و نادیده گرفته می‌شود؛ هیچ بررسی‌ای خاموش نمی‌شود.
SecurityContext ownerTrustContext({
  bool withTrustedRoots = true,
  List<String> pems = letsEncryptChainPems,
}) {
  final c = SecurityContext(withTrustedRoots: withTrustedRoots);
  for (final p in pems) {
    try {
      c.setTrustedCertificatesBytes(utf8.encode(p));
    } on TlsException {
      // از قبل در انبار هست
    }
  }
  return c;
}

final class IoS3Transport implements S3Transport {
  IoS3Transport({
    Duration timeout = const Duration(seconds: 20),
    SecurityContext? context,
  }) : _timeout = timeout,
       _client = HttpClient(context: context ?? ownerTrustContext())
         ..connectionTimeout = timeout;
  final Duration _timeout;
  final HttpClient _client;

  @override
  Future<S3Response> get(Uri url, Map<String, String> headers) async {
    final req = await _client.getUrl(url).timeout(_timeout);
    req.followRedirects = false;
    headers.forEach((k, v) {
      if (k != 'host') req.headers.set(k, v);
    });
    final res = await req.close().timeout(_timeout);
    final body = await res.transform(utf8.decoder).join().timeout(_timeout);
    return S3Response(
      res.statusCode,
      body.length > 65536 ? body.substring(0, 65536) : body,
    );
  }

  @override
  void close() => _client.close(force: true);
}

final class S3TestResult {
  const S3TestResult.ok(this.buckets) : ok = true, error = null;
  const S3TestResult.fail(this.error) : ok = false, buckets = const [];
  final bool ok;
  final String? error;
  final List<String> buckets;
}

String? _xmlTag(String xml, String tag) =>
    RegExp('<$tag>([^<]*)</$tag>').firstMatch(xml)?.group(1);

/// فهرست صندوقچه‌ها (ListBuckets): آزمون واقعی کلیدها روی همان آدرس.
Future<S3TestResult> testS3Connection(
  S3Settings s,
  S3Transport transport, {
  DateTime Function()? now,
}) async {
  var region = regionFor(s.endpoint);
  for (var attempt = 0; attempt < 2; attempt++) {
    final date = amzDate((now ?? DateTime.now)());
    final hostHeader = s.endpoint.hasPort
        ? '${s.endpoint.host}:${s.endpoint.port}'
        : s.endpoint.host;
    final headers = {
      'host': hostHeader,
      'x-amz-content-sha256': _emptySha256,
      'x-amz-date': date,
    };
    headers['authorization'] = sigV4Authorization(
      method: 'GET',
      path: '/',
      headers: Map.of(headers),
      payloadHash: _emptySha256,
      region: region,
      service: 's3',
      accessKey: s.accessKey.trim(),
      secretKey: s.secretKey.trim(),
      amzDateTime: date,
    );
    final S3Response r;
    try {
      r = await transport.get(s.endpoint.replace(path: '/'), headers);
    } on TimeoutException {
      return const S3TestResult.fail(
        'پاسخی از سرور دیتابیس نیامد (مهلت تمام شد). اتصال اینترنت را بررسی کنید.',
      );
    } on SocketException {
      return const S3TestResult.fail(
        'ارتباط با سرور دیتابیس برقرار نشد. اتصال اینترنت یا آدرس را بررسی کنید.',
      );
    } on HandshakeException catch (e) {
      final why = (e.osError?.message ?? e.message).trim();
      return S3TestResult.fail(
        'گواهی امنیتی (TLS) سرور دیتابیس پذیرفته نشد${why.isEmpty ? '.' : ': $why'}',
      );
    } on HttpException {
      return const S3TestResult.fail(
        'ارتباط با سرور دیتابیس نیمه‌کاره قطع شد.',
      );
    }
    if (r.status == 200) {
      final names = RegExp(r'<Bucket>\s*<Name>([^<]+)</Name>')
          .allMatches(r.body)
          .map((m) => m.group(1)!)
          .toList();
      return S3TestResult.ok(names);
    }
    final code = _xmlTag(r.body, 'Code');
    final hinted = _xmlTag(r.body, 'Region');
    if (attempt == 0 &&
        hinted != null &&
        hinted.isNotEmpty &&
        hinted != region &&
        (code == 'AuthorizationHeaderMalformed' ||
            r.status == 301 ||
            r.status == 400)) {
      region = hinted;
      continue;
    }
    return S3TestResult.fail(switch (code) {
      'InvalidAccessKeyId' =>
        'Access Key نادرست است یا در این ناحیه وجود ندارد.',
      'SignatureDoesNotMatch' => 'Secret Key نادرست است.',
      'RequestTimeTooSkewed' =>
        'ساعت این دستگاه با سرور فاصله دارد. تاریخ و ساعت ویندوز را درست کنید.',
      'AccessDenied' => 'این کلید اجازهٔ دسترسی ندارد (AccessDenied).',
      _ =>
        'پاسخ نامنتظره از سرور دیتابیس: کد ${r.status}${code == null ? '' : ' ($code)'}',
    });
  }
  return const S3TestResult.fail('ناحیهٔ سرور دیتابیس شناخته نشد.');
}
