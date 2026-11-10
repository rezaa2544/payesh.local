// Integration test against the REAL Payesh Node server (server/index.js), not a mock.
// Runs only when PAYESH_SERVER_IT=1 (CI job `sync-real-server` in native-client.yml).
// PAYESH_NODE overrides the node binary; the repo root is four levels up.
@Tags(['server'])
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:payesh_core/payesh_core.dart';
import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

final bool enabled = Platform.environment['PAYESH_SERVER_IT'] == '1';
final String node = Platform.environment['PAYESH_NODE'] ?? 'node';
final String repoRoot =
    Platform.environment['PAYESH_REPO_ROOT'] ??
    Directory('../../../..').absolute.path;

final class RealServer {
  RealServer(this.dataDir);
  final String dataDir;
  Process? proc;
  late int port;
  final log = StringBuffer();

  Uri get base => Uri.parse('http://127.0.0.1:$port');

  Future<void> start({int? fixedPort}) async {
    if (fixedPort != null) {
      port = fixedPort;
    } else {
      final s = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      port = s.port;
      await s.close();
    }
    proc = await Process.start(
      node,
      [
        '--experimental-sqlite',
        '--disable-warning=ExperimentalWarning',
        'server/index.js',
      ],
      workingDirectory: repoRoot,
      environment: {
        'PORT': '$port',
        'HOST': '127.0.0.1',
        'PAYESH_DATA': dataDir,
        'PAYESH_LOG': '0',
        'PAYESH_AUTO_BACKUP': '0',
        'PAYESH_UPDATE_AUTO': '0',
        'PAYESH_LIVE_MS': '0',
        'PAYESH_OUTBOX_AUTO': '0',
        'PAYESH_CLOUD_AUTO': '0',
        'PAYESH_MIRROR': '0',
      },
    );
    proc!.stdout.transform(utf8.decoder).listen(log.write);
    proc!.stderr.transform(utf8.decoder).listen(log.write);
    final c = HttpClient();
    try {
      for (var i = 0; i < 200; i++) {
        try {
          final req = await c.getUrl(base.resolve('/api/health'));
          final res = await req.close();
          final body = await utf8.decodeStream(res);
          if (res.statusCode == 200 && body.contains('"ok":true')) return;
        } on SocketException {
          // not up yet
        }
        await Future<void>.delayed(const Duration(milliseconds: 150));
      }
    } finally {
      c.close(force: true);
    }
    throw StateError('server did not start:\n$log');
  }

  Future<void> kill() async {
    proc?.kill(ProcessSignal.sigkill);
    await proc?.exitCode;
    proc = null;
  }

  Future<Map<String, Object?>> json(
    String method,
    String path, {
    Object? body,
    String? token,
  }) async {
    final c = HttpClient();
    try {
      final req = await c.openUrl(method, base.resolve(path));
      req.headers.contentType = ContentType.json;
      if (token != null) req.headers.set('authorization', 'Bearer $token');
      if (body != null) req.write(jsonEncode(body));
      final res = await req.close();
      final text = await utf8.decodeStream(res);
      return {
        'status': res.statusCode,
        ...(jsonDecode(text) as Map).cast<String, Object?>(),
      };
    } finally {
      c.close(force: true);
    }
  }
}

