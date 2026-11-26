// Row 172 — the web panel's own building blocks, 1:1 in Flutter. The owner asked for the user
// panel of the installed apps to be EXACTLY the old web panel, nothing changed. Every size,
// colour and spacing below is copied from client/styles.css + client/pulse.css (light theme),
// and the icons are the SVG shapes of client/pulse.js (ICON_SHAPES) drawn stroke-for-stroke.
//
//   .card .btn(.primary/.ghost/.sm/.xs/.danger) .badge(.green/.red/.amber/.purple) .item .list
//   table/th/td .table-wrap .topbar(h2) .nowchip .stat .grid .banner .updbar .pill-tabs .field
//   .input .sidebar .navitem(.on) .navgroup .main
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:payesh_ui/payesh_ui.dart';

/// Row 179: the palette the web-parity widgets paint with. It follows the app's look
/// («مینیمال حرفه‌ای» by default) and brightness (روشن / تاریک) — [Web.use] is called from the
/// app root whenever the theme changes. Before row 179 these were `const` teal values of
/// client/pulse.css (light only); [WebPalette.nabdLight] keeps them for comparison tests.
@immutable
final class WebPalette {
  const WebPalette({
    required this.primary,
    required this.primary2,
    required this.bg,
    required this.card,
    required this.ink,
    required this.muted,
    required this.line,
    required this.soft,
    required this.accent,
    required this.green,
    required this.greenBg,
    required this.red,
    required this.redBg,
    required this.amber,
    required this.amberBg,
    required this.purple,
    required this.purpleBg,
    required this.deleteInk,
    required this.shadow,
    required this.flat,
    required this.onPrimary,
    Color? ink2,
    Color? navBg,
    Color? track,
    Color? link,
    Color? frame,
  }) : ink2 = ink2 ?? ink,
       frame = frame ?? line,
       navBg = navBg ?? card,
       track = track ?? line,
       link = link ?? primary;

  /// Row 180 (design 2): secondary text, the sidebar surface, slider/ring track, links.
  final Color ink2, navBg, track, link;

  /// Row 190: the outline of a card / section — a step darker than the inner hairlines.
  final Color frame;

  final Color primary, primary2, bg, card, ink, muted, line, soft, accent;
  final Color green, greenBg, red, redBg, amber, amberBg, purple, purpleBg;
  final Color deleteInk, onPrimary;
  final List<BoxShadow> shadow;

  /// No gradients (a flat accent fill), as in «مینیمال».
  final bool flat;

  /// The old «نبض» light palette (client/pulse.css `:root`).
  static const nabdLight = WebPalette(
    primary: Color(0xFF0D9488),
    primary2: Color(0xFF0F766E),
    bg: Color(0xFFEEF7F5),
    card: Color(0xFFFFFFFF),
    ink: Color(0xFF0F2B27),
    muted: Color(0xFF5D7D76),
    line: Color(0xFFD7EBE6),
    soft: Color(0xFFDCF4EE),
    accent: Color(0xFFF59E0B),
    green: Color(0xFF0F766E),
    greenBg: Color(0xFFE2F6F1),
    red: Color(0xFFB42318),
    redBg: Color(0xFFFEE4E2),
    amber: Color(0xFFB45309),
    amberBg: Color(0xFFFEF3E2),
    purple: Color(0xFF6D28D9),
    purpleBg: Color(0xFFF3ECFF),
    deleteInk: Color(0xFFB91C1C),
    onPrimary: Color(0xFFFFFFFF),
    flat: false,
    shadow: [
      BoxShadow(
        color: Color(0x1A0D9488),
        offset: Offset(0, 10),
        blurRadius: 25,
        spreadRadius: -5,
      ),
      BoxShadow(
        color: Color(0x1A0D9488),
        offset: Offset(0, 8),
        blurRadius: 10,
        spreadRadius: -6,
      ),
    ],
  );

  /// From the app's design tokens (row 179: every look, both brightnesses).
  factory WebPalette.fromTokens(PayeshTokens t, Brightness b) {
    if (t.isNabd && b == Brightness.light) return nabdLight;
    final dark = b == Brightness.dark;
    return WebPalette(
      primary: t.isNabd ? t.primary2 : t.primary,
      primary2: t.isNabd ? t.primary : t.primary,
      bg: t.bg,
      card: t.card,
      ink: t.ink,
      muted: t.muted,
      line: t.line,
      soft: t.soft,
      accent: t.accent,
      green: t.success,
      greenBg: t.successBg,
      red: t.danger,
      redBg: t.dangerBg,
      amber: t.warning,
      amberBg: t.warningBg,
      purple: t.info,
      purpleBg: t.infoBg,
      deleteInk: t.danger,
      onPrimary: t.isMinimal
          ? t.onPrimary
          : (dark ? const Color(0xFF0B1220) : const Color(0xFFFFFFFF)),
      ink2: t.ink2,
      navBg: t.navBg,
      track: t.track,
      link: t.link,
      frame: t.frame,
      flat: !t.isNabd,
      shadow: t.isMinimal
          // row 190: a faint lift under the light cards (none in dark — the frame carries it)
          ? (dark
                ? const <BoxShadow>[]
                : const [
                    BoxShadow(
                      color: Color(0x0F000000),
                      offset: Offset(0, 1),
                      blurRadius: 3,
                    ),
                    BoxShadow(
                      color: Color(0x0A000000),
                      offset: Offset(0, 1),
                      blurRadius: 2,
                      spreadRadius: -1,
                    ),
                  ])
          : dark || !t.isNabd
          ? (dark
                ? const <BoxShadow>[]
                : const [
                    BoxShadow(
                      color: Color(0x0D000000),
                      offset: Offset(0, 1),
                      blurRadius: 2,
                    ),
                  ])
          : nabdLight.shadow,
    );
  }
}

/// The web panel's building blocks (client/styles.css + client/pulse.css), painted with the
/// current [WebPalette].
abstract final class Web {
  static WebPalette _p = WebPalette.fromTokens(
    PayeshTokens.minimalLight,
    Brightness.light,
  );

  /// The palette now in use.
  static WebPalette get palette => _p;

  /// Called from the app root on every theme change (look + brightness).
  static void use(WebPalette p) => _p = p;

  static Color get primary => _p.primary;
  static Color get primary2 => _p.primary2;
  static Color get bg => _p.bg;
  static Color get card => _p.card;
  static Color get ink => _p.ink;
  static Color get muted => _p.muted;
  static Color get line => _p.line;

  /// Row 190: card / section outline.
  static Color get frame => _p.frame;
  static Color get soft => _p.soft;
  static Color get accent => _p.accent;
  static Color get green => _p.green;
  static Color get greenBg => _p.greenBg;
  static Color get red => _p.red;
  static Color get redBg => _p.redBg;
  static Color get amber => _p.amber;
  static Color get amberBg => _p.amberBg;
  static Color get purple => _p.purple;
  static Color get purpleBg => _p.purpleBg;
  static Color get ink2 => _p.ink2;
  static Color get navBg => _p.navBg;
  static Color get track => _p.track;
  static Color get link => _p.link;

  /// Row 180: design 2 «مینیمال حرفه‌ای» as drawn (flat, hairlines, radius 8/10, outlined pills).
  static bool get d2 => _p.flat;

  /// Dark mode (روشن / تاریک).
  static bool get dark => _p.card.computeLuminance() < 0.2;

  /// Text / icons on a filled [primary] button.
  static Color get onPrimary => _p.onPrimary;

  /// `style="color:#b91c1c"` of the web «حذف» buttons.
  static Color get deleteInk => _p.deleteInk;

