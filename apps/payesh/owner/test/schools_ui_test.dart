import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_owner/src/net/resilience.dart';
import 'package:payesh_owner/src/schools/payments_section.dart';
import 'package:payesh_owner/src/schools/school_registry.dart';
import 'package:payesh_owner/src/schools/schools_section.dart';
import 'package:payesh_owner/src/schools/subscription_section.dart';
import 'package:payesh_secure/payesh_secure.dart';

import 'support/fake_bucket.dart';

/// بخش‌های «مدارس» و «اشتراک» پنل مالک (ردیف ۱۴۵، برگردان p2).
void main() {
  const sk = 'SK-UI-TEST';
  late FakeBucket bucket;
  late FakeSecureStore secure;
  late SchoolRegistry reg;
  late List<(bool, String)> flashes;
  var clock = DateTime.utc(2026, 11, 13, 10);

  setUpAll(() => s3RetryPolicy = RetryPolicy.none);
  tearDownAll(() => s3RetryPolicy = const RetryPolicy());

  setUp(() async {
    EndpointRoutes.reset();
    clock = DateTime.utc(2026, 11, 13, 10);
    bucket = FakeBucket(() => clock);
    secure = FakeSecureStore();
    flashes = [];
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

  Future<Map<String, Object?>> inBucket() async => (await openSchools(
    sk,
    SchoolKinds.registry,
    bucket.text('payesh/${SchoolDirs.registry}')!,
  ))!.plain;

  /// کار واقعی (هش، رمزنگاری) بیرون از ساعت جعلی آزمون.
  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 6; i++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 30)),
      );
      await tester.pump(const Duration(milliseconds: 50));
    }
    await tester.pumpAndSettle();
  }

  Future<void> tap(WidgetTester tester, String key) async {
    final f = find.byKey(Key(key));
    await tester.ensureVisible(f);
    await tester.pumpAndSettle();
    await tester.tap(f);
    await settle(tester);
  }

  Future<void> type(WidgetTester tester, String key, String v) async {
    final f = find.byKey(Key(key));
    await tester.ensureVisible(f);
    await tester.enterText(f, v);
    await tester.pump();
  }

  Future<void> pick(WidgetTester tester, String key, String option) async {
    await tap(tester, key);
    await tester.tap(find.text(option).last);
    await tester.pumpAndSettle();
  }

  Future<void> pumpSection(WidgetTester tester, Widget child) async {
    tester.view.physicalSize = const Size(1600, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: Directionality(
          textDirection: TextDirection.rtl,
          child: Scaffold(body: ListView(children: [child])),
        ),
      ),
    );
    await settle(tester);
  }

  void flash(bool ok, String text) => flashes.add((ok, text));

  testWidgets(
    'نوع ۱: ساخت دستی با فرم p2؛ خطاها؛ ویرایش، رمز، تعلیق، هدیه، حذف',
    (tester) async {
      await pumpSection(
        tester,
        SchoolsRegistrySection(registry: reg, flash: flash),
      );
      expect(find.byKey(const Key('schools-registry')), findsOneWidget);
      await tap(tester, 'p2-create-school');
      expect(find.byKey(const Key('school-form')), findsOneWidget);
      for (final k in const [
        'sf-level',
        'sf-gender',
        'sf-capacity',
        'sf-shift',
        'sf-landline',
        'sf-day-0',
        'sf-cap-has_tuition',
        'sf-excuse',
      ]) {
        expect(find.byKey(Key(k)), findsNothing, reason: k);
      }
      expect(find.byKey(const Key('sf-profile-note')), findsOneWidget);
      // اعتبارسنجی p2: نام و کد اجباری
      await tap(tester, 'sf-submit');
      expect(find.byKey(const Key('sf-error')), findsOneWidget);
      await type(tester, 'sf-name', 'دبستان شهید رجایی');
      await type(tester, 'sf-code', '1001');
      await pick(tester, 'sf-province', 'تهران');
      await type(tester, 'sf-county', 'ری');
      await type(tester, 'sf-district', 'کهریزک');
      await type(tester, 'sf-mg_name', 'علی رضایی');
      await type(tester, 'sf-mg_user', 'Ali.Rezaei');
      await type(tester, 'sf-mg_pass', '123');
      await tap(tester, 'sf-submit');
      expect(
        tester.widget<Text>(find.byKey(const Key('sf-error'))).data,
        contains('۶'),
      );
      await type(tester, 'sf-mg_pass', 'Madrese-1403');
      await tap(tester, 'sf-submit');
      expect(find.byKey(const Key('school-form')), findsNothing);
      expect(flashes.last.$1, isTrue, reason: '${flashes.last}');
      var plain = await tester.runAsync(inBucket);
      final s = (plain!['schools']! as List).single as Map;
      final id = '${s['id']}';
      expect((s['manager'] as Map)['username'], 'ali.rezaei');
      // ردیف ۱۵۰: فرم مالک فقط مکان/اداره + مدیر؛ بقیه با مدیر (مشخصات مدرسه)
      expect(s.containsKey('work_days'), isFalse);
      expect(s.containsKey('level'), isFalse);
      expect(s.containsKey('gender'), isFalse);
      expect(s['province'], 'تهران');
      expect(s['district'], 'کهریزک');
      expect(find.byKey(Key('reg-school-$id')), findsOneWidget);
      expect(find.textContaining('دبستان شهید رجایی'), findsWidgets);

      // کد تکراری
      await tap(tester, 'p2-create-school');
      await type(tester, 'sf-name', 'دبستان دیگر');
      await type(tester, 'sf-code', '1001');
      await pick(tester, 'sf-province', 'تهران');
      await type(tester, 'sf-county', 'ری');
      await type(tester, 'sf-mg_name', 'کس دیگر');
      await type(tester, 'sf-mg_user', 'other.user');
      await type(tester, 'sf-mg_pass', 'pass-123456');
      await tap(tester, 'sf-submit');
      expect(
        tester.widget<Text>(find.byKey(const Key('sf-error'))).data,
        'کد مدرسه تکراری است',
      );
      await tap(tester, 'sf-cancel');

      // ویرایش
      await tap(tester, 'school-edit-$id');
      await type(tester, 'sf-name', 'دبستان نو');
      await tap(tester, 'sf-submit');
      expect(flashes.last, (true, 'تغییرات ذخیره شد'));

      // رمز تازهٔ مدیر
      await tap(tester, 'school-pass-$id');
      await type(tester, 'dlg-password', 'Taze-5678');
      await type(tester, 'dlg-reason', 'مدیر رمز را فراموش کرده است');
      await tap(tester, 'dlg-submit');
      expect(flashes.last, (true, 'رمز تازهٔ مدیر ثبت شد'));

      // تعلیق
      await tap(tester, 'school-toggle-$id');
      await type(tester, 'dlg-reason', 'تعلیق آزمایشی مدرسه برای آزمون');
      await tap(tester, 'dlg-submit');
      expect(flashes.last, (true, 'مدرسه غیرفعال شد'));

      // هدیه
      await tap(tester, 'school-gift-$id');
      await type(tester, 'dlg-days', '45');
      await type(tester, 'dlg-reason', 'هدیهٔ آغاز همکاری با مدرسه');
      await tap(tester, 'dlg-submit');
      expect(flashes.last.$1, isTrue);

      plain = await tester.runAsync(inBucket);
      final s2 = (plain!['schools']! as List).single as Map;
      expect(s2['name'], 'دبستان نو');
      expect(s2['active'], isFalse);
      expect((s2['manager'] as Map)['rev'], 2);
      final g = (plain['grants']! as List).single as Map;
      expect(g['days'], 45);
      expect(g['role'], 'manager');

      // حذف (با بازنویسی کد)
      await tap(tester, 'school-del-$id');
      await type(tester, 'dlg-reason', 'مدرسه دیگر همکاری نمی‌کند');
      await type(tester, 'dlg-retype', '1001');
      await tap(tester, 'dlg-submit');
      expect(flashes.last, (true, 'مدرسه حذف شد'));
      plain = await tester.runAsync(inBucket);
      expect(plain!['schools'], isEmpty);
    },
  );

  testWidgets('نوع ۲: درخواست ثبت‌نام ← تأیید با فرم p2 یا رد', (tester) async {
    final hash = (await tester.runAsync(
      () => pbkdf2Hash('Karimi-1403', iterations: 1000),
    ))!;
    const rid = '1794579912714-0123456789abcdef';
    const rid2 = '1794579912999-fedcba9876543210';
    for (final (id, user) in [(rid, 'm.karimi'), (rid2, 'other.mgr')]) {
      final sealed = await tester.runAsync(
        () => sealSchools(sk, SchoolKinds.request, 1, {
          'v': 1,
          'id': id,
          'school_name': 'هنرستان باهنر',
          'level': 'متوسطه اول',
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
      bucket.putText('payesh/${SchoolDirs.req}$id.json', sealed!);
    }
    await pumpSection(
      tester,
      SchoolsRegistrySection(registry: reg, flash: flash),
    );
    expect(find.byKey(const Key('req-$rid')), findsOneWidget);
    expect(find.byKey(const Key('req-$rid2')), findsOneWidget);
    expect(find.textContaining('نیشابور'), findsWidgets);

    await tap(tester, 'req-approve-$rid');
    expect(find.byKey(const Key('school-form')), findsOneWidget);
    // پیش‌پر از درخواست؛ رمز همان رمز متقاضی است
    expect(find.text('هنرستان باهنر'), findsWidgets);
    await tap(tester, 'sf-submit');
    expect(flashes.last.$1, isTrue, reason: '${flashes.last}');
    var plain = await tester.runAsync(inBucket);
    final s = (plain!['schools']! as List).single as Map;
    expect(s['request_id'], rid);
    expect((s['manager'] as Map)['username'], 'm.karimi');
    expect((s['manager'] as Map)['password_hash'], hash);
    expect(s['district'], 'خرو');
    // ردیف ۱۵۰: دادهٔ درخواست ثبت‌نام (مقطع، آمار) حفظ می‌شود
    expect(s['level'], 'متوسطه اول');
    expect(s['school_type'], 'rural');
    expect(find.byKey(const Key('req-$rid')), findsNothing);

    await tap(tester, 'req-reject-$rid2');
    await type(tester, 'dlg-reason', 'اطلاعات مدرسه ناقص است');
    await tap(tester, 'dlg-submit');
    expect(flashes.last, (true, 'درخواست رد شد'));
    plain = await tester.runAsync(inBucket);
    expect(((plain!['rejected']! as List).single as Map)['id'], rid2);
    expect(find.byKey(const Key('req-$rid2')), findsNothing);
  });

  testWidgets(
    'اشتراک: سیاست نقش‌ها، آزمایشی، درگاه، دامنه، تأیید پرداخت، هدیه',
    (tester) async {
      final id = (await tester.runAsync(
        () => reg.createSchool({
          'name': 'دبستان رجایی',
          'code': '1001',
          'province': 'تهران',
          'county': 'ری',
          'level': 'ابتدایی',
          'manager': {'name': 'علی رضایی', 'username': 'ali.rezaei'},
        }, password: 'Madrese-1403'),
      ))!;
      for (final (pid, status, amount) in [
        ('SUB-0A1B2C3D', 'pending', 250000),
        // ردیف ۱۵۴: مبلغ کمتر از قیمت ⇒ «مشکوک»
        ('SUB-0A1B2C3E', 'pending', 1000),
      ]) {
        final sealed = await tester.runAsync(
          () => sealSchools(sk, SchoolKinds.payment, 1, {
            'v': 1,
            'id': pid,
            'school_id': id,
            'uid': 1,
            'name': 'علی رضایی',
            'role': 'manager',
            'plan': 'monthly',
            'amount': amount,
            'method': 'receipt',
            'ref': 'TRX-$pid',
            'status': status,
            'created_at': '2026-11-13T09:00:00.000Z',
          }),
        );
        bucket.putText('payesh/${SchoolDirs.pay}$pid.json', sealed!);
      }
      final ack = await tester.runAsync(
        () => sealSchools(sk, SchoolKinds.ack, 1, {
          'v': 1,
          'school_id': id,
          'instance': 'inst-1',
          'at': '2026-11-13T09:59:00.000Z',
          'users': {
            'total': 2,
            'by_role': {'manager': 1, 'teacher': 1},
          },
          'subs': [
            {
              'uid': 1,
              'name': 'علی رضایی',
              'role': 'manager',
              'status': 'trial',
              'plan': 'trial',
              'end': '2026-12-01T00:00:00.000Z',
            },
          ],
        }),
      );
      bucket.putText('payesh/${SchoolDirs.ack}$id.json', ack!);

      await pumpSection(
        tester,
        Column(
          children: [
            SubscriptionSection(registry: reg, flash: flash),
            PaymentsSection(registry: reg, flash: flash),
          ],
        ),
      );
      expect(find.byKey(const Key('subscription-section')), findsOneWidget);
      expect(find.byKey(const Key('payments-section')), findsOneWidget);
      expect(find.byKey(const Key('sub-year-end')), findsOneWidget);
      // ردیف ۱۵۴: نشان «مشکوک» فقط کنار همان پرداخت
      expect(find.byKey(const Key('sub-suspect-count')), findsOneWidget);
      expect(find.byKey(const Key('pay-suspect-SUB-0A1B2C3E')), findsOneWidget);
      expect(find.byKey(const Key('pay-suspect-SUB-0A1B2C3D')), findsNothing);
      expect(find.textContaining('مبلغ کمتر از قیمت'), findsOneWidget);
      // پالایه و جست‌وجو
      await tap(tester, 'pay-filter-paid');
      expect(find.text('پرداختی با این پالایه پیدا نشد.'), findsOneWidget);
      await tap(tester, 'pay-filter-pending');
      expect(find.byKey(const Key('pay-approve-SUB-0A1B2C3D')), findsOneWidget);
      await type(tester, 'pay-search', 'trx-sub-0a1b2c3e');
      expect(find.byKey(const Key('pay-approve-SUB-0A1B2C3D')), findsNothing);
      expect(find.byKey(const Key('pay-approve-SUB-0A1B2C3E')), findsOneWidget);
      await type(tester, 'pay-search', '');
      await tap(tester, 'pay-filter-all');
      expect(find.byKey(const Key('gateway-off')), findsOneWidget);
      expect(find.text('در انتظار تأیید: ۲'), findsOneWidget);
      expect(find.text('آزمایشی: ۱'), findsOneWidget);

      // ردیف ۱۴۹: نقش دبیر ⇒ کلید «نیاز به اشتراک»؛ ماهانه/سالانه با مبلغ ریالی جدا
      await tester.ensureVisible(find.byKey(const Key('sub-role-teacher')));
      expect(find.byKey(const Key('sub-price-teacher-monthly')), findsNothing);
      await tap(tester, 'sub-role-teacher');
      expect(
        tester
            .widget<Text>(find.byKey(const Key('sub-role-label-teacher')))
            .data,
        'نیاز به اشتراک',
      );
      expect(
        find.byKey(const Key('sub-price-teacher-monthly')),
        findsOneWidget,
      );
      await type(tester, 'sub-trial-days', '400');
      await tap(tester, 'sub-save');
      expect(flashes.last, (false, 'روزهای آزمایشی باید بین ۰ تا ۳۶۵ باشد.'));
      await type(tester, 'sub-trial-days', '۱۴');
      // سالانهٔ دبیر خاموش ⇒ کادر مبلغ غیرفعال؛ مبلغ خالی پذیرفته نمی‌شود
      await tap(tester, 'sub-on-teacher-yearly');
      expect(
        tester
            .widget<TextField>(
              find.byKey(const Key('sub-price-teacher-yearly')),
            )
            .enabled,
        isFalse,
      );
      await type(tester, 'sub-price-teacher-monthly', '');
      await tap(tester, 'sub-save');
      expect(flashes.last, (
        false,
        'قیمت ماهانه برای دبیر را به ریال وارد کنید.',
      ));
      await type(tester, 'sub-price-teacher-monthly', '۹۰۰۰۰');
      await type(tester, 'sub-price-manager-monthly', '300000');
      await tap(tester, 'sub-save');
      expect(flashes.last.$1, isTrue, reason: '${flashes.last}');

      // درگاه: پیوند نادرست رد می‌شود؛ پیوند درست ⇒ «درگاه فعال»
      await type(tester, 'sub-pay-url', 'ftp://bad');
      await tap(tester, 'sub-save-gateway');
      expect(flashes.last.$1, isFalse);
      await type(
        tester,
        'sub-pay-url',
        'https://pay.example/start?amount={amount}&id={payment_id}&cb={callback}',
      );
      await type(tester, 'sub-receipt-note', 'کارت ۶۰۳۷-۰۰۰۰');
      await tap(tester, 'sub-save-gateway');
      expect(flashes.last, (true, 'تنظیمات پرداخت ذخیره شد.'));
      expect(find.byKey(const Key('gateway-on')), findsOneWidget);

      // کادر دامنه
      await type(tester, 'sub-domain', 'payesh.example.ir');
      await tap(tester, 'sub-save-domain');
      expect(flashes.last, (true, 'دامنه ذخیره شد.'));

      var plain = await tester.runAsync(inBucket);
      final st = plain!['settings']! as Map;
      expect(st['trial_days'], 14);
      expect((st['roles']! as Map)['teacher'], 'required');
      expect(st['plans'], [
        {'key': 'monthly', 'price': 300000},
        {'key': 'yearly', 'price': 2200000},
      ]);
      expect((st['role_plans']! as Map)['teacher'], {
        'monthly': 90000,
        'yearly': null,
      });
      expect((st['gateway']! as Map)['pay_url'], startsWith('https://pay.'));
      expect(st['receipt_note'], 'کارت ۶۰۳۷-۰۰۰۰');
      expect(plain['domain'], 'payesh.example.ir');

      // تأیید و رد پرداخت
      await tap(tester, 'pay-approve-SUB-0A1B2C3D');
      await type(tester, 'dlg-reason', 'رسید بانکی بررسی و تأیید شد');
      await tap(tester, 'dlg-submit');
      expect(flashes.last.$1, isTrue);
      expect(find.byKey(const Key('pay-approve-SUB-0A1B2C3D')), findsNothing);
      expect(find.text('تأیید شد (در حال اعمال)'), findsOneWidget);
      await tap(tester, 'pay-reject-SUB-0A1B2C3E');
      await type(tester, 'dlg-reason', 'مبلغ واریزی نادرست است');
      await tap(tester, 'dlg-submit');
      expect(flashes.last, (true, 'پرداخت رد شد.'));
      expect(find.text('رد شد (در حال اعمال)'), findsOneWidget);
      // ردیف ۱۴۹: لغو پرداخت تأییدشده
      await tap(tester, 'pay-cancel-SUB-0A1B2C3D');
      await type(tester, 'dlg-reason', 'تراکنش تکراری بود و برگشت داده شد');
      await tap(tester, 'dlg-submit');
      expect(flashes.last.$1, isTrue);
      expect(find.text('لغو شد (در حال اعمال)'), findsOneWidget);
      expect(find.byKey(const Key('pay-cancel-SUB-0A1B2C3D')), findsNothing);
      // لغو اشتراک یک مشترک
      await tap(tester, 'sub-cancel-$id-1');
      await type(tester, 'dlg-reason', 'لغو اشتراک به درخواست مدیر');
      await tap(tester, 'dlg-submit');
      expect(flashes.last, (
        true,
        'لغو اشتراک ثبت شد؛ سرور مدرسه تا یک دقیقهٔ دیگر اعمال می‌کند.',
      ));

      // هدیه و بازنشانی برای یک مشترک
      await tap(tester, 'sub-gift-$id-1');
      await type(tester, 'dlg-days', '0');
      await type(tester, 'dlg-reason', 'تمدید هدیه برای مدیر مدرسه');
      await tap(tester, 'dlg-submit');
      expect(find.byKey(const Key('dlg-error')), findsOneWidget);
      await type(tester, 'dlg-days', '20');
      await tap(tester, 'dlg-submit');
      expect(flashes.last.$1, isTrue);
      await tap(tester, 'sub-reset-$id-1');
      await type(tester, 'dlg-reason', 'بازنشانی اشتراک به درخواست مدیر');
      await tap(tester, 'dlg-submit');
      expect(flashes.last, (true, 'بازنشانی ثبت شد.'));

      plain = await tester.runAsync(inBucket);
      final d = plain!['decisions']! as Map;
      expect((d['SUB-0A1B2C3D']! as Map)['status'], 'cancelled');
      expect((d['SUB-0A1B2C3E']! as Map)['status'], 'rejected');
      final grants = plain['grants']! as List;
      expect(
        [for (final g in grants) (g as Map)['kind']],
        ['cancel', 'gift', 'reset'],
      );
      expect((grants[1] as Map)['user_id'], 1);
      expect((grants[1] as Map)['days'], 20);

      await tap(tester, 'sub-refresh');
      await tap(tester, 'pay-refresh');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('بدون دیتابیس: هشدار، نه خطای صفحه؛ تغییر با پیام روشن', (
    tester,
  ) async {
    bucket.down = true;
    await pumpSection(
      tester,
      Column(
        children: [
          SchoolsRegistrySection(registry: reg, flash: flash),
          SubscriptionSection(registry: reg, flash: flash),
        ],
      ),
    );
    expect(find.byKey(const Key('schools-offline')), findsNWidgets(2));
    expect(find.byKey(const Key('state-error')), findsNothing);
    await tap(tester, 'sub-save');
    expect(flashes.last.$1, isFalse);
    expect(tester.takeException(), isNull);
  });

  testWidgets('فقط مشاهده: دکمه‌های تغییر نیست', (tester) async {
    await pumpSection(
      tester,
      Column(
        children: [
          SchoolsRegistrySection(registry: reg, flash: flash, canManage: false),
          SubscriptionSection(registry: reg, flash: flash, canManage: false),
        ],
      ),
    );
    expect(find.byKey(const Key('p2-create-school')), findsNothing);
    expect(find.byKey(const Key('sub-save')), findsNothing);
    expect(find.byKey(const Key('subscription-section')), findsOneWidget);
  });
}
