// Row 197 (Q12 / F27, F29) — the parent's child page shows what the web shows (report card,
// open homework, upcoming exams, discipline, today's absence, contributions, the threads) and
// the parent writes to the school / a teacher / the counselor; the recipient answers; the
// counselor has a desk of every student with a read-only record and private notes.
// Real screens, real controllers, real books on in-memory SQLite + outbox.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/app.dart';
import 'package:payesh_data/payesh_data.dart' show SqliteEngine;

import 'family_wave5_test.dart' as w5;
import 'nav_support.dart';
import 'school_support.dart';

/// 12 Nov 2026 (both supports) — the child is absent today.
Future<void> seedF27(SqliteEngine e) async {
  Future<void> put(String c, int id, Map<String, Object?> d) =>
      e.put(c, id, {...d, 'id': id}, version: 1);
  await put('attendance', 4000000000000999, {
    'student_id': 21,
    'class_id': 5,
    'date': '2026-11-12',
    'status': 'absent',
  });
  await put('users', 30, {'name': 'آقای رضایی', 'role': 'teacher'});
  await put('schedule', 701, {
    'class_id': 5,
    'teacher_id': 30,
    'subject_id': 1,
    'weekday': 6,
    'period': 1,
  });
  await put('discipline', 801, {
    'student_id': 21,
    'class_id': 5,
    'date': '2026-11-10',
    'kind': 'positive',
    'note': 'همکاری در کلاس',
  });
  await put('homework', 901, {
    'class_id': 5,
    'subject_id': 1,
    'title': 'تمرین فصل ۲',
    'date': '2026-11-11',
    'due': '2026-11-15',
  });
  await put('exams', 951, {
    'class_id': 5,
    'subject_id': 2,
    'date': '2026-11-20',
    'kind': 'internal',
  });
  await put('contributions', 961, {
    'student_id': 21,
    'date': '2026-10-01',
    'amount': 5000000,
    'kind': 'voluntary',
    'purpose': 'کمک به آزمایشگاه',
  });
  await put('parent_msgs', 2800000000000001, {
    'student_id': 21,
    'parent_id': 10,
    'to': 'school',
    'kind': 'message',
    'text': 'سارا دیروز بیمار بود',
    'reply': 'ثبت شد، سلامت باشد',
    'status': 'answered',
    'created_at': '2026-11-11T08:00:00Z',
  });
}

Future<void> seedDesk(MemorySchool s, {String role = 'counselor'}) async {
  await s.put('schools', 1, {'name': 'هنرستان نمونه'});
  await s.put('classes', 5, {'name': 'دهم شبکه', 'grade': 'دهم'});
  await s.put('subjects', 1, {'name': 'ریاضی'});
  await s.put('users', 10, {'name': 'کاربر', 'role': role});
  await s.put('users', 21, {
    'name': 'بهار سعیدی',
    'role': 'student',
    'class_id': 5,
    'grade': 'دهم',
  });
  await s.put('users', 22, {
    'name': 'نیما کریمی',
    'role': 'student',
    'class_id': 5,
  });
  await s.put('users', 30, {'name': 'آقای رضایی', 'role': 'teacher'});
  await s.put('grades', 101, {
    'student_id': 21,
    'class_id': 5,
    'subject_id': 1,
    'term': 'نوبت اول',
    'score': 17,
    'status': 'approved',
  });
  await s.put('discipline', 801, {
    'student_id': 21,
    'class_id': 5,
    'date': '2026-11-10',
    'kind': 'negative',
    'note': 'تأخیر',
  });
  await s.put('parent_msgs', 2800000000000001, {
    'student_id': 21,
    'parent_id': 40,
    'to': 'counselor',
    'kind': 'appointment',
    'text': 'برای انتخاب رشته وقت می‌خواهیم',
    'status': 'open',
    'created_at': '2026-11-11T08:00:00Z',
  });
  await s.put('parent_msgs', 2800000000000002, {
    'student_id': 21,
    'parent_id': 40,
    'to': 'teacher',
    'teacher_id': 30,
    'kind': 'message',
    'text': 'تکلیف ریاضی',
    'status': 'open',
    'created_at': '2026-11-11T09:00:00Z',
  });
}

