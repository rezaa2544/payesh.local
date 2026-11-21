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
