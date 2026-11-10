import 'dart:io';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_secure/payesh_secure.dart';

import 'android_keystore_store.dart';

/// The opened, encrypted local database of this device (row 72).
final class LocalStorage {
  const LocalStorage({
    required this.engine,
    required this.path,
    required this.cipher,
    required this.created,
    this.quarantined,
  });
  final SqliteEngine engine;
  final String path;
  final String cipher;

  /// A new empty database was created (first run, or after quarantine).
  final bool created;

  /// When the existing file could not be decrypted with any stored key (e.g. the platform
  /// key was wiped), it is moved here — never deleted — and a fresh encrypted cache is
  /// started; the server remains the source of truth and is re-pulled after login.
  final String? quarantined;
}

/// Opens `<dir>/payesh.db` encrypted with the device key from [store].
/// Fails closed: if the secure store fails, no database is opened at all.
Future<LocalStorage> openLocalStorage({
  required SecureStore store,
  required String dir,
  DateTime Function()? now,
}) async {
  final cipher = EncryptedDatabase.cipherLibrary();
  Directory(dir).createSync(recursive: true);
  final path = '$dir${Platform.pathSeparator}payesh.db';
  final keys = DatabaseKeyManager(store);
  final o = await keys.obtain();
  if (EncryptedDatabase.isPlaintextFile(path)) {
    EncryptedDatabase.encryptPlaintextFile(path, o.candidates.first);
  }
  for (final k in o.candidates) {
    try {
      final engine = EncryptedDatabase.openEngine(path, k);
      await keys.confirm(k);
      return LocalStorage(
        engine: engine,
        path: path,
        cipher: cipher,
        created: o.created,
      );
    } on WrongKeyException {
      continue;
    }
  }
  final stamp = (now ?? DateTime.now)().toUtc().millisecondsSinceEpoch;
  final aside = '$path.unreadable-$stamp';
  File(path).renameSync(aside);
  final engine = EncryptedDatabase.openEngine(path, o.candidates.first);
  await keys.confirm(o.candidates.first);
  return LocalStorage(
    engine: engine,
    path: path,
    cipher: cipher,
    created: true,
    quarantined: aside,
  );
}

/// Platform wiring: Android Keystore or Windows DPAPI. Other platforms are not targets.
Future<LocalStorage> openPlatformStorage() async {
  if (Platform.isAndroid) {
    final s = AndroidKeystoreStore();
    return openLocalStorage(store: s, dir: await s.dataDir());
  }
  if (Platform.isWindows) {
    final base =
        Platform.environment['LOCALAPPDATA'] ??
        Platform.environment['APPDATA'] ??
        Directory.systemTemp.path;
    final dir = '$base\\Payesh';
    return openLocalStorage(store: DpapiSecureStore('$dir\\secure'), dir: dir);
  }
  throw UnsupportedError('Payesh native targets are Android and Windows');
}
