// Row 190 — the owner: «تفکیک‌سازی بین بخش‌ها را بهتر انجام بده، کادرها را پررنگ‌تر کن؛
// گزینه‌های منوی همبرگری هم در سیستم و هم در گوشی پررنگ‌تر و برجسته‌تر باشند».
// Cards / sections carry the stronger frame (a step darker than the inner hairlines) and a faint
// lift on a faint grey page; menu items are 14px w600 ink with 19px ink icons; the chosen one is
// a framed pill with a violet bar, a violet icon and w800 text — on the Windows sidebar, the
// phone's bottom bar and its «بیشتر» sheet. NEG: the old hairline grey (#E4E4E7) and the w400
// ink2 items are gone.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/pulse/d2.dart';
import 'package:payesh_app/src/pulse/pulse.dart';
import 'package:payesh_app/src/pulse/web.dart';
import 'package:payesh_ui/payesh_ui.dart';

const _items = [
  PulseNavItem(id: 'today', label: 'داشبورد', icon: Icons.home, page: _blank),
  PulseNavItem(id: 'users', label: 'کاربران', icon: Icons.people, page: _blank),
  PulseNavItem(
    id: 'classes',
    label: 'کلاس‌ها',
    icon: Icons.class_,
    page: _blank,
  ),
  PulseNavItem(
    id: 'schedule',
    label: 'برنامه',
    icon: Icons.event,
    page: _blank,
  ),
  PulseNavItem(
    id: 'attendance',
    label: 'حضور',
    icon: Icons.check,
    page: _blank,
  ),
  PulseNavItem(
    id: 'reports',
    label: 'گزارش‌ها',
    icon: Icons.list,
    page: _blank,
  ),
  PulseNavItem(
    id: 'system',
    label: 'سیستم',
    icon: Icons.settings,
    page: _blank,
  ),
];

Widget _blank(BuildContext _) => const SizedBox();

Future<void> _pump(WidgetTester t, Widget child, Size size) async {
  t.view.physicalSize = size;
  t.view.devicePixelRatio = 1;
  addTearDown(t.view.reset);
  await t.pumpWidget(
    MaterialApp(
      theme: PayeshUi.light(look: PayeshLook.minimal),
      home: Directionality(
        textDirection: TextDirection.rtl,
        child: Scaffold(body: child),
      ),
    ),
  );
  await t.pumpAndSettle();
}

TextStyle _label(WidgetTester t, String id, String text) => t
    .widget<Text>(
      find.descendant(
        of: find.byKey(Key('nav-$id')),
        matching: find.text(text),
      ),
    )
    .style!;

void main() {
  setUp(
    () => Web.use(
      WebPalette.fromTokens(PayeshTokens.minimalLight, Brightness.light),
    ),
  );

  test(
    'S190-01 tokens: a stronger card frame, darker hairlines, grey page',
    () {
      for (final t in [PayeshTokens.minimalLight, PayeshTokens.minimalDark]) {
        expect(t.frame, isNot(t.line));
        expect(
          contrastRatio(t.frame, t.card),
          greaterThan(contrastRatio(t.line, t.card)),
          reason: 'the frame is a step stronger than the inner hairlines',
        );
        expect(contrastRatio(t.frame, t.card), greaterThanOrEqualTo(1.5));
      }
      final l = PayeshTokens.minimalLight;
      expect(
        l.line,
        isNot(const Color(0xFFE4E4E7)),
        reason: 'NEG old hairline',
      );
      expect(l.bg, isNot(l.card), reason: 'white cards stand on a grey page');
      expect(contrastRatio(l.muted, l.bg), greaterThanOrEqualTo(wcagAA));
      expect(contrastRatio(l.link, l.bg), greaterThanOrEqualTo(wcagAA));
      // light cards get a faint lift; dark ones rely on the frame
      expect(Web.shadow, isNotEmpty);
      expect(
        WebPalette.fromTokens(PayeshTokens.minimalDark, Brightness.dark).shadow,
        isEmpty,
      );
    },
  );

  testWidgets('S190-02 cards (D2Card / WebCard) carry the frame and the lift', (
    t,
  ) async {
    await _pump(
      t,
      const Column(
        children: [
          D2Card(key: Key('d2'), child: Text('a')),
          WebCard(key: Key('wc'), child: Text('b')),
        ],
      ),
      const Size(800, 600),
    );
    for (final k in ['d2', 'wc']) {
      final box = t.widget<Container>(
        find
            .descendant(
              of: find.byKey(Key(k)),
              matching: find.byType(Container),
            )
            .first,
      );
      final d = box.decoration! as BoxDecoration;
      expect((d.border! as Border).top.color, Web.frame, reason: k);
      expect(d.boxShadow, isNotEmpty, reason: k);
    }
  });

  testWidgets(
    'S190-03 Windows sidebar: bold ink items, the chosen one framed with a violet bar',
    (t) async {
      await _pump(
        t,
        Row(
          children: [
            PulseSidebar(
              items: _items,
              selected: 'today',
              onSelected: (_) {},
              school: 'کاردانش آینده سازان',
              account: 'رضا احمدی · مدیر',
            ),
            const Expanded(child: SizedBox()),
          ],
        ),
        const Size(1280, 800),
      );
      final off = _label(t, 'users', 'کاربران');
      expect(off.fontSize, 14);
      expect(off.fontWeight, FontWeight.w600);
      expect(off.color, Web.ink, reason: 'NEG not the lighter ink2');
      final on = _label(t, 'today', 'داشبورد');
      expect(on.fontWeight, FontWeight.w800);
      expect(find.byKey(const Key('pulse-nav-bar')), findsOneWidget);
      final pill = t.widget<Container>(
        find
            .descendant(
              of: find.byKey(const Key('nav-today')),
              matching: find.byType(Container),
            )
            .first,
      );
      final d = pill.decoration! as BoxDecoration;
      expect((d.border! as Border).top.color, Web.frame);
      expect(d.color, Web.card, reason: 'card-white pill on the grey sidebar');
      expect(t.takeException(), isNull);
    },
  );

  testWidgets(
    'S190-04 phone: bolder bottom bar and «بیشتر» sheet, no overflow at 360',
    (t) async {
      await _pump(
        t,
        Align(
          alignment: Alignment.bottomCenter,
          child: PulseBottomNav(
            items: _items,
            selected: 'today',
            onSelected: (_) {},
          ),
        ),
        const Size(360, 740),
      );
      final off = _label(t, 'users', 'کاربران');
      expect(off.fontSize, 12);
      expect(off.fontWeight, FontWeight.w600);
      expect(off.color, Web.ink2, reason: 'NEG not the pale muted grey');
      expect(_label(t, 'today', 'داشبورد').fontWeight, FontWeight.w800);
      final bar = t.widget<Container>(
        find
            .descendant(
              of: find.byKey(const Key('pulse-bottomnav')),
              matching: find.byType(Container),
            )
            .first,
      );
      final d = bar.decoration! as BoxDecoration;
      expect((d.border! as Border).top.color, Web.frame);
      expect(t.takeException(), isNull);
      await t.tap(find.byKey(const Key('nav-more')));
      await t.pumpAndSettle();
      expect(find.byKey(const Key('pulse-more-sheet')), findsOneWidget);
      expect(_label(t, 'system', 'سیستم').fontWeight, FontWeight.w600);
      expect(t.takeException(), isNull);
    },
  );
}
