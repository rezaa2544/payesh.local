// Row 170 — «نبض» panel of the web client (client/pulse.js + pulse.css, option A of the owner):
// the sidebar dashboard of the manager / users panel, rebuilt in Flutter so the installed apps
// (Windows 64/32-bit, Android) show the SAME panel: sidebar on the right (RTL) with the brand,
// the school name, the pages in the web order and the account; «نبض امروز مدرسه» hero with the
// present count and a ratio ring; stat cards with a soft icon tile and the number in the primary
// colour. On a phone the same pages sit in a drawer.
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:payesh_ui/payesh_ui.dart';

/// Wider than this ⇒ the sidebar is shown and pages open inside the shell.
const double pulseWideBreakpoint = 960;

/// One page of the panel's navigation.
final class PulseNavItem {
  const PulseNavItem({
    required this.id,
    required this.label,
    required this.icon,
    required this.page,
  });
  final String id;
  final String label;
  final IconData icon;

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

/// Marks a page that is shown inside the shell (no back button: the sidebar is the way out).
class PulseInline extends InheritedWidget {
  const PulseInline({super.key, required super.child});

  static bool of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<PulseInline>() != null;

  @override
  bool updateShouldNotify(PulseInline oldWidget) => false;
}

/// The «نبض» sidebar (`.sidebar`): brand, school name, «داشبورد» + pages, account footer.
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

  /// `dashboard` or an item id.
  final String selected;
  final ValueChanged<String> onSelected;
  final String? school;
  final String? account;
  final List<Widget> footer;

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    return Container(
      width: 250,
      decoration: BoxDecoration(
        color: tk.card.withValues(alpha: 0.92),
        border: BorderDirectional(end: BorderSide(color: tk.line)),
      ),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(14, 16, 14, 16),
        children: [
          Row(
            children: [
              const PayeshBrandMark(size: 32),
              const SizedBox(width: 10),
              Flexible(
                child: Text(
                  'پایش',
                  style: TextStyle(
                    fontWeight: FontWeight.w800,
                    fontSize: 17,
                    color: tk.primary,
                  ),
                ),
              ),
            ],
          ),
          if (school case final s? when s.isNotEmpty)
            Padding(
              padding: const EdgeInsetsDirectional.only(
                start: 4,
                top: 10,
                bottom: 6,
              ),
              child: Text(
                s,
                key: const Key('pulse-school'),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 12.5, color: tk.muted),
              ),
            ),
          const SizedBox(height: 6),
          _PulseNavTile(
            key: const Key('nav-dashboard'),
            icon: Icons.home_outlined,
            label: 'داشبورد',
            selected: selected == 'dashboard',
            onTap: () => onSelected('dashboard'),
          ),
          for (final m in items)
            _PulseNavTile(
              key: Key('nav-${m.id}'),
              icon: m.icon,
              label: m.label,
              selected: selected == m.id,
              onTap: () => onSelected(m.id),
            ),
          const SizedBox(height: 14),
          if (account case final a? when a.isNotEmpty) ...[
            Padding(
              padding: const EdgeInsetsDirectional.only(start: 4, bottom: 4),
              child: Text(
                'حساب',
                style: TextStyle(fontSize: 11.5, color: tk.muted),
              ),
            ),
            Padding(
              padding: const EdgeInsetsDirectional.only(start: 4, bottom: 8),
              child: Text(
                a,
                key: const Key('pulse-account'),
                style: TextStyle(fontSize: 13, color: tk.muted),
              ),
            ),
          ],
          ...footer,
        ],
      ),
    );
  }
}

