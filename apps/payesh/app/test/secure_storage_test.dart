import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/app.dart';
import 'package:payesh_app/src/secure/android_keystore_store.dart';
import 'package:payesh_app/src/secure/local_storage.dart';
import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_secure/payesh_secure.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('AndroidKeystoreStore (Dart side of the Keystore channel)', () {
    const ch = MethodChannel(AndroidKeystoreStore.channelName);
    final calls = <MethodCall>[];
    final native = <String, String>{};
    setUp(() {
      calls.clear();
      native.clear();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(ch, (c) async {
            calls.add(c);
            final a = (c.arguments as Map).cast<String, Object?>();
            switch (c.method) {
              case 'read':
                return native[a['key']];
              case 'write':
                if (a['value'] == 'boom') {
                  throw PlatformException(
                    code: 'secure_store',
                    message: 'KeyPermanentlyInvalidatedException',
                  );
                }
                native[a['key']! as String] = a['value']! as String;
                return null;
              case 'delete':
                native.remove(a['key']);
                return null;
              case 'dataDir':
                return '/data/user/0/ir.payesh.school.payesh_app/no_backup';
            }
            return null;
          });
    });
    tearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(ch, null),
    );

    test('read/write/delete/dataDir go through the channel', () async {
      final s = AndroidKeystoreStore();
      expect(await s.read('device.id'), isNull);
      await s.write('device.id', 'd-1');
      expect(await s.read('device.id'), 'd-1');
      await s.delete('device.id');
      expect(await s.read('device.id'), isNull);
      expect(await s.dataDir(), endsWith('no_backup'));
      expect(calls.map((c) => c.method), [
        'read',
        'write',
        'read',
        'delete',
        'read',
        'dataDir',
      ]);
    });

    test('platform errors become SecureStoreException; bad keys never reach native', () async {
      final s = AndroidKeystoreStore();
      await expectLater(
        s.write('device.id', 'boom'),
        throwsA(isA<SecureStoreException>()),
      );
      expect(() => s.read('../etc'), throwsArgumentError);
      expect(calls.where((c) => c.method == 'read'), isEmpty);
    });

    test('missing channel or empty data dir fails closed', () async {
      final s = AndroidKeystoreStore(
        channel: const MethodChannel('nobody/listens'),
      );
      await expectLater(s.read('a'), throwsA(isA<SecureStoreException>()));
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(ch, (c) async => '');
      await expectLater(
        AndroidKeystoreStore().dataDir(),
        throwsA(isA<SecureStoreException>()),
      );
    });
  });

  group('openLocalStorage', () {
    late Directory tmp;
    setUp(() => tmp = Directory.systemTemp.createTempSync('payesh_app_'));
    tearDown(() => tmp.deleteSync(recursive: true));

    test(
      'first run: random key in the secure store, encrypted file on disk',
      () async {
        final store = FakeSecureStore();
        final s = await openLocalStorage(store: store, dir: tmp.path);
        expect(s.created, isTrue);
        expect(s.cipher, startsWith('SQLite3 Multiple Ciphers'));
        await s.engine.put('students', 1, {'id': 1, 'name': 'x'});
        s.engine.close();
        expect(EncryptedDatabase.isPlaintextFile(s.path), isFalse);
        expect(
          store.values[SecureKeys.dbKey],
          matches(RegExp(r'^[0-9a-f]{64}$')),
        );
        final again = await openLocalStorage(store: store, dir: tmp.path);
        expect(again.created, isFalse);
        expect((await again.engine.get('students', 1))!.data['name'], 'x');
        again.engine.close();
      },
    );

    test('existing plaintext database is encrypted in place', () async {
      final p = SqliteEngine.open('${tmp.path}/payesh.db');
      await p.put('classes', 2, {'id': 2});
      p.close();
      final s = await openLocalStorage(store: FakeSecureStore(), dir: tmp.path);
      expect(EncryptedDatabase.isPlaintextFile(s.path), isFalse);
      expect(await s.engine.get('classes', 2), isNotNull);
      s.engine.close();
    });

    test('pending rotation key is used when the current one fails', () async {
      final store = FakeSecureStore();
      final s = await openLocalStorage(store: store, dir: tmp.path);
      final m = DatabaseKeyManager(store);
      final next = m.newKey();
      store.values[SecureKeys.dbKeyNext] = next;
      EncryptedDatabase.rekey(s.engine.database, next);
      s.engine.close();
      final r = await openLocalStorage(store: store, dir: tmp.path);
      expect(store.values[SecureKeys.dbKey], next);
      expect(store.values.containsKey(SecureKeys.dbKeyNext), isFalse);
      r.engine.close();
    });

    test('lost platform key: old file is quarantined (kept), fresh encrypted cache', () async {
      final s = await openLocalStorage(store: FakeSecureStore(), dir: tmp.path);
      s.engine.close();
      final r = await openLocalStorage(
        store: FakeSecureStore(),
        dir: tmp.path,
        now: () => DateTime.utc(2026, 11, 10),
      );
      expect(r.created, isTrue);
      expect(r.quarantined, endsWith('.unreadable-1794268800000'));
      expect(File(r.quarantined!).existsSync(), isTrue);
      r.engine.close();
    });

    test('secure store failure → nothing is opened', () async {
      final store = FakeSecureStore()
        ..failWith = const SecureStoreException('locked');
      await expectLater(
        openLocalStorage(store: store, dir: tmp.path),
        throwsA(isA<SecureStoreException>()),
      );
      expect(File('${tmp.path}/payesh.db').existsSync(), isFalse);
    });

    test('openPlatformStorage refuses non-target hosts', () async {
      if (Platform.isAndroid || Platform.isWindows) return;
      await expectLater(openPlatformStorage(), throwsUnsupportedError);
    });
  });

  group('StorageStatus widget', () {
    testWidgets('shows ok / quarantine / error states', (tester) async {
      final tmp = Directory.systemTemp.createTempSync('payesh_w_');
      addTearDown(() => tmp.deleteSync(recursive: true));
      final ok = await tester.runAsync(
        () => openLocalStorage(store: FakeSecureStore(), dir: tmp.path),
      );
      await tester.pumpWidget(PayeshApp(storage: Future.value(ok)));
      await tester.pumpAndSettle();
      expect(find.text('پایگاه محلی رمزنگاری‌شده فعال است'), findsOneWidget);
      ok!.engine.close();

      final q = LocalStorage(
        engine: SqliteEngine.inMemory(),
        path: 'p',
        cipher: 'c',
        created: true,
        quarantined: 'p.unreadable-1',
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: StorageStatus(storage: Future.value(q))),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('storage-ok')), findsOneWidget);
      expect(find.textContaining('پایگاه تازه'), findsOneWidget);

      final failed = Future<LocalStorage>.error(const SecureStoreException('x'))
        ..ignore();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: StorageStatus(key: UniqueKey(), storage: failed),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('storage-error')), findsOneWidget);

      final pending = Completer<LocalStorage>();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: StorageStatus(key: UniqueKey(), storage: pending.future),
          ),
        ),
      );
      expect(find.textContaining('در حال باز کردن'), findsOneWidget);
    });
  });
}
