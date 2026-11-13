import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/helper/helper_service.dart';
import 'package:payesh_owner/src/infra/infra_card.dart';
import 'package:payesh_owner/src/infra/infra_policy.dart';
import 'package:payesh_owner/src/local/local_platform.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_owner/src/monitor/live_monitor.dart';
import 'package:payesh_owner/src/net/resilience.dart';
import 'package:payesh_owner/src/status/status_lights.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'support/fake_bucket.dart';

/// کارت «زیرساخت‌ها» (ردیف ۱۳۱): هر زیرساخت با کلید و چراغ وضعیت؛ سرویس غیرفعال پایش نمی‌شود.
void main() {
  final t0 = DateTime.utc(2026, 11, 13, 9);
  setUpAll(() => s3RetryPolicy = RetryPolicy.none);
  tearDownAll(() => s3RetryPolicy = const RetryPolicy());
  setUp(EndpointRoutes.reset);

  String text(WidgetTester tester, String key) =>
      tester.widget<Text>(find.byKey(Key(key))).data!;

  const infra = ApiResult(
    ok: true,
    status: 200,
    body: {
      'services': [
        {'id': 'svc-a', 'name': 'سرور مدرسهٔ الف'},
        {'id': 'svc-b', 'name': 'سرور مدرسهٔ ب'},
        {'id': 'svc-c', 'name': 'بدون Endpoint'},
        {'id': 'svc-d', 'name': 'بررسی‌نشده'},
      ],
      'endpoints': [
        {
          'id': 'e1',
          'service_id': 'svc-a',
          'url': 'https://a.example.test/',
          'health': {'state': 'up'},
        },
        {
          'id': 'e2',
          'service_id': 'svc-b',
          'url': 'https://b.example.test/',
          'health': {'state': 'down'},
        },
        {
          'id': 'e3',
          'service_id': 'svc-d',
          'url': 'https://d.example.test/',
          'health': {'state': 'unknown'},
        },
      ],
    },
  );

  testWidgets('هر زیرساخت: کلید + چراغ؛ تغییر برای همه در دیتابیس', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final secure = FakeSecureStore();
    final bucket = FakeBucket(() => t0);
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
    await tester.runAsync(helper.init);
    final db = DbMonitor(
      probe: () async => const PlatformSync(state: 'synced'),
    );
    await tester.runAsync(db.refresh);
    await tester.pumpWidget(
      PayeshMaterialApp(
        title: 't',
        home: Scaffold(
          body: SingleChildScrollView(
            child: InfraCard(
              helper: helper,
              db: db,
              loadInfra: () async => infra,
              now: () => t0,
            ),
          ),
        ),
      ),
    );
    await tester.runAsync(() => Future<void>.delayed(Duration.zero));
    await tester.pumpAndSettle();

    expect(text(tester, 'infra-status-db'), startsWith('وصل'));
    final dbSwitch = tester.widget<Switch>(
      find.byKey(const Key('infra-db-switch')),
    );
    expect(dbSwitch.value, isTrue);
    expect(dbSwitch.onChanged, isNull); // دیتابیس همیشه روشن
    expect(text(tester, 'infra-status-svc-svc-a'), 'فعال — وصل');
    expect(text(tester, 'infra-status-svc-svc-b'), 'فعال — در دسترس نیست');
    expect(text(tester, 'infra-status-svc-svc-c'), contains('Endpoint'));
    expect(text(tester, 'infra-status-svc-svc-d'), contains('بررسی نشده'));
    expect(text(tester, 'infra-status-helpers'), contains('سیستم کمکی'));

    // غیرفعال کردن یک سرویس
    await tester.tap(find.byKey(const Key('infra-svc-switch-svc-b')));
    await tester.runAsync(() => helper.policy.refresh());
    await tester.pumpAndSettle();
    expect(helper.policy.value.serviceOn('svc-b'), isFalse);
    expect(text(tester, 'infra-status-svc-svc-b'), startsWith('غیرفعال'));
    expect(bucket.objects.keys, contains(infraPolicyKey));

    // پایش زنده: سرویس غیرفعال سنجیده نمی‌شود
    var probed = 0;
    final mon = LiveMonitor(
      enabled: (id) => helper.policy.value.serviceOn(id),
      checker: (u) async {
        probed++;
        return const CheckOutcome(ok: true, latencyMs: 5);
      },
    );
    mon.setInfra(infra.body!);
    await tester.runAsync(mon.probeNow);
    final b = mon.items.firstWhere((i) => i.id == 'svc-b');
    expect(b.disabled, isTrue);
    expect(b.up, isNull);
    expect(mon.items.firstWhere((i) => i.id == 'svc-a').up, isTrue);
    expect(probed, 2); // a و d؛ نه b
    mon.dispose();

    // بدون دیتابیس: تغییر «در انتظار ثبت»
    bucket.down = true;
    await tester.tap(find.byKey(const Key('infra-helpers-switch')));
    await tester.runAsync(() => helper.policy.refresh());
    await tester.pumpAndSettle();
    expect(helper.policy.value.helpers, isFalse);
    expect(find.byKey(const Key('infra-policy-note')), findsOneWidget);
    expect(text(tester, 'infra-status-helpers'), startsWith('خاموش'));

    await tester.pumpWidget(const SizedBox());
    db.dispose();
    await tester.runAsync(helper.dispose);
  });

  testWidgets('خطای فهرست زیرساخت و بدون سرویس کمکی', (tester) async {
    await tester.pumpWidget(
      PayeshMaterialApp(
        title: 't',
        home: Scaffold(
          body: InfraCard(
            loadInfra: () async =>
                const ApiResult(ok: false, status: 0, kind: 'network'),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('infra-card-error')), findsOneWidget);
    expect(find.byKey(const Key('infra-helpers-switch')), findsNothing);
    expect(text(tester, 'infra-status-db'), contains('بررسی'));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('ردیف ۱۵۳: هر سیستم کمکی کلید جدا دارد (برای همهٔ پنل‌ها)', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final secure = FakeSecureStore();
    final bucket = FakeBucket(() => t0);
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
    await tester.runAsync(helper.init);
    await tester.runAsync(() => helper.node!.tick());
    final id = helper.node!.helperId;
    await tester.pumpWidget(
      PayeshMaterialApp(
        title: 't',
        home: Scaffold(
          body: SingleChildScrollView(
            child: InfraCard(helper: helper, now: () => t0),
          ),
        ),
      ),
    );
    await tester.runAsync(() => Future<void>.delayed(Duration.zero));
    await tester.pumpAndSettle();
    expect(find.byKey(Key('infra-row-helper-$id')), findsOneWidget);
    expect(find.textContaining('(همین دستگاه)'), findsOneWidget);
    expect(text(tester, 'infra-status-helper-$id'), startsWith('روشن'));
    await tester.tap(find.byKey(Key('infra-helper-switch-$id')));
    await tester.runAsync(() => helper.policy.refresh());
    await tester.pumpAndSettle();
    expect(helper.policy.value.helperOn(id), isFalse);
    expect(helper.policy.value.off, contains(helperServiceId(id)));
    expect(text(tester, 'infra-status-helper-$id'), startsWith('خاموش'));
    expect(bucket.objects.keys, contains(infraPolicyKey));
    // حالت «فقط دیتابیس» ⇒ همهٔ سیستم‌ها منتظر
    await tester.tap(find.byKey(Key('infra-helper-switch-$id')));
    await tester.runAsync(() => helper.policy.setMode('db'));
    await tester.pumpAndSettle();
    expect(text(tester, 'infra-status-helper-$id'), startsWith('منتظر'));
    await tester.runAsync(helper.dispose);
  });
}
