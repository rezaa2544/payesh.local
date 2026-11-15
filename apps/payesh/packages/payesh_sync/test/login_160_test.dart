// Row 160 — two ways to sign in: the user name / password the manager set, and mobile + SMS code
// (plus «فراموشی رمز» by SMS). The SMS panel is not linked yet: everything answers `sms_disabled`.
import 'dart:convert';
import 'dart:io';

import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

void main() {
  group('rules', () {
    test(
      'L160-U01 login shapes: mobile 11, national id 10, user code 4–9, Latin',
      () {
        for (final ok in [
          '09121234567',
          '0012345678',
          '8001',
          '123456789',
          'ali.r',
        ]) {
          expect(LanServerRules.loginProblem(ok), isNull, reason: ok);
        }
        for (final bad in ['091', '1234567890123', '2ali']) {
          expect(LanServerRules.loginProblem(bad), isNotNull, reason: bad);
        }
        expect(LanServerRules.loginDigitsRuleFa, contains('۴ تا ۹'));
        expect(LanServerRules.mobileProblem('۰۹۱۲۱۲۳۴۵۶۷'), isNull);
        expect(LanServerRules.mobileProblem('0912'), isNotNull);
        expect(LanServerRules.mobileProblem(''), 'شمارهٔ همراه را بنویسید');
        expect(LanServerRules.mobileProblem('0012345678'), isNotNull);
      },
    );

    test(
      'L160-U02 manager user name: Latin or a 4–9 digit code; empty = mobile',
      () {
        for (final ok in ['', 'ali.rezaei', 'Teacher_7', '8001', '۱۲۳۴']) {
          expect(AccountRules.usernameProblem(ok), isNull, reason: ok);
        }
        for (final bad in [
          'ab',
          '123',
          '0012345678',
          '09121234567',
          '1abc',
          'علی',
        ]) {
          expect(
            AccountRules.usernameProblem(bad),
            AccountRules.usernameRuleFa,
            reason: bad,
          );
        }
        expect(AccountRules.normUsername(' Ali.R '), 'ali.r');
        expect(AccountRules.normUsername('۸۰۰۱'), '8001');
      },
    );

    test('L160-U03 server errors → Persian messages', () {
      LanAccessError kind(int s, String e) =>
          mapLanError(s, {'error': e}, null).kind;
      expect(kind(503, 'sms_disabled'), LanAccessError.smsDisabled);
      expect(kind(502, 'sms_send_failed'), LanAccessError.smsFailed);
      expect(kind(401, 'otp_invalid'), LanAccessError.otpInvalid);
      expect(kind(401, 'otp_expired'), LanAccessError.otpExpired);
      expect(kind(429, 'otp_locked'), LanAccessError.otpExpired);
      expect(kind(429, 'otp_cooldown'), LanAccessError.rateLimited);
      expect(
        LanAccessError.smsDisabled.messageFa(),
        contains('هنوز فعال نشده'),
      );
      expect(LanAccessError.otpInvalid.messageFa(), 'کد پیامکی درست نیست');
      final t = OtpTicket.fromJson({
        'ttl_s': 120,
        'resend_s': 60,
        'code_length': 12,
      });
      expect(t.length, 8);
      expect(t.ttl.inMinutes, 2);
      expect(OtpTicket.fromJson(const {}).length, 6);
    });
  });

  group('HTTP (scripted school server)', () {
    late HttpServer srv;
    late Uri base;
    final bodies = <String, Map<String, Object?>>{};
    var smsOn = false;

    setUp(() async {
      HttpOverrides.global = null;
      bodies.clear();
      smsOn = false;
      srv = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      base = Uri.parse('http://127.0.0.1:${srv.port}');
      srv.listen((r) async {
        final raw = await utf8.decodeStream(r);
        if (raw.isNotEmpty) {
          bodies[r.uri.path] = (jsonDecode(raw) as Map).cast<String, Object?>();
        }
        Object? out;
        var status = 200;
        switch (r.uri.path) {
          case '/api/health':
            out = {
              'ok': true,
              'name': 'payesh-local',
              'setup_done': true,
              'school': 'هنرستان',
              'instance': 'i1',
              'login': smsOn
                  ? {'primary': 'mobile', 'sms': true, 'code_length': 5}
                  : {
                      'primary': 'password',
                      'requested_primary': 'mobile',
                      'sms': false,
                      'code_length': 6,
                    },
            };
          case '/api/auth/otp/request':
            if (!smsOn) {
              status = 503;
              out = {'ok': false, 'error': 'sms_disabled'};
            } else {
              out = {
                'ok': true,
                'sent': true,
                'ttl_s': 120,
                'resend_s': 60,
                'code_length': 5,
              };
            }
          case '/api/auth/otp/verify':
            final j = bodies[r.uri.path]!;
            if (j['code'] == '12345') {
              out = {
                'ok': true,
                'user': {'id': 7, 'role': 'teacher', 'name': 'معلم'},
                'session': {
                  'token': 'acc-o',
                  'expires_at': '2030-01-01T00:00:00.000Z',
                },
                'device_token': 'dt-o',
                'auth': 'otp',
                'password_reset': j['purpose'] == 'reset',
              };
            } else {
              status = 401;
              out = {'ok': false, 'error': 'otp_invalid', 'tries_left': 4};
            }
          case '/api/admin/users/7':
            final j = bodies[r.uri.path]!;
            if (j['username'] == 'taken1') {
              status = 409;
              out = {'ok': false, 'error': 'duplicate_username'};
            } else {
              out = {
                'ok': true,
                'user': {'id': 7, 'username': j['username']},
              };
            }
          case '/api/admin/users/credentials':
            out = {
              'ok': true,
              'users': [
                {
                  'id': 7,
                  'name': 'معلم',
                  'role': 'teacher',
                  'phone': '09121234567',
                  'username': 'ali.r',
                },
                {
                  'id': 8,
                  'name': 'دبیر',
                  'role': 'teacher',
                  'phone': '09127654321',
                  'username': '',
                },
              ],
            };
          default:
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

    test('L160-U04 / L162 health.login: the owner chose «mobile» ⇒ mobile first (SMS off: the form says «به‌زودی»)', () async {
      final c = LanAccessClient();
      addTearDown(c.close);
      final off = await c.probe(base);
      expect(off.smsReady, isFalse);
      // row 162: the owner's choice (requested_primary) decides, not the SMS fallback
      expect(off.mobileFirst, isTrue);
      expect(off.loginPrimary, 'mobile');
      smsOn = true;
      final on = await c.probe(base);
      expect(on.smsReady, isTrue);
      expect(on.mobileFirst, isTrue);
      expect(on.otpLength, 5);
    });

    test('L160-U05 OTP request (disabled → smsDisabled) and verify (login / reset)', () async {
      final c = LanAccessClient();
      addTearDown(c.close);
      await expectLater(
        c.requestOtp(server: base, phone: '۰۹۱۲۱۲۳۴۵۶۷'),
        throwsA(
          isA<LanAccessFailure>().having(
            (f) => f.kind,
            'kind',
            LanAccessError.smsDisabled,
          ),
        ),
      );
      expect(bodies['/api/auth/otp/request'], {
        'phone': '09121234567',
        'purpose': 'login',
      });
      smsOn = true;
      final t = await c.requestOtp(
        server: base,
        phone: '09121234567',
        purpose: 'reset',
      );
      expect(t.length, 5);
      expect(bodies['/api/auth/otp/request']!['purpose'], 'reset');
      await expectLater(
        c.verifyOtp(
          server: base,
          phone: '09121234567',
          code: '11111',
          deviceName: 'd',
        ),
        throwsA(
          isA<LanAccessFailure>().having(
            (f) => f.kind,
            'kind',
            LanAccessError.otpInvalid,
          ),
        ),
      );
      expect(bodies['/api/auth/otp/verify']!.containsKey('password'), isFalse);
      final s = await c.verifyOtp(
        server: base,
        phone: '09121234567',
        code: '۱۲۳۴۵',
        deviceName: 'گوشی',
        purpose: 'reset',
        newPassword: 'tazeh-160',
      );
      expect(s.token, 'acc-o');
      expect(s.deviceToken, 'dt-o');
      expect(s.uid, 7);
      expect(
        bodies['/api/auth/otp/verify'],
        containsPair('password', 'tazeh-160'),
      );
      expect(bodies['/api/auth/otp/verify'], containsPair('code', '12345'));
      expect(bodies['/api/auth/otp/verify'], containsPair('purpose', 'reset'));
    });

    test('L160-U06 credentials show the manager user name; PATCH username (409 / bad shape)', () async {
      final client = LanAccessClient();
      addTearDown(client.close);
      final a = LanAccounts(
        client: client,
        server: base,
        token: () async => 'acc',
      );
      final list = await a.credentials();
      expect(list.first.username, 'ali.r');
      expect(list.first.custom, 'ali.r');
      expect(list.first.phone, '09121234567');
      expect(list.last.username, '09127654321');
      expect(list.last.custom, '');
      await a.setCredentials(7, username: ' Teacher.7 ');
      expect(bodies['/api/admin/users/7'], {'username': 'teacher.7'});
      await expectLater(
        a.setCredentials(7, username: 'taken1'),
        throwsA(
          isA<AccountFailure>().having(
            (f) => f.kind,
            'kind',
            AccountError.duplicateUsername,
          ),
        ),
      );
      bodies.clear();
      await expectLater(
        a.setCredentials(7, username: '12'),
        throwsA(
          isA<AccountFailure>().having(
            (f) => f.kind,
            'kind',
            AccountError.badUsername,
          ),
        ),
      );
      expect(bodies, isEmpty, reason: 'a bad shape is never sent');
      expect(
        const AccountFailure(AccountError.duplicateUsername).messageFa,
        contains('قبلاً'),
      );
    });
  });
}
