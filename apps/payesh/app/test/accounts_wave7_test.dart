// Row 128, wave W7 — accounts: the manager's «نام کاربری و رمز» page, «رمز = کد ملی», «رمز
// تصادفی», account delete, every user's own password, the app lock and the manager rescue
// (claim). Widget tests drive the REAL app shell, pages, controllers, SessionController and
// UserDirectory on an in-memory SQLite + durable outbox; the school server is scripted
// (FakeAccounts / FakeLan). The real server path is school_admin_it_test.dart W7-IT-*.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/app.dart';
import 'package:payesh_app/src/flags.dart';
import 'package:payesh_app/src/login/session_controller.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_sync/payesh_sync.dart';

import 'lan_mode_127_test.dart' as lan;
import 'school_support.dart';
import 'users_wave6_test.dart' as w6;

FakeAccounts serverCreds() => FakeAccounts({
  11: const AccountCredential(
    id: 11,
    name: 'دبیر',
    role: 'teacher',
    username: '09120000011',
    password: 'moalem-1',
  ),
  21: const AccountCredential(
    id: 21,
    name: 'بهار سعیدی',
    role: 'student',
    username: '0012345678',
    password: '0012345678',
  ),
});

Future<MemorySchool> openCreds(
  WidgetTester tester,
  int id, {
  FakeAccounts? accounts,
  bool withAccounts = true,
}) async {
  final src = MemorySchool()
    ..accounts = withAccounts ? (accounts ?? serverCreds()) : null;
  await bootSchool(tester, role: 'manager', seed: w6.seed, source: src);
  await tapKey(tester, 'adm-users');
  await tapKey(tester, 'usr-menu-$id');
  await tapKey(tester, 'usr-creds-$id');
  return src;
}

String fieldText(WidgetTester tester, String key) =>
    tester.widget<TextField>(find.byKey(Key(key))).controller!.text;

