// ردیف ۱۹۵ — ساختار مدرسه در اپ واقعی (پوسته، صفحه‌ها، کنترلرها، ClassBook و Timetable روی SQLite
// درون‌حافظه + صف ماندگار): ابتدایی/متوسطه اول «کلاس‌محور» (کلاس‌های ثابت، برنامهٔ هر کلاس جدا)،
// متوسطه دوم «رشته‌محور» (پایه × رشته، محل هر زنگ را مدیر تعیین می‌کند).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'nav_support.dart';
import 'school_support.dart';

Future<void> primary(MemorySchool s) async {
  await s.put('schools', 1, {
    'name': 'دبستان',
    'level': 'ابتدایی',
    'workdays': [0, 1, 2, 3, 4],
  });
  await s.put('users', 10, {'name': 'مدیر', 'role': 'manager'});
  await s.put('users', 11, {
    'name': 'خانم رضایی',
    'role': 'teacher',
    'subject': 'ریاضی',
  });
  await s.put('lookups', 1, {'kind': 'grade', 'name': 'سوم'});
  await s.put('classes', 5, {
    'name': 'سوم الف',
    'grade': 'سوم',
    'kind': 'class',
    'mode': 'class',
    'room': 'اتاق ۳',
    'teacher_id': 11,
    'capacity': 2,
  });
  await s.put('classes', 6, {
    'name': 'سوم ب',
    'grade': 'سوم',
    'kind': 'class',
    'mode': 'class',
  });
  await s.put('classes', 7, {'name': 'آزمایشگاه', 'kind': 'room'});
  await s.put('subjects', 41, {'name': 'ریاضی', 'weekly_hours': 2});
  await s.put('users', 21, {'name': 'سارا', 'role': 'student', 'class_id': 5});
  await s.put('users', 22, {'name': 'مینا', 'role': 'student', 'class_id': 5});
}

Future<void> choose(WidgetTester tester, String dropdown, String text) async {
  await tapKey(tester, dropdown);
  await tester.tap(find.text(text).last);
  await settle(tester);
}

Future<MemorySchool> open(
  WidgetTester tester,
  String page,
  Future<void> Function(MemorySchool s) seed,
) async {
  tallView(tester);
  final (_, s) = await bootSchool(tester, role: 'manager', seed: seed);
  await openPage(tester, page);
  return s;
}

