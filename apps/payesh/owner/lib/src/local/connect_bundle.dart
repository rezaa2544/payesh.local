/// ردیف ۱۷۰ — «بستهٔ اتصال»: هر برنامه پس از نصب خودکار به دیتابیس وصل می‌شود، بی‌وارد کردن
/// نشانی یا کلید (همتای server/connect.js).
///
/// پنل مالک با ساختن مدرسه / رمز تازهٔ مدیر، محتوای فرمان cloud-control (آدرس، صندوقچه،
/// کلیدها) را با کلیدی از «نام کاربری + رمز مدیر» مهر و در `payesh/pub/connect/s-….json`
/// (خواندنی برای همه) می‌نویسد؛ سرور مدرسهٔ تازه‌نصب با نخستین ورود مدیر بازش می‌کند. بستهٔ
/// مالک (`o-…`) با شناسه + رمز + کد پنل مالک مهر می‌شود و پنل مالکِ تازه‌نصب روی هر رایانه یا
/// گوشی با همان سه مقدار وصل می‌شود. کلید دیتابیس در هیچ کد و باندلی نیست (D‑23).
///
/// ترتیب یافتن: `https://payeshschool.ir/payesh/pub/`، سپس نشانی صندوقچه؛ `connect.json` هر
/// پایه می‌تواند «base» تازه‌تری بدهد (تا عمق ۲) — جابه‌جایی دیتابیس بی‌به‌روزرسانی برنامه.
/// بردار آزمون مشترک: docs/cloud/contracts/connect-vectors.json.
library;

import 'dart:convert';

import 'package:crypto/crypto.dart' as hash;

import 'cloud_control.dart';
import '../schools/school_registry.dart' show pbkdf2Hex;
import 's3_client.dart';

const String connectKind = 'payesh-connect';
const String connectSalt = 'payesh/connect';
const int connectIterations = 120000;

/// پوشهٔ عمومی داخل صندوقچه.
const String connectPubDir = '${controlPrefix}pub/';

/// پایه‌های پیش‌فرض (اول دامنه — قابل جابه‌جایی بی‌به‌روزرسانی برنامه).
const List<String> defaultConnectBases = [
  'https://payeshschool.ir/payesh/pub/',
  'https://s3.ir-central1.arvanstorage.ir/payesh-madrese/payesh/pub/',
];

const _fa = '۰۱۲۳۴۵۶۷۸۹';
const _ar = '٠١٢٣٤٥٦٧٨٩';

/// نام کاربری یکدست: trim، حروف کوچک، رقم فارسی/عربی ⇒ لاتین.
String connectNorm(String login) {
  final b = StringBuffer();
  for (final r in login.trim().toLowerCase().runes) {
    final c = String.fromCharCode(r);
    final i = _fa.indexOf(c);
    final j = _ar.indexOf(c);
    b.write(i >= 0 ? '$i' : (j >= 0 ? '$j' : c));
  }
  return b.toString();
}

String _saltOf(String kind, String login) =>
    'payesh/connect/$kind/${connectNorm(login)}';

void _kind(String kind) {
  if (kind != 'school' && kind != 'owner') {
    throw ArgumentError.value(kind, 'kind');
  }
}

/// `connect/<s|o>-<۳۲ نویسهٔ اول sha256>.json` (نسبت به پایه).
String connectBundlePath(String kind, String login) {
  _kind(kind);
  final h = hash.sha256
      .convert(utf8.encode(_saltOf(kind, login)))
      .toString()
      .substring(0, 32);
  return 'connect/${kind == 'school' ? 's' : 'o'}-$h.json';
}

/// رمز بسته (hex)؛ مالک: `password + "\u0000" + code.trim()`. PBKDF2 کند است ⇒ بیرون از رشتهٔ رابط.
Future<String> connectSecret(
  String kind,
  String login,
  String password, {
  String code = '',
}) {
  _kind(kind);
  final pw = kind == 'owner' ? '$password\u0000${code.trim()}' : password;
  final salt = _saltOf(kind, login);
  // pbkdf2Hex = package:cryptography: Isolate روی بومی، WebCrypto (ناهمگام) در وب ۳۲ بیتی —
  // PBKDF2 خالص Dart در dart2js رشتهٔ رابط را چند ثانیه قفل می‌کرد (W170-02).
  return pbkdf2Hex(pw, salt, connectIterations);
}

