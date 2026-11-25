// منوی پنل مالک بر اساس کارکرد (ردیف ۱۵۱ · درخواست مالک ۲۰۲۶‑۱۱‑۱۳).
//
// صفحه‌های سروری همان ownerPages پنل وب است (برابری با apps/owner-panel/web/app.js
// در parity_test)؛ اینجا فقط «چیدمان منو» تعیین می‌شود: هر صفحه دقیقاً یک بار، در
// گروه کارکردی خودش. صفحه‌های محلی پنل بومی (پرداخت‌ها، پشتیبانی، نگهبان هوشمند، پشتیبان دیتابیس، تنظیمات) هم جای
// ثابت دارند و فقط وقتی امکانش هست دیده می‌شوند.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:payesh_ui/payesh_ui.dart';

/// یک گروه منو: عنوان + شناسهٔ صفحه‌ها به همان ترتیب نمایش.
typedef OwnerMenuGroup = ({String id, String title, List<String> pages});

// Row 180 (design 2, exact): three sections as drawn — «اصلی»، «کسب‌وکار»، «سیستم».
const List<OwnerMenuGroup> ownerMenuGroups = [
  (
    id: 'main',
    title: 'اصلی',
    pages: ['dashboard', 'schools', 'operators', 'support'],
  ),
  (
    id: 'business',
    title: 'کسب‌وکار',
    pages: ['plans', 'payments', 'limits', 'infra', 'health', 'guard'],
  ),
  (
    id: 'system',
    title: 'سیستم',
    pages: ['reports', 'audit', 'backup', 'settings'],
  ),
];

/// عنوان صفحه‌های محلی (غیر از ownerPages).
const Map<String, String> localPageTitles = {
  'payments': 'پرداخت‌ها',
  'support': 'پشتیبانی',
  'guard': 'نگهبان هوشمند',
  'backup': 'پشتیبان دیتابیس',
  'settings': 'تنظیمات',
};

const Map<String, IconData> ownerMenuIcons = {
  'dashboard': Icons.space_dashboard_outlined,
  'schools': Icons.school_outlined,
  'operators': Icons.admin_panel_settings_outlined,
  'support': Icons.support_agent_outlined,
  'plans': Icons.credit_card_outlined,
  'payments': Icons.receipt_long_outlined,
  'limits': Icons.data_usage_outlined,
  'infra': Icons.dns_outlined,
  'health': Icons.monitor_heart_outlined,
  'guard': Icons.shield_outlined,
  'backup': Icons.backup_outlined,
  'reports': Icons.description_outlined,
  'audit': Icons.verified_user_outlined,
  'settings': Icons.settings_outlined,
};

/// یک مورد منو.
typedef OwnerMenuItem = ({String id, String title, String group});

/// فهرست تخت منو به ترتیب گروه‌ها. [local] = صفحه‌های محلی که الان در دسترس‌اند.
List<OwnerMenuItem> ownerMenu({Set<String> local = const {}}) {
  final titles = {for (final (id, t) in ownerPages) id: t, ...localPageTitles};
  final server = {for (final (id, _) in ownerPages) id};
  final out = <OwnerMenuItem>[];
  for (final g in ownerMenuGroups) {
    for (final id in g.pages) {
      if (server.contains(id) || local.contains(id)) {
        out.add((id: id, title: titles[id]!, group: g.id));
      }
    }
  }
  return out;
}

/// عنوان گروه.
String menuGroupTitle(String id) =>
    ownerMenuGroups.firstWhere((g) => g.id == id).title;

/// نوار کناری «نبض» (همان .sidebar / .navgroup / .navitem پنل کاربران): کارت با خط
/// جداکننده، عنوان گروه‌ها کم‌رنگ، مورد فعال با گرادیان اصلی و سایهٔ درخشان.
class NabdSideNav extends StatelessWidget {
  const NabdSideNav({
    super.key = const Key('nav-rail'),
    required this.items,
    required this.selected,
    required this.onSelected,
    required this.extended,
    this.leading,
    this.account,
    this.roleKey,
    this.footActions = const [],
  });
  final List<OwnerMenuItem> items;
  final int selected;
  final ValueChanged<int> onSelected;
  final bool extended;
  final Widget? leading;

  /// Row 180 design 2: the foot of the sidebar («name», «role»).
  final (String, String)? account;

