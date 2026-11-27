// Row 198-U4 — «بار لحظه‌ای» showed p95 ≈ 17.6 s while the database answered in 59–275 ms, and
// «پردازش کمکی» looked dead (done 0, «کل سیستم ۲٫۷٪» while Task Manager showed ~40%).
//  * large UPLOADS (backups) were timed with their upload body and landed in p95; now the
//    window holds connect + wait-for-headers only (transport latency), transfer is throughput;
//  * Task Manager (Win8+) shows «% Processor Utility», not GetSystemTimes «% Processor Time»;
//  * the owner panel's own background work (capacity scan) runs as a job of this system's
//    processing: counted in «انجام‌شده», skipped while «توقف».
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_core/io.dart';
import 'package:payesh_owner/src/helper/helper_node.dart';
import 'package:payesh_owner/src/helper/helper_service.dart';
import 'package:payesh_owner/src/helper/host_cpu.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_owner/src/monitor/net_meter.dart';
import 'package:payesh_secure/payesh_secure.dart';

import 'support/fake_bucket.dart';

void main() {
  group('U4 response time = server latency, not transfer time', () {
    setUp(NetMeter.reset);
    tearDown(NetMeter.reset);
    final at = DateTime.utc(2026, 11, 27, 9);
    final nowMs = at.millisecondsSinceEpoch;

    test(
      'L198-01 backup upload of 6 MB taking 17.6 s: p95 is the 180 ms server '
      'latency; upload speed is kept as throughput',
      () {
        for (var i = 0; i < 40; i++) {
          NetMeter.record(
            NetMeter.db,
            sent: 400,
            received: 900,
            elapsedMs: 120 + i,
            latencyMs: 120 + i,
            at: at,
          );
        }
        for (var i = 0; i < 3; i++) {
          NetMeter.record(
            NetMeter.db,
            sent: 6 << 20,
            received: 300,
            elapsedMs: 17653,
            latencyMs: 180,
            what: 'PUT payesh-owner-backup',
            at: at,
          );
        }
        final w = NetMeter.of(NetMeter.db).window.stats(nowMs);
        expect(w.n, 43);
        expect(w.p95, lessThan(500));
        expect(NetMeter.of(NetMeter.db).upBps, closeTo((6 << 20) / 17.653, 1));
        // the slow transfer is still visible in the diagnostics
        expect(
          NetMeter.of(NetMeter.db).slow.first.what,
          'PUT payesh-owner-backup',
        );
        expect(NetMeter.of(NetMeter.db).slow.length, 3);
      },
    );

    test('L198-02 without transport latency (fakes) a big upload is excluded like a '
        'big download; small requests still count', () {
      NetMeter.record(NetMeter.db, sent: 6 << 20, elapsedMs: 17000, at: at);
      NetMeter.record(NetMeter.db, received: 1 << 20, elapsedMs: 9000, at: at);
      NetMeter.record(NetMeter.db, sent: 300, elapsedMs: 90, at: at);
      final w = NetMeter.of(NetMeter.db).window.stats(nowMs);
      expect(w.n, 1);
      expect(w.p95, 90);
      // failures always count (as errors)
      NetMeter.record(
        NetMeter.db,
        sent: 6 << 20,
        elapsedMs: 0,
        ok: false,
        at: at,
      );
      expect(NetMeter.of(NetMeter.db).window.stats(nowMs).err, 0.5);
    });

    test('L198-03 path classes carry no ids/keys; diag file is written at most once a '
        'minute with p95, slow list, loop lag and extra metrics', () {
      expect(
        NetMeter.pathClass('/payesh-madrese/payesh/outbox/s-1/x.json'),
        'payesh/outbox',
      );
      expect(
        NetMeter.pathClass(
          '/payesh-madrese/payesh-owner-backup/2026-11-27.zip',
        ),
        'payesh-owner-backup',
      );
      expect(NetMeter.pathClass('/payesh-madrese'), '/');
      final dir = Directory.systemTemp.createTempSync('diag198');
      addTearDown(() {
        NetMeter.diagDir = null;
        NetMeter.diagExtra = null;
        dir.deleteSync(recursive: true);
      });
      NetMeter.diagDir = dir.path;
      NetMeter.record(
        NetMeter.db,
        sent: 300,
        elapsedMs: 2500,
        latencyMs: 2500,
        what: 'GET payesh/outbox',
        at: at,
      );
      NetMeter.maybeWriteDiag(
        nowMs,
        extra: {
          'cpu': {'system_pct': 41.5},
        },
      );
      final f = File('${dir.path}/diag/load.json');
      final j = jsonDecode(f.readAsStringSync()) as Map<String, Object?>;
      expect((j['db']! as Map)['p95_ms'], 2500);
      expect(((j['slow']! as List).single as Map)['what'], 'GET payesh/outbox');
      expect((j['cpu']! as Map)['system_pct'], 41.5);
      expect(j.containsKey('loop_lag_ms'), isTrue);
      expect(f.readAsStringSync(), isNot(contains('sk-')));
      f.deleteSync();
      NetMeter.maybeWriteDiag(nowMs + 30000);
      expect(f.existsSync(), isFalse);
      NetMeter.maybeWriteDiag(nowMs + 61000);
      expect(f.existsSync(), isTrue);
    });
  });

  group('U4 CPU numbers = Task Manager', () {
    test('L198-04 utility reader wins (Task Manager), scale = utility/time; the app '
        'figure is scaled the same way and never exceeds the system', () {
      var idle = 0, total = 0;
      final util = <double?>[null, 40.0, 30.0];
      var i = 0;
      final m = HostCpuMeter(
        read: () {
          // 5% busy by GetSystemTimes each step
          idle += 95;
          total += 100;
          return (idle: idle, total: total);
        },
        utility: () => util[i++],
      );
      // first: no time delta, no utility yet
      expect(m.sample(), isNull);
      expect(m.sample(), 40.0);
      expect(m.utilityBased, isTrue);
      expect(m.scale, closeTo(8.0, 0.01));
      expect(m.asTaskManager(0.5), closeTo(4.0, 0.01));
      expect(m.asTaskManager(20), 40.0);
      expect(m.sample(), 30.0);
      expect(m.scale, closeTo(6.0, 0.01));
      expect(m.asTaskManager(null), isNull);
    });

    test('L198-05 no utility counter (Windows 7 / Linux / Android) ⇒ time-based, scale 1', () {
      final seq = [(idle: 0, total: 0), (idle: 50, total: 100)];
      var i = 0;
      final m = HostCpuMeter(read: () => seq[i++]);
      expect(m.sample(), isNull);
      expect(m.sample(), 50);
      expect(m.utilityBased, isFalse);
      expect(m.scale, 1);
      expect(m.asTaskManager(3), 3);
    });
  });

  group('U4 «پردازش کمکی» really works', () {
    final t0 = DateTime.utc(2026, 11, 27, 9);

    Future<OwnerHelperService> make() async {
      final secure = FakeSecureStore();
      final bucket = FakeBucket(() => t0);
      await S3Settings(
        endpoint: Uri.https('s3.example.test'),
        accessKey: 'ak',
        secretKey: 'sk-198',
        bucket: 'payesh-madrese',
      ).save(secure);
      final svc = OwnerHelperService(
        secure: secure,
        transport: bucket.transport,
        now: () => t0,
        sleep: (_) async {},
        autoStart: false,
      );
      await svc.init();
      return svc;
    }

    test('L198-06 background work runs as a job of this system: «انجام‌شده» rises and '
        'the job is listed; «توقف» ⇒ not run; failures counted', () async {
      final svc = await make();
      final node = svc.node!;
      expect(node.doneTotal, 0);
      var runs = 0;
      expect(
        await svc.runLocalJob('storage.usage', () async => runs++),
        isTrue,
      );
      expect(runs, 1);
      expect(node.doneTotal, 1);
      expect(node.recent.first.kind, 'storage.usage');
      expect(node.activity.first.text, contains('محاسبهٔ مصرف فضای دیتابیس'));
      await svc.setPaused(true);
      expect(
        await svc.runLocalJob('storage.usage', () async => runs++),
        isFalse,
      );
      expect(runs, 1);
      await svc.setPaused(false);
      expect(
        await svc.runLocalJob(
          'storage.usage',
          () async => throw StateError('x'),
        ),
        isTrue,
      );
      expect(node.failed, 1);
      expect(node.doneTotal, 1);
      await svc.dispose();
    });

    test(
      'L198-07 a submitted job executed locally counts in «انجام‌شده»',
      () async {
        final svc = await make();
        final r = await svc.submit('storage.usage');
        expect(r.ok, isTrue);
        expect(r.by, 'local');
        expect(svc.node!.doneTotal, 1);
        svc.node!.noteSubmitted(
          'bucket.gc',
          const JobOutcome(ok: true, by: 'h-other'),
        );
        expect(svc.node!.doneTotal, 1, reason: 'done by another helper');
        await svc.dispose();
      },
    );
  });
}
