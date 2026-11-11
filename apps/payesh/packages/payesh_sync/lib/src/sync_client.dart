import 'dart:convert';

import 'package:payesh_data/payesh_data.dart';
import 'package:sqlite3/sqlite3.dart' show Database;

import 'outbox.dart';
import 'transport.dart';

/// Thrown when the server speaks a sync contract this client does not understand,
/// or when a paged pull would loop without advancing.
final class SyncProtocolException implements Exception {
  const SyncProtocolException(this.message);
  final String message;
  @override
  String toString() => 'SyncProtocolException: $message';
}

final class PullResult {
  int pages = 0;
  int rows = 0;
  int deleted = 0;
  int skipped = 0;
  String since = '';
  int sinceId = 0;
}

final class SyncReport {
  const SyncReport(this.push, this.pull);
  final DrainResult push;
  final PullResult? pull;
}

/// One entry of the "needs review" list (D‑28 / client/app.js `S.review`).
///
/// Kinds: `conflict` (server kept its version, ours is preserved here), `rejected`
/// (server refused the op, e.g. role_denied), `superseded` (a later queued edit of a record
/// that is now in conflict — taken out of the queue but never thrown away).
final class ReviewItem {
  const ReviewItem({
    required this.kind,
    required this.uid,
    required this.at,
    this.collection,
    this.id,
    this.conflictId,
    this.serverVersion,
    this.local,
    this.server,
    this.error,
    this.status = 'needs_review',
  });
  final String kind;
  final String uid;
  final String at;
  final String? collection;
  final int? id;
  final int? conflictId;
  final int? serverVersion;
  final Map<String, Object?>? local;
  final Map<String, Object?>? server;
  final String? error;
  final String status;
}

/// Composite pull cursor persisted in the engine's `meta` table (survives restarts).
const String cursorSinceKey = 'sync.since';
const String cursorIdKey = 'sync.since_id';
const String epoch = '1970-01-01T00:00:00.000Z';

