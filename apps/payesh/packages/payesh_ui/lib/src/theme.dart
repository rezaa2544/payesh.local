import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'tokens.dart';

/// Light/dark themes of the native app, built only from [PayeshTokens].
abstract final class PayeshUi {
  /// The app is Persian and right-to-left on every platform.
  static const Locale locale = Locale('fa', 'IR');

  static ThemeData light({TargetPlatform? platform}) =>
      _build(PayeshTokens.light, Brightness.light, platform);

  static ThemeData dark({TargetPlatform? platform}) =>
      _build(PayeshTokens.dark, Brightness.dark, platform);

  /// Desktop (Windows) is mouse-first → compact density; Android stays touch-standard.
  static VisualDensity densityFor(TargetPlatform p) => switch (p) {
    TargetPlatform.windows ||
    TargetPlatform.linux ||
    TargetPlatform.macOS => VisualDensity.compact,
    _ => VisualDensity.standard,
  };

  static ThemeData _build(
    PayeshTokens t,
    Brightness b,
    TargetPlatform? platform,
  ) {
    final p = platform ?? defaultTargetPlatform;
    final scheme =
        ColorScheme.fromSeed(
          seedColor: PayeshTokens.light.primary,
          brightness: b,
        ).copyWith(
          primary: t.primary,
          onPrimary: b == Brightness.light
              ? Colors.white
              : const Color(0xFF0B1220),
          surface: t.card,
          onSurface: t.ink,
          onSurfaceVariant: t.muted,
          outline: t.muted,
          outlineVariant: t.line,
          error: t.danger,
          onError: b == Brightness.light
              ? Colors.white
              : const Color(0xFF0B1220),
          secondaryContainer: t.soft,
          onSecondaryContainer: t.ink,
        );
    const shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.all(Radius.circular(PayeshTokens.radius)),
    );
    const minButton = Size(
      PayeshTokens.minTouchTarget,
      PayeshTokens.minTouchTarget,
    );
    final base = ThemeData(
      useMaterial3: true,
      brightness: b,
      colorScheme: scheme,
      platform: p,
      visualDensity: densityFor(p),
      // Material keeps 48dp hit areas even when visuals are compact on Windows.
      materialTapTargetSize: MaterialTapTargetSize.padded,
      fontFamily: PayeshTokens.fontFamily,
      package: PayeshTokens.fontPackage,
      scaffoldBackgroundColor: t.bg,
      dividerColor: t.line,
      extensions: [t],
    );
    return base.copyWith(
      textTheme: base.textTheme.apply(
        bodyColor: t.ink,
        displayColor: t.ink,
        fontFamily: PayeshTokens.fontFamily,
        package: PayeshTokens.fontPackage,
      ),
      cardTheme: CardThemeData(
        color: t.card,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: shape.copyWith(side: BorderSide(color: t.line)),
      ),
      appBarTheme: AppBarTheme(
        backgroundColor: t.card,
        foregroundColor: t.ink,
        elevation: 0,
        scrolledUnderElevation: 1,
        centerTitle: false,
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(minimumSize: minButton, shape: shape),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(minimumSize: minButton, shape: shape),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(minimumSize: minButton),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: t.card,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(PayeshTokens.radiusSmall),
          borderSide: BorderSide(color: t.muted),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(PayeshTokens.radiusSmall),
          borderSide: BorderSide(color: t.muted),
        ),
      ),
      chipTheme: ChipThemeData(
        backgroundColor: t.soft,
        side: BorderSide(color: t.line),
      ),
    );
  }
}

extension PayeshThemeX on BuildContext {
  PayeshTokens get tokens =>
      Theme.of(this).extension<PayeshTokens>() ?? PayeshTokens.light;
}
