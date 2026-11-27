// Row 204 — the owner's points after 0.9.72: a branch opens a sorted list of its students with
// پایه filters (not a cloud of chips); a field school (هنرستان کاردانش، رشته‌محور) names no
// «کلاس» but its venues; every figure is counted by one rule («پایه دهم», «۱۰» and «دهم» are
// one grade; students no definition counts are «بدون پایه»), so the numbers agree everywhere.
// REAL shell, pages and controllers on in-memory SQLite.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/school/school_source.dart';

import 'nav_support.dart';
import 'school_support.dart';

Future<void> seed(MemorySchool s) async {
  await s.put('schools', 1, {'name': 'هنرستان کاردانش', 'level': 'متوسطه دوم'});
  await s.put('lookups', 1, {'kind': 'grade', 'name': 'دهم'});
  await s.put('lookups', 2, {'kind': 'grade', 'name': 'یازدهم'});
  await s.put('lookups', 10, {'kind': 'branch', 'name': 'الکتروتکنیک'});
  await s.put('lookups', 11, {'kind': 'branch', 'name': 'معماری'});
  await s.put('classes', 20, {
    'name': 'دهم الکتروتکنیک',
    'grade': 'دهم',
    'branch': 'الکتروتکنیک',
    'kind': 'group',
  });
  await s.put('classes', 30, {'name': 'کارگاه برق', 'kind': 'room'});
  await s.put('users', 10, {'name': 'مدیر', 'role': 'manager'});
  var id = 100;
  for (final (n, g, b, extra)
      in <(String, String, String, Map<String, Object?>)>[
        ('علی', 'دهم', 'الکتروتکنیک', {}),
        ('رضا', 'پایه دهم', 'الکتروتکنیک', {}),
        ('حسن', '۱۰', 'الکتروتکنیک', {}),
        ('مینا', '', '', {'class_id': 20}),
        ('سارا', 'یازدهم', 'الکتروتکنیک', {}),
        ('نرگس', 'یازدهم', 'معماری', {}),
        ('بی‌پایه', '', 'معماری', {}),
        ('رفته', 'دهم', 'الکتروتکنیک', {'active': false}),
      ]) {
    await s.put('users', id++, {
      'name': n,
      'role': 'student',
      'grade': g,
      'field': b,
      ...extra,
    });
  }
}

Future<MemorySchool> boot(WidgetTester tester, String page) async {
  tallView(tester);
  final (_, s) = await bootSchool(tester, role: 'manager', seed: seed);
  await openPage(tester, page);
  return s;
}

Finder inside(String key, String text) =>
    find.descendant(of: find.byKey(Key(key)), matching: find.text(text));

