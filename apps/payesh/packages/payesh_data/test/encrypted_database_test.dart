import 'dart:convert';
import 'dart:io';

import 'package:payesh_data/payesh_data.dart';
import 'package:sqlite3/sqlite3.dart';
import 'package:test/test.dart';

const k1 = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const k2 = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';

void main() {
  late Directory tmp;
  late String path;

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('payesh_enc_');
    path = '${tmp.path}/payesh.db';
  });
  tearDown(() => tmp.deleteSync(recursive: true));

  bool fileContains(String needle) {
    final bytes = File(path).readAsBytesSync();
    final n = utf8.encode(needle);
    outer:
    for (var i = 0; i + n.length <= bytes.length; i++) {
      for (var j = 0; j < n.length; j++) {
        if (bytes[i + j] != n[j]) continue outer;
      }
      return true;
    }
    return false;
  }

  test(
    'the linked SQLite is SQLite3 Multiple Ciphers (encryption available)',
    () {
      expect(
        EncryptedDatabase.cipherLibrary(),
        startsWith('SQLite3 Multiple Ciphers'),
      );
    },
  );

  test('data at rest is encrypted: no plaintext header, no plaintext values on disk', () async {
    final e = EncryptedDatabase.openEngine(path, k1);
    await e.put('students', 1, {
      'id': 1,
      'name': 'دانش‌آموز محرمانه',
      'nid': '0012345678',
    });
    e.close();
    expect(EncryptedDatabase.isPlaintextFile(path), isFalse);
    expect(fileContains('SQLite format 3'), isFalse);
    expect(fileContains('0012345678'), isFalse);
    expect(fileContains('students'), isFalse);
    final again = EncryptedDatabase.openEngine(path, k1);
    expect((await again.get('students', 1))!.data['nid'], '0012345678');
    again.close();
  });

  test('wrong key and missing key cannot read the file', () async {
    EncryptedDatabase.openEngine(path, k1).close();
    expect(
      () => EncryptedDatabase.open(path, k2),
      throwsA(isA<WrongKeyException>()),
    );
    final plain = sqlite3.open(path);
    expect(
      () => plain.select('SELECT count(*) FROM sqlite_master'),
      throwsA(isA<SqliteException>().having((e) => e.resultCode, 'code', 26)),
    );
    plain.close();
    expect(WrongKeyException(path).toString(), contains(path));
  });

  test('tampering with ciphertext is detected (page MAC)', () async {
    final e = EncryptedDatabase.openEngine(path, k1);
    await e.putMany([
      for (var i = 0; i < 200; i++)
        RowInput(collection: 'grades', id: i, data: {'s': i}),
    ]);
    e.close();
    final bytes = File(path).readAsBytesSync();
    final mid = bytes.length - 2000;
    bytes[mid] ^= 0xff;
    File(path).writeAsBytesSync(bytes);
    Object? err;
    try {
      final db = EncryptedDatabase.open(path, k1);
      try {
        db.select('SELECT count(*) FROM rows');
        db.select('PRAGMA integrity_check');
        db.select("SELECT * FROM rows WHERE collection = 'grades'");
      } finally {
        db.close();
      }
    } on Object catch (x) {
      err = x;
    }
    expect(
      err,
      isNotNull,
      reason: 'a flipped ciphertext byte must not read back silently',
    );
  });

  test(
    'key rotation: old key stops working, new key opens, data intact',
    () async {
      final e = EncryptedDatabase.openEngine(path, k1);
      await e.put('classes', 3, {'id': 3, 'name': 'دهم'});
      EncryptedDatabase.rekey(e.database, k2);
      e.close();
      expect(
        () => EncryptedDatabase.open(path, k1),
        throwsA(isA<WrongKeyException>()),
      );
      final r = EncryptedDatabase.openEngine(path, k2);
      expect((await r.get('classes', 3))!.data['name'], 'دهم');
      r.close();
    },
  );

  test('one-time migration of an existing plaintext database', () async {
    final p = SqliteEngine.open(path);
    await p.put('announcements', 1, {'id': 1, 'title': 'secret-title'});
    p.close();
    expect(EncryptedDatabase.isPlaintextFile(path), isTrue);
    EncryptedDatabase.encryptPlaintextFile(path, k1);
    expect(EncryptedDatabase.isPlaintextFile(path), isFalse);
    expect(fileContains('secret-title'), isFalse);
    final e = EncryptedDatabase.openEngine(path, k1);
    expect((await e.get('announcements', 1))!.data['title'], 'secret-title');
    e.close();
    expect(
      () => EncryptedDatabase.encryptPlaintextFile(path, k1),
      throwsStateError,
    );
  });

  test(
    'keys must be 256-bit lowercase hex (no SQL injection through the key)',
    () {
      for (final bad in [
        '',
        'abc',
        "${k1.substring(2)}'x",
        k1.toUpperCase(),
        '$k1 ',
      ]) {
        expect(() => EncryptedDatabase.open(path, bad), throwsArgumentError);
        expect(
          () => EncryptedDatabase.encryptPlaintextFile(path, bad),
          throwsArgumentError,
        );
      }
      final db = sqlite3.openInMemory();
      expect(() => EncryptedDatabase.rekey(db, 'nope'), throwsArgumentError);
      db.close();
      expect(
        EncryptedDatabase.isPlaintextFile('${tmp.path}/missing.db'),
        isFalse,
      );
    },
  );

  test('exception messages are descriptive', () {
    expect(const EncryptionUnavailableException('x').toString(), contains('x'));
  });
}
