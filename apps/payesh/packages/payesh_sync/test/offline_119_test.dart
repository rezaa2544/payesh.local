// Row 119 — 20 offline scenarios on the DEFAULT data path of the native app:
// SqliteOutbox / AutoSync / GatewaySync (payesh_sync) → real server/gateway.js → real PostgreSQL
// (RLS, runtime role). Faults are injected on real TCP: a proxy in front of the Gateway (refuse,
// cut mid-request, cut mid-response, blackhole, injected 429/5xx, slow link, cut after N
// responses) and a proxy in front of PostgreSQL (database down). The Gateway process is killed
// and restarted; the "app" is a separate process that is SIGKILLed while its request is on the
// wire. Server truth is read back from the Gateway change feed on a direct (unproxied) port.
//
// PASS for every scenario: no loss · no duplicate · pending survives restart · order kept ·
// automatic sync · conflict kept for review · no cross-school leak · status visible · no storm.
// Runs when PAYESH_OFFLINE_IT=1 (+ PAYESH_PG_ADMIN / PAYESH_PG_RUNTIME); CI job `gateway-real`.
// Not covered here (NOT RUN): real devices/OS power loss [M], TLS front (row 75 tests), real host.
@Tags(['server'])
@Timeout(Duration(minutes: 8))
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:sqlite3/sqlite3.dart';
import 'package:test/test.dart';

final env = Platform.environment;
final bool enabled = env['PAYESH_OFFLINE_IT'] == '1';
final String node = env['PAYESH_NODE'] ?? 'node';
final String repoRoot =
    env['PAYESH_REPO_ROOT'] ?? Directory('../../../..').absolute.path;

enum Mode {
  pass,
  refuse,
  cutMidRequest,
  cutMidResponse,
  blackhole,
  status,
  slow,
  hold,
}

/// Real TCP fault injector (client ⇄ Gateway, or Gateway ⇄ PostgreSQL).
final class FaultProxy {
  FaultProxy._(this._server, this.upstream);
  final ServerSocket _server;
  int upstream;
  Mode _mode = Mode.pass;
  int status = 503;
  int retryAfterSec = 0;
  String errorCode = 'unavailable';
  int cutAfterBytes = 120;
  int cutAfterResponses = -1;
  Duration slowDelay = const Duration(milliseconds: 120);
  int connections = 0;
  int responses = 0;
  int forwardedRequests = 0;
  final arrivals = <DateTime>[];
  final _live = <Socket>{};
  Completer<void> heldResponse = Completer<void>();

  static Future<FaultProxy> start(int upstream) async {
    final s = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final p = FaultProxy._(s, upstream);
    s.listen(p._onClient);
    return p;
  }

  int get port => _server.port;
  Mode get mode => _mode;

  /// Switching mode also breaks every live connection (kept-alive sockets included).
  set mode(Mode m) {
    _mode = m;
    killAll();
  }

  void killAll() {
    for (final s in _live.toList()) {
      s.destroy();
    }
    _live.clear();
  }

  Future<void> close() async {
    killAll();
    await _server.close();
  }

  Future<void> _onClient(Socket client) async {
    connections++;
    arrivals.add(DateTime.now());
    _live.add(client);
    final m = _mode;
    if (m == Mode.refuse) {
      client.destroy();
      return;
    }
    if (m == Mode.blackhole) {
      client.listen((_) {}, onError: (_) {}, onDone: client.destroy);
      return;
    }
    if (m == Mode.status) {
      final buf = BytesBuilder();
      client.listen((d) {
        buf.add(d);
        final txt = latin1.decode(buf.toBytes());
        final he = txt.indexOf('\r\n\r\n');
        if (he < 0) return;
        final cl = RegExp(
          r'content-length:\s*(\d+)',
          caseSensitive: false,
        ).firstMatch(txt.substring(0, he));
        final need = he + 4 + (cl == null ? 0 : int.parse(cl.group(1)!));
        if (buf.length < need) return;
        final body = utf8.encode(
          jsonEncode({
            'ok': false,
            'error': errorCode,
            if (retryAfterSec > 0) 'retry_after_ms': retryAfterSec * 1000,
          }),
        );
        client.add(
          latin1.encode(
            'HTTP/1.1 $status Injected\r\ncontent-type: application/json\r\n'
            '${retryAfterSec > 0 ? 'retry-after: $retryAfterSec\r\n' : ''}'
            'content-length: ${body.length}\r\nconnection: close\r\n\r\n',
          ),
        );
        client.add(body);
        responses++;
        unawaited(client.flush().whenComplete(client.destroy));
      }, onError: (_) {});
      return;
    }
    Socket up;
    try {
      up = await Socket.connect(InternetAddress.loopbackIPv4, upstream);
    } on SocketException {
      client.destroy(); // upstream (Gateway / PostgreSQL) is down
      return;
    }
    _live.add(up);
    var reqBytes = 0;
    var upChain = Future<void>.value();
    var downChain = Future<void>.value();
    void cutBoth() {
      client.destroy();
      up.destroy();
    }

    client.listen(
      (d) {
        reqBytes += d.length;
        if (m == Mode.cutMidRequest && reqBytes > cutAfterBytes) {
          final keep = d.length - (reqBytes - cutAfterBytes);
          if (keep > 0) up.add(d.sublist(0, keep));
          unawaited(up.flush().whenComplete(cutBoth));
          return;
        }
        if (m == Mode.slow) {
          upChain = upChain
              .then((_) => Future<void>.delayed(slowDelay))
              .then((_) => up.add(d));
        } else {
          up.add(d);
        }
      },
      onError: (_) => up.destroy(),
      onDone: () => up.destroy(),
    );
    up.listen(
      (d) {
        final isHead = latin1.decode(d.take(9).toList()) == 'HTTP/1.1 ';
        if (isHead) forwardedRequests++;
        if (m == Mode.cutMidResponse) {
          cutBoth();
          return;
        }
        if (m == Mode.hold) {
          if (!heldResponse.isCompleted) heldResponse.complete();
          return; // the server answered; the client never sees it
        }
        if (isHead) {
          responses++;
          if (cutAfterResponses >= 0 && responses > cutAfterResponses) {
            _mode = Mode.refuse;
            cutBoth();
            return;
          }
        }
        if (m == Mode.slow) {
          downChain = downChain
              .then((_) => Future<void>.delayed(slowDelay))
              .then((_) => client.add(d));
        } else {
          client.add(d);
        }
      },
      onError: (_) => client.destroy(),
      onDone: () => client.destroy(),
    );
  }
}

