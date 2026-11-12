// Row 127 — LAN mode: the native app signs in to the school's OWN server on the local network
// (same login as that server: phone/national id + password) and syncs over Sync v1 with the same
// durable outbox and AutoSync. Widget tests drive the REAL screens and the REAL SessionController
// with a scripted LanAccessApi; the data-path group runs the REAL LanAccessClient +
// GatewayAttendanceSource (LAN branch) against a local Sync v1 HTTP server. The real
// server/index.js path is packages/payesh_sync/test/lan_server_it_test.dart.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/app.dart';
import 'package:payesh_app/src/attendance/attendance_wiring.dart';
import 'package:payesh_app/src/flags.dart';
import 'package:payesh_app/src/login/session_controller.dart';
import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_sync/payesh_sync.dart';

/// Gateway side is never used in these tests.
final class NoGateway implements SchoolAccessApi {
  @override
  Future<SchoolRoute> resolve(String schoolCode) =>
      Future.error(StateError('unexpected resolve'));
  @override
  Future<Activation> activate({
    required Uri cell,
    required String school,
    required String code,
    required String deviceId,
  }) => Future.error(StateError('unexpected activate'));
  @override
  Future<SchoolSession> refresh({
    required Uri cell,
    required String school,
    required String deviceId,
    required String deviceSecret,
  }) => Future.error(StateError('unexpected gateway refresh'));
}

final lanServer = Uri.parse('http://192.168.1.10:8080');

LanSession lanSession({
  String role = 'teacher',
  int uid = 10,
  String token = 'acc-1',
  String device = 'dt-1',
}) => LanSession(
  token: token,
  expiresAt: DateTime.utc(2030),
  deviceToken: device,
  uid: uid,
  role: role,
);

/// Scripted LAN server: each call pops the next answer (value or LanAccessFailure).
final class FakeLan implements LanAccessApi {
  final calls = <String>[];
  final probes = <Object>[];
  final logins = <Object>[];
  final setups = <Object>[];
  final refreshes = <Object>[];

  Future<T> _next<T>(List<Object> q, String what) {
    calls.add(what);
    if (q.isEmpty) return Future.error(StateError('unexpected $what'));
    final v = q.removeAt(0);
    return v is LanAccessFailure ? Future.error(v) : Future.value(v as T);
  }

  @override
  Future<LanServerInfo> probe(Uri server) =>
      _next(probes, 'probe:${server.host}:${server.port}');

  @override
  Future<LanSession> login({
    required Uri server,
    required String phone,
    required String password,
    required String deviceName,
  }) => _next(logins, 'login:$phone:$password');

  @override
  Future<LanSession> setup({
    required Uri server,
    required String schoolName,
    required String managerName,
    required String phone,
    required String password,
  }) => _next(setups, 'setup:$schoolName:$managerName:$phone');

  @override
  Future<LanSession> refresh({
    required Uri server,
    required String deviceToken,
  }) => _next(refreshes, 'refresh:$deviceToken');

  @override
  Future<void> logout({required Uri server, required String token}) async {
    calls.add('logout:$token');
  }
}

LanServerInfo serverInfo({bool setupDone = true}) => LanServerInfo(
  server: lanServer,
  setupDone: setupDone,
  headless: true,
  schoolName: setupDone ? 'هنرستان شهید آزمون' : null,
  instance: 'ab12cd34',
);

Future<SessionController> boot(
  WidgetTester tester, {
  FakeLan? lan,
  bool withLan = true,
  FakeSecureStore? store,
}) async {
  final c = SessionController(
    api: NoGateway(),
    accounts: SchoolAccountStore(store ?? FakeSecureStore()),
    flags: ClientFlags.parse(),
    lan: withLan ? (lan ?? FakeLan()) : null,
    now: () => DateTime.utc(2026, 11, 12, 8),
  );
  addTearDown(c.dispose);
  await tester.pumpWidget(
    PayeshApp(session: c, today: () => DateTime(2026, 11, 12)),
  );
  await c.start();
  await tester.pumpAndSettle();
  return c;
}

Future<void> typeAndTap(
  WidgetTester tester,
  Map<String, String> fields,
  String button,
) async {
  for (final e in fields.entries) {
    await tester.enterText(find.byKey(Key(e.key)), e.value);
  }
  await tester.tap(find.byKey(Key(button)));
  await tester.pumpAndSettle();
}

String errorText(WidgetTester tester) =>
    tester.widget<Text>(find.byKey(const Key('login-error'))).data!;

Future<FakeSecureStore> savedLan({String token = 'dt-1'}) async {
  final store = FakeSecureStore();
  await LanAccountStore(store).save(
    SavedLan(
      server: lanServer,
      school: 'lan-ab12cd34',
      deviceToken: token,
      schoolName: 'هنرستان شهید آزمون',
      role: 'teacher',
      uid: 10,
    ),
  );
  return store;
}

