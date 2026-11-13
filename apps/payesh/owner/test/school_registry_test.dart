import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_owner/src/net/resilience.dart';
import 'package:payesh_owner/src/schools/school_registry.dart';
import 'package:payesh_secure/payesh_secure.dart';

import 'support/fake_bucket.dart';

/// مدارس، درخواست ثبت‌نام و اشتراک (ردیف ۱۴۵): قرارداد مشترک با server/school-registry.js.
void main() {
  final vectors = jsonDecode(
    File('../../../docs/cloud/contracts/schools-vectors.json')
        .readAsStringSync(),
  ) as Map<String, Object?>;

  List<int> hex(String h) => [
    for (var i = 0; i < h.length; i += 2)
      int.parse(h.substring(i, i + 2), radix: 16),
  ];

  group('قرارداد schools v1 (همان بایت‌های Node)', () {
    final cases = vectors['cases']! as Map<String, Object?>;
    final kinds = vectors['kinds']! as Map<String, Object?>;
    for (final name in cases.keys) {
      test('پاکت $name', () async {
        final c = cases[name]! as Map<String, Object?>;
        final plain =
            jsonDecode(c['plaintext']! as String) as Map<String, Object?>;
        final sealed = await sealSchools(
          vectors['secret']! as String,
          kinds[name]! as String,
          vectors['rev']! as int,
          plain,
          nonce: hex(vectors['nonce_hex']! as String),
        );
        // همان رشتهٔ متن ساده (ترتیب کلیدها) ⇒ همان بایت‌ها
        expect(jsonEncode(plain), c['plaintext']);
        expect(jsonDecode(sealed), c['envelope']);
        final back = await openSchools(
          vectors['secret']! as String,
          kinds[name]! as String,
          jsonEncode(c['envelope']),
        );
        expect(back!.plain, plain);
        expect(back.rev, vectors['rev']);
        expect(
          await openSchools('other', kinds[name]! as String, sealed),
          isNull,
        );
        expect(
          await openSchools(vectors['secret']! as String, 'x', sealed),
          isNull,
        );
      });
    }

    test('ثابت‌ها: نمک، پوشه‌ها، پلن‌ها، نقش‌ها، مقطع‌ها، نام کاربری', () {
      expect(vectors['salt'], schoolsSalt);
      expect(vectors['kinds'], {
        'registry': SchoolKinds.registry,
        'request': SchoolKinds.request,
        'payment': SchoolKinds.payment,
        'ack': SchoolKinds.ack,
        'trial': SchoolKinds.trial,
      });
      expect(vectors['dirs'], {
        'registry': SchoolDirs.registry,
        'req': SchoolDirs.req,
        'pay': SchoolDirs.pay,
        'ack': SchoolDirs.ack,
        'trial': SchoolDirs.trial,
      });
      expect(vectors['plans'], [
        for (final p in subPlans)
          {
            'key': p.key,
            'title': p.title,
            'months': p.months,
            'price': p.price,
          },
      ]);
      expect(vectors['roles'], subRoles);
      expect(vectors['levels'], schoolLevels);
      expect(vectors['username_re'], usernameRe.pattern);
      final d = vectors['defaults']! as Map<String, Object?>;
      expect(d['trial_days'], defaultTrialDays);
      expect(d['roles'], defaultRolePolicy);
    });

    test('pbkdf2 همان سرور (۱۵۰۰۰۰ دور، نمک = رشتهٔ hex)', () async {
      final p = vectors['pbkdf2']! as Map<String, Object?>;
      expect(
        await pbkdf2Verify(p['password']! as String, p['hash']! as String),
        isTrue,
      );
      expect(
        await pbkdf2Verify('${p['password']}!', p['hash']! as String),
        isFalse,
      );
      final h = await pbkdf2Hash('abc123', iterations: 1000);
      expect(h, matches(RegExp(r'^pbkdf2\$1000\$[0-9a-f]{32}\$[0-9a-f]{64}$')));
      expect(await pbkdf2Verify('abc123', h), isTrue);
    });

    test('کد ملی و ارقام فارسی', () {
      expect(digitsOnly('۰۹۱۲-۱۲۳ ۴۵۶۷'), '09121234567');
      expect(validNationalId('0499370899'), isTrue);
      expect(validNationalId('0499370898'), isFalse);
      expect(validNationalId('1111111111'), isFalse);
      expect(validGatewayUrl(''), isTrue);
      expect(validGatewayUrl('https://pay.example/x?a={amount}'), isTrue);
      expect(validGatewayUrl('javascript:alert(1)'), isFalse);
      expect(capsForType('vocational')['has_workshop'], 1);
      expect(capsForType('governmental')['has_tuition'], 0);
      expect(capsForType('governmental')['has_second_term_exam'], 1);
      expect(iranProvinces.length, 31);
    });
  });

  group('فهرست مدارس در صندوقچه', () {
    setUpAll(() => s3RetryPolicy = RetryPolicy.none);
    tearDownAll(() => s3RetryPolicy = const RetryPolicy());
    late DateTime clock;
    late FakeBucket bucket;
    late FakeSecureStore secure;
    late SchoolRegistry reg;
    const sk = 'sk-test';

    Map<String, Object?> school({
      String name = 'دبستان شهید رجایی',
      String code = '1001',
      String user = 'ali.rezaei',
      String level = 'ابتدایی',
    }) => {
      'name': name,
      'code': code,
      'province': 'تهران',
      'county': 'ری',
      'district': 'کهریزک',
      'area_kind': 'village',
      'level': level,
      'school_type': 'rural',
      'capabilities': capsForType('rural'),
      'work_days': [0, 1, 2, 3, 4],
      'manager': {
        'name': 'علی رضایی',
        'username': user,
        'national_id': '',
        'phone': '09121234567',
      },
    };

    setUp(() async {
      EndpointRoutes.reset();
      clock = DateTime.utc(2026, 11, 13, 10);
      bucket = FakeBucket(() => clock);
      secure = FakeSecureStore();
      await S3Settings(
        endpoint: Uri.https('s3.example.test'),
        accessKey: 'ak',
        secretKey: sk,
        bucket: 'payesh-madrese',
      ).save(secure);
      reg = SchoolRegistry(
        secure: secure,
        s3Factory: bucket.transport,
        now: () => clock,
        hashIterations: 1000,
      );
    });

    Future<Map<String, Object?>> registryInBucket() async {
      final r = await openSchools(
        sk,
        SchoolKinds.registry,
        bucket.text('payesh/${SchoolDirs.registry}')!,
      );
      return r!.plain;
    }

    test('نوع ۱: ساخت دستی + اعتبارسنجی p2 + رمز مدیر هش‌شده', () async {
      final id = await reg.createSchool(school(), password: 'Madrese-1403');
      expect(schoolIdRe.hasMatch(id), isTrue);
      final plain = await registryInBucket();
      final s = (plain['schools']! as List).single as Map<String, Object?>;
      expect(s['name'], 'دبستان شهید رجایی');
      expect(s['active'], isTrue);
      expect(s['district'], 'کهریزک');
      final m = s['manager']! as Map<String, Object?>;
      expect(m['username'], 'ali.rezaei');
      expect(m['rev'], 1);
      expect(
        await pbkdf2Verify('Madrese-1403', m['password_hash']! as String),
        isTrue,
      );
      expect(
        bucket.text('payesh/${SchoolDirs.registry}'),
        isNot(contains('ali.rezaei')),
      );

      Future<String> err(
        Map<String, Object?> f, [
        String pw = 'pass-123456',
      ]) async {
        try {
          await reg.createSchool(f, password: pw);
          return 'ok';
        } on SchoolsFailure catch (e) {
          return e.messageFa;
        }
      }

      expect(
        await err(school(code: '1001', user: 'b.user')),
        'کد مدرسه تکراری است',
      );
      expect(await err(school(code: '1002')), 'نام کاربری مدیر تکراری است');
      expect(
        await err(school(code: '1002', user: '9bad')),
        contains('نام کاربری مدیر باید'),
      );
      expect(
        await err(school(code: '1002', user: 'b.user'), '123'),
        contains('دست‌کم ۶'),
      );
      expect(
        await err(school(code: '1002', user: 'b.user', level: 'متوسطه دوم')),
        contains('دست‌کم یک شاخه'),
      );
      expect(
        await err({...school(code: '1002', user: 'b.user'), 'province': ''}),
        'استان را انتخاب کنید',
      );
      expect(
        await err(
          school(code: '1003', user: 'c.user', level: 'متوسطه دوم')
            ..['branches'] = ['فنی و حرفه‌ای']
            ..['fields'] = ['کامپیوتر', 'ریاضی فیزیک'],
        ),
        'ok',
      );
      final p2 = await registryInBucket();
      final hs = (p2['schools']! as List).last as Map<String, Object?>;
      expect(hs['branches'], ['فنی و حرفه‌ای']);
      expect(hs['fields'], [
        'کامپیوتر',
      ], reason: 'رشتهٔ شاخهٔ انتخاب‌نشده حذف می‌شود');
    });

    test('ویرایش، تغییر رمز (rev مدیر)، فعال/غیرفعال، حذف', () async {
      final id = await reg.createSchool(school(), password: 'Madrese-1403');
      await reg.updateSchool(id, {...school(name: 'دبستان نو')});
      var m =
          (((await registryInBucket())['schools']! as List).single
                  as Map)['manager']
              as Map;
      expect(m['rev'], 1, reason: 'بدون تغییر رمز/نام کاربری، rev ثابت');
      await reg.resetManagerPassword(id, 'Taze-5678');
      final s = ((await registryInBucket())['schools']! as List).single as Map;
      m = s['manager'] as Map;
      expect(s['name'], 'دبستان نو');
      expect(m['rev'], 2);
      expect(
        await pbkdf2Verify('Taze-5678', m['password_hash']! as String),
        isTrue,
      );
      await reg.setActive(id, false);
      expect(
        (((await registryInBucket())['schools']! as List).single
            as Map)['active'],
        isFalse,
      );
      await reg.removeSchool(id);
      expect((await registryInBucket())['schools'], isEmpty);
      expect(() => reg.removeSchool(id), throwsA(isA<SchoolsFailure>()));
    });

    test(
      'نوع ۲: درخواست سرور ← فهرست مالک ← تأیید با همان هش، یا رد',
      () async {
        final hash = await pbkdf2Hash('Karimi-1403', iterations: 1000);
        const rid = '1794579912714-0123456789abcdef';
        const rid2 = '1794579912999-fedcba9876543210';
        for (final (id, user) in [(rid, 'm.karimi'), (rid2, 'other.mgr')]) {
          bucket.putText(
            'payesh/${SchoolDirs.req}$id.json',
            await sealSchools(sk, SchoolKinds.request, 1, {
              'v': 1,
              'id': id,
              'school_name': 'هنرستان باهنر',
              'level': 'متوسطه دوم',
              'province': 'خراسان رضوی',
              'county': 'نیشابور',
              'village': 'خرو',
              'phone': '09151234567',
              'staff_count': 25,
              'student_count': 320,
              'manager_name': 'محمد کریمی',
              'username': user,
              'password_hash': hash,
            }),
          );
        }
        // پاکت با کلید دیگر نادیده گرفته می‌شود
        bucket.putText(
          'payesh/${SchoolDirs.req}1794579912000-aaaaaaaaaaaaaaaa.json',
          await sealSchools('other', SchoolKinds.request, 1, {
            'v': 1,
            'id': 'x',
          }),
        );
        var v = await reg.load();
        expect(v.connected, isTrue);
        expect(v.requests.map((r) => r['id']), [rid2, rid]);
        final r = v.requests.last;
        final id = await reg.approveRequest(r, {
          'name': r['school_name'],
          'code': '2001',
          'province': r['province'],
          'county': r['county'],
          'district': r['village'],
          'area_kind': 'village',
          'level': r['level'],
          'branches': ['فنی و حرفه‌ای'],
          'staff_count': r['staff_count'],
          'student_count': r['student_count'],
          'manager': {
            'name': r['manager_name'],
            'username': 'ignored',
            'phone': r['phone'],
          },
        });
        final s =
            ((await registryInBucket())['schools']! as List).single as Map;
        expect(s['id'], id);
        expect(s['request_id'], rid);
        expect(
          (s['manager'] as Map)['username'],
          'm.karimi',
          reason: 'نام کاربری خود متقاضی',
        );
        expect((s['manager'] as Map)['password_hash'], hash);
        expect(s['student_count'], 320);
        await reg.rejectRequest(rid2, 'اطلاعات ناقص');
        v = await reg.load();
        expect(v.requests, isEmpty);
        expect((await registryInBucket())['rejected'], [
          {'id': rid2, 'reason': 'اطلاعات ناقص', 'at': clock.toIso8601String()},
        ]);
        expect(() => reg.approveRequest(r, {}), throwsA(isA<SchoolsFailure>()));
      },
    );

    test(
      'سیاست اشتراک، دامنه، هدیه/بازنشانی، تصمیم پرداخت، گزارش سرور',
      () async {
        final id = await reg.createSchool(school(), password: 'Madrese-1403');
        var v = await reg.load();
        final st = v.settings;
        expect(st.trialDays, 21);
        expect(st.gatewayConfigured, isFalse);
        expect(st.roles['manager'], 'required');
        expect(st.prices['yearly'], 2200000);
        st
          ..trialDays = 14
          ..roles['teacher'] = 'required'
          ..prices.remove('seasonal')
          ..prices['monthly'] = 300000
          ..payUrl = 'https://pay.example/start?amount={amount}&cb={callback}';
        await reg.saveSettings(st, domain: 'payesh.example.ir');
        final p = await registryInBucket();
        final s = p['settings']! as Map<String, Object?>;
        expect(s['trial_days'], 14);
        expect((s['roles']! as Map)['teacher'], 'required');
        expect(s['plans'], [
          {'key': 'monthly', 'price': 300000},
          {'key': 'yearly', 'price': 2200000},
        ]);
        expect(p['domain'], 'payesh.example.ir');
        v = await reg.load();
        expect(v.settings.gatewayConfigured, isTrue);
        expect(v.settings.prices.containsKey('seasonal'), isFalse);
        expect(
          () => reg.saveSettings(st..payUrl = 'ftp://x', domain: ''),
          throwsA(isA<SchoolsFailure>()),
        );

        await reg.grant(id, 'gift', days: 10, userId: 3);
        await reg.grant(id, 'reset', role: 'parent');
        expect(
          () => reg.grant(id, 'gift', days: 0),
          throwsA(isA<SchoolsFailure>()),
        );
        final grants = (await registryInBucket())['grants']! as List;
        expect(grants.length, 2);
        expect((grants.first as Map)['days'], 10);
        expect((grants.last as Map)['role'], 'parent');

        bucket.putText(
          'payesh/${SchoolDirs.pay}SUB-0A1B2C3D.json',
          await sealSchools(sk, SchoolKinds.payment, 1, {
            'v': 1,
            'id': 'SUB-0A1B2C3D',
            'school_id': id,
            'uid': 1,
            'name': 'علی رضایی',
            'role': 'manager',
            'plan': 'monthly',
            'amount': 300000,
            'method': 'receipt',
            'ref': 'TRX-1234',
            'status': 'pending',
            'created_at': '2026-11-13T09:00:00.000Z',
          }),
        );
        bucket.putText(
          'payesh/${SchoolDirs.ack}$id.json',
          await sealSchools(sk, SchoolKinds.ack, 1, {
            'v': 1,
            'school_id': id,
            'instance': 'inst-1',
            'at': '2026-11-13T09:59:00.000Z',
            'users': {
              'total': 4,
              'by_role': {'manager': 1, 'teacher': 3},
            },
            'subs': [],
          }),
        );
        v = await reg.load();
        expect(v.payments.single['ref'], 'TRX-1234');
        expect(v.payments.single['decision'], isNull);
        expect(v.acks[id]!['instance'], 'inst-1');
        await reg.decide('SUB-0A1B2C3D', true);
        v = await reg.load();
        expect((v.payments.single['decision']! as Map)['status'], 'approved');
        await reg.decide('SUB-0A1B2C3D', false, reason: 'مبلغ نادرست');
        expect(
          (((await registryInBucket())['decisions']! as Map)['SUB-0A1B2C3D']
              as Map)['reason'],
          'مبلغ نادرست',
        );
        expect(() => reg.decide('bad', true), throwsA(isA<SchoolsFailure>()));
      },
    );

    test(
      'بدون دیتابیس: خواندن از نسخهٔ همین دستگاه، تغییر ممنوع با پیام روشن',
      () async {
        await reg.createSchool(school(), password: 'Madrese-1403');
        final other = FakeSecureStore();
        await other.write(
          SchoolRegistry.cacheKey,
          (await secure.read(SchoolRegistry.cacheKey))!,
        );
        final off = SchoolRegistry(
          secure: other,
          s3Factory: bucket.transport,
          now: () => clock,
          hashIterations: 1000,
        );
        final v = await off.load();
        expect(v.connected, isFalse);
        expect(v.schools.single['code'], '1001');
        expect(v.error, contains('تنظیمات'));
        await expectLater(
          off.createSchool(
            school(code: '9', user: 'zz.user'),
            password: 'pass-123456',
          ),
          throwsA(
            isA<SchoolsFailure>().having(
              (e) => e.code,
              'code',
              'not_connected',
            ),
          ),
        );
        // نسخهٔ تازه‌ترِ صندوقچه برنده است؛ نسخهٔ کهنهٔ دستگاه آن را بازنویسی نمی‌کند
        bucket.down = true;
        final down = await reg.load();
        expect(down.connected, isFalse);
        expect(down.schools.length, 1);
      },
    );
  });
}
