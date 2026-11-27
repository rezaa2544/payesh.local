// Row 194 — «کاربر جدید»: the role comes first, each role has its own complete form; a
// student brings the father's and mother's accounts, a teacher's subjects come from «دروس» with
// پایه/رشته (and a new subject written in the form is saved into «دروس»), a staff member gets
// «سطح دسترسی» ticks. REAL shell, pages, controllers and UserDirectory on in-memory SQLite.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'nav_support.dart';
import 'school_support.dart';

Future<void> seed(MemorySchool s) async {
  await s.put('lookups', 1, {'kind': 'grade', 'name': 'دهم'});
  await s.put('lookups', 2, {'kind': 'grade', 'name': 'یازدهم'});
  await s.put('lookups', 3, {'kind': 'branch', 'name': 'الکترونیک'});
  await s.put('classes', 5, {
    'name': 'دهم الف',
    'grade': 'دهم',
    'branch': 'الکترونیک',
  });
  await s.put('classes', 6, {'name': 'یازدهم ب', 'grade': 'یازدهم'});
  await s.put('subjects', 41, {'name': 'ریاضی'});
  await s.put('users', 10, {
    'name': 'مدیر',
    'role': 'manager',
    'phone': '09120000010',
  });
  await s.put('users', 40, {
    'name': 'مریم',
    'role': 'parent',
    'phone': '09120000040',
  });
}

Future<MemorySchool> openForm(WidgetTester tester) async {
  tallView(tester);
  final (_, s) = await bootSchool(tester, role: 'manager', seed: seed);
  await openPage(tester, 'users');
  await tapKey(tester, 'usr-add');
  return s;
}

Future<void> pick(WidgetTester tester, String key, String item) async {
  await tapKey(tester, key);
  await tester.tap(find.text(item).last);
  await settle(tester);
}

Map<String, Object?> lastUser(MemorySchool s) =>
    s.outbox.list().where((o) => o.collection == 'users').first.payload!;

