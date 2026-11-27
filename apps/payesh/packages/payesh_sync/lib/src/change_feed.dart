import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:payesh_core/io.dart';
import 'package:payesh_core/payesh_core.dart';

import 'le_trust.dart';

/// One notification from the school server's change feed (row 177).
///
/// It names *which* collections changed — never the data itself. The app then pulls just the
/// delta (`/api/v1/pull` with its cursor and ETag).
final class ChangeEvent {
  const ChangeEvent({
    required this.kind,
    required this.seq,
    this.topics = const [],
    this.missed = false,
  });

  /// `hello` (connected) or `change`.
  final String kind;
  final int seq;
  final List<String> topics;

  /// On `hello`: something changed since the `since` the client sent (or the server restarted).
  final bool missed;

  bool get isHello => kind == 'hello';

  /// Whether the app has to pull: every `change`, and a `hello` that reports missed changes.
  bool get needsPull => kind == 'change' || missed;

  @override
  String toString() =>
      'ChangeEvent($kind seq=$seq topics=$topics missed=$missed)';
}

/// Incremental Server-Sent-Events parser: feed it text chunks, get complete events.
final class SseParser {
  String _buf = '';

  /// Returns the events completed by [chunk]. Comment lines (`:` keep-alives) are ignored.
  List<ChangeEvent> add(String chunk) {
    _buf += chunk.replaceAll('\r\n', '\n');
    final out = <ChangeEvent>[];
    var i = _buf.indexOf('\n\n');
    while (i >= 0) {
      final block = _buf.substring(0, i);
      _buf = _buf.substring(i + 2);
      final e = _parse(block);
      if (e != null) out.add(e);
      i = _buf.indexOf('\n\n');
    }
    return out;
  }

  static ChangeEvent? _parse(String block) {
    String? kind;
    final data = StringBuffer();
    for (final line in block.split('\n')) {
      if (line.startsWith('event:')) kind = line.substring(6).trim();
      if (line.startsWith('data:')) data.write(line.substring(5).trim());
    }
    if (kind == null || (kind != 'hello' && kind != 'change')) return null;
    Map<String, Object?> j = const {};
    try {
      final d = jsonDecode(data.toString());
      if (d is Map<String, Object?>) j = d;
    } on FormatException {
      j = const {};
    }
    final topics = j['topics'];
    return ChangeEvent(
      kind: kind,
      seq: (j['seq'] as num?)?.toInt() ?? 0,
      topics: topics is List ? topics.map((t) => '$t').toList() : const [],
      missed: j['missed'] == true,
    );
  }
}

/// Opens the raw byte stream of `GET /api/v1/events` (injectable for tests).
typedef FeedConnector = Future<Stream<List<int>>> Function(
  Uri uri,
  Map<String, String> headers,
);

/// The device side of the event-driven sync ("publish/subscribe" over SSE, row 177).
///
/// One long-lived request; the server writes only when something was written in its database.
/// While nothing changes not a byte moves (except a `:` keep-alive every 45 s). If the feed is
/// unavailable (old server, proxy, offline) [live] is false and the caller keeps its slow
/// polling; the feed retries with a growing delay (5 s, 10 s … 5 min). [pause] closes the
/// connection when the app goes to the background; [resume] reconnects and — through the
/// server's `missed` flag — catches up once.
final class ChangeFeed {
  ChangeFeed({
    required this.baseUri,
    required this.token,
    this.topics = const [],
    this.path = lanPath,
    this.deviceId,
    FeedConnector? connect,
    HttpClient? client,
    this.minRetry = const Duration(seconds: 5),
    this.maxRetry = const Duration(minutes: 5),
  }) : _connect = connect ?? _httpConnector(client ?? trustedHttpClient());

  /// School server on the LAN (row 177).
  static const lanPath = '/api/v1/events';

  /// Same contract through the Gateway, for devices syncing over the internet (row 178).
  static const gatewayPath = '/api/gw/v1/events';

  final Uri baseUri;
  final String Function() token;
  final List<String> topics;

  /// [lanPath] or [gatewayPath].
  final String path;

  /// Sent as `X-Device-Id` (the Gateway's per-device quota bucket).
  final String? deviceId;
  final Duration minRetry;
  final Duration maxRetry;
  final FeedConnector _connect;

