// DPAPI through FFI (native Windows builds). Split out of dpapi_secure_store.dart in row 169
// so the 32-bit Windows edition (JavaScript; no dart:ffi) compiles win32_dpapi_web.dart instead.
import 'dart:ffi';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';
import 'package:payesh_core/io.dart';

import 'dpapi_secure_store.dart' show DpapiCipher;
import 'secure_store.dart';

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
