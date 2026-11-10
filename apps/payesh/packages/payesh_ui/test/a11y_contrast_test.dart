import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_ui/payesh_ui.dart';

void main() {
  for (final (name, t, theme) in [
    ('light', PayeshTokens.light, PayeshUi.light()),
    ('dark', PayeshTokens.dark, PayeshUi.dark()),
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
