// 32-bit Windows edition: dart:io surface answered by the CEF shell (row 169, D-50).
import 'dart:async';
import 'dart:io' as io;

import 'web/files.dart';
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

/// Routes dart:io files/stdout/sockets and `HttpClient()` through the shell. Call once at
/// start-up before any file access.
Future<void> prepareWebHost() async {
  io.IOOverrides.global = WebIOOverrides();
  io.HttpOverrides.global = WebHttpOverrides();
}

/// Row 170: dart2js has no isolates (`Isolate.run` throws) — heavy work runs inline here.
Future<T> runOffThread<T>(FutureOr<T> Function() work) async => work();
