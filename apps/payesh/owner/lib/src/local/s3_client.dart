import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

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

/// نام صندوقچه (Bucket) طبق قواعد S3.
final RegExp bucketNameRe = RegExp(r'^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$');

/// اگر مالک آدرس خود صندوقچه را بچسباند (`https://payesh-madrese.s3.ir-central1.arvanstorage.ir`)،
/// آدرس سرور و نام صندوقچه را جدا می‌کند: `(s3.ir-central1.arvanstorage.ir, payesh-madrese)`.
(String endpoint, String bucket)? splitBucketHost(String input) {
  var s = input.trim();
  if (s.isEmpty) return null;
  if (!s.contains('://')) s = 'https://$s';
  final Uri u;
  try {
    u = Uri.parse(s);
  } on FormatException {
    return null;
  }
  final m = RegExp(
    r'^([a-z0-9][a-z0-9.-]*[a-z0-9])\.(s3\.[a-z0-9-]+\.arvanstorage\.(?:ir|com))$',
  ).firstMatch(u.host.toLowerCase());
  if (m == null || !bucketNameRe.hasMatch(m.group(1)!)) return null;
  return ('${u.scheme}://${m.group(2)}', m.group(1)!);
}

/// همان قاعدهٔ سرور مدرسه (server/s3mem.js ensureBucket) برای وقتی که نام صندوقچه خالی است.
String? pickBucket(List<String> names) {
  if (names.isEmpty) return null;
  for (final n in names) {
    if (RegExp('payesh', caseSensitive: false).hasMatch(n)) return n;
  }
  for (final n in names) {
    if (RegExp('(school|madrese|مدرسه)', caseSensitive: false).hasMatch(n)) {
      return n;
    }
  }
  return names.first;
}

final class S3Settings {
  const S3Settings({
    required this.endpoint,
    required this.accessKey,
    required this.secretKey,
    this.bucket = '',
  });

  final Uri endpoint;
  final String accessKey;
  final String secretKey;

  /// خالی = خودکار (همان قاعدهٔ سرور مدرسه، [pickBucket]).
  final String bucket;

  S3Settings withBucket(String b) => S3Settings(
    endpoint: endpoint,
    accessKey: accessKey,
    secretKey: secretKey,
    bucket: b,
  );

  /// همان مقصد (آدرس، صندوقچه و کلیدها)؟
  bool sameTarget(S3Settings o) =>
      endpointText(endpoint) == endpointText(o.endpoint) &&
      bucket == o.bucket &&
      accessKey == o.accessKey &&
      secretKey == o.secretKey;

  String encode() => jsonEncode({
    'v': 1,
    'endpoint': endpointText(endpoint),
    'access_key': accessKey,
    'secret_key': secretKey,
    if (bucket.isNotEmpty) 'bucket': bucket,
  });

