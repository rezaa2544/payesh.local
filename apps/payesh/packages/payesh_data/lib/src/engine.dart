/// One stored product row — identical shape to the web engine's IndexedDB record.
final class EngineRow {
  const EngineRow({
    required this.collection,
    required this.id,
    required this.data,
    required this.version,
    required this.refKeys,
    required this.updatedAt,
  });

  final String collection;
  final int id;
  final Map<String, Object?> data;
  final int version;
  final List<String> refKeys;

  /// ISO-8601 UTC timestamp string (stored and compared as text, like the web engine).
  final String updatedAt;

  /// Primary key `collection/id`.
  String get k => keyOf(collection, id);

  static String keyOf(String collection, int id) => '$collection/$id';

  Map<String, Object?> toJson() => {
    'k': k,
    'collection': collection,
    'id': id,
    'data': data,
    'version': version,
    'refKeys': refKeys,
    'updated_at': updatedAt,
  };
}

/// Input for [DataEngine.putMany].
final class RowInput {
  const RowInput({
    required this.collection,
    required this.id,
    this.data = const {},
    this.version = 1,
    this.refFields,
    this.updatedAt,
  });

  factory RowInput.fromJson(Map<String, Object?> j) => RowInput(
    collection: j['collection']! as String,
    id: (j['id']! as num).toInt(),
    data: (j['data'] as Map<String, Object?>?) ?? const {},
    version: (j['version'] as num?)?.toInt() ?? 1,
    refFields: (j['refFields'] as List<Object?>?)?.cast<String>(),
    updatedAt: j['updated_at'] as String?,
  );

  final String collection;
  final int id;
  final Map<String, Object?> data;
  final int version;
  final List<String>? refFields;
  final String? updatedAt;
}

/// Counters reported by [DataEngine.stats].
final class EngineStats {
  const EngineStats({
    required this.total,
    required this.collections,
    required this.writes,
    required this.reads,
  });
  final int total;
  final Map<String, int> collections;
  final int writes;
  final int reads;
}

/// The client data engine contract (mirrors `client/engine-web.js`).
abstract interface class DataEngine {
  Future<EngineRow> put(
    String collection,
    int id,
    Map<String, Object?> data, {
    int version = 1,
    List<String>? refFields,
    String? updatedAt,
  });
  Future<int> putMany(List<RowInput> rows, {List<String>? refFields});
  Future<int> loadChunked(
    List<RowInput> rows, {
    int chunk = 2000,
    List<String>? refFields,
    void Function(int done, int total)? onProgress,
  });
  Future<void> del(String collection, int id);
  Future<void> clear();
  Future<EngineRow?> get(String collection, int id);

  /// Rows in [collection], or all rows when [collection] is null.
  Future<int> count([String? collection]);

  /// Page of [collection] ordered by primary key string (IndexedDB order).
  Future<List<EngineRow>> list(
    String collection, {
    int limit = 100,
    int offset = 0,
  });

  /// Rows of [collection] whose `field` equals [value] (ref index), ordered by key.
  Future<List<EngineRow>> byRef(String collection, String field, Object value);

  /// Rows of [collection] changed at or after [isoTime], ordered by (updated_at, key).
  Future<List<EngineRow>> since(
    String collection,
    String isoTime, {
    int limit = 1000,
  });
  Future<EngineStats> stats();
  void close();
}

final RegExp _refField = RegExp(r'_id$|^id$');

/// Same rule as `refKeysOf` in engine-web.js: fields ending in `_id` (or `id`) unless
/// [refFields] is given; null and object/array values are skipped; values are stringified
/// the way JavaScript template literals do.
List<String> refKeysOf(Map<String, Object?> data, [List<String>? refFields]) {
  final fields = refFields ?? data.keys.where(_refField.hasMatch).toList();
  final out = <String>[];
  for (final f in fields) {
    final v = data[f];
    if (v == null || v is Map || v is List) continue;
    out.add('$f:${jsString(v)}');
  }
  return out;
}

/// JavaScript `String(v)` for JSON scalars (2.0 → "2", true → "true").
String jsString(Object v) {
  if (v is double) {
    if (v.isFinite && v == v.truncateToDouble() && v.abs() < 1e21) {
      return v.toInt().toString();
    }
    return v.toString();
  }
  return v.toString();
}
