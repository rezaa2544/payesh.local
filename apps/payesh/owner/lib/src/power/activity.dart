// ردیف ۱۷۷ — «تا تغییری نشده، الکی همه‌چیز را هر لحظه چک نکن».
//
// [OwnerActivity] می‌داند پنجرهٔ برنامه دیده می‌شود یا نه و مالک آخرین بار کِی کاری کرده
// (لمس، کلیک، کلید). [PacedTimer] جای Timer.periodic در همهٔ کارهای دوره‌ای پنل می‌نشیند:
//   • پنجره پنهان/کوچک ⇒ تایمر کاملاً خاموش (صفر درخواست، صفر CPU)؛
//   • مالک فعال (۲ دقیقهٔ اخیر) ⇒ همان آهنگ عادی؛
//   • بیکار ⇒ آهنگ کند ([idleEvery])؛
//   • برگشت به پنجره یا اولین لمس پس از بیکاری ⇒ یک بار فوری تازه می‌شود؛
//   • «توقف پردازش» مالک ([heavy]) ⇒ کارهای سنگین پس‌زمینه اجرا نمی‌شوند؛
//   • [background]: کارهایی که باید با پنجرهٔ کوچک‌شده هم ادامه دهند (سیاست، مسیر بار، بکاپ)
//     ⇒ در پنهانی با همان آهنگ کند [idleEvery].
import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:payesh_core/io.dart' show Platform;

/// وضعیت دیده‌شدن و فعالیت مالک (یک نمونه برای کل برنامه).
class OwnerActivity extends ChangeNotifier {
  OwnerActivity({DateTime Function()? now, this.activeWindow = defaultWindow})
    : _now = now ?? DateTime.now,
      _last = (now ?? DateTime.now)();

  static const Duration defaultWindow = Duration(minutes: 2);

  /// نمونهٔ مشترک برنامه (آزمون‌ها نمونهٔ خودشان را می‌سازند).
  static OwnerActivity instance = OwnerActivity();

  final DateTime Function() _now;
  final Duration activeWindow;
  DateTime _last;
  bool _visible = true;
  bool _processingPaused = false;

  bool get visible => _visible;
  DateTime get lastInteraction => _last;

  /// پنجره دیده می‌شود و مالک در [activeWindow] اخیر کاری کرده.
  bool get active => _visible && _now().difference(_last) < activeWindow;

  /// «توقف پردازش» مالک (سیاست زیرساخت ⇐ proc.paused).
  bool get processingPaused => _processingPaused;

  void setVisible(bool v) {
    if (_visible == v) return;
    _visible = v;
    if (v) _last = _now();
    notifyListeners();
  }

  /// هر لمس/کلید؛ فقط گذار «بیکار ⇒ فعال» خبر می‌دهد (نه به‌ازای هر حرکت موس).
  void markInteraction() {
    final wasIdle = !active;
    _last = _now();
    if (wasIdle) notifyListeners();
  }

  void setProcessingPaused(bool v) {
    if (_processingPaused == v) return;
    _processingPaused = v;
    notifyListeners();
  }

  /// برای [PacedTimer]: آیا الان «بیکار» است (پنجره دیده می‌شود ولی مالک کاری نکرده).
  bool get idle => _visible && !active;
}

/// تایمر دوره‌ای آگاه از دیده‌شدن، فعالیت و «توقف پردازش».
class PacedTimer {
  PacedTimer.periodic(
    this.every,
    this.onTick, {
    Duration? idleEvery,
    this.heavy = false,
    this.wakeRefresh = true,
    this.background = false,
    OwnerActivity? activity,
    DateTime Function()? now,
  }) : idleEvery = idleEvery ?? every * 6,
       _a = activity ?? OwnerActivity.instance,
       _now = now ?? DateTime.now {
    _last = _now();
    _a.addListener(_onActivity);
    _arm();
  }

  /// آهنگ عادی (مالک فعال).
  final Duration every;

  /// آهنگ بیکاری (پیش‌فرض ۶ برابر).
  final Duration idleEvery;

  /// کار سنگین پس‌زمینه: با «توقف پردازش» اجرا نمی‌شود.
  final bool heavy;

  /// برگشت به پنجره / فعال شدن دوباره ⇒ یک اجرای فوری (اگر از آخرین اجرا [every] گذشته).
  final bool wakeRefresh;

  /// پنجرهٔ پنهان ⇒ ادامه با آهنگ [idleEvery] (به‌جای خاموش شدن).
  final bool background;
  final void Function() onTick;
  final OwnerActivity _a;
  final DateTime Function() _now;
  Timer? _t;
  late DateTime _last;
  bool _armedVisible = true;
  bool _cancelled = false;
  int _runs = 0;

  /// چند بار [onTick] واقعاً اجرا شد (آزمون‌ها با آن «بی‌طوفان» را می‌سنجند).
  int get runs => _runs;
  bool get armed => _t != null;

  void _arm() {
    _t?.cancel();
    _t = null;
    if (_cancelled) return;
    if (!_a.visible && !background) return; // پنهان ⇒ هیچ تایمری
    _t = Timer.periodic(_a.visible ? every : idleEvery, (_) => _maybeRun());
    _armedVisible = _a.visible;
  }

  void _maybeRun({bool force = false}) {
    if (_cancelled || (!_a.visible && !background)) return;
    if (heavy && _a.processingPaused) return;
    final since = _now().difference(_last);
    final slow = _a.idle || !_a.visible;
    if (!force && slow && since < idleEvery) return;
    _last = _now();
    _runs++;
    onTick();
  }

  void _onActivity() {
    if (_cancelled) return;
    if (_t == null ? (_a.visible || background) : _armedVisible != _a.visible) {
      _arm();
    }
    if (wakeRefresh &&
        _a.visible &&
        _a.active &&
        _now().difference(_last) >= every) {
      _maybeRun(force: true);
    }
  }

  void cancel() {
    _cancelled = true;
    _t?.cancel();
    _t = null;
    _a.removeListener(_onActivity);
  }
}

/// ردیف ۱۷۷ — سقف «درصد CPU» ⇒ تعداد کارهای هم‌زمان سرور کمکی همین دستگاه.
/// null (تنظیم نشده) ⇒ همان پیش‌فرض قدیمی (نصف هسته‌ها، ۱ تا ۴)؛ وگرنه
/// floor(هسته × درصد) بین ۱ و تعداد هسته‌ها.
int slotsForCpu(int? percent, [int? cores]) {
  final c = max(1, cores ?? Platform.numberOfProcessors);
  if (percent == null) return (c ~/ 2).clamp(1, 4);
  final p = percent.clamp(minCpuPercent, 100);
  return (c * p ~/ 100).clamp(1, c);
}

const int minCpuPercent = 10;

/// ردیف ۱۷۸ — استراحت پس از هر کار برای ماندن زیر سقف درصد CPU (هم‌ارز
/// `server/processing.js` restMs): کار × (۱۰۰ − درصد) / درصد، حداکثر ۵ ثانیه.
/// null یا ۱۰۰ ⇒ بدون استراحت.
Duration restForCpu(Duration work, int? percent) {
  if (percent == null || percent >= 100) return Duration.zero;
  final p = percent.clamp(minCpuPercent, 100);
  final ms = work.inMilliseconds * (100 - p) ~/ p;
  return Duration(milliseconds: ms.clamp(0, maxRest.inMilliseconds));
}

const Duration maxRest = Duration(seconds: 5);

/// کمترینِ دو سقف (null یعنی بدون سقف).
int? minCpu(int? a, int? b) => a == null ? b : (b == null ? a : min(a, b));
