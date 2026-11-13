// پایداری اتصال برای هر زیرساخت (دیتابیس S3 امروز، هر سرویس دیگری فردا):
//   • تلاش دوباره با فاصلهٔ نمایی + لرزش تصادفی (jitter) فقط برای خطاهای گذرا؛
//   • به خاطر سپردن آدرسی که آخرین بار جواب داده (اگر آدرس اصلی موقتاً در دسترس نبود و
//     آدرس جایگزینِ همان سرویس جواب داد، درخواست‌های بعدی اول سراغ همان می‌روند)؛
//   • بدون هیچ کار دستی: کاربر هرگز برای وصل شدن دوباره لازم نیست آدرس را عوض کند.

import 'dart:async';
import 'dart:io';
import 'dart:math';

/// فاصلهٔ تلاش‌های دوباره. `attempts` = کل تلاش‌ها روی یک آدرس (۱ = بدون تلاش دوباره).
final class RetryPolicy {
  const RetryPolicy({
    this.attempts = 3,
    this.base = const Duration(milliseconds: 400),
    this.max = const Duration(seconds: 4),
  });

  /// فقط یک تلاش (آزمون‌ها و جاهایی که خودشان تلاش دوباره دارند).
  static const RetryPolicy none = RetryPolicy(attempts: 1);

  final int attempts;
  final Duration base;
  final Duration max;

  /// فاصلهٔ پیش از تلاش شمارهٔ `retry` (از ۰): نمایی تا سقف، و بعد «لرزش برابر»
  /// (نیمی ثابت + نیمی تصادفی) تا چند دستگاه هم‌زمان با هم دوباره نکوبند.
  Duration delayFor(int retry, [Random? random]) {
    final r = random ?? _rnd;
    final exp = base.inMicroseconds * pow(2, min(retry, 16));
    final capped = min(exp.toDouble(), max.inMicroseconds.toDouble());
    final half = capped / 2;
    return Duration(microseconds: (half + r.nextDouble() * half).round());
  }
}

final Random _rnd = Random();

/// خطای گذرای شبکه؟ (ارزش تلاش دوباره روی همان آدرس دارد)
bool isTransientNetworkError(Object e) => switch (e) {
  TimeoutException() => true,
  SocketException() => true,
  HttpException() => true, // مثلاً اتصالِ keep-alive که سرور بسته بود
  HandshakeException(:final message, :final osError) => !_certProblem(
    '$message ${osError?.message ?? ''}',
  ),
  TlsException(:final message, :final osError) => !_certProblem(
    '$message ${osError?.message ?? ''}',
  ),
  _ => false,
};

bool _certProblem(String m) {
  final s = m.toUpperCase();
  return s.contains('CERTIFICATE') || s.contains('HOSTNAME MISMATCH');
}

/// خطای ناشی از نرسیدن به خود آدرس (DNS، اتصال، TLS)؟ ⇒ آدرس جایگزین را امتحان کن.
bool isReachabilityError(Object e) =>
    e is TimeoutException ||
    e is SocketException ||
    e is HttpException ||
    e is TlsException;

/// پاسخ HTTP گذرا؟ (۴۰۸، ۴۲۹، ۵xx — سرور هست ولی همین حالا نتوانست)
bool isTransientStatus(int status) =>
    status == 408 || status == 429 || (status >= 500 && status <= 599);

/// اجرای [f] با تلاش دوباره برای خطاهای گذرا ([retryIf]، پیش‌فرض: خطای شبکه).
Future<T> withRetry<T>(
  Future<T> Function(int attempt) f, {
  RetryPolicy policy = const RetryPolicy(),
  bool Function(Object error)? retryIf,
  Future<void> Function(Duration)? sleep,
  void Function(int attempt, Object error)? onRetry,
}) async {
  final test = retryIf ?? isTransientNetworkError;
  final wait = sleep ?? Future<void>.delayed;
  for (var i = 0; ; i++) {
    try {
      return await f(i);
    } on Object catch (e) {
      if (i + 1 >= policy.attempts || !test(e)) rethrow;
      onRetry?.call(i, e);
      await wait(policy.delayFor(i));
    }
  }
}

/// حافظهٔ مسیرِ سالم برای هر سرویس: کلید = آدرس تنظیم‌شده، مقدار = آدرسی که آخرین بار جواب
/// داد. فقط در حافظهٔ همین اجرا (تنظیمات کاربر هرگز خودکار عوض نمی‌شود).
final class EndpointRoutes {
  EndpointRoutes._();

  static final Map<String, String> _preferred = {};

  /// ترتیب امتحان: اول آخرین آدرس سالم، بعد آدرس تنظیم‌شده، بعد بقیهٔ جایگزین‌ها.
  static List<T> order<T>(
    T configured,
    List<T> alternates,
    String Function(T) key,
  ) {
    final all = <T>[configured, ...alternates];
    final seen = <String>{};
    final unique = [
      for (final e in all)
        if (seen.add(key(e))) e,
    ];
    final pref = _preferred[key(configured)];
    if (pref == null) return unique;
    final i = unique.indexWhere((e) => key(e) == pref);
    if (i <= 0) return unique;
    return [unique[i], ...unique.take(i), ...unique.skip(i + 1)];
  }

  static void good(String configured, String used) {
    if (configured == used) {
      _preferred.remove(configured);
    } else {
      _preferred[configured] = used;
    }
  }

  static void reset() => _preferred.clear();
}
