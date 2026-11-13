// Row 127 — LAN mode rules (school's own server on the local network). Pure unit tests; the real
// server path is lan_server_it_test.dart.
import 'dart:convert';
import 'dart:io';

import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

void main() {
  group('LanServerRules.parse — only local-network addresses', () {
    test('LAN-U01 typed forms → normalised base URI (default port 8080)', () {
      expect(
        '${LanServerRules.parse('192.168.1.10')}',
        'http://192.168.1.10:8080',
      );
      expect(
        '${LanServerRules.parse(' 192.168.1.10:9000 ')}',
        'http://192.168.1.10:9000',
      );
      expect(
        '${LanServerRules.parse('http://10.0.0.5:8080/')}',
        'http://10.0.0.5:8080',
      );
      expect(
        '${LanServerRules.parse('۱۹۲.۱۶۸.۱.۱۰')}',
        'http://192.168.1.10:8080',
      );
      expect('${LanServerRules.parse('172.16.4.2')}', 'http://172.16.4.2:8080');
      expect(
        '${LanServerRules.parse('172.31.255.1')}',
        'http://172.31.255.1:8080',
      );
      expect(
        '${LanServerRules.parse('127.0.0.1:8080')}',
        'http://127.0.0.1:8080',
      );
      expect('${LanServerRules.parse('localhost')}', 'http://localhost:8080');
      expect(
        '${LanServerRules.parse('School-Server')}',
        'http://school-server:8080',
      );
      expect(
        '${LanServerRules.parse('payesh.local')}',
        'http://payesh.local:8080',
      );
      expect(
        '${LanServerRules.parse('http://[fd00::12]:8080')}',
        'http://[fd00::12]:8080',
      );
      expect(
        '${LanServerRules.parse('https://192.168.1.10')}',
        'https://192.168.1.10',
      );
    });

    test(
      'LAN-U02 NEG public / malformed addresses are refused before any request',
      () {
        for (final bad in [
          '',
          '8.8.8.8',
          '172.32.0.1', // just outside 172.16/12
          '172.15.0.1',
          'payesh.example.ir',
          'https://gateway.payesh.ir',
          'http://203.0.113.9:8080',
          'ftp://192.168.1.10',
          'http://user:pw@192.168.1.10',
          '192.168.1.10/api',
          '192.168.1.10?x=1',
          '192.168.1.10 8080',
          'http://[2001:db8::1]:8080',
          '192.168.1.10:0',
        ]) {
          expect(LanServerRules.parse(bad), isNull, reason: bad);
        }
        expect(
          LanServerRules.allowed(Uri.parse('http://8.8.8.8:8080')),
          isFalse,
        );
        expect(
          LanServerRules.allowed(Uri.parse('http://192.168.0.2:8080')),
          isTrue,
        );
      },
    );

    test(
      'LAN-U03 school code: stable, fits SchoolAccessRules.school, lan- prefix',
      () {
        final u = Uri.parse('http://192.168.1.10:8080');
        expect(
          LanServerRules.schoolCode(u, 'a1b2c3d4e5f6'),
          'lan-a1b2c3d4e5f6',
        );
        expect(LanServerRules.schoolCode(u, null), 'lan-192-168-1-10-8080');
        final long = LanServerRules.schoolCode(u, 'X' * 80);
        expect(long.length, lessThanOrEqualTo(40));
        for (final c in [
          long,
          LanServerRules.schoolCode(u, '—'),
          'lan-a1b2c3d4e5f6',
        ]) {
          expect(SchoolAccessRules.school.hasMatch(c), isTrue, reason: c);
        }
      },
    );

    test(
      'LAN-U04 login normalisation keeps digits only (Persian digits too)',
      () {
        expect(LanServerRules.normalizeLogin('۰۹۱۲ ۱۲۳ ۴۵۶۷'), '09121234567');
        expect(LanServerRules.normalizeLogin('0012345678'), '0012345678');
      },
    );

    test('LAN-U04b login shape = web doLogin (11 / 10 digits) + row 145 user names', () {
      String? p(String s) => LanServerRules.loginProblem(s);
      for (final ok in [
        '09121234567',
        '۰۹۱۲ ۱۲۳ ۴۵۶۷',
        '0012345678',
        '٠٠١٢٣٤٥٦٧٨',
        'Ali.Rezaei',
        'm_karimi-2',
      ]) {
        expect(p(ok), isNull, reason: ok);
        expect(LanServerRules.validLogin(ok), isTrue, reason: ok);
      }
      expect(p(''), isNotNull);
      expect(p('   '), isNotNull);
      expect(p('0912'), LanServerRules.loginDigitsRuleFa);
      expect(p('091212345678'), LanServerRules.loginDigitsRuleFa);
      expect(p('+98 912 123 4567'), LanServerRules.loginDigitsRuleFa);
      expect(p('ab'), LanServerRules.usernameRuleFa);
      expect(p('1ali'), LanServerRules.usernameRuleFa);
      expect(p('ali rezaei'), LanServerRules.usernameRuleFa);
      expect(p('علی.رضایی'), LanServerRules.latinUsernameFa);
      expect(LanServerRules.digitsOnly(' ۰۹۱۲-۱۲۳ ٤٥٦٧ '), '09121234567');
      expect(LanServerRules.digitsOnly('ab09'), '09');
    });
  });

  group('mapLanError — one message per failure', () {
    test('LAN-U05 server error codes', () {
      LanAccessError k(
        int s,
        String? w, {
        LanAccessError u = LanAccessError.unknown,
      }) => mapLanError(s, {'error': ?w}, null, unauthorized: u).kind;
      expect(k(401, 'bad_credentials'), LanAccessError.badCredentials);
      expect(k(401, 'no_password'), LanAccessError.noPassword);
      expect(k(409, 'device_limit'), LanAccessError.deviceLimit);
      expect(k(401, 'device_revoked'), LanAccessError.deviceRevoked);
      expect(k(401, 'device_expired'), LanAccessError.deviceRevoked);
      expect(k(401, 'bad_device'), LanAccessError.deviceRevoked);
      expect(k(403, 'setup_local_only'), LanAccessError.setupLocalOnly);
      expect(k(400, 'already_setup'), LanAccessError.alreadySetup);
      expect(k(429, 'rate_limited'), LanAccessError.rateLimited);
      expect(k(503, null), LanAccessError.unreachable);
      expect(
        k(401, null, u: LanAccessError.deviceRevoked),
        LanAccessError.deviceRevoked,
      );
      expect(
        mapLanError(429, const {}, '7').retryAfter,
        const Duration(seconds: 7),
      );
      for (final e in LanAccessError.values) {
        expect(e.messageFa(), isNotEmpty);
      }
    });
  });

  group('LanAccountStore', () {
    test('LAN-U06 save/load/clear; rotated token persisted', () async {
      final store = FakeSecureStore();
      final a = LanAccountStore(store);
      expect(await a.load(), isNull);
      final s = SavedLan(
        server: Uri.parse('http://192.168.1.10:8080'),
        school: 'lan-abc123',
        deviceToken: 'dt-1',
        schoolName: 'هنرستان',
        role: 'teacher',
        uid: 10,
      );
      await a.save(s);
      final l = (await a.load())!;
      expect(l.deviceToken, 'dt-1');
      expect(l.uid, 10);
      expect(l.schoolName, 'هنرستان');
      await a.save(l.withToken('dt-2'));
      expect((await a.load())!.deviceToken, 'dt-2');
      await a.clear();
      expect(await a.load(), isNull);
      expect(await store.read(LanKeys.deviceToken), isNull);
    });

    test('LAN-U07 NEG a saved public address is never used', () async {
      final store = FakeSecureStore();
      await store.write(LanKeys.server, 'http://8.8.8.8:8080');
      await store.write(LanKeys.school, 'lan-abc');
      await store.write(LanKeys.deviceToken, 'dt');
      expect(await LanAccountStore(store).load(), isNull);
      await store.write(LanKeys.server, 'http://192.168.1.2:8080');
      await store.write(LanKeys.school, 'alborz-12'); // not a LAN code
      expect(await LanAccountStore(store).load(), isNull);
    });
  });

  group('LanAccessClient against a scripted local HTTP server', () {
    late HttpServer srv;
    late Uri base;
    final seen = <String>[];
    final bodies = <String, Map<String, Object?>>{};
    var health = <String, Object?>{};
    var refreshFails = 0;

    setUp(() async {
      seen.clear();
      bodies.clear();
      refreshFails = 0;
      health = {
        'ok': true,
        'name': 'payesh-local',
        'setup_done': true,
        'school': 'هنرستان',
        'instance': 'i1',
      };
      srv = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      base = Uri.parse('http://127.0.0.1:${srv.port}');
      srv.listen((r) async {
        final body = await utf8.decodeStream(r);
        seen.add(
          '${r.method} ${r.uri.path} ${r.headers.value('x-payesh-client') != null}',
        );
        Object? out;
        var status = 200;
        if (r.uri.path == '/api/health') {
          out = health;
        } else if (r.uri.path == '/api/auth/login') {
          final j = jsonDecode(body) as Map;
          if (j['phone'] == '09120000001' && j['password'] == 'pass1234') {
            out = {
              'ok': true,
              'user': {'id': 10, 'role': 'teacher', 'name': 'معلم'},
              'session': {
                'token': 'acc-1',
                'expires_at': '2030-01-01T00:00:00.000Z',
              },
              'device_token': 'dt-1',
              'device_id': 'abc',
            };
          } else {
            status = 401;
            out = {'ok': false, 'error': 'bad_credentials'};
          }
        } else if (r.uri.path == '/api/auth/refresh') {
          if (refreshFails > 0) {
            refreshFails--;
            status = 503;
            out = {'ok': false, 'error': 'unavailable'};
          } else if ((jsonDecode(body) as Map)['device_token'] == 'dt-1') {
            out = {
              'ok': true,
              'user': {'id': 10, 'role': 'teacher'},
              'session': {
                'token': 'acc-2',
                'expires_at': '2030-01-01T00:15:00.000Z',
              },
              'device_token': 'dt-2',
            };
          } else {
            status = 401;
            out = {'ok': false, 'error': 'device_revoked', 'wipe': true};
          }
        } else if (r.uri.path == '/api/setup' ||
            r.uri.path == '/api/auth/claim') {
          bodies[r.uri.path] = (jsonDecode(body) as Map)
              .cast<String, Object?>();
          out = {
            'ok': true,
            'user': {'id': 1, 'role': 'manager', 'name': 'مدیر'},
            'session': {
              'token': 'acc-m',
              'expires_at': '2030-01-01T00:00:00.000Z',
            },
            'device_token': 'dt-m',
          };
        } else if (r.uri.path == '/') {
          r.response.headers.contentType = ContentType.html;
          r.response.write('<html></html>');
          await r.response.close();
          return;
        } else {
          status = 404;
          out = {'ok': false};
        }
        r.response
          ..statusCode = status
          ..headers.contentType = ContentType.json
          ..write(jsonEncode(out));
        await r.response.close();
      });
    });

    tearDown(() => srv.close(force: true));

    test('LAN-U08 probe → login → refresh rotates the device token', () async {
      final c = LanAccessClient(refreshRetryDelays: const [Duration.zero]);
      final info = await c.probe(base);
      expect(info.setupDone, isTrue);
      expect(info.schoolName, 'هنرستان');
      expect(info.schoolCode, 'lan-i1');
      final s = await c.login(
        server: base,
        phone: '۰۹۱۲۰۰۰۰۰۰۱',
        password: 'pass1234',
        deviceName: 'd',
      );
      expect(s.token, 'acc-1');
      expect(s.deviceToken, 'dt-1');
      expect(s.uid, 10);
      expect(s.toSchoolSession('lan-i1').role, 'teacher');
      refreshFails = 1; // one lost answer → retried inside the grace window
      final r = await c.refresh(server: base, deviceToken: 'dt-1');
      expect(r.deviceToken, 'dt-2');
      expect(r.token, 'acc-2');
      expect(
        seen.where((x) => x.startsWith('POST /api/auth/refresh')).length,
        2,
      );
      expect(
        seen.every((x) => x.endsWith('true')),
        isTrue,
        reason: 'X-Payesh-Client on every call',
      );
      c.close();
    });

    test(
      'LAN-U09 NEG wrong password / reused token / not a Payesh server',
      () async {
        final c = LanAccessClient(refreshRetryDelays: const []);
        await expectLater(
          c.login(
            server: base,
            phone: '09120000001',
            password: 'nope',
            deviceName: 'd',
          ),
          throwsA(
            isA<LanAccessFailure>().having(
              (e) => e.kind,
              'kind',
              LanAccessError.badCredentials,
            ),
          ),
        );
        await expectLater(
          c.refresh(server: base, deviceToken: 'dt-old'),
          throwsA(
            isA<LanAccessFailure>().having(
              (e) => e.kind,
              'kind',
              LanAccessError.deviceRevoked,
            ),
          ),
        );
        health = {'ok': true, 'name': 'something-else'};
        await expectLater(
          c.probe(base),
          throwsA(
            isA<LanAccessFailure>().having(
              (e) => e.kind,
              'kind',
              LanAccessError.notSchoolServer,
            ),
          ),
        );
        // NEG: a public address is refused without a request
        final before = seen.length;
        await expectLater(
          c.probe(Uri.parse('http://8.8.8.8:8080')),
          throwsA(
            isA<LanAccessFailure>().having(
              (e) => e.kind,
              'kind',
              LanAccessError.badAddress,
            ),
          ),
        );
        expect(seen.length, before);
        c.close();
      },
    );

    test(
      'LAN-U10 NEG nothing listening → unreachable (no crash, no guess)',
      () async {
        final s = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
        final dead = Uri.parse('http://127.0.0.1:${s.port}');
        await s.close();
        final c = LanAccessClient(timeout: const Duration(seconds: 3));
        await expectLater(
          c.probe(dead),
          throwsA(
            isA<LanAccessFailure>().having(
              (e) => e.kind,
              'kind',
              LanAccessError.unreachable,
            ),
          ),
        );
        c.close();
      },
    );

    test('LAN-U11 setup and claim send what the web forms send (digits only, type, year)', () async {
      final c = LanAccessClient();
      await c.setup(
        server: base,
        schoolName: 'هنرستان نو',
        managerName: 'مدیر آزمون',
        phone: '۰۹۱۲ ۰۰۰-۰۱۴۶',
        password: 'modir-146',
        schoolType: 'متوسطه اول',
        schoolYear: ' ۱۴۰۵–۱۴۰۶ ',
      );
      expect(bodies['/api/setup'], {
        'school_name': 'هنرستان نو',
        'manager_name': 'مدیر آزمون',
        'phone': '09120000146',
        'password': 'modir-146',
        'school_type': 'متوسطه اول',
        'school_year': '۱۴۰۵–۱۴۰۶',
      });
      await c.claim(server: base, phone: '۰۹۱۲۰۰۰۰۱۴۶', password: 'modir-1');
      expect(bodies['/api/auth/claim'], {
        'phone': '09120000146',
        'password': 'modir-1',
      });
      c.close();
    });
  });
}
