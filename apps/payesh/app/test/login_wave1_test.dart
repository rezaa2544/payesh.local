// Row 74, wave 1 — school login/select. Widget tests drive the REAL screens and the REAL
// SessionController; only the network is a scripted fake (the real Directory + Gateway +
// PostgreSQL path is packages/payesh_sync/test/school_access_it_test.dart).
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/app.dart';
import 'package:payesh_app/src/flags.dart';
import 'package:payesh_app/src/login/session_controller.dart';
import 'package:payesh_app/src/login/wiring.dart';
import 'package:payesh_app/src/sync_badge.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_sync/payesh_sync.dart';

const code32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const secret32 = 'QRSTUVWXYZ234567ABCDEFGHIJKLMNOP';

/// Scripted network: each call pops the next answer (a value or a SchoolAccessFailure).
final class FakeAccess implements SchoolAccessApi {
  final calls = <String>[];
  final resolves = <Object>[];
  final activations = <Object>[];
  final refreshes = <Object>[];

  static SchoolSession session(String role, {String token = 'tok-1'}) =>
      SchoolSession(
        school: 'alborz-12',
        tenantId: 't-1',
        token: token,
        expiresAt: DateTime.utc(2030),
        role: role,
        uid: 7,
      );

  Future<T> _next<T>(List<Object> q, String what) {
    calls.add(what);
    if (q.isEmpty) return Future.error(StateError('unexpected $what'));
    final v = q.removeAt(0);
    return v is SchoolAccessFailure ? Future.error(v) : Future.value(v as T);
  }

  @override
  Future<SchoolRoute> resolve(String schoolCode) {
    // the real client validates on the device; keep that behaviour in the fake
    final c = SchoolAccessRules.normalizeSchool(schoolCode);
    if (!SchoolAccessRules.school.hasMatch(c)) {
      return Future.error(
        const SchoolAccessFailure(SchoolAccessError.badSchoolCode),
      );
    }
    return _next(resolves, 'resolve:$c');
  }

  @override
  Future<Activation> activate({
    required Uri cell,
    required String school,
    required String code,
    required String deviceId,
  }) {
    if (!SchoolAccessRules.code.hasMatch(
      SchoolAccessRules.normalizeCode(code),
    )) {
      return Future.error(
        const SchoolAccessFailure(SchoolAccessError.badActivationCode),
      );
    }
    return _next(activations, 'activate:$school@${cell.host}:$deviceId');
  }

  @override
  Future<SchoolSession> refresh({
    required Uri cell,
    required String school,
    required String deviceId,
    required String deviceSecret,
  }) => _next(refreshes, 'refresh:$school:$deviceSecret');
}

final route = SchoolRoute(
  schoolCode: 'alborz-12',
  cellUrl: Uri.parse('https://cell-1.example.ir'),
);

Future<SessionController> boot(
  WidgetTester tester, {
  required FakeAccess api,
  FakeSecureStore? store,
  ClientFlags? flags,
  DateTime Function()? now,
}) async {
  final c = SessionController(
    api: api,
    accounts: SchoolAccountStore(store ?? FakeSecureStore()),
    flags: flags ?? ClientFlags.parse(),
    now: now,
  );
  addTearDown(c.dispose);
  await tester.pumpWidget(
    PayeshApp(session: c, today: () => DateTime(2026, 11, 10)),
  );
  await c.start();
  await tester.pumpAndSettle();
  return c;
}

Future<void> typeAndTap(
  WidgetTester tester,
  String field,
  String text,
  String button,
) async {
  await tester.enterText(find.byKey(Key(field)), text);
  await tester.tap(find.byKey(Key(button)));
  await tester.pumpAndSettle();
}

String fieldText(WidgetTester tester, String key) =>
    tester.widget<TextField>(find.byKey(Key(key))).controller!.text;

String errorText(WidgetTester tester) =>
    tester.widget<Text>(find.byKey(const Key('login-error'))).data!;

