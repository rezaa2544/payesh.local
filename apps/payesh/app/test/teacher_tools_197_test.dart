// Row 197 — Q12 (F19): the teacher's class tools in the app — homework for their own classes,
// discipline notes and «ارجاع به مشاور» on «دانش‌آموزان من», class notices on «اطلاعیه‌ها», and
// an explained empty page when no timetable names them yet. Web twin: tests/teacher-tools-197.js.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'nav_support.dart';
import 'notices_wave4_test.dart' as w4;
import 'school_support.dart';

/// Teacher (uid 10) teaches class 5; class 6 is someone else's.
Future<void> seed(MemorySchool s) async {
  await s.put('classes', 5, {'name': 'هفتم الف'});
  await s.put('classes', 6, {'name': 'هشتم ب'});
  await s.put('users', 10, {'name': 'دبیر علوم', 'role': 'teacher'});
  await s.put('users', 21, {'name': 'بهار', 'role': 'student', 'class_id': 5});
  await s.put('users', 22, {'name': 'آرش', 'role': 'student', 'class_id': 6});
  await s.put('schedule', 900, {'teacher_id': 10, 'class_id': 5});
  await s.put('homework', 300, {
    'class_id': 5,
    'title': 'تکلیف دبیر دیگر',
    'author_id': 77,
    'date': '2026-11-10',
  });
}

/// A teacher no timetable names yet (the live test teacher, F19 «دانش‌آموزان من = ۰»).
Future<void> seedNoSchedule(MemorySchool s) async {
  await s.put('classes', 5, {'name': 'هفتم الف'});
  await s.put('users', 10, {'name': 'دبیر تازه', 'role': 'teacher'});
  await s.put('users', 21, {'name': 'بهار', 'role': 'student', 'class_id': 5});
}

void main() {
  testWidgets('TT197-A01 homework: add for own class, delete only own rows', (
    tester,
  ) async {
    tallView(tester);
    final (_, s) = await bootSchool(tester, role: 'teacher', seed: seed);
    await openPage(tester, 'students');
    expect(find.byKey(const Key('hw-card')), findsOneWidget);
    expect(find.byKey(const Key('hw-row-300')), findsOneWidget);
    // another teacher's homework has no «حذف»
    expect(find.byKey(const Key('hw-delete-300')), findsNothing);
    await tapKey(tester, 'hw-add');
    // empty title refused, nothing queued
    await tapKey(tester, 'hw-save');
    expect(find.byKey(const Key('hw-form-error')), findsOneWidget);
    expect(s.outbox.list(), isEmpty);
    await typeKey(tester, 'hw-f-title', 'تمرین صفحهٔ ۴۲');
    await typeKey(tester, 'hw-f-due', '۱۴۰۵/۰۸/۳۰');
    await tapKey(tester, 'hw-save');
    expect(textOf(tester, 'std-notice'), 'تکلیف ثبت شد');
    final op = s.outbox.list().single;
    expect(op.collection, 'homework');
    expect(op.payload!['class_id'], 5);
    expect(op.payload!['author_id'], 10);
    expect(op.payload!['due'], '2026-11-21');
    final id = op.id;
    await tapKey(tester, 'hw-delete-$id');
    expect(find.byKey(Key('hw-row-$id')), findsNothing);
    expect(s.outbox.list().last.type, 'del');
  });

  testWidgets('TT197-A02 discipline and referral only for own students', (
    tester,
  ) async {
    tallView(tester);
    final (_, s) = await bootSchool(tester, role: 'teacher', seed: seed);
    await openPage(tester, 'students');
    expect(find.byKey(const Key('std-row-22')), findsNothing);
    await tapKey(tester, 'std-disc-21');
    await tapKey(tester, 'disc-kind-negative');
    await typeKey(tester, 'disc-f-note', 'تکلیف را نیاورد');
    await tapKey(tester, 'disc-save');
    expect(textOf(tester, 'std-notice'), 'یادداشت انضباطی ثبت شد');
    final d = s.outbox.list().single;
    expect(d.collection, 'discipline');
    expect(d.payload!['kind'], 'negative');
    expect(d.payload!['student_id'], 21);
    expect(d.payload!['class_id'], 5);
    await tapKey(tester, 'std-cref-21');
    await tapKey(tester, 'cref-save');
    expect(find.byKey(const Key('cref-form-error')), findsOneWidget);
    await typeKey(tester, 'cref-f-reason', 'افت ناگهانی نمره‌ها');
    await tapKey(tester, 'cref-save');
    expect(textOf(tester, 'std-notice'), 'به صف مشاور ارجاع شد');
    final r = s.outbox.list().last;
    expect(r.collection, 'counselor_refs');
    expect(r.payload!['referred_by'], 10);
    expect(r.payload!['status'], 'open');
  });

  testWidgets(
    'TT197-A03 no timetable yet: the empty page says why (not «یافت نشد»)',
    (tester) async {
      await bootSchool(tester, role: 'teacher', seed: seedNoSchedule);
      await openPage(tester, 'students');
      expect(textOf(tester, 'std-count'), '۰ نفر');
      expect(find.textContaining('برنامهٔ هفتگی'), findsWidgets);
      expect(find.byKey(const Key('hw-no-class')), findsOneWidget);
      expect(find.byKey(const Key('hw-add')), findsNothing);
    },
  );

  testWidgets(
    'TT197-A04 class notice: teacher picks own class; no day-off card',
    (tester) async {
      final src = w4.MemorySource();
      await tester.runAsync(() async {
        Future<void> put(String c, int id, Map<String, Object?> d) =>
            src.engine.put(c, id, {...d, 'id': id}, version: 1);
        await put('classes', 5, {'name': 'هفتم الف'});
        await put('classes', 6, {'name': 'هشتم ب'});
        await put('users', 10, {'name': 'دبیر علوم', 'role': 'teacher'});
        await put('schedule', 900, {'teacher_id': 10, 'class_id': 5});
      });
      await w4.boot(tester, role: 'teacher', source: src);
      await openPage(tester, 'announcements');
      expect(find.byKey(const Key('ntc-dayoff-card')), findsNothing);
      // the manager's school-wide notices: readable, not editable by a teacher
      expect(find.byKey(const Key('ntc-card-1')), findsOneWidget);
      expect(find.byKey(const Key('ntc-edit-1')), findsNothing);
      await w4.tapKey(tester, 'ntc-add');
      expect(find.byKey(const Key('ntc-class')), findsOneWidget);
      await tester.enterText(find.byKey(const Key('ntc-title')), 'آزمونک شنبه');
      await tester.enterText(find.byKey(const Key('ntc-body')), 'فصل ۳');
      await tester.pump();
      await w4.tapKey(tester, 'ntc-submit');
      final op = src.outbox.list().single;
      expect(op.collection, 'announcements');
      expect(op.payload!['class_id'], 5);
      expect(op.payload!['author_id'], 10);
      expect(find.byKey(Key('ntc-class-${op.id}')), findsOneWidget);
      expect(find.byKey(Key('ntc-edit-${op.id}')), findsOneWidget);
    },
  );
}
