import 'dart:io';

import 'package:payesh_data/payesh_data.dart';

import 'http_transport.dart';
import 'outbox.dart';
import 'pinning.dart';
import 'sync_client.dart'
    show
        PullResult,
        ReviewItem,
        SyncProtocolException,
        addReview,
        ensureReviewTable,
        readReview;

/// One row of the Gateway change feed (`GET /api/gw/v1/pull`).
final class GatewayRow {
  const GatewayRow({
    required this.seq,
    required this.collection,
    required this.id,
    required this.op,
    required this.version,
    required this.data,
  });
  factory GatewayRow.fromJson(Map<String, Object?> j) => GatewayRow(
    seq: (j['seq'] as num?)?.toInt() ?? 0,
    collection: '${j['collection'] ?? ''}',
    id: (j['id'] as num?)?.toInt() ?? 0,
    op: '${j['op'] ?? 'put'}',
    version: (j['version'] as num?)?.toInt() ?? 1,
    data: j['data'] is Map ? (j['data']! as Map).cast<String, Object?>() : null,
  );
  final int seq;
  final String collection;
  final int id;
  final String op;
  final int version;
  final Map<String, Object?>? data;
}

final class GatewayPage {
  const GatewayPage({
    required this.schemaVersion,
    required this.rows,
    required this.more,
    required this.nextSeq,
  });
  factory GatewayPage.fromJson(Map<String, Object?> j) => GatewayPage(
    schemaVersion: (j['schema_version'] as num?)?.toInt() ?? 0,
    rows: [
      for (final r in (j['rows'] as List<Object?>? ?? const []))
        if (r is Map) GatewayRow.fromJson(r.cast<String, Object?>()),
    ],
    more: j['more'] == true,
    nextSeq: (j['next_seq'] as num?)?.toInt() ?? 0,
  );
  final int schemaVersion;
  final List<GatewayRow> rows;
  final bool more;
  final int nextSeq;
}

/// The cloud data path of the native app (row 75, constitution clause 25 / D‑36):
/// the stateless Gateway only — never a database or object-storage endpoint.
///
/// Every request carries the client version header, a fresh UUIDv4 request id, the device id
/// and the bearer token; with [GatewayTransport.pinned] the TLS key is pinned (primary +
/// backup) before any byte is sent.
final class GatewayTransport {
  GatewayTransport({
    required Uri baseUri,
    required String Function() token,
    required String deviceId,
    HttpClient? client,
    Duration timeout = const Duration(seconds: 30),
    String Function()? requestId,
  }) : _http = HttpSyncTransport(
         baseUri: baseUri,
         token: token,
         deviceId: deviceId,
         client: client,
         timeout: timeout,
         requestId: requestId,
       );

  /// Production constructor: https + SPKI pinning from [config].
  factory GatewayTransport.pinned(
    GatewayConfig config, {
    required String Function() token,
    required String deviceId,
    SecurityContext? context,
    Duration timeout = const Duration(seconds: 30),
  }) => GatewayTransport(
    baseUri: config.baseUri,
    token: token,
    deviceId: deviceId,
    client: createPinnedHttpClient(config, context: context),
    timeout: timeout,
  );

  final HttpSyncTransport _http;

  String? get lastRequestId => _http.lastRequestId;

  Future<GatewayPage> pull({
    int sinceSeq = 0,
    int limit = 200,
    String? collection,
  }) async {
    final uri = _http.baseUri
        .resolve('/api/gw/v1/pull')
        .replace(
          queryParameters: {
            'since_seq': '$sinceSeq',
            'limit': '$limit',
            'collection': ?collection,
          },
        );
    return GatewayPage.fromJson(await _http.send('GET', uri, null));
  }

  /// Gateway verdicts are mapped onto the outbox contract: `duplicates` count as applied
  /// (`duplicate: true`), `conflicts` as conflicts. Plugs into [SqliteOutbox.drain].
  Future<PushVerdicts> push(List<Map<String, Object?>> ops) async {
    final j = await _http.send(
      'POST',
      _http.baseUri.resolve('/api/gw/v1/push'),
      {'ops': ops},
    );
    List<Object?> l(String k) => (j[k] as List<Object?>?) ?? const [];
    return PushVerdicts.fromJson({
      'applied': [
        ...l('applied'),
        for (final d in l('duplicates'))
          if (d is Map) {...d.cast<String, Object?>(), 'duplicate': true},
      ],
      'conflicts': l('conflicts'),
      'rejected': l('rejected'),
    });
  }

  void close() => _http.close();
}

