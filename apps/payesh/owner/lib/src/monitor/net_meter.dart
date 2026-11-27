// شمارندهٔ واقعی ترافیک شبکهٔ همین دستگاه با هر زیرساخت (ردیف ۱۳۰).
//
// هر درخواست واقعی (مثلاً هر درخواست S3 به دیتابیس) بعد از پایانش این‌جا ثبت می‌شود:
// بایت ارسالی، بایت دریافتی، مدت، موفق یا ناموفق. پایش زنده (live_monitor.dart) از
// اختلاف این شمارنده‌ها در هر ثانیه «سرعت لحظه‌ای ترافیک» را می‌سازد. هیچ عددی ساختگی نیست.
// ردیف ۱۵۳: هر درخواست (به‌جز انتقال‌های بزرگ) در پنجرهٔ لغزان زمان پاسخ هم ثبت می‌شود
// (p95، نرخ خطا، درخواست در دقیقه) تا «مسیر بار» و کارت «بار لحظه‌ای» داشبورد واقعی باشند.

import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:payesh_core/io.dart';

import '../infra/load_route.dart';

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

  /// ردیف ۱۹۸-U4: سرعت بارگذاری آخرین درخواست بزرگ (بایت بر ثانیه).
  double? upBps;

  /// ردیف ۱۹۸-U4: کندترین درخواست‌های اخیر (برای پروندهٔ عیب‌یابی).
  final List<SlowRequest> slow = [];
  bool? lastOk;
  DateTime? lastAt;

  /// پنجرهٔ ۶۰ ثانیهٔ اخیر (ردیف ۱۵۳).
  final LatencyWindow window = LatencyWindow();
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
    int? latencyMs,
    String? what,
    bool ok = true,
    DateTime? at,
  }) {
    final c = of(target);
    c.sent += sent < 0 ? 0 : sent;
    c.received += received < 0 ? 0 : received;
    c.requests++;
    if (!ok) c.errors++;
    c.lastOk = ok;
    final when = at ?? DateTime.now();
    c.lastAt = when;
    // ردیف ۱۹۸-U4: زمان پاسخ = اتصال + انتظار تا سرآیند (latencyMs)؛ بدون آن (جعلی‌ها) فقط
    // درخواست‌های کوچک در هر دو جهت — پیش‌تر بارگذاری‌های بزرگ (پشتیبان) با ۱۰ تا ۲۰ ثانیه
    // زمان فرستادن در p95 می‌نشستند (p95 ≈ ۱۷٫۶ ثانیه درحالی‌که سرور زیر ۳۰۰ میلی‌ثانیه بود).
    final bulk = received >= bulkBytes || sent >= bulkBytes;
    final lat = latencyMs ?? (bulk ? null : elapsedMs);
    if (!ok || lat != null) {
      c.window.record(
        ok ? lat! : elapsedMs,
        ok: ok,
        atMs: when.millisecondsSinceEpoch,
      );
    }
    if (elapsedMs >= slowMs || (lat ?? 0) >= slowMs) {
      c.slow.add(
        SlowRequest(when, what ?? '?', sent, received, lat, elapsedMs, ok),
      );
      if (c.slow.length > 40) c.slow.removeAt(0);
    }
    if (!ok) return;
    if (received >= bulkBytes && elapsedMs > 0) {
      c.downBps = received * 1000 / elapsedMs;
    }
    if (sent >= bulkBytes && elapsedMs > 0) c.upBps = sent * 1000 / elapsedMs;
    if (lat != null) c.latencyMs = lat;
  }

  /// درخواستی کندتر از این ⇒ در فهرست «کندترین‌ها» ثبت می‌شود.
  static const int slowMs = 1000;

  /// ردهٔ مسیر بدون شناسه‌ها: `/bucket/payesh/outbox/s-1/x.json` ⇒ `payesh/outbox`.
  static String pathClass(String path) {
    final parts = path.split('/').where((p) => p.isNotEmpty).toList();
    if (parts.length <= 1) return '/';
    final keep = parts.skip(1).take(2).toList();
    if (keep.length == 2 && RegExp(r'[0-9]').hasMatch(keep[1])) {
      keep.removeLast();
    }
    return keep.join('/');
  }

  // ── پروندهٔ عیب‌یابی (ردیف ۱۹۸-U4) ────────────────────────────────────────────
  /// پوشه‌ای که هر دقیقه `diag/load.json` در آن نوشته می‌شود (null ⇒ نوشته نمی‌شود).
  static String? diagDir;

  /// سنجه‌های دیگر برای همان پرونده (مثلاً درصدهای کارت پردازش کمکی).
  static Map<String, Object?> Function()? diagExtra;
  static int _diagAt = 0;

  /// خلاصهٔ یک دقیقهٔ اخیر برای بررسی روی خود ویندوز (بی‌کلید و بی‌نام فایل‌ها).
  static Map<String, Object?> diag(int nowMs, {Map<String, Object?>? extra}) {
    final c = of(db);
    final w = c.window.stats(nowMs);
    return {
      'v': 1,
      'at': DateTime.fromMillisecondsSinceEpoch(nowMs)
          .toUtc()
          .toIso8601String(),
      'db': {
        'n': w.n,
        'per_min': w.perMin,
        'p95_ms': w.p95,
        'avg_ms': w.avg,
        'err': w.err,
        'requests': c.requests,
        'errors': c.errors,
        'up_bps': c.upBps?.round(),
        'down_bps': c.downBps?.round(),
      },
      'loop_lag_ms': LoopLag.instance.summary(),
      'slow': [for (final r in c.slow.reversed.take(20)) r.toJson()],
      ...?extra,
    };
  }

  /// حداکثر یک بار در دقیقه؛ خطای دیسک بی‌اثر.
  static void maybeWriteDiag(int nowMs, {Map<String, Object?>? extra}) {
    final dir = diagDir;
    if (dir == null || nowMs - _diagAt < 60000) return;
    _diagAt = nowMs;
    try {
      final d = Directory('$dir${Platform.pathSeparator}diag')
        ..createSync(recursive: true);
      File('${d.path}${Platform.pathSeparator}load.json').writeAsStringSync(
        const JsonEncoder.withIndent(' ').convert(diag(nowMs, extra: extra)),
      );
    } on Object {
      // بی‌اهمیت
    }
  }

  /// فقط برای آزمون‌ها.
  static void reset() {
    _all.clear();
    _diagAt = 0;
  }
}