  /// `--radius`.
  /// pulse.css `.stat .num, .num, td, th, .badge, .nabd-num, .att-count, .updbar b {
  /// font-feature-settings:"tnum","ss01"}` — Vazirmatn's ss01 draws 0–9 as Persian digits.
  static const numFeatures = [
    FontFeature.tabularFigures(),
    FontFeature('ss01'),
  ];

  static double get radius => _p.flat ? 10.0 : 18.0;

  /// `body{font-size:15px;line-height:1.7}`.
  static const fontSize = 15.0;
  static const lineHeight = 1.7;

  /// `--shadow` (none / hairline for «مینیمال»).
  static List<BoxShadow> get shadow => _p.shadow;

  /// `linear-gradient(135deg, var(--primary), var(--primary-2))` (.btn.primary, .navitem.on);
  /// a flat fill for «مینیمال».
  static LinearGradient get gradient => LinearGradient(
    begin: AlignmentDirectional.topStart,
    end: AlignmentDirectional.bottomEnd,
    colors: [primary, _p.flat ? primary : primary2],
  );

  /// `<div class="small muted">` (styles.css `.small{font-size:12.5px}`).
  static TextStyle get small =>
      TextStyle(fontSize: 12.5, color: muted, height: lineHeight);

  /// `<b>` card titles.
  static TextStyle get b => TextStyle(
    fontSize: fontSize,
    fontWeight: FontWeight.w700,
    color: ink,
    height: lineHeight,
  );

  /// client/app.js `J_DAYS` (Saturday first).
  static const jDays = [
    'شنبه',
    'یک‌شنبه',
    'دوشنبه',
    'سه‌شنبه',
    'چهارشنبه',
    'پنج‌شنبه',
    'جمعه',
  ];

  /// client/app.js `jdate(iso)`: «20 آبان 1405» (Latin digits — the web prints it without
  /// `fa()`; wrap it in [fa] where the web does).
  static String jdate(String? iso) {
    final j = JalaliDate.fromIso(iso);
    if (j == null) return '—';
    return '${j.day} ${jalaliMonths[j.month - 1]} ${j.year}';
  }

  /// client/app.js `clock24`: «8:5» → «08:05».
  static String clock24(String v) {
    final m = RegExp(r'^(\d{1,2}):(\d{2})$').firstMatch(latinDigits(v).trim());
    if (m == null) return v;
    final h = int.parse(m[1]!), mi = int.parse(m[2]!);
    return h <= 23 && mi <= 59
        ? '${'$h'.padLeft(2, '0')}:${'$mi'.padLeft(2, '0')}'
        : v;
  }

  /// Persian digits, as the web `fa()`.
  static String fa(Object? v) => faDigits(v);

  /// `new Date().toLocaleDateString('fa-IR', {weekday:'long', day:'numeric', month:'long'})`
  /// — e.g. «پنجشنبه ۲۱ آبان» (ICU spells the week days without the half-space).
  static String todayChip(DateTime d) {
    const days = [
      'دوشنبه',
      'سه‌شنبه',
      'چهارشنبه',
      'پنجشنبه',
      'جمعه',
      'شنبه',
      'یکشنبه',
    ];
    final j = JalaliDate.fromDateTime(d);
    return '${days[d.weekday - 1]} ${faDigits(j.day)} ${jalaliMonths[j.month - 1]}';
  }
}

/// The page clock (tests inject a fixed «today»; the app uses the device clock).
class WebClock extends InheritedWidget {
  const WebClock({super.key, required this.now, required super.child});
  final DateTime Function() now;

  static DateTime of(BuildContext context) =>
      (context.dependOnInheritedWidgetOfExactType<WebClock>()?.now ??
      DateTime.now)();

  @override
  bool updateShouldNotify(WebClock oldWidget) => oldWidget.now != now;
}

/// Base text of the web body (Vazirmatn 15px, line-height 1.7, `--ink`).
class WebText extends StatelessWidget {
  const WebText({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => DefaultTextStyle.merge(
    style: TextStyle(
      fontSize: Web.fontSize,
      height: Web.lineHeight,
      color: Web.ink,
    ),
    child: child,
  );
}

/// `body` background of pulse.css: two soft radial glows over `--bg`.
class WebBackdrop extends StatelessWidget {
  const WebBackdrop({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => DecoratedBox(
    decoration: BoxDecoration(color: Web.bg),
    // Row 179 «مینیمال»: a plain surface (no washes)
    child: Web.palette.flat
        ? child
        : CustomPaint(painter: _BackdropPainter(), child: child),
  );
}

class _BackdropPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    // radial-gradient(at 0% 0%, rgba(20,184,166,.08) 0, transparent 48%) — "0% 0%" is the
    // top-left corner of the page; the 48% stop is of the farthest-corner distance.
    final far = math.sqrt(size.width * size.width + size.height * size.height);
    void glow(Offset at, Color c, double stop) {
      final r = far * stop;
      if (r <= 0) return;
      canvas.drawRect(
        Offset.zero & size,
        Paint()
          ..shader = RadialGradient(colors: [c, c.withValues(alpha: 0)])
              .createShader(Rect.fromCircle(center: at, radius: r)),
      );
    }

    glow(Offset.zero, const Color(0x1414B8A6), 0.48);
    glow(Offset(size.width, size.height), const Color(0x0FF59E0B), 0.45);
  }

  @override
  bool shouldRepaint(_BackdropPainter oldDelegate) => false;
}

/// `.card` — white, 1px `--line`, radius 18, padding 14, `--shadow`, 12px under it.
class WebCard extends StatelessWidget {
  const WebCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(14),
    this.margin = const EdgeInsets.only(bottom: 12),
    this.center = false,
  });

  /// `.card.tight` = padding 10.
  const WebCard.tight({
    super.key,
    required this.child,
    this.margin = const EdgeInsets.only(bottom: 12),
  }) : padding = const EdgeInsets.all(10),
       center = false;

  final Widget child;
  final EdgeInsetsGeometry padding;
  final EdgeInsetsGeometry margin;
  final bool center;

  @override
  Widget build(BuildContext context) => Padding(
    padding: margin,
    child: Container(
      // design 2: `.card{padding:16px 18px}`
      padding: Web.d2 && padding == const EdgeInsets.all(14)
          ? const EdgeInsets.symmetric(horizontal: 18, vertical: 16)
          : padding,
      decoration: BoxDecoration(
        color: Web.card,
        border: Border.all(color: Web.frame),
        borderRadius: BorderRadius.circular(Web.radius),
        boxShadow: Web.shadow,
      ),
      child: center ? Center(child: child) : child,
    ),
  );
}

/// `empty(msg)` = `<div class="card center muted" style="padding:26px">`.
class WebEmpty extends StatelessWidget {
  const WebEmpty(this.message, {super.key});
  final String message;

  @override
  Widget build(BuildContext context) => WebCard(
    padding: const EdgeInsets.all(26),
    child: Text(
      message,
      textAlign: TextAlign.center,
      style: TextStyle(color: Web.muted),
    ),
  );
}

/// `<div class="row between" style="margin-bottom:8px"><b>title</b> … actions</div>` — the
/// head row of a card: the title on the right, the actions on the left.
class WebCardHead extends StatelessWidget {
  const WebCardHead({
    super.key,
    required this.title,
    this.icon,
    this.actions = const [],
    this.bottom = 8,
  });
  final String title;

  /// An emoji in the web title that pulse.js swaps for nothing (only `.ico`/nav spans are
  /// swapped), so the emoji stays: «🏫 کلاس‌ها و کارگاه‌ها».
  final String? icon;
  final List<Widget> actions;
  final double bottom;

  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.only(bottom: bottom),
    child: Wrap(
      alignment: WrapAlignment.spaceBetween,
      crossAxisAlignment: WrapCrossAlignment.center,
      spacing: 9.6,
      runSpacing: 9.6,
      children: [
        Text(
          icon == null ? title : '$icon $title',
          style: Web.d2 ? Web.b.copyWith(fontSize: 14) : Web.b,
        ),
        if (actions.isNotEmpty)
          Wrap(
            spacing: 6,
            runSpacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: actions,
          ),
      ],
    ),
  );
}

