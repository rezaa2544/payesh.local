// Row 179 — «مینیمال حرفه‌ای» with a user-chosen روشن / تاریک / سیستم mode in every panel.
// One controller + one button, shared by the owner app and the school app (Android, Windows);
// the web panels keep the same choice in localStorage `payesh.theme`.
import 'package:flutter/material.dart';

/// The user's روشن / تاریک / سیستم choice, persisted by the app under [storeKey].
class PayeshThemeMode extends ValueNotifier<ThemeMode> {
  PayeshThemeMode({ThemeMode initial = ThemeMode.system, this.save})
    : super(initial);

  /// Key in the app's store (owner: SecureStore `theme`; school: prefs `theme`).
  static const storeKey = 'theme';

  /// Writes the stored form ([encode]) — called after every change.
  final Future<void> Function(String stored)? save;

  /// `light` / `dark`; anything else (missing, `system`) follows the device.
  static ThemeMode parse(String? stored) => switch (stored) {
    'light' => ThemeMode.light,
    'dark' => ThemeMode.dark,
    _ => ThemeMode.system,
  };

  static String encode(ThemeMode m) => m.name;

  /// سیستم → روشن → تاریک → سیستم.
  static ThemeMode next(ThemeMode m) => switch (m) {
    ThemeMode.system => ThemeMode.light,
    ThemeMode.light => ThemeMode.dark,
    ThemeMode.dark => ThemeMode.system,
  };

  /// Reads the saved choice (call once at start-up).
  Future<void> load(Future<String?> Function(String key) read) async {
    try {
      value = parse(await read(storeKey));
    } on Object {
      // an unreadable store keeps «سیستم»
    }
  }

  Future<void> set(ThemeMode m) async {
    if (m == value) return;
    value = m;
    await save?.call(encode(m));
  }

  Future<void> cycle() => set(next(value));
}

/// «پوسته: …» — the label of every mode.
const payeshThemeLabels = {
  ThemeMode.system: 'پوسته: سیستم',
  ThemeMode.light: 'پوسته: روشن',
  ThemeMode.dark: 'پوسته: تاریک',
};

/// Short names (segmented choice).
const payeshThemeNames = {
  ThemeMode.light: 'روشن',
  ThemeMode.dark: 'تاریک',
  ThemeMode.system: 'سیستم',
};

const payeshThemeIcons = {
  ThemeMode.system: Icons.brightness_auto,
  ThemeMode.light: Icons.light_mode,
  ThemeMode.dark: Icons.dark_mode,
};

/// Makes the app's [PayeshThemeMode] reachable from any page (system page, sidebar…).
class PayeshThemeScope extends InheritedNotifier<PayeshThemeMode> {
  const PayeshThemeScope({
    super.key,
    required PayeshThemeMode controller,
    required super.child,
  }) : super(notifier: controller);

  static PayeshThemeMode? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<PayeshThemeScope>()?.notifier;
}

/// Icon-only button that cycles سیستم → روشن → تاریک (the name is in the tooltip).
class PayeshThemeButton extends StatelessWidget {
  const PayeshThemeButton({
    super.key = const Key('theme'),
    this.controller,
    this.compact = false,
  });

  /// Defaults to the nearest [PayeshThemeScope].
  final PayeshThemeMode? controller;

  /// A small 32 px button (the school app's top strip).
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final c = controller ?? PayeshThemeScope.maybeOf(context);
    if (c == null) return const SizedBox.shrink();
    return ValueListenableBuilder<ThemeMode>(
      valueListenable: c,
      builder: (context, mode, _) => IconButton(
        tooltip: payeshThemeLabels[mode],
        icon: Icon(payeshThemeIcons[mode], size: compact ? 18 : null),
        visualDensity: compact ? VisualDensity.compact : null,
        constraints: compact
            ? const BoxConstraints.tightFor(width: 32, height: 32)
            : null,
        padding: compact ? EdgeInsets.zero : null,
        onPressed: c.cycle,
      ),
    );
  }
}

/// روشن · تاریک · سیستم as three segments (settings pages).
class PayeshThemeChoice extends StatelessWidget {
  const PayeshThemeChoice({
    super.key = const Key('theme-choice'),
    this.controller,
  });

  final PayeshThemeMode? controller;

  @override
  Widget build(BuildContext context) {
    final c = controller ?? PayeshThemeScope.maybeOf(context);
    if (c == null) return const SizedBox.shrink();
    return ValueListenableBuilder<ThemeMode>(
      valueListenable: c,
      builder: (context, mode, _) => SegmentedButton<ThemeMode>(
        showSelectedIcon: false,
        segments: [
          for (final m in const [
            ThemeMode.light,
            ThemeMode.dark,
            ThemeMode.system,
          ])
            ButtonSegment(
              value: m,
              icon: Icon(payeshThemeIcons[m], size: 18),
              label: Text(payeshThemeNames[m]!, key: Key('theme-${m.name}')),
            ),
        ],
        selected: {mode},
        onSelectionChanged: (s) => c.set(s.first),
      ),
    );
  }
}

/// Calls [onTheme] with the resolved theme before the app's pages build; when it reports a
/// change, every page below is rebuilt once (widgets that paint from static palettes — the
/// school app's web-parity [Web] colours — pick up روشن / تاریک without a restart).
class PayeshThemeSync extends StatefulWidget {
  const PayeshThemeSync({
    super.key,
    required this.onTheme,
    required this.child,
  });

  final bool Function(ThemeData theme) onTheme;
  final Widget child;

  @override
  State<PayeshThemeSync> createState() => _PayeshThemeSyncState();
}

class _PayeshThemeSyncState extends State<PayeshThemeSync> {
  bool _dirty = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (widget.onTheme(Theme.of(context))) _dirty = true;
  }

  @override
  Widget build(BuildContext context) {
    if (_dirty) {
      _dirty = false;
      void mark(Element e) {
        e.markNeedsBuild();
        e.visitChildren(mark);
      }

      // descendants only (allowed during this build)
      (context as Element).visitChildren(mark);
    }
    return widget.child;
  }
}