/// اندازهٔ تقریبی سرآیند یک درخواست HTTP/1.1 (خط درخواست + سرآیندها) به بایت.
int requestHeadBytes(String method, Uri url, Map<String, String> headers) {
  var n = method.length + url.path.length + url.query.length + 12;
  headers.forEach((k, v) => n += k.length + v.length + 4);
  return n + 2;
}

/// یک درخواست کند (ردیف ۱۹۸-U4).
final class SlowRequest {
  const SlowRequest(
    this.at,
    this.what,
    this.sent,
    this.received,
    this.latencyMs,
    this.totalMs,
    this.ok,
  );
  final DateTime at;
  final String what;
  final int sent;
  final int received;
  final int? latencyMs;
  final int totalMs;
  final bool ok;

  Map<String, Object?> toJson() => {
    'at': at.toUtc().toIso8601String(),
    'what': what,
    'sent': sent,
    'recv': received,
    'latency_ms': latencyMs,
    'total_ms': totalMs,
    'ok': ok,
  };
}

/// تأخیر حلقهٔ رویداد همین برنامه (ردیف ۱۹۸-U4): کار سنگین هم‌زمان روی رشتهٔ اصلی
/// زمان پاسخ همهٔ درخواست‌های در جریان را هم بالا می‌برد؛ این‌جا جدا دیده می‌شود.
final class LoopLag {
  LoopLag._();
  static final LoopLag instance = LoopLag._();

  static const Duration every = Duration(milliseconds: 500);
  Timer? _t;
  final Stopwatch _sw = Stopwatch();
  final List<(int at, int lag)> _items = [];

  void start() {
    if (_t != null) return;
    _sw.start();
    var last = _sw.elapsedMilliseconds;
    _t = Timer.periodic(every, (_) {
      final now = _sw.elapsedMilliseconds;
      final lag = math.max(0, now - last - every.inMilliseconds);
      last = now;
      _items.add((now, lag));
      _items.removeWhere((x) => x.$1 < now - 60000);
    });
  }

  void stop() {
    _t?.cancel();
    _t = null;
  }

  Map<String, int> summary() {
    if (_items.isEmpty) return const {'n': 0};
    final lags = [for (final x in _items) x.$2]..sort();
    return {
      'n': lags.length,
      'max': lags.last,
      'p95': lags[math.max(0, (0.95 * lags.length).ceil() - 1)],
      'over_250': lags.where((x) => x > 250).length,
    };
  }
}