enum WebBtnKind { normal, primary, ghost, danger }

enum WebBtnSize { normal, sm, xs }

/// `.btn` with its variants.
class WebBtn extends StatefulWidget {
  const WebBtn(
    this.label, {
    super.key,
    this.onPressed,
    this.kind = WebBtnKind.normal,
    this.size = WebBtnSize.sm,
    this.color,
    this.icon,
    this.block = false,
    this.background,
  });

  /// `class="btn sm ghost" style="color:#b91c1c"` — the red «حذف» of the lists.
  WebBtn.delete(
    this.label, {
    super.key,
    this.onPressed,
    this.size = WebBtnSize.sm,
  }) : kind = WebBtnKind.ghost,
       color = Web.deleteInk,
       icon = null,
       block = false,
       background = null;

  final String label;
  final VoidCallback? onPressed;
  final WebBtnKind kind;
  final WebBtnSize size;
  final Color? color;
  final String? icon;
  final bool block;

  /// An inline `style="background:…"` (e.g. the red bulk-delete button).
  final Color? background;

  @override
  State<WebBtn> createState() => _WebBtnState();
}

class _WebBtnState extends State<WebBtn> {
  bool _hover = false;
  bool _down = false;

  @override
  Widget build(BuildContext context) {
    final w = widget;
    final primary = w.kind == WebBtnKind.primary;
    final enabled = w.onPressed != null;
    final d2 = Web.d2;
    final (minH, pad, font, radius0) = switch (w.size) {
      // .btn{padding:.6rem 1rem;min-height:42px;border-radius:11px}
      WebBtnSize.normal => (
        42.0,
        const EdgeInsets.symmetric(horizontal: 16, vertical: 9.6),
        Web.fontSize,
        11.0,
      ),
      // .btn.sm{min-height:34px;padding:.3rem .7rem;font-size:13px;border-radius:9px}
      WebBtnSize.sm => (
        34.0,
        const EdgeInsets.symmetric(horizontal: 11.2, vertical: 4.8),
        13.0,
        9.0,
      ),
      // .updbar .btn.xs{padding:3px 9px;font-size:.75rem;border-radius:8px} (min-height 42 stays)
      WebBtnSize.xs => (
        42.0,
        const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
        12.0,
        8.0,
      ),
    };
    // design 2: every button is radius 8, flat, 13.5px w600
    final radius = d2 ? 8.0 : radius0;
    final fg =
        w.color ??
        switch (w.kind) {
          WebBtnKind.primary => Web.onPrimary,
          WebBtnKind.danger => Web.red,
          _ => Web.ink,
        };
    final border =
        w.background ??
        switch (w.kind) {
          WebBtnKind.primary => Web.primary,
          WebBtnKind.danger => Web.red.withValues(alpha: 0.4),
          _ => Web.line,
        };
    final bg = primary
        ? null
        : w.background != null
        ? w.background!
        : (_hover && enabled)
        ? Web.soft
        : w.kind == WebBtnKind.ghost
        ? Colors.transparent
        : Web.card;
    final body = Container(
      constraints: BoxConstraints(minHeight: minH),
      padding: pad,
      decoration: BoxDecoration(
        color: d2 && primary
            ? (_hover ? Web.primary.withValues(alpha: 0.88) : Web.primary)
            : bg,
        gradient: primary && !d2
            ? (_hover
                  ? LinearGradient(
                      begin: AlignmentDirectional.topStart,
                      end: AlignmentDirectional.bottomEnd,
                      colors: [
                        Web.primary2,
                        Web.palette.flat
                            ? Web.primary2
                            : const Color(0xFF115E59),
                      ],
                    )
                  : Web.gradient)
            : null,
        border: Border.all(color: border),
        borderRadius: BorderRadius.circular(radius),
        boxShadow: primary && !d2
            ? [
                BoxShadow(
                  color: Web.primary.withValues(alpha: 0.58),
                  offset: Offset(0, 7),
                  blurRadius: 18,
                  spreadRadius: -7,
                ),
              ]
            : null,
      ),
      child: Row(
        mainAxisSize: w.block ? MainAxisSize.max : MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          if (w.icon case final i?) ...[
            WebIcon(i, size: 17, color: fg),
            const SizedBox(width: 6.4),
          ],
          Flexible(
            child: Text(
              w.label,
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: d2 && w.size == WebBtnSize.normal ? 13.5 : font,
                fontWeight: d2 ? FontWeight.w500 : FontWeight.w600,
                color: fg,
                height: Web.lineHeight,
              ),
            ),
          ),
        ],
      ),
    );
    return Semantics(
      button: true,
      enabled: enabled,
      child: MouseRegion(
        cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
        onEnter: (_) => setState(() => _hover = true),
        onExit: (_) => setState(() => _hover = false),
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTapDown: enabled ? (_) => setState(() => _down = true) : null,
          onTapCancel: () => setState(() => _down = false),
          onTapUp: (_) => setState(() => _down = false),
          onTap: w.onPressed,
          child: AnimatedScale(
            // .btn:active{transform:scale(.965)}
            scale: _down ? 0.965 : 1,
            duration: const Duration(milliseconds: 80),
            child: Opacity(opacity: enabled ? 1 : 0.55, child: body),
          ),
        ),
      ),
    );
  }
}

enum WebTone { none, green, red, amber, purple }

/// `.badge` (pill, 11.5px).
class WebBadge extends StatelessWidget {
  const WebBadge(this.text, {super.key, this.tone = WebTone.none, this.size});
  final String text;
  final WebTone tone;

  /// `.dashboard-coverage-grid .dashboard-table .badge{font-size:10px}`.
  final double? size;

  @override
  Widget build(BuildContext context) {
    final (bg, fg) = switch (tone) {
      WebTone.none => (Web.soft, Web.muted),
      WebTone.green => (Web.greenBg, Web.green),
      WebTone.red => (Web.redBg, Web.red),
      WebTone.amber => (Web.amberBg, Web.amber),
      WebTone.purple => (Web.purpleBg, Web.purple),
    };
    if (Web.d2) {
      // design 2: an outlined pill — a 6px dot in the status colour, ink2 text
      return Container(
        padding: EdgeInsets.symmetric(
          horizontal: size == null ? 9 : 6,
          vertical: size == null ? 1 : 0,
        ),
        decoration: BoxDecoration(
          border: Border.all(color: Web.line),
          borderRadius: BorderRadius.circular(999),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 6,
              height: 6,
              decoration: BoxDecoration(
                color: tone == WebTone.none ? Web.muted : fg,
                shape: BoxShape.circle,
              ),
            ),
            SizedBox(width: size == null ? 6 : 4),
            Flexible(
              child: Text(
                text,
                style: TextStyle(
                  fontSize: size ?? 12,
                  fontWeight: FontWeight.w500,
                  color: Web.ink2,
                  height: Web.lineHeight,
                  fontFeatures: Web.numFeatures,
                ),
              ),
            ),
          ],
        ),
      );
    }
    return Container(
      padding: size == null
          ? const EdgeInsets.symmetric(horizontal: 8, vertical: 2)
          : const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        text,
        style: TextStyle(
          fontSize: size ?? 11.5,
          color: fg,
          height: Web.lineHeight,
          fontFeatures: Web.numFeatures,
        ),
      ),
    );
  }
}

