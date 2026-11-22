// Row 171 — any device, any network, anywhere: the app reaches THIS user's school server with
// nothing typed. A fresh install's own empty server is not the school; a server of another school
// that answered first does not keep the user; «مدرسه روی سرور دیگری است» moves the app to the
// host by itself; a wrong password on the device's own server stays a wrong password. Real
// controller + real screens; a scripted network where every address answers for itself.
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/app.dart';
import 'package:payesh_app/src/flags.dart';
import 'package:payesh_app/src/login/session_controller.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_sync/payesh_sync.dart';

import 'lan_mode_127_test.dart' hide main;
import 'login_163_test.dart' hide main;

const _down = LanAccessFailure(LanAccessError.unreachable);
const _wrong = LanAccessFailure(LanAccessError.badCredentials, status: 401);

final local = Uri.parse('http://127.0.0.1:8080');
final schoolA = Uri.parse('http://192.168.1.10:8080');
final schoolB = Uri.parse('https://b.example.ir');
final central = Uri.parse('https://central.example.ir');
final pc = Uri.parse('https://pc.example.ir');

LanServerInfo serverAt(
  Uri u, {
  bool setupDone = true,
  String id = 'i0000001',
}) => LanServerInfo(
  server: u,
  setupDone: setupDone,
  headless: true,
  schoolName: 'مدرسهٔ ${u.host}',
  instance: id,
);

/// Every address answers for itself: probe → [probes][host], login → [logins][host].
final class NetLan implements LanAccessApi {
  final calls = <String>[];
  final probes = <String, Object>{};
  final logins = <String, Object>{};

  Future<T> _answer<T>(Object? a, String what) async {
    calls.add(what);
    if (a == null) throw _down;
    if (a is T) return a as T;
    throw a;
  }

  @override
  Future<LanServerInfo> probe(Uri server) =>
      _answer(probes[server.host], 'probe:${server.host}');

  @override
  Future<LanSession> login({
    required Uri server,
    required String phone,
    required String password,
    required String deviceName,
  }) => _answer(logins[server.host], 'login:${server.host}');

  @override
  dynamic noSuchMethod(Invocation invocation) => throw _down;
}

Future<SessionController> boot(
  WidgetTester tester,
  NetLan lan, {
  required FakeDirectory directory,
  FakeSecureStore? store,
}) async {
  final c = SessionController(
    api: const UnconfiguredSchoolAccess(),
    accounts: SchoolAccountStore(store ?? FakeSecureStore()),
    flags: ClientFlags.parse(),
    lan: lan,
    directory: directory,
    now: () => DateTime.utc(2026, 11, 22, 8),
  );
  addTearDown(c.dispose);
  await tester.pumpWidget(
    PayeshApp(session: c, today: () => DateTime(2026, 11, 22)),
  );
  await c.start();
  await tester.pumpAndSettle();
  return c;
}

List<String> loginsOf(NetLan lan) =>
    lan.calls.where((x) => x.startsWith('login:')).toList();

