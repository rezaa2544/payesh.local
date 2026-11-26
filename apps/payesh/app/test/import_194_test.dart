// Row 194 — the import wizard copied from p2 (34-excel-import.js): the steps joined by arrows
// turn green when done; the پایه list is the manager's own; «انتخاب فایل» goes through the
// system dialog; automatic placement into the least-filled section, «نیازمند بررسی دستی» when
// every section is full, an explicit capacity raise, and the saved placement rules. REAL shell,
// controllers and SchoolImport on in-memory SQLite + outbox.
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/followup/followup_screen.dart';
import 'package:payesh_app/src/platform/file_pick.dart';
import 'package:payesh_app/src/pulse/web.dart';

import 'nav_support.dart';
import 'school_support.dart';

Future<void> seed(MemorySchool s) async {
  await s.put('schools', 1, {'name': 'هنرستان', 'gender': 'مختلط'});
  await s.put('lookups', 1, {'kind': 'grade', 'name': 'دهم', 'order': 1});
  await s.put('lookups', 2, {'kind': 'grade', 'name': 'یازدهم', 'order': 2});
  await s.put('lookups', 3, {'kind': 'branch', 'name': 'الکترونیک'});
  // two sections of «دهم الکترونیک»: ۱ has 1 student (cap 2), ۲ has none (cap 1)
  await s.put('classes', 5, {
    'name': 'دهم الکترونیک ۱',
    'grade': 'دهم',
    'branch': 'الکترونیک',
    'kind': 'class',
    'capacity': 2,
  });
  await s.put('classes', 6, {
    'name': 'دهم الکترونیک ۲',
    'grade': 'دهم',
    'branch': 'الکترونیک',
    'kind': 'class',
    'capacity': 1,
  });
  await s.put('users', 10, {'name': 'مدیر', 'role': 'manager'});
  await s.put('users', 22, {'name': 'کامل', 'role': 'student', 'class_id': 5});
}

Future<MemorySchool> openImport(WidgetTester tester) async {
  tallView(tester);
  final (_, s) = await bootSchool(tester, role: 'manager', seed: seed);
  await openPage(tester, 'followup');
  await tapKey(tester, 'fu-import');
  return s;
}

void usePick(String csv) {
  final saved = ImportController.pickFile;
  addTearDown(() => ImportController.pickFile = saved);
  ImportController.pickFile = () async =>
      PickedFile('class10.csv', Uint8List.fromList(utf8.encode(csv)));
}

Future<void> top(WidgetTester tester) async {
  await tester.drag(find.byType(ListView).last, const Offset(0, 6000));
  await settle(tester);
}

/// The number of a stat card / table cell, wherever the page is scrolled.
Future<String> numOf(WidgetTester tester, String key) async {
  await top(tester);
  await reveal(tester, key);
  return textOf(tester, key);
}

const csv4 =
    'نام و نام خانوادگی,کد ملی,پایه,رشته\n'
    'سینا کاظمی,0012345678,دهم,الکترونیک\n'
    'سارا نوری,0023456789,دهم,الکترونیک\n'
    'آرمان یزدی,0034567891,دهم,الکترونیک\n';

