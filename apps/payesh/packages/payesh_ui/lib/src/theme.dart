import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'tokens.dart';

/// Light/dark themes of the native app, built only from [PayeshTokens].
abstract final class PayeshUi {
  /// The app is Persian and right-to-left on every platform.
  static const Locale locale = Locale('fa', 'IR');

  static ThemeData light({
    TargetPlatform? platform,
    PayeshLook look = PayeshLook.classic,
  }) => _build(
    PayeshTokens.of(look, Brightness.light),
    Brightness.light,
    platform,
  );

  static ThemeData dark({
    TargetPlatform? platform,
    PayeshLook look = PayeshLook.classic,
  }) =>
      _build(PayeshTokens.of(look, Brightness.dark), Brightness.dark, platform);

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
          seedColor: PayeshTokens.of(t.look, Brightness.light).primary,
          brightness: b,
        ).copyWith(
          primary: t.primary,
          onPrimary: t.isMinimal
              ? t.onPrimary
              : (b == Brightness.light
                    ? Colors.white
                    : const Color(0xFF0B1220)),
          tertiary: t.isMinimal ? t.accent : null,
          primaryContainer: t.isPanel ? t.soft : null,
          onPrimaryContainer: t.isPanel ? t.ink : null,
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
    final shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.all(Radius.circular(t.cardRadius)),
    );
    final onPrimary = t.isMinimal
        ? t.onPrimary
        : (b == Brightness.light ? Colors.white : const Color(0xFF0B1220));
    // Row 180 (design 2): buttons and inputs are radius 8, cards 10, dialogs 14.
    final small = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(t.isMinimal ? 8 : t.cardRadius),
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
        // «نبض»: layered surface with the soft teal glow (pulse.css `.card` → `--shadow`)
        elevation: t.isNabd ? 3 : 0,
        shadowColor: t.isNabd ? t.glow : null,
        surfaceTintColor: t.isPanel ? Colors.transparent : null,
        margin: EdgeInsets.zero,
        shape: shape.copyWith(side: BorderSide(color: t.line)),
      ),
      // «نبض»: the active item is filled with the primary colour and its icon is white
      // (owner-panel/web/app.css `.navitem.active`); classic keeps the Material defaults.
      navigationRailTheme: t.isPanel
          ? NavigationRailThemeData(
              backgroundColor: t.isMinimal ? t.navBg : t.card,
              indicatorColor: t.isMinimal ? t.soft : t.primary,
              selectedIconTheme: IconThemeData(
                color: t.isMinimal ? t.ink : onPrimary,
              ),
              unselectedIconTheme: IconThemeData(color: t.muted),
              selectedLabelTextStyle: TextStyle(
                color: t.isMinimal ? t.ink : t.primary,
                fontWeight: FontWeight.w700,
                fontFamily: PayeshTokens.fontFamily,
                package: PayeshTokens.fontPackage,
              ),
              unselectedLabelTextStyle: TextStyle(
                color: t.muted,
                fontFamily: PayeshTokens.fontFamily,
                package: PayeshTokens.fontPackage,
              ),
              indicatorShape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(
                  t.isMinimal ? 8 : PayeshTokens.radius,
                ),
              ),
            )
          : null,
      navigationDrawerTheme: t.isPanel
          ? NavigationDrawerThemeData(
              backgroundColor: t.isMinimal ? t.bg : t.card,
              indicatorColor: t.isMinimal ? t.soft : t.primary,
              indicatorShape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(
                  t.isMinimal ? 8 : PayeshTokens.radius,
                ),
              ),
              iconTheme: WidgetStateProperty.resolveWith(
                (s) => IconThemeData(
                  color: s.contains(WidgetState.selected)
                      ? (t.isMinimal ? t.ink : onPrimary)
                      : t.muted,
                ),
              ),
              labelTextStyle: WidgetStateProperty.resolveWith(
                (s) => TextStyle(
                  color: s.contains(WidgetState.selected)
                      ? (t.isMinimal ? t.ink : onPrimary)
                      : t.ink,
                  fontWeight: s.contains(WidgetState.selected)
                      ? FontWeight.w700
                      : FontWeight.w400,
                  fontFamily: PayeshTokens.fontFamily,
                  package: PayeshTokens.fontPackage,
                ),
              ),
            )
          : null,
      navigationBarTheme: t.isPanel
          ? NavigationBarThemeData(
              backgroundColor: t.isMinimal ? t.bg : t.card,
              indicatorColor: t.soft,
              surfaceTintColor: Colors.transparent,
              elevation: 0,
            )
          : null,
      appBarTheme: AppBarTheme(
        backgroundColor: t.isNabd
            ? t.card.withValues(alpha: 0.92)
            : (t.isMinimal ? t.bg : t.card),
        foregroundColor: t.ink,
        elevation: 0,
        scrolledUnderElevation: 1,
        centerTitle: false,
        // «نبض»: سرتیتر نوار بالا (pulse `.topbar h2`: 19px، پررنگ، فاصلهٔ حروف منفی)
        titleTextStyle: t.isPanel
            ? TextStyle(
                fontSize: t.isMinimal ? 17 : 19,
                fontWeight: t.isMinimal ? FontWeight.w700 : FontWeight.w800,
                letterSpacing: -0.2,
                color: t.ink,
                fontFamily: PayeshTokens.fontFamily,
                package: PayeshTokens.fontPackage,
              )
            : null,
        shape: t.isPanel ? Border(bottom: BorderSide(color: t.line)) : null,
      ),
      filledButtonTheme: FilledButtonThemeData(
        // «نبض»: دکمهٔ اصلی با سایهٔ درخشان (pulse `.btn.primary`)
        style: FilledButton.styleFrom(
          minimumSize: minButton,
          shape: t.isMinimal ? small : shape,
          backgroundColor: t.isMinimal ? t.primary : null,
          foregroundColor: t.isMinimal ? t.onPrimary : null,
          elevation: t.isNabd ? 2 : (t.isMinimal ? 0 : null),
          shadowColor: t.isNabd ? t.glow : null,
        ),
      ),
      // «نبض»: دیالوگ، کلید، نوار پیشرفت، جدول و راهنما با همان زبان بصری
      dialogTheme: t.isPanel
          ? DialogThemeData(
              backgroundColor: t.card,
              surfaceTintColor: Colors.transparent,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(t.cardRadius + 4),
                side: BorderSide(color: t.line),
              ),
            )
          : null,
      switchTheme: t.isPanel
          ? SwitchThemeData(
              trackColor: WidgetStateProperty.resolveWith(
                (s) => s.contains(WidgetState.selected)
                    ? (t.isMinimal ? t.ink : t.primary)
                    : t.soft,
              ),
              thumbColor: WidgetStateProperty.resolveWith(
                (s) => s.contains(WidgetState.selected)
                    ? (t.isMinimal ? t.card : onPrimary)
                    : t.muted,
              ),
              trackOutlineColor: WidgetStatePropertyAll(t.line),
            )
          : null,
      progressIndicatorTheme: t.isPanel
          ? ProgressIndicatorThemeData(
              color: t.isMinimal ? t.accent : t.primary,
              linearTrackColor: t.isMinimal ? t.track : t.soft,
            )
          : null,
      dividerTheme: t.isPanel ? DividerThemeData(color: t.line) : null,
      dataTableTheme: t.isPanel
          ? DataTableThemeData(
              headingTextStyle: TextStyle(
                color: t.muted,
                fontWeight: t.isMinimal ? FontWeight.w500 : FontWeight.w700,
                fontSize: t.isMinimal ? 11.5 : 12.5,
                fontFamily: PayeshTokens.fontFamily,
                package: PayeshTokens.fontPackage,
              ),
              dataTextStyle: TextStyle(
                color: t.ink,
                fontFeatures: const [FontFeature.tabularFigures()],
                fontFamily: PayeshTokens.fontFamily,
                package: PayeshTokens.fontPackage,
              ),
              dividerThickness: 1,
            )
          : null,
      tooltipTheme: t.isPanel
          ? TooltipThemeData(
              decoration: BoxDecoration(
                color: t.ink.withValues(alpha: 0.92),
                borderRadius: BorderRadius.circular(10),
              ),
              textStyle: TextStyle(
                color: t.card,
                fontSize: 12,
                fontFamily: PayeshTokens.fontFamily,
                package: PayeshTokens.fontPackage,
              ),
            )
          : null,
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: minButton,
          shape: t.isMinimal ? small : shape,
          foregroundColor: t.isMinimal ? t.ink : null,
          side: t.isMinimal ? BorderSide(color: t.line) : null,
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          minimumSize: minButton,
          foregroundColor: t.isMinimal ? t.link : null,
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: t.card,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(_fieldRadius(t)),
          borderSide: BorderSide(color: t.isMinimal ? t.line : t.muted),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(_fieldRadius(t)),
          borderSide: BorderSide(color: t.isMinimal ? t.line : t.muted),
        ),
        // «نبض»: focus ring in the primary colour (pulse.css `--ring`)
        focusedBorder: t.isPanel
            ? OutlineInputBorder(
                borderRadius: BorderRadius.circular(_fieldRadius(t)),
                borderSide: BorderSide(
                  color: t.isMinimal ? t.ink : t.primary,
                  width: t.isMinimal ? 1.5 : 2,
                ),
              )
            : null,
      ),
      chipTheme: ChipThemeData(
        backgroundColor: t.isMinimal ? t.card : t.soft,
        selectedColor: t.isMinimal ? t.primary : null,
        side: BorderSide(color: t.line),
        shape: t.isMinimal
            ? RoundedRectangleBorder(borderRadius: BorderRadius.circular(6))
            : null,
      ),
      sliderTheme: t.isMinimal
          ? SliderThemeData(
              trackHeight: 6,
              activeTrackColor: t.accent,
              inactiveTrackColor: t.track,
              thumbColor: t.card,
              overlayColor: t.accent.withValues(alpha: 0.12),
              tickMarkShape: SliderTickMarkShape.noTickMark,
              thumbShape: _RingThumb(t.accent, t.card),
            )
          : null,
    );
  }
}

