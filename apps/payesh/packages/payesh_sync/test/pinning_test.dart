import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:payesh_core/payesh_core.dart';
import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

import 'support/tls.dart';

/// Mock Gateway over TLS. Records every HTTP request that actually arrived.
final class MockGateway {
  MockGateway._(this.server);
  final HttpServer server;
  final requests = <HttpRequest>[];
  final headers = <Map<String, String>>[];
  final bodies = <String>[];
  final pullAnswers = <Map<String, Object?>>[];
  Map<String, Object?> pushAnswer = const {'ok': true, 'applied': <Object?>[]};
  int status = 200;

  static Future<MockGateway> start(SecurityContext? tls) async {
    final s = tls == null
        ? await HttpServer.bind(InternetAddress.loopbackIPv4, 0)
        : await HttpServer.bindSecure(InternetAddress.loopbackIPv4, 0, tls);
    final m = MockGateway._(s);
    s.listen((req) async {
      m.requests.add(req);
      final h = <String, String>{};
      req.headers.forEach((k, v) => h[k] = v.join(','));
      m.headers.add(h);
      m.bodies.add(await utf8.decodeStream(req));
      final Object body;
      if (m.status != 200) {
        body = {'ok': false, 'error': 'unauthorized'};
      } else if (req.uri.path == '/api/gw/v1/pull') {
        body = m.pullAnswers.isEmpty
            ? {
                'ok': true,
                'schema_version': 1,
                'rows': <Object?>[],
                'more': false,
                'next_seq': 0,
              }
            : m.pullAnswers.removeAt(0);
      } else {
        body = m.pushAnswer;
      }
      req.response
        ..statusCode = m.status
        ..headers.contentType = ContentType.json
        ..write(jsonEncode(body));
      await req.response.close();
    });
    return m;
  }

  Uri get https => Uri.parse('https://127.0.0.1:${server.port}');
  Uri get http => Uri.parse('http://127.0.0.1:${server.port}');
  Future<void> close() => server.close(force: true);
}

