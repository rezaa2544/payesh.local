// 32-bit Windows edition: dart:io surface answered by the CEF shell (row 169, D-50).
import 'dart:async';
import 'dart:io' as io;
import 'dart:typed_data';

import 'web/files.dart';
import 'web/host.dart' show WebHost, browserPickFile;
import 'web/http.dart';

export 'web/host.dart' show WebHost, HostError;
export 'web/http.dart' show HttpClient, SecureSocket;
export 'web/net.dart'
    show
        SecurityContext,
        InternetAddress,
        ZLibCodec,
        ZLibEncoder,
        ZLibDecoder,
        GZipCodec,
        zlib,
        gzip;
export 'web/platform.dart' show Platform, Process, exit, pid;

/// True in the 32-bit Windows edition.
const bool isWeb32 = true;

/// Row 199: true in an ordinary browser (app.payeshschool.ir) — the same JavaScript build
/// without the 32-bit shell: no processes, no installed server, no self-update (a reload is
/// the update).
bool get isBrowser => !WebHost.instance.isShell;

/// Row 199: the browser's own file dialog (only when [isBrowser]) — (name, bytes) or null.
/// [accept] is an HTML accept list, e.g. `.xlsx,.csv`.
Future<(String, Uint8List)?> pickBrowserFile({String accept = ''}) =>
    browserPickFile(accept);

/// Routes dart:io files/stdout/sockets and `HttpClient()` through the shell. Call once at
/// start-up before any file access.
Future<void> prepareWebHost() async {
  // row 199: the shell's host, or (a plain browser) the IndexedDB-backed browser host
  await WebHost.prepare();
  io.IOOverrides.global = WebIOOverrides();
  io.HttpOverrides.global = WebHttpOverrides();
}

/// Row 170: dart2js has no isolates (`Isolate.run` throws) — heavy work runs inline here.
Future<T> runOffThread<T>(FutureOr<T> Function() work) async => work();
