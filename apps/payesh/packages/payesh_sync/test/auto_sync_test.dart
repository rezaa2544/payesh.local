// Row 119 — AutoSync (automatic queue runner) unit tests. No server: a scripted fake Gateway.
// Real short timers + seeded Random → deterministic; every property has a mutant noted inline
// that turns the test red (see docs/cloud/119-offline.md §negative controls).
import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:payesh_sync/payesh_sync.dart';
import 'package:sqlite3/sqlite3.dart';
import 'package:test/test.dart';

/// Scripted Gateway: `down` → network failure; `status` → HTTP failure; else applies ops.
final class FakeGw {
  bool down = false;
  int? status;
  final sent = <String>[];
  int calls = 0;

  Future<PushVerdicts> push(List<Map<String, Object?>> ops) async {
    calls++;
    await Future<void>.delayed(const Duration(milliseconds: 2));
    if (down) throw const SyncFailure('network: refused');
    final s = status;
    if (s != null) throw SyncFailure('http $s', status: s);
    final applied = <String, Map<String, Object?>>{};
    for (final o in ops) {
      final uid = '${o['uid']}';
      sent.add(uid);
      applied[uid] = {'uid': uid, 'id': o['id'], 'version': 1};
    }
    return PushVerdicts(applied: applied);
  }
}

Map<String, Object?> op(int i) => {
  'k': 'a-$i',
  'collection': 'announcements',
  'type': 'put',
  'id': i,
  'data': {'title': 't$i'},
};

const cfg = OutboxConfig(
  baseBackoffMs: 60,
  maxBackoffMs: 200,
  jitter: 0,
  maxAttempts: 3,
);