Future<int> freePort() async {
  final s = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  final p = s.port;
  await s.close();
  return p;
}

final class Gw {
  Gw(this.port, this.environment);
  final int port;
  final Map<String, String> environment;
  final log = StringBuffer();
  Process? _p;

  Future<void> start() async {
    _p = await Process.start(
      node,
      ['server/gateway.js'],
      workingDirectory: repoRoot,
      environment: {...environment, 'PORT': '$port'},
    );
    _p!.stdout.transform(utf8.decoder).listen(log.write);
    _p!.stderr.transform(utf8.decoder).listen(log.write);
    final c = HttpClient();
    var ready = false;
    for (var i = 0; i < 150 && !ready; i++) {
      try {
        final r = await (await c.getUrl(
          Uri.parse('http://127.0.0.1:$port/readyz'),
        )).close();
        await r.drain<void>();
        ready = r.statusCode == 200;
      } on SocketException {
        // not up yet
      }
      if (!ready) await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    c.close(force: true);
    if (!ready) throw StateError('gateway /readyz never 200:\n$log');
  }

  Future<void> kill() async {
    _p?.kill(ProcessSignal.sigkill);
    await _p?.exitCode;
    _p = null;
  }
}

Future<int> httpStatus(Uri u) async {
  final c = HttpClient();
  try {
    final r = await (await c.getUrl(u)).close();
    await r.drain<void>();
    return r.statusCode;
  } on SocketException {
    return -1; // process not listening
  } finally {
    c.close(force: true);
  }
}

Future<void> until(
  bool Function() f, {
  Duration max = const Duration(seconds: 15),
  String what = 'condition',
}) async {
  final end = DateTime.now().add(max);
  while (!f()) {
    if (DateTime.now().isAfter(end)) {
      throw StateError('timeout waiting for $what');
    }
    await Future<void>.delayed(const Duration(milliseconds: 25));
  }
}

/// Tally printed at the end (also the raw evidence line).
final tally = <String, int>{
  'scenarios': 0,
  'data_loss': 0,
  'duplicate': 0,
  'order_violations': 0,
  'cross_tenant': 0,
};

void main() {
  late Map<String, String> tok;
  late FaultProxy net; // client ⇄ Gateway
  late FaultProxy db; // Gateway ⇄ PostgreSQL
  late Gw gw;
  late Uri viaNet;
  late Uri direct;
  final tmp = Directory.systemTemp.createTempSync('o119-');

  setUpAll(() async {
    if (!enabled) return;
    final rnd = Random.secure();
    final secret = List.generate(
      32,
      (_) => rnd.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ).join();
    final h = await Process.run(
      node,
      ['test/support/offline_119_harness.cjs'],
      environment: {
        'PAYESH_REPO_ROOT': repoRoot,
        'PGURL_ADMIN': env['PAYESH_PG_ADMIN']!,
        'SECRET': secret,
      },
    );
    expect(h.exitCode, 0, reason: '${h.stderr}');
    tok = (jsonDecode('${h.stdout}') as Map).cast<String, String>();
    final runtime = Uri.parse(env['PAYESH_PG_RUNTIME']!);
    db = await FaultProxy.start(runtime.port == 0 ? 5432 : runtime.port);
    final gwPort = await freePort();
    gw = Gw(gwPort, {
      'HOST': '127.0.0.1',
      'PGURL': runtime.replace(port: db.port).toString(),
      'GW_SECRET': secret,
      'GW_INSTANCE': 'gw-offline-119',
      'GW_QUOTA_MAX': '100000',
      'PAYESH_LOG': '0',
    });
    await gw.start();
    net = await FaultProxy.start(gwPort);
    viaNet = Uri.parse('http://127.0.0.1:${net.port}');
    direct = Uri.parse('http://127.0.0.1:$gwPort');
  });

  tearDownAll(() async {
    if (!enabled) return;
    // ignore: avoid_print
    print(
      'OFFLINE-119 scenarios=${tally['scenarios']} data_loss=${tally['data_loss']} '
      'duplicate=${tally['duplicate']} order_violations=${tally['order_violations']} '
      'cross_tenant=${tally['cross_tenant']}',
    );
    await net.close();
    await gw.kill();
    await db.close();
    tmp.deleteSync(recursive: true);
  });

  final skip = enabled
      ? false
      : 'set PAYESH_OFFLINE_IT=1 (+ PAYESH_PG_ADMIN/RUNTIME) for the real Gateway';

  HttpClient noReuse() =>
      HttpClient()..idleTimeout = const Duration(milliseconds: 1);

  GatewayTransport via(
    Uri base,
    String token, {
    String device = 'dev-1',
    Duration timeout = const Duration(seconds: 3),
  }) => GatewayTransport(
    baseUri: base,
    token: () => token,
    deviceId: device,
    client: noReuse(),
    timeout: timeout,
  );

  const fast = OutboxConfig(
    leaseMs: 1500,
    maxAttempts: 3,
    baseBackoffMs: 200,
    maxBackoffMs: 1000,
    jitter: 0,
  );

  Map<String, Object?> op(
    int id, {
    String col = 'announcements',
    Map<String, Object?>? data,
    int base = 0,
    String? k,
  }) => {
    'k': k ?? 'o119-$id',
    'collection': col,
    'type': 'put',
    'id': id,
    'base_version': base,
    'data': data ?? {'title': 'o119 $id'},
  };

  Future<List<GatewayRow>> feed(String token) async {
    final t = via(
      direct,
      token,
      device: 'audit',
      timeout: const Duration(seconds: 10),
    );
    final rows = <GatewayRow>[];
    var since = 0;
    for (;;) {
      final p = await t.pull(sinceSeq: since, limit: 500);
      rows.addAll(p.rows);
      if (!p.more) break;
      since = p.nextSeq;
    }
    t.close();
    return rows;
  }

  /// Exactly-once + order on the server for [ids] (enqueued in this order).
  Future<String> verify(
    List<int> ids, {
    String token = '',
    String col = 'announcements',
    int expectVersion = 1,
  }) async {
    final rows = (await feed(token.isEmpty ? tok['A1']! : token))
        .where((r) => r.collection == col && ids.contains(r.id))
        .toList();
    final seen = <int, List<GatewayRow>>{};
    for (final r in rows) {
      seen.putIfAbsent(r.id, () => []).add(r);
    }
    final loss = ids.where((i) => !seen.containsKey(i)).length;
    // the feed is append-only: a second application of the same op shows up as an extra
    // version (or the same version twice) — both count as a duplicate
    var dup = 0;
    for (final l in seen.values) {
      final versions = l.map((r) => r.version).toList();
      dup += versions.length - versions.toSet().length;
      if (versions.reduce(max) != expectVersion) dup++;
    }
    var order = 0;
    for (var i = 1; i < ids.length; i++) {
      final a = seen[ids[i - 1]], b = seen[ids[i]];
      if (a != null && b != null && a.first.seq > b.first.seq) order++;
    }
    tally['scenarios'] = tally['scenarios']! + 1;
    tally['data_loss'] = tally['data_loss']! + loss;
    tally['duplicate'] = tally['duplicate']! + dup;
    tally['order_violations'] = tally['order_violations']! + order;
    expect(loss, 0, reason: 'data_loss');
    expect(dup, 0, reason: 'duplicate (count or version != $expectVersion)');
    expect(order, 0, reason: 'order');
    return 'data_loss=0 duplicate=0 order=ok rows=${ids.length}';
  }

  List<int> range(int from, int n) => [for (var i = 0; i < n; i++) from + i];

  void enqueueAll(SqliteOutbox ob, List<int> ids) {
    for (final i in ids) {
      expect(ob.enqueue(op(i)).ok, isTrue);
    }
  }

  void note(String id, String detail) =>
      // ignore: avoid_print
      print('PASS  $id  $detail');

  // ── shared state between consecutive scenarios ─────────────────────────────
  late SqliteOutbox ob1;
  late AutoSync auto1;
  late final t1 = via(viaNet, tok['A1']!); // lazy: first use after setUpAll

  test('O119-S01 internet lost BEFORE send: nothing reaches the server, ops kept, status offline', () async {
    net.mode = Mode.refuse;
    ob1 = SqliteOutbox.inMemory(config: fast);
    auto1 = AutoSync(
      outbox: ob1,
      push: t1.push,
      minGap: const Duration(milliseconds: 100),
      spread: const Duration(milliseconds: 200),
      idleInterval: const Duration(seconds: 30),
    )..start();
    enqueueAll(ob1, range(1101, 5));
    auto1.notifyEnqueued();
    await until(
      () => auto1.cycles >= 2 && auto1.current.phase == SyncPhase.offline,
      what: 'offline',
    );
    expect(ob1.stats().pending + ob1.stats().inflight, 5);
    expect(auto1.current.waiting, 5);
    expect(auto1.current.labelFa, contains('آفلاین'));
    final onServer = (await feed(tok['A1']!))
        .where((r) => r.id >= 1101 && r.id <= 1105);
    expect(onServer, isEmpty);
    tally['scenarios'] = tally['scenarios']! + 1;
    note(
      'O119-S01',
      'refused=${net.connections} server_rows=0 status="${auto1.current.labelFa}"',
    );
  }, skip: skip);

  test('O119-S02 internet RETURNS: automatic send after notifyOnline, exactly once, status idle', () async {
    net.mode = Mode.pass;
    auto1.notifyOnline();
    await until(
      () => ob1.stats().active == 0 && auto1.current.phase == SyncPhase.idle,
      what: 'idle',
    );
    expect(auto1.current.labelFa, 'همگام');
    note('O119-S02', await verify(range(1101, 5)));
  }, skip: skip);

  test('O119-S03 internet lost DURING send (cut mid-request): no partial write, then exactly once', () async {
    await auto1.stop();
    net
      ..cutAfterBytes = 90
      ..mode = Mode.cutMidRequest;
    final ob = SqliteOutbox.inMemory(config: fast);
    enqueueAll(ob, range(1201, 5));
    final r = await ob.drain(t1.push);
    expect(r.stopped, isNotNull);
    expect(ob.stats().pending, 5);
    expect(
      (await feed(tok['A1']!)).where((x) => x.id >= 1201 && x.id <= 1205),
      isEmpty,
    );
    net.mode = Mode.pass;
    final r2 = await ob.drain(
      t1.push,
      now: DateTime.now().millisecondsSinceEpoch + 5000,
    );
    expect(r2.applied, 5);
    note('O119-S03', 'first=${r.stopped} ${await verify(range(1201, 5))}');
  }, skip: skip);

  test('O119-S04 internet lost AFTER send (server applied, verdict lost): retry is a duplicate, not a second write', () async {
    net.mode = Mode.cutMidResponse;
    final ob = SqliteOutbox.inMemory(config: fast);
    enqueueAll(ob, range(1301, 5));
    final r = await ob.drain(t1.push);
    expect(r.stopped, isNotNull);
    expect(ob.stats().pending, 5, reason: 'no verdict → ops stay queued');
    expect(
      (await feed(tok['A1']!))
          .where((x) => x.id >= 1301 && x.id <= 1305)
          .length,
      5,
      reason: 'the server did apply the batch',
    );
    net.mode = Mode.pass;
    final dups = <bool>[];
    await ob.drain(
      t1.push,
      now: DateTime.now().millisecondsSinceEpoch + 5000,
      onApplied: (o, v) => dups.add(v['duplicate'] == true),
    );
    expect(dups, everyElement(isTrue));
    expect(dups.length, 5);
    note(
      'O119-S04',
      'retry_verdicts=duplicate×5 ${await verify(range(1301, 5))}',
    );
  }, skip: skip);

  test('O119-S05 Gateway DOWN (process killed) then restarted: ops kept, then exactly once', () async {
    await gw.kill();
    final ob = SqliteOutbox.inMemory(config: fast);
    enqueueAll(ob, range(1401, 5));
    final r = await ob.drain(t1.push);
    expect(r.stopped, 'network');
    expect(ob.stats().pending, 5);
    expect(ob.stats().blocked, 0);
    await gw.start();
    final r2 = await ob.drain(
      t1.push,
      now: DateTime.now().millisecondsSinceEpoch + 5000,
    );
    expect(r2.applied, 5);
    note('O119-S05', 'down=${r.stopped} ${await verify(range(1401, 5))}');
  }, skip: skip);

  test('O119-S06 DATABASE down: readyz 503, 5xx are transient — never blocked after > maxAttempts; DB back → exactly once', () async {
    db.mode = Mode.refuse;
    final ob = SqliteOutbox.inMemory(config: fast);
    enqueueAll(ob, range(1501, 5));
    final now = DateTime.now().millisecondsSinceEpoch;
    final reasons = <String?>[];
    for (var i = 0; i < 5; i++) {
      final r = await ob.drain(t1.push, now: now + i * 10000);
      reasons.add(r.stopped);
    }
    expect(
      await httpStatus(direct.resolve('/readyz')),
      503,
      reason: 'gateway must survive a DB outage:\n${gw.log}',
    );
    expect(ob.stats().blocked, 0, reason: 'transient failures must not block');
    expect(ob.stats().pending, 5);
    expect(ob.list().first.attempts, 5, reason: 'more than maxAttempts=3');
    db.mode = Mode.pass;
    var applied = 0;
    for (var i = 0; i < 20 && applied < 5; i++) {
      final r = await ob.drain(t1.push, now: now + 100000 + i * 10000);
      applied += r.applied;
      if (applied < 5) {
        await Future<void>.delayed(const Duration(milliseconds: 200));
      }
    }
    expect(applied, 5, reason: gw.log.toString());
    note(
      'O119-S06',
      'stopped=${reasons.toSet()} attempts=5>maxAttempts blocked=0 ${await verify(range(1501, 5))}',
    );
  }, skip: skip);

  test('O119-S07 HTTP 429 + Retry-After: client waits at least Retry-After, then exactly once', () async {
    net
      ..status = 429
      ..retryAfterSec = 2
      ..errorCode = 'rate_limited'
      ..mode = Mode.status;
    final ob = SqliteOutbox.inMemory(config: fast);
    enqueueAll(ob, range(1601, 3));
    final t = DateTime.now().millisecondsSinceEpoch;
    final r = await ob.drain(t1.push, now: t);
    expect(r.stopped, isNotNull);
    final o = ob.list().first;
    expect(
      o.nextAt,
      greaterThanOrEqualTo(t + 2000),
      reason: 'Retry-After honoured',
    );
    expect(o.state, OpState.pending);
    expect(
      ob.claim(10, t + 1500),
      isEmpty,
      reason: 'nothing sent before Retry-After',
    );
    net.mode = Mode.pass;
    final r2 = await ob.drain(t1.push, now: t + 2100);
    expect(r2.applied, 3);
    note(
      'O119-S07',
      'stopped=${r.stopped} next_at≥+2000ms ${await verify(range(1601, 3))}',
    );
  }, skip: skip);

  test('O119-S08 HTTP 500 / 502 / 503: transient backoff, never blocked, then exactly once', () async {
    final ob = SqliteOutbox.inMemory(config: fast);
    enqueueAll(ob, range(1701, 3));
    final t = DateTime.now().millisecondsSinceEpoch;
    var i = 0;
    for (final s in [500, 502, 503, 500]) {
      net
        ..status = s
        ..retryAfterSec = 0
        ..errorCode = 'server_error'
        ..mode = Mode.status;
      final r = await ob.drain(t1.push, now: t + (i++) * 10000);
      expect(r.failed, 3);
    }
    expect(ob.stats().blocked, 0);
    expect(ob.list().first.attempts, 4);
    net.mode = Mode.pass;
    expect((await ob.drain(t1.push, now: t + 100000)).applied, 3);
    note(
      'O119-S08',
      '4×5xx attempts=4>maxAttempts blocked=0 ${await verify(range(1701, 3))}',
    );
  }, skip: skip);

  test(
    'O119-S09 TIMEOUT (blackhole link): transient, ops kept, then exactly once',
    () async {
      net.mode = Mode.blackhole;
      final t = via(
        viaNet,
        tok['A1']!,
        timeout: const Duration(milliseconds: 1200),
      );
      final ob = SqliteOutbox.inMemory(config: fast);
      enqueueAll(ob, range(1801, 3));
      final r = await ob.drain(t.push);
      expect(r.stopped, isNotNull);
      expect(ob.list().first.lastError, contains('timeout'));
      expect(ob.stats().pending, 3);
      net.mode = Mode.pass;
      expect(
        (await ob.drain(
          t.push,
          now: DateTime.now().millisecondsSinceEpoch + 5000,
        )).applied,
        3,
      );
      t.close();
      note('O119-S09', 'error=timeout ${await verify(range(1801, 3))}');
    },
    skip: skip,
  );

  test('O119-S10 CONGESTION (slow link, 300 ops): batched by batchLimit, no duplicate, order kept', () async {
    net
      ..slowDelay = const Duration(milliseconds: 60)
      ..mode = Mode.slow;
    final t = via(viaNet, tok['A1']!, timeout: const Duration(seconds: 20));
    final ob = SqliteOutbox.inMemory(config: fast);
    final ids = range(10001, 300);
    enqueueAll(ob, ids);
    final r = await ob.drain(t.push);
    expect(r.applied, 300);
    expect(r.batches, 3, reason: 'batchLimit=120 → 3 requests, not 300');
    net.mode = Mode.pass;
    t.close();
    note('O119-S10', 'batches=${r.batches} ${await verify(ids)}');
  }, skip: skip);

  test('O119-S11 APP RESTART mid-send: separate app process SIGKILLed while its request is on the wire; reopen file → exactly once', () async {
    final file = '${tmp.path}/outbox-restart.db';
    net
      ..heldResponse = Completer<void>()
      ..mode = Mode.hold;
    final child = await Process.start(Platform.resolvedExecutable, [
      'run',
      'test/support/offline_119_client.dart',
      file,
      viaNet.toString(),
      tok['A1']!,
      '10',
      '1901',
    ]);
    final out = StringBuffer();
    child.stdout.transform(utf8.decoder).listen(out.write);
    child.stderr.transform(utf8.decoder).listen(out.write);
    await net.heldResponse.future.timeout(const Duration(seconds: 120));
    child.kill(ProcessSignal.sigkill);
    await child.exitCode;
    expect(out.toString(), contains('READY 10'));
    expect(out.toString(), isNot(contains('DRAINED')));
    net.mode = Mode.pass;
    final ob = SqliteOutbox(sqlite3.open(file), config: fast);
    expect(ob.stats().inflight, 10, reason: 'leased ops survived the kill');
    final later = DateTime.now().millisecondsSinceEpoch + 5000;
    expect(ob.recover(later), 10);
    final dups = <bool>[];
    final r = await ob.drain(
      t1.push,
      now: later,
      onApplied: (o, v) => dups.add(v['duplicate'] == true),
    );
    expect(r.applied, 10);
    expect(
      dups,
      everyElement(isTrue),
      reason: 'server already had them — no second write',
    );
    ob.database.close();
    note(
      'O119-S11',
      'killed=SIGKILL recovered=10 ${await verify(range(1901, 10))}',
    );
  }, skip: skip);

  test('O119-S12 restart while OFFLINE: queue file closed and reopened, pending intact, then exactly once', () async {
    final file = '${tmp.path}/outbox-offline.db';
    net.mode = Mode.refuse;
    var ob = SqliteOutbox(sqlite3.open(file), config: fast);
    enqueueAll(ob, range(2001, 5));
    await ob.drain(t1.push);
    ob.database.close(); // app closed
    ob = SqliteOutbox(sqlite3.open(file), config: fast);
    expect(ob.stats().pending, 5);
    net.mode = Mode.pass;
    expect(
      (await ob.drain(
        t1.push,
        now: DateTime.now().millisecondsSinceEpoch + 5000,
      )).applied,
      5,
    );
    ob.database.close();
    note('O119-S12', 'reopened pending=5 ${await verify(range(2001, 5))}');
  }, skip: skip);

  test('O119-S13 AUTOMATIC queue run: enqueue only — AutoSync sends without any manual call; status stream shows it', () async {
    final ob = SqliteOutbox.inMemory(config: fast);
    final a = AutoSync(
      outbox: ob,
      push: t1.push,
      minGap: const Duration(milliseconds: 100),
      idleInterval: const Duration(seconds: 30),
    );
    final phases = <SyncPhase>[];
    final sub = a.status.listen((s) => phases.add(s.phase));
    a.start();
    await until(() => a.current.phase == SyncPhase.idle, what: 'idle');
    enqueueAll(ob, range(2101, 4));
    a.notifyEnqueued();
    await until(
      () => ob.stats().active == 0 && a.current.phase == SyncPhase.idle,
      what: 'auto drain',
    );
    expect(
      phases,
      containsAllInOrder([SyncPhase.queued, SyncPhase.syncing, SyncPhase.idle]),
    );
    await sub.cancel();
    await a.stop();
    note(
      'O119-S13',
      'phases=${phases.map((p) => p.name).toSet()} ${await verify(range(2101, 4))}',
    );
  }, skip: skip);

  test('O119-S14 RETRY of an already executed op (same k re-queued): server answers duplicate, version stays 1', () async {
    final ob = SqliteOutbox.inMemory(config: fast);
    enqueueAll(ob, range(1101, 5)); // same keys as S01/S02, already applied
    final dups = <bool>[];
    final r = await ob.drain(
      t1.push,
      onApplied: (o, v) => dups.add(v['duplicate'] == true),
    );
    expect(r.applied, 5);
    expect(dups, everyElement(isTrue));
    note('O119-S14', 'duplicate×5 ${await verify(range(1101, 5))}');
  }, skip: skip);

  test('O119-S15 DEPENDENT ORDER: a later op (references class) never overtakes the earlier op in backoff', () async {
    final ob = SqliteOutbox.inMemory(
      config: const OutboxConfig(
        baseBackoffMs: 1000,
        maxBackoffMs: 4000,
        jitter: 0,
      ),
    );
    net.mode = Mode.refuse;
    ob.enqueue(op(2201, col: 'classes', data: {'name': 'دهم ب'}));
    final t = DateTime.now().millisecondsSinceEpoch;
    await ob.drain(t1.push, now: t);
    ob.enqueue(op(2202, data: {'title': 'برنامهٔ کلاس', 'class_id': 2201}));
    net.mode = Mode.pass;
    final early = await ob.drain(t1.push, now: t + 100);
    expect(early.claimed, 0, reason: 'FIFO barrier: 2202 must wait for 2201');
    expect((await feed(tok['A1']!)).where((x) => x.id == 2202), isEmpty);
    final r = await ob.drain(t1.push, now: t + 1100);
    expect(r.applied, 2);
    final rows = await feed(tok['A1']!);
    final a = rows.firstWhere((x) => x.id == 2201),
        b = rows.firstWhere((x) => x.id == 2202);
    expect(a.seq, lessThan(b.seq));
    tally['scenarios'] = tally['scenarios']! + 1;
    note(
      'O119-S15',
      'early_claimed=0 seq(class)=${a.seq} < seq(dependent)=${b.seq}',
    );
  }, skip: skip);

  test('O119-S16 TWO-DEVICE conflict: second writer gets a conflict, its edit is kept for review (and a later queued edit superseded), server keeps v2', () async {
    final seed = SqliteOutbox.inMemory(config: fast)
      ..enqueue(op(2301, data: {'title': 'اصل'}));
    await seed.drain(t1.push);
    final e1 = SqliteEngine.inMemory(), e2 = SqliteEngine.inMemory();
    final ta = via(viaNet, tok['A1']!),
        tb = via(viaNet, tok['A2']!, device: 'dev-2');
    final s1 = GatewaySync(engine: e1, transport: ta),
        s2 = GatewaySync(engine: e2, transport: tb);
    await s1.pull();
    await s2.pull();
    final o1 = SqliteOutbox.inMemory(
      config: fast,
    )..enqueue(op(2301, k: 'c-1', base: 1, data: {'title': 'ویرایش دستگاه ۱'}));
    final o2 = SqliteOutbox.inMemory(config: fast)
      ..enqueue(op(2301, k: 'c-2', base: 1, data: {'title': 'ویرایش دستگاه ۲'}))
      ..enqueue(
        op(2301, k: 'c-3', base: 1, data: {'title': 'ویرایش دوم دستگاه ۲'}),
      );
    expect((await s1.push(o1)).applied, 1);
    final r2 = await s2.push(o2);
    expect(r2.conflicts, 2, reason: 'both device-2 edits were based on v1');
    expect(o2.stats().total, 0, reason: 'nothing left to send blind');
    final rev = s2.review();
    expect(rev.map((x) => x.kind), ['conflict', 'superseded']);
    expect(rev.first.local!['title'], 'ویرایش دستگاه ۲');
    expect(rev.first.serverVersion, 2);
    await s2.pull();
    expect(
      (await e2.get('announcements', 2301))!.data['title'],
      'ویرایش دستگاه ۱',
    );
    ta.close();
    tb.close();
    e1.close();
    e2.close();
    note(
      'O119-S16',
      'review=${rev.map((x) => x.kind).toList()} ${await verify([2301], expectVersion: 2)}',
    );
  }, skip: skip);

  test('O119-S17 CROSS-SCHOOL: school B never sees school A rows; B writing the same ids does not touch A', () async {
    final tbb = via(viaNet, tok['B']!, device: 'dev-b');
    final ob = SqliteOutbox.inMemory(config: fast)
      ..enqueue(op(2301, k: 'b-2301', data: {'title': 'مدرسهٔ B'}));
    expect((await ob.drain(tbb.push)).applied, 1);
    final bRows = await feed(tok['B']!);
    final aIds = (await feed(tok['A1']!)).map((r) => r.id).toSet();
    final leak = bRows.where((r) => r.id != 2301 && aIds.contains(r.id)).length;
    expect(bRows.where((r) => r.id == 2301).single.data!['title'], 'مدرسهٔ B');
    expect(leak, 0);
    tally['cross_tenant'] = tally['cross_tenant']! + leak;
    tbb.close();
    note(
      'O119-S17',
      'b_rows=${bRows.length} leaked_a_rows=0 a_rows=${aIds.length} ${await verify([2301], expectVersion: 2)}',
    );
  }, skip: skip);

  test('O119-S18 SENSITIVE DATA authorization: parent pulls only own child grades; forbidden write → visible "attention", bounded retries', () async {
    final m = SqliteOutbox.inMemory(config: fast)
      ..enqueue(
        op(
          2401,
          col: 'parent_links',
          data: {'parent_id': 9001, 'student_id': 501},
        ),
      )
      ..enqueue(op(2402, col: 'grades', data: {'student_id': 501, 'score': 18}))
      ..enqueue(
        op(2403, col: 'grades', data: {'student_id': 502, 'score': 12}),
      );
    expect((await m.drain(t1.push)).applied, 3);
    final pRows = await feed(tok['P']!);
    final grades = pRows
        .where((r) => r.collection == 'grades')
        .map((r) => r.id)
        .toList();
    expect(grades, [2402], reason: 'only the linked child (501)');
    final before = net.connections;
    final tp = via(viaNet, tok['P']!, device: 'dev-p');
    final po = SqliteOutbox.inMemory(
      config: fast,
    )..enqueue(op(2404, col: 'grades', data: {'student_id': 501, 'score': 20}));
    final a = AutoSync(
      outbox: po,
      push: tp.push,
      minGap: const Duration(milliseconds: 100),
      idleInterval: const Duration(seconds: 30),
    )..start();
    await until(
      () => a.current.phase == SyncPhase.attention,
      what: 'attention',
    );
    await Future<void>.delayed(const Duration(seconds: 2));
    final used = net.connections - before;
    expect(
      used,
      lessThanOrEqualTo(fast.maxAttempts),
      reason: 'no retry storm on a 403',
    );
    expect(po.stats().blocked, 1, reason: 'kept on the device, not dropped');
    expect(a.current.labelFa, contains('بررسی'));
    expect((await feed(tok['A1']!)).where((r) => r.id == 2404), isEmpty);
    await a.stop();
    tp.close();
    tally['scenarios'] = tally['scenarios']! + 1;
    note(
      'O119-S18',
      'parent_grades=$grades forbidden_requests=$used status="${a.current.labelFa}"',
    );
  }, skip: skip);

  test('O119-S19 connection LOST AGAIN mid-sync (after 2 of 6 batches): acked part stays acked, rest resent, exactly once, order kept', () async {
    final ob = SqliteOutbox.inMemory(
      config: const OutboxConfig(
        leaseMs: 1500,
        batchLimit: 25,
        jitter: 0,
        baseBackoffMs: 200,
      ),
    );
    final ids = range(20001, 150);
    enqueueAll(ob, ids);
    net
      ..responses = 0
      ..cutAfterResponses = 2
      ..mode = Mode.pass;
    final r = await ob.drain(t1.push);
    net.cutAfterResponses = -1;
    expect(r.applied, 50);
    expect(r.stopped, isNotNull);
    expect(ob.stats().active, 100);
    net.mode = Mode.pass;
    final dups = <bool>[];
    final r2 = await ob.drain(
      t1.push,
      now: DateTime.now().millisecondsSinceEpoch + 5000,
      onApplied: (o, v) => dups.add(v['duplicate'] == true),
    );
    expect(r2.applied, 100);
    expect(
      dups.where((d) => d).length,
      25,
      reason: 'the batch whose verdict was lost',
    );
    note(
      'O119-S19',
      'first_applied=50 resent=100 (dup_verdicts=25) ${await verify(ids)}',
    );
  }, skip: skip);

  test('O119-S20 NO RETRY STORM: 8 devices through an outage — bounded attempts; on return arrivals are spread; all exactly once', () async {
    net.mode = Mode.refuse;
    final devices = <(SqliteOutbox, AutoSync, GatewayTransport)>[];
    final all = <int>[];
    for (var d = 0; d < 8; d++) {
      final t = via(viaNet, tok['A1']!, device: 'storm-$d');
      final ob = SqliteOutbox.inMemory(
        config: const OutboxConfig(
          baseBackoffMs: 400,
          maxBackoffMs: 1600,
          jitter: 0.5,
          maxAttempts: 3,
        ),
      );
      final ids = range(30001 + d * 10, 3);
      all.addAll(ids);
      enqueueAll(ob, ids);
      final a = AutoSync(
        outbox: ob,
        push: t.push,
        minGap: const Duration(milliseconds: 300),
        spread: const Duration(milliseconds: 1500),
        idleInterval: const Duration(seconds: 60),
      )..start();
      devices.add((ob, a, t));
    }
    final c0 = net.connections;
    await Future<void>.delayed(const Duration(seconds: 5));
    final during = net.connections - c0;
    expect(
      during,
      lessThanOrEqualTo(8 * 8),
      reason: 'a tight loop would be hundreds',
    );
    for (final (ob, a, _) in devices) {
      expect(a.current.phase, SyncPhase.offline);
      expect(ob.stats().blocked, 0, reason: 'outage must not block');
      expect(a.current.waiting, 3);
    }
    net.mode = Mode.pass;
    final mark = net.arrivals.length;
    for (final (_, a, _) in devices) {
      a.notifyOnline();
    }
    await until(
      () => devices.every((d) => d.$1.stats().active == 0),
      what: 'all devices drained',
    );
    final arr = net.arrivals.sublist(mark);
    final spreadMs = arr.last.difference(arr.first).inMilliseconds;
    // on return: exactly one request per device (3 ops in one batch) — no retry burst.
    // The jitter spread itself is proven deterministically in auto_sync_test.dart
    // (end-to-end timing here is dominated by backoff jitter + minGap; recorded, not gated).
    expect(
      arr.length,
      8,
      reason: 'one request per device after the network returns',
    );
    for (final (_, a, t) in devices) {
      await a.stop();
      t.close();
    }
    // order is a per-device guarantee (each device has its own queue); loss/duplicates are
    // checked for every op of every device
    var last = '';
    for (var d = 0; d < 8; d++) {
      last = await verify(all.sublist(d * 3, d * 3 + 3));
    }
    tally['scenarios'] =
        tally['scenarios']! - 7; // 8 verify() calls = one scenario
    note(
      'O119-S20',
      'attempts_during_5s_outage=$during (8 devices) return_spread=${spreadMs}ms '
          'per_device: $last ×8',
    );
  }, skip: skip);
}
