// Row 177 — change/activity-driven refresh in the owner panel and the «processing control»
// (pause / CPU %) that reaches every system through the sealed infra policy.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/helper/helper_box.dart';
import 'package:payesh_owner/src/infra/infra_policy.dart';
import 'package:payesh_owner/src/local/local_platform.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_owner/src/power/activity.dart';
import 'package:payesh_owner/src/power/processing_card.dart';
import 'package:payesh_owner/src/status/status_lights.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'support/fake_bucket.dart';

void main() {
  group('OwnerActivity + PacedTimer', () {
    late DateTime clock;
    late OwnerActivity a;
    setUp(() {
      clock = DateTime.utc(2026, 11, 24, 10);
      a = OwnerActivity(now: () => clock);
    });

    test(
      'active → normal pace; idle → idleEvery; touch → immediate refresh',
      () {
        var runs = 0;
        final t = PacedTimer.periodic(
          const Duration(seconds: 1),
          () => runs++,
          idleEvery: const Duration(seconds: 10),
          activity: a,
          now: () => clock,
        );
        expect(t.armed, isTrue);
        expect(a.active, isTrue);
        clock = clock.add(const Duration(minutes: 3)); // owner idle
        expect(a.active, isFalse);
        expect(a.idle, isTrue);
        // touch after idle ⇒ notifies ⇒ immediate refresh (more than `every` since the last run)
        a.markInteraction();
        expect(runs, 1);
        expect(t.runs, 1);
        a.markInteraction(); // already active: no extra run, no notification storm
        expect(runs, 1);
        t.cancel();
        expect(t.armed, isFalse);
      },
    );

    testWidgets(
      'hidden ⇒ no timer at all; shown ⇒ re-armed + one catch-up run',
      (tester) async {
        var runs = 0;
        final t = PacedTimer.periodic(
          const Duration(seconds: 1),
          () => runs++,
          activity: a,
          now: () => clock,
        );
        await tester.pump(const Duration(milliseconds: 1100));
        expect(runs, 1);
        a.setVisible(false);
        expect(a.visible, isFalse);
        expect(t.armed, isFalse);
        clock = clock.add(const Duration(seconds: 30));
        await tester.pump(const Duration(seconds: 30));
        expect(runs, 1, reason: 'nothing runs while hidden');
        a.setVisible(true);
        expect(t.armed, isTrue);
        expect(runs, 2, reason: 'one catch-up refresh on return');
        t.cancel();
      },
    );

    testWidgets('background timer keeps going hidden, at the idle pace', (
      tester,
    ) async {
      var runs = 0;
      final t = PacedTimer.periodic(
        const Duration(seconds: 1),
        () => runs++,
        idleEvery: const Duration(seconds: 5),
        background: true,
        activity: a,
        now: () => clock,
      );
      a.setVisible(false);
      expect(t.armed, isTrue);
      for (var i = 0; i < 11; i++) {
        clock = clock.add(const Duration(seconds: 1));
        await tester.pump(const Duration(seconds: 1));
      }
      // re-armed at 5 s while hidden ⇒ 2 runs in 11 s (not 11)
      expect(runs, 2);
      t.cancel();
    });

    testWidgets('heavy work does not run while processing is paused', (
      tester,
    ) async {
      var runs = 0;
      final t = PacedTimer.periodic(
        const Duration(seconds: 1),
        () => runs++,
        heavy: true,
        activity: a,
        now: () => clock,
      );
      a.setProcessingPaused(true);
      a.setProcessingPaused(true);
      expect(a.processingPaused, isTrue);
      clock = clock.add(const Duration(seconds: 3));
      await tester.pump(const Duration(seconds: 3));
      expect(runs, 0);
      a.setProcessingPaused(false);
      clock = clock.add(const Duration(seconds: 1));
      await tester.pump(const Duration(seconds: 1));
      expect(runs, greaterThan(0));
      t.cancel();
    });
  });

  test('row 178: restForCpu / minCpu (same formula as server processing.js restMs)', () {
    const w = Duration(milliseconds: 100);
    expect(restForCpu(w, null), Duration.zero);
    expect(restForCpu(w, 100), Duration.zero);
    expect(restForCpu(w, 25), const Duration(milliseconds: 300));
    expect(restForCpu(w, 50), const Duration(milliseconds: 100));
    expect(restForCpu(const Duration(seconds: 10), 25), maxRest);
    expect(restForCpu(w, 5), restForCpu(w, minCpuPercent), reason: 'clamped');
    expect(restForCpu(Duration.zero, 25), Duration.zero);
    expect(minCpu(null, null), isNull);
    expect(minCpu(40, null), 40);
    expect(minCpu(null, 30), 30);
    expect(minCpu(40, 30), 30);
  });

  test('slotsForCpu: unset ⇒ old default; % of cores within 1..cores', () {
    expect(slotsForCpu(null, 8), 4);
    expect(slotsForCpu(null, 16), 4);
    expect(slotsForCpu(null, 1), 1);
    expect(slotsForCpu(50, 8), 4);
    expect(slotsForCpu(100, 16), 16);
    expect(slotsForCpu(10, 8), 1);
    expect(slotsForCpu(5, 8), 1, reason: 'clamped to the 10 % minimum');
    expect(slotsForCpu(25, 8), 2);
    expect(slotsForCpu(75, 4), 3);
    expect(slotsForCpu(50), greaterThanOrEqualTo(1));
  });

  group('InfraPolicy.proc', () {
    test('default is not written (old envelopes unchanged)', () {
      const p = InfraPolicy(at: 5);
      expect(p.toPlain().containsKey('proc'), isFalse);
      expect(p.procPaused, isFalse);
      expect(p.cpuPercent, isNull);
    });

    test('round trip + validation', () {
      const p = InfraPolicy(at: 7, procPaused: true, cpuPercent: 40);
      final plain = p.toPlain();
      expect(plain['proc'], {'paused': true, 'cpu': 40});
      final back = InfraPolicy.fromPlain(
        (jsonDecode(jsonEncode(plain)) as Map).cast<String, Object?>(),
      );
      expect(back, p);
      expect(back!.hashCode, p.hashCode);
      const pausedOnly = InfraPolicy(at: 8, procPaused: true);
      expect(pausedOnly.toPlain()['proc'], {'paused': true});
      Map<String, Object?> base(Object? proc) => {
        'v': 1,
        'helpers': true,
        'off': <String>[],
        'at': 1,
        'proc': proc,
      };
      expect(InfraPolicy.fromPlain(base({'paused': true, 'cpu': 5})), isNull);
      expect(InfraPolicy.fromPlain(base({'paused': true, 'cpu': 150})), isNull);
      expect(InfraPolicy.fromPlain(base({'paused': 'yes'})), isNull);
      expect(InfraPolicy.fromPlain(base('x')), isNull);
      expect(InfraPolicy.fromPlain(base(null))!.procPaused, isFalse);
      // copyWith: cpu 0 ⇒ remove the cap
      expect(p.copyWith(cpuPercent: 0, at: 9).cpuPercent, isNull);
      expect(p.copyWith(at: 9).cpuPercent, 40);
    });

    test(
      'store: setProcessing seals it for every system; no-op when unchanged',
      () async {
        var clock = DateTime.utc(2026, 11, 24, 10);
        final bucket = FakeBucket(() => clock);
        final s3 = S3Settings(
          endpoint: Uri.https('s3.example.test'),
          accessKey: 'ak',
          secretKey: 'sk-test',
          bucket: 'payesh-madrese',
        );
        final a = InfraPolicyStore(
          secure: FakeSecureStore(),
          transport: bucket.transport,
          now: () => clock,
        )..configure(s3);
        await a.setProcessing(paused: true, cpu: 30);
        expect(a.value.procPaused, isTrue);
        expect(a.value.cpuPercent, 30);
        expect(a.pending, isFalse);
        final plain = await openHelper(
          'sk-test',
          HelperKinds.policy,
          utf8.decode(bucket.objects['payesh/control/infra-policy.json']!),
        );
        expect(plain!['proc'], {'paused': true, 'cpu': 30});
        final at = a.value.at;
        await a.setProcessing(paused: true, cpu: 30);
        expect(a.value.at, at, reason: 'unchanged ⇒ nothing written');
        await a.setProcessing(cpu: 7); // invalid ⇒ ignored
        expect(a.value.cpuPercent, 30);
        clock = clock.add(const Duration(seconds: 1));
        await a.setProcessing(paused: false, cpu: 0);
        expect(a.value.procPaused, isFalse);
        expect(a.value.cpuPercent, isNull);
        // another device follows on its next read
        final b = InfraPolicyStore(
          secure: FakeSecureStore(),
          transport: bucket.transport,
          now: () => clock,
        )..configure(s3);
        await b.refresh();
        expect(b.value, a.value);
        a.dispose();
        b.dispose();
      },
    );
  });

  testWidgets(
    'DbMonitor: hidden ⇒ no probe scheduled; shown ⇒ probes at once',
    (tester) async {
      final a = OwnerActivity();
      var probes = 0;
      final m = DbMonitor(
        probe: () async {
          probes++;
          return const PlatformSync(state: 'synced');
        },
        activity: a,
      )..start(first: const Duration(milliseconds: 10));
      await tester.pump(const Duration(milliseconds: 20));
      expect(probes, 1);
      expect(m.nextIn, m.okEvery);
      a.setVisible(false);
      await m.refresh();
      expect(m.nextIn, isNull, reason: 'hidden: nothing scheduled');
      final before = probes;
      await tester.pump(const Duration(minutes: 3));
      expect(probes, before);
      a.setVisible(true);
      await tester.pump();
      expect(probes, before + 1);
      m.dispose();
    },
  );

  testWidgets('ProcessingCard: pause switch and CPU slider write the policy', (
    tester,
  ) async {
    final clock = DateTime.utc(2026, 11, 24, 10);
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
            secretKey: 'sk-test',
            bucket: 'payesh-madrese',
          ),
        );
    await tester.pumpWidget(
      PayeshMaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: ProcessingCard(policy: store, cores: 8),
          ),
        ),
      ),
    );
    expect(find.text('کنترل پردازش'), findsOneWidget);
    expect(find.byKey(const Key('proc-cpu')), findsNothing);
    expect(find.text('همین سیستم: حداکثر ۴ کار هم‌زمان.'), findsOneWidget);
    await tester.tap(find.byKey(const Key('proc-pause')));
    await tester.pumpAndSettle();
    expect(store.value.procPaused, isTrue);
    expect(find.text('همین سیستم: پردازش متوقف است.'), findsOneWidget);
    await tester.tap(find.byKey(const Key('proc-cpu-on')));
    await tester.pumpAndSettle();
    expect(store.value.cpuPercent, 50);
    expect(find.byKey(const Key('proc-cpu')), findsOneWidget);
    // RTL: the minimum is on the right ⇒ drag far right ⇒ 10 %
    await tester.drag(find.byKey(const Key('proc-cpu')), const Offset(2000, 0));
    await tester.pumpAndSettle();
    expect(store.value.cpuPercent, 10);
    expect(find.byKey(const Key('proc-cpu-value')), findsOneWidget);
    await tester.tap(find.byKey(const Key('proc-pause')));
    await tester.pumpAndSettle();
    expect(find.text('همین سیستم: حداکثر ۱ کار هم‌زمان.'), findsOneWidget);
    await tester.tap(find.byKey(const Key('proc-cpu-on')));
    await tester.pumpAndSettle();
    expect(store.value.cpuPercent, isNull);
    store.dispose();
  });
}
