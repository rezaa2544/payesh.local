// Row 75 — the native client against the REAL stateless Gateway (server/gateway.js) on a real
// PostgreSQL, through a TLS front with SPKI pinning (primary + backup). Not a mock.
// Runs when PAYESH_GW_IT=1 (CI job `gateway-real` in native-client.yml).
@Tags(['server'])
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:payesh_core/payesh_core.dart';
import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

import 'support/tls.dart';

final env = Platform.environment;
final bool enabled = env['PAYESH_GW_IT'] == '1';
final String node = env['PAYESH_NODE'] ?? 'node';
final String repoRoot =
    env['PAYESH_REPO_ROOT'] ?? Directory('../../../..').absolute.path;

/// TLS terminator in front of the Gateway (like the production reverse proxy). Counts the
/// decrypted application bytes it received, so a refused handshake provably leaked nothing.
final class TlsFront {
  TlsFront._(this.server, this.upstream);
  final SecureServerSocket server;
  final int upstream;
  final received = BytesBuilder();

  static Future<TlsFront> start(SecurityContext ctx, int upstream) async {
    final s = await SecureServerSocket.bind(
      InternetAddress.loopbackIPv4,
      0,
      ctx,
    );
    final f = TlsFront._(s, upstream);
    s.listen(
      (client) async {
        final up = await Socket.connect(InternetAddress.loopbackIPv4, upstream);
        client.listen(
          (d) {
            f.received.add(d);
            up.add(d);
          },
          onDone: up.destroy,
          onError: (_) => up.destroy(),
        );
        up.listen(
          client.add,
          onDone: client.destroy,
          onError: (_) => client.destroy(),
        );
      },
      onError: (_) {}, // failed handshakes (unpinned/untrusted) end here
    );
    return f;
  }

  Uri get uri => Uri.parse('https://127.0.0.1:${server.port}');
  String get text => latin1.decode(received.toBytes());
  Future<void> close() => server.close();
}

