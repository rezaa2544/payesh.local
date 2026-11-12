// Row 127 — the native app against the school's OWN server on the local network: the REAL
// server/index.js started as the headless data service (PAYESH_HEADLESS=1, what the school
// Windows installer runs), not a mock. Runs only when PAYESH_SERVER_IT=1 (CI job
// `sync-real-server` in native-client.yml).
//
// Path under test = the app's LAN data path: LanAccessClient (probe → first setup → login →
// refresh with rotation) → DeviceOwner.claim(lan-<instance>/<uid>) → SyncClient pull over
// HttpSyncTransport (`/api/v1/pull`) into SQLite → AttendanceBook (local write + SqliteOutbox)
// → AutoSync → HttpSyncTransport.push (`/api/sync`).
@Tags(['server'])
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

final bool enabled = Platform.environment['PAYESH_SERVER_IT'] == '1';

/// Row 127 acceptance on Windows: point the test at the INSTALLED data service (silent install of
/// payesh-data-service-setup.exe in native-client.yml) instead of spawning server/index.js.
final String? installedUrl = Platform.environment['PAYESH_LAN_IT_URL'];
final String node = Platform.environment['PAYESH_NODE'] ?? 'node';
final String repoRoot =
    Platform.environment['PAYESH_REPO_ROOT'] ??
    Directory('../../../..').absolute.path;

const day = '2026-11-12';

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

  /// The installed service: nothing to spawn, only wait for it.
  bool get external => installedUrl != null;

  Future<void> start() async {
    if (external) {
      port = Uri.parse(installedUrl!).port;
      return _waitHealthy();
    }
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
        // all interfaces, like the installed service (other devices of the school reach it)
        'HOST': '0.0.0.0',
        'PAYESH_HEADLESS': '1',
        'PAYESH_DATA': dataDir,
        'PAYESH_LOG': '0',
        'PAYESH_AUTO_BACKUP': '0',
        'PAYESH_UPDATE_AUTO': '0',
        'PAYESH_LIVE_MS': '0',
        'PAYESH_OUTBOX_AUTO': '0',
        'PAYESH_CLOUD_AUTO': '0',
        'PAYESH_MIRROR': '0',
        // a replayed (stolen/duplicated) device token is caught at once in this test
        'PAYESH_REFRESH_GRACE_SEC': '0',
      },
    );
    _p!.stdout.transform(utf8.decoder).listen(log.write);
    _p!.stderr.transform(utf8.decoder).listen(log.write);
    await _waitHealthy();
  }

  Future<void> _waitHealthy() async {
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

/// Raw HTTP (status + headers + body), for the checks the typed clients hide.
Future<(int, String, String)> raw(
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
    return (res.statusCode, res.headers.contentType?.mimeType ?? '', text);
  } finally {
    c.close(force: true);
  }
}

/// One device on the school LAN: its own SQLite, outbox, transport and attendance book.
final class LanDevice {
  LanDevice({required this.server, required this.session, required this.school})
    : engine = SqliteEngine.inMemory() {
    outbox = SqliteOutbox(
      engine.database,
      config: const OutboxConfig(jitter: 0),
    );
    token = session.token;
  }
  final Uri server;
  LanSession session;
  final String school;
  final SqliteEngine engine;
  late final SqliteOutbox outbox;
  late String token;

  HttpSyncTransport transport(Uri to) => HttpSyncTransport(
    baseUri: to,
    token: () => token,
    deviceId: 'pd-lan127device',
  );

  SyncClient client(Uri to) =>
      SyncClient(engine: engine, outbox: outbox, transport: transport(to));

  AttendanceBook get book => AttendanceBook(
    engine: engine,
    outbox: outbox,
    role: session.role,
    uid: session.uid,
  );

  AutoSync auto(Uri to) {
    final t = transport(to);
    final s = SyncClient(engine: engine, outbox: outbox, transport: t);
    return AutoSync(
      outbox: outbox,
      push: t.push,
      pull: () async {
        await s.pull();
      },
      idleInterval: const Duration(hours: 1),
    );
  }
}

