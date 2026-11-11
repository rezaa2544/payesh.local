import 'dart:convert';
import 'dart:math';

import 'package:payesh_core/payesh_core.dart';
import 'package:sqlite3/sqlite3.dart';

/// Outbox tuning — defaults equal `DEFAULTS` in client/outbox-web.js.
final class OutboxConfig {
  const OutboxConfig({
    this.capacity = 5000,
    this.leaseMs = 30000,
    this.maxAttempts = 6,
    this.baseBackoffMs = 1000,
    this.maxBackoffMs = 300000,
    this.jitter = 0.5,
    this.batchLimit = 120,
  });

  factory OutboxConfig.fromJson(Map<String, Object?> j) => OutboxConfig(
    capacity: (j['capacity'] as num?)?.toInt() ?? 5000,
    leaseMs: (j['leaseMs'] as num?)?.toInt() ?? 30000,
    maxAttempts: (j['maxAttempts'] as num?)?.toInt() ?? 6,
    baseBackoffMs: (j['baseBackoffMs'] as num?)?.toInt() ?? 1000,
    maxBackoffMs: (j['maxBackoffMs'] as num?)?.toInt() ?? 300000,
    jitter: (j['jitter'] as num?)?.toDouble() ?? 0.5,
    batchLimit: (j['batchLimit'] as num?)?.toInt() ?? 120,
  );

  final int capacity;
  final int leaseMs;
  final int maxAttempts;
  final int baseBackoffMs;
  final int maxBackoffMs;
  final double jitter;
  final int batchLimit;
}

enum OpState { pending, inflight, blocked }

/// One queued operation (same fields as the web outbox record).
final class OutboxOp {
  const OutboxOp({
    required this.k,
    required this.seq,
    required this.collection,
    required this.type,
    required this.id,
    required this.localId,
    required this.payload,
    required this.baseVersion,
    required this.at,
    required this.state,
    required this.attempts,
    required this.leaseUntil,
    required this.nextAt,
    required this.lastError,
  });

  final String k;
  final int seq;
  final String collection;
  final String type;
  final int? id;
  final int? localId;
  final Map<String, Object?>? payload;
  final int baseVersion;
  final String at;
  final OpState state;
  final int attempts;
  final int leaseUntil;
  final int nextAt;
  final String? lastError;

  /// Sync v1 wire op — identical to `toWire` in client/outbox-web.js.
  Map<String, Object?> toWire() => {
    'uid': k,
    'collection': collection,
    'type': type,
    if (id != null && id! > 0) 'id': id,
    if (localId != null) 'localId': localId,
    if (type == 'put') ...{
      'data': payload ?? const <String, Object?>{},
      'base_version': baseVersion,
    },
    if (at.isNotEmpty) 'at': at,
  };
}

/// Result of [SqliteOutbox.enqueue].
final class EnqueueResult {
  const EnqueueResult({
    required this.ok,
    this.k,
    this.duplicate = false,
    this.error,
    this.seq,
  });
  final bool ok;
  final String? k;
  final bool duplicate;
  final PayeshErrorCode? error;
  final int? seq;
}

/// Result of [SqliteOutbox.fail].
final class FailResult {
  const FailResult({
    required this.ok,
    this.state,
    this.attempts = 0,
    this.nextAt = 0,
  });
  final bool ok;
  final OpState? state;
  final int attempts;
  final int nextAt;
}

final class OutboxStats {
  const OutboxStats({
    required this.total,
    required this.pending,
    required this.inflight,
    required this.blocked,
    required this.capacity,
  });
  final int total;
  final int pending;
  final int inflight;
  final int blocked;
  final int capacity;
  int get active => pending + inflight;
  bool get full => active >= capacity;
  int get free => max(0, capacity - active);
}

/// Server verdicts for one pushed batch (`applied` / `rejected` / `conflicts`, keyed by uid).
final class PushVerdicts {
  const PushVerdicts({
    this.applied = const {},
    this.rejected = const {},
    this.conflicts = const {},
  });

