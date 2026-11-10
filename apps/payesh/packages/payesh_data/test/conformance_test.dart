// Runs the shared engine vectors (docs/cloud/contracts/conformance/engine-v1.json) against
// the SQLite engine. The same file runs against client/engine-web.js in
// tests/conformance-engine-70.js — passing both proves the two engines behave the same.
import 'dart:convert';
import 'dart:io';

import 'package:payesh_data/payesh_data.dart';
import 'package:test/test.dart';

const vectorsPath =
    '../../../../docs/cloud/contracts/conformance/engine-v1.json';

Map<String, Object?> norm(EngineRow r) {
  final j = r.toJson();
  j['refKeys'] = [...r.refKeys]..sort();
  return j;
}

Map<String, Object?>? normExpect(Object? e) {
  if (e == null) return null;
  final m = Map<String, Object?>.from(e as Map);
  m['refKeys'] = [
    ...((m['refKeys'] as List<Object?>?) ?? const []).cast<String>(),
  ]..sort();
  return m;
}

void main() {
  final doc =
      jsonDecode(File(vectorsPath).readAsStringSync()) as Map<String, Object?>;
  final cases = (doc['cases']! as List<Object?>).cast<Map<String, Object?>>();

  test('vector file identity', () {
    expect(doc['id'], 'engine-v1');
    expect(cases, isNotEmpty);
  });

  for (final c in cases) {
    test(c['name'], () async {
      final db = SqliteEngine.inMemory();
      addTearDown(db.close);
      final steps = (c['steps']! as List<Object?>).cast<Map<String, Object?>>();
      for (var i = 0; i < steps.length; i++) {
        final s = steps[i];
        final at = 'step $i ${s['op']}';
        final collection = s['collection'] as String?;
        switch (s['op']) {
          case 'put':
            await db.put(
              collection!,
              (s['id']! as num).toInt(),
              (s['data']! as Map).cast<String, Object?>(),
              version: (s['version'] as num?)?.toInt() ?? 1,
              refFields: (s['refFields'] as List<Object?>?)?.cast<String>(),
              updatedAt: s['updated_at'] as String?,
            );
          case 'putMany':
            final rows = (s['rows']! as List<Object?>)
                .map(
                  (r) => RowInput.fromJson((r! as Map).cast<String, Object?>()),
                )
                .toList();
            final n = await db.putMany(rows);
            if (s.containsKey('expect')) expect(n, s['expect'], reason: at);
          case 'get':
            final r = await db.get(collection!, (s['id']! as num).toInt());
            expect(
              r == null ? null : norm(r),
              normExpect(s['expect']),
              reason: at,
            );
          case 'count':
            expect(await db.count(collection), s['expect'], reason: at);
          case 'list':
            final rs = await db.list(
              collection!,
              limit: (s['limit']! as num).toInt(),
              offset: (s['offset']! as num).toInt(),
            );
            expect(rs.map((r) => r.id).toList(), s['expect_ids'], reason: at);
          case 'byRef':
            final rs = await db.byRef(
              collection!,
              s['field']! as String,
              s['value']!,
            );
            expect(rs.map((r) => r.id).toList(), s['expect_ids'], reason: at);
          case 'since':
            final rs = await db.since(
              collection!,
              s['iso']! as String,
              limit: (s['limit']! as num).toInt(),
            );
            expect(rs.map((r) => r.id).toList(), s['expect_ids'], reason: at);
          case 'del':
            await db.del(collection!, (s['id']! as num).toInt());
          case 'clear':
            await db.clear();
          case 'stats':
            final st = await db.stats();
            expect(
              {'total': st.total, 'collections': st.collections},
              s['expect'],
              reason: at,
            );
          default:
            fail('unknown op ${s['op']}');
        }
      }
    });
  }
}
