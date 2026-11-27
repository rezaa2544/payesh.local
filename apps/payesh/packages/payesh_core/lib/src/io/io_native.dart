// Native builds: dart:io itself (row 169 — see package:payesh_core/io.dart).
import 'dart:async';
import 'dart:isolate';
import 'dart:typed_data';

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

/// Row 199: true only in the browser edition (never in a native build).
const bool isBrowser = false;

/// Row 199: only the browser edition has a browser file dialog.
Future<(String, Uint8List)?> pickBrowserFile({String accept = ''}) =>
    throw UnsupportedError(
      'pickBrowserFile exists only in the browser edition',
    );

/// Native builds need no preparation.
Future<void> prepareWebHost() async {}

/// Row 170: CPU-heavy work (hashing, PBKDF2) off the UI thread. Native builds use a
/// short-lived isolate; the 32-bit edition (dart2js) has no isolates and runs it inline.
Future<T> runOffThread<T>(FutureOr<T> Function() work) => Isolate.run(work);
