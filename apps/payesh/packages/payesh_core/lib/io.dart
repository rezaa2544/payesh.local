/// `dart:io` for every Payesh package — row 169 (D-50).
///
/// Native builds (Windows x64, Android) get dart:io itself, unchanged. The 32-bit Windows
/// edition is the same Flutter code compiled to JavaScript inside a 32-bit Chromium shell
/// (tools/web32/shell); there `Platform`, `Process`, `exit`, `pid`, `HttpClient`,
/// `SecurityContext`, `SecureSocket`, `InternetAddress` and the zlib codecs come from the
/// shell (src/io/web/), and [prepareWebHost] installs IOOverrides so `File`/`Directory` use
/// the shell's real files. Import this library instead of `dart:io` in app/package code.
library;

export 'dart:io'
    hide
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

export 'src/io/io_native.dart'
    if (dart.library.js_interop) 'src/io/io_web.dart';
