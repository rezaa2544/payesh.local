// Row 170 — «نبض» panel of the web client (client/pulse.js + pulse.css, option A of the owner):
// the sidebar dashboard of the manager / users panel, rebuilt in Flutter so the installed apps
// (Windows 64/32-bit, Android) show the SAME panel: sidebar on the right (RTL) with the brand,
// the school name, the pages in the web order and the account; «نبض امروز مدرسه» hero with the
// present count and a ratio ring; stat cards with a soft icon tile and the number in the primary
// colour. On a phone the same pages sit in a drawer.
import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart'
    show AdminFailure, ServerAdminApi, ServerHealth, SyncPhase, SyncStatus;
import 'package:payesh_ui/payesh_ui.dart';
import 'package:payesh_update/payesh_update.dart';

import 'web.dart';

/// Wider than this ⇒ the sidebar is shown and pages open inside the shell.
/// Row 172: web `@media (min-width:900px)` — sidebar at 900px and up, the bottom bar below.
const double pulseWideBreakpoint = 900;

/// One page of the panel's navigation.
final class PulseNavItem {
  const PulseNavItem({
    required this.id,
    required this.label,
    required this.icon,
    required this.page,
    this.webIcon = 'default',
  });
  final String id;
  final String label;
  final IconData icon;

  /// Row 172: the pulse.js icon of the web sidebar (client/pages.js `navConfig` emoji).
  final String webIcon;

  /// The page itself (inline in the wide shell, a pushed route on a phone).
  final WidgetBuilder page;
}

/// Web sidebar order (client/pages.js `navConfig`): pages not listed keep their own order after.
const List<String> pulseNavOrder = [
  'today',
  'users',
  'students',
  'followup',
  'classes',
  'schedule',
  'attendance',
  'attendance-report',
  'grades',
  'reports',
  'leaves',
  'notices',
  'family',
  'record',
  'health',
  'cloud',
  'system',
  'password',
];

/// Sorts [items] in the web order.
List<PulseNavItem> pulseSorted(Iterable<PulseNavItem> items) {
  int rank(String id) {
    final i = pulseNavOrder.indexOf(id);
    return i < 0 ? pulseNavOrder.length : i;
  }

  final list = [...items];
  final pos = {for (final (i, e) in list.indexed) e.id: i};
  list.sort((a, b) {
    final r = rank(a.id).compareTo(rank(b.id));
    return r != 0 ? r : pos[a.id]!.compareTo(pos[b.id]!);
  });
  return list;
}

/// Row 172: what the web pages read from the app itself — the app updater (the system page's
/// «به‌روزرسانی برنامه» card) and the external-link opener («صفحهٔ نصب و راهنما»). Sits above
/// the MaterialApp, so pushed pages see it too; both are null in tests and local builds.
class PulseApp extends InheritedWidget {
  const PulseApp({super.key, required super.child, this.updater, this.openUrl});

  final AppUpdater? updater;
  final Future<void> Function(Uri url)? openUrl;

  static PulseApp? of(BuildContext context) =>
      context.getInheritedWidgetOfExactType<PulseApp>();

  @override
  bool updateShouldNotify(PulseApp oldWidget) =>
      updater != oldWidget.updater || openUrl != oldWidget.openUrl;
}

/// Marks a page that is shown inside the shell (no back button: the sidebar is the way out).
/// Row 172: [go] opens another sidebar page (web `href="#/users"` links of the pages).
class PulseInline extends InheritedWidget {
  const PulseInline({
    super.key,
    required super.child,
    this.onGo,
    this.onLock,
    this.extras,
  });

  final ValueChanged<String>? onGo;

  /// Row 172: this device's native-only controls (support, the previous web version, sign-out)
  /// that the web panel has no place for; the system page shows them in its last card.
  final WidgetBuilder? extras;

  static WidgetBuilder? extrasOf(BuildContext context) =>
      context.getInheritedWidgetOfExactType<PulseInline>()?.extras;

  /// Row 172: web «🔒 خروج» of the system page (lock when the app can lock, else sign out).
  final VoidCallback? onLock;

  static VoidCallback? lockOf(BuildContext context) =>
      context.getInheritedWidgetOfExactType<PulseInline>()?.onLock;

