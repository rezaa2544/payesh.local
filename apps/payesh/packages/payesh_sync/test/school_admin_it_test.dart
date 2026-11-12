// Row 128 — the native school-management pages (waves W6..W12) against the school's OWN server:
// the REAL server/index.js started as the headless data service (PAYESH_HEADLESS=1, what the
// school installer runs), not a mock. Runs only when PAYESH_SERVER_IT=1 (CI job
// `sync-real-server` in native-client.yml).
//
// Path under test = the app's LAN data path: LanAccessClient login → SyncClient pull over
// HttpSyncTransport into SQLite → the wave's book (local write + SqliteOutbox, offline) →
// AutoSync → HttpSyncTransport.push (`/api/sync`, server/policy.js + server/sync.js enforce).
// Every wave has negative controls: the server refuses what the device must never do.
@Tags(['server'])
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

final bool enabled = Platform.environment['PAYESH_SERVER_IT'] == '1';
final String node = Platform.environment['PAYESH_NODE'] ?? 'node';
final String repoRoot =
    Platform.environment['PAYESH_REPO_ROOT'] ??
    Directory('../../../..').absolute.path;

Future<int> freePort() async {
  final s = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  final p = s.port;
  await s.close();
  return p;
}

/// The school data service exactly as the installer starts it (API only, no web UI).
final class DataService {
  DataService(this.dataDir);
  final String dataDir;
  final log = StringBuffer();
  Process? _p;
  late int port;
  Uri get base => Uri.parse('http://127.0.0.1:$port');

