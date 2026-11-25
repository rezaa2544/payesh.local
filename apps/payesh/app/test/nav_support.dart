// Row 172: the app shell is the web panel on every width — the pages of `navConfig(role)` in
// the sidebar (900px and up) or in the bottom bar (below, scrolls sideways). Tests open a page
// the way a user does: by its web route id (`nav-<route>`).
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

Finder navOf(String route) => find.byKey(Key('nav-$route'));

/// Opens the «بیشتر» sheet when [route] is folded into it (phone, design 2).
Future<void> revealNav(WidgetTester tester, String route) async {
  final more = find.byKey(const Key('nav-more'));
  if (navOf(route).evaluate().isEmpty && more.evaluate().isNotEmpty) {
    await tester.tap(more);
    await tester.pumpAndSettle();
  }
}

/// Taps the navigation entry of [route] (scrolling the bottom bar to it first).
Future<void> openPage(WidgetTester tester, String route) async {
  final f = navOf(route);
  // row 180 design 2: on a phone a role with more than five pages folds the rest under
  // «بیشتر» (`nav-more`), which opens them in a sheet
  await revealNav(tester, route);
  expect(f, findsOneWidget, reason: 'no «$route» in the navigation');
  await tester.ensureVisible(f);
  await tester.pumpAndSettle();
  await tester.tap(f);
  await settleAsync(tester);
}

/// Lets a page that loads from the (fake) server finish: real async gaps between frames.
Future<void> settleAsync(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
    await tester.pumpAndSettle();
  }
}

/// Every text inside a web-layout block, joined (chips and cells hold more than one Text).
String textIn(WidgetTester tester, String key) => tester
    .widgetList<Text>(
      find.descendant(
        of: find.byKey(Key(key)),
        matching: find.byType(Text),
        matchRoot: true,
      ),
    )
    .map((w) => w.data ?? w.textSpan?.toPlainText() ?? '')
    .join(' ');

/// A tall desktop window (sidebar layout) so a long web page keeps every card built and the
/// page's banner (at the top of its list) stays on screen.
void tallView(WidgetTester tester) {
  tester.view.physicalSize = const Size(4200, 24000);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}