/// مهر متن JSON فرمان با رمز بسته.
Future<Map<String, Object?>> sealConnect(
  String secret,
  int rev,
  String plaintext, {
  List<int>? nonce,
}) => sealBox(
  secret: secret,
  salt: connectSalt,
  kind: connectKind,
  rev: rev,
  plaintext: plaintext,
  nonce: nonce,
);

/// متن داخل بسته؛ هر خطا ⇒ استثنا.
Future<String> openConnectText(String secret, Map<String, Object?> env) =>
    openBox(secret: secret, salt: connectSalt, kind: connectKind, env: env);

/// باز کردن بسته و ساختن تنظیم دیتابیس؛ رمز غلط یا محتوای نامعتبر ⇒ null.
Future<S3Settings?> openConnect(String secret, Map<String, Object?> env) async {
  try {
    final j = jsonDecode(await openConnectText(secret, env));
    if (j is! Map<String, Object?> || j['v'] != 1 || j['rev'] != env['rev']) {
      return null;
    }
    final e = normalizeS3Endpoint(j['endpoint'] as String?);
    final a = j['accessKey'], k = j['secret'], b = j['bucket'];
    if (e == null ||
        a is! String ||
        k is! String ||
        b is! String ||
        a.isEmpty ||
        k.isEmpty ||
        !bucketNameRe.hasMatch(b)) {
      return null;
    }
    return S3Settings(endpoint: e, accessKey: a, secretKey: k, bucket: b);
  } on Object {
    return null;
  }
}

/// نشانی عمومی پوشهٔ `payesh/pub/` همین صندوقچه.
String connectBaseOf(S3Settings s) =>
    '${endpointText(s.endpoint)}/${s.bucket}/$connectPubDir';

/// انتشار بستهٔ [kind] برای [login] در صندوقچهٔ [s] (عمومی، بی‌کش) + فهرست `connect.json`.
Future<void> publishConnectBundle({
  required S3Settings s,
  required S3Transport t,
  required String kind,
  required String login,
  required String password,
  String code = '',
  DateTime Function()? now,
}) async {
  final at = (now ?? DateTime.now)();
  final rev = at.millisecondsSinceEpoch;
  final secret = await connectSecret(kind, login, password, code: code);
  final env = await sealConnect(secret, rev, controlPlaintext(s, rev));
  const pub = {'x-amz-acl': 'public-read', 'cache-control': 'no-cache'};
  await s3PutJson(
    s,
    t,
    '$connectPubDir${connectBundlePath(kind, login)}',
    jsonEncode(env),
    now: now,
    headers: pub,
  );
  await s3PutJson(
    s,
    t,
    '${connectPubDir}connect.json',
    jsonEncode({
      'v': 1,
      'kind': 'payesh-connect-index',
      'base': connectBaseOf(s),
      'at': at.toUtc().toIso8601String(),
    }),
    now: now,
    headers: pub,
  );
}

bool _okBase(String u) =>
    RegExp(r'^https://\S+/$').hasMatch(u) ||
    RegExp(r'^http://(127\.0\.0\.1|localhost)(:\d+)?/\S*/$').hasMatch(u);

Future<Object?> _getJson(S3Transport t, String url) async {
  try {
    final r = await t
        .send('GET', Uri.parse(url), {'cache-control': 'no-cache'})
        .timeout(const Duration(seconds: 10));
    if (r.status != 200) return null;
    return jsonDecode(r.body);
  } on Object {
    return null;
  }
}

