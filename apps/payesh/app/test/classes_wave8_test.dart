// Row 128, wave W8 — classes, rooms, grade/branch definitions and subjects. Widget tests drive the
// REAL app shell, pages, controllers and ClassBook on an in-memory SQLite + durable outbox; the
// real server path is packages/payesh_sync/test/school_admin_it_test.dart W8-IT-*.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_sync/payesh_sync.dart';

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
}) async {
  final (_, s) = await bootSchool(
    tester,
    role: 'manager',
    seed: seed,
    source: source,
  );
  await tapKey(tester, 'adm-classes');
  return s;
}

Future<void> pickMenu(WidgetTester tester, String menu, String item) async {
  await tapKey(tester, menu);
  await tapKey(tester, item);
}

Future<void> choose(WidgetTester tester, String dropdown, String text) async {
  await tapKey(tester, dropdown);
  await tester.tap(find.text(text).last);
  await settle(tester);
}

void main() {
  testWidgets('W8-W01 the page lists rooms, classes, grades, branches and subjects with usage; '
      'NEG not on a teacher\'s home', (tester) async {
    await openClasses(tester);
    expect(find.byKey(const Key('cls-room-6')), findsOneWidget);
    expect(find.byKey(const Key('cls-class-5')), findsOneWidget);
    expect(find.text('رشته‌محور · 1 دانش‌آموز'), findsOneWidget);
    await reveal(tester, 'cls-def-1');
    expect(find.text('1 کلاس از این مورد استفاده می‌کند'), findsWidgets);
    await reveal(tester, 'cls-subject-41');
    expect(find.text('1 زنگ در برنامه'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await bootSchool(tester, role: 'teacher', seed: seed);
    expect(find.byKey(const Key('adm-classes')), findsNothing);
  });

  testWidgets('W8-W02 new field class: NEG without a branch refused (form stays), then created '
      'offline and the waiting student joins it', (tester) async {
    final s = await openClasses(tester);
    await tapKey(tester, 'cls-class-add');
    await choose(tester, 'cf-f-grade', 'دهم');
    await tapKey(tester, 'cf-save');
    expect(textOf(tester, 'cf-form-error'), contains('رشته'));
    expect(s.outbox.list(), isEmpty);
    await choose(tester, 'cf-f-branch', 'الکترونیک');
    await typeKey(tester, 'cf-f-name', 'دهم الکترونیک ۲');
    await tapKey(tester, 'cf-save');
    expect(find.byKey(const Key('cf-save')), findsNothing, reason: 'closed');
    expect(
      textOf(tester, 'cls-notice'),
      'کلاس ساخته شد · 1 دانش‌آموز به آن وصل شد',
    );
    final ops = s.outbox.list();
    expect(ops.map((o) => o.collection), ['classes', 'users']);
    expect(ops.last.payload!['class_id'], ops.first.id);
    expect(find.text('در صف ارسال'), findsWidgets);
  });

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
    await pickMenu(tester, 'cls-room-menu-6', 'cls-room-edit-6');
    await typeKey(tester, 'room-f-name', 'کارگاه برق');
    await tapKey(tester, 'room-save');
    expect(find.text('کارگاه برق'), findsOneWidget);
    expect(s.outbox.list(), hasLength(2));
  });

  testWidgets('W8-W04 delete class: NEG cancel keeps it; confirm → students stay without a class '
      '(follow-up reason), queued', (tester) async {
    final s = await openClasses(tester);
    await pickMenu(tester, 'cls-class-menu-5', 'cls-class-delete-5');
    expect(
      find.textContaining('1 دانش‌آموز بدون کلاس می‌شوند'),
      findsOneWidget,
    );
    await tapKey(tester, 'cls-confirm-cancel');
    expect(s.outbox.list(), isEmpty);
    await pickMenu(tester, 'cls-class-menu-5', 'cls-class-delete-5');
    await tapKey(tester, 'cls-confirm-ok');
    expect(find.byKey(const Key('cls-class-5')), findsNothing);
    final u = await tester.runAsync(() => s.engine.get('users', 21));
    expect(u!.data['class_id'], isNull);
    expect('${u.data['followup_reason']}', contains('دهم الکترونیک'));
    expect(s.outbox.list().map((o) => o.type), ['put', 'del']);
  });

  testWidgets(
    'W8-W05 merge: pick the target, confirm → students and schedule move, source gone',
    (tester) async {
      final s = await openClasses(tester);
      await pickMenu(tester, 'cls-class-menu-7', 'cls-class-merge-7');
      await tapKey(tester, 'cls-merge-to-5');
      await tapKey(tester, 'cls-confirm-ok');
      expect(find.byKey(const Key('cls-class-7')), findsNothing);
      expect(
        textOf(tester, 'cls-notice'),
        'کلاس ادغام شد · 1 دانش‌آموز منتقل شد',
      );
      final u = await tester.runAsync(() => s.engine.get('users', 23));
      expect(u!.data['class_id'], 5);
      final sg = await tester.runAsync(() => s.engine.get('schedule', 900));
      expect(sg!.data['class_id'], 5);
    },
  );

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
      await pickMenu(tester, 'cls-def-menu-4', 'cls-def-delete-4');
      expect(find.textContaining('«مکانیک» از فهرست'), findsOneWidget);
      await tapKey(tester, 'def-confirm-ok');
      expect(find.byKey(const Key('cls-def-4')), findsNothing);
      expect(s.outbox.list().map((o) => o.type), ['put', 'del']);
    },
  );

  testWidgets('W8-W07 a grade in use: the three choices; NEG cancel; "only" keeps the classes; '
      '"cascade" sends students to follow-up', (tester) async {
    final s = await openClasses(tester);
    await pickMenu(tester, 'cls-def-menu-3', 'cls-def-delete-3');
    expect(find.byKey(const Key('def-del-students')), findsOneWidget);
    await tapKey(tester, 'def-del-cancel');
    expect(s.outbox.list(), isEmpty);
    await pickMenu(tester, 'cls-def-menu-3', 'cls-def-delete-3');
    await tapKey(tester, 'def-del-cascade');
    expect(find.byKey(const Key('cls-class-7')), findsNothing);
    expect(find.byKey(const Key('cls-def-3')), findsNothing);
    final u = await tester.runAsync(() => s.engine.get('users', 23));
    expect(u!.data['class_id'], isNull);
    expect('${u.data['followup_reason']}', contains('هفتم'));
    // "only": the grade goes, its class stays
    await pickMenu(tester, 'cls-def-menu-1', 'cls-def-delete-1');
    await tapKey(tester, 'def-del-only');
    expect(find.byKey(const Key('cls-class-5')), findsOneWidget);
    expect(find.byKey(const Key('cls-def-1')), findsNothing);
  });

  testWidgets('W8-W08 a grade with its students: second confirmation (NEG cancel keeps all), then '
      'students, classes and the grade are gone', (tester) async {
    final s = await openClasses(tester);
    await pickMenu(tester, 'cls-def-menu-3', 'cls-def-delete-3');
    await tapKey(tester, 'def-del-students');
    expect(find.textContaining('برگشت‌پذیر نیست'), findsOneWidget);
    await tapKey(tester, 'def-confirm-cancel');
    expect(s.outbox.list(), isEmpty);
    await pickMenu(tester, 'cls-def-menu-3', 'cls-def-delete-3');
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
      await reveal(tester, 'cls-subject-${s.outbox.list().single.id}');
      expect(find.text('کارگاه برق · کارگاهی'), findsOneWidget);
      await pickMenu(tester, 'cls-subject-menu-41', 'cls-subject-edit-41');
      await typeKey(tester, 'sub-f-name', 'ریاضی ۱');
      await tapKey(tester, 'sub-save');
      expect(find.text('ریاضی ۱'), findsOneWidget);
      await pickMenu(tester, 'cls-subject-menu-41', 'cls-subject-delete-41');
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
    await pickMenu(tester, 'cls-class-menu-5', 'cls-class-delete-5');
    await tapKey(tester, 'cls-confirm-ok');
    expect(textOf(tester, 'cls-error'), contains('صف ارسال پر است'));
    expect(s.outbox.list(), isEmpty);
    expect(find.byKey(const Key('cls-class-5')), findsOneWidget);
    final u = await tester.runAsync(() => s.engine.get('users', 21));
    expect(u!.data['class_id'], 5);
  });
}
