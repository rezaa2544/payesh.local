// Row 190 — «تفکیک بخش‌ها بهتر، کادرها پررنگ‌تر؛ گزینه‌های منو پررنگ‌تر و برجسته‌تر» in the
// shared theme: the card frame token, the bolder phone drawer (owner app) and the frame through
// copyWith / lerp. NEG: the older looks keep frame = line and their drawer unchanged.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_ui/payesh_ui.dart';

void main() {
  test(
    'U190-01 frame: a step stronger than the hairlines; = line elsewhere',
    () {
      for (final t in [PayeshTokens.minimalLight, PayeshTokens.minimalDark]) {
        expect(
          contrastRatio(t.frame, t.card),
          greaterThan(contrastRatio(t.line, t.card)),
        );
      }
      for (final t in [
        PayeshTokens.light,
        PayeshTokens.dark,
        PayeshTokens.nabdLight,
        PayeshTokens.nabdDark,
      ]) {
        expect(t.frame, t.line, reason: 'NEG older looks unchanged');
      }
      final l = PayeshTokens.minimalLight, d = PayeshTokens.minimalDark;
      expect(l.copyWith(bg: Colors.red).frame, l.frame);
      expect(l.lerp(d, 0).frame, l.frame);
      expect(l.lerp(d, 1).frame, d.frame);
      expect(l.lerp(d, 0.5).frame, Color.lerp(l.frame, d.frame, 0.5));
      expect(l.lerp(null, 0.5), same(l));
    },
  );

  test('U190-02 phone drawer: ink w600 items, a framed chosen item with a '
      'violet icon and w800 text', () {
    for (final b in Brightness.values) {
      final theme = b == Brightness.light
          ? PayeshUi.light(look: PayeshLook.minimal)
          : PayeshUi.dark(look: PayeshLook.minimal);
      final t = PayeshTokens.of(PayeshLook.minimal, b);
      final dr = theme.navigationDrawerTheme;
      expect(dr.backgroundColor, t.navBg);
      expect(dr.indicatorColor, b == Brightness.light ? t.card : t.soft);
      expect(
        (dr.indicatorShape! as RoundedRectangleBorder).side.color,
        t.frame,
      );
      const on = {WidgetState.selected};
      const off = <WidgetState>{};
      final lOn = dr.labelTextStyle!.resolve(on)!;
      final lOff = dr.labelTextStyle!.resolve(off)!;
      expect(lOn.fontWeight, FontWeight.w800);
      expect(lOff.fontWeight, FontWeight.w600);
      expect(lOff.fontSize, 14);
      expect(lOff.color, t.ink);
      final iOn = dr.iconTheme!.resolve(on)!;
      final iOff = dr.iconTheme!.resolve(off)!;
      expect(iOn.color, t.link);
      expect(iOff.color, t.ink, reason: 'NEG not the pale muted grey');
      expect(iOff.size, 22);
      // cards: the frame and a hint of lift in light only
      final card = theme.cardTheme;
      expect((card.shape! as RoundedRectangleBorder).side.color, t.frame);
      expect(card.elevation, b == Brightness.light ? 1 : 0);
    }
  });

  test('U190-03 NEG «نبض» drawer keeps its filled primary pill', () {
    final theme = PayeshUi.light(look: PayeshLook.nabd);
    final t = PayeshTokens.nabdLight;
    final dr = theme.navigationDrawerTheme;
    expect(dr.indicatorColor, t.primary);
    expect(
      (dr.indicatorShape! as RoundedRectangleBorder).side,
      BorderSide.none,
    );
    final lOff = dr.labelTextStyle!.resolve(<WidgetState>{})!;
    expect(lOff.fontWeight, FontWeight.w400);
    expect(lOff.fontSize, isNull);
    final lOn = dr.labelTextStyle!.resolve({WidgetState.selected})!;
    expect(lOn.fontWeight, FontWeight.w700);
    expect(dr.iconTheme!.resolve(<WidgetState>{})!.color, t.muted);
    expect(theme.cardTheme.elevation, 3);
  });
}
