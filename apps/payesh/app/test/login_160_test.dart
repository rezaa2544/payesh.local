// Row 160 — the LAN login screen: the owner's primary method first, the other one written under
// it («ورود با شماره» / «ورود با نام کاربری و رمز عبور»), «فراموشی رمز», and «به‌زودی» while no
// SMS panel is linked. Real controller, scripted school server.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/login/session_controller.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_sync/payesh_sync.dart';

import 'lan_mode_127_test.dart' hide main;

LanServerInfo info({bool sms = false, String primary = 'password'}) =>
    LanServerInfo(
      server: lanServer,
      setupDone: true,
      headless: true,
      schoolName: 'هنرستان شهید آزمون',
      instance: 'ab12cd34',
      smsReady: sms,
      loginPrimary: sms && primary == 'mobile' ? 'mobile' : 'password',
      otpLength: 5,
    );

Future<void> toLogin(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('use-lan')));
  await tester.pumpAndSettle();
  await typeAndTap(tester, {'lan-server': '192.168.1.10'}, 'lan-next');
}

Future<void> tapKey(WidgetTester tester, String key) async {
  final f = find.byKey(Key(key));
  await tester.ensureVisible(f);
  await tester.pumpAndSettle();
  await tester.tap(f);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'L160-W01 SMS not linked: password first, «ورود با شماره» under it says «به‌زودی», nothing sent',
    (tester) async {
      final lan = FakeLan()..probes.add(info());
      await boot(tester, lan: lan);
      await toLogin(tester);
      expect(find.byKey(const Key('lan-password')), findsOneWidget);
      expect(find.text('ورود با شماره و کد یکبارمصرف'), findsOneWidget);
      expect(find.text('فراموشی رمز'), findsOneWidget);
      await tapKey(tester, 'lan-switch-method');
      expect(find.byKey(const Key('lan-mobile')), findsOneWidget);
      expect(find.byKey(const Key('lan-sms-soon')), findsOneWidget);
      final send = tester.widget<FilledButton>(
        find.byKey(const Key('lan-otp-send')),
      );
      expect(send.onPressed, isNull);
      await tapKey(tester, 'lan-switch-method');
      expect(find.byKey(const Key('lan-password')), findsOneWidget);
      // «فراموشی رمز» while SMS is off: same «به‌زودی», ask the manager
      await tapKey(tester, 'lan-forgot');
      expect(
        tester.widget<Text>(find.byKey(const Key('lan-sms-soon'))).data,
        contains('مدیر مدرسه'),
      );
      expect(lan.calls, ['probe:192.168.1.10:8080']);
    },
  );

  testWidgets('L160-W02 user code the manager set (4–9 digits) signs in', (
    tester,
  ) async {
    final lan = FakeLan()
      ..probes.add(info())
      ..logins.add(lanSession());
    final c = await boot(tester, lan: lan);
    await toLogin(tester);
    await typeAndTap(tester, {
      'lan-phone': '091',
      'lan-password': 'ramz-160',
    }, 'lan-login');
    expect(errorText(tester), LanServerRules.loginDigitsRuleFa);
    await typeAndTap(tester, {
      'lan-phone': '۸۰۰۱',
      'lan-password': 'ramz-160',
    }, 'lan-login');
    // the client normalizes (LanServerRules.normalizeLogin ⇒ 8001) — U01
    expect(lan.calls.last, 'login:۸۰۰۱:ramz-160');
    expect(LanServerRules.normalizeLogin('۸۰۰۱'), '8001');
    expect(c.state, isA<SignedIn>());
  });

  testWidgets(
    'L160-W03 owner chose mobile first + SMS linked: code → signed in; wrong code stays',
    (tester) async {
      final lan = FakeLan()
        ..probes.add(info(sms: true, primary: 'mobile'))
        ..otpRequests.add(const OtpTicket(length: 5))
        ..otpVerifies.addAll([
          const LanAccessFailure(LanAccessError.otpInvalid, status: 401),
          lanSession(),
        ]);
      final store = FakeSecureStore();
      final c = await boot(tester, lan: lan, store: store);
      await toLogin(tester);
      expect(find.byKey(const Key('lan-mobile')), findsOneWidget);
      expect(find.byKey(const Key('lan-sms-soon')), findsNothing);
      expect(find.text('ورود با نام کاربری و رمز عبور'), findsOneWidget);
      await typeAndTap(tester, {'lan-mobile': '0912'}, 'lan-otp-send');
      expect(errorText(tester), 'شمارهٔ همراه باید ۱۱ رقم و با ۰۹ باشد');
      await typeAndTap(tester, {'lan-mobile': '۰۹۱۲۰۰۰۰۰۱۰'}, 'lan-otp-send');
      expect(lan.calls.last, 'otp-request:09120000010:login');
      expect(find.byKey(const Key('lan-otp-sent')), findsOneWidget);
      expect(find.byKey(const Key('lan-otp-password')), findsNothing);
      await typeAndTap(tester, {'lan-otp-code': '12'}, 'lan-otp-verify');
      expect(errorText(tester), 'کد پیامکی ۵ رقم است');
      await typeAndTap(tester, {'lan-otp-code': '11111'}, 'lan-otp-verify');
      expect(errorText(tester), 'کد پیامکی درست نیست');
      expect(find.byKey(const Key('lan-otp-code')), findsOneWidget);
      await typeAndTap(tester, {'lan-otp-code': '۱۲۳۴۵'}, 'lan-otp-verify');
      expect(lan.calls.last, 'otp-verify:09120000010:12345:login:-');
      expect(c.state, isA<SignedIn>());
      expect(await store.read(LanKeys.deviceToken), 'dt-1');
    },
  );

  testWidgets(
    'L160-W04 «فراموشی رمز» by SMS: code + new password; expired code → back to the number',
    (tester) async {
      final lan = FakeLan()
        ..probes.add(info(sms: true))
        ..otpRequests.addAll([
          const OtpTicket(length: 5),
          const OtpTicket(length: 5),
        ])
        ..otpVerifies.addAll([
          const LanAccessFailure(LanAccessError.otpExpired, status: 401),
          lanSession(),
        ]);
      final c = await boot(tester, lan: lan);
      await toLogin(tester);
      expect(find.byKey(const Key('lan-password')), findsOneWidget);
      await tester.enterText(find.byKey(const Key('lan-phone')), '09120000010');
      await tapKey(tester, 'lan-forgot');
      expect(find.text('فراموشی رمز'), findsWidgets);
      final mobile = tester.widget<TextField>(
        find.byKey(const Key('lan-mobile')),
      );
      expect(mobile.controller!.text, '09120000010');
      await tapKey(tester, 'lan-otp-send');
      expect(lan.calls.last, 'otp-request:09120000010:reset');
      expect(find.byKey(const Key('lan-otp-password')), findsOneWidget);
      await typeAndTap(tester, {
        'lan-otp-code': '12345',
        'lan-otp-password': 'ab',
      }, 'lan-otp-verify');
      expect(errorText(tester), 'رمز تازه حداقل ۴ نویسه باشد');
      await typeAndTap(tester, {
        'lan-otp-code': '12345',
        'lan-otp-password': 'tazeh-160',
      }, 'lan-otp-verify');
      expect(errorText(tester), LanAccessError.otpExpired.messageFa());
      expect(find.byKey(const Key('lan-otp-code')), findsNothing);
      await tapKey(tester, 'lan-otp-send');
      await typeAndTap(tester, {
        'lan-otp-code': '12345',
        'lan-otp-password': 'tazeh-160',
      }, 'lan-otp-verify');
      expect(lan.calls.last, 'otp-verify:09120000010:12345:reset:tazeh-160');
      expect(c.state, isA<SignedIn>());
    },
  );

  testWidgets('L160-W05 code step: back and resend', (tester) async {
    final lan = FakeLan()
      ..probes.add(info(sms: true))
      ..otpRequests.addAll([
        const OtpTicket(),
        const LanAccessFailure(
          LanAccessError.rateLimited,
          status: 429,
          retryAfter: Duration(seconds: 40),
        ),
      ]);
    await boot(tester, lan: lan);
    await toLogin(tester);
    await tapKey(tester, 'lan-switch-method');
    await typeAndTap(tester, {'lan-mobile': '09120000010'}, 'lan-otp-send');
    await tapKey(tester, 'lan-otp-resend');
    expect(errorText(tester), contains('۴۰'));
    expect(find.byKey(const Key('lan-otp-code')), findsOneWidget);
    await tapKey(tester, 'lan-otp-back');
    expect(find.byKey(const Key('lan-otp-code')), findsNothing);
    expect(find.byKey(const Key('lan-mobile')), findsOneWidget);
  });
}
