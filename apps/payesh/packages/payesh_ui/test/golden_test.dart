// Golden screenshots rendered with the REAL bundled Vazirmatn (not Ahem): light/dark,
// Android phone and Windows window, plus large text. Regenerate intentionally with
//   flutter test --update-goldens test/golden_test.dart
@Tags(['golden'])
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'support/fonts.dart';
import 'support/showcase.dart';

void main() {
  setUpAll(() async {
    await loadPayeshFonts();
    goldenFileComparator = TolerantComparator(
      Uri.parse('test/golden_test.dart'),
    );
  });

  for (final (name, size, mode, platform, scale, look) in [
    (
      'android_light',
      const Size(360, 780),
      ThemeMode.light,
      TargetPlatform.android,
      1.0,
      PayeshLook.classic,
    ),
    (
      'android_dark',
      const Size(360, 780),
      ThemeMode.dark,
      TargetPlatform.android,
      1.0,
      PayeshLook.classic,
    ),
    (
      'windows_light',
      const Size(1280, 800),
      ThemeMode.light,
      TargetPlatform.windows,
      1.0,
      PayeshLook.classic,
    ),
    (
      'windows_dark',
      const Size(1280, 800),
      ThemeMode.dark,
      TargetPlatform.windows,
      1.0,
      PayeshLook.classic,
    ),
    (
      'android_light_text2x',
      const Size(360, 780),
      ThemeMode.light,
      TargetPlatform.android,
      2.0,
      PayeshLook.classic,
    ),
    // row 147: «نبض» — the owner panel's look
    (
      'nabd_windows_light',
      const Size(1280, 800),
      ThemeMode.light,
      TargetPlatform.windows,
      1.0,
      PayeshLook.nabd,
    ),
    (
      'nabd_windows_dark',
      const Size(1280, 800),
      ThemeMode.dark,
      TargetPlatform.windows,
      1.0,
      PayeshLook.nabd,
    ),
    (
      'nabd_android_light',
      const Size(360, 780),
      ThemeMode.light,
      TargetPlatform.android,
      1.0,
      PayeshLook.nabd,
    ),
  ]) {
    testWidgets('golden $name', (t) async {
      t.view.physicalSize = size;
      t.view.devicePixelRatio = 1;
      t.platformDispatcher.textScaleFactorTestValue = scale;
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
      await expectLater(
        find.byType(Showcase),
        matchesGoldenFile('goldens/$name.png'),
      );
    });
  }
}
