import 'dart:convert';
import 'dart:typed_data';

import 'package:payesh_core/io.dart';

import 'secure_store.dart';
import 'win32_dpapi_ffi.dart'
    if (dart.library.js_interop) 'win32_dpapi_web.dart';

// Row 169 (D-50): the 32-bit Windows edition (Flutter web in a CEF x86 shell) seals with the
// same DPAPI call made by the shell — same files, same format, same entropy.
export 'win32_dpapi_ffi.dart'
    if (dart.library.js_interop) 'win32_dpapi_web.dart'
    show Win32Dpapi;

/// Seals/unseals bytes. Production: [Win32Dpapi]. Tests on non-Windows hosts inject a fake
/// to exercise the file layout; the real DPAPI is exercised on `windows-latest` in CI.
abstract interface class DpapiCipher {
  Uint8List protect(Uint8List plain, Uint8List entropy);
  Uint8List unprotect(Uint8List sealed, Uint8List entropy);
}

/// Windows [SecureStore]: each value is sealed with DPAPI for the *current Windows user*
/// (CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN) with app- and key-bound entropy, and stored
/// as `<dir>/<key>.dpapi` (atomic write: temp file + rename).
///
/// Another Windows account on the same PC, or a copy of the files on another machine,
/// cannot unseal them. Swapping two files fails too (entropy includes the key name).
final class DpapiSecureStore implements SecureStore {
  DpapiSecureStore(String directory, {DpapiCipher? cipher})
    : _dir = Directory(directory),
      _cipher = cipher ?? Win32Dpapi() {
    _dir.createSync(recursive: true);
  }

  final Directory _dir;
  final DpapiCipher _cipher;

  static const String entropyPrefix = 'ir.payesh.school/secure-store/v1/';
  static final List<int> magic = ascii.encode('PYS1');

  File _file(String key) =>
      File('${_dir.path}${Platform.pathSeparator}${checkSecureKey(key)}.dpapi');

  static Uint8List _entropy(String key) =>
      Uint8List.fromList(utf8.encode('$entropyPrefix$key'));

  @override
  Future<String?> read(String key) async {
    final f = _file(key);
    if (!f.existsSync()) return null;
    final bytes = f.readAsBytesSync();
    if (bytes.length < magic.length || !_startsWith(bytes, magic)) {
      throw SecureStoreException('$key: unknown file format');
    }
    final Uint8List plain;
    try {
      plain = _cipher.unprotect(
        Uint8List.sublistView(bytes, magic.length),
        _entropy(key),
      );
    } on SecureStoreException {
      rethrow;
    } on Object catch (e) {
      throw SecureStoreException('$key: unseal failed: $e');
    }
    try {
      return utf8.decode(plain);
    } on FormatException {
      throw SecureStoreException('$key: unsealed value is not UTF-8');
    }
  }

  @override
  Future<void> write(String key, String value) async {
    final f = _file(key);
    final sealed = _cipher.protect(
      Uint8List.fromList(utf8.encode(value)),
      _entropy(key),
    );
    final tmp = File('${f.path}.tmp');
    tmp.writeAsBytesSync([...magic, ...sealed], flush: true);
    tmp.renameSync(f.path);
  }

  @override
  Future<void> delete(String key) async {
    final f = _file(key);
    if (f.existsSync()) f.deleteSync();
  }

  static bool _startsWith(List<int> b, List<int> p) {
    for (var i = 0; i < p.length; i++) {
      if (b[i] != p[i]) return false;
    }
    return true;
  }
}