void main() {
  late TestPki pki;
  late Process gw;
  late int gwPort;
  late Map<String, String> tokens;
  late TlsFront front;
  late TlsFront rogue;
  final gwLog = StringBuffer();

  setUpAll(() async {
    if (!enabled) return;
    pki = await TestPki.create();
    final rnd = Random.secure();
    final secret = List.generate(
      32,
      (_) => rnd.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ).join();
    final h = await Process.run(
      node,
      ['test/support/gateway_harness.cjs'],
      environment: {
        'PAYESH_REPO_ROOT': repoRoot,
        'PGURL_ADMIN': env['PAYESH_PG_ADMIN']!,
        'SECRET': secret,
      },
    );
    expect(h.exitCode, 0, reason: '${h.stderr}');
    tokens = (jsonDecode('${h.stdout}') as Map).cast<String, String>();
    final s = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    gwPort = s.port;
    await s.close();
    gw = await Process.start(
      node,
      ['server/gateway.js'],
      workingDirectory: repoRoot,
      environment: {
        'PORT': '$gwPort',
        'HOST': '127.0.0.1',
        'PGURL': env['PAYESH_PG_RUNTIME']!,
        'GW_SECRET': secret,
        'GW_INSTANCE': 'gw-native-75',
        'GW_QUOTA_MAX': '100000',
        'PAYESH_LOG': '0',
      },
    );
    gw.stdout.transform(utf8.decoder).listen(gwLog.write);
    gw.stderr.transform(utf8.decoder).listen(gwLog.write);
    final c = HttpClient();
    var ready = false;
    for (var i = 0; i < 150 && !ready; i++) {
      try {
        final r = await (await c.getUrl(
          Uri.parse('http://127.0.0.1:$gwPort/readyz'),
        )).close();
        await r.drain<void>();
        ready = r.statusCode == 200;
      } on SocketException {
        // not up yet
      }
      if (!ready) await Future<void>.delayed(const Duration(milliseconds: 200));
    }
    c.close(force: true);
    expect(ready, isTrue, reason: 'gateway /readyz never 200:\n$gwLog');
    front = await TlsFront.start(pki.serverContext('leaf'), gwPort);
    rogue = await TlsFront.start(pki.serverContext('rogue'), gwPort);
  });

  tearDownAll(() async {
    if (!enabled) return;
    await front.close();
    await rogue.close();
    gw.kill(ProcessSignal.sigkill);
    await gw.exitCode;
    pki.dispose();
  });

  final skip = enabled
      ? false
      : 'set PAYESH_GW_IT=1 (+ PAYESH_PG_ADMIN/RUNTIME) for the real Gateway';

  GatewayTransport pinned(Uri base, String tok, {String device = 'dev-a'}) =>
      GatewayTransport.pinned(
        GatewayConfig(
          baseUri: base,
          pins: [pki.pins['leaf']!, pki.pins['backup']!],
        ),
        token: () => tok,
        deviceId: device,
        context: pki.clientContext(),
        timeout: const Duration(seconds: 10),
      );

  test(
    'push through pinned TLS → real Gateway applies once; same uid → duplicate',
    () async {
      final t = pinned(front.uri, tokens['A']!);
      final ob = SqliteOutbox.inMemory(config: const OutboxConfig(jitter: 0));
      ob.enqueue({
        'k': 'gw-1',
        'collection': 'announcements',
        'type': 'put',
        'id': 7501,
        'data': {'title': 'اطلاعیهٔ Gateway'},
      });
      ob.enqueue({
        'k': 'gw-2',
        'collection': 'classes',
        'type': 'put',
        'id': 7502,
        'data': {'name': 'دهم الف'},
      });
      final applied = <String, Map<String, Object?>>{};
      final r = await ob.drain(t.push, onApplied: (o, v) => applied[o.k] = v);
      expect(r.applied, 2, reason: gwLog.toString());
      expect(applied['gw-1']!['version'], 1);
      ob.enqueue({
        'k': 'gw-1',
        'collection': 'announcements',
        'type': 'put',
        'id': 7501,
        'data': {'title': 'اطلاعیهٔ Gateway'},
      });
      final dup = <Map<String, Object?>>[];
      await ob.drain(t.push, onApplied: (o, v) => dup.add(v));
      expect(dup.single['duplicate'], true);
      t.close();
    },
    skip: skip,
  );

  test('version header, request id and device id reach the Gateway (seen at the TLS front)', () async {
    final txt = front.text.toLowerCase();
    expect(txt, contains('x-payesh-client: payesh-native/0.1.0'));
    expect(txt, contains('x-device-id: dev-a'));
    final ids = RegExp(r'x-request-id: ([0-9a-f-]{36})')
        .allMatches(txt)
        .map((m) => m.group(1)!)
        .toList();
    expect(ids.length, greaterThanOrEqualTo(2));
    expect(ids.every(isUuidV4), isTrue);
    expect(ids.toSet().length, ids.length, reason: 'fresh id per request');
  }, skip: skip);

  test('pull from the real change feed into the local SQLite engine; second pull empty', () async {
    final engine = SqliteEngine.inMemory();
    final t = pinned(front.uri, tokens['A']!);
    final s = GatewaySync(engine: engine, transport: t, pageSize: 1);
    final r = await s.pull();
    expect(r.rows, 2);
    expect(r.pages, greaterThanOrEqualTo(2), reason: 'paged with limit=1');
    expect(
      (await engine.get('announcements', 7501))!.data['title'],
      'اطلاعیهٔ Gateway',
    );
    expect(s.cursor, greaterThan(0));
    expect((await s.pull()).rows, 0);
    engine.close();
    t.close();
  }, skip: skip);

  test('tenant isolation: tenant B sees none of tenant A rows', () async {
    final t = pinned(front.uri, tokens['B']!, device: 'dev-b');
    final p = await t.pull();
    expect(p.rows.where((r) => r.id == 7501 || r.id == 7502), isEmpty);
    t.close();
  }, skip: skip);

  test('stale base_version → real conflict verdict, op leaves the queue, server keeps v1', () async {
    final t = pinned(front.uri, tokens['A']!);
    final ob = SqliteOutbox.inMemory(config: const OutboxConfig(jitter: 0));
    ob.enqueue({
      'k': 'gw-stale',
      'collection': 'announcements',
      'type': 'put',
      'id': 7501,
      'base_version': 9,
      'data': {'title': 'stale'},
    });
    final conflicts = <Map<String, Object?>>[];
    final r = await ob.drain(t.push, onConflict: (o, v) => conflicts.add(v));
    expect(r.conflicts, 1, reason: gwLog.toString());
    expect(conflicts.single['id'], 7501);
    final p = await t.pull();
    expect(
      p.rows.where((x) => x.id == 7501).last.data!['title'],
      'اطلاعیهٔ Gateway',
    );
    t.close();
  }, skip: skip);

  test('MITM front with a trusted-CA but UNPINNED key → refused, zero bytes reach the Gateway', () async {
    final t = pinned(rogue.uri, tokens['A']!);
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
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(
      rogue.received.length,
      0,
      reason: 'no request (and no token) was sent',
    );
    t.close();
  }, skip: skip);

  test('invalid token → 401 unauthorized from the real Gateway', () async {
    final t = pinned(
      front.uri,
      '${tokens['A']!.substring(0, tokens['A']!.length - 6)}AAAAAA',
    );
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
    t.close();
  }, skip: skip);
}