/// Applies the Gateway change feed to the local engine; cursor `gw.since_seq` in `meta`.
final class GatewaySync {
  GatewaySync({
    required this.engine,
    required this.transport,
    this.pageSize = 200,
    this.maxPages = 10000,
  });

  static const String cursorKey = 'gw.since_seq';
  final SqliteEngine engine;
  final GatewayTransport transport;
  final int pageSize;
  final int maxPages;

  int get cursor {
    final rs = engine.database.select('SELECT value FROM meta WHERE key = ?', [
      cursorKey,
    ]);
    return rs.isEmpty ? 0 : int.tryParse('${rs.first['value']}') ?? 0;
  }

  void _save(int seq) => engine.database.execute(
    'INSERT INTO meta (key, value) VALUES (?, ?) '
    'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    [cursorKey, '$seq'],
  );

  /// Pushes [outbox] through the Gateway with a durable review log (row 119, D‑28):
  /// * `rejected` → review item, op leaves the queue;
  /// * `conflict` → our version is kept in the review list (never auto-resolved; the server
  ///   version arrives with the next pull) and later queued edits of the same record move to
  ///   review as `superseded` instead of being sent blind.
  Future<DrainResult> push(
    SqliteOutbox outbox, {
    int? now,
    VerdictHook? onApplied,
  }) async {
    final db = engine.database;
    ensureReviewTable(db);
    String iso() => DateTime.now().toUtc().toIso8601String();
    final conflicts = <(OutboxOp, Map<String, Object?>)>[];
    final res = await outbox.drain(
      transport.push,
      now: now,
      onApplied: onApplied,
      onRejected: (op, v) => addReview(
        db,
        ReviewItem(
          kind: 'rejected',
          uid: op.k,
          at: iso(),
          collection: op.collection,
          id: op.id,
          local: op.payload,
          error: (v['error'] as String?) ?? 'rejected',
        ),
      ),
      onConflict: (op, v) => conflicts.add((op, v)),
    );
    // one decision per record: the oldest conflicting edit is the `conflict`; later edits of the
    // same record (in the same batch or still queued) are `superseded`
    final decided = <String>{};
    for (final (op, v) in conflicts) {
      final id = (v['id'] as num?)?.toInt() ?? op.id;
      final first = decided.add('${op.collection}/$id');
      addReview(
        db,
        ReviewItem(
          kind: first ? 'conflict' : 'superseded',
          uid: op.k,
          at: iso(),
          collection: op.collection,
          id: id,
          serverVersion: (v['version'] as num?)?.toInt(),
          local: op.payload,
        ),
      );
      if (id == null || !first) continue;
      for (final later in outbox.list()) {
        if (later.collection == op.collection && later.id == id) {
          addReview(
            db,
            ReviewItem(
              kind: 'superseded',
              uid: later.k,
              at: iso(),
              collection: op.collection,
              id: id,
              local: later.payload,
            ),
          );
          outbox.ack(later.k);
        }
      }
    }
    return res;
  }

  /// Local edits waiting for an authorised human decision, oldest first.
  List<ReviewItem> review({String status = 'needs_review'}) {
    ensureReviewTable(engine.database);
    return readReview(engine.database, status: status);
  }

  Future<PullResult> pull() async {
    final res = PullResult();
    var since = cursor;
    for (;;) {
      if (res.pages >= maxPages) {
        throw SyncProtocolException('gateway pull exceeded $maxPages pages');
      }
      final page = await transport.pull(sinceSeq: since, limit: pageSize);
      res.pages++;
      if (page.schemaVersion != 1) {
        throw SyncProtocolException(
          'unsupported schema_version ${page.schemaVersion}',
        );
      }
      final puts = <RowInput>[];
      for (final r in page.rows) {
        if (r.op == 'del') {
          await engine.del(r.collection, r.id);
          res.deleted++;
        } else if (r.data != null && r.id > 0) {
          puts.add(
            RowInput(
              collection: r.collection,
              id: r.id,
              data: {...r.data!, 'id': r.id},
              version: r.version,
            ),
          );
        } else {
          res.skipped++;
        }
      }
      await engine.putMany(puts);
      res.rows += puts.length;
      if (page.nextSeq < since) {
        throw const SyncProtocolException('gateway cursor moved backwards');
      }
      if (page.more && page.nextSeq == since) {
        throw const SyncProtocolException('more=true without cursor progress');
      }
      since = page.nextSeq;
      _save(since);
      if (!page.more) break;
    }
    res.sinceId = since;
    return res;
  }
}
