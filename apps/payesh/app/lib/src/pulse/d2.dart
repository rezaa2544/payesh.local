// Row 180 — design 2 «مینیمال حرفه‌ای» of design/payesh-ui-proposals.html, drawn as specified
// (the owner: «مو به مو مثل خودش»). The manager home's `.mgrid` blocks: the attendance ring,
// the week bars, the absent / notice lists with outlined icon boxes, the card head with a violet
// «همه ›» link, the greeting row with the new-notice button, a bell and the avatar.
import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'web.dart';

/// `.card` of design 2: surface, hairline, radius 10, padding 16/18.
class D2Card extends StatelessWidget {
  const D2Card({super.key, required this.child, this.padding});
  final Widget child;
  final EdgeInsetsGeometry? padding;

  @override
  Widget build(BuildContext context) => Container(
    padding:
        padding ?? const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
    decoration: BoxDecoration(
      color: Web.card,
      // row 190: a stronger frame and a faint lift so the blocks stand apart
      border: Border.all(color: Web.frame),
      borderRadius: BorderRadius.circular(10),
      boxShadow: Web.shadow,
    ),
    child: child,
  );
}

/// `.card-h`: h3 (14 w700) + optional muted small, and the violet `.lnk` «همه ›» at the end.
class D2CardHead extends StatelessWidget {
  const D2CardHead({
    super.key,
    required this.title,
    this.sub,
    this.link,
    this.onLink,
    this.linkKey,
  });
  final String title;
  final String? sub;
  final String? link;
  final VoidCallback? onLink;
  final Key? linkKey;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Row(
      children: [
        Expanded(
          child: Text.rich(
            TextSpan(
              children: [
                TextSpan(
                  text: title,
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w700,
                    color: Web.ink,
                  ),
                ),
                if (sub != null)
                  TextSpan(
                    text: '  $sub',
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w500,
                      color: Web.muted,
                    ),
                  ),
              ],
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
        if (link != null)
          InkWell(
            key: linkKey,
            onTap: onLink,
            borderRadius: BorderRadius.circular(6),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    link!,
                    style: TextStyle(fontSize: 12.5, color: Web.link),
                  ),
                  const SizedBox(width: 2),
                  Icon(Icons.chevron_left_rounded, size: 16, color: Web.link),
                ],
              ),
            ),
          ),
      ],
    ),
  );
}

/// `.ring` (112, inner 96): a violet arc of [percent] on the track, «۹۴٪ / حاضر» inside.
class D2Ring extends StatelessWidget {
  const D2Ring({
    super.key,
    required this.percent,
    this.label = 'حاضر',
    this.size = 112,
  });
  final int percent;
  final String label;
  final double size;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: size,
    height: size,
    child: CustomPaint(
      painter: _RingPainter(percent / 100, Web.link, Web.track),
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              '${Web.fa(percent)}٪',
              key: const Key('d2-ring-value'),
              style: TextStyle(
                fontSize: size * 0.25,
                fontWeight: FontWeight.w800,
                height: 1,
                color: Web.ink,
                fontFeatures: Web.numFeatures,
              ),
            ),
            const SizedBox(height: 4),
            Text(label, style: TextStyle(fontSize: 12, color: Web.muted)),
          ],
        ),
      ),
    ),
  );
}

class _RingPainter extends CustomPainter {
  _RingPainter(this.value, this.color, this.track);
  final double value;
  final Color color, track;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width * (10 / 112);
    final rect = Offset.zero & size;
    final r = rect.deflate(w / 2);
    canvas.drawArc(
      r,
      0,
      math.pi * 2,
      false,
      Paint()
        ..color = track
        ..style = PaintingStyle.stroke
        ..strokeWidth = w,
    );
    if (value > 0) {
      // conic-gradient starts at 12 o'clock and runs clockwise
      canvas.drawArc(
        r,
        -math.pi / 2,
        math.pi * 2 * value.clamp(0, 1),
        false,
        Paint()
          ..color = color
          ..style = PaintingStyle.stroke
          ..strokeWidth = w,
      );
    }
  }

  @override
  bool shouldRepaint(_RingPainter old) =>
      old.value != value || old.color != color || old.track != track;
}

/// `.chip` of design 2: outlined, radius 6, 12px w500; the status chips keep their colour text.
class D2Chip extends StatelessWidget {
  const D2Chip(this.text, {super.key, this.color});
  final String text;
  final Color? color;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
    decoration: BoxDecoration(
      border: Border.all(color: Web.line),
      borderRadius: BorderRadius.circular(6),
    ),
    child: Text(
      text,
      style: TextStyle(
        fontSize: 12,
        fontWeight: FontWeight.w500,
        color: color ?? Web.ink2,
        fontFeatures: Web.numFeatures,
      ),
    ),
  );
}

/// `.bars`: 120px high, 12 apart, the bar ≤ 38 wide radius 4, today violet; the weekday letter.
class D2Bars extends StatelessWidget {
  const D2Bars({super.key, required this.days});

  /// (letter, percent, today).
  final List<(String, int, bool)> days;

