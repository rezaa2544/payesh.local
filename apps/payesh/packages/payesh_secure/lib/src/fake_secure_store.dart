import 'secure_store.dart';

/// In-memory [SecureStore] for tests. Can be told to fail to exercise fail-closed paths.
final class FakeSecureStore implements SecureStore {
  final Map<String, String> values = {};
  final List<String> log = [];

  /// When set, every call throws this.
  SecureStoreException? failWith;

  void _check(String op, String key) {
    checkSecureKey(key);
    log.add('$op:$key');
    final f = failWith;
    if (f != null) throw f;
  }

  @override
  Future<String?> read(String key) async {
    _check('read', key);
    return values[key];
  }

  @override
  Future<void> write(String key, String value) async {
    _check('write', key);
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    _check('delete', key);
    values.remove(key);
  }
}
