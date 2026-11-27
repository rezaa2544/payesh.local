// Row 201 — «کلاس‌ها و تعریف‌ها»: details of a grade/branch/class/subject, a rename that takes
// the students and classes along, and merging a duplicated branch into the right one.
import 'dart:math';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

Future<(SqliteEngine, SqliteOutbox)> seeded() async {
  final e = SqliteEngine.inMemory();
  final ob = SqliteOutbox(e.database);
  Future<void> put(String c, int id, Map<String, Object?> d) =>
      e.put(c, id, {...d, 'id': id}, version: 1);
  await put('schools', 1, {'name': 'کاردانش', 'level': 'متوسطه دوم'});
  await put('lookups', 1, {'kind': 'grade', 'name': 'دهم'});
  await put('lookups', 2, {'kind': 'grade', 'name': 'یازدهم'});
  await put('lookups', 10, {'kind': 'branch', 'name': 'تعمیر موتور'});
  await put('lookups', 11, {'kind': 'branch', 'name': 'تعمیر موتور موتور'});
  await put('lookups', 12, {'kind': 'branch', 'name': 'الکتروتکنیک'});
  await put('lookups', 13, {'kind': 'branch', 'name': 'برق صنعتی'});
  await put('lookups', 14, {'kind': 'branch', 'name': 'الکترونیک'});
  await put('classes', 20, {
    'name': 'دهم تعمیر موتور',
    'grade': 'دهم',
    'branch': 'تعمیر موتور',
    'kind': 'group',
  });
  await put('classes', 21, {
    'name': 'دهم تعمیر موتور موتور',
    'grade': 'دهم',
    'branch': 'تعمیر موتور موتور',
    'kind': 'group',
  });
  await put('classes', 22, {
    'name': 'یازدهم تعمیر موتور موتور',
    'grade': 'یازدهم',
    'branch': 'تعمیر موتور موتور',
    'kind': 'group',
  });
  await put('subjects', 30, {'name': 'ریاضی'});
  await put('users', 40, {'name': 'دبیر ریاضی', 'role': 'teacher'});
  await put('schedule', 50, {
    'class_id': 20,
    'subject_id': 30,
    'teacher_id': 40,
    'weekday': 1,
    'bell_order': 1,
  });
  var id = 100;
  for (final (n, g, b) in [
    ('علی', 'دهم', 'تعمیر موتور'),
    ('رضا', 'دهم', 'تعمیر موتور موتور'),
    ('مینا', 'یازدهم', 'تعمیر موتور موتور'),
    ('سارا', 'دهم', 'برق صنعتی'),
  ]) {
    await put('users', id++, {
      'name': n,
      'role': 'student',
      'grade': g,
      'field': b,
      'class_id': null,
    });
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
    'C201-01 details: students, classes and the definition it duplicates',
    () async {
      final (e, ob) = await seeded();
      final b = ClassBook(db(e, ob));
      final dup = await b.lookupDetail(11);
      expect(dup.students.map((s) => s.name), ['رضا', 'مینا']);
      expect(dup.classes, [
        'دهم تعمیر موتور موتور',
        'یازدهم تعمیر موتور موتور',
      ]);
      expect((dup.likeId, dup.like, dup.why), (10, 'تعمیر موتور', 'repeat'));
      // NEG the clean one is never offered to go into the duplicate
      expect((await b.lookupDetail(10)).likeId, isNull);
      expect((await b.lookupDetail(13)).like, 'الکتروتکنیک');
      expect((await b.lookupDetail(13)).why, 'alias');
      // NEG two real branches that only look alike
      expect((await b.lookupDetail(14)).likeId, isNull);
      final c = await b.classDetail(20);
      expect(c.students.map((s) => s.$2), ['علی']);
      expect(c.slots, 1);
      final s = await b.subjectDetail(30);
      expect(s.classes, ['دهم تعمیر موتور']);
      expect(s.teachers, ['دبیر ریاضی']);
      expect(s.slots, 1);
    },
  );

  test('C201-02 merge: students and classes move, the twin class merges, the duplicate goes', () async {
    final (e, ob) = await seeded();
    final d = db(e, ob);
    final w = await ClassBook(d).mergeLookup(11, 10);
    expect(
      w.messageFa,
      '«تعمیر موتور موتور» در «تعمیر موتور» ادغام شد · 2 دانش‌آموز منتقل شد',
    );
    expect(await d.get('lookups', 11), isNull);
    expect((await d.get('users', 101))!.data['field'], 'تعمیر موتور');
    expect((await d.get('users', 102))!.data['field'], 'تعمیر موتور');
    // «دهم تعمیر موتور موتور» had a twin → merged into it; the 11th one is renamed
    expect(await d.get('classes', 21), isNull);
    final c22 = (await d.get('classes', 22))!.data;
    expect((c22['name'], c22['branch']), ('یازدهم تعمیر موتور', 'تعمیر موتور'));
    final v = await ClassBook(d).overview();
    expect(v.branches.map((b) => b.name), isNot(contains('تعمیر موتور موتور')));
    expect(v.branches.firstWhere((b) => b.name == 'تعمیر موتور').students, 3);
    // NEG a grade never merges into a branch
    expect(
      () => ClassBook(d).mergeLookup(1, 12),
      throwsA(isA<RecordFailure>()),
    );
  });

  test('C201-03 rename takes students and classes along; NEG a name already used is refused', () async {
    final (e, ob) = await seeded();
    final d = db(e, ob);
    final w = await ClassBook(d)
        .saveLookup(id: 13, kind: 'branch', name: 'برق');
    expect(w.messageFa, contains('دانش‌آموز هم به‌روز شد'));
    expect((await d.get('users', 103))!.data['field'], 'برق');
    await expectLater(
      ClassBook(d).saveLookup(id: 11, kind: 'branch', name: 'تعمیر موتور'),
      throwsA(
        isA<RecordFailure>().having((f) => f.messageFa, 'm', contains('ادغام')),
      ),
    );
    await ClassBook(d)
        .saveLookup(id: 10, kind: 'branch', name: 'تعمیرات موتور');
    final c20 = (await d.get('classes', 20))!.data;
    expect(
      (c20['name'], c20['branch']),
      ('دهم تعمیرات موتور', 'تعمیرات موتور'),
    );
    expect((await d.get('users', 100))!.data['field'], 'تعمیرات موتور');
  });
}