void main() {
  late Directory dir;
  late DataService svc;
  late LanAccessClient lan;
  late LanServerInfo info;
  late LanSession manager;
  late LanSession teacherLogin;
  late LanDevice teacher;
  var passed = 0;
  var negatives = 0;
  const teacherPhone = '09120000010';
  const teacherPassword = 'moalem-127';
  var teacherId = 0;
  final students = <int>[];

  Future<List<Map<String, Object?>>> serverAttendance() async {
    final (st, _, body) = await raw(
      'GET',
      svc.base.resolve('/api/v1/pull?collections=attendance'),
      token: manager.token,
    );
    expect(st, 200, reason: body);
    final cols = (jsonDecode(body) as Map)['collections'] as Map;
    return [
      for (final r in (cols['attendance'] as List? ?? const []))
        (r as Map).cast<String, Object?>(),
    ];
  }

  setUpAll(() async {
    if (!enabled) return;
    dir = await Directory.systemTemp.createTemp('payesh-lan127-');
    svc = DataService(dir.path);
    await svc.start();
    lan = LanAccessClient(platform: 'it', refreshRetryDelays: const []);
  });

  tearDownAll(() async {
    if (!enabled) return;
    lan.close();
    // ignore: avoid_print
    print('NATIVE-LAN-IT passed=$passed negative_controls=$negatives');
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

  test('LAN-IT-01 data service: Payesh server, headless, fresh — and NO web UI is served', () async {
    info = await lan.probe(svc.base);
    expect(info.headless, isTrue);
    expect(info.setupDone, isFalse);
    expect(info.schoolCode, startsWith('lan-'));
    for (final u in info.lanUrls) {
      expect(LanServerRules.parse(u), isNotNull, reason: u);
    }
    expect(SchoolAccessRules.school.hasMatch(info.schoolCode), isTrue);
    // NEG: the browser UI of the old client is not there (D‑49: the UI is the native app only)
    for (final path in [
      '/',
      '/index.html',
      '/install',
      '/join/ABCD-EFGH',
      '/app.js',
    ]) {
      final (st, mime, body) = await raw('GET', svc.base.resolve(path));
      expect(st, 404, reason: path);
      expect(mime, 'application/json', reason: path);
      expect(body, contains('no_web_ui'), reason: path);
      expect(body.toLowerCase(), isNot(contains('<html')), reason: path);
      negatives++;
    }
    passed++;
  }, skip: skip);

  test(
    'LAN-IT-02 NEG first setup from another device of the network is refused',
    () async {
      // the data service listens on every interface; any non-loopback address of this machine
      // stands in for "another device on the school network"
      InternetAddress? other;
      for (final i in await NetworkInterface.list(
        type: InternetAddressType.IPv4,
        includeLinkLocal: true,
      )) {
        for (final a in i.addresses) {
          if (!a.isLoopback) other ??= a;
        }
      }
      if (other == null) {
        markTestSkipped('no non-loopback IPv4 address on this machine');
        return;
      }
      final remote = Uri.parse('http://${other.address}:${svc.port}/api/setup');
      final (st, _, body) = await raw(
        'POST',
        remote,
        body: {
          'school_name': 'نفوذی',
          'manager_name': 'مهاجم شبکه',
          'phone': '09129999999',
          'password': 'xxxx1234',
        },
      );
      expect(st, 403, reason: body);
      expect(body, contains('setup_local_only'));
      expect(
        mapLanError(st, (jsonDecode(body) as Map).cast(), null).kind,
        LanAccessError.setupLocalOnly,
      );
      expect(
        (await lan.probe(svc.base)).setupDone,
        isFalse,
        reason: 'nothing was set up',
      );
      negatives++;
      passed++;
    },
    skip: skip,
  );

  test('LAN-IT-03 first setup on the server computer → manager signed in (device token)', () async {
    manager = await lan.setup(
      server: info.server,
      schoolName: 'هنرستان آزمون ۱۲۷',
      managerName: 'مدیر آزمون',
      phone: '۰۹۱۲۰۰۰۰۱۲۷',
      password: 'modir-127',
    );
    expect(manager.role, 'manager');
    expect(manager.deviceToken, isNotEmpty);
    final again = await lan.probe(svc.base);
    expect(again.setupDone, isTrue);
    expect(again.schoolName, 'هنرستان آزمون ۱۲۷');
    // NEG: a second setup is refused
    await expectLater(
      lan.setup(
        server: info.server,
        schoolName: 'x',
        managerName: 'دومی',
        phone: '09121111111',
        password: 'abcd1234',
      ),
      throwsA(
        isA<LanAccessFailure>().having(
          (e) => e.kind,
          'kind',
          LanAccessError.alreadySetup,
        ),
      ),
    );
    negatives++;
    // the manager's own login works too (phone + password)
    final m2 = await lan.login(
      server: info.server,
      phone: '09120000127',
      password: 'modir-127',
      deviceName: 'it',
    );
    expect(m2.role, 'manager');
    // seed the school through the same Sync v1 API (class 5 with two students, a teacher)
    Future<List<Object?>> push(List<Map<String, Object?>> ops) async {
      final (st, _, body) = await raw(
        'POST',
        svc.base.resolve('/api/sync'),
        token: manager.token,
        body: {'ops': ops},
      );
      expect(st, 200, reason: body);
      final j = jsonDecode(body) as Map;
      expect(j['rejected'], isEmpty, reason: body);
      return j['applied'] as List<Object?>;
    }

    await push([
      {
        'uid': 'seed-class',
        'collection': 'classes',
        'type': 'put',
        'id': 5,
        'data': {'name': 'دهم الف'},
      },
      {
        'uid': 'seed-class-6',
        'collection': 'classes',
        'type': 'put',
        'id': 6,
        'data': {'name': 'یازدهم ب'},
      },
    ]);
    final applied = await push([
      {
        'uid': 'seed-teacher',
        'collection': 'users',
        'type': 'put',
        'data': {
          'name': 'معلم آزمون',
          'role': 'teacher',
          'phone': teacherPhone,
          'active': true,
        },
      },
      {
        'uid': 'seed-s1',
        'collection': 'users',
        'type': 'put',
        'data': {
          'name': 'دانش‌آموز یک',
          'role': 'student',
          'class_id': 5,
          'active': true,
        },
      },
      {
        'uid': 'seed-s2',
        'collection': 'users',
        'type': 'put',
        'data': {
          'name': 'دانش‌آموز دو',
          'role': 'student',
          'class_id': 5,
          'active': true,
        },
      },
    ]);
    final ids = [for (final a in applied) ((a! as Map)['id']! as num).toInt()];
    teacherId = ids[0];
    students.addAll(ids.sublist(1));
    await push([
      {
        'uid': 'seed-schedule',
        'collection': 'schedule',
        'type': 'put',
        'data': {
          'class_id': 5,
          'teacher_id': teacherId,
          'day': 1,
          'period': 1,
          'subject': 'ریاضی',
        },
      },
    ]);
    final (st, _, body) = await raw(
      'POST',
      svc.base.resolve('/api/admin/users/$teacherId/password'),
      token: manager.token,
      body: {'password': teacherPassword},
    );
    expect(st, 200, reason: body);
    passed++;
  }, skip: skip);

  test('LAN-IT-04 teacher signs in with phone + password; wrong password is refused', () async {
    await expectLater(
      lan.login(
        server: info.server,
        phone: teacherPhone,
        password: 'wrong-pass',
        deviceName: 'it',
      ),
      throwsA(
        isA<LanAccessFailure>().having(
          (e) => e.kind,
          'kind',
          LanAccessError.badCredentials,
        ),
      ),
    );
    negatives++;
    teacherLogin = await lan.login(
      server: info.server,
      phone: teacherPhone,
      password: teacherPassword,
      deviceName: 'گوشی معلم',
    );
    expect(teacherLogin.role, 'teacher');
    expect(teacherLogin.uid, teacherId);
    expect(teacherLogin.deviceToken, isNot(manager.deviceToken));
    // NEG: without a token the data API answers 401 (nothing leaks to an anonymous device)
    final (st, _, _) = await raw('GET', svc.base.resolve('/api/v1/pull'));
    expect(st, 401);
    negatives++;
    passed++;
  }, skip: skip);

  test(
    'LAN-IT-05 pull into the device: the teacher\'s class and its students',
    () async {
      final again = await lan.probe(svc.base);
      teacher = LanDevice(
        server: info.server,
        session: teacherLogin,
        school: again.schoolCode,
      );
      final claim = await DeviceOwner.claim(
        teacher.engine,
        teacher.outbox,
        DeviceOwner.tag(again.schoolCode, teacherLogin.uid),
      );
      expect(claim, DeviceClaim.fresh);
      final r = await teacher.client(info.server).pull();
      expect(r.rows, greaterThan(0));
      final classes = await teacher.book.classes();
      expect(classes.map((c) => c.id), [5], reason: 'only the scheduled class');
      final roster = await teacher.book.roster(5, day);
      expect(roster.map((e) => e.studentId).toSet(), students.toSet());
      passed++;
    },
    skip: skip,
  );

  test('LAN-IT-06 offline save → queued, nothing sent → server back → applied exactly once', () async {
    final res = await teacher.book.save(
      classId: 5,
      date: day,
      marks: {students[0]: AttendanceStatus.absent},
    );
    expect(res.written, 2);
    final dead = Uri.parse('http://127.0.0.1:${await freePort()}');
    final s1 = await teacher.auto(dead).runOnce();
    expect(s1.phase, SyncPhase.offline);
    expect(s1.waiting, 2);
    expect(
      await serverAttendance(),
      isEmpty,
      reason: 'nothing reached the server',
    );
    negatives++;
    teacher.outbox.wake();
    final s2 = await teacher.auto(info.server).runOnce();
    expect(s2.phase, SyncPhase.idle, reason: '${s2.lastError}\n${svc.log}');
    expect(s2.waiting, 0);
    final rows = await serverAttendance();
    expect(rows.length, 2);
    final byStudent = {for (final r in rows) r['student_id']: r['status']};
    expect(byStudent, {students[0]: 'absent', students[1]: 'present'});
    expect(rows.map((r) => r['id']).toSet(), {
      for (final s in students) AttendanceBook.recordId(s, day),
    });
    // a second cycle sends nothing new and creates no duplicate
    final s3 = await teacher.auto(info.server).runOnce();
    expect(s3.waiting, 0);
    expect((await serverAttendance()).length, 2);
    passed++;
  }, skip: skip);

  test('LAN-IT-07 refresh rotates the device token; a replayed old token revokes the device', () async {
    final fresh = await lan.refresh(
      server: info.server,
      deviceToken: teacherLogin.deviceToken,
    );
    expect(fresh.deviceToken, isNot(teacherLogin.deviceToken));
    expect(fresh.uid, teacherId);
    teacher
      ..session = fresh
      ..token = fresh.token;
    // the new access token works on the data API
    await teacher.client(info.server).pull();
    // the installed service keeps the default 30 s grace (a lost reply may be retried): wait it out
    if (svc.external) await Future<void>.delayed(const Duration(seconds: 31));
    // NEG: the old device token is replayed (copied/stolen) → server revokes the device family
    await expectLater(
      lan.refresh(server: info.server, deviceToken: teacherLogin.deviceToken),
      throwsA(
        isA<LanAccessFailure>().having(
          (e) => e.kind,
          'kind',
          LanAccessError.deviceRevoked,
        ),
      ),
    );
    await expectLater(
      lan.refresh(server: info.server, deviceToken: fresh.deviceToken),
      throwsA(
        isA<LanAccessFailure>().having(
          (e) => e.kind,
          'kind',
          LanAccessError.deviceRevoked,
        ),
      ),
      reason: 'the successor dies with it',
    );
    negatives += 2;
    passed++;
  }, skip: skip);
}