void main() {
  group('feature flag — old vs new client', () {
    test('parse: fail-safe defaults and wave order', () {
      final d = ClientFlags.parse();
      expect(d.client, ClientChoice.native);
      expect(d.uses(NativeWave.login), isTrue);
      // waves 2–4 (attendance, grades, notices) ship by default since row 74 wave 4; parents not
      expect(d.uses(NativeWave.attendance), isTrue);
      expect(d.uses(NativeWave.grades), isTrue);
      expect(d.uses(NativeWave.notices), isTrue);
      expect(d.uses(NativeWave.parents), isFalse);
      expect(
        ClientFlags.parse(client: 'legacy').uses(NativeWave.login),
        isFalse,
      );
      // NEGATIVE: unknown client value → OLD client (never an untested path)
      expect(ClientFlags.parse(client: 'nativ').client, ClientChoice.legacy);
      expect(ClientFlags.parse(client: '').client, ClientChoice.legacy);
      // NEGATIVE: a later wave without the earlier ones is NOT enabled
      expect(ClientFlags.parse(waves: 'grades').waves, isEmpty);
      expect(ClientFlags.parse(waves: 'login,grades').waves, {
        NativeWave.login,
      });
      // grades without attendance stays off (waves are strictly in order)
      expect(
        ClientFlags.parse(waves: 'login,grades,notices')
            .uses(NativeWave.grades),
        isFalse,
      );
      expect(ClientFlags.parse(waves: ' LOGIN , attendance ,x').waves, {
        NativeWave.login,
        NativeWave.attendance,
      });
      // device choice: legacy always allowed; native only when the build ships login
      expect(d.withChoice('legacy').client, ClientChoice.legacy);
      final noLogin = ClientFlags.parse(client: 'legacy', waves: '');
      expect(noLogin.withChoice('native').client, ClientChoice.legacy);
      expect(
        ClientFlags.parse(client: 'legacy').withChoice('native').client,
        ClientChoice.native,
      );
      expect(d.withChoice('garbage').client, ClientChoice.native);
      expect(ClientFlags.fromEnvironment().client, ClientChoice.native);
    });

    testWidgets('build flag legacy → old-client screen, no login, no request', (
      tester,
    ) async {
      final api = FakeAccess();
      await boot(
        tester,
        api: api,
        flags: ClientFlags.parse(
          client: 'legacy',
          webUrl: 'https://payesh.school.ir',
        ),
      );
      expect(find.byKey(const Key('legacy-client')), findsOneWidget);
      expect(find.byKey(const Key('school-code')), findsNothing);
      expect(find.text('https://payesh.school.ir'), findsOneWidget);
      expect(api.calls, isEmpty);
    });

    testWidgets(
      'device switch to old client persists; back to native when shipped',
      (tester) async {
        final store = FakeSecureStore();
        final api = FakeAccess();
        final c = await boot(tester, api: api, store: store);
        expect(find.byKey(const Key('school-code')), findsOneWidget);
        await tester.tap(find.byKey(const Key('use-legacy')));
        await tester.pumpAndSettle();
        expect(find.byKey(const Key('legacy-client')), findsOneWidget);
        expect(find.byKey(const Key('legacy-url-missing')), findsOneWidget);
        expect(await store.read(SchoolKeys.clientChoice), 'legacy');
        // restart: the choice is kept
        await c.start();
        await tester.pumpAndSettle();
        expect(find.byKey(const Key('legacy-client')), findsOneWidget);
        await tester.tap(find.byKey(const Key('use-native')));
        await tester.pumpAndSettle();
        expect(find.byKey(const Key('school-code')), findsOneWidget);
        expect(await store.read(SchoolKeys.clientChoice), 'native');
      },
    );

    testWidgets(
      'NEGATIVE: build without the login wave offers no native switch',
      (tester) async {
        final store = FakeSecureStore();
        await store.write(SchoolKeys.clientChoice, 'native');
        final c = await boot(
          tester,
          api: FakeAccess(),
          store: store,
          flags: ClientFlags.parse(waves: ''),
        );
        expect(find.byKey(const Key('legacy-client')), findsOneWidget);
        expect(find.byKey(const Key('use-native')), findsNothing);
        await c.useNative(); // ignored
        await tester.pumpAndSettle();
        expect(find.byKey(const Key('legacy-client')), findsOneWidget);
      },
    );
  });

  group('school select → activation → signed in', () {
    testWidgets('happy path: RTL Persian screens, secret saved, token not', (
      tester,
    ) async {
      final store = FakeSecureStore();
      final api = FakeAccess()
        ..resolves.add(route)
        ..activations.add(Activation(FakeAccess.session('teacher'), secret32));
      final c = await boot(tester, api: api, store: store);
      final ctx = tester.element(find.byKey(const Key('school-code')));
      expect(Directionality.of(ctx), TextDirection.rtl);
      expect(find.text('ورود به مدرسه'), findsOneWidget);
      await typeAndTap(tester, 'school-code', 'ALBORZ-۱۲', 'school-next');
      expect(api.calls.last, 'resolve:alborz-12');
      expect(find.byKey(const Key('activation-code')), findsOneWidget);
      expect(find.text('alborz-12'), findsOneWidget);
      expect(find.byKey(const Key('school-notice')), findsNothing);
      await typeAndTap(
        tester,
        'activation-code',
        code32.toLowerCase(),
        'activation-submit',
      );
      expect(
        api.calls.last,
        startsWith('activate:alborz-12@cell-1.example.ir:pd-'),
      );
      expect(find.byKey(const Key('session-school')), findsOneWidget);
      expect(find.text('معلم'), findsOneWidget);
      expect(find.byKey(const Key('home-title')), findsOneWidget);
      expect(find.byKey(const Key('sync-idle')), findsOneWidget);
      expect(find.text('همگام'), findsOneWidget);
      expect(await store.read(SchoolKeys.deviceSecret), secret32);
      expect(await store.read(SchoolKeys.school), 'alborz-12');
      expect(await store.read(SecureKeys.sessionToken), isNull);
      for (final k in [
        SchoolKeys.school,
        SchoolKeys.cellUrl,
        SchoolKeys.deviceSecret,
        SchoolKeys.role,
      ]) {
        expect(await store.read(k), isNot('tok-1'), reason: k);
      }
      expect(await c.validToken(), 'tok-1');
    });

    testWidgets(
      'NEGATIVE: malformed school code → Persian error, nothing sent',
      (tester) async {
        final api = FakeAccess();
        await boot(tester, api: api);
        for (final bad in ['', 'ab', 'مدرسه', 'a b']) {
          await typeAndTap(tester, 'school-code', bad, 'school-next');
          expect(errorText(tester), contains('کد مدرسه درست نیست'));
        }
        expect(api.calls, isEmpty);
        expect(find.byKey(const Key('activation-code')), findsNothing);
      },
    );

    testWidgets('NEGATIVE: unknown school → «پیدا نشد», stays on step 1', (
      tester,
    ) async {
      final api = FakeAccess()
        ..resolves.add(
          const SchoolAccessFailure(
            SchoolAccessError.schoolNotFound,
            status: 404,
          ),
        );
      await boot(tester, api: api);
      await typeAndTap(tester, 'school-code', 'no-such-school', 'school-next');
      expect(errorText(tester), contains('پیدا نشد'));
      expect(find.byKey(const Key('school-code')), findsOneWidget);
      // what the user typed is kept
      expect(fieldText(tester, 'school-code'), 'no-such-school');
    });

    testWidgets('NEGATIVE: no internet at step 1 → offline message', (
      tester,
    ) async {
      final api = FakeAccess()
        ..resolves.add(const SchoolAccessFailure(SchoolAccessError.offline));
      await boot(tester, api: api);
      await typeAndTap(tester, 'school-code', 'alborz-12', 'school-next');
      expect(errorText(tester), contains('اتصال اینترنت برقرار نیست'));
    });

    testWidgets(
      'NEGATIVE: wrong/used activation code → rejected; bad shape → nothing sent',
      (tester) async {
        final api = FakeAccess()
          ..resolves.add(route)
          ..activations.add(
            const SchoolAccessFailure(
              SchoolAccessError.activationRejected,
              status: 401,
            ),
          );
        final store = FakeSecureStore();
        await boot(tester, api: api, store: store);
        await typeAndTap(tester, 'school-code', 'alborz-12', 'school-next');
        await typeAndTap(
          tester,
          'activation-code',
          '1234',
          'activation-submit',
        );
        expect(errorText(tester), contains('۳۲ نویسه'));
        expect(api.calls.where((c) => c.startsWith('activate')), isEmpty);
        await typeAndTap(
          tester,
          'activation-code',
          code32,
          'activation-submit',
        );
        expect(errorText(tester), contains('پذیرفته نشد'));
        expect(find.byKey(const Key('activation-code')), findsOneWidget);
        expect(await store.read(SchoolKeys.deviceSecret), isNull);
        // change school goes back to step 1 with the code prefilled
        await tester.tap(find.byKey(const Key('change-school')));
        await tester.pumpAndSettle();
        expect(fieldText(tester, 'school-code'), 'alborz-12');
      },
    );

    testWidgets('migrating school shows a notice on step 2', (tester) async {
      final api = FakeAccess()
        ..resolves.add(
          SchoolRoute(
            schoolCode: 'alborz-12',
            cellUrl: Uri.parse('https://cell-2.example.ir'),
            migrationState: 'migrating',
          ),
        );
      await boot(tester, api: api);
      await typeAndTap(tester, 'school-code', 'alborz-12', 'school-next');
      expect(find.byKey(const Key('school-notice')), findsOneWidget);
      expect(find.textContaining('در حال انتقال'), findsOneWidget);
    });

    testWidgets(
      'NEGATIVE: 429 → cooldown; no request until it ends, then allowed',
      (tester) async {
        var t = DateTime.utc(2026, 11, 10, 8);
        final api = FakeAccess()
          ..resolves.addAll([
            const SchoolAccessFailure(
              SchoolAccessError.rateLimited,
              status: 429,
              retryAfter: Duration(seconds: 30),
            ),
            route,
          ]);
        await boot(tester, api: api, now: () => t);
        await typeAndTap(tester, 'school-code', 'alborz-12', 'school-next');
        expect(errorText(tester), contains('۳۰ ثانیه'));
        t = t.add(const Duration(seconds: 10));
        await typeAndTap(tester, 'school-code', 'alborz-12', 'school-next');
        expect(errorText(tester), contains('۲۰ ثانیه'));
        expect(api.calls.length, 1, reason: 'no request during cooldown');
        t = t.add(const Duration(seconds: 21));
        await typeAndTap(tester, 'school-code', 'alborz-12', 'school-next');
        expect(api.calls.length, 2);
        expect(find.byKey(const Key('activation-code')), findsOneWidget);
      },
    );

    testWidgets('busy: button disabled and spinner while a request runs', (
      tester,
    ) async {
      final api = _SlowAccess();
      final c = SessionController(
        api: api,
        accounts: SchoolAccountStore(FakeSecureStore()),
        flags: ClientFlags.parse(),
      );
      addTearDown(c.dispose);
      await tester.pumpWidget(PayeshApp(session: c));
      await c.start();
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('school-code')), 'alborz-12');
      await tester.tap(find.byKey(const Key('school-next')));
      await tester.pump();
      expect(find.byKey(const Key('login-busy')), findsOneWidget);
      final btn = tester.widget<FilledButton>(
        find.byKey(const Key('school-next')),
      );
      expect(btn.onPressed, isNull);
      await c.submitSchool('alborz-12'); // ignored while busy
      expect(api.n, 1);
      api.done.complete(route);
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('activation-code')), findsOneWidget);
    });
  });

  group('offline-first restart, refresh, sign-out', () {
    Future<FakeSecureStore> savedStore() async {
      final s = FakeSecureStore();
      await SchoolAccountStore(s).save(
        SavedSchool(
          school: 'alborz-12',
          cellUrl: Uri.parse('https://cell-1.example.ir'),
          deviceSecret: secret32,
          role: 'manager',
        ),
      );
      return s;
    }

    testWidgets(
      'saved school + no internet → home opens, badge shows offline',
      (tester) async {
        final api = FakeAccess()
          ..refreshes.add(const SchoolAccessFailure(SchoolAccessError.offline));
        final c = await boot(tester, api: api, store: await savedStore());
        expect(api.calls.single, 'refresh:alborz-12:$secret32');
        expect(find.byKey(const Key('session-school')), findsOneWidget);
        expect(find.text('مدیر'), findsOneWidget);
        expect(find.byKey(const Key('sync-offline')), findsOneWidget);
        expect(find.textContaining('آفلاین'), findsOneWidget);
        expect(c.sync.value.lastError, contains('اتصال اینترنت'));
        expect(await c.validToken(), isNull, reason: 'offline: callers queue');
      },
    );

    testWidgets('tap the badge retries; success → همگام, role re-read', (
      tester,
    ) async {
      final api = FakeAccess()
        ..refreshes.addAll([
          const SchoolAccessFailure(SchoolAccessError.offline),
          FakeAccess.session('deputy', token: 'tok-2'),
        ]);
      final store = await savedStore();
      final c = await boot(tester, api: api, store: store);
      await tester.tap(find.byKey(const Key('sync-badge')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('sync-idle')), findsOneWidget);
      expect(find.text('معاون'), findsOneWidget);
      expect(await store.read(SchoolKeys.role), 'deputy');
      expect(await c.validToken(), 'tok-2');
    });

    testWidgets(
      'NEGATIVE: revoked device on refresh → back to step 1, secret erased',
      (tester) async {
        final api = FakeAccess()
          ..refreshes.add(
            const SchoolAccessFailure(
              SchoolAccessError.deviceRevoked,
              status: 401,
            ),
          );
        final store = await savedStore();
        await boot(tester, api: api, store: store);
        expect(find.byKey(const Key('school-code')), findsOneWidget);
        expect(errorText(tester), contains('دیگر معتبر نیست'));
        expect(await store.read(SchoolKeys.deviceSecret), isNull);
        expect(fieldText(tester, 'school-code'), 'alborz-12');
      },
    );

    testWidgets('NEGATIVE: tampered saved cell URL → treated as signed out', (
      tester,
    ) async {
      final store = await savedStore();
      await store.write(SchoolKeys.cellUrl, 'http://evil.example');
      final api = FakeAccess();
      await boot(tester, api: api, store: store);
      expect(find.byKey(const Key('school-code')), findsOneWidget);
      expect(api.calls, isEmpty);
    });

    testWidgets('expired token → validToken refreshes once', (tester) async {
      var t = DateTime.utc(2026, 11, 10);
      final expiring = SchoolSession(
        school: 'alborz-12',
        tenantId: 't-1',
        token: 'old',
        expiresAt: DateTime.utc(2026, 11, 10, 1),
        role: 'manager',
        uid: 1,
      );
      final api = FakeAccess()
        ..refreshes.addAll([
          expiring,
          FakeAccess.session('manager', token: 'new'),
        ]);
      final c = await boot(
        tester,
        api: api,
        store: await savedStore(),
        now: () => t,
      );
      expect(await c.validToken(), 'old');
      t = DateTime.utc(2026, 11, 10, 2);
      expect(await c.validToken(), 'new');
      expect(api.calls.length, 2);
    });

    testWidgets('sign-out is two-step; cancel keeps the session', (
      tester,
    ) async {
      final api = FakeAccess()..refreshes.add(FakeAccess.session('manager'));
      final store = await savedStore();
      await boot(tester, api: api, store: store);
      Future<void> openSignOut() async {
        await tester.tap(find.byKey(const Key('session-menu')));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('sign-out')));
        await tester.pumpAndSettle();
      }

      await openSignOut();
      await tester.tap(find.byKey(const Key('sign-out-cancel')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('session-school')), findsOneWidget);
      expect(await store.read(SchoolKeys.deviceSecret), secret32);
      await openSignOut();
      await tester.tap(find.byKey(const Key('sign-out-confirm')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('school-code')), findsOneWidget);
      expect(await store.read(SchoolKeys.deviceSecret), isNull);
      expect(await store.read(SecureKeys.deviceId), isNotNull);
    });

    testWidgets('menu → old client from the signed-in screen', (tester) async {
      final api = FakeAccess()..refreshes.add(FakeAccess.session('manager'));
      final store = await savedStore();
      await boot(tester, api: api, store: store);
      await tester.tap(find.byKey(const Key('session-menu')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('use-legacy')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('legacy-client')), findsOneWidget);
      expect(
        await store.read(SchoolKeys.deviceSecret),
        secret32,
        reason: 'switching client does not sign out',
      );
    });

    testWidgets('NEGATIVE: unexpected error type → Persian message, no crash', (
      tester,
    ) async {
      final api =
          FakeAccess(); // empty script → StateError (not a SchoolAccessFailure)
      final c = await boot(tester, api: api);
      await typeAndTap(tester, 'school-code', 'alborz-12', 'school-next');
      expect(errorText(tester), contains('خطای غیرمنتظره'));
      expect(c.state, isA<NeedSchool>());
    });

    testWidgets('NEGATIVE: secure store fails → Persian error, no crash', (
      tester,
    ) async {
      final c = SessionController(
        api: FakeAccess(),
        accounts: SchoolAccountStore(_BrokenStore()),
        flags: ClientFlags.parse(),
      );
      addTearDown(c.dispose);
      await tester.pumpWidget(PayeshApp(session: c));
      await c.start();
      await tester.pumpAndSettle();
      expect(errorText(tester), contains('حافظهٔ امن'));
    });
  });

  group('sync badge + wiring', () {
    testWidgets('every phase has text, icon and a semantics label', (
      tester,
    ) async {
      final c = await boot(tester, api: FakeAccess());
      for (final p in SyncPhase.values) {
        c.sync.value = SyncStatus(
          phase: p,
          pending: 2,
          inflight: 0,
          blocked: 1,
        );
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: Center(child: SyncBadgeHost(controller: c)),
            ),
          ),
        );
        expect(find.byKey(Key('sync-${p.name}')), findsOneWidget);
        expect(
          find.bySemanticsLabel(RegExp('^وضعیت همگام‌سازی: ')),
          findsOneWidget,
        );
      }
    });

    test(
      'NEGATIVE: no / invalid Gateway config → not configured, never a guess',
      () async {
        for (final api in [
          schoolAccessFromEnvironment(url: '', pins: ''),
          schoolAccessFromEnvironment(url: 'http://gw.example.ir', pins: 'x,y'),
          schoolAccessFromEnvironment(
            url: 'https://gw.example.ir',
            pins: '${'A' * 43}=',
          ),
        ]) {
          expect(api, isA<UnconfiguredSchoolAccess>());
          await expectLater(
            api.resolve('alborz-12'),
            throwsA(
              isA<SchoolAccessFailure>().having(
                (e) => e.kind,
                'kind',
                SchoolAccessError.unavailable,
              ),
            ),
          );
          await expectLater(
            api.activate(
              cell: route.cellUrl,
              school: 'a-b-c',
              code: code32,
              deviceId: 'pd-1234',
            ),
            throwsA(isA<SchoolAccessFailure>()),
          );
          await expectLater(
            api.refresh(
              cell: route.cellUrl,
              school: 'a-b-c',
              deviceId: 'pd-1234',
              deviceSecret: secret32,
            ),
            throwsA(isA<SchoolAccessFailure>()),
          );
        }
        final ok = schoolAccessFromEnvironment(
          url: 'https://gw.example.ir',
          pins: '${'A' * 43}=,${'B' * 43}=',
          directory: 'https://dir.example.ir',
        );
        expect(ok, isA<SchoolAccessClient>());
        expect((ok as SchoolAccessClient).directory.host, 'dir.example.ir');
        expect(ok.fallbackCell!.host, 'gw.example.ir');
        final insecureDir = schoolAccessFromEnvironment(
          url: 'https://gw.example.ir',
          pins: '${'A' * 43}=,${'B' * 43}=',
          directory: 'http://dir.example.ir',
        ) as SchoolAccessClient;
        expect(insecureDir.directory.host, 'gw.example.ir');
        ok.close();
        insecureDir.close();
      },
    );
  });
}

/// Hosts only the badge (unit view of every phase).
class SyncBadgeHost extends StatelessWidget {
  const SyncBadgeHost({super.key, required this.controller});
  final SessionController controller;
  @override
  Widget build(BuildContext context) => SyncBadge(status: controller.sync);
}

final class _SlowAccess extends FakeAccess {
  int n = 0;
  final done = Completer<SchoolRoute>();
  @override
  Future<SchoolRoute> resolve(String schoolCode) {
    n++;
    return done.future;
  }
}

final class _BrokenStore implements SecureStore {
  @override
  Future<String?> read(String key) =>
      Future.error(const SecureStoreException('keystore unavailable'));
  @override
  Future<void> write(String key, String value) =>
      Future.error(const SecureStoreException('keystore unavailable'));
  @override
  Future<void> delete(String key) =>
      Future.error(const SecureStoreException('keystore unavailable'));
}
