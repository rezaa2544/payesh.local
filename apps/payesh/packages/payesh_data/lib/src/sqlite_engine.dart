import 'dart:convert';

import 'package:sqlite3/sqlite3.dart';

import 'engine.dart';
import 'migrations.dart';

/// SQLite implementation of [DataEngine].
///
/// Ordering note: SQLite BINARY collation compares UTF-8 bytes (= code point order); IndexedDB
/// compares UTF-16 code units. They agree for every key made of BMP characters below U+E000,
/// which covers all `collection/id` keys and ISO timestamps used by Payesh.
final class SqliteEngine implements DataEngine {
  SqliteEngine._(this._db, {String Function()? now})
    : _now = now ?? (() => DateTime.now().toUtc().toIso8601String());

  /// Opens (and migrates) a database file.
  factory SqliteEngine.open(String path, {String Function()? now}) =>
      SqliteEngine._(sqlite3.open(path), now: now).._init();

  /// Opens a private in-memory database (tests, previews).
  factory SqliteEngine.inMemory({String Function()? now}) =>
      SqliteEngine._(sqlite3.openInMemory(), now: now).._init();

  /// Wraps an already-open database (e.g. one opened with an encryption key, row 72).
  factory SqliteEngine.wrap(Database db, {String Function()? now}) =>
      SqliteEngine._(db, now: now).._init();

  final Database _db;
  final String Function() _now;
  int _writes = 0;
  int _reads = 0;

  Database get database => _db;

  int get schemaVersion => _db.userVersion;

  void _init() {
    _db.execute('PRAGMA foreign_keys = ON');
    migrate(_db);
  }

  /// Applies pending [migrations]; returns the versions applied.
  static List<int> migrate(Database db, {List<Migration>? steps}) {
    final all = steps ?? migrations;
    final latest = all.isEmpty ? 0 : all.last.version;
    final current = db.userVersion;
    if (current > latest) throw SchemaTooNewException(current, latest);
    final applied = <int>[];
    for (final m in all.where((m) => m.version > current)) {
      db.execute('BEGIN IMMEDIATE');
      try {
        for (final s in m.statements) {
          db.execute(s);
        }
        db.userVersion = m.version;
        db.execute('COMMIT');
        applied.add(m.version);
      } catch (_) {
        db.execute('ROLLBACK');
        rethrow;
      }
    }
    return applied;
  }

  EngineRow _row(Row r) => EngineRow(
    collection: r['collection'] as String,
    id: r['id'] as int,
    data: (jsonDecode(r['data'] as String) as Map).cast<String, Object?>(),
    version: r['version'] as int,
    refKeys: _refsOf(r['k'] as String),
    updatedAt: r['updated_at'] as String,
  );

  List<String> _refsOf(String k) => _db
      .select('SELECT ref FROM ref_keys WHERE k = ? ORDER BY ref', [k])
      .map((r) => r['ref'] as String)
      .toList();

  void _write(
    String collection,
    int id,
    Map<String, Object?> data,
    int version,
    List<String>? refFields,
    String updatedAt,
  ) {
    final k = EngineRow.keyOf(collection, id);
    _db.execute(
      'INSERT INTO rows (k, collection, id, data, version, updated_at) VALUES (?, ?, ?, ?, ?, ?) '
      'ON CONFLICT (k) DO UPDATE SET collection = excluded.collection, id = excluded.id, '
      'data = excluded.data, version = excluded.version, updated_at = excluded.updated_at',
      [k, collection, id, jsonEncode(data), version, updatedAt],
    );
    _db.execute('DELETE FROM ref_keys WHERE k = ?', [k]);
    for (final ref in refKeysOf(data, refFields).toSet()) {
      _db.execute(
        'INSERT INTO ref_keys (ref, k, collection) VALUES (?, ?, ?)',
        [ref, k, collection],
      );
    }
  }

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

