// Row 170 — the «نبض» panel of the web client (option A) inside the installed app: sidebar on
// the right with the web order, «نبض امروز مدرسه» on the manager's home, pages inside the shell
// on a wide window, a drawer on a phone; NEG the other roles see neither the hero nor manager
// pages.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'reports_wave11_test.dart' show seed;
import 'nav_support.dart';
import 'school_support.dart';

Future<void> size(WidgetTester tester, double w, double h) async {
  tester.view.physicalSize = Size(w, h);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
}

Future<void> boot(WidgetTester tester, String role) => bootSchool(
  tester,
  role: role,
  seed: (s) async {
    await seed(s, teacher: role == 'teacher' ? 10 : 11);
    if (role != 'teacher') {
      await s.put('users', 10, {
        'name': role == 'student' ? 'نوید' : 'مدیر',
        'role': role,
        if (role == 'student') 'class_id': 5,
      });
    }
  },
).then((_) => settle(tester));

void main() {
  testWidgets(
    'S170-P01 wide window: the web sidebar on the right in the web order (row 172: exactly '
    '`navConfig`), hero on «داشبورد», pages inside the shell',
    (tester) async {
      await size(tester, 1366, 900);
      await boot(tester, 'manager');
      expect(find.byKey(const Key('pulse-shell')), findsOneWidget);
      final bar = find.byKey(const Key('pulse-sidebar'));
      expect(bar, findsOneWidget);
      expect(find.byKey(const Key('pulse-bottomnav')), findsNothing);
      // RTL: the sidebar is the right-hand column
      expect(tester.getTopLeft(bar).dx, greaterThan(1366 / 2));
      final order = [
        'nav-home',
        'nav-users',
        'nav-followup',
        'nav-classes',
        'nav-schedule',
        'nav-attendance-report',
        'nav-reports',
        'nav-health',
        'nav-network',
        'nav-cloud',
        'nav-system',
      ];
      final ys = [
        for (final k in order) tester.getTopLeft(find.byKey(Key(k))).dy,
      ];
      for (var i = 1; i < ys.length; i++) {
        expect(ys[i], greaterThan(ys[i - 1]), reason: '${order[i]} order');
      }
      expect(textOf(tester, 'pulse-school'), isNotEmpty);
      // row 180 design 2: the foot of the sidebar — avatar, name, role
      expect(textIn(tester, 'pulse-account'), 'مدیر مدیر');
      expect(find.byKey(const Key('pulse-nav-search')), findsOneWidget);
      // the web sidebar has no native sync light / session menu
      expect(find.byKey(const Key('session-menu')), findsNothing);
      // «حضور امروز» (design 2 ring card): 1 present of 3 students, 1 absent
      expect(find.byKey(const Key('pulse-hero')), findsOneWidget);
      expect(textOf(tester, 'pulse-title'), 'حضور امروز');
      expect(textOf(tester, 'pulse-of'), '۱ نفر از ۳ دانش‌آموز');
      expect(textIn(tester, 'pulse-a'), contains('غایب ۱'));
      expect(textIn(tester, 'pulse-a'), contains('حاضر ۱'));
      expect(textIn(tester, 'd2-ring-value'), contains('۳۳٪'));
      // the greeting follows the clock of the run (CI runs at any hour)
      expect(
        textOf(tester, 'web-title'),
        matches(RegExp('^(صبح|ظهر|عصر|شب) بخیر')),
      );
      expect(find.byKey(const Key('dash-week')), findsOneWidget);
      expect(find.byKey(const Key('dash-away')), findsOneWidget);
      // a page opens inside the shell: the sidebar stays, no back button
      await tester.tap(find.byKey(const Key('nav-users')));
      await settle(tester);
      expect(bar, findsOneWidget);
      expect(find.byKey(const Key('pulse-page-users')), findsOneWidget);
      expect(find.byKey(const Key('usr-back')), findsNothing);
      expect(find.byKey(const Key('pulse-hero')), findsNothing);
      await tester.tap(find.byKey(const Key('nav-home')));
      await settle(tester);
      expect(find.byKey(const Key('pulse-hero')), findsOneWidget);
    },
  );

  testWidgets('S170-P02 phone: the web `.bottomnav` (row 172) — same pages inside the shell, hero on the '
      'home, no drawer and no overflow at 400 px', (tester) async {
    await size(tester, 400, 860);
    await boot(tester, 'manager');
    expect(find.byKey(const Key('pulse-sidebar')), findsNothing);
    expect(find.byKey(const Key('pulse-drawer')), findsNothing);
    expect(find.byKey(const Key('pulse-bottomnav')), findsOneWidget);
    expect(find.byKey(const Key('pulse-hero')), findsOneWidget);
    expect(tester.takeException(), isNull, reason: 'no overflow at 400 px');
    await tester.tap(find.byKey(const Key('nav-users')));
    await settle(tester);
    expect(find.byKey(const Key('pulse-page-users')), findsOneWidget);
    expect(find.byKey(const Key('usr-back')), findsNothing);
    expect(tester.takeException(), isNull, reason: 'no overflow at 400 px');
    // row 180 design 2: four pages and «بیشتر»; the rest open from its sheet
    expect(find.byKey(const Key('nav-system')), findsNothing);
    await tester.tap(find.byKey(const Key('nav-more')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('pulse-more-sheet')), findsOneWidget);
    await tester.tap(find.byKey(const Key('nav-system')));
    await settle(tester);
    expect(find.byKey(const Key('pulse-page-system')), findsOneWidget);
    expect(tester.takeException(), isNull, reason: 'no overflow at 400 px');
  });

  testWidgets(
    'S170-P03 NEG a student: no hero, no manager pages in the sidebar',
    (tester) async {
      await size(tester, 1366, 900);
      await boot(tester, 'student');
      expect(find.byKey(const Key('pulse-hero')), findsNothing);
      expect(find.byKey(const Key('nav-users')), findsNothing);
      expect(find.byKey(const Key('nav-reports')), findsNothing);
      expect(find.byKey(const Key('nav-schedule')), findsOneWidget);
    },
  );
}