  static bool of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<PulseInline>() != null;

  /// Opens the sidebar page [route] (a web route id); false when there is no such page here.
  static bool go(BuildContext context, String route) {
    final g = context.getInheritedWidgetOfExactType<PulseInline>()?.onGo;
    if (g == null) return false;
    g(route);
    return true;
  }

  @override
  bool updateShouldNotify(PulseInline oldWidget) => false;
}

/// The web sidebar (`shellHtml` `.sidebar`, row 172 = exactly the web panel): the logo mark and
/// «پایش-لوکال», the school name (small, muted), the pages of `navConfig(role)` — the first one
/// is the role's home — then «حساب» and «name · role».
class PulseSidebar extends StatelessWidget {
  const PulseSidebar({
    super.key = const Key('pulse-sidebar'),
    required this.items,
    required this.selected,
    required this.onSelected,
    this.school,
    this.account,
    this.footer = const [],
  });

  final List<PulseNavItem> items;

  /// An item id.
  final String selected;
  final ValueChanged<String> onSelected;
  final String? school;

  /// «مدیر نمونه · مدیر».
  final String? account;

  /// Native-only controls (sync state, sign-out menu) under the account line.
  final List<Widget> footer;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 250,
      decoration: const BoxDecoration(
        color: Web.card,
        border: BorderDirectional(end: BorderSide(color: Web.line)),
      ),
      child: WebText(
        child: ListView(
          padding: const EdgeInsets.all(14),
          children: [
            // .sidebar .brand{gap:.5rem;margin-bottom:14px;font-weight:800;color:var(--primary)}
            Padding(
              padding: const EdgeInsets.only(bottom: 14),
              child: Row(
                children: [
                  Image.asset(
                    'assets/logo-mark.png',
                    key: const Key('pulse-brand-mark'),
                    width: 30,
                    height: 30,
                    fit: BoxFit.contain,
                  ),
                  const SizedBox(width: 8),
                  const Flexible(
                    child: Text(
                      'پایش-لوکال',
                      key: Key('pulse-brand'),
                      style: TextStyle(
                        fontWeight: FontWeight.w800,
                        color: Web.primary,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Text(
                school ?? '',
                key: const Key('pulse-school'),
                style: Web.small,
              ),
            ),
            for (final m in items)
              _PulseNavTile(
                key: Key('nav-${m.id}'),
                icon: m.webIcon,
                label: m.label,
                selected: selected == m.id,
                onTap: () => onSelected(m.id),
              ),
            // .navgroup{font-size:11.5px;color:var(--muted);margin:14px 0 4px;padding-inline-start:4px}
            const Padding(
              padding: EdgeInsetsDirectional.only(start: 4, top: 14, bottom: 4),
              child: Text(
                'حساب',
                style: TextStyle(
                  fontSize: 11.5,
                  color: Web.muted,
                  letterSpacing: 0.3,
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(6),
              child: Text(
                account ?? '',
                key: const Key('pulse-account'),
                style: Web.small,
              ),
            ),
            ...footer,
          ],
        ),
      ),
    );
  }
}

class _PulseNavTile extends StatefulWidget {
  const _PulseNavTile({
    super.key,
    required this.icon,
    required this.label,
    required this.selected,
    required this.onTap,
  });
  final String icon;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  State<_PulseNavTile> createState() => _PulseNavTileState();
}

class _PulseNavTileState extends State<_PulseNavTile> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final on = widget.selected;
    // .navitem{gap:.5rem;padding:.55rem .7rem;border-radius:13px;font-size:14px}
    // .navitem.on{gradient;color:#fff;font-weight:700;box-shadow:0 7px 16px -7px rgba(13,148,136,.55)}
    return Semantics(
      button: true,
      selected: on,
      label: widget.label,
      excludeSemantics: true,
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => setState(() => _hover = true),
        onExit: (_) => setState(() => _hover = false),
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: widget.onTap,
          child: Container(
            padding: const EdgeInsets.symmetric(
              horizontal: 11.2,
              vertical: 8.8,
            ),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(13),
              color: on ? null : (_hover ? Web.soft : null),
              gradient: on ? Web.gradient : null,
              boxShadow: on
                  ? const [
                      BoxShadow(
                        color: Color(0x8C0D9488),
                        blurRadius: 16,
                        offset: Offset(0, 7),
                        spreadRadius: -7,
                      ),
                    ]
                  : null,
            ),
            child: Row(
              children: [
                WebIcon(
                  widget.icon,
                  size: 21,
                  color: on ? Colors.white : Web.ink,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    widget.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 14,
                      color: on ? Colors.white : Web.ink,
                      fontWeight: on ? FontWeight.w700 : FontWeight.w400,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// «نبض امروز مدرسه» — pulse.js `buildNabdCard` + pulse.css `.nabd-card`, exactly: the head
/// (health icon tile + title) on the right, the present count, «از N دانش‌آموز حاضر», the
/// legend and the 104px ring on the left.
class PulseHero extends StatelessWidget {
  const PulseHero({
    super.key = const Key('pulse-hero'),
    required this.present,
    required this.of,
    required this.absent,
    required this.late,
  });

  final int present;

  /// Students of the school (the ring is present / of).
  final int of;
  final int absent;
  final int late;

  int get ratio => of <= 0 ? 0 : (present * 100 / of).round().clamp(0, 100);

  @override
  Widget build(BuildContext context) {
    final vw = MediaQuery.sizeOf(context).width;
    final narrow = vw <= 600;
    Widget legend(Color c, String label, int n, String key) => Row(
      key: Key(key),
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 9,
          height: 9,
          decoration: BoxDecoration(color: c, shape: BoxShape.circle),
        ),
        const SizedBox(width: 5),
        Text.rich(
          TextSpan(
            text: '$label ',
            children: [
              TextSpan(
                text: Web.fa(n),
                style: const TextStyle(
                  color: Web.ink,
                  fontWeight: FontWeight.w900,
                ),
              ),
            ],
          ),
          style: TextStyle(
            fontSize: narrow ? 11 : 12,
            fontWeight: FontWeight.w800,
            color: Web.muted,
          ),
        ),
      ],
    );
    final head = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 42,
          height: 42,
          padding: const EdgeInsets.all(9),
          decoration: BoxDecoration(
            color: Color.lerp(Web.card, Web.primary, 0.10),
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: Color.lerp(Web.line, Web.primary, 0.25)!),
          ),
          child: const WebIcon('health', size: 24, color: Web.primary),
        ),
        const SizedBox(width: 11),
        Flexible(
          child: Text(
            'نبض امروز مدرسه',
            key: const Key('pulse-title'),
            style: TextStyle(
              fontSize: narrow ? 16 : 18,
              fontWeight: FontWeight.w900,
              color: Web.ink,
            ),
          ),
        ),
      ],
    );
    final metrics = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          Web.fa(present),
          key: const Key('pulse-present'),
          style: TextStyle(
            fontSize: narrow ? 36 : (vw * 0.045).clamp(34, 48).toDouble(),
            height: 1.15,
            fontWeight: FontWeight.w900,
            color: Web.primary,
            // pulse.css `.nabd-num` (and its <small>): tnum + ss01
            fontFeatures: Web.numFeatures,
          ),
        ),
        const SizedBox(height: 5),
        Text(
          'از ${Web.fa(of)} دانش‌آموز حاضر',
          key: const Key('pulse-of'),
          style: const TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w700,
            color: Web.muted,
            fontFeatures: Web.numFeatures,
          ),
        ),
        SizedBox(height: narrow ? 14 : 14),
        Wrap(
          spacing: narrow ? 11 : 15,
          runSpacing: narrow ? 8 : 9,
          children: [
            legend(const Color(0xFF10B981), 'حاضر', present, 'pulse-p'),
            legend(const Color(0xFFF43F5E), 'غایب', absent, 'pulse-a'),
            legend(const Color(0xFFF59E0B), 'تأخیر', late, 'pulse-l'),
          ],
        ),
      ],
    );
    final ring = _PulseRing(ratio: ratio, size: narrow ? 84 : 104);
    final body = Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Flexible(child: metrics),
        SizedBox(width: narrow ? 14 : 32),
        ring,
      ],
    );
    return Container(
      constraints: BoxConstraints(minHeight: narrow ? 0 : 180),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(24),
        border: Border.all(
          color: Color.lerp(Web.line, Web.primary, 0.78)!,
          width: 2,
        ),
        gradient: const LinearGradient(
          begin: Alignment(-0.82, -0.57),
          end: Alignment(0.82, 0.57),
          stops: [0.08, 1],
          colors: [Web.card, Web.soft],
        ),
        boxShadow: const [
          BoxShadow(
            color: Color(0x5C0D9488),
            offset: Offset(0, 20),
            blurRadius: 34,
            spreadRadius: -18,
          ),
          ...Web.shadow,
        ],
      ),
      clipBehavior: Clip.antiAlias,
      child: Stack(
        children: [
          // ::before — teal glow at the top inline-start corner
          PositionedDirectional(
            start: -90,
            top: -125,
            child: _glow(230, const Color(0x3814B8A6), 0.70),
          ),
          // ::after — amber glow under the card, 22% from the inline end
          Positioned.fill(
            child: LayoutBuilder(
              builder: (context, box) => Stack(
                clipBehavior: Clip.none,
                children: [
                  PositionedDirectional(
                    end: box.maxWidth * 0.22,
                    bottom: -125,
                    child: _glow(170, const Color(0x26F59E0B), 0.72),
                  ),
                ],
              ),
            ),
          ),
          Padding(
            padding: narrow
                ? const EdgeInsets.all(19)
                : const EdgeInsets.symmetric(horizontal: 28, vertical: 24),
            child: narrow
                ? Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [head, const SizedBox(height: 16), body],
                  )
                : ConstrainedBox(
                    constraints: const BoxConstraints(minHeight: 128),
                    child: Row(
                      children: [
                        Expanded(child: head),
                        const SizedBox(width: 28),
                        ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 520),
                          child: SizedBox(width: 520, child: body),
                        ),
                      ],
                    ),
                  ),
          ),
        ],
      ),
    );
  }

  static Widget _glow(double d, Color c, double stop) => IgnorePointer(
    child: Container(
      width: d,
      height: d,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: RadialGradient(
          colors: [c, c.withValues(alpha: 0)],
          stops: [0, stop],
        ),
      ),
    ),
  );
}

