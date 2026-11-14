import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/app.dart';
import 'package:payesh_owner/src/helper/helper_service.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_owner/src/platform.dart';
import 'package:payesh_owner/src/update/update_service.dart';
import 'package:payesh_secure/payesh_secure.dart';

import 'owner_update_test.dart' show FakeHttp;
import 'support/fake_backend.dart';
import 'support/fake_bucket.dart';

/// «تنظیمات» برنامهٔ نصب‌شده: بخش سرور کمکی (پیش‌فرض روشن) و به‌روزرسانی برنامه.
void main() {
  final t0 = DateTime.utc(2026, 11, 13, 9);

  Future<void> tap(WidgetTester tester, String key) async {
    final f = find.byKey(Key(key));
    await tester.ensureVisible(f);
    await tester.pumpAndSettle();
    await tester.tap(f);
    await tester.pumpAndSettle();
  }

  String text(WidgetTester tester, String key) =>
      tester.widget<Text>(find.byKey(Key(key))).data!;

  testWidgets('سرور کمکی و به‌روزرسانی در تنظیمات', (tester) async {
    tester.view.physicalSize = const Size(1400, 1100);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final secure = FakeSecureStore();
    final bucket = FakeBucket(() => t0)
      ..putText('payesh/schools/a/1.bin', 'x' * 2048);
    await S3Settings(
      endpoint: Uri.https('s3.example.test'),
      accessKey: 'ak',
      secretKey: 'sk',
      bucket: 'payesh-madrese',
    ).save(secure);
    final helper = OwnerHelperService(
      secure: secure,
      transport: bucket.transport,
      now: () => t0,
      sleep: (_) async {},
      autoStart: false,
      slots: 1,
    );
    final http = FakeHttp()
      ..files[defaultManifestUrl.toString()] = utf8.encode(
        jsonEncode({
          'schema': ownerUpdateSchema,
          'build': 150,
          'commit': 'c' * 40,
          'files': [
            {
              'path': 'data/app.so',
              'sha256': 'd' * 64,
              'size': 10,
              'gz_size': 5,
            },
          ],
        }),
      );
    final updater = OwnerUpdater(
      secure: secure,
      http: () => http,
      windows: false,
    );
    await tester.pumpWidget(
      OwnerApp(
        store: MemorySettingsStore(),
        httpFactory: FakeBackend.new,
        secure: secure,
        s3Factory: bucket.transport,
        pbkdf2Iterations: 50,
        now: () => t0,
        helper: helper,
        updater: updater,
      ),
    );
    await tester.pumpAndSettle();
    for (final e in {
      'setup-id': 'rezaa-test',
      'setup-pw': 'pass-word-123',
      'setup-code': '123456',
    }.entries) {
      await tester.enterText(find.byKey(Key(e.key)), e.value);
    }
    await tap(tester, 'setup-submit');
    expect(find.byKey(const Key('local-shell')), findsOneWidget);

    // داشبورد (صفحهٔ اول): پایش زندهٔ زیرساخت با کارت دیتابیس (ردیف ۱۳۰)
    expect(find.byKey(const Key('live-infra')), findsOneWidget);
    expect(find.byKey(const Key('live-db')), findsOneWidget);
    expect(find.byKey(const Key('live-db-traffic')), findsOneWidget);
    await tester.pump(const Duration(seconds: 1));
    expect(find.textContaining('فضای دیتابیس'), findsOneWidget);
    // ردیف ۱۵۳: بار لحظه‌ای و مسیر بار بالای داشبورد
    expect(find.byKey(const Key('load-card')), findsOneWidget);
    expect(find.byKey(const Key('load-rpm')), findsOneWidget);
    // ردیف ۱۵۶: داخل کادر «نبض پلتفرم»، بالای پایش زنده، بدون کارت جدا
    expect(
      find.descendant(
        of: find.byKey(const Key('nabd-hero')),
        matching: find.byKey(const Key('load-rpm')),
      ),
      findsOneWidget,
    );
    expect(
      tester.getTopLeft(find.byKey(const Key('nabd-hero'))).dy,
      lessThan(tester.getTopLeft(find.byKey(const Key('live-infra'))).dy),
    );
    expect(find.byKey(const Key('route-chain')), findsOneWidget);

    // زیرساخت: کارت «زیرساخت‌ها» بالای صفحه (ردیف ۱۳۱)
    await tap(tester, 'nav-infra');
    expect(find.byKey(const Key('infra-card-top')), findsOneWidget);
    expect(find.byKey(const Key('infra-light-db')), findsOneWidget);
    expect(text(tester, 'infra-status-self'), startsWith('فعال'));
    expect(text(tester, 'infra-status-helpers'), startsWith('روشن'));

    // ردیف ۱۵۱: سرور کمکی فقط در «زیرساخت» (دیگر در «تنظیمات» تکرار نمی‌شود)
    await tap(tester, 'nav-settings');
    expect(find.byKey(const Key('helper-switch')), findsNothing);
    expect(find.byKey(const Key('infra-card')), findsNothing);
    await tap(tester, 'nav-infra');
    // پیش‌فرض روشن
    final sw = tester.widget<Switch>(find.byKey(const Key('helper-switch')));
    expect(sw.value, isTrue);
    expect(text(tester, 'helper-status'), startsWith('فعال'));

    // کار نمونه: سرور کمکیِ دیگری نیست ⇒ همین دستگاه انجام می‌دهد
    await tap(tester, 'helper-usage');
    expect(text(tester, 'helper-usage-result'), contains('همین دستگاه'));
    expect(text(tester, 'helper-usage-result'), contains('کیلوبایت'));

    // حضور همین دستگاه در فهرست سرورهای کمکی
    await tester.runAsync(() => helper.node!.tick());
    await tap(tester, 'helper-list');
    expect(text(tester, 'helper-count'), contains('1 فعال از 1'));
    final self = helper.node!.helperId;
    expect(find.byKey(Key('helper-$self')), findsOneWidget);

    // توقف موقت (ماندگار)
    await tap(tester, 'helper-switch');
    expect(helper.node!.paused, isTrue);
    expect(await secure.read(HelperKeys.paused), '1');
    expect(text(tester, 'helper-status'), startsWith('متوقف'));
    await tap(tester, 'helper-switch');
    expect(helper.node!.paused, isFalse);

    // پردازش کمکی برای همه (سیاست رمزشده در دیتابیس، ردیف ۱۳۱)
    await tap(tester, 'infra-helpers-switch');
    await tester.runAsync(() => helper.policy.refresh());
    await tester.pumpAndSettle();
    expect(helper.policy.value.helpers, isFalse);
    expect(helper.policy.pending, isFalse);
    expect(bucket.objects.keys, contains('payesh/control/infra-policy.json'));
    expect(text(tester, 'infra-status-helpers'), startsWith('خاموش'));
    expect(text(tester, 'infra-status-self'), startsWith('منتظر'));
    await tap(tester, 'helper-usage');
    expect(text(tester, 'helper-usage-result'), contains('خاموش'));
    await tap(tester, 'infra-helpers-switch');
    await tester.runAsync(() => helper.policy.refresh());
    await tester.pumpAndSettle();
    expect(helper.policy.value.helpers, isTrue);

    // ردیف ۱۵۳: «حالت معماری» بالای «زیرساخت» — هم‌خوان با کلید «پردازش کمکی»
    expect(find.byKey(const Key('arch-card')), findsOneWidget);
    await tap(tester, 'arch-mode-db');
    await tester.runAsync(() => helper.policy.refresh());
    await tester.pumpAndSettle();
    expect(helper.policy.value.mode, 'db');
    expect(text(tester, 'infra-status-helpers'), startsWith('خاموش'));
    await tap(tester, 'arch-mode-external');
    await tester.runAsync(() => helper.policy.refresh());
    await tester.pumpAndSettle();
    expect(helper.policy.value.mode, 'external');
    expect(helper.policy.value.helpers, isTrue);
    await tap(tester, 'arch-mode-helpers');
    await tester.runAsync(() => helper.policy.refresh());
    await tester.pumpAndSettle();
    expect(helper.policy.value.mode, 'helpers');

    // به‌روزرسانی در «تنظیمات» (اندروید/غیرویندوز: فقط اعلام بستهٔ کامل)
    await tap(tester, 'nav-settings');
    expect(find.byKey(const Key('upd-check')), findsOneWidget);
    await tap(tester, 'upd-check');
    expect(find.byKey(const Key('upd-status')), findsOneWidget);
    expect(find.byKey(const Key('upd-download')), findsNothing);

    // پاک کردن تنظیمات دیتابیس ⇒ سرور کمکی بیکار
    await S3Settings.clear(secure);
    await helper.reload();
    await tester.pumpAndSettle();
    await tap(tester, 'nav-infra');
    expect(text(tester, 'helper-status'), contains('اول دیتابیس'));
    await helper.dispose();
    await updater.dispose();
  });
}