  /// Row 180: the key of the role line in the foot (e.g. `role-platform_owner`).
  final Key? roleKey;

  /// Row 180: small icon actions at the end of the account foot (theme, sign out).
  final List<Widget> footActions;

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    if (tk.isMinimal && extended) return _MinimalSideNav(nav: this);
    return Container(
      width: extended ? 260 : 92,
      decoration: BoxDecoration(
        color: tk.card.withValues(alpha: 0.86),
        border: BorderDirectional(end: BorderSide(color: tk.line)),
      ),
      child: ListView(
        padding: const EdgeInsets.all(14),
        children: [
          if (leading != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Align(
                alignment: extended
                    ? AlignmentDirectional.centerStart
                    : Alignment.center,
                child: leading,
              ),
            ),
          for (final (i, m) in items.indexed) ...[
            if (i == 0 || items[i - 1].group != m.group)
              extended
                  ? Padding(
                      key: Key('nav-group-${m.group}'),
                      padding: const EdgeInsetsDirectional.only(
                        start: 4,
                        top: 14,
                        bottom: 4,
                      ),
                      child: Text(
                        menuGroupTitle(m.group),
                        style: TextStyle(
                          fontSize: 11.5,
                          letterSpacing: 0.3,
                          color: tk.muted,
                        ),
                      ),
                    )
                  : Padding(
                      key: Key('nav-group-${m.group}'),
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      child: Divider(height: 1, color: tk.line),
                    ),
            _NabdNavItem(
              key: Key('nav-${m.id}'),
              item: m,
              selected: i == selected,
              extended: extended,
              onTap: () => onSelected(i),
            ),
          ],
        ],
      ),
    );
  }
}

/// Row 180 — design 2 `.nav` of the owner panel, as drawn: 240 wide on the nav surface,
/// padding 12/10; the logo square «پ» with «پایش» / «پنل مالک»; «جستجو در پنل… Ctrl K» (filters
/// the menu, Enter opens the first); the groups 11.5 muted; 13px items; the account foot.
class _MinimalSideNav extends StatefulWidget {
  const _MinimalSideNav({required this.nav});
  final NabdSideNav nav;

  @override
  State<_MinimalSideNav> createState() => _MinimalSideNavState();
}

class _MinimalSideNavState extends State<_MinimalSideNav> {
  final _q = TextEditingController();
  final _focus = FocusNode();

