// ردیف ۱۶۵/۱۶۹ — GetSystemTimes از kernel32 با dart:ffi (ساخت‌های بومی ویندوز).
import 'dart:ffi';

import 'package:ffi/ffi.dart';

import 'host_cpu.dart' show CpuTimes;

typedef _GetSystemTimesC = Int32 Function(
  Pointer<Uint64>,
  Pointer<Uint64>,
  Pointer<Uint64>,
);
typedef _GetSystemTimesDart = int Function(
  Pointer<Uint64>,
  Pointer<Uint64>,
  Pointer<Uint64>,
);

_GetSystemTimesDart? _gst;

CpuTimes? windowsCpuTimes() {
  try {
    _gst ??= DynamicLibrary.open(
      'kernel32.dll',
    ).lookupFunction<_GetSystemTimesC, _GetSystemTimesDart>('GetSystemTimes');
    final p = calloc<Uint64>(3);
    try {
      if (_gst!(p, p + 1, p + 2) == 0) return null;
      // زمان «هسته» شامل زمان بیکار هم هست
      return (idle: p[0], total: p[1] + p[2]);
    } finally {
      calloc.free(p);
    }
  } on Object {
    return null;
  }
}

// ── ردیف ۱۹۱: مصرف واقعی همین برنامه و سقف قطعی ویندوز ─────────────────────

typedef _CurProcC = IntPtr Function();
typedef _CurProcD = int Function();
typedef _ProcTimesC = Int32 Function(
  IntPtr,
  Pointer<Uint64>,
  Pointer<Uint64>,
  Pointer<Uint64>,
  Pointer<Uint64>,
);
typedef _ProcTimesD = int Function(
  int,
  Pointer<Uint64>,
  Pointer<Uint64>,
  Pointer<Uint64>,
  Pointer<Uint64>,
);
typedef _CreateJobC = IntPtr Function(Pointer<Void>, Pointer<Utf16>);
typedef _CreateJobD = int Function(Pointer<Void>, Pointer<Utf16>);
typedef _SetJobC = Int32 Function(IntPtr, Int32, Pointer<Void>, Uint32);
typedef _SetJobD = int Function(int, int, Pointer<Void>, int);
typedef _AssignC = Int32 Function(IntPtr, IntPtr);
typedef _AssignD = int Function(int, int);

DynamicLibrary? _k32;
DynamicLibrary get _kernel => _k32 ??= DynamicLibrary.open('kernel32.dll');

/// زمان پردازندهٔ مصرف‌شده به‌دست همین فرایند (هسته + کاربر، همهٔ رشته‌ها) بر حسب
/// میکروثانیه — همان عددی که «Task Manager» از آن درصد می‌سازد.
int? windowsProcessCpuMicros() {
  try {
    final cur = _kernel.lookupFunction<_CurProcC, _CurProcD>(
      'GetCurrentProcess',
    );
    final gpt = _kernel.lookupFunction<_ProcTimesC, _ProcTimesD>(
      'GetProcessTimes',
    );
    final p = calloc<Uint64>(4);
    try {
      if (gpt(cur(), p, p + 1, p + 2, p + 3) == 0) return null;
      return (p[2] + p[3]) ~/ 10; // واحد ۱۰۰ نانوثانیه
    } finally {
      calloc.free(p);
    }
  } on Object {
    return null;
  }
}

int _job = 0;
bool _assigned = false;

/// سقف قطعی درصد پردازنده برای همین فرایند با «Job Object» ویندوز
/// (JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | HARD_CAP). خود ویندوز اجرا نمی‌گذارد این برنامه
/// بیش از [pct]٪ از کل توان همهٔ هسته‌ها مصرف کند. null ⇒ برداشتن سقف.
/// true یعنی سقف (یا برداشتنش) واقعاً اعمال شد.
bool windowsApplyCpuCap(int? pct) {
  try {
    final setInfo = _kernel.lookupFunction<_SetJobC, _SetJobD>(
      'SetInformationJobObject',
    );
    if (_job == 0) {
      if (pct == null) return true; // هنوز سقفی نبوده
      final create = _kernel.lookupFunction<_CreateJobC, _CreateJobD>(
        'CreateJobObjectW',
      );
      _job = create(nullptr, nullptr);
      if (_job == 0) return false;
    }
    if (!_assigned) {
      final assign = _kernel.lookupFunction<_AssignC, _AssignD>(
        'AssignProcessToJobObject',
      );
      final cur = _kernel.lookupFunction<_CurProcC, _CurProcD>(
        'GetCurrentProcess',
      );
      if (assign(_job, cur()) == 0) return false;
      _assigned = true;
    }
    // JOBOBJECT_CPU_RATE_CONTROL_INFORMATION { DWORD ControlFlags; DWORD CpuRate; }
    final info = calloc<Uint32>(2);
    try {
      // «بدون سقف» = همان Job با نرخ ۱۰۰٪ (ویندوز ControlFlags=0 را نمی‌پذیرد؛ آزموده روی
      // رایانهٔ مالک ۱۴۰۵/۹/۵: ۱۰٪ ⇒ ۵ تا ۷٪، ۲۵٪ ⇒ ۱۵٪، ۱۰۰٪ ⇒ ۳۰٪ برای یک بار ۴ رشته‌ای)
      info[0] = 0x1 | 0x4;
      info[1] = pct == null ? 10000 : pct.clamp(1, 100) * 100;
      // JobObjectCpuRateControlInformation = 15
      return setInfo(_job, 15, info.cast(), 8) != 0;
    } finally {
      calloc.free(info);
    }
  } on Object {
    return false;
  }
}
