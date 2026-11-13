// ردیف ۱۵۱: پوستهٔ کامل «نبض» — کارت قهرمان و اجزای Material (فقط در look نبض).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_ui/payesh_ui.dart';

void main() {
  testWidgets('کارت قهرمان نبض: عدد فارسی، جزئیات، قاب رنگ اصلی', (t) async {
    await t.pumpWidget(
      MaterialApp(
        theme: PayeshUi.light(look: PayeshLook.nabd),
        home: const Scaffold(
          body: NabdHeroCard(
            key: Key('hero'),
            title: 'نبض پلتفرم',
            value: 1250,
            caption: 'کاربران فعال',
            details: ['اشتراک‌ها: ۳'],
          ),
        ),
      ),
    );
    expect(find.text('۱٬۲۵۰'), findsOneWidget);
    expect(find.text('اشتراک‌ها: ۳'), findsOneWidget);
    final box = t.widget<Container>(
      find
          .descendant(
            of: find.byKey(const Key('hero')),
            matching: find.byType(Container),
          )
          .first,
    );
    final deco = box.decoration! as BoxDecoration;
    expect((deco.border! as Border).top.width, 2);
    expect(deco.borderRadius, BorderRadius.circular(24));
    expect(t.takeException(), isNull);
  });

  test('اجزای Material با زبان بصری نبض؛ پوستهٔ کلاسیک دست‌نخورده', () {
    for (final th in [
      PayeshUi.light(look: PayeshLook.nabd),
      PayeshUi.dark(look: PayeshLook.nabd),
    ]) {
      final tk = th.extension<PayeshTokens>()!;
      expect(th.appBarTheme.titleTextStyle?.fontSize, 19);
      expect(th.dialogTheme.shape, isA<RoundedRectangleBorder>());
      expect(th.progressIndicatorTheme.color, tk.primary);
      expect(th.dividerTheme.color, tk.line);
      expect(
        th.switchTheme.trackColor!.resolve({WidgetState.selected}),
        tk.primary,
      );
      expect(th.switchTheme.trackColor!.resolve({}), tk.soft);
      expect(th.dataTableTheme.headingTextStyle?.color, tk.muted);
      expect(th.tooltipTheme.decoration, isA<BoxDecoration>());
      expect(th.filledButtonTheme.style!.shadowColor!.resolve({}), tk.glow);
    }
    final classic = PayeshUi.light();
    expect(classic.appBarTheme.titleTextStyle, isNull);
    expect(classic.switchTheme.trackColor, isNull);
    expect(classic.dataTableTheme.headingTextStyle, isNull);
  });
}