void main() {
  late TestPki pki;
  setUpAll(() async => pki = await TestPki.create());
  tearDownAll(() => pki.dispose());

  group('SPKI pin computation', () {
    test('matches openssl pin-sha256 for every test certificate', () {
      for (final n in ['leaf', 'rogue', 'backup']) {
        final pem = File(pki.leafPem(n)).readAsStringSync();
        final b64 = pem
            .split('\n')
            .where((l) => l.isNotEmpty && !l.startsWith('-----'))
            .join();
        expect(spkiPin(base64.decode(b64)), pki.pins[n], reason: n);
      }
      expect(pki.pins.values.toSet().length, 3);
    });

    test('garbage DER is rejected', () {
      for (final bad in [
        <int>[],
        [0x02, 0x01, 0x00],
        [0x30, 0x85, 1, 1, 1, 1, 1],
        [0x30, 0x10, 0x30],
        [0x30, 0x03, 0x02, 0x01, 0x00],
        [0x30, 0x80],
      ]) {
        expect(
          () => subjectPublicKeyInfo(Uint8List.fromList(bad)),
          throwsFormatException,
          reason: '$bad',
        );
      }
    });
  });

  group('GatewayConfig (owner decision: pinning ON + backup pin)', () {
    final a = base64.encode(List.filled(32, 1));
    final b = base64.encode(List.filled(32, 2));
    test('accepts https + two distinct pins', () {
      final c = GatewayConfig(
        baseUri: Uri.parse('https://gw.a.b'),
        pins: [a, ' $b '],
      );
      expect(c.accepts(b), isTrue);
      expect(c.accepts('x'), isFalse);
    });
    test('rejects http, a single pin, duplicate pins and malformed pins', () {
      expect(
        () => GatewayConfig(baseUri: Uri.parse('http://gw.a.b'), pins: [a, b]),
        throwsA(isA<PinConfigException>()),
      );
      expect(
        () => GatewayConfig(baseUri: Uri.parse('https://gw.a.b'), pins: [a]),
        throwsA(isA<PinConfigException>()),
      );
      expect(
        () => GatewayConfig(baseUri: Uri.parse('https://gw.a.b'), pins: [a, a]),
        throwsA(isA<PinConfigException>()),
      );
      expect(
        () => GatewayConfig(
          baseUri: Uri.parse('https://gw.a.b'),
          pins: [a, 'nope'],
        ),
        throwsA(
          isA<PinConfigException>().having(
            (e) => e.toString(),
            's',
            contains('nope'),
          ),
        ),
      );
    });
    test('fromEnvironment: unset → no remote data path; set → validated', () {
      expect(GatewayConfig.fromEnvironment(), isNull);
      expect(
        GatewayConfig.fromEnvironment(
          url: 'https://gw.a.b',
          pins: '$a,$b',
        )!.pins,
        [a, b],
      );
      expect(
        () => GatewayConfig.fromEnvironment(url: 'https://gw.a.b', pins: a),
        throwsA(isA<PinConfigException>()),
      );
    });
  });

  group('pinned TLS client against a mock Gateway', () {
    late MockGateway gw;
    tearDown(() => gw.close());

    GatewayTransport client(List<String> pins, Uri base) =>
        GatewayTransport.pinned(
          GatewayConfig(baseUri: base, pins: pins),
          token: () => 'tok-75',
          deviceId: 'dev-75',
          context: pki.clientContext(),
          timeout: const Duration(seconds: 5),
        );

    test('primary pin: request goes through with version, request id, device and token', () async {
      gw = await MockGateway.start(pki.serverContext('leaf'));
      final t = client([pki.pins['leaf']!, pki.pins['backup']!], gw.https);
      final p = await t.pull(sinceSeq: 7, limit: 50);
      expect(p.schemaVersion, 1);
      final h = gw.headers.single;
      expect(gw.requests.single.uri.path, '/api/gw/v1/pull');
      expect(gw.requests.single.uri.queryParameters, {
        'since_seq': '7',
        'limit': '50',
      });
      expect(h['x-payesh-client'], 'payesh-native/0.1.0');
      expect(isUuidV4(h['x-request-id']!), isTrue);
      expect(h['x-request-id'], t.lastRequestId);
      expect(h['x-device-id'], 'dev-75');
      expect(h['authorization'], 'Bearer tok-75');
      t.close();
    });

    test(
      'backup pin only (key rotated on the server): still accepted',
      () async {
        gw = await MockGateway.start(pki.serverContext('backup'));
        final t = client([pki.pins['leaf']!, pki.pins['backup']!], gw.https);
        expect((await t.pull()).rows, isEmpty);
        expect(gw.requests, hasLength(1));
        t.close();
      },
    );

    test('valid chain but UNPINNED key (MITM with trusted CA) → refused, zero HTTP bytes sent', () async {
      gw = await MockGateway.start(pki.serverContext('rogue'));
      final t = client([pki.pins['leaf']!, pki.pins['backup']!], gw.https);
      await expectLater(
        t.pull(),
        throwsA(
          isA<SyncFailure>().having(
            (e) => e.message,
            'm',
            startsWith('certificate_pin_mismatch'),
          ),
        ),
      );
      await expectLater(
        t.push([
          {'uid': 'u'},
        ]),
        throwsA(isA<SyncFailure>()),
      );
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(
        gw.requests,
        isEmpty,
        reason: 'token/body must never reach an unpinned server',
      );
      t.close();
    });

    test(
      'pinned outbox drain: a pin failure keeps the ops queued (never dropped)',
      () async {
        gw = await MockGateway.start(pki.serverContext('rogue'));
        final t = client([pki.pins['leaf']!, pki.pins['backup']!], gw.https);
        final ob = SqliteOutbox.inMemory(config: const OutboxConfig(jitter: 0));
        ob.enqueue({
          'k': 'p1',
          'collection': 'grades',
          'type': 'put',
          'id': 1,
          'data': {'s': 1},
        });
        final r = await ob.drain(t.push);
        expect(
          r.stopped,
          'network',
          reason: 'transport-level failure: retried with backoff',
        );
        expect(r.failed, 1);
        expect(ob.stats().total, 1);
        t.close();
      },
    );

    test(
      'untrusted chain is still refused (pinning does not disable validation)',
      () async {
        gw = await MockGateway.start(pki.serverContext('leaf'));
        final t = GatewayTransport.pinned(
          GatewayConfig(
            baseUri: gw.https,
            pins: [pki.pins['leaf']!, pki.pins['backup']!],
          ),
          token: () => 't',
          deviceId: 'd',
          context: SecurityContext(withTrustedRoots: false),
          timeout: const Duration(seconds: 5),
        );
        await expectLater(
          t.pull(),
          throwsA(
            isA<SyncFailure>().having((e) => e.message, 'm', startsWith('tls')),
          ),
        );
        expect(gw.requests, isEmpty);
        t.close();
      },
    );

    test(
      'plaintext http and proxies are refused by the pinned client',
      () async {
        gw = await MockGateway.start(null);
        final cfg = GatewayConfig(
          baseUri: Uri.parse('https://127.0.0.1:1'),
          pins: [pki.pins['leaf']!, pki.pins['backup']!],
        );
        final c = createPinnedHttpClient(cfg, context: pki.clientContext());
        await expectLater(c.getUrl(gw.http), throwsA(isA<PinningException>()));
        c.findProxy = (_) => 'PROXY 127.0.0.1:9';
        await expectLater(
          c.getUrl(gw.http.replace(scheme: 'https')),
          throwsA(isA<PinningException>()),
        );
        expect(const PinningException('h', 'p').toString(), contains('"p"'));
        c.close(force: true);
        expect(gw.requests, isEmpty);
      },
    );
  });

  group('GatewayTransport + GatewaySync (mock, plain HTTP)', () {
    late MockGateway gw;
    late GatewayTransport t;
    late SqliteEngine engine;
    setUp(() async {
      gw = await MockGateway.start(null);
      t = GatewayTransport(
        baseUri: gw.http,
        token: () => 'tok',
        deviceId: 'd1',
      );
      engine = SqliteEngine.inMemory();
    });
    tearDown(() async {
      t.close();
      engine.close();
      await gw.close();
    });

    Map<String, Object?> page(
      List<Map<String, Object?>> rows, {
      bool more = false,
      int next = 0,
      int schema = 1,
    }) => {
      'ok': true,
      'schema_version': schema,
      'rows': rows,
      'more': more,
      'next_seq': next,
    };

    test(
      'push maps applied / duplicates / conflicts onto the outbox verdicts',
      () async {
        gw.pushAnswer = {
          'ok': true,
          'applied': [
            {'uid': 'a', 'id': 1, 'version': 1},
          ],
          'duplicates': [
            {'uid': 'b'},
          ],
          'conflicts': [
            {'uid': 'c', 'id': 3, 'version': 4},
          ],
        };
        final v = await t.push([
          {'uid': 'a'},
          {'uid': 'b'},
          {'uid': 'c'},
        ]);
        expect(v.applied.keys, ['a', 'b']);
        expect(v.applied['b']!['duplicate'], true);
        expect(v.conflicts['c']!['version'], 4);
        expect(jsonDecode(gw.bodies.single), {
          'ops': [
            {'uid': 'a'},
            {'uid': 'b'},
            {'uid': 'c'},
          ],
        });
        expect(gw.requests.single.uri.path, '/api/gw/v1/push');
      },
    );

    test(
      'paged pull applies puts and deletes, persists the seq cursor',
      () async {
        await engine.put('grades', 9, {'id': 9});
        gw.pullAnswers
          ..add(
            page(
              [
                {
                  'seq': 1,
                  'collection': 'grades',
                  'id': 1,
                  'op': 'put',
                  'version': 2,
                  'data': {'score': 18},
                },
                {
                  'seq': 2,
                  'collection': 'grades',
                  'id': 9,
                  'op': 'del',
                  'version': 3,
                },
              ],
              more: true,
              next: 2,
            ),
          )
          ..add(
            page([
              {
                'seq': 3,
                'collection': 'classes',
                'id': 4,
                'op': 'put',
                'version': 1,
                'data': {'name': 'x'},
              },
              {
                'seq': 4,
                'collection': 'classes',
                'id': 0,
                'op': 'put',
                'data': {'bad': true},
              },
            ], next: 4),
          );
        final s = GatewaySync(engine: engine, transport: t, pageSize: 2);
        final r = await s.pull();
        expect((r.pages, r.rows, r.deleted, r.skipped), (2, 2, 1, 1));
        expect(s.cursor, 4);
        expect((await engine.get('grades', 1))!.data, {'score': 18, 'id': 1});
        expect((await engine.get('grades', 1))!.version, 2);
        expect(await engine.get('grades', 9), isNull);
        expect(gw.requests.map((q) => q.uri.queryParameters['since_seq']), [
          '0',
          '2',
        ]);
        gw.pullAnswers.add(page([], next: 4));
        await s.pull();
        expect(gw.requests.last.uri.queryParameters['since_seq'], '4');
      },
    );

    test(
      'protocol guards: schema, backwards cursor, no progress, page cap',
      () async {
        final s = GatewaySync(engine: engine, transport: t);
        gw.pullAnswers.add(page([], schema: 2));
        await expectLater(s.pull(), throwsA(isA<SyncProtocolException>()));
        gw.pullAnswers.add(page([], next: 5));
        await s.pull();
        gw.pullAnswers.add(page([], next: 3));
        await expectLater(s.pull(), throwsA(isA<SyncProtocolException>()));
        gw.pullAnswers.add(page([], more: true, next: 5));
        await expectLater(s.pull(), throwsA(isA<SyncProtocolException>()));
        final capped = GatewaySync(engine: engine, transport: t, maxPages: 1);
        gw.pullAnswers
          ..add(page([], more: true, next: 6))
          ..add(page([], next: 7));
        await expectLater(capped.pull(), throwsA(isA<SyncProtocolException>()));
      },
    );

    test('HTTP 401 from the Gateway → SyncFailure(unauthorized)', () async {
      gw.status = 401;
      await expectLater(
        t.pull(),
        throwsA(
          isA<SyncFailure>().having(
            (e) => e.code,
            'code',
            PayeshErrorCode.unauthorized,
          ),
        ),
      );
    });
  });
}
