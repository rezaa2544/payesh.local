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

// ── ردیف ۱۹۸-U4: همان عدد «Task Manager» ────────────────────────────────────
// Task Manager ویندوز ۸ به بعد «% Processor Utility» را نشان می‌دهد (زمان کار × بسامد واقعی
// نسبت به بسامد پایه)، نه «% Processor Time» ِ GetSystemTimes. روی رایانهٔ مالک (ویندوز ۱۱،
// ۸ هسته) در یک لحظه: Utility = ۲۸ تا ۵۴٪ و Time = ۱ تا ۱۳٪ ⇒ کارت «کل سیستم ۲٫۷٪»
// نشان می‌داد درحالی‌که Task Manager حدود ۴۰٪ بود. شمارندهٔ PDH یک بار باز می‌شود و هر
// نمونه فقط یک PdhCollectQueryData است. ویندوز ۷ این شمارنده را ندارد ⇒ null (همان Time).

typedef _PdhOpenC = Int32 Function(Pointer<Utf16>, IntPtr, Pointer<IntPtr>);
typedef _PdhOpenD = int Function(Pointer<Utf16>, int, Pointer<IntPtr>);
typedef _PdhAddC = Int32 Function(
  IntPtr,
  Pointer<Utf16>,
  IntPtr,
  Pointer<IntPtr>,
);
typedef _PdhAddD = int Function(int, Pointer<Utf16>, int, Pointer<IntPtr>);
typedef _PdhCollectC = Int32 Function(IntPtr);
typedef _PdhCollectD = int Function(int);
typedef _PdhFmtC = Int32 Function(
  IntPtr,
  Uint32,
  Pointer<Uint32>,
  Pointer<Uint8>,
);
typedef _PdhFmtD = int Function(int, int, Pointer<Uint32>, Pointer<Uint8>);

const int _pdhFmtDouble = 0x00000200;
const int _pdhFmtNoCap100 = 0x00008000;

final class _Pdh {
  _Pdh(this.collect, this.format, this.counter);
  final _PdhCollectD collect;
  final _PdhFmtD format;
  final int counter;
  int query = 0;
}

_Pdh? _pdh;
bool _pdhFailed = false;

/// درصد «Processor Utility» کل رایانه (۰ تا ۱۰۰، همان Task Manager)؛ null اگر نیست.
double? windowsCpuUtility() {
  if (_pdhFailed) return null;
  try {
    var p = _pdh;
    if (p == null) {
      final lib = DynamicLibrary.open('pdh.dll');
      final open = lib.lookupFunction<_PdhOpenC, _PdhOpenD>('PdhOpenQueryW');
      final add = lib.lookupFunction<_PdhAddC, _PdhAddD>(
        'PdhAddEnglishCounterW',
      );
      final q = calloc<IntPtr>();
      final c = calloc<IntPtr>();
      final path = r'\Processor Information(_Total)\% Processor Utility'
          .toNativeUtf16();
      try {
        if (open(nullptr, 0, q) != 0 || add(q.value, path, 0, c) != 0) {
          _pdhFailed = true;
          return null;
        }
        p = _pdh = _Pdh(
          lib.lookupFunction<_PdhCollectC, _PdhCollectD>('PdhCollectQueryData'),
          lib.lookupFunction<_PdhFmtC, _PdhFmtD>('PdhGetFormattedCounterValue'),
          c.value,
        )..query = q.value;
      } finally {
        calloc
          ..free(q)
          ..free(c)
          ..free(path);
      }
    }
    if (p.collect(p.query) != 0) return null;
    // PDH_FMT_COUNTERVALUE: CStatus (DWORD) + فاصله + double در جابه‌جایی ۸
    final v = calloc<Uint8>(16);
    try {
      if (p.format(p.counter, _pdhFmtDouble | _pdhFmtNoCap100, nullptr, v) !=
          0) {
        return null; // نمونهٔ اول (هنوز دو نمونه نیست) یا داده نامعتبر
      }
      final d = (v + 8).cast<Double>().value;
      if (d.isNaN || d < 0) return null;
      return d > 100 ? 100 : d;
    } finally {
      calloc.free(v);
    }
  } on Object {
    _pdhFailed = true;
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
