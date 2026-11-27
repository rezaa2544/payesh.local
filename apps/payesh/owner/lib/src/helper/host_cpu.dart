// ردیف ۱۶۵ — مصرف پردازندهٔ همین رایانه، زنده (برای کارت «پردازش کمکی (همین سیستم)»).
//
// ویندوز: GetSystemTimes از kernel32 (زمان بیکار/هسته/کاربر همهٔ هسته‌ها)؛ لینوکس: /proc/stat.
// درصد = ۱ − (اختلاف بیکار ÷ اختلاف کل) بین دو نمونه. نمونهٔ اول فقط نشانه می‌گذارد (null).
// هیچ فرایندی اجرا نمی‌شود (نه PowerShell، نه wmic) ⇒ هزینهٔ هر نمونه چند میکروثانیه است.

import 'package:payesh_core/io.dart';

// ردیف ۱۶۹: نسخهٔ ۳۲بیتی ویندوز (وب در پوستهٔ CEF) dart:ffi ندارد ⇒ پیاده‌سازی جدا.
import 'host_cpu_ffi.dart' if (dart.library.js_interop) 'host_cpu_web.dart';

/// (بیکار، کل) بر حسب واحدهای خود سیستم‌عامل؛ null اگر خوانده نشد.
typedef CpuTimes = ({int idle, int total});

typedef CpuTimesReader = CpuTimes? Function();

/// سطر اول /proc/stat: `cpu user nice system idle iowait irq softirq steal …`
CpuTimes? parseProcStat(String text) {
  final line = text
      .split('\n')
      .firstWhere((l) => l.startsWith('cpu '), orElse: () => '');
  if (line.isEmpty) return null;
  final n = line
      .split(RegExp(r'\s+'))
      .skip(1)
      .map(int.tryParse)
      .whereType<int>()
      .toList();
  if (n.length < 4) return null;
  final idle = n[3] + (n.length > 4 ? n[4] : 0);
  final total = n.take(8).fold<int>(0, (a, b) => a + b);
  return (idle: idle, total: total);
}

CpuTimes? _linuxTimes() {
  try {
    return parseProcStat(File('/proc/stat').readAsStringSync());
  } on Object {
    return null;
  }
}

CpuTimes? defaultCpuTimes() {
  if (Platform.isWindows) return windowsCpuTimes();
  if (Platform.isLinux || Platform.isAndroid) return _linuxTimes();
  return null;
}

/// درصد «Processor Utility» (همان Task Manager)؛ null ⇒ ندارد (ویندوز ۷، لینوکس، اندروید).
typedef CpuUtilityReader = double? Function();

double? defaultCpuUtility() => Platform.isWindows ? windowsCpuUtility() : null;

/// نمونه‌گیر درصد مصرف پردازنده + تاریخچهٔ کوتاه برای نمودار.
///
/// ردیف ۱۹۸-U4: روی ویندوز ۸ به بعد عدد نشان‌داده‌شده همان «Processor Utility» ِ Task Manager
/// است؛ نسبت Utility به Time ([scale]) برای هم‌خوان کردن «مصرف این برنامه» هم نگه داشته می‌شود.
final class HostCpuMeter {
  HostCpuMeter({
    CpuTimesReader? read,
    CpuUtilityReader? utility,
    this.keep = 60,
  }) : _read = read ?? defaultCpuTimes,
       _utility = utility ?? (read == null ? defaultCpuUtility : _none);

  static double? _none() => null;

  final CpuTimesReader _read;
  final CpuUtilityReader _utility;
  final int keep;
  CpuTimes? _prev;

  /// آخرین درصدها (قدیمی‌ترین اول)، هر کدام ۰ تا ۱۰۰.
  final List<double> history = [];

  /// آخرین درصد (null تا وقتی دو نمونه نگرفته‌ایم یا سیستم پشتیبانی نمی‌شود).
  double? get last => history.isEmpty ? null : history.last;

  /// Utility ÷ Time در آخرین نمونهٔ معتبر (۱ ⇒ بی‌تبدیل).
  double scale = 1;

  /// عدد آخرین نمونه «Processor Utility» بود (همان Task Manager)؟
  bool utilityBased = false;

  double? sample() {
    final now = _read();
    final u = _utility();
    final prev = _prev;
    if (now != null) _prev = now;
    double? time;
    if (now != null && prev != null) {
      final dt = now.total - prev.total;
      if (dt > 0) {
        time = (100 * (1 - (now.idle - prev.idle) / dt)).clamp(0.0, 100.0);
      }
    }
    final double pct;
    if (u != null) {
      pct = u.clamp(0.0, 100.0);
      utilityBased = true;
      // زیر ۰٫۵٪ نسبت پر از نویز است؛ نسبت قبلی می‌ماند
      if (time != null && time >= 0.5) scale = (pct / time).clamp(1.0, 20.0);
    } else if (time != null) {
      pct = time;
      utilityBased = false;
      scale = 1;
    } else {
      return now == null ? null : last;
    }
    history.add(pct);
    if (history.length > keep) history.removeAt(0);
    return pct;
  }