class _PulseNavTile extends StatelessWidget {
  const _PulseNavTile({
    super.key,
    required this.icon,
    required this.label,
    required this.selected,
    required this.onTap,
  });
  final IconData icon;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Semantics(
        button: true,
        selected: selected,
        label: label,
        excludeSemantics: true,
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            borderRadius: BorderRadius.circular(13),
            hoverColor: tk.soft,
            onTap: onTap,
            child: Ink(
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(13),
                gradient: selected ? tk.primaryGradient : null,
                boxShadow: selected
                    ? [
                        BoxShadow(
                          color: tk.glow,
                          blurRadius: 16,
                          offset: const Offset(0, 7),
                          spreadRadius: -7,
                        ),
                      ]
                    : null,
              ),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              child: Row(
                children: [
                  Icon(
                    icon,
                    size: 21,
                    color: selected ? Colors.white : tk.muted,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: selected ? Colors.white : tk.ink,
                        fontWeight: selected
                            ? FontWeight.w700
                            : FontWeight.w500,
                      ),
                    ),
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

/// «نبض امروز مدرسه» (`.pulse-hero`): present count of today, «از N دانش‌آموز حاضر», the
/// present / absent / late dots and the ratio ring.
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
    final tk = context.tokens;
    final narrow = MediaQuery.sizeOf(context).width < 560;
    Widget dot(Color c, String label, int n, String key) => Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 9,
          height: 9,
          decoration: BoxDecoration(color: c, shape: BoxShape.circle),
        ),
        const SizedBox(width: 5),
        Text(
          '$label ${faNumber(n)}',
          key: Key(key),
          style: TextStyle(
            fontSize: 12.5,
            fontWeight: FontWeight.w700,
            color: tk.muted,
          ),
        ),
      ],
    );
    final title = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 42,
          height: 42,
          decoration: BoxDecoration(
            color: tk.card,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: tk.primary2.withValues(alpha: 0.5)),
          ),
          child: Icon(Icons.monitor_heart_outlined, color: tk.primary),
        ),
        const SizedBox(width: 12),
        Flexible(
          child: Text(
            'نبض امروز مدرسه',
            key: const Key('pulse-title'),
            style: TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w800,
              color: tk.ink,
            ),
          ),
        ),
      ],
    );
    final numbers = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          faNumber(present),
          key: const Key('pulse-present'),
          style: TextStyle(
            fontSize: 44,
            height: 1.1,
            fontWeight: FontWeight.w900,
            color: tk.primary2,
          ),
        ),
        Text(
          'از ${faNumber(of)} دانش‌آموز حاضر',
          key: const Key('pulse-of'),
          style: TextStyle(fontWeight: FontWeight.w700, color: tk.muted),
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 14,
          runSpacing: 6,
          children: [
            dot(const Color(0xFF10B981), 'حاضر', present, 'pulse-p'),
            dot(const Color(0xFFF43F5E), 'غایب', absent, 'pulse-a'),
            dot(const Color(0xFFF59E0B), 'تأخیر', late, 'pulse-l'),
          ],
        ),
      ],
    );
    final ring = _PulseRing(ratio: ratio, size: narrow ? 84 : 100);
    return Container(
      padding: const EdgeInsets.all(PayeshTokens.space5),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: tk.ink.withValues(alpha: 0.85), width: 1.5),
        gradient: LinearGradient(
          begin: AlignmentDirectional.topEnd,
          end: AlignmentDirectional.bottomStart,
          colors: [tk.soft, tk.card],
        ),
        boxShadow: [
          BoxShadow(
            color: tk.glow,
            blurRadius: 24,
            offset: const Offset(0, 10),
          ),
        ],
      ),
      child: narrow
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                title,
                const SizedBox(height: PayeshTokens.space3),
                Row(
                  children: [
                    Expanded(child: numbers),
                    ring,
                  ],
                ),
              ],
            )
          : Row(
              children: [
                Flexible(flex: 2, child: title),
                const SizedBox(width: PayeshTokens.space4),
                Expanded(flex: 3, child: numbers),
                ring,
              ],
            ),
    );
  }
}

class _PulseRing extends StatelessWidget {
  const _PulseRing({required this.ratio, required this.size});
  final int ratio;
  final double size;

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    return SizedBox(
      width: size,
      height: size,
      child: CustomPaint(
        painter: _RingPainter(
          value: ratio / 100,
          track: tk.line,
          color: tk.primary2,
        ),
        child: Center(
          child: Text(
            '${faNumber(ratio)}٪',
            key: const Key('pulse-ratio'),
            style: TextStyle(fontWeight: FontWeight.w800, color: tk.ink),
          ),
        ),
      ),
    );
  }
}

class _RingPainter extends CustomPainter {
  _RingPainter({required this.value, required this.track, required this.color});
  final double value;
  final Color track;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final stroke = size.width * 0.1;
    final rect = Offset.zero & size;
    final r = rect.deflate(stroke / 2);
    final p = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.round;
    canvas.drawArc(r, 0, math.pi * 2, false, p..color = track);
    if (value > 0) {
      canvas.drawArc(
        r,
        -math.pi / 2,
        math.pi * 2 * value.clamp(0, 1),
        false,
        p..color = color,
      );
    }
  }

  @override
  bool shouldRepaint(_RingPainter old) =>
      old.value != value || old.color != color || old.track != track;
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
