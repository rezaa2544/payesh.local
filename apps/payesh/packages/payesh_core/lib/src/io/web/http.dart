// dart:io's HttpClient for the 32-bit Windows edition (row 169, D-50): requests go through
// Chromium's `fetch` (the shell disables CORS for the app's own origin only and verifies TLS
// with Chromium's root store + certificates the app trusts). Same API as dart:io, so
// transports, S3 and update downloads run unchanged.
import 'dart:async';
import 'dart:convert';
import 'dart:io' as io;
import 'dart:js_interop';
import 'dart:js_interop_unsafe';
import 'dart:typed_data';

import 'host.dart' show WebHost;
import 'net.dart' show SecurityContext;

@JS('fetch')
external JSPromise<_Response> _fetch(JSString url, JSObject init);

@JS('AbortController')
extension type _AbortController._(JSObject _) implements JSObject {
  external factory _AbortController();
  external JSObject get signal;
  external void abort();
}

extension type _Response._(JSObject _) implements JSObject {
  external int get status;
  external String get statusText;
  external String get type;
  external String get url;
  external bool get redirected;
  external JSObject get headers;
  external _Body? get body;
}

extension type _Body._(JSObject _) implements JSObject {
  external _Reader getReader();
}

extension type _Reader._(JSObject _) implements JSObject {
  external JSPromise<_Chunk> read();
  external JSPromise<JSAny?> cancel();
}

extension type _Chunk._(JSObject _) implements JSObject {
  external bool get done;
  external JSUint8Array? get value;
}

/// Same surface as dart:io's `HttpClient` (created through `fetch`).
abstract interface class HttpClient implements io.HttpClient {
  factory HttpClient({SecurityContext? context}) => FetchHttpClient(context);

  static const int defaultHttpPort = 80;
  static const int defaultHttpsPort = 443;
  static set enableTimelineLogging(bool value) {}
  static bool get enableTimelineLogging => false;
  static String findProxyFromEnvironment(
    Uri url, {
    Map<String, String>? environment,
  }) => 'DIRECT';
}

/// Same surface as dart:io's `SecureSocket` statics. Raw sockets do not exist in a browser:
/// code that builds its own TLS connection (`connectionFactory`) is skipped by
/// [FetchHttpClient], so these are never reached in practice.
abstract final class SecureSocket {
  static Future<io.ConnectionTask<io.SecureSocket>> startConnect(
    Object host,
    int port, {
    SecurityContext? context,
    bool Function(io.X509Certificate certificate)? onBadCertificate,
    void Function(String line)? keyLog,
    List<String>? supportedProtocols,
  }) async =>
      throw io.SocketException('raw TLS sockets are not available on web32');

  static Future<io.SecureSocket> connect(
    Object host,
    int port, {
    SecurityContext? context,
    bool Function(io.X509Certificate certificate)? onBadCertificate,
    void Function(String line)? keyLog,
    List<String>? supportedProtocols,
    Duration? timeout,
  }) async =>
      throw io.SocketException('raw TLS sockets are not available on web32');

  static Future<io.SecureSocket> secure(
    io.Socket socket, {
    Object? host,
    SecurityContext? context,
    bool Function(io.X509Certificate certificate)? onBadCertificate,
    void Function(String line)? keyLog,
    List<String>? supportedProtocols,
  }) async =>
      throw io.SocketException('raw TLS sockets are not available on web32');
}

/// dart:io-shaped headers (lower-cased names, multi-value).
final class WebHttpHeaders implements io.HttpHeaders {
  final Map<String, List<String>> _h = {};
  final Map<String, String> _original = {};

  @override
  bool chunkedTransferEncoding = false;
  @override
  int contentLength = -1;
  @override
  bool persistentConnection = true;
  @override
  String? host;
  @override
  int? port;
  @override
  DateTime? date;
  @override
  DateTime? expires;
  @override
  DateTime? ifModifiedSince;

  @override
  io.ContentType? get contentType {
    final v = value(io.HttpHeaders.contentTypeHeader);
    return v == null ? null : io.ContentType.parse(v);
  }

  @override
  set contentType(io.ContentType? t) {
    if (t == null) {
      removeAll(io.HttpHeaders.contentTypeHeader);
    } else {
      set(io.HttpHeaders.contentTypeHeader, t.toString());
    }
  }

