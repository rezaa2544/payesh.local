/// پیروی سرورهای مدرسه از «دیتابیس» پنل مالک (همتای server/cloud-control.js).
///
/// پنل مالک هر بار که دیتابیس را ذخیره می‌کند، در صندوقچهٔ تازه — و اگر عوض شده، در صندوقچهٔ
/// قبلی هم — فایل `payesh/control/cloud-<kid>.json` را می‌نویسد (kid = ۱۶ نویسهٔ اول SHA-256 از
/// Access Key؛ پس اگر فقط کلیدها عوض شوند، پاکت کلید قدیمی و تازه روی هم نمی‌افتند). محتوا (آدرس، صندوقچه و کلیدها) با
/// AES-256-GCM و کلیدی از Secret Key همان صندوقچه (HKDF-SHA256) مهر می‌شود؛ پس فقط سرورهایی
/// که همین حالا به آن صندوقچه دسترسی دارند بازش می‌کنند. برنامه‌های کاربران هیچ کلیدی
/// نمی‌گیرند: با سرور مدرسه کار می‌کنند و سرور همه‌چیز را در صندوقچه می‌نویسد.
///
/// هر سرور پس از پیروی، در `payesh/control/ack/<id>.json` رسید می‌گذارد ([readFollowers]).
/// قالب و بردار آزمون: docs/cloud/contracts/cloud-control-vectors.json.
library;

import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as hash;
import 'package:cryptography/cryptography.dart';
import 'package:payesh_secure/payesh_secure.dart';

import 's3_client.dart';

const String controlKind = 'payesh-cloud-control';
const String controlPrefix = 'payesh/';

/// شناسهٔ کلید در نام فایل: ۱۶ نویسهٔ اول SHA-256 از Access Key.
String controlKid(String accessKey) =>
    hash.sha256.convert(utf8.encode(accessKey)).toString().substring(0, 16);

/// فایل فرمانی که فقط دارندهٔ [accessKey] (و Secret آن) می‌خواند.
String controlObjectKey(String accessKey) =>
    '${controlPrefix}control/cloud-${controlKid(accessKey)}.json';
const String ackPrefix = '${controlPrefix}control/ack/';

/// شمارهٔ آخرین نسخه‌ای که پنل منتشر کرده (برای «به‌روز / قدیمی» در فهرست سرورها).
abstract final class ControlKeys {
  static const String rev = 'owner.s3.control_rev';
}

final _hkdf = Hkdf(hmac: Hmac.sha256(), outputLength: 32);
final _gcm = AesGcm.with256bits();

String _b64u(List<int> b) => base64Url.encode(b).replaceAll('=', '');

Uint8List _unb64u(String s) {
  if (!RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(s)) {
    throw const FormatException('bad base64url');
  }
  final b = base64Url.decode(s.padRight((s.length + 3) ~/ 4 * 4, '='));
  if (_b64u(b) != s) throw const FormatException('non-canonical base64url');
  return Uint8List.fromList(b);
}

/// کلید مهر: HKDF-SHA256(utf8(secret), salt="payesh/cloud-control", info="v1").
Future<Uint8List> controlKey(String secret) async {
  final k = await _hkdf.deriveKey(
    secretKey: SecretKey(utf8.encode(secret)),
    nonce: utf8.encode('payesh/cloud-control'),
    info: utf8.encode('v1'),
  );
  return Uint8List.fromList(await k.extractBytes());
}

List<int> _aad(int rev) => utf8.encode('$controlKind/v1/$rev');

/// متن JSON داخل پاکت؛ ترتیب کلیدها همان سرور است (بردار آزمون مشترک).
String controlPlaintext(S3Settings target, int rev) => jsonEncode({
  'v': 1,
  'rev': rev,
  'endpoint': endpointText(target.endpoint),
  'region': regionFor(target.endpoint),
  'bucket': target.bucket,
  'prefix': controlPrefix,
  'accessKey': target.accessKey,
  'secret': target.secretKey,
});

/// مهر [plaintext] با Secret Key صندوقچه‌ای که پاکت در آن نوشته می‌شود.
Future<Map<String, Object?>> sealControlText(
  String secret,
  int rev,
  String plaintext, {
  List<int>? nonce,
}) async {
  final n =
      nonce ?? List<int>.generate(12, (_) => Random.secure().nextInt(256));
  if (n.length != 12) throw ArgumentError('nonce must be 12 bytes');
  final box = await _gcm.encrypt(
    utf8.encode(plaintext),
    secretKey: SecretKey(await controlKey(secret)),
    nonce: n,
    aad: _aad(rev),
  );
  return {
    'v': 1,
    'kind': controlKind,
    'rev': rev,
    'alg': 'HKDF-SHA256/A256GCM',
    'nonce': _b64u(n),
    'ct': _b64u([...box.cipherText, ...box.mac.bytes]),
  };
}

