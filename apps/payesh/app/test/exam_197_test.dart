// Row 197 — Q12 / F21 «دانش‌آموز»: the manager keeps the exam calendar from «اطلاعیه‌ها»
// (add / delete); the student's home shows open homework, upcoming exams and the latest
// discipline notes, and «پروندهٔ من» shows the average, the report card and the discipline.
// Real screens + controllers + books on in-memory SQLite (web twin: tests/student-record-197.js).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'day_off_197_test.dart' as d197;
import 'nav_support.dart';
import 'school_support.dart';
import 'notices_wave4_test.dart' as w4;

Future<void> seedStudentRecord(MemorySchool s) async {
  await s.put('classes', 5, {'name': 'دهم الف', 'grade': '10'});
  await s.put('classes', 6, {'name': 'یازدهم', 'grade': '11'});
  await s.put('subjects', 41, {'name': 'ریاضی'});
  await s.put('subjects', 42, {'name': 'هنر'});
  // the signed-in user is uid 10 (see school_support.dart)
  await s.put('users', 10, {'name': 'سارا', 'role': 'student', 'class_id': 5});
  await s.put('users', 22, {'name': 'آرش', 'role': 'student', 'class_id': 5});
  await s.put('grades', 1, {'student_id': 10, 'subject_id': 41, 'score': 18});
  await s.put('grades', 2, {'student_id': 10, 'subject_id': 41, 'score': 15});
  await s.put('grades', 3, {
    'student_id': 10,
    'subject_id': 42,
    'kind': 'descriptive',
    'level': 'خیلی خوب',
  });
  await s.put('discipline', 1, {
    'student_id': 10,
    'kind': 'positive',
    'note': 'همکاری در کلاس',
    'date': '2026-11-10',
  });
  await s.put('discipline', 2, {
    'student_id': 22,
    'kind': 'negative',
    'note': 'یادداشت همکلاسی',
    'date': '2026-11-11',
  });
  await s.put('homework', 1, {
    'class_id': 5,
    'subject_id': 41,
    'title': 'تمرین صفحهٔ ۳۰',
    'due': '2026-11-13',
    'date': '2026-11-12',
  });
  await s.put('homework', 2, {
    'class_id': 5,
    'title': 'تکلیف گذشته',
    'due': '2026-11-01',
    'date': '2026-10-30',
  });
  await s.put('exams', 1, {
    'date': '2026-11-15',
    'subject_id': 41,
    'class_id': 5,
    'title': 'میان‌نوبت',
    'kind': 'internal',
  });
  await s.put('exams', 2, {
    'date': '2026-11-15',
    'subject_id': 41,
    'class_id': 6,
    'title': 'کلاس دیگر',
    'kind': 'internal',
  });
}

void main() {
  testWidgets(
    'EX197-01 manager: «افزودن امتحان» → exams row, listed; NEG no subject/title refused; «حذف»',
    (tester) async {
      final src = w4.MemorySource();
      await tester.runAsync(() async {
        await d197.seedSchool(src.engine);
        await src.engine.put('subjects', 41, {
          'id': 41,
          'name': 'ریاضی',
        }, version: 1);
      });
      await w4.boot(tester, source: src);
      await openPage(tester, 'announcements');
      expect(find.byKey(const Key('ntc-exams-card')), findsOneWidget);
      // the seeded exam (13 Nov) is upcoming on 12 Nov
      expect(find.byKey(const Key('ntc-exam-70')), findsOneWidget);
      await w4.tapKey(tester, 'ntc-exam-add');
      // NEG: neither a subject nor a title → refused in the form, nothing written
      await w4.tapKey(tester, 'exm-submit');
      expect(find.byKey(const Key('exm-error')), findsOneWidget);
      expect(
        await tester.runAsync(() => src.engine.list('exams')),
        hasLength(1),
      );
      await tester.enterText(find.byKey(const Key('exm-title')), 'آزمون جامع');
      await w4.tapKey(tester, 'exm-submit');
      expect(find.byKey(const Key('exm-submit')), findsNothing); // form closed
      final rows = (await tester.runAsync(() => src.engine.list('exams')))!;
      final row = rows.firstWhere((r) => r.data['title'] == 'آزمون جامع');
      expect(row.data['date'], '2026-11-13'); // tomorrow by default
      expect(row.data['kind'], 'internal');
      expect(row.data.containsKey('class_id'), isFalse); // the whole school
      expect(find.byKey(Key('ntc-exam-${row.id}')), findsOneWidget);
      expect(src.nudges, greaterThan(0));
      await w4.tapKey(tester, 'ntc-exam-del-${row.id}');
      expect(find.byKey(Key('ntc-exam-${row.id}')), findsNothing);
      expect(
        (await tester.runAsync(() => src.engine.list('exams')))!
            .map((r) => r.id),
        [70],
      );
    },
  );

  testWidgets(
    'EX197-02 student: home = open homework + own exams + latest discipline; «پروندهٔ من» = '
    'average, report card, own discipline; NEG classmate/other class absent',
    (tester) async {
      tester.view.physicalSize = const Size(2400, 24000);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      await bootSchool(tester, role: 'student', seed: seedStudentRecord);
      await openPage(tester, 'home');
      expect(find.byKey(const Key('home-hw-0')), findsOneWidget);
      expect(find.text('ریاضی — تمرین صفحهٔ ۳۰'), findsOneWidget);
      expect(find.byKey(const Key('home-hw-1')), findsNothing); // past due
      expect(find.byKey(const Key('home-exam-0')), findsOneWidget);
      expect(find.text('ریاضی — میان‌نوبت'), findsOneWidget);
      expect(find.byKey(const Key('home-exam-1')), findsNothing); // other class
      expect(find.byKey(const Key('home-disc-0')), findsOneWidget);
      expect(find.textContaining('همکاری در کلاس'), findsOneWidget);
      expect(find.textContaining('یادداشت همکلاسی'), findsNothing);
      expect(find.byKey(const Key('rec-present')), findsNothing);

      await openPage(tester, 'record');
      expect(textOf(tester, 'rec-average'), '۱۶٫۵');
      expect(find.byKey(const Key('rec-report-card')), findsOneWidget);
      expect(textOf(tester, 'rec-rc-subject-0'), 'ریاضی');
      expect(textOf(tester, 'rec-rc-value-0'), '۱۶٫۵');
      expect(textOf(tester, 'rec-rc-subject-1'), 'هنر');
      expect(textOf(tester, 'rec-rc-value-1'), 'خیلی خوب');
      expect(find.byKey(const Key('rec-discipline')), findsOneWidget);
      expect(find.byKey(const Key('rec-disc-0')), findsOneWidget);
      expect(find.byKey(const Key('rec-disc-1')), findsNothing);
    },
  );

  testWidgets(
    'EX197-03 NEG a student with no grade: average «—», empty report card',
    (tester) async {
      await bootSchool(
        tester,
        role: 'student',
        seed: (s) async {
          await s.put('classes', 5, {'name': 'دهم الف'});
          await s.put('users', 10, {
            'name': 'سارا',
            'role': 'student',
            'class_id': 5,
          });
        },
      );
      await openPage(tester, 'record');
      expect(textOf(tester, 'rec-average'), '—');
      expect(find.byKey(const Key('rec-report-empty')), findsOneWidget);
      expect(find.byKey(const Key('rec-disc-none')), findsOneWidget);
    },
  );
}
