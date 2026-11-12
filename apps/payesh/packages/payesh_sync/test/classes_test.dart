// Row 128, wave W8 — classes, rooms, definitions and subjects, unit level (local SQLite + durable
// outbox, no network). Parity target: client/pages.js PAGES.classes, client/app.js forms
// `class` / `def` / `subject` and class-* / def-* / subject-* actions.
import 'dart:math';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

Future<(SqliteEngine, SqliteOutbox)> seeded({
  OutboxConfig config = const OutboxConfig(),
}) async {
  final e = SqliteEngine.inMemory();
  final ob = SqliteOutbox(e.database, config: config);
  Future<void> put(String c, int id, Map<String, Object?> d) =>
      e.put(c, id, {...d, 'id': id}, version: 1);
  await put('lookups', 1, {'kind': 'grade', 'name': 'دهم', 'order': 1});
  await put('lookups', 2, {'kind': 'branch', 'name': 'الکترونیک', 'order': 1});
  await put('lookups', 3, {'kind': 'grade', 'name': 'هفتم', 'order': 2});
  await put('classes', 5, {
    'name': 'دهم الکترونیک',
    'grade': 'دهم',
    'branch': 'الکترونیک',
    'mode': 'field',
    'kind': 'class',
  });
  await put('classes', 6, {'name': 'کارگاه ۱', 'kind': 'room'});
  await put('classes', 7, {
    'name': 'هفتم الف',
    'grade': 'هفتم',
    'mode': 'class',
    'kind': 'class',
  });
  await put('subjects', 41, {'name': 'ریاضی'});
  await put('users', 21, {'name': 'بهار', 'role': 'student', 'class_id': 5});
  await put('users', 22, {
    'name': 'آرش',
    'role': 'student',
    'class_id': null,
    'grade': 'دهم',
    'field': 'الکترونیک',
    'followup_reason': 'کلاس ندارد',
  });
  await put('users', 23, {'name': 'نیما', 'role': 'student', 'class_id': 7});
  await put('users', 40, {'name': 'ولی', 'role': 'parent'});
  await put('parent_links', 700, {'parent_id': 40, 'student_id': 21});
  await put('schedule', 900, {
    'class_id': 5,
    'subject_id': 41,
    'weekday': 1,
    'bell_order': 1,
  });
  await put('schedule', 901, {
    'class_id': 7,
    'subject_id': 41,
    'weekday': 1,
    'bell_order': 1,
  });
  await put('schedule', 902, {
    'class_id': 7,
    'subject_id': 41,
    'weekday': 2,
    'bell_order': 1,
  });
  await put('substitutions', 950, {'schedule_id': 901});
  await put('grades', 5000000000000001, {
    'student_id': 23,
    'class_id': 7,
    'score': 18,
  });
  await put('attendance', 4000000000000001, {
    'student_id': 23,
    'class_id': 7,
    'status': 'present',
  });
  return (e, ob);
}

SchoolRecords db(SqliteEngine e, SqliteOutbox ob, [String role = 'manager']) =>
    SchoolRecords(engine: e, outbox: ob, role: role, uid: 1, random: Random(3));

