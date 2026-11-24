// Row 177 — event-driven sync on the device: SSE parsing, the ChangeFeed connection and the
// AutoSync rules (no idle polling while the feed is live, pause in the background). A real
// local HTTP server stands in for the school server's `/api/v1/events`.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

Future<void> until(
  bool Function() f, {
  Duration max = const Duration(seconds: 5),
}) async {
  final end = DateTime.now().add(max);
  while (!f()) {
    if (DateTime.now().isAfter(end)) throw StateError('timeout');
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
}

/// Minimal `/api/v1/events`: hello on connect, then whatever the test pushes.
final class FakeEvents {
  late HttpServer server;
  final open = <HttpResponse>[];
  final requests = <Uri>[];
  final auth = <String?>[];
  int status = 200;
  int seq = 0;

  Uri get base => Uri.parse('http://127.0.0.1:${server.port}/');

  Future<void> start() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      requests.add(req.uri);
      auth.add(req.headers.value(HttpHeaders.authorizationHeader));
      final res = req.response;
      if (status != 200) {
        res.statusCode = status;
        await res.close();
        return;
      }
      res.headers.contentType = ContentType('text', 'event-stream');
      res.bufferOutput = false;
      final since = int.tryParse(req.uri.queryParameters['since'] ?? '');
      res.write(
        'retry: 10000\n\nevent: hello\ndata: ${jsonEncode({'seq': seq, 'missed': since != null && since != seq})}\n\n',
      );
      await res.flush();
      open.add(res);
    });
  }

  Future<void> change(List<String> topics) async {
    seq++;
    for (final r in List.of(open)) {
      r.write(
        'event: change\ndata: ${jsonEncode({'seq': seq, 'topics': topics})}\n\n',
      );
      await r.flush();
    }
  }

  Future<void> dropAll() async {
    for (final r in List.of(open)) {
      await r.close();
    }
    open.clear();
  }

  Future<void> close() async {
    await dropAll();
    await server.close(force: true);
  }
}

