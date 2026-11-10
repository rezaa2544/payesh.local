import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:payesh_secure/payesh_secure.dart';
import 'package:test/test.dart';

/// Stand-in for DPAPI on Linux: XOR keystream + checksum, bound to entropy. Only used to test
/// the file layout of [DpapiSecureStore]; the real DPAPI runs in dpapi_windows_test.dart.
final class FakeCipher implements DpapiCipher {
  int calls = 0;

  /// Digest of the whole entropy so every byte of it matters (like DPAPI).
  static int _h(Uint8List e) {
    var h = 17;
    for (final b in e) {
      h = (h * 31 + b) & 0xffff;
    }
    return h;
  }

  @override
  Uint8List protect(Uint8List plain, Uint8List entropy) {
    calls++;
    final out = Uint8List(plain.length + 1);
    var sum = _h(entropy) & 0xff;
    for (var i = 0; i < plain.length; i++) {
      out[i] = plain[i] ^ entropy[i % entropy.length] ^ 0x5a;
      sum = (sum + plain[i] + entropy[i % entropy.length]) & 0xff;
    }
    out[plain.length] = sum;
    return out;
  }

  @override
  Uint8List unprotect(Uint8List sealed, Uint8List entropy) {
    calls++;
    if (sealed.isEmpty) throw const SecureStoreException('empty');
    final n = sealed.length - 1;
    final plain = Uint8List(n);
    var sum = _h(entropy) & 0xff;
    for (var i = 0; i < n; i++) {
      plain[i] = sealed[i] ^ entropy[i % entropy.length] ^ 0x5a;
      sum = (sum + plain[i] + entropy[i % entropy.length]) & 0xff;
    }
    if (sum != sealed[n]) throw StateError('bad mac');
    return plain;
  }
}

