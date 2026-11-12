import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:payesh_secure/payesh_secure.dart';

/// حساب محلی پنل مالک: ورود بدون اینترنت روی همین دستگاه.
///
/// شناسه، رمز و کد دومرحله‌ای را خود مالک در اولین اجرا روی دستگاه تعریف می‌کند؛ هیچ
/// رمزی در کد یا مخزن (که عمومی است) نیست. فقط هش PBKDF2-HMAC-SHA256 با نمک تصادفی در
/// انبار امن سیستم‌عامل (ویندوز: DPAPI، اندروید: Keystore) نگه داشته می‌شود.
abstract final class LocalAccountKeys {
  static const String account = 'owner.local.account';

  /// نشست ورود محلی: تا وقتی مالک خودش «خروج» نزند، برنامه بدون ورود دوباره باز می‌شود.
  static const String session = 'owner.local.session';

  /// توکن نشست سرور پلتفرم (اختیاری) تا انقضای خودش.
  static const String serverSession = 'owner.server.session';
}

final RegExp _loginRe = RegExp(r'^[A-Za-z0-9._@-]{3,120}$');
final RegExp _codeRe = RegExp(r'^[0-9]{6}$');

/// کمترین طول رمز عبور محلی.
const int minLocalPassword = 8;

/// تعداد تکرار PBKDF2 در ساخت حساب تازه (هر رکورد تعداد خودش را نگه می‌دارد).
const int defaultPbkdf2Iterations = 120000;

/// بعد از این تعداد تلاش نادرست، ورود برای [lockDuration] بسته می‌شود.
const int maxFailedAttempts = 5;
const Duration lockDuration = Duration(seconds: 30);

/// خطای اعتبارسنجی فرم تعریف حساب (متن فارسی برای نمایش).
String? validateNewAccount({
  required String loginId,
  required String password,
  required String code,
}) {
  if (!_loginRe.hasMatch(loginId.trim())) {
    return 'شناسهٔ ورود باید ۳ تا ۱۲۰ نویسه از حروف لاتین، رقم و . _ @ - باشد.';
  }
  if (password.length < minLocalPassword) {
    return 'رمز عبور باید دست‌کم $minLocalPassword نویسه باشد.';
  }
  if (!_codeRe.hasMatch(code)) return 'کد دومرحله‌ای باید دقیقاً ۶ رقم باشد.';
  return null;
}

/// PBKDF2-HMAC-SHA256 با خروجی ۳۲ بایت (RFC 8018).
Uint8List pbkdf2Sha256(List<int> password, List<int> salt, int iterations) {
  if (iterations < 1) throw ArgumentError.value(iterations, 'iterations');
  final mac = Hmac(sha256, password);
  final block = Uint8List.fromList([...salt, 0, 0, 0, 1]);
  var u = mac.convert(block).bytes;
  final out = Uint8List.fromList(u);
  for (var i = 1; i < iterations; i++) {
    u = mac.convert(u).bytes;
    for (var j = 0; j < out.length; j++) {
      out[j] ^= u[j];
    }
  }
  return out;
}