  void _put(String name, Object value, {required bool replace}) {
    final k = name.toLowerCase();
    if (k == io.HttpHeaders.contentLengthHeader) {
      contentLength = int.tryParse('$value') ?? -1;
      return;
    }
    _original[k] = name;
    final list = replace ? (_h[k] = <String>[]) : _h.putIfAbsent(k, () => []);
    if (value is Iterable) {
      list.addAll(value.map((e) => '$e'));
    } else if (value is DateTime) {
      list.add(io.HttpDate.format(value));
    } else {
      list.add('$value');
    }
  }

  @override
  void add(String name, Object value, {bool preserveHeaderCase = false}) =>
      _put(name, value, replace: false);

  @override
  void set(String name, Object value, {bool preserveHeaderCase = false}) =>
      _put(name, value, replace: true);

  @override
  List<String>? operator [](String name) => _h[name.toLowerCase()];

  @override
  String? value(String name) {
    final k = name.toLowerCase();
    if (k == io.HttpHeaders.contentLengthHeader) {
      return contentLength < 0 ? null : '$contentLength';
    }
    final v = _h[k];
    if (v == null || v.isEmpty) return null;
    if (v.length > 1) throw io.HttpException('More than one value for $name');
    return v.first;
  }

  @override
  void remove(String name, Object value) =>
      _h[name.toLowerCase()]?.remove('$value');

  @override
  void removeAll(String name) => _h.remove(name.toLowerCase());

  @override
  void forEach(void Function(String name, List<String> values) action) {
    _h.forEach(action);
    if (contentLength >= 0) {
      action(io.HttpHeaders.contentLengthHeader, ['$contentLength']);
    }
  }

  @override
  void noFolding(String name) {}

  @override
  void clear() {
    _h.clear();
    contentLength = -1;
  }

  @override
  String toString() {
    final sb = StringBuffer();
    forEach((k, v) => sb.writeln('$k: ${v.join(', ')}'));
    return sb.toString();
  }
}

/// fetch-backed [io.HttpClient].
final class FetchHttpClient implements HttpClient {
  FetchHttpClient(this.context);

  final SecurityContext? context;
  final Set<_AbortController> _live = {};
  bool _closed = false;

  @override
  Duration idleTimeout = const Duration(seconds: 15);
  @override
  Duration? connectionTimeout;
  @override
  int? maxConnectionsPerHost;
  @override
  bool autoUncompress = true;
  @override
  String? userAgent = 'Payesh web32';

  // Stored for API compatibility; Chromium owns sockets, proxies and certificate checks.
  @override
  set badCertificateCallback(
    bool Function(io.X509Certificate cert, String host, int port)? callback,
  ) {}
  @override
  set findProxy(String Function(Uri url)? f) {}
  @override
  set connectionFactory(
    Future<io.ConnectionTask<io.Socket>> Function(
      Uri url,
      String? proxyHost,
      int? proxyPort,
    )?
    f,
  ) {}
  @override
  set keyLog(dynamic Function(String line)? callback) {}
  @override
  set authenticate(
    Future<bool> Function(Uri url, String scheme, String? realm)? f,
  ) {}
  @override
  set authenticateProxy(
    Future<bool> Function(String host, int port, String scheme, String? realm)?
    f,
  ) {}

  @override
  void addCredentials(
    Uri url,
    String realm,
    io.HttpClientCredentials credentials,
  ) {}

  @override
  void addProxyCredentials(
    String host,
    int port,
    String realm,
    io.HttpClientCredentials credentials,
  ) {}

  @override
  Future<io.HttpClientRequest> openUrl(String method, Uri url) async {
    if (_closed) throw StateError('Client is closed');
    if (url.scheme != 'http' && url.scheme != 'https') {
      throw ArgumentError('Unsupported scheme ${url.scheme}');
    }
    return _FetchRequest(this, method.toUpperCase(), url);
  }

  @override
  Future<io.HttpClientRequest> open(
    String method,
    String host,
    int port,
    String path,
  ) => openUrl(method, Uri(scheme: 'http', host: host, port: port, path: path));

