// Row 204 — one rule for every figure: «پایه دهم», «۱۰» and «دهم» are one grade; a student's
// grade/branch comes from its class first, then its own fields (the users list did this, the
// classes page did not, so the two disagreed); students no definition counts are «بدون پایه»
// so the columns add up; a field school (رشته‌محور) names no «کلاس» but its venues.
import 'dart:math';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

Future<(SqliteEngine, SqliteOutbox)> seeded({
  String level = 'متوسطه دوم',
}) async {
  final e = SqliteEngine.inMemory();
  final ob = SqliteOutbox(e.database);
  Future<void> put(String c, int id, Map<String, Object?> d) =>
      e.put(c, id, {...d, 'id': id}, version: 1);
  await put('schools', 1, {'name': 'کاردانش', 'level': level});
  await put('lookups', 1, {'kind': 'grade', 'name': 'دهم'});
  await put('lookups', 2, {'kind': 'grade', 'name': 'یازدهم'});
  await put('lookups', 3, {'kind': 'grade', 'name': 'دوازدهم'});
  await put('lookups', 10, {'kind': 'branch', 'name': 'الکتروتکنیک'});
  await put('lookups', 11, {'kind': 'branch', 'name': 'معماری'});
  await put('classes', 20, {
    'name': 'دهم الکتروتکنیک',
    'grade': 'دهم',
    'branch': 'الکتروتکنیک',
    'kind': 'group',
  });
  await put('classes', 21, {
    'name': 'یازدهم الکتروتکنیک',
    'grade': 'یازدهم',
    'branch': 'الکتروتکنیک',
    'kind': 'group',
  });
  await put('classes', 22, {
    'name': 'دوازدهم الکتروتکنیک',
    'grade': 'دوازدهم',
    'branch': 'الکتروتکنیک',
    'kind': 'group',
  });
  await put('classes', 30, {'name': 'کارگاه برق', 'kind': 'room'});
  var id = 100;
  for (final (n, g, b, extra)
      in <(String, String, String, Map<String, Object?>)>[
        ('علی', 'دهم', 'الکتروتکنیک', {}),
        ('رضا', 'پایه دهم', 'الکتروتکنیک', {}), // the old count missed it
        ('حسن', '۱۰', 'معماری', {}), // and this one
        ('مینا', '', 'الکتروتکنیک', {'class_id': 20}), // its class says دهم
        ('سارا', 'یازدهم', 'الکتروتکنیک', {}),
        ('نرگس', 'دوازدهم', 'معماری', {}),
        ('بی‌پایه', '', 'الکتروتکنیک', {}), // «بدون پایه»
        ('ناشناس', 'هفتم', 'معماری', {}), // a grade no definition has
        ('رفته', 'دهم', 'الکتروتکنیک', {'active': false}), // not counted
        ('بی‌رشته', 'یازدهم', '', {}), // «بدون رشته»
      ]) {
    await e.put('users', id, {
      'id': id,
      'name': n,
      'role': 'student',
      'grade': g,
      'field': b,
      'national_id': '00${id}1234567'.substring(0, 10),
      'phone': '0912000${id}0'.substring(0, 11),
      ...extra,
    }, version: 1);
    id++;
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

void main() {
  test(
    'C204-01 sameGrade / gradeKey: every spelling of a grade is one grade',
    () {
      expect(sameGrade('پایه دهم', 'دهم'), isTrue);
      expect(sameGrade('۱۰', 'دهم'), isTrue);
      expect(sameGrade('10', 'دهم'), isTrue);
      expect(sameGrade('یازدهم', 'دهم'), isFalse);
      expect(sameGrade('دوازدهم', 'دهم'), isFalse);
      expect(sameGrade('', 'دهم'), isFalse);
      expect(sameGrade('', ''), isFalse);
      expect(gradeKey('پایهٔ دوازدهم'), gradeKey('12'));
      expect(gradeKey('پیش‌دانشگاهی'), isNot(''));
      expect(sameBranch('الکترو تکنیک', 'الکتروتکنیک'), isTrue);
      expect(sameBranch('', ''), isFalse);
    },
  );

  test('C204-02 classes page: grade and branch figures by the one rule, with «بدون پایه» / '
      '«بدون رشته» so each column adds up to every active student', () async {
    final (e, ob) = await seeded();
    final v = await ClassBook(db(e, ob)).overview();
    final g = {for (final r in v.grades) r.name: r};
    final b = {for (final r in v.branches) r.name: r};
    // دهم: علی, رضا (پایه دهم), حسن (۱۰), مینا (its class) — not the inactive one
    expect(g['دهم']!.students, 4);
    expect(g['یازدهم']!.students, 2);
    expect(g['دوازدهم']!.students, 1);
    expect(v.noGrade, 2, reason: 'بی‌پایه + ناشناس (هفتم)');
    final active = 9;
    expect(v.grades.fold(0, (n, r) => n + r.students) + v.noGrade, active);
    expect(b['الکتروتکنیک']!.students, 5);
    expect(b['معماری']!.students, 3);
    expect(v.noBranch, 1);
    expect(v.branches.fold(0, (n, r) => n + r.students) + v.noBranch, active);
    // a field school: a branch counts its grades, a grade its branches
    expect(b['الکتروتکنیک']!.others, 3);
    expect(b['معماری']!.others, 3, reason: 'دهم (حسن)، دوازدهم، هفتم');
    expect(g['دهم']!.others, 2);
    // grades in school order, not alphabetical
    expect(v.grades.map((r) => r.name), ['دهم', 'یازدهم', 'دوازدهم']);
  });

  test('C204-03 a grade/branch detail: the same students as its figure, sorted, with grade, '
      'branch, national id, mobile; the other half for the filters; inactive counted aside', () async {
    final (e, ob) = await seeded();
    final book = ClassBook(db(e, ob));
    final d = await book.lookupDetail(1);
    expect(d.students.map((s) => s.name), ['حسن', 'رضا', 'علی', 'مینا']);
    expect(d.inactive, 1);
    final mina = d.students.firstWhere((s) => s.name == 'مینا');
    expect(
      (mina.grade, mina.branch, mina.className),
      ('دهم', 'الکتروتکنیک', 'دهم الکتروتکنیک'),
    );
    expect(d.students.first.nationalId, isNotEmpty);
    expect(d.students.first.phone, startsWith('0912'));
    expect(d.others('grade'), ['الکتروتکنیک', 'معماری']);
    final br = await book.lookupDetail(10);
    expect(br.students.length, 5);
    // the filter values of a branch: one per grade (any spelling), in school order, empty last
    final keys = br.others('branch').map(gradeKey).toList();
    expect(keys, ['L10', 'L11', ''], reason: 'no student in دوازدهم of it');
    final none = await book.unassignedDetail('grade');
    expect(none.students.map((s) => s.name), ['بی‌پایه', 'ناشناس']);
    final noBranch = await book.unassignedDetail('branch');
    expect(noBranch.students.map((s) => s.name), ['بی‌رشته']);
  });

  test('C204-04 the dashboard counts the same roster and groups «پایه دهم» with «دهم»; it knows '
      'a field school (its home shows پایه و رشته, not «کلاس»)', () async {
    final (e, ob) = await seeded();
    final d = await SchoolReports(db(e, ob)).dashboard();
    expect(d.students, 9);
    expect(d.fieldBased, isTrue);
    final dahom = d.coverage.where(
      (c) => gradeKey(c.grade) == 'L10' && c.branch == 'الکتروتکنیک',
    );
    expect(dahom.length, 1, reason: 'one cohort, not «دهم» + «پایه دهم»');
    expect(dahom.single.roster, 3);
    final (e2, ob2) = await seeded(level: 'متوسطه اول');
    expect((await SchoolReports(db(e2, ob2)).dashboard()).fieldBased, isFalse);
  });

  test(
    'C204-05 deleting a grade in a field school: its students are the ones the figure '
    'counts (they have no class of their own) and the words name no «کلاس»',
    () async {
      final (e, ob) = await seeded();
      final book = ClassBook(db(e, ob));
      final u = await book.lookupUsage(11);
      expect(
        u.students,
        3,
        reason: 'حسن، نرگس، ناشناس — none of them in a class',
      );
      final w = await book.deleteLookup(11, LookupDelete.cascade);
      expect(w.messageFa, contains('رشته حذف شد'));
      expect(w.messageFa, isNot(contains('کلاس')));
      final hasan = await e.get('users', 102);
      expect(hasan!.data['followup_reason'], contains('پایه و رشتهٔ درست'));
      expect(hasan.data['followup_reason'], isNot(contains('کلاس')));
    },
  );

  test('C204-06 data health in a field school: «پایه و رشته» wording; a venue is never «a class '
      'with no grade»; «پایه دهم» is a known grade', () async {
    final (e, ob) = await seeded();
    await e.put('classes', 23, {
      'id': 23,
      'name': 'پایه دهم معماری',
      'grade': 'پایه دهم',
      'branch': 'معماری',
      'kind': 'group',
    }, version: 1);
    final h = DataHealth(db(e, ob));
    final run = await h.run();
    final titles = [for (final r in run.rows) r.check.title];
    expect(titles, contains('دانش‌آموز بدون پایه یا رشته'));
    expect(titles, isNot(contains('دانش‌آموز بدون کلاس')));
    final noGrade = await h.check('class-no-grade');
    expect(noGrade.ok, isTrue, reason: 'the room and «پایه دهم» are fine');
    final (e2, ob2) = await seeded(level: 'متوسطه اول');
    final run2 = await DataHealth(db(e2, ob2)).run();
    expect([
      for (final r in run2.rows) r.check.title,
    ], contains('دانش‌آموز بدون کلاس'));
  });

  test('C204-07 the attendance book knows a field school; the import says «پایه و رشته»', () async {
    final (e, ob) = await seeded();
    expect(await engineFieldBased(e), isTrue);
    final (e2, _) = await seeded(level: 'ابتدایی');
    expect(await engineFieldBased(e2), isFalse);
    final r = ImportResult()
      ..created = 2
      ..classes = 1
      ..fieldBased = true;
    expect(r.summaryFa, contains('پایه و رشتهٔ تازه'));
    expect(r.summaryFa, isNot(contains('کلاس')));
    expect(importReasonFields('بدون پایه و رشته'), contains('grade'));
    expect(
      importReasonFields('پایه ثبت نشد: پایه در فایل نبود'),
      contains('grade'),
    );
  });
}