  @override
  Future<EngineRow> put(
    String collection,
    int id,
    Map<String, Object?> data, {
    int version = 1,
    List<String>? refFields,
    String? updatedAt,
  }) async {
    final at = updatedAt ?? _now();
    _writes++;
    _tx(() => _write(collection, id, data, version, refFields, at));
    return EngineRow(
      collection: collection,
      id: id,
      data: data,
      version: version,
      refKeys: refKeysOf(data, refFields),
      updatedAt: at,
    );
  }

  @override
  Future<int> putMany(List<RowInput> rows, {List<String>? refFields}) async {
    if (rows.isEmpty) return 0;
    _writes += rows.length;
    final now = _now();
    _tx(() {
      for (final r in rows) {
        _write(
          r.collection,
          r.id,
          r.data,
          r.version,
          r.refFields ?? refFields,
          r.updatedAt ?? now,
        );
      }
    });
    return rows.length;
  }

  @override
  Future<int> loadChunked(
    List<RowInput> rows, {
    int chunk = 2000,
    List<String>? refFields,
    void Function(int done, int total)? onProgress,
  }) async {
    var done = 0;
    for (var i = 0; i < rows.length; i += chunk) {
      final end = i + chunk > rows.length ? rows.length : i + chunk;
      await putMany(rows.sublist(i, end), refFields: refFields);
      done = end;
      onProgress?.call(done, rows.length);
    }
    return done;
  }

  @override
  Future<void> del(String collection, int id) async {
    _writes++;
    _db.execute('DELETE FROM rows WHERE k = ?', [
      EngineRow.keyOf(collection, id),
    ]);
  }

  @override
  Future<void> clear() async {
    _tx(() {
      _db.execute('DELETE FROM ref_keys');
      _db.execute('DELETE FROM rows');
    });
  }

  @override
  Future<EngineRow?> get(String collection, int id) async {
    _reads++;
    final rs = _db.select('SELECT * FROM rows WHERE k = ?', [
      EngineRow.keyOf(collection, id),
    ]);
    return rs.isEmpty ? null : _row(rs.first);
  }

  @override
  Future<int> count([String? collection]) async {
    _reads++;
    final rs = collection == null
        ? _db.select('SELECT COUNT(*) AS n FROM rows')
        : _db.select('SELECT COUNT(*) AS n FROM rows WHERE collection = ?', [
            collection,
          ]);
    return rs.first['n'] as int;
  }

  @override
  Future<List<EngineRow>> list(
    String collection, {
    int limit = 100,
    int offset = 0,
  }) async {
    _reads++;
    return _db
        .select(
          'SELECT * FROM rows WHERE collection = ? ORDER BY k LIMIT ? OFFSET ?',
          [collection, limit, offset],
        )
        .map(_row)
        .toList();
  }

  @override
  Future<List<EngineRow>> byRef(
    String collection,
    String field,
    Object value,
  ) async {
    _reads++;
    return _db
        .select(
          'SELECT r.* FROM ref_keys x JOIN rows r ON r.k = x.k '
          'WHERE x.ref = ? AND x.collection = ? ORDER BY x.k',
          ['$field:${jsString(value)}', collection],
        )
        .map(_row)
        .toList();
  }

  @override
  Future<List<EngineRow>> since(
    String collection,
    String isoTime, {
    int limit = 1000,
  }) async {
    _reads++;
    return _db
        .select(
          'SELECT * FROM rows WHERE collection = ? AND updated_at >= ? '
          'ORDER BY updated_at, k LIMIT ?',
          [collection, isoTime, limit],
        )
        .map(_row)
        .toList();
  }

  @override
  Future<EngineStats> stats() async {
    final total = await count();
    final per = <String, int>{
      for (final r in _db.select(
        'SELECT collection, COUNT(*) AS n FROM rows GROUP BY collection ORDER BY collection',
      ))
        r['collection'] as String: r['n'] as int,
    };
    return EngineStats(
      total: total,
      collections: per,
      writes: _writes,
      reads: _reads,
    );
  }

  @override
  void close() => _db.close();
}
