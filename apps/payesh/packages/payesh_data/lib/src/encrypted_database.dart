import 'dart:io';

import 'package:sqlite3/sqlite3.dart';

import 'sqlite_engine.dart';

/// The key given to [EncryptedDatabase.open] does not decrypt the file
/// (or the file is not a database at all).
final class WrongKeyException implements Exception {
  const WrongKeyException(this.path);
  final String path;
  @override
  String toString() => 'WrongKeyException: cannot decrypt $path';
}

/// The linked SQLite has no encryption support (build misconfigured: the workspace must set
/// `hooks: user_defines: sqlite3: source: sqlite3mc`). Fail closed — never fall back to plaintext.
final class EncryptionUnavailableException implements Exception {
  const EncryptionUnavailableException(this.detail);
  final String detail;
  @override
  String toString() => 'EncryptionUnavailableException: $detail';
}

/// At-rest encryption of the local database (row 72).
///
/// Uses SQLite3 Multiple Ciphers (MIT licence, bundled through the `package:sqlite3` build hook;
/// no OpenSSL). Default cipher: ChaCha20-Poly1305 with per-page MAC, so tampering is detected.
/// The 256-bit key is random per device and lives only in the platform secure store
/// (Android Keystore / Windows DPAPI) — see `payesh_secure` and docs/cloud/72-device-threat-model.md.
abstract final class EncryptedDatabase {
  static final RegExp _hex = RegExp(r'^[0-9a-f]{64}$');

  /// First 16 bytes of every *plaintext* SQLite file.
  static const String plainHeader = 'SQLite format 3\u0000';

  static void _checkKey(String hexKey) {
    if (!_hex.hasMatch(hexKey)) {
      throw ArgumentError('key must be 64 lowercase hex chars (256 bit)');
    }
  }

  /// Name/version of the encryption library, or throws [EncryptionUnavailableException].
  static String cipherLibrary() {
    final db = sqlite3.openInMemory();
    try {
      return db.select('SELECT sqlite3mc_version() AS v').first['v'] as String;
    } on SqliteException catch (e) {
      throw EncryptionUnavailableException(e.message);
    } finally {
      db.close();
    }
  }

  /// Opens [path] decrypted with [hexKey] (creates an encrypted file if it does not exist).
  static Database open(String path, String hexKey) {
    _checkKey(hexKey);
    cipherLibrary();
    final db = sqlite3.open(path);
    try {
      // Key is validated hex (no injection possible); must be the first statement.
      db.execute("PRAGMA hexkey = '$hexKey'");
      db.select('SELECT count(*) FROM sqlite_master');
      return db;
    } on SqliteException catch (e) {
      db.close();
      if (e.resultCode == 26) throw WrongKeyException(path); // SQLITE_NOTADB
      rethrow;
    }
  }

  /// Opens + migrates the data engine on an encrypted file.
  static SqliteEngine openEngine(
    String path,
    String hexKey, {
    String Function()? now,
  }) => SqliteEngine.wrap(open(path, hexKey), now: now);

  /// Re-encrypts an open database with [newHexKey] (key rotation).
  static void rekey(Database db, String newHexKey) {
    _checkKey(newHexKey);
    db.execute("PRAGMA hexrekey = '$newHexKey'");
  }

  /// Encrypts an existing plaintext database file in place (one-time migration).
  static void encryptPlaintextFile(String path, String hexKey) {
    _checkKey(hexKey);
    cipherLibrary();
    if (!isPlaintextFile(path)) {
      throw StateError('$path is not a plaintext SQLite database');
    }
    final db = sqlite3.open(path);
    try {
      db.execute("PRAGMA hexrekey = '$hexKey'");
    } finally {
      db.close();
    }
  }

  /// True when [path] starts with the plaintext SQLite header.
  static bool isPlaintextFile(String path) {
    final f = File(path);
    if (!f.existsSync() || f.lengthSync() < 16) return false;
    final raf = f.openSync();
    try {
      return String.fromCharCodes(raf.readSync(16)) == plainHeader;
    } finally {
      raf.closeSync();
    }
  }
}
