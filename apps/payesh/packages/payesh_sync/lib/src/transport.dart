import 'outbox.dart';

/// One page of `GET /api/v1/pull` (Sync v1).
final class PullPage {
  const PullPage({
    required this.schemaVersion,
    required this.serverTime,
    required this.nextSince,
    required this.nextId,
    required this.more,
    required this.collections,
    required this.deleted,
  });

  factory PullPage.fromJson(Map<String, Object?> j) => PullPage(
    schemaVersion: (j['schema_version'] as num?)?.toInt() ?? 0,
    serverTime: '${j['server_time'] ?? ''}',
    nextSince: j['next_since'] as String?,
    nextId: (j['next_id'] as num?)?.toInt() ?? 0,
    more: j['more'] == true,
    collections: {
      for (final e in ((j['collections'] as Map?) ?? const {}).entries)
        '${e.key}': [
          for (final r in (e.value as List<Object?>? ?? const []))
            if (r is Map) r.cast<String, Object?>(),
        ],
    },
    deleted: [
      for (final d in (j['deleted'] as List<Object?>? ?? const []))
        if (d is Map) d.cast<String, Object?>(),
    ],
  );

  final int schemaVersion;
  final String serverTime;
  final String? nextSince;
  final int nextId;
  final bool more;
  final Map<String, List<Map<String, Object?>>> collections;
  final List<Map<String, Object?>> deleted;
}

/// Network boundary of the sync client. Failures are reported as [SyncFailure].
abstract interface class SyncTransport {
  Future<PullPage> pull({
    required String since,
    required int sinceId,
    List<String>? collections,
  });

  Future<PushVerdicts> push(List<Map<String, Object?>> ops);
}
