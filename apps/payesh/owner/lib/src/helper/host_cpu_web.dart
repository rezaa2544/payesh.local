// ردیف ۱۶۹: نسخهٔ وب ۳۲بیتی dart:ffi ندارد.
import 'host_cpu.dart' show CpuTimes;

CpuTimes? windowsCpuTimes() => null;

/// ردیف ۱۹۱: در نسخهٔ وب خوانده نمی‌شود.
int? windowsProcessCpuMicros() => null;

/// ردیف ۱۹۱: در نسخهٔ وب سقف قطعی نیست.
bool windowsApplyCpuCap(int? pct) => false;