  @override
  Future<io.HttpClientRequest> getUrl(Uri url) => openUrl('GET', url);
  @override
  Future<io.HttpClientRequest> postUrl(Uri url) => openUrl('POST', url);
  @override
  Future<io.HttpClientRequest> putUrl(Uri url) => openUrl('PUT', url);
  @override
  Future<io.HttpClientRequest> deleteUrl(Uri url) => openUrl('DELETE', url);
  @override
  Future<io.HttpClientRequest> headUrl(Uri url) => openUrl('HEAD', url);
  @override
  Future<io.HttpClientRequest> patchUrl(Uri url) => openUrl('PATCH', url);
  @override
  Future<io.HttpClientRequest> get(String host, int port, String path) =>
      open('GET', host, port, path);
  @override
  Future<io.HttpClientRequest> post(String host, int port, String path) =>
      open('POST', host, port, path);
  @override
  Future<io.HttpClientRequest> put(String host, int port, String path) =>
      open('PUT', host, port, path);
  @override
  Future<io.HttpClientRequest> delete(String host, int port, String path) =>
      open('DELETE', host, port, path);
  @override
  Future<io.HttpClientRequest> head(String host, int port, String path) =>
      open('HEAD', host, port, path);
  @override
  Future<io.HttpClientRequest> patch(String host, int port, String path) =>
      open('PATCH', host, port, path);

  @override
  void close({bool force = false}) {
    _closed = true;
    if (force) {
      for (final c in _live.toList()) {
        c.abort();
      }
      _live.clear();
    }
  }
}

/// True when the page itself was served over https (row 199, app.payeshschool.ir).
bool _pageIsHttps() {
  final loc = globalContext.getProperty<JSAny?>('location'.toJS);
  if (loc == null || !loc.isA<JSObject>()) return false;
  final p = (loc as JSObject).getProperty<JSAny?>('protocol'.toJS);
  return p != null && p.isA<JSString>() && (p as JSString).toDart == 'https:';
}

/// Identity headers only the installed apps send (row 199).
const Set<String> _nativeOnly = {
  'x-payesh-client',
  'x-payesh-api',
  'x-device-id',
};

const Set<String> _forbidden = {
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'accept-encoding',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'user-agent',
  'cookie',
  'date',
  'expect',
  'origin',
  'referer',
  'via',
};

final class _FetchRequest implements io.HttpClientRequest {
  _FetchRequest(this._client, this.method, this.uri) {
    headers.host = uri.host;
    headers.port = uri.port;
  }

  final FetchHttpClient _client;
  @override
  final String method;
  @override
  final Uri uri;
  @override
  final WebHttpHeaders headers = WebHttpHeaders();
  final BytesBuilder _body = BytesBuilder(copy: false);
  final Completer<io.HttpClientResponse> _done = Completer();
  bool _sent = false;
  _AbortController? _abort;

  @override
  bool followRedirects = true;
  @override
  int maxRedirects = 5;
  @override
  bool persistentConnection = true;
  @override
  bool bufferOutput = true;
  Encoding? _encoding;

  @override
  Encoding get encoding {
    if (_encoding != null) return _encoding!;
    final cs = headers.contentType?.charset;
    return (cs == null ? null : Encoding.getByName(cs)) ?? latin1;
  }

  @override
  set encoding(Encoding e) => _encoding = e;

  @override
  int get contentLength => headers.contentLength;
  @override
  set contentLength(int v) => headers.contentLength = v;

  @override
  List<io.Cookie> get cookies => <io.Cookie>[];

  @override
  io.HttpConnectionInfo? get connectionInfo => null;

  @override
  Future<io.HttpClientResponse> get done => _done.future;

  @override
  void add(List<int> data) => _body.add(data);

  @override
  void addError(Object error, [StackTrace? stackTrace]) {
    if (!_done.isCompleted) _done.completeError(error, stackTrace);
  }

  @override
  Future<void> addStream(Stream<List<int>> stream) => stream.forEach(add);

  @override
  void write(Object? object) => add(encoding.encode('$object'));

  @override
  void writeAll(Iterable<Object?> objects, [String separator = '']) =>
      write(objects.join(separator));

  @override
  void writeCharCode(int charCode) => write(String.fromCharCode(charCode));

  @override
  void writeln([Object? object = '']) => write('$object\n');