void main() {
  group('LAN login screens (real controller, scripted server)', () {
    testWidgets(
      'L127-W01 step 1 offers the school-LAN login; NEG not in a build without LAN',
      (tester) async {
        await boot(tester);
        expect(find.byKey(const Key('school-code')), findsOneWidget);
        expect(find.byKey(const Key('use-lan')), findsOneWidget);
        await tester.pumpWidget(const SizedBox());
        await boot(tester, withLan: false);
        expect(find.byKey(const Key('use-lan')), findsNothing);
      },
    );

    testWidgets(
      'L127-W02 address → server name → phone + password → signed in on the LAN server',
      (tester) async {
        final lan = FakeLan()
          ..probes.add(serverInfo())
          ..logins.addAll([
            const LanAccessFailure(LanAccessError.badCredentials, status: 401),
            lanSession(),
          ]);
        final store = FakeSecureStore();
        final c = await boot(tester, lan: lan, store: store);
        await tester.tap(find.byKey(const Key('use-lan')));
        await tester.pumpAndSettle();
        expect(find.byKey(const Key('lan-server')), findsOneWidget);
        // NEG: a public internet address is refused on the device — no request at all
        await typeAndTap(tester, {'lan-server': '8.8.8.8'}, 'lan-next');
        expect(errorText(tester), LanAccessError.badAddress.messageFa());
        expect(lan.calls, isEmpty);
        await typeAndTap(tester, {'lan-server': '۱۹۲.۱۶۸.۱.۱۰'}, 'lan-next');
        expect(lan.calls, ['probe:192.168.1.10:8080']);
        expect(find.text('هنرستان شهید آزمون'), findsOneWidget);
        expect(find.byKey(const Key('lan-password')), findsOneWidget);
        // NEG: wrong password → one clear message, still on the form, nothing saved
        await typeAndTap(tester, {
          'lan-phone': '09120000010',
          'lan-password': 'wrong',
        }, 'lan-login');
        expect(errorText(tester), LanAccessError.badCredentials.messageFa());
        expect(await store.read(LanKeys.deviceToken), isNull);
        await typeAndTap(tester, {
          'lan-phone': '09120000010',
          'lan-password': 'moalem-127',
        }, 'lan-login');
        expect(lan.calls.last, 'login:09120000010:moalem-127');
        final s = c.state as SignedIn;
        expect(s.onLan, isTrue);
        expect(s.school, 'lan-ab12cd34');
        expect(s.currentRole, 'teacher');
        expect(c.onLan, isTrue);
        expect(c.cellUrl, lanServer);
        expect(find.byKey(const Key('session-lan-server')), findsOneWidget);
        expect(find.text('هنرستان شهید آزمون'), findsOneWidget);
        // the device token is in the secure store, the password is not stored anywhere
        expect(await store.read(LanKeys.deviceToken), 'dt-1');
        expect(await store.read(LanKeys.server), 'http://192.168.1.10:8080');
        expect(store.values.values, isNot(contains('moalem-127')));
        expect(await c.validToken(), 'acc-1');
      },
    );

    testWidgets(
      'L127-W03 restart: refresh rotates the device token and saves the new one',
      (tester) async {
        final store = await savedLan();
        final lan = FakeLan()
          ..refreshes.add(lanSession(token: 'acc-2', device: 'dt-2'));
        final c = await boot(tester, lan: lan, store: store);
        expect(lan.calls, ['refresh:dt-1']);
        expect(await store.read(LanKeys.deviceToken), 'dt-2');
        expect((c.state as SignedIn).session?.token, 'acc-2');
        expect(c.onLan, isTrue);
      },
    );

    testWidgets(
      'L127-W04 offline at start: still signed in (offline-first), token kept',
      (tester) async {
        final store = await savedLan();
        final lan = FakeLan()
          ..refreshes.add(const LanAccessFailure(LanAccessError.unreachable));
        final c = await boot(tester, lan: lan, store: store);
        final s = c.state as SignedIn;
        expect(s.onLan, isTrue);
        expect(s.session, isNull);
        expect(s.currentUid, 10);
        expect(c.sync.value.phase, SyncPhase.offline);
        expect(await store.read(LanKeys.deviceToken), 'dt-1');
      },
    );

    testWidgets(
      'L127-W05 NEG revoked/reused device token → signed out to the LAN form, token wiped',
      (tester) async {
        final store = await savedLan();
        final lan = FakeLan()
          ..refreshes.add(
            const LanAccessFailure(
              LanAccessError.deviceRevoked,
              status: 401,
              wire: 'device_revoked',
            ),
          );
        final c = await boot(tester, lan: lan, store: store);
        expect(c.state, isA<NeedLan>());
        expect(errorText(tester), LanAccessError.deviceRevoked.messageFa());
        expect(await store.read(LanKeys.deviceToken), isNull);
        expect(c.onLan, isFalse);
      },
    );

    testWidgets('L127-W06 fresh server: first setup form → manager signed in', (
      tester,
    ) async {
      final lan = FakeLan()
        ..probes.add(serverInfo(setupDone: false))
        ..setups.add(lanSession(role: 'manager', uid: 1));
      final c = await boot(tester, lan: lan);
      c.useLan();
      await tester.pumpAndSettle();
      await typeAndTap(tester, {'lan-server': '192.168.1.10'}, 'lan-next');
      expect(find.byKey(const Key('lan-setup-submit')), findsOneWidget);
      // NEG: short manager name → message, nothing sent
      await typeAndTap(tester, {
        'lan-setup-school': 'هنرستان نو',
        'lan-setup-manager': 'ab',
        'lan-phone': '09120000127',
        'lan-password': 'modir-127',
      }, 'lan-setup-submit');
      expect(errorText(tester), contains('نام مدیر'));
      expect(lan.calls.where((x) => x.startsWith('setup')), isEmpty);
      await typeAndTap(tester, {
        'lan-setup-manager': 'مدیر آزمون',
      }, 'lan-setup-submit');
      expect(lan.calls.last, 'setup:هنرستان نو:مدیر آزمون:09120000127');
      final s = c.state as SignedIn;
      expect(s.currentRole, 'manager');
      expect(s.schoolName, 'هنرستان نو');
    });

    testWidgets(
      'L127-W07 setup refused off the server computer → the one clear message',
      (tester) async {
        final lan = FakeLan()
          ..probes.add(serverInfo(setupDone: false))
          ..setups.add(
            const LanAccessFailure(LanAccessError.setupLocalOnly, status: 403),
          );
        final c = await boot(tester, lan: lan);
        c.useLan();
        await tester.pumpAndSettle();
        await typeAndTap(tester, {'lan-server': '192.168.1.10'}, 'lan-next');
        await typeAndTap(tester, {
          'lan-setup-school': 'x',
          'lan-setup-manager': 'مدیر آزمون',
          'lan-phone': '09120000127',
          'lan-password': 'modir-127',
        }, 'lan-setup-submit');
        expect(errorText(tester), LanAccessError.setupLocalOnly.messageFa());
        expect(c.state, isA<NeedLan>());
      },
    );

    testWidgets(
      'L127-W08 sign-out forgets the LAN account and tells the server',
      (tester) async {
        final store = await savedLan();
        final lan = FakeLan()..refreshes.add(lanSession(device: 'dt-2'));
        final c = await boot(tester, lan: lan, store: store);
        await c.signOut();
        await tester.pumpAndSettle();
        expect(c.state, isA<NeedLan>());
        expect(lan.calls.last, 'logout:acc-1');
        for (final k in LanKeys.all) {
          expect(await store.read(k), isNull, reason: k);
        }
        // back to the school-code login is one tap away
        await tester.tap(find.byKey(const Key('lan-back')));
        await tester.pumpAndSettle();
        expect(find.byKey(const Key('school-code')), findsOneWidget);
      },
    );

    testWidgets(
      'L127-W09 NEG not a Payesh server / server off → message, nothing saved',
      (tester) async {
        final store = FakeSecureStore();
        final lan = FakeLan()
          ..probes.addAll([
            const LanAccessFailure(LanAccessError.notSchoolServer),
            const LanAccessFailure(LanAccessError.unreachable),
          ]);
        final c = await boot(tester, lan: lan, store: store);
        c.useLan();
        await tester.pumpAndSettle();
        await typeAndTap(tester, {'lan-server': '192.168.1.20'}, 'lan-next');
        expect(errorText(tester), LanAccessError.notSchoolServer.messageFa());
        await typeAndTap(tester, {'lan-server': '192.168.1.21'}, 'lan-next');
        expect(errorText(tester), LanAccessError.unreachable.messageFa());
        expect(store.values, isEmpty);
      },
    );
  });

  group('LAN data path (real LanAccessClient + GatewayAttendanceSource, local Sync v1 server)', () {
    late HttpServer srv;
    final requests = <String>[];
    final pushed = <Map<String, Object?>>[];
    var online = true;

    HttpOverrides? saved;

    setUp(() async {
      // the widget-test binding replaces every HttpClient with a fake that answers 400; this
      // group talks to a real local socket on purpose
      saved = HttpOverrides.current;
      HttpOverrides.global = null;
      requests.clear();
      pushed.clear();
      online = true;
      srv = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      srv.listen((r) async {
        final body = await utf8.decodeStream(r);
        requests.add('${r.method} ${r.uri.path}');
        Object? out;
        var status = 200;
        final auth = r.headers.value('authorization');
        switch (r.uri.path) {
          case '/api/health':
            out = {
              'ok': true,
              'name': 'payesh-local',
              'headless': true,
              'setup_done': true,
              'school': 'هنرستان آزمون',
              'instance': 'ab12cd34',
            };
          case '/api/network':
            out = {
              'ok': true,
              'lan_urls': ['http://192.168.1.10:8080', 'http://8.8.8.8:8080'],
            };
          case '/api/auth/login':
            out = {
              'ok': true,
              'user': {'id': 10, 'role': 'teacher', 'name': 'معلم'},
              'session': {
                'token': 'acc-1',
                'expires_at': '2030-01-01T00:00:00.000Z',
              },
              'device_token': 'dt-1',
            };
          case '/api/v1/pull' when auth == 'Bearer acc-1':
            out = {
              'ok': true,
              'schema_version': 1,
              'server_time': '2026-11-12T08:00:00.000Z',
              'more': false,
              'collections': {
                'classes': [
                  {'id': 5, 'name': 'دهم الف', '_version': 1},
                ],
                'schedule': [
                  {'id': 900, 'class_id': 5, 'teacher_id': 10, '_version': 1},
                ],
                'users': [
                  {'id': 10, 'role': 'teacher', 'name': 'معلم', '_version': 1},
                  {
                    'id': 21,
                    'role': 'student',
                    'class_id': 5,
                    'name': 'بهار',
                    '_version': 1,
                  },
                ],
              },
              'deleted': <Object>[],
            };
          case '/api/sync' when auth == 'Bearer acc-1' && online:
            final ops = ((jsonDecode(body) as Map)['ops'] as List)
                .cast<Map<String, Object?>>();
            pushed.addAll(ops);
            out = {
              'ok': true,
              'applied': [
                for (final o in ops)
                  {'uid': o['uid'], 'id': o['id'], 'version': 1},
              ],
              'rejected': <Object>[],
              'conflicts': <Object>[],
            };
          case '/api/sync' when !online:
            status = 503;
            out = {'ok': false, 'error': 'unavailable'};
          default:
            status = 401;
            out = {'ok': false, 'error': 'unauthorized'};
        }
        r.response
          ..statusCode = status
          ..headers.contentType = ContentType.json
          ..write(jsonEncode(out));
        await r.response.close();
      });
    });

    tearDown(() async {
      await srv.close(force: true);
      HttpOverrides.global = saved;
    });

    test('L127-D01 LAN login → pull into SQLite → attendance queued → AutoSync push over /api/sync', () async {
      final engine = SqliteEngine.inMemory();
      final c = SessionController(
        api: NoGateway(),
        accounts: SchoolAccountStore(FakeSecureStore()),
        flags: ClientFlags.parse(),
        lan: LanAccessClient(platform: 'test'),
      );
      // no Gateway config at all (client: null) — the LAN path still works
      final src = GatewayAttendanceSource(
        storage: Future.value(engine),
        session: c,
      )..attach();
      await c.start();
      expect(c.state, isA<NeedSchool>());
      c.useLan();
      await c.submitLanServer('127.0.0.1:${srv.port}');
      expect((c.state as NeedLan).info?.schoolName, 'هنرستان آزمون');
      // the manager on the server computer sees the address for the other devices
      // (a public address in the answer is dropped)
      expect(c.lanShareUrls, ['http://192.168.1.10:8080']);
      await c.submitLanLogin('09120000010', 'moalem-127');
      expect(c.state, isA<SignedIn>());
      expect(c.onLan, isTrue);
      final book = await src.bookFor(role: 'teacher', uid: 10);
      expect(book, isNotNull);
      expect(DeviceOwner.read(engine), 'lan-ab12cd34/10');
      await src.retry();
      expect((await book!.classes()).map((x) => x.id), [5]);
      // offline save → queued (badge counts it), nothing lost
      online = false;
      final saved = await book.save(
        classId: 5,
        date: '2026-11-12',
        marks: {21: AttendanceStatus.absent},
      );
      expect(saved.written, 1);
      src.queued();
      await src.retry();
      expect(c.sync.value.waiting, 1);
      expect(pushed, isEmpty);
      // back online → the outbox drains through /api/sync
      online = true;
      SqliteOutbox(engine.database).wake();
      await src.retry();
      expect(c.sync.value.waiting, 0, reason: '${c.sync.value.lastError}');
      expect(pushed.single['collection'], 'attendance');
      expect((pushed.single['data']! as Map)['status'], 'absent');
      // only the Sync v1 API of the school server was used — never a Gateway route
      expect(requests.where((x) => x.contains('/api/gw/')), isEmpty);
      expect(requests, contains('GET /api/v1/pull'));
      expect(requests, contains('POST /api/sync'));
      await src.dispose();
      c.dispose();
    });
  });
}
