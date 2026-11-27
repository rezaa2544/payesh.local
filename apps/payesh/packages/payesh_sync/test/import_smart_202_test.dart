// Row 202 — a smart import: columns without a title are mapped from their values (the owner's
// file: «گرافیک · معماری» ⇒ رشته, «والدین · فقط پدر» ⇒ سرپرست, «شهر · روستا» ⇒ محل سکونت);
// a follow-up row keeps the file's values and the fields that are wrong; the final apply is
// written in chunks with progress.
import 'dart:math';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

String nid(int n) {
  final d = n.toString().padLeft(9, '0').split('').map(int.parse).toList();
  var s = 0;
  for (var i = 0; i < 9; i++) {
    s += d[i] * (10 - i);
  }
  final r = s % 11;
  return '${d.join()}${r < 2 ? r : 11 - r}';
}

Future<SchoolRecords> school() async {
  final e = SqliteEngine.inMemory();
  final ob = SqliteOutbox(e.database);
  await e.put('lookups', 1, {
    'id': 1,
    'kind': 'grade',
    'name': 'دهم',
  }, version: 1);
  await e.put('lookups', 2, {
    'id': 2,
    'kind': 'branch',
    'name': 'معماری',
  }, version: 1);
  return SchoolRecords(
    engine: e,
    outbox: ob,
    role: 'manager',
    uid: 1,
    random: Random(7),
  );
}

