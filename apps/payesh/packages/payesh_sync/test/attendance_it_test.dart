// Row 74, wave 2 — native attendance against the REAL Gateway (server/gateway.js, runtime role,
// RLS, server-side scope) on a real PostgreSQL. Not a mock. Runs when PAYESH_GW_IT=1
// (+ PAYESH_PG_ADMIN / PAYESH_PG_RUNTIME); CI job `gateway-real` in native-client.yml.
//
// Path under test = the app's default data path: activation (row 121) → GatewaySync.pull into
// SQLite → AttendanceBook (local write + SqliteOutbox) → AutoSync → GatewayTransport.push.
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
    ['test/support/attendance_harness.cjs', ...args],
    environment: {
      'PAYESH_REPO_ROOT': repoRoot,
      'PGURL_ADMIN': env['PAYESH_PG_ADMIN'] ?? '',
      ...extra,
    },
  );
  if (h.exitCode != 0) throw StateError('harness: ${h.stderr}');
  return (jsonDecode('${h.stdout}') as Map).cast<String, Object?>();
}

/// One device of the school: its own encrypted-at-rest-equivalent SQLite (in memory here),
/// outbox, Gateway transport and attendance book — the same objects the app wires.
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
    book = AttendanceBook(
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
  late final AttendanceBook book;
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

const day = '2026-11-12';

void main() {
  late Gw gw;
  late Map<String, Object?> h;
  late SchoolAccessClient access;
  late Device teacher;
  var negatives = 0;
  var passed = 0;
  final rnd = Random(742);
  final teacherDevice = SchoolAccessRules.newDeviceId(rnd);

  Future<List<Map<String, Object?>>> serverRows() async {
    final r = await harness(['read'], {'TENANT': '${h['tenant']}'});
    return [
      for (final x in r['rows']! as List<Object?>)
        (x! as Map).cast<String, Object?>(),
    ];
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
      'GW_INSTANCE': 'gw-74-w2',
    });
    await gw.start();
    access = SchoolAccessClient(directory: gw.uri);
    teacher = await activate('${h['teacher_code']}', teacherDevice);
  });

  tearDownAll(() async {
    if (!enabled) return;
    access.close();
    // ignore: avoid_print
    print('NATIVE-WAVE2-IT passed=$passed negative_controls=$negatives');
    await gw.kill();
  });

  final skip = enabled
      ? false
      : 'set PAYESH_GW_IT=1 (+ PAYESH_PG_ADMIN/RUNTIME) for the real Gateway';

  test('W2-IT-01 teacher pull: only the scheduled class and its students reach the device', () async {
    expect(teacher.session.role, 'teacher');
    expect(teacher.session.uid, 10);
    await teacher.sync.pull();
    final classes = await teacher.book.classes();
    expect(classes.map((c) => c.id), [5]);
    expect(classes.single.name, 'دهم الف');
    final roster = await teacher.book.roster(5, day);
    expect(roster.map((r) => r.studentId).toSet(), {21, 22, 23});
    // NEG: class 6 and its student never reach this device (server scope, not the UI)
    expect(await teacher.engine.get('users', 31), isNull);
    expect(await teacher.engine.get('classes', 6), isNull);
    negatives += 2;
    passed++;
  }, skip: skip);

  test('W2-IT-02 offline save → queued with a visible count → online → applied once on the server', () async {
    final res = await teacher.book.save(
      classId: 5,
      date: day,
      marks: {21: AttendanceStatus.absent, 23: AttendanceStatus.late},
    );
    expect(res.written, 3);
    // the Gateway address is unreachable (closed port): nothing leaves, nothing is lost
    final dead = Uri.parse('http://127.0.0.1:${await freePort()}');
    final off = teacher.auto(dead);
    final s1 = await off.runOnce();
    expect(s1.phase, SyncPhase.offline);
    expect(s1.waiting, 3);
    expect(s1.labelFa, 'آفلاین — 3 مورد در صف ارسال');
    expect(await serverRows(), isEmpty);
    negatives++;
    // back online: the real Gateway applies the three records
    teacher.outbox.wake();
    final on = teacher.auto(gw.uri);
    final s2 = await on.runOnce();
    expect(s2.phase, SyncPhase.idle, reason: '${s2.lastError}');
    expect(s2.waiting, 0);
    final rows = await serverRows();
    expect(rows.length, 3);
    final status = {
      for (final r in rows)
        (r['data']! as Map)['student_id']: (r['data']! as Map)['status'],
    };
    expect(status, {21: 'absent', 22: 'present', 23: 'late'});
    expect(rows.map((r) => r['id']).toSet(), {
      for (final s in [21, 22, 23]) AttendanceBook.recordId(s, day),
    });
    expect(rows.every((r) => r['version'] == 1), isTrue);
    // the pull brought the server versions back to the device
    final r21 = (await teacher.book.roster(
      5,
      day,
    )).firstWhere((r) => r.studentId == 21);
    expect(r21.version, 1);
    passed++;
  }, skip: skip);

  test(
    'W2-IT-03 edit after sync: only the changed student is sent, version 1 → 2',
    () async {
      final res = await teacher.book.save(
        classId: 5,
        date: day,
        marks: {21: AttendanceStatus.excused},
      );
      expect(res.written, 1);
      expect(res.unchanged, 2);
      final d = await teacher.outbox.drain(teacher.transport.push);
      expect(d.applied, 1);
      final rows = await serverRows();
      final r21 = rows.firstWhere(
        (r) => (r['data']! as Map)['student_id'] == 21,
      );
      expect((r21['data']! as Map)['status'], 'excused');
      expect(r21['version'], 2);
      expect(
        rows.where((r) => r['version'] == 1).length,
        2,
        reason: 'unchanged students must not be rewritten',
      );
      passed++;
    },
    skip: skip,
  );

  test('W2-IT-04 NEG a second device with a stale copy: real conflict → review, server value kept', () async {
    // same teacher on a second device whose local copy is older than W2-IT-03
    final stale = Device(
      base: gw.uri,
      session: teacher.session,
      deviceId: teacherDevice,
    );
    // the stale device pulled BEFORE the edit of W2-IT-03 → it believes version 1
    await stale.engine.put('attendance', AttendanceBook.recordId(21, day), {
      'id': AttendanceBook.recordId(21, day),
      'student_id': 21,
      'class_id': 5,
      'date': day,
      'status': 'absent',
      'note': '',
    }, version: 1);
    await stale.engine.put('classes', 5, {'id': 5, 'name': 'دهم الف'});
    await stale.engine.put('schedule', 900, {
      'id': 900,
      'teacher_id': 10,
      'class_id': 5,
    });
    for (final s in [21, 22, 23]) {
      await stale.engine.put('users', s, {
        'id': s,
        'role': 'student',
        'class_id': 5,
        'name': 's$s',
      });
    }
    await stale.book.save(
      classId: 5,
      date: day,
      marks: {
        21: AttendanceStatus.late,
        22: AttendanceStatus.present,
        23: AttendanceStatus.late,
      },
    );
    final res = await stale.sync.push(stale.outbox);
    expect(res.conflicts, greaterThanOrEqualTo(1));
    final review = stale.sync.review();
    expect(
      review.any(
        (r) => r.kind == 'conflict' && r.id == AttendanceBook.recordId(21, day),
      ),
      isTrue,
    );
    final r21 = (await serverRows()).firstWhere(
      (r) => (r['data']! as Map)['student_id'] == 21,
    );
    expect(
      (r21['data']! as Map)['status'],
      'excused',
      reason: 'never overwritten blind',
    );
    expect(r21['version'], 2);
    negatives++;
    passed++;
  }, skip: skip);

  test('W2-IT-05 NEG forged op for a class outside the teacher scope → 403 out_of_scope, kept on device', () async {
    final dev = Device(
      base: gw.uri,
      session: teacher.session,
      deviceId: teacherDevice,
      config: const OutboxConfig(maxAttempts: 1),
    );
    // bypasses AttendanceBook (which refuses class 6 locally) — the server must refuse too
    dev.outbox.enqueue({
      'collection': 'attendance',
      'type': 'put',
      'id': AttendanceBook.recordId(31, day),
      'data': {
        'student_id': 31,
        'class_id': 6,
        'date': day,
        'status': 'absent',
      },
      'base_version': 0,
    });
    final s = await dev.auto(gw.uri).runOnce();
    expect(s.phase, SyncPhase.attention);
    expect(s.blocked, 1);
    expect(s.labelFa, '1 مورد نیاز به بررسی دارد');
    final op = dev.outbox.list().single;
    expect(op.state, OpState.blocked);
    expect(op.lastError, contains('out_of_scope'));
    expect(
      (await serverRows()).where(
        (r) => (r['data']! as Map)['student_id'] == 31,
      ),
      isEmpty,
    );
    negatives++;
    passed++;
  }, skip: skip);

  test(
    'W2-IT-06 NEG forged unknown status → 403 bad_status, nothing written',
    () async {
      final dev = Device(
        base: gw.uri,
        session: teacher.session,
        deviceId: teacherDevice,
        config: const OutboxConfig(maxAttempts: 1),
      );
      dev.outbox.enqueue({
        'collection': 'attendance',
        'type': 'put',
        'id': AttendanceBook.recordId(22, '2026-11-13'),
        'data': {
          'student_id': 22,
          'class_id': 5,
          'date': '2026-11-13',
          'status': 'sick',
        },
        'base_version': 0,
      });
      final d = await dev.outbox.drain(dev.transport.push);
      expect(d.applied, 0);
      expect(dev.outbox.list().single.lastError, contains('bad_status'));
      expect(
        (await serverRows()).where(
          (r) => (r['data']! as Map)['date'] == '2026-11-13',
        ),
        isEmpty,
      );
      negatives++;
      passed++;
    },
    skip: skip,
  );

  test('W2-IT-07 NEG parent: no attendance UI locally AND role_denied on the server', () async {
    final parent = await activate(
      '${h['parent_code']}',
      SchoolAccessRules.newDeviceId(rnd),
    );
    expect(parent.session.role, 'parent');
    expect(parent.book.canWrite, isFalse);
    await expectLater(parent.book.classes(), throwsA(isA<AttendanceFailure>()));
    final dev = Device(
      base: gw.uri,
      session: parent.session,
      deviceId: parent.deviceId,
      config: const OutboxConfig(maxAttempts: 1),
    );
    dev.outbox.enqueue({
      'collection': 'attendance',
      'type': 'put',
      'id': AttendanceBook.recordId(21, '2026-11-14'),
      'data': {
        'student_id': 21,
        'class_id': 5,
        'date': '2026-11-14',
        'status': 'present',
      },
      'base_version': 0,
    });
    await dev.outbox.drain(dev.transport.push);
    expect(dev.outbox.list().single.lastError, contains('role_denied'));
    expect(
      (await serverRows()).where(
        (r) => (r['data']! as Map)['date'] == '2026-11-14',
      ),
      isEmpty,
    );
    negatives += 2;
    passed++;
  }, skip: skip);

  test(
    'W2-IT-08 NEG forged token → 401, op stays queued (never dropped)',
    () async {
      final dev = Device(
        base: gw.uri,
        session: teacher.session,
        deviceId: teacherDevice,
      )..token = '${teacher.session.token}x';
      await dev.engine.put('classes', 5, {'id': 5, 'name': 'دهم الف'});
      await dev.engine.put('schedule', 900, {
        'id': 900,
        'teacher_id': 10,
        'class_id': 5,
      });
      await dev.engine.put('users', 22, {
        'id': 22,
        'role': 'student',
        'class_id': 5,
        'name': 'آرش',
      });
      await dev.book.save(classId: 5, date: '2026-11-15');
      final d = await dev.outbox.drain(dev.transport.push);
      expect(d.applied, 0);
      final op = dev.outbox.list().single;
      expect(op.state, OpState.pending);
      expect(op.lastError, isNotNull);
      expect(
        (await serverRows()).where(
          (r) => (r['data']! as Map)['date'] == '2026-11-15',
        ),
        isEmpty,
      );
      negatives++;
      passed++;
    },
    skip: skip,
  );
}