  /// درصد یک فرایند (از GetProcessTimes) به مقیاس Task Manager: همان نسبت Utility/Time،
  /// و هرگز بیش از کل سیستم.
  double? asTaskManager(double? processPct) {
    if (processPct == null) return null;
    final v = processPct * scale;
    final all = last;
    return all != null && v > all ? all : v;
  }
}

// ── ردیف ۱۹۱: «مصرف همین برنامه» واقعی و سقف قطعی ─────────────────────────────

/// زمان پردازندهٔ مصرف‌شدهٔ همین فرایند (میکروثانیه)؛ null اگر خوانده نشد.
typedef ProcessCpuReader = int? Function();

/// /proc/self/stat: فیلدهای ۱۴ و ۱۵ (utime، stime) بر حسب تیک (۱۰۰ در ثانیه).
int? parseSelfStat(String text) {
  final i = text.lastIndexOf(')');
  if (i < 0) return null;
  final f = text.substring(i + 2).split(' ');
  // پس از «)»: state=0 … utime=11، stime=12
  if (f.length < 13) return null;
  final u = int.tryParse(f[11]);
  final s = int.tryParse(f[12]);
  if (u == null || s == null) return null;
  return (u + s) * 10000; // تیک ۱۰ میلی‌ثانیه
}

int? defaultProcessCpuMicros() {
  if (Platform.isWindows) return windowsProcessCpuMicros();
  if (Platform.isLinux || Platform.isAndroid) {
    try {
      return parseSelfStat(File('/proc/self/stat').readAsStringSync());
    } on Object {
      return null;
    }
  }
  return null;
}

/// درصد پردازندهٔ همین برنامه از کل توان رایانه (همهٔ هسته‌ها) — همان ستون CPU در
/// «Task Manager». کار کمکی، پشتیبان، پایش و خود صفحه همه در همین فرایندند.
final class ProcessCpuMeter {
  ProcessCpuMeter({
    ProcessCpuReader? read,
    int Function()? wallMicros,
    int? cores,
    this.keep = 60,
  }) : _read = read ?? defaultProcessCpuMicros,
       _wall = wallMicros ?? _stopwatchMicros,
       cores = cores ?? Platform.numberOfProcessors;

  static final Stopwatch _sw = Stopwatch()..start();
  static int _stopwatchMicros() => _sw.elapsedMicroseconds;

  final ProcessCpuReader _read;
  final int Function() _wall;
  final int cores;
  final int keep;
  ({int cpu, int wall})? _prev;
  final List<double> history = [];
  double? get last => history.isEmpty ? null : history.last;

  double? sample() {
    final cpu = _read();
    if (cpu == null) return null;
    final now = (cpu: cpu, wall: _wall());
    final prev = _prev;
    _prev = now;
    if (prev == null) return null;
    final dw = now.wall - prev.wall;
    if (dw <= 0) return last;
    final pct = (100 * (now.cpu - prev.cpu) / (dw * (cores < 1 ? 1 : cores)))
        .clamp(0.0, 100.0);
    history.add(pct);
    if (history.length > keep) history.removeAt(0);
    return pct;
  }
}

typedef CpuCapApplier = bool Function(int? pct);

/// ردیف ۱۹۶: پنل مالک هرگز خودش را در سیستم‌عامل محدود نمی‌کند. «سقف قطعی ویندوز» (Job
/// Object با HARD_CAP، ردیف ۱۹۱) کل فرایند را محدود می‌کرد — رشته‌های رابط و رسم صفحه هم —
/// و روی رایانهٔ مالک با سقف ۱۰٪ (کمتر از یک هسته از ۸) همهٔ صفحه‌ها گیر می‌کرد.
bool _noOsCap(int? pct) => false;

/// سقف درصد پردازندهٔ کارهای پس‌زمینهٔ همین برنامه (پردازش کمکی، پشتیبان خودکار، پایش).
/// با کم کردن کارهای هم‌زمان و استراحت بین کارها رعایت می‌شود؛ خود صفحه آزاد می‌ماند.
/// [hard] فقط وقتی true است که یک [apply] تزریقی (آزمون) سقف را پذیرفته باشد.
final class CpuCap {
  CpuCap({CpuCapApplier? apply}) : _apply = apply ?? _noOsCap;

  static CpuCap instance = CpuCap();

  final CpuCapApplier _apply;
  int? _pct;
  bool _set = false;
  bool hard = false;

  /// سقف فعلی (null ⇒ بدون سقف).
  int? get percent => _pct;

  /// سقف تازه؛ همان مقدار قبلی ⇒ کاری نمی‌کند.
  bool set(int? pct) {
    final p = pct == null || pct >= 100 ? null : pct;
    if (_set && p == _pct) return hard;
    _set = true;
    _pct = p;
    hard = _apply(p) && p != null;
    return hard;
  }
}