void main() {
  test('S202-01 untitled columns of the owner file are mapped from values', () {
    // titled columns first, then six empty columns and the five untitled ones
    final b = StringBuffer('نام,نام خانوادگی,کد ملی,موبایل پدر,,,,,,,,,,,\n');
    final vals = [
      ['گرافیک', 'در قید حیات', 'والدین', 'بلی', 'شهر'],
      ['معماری', 'فوت شده', 'فقط پدر', 'خیر', 'روستا'],
      ['گرافیک', 'در قید حیات', 'والدین', 'خیر', 'شهر'],
    ];
    for (final (i, v) in vals.indexed) {
      b.writeln(
        '${['علی', 'رضا', 'حسن'][i]},احمدی,${nid(100 + i)},0912000000$i,,,,,,,${v.join(',')}',
      );
    }
    final s = ImportSession.fromBook(
      SheetReader.csv(b.toString()),
      kind: 'students',
      fileName: 'o.xlsx',
      grades: const ['دهم'],
    );
    expect(s.map.sublist(0, 4), [
      'first_name',
      'last_name',
      'national_id',
      'father_phone',
    ]);
    expect(s.map.sublist(4, 10), everyElement(''));
    expect(s.map[10], 'field');
    expect(s.map[11], 'guardian_alive'); // next to «سرپرست»
    expect(s.map[12], 'guardian');
    expect(s.map[13], 'covered');
    expect(s.map[14], 'residence');
    expect(s.detected, {10, 11, 12, 13, 14});
    expect(s.headers[10], 'ستون ۱۱');
  });

  test('S202-02 a file with no title row at all is mapped from values', () {
    const names = [
      'محمد رضایی',
      'علی کریمی',
      'حسین موسوی',
      'رضا احمدی',
      'مهدی نوری',
      'امیر صالحی',
    ];
    final b = StringBuffer();
    for (var i = 0; i < 6; i++) {
      b.writeln(
        '${i + 1},${names[i]},${nid(300 + i)},۱۳۸۸/۰۲/۱$i,پسر,دهم,'
        'الکترونیک,0935123456$i,${['حسن', 'جواد', 'کریم', 'صادق', 'یوسف', 'ناصر'][i]},${nid(500 + i)},0936123456$i,شهر',
      );
    }
    final s = ImportSession.fromBook(
      SheetReader.csv(b.toString()),
      kind: 'students',
      fileName: 'x.xlsx',
      grades: const ['دهم'],
    );
    expect(s.headerRow, 0);
    expect(s.rows.length, 6, reason: 'the first row is data, not titles');
    expect(s.map, [
      '', // ردیف 1, 2, 3 …
      'full_name',
      'national_id',
      'birth_date',
      'gender',
      'grade',
      'field',
      'phone',
      'father_name',
      'father_nid',
      'father_phone',
      'residence',
    ]);
  });

  test('S202-03 a data row with a title-like cell is still data', () {
    final s = ImportSession.fromBook(
      SheetReader.csv(
        'زهرا کریمی,${nid(1)},فقط پدر\n'
        'سارا موسوی,${nid(2)},والدین\n',
      ),
      kind: 'students',
      fileName: 'x.csv',
      grades: const ['دهم'],
    );
    expect(s.rows.length, 2);
    expect(s.map, ['full_name', 'national_id', 'guardian']);
  });

  test('S202-04 reasons point at their fields; informing ones at none', () {
    expect(
      importReasonFields(
        'کد ملی مادر «38409918467» معتبر نیست — باید دقیقاً ۱۰ رقم باشد',
      ),
      ['mother_nid'],
    );
    expect(importReasonFields('کد ملی «12345» معتبر نیست'), ['national_id']);
    expect(
      importReasonFields(
        'موبایل پدر «912345678» ۹ رقم است؛ با صفرِ اول «0912345678» می‌شود و هنوز یک رقم کم دارد',
      ),
      ['father_phone'],
    );
    expect(
      importReasonFields(
        'برای مادر نه شمارهٔ همراه هست نه کد ملی — بعداً کامل کنید',
      ),
      ['mother_phone', 'mother_nid'],
    );
    expect(importReasonFields('بدون کد ملی'), ['national_id']);
    expect(importReasonFields('قبلاً ثبت شده — به‌روزرسانی می‌شود'), isEmpty);
    expect(importReasonFields('کلاس «دهم معماری» ساخته می‌شود'), isEmpty);
    expect(
      importReasonFields(
        'موبایل پدر «9121234567» با صفرِ اول «09121234567» می‌شود — ثبت می‌شود.',
      ),
      isEmpty,
    );
    expect(importReasonFields('تاریخ تولد «۱۳۸۸/۱۳/۰۱» خوانده نشد'), [
      'birth_date',
    ]);
    expect(
      importReasonValue('کد ملی مادر «38409918467» معتبر نیست'),
      '38409918467',
    );
  });

  test(
    'S202-05 a follow-up row keeps the raw values and the wrong fields',
    () async {
      final db = await school();
      final s = ImportSession.fromBook(
        SheetReader.csv(
          'نام و نام خانوادگی,کد ملی,رشته,کد ملی مادر,موبایل پدر\n'
          'آرسین مولایی,${nid(77)},معماری,38409918467,09121112233\n'
          'سالم سالمی,${nid(78)},معماری,${nid(79)},09121112234\n',
        ),
        kind: 'students',
        fileName: 'f.xlsx',
        grades: const ['دهم'],
      );
      final r = await SchoolImport(db).check(s);
      final bad = r.rows.firstWhere((x) => x.name == 'آرسین مولایی');
      expect(bad.problems.keys, ['mother_nid']);
      // the parent nid only blocks the row: fix it in place, then the import goes on
      expect(bad.ready, isFalse);
      final stages = <String>[];
      var last = (0, 0);
      final res = await SchoolImport(
        db,
        onProgress: (st, d, t) {
          if (!stages.contains(st)) stages.add(st);
          if (st == 'write') last = (d, t);
        },
      ).apply(s, r);
      expect(stages, ['prepare', 'write']);
      expect(last.$1, last.$2);
      expect(last.$2, res.keys.length);
      final view = await Followup(db).view();
      final i = view.issues.firstWhere((x) => x.name == 'آرسین مولایی');
      expect(i.fields.keys, ['mother_nid']);
      expect(i.raw['mother_nid'], '38409918467');
      expect(i.raw['field'], 'معماری');
    },
  );

  test(
    'S202-06 putAll: chunks, one key per row, all queued then stored',
    () async {
      final db = await school();
      final rows = [
        for (var i = 0; i < 250; i++)
          ('users', 10 + i, <String, Object?>{'n': i}, null),
      ];
      final seen = <(int, int)>[];
      final keys = await db.putAll(
        rows.cast<(String, int, Map<String, Object?>, EngineRow?)>(),
        chunk: 100,
        onProgress: (d, t) => seen.add((d, t)),
      );
      expect(keys.toSet().length, 250);
      expect(seen, [(0, 250), (100, 250), (200, 250), (250, 250)]);
      expect(db.outbox.stats().pending, 250);
      expect((await db.engine.get('users', 259))!.data['n'], 249);
    },
  );
}
