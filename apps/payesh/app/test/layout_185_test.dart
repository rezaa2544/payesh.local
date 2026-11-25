// Row 185 — no empty stretches in the school app: «پایه‌ها»، «رشته‌ها» and «کلاس‌ها و محل
// برگزاری» are three columns side by side (right → left), cards of every page flow in columns, a
// table is only as wide as its columns, the search box is short, and «دانش‌آموز» on «کاربران»
// can be split by پایه and رشته. A phone keeps one column.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'nav_support.dart';
import 'school_support.dart';

Future<void> seed185(MemorySchool s) async {
  await s.put('users', 10, {'name': 'مدیر', 'role': 'manager'});
  await s.put('lookups', 1, {'kind': 'grade', 'name': 'دهم'});
  await s.put('lookups', 2, {'kind': 'grade', 'name': 'یازدهم'});
  await s.put('lookups', 3, {'kind': 'branch', 'name': 'شبکه'});
  await s.put('lookups', 4, {'kind': 'branch', 'name': 'برق'});
  await s.put('classes', 5, {
    'name': 'دهم شبکه',
    'grade': 'دهم',
    'branch': 'شبکه',
    'mode': 'field',
    'kind': 'class',
  });
  await s.put('classes', 6, {'name': 'کارگاه ۱', 'kind': 'room'});
  await s.put('subjects', 41, {'name': 'ریاضی'});
  await s.put('users', 21, {'name': 'بهار', 'role': 'student', 'class_id': 5});
  await s.put('users', 22, {
    'name': 'آرش',
    'role': 'student',
    'grade': 'یازدهم',
    'field': 'برق',
  });
  await s.put('users', 23, {'name': 'نیما', 'role': 'student'});
}

Future<void> _boot(WidgetTester tester, Size size) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await bootSchool(tester, role: 'manager', seed: seed185);
}

Rect _r(WidgetTester tester, String key) =>
    tester.getRect(find.byKey(Key(key)));

Future<void> _pick(WidgetTester tester, String key, String item) async {
  await tester.tap(find.byKey(Key(key)));
  await tester.pumpAndSettle();
  await tester.tap(find.text(item).last);
  await settleAsync(tester);
}

void main() {
  testWidgets(
    'L185-01 «کلاس‌ها» on a Windows window: پایه‌ها right, رشته‌ها middle, کلاس/محل left, one row',
    (tester) async {
      await _boot(tester, const Size(1568, 900));
      await openPage(tester, 'classes');
      final g = _r(tester, 'cls-defs-grade');
      final b = _r(tester, 'cls-defs-branch');
      final r = _r(tester, 'cls-rooms');
      expect(g.top, b.top);
      expect(b.top, r.top);
      expect(g.left, greaterThan(b.left));
      expect(b.left, greaterThan(r.left));
      expect(g.width, lessThan(1568 / 3), reason: 'NEG: no full-width card');
      // a row is as wide as its column: «دهم» and its buttons are close together
      final item = _r(tester, 'cls-def-1');
      expect(item.width, lessThanOrEqualTo(g.width));
      expect(item.width, lessThan(480));
    },
  );

  testWidgets('L185-02 «کلاس‌ها» on a phone: one column, cards stacked', (
    tester,
  ) async {
    await _boot(tester, const Size(400, 860));
    await openPage(tester, 'classes');
    final g = _r(tester, 'cls-defs-grade');
    final b = _r(tester, 'cls-defs-branch');
    expect(g.left, b.left);
    expect(b.top, greaterThan(g.bottom - 1));
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'L185-03 «کاربران» → «دانش‌آموز»: split by پایه and رشته (all · one · none set)',
    (tester) async {
      await _boot(tester, const Size(1568, 900));
      await openPage(tester, 'users');
      expect(find.byKey(const Key('usr-grade-filter')), findsNothing);
      await tester.tap(find.byKey(const Key('usr-role-student')));
      await settleAsync(tester);
      expect(find.byKey(const Key('usr-grade-filter')), findsOneWidget);
      expect(find.byKey(const Key('usr-branch-filter')), findsOneWidget);
      for (final id in [21, 22, 23]) {
        expect(find.byKey(Key('usr-row-$id')), findsOneWidget);
      }
      await _pick(tester, 'usr-grade-filter', 'دهم');
      expect(find.byKey(const Key('usr-row-21')), findsOneWidget);
      expect(find.byKey(const Key('usr-row-22')), findsNothing);
      expect(find.byKey(const Key('usr-row-23')), findsNothing);
      await _pick(tester, 'usr-grade-filter', 'همهٔ پایه‌ها');
      await _pick(tester, 'usr-branch-filter', 'برق');
      expect(find.byKey(const Key('usr-row-22')), findsOneWidget);
      expect(find.byKey(const Key('usr-row-21')), findsNothing);
      await _pick(tester, 'usr-branch-filter', 'بدون رشته');
      expect(find.byKey(const Key('usr-row-23')), findsOneWidget);
      expect(find.byKey(const Key('usr-row-22')), findsNothing);
      // another role clears the student filters
      await tester.tap(find.byKey(const Key('usr-role-all')));
      await settleAsync(tester);
      expect(find.byKey(const Key('usr-grade-filter')), findsNothing);
      expect(find.byKey(const Key('usr-row-22')), findsOneWidget);
    },
  );

  testWidgets(
    'L185-04 «کاربران»: the search box is short (240) and the table only as wide as its columns',
    (tester) async {
      await _boot(tester, const Size(1568, 900));
      await openPage(tester, 'users');
      expect(tester.getSize(find.byKey(const Key('usr-search'))).width, 240);
      final card = _r(tester, 'usr-table');
      final table = tester.getRect(
        find.descendant(
          of: find.byKey(const Key('usr-table')),
          matching: find.byType(Table),
        ),
      );
      expect(
        table.width,
        lessThan(card.width - 100),
        reason: 'NEG: no stretch',
      );
      expect(
        table.right,
        closeTo(card.right, 40),
        reason: 'starts on the right',
      );
      // the actions of a row stay on one line
      final full = _r(tester, 'usr-full-21');
      final edit = _r(tester, 'usr-edit-21');
      expect(full.top, edit.top);
    },
  );
}
