// Row 74, wave 4 — native notices against the REAL Gateway (server/gateway.js, runtime role, RLS,
// server-side scope: `announcements` is written by the manager only, read by every role) on a
// real PostgreSQL. Not a mock. Runs when PAYESH_GW_IT=1 (+ PAYESH_PG_ADMIN / PAYESH_PG_RUNTIME);
// CI job `gateway-real` in native-client.yml.
//
// Path under test = the app's default data path: activation (row 121) → GatewaySync.pull into
// SQLite → NoticeBoard (local write + SqliteOutbox) → AutoSync → GatewayTransport.push.
@Tags(['server'])
library;

import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

final env = Platform.environment;
final bool enabled = env['PAYESH_GW_IT'] == '1';
final String node = env['PAYESH_NODE'] ?? 'node';
final String repoRoot =
    env['PAYESH_REPO_ROOT'] ?? Directory('../../../..').absolute.path;

/// Seeded by the harness at NoticeBoard.idBase + 5.
const collide = NoticeBoard.idBase + 5;

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
  Uri get uri => Uri.parse('http://127.0.0.1:$port');

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
        final r = await (await c.getUrl(uri.resolve('/readyz'))).close();
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
  }
}

Future<Map<String, Object?>> harness(
  List<String> args, [
  Map<String, String> extra = const {},
]) async {
  final h = await Process.run(
    node,
    ['test/support/notices_harness.cjs', ...args],
    environment: {
      'PAYESH_REPO_ROOT': repoRoot,
      'PGURL_ADMIN': env['PAYESH_PG_ADMIN'] ?? '',
      ...extra,
    },
  );
  if (h.exitCode != 0) throw StateError('harness: ${h.stderr}');
  return (jsonDecode('${h.stdout}') as Map).cast<String, Object?>();
}

/// Random whose first values are scripted (forces a chosen notice id), then seeded.
final class ScriptedRandom implements Random {
  ScriptedRandom(this.script);
  final List<int> script;
  final Random _rest = Random(74);
  @override
  int nextInt(int max) =>
      script.isNotEmpty ? script.removeAt(0) : _rest.nextInt(max);
  @override
  bool nextBool() => _rest.nextBool();
  @override
  double nextDouble() => _rest.nextDouble();
}

/// One device of the school: its own SQLite (in memory here), outbox, Gateway transport and
/// notice board — the same objects the app wires.
final class Device {
  Device({
    required this.base,
    required this.session,
    required this.deviceId,
    OutboxConfig config = const OutboxConfig(),
    Random? random,
  }) : engine = SqliteEngine.inMemory() {
    outbox = SqliteOutbox(engine.database, config: config);
    transport = GatewayTransport(
      baseUri: base,
      token: () => token,
      deviceId: deviceId,
    );
    sync = GatewaySync(engine: engine, transport: transport);
    board = NoticeBoard(
      engine: engine,
      outbox: outbox,
      role: session.role,
      uid: session.uid,
      random: random,
    );
  }
  final Uri base;
  final SchoolSession session;
  final String deviceId;
  final SqliteEngine engine;
  late final SqliteOutbox outbox;
  late final GatewayTransport transport;
  late final GatewaySync sync;
  late final NoticeBoard board;
  late String token = session.token;

  AutoSync auto(Uri to) {
    final t = to == base
        ? transport
        : GatewayTransport(baseUri: to, token: () => token, deviceId: deviceId);
    final s = GatewaySync(engine: engine, transport: t);
    return AutoSync(
      outbox: outbox,
      push: (ops) => t.push(ops),
      pull: () async {
        await s.pull();
      },
      idleInterval: const Duration(hours: 1),
    );
  }
}

String utcToday() => DateTime.now().toUtc().toIso8601String().substring(0, 10);

