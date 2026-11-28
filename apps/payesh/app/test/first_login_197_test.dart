// Row 197 — Q12 (F16): the first password of every account is the national id (everyone at
// school knows it). Signed in with it (LAN `must_change`), the app shows only «رمز تازه» —
// no page, no menu — until the school server accepts a new password. The password typed at
// sign-in is kept in memory only and is not asked again; after a restart it is.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/app.dart';
import 'package:payesh_app/src/flags.dart';
import 'package:payesh_app/src/login/login_screens.dart';
import 'package:payesh_app/src/login/session_controller.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_sync/payesh_sync.dart';

import 'lan_mode_127_test.dart' as lan;
import 'school_support.dart';

const nid = '1970000015';

LanSession first({bool mustChange = true}) => LanSession(
  token: 'acc-1',
  expiresAt: DateTime.utc(2030),
  deviceToken: 'dt-1',
  uid: 10,
  role: 'teacher',
  mustChange: mustChange,
);

Future<(SessionController, FakeAccounts)> boot(
  WidgetTester tester,
  lan.FakeLan server, {
  FakeSecureStore? store,
}) async {
  final acc = FakeAccounts({})..ownPassword = nid;
  final src = MemorySchool()..accounts = acc;
  final c = SessionController(
    api: lan.NoGateway(),
    accounts: SchoolAccountStore(store ?? FakeSecureStore()),
    flags: ClientFlags.parse(school: ClientFlags.defaultSchoolWaves),
    lan: server,
    now: () => DateTime.utc(2026, 11, 12, 8),
  );
  addTearDown(c.dispose);
  await tester.pumpWidget(
    PayeshApp(session: c, school: src, today: () => DateTime(2026, 11, 12)),
  );
  await c.start();
  await tester.pumpAndSettle();
  return (c, acc);
}

Future<void> signIn(WidgetTester tester, String password) async {
  await tester.tap(find.byKey(const Key('use-lan')));
  await tester.pumpAndSettle();
  await lan.typeAndTap(tester, {'lan-server': '192.168.1.10'}, 'lan-next');
  await lan.typeAndTap(tester, {
    'lan-phone': '09121970001',
    'lan-password': password,
  }, 'lan-login');
  await settle(tester);
}

void main() {
  testWidgets(
    'F16-W01 first password → only «رمز تازه»; NEG the national id again is '
    'refused (no call); a new one opens the panel',
    (tester) async {
      final server = lan.FakeLan()
        ..probes.add(lan.serverInfo())
        ..logins.add(first());
      final (c, acc) = await boot(tester, server);
      await signIn(tester, nid);
      expect(c.state, isA<SignedIn>());
      expect(c.mustChangePassword, isTrue);
      expect(find.byKey(const Key('fpw-screen')), findsOneWidget);
      expect(find.byType(SignedInScreen), findsNothing);
      // the password typed a moment ago is not asked again
      expect(find.byKey(const Key('fpw-current')), findsNothing);
      await typeKey(tester, 'fpw-next', nid);
      await typeKey(tester, 'fpw-again', nid);
      await tapKey(tester, 'fpw-submit');
      expect(
        textOf(tester, 'fpw-error'),
        const AccountFailure(AccountError.passwordIsDefault).messageFa,
      );
      expect(acc.calls, isEmpty);
      // NEG: the two new fields differ
      await typeKey(tester, 'fpw-next', 'Gol-1405');
      await typeKey(tester, 'fpw-again', 'Gol-1406');
      await tapKey(tester, 'fpw-submit');
      expect(textOf(tester, 'fpw-error'), 'رمز تازه و تکرارش یکی نیست');
      expect(acc.calls, isEmpty);
      await typeKey(tester, 'fpw-again', 'Gol-1405');
      await tapKey(tester, 'fpw-submit');
      expect(acc.calls, ['own:$nid:Gol-1405']);
      expect(acc.ownPassword, 'Gol-1405');
      expect(c.mustChangePassword, isFalse);
      expect(c.signInPassword, isNull);
      expect(find.byKey(const Key('fpw-screen')), findsNothing);
      expect(find.byType(SignedInScreen), findsOneWidget);
    },
  );

  testWidgets(
    'F16-W02 NEG a changed password: straight to the panel, nothing kept',
    (tester) async {
      final server = lan.FakeLan()
        ..probes.add(lan.serverInfo())
        ..logins.add(first(mustChange: false));
      final (c, _) = await boot(tester, server);
      await signIn(tester, 'Gol-1405');
      expect(c.mustChangePassword, isFalse);
      expect(c.signInPassword, isNull);
      expect(find.byKey(const Key('fpw-screen')), findsNothing);
      expect(find.byType(SignedInScreen), findsOneWidget);
    },
  );

  testWidgets(
    'F16-W03 restart with the first password still set: the refresh says so, the '
    'form asks for the current password; a wrong one is the server\'s message',
    (tester) async {
      final store = await lan.savedLan();
      final server = lan.FakeLan()..refreshes.add(first());
      final (c, acc) = await boot(tester, server, store: store);
      expect(c.mustChangePassword, isTrue);
      expect(find.byKey(const Key('fpw-screen')), findsOneWidget);
      expect(find.byKey(const Key('fpw-current')), findsOneWidget);
      await typeKey(tester, 'fpw-current', '0000');
      await typeKey(tester, 'fpw-next', 'Gol-1405');
      await typeKey(tester, 'fpw-again', 'Gol-1405');
      await tapKey(tester, 'fpw-submit');
      expect(textOf(tester, 'fpw-error'), 'رمز فعلی درست نیست');
      expect(c.mustChangePassword, isTrue);
      await typeKey(tester, 'fpw-current', nid);
      await tapKey(tester, 'fpw-submit');
      expect(acc.calls.last, 'own:$nid:Gol-1405');
      expect(find.byType(SignedInScreen), findsOneWidget);
    },
  );

  test('F16-L01 LanSession reads must_change; AccountError wires', () {
    final j = {
      'ok': true,
      'session': {'token': 't', 'expires_at': '2030-01-01T00:00:00Z'},
      'device_token': 'd',
      'user': {'id': 3, 'role': 'teacher', 'name': 'دبیر'},
      'must_change': true,
    };
    expect(LanSession.fromJson(j).mustChange, isTrue);
    expect(
      LanSession.fromJson({...j}..remove('must_change')).mustChange,
      isFalse,
    );
  });
}
