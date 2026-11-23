// Row 128, wave W8 — classes, rooms, grade/branch definitions and subjects. Widget tests drive the
// REAL app shell, pages, controllers and ClassBook on an in-memory SQLite + durable outbox; the
// real server path is packages/payesh_sync/test/school_admin_it_test.dart W8-IT-*.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_sync/payesh_sync.dart';

import 'nav_support.dart';
import 'school_support.dart';

Future<void> seed(MemorySchool s) async {
  await s.put('users', 10, {'name': 'مدیر', 'role': 'manager'});
  await s.put('lookups', 1, {'kind': 'grade', 'name': 'دهم'});
  await s.put('lookups', 2, {'kind': 'branch', 'name': 'الکترونیک'});
  await s.put('lookups', 3, {'kind': 'grade', 'name': 'هفتم'});
  await s.put('lookups', 4, {'kind': 'branch', 'name': 'مکانیک'});
  await s.put('classes', 5, {
    'name': 'دهم الکترونیک',
    'grade': 'دهم',
    'branch': 'الکترونیک',
    'mode': 'field',
    'kind': 'class',
  });
  await s.put('classes', 6, {'name': 'کارگاه ۱', 'kind': 'room'});
  await s.put('classes', 7, {
    'name': 'هفتم الف',
    'grade': 'هفتم',
    'mode': 'class',
    'kind': 'class',
  });
  await s.put('subjects', 41, {'name': 'ریاضی'});
  await s.put('users', 21, {'name': 'بهار', 'role': 'student', 'class_id': 5});
  await s.put('users', 22, {
    'name': 'آرش',
    'role': 'student',
    'grade': 'دهم',
    'field': 'الکترونیک',
  });
  await s.put('users', 23, {'name': 'نیما', 'role': 'student', 'class_id': 7});
  await s.put('schedule', 900, {
    'class_id': 7,
    'subject_id': 41,
    'weekday': 1,
    'bell_order': 1,
  });
}

Future<MemorySchool> openClasses(
  WidgetTester tester, {
  MemorySchool? source,
  Future<void> Function(MemorySchool s)? extra,
}) async {
  tallView(tester);
  final (_, s) = await bootSchool(
    tester,
    role: 'manager',
    seed: (s) async {
      await seed(s);
      await extra?.call(s);
    },
    source: source,
  );
  await openPage(tester, 'classes');
  return s;
}

Future<void> choose(WidgetTester tester, String dropdown, String text) async {
  await tapKey(tester, dropdown);
  await tester.tap(find.text(text).last);
  await settle(tester);
}