Future<void> until(
  bool Function() f, {
  Duration max = const Duration(seconds: 5),
}) async {
  final end = DateTime.now().add(max);
  while (!f()) {
    if (DateTime.now().isAfter(end)) throw StateError('timeout');
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
}

AutoSync mk(SqliteOutbox ob, FakeGw gw, {int seed = 1, Duration? spread}) =>
    AutoSync(
      outbox: ob,
      push: gw.push,
      minGap: const Duration(milliseconds: 20),
      spread: spread ?? const Duration(milliseconds: 50),
      idleInterval: const Duration(seconds: 30),
      random: Random(seed),
    );

void main() {
  test('runs automatically after enqueue — no manual drain call', () async {
    final ob = SqliteOutbox.inMemory(config: cfg);
    final gw = FakeGw();
    final a = mk(ob, gw)..start();
    await until(() => a.current.phase == SyncPhase.idle && a.cycles >= 1);
    for (var i = 1; i <= 3; i++) {
      ob.enqueue(op(i));
    }
    a.notifyEnqueued(); // mutant: notifyEnqueued without _schedule → waits for 30 s idle → red
    await until(() => ob.stats().active == 0);
    expect(gw.sent, ['a-1', 'a-2', 'a-3']);
    expect(a.current.phase, SyncPhase.idle);
    expect(a.current.lastSuccessAt, isNotNull);
    await a.stop();
  });

  test('offline: status offline with pending count; notifyOnline sends everything once', () async {
    final ob = SqliteOutbox.inMemory(config: cfg);
    final gw = FakeGw()..down = true;
    final a = mk(ob, gw)..start();
    for (var i = 1; i <= 4; i++) {
      ob.enqueue(op(i));
    }
    a.notifyEnqueued();
    await until(() => a.current.phase == SyncPhase.offline);
    expect(a.current.waiting, 4);
    expect(a.current.labelFa, 'آفلاین — 4 مورد در صف ارسال');
    expect(a.current.lastError, startsWith('network'));
    gw.down = false;
    a.notifyOnline();
    await until(
      () => ob.stats().active == 0 && a.current.phase == SyncPhase.idle,
    );
    expect(gw.sent, ['a-1', 'a-2', 'a-3', 'a-4']);
    expect(gw.sent.toSet().length, gw.sent.length, reason: 'no duplicate');
    await a.stop();
  });

  test('an all-in-backoff cycle (nothing claimed) does not flip "offline" back to "synced"', () async {
    final ob = SqliteOutbox.inMemory(
      config: const OutboxConfig(baseBackoffMs: 5000, jitter: 0),
    );
    final gw = FakeGw()..down = true;
    final a = mk(ob, gw)..start();
    ob.enqueue(op(1));
    a.notifyEnqueued();
    await until(() => a.current.phase == SyncPhase.offline);
    final success = a.current.lastSuccessAt;
    await a.runOnce(); // head is in a 5 s backoff → claims nothing
    // mutant: treat "claimed 0, no error" as success → phase queued, lastSuccessAt set → red
    expect(a.current.phase, SyncPhase.offline);
    expect(a.current.lastSuccessAt, success);
    await a.stop();
  });

  test('no retry storm: a 1 s outage costs a bounded number of cycles and requests', () async {
    final ob = SqliteOutbox.inMemory(config: cfg);
    final gw = FakeGw()..down = true;
    final a = mk(ob, gw)..start();
    for (var i = 1; i <= 50; i++) {
      ob.enqueue(op(i));
    }
    a.notifyEnqueued();
    await Future<void>.delayed(const Duration(seconds: 1));
    // backoff 60→120→200 ms (cap) + minGap 20 ms → ≈ 7 attempts. A loop without backoff
    // or without minGap would make hundreds (mutant: minGap=0 & cfg backoff 0 → red).
    expect(gw.calls, lessThanOrEqualTo(12));
    expect(a.cycles, lessThanOrEqualTo(40));
    expect(gw.calls, greaterThanOrEqualTo(2), reason: 'it does keep retrying');
    await a.stop();
  });

  test('transient failures (network/429/5xx) never block, even far beyond maxAttempts', () async {
    final ob = SqliteOutbox.inMemory(config: cfg);
    final gw = FakeGw()..status = 503;
    final a = mk(ob, gw)..start();
    ob.enqueue(op(1));
    a.notifyEnqueued();
    await until(() => gw.calls >= 8, max: const Duration(seconds: 10));
    expect(
      ob.stats().blocked,
      0,
    ); // mutant: fail() without the transient flag → blocked at 3
    expect(a.current.phase, isNot(SyncPhase.attention));
    expect(ob.list().single.attempts, greaterThan(cfg.maxAttempts));
    gw.status = null;
    a.notifyOnline();
    await until(() => ob.stats().active == 0);
    expect(gw.sent, ['a-1']);
    await a.stop();
  });

  test('non-transient failure (403) blocks after maxAttempts and shows "attention"', () async {
    final ob = SqliteOutbox.inMemory(config: cfg);
    final gw = FakeGw()..status = 403;
    final a = mk(ob, gw)..start();
    ob.enqueue(op(1));
    a.notifyEnqueued();
    await until(() => a.current.phase == SyncPhase.attention);
    await Future<void>.delayed(const Duration(milliseconds: 400));
    expect(
      gw.calls,
      cfg.maxAttempts,
      reason: 'no further requests once blocked',
    );
    expect(a.current.labelFa, '1 مورد نیاز به بررسی دارد');
    expect(ob.stats().blocked, 1, reason: 'kept on the device, not dropped');
    await a.stop();
  });

  test(
    'FIFO: a later op never overtakes an earlier op that is in backoff',
    () async {
      final ob = SqliteOutbox.inMemory(config: cfg);
      final gw = FakeGw()..down = true;
      final a = mk(ob, gw)..start();
      ob.enqueue(op(1));
      a.notifyEnqueued();
      await until(
        () => gw.calls >= 1 && !a.current.phase.name.startsWith('sync'),
      );
      gw.down = false;
      ob.enqueue(op(2));
      a.notifyEnqueued();
      await until(() => ob.stats().active == 0);
      expect(gw.sent, [
        'a-1',
        'a-2',
      ]); // mutant: claim() FIFO break→continue → ['a-2','a-1'] red
      await a.stop();
    },
  );

  test('restart: pending ops in a file-backed outbox survive close/reopen and are sent once', () async {
    final dir = Directory.systemTemp.createTempSync('auto119-');
    final file = '${dir.path}/ob.db';
    final gw = FakeGw()..down = true;
    var ob = SqliteOutbox(sqlite3.open(file), config: cfg);
    var a = mk(ob, gw)..start();
    for (var i = 1; i <= 3; i++) {
      ob.enqueue(op(i));
    }
    a.notifyEnqueued();
    await until(() => a.current.phase == SyncPhase.offline);
    await a.stop();
    ob.database.close(); // app killed
    gw.down = false;
    ob = SqliteOutbox(sqlite3.open(file), config: cfg);
    expect(ob.stats().active, 3);
    a = mk(ob, gw)..start(); // start() recovers leases and runs at once
    await until(() => ob.stats().active == 0);
    expect(gw.sent, ['a-1', 'a-2', 'a-3']);
    await a.stop();
    ob.database.close();
    dir.deleteSync(recursive: true);
  });

  test('notifyOnline spreads wake-ups (seeded Random): 40 devices are not scheduled in lockstep', () async {
    final at = <int>[];
    for (var d = 0; d < 40; d++) {
      final ob = SqliteOutbox.inMemory(config: cfg);
      final a = AutoSync(
        outbox: ob,
        push: FakeGw().push,
        minGap: Duration.zero,
        spread: const Duration(seconds: 10),
        idleInterval: const Duration(minutes: 10),
        random: Random(d),
      )..start();
      await until(() => a.cycles >= 1 && a.current.phase == SyncPhase.idle);
      final t0 = DateTime.now().millisecondsSinceEpoch;
      a.notifyOnline();
      at.add(a.current.nextAttemptAt!.millisecondsSinceEpoch - t0);
      await a.stop();
    }
    at.sort();
    // mutant: notifyOnline schedules Duration.zero (no spread) → all ≈ 0 → red
    expect(at.last - at.first, greaterThan(5000));
    expect(at.where((x) => x < 1000).length, lessThan(10));
  });

  test(
    'status stream: every phase change is published with a Persian label',
    () async {
      final ob = SqliteOutbox.inMemory(config: cfg);
      final gw = FakeGw()..down = true;
      final a = mk(ob, gw);
      final seen = <String>[];
      final sub = a.status.listen(
        (s) => seen.add('${s.phase.name}:${s.labelFa}'),
      );
      a.start();
      ob.enqueue(op(1));
      a.notifyEnqueued();
      await until(() => a.current.phase == SyncPhase.offline);
      gw.down = false;
      a.notifyOnline();
      await until(
        () => a.current.phase == SyncPhase.idle && ob.stats().active == 0,
      );
      await Future<void>.delayed(Duration.zero);
      expect(seen, contains('syncing:در حال همگام‌سازی…'));
      expect(seen, contains('offline:آفلاین — 1 مورد در صف ارسال'));
      expect(seen.last, 'idle:همگام');
      await sub.cancel();
      await a.stop();
    },
  );
}
