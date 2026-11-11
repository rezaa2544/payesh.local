/// Device secret storage of the Payesh native client (row 72, ADR-43).
///
/// * [SecureStore] — the contract every platform implements.
/// * [DpapiSecureStore] — Windows: values sealed with DPAPI (CryptProtectData, current user).
/// * Android: `AndroidKeystoreStore` in the app (AES-256-GCM key inside Android Keystore).
/// * [FakeSecureStore] — in-memory, for tests only.
/// * [DatabaseKeyManager] — per-device random 256-bit key for the encrypted local database.
/// * `e2e1` — device-side end-to-end encryption of the direct path (row 107, ADR-105).
library;

export 'src/database_key.dart';
export 'src/e2e1.dart';
export 'src/dpapi_secure_store.dart';
export 'src/fake_secure_store.dart';
export 'src/secure_store.dart';
