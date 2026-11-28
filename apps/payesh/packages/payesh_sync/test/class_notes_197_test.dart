// Row 197 — Q12 (F19): a teacher's class tools — class notices, homework, discipline notes and
// «ارجاع به مشاور», each only for the teacher's own classes / students and only their own rows.
// Server twins: server/policy.js `canWriteRow` / `classNoteIssue` (tests/teacher-tools-197.js);
// web twin: client/app.js forms `ann`, `hw`, `disc`, `cref`.
import 'dart:math';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

typedef Seed = (SqliteEngine, SqliteOutbox);

Future<Seed> seeded() async {
  final e = SqliteEngine.inMemory();
  final ob = SqliteOutbox(e.database);
  Future<void> put(String c, int id, Map<String, Object?> d) =>
      e.put(c, id, {...d, 'id': id}, version: 1);
  await put('classes', 5, {'name': 'هفتم الف'});
  await put('classes', 6, {'name': 'هشتم ب'});
  await put('users', 10, {'name': 'دبیر', 'role': 'teacher'});
  await put('users', 11, {'name': 'دبیر دیگر', 'role': 'teacher'});
  await put('schedule', 900, {'teacher_id': 10, 'class_id': 5});
  await put('schedule', 901, {'teacher_id': 11, 'class_id': 6});
  await put('users', 21, {'name': 'بهار', 'role': 'student', 'class_id': 5});
  await put('users', 22, {'name': 'سارا', 'role': 'student', 'class_id': 6});
  return (e, ob);
}

SchoolRecords recs(Seed s, String role, int uid) => SchoolRecords(
  engine: s.$1,
  outbox: s.$2,
  role: role,
  uid: uid,
  random: Random(7),
);

NoticeBoard board(Seed s, String role, int uid) => NoticeBoard(
  engine: s.$1,
  outbox: s.$2,
  role: role,
  uid: uid,
  random: Random(9),
);

Matcher fails(String code) =>
    throwsA(isA<RecordFailure>().having((f) => f.code, 'code', code));

void main() {
  test(
    'CN197-01 class notice: teacher only for own class; others do not see it',
    () async {
      final s = await seeded();
      final t = board(s, 'teacher', 10);
      expect(t.canWriteSchool, isFalse);
      expect(await t.myClassIds(), {5});
      await expectLater(
        t.publish(
          title: 'کل مدرسه',
          body: 'x',
          severity: NoticeSeverity.normal,
        ),
        throwsA(isA<NoticeFailure>()),
      );
      await expectLater(
        t.publish(
          title: 'کلاس دیگر',
          body: 'x',
          severity: NoticeSeverity.normal,
          classId: 6,
        ),
        throwsA(isA<NoticeFailure>()),
      );
      final r = await t.publish(
        title: 'آزمونک',
        body: 'شنبه',
        severity: NoticeSeverity.info,
        classId: 5,
      );
      final row = (await s.$1.get('announcements', r.id))!.data;
      expect(row['class_id'], 5);
      expect(row['author_id'], 10);
      // the class's student sees it, a student of another class and another teacher do not
      expect(
        (await board(s, 'student', 21).list()).map((n) => n.title),
        contains('آزمونک'),
      );
      expect(
        (await board(s, 'student', 22).list()).map((n) => n.title),
        isNot(contains('آزمونک')),
      );
      final other = board(s, 'teacher', 11);
      expect(
        (await other.list()).map((n) => n.title),
        isNot(contains('آزمونک')),
      );
      // the manager sees and may change it; another teacher may not
      final mine = (await t.list()).firstWhere((n) => n.id == r.id);
      expect(t.canChange(mine), isTrue);
      expect(other.canChange(mine), isFalse);
      expect(board(s, 'manager', 1).canChange(mine), isTrue);
    },
  );

  test('CN197-02 homework: own class only, own rows deleted, shape = classNoteIssue', () async {
    final s = await seeded();
    final n = ClassNotes(recs(s, 'teacher', 10));
    expect((await n.myClasses()).map((c) => c.id), [5]);
    await expectLater(
      n.addHomework(classId: 5, title: ' '),
      fails('text_required'),
    );
    await expectLater(
      n.addHomework(classId: 5, title: 'x' * 201),
      fails('text_too_long'),
    );
    await expectLater(
      n.addHomework(classId: 5, title: 'تمرین', due: '1405/09/06'),
      fails('bad_date'),
    );
    await expectLater(
      n.addHomework(classId: 6, title: 'تمرین'),
      fails('out_of_scope'),
    );
    final w = await n.addHomework(
      classId: 5,
      title: 'تمرین ۱ تا ۵',
      body: 'صفحهٔ ۴۲',
      due: '2026-11-20',
    );
    final hw = await n.homework(classIds: {5});
    expect(hw.single.title, 'تمرین ۱ تا ۵');
    expect(hw.single.className, 'هفتم الف');
    expect(hw.single.authorId, 10);
    expect(hw.single.due, '2026-11-20');
    // another teacher (even of the same class) cannot delete it
    await s.$1.put('schedule', 902, {
      'id': 902,
      'teacher_id': 11,
      'class_id': 5,
    }, version: 1);
    await expectLater(
      ClassNotes(recs(s, 'teacher', 11)).deleteHomework(hw.single),
      fails('not_author'),
    );
    await n.deleteHomework(hw.single);
    expect(await n.homework(classIds: {5}), isEmpty);
    expect(w.id, isNotNull);
    expect(s.$2.list().map((o) => o.type), ['put', 'del']);
  });

  test('CN197-03 discipline note: kinds, text, own class', () async {
    final s = await seeded();
    final n = ClassNotes(recs(s, 'teacher', 10));
    expect(DisciplineKind.values.map((k) => k.labelFa), [
      'تشویق',
      'تذکر',
      'یادداشت',
    ]);
    await expectLater(
      n.addDiscipline(
        studentId: 21,
        classId: 5,
        kind: DisciplineKind.positive,
        note: '',
      ),
      fails('text_required'),
    );
    await expectLater(
      n.addDiscipline(
        studentId: 22,
        classId: 6,
        kind: DisciplineKind.negative,
        note: 'دیر آمد',
      ),
      fails('out_of_scope'),
    );
    await n.addDiscipline(
      studentId: 21,
      classId: 5,
      kind: DisciplineKind.positive,
      note: 'فعالیت عالی در کلاس',
    );
    final d = (await n.discipline(studentIds: {21})).single;
    expect(d.kind, DisciplineKind.positive);
    expect(d.studentName, 'بهار');
    expect(d.row.data['author_id'], 10);
    expect(ClassNotes(recs(s, 'student', 21)).canWrite, isFalse);
  });

  test(
    'CN197-04 referral: teacher refers only own students; counselor handles',
    () async {
      final s = await seeded();
      final q = CounselorQueue(recs(s, 'teacher', 10));
      expect(q.canRefer, isTrue);
      expect(q.canHandle, isFalse);
      expect((await q.students()).map((u) => u.id), [21]);
      await expectLater(q.refer(22, 'افت تحصیلی'), fails('out_of_scope'));
      await expectLater(q.refer(21, ' '), fails('reason'));
      final r = await q.refer(21, 'افت تحصیلی');
      final row = (await s.$1.get('counselor_refs', r.id!))!.data;
      expect(row['referred_by'], 10);
      expect(row['status'], 'open');
      expect(CounselorQueue(recs(s, 'counselor', 30)).canHandle, isTrue);
    },
  );
}