void main() {
  testWidgets('I194-01 the پایه list is the manager\'s (not 1–12); the steps are joined by '
      'arrows and only a finished step is green', (tester) async {
    usePick(csv4);
    await openImport(tester);
    expect(find.byKey(const Key('imp-grade-دهم')), findsOneWidget);
    expect(find.byKey(const Key('imp-grade-یازدهم')), findsOneWidget);
    for (final g in ['اول', 'ششم', 'دوازدهم', 'هفتم']) {
      expect(find.byKey(Key('imp-grade-$g')), findsNothing);
    }
    for (var i = 1; i <= 3; i++) {
      expect(find.byKey(Key('imp-arrow-$i')), findsOneWidget);
    }
    expect(find.byKey(const Key('imp-step-1-done')), findsNothing);
    await tapKey(tester, 'imp-grade-دهم');
    await tapKey(tester, 'imp-pick');
    expect(find.byKey(const Key('imp-step-1-done')), findsOneWidget);
    expect(find.byKey(const Key('imp-step-2-done')), findsNothing);
    final arrow = tester.widget<Icon>(find.byKey(const Key('imp-arrow-1')));
    expect(arrow.color, Web.green);
    final next = tester.widget<Icon>(find.byKey(const Key('imp-arrow-2')));
    expect(next.color, isNot(Web.green));
  });

  testWidgets('I194-02 automatic placement fills the least-filled section with room; when '
      'every section is full the row waits for a manual decision; an explicit capacity raise '
      'places it', (tester) async {
    usePick(csv4);
    final s = await openImport(tester);
    await tapKey(tester, 'imp-grade-دهم');
    await tapKey(tester, 'imp-pick');
    await tapKey(tester, 'imp-check');
    // 5: 1/2, 6: 0/1 → سینا→6 (0), سارا→5 (1), آرمان: both full → manual
    expect(await numOf(tester, 'imp-stat-auto'), '۲');
    expect(await numOf(tester, 'imp-stat-manual'), '۱');
    await reveal(tester, 'imp-manual');
    expect(find.byKey(const Key('imp-manual')), findsOneWidget);
    expect(await numOf(tester, 'imp-cap-after-5'), '۲');
    expect(await numOf(tester, 'imp-cap-after-6'), '۱');
    expect(find.byKey(const Key('imp-cap-over')), findsNothing);
    // NEG: a capacity below the current one is refused
    await typeKey(tester, 'imp-cap-in-6', '0');
    await tapKey(tester, 'imp-cap-save-6');
    expect(textOf(tester, 'imp-error'), 'ظرفیت معتبر وارد کنید');
    await typeKey(tester, 'imp-cap-in-6', '3');
    await tapKey(tester, 'imp-cap-save-6');
    expect(find.byKey(const Key('imp-manual')), findsNothing);
    expect(await numOf(tester, 'imp-stat-auto'), '۳');
    expect(await numOf(tester, 'imp-stat-ready'), '۳');
    await tapKey(tester, 'imp-apply');
    final ops = s.outbox.list();
    expect(
      ops.any((o) => o.collection == 'classes' && o.payload!['capacity'] == 3),
      isTrue,
    );
    int? cls(String name) =>
        ops.firstWhere((o) => o.payload?['name'] == name).payload!['class_id']
            as int?;
    expect(cls('سینا کاظمی'), 6);
    expect(cls('سارا نوری'), 5);
    expect(cls('آرمان یزدی'), 6);
    expect(find.byKey(const Key('imp-step-4-done')), findsOneWidget);
    expect(await numOf(tester, 'imp-done-created'), '۳');
  });

  testWidgets(
    'I194-03 «⚙️ قواعد کلاس‌بندی خودکار»: saved on the school; with «توزیع '
    'خودکار» off nobody is placed by the system',
    (tester) async {
      usePick(csv4);
      final s = await openImport(tester);
      await reveal(tester, 'imp-pr-sib');
      expect(
        tester.widget<Checkbox>(find.byKey(const Key('imp-pr-auto'))).value,
        isTrue,
      );
      expect(
        tester.widget<Checkbox>(find.byKey(const Key('imp-pr-gender'))).value,
        isFalse,
      );
      await tapKey(tester, 'imp-pr-auto');
      await tapKey(tester, 'imp-pr-sib');
      await tapKey(tester, 'imp-rules-save');
      final saved = s.outbox.list().singleWhere(
        (o) => o.collection == 'schools',
      );
      expect(saved.payload!['place_rules'], {
        'autoDistribute': false,
        'separateGender': false,
        'keepSiblings': true,
      });
      expect(saved.payload!['name'], 'هنرستان', reason: 'nothing else lost');
      await top(tester);
      await tapKey(tester, 'imp-grade-دهم');
      await tapKey(tester, 'imp-pick');
      await tapKey(tester, 'imp-check');
      await top(tester);
      expect(find.byKey(const Key('imp-stat-total')), findsOneWidget);
      expect(find.byKey(const Key('imp-stat-auto')), findsNothing);
      expect(find.byKey(const Key('imp-manual')), findsNothing);
    },
  );

  testWidgets(
    'I194-04 NEG no پایه defined: the wizard says so and «انتخاب فایل» stays off',
    (tester) async {
      tallView(tester);
      await bootSchool(
        tester,
        role: 'manager',
        seed: (s) async {
          await s.put('users', 10, {'name': 'مدیر', 'role': 'manager'});
        },
      );
      await openPage(tester, 'followup');
      await tapKey(tester, 'fu-import');
      expect(find.byKey(const Key('imp-grade-none')), findsOneWidget);
      expect(
        tester.widget<WebBtn>(find.byKey(const Key('imp-pick'))).onPressed,
        isNull,
      );
    },
  );
}
