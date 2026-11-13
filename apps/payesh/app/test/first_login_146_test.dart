// Row 146 — the first sign-in on a school server follows the web client's design
// (client/app.js doSetup / doLogin / doClaim, client/pages.js renderSetup): the same fields, the
// same rules and the same messages; nothing is sent while the typed login has the wrong shape.
// Row 145 user names (manager of an owner-created school) keep working.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/login/session_controller.dart';
import 'package:payesh_sync/payesh_sync.dart';

import 'lan_mode_127_test.dart';

/// The web setup form is long: a tall window keeps every field on screen.
void _tall(WidgetTester tester) {
  tester.view.physicalSize = const Size(900, 1800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
}

Future<SessionController> _fresh(WidgetTester tester, FakeLan lan) async {
  _tall(tester);
  final c = await boot(tester, lan: lan);
  c.useLan();
  await tester.pumpAndSettle();
  await typeAndTap(tester, {'lan-server': '192.168.1.10'}, 'lan-next');
  return c;
}

void main() {
  testWidgets(
    'F146-W01 fresh server setup = web renderSetup: type, year, mobile 11 digits, password twice',
    (tester) async {
      final lan = FakeLan()
        ..probes.add(serverInfo(setupDone: false))
        ..setups.add(lanSession(role: 'manager', uid: 1));
      final c = await _fresh(tester, lan);
      // the web form's fields, in its order, with its defaults
      for (final k in [
        'lan-setup-school',
        'lan-setup-type',
        'lan-setup-year',
        'lan-setup-manager',
        'lan-phone',
        'lan-password',
        'lan-password2',
        'lan-setup-after',
      ]) {
        expect(find.byKey(Key(k)), findsOneWidget, reason: k);
      }
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('lan-setup-year')))
            .controller!
            .text,
        setupDefaultYear,
      );
      final base = {
        'lan-setup-school': 'هنرستان نو',
        'lan-setup-manager': 'مدیر آزمون',
        'lan-password': 'modir-146',
        'lan-password2': 'modir-146',
      };
      // NEG: 10 digits (a national id is not a manager mobile) / a user name / too long
      for (final bad in ['0912000014', 'ali.rezaei', '091200001466']) {
        await typeAndTap(tester, {
          ...base,
          'lan-phone': bad,
        }, 'lan-setup-submit');
        expect(errorText(tester), LanServerRules.mobileRuleFa, reason: bad);
      }
      // NEG: short password, then the repeat does not match
      await typeAndTap(tester, {
        ...base,
        'lan-phone': '09120000146',
        'lan-password': 'abc',
        'lan-password2': 'abc',
      }, 'lan-setup-submit');
      expect(errorText(tester), 'رمز عبور حداقل ۴ نویسه باشد');
      await typeAndTap(tester, {
        ...base,
        'lan-phone': '09120000146',
        'lan-password2': 'modir-147',
      }, 'lan-setup-submit');
      expect(errorText(tester), 'رمز عبور و تکرارش یکی نیست');
      expect(lan.calls.where((x) => x.startsWith('setup')), isEmpty);

      // the school type is chosen from the web list
      await tester.tap(find.byKey(const Key('lan-setup-type')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('متوسطه اول').last);
      await tester.pumpAndSettle();
      // Persian digits with spaces are fine (web digitsOnly)
      await typeAndTap(tester, {
        ...base,
        'lan-phone': '۰۹۱۲ ۰۰۰ ۰۱۴۶',
      }, 'lan-setup-submit');
      expect(lan.calls.last, 'setup:هنرستان نو:مدیر آزمون:۰۹۱۲ ۰۰۰ ۰۱۴۶');
      expect(lan.setupExtras.single, 'متوسطه اول|$setupDefaultYear');
      expect((c.state as SignedIn).currentRole, 'manager');
    },
  );

  testWidgets(
    'F146-W02 first manager sign-in on a fresh server: user name / mobile / national id shapes',
    (tester) async {
      final lan = FakeLan()
        ..probes.add(serverInfo(setupDone: false))
        ..logins.add(lanSession(role: 'manager', uid: 1, token: 'acc-m'));
      final c = await _fresh(tester, lan);
      await tester.tap(find.byKey(const Key('lan-login-instead')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('lan-login')), findsOneWidget);
      for (final (typed, pw, msg) in [
        ('', 'Madrese-1403', null),
        ('ab', 'Madrese-1403', LanServerRules.usernameRuleFa),
        ('2ali', 'Madrese-1403', LanServerRules.usernameRuleFa),
        ('علی.رضایی', 'Madrese-1403', LanServerRules.latinUsernameFa),
        ('0912', 'Madrese-1403', LanServerRules.loginDigitsRuleFa),
        ('091212345678', 'Madrese-1403', LanServerRules.loginDigitsRuleFa),
        ('Ali.Rezaei', '', 'رمز عبور را وارد کنید'),
        ('Ali.Rezaei', 'abc', LanAccessError.badCredentials.messageFa()),
      ]) {
        await typeAndTap(tester, {
          'lan-phone': typed,
          'lan-password': pw,
        }, 'lan-login');
        if (msg != null) expect(errorText(tester), msg, reason: typed);
        expect(find.byKey(const Key('login-error')), findsOneWidget);
      }
      expect(
        lan.calls.where((x) => x.startsWith('login')),
        isEmpty,
        reason: 'nothing is sent while the shape is wrong',
      );
      await typeAndTap(tester, {
        'lan-phone': ' Ali.Rezaei ',
        'lan-password': 'Madrese-1403',
      }, 'lan-login');
      expect(lan.calls.last, 'login: Ali.Rezaei :Madrese-1403');
      expect((c.state as SignedIn).currentRole, 'manager');
    },
  );

  testWidgets(
    'F146-W03 national id (10 digits, Arabic digits too) is a valid login',
    (tester) async {
      final lan = FakeLan()
        ..probes.add(serverInfo())
        ..logins.add(lanSession(role: 'parent', uid: 7));
      await boot(tester, lan: lan).then((c) => c.useLan());
      await tester.pumpAndSettle();
      await typeAndTap(tester, {'lan-server': '192.168.1.10'}, 'lan-next');
      await typeAndTap(tester, {
        'lan-phone': '٠٠١٢٣٤٥٦٧٨',
        'lan-password': 'valed-146',
      }, 'lan-login');
      expect(lan.calls.last, 'login:٠٠١٢٣٤٥٦٧٨:valed-146');
    },
  );
}
