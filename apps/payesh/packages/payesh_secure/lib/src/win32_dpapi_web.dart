// DPAPI on the 32-bit Windows edition (row 169, D-50): the CEF shell calls
// CryptProtectData/CryptUnprotectData (current user, CRYPTPROTECT_UI_FORBIDDEN) with the same
// entropy, so files written by either edition are the same format.
import 'dart:typed_data';

import 'package:payesh_core/web_host.dart';

import 'dpapi_secure_store.dart' show DpapiCipher;
import 'secure_store.dart';

/// DPAPI through the shell (`payeshHost.dpapi`).
final class Win32Dpapi implements DpapiCipher {
  Win32Dpapi({WebHost? host}) : _host = host ?? WebHost.instance;
  final WebHost _host;

  Uint8List _run(
    String name,
    Uint8List input,
    Uint8List entropy,
    bool protect,
  ) {
    try {
      return _host.dpapi(input, entropy, protect: protect);
    } on HostError catch (e) {
      throw SecureStoreException('$name failed: ${e.code}');
    }
  }

  @override
  Uint8List protect(Uint8List plain, Uint8List entropy) =>
      _run('CryptProtectData', plain, entropy, true);

  @override
  Uint8List unprotect(Uint8List sealed, Uint8List entropy) =>
      _run('CryptUnprotectData', sealed, entropy, false);
}
