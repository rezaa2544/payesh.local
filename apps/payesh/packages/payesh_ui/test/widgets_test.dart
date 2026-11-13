import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'support/showcase.dart';

Future<void> pumpAt(
  WidgetTester t,
  Size size, {
  ThemeMode mode = ThemeMode.light,
  double textScale = 1,
  TargetPlatform platform = TargetPlatform.android,
  PayeshLook look = PayeshLook.classic,
}) async {
  t.view.physicalSize = size;
  t.view.devicePixelRatio = 1;
  t.platformDispatcher.textScaleFactorTestValue = textScale;
  addTearDown(t.view.reset);
  addTearDown(t.platformDispatcher.clearAllTestValues);
  await t.pumpWidget(
    PayeshMaterialApp(
      themeMode: mode,
      platform: platform,
      look: look,
      home: const Showcase(),
    ),
  );
  await t.pumpAndSettle();
}

void main() {
  testWidgets(
    'full RTL: fa locale, rtl Directionality, start edge is on the right',
    (t) async {
      await pumpAt(t, const Size(360, 780));
      final ctx = t.element(find.byType(Showcase));
      expect(Directionality.of(ctx), TextDirection.rtl);
      expect(Localizations.localeOf(ctx), const Locale('fa', 'IR'));
      final tile = t.getRect(find.text('دانش‌آموزان'));
      final icon = t.getRect(find.byIcon(Icons.groups));
      expect(
        icon.left,
        greaterThan(tile.left),
        reason: 'leading icon sits on the right in RTL',
      );
    },
  );

  testWidgets(
    'Jalali display over ISO data + Persian digits + screen-reader labels',
    (t) async {
      final h = t.ensureSemantics();
      await pumpAt(t, const Size(360, 1400));
      expect(find.text('۱۹ آبان ۱۴۰۵'), findsOneWidget);
      expect(find.text('۱۴۰۴/۰۱/۰۱'), findsOneWidget);
      expect(find.text('۱٬۲۳۴'), findsOneWidget);
      expect(find.bySemanticsLabel('سه‌شنبه ۱۹ آبان ۱۴۰۵'), findsOneWidget);
      expect(find.bySemanticsLabel('دانش‌آموزان: ۱٬۲۳۴'), findsOneWidget);
      expect(find.bySemanticsLabel('همگام'), findsOneWidget);
      final header = t.getSemantics(find.text('اطلاعیه‌ها'));
      expect(header.flagsCollection.isHeader, isTrue);
      h.dispose();
    },
  );

  testWidgets('unknown date is announced, not silent', (t) async {
    final h = t.ensureSemantics();
    await t.pumpWidget(
      const PayeshMaterialApp(home: Scaffold(body: JalaliDateText(null))),
    );
    expect(find.text('—'), findsOneWidget);
    expect(find.bySemanticsLabel('تاریخ نامشخص'), findsOneWidget);
    await t.pumpWidget(
      const PayeshMaterialApp(home: Scaffold(body: FaNumberText(42))),
    );
    expect(find.text('۴۲'), findsOneWidget);
    h.dispose();
  });

  testWidgets('Android phone: bottom navigation; selecting a tab works', (
    t,
  ) async {
    await pumpAt(t, const Size(360, 780));
    expect(find.byKey(const Key('nav-bar')), findsOneWidget);
    expect(find.byKey(const Key('nav-rail')), findsNothing);
    await t.tap(find.text('نمره‌ها'));
    await t.pumpAndSettle();
    expect(
      t.widget<NavigationBar>(find.byType(NavigationBar)).selectedIndex,
      2,
    );
  });

  testWidgets(
    'Windows window: extended navigation rail on the RIGHT, compact density',
    (t) async {
      await pumpAt(t, const Size(1280, 800), platform: TargetPlatform.windows);
      final rail = find.byKey(const Key('nav-rail'));
      expect(rail, findsOneWidget);
      expect(t.widget<NavigationRail>(rail).extended, isTrue);
      expect(t.getRect(rail).right, 1280);
      expect(Theme.of(t.element(rail)).visualDensity, VisualDensity.compact);
      await t.tap(find.text('تنظیمات'));
      await t.pumpAndSettle();
      expect(t.widget<NavigationRail>(rail).selectedIndex, 3);
    },
  );

  testWidgets('tablet width: rail with labels (not extended)', (t) async {
    await pumpAt(t, const Size(700, 900));
    expect(
      t.widget<NavigationRail>(find.byKey(const Key('nav-rail'))).extended,
      isFalse,
    );
  });

  for (final mode in [ThemeMode.light, ThemeMode.dark]) {
    testWidgets(
      'accessibility guidelines ($mode): tap targets, labels, text contrast',
      (t) async {
        final h = t.ensureSemantics();
        await pumpAt(t, const Size(360, 780), mode: mode);
        await expectLater(t, meetsGuideline(androidTapTargetGuideline));
        await expectLater(t, meetsGuideline(labeledTapTargetGuideline));
        await expectLater(t, meetsGuideline(textContrastGuideline));
        h.dispose();
      },
    );
  }

  for (final scale in [1.3, 2.0]) {
    testWidgets(
      'text scale ×$scale: no overflow on a phone or a Windows window',
      (t) async {
        await pumpAt(t, const Size(360, 780), textScale: scale);
        expect(t.takeException(), isNull);
        await pumpAt(
          t,
          const Size(1280, 800),
          textScale: scale,
          platform: TargetPlatform.windows,
        );
        expect(t.takeException(), isNull);
      },
    );
  }

  testWidgets(
    'dark theme really switches surfaces and keeps tokens reachable',
    (t) async {
      await pumpAt(t, const Size(360, 780), mode: ThemeMode.dark);
      final ctx = t.element(find.byType(Showcase));
      expect(Theme.of(ctx).brightness, Brightness.dark);
      expect(ctx.tokens.bg, PayeshTokens.dark.bg);
      expect(Theme.of(ctx).scaffoldBackgroundColor, PayeshTokens.dark.bg);
    },
  );

  testWidgets('tokens fallback outside a Payesh theme', (t) async {
    late PayeshTokens got;
    await t.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (c) {
            got = c.tokens;
            return const SizedBox();
          },
        ),
      ),
    );
    expect(got, same(PayeshTokens.light));
  });

  testWidgets(
    'row 147 «نبض»: stat numbers in primary, rounder icon tiles, backdrop + brand',
    (t) async {
      Color? numberColour() =>
          t.widget<Text>(find.text(faNumber(1234))).style?.color;
      await pumpAt(t, const Size(1280, 800), look: PayeshLook.nabd);
      expect(numberColour(), PayeshTokens.nabdLight.primary);
      expect(t.takeException(), isNull);
      // classic: the number keeps the body ink (theme default), nothing else changes
      await pumpAt(t, const Size(1280, 800));
      expect(numberColour(), isNot(PayeshTokens.nabdLight.primary));

      Future<void> pumpPiece(PayeshLook look, Brightness b) async {
        await t.pumpWidget(
          MaterialApp(
            theme: b == Brightness.light
                ? PayeshUi.light(look: look)
                : PayeshUi.dark(look: look),
            home: const Directionality(
              textDirection: TextDirection.rtl,
              child: PayeshBackdrop(child: Center(child: PayeshBrandMark())),
            ),
          ),
        );
        await t.pumpAndSettle(); // the theme animates between looks
      }

      await pumpPiece(PayeshLook.nabd, Brightness.light);
      expect(find.byKey(const Key('payesh-backdrop')), findsOneWidget);
      final mark = t.widget<Container>(
        find.descendant(
          of: find.byType(PayeshBrandMark),
          matching: find.byType(Container),
        ),
      );
      final deco = mark.decoration! as BoxDecoration;
      expect(deco.gradient, PayeshTokens.nabdLight.primaryGradient);
      expect(deco.boxShadow, isNotEmpty);
      await pumpPiece(PayeshLook.nabd, Brightness.dark);
      expect(find.byKey(const Key('payesh-backdrop')), findsOneWidget);
      // NEG: classic — plain surface colour, no wash, flat mark
      await pumpPiece(PayeshLook.classic, Brightness.light);
      expect(find.byKey(const Key('payesh-backdrop')), findsNothing);
      final flat = t.widget<Container>(
        find.descendant(
          of: find.byType(PayeshBrandMark),
          matching: find.byType(Container),
        ),
      );
      expect((flat.decoration! as BoxDecoration).boxShadow, isNull);
      expect(t.takeException(), isNull);
    },
  );
}
