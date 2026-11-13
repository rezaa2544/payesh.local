// منوی پنل مالک بر اساس کارکرد (ردیف ۱۵۱ · درخواست مالک ۲۰۲۶‑۱۱‑۱۳).
//
// صفحه‌های سروری همان ownerPages پنل وب است (برابری با apps/owner-panel/web/app.js
// در parity_test)؛ اینجا فقط «چیدمان منو» تعیین می‌شود: هر صفحه دقیقاً یک بار، در
// گروه کارکردی خودش. صفحه‌های محلی پنل بومی (پرداخت‌ها، پشتیبانی، نگهبان هوشمند، پشتیبان دیتابیس، تنظیمات) هم جای
// ثابت دارند و فقط وقتی امکانش هست دیده می‌شوند.
import 'package:flutter/material.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:payesh_ui/payesh_ui.dart';

/// یک گروه منو: عنوان + شناسهٔ صفحه‌ها به همان ترتیب نمایش.
typedef OwnerMenuGroup = ({String id, String title, List<String> pages});

const List<OwnerMenuGroup> ownerMenuGroups = [
  (id: 'overview', title: 'نمای کلی', pages: ['dashboard']),
  (
    id: 'people',
    title: 'مدارس و کاربران',
    pages: ['schools', 'operators', 'support'],
  ),
  (
    id: 'finance',
    title: 'مالی و اشتراک',
    pages: ['plans', 'payments', 'limits'],
  ),
  (id: 'infra', title: 'زیرساخت و پایش', pages: ['infra', 'health', 'guard']),
  (id: 'records', title: 'گزارش و ممیزی', pages: ['reports', 'audit']),
  (id: 'system', title: 'سیستم', pages: ['backup', 'settings']),
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
  });
  final List<OwnerMenuItem> items;
  final int selected;
  final ValueChanged<int> onSelected;
  final bool extended;
  final Widget? leading;

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
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
    final fg = selected ? Colors.white : tk.ink;
    final icon = Icon(
      ownerMenuIcons[item.id],
      size: 21,
      color: selected ? Colors.white : tk.muted,
    );
    final label = Text(
      item.title,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: TextStyle(
        color: fg,
        fontSize: extended ? 14 : 11,
        fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
      ),
    );
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
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
              padding: EdgeInsets.symmetric(
                horizontal: extended ? 11 : 4,
                vertical: extended ? 9 : 8,
              ),
              child: extended
                  ? Row(
                      children: [
                        icon,
                        const SizedBox(width: 9),
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
              color: on ? tk.soft : null,
              borderRadius: BorderRadius.circular(18),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(icon, size: 22, color: on ? tk.primary : tk.muted),
                const SizedBox(height: 2),
                Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 11,
                    color: on ? tk.primary : tk.muted,
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
