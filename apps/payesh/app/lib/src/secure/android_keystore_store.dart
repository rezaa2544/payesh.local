import 'package:flutter/services.dart';
import 'package:payesh_secure/payesh_secure.dart';

/// Android [SecureStore]: values are AES-256-GCM encrypted with a non-exportable key that
/// lives inside Android Keystore (alias `payesh_secure_v1`, see KeystoreSecureStore.kt);
/// only the ciphertext is kept in the app's private preferences. Backups are disabled
/// in the manifest.
final class AndroidKeystoreStore implements SecureStore {
  AndroidKeystoreStore({MethodChannel? channel})
    : _ch = channel ?? const MethodChannel(channelName);

  static const String channelName = 'ir.payesh.school/secure_store';
  final MethodChannel _ch;

  Future<T?> _call<T>(String method, Map<String, Object?> args) async {
    try {
      return await _ch.invokeMethod<T>(method, args);
    } on PlatformException catch (e) {
      throw SecureStoreException('${e.code}: ${e.message ?? ''}');
    } on MissingPluginException {
      throw const SecureStoreException('secure store channel not available');
    }
  }

  @override
  Future<String?> read(String key) =>
      _call<String>('read', {'key': checkSecureKey(key)});

  @override
  Future<void> write(String key, String value) =>
      _call<void>('write', {'key': checkSecureKey(key), 'value': value});

  @override
  Future<void> delete(String key) =>
      _call<void>('delete', {'key': checkSecureKey(key)});

  /// `Context.noBackupFilesDir` — private, excluded from backups.
  Future<String> dataDir() async {
    final d = await _call<String>('dataDir', const {});
    if (d == null || d.isEmpty) {
      throw const SecureStoreException('no data directory');
    }
    return d;
  }
}
