// Row 194: the Windows «Open» dialog (comdlg32 GetOpenFileNameW) through FFI — no plugin. The
// 32-bit edition (JavaScript; no dart:ffi) compiles win32_file_dialog_web.dart instead.
import 'dart:ffi';
import 'dart:isolate';

import 'package:ffi/ffi.dart';
import 'package:payesh_core/io.dart';

// coverage:ignore-start
// FFI binding — runs only on Windows (checked by hand on the PC, row 194), not in the Linux
// coverage run.

final class _OpenFileName extends Struct {
  @Uint32()
  external int lStructSize;
  external Pointer<Void> hwndOwner;
  external Pointer<Void> hInstance;
  external Pointer<Utf16> lpstrFilter;
  external Pointer<Utf16> lpstrCustomFilter;
  @Uint32()
  external int nMaxCustFilter;
  @Uint32()
  external int nFilterIndex;
  external Pointer<Utf16> lpstrFile;
  @Uint32()
  external int nMaxFile;
  external Pointer<Utf16> lpstrFileTitle;
  @Uint32()
  external int nMaxFileTitle;
  external Pointer<Utf16> lpstrInitialDir;
  external Pointer<Utf16> lpstrTitle;
  @Uint32()
  external int flags;
  @Uint16()
  external int nFileOffset;
  @Uint16()
  external int nFileExtension;
  external Pointer<Utf16> lpstrDefExt;
  @IntPtr()
  external int lCustData;
  external Pointer<Void> lpfnHook;
  external Pointer<Utf16> lpTemplateName;
  external Pointer<Void> pvReserved;
  @Uint32()
  external int dwReserved;
  @Uint32()
  external int flagsEx;
}

const int _ofnNoChangeDir = 0x00000008;
const int _ofnPathMustExist = 0x00000800;
const int _ofnFileMustExist = 0x00001000;
const int _ofnExplorer = 0x00080000;
const int _ofnDontAddToRecent = 0x02000000;

/// Shows the system «Open» dialog owned by the foreground window (the app) and returns the
/// chosen file's path, or null when the user cancels. [filters] are (label, pattern) pairs, e.g.
/// ('Excel', '*.xlsx;*.csv'). The modal dialog runs on a short-lived isolate (with its own COM
/// apartment) so the app keeps painting meanwhile.
Future<String?> windowsOpenFileDialog({
  required String title,
  required List<(String, String)> filters,
}) async {
  if (!Platform.isWindows) {
    throw UnsupportedError('the Open dialog exists only on Windows');
  }
  final user32 = DynamicLibrary.open('user32.dll');
  final owner = user32.lookupFunction<IntPtr Function(), int Function()>(
    'GetForegroundWindow',
  )();
  final spec = StringBuffer();
  for (final (label, pattern) in filters) {
    spec
      ..write('$label ($pattern)\u0000')
      ..write('$pattern\u0000');
  }
  spec.write('\u0000');
  final filter = spec.toString();
  return Isolate.run(() => _show(owner, title, filter));
}

String? _show(int owner, String title, String filter) {
  final ole32 = DynamicLibrary.open('ole32.dll');
  final coInit = ole32
      .lookupFunction<
        Int32 Function(Pointer<Void>, Uint32),
        int Function(Pointer<Void>, int)
      >('CoInitializeEx');
  final coUninit = ole32.lookupFunction<Void Function(), void Function()>(
    'CoUninitialize',
  );
  final comdlg = DynamicLibrary.open('comdlg32.dll');
  final open = comdlg
      .lookupFunction<
        Int32 Function(Pointer<_OpenFileName>),
        int Function(Pointer<_OpenFileName>)
      >('GetOpenFileNameW');
  const max = 4096;
  final hr = coInit(nullptr, 0x2 /* COINIT_APARTMENTTHREADED */);
  final ofn = calloc<_OpenFileName>();
  final file = calloc<Uint16>(max);
  final pFilter = filter.toNativeUtf16();
  final pTitle = title.toNativeUtf16();
  try {
    ofn.ref
      ..lStructSize = sizeOf<_OpenFileName>()
      ..hwndOwner = Pointer<Void>.fromAddress(owner)
      ..lpstrFilter = pFilter
      ..nFilterIndex = 1
      ..lpstrFile = file.cast()
      ..nMaxFile = max
      ..lpstrTitle = pTitle
      ..flags =
          _ofnExplorer |
          _ofnFileMustExist |
          _ofnPathMustExist |
          _ofnNoChangeDir |
          _ofnDontAddToRecent;
    if (open(ofn) == 0) return null;
    final path = file.cast<Utf16>().toDartString();
    return path.isEmpty ? null : path;
  } finally {
    calloc
      ..free(pTitle)
      ..free(pFilter)
      ..free(file)
      ..free(ofn);
    if (hr >= 0) coUninit();
  }
}

// coverage:ignore-end
