// Row 197 — Q12 / F21: the exam calendar (manager writes, everyone reads) and the student's
// «پروندهٔ من» (average, report card, own discipline). Web twin: client/pages.js
// `examsCard` / `myStudentExams` / `reportCardOf` + client/app.js form `exam`
// (tests/student-record-197.js).
import 'dart:math';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

const today = '2026-11-12';
const tomorrow = '2026-11-13';
const later = '2026-11-16';

Future<(SqliteEngine, SqliteOutbox)> seeded() async {
  final e = SqliteEngine.inMemory();
  final ob = SqliteOutbox(e.database);
  Future<void> put(String c, int id, Map<String, Object?> d) =>
      e.put(c, id, {...d, 'id': id}, version: 1);
  await put('classes', 5, {
    'name': 'دهم ریاضی',
    'grade': '10',
    'branch': 'ریاضی',
  });
  await put('classes', 6, {'name': 'هفتم', 'grade': '7'});
  await put('subjects', 1, {'name': 'ریاضی'});
  await put('subjects', 2, {'name': 'ادبیات'});
  await put('subjects', 3, {'name': 'هنر'});
  await put('users', 21, {'name': 'بهار', 'role': 'student', 'class_id': 5});
  await put('users', 22, {'name': 'نگار', 'role': 'student', 'class_id': 6});
  return (e, ob);
}

SchoolRecords as(SqliteEngine e, SqliteOutbox ob, String role, int uid) =>
    SchoolRecords(
      engine: e,
      outbox: ob,
      role: role,
      uid: uid,
      random: Random(7),
      now: () => DateTime.utc(2026, 11, 12, 9),
    );

