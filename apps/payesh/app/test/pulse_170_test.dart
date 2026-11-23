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
      expect(textOf(tester, 'pulse-account'), 'مدیر · مدیر');
      // the web sidebar has no native sync light / session menu
      expect(find.byKey(const Key('session-menu')), findsNothing);
      // «نبض امروز مدرسه»: 1 present of 3 students, 1 absent
      expect(find.byKey(const Key('pulse-hero')), findsOneWidget);
      expect(textOf(tester, 'pulse-title'), 'نبض امروز مدرسه');
      expect(textOf(tester, 'pulse-present'), '۱');
      expect(textOf(tester, 'pulse-of'), 'از ۳ دانش‌آموز حاضر');
      expect(textIn(tester, 'pulse-a'), contains('غایب ۱'));
      expect(textOf(tester, 'pulse-ratio'), '۳۳٪');
      expect(textOf(tester, 'dash-present'), '۱ / ۲');
      expect(textOf(tester, 'dash-students'), '۳');
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

  testWidgets(
    'S170-P02 phone: the web `.bottomnav` (row 172) — same pages inside the shell, hero on the '
    'home, no drawer and no overflow at 400 px',
    (tester) async {
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
      // the far end of the bar scrolls into view
      await tester.ensureVisible(find.byKey(const Key('nav-system')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('nav-system')));
      await settle(tester);
      expect(find.byKey(const Key('pulse-page-system')), findsOneWidget);
      expect(tester.takeException(), isNull, reason: 'no overflow at 400 px');
    },
  );

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
