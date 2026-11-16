// Row 165 — the signed-in home of the school app: a clean header card and a grid of EQUAL tiles,
// grouped under short section titles (Material 3 "launcher" pattern). Every tile has the same
// size, an icon on a tinted rounded square, and a label of at most two lines; columns follow the
// width (3 on a phone, 4 on a tablet, 6 on a desktop).
import 'package:flutter/material.dart';

import 'theme.dart';
import 'tokens.dart';

/// One home destination.
class PayeshTile extends StatelessWidget {
  const PayeshTile({
    super.key,
    required this.icon,
    required this.label,
    required this.onTap,
    this.tone = PayeshTone.info,
    this.badge,
  });

  final IconData icon;
  final String label;
  final VoidCallback? onTap;

  /// Colour family of the icon square (one per section keeps the grid calm and scannable).
  final PayeshTone tone;

  /// Small count / dot in the top corner (e.g. unread notices); null = none.
  final String? badge;

  static const double height = 116;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final (fg, bg) = t.tone(tone);
    final radius = BorderRadius.circular(t.cardRadius);
    return Semantics(
      button: true,
      label: label,
      excludeSemantics: true,
      child: Material(
        color: t.card,
        shape: RoundedRectangleBorder(
          borderRadius: radius,
          side: BorderSide(color: t.line),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: SizedBox(
            height: height,
            child: Stack(
              fit: StackFit.expand,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(8, 12, 8, 8),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        width: 44,
                        height: 44,
                        decoration: BoxDecoration(
                          color: bg,
                          borderRadius: BorderRadius.circular(14),
                        ),
                        child: Icon(icon, color: fg, size: 24),
                      ),
                      const SizedBox(height: 8),
                      Flexible(
                        child: Text(
                          label,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            fontSize: 13.5,
                            height: 1.35,
                            fontWeight: FontWeight.w600,
                            color: t.ink,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                if (badge != null)
                  PositionedDirectional(
                    top: 8,
                    end: 8,
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 6,
                        vertical: 1,
                      ),
                      decoration: BoxDecoration(
                        color: t.danger,
                        borderRadius: BorderRadius.circular(99),
                      ),
                      child: Text(
                        badge!,
                        style: TextStyle(
                          color: t.card,
                          fontSize: 11,
                          fontWeight: FontWeight.w700,
                        ),
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

/// Columns for a width: 3 phone, 4 tablet, 6 desktop (never narrower than ~96 px per tile).
int payeshTileColumns(double width) {
  if (width >= 900) return 6;
  if (width >= 560) return 4;
  if (width < 300) return 2;
  return 3;
}

/// Equal tiles in rows; the last row is start-aligned (never stretched).
class PayeshTileGrid extends StatelessWidget {
  const PayeshTileGrid({super.key, required this.children, this.gap = 10});

  final List<Widget> children;
  final double gap;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      final cols = payeshTileColumns(box.maxWidth);
      final w = (box.maxWidth - gap * (cols - 1)) / cols;
      return Wrap(
        spacing: gap,
        runSpacing: gap,
        children: [for (final c in children) SizedBox(width: w, child: c)],
      );
    },
  );
}

/// A titled group of tiles on the home.
class PayeshTileSection extends StatelessWidget {
  const PayeshTileSection({
    super.key,
    required this.title,
    required this.tiles,
  });

  final String title;
  final List<Widget> tiles;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsetsDirectional.only(start: 4, bottom: 10),
          child: Semantics(
            header: true,
            child: Text(
              title,
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w700,
                letterSpacing: 0,
                color: t.muted,
              ),
            ),
          ),
        ),
        PayeshTileGrid(children: tiles),
      ],
    );
  }
}

/// Header card of the signed-in home: avatar, school name, role chip and the connection line.
class PayeshHeaderCard extends StatelessWidget {
  const PayeshHeaderCard({
    super.key,
    required this.title,
    this.titleKey,
    this.chips = const [],
    this.lines = const [],
    this.icon = Icons.apartment_rounded,
  });

  final String title;
  final Key? titleKey;
  final List<Widget> chips;
  final List<Widget> lines;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(t.cardRadius + 2),
        gradient: LinearGradient(
          begin: AlignmentDirectional.topStart.resolve(
            Directionality.of(context),
          ),
          end: AlignmentDirectional.bottomEnd.resolve(
            Directionality.of(context),
          ),
          colors: [
            Color.alphaBlend(
              t.primary.withValues(alpha: dark ? 0.22 : 0.10),
              t.card,
            ),
            t.card,
          ],
        ),
        border: Border.all(color: t.line),
      ),
      padding: const EdgeInsets.all(PayeshTokens.space4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 52,
            height: 52,
            decoration: BoxDecoration(
              gradient: t.primaryGradient,
              borderRadius: BorderRadius.circular(16),
            ),
            child: Icon(
              icon,
              color: Theme.of(context).colorScheme.onPrimary,
              size: 28,
            ),
          ),
          const SizedBox(width: PayeshTokens.space3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  key: titleKey,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 18,
                    height: 1.4,
                    fontWeight: FontWeight.w800,
                    color: t.ink,
                  ),
                ),
                if (chips.isNotEmpty) ...[
                  const SizedBox(height: 6),
                  Wrap(spacing: 6, runSpacing: 6, children: chips),
                ],
                for (final l in lines) ...[
                  const SizedBox(height: 6),
                  DefaultTextStyle.merge(
                    style: TextStyle(color: t.muted, fontSize: 12.5),
                    child: l,
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}