  @override
  Widget build(BuildContext context) => SizedBox(
    height: 120,
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        for (final (i, (letter, v, on)) in days.indexed) ...[
          if (i > 0) const SizedBox(width: 12),
          Expanded(
            child: Tooltip(
              message: '${Web.fa(v)}٪',
              child: Column(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  Expanded(
                    child: Align(
                      alignment: Alignment.bottomCenter,
                      child: FractionallySizedBox(
                        heightFactor: math.max(4, v) / 100,
                        child: Container(
                          key: Key('d2-bar-$i'),
                          constraints: const BoxConstraints(maxWidth: 38),
                          decoration: BoxDecoration(
                            color: on ? Web.link : Web.track,
                            borderRadius: BorderRadius.circular(4),
                          ),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    letter,
                    style: TextStyle(fontSize: 11.5, color: Web.muted),
                  ),
                ],
              ),
            ),
          ),
        ],
      ],
    ),
  );
}

/// `.av` of design 2: 28 (radius 7) initial on the avatar background.
class D2Avatar extends StatelessWidget {
  const D2Avatar(this.name, {super.key, this.size = 28, this.me = false});
  final String name;
  final double size;
  final bool me;

  @override
  Widget build(BuildContext context) {
    final t = name.trim();
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: me
            ? Web.primary
            : (Web.dark ? const Color(0xFF26262B) : Web.soft),
        borderRadius: BorderRadius.circular(size >= 34 ? 8 : 7),
      ),
      child: Text(
        t.isEmpty ? '؟' : t.characters.first,
        style: TextStyle(
          fontSize: size * 0.43,
          fontWeight: FontWeight.w700,
          color: me ? Web.onPrimary : Web.ink2,
        ),
      ),
    );
  }
}

/// `.n-ic`: an outlined 36px box (radius 8) with an icon.
class D2IconBox extends StatelessWidget {
  const D2IconBox(this.icon, {super.key, this.size = 36, this.color});
  final IconData icon;
  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(
      border: Border.all(color: Web.line),
      borderRadius: BorderRadius.circular(8),
    ),
    child: Icon(icon, size: size / 2, color: color ?? Web.ink2),
  );
}

/// `.lst li`: leading, `.nm` (b 13 w700 + small 11.5 muted), trailing; hairline between rows.
class D2List extends StatelessWidget {
  const D2List({super.key, required this.rows});
  final List<D2Row> rows;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      for (final (i, r) in rows.indexed)
        Container(
          decoration: BoxDecoration(
            border: i == rows.length - 1
                ? null
                : Border(bottom: BorderSide(color: Web.line)),
          ),
          child: InkWell(
            onTap: r.onTap,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Row(
                key: r.key,
                children: [
                  r.leading,
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          r.title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w700,
                            color: Web.ink,
                          ),
                        ),
                        if (r.sub.isNotEmpty)
                          Text(
                            r.sub,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 11.5, color: Web.muted),
                          ),
                      ],
                    ),
                  ),
                  if (r.trailing != null) ...[
                    const SizedBox(width: 8),
                    r.trailing!,
                  ],
                ],
              ),
            ),
          ),
        ),
    ],
  );
}

final class D2Row {
  const D2Row({
    this.key,
    required this.leading,
    required this.title,
    this.sub = '',
    this.trailing,
    this.onTap,
  });
  final Key? key;
  final Widget leading;
  final String title, sub;
  final Widget? trailing;
  final VoidCallback? onTap;
}

/// `.icon-b`: a 38px outlined square (radius 8) with an icon and an optional red dot.
class D2IconButton extends StatelessWidget {
  const D2IconButton({
    super.key,
    required this.icon,
    required this.tooltip,
    this.onPressed,
    this.dot = false,
  });
  final IconData icon;
  final String tooltip;
  final VoidCallback? onPressed;
  final bool dot;

  @override
  Widget build(BuildContext context) => Tooltip(
    message: tooltip,
    child: Semantics(
      button: true,
      label: tooltip,
      child: InkWell(
        onTap: onPressed,
        borderRadius: BorderRadius.circular(8),
        child: Container(
          width: 38,
          height: 38,
          decoration: BoxDecoration(
            color: Web.card,
            border: Border.all(color: Web.line),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Stack(
            alignment: Alignment.center,
            children: [
              Icon(icon, size: 18, color: Web.ink2),
              if (dot)
                PositionedDirectional(
                  top: 8,
                  end: 9,
                  child: Container(
                    width: 8,
                    height: 8,
                    decoration: BoxDecoration(
                      color: Web.red,
                      shape: BoxShape.circle,
                      border: Border.all(color: Web.card, width: 2),
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

/// Two columns `1.25fr 1fr` with a 14px gap above 900px; stacked below.
class D2Grid extends StatelessWidget {
  const D2Grid({super.key, required this.rows});

  /// Pairs of (start, end) cells, top to bottom.
  final List<(Widget, Widget)> rows;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, c) {
      if (c.maxWidth < 760) {
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final (i, (a, b)) in rows.indexed) ...[
              if (i > 0) const SizedBox(height: 14),
              a,
              const SizedBox(height: 14),
              b,
            ],
          ],
        );
      }
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final (i, (a, b)) in rows.indexed) ...[
            if (i > 0) const SizedBox(height: 14),
            IntrinsicHeight(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Expanded(flex: 125, child: a),
                  const SizedBox(width: 14),
                  Expanded(flex: 100, child: b),
                ],
              ),
            ),
          ],
        ],
      );
    },
  );
}
