// Row 128, wave W6 — users, students and the student record. Widget tests drive the REAL app
// shell, the REAL pages/controllers and the REAL UserDirectory on an in-memory SQLite + durable
// outbox; only the server is absent (the real server path is
// packages/payesh_sync/test/school_admin_it_test.dart, W6-IT-*).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_sync/payesh_sync.dart';

import 'school_support.dart';

Future<void> seed(MemorySchool s) async {
  await s.put('classes', 5, {'name': 'دهم الف'});
  await s.put('classes', 6, {'name': 'یازدهم'});
  await s.put('subjects', 41, {'name': 'ریاضی'});
  await s.put('users', 10, {
    'name': 'مدیر',
    'role': 'manager',
    'phone': '09120000010',
  });
  await s.put('users', 11, {
    'name': 'دبیر',
    'role': 'teacher',
    'phone': '09120000011',
  });
  await s.put('users', 21, {
    'name': 'بهار سعیدی',
    'role': 'student',
    'class_id': 5,
    'national_id': '0012345678',
    'birth_date': '2010-03-01',
  });
  await s.put('users', 22, {'name': 'آرش', 'role': 'student', 'class_id': 6});
  await s.put('users', 40, {
    'name': 'مریم',
    'role': 'parent',
    'phone': '09120000040',
  });
  await s.put('parent_links', 700, {
    'parent_id': 40,
    'student_id': 21,
    'relation': 'مادر',
  });
  await s.put('schedule', 900, {
    'teacher_id': 10,
    'class_id': 5,
    'subject_id': 41,
  });
  await s.put('grades', 1, {
    'student_id': 21,
    'subject_id': 41,
    'score': 17,
    'status': 'approved',
  });
}

/// Teacher (uid 10) teaches class 5 only.
Future<void> seedTeacher(MemorySchool s) async {
  await seed(s);
  await s.put('users', 10, {'name': 'دبیر ریاضی', 'role': 'teacher'});
}

/// Student (uid 10) with grades and attendance.
Future<void> seedStudent(MemorySchool s) async {
  await seed(s);
  await s.put('users', 10, {
    'name': 'سارا',
    'role': 'student',
    'class_id': 5,
    'father_name': 'رضا',
  });
  await s.put('grades', 2, {
    'student_id': 10,
    'subject_id': 41,
    'score': 19,
    'status': 'approved',
  });
  await s.put('attendance', 1, {'student_id': 10, 'status': 'present'});
  await s.put('attendance', 2, {'student_id': 10, 'status': 'absent'});
}

