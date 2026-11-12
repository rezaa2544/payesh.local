// Row 74, wave 5 — native parents pages against the REAL Gateway (server/gateway.js, runtime role,
// RLS, server-side scope: a parent pulls only the linked children's rows and writes only
// `leaves` of those children, always `pending`) on a real PostgreSQL. Not a mock. Runs when
// PAYESH_GW_IT=1 (+ PAYESH_PG_ADMIN / PAYESH_PG_RUNTIME); CI job `gateway-real` in
// native-client.yml.
//
// Path under test = the app's default data path: activation (row 121) → GatewaySync.pull into
// SQLite → FamilyBook (SqliteOutbox + local write) → AutoSync → GatewayTransport.push.
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
    ['test/support/family_harness.cjs', ...args],
    environment: {
      'PAYESH_REPO_ROOT': repoRoot,
      'PGURL_ADMIN': env['PAYESH_PG_ADMIN'] ?? '',
      ...extra,
    },
  );
  if (h.exitCode != 0) throw StateError('harness: ${h.stderr}');
  return (jsonDecode('${h.stdout}') as Map).cast<String, Object?>();
}

/// One device of the school: its own SQLite (in memory here), outbox, Gateway transport and
/// parents book — the same objects the app wires.
final class Device {
  Device({
    required this.base,
    required this.session,
    required this.deviceId,
    OutboxConfig config = const OutboxConfig(),
  }) : engine = SqliteEngine.inMemory() {
    outbox = SqliteOutbox(engine.database, config: config);
    transport = GatewayTransport(
      baseUri: base,
      token: () => token,
      deviceId: deviceId,
    );
    sync = GatewaySync(engine: engine, transport: transport);
    family = FamilyBook(
      engine: engine,
      outbox: outbox,
      role: session.role,
      uid: session.uid,
    );
  }
  final Uri base;
  final SchoolSession session;
  final String deviceId;
  final SqliteEngine engine;
  late final SqliteOutbox outbox;
  late final GatewayTransport transport;
  late final GatewaySync sync;
  late final FamilyBook family;
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
  late Device parent;
  late Device manager;
  late Device teacher;
  var negatives = 0;
  var passed = 0;
  var requested = 0;
  final rnd = Random(745);

  Future<List<Map<String, Object?>>> serverRows([
    String collection = 'leaves',
  ]) async {
    final r = await harness(
      ['read'],
      {'TENANT': '${h['tenant']}', 'COLLECTION': collection},
    );
    return [
      for (final x in r['rows']! as List<Object?>)
        (x! as Map).cast<String, Object?>(),
    ];
  }

  Future<Map<String, Object?>?> serverRow(int id, [String c = 'leaves']) async {
    for (final r in await serverRows(c)) {
      if (r['id'] == id) return r;
    }
    return null;
  }

  Future<Device> activate(String code) async {
    final device = SchoolAccessRules.newDeviceId(rnd);
    final a = await access.activate(
      cell: gw.uri,
      school: '${h['slug']}',
      code: code,
      deviceId: device,
    );
    return Device(base: gw.uri, session: a.session, deviceId: device);
  }