/// خواندن بسته از پایه‌ها (دنبال کردن «base» در `connect.json`، تا عمق ۲)؛ نبود ⇒ null.
Future<Map<String, Object?>?> fetchConnectBundle(
  S3Transport t,
  String kind,
  String login, {
  List<String> bases = defaultConnectBases,
}) async {
  final rel = connectBundlePath(kind, login);
  final seen = <String>{};
  Future<Map<String, Object?>?> tryBase(String base, int depth) async {
    if (!_okBase(base) || !seen.add(base)) return null;
    final b = await _getJson(t, '$base$rel');
    if (b is Map<String, Object?> && b['kind'] == connectKind) return b;
    if (depth < 2) {
      final idx = await _getJson(t, '${base}connect.json');
      if (idx is Map<String, Object?> && idx['base'] is String) {
        return tryBase(idx['base']! as String, depth + 1);
      }
    }
    return null;
  }

  for (final base in bases) {
    final r = await tryBase(base, 0);
    if (r != null) return r;
  }
  return null;
}

/// پنل مالکِ تازه‌نصب: با شناسه + رمز + کد، تنظیم دیتابیس را از بستهٔ مالک می‌گیرد (null = نشد).
Future<S3Settings?> discoverOwnerDatabase(
  S3Transport t, {
  required String login,
  required String password,
  required String code,
  List<String> bases = defaultConnectBases,
}) async {
  final env = await fetchConnectBundle(t, 'owner', login, bases: bases);
  if (env == null) return null;
  return openConnect(
    await connectSecret('owner', login, password, code: code),
    env,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ردیف ۱۹۸-U3 — «بستهٔ حساب مالک» (a-…): اتصال خودکار پنل مالکِ گوشی/رایانهٔ تازه.
//
// علت گزارش «گوشی تعریف سرور می‌خواهد»: بستهٔ o-… فقط هنگام «ساخت حساب» یا «ورود با رمز» منتشر
// می‌شد؛ پنل مالکِ رایانه نشست ماندگار دارد و هرگز دوباره رمز نمی‌گیرد ⇒ در صندوقچه هیچ
// `payesh/pub/connect/` نبود (فهرست واقعی ۱۴۰۵/۹/۶) و گوشی چیزی برای یافتن نداشت.
//
// این بسته با «هش ذخیره‌شدهٔ حساب» مهر می‌شود (نه با خود رمز) ⇒ پنل رایانه هر وقت باز باشد و
// تنظیم دیتابیس داشته باشد، بی‌نیاز به رمز آن را منتشر می‌کند. نمک و تکرار PBKDF2 رکورد حساب
// آشکار در بسته است؛ گوشی با همان شناسه + رمز + کد همان هش‌ها را می‌سازد و باز می‌کند. هزینهٔ
// حدس آفلاین = همان PBKDF2 حساب (۱۲۰هزار تکرار). کلید دیتابیس در هیچ کد یا بسته‌ای نیست (D‑23).
// ─────────────────────────────────────────────────────────────────────────────

const String acctKind = 'payesh-connect-acct';
const String acctSalt = 'payesh/connect-acct';

/// `connect/a-<۳۲ نویسهٔ اول sha256>.json` (نسبت به پایه).
String acctBundlePath(String login) {
  final h = hash.sha256
      .convert(utf8.encode('payesh/connect/acct/${connectNorm(login)}'))
      .toString()
      .substring(0, 32);
  return 'connect/a-$h.json';
}

/// رمز بستهٔ حساب از دو هش رکورد (hex).
String acctSecret(List<int> passwordHash, List<int> codeHash) => hash.sha256
    .convert([...utf8.encode('$acctSalt\u0000'), ...passwordHash, ...codeHash])
    .toString();

/// متن بسته (بی‌زمان) — برای تشخیص «تغییری نبود» بی‌نوشتن دوباره (درس U1).
String acctMark(S3Settings s, String login, List<int> salt, int iter,
        List<int> passwordHash, List<int> codeHash) =>
    hash.sha256
        .convert(utf8.encode(jsonEncode({
          'endpoint': endpointText(s.endpoint),
          'bucket': s.bucket,
          'a': s.accessKey,
          'k': s.secretKey,
          'login': connectNorm(login),
          'salt': base64.encode(salt),
          'iter': iter,
          'h': acctSecret(passwordHash, codeHash),
        })))
        .toString();

/// پاکت بستهٔ حساب.
Future<Map<String, Object?>> sealAcct({
  required S3Settings s,
  required List<int> salt,
  required int iter,
  required List<int> passwordHash,
  required List<int> codeHash,
  required int rev,
  List<int>? nonce,
}) async {
  final env = await sealBox(
    secret: acctSecret(passwordHash, codeHash),
    salt: acctSalt,
    kind: acctKind,
    rev: rev,
    plaintext: controlPlaintext(s, rev),
    nonce: nonce,
  );
  return {...env, 'psalt': base64.encode(salt), 'piter': iter};
}

/// باز کردن بستهٔ حساب با هش‌های ساخته‌شده از همان نمک؛ هر خطا ⇒ null.
Future<S3Settings?> openAcct(
  Map<String, Object?> env,
  List<int> passwordHash,
  List<int> codeHash,
) async {
  try {
    final j = jsonDecode(await openBox(
      secret: acctSecret(passwordHash, codeHash),
      salt: acctSalt,
      kind: acctKind,
      env: env,
    ));
    if (j is! Map<String, Object?> || j['v'] != 1 || j['rev'] != env['rev']) {
      return null;
    }
    final e = normalizeS3Endpoint(j['endpoint'] as String?);
    final a = j['accessKey'], k = j['secret'], b = j['bucket'];
    if (e == null ||
        a is! String ||
        k is! String ||
        b is! String ||
        a.isEmpty ||
        k.isEmpty ||
        !bucketNameRe.hasMatch(b)) {
      return null;
    }
    return S3Settings(endpoint: e, accessKey: a, secretKey: k, bucket: b);
  } on Object {
    return null;
  }
}

/// نمک/تکرار آشکار بسته (null = بستهٔ نامعتبر).
({List<int> salt, int iter})? acctParams(Map<String, Object?> env) {
  final s = env['psalt'], i = env['piter'];
  if (s is! String || i is! int || i < 1 || i > 10000000) return null;
  try {
    final salt = base64.decode(s);
    if (salt.length < 8 || salt.length > 64) return null;
    return (salt: salt, iter: i);
  } on FormatException {
    return null;
  }
}

/// انتشار بستهٔ حساب در `payesh/pub/connect/` (عمومی، بی‌کش) + `connect.json`.
Future<void> publishAcctBundle({
  required S3Settings s,
  required S3Transport t,
  required String login,
  required List<int> salt,
  required int iter,
  required List<int> passwordHash,
  required List<int> codeHash,
  DateTime Function()? now,
}) async {
  final at = (now ?? DateTime.now)();
  final rev = at.millisecondsSinceEpoch;
  final env = await sealAcct(
    s: s,
    salt: salt,
    iter: iter,
    passwordHash: passwordHash,
    codeHash: codeHash,
    rev: rev,
  );
  const pub = {'x-amz-acl': 'public-read', 'cache-control': 'no-cache'};
  await s3PutJson(s, t, '$connectPubDir${acctBundlePath(login)}',
      jsonEncode(env), now: now, headers: pub);
  await s3PutJson(
    s,
    t,
    '${connectPubDir}connect.json',
    jsonEncode({
      'v': 1,
      'kind': 'payesh-connect-index',
      'base': connectBaseOf(s),
      'at': at.toUtc().toIso8601String(),
    }),
    now: now,
    headers: pub,
  );
}

/// خواندن بستهٔ حساب از پایه‌ها (همان پیمایش `connect.json`)؛ نبود ⇒ null.
Future<Map<String, Object?>?> fetchAcctBundle(
  S3Transport t,
  String login, {
  List<String> bases = defaultConnectBases,
}) async {
  final rel = acctBundlePath(login);
  final seen = <String>{};
  Future<Map<String, Object?>?> tryBase(String base, int depth) async {
    if (!_okBase(base) || !seen.add(base)) return null;
    final b = await _getJson(t, '$base$rel');
    if (b is Map<String, Object?> && b['kind'] == acctKind) return b;
    if (depth < 2) {
      final idx = await _getJson(t, '${base}connect.json');
      if (idx is Map && idx['base'] is String) {
        return tryBase(idx['base'] as String, depth + 1);
      }
    }
    return null;
  }

  for (final base in bases) {
    final r = await tryBase(base, 0);
    if (r != null) return r;
  }
  return null;
}
