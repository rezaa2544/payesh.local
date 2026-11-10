/// Failure of the platform secret store (key unavailable, blob corrupted or tampered,
/// OS refused). Callers must fail closed: never continue with a missing/guessed secret.
final class SecureStoreException implements Exception {
  const SecureStoreException(this.message, {this.code});
  final String message;
  final int? code;
  @override
  String toString() =>
      'SecureStoreException: $message${code == null ? '' : ' ($code)'}';
}

/// Small secrets only: session token, device id, database key. Never bulk data.
abstract interface class SecureStore {
  /// Value for [key], or null when absent.
  Future<String?> read(String key);

  Future<void> write(String key, String value);

  /// Deleting a missing key is not an error.
  Future<void> delete(String key);
}

final RegExp _keyRe = RegExp(r'^[a-z0-9][a-z0-9._-]{0,63}$');

/// Keys are short ASCII names (they become file names / preference keys).
String checkSecureKey(String key) {
  if (!_keyRe.hasMatch(key)) {
    throw ArgumentError.value(key, 'key', 'must match ${_keyRe.pattern}');
  }
  return key;
}

/// Well-known entries.
abstract final class SecureKeys {
  static const String sessionToken = 'session.token';
  static const String deviceId = 'device.id';
  static const String dbKey = 'db.key.v1';
  static const String dbKeyNext = 'db.key.next';
}