void main() {
  late Gw gw;
  late Map<String, Object?> h;
  late SchoolAccessClient access;
  late Device teacher;
  late Device manager;
  late Device parent;
  var negatives = 0;
  var passed = 0;
  var published = 0;
  final rnd = Random(744);
  final managerDevice = SchoolAccessRules.newDeviceId(rnd);

  Future<List<Map<String, Object?>>> serverRows() async {
    final r = await harness(['read'], {'TENANT': '${h['tenant']}'});
    return [
      for (final x in r['rows']! as List<Object?>)
        (x! as Map).cast<String, Object?>(),
    ];
  }

  Future<Map<String, Object?>?> serverRow(int id) async {
    for (final r in await serverRows()) {
      if (r['id'] == id) return r;
    }
    return null;
  }

  Future<Device> activate(String code, String device) async {
    final a = await access.activate(
      cell: gw.uri,
      school: '${h['slug']}',
      code: code,
      deviceId: device,
    );
    return Device(base: gw.uri, session: a.session, deviceId: device);
  }

  /// A forged op that bypasses NoticeBoard (which refuses it locally) — the server must refuse.
  Future<SqliteOutbox> forged(
    Device as,
    String type,
    int id, [
    Map<String, Object?>? data,
  ]) async {
    final dev = Device(
      base: gw.uri,
      session: as.session,
      deviceId: as.deviceId,
      config: const OutboxConfig(maxAttempts: 1),
    );
    dev.outbox.enqueue({
      'collection': 'announcements',
      'type': type,
      'id': id,
      'data': ?data,
      'base_version': 0,
    });
    await dev.outbox.drain(dev.transport.push);
    return dev.outbox;
  }

  setUpAll(() async {
    if (!enabled) return;
    final r = Random.secure();
    final secret = List.generate(
      32,
      (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ).join();
    h = await harness(['setup']);
    gw = Gw(await freePort(), {
      'HOST': '127.0.0.1',
      'PGURL': env['PAYESH_PG_RUNTIME']!,
      'GW_SECRET': secret,
      'GW_QUOTA_MAX': '100000',
      'PAYESH_LOG': '0',
      'GW_INSTANCE': 'gw-74-w4',
    });
    await gw.start();
    access = SchoolAccessClient(directory: gw.uri);
    teacher = await activate(
      '${h['teacher_code']}',
      SchoolAccessRules.newDeviceId(rnd),
    );
    manager = await activate('${h['manager_code']}', managerDevice);
    parent = await activate(
      '${h['parent_code']}',
      SchoolAccessRules.newDeviceId(rnd),
    );
  });

  tearDownAll(() async {
    if (!enabled) return;
    access.close();
    // ignore: avoid_print
    print('NATIVE-WAVE4-IT passed=$passed negative_controls=$negatives');
    await gw.kill();
  });

  final skip = enabled
      ? false
      : 'set PAYESH_GW_IT=1 (+ PAYESH_PG_ADMIN/RUNTIME) for the real Gateway';

  test('W4-IT-01 teacher and parent pull the web notices and read them; neither may write', () async {
    expect(teacher.session.role, 'teacher');
    expect(parent.session.role, 'parent');
    for (final d in [teacher, parent]) {
      await d.sync.pull();
      final l = await d.board.list();
      expect(l.map((n) => n.id), [collide, 1], reason: d.session.role);
      expect(l.last.title, 'آغاز سال تحصیلی');
      expect(l.first.severity, NoticeSeverity.info);
      expect(d.board.canWrite, isFalse);
      await expectLater(
        d.board.publish(title: 't', body: 'b'),
        throwsA(isA<NoticeFailure>()),
      );
    }
    expect(teacher.outbox.list(), isEmpty);
    negatives += 2;
    passed++;
  }, skip: skip);

  test('W4-IT-02 manager publishes offline → queued → online → applied once, version 1', () async {
    expect(manager.session.role, 'manager');
    await manager.sync.pull();
    final res = await manager.board.publish(
      title: ' امتحان ریاضی ',
      body: 'شنبه ساعت ۸',
      severity: NoticeSeverity.important,
    );
    published = res.id;
    expect(published, greaterThanOrEqualTo(NoticeBoard.idBase));
    final dead = Uri.parse('http://127.0.0.1:${await freePort()}');
    final s1 = await manager.auto(dead).runOnce();
    expect(s1.phase, SyncPhase.offline);
    expect(s1.labelFa, 'آفلاین — 1 مورد در صف ارسال');
    expect(await serverRow(published), isNull);
    negatives++;
    manager.outbox.wake();
    final s2 = await manager.auto(gw.uri).runOnce();
    expect(s2.phase, SyncPhase.idle, reason: '${s2.lastError}');
    final row = (await serverRow(published))!;
    expect(row['version'], 1);
    expect(row['data'], {
      'id': published,
      'title': 'امتحان ریاضی',
      'body': 'شنبه ساعت ۸',
      'severity': 'important',
      'date': utcToday(),
      'author_id': 1,
    });
    // the teacher sees it first after a pull
    await teacher.sync.pull();
    final l = await teacher.board.list();
    expect(l.first.id, published);
    expect(l.first.severity, NoticeSeverity.important);
    passed++;
  }, skip: skip);

  test('W4-IT-03 manager edits: version 2, original date kept, teacher sees the edit', () async {
    final before = (await serverRow(1))!;
    expect(before['version'], 1);
    final r = await manager.board.edit(
      id: 1,
      title: 'آغاز سال تحصیلی',
      body: 'کلاس‌ها از یکشنبه',
      severity: NoticeSeverity.info,
    );
    expect(r.action, NoticeAction.edited);
    expect((await manager.outbox.drain(manager.transport.push)).applied, 1);
    final row = (await serverRow(1))!;
    expect(row['version'], 2);
    final d = row['data']! as Map;
    expect(d['date'], '2026-09-20');
    expect(d['body'], 'کلاس‌ها از یکشنبه');
    expect(d['severity'], 'info');
    await teacher.sync.pull();
    final n = (await teacher.board.list()).firstWhere((x) => x.id == 1);
    expect(n.body, 'کلاس‌ها از یکشنبه');
    expect(n.version, 2);
    passed++;
  }, skip: skip);

  test('W4-IT-04 manager deletes: server tombstone; the teacher device drops it on pull', () async {
    await manager.board.delete(published);
    expect(await manager.engine.get('announcements', published), isNull);
    expect((await manager.outbox.drain(manager.transport.push)).applied, 1);
    final row = (await serverRow(published))!;
    expect(row['deleted'], isTrue);
    expect(row['version'], 2);
    expect(
      (await teacher.board.list()).any((n) => n.id == published),
      isTrue,
      reason: 'still there before the pull',
    );
    await teacher.sync.pull();
    expect((await teacher.board.list()).map((n) => n.id), [collide, 1]);
    passed++;
  }, skip: skip);

  test('W4-IT-05 NEG forged teacher publish and delete → role_denied, nothing changes', () async {
    final put = await forged(teacher, 'put', NoticeBoard.idBase + 77, {
      'title': 'جعلی',
      'body': 'x',
      'severity': 'important',
      'date': '2026-11-12',
    });
    expect(put.list().single.lastError, contains('role_denied'));
    expect(await serverRow(NoticeBoard.idBase + 77), isNull);
    final del = await forged(teacher, 'del', 1);
    expect(del.list().single.lastError, contains('role_denied'));
    final one = (await serverRow(1))!;
    expect(one['deleted'], isFalse);
    expect(one['version'], 2);
    negatives += 2;
    passed++;
  }, skip: skip);

  test(
    'W4-IT-06 NEG forged parent edit → role_denied; the notice is unchanged',
    () async {
      final ob = await forged(parent, 'put', 1, {
        'title': 'ویرایش والد',
        'body': 'x',
        'date': '2026-09-20',
      });
      expect(ob.list().single.lastError, contains('role_denied'));
      expect(
        ((await serverRow(1))!['data']! as Map)['title'],
        'آغاز سال تحصیلی',
      );
      negatives++;
      passed++;
    },
    skip: skip,
  );

  test('W4-IT-07 NEG a second manager device with a stale copy: real conflict → review, server kept', () async {
    final stale = Device(
      base: gw.uri,
      session: manager.session,
      deviceId: managerDevice,
    );
    // the stale device pulled before W4-IT-03 → it believes notice 1 is version 1
    await stale.engine.put('announcements', 1, {
      'id': 1,
      'title': 'آغاز سال تحصیلی',
      'body': 'کلاس‌ها از شنبه',
      'severity': 'normal',
      'date': '2026-09-20',
      'author_id': 1,
    }, version: 1);
    await stale.board.edit(
      id: 1,
      title: 'آغاز سال',
      body: 'کلاس‌ها از دوشنبه',
      severity: NoticeSeverity.normal,
    );
    final res = await stale.sync.push(stale.outbox);
    expect(res.conflicts, 1);
    expect(
      stale.sync.review().any((r) => r.kind == 'conflict' && r.id == 1),
      isTrue,
    );
    final row = (await serverRow(1))!;
    expect((row['data']! as Map)['body'], 'کلاس‌ها از یکشنبه');
    expect(row['version'], 2);
    negatives++;
    passed++;
  }, skip: skip);

  test('W4-IT-08 NEG id collision with a notice this device never pulled → conflict, no overwrite', () async {
    final fresh = Device(
      base: gw.uri,
      session: manager.session,
      deviceId: managerDevice,
      random: ScriptedRandom([
        0,
        5,
      ]), // first draw = idBase + 5 (seeded on the server)
    );
    final r = await fresh.board.publish(title: 'تازه', body: 'متن تازه');
    expect(r.id, collide, reason: 'not pulled → no local collision to re-draw');
    final res = await fresh.sync.push(fresh.outbox);
    expect(res.conflicts, 1);
    final row = (await serverRow(collide))!;
    expect((row['data']! as Map)['title'], 'اطلاعیهٔ قبلی');
    expect(row['version'], 1);
    negatives++;
    passed++;
  }, skip: skip);
}