void main() {
  testWidgets(
    'W8-W01 the web page (row 172): rooms table, grades, branches and subjects with usage '
    '(classes themselves are not listed, like the web); NEG not on a teacher\'s home',
    (tester) async {
      await openClasses(tester);
      expect(textOf(tester, 'web-title'), 'کلاس‌ها و تعریف‌ها');
      expect(find.byKey(const Key('cls-room-6')), findsOneWidget);
      expect(find.byKey(const Key('cls-room-5')), findsNothing);
      expect(find.byKey(const Key('cls-room-7')), findsNothing);
      // a field school (a class in «field» mode): no «+ کلاس جدید», like web `isFieldSchool`
      expect(find.byKey(const Key('cls-class-add')), findsNothing);
      await reveal(tester, 'cls-def-1');
      expect(find.text('۱ کلاس از این مورد استفاده می‌کند'), findsWidgets);
      await reveal(tester, 'cls-subject-41');
      expect(find.text('۱ زنگ در برنامه'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await bootSchool(tester, role: 'teacher', seed: seed);
      expect(navOf('classes'), findsNothing);
    },
  );

  testWidgets(
    'W8-W02 a school without field classes: «+ کلاس جدید» creates a class offline',
    (tester) async {
      final src = MemorySchool();
      final s = await openClasses(
        tester,
        source: src,
        extra: (s) async {
          await s.put('classes', 5, {
            'name': 'دهم الکترونیک',
            'grade': 'دهم',
            'mode': 'class',
            'kind': 'class',
          });
        },
      );
      await tapKey(tester, 'cls-class-add');
      await choose(tester, 'cf-f-grade', 'هفتم');
      await typeKey(tester, 'cf-f-name', 'هفتم ب');
      await tapKey(tester, 'cf-save');
      expect(find.byKey(const Key('cf-save')), findsNothing, reason: 'closed');
      expect(textOf(tester, 'cls-notice'), startsWith('کلاس ساخته شد'));
      expect(s.outbox.list().first.collection, 'classes');
    },
  );

  testWidgets('W8-W03 rooms: add, NEG duplicate name refused, edit', (
    tester,
  ) async {
    final s = await openClasses(tester);
    await tapKey(tester, 'cls-room-add');
    await typeKey(tester, 'room-f-name', 'كارگاه ۱');
    await tapKey(tester, 'room-save');
    expect(textOf(tester, 'room-form-error'), contains('قبلاً ثبت شده'));
    await typeKey(tester, 'room-f-name', 'کارگاه ۲');
    await tapKey(tester, 'room-save');
    expect(textOf(tester, 'cls-notice'), 'کلاس/کارگاه اضافه شد');
    await tapKey(tester, 'cls-room-edit-6');
    await typeKey(tester, 'room-f-name', 'کارگاه برق');
    await tapKey(tester, 'room-save');
    expect(find.text('کارگاه برق'), findsOneWidget);
    expect(s.outbox.list(), hasLength(2));
  });

  testWidgets('W8-W04 delete a room (web «حذف» = class-delete): NEG cancel keeps it; confirm '
      'removes it, queued', (tester) async {
    final s = await openClasses(tester);
    await tapKey(tester, 'cls-room-delete-6');
    await tapKey(tester, 'cls-confirm-cancel');
    expect(s.outbox.list(), isEmpty);
    expect(find.byKey(const Key('cls-room-6')), findsOneWidget);
    await tapKey(tester, 'cls-room-delete-6');
    await tapKey(tester, 'cls-confirm-ok');
    expect(find.byKey(const Key('cls-room-6')), findsNothing);
    expect(await tester.runAsync(() => s.engine.get('classes', 6)), isNull);
    expect(s.outbox.list().map((o) => o.type), ['del']);
  });

  testWidgets('W8-W05 NEG like the web page: no class list, no merge', (
    tester,
  ) async {
    await openClasses(tester);
    expect(find.textContaining('ادغام'), findsNothing);
    expect(find.text('هفتم الف'), findsNothing);
  });

  testWidgets(
    'W8-W06 definitions: add branch, NEG duplicate, unused delete with a simple confirm',
    (tester) async {
      final s = await openClasses(tester);
      await tapKey(tester, 'cls-def-add-branch');
      await typeKey(tester, 'def-f-name', 'الکترونیک');
      await tapKey(tester, 'def-save');
      expect(textOf(tester, 'def-form-error'), 'این مورد قبلاً ثبت شده است');
      await typeKey(tester, 'def-f-name', 'شبکه');
      await tapKey(tester, 'def-save');
      expect(textOf(tester, 'cls-notice'), 'رشته ثبت شد');
      await tapKey(tester, 'cls-def-delete-4');
      expect(find.textContaining('«مکانیک» از فهرست'), findsOneWidget);
      await tapKey(tester, 'def-confirm-ok');
      expect(find.byKey(const Key('cls-def-4')), findsNothing);
      expect(s.outbox.list().map((o) => o.type), ['put', 'del']);
    },
  );

  testWidgets('W8-W07 a grade in use: the three choices; NEG cancel; "only" keeps the classes; '
      '"cascade" sends students to follow-up', (tester) async {
    final s = await openClasses(tester);
    await tapKey(tester, 'cls-def-delete-3');
    expect(find.byKey(const Key('def-del-students')), findsOneWidget);
    await tapKey(tester, 'def-del-cancel');
    expect(s.outbox.list(), isEmpty);
    await tapKey(tester, 'cls-def-delete-3');
    await tapKey(tester, 'def-del-cascade');
    expect(await tester.runAsync(() => s.engine.get('classes', 7)), isNull);
    expect(find.byKey(const Key('cls-def-3')), findsNothing);
    final u = await tester.runAsync(() => s.engine.get('users', 23));
    expect(u!.data['class_id'], isNull);
    expect('${u.data['followup_reason']}', contains('هفتم'));
    // "only": the grade goes, its class stays
    await tapKey(tester, 'cls-def-delete-1');
    await tapKey(tester, 'def-del-only');
    expect(await tester.runAsync(() => s.engine.get('classes', 5)), isNotNull);
    expect(find.byKey(const Key('cls-def-1')), findsNothing);
  });

  testWidgets('W8-W08 a grade with its students: second confirmation (NEG cancel keeps all), then '
      'students, classes and the grade are gone', (tester) async {
    final s = await openClasses(tester);
    await tapKey(tester, 'cls-def-delete-3');
    await tapKey(tester, 'def-del-students');
    expect(find.textContaining('برگشت‌پذیر نیست'), findsOneWidget);
    await tapKey(tester, 'def-confirm-cancel');
    expect(s.outbox.list(), isEmpty);
    await tapKey(tester, 'cls-def-delete-3');
    await tapKey(tester, 'def-del-students');
    await tapKey(tester, 'def-confirm-ok');
    expect(await tester.runAsync(() => s.engine.get('users', 23)), isNull);
    expect(await tester.runAsync(() => s.engine.get('classes', 7)), isNull);
    expect(await tester.runAsync(() => s.engine.get('schedule', 900)), isNull);
    expect(textOf(tester, 'cls-notice'), '1 دانش‌آموز و 1 کلاس حذف شد');
  });

  testWidgets(
    'W8-W09 subjects: add workshop subject, edit, delete removes its slot',
    (tester) async {
      final s = await openClasses(tester);
      await tapKey(tester, 'cls-subject-add');
      await tapKey(tester, 'sub-save');
      expect(textOf(tester, 'sub-form-error'), 'نام درس را بنویسید');
      await typeKey(tester, 'sub-f-name', 'کارگاه برق');
      await tapKey(tester, 'sub-f-workshop');
      await tapKey(tester, 'sub-save');
      final id = s.outbox.list().single.id;
      await reveal(tester, 'cls-subject-$id');
      expect(textIn(tester, 'cls-subject-$id'), contains('کارگاه برق'));
      expect(textIn(tester, 'cls-subject-$id'), contains('کارگاهی'));
      await tapKey(tester, 'cls-subject-edit-41');
      await typeKey(tester, 'sub-f-name', 'ریاضی ۱');
      await tapKey(tester, 'sub-save');
      expect(find.text('ریاضی ۱'), findsOneWidget);
      await tapKey(tester, 'cls-subject-delete-41');
      expect(find.textContaining('1 زنگ برنامه'), findsOneWidget);
      await tapKey(tester, 'sub-confirm-ok');
      expect(
        await tester.runAsync(() => s.engine.get('schedule', 900)),
        isNull,
      );
      expect(await tester.runAsync(() => s.engine.get('subjects', 41)), isNull);
    },
  );

  testWidgets('W8-W10 NEG full queue: a multi-row delete is refused with the queue message and '
      'nothing changes', (tester) async {
    final src = MemorySchool(config: const OutboxConfig(capacity: 1));
    final s = await openClasses(tester, source: src);
    await tapKey(tester, 'cls-def-delete-3');
    await tapKey(tester, 'def-del-cascade');
    expect(textOf(tester, 'cls-error'), contains('صف ارسال پر است'));
    expect(s.outbox.list(), isEmpty);
    expect(await tester.runAsync(() => s.engine.get('classes', 7)), isNotNull);
    final u = await tester.runAsync(() => s.engine.get('users', 23));
    expect(u!.data['class_id'], 7);
  });
}