void main() {
  testWidgets('U194-01 the role comes first: no fields until a role is picked; '
      'the role filter has only the five groups', (tester) async {
    final s = await openForm(tester);
    expect(find.byKey(const Key('usr-f-kind-hint')), findsOneWidget);
    expect(find.byKey(const Key('usr-f-name')), findsNothing);
    for (final k in ['student', 'teacher', 'parent', 'exec']) {
      expect(find.byKey(Key('usr-f-kind-$k')), findsOneWidget);
    }
    await tapKey(tester, 'usr-save');
    expect(textOf(tester, 'usr-form-error'), 'اول نقش را انتخاب کنید');
    expect(s.outbox.list(), isEmpty);
    await tapKey(tester, 'usr-f-kind-teacher');
    expect(find.byKey(const Key('usr-f-name')), findsOneWidget);
    expect(find.byKey(const Key('usr-f-personnel_code')), findsOneWidget);
    expect(find.byKey(const Key('usr-f-father_name')), findsNothing);
    Navigator.of(tester.element(find.byKey(const Key('usr-save')))).pop();
    await settle(tester);
    for (final k in ['all', 'student', 'teacher', 'parent', 'exec']) {
      expect(find.byKey(Key('usr-role-$k')), findsOneWidget);
    }
    expect(find.byKey(const Key('usr-role-counselor')), findsNothing);
    expect(find.byKey(const Key('usr-role-manager')), findsNothing);
  });

  testWidgets(
    'U194-02 student: پایه/رشته from the school\'s definitions, the class '
    'list follows them; father + mother accounts are made and linked',
    (tester) async {
      final s = await openForm(tester);
      await tapKey(tester, 'usr-f-kind-student');
      await typeKey(tester, 'usr-f-name', 'کیان رادمهر');
      await typeKey(tester, 'usr-f-nid', '0098765432');
      await pick(tester, 'usr-f-grade', 'دهم');
      // row 204: the school reads as field-based (a class has a branch) — the student is placed
      // by پایه + رشته, there is no «کلاس» to choose
      expect(find.byKey(const Key('usr-f-class')), findsNothing);
      await pick(tester, 'usr-f-branch', 'الکترونیک');
      await typeKey(tester, 'usr-f-father_name', 'علی رادمهر');
      await typeKey(tester, 'usr-f-father_phone', '09124445566');
      await typeKey(tester, 'usr-f-father_job', 'کارمند');
      await typeKey(tester, 'usr-f-mother_name', 'سارا نیک');
      await typeKey(tester, 'usr-f-mother_phone', '09120000040');
      await tapKey(tester, 'usr-save');
      expect(find.byKey(const Key('usr-save')), findsNothing);
      final notice = textOf(tester, 'usr-notice');
      expect(notice, contains('حساب پدر ساخته شد'));
      expect(notice, contains('به حساب موجود مادر وصل شد'));
      final out = s.outbox.list();
      expect(out.map((o) => o.collection), [
        'users',
        'users',
        'parent_links',
        'parent_links',
      ]);
      final st = out.first.payload!;
      expect(st['role'], 'student');
      expect(st['grade'], 'دهم');
      expect(st['class_id'], isNull);
      expect(st['field'], 'الکترونیک');
      expect(st['father_job'], 'کارمند');
      expect(out[1].payload!['role'], 'parent');
      expect(out[1].payload!['phone'], '09124445566');
      expect(
        out[3].payload!['parent_id'],
        40,
        reason: 'mother re-used, no dup',
      );
    },
  );

  testWidgets(
    'U194-03 teacher: subjects from «دروس» with پایه/رشته; a new subject '
    'is saved into «دروس» without leaving the form',
    (tester) async {
      final s = await openForm(tester);
      await tapKey(tester, 'usr-f-kind-teacher');
      await typeKey(tester, 'usr-f-name', 'نرگس امینی');
      await typeKey(tester, 'usr-f-phone', '09120000077');
      await pick(tester, 'usr-f-employment', 'رسمی');
      await pick(tester, 'usr-f-teach-subject', 'ریاضی');
      await pick(tester, 'usr-f-teach-grade', 'دهم');
      await tapKey(tester, 'usr-f-teach-add');
      expect(find.byKey(const Key('usr-f-teach-0')), findsOneWidget);
      await typeKey(tester, 'usr-f-newsubject', 'الکترونیک عمومی');
      await tapKey(tester, 'usr-f-newsubject-add');
      expect(find.byKey(const Key('usr-save')), findsOneWidget, reason: 'open');
      expect(s.outbox.list().single.collection, 'subjects');
      await tapKey(tester, 'usr-f-teach-add');
      expect(find.byKey(const Key('usr-f-teach-1')), findsOneWidget);
      await tapKey(tester, 'usr-save');
      expect(find.byKey(const Key('usr-save')), findsNothing);
      final t = lastUser(s);
      expect(t['role'], 'teacher');
      expect(t['employment'], 'رسمی');
      final teaches = (t['teaches']! as List).cast<Map<String, Object?>>();
      expect(teaches, hasLength(2));
      expect(teaches[0]['subject_id'], 41);
      expect(teaches[0]['grade'], 'دهم');
      expect(teaches[1]['subject'], 'الکترونیک عمومی');
      final subjects = await tester.runAsync(() => s.engine.list('subjects'));
      expect(subjects!.map((r) => r.data['name']), contains('الکترونیک عمومی'));
    },
  );

  testWidgets('U194-04 staff: the post, personnel data and «سطح دسترسی» ticks; '
      'معاون has everything (no ticks)', (tester) async {
    final s = await openForm(tester);
    await tapKey(tester, 'usr-f-kind-exec');
    expect(find.byKey(const Key('usr-f-access-all')), findsOneWidget);
    await pick(tester, 'usr-f-role', 'مشاور');
    expect(find.byKey(const Key('usr-f-access-all')), findsNothing);
    await typeKey(tester, 'usr-f-name', 'حمید صالحی');
    await typeKey(tester, 'usr-f-phone', '09120000088');
    await typeKey(tester, 'usr-f-position', 'مشاور پایهٔ دهم');
    await tapKey(tester, 'usr-f-access-attendance');
    await tapKey(tester, 'usr-f-access-notices');
    await tapKey(tester, 'usr-save');
    expect(find.byKey(const Key('usr-save')), findsNothing);
    final u = lastUser(s);
    expect(u['role'], 'counselor');
    expect(u['position'], 'مشاور پایهٔ دهم');
    expect(u['access'], ['attendance', 'notices']);
  });

  testWidgets('U194-05 NEG parent mobile equal to the student\'s own: refused, '
      'nothing queued', (tester) async {
    final s = await openForm(tester);
    await tapKey(tester, 'usr-f-kind-student');
    await typeKey(tester, 'usr-f-name', 'کیان');
    await typeKey(tester, 'usr-f-phone', '09125550000');
    await typeKey(tester, 'usr-f-father_phone', '09125550000');
    await tapKey(tester, 'usr-save');
    expect(textOf(tester, 'usr-form-error'), contains('همراه پدر'));
    expect(s.outbox.list(), isEmpty);
  });
}
