import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/helper/helper_box.dart';
import 'package:payesh_owner/src/infra/arch_card.dart';
import 'package:payesh_owner/src/infra/infra_policy.dart';
import 'package:payesh_owner/src/infra/load_route.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_owner/src/monitor/net_meter.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'support/fake_bucket.dart';

/// سه حالت معماری و مسیر بار (ردیف ۱۵۳): قرارداد load-route v1 مشترک با server/load-route.js.
void main() {
  final vectors = jsonDecode(
    File('../../../docs/cloud/contracts/load-route-vectors.json')
        .readAsStringSync(),
  ) as Map<String, Object?>;

  TierStats? stats(Object? j) => TierStats.fromJson(j);

  RouteSample sampleOf(Map<String, Object?> s) => RouteSample(
    nowMs: s['now_ms']! as int,
    mode: s['mode']! as String,
    db: stats(s['db'])!,
    ext: stats(s['ext']),
    helpers: s['helpers'] as int?,
  );

  group('قرارداد load-route v1 (همان نتیجهٔ Node)', () {
    test('آستانه‌ها', () {
      expect(vectors['thresholds'], routeThresholds.toJson());
    });

    final scenarios = (vectors['scenarios']! as List)
        .cast<Map<String, Object?>>();
    for (final sc in scenarios) {
      test('سناریو ${sc['name']}', () {
        RouteState? st;
        final steps = (sc['steps']! as List).cast<Map<String, Object?>>();
        for (var i = 0; i < steps.length; i++) {
          final s = steps[i];
          st = routeStep(st, sampleOf(s['sample']! as Map<String, Object?>));
          final e = s['expect']! as Map<String, Object?>;
          expect(
            {...st.toJson(), 'active': st.active},
            e,
            reason: '${sc['name']} گام $i',
          );
        }
      });
    }

    test('p95 و حالت هر سیاست', () {
      for (final x in (vectors['p95']! as List).cast<Map<String, Object?>>()) {
        expect(p95Of((x['values']! as List).cast<int>()), x['p95']);
      }
      for (final x
          in (vectors['policies']! as List).cast<Map<String, Object?>>()) {
        expect(
          modeOfPlain((x['policy'] as Map?)?.cast<String, Object?>()),
          x['mode'],
        );
      }
    });
  });

  test('پنجرهٔ لغزان: p95 فقط موفق‌ها، خطا، در دقیقه، کهنه‌ها، سقف', () {
    final w = LatencyWindow();
    const t0 = 1000000;
    for (var i = 1; i <= 19; i++) {
      w.record(i * 10, ok: true, atMs: t0 + i);
    }
    w.record(5000, ok: false, atMs: t0 + 20);
    var s = w.stats(t0 + 30);
    expect(s.n, 20);
    expect(s.p95, 190);
    expect(s.err, 0.05);
    expect(s.avg, 100);
    expect(s.perMin, 20);
    s = w.stats(t0 + 60015);
    expect(s.n, 6);
    final big = LatencyWindow();
    for (var i = 0; i < 250; i++) {
      big.record(1, ok: true, atMs: t0);
    }
    expect(big.stats(t0).n, 200);
    expect(LatencyWindow().stats(t0).p95, 0);
  });

  test('NetMeter: درخواست‌های کوچک و خطاها در پنجره، انتقال بزرگ نه', () {
    NetMeter.reset();
    final at = DateTime.now();
    NetMeter.record(NetMeter.db, received: 100, elapsedMs: 80, at: at);
    NetMeter.record(NetMeter.db, received: 1 << 20, elapsedMs: 9000, at: at);
    NetMeter.record(NetMeter.db, elapsedMs: 0, ok: false, at: at);
    final s = NetMeter.of(NetMeter.db).window.stats(at.millisecondsSinceEpoch);
    expect(s.n, 2);
    expect(s.p95, 80);
    expect(s.err, 0.5);
    NetMeter.reset();
  });

  group('سیاست زیرساخت: حالت، سرور بیرونی، کلید هر سیستم کمکی', () {
    test('fromPlain / toPlain و سازگاری با سیاست قدیمی', () {
      final old = InfraPolicy.fromPlain({
        'v': 1,
        'helpers': false,
        'off': <String>[],
        'at': 3,
      })!;
      expect(old.mode, ArchModes.db);
      expect(old.helpers, isFalse);
      final p = InfraPolicy.fromPlain({
        'v': 1,
        'helpers': true,
        'mode': 'external',
        'external': 'https://ext.example.ir',
        'off': ['helper:00aa00aa00aa00aa'],
        'at': 9,
      })!;
      expect(p.mode, ArchModes.external);
      expect(p.helperOn('00aa00aa00aa00aa'), isFalse);
      expect(p.helperOn('11bb11bb11bb11bb'), isTrue);
      expect(p.toPlain()['helpers'], isTrue);
      expect(InfraPolicy.fromPlain(p.toPlain()), p);
      const db = InfraPolicy(mode: ArchModes.db);
      expect(db.toPlain()['helpers'], isFalse);
      for (final bad in <Map<String, Object?>>[
        {'v': 1, 'helpers': true, 'mode': 'cloud', 'off': <String>[], 'at': 1},
        {'v': 1, 'helpers': true, 'external': 7, 'off': <String>[], 'at': 1},
        {
          'v': 1,
          'helpers': true,
          'external': 'ftp://x.ir',
          'off': <String>[],
          'at': 1,
        },
      ]) {
        expect(InfraPolicy.fromPlain(bad), isNull, reason: '$bad');
      }
      expect(validExternalUrl(''), isTrue);
      expect(validExternalUrl('https://a.ir/x'), isTrue);
      expect(validExternalUrl('https://a.ir/?q=1'), isFalse);
      expect(validExternalUrl('https://u:p@a.ir'), isFalse);
      expect(validExternalUrl('a.ir'), isFalse);
    });

    test(
      'ذخیره در دیتابیس و خواندن سرور مدرسه (helpers همیشه هم‌خوان)',
      () async {
        var clock = DateTime.utc(2026, 11, 13, 10);
        final bucket = FakeBucket(() => clock);
        final s3 = S3Settings(
          endpoint: Uri.https('s3.example.test'),
          accessKey: 'ak',
          secretKey: 'sk-route-1',
          bucket: 'payesh-madrese',
        );
        final a = InfraPolicyStore(
          secure: FakeSecureStore(),
          transport: bucket.transport,
          now: () => clock,
        )..configure(s3);
        await a.setMode(ArchModes.external);
        clock = clock.add(const Duration(seconds: 1));
        expect(await a.setExternal('not a url'), isFalse);
        expect(await a.setExternal(' https://ext.example.ir '), isTrue);
        await a.setHelperOn('00aa00aa00aa00aa', false);
        expect(a.pending, isFalse);
        final plain = await openHelper(
          'sk-route-1',
          HelperKinds.policy,
          bucket.text('payesh/control/infra-policy.json')!,
        );
        expect(plain!['mode'], 'external');
        expect(plain['helpers'], true);
        expect(plain['external'], 'https://ext.example.ir');
        expect(plain['off'], ['helper:00aa00aa00aa00aa']);
        await a.setHelpers(false);
        expect(a.value.mode, ArchModes.db);
        await a.setHelpers(true);
        expect(a.value.mode, ArchModes.helpers);
        a.dispose();
      },
    );
  });

  group('LoadRouter (مسیر بار همین پنل)', () {
    late DateTime clock;
    setUp(() {
      NetMeter.reset();
      clock = DateTime.utc(2026, 11, 13, 10);
    });
    tearDown(NetMeter.reset);

    void slow(int ms, {int n = 10}) {
      for (var i = 0; i < n; i++) {
        NetMeter.record(NetMeter.db, received: 10, elapsedMs: ms, at: clock);
      }
    }

    test('دیتابیس کند ⇒ سیستم‌های کمکی؛ «فقط دیتابیس» ⇒ هرگز', () async {
      var mode = ArchModes.helpers;
      final r = LoadRouter(
        policy: () => (mode: mode, external: ''),
        helpersOnline: () async => 2,
        now: () => clock,
      );
      slow(2000);
      await r.tick();
      expect(r.state.helpersActive, isTrue);
      expect(r.helpers, 2);
      expect(r.db.p95, 2000);
      mode = ArchModes.db;
      await r.tick();
      expect(r.state.active, ['db']);
      expect(r.state.reason, 'mode');
      r.dispose();
    });

    test('سرور بیرونی: در دسترس ⇒ اصلی؛ قطع ⇒ زنجیرهٔ دیتابیس', () async {
      var up = true;
      final probes = <Uri>[];
      final r = LoadRouter(
        policy: () => (mode: ArchModes.external, external: 'https://ext.ir/'),
        probe: (u) async {
          probes.add(u);
          return (ok: up, ms: 120);
        },
        now: () => clock,
      );
      await r.tick();
      expect(probes.single.toString(), 'https://ext.ir/healthz');
      expect(r.state.primary, 'external');
      expect(r.external!.ok, isTrue);
      clock = clock.add(const Duration(seconds: 10));
      await r.tick();
      expect(probes, hasLength(1), reason: 'نتیجه ۳۰ ثانیه نگه داشته می‌شود');
      up = false;
      clock = clock.add(const Duration(seconds: 30));
      await r.tick();
      expect(r.state.chain, ['db', 'helpers']);
      expect(r.state.reason, 'external_down');
      r.dispose();
    });
  });

  group('رابط', () {
    Future<void> pump(WidgetTester tester, Widget child) async {
      tester.view.physicalSize = const Size(900, 1800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: PayeshUi.light(),
          home: Directionality(
            textDirection: TextDirection.rtl,
            child: Scaffold(body: SingleChildScrollView(child: child)),
          ),
        ),
      );
      await tester.pump();
    }

    testWidgets('کارت «حالت معماری»: تعویض حالت، نشانی بیرونی، مسیر زنده', (
      tester,
    ) async {
      NetMeter.reset();
      final clock = DateTime.utc(2026, 11, 13, 10);
      final bucket = FakeBucket(() => clock);
      final store =
          InfraPolicyStore(
            secure: FakeSecureStore(),
            transport: bucket.transport,
            now: () => clock,
          )..configure(
            S3Settings(
              endpoint: Uri.https('s3.example.test'),
              accessKey: 'ak',
              secretKey: 'sk-route-2',
              bucket: 'payesh-madrese',
            ),
          );
      final router = LoadRouter(
        policy: () => (mode: store.value.mode, external: store.value.external),
        now: () => clock,
      );
      await tester.runAsync(router.tick);
      await pump(tester, ArchCard(policy: store, router: router));
      expect(find.byKey(const Key('arch-card')), findsOneWidget);
      expect(find.byKey(const Key('route-tier-db')), findsOneWidget);
      expect(find.byKey(const Key('route-tier-helpers')), findsOneWidget);
      expect(find.byKey(const Key('arch-thresholds')), findsOneWidget);
      final helpersTile = tester.widget<ListTile>(
        find.byKey(const Key('arch-mode-helpers')),
      );
      expect(helpersTile.selected, isTrue);

      await tester.runAsync(() async {
        await tester.tap(find.byKey(const Key('arch-mode-db')));
        await Future<void>.delayed(const Duration(milliseconds: 50));
      });
      await tester.pump();
      expect(store.value.mode, ArchModes.db);
      await tester.runAsync(router.tick);
      await tester.pump();
      expect(find.byKey(const Key('route-tier-helpers')), findsNothing);

      await tester.enterText(find.byKey(const Key('arch-external')), 'bad');
      await tester.runAsync(() async {
        await tester.tap(find.byKey(const Key('arch-external-save')));
        await Future<void>.delayed(const Duration(milliseconds: 50));
      });
      await tester.pump();
      expect(find.textContaining('نشانی درست نیست'), findsOneWidget);
      await tester.enterText(
        find.byKey(const Key('arch-external')),
        'https://ext.example.ir',
      );
      await tester.runAsync(() async {
        await tester.tap(find.byKey(const Key('arch-external-save')));
        await Future<void>.delayed(const Duration(milliseconds: 50));
      });
      await tester.pump();
      expect(store.value.external, 'https://ext.example.ir');
      expect(find.text('نشانی ذخیره شد.'), findsOneWidget);
      router.dispose();
      store.dispose();
    });

    testWidgets('کارت «بار لحظه‌ای»: عددهای واقعی و زنجیره', (tester) async {
      NetMeter.reset();
      final clock = DateTime.now();
      for (var i = 0; i < 10; i++) {
        NetMeter.record(NetMeter.db, received: 10, elapsedMs: 1500, at: clock);
      }
      final router = LoadRouter(
        policy: () => (mode: ArchModes.helpers, external: ''),
        now: () => clock,
      );
      await tester.runAsync(router.tick);
      await pump(tester, LoadCard(router: router));
      expect(find.byKey(const Key('load-card')), findsOneWidget);
      expect(find.text('${faNumber(1500)} میلی‌ثانیه'), findsNWidgets(2));
      expect(find.text('۱۰'), findsOneWidget);
      final mode = tester.widget<StatusBadge>(
        find.byKey(const Key('load-mode')),
      );
      expect(mode.label, archModeTitles[ArchModes.helpers]);
      final helpers = tester.widget<StatusBadge>(
        find.byKey(const Key('route-tier-helpers')),
      );
      expect(helpers.label, 'سیستم‌های کمکی');
      expect(helpers.tone, PayeshTone.warning);
      expect(find.textContaining('پلهٔ بعد به کمک آمد'), findsOneWidget);
      router.dispose();
      NetMeter.reset();
    });
  });
}
