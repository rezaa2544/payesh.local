/// ردیف ۱۹۸-U3 — اتصال خودکار دیتابیس پنل مالک با «بستهٔ حساب» (connect/a-…).
///
/// * دستگاهِ دارای تنظیم دیتابیس (معمولاً رایانهٔ مالک) هر بار که باز است، اگر بسته نبود یا
///   فرق داشت، آن را منتشر می‌کند — بی‌نیاز به رمز (مهر با هش ذخیره‌شدهٔ حساب).
/// * دستگاهِ بی‌تنظیم (گوشی/رایانهٔ تازه): با شناسه + رمز + کدِ همان حساب بسته را باز می‌کند،
///   تنظیم را ذخیره می‌کند و رکورد حساب خودش را هم‌نمک بسته می‌کند تا دفعه‌های بعد بی‌رمز
///   هم وصل شود. هیچ فرم «تعریف سرور/دیتابیس» لازم نیست.
library;

import 'package:flutter/foundation.dart' show compute;
import 'package:payesh_secure/payesh_secure.dart';

import 'connect_bundle.dart';
import 'local_account.dart';
import 's3_client.dart';

/// هش رمز و کد با نمک داده‌شده (PBKDF2 کند ⇒ پیش‌فرض در Isolate).
typedef AcctHasher = Future<({List<int> pw, List<int> code})> Function(
  String password,
  String code,
  List<int> salt,
  int iterations,
);

({List<int> pw, List<int> code}) _hashJob(
  ({String pw, String code, List<int> salt, int iter}) m,
) => LocalAccountRecord.hashesFor(m.pw, m.code, m.salt, m.iter);

Future<({List<int> pw, List<int> code})> isolateAcctHasher(
  String password,
  String code,
  List<int> salt,
  int iterations,
) =>
    compute(_hashJob, (pw: password, code: code, salt: salt, iter: iterations));

enum AcctOutcome {
  /// تنظیم دیتابیس از بسته خوانده و ذخیره شد.
  connected,

  /// بسته هست ولی با نمک دیگری ⇒ یک بار ورود با رمز لازم است.
  needsPassword,

  /// بسته‌ای نیست / اینترنت نیست / باز نشد.
  none,
}

bool _sameList(List<int> a, List<int> b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

final class AcctConnector {
  AcctConnector({
    required this.secure,
    required this.transport,
    this.bases = defaultConnectBases,
    this.now,
    AcctHasher? hasher,
  }) : hasher = hasher ?? isolateAcctHasher;

  final SecureStore secure;
  final S3Transport Function() transport;
  final List<String> bases;
  final DateTime Function()? now;
  final AcctHasher hasher;

  /// اثر انگشت آخرین بستهٔ منتشرشده (بی‌تغییر ⇒ بی‌نوشتن؛ درس U1).
  static const String markKey = 'owner.connect.acct.mark';

  bool _verified = false;

  /// منتشر کن اگر بسته نبود یا فرق داشت. true = نوشته شد.
  Future<bool> publishIfChanged(S3Settings s, LocalAccountRecord rec) async {
    final mark = acctMark(
      s,
      rec.loginId,
      rec.salt,
      rec.iterations,
      rec.passwordHash,
      rec.codeHash,
    );
    final t = transport();
    try {
      if (await secure.read(markKey) == mark) {
        if (_verified) return false;
        // یک بار در هر اجرا: بسته واقعاً در صندوقچه هست و همین نمک را دارد؟ (یک GET)
        final env = await fetchAcctBundle(
          t,
          rec.loginId,
          bases: [connectBaseOf(s)],
        );
        final p = env == null ? null : acctParams(env);
        if (p != null &&
            p.iter == rec.iterations &&
            _sameList(p.salt, rec.salt) &&
            await openAcct(env!, rec.passwordHash, rec.codeHash) != null) {
          _verified = true;
          return false;
        }
      }
      await publishAcctBundle(
        s: s,
        t: t,
        login: rec.loginId,
        salt: rec.salt,
        iter: rec.iterations,
        passwordHash: rec.passwordHash,
        codeHash: rec.codeHash,
        now: now,
      );
      await secure.write(markKey, mark);
      _verified = true;
      return true;
    } finally {
      t.close();
    }
  }

  /// بی‌رمز: فقط وقتی بسته هم‌نمک رکورد همین دستگاه است.
  Future<AcctOutcome> tryWithRecord(LocalAccountRecord rec) async {
    final t = transport();
    try {
      final env = await fetchAcctBundle(t, rec.loginId, bases: bases);
      if (env == null) return AcctOutcome.none;
      final p = acctParams(env);
      if (p == null) return AcctOutcome.none;
      if (p.iter != rec.iterations || !_sameList(p.salt, rec.salt)) {
        return AcctOutcome.needsPassword;
      }
      final s = await openAcct(env, rec.passwordHash, rec.codeHash);
      if (s == null) return AcctOutcome.needsPassword;
      await s.save(secure);
      return AcctOutcome.connected;
    } on Object {
      return AcctOutcome.none;
    } finally {
      t.close();
    }
  }

  /// با رمز (ساخت حساب / ورود): باز کردن بسته، ذخیرهٔ تنظیم و هم‌نمک کردن رکورد.
  /// خروجی: رکورد تازه (هم‌نمک بسته) یا null اگر وصل نشد.
  Future<LocalAccountRecord?> tryWithPassword(
    String login,
    String password,
    String code,
  ) async {
    final t = transport();
    try {
      final env = await fetchAcctBundle(t, login, bases: bases);
      if (env == null) return null;
      final p = acctParams(env);
      if (p == null) return null;
      final h = await hasher(password, code, p.salt, p.iter);
      final s = await openAcct(env, h.pw, h.code);
      if (s == null) return null;
      await s.save(secure);
      final rec = LocalAccountRecord(
        loginId: login.trim(),
        salt: p.salt,
        iterations: p.iter,
        passwordHash: h.pw,
        codeHash: h.code,
      );
      await secure.write(LocalAccountKeys.account, rec.encode());
      return rec;
    } on Object {
      return null;
    } finally {
      t.close();
    }
  }
}
