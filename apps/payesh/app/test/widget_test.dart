import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/app.dart';

void main() {
  testWidgets('app starts in Persian, right-to-left', (tester) async {
    await tester.pumpWidget(const PayeshApp());
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('home-title')), findsOneWidget);
    expect(find.text('sync-v1'), findsOneWidget);
    final ctx = tester.element(find.byKey(const Key('home-title')));
    expect(Directionality.of(ctx), TextDirection.rtl);
    expect(Localizations.localeOf(ctx).languageCode, 'fa');
  });

  testWidgets(
    'design system: Vazirmatn theme, today in Jalali, dark mode follows system',
    (tester) async {
      await tester.pumpWidget(PayeshApp(today: () => DateTime(2026, 11, 10)));
      await tester.pumpAndSettle();
      expect(find.text('۱۹ آبان ۱۴۰۵'), findsOneWidget);
      final ctx = tester.element(find.byKey(const Key('home-title')));
      expect(
        Theme.of(ctx).textTheme.bodyMedium!.fontFamily,
        'packages/payesh_ui/Vazirmatn',
      );
      expect(Theme.of(ctx).brightness, Brightness.light);
      tester.platformDispatcher.platformBrightnessTestValue = Brightness.dark;
      addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
      await tester.pumpAndSettle();
      expect(
        Theme.of(tester.element(find.byKey(const Key('home-title'))))
            .brightness,
        Brightness.dark,
      );
    },
  );
}