/// `.item` — a bordered row: `.t` title + `.s` line on the right (grow), actions on the left.
class WebItem extends StatelessWidget {
  const WebItem({
    super.key,
    required this.title,
    this.titleTrailing = const [],
    this.sub,
    this.subWidget,
    this.leading,
    this.actions = const [],
    this.onTap,
    this.titleColor,
  });
  final String title;

  /// `a.item` rows take the link colour (`a{color:var(--primary)}`).
  final Color? titleColor;

  /// Badges after the title (`… <span class="badge purple">کارگاهی</span>`).
  final List<Widget> titleTrailing;
  final String? sub;
  final Widget? subWidget;
  final Widget? leading;
  final List<Widget> actions;
  final VoidCallback? onTap;

  /// Row 185: the actions sit next to the content and wrap (never overflow) in a narrow column.
  Widget _withActions(Widget main) => actions.isEmpty
      ? main
      : TrailingRow(
          main: main,
          trailing: SpacedWrap(spacing: 4, runSpacing: 4, children: actions),
        );

  @override
  Widget build(BuildContext context) {
    final body = Container(
      padding: const EdgeInsets.symmetric(horizontal: 11.2, vertical: 10.4),
      decoration: BoxDecoration(
        color: Web.card,
        border: Border.all(color: Web.line),
        borderRadius: BorderRadius.circular(Web.d2 ? 8 : 12),
      ),
      child: _withActions(
        Row(
          children: [
            if (leading != null) ...[leading!, const SizedBox(width: 9.6)],
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Wrap(
                    spacing: 4,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      Text(
                        title,
                        style: TextStyle(
                          fontWeight: FontWeight.w600,
                          fontSize: 14,
                          height: Web.lineHeight,
                          color: titleColor,
                        ),
                      ),
                      ...titleTrailing,
                    ],
                  ),
                  if (subWidget != null)
                    subWidget!
                  else if (sub case final s?)
                    Text(
                      s,
                      style: TextStyle(
                        fontSize: 12,
                        color: Web.muted,
                        height: Web.lineHeight,
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
    return onTap == null
        ? body
        : MouseRegion(
            cursor: SystemMouseCursors.click,
            child: GestureDetector(onTap: onTap, child: body),
          );
  }
}

/// `.list` — items 8px apart. Row 185: on a wide card the items sit side by side in columns of
/// at least [kListColumnMin] (a row is never a long empty stretch between its name and buttons).
class WebList extends StatelessWidget {
  const WebList({super.key, required this.children});
  final List<Widget> children;

  /// Narrowest column of a wide list.
  static const double kListColumnMin = 300;

  Widget _column(List<Widget> items) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      for (final (i, c) in items.indexed) ...[
        if (i > 0) const SizedBox(height: 8),
        c,
      ],
    ],
  );

  @override
  Widget build(BuildContext context) => children.length < 2
      ? _column(children)
      : LayoutBuilder(
          builder: (context, box) {
            final n = box.maxWidth.isFinite
                ? flowColumnsFor(
                    box.maxWidth,
                    min: kListColumnMin,
                    max: 4,
                    gap: 8,
                  )
                : 1;
            if (n == 1) return _column(children);
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (var i = 0; i < children.length; i += n) ...[
                  if (i > 0) const SizedBox(height: 8),
                  WebEqualRow(
                    gap: 8,
                    children: [
                      for (var j = i; j < i + n; j++)
                        j < children.length
                            ? children[j]
                            : const SizedBox.shrink(),
                    ],
                  ),
                ],
              ],
            );
          },
        );
}

/// `table` inside `.table-wrap`: th soft + bold 12px, td 13.5px, padding .5rem .45rem, a line
/// under every row except the last. Columns size like an HTML auto table: each gets its widest
/// cell, and the rest of the width is shared in proportion to those widths.
class WebTable extends StatelessWidget {
  const WebTable({
    super.key,
    required this.head,
    required this.rows,
    this.fontSize = 13.5,
    this.rowColor,
    this.minWidth,
    this.fixed,
    this.cellPadding = const EdgeInsets.symmetric(horizontal: 7.2, vertical: 8),
    this.bordered = false,
    this.headCells = const {},
    this.widths = const {},
    this.empty,
    this.headless = false,
    this.stretch = false,
  });

  /// Row 185: a table is as wide as its columns need and sits at the start of the line — no
  /// empty stretches between a name and its buttons. [stretch] keeps the old full width (the
  /// dashboard's coverage tables).
  final bool stretch;

  /// A `<table><tbody>` with no `<thead>` (e.g. the record's «مشخصات»).
  final bool headless;

  /// `<tr><td colspan="N" class="muted">…</td></tr>` shown when [rows] is empty.
  final Widget? empty;
  final List<String> head;

  /// Header cells that are not text (e.g. the «انتخاب همه» checkbox), by column.
  final Map<int, Widget> headCells;

  /// Fixed column widths (`<th style="width:34px">`), by column.
  final Map<int, double> widths;
  final List<List<Widget>> rows;
  final double fontSize;

  /// Background of a row (e.g. the occupied rooms of the dashboard).
  final Color? Function(int row)? rowColor;

  /// `min-width` of the table (the wrap scrolls sideways below it).
  final double? minWidth;

  /// `table-layout:fixed` column shares (fractions of the width).
  final List<double>? fixed;
  final EdgeInsets cellPadding;

  /// `.dashboard-table-wrap{border:1px solid var(--line)}`.
  final bool bordered;

  @override
  Widget build(BuildContext context) {
    final cols = head.length;
    TableColumnWidth width(int i) => widths[i] != null
        ? FixedColumnWidth(widths[i]!)
        : fixed != null
        ? FractionColumnWidth(fixed![i])
        : stretch
        ? const _HtmlAutoColumn()
        : const _HtmlAutoColumn(grow: false);
    TableRow row(
      List<Widget> cells, {
      required bool th,
      Color? color,
      bool last = false,
    }) => TableRow(
      decoration: BoxDecoration(
        color: th ? Web.soft : color,
        border: last ? null : Border(bottom: BorderSide(color: Web.line)),
      ),
      children: [
        for (var i = 0; i < cols; i++)
          Padding(
            padding: cellPadding,
            child: i < cells.length ? cells[i] : const SizedBox.shrink(),
          ),
      ],
    );
    final table = DefaultTextStyle.merge(
      style: TextStyle(
        fontSize: fontSize,
        height: Web.lineHeight,
        fontFeatures: Web.numFeatures,
      ),
      child: Table(
        columnWidths: {for (var i = 0; i < cols; i++) i: width(i)},
        defaultVerticalAlignment: TableCellVerticalAlignment.middle,
        children: [
          if (!headless)
            row(
              [
                for (final (i, h) in head.indexed)
                  headCells[i] ??
                      Text(
                        h,
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w800,
                          color: Web.ink,
                        ),
                      ),
              ],
              th: true,
              last: rows.isEmpty && empty == null,
            ),
          for (final (i, r) in rows.indexed)
            row(
              r,
              th: false,
              color: rowColor?.call(i),
              last: i == rows.length - 1,
            ),
        ],
      ),
    );
    final box = Container(
      decoration: BoxDecoration(
        color: bordered ? Web.card : null,
        border: bordered ? Border.all(color: Web.line) : null,
        borderRadius: BorderRadius.circular(bordered ? 13 : 12),
      ),
      clipBehavior: Clip.antiAlias,
      child: rows.isEmpty && empty != null
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                table,
                Padding(padding: cellPadding, child: empty),
              ],
            )
          : table,
    );
    final body = stretch || fixed != null
        ? box
        : Align(alignment: AlignmentDirectional.topStart, child: box);
    final mw = minWidth;
    // no LayoutBuilder unless a min-width can make it scroll (intrinsic-size parents)
    if (mw == null) return body;
    return LayoutBuilder(
      builder: (context, size) => size.maxWidth >= mw
          ? body
          // row 185: below the min-width the table scrolls sideways at its own (content)
          // width with an always-visible bar, so the «عملیات» column is never just cut off
          : WebHScroll(
              child: stretch || fixed != null
                  ? SizedBox(width: mw, child: body)
                  : box,
            ),
    );
  }
}

