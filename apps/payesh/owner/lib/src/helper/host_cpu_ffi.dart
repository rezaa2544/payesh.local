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

// ردیف ۱۹۶: «سقف قطعی ویندوز» (Job Object با HARD_CAP) از پنل مالک برداشته شد. آن سقف
// کل فرایند — از جمله رشته‌های رابط و رسم صفحه — را محدود می‌کرد؛ روی رایانهٔ مالک با
// سقف ۱۰٪ (کمتر از یک هسته از ۸) صفحه گیر می‌کرد و کند بود. سقف حالا فقط کارهای
// پس‌زمینه را محدود می‌کند (کارهای هم‌زمان کمتر + استراحت بین کارها؛ host_cpu.dart).