void main() {
  group('SecureStore contract on FakeSecureStore', () {
    test('read/write/delete, missing → null, delete missing is fine', () async {
      final s = FakeSecureStore();
      expect(await s.read(SecureKeys.sessionToken), isNull);
      await s.write(SecureKeys.sessionToken, 'tok-ü-پایش');
      expect(await s.read(SecureKeys.sessionToken), 'tok-ü-پایش');
      await s.delete(SecureKeys.sessionToken);
      await s.delete(SecureKeys.sessionToken);
      expect(await s.read(SecureKeys.sessionToken), isNull);
      expect(s.log.first, 'read:session.token');
    });

    test('key names are validated (no path tricks)', () {
      for (final bad in ['', '../x', 'A', 'a/b', r'a\b', 'a b', 'x' * 65]) {
        expect(() => checkSecureKey(bad), throwsArgumentError, reason: bad);
      }
      expect(checkSecureKey('db.key.v1'), 'db.key.v1');
    });

    test('failWith makes every call fail (fail-closed paths)', () async {
      final s = FakeSecureStore()
        ..failWith = const SecureStoreException('locked', code: 5);
      await expectLater(s.read('a'), throwsA(isA<SecureStoreException>()));
      await expectLater(
        s.write('a', 'b'),
        throwsA(isA<SecureStoreException>()),
      );
      await expectLater(s.delete('a'), throwsA(isA<SecureStoreException>()));
      expect(
        const SecureStoreException('locked', code: 5).toString(),
        contains('(5)'),
      );
      expect(const SecureStoreException('x').toString(), isNot(contains('(')));
    });
  });

  group('DpapiSecureStore file layout (fake cipher on non-Windows)', () {
    late Directory tmp;
    late FakeCipher c;
    late DpapiSecureStore s;
    setUp(() {
      tmp = Directory.systemTemp.createTempSync('payesh_sec_');
      c = FakeCipher();
      s = DpapiSecureStore('${tmp.path}/secure', cipher: c);
    });
    tearDown(() => tmp.deleteSync(recursive: true));

    test(
      'roundtrip, overwrite, persistence across instances, delete',
      () async {
        await s.write('device.id', 'dev-1');
        await s.write('device.id', 'dev-2');
        final again = DpapiSecureStore('${tmp.path}/secure', cipher: c);
        expect(await again.read('device.id'), 'dev-2');
        expect(File('${tmp.path}/secure/device.id.dpapi').existsSync(), isTrue);
        expect(
          File('${tmp.path}/secure/device.id.dpapi.tmp').existsSync(),
          isFalse,
        );
        await s.delete('device.id');
        await s.delete('device.id');
        expect(await s.read('device.id'), isNull);
      },
    );

    test('file carries the PYS1 magic and no plaintext', () async {
      await s.write('session.token', 'very-secret-token');
      final b = File('${tmp.path}/secure/session.token.dpapi')
          .readAsBytesSync();
      expect(ascii.decode(b.sublist(0, 4)), 'PYS1');
      expect(latin1.decode(b).contains('very-secret-token'), isFalse);
    });

    test(
      'tampered, foreign-format, swapped and non-UTF-8 files fail closed',
      () async {
        await s.write('a.key', 'alpha');
        await s.write('b.key', 'bravo');
        final fa = File('${tmp.path}/secure/a.key.dpapi');
        final fb = File('${tmp.path}/secure/b.key.dpapi');
        // swap: entropy is bound to the key name
        final ab = fa.readAsBytesSync();
        fa.writeAsBytesSync(fb.readAsBytesSync());
        await expectLater(
          s.read('a.key'),
          throwsA(isA<SecureStoreException>()),
        );
        // flip a byte
        final t = Uint8List.fromList(ab)..[5] ^= 0x01;
        fa.writeAsBytesSync(t);
        await expectLater(
          s.read('a.key'),
          throwsA(isA<SecureStoreException>()),
        );
        // wrong magic / too short
        fa.writeAsBytesSync([1, 2]);
        await expectLater(
          s.read('a.key'),
          throwsA(isA<SecureStoreException>()),
        );
        fa.writeAsBytesSync([...ascii.encode('XXXX'), 1, 2, 3]);
        await expectLater(
          s.read('a.key'),
          throwsA(isA<SecureStoreException>()),
        );
        // cipher-level SecureStoreException is passed through
        fa.writeAsBytesSync(ascii.encode('PYS1'));
        await expectLater(
          s.read('a.key'),
          throwsA(
            isA<SecureStoreException>().having((e) => e.message, 'm', 'empty'),
          ),
        );
        // valid seal of bytes that are not UTF-8
        final sealed = c.protect(
          Uint8List.fromList([0xff, 0xfe]),
          Uint8List.fromList(
            utf8.encode('${DpapiSecureStore.entropyPrefix}a.key'),
          ),
        );
        fa.writeAsBytesSync([...ascii.encode('PYS1'), ...sealed]);
        await expectLater(
          s.read('a.key'),
          throwsA(isA<SecureStoreException>()),
        );
      },
    );

    test('the real DPAPI cipher refuses to load off Windows', () {
      if (Platform.isWindows) return;
      expect(Win32Dpapi.new, throwsUnsupportedError);
      expect(() => DpapiSecureStore(tmp.path), throwsUnsupportedError);
    });
  });

  group('DatabaseKeyManager', () {
    test('first run creates one random 256-bit key and stores it', () async {
      final s = FakeSecureStore();
      final m = DatabaseKeyManager(s);
      final r = await m.obtain();
      expect(r.created, isTrue);
      expect(r.candidates.single, matches(RegExp(r'^[0-9a-f]{64}$')));
      expect(s.values[SecureKeys.dbKey], r.candidates.single);
      final r2 = await m.obtain();
      expect(r2.created, isFalse);
      expect(r2.candidates, r.candidates);
      expect(m.newKey(), isNot(m.newKey()));
    });

    test(
      'rotation is crash-safe: next is stored before apply, promoted after',
      () async {
        final s = FakeSecureStore();
        final m = DatabaseKeyManager(s, random: Random(1));
        final first = (await m.obtain()).candidates.single;
        String? seenNext;
        final k = await m.rotate((nk) async {
          seenNext = s.values[SecureKeys.dbKeyNext];
          expect(nk, seenNext);
        });
        expect(seenNext, k);
        expect(s.values[SecureKeys.dbKey], k);
        expect(s.values.containsKey(SecureKeys.dbKeyNext), isFalse);
        expect(k, isNot(first));
      },
    );

    test('failed apply keeps the old key and drops next', () async {
      final s = FakeSecureStore();
      final m = DatabaseKeyManager(s);
      final first = (await m.obtain()).candidates.single;
      await expectLater(
        m.rotate((_) async => throw StateError('disk full')),
        throwsStateError,
      );
      expect(s.values[SecureKeys.dbKey], first);
      expect(s.values.containsKey(SecureKeys.dbKeyNext), isFalse);
    });

    test('crash between rekey and promote: obtain offers both keys; confirm settles', () async {
      final s = FakeSecureStore();
      final m = DatabaseKeyManager(s);
      final cur = (await m.obtain()).candidates.single;
      final next = m.newKey();
      s.values[SecureKeys.dbKeyNext] = next;
      final r = await m.obtain();
      expect(r.candidates, [cur, next]);
      await m.confirm(next);
      expect(s.values[SecureKeys.dbKey], next);
      expect(s.values.containsKey(SecureKeys.dbKeyNext), isFalse);
      await m.confirm(next);
      expect(s.values[SecureKeys.dbKey], next);
    });

    test(
      'only next present (crash right after deleting current) → promoted',
      () async {
        final s = FakeSecureStore();
        final m = DatabaseKeyManager(s);
        final next = m.newKey();
        s.values[SecureKeys.dbKeyNext] = next;
        final r = await m.obtain();
        expect(r.candidates, [next]);
        expect(r.created, isFalse);
        expect(s.values[SecureKeys.dbKey], next);
      },
    );

    test(
      'malformed stored key or a store that drops writes → fail closed',
      () async {
        final s = FakeSecureStore()..values[SecureKeys.dbKey] = 'not-hex';
        await expectLater(
          DatabaseKeyManager(s).obtain(),
          throwsA(isA<SecureStoreException>()),
        );
        final lossy = _LossyStore();
        await expectLater(
          DatabaseKeyManager(lossy).obtain(),
          throwsA(isA<SecureStoreException>()),
        );
        final locked = FakeSecureStore()
          ..failWith = const SecureStoreException('locked');
        await expectLater(
          DatabaseKeyManager(locked).obtain(),
          throwsA(isA<SecureStoreException>()),
        );
      },
    );
  });
}

final class _LossyStore implements SecureStore {
  @override
  Future<String?> read(String key) async => null;
  @override
  Future<void> write(String key, String value) async {}
  @override
  Future<void> delete(String key) async {}
}
