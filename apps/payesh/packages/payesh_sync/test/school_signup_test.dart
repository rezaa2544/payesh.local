// Row 145 — registration request + subscription client (school server; never the bucket key).
import 'dart:convert';
import 'dart:io';

import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

SchoolSignup form({
  String school = 'هنرستان باهنر',
  String level = 'متوسطه دوم',
  String province = 'خراسان رضوی',
  String county = 'نیشابور',
  String village = 'خرو',
  String phone = '۰۹۱۵ ۱۲۳ ۴۵۶۷',
  String staff = '۲۵',
  String students = '320',
  String manager = 'محمد کریمی',
  String username = ' M.Karimi ',
  String password = 'Karimi-1403',
}) => SchoolSignup(
  schoolName: school,
  level: level,
  province: province,
  county: county,
  village: village,
  phone: phone,
  staffCount: staff,
  studentCount: students,
  managerName: manager,
  username: username,
  password: password,
);

void main() {
  group('rules (same as server/school-registry.js validRequest)', () {
    test('S145-U01 a valid request; normalised JSON with the device hash', () {
      final f = form();
      expect(f.validate(), isNull);
      final dh = deviceHashOf('android-id-1')!;
      expect(dh, matches(RegExp(r'^[0-9a-f]{64}$')));
      expect(deviceHashOf('android-id-1'), dh, reason: 'stable');
      expect(deviceHashOf(' '), isNull);
      expect(deviceHashOf(null), isNull);
      expect(f.toJson(deviceHash: dh), {
        'school_name': 'هنرستان باهنر',
        'level': 'متوسطه دوم',
        'province': 'خراسان رضوی',
        'county': 'نیشابور',
        'village': 'خرو',
        'phone': '09151234567',
        'staff_count': 25,
        'student_count': 320,
        'manager_name': 'محمد کریمی',
        'username': 'm.karimi',
        'password': 'Karimi-1403',
        'device_hash': dh,
      });
      expect(f.toJson().containsKey('device_hash'), isFalse);
      expect(form(village: '').validate(), isNull, reason: 'village optional');
    });

    test('S145-U02 NEG each field', () {
      expect(form(school: 'x').validate(), 'نام مدرسه را بنویسید');
      expect(form(level: 'دانشگاه').validate(), 'مقطع را انتخاب کنید');
      expect(form(province: '').validate(), 'استان را انتخاب کنید');
      expect(form(county: '').validate(), 'شهرستان را بنویسید');
      expect(form(village: 'x' * 61).validate(), contains('طولانی'));
      expect(form(phone: '0915123456').validate(), contains('۱۱ رقمی'));
      expect(form(phone: '19151234567').validate(), contains('۱۱ رقمی'));
      expect(form(staff: '').validate(), contains('کارکنان'));
      expect(form(staff: '10001').validate(), contains('کارکنان'));
      expect(form(students: '-1').validate(), contains('دانش‌آموزان'));
      expect(form(students: '100001').validate(), contains('دانش‌آموزان'));
      expect(form(manager: 'ab').validate(), contains('مدیر'));
      expect(form(username: '9bad').validate(), contains('نام کاربری'));
      expect(form(username: 'ab').validate(), contains('نام کاربری'));
      expect(form(password: '12345').validate(), contains('۶'));
      expect(signupProvinces.length, 31);
      expect(signupLevels, ['ابتدایی', 'متوسطه اول', 'متوسطه دوم']);
    });

    test('S145-U03 user-name login + new server errors', () {
      expect(LanServerRules.normalizeLogin(' Ali.Rezaei '), 'ali.rezaei');
      expect(LanServerRules.normalizeLogin('۰۹۱۲ ۱۲۳ ۴۵۶۷'), '09121234567');
      expect(LanServerRules.validLogin('Ali.Rezaei'), isTrue);
      expect(LanServerRules.validLogin('a1'), isFalse);
      expect(LanServerRules.validLogin('09121234567'), isTrue);
      expect(LanServerRules.validLogin('0912'), isFalse);
      LanAccessError k(int st, String e) =>
          mapLanError(st, {'error': e}, null).kind;
      expect(k(403, 'school_inactive'), LanAccessError.schoolInactive);
      expect(k(403, 'school_removed'), LanAccessError.schoolRemoved);
      expect(k(409, 'school_hosted_elsewhere'), LanAccessError.hostedElsewhere);
      expect(
        k(402, 'subscription_required'),
        LanAccessError.subscriptionRequired,
      );
      expect(k(402, 'x'), LanAccessError.subscriptionRequired);
      expect(k(503, 'registry_unreachable'), LanAccessError.unreachable);
      for (final e in LanAccessError.values) {
        expect(e.messageFa(), isNotEmpty);
      }
      for (final w in [
        'username_taken',
        'not_connected',
        'registry_unreachable',
        'bad_school_name',
        'bad_level',
        'bad_province',
        'bad_county',
        'bad_village',
        'bad_phone',
        'bad_staff_count',
        'bad_student_count',
        'bad_manager_name',
        'bad_username',
        'bad_password',
        'not_found',
        'bad_device',
        'already_active',
        'trial_used_device',
        'trial_unavailable',
        'trial_check_unavailable',
        'gateway_not_configured',
        'no_callback_address',
        'bad_plan',
        'bad_ref',
        'receipt_disabled',
        'not_required',
      ]) {
        final m = schoolsErrorFa(
          LanAccessFailure(LanAccessError.unknown, wire: w),
        );
        expect(m, isNot(LanAccessError.unknown.messageFa()), reason: w);
      }
      expect(
        schoolsErrorFa(const LanAccessFailure(LanAccessError.unreachable)),
        LanAccessError.unreachable.messageFa(),
      );
    });

    test('S145-U04 subscription status (gate) parsing', () {
      final s = SubStatus.fromJson({
        'ok': true,
        'managed': true,
        'access': false,
        'status': 'expired',
        'role': 'parent',
        'policy': 'required',
        'school': 'دبستان',
        'plans': [
          {'key': 'monthly', 'price': 250000},
          {'key': 'yearly', 'price': 2200000},
          {'key': 'bad'},
        ],
        'trial_days': 21,
        'trial_available': false,
        'gateway': true,
        'receipt': true,
        'receipt_note': 'کارت',
        'plan': 'monthly',
        'end': '2026-10-01T00:00:00.000Z',
        'days_left': 0,
        'pending': [
          {
            'id': 'SUB-0A1B2C3D',
            'plan': 'monthly',
            'amount': 250000,
            'method': 'receipt',
            'status': 'pending',
            'ref': 'TRX-1',
          },
          'junk',
        ],
      });
      expect(s.managed && !s.access, isTrue);
      expect(s.plans.map((p) => '${p.key}:${p.titleFa}:${p.months}'), [
        'monthly:ماهانه:1',
        'yearly:سالانه:12',
      ]);
      expect(s.pending.single.ref, 'TRX-1');
      expect(s.end, DateTime.utc(2026, 10));
      expect(s.blockedSchool, isFalse);
      // 402 body: {error, sub:{…}}
      final b = SubStatus.fromJson({
        'ok': false,
        'error': 'school_inactive',
        'sub': {'managed': true, 'access': false, 'status': 'school_inactive'},
      });
      expect(b.blockedSchool, isTrue);
      final free = SubStatus.fromJson({
        'managed': false,
        'access': true,
        'status': 'free',
      });
      expect(free.access, isTrue);
      expect(const SubPlanOffer('seasonal', 1).titleFa, 'فصلی');
      expect(const SignupStatus('approved').approved, isTrue);
      for (final st in ['pending', 'approved', 'rejected', 'inactive']) {
        expect(SignupStatus(st).titleFa, isNotEmpty);
      }
    });

    test('S145-U05 ticket store survives a restart; NEG junk', () async {
      final store = FakeSecureStore();
      final s = SignupStore(store);
      expect(await s.load(), isNull);
      final t = SignupTicket(
        server: Uri.parse('http://192.168.1.10:8080'),
        id: '1794579912714-0123456789abcdef',
        token: 'tok',
        schoolName: 'هنرستان',
        username: 'm.karimi',
        at: DateTime.utc(2026, 11, 12),
      );
      await s.save(t);
      final back = (await SignupStore(store).load())!;
      expect(back.toJson(), t.toJson());
      await store.write(SignupStore.key, '{bad');
      expect(await s.load(), isNull);
      await store.write(
        SignupStore.key,
        jsonEncode({...t.toJson(), 'server': 'https://evil.example'}),
      );
      expect(await s.load(), isNull, reason: 'public address refused');
      await s.clear();
      expect(await s.load(), isNull);
    });
  });

  group('LanSchoolsClient (real HTTP, loopback server)', () {
    late HttpServer srv;
    late Uri base;
    late LanSchoolsClient c;
    final seen = <String>[];
    final bodies = <Object?>[];

    setUp(() async {
      seen.clear();
      bodies.clear();
      srv = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      base = Uri.parse('http://127.0.0.1:${srv.port}');
      c = LanSchoolsClient(
        LanAccessClient(timeout: const Duration(seconds: 5)),
      );
      srv.listen((req) async {
        final text = await utf8.decodeStream(req);
        seen.add(
          '${req.method} ${req.uri.path}${req.uri.hasQuery ? '?${req.uri.query}' : ''} ${req.headers.value('authorization') ?? '-'}',
        );
        bodies.add(text.isEmpty ? null : jsonDecode(text));
        Object? out;
        var st = 200;
        switch (req.uri.path) {
          case '/api/schools/register':
            final b = bodies.last! as Map;
            if (b['username'] == 'taken.user') {
              st = 409;
              out = {'ok': false, 'error': 'username_taken'};
            } else {
              out = {
                'ok': true,
                'id': '1794579912714-0123456789abcdef',
                'token': 'tok-1',
                'status': 'pending',
              };
            }
          case '/api/schools/register/status':
            out = {
              'ok': true,
              'status': 'approved',
              'school': 'هنرستان باهنر',
              'username': 'm.karimi',
            };
          case '/api/sub/status':
            st = 200;
            out = {
              'ok': true,
              'managed': true,
              'access': false,
              'status': 'none',
              'trial_available': true,
              'trial_days': 14,
            };
          case '/api/sub/trial':
            out = {
              'ok': true,
              'sub': {
                'managed': true,
                'access': true,
                'status': 'trial',
                'days_left': 14,
              },
            };
          case '/api/sub/pay':
            out = {
              'ok': true,
              'pay_url': 'https://pay.example/x?id=SUB-0A1B2C3D',
              'payment': {
                'id': 'SUB-0A1B2C3D',
                'plan': 'monthly',
                'amount': 250000,
                'method': 'gateway',
                'status': 'pending',
              },
            };
          case '/api/sub/receipt':
            out = {
              'ok': true,
              'payment': {
                'id': 'SUB-0A1B2C3E',
                'plan': 'monthly',
                'amount': 250000,
                'method': 'receipt',
                'status': 'pending',
                'ref': 'TRX-1',
              },
            };
          default:
            st = 404;
            out = {'ok': false, 'error': 'not_found'};
        }
        req.response
          ..statusCode = st
          ..headers.contentType = ContentType.json
          ..write(jsonEncode(out));
        await req.response.close();
      });
    });

    tearDown(() async {
      c.client.close();
      await srv.close(force: true);
    });

    test('S145-I01 register → status; NEG user name taken', () async {
      final r = await c.register(
        base,
        form(),
        deviceHash: deviceHashOf('pc-1'),
      );
      expect(r.id, '1794579912714-0123456789abcdef');
      expect((bodies.last! as Map)['username'], 'm.karimi');
      expect((bodies.last! as Map)['device_hash'], deviceHashOf('pc-1'));
      final st = await c.registrationStatus(
        SignupTicket(
          server: base,
          id: r.id,
          token: r.token,
          schoolName: '',
          username: '',
          at: DateTime.utc(2026),
        ),
      );
      expect(st.approved, isTrue);
      expect(st.username, 'm.karimi');
      expect(
        seen.last,
        startsWith(
          'GET /api/schools/register/status?id=1794579912714-0123456789abcdef&token=tok-1',
        ),
      );
      await expectLater(
        c.register(base, form(username: 'taken.user')),
        throwsA(
          isA<LanAccessFailure>().having(
            (e) => e.wire,
            'wire',
            'username_taken',
          ),
        ),
      );
    });

    test(
      'S145-I02 status, trial, gateway link, receipt — with the session token',
      () async {
        final s = await c.subStatus(base, 'acc-1');
        expect(s.trialAvailable, isTrue);
        expect(seen.last, 'GET /api/sub/status Bearer acc-1');
        final t = await c.startTrial(base, 'acc-1', deviceHashOf('pc-1')!);
        expect(t.status, 'trial');
        expect(bodies.last, {'device_hash': deviceHashOf('pc-1')});
        final p = await c.startPayment(base, 'acc-1', 'monthly');
        expect(p.paymentId, 'SUB-0A1B2C3D');
        expect(p.payUrl, startsWith('https://pay.example/'));
        final rc = await c.submitReceipt(base, 'acc-1', 'monthly', ' TRX-1 ');
        expect(rc.ref, 'TRX-1');
        expect(bodies.last, {'plan': 'monthly', 'ref': 'TRX-1'});
      },
    );

    test('S145-I03 NEG public address is never contacted', () async {
      await expectLater(
        c.subStatus(Uri.parse('https://example.com'), 't'),
        throwsA(
          isA<LanAccessFailure>().having(
            (e) => e.kind,
            'kind',
            LanAccessError.badAddress,
          ),
        ),
      );
      expect(seen, isEmpty);
    });
  });
}
