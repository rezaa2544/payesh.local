import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'digits.dart';
import 'jalali.dart';
import 'theme.dart';
import 'tokens.dart';

/// MaterialApp preset: Persian locale (→ RTL), Material/Widgets/Cupertino fa localisations,
/// light + dark themes, follows the system theme by default.
class PayeshMaterialApp extends StatelessWidget {
  const PayeshMaterialApp({
    super.key,
    required this.home,
    this.title = 'پایش',
    this.themeMode = ThemeMode.system,
    this.platform,
    this.navigatorKey,
    this.look = PayeshLook.classic,
    this.overlay,
  });

  final Widget home;

  /// Always-visible widget above every page, top-centre (row 148: the school app's version +
  /// update light). Sits in the navigator's own [Overlay] so tooltips work; taps outside it
  /// reach the page below.
  final Widget? overlay;

  /// Visual language: the owner panel uses [PayeshLook.nabd] (the user panel's «نبض»).
  final PayeshLook look;

  /// Lets the app close dialogs/sheets when the session ends (owner app, row 126).
  final GlobalKey<NavigatorState>? navigatorKey;
  final String title;
  final ThemeMode themeMode;
  final TargetPlatform? platform;

  @override
  Widget build(BuildContext context) => MaterialApp(
    navigatorKey: navigatorKey,
    title: title,
    debugShowCheckedModeBanner: false,
    locale: PayeshUi.locale,
    supportedLocales: const [PayeshUi.locale],
    localizationsDelegates: GlobalMaterialLocalizations.delegates,
    theme: PayeshUi.light(platform: platform, look: look),
    darkTheme: PayeshUi.dark(platform: platform, look: look),
    themeMode: themeMode,
    home: home,
    builder: overlay == null
        ? null
        : (context, child) => _TopOverlay(overlay: overlay!, child: child),
  );
}

/// Page + an always-visible widget at the top centre, both inside one [Overlay] so the widget
/// gets tooltips and taps outside it fall through to the page.
class _TopOverlay extends StatefulWidget {
  const _TopOverlay({required this.overlay, required this.child});
  final Widget overlay;
  final Widget? child;

  @override
  State<_TopOverlay> createState() => _TopOverlayState();
}

class _TopOverlayState extends State<_TopOverlay> {
  late final OverlayEntry _page = OverlayEntry(
    builder: (_) => widget.child ?? const SizedBox.shrink(),
  );
  late final OverlayEntry _top = OverlayEntry(
    builder: (_) => SafeArea(
      child: Align(
        alignment: Alignment.topCenter,
        child: Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Material(
            type: MaterialType.transparency,
            child: widget.overlay,
          ),
        ),
      ),
    ),
  );

  @override
  void didUpdateWidget(covariant _TopOverlay old) {
    super.didUpdateWidget(old);
    _page.markNeedsBuild();
    _top.markNeedsBuild();
  }

  // initialEntries belong to the Overlay: it drops them together with itself.
  @override
  Widget build(BuildContext context) => Overlay(initialEntries: [_page, _top]);
}

/// «نبض» page background (client/pulse.css `body`): the surface colour with a teal wash from the
/// top-start corner and a warm wash from the bottom-end corner. Classic: just the surface colour.
class PayeshBackdrop extends StatelessWidget {
  const PayeshBackdrop({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    if (!t.isNabd) return ColoredBox(color: t.bg, child: child);
    final dark = Theme.of(context).brightness == Brightness.dark;
    return DecoratedBox(
      key: const Key('payesh-backdrop'),
      decoration: BoxDecoration(color: t.bg),
      child: DecoratedBox(
        decoration: BoxDecoration(
          gradient: RadialGradient(
            center: AlignmentDirectional.topStart.resolve(
              Directionality.of(context),
            ),
            radius: 1.1,
            colors: [
              t.primary2.withValues(alpha: dark ? 0.10 : 0.08),
              t.primary2.withValues(alpha: 0),
            ],
          ),
        ),
        child: DecoratedBox(
          decoration: BoxDecoration(
            gradient: RadialGradient(
              center: AlignmentDirectional.bottomEnd.resolve(
                Directionality.of(context),
              ),
              radius: 1.0,
              colors: [
                t.accent.withValues(alpha: 0.06),
                t.accent.withValues(alpha: 0),
              ],
            ),
          ),
          child: child,
        ),
      ),
    );
  }
}

/// «نبض» brand tile: the app icon on the primary gradient (owner-panel/web `.brand-mark`).
class PayeshBrandMark extends StatelessWidget {
  const PayeshBrandMark({
    super.key,
    this.size = 36,
    this.icon = Icons.monitor_heart_outlined,
  });

  final double size;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        gradient: t.primaryGradient,
        borderRadius: BorderRadius.circular(size * 0.32),
        boxShadow: t.isNabd
            ? [
                BoxShadow(
                  color: t.primary2.withValues(alpha: 0.25),
                  blurRadius: 12,
                  offset: const Offset(0, 4),
                ),
              ]
            : null,
      ),
      child: Icon(
        icon,
        size: size * 0.58,
        color: Theme.of(context).colorScheme.onPrimary,
      ),
    );
  }
}

/// Shows an ISO date as Jalali with Persian digits; screen readers get the weekday too.
class JalaliDateText extends StatelessWidget {
  const JalaliDateText(this.iso, {super.key, this.short = false, this.style});