void main() {
  testWidgets(
    'FC197-W01 parent child page: absence banner, report card, homework, exams, discipline, threads, contributions',
    (tester) async {
      final src = w5.MemorySource();
      await tester.runAsync(() => seedF27(src.engine));
      await w5.boot(tester, source: src);
      await openPage(tester, 'home');
      await w5.openKid(tester, 21);
      await settleAsync(tester);
      expect(find.byKey(const Key('chd-today-absent')), findsOneWidget);
      expect(find.byKey(const Key('chd-report-card')), findsOneWidget);
      expect(textIn(tester, 'chd-report-card'), contains('ریاضی'));
      expect(textIn(tester, 'home-homework'), contains('تمرین فصل ۲'));
      expect(textIn(tester, 'home-exams'), contains('فیزیک'));
      expect(textIn(tester, 'chd-discipline'), contains('همکاری در کلاس'));
      expect(textIn(tester, 'chd-msgs'), contains('سارا دیروز بیمار بود'));
      expect(textIn(tester, 'chd-msgs'), contains('ثبت شد، سلامت باشد'));
      expect(textIn(tester, 'chd-contrib'), contains('کمک به آزمایشگاه'));
      // nothing editable about contributions
      expect(find.byKey(const Key('chd-contrib-add')), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'FC197-W02 parent writes to a teacher (shown as «دبیرِ <درس>», never by name) — queued with fixed fields',
    (tester) async {
      final src = w5.MemorySource();
      await tester.runAsync(() => seedF27(src.engine));
      await w5.boot(tester, source: src);
      await openPage(tester, 'home');
      await w5.openKid(tester, 21);
      await settleAsync(tester);
      await w5.tapKey(tester, 'chd-msg-add');
      await tester.tap(find.byKey(const Key('pmf-to')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('دبیر').last);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('pmf-teacher')));
      await tester.pumpAndSettle();
      expect(find.text('آقای رضایی'), findsNothing);
      await tester.tap(find.text('دبیرِ ریاضی').last);
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('pmf-text')),
        'لطفاً تمرین بیشتری بدهید',
      );
      await w5.tapKey(tester, 'pmf-submit');
      await settleAsync(tester);
      final rows = await tester.runAsync(() => src.engine.list('parent_msgs'));
      final mine = rows!
          .where((r) => r.data['text'] == 'لطفاً تمرین بیشتری بدهید')
          .single;
      expect(mine.data['to'], 'teacher');
      expect(mine.data['teacher_id'], 30);
      expect(mine.data['parent_id'], 10);
      expect(mine.data['status'], 'open');
      expect(textIn(tester, 'chd-msgs'), contains('لطفاً تمرین بیشتری بدهید'));
      await tester.pumpWidget(const SizedBox());
    },
  );

  test('FC197-W03 navigation mirrors client/pages.js navConfig', () {
    final c = webNavConfig('counselor').map((e) => e.$1).toList();
    expect(c.take(3), ['cqueue', 'cstudents', 'pmsgs']);
    expect(webNavConfig('teacher').map((e) => e.$1), contains('pmsgs'));
    expect(webNavConfig('manager').map((e) => e.$1), contains('pmsgs'));
    expect(webNavConfig('parent').map((e) => e.$1), isNot(contains('pmsgs')));
  });

  testWidgets(
    'FC197-W04 counselor inbox: only «to counselor»; schedules an appointment with day and hour',
    (tester) async {
      tallView(tester);
      final (_, s) = await bootSchool(
        tester,
        role: 'counselor',
        seed: seedDesk,
      );
      await openPage(tester, 'pmsgs');
      expect(find.byKey(const Key('pm-row-2800000000000001')), findsOneWidget);
      // the teacher's thread is not the counselor's
      expect(find.byKey(const Key('pm-row-2800000000000002')), findsNothing);
      expect(find.byKey(const Key('pm-book')), findsOneWidget);
      await tapKey(tester, 'pm-reply-2800000000000001');
      await tester.enterText(
        find.byKey(const Key('pmr-reply')),
        'دوشنبه ساعت ۱۰:۳۰',
      );
      await tester.tap(find.byKey(const Key('pmr-status')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('وقت ملاقات تعیین شد').last);
      await tester.pumpAndSettle();
      await tester.enterText(
        find.descendant(
          of: find.byKey(const Key('pmr-date')),
          matching: find.byType(TextField),
        ),
        '۱۴۰۵/۰۸/۲۵',
      );
      await tester.enterText(find.byKey(const Key('pmr-time')), '10:30');
      await tapKey(tester, 'pmr-save');
      await settle(tester);
      final row = await tester.runAsync(
        () => s.engine.get('parent_msgs', 2800000000000001),
      );
      expect(row!.data['status'], 'scheduled');
      expect(row.data['appt_date'], '2026-11-16');
      expect(row.data['appt_time'], '10:30');
      expect(row.data['reply'], 'دوشنبه ساعت ۱۰:۳۰');
      expect(row.data['text'], 'برای انتخاب رشته وقت می‌خواهیم');
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'FC197-W05 teacher inbox: only threads addressed to them; no «scheduled»',
    (tester) async {
      tallView(tester);
      await bootSchool(
        tester,
        role: 'teacher',
        seed: (s) => seedDesk(s, role: 'teacher'),
      );
      // seedDesk addresses thread 2 to teacher 30; the signed-in teacher is uid 10
      await openPage(tester, 'pmsgs');
      expect(find.byKey(const Key('pm-empty')), findsOneWidget);
      expect(find.byKey(const Key('pm-book')), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'FC197-W06 counselor desk: every student, read-only record, a guidance note with a track',
    (tester) async {
      tallView(tester);
      final (_, s) = await bootSchool(
        tester,
        role: 'counselor',
        seed: seedDesk,
      );
      await openPage(tester, 'cstudents');
      expect(find.byKey(const Key('cst-row-21')), findsOneWidget);
      expect(find.byKey(const Key('cst-row-22')), findsOneWidget);
      // staff are not students
      expect(find.byKey(const Key('cst-row-30')), findsNothing);
      await tester.enterText(find.byKey(const Key('cst-search')), 'نیما');
      await settle(tester);
      expect(find.byKey(const Key('cst-row-21')), findsNothing);
      await tester.enterText(find.byKey(const Key('cst-search')), '');
      await settle(tester);
      await tapKey(tester, 'cst-row-21');
      await settleAsync(tester);
      expect(textIn(tester, 'cs-report-card'), contains('ریاضی'));
      expect(textIn(tester, 'cs-discipline'), contains('تأخیر'));
      expect(find.byKey(const Key('cs-notes-none')), findsOneWidget);
      // read only: no grade / discipline editing on this page
      expect(find.byKey(const Key('rec-grades')), findsNothing);
      await tapKey(tester, 'cs-note-add');
      await tester.tap(find.byKey(const Key('csn-kind')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('هدایت تحصیلی').last);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('csn-track')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('ریاضی و فیزیک').last);
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('csn-text')),
        'علاقه به ریاضی، معدل خوب',
      );
      await tapKey(tester, 'csn-save');
      await settle(tester);
      final notes = await tester.runAsync(
        () => s.engine.list('counselor_notes'),
      );
      expect(notes!.single.data['kind'], 'guidance');
      expect(notes.single.data['track'], 'ریاضی و فیزیک');
      expect(notes.single.data['student_id'], 21);
      expect(notes.single.data['author_id'], 10);
      expect(
        textIn(tester, 'cs-notes'),
        contains('رشتهٔ پیشنهادی: ریاضی و فیزیک'),
      );
      await tester.pumpWidget(const SizedBox());
    },
  );
}
