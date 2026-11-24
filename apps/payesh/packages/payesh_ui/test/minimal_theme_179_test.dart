// Row 179 — «مینیمال حرفه‌ای» + روشن / تاریک / سیستم chosen by the user.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_ui/payesh_ui.dart';

void main() {
  group('minimal look', () {
    test(
      'tokens: zinc surfaces, violet accent, flat (no glow, no gradient)',
      () {
        final l = PayeshTokens.minimalLight, d = PayeshTokens.minimalDark;
        expect(l.bg, const Color(0xFFFAFAFA));
        expect(l.primary, const Color(0xFF5B4BDB));
        expect(d.bg, const Color(0xFF09090B));
        expect(d.primary, const Color(0xFFA89EFF));
        for (final t in [l, d]) {
          expect(t.isMinimal, isTrue);
          expect(t.isPanel, isTrue);
          expect(t.isNabd, isFalse);
          expect(t.glow.a, 0, reason: 'flat cards');
          expect(t.primaryGradient.colors.toSet(), {t.primary});
          expect(t.cardRadius, 10);
        }
        expect(PayeshTokens.of(PayeshLook.minimal, Brightness.light), same(l));
        expect(PayeshTokens.of(PayeshLook.minimal, Brightness.dark), same(d));
        // NEG: the other looks are untouched
        expect(PayeshTokens.nabdLight.isMinimal, isFalse);
        expect(PayeshTokens.light.isPanel, isFalse);
      },
    );

    test(
      'theme: flat cards with a hairline, soft grey nav pill with ink text',
      () {
        for (final b in Brightness.values) {
          final theme = b == Brightness.light
              ? PayeshUi.light(look: PayeshLook.minimal)
              : PayeshUi.dark(look: PayeshLook.minimal);
          final t = PayeshTokens.of(PayeshLook.minimal, b);
          expect(theme.brightness, b);
          expect(theme.cardTheme.elevation ?? 0, 0);
          final shape = theme.cardTheme.shape as RoundedRectangleBorder;
          expect(shape.side.color, t.line);
          expect(shape.borderRadius, BorderRadius.circular(10));
          final rail = theme.navigationRailTheme;
          expect(rail.indicatorColor, t.soft);
          expect(rail.selectedIconTheme!.color, t.ink);
          expect(
            contrastRatio(rail.selectedIconTheme!.color!, rail.indicatorColor!),
            greaterThanOrEqualTo(wcagAA),
          );
          expect(theme.appBarTheme.backgroundColor, t.bg);
          expect(theme.scaffoldBackgroundColor, t.bg);
        }
        // NEG: «نبض» keeps its gradient pill + glow
        final n = PayeshUi.light(look: PayeshLook.nabd);
        expect(
          n.navigationRailTheme.indicatorColor,
          isNot(PayeshTokens.nabdLight.soft),
        );
      },
    );
  });

  group('PayeshThemeMode (روشن / تاریک / سیستم)', () {
    test('parse / encode / cycle order', () {
      expect(PayeshThemeMode.parse(null), ThemeMode.system);
      expect(PayeshThemeMode.parse('system'), ThemeMode.system);
      expect(PayeshThemeMode.parse('light'), ThemeMode.light);
      expect(PayeshThemeMode.parse('dark'), ThemeMode.dark);
      expect(PayeshThemeMode.parse('garbage'), ThemeMode.system);
      for (final m in ThemeMode.values) {
        expect(PayeshThemeMode.parse(PayeshThemeMode.encode(m)), m);
      }
      expect(PayeshThemeMode.next(ThemeMode.system), ThemeMode.light);
      expect(PayeshThemeMode.next(ThemeMode.light), ThemeMode.dark);
      expect(PayeshThemeMode.next(ThemeMode.dark), ThemeMode.system);
    });

    test('load + save through the app store', () async {
      final store = <String, String>{'theme': 'dark'};
      final c = PayeshThemeMode(
        save: (v) async => store[PayeshThemeMode.storeKey] = v,
      );
      await c.load((k) async => store[k]);
      expect(c.value, ThemeMode.dark);
      await c.cycle();
      expect(c.value, ThemeMode.system);
      expect(store['theme'], 'system');
      await c.set(ThemeMode.light);
      expect(store['theme'], 'light');
      // an unreadable store keeps «سیستم»
      final bad = PayeshThemeMode();
      await bad.load((_) async => throw StateError('locked'));
      expect(bad.value, ThemeMode.system);
    });

    testWidgets(
      'the app follows the choice live; button + segments change it',
      (tester) async {
        final c = PayeshThemeMode(initial: ThemeMode.light);
        var synced = <Brightness>[];
        await tester.pumpWidget(
          PayeshMaterialApp(
            look: PayeshLook.minimal,
            themeController: c,
            onTheme: (t) {
              synced.add(t.brightness);
              return false;
            },
            home: const Scaffold(
              body: Column(
                children: [PayeshThemeButton(), PayeshThemeChoice()],
              ),
            ),
          ),
        );
        BuildContext ctx() => tester.element(find.byType(PayeshThemeChoice));
        expect(Theme.of(ctx()).brightness, Brightness.light);
        expect(find.byTooltip('پوسته: روشن'), findsOneWidget);
        await tester.tap(find.byKey(const Key('theme')));
        await tester.pumpAndSettle();
        expect(c.value, ThemeMode.dark);
        expect(Theme.of(ctx()).brightness, Brightness.dark);
        expect(ctx().tokens, PayeshTokens.minimalDark);
        expect(synced.last, Brightness.dark);
        await tester.tap(find.byKey(const Key('theme-light')));
        await tester.pumpAndSettle();
        expect(c.value, ThemeMode.light);
        expect(Theme.of(ctx()).brightness, Brightness.light);
        synced = [];
      },
    );

    testWidgets('PayeshThemeSync rebuilds the pages when the palette changes', (
      tester,
    ) async {
      final c = PayeshThemeMode(initial: ThemeMode.light);
      var palette = Brightness.light;
      var builds = 0;
      await tester.pumpWidget(
        PayeshMaterialApp(
          look: PayeshLook.minimal,
          themeController: c,
          onTheme: (t) {
            if (t.brightness == palette) return false;
            palette = t.brightness;
            return true;
          },
          home: _Counter(onBuild: () => builds++),
        ),
      );
      final before = builds;
      await c.set(ThemeMode.dark);
      await tester.pumpAndSettle();
      expect(palette, Brightness.dark);
      expect(
        builds,
        greaterThan(before),
        reason: 'static-palette widget repainted',
      );
    });

    testWidgets(
      'no controller in scope: the button and segments draw nothing',
      (tester) async {
        await tester.pumpWidget(
          const MaterialApp(
            home: Scaffold(
              body: Column(
                children: [PayeshThemeButton(), PayeshThemeChoice()],
              ),
            ),
          ),
        );
        expect(find.byType(IconButton), findsNothing);
        expect(find.byType(SegmentedButton<ThemeMode>), findsNothing);
      },
    );
  });
}

class _Counter extends StatelessWidget {
  const _Counter({required this.onBuild});
  final VoidCallback onBuild;
  @override
  Widget build(BuildContext context) {
    onBuild();
    return const SizedBox();
  }
}
