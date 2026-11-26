/// Row 194: the system «Open» dialog of Windows (native: FFI; 32-bit edition: the shell).
library;

export 'win32_file_dialog_ffi.dart'
    if (dart.library.js_interop) 'win32_file_dialog_web.dart';
