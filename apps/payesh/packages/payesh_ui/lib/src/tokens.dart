import 'package:flutter/material.dart';

/// Which visual language a native app wears.
///
/// * [classic] — the original Payesh tokens (client/styles.css).
/// * [nabd] — «نبض», the user panel's design system (client/pulse.css): teal primary, layered
///   surfaces with a soft teal glow, radius 18, numbers in the primary colour. The native owner
///   panel uses it (row 147) so it looks like the user panel and like the owner web panel
///   (apps/owner-panel/web/app.css). Light colours that fail AA in pulse.css are darkened here
///   (see a11y_contrast_test.dart): muted #5d7d76 → #4f6f68, text/filled primary #0d9488 →
///   #0f766e (#0d9488 stays as the gradient start only).
enum PayeshLook { classic, nabd }

/// Design tokens of the Payesh design system. Colours are the web client's CSS variables
/// (client/styles.css `:root` and its `prefers-color-scheme: dark` block, or client/pulse.css for
/// [PayeshLook.nabd]), so both clients look the same; spacing / radius / type scale / breakpoints
/// are shared by every widget.
@immutable
final class PayeshTokens extends ThemeExtension<PayeshTokens> {
  const PayeshTokens({
    required this.bg,
    required this.card,
    required this.ink,
    required this.muted,
    required this.line,
    required this.primary,
    required this.soft,
    required this.success,
    required this.successBg,
    required this.danger,
    required this.dangerBg,
    required this.warning,
    required this.warningBg,
    required this.info,
    required this.infoBg,
    this.look = PayeshLook.classic,
    Color? primary2,
    Color? glow,
    this.accent = const Color(0xFFF59E0B),
  }) : primary2 = primary2 ?? primary,
       glow = glow ?? const Color(0x00000000);

  static const PayeshTokens light = PayeshTokens(
    bg: Color(0xFFF4F6FA),
    card: Color(0xFFFFFFFF),
    ink: Color(0xFF0F172A),
    muted: Color(
      0xFF5F6F86,
    ), // web #64748b is 4.40:1 on --bg; darkened to pass AA
    line: Color(0xFFE2E8F0),
    primary: Color(0xFF1E3A8A),
    soft: Color(0xFFEEF3FF),
    success: Color(0xFF0F766E),
    successBg: Color(0xFFE7F7F3),
    danger: Color(0xFFB42318),
    dangerBg: Color(0xFFFEE4E2),
    warning: Color(0xFFB45309),
    warningBg: Color(0xFFFEF3E2),
    info: Color(0xFF6D28D9),
    infoBg: Color(0xFFF3ECFF),
  );

  /// Dark: web dark surfaces; foreground accents lifted so text keeps ≥ 4.5:1 (see a11y tests).
  static const PayeshTokens dark = PayeshTokens(
    bg: Color(0xFF0B1220),
    card: Color(0xFF121B2E),
    ink: Color(0xFFE5EAF3),
    muted: Color(0xFF9AA8BF),
    line: Color(0xFF22304A),
    primary: Color(0xFF8FB4FF),
    soft: Color(0xFF16223A),
    success: Color(0xFF5EEAD4),
    successBg: Color(0xFF0D2F2A),
    danger: Color(0xFFFDA29B),
    dangerBg: Color(0xFF3A1715),
    warning: Color(0xFFFCC97A),
    warningBg: Color(0xFF3A2A12),
    info: Color(0xFFC4B5FD),
    infoBg: Color(0xFF241A3D),
  );

  /// «نبض» (client/pulse.css) — light. `--primary #0d9488` is the gradient start ([primary2]);
  /// text, links and filled buttons use `--primary-2 #0f766e` so they pass AA on every surface.
  static const PayeshTokens nabdLight = PayeshTokens(
    look: PayeshLook.nabd,
    bg: Color(0xFFEEF7F5),
    card: Color(0xFFFFFFFF),
    ink: Color(0xFF0F2B27),
    muted: Color(
      0xFF4F6F68,
    ), // pulse #5d7d76 is 4.33:1 on --bg; darkened to pass AA
    line: Color(0xFFD7EBE6),
    primary: Color(0xFF0F766E),
    primary2: Color(0xFF0D9488),
    soft: Color(0xFFDCF4EE),
    success: Color(0xFF0F766E),
    successBg: Color(0xFFE2F6F1),
    danger: Color(0xFFB42318),
    dangerBg: Color(0xFFFEE4E2),
    warning: Color(0xFFB45309),
    warningBg: Color(0xFFFEF3E2),
    info: Color(0xFF6D28D9),
    infoBg: Color(0xFFF3ECFF),
    glow: Color(0x1A0D9488), // --shadow rgba(13,148,136,.10)
  );

