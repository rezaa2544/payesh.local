// Row 186 — «اتصال به دیتابیس برقرار نشد» on the owner's phone: the Lantern VPN was on (full
// tunnel, non-bypassable) and refused every connection — the school server's LAN address and
// the internet alike — so no school server could answer. The app now (1) says when a VPN is up
// and what to do, and (2) searches again by itself until the school server answers, so it
// connects as soon as the VPN is off, the phone joins the school Wi-Fi or the server is back.
// Real controller + real screens, scripted school server / directory / VPN check.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/app.dart';
import 'package:payesh_app/src/flags.dart';
import 'package:payesh_app/src/login/session_controller.dart';
import 'package:payesh_app/src/login/vpn_probe.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_sync/payesh_sync.dart';

import 'lan_mode_127_test.dart' hide main;
import 'login_162_test.dart' hide main;
import 'login_163_test.dart' hide main;

Future<SessionController> _boot(
  WidgetTester tester,
  FakeLan lan, {
  bool vpn = false,
  List<Duration> retry = const [],
  Future<bool> Function()? startLocal,
}) async {
  final c = SessionController(
    api: const UnconfiguredSchoolAccess(),
    accounts: SchoolAccountStore(FakeSecureStore()),
    flags: ClientFlags.parse(),
    lan: lan,
    directory: FakeDirectory([<Uri>[]]),
    startLocalServer: startLocal,
    vpnActive: () async => vpn,
    retryDelays: retry,
    now: () => DateTime.utc(2026, 11, 25, 8),
  );
  await tester.pumpWidget(
    PayeshApp(session: c, today: () => DateTime(2026, 11, 25)),
  );
  await c.start();
  await tester.pumpAndSettle();
  return c;
}

/// Unmounts the screens first (they listen to the controller), then disposes it — which also
/// cancels a pending automatic search.
Future<void> _finish(WidgetTester tester, SessionController c) async {
  await tester.pumpWidget(const SizedBox());
  c.dispose();
}

void main() {
  group('row 186 — connection on a phone with a VPN', () {
    testWidgets(
      'C186-01 a VPN is up and no school server answers: the line says so and the hint says what to do',
      (tester) async {
        final c = await _boot(tester, FakeLan(), vpn: true);
        final s = c.state as NeedLan;
        expect(s.notFound, isTrue);
        expect(s.vpn, isTrue);
        expect(pillText(tester), 'اتصال برقرار نشد — VPN روشن است');
        expect(find.byKey(const Key('lan-vpn-hint')), findsOneWidget);
        expect(find.text(SessionController.lanVpnFa), findsOneWidget);
        expect(find.byKey(const Key('lan-retry')), findsOneWidget);
        expect(tester.takeException(), isNull);
        await _finish(tester, c);
      },
    );

    testWidgets('C186-02 NEG no VPN: the usual red line, no VPN hint', (
      tester,
    ) async {
      final c = await _boot(tester, FakeLan());
      expect((c.state as NeedLan).vpn, isFalse);
      expect(pillText(tester), 'اتصال به دیتابیس برقرار نشد');
      expect(find.byKey(const Key('lan-vpn-hint')), findsNothing);
      await _finish(tester, c);
    });

    testWidgets(
      'C186-03 the search runs again by itself: once the server answers (VPN off) the app connects with no press, and the local server is started only once',
      (tester) async {
        var starts = 0;
        final lan = FakeLan();
        final c = await _boot(
          tester,
          lan,
          vpn: true,
          retry: const [Duration(seconds: 5), Duration(seconds: 10)],
          startLocal: () async {
            starts++;
            return false;
          },
        );
        expect((c.state as NeedLan).notFound, isTrue);
        final before = lan.calls.length;
        // first automatic search: still nothing — the red line stays (no spinner flicker)
        await tester.pump(const Duration(seconds: 5));
        await tester.pumpAndSettle();
        expect(lan.calls.length, greaterThan(before));
        expect((c.state as NeedLan).notFound, isTrue);
        expect(find.byKey(const Key('lan-searching')), findsNothing);
        // the VPN is switched off: the next search (10 s later) finds the school server
        lan.probes.add(info162());
        await tester.pump(const Duration(seconds: 10));
        await tester.pumpAndSettle();
        final s = c.state as NeedLan;
        expect(s.info, isNotNull);
        expect(pillText(tester), 'وصل به دیتابیس');
        expect(find.byKey(const Key('lan-vpn-hint')), findsNothing);
        expect(starts, 1, reason: 'automatic searches never start a process');
        // connected: no further searches
        final after = lan.calls.length;
        await tester.pump(const Duration(seconds: 60));
        expect(lan.calls.length, after);
        await _finish(tester, c);
      },
    );

    testWidgets(
      'C186-04 what the user typed survives the automatic searches; the last delay repeats',
      (tester) async {
        final lan = FakeLan();
        final c = await _boot(tester, lan, retry: const [Duration(seconds: 5)]);
        await tester.enterText(
          find.byKey(const Key('lan-phone')),
          '09121234567',
        );
        for (var i = 0; i < 3; i++) {
          final n = lan.calls.length;
          await tester.pump(const Duration(seconds: 5));
          await tester.pumpAndSettle();
          expect(lan.calls.length, greaterThan(n), reason: 'search ${i + 1}');
        }
        expect((c.state as NeedLan).notFound, isTrue);
        expect(
          tester
              .widget<TextField>(find.byKey(const Key('lan-phone')))
              .controller!
              .text,
          '09121234567',
        );
        await _finish(tester, c);
      },
    );

    test('C186-05 VPN interface names (Android)', () {
      for (final n in ['tun0', 'tun1', 'ppp0', 'wg0', 'tap0', 'ipsec0']) {
        expect(looksLikeVpnInterface(n), isTrue, reason: n);
      }
      for (final n in [
        'wlan0',
        'rmnet_data0',
        'clat4',
        'lo',
        'eth0',
        'dummy0',
        'p2p0',
      ]) {
        expect(looksLikeVpnInterface(n), isFalse, reason: n);
      }
    });
  });
}
