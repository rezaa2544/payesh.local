// Row 201 — a smart import of branches: a word written twice, a known synonym and the same
// name written another way go under the defined branch by themselves (and are listed); a typo,
// one name inside the other and a brand-new name are asked; nothing is created silently.
import 'dart:math';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

Future<(SqliteEngine, SqliteOutbox)> seeded(List<String> branches) async {
  final e = SqliteEngine.inMemory();
  final ob = SqliteOutbox(e.database);
  var id = 1;
  Future<void> put(String c, Map<String, Object?> d) async {
    final i = id++;
    await e.put(c, i, {...d, 'id': i}, version: 1);
  }

  await put('lookups', {'kind': 'grade', 'name': 'دهم'});
  for (final b in branches) {
    await put('lookups', {'kind': 'branch', 'name': b});
  }
  return (e, ob);
}

SchoolRecords db(SqliteEngine e, SqliteOutbox ob) => SchoolRecords(
  engine: e,
  outbox: ob,
  role: 'manager',
  uid: 1,
  random: Random(5),
);

ImportSession csv(List<(String, String)> rows) => ImportSession.fromBook(
  SheetReader.csv(
    'نام,کد ملی,پایه,رشته\n'
    '${[for (final (i, (n, b)) in rows.indexed) '$n,00${(23456789 + i)},دهم,$b'].join('\n')}\n',
  ),
  kind: 'students',
  fileName: 'b.csv',
  grades: const ['دهم'],
);

const defs = ['الکتروتکنیک', 'الکترونیک', 'تاسیسات', 'تعمیر موتور', 'نقشه کشی'];

void main() {
  test('B201-01 collapse: a word written twice is written once', () {
    expect(importBranchCollapse('تعمیر موتور موتور'), 'تعمیر موتور');
    expect(importBranchCollapse('تعمیر موتورموتور'), 'تعمیر موتور');
    expect(importBranchCollapse('تعمیر  موتور'), 'تعمیر موتور');
    expect(importBranchCollapse('الکترونیک'), 'الکترونیک');
  });

  test(
    'B201-02 guess: repeat / alias / same are sure; typo, contains, new asked',
    () {
      expect(importBranchGuess('تعمیر موتورموتور', defs), (
        'تعمیر موتور',
        'repeat',
      ));
      expect(importBranchGuess('تعمیر موتور موتور', defs), (
        'تعمیر موتور',
        'repeat',
      ));
      expect(importBranchGuess('برق', defs), ('الکتروتکنیک', 'alias'));
      expect(importBranchGuess('برق صنعتی', defs), ('الکتروتکنیک', 'alias'));
      expect(importBranchGuess('معماری', defs), ('نقشه کشی', 'alias'));
      expect(importBranchGuess('نقشه‌کشی', defs), ('نقشه کشی', 'same'));
      expect(importBranchGuess('رشته تاسیسات', defs), ('تاسیسات', 'same'));
      expect(importBranchGuess('تاسیسا', defs), ('تاسیسات', 'typo'));
      expect(importBranchGuess('تاسیسات مکانیکی', defs), (
        'تاسیسات',
        'contains',
      ));
      expect(importBranchGuess('حسابداری', defs), ('', ''));
      // a synonym never points at a branch the school does not have
      expect(importBranchGuess('برق', const ['تاسیسات']).$2, isNot('alias'));
      expect(importBranchSure('repeat'), isTrue);
      expect(importBranchSure('typo'), isFalse);
    },
  );

  test(
    'B201-03 check: sure fixes are applied and listed, the rest asked',
    () async {
      final (e, ob) = await seeded(defs);
      final x = SchoolImport(db(e, ob));
      final s = csv([
        ('علی یک', 'تعمیر موتورموتور'),
        ('رضا دو', 'برق صنعتی'),
        ('سارا سه', 'معماری'),
        ('مینا چهار', 'حسابداری'),
        ('نیما پنج', 'تاسیسات مکانیکی'),
        ('امید شش', 'نقشه کشی'),
      ]);
      var r = await x.check(s);
      expect(r.branchFixes, [
        ('تعمیر موتورموتور', 'تعمیر موتور'),
        ('برق صنعتی', 'الکتروتکنیک'),
        ('معماری', 'نقشه کشی'),
      ]);
      expect(r.branchAsk, [('تاسیسات مکانیکی', 'تاسیسات')]);
      expect(r.branchNew, ['حسابداری']);
      expect(r.pendingAsks, 2);
      expect(r.branchChoices, containsAll(defs));
      expect(r.rows[0].data['field'], 'تعمیر موتور');
      expect(r.rows[1].data['field'], 'الکتروتکنیک');
      expect(r.rows[2].data['field'], 'نقشه کشی');
      // answers
      s.branchAsk['حسابداری'] = '';
      s.branchAsk['تاسیسات مکانیکی'] = 'تاسیسات';
      r = await x.check(s);
      expect(r.pendingAsks, 0);
      expect(r.rows[4].data['field'], 'تاسیسات');
      expect(
        r.rows[3].warns,
        contains('رشتهٔ «حسابداری» به فهرست رشته‌ها اضافه می‌شود'),
      );
      // a sure fix can still be refused («جدا بماند»)
      s.branchAsk['معماری'] = '';
      r = await x.check(s);
      expect(r.rows[2].data['field'], 'معماری');
      expect(r.branchFixes.map((f) => f.$1), isNot(contains('معماری')));
    },
  );

  test('B201-04 a duplicate made by an older import is not a target', () async {
    final (e, ob) = await seeded([...defs, 'تعمیر موتور موتور', 'برق صنعتی']);
    final x = SchoolImport(db(e, ob));
    final r = await x.check(
      csv([('علی یک', 'تعمیر موتور موتور'), ('رضا دو', 'برق صنعتی')]),
    );
    expect(r.rows[0].data['field'], 'تعمیر موتور');
    expect(r.rows[1].data['field'], 'الکتروتکنیک');
    expect(r.branchChoices, isNot(contains('تعمیر موتور موتور')));
    expect(r.pendingAsks, 0);
  });

  test('B201-05 no definitions: the file names of one branch are matched to each other', () async {
    final (e, ob) = await seeded(const []);
    final x = SchoolImport(db(e, ob));
    final r = await x.check(
      csv([('علی یک', 'تعمیر موتور'), ('رضا دو', 'تعمیر موتور موتور')]),
    );
    expect(r.branchFixes, [('تعمیر موتور موتور', 'تعمیر موتور')]);
    expect(r.branchNew, ['تعمیر موتور']);
    expect(r.rows[1].data['field'], 'تعمیر موتور');
  });
}
