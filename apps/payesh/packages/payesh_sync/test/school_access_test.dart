import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

/// Row 74 wave 1 — SchoolAccessClient against a loopback stub (contract shapes copied from
/// openapi.yaml). The real Directory + Gateway + PostgreSQL run in school_access_it_test.dart.
void main() {
  late HttpServer server;
  late SchoolAccessClient client;
  late Uri base;
  final seen = <HttpRequest>[];
  final bodies = <String>[];
  late void Function(HttpRequest req) handler;
  const code32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  setUp(() async {
    seen.clear();
    bodies.clear();
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      seen.add(req);
      bodies.add(await utf8.decodeStream(req));
      handler(req);
    });
    base = Uri.parse('http://127.0.0.1:${server.port}');
    var n = 0;
    client = SchoolAccessClient(
      directory: base,
      deviceId: 'pd-test-1',
      requestId: () => 'rid-${++n}',
      timeout: const Duration(seconds: 2),
    );
  });
  tearDown(() async {
    client.close();
    await server.close(force: true);
  });

  void reply(
    int status,
    Object body, {
    Map<String, String> headers = const {},
  }) {
    handler = (req) {
      req.response.statusCode = status;
      headers.forEach(req.response.headers.set);
      req.response.headers.contentType = ContentType.json;
      req.response.write(body is String ? body : jsonEncode(body));
      req.response.close();
    };
  }

  Map<String, Object?> session({String? secret}) => {
    'ok': true,
    'tenant_id': '0b9d7c1e-0000-4000-8000-000000000001',
    'token': 'tok.abc',
    'expires_at': 1893456000000,
    'role': 'manager',
    'uid': 1,
    'device_secret': ?secret,
  };

  group('resolve (GET /api/dir/v1/resolve)', () {
    test(
      'sends the code normalised, no Authorization, standard headers',
      () async {
        reply(200, {
          'ok': true,
          'schema_version': 1,
          'school_code': 'alborz-1',
          'cell_id': '6a1b0a7e-0000-4000-8000-000000000002',
          'cell_url': 'https://cell-1.example.ir',
          'version': 3,
          'ttl': 120,
          'migration_state': 'stable',
          'stale': false,
        });
        final r = await client.resolve('  ALBORZ-۱ ');
        expect(r.schoolCode, 'alborz-1');
        expect(r.cellUrl.toString(), 'https://cell-1.example.ir');
        expect(r.ttl, const Duration(seconds: 120));
        expect(r.migrating, isFalse);
        final q = seen.single;
        expect(q.method, 'GET');
        expect(q.uri.path, '/api/dir/v1/resolve');
        expect(q.uri.queryParameters, {'school_code': 'alborz-1'});
        expect(q.headers.value(HttpHeaders.authorizationHeader), isNull);
        expect(q.headers.value('x-payesh-client'), 'payesh-native/0.1.0');
        expect(q.headers.value('x-request-id'), 'rid-1');
        expect(q.headers.value('x-device-id'), 'pd-test-1');
        expect(client.lastRequestId, 'rid-1');
      },
    );

    test('migrating school: route kept, flagged', () async {
      reply(200, {
        'ok': true,
        'school_code': 'alborz-1',
        'cell_url': 'https://cell-2.example.ir/base',
        'ttl': 5,
        'migration_state': 'migrating',
        'stale': true,
      });
      final r = await client.resolve('alborz-1');
      expect(r.migrating, isTrue);
      expect(r.stale, isTrue);
    });

    test(
      'NEGATIVE: malformed code is refused on the device — nothing is sent',
      () async {
        reply(200, {});
        for (final bad in [
          '',
          'ab',
          '-abc',
          'a b c',
          'مدرسه',
          'x' * 41,
          'ab_c',
        ]) {
          await expectLater(
            client.resolve(bad),
            throwsA(
              isA<SchoolAccessFailure>().having(
                (e) => e.kind,
                'kind',
                SchoolAccessError.badSchoolCode,
              ),
            ),
            reason: bad,
          );
        }
        expect(seen, isEmpty);
      },
    );

    test('NEGATIVE: unknown school (404) → schoolNotFound', () async {
      reply(404, {'ok': false, 'error': 'not_found'});
      await expectLater(
        client.resolve('no-such-school'),
        throwsA(
          isA<SchoolAccessFailure>()
              .having((e) => e.kind, 'kind', SchoolAccessError.schoolNotFound)
              .having((e) => e.messageFa, 'fa', contains('پیدا نشد')),
        ),
      );
    });

    test(
      'NEGATIVE: http cell URL (not loopback) is refused → insecureCell',
      () async {
        for (final u in [
          'http://cell.example.ir',
          'ftp://cell.example.ir',
          'https://user:pw@cell.example.ir',
          'not a url',
        ]) {
          reply(200, {'ok': true, 'school_code': 'alborz-1', 'cell_url': u});
          await expectLater(
            client.resolve('alborz-1'),
            throwsA(isA<SchoolAccessFailure>()),
            reason: u,
          );
        }
        expect(
          SchoolAccessRules.isAllowedCellUrl(
            Uri.parse('http://127.0.0.1:8080'),
          ),
          isTrue,
        );
      },
    );

    test('Directory not deployed (503 not_configured) → fallback cell when configured', () async {
      reply(503, {'ok': false, 'error': 'not_configured'});
      await expectLater(
        client.resolve('alborz-1'),
        throwsA(
          isA<SchoolAccessFailure>().having(
            (e) => e.kind,
            'kind',
            SchoolAccessError.unavailable,
          ),
        ),
      );
      final fb = SchoolAccessClient(
        directory: base,
        fallbackCell: Uri.parse('https://gw.example.ir'),
      );
      addTearDown(fb.close);
      final r = await fb.resolve('alborz-1');
      expect(r.cellUrl.host, 'gw.example.ir');
      reply(503, {'ok': false, 'error': 'cell_unavailable'});
      await expectLater(
        fb.resolve('alborz-1'),
        throwsA(isA<SchoolAccessFailure>()),
      );
    });

    test('NEGATIVE: ok:false or garbage 200 body → unknown', () async {
      reply(200, 'not json');
      await expectLater(
        client.resolve('alborz-1'),
        throwsA(
          isA<SchoolAccessFailure>().having(
            (e) => e.kind,
            'kind',
            SchoolAccessError.unknown,
          ),
        ),
      );
    });
  });

  group('activate (POST /api/gw/v1/session/activate)', () {
    test(
      'sends school/code/device_id exactly; returns session + device secret',
      () async {
        reply(200, session(secret: code32));
        final a = await client.activate(
          cell: base,
          school: 'Alborz-1',
          code: 'abcd-efgh ijkl-mnop qrst-uvwx yz23-4567',
          deviceId: 'pd-test-1',
        );
        expect(a.deviceSecret, code32);
        expect(a.session.role, 'manager');
        expect(a.session.roleFa, 'مدیر');
        expect(a.session.uid, 1);
        expect(a.session.school, 'alborz-1');
        expect(a.session.expiredAt(DateTime.utc(2029)), isFalse);
        expect(a.session.expiredAt(DateTime.utc(2031)), isTrue);
        expect(seen.single.uri.path, '/api/gw/v1/session/activate');
        expect(jsonDecode(bodies.single), {
          'school': 'alborz-1',
          'code': code32,
          'device_id': 'pd-test-1',
        });
        expect(
          seen.single.headers.value(HttpHeaders.authorizationHeader),
          isNull,
        );
      },
    );

    test(
      'NEGATIVE: wrong-shape code refused on the device — nothing is sent',
      () async {
        reply(200, session(secret: code32));
        for (final bad in [
          '',
          '1234',
          code32.substring(1),
          '${code32}A',
          'ABCDEFGHIJKLMNOPQRSTUVWXYZ234561',
        ]) {
          await expectLater(
            client.activate(
              cell: base,
              school: 'alborz-1',
              code: bad,
              deviceId: 'pd-test-1',
            ),
            throwsA(
              isA<SchoolAccessFailure>().having(
                (e) => e.kind,
                'kind',
                SchoolAccessError.badActivationCode,
              ),
            ),
            reason: bad,
          );
        }
        await expectLater(
          client.activate(
            cell: base,
            school: 'a',
            code: code32,
            deviceId: 'pd-test-1',
          ),
          throwsA(isA<SchoolAccessFailure>()),
        );
        await expectLater(
          client.activate(
            cell: base,
            school: 'alborz-1',
            code: code32,
            deviceId: 'x',
          ),
          throwsA(isA<SchoolAccessFailure>()),
        );
        expect(seen, isEmpty);
      },
    );

    test(
      'NEGATIVE: 401 activation_failed → activationRejected (one answer)',
      () async {
        reply(401, {'ok': false, 'error': 'activation_failed'});
        await expectLater(
          client.activate(
            cell: base,
            school: 'alborz-1',
            code: code32,
            deviceId: 'pd-test-1',
          ),
          throwsA(
            isA<SchoolAccessFailure>()
                .having(
                  (e) => e.kind,
                  'kind',
                  SchoolAccessError.activationRejected,
                )
                .having((e) => e.wire, 'wire', 'activation_failed'),
          ),
        );
      },
    );

    test(
      'NEGATIVE: 200 without a valid device secret is not accepted',
      () async {
        reply(200, session());
        await expectLater(
          client.activate(
            cell: base,
            school: 'alborz-1',
            code: code32,
            deviceId: 'pd-test-1',
          ),
          throwsA(isA<SchoolAccessFailure>()),
        );
        reply(200, {...session(secret: code32), 'token': ''});
        await expectLater(
          client.activate(
            cell: base,
            school: 'alborz-1',
            code: code32,
            deviceId: 'pd-test-1',
          ),
          throwsA(isA<SchoolAccessFailure>()),
        );
      },
    );
  });

  group('refresh (POST /api/gw/v1/session/refresh)', () {
    test('returns a fresh session', () async {
      reply(200, session());
      final s = await client.refresh(
        cell: base,
        school: 'alborz-1',
        deviceId: 'pd-test-1',
        deviceSecret: code32,
      );
      expect(s.token, 'tok.abc');
      expect(jsonDecode(bodies.single), {
        'school': 'alborz-1',
        'device_id': 'pd-test-1',
        'device_secret': code32,
      });
    });

    test('NEGATIVE: 401 refresh_failed → deviceRevoked', () async {
      reply(401, {'ok': false, 'error': 'refresh_failed'});
      await expectLater(
        client.refresh(
          cell: base,
          school: 'alborz-1',
          deviceId: 'pd-test-1',
          deviceSecret: code32,
        ),
        throwsA(
          isA<SchoolAccessFailure>().having(
            (e) => e.kind,
            'kind',
            SchoolAccessError.deviceRevoked,
          ),
        ),
      );
    });

    test(
      'NEGATIVE: connection refused → offline (nothing lost, no crash)',
      () async {
        final dead = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
        final port = dead.port;
        await dead.close();
        await expectLater(
          client.refresh(
            cell: Uri.parse('http://127.0.0.1:$port'),
            school: 'alborz-1',
            deviceId: 'pd-test-1',
            deviceSecret: code32,
          ),
          throwsA(
            isA<SchoolAccessFailure>().having(
              (e) => e.kind,
              'kind',
              SchoolAccessError.offline,
            ),
          ),
        );
      },
    );

    test(
      'NEGATIVE: server never answers → offline after the timeout',
      () async {
        handler = (_) {}; // hold the request
        final slow = SchoolAccessClient(
          directory: base,
          timeout: const Duration(milliseconds: 200),
        );
        addTearDown(slow.close);
        await expectLater(
          slow.resolve('alborz-1'),
          throwsA(
            isA<SchoolAccessFailure>().having(
              (e) => e.kind,
              'kind',
              SchoolAccessError.offline,
            ),
          ),
        );
      },
    );
  });

  group('TLS / pinning', () {
    test(
      'NEGATIVE: pinned client refuses plaintext before sending → tlsRejected',
      () async {
        reply(200, {'ok': true});
        final pinned = SchoolAccessClient(
          directory: base,
          client: createPinnedHttpClient(
            GatewayConfig(
              baseUri: Uri.parse('https://gw.example.ir'),
              pins: ['${'A' * 43}=', '${'B' * 43}='],
            ),
          ),
        );
        addTearDown(pinned.close);
        await expectLater(
          pinned.resolve('alborz-1'),
          throwsA(
            isA<SchoolAccessFailure>()
                .having((e) => e.kind, 'kind', SchoolAccessError.tlsRejected)
                .having((e) => e.messageFa, 'fa', contains('چیزی ارسال نشد')),
          ),
        );
        expect(seen, isEmpty, reason: 'nothing reached the server');
      },
    );
  });

  group('error mapping', () {
    test('every status class maps to one kind with a Persian message', () {
      final cases = <(int, Map<String, Object?>, String?, SchoolAccessError)>[
        (404, {'error': 'not_found'}, null, SchoolAccessError.schoolNotFound),
        (
          426,
          {'error': 'upgrade_required'},
          null,
          SchoolAccessError.upgradeRequired,
        ),
        (
          400,
          {'error': 'api_version_unsupported'},
          null,
          SchoolAccessError.upgradeRequired,
        ),
        (
          400,
          {'error': 'bad_school_code'},
          null,
          SchoolAccessError.badSchoolCode,
        ),
        (400, {'error': 'bad_device_id'}, null, SchoolAccessError.unknown),
        (
          429,
          {'error': 'rate_limited', 'retry_after_ms': 4200},
          '9',
          SchoolAccessError.rateLimited,
        ),
        (503, {'error': 'not_configured'}, null, SchoolAccessError.unavailable),
        (500, {'error': 'session_failed'}, null, SchoolAccessError.unavailable),
        (418, {}, null, SchoolAccessError.unknown),
      ];
      for (final (st, body, ra, kind) in cases) {
        final f = mapSchoolAccessError(st, body, ra);
        expect(f.kind, kind, reason: '$st $body');
        expect(f.messageFa, isNotEmpty);
        expect(f.toString(), contains(kind.name));
      }
      final rl = mapSchoolAccessError(429, {'retry_after_ms': 4200}, '9');
      expect(rl.retryAfter, const Duration(milliseconds: 4200));
      expect(rl.messageFa, contains('۵'));
      expect(
        mapSchoolAccessError(429, {}, '7').retryAfter,
        const Duration(seconds: 7),
      );
      expect(SchoolAccessError.rateLimited.messageFa(), contains('۶۰'));
      expect(
        mapSchoolAccessError(
          401,
          {},
          null,
          rejected: SchoolAccessError.deviceRevoked,
        ).kind,
        SchoolAccessError.deviceRevoked,
      );
      for (final k in SchoolAccessError.values) {
        expect(
          k.messageFa(),
          matches(RegExp('[\u0600-\u06FF]')),
          reason: k.name,
        );
      }
      expect(toPersianDigits('120'), '۱۲۰');
    });

    test('role names in Persian; unknown role shown verbatim', () {
      SchoolSession s(String role) => SchoolSession(
        school: 'a-b-c',
        tenantId: 't',
        token: 'x',
        expiresAt: DateTime.utc(2030),
        role: role,
        uid: 2,
      );
      expect(
        [
          'manager',
          'deputy',
          'teacher',
          'parent',
          'student',
          'x',
        ].map((r) => s(r).roleFa),
        ['مدیر', 'معاون', 'معلم', 'ولی', 'دانش‌آموز', 'x'],
      );
    });
  });

  group('SchoolAccountStore (secure store)', () {
    test(
      'device id created once and kept; save/load/clear round trip',
      () async {
        final fake = FakeSecureStore();
        final st = SchoolAccountStore(fake);
        final id = await st.deviceId(random: Random(1));
        expect(SchoolAccessRules.device.hasMatch(id), isTrue);
        expect(await st.deviceId(), id);
        expect(await st.load(), isNull);
        await st.save(
          SavedSchool(
            school: 'alborz-1',
            cellUrl: Uri.parse('https://cell-1.example.ir'),
            deviceSecret: code32,
            role: 'teacher',
          ),
        );
        final l = (await st.load())!;
        expect(
          [l.school, l.cellUrl.host, l.deviceSecret, l.role],
          ['alborz-1', 'cell-1.example.ir', code32, 'teacher'],
        );
        await st.clear();
        expect(await st.load(), isNull);
        expect(await st.deviceId(), id, reason: 'device id survives sign-out');
      },
    );

    test(
      'NEGATIVE: tampered saved values are ignored (never used to connect)',
      () async {
        final fake = FakeSecureStore();
        final st = SchoolAccountStore(fake);
        await fake.write(SchoolKeys.school, 'alborz-1');
        await fake.write(SchoolKeys.cellUrl, 'http://evil.example');
        await fake.write(SchoolKeys.deviceSecret, code32);
        expect(await st.load(), isNull);
        await fake.write(SchoolKeys.cellUrl, 'https://ok.example');
        await fake.write(SchoolKeys.school, 'BAD SCHOOL');
        expect(await st.load(), isNull);
        await fake.write(SecureKeys.deviceId, 'x');
        expect(SchoolAccessRules.device.hasMatch(await st.deviceId()), isTrue);
      },
    );

    test('the token is never written to the secure store', () async {
      reply(200, session(secret: code32));
      final fake = FakeSecureStore();
      final st = SchoolAccountStore(fake);
      final a = await client.activate(
        cell: base,
        school: 'alborz-1',
        code: code32,
        deviceId: 'pd-test-1',
      );
      await st.save(
        SavedSchool(
          school: 'alborz-1',
          cellUrl: base,
          deviceSecret: a.deviceSecret,
        ),
      );
      for (final k in [
        SchoolKeys.school,
        SchoolKeys.cellUrl,
        SchoolKeys.deviceSecret,
        SchoolKeys.role,
        SecureKeys.sessionToken,
      ]) {
        expect(await fake.read(k) == a.session.token, isFalse, reason: k);
      }
      expect(await fake.read(SecureKeys.sessionToken), isNull);
    });
  });
}