void main() {
  testWidgets(
    'R204-01 the figures: «پایه دهم», «۱۰», a class\'s grade all count in «دهم»; the inactive '
    'one does not; «بدون پایه» closes the sum; a field school\'s page names no «کلاس»',
    (tester) async {
      await boot(tester, 'classes');
      expect(textOf(tester, 'web-title'), 'پایه‌ها، رشته‌ها و محل برگزاری');
      // دهم: علی، رضا (پایه دهم)، حسن (۱۰)، مینا (its class) — not «رفته»
      expect(badgeOf(tester, 'cls-def-students-1'), '۴ دانش‌آموز');
      expect(badgeOf(tester, 'cls-def-students-2'), '۲ دانش‌آموز');
      expect(badgeOf(tester, 'cls-def-students-10'), '۵ دانش‌آموز');
      expect(badgeOf(tester, 'cls-def-students-11'), '۲ دانش‌آموز');
      // 4 + 2 + «بدون پایه» 1 = the 7 active students; the branches: 5 + 2
      expect(badgeOf(tester, 'cls-def-none-students-grade'), '۱ دانش‌آموز');
      expect(find.byKey(const Key('cls-def-none-branch')), findsNothing);
      expect(find.textContaining('کلاس از این مورد استفاده'), findsNothing);
      expect(navLabel(tester), 'پایه و رشته');
    },
  );

  testWidgets(
    'R204-02 a branch: a sorted table with پایه filters (one per grade, any spelling); '
    'the stats say «پایه», never «کلاس»; a student opens its edit form',
    (tester) async {
      await boot(tester, 'classes');
      await tester.tap(find.text('الکتروتکنیک').first);
      await settleAsync(tester);
      expect(find.byKey(const Key('def-detail')), findsOneWidget);
      expect(find.byKey(const Key('def-students-table')), findsOneWidget);
      expect(find.byKey(const Key('def-filter')), findsOneWidget);
      expect(find.text('پایه'), findsWidgets);
      expect(
        find.descendant(
          of: find.byKey(const Key('def-detail')),
          matching: find.text('کلاس'),
        ),
        findsNothing,
      );
      // «دهم» once (علی، رضا، حسن، مینا), «یازدهم» (سارا)
      expect(find.byKey(const Key('def-filter-L10')), findsOneWidget);
      expect(find.byKey(const Key('def-filter-L11')), findsOneWidget);
      expect(textIn(tester, 'def-filter-L10'), contains('۴'));
      for (final id in [100, 101, 102, 103, 104]) {
        expect(find.byKey(Key('def-stu-$id')), findsOneWidget);
      }
      expect(
        find.byKey(const Key('def-stu-107')),
        findsNothing,
        reason: 'inactive',
      );
      await tester.tap(find.byKey(const Key('def-filter-L11')));
      await settle(tester);
      expect(find.byKey(const Key('def-stu-104')), findsOneWidget);
      expect(find.byKey(const Key('def-stu-100')), findsNothing);
      // sorted by name
      await tester.tap(find.byKey(const Key('def-filter-all')));
      await settle(tester);
      final ys = [
        for (final id in [102, 101, 104, 100, 103])
          tester.getTopLeft(find.byKey(Key('def-stu-$id'))).dy,
      ];
      expect(ys, [...ys]..sort());
    },
  );

  testWidgets(
    'R204-03 «بدون پایه» lists the students no grade counts, to fix them in place',
    (tester) async {
      await boot(tester, 'classes');
      await tester.tap(find.byKey(const Key('cls-def-none-grade')));
      await settleAsync(tester);
      expect(find.byKey(const Key('def-students-table')), findsOneWidget);
      expect(find.byKey(const Key('def-stu-106')), findsOneWidget);
      expect(find.byKey(const Key('def-stu-100')), findsNothing);
    },
  );

  testWidgets(
    'R204-04 users: the grade filter has «دهم» once (not «پایه دهم» / «۱۰» too) and it '
    'takes every spelling; the home and the nav say «پایه و رشته»',
    (tester) async {
      await boot(tester, 'users');
      await tapKey(tester, 'usr-role-student');
      final items = [
        for (final e
            in find
                .descendant(
                  of: find.byKey(const Key('usr-grade-filter')),
                  matching: find.byType(
                    DropdownMenuItem<String>,
                    skipOffstage: false,
                  ),
                  skipOffstage: false,
                )
                .evaluate())
          (e.widget as DropdownMenuItem<String>).value,
      ];
      // «پایه دهم» and «۱۰» are not options of their own
      expect(items, ['', 'دهم', 'یازدهم', '-']);
      await tapKey(tester, 'usr-grade-filter');
      await tester.tap(find.text('دهم').last);
      await settleAsync(tester);
      for (final id in [100, 101, 102]) {
        expect(find.byKey(Key('usr-row-$id')), findsOneWidget);
      }
      expect(find.byKey(const Key('usr-row-104')), findsNothing);
      expect(schoolFieldBased.value, isTrue);
    },
  );
}

String navLabel(WidgetTester tester) => tester
    .widgetList<Text>(
      find.descendant(of: navOf('classes'), matching: find.byType(Text)),
    )
    .map((t) => t.data ?? '')
    .where((t) => t.isNotEmpty)
    .first;
