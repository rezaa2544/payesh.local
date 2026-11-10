// Real Windows DPAPI (crypt32.dll). Runs in the `windows` job of native-client.yml.
@TestOn('windows')
library;

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:payesh_secure/payesh_secure.dart';
import 'package:test/test.dart';

void main() {
  late Directory tmp;
  late DpapiSecureStore s;
  setUp(() {
    tmp = Directory.systemTemp.createTempSync('payesh_dpapi_');
    s = DpapiSecureStore('${tmp.path}\\secure');
  });
  tearDown(() => tmp.deleteSync(recursive: true));

  test('DPAPI roundtrip of a Persian/Unicode value and persistence across instances', () async {
    await s.write(SecureKeys.sessionToken, 'توکن-نشست-ü-1234567890');
    final again = DpapiSecureStore('${tmp.path}\\secure');
    expect(await again.read(SecureKeys.sessionToken), 'توکن-نشست-ü-1234567890');
  });

  test('sealed file contains no plaintext and is a real DPAPI blob', () async {
    await s.write(SecureKeys.dbKey, 'a' * 64);
    final b = File('${tmp.path}\\secure\\db.key.v1.dpapi').readAsBytesSync();
    expect(ascii.decode(b.sublist(0, 4)), 'PYS1');
    expect(latin1.decode(b).contains('a' * 16), isFalse);
    // DPAPI blobs start with dwVersion=1 followed by the DPAPI provider GUID df9d8cd0-1501-11d1-8c7a-00c04fc297eb
    expect(b.sublist(4, 8), [1, 0, 0, 0]);
    expect(b.sublist(8, 12), [0xd0, 0x8c, 0x9d, 0xdf]);
    expect(b.length, greaterThan(100));
  });

  test('tampered blob and swapped files are refused', () async {
    await s.write('a.key', 'alpha');
    await s.write('b.key', 'bravo');
    final fa = File('${tmp.path}\\secure\\a.key.dpapi');
    final fb = File('${tmp.path}\\secure\\b.key.dpapi');
    final orig = fa.readAsBytesSync();
    fa.writeAsBytesSync(fb.readAsBytesSync());
    await expectLater(s.read('a.key'), throwsA(isA<SecureStoreException>()));
    final t = Uint8List.fromList(orig)..[orig.length - 10] ^= 0xff;
    fa.writeAsBytesSync(t);
    await expectLater(s.read('a.key'), throwsA(isA<SecureStoreException>()));
  });

  test('wrong entropy is refused at the cipher level; delete works', () async {
    final c = Win32Dpapi();
    final sealed = c.protect(
      Uint8List.fromList([1, 2, 3]),
      Uint8List.fromList([9]),
    );
    expect(c.unprotect(sealed, Uint8List.fromList([9])), [1, 2, 3]);
    expect(
      () => c.unprotect(sealed, Uint8List.fromList([8])),
      throwsA(isA<SecureStoreException>()),
    );
    await s.write('x.key', 'v');
    await s.delete('x.key');
    expect(await s.read('x.key'), isNull);
  });

  test('DatabaseKeyManager on real DPAPI', () async {
    final m = DatabaseKeyManager(s);
    final r = await m.obtain();
    expect(r.created, isTrue);
    expect(
      (await DatabaseKeyManager(
        DpapiSecureStore('${tmp.path}\\secure'),
      ).obtain()).candidates,
      r.candidates,
    );
  });
}