/// LAN session (row 127 controller) for the lock / claim tests.
Future<SessionController> bootLan(
  WidgetTester tester, {
  required lan.FakeLan server,
  FakeSecureStore? store,
  String school = ClientFlags.defaultSchoolWaves,
}) async {
  final c = SessionController(
    api: lan.NoGateway(),
    accounts: SchoolAccountStore(store ?? FakeSecureStore()),
    flags: ClientFlags.parse(school: school),
    lan: server,
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

void main() {
  testWidgets(
    'W7-W01 the credentials page shows the server\'s username + password; '
    'NEG not offered when the build does not ship W7',
    (tester) async {
      final src = await openCreds(tester, 11);
      expect(fieldText(tester, 'crd-phone'), '09120000011');
      expect(fieldText(tester, 'crd-password'), 'moalem-1');
      expect(textOf(tester, 'crd-role'), contains('دبیر'));
      expect((src.accounts! as FakeAccounts).calls, ['creds']);
      // NEG: users wave only → no credentials entry in the row menu
      await tester.pumpWidget(const SizedBox());
      await bootSchool(tester, role: 'manager', seed: w6.seed, school: 'users');
      await tapKey(tester, 'adm-users');
      await tapKey(tester, 'usr-menu-11');
      expect(find.byKey(const Key('usr-creds-11')), findsNothing);
      expect(find.byKey(const Key('usr-edit-11')), findsOneWidget);
    },
  );

  testWidgets(
    'W7-W02 a new password goes to the school server, never into the queue; '
    'NEG a short one is refused locally',
    (tester) async {
      final acc = serverCreds();
      final src = await openCreds(tester, 11, accounts: acc);
      await typeKey(tester, 'crd-password', 'abc');
      await tapKey(tester, 'crd-save');
      expect(textOf(tester, 'crd-form-error'), contains('حداقل ۴'));
      expect(acc.calls.where((c) => c.startsWith('set:')), isEmpty);
      await typeKey(tester, 'crd-password', 'secret-9');
      await tapKey(tester, 'crd-save');
      expect(acc.calls, contains('set:11:-:secret-9'));
      expect(textOf(tester, 'crd-notice'), 'رمز تازه ثبت شد: secret-9');
      expect(src.outbox.list(), isEmpty, reason: 'F‑01: no password on disk');
      expect(acc.creds[11]!.password, 'secret-9');
    },
  );

  testWidgets(
    'W7-W03 offline: the username change is queued; NEG the password is refused with '
    'the "needs the school server" message and nothing of it is stored',
    (tester) async {
      final acc = serverCreds()..online = false;
      final src = await openCreds(tester, 11, accounts: acc);
      expect(find.byKey(const Key('crd-server')), findsOneWidget);
      await typeKey(tester, 'crd-phone', '09125550011');
      await tapKey(tester, 'crd-save');
      final ops = src.outbox.list();
      expect(ops, hasLength(1));
      expect(ops.single.collection, 'users');
      expect(ops.single.payload!['phone'], '09125550011');
      expect(textOf(tester, 'crd-notice'), 'نام کاربری در صف ارسال است');
      await typeKey(tester, 'crd-password', 'secret-9');
      await tapKey(tester, 'crd-save');
      expect(
        textOf(tester, 'crd-form-error'),
        const AccountFailure(AccountError.offline).messageFa,
      );
      expect(src.outbox.list(), hasLength(1));
      for (final o in src.outbox.list()) {
        expect(o.payload.toString(), isNot(contains('secret-9')));
      }
      // NEG: a mobile already used by someone else is refused on the device
      await typeKey(tester, 'crd-password', '');
      await typeKey(tester, 'crd-phone', '09120000040');
      await tapKey(tester, 'crd-save');
      expect(find.byKey(const Key('crd-form-error')), findsOneWidget);
      expect(src.outbox.list(), hasLength(1));
    },
  );

  testWidgets(
    'W7-W04 «رمز = کد ملی» asks the server and shows it; «رمز تصادفی» fills 8 '
    'characters locally',
    (tester) async {
      final acc = serverCreds();
      await openCreds(tester, 21, accounts: acc);
      await typeKey(tester, 'crd-password', 'x');
      await tapKey(tester, 'crd-auto');
      expect(acc.calls, contains('auto:21'));
      expect(fieldText(tester, 'crd-password'), '0012345678');
      expect(textOf(tester, 'crd-notice'), 'رمز = کد ملی شد: 0012345678');
      final before = acc.calls.length;
      await tapKey(tester, 'crd-random');
      expect(
        fieldText(tester, 'crd-password'),
        matches(r'^[a-hjkmnp-z2-9]{8}$'),
      );
      expect(acc.calls.length, before, reason: 'generated on the device');
    },
  );

  testWidgets('W7-W05 delete from the credentials page: NEG cancel keeps it; confirm removes the '
      'student and the lone parent (queued)', (tester) async {
    final src = await openCreds(tester, 21);
    await tapKey(tester, 'crd-delete');
    expect(find.textContaining('مریم'), findsWidgets);
    await tapKey(tester, 'crd-confirm-cancel');
    expect(src.outbox.list(), isEmpty);
    await tapKey(tester, 'crd-delete');
    await tapKey(tester, 'crd-confirm-ok');
    final ops = src.outbox.list();
    expect(ops.where((o) => o.type == 'del'), hasLength(3));
    expect(find.byKey(const Key('usr-row-21')), findsNothing);
  });

  testWidgets('W7-W06 own password: NEG mismatch (no call) and wrong current (server), then '
      'changed', (tester) async {
    final acc = serverCreds();
    final src = MemorySchool()..accounts = acc;
    await bootSchool(
      tester,
      role: 'teacher',
      seed: w6.seedTeacher,
      source: src,
    );
    await tapKey(tester, 'adm-password');
    await typeKey(tester, 'pw-current', 'old-pass');
    await typeKey(tester, 'pw-next', 'new-pass');
    await typeKey(tester, 'pw-again', 'new-pazz');
    await tapKey(tester, 'pw-save');
    expect(textOf(tester, 'pw-form-error'), 'رمز تازه و تکرارش یکی نیست');
    expect(acc.calls, isEmpty);
    await typeKey(tester, 'pw-current', 'not-mine');
    await typeKey(tester, 'pw-again', 'new-pass');
    await tapKey(tester, 'pw-save');
    expect(textOf(tester, 'pw-form-error'), 'رمز فعلی درست نیست');
    expect(acc.ownPassword, 'old-pass');
    await typeKey(tester, 'pw-current', 'old-pass');
    await typeKey(tester, 'pw-next', 'new-pass');
    await typeKey(tester, 'pw-again', 'new-pass');
    await tapKey(tester, 'pw-save');
    expect(acc.ownPassword, 'new-pass');
    expect(textOf(tester, 'pw-notice'), 'رمز عبور عوض شد');
    expect(src.outbox.list(), isEmpty);
  });

  testWidgets('W7-W07 NEG on a cloud session (no school server): the page says so, a password '
      'is refused, the username still queues', (tester) async {
    final src = await openCreds(tester, 11, withAccounts: false);
    expect(textOf(tester, 'crd-server'), contains('سرور مدرسه'));
    expect(fieldText(tester, 'crd-phone'), '09120000011');
    await typeKey(tester, 'crd-password', 'secret-9');
    await tapKey(tester, 'crd-save');
    expect(
      textOf(tester, 'crd-form-error'),
      const AccountFailure(AccountError.offline).messageFa,
    );
    expect(src.outbox.list(), isEmpty);
    await typeKey(tester, 'crd-password', '');
    await typeKey(tester, 'crd-phone', '09125550011');
    await tapKey(tester, 'crd-save');
    expect(src.outbox.list(), hasLength(1));
  });

  testWidgets('W7-W08 lock: survives a restart; NEG wrong password stays locked; the right one '
      'opens without a new login', (tester) async {
    final store = await lan.savedLan();
    final server = lan.FakeLan()..refreshes.add(lan.lanSession(device: 'dt-1'));
    final c = await bootLan(tester, server: server, store: store);
    expect(c.state, isA<SignedIn>());
    await tester.tap(find.byKey(const Key('session-menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('lock')));
    await tester.pumpAndSettle();
    expect(c.state, isA<Locked>());
    expect(find.byKey(const Key('unlock-password')), findsOneWidget);
    expect(await store.read(LanKeys.locked), '1');
    expect(await c.validToken(), isNull, reason: 'no access while locked');
    // restart: still locked, and no refresh was attempted
    await tester.pumpWidget(const SizedBox());
    final server2 = lan.FakeLan()
      ..unlocks.addAll([
        const LanAccessFailure(LanAccessError.badCredentials, status: 401),
        lan.lanSession(token: 'acc-2', device: 'dt-1'),
      ]);
    final c2 = await bootLan(tester, server: server2, store: store);
    expect(c2.state, isA<Locked>());
    expect(server2.calls, isEmpty);
    await tester.enterText(find.byKey(const Key('unlock-password')), 'nope');
    await tester.tap(find.byKey(const Key('unlock-submit')));
    await tester.pumpAndSettle();
    expect(c2.state, isA<Locked>());
    expect(lan.errorText(tester), LanAccessError.badCredentials.messageFa());
    await tester.enterText(
      find.byKey(const Key('unlock-password')),
      'moalem-127',
    );
    await tester.tap(find.byKey(const Key('unlock-submit')));
    await tester.pumpAndSettle();
    expect(server2.calls, ['unlock:dt-1:nope', 'unlock:dt-1:moalem-127']);
    expect(c2.state, isA<SignedIn>());
    expect(await c2.validToken(), 'acc-2');
    expect(await store.read(LanKeys.locked), isNull);
    expect(await store.read(LanKeys.deviceToken), 'dt-1');
  });

  testWidgets(
    'W7-W09 NEG lock is not offered without W7 or on a cloud session',
    (tester) async {
      final store = await lan.savedLan();
      final server = lan.FakeLan()..refreshes.add(lan.lanSession());
      await bootLan(tester, server: server, store: store, school: 'users');
      await tester.tap(find.byKey(const Key('session-menu')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('lock')), findsNothing);
      expect(find.byKey(const Key('sign-out')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await bootSchool(tester, role: 'manager', seed: w6.seed);
      await tester.tap(find.byKey(const Key('session-menu')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('lock')), findsNothing);
    },
  );

  testWidgets('W7-W10 claim on the server computer: NEG not offered for another address, NEG bad '
      'mobile (no request), then signed in as manager', (tester) async {
    final remote = lan.FakeLan()..probes.add(lan.serverInfo());
    await bootLan(tester, server: remote);
    await tester.tap(find.byKey(const Key('use-lan')));
    await tester.pumpAndSettle();
    await lan.typeAndTap(tester, {'lan-server': '192.168.1.10'}, 'lan-next');
    expect(find.byKey(const Key('lan-login')), findsOneWidget);
    expect(find.byKey(const Key('lan-claim')), findsNothing);
    await tester.pumpWidget(const SizedBox());
    final local = lan.FakeLan()
      ..probes.add(
        LanServerInfo(
          server: Uri.parse('http://127.0.0.1:8080'),
          setupDone: true,
          headless: true,
          schoolName: 'هنرستان شهید آزمون',
          instance: 'ab12cd34',
        ),
      )
      ..claims.add(lan.lanSession(role: 'manager', uid: 1, device: 'dt-m'));
    final store = FakeSecureStore();
    final c = await bootLan(tester, server: local, store: store);
    await tester.tap(find.byKey(const Key('use-lan')));
    await tester.pumpAndSettle();
    await lan.typeAndTap(tester, {'lan-server': '127.0.0.1'}, 'lan-next');
    await tester.tap(find.byKey(const Key('lan-claim')));
    await tester.pumpAndSettle();
    expect(c.state, isA<NeedClaim>());
    await lan.typeAndTap(tester, {
      'claim-phone': '0912',
      'claim-password': 'modir-1',
    }, 'claim-submit');
    expect(lan.errorText(tester), 'شمارهٔ همراه باید ۱۱ رقم باشد');
    expect(local.calls.where((x) => x.startsWith('claim')), isEmpty);
    await lan.typeAndTap(tester, {
      'claim-phone': '۰۹۱۲۰۰۰۰۱۲۸',
      'claim-password': 'modir-1',
    }, 'claim-submit');
    expect(local.calls.last, 'claim:127.0.0.1:09120000128:modir-1');
    final s = c.state as SignedIn;
    expect(s.currentRole, 'manager');
    expect(await store.read(LanKeys.deviceToken), 'dt-m');
    expect(store.values.values, isNot(contains('modir-1')));
  });
}