/// Row 185: a sideways scroller with an always-visible scrollbar (phone tables).
class WebHScroll extends StatefulWidget {
  const WebHScroll({super.key, required this.child});
  final Widget child;

  @override
  State<WebHScroll> createState() => _WebHScrollState();
}

class _WebHScrollState extends State<WebHScroll> {
  final _c = ScrollController();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scrollbar(
    controller: _c,
    thumbVisibility: true,
    child: SingleChildScrollView(
      controller: _c,
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.only(bottom: 10),
      child: widget.child,
    ),
  );
}

/// HTML `table-layout:auto`: a column is as wide as its widest cell, and spare width goes to
/// the columns in proportion to that width.
class _HtmlAutoColumn extends TableColumnWidth {
  const _HtmlAutoColumn({this.grow = true});

  /// Whether the column takes a share of the spare width (row 185: only when stretched).
  final bool grow;

  double _max(Iterable<RenderBox> cells) {
    var w = 0.0;
    for (final c in cells) {
      w = math.max(w, c.getMaxIntrinsicWidth(double.infinity));
    }
    return w;
  }

  @override
  double minIntrinsicWidth(Iterable<RenderBox> cells, double containerWidth) {
    var w = 0.0;
    for (final c in cells) {
      w = math.max(w, c.getMinIntrinsicWidth(double.infinity));
    }
    return w;
  }

  @override
  double maxIntrinsicWidth(Iterable<RenderBox> cells, double containerWidth) =>
      _max(cells);

  @override
  double? flex(Iterable<RenderBox> cells) =>
      grow ? math.max(_max(cells), 1) : null;
}

/// `pageHead(title, sub, actions)` + pulse.js `.nowchip`: the title box on the right (h2 19px,
/// optional small muted line, the «today» chip), the actions on the left; 14px under it.
class WebPageHead extends StatelessWidget {
  const WebPageHead({
    super.key,
    required this.title,
    this.sub,
    this.actions = const [],
    this.chip = true,
    this.subKey,
  });
  final String title;
  final String? sub;
  final Key? subKey;
  final List<Widget> actions;

  /// pulse.js adds the chip to the first `.topbar` of every page.
  final bool chip;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 14),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Expanded(
          flex: 3,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                title,
                key: const Key('web-title'),
                style: TextStyle(
                  fontSize: 19,
                  fontWeight: FontWeight.w700,
                  height: 1.4,
                  letterSpacing: -0.2,
                  color: Web.ink,
                ),
              ),
              if (sub case final s? when s.isNotEmpty)
                Text(s, key: subKey, style: Web.small),
              if (chip && !(Web.d2 && (sub ?? '').isNotEmpty))
                const WebNowChip(),
            ],
          ),
        ),
        if (actions.isNotEmpty) ...[
          const SizedBox(width: 9.6),
          if (MediaQuery.sizeOf(context).width < 900)
            // a phone: both boxes shrink like the flex items of `.topbar`; the buttons wrap
            Flexible(
              flex: 2,
              child: Align(
                alignment: AlignmentDirectional.centerEnd,
                child: Wrap(
                  spacing: 9.6,
                  runSpacing: 9.6,
                  alignment: WrapAlignment.end,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: actions,
                ),
              ),
            )
          else
            Wrap(
              spacing: 9.6,
              runSpacing: 9.6,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: actions,
            ),
        ],
      ],
    ),
  );
}

/// pulse.js `.nowchip`: clock icon, «پنجشنبه ۲۱ آبان», a blinking green dot.
class WebNowChip extends StatelessWidget {
  const WebNowChip({super.key});

  @override
  Widget build(BuildContext context) => Web.d2
      // design 2: the date is a plain muted line under the title (no pill, no dot)
      ? Padding(
          padding: const EdgeInsets.only(top: 2),
          child: Text(
            Web.todayChip(WebClock.of(context)),
            key: const Key('web-nowchip'),
            style: Web.small,
          ),
        )
      : Padding(
          padding: const EdgeInsets.only(top: 7),
          child: Container(
            key: const Key('web-nowchip'),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(
              color: Web.card.withValues(alpha: 0.76),
              border: Border.all(color: Web.line),
              borderRadius: BorderRadius.circular(99),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                WebIcon('clock', size: 17, color: Web.primary),
                const SizedBox(width: 7),
                // a narrow title box (phone + head buttons) wraps the date instead of overflowing
                Flexible(
                  child: Text(
                    Web.todayChip(WebClock.of(context)),
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w800,
                      color: Web.muted,
                      height: 1.2,
                    ),
                  ),
                ),
                const SizedBox(width: 7),
                Container(
                  width: 7,
                  height: 7,
                  decoration: const BoxDecoration(
                    color: Color(0xFF10B981),
                    shape: BoxShape.circle,
                  ),
                ),
              ],
            ),
          ),
        );
}

/// The `.main` column of a page: padding 22px 26px 40px (14px 14px 86px on a phone).
class WebPageBody extends StatelessWidget {
  const WebPageBody({
    super.key,
    required this.children,
    this.controller,
    this.flow = true,
  });
  final List<Widget> children;
  final ScrollController? controller;

  /// Row 185: the page's cards sit side by side in columns ([FlowColumns]) — «حذف فضاهای
  /// بیخود و اضافی در کل برنامه». Titles, banners and [FlowWide] blocks keep the full width.
  final bool flow;

  /// Only a card flows in a column; anything else (title row, banner, paragraph, stats grid)
  /// takes the whole line.
  static bool wideBlock(Widget w) => w is! WebCard && w is! WebEmpty;

  @override
  Widget build(BuildContext context) {
    final wide = MediaQuery.sizeOf(context).width >= 900;
    final all = [?WebMainTop.of(context), ...children];
    return WebText(
      child: ListView(
        controller: controller,
        padding: wide
            ? const EdgeInsets.fromLTRB(26, 22, 26, 40)
            : const EdgeInsets.fromLTRB(14, 14, 14, 86),
        children:
            flow &&
                all
                        .where(
                          (w) =>
                              w is FlowCell ||
                              (w is! FlowWide && !wideBlock(w)),
                        )
                        .length >
                    1
            ? [FlowColumns(wide: wideBlock, children: all)]
            : all,
      ),
    );
  }
}

/// Row 185: a [Wrap] whose widest size counts the gaps between its children too ([SpacedWrap]).
typedef WebWrap = SpacedWrap;

/// Row 185: [child] takes the page's whole width when [wide] (a filled table), else it flows in a
/// column like any card.
Widget wideIf(bool wide, Widget child) => wide ? FlowWide(child: child) : child;

/// Row 172: what the shell puts at the top of every `.main` (the cloud banner and the version
/// bar of the web `shellHtml`); [WebPageBody] shows it first, scrolling with the page.
class WebMainTop extends InheritedWidget {
  const WebMainTop({super.key, required this.bars, required super.child});
  final Widget bars;

  static Widget? of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<WebMainTop>()?.bars;

  @override
  bool updateShouldNotify(WebMainTop oldWidget) => bars != oldWidget.bars;
}

