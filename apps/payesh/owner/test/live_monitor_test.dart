import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/local/local_platform.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_owner/src/monitor/live_monitor.dart';
import 'package:payesh_owner/src/monitor/live_panel.dart';
import 'package:payesh_owner/src/monitor/net_meter.dart';
import 'package:payesh_owner/src/net/resilience.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'support/fake_bucket.dart';

/// ردیف ۱۳۰: پایش زندهٔ زیرساخت در داشبورد — سرعت، ترافیک، درصد استفاده از ظرفیت.
void main() {
  final t0 = DateTime.utc(2026, 11, 13, 12);
  final settings = S3Settings(
    endpoint: Uri.https('s3.example.test'),
    accessKey: 'ak',
    secretKey: 'sk',
    bucket: 'payesh-madrese',
  );

  setUp(() {
    NetMeter.reset();
    EndpointRoutes.reset();
    s3RetryPolicy = RetryPolicy.none;
  });
  tearDown(() => s3RetryPolicy = const RetryPolicy());

  group('شمارش ترافیک واقعی', () {
    test(
      'هر درخواست S3: بایت ارسال/دریافت، تأخیر (کوچک) و سرعت دانلود (بزرگ)',
      () async {
        final b = FakeBucket(() => t0)..putText('big.bin', 'z' * 40000);
        final t = b.transport();
        await s3PutBytes(settings, t, 'a.txt', List.filled(1000, 65));
        var c = NetMeter.of(NetMeter.db);
        expect(c.requests, 1);
        expect(c.sent, greaterThan(1000));
        expect(c.latencyMs, isNotNull);
        expect(c.downBps, isNull);
        await s3GetBytes(settings, t, 'big.bin');
        c = NetMeter.of(NetMeter.db);
        expect(c.requests, 2);
        expect(c.received, greaterThan(40000));
        // پاسخ بزرگ ⇒ سرعت انتقال، نه تأخیر
        expect(c.errors, 0);
      },
    );

    test('خطای شبکه شمرده می‌شود', () async {
      final b = FakeBucket(() => t0)..down = true;
      await expectLater(
        s3GetBytes(settings, b.transport(), 'x'),
        throwsA(isA<S3Failure>()),
      );
      final c = NetMeter.of(NetMeter.db);
      expect(c.lastOk, isFalse);
      expect(c.errors, 1);
    });

    test('سرآیند درخواست اندازهٔ معقول دارد', () {
      final n = requestHeadBytes('GET', Uri.parse('https://h/b/k?x=1'), {
        'host': 'h',
        'authorization': 'a' * 100,
      });
      expect(n, inInclusiveRange(120, 200));
    });
  });

  group('Prometheus', () {
    test('جمع روی برچسب‌ها؛ توضیح و خط خراب نادیده', () {
      final v = parsePrometheus('''
# HELP payesh_http_requests_total x
# TYPE payesh_http_requests_total counter
payesh_http_requests_total{class="2xx"} 10
payesh_http_requests_total{class="5xx"} 2
payesh_cpu_usage_pct 37.5
broken line here
payesh_bad NaN
payesh_disk_free_pct 60 1700000000
''');
      expect(v['payesh_http_requests_total'], 12);
      expect(v['payesh_cpu_usage_pct'], 37.5);
      expect(v['payesh_disk_free_pct'], 60);
      expect(v.containsKey('payesh_bad'), isFalse);
      expect(v.containsKey('broken'), isFalse);
    });
  });

  group('پایش دیتابیس', () {
    test('ترافیک لحظه‌ای از اختلاف شمارنده‌ها در هر ثانیه', () async {
      var now = t0;
      final b = FakeBucket(() => now);
      final m = LiveMonitor(
        db: DbSource(
          settings: () async => settings,
          transport: b.transport,
          store: FakeSecureStore(),
        ),
        now: () => now,
      );
      m.tick();
      NetMeter.record(NetMeter.db, sent: 2000, received: 6000, elapsedMs: 40);
      now = now.add(const Duration(seconds: 2));
      m.tick();
      final db = m.items.single;
      expect(db.kind, 'db');
      expect(db.txBps, closeTo(1000, 0.01));
      expect(db.rxBps, closeTo(3000, 0.01));
      expect(db.rx.values.last, closeTo(3000, 0.01));
      expect(db.rxTotal, greaterThanOrEqualTo(6000));
      m.dispose();
    });

    test('سنجش: وصل ⇒ سبز با تأخیر؛ قطع ⇒ قرمز با پیام فارسی', () async {
      final b = FakeBucket(() => t0);
      final m = LiveMonitor(
        db: DbSource(settings: () async => settings, transport: b.transport),
        now: () => t0,
      );
      await m.probeNow();
      final db = m.items.single;
      expect(db.up, isTrue);
      expect(db.latencyMs, isNotNull);
      expect(db.detail, 'payesh-madrese');
      expect(db.latency.values, hasLength(1));
      b.down = true;
      await m.probeNow();
      expect(db.up, isFalse);
      expect(db.error, isNotEmpty);
      m.dispose();
    });

    test('تنظیم نشده ⇒ خاکستری بدون سنجش', () async {
      final m = LiveMonitor(
        db: DbSource(
          settings: () async => null,
          transport: FakeBucket(() => t0).transport,
        ),
        now: () => t0,
      );
      await m.probeNow();
      expect(m.items.single.up, isNull);
      expect(m.items.single.error, 'تنظیم نشده');
      m.dispose();
    });

    test(
      'درصد استفاده از ظرفیت = مجموع فایل‌ها / ظرفیت مالک (ماندگار)',
      () async {
        final b = FakeBucket(() => t0)
          ..putText('a', 'x' * 3000)
          ..putText('p/b', 'y' * 1000);
        final store = FakeSecureStore();
        final m = LiveMonitor(
          db: DbSource(
            settings: () async => settings,
            transport: b.transport,
            store: store,
          ),
          now: () => t0,
        );
        await m.probeNow();
        await m.scanCapacity();
        var cap = m.items.single.capacity.single;
        expect(cap.pct, isNull);
        expect(cap.text, contains('ظرفیت تعیین نشده'));
        expect(cap.text, contains('2 فایل'));
        expect(cap.editable, isTrue);
        await m.setDbCapacity(8000);
        cap = m.items.single.capacity.single;
        expect(cap.pct, closeTo(50, 0.01));
        expect(await store.read(dbCapacityKey), '8000');
        m.dispose();

        // دستگاه همان ظرفیت را بعد از باز شدن دوباره می‌خواند
        final m2 = LiveMonitor(
          db: DbSource(
            settings: () async => settings,
            transport: b.transport,
            store: store,
          ),
          now: () => t0,
        );
        await m2.probeNow();
        await m2.scanCapacity();
        expect(m2.capacityBytes, 8000);
        expect(m2.items.single.capacity.single.pct, closeTo(50, 0.01));
        await m2.setDbCapacity(null);
        expect(await store.read(dbCapacityKey), isNull);
        m2.dispose();
      },
    );

    test('بیش از سقف صفحه‌ها ⇒ «≥» (کمینه)', () async {
      final b = FakeBucket(() => t0);
      for (var i = 0; i < 1005; i++) {
        b.putText('k$i', 'v');
      }
      final m = LiveMonitor(
        db: DbSource(settings: () async => settings, transport: b.transport),
        now: () => t0,
        capacityPages: 1,
      );
      await m.probeNow();
      await m.scanCapacity();
      expect(m.items.single.capacity.single.text, startsWith('≥ '));
      m.dispose();
    });
  });

  group('پایش سرورها', () {
    Map<String, Object?> infra({List<Map<String, Object?>>? endpoints}) => {
      'services': [
        {
          'id': 's1',
          'name': 'Gateway',
          'metrics': {
            'usage_memory': {'value': 3, 'unit': 'gb', 'label': 'M'},
            'capacity_memory': {'value': 4, 'unit': 'gb', 'label': 'E'},
            'usage_cpu': {'value': 20, 'unit': 'percent', 'label': 'M'},
          },
        },
      ],
      'endpoints':
          endpoints ??
          [
            {
              'id': 'e1',
              'service_id': 's1',
              'url': 'https://gw.example.ir/metrics',
              'check_kind': 'http',
              'enabled': true,
            },
            {
              'id': 'e2',
              'service_id': 's1',
              'url': 'https://gw.example.ir/readyz',
              'check_kind': 'http',
              'enabled': true,
            },
          ],
    };

    test(
      '/metrics ⇒ ترافیک و درخواست در ثانیه + CPU/حافظه/دیسک واقعی',
      () async {
        var now = t0;
        var n = 0;
        final m = LiveMonitor(
          now: () => now,
          checker: (_) async => const CheckOutcome(ok: true, latencyMs: 30),
          fetcher: (u) async {
            n++;
            expect(u.path, '/metrics');
            return MetricsScrape(
              latencyMs: 12,
              values: {
                'payesh_net_rx_bytes_total': n * 10000,
                'payesh_net_tx_bytes_total': n * 50000,
                'payesh_http_requests_total': n * 25,
                'payesh_cpu_usage_pct': 41,
                'payesh_memory_used_pct': 63,
                'payesh_disk_free_pct': 5,
              },
            );
          },
        )..setInfra(infra());
        await m.probeNow();
        now = now.add(const Duration(seconds: 5));
        await m.probeNow();
        final s = m.items.single;
        expect(s.kind, 'service');
        expect(s.name, 'Gateway');
        expect(s.detail, 'gw.example.ir');
        expect(s.up, isTrue);
        expect(s.latencyMs, 12);
        expect(s.rxBps, closeTo(2000, 0.01));
        expect(s.txBps, closeTo(10000, 0.01));
        expect(s.reqPs, closeTo(5, 0.01));
        expect(s.txTotal, 100000);
        expect(
          {for (final c in s.capacity) c.label: c.pct},
          {'پردازنده': 41, 'حافظه': 63, 'دیسک': 95},
        );
        m.tick();
        expect(s.tx.values.last, closeTo(10000, 0.01));
        m.dispose();
      },
    );

    test('سرور دوباره روشن شد (شمارنده صفر شد) ⇒ نرخ منفی نمی‌شود', () async {
      var now = t0;
      final seq = [100000.0, 4000.0];
      var i = 0;
      final m = LiveMonitor(
        now: () => now,
        checker: (_) async => const CheckOutcome(ok: true, latencyMs: 1),
        fetcher: (_) async => MetricsScrape(
          latencyMs: 1,
          values: {
            'payesh_net_rx_bytes_total': seq[i],
            'payesh_net_tx_bytes_total': seq[i++],
          },
        ),
      )..setInfra(infra());
      await m.probeNow();
      now = now.add(const Duration(seconds: 2));
      await m.probeNow();
      expect(m.items.single.rxBps, closeTo(2000, 0.01));
      m.dispose();
    });

    test(
      'بدون /metrics ⇒ ترافیک نامعلوم؛ ظرفیت از عددهای دستی [M]/[E]',
      () async {
        final m =
            LiveMonitor(
              now: () => t0,
              checker: (e) async => const CheckOutcome(ok: true, latencyMs: 80),
              fetcher: (_) async => throw StateError('no'),
            )..setInfra(
              infra(
                endpoints: [
                  {
                    'id': 'e2',
                    'service_id': 's1',
                    'url': 'tcp://gw.example.ir:443',
                    'check_kind': 'tcp',
                    'enabled': true,
                  },
                ],
              ),
            );
        await m.probeNow();
        final s = m.items.single;
        expect(s.up, isTrue);
        expect(s.latencyMs, 80);
        expect(s.hasTraffic, isFalse);
        final caps = {for (final c in s.capacity) c.label: c};
        expect(caps['حافظه']!.pct, closeTo(75, 0.01));
        expect(caps['حافظه']!.estimated, isTrue);
        expect(caps['پردازنده']!.pct, 20);
        expect(caps['پردازنده']!.estimated, isFalse);
        m.dispose();
      },
    );

    test(
      'یک Endpoint از دو قطع ⇒ وضعیت نامعلوم با پیام؛ همه قطع ⇒ قرمز',
      () async {
        var metricsUp = true;
        final m = LiveMonitor(
          now: () => t0,
          checker: (e) async =>
              const CheckOutcome(ok: false, errorCode: 'connect_failed'),
          fetcher: (_) async {
            if (!metricsUp) throw StateError('down');
            return const MetricsScrape(latencyMs: 9, values: {});
          },
        )..setInfra(infra());
        await m.probeNow();
        final s = m.items.single;
        expect(s.up, isNull);
        expect(s.error, contains('Endpoint'));
        metricsUp = false;
        await m.probeNow();
        expect(s.up, isFalse);
        expect(s.error, 'در دسترس نیست');
        m.dispose();
      },
    );

    test(
      'سرویس حذف‌شده از فهرست حذف می‌شود؛ Endpoint غیرفعال سنجیده نمی‌شود',
      () async {
        var checks = 0;
        final m =
            LiveMonitor(
              now: () => t0,
              checker: (_) async {
                checks++;
                return const CheckOutcome(ok: true, latencyMs: 1);
              },
            )..setInfra(
              infra(
                endpoints: [
                  {
                    'id': 'e9',
                    'service_id': 's1',
                    'url': 'https://x.example.ir/',
                    'enabled': false,
                  },
                ],
              ),
            );
        await m.probeNow();
        expect(checks, 0);
        expect(m.items.single.error, 'Endpoint ندارد');
        m.setInfra(const {'services': [], 'endpoints': []});
        expect(m.items, isEmpty);
        m.dispose();
      },
    );
  });

  test('قالب اندازه و سرعت', () {
    expect(bytesText(512), '512 بایت');
    expect(bytesText(1536), '1.5 کیلوبایت');
    expect(bytesText(5 * 1024 * 1024), '5 مگابایت');
    expect(bytesText(300 * 1024 * 1024 * 1024), '300 گیگابایت');
    expect(rateText(2048), '2 کیلوبایت/ث');
    expect(rateText(null), '—');
  });

  testWidgets(
    'داشبورد: کارت زنده با سرعت، ترافیک، نمودار و درصد ظرفیت؛ لمس ⇒ تعیین ظرفیت',
    (tester) async {
      tester.view.physicalSize = const Size(1300, 1400);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final b = FakeBucket(() => t0)..putText('a', 'x' * 4096);
      final store = FakeSecureStore();
      var now = t0;
      final m =
          LiveMonitor(
            db: DbSource(
              settings: () async => settings,
              transport: b.transport,
              store: store,
            ),
            now: () => now,
            fetcher: (_) async => const MetricsScrape(
              latencyMs: 7,
              values: {
                'payesh_net_rx_bytes_total': 1000,
                'payesh_net_tx_bytes_total': 2000,
                'payesh_cpu_usage_pct': 12,
              },
            ),
          )..setInfra({
            'services': [
              {'id': 's1', 'name': 'سرور مدرسه'},
            ],
            'endpoints': [
              {
                'id': 'e1',
                'service_id': 's1',
                'url': 'https://school.example.ir/metrics',
                'enabled': true,
              },
            ],
          });
      await tester.pumpWidget(
        PayeshMaterialApp(
          title: 't',
          themeMode: ThemeMode.light,
          home: Scaffold(
            body: SingleChildScrollView(child: LiveInfraPanel(monitor: m)),
          ),
        ),
      );
      await tester.pump();
      await m.scanCapacity();
      for (var i = 0; i < 3; i++) {
        now = now.add(const Duration(seconds: 1));
        await tester.pump(const Duration(seconds: 1));
      }
      expect(m.running, isTrue);
      expect(find.text('پایش زنده زیرساخت'), findsOneWidget);
      expect(find.text('زنده'), findsOneWidget);
      expect(find.byKey(const Key('live-db')), findsOneWidget);
      expect(find.byKey(const Key('live-s1')), findsOneWidget);
      expect(find.byKey(const Key('live-db-chart')), findsOneWidget);
      expect(find.text('سرور مدرسه'), findsOneWidget);
      // سرعت با ارقام فارسی
      expect(
        find.descendant(
          of: find.byKey(const Key('live-s1-speed')),
          matching: find.text('۷ ms'),
        ),
        findsOneWidget,
      );
      expect(find.textContaining('پردازنده'), findsOneWidget);
      expect(find.text('۱۲.۰٪'), findsOneWidget);
      expect(find.textContaining('ظرفیت تعیین نشده'), findsOneWidget);

      await tester.tap(find.byKey(const Key('live-db-cap-فضای دیتابیس')));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('db-capacity-input')), '۱');
      await tester.tap(find.byKey(const Key('db-capacity-save')));
      await tester.pumpAndSettle();
      expect(await store.read(dbCapacityKey), '${1 << 30}');
      expect(find.textContaining('از ۱ گیگابایت'), findsOneWidget);

      await tester.pumpWidget(const SizedBox());
      expect(m.running, isFalse);
      m.dispose();
    },
  );
}
