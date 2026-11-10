import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

import 'secure_store.dart';

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

// coverage:ignore-start
// FFI binding — runs only on Windows; covered by test/dpapi_windows_test.dart in the
// `windows` CI job (native-client.yml), not by the Linux coverage run.

final class _Blob extends Struct {
  @Uint32()
  external int cbData;
  external Pointer<Uint8> pbData;
}

typedef _CryptC = Int32 Function(
  Pointer<_Blob> dataIn,
  Pointer<Void> descr,
  Pointer<_Blob> entropy,
  Pointer<Void> reserved,
  Pointer<Void> prompt,
  Uint32 flags,
  Pointer<_Blob> dataOut,
);
typedef _CryptD = int Function(
  Pointer<_Blob>,
  Pointer<Void>,
  Pointer<_Blob>,
  Pointer<Void>,
  Pointer<Void>,
  int,
  Pointer<_Blob>,
);

/// DPAPI through crypt32.dll (no plugin, no extra runtime).
final class Win32Dpapi implements DpapiCipher {
  factory Win32Dpapi() {
    if (!Platform.isWindows) {
      throw UnsupportedError('DPAPI exists only on Windows');
    }
    final crypt32 = DynamicLibrary.open('crypt32.dll');
    final kernel32 = DynamicLibrary.open('kernel32.dll');
    return Win32Dpapi._(
      crypt32.lookupFunction<_CryptC, _CryptD>('CryptProtectData'),
      crypt32.lookupFunction<_CryptC, _CryptD>('CryptUnprotectData'),
      kernel32.lookupFunction<
        Pointer<Void> Function(Pointer<Void>),
        Pointer<Void> Function(Pointer<Void>)
      >('LocalFree'),
    );
  }

  Win32Dpapi._(this._protect, this._unprotect, this._localFree);

  final _CryptD _protect;
  final _CryptD _unprotect;
  final Pointer<Void> Function(Pointer<Void>) _localFree;

  static const int _uiForbidden = 0x1;

  Uint8List _run(_CryptD fn, String name, Uint8List input, Uint8List entropy) {
    return using((arena) {
      Pointer<_Blob> blob(Uint8List b) {
        final p = arena<_Blob>();
        final data = arena<Uint8>(b.isEmpty ? 1 : b.length);
        data.asTypedList(b.isEmpty ? 1 : b.length).setAll(0, b);
        p.ref
          ..cbData = b.length
          ..pbData = data;
        return p;
      }

      final inB = blob(input);
      final entB = blob(entropy);
      final out = arena<_Blob>();
      final ok = fn(inB, nullptr, entB, nullptr, nullptr, _uiForbidden, out);
      if (ok == 0) {
        throw SecureStoreException('$name failed');
      }
      try {
        return Uint8List.fromList(out.ref.pbData.asTypedList(out.ref.cbData));
      } finally {
        _localFree(out.ref.pbData.cast());
      }
    });
  }

  @override
  Uint8List protect(Uint8List plain, Uint8List entropy) =>
      _run(_protect, 'CryptProtectData', plain, entropy);

  @override
  Uint8List unprotect(Uint8List sealed, Uint8List entropy) =>
      _run(_unprotect, 'CryptUnprotectData', sealed, entropy);
}

// coverage:ignore-end