double _fieldRadius(PayeshTokens t) => t.isMinimal
    ? PayeshTokens.radiusSmall
    : (t.isNabd ? PayeshTokens.radius - 2 : PayeshTokens.radiusSmall);

extension PayeshThemeX on BuildContext {
  PayeshTokens get tokens =>
      Theme.of(this).extension<PayeshTokens>() ?? PayeshTokens.light;
}

/// Row 180 (design 2): the slider thumb — an 18px disc in the card colour with a 2px violet ring.
class _RingThumb extends SliderComponentShape {
  const _RingThumb(this.ring, this.fill);
  final Color ring, fill;

  @override
  Size getPreferredSize(bool isEnabled, bool isDiscrete) => const Size(18, 18);

  @override
  void paint(
    PaintingContext context,
    Offset center, {
    required Animation<double> activationAnimation,
    required Animation<double> enableAnimation,
    required bool isDiscrete,
    required TextPainter labelPainter,
    required RenderBox parentBox,
    required SliderThemeData sliderTheme,
    required TextDirection textDirection,
    required double value,
    required double textScaleFactor,
    required Size sizeWithOverflow,
  }) {
    final c = context.canvas;
    c.drawCircle(center, 9, Paint()..color = fill);
    c.drawCircle(
      center,
      8,
      Paint()
        ..color = ring
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2,
    );
  }
}