  factory PushVerdicts.fromJson(Map<String, Object?> j) {
    Map<String, Map<String, Object?>> byUid(String key) => {
      for (final e in (j[key] as List<Object?>?) ?? const [])
        if (e is Map) '${e['uid']}': e.cast<String, Object?>(),
    };
    return PushVerdicts(
      applied: byUid('applied'),
      rejected: byUid('rejected'),
      conflicts: byUid('conflicts'),
    );
  }

  final Map<String, Map<String, Object?>> applied;
  final Map<String, Map<String, Object?>> rejected;
  final Map<String, Map<String, Object?>> conflicts;
}

/// Thrown by a push sender when the whole request failed. [code] decides retry policy.
final class SyncFailure implements Exception {
  const SyncFailure(this.message, {this.code, this.status, this.retryAfterMs});
  final String message;
  final PayeshErrorCode? code;
  final int? status;
  final int? retryAfterMs;
  @override
  String toString() => 'SyncFailure($status ${code?.wire ?? ''}: $message)';
}

final class DrainResult {
  int batches = 0;
  int claimed = 0;
  int applied = 0;
  int rejected = 0;
  int conflicts = 0;
  int failed = 0;

  /// null when the queue drained; `network`, or the server error code that stopped the loop.
  String? stopped;
  int? retryAt;
}

typedef PushSender = Future<PushVerdicts> Function(
  List<Map<String, Object?>> wire,
);
typedef VerdictHook = void Function(OutboxOp op, Map<String, Object?> verdict);

const _schema = '''
CREATE TABLE IF NOT EXISTS outbox (
  k TEXT NOT NULL PRIMARY KEY,
  seq INTEGER NOT NULL,
  collection TEXT NOT NULL,
  type TEXT NOT NULL,
  id INTEGER,
  local_id INTEGER,
  payload TEXT,
  base_version INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID''';

/// Durable device outbox on SQLite.
///
/// Guarantees (same as row 40 web outbox): persisted before send; removed only on a server
/// verdict (ack); leased sends survive crashes; one stable key per op; a full queue refuses the
/// new op with `queue_full` and never drops an old one.
final class SqliteOutbox {
  SqliteOutbox(
    this._db, {
    this.config = const OutboxConfig(),
    this.clock = const SystemClock(),
    Random? random,
  }) : _random = random ?? Random() {
    _db.execute(_schema);
    _db.execute(
      'CREATE INDEX IF NOT EXISTS outbox_state ON outbox (state, seq)',
    );
  }

  /// Private in-memory outbox (tests).
  factory SqliteOutbox.inMemory({
    OutboxConfig config = const OutboxConfig(),
    Clock clock = const SystemClock(),
    Random? random,
  }) => SqliteOutbox(
    sqlite3.openInMemory(),
    config: config,
    clock: clock,
    random: random,
  );

  final Database _db;
  final OutboxConfig config;
  final Clock clock;
  final Random _random;

  Database get database => _db;

  int _nowMs() => clock.now().millisecondsSinceEpoch;
  String _iso(int ms) =>
      DateTime.fromMillisecondsSinceEpoch(ms, isUtc: true).toIso8601String();

  T _tx<T>(T Function() fn) {
    _db.execute('BEGIN IMMEDIATE');
    try {
      final r = fn();
      _db.execute('COMMIT');
      return r;
    } catch (_) {
      _db.execute('ROLLBACK');
      rethrow;
    }
  }