void main() {
  group('SseParser', () {
    test('split chunks, CRLF, keep-alive comments and unknown events', () {
      final p = SseParser();
      expect(p.add('retry: 10000\n\n: keep-alive\n\nevent: hel'), isEmpty);
      final a = p.add('lo\ndata: {"seq":3,"missed":true}\n\nevent: chan');
      expect(a, hasLength(1));
      expect(a.single.isHello, isTrue);
      expect(a.single.seq, 3);
      expect(a.single.needsPull, isTrue);
      final b = p.add(
        'ge\r\ndata: {"seq":4,"topics":["grades","users"]}\r\n\r\nevent: other\ndata: {}\n\n',
      );
      expect(b, hasLength(1));
      expect(b.single.kind, 'change');
      expect(b.single.topics, ['grades', 'users']);
      expect(b.single.needsPull, isTrue);
      expect(b.single.toString(), contains('grades'));
    });

    test('hello without missed needs no pull; bad JSON is tolerated', () {
      final p = SseParser();
      final e = p.add(
        'event: hello\ndata: {"seq":0,"missed":false}\n\nevent: change\ndata: nope\n\n',
      );
      expect(e[0].needsPull, isFalse);
      expect(e[1].seq, 0);
      expect(e[1].topics, isEmpty);
    });
  });

  group('ChangeFeed', () {
    late FakeEvents srv;
    setUp(() async {
      srv = FakeEvents();
      await srv.start();
    });
    tearDown(() => srv.close());

    test('connects with the token, reports live, delivers changes, resumes from seq', () async {
      final f = ChangeFeed(
        baseUri: srv.base,
        token: () => 'tok-177',
        topics: const ['grades'],
        client: HttpClient(),
        minRetry: const Duration(milliseconds: 30),
      );
      final got = <ChangeEvent>[];
      f.events.listen(got.add);
      f.start();
      f.start(); // idempotent
      await until(() => f.live);
      expect(srv.auth.single, 'Bearer tok-177');
      expect(srv.requests.single.path, '/api/v1/events');
      expect(srv.requests.single.queryParameters['topics'], 'grades');
      expect(srv.requests.single.queryParameters['since'], '0');
      await srv.change(['grades']);
      await until(() => got.any((e) => e.kind == 'change'));
      expect(f.seq, 1);

      // server drops the stream → not live → reconnect after minRetry with since=1
      await srv.dropAll();
      await until(() => !f.live);
      await until(() => f.live);
      expect(srv.requests.last.queryParameters['since'], '1');
      expect(f.connects, 2);
      await f.stop();
    });

    test(
      'pause closes the connection and never reconnects; resume reconnects',
      () async {
        final f = ChangeFeed(
          baseUri: srv.base,
          token: () => 't',
          client: HttpClient(),
          minRetry: const Duration(milliseconds: 20),
        )..start();
        await until(() => f.live);
        f.pause();
        f.pause();
        expect(f.paused, isTrue);
        expect(f.live, isFalse);
        await Future<void>.delayed(const Duration(milliseconds: 150));
        expect(f.connects, 1, reason: 'no reconnect while paused');
        await srv.change(['x']); // missed while paused
        f.resume();
        f.resume();
        await until(() => f.live);
        expect(f.connects, 2);
        await f.stop();
      },
    );

    test('unavailable feed (old server: 404) retries with a growing delay, no storm', () async {
      srv.status = 404;
      final f = ChangeFeed(
        baseUri: srv.base,
        token: () => 't',
        client: HttpClient(),
        minRetry: const Duration(milliseconds: 40),
        maxRetry: const Duration(milliseconds: 160),
      )..start();
      await Future<void>.delayed(const Duration(milliseconds: 500));
      // 0, 40, 120 (+80), 280 (+160), 440 (+160) ⇒ at most ~5 attempts in 500 ms
      expect(f.connects, inInclusiveRange(3, 6));
      expect(f.live, isFalse);
      srv.status = 200;
      await until(() => f.live);
      await f.stop();
    });

    test('a connector that throws is handled like a drop', () async {
      var n = 0;
      final f = ChangeFeed(
        baseUri: srv.base,
        token: () => 't',
        connect: (u, h) async {
          n++;
          throw const SocketException('refused');
        },
        minRetry: const Duration(milliseconds: 20),
      )..start();
      await until(() => n >= 2);
      expect(f.live, isFalse);
      await f.stop();
    });
  });

  group('AutoSync with the feed', () {
    AutoSync mk(SqliteOutbox ob, List<String> log) => AutoSync(
      outbox: ob,
      push: (ops) async => const PushVerdicts(applied: {}),
      pull: () async => log.add('pull'),
      minGap: const Duration(milliseconds: 20),
      idleInterval: const Duration(milliseconds: 120),
      liveIdleInterval: const Duration(seconds: 30),
      random: Random(1),
    );

    test('feed live ⇒ no idle polling; a change ⇒ one pull; feed lost ⇒ polling again', () async {
      final log = <String>[];
      final a = mk(SqliteOutbox.inMemory(), log)..start();
      await until(() => log.length == 1);
      a.feedLive = true;
      a.feedLive = true;
      expect(a.feedLive, isTrue);
      // let the already armed idle timer (≤120 ms) fire once; after that only the 30 s check
      await Future<void>.delayed(const Duration(milliseconds: 200));
      final settled = log.length;
      await Future<void>.delayed(const Duration(milliseconds: 400));
      expect(log.length, settled, reason: 'no polling while the feed is live');
      a.notifyRemoteChange();
      await until(() => log.length == settled + 1);
      a.feedLive = false;
      await until(
        () => log.length >= settled + 3,
        max: const Duration(seconds: 2),
      );
      await a.stop();
    });

    test(
      'pause ⇒ no cycle at all (not even on a change); resume ⇒ one catch-up',
      () async {
        final log = <String>[];
        final a = mk(SqliteOutbox.inMemory(), log)..start();
        await until(() => log.length == 1);
        a.pause();
        a.pause();
        expect(a.paused, isTrue);
        a.notifyRemoteChange();
        await Future<void>.delayed(const Duration(milliseconds: 400));
        expect(log.length, 1, reason: 'paused: no idle poll, no change pull');
        a.resume();
        a.resume();
        await until(() => log.length == 2);
        await a.stop();
      },
    );
  });
}
