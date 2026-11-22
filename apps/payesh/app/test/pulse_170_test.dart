// Row 170 — the «نبض» panel of the web client (option A) inside the installed app: sidebar on
// the right with the web order, «نبض امروز مدرسه» on the manager's home, pages inside the shell
// on a wide window, a drawer on a phone; NEG the other roles see neither the hero nor manager
// pages.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'reports_wave11_test.dart' show seed;
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
    'S170-P01 wide window: «نبض» sidebar on the right in the web order, hero, pages inside the shell',
    (tester) async {
      await size(tester, 1366, 900);
      await boot(tester, 'manager');
      expect(find.byKey(const Key('pulse-shell')), findsOneWidget);
      final bar = find.byKey(const Key('pulse-sidebar'));
      expect(bar, findsOneWidget);
      // RTL: the sidebar is the right-hand column
      expect(tester.getTopLeft(bar).dx, greaterThan(1366 / 2));
      final order = [
        'nav-dashboard',
        'nav-today',
        'nav-users',
        'nav-followup',
        'nav-classes',
        'nav-schedule',
        'nav-reports',
        'nav-health',
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
      // «نبض امروز مدرسه»: 1 present of 3 students, 1 absent
      expect(find.byKey(const Key('pulse-hero')), findsOneWidget);
      expect(textOf(tester, 'pulse-title'), 'نبض امروز مدرسه');
      expect(textOf(tester, 'pulse-present'), '۱');
      expect(textOf(tester, 'pulse-of'), 'از ۳ دانش‌آموز حاضر');
      expect(textOf(tester, 'pulse-a'), 'غایب ۱');
      expect(textOf(tester, 'pulse-ratio'), '۳۳٪');
      expect(textOf(tester, 'dash-home-present'), '۱ / ۲');
      expect(textOf(tester, 'dash-home-students'), '۳');
      // a page opens inside the shell: the sidebar stays, no back button
      await tester.tap(find.byKey(const Key('nav-users')));
      await settle(tester);
      expect(bar, findsOneWidget);
      expect(find.byKey(const Key('pulse-page-users')), findsOneWidget);
      expect(find.byKey(const Key('usr-back')), findsNothing);
      expect(find.byKey(const Key('pulse-hero')), findsNothing);
      // the dashboard page itself has the hero and the stat cards
      await tester.tap(find.byKey(const Key('nav-today')));
      await settle(tester);
      expect(find.byKey(const Key('pulse-hero')), findsOneWidget);
      expect(textOf(tester, 'dash-present'), '۱ / ۲');
      expect(find.byKey(const Key('dash-stat-students')), findsOneWidget);
      await tester.tap(find.byKey(const Key('nav-dashboard')));
      await settle(tester);
      expect(find.byKey(const Key('session-header')), findsOneWidget);
      expect(find.byKey(const Key('session-menu')), findsOneWidget);
    },
  );

  testWidgets(
    'S170-P02 phone: same pages in a drawer (pushed with a back button), hero on the home',
    (tester) async {
      await size(tester, 400, 860);
      await boot(tester, 'manager');
      expect(find.byKey(const Key('pulse-sidebar')), findsNothing);
      expect(find.byKey(const Key('pulse-hero')), findsOneWidget);
      expect(tester.takeException(), isNull, reason: 'no overflow at 400 px');
      tester.state<ScaffoldState>(find.byType(Scaffold).first).openDrawer();
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('pulse-drawer')), findsOneWidget);
      expect(find.byKey(const Key('drawer-users')), findsOneWidget);
      await tester.tap(find.byKey(const Key('drawer-users')));
      await settle(tester);
      expect(find.byKey(const Key('pulse-drawer')), findsNothing);
      expect(find.byKey(const Key('usr-back')), findsOneWidget);
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