  /// A forged op that bypasses FamilyBook (which refuses it locally) — the server must refuse.
  Future<SqliteOutbox> forged(
    Device as,
    String collection,
    int id,
    Map<String, Object?> data,
  ) async {
    final dev = Device(
      base: gw.uri,
      session: as.session,
      deviceId: as.deviceId,
      config: const OutboxConfig(maxAttempts: 1),
    );
    dev.outbox.enqueue({
      'collection': collection,
      'type': 'put',
      'id': id,
      'data': data,
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
      'GW_INSTANCE': 'gw-74-w5',
    });
    await gw.start();
    access = SchoolAccessClient(directory: gw.uri);
    parent = await activate('${h['parent_code']}');
    manager = await activate('${h['manager_code']}');
    teacher = await activate('${h['teacher_code']}');
  });

  tearDownAll(() async {
    if (!enabled) return;
    access.close();
    // ignore: avoid_print
    print('NATIVE-WAVE5-IT passed=$passed negative_controls=$negatives');
    await gw.kill();
  });

  final skip = enabled
      ? false
      : 'set PAYESH_GW_IT=1 (+ PAYESH_PG_ADMIN/RUNTIME) for the real Gateway';

  test('W5-IT-01 parent pulls exactly the own family: two children, nothing of the other family', () async {
    expect(parent.session.role, 'parent');
    expect(parent.session.uid, 40);
    await parent.sync.pull();
    final kids = await parent.family.children();
    expect(kids.map((k) => k.id), [21, 22]);
    expect(kids.map((k) => k.className), ['دهم الف', 'یازدهم ب']);
    // server scope: no row of student 23 or of parent 41 reached this device
    expect(await parent.engine.get('users', 23), isNull);
    expect(await parent.engine.get('grades', 804), isNull);
    expect(await parent.engine.get('leaves', 961), isNull);
    expect(await parent.engine.get('parent_links', 702), isNull);
    expect(await parent.engine.count('parent_links'), 2);
    negatives++;
    passed++;
  }, skip: skip);

  test('W5-IT-02 home and child page from the pulled rows: approved average, attendance, review states', () async {
    final bahar = (await parent.family.children()).first;
    expect(bahar.average, 16); // (18 + 14) / 2 — the pending 9 is not counted
    expect(bahar.attendancePercent, 67); // 2 of 3
    final r = await parent.family.child(21);
    expect(r.grades.map((g) => g.subject), ['ریاضی', 'ادبیات', 'ریاضی']);
    expect(r.grades.map((g) => g.approved), [true, true, false]);
    expect(r.attendance.first.date, '2025-11-10');
    expect(r.attendance.first.status, AttendanceStatus.absent);
    final omid = await parent.family.child(22);
    expect(omid.internships.single.location, 'کارگاه');
    expect(omid.summary.average, isNull);
    await expectLater(parent.family.child(23), throwsA(isA<FamilyFailure>()));
    negatives++;
    passed++;
  }, skip: skip);

  test('W5-IT-03 leave request offline → queued → online → applied once as pending, version 1', () async {
    final res = await parent.family.requestLeave(
      studentId: 22,
      reason: ' مراجعه به پزشک ',
    );
    requested = res.id;
    expect(requested, greaterThanOrEqualTo(FamilyBook.idBase));
    final dead = Uri.parse('http://127.0.0.1:${await freePort()}');
    final s1 = await parent.auto(dead).runOnce();
    expect(s1.phase, SyncPhase.offline);
    expect(s1.labelFa, 'آفلاین — 1 مورد در صف ارسال');
    expect(await serverRow(requested), isNull);
    expect((await parent.family.leaveRequests()).first.queued, isTrue);
    negatives++;
    parent.outbox.wake();
    final s2 = await parent.auto(gw.uri).runOnce();
    expect(s2.phase, SyncPhase.idle, reason: '${s2.lastError}');
    final row = (await serverRow(requested))!;
    expect(row['version'], 1);
    expect(row['data'], {
      'id': requested,
      'student_id': 22,
      'date': utcToday(),
      'reason': 'مراجعه به پزشک',
      'status': 'pending',
      'by_id': 40,
    });
    final ls = await parent.family.leaveRequests();
    expect(ls.first.id, requested);
    expect(ls.first.queued, isFalse);
    expect(ls.map((l) => l.id).toSet(), {requested, 960});
    passed++;
  }, skip: skip);

  test('W5-IT-04 the school approves it (manager device) → the parent sees «تأییدشده» after a pull', () async {
    final cur = (await serverRow(requested))!;
    manager.outbox.enqueue({
      'collection': 'leaves',
      'type': 'put',
      'id': requested,
      'data': {
        ...(cur['data']! as Map).cast<String, Object?>(),
        'status': 'approved',
        'decided_by': 1,
      },
      'base_version': cur['version'],
    });
    expect((await manager.outbox.drain(manager.transport.push)).applied, 1);
    expect((await serverRow(requested))!['version'], 2);
    await parent.sync.pull();
    final l = (await parent.family.leaveRequests()).firstWhere(
      (x) => x.id == requested,
    );
    expect(l.state, LeaveState.approved);
    passed++;
  }, skip: skip);

  test('W5-IT-05 NEG forged parent leave with status approved / rejected → approval_denied', () async {
    for (final (id, st) in [
      (FamilyBook.idBase + 501, 'approved'),
      (FamilyBook.idBase + 502, 'rejected'),
    ]) {
      final ob = await forged(parent, 'leaves', id, {
        'student_id': 21,
        'date': '2025-11-12',
        'reason': 'جعلی',
        'status': st,
        'by_id': 40,
      });
      expect(ob.list().single.lastError, contains('approval_denied'));
      expect(await serverRow(id), isNull);
      negatives++;
    }
    // and the approved request cannot be turned back into «approved by the parent» either
    final cur = (await serverRow(requested))!;
    final dev = Device(
      base: gw.uri,
      session: parent.session,
      deviceId: parent.deviceId,
      config: const OutboxConfig(maxAttempts: 1),
    );
    dev.outbox.enqueue({
      'collection': 'leaves',
      'type': 'put',
      'id': requested,
      'data': {...(cur['data']! as Map).cast<String, Object?>(), 'reason': 'x'},
      'base_version': cur['version'],
    });
    await dev.outbox.drain(dev.transport.push);
    expect(dev.outbox.list().single.lastError, contains('approval_denied'));
    expect((await serverRow(requested))!['version'], 2);
    negatives++;
    passed++;
  }, skip: skip);

  test(
    'W5-IT-06 NEG forged leave for the other family\'s child → out_of_scope',
    () async {
      final ob = await forged(parent, 'leaves', FamilyBook.idBase + 503, {
        'student_id': 23,
        'date': '2025-11-12',
        'reason': 'x',
        'status': 'pending',
        'by_id': 40,
      });
      expect(ob.list().single.lastError, contains('out_of_scope'));
      expect(await serverRow(FamilyBook.idBase + 503), isNull);
      negatives++;
      passed++;
    },
    skip: skip,
  );

  test(
    'W5-IT-07 NEG forged parent grade → role_denied; the grade is unchanged',
    () async {
      final ob = await forged(parent, 'grades', 803, {
        'student_id': 21,
        'class_id': 5,
        'subject_id': 41,
        'term': 'نوبت دوم',
        'kind': 'midterm',
        'score': 20,
        'status': 'pending',
      });
      expect(ob.list().single.lastError, contains('role_denied'));
      final g = (await serverRow(803, 'grades'))!;
      expect((g['data']! as Map)['score'], 9);
      expect(g['version'], 1);
      negatives++;
      passed++;
    },
    skip: skip,
  );

  test(
    'W5-IT-08 NEG a teacher has no parents page and never pulls parent links',
    () async {
      expect(teacher.session.role, 'teacher');
      await teacher.sync.pull();
      expect(await teacher.engine.count('parent_links'), 0);
      expect(teacher.family.isParent, isFalse);
      await expectLater(
        teacher.family.children(),
        throwsA(isA<FamilyFailure>()),
      );
      await expectLater(
        teacher.family.requestLeave(studentId: 21),
        throwsA(isA<FamilyFailure>()),
      );
      expect(teacher.outbox.list(), isEmpty);
      negatives++;
      passed++;
    },
    skip: skip,
  );
}