  @override
  Future<void> flush() async {}

  @override
  void abort([Object? exception, StackTrace? stackTrace]) {
    _abort?.abort();
    addError(exception ?? const io.HttpException('Request has been aborted'));
  }

  @override
  Future<io.HttpClientResponse> close() {
    if (!_sent) {
      _sent = true;
      unawaited(_send());
    }
    return _done.future;
  }

  Future<void> _send() async {
    final init = JSObject();
    init.setProperty('method'.toJS, method.toJS);
    final h = JSObject();
    // Row 199: in a plain browser a cross-origin GET with `cache-control`/`pragma` needs a CORS
    // preflight that a static file host (the domain's list) does not answer. `cache: no-store`
    // below already bypasses every cache, so these are dropped from unsigned requests.
    // Only an S3 SigV4 signature (it always carries x-amz-date) may have signed these headers;
    // a Bearer token to a school server has not, and keeping them there fails the preflight.
    var signed = false;
    headers.forEach((k, v) {
      if (k.startsWith('x-amz-')) signed = true;
    });
    // Row 199: school servers released before 0.9.67 do not list the native identity headers in
    // their CORS allow-list, so a plain browser drops the whole request. Without them the server
    // treats the browser edition like the web client (no native version gate) — which it is.
    final browser = !WebHost.instance.isShell;
    headers.forEach((k, v) {
      if (!signed && (k == 'cache-control' || k == 'pragma')) return;
      if (browser && _nativeOnly.contains(k)) return;
      if (!_forbidden.contains(k) &&
          !k.startsWith('sec-') &&
          !k.startsWith('proxy-')) {
        h.setProperty(k.toJS, v.join(', ').toJS);
      }
    });
    init.setProperty('headers'.toJS, h);
    // Row 199: from an https page a plain-http address can only fail — mixed content, and for
    // loopback/LAN addresses the browser would first ask the user for «local network» access.
    // Fail at once, like an unreachable host, without the prompt.
    if (browser && uri.scheme == 'http' && _pageIsHttps()) {
      if (!_done.isCompleted) {
        _done.completeError(
          io.SocketException(
            'Connection failed (http from an https page), host: ${uri.host}, port: ${uri.port}',
          ),
        );
      }
      return;
    }
    final body = _body.takeBytes();
    if (body.isNotEmpty && method != 'GET' && method != 'HEAD') {
      init.setProperty('body'.toJS, body.toJS);
    }
    init.setProperty(
      'redirect'.toJS,
      (followRedirects ? 'follow' : 'manual').toJS,
    );
    init.setProperty('cache'.toJS, 'no-store'.toJS);
    init.setProperty('credentials'.toJS, 'omit'.toJS);
    final abort = _abort = _AbortController();
    _client._live.add(abort);
    init.setProperty('signal'.toJS, abort.signal);
    Timer? timer;
    var timedOut = false;
    final limit = _client.connectionTimeout;
    if (limit != null) {
      timer = Timer(limit, () {
        timedOut = true;
        abort.abort();
      });
    }
    try {
      final resp = await _fetch(uri.toString().toJS, init).toDart;
      timer?.cancel();
      if (!_done.isCompleted) {
        _done.complete(_FetchResponse(this, resp, abort));
      }
    } catch (e) {
      timer?.cancel();
      _client._live.remove(abort);
      if (_done.isCompleted) return;
      if (timedOut) {
        _done.completeError(
          io.SocketException(
            'HTTP connection timed out after $limit, host: ${uri.host}, port: ${uri.port}',
          ),
        );
      } else {
        _done.completeError(
          io.SocketException(
            'Connection failed ($e), host: ${uri.host}, port: ${uri.port}',
          ),
        );
      }
    }
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

final class _FetchResponse extends Stream<List<int>>
    implements io.HttpClientResponse {
  _FetchResponse(this._req, this._resp, this._abort) {
    final opaque = _resp.type == 'opaqueredirect';
    statusCode = opaque ? 302 : _resp.status;
    reasonPhrase = opaque ? 'Found' : _resp.statusText;
    void each(JSString value, JSString key) =>
        headers.add(key.toDart, value.toDart);
    _resp.headers.callMethod<JSAny?>('forEach'.toJS, each.toJS);
    final enc = headers.value(io.HttpHeaders.contentEncodingHeader);
    final len = int.tryParse(
      _resp.headers
              .callMethod<JSString?>(
                'get'.toJS,
                io.HttpHeaders.contentLengthHeader.toJS,
              )
              ?.toDart ??
          '',
    );
    // Like dart:io with autoUncompress: a compressed body has no usable length.
    contentLength = (enc != null && enc != 'identity') ? -1 : (len ?? -1);
    headers.contentLength = contentLength;
    if (_resp.redirected) {
      redirects.add(_Redirect(Uri.parse(_resp.url)));
    }
  }

  final _FetchRequest _req;
  final _Response _resp;
  final _AbortController _abort;
  @override
  late final int statusCode;
  @override
  late final String reasonPhrase;
  @override
  late final int contentLength;
  @override
  final WebHttpHeaders headers = WebHttpHeaders();
  @override
  final List<io.RedirectInfo> redirects = [];
  bool _listened = false;

  @override
  bool get isRedirect =>
      const {301, 302, 303, 307, 308}.contains(statusCode) &&
      !_req.followRedirects;

  @override
  bool get persistentConnection => true;

  @override
  io.HttpClientResponseCompressionState get compressionState =>
      contentLength < 0 && headers.value('content-encoding') != null
      ? io.HttpClientResponseCompressionState.decompressed
      : io.HttpClientResponseCompressionState.notCompressed;

  @override
  List<io.Cookie> get cookies => <io.Cookie>[];

  @override
  io.X509Certificate? get certificate => null;

  @override
  io.HttpConnectionInfo? get connectionInfo => null;

  @override
  Future<io.HttpClientResponse> redirect([
    String? method,
    Uri? url,
    bool? followLoops,
  ]) async {
    final next = await _req._client.openUrl(
      method ?? _req.method,
      url ?? _req.uri.resolve(headers.value('location') ?? ''),
    );
    _req.headers.forEach((k, v) {
      for (final x in v) {
        next.headers.add(k, x);
      }
    });
    return next.close();
  }

  @override
  Future<io.Socket> detachSocket() =>
      throw UnsupportedError('detachSocket on web32');

  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int> event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) {
    if (_listened) throw StateError('Stream has already been listened to.');
    _listened = true;
    late final StreamController<List<int>> c;
    _Reader? reader;
    var cancelled = false;
    var paused = false;
    Completer<void>? resume;
    Future<void> pump() async {
      final body = _resp.body;
      if (body == null || _req.method == 'HEAD') {
        _req._client._live.remove(_abort);
        await c.close();
        return;
      }
      final r = reader = body.getReader();
      try {
        for (;;) {
          if (paused) await (resume = Completer<void>()).future;
          if (cancelled) return;
          final chunk = await r.read().toDart;
          if (chunk.done) break;
          final v = chunk.value;
          if (v != null) c.add(v.toDart);
        }
      } catch (e, st) {
        if (!cancelled) {
          c.addError(
            io.HttpException('Connection closed while receiving data: $e'),
            st,
          );
        }
      } finally {
        _req._client._live.remove(_abort);
      }
      if (!cancelled) await c.close();
    }

    c = StreamController<List<int>>(
      onListen: () => unawaited(pump()),
      onPause: () => paused = true,
      onResume: () {
        paused = false;
        resume?.complete();
        resume = null;
      },
      onCancel: () async {
        cancelled = true;
        resume?.complete();
        try {
          await reader?.cancel().toDart;
        } catch (_) {
          // already finished
        }
        _abort.abort();
      },
    );
    return c.stream.listen(
      onData,
      onError: onError,
      onDone: onDone,
      cancelOnError: cancelOnError,
    );
  }
}

final class _Redirect implements io.RedirectInfo {
  _Redirect(this.location);
  @override
  final Uri location;
  @override
  int get statusCode => 302;
  @override
  String get method => 'GET';
}

/// Every `HttpClient()` created through dart:io itself (libraries that import dart:io
/// directly) also goes through fetch.
final class WebHttpOverrides extends io.HttpOverrides {
  @override
  io.HttpClient createHttpClient(io.SecurityContext? context) =>
      FetchHttpClient(null);
}