void main() {
  testWidgets(
    'W6-W01 manager: users + students entries; list, count, role filter, search',
    (tester) async {
      await bootSchool(tester, role: 'manager', seed: seed);
      expect(find.byKey(const Key('adm-users')), findsOneWidget);
      expect(find.byKey(const Key('adm-students')), findsOneWidget);
      expect(find.byKey(const Key('adm-record')), findsNothing);
      await tapKey(tester, 'adm-users');
      expect(textOf(tester, 'usr-count'), '۵ کاربر');
      await tapKey(tester, 'usr-role-parent');
      expect(textOf(tester, 'usr-count'), '۱ کاربر');
      expect(find.text('مادر'), findsNothing);
      expect(find.textContaining('ولیِ بهار سعیدی'), findsOneWidget);
      await tapKey(tester, 'usr-role-all');
      await submitKey(tester, 'usr-search', '0012345678');
      expect(find.byKey(const Key('usr-row-21')), findsOneWidget);
      expect(textOf(tester, 'usr-count'), '۱ کاربر');
    },
  );

  testWidgets(
    'W6-W02 add a student with a parent while offline → queued, rows marked',
    (tester) async {
      final (_, s) = await bootSchool(tester, role: 'manager', seed: seed);
      await tapKey(tester, 'adm-users');
      await tapKey(tester, 'usr-add');
      await typeKey(tester, 'usr-f-name', 'کیان');
      await typeKey(tester, 'usr-f-nid', '۰۰۹۸۷۶۵۴۳۲');
      await typeKey(tester, 'usr-f-parent-name', 'علی');
      await typeKey(tester, 'usr-f-parent-phone', '9124445566');
      await tapKey(tester, 'usr-save');
      expect(
        find.byKey(const Key('usr-save')),
        findsNothing,
        reason: 'form closed',
      );
      expect(textOf(tester, 'usr-notice'), contains('حساب ولی هم ساخته شد'));
      expect(s.outbox.list().map((o) => o.collection), [
        'users',
        'users',
        'parent_links',
      ]);
      expect(s.nudges, 1);
      expect(textOf(tester, 'usr-count'), '۷ کاربر');
      expect(find.text('در صف ارسال'), findsWidgets);
    },
  );

  testWidgets(
    'W6-W03 NEG bad national id / used mobile: the form stays, nothing queued',
    (tester) async {
      final (_, s) = await bootSchool(tester, role: 'manager', seed: seed);
      await tapKey(tester, 'adm-users');
      await tapKey(tester, 'usr-add');
      await typeKey(tester, 'usr-f-name', 'کیان');
      await typeKey(tester, 'usr-f-nid', '12345');
      await tapKey(tester, 'usr-save');
      expect(
        textOf(tester, 'usr-form-error'),
        'کد ملی باید دقیقاً ۱۰ رقم باشد',
      );
      await typeKey(tester, 'usr-f-nid', '');
      await typeKey(tester, 'usr-f-phone', '09120000011');
      await tapKey(tester, 'usr-save');
      expect(textOf(tester, 'usr-form-error'), contains('«دبیر»'));
      expect(find.byKey(const Key('usr-save')), findsOneWidget);
      expect(s.outbox.list(), isEmpty);
    },
  );

  testWidgets(
    'W6-W04 same name + birth date: warned first, saved only after confirming',
    (tester) async {
      final (_, s) = await bootSchool(tester, role: 'manager', seed: seed);
      await tapKey(tester, 'adm-users');
      await tapKey(tester, 'usr-add');
      await typeKey(tester, 'usr-f-name', 'بهار سعیدی');
      await typeKey(tester, 'usr-f-birth', '2010-03-01');
      await tapKey(tester, 'usr-save');
      expect(textOf(tester, 'usr-form-error'), contains('بهار سعیدی'));
      expect(find.text('شخص دیگری است — ذخیره'), findsOneWidget);
      expect(s.outbox.list(), isEmpty);
      await tapKey(tester, 'usr-save');
      expect(s.outbox.list(), hasLength(1));
    },
  );

  testWidgets(
    'W6-W05 edit: a used mobile is refused (NEG), a valid edit is queued',
    (tester) async {
      final (_, s) = await bootSchool(tester, role: 'manager', seed: seed);
      await tapKey(tester, 'adm-users');
      await tapKey(tester, 'usr-menu-22');
      await tapKey(tester, 'usr-edit-22');
      await typeKey(tester, 'usr-e-phone', '09120000040');
      await tapKey(tester, 'usr-save');
      expect(textOf(tester, 'usr-form-error'), contains('«مریم»'));
      expect(s.outbox.list(), isEmpty);
      await typeKey(tester, 'usr-e-phone', '9125550000');
      await tapKey(tester, 'usr-e-active');
      await tapKey(tester, 'usr-save');
      final op = s.outbox.list().single;
      expect(op.payload!['phone'], '09125550000');
      expect(op.payload!['active'], false);
      expect(op.baseVersion, 1);
      expect(find.textContaining('غیرفعال'), findsOneWidget);
    },
  );

  testWidgets(
    'W6-W06 full profile: the mother\'s mobile follows to the linked parent',
    (tester) async {
      final (_, s) = await bootSchool(tester, role: 'manager', seed: seed);
      await tapKey(tester, 'adm-users');
      await tapKey(tester, 'usr-menu-21');
      await tapKey(tester, 'usr-full-21');
      await typeKey(tester, 'usr-p-mother_phone', '9126660000');
      await typeKey(tester, 'usr-p-address', 'خیابان آزادی');
      await tapKey(tester, 'usr-save');
      expect(textOf(tester, 'usr-notice'), contains('حساب ولی هم به‌روز شد'));
      final parent = await tester.runAsync(() => s.engine.get('users', 40));
      expect(parent!.data['phone'], '09126660000');
      expect(s.outbox.list(), hasLength(2));
    },
  );

  testWidgets(
    'W6-W07 delete a student: confirm names the parent; cancel keeps everything (NEG)',
    (tester) async {
      final (_, s) = await bootSchool(tester, role: 'manager', seed: seed);
      await tapKey(tester, 'adm-users');
      await tapKey(tester, 'usr-menu-21');
      await tapKey(tester, 'usr-delete-21');
      expect(find.textContaining('ولیِ او هم (مریم)'), findsOneWidget);
      await tapKey(tester, 'usr-confirm-cancel');
      expect(s.outbox.list(), isEmpty);
      expect(find.byKey(const Key('usr-row-21')), findsOneWidget);
      await tapKey(tester, 'usr-menu-21');
      await tapKey(tester, 'usr-delete-21');
      await tapKey(tester, 'usr-confirm-ok');
      expect(find.byKey(const Key('usr-row-21')), findsNothing);
      expect(find.byKey(const Key('usr-row-40')), findsNothing);
      expect(s.outbox.list().map((o) => o.type).toSet(), {'del'});
    },
  );

  testWidgets(
    'W6-W08 multi-select: clear, then bulk delete; never your own account (NEG)',
    (tester) async {
      final (_, s) = await bootSchool(tester, role: 'manager', seed: seed);
      await tapKey(tester, 'adm-users');
      await tapKey(tester, 'usr-pick-22');
      await tapKey(tester, 'usr-pick-11');
      expect(find.byKey(const Key('usr-picked-bar')), findsOneWidget);
      await tapKey(tester, 'usr-pick-clear');
      expect(find.byKey(const Key('usr-picked-bar')), findsNothing);
      await tapKey(tester, 'usr-pick-10');
      await tapKey(tester, 'usr-bulk-delete');
      await tapKey(tester, 'usr-confirm-ok');
      expect(textOf(tester, 'usr-error'), 'حساب خودتان را نمی‌توانید حذف کنید');
      expect(s.outbox.list(), isEmpty);
      await tapKey(tester, 'usr-pick-10');
      await tapKey(tester, 'usr-pick-22');
      await tapKey(tester, 'usr-pick-11');
      await tapKey(tester, 'usr-bulk-delete');
      await tapKey(tester, 'usr-confirm-ok');
      expect(textOf(tester, 'usr-notice'), startsWith('2 '));
      expect(textOf(tester, 'usr-count'), '۳ کاربر');
    },
  );

  testWidgets(
    'W6-W09 teacher: only «students» (NEG no users page), only the taught class',
    (tester) async {
      await bootSchool(tester, role: 'teacher', seed: seedTeacher);
      expect(find.byKey(const Key('adm-users')), findsNothing);
      await tapKey(tester, 'adm-students');
      expect(textOf(tester, 'std-count'), '۱ نفر');
      expect(find.byKey(const Key('std-row-21')), findsOneWidget);
      expect(find.byKey(const Key('std-row-22')), findsNothing);
      expect(badgeOf(tester, 'std-avg-21'), 'معدل ۱۷.۰');
    },
  );

  testWidgets('W6-W10 student: own record — attendance %, grades, profile', (
    tester,
  ) async {
    await bootSchool(tester, role: 'student', seed: seedStudent);
    expect(find.byKey(const Key('adm-students')), findsNothing);
    await tapKey(tester, 'adm-record');
    expect(badgeOf(tester, 'rec-present'), 'حضور ۵۰٪');
    expect(textOf(tester, 'rec-class'), 'دهم الف');
    expect(find.byKey(const Key('rec-grade-0')), findsOneWidget);
    expect(find.text('رضا'), findsOneWidget);
  });

  testWidgets(
    'W6-W11 NEG wave off or no data path → no entry (never a dead button)',
    (tester) async {
      await bootSchool(tester, role: 'manager', seed: seed, school: 'schedule');
      expect(find.byKey(const Key('adm-users')), findsNothing);
      expect(find.byKey(const Key('adm-entry-none')), findsOneWidget);
      await bootSchool(tester, role: 'manager', seed: seed, wire: false);
      expect(find.byKey(const Key('adm-users')), findsNothing);
    },
  );

  testWidgets(
    'W6-W12 NEG full queue: add refused with the queue message, nothing written',
    (tester) async {
      final s = MemorySchool(config: const OutboxConfig(capacity: 0));
      await bootSchool(tester, role: 'manager', seed: seed, source: s);
      await tapKey(tester, 'adm-users');
      await tapKey(tester, 'usr-add');
      await typeKey(tester, 'usr-f-name', 'کیان');
      await tapKey(tester, 'usr-save');
      expect(textOf(tester, 'usr-form-error'), contains('صف ارسال پر است'));
      expect(await tester.runAsync(() => s.engine.count('users')), 5);
    },
  );
}
