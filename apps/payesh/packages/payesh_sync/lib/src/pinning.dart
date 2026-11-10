import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

/// The server's TLS public key is not one of the pinned keys (row 75). Raised before any
/// HTTP byte (and therefore before the bearer token) is written to the connection.
final class PinningException implements Exception {
  const PinningException(this.host, this.actual);
  final String host;
  final String actual;
  @override
  String toString() =>
      'PinningException: $host presented pin-sha256 "$actual" (not pinned)';
}

/// Invalid Gateway pinning configuration (fail closed at startup).
final class PinConfigException implements Exception {
  const PinConfigException(this.message);
  final String message;
  @override
  String toString() => 'PinConfigException: $message';
}

/// `pin-sha256` (RFC 7469): base64(SHA-256(DER SubjectPublicKeyInfo)) of [certDer].
String spkiPin(Uint8List certDer) =>
    base64.encode(sha256.convert(subjectPublicKeyInfo(certDer)).bytes);

/// Extracts the DER `SubjectPublicKeyInfo` from an X.509 certificate (minimal DER walk:
/// Certificate → tbsCertificate → [version] serial sigAlg issuer validity subject SPKI).
Uint8List subjectPublicKeyInfo(Uint8List der) {
  (int, int, int) tlv(int at) {
    if (at + 2 > der.length) throw const FormatException('truncated DER');
    final tag = der[at];
    var len = der[at + 1];
    var hdr = 2;
    if (len & 0x80 != 0) {
      final n = len & 0x7f;
      if (n == 0 || n > 4 || at + 2 + n > der.length) {
        throw const FormatException('bad DER length');
      }
      len = 0;
      for (var i = 0; i < n; i++) {
        len = (len << 8) | der[at + 2 + i];
      }
      hdr += n;
    }
    if (at + hdr + len > der.length) throw const FormatException('DER overrun');
    return (tag, hdr, len);
  }

  final (certTag, certHdr, _) = tlv(0);
  if (certTag != 0x30) throw const FormatException('not a certificate');
  final tbsAt = certHdr;
  final (tbsTag, tbsHdr, _) = tlv(tbsAt);
  if (tbsTag != 0x30) throw const FormatException('no tbsCertificate');
  var at = tbsAt + tbsHdr;
  var (tag, hdr, len) = tlv(at);
  if (tag == 0xa0) {
    at += hdr + len; // explicit version
  }
  for (var skip = 0; skip < 5; skip++) {
    (tag, hdr, len) = tlv(at); // serial, signature, issuer, validity, subject
    at += hdr + len;
  }
  (tag, hdr, len) = tlv(at);
  if (tag != 0x30) throw const FormatException('no SubjectPublicKeyInfo');
  return Uint8List.sublistView(der, at, at + hdr + len);
}

/// Gateway endpoint + key pins. Owner decision (row 75): pinning is ENABLED and a BACKUP pin
/// is mandatory, so a key rotation never bricks installed apps. Only https is allowed.
final class GatewayConfig {
  GatewayConfig({required this.baseUri, required List<String> pins})
    : pins = List.unmodifiable(pins.map((p) => p.trim())) {
    if (baseUri.scheme != 'https' || baseUri.host.isEmpty) {
      throw const PinConfigException('gateway must be an https URL');
    }
    final valid = RegExp(r'^[A-Za-z0-9+/]{43}=$');
    for (final p in this.pins) {
      if (!valid.hasMatch(p)) {
        throw PinConfigException('not a base64 SHA-256 pin: "$p"');
      }
    }
    if (this.pins.toSet().length < 2) {
      throw const PinConfigException(
        'at least two distinct pins (primary + backup) are required',
      );
    }
  }

  /// From build-time defines: `--dart-define=PAYESH_GATEWAY_URL=https://…`
  /// `--dart-define=PAYESH_GATEWAY_PINS=<primary>,<backup>`. Null when not configured
  /// (the app then has no remote data path at all).
  static GatewayConfig? fromEnvironment({
    String url = const String.fromEnvironment('PAYESH_GATEWAY_URL'),
    String pins = const String.fromEnvironment('PAYESH_GATEWAY_PINS'),
  }) {
    if (url.isEmpty && pins.isEmpty) return null;
    return GatewayConfig(
      baseUri: Uri.parse(url),
      pins: pins.split(',').where((p) => p.trim().isNotEmpty).toList(),
    );
  }

  final Uri baseUri;
  final List<String> pins;

  bool accepts(String pin) => pins.contains(pin);
}

/// `HttpClient` that verifies the server's SPKI pin right after the TLS handshake and before
/// any HTTP data is written. Normal chain + hostname validation still apply ([context]).
HttpClient createPinnedHttpClient(
  GatewayConfig config, {
  SecurityContext? context,
}) {
  final client = HttpClient(context: context);
  client.connectionFactory = (uri, proxyHost, proxyPort) async {
    if (uri.scheme != 'https') {
      throw PinningException(uri.host, 'plaintext-http-refused');
    }
    if (proxyHost != null) {
      throw PinningException(uri.host, 'proxy-refused');
    }
    final task = await SecureSocket.startConnect(
      uri.host,
      uri.port,
      context: context,
    );
    final verified = task.socket.then((s) {
      final cert = s.peerCertificate;
      final pin = cert == null ? 'no-certificate' : spkiPin(cert.der);
      if (!config.accepts(pin)) {
        s.destroy();
        throw PinningException(uri.host, pin);
      }
      return s as Socket;
    });
    return ConnectionTask.fromSocket(verified, task.cancel);
  };
  return client;
}
