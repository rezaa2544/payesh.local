import 'dart:io';

import 'package:payesh_data/payesh_data.dart';
import 'package:sqlite3/sqlite3.dart';
import 'package:test/test.dart';

void main() {
  group('migrations', () {
    test('fresh database is migrated to the latest schema', () {
      final e = SqliteEngine.inMemory();
      addTearDown(e.close);
      expect(e.schemaVersion, latestSchemaVersion);
      expect(latestSchemaVersion, 2);
    });

    test('v1 database with data migrates to v2 and keeps rows', () async {
      final db = sqlite3.openInMemory();
      expect(SqliteEngine.migrate(db, steps: migrations.take(1).toList()), [1]);
      db.execute(
        'INSERT INTO rows (k, collection, id, data, version, updated_at) '
        "VALUES ('a/1', 'a', 1, ?, 1, '2026-01-01T00:00:00.000Z')",
        ['{"id":1}'],
      );
      final e = SqliteEngine.wrap(db);
      addTearDown(e.close);
      expect(e.schemaVersion, 2);
      expect((await e.get('a', 1))!.data, {'id': 1});
      expect(SqliteEngine.migrate(db), isEmpty, reason: 'idempotent');
    });

    test('database newer than this build is refused (no silent downgrade)', () {
      final db = sqlite3.openInMemory()..userVersion = 99;
      addTearDown(db.close);
      expect(
        () => SqliteEngine.migrate(db),
        throwsA(
          isA<SchemaTooNewException>().having((x) => x.found, 'found', 99),
        ),
      );
    });

    test('a failing migration rolls back completely', () {
      final db = sqlite3.openInMemory();
      addTearDown(db.close);
      final broken = [
        ...migrations,
        const Migration(3, 'broken', [
          'CREATE TABLE half (x INTEGER)',
          'THIS IS NOT SQL',
        ]),
      ];
      expect(() => SqliteEngine.migrate(db, steps: broken), throwsA(anything));
      expect(db.userVersion, 2);
      expect(
        db.select("SELECT name FROM sqlite_master WHERE name = 'half'"),
        isEmpty,
      );
    });
  });

  group('engine', () {
    test('rows survive close/reopen of a database file', () async {
      final dir = Directory.systemTemp.createTempSync('payesh_data_');
      addTearDown(() => dir.deleteSync(recursive: true));
      final path = '${dir.path}/p.db';
      final a = SqliteEngine.open(path);
      await a.put('attendance', 1, {
        'id': 1,
        'class_id': 2,
      }, updatedAt: '2026-11-01T00:00:00.000Z');
      a.close();
      final b = SqliteEngine.open(path);
      addTearDown(b.close);
      final r = await b.get('attendance', 1);
      expect(r!.refKeys, ['class_id:2', 'id:1']);
      expect((await b.byRef('attendance', 'class_id', 2)).single.id, 1);
    });

    test('default updated_at comes from the injected clock', () async {
      final e = SqliteEngine.inMemory(now: () => '2030-01-01T00:00:00.000Z');
      addTearDown(e.close);
      final r = await e.put('x', 1, {});
      expect(r.updatedAt, '2030-01-01T00:00:00.000Z');
      expect((await e.get('x', 1))!.updatedAt, '2030-01-01T00:00:00.000Z');
      await e.putMany([const RowInput(collection: 'x', id: 2)]);
      expect((await e.get('x', 2))!.updatedAt, '2030-01-01T00:00:00.000Z');
    });

    test('loadChunked reports progress and loads 10k rows', () async {
      final e = SqliteEngine.inMemory();
      addTearDown(e.close);
      final rows = [
        for (var i = 1; i <= 10000; i++)
          RowInput(
            collection: 'attendance',
            id: i,
            data: {'id': i, 'class_id': i % 40 + 1},
          ),
      ];
      final progress = <int>[];
      final n = await e.loadChunked(
        rows,
        chunk: 2500,
        onProgress: (d, _) => progress.add(d),
      );
      expect(n, 10000);
      expect(progress, [2500, 5000, 7500, 10000]);
      expect(await e.count('attendance'), 10000);
      expect((await e.byRef('attendance', 'class_id', 1)).length, 250);
      final st = await e.stats();
      expect(st.collections, {'attendance': 10000});
      expect(st.writes, 10000);
    });

    test('putMany of an empty list is a no-op', () async {
      final e = SqliteEngine.inMemory();
      addTearDown(e.close);
      expect(await e.putMany(const []), 0);
    });

    test('a failing batch is atomic (no partial putMany)', () async {
      final e = SqliteEngine.inMemory();
      addTearDown(e.close);
      e.database.execute(
        "CREATE TRIGGER boom BEFORE INSERT ON rows WHEN NEW.id = 3 BEGIN SELECT RAISE(ABORT, 'boom'); END",
      );
      await expectLater(
        e.putMany([
          for (var i = 1; i <= 5; i++) RowInput(collection: 'c', id: i),
        ]),
        throwsA(anything),
      );
      expect(await e.count('c'), 0);
    });
  });

  group('refKeysOf / jsString (JavaScript parity)', () {
    test('numbers stringify like JavaScript', () {
      expect(jsString(2.0), '2');
      expect(jsString(1.5), '1.5');
      expect(jsString(7), '7');
      expect(jsString(true), 'true');
      expect(jsString('x'), 'x');
    });
    test('only *_id / id fields, null and objects skipped', () {
      expect(
        refKeysOf({
          'id': 1,
          'a_id': null,
          'b_id': [1],
          'c_id': 'z',
          'name': 'n',
        }),
        ['id:1', 'c_id:z'],
      );
      expect(refKeysOf({'role': 'x', 'id': 1}, ['role']), ['role:x']);
    });
  });
}
