// Row 197-Q03 (F30/F22/F23) — a parent without a subscription keeps the children's grades,
// attendance, weekly schedule and leave requests («هستهٔ رایگان»); the rest waits for a
// subscription or the trial, and the trial opens everything at once — no restart, no new
// sign-in.
//
//   Q03-W01  parent + free core ⇒ no paywall; the free-core card and the «نسخهٔ رایگان» badge;
//            «شروع تست رایگان» ⇒ the card goes, the trial badge shows (same session).
//   Q03-W02  NEG manager (no free core) ⇒ still the paywall; blocked school ⇒ closed even with a
//            free core.
//   Q03-U01  SubStatus.free_core parsing + the parent's wording.
//   Q03-D01  data path (real LanAccessClient + GatewayAttendanceSource + a real local socket):
//            while locked the pull cursor moves on (free collections only); the trial ⇒ the cursor
//            is forgotten and a full pull (since = epoch) runs at once, and the refused change
//            feed connects again — before row 197 the subscription-only rows older than the
//            cursor never arrived and the feed waited in its backoff.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/app.dart';
import 'package:payesh_app/src/attendance/attendance_wiring.dart';
import 'package:payesh_app/src/flags.dart';
import 'package:payesh_app/src/login/paywall.dart';
import 'package:payesh_app/src/login/session_controller.dart';
import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_sync/payesh_sync.dart';

import 'lan_mode_127_test.dart' show FakeLan, NoGateway, lanSession, serverInfo;
import 'family_wave5_test.dart' show MemorySource;
import 'nav_support.dart';
import 'schools_145_test.dart' show FakeSchools, ListDirectory, active;

Map<String, Object?> _limitedJson({
  String role = 'parent',
  bool trial = true,
  String status = 'none',
  List<String> core = const ['grades', 'attendance', 'schedule', 'leaves'],
}) => {
  'managed': true,
  'access': false,
  'status': status,
  'role': role,
  'policy': 'required',
  'school': 'دبستان آزمون',
  'plans': [
    {'key': 'monthly', 'price': 250000},
    {'key': 'yearly', 'price': 2200000},
  ],
  'trial_days': 21,
  'trial_available': trial,
  'gateway': false,
  'receipt': true,
  'pending': <Object>[],
  if (core.isNotEmpty) 'free_core': core,
};

