/// SQLite for every Payesh package — row 169 (D-50).
///
/// Native builds: `package:sqlite3/sqlite3.dart` (SQLite3 Multiple Ciphers through FFI),
/// unchanged. The 32-bit Windows edition (Flutter web in a CEF x86 shell): the same SQLite3MC
/// compiled to WebAssembly (`sqlite3mc.wasm`, sqlite3.dart release 3.9.1) with a file system
/// on the shell's real files — so the encrypted database lives at the same path, in the same
/// format, as on the 64-bit build. Call [prepareWebSqlite] once at start-up (no-op natively).
library;

export 'src/sqlite/sqlite_native.dart'
    if (dart.library.js_interop) 'src/sqlite/sqlite_web.dart';
