import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_ui/payesh_ui.dart';

void main() {
  for (final (name, t, theme) in [
    ('light', PayeshTokens.light, PayeshUi.light()),
    ('dark', PayeshTokens.dark, PayeshUi.dark()),
    // row 147: «نبض» (client/pulse.css) for the owner panel — same AA bar
    (
      'nabd light',
      PayeshTokens.nabdLight,
      PayeshUi.light(look: PayeshLook.nabd),
    ),
    ('nabd dark', PayeshTokens.nabdDark, PayeshUi.dark(look: PayeshLook.nabd)),
  ]) {
    group('$name tokens meet WCAG 2.x AA', () {
      test('body text and secondary text on every surface ≥ 4.5:1', () {
        for (final s in [t.bg, t.card, t.soft]) {
          expect(contrastRatio(t.ink, s), greaterThanOrEqualTo(wcagAA));
          expect(
            contrastRatio(t.muted, s),
            greaterThanOrEqualTo(wcagAA),
            reason: 'muted on $s',
          );
          expect(
            contrastRatio(t.primary, s),
            greaterThanOrEqualTo(wcagAA),
            reason: 'primary/link on $s',
          );
        }
      });
      test('every status tone: text on its own background ≥ 4.5:1', () {
        for (final tone in PayeshTone.values) {
          final (fg, bg) = t.tone(tone);
          expect(
            contrastRatio(fg, bg),
            greaterThanOrEqualTo(wcagAA),
            reason: '$tone',
          );
        }
      });
      test('filled buttons and field borders', () {
        final c = theme.colorScheme;
        expect(
          contrastRatio(c.onPrimary, c.primary),
          greaterThanOrEqualTo(wcagAA),
        );
        expect(contrastRatio(c.onError, c.error), greaterThanOrEqualTo(wcagAA));
        expect(
          contrastRatio(c.outline, t.card),
          greaterThanOrEqualTo(wcagAALarge),
        );
      });
    });
  }

  test('«نبض»: the raw pulse.css light muted/primary fail AA, so the tokens darken them', () {
    const pulseMuted = Color(0xFF5D7D76), pulsePrimary = Color(0xFF0D9488);
    final t = PayeshTokens.nabdLight;
    expect(contrastRatio(pulseMuted, t.bg), lessThan(wcagAA));
    expect(contrastRatio(pulsePrimary, Colors.white), lessThan(wcagAA));
    expect(t.muted, isNot(pulseMuted));
    expect(t.primary, const Color(0xFF0F766E));
    expect(t.primary2, pulsePrimary, reason: 'gradient start only');
    // active navigation item: white icon on the primary fill
    final rail = PayeshUi.light(look: PayeshLook.nabd).navigationRailTheme;
    expect(
      contrastRatio(rail.selectedIconTheme!.color!, rail.indicatorColor!),
      greaterThanOrEqualTo(wcagAA),
    );
    final railDark = PayeshUi.dark(look: PayeshLook.nabd).navigationRailTheme;
    expect(
      contrastRatio(
        railDark.selectedIconTheme!.color!,
        railDark.indicatorColor!,
      ),
      greaterThanOrEqualTo(wcagAA),
    );
    // NEG: classic keeps Material defaults (no nav theme), classic tokens unchanged
    expect(PayeshUi.light().navigationRailTheme.indicatorColor, isNull);
    expect(PayeshTokens.light.primary, const Color(0xFF1E3A8A));
    expect(
      PayeshTokens.of(PayeshLook.classic, Brightness.dark),
      same(PayeshTokens.dark),
    );
    expect(
      PayeshTokens.of(PayeshLook.nabd, Brightness.dark),
      same(PayeshTokens.nabdDark),
    );
    expect(PayeshTokens.light.cardRadius, PayeshTokens.radius);
    expect(t.cardRadius, 18);
    expect(PayeshTokens.light.lerp(t, 0.8).look, PayeshLook.nabd);
    expect(PayeshTokens.light.lerp(t, 0.2).look, PayeshLook.classic);
    expect(t.copyWith().look, PayeshLook.nabd);
    expect(t.primaryGradient.colors, [t.primary2, t.primary]);
    expect(PayeshTokens.light.primaryGradient.colors.toSet(), {
      PayeshTokens.light.primary,
    });
  });

  test('contrast math matches WCAG reference values', () {
    expect(contrastRatio(Colors.black, Colors.white), closeTo(21, 0.01));
    expect(
      contrastRatio(const Color(0xFF777777), Colors.white),
      closeTo(4.48, 0.01),
    );
    expect(relativeLuminance(Colors.white), closeTo(1, 1e-9));
  });

  test(
    'token lerp / copyWith keep the extension usable for theme animation',
    () {
      final mid = PayeshTokens.light.lerp(PayeshTokens.dark, 0.5);
      expect(mid.bg, isNot(PayeshTokens.light.bg));
      expect(PayeshTokens.light.lerp(null, 0.5), same(PayeshTokens.light));
      expect(
        PayeshTokens.light.copyWith(primary: Colors.red).primary,
        Colors.red,
      );
      expect(PayeshTokens.light.copyWith().bg, PayeshTokens.light.bg);
      expect(PayeshTokens.light.copyWith(bg: Colors.red).bg, Colors.red);
    },
  );

  test('platform sizing: Windows compact density, Android standard, 48dp targets kept', () {
    final w = PayeshUi.light(platform: TargetPlatform.windows);
    final a = PayeshUi.light(platform: TargetPlatform.android);
    expect(w.visualDensity, VisualDensity.compact);
    expect(a.visualDensity, VisualDensity.standard);
    expect(PayeshUi.densityFor(TargetPlatform.linux), VisualDensity.compact);
    expect(PayeshUi.densityFor(TargetPlatform.iOS), VisualDensity.standard);
    for (final th in [w, a]) {
      expect(th.materialTapTargetSize, MaterialTapTargetSize.padded);
      expect(
        th.filledButtonTheme.style!.minimumSize!.resolve({}),
        const Size(48, 48),
      );
      expect(
        th.textTheme.bodyMedium!.fontFamily,
        'packages/payesh_ui/Vazirmatn',
      );
    }
    expect(sizeClassOf(360), SizeClass.compact);
    expect(sizeClassOf(700), SizeClass.medium);
    expect(sizeClassOf(1280), SizeClass.expanded);
  });
}
