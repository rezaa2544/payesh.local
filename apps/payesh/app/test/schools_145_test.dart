// Row 145 — «درخواست ثبت نام مدرسه جدید» on the LAN login, user-name login of a school manager,
// and the subscription paywall (p2 port): trial once per device, gateway payment, receipt.
// Real screens + real SessionController with scripted LAN and schools APIs.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/app.dart';
import 'package:payesh_app/src/flags.dart';
import 'package:payesh_app/src/login/device_identity.dart';
import 'package:payesh_app/src/login/paywall.dart';
import 'package:payesh_app/src/login/session_controller.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_sync/payesh_sync.dart';

import 'lan_mode_127_test.dart'
    show FakeLan, NoGateway, lanServer, lanSession, serverInfo;

/// Scripted school server for row 145: each call pops the next answer.
final class FakeSchools implements LanSchoolsApi {
  final calls = <String>[];
  final registers = <Object>[];
  final statuses = <Object>[];
  final subs = <Object>[];
  final trials = <Object>[];
  final pays = <Object>[];
  final receipts = <Object>[];
  Map<String, Object?>? lastForm;

  Future<T> _next<T>(List<Object> q, String what) {
    calls.add(what);
    if (q.isEmpty) return Future.error(StateError('unexpected $what'));
    final v = q.removeAt(0);
    return v is LanAccessFailure ? Future.error(v) : Future.value(v as T);
  }

  @override
  Future<({String id, String token})> register(
    Uri server,
    SchoolSignup form, {
    String? deviceHash,
  }) {
    lastForm = form.toJson(deviceHash: deviceHash);
    return _next(registers, 'register:${form.normalizedUsername}');
  }

  @override
  Future<SignupStatus> registrationStatus(SignupTicket t) =>
      _next(statuses, 'status:${t.id}');

  @override
  Future<SubStatus> subStatus(Uri server, String token) =>
      _next(subs, 'sub:$token');

  @override
  Future<SubStatus> startTrial(Uri server, String token, String deviceHash) =>
      _next(trials, 'trial:$deviceHash');

  @override
  Future<({String payUrl, String paymentId})> startPayment(
    Uri server,
    String token,
    String plan,
  ) => _next(pays, 'pay:$plan');

  @override
  Future<SubPayment> submitReceipt(
    Uri server,
    String token,
    String plan,
    String ref,
  ) => _next(receipts, 'receipt:$plan:$ref');
}

SubStatus paywalled({bool trial = true, bool gateway = true}) =>
    SubStatus.fromJson({
      'managed': true,
      'access': false,
      'status': 'none',
      'role': 'manager',
      'policy': 'required',
      'school': 'هنرستان باهنر',
      'plans': [
        {'key': 'monthly', 'price': 250000},
        {'key': 'seasonal', 'price': 650000},
        {'key': 'yearly', 'price': 2200000},
      ],
      'trial_days': 14,
      'trial_available': trial,
      'gateway': gateway,
      'receipt': true,
      'receipt_note': 'کارت ۶۰۳۷-۹۹۹۹ به نام پایش',
      'pending': <Object>[],
    });

SubStatus active({String status = 'trial', int days = 14}) =>
    SubStatus.fromJson({
      'managed': true,
      'access': true,
      'status': status,
      'policy': 'required',
      'days_left': days,
      'end': '2026-11-26T08:00:00.000Z',
    });