  @override
  void dispose() {
    _q.dispose();
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    final nav = widget.nav;
    final q = _q.text.trim();
    final shown = [
      for (final (i, m) in nav.items.indexed)
        if (q.isEmpty || m.title.contains(q)) (i, m),
    ];
    final acc = nav.account;
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.keyK, control: true): () =>
            _focus.requestFocus(),
      },
      child: Container(
        width: 240,
        decoration: BoxDecoration(
          color: tk.navBg,
          border: BorderDirectional(end: BorderSide(color: tk.line)),
        ),
        child: Column(
          children: [
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(10, 12, 10, 4),
                children: [
                  Padding(
                    key: const Key('owner-brand'),
                    padding: const EdgeInsetsDirectional.fromSTEB(6, 4, 6, 12),
                    child: Row(
                      children: [
                        Container(
                          width: 28,
                          height: 28,
                          alignment: Alignment.center,
                          decoration: BoxDecoration(
                            color: tk.primary,
                            borderRadius: BorderRadius.circular(7),
                          ),
                          child: Text(
                            'پ',
                            style: TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.w800,
                              color: tk.onPrimary,
                            ),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'پایش',
                                style: TextStyle(
                                  fontSize: 14,
                                  fontWeight: FontWeight.w700,
                                  height: 1.3,
                                  color: tk.ink,
                                ),
                              ),
                              Text(
                                'پنل مالک',
                                style: TextStyle(fontSize: 11, color: tk.muted),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                  Container(
                    key: const Key('nav-search'),
                    height: 34,
                    margin: const EdgeInsets.fromLTRB(2, 0, 2, 4),
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                    decoration: BoxDecoration(
                      color: tk.card,
                      border: Border.all(color: tk.line),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Row(
                      children: [
                        Icon(Icons.search_rounded, size: 16, color: tk.muted),
                        const SizedBox(width: 8),
                        Expanded(
                          child: FieldBox(
                            width: kFieldSearch,
                            child: TextField(
                              controller: _q,
                              focusNode: _focus,
                              onChanged: (_) => setState(() {}),
                              onSubmitted: (_) {
                                if (shown.isNotEmpty) {
                                  nav.onSelected(shown.first.$1);
                                }
                              },
                              style: TextStyle(fontSize: 12.5, color: tk.ink),
                              decoration: InputDecoration(
                                isCollapsed: true,
                                filled: false,
                                border: InputBorder.none,
                                enabledBorder: InputBorder.none,
                                focusedBorder: InputBorder.none,
                                hintText: 'جستجو در پنل…',
                                hintStyle: TextStyle(
                                  fontSize: 12.5,
                                  color: tk.muted,
                                ),
                              ),
                            ),
                          ),
                        ),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 5),
                          decoration: BoxDecoration(
                            border: Border.all(color: tk.line),
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: Text(
                            'Ctrl K',
                            textDirection: TextDirection.ltr,
                            style: TextStyle(fontSize: 10.5, color: tk.muted),
                          ),
                        ),
                      ],
                    ),
                  ),
                  for (final (j, (i, m)) in shown.indexed) ...[
                    if (j == 0 || shown[j - 1].$2.group != m.group)
                      Padding(
                        key: Key('nav-group-${m.group}'),
                        padding: const EdgeInsetsDirectional.fromSTEB(
                          8,
                          14,
                          8,
                          4,
                        ),
                        child: Text(
                          menuGroupTitle(m.group),
                          style: TextStyle(
                            fontSize: 11.5,
                            fontWeight: FontWeight.w500,
                            color: tk.muted,
                          ),
                        ),
                      ),
                    _NabdNavItem(
                      key: Key('nav-${m.id}'),
                      item: m,
                      selected: i == nav.selected,
                      extended: true,
                      onTap: () => nav.onSelected(i),
                    ),
                  ],
                ],
              ),
            ),
            if (acc != null)
              Container(
                key: const Key('nav-account'),
                margin: const EdgeInsets.fromLTRB(10, 0, 10, 12),
                padding: const EdgeInsetsDirectional.fromSTEB(8, 10, 8, 0),
                decoration: BoxDecoration(
                  border: Border(top: BorderSide(color: tk.line)),
                ),
                child: Row(
                  children: [
                    Container(
                      width: 28,
                      height: 28,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: tk.soft,
                        borderRadius: BorderRadius.circular(7),
                      ),
                      child: Text(
                        acc.$1.trim().isEmpty
                            ? '؟'
                            : acc.$1.trim().characters.first,
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w700,
                          color: tk.ink2,
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            acc.$1,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.w600,
                              color: tk.ink,
                            ),
                          ),
                          KeyedSubtree(
                            key: nav.roleKey,
                            child: Text(
                              acc.$2,
                              style: TextStyle(fontSize: 11, color: tk.muted),
                            ),
                          ),
                        ],
                      ),
                    ),
                    if (nav.footActions.isNotEmpty)
                      IconButtonTheme(
                        data: IconButtonThemeData(
                          style: IconButton.styleFrom(
                            fixedSize: const Size(30, 30),
                            minimumSize: const Size(30, 30),
                            padding: EdgeInsets.zero,
                            iconSize: 17,
                            foregroundColor: tk.muted,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(6),
                            ),
                          ),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: nav.footActions,
                        ),
                      ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _NabdNavItem extends StatelessWidget {
  const _NabdNavItem({
    super.key,
    required this.item,
    required this.selected,
    required this.extended,
    required this.onTap,
  });
  final OwnerMenuItem item;
  final bool selected;
  final bool extended;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    // Row 179 «مینیمال»: the chosen item is a soft grey pill with ink text (no gradient).
    final pill = tk.isMinimal;
    final fg = selected ? (pill ? tk.ink : Colors.white) : tk.ink;
    final icon = Icon(
      ownerMenuIcons[item.id],
      size: pill ? 17 : 21,
      color: selected
          ? (pill ? tk.ink : Colors.white)
          : (pill ? tk.ink2 : tk.muted),
    );
    final label = Text(
      item.title,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: TextStyle(
        color: selected || !pill ? fg : tk.ink2,
        fontSize: extended ? (pill ? 13 : 14) : 11,
        fontWeight: selected
            ? (pill ? FontWeight.w500 : FontWeight.w700)
            : (pill ? FontWeight.w400 : FontWeight.w500),
      ),
    );
    return Padding(
      padding: EdgeInsets.symmetric(vertical: pill ? 0.5 : 2),
      child: Semantics(
        button: true,
        selected: selected,
        label: item.title,
        excludeSemantics: true,
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            borderRadius: BorderRadius.circular(13),
            hoverColor: tk.soft,
            onTap: onTap,
            child: Ink(
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(pill ? 6 : 13),
                color: selected && pill ? tk.soft : null,
                gradient: selected && !pill ? tk.primaryGradient : null,
                boxShadow: selected && !pill
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
              padding: EdgeInsets.symmetric(
                horizontal: extended ? (pill ? 8 : 11) : 4,
                vertical: extended ? (pill ? 7 : 9) : 8,
              ),
              child: extended
                  ? Row(
                      children: [
                        icon,
                        SizedBox(width: pill ? 10 : 9),
                        Expanded(child: label),
                      ],
                    )
                  : Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [icon, const SizedBox(height: 3), label],
                    ),
            ),
          ),
        ),
      ),
    );
  }
}

