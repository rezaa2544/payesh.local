// Row 74, wave 3 — native grade entry against the REAL Gateway (server/gateway.js, runtime role,
// RLS, server-side scope incl. `approval_denied`) on a real PostgreSQL. Not a mock. Runs when
// PAYESH_GW_IT=1 (+ PAYESH_PG_ADMIN / PAYESH_PG_RUNTIME); CI job `gateway-real` in
// native-client.yml.
//
// Path under test = the app's default data path: activation (row 121) → GatewaySync.pull into
// SQLite → GradeBook (local write + SqliteOutbox) → AutoSync → GatewayTransport.push.
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
    ['test/support/grades_harness.cjs', ...args],
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
/// outbox, Gateway transport and grade book — the same objects the app wires.
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
    book = GradeBook(
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
  late final GradeBook book;
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

const t1 = GradeTerm.first;

int gid(int student, {int subject = 41, GradeTerm term = t1}) =>
    GradeBook.recordId(
      classId: 5,
      subjectId: subject,
      term: term,
      studentId: student,
    );

void main() {
  late Gw gw;
  late Map<String, Object?> h;
  late SchoolAccessClient access;
  late Device teacher;
  late Device manager;
  var negatives = 0;
  var passed = 0;
  final rnd = Random(743);
  final teacherDevice = SchoolAccessRules.newDeviceId(rnd);

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

  /// A forged op that bypasses GradeBook (which refuses it locally) — the server must refuse too.
  Future<SqliteOutbox> forged(
    Device as,
    Map<String, Object?> data,
    int id,
  ) async {
    final dev = Device(
      base: gw.uri,
      session: as.session,
      deviceId: as.deviceId,
      config: const OutboxConfig(maxAttempts: 1),
    );
    dev.outbox.enqueue({
      'collection': 'grades',
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
      'GW_INSTANCE': 'gw-74-w3',
    });
    await gw.start();
    access = SchoolAccessClient(directory: gw.uri);
    teacher = await activate('${h['teacher_code']}', teacherDevice);
    manager = await activate(
      '${h['manager_code']}',
      SchoolAccessRules.newDeviceId(rnd),
    );
  });

  tearDownAll(() async {
    if (!enabled) return;
    access.close();
    // ignore: avoid_print
    print('NATIVE-WAVE3-IT passed=$passed negative_controls=$negatives');
    await gw.kill();
  });

  final skip = enabled
      ? false
      : 'set PAYESH_GW_IT=1 (+ PAYESH_PG_ADMIN/RUNTIME) for the real Gateway';

  test('W3-IT-01 teacher pull: scheduled class, all subjects, sheet of its students only', () async {
    expect(teacher.session.role, 'teacher');
    await teacher.sync.pull();
    expect((await teacher.book.classes()).map((c) => c.id), [5]);
    expect((await teacher.book.subjects()).map((s) => s.id), [40, 41, 42]);
    expect((await teacher.book.defaultSubject(5))!.id, 41);
    final sheet = await teacher.book.sheet(classId: 5, subjectId: 41, term: t1);
    expect(sheet.map((e) => e.studentId).toSet(), {21, 22, 23});
    // NEG: class 6 and its student never reach this device (server scope, not the UI)
    expect(await teacher.engine.get('users', 31), isNull);
    expect(await teacher.engine.get('classes', 6), isNull);
    negatives += 2;
    passed++;
  }, skip: skip);

  test('W3-IT-02 offline save → queued → online → applied once, pending, version 1', () async {
    final res = await teacher.book.save(
      classId: 5,
      subjectId: 41,
      term: t1,
      inputs: {21: '۱۷', 22: '12.5', 23: ''},
    );
    expect(res.written, 2);
    final dead = Uri.parse('http://127.0.0.1:${await freePort()}');
    final s1 = await teacher.auto(dead).runOnce();
    expect(s1.phase, SyncPhase.offline);
    expect(s1.labelFa, 'آفلاین — 2 مورد در صف ارسال');
    expect(await serverRows(), isEmpty);
    negatives++;
    teacher.outbox.wake();
    final s2 = await teacher.auto(gw.uri).runOnce();
    expect(s2.phase, SyncPhase.idle, reason: '${s2.lastError}');
    final rows = await serverRows();
    expect(rows.map((r) => r['id']).toSet(), {gid(21), gid(22)});
    final r21 = (await serverRow(gid(21)))!;
    expect(r21['version'], 1);
    expect(r21['data'], {
      'id': gid(21),
      'student_id': 21,
      'class_id': 5,
      'subject_id': 41,
      'term': 'نوبت اول',
      'kind': 'midterm',
      'score': 17,
      'status': 'pending',
    });
    expect(((await serverRow(gid(22)))!['data']! as Map)['score'], 12.5);
    final back = await teacher.book.sheet(classId: 5, subjectId: 41, term: t1);
    final b21 = back.firstWhere((e) => e.studentId == 21);
    expect(b21.version, 1);
    expect(b21.state, GradeState.pending);
    passed++;
  }, skip: skip);

  test('W3-IT-03 manager approves by entering the grade; a later teacher edit drops it back to pending', () async {
    expect(manager.session.role, 'manager');
    await manager.sync.pull();
    expect((await manager.book.classes()).map((c) => c.id), [5, 6]);
    final m = await manager.book.save(
      classId: 5,
      subjectId: 41,
      term: t1,
      inputs: {21: '18'},
    );
    expect(m.written, 1);
    expect((await manager.outbox.drain(manager.transport.push)).applied, 1);
    var r21 = (await serverRow(gid(21)))!;
    expect(r21['version'], 2);
    expect((r21['data']! as Map)['status'], 'approved');
    // the teacher sees the approval after a pull
    await teacher.sync.pull();
    final s = await teacher.book.sheet(classId: 5, subjectId: 41, term: t1);
    expect(s.firstWhere((e) => e.studentId == 21).state, GradeState.approved);
    // the teacher changes it → pending again (approval revoked), version 3
    await teacher.book.save(
      classId: 5,
      subjectId: 41,
      term: t1,
      inputs: {21: '19'},
    );
    expect((await teacher.outbox.drain(teacher.transport.push)).applied, 1);
    r21 = (await serverRow(gid(21)))!;
    expect(r21['version'], 3);
    expect((r21['data']! as Map)['status'], 'pending');
    expect((r21['data']! as Map)['score'], 19);
    passed++;
  }, skip: skip);

  test('W3-IT-04 NEG forged teacher op with status approved → 403 approval_denied, nothing written', () async {
    final ob = await forged(teacher, {
      'student_id': 23,
      'class_id': 5,
      'subject_id': 41,
      'term': 'نوبت اول',
      'kind': 'midterm',
      'score': 20,
      'status': 'approved',
    }, gid(23));
    expect(ob.list().single.lastError, contains('approval_denied'));
    expect(await serverRow(gid(23)), isNull);
    negatives++;
    passed++;
  }, skip: skip);

  test(
    'W3-IT-05 NEG forged score 25 → bad_score; forged kind → bad_kind',
    () async {
      final a = await forged(teacher, {
        'student_id': 23,
        'class_id': 5,
        'subject_id': 40,
        'term': 'نوبت اول',
        'score': 25,
        'status': 'pending',
      }, gid(23, subject: 40));
      expect(a.list().single.lastError, contains('bad_score'));
      final b = await forged(teacher, {
        'student_id': 23,
        'class_id': 5,
        'subject_id': 40,
        'term': 'نوبت دوم',
        'score': 12,
        'kind': 'written',
        'status': 'pending',
      }, gid(23, subject: 40, term: GradeTerm.second));
      expect(b.list().single.lastError, contains('bad_kind'));
      expect(await serverRow(gid(23, subject: 40)), isNull);
      expect(
        await serverRow(gid(23, subject: 40, term: GradeTerm.second)),
        isNull,
      );
      negatives += 2;
      passed++;
    },
    skip: skip,
  );

  test('W3-IT-06 NEG forged grade for a class outside the teacher scope → out_of_scope', () async {
    final id = GradeBook.recordId(
      classId: 6,
      subjectId: 41,
      term: t1,
      studentId: 31,
    );
    final ob = await forged(teacher, {
      'student_id': 31,
      'class_id': 6,
      'subject_id': 41,
      'term': 'نوبت اول',
      'score': 10,
      'status': 'pending',
    }, id);
    expect(ob.list().single.lastError, contains('out_of_scope'));
    expect(await serverRow(id), isNull);
    negatives++;
    passed++;
  }, skip: skip);

  test(
    'W3-IT-07 NEG parent: no grade entry locally AND role_denied on the server',
    () async {
      final parent = await activate(
        '${h['parent_code']}',
        SchoolAccessRules.newDeviceId(rnd),
      );
      expect(parent.session.role, 'parent');
      expect(parent.book.canWrite, isFalse);
      await expectLater(parent.book.classes(), throwsA(isA<GradeFailure>()));
      final ob = await forged(parent, {
        'student_id': 21,
        'class_id': 5,
        'subject_id': 40,
        'term': 'پایانی',
        'score': 20,
        'status': 'pending',
      }, gid(21, subject: 40, term: GradeTerm.finalTerm));
      expect(ob.list().single.lastError, contains('role_denied'));
      expect(
        await serverRow(gid(21, subject: 40, term: GradeTerm.finalTerm)),
        isNull,
      );
      negatives += 2;
      passed++;
    },
    skip: skip,
  );

  test('W3-IT-08 NEG a second device with a stale copy: real conflict → review, server value kept', () async {
    final stale = Device(
      base: gw.uri,
      session: teacher.session,
      deviceId: teacherDevice,
    );
    // the stale device pulled after W3-IT-02 only → it believes version 1
    await stale.engine.put('classes', 5, {'id': 5, 'name': 'دهم الف'});
    await stale.engine.put('schedule', 900, {
      'id': 900,
      'teacher_id': 10,
      'class_id': 5,
      'subject_id': 41,
    });
    await stale.engine.put('subjects', 41, {'id': 41, 'name': 'ریاضی'});
    await stale.engine.put('users', 21, {
      'id': 21,
      'role': 'student',
      'class_id': 5,
      'name': 'بهار',
    });
    await stale.engine.put('grades', gid(21), {
      'id': gid(21),
      'student_id': 21,
      'class_id': 5,
      'subject_id': 41,
      'term': 'نوبت اول',
      'kind': 'midterm',
      'score': 17,
      'status': 'pending',
    }, version: 1);
    await stale.book.save(
      classId: 5,
      subjectId: 41,
      term: t1,
      inputs: {21: '10'},
    );
    final res = await stale.sync.push(stale.outbox);
    expect(res.conflicts, 1);
    expect(
      stale.sync.review().any((r) => r.kind == 'conflict' && r.id == gid(21)),
      isTrue,
    );
    final r21 = (await serverRow(gid(21)))!;
    expect(
      (r21['data']! as Map)['score'],
      19,
      reason: 'never overwritten blind',
    );
    expect(r21['version'], 3);
    negatives++;
    passed++;
  }, skip: skip);
}
