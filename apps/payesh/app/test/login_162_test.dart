// Row 162 — the app's REAL first screen (production wiring: no Gateway in the build, LAN on) is
// the school server's login: username + password, or mobile + one-time SMS code, in the order
// the owner set in the owner panel. No «کد مدرسه», no activation code; the server address is
// remembered (and a server on this same computer is found by itself). Real controller + real
// screens, scripted school server.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/app.dart';
import 'package:payesh_app/src/flags.dart';
import 'package:payesh_app/src/login/session_controller.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_sync/payesh_sync.dart';

import 'lan_mode_127_test.dart' hide main;

const _unreachable = LanAccessFailure(LanAccessError.unreachable);

LanServerInfo info162({bool sms = true, String primary = 'password'}) =>
    LanServerInfo(
      server: lanServer,
      setupDone: true,
      headless: true,
      schoolName: 'هنرستان شهید آزمون',
      instance: 'ab12cd34',
      smsReady: sms,
      loginPrimary: primary,
      otpLength: 5,
    );

/// Production wiring: `schoolAccessFromEnvironment()` without Gateway defines.
Future<SessionController> bootProd(
  WidgetTester tester,
  FakeLan lan, {
  FakeSecureStore? store,
}) async {
  final c = SessionController(
    api: const UnconfiguredSchoolAccess(),
    accounts: SchoolAccountStore(store ?? FakeSecureStore()),
    flags: ClientFlags.parse(),
    lan: lan,
    now: () => DateTime.utc(2026, 11, 15, 8),
  );
  addTearDown(c.dispose);
  await tester.pumpWidget(
    PayeshApp(session: c, today: () => DateTime(2026, 11, 15)),
  );
  await c.start();
  await tester.pumpAndSettle();
  return c;
}

void main() {
  testWidgets(
    'L162-01 fresh device: the first screen is username + password (no school code), one press signs in and the server is remembered',
    (tester) async {
      final store = FakeSecureStore();
      final lan = FakeLan()
        ..probes.addAll([_unreachable, info162()])
        ..logins.add(lanSession());
      final c = await bootProd(tester, lan, store: store);
      expect(c.lanFirst, isTrue);
      expect(c.state, isA<NeedLan>());
      expect(find.text('ورود به پایش'), findsOneWidget);
      for (final k in [
        'lan-server',
        'lan-phone',
        'lan-password',
        'lan-login',
      ]) {
        expect(find.byKey(Key(k)), findsOneWidget, reason: k);
      }
      expect(find.text('ورود با شماره و کد یکبارمصرف'), findsOneWidget);
      expect(find.text('فراموشی رمز'), findsOneWidget);
      // the old school-code / activation login is gone from this build
      for (final k in ['school-code', 'use-lan', 'use-legacy', 'lan-back']) {
        expect(find.byKey(Key(k)), findsNothing, reason: k);
      }
      expect(find.textContaining('کد مدرسه'), findsNothing);
      await typeAndTap(tester, {
        'lan-server': '192.168.1.10',
        'lan-phone': '09121234567',
        'lan-password': '0012345678',
      }, 'lan-login');
      expect(c.state, isA<SignedIn>());
      expect(lan.calls, [
        'probe:127.0.0.1:8080',
        'probe:192.168.1.10:8080',
        'login:09121234567:0012345678',
      ]);
      expect(await store.read(LanKeys.lastServer), 'http://192.168.1.10:8080');
    },
  );

  testWidgets(
    'L162-02 remembered server + owner chose «mobile»: the app opens on the mobile + code form and signs in with the SMS code',
    (tester) async {
      final store = FakeSecureStore();
      await store.write(LanKeys.lastServer, 'http://192.168.1.10:8080');
      await store.write(LanKeys.lastPrimary, 'mobile');
      final lan = FakeLan()
        ..probes.add(info162(primary: 'mobile'))
        ..otpRequests.add(const OtpTicket(length: 5))
        ..otpVerifies.add(lanSession());
      final c = await bootProd(tester, lan, store: store);
      final s = c.state as NeedLan;
      expect(s.info, isNotNull);
      expect(find.text('ورود با شمارهٔ همراه'), findsOneWidget);
      expect(find.byKey(const Key('lan-mobile')), findsOneWidget);
      expect(find.byKey(const Key('lan-server')), findsNothing);
      expect(find.text('ورود با نام کاربری و رمز عبور'), findsOneWidget);
      await typeAndTap(tester, {'lan-mobile': '09121234567'}, 'lan-otp-send');
      expect(find.byKey(const Key('lan-otp-code')), findsOneWidget);
      await typeAndTap(tester, {'lan-otp-code': '12345'}, 'lan-otp-verify');
      expect(c.state, isA<SignedIn>());
      expect(lan.calls, [
        'probe:192.168.1.10:8080',
        'otp-request:09121234567:login',
        'otp-verify:09121234567:12345:login:-',
      ]);
    },
  );

  testWidgets(
    'L162-03 owner chose «mobile» but no SMS panel yet: the mobile form shows (owner setting wins) with «به‌زودی» and the password link under it',
    (tester) async {
      final store = FakeSecureStore();
      await store.write(LanKeys.lastServer, 'http://192.168.1.10:8080');
      final lan = FakeLan()..probes.add(info162(sms: false, primary: 'mobile'));
      await bootProd(tester, lan, store: store);
      expect(find.byKey(const Key('lan-mobile')), findsOneWidget);
      expect(find.byKey(const Key('lan-sms-soon')), findsOneWidget);
      await tester.tap(find.byKey(const Key('lan-switch-method')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('lan-password')), findsOneWidget);
    },
  );

  testWidgets(
    'L162-04 server not reachable at start: the same login form, address prefilled; mobile login connects and asks for the code in one press',
    (tester) async {
      final store = FakeSecureStore();
      await store.write(LanKeys.lastServer, 'http://192.168.1.10:8080');
      await store.write(LanKeys.lastPrimary, 'mobile');
      final lan = FakeLan()
        ..probes.addAll([
          _unreachable,
          _unreachable,
          info162(primary: 'mobile'),
        ])
        ..otpRequests.add(const OtpTicket(length: 5));
      final c = await bootProd(tester, lan, store: store);
      expect(c.lastMobileFirst, isTrue);
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('lan-server')))
            .controller!
            .text,
        '192.168.1.10',
      );
      await typeAndTap(tester, {'lan-mobile': '09121234567'}, 'lan-otp-send');
      expect((c.state as NeedLan).otp, isNotNull);
      expect(lan.calls.last, 'otp-request:09121234567:login');
    },
  );

  testWidgets(
    'L162-05 «خروج» returns straight to the same server login form (no address, no school code)',
    (tester) async {
      final store = FakeSecureStore();
      final lan = FakeLan()
        ..probes.addAll([_unreachable, info162(), info162()])
        ..logins.add(lanSession());
      final c = await bootProd(tester, lan, store: store);
      await typeAndTap(tester, {
        'lan-server': '192.168.1.10',
        'lan-phone': '09121234567',
        'lan-password': '0012345678',
      }, 'lan-login');
      expect(c.state, isA<SignedIn>());
      await c.signOut();
      await tester.pumpAndSettle();
      final s = c.state as NeedLan;
      expect(s.info?.server, lanServer);
      expect(find.byKey(const Key('lan-password')), findsOneWidget);
      expect(find.byKey(const Key('lan-school')), findsOneWidget);
      expect(find.textContaining('کد مدرسه'), findsNothing);
      c.leaveLan(); // no Gateway in this build: nothing to go back to
      expect(c.state, isA<NeedLan>());
    },
  );
}