  Future<void> start() async {
    port = await freePort();
    _p = await Process.start(
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
        'PAYESH_HEADLESS': '1',
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
    _p!.stdout.transform(utf8.decoder).listen(log.write);
    _p!.stderr.transform(utf8.decoder).listen(log.write);
    final c = HttpClient();
    try {
      for (var i = 0; i < 400; i++) {
        try {
          final res = await (await c.getUrl(base.resolve('/api/health')))
              .close();
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
    throw StateError('data service did not start:\n$log');
  }

  Future<void> kill() async {
    _p?.kill(ProcessSignal.sigkill);
    await _p?.exitCode;
  }
}

/// Raw HTTP (status + body), for server-side assertions and negative controls.
Future<(int, Map<String, Object?>)> raw(
  String method,
  Uri uri, {
  Object? body,
  String? token,
}) async {
  final c = HttpClient();
  try {
    final req = await c.openUrl(method, uri);
    if (token != null) req.headers.set('authorization', 'Bearer $token');
    if (body != null) {
      req.headers.contentType = ContentType.json;
      req.write(jsonEncode(body));
    }
    final res = await req.close();
    final text = await utf8.decodeStream(res);
    Object? j;
    try {
      j = jsonDecode(text);
    } on FormatException {
      j = {'_text': text};
    }
    return (res.statusCode, j is Map ? j.cast<String, Object?>() : {'_': j});
  } finally {
    c.close(force: true);
  }
}

/// One device of the school: its own SQLite, outbox and transport.
final class Device {
  Device(this.server, this.session, {int seed = 1})
    : engine = SqliteEngine.inMemory(),
      random = Random(seed) {
    outbox = SqliteOutbox(
      engine.database,
      config: const OutboxConfig(jitter: 0),
    );
  }
  final Uri server;
  final LanSession session;
  final SqliteEngine engine;
  final Random random;
  late final SqliteOutbox outbox;

  SchoolRecords get db => SchoolRecords(
    engine: engine,
    outbox: outbox,
    role: session.role,
    uid: session.uid,
    random: random,
  );

  HttpSyncTransport transport(Uri to) => HttpSyncTransport(
    baseUri: to,
    token: () => session.token,
    deviceId: 'pd-it128-${session.uid}',
  );

  SyncClient client([Uri? to]) => SyncClient(
    engine: engine,
    outbox: outbox,
    transport: transport(to ?? server),
  );

  Future<void> pull() async {
    await client().pull();
  }

  /// One AutoSync cycle (push then pull) against [to] (default: the server).
  Future<SyncStatus> sync([Uri? to]) async {
    final t = transport(to ?? server);
    final s = SyncClient(engine: engine, outbox: outbox, transport: t);
    outbox.wake();
    return AutoSync(
      outbox: outbox,
      push: (ops) => t.push(ops),
      pull: () async {
        await s.pull();
      },
      idleInterval: const Duration(hours: 1),
    ).runOnce();
  }
}

void main() {
  late Directory dir;
  late DataService svc;
  late LanAccessClient lan;
  late Uri server;
  late LanSession managerLogin;
  late Device manager;
  late LanSession teacherLogin;
  late Device teacher;
  var passed = 0;
  var negatives = 0;
  const teacherPhone = '09120000010';
  const teacherPassword = 'moalem-128';
  var teacherId = 0;

  Future<List<Map<String, Object?>>> serverRows(String collection) async {
    final (st, j) = await raw(
      'GET',
      svc.base.resolve('/api/v1/pull?collections=$collection'),
      token: managerLogin.token,
    );
    expect(st, 200, reason: '$j');
    final cols = j['collections']! as Map;
    return [
      for (final r in (cols[collection] as List? ?? const []))
        if ((r as Map)['deleted'] != true) r.cast<String, Object?>(),
    ];
  }

  Future<Map<String, Object?>?> serverRow(String collection, int id) async {
    for (final r in await serverRows(collection)) {
      if ((r['id'] as num).toInt() == id) return r;
    }
    return null;
  }

  Future<Map<String, Object?>> push(
    String token,
    List<Map<String, Object?>> ops,
  ) async {
    final (st, j) = await raw(
      'POST',
      svc.base.resolve('/api/sync'),
      token: token,
      body: {'ops': ops},
    );
    expect(st, 200, reason: '$j');
    return j;
  }

  setUpAll(() async {
    if (!enabled) return;
    dir = await Directory.systemTemp.createTemp('payesh-it128-');
    svc = DataService(dir.path);
    await svc.start();
    lan = LanAccessClient(platform: 'it', refreshRetryDelays: const []);
    server = svc.base;
  });

  tearDownAll(() async {
    if (!enabled) return;
    lan.close();
    // ignore: avoid_print
    print('NATIVE-ADMIN-IT passed=$passed negative_controls=$negatives');
    await svc.kill();
    try {
      await dir.delete(recursive: true);
    } on FileSystemException {
      // best effort
    }
  });

  final skip = enabled
      ? false
      : 'set PAYESH_SERVER_IT=1 to run against server/index.js';

  test(
    'ADM-IT-00 setup: manager + teacher signed in, both devices pulled',
    () async {
      managerLogin = await lan.setup(
        server: server,
        schoolName: 'هنرستان آزمون ۱۲۸',
        managerName: 'مدیر آزمون',
        phone: '09120000128',
        password: 'modir-128',
      );
      final seeded = await push(managerLogin.token, [
        {
          'uid': 's-c5',
          'collection': 'classes',
          'type': 'put',
          'id': 5,
          'data': {'name': 'دهم الف'},
        },
        {
          'uid': 's-c6',
          'collection': 'classes',
          'type': 'put',
          'id': 6,
          'data': {'name': 'یازدهم ب'},
        },
        {
          'uid': 's-sub',
          'collection': 'subjects',
          'type': 'put',
          'id': 41,
          'data': {'name': 'ریاضی'},
        },
        {
          'uid': 's-t',
          'collection': 'users',
          'type': 'put',
          'data': {
            'name': 'معلم آزمون',
            'role': 'teacher',
            'phone': teacherPhone,
            'active': true,
          },
        },
      ]);
      expect(seeded['rejected'], isEmpty, reason: '$seeded');
      teacherId = (((seeded['applied']! as List).last as Map)['id']! as num)
          .toInt();
      final (st, j) = await raw(
        'POST',
        svc.base.resolve('/api/admin/users/$teacherId/password'),
        token: managerLogin.token,
        body: {'password': teacherPassword},
      );
      expect(st, 200, reason: '$j');
      await push(managerLogin.token, [
        {
          'uid': 's-sch',
          'collection': 'schedule',
          'type': 'put',
          'data': {
            'class_id': 5,
            'teacher_id': teacherId,
            'weekday': 1,
            'bell_order': 1,
            'subject_id': 41,
          },
        },
      ]);
      teacherLogin = await lan.login(
        server: server,
        phone: teacherPhone,
        password: teacherPassword,
        deviceName: 'گوشی معلم',
      );
      manager = Device(server, managerLogin, seed: 1);
      teacher = Device(server, teacherLogin, seed: 2);
      await manager.pull();
      await teacher.pull();
      expect(await manager.engine.get('classes', 5), isNotNull);
      passed++;
    },
    skip: skip,
  );

  // ───────────────────────────── W6 users and records ─────────────────────────────
  var studentId = 0;
  var parentId = 0;
  const studentNid = '0012345678';
  const parentPhone = '09124445566';

  test('W6-IT-01 offline add of a student + parent → queued → server: accounts + link, '
      'the student signs in with the default credentials', () async {
    final users = UserDirectory(manager.db);
    final w = await users.add(
      const UserDraft(
        name: 'سارا رضایی',
        classId: 5,
        nationalId: studentNid,
        parentName: 'علی رضایی',
        parentPhone: parentPhone,
      ),
    );
    studentId = w.id!;
    expect(w.keys, hasLength(3));
    final dead = Uri.parse('http://127.0.0.1:${await freePort()}');
    final s1 = await manager.sync(dead);
    expect(s1.phase, SyncPhase.offline);
    expect(s1.waiting, 3);
    expect(
      await serverRow('users', studentId),
      isNull,
      reason: 'nothing reached the server',
    );
    negatives++;
    final s2 = await manager.sync();
    expect(s2.waiting, 0, reason: '${s2.lastError}\n${svc.log}');
    final st = await serverRow('users', studentId);
    expect(st!['national_id'], studentNid);
    expect(st['class_id'], 5);
    final link = (await serverRows('parent_links'))
        .singleWhere((l) => l['student_id'] == studentId);
    parentId = (link['parent_id']! as num).toInt();
    expect((await serverRow('users', parentId))!['phone'], parentPhone);
    // the account is real: the server gave it default credentials (no mobile → username and
    // initial password = national id, server/auth.js credentialsFor)
    final st1 = await lan.login(
      server: server,
      phone: studentNid,
      password: studentNid,
      deviceName: 'it',
    );
    expect(st1.role, 'student');
    expect(st1.uid, studentId);
    await expectLater(
      lan.login(
        server: server,
        phone: studentNid,
        password: 'not-it-1234',
        deviceName: 'it',
      ),
      throwsA(isA<LanAccessFailure>()),
    );
    negatives++;
    passed++;
  }, skip: skip);

  test('W6-IT-02 edit + full profile reach the server; the father\'s name follows to the parent', () async {
    final users = UserDirectory(manager.db);
    await users.saveFull(studentId, {
      'father_name': 'علی رضایی‌فر',
      'address': 'خیابان آزادی',
    });
    // NEG: the manager device pulled the credential fields (server/sync.js, row 57) but never
    // sends them back — a stale copy could otherwise revert a password change
    expect((await manager.engine.get('users', studentId)), isNotNull);
    for (final op in manager.outbox.list()) {
      expect(op.payload!.keys.where(SchoolRecords.neverSent.contains), isEmpty);
    }
    expect(
      manager.outbox.list(),
      hasLength(2),
      reason: 'student + the linked father',
    );
    final s = await manager.sync();
    expect(s.waiting, 0, reason: '${s.lastError}');
    final st = await serverRow('users', studentId);
    expect(st!['address'], 'خیابان آزادی');
    expect(st['father_name'], 'علی رضایی‌فر');
    expect((await serverRow('users', parentId))!['name'], 'علی رضایی‌فر');
    await users.edit(
      studentId,
      name: 'سارا رضایی',
      phone: '',
      active: true,
      extra: {'address': ''},
    );
    expect((await manager.sync()).waiting, 0);
    expect((await serverRow('users', studentId))!['address'], '');
    // the password set by the server is untouched by both edits
    final again = await lan.login(
      server: server,
      phone: studentNid,
      password: studentNid,
      deviceName: 'it',
    );
    expect(again.uid, studentId);
    negatives++;
    passed++;
  }, skip: skip);

  test('W6-IT-03 NEG stale edit of a sensitive field from a second manager device → conflict '
      'kept for review, never a silent overwrite', () async {
    final other = Device(server, managerLogin, seed: 9);
    await other.pull();
    await UserDirectory(manager.db)
        .saveFull(studentId, {'national_id': '0012345679'});
    expect((await manager.sync()).waiting, 0);
    // national_id is a manual field (server/convergence.js users.manual)
    await UserDirectory(other.db)
        .saveFull(studentId, {'national_id': '0099999999'});
    await other.client().push();
    expect((await serverRow('users', studentId))!['national_id'], '0012345679');
    expect(
      other.client().review().where((r) => r.kind == 'conflict'),
      isNotEmpty,
    );
    // the device now shows the server's version, not its own lost edit
    expect(
      (await other.engine.get('users', studentId))!.data['national_id'],
      '0012345679',
    );
    negatives++;
    passed++;
  }, skip: skip);

  test('W6-IT-04 NEG a teacher cannot manage users: refused on the device AND by the server', () async {
    await expectLater(
      UserDirectory(teacher.db).add(const UserDraft(name: 'نفوذی')),
      throwsA(
        isA<RecordFailure>().having((f) => f.code, 'code', 'not_allowed'),
      ),
    );
    expect(teacher.outbox.list(), isEmpty);
    final r = await push(teacherLogin.token, [
      {
        'uid': 'evil-1',
        'collection': 'users',
        'type': 'put',
        'id': SchoolRecords.idBaseOf('users') + 1,
        'data': {'name': 'نفوذی', 'role': 'manager'},
        'base_version': 0,
      },
    ]);
    expect(r['applied'], isEmpty, reason: '$r');
    expect(r['rejected'], isNotEmpty);
    expect(
      await serverRow('users', SchoolRecords.idBaseOf('users') + 1),
      isNull,
    );
    negatives += 2;
    passed++;
  }, skip: skip);

  test('W6-IT-05 NEG a mobile taken on the server meanwhile → the server refuses the add '
      '(duplicate_phone), the op goes to review', () async {
    await push(managerLogin.token, [
      {
        'uid': 'other-desk',
        'collection': 'users',
        'type': 'put',
        'data': {'name': 'کارمند', 'role': 'staff', 'phone': '09127770000'},
      },
    ]);
    // this device has not pulled yet, so its local check cannot see the clash
    final w = await UserDirectory(manager.db).add(
      const UserDraft(name: 'دبیر تازه', role: 'teacher', phone: '09127770000'),
    );
    await manager.client().push();
    expect(await serverRow('users', w.id!), isNull);
    expect(
      manager.client().review().any(
        (r) => r.kind == 'rejected' && r.error == 'duplicate_phone',
      ),
      isTrue,
    );
    negatives++;
    passed++;
  }, skip: skip);

  test(
    'W6-IT-06 teacher: students of the taught class (pulled); delete student → link and '
    'lone parent gone on the server, the student can no longer sign in',
    () async {
      await teacher.pull();
      final mine = await UserDirectory(teacher.db).students();
      expect(mine.map((s) => s.user.id), contains(studentId));
      expect(mine.every((s) => s.user.classId == 5), isTrue);
      // the national id changed in W6-IT-03, so it is the username now
      final before = await lan.login(
        server: server,
        phone: '0012345679',
        password: studentNid,
        deviceName: 'it',
      );
      expect(before.uid, studentId);
      await manager.pull();
      final w = await UserDirectory(manager.db).delete(studentId);
      expect(w.keys, hasLength(3), reason: 'link + student + lone parent');
      expect((await manager.sync()).waiting, 0);
      expect(await serverRow('users', studentId), isNull);
      expect(await serverRow('users', parentId), isNull);
      expect(
        (await serverRows('parent_links'))
            .where((l) => l['student_id'] == studentId),
        isEmpty,
      );
      await expectLater(
        lan.login(
          server: server,
          phone: '0012345679',
          password: studentNid,
          deviceName: 'it',
        ),
        throwsA(isA<LanAccessFailure>()),
        reason: 'a deleted student can no longer sign in',
      );
      negatives++;
      passed++;
    },
    skip: skip,
  );

  // ───────────────────────────── W7 accounts ─────────────────────────────
  // Passwords are online by design (F‑01): LanAccounts talks to the server directly; the
  // username (= mobile) goes through the offline queue like every users edit.
  LanAccounts accountsOf(LanSession who) =>
      LanAccounts(client: lan, server: server, token: () async => who.token);
  const newTeacherPhone = '09120000099';

  test('W7-IT-01 manager reads and sets a password on the server; the old one stops working; '
      'NEG a teacher cannot read credentials', () async {
    final m = accountsOf(managerLogin);
    final all = await m.credentials();
    final t = all.singleWhere((c) => c.id == teacherId);
    expect(t.username, teacherPhone);
    expect(t.password, teacherPassword, reason: 'sealed copy for the manager');
    final shown = await m.setCredentials(teacherId, password: 'moalem-new');
    expect(shown, 'moalem-new');
    final s = await lan.login(
      server: server,
      phone: teacherPhone,
      password: 'moalem-new',
      deviceName: 'it',
    );
    expect(s.uid, teacherId);
    await expectLater(
      lan.login(
        server: server,
        phone: teacherPhone,
        password: teacherPassword,
        deviceName: 'it',
      ),
      throwsA(isA<LanAccessFailure>()),
    );
    negatives++;
    await expectLater(
      accountsOf(teacherLogin).credentials(),
      throwsA(
        isA<AccountFailure>().having(
          (f) => f.kind,
          'kind',
          AccountError.notManager,
        ),
      ),
    );
    negatives++;
    // NEG: a short password is refused on the device, nothing sent
    await expectLater(
      m.setCredentials(teacherId, password: 'abc'),
      throwsA(
        isA<AccountFailure>().having(
          (f) => f.kind,
          'kind',
          AccountError.shortPassword,
        ),
      ),
    );
    negatives++;
    passed++;
  }, skip: skip);

  test('W7-IT-02 username (mobile) changed offline → queued → applied; the password survives', () async {
    await manager.pull();
    final w = await UserDirectory(manager.db)
        .setUsername(teacherId, newTeacherPhone);
    expect(w.keys, hasLength(1));
    final dead = Uri.parse('http://127.0.0.1:${await freePort()}');
    expect((await manager.sync(dead)).waiting, 1);
    expect((await serverRow('users', teacherId))!['phone'], teacherPhone);
    negatives++;
    expect((await manager.sync()).waiting, 0);
    expect((await serverRow('users', teacherId))!['phone'], newTeacherPhone);
    final s = await lan.login(
      server: server,
      phone: newTeacherPhone,
      password: 'moalem-new',
      deviceName: 'it',
    );
    expect(s.uid, teacherId);
    // the queued op carried no credential field
    expect(manager.outbox.list(), isEmpty);
    passed++;
  }, skip: skip);

  test('W7-IT-03 «رمز = کد ملی» on the server; NEG no mobile and no national id → refused', () async {
    final users = UserDirectory(manager.db);
    final a = await users.add(
      const UserDraft(
        name: 'کارمند آزمون',
        role: 'staff',
        nationalId: '0023456789',
      ),
    );
    final b = await users.add(const UserDraft(name: 'بی‌شناسه', role: 'staff'));
    expect((await manager.sync()).waiting, 0);
    final m = accountsOf(managerLogin);
    await m.setCredentials(a.id!, password: 'temp-1234');
    expect(await m.autoPassword(a.id!), '0023456789');
    final s = await lan.login(
      server: server,
      phone: '0023456789',
      password: '0023456789',
      deviceName: 'it',
    );
    expect(s.uid, a.id);
    await expectLater(
      m.autoPassword(b.id!),
      throwsA(
        isA<AccountFailure>().having(
          (f) => f.kind,
          'kind',
          AccountError.noLogin,
        ),
      ),
    );
    negatives++;
    passed++;
  }, skip: skip);

  test(
    'W7-IT-04 own password: NEG wrong current refused, then changed',
    () async {
      final t = accountsOf(teacherLogin);
      await expectLater(
        t.changeOwnPassword(current: 'not-mine', next: 'khodam-128'),
        throwsA(
          isA<AccountFailure>().having(
            (f) => f.kind,
            'kind',
            AccountError.wrongCurrent,
          ),
        ),
      );
      negatives++;
      await t.changeOwnPassword(current: 'moalem-new', next: 'khodam-128');
      final s = await lan.login(
        server: server,
        phone: newTeacherPhone,
        password: 'khodam-128',
        deviceName: 'it',
      );
      expect(s.uid, teacherId);
      passed++;
    },
    skip: skip,
  );

  test('W7-IT-05 unlock: the device token + password open a new session; NEG wrong password', () async {
    await expectLater(
      lan.unlock(
        server: server,
        deviceToken: teacherLogin.deviceToken,
        password: 'wrong-pass',
      ),
      throwsA(
        isA<LanAccessFailure>().having(
          (f) => f.kind,
          'kind',
          LanAccessError.badCredentials,
        ),
      ),
    );
    negatives++;
    final u = await lan.unlock(
      server: server,
      deviceToken: teacherLogin.deviceToken,
      password: 'khodam-128',
    );
    expect(u.uid, teacherId);
    expect(u.deviceToken, teacherLogin.deviceToken, reason: 'not rotated');
    final (st, _) = await raw(
      'GET',
      svc.base.resolve('/api/v1/pull?collections=classes'),
      token: u.token,
    );
    expect(st, 200);
    passed++;
  }, skip: skip);

  test('W7-IT-06 manager rescue (claim) on the server computer; NEG not from another address', () async {
    await expectLater(
      lan.claim(
        server: Uri.parse('http://192.168.1.10:${svc.port}'),
        phone: '09120000128',
        password: 'modir-new',
      ),
      throwsA(
        isA<LanAccessFailure>().having(
          (f) => f.kind,
          'kind',
          LanAccessError.setupLocalOnly,
        ),
      ),
    );
    negatives++;
    final c = await lan.claim(
      server: server,
      phone: '09120000128',
      password: 'modir-new',
    );
    expect(c.role, 'manager');
    await expectLater(
      lan.login(
        server: server,
        phone: '09120000128',
        password: 'modir-128',
        deviceName: 'it',
      ),
      throwsA(isA<LanAccessFailure>()),
    );
    negatives++;
    passed++;
  }, skip: skip);

  // ───────────────────────────── W8 classes, definitions, subjects ─────────────────────────────
  var roomId = 0,
      classA = 0,
      classB = 0,
      subjectId = 0,
      gradeId = 0,
      mergeStudent = 0;

  test('W8-IT-01 offline: grade + branch + field class + room + subject → queued → all on the server', () async {
    await manager.pull();
    final b = ClassBook(manager.db);
    gradeId = (await b.saveLookup(kind: 'grade', name: 'پایه یازدهم')).id!;
    await b.saveLookup(kind: 'branch', name: 'شبکه');
    classA = (await b.saveClass(
      const ClassDraft(grade: 'پایه یازدهم', branch: 'شبکه'),
    )).id!;
    classB = (await b.saveClass(
      const ClassDraft(grade: 'یازدهم', branch: 'شبکه', name: 'یازدهم شبکه ب'),
    )).id!;
    roomId = (await b.saveRoom(name: 'کارگاه شبکه')).id!;
    subjectId = (await b.saveSubject(name: 'شبکه ۱', workshop: true)).id!;
    final dead = Uri.parse('http://127.0.0.1:${await freePort()}');
    expect((await manager.sync(dead)).waiting, 6);
    expect(await serverRow('classes', classA), isNull);
    negatives++;
    expect((await manager.sync()).waiting, 0);
    final a = await serverRow('classes', classA);
    expect(a!['name'], 'پایه یازدهم شبکه');
    expect(a['mode'], 'field');
    expect(a['grade_level'], 11);
    expect((await serverRow('classes', roomId))!['kind'], 'room');
    expect((await serverRow('subjects', subjectId))!['workshop'], true);
    expect((await serverRow('lookups', gradeId))!['name'], 'پایه یازدهم');
    passed++;
  }, skip: skip);

  test('W8-IT-02 merge on the device → students and schedule moved on the server, source gone', () async {
    final users = UserDirectory(manager.db);
    mergeStudent = (await users.add(
      UserDraft(name: 'شاگرد ادغام', classId: classB),
    )).id!;
    await push(managerLogin.token, []); // no-op: keep the token warm
    expect((await manager.sync()).waiting, 0);
    final (_, applied) = (
      0,
      await push(managerLogin.token, [
        {
          'uid': 'w8-sched',
          'collection': 'schedule',
          'type': 'put',
          'id': SchoolRecords.idBaseOf('schedule') + 8001,
          'data': {
            'class_id': classB,
            'subject_id': subjectId,
            'weekday': 3,
            'bell_order': 2,
          },
          'base_version': 0,
        },
      ]),
    );
    expect(applied['rejected'], isEmpty, reason: '$applied');
    await manager.pull();
    await ClassBook(manager.db).mergeClass(classB, classA);
    expect((await manager.sync()).waiting, 0);
    expect(await serverRow('classes', classB), isNull);
    expect((await serverRow('users', mergeStudent))!['class_id'], classA);
    expect(
      (await serverRow(
        'schedule',
        SchoolRecords.idBaseOf('schedule') + 8001,
      ))!['class_id'],
      classA,
    );
    passed++;
  }, skip: skip);

  test('W8-IT-03 delete class → the student stays on the server, without a class, in follow-up', () async {
    await ClassBook(manager.db).deleteClass(classA);
    expect((await manager.sync()).waiting, 0);
    expect(await serverRow('classes', classA), isNull);
    final u = await serverRow('users', mergeStudent);
    expect(u, isNotNull, reason: 'students are never deleted with their class');
    expect(u!['class_id'], isNull);
    expect('${u['followup_reason']}', contains('یازدهم شبکه'));
    passed++;
  }, skip: skip);

  test(
    'W8-IT-04 delete subject → its schedule slot is gone on the server too',
    () async {
      await manager.pull();
      final w = await ClassBook(manager.db).deleteSubject(subjectId);
      expect(w.keys, hasLength(2));
      expect((await manager.sync()).waiting, 0);
      expect(await serverRow('subjects', subjectId), isNull);
      expect(
        await serverRow('schedule', SchoolRecords.idBaseOf('schedule') + 8001),
        isNull,
      );
      passed++;
    },
    skip: skip,
  );

  test('W8-IT-05 NEG a teacher cannot change classes or definitions: device AND server refuse', () async {
    await teacher.pull();
    await expectLater(
      ClassBook(teacher.db).saveRoom(name: 'نفوذی'),
      throwsA(
        isA<RecordFailure>().having((f) => f.code, 'code', 'not_allowed'),
      ),
    );
    expect(teacher.outbox.list(), isEmpty);
    final r = await push(teacherLogin.token, [
      {
        'uid': 'evil-w8',
        'collection': 'lookups',
        'type': 'put',
        'id': SchoolRecords.idBaseOf('lookups') + 9,
        'data': {'kind': 'grade', 'name': 'نفوذی'},
        'base_version': 0,
      },
      {
        'uid': 'evil-w8-del',
        'collection': 'classes',
        'type': 'del',
        'id': roomId,
        'base_version': 1,
      },
    ]);
    expect(r['applied'], isEmpty, reason: '$r');
    expect(
      await serverRow('lookups', SchoolRecords.idBaseOf('lookups') + 9),
      isNull,
    );
    expect(await serverRow('classes', roomId), isNotNull);
    negatives += 3;
    passed++;
  }, skip: skip);

  // ───────────────────────────── W9 weekly schedule ─────────────────────────────
  var w9Slot = 0, w9Class = 0, w9Sub = 0, w9Teacher = 0;

  test('W9-IT-01 offline: work days + bells + a slot for a new cohort → queued → all on the server', () async {
    await manager.pull();
    final t = Timetable(manager.db);
    final subj = (await ClassBook(
      manager.db,
    ).saveSubject(name: 'برنامه‌سازی', workshop: false)).id!;
    await t.saveWorkdays(const [0, 1, 2, 3, 4]);
    await t.saveBells(const [
      BellDraft(start: '07:30', end: '08:15'),
      BellDraft(start: '08:15', end: '08:30', type: 'break'),
      BellDraft(start: '08:30', end: '09:15'),
    ]);
    final w = await t.saveSlot(
      SlotDraft(
        grade: 'دوازدهم',
        branch: 'شبکه',
        day: 2,
        period: 1,
        subjectId: subj,
        teacherId: teacherId,
      ),
    );
    w9Slot = w.id!;
    w9Class =
        (await manager.engine.get('schedule', w9Slot))!.data['class_id']!
            as int;
    final dead = Uri.parse('http://127.0.0.1:${await freePort()}');
    final queued = (await manager.sync(dead)).waiting;
    expect(queued, 7, reason: 'subject, schools, 3 bells, class, slot');
    expect(await serverRow('schedule', w9Slot), isNull);
    negatives++;
    expect((await manager.sync()).waiting, 0);
    final sg = await serverRow('schedule', w9Slot);
    expect(sg!['class_id'], w9Class);
    expect(sg['teacher_id'], teacherId);
    expect(sg['weekday'], 2);
    expect((await serverRow('classes', w9Class))!['name'], 'دوازدهم شبکه');
    expect((await serverRow('schools', 1))!['workdays'], [0, 1, 2, 3, 4]);
    final bells = await serverRows('bell_schedules');
    expect(
      bells.map((b) => b['order']).toList()
        ..sort((a, b) => (a! as num).compareTo(b! as num)),
      [1, 1.5, 2],
    );
    passed++;
  }, skip: skip);

  test('W9-IT-02 the teacher pulls it: own teaching view shows the slot (read-only)', () async {
    await teacher.pull();
    final v = await Timetable(teacher.db).view();
    expect(v.canEdit, isFalse);
    final s = v.slots.firstWhere((x) => x.id == w9Slot);
    expect(s.subject, 'برنامه‌سازی');
    expect(v.periods.map((b) => b.order), [
      1,
      2,
    ], reason: 'bells from the server');
    passed++;
  }, skip: skip);

  test('W9-IT-03 substitution by a teacher created offline → both reach the server', () async {
    final t = Timetable(manager.db);
    w9Teacher = (await t.addTeacher('دبیر جایگزین')).id!;
    w9Sub = (await t.saveSub(w9Slot, '2026-11-16', w9Teacher)).id!;
    expect((await manager.sync()).waiting, 0);
    final u = await serverRow('users', w9Teacher);
    expect(u!['role'], 'teacher');
    final sub = await serverRow('substitutions', w9Sub);
    expect(sub!['schedule_id'], w9Slot);
    expect(sub['sub_teacher_id'], w9Teacher);
    expect(sub['date'], '2026-11-16');
    passed++;
  }, skip: skip);

  test('W9-IT-04 NEG clash refused on the device; a teacher cannot write the schedule (device AND server)', () async {
    final m = Timetable(manager.db);
    await expectLater(
      m.saveSlot(
        SlotDraft(
          grade: 'دهم',
          branch: 'x',
          day: 2,
          period: 1,
          subjectId: 41,
          teacherId: teacherId,
        ),
      ),
      throwsA(isA<RecordFailure>().having((f) => f.code, 'code', 'duplicate')),
    );
    expect(manager.outbox.list(), isEmpty);
    await expectLater(
      Timetable(teacher.db).move(w9Slot, 3, 1),
      throwsA(
        isA<RecordFailure>().having((f) => f.code, 'code', 'not_allowed'),
      ),
    );
    expect(teacher.outbox.list(), isEmpty);
    final r = await push(teacherLogin.token, [
      {
        'uid': 'evil-w9',
        'collection': 'schedule',
        'type': 'put',
        'id': w9Slot,
        'data': {'weekday': 4, 'bell_order': 2},
        'base_version': 1,
      },
      {
        'uid': 'evil-w9-bells',
        'collection': 'bell_schedules',
        'type': 'put',
        'id': SchoolRecords.idBaseOf('bell_schedules') + 77,
        'data': {'order': 9, 'type': 'lesson'},
        'base_version': 0,
      },
    ]);
    expect(r['applied'], isEmpty, reason: '$r');
    expect((await serverRow('schedule', w9Slot))!['weekday'], 2);
    expect(
      await serverRow(
        'bell_schedules',
        SchoolRecords.idBaseOf('bell_schedules') + 77,
      ),
      isNull,
    );
    negatives += 4;
    passed++;
  }, skip: skip);

  test(
    'W9-IT-05 delete the slot → its substitution is gone on the server too',
    () async {
      await manager.pull();
      final w = await Timetable(manager.db).deleteSlot(w9Slot);
      expect(w.keys, hasLength(2));
      expect((await manager.sync()).waiting, 0);
      expect(await serverRow('schedule', w9Slot), isNull);
      expect(await serverRow('substitutions', w9Sub), isNull);
      passed++;
    },
    skip: skip,
  );

  // ───────────────────────────── W10 bulk import and follow-up ─────────────────────────────
  var w10Student = 0;
  var w10Bare = 0;

  test('W10-IT-01 offline CSV import → queued → users, parents, links, definitions on the server; the student signs in with mobile + national id', () async {
    await manager.pull();
    final x = SchoolImport(manager.db);
    final s = ImportSession.fromBook(
      SheetReader.csv(
        'نام و نام خانوادگی,کد ملی,موبایل,نام پدر,موبایل پدر,پایه,رشته\n'
        'کیوان واردشده,0099887766,9351110128,رضا,09351110129,یازدهم,مکاترونیک\n'
        'بی‌پایه وارده,,,,,,\n',
      ),
      kind: 'students',
      fileName: 'w10.csv',
      grades: const ['یازدهم'],
    );
    final r = await x.check(s);
    expect(r.ready.length, 2);
    expect(r.phonesFixed, 1);
    final res = await x.apply(s, r);
    expect(res.students, 2);
    expect(res.parents, 1);
    expect(res.savedIssues, 1, reason: 'no national id');
    final dead = Uri.parse('http://127.0.0.1:${await freePort()}');
    final queued = (await manager.sync(dead)).waiting;
    expect(queued, res.keys.length);
    expect(
      queued,
      greaterThanOrEqualTo(6),
      reason: 'new definitions, 2 students, parent, link, issue',
    );
    negatives++;
    expect((await manager.sync()).waiting, 0);
    final users = await serverRows('users');
    final kv = users.firstWhere((u) => u['name'] == 'کیوان واردشده');
    w10Student = (kv['id']! as num).toInt();
    expect(kv['phone'], '09351110128');
    expect(kv['grade'], 'یازدهم');
    expect(kv['field'], 'مکاترونیک');
    expect(
      kv['password_hash'],
      isNotNull,
      reason: 'the server set the default credentials',
    );
    final father = users.firstWhere((u) => u['phone'] == '09351110129');
    expect(father['role'], 'parent');
    final links = await serverRows('parent_links');
    expect(
      links.any(
        (l) =>
            l['student_id'] == w10Student &&
            l['parent_id'] == father['id'] &&
            l['relation'] == 'پدر',
      ),
      isTrue,
    );
    final defs = (await serverRows('lookups')).map((l) => l['name']).toSet();
    expect(defs, containsAll(['یازدهم', 'مکاترونیک']));
    final issues = await serverRows('import_issues');
    expect(issues.single['name'], 'بی‌پایه وارده');
    final login = await lan.login(
      server: server,
      phone: '09351110128',
      password: '0099887766',
      deviceName: 'گوشی کیوان',
    );
    expect(login.role, 'student');
    expect(login.uid, w10Student);
    w10Bare =
        (users.firstWhere((u) => u['name'] == 'بی‌پایه وارده')['id']! as num)
            .toInt();
    passed++;
  }, skip: skip);

  test('W10-IT-02 another manager device pulls the follow-up list; assign + issue done reach the server', () async {
    final other = Device(server, managerLogin, seed: 10);
    await other.pull();
    final f = Followup(other.db);
    final v = await f.view();
    expect(v.issues.map((i) => i.name), contains('بی‌پایه وارده'));
    final issue = v.issues.firstWhere((i) => i.name == 'بی‌پایه وارده');
    expect(issue.userId, w10Bare, reason: 'created, but incomplete');
    expect(
      v.students.any((s) => s.id == w10Bare),
      isFalse,
      reason: 'the file grade (11th, field mode) is complete without a class',
    );
    expect(v.students.any((s) => s.id == w10Student), isFalse);
    await f.assign(w10Bare, grade: 'نهم');
    await f.issueDone(issue.id);
    expect((await other.sync()).waiting, 0);
    final u = await serverRow('users', w10Bare);
    expect(u!['grade'], 'نهم');
    final cls = await serverRow('classes', (u['class_id']! as num).toInt());
    expect(cls!['name'], 'نهم');
    expect((await serverRow('import_issues', issue.id))!['status'], 'done');
    await manager.pull();
    expect((await Followup(manager.db).view()).issues, isEmpty);
    passed++;
  }, skip: skip);

  test('W10-IT-03 past grades and attendance from a sheet reach the server with deterministic ids', () async {
    await manager.pull();
    final x = SchoolImport(manager.db);
    final g = ImportSession.fromBook(
      SheetReader.csv('کد ملی,درس,نمره,نوبت\n0099887766,ریاضی,۱۷/۵,اول\n'),
      kind: 'grades',
      fileName: 'g.csv',
    );
    await x.apply(g, await x.check(g));
    final a = ImportSession.fromBook(
      SheetReader.csv('کد ملی,تاریخ,وضعیت\n0099887766,۱۴۰۵/۸/۱۹,تأخیر\n'),
      kind: 'attendance',
      fileName: 'a.csv',
    );
    await x.apply(a, await x.check(a));
    expect((await manager.sync()).waiting, 0);
    final gid = GradeBook.recordId(
      classId: 0,
      subjectId: 41,
      term: GradeTerm.first,
      studentId: w10Student,
    );
    expect((await serverRow('grades', gid))!['score'], 17.5);
    final aid = AttendanceBook.recordId(w10Student, '2026-11-10');
    expect((await serverRow('attendance', aid))!['status'], 'late');
    passed++;
  }, skip: skip);

  test('W10-IT-04 NEG a taken mobile is refused on the device; a teacher cannot import or write follow-up (device AND server)', () async {
    await manager.pull();
    final x = SchoolImport(manager.db);
    final s = ImportSession.fromBook(
      SheetReader.csv('نام,موبایل\nتکراری وارده,09351110128\n'),
      kind: 'students',
      fileName: 'dup.csv',
      grades: const ['دهم'],
    );
    final r = await x.check(s);
    expect(r.rows.single.errors.single, contains('هر شماره یک حساب دارد'));
    await expectLater(x.apply(s, r), throwsA(isA<RecordFailure>()));
    expect(manager.outbox.list(), isEmpty);
    await expectLater(
      SchoolImport(teacher.db).check(s),
      throwsA(
        isA<RecordFailure>().having((f) => f.code, 'code', 'not_allowed'),
      ),
    );
    await expectLater(
      Followup(teacher.db).ack(w10Student),
      throwsA(
        isA<RecordFailure>().having((f) => f.code, 'code', 'not_allowed'),
      ),
    );
    expect(teacher.outbox.list(), isEmpty);
    final evil = await push(teacherLogin.token, [
      {
        'uid': 'evil-w10-issue',
        'collection': 'import_issues',
        'type': 'put',
        'id': SchoolRecords.idBaseOf('import_issues') + 7,
        'data': {'name': 'x', 'status': 'open'},
        'base_version': 0,
      },
      {
        'uid': 'evil-w10-user',
        'collection': 'users',
        'type': 'put',
        'id': SchoolRecords.idBaseOf('users') + 7,
        'data': {'name': 'دانش‌آموز جعلی', 'role': 'student'},
        'base_version': 0,
      },
    ]);
    expect(evil['applied'], isEmpty, reason: '$evil');
    expect(
      await serverRow(
        'import_issues',
        SchoolRecords.idBaseOf('import_issues') + 7,
      ),
      isNull,
    );
    expect(
      await serverRow('users', SchoolRecords.idBaseOf('users') + 7),
      isNull,
    );
    negatives += 5;
    passed++;
  }, skip: skip);
  test('W11-IT-01 leave decisions: another manager device approves and deletes; the server keeps who/when; NEG a teacher device is refused locally', () async {
    const leaveId = 3000000000128011;
    const gone = 3000000000128012;
    final seeded = await push(managerLogin.token, [
      for (final (id, uid) in [(leaveId, 'w11-leave-a'), (gone, 'w11-leave-b')])
        {
          'uid': uid,
          'collection': 'leaves',
          'type': 'put',
          'id': id,
          'data': {
            'student_id': w10Student,
            'date': '2026-11-20',
            'reason': 'پزشکی',
            'status': 'pending',
            'created_at': '2026-11-12T08:00:00Z',
          },
          'base_version': 0,
        },
    ]);
    expect((seeded['applied'] as List).length, 2, reason: '$seeded');
    final other = Device(server, managerLogin, seed: 11);
    await other.pull();
    final r = SchoolReports(other.db);
    final rows = await r.leaves();
    expect(rows.map((l) => l.id), containsAll([leaveId, gone]));
    expect(rows.firstWhere((l) => l.id == leaveId).student, 'کیوان واردشده');
    await r.decide(leaveId, 'approved');
    await r.deleteLeave(gone);
    expect((await other.sync()).waiting, 0);
    final srv = await serverRow('leaves', leaveId);
    expect(srv!['status'], 'approved');
    expect(srv['decided_by'], managerLogin.uid);
    expect(srv['decided_at'], isA<String>());
    expect(await serverRow('leaves', gone), isNull);
    await teacher.pull();
    await expectLater(
      SchoolReports(teacher.db).decide(leaveId, 'rejected'),
      throwsA(
        isA<RecordFailure>().having((f) => f.code, 'code', 'not_allowed'),
      ),
    );
    expect(teacher.outbox.list(), isEmpty);
    expect((await serverRow('leaves', leaveId))!['status'], 'approved');
    negatives++;
    passed++;
  }, skip: skip);

  test('W11-IT-02 reports and the dashboard are computed from the pulled copy and match the server rows', () async {
    final other = Device(server, managerLogin, seed: 12);
    await other.pull();
    final r = SchoolReports(other.db);
    final d = await r.dashboard();
    final users = await serverRows('users');
    expect(
      d.students,
      users.where((u) => u['role'] == 'student' && u['active'] != false).length,
    );
    expect(d.teachers, users.where((u) => u['role'] == 'teacher').length);
    expect(d.classes, (await serverRows('classes')).length);
    final week = await r.weekly();
    expect(week.length, d.classes);
    final card = await r.card(5);
    expect(card.className, isNotEmpty);
    final day = await r.day('2026-11-10');
    final att = [
      for (final a in await serverRows('attendance'))
        if ('${a['date']}'.startsWith('2026-11-10')) a,
    ];
    expect(
      day.fold<int>(0, (n, c) => n + c.records),
      att
          .where(
            (a) =>
                a['class_id'] != null &&
                day.any((c) => c.classId == (a['class_id']! as num).toInt()),
          )
          .length,
    );
    await expectLater(
      SchoolReports(teacher.db).dashboard(),
      throwsA(
        isA<RecordFailure>().having((f) => f.code, 'code', 'not_allowed'),
      ),
    );
    negatives++;
    passed++;
  }, skip: skip);

  // ───────────────────── W12 school-server management ─────────────────────
  // Online by design: each action works on the school server's own disk / device table /
  // audit log / cloud settings, so LanServerAdmin calls the server directly.
  late LanSession extra;
  LanServerAdmin adminOf(LanSession who) =>
      LanServerAdmin(client: lan, server: server, token: () async => who.token);

  test(
    'W12-IT-01 backup now, backup list, mirror refresh and restore from the mirror file; '
    'NEG a teacher can do none of it, a non-backup file is refused',
    () async {
      final m = adminOf(managerLogin);
      // a second manager device, revoked in W12-IT-02 (signed in before the restore below)
      extra = await lan.login(
        server: server,
        phone: '09120000128',
        password: 'modir-new', // changed in W7-IT
        deviceName: 'it-w12-extra',
      );
      final h = await m.health();
      expect(h.school, 'هنرستان آزمون ۱۲۸');
      expect(h.version, isNotEmpty);
      final file = await m.backupNow();
      expect(file, endsWith('.sqlite'));
      expect(await m.backups(), contains(file));
      final mir = await m.mirrorRefresh();
      expect(mir.total, greaterThan(0));
      expect(
        mir.ok,
        isTrue,
        reason: 'mirror equals the database right after a refresh',
      );
      expect(mir.daily, isNotEmpty);
      expect((await m.mirror()).total, mir.total);
      final (st, data) = await raw(
        'GET',
        svc.base.resolve('/api/admin/mirror/download'),
        token: managerLogin.token,
      );
      expect(st, 200);
      final parsed = BackupFile.parse(utf8.encode(jsonEncode(data)));
      final rep = await m.restore(parsed);
      expect(rep.restored, greaterThan(0));
      expect(rep.safety, endsWith('.sqlite'));
      await expectLater(
        m.restore({'format': 'other', 'collections': <String, Object?>{}}),
        throwsA(
          isA<AdminFailure>().having(
            (f) => f.kind,
            'kind',
            AdminError.notBackup,
          ),
        ),
      );
      negatives++;
      final t = adminOf(teacherLogin);
      for (final call in <Future<Object?> Function()>[
        t.backupNow,
        t.backups,
        t.mirrorRefresh,
        () => t.restore(parsed),
      ]) {
        await expectLater(
          call(),
          throwsA(
            isA<AdminFailure>().having(
              (f) => f.kind,
              'kind',
              AdminError.notManager,
            ),
          ),
        );
        negatives++;
      }
      passed++;
    },
    skip: skip,
  );

  test(
    'W12-IT-02 devices list, revoke a device (its token stops working), audit shows it, '
    'school name saved; NEG a teacher cannot list devices or read the audit',
    () async {
      final m = adminOf(managerLogin);
      final before = await m.devices();
      final d = before.firstWhere(
        (x) => x.name == 'it-w12-extra' && !x.revoked,
      );
      expect(d.userId, managerLogin.uid);
      await m.revokeDevice(d.id);
      expect(
        (await m.devices()).firstWhere((x) => x.id == d.id).revoked,
        isTrue,
      );
      final (st, _) = await raw(
        'GET',
        svc.base.resolve('/api/v1/pull?collections=users'),
        token: extra.token,
      );
      expect(st, isNot(200), reason: 'a revoked device is refused');
      negatives++;
      final log = await m.audit(limit: 50);
      expect(log.map((a) => a.action), contains('device_revoke'));
      await m.saveSettings(name: 'هنرستان آزمون ۱۲۸ ب');
      expect((await serverRow('schools', 1))!['name'], 'هنرستان آزمون ۱۲۸ ب');
      expect((await m.health()).school, 'هنرستان آزمون ۱۲۸ ب');
      await m.saveSettings(name: 'هنرستان آزمون ۱۲۸');
      await expectLater(
        m.revokeDevice('../x'),
        throwsA(
          isA<AdminFailure>().having(
            (f) => f.kind,
            'kind',
            AdminError.notFound,
          ),
        ),
      );
      negatives++;
      final t = adminOf(teacherLogin);
      for (final call in <Future<Object?> Function()>[
        t.devices,
        () => t.audit(),
        () => t.saveSettings(name: 'x'),
      ]) {
        await expectLater(
          call(),
          throwsA(
            isA<AdminFailure>().having(
              (f) => f.kind,
              'kind',
              AdminError.notManager,
            ),
          ),
        );
        negatives++;
      }
      passed++;
    },
    skip: skip,
  );

  test('W12-IT-03 cloud settings: save (key write-only), test / CORS / phone check report '
      'their steps, reset to the built-in default; NEG the key never comes back, a teacher '
      'cannot read the settings', () async {
    final m = adminOf(managerLogin);
    const secret = 'it-secret-never-returned-128';
    final ok = await m.cloudSave(
      const CloudForm(
        endpoint: 'http://127.0.0.1:1',
        bucket: 'it-bucket',
        region: 'it-1',
        accessKey: 'AKITW12KEY',
        secret: secret,
      ),
    );
    expect(ok, isTrue);
    final c = await m.cloud();
    expect(c.configured, isTrue);
    expect(c.builtIn, isFalse);
    expect(c.bucket, 'it-bucket');
    expect(c.accessHint, 'AKIT…');
    expect(c.stateFa, 'آماده');
    final (st, j) = await raw(
      'GET',
      svc.base.resolve('/api/admin/cloud'),
      token: managerLogin.token,
    );
    expect(st, 200);
    expect(jsonEncode(j), isNot(contains(secret)));
    expect(jsonEncode(j), isNot(contains('AKITW12KEY')));
    negatives++;
    final test = await m.cloudTest();
    expect(test.ok, isFalse, reason: 'nothing listens on 127.0.0.1:1');
    expect(test.headlineFa, startsWith('وصل نشد'));
    final cors = await m.cloudCors();
    expect(cors.ok, isFalse);
    expect(cors.headlineFa, 'تنظیم خودکار نشد');
    final phone = await m.phoneCheck();
    expect(phone.ok, isFalse);
    expect(phone.steps.first.name, 'پیدا کردن صندوقچه');
    expect(phone.steps.first.ok, isTrue);
    await m.cloudReset();
    final back = await m.cloud();
    expect(back.builtIn, isTrue);
    expect(back.bucket, isNot('it-bucket'));
    final log = await m.audit(limit: 50);
    expect(
      log.map((a) => a.action),
      containsAll([
        'cloud_config',
        'cloud_test',
        'cloud_phone_check',
        'cloud_reset',
      ]),
    );
    await expectLater(
      adminOf(teacherLogin).cloud(),
      throwsA(
        isA<AdminFailure>().having(
          (f) => f.kind,
          'kind',
          AdminError.notManager,
        ),
      ),
    );
    negatives++;
    final steps = await diagnoseConnection(
      server: server,
      admin: m,
      signedIn: true,
      queued: 0,
    );
    expect(steps[1].textFa, 'سرور مدرسه جواب می‌دهد');
    expect(steps[1].detail, contains('هنرستان آزمون ۱۲۸'));
    final down = await diagnoseConnection(
      server: Uri.parse('http://127.0.0.1:1'),
      admin: LanServerAdmin(
        client: lan,
        server: Uri.parse('http://127.0.0.1:1'),
        token: () async => managerLogin.token,
      ),
      signedIn: true,
      queued: 0,
    );
    expect(down[1].ok, isFalse);
    expect(down[1].textFa, 'به سرور مدرسه دسترسی نداریم (شبکه/نشانی)');
    negatives++;
    passed++;
  }, skip: skip);

  test('W12-IT-04 data health on the pulled copy: a safe fix is queued and reaches the '
      'server; NEG a teacher cannot run the checks', () async {
    final other = Device(server, managerLogin, seed: 13);
    const orphanId = 3700000000000001;
    await push(managerLogin.token, [
      {
        'uid': 'w12-orphan',
        'collection': 'parent_links',
        'type': 'put',
        'id': orphanId,
        'data': {'parent_id': 987654, 'student_id': 987655},
      },
    ]);
    await other.pull();
    final h = DataHealth(other.db);
    final link = await h.check('orphan-link');
    expect(link.ok, isFalse);
    expect(link.items.map((i) => i.id), contains(orphanId));
    final fix = await h.fix('orphan-link');
    expect(fix.queued, isTrue);
    expect((await other.sync()).waiting, 0);
    expect(await serverRow('parent_links', orphanId), isNull);
    expect((await h.check('orphan-link')).ok, isTrue);
    await expectLater(
      DataHealth(teacher.db).run(),
      throwsA(
        isA<RecordFailure>().having((f) => f.code, 'code', 'not_allowed'),
      ),
    );
    negatives++;
    passed++;
  }, skip: skip);
}