class _PulseRing extends StatelessWidget {
  const _PulseRing({required this.ratio, required this.size});
  final int ratio;
  final double size;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: size,
    height: size,
    child: CustomPaint(
      painter: _RingPainter(value: ratio / 100),
      child: Center(
        child: Text(
          '${Web.fa(ratio)}٪',
          key: const Key('pulse-ratio'),
          style: const TextStyle(
            fontSize: 19,
            fontWeight: FontWeight.w900,
            color: Web.ink,
          ),
        ),
      ),
    ),
  );
}

/// `<svg viewBox="0 0 80 80">` r=34, stroke-width 7, rotated −90° (starts at the top).
class _RingPainter extends CustomPainter {
  _RingPainter({required this.value});
  final double value;

  @override
  void paint(Canvas canvas, Size size) {
    final k = size.width / 80;
    final c = Offset(size.width / 2, size.height / 2);
    final rect = Rect.fromCircle(center: c, radius: 34 * k);
    final p = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 7 * k;
    canvas.drawArc(rect, 0, math.pi * 2, false, p..color = Web.line);
    if (value > 0) {
      canvas.drawArc(
        rect,
        -math.pi / 2,
        math.pi * 2 * value.clamp(0, 1),
        false,
        p
          ..color = Web.primary
          ..strokeCap = StrokeCap.round,
      );
    }
  }

