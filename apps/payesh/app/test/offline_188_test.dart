// Row 188 — «سیستم مدرسه در دسترس نیست» stuck on a connected phone. Root cause (seen on the
// user's phone and in the server log): overnight the phone's LAN address of the school server
// stopped answering (Lantern VPN full tunnel), the session's token refresh found the SAME server at
// its public tunnel address (row 165) and moved there — but AutoSync / ChangeFeed had been built
// with the OLD address and kept pulling it: not one /api/v1/pull reached the server for hours,
// «اتصال دوباره» could not help, only killing the app did.
//
// Now (1) the data path is rebuilt whenever the session's server address changes, and (2) a pull
// or push that cannot reach the address itself starts the search for the server's other addresses.
// Real LanAccessClient + GatewayAttendanceSource + two real local sockets (= two addresses of one
// server).
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/attendance/attendance_wiring.dart';
import 'package:payesh_app/src/flags.dart';
import 'package:payesh_app/src/login/session_controller.dart';
import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_sync/payesh_sync.dart';

import 'lan_mode_127_test.dart' hide main;
import 'login_163_test.dart' hide main;

/// One address of the school server (instance `ab12cd34`); every request is logged.
Future<HttpServer> _serve(List<String> log) async {
  final srv = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  srv.listen((r) async {
    await utf8.decodeStream(r);
    log.add('${r.method} ${r.uri.path}');
    final auth = r.headers.value('authorization');
    Object out;
    var status = 200;
    switch (r.uri.path) {
      case '/api/health':
        out = {
          'ok': true,
          'name': 'payesh-local',
          'headless': true,
          'setup_done': true,
          'school': 'هنرستان آزمون',
          'instance': 'ab12cd34',
        };
      case '/api/auth/login':
      case '/api/auth/refresh':
        out = {
          'ok': true,
          'user': {'id': 10, 'role': 'vice', 'name': '1'},
          'session': {
            'token': 'acc-1',
            'expires_at': '2030-01-01T00:00:00.000Z',
          },
          'device_token': 'dt-1',
        };
      case '/api/v1/pull' when auth == 'Bearer acc-1':
        out = {
          'ok': true,
          'schema_version': 1,
          'server_time': '2026-11-26T06:00:00.000Z',
          'more': false,
          'collections': <String, Object>{},
          'deleted': <Object>[],
        };
      default:
        status = 404;
        out = {'ok': false, 'error': 'not_found'};
    }
    r.response
      ..statusCode = status
      ..headers.contentType = ContentType.json
      ..write(jsonEncode(out));
    await r.response.close();
  });
  return srv;
}

Future<void> _until(bool Function() ok, {String? reason}) async {
  for (var i = 0; i < 200 && !ok(); i++) {
    await Future<void>.delayed(const Duration(milliseconds: 25));
  }
  expect(ok(), isTrue, reason: reason);
}

void main() {
  group('offline bar on a connected phone (row 188)', () {
    HttpOverrides? saved;
    final logA = <String>[], logB = <String>[];
    late HttpServer a, b;
    late Uri addrA, addrB;
    late FakeDirectory dir;
    late SessionController c;
    late GatewayAttendanceSource src;

    setUp(() async {
      saved = HttpOverrides.current;
      HttpOverrides.global = null;
      logA.clear();
      logB.clear();
      a = await _serve(logA);
      b = await _serve(logB);
      addrA = Uri.parse('http://127.0.0.1:${a.port}');
      addrB = Uri.parse('http://127.0.0.1:${b.port}');
      dir = FakeDirectory([<Uri>[]])..byInstance['ab12cd34'] = [addrA, addrB];
      c = SessionController(
        api: NoGateway(),
        accounts: SchoolAccountStore(FakeSecureStore()),
        flags: ClientFlags.parse(),
        lan: LanAccessClient(platform: 'test', refreshRetryDelays: const []),
        directory: dir,
      );
      src = GatewayAttendanceSource(
        storage: Future.value(SqliteEngine.inMemory()),
        session: c,
      )..attach();
      await c.start();
      c.useLan();
      await c.submitLanServer('127.0.0.1:${a.port}');
      await c.submitLanLogin('09111111111', '1111111111');
      expect(c.state, isA<SignedIn>());
      await _until(() => logA.contains('GET /api/v1/pull'));
      expect(c.cellUrl, addrA);
    });

    tearDown(() async {
      await src.dispose();
      c.dispose();
      await a.close(force: true);
      await b.close(force: true);
      HttpOverrides.global = saved;
    });

    test('R188-01 the address stops answering ⇒ the failed pull itself finds the same server at its other address, and the data path pulls there', () async {
      await a.close(
        force: true,
      ); // e.g. a VPN switched on: the LAN address is gone
      await src.retry(); // «اتصال دوباره» / the next automatic cycle
      await _until(() => c.cellUrl == addrB, reason: 'session moved');
      await _until(
        () => logB.contains('GET /api/v1/pull'),
        reason: 'the data path follows the session to the new address',
      );
      await _until(() => c.sync.value.phase == SyncPhase.idle);
      expect(c.lanRelocated, addrB);
      expect(dir.addressCalls, 1);
    });

    test('R188-02 the session moves by itself (token refresh, row 165) ⇒ the data path is rebuilt on the new address — never left on the old one', () async {
      await a.close(force: true);
      await c.refresh(); // refresh at A fails → relocation → refresh at B
      expect(c.cellUrl, addrB);
      await _until(() => logB.contains('GET /api/v1/pull'));
      final before = logB.where((x) => x == 'GET /api/v1/pull').length;
      await src.retry();
      expect(
        logB.where((x) => x == 'GET /api/v1/pull').length,
        greaterThan(before),
      );
      expect(c.sync.value.phase, SyncPhase.idle);
    });

    test('R188-03 NEG nothing answers ⇒ offline (honest), the session stays on its own server, and AutoSync keeps a retry scheduled', () async {
      dir.byInstance['ab12cd34'] = [addrA];
      await a.close(force: true);
      await src.retry();
      await _until(() => c.sync.value.phase == SyncPhase.offline);
      expect(c.cellUrl, addrA);
      expect(
        c.state,
        isA<SignedIn>(),
        reason: 'never signed out by a network failure',
      );
      expect(
        c.sync.value.nextAttemptAt,
        isNotNull,
        reason: 'it retries by itself',
      );
    });

    test('R188-04 only "the address does not answer" starts the search', () {
      expect(
        GatewayAttendanceSource.unreachable(const SyncFailure('timeout')),
        isTrue,
      );
      expect(
        GatewayAttendanceSource.unreachable(
          const SyncFailure('network: Connection refused'),
        ),
        isTrue,
      );
      expect(
        GatewayAttendanceSource.unreachable(
          const SyncFailure('unavailable', status: 503),
        ),
        isFalse,
        reason: 'the server answered',
      );
      expect(
        GatewayAttendanceSource.unreachable(const SyncFailure('offline')),
        isFalse,
        reason: 'no token — nothing was sent',
      );
    });
  });
}
