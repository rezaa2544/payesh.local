import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/app.dart';
import 'package:payesh_owner/src/helper/helper_service.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_owner/src/platform.dart';
import 'package:payesh_owner/src/power/activity.dart';
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
    expect(find.text('فضای دیتابیس'), findsOneWidget);
    // ردیف ۱۵۳: بار لحظه‌ای و مسیر بار بالای داشبورد
    expect(find.byKey(const Key('load-card')), findsOneWidget);
    expect(find.byKey(const Key('load-rpm')), findsOneWidget);
    // ردیف ۱۸۰ (طرح ۲): کارت‌های KPI بالای صفحه، بعد «بار لحظه‌ای» و بعد پایش زنده
    expect(find.byKey(const Key('nabd-hero')), findsNothing);
    expect(find.byKey(const Key('owner-kpis')), findsOneWidget);
    expect(
      tester.getTopLeft(find.byKey(const Key('load-card'))).dy,
      lessThan(tester.getTopLeft(find.byKey(const Key('live-infra'))).dy),
    );
    expect(find.byKey(const Key('route-chain')), findsOneWidget);
    // ردیف ۱۸۱ (طرح ۲، مو به مو): «پردازش کمکی (همین سیستم)» فشرده زیر KPIها در «dash-pair»
    // (کنار کارت «مدارس» وقتی سرور وصل است) — بالای «بار لحظه‌ای» و پایش زنده.
    final pair = find.byKey(const Key('dash-pair'));
    expect(
      find.descendant(
        of: pair,
        matching: find.byKey(const Key('dash-helper-card')),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: pair,
        matching: find.byKey(const Key('helper-compact')),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: pair,
        matching: find.text('پردازش کمکی (همین سیستم)', findRichText: true),
      ),
      findsOneWidget,
    );
    expect(find.byKey(const Key('live-side')), findsNothing);
    expect(
      tester.getRect(pair).bottom,
      lessThanOrEqualTo(
        tester.getTopLeft(find.byKey(const Key('load-card'))).dy,
      ),
      reason: 'helper above the load card',
    );
    for (final k in [
      'helper-start',
      'helper-stop',
      'helper-cpu',
      'helper-stat-cpu',
      'helper-stat-done',
      'helper-stat-host',
      'helper-cap',
    ]) {
      expect(find.byKey(Key(k)), findsOneWidget, reason: k);
    }
    // کارت فشرده: توقف ⇒ «متوقف»، شروع دوباره ⇒ آماده/در حال کار
    await tester.ensureVisible(find.byKey(const Key('helper-stop')));
    await tester.tap(find.byKey(const Key('helper-stop')));
    await tester.pumpAndSettle();
    expect(text(tester, 'helper-run-state'), 'متوقف');
    // ردیف ۱۹۱: «توقف» همین سیستم کارهای سنگین پس‌زمینهٔ پنل را هم نگه می‌دارد
    expect(OwnerActivity.instance.processingPaused, isTrue);
    expect(text(tester, 'helper-cap'), contains('متوقف است'));
    await tester.tap(find.byKey(const Key('helper-start')));
    await tester.pumpAndSettle();
    expect(text(tester, 'helper-run-state'), isNot('متوقف'));
    expect(OwnerActivity.instance.processingPaused, isFalse);

    // زیرساخت: کارت «زیرساخت‌ها» بالای صفحه (ردیف ۱۳۱)
    await tap(tester, 'nav-infra');
    expect(find.byKey(const Key('infra-card-top')), findsOneWidget);
    expect(find.byKey(const Key('infra-light-db')), findsOneWidget);
    expect(text(tester, 'infra-status-self'), startsWith('فعال'));
    expect(text(tester, 'infra-status-helpers'), startsWith('روشن'));

    // ردیف ۱۶۴: «زیرساخت» = راست «مدل پردازش»، چپ «تعریف سرور» + «تعریف دیتابیس» + کلیدها
    // و سرور کمکی؛ فهرست ارائه‌دهنده‌ها/سرویس‌ها دیگر نیست.
    expect(find.byKey(const Key('infra-side-by-side')), findsOneWidget);
    expect(find.text('ارائه‌دهنده‌ها'), findsNothing);
    expect(find.byKey(const Key('provisioning-manual')), findsNothing);
    final arch = tester.getRect(find.byKey(const Key('arch-card')));
    final server = tester.getRect(find.byKey(const Key('server-panel')));
    final dbPanel = tester.getRect(find.byKey(const Key('db-panel')));
    expect(arch.left, greaterThan(server.right), reason: 'مدل پردازش سمت راست');
    expect(dbPanel.right, lessThan(arch.left), reason: 'دیتابیس سمت چپ');
    expect((arch.top - server.top).abs(), lessThan(40), reason: 'هم‌تراز');
    expect(find.byKey(const Key('db-endpoint')), findsOneWidget);
    expect(find.byKey(const Key('server-url')), findsOneWidget);
    expect(find.byKey(const Key('arch-external')), findsNothing);
    // پنجرهٔ باریک ⇒ زیر هم
    tester.view.physicalSize = const Size(820, 1100);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('infra-side-by-side')), findsNothing);
    expect(find.byKey(const Key('infra-top-pane')), findsOneWidget);
    tester.view.physicalSize = const Size(1400, 1100);
    await tester.pumpAndSettle();

    // ردیف ۱۵۱: سرور کمکی فقط در «زیرساخت» (دیگر در «تنظیمات» تکرار نمی‌شود)
    await tap(tester, 'nav-settings');
    expect(find.byKey(const Key('helper-switch')), findsNothing);
    expect(find.byKey(const Key('infra-card')), findsNothing);
    expect(find.byKey(const Key('db-endpoint')), findsNothing);
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

    // ردیف ۱۷۸: «شروع/توقف» و «مقدار پردازش» داخل همین کارت «پردازش کمکی (همین سیستم)»
    final controls = find.byKey(const Key('helper-controls'));
    expect(controls, findsOneWidget);
    for (final k in ['helper-toggle', 'helper-cpu', 'helper-cpu-value']) {
      expect(
        find.descendant(of: controls, matching: find.byKey(Key(k))),
        findsOneWidget,
      );
    }
    expect(text(tester, 'helper-run-state'), contains('در حال کار'));
    expect(find.widgetWithText(OutlinedButton, 'توقف'), findsOneWidget);
    expect(text(tester, 'helper-cpu-value'), 'کامل');
    await tap(tester, 'helper-toggle'); // توقف
    expect(helper.node!.paused, isTrue);
    expect(await secure.read(HelperKeys.paused), '1');
    expect(text(tester, 'helper-run-state'), contains('متوقف'));
    expect(find.widgetWithText(FilledButton, 'شروع'), findsOneWidget);
    // «شروع» هر چیزی را که جلوی همین سیستم را گرفته برمی‌دارد — حتی «توقف پردازش» کلی
    await tester.runAsync(() => helper.policy.setProcessing(paused: true));
    await tester.pumpAndSettle();
    expect(text(tester, 'helper-status'), contains('کنترل پردازش'));
    await tap(tester, 'helper-toggle'); // شروع
    await tester.runAsync(() => helper.policy.refresh());
    await tester.pumpAndSettle();
    expect(helper.node!.paused, isFalse);
    expect(helper.policy.value.procPaused, isFalse);
    expect(text(tester, 'helper-run-state'), contains('در حال کار'));
    // مقدار پردازش همین سیستم (ماندگار): RTL ⇒ کشیدن به راست = کمینه ۱۰٪
    final cpu = find.byKey(const Key('helper-cpu'));
    await tester.ensureVisible(cpu);
    await tester.pumpAndSettle();
    await tester.drag(cpu, const Offset(2000, 0));
    await tester.pumpAndSettle();
    expect(await secure.read(HelperKeys.cpu), '10');
    expect(helper.localCpu, 10);
    expect(helper.effectiveCpu, 10);
    expect(text(tester, 'helper-cpu-value'), '۱۰٪');
    expect(text(tester, 'helper-cpu-note'), contains('۱۰٪'));
    await tester.drag(cpu, const Offset(-2000, 0));
    await tester.pumpAndSettle();
    expect(await secure.read(HelperKeys.cpu), isNull);
    expect(helper.localCpu, isNull);
    expect(text(tester, 'helper-cpu-value'), 'کامل');

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
