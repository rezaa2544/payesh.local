import 'dart:io';
import 'dart:math';

import 'package:payesh_core/payesh_core.dart';
import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

/// Scripted transport: each pull answer / push answer is consumed in order.
final class FakeTransport implements SyncTransport {
  final pulls = <(String, int)>[];
  final pushes = <List<Map<String, Object?>>>[];
  final pullAnswers = <Object>[];
  final pushAnswers = <Object>[];

  @override
  Future<PullPage> pull({
    required String since,
    required int sinceId,
    List<String>? collections,
  }) async {
    pulls.add((since, sinceId));
    final a = pullAnswers.removeAt(0);
    if (a is Exception) throw a;
    return PullPage.fromJson(a as Map<String, Object?>);
  }

  @override
  Future<PushVerdicts> push(List<Map<String, Object?>> ops) async {
    pushes.add(ops);
    final a = pushAnswers.isEmpty
        ? <String, Object?>{}
        : pushAnswers.removeAt(0);
    if (a is SyncFailure) throw a;
    if (a is Exception) throw a;
    if (a == 'applyAll') {
      return PushVerdicts.fromJson({
        'applied': [
          for (final o in ops) {'uid': o['uid'], 'id': 1, 'version': 1},
        ],
      });
    }
    return PushVerdicts.fromJson(a as Map<String, Object?>);
  }
}

Map<String, Object?> page({
  Map<String, Object?> collections = const {},
  List<Object?> deleted = const [],
  String? nextSince,
  int nextId = 0,
  bool more = false,
  int schema = 1,
  String serverTime = '2026-11-07T14:30:41.008Z',
}) => {
  'ok': true,
  'schema_version': schema,
  'server_time': serverTime,
  'next_since': nextSince,
  'next_id': nextId,
  'more': more,
  'collections': collections,
  'deleted': deleted,
};