  @override
  bool shouldRepaint(_RingPainter old) => old.value != value;
}

/// A stat card of the dashboard (`.stat`): soft icon tile, the number, the label. Keys:
/// `dash-stat-<id>` on the card, `dash-<id>` on the number (unchanged from the old cards).
class PulseStat extends StatelessWidget {
  const PulseStat({
    super.key,
    required this.id,
    required this.icon,
    required this.value,
    required this.label,
    this.tone = PayeshTone.neutral,
  });
  final String id;
  final IconData icon;
  final String value;
  final String label;
  final PayeshTone tone;

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    final color = tone == PayeshTone.neutral ? tk.ink : tk.tone(tone).$1;
    return Container(
      key: Key('dash-stat-$id'),
      padding: const EdgeInsets.all(PayeshTokens.space3),
      decoration: BoxDecoration(
        color: tk.card,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: tk.line),
        boxShadow: [
          BoxShadow(color: tk.glow, blurRadius: 14, offset: const Offset(0, 6)),
        ],
      ),
      child: Row(
        children: [
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: tk.soft,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: tk.primary2.withValues(alpha: 0.35)),
            ),
            child: Icon(icon, color: tk.primary),
          ),
          const SizedBox(width: 12),
          Flexible(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  value,
                  key: Key('dash-$id'),
                  style: TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.w900,
                    color: color,
                  ),
                ),
                Text(label, style: TextStyle(fontSize: 12.5, color: tk.muted)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The stat cards in equal columns (`.stats` grid): 2 on a phone, up to 4 on a wide page.
class PulseStatGrid extends StatelessWidget {
  const PulseStatGrid({super.key, required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      const gap = PayeshTokens.space3;
      final cols = (box.maxWidth / 210).floor().clamp(2, 4);
      final w = (box.maxWidth - gap * (cols - 1)) / cols;
      return Wrap(
        spacing: gap,
        runSpacing: gap,
        children: [for (final c in children) SizedBox(width: w, child: c)],
      );
    },
  );
}

/// Row 172: web `.bottomnav` (below 900px): fixed at the bottom, white with a top line, the
/// pages of `navConfig(role)` as `.bn` (icon over an 11px label; `.bn.on` = primary on soft).
/// Scrolls sideways when the role has more pages than fit.
class PulseBottomNav extends StatelessWidget {
  const PulseBottomNav({
    super.key = const Key('pulse-bottomnav'),
    required this.items,
    required this.selected,
    required this.onSelected,
  });

  final List<PulseNavItem> items;
  final String selected;
  final ValueChanged<String> onSelected;

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.paddingOf(context).bottom;
    return Container(
      decoration: const BoxDecoration(
        color: Web.card,
        border: Border(top: BorderSide(color: Web.line)),
      ),
      padding: EdgeInsets.fromLTRB(4, 6, 4, 6 + bottom),
      child: WebText(
        child: LayoutBuilder(
          builder: (context, box) => SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: ConstrainedBox(
              constraints: BoxConstraints(minWidth: box.maxWidth),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceAround,
                children: [
                  for (final m in items)
                    _PulseBn(
                      key: Key('nav-${m.id}'),
                      icon: m.webIcon,
                      label: m.label,
                      selected: selected == m.id,
                      onTap: () => onSelected(m.id),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _PulseBn extends StatelessWidget {
  const _PulseBn({
    super.key,
    required this.icon,
    required this.label,
    required this.selected,
    required this.onTap,
  });
  final String icon;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = selected ? Web.primary : Web.muted;
    // .bn{gap:2px;font-size:11px;padding:4px 10px;border-radius:10px} .bn .ico{font-size:19px}
    return Semantics(
      button: true,
      selected: selected,
      label: label,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
          decoration: BoxDecoration(
            color: selected ? Web.soft : null,
            borderRadius: BorderRadius.circular(10),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              WebIcon(icon, size: 19, color: c),
              const SizedBox(height: 2),
              Text(
                label,
                style: TextStyle(
                  fontSize: 11,
                  color: c,
                  fontWeight: selected ? FontWeight.w700 : FontWeight.w400,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Row 172: the bars at the top of web `.main` — `canonicalBarHtml` (manager: «☁️ حافظهٔ مشترک
/// ابری هنوز آماده نیست …» with «تنظیم خودکار» / «بستن») and `updateBarHtml` (`.updbar`: the
/// light, «vX — برنامه به‌روز است», the manager's «بررسی آپدیت» / «دانلود و نصب»).
/// The version and its light are this app's own updater (the app updates itself); the cloud
/// state is the school server's `/api/health` `cloud_ready`, read quietly once.
class PulseTopBars extends StatefulWidget {
  const PulseTopBars({
    super.key = const Key('pulse-top'),
    required this.manager,
    this.updater,
    this.admin,
    this.openUrl,
    this.onGo,
    this.sync,
    this.onRetry,
  });

  /// The device's sync state: web `offlineBarHtml` when the school server is out of reach.
  final ValueListenable<SyncStatus>? sync;
  final VoidCallback? onRetry;

  final bool manager;
  final AppUpdater? updater;
  final ServerAdminApi? admin;
  final Future<void> Function(Uri url)? openUrl;
  final ValueChanged<String>? onGo;

  /// Web `localStorage['payesh.originbar.off'] = 'none'` (for this run of the app).
  static bool cloudDismissed = false;

  @override
  State<PulseTopBars> createState() => _PulseTopBarsState();
}

class _PulseTopBarsState extends State<PulseTopBars> {
  ServerHealth? _health;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    if (widget.manager) unawaited(_peek());
  }

  Future<void> _peek() async {
    final a = widget.admin;
    if (a == null) return;
    try {
      final h = await a.health();
      if (mounted) setState(() => _health = h);
    } on AdminFailure {
      // no bar when the school server is out of reach (the web knows it from boot)
    } on Object {
      // same: a quiet read
    }
  }

  void _toast(String text) {
    ScaffoldMessenger.maybeOf(context)
        ?.showSnackBar(SnackBar(content: Text(text)));
  }

  /// Web `cloud-phone-check`: POST /api/admin/cloud/phone-check, toast, then «حافظهٔ ابری».
  Future<void> _cloudCheck() async {
    final a = widget.admin;
    if (a == null || _busy) return;
    setState(() => _busy = true);
    try {
      final r = await a.phoneCheck();
      _toast(
        r.ok ? 'دسترسی گوشی درست شد ✅' : 'هنوز کامل نشد — پایین را ببینید',
      );
      if (r.ok) await _peek();
    } on AdminFailure catch (e) {
      _toast('بررسی انجام نشد: ${e.detail ?? e.kind.name}');
    } finally {
      if (mounted) setState(() => _busy = false);
      widget.onGo?.call('cloud');
    }
  }

  Future<void> _install(AppUpdater u) async {
    if (!u.isWindows && u.apkInstaller == null) {
      await (widget.openUrl ?? u.openUrl)?.call(u.channel.apkUrl);
      return;
    }
    await u.tap();
  }

  Widget _cloudBar() => WebBanner(
    key: const Key('origin-bar'),
    kind: WebBannerKind.warn,
    text: '☁️ حافظهٔ مشترک ابری هنوز آماده نیست — با یک کلیک خودکار تنظیم می‌شود؛ بعد از آن گوشی و خانه هم به همه‌چیز دسترسی دارند.',
    actions: [
      WebBtn(
        'تنظیم خودکار',
        key: const Key('origin-bar-fix'),
        kind: WebBtnKind.primary,
        onPressed: _busy ? null : () => unawaited(_cloudCheck()),
      ),
      WebBtn(
        'بستن',
        key: const Key('origin-bar-off'),
        kind: WebBtnKind.ghost,
        onPressed: () => setState(() => PulseTopBars.cloudDismissed = true),
      ),
    ],
  );

  Widget _updBar(AppUpdater u) {
    final busy =
        u.phase == UpdatePhase.downloading || u.phase == UpdatePhase.applying;
    final ready = u.phase == UpdatePhase.staged;
    final avail = !ready && u.available;
    final next = u.plan?.manifest.build;
    final latest = next == null ? '' : u.channel.versionOf(next);
    final dot = busy
        ? const Color(0xFF2563EB)
        : (ready || avail)
        ? const Color(0xFFF59E0B)
        : const Color(0xFF16A34A);
    final text = busy
        ? 'در حال دانلود ${Web.fa(((u.progress ?? 0) * 100).round())}٪'
        : ready
        ? 'نسخهٔ $latest آمادهٔ نصب است'
        : avail
        ? 'نسخهٔ تازهٔ $latest موجود است'
        : 'برنامه به‌روز است';
    Widget xs(String label, Key key, WebBtnKind kind, VoidCallback? on) =>
        WebBtn(label, key: key, kind: kind, size: WebBtnSize.xs, onPressed: on);
    // .updbar{gap:8px;padding:6px 10px;border-radius:10px;background:#f8fafc;
    //   border:1px solid #e5e7eb;margin:0 0 10px;font-size:.82rem}
    return Container(
      key: const Key('update-bar'),
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: const Color(0xFFF8FAFC),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: const Color(0xFFE5E7EB)),
      ),
      child: Wrap(
        spacing: 8,
        runSpacing: 6,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Container(
            width: 10,
            height: 10,
            decoration: BoxDecoration(
              color: dot,
              shape: BoxShape.circle,
              boxShadow: const [
                BoxShadow(color: Color(0x1F16A34A), spreadRadius: 3),
              ],
            ),
          ),
          Text.rich(
            TextSpan(
              children: [
                TextSpan(
                  text: 'v${u.channel.versionOf(u.currentBuild)}',
                  style: const TextStyle(
                    fontWeight: FontWeight.w700,
                    fontFeatures: Web.numFeatures,
                  ),
                ),
                TextSpan(text: ' — $text'),
              ],
            ),
            key: const Key('update-bar-text'),
            textDirection: TextDirection.rtl,
            style: const TextStyle(fontSize: 12.5, color: Web.ink),
          ),
          if (widget.manager && (avail || ready))
            xs(
              ready ? 'نصب و راه‌اندازی دوباره' : 'دانلود و نصب',
              const Key('update-bar-install'),
              WebBtnKind.primary,
              u.busy ? null : () => unawaited(_install(u)),
            ),
          if (widget.manager && !avail && !ready && !busy)
            xs(
              'بررسی آپدیت',
              const Key('update-bar-check'),
              WebBtnKind.ghost,
              u.busy ? null : () => unawaited(u.check()),
            ),
        ],
      ),
    );
  }

  /// Web `offlineBarHtml` (`S.offline`: the school server is out of reach): «📴 سیستم مدرسه در
  /// دسترس نیست — …» + «N تغییر در صف مانده …» + «اتصال دوباره». Native-only: writes the server
  /// refused (`blocked`, the web has no such state) get one warn line so they are never hidden.
  Widget? _offlineBar(SyncStatus st) {
    if (st.phase == SyncPhase.offline) {
      final q = st.waiting;
      return WebBanner(
        key: const Key('offline-bar'),
        kind: WebBannerKind.warn,
        text:
            '📴 سیستم مدرسه در دسترس نیست — همهٔ فایل‌های برنامه روی همین دستگاه است و آخرین اطلاعات نمایش داده می‌شود.'
            '${q > 0 ? ' ${Web.fa(q)} تغییر در صف مانده و با اولین اتصال ارسال می‌شود.' : ''}',
        textKey: const Key('offline-bar-text'),
        actions: [
          if (widget.onRetry != null)
            WebBtn(
              'اتصال دوباره',
              key: const Key('offline-bar-retry'),
              kind: WebBtnKind.ghost,
              onPressed: widget.onRetry,
            ),
        ],
      );
    }
    if (st.blocked > 0) {
      return WebBanner(
        key: const Key('attention-bar'),
        kind: WebBannerKind.warn,
        text:
            '${Web.fa(st.blocked)} تغییر را سیستم مدرسه نپذیرفت و نیاز به بررسی دارد.',
        textKey: const Key('attention-bar-text'),
        actions: [
          if (widget.onRetry != null)
            WebBtn(
              'تلاش دوباره',
              key: const Key('attention-bar-retry'),
              kind: WebBtnKind.ghost,
              onPressed: widget.onRetry,
            ),
        ],
      );
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final u = widget.updater;
    final sync = widget.sync;
    final cloud =
        widget.manager &&
        !PulseTopBars.cloudDismissed &&
        _health != null &&
        !_health!.cloudReady;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (cloud) _cloudBar(),
        if (u != null)
          StreamBuilder<void>(stream: u.changes, builder: (_, _) => _updBar(u)),
        if (sync != null)
          ValueListenableBuilder<SyncStatus>(
            valueListenable: sync,
            builder: (_, st, _) => _offlineBar(st) ?? const SizedBox.shrink(),
          ),
      ],
    );
  }
}
