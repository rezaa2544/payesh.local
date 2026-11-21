// Row 169 (D-50) — the 32-bit Windows edition's SQLite (SQLite3MC WebAssembly on the shell's
// files) must behave like the native one: encrypted at rest, wrong key refused, and the
// file format identical (a database written by native SQLite3MC opens here).
//   dart run tool/make_web32_fixture.dart > /tmp/fx.b64
//   dart compile js -O1 -o /tmp/sq.js tool/web32_sqlite_check.dart
//   node tool/web32_sqlite_check.mjs /tmp/sq.js sqlite3mc.wasm /tmp/fx.b64
// ignore_for_file: avoid_print
import 'dart:convert';
import 'dart:js_interop';
import 'dart:js_interop_unsafe';

import 'package:payesh_core/io.dart';
import 'package:payesh_core/web_host.dart';
import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_data/sqlite.dart';

var _ok = 0, _fail = 0;

Future<void> check(String id, Future<void> Function() body) async {
  try {
    await body();
    _ok++;
    print('SQ-OK $id');
  } catch (e) {
    _fail++;
    print('SQ-FAIL $id $e');
  }
}

void expect(bool cond, String what) {
  if (!cond) throw StateError(what);
}

const String key =
    'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
const String fixtureKey =
    '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

Future<void> main() async {
  final mem = MemoryHost();
  WebHost.instance = mem;
  await prepareWebHost();
  final wasm = globalContext.getProperty<JSUint8Array>('PAYESH_WASM'.toJS);
  await prepareWebSqlite(wasmBytes: wasm.toDart);
  final dir = r'C:\Users\web\AppData\Local\Payesh';
  Directory(dir).createSync(recursive: true);
  final path = '$dir\\payesh.db';

  await check('SQ-01 cipher library present', () async {
    expect(
      EncryptedDatabase.cipherLibrary().contains('SQLite3 Multiple Ciphers'),
      'mc',
    );
  });

  await check('SQ-02 encrypted engine on a real (host) file', () async {
    final e = EncryptedDatabase.openEngine(path, key);
    await e.put('students', 1, {'name': 'سارا'});
    expect((await e.get('students', 1))?.data['name'] == 'سارا', 'read back');
    e.database.close();
    final bytes = File(path).readAsBytesSync();
    expect(bytes.length >= 4096, 'file written (${bytes.length})');
    expect(!EncryptedDatabase.isPlaintextFile(path), 'not plaintext');
    expect(
      !utf8.decode(bytes, allowMalformed: true).contains('students'),
      'no plaintext table names',
    );
  });

  await check('SQ-03 reopen with the key keeps data', () async {
    final e = EncryptedDatabase.openEngine(path, key);
    expect((await e.get('students', 1))?.data['name'] == 'سارا', 'persisted');
    e.database.close();
  });

  await check('SQ-04 wrong key → WrongKeyException', () async {
    try {
      EncryptedDatabase.open(path, fixtureKey).close();
      throw StateError('opened with the wrong key');
    } on WrongKeyException {
      // expected
    }
  });

  final fx = globalContext.getProperty<JSString?>('PAYESH_FIXTURE'.toJS);
  if (fx != null) {
    await check(
      'SQ-05 database written by NATIVE SQLite3MC opens here',
      () async {
        final p = '$dir\\native.db';
        File(p).writeAsBytesSync(base64.decode(fx.toDart.trim()));
        final db = EncryptedDatabase.open(p, fixtureKey);
        final v = db.select('SELECT v FROM t WHERE k = ?', [
          'school',
        ]).first['v'];
        expect(v == 'پایش ۱۶۹', 'value $v');
        db.close();
      },
    );
  }

  await check('SQ-06 journal files cleaned up', () async {
    final names = Directory(dir).listSync().map((e) => e.path).toList();
    expect(!names.any((n) => n.endsWith('-journal')), 'journal left: $names');
  });

  print(_fail == 0 ? 'WEB32-SQLITE-OK $_ok' : 'WEB32-SQLITE-FAIL $_fail');
}