void main() {
  late SqliteEngine engine;
  late SqliteOutbox outbox;
  late FakeTransport t;
  late SyncClient client;

  setUp(() {
    engine = SqliteEngine.inMemory();
    outbox = SqliteOutbox.inMemory(
      config: const OutboxConfig(jitter: 0, batchLimit: 4),
      clock: FakeClock(DateTime.utc(2026, 11, 1)),
    );
    t = FakeTransport();
    client = SyncClient(
      engine: engine,
      outbox: outbox,
      transport: t,
      knownCollections: {'attendance', 'announcements'},
    );
  });
  tearDown(() {
    engine.close();
    outbox.database.close();
  });

  group('pull', () {
    test(
      'follows the composite cursor until more=false and persists it',
      () async {
        t.pullAnswers.addAll([
          page(
            collections: {
              'attendance': [
                {
                  'id': 1,
                  'student_id': 3,
                  '_version': 2,
                  'updated_at': '2026-11-07T10:00:00.000Z',
                },
                {
                  'id': 2,
                  'student_id': 4,
                  '_version': 1,
                  'updated_at': '2026-11-07T10:00:00.000Z',
                },
              ],
            },
            nextSince: '2026-11-07T10:00:00.000Z',
            nextId: 2,
            more: true,
          ),
          page(
            collections: {
              'attendance': [
                {
                  'id': 3,
                  'student_id': 5,
                  'updated_at': '2026-11-07T10:00:00.000Z',
                },
              ],
              'announcements': [
                {'id': 9, 'title': 'اطلاعیه'},
              ],
            },
            deleted: [
              {
                'collection': 'attendance',
                'id': 2,
                'at': '2026-11-07T11:00:00.000Z',
              },
            ],
            nextSince: '2026-11-07T11:00:00.000Z',
            nextId: 9,
          ),
        ]);
        final r = await client.pull();
        expect(t.pulls, [(epoch, 0), ('2026-11-07T10:00:00.000Z', 2)]);
        expect(r.pages, 2);
        expect(r.rows, 4);
        expect(r.deleted, 1);
        expect(client.cursor, (
          '2026-11-07T14:30:41.008Z',
          0,
        ), reason: 'last page → (server_time, 0)');
        expect((await engine.get('attendance', 1))!.version, 2);
        expect(
          await engine.get('attendance', 2),
          isNull,
          reason: 'tombstone applied',
        );
        expect(
          (await engine.get('announcements', 9))!.updatedAt,
          '2026-11-07T14:30:41.008Z',
        );
        expect(
          (await engine.get('announcements', 9))!.data['title'],
          'اطلاعیه',
        );
      },
    );

    test('cursor survives restart (same database file)', () async {
      final dir = Directory.systemTemp.createTempSync('payesh_sync_');
      addTearDown(() => dir.deleteSync(recursive: true));
      final path = '${dir.path}/c.db';
      final e1 = SqliteEngine.open(path);
      final c1 = SyncClient(engine: e1, outbox: outbox, transport: t);
      t.pullAnswers.add(
        page(more: true, nextSince: '2026-11-07T12:00:00.000Z', nextId: 5),
      );
      t.pullAnswers.add(const SocketException('cut'));
      await expectLater(c1.pull(), throwsA(isA<SocketException>()));
      e1.close();
      final e2 = SqliteEngine.open(path);
      addTearDown(e2.close);
      final c2 = SyncClient(engine: e2, outbox: outbox, transport: t);
      expect(c2.cursor, ('2026-11-07T12:00:00.000Z', 5));
      t.pullAnswers.add(page());
      await c2.pull();
      expect(t.pulls.last, ('2026-11-07T12:00:00.000Z', 5));
      c2.resetCursor();
      expect(c2.cursor, (epoch, 0));
    });

    test('unknown collections and rows without id are skipped, pull does not break', () async {
      t.pullAnswers.add(
        page(
          collections: {
            'future_collection': [
              {'id': 1},
            ],
            'attendance': [
              {'student_id': 1},
              {'id': 5},
            ],
          },
        ),
      );
      final r = await client.pull();
      expect(r.rows, 1);
      expect(r.skipped, 2);
      expect(await engine.count(), 1);
    });

    test('unsupported schema_version is refused', () async {
      t.pullAnswers.add(page(schema: 2));
      await expectLater(client.pull(), throwsA(isA<SyncProtocolException>()));
    });

    test(
      'more=true without cursor progress is refused (no infinite loop)',
      () async {
        t.pullAnswers.add(page(more: true));
        await expectLater(client.pull(), throwsA(isA<SyncProtocolException>()));
      },
    );

    test('maxPages guard', () async {
      final c = SyncClient(
        engine: engine,
        outbox: outbox,
        transport: t,
        maxPages: 1,
      );
      t.pullAnswers.addAll([
        page(more: true, nextSince: '2026-11-07T01:00:00.000Z', nextId: 1),
        page(),
      ]);
      await expectLater(c.pull(), throwsA(isA<SyncProtocolException>()));
    });

    test('a stale page never moves the cursor backwards', () async {
      t.pullAnswers.addAll([
        page(serverTime: '2026-11-07T12:00:00.000Z'),
        page(serverTime: '2026-11-07T09:00:00.000Z'),
        page(serverTime: ''),
      ]);
      await client.pull();
      await client.pull();
      expect(client.cursor, ('2026-11-07T12:00:00.000Z', 0));
      await client.pull();
      expect(client.cursor, ('2026-11-07T12:00:00.000Z', 0));
    });
  });

  group('push / faults', () {
    void enqueueN(int n) {
      for (var i = 0; i < n; i++) {
        outbox.enqueue({
          'k': 'k$i',
          'collection': 'attendance',
          'data': {'i': i},
          'at': '2026-11-01T00:00:00.000Z',
        });
      }
    }

    test('syncOnce pushes then pulls', () async {
      enqueueN(5);
      t.pushAnswers.addAll(['applyAll', 'applyAll']);
      t.pullAnswers.add(page());
      final r = await client.syncOnce(now: 0);
      expect(r.push.applied, 5);
      expect(r.push.batches, 2);
      expect(r.pull, isNotNull);
      expect(outbox.stats().total, 0);
    });

    test('unauthorized: ops stay queued, pull skipped', () async {
      enqueueN(2);
      t.pushAnswers.add(
        const SyncFailure(
          'unauthorized',
          code: PayeshErrorCode.unauthorized,
          status: 401,
        ),
      );
      final r = await client.syncOnce(now: 0);
      expect(r.push.stopped, 'unauthorized');
      expect(r.pull, isNull);
      expect(t.pulls, isEmpty);
      expect(outbox.stats().pending, 2);
      expect(outbox.get('k0')!.lastError, 'unauthorized');
    });

    test('write_frozen (409) keeps ops queued with backoff', () async {
      enqueueN(1);
      t.pushAnswers.add(
        const SyncFailure(
          'write_frozen',
          code: PayeshErrorCode.writeFrozen,
          status: 409,
        ),
      );
      final r = await client.push(now: 1000);
      expect(r.stopped, 'write_frozen');
      expect(outbox.get('k0')!.nextAt, 2000);
      expect(r.retryAt, 2000);
    });

    test(
      '413 body_too_large halves the batch until it fits; nothing dropped',
      () async {
        enqueueN(4);
        t.pushAnswers.addAll([
          const SyncFailure(
            'body_too_large',
            code: PayeshErrorCode.payloadTooLarge,
            status: 413,
          ),
          'applyAll',
          'applyAll',
        ]);
        final r = await client.push(now: 0);
        expect(t.pushes.map((p) => p.length).toList(), [4, 2, 2]);
        expect(r.applied, 4);
        expect(r.claimed, 4);
        expect(outbox.stats().total, 0);
      },
    );

    test('413 on a single op fails it (no infinite split)', () async {
      enqueueN(1);
      t.pushAnswers.add(
        const SyncFailure(
          'body_too_large',
          code: PayeshErrorCode.payloadTooLarge,
          status: 413,
        ),
      );
      final r = await client.push(now: 0);
      expect(r.failed, 1);
      expect(r.stopped, 'body_too_large');
      expect(outbox.get('k0')!.state, OpState.pending);
    });

    test('429 Retry-After overrides the shorter backoff', () async {
      enqueueN(1);
      t.pushAnswers.add(
        const SyncFailure('rate_limited', status: 429, retryAfterMs: 60000),
      );
      final r = await client.push(now: 0);
      expect(r.stopped, 'rate_limited');
      expect(outbox.get('k0')!.nextAt, 60000);
    });

    test('network exception → stopped=network, op kept and retried later with the same uid', () async {
      enqueueN(1);
      t.pushAnswers.addAll([const SocketException('offline'), 'applyAll']);
      final r1 = await client.push(now: 0);
      expect(r1.stopped, 'network');
      final r2 = await client.push(now: 999);
      expect(r2.batches, 0, reason: 'still in backoff');
      final r3 = await client.push(now: 1000);
      expect(r3.applied, 1);
      expect(t.pushes[0].single['uid'], t.pushes[1].single['uid']);
    });

    test(
      'verdict hooks are called; rejected and conflict leave the queue',
      () async {
        enqueueN(3);
        final seen = <String>[];
        t.pushAnswers.add({
          'applied': [
            {'uid': 'k0'},
          ],
          'rejected': [
            {'uid': 'k1', 'error': 'role_denied'},
          ],
          'conflicts': [
            {'uid': 'k2', 'server_version': 3},
          ],
        });
        final r = await outbox.drain(
          t.push,
          now: 0,
          onApplied: (o, v) => seen.add('a:${o.k}'),
          onRejected: (o, v) => seen.add('r:${o.k}:${v['error']}'),
          onConflict: (o, v) => seen.add('c:${o.k}:${v['server_version']}'),
        );
        expect(seen, ['a:k0', 'r:k1:role_denied', 'c:k2:3']);
        expect(r.applied + r.rejected + r.conflicts, 3);
        expect(outbox.stats().total, 0);
      },
    );

    test(
      'convergence (D-28): conflict keeps both versions, server version shown, '
      'later edits of that record are superseded, rejected goes to review',
      () async {
        await engine.put('grades', 7, {'id': 7, 'score': 15}, version: 2);
        outbox.enqueue({
          'k': 'g1',
          'collection': 'grades',
          'type': 'put',
          'id': 7,
          'base_version': 2,
          'data': {'id': 7, 'score': 18},
        });
        outbox.enqueue({
          'k': 'g2',
          'collection': 'grades',
          'type': 'put',
          'id': 7,
          'base_version': 2,
          'data': {'id': 7, 'score': 19},
        });
        outbox.enqueue({
          'k': 'x1',
          'collection': 'users',
          'type': 'put',
          'id': 3,
          'data': {'role': 'manager'},
        });
        outbox.enqueue({
          'k': 'other',
          'collection': 'grades',
          'type': 'put',
          'id': 8,
          'data': {'id': 8, 'score': 10},
        });
        t.pushAnswers
          ..add({
            'applied': <Object?>[],
            'conflicts': [
              {
                'uid': 'g1',
                'collection': 'grades',
                'id': 7,
                'server_version': 3,
                'conflict_id': 41,
                'server': {'id': 7, 'score': 12, '_version': 3},
              },
            ],
            'rejected': [
              {'uid': 'x1', 'error': 'role_change_denied', 'conflict_id': 42},
            ],
          })
          ..add('applyAll');
        // batchLimit 4 → g1, g2, x1, other in one batch; g2 and other get no verdict in the
        // first answer and are retried — but g2 must be pulled out as superseded first.
        final r = await client.push(now: 0);
        expect(r.conflicts, 1);
        expect(r.rejected, 1);
        final row = await engine.get('grades', 7);
        expect(
          row!.data['score'],
          12,
          reason: 'server version is what the user sees',
        );
        expect(row.version, 3);
        final rv = client.review();
        expect(rv.map((e) => '${e.kind}:${e.uid}'), [
          'rejected:x1',
          'conflict:g1',
          'superseded:g2',
        ]);
        final c = rv[1];
        expect(
          c.local!['score'],
          18,
          reason: 'our version is never thrown away',
        );
        expect(c.server!['score'], 12);
        expect(c.serverVersion, 3);
        expect(c.conflictId, 41);
        expect(rv[0].error, 'role_change_denied');
        expect(rv[0].conflictId, 42);
        expect(rv[2].local!['score'], 19);
        expect(outbox.list().map((o) => o.k), ['other']);
        expect(client.review(status: 'resolved'), isEmpty);
      },
    );

    test(
      'conflict without a server row (deleted on server) is still recorded',
      () async {
        outbox.enqueue({
          'k': 'd1',
          'collection': 'homework',
          'type': 'put',
          'id': 5,
          'base_version': 4,
          'data': {'title': 'x'},
        });
        t.pushAnswers.add({
          'conflicts': [
            {
              'uid': 'd1',
              'collection': 'homework',
              'id': 5,
              'server_version': 0,
              'server': null,
            },
          ],
        });
        final r = await client.push(now: 0);
        expect(r.conflicts, 1);
        expect(await engine.get('homework', 5), isNull);
        final rv = client.review().single;
        expect(rv.server, isNull);
        expect(rv.local!['title'], 'x');
        expect(rv.serverVersion, 0);
      },
    );

    test('ordering: ops are sent in enqueue order across batches', () async {
      for (var i = 0; i < 10; i++) {
        outbox.enqueue({
          'k': 'o$i',
          'collection': 'attendance',
          'type': 'put',
          'data': {'n': i},
        });
      }
      t.pushAnswers.addAll(['applyAll', 'applyAll', 'applyAll']);
      final r = await client.push(now: 0);
      expect(r.applied, 10);
      expect(r.batches, 3);
      expect(
        [for (final b in t.pushes) ...b.map((o) => o['uid'])],
        [for (var i = 0; i < 10; i++) 'o$i'],
      );
    });

    test(
      'crash mid-send: lease expires, recover() and the op is resent',
      () async {
        enqueueN(1);
        final claimed = outbox.claim(10, 0);
        expect(
          claimed.single.state,
          OpState.pending,
          reason: 'snapshot before lease',
        );
        expect(outbox.stats().inflight, 1);
        expect(outbox.recover(29999), 0);
        expect(outbox.recover(30000), 1);
        t.pushAnswers.add('applyAll');
        expect((await client.push(now: 30000)).applied, 1);
      },
    );

    test(
      'enqueue without k generates a UUIDv4; release ignores non-inflight ops',
      () {
        final r = outbox.enqueue({
          'collection': 'attendance',
          'type': 'del',
          'id': 4,
        });
        expect(isUuidV4(r.k!), isTrue);
        outbox.release([r.k!]);
        expect(outbox.get(r.k!)!.state, OpState.pending);
        expect(outbox.list(state: OpState.pending).length, 1);
        expect(outbox.stats().free, 4999);
        expect(outbox.retry('missing'), isFalse);
      },
    );

    test('jittered backoff stays within [1-j, 1] × base', () {
      final ob = SqliteOutbox.inMemory(
        config: const OutboxConfig(jitter: 0.5),
        random: Random(7),
      );
      addTearDown(ob.database.close);
      for (var i = 0; i < 50; i++) {
        ob.enqueue({'k': 'j$i', 'collection': 'c'});
        final f = ob.fail('j$i', now: 0);
        expect(f.nextAt, inInclusiveRange(500, 1000));
      }
      final long = 'x' * 500;
      ob.enqueue({'k': 'long', 'collection': 'c'});
      ob.fail('long', error: long, now: 0);
      expect(ob.get('long')!.lastError!.length, 200);
    });

    test('SyncFailure / SyncProtocolException describe themselves', () {
      expect(
        const SyncFailure(
          'x',
          code: PayeshErrorCode.writeFrozen,
          status: 409,
        ).toString(),
        contains('write_frozen'),
      );
      expect(const SyncProtocolException('y').toString(), contains('y'));
    });
  });
}