void main() {
  late Directory tmp;
  late RealServer srv;
  late String token;
  late SqliteEngine engine;
  late SqliteOutbox outbox;
  late HttpSyncTransport transport;
  late SyncClient client;

  setUpAll(() async {
    if (!enabled) return;
    tmp = Directory.systemTemp.createTempSync('payesh_it_');
    srv = RealServer('${tmp.path}/srv');
    await srv.start();
    final r = await srv.json(
      'POST',
      '/api/setup',
      body: {
        'school_name': 'مدرسهٔ آزمون بومی',
        'manager_name': 'مدیر آزمون',
        'password': 'Native-71-Pass',
        'phone': '09120000071',
      },
    );
    expect(r['status'], 200, reason: '$r');
    token = ((r['session']! as Map)['token']) as String;
    engine = SqliteEngine.open('${tmp.path}/client.db');
    outbox = SqliteOutbox(
      engine.database,
      config: const OutboxConfig(jitter: 0),
    );
    transport = HttpSyncTransport(
      baseUri: srv.base,
      token: () => token,
      deviceId: 'it-device-1',
    );
    client = SyncClient(engine: engine, outbox: outbox, transport: transport);
  });

  tearDownAll(() async {
    if (!enabled) return;
    transport.close();
    engine.close();
    await srv.kill();
    tmp.deleteSync(recursive: true);
  });

  final skip = enabled
      ? false
      : 'set PAYESH_SERVER_IT=1 to run against the real Node server';

  test(
    'push: offline-created ops are applied once by the real server',
    () async {
      outbox.enqueue({
        'k': 'it-a1',
        'collection': 'announcements',
        'type': 'put',
        'data': {'title': 'اطلاعیهٔ بومی', 'body': 'متن', 'date': '2026-11-10'},
      });
      outbox.enqueue({
        'k': 'it-c1',
        'collection': 'classes',
        'type': 'put',
        'data': {'name': 'دهم ب', 'grade': '10'},
      });
      final applied = <String, Map<String, Object?>>{};
      final r = await outbox.drain(
        transport.push,
        onApplied: (o, v) => applied[o.k] = v,
      );
      expect(r.applied, 2, reason: srv.log.toString());
      expect(r.stopped, isNull);
      expect(outbox.stats().total, 0);
      expect(applied['it-a1']!['id'], isA<int>());
    },
    skip: skip,
  );

  test(
    'idempotency: re-sending the same uid is marked duplicate, no second row',
    () async {
      outbox.enqueue({
        'k': 'it-a1',
        'collection': 'announcements',
        'type': 'put',
        'data': {'title': 'اطلاعیهٔ بومی', 'body': 'متن', 'date': '2026-11-10'},
      });
      final dup = <Map<String, Object?>>[];
      await outbox.drain(transport.push, onApplied: (o, v) => dup.add(v));
      expect(dup.single['duplicate'], true);
      final p = await srv.json(
        'GET',
        '/api/v1/pull?since=1970-01-01T00:00:00.000Z&collections=announcements',
        token: token,
      );
      final rows = ((p['collections']! as Map)['announcements'] as List).where(
        (r) => (r as Map)['title'] == 'اطلاعیهٔ بومی',
      );
      expect(rows.length, 1);
    },
    skip: skip,
  );

  test(
    'pull: real rows land in the local SQLite engine; second pull is empty',
    () async {
      final r1 = await client.pull();
      expect(r1.rows, greaterThanOrEqualTo(2));
      final ann = await engine.list('announcements');
      expect(ann.map((e) => e.data['title']), contains('اطلاعیهٔ بومی'));
      final (since, _) = client.cursor;
      expect(since, isNot(epoch));
      final r2 = await client.pull();
      expect(r2.rows, 0);
    },
    skip: skip,
  );

  test('fault: bad token → unauthorized, ops stay queued and are sent after re-login', () async {
    final good = token;
    token = 'not-a-valid-token';
    outbox.enqueue({
      'k': 'it-a2',
      'collection': 'announcements',
      'type': 'put',
      'data': {'title': 'دوم', 'body': 'x', 'date': '2026-11-10'},
    });
    final r = await client.syncOnce();
    expect(r.push.stopped, 'unauthorized');
    expect(outbox.stats().pending, 1);
    token = good;
    outbox.retry('it-a2');
    final r2 = await client.syncOnce();
    expect(r2.push.applied, 1);
    expect(r2.pull!.rows, greaterThanOrEqualTo(1));
  }, skip: skip);

  test('fault: server killed (offline) → op kept; after restart it is applied exactly once', () async {
    final port = srv.port;
    await srv.kill();
    outbox.enqueue({
      'k': 'it-a3',
      'collection': 'announcements',
      'type': 'put',
      'data': {'title': 'پس از قطعی', 'body': 'x', 'date': '2026-11-10'},
    });
    final r = await client.push();
    expect(r.stopped, 'network');
    expect(outbox.get('it-a3')!.state, OpState.pending);
    await srv.start(fixedPort: port);
    outbox.retry('it-a3');
    final r2 = await client.push();
    expect(r2.applied, 1);
    await client.pull();
    final titles = (await engine.list('announcements'))
        .map((e) => e.data['title'])
        .toList();
    expect(titles.where((t) => t == 'پس از قطعی').length, 1);
  }, skip: skip);

  test(
    'server rejects an unknown collection per op (rejected, not 500)',
    () async {
      outbox.enqueue({
        'k': 'it-x1',
        'collection': 'no_such_collection',
        'type': 'put',
        'data': {'a': 1},
      });
      final rejected = <Map<String, Object?>>[];
      await outbox.drain(transport.push, onRejected: (o, v) => rejected.add(v));
      expect(rejected.single['error'], 'unknown_collection');
      expect(outbox.stats().total, 0);
    },
    skip: skip,
  );

  test('convergence: stale edit vs another device → real server conflict; both versions kept', () async {
    // Device B (raw HTTP) creates a record, then edits it → server version 2.
    Future<Map<String, Object?>> rawPush(Map<String, Object?> op) async {
      final r = await srv.json(
        'POST',
        '/api/sync',
        token: token,
        body: {
          'ops': [op],
        },
      );
      expect(r['status'], 200, reason: '$r');
      return ((r['applied']! as List).single as Map).cast<String, Object?>();
    }

    final created = await rawPush({
      'uid': 'b-create',
      'collection': 'announcements',
      'type': 'put',
      'data': {'title': 'نسخهٔ اول', 'body': 'b', 'date': '2026-11-10'},
    });
    final id = created['id']! as int;
    final v1 = created['version']! as int;
    final edited = await rawPush({
      'uid': 'b-edit',
      'collection': 'announcements',
      'type': 'put',
      'id': id,
      'base_version': v1,
      'data': {'title': 'نسخهٔ دستگاه دوم', 'body': 'b', 'date': '2026-11-10'},
    });
    expect(edited['version'], v1 + 1);
    // Device A (this Dart client) still edits from v1 → must NOT overwrite.
    outbox.enqueue({
      'k': 'a-stale',
      'collection': 'announcements',
      'type': 'put',
      'id': id,
      'base_version': v1,
      'data': {'title': 'نسخهٔ دستگاه بومی', 'body': 'b', 'date': '2026-11-10'},
    });
    final r = await client.push();
    expect(r.conflicts, 1, reason: srv.log.toString());
    expect(outbox.stats().total, 0);
    final local = await engine.get('announcements', id);
    expect(local!.data['title'], 'نسخهٔ دستگاه دوم');
    final c = client.review().lastWhere((e) => e.kind == 'conflict');
    expect(c.uid, 'a-stale');
    expect(c.local!['title'], 'نسخهٔ دستگاه بومی');
    expect(c.server!['title'], 'نسخهٔ دستگاه دوم');
    expect(c.serverVersion, v1 + 1);
    expect(c.conflictId, isA<int>());
    // Server did not apply the stale write.
    final p = await srv.json(
      'GET',
      '/api/v1/pull?since=1970-01-01T00:00:00.000Z&collections=announcements',
      token: token,
    );
    final row = ((p['collections']! as Map)['announcements'] as List)
        .cast<Map<String, Object?>>()
        .firstWhere((e) => e['id'] == id);
    expect(row['title'], 'نسخهٔ دستگاه دوم');
  }, skip: skip);

  test('request headers reach the server (version + request id)', () async {
    expect(transport.lastRequestId, isNotNull);
    expect(isUuidV4(transport.lastRequestId!), isTrue);
    expect(PayeshApi.versionHeader, 'X-Payesh-Client');
  }, skip: skip);
}