void main() {
  group('free core UI (row 197-Q03)', () {
    late FakeLan lan;
    late FakeSchools schools;

    setUp(() {
      lan = FakeLan();
      schools = FakeSchools();
    });

    Future<SessionController> boot(WidgetTester tester) async {
      tallView(tester);
      final src = MemorySource();
      final c = SessionController(
        api: NoGateway(),
        accounts: SchoolAccountStore(FakeSecureStore()),
        flags: ClientFlags.parse(
          waves: 'login,attendance,grades,notices,parents',
        ),
        lan: lan,
        schools: schools,
        directory: ListDirectory(),
        deviceId: () async => 'android-id-q03',
        now: () => DateTime.utc(2026, 11, 27, 8),
      );
      addTearDown(c.dispose);
      await tester.pumpWidget(
        PayeshApp(
          session: c,
          attendance: src,
          grades: src,
          notices: src,
          family: src,
          today: () => DateTime(2026, 11, 27),
        ),
      );
      await c.start();
      await tester.pumpAndSettle();
      return c;
    }

    Future<void> tap(WidgetTester tester, String key) async {
      final f = find.byKey(Key(key));
      await tester.ensureVisible(f);
      await tester.pumpAndSettle();
      await tester.tap(f);
      await tester.pumpAndSettle();
    }

    Future<void> signIn(WidgetTester tester, String role) async {
      lan.probes.add(serverInfo());
      await tap(tester, 'use-lan');
      await tester.enterText(
        find.byKey(const Key('lan-server')),
        '192.168.1.10:8080',
      );
      await tap(tester, 'lan-next');
      lan.logins.add(lanSession(role: role, uid: 7, token: 'acc-q3'));
      await tester.enterText(find.byKey(const Key('lan-phone')), '0912');
      await tester.enterText(find.byKey(const Key('lan-password')), 'p-1234');
      await tap(tester, 'lan-login');
    }

    testWidgets(
      'Q03-W01 parent without a subscription keeps the free core; the trial opens the rest at once',
      (tester) async {
        final c = await boot(tester);
        schools.subs.add(SubStatus.fromJson(_limitedJson()));
        // the automatic trial (row 167) fails quietly here — the card still offers it
        schools.trials.add(const LanAccessFailure(LanAccessError.unreachable));
        await signIn(tester, 'parent');
        expect(c.paywalled, isFalse);
        expect(c.limited, isTrue);
        expect(find.byKey(const Key('paywall')), findsNothing);
        expect(find.byKey(const Key('free-core')), findsOneWidget);
        expect(
          find.textContaining(
            'نمره، حضور و غیاب، برنامهٔ هفتگی و درخواست مرخصی فرزندتان همیشه رایگان است',
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: find.byKey(const Key('free-core')),
            matching: find.text('🔓 نسخهٔ رایگان'),
          ),
          findsOneWidget,
        );
        expect(
          find.textContaining('اشتراک فعال'),
          findsNothing,
          reason: 'never «اشتراک فعال» without a subscription',
        );
        expect(find.text('شروع تست رایگان ۲۱ روزه'), findsOneWidget);
        // the menu keeps the free core only
        expect(navOf('home'), findsOneWidget);
        expect(navOf('leaves'), findsOneWidget);
        expect(navOf('system'), findsOneWidget);
        expect(navOf('subscription'), findsOneWidget);
        expect(navOf('announcements'), findsNothing);

        schools.trials.add(active(days: 21));
        await tap(tester, 'free-core-trial');
        expect(
          schools.calls.where((x) => x.startsWith('trial:')),
          hasLength(2),
        );
        expect(c.limited, isFalse);
        expect(c.state, isA<SignedIn>(), reason: 'same session');
        expect(find.byKey(const Key('free-core')), findsNothing);
        expect(navOf('announcements'), findsOneWidget);
        expect(
          find.descendant(
            of: find.byKey(const Key('sub-banner')),
            matching: find.textContaining('تست رایگان — ۲۱ روز'),
          ),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'Q03-W02 NEG a role without a free core keeps the paywall; a blocked school stays closed',
      (tester) async {
        final c = await boot(tester);
        schools.subs.add(
          SubStatus.fromJson(
            _limitedJson(role: 'manager', trial: false, core: const []),
          ),
        );
        await signIn(tester, 'manager');
        expect(c.paywalled, isTrue);
        expect(c.limited, isFalse);
        expect(find.byKey(const Key('paywall')), findsOneWidget);
        expect(find.byKey(const Key('free-core')), findsNothing);
        // a free core never opens an inactive school
        schools.subs.add(
          SubStatus.fromJson(
            _limitedJson(status: 'school_inactive', trial: false),
          ),
        );
        await c.checkSub();
        await tester.pumpAndSettle();
        expect(c.paywalled, isTrue);
        expect(c.limited, isFalse);
        expect(find.byKey(const Key('paywall-school-blocked')), findsOneWidget);
      },
    );
  });

  test('Q03-U01 free_core parsing and wording', () {
    final s = SubStatus.fromJson(_limitedJson());
    expect(s.freeCore, ['grades', 'attendance', 'schedule', 'leaves']);
    expect(SubStatus.fromJson(_limitedJson(core: const [])).freeCore, isEmpty);
    expect(
      SubStatus.fromJson({
        'free_core': [1, 'grades', null],
      }).freeCore,
      ['grades'],
      reason: 'only names',
    );
    expect(freeCoreLabel(const ['grades', 'attendance']), 'نمره و حضور و غیاب');
    expect(freeCoreLabel(const ['grades']), 'نمره');
    expect(freeCoreLabel(const ['x']), '');
    expect(freeCorePages, containsAll(['home', 'schedule', 'leaves']));
    expect(freeCorePages.contains('announcements'), isFalse);
  });

  group('data path unlock (row 197-Q03)', () {
    HttpOverrides? saved;
    late HttpServer srv;
    late SessionController c;
    late GatewayAttendanceSource src;
    final pulls = <String>[];
    final log = <String>[];
    var unlocked = false;
    var offer = false;

    Map<String, Object?> sub() => unlocked
        ? {
            'managed': true,
            'access': true,
            'status': 'trial',
            'policy': 'required',
            'days_left': 21,
          }
        : _limitedJson(trial: offer);

    setUp(() async {
      saved = HttpOverrides.current;
      HttpOverrides.global = null;
      pulls.clear();
      log.clear();
      unlocked = false;
      offer = false;
      srv = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      srv.listen((r) async {
        await utf8.decodeStream(r);
        log.add('${r.method} ${r.uri.path}');
        Object out;
        var status = 200;
        switch (r.uri.path) {
          case '/api/health':
            out = {
              'ok': true,
              'name': 'payesh-local',
              'headless': true,
              'setup_done': true,
              'school': 'دبستان آزمون',
              'instance': 'q3q3q3q3',
            };
          case '/api/auth/login':
          case '/api/auth/refresh':
            out = {
              'ok': true,
              'user': {'id': 10, 'role': 'parent', 'name': 'ولی'},
              'session': {
                'token': 'acc-p',
                'expires_at': '2030-01-01T00:00:00.000Z',
              },
              'device_token': 'dt-p',
            };
          case '/api/sub/status':
            out = {'ok': true, ...sub()};
          case '/api/sub/trial':
            unlocked = true;
            out = {'ok': true, 'sub': sub()};
          case '/api/v1/pull':
            pulls.add(r.uri.queryParameters['since'] ?? '');
            out = {
              'ok': true,
              'schema_version': 1,
              'server_time': '2026-11-27T06:00:00.000Z',
              'more': false,
              'collections': <String, Object>{},
              'deleted': <Object>[],
            };
          case '/api/v1/events' when !unlocked:
            status = 402;
            out = {'ok': false, 'error': 'subscription_required'};
          default:
            status = 404;
            out = {'ok': false, 'error': 'not_found'};
        }
        r.response
          ..statusCode = status
          ..headers.contentType = ContentType.json
          ..write(jsonEncode(out));
        await r.response.close();
      });
      final lanClient = LanAccessClient(
        platform: 'test',
        refreshRetryDelays: const [],
      );
      c = SessionController(
        api: NoGateway(),
        accounts: SchoolAccountStore(FakeSecureStore()),
        flags: ClientFlags.parse(),
        lan: lanClient,
        schools: LanSchoolsClient(lanClient),
        directory: ListDirectory(),
        deviceId: () async => 'android-id-q03-data',
      );
      src = GatewayAttendanceSource(
        storage: Future.value(SqliteEngine.inMemory()),
        session: c,
      )..attach();
      await c.start();
      c.useLan();
      await c.submitLanServer('127.0.0.1:${srv.port}');
      await c.submitLanLogin('09121970002', '1970000023');
      expect(c.state, isA<SignedIn>());
    });

    tearDown(() async {
      await src.dispose();
      c.dispose();
      await srv.close(force: true);
      HttpOverrides.global = saved;
    });

    Future<void> until(bool Function() ok, {String? reason}) async {
      for (var i = 0; i < 200 && !ok(); i++) {
        await Future<void>.delayed(const Duration(milliseconds: 25));
      }
      expect(ok(), isTrue, reason: reason);
    }

    test('Q03-D01 trial ⇒ cursor forgotten, full pull at once, the refused feed connects again', () async {
      await until(() => c.sub != null);
      expect(c.limited, isTrue);
      await until(() => pulls.isNotEmpty, reason: 'first pull');
      expect(pulls.first, epoch);
      await until(
        () => log.contains('GET /api/v1/events'),
        reason: 'the feed tries and is refused (402)',
      );
      await Future<void>.delayed(const Duration(milliseconds: 300));
      final full = pulls.where((s) => s == epoch).length;
      expect(full, 1, reason: 'while locked the cursor moves on');
      // the owner switches the trial on ⇒ «بررسی دوباره» starts it by itself (row 167)
      offer = true;
      await c.checkSub();
      expect(unlocked, isTrue);
      expect(c.sub!.access, isTrue);
      await until(
        () => pulls.where((s) => s == epoch).length > full,
        reason:
            'after the unlock the cursor is forgotten: a full pull $log $pulls',
      );
      await until(
        () => log.where((x) => x == 'GET /api/v1/events').length >= 2,
        reason: 'the feed refused with 402 connects again at once',
      );
      expect(c.limited, isFalse);
    });
  });
}
