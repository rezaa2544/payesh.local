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
  });

  final Widget home;

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
    theme: PayeshUi.light(platform: platform),
    darkTheme: PayeshUi.dark(platform: platform),
    themeMode: themeMode,
    home: home,
  );
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
                  borderRadius: BorderRadius.circular(PayeshTokens.radiusSmall),
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
