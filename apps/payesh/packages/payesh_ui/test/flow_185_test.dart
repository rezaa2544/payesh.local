// Row 185 — no empty stretches: a page's cards sit side by side in up to three columns, each
// under the shortest column, the first on the right (RTL); a wide block takes the whole line; a
// phone keeps one column. The owner: «پایه‌ها راست، رشته‌ها وسط، کلاس و محل برگزاری چپ … حذف
// فضاهای بیخود و اضافی در کل برنامه».
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_ui/payesh_ui.dart';

Widget _box(String k, double h) => SizedBox(
  key: Key(k),
  height: h,
  child: const ColoredBox(color: Colors.red),
);

Future<void> _pump(WidgetTester tester, double width, Widget child) async {
  tester.view.physicalSize = Size(width, 1200);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    Directionality(
      textDirection: TextDirection.rtl,
      child: Align(
        alignment: Alignment.topCenter,
        child: SingleChildScrollView(child: child),
      ),
    ),
  );
}

void main() {
  test('L185-U1 column count: phone 1, tablet 2, desktop 3 (never more)', () {
    expect(flowColumnsFor(360), 1);
    expect(flowColumnsFor(680), 1);
    expect(flowColumnsFor(800), 2);
    expect(flowColumnsFor(1080), 3);
    expect(flowColumnsFor(2400), 3);
  });

  testWidgets(
    'L185-U2 three cards on a wide page: one row, first on the right, last on the left',
    (tester) async {
      await _pump(
        tester,
        1080,
        FlowColumns(children: [_box('g', 100), _box('b', 140), _box('r', 80)]),
      );
      final g = tester.getRect(find.byKey(const Key('g')));
      final b = tester.getRect(find.byKey(const Key('b')));
      final r = tester.getRect(find.byKey(const Key('r')));
      expect(g.top, b.top);
      expect(b.top, r.top);
      expect(g.left, greaterThan(b.left), reason: 'پایه‌ها on the right');
      expect(b.left, greaterThan(r.left), reason: 'کلاس on the left');
      expect(g.width, closeTo((1080 - 24) / 3, 0.01));
    },
  );

  testWidgets('L185-U3 the next card goes under the shortest column', (
    tester,
  ) async {
    await _pump(
      tester,
      1080,
      FlowColumns(
        children: [
          _box('a', 300),
          _box('b', 100),
          _box('c', 200),
          _box('d', 50),
        ],
      ),
    );
    final b = tester.getRect(find.byKey(const Key('b')));
    final d = tester.getRect(find.byKey(const Key('d')));
    expect(d.left, b.left);
    expect(d.top, b.bottom);
  });

  testWidgets(
    'L185-U4 a FlowWide block takes the whole line; two cards share it in halves',
    (tester) async {
      await _pump(
        tester,
        1080,
        FlowColumns(
          children: [
            _box('a', 50),
            _box('b', 50),
            FlowWide(child: _box('w', 40)),
          ],
        ),
      );
      expect(tester.getSize(find.byKey(const Key('w'))).width, 1080);
      expect(
        tester.getSize(find.byKey(const Key('a'))).width,
        closeTo((1080 - 12) / 2, 0.01),
      );
      expect(
        tester.getRect(find.byKey(const Key('w'))).top,
        tester.getRect(find.byKey(const Key('a'))).bottom,
      );
    },
  );

  testWidgets('L185-U5 a phone keeps one stretched column (NEG: no squeeze)', (
    tester,
  ) async {
    await _pump(
      tester,
      390,
      FlowColumns(children: [_box('a', 50), _box('b', 50)]),
    );
    final a = tester.getRect(find.byKey(const Key('a')));
    final b = tester.getRect(find.byKey(const Key('b')));
    expect(a.width, 390);
    expect(b.top, a.bottom);
  });

  testWidgets(
    'L185-U6 SpacedWrap counts its gaps: a button row in a content-wide box stays on one line',
    (tester) async {
      Widget btn(String k) => SizedBox(key: Key(k), width: 60, height: 30);
      await _pump(
        tester,
        1000,
        Align(
          alignment: Alignment.topRight,
          child: IntrinsicWidth(
            child: SpacedWrap(
              spacing: 8,
              children: [btn('1'), btn('2'), btn('3')],
            ),
          ),
        ),
      );
      expect(
        tester.getRect(find.byKey(const Key('1'))).top,
        tester.getRect(find.byKey(const Key('3'))).top,
      );
      // NEG: Flutter's own Wrap breaks the same row onto two lines
      await _pump(
        tester,
        1000,
        Align(
          alignment: Alignment.topRight,
          child: IntrinsicWidth(
            child: Wrap(spacing: 8, children: [btn('1'), btn('2'), btn('3')]),
          ),
        ),
      );
      expect(
        tester.getRect(find.byKey(const Key('3'))).top,
        greaterThan(tester.getRect(find.byKey(const Key('1'))).top),
      );
    },
  );

  test('L185-U7 the search box is shorter: 240', () {
    expect(kFieldSearch, 240);
    expect(kFieldFilter, lessThan(kFieldText));
  });

  testWidgets(
    'L185-U8 TrailingRow: actions sit at their natural width next to the content; a narrow row wraps them (NEG: no overflow)',
    (tester) async {
      Widget btn(String k) => SizedBox(key: Key(k), width: 80, height: 30);
      Widget row() => TrailingRow(
        main: const SizedBox(key: Key('main'), height: 20),
        trailing: SpacedWrap(
          spacing: 4,
          runSpacing: 4,
          children: [btn('a'), btn('b'), btn('c')],
        ),
      );
      await _pump(tester, 900, SizedBox(width: 900, child: row()));
      // rtl: content on the right, the three actions in one line at the left
      expect(
        tester.getRect(find.byKey(const Key('a'))).top,
        tester.getRect(find.byKey(const Key('c'))).top,
      );
      expect(
        tester.getSize(find.byKey(const Key('main'))).width,
        900 - 8 - 248,
      );
      expect(tester.takeException(), isNull);
      // a 300 wide column: the actions wrap, the content keeps its 140
      await _pump(tester, 300, SizedBox(width: 300, child: row()));
      expect(tester.takeException(), isNull);
      expect(
        tester.getRect(find.byKey(const Key('c'))).top,
        greaterThan(tester.getRect(find.byKey(const Key('a'))).top),
      );
      expect(
        tester.getSize(find.byKey(const Key('main'))).width,
        greaterThanOrEqualTo(140),
      );
    },
  );
}