  final String? iso;
  final bool short;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) {
    final d = JalaliDate.fromIso(iso);
    final text = d == null ? '—' : (short ? d.formatShort() : d.format());
    return Semantics(
      container: true,
      label: d == null ? 'تاریخ نامشخص' : d.format(weekday: true),
      excludeSemantics: true,
      child: Text(text, style: style),
    );
  }
}

/// Integer with Persian digits and thousands separators.
class FaNumberText extends StatelessWidget {
  const FaNumberText(this.value, {super.key, this.style});

  final int value;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) => Text(faNumber(value), style: style);
}

/// Small status pill. Colour is never the only signal: the label is always text.
class StatusBadge extends StatelessWidget {
  const StatusBadge(
    this.label, {
    super.key,
    this.tone = PayeshTone.neutral,
    this.icon,
  });

  final String label;
  final PayeshTone tone;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final (fg, bg) = context.tokens.tone(tone);
    return Semantics(
      container: true,
      label: label,
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.symmetric(
          horizontal: PayeshTokens.space3,
          vertical: PayeshTokens.space1,
        ),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(999),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (icon != null) ...[
              Icon(icon, size: 16, color: fg),
              const SizedBox(width: PayeshTokens.space1),
            ],
            Text(
              label,
              style: Theme.of(context).textTheme.labelMedium
                  ?.copyWith(color: fg),
            ),
          ],
        ),
      ),
    );
  }
}

/// Titled card section (the web `.card` with `h3`).
class PayeshSection extends StatelessWidget {
  const PayeshSection({
    super.key,
    required this.title,
    required this.child,
    this.trailing,
  });

  final String title;
  final Widget child;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(PayeshTokens.space4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Semantics(
                    header: true,
                    child: Text(
                      title,
                      style: t.titleMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                ),
                ?trailing,
              ],
            ),
            const SizedBox(height: PayeshTokens.space3),
            child,
          ],
        ),
      ),
    );
  }
}

/// Dashboard number tile.
class StatTile extends StatelessWidget {
  const StatTile({
    super.key,
    required this.label,
    required this.value,
    required this.icon,
    this.tone = PayeshTone.neutral,
  });

  final String label;
  final int value;
  final IconData icon;
  final PayeshTone tone;

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    final (fg, bg) = tk.tone(tone);
    final t = Theme.of(context).textTheme;
    return Semantics(
      container: true,
      label: '$label: ${faNumber(value)}',
      excludeSemantics: true,
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(PayeshTokens.space4),
          child: Row(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: bg,
                  borderRadius: BorderRadius.circular(
                    tk.isNabd ? PayeshTokens.radius : PayeshTokens.radiusSmall,
                  ),
                ),
                child: Icon(icon, color: fg),
              ),
              const SizedBox(width: PayeshTokens.space3),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(label, style: t.bodyMedium?.copyWith(color: tk.muted)),
                    Text(
                      faNumber(value),
                      style: t.headlineSmall?.copyWith(
                        fontWeight: FontWeight.w700,
                        // «نبض»: the number is the hero, in the primary colour (`.stat b`)
                        color: tk.isNabd ? tk.primary : null,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

final class PayeshDestination {
  const PayeshDestination({
    required this.label,
    required this.icon,
    IconData? selectedIcon,
  }) : selectedIcon = selectedIcon ?? icon;
  final String label;
  final IconData icon;
  final IconData selectedIcon;
}

/// One layout for both platforms: bottom navigation on a phone (compact), navigation rail on
/// a tablet / Windows window (medium+, extended labels when expanded). In RTL the rail sits on
/// the right automatically.
class AdaptiveScaffold extends StatelessWidget {
  const AdaptiveScaffold({
    super.key,
    required this.title,
    required this.destinations,
    required this.selected,
    required this.onSelected,
    required this.body,
    this.actions = const [],
  }) : assert(destinations.length >= 2);

  final String title;
  final List<PayeshDestination> destinations;
  final int selected;
  final ValueChanged<int> onSelected;
  final Widget body;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    final size = sizeClassOf(MediaQuery.sizeOf(context).width);
    final appBar = AppBar(title: Text(title), actions: actions);
    if (size == SizeClass.compact) {
      return Scaffold(
        appBar: appBar,
        body: SafeArea(child: body),
        bottomNavigationBar: NavigationBar(
          key: const Key('nav-bar'),
          selectedIndex: selected,
          onDestinationSelected: onSelected,
          destinations: [
            for (final d in destinations)
              NavigationDestination(
                icon: Icon(d.icon),
                selectedIcon: Icon(d.selectedIcon),
                label: d.label,
              ),
          ],
        ),
      );
    }
    final extended = size == SizeClass.expanded;
    return Scaffold(
      appBar: appBar,
      body: SafeArea(
        child: Row(
          children: [
            NavigationRail(
              key: const Key('nav-rail'),
              extended: extended,
              labelType: extended
                  ? NavigationRailLabelType.none
                  : NavigationRailLabelType.all,
              selectedIndex: selected,
              onDestinationSelected: onSelected,
              destinations: [
                for (final d in destinations)
                  NavigationRailDestination(
                    icon: Icon(d.icon),
                    selectedIcon: Icon(d.selectedIcon),
                    label: Text(d.label),
                  ),
              ],
            ),
            VerticalDivider(width: 1, color: context.tokens.line),
            Expanded(child: body),
          ],
        ),
      ),
    );
  }
}
