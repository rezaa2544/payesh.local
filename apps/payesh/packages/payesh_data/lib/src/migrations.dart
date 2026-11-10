/// Versioned, forward-only schema migrations for the local SQLite store.
///
/// `PRAGMA user_version` records the applied version. Each step runs inside one transaction;
/// a database newer than [latestSchemaVersion] is refused (no silent downgrade).
final class Migration {
  const Migration(this.version, this.description, this.statements);
  final int version;
  final String description;
  final List<String> statements;
}

const List<Migration> migrations = [
  Migration(1, 'rows + ref index + (collection, updated_at) index', [
    '''
CREATE TABLE IF NOT EXISTS rows (
  k TEXT NOT NULL PRIMARY KEY,
  collection TEXT NOT NULL,
  id INTEGER NOT NULL,
  data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
) WITHOUT ROWID''',
    'CREATE INDEX IF NOT EXISTS rows_collection ON rows (collection, k)',
    'CREATE INDEX IF NOT EXISTS rows_updated ON rows (collection, updated_at, k)',
    '''
CREATE TABLE IF NOT EXISTS ref_keys (
  ref TEXT NOT NULL,
  k TEXT NOT NULL REFERENCES rows (k) ON DELETE CASCADE,
  collection TEXT NOT NULL,
  PRIMARY KEY (ref, k)
) WITHOUT ROWID''',
    'CREATE INDEX IF NOT EXISTS ref_keys_k ON ref_keys (k)',
  ]),
  Migration(2, 'engine metadata (key/value)', [
    '''
CREATE TABLE IF NOT EXISTS meta (
  key TEXT NOT NULL PRIMARY KEY,
  value TEXT
) WITHOUT ROWID''',
  ]),
];

int get latestSchemaVersion => migrations.last.version;

/// Thrown when the on-disk schema is newer than this build understands.
final class SchemaTooNewException implements Exception {
  const SchemaTooNewException(this.found, this.supported);
  final int found;
  final int supported;
  @override
  String toString() =>
      'SchemaTooNewException: database schema v$found > supported v$supported';
}
