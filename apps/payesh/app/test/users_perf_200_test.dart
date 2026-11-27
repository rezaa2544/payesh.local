// Row 200: the users page of a real-size school stays quick
// (1177 users — 800 students, 300 parents, 77 staff) like the owner's «کاردانش آینده سازان».
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'nav_support.dart';
import 'school_support.dart';

const scale = 1177;
const grades = ['دهم', 'یازدهم', 'دوازدهم'];
const branches = ['گرافیک', 'تاسیسات', 'الکترونیک', 'نقشه کشی'];

final _t = Stopwatch()..start();
// ignore: avoid_print
void mark(String m) => print('P200 t=${_t.elapsedMilliseconds} ms $m');

Future<void> seedBig(MemorySchool s) async {
  mark('seed start');
  await s.put('users', 10, {
    'name': 'مدیر',
    'role': 'manager',
    'phone': '09120000010',
  });
  var cls = 100;
  for (final g in grades) {
    for (final b in branches) {
      await s.put('classes', cls++, {'name': '$g $b', 'grade': g, 'branch': b});
    }
  }
  for (final (i, g) in grades.indexed) {
    await s.put('lookups', 50 + i, {'kind': 'grade', 'name': g});
  }
  for (final (i, b) in branches.indexed) {
    await s.put('lookups', 60 + i, {'kind': 'branch', 'name': b});
  }
  for (var i = 0; i < scale * 800 ~/ 1177; i++) {
    await s.put('users', 1000 + i, {
      'name': 'دانش‌آموز شماره ${i + 1}',
      'role': 'student',
      'class_id': 100 + i % 12,
      'national_id': '00${(10000000 + i)}',
      'grade': grades[i % 3],
      'branch': branches[i % 4],
    });
  }
  mark('students seeded');
  for (var i = 0; i < scale * 300 ~/ 1177; i++) {
    await s.put('users', 3000 + i, {
      'name': 'ولی شماره ${i + 1}',
      'role': 'parent',
      'phone': '0912${(1000000 + i)}',
    });
    await s.put('parent_links', 5000 + i, {
      'parent_id': 3000 + i,
      'student_id': 1000 + i,
    });
  }
  for (var i = 0; i < scale * 76 ~/ 1177; i++) {
    await s.put('users', 4000 + i, {
      'name': 'دبیر شماره ${i + 1}',
      'role': 'teacher',
      'phone': '0935${(1000000 + i)}',
    });
  }
  mark('all users seeded');
  for (var i = 0; i < 75; i++) {
    await s.put('import_issues', 7000 + i, {
      'name': 'ردیف $i',
      'national_id': '99${(10000000 + i)}',
      'reasons': ['کلاس درست نیست'],
      'status': 'open',
    });
  }
}

