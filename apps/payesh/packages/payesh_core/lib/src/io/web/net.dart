// dart:io's SecurityContext / InternetAddress / zlib codecs for the 32-bit Windows edition
// (row 169, D-50). On that edition Chromium (CEF 109, its own Chrome Root Store) does TLS;
// certificates the app adds to a SecurityContext are handed to the shell, which accepts a
// server chain that contains one of them (OnCertificateError).
import 'dart:convert';
import 'dart:io' as io;
import 'dart:typed_data';

import '../zlib_dart.dart';
import 'host.dart';

/// Same surface as dart:io's `SecurityContext`.
/// (dart:io's class is `final`, so this is a separate type with the same members; on this
/// edition `HttpClient`/`SecureSocket` take this type.)
final class SecurityContext {
  SecurityContext({this.withTrustedRoots = false});

  final bool withTrustedRoots;

  /// PEM blocks added with [setTrustedCertificatesBytes].
  final List<String> trusted = [];

  static final SecurityContext defaultContext = SecurityContext(
    withTrustedRoots: true,
  );

  static bool get alpnSupported => true;

  bool allowLegacyUnsafeRenegotiation = false;

  io.TlsProtocolVersion minimumTlsProtocolVersion =
      io.TlsProtocolVersion.tls1_2;

  void setTrustedCertificatesBytes(List<int> certBytes, {String? password}) {
    final text = latin1.decode(certBytes, allowInvalid: true);
    final blocks = RegExp(
      r'-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----',
    ).allMatches(text).map((m) => m[0]!).toList();
    if (blocks.isEmpty && certBytes.isNotEmpty) {
      blocks.add(
        '-----BEGIN CERTIFICATE-----\n${base64.encode(certBytes)}\n'
        '-----END CERTIFICATE-----',
      );
    }
    for (final b in blocks) {
      trusted.add(b);
      WebHost.instance.trustPem(b);
    }
  }

  void setTrustedCertificates(String file, {String? password}) =>
      setTrustedCertificatesBytes(io.File(file).readAsBytesSync());

  void setAlpnProtocols(List<String> protocols, bool isServer) {}

  void setClientAuthorities(String file, {String? password}) {}

  void setClientAuthoritiesBytes(List<int> authCertBytes, {String? password}) {}

  void useCertificateChain(String file, {String? password}) {}

  void useCertificateChainBytes(List<int> chainBytes, {String? password}) {}

  void usePrivateKey(String file, {String? password}) {}

  void usePrivateKeyBytes(List<int> keyBytes, {String? password}) {}
}

/// Same surface as dart:io's `InternetAddress` (parsing only — no DNS on this edition).
final class InternetAddress implements io.InternetAddress {
  InternetAddress._(this.address, this.rawAddress, this.type, [String? host])
    : _host = host;

  factory InternetAddress(String address, {io.InternetAddressType? type}) {
    final a = tryParse(address);
    if (a == null) {
      throw ArgumentError.value(address, 'address', 'not an IP address');
    }
    return a;
  }

  factory InternetAddress.fromRawAddress(
    Uint8List rawAddress, {
    io.InternetAddressType? type,
  }) {
    if (rawAddress.length == 4) {
      return InternetAddress._(
        rawAddress.join('.'),
        Uint8List.fromList(rawAddress),
        io.InternetAddressType.IPv4,
      );
    }
    if (rawAddress.length == 16) {
      final parts = [
        for (var i = 0; i < 16; i += 2)
          ((rawAddress[i] << 8) | rawAddress[i + 1]).toRadixString(16),
      ];
      return InternetAddress._(
        parts.join(':'),
        Uint8List.fromList(rawAddress),
        io.InternetAddressType.IPv6,
      );
    }
    throw ArgumentError('raw address must be 4 or 16 bytes');
  }

  static InternetAddress? tryParse(String address) {
    final v4 = RegExp(r'^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$');
    final m = v4.firstMatch(address);
    if (m != null) {
      final b = [for (var i = 1; i <= 4; i++) int.parse(m[i]!)];
      if (b.any((x) => x > 255)) return null;
      if ([for (var i = 1; i <= 4; i++) m[i]!]
          .any((s) => s.length > 1 && s.startsWith('0'))) {
        return null;
      }
      return InternetAddress._(
        address,
        Uint8List.fromList(b),
        io.InternetAddressType.IPv4,
      );
    }
    if (!address.contains(':')) return null;
    try {
      final raw = Uint8List.fromList(Uri.parseIPv6Address(address));
      return InternetAddress._(address, raw, io.InternetAddressType.IPv6);
    } on FormatException {
      return null;
    }
  }

