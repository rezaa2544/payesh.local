import 'dart:convert';
import 'dart:io';

import 'package:payesh_core/payesh_core.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

/// Local loopback HTTP server standing in for the Gateway (mock tests; the real server
/// runs in test/server_it_test.dart).
void main() {
  late HttpServer server;
  late HttpSyncTransport transport;
  final seen = <HttpRequest>[];
  final bodies = <String>[];
  late void Function(HttpRequest req) handler;

  setUp(() async {
    seen.clear();
    bodies.clear();
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      seen.add(req);
      bodies.add(await utf8.decodeStream(req));
      handler(req);
    });
    var n = 0;
    transport = HttpSyncTransport(
      baseUri: Uri.parse('http://127.0.0.1:${server.port}'),
      token: () => 'tok-1',
      deviceId: 'dev-9',
      requestId: () => 'rid-${++n}',
      timeout: const Duration(seconds: 2),
    );
  });
  tearDown(() async {
    transport.close();
    await server.close(force: true);
  });

  void reply(
    HttpRequest req,
    int status,
    Object body, {
    Map<String, String> headers = const {},
  }) {
    req.response.statusCode = status;
    headers.forEach(req.response.headers.set);
    req.response.headers.contentType = ContentType.json;
    req.response.write(jsonEncode(body));
    req.response.close();
  }

  test(
    'pull sends cursor + auth, version, request-id and device headers',
    () async {
      handler = (req) => reply(req, 200, {
        'ok': true,
        'schema_version': 1,
        'server_time': '2026-11-07T00:00:00.000Z',
        'next_since': '2026-11-07T00:00:00.000Z',
        'next_id': 3,
        'more': false,
        'collections': {
          'attendance': [
            {'id': 3},
          ],
        },
        'deleted': <Object?>[],
      });
      final p = await transport.pull(
        since: '2026-01-01T00:00:00.000Z',
        sinceId: 7,
        collections: ['attendance', 'grades'],
      );
      final r = seen.single;
      expect(r.method, 'GET');
      expect(r.uri.path, '/api/v1/pull');
      expect(r.uri.queryParameters, {
        'since': '2026-01-01T00:00:00.000Z',
        'since_id': '7',
        'collections': 'attendance,grades',
      });
      expect(r.headers.value('authorization'), 'Bearer tok-1');
      expect(r.headers.value(PayeshApi.versionHeader), 'payesh-native/0.1.0');
      expect(r.headers.value(PayeshApi.requestIdHeader), 'rid-1');
      expect(r.headers.value(PayeshApi.deviceIdHeader), 'dev-9');
      expect(transport.lastRequestId, 'rid-1');
      expect(p.nextId, 3);
      expect(p.collections['attendance']!.single['id'], 3);
    },
  );

  test('push posts {ops} as JSON and parses verdicts', () async {
    handler = (req) => reply(req, 200, {
      'ok': true,
      'applied': [
        {'uid': 'a', 'id': 1, 'version': 1},
      ],
      'rejected': [
        {'uid': 'b', 'error': 'role_denied'},
      ],
      'conflicts': <Object?>[],
    });
    final v = await transport.push([
      {
        'uid': 'a',
        'collection': 'attendance',
        'type': 'put',
        'data': {'x': 'ی'},
      },
    ]);
    expect(seen.single.method, 'POST');
    expect(seen.single.uri.path, '/api/sync');
    expect(seen.single.headers.contentType!.mimeType, 'application/json');
    expect(jsonDecode(bodies.single), {
      'ops': [
        {
          'uid': 'a',
          'collection': 'attendance',
          'type': 'put',
          'data': {'x': 'ی'},
        },
      ],
    });
    expect(v.applied.keys, ['a']);
    expect(v.rejected['b']!['error'], 'role_denied');
  });

  final cases =
      <
        (int, Map<String, Object?>, Map<String, String>, PayeshErrorCode?, int?)
      >[
        (
          401,
          {'error': 'unauthorized'},
          {},
          PayeshErrorCode.unauthorized,
          null,
        ),
        (403, {'error': 'missing_cell'}, {}, PayeshErrorCode.missingCell, null),
        (403, {'error': 'wrong_cell'}, {}, PayeshErrorCode.wrongCell, null),
        (
          409,
          {'error': 'write_frozen', 'retry_after_ms': 15000},
          {},
          PayeshErrorCode.writeFrozen,
          15000,
        ),
        (
          413,
          {'error': 'body_too_large'},
          {},
          PayeshErrorCode.payloadTooLarge,
          null,
        ),
        (
          429,
          {'error': 'rate_limited'},
          {'retry-after': '30'},
          PayeshErrorCode.unknown,
          30000,
        ),
        (502, {}, {}, PayeshErrorCode.unknown, null),
      ];
  for (final (status, body, headers, code, retry) in cases) {
    test(
      'HTTP $status ${body['error'] ?? ''} → SyncFailure(${code?.wire})',
      () async {
        handler = (req) => reply(req, status, body, headers: headers);
        await expectLater(
          transport.push(const []),
          throwsA(
            isA<SyncFailure>()
                .having((e) => e.status, 'status', status)
                .having((e) => e.code, 'code', code)
                .having((e) => e.retryAfterMs, 'retryAfterMs', retry),
          ),
        );
      },
    );
  }

  test('non-JSON error body still maps by status', () async {
    handler = (req) {
      req.response.statusCode = 500;
      req.response.write('<html>oops</html>');
      req.response.close();
    };
    await expectLater(
      transport.pull(since: 'x', sinceId: 0),
      throwsA(
        isA<SyncFailure>().having((e) => e.message, 'message', 'http_500'),
      ),
    );
  });

  test('connection refused → SyncFailure network (no code)', () async {
    final s = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = s.port;
    await s.close();
    final dead = HttpSyncTransport(
      baseUri: Uri.parse('http://127.0.0.1:$port'),
      token: () => 't',
      deviceId: 'd',
    );
    addTearDown(dead.close);
    await expectLater(
      dead.push(const []),
      throwsA(
        isA<SyncFailure>()
            .having((e) => e.code, 'code', isNull)
            .having((e) => e.message, 'm', startsWith('network')),
      ),
    );
  });

  test('server that never answers → SyncFailure timeout', () async {
    handler = (req) {}; // never responds
    final slow = HttpSyncTransport(
      baseUri: Uri.parse('http://127.0.0.1:${server.port}'),
      token: () => 't',
      deviceId: 'd',
      timeout: const Duration(milliseconds: 300),
    );
    addTearDown(slow.close);
    await expectLater(
      slow.pull(since: 'x', sinceId: 0),
      throwsA(isA<SyncFailure>().having((e) => e.message, 'm', 'timeout')),
    );
  });

  test('default request ids are UUIDv4 and differ per request', () async {
    handler = (req) => reply(req, 200, {'ok': true});
    final t2 = HttpSyncTransport(
      baseUri: Uri.parse('http://127.0.0.1:${server.port}'),
      token: () => 't',
      deviceId: 'd',
    );
    addTearDown(t2.close);
    await t2.push(const []);
    await t2.push(const []);
    final ids = seen
        .map((r) => r.headers.value(PayeshApi.requestIdHeader)!)
        .toList();
    expect(ids.every(isUuidV4), isTrue);
    expect(ids.toSet().length, 2);
  });
}