void main() {
  Future<MemorySchool> open(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1568, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final (_, s) = await bootSchool(tester, role: 'manager', seed: seedBig);
    final sw = Stopwatch()..start();
    await openPage(tester, 'users');
    mark('users page open: ${sw.elapsedMilliseconds} ms');
    return s;
  }

  Future<void> page(WidgetTester tester, String key) async {
    final f = find.byKey(Key(key));
    await tester.ensureVisible(f);
    await tester.pump();
    await tester.tap(f);
    await tester.pump();
    await tester.pump();
  }

  int rows() => find
      .byWidgetPredicate(
        (w) =>
            w.key is ValueKey<String> &&
            (w.key! as ValueKey<String>).value.startsWith('usr-row-'),
      )
      .evaluate()
      .length;

  testWidgets(
    'P200-01 a 1177-user school: 50 rows a page, the pager walks them',
    (tester) async {
      await open(tester);
      expect(textIn(tester, 'usr-count'), contains('۱۱۷۷ کاربر'));
      expect(rows(), 50, reason: 'NEG: not every user is drawn at once');
      expect(textIn(tester, 'usr-page-info'), '۱ تا ۵۰ از ۱۱۷۷');
      final sw = Stopwatch()..start();
      await page(tester, 'usr-page-next');
      mark('next page: ${sw.elapsedMilliseconds} ms');
      expect(textIn(tester, 'usr-page-info'), '۵۱ تا ۱۰۰ از ۱۱۷۷');
      expect(rows(), 50);
      for (var i = 0; i < 30; i++) {
        await page(tester, 'usr-page-next');
      }
      expect(textIn(tester, 'usr-page-info'), '۱۱۵۱ تا ۱۱۷۷ از ۱۱۷۷');
      expect(rows(), 27);
      await page(tester, 'usr-page-prev');
      expect(textIn(tester, 'usr-page-info'), '۱۱۰۱ تا ۱۱۵۰ از ۱۱۷۷');
      // the new page opens at the top of the table
      final top = tester.getTopLeft(find.byKey(const Key('usr-table'))).dy;
      expect(top, inInclusiveRange(-20, 900));
      tester
          .state<ScrollableState>(
            find
                .ancestor(
                  of: find.byKey(const Key('usr-table')),
                  matching: find.byType(Scrollable),
                )
                .first,
          )
          .position
          .jumpTo(0);
      await tester.pump();
      // a filter starts again from the first page
      await tester.tap(find.byKey(const Key('usr-role-teacher')));
      await settleAsync(tester);
      expect(rows(), 50);
      expect(textIn(tester, 'usr-page-info'), '۱ تا ۵۰ از ۷۶');
      expect(find.byKey(const Key('usr-row-4000')), findsOneWidget);
    },
  );

  testWidgets('P200-02 search waits for the typing to stop, then reads once', (
    tester,
  ) async {
    await open(tester);
    await tester.enterText(find.byKey(const Key('usr-search')), 'دبیر شماره 7');
    await tester.pump(const Duration(milliseconds: 100));
    expect(
      textIn(tester, 'usr-page-info'),
      '۱ تا ۵۰ از ۱۱۷۷',
      reason: 'NEG: not read again on every letter',
    );
    final sw = Stopwatch()..start();
    await tester.pump(const Duration(milliseconds: 300));
    await settleAsync(tester);
    mark('search: ${sw.elapsedMilliseconds} ms');
    // «دبیر شماره 7», 70…76 — one page, no pager
    expect(rows(), 8);
    expect(find.byKey(const Key('usr-pager')), findsNothing);
    expect(find.byKey(const Key('usr-row-4006')), findsOneWidget);
  });

  testWidgets(
    'P200-03 pick-all picks every filtered user; one tick redraws one page',
    (tester) async {
      await open(tester);
      var sw = Stopwatch()..start();
      await tester.tap(find.byKey(const Key('usr-pick-1000')));
      await tester.pump();
      mark('one checkbox: ${sw.elapsedMilliseconds} ms');
      expect(textIn(tester, 'usr-picked-bar'), contains('۱ کاربر انتخاب شده'));
      sw = Stopwatch()..start();
      await tester.tap(find.byKey(const Key('usr-pick-all')));
      await tester.pump();
      mark('pick all: ${sw.elapsedMilliseconds} ms');
      expect(
        textIn(tester, 'usr-picked-bar'),
        contains('۱۱۷۷ کاربر انتخاب شده'),
      );
      expect(rows(), 50);
    },
  );

  testWidgets(
    'P200-04 synced changes fold into one quiet reload; the follow-up count holds',
    (tester) async {
      final s = await open(tester);
      expect(textIn(tester, 'usr-followup'), contains('۷۵ مورد'));
      await tester.runAsync(() async {
        await s.put('users', 4999, {'name': 'آ تازه', 'role': 'teacher'});
        for (var i = 0; i < 20; i++) {
          s.bump.value++;
        }
      });
      await settleAsync(tester);
      expect(textIn(tester, 'usr-count'), contains('۱۱۷۸ کاربر'));
      expect(find.byKey(const Key('usr-row-4999')), findsOneWidget);
      expect(find.byKey(const Key('usr-loading')), findsNothing);
    },
  );

  testWidgets(
    'P200-05 the parents\' «ولیِ چه دانش‌آموزی» column still names each child',
    (tester) async {
      await open(tester);
      await tester.tap(find.byKey(const Key('usr-role-parent')));
      await settleAsync(tester);
      expect(textIn(tester, 'usr-page-info'), '۱ تا ۵۰ از ۳۰۰');
      // ولی شماره 1 → دانش‌آموز شماره 1 (students are not listed: only the children column)
      expect(find.text('دانش‌آموز شماره 1'), findsOneWidget);
    },
  );
}