void main() {
  late FakeLan lan;
  late FakeSchools schools;
  late FakeSecureStore store;
  late List<String> opened;
  String? deviceId;

  setUp(() {
    lan = FakeLan();
    schools = FakeSchools();
    store = FakeSecureStore();
    opened = [];
    deviceId = 'android-id-0123456789';
  });

  Future<SessionController> boot(WidgetTester tester) async {
    tester.view.physicalSize = const Size(900, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final c = SessionController(
      api: NoGateway(),
      accounts: SchoolAccountStore(store),
      flags: ClientFlags.parse(),
      lan: lan,
      schools: schools,
      deviceId: () async => deviceId,
      openUrl: (u) async {
        opened.add(u);
        return true;
      },
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

  Future<void> tap(WidgetTester tester, String key) async {
    final f = find.byKey(Key(key));
    await tester.ensureVisible(f);
    await tester.pumpAndSettle();
    await tester.tap(f);
    await tester.pumpAndSettle();
  }

  Future<void> type(WidgetTester tester, String key, String v) async {
    final f = find.byKey(Key(key));
    await tester.ensureVisible(f);
    await tester.enterText(f, v);
    await tester.pump();
  }

  Future<void> pick(WidgetTester tester, String key, String option) async {
    await tap(tester, key);
    await tester.tap(find.text(option).last);
    await tester.pumpAndSettle();
  }

  Future<void> toLogin(WidgetTester tester, {bool setupDone = true}) async {
    lan.probes.add(serverInfo(setupDone: setupDone));
    await tap(tester, 'use-lan');
    await type(tester, 'lan-server', '192.168.1.10:8080');
    await tap(tester, 'lan-next');
  }

  String text(WidgetTester tester, String key) {
    final w = tester.widget(find.byKey(Key(key)));
    return w is Text ? w.data! : (w as SelectableText).data!;
  }

  testWidgets(
    'S145-W01 registration request next to the login: validation, send, status, approved ⇒ login with the user name',
    (tester) async {
      await boot(tester);
      await toLogin(tester);
      expect(find.byKey(const Key('lan-login')), findsOneWidget);
      await tap(tester, 'lan-signup');
      expect(find.text('درخواست ثبت نام مدرسه جدید'), findsWidgets);
      // NEG: empty form ⇒ first missing field, nothing sent
      await tap(tester, 'signup-submit');
      expect(text(tester, 'signup-error'), 'نام مدرسه را بنویسید');
      await type(tester, 'signup-school', 'هنرستان باهنر');
      await pick(tester, 'signup-level', 'متوسطه دوم');
      await pick(tester, 'signup-province', 'خراسان رضوی');
      await type(tester, 'signup-county', 'نیشابور');
      await type(tester, 'signup-village', 'خرو');
      await type(tester, 'signup-phone', '۰۹۱۵۱۲۳۴۵۶۷');
      await type(tester, 'signup-staff', '25');
      await type(tester, 'signup-students', '320');
      await type(tester, 'signup-manager', 'محمد کریمی');
      await type(tester, 'signup-username', '9bad');
      await type(tester, 'signup-password', 'Karimi-1403');
      await tap(tester, 'signup-submit');
      expect(text(tester, 'signup-error'), contains('نام کاربری باید'));
      expect(schools.calls, isEmpty);
      // NEG: user name taken (server)
      schools.registers.addAll([
        const LanAccessFailure(
          LanAccessError.unknown,
          wire: 'username_taken',
          status: 409,
        ),
        (id: '1794579912714-0123456789abcdef', token: 'tok-1'),
      ]);
      await type(tester, 'signup-username', 'M.Karimi');
      await tap(tester, 'signup-submit');
      expect(text(tester, 'signup-error'), contains('قبلاً گرفته شده'));
      await tap(tester, 'signup-submit');
      expect(schools.calls.last, 'register:m.karimi');
      expect(schools.lastForm!['phone'], '09151234567');
      expect(schools.lastForm!['staff_count'], 25);
      expect(schools.lastForm!['student_count'], 320);
      expect(schools.lastForm!['village'], 'خرو');
      expect(
        schools.lastForm!['device_hash'],
        deviceHashOf('android-id-0123456789'),
      );
      expect(find.byKey(const Key('signup-pending')), findsOneWidget);
      expect(
        text(tester, 'signup-id'),
        'کد پیگیری: 1794579912714-0123456789abcdef',
      );
      expect(await SignupStore(store).load(), isNotNull);

      // still pending, then approved
      schools.statuses.addAll([
        const SignupStatus('pending'),
        const SignupStatus(
          'approved',
          school: 'هنرستان باهنر',
          username: 'm.karimi',
        ),
      ]);
      await tap(tester, 'signup-check');
      expect(find.byKey(const Key('signup-pending')), findsOneWidget);
      // leave and come back: the saved request is checked again
      await tap(tester, 'signup-back');
      expect(find.byKey(const Key('lan-login')), findsOneWidget);
      await tap(tester, 'lan-signup');
      expect(find.byKey(const Key('signup-approved')), findsOneWidget);
      await tap(tester, 'signup-login');
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('lan-phone')))
            .controller!
            .text,
        'm.karimi',
      );

      // user-name login ⇒ manager ⇒ paywall (subscription required, trial offered)
      lan.logins.add(lanSession(role: 'manager', uid: 1, token: 'acc-m'));
      schools.subs.add(paywalled());
      await type(tester, 'lan-password', 'Karimi-1403');
      await tap(tester, 'lan-login');
      expect(lan.calls.last, 'login:m.karimi:Karimi-1403');
      expect(find.byKey(const Key('paywall')), findsOneWidget);
      expect(find.byKey(const Key('paywall-trial')), findsOneWidget);
    },
  );

  testWidgets(
    'S145-W02 rejected request shows the reason; a new request starts over',
    (tester) async {
      await SignupStore(store).save(
        SignupTicket(
          server: lanServer,
          id: '1794579912999-fedcba9876543210',
          token: 'tok-2',
          schoolName: 'دبستان نمونه',
          username: 'other.mgr',
          at: DateTime.utc(2026, 11, 10),
        ),
      );
      schools.statuses.add(
        const SignupStatus('rejected', reason: 'اطلاعات مدرسه ناقص است'),
      );
      await boot(tester);
      await toLogin(tester);
      await tap(tester, 'lan-signup');
      expect(text(tester, 'signup-reason'), 'دلیل: اطلاعات مدرسه ناقص است');
      await tap(tester, 'signup-new');
      expect(find.byKey(const Key('signup-submit')), findsOneWidget);
      expect(await SignupStore(store).load(), isNull);
    },
  );

  testWidgets(
    'S145-W03 fresh server: «with the manager user name» instead of setup (owner-created school)',
    (tester) async {
      await boot(tester);
      await toLogin(tester, setupDone: false);
      expect(find.byKey(const Key('lan-setup-submit')), findsOneWidget);
      expect(find.byKey(const Key('lan-signup')), findsOneWidget);
      await tap(tester, 'lan-login-instead');
      expect(find.byKey(const Key('lan-login')), findsOneWidget);
      lan.logins.add(lanSession(role: 'manager', uid: 1, token: 'acc-m'));
      schools.subs.add(active(status: 'free'));
      await type(tester, 'lan-phone', 'Ali.Rezaei');
      await type(tester, 'lan-password', 'Madrese-1403');
      await tap(tester, 'lan-login');
      expect(lan.calls.last, 'login:Ali.Rezaei:Madrese-1403');
      expect(find.byKey(const Key('session-school')), findsOneWidget);
      expect(find.byKey(const Key('paywall')), findsNothing);
      expect(find.byKey(const Key('sub-banner')), findsNothing);
    },
  );

  testWidgets(
    'S145-W04 paywall: trial once per device (NEG used on this device), gateway opens the browser, receipt pending',
    (tester) async {
      await boot(tester);
      await toLogin(tester);
      lan.logins.add(lanSession(role: 'manager', uid: 1, token: 'acc-m'));
      schools.subs.add(paywalled());
      await type(tester, 'lan-phone', 'm.karimi');
      await type(tester, 'lan-password', 'Karimi-1403');
      await tap(tester, 'lan-login');
      expect(find.byKey(const Key('paywall')), findsOneWidget);
      expect(find.byKey(const Key('plan-yearly')), findsOneWidget);
      expect(find.textContaining('۲٬۲۰۰٬۰۰۰ ریال'), findsOneWidget);
      // row 149: yearly runs to the end of the school year (31 Shahrivar)
      expect(find.textContaining('تا پایان سال تحصیلی'), findsOneWidget);

      // NEG: this device already used its trial (reinstall does not help)
      schools.trials.add(
        const LanAccessFailure(
          LanAccessError.unknown,
          wire: 'trial_used_device',
          status: 409,
        ),
      );
      await tap(tester, 'paywall-trial');
      expect(schools.calls.last, 'trial:${deviceHashOf(deviceId)}');
      expect(text(tester, 'paywall-error'), contains('حتی با نصب دوبارهٔ'));

      // gateway: the server builds the link; the app opens it in the browser
      schools.pays.add((
        payUrl: 'https://pay.example/start?amount=650000&id=SUB-0A1B2C3D',
        paymentId: 'SUB-0A1B2C3D',
      ));
      await tap(tester, 'plan-seasonal');
      await tap(tester, 'paywall-pay');
      expect(schools.calls.last, 'pay:seasonal');
      expect(opened, [
        'https://pay.example/start?amount=650000&id=SUB-0A1B2C3D',
      ]);
      expect(text(tester, 'paywall-notice'), contains('SUB-0A1B2C3D'));
      expect(find.byKey(const Key('paywall-pay-url')), findsOneWidget);

      // receipt: NEG short ref; then pending until the owner approves
      await type(tester, 'paywall-ref', '12');
      await tap(tester, 'paywall-receipt');
      expect(text(tester, 'paywall-error'), contains('۴ تا ۴۰'));
      schools.receipts.add(
        const SubPayment(
          id: 'SUB-0A1B2C3E',
          plan: 'seasonal',
          amount: 650000,
          method: 'receipt',
          status: 'pending',
          ref: 'TRX-778899',
        ),
      );
      schools.subs.add(
        SubStatus.fromJson({
          ...{
            'managed': true,
            'access': false,
            'status': 'none',
            'plans': [
              {'key': 'seasonal', 'price': 650000},
            ],
            'receipt': true,
          },
          'pending': [
            {
              'id': 'SUB-0A1B2C3E',
              'plan': 'seasonal',
              'amount': 650000,
              'method': 'receipt',
              'status': 'pending',
              'ref': 'TRX-778899',
            },
          ],
        }),
      );
      await type(tester, 'paywall-ref', 'TRX-778899');
      await tap(tester, 'paywall-receipt');
      expect(schools.calls, contains('receipt:seasonal:TRX-778899'));
      expect(find.byKey(const Key('pending-SUB-0A1B2C3E')), findsOneWidget);
      expect(find.byKey(const Key('paywall-trial')), findsNothing);

      // owner approved ⇒ «بررسی دوباره» opens the app
      schools.subs.add(active(status: 'active', days: 90));
      await tap(tester, 'paywall-recheck');
      expect(find.byKey(const Key('paywall')), findsNothing);
      expect(find.byKey(const Key('sub-banner')), findsOneWidget);
    },
  );

  testWidgets(
    'S149-W01 manager renewal warning from 1 Tir ⇒ «تمدید» opens the plans',
    (tester) async {
      await boot(tester);
      await toLogin(tester);
      lan.logins.add(lanSession(role: 'manager', uid: 1, token: 'acc-m'));
      schools.subs.add(
        SubStatus.fromJson({
          'managed': true,
          'access': true,
          'status': 'active',
          'role': 'manager',
          'policy': 'required',
          'days_left': 60,
          'end': '2027-09-22T20:30:00.000Z',
          'year_end': '2027-09-22T20:30:00.000Z',
          'renew_warning': true,
          'plans': [
            {'key': 'monthly', 'price': 400000},
            {'key': 'yearly', 'price': 3500000},
          ],
          'trial_available': true,
          'gateway': false,
          'receipt': true,
        }),
      );
      await type(tester, 'lan-phone', 'm.karimi');
      await type(tester, 'lan-password', 'Karimi-1403');
      await tap(tester, 'lan-login');
      expect(find.byKey(const Key('paywall')), findsNothing);
      expect(find.byKey(const Key('sub-renew-warning')), findsOneWidget);
      await tap(tester, 'sub-renew');
      expect(find.byKey(const Key('paywall')), findsOneWidget);
      expect(
        find.descendant(
          of: find.byKey(const Key('paywall-status')),
          matching: find.textContaining('فعال'),
        ),
        findsOneWidget,
      );
      // active user: no trial; both role prices shown in rial
      expect(find.byKey(const Key('paywall-trial')), findsNothing);
      expect(find.textContaining('۳٬۵۰۰٬۰۰۰ ریال'), findsOneWidget);
      expect(find.byKey(const Key('paywall-year-end')), findsOneWidget);
    },
  );

  test('S149-U01 plan descriptions follow the 31 Shahrivar rule', () {
    const m = SubPlanOffer('monthly', 1);
    const y = SubPlanOffer('yearly', 1);
    final aban = DateTime.utc(2026, 11, 13, 10);
    expect(planDesc(m, aban), contains('۳۱ روز'));
    expect(planDesc(y, aban), contains('۳۱ شهریور ۱۴۰۶'));
    // 25 Shahrivar: monthly is capped at the end of the school year
    final late = DateTime.utc(2027, 9, 16, 8);
    expect(planDesc(m, late), contains('۳۱ شهریور ۱۴۰۶'));
    // renewal window: yearly covers the next school year
    expect(planDesc(y, late), contains('۳۱ شهریور ۱۴۰۷'));
  });

  testWidgets('S145-W05 trial starts ⇒ app opens with the trial badge', (
    tester,
  ) async {
    await boot(tester);
    await toLogin(tester);
    lan.logins.add(lanSession(role: 'parent', uid: 7, token: 'acc-p'));
    schools.subs.add(paywalled(gateway: false));
    await type(tester, 'lan-phone', '09121234567');
    await type(tester, 'lan-password', 'pass-1234');
    await tap(tester, 'lan-login');
    expect(find.byKey(const Key('paywall-pay')), findsNothing);
    expect(find.byKey(const Key('paywall-receipt-note')), findsOneWidget);
    schools.trials.add(active());
    await tap(tester, 'paywall-trial');
    expect(find.byKey(const Key('paywall')), findsNothing);
    expect(
      find.descendant(
        of: find.byKey(const Key('sub-banner')),
        matching: find.textContaining('تست رایگان — ۱۴ روز'),
      ),
      findsOneWidget,
    );
  });

  testWidgets(
    'S145-W06 NEG no device id ⇒ no trial request; inactive school ⇒ closed',
    (tester) async {
      deviceId = null;
      await boot(tester);
      await toLogin(tester);
      lan.logins.add(lanSession(role: 'manager', uid: 1, token: 'acc-m'));
      schools.subs.add(paywalled());
      await type(tester, 'lan-phone', 'm.karimi');
      await type(tester, 'lan-password', 'Karimi-1403');
      await tap(tester, 'lan-login');
      await tap(tester, 'paywall-trial');
      expect(schools.calls.where((c) => c.startsWith('trial')), isEmpty);
      expect(text(tester, 'paywall-error'), contains('شناسهٔ این دستگاه'));
      schools.subs.add(
        const LanAccessFailure(
          LanAccessError.schoolInactive,
          wire: 'school_inactive',
          status: 403,
        ),
      );
      await tap(tester, 'paywall-recheck');
      expect(find.byKey(const Key('paywall-school-blocked')), findsOneWidget);
    },
  );

  test('S145-U01 device identity helpers', () async {
    expect(
      parseMachineGuid(
        '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n'
        '    MachineGuid    REG_SZ    3F2504E0-4F89-11D3-9A0C-0305E82C3301\r\n',
      ),
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    );
    expect(parseMachineGuid('nothing'), isNull);
    expect(await openExternalUrl('ftp://x'), isFalse);
    expect(await openExternalUrl('not a url'), isFalse);
  });
}