/// باز کردن پاکت (برای آزمون و بازبینی)؛ هر خطا ⇒ [FormatException] یا [SecretBoxAuthenticationError].
Future<String> openControlText(String secret, Map<String, Object?> env) async {
  final rev = env['rev'];
  if (env['v'] != 1 ||
      env['kind'] != controlKind ||
      env['alg'] != 'HKDF-SHA256/A256GCM' ||
      rev is! int ||
      rev <= 0) {
    throw const FormatException('bad envelope');
  }
  final n = _unb64u('${env['nonce']}');
  final ct = _unb64u('${env['ct']}');
  if (n.length != 12 || ct.length < 17) {
    throw const FormatException('bad envelope');
  }
  final clear = await _gcm.decrypt(
    SecretBox(
      ct.sublist(0, ct.length - 16),
      nonce: n,
      mac: Mac(ct.sublist(ct.length - 16)),
    ),
    secretKey: SecretKey(await controlKey(secret)),
    aad: _aad(rev),
  );
  return utf8.decode(clear);
}

/// نتیجهٔ اعلام به سرورهای مدرسه.
final class PublishResult {
  const PublishResult(this.rev, this.buckets);
  final int rev;

  /// صندوقچه‌هایی که فرمان در آن‌ها نوشته شد (تازه، و قبلی اگر فرق داشت).
  final List<String> buckets;
}

/// فرمان «از این دیتابیس پیروی کنید» را در [target] و (اگر فرق دارد) در [previous] می‌نویسد.
/// نوشتن در صندوقچهٔ قبلی برای سرورهایی است که هنوز به آن وصل‌اند؛ اگر آن کلیدها دیگر کار
/// نکنند (مثلاً باطل شده‌اند)، فقط هشدار برمی‌گردد و مقصد تازه معتبر می‌ماند.
Future<(PublishResult, String?)> publishControl({
  required S3Settings target,
  S3Settings? previous,
  required S3Transport transport,
  required int rev,
  DateTime Function()? now,
}) async {
  final plain = controlPlaintext(target, rev);
  final written = <String>[];
  final env = await sealControlText(target.secretKey, rev, plain);
  await s3PutJson(
    target,
    transport,
    controlObjectKey(target.accessKey),
    jsonEncode(env),
    now: now,
  );
  written.add(target.bucket);
  String? warning;
  if (previous != null &&
      previous.bucket.isNotEmpty &&
      !previous.sameTarget(target)) {
    try {
      final old = await sealControlText(previous.secretKey, rev, plain);
      await s3PutJson(
        previous,
        transport,
        controlObjectKey(previous.accessKey),
        jsonEncode(old),
        now: now,
      );
      written.add(previous.bucket);
    } on S3Failure catch (e) {
      warning =
          'اعلام در صندوقچهٔ قبلی (${previous.bucket}) ممکن نشد: ${e.messageFa} '
          'سرورهایی که هنوز به آن وصل‌اند را باید یک بار دستی روی دیتابیس تازه تنظیم کرد.';
    }
  }
  return (PublishResult(rev, written), warning);
}

/// رسید یک سرور مدرسه.
final class Follower {
  const Follower({
    required this.id,
    required this.host,
    required this.rev,
    required this.ok,
    required this.at,
    this.error,
    this.version,
  });
  final String id;
  final String host;
  final int rev;
  final bool ok;
  final String at;
  final String? error;
  final String? version;

  static Follower? fromJson(String text) {
    final Object? j;
    try {
      j = jsonDecode(text);
    } on FormatException {
      return null;
    }
    if (j is! Map<String, Object?> || j['v'] != 1) return null;
    final id = j['server_id'], rev = j['rev'];
    if (id is! String || rev is! int) return null;
    return Follower(
      id: id,
      host: (j['host'] as String?) ?? '—',
      rev: rev,
      ok: j['ok'] == true,
      at: (j['at'] as String?) ?? '',
      error: j['error'] as String?,
      version: j['version'] as String?,
    );
  }
}

/// رسیدهای سرورهای مدرسه در صندوقچهٔ [s] (حداکثر ۵۰).
Future<List<Follower>> readFollowers(
  S3Settings s,
  S3Transport t, {
  DateTime Function()? now,
}) async {
  final keys = await s3ListKeys(s, t, ackPrefix, max: 50, now: now);
  final out = <Follower>[];
  for (final k in keys.where((k) => k.endsWith('.json'))) {
    final text = await s3GetText(s, t, k, now: now);
    final f = text == null ? null : Follower.fromJson(text);
    if (f != null) out.add(f);
  }
  out.sort((a, b) => b.at.compareTo(a.at));
  return out;
}

Future<int?> loadPublishedRev(SecureStore store) async =>
    int.tryParse(await store.read(ControlKeys.rev) ?? '');