void main() {
  test(
    'E197-01 manager adds/deletes; everyone else is refused; rules',
    () async {
      final (e, ob) = await seeded();
      final m = SchoolExams(as(e, ob, 'manager', 1));
      final w = await m.add(
        date: tomorrow,
        kind: ExamKind.internal,
        subjectId: 1,
        classId: 5,
        title: 'میان‌نوبت',
        today: today,
      );
      final row = (await e.get('exams', w.id!))!.data;
      expect(row['date'], tomorrow);
      expect(row['kind'], 'internal');
      expect(row['subject_id'], 1);
      expect(row['class_id'], 5);
      expect(row['created_by'], 1);
      expect(w.id! >= SchoolRecords.idBaseOf('exams'), isTrue);
      expect(ob.list().length, 1);

      // NEG: no subject and no title / a past day / a too-long title
      for (final (f, code) in [
        (
          () => m.add(date: later, kind: ExamKind.internal, today: today),
          'text_required',
        ),
        (
          () => m.add(
            date: '2026-11-01',
            kind: ExamKind.internal,
            title: 'x',
            today: today,
          ),
          'bad_date',
        ),
        (
          () => m.add(
            date: later,
            kind: ExamKind.internal,
            title: 'ا' * (ExamLimits.title + 1),
            today: today,
          ),
          'text_too_long',
        ),
      ]) {
        await expectLater(
          f(),
          throwsA(isA<RecordFailure>().having((x) => x.code, 'code', code)),
        );
      }
      // NEG: teacher / student cannot add or delete
      for (final role in ['teacher', 'student', 'parent']) {
        final x = SchoolExams(as(e, ob, role, 21));
        await expectLater(
          x.add(date: later, kind: ExamKind.internal, title: 'x', today: today),
          throwsA(isA<RecordFailure>()),
        );
      }
      final listed = await m.list(from: today);
      expect(listed.single.label, 'ریاضی — میان‌نوبت');
      expect(listed.single.audience, 'دهم ریاضی');
      await expectLater(
        SchoolExams(as(e, ob, 'student', 21)).delete(listed.single),
        throwsA(isA<RecordFailure>()),
      );
      await m.delete(listed.single);
      expect(await m.list(from: today), isEmpty);
      expect(ExamKind.values.map((k) => k.labelFa), ['داخلی', 'نهایی']);
    },
  );

  test(
    'E197-02 a student sees own class / own cohort / school-wide exams only',
    () async {
      final (e, ob) = await seeded();
      final m = SchoolExams(as(e, ob, 'manager', 1));
      await m.add(
        date: tomorrow,
        kind: ExamKind.internal,
        subjectId: 1,
        classId: 5,
        today: today,
      );
      await m.add(
        date: tomorrow,
        kind: ExamKind.internal,
        subjectId: 2,
        classId: 6,
        today: today,
      );
      await m.add(
        date: later,
        kind: ExamKind.national,
        subjectId: 1,
        grade: '10',
        branch: 'ریاضی',
        today: today,
      );
      await m.add(
        date: later,
        kind: ExamKind.internal,
        title: 'آزمون جامع',
        today: today,
      );
      await e.put('exams', 99, {
        'id': 99,
        'date': '2026-11-01',
        'title': 'گذشته',
        'kind': 'internal',
      }, version: 1);

      final mine = await SchoolExams(as(e, ob, 'student', 21))
          .upcomingFor(from: today, classId: 5, grade: '10', branch: 'ریاضی');
      // same-day order is by id (random within the slot): compare per day
      expect(mine.first.date, tomorrow);
      expect(mine.first.label, 'ریاضی');
      expect(
        mine.skip(1).map((x) => x.label),
        unorderedEquals(['ریاضی', 'آزمون جامع']),
      );
      expect(mine.where((x) => x.kind == ExamKind.national).single.date, later);
      // NEG: the other class's exam and the past exam are not there
      expect(
        mine.any((x) => x.label == 'ادبیات' || x.label == 'گذشته'),
        isFalse,
      );
      final other = await SchoolExams(as(e, ob, 'student', 22))
          .upcomingFor(from: today, classId: 6, grade: '7');
      expect(other.map((x) => x.label), ['ادبیات', 'آزمون جامع']);
    },
  );

  test('E197-03 «پروندهٔ من»: average, report card, homework, exams, own discipline', () async {
    final (e, ob) = await seeded();
    Future<void> put(String c, int id, Map<String, Object?> d) =>
        e.put(c, id, {...d, 'id': id}, version: 1);
    await put('grades', 1, {
      'student_id': 21,
      'subject_id': 1,
      'score': 18,
      'status': 'approved',
    });
    await put('grades', 2, {
      'student_id': 21,
      'subject_id': 1,
      'score': 15,
      'status': 'approved',
    });
    await put('grades', 3, {
      'student_id': 21,
      'subject_id': 2,
      'score': '19.5',
    });
    await put('grades', 4, {
      'student_id': 21,
      'subject_id': 3,
      'kind': 'descriptive',
      'level': 'خیلی خوب',
    });
    await put('grades', 5, {'student_id': 22, 'subject_id': 1, 'score': 3});
    await put('discipline', 1, {
      'student_id': 21,
      'kind': 'positive',
      'note': 'همکاری',
      'date': '2026-11-10',
    });
    await put('discipline', 2, {
      'student_id': 22,
      'kind': 'negative',
      'note': 'دیگری',
      'date': '2026-11-11',
    });
    await put('homework', 1, {
      'class_id': 5,
      'title': 'تمرین ۳',
      'due': tomorrow,
      'date': today,
    });
    await put('homework', 2, {
      'class_id': 5,
      'title': 'قدیمی',
      'due': '2026-11-01',
      'date': '2026-10-30',
    });
    await put('homework', 3, {
      'class_id': 6,
      'title': 'هفتمی',
      'due': tomorrow,
      'date': today,
    });
    await put('exams', 1, {
      'date': tomorrow,
      'subject_id': 1,
      'class_id': 5,
      'kind': 'internal',
    });

    final db = as(e, ob, 'student', 21);
    final r = await UserDirectory(db).myRecord();
    expect(r.average, closeTo((18 + 15 + 19.5) / 3, 1e-9));
    expect(r.reportCard, [
      ('ادبیات', '۱۹٫۵'),
      ('ریاضی', '۱۶٫۵'),
      ('هنر', 'خیلی خوب'),
    ]);
    expect(r.discipline.map((d) => d.note), [
      'همکاری',
    ]); // NEG: classmate's note absent
    expect(r.exams.single.label, 'ریاضی');
    expect(r.openHomework(today).map((h) => h.title), ['تمرین ۳']);
    expect(r.homework.any((h) => h.title == 'هفتمی'), isFalse);

    // NEG: a student without any grade has «—» (null), never ۰
    final r2 = await UserDirectory(as(e, ob, 'student', 22)).myRecord();
    expect(r2.reportCard.single, ('ریاضی', '۳٫۰'));
    await put('users', 23, {'name': 'سارا', 'role': 'student', 'class_id': 6});
    final r3 = await UserDirectory(as(e, ob, 'student', 23)).myRecord();
    expect(r3.average, isNull);
    expect(r3.reportCard, isEmpty);
  });
}
