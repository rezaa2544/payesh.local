// Native builds: package:sqlite3 itself (row 169 — see package:payesh_data/sqlite.dart).
import 'dart:typed_data';

export 'package:sqlite3/sqlite3.dart';

/// Native builds load SQLite through FFI; nothing to prepare.
Future<void> prepareWebSqlite({
  String wasmUrl = 'sqlite3mc.wasm',
  Uint8List? wasmBytes,
}) async {}