  static Future<List<InternetAddress>> lookup(
    String host, {
    io.InternetAddressType type = io.InternetAddressType.any,
  }) async {
    final a = tryParse(host);
    if (a != null) return [a];
    throw io.SocketException('DNS lookup is not available on web32: $host');
  }

  static final InternetAddress loopbackIPv4 = InternetAddress('127.0.0.1');
  static final InternetAddress loopbackIPv6 = InternetAddress('::1');
  static final InternetAddress anyIPv4 = InternetAddress('0.0.0.0');
  static final InternetAddress anyIPv6 = InternetAddress('::');

  @override
  final String address;
  @override
  final Uint8List rawAddress;
  @override
  final io.InternetAddressType type;
  final String? _host;

  @override
  String get host => _host ?? address;

  @override
  bool get isLoopback => type == io.InternetAddressType.IPv4
      ? rawAddress[0] == 127
      : rawAddress.sublist(0, 15).every((b) => b == 0) && rawAddress[15] == 1;

  @override
  bool get isLinkLocal => type == io.InternetAddressType.IPv4
      ? rawAddress[0] == 169 && rawAddress[1] == 254
      : rawAddress[0] == 0xfe && (rawAddress[1] & 0xc0) == 0x80;

  @override
  bool get isMulticast => type == io.InternetAddressType.IPv4
      ? rawAddress[0] >= 224 && rawAddress[0] < 240
      : rawAddress[0] == 0xff;

  @override
  Future<InternetAddress> reverse() async => this;

  @override
  bool operator ==(Object other) =>
      other is io.InternetAddress && other.address == address;

  @override
  int get hashCode => address.hashCode;

  @override
  String toString() => "InternetAddress('$address', ${type.name})";
}

/// Same surface as dart:io's `ZLibEncoder` (pure Dart).
final class ZLibEncoder extends Converter<List<int>, List<int>> {
  ZLibEncoder({
    this.gzip = false,
    this.level = 6,
    this.windowBits = 15,
    this.memLevel = 8,
    this.strategy = 0,
    this.dictionary,
    this.raw = false,
  });
  final bool gzip;
  final int level;
  final int windowBits;
  final int memLevel;
  final int strategy;
  final List<int>? dictionary;
  final bool raw;
  @override
  List<int> convert(List<int> input) =>
      DartZLibEncoder(gzip: gzip, level: level, raw: raw).convert(input);
}

/// Same surface as dart:io's `ZLibDecoder` (pure Dart).
final class ZLibDecoder extends Converter<List<int>, List<int>> {
  ZLibDecoder({
    this.gzip = false,
    this.windowBits = 15,
    this.dictionary,
    this.raw = false,
  });
  final bool gzip;
  final int windowBits;
  final List<int>? dictionary;
  final bool raw;
  @override
  List<int> convert(List<int> input) {
    // dart:io's decoder auto-detects gzip vs zlib headers when not raw.
    if (!raw && input.length > 2 && input[0] == 0x1f && input[1] == 0x8b) {
      return gzipDecode(input);
    }
    return DartZLibDecoder(raw: raw).convert(input);
  }
}

/// Same surface as dart:io's `ZLibCodec` / `GZipCodec`.
final class ZLibCodec extends Codec<List<int>, List<int>> {
  const ZLibCodec({this.level = 6, this.raw = false, this.gzip = false});
  final int level;
  final bool raw;
  final bool gzip;
  @override
  ZLibEncoder get encoder => ZLibEncoder(gzip: gzip, level: level, raw: raw);
  @override
  ZLibDecoder get decoder => ZLibDecoder(gzip: gzip, raw: raw);
}

/// Same as dart:io's `GZipCodec`.
final class GZipCodec extends ZLibCodec {
  const GZipCodec({super.level}) : super(gzip: true);
}

const ZLibCodec zlib = ZLibCodec();
const GZipCodec gzip = GZipCodec();
