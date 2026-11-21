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

/// نمونه‌گیر درصد مصرف پردازنده + تاریخچهٔ کوتاه برای نمودار.
final class HostCpuMeter {
  HostCpuMeter({CpuTimesReader? read, this.keep = 60})
    : _read = read ?? defaultCpuTimes;

  final CpuTimesReader _read;
  final int keep;
  CpuTimes? _prev;

  /// آخرین درصدها (قدیمی‌ترین اول)، هر کدام ۰ تا ۱۰۰.
  final List<double> history = [];

  /// آخرین درصد (null تا وقتی دو نمونه نگرفته‌ایم یا سیستم پشتیبانی نمی‌شود).
  double? get last => history.isEmpty ? null : history.last;

  double? sample() {
    final now = _read();
    if (now == null) return null;
    final prev = _prev;
    _prev = now;
    if (prev == null) return null;
    final dt = now.total - prev.total;
    if (dt <= 0) return last;
    final pct = (100 * (1 - (now.idle - prev.idle) / dt)).clamp(0.0, 100.0);
    history.add(pct);
    if (history.length > keep) history.removeAt(0);
    return pct;
  }
}