void main() {
  test('W8-U01 overview: rooms vs classes, student counts, definitions in use, subject slots', () async {
    final (e, ob) = await seeded();
    final v = await ClassBook(db(e, ob)).overview();
    expect(v.rooms.map((r) => r.name), ['کارگاه ۱']);
    expect(v.classes.map((c) => c.name), ['دهم الکترونیک', 'هفتم الف']);
    expect(v.classes.first.students, 1);
    expect(v.classes.first.mode, 'field');
    expect(v.grades.map((g) => '${g.name}:${g.classes}'), ['دهم:1', 'هفتم:1']);
    expect(v.branches.single.classes, 1);
    expect(v.subjects.single.slots, 3);
  });

  test('W8-U02 grade level: words, digits, longest word first; NEG a branch is not a grade', () {
    expect(gradeLevel('دهم'), 10);
    expect(gradeLevel('یازدهم'), 11);
    expect(gradeLevel('دوازدهم ریاضی'), 12);
    expect(gradeLevel('پایه ۷'), 7);
    expect(gradeLevel('الکترونیک'), 0);
    expect(normName('كلاس‌ يك'), 'کلاس یک');
  });

  test('W8-U03 class form: field mode needs a branch, class mode none; name from grade+branch; '
      'students waiting for this grade/branch join it', () async {
    final (e, ob) = await seeded();
    final b = ClassBook(db(e, ob));
    await expectLater(
      b.saveClass(const ClassDraft(grade: 'الکترونیک')),
      throwsA(isA<RecordFailure>().having((f) => f.code, 'code', 'invalid')),
    );
    await expectLater(
      b.saveClass(const ClassDraft(grade: 'دهم')),
      throwsA(
        isA<RecordFailure>().having(
          (f) => f.messageFa,
          'msg',
          contains('رشته'),
        ),
      ),
    );
    await expectLater(
      b.saveClass(
        const ClassDraft(grade: 'هفتم', branch: 'الکترونیک', mode: 'class'),
      ),
      throwsA(isA<RecordFailure>()),
    );
    await expectLater(
      b.saveClass(const ClassDraft(grade: 'دهم', branch: 'الکترونیک')),
      throwsA(isA<RecordFailure>().having((f) => f.code, 'code', 'duplicate')),
    );
    expect(ob.list(), isEmpty);
    final w = await b.saveClass(
      const ClassDraft(
        grade: 'دهم',
        branch: 'الکترونیک',
        name: 'دهم الکترونیک ۲',
      ),
    );
    expect(w.messageFa, 'کلاس ساخته شد · 1 دانش‌آموز به آن وصل شد');
    final u = (await e.get('users', 22))!.data;
    expect(u['class_id'], w.id);
    expect(u.containsKey('followup_reason'), isFalse);
    final c = (await e.get('classes', w.id!))!.data;
    expect(c['grade_level'], 10);
    expect(c['mode'], 'field');
    expect(ob.list(), hasLength(2));
  });

  test(
    'W8-U04 rooms: name only, unique across all classes (letter forms ignored)',
    () async {
      final (e, ob) = await seeded();
      final b = ClassBook(db(e, ob));
      await expectLater(
        b.saveRoom(name: 'كارگاه ۱'),
        throwsA(isA<RecordFailure>()),
      );
      await expectLater(b.saveRoom(name: ' '), throwsA(isA<RecordFailure>()));
      final w = await b.saveRoom(name: 'کارگاه ۲');
      expect((await e.get('classes', w.id!))!.data['kind'], 'room');
      await b.saveRoom(id: 6, name: 'کارگاه برق');
      expect((await e.get('classes', 6))!.data['name'], 'کارگاه برق');
    },
  );

  test('W8-U05 delete class: students stay without a class, in follow-up with the reason', () async {
    final (e, ob) = await seeded();
    final w = await ClassBook(db(e, ob)).deleteClass(5);
    expect(w.keys, hasLength(2));
    expect(await e.get('classes', 5), isNull);
    final u = (await e.get('users', 21))!.data;
    expect(u['class_id'], isNull);
    expect(u['followup_reason'], contains('دهم الکترونیک'));
  });

  test('W8-U06 merge: students, schedule, grades, attendance move; a clashing slot is dropped '
      'with its substitution', () async {
    final (e, ob) = await seeded();
    final w = await ClassBook(db(e, ob)).mergeClass(7, 5);
    expect(await e.get('classes', 7), isNull);
    expect((await e.get('users', 23))!.data['class_id'], 5);
    expect(
      await e.get('schedule', 901),
      isNull,
      reason: 'clash at weekday 1 bell 1',
    );
    expect(await e.get('substitutions', 950), isNull);
    expect((await e.get('schedule', 902))!.data['class_id'], 5);
    expect((await e.get('grades', 5000000000000001))!.data['class_id'], 5);
    expect((await e.get('attendance', 4000000000000001))!.data['class_id'], 5);
    expect(w.messageFa, contains('1 دانش‌آموز'));
    await expectLater(
      ClassBook(db(e, ob)).mergeClass(5, 5),
      throwsA(isA<RecordFailure>()),
    );
  });

  test('W8-U07 definitions: add/edit, duplicate refused, usage, three ways to delete', () async {
    final (e, ob) = await seeded();
    final b = ClassBook(db(e, ob));
    await expectLater(
      b.saveLookup(kind: 'grade', name: 'دهم'),
      throwsA(isA<RecordFailure>().having((f) => f.code, 'code', 'duplicate')),
    );
    final w = await b.saveLookup(kind: 'branch', name: 'مکانیک');
    expect((await e.get('lookups', w.id!))!.data['order'], 2);
    final u = await b.lookupUsage(1);
    expect(u.classes, ['دهم الکترونیک']);
    expect(u.students, 1);
    // only the definition
    await b.deleteLookup(2, LookupDelete.only);
    expect(await e.get('classes', 5), isNotNull);
    // cascade: classes go, students to follow-up, schedule + substitutions of those classes go
    final c = await b.deleteLookup(3, LookupDelete.cascade);
    expect(await e.get('classes', 7), isNull);
    expect(await e.get('schedule', 901), isNull);
    expect(await e.get('substitutions', 950), isNull);
    expect(
      (await e.get('users', 23))!.data['followup_reason'],
      contains('هفتم'),
    );
    expect(c.messageFa, contains('1 دانش‌آموز'));
  });

  test('W8-U08 delete a grade with its students: grades, attendance, links, students, classes', () async {
    final (e, ob) = await seeded();
    final b = ClassBook(db(e, ob));
    await b.deleteLookup(3, LookupDelete.students);
    expect(await e.get('users', 23), isNull);
    expect(await e.get('grades', 5000000000000001), isNull);
    expect(await e.get('attendance', 4000000000000001), isNull);
    expect(await e.get('classes', 7), isNull);
    expect(await e.get('lookups', 3), isNull);
    expect(
      await e.get('users', 21),
      isNotNull,
      reason: 'other grade untouched',
    );
  });

  test(
    'W8-U09 subjects: add/edit (workshop), delete removes its slots',
    () async {
      final (e, ob) = await seeded();
      final b = ClassBook(db(e, ob));
      await expectLater(
        b.saveSubject(name: '', workshop: false),
        throwsA(isA<RecordFailure>()),
      );
      final w = await b.saveSubject(name: 'کارگاه برق', workshop: true);
      expect((await e.get('subjects', w.id!))!.data['workshop'], true);
      await b.deleteSubject(41);
      expect(await e.get('subjects', 41), isNull);
      expect(await e.get('schedule', 900), isNull);
      expect(await e.get('schedule', 902), isNull);
    },
  );

  test('W8-U10 NEG teacher: every write refused, nothing queued', () async {
    final (e, ob) = await seeded();
    final b = ClassBook(db(e, ob, 'teacher'));
    for (final f in <Future<Object?> Function()>[
      () => b.saveRoom(name: 'x'),
      () => b.saveClass(const ClassDraft(grade: 'هفتم')),
      () => b.deleteClass(5),
      () => b.saveLookup(kind: 'grade', name: 'نهم'),
      () => b.deleteSubject(41),
    ]) {
      await expectLater(f(), throwsA(isA<RecordFailure>()));
    }
    expect(ob.list(), isEmpty);
  });

  test('W8-U11 NEG a full queue refuses a multi-row delete up front: nothing changed', () async {
    final (e, ob) = await seeded(config: const OutboxConfig(capacity: 2));
    await expectLater(
      ClassBook(db(e, ob)).deleteLookup(3, LookupDelete.students),
      throwsA(isA<SyncFailure>()),
    );
    expect(ob.list(), isEmpty);
    expect(await e.get('users', 23), isNotNull);
    expect(await e.get('classes', 7), isNotNull);
  });
}
