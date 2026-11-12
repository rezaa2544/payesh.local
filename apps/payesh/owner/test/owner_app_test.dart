import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/app.dart';
import 'package:payesh_owner/src/platform.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';

import 'support/fake_backend.dart';

const _origin = 'https://owner.example.ir';

Future<void> _pumpApp(
  WidgetTester tester, {
  required FakeBackend backend,
  required MemorySettingsStore store,
  Size size = const Size(1600, 1100),
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(OwnerApp(store: store, httpFactory: () => backend));
  await tester.pumpAndSettle();
}

Future<void> _login(
  WidgetTester tester,
  String id,
  String pw, [
  String totp = '123456',
]) async {
  await tester.enterText(find.byKey(const Key('login_id')), id);
  await tester.enterText(find.byKey(const Key('password')), pw);
  await tester.enterText(find.byKey(const Key('totp')), totp);
  await tester.tap(find.byKey(const Key('login-submit')));
  await tester.pumpAndSettle();
}

Future<void> _go(WidgetTester tester, String page) async {
  await tester.tap(find.byKey(Key('nav-$page')));
  await tester.pumpAndSettle();
}

Future<void> _tap(WidgetTester tester, String key) async {
  final f = find.byKey(Key(key));
  await tester.ensureVisible(f);
  await tester.pumpAndSettle();
  await tester.tap(f);
  await tester.pumpAndSettle();
}

Future<void> _fillDialog(
  WidgetTester tester,
  String reason, {
  String? retype,
  Map<String, String> fields = const {},
}) async {
  for (final e in fields.entries) {
    await tester.enterText(find.byKey(Key('dlg-${e.key}')), e.value);
  }
  await tester.enterText(find.byKey(const Key('dlg-reason')), reason);
  if (retype != null) {
    await tester.enterText(find.byKey(const Key('dlg-retype')), retype);
  }
  await tester.tap(find.byKey(const Key('dlg-submit')));
  await tester.pumpAndSettle();
}

String _flash(WidgetTester tester) =>
    tester.widget<Text>(find.byKey(const Key('flash'))).data!;

void main() {
  group('first start + login', () {
    testWidgets(
      'asks for the server origin, rejects unsafe ones, remembers a valid one',
      (tester) async {
        final store = MemorySettingsStore();
        await _pumpApp(tester, backend: FakeBackend(), store: store);
        expect(find.byKey(const Key('origin')), findsOneWidget);

        for (final bad in [
          'http://owner.example.ir',
          'https://owner.example.ir/panel',
          'javascript:alert(1)',
          'owner',
        ]) {
          await tester.enterText(find.byKey(const Key('origin')), bad);
          await tester.tap(find.byKey(const Key('origin-save')));
          await tester.pumpAndSettle();
          expect(
            find.byKey(const Key('origin-error')),
            findsOneWidget,
            reason: bad,
          );
          expect(store.values['origin'], isNull);
        }
        await tester.enterText(
          find.byKey(const Key('origin')),
          'HTTPS://Owner.Example.IR/',
        );
        await tester.tap(find.byKey(const Key('origin-save')));
        await tester.pumpAndSettle();
        expect(store.values['origin'], _origin);
        expect(find.byKey(const Key('login-submit')), findsOneWidget);
        expect(find.text('سرور: $_origin'), findsOneWidget);
      },
    );

    testWidgets(
      'password + wrong TOTP ⇒ refused; password + TOTP ⇒ panel; token never persisted',
      (tester) async {
        final store = MemorySettingsStore({'origin': _origin});
        final be = FakeBackend();
        await _pumpApp(tester, backend: be, store: store);
        await _login(tester, 'owner', 'pw-owner-1', '000000');
        expect(find.text(ownerErrors['login_failed']!), findsOneWidget);
        expect(find.byKey(const Key('nav-rail')), findsNothing);
        // fields are cleared after an attempt (no secret left in the form)
        expect(
          tester
              .widget<TextField>(find.byKey(const Key('password')))
              .controller!
              .text,
          isEmpty,
        );

        await _login(tester, 'owner', 'pw-owner-1');
        expect(find.byKey(const Key('nav-rail')), findsOneWidget);
        expect(find.byKey(const Key('role-platform_owner')), findsOneWidget);
        expect(find.byKey(const Key('metric-subscriptions')), findsOneWidget);
        final login = be.posts('/auth/login').last.body!;
        expect(login, {
          'login_id': 'owner',
          'password': 'pw-owner-1',
          'totp': '123456',
        });
        // only the origin is stored — never the token or the password
        expect(store.values.keys, ['origin']);
        expect(store.values.values.join(), isNot(contains('pw-owner')));
        // authenticated calls carry the bearer token; no cookies
        final get = be.sent.firstWhere((s) => s.path == '/dashboard');
        expect(
          get.headers['Authorization'] ?? get.headers['authorization'],
          startsWith('Bearer '),
        );
      },
    );

    testWidgets('server 401 ⇒ session dropped ⇒ login screen with notice', (
      tester,
    ) async {
      final be = FakeBackend();
      await _pumpApp(
        tester,
        backend: be,
        store: MemorySettingsStore({'origin': _origin}),
      );
      await _login(tester, 'owner', 'pw-owner-1');
      be.expireNext = true;
      await _go(tester, 'plans');
      expect(find.byKey(const Key('login-submit')), findsOneWidget);
      expect(find.byKey(const Key('nav-rail')), findsNothing);
      expect(find.text(ownerErrors['unauthorized']!), findsOneWidget);
    });

    testWidgets(
      'logout returns to login; change server keeps the old one until saved',
      (tester) async {
        final store = MemorySettingsStore({'origin': _origin});
        await _pumpApp(tester, backend: FakeBackend(), store: store);
        await _login(tester, 'owner', 'pw-owner-1');
        await tester.tap(find.byKey(const Key('logout')));
        await tester.pumpAndSettle();
        expect(find.byKey(const Key('login-submit')), findsOneWidget);
        await tester.tap(find.byKey(const Key('change-server')));
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const Key('origin')),
          'http://127.0.0.1:8099',
        );
        await tester.tap(find.byKey(const Key('origin-save')));
        await tester.pumpAndSettle();
        expect(store.values['origin'], 'http://127.0.0.1:8099');
        expect(find.text('سرور: http://127.0.0.1:8099'), findsOneWidget);
      },
    );

    testWidgets('theme choice cycles and is remembered', (tester) async {
      final store = MemorySettingsStore({'origin': _origin});
      await _pumpApp(tester, backend: FakeBackend(), store: store);
      await tester.tap(find.byKey(const Key('theme')));
      await tester.pumpAndSettle();
      expect(store.values['theme'], 'light');
      await tester.tap(find.byKey(const Key('theme')));
      await tester.pumpAndSettle();
      expect(store.values['theme'], 'dark');
      expect(
        tester.widget<MaterialApp>(find.byType(MaterialApp)).themeMode,
        ThemeMode.dark,
      );
      await tester.tap(find.byKey(const Key('theme')));
      await tester.pumpAndSettle();
      expect(store.values.containsKey('theme'), isFalse);
    });
  });

  group('all nine pages', () {
    testWidgets(
      'owner: every page of the web panel renders its data natively',
      (tester) async {
        await _pumpApp(
          tester,
          backend: FakeBackend(),
          store: MemorySettingsStore({'origin': _origin}),
        );
        await _login(tester, 'owner', 'pw-owner-1');
        expect(ownerPages.length, 9);
        final expectText = <String, String>{
          'dashboard': 'کاربران فعال پلتفرم',
          'schools': 'فهرست مدارس',
          'plans': 'پایه',
          'limits': '۲۳۰',
          'health': 'gw-1',
          'infra': 'رادکلود',
          'operators': 'کاربران پلتفرم',
          'reports': 'اشتراک‌ها بر اساس پلن',
          'audit': 'دفتر ممیزی زنجیره‌هش',
        };
        for (final (id, title) in ownerPages) {
          await _go(tester, id);
          expect(
            find.descendant(
              of: find.byType(AppBar),
              matching: find.text(title),
            ),
            findsOneWidget,
            reason: id,
          );
          expect(
            find.textContaining(expectText[id]!),
            findsWidgets,
            reason: id,
          );
          expect(
            find.byKey(const Key('state-error')),
            findsNothing,
            reason: id,
          );
          expect(tester.takeException(), isNull, reason: id);
        }
      },
    );

    testWidgets('phone layout uses a drawer', (tester) async {
      await _pumpApp(
        tester,
        backend: FakeBackend(),
        store: MemorySettingsStore({'origin': _origin}),
        size: const Size(400, 860),
      );
      await _login(tester, 'owner', 'pw-owner-1');
      expect(find.byKey(const Key('nav-rail')), findsNothing);
      await tester.tap(find.byType(DrawerButton));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('nav-health')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('health-configured')), findsOneWidget);
      await tester.tap(find.byKey(const Key('account-menu')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('role-platform_owner')), findsOneWidget);
      await tester.tap(find.byKey(const Key('logout')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('login-submit')), findsOneWidget);
      expect(
        find.byType(BottomSheet),
        findsNothing,
      ); // the sheet does not outlive the session
      expect(tester.takeException(), isNull);
    });
  });

  group('CAPS matrix (buttons hidden by role; server still decides)', () {
    for (final role in OwnerRole.values) {
      testWidgets('role ${role.wire}', (tester) async {
        final login = switch (role) {
          OwnerRole.owner => ('owner', 'pw-owner-1'),
          OwnerRole.operator => ('operator', 'pw-operator'),
          OwnerRole.support => ('support', 'pw-support'),
        };
        await _pumpApp(
          tester,
          backend: FakeBackend(),
          store: MemorySettingsStore({'origin': _origin}),
        );
        await _login(tester, login.$1, login.$2);
        final caps = OwnerCaps.of(role);
        Future<void> check(String page, String key, bool want) async {
          await _go(tester, page);
          expect(
            find.byKey(Key(key)),
            want ? findsOneWidget : findsNothing,
            reason: '$page/$key',
          );
        }

        await check('schools', 'create-school', caps.createSchool);
        await check('schools', 'suspend-$tenantA', caps.suspend);
        await check('schools', 'delete-request-$tenantA', caps.deleteRequest);
        await check('plans', 'create-plan', caps.createPlan);
        await check('plans', 'renew-sub-a', caps.renew);
        await check('operators', 'create-user', caps.createUser);
        await check('operators', 'request-grant', caps.requestGrant);
        await check('infra', 'infra-add-provider', caps.infraRegister);
        await check('infra', 'infra-check-ep-0001-aaaa', caps.infraCheck);
        await check(
          'infra',
          'infra-req-disable-provider-prov-0001-aaaa',
          caps.infraRequestChange,
        );
      });
    }
  });

  group('mutations: reason ≥ 10, retype, server verdict', () {
    testWidgets(
      'suspend: short reason refused locally; valid ⇒ POST + reload',
      (tester) async {
        final be = FakeBackend();
        await _pumpApp(
          tester,
          backend: be,
          store: MemorySettingsStore({'origin': _origin}),
        );
        await _login(tester, 'owner', 'pw-owner-1');
        await _go(tester, 'schools');
        await _tap(tester, 'suspend-$tenantA');
        await _fillDialog(tester, 'کوتاه');
        expect(find.text(ownerErrors['reason_too_short']!), findsOneWidget);
        expect(be.posts('/tenants/$tenantA/suspend'), isEmpty);
        await _fillDialog(tester, 'تعلیق به درخواست مدیر مدرسه');
        final post = be.posts('/tenants/$tenantA/suspend').single.body!;
        expect(post['reason'], 'تعلیق به درخواست مدیر مدرسه');
        expect(post['idempotency_key'], isA<String>());
        expect(_flash(tester), 'مدرسه تعلیق شد.');
        expect(
          find.byKey(Key('suspend-$tenantA')),
          findsNothing,
        ); // reloaded: now suspended
      },
    );

    testWidgets(
      'deletion request needs the tenant id retyped; self-approve hidden; second owner approves',
      (tester) async {
        final be = FakeBackend();
        final store = MemorySettingsStore({'origin': _origin});
        await _pumpApp(tester, backend: be, store: store);
        await _login(tester, 'owner', 'pw-owner-1');
        await _go(tester, 'schools');
        await _tap(tester, 'delete-request-$tenantB');
        await _fillDialog(
          tester,
          'پایان قرارداد مدرسه و درخواست کتبی',
          retype: 'wrong',
        );
        expect(find.byKey(const Key('dlg-error')), findsOneWidget);
        expect(be.posts('/tenants/$tenantB/deletion-request'), isEmpty);
        await _fillDialog(
          tester,
          'پایان قرارداد مدرسه و درخواست کتبی',
          retype: tenantB,
        );
        expect(
          be
              .posts('/tenants/$tenantB/deletion-request')
              .single
              .body!['confirm_tenant_id'],
          tenantB,
        );
        final id = be.deletions.single['id'];
        expect(find.byKey(Key('wait-second-owner-$id')), findsOneWidget);
        expect(find.byKey(Key('deletion-approve-$id')), findsNothing);
        expect(find.byKey(Key('deletion-open-$tenantB')), findsOneWidget);

        await tester.tap(find.byKey(const Key('logout')));
        await tester.pumpAndSettle();
        await _login(tester, 'owner2', 'pw-owner-2');
        await _go(tester, 'schools');
        await _tap(tester, 'deletion-approve-$id');
        await _fillDialog(tester, 'تأیید مالک دوم پس از تماس', retype: tenantB);
        expect(_flash(tester), 'حذف تأیید شد؛ اجرا پس از ۲۴ ساعت ممکن است.');
        expect(find.byKey(Key('wait-delay-$id')), findsOneWidget);
        expect(find.byKey(Key('deletion-execute-$id')), findsNothing);
      },
    );

    testWidgets('server refusal is shown with the Persian error text', (
      tester,
    ) async {
      final be = FakeBackend();
      await _pumpApp(
        tester,
        backend: be,
        store: MemorySettingsStore({'origin': _origin}),
      );
      await _login(tester, 'owner', 'pw-owner-1');
      be.deletions.add({
        'id': 'del-x',
        'tenant_id': tenantA,
        'status': 'pending',
        'requested_by': owner2Sub,
        'reason': 'r',
        'created_at': '2026-11-01T00:00:00Z',
      });
      be.failNext = 'four_eyes_required';
      await _go(tester, 'schools');
      await _tap(tester, 'deletion-approve-del-x');
      await _fillDialog(tester, 'تأیید درخواست حذف مدرسه', retype: tenantA);
      expect(_flash(tester), ownerErrors['four_eyes_required']);
    });

    testWidgets('create school: activation code shown once, never stored', (
      tester,
    ) async {
      final be = FakeBackend();
      final store = MemorySettingsStore({'origin': _origin});
      await _pumpApp(tester, backend: be, store: store);
      await _login(tester, 'owner', 'pw-owner-1');
      await _go(tester, 'schools');
      await _tap(tester, 'create-school');
      await _fillDialog(
        tester,
        'ساخت مدرسهٔ تازهٔ شهر',
        fields: {
          'slug': 'Bad Slug',
          'display_name': 'هنرستان',
          'manager_name': 'مدیر',
        },
      );
      expect(find.byKey(const Key('dlg-error')), findsOneWidget);
      await _fillDialog(
        tester,
        'ساخت مدرسهٔ تازهٔ شهر',
        fields: {'slug': 'school-12'},
      );
      final body = be.posts('/tenants').single.body!;
      expect(body['slug'], 'school-12');
      expect(body['plan_code'], 'basic');
      expect(body['provision_op_id'], isA<String>());
      expect(find.byKey(const Key('activation-code')), findsOneWidget);
      expect(find.text('ACT-SCHOOL-12-9F3K'), findsOneWidget);
      await tester.tap(find.byKey(const Key('once-close')));
      await tester.pumpAndSettle();
      expect(find.text('ACT-SCHOOL-12-9F3K'), findsNothing);
      expect(_flash(tester), 'مدرسه ساخته شد.');
      expect(store.values.values.join(), isNot(contains('ACT-')));
    });

    testWidgets('renew: days 1..366 validated; plan created', (tester) async {
      final be = FakeBackend();
      await _pumpApp(
        tester,
        backend: be,
        store: MemorySettingsStore({'origin': _origin}),
      );
      await _login(tester, 'owner', 'pw-owner-1');
      await _go(tester, 'plans');
      await _tap(tester, 'renew-sub-a');
      await _fillDialog(
        tester,
        'تمدید سالانهٔ قرارداد',
        fields: {'days': '400'},
      );
      expect(find.text('تعداد روز باید بین ۱ و ۳۶۶ باشد.'), findsOneWidget);
      await _fillDialog(
        tester,
        'تمدید سالانهٔ قرارداد',
        fields: {'days': '۳۰'},
      );
      expect(
        be.posts('/subscriptions/sub-a/renew').single.body!['extend_days'],
        30,
      );
      await _tap(tester, 'create-plan');
      await _fillDialog(
        tester,
        'پلن ویژهٔ هنرستان‌ها',
        fields: {'code': 'pro', 'name': 'حرفه‌ای', 'mb': '2048'},
      );
      expect(be.posts('/plans').single.body!['storage_mb'], 2048);
      expect(find.text('حرفه‌ای'), findsOneWidget);
    });

    testWidgets('operators: create user; support grant request validated', (
      tester,
    ) async {
      final be = FakeBackend();
      await _pumpApp(
        tester,
        backend: be,
        store: MemorySettingsStore({'origin': _origin}),
      );
      await _login(tester, 'owner', 'pw-owner-1');
      await _go(tester, 'operators');
      await _tap(tester, 'create-user');
      await _fillDialog(
        tester,
        'اپراتور تازهٔ پشتیبانی',
        fields: {'login_id': 'op2'},
      );
      expect(
        be.posts('/platform-users').single.body!['role'],
        'platform_owner',
      );
      await tester.tap(find.byKey(const Key('logout')));
      await tester.pumpAndSettle();
      await _login(tester, 'support', 'pw-support');
      await _go(tester, 'operators');
      await _tap(tester, 'request-grant');
      await _fillDialog(
        tester,
        'بررسی خطای همگام‌سازی',
        fields: {'tenant_id': 'not-a-uuid', 'case_ref': 'C-1'},
      );
      expect(find.text(ownerErrors['invalid_tenant_id']!), findsOneWidget);
      await _fillDialog(
        tester,
        'بررسی خطای همگام‌سازی',
        fields: {'tenant_id': tenantA, 'hours': '80'},
      );
      expect(find.text('مدت باید بین ۱ تا ۷۲ ساعت باشد.'), findsOneWidget);
      await _fillDialog(
        tester,
        'بررسی خطای همگام‌سازی',
        fields: {'hours': '4'},
      );
      final g = be.posts('/support-grants').single.body!;
      expect(g['tenant_id'], tenantA);
      expect(g['max_actions'], 3);
      final s = DateTime.parse('${g['starts_at']}'),
          e = DateTime.parse('${g['ends_at']}');
      expect(e.difference(s), const Duration(hours: 4));
      // support cannot approve; the owner sees the request in the list (from the audit ledger)
      final reqRef = be.events.first['subject_ref'];
      expect(find.byKey(Key('approve-grant-$reqRef')), findsNothing);
      await tester.tap(find.byKey(const Key('logout')));
      await tester.pumpAndSettle();
      await _login(tester, 'owner', 'pw-owner-1');
      await _go(tester, 'operators');
      expect(find.byKey(Key('approve-grant-$reqRef')), findsOneWidget);
    });

    testWidgets(
      'infra: credential refs only; change request ⇒ owner approve with short id retype',
      (tester) async {
        final be = FakeBackend();
        await _pumpApp(
          tester,
          backend: be,
          store: MemorySettingsStore({'origin': _origin}),
        );
        await _login(tester, 'owner', 'pw-owner-1');
        await _go(tester, 'infra');
        expect(find.byKey(const Key('provisioning-manual')), findsOneWidget);
        expect(
          find.byKey(const Key('metric-capacity_cpu-known')),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('metric-usage_cpu-unknown')),
          findsOneWidget,
        );
        expect(find.text('بحرانی'), findsOneWidget);
        await _tap(tester, 'infra-add-provider');
        await _fillDialog(
          tester,
          'ثبت ارائه‌دهندهٔ تازه',
          fields: {
            'code': 'arvan',
            'display_name': 'آروان',
            'credential_ref': 'sk_live_raw_token',
          },
        );
        expect(find.byKey(const Key('dlg-error')), findsOneWidget);
        expect(be.posts('/infra/providers'), isEmpty);
        await tester.tap(find.byKey(const Key('dlg-cancel')));
        await tester.pumpAndSettle();

        await _tap(tester, 'infra-check-ep-0001-aaaa');
        expect(_flash(tester), contains('Endpoint سالم است'));

        await _tap(tester, 'infra-req-disable-provider-prov-0001-aaaa');
        await _fillDialog(
          tester,
          'قطع قرارداد با ارائه‌دهنده',
          retype: 'radcloud',
        );
        final chg = be.changes.single;
        expect(chg['status'], 'pending');
        expect(
          be.providers.first['status'],
          'active',
        ); // nothing changes before approval
        await _tap(tester, 'infra-approve-${chg['id']}');
        await _fillDialog(
          tester,
          'تأیید قطع قرارداد ارائه‌دهنده',
          retype: shortId(chg['target_id']),
        );
        expect(be.providers.first['status'], 'disabled');
        expect(
          find.byKey(Key('change-status-${chg['id']}-executed')),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'limits page switches tenant; empty tenant shows the empty state',
      (tester) async {
        await _pumpApp(
          tester,
          backend: FakeBackend(),
          store: MemorySettingsStore({'origin': _origin}),
        );
        await _login(tester, 'owner', 'pw-owner-1');
        await _go(tester, 'limits');
        expect(find.byKey(const Key('limits-table')), findsOneWidget);
        expect(find.textContaining('۲۵٪'), findsOneWidget);
        await tester.tap(find.byKey(const Key('limits-tenant')));
        await tester.pumpAndSettle();
        await tester.tap(find.textContaining(shortId(tenantB)).last);
        await tester.pumpAndSettle();
        expect(find.byKey(const Key('state-empty')), findsOneWidget);
      },
    );

    testWidgets('audit chain indicator', (tester) async {
      final be = FakeBackend();
      await _pumpApp(
        tester,
        backend: be,
        store: MemorySettingsStore({'origin': _origin}),
      );
      await _login(tester, 'owner', 'pw-owner-1');
      await _go(tester, 'schools');
      await _tap(tester, 'suspend-$tenantA');
      await _fillDialog(tester, 'تعلیق آزمایشی برای ممیزی');
      await _tap(tester, 'suspend-$tenantB');
      await _fillDialog(tester, 'تعلیق آزمایشی برای ممیزی');
      await _go(tester, 'audit');
      expect(find.byKey(const Key('chain-continuous')), findsOneWidget);
      be.events.first['previous_hash'] = 'tampered';
      await tester.fling(
        find.byType(ListView).first,
        const Offset(0, 400),
        1000,
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('chain-broken')), findsOneWidget);
    });
  });

  test('FileSettingsStore round-trips in a private directory', () async {
    final dir = Directory.systemTemp.createTempSync('owner-settings');
    addTearDown(() => dir.deleteSync(recursive: true));
    final s = FileSettingsStore(() async => '${dir.path}/PayeshOwner');
    expect(await s.read('origin'), isNull);
    await s.write('origin', _origin);
    expect(await s.read('origin'), _origin);
    expect(
      File('${dir.path}/PayeshOwner/origin.txt').readAsStringSync(),
      _origin,
    );
    await s.write('origin', null);
    expect(await s.read('origin'), isNull);
  });
}