/// `.grid` — auto-fill columns of at least 150px, 12px gaps.
class WebGrid extends StatelessWidget {
  const WebGrid({
    super.key,
    required this.children,
    this.min = 150,
    this.gap = 12,
    this.bottom = 12,
  });
  final List<Widget> children;
  final double min;
  final double gap;
  final double bottom;

  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.only(bottom: bottom),
    child: LayoutBuilder(
      builder: (context, box) {
        final cols = math.max(1, ((box.maxWidth + gap) / (min + gap)).floor());
        final rows = <Widget>[];
        for (var i = 0; i < children.length; i += cols) {
          rows.add(
            WebEqualRow(
              gap: gap,
              children: [
                for (var j = i; j < i + cols; j++)
                  j < children.length ? children[j] : const SizedBox.shrink(),
              ],
            ),
          );
        }
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final (i, r) in rows.indexed) ...[
              if (i > 0) SizedBox(height: gap),
              r,
            ],
          ],
        );
      },
    ),
  );
}

/// `<div class="card tight stat"><div class="ico">…</div><div><div class="num">…</div>
/// <div class="lbl">…</div></div></div>` (pulse.css: min-height 80, 40px icon tile).
class WebStat extends StatelessWidget {
  const WebStat({
    super.key,
    required this.icon,
    required this.num,
    required this.label,
    this.numKey,
    this.numColor,
    this.onTap,
  });
  final String icon;
  final String num;
  final String label;
  final Key? numKey;
  final Color? numColor;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final body = Container(
      constraints: const BoxConstraints(minHeight: 80),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: Web.card,
        border: Border.all(color: Web.line),
        borderRadius: BorderRadius.circular(Web.radius),
        boxShadow: Web.shadow,
      ),
      child: Row(
        children: [
          WebIconTile(icon),
          const SizedBox(width: 9.6),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  num,
                  key: numKey,
                  style: TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.w800,
                    height: 1.2,
                    color: numColor ?? Web.ink,
                    fontFeatures: Web.numFeatures,
                  ),
                ),
                Text(
                  label,
                  style: TextStyle(
                    fontSize: 12,
                    color: Web.muted,
                    height: Web.lineHeight,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
    return onTap == null
        ? body
        : MouseRegion(
            cursor: SystemMouseCursors.click,
            child: GestureDetector(onTap: onTap, child: body),
          );
  }
}

/// `.stat .ico.pjs-ic` — 40×40, radius 13, soft gradient, the icon in `--primary`.
class WebIconTile extends StatelessWidget {
  const WebIconTile(this.icon, {super.key, this.size = 40});
  final String icon;
  final double size;

  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(
      borderRadius: BorderRadius.circular(13),
      border: Border.all(color: Color.lerp(Web.line, Web.primary, 0.15)!),
      gradient: LinearGradient(
        begin: const Alignment(-0.57, -0.82),
        end: const Alignment(0.57, 0.82),
        colors: [Web.soft, Color.lerp(Web.card, Web.primary, 0.28)!],
      ),
    ),
    child: WebIcon(icon, size: size, color: Web.primary),
  );
}

enum WebBannerKind { info, warn, err, ok }

/// `.banner` — radius 14, 13px, coloured by kind; actions on the left.
class WebBanner extends StatelessWidget {
  const WebBanner({
    super.key,
    required this.text,
    this.kind = WebBannerKind.info,
    this.actions = const [],
    this.textKey,
  });
  final String text;
  final WebBannerKind kind;
  final List<Widget> actions;
  final Key? textKey;

  @override
  Widget build(BuildContext context) {
    final (bg, fg) = switch (kind) {
      WebBannerKind.info => (Web.soft, Web.primary),
      WebBannerKind.warn => (Web.amberBg, Web.amber),
      WebBannerKind.err => (Web.redBg, Web.red),
      WebBannerKind.ok => (Web.greenBg, Web.green),
    };
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.symmetric(horizontal: 12.8, vertical: 9.6),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              text,
              key: textKey,
              style: TextStyle(fontSize: 13, color: fg, height: Web.lineHeight),
            ),
          ),
          for (final a in actions) ...[const SizedBox(width: 9.6), a],
        ],
      ),
    );
  }
}

/// `.pill-tabs` — round tabs, the selected one filled with `--primary`.
class WebPills extends StatelessWidget {
  const WebPills({
    super.key,
    required this.tabs,
    required this.selected,
    required this.onSelected,
    this.keyPrefix = 'pill',
    this.bottom = 16,
  });

  /// Space under the pills.
  final double bottom;
  final List<(String id, String label)> tabs;
  final String selected;
  final ValueChanged<String> onSelected;
  final String keyPrefix;

  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.only(bottom: bottom),
    child: SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          for (final (i, (id, label)) in tabs.indexed) ...[
            if (i > 0) const SizedBox(width: 6),
            MouseRegion(
              cursor: SystemMouseCursors.click,
              child: GestureDetector(
                key: Key('$keyPrefix-$id'),
                onTap: () => onSelected(id),
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 13.6,
                    vertical: 5.6,
                  ),
                  decoration: BoxDecoration(
                    color: id == selected ? Web.primary : Web.card,
                    border: Border.all(
                      color: id == selected ? Web.primary : Web.line,
                    ),
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text(
                    label,
                    style: TextStyle(
                      fontSize: 13,
                      height: Web.lineHeight,
                      color: id == selected ? Web.onPrimary : Web.ink,
                    ),
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    ),
  );
}

/// `.field` — bold 13px label over the control, 12.8px under it.
class WebField extends StatelessWidget {
  const WebField({
    super.key,
    required this.label,
    required this.child,
    this.bottom = 12.8,
  });
  final String label;
  final Widget child;

  /// The space under the control (`style="margin:0"` = 0).
  final double bottom;

  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.only(bottom: bottom),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: 5),
          child: Text(
            label,
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w700,
              color: Web.ink,
            ),
          ),
        ),
        child,
      ],
    ),
  );
}

/// `.input` — 2px #94a3b8 border, radius 11, min-height 44; focus = `--primary` + ring.
InputDecoration webInput({String? hint, String? error}) {
  OutlineInputBorder b(Color c) => OutlineInputBorder(
    borderRadius: BorderRadius.circular(11),
    borderSide: BorderSide(color: c, width: 2),
  );
  return InputDecoration(
    hintText: hint,
    errorText: error,
    errorMaxLines: 3,
    isDense: true,
    filled: true,
    fillColor: error == null ? Web.card : const Color(0xFFFFF6F5),
    contentPadding: const EdgeInsets.symmetric(horizontal: 12.8, vertical: 12),
    enabledBorder: b(
      error == null ? const Color(0xFF94A3B8) : const Color(0xFFF2A7A1),
    ),
    focusedBorder: b(Web.primary),
    errorBorder: b(const Color(0xFFF2A7A1)),
    focusedErrorBorder: b(Web.primary),
    border: b(const Color(0xFF94A3B8)),
  );
}

// ─────────────────────────── icons (client/pulse.js ICON_SHAPES) ───────────────────────────

/// One SVG element of an icon: `path d`, `polyline points`, `circle cx cy r`, `rect x y w h rx`.
typedef _Shape = (String tag, List<Object> args);