  final _events = StreamController<ChangeEvent>.broadcast();
  final _liveCtrl = StreamController<bool>.broadcast();
  StreamSubscription<String>? _sub;
  Timer? _retry;
  bool _started = false;
  bool _paused = false;
  bool _live = false;
  int _seq = 0;
  int _fails = 0;
  int _connects = 0;

  /// Every `hello` / `change` notification.
  Stream<ChangeEvent> get events => _events.stream;

  /// Connected (a `hello` arrived) / disconnected.
  Stream<bool> get liveChanges => _liveCtrl.stream;
  bool get live => _live;
  bool get paused => _paused;
  int get seq => _seq;

  /// Connection attempts so far (tests use it to prove there is no reconnect storm).
  int get connects => _connects;

  void start() {
    if (_started) return;
    _started = true;
    unawaited(_open());
  }

  /// App went to the background: close the connection, no retries.
  void pause() {
    if (_paused) return;
    _paused = true;
    _close();
  }

  /// App is visible again: reconnect now (the server reports what was missed).
  void resume() {
    if (!_paused) return;
    _paused = false;
    _fails = 0;
    if (_started) unawaited(_open());
  }

  /// Row 197-Q03: access just opened (trial/subscription) — the feed was refused (402) and
  /// waits in its backoff; connect again now.
  void reconnectNow() {
    _fails = 0;
    if (!_started || _paused || _sub != null) return;
    unawaited(_open());
  }

  Future<void> stop() async {
    _started = false;
    _close();
    await _events.close();
    await _liveCtrl.close();
  }

  Uri get _uri => baseUri
      .resolve(path)
      .replace(
        queryParameters: {
          'since': '$_seq',
          if (topics.isNotEmpty) 'topics': topics.join(','),
        },
      );

  Future<void> _open() async {
    if (!_started || _paused || _sub != null) return;
    _retry?.cancel();
    _retry = null;
    _connects++;
    final parser = SseParser();
    try {
      final stream = await _connect(_uri, {
        HttpHeaders.authorizationHeader: 'Bearer ${token()}',
        HttpHeaders.acceptHeader: 'text/event-stream',
        if (deviceId case final id? when id.isNotEmpty)
          PayeshApi.deviceIdHeader: id,
      });
      if (!_started || _paused) return;
      _sub = stream
          .cast<List<int>>()
          .transform(utf8.decoder)
          .listen(
            (chunk) {
              for (final e in parser.add(chunk)) {
                _seq = e.seq;
                if (e.isHello) {
                  _fails = 0;
                  _setLive(true);
                }
                if (!_events.isClosed) _events.add(e);
              }
            },
            onError: (Object _) => _dropped(),
            onDone: _dropped,
            cancelOnError: true,
          );
    } on Object {
      _dropped();
    }
  }

  void _dropped() {
    _sub = null;
    _setLive(false);
    if (!_started || _paused) return;
    _fails = min(_fails + 1, 8);
    final ms = min(
      maxRetry.inMilliseconds,
      minRetry.inMilliseconds * pow(2, _fails - 1).toInt(),
    );
    _retry?.cancel();
    _retry = Timer(Duration(milliseconds: ms), () {
      _retry = null;
      unawaited(_open());
    });
  }

  void _close() {
    _retry?.cancel();
    _retry = null;
    unawaited(_sub?.cancel());
    _sub = null;
    _setLive(false);
  }

  void _setLive(bool v) {
    if (_live == v) return;
    _live = v;
    if (!_liveCtrl.isClosed) _liveCtrl.add(v);
  }

  static FeedConnector _httpConnector(HttpClient client) =>
      (uri, headers) async {
        final req = await client
            .openUrl('GET', uri)
            .timeout(const Duration(seconds: 20));
        headers.forEach(req.headers.set);
        req.headers.set(PayeshApi.versionHeader, 'payesh-native/0.1.0');
        final res = await req.close().timeout(const Duration(seconds: 20));
        if (res.statusCode != 200) {
          await res.drain<void>();
          throw HttpException('events ${res.statusCode}');
        }
        return res;
      };
}
