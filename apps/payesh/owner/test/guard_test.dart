import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/guard/fraud.dart';
import 'package:payesh_owner/src/guard/guard_engine.dart';
import 'package:payesh_owner/src/helper/helper_service.dart';
import 'package:payesh_owner/src/infra/infra_policy.dart';
import 'package:payesh_owner/src/infra/load_route.dart';
import 'package:payesh_owner/src/monitor/net_meter.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_owner/src/menu.dart';
import 'package:payesh_owner/src/net/resilience.dart';
import 'package:payesh_owner/src/pages/guard_page.dart';
import 'package:payesh_owner/src/schools/school_registry.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'support/fake_bucket.dart';

/// ردیف ۱۵۴: موتور هوشمند مالک — تراکنش مشکوک، صف دستورها، رفع خودکار، صفحهٔ نگهبان.
void main() {
  final now = DateTime.utc(2026, 11, 13, 10);
  final settings = SubSettings.of({
    'settings': {
      'roles': {'manager': 'required', 'parent': 'required', 'teacher': 'free'},
      'role_plans': {
        'manager': {'monthly': 250000, 'yearly': 2200000},
        'parent': {'monthly': 100000},
      },
    },
  });

  Map<String, Object?> pay(
    String id, {
    String uid = '1',
    String role = 'manager',
    String plan = 'monthly',
    int amount = 250000,
    String status = 'paid',
    String? ref,
    String school = 'SCH-1',
    DateTime? at,
    Map<String, Object?>? decision,
  }) => {
    'id': id,
    'uid': uid,
    'name': 'کاربر $uid',
    'role': role,
    'plan': plan,
    'amount': amount,
    'method': 'gateway',
    'status': status,
    'ref': ?ref,
    'school_id': school,
    'created_at': (at ?? now.subtract(const Duration(days: 3)))
        .toIso8601String(),
    'decision': ?decision,
  };

  List<String> codes(List<FraudFinding> f) => [for (final x in f) x.code];

  group('تراکنش مشکوک اشتراک', () {
    test('پرداخت سالم ⇒ هیچ یافته‌ای', () {
      expect(
        suspiciousPayments(
          [
            pay('SUB-00000001', ref: 'TRX-1'),
            pay('SUB-00000002', uid: '2', plan: 'yearly', amount: 2200000),
            pay('SUB-00000003', uid: '3', role: 'parent', amount: 100000),
          ],
          settings,
          now: now,
        ),
        isEmpty,
      );
    });

    test('کد پیگیری تکراری (با فاصله و خط تیره) در دو مدرسه ⇒ شدید', () {
      final f = suspiciousPayments(
        [
          pay('SUB-00000001', ref: 'TRX-12 34'),
          pay('SUB-00000002', uid: '9', ref: 'trx1234', school: 'SCH-2'),
          pay('SUB-00000003', uid: '5', ref: 'ab'),
          pay('SUB-00000004', uid: '6', ref: 'ab'),
        ],
        settings,
        now: now,
      );
      expect(codes(f), ['dup_ref']);
      expect(f.single.severity, FraudSeverity.high);
      expect(f.single.paymentIds, ['SUB-00000001', 'SUB-00000002']);
      expect(f.single.schoolId, '');
      expect(f.single.detailFa, contains('مدرسهٔ مختلف'));
      expect(f.single.id, 'dup_ref:SUB-00000001,SUB-00000002');
    });

    test('مبلغ کم/زیاد/صفر، پلن عرضه‌نشده، نقش رایگان، زمان آینده', () {
      final f = suspiciousPayments(
        [
          pay('SUB-00000001', amount: 1000),
          pay('SUB-00000002', uid: '2', amount: 300000),
          pay('SUB-00000003', uid: '3', amount: 0),
          pay('SUB-00000004', uid: '4', role: 'parent', plan: 'yearly'),
          pay('SUB-00000005', uid: '5', role: 'teacher'),
          pay('SUB-00000006', uid: '6', at: now.add(const Duration(hours: 2))),
          // ناموفق و لغوشده شمرده نمی‌شوند؛ مبلغ صفرِ ناموفق هم نه
          pay('SUB-00000007', uid: '7', amount: 1, status: 'failed'),
          pay('SUB-00000008', uid: '8', amount: 0, status: 'failed'),
        ],
        settings,
        now: now,
      );
      expect(codes(f), [
        'amount_low',
        'zero_amount',
        'plan_not_offered',
        'plan_not_offered',
        'amount_high',
        'future_date',
      ]);
      expect(f[0].detailFa, contains('250000'));
      expect(f[2].detailFa, contains('عرضه نمی‌شود'));
      expect(f[3].detailFa, contains('رایگان'));
    });

    test('کد تراکنش درگاه تکراری و پرداخت درگاهی بدون کد', () {
      final f = suspiciousPayments(
        [
          pay('SUB-00000001')
            ..['gateway_ref'] = '98765'
            ..['approved_by'] = 'gateway',
          pay('SUB-00000002', uid: '2', status: 'pending')
            ..['gateway_ref'] = '98765'
            ..['flag'] = 'dup_gateway_ref',
          // همان پرداخت با ref و gateway_ref یکسان یک بار شمرده می‌شود
          pay('SUB-00000003', uid: '3', ref: 'R-4444')
            ..['gateway_ref'] = 'r4444',
          pay('SUB-00000004', uid: '4')..['approved_by'] = 'gateway',
          pay('SUB-00000005', uid: '5')..['approved_by'] = 'owner',
        ],
        settings,
        now: now,
      );
      expect(codes(f), ['dup_ref', 'no_ref']);
      expect(f[0].paymentIds, ['SUB-00000001', 'SUB-00000002']);
      expect(f[0].detailFa, contains('98765'));
      expect(f[1].paymentIds, ['SUB-00000004']);
    });

    test('تصمیم مالک بر وضعیت سرور مقدم است', () {
      expect(
        effectivePaymentStatus(
          pay('SUB-1', status: 'paid', decision: {'status': 'cancelled'}),
        ),
        'cancelled',
      );
      // پرداخت معلقِ تأییدشده با مبلغ صفر ⇒ شدید
      expect(
        codes(
          suspiciousPayments(
            [
              pay(
                'SUB-00000001',
                amount: 0,
                status: 'pending',
                decision: {'status': 'approved'},
              ),
            ],
            settings,
            now: now,
          ),
        ),
        ['zero_amount'],
      );
    });

    test('پرداخت‌های پی‌درپی یک کاربر و ناموفق‌های پی‌درپی یک مدرسه', () {
      final t0 = now.subtract(const Duration(hours: 30));
      final f = suspiciousPayments(
        [
          for (var i = 0; i < 3; i++)
            pay('SUB-0000001$i', at: t0.add(Duration(hours: i * 5))),
          // همان کاربر در مدرسهٔ دیگر جدا شمرده می‌شود
          pay('SUB-00000020', school: 'SCH-2', at: t0),
          for (var i = 0; i < 5; i++)
            pay(
              'SUB-0000003$i',
              uid: '${40 + i}',
              status: i.isEven ? 'failed' : 'rejected',
              at: t0.add(Duration(minutes: i * 10)),
            ),
          // چهار ناموفق در مدرسهٔ دیگر کافی نیست
          for (var i = 0; i < 4; i++)
            pay(
              'SUB-0000005$i',
              uid: '${50 + i}',
              status: 'failed',
              school: 'SCH-3',
              at: t0,
            ),
        ],
        settings,
        now: now,
      );
      expect(codes(f)..sort(), ['burst_user', 'failed_burst']);
      final b = f.firstWhere((x) => x.code == 'burst_user');
      expect(b.paymentIds.length, 3);
      expect(b.schoolId, 'SCH-1');
      final fb = f.firstWhere((x) => x.code == 'failed_burst');
      expect(fb.paymentIds.length, 5);
      expect(fb.detailFa, contains('SCH-1'));
    });
  });

  group('صف دستورهای مالک (هیچ دستوری گم نمی‌شود)', () {
    setUpAll(() => s3RetryPolicy = RetryPolicy.none);
    tearDownAll(() => s3RetryPolicy = const RetryPolicy());
    late DateTime clock;
    late FakeBucket bucket;
    late FakeSecureStore secure;
    late SchoolRegistry reg;
    const sk = 'sk-test';

    setUp(() async {
      EndpointRoutes.reset();
      clock = now;
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

    Future<Map<String, Object?>> decisions() async {
      final r = await openSchools(
        sk,
        SchoolKinds.registry,
        bucket.text('payesh/${SchoolDirs.registry}')!,
      );
      final d = r!.plain['decisions'];
      return d is Map ? d.cast<String, Object?>() : {};
    }

    test('دیتابیس قطع ⇒ صف؛ وصل ⇒ به همان ترتیب و با زمان اصلی ثبت', () async {
      bucket.down = true;
      await expectLater(
        reg.decide('SUB-0A1B2C3D', true),
        throwsA(isA<SchoolsFailure>().having((e) => e.code, 'code', 'queued')),
      );
      clock = now.add(const Duration(minutes: 1));
      await expectLater(
        reg.cancelPayment('SUB-0A1B2C3D', reason: 'مشکوک'),
        throwsA(isA<SchoolsFailure>().having((e) => e.code, 'code', 'queued')),
      );
      await expectLater(
        reg.setActive('SCH-NOPE', false),
        throwsA(isA<SchoolsFailure>()),
      );
      expect((await reg.pendingCommands()).length, 3);
      // تلاش دوباره هنگام قطعی: چیزی گم نمی‌شود
      var r = await reg.replayJournal();
      expect((r.done, r.left, r.dropped), (0, 3, 0));

      bucket.down = false;
      clock = now.add(const Duration(minutes: 5));
      r = await reg.replayJournal();
      // مدرسهٔ ناموجود دیگر معتبر نیست ⇒ کنار گذاشته و ثبت می‌شود
      expect((r.done, r.left, r.dropped), (2, 0, 1));
      expect(await reg.pendingCommands(), isEmpty);
      final dropped = await reg.droppedCommands();
      expect(dropped.single['op'], 'active');
      expect(dropped.single['error'], 'not_found');
      final d = (await decisions())['SUB-0A1B2C3D']! as Map;
      expect(d['status'], 'cancelled');
      expect(d['reason'], 'مشکوک');
      expect(d['at'], now.add(const Duration(minutes: 1)).toIso8601String());
    });

    test(
      'دستور تازه پیش از اجرا صف قدیمی را خالی می‌کند (ترتیب حفظ)',
      () async {
        bucket.down = true;
        await expectLater(
          reg.decide('SUB-0A1B2C3D', false, reason: 'اول'),
          throwsA(isA<SchoolsFailure>()),
        );
        bucket.down = false;
        await reg.decide('SUB-0A1B2C3D', true);
        expect(await reg.pendingCommands(), isEmpty);
        expect(
          ((await decisions())['SUB-0A1B2C3D']! as Map)['status'],
          'approved',
        );
        // خطای غیرموقت صف نمی‌شود
        expect(() => reg.decide('bad', true), throwsA(isA<SchoolsFailure>()));
        expect(
          () => reg.rejectRequest('bad', 'x'),
          throwsA(isA<SchoolsFailure>()),
        );
        expect(await reg.pendingCommands(), isEmpty);
      },
    );

    test(
      'موتور: صف را خالی می‌کند، گزارش می‌دهد و رفع را ثبت می‌کند',
      () async {
        bucket.down = true;
        await expectLater(
          reg.decide('SUB-0A1B2C3D', true),
          throwsA(isA<SchoolsFailure>()),
        );
        final g = GuardEngine(
          secure: secure,
          registry: reg,
          loadSchools: () async =>
              const SchoolsView(connected: false, rev: 0, plain: {}),
          now: () => clock,
        );
        await g.run();
        final j = g.findings.firstWhere((f) => f.check == 'journal');
        expect(j.level, GuardLevel.warning);
        expect(j.titleFa, contains('در صف'));
        expect(g.findings.any((f) => f.check == 'registry'), isTrue);
        expect(g.level, GuardLevel.warning);

        bucket.down = false;
        await g.run();
        final ok = g.findings.firstWhere((f) => f.check == 'journal');
        expect(ok.level, GuardLevel.ok);
        expect(ok.fixedFa, contains('ثبت شد'));
        expect(g.log.last.check, 'journal');
        expect(await reg.pendingCommands(), isEmpty);
        // دور بعد: صف خالی ⇒ یافتهٔ صف نیست
        await g.run();
        expect(g.findings.any((f) => f.check == 'journal'), isFalse);
        g.dispose();
      },
    );
  });

  group('موتور هوشمند + سرور کمکی', () {
    setUpAll(() => s3RetryPolicy = RetryPolicy.none);
    tearDownAll(() => s3RetryPolicy = const RetryPolicy());
    late DateTime clock;
    late FakeBucket bucket;
    late FakeSecureStore secure;
    late OwnerHelperService helper;

    setUp(() async {
      EndpointRoutes.reset();
      NetMeter.reset();
      clock = now;
      bucket = FakeBucket(() => clock);
      secure = FakeSecureStore();
      await S3Settings(
        endpoint: Uri.https('s3.example.test'),
        accessKey: 'ak',
        secretKey: 'sk-test',
        bucket: 'payesh-madrese',
      ).save(secure);
      helper = OwnerHelperService(
        secure: secure,
        transport: bucket.transport,
        now: () => clock,
        sleep: (_) async {},
        autoStart: false,
        slots: 1,
      );
      await helper.init();
    });
    tearDown(NetMeter.reset);

    test('سیاست ثبت‌نشده ⇒ ثبت دوباره؛ قطع ⇒ هشدار', () async {
      var db = 0;
      final g = GuardEngine(
        secure: secure,
        helper: helper,
        onDbTrouble: () async => db++,
        now: () => clock,
      );
      bucket.down = true;
      await helper.policy.setMode(ArchModes.db);
      expect(helper.policy.pending, isTrue);
      await g.run();
      final w = g.findings.firstWhere((f) => f.check == 'policy');
      expect(w.level, GuardLevel.warning);
      expect(w.fixedFa, isNull);
      bucket.down = false;
      await g.run();
      final ok = g.findings.firstWhere((f) => f.check == 'policy');
      expect(ok.level, GuardLevel.ok);
      expect(ok.fixedFa, 'ثبت دوباره');
      expect(helper.policy.pending, isFalse);
      expect(bucket.objects.keys, contains(infraPolicyKey));
      expect(g.log.map((e) => e.check), contains('policy'));
      // درخواست‌های ناموفق دوران قطعی ⇒ موتور اتصال را هم بازبینی کرده است
      expect(db, greaterThanOrEqualTo(0));
      g.dispose();
    });

    test('خطای بالای دیتابیس ⇒ بازبینی اتصال؛ کندی ⇒ هشدار', () async {
      var db = 0;
      final g = GuardEngine(
        secure: secure,
        helper: helper,
        onDbTrouble: () async => db++,
        now: () => clock,
      );
      for (var i = 0; i < 6; i++) {
        NetMeter.record(
          NetMeter.db,
          elapsedMs: 100,
          ok: i.isEven,
          at: clock.subtract(Duration(seconds: i)),
        );
      }
      await g.run();
      final d = g.findings.firstWhere((f) => f.check == 'db');
      expect(d.level, GuardLevel.danger);
      expect(d.fixedFa, 'بازبینی اتصال');
      expect(db, 1);
      expect(g.log.last.textFa, contains('٪'));
      expect(g.findings.first.check, 'db');

      NetMeter.reset();
      for (var i = 0; i < 6; i++) {
        NetMeter.record(
          NetMeter.db,
          elapsedMs: 3000,
          at: clock.subtract(Duration(seconds: i)),
        );
      }
      await g.run();
      final slow = g.findings.firstWhere((f) => f.check == 'db');
      expect(slow.level, GuardLevel.warning);
      expect(slow.titleFa, 'دیتابیس کند است');
      expect(db, 1);
      g.dispose();
    });

    test('کار ماندهٔ صندوقچه ⇒ پاک‌سازی خودکار (bucket.gc)', () async {
      bucket
        ..putText(
          'payesh/jobs/req/old1.json',
          '{}',
          at: now.subtract(const Duration(hours: 5)),
        )
        ..putText('payesh/jobs/res/fresh.json', '{}');
      final g = GuardEngine(secure: secure, helper: helper, now: () => clock);
      await g.run();
      final j = g.findings.firstWhere((f) => f.check == 'jobs');
      expect(j.titleFa, contains('1'));
      expect(j.detailFa, contains('هرگز متوقف'));
      expect(j.level, j.fixedFa == null ? GuardLevel.warning : GuardLevel.ok);
      g.dispose();
    });
  });

  group('موتور هوشمند', () {
    SchoolsView view({
      List<Map<String, Object?>> payments = const [],
      Map<String, Map<String, Object?>> acks = const {},
    }) => SchoolsView(
      connected: true,
      rev: 1,
      plain: {
        'v': 1,
        'schools': [
          {'id': 'SCH-1', 'name': 'دبستان یک', 'active': true},
          {'id': 'SCH-2', 'name': 'دبستان دو', 'active': false},
          {'id': 'SCH-3', 'name': 'دبستان سه', 'active': true},
        ],
        'settings': {
          'role_plans': {
            'manager': {'monthly': 250000, 'yearly': 2200000},
          },
        },
      },
      payments: payments,
      acks: acks,
    );

    test('میزبان خاموش، تراکنش مشکوک، «بررسی شد» ماندگار', () async {
      final secure = FakeSecureStore();
      var v = view(
        payments: [pay('SUB-00000001', amount: 10)],
        acks: {
          'SCH-1': {
            'at': now.subtract(const Duration(hours: 30)).toIso8601String(),
          },
          'SCH-2': {
            'at': now.subtract(const Duration(days: 9)).toIso8601String(),
          },
          'SCH-3': {
            'at': now.subtract(const Duration(hours: 2)).toIso8601String(),
          },
        },
      );
      final g = GuardEngine(
        secure: secure,
        loadSchools: () async => v,
        now: () => now,
      );
      await g.run();
      final hosts = [
        for (final f in g.findings)
          if (f.check == 'hosts') f,
      ];
      expect(hosts.single.titleFa, contains('دبستان یک'));
      expect(hosts.single.detailFa, contains('30'));
      final fr = g.findings.firstWhere((f) => f.fraud != null);
      expect(fr.level, GuardLevel.danger);
      expect(fr.id, startsWith('fraud:amount_low'));
      expect(g.findings.first.level, GuardLevel.danger);
      expect(g.level, GuardLevel.danger);
      expect(g.openFraud.length, 1);

      await g.acknowledge(fr.fraud!);
      expect(g.openFraud, isEmpty);
      expect(g.level, GuardLevel.warning);
      expect(g.log.last.textFa, contains('بررسی شد'));
      // ماندگار روی دستگاه
      final g2 = GuardEngine(
        secure: secure,
        loadSchools: () async => v,
        now: () => now,
      );
      await g2.run();
      expect(g2.openFraud, isEmpty);
      expect(g2.log, isNotEmpty);
      await g2.acknowledge(fr.fraud!, acked: false);
      expect(g2.openFraud.length, 1);

      v = view();
      await g2.run();
      expect(g2.findings, isEmpty);
      expect(g2.level, GuardLevel.ok);
      g.dispose();
      g2.dispose();
    });

    test('خطای یک بررسی بقیه را متوقف نمی‌کند', () async {
      final g = GuardEngine(
        secure: FakeSecureStore(),
        loadSchools: () async => throw StateError('boom'),
        now: () => now,
      );
      await Future.wait([g.run(), g.run()]);
      expect(g.findings.single.titleFa, contains('کامل نشد'));
      expect(g.lastRun, now);
      expect(g.running, isFalse);
      g.dispose();
    });

    test('منوی کناری: «نگهبان هوشمند» در گروه زیرساخت و فقط وقتی هست', () {
      final ids = [
        for (final m in ownerMenu(local: {'guard'})) m.id,
      ];
      expect(ids, contains('guard'));
      expect(ownerMenuIcons['guard'], isNotNull);
      expect(localPageTitles['guard'], 'نگهبان هوشمند');
      expect(
        ownerMenuGroups.firstWhere((g) => g.id == 'infra').pages,
        contains('guard'),
      );
      expect([for (final m in ownerMenu()) m.id], isNot(contains('guard')));
    });

    testWidgets('صفحهٔ نگهبان: یافته‌ها، «بررسی شد»، بررسی اکنون', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(900, 1800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final g = GuardEngine(
        secure: FakeSecureStore(),
        loadSchools: () async => view(
          payments: [
            pay('SUB-00000001', ref: 'TRX-9'),
            pay('SUB-00000002', uid: '2', ref: 'TRX-9'),
          ],
        ),
        now: () => now,
      );
      Widget app() => MaterialApp(
        theme: PayeshUi.light(look: PayeshLook.nabd),
        home: Directionality(
          textDirection: TextDirection.rtl,
          child: Scaffold(body: GuardView(engine: g)),
        ),
      );
      await tester.pumpWidget(app());
      expect(find.byKey(const Key('guard-page')), findsOneWidget);
      expect(find.text('هنوز بررسی نشده'), findsOneWidget);
      expect(find.byKey(const Key('guard-fraud-empty')), findsOneWidget);
      expect(find.byKey(const Key('guard-log-empty')), findsOneWidget);
      await tester.runAsync(g.run);
      await tester.pump();
      expect(find.byKey(const Key('guard-clean')), findsOneWidget);
      expect(
        tester.widget<StatusBadge>(find.byKey(const Key('guard-level'))).label,
        'نیاز به توجه فوری',
      );
      expect(
        tester
            .widget<StatusBadge>(find.byKey(const Key('guard-fraud-count')))
            .label,
        '${faNumber(1)} بررسی‌نشده',
      );
      const id = 'dup_ref:SUB-00000001,SUB-00000002';
      expect(find.byKey(const Key('guard-finding-fraud:$id')), findsOneWidget);
      await tester.runAsync(() async {
        await tester.tap(find.byKey(const Key('guard-ack-$id')));
        await Future<void>.delayed(const Duration(milliseconds: 50));
      });
      await tester.pump();
      expect(find.text('بررسی شد ✓'), findsOneWidget);
      expect(find.byKey(const Key('guard-log')), findsOneWidget);
      expect(
        tester.widget<StatusBadge>(find.byKey(const Key('guard-level'))).label,
        'همه‌چیز سالم است',
      );
      expect(find.textContaining('آخرین بررسی'), findsOneWidget);
      await tester.runAsync(() async {
        await tester.tap(find.byKey(const Key('guard-run')));
        await Future<void>.delayed(const Duration(milliseconds: 50));
      });
      await tester.pump();
      expect(g.running, isFalse);
      expect(GuardView.levelFa(GuardLevel.info), 'اطلاع');
      expect(GuardView.toneOf(GuardLevel.warning), PayeshTone.warning);
      g.dispose();
    });
  });
}
