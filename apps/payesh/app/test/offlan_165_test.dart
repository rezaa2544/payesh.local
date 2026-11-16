// Row 165 — a phone that signed in at school keeps working OUTSIDE the school network: when the
// saved LAN address no longer answers, the session finds the SAME server (same school code) at its
// other addresses in the owner's address list (public tunnel — Cloudflare / Tailscale / custom),
// saves it, and the sync carries on there. A different server answering is never used (the device
// token only belongs to its own server). Real controller + real screens, scripted server/list.
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/login/session_controller.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_sync/payesh_sync.dart';

import 'lan_mode_127_test.dart' hide main;
import 'login_162_test.dart' hide main;
import 'login_163_test.dart' hide main;

const _down = LanAccessFailure(LanAccessError.unreachable);
final _tunnel = Uri.parse('https://producing-spin-bookmarks.trycloudflare.com');

LanServerInfo _at(Uri server, {String instance = 'ab12cd34'}) => LanServerInfo(
  server: server,
  setupDone: true,
  headless: true,
  schoolName: 'هنرستان شهید آزمون',
  instance: instance,
);

Future<(SessionController, FakeLan, FakeSecureStore, FakeDirectory)> _signedIn(
  WidgetTester tester,
) async {
  final store = FakeSecureStore();
  final dir = FakeDirectory([
    [lanServer],
  ]);
  final lan = FakeLan()
    ..probes.addAll([_down, info162()])
    ..logins.add(lanSession());
  final c = await bootProd(tester, lan, store: store, directory: dir);
  await typeAndTap(tester, {
    'lan-phone': '09121234567',
    'lan-password': '0012345678',
  }, 'lan-login');
  expect(c.state, isA<SignedIn>());
  return (c, lan, store, dir);
}

void main() {
  group('off the school network (row 165)', () {
    testWidgets(
      'O165-01 LAN address gone ⇒ the same server at its public tunnel address is found, saved, and the sync goes on there',
      (tester) async {
        final (c, lan, store, dir) = await _signedIn(tester);
        dir.byInstance['ab12cd34'] = [lanServer, _tunnel];
        lan
          ..refreshes.addAll([_down, lanSession(device: 'dt-2')])
          ..probes.add(_at(_tunnel));
        await c.refresh();
        await tester.pumpAndSettle();
        expect(c.state, isA<SignedIn>());
        expect(c.lanRelocated, _tunnel);
        expect(dir.addressCalls, 1);
        // the dead LAN address is not probed again; the tunnel is
        expect(
          lan.calls.where((x) => x.startsWith('probe:')).last,
          'probe:producing-spin-bookmarks.trycloudflare.com:443',
        );
        expect(lan.calls.where((x) => x.startsWith('refresh:')).toList(), [
          'refresh:dt-1',
          'refresh:dt-1',
        ]);
        expect(await store.read(LanKeys.server), _tunnel.toString());
        expect(await store.read(LanKeys.deviceToken), 'dt-2');
        expect(c.sync.value.phase, SyncPhase.idle);
      },
    );

    testWidgets(
      'O165-02 NEG another server answers at that address ⇒ never used; the session stays on its own server (offline)',
      (tester) async {
        final (c, lan, store, dir) = await _signedIn(tester);
        dir.byInstance['ab12cd34'] = [_tunnel];
        lan
          ..refreshes.add(_down)
          ..probes.add(_at(_tunnel, instance: 'ff00ff00'));
        await c.refresh();
        await tester.pumpAndSettle();
        expect(c.state, isA<SignedIn>());
        expect(c.lanRelocated, isNull);
        expect(await store.read(LanKeys.server), lanServer.toString());
        expect(c.sync.value.phase, SyncPhase.offline);
      },
    );

    testWidgets(
      'O165-03 NEG the list does not name the server / nothing answers ⇒ offline, and the list is not asked again within 20 s',
      (tester) async {
        final (c, lan, _, dir) = await _signedIn(tester);
        lan.refreshes.addAll([_down, _down]);
        await c.refresh();
        await tester.pumpAndSettle();
        expect(c.sync.value.phase, SyncPhase.offline);
        expect(dir.addressCalls, 1);
        await c.refresh();
        await tester.pumpAndSettle();
        expect(dir.addressCalls, 1, reason: 'same clock ⇒ no second lookup');
      },
    );

    test('O165-04 list rows: every public address (https only, no path) after the LAN ones', () {
      final e = SchoolServerEntry.fromJson({
        'instance': 'ab12cd34',
        'at': '2026-11-16T08:00:00Z',
        'lan': ['http://192.168.1.120:8080'],
        'public_url': 'https://a.ts.net',
        'public_urls': [
          'https://a.ts.net',
          'https://x.trycloudflare.com/',
          'http://plain.example',
          'https://u:p@evil.example',
        ],
      })!;
      expect(e.publicUrls.map((u) => u.toString()), [
        'https://a.ts.net',
        'https://x.trycloudflare.com',
      ]);
      expect(
        SchoolDirectoryClient.addressesIn([e], 'AB12CD34').map((u) => '$u'),
        [
          'http://192.168.1.120:8080',
          'https://a.ts.net',
          'https://x.trycloudflare.com',
        ],
      );
      expect(SchoolDirectoryClient.addressesIn([e], 'other'), isEmpty);
      expect(
        SchoolDirectoryClient.candidatesOf([e]).map((u) => '$u'),
        contains('https://x.trycloudflare.com'),
      );
    });
  });
}