void main() {
  testWidgets('S195-W01 دبستان (کلاس‌محور): خط ساختار، جدول کلاس‌های ثابت با اتاق/دبیر پایه/پرشدگی؛ '
      'NEG بدون کارت «رشته‌ها» و بدون انتخاب رشته در فرم', (tester) async {
    final s = await open(tester, 'classes', primary);
    expect(textOf(tester, 'cls-structure'), contains('کلاس‌محور'));
    expect(textOf(tester, 'cls-structure'), contains('ابتدایی'));
    expect(find.byKey(const Key('cls-defs-branch')), findsNothing);
    expect(find.byKey(const Key('cls-classes')), findsOneWidget);
    expect(find.byKey(const Key('cls-class-5')), findsOneWidget);
    expect(find.text('اتاق ۳'), findsOneWidget);
    expect(find.text('خانم رضایی'), findsOneWidget);
    expect(find.text('۲ / ۲'), findsOneWidget, reason: 'پر = هشدار');
    await tapKey(tester, 'cls-class-add');
    expect(find.byKey(const Key('cf-mode-fixed')), findsOneWidget);
    expect(find.byKey(const Key('cf-f-mode')), findsNothing);
    expect(find.byKey(const Key('cf-f-branch')), findsNothing);
    await choose(tester, 'cf-f-grade', 'سوم');
    await typeKey(tester, 'cf-f-name', 'سوم ج');
    await typeKey(tester, 'cf-f-room', 'اتاق ۵');
    await typeKey(tester, 'cf-f-capacity', '۲۵');
    await choose(tester, 'cf-f-teacher', 'خانم رضایی');
    await tapKey(tester, 'cf-save');
    expect(find.byKey(const Key('cf-save')), findsNothing, reason: 'closed');
    final op = s.outbox.list().single;
    expect(op.collection, 'classes');
    expect(op.payload!['mode'], 'class');
    expect(op.payload!['room'], 'اتاق ۵');
    expect(op.payload!['capacity'], 25);
    expect(op.payload!['teacher_id'], 11);
    expect(find.text('سوم ج'), findsOneWidget);
  });

  testWidgets(
    'S195-W02 برنامهٔ دبستان: انتخابگر کلاس (نه پایه/رشته)، زنگ هر کلاس جدا؛ '
    'NEG «سوم ب» برنامهٔ «سوم الف» را ندارد',
    (tester) async {
      final s = await open(tester, 'schedule', primary);
      expect(find.byKey(const Key('sch-class')), findsOneWidget);
      expect(find.byKey(const Key('sch-grade')), findsNothing);
      expect(textOf(tester, 'sch-class-hint'), contains('اتاق ۳'));
      expect(textOf(tester, 'sch-class-hint'), contains('خانم رضایی'));
      await tapKey(tester, 'sch-cell-0-1');
      expect(textOf(tester, 'slot-cohort'), 'کلاس: سوم الف');
      await choose(tester, 'slot-f-subject', 'ریاضی');
      await tapKey(tester, 'slot-save');
      expect(find.byKey(const Key('slot-save')), findsNothing);
      final op = s.outbox.list().single;
      expect(op.collection, 'schedule');
      expect(op.payload!['class_id'], 5);
      expect(op.payload!['room'], 'اتاق ۳');
      expect(find.text('ریاضی'), findsWidgets);
      await choose(tester, 'sch-class', 'سوم ب');
      expect(textOf(tester, 'sch-class-hint'), isNot(contains('اتاق ۳')));
      // همان زنگ برای «سوم ب» آزاد است
      await tapKey(tester, 'sch-cell-0-1');
      expect(textOf(tester, 'slot-cohort'), 'کلاس: سوم ب');
      await choose(tester, 'slot-f-subject', 'ریاضی');
      await tapKey(tester, 'slot-save');
      expect(find.byKey(const Key('slot-save')), findsNothing);
      expect(s.outbox.list().last.payload!['class_id'], 6);
    },
  );

  testWidgets('Q04-W01 هنرستان: اتاق «نقشه کشی» کلاس شمرده نمی‌شود، '
      'پایهٔ تکراری یک بار، رشته‌ها با شمار دانش‌آموز', (tester) async {
    Future<void> voc(MemorySchool s) async {
      await s.put('schools', 1, {'name': 'هنرستان', 'level': 'متوسطه دوم'});
      await s.put('users', 10, {'name': 'مدیر', 'role': 'manager'});
      await s.put('lookups', 1, {'kind': 'grade', 'name': 'دهم'});
      await s.put('lookups', 9, {'kind': 'grade', 'name': 'دهم'});
      await s.put('lookups', 2, {'kind': 'branch', 'name': 'نقشه کشی'});
      await s.put('classes', 7, {'name': 'نقشه کشی', 'kind': 'room'});
      await s.put('classes', 8, {
        'name': 'دهم نقشه کشی',
        'grade': 'دهم',
        'branch': 'نقشه کشی',
        'mode': 'field',
        'kind': 'class',
      });
      for (var i = 0; i < 3; i++) {
        await s.put('users', 100 + i, {
          'name': 'هنرجو $i',
          'role': 'student',
          'grade': 'دهم',
          'field': 'نقشه کشی',
          'class_id': i == 0 ? 8 : null,
        });
      }
    }

    await open(tester, 'classes', voc);
    // like the web (row 172) a field school lists no classes; the group class is in attendance
    expect(find.byKey(const Key('cls-class-add')), findsNothing);
    Finder inside(String key, String text) =>
        find.descendant(of: find.byKey(Key(key)), matching: find.text(text));
    expect(inside('cls-defs-grade', 'دهم'), findsOneWidget);
    expect(inside('cls-def-students-2', '۳ دانش‌آموز'), findsOneWidget);
    expect(inside('cls-def-students-1', '۳ دانش‌آموز'), findsOneWidget);
    // the room «نقشه کشی» is not counted; row 204: a field school names the grades of a branch,
    // never «کلاس»
    expect(inside('cls-defs-branch', 'در ۱ پایه'), findsOneWidget);
    expect(
      inside('cls-defs-branch', '۱ کلاس از این مورد استفاده می‌کند'),
      findsNothing,
    );
  });

  testWidgets('S195-W03 دبیرستان (رشته‌محور): خط ساختار، کارت «رشته‌ها»؛ NEG بدون «+ کلاس جدید»؛ '
      'برنامه با پایه و رشته و محل الزامی', (tester) async {
    Future<void> high(MemorySchool s) async {
      await s.put('schools', 1, {
        'name': 'دبیرستان',
        'level': 'متوسطه دوم',
        'branches': ['نظری'],
        'workdays': [0, 1, 2, 3, 4],
      });
      await s.put('users', 10, {'name': 'مدیر', 'role': 'manager'});
      await s.put('lookups', 1, {'kind': 'grade', 'name': 'دهم'});
      await s.put('lookups', 2, {'kind': 'branch', 'name': 'علوم تجربی'});
      await s.put('classes', 7, {'name': 'کارگاه ۱', 'kind': 'room'});
      await s.put('subjects', 41, {'name': 'زیست', 'weekly_hours': 2});
    }

    await open(tester, 'classes', high);
    expect(textOf(tester, 'cls-structure'), contains('رشته‌محور'));
    expect(find.byKey(const Key('cls-defs-branch')), findsOneWidget);
    expect(find.byKey(const Key('cls-class-add')), findsNothing);
    expect(find.byKey(const Key('cls-classes')), findsNothing);
    await tester.pumpWidget(const SizedBox());
    final s = await open(tester, 'schedule', high);
    expect(find.byKey(const Key('sch-grade')), findsOneWidget);
    expect(find.byKey(const Key('sch-class')), findsNothing);
    await choose(tester, 'sch-branch', 'علوم تجربی');
    await tapKey(tester, 'sch-cell-0-1');
    await choose(tester, 'slot-f-subject', 'زیست');
    await tapKey(tester, 'slot-save');
    expect(textOf(tester, 'slot-form-error'), contains('محل برگزاری'));
    expect(s.outbox.list(), isEmpty);
    await choose(tester, 'slot-f-room', 'کارگاه ۱');
    await tapKey(tester, 'slot-save');
    expect(find.byKey(const Key('slot-save')), findsNothing);
    expect(
      s.outbox
          .list()
          .where((o) => o.collection == 'schedule')
          .single
          .payload!['room'],
      'کارگاه ۱',
    );
  });

  testWidgets(
    'S195-W04 فرم کاربر در دبستان: دانش‌آموز پایه و کلاس دارد؛ NEG کادر «رشته» نیست',
    (tester) async {
      await open(tester, 'users', primary);
      await tapKey(tester, 'usr-add');
      await tapKey(tester, 'usr-f-kind-student');
      expect(find.byKey(const Key('usr-f-grade')), findsOneWidget);
      expect(find.byKey(const Key('usr-f-class')), findsOneWidget);
      expect(find.byKey(const Key('usr-f-branch')), findsNothing);
    },
  );
}
