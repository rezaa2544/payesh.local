// شمارندهٔ واقعی ترافیک شبکهٔ همین دستگاه با هر زیرساخت (ردیف ۱۳۰).
//
// هر درخواست واقعی (مثلاً هر درخواست S3 به دیتابیس) بعد از پایانش این‌جا ثبت می‌شود:
// بایت ارسالی، بایت دریافتی، مدت، موفق یا ناموفق. پایش زنده (live_monitor.dart) از
// اختلاف این شمارنده‌ها در هر ثانیه «سرعت لحظه‌ای ترافیک» را می‌سازد. هیچ عددی ساختگی نیست.

/// شمارنده‌های تجمعی یک زیرساخت (از شروع برنامه).
final class NetCounters {
  int sent = 0;
  int received = 0;
  int requests = 0;
  int errors = 0;

  /// مدت آخرین درخواست کوچک (پاسخ زیر [NetMeter.bulkBytes]) = تأخیر رفت‌وبرگشت.
  int? latencyMs;

  /// سرعت دانلود آخرین پاسخ بزرگ (بایت بر ثانیه).
  double? downBps;
  bool? lastOk;
  DateTime? lastAt;
}

abstract final class NetMeter {
  /// پاسخ از این اندازه بزرگ‌تر ⇒ برای «سرعت انتقال» حساب می‌شود، نه تأخیر.
  static const int bulkBytes = 16 * 1024;

  static final Map<String, NetCounters> _all = {};

  /// نام زیرساخت دیتابیس (همهٔ درخواست‌های S3 این دستگاه).
  static const String db = 'db';

  static NetCounters of(String target) =>
      _all.putIfAbsent(target, NetCounters.new);

  static void record(
    String target, {
    int sent = 0,
    int received = 0,
    required int elapsedMs,
    bool ok = true,
    DateTime? at,
  }) {
    final c = of(target);
    c.sent += sent < 0 ? 0 : sent;
    c.received += received < 0 ? 0 : received;
    c.requests++;
    if (!ok) c.errors++;
    c.lastOk = ok;
    c.lastAt = at ?? DateTime.now();
    if (!ok) return;
    if (received >= bulkBytes) {
      if (elapsedMs > 0) c.downBps = received * 1000 / elapsedMs;
    } else {
      c.latencyMs = elapsedMs;
    }
  }

  /// فقط برای آزمون‌ها.
  static void reset() => _all.clear();
}

/// اندازهٔ تقریبی سرآیند یک درخواست HTTP/1.1 (خط درخواست + سرآیندها) به بایت.
int requestHeadBytes(String method, Uri url, Map<String, String> headers) {
  var n = method.length + url.path.length + url.query.length + 12;
  headers.forEach((k, v) => n += k.length + v.length + 4);
  return n + 2;
}