void main() {
  group('row 171 — the right school server, from anywhere', () {
    testWidgets(
      'A171-01 fresh install: this computer\'s EMPTY server is skipped — the central server from the list opens its login (no setup form) and signs in',
      (tester) async {
        final store = FakeSecureStore();
        final lan = NetLan()
          ..probes[local.host] = serverAt(local, setupDone: false)
          ..probes[central.host] = serverAt(central, id: 'central01')
          ..logins[central.host] = lanSession();
        final dir = FakeDirectory([
          [central],
        ]);
        final c = await boot(tester, lan, directory: dir, store: store);
        final s = c.state as NeedLan;
        expect(s.info?.server, central);
        expect(s.needsSetup, isFalse);
        await c.connectAndLogin('09121234567', '0012345678');
        await tester.pumpAndSettle();
        expect(c.state, isA<SignedIn>());
        expect(loginsOf(lan), ['login:${central.host}']);
        expect(await store.read(LanKeys.homeServer), central.toString());
      },
    );

    testWidgets(
      'A171-02 two schools: the server that answered first does not know the user ⇒ the other school server of the list signs them in (and is remembered)',
      (tester) async {
        final store = FakeSecureStore();
        final lan = NetLan()
          ..probes[schoolA.host] = serverAt(schoolA, id: 'schoolAA')
          ..probes[schoolB.host] = serverAt(schoolB, id: 'schoolBB')
          ..logins[schoolA.host] = _wrong
          ..logins[schoolB.host] = lanSession(role: 'manager');
        final dir = FakeDirectory([
          [schoolA, schoolB],
        ]);
        final c = await boot(tester, lan, directory: dir, store: store);
        expect((c.state as NeedLan).info?.server, schoolA);
        await c.connectAndLogin('teacher2', 'pass-1234');
        await tester.pumpAndSettle();
        expect(c.state, isA<SignedIn>());
        expect(c.cellUrl, schoolB);
        expect(loginsOf(lan), [
          'login:${schoolA.host}',
          'login:${schoolB.host}',
        ]);
        expect(await store.read(LanKeys.lastServer), schoolB.toString());
        expect(await store.read(LanKeys.homeServer), schoolB.toString());
      },
    );

    testWidgets(
      'A171-03 «school hosted elsewhere» (409 + host instance/addresses) ⇒ the app goes to THAT host first, by itself',
      (tester) async {
        final lan = NetLan()
          ..probes[central.host] = serverAt(central, id: 'central01')
          ..probes[schoolA.host] = serverAt(schoolA, id: 'schoolAA')
          ..probes[pc.host] = serverAt(pc, id: 'pc000001')
          ..logins[central.host] = LanAccessFailure(
            LanAccessError.hostedElsewhere,
            status: 409,
            instance: 'pc000001',
            urls: [pc],
          )
          ..logins[schoolA.host] = lanSession(role: 'teacher')
          ..logins[pc.host] = lanSession(role: 'manager');
        final dir = FakeDirectory([
          [central, schoolA],
        ]);
        final c = await boot(tester, lan, directory: dir);
        await c.connectAndLogin('manager1', 'pass-1234');
        await tester.pumpAndSettle();
        expect(c.state, isA<SignedIn>());
        expect(c.cellUrl, pc);
        expect(loginsOf(lan), ['login:${central.host}', 'login:${pc.host}']);
      },
    );

    testWidgets(
      'A171-04 NEG a wrong password on the server this device already signs in on stays «wrong password» — no other server is tried',
      (tester) async {
        final store = FakeSecureStore();
        await store.write(LanKeys.lastServer, schoolA.toString());
        await store.write(LanKeys.homeServer, schoolA.toString());
        final lan = NetLan()
          ..probes[schoolA.host] = serverAt(schoolA, id: 'schoolAA')
          ..probes[schoolB.host] = serverAt(schoolB, id: 'schoolBB')
          ..logins[schoolA.host] = _wrong
          ..logins[schoolB.host] = lanSession();
        final dir = FakeDirectory([
          [schoolB],
        ]);
        final c = await boot(tester, lan, directory: dir, store: store);
        await c.connectAndLogin('teacher2', 'bad-pass');
        await tester.pumpAndSettle();
        final s = c.state as NeedLan;
        expect(s.info?.server, schoolA);
        expect(s.error, LanAccessError.badCredentials.messageFa());
        expect(loginsOf(lan), ['login:${schoolA.host}']);
      },
    );

    testWidgets(
      'A171-05 another server KNOWS the user (school inactive) ⇒ its answer is shown, on that server',
      (tester) async {
        final lan = NetLan()
          ..probes[schoolA.host] = serverAt(schoolA, id: 'schoolAA')
          ..probes[schoolB.host] = serverAt(schoolB, id: 'schoolBB')
          ..logins[schoolA.host] = _wrong
          ..logins[schoolB.host] = const LanAccessFailure(
            LanAccessError.schoolInactive,
            status: 403,
          );
        final dir = FakeDirectory([
          [schoolA, schoolB],
        ]);
        final c = await boot(tester, lan, directory: dir);
        await c.connectAndLogin('teacher2', 'pass-1234');
        await tester.pumpAndSettle();
        final s = c.state as NeedLan;
        expect(s.info?.server, schoolB);
        expect(s.error, LanAccessError.schoolInactive.messageFa());
      },
    );

    testWidgets(
      'A171-06 NEG an EMPTY server of the list is never logged into (it would make the user its manager)',
      (tester) async {
        final lan = NetLan()
          ..probes[schoolA.host] = serverAt(schoolA, id: 'schoolAA')
          ..probes[schoolB.host] = serverAt(schoolB, setupDone: false)
          ..logins[schoolA.host] = _wrong
          ..logins[schoolB.host] = lanSession();
        final dir = FakeDirectory([
          [schoolA, schoolB],
        ]);
        final c = await boot(tester, lan, directory: dir);
        await c.connectAndLogin('teacher2', 'pass-1234');
        await tester.pumpAndSettle();
        final s = c.state as NeedLan;
        expect(s.info?.server, schoolA);
        expect(s.error, LanAccessError.badCredentials.messageFa());
        expect(loginsOf(lan), ['login:${schoolA.host}']);
      },
    );
  });
}