  static S3Settings? decode(String? text) {
    if (text == null) return null;
    final Object? j = jsonDecode(text);
    if (j is! Map<String, Object?> || j['v'] != 1) return null;
    final e = normalizeS3Endpoint(j['endpoint'] as String?);
    final a = j['access_key'], k = j['secret_key'], b = j['bucket'] ?? '';
    if (e == null || a is! String || k is! String || b is! String) return null;
    if (b.isNotEmpty && !bucketNameRe.hasMatch(b)) return null;
    return S3Settings(endpoint: e, accessKey: a, secretKey: k, bucket: b);
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
  String bucket = '',
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
  if (bucket.trim().isNotEmpty && !bucketNameRe.hasMatch(bucket.trim())) {
    return 'نام صندوقچه معتبر نیست (فقط حروف کوچک انگلیسی، عدد و خط تیره؛ مثل payesh-madrese).';
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
/// کدگذاری RFC 3986 (همان قاعدهٔ AWS)؛ [keepSlash] برای مسیر.
String uriEncode(String s, {bool keepSlash = false}) {
  final out = StringBuffer();
  for (final c in utf8.encode(s)) {
    final ok =
        (c >= 0x41 && c <= 0x5a) ||
        (c >= 0x61 && c <= 0x7a) ||
        (c >= 0x30 && c <= 0x39) ||
        c == 0x2d ||
        c == 0x5f ||
        c == 0x2e ||
        c == 0x7e ||
        (keepSlash && c == 0x2f);
    out.write(
      ok
          ? String.fromCharCode(c)
          : '%${c.toRadixString(16).toUpperCase().padLeft(2, '0')}',
    );
  }
  return out.toString();
}

String _canonicalQuery(Map<String, String> q) {
  final keys = q.keys.toList()..sort();
  return keys.map((k) => '${uriEncode(k)}=${uriEncode(q[k]!)}').join('&');
}

String sigV4Authorization({
  required String method,
  required String path,
  Map<String, String> query = const {},
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
    _canonicalQuery(query),
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
  const S3Response(this.status, this.body, {this.rawBytes});
  final int status;
  final String body;

  /// بدنهٔ خام (برای فایل‌های دودویی). در آزمون‌ها اگر نباشد، همان [body] است.
  final Uint8List? rawBytes;

  List<int> get bytes => rawBytes ?? utf8.encode(body);
}

/// انتقال HTTP (در آزمون‌ها جعلی).
abstract interface class S3Transport {
  Future<S3Response> send(
    String method,
    Uri url,
    Map<String, String> headers, [
    List<int>? body,
  ]);
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
    this.maxBytes = 0,
  }) : _timeout = timeout,
       _client = HttpClient(context: context ?? ownerTrustContext())
         ..connectionTimeout = timeout;
  final Duration _timeout;
  final HttpClient _client;

  /// اگر > 0: بدنهٔ خام تا این اندازه نگه داشته می‌شود ([S3Response.rawBytes]).
  final int maxBytes;

  @override
  Future<S3Response> send(
    String method,
    Uri url,
    Map<String, String> headers, [
    List<int>? body,
  ]) async {
    final req = await _client.openUrl(method, url).timeout(_timeout);
    req.followRedirects = false;
    headers.forEach((k, v) {
      if (k != 'host') req.headers.set(k, v);
    });
    if (body != null) {
      req.contentLength = body.length;
      req.add(body);
    }
    final res = await req.close().timeout(_timeout);
    if (maxBytes > 0) {
      final b = BytesBuilder(copy: false);
      await for (final chunk in res.timeout(_timeout)) {
        b.add(chunk);
        if (b.length > maxBytes) {
          throw const S3Failure('فایل از سقف مجاز بزرگ‌تر است.');
        }
      }
      final raw = b.takeBytes();
      final head = raw.length > 65536 ? raw.sublist(0, 65536) : raw;
      return S3Response(
        res.statusCode,
        utf8.decode(head, allowMalformed: true),
        rawBytes: raw,
      );
    }
    final text = await res.transform(utf8.decoder).join().timeout(_timeout);
    return S3Response(
      res.statusCode,
      text.length > 65536 ? text.substring(0, 65536) : text,
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

/// خطای ارتباط با دیتابیس، با متن فارسی برای نمایش.
final class S3Failure implements Exception {
  const S3Failure(this.messageFa, {this.status = 0, this.code});
  final String messageFa;
  final int status;
  final String? code;
  @override
  String toString() => messageFa;
}

String? _xmlTag(String xml, String tag) =>
    RegExp('<$tag>([^<]*)</$tag>').firstMatch(xml)?.group(1);

String _failText(int status, String? code) => switch (code) {
  'InvalidAccessKeyId' => 'Access Key نادرست است یا در این ناحیه وجود ندارد.',
  'SignatureDoesNotMatch' => 'Secret Key نادرست است.',
  'RequestTimeTooSkewed' =>
    'ساعت این دستگاه با سرور فاصله دارد. تاریخ و ساعت ویندوز را درست کنید.',
  'AccessDenied' => 'این کلید اجازهٔ دسترسی ندارد (AccessDenied).',
  'NoSuchBucket' => 'این صندوقچه (Bucket) در این حساب پیدا نشد.',
  _ =>
    'پاسخ نامنتظره از سرور دیتابیس: کد $status${code == null ? '' : ' ($code)'}',
};

/// یک درخواست امضاشده (SigV4، مسیر-محور روی همان آدرس). ناحیه از آدرس؛ اگر سرور ناحیهٔ دیگری
/// پیشنهاد کند، یک بار دیگر با همان. پاسخ 2xx یا 404 برمی‌گردد؛ بقیه ⇒ [S3Failure].
Future<S3Response> s3Request(
  S3Settings s,
  S3Transport transport, {
  String method = 'GET',
  String path = '/',
  Map<String, String> query = const {},
  List<int>? body,
  String? contentType,
  DateTime Function()? now,
}) async {
  var region = regionFor(s.endpoint);
  final payloadHash = body == null
      ? _emptySha256
      : sha256.convert(body).toString();
  final canonicalPath = uriEncode(path, keepSlash: true);
  for (var attempt = 0; attempt < 2; attempt++) {
    final date = amzDate((now ?? DateTime.now)());
    final hostHeader = s.endpoint.hasPort
        ? '${s.endpoint.host}:${s.endpoint.port}'
        : s.endpoint.host;
    final headers = {
      'host': hostHeader,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': date,
      'content-type': ?contentType,
    };
    headers['authorization'] = sigV4Authorization(
      method: method,
      path: canonicalPath,
      query: query,
      headers: Map.of(headers),
      payloadHash: payloadHash,
      region: region,
      service: 's3',
      accessKey: s.accessKey.trim(),
      secretKey: s.secretKey.trim(),
      amzDateTime: date,
    );
    final url = Uri.parse(
      '${endpointText(s.endpoint)}$canonicalPath'
      '${query.isEmpty ? '' : '?${_canonicalQuery(query)}'}',
    );
    final S3Response r;
    try {
      r = await transport.send(method, url, headers, body);
    } on TimeoutException {
      throw const S3Failure(
        'پاسخی از سرور دیتابیس نیامد (مهلت تمام شد). اتصال اینترنت را بررسی کنید.',
      );
    } on SocketException {
      throw const S3Failure(
        'ارتباط با سرور دیتابیس برقرار نشد. اتصال اینترنت یا آدرس را بررسی کنید.',
      );
    } on HandshakeException catch (e) {
      final why = (e.osError?.message ?? e.message).trim();
      throw S3Failure(
        'گواهی امنیتی (TLS) سرور دیتابیس پذیرفته نشد${why.isEmpty ? '.' : ': $why'}',
      );
    } on HttpException {
      throw const S3Failure('ارتباط با سرور دیتابیس نیمه‌کاره قطع شد.');
    }
    if ((r.status >= 200 && r.status < 300) ||
        (r.status == 404 && _xmlTag(r.body, 'Code') != 'NoSuchBucket')) {
      return r;
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
    throw S3Failure(_failText(r.status, code), status: r.status, code: code);
  }
  throw const S3Failure('ناحیهٔ سرور دیتابیس شناخته نشد.');
}

/// فهرست صندوقچه‌ها (ListBuckets): آزمون واقعی کلیدها روی همان آدرس.
Future<S3TestResult> testS3Connection(
  S3Settings s,
  S3Transport transport, {
  DateTime Function()? now,
}) async {
  try {
    final r = await s3Request(s, transport, now: now);
    if (r.status != 200) {
      return S3TestResult.fail(_failText(r.status, _xmlTag(r.body, 'Code')));
    }
    final names = RegExp(r'<Bucket>\s*<Name>([^<]+)</Name>')
        .allMatches(r.body)
        .map((m) => m.group(1)!)
        .toList();
    return S3TestResult.ok(names);
  } on S3Failure catch (e) {
    return S3TestResult.fail(e.messageFa);
  }
}

/// نوشتن یک شیء کوچک (JSON) در صندوقچهٔ [s].
Future<void> s3PutJson(
  S3Settings s,
  S3Transport t,
  String key,
  String json, {
  DateTime Function()? now,
}) async {
  final r = await s3Request(
    s,
    t,
    method: 'PUT',
    path: '/${s.bucket}/$key',
    body: utf8.encode(json),
    contentType: 'application/json; charset=utf-8',
    now: now,
  );
  if (r.status == 404) throw S3Failure(_failText(404, 'NoSuchBucket'));
}

/// خواندن یک شیء؛ null اگر نباشد.
Future<String?> s3GetText(
  S3Settings s,
  S3Transport t,
  String key, {
  DateTime Function()? now,
}) async {
  final r = await s3Request(s, t, path: '/${s.bucket}/$key', now: now);
  return r.status == 404 ? null : r.body;
}

/// کلیدهای زیر یک پیشوند (ListObjectsV2، حداکثر [max]).
Future<List<String>> s3ListKeys(
  S3Settings s,
  S3Transport t,
  String prefix, {
  int max = 100,
  DateTime Function()? now,
}) async {
  final r = await s3Request(
    s,
    t,
    path: '/${s.bucket}',
    query: {'list-type': '2', 'max-keys': '$max', 'prefix': prefix},
    now: now,
  );
  if (r.status == 404) return const [];
  return RegExp(r'<Key>([^<]+)</Key>')
      .allMatches(r.body)
      .map((m) => m.group(1)!.replaceAll('&amp;', '&'))
      .toList();
}

/// یک فایل در فهرست صندوقچه.
final class S3Object {
  const S3Object(this.key, this.size, this.modified);
  final String key;
  final int size;
  final DateTime? modified;
}

String _unxml(String s) => s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');

/// فهرست کامل زیر یک پیشوند (ListObjectsV2 با صفحه‌بندی؛ حداکثر [maxPages] صفحهٔ ۱۰۰۰تایی).
Future<(List<S3Object>, bool)> s3ListObjects(
  S3Settings s,
  S3Transport t,
  String prefix, {
  int maxPages = 50,
  DateTime Function()? now,
}) async {
  final out = <S3Object>[];
  String? token;
  var pages = 0;
  do {
    final r = await s3Request(
      s,
      t,
      path: '/${s.bucket}',
      query: {
        'list-type': '2',
        'max-keys': '1000',
        'prefix': prefix,
        'continuation-token': ?token,
      },
      now: now,
    );
    if (r.status == 404) return (out, false);
    for (final m in RegExp(
      r'<Contents>([\s\S]*?)</Contents>',
    ).allMatches(r.body)) {
      final c = m.group(1)!;
      final key = _xmlTag(c, 'Key');
      if (key == null) continue;
      final mod = _xmlTag(c, 'LastModified');
      out.add(
        S3Object(
          _unxml(key),
          int.tryParse(_xmlTag(c, 'Size') ?? '') ?? 0,
          mod == null ? null : DateTime.tryParse(mod),
        ),
      );
    }
    final truncated = _xmlTag(r.body, 'IsTruncated') == 'true';
    token = truncated ? _xmlTag(r.body, 'NextContinuationToken') : null;
    pages++;
    if (token != null && pages >= maxPages) return (out, true);
  } while (token != null);
  return (out, false);
}

/// خواندن خام یک فایل؛ null اگر نباشد.
Future<List<int>?> s3GetBytes(
  S3Settings s,
  S3Transport t,
  String key, {
  DateTime Function()? now,
}) async {
  final r = await s3Request(s, t, path: '/${s.bucket}/$key', now: now);
  return r.status == 404 ? null : r.bytes;
}

/// نوشتن خام (مثلاً فایل فشردهٔ به‌روزرسانی).
Future<void> s3PutBytes(
  S3Settings s,
  S3Transport t,
  String key,
  List<int> body, {
  String contentType = 'application/octet-stream',
  DateTime Function()? now,
}) async {
  final r = await s3Request(
    s,
    t,
    method: 'PUT',
    path: '/${s.bucket}/$key',
    body: body,
    contentType: contentType,
    now: now,
  );
  if (r.status == 404) throw S3Failure(_failText(404, 'NoSuchBucket'));
}

/// پاک کردن یک فایل (نبودن هم یعنی پاک).
Future<void> s3Delete(
  S3Settings s,
  S3Transport t,
  String key, {
  DateTime Function()? now,
}) async {
  await s3Request(s, t, method: 'DELETE', path: '/${s.bucket}/$key', now: now);
}