/// Sync v1 client: push the outbox, then pull with the composite cursor until `more == false`.
final class SyncClient {
  SyncClient({
    required this.engine,
    required this.outbox,
    required this.transport,
    this.knownCollections,
    this.maxPages = 10000,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now {
    ensureReviewTable(engine.database);
  }

  final DateTime Function() _now;

  final SqliteEngine engine;
  final SqliteOutbox outbox;
  final SyncTransport transport;

  /// When set, rows of other collections are ignored (contract §5: never break the pull).
  final Set<String>? knownCollections;
  final int maxPages;

  (String, int) get cursor {
    String? read(String k) {
      final rs = engine.database.select(
        'SELECT value FROM meta WHERE key = ?',
        [k],
      );
      return rs.isEmpty ? null : rs.first['value'] as String?;
    }

    return (
      read(cursorSinceKey) ?? epoch,
      int.tryParse(read(cursorIdKey) ?? '') ?? 0,
    );
  }

  void _saveCursor(String since, int id) {
    for (final e in {cursorSinceKey: since, cursorIdKey: '$id'}.entries) {
      engine.database.execute(
        'INSERT INTO meta (key, value) VALUES (?, ?) '
        'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        [e.key, e.value],
      );
    }
  }

  /// Forget the cursor (full resync on next pull).
  void resetCursor() => engine.database.execute(
    'DELETE FROM meta WHERE key IN (?, ?)',
    [cursorSinceKey, cursorIdKey],
  );

  /// Push the outbox. Convergence follows D‑28 exactly like client/app.js:
  /// * `rejected` → review item, op leaves the queue;
  /// * `conflict` → the server version is written to the local engine (what the user sees),
  ///   our version is kept in the review list (never auto-resolved), and later queued edits
  ///   of the same record are moved to review as `superseded` instead of being sent blind.
  Future<DrainResult> push({int? now, VerdictHook? onApplied}) async {
    final conflicts = <(OutboxOp, Map<String, Object?>)>[];
    final res = await outbox.drain(
      transport.push,
      now: now,
      onApplied: onApplied,
      onRejected: (op, v) => _addReview(
        ReviewItem(
          kind: 'rejected',
          uid: op.k,
          at: _iso(),
          collection: op.collection,
          id: op.id,
          conflictId: (v['conflict_id'] as num?)?.toInt(),
          local: op.payload,
          error: (v['error'] as String?) ?? 'rejected',
        ),
      ),
      onConflict: (op, v) => conflicts.add((op, v)),
    );
    for (final (op, v) in conflicts) {
      final id = (v['id'] as num?)?.toInt() ?? op.id;
      final collection = (v['collection'] as String?) ?? op.collection;
      final server = v['server'] is Map
          ? (v['server']! as Map).cast<String, Object?>()
          : null;
      _addReview(
        ReviewItem(
          kind: 'conflict',
          uid: op.k,
          at: _iso(),
          collection: collection,
          id: id,
          conflictId: (v['conflict_id'] as num?)?.toInt(),
          serverVersion: (v['server_version'] as num?)?.toInt(),
          local: op.payload,
          server: server,
        ),
      );
      if (server != null && id != null) {
        await engine.put(
          collection,
          id,
          server,
          version:
              (server['_version'] as num?)?.toInt() ??
              (v['server_version'] as num?)?.toInt() ??
              1,
          updatedAt: server['updated_at'] as String?,
        );
      }
      if (id != null) {
        for (final later in outbox.list()) {
          if (later.collection == collection && later.id == id) {
            _addReview(
              ReviewItem(
                kind: 'superseded',
                uid: later.k,
                at: _iso(),
                collection: collection,
                id: id,
                local: later.payload,
              ),
            );
            outbox.ack(later.k);
          }
        }
      }
    }
    return res;
  }

  String _iso() => _now().toUtc().toIso8601String();

  void _addReview(ReviewItem r) => addReview(engine.database, r);

  /// Items still waiting for an authorised human decision, oldest first.
  List<ReviewItem> review({String status = 'needs_review'}) =>
      readReview(engine.database, status: status);

  Future<PullResult> pull({List<String>? collections}) async {
    final res = PullResult();
    var (since, sinceId) = cursor;
    for (;;) {
      if (res.pages >= maxPages) {
        throw SyncProtocolException('pull exceeded $maxPages pages');
      }
      final page = await transport.pull(
        since: since,
        sinceId: sinceId,
        collections: collections,
      );
      res.pages++;
      if (page.schemaVersion != 1) {
        throw SyncProtocolException(
          'unsupported schema_version ${page.schemaVersion}',
        );
      }
      final rows = <RowInput>[];
      for (final e in page.collections.entries) {
        if (knownCollections != null && !knownCollections!.contains(e.key)) {
          res.skipped += e.value.length;
          continue;
        }
        for (final r in e.value) {
          final id = (r['id'] as num?)?.toInt();
          if (id == null) {
            res.skipped++;
            continue;
          }
          rows.add(
            RowInput(
              collection: e.key,
              id: id,
              data: r,
              version: (r['_version'] as num?)?.toInt() ?? 1,
              updatedAt: (r['updated_at'] as String?) ?? page.serverTime,
            ),
          );
        }
      }
      await engine.putMany(rows);
      res.rows += rows.length;
      for (final d in page.deleted) {
        final id = (d['id'] as num?)?.toInt();
        final c = d['collection'];
        if (id == null || c is! String) continue;
        await engine.del(c, id);
        res.deleted++;
      }
      // Same rule as client/app.js: while more=true follow (next_since, next_id); on the last
      // page the server sends next_since=null and the cursor moves to (server_time, 0).
      final String nextSince;
      final int nextId;
      if (page.more) {
        nextSince = page.nextSince ?? since;
        nextId = page.nextId;
        if (nextSince == since && nextId == sinceId) {
          throw const SyncProtocolException(
            'more=true without cursor progress',
          );
        }
      } else if (page.serverTime.isNotEmpty) {
        nextSince = page.serverTime;
        nextId = 0;
      } else {
        nextSince = page.nextSince ?? since;
        nextId = page.nextId;
      }
      if (nextSince.compareTo(since) > 0 ||
          (nextSince == since && nextId >= sinceId)) {
        since = nextSince;
        sinceId = nextId;
        _saveCursor(since, sinceId);
      }
      if (!page.more) break;
    }
    res
      ..since = since
      ..sinceId = sinceId;
    return res;
  }

  /// One sync round: push first (so the pull sees our writes), then pull.
  /// If the push stopped on unauthorized/network, the pull is skipped.
  Future<SyncReport> syncOnce({int? now, List<String>? collections}) async {
    final p = await push(now: now);
    if (p.stopped != null) return SyncReport(p, null);
    return SyncReport(p, await pull(collections: collections));
  }
}

/// Durable review log shared by [SyncClient] and the Gateway path (`GatewaySync.push`, row 119):
/// a rejected, conflicting or superseded local edit leaves the outbox only after it has been
/// written here, so it is never lost silently and stays visible until a human decides.
void ensureReviewTable(Database db) => db.execute(
  'CREATE TABLE IF NOT EXISTS sync_review ('
  'seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, uid TEXT NOT NULL, '
  'collection TEXT, record_id INTEGER, conflict_id INTEGER, server_version INTEGER, '
  'local TEXT, server TEXT, error TEXT, at TEXT NOT NULL, '
  "status TEXT NOT NULL DEFAULT 'needs_review')",
);

void addReview(Database db, ReviewItem r) => db.execute(
  'INSERT INTO sync_review (kind, uid, collection, record_id, conflict_id, '
  'server_version, local, server, error, at, status) '
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  [
    r.kind,
    r.uid,
    r.collection,
    r.id,
    r.conflictId,
    r.serverVersion,
    r.local == null ? null : jsonEncode(r.local),
    r.server == null ? null : jsonEncode(r.server),
    r.error,
    r.at,
    r.status,
  ],
);

List<ReviewItem> readReview(Database db, {String status = 'needs_review'}) {
  Map<String, Object?>? dec(Object? s) => s == null
      ? null
      : (jsonDecode(s as String) as Map).cast<String, Object?>();
  return db
      .select('SELECT * FROM sync_review WHERE status = ? ORDER BY seq', [
        status,
      ])
      .map(
        (r) => ReviewItem(
          kind: r['kind'] as String,
          uid: r['uid'] as String,
          at: r['at'] as String,
          collection: r['collection'] as String?,
          id: r['record_id'] as int?,
          conflictId: r['conflict_id'] as int?,
          serverVersion: r['server_version'] as int?,
          local: dec(r['local']),
          server: dec(r['server']),
          error: r['error'] as String?,
          status: r['status'] as String,
        ),
      )
      .toList();
}