/// کپسول شیشه‌ای شناور پایین صفحه در تلفن (همان .bottomnav نبض) + «منو» برای همهٔ بخش‌ها.
class NabdCapsuleBar extends StatelessWidget {
  const NabdCapsuleBar({
    super.key = const Key('nav-capsule'),
    required this.items,
    required this.selected,
    required this.onSelected,
    required this.onMore,
  });
  final List<OwnerMenuItem> items;
  final String selected;
  final ValueChanged<String> onSelected;
  final VoidCallback onMore;

  Widget _cell(
    BuildContext context, {
    required Key key,
    required IconData icon,
    required String label,
    required bool on,
    required VoidCallback onTap,
  }) {
    final tk = context.tokens;
    return Expanded(
      child: Semantics(
        button: true,
        selected: on,
        label: label,
        excludeSemantics: true,
        child: InkWell(
          key: key,
          borderRadius: BorderRadius.circular(18),
          onTap: onTap,
          child: Container(
            constraints: const BoxConstraints(minHeight: 48),
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
            decoration: BoxDecoration(
              color: on && !tk.isMinimal ? tk.soft : null,
              borderRadius: BorderRadius.circular(18),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  icon,
                  size: 22,
                  color: on ? (tk.isMinimal ? tk.ink : tk.primary) : tk.muted,
                ),
                const SizedBox(height: 2),
                Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 11,
                    color: on ? (tk.isMinimal ? tk.ink : tk.primary) : tk.muted,
                    fontWeight: on ? FontWeight.w700 : FontWeight.w500,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    if (tk.isMinimal) {
      // design 2 `.tabbar`: flat, the card colour, a hairline on top; «بیشتر» last
      return Container(
        decoration: BoxDecoration(
          color: tk.card,
          border: Border(top: BorderSide(color: tk.line)),
        ),
        child: SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
            child: Row(
              children: [
                for (final m in items)
                  _cell(
                    context,
                    key: Key('cap-${m.id}'),
                    icon: ownerMenuIcons[m.id]!,
                    label: m.title,
                    on: m.id == selected,
                    onTap: () => onSelected(m.id),
                  ),
                _cell(
                  context,
                  key: const Key('cap-more'),
                  icon: Icons.grid_view_rounded,
                  label: 'بیشتر',
                  on: !items.any((m) => m.id == selected),
                  onTap: onMore,
                ),
              ],
            ),
          ),
        ),
      );
    }
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: tk.card.withValues(alpha: 0.9),
            borderRadius: BorderRadius.circular(24),
            border: Border.all(color: tk.line),
            boxShadow: [
              BoxShadow(
                color: tk.glow,
                blurRadius: 25,
                offset: const Offset(0, 10),
                spreadRadius: -5,
              ),
            ],
          ),
          child: Padding(
            padding: const EdgeInsets.all(6),
            child: Row(
              children: [
                for (final m in items)
                  _cell(
                    context,
                    key: Key('cap-${m.id}'),
                    icon: ownerMenuIcons[m.id]!,
                    label: m.title,
                    on: m.id == selected,
                    onTap: () => onSelected(m.id),
                  ),
                _cell(
                  context,
                  key: const Key('cap-more'),
                  icon: Icons.menu,
                  label: 'همهٔ بخش‌ها',
                  on: !items.any((m) => m.id == selected),
                  onTap: onMore,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