  /// «نبض» — dark (pulse.css `prefers-color-scheme: dark`); filled buttons get dark ink.
  static const PayeshTokens nabdDark = PayeshTokens(
    look: PayeshLook.nabd,
    bg: Color(0xFF07110F),
    card: Color(0xFF0E1D1A),
    ink: Color(0xFFE6F5F0),
    muted: Color(0xFF91B1A8),
    line: Color(0xFF203B35),
    primary: Color(0xFF14B8A6),
    primary2: Color(0xFF2DD4BF),
    soft: Color(0xFF122724),
    success: Color(0xFF5EEAD4),
    successBg: Color(0xFF0C2B25),
    danger: Color(0xFFFDA29B),
    dangerBg: Color(0xFF3A1715),
    warning: Color(0xFFFCC97A),
    warningBg: Color(0xFF3A2A12),
    info: Color(0xFFC4B5FD),
    infoBg: Color(0xFF241A3D),
    glow: Color(0x47000000), // --shadow rgba(0,0,0,.28)
  );

  /// Tokens of [look] for [brightness].
  static PayeshTokens of(PayeshLook look, Brightness brightness) =>
      switch ((look, brightness)) {
        (PayeshLook.nabd, Brightness.light) => nabdLight,
        (PayeshLook.nabd, Brightness.dark) => nabdDark,
        (_, Brightness.light) => light,
        (_, Brightness.dark) => dark,
      };

  final PayeshLook look;

  /// Second gradient stop (`--primary` → `--primary-2` in pulse.css); = [primary] for classic.
  final Color primary2;

  /// Card glow (pulse.css `--shadow`); transparent for classic (flat cards with a border).
  final Color glow;

  /// Warm accent (pulse.css `--accent`), used only for the background wash.
  final Color accent;

  bool get isNabd => look == PayeshLook.nabd;

  /// Card / button radius: 18 for «نبض» (`--radius: 18px`), [radius] otherwise.
  double get cardRadius => isNabd ? 18 : radius;

  /// The active-item / primary-button gradient of the web panels.
  LinearGradient get primaryGradient => LinearGradient(
    begin: AlignmentDirectional.topStart,
    end: AlignmentDirectional.bottomEnd,
    colors: isNabd ? [primary2, primary] : [primary, primary],
  );

  final Color bg, card, ink, muted, line, primary, soft;
  final Color success,
      successBg,
      danger,
      dangerBg,
      warning,
      warningBg,
      info,
      infoBg;

  // ── scale (logical pixels) ─────────────────────────────────────────────
  static const double space1 = 4,
      space2 = 8,
      space3 = 12,
      space4 = 16,
      space5 = 24,
      space6 = 32;
  static const double radius = 14, radiusSmall = 8;

  /// Minimum interactive size (Material / WCAG 2.5.5 target size), both platforms.
  static const double minTouchTarget = 48;

  /// Width breakpoints: phone (Android) → compact; tablet / small window → medium;
  /// Windows desktop window → expanded (navigation rail instead of a bottom bar).
  static const double compactMax = 600, mediumMax = 840;

  static const String fontFamily = 'Vazirmatn';
  static const String fontPackage = 'payesh_ui';

  @override
  PayeshTokens copyWith({Color? primary, Color? bg}) => PayeshTokens(
    bg: bg ?? this.bg,
    card: card,
    ink: ink,
    muted: muted,
    line: line,
    primary: primary ?? this.primary,
    soft: soft,
    success: success,
    successBg: successBg,
    danger: danger,
    dangerBg: dangerBg,
    warning: warning,
    warningBg: warningBg,
    info: info,
    infoBg: infoBg,
    look: look,
    primary2: primary2,
    glow: glow,
    accent: accent,
  );

  @override
  PayeshTokens lerp(PayeshTokens? other, double t) {
    if (other == null) return this;
    Color l(Color a, Color b) => Color.lerp(a, b, t)!;
    return PayeshTokens(
      bg: l(bg, other.bg),
      card: l(card, other.card),
      ink: l(ink, other.ink),
      muted: l(muted, other.muted),
      line: l(line, other.line),
      primary: l(primary, other.primary),
      soft: l(soft, other.soft),
      success: l(success, other.success),
      successBg: l(successBg, other.successBg),
      danger: l(danger, other.danger),
      dangerBg: l(dangerBg, other.dangerBg),
      warning: l(warning, other.warning),
      warningBg: l(warningBg, other.warningBg),
      info: l(info, other.info),
      infoBg: l(infoBg, other.infoBg),
      look: t < 0.5 ? look : other.look,
      primary2: l(primary2, other.primary2),
      glow: l(glow, other.glow),
      accent: l(accent, other.accent),
    );
  }
}

/// Semantic status used by badges / banners; maps to a (foreground, background) token pair.
enum PayeshTone { neutral, success, danger, warning, info }

extension PayeshToneColors on PayeshTokens {
  (Color, Color) tone(PayeshTone t) => switch (t) {
    PayeshTone.neutral => (ink, soft),
    PayeshTone.success => (success, successBg),
    PayeshTone.danger => (danger, dangerBg),
    PayeshTone.warning => (warning, warningBg),
    PayeshTone.info => (info, infoBg),
  };
}

/// Window size class from the shared breakpoints.
enum SizeClass { compact, medium, expanded }

SizeClass sizeClassOf(double width) => width < PayeshTokens.compactMax
    ? SizeClass.compact
    : width < PayeshTokens.mediumMax
    ? SizeClass.medium
    : SizeClass.expanded;
