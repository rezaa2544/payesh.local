// Row 169 (D-50): writes an encrypted database with the NATIVE SQLite3MC (FFI) and prints it
// as base64, so tool/web32_sqlite_check.dart can prove the WebAssembly build of the 32-bit
// edition opens the very same file format. Run: dart run tool/make_web32_fixture.dart
// ignore_for_file: avoid_print
import 'dart:convert';
import 'dart:io';

import 'package:payesh_data/payesh_data.dart';

const String fixtureKey =
    '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

void main() {
  final dir = Directory.systemTemp.createTempSync('w32fx');
  final path = '${dir.path}/native.db';
  final db = EncryptedDatabase.open(path, fixtureKey);
  db.execute('CREATE TABLE t(k TEXT PRIMARY KEY, v TEXT)');
  db.execute("INSERT INTO t VALUES ('school', 'پایش ۱۶۹')");
  db.close();
  print(base64.encode(File(path).readAsBytesSync()));
  dir.deleteSync(recursive: true);
}