  OutboxOp _op(Row r) => OutboxOp(
    k: r['k'] as String,
    seq: r['seq'] as int,
    collection: r['collection'] as String,
    type: r['type'] as String,
    id: r['id'] as int?,
    localId: r['local_id'] as int?,
    payload: r['payload'] == null
        ? null
        : (jsonDecode(r['payload'] as String) as Map).cast<String, Object?>(),
    baseVersion: r['base_version'] as int,
    at: r['at'] as String,
    state: OpState.values.byName(r['state'] as String),
    attempts: r['attempts'] as int,
    leaseUntil: r['lease_until'] as int,
    nextAt: r['next_at'] as int,
    lastError: r['last_error'] as String?,
  );

  /// Adds an op; idempotent on `k` (or `uid`). Input uses the web-outbox field names.
  EnqueueResult enqueue(Map<String, Object?> op) {
    final raw = '${op['k'] ?? op['uid'] ?? ''}'.trim();
    final k = raw.isEmpty ? newIdempotencyKey() : raw;
    final now = _nowMs();
    return _tx(() {
      if (_db.select('SELECT 1 FROM outbox WHERE k = ?', [k]).isNotEmpty) {
        return EnqueueResult(ok: true, k: k, duplicate: true);
      }
      final active =
          _db
                  .select(
                    "SELECT COUNT(*) AS n FROM outbox WHERE state IN ('pending','inflight')",
                  )
                  .first['n']
              as int;
      if (active >= config.capacity) {
        return const EnqueueResult(ok: false, error: PayeshErrorCode.queueFull);
      }
      final seq =
          (_db
                  .select('SELECT COALESCE(MAX(seq), 0) AS m FROM outbox')
                  .first['m']
              as int) +
          1;
      final data = op['data'];
      _db.execute(
        'INSERT INTO outbox (k, seq, collection, type, id, local_id, payload, base_version, at, '
        'state, attempts, lease_until, next_at, last_error, created_at, updated_at) '
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, 0, NULL, ?, ?)",
        [
          k,
          seq,
          '${op['collection'] ?? ''}',
          op['type'] == 'del' ? 'del' : 'put',
          (op['id'] as num?)?.toInt(),
          (op['localId'] as num?)?.toInt(),
          data == null ? null : jsonEncode(data),
          (op['base_version'] as num?)?.toInt() ?? 0,
          (op['at'] as String?) ?? _iso(now),
          _iso(now),
          _iso(now),
        ],
      );
      return EnqueueResult(ok: true, k: k, seq: seq);
    });
  }

  /// Leases up to [limit] ready ops (pending past backoff, or inflight with an expired lease),
  /// strictly in `seq` order.
  ///
  /// Row 119 — FIFO barrier: the scan stops at the first *pending* op that is still in its
  /// backoff window, so a later op (e.g. a student row that references a class created by an
  /// earlier op) can never overtake an earlier one. Inflight ops with a live lease are already
  /// on the wire ahead of the rest and do not stop the scan; blocked ops wait for a user
  /// decision (visible in [stats]) and do not stall the queue.
  List<OutboxOp> claim([int? limit, int? now]) {
    final t = now ?? _nowMs();
    final n = max(1, limit ?? config.batchLimit);
    return _tx(() {
      final rows = <OutboxOp>[];
      final scan = _db
          .select(
            "SELECT * FROM outbox WHERE state IN ('pending','inflight') ORDER BY seq",
          )
          .map(_op);
      for (final r in scan) {
        if (rows.length >= n) break;
        if (r.state == OpState.pending) {
          if (r.nextAt > t) break; // FIFO barrier
          rows.add(r);
        } else if (r.leaseUntil <= t) {
          rows.add(r); // abandoned lease (crash/restart)
        }
      }
      for (final r in rows) {
        _db.execute(
          "UPDATE outbox SET state = 'inflight', lease_until = ?, updated_at = ? WHERE k = ?",
          [t + config.leaseMs, _iso(t), r.k],
        );
      }
      return rows;
    });
  }

  /// Server verdict received — the only way an op leaves the queue.
  void ack(String k) => _db.execute('DELETE FROM outbox WHERE k = ?', [k]);

  /// Send failed: exponential backoff with jitter; after maxAttempts → blocked.
  /// [retryAfterMs] (HTTP 429 / Retry-After) overrides the computed delay when larger.
  ///
  /// Row 119: a [transient] failure (no network, timeout, 429, 5xx, draining) never blocks
  /// the op — an outage of any length must not park the whole queue; the delay stays capped at
  /// `maxBackoffMs` (with jitter, so devices do not return in lockstep).
  FailResult fail(
    String k, {
    String? error,
    int? now,
    int? retryAfterMs,
    bool transient = false,
  }) {
    final t = now ?? _nowMs();
    return _tx(() {
      final rs = _db.select('SELECT attempts FROM outbox WHERE k = ?', [k]);
      if (rs.isEmpty) return const FailResult(ok: false);
      final attempts = (rs.first['attempts'] as int) + 1;
      final msg = (error ?? 'send_failed');
      final lastError = msg.length > 200 ? msg.substring(0, 200) : msg;
      OpState state;
      int nextAt;
      if (attempts >= config.maxAttempts && !transient) {
        state = OpState.blocked;
        nextAt = 0;
      } else {
        final backoff = min(
          config.baseBackoffMs * pow(2, min(attempts - 1, 30)),
          config.maxBackoffMs,
        ).toDouble();
        final j = config.jitter.clamp(0.0, 0.9);
        final factor = 1 - j + _random.nextDouble() * j;
        var delay = max(1, (backoff * factor).round());
        if (retryAfterMs != null && retryAfterMs > delay) delay = retryAfterMs;
        state = OpState.pending;
        nextAt = t + delay;
      }
      _db.execute(
        'UPDATE outbox SET attempts = ?, last_error = ?, updated_at = ?, lease_until = 0, '
        'state = ?, next_at = ? WHERE k = ?',
        [attempts, lastError, _iso(t), state.name, nextAt, k],
      );
      return FailResult(
        ok: true,
        state: state,
        attempts: attempts,
        nextAt: nextAt,
      );
    });
  }

  /// Returns leased ops to pending without counting an attempt (e.g. to re-split a batch).
  void release(Iterable<String> keys) {
    _tx(() {
      for (final k in keys) {
        _db.execute(
          "UPDATE outbox SET state = 'pending', lease_until = 0 WHERE k = ? AND state = 'inflight'",
          [k],
        );
      }
    });
  }

  /// After a restart: inflight ops whose lease expired go back to pending.
  int recover([int? now]) {
    final t = now ?? _nowMs();
    _db.execute(
      "UPDATE outbox SET state = 'pending', lease_until = 0, updated_at = ? "
      "WHERE state = 'inflight' AND lease_until <= ?",
      [_iso(t), t],
    );
    return _db.updatedRows;
  }

  /// Connectivity is back (row 119): pending ops become due now. Attempts are kept, so a
  /// failing server still sees exponential backoff — only the waiting time is cut short.
  int wake([int? now]) {
    final t = now ?? _nowMs();
    _db.execute(
      "UPDATE outbox SET next_at = 0, updated_at = ? WHERE state = 'pending' AND next_at > ?",
      [_iso(t), t],
    );
    return _db.updatedRows;
  }

  /// Manual retry of a (blocked) op.
  bool retry(String k) {
    _db.execute(
      "UPDATE outbox SET state = 'pending', attempts = 0, next_at = 0, lease_until = 0 WHERE k = ?",
      [k],
    );
    return _db.updatedRows == 1;
  }

  List<OutboxOp> list({OpState? state}) =>
      (state == null
              ? _db.select('SELECT * FROM outbox ORDER BY seq')
              : _db.select(
                  'SELECT * FROM outbox WHERE state = ? ORDER BY seq',
                  [state.name],
                ))
          .map(_op)
          .toList();

  OutboxOp? get(String k) {
    final rs = _db.select('SELECT * FROM outbox WHERE k = ?', [k]);
    return rs.isEmpty ? null : _op(rs.first);
  }

  OutboxStats stats() {
    int c(String s) =>
        _db.select('SELECT COUNT(*) AS n FROM outbox WHERE state = ?', [
              s,
            ]).first['n']
            as int;
    final total =
        _db.select('SELECT COUNT(*) AS n FROM outbox').first['n'] as int;
    return OutboxStats(
      total: total,
      pending: c('pending'),
      inflight: c('inflight'),
      blocked: c('blocked'),
      capacity: config.capacity,
    );
  }

  /// Send loop: claim → send → ack/fail. Same verdict routing as the web outbox.
  ///
  /// Request-level failures ([SyncFailure]): `body_too_large` halves the batch and retries
  /// (down to one op, then fails it); every other failure fails the whole batch with backoff
  /// (honouring `retryAfterMs`) and stops the loop — ops are never dropped.
  Future<DrainResult> drain(
    PushSender send, {
    int? now,
    int? limit,
    VerdictHook? onApplied,
    VerdictHook? onRejected,
    VerdictHook? onConflict,
  }) async {
    var lim = limit ?? config.batchLimit;
    final res = DrainResult();
    for (;;) {
      final t = now ?? _nowMs();
      final batch = claim(lim, t);
      if (batch.isEmpty) break;
      res.batches++;
      res.claimed += batch.length;
      PushVerdicts verdicts;
      try {
        verdicts = await send(batch.map((o) => o.toWire()).toList());
      } on SyncFailure catch (e) {
        if (e.code == PayeshErrorCode.payloadTooLarge && batch.length > 1) {
          release(batch.map((o) => o.k));
          res.claimed -= batch.length;
          lim = max(1, batch.length ~/ 2);
          continue;
        }
        final reason = e.code != null && e.code != PayeshErrorCode.unknown
            ? e.code!.wire
            : (e.status != null
                  ? e.message
                  : (e.message == 'timeout' ? 'timeout' : 'network'));
        _failAll(batch, reason, t, res, e.retryAfterMs, isTransient(e));
        res.stopped = reason;
        break;
      } catch (e) {
        _failAll(batch, _msg(e), t, res, null, true);
        res.stopped = 'network';
        break;
      }
      for (final op in batch) {
        final r = verdicts.rejected[op.k];
        final c = verdicts.conflicts[op.k];
        final a = verdicts.applied[op.k];
        if (r != null) {
          res.rejected++;
          onRejected?.call(op, r);
          ack(op.k);
        } else if (c != null) {
          res.conflicts++;
          onConflict?.call(op, c);
          ack(op.k);
        } else if (a != null) {
          res.applied++;
          onApplied?.call(op, a);
          ack(op.k);
        } else {
          fail(op.k, error: 'no_verdict', now: t);
          res.failed++;
        }
      }
    }
    return res;
  }

  void _failAll(
    List<OutboxOp> batch,
    String error,
    int t,
    DrainResult res,
    int? retryAfterMs,
    bool transient,
  ) {
    for (final op in batch) {
      final f = fail(
        op.k,
        error: error,
        now: t,
        retryAfterMs: retryAfterMs,
        transient: transient,
      );
      res.failed++;
      if (f.nextAt > 0) res.retryAt = max(res.retryAt ?? 0, f.nextAt);
    }
  }

  /// Request-level failures that say nothing about the ops themselves (row 119): no response
  /// at all, timeout, 408, 429, any 5xx, a draining instance or a tenant write-freeze.
  static bool isTransient(SyncFailure e) {
    final st = e.status;
    if (st == null) return true;
    if (st == 408 || st == 429 || st >= 500) return true;
    final m = e.message;
    return m == 'write_frozen' || m == 'draining';
  }

  static String _msg(Object e) {
    final s = e.toString();
    return s.startsWith('Exception: ') ? s.substring(11) : s;
  }
}
