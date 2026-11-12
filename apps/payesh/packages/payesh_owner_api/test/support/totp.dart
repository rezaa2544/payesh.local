import 'dart:typed_data';

import 'package:crypto/crypto.dart';

/// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — test helper only; the app never holds a TOTP
/// secret (the operator types the code from an authenticator app).
String totpAt(String base32Secret, DateTime t) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  var bits = 0, value = 0;
  final key = <int>[];
  for (final ch in base32Secret.toUpperCase().replaceAll('=', '').split('')) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      key.add((value >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  final counter = t.millisecondsSinceEpoch ~/ 1000 ~/ 30;
  final msg = ByteData(8)..setUint64(0, counter);
  final mac = Hmac(sha1, key).convert(msg.buffer.asUint8List()).bytes;
  final o = mac[mac.length - 1] & 0x0f;
  final bin =
      ((mac[o] & 0x7f) << 24) |
      (mac[o + 1] << 16) |
      (mac[o + 2] << 8) |
      mac[o + 3];
  return (bin % 1000000).toString().padLeft(6, '0');
}