bool _sameBytes(List<int> a, List<int> b) {
  var diff = a.length ^ b.length;
  final n = min(a.length, b.length);
  for (var i = 0; i < n; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff == 0;
}

/// رکورد ذخیره‌شدهٔ حساب محلی (فقط هش‌ها، هرگز خود رمز یا کد).
final class LocalAccountRecord {
  const LocalAccountRecord({
    required this.loginId,
    required this.salt,
    required this.iterations,
    required this.passwordHash,
    required this.codeHash,
  });

  final String loginId;
  final List<int> salt;
  final int iterations;
  final List<int> passwordHash;
  final List<int> codeHash;

  static List<int> _pw(String password, List<int> salt, int it) =>
      pbkdf2Sha256(utf8.encode('pw:$password'), salt, it);

  static List<int> _code(String code, List<int> salt, int it) =>
      pbkdf2Sha256(utf8.encode('code:$code'), salt, it);

  /// حساب تازه با نمک تصادفی ۱۶ بایتی.
  factory LocalAccountRecord.create({
    required String loginId,
    required String password,
    required String code,
    int iterations = defaultPbkdf2Iterations,
    Random? random,
  }) {
    final r = random ?? Random.secure();
    final salt = List<int>.generate(16, (_) => r.nextInt(256));
    return LocalAccountRecord(
      loginId: loginId.trim(),
      salt: salt,
      iterations: iterations,
      passwordHash: _pw(password, salt, iterations),
      codeHash: _code(code, salt, iterations),
    );
  }

  /// هر سه مورد بررسی می‌شوند (بدون اتصال کوتاه) تا زمان پاسخ چیزی را لو ندهد.
  bool verify(String loginId, String password, String code) {
    final idOk = _sameBytes(
      utf8.encode(loginId.trim()),
      utf8.encode(this.loginId),
    );
    final pwOk = _sameBytes(_pw(password, salt, iterations), passwordHash);
    final codeOk = _sameBytes(_code(code, salt, iterations), codeHash);
    return idOk & pwOk & codeOk;
  }

  String encode() => jsonEncode({
    'v': 1,
    'login': loginId,
    'salt': base64.encode(salt),
    'iter': iterations,
    'pw': base64.encode(passwordHash),
    'code': base64.encode(codeHash),
  });

  /// رکورد خراب یا ناشناخته ⇒ [FormatException] (بسته‌ماندن ورود، نه حدس).
  static LocalAccountRecord decode(String text) {
    final Object? j = jsonDecode(text);
    if (j is! Map<String, Object?> || j['v'] != 1) {
      throw const FormatException('unknown local account record');
    }
    final login = j['login'], salt = j['salt'], it = j['iter'];
    final pw = j['pw'], code = j['code'];
    if (login is! String ||
        salt is! String ||
        it is! int ||
        it < 1 ||
        pw is! String ||
        code is! String) {
      throw const FormatException('corrupted local account record');
    }
    return LocalAccountRecord(
      loginId: login,
      salt: base64.decode(salt),
      iterations: it,
      passwordHash: base64.decode(pw),
      codeHash: base64.decode(code),
    );
  }
}

/// نتیجهٔ یک تلاش ورود محلی.
final class LocalLoginResult {
  const LocalLoginResult.ok() : ok = true, error = null;
  const LocalLoginResult.fail(this.error) : ok = false;
  final bool ok;
  final String? error;
}

/// ورود محلی + قفل موقت بعد از تلاش‌های نادرست پیاپی.
final class LocalAuth {
  LocalAuth(
    this.store, {
    DateTime Function()? now,
    this.iterations = defaultPbkdf2Iterations,
  }) : _now = now ?? DateTime.now;

  final SecureStore store;
  final int iterations;
  final DateTime Function() _now;
  int _failures = 0;
  DateTime? _lockedUntil;

  /// حساب ذخیره‌شده یا null. خطای انبار امن یا رکورد خراب به بالادست می‌رود.
  Future<LocalAccountRecord?> load() async {
    final s = await store.read(LocalAccountKeys.account);
    return s == null ? null : LocalAccountRecord.decode(s);
  }

  Future<LocalAccountRecord> create({
    required String loginId,
    required String password,
    required String code,
  }) async {
    final rec = LocalAccountRecord.create(
      loginId: loginId,
      password: password,
      code: code,
      iterations: iterations,
    );
    await store.write(LocalAccountKeys.account, rec.encode());
    return rec;
  }

  LocalLoginResult login(
    LocalAccountRecord rec, {
    required String loginId,
    required String password,
    required String code,
  }) {
    final until = _lockedUntil;
    final now = _now();
    if (until != null && now.isBefore(until)) {
      final s = until.difference(now).inSeconds + 1;
      return LocalLoginResult.fail(
        'به‌خاطر تلاش‌های نادرست پیاپی، ورود موقتاً بسته است. $s ثانیهٔ دیگر دوباره امتحان کنید.',
      );
    }
    if (rec.verify(loginId, password, code)) {
      _failures = 0;
      _lockedUntil = null;
      return const LocalLoginResult.ok();
    }
    _failures++;
    if (_failures >= maxFailedAttempts) {
      _failures = 0;
      _lockedUntil = now.add(lockDuration);
    }
    return const LocalLoginResult.fail(
      'شناسه، رمز عبور یا کد دومرحله‌ای نادرست است.',
    );
  }

  /// نشست ذخیره‌شده برای همین حساب هست؟ (رکورد نشست فقط شناسه را دارد، نه رمز.)
  Future<bool> hasSession(LocalAccountRecord rec) async {
    final s = await store.read(LocalAccountKeys.session);
    if (s == null) return false;
    try {
      final Object? j = jsonDecode(s);
      return j is Map<String, Object?> &&
          j['v'] == 1 &&
          j['login'] == rec.loginId;
    } on FormatException {
      return false;
    }
  }

  Future<void> saveSession(LocalAccountRecord rec) => store.write(
    LocalAccountKeys.session,
    jsonEncode({
      'v': 1,
      'login': rec.loginId,
      'since': _now().toUtc().toIso8601String(),
    }),
  );

  /// «خروج»: نشست محلی و نشست سرور هر دو پاک می‌شوند.
  Future<void> clearSession() async {
    await store.delete(LocalAccountKeys.session);
    await store.delete(LocalAccountKeys.serverSession);
  }

  /// حذف حساب محلی و نشست‌ها (تنظیمات دیتابیس را فراخواننده جدا پاک می‌کند).
  Future<void> reset() async {
    await clearSession();
    await store.delete(LocalAccountKeys.account);
  }
}
