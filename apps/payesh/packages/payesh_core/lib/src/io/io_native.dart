// Native builds: dart:io itself (row 169 — see package:payesh_core/io.dart).
export 'dart:io'
    show
        Platform,
        Process,
        exit,
        pid,
        HttpClient,
        SecureSocket,
        SecurityContext,
        InternetAddress,
        ZLibCodec,
        ZLibEncoder,
        ZLibDecoder,
        GZipCodec,
        zlib,
        gzip;

/// False in native builds; true in the 32-bit Windows edition (Flutter web in CEF x86).
const bool isWeb32 = false;

/// Native builds need no preparation.
Future<void> prepareWebHost() async {}