const Map<String, List<_Shape>> _icons = {
  // row 180 design 2 «بیشتر» (lucide layout-grid)
  'grid': [
    ('rect', [3.0, 3.0, 7.0, 7.0, 1.0]),
    ('rect', [14.0, 3.0, 7.0, 7.0, 1.0]),
    ('rect', [14.0, 14.0, 7.0, 7.0, 1.0]),
    ('rect', [3.0, 14.0, 7.0, 7.0, 1.0]),
  ],
  'home': [
    ('path', ['m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z']),
    ('polyline', ['9 22 9 12 15 12 15 22']),
  ],
  'users': [
    ('path', ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2']),
    ('circle', [9.0, 7.0, 4.0]),
    ('path', ['M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75']),
  ],
  'teacher': [
    ('path', ['m2 10 10-5 10 5-10 5-10-5z']),
    ('path', ['M6 12v5c3.5 2.5 8.5 2.5 12 0v-5M22 10v6']),
    ('circle', [22.0, 17.0, 1.0]),
  ],
  'alert': [
    (
      'path',
      [
        'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z',
      ],
    ),
    ('path', ['M12 9v4M12 17h.01']),
  ],
  'school': [
    ('path', ['m22 10-10-5L2 10l10 5 10-5z']),
    ('path', ['M6 12v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5M22 10v6']),
  ],
  'calendar': [
    ('rect', [3.0, 4.0, 18.0, 17.0, 2.0]),
    ('path', ['M16 2v4M8 2v4M3 10h18']),
  ],
  'check': [
    ('path', ['m5 12 4 4L19 6']),
    ('path', ['M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h10']),
  ],
  'cross': [
    ('circle', [12.0, 12.0, 9.0]),
    ('path', ['m9 9 6 6m0-6-6 6']),
  ],
  'report': [
    ('path', ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z']),
    ('path', ['M14 2v6h6M16 13H8M16 17H8M10 9H8']),
  ],
  'chart': [
    ('path', ['M3 3v18h18']),
    ('path', ['m7 14 4-4 4 3 6-7']),
    ('path', ['M17 6h4v4']),
  ],
  'megaphone': [
    ('path', ['m3 11 18-5v12L3 13v-2z']),
    ('path', ['M11.6 16.8a3 3 0 1 1-5.8-1.6M16 8v8']),
  ],
  'health': [
    ('path', ['M22 12h-4l-3 9L9 3l-3 9H2']),
  ],
  'globe': [
    ('circle', [12.0, 12.0, 10.0]),
    (
      'path',
      [
        'M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
      ],
    ),
  ],
  'cloud': [
    (
      'path',
      [
        'M17.5 19a4.5 4.5 0 1 0-.42-8.97 6 6 0 0 0-11.36 2.2A3.5 3.5 0 0 0 7 19z',
      ],
    ),
  ],
  'gear': [
    ('circle', [12.0, 12.0, 3.0]),
    (
      'path',
      [
        'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
      ],
    ),
  ],
  'pen': [
    ('path', ['m17 3 4 4L7.5 20.5 2 22l1.5-5.5L17 3z']),
    ('path', ['m15 5 4 4']),
  ],
  'mail': [
    ('rect', [2.0, 4.0, 20.0, 16.0, 2.0]),
    ('path', ['m22 7-10 5L2 7']),
  ],
  'folder': [
    (
      'path',
      [
        'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z',
      ],
    ),
  ],
  'family': [
    ('path', ['M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2']),
    ('circle', [9.0, 7.0, 4.0]),
    ('path', ['M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75']),
  ],
  'clock': [
    ('circle', [12.0, 12.0, 10.0]),
    ('path', ['M12 6v6l4 2']),
  ],
  'down': [
    ('path', ['M12 5v14M19 12l-7 7-7-7']),
  ],
  'default': [
    ('circle', [12.0, 12.0, 9.0]),
    ('path', ['M12 8v4l3 3']),
  ],
};

/// pulse.js `EMOJI_TO_ICON`: the web pages write an emoji; pulse.js swaps it for this icon.
const Map<String, String> webEmojiIcon = {
  '🏠': 'home',
  '🏡': 'home',
  '👥': 'users',
  '👤': 'users',
  '👨‍🏫': 'teacher', //
  '⚠': 'alert',
  '🏛': 'school',
  '🏫': 'school',
  '🗓': 'calendar',
  '📅': 'calendar',
  '✅': 'check', '✔': 'check', '❌': 'cross', '📑': 'report', '📊': 'chart',
  '📄': 'report',
  '📢': 'megaphone',
  '📣': 'megaphone',
  '🩺': 'health',
  '🌐': 'globe',
  '☁': 'cloud', '⚙': 'gear', '📝': 'pen', '✏': 'pen', '📨': 'mail', '✉': 'mail',
  '📁': 'folder',
  '🗂': 'folder',
  '👨‍👩‍👦': 'family',
  '👨‍👩‍👧': 'family',
  '🕐': 'clock',
  '⏰': 'clock', '⬇': 'down', '📥': 'down',
};

/// Icon name of a web emoji (variation selectors ignored), or null when pulse.js keeps it.
String? webIconFor(String emoji) =>
    webEmojiIcon[emoji.replaceAll(RegExp('[\uFE0E\uFE0F]'), '')];

/// A pulse.js icon: 24-unit viewBox, no fill, `currentColor` stroke 2, round caps and joins.
class WebIcon extends StatelessWidget {
  const WebIcon(this.name, {super.key, this.size = 22, this.color});
  final String name;
  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: size,
    height: size,
    child: CustomPaint(
      painter: _IconPainter(
        _icons[name] ?? _icons['default']!,
        color ?? DefaultTextStyle.of(context).style.color ?? Web.ink,
      ),
    ),
  );
}

class _IconPainter extends CustomPainter {
  _IconPainter(this.shapes, this.color);
  final List<_Shape> shapes;
  final Color color;

  static final Map<String, Path> _cache = {};

  @override
  void paint(Canvas canvas, Size size) {
    final s = size.shortestSide / 24;
    canvas.save();
    canvas.translate((size.width - 24 * s) / 2, (size.height - 24 * s) / 2);
    canvas.scale(s);
    final p = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..color = color;
    for (final (tag, a) in shapes) {
      switch (tag) {
        case 'path':
          final d = a[0] as String;
          canvas.drawPath(_cache[d] ??= svgPath(d), p);
        case 'polyline':
          final n = _numbers(a[0] as String);
          final path = Path()..moveTo(n[0], n[1]);
          for (var i = 2; i + 1 < n.length; i += 2) {
            path.lineTo(n[i], n[i + 1]);
          }
          canvas.drawPath(path, p);
        case 'circle':
          canvas.drawCircle(
            Offset(a[0] as double, a[1] as double),
            a[2] as double,
            p,
          );
        case 'rect':
          canvas.drawRRect(
            RRect.fromRectAndRadius(
              Rect.fromLTWH(
                a[0] as double,
                a[1] as double,
                a[2] as double,
                a[3] as double,
              ),
              Radius.circular(a[4] as double),
            ),
            p,
          );
      }
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_IconPainter old) =>
      old.color != color || !identical(old.shapes, shapes);
}

final RegExp _num = RegExp(r'-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?');

List<double> _numbers(String s) => [
  for (final m in _num.allMatches(s)) double.parse(m.group(0)!),
];

/// SVG path data → [Path] (M L H V C S Q T A Z, absolute and relative).
Path svgPath(String d) {
  final path = Path();
  final tokens = RegExp(
    r'[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?',
  ).allMatches(d).map((m) => m.group(0)!).toList();
  var i = 0;
  var cmd = '';
  var x = 0.0, y = 0.0, sx = 0.0, sy = 0.0;
  double? cx2, cy2; // last control point (for S / T)
  var lastCmd = '';
  bool isCmd(String t) => RegExp(r'^[A-Za-z]$').hasMatch(t);
  double n() => double.parse(tokens[i++]);
  // Arc flags may be packed ("011"); here every token is a whole number already.
  while (i < tokens.length) {
    if (isCmd(tokens[i])) {
      cmd = tokens[i++];
    } else if (cmd == 'M') {
      cmd = 'L';
    } else if (cmd == 'm') {
      cmd = 'l';
    }
    final rel = cmd == cmd.toLowerCase();
    final ox = rel ? x : 0.0, oy = rel ? y : 0.0;
    switch (cmd.toUpperCase()) {
      case 'M':
        x = ox + n();
        y = oy + n();
        path.moveTo(x, y);
        sx = x;
        sy = y;
        cx2 = cy2 = null;
      case 'L':
        x = ox + n();
        y = oy + n();
        path.lineTo(x, y);
        cx2 = cy2 = null;
      case 'H':
        x = ox + n();
        path.lineTo(x, y);
        cx2 = cy2 = null;
      case 'V':
        y = oy + n();
        path.lineTo(x, y);
        cx2 = cy2 = null;
      case 'C':
        final x1 = ox + n(), y1 = oy + n();
        final x2 = ox + n(), y2 = oy + n();
        x = ox + n();
        y = oy + n();
        path.cubicTo(x1, y1, x2, y2, x, y);
        cx2 = x2;
        cy2 = y2;
      case 'S':
        final prevC = 'CcSs'.contains(lastCmd) && cx2 != null;
        final x1 = prevC ? 2 * x - cx2 : x;
        final y1 = prevC ? 2 * y - cy2! : y;
        final x2 = ox + n(), y2 = oy + n();
        x = ox + n();
        y = oy + n();
        path.cubicTo(x1, y1, x2, y2, x, y);
        cx2 = x2;
        cy2 = y2;
      case 'Q':
        final x1 = ox + n(), y1 = oy + n();
        x = ox + n();
        y = oy + n();
        path.quadraticBezierTo(x1, y1, x, y);
        cx2 = x1;
        cy2 = y1;
      case 'T':
        final prevQ = 'QqTt'.contains(lastCmd) && cx2 != null;
        final x1 = prevQ ? 2 * x - cx2 : x;
        final y1 = prevQ ? 2 * y - cy2! : y;
        x = ox + n();
        y = oy + n();
        path.quadraticBezierTo(x1, y1, x, y);
        cx2 = x1;
        cy2 = y1;
      case 'A':
        final rx = n(), ry = n(), rot = n();
        final large = n() != 0, sweep = n() != 0;
        x = ox + n();
        y = oy + n();
        path.arcToPoint(
          Offset(x, y),
          radius: Radius.elliptical(rx, ry),
          rotation: rot,
          largeArc: large,
          clockwise: sweep,
        );
        cx2 = cy2 = null;
      case 'Z':
        path.close();
        x = sx;
        y = sy;
        cx2 = cy2 = null;
    }
    lastCmd = cmd;
  }
  return path;
}

/// A row of equal-width cells that all take the height of the tallest one — CSS grid rows
/// (`align-items:stretch`, `.card{height:100%}`) — measured with two layout passes, no
/// intrinsic sizing (pages hold tables and LayoutBuilders).
class WebEqualRow extends MultiChildRenderObjectWidget {
  const WebEqualRow({
    super.key,
    required super.children,
    this.gap = 12,
    this.firstWidth,
  });
  final double gap;

  /// A fixed width for the first cell (CSS `grid-template-columns:74px repeat(…)`).
  final double? firstWidth;

  @override
  RenderObject createRenderObject(BuildContext context) =>
      RenderWebEqualRow(gap, textDirection: Directionality.of(context))
        ..firstWidth = firstWidth;

  @override
  void updateRenderObject(
    BuildContext context,
    RenderWebEqualRow renderObject,
  ) {
    renderObject
      ..gap = gap
      ..firstWidth = firstWidth
      ..textDirection = Directionality.of(context);
  }
}

class _EqualRowData extends ContainerBoxParentData<RenderBox> {}

class RenderWebEqualRow extends RenderBox
    with
        ContainerRenderObjectMixin<RenderBox, _EqualRowData>,
        RenderBoxContainerDefaultsMixin<RenderBox, _EqualRowData> {
  RenderWebEqualRow(this._gap, {required TextDirection textDirection})
    : _dir = textDirection;

  double _gap;
  set gap(double v) {
    if (v == _gap) return;
    _gap = v;
    markNeedsLayout();
  }

  double? _first;
  set firstWidth(double? v) {
    if (v == _first) return;
    _first = v;
    markNeedsLayout();
  }

  TextDirection _dir;
  set textDirection(TextDirection v) {
    if (v == _dir) return;
    _dir = v;
    markNeedsLayout();
  }

  @override
  void setupParentData(RenderBox child) {
    if (child.parentData is! _EqualRowData) child.parentData = _EqualRowData();
  }

  @override
  void performLayout() {
    final n = childCount;
    final width = constraints.maxWidth;
    if (n == 0) {
      size = constraints.constrain(Size(width, 0));
      return;
    }
    final first = _first;
    final w = first == null
        ? (width - _gap * (n - 1)) / n
        : n == 1
        ? first
        : (width - first - _gap * (n - 1)) / (n - 1);
    double wOf(int i) => i == 0 && first != null ? first : w;
    var h = 0.0;
    var c = firstChild;
    var i = 0;
    while (c != null) {
      final cw = wOf(i);
      c.layout(
        BoxConstraints(minWidth: cw, maxWidth: cw),
        parentUsesSize: true,
      );
      h = math.max(h, c.size.height);
      c = childAfter(c);
      i++;
    }
    i = 0;
    var x = 0.0;
    c = firstChild;
    while (c != null) {
      final cw = wOf(i);
      // not tight (and the size is used): a tight child would be a relayout boundary, and a
      // cell whose content grows later would overflow the old row height instead of
      // re-measuring the row
      c.layout(
        BoxConstraints(minWidth: cw, maxWidth: cw, minHeight: h),
        parentUsesSize: true,
      );
      (c.parentData! as _EqualRowData).offset = Offset(
        _dir == TextDirection.rtl ? width - x - cw : x,
        0,
      );
      x += cw + _gap;
      i++;
      c = childAfter(c);
    }
    size = constraints.constrain(Size(width, h));
  }

  @override
  void paint(PaintingContext context, Offset offset) =>
      defaultPaint(context, offset);

  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) =>
      defaultHitTestChildren(result, position: position);
}

/// `jalaliDateControl()`: one ltr text input with the Jalali date in Persian digits
/// (placeholder «۱۴۰۵/۰۱/۰۱»); a complete valid date is reported as ISO.
class WebJalaliField extends StatefulWidget {
  const WebJalaliField({
    super.key,
    required this.iso,
    required this.onChanged,
    this.maxWidth = 180,
  });
  final String? iso;
  final ValueChanged<String> onChanged;
  final double maxWidth;

  @override
  State<WebJalaliField> createState() => _WebJalaliFieldState();
}

class _WebJalaliFieldState extends State<WebJalaliField> {
  late final TextEditingController text = TextEditingController(
    text: _show(widget.iso),
  );

  static String _show(String? iso) =>
      faDigits(JalaliDate.fromIso(iso)?.slash ?? '');

  @override
  void didUpdateWidget(WebJalaliField old) {
    super.didUpdateWidget(old);
    final shown = JalaliDate.parse(text.text)?.toIso();
    if (widget.iso != old.iso && widget.iso != shown) {
      text.text = _show(widget.iso);
    }
  }

  @override
  void dispose() {
    text.dispose();
    super.dispose();
  }

  void _changed(String v) {
    final iso = JalaliDate.parse(v)?.toIso();
    if (iso != null && iso != widget.iso) widget.onChanged(iso);
  }

  @override
  Widget build(BuildContext context) => ConstrainedBox(
    constraints: BoxConstraints(maxWidth: widget.maxWidth),
    child: FieldBox(
      width: kFieldDigits,
      child: TextField(
        controller: text,
        textDirection: TextDirection.ltr,
        keyboardType: TextInputType.number,
        maxLength: 10,
        style: TextStyle(fontSize: 15, color: Web.ink),
        decoration: webInput(hint: '۱۴۰۵/۰۱/۰۱').copyWith(counterText: ''),
        onChanged: _changed,
        onSubmitted: _changed,
      ),
    ),
  );
}
