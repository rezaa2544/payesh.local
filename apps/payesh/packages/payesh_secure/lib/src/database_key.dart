import 'dart:math';

import 'secure_store.dart';

/// Per-device random 256-bit key of the encrypted local database (row 72).
///
/// The key is generated on the device with a CSPRNG, kept only in the [SecureStore]
/// (Android Keystore / Windows DPAPI), never logged, never sent to the server.
/// Losing it means the local cache is unreadable — which is safe: it is re-pulled from the
/// server after login (the server is the source of truth; unsent outbox ops are the only loss,
/// documented in the threat model).
final class DatabaseKeyManager {
  DatabaseKeyManager(this.store, {Random? random})
    : _random = random ?? Random.secure();

  final SecureStore store;
  final Random _random;

  static final RegExp _hex = RegExp(r'^[0-9a-f]{64}$');

  String newKey() {
    final b = StringBuffer();
    for (var i = 0; i < 32; i++) {
      b.write(_random.nextInt(256).toRadixString(16).padLeft(2, '0'));
    }
    return b.toString();
  }

  Future<String?> _valid(String name) async {
    final v = await store.read(name);
    if (v == null) return null;
    if (!_hex.hasMatch(v)) {
      throw SecureStoreException('stored $name is malformed');
    }
    return v;
  }

  /// Keys to try when opening, in order: current, then a pending rotation (crash-safe).
  /// Creates and stores the first key when none exists (`created` = true → new empty DB).
  Future<({List<String> candidates, bool created})> obtain() async {
    final cur = await _valid(SecureKeys.dbKey);
    final next = await _valid(SecureKeys.dbKeyNext);
    if (cur != null) {
      return (candidates: [cur, ?next], created: false);
    }
    if (next != null) {
      await store.write(SecureKeys.dbKey, next);
      await store.delete(SecureKeys.dbKeyNext);
      return (candidates: [next], created: false);
    }
    final k = newKey();
    await store.write(SecureKeys.dbKey, k);
    if (await store.read(SecureKeys.dbKey) != k) {
      throw const SecureStoreException('database key did not persist');
    }
    return (candidates: [k], created: true);
  }

  /// Crash-safe rotation: the new key is persisted as `next` BEFORE [apply] re-encrypts the
  /// database, and promoted only after [apply] succeeded. If the process dies in between,
  /// [obtain] offers both keys so the database always opens.
  Future<String> rotate(Future<void> Function(String newKey) apply) async {
    final k = newKey();
    await store.write(SecureKeys.dbKeyNext, k);
    try {
      await apply(k);
    } catch (_) {
      await store.delete(SecureKeys.dbKeyNext);
      rethrow;
    }
    await store.write(SecureKeys.dbKey, k);
    await store.delete(SecureKeys.dbKeyNext);
    return k;
  }

  /// Called after opening succeeded with candidate [used]: makes it the current key.
  Future<void> confirm(String used) async {
    if (await store.read(SecureKeys.dbKey) != used) {
      await store.write(SecureKeys.dbKey, used);
    }
    await store.delete(SecureKeys.dbKeyNext);
  }
}
