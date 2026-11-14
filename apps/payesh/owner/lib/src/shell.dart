import 'package:flutter/material.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'pages/audit_page.dart';
import 'pages/dashboard_page.dart';
import 'pages/health_page.dart';
import 'pages/infra_page.dart';
import 'pages/limits_page.dart';
import 'pages/operators_page.dart';
import 'pages/payments_page.dart';
import 'pages/plans_page.dart';
import 'pages/reports_page.dart';
import 'pages/schools_page.dart';
import 'pages/backup_page.dart';
import 'pages/guard_page.dart';
import 'pages/support_page.dart';
import 'backup/backup_engine.dart';
import 'guard/guard_engine.dart';
import 'infra/load_route.dart';
import 'monitor/live_monitor.dart';
import 'schools/school_registry.dart';
import 'menu.dart';
import 'widgets.dart';

Widget pageFor(String id) => switch (id) {
  'dashboard' => const DashboardPage(),
  'schools' => const SchoolsPage(),
  'plans' => const PlansPage(),
  'limits' => const LimitsPage(),
  'health' => const HealthPage(),
  'infra' => const InfraPage(),
  'operators' => const OperatorsPage(),
  'reports' => const ReportsPage(),
  'audit' => const AuditPage(),
  'payments' => const PaymentsPage(),
  'support' => const SupportPage(),
  'guard' => const GuardPage(),
  'backup' => const BackupPage(),
  _ => const DashboardPage(),
};

/// عرض لازم برای کنار هم نشستن دو بخش «زیرساخت» (ردیف ۱۵۷).
const double infraSideBySideWidth = 960;

/// Signed-in shell: the nine pages of the web panel + local pages, grouped by function
/// (menu.dart). «نبض» sidebar on a tablet / Windows window (on the right in RTL); on a phone a
/// grouped drawer + the floating glass capsule of the user panel.
class OwnerShell extends StatefulWidget {
  const OwnerShell({
    super.key,
    required this.api,
    required this.now,
    required this.themeButton,
    required this.onSignOut,
    this.settings,
    this.badge,
    this.infraTop,
    this.extraActions = const [],
    this.dbLight,
    this.updateLight,
    this.monitor,
    this.schools,
    this.router,
    this.guard,
    this.backup,
  });

  /// پشتیبان کامل دیتابیس (ردیف ۱۵۵)؛ صفحهٔ «پشتیبان دیتابیس».
  final OwnerBackupEngine? backup;

  /// موتور هوشمند (ردیف ۱۵۴)؛ صفحهٔ «نگهبان هوشمند».
  final GuardEngine? guard;

  /// پایش زندهٔ زیرساخت در داشبورد.
  final LiveMonitor? monitor;

  /// مسیر بار و بار لحظه‌ای (ردیف ۱۵۳)؛ کارت «بار لحظه‌ای» داشبورد.
  final LoadRouter? router;

  /// مدارس، درخواست ثبت‌نام و اشتراک (برگردان p2، ردیف ۱۴۵).
  final SchoolRegistry? schools;

  /// چراغ وضعیت دیتابیس: همیشه پیدا، بالا-چپ (آخرین جای نوار در راست‌به‌چپ).
  final Widget? dbLight;

  /// نسخه + چراغ به‌روزرسانی: همیشه پیدا در نوار بالا.
  final Widget? updateLight;

  /// بالای صفحهٔ «زیرساخت» (مثلاً خلاصهٔ سرور کمکی همین دستگاه).
  final Widget? infraTop;

  /// دکمه‌ها/نشان‌های دیگر نوار بالا (مثلاً «به‌روزرسانی آماده»).
  final List<Widget> extraActions;

  /// برچسب حالت کار (مثلاً «سرور مستقل») کنار نقش.
  final String? badge;

  /// null یا بدون نشست ⇒ بخش‌های سروری راهنمای «اتصال در تنظیمات» را نشان می‌دهند.
  final OwnerApi? api;
  final DateTime Function() now;
  final Widget themeButton;
  final VoidCallback onSignOut;

  /// صفحهٔ «تنظیمات» برنامهٔ نصب‌شده (دیتابیس + سرور)؛ null در حالت فقط-سرور.
  final Widget? settings;

  @override
  State<OwnerShell> createState() => _OwnerShellState();
}

class _OwnerShellState extends State<OwnerShell> {
  int _index = 0;
  ({bool ok, String text, int n})? _flash;
  int _seq = 0;

  void _show(bool ok, String text) {
    if (!mounted) return;
    setState(() => _flash = (ok: ok, text: text, n: ++_seq));
  }

  void _select(int i) => setState(() {
    _index = i;
    _flash = null;
  });

  final _scaffold = GlobalKey<ScaffoldState>();

  List<OwnerMenuItem> get _items => ownerMenu(
    local: {
      if (widget.schools != null) 'payments',
      if (widget.schools != null) 'support',
      if (widget.guard != null) 'guard',
      if (widget.backup != null) 'backup',
      if (widget.settings != null) 'settings',
    },
  );

  List<(String, String)> get _pages => [
    for (final m in _items) (m.id, m.title),
  ];

  Widget _page(String id) {
    if (id == 'settings') return widget.settings!;
    final api = widget.api;
    if (api == null || api.session == null) {
      return _ServerNeeded(
        onOpenSettings: widget.settings == null
            ? null
            : () => _select(_pages.indexWhere((p) => p.$1 == 'settings')),
      );
    }
    return OwnerScope(
      api: api,
      flash: _show,
      now: widget.now,
      monitor: widget.monitor,
      schools: widget.schools,
      router: widget.router,
      guard: widget.guard,
      backup: widget.backup,
      child: KeyedSubtree(
        key: ValueKey('page-$id-${identityHashCode(api)}'),
        child: id == 'infra' && widget.infraTop != null
            ? LayoutBuilder(
                builder: (context, box) {
                  final top = SingleChildScrollView(
                    key: const Key('infra-top-pane'),
                    child: widget.infraTop,
                  );
                  // ردیف ۱۵۷: در صفحهٔ پهن «حالت معماری/زیرساخت‌ها» (راست) و
                  // «ارائه‌دهنده‌ها/سرویس‌ها» (چپ) کنار هم، هر کدام با پیمایش جدا.
                  if (box.maxWidth >= infraSideBySideWidth) {
                    return Row(
                      key: const Key('infra-side-by-side'),
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Expanded(child: top),
                        Expanded(child: pageFor(id)),
                      ],
                    );
                  }
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      ConstrainedBox(
                        constraints: BoxConstraints(
                          maxHeight: MediaQuery.sizeOf(context).height * 0.6,
                        ),
                        child: top,
                      ),
                      Expanded(child: pageFor(id)),
                    ],
                  );
                },
              )
            : pageFor(id),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.api?.session;
    final pages = _pages;
    if (_index >= pages.length) _index = 0;
    final (id, title) = pages[_index];
    final size = sizeClassOf(MediaQuery.sizeOf(context).width);
    final tk = context.tokens;
    final flash = _flash;
    final body = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (flash != null)
          Material(
            key: ValueKey('flash-${flash.n}'),
            color: flash.ok ? tk.successBg : tk.dangerBg,
            child: Semantics(
              liveRegion: true,
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 10,
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        flash.text,
                        key: const Key('flash'),
                        style: TextStyle(
                          color: flash.ok ? tk.success : tk.danger,
                        ),
                      ),
                    ),
                    IconButton(
                      tooltip: 'بستن',
                      icon: const Icon(Icons.close, size: 18),
                      onPressed: () => setState(() => _flash = null),
                    ),
                  ],
                ),
              ),
            ),
          ),
        Expanded(child: _page(id)),
      ],
    );
    final actions = <Widget>[
      ?widget.updateLight,
      ...widget.extraActions,
      if (widget.badge != null)
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Center(
            child: Pill(
              widget.badge!,
              key: const Key('mode-badge'),
              tone: PayeshTone.success,
            ),
          ),
        ),
      if (s != null)
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Center(
            child: Pill(
              // نوار بالا کوتاه: فقط «مالک» (برچسب کامل نقش در caps.dart ثابت می‌ماند)
              s.role == OwnerRole.owner ? 'مالک' : s.role.label,
              key: Key('role-${s.role.wire}'),
              tone: PayeshTone.info,
            ),
          ),
        ),
      widget.themeButton,
      IconButton(
        key: const Key('logout'),
        tooltip: 'خروج',
        icon: const Icon(Icons.logout),
        onPressed: widget.onSignOut,
      ),
      ?widget.dbLight,
    ];
    if (size == SizeClass.compact) {
      return Scaffold(
        key: _scaffold,
        extendBody: true,
        appBar: AppBar(
          title: Text(title),
          actions: [
            ?widget.updateLight,
            IconButton(
              key: const Key('account-menu'),
              tooltip: 'حساب و پوسته',
              icon: const Icon(Icons.account_circle_outlined),
              onPressed: () => showModalBottomSheet<void>(
                context: context,
                builder: (ctx) => SafeArea(
                  child: Padding(
                    padding: const EdgeInsets.all(PayeshTokens.space4),
                    child: Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        for (final a in actions)
                          if (a != widget.updateLight && a != widget.dbLight) a,
                      ],
                    ),
                  ),
                ),
              ),
            ),
            ?widget.dbLight,
          ],
        ),
        drawer: NavigationDrawer(
          key: const Key('nav-drawer'),
          selectedIndex: _index,
          onDestinationSelected: (i) {
            Navigator.of(context).pop();
            _select(i);
          },
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(28, 16, 16, 10),
              child: _Brand(extended: true),
            ),
            for (final (i, m) in _items.indexed) ...[
              if (i == 0 || _items[i - 1].group != m.group)
                Padding(
                  key: Key('nav-group-${m.group}'),
                  padding: const EdgeInsetsDirectional.fromSTEB(28, 14, 16, 4),
                  child: Text(
                    menuGroupTitle(m.group),
                    style: TextStyle(fontSize: 11.5, color: tk.muted),
                  ),
                ),
              NavigationDrawerDestination(
                key: Key('nav-${m.id}'),
                icon: Icon(ownerMenuIcons[m.id]),
                label: Text(m.title),
              ),
            ],
          ],
        ),
        bottomNavigationBar: NabdCapsuleBar(
          items: [
            for (final m in _items)
              if (const {
                'dashboard',
                'schools',
                'payments',
                'infra',
              }.contains(m.id))
                m,
          ],
          selected: id,
          onSelected: (pid) => _select(_pages.indexWhere((p) => p.$1 == pid)),
          onMore: () => _scaffold.currentState?.openDrawer(),
        ),
        body: PayeshBackdrop(child: SafeArea(child: body)),
      );
    }
    return Scaffold(
      appBar: AppBar(title: Text(title), actions: actions),
      body: PayeshBackdrop(
        child: SafeArea(
          child: Row(
            children: [
              NabdSideNav(
                items: _items,
                selected: _index,
                onSelected: _select,
                extended: size == SizeClass.expanded,
                leading: _Brand(extended: size == SizeClass.expanded),
              ),
              Expanded(child: body),
            ],
          ),
        ),
      ),
    );
  }
}

/// Brand of the web panel's sidebar (`.brand`): the mark on the «نبض» gradient + «پنل مالک پایش».
class _Brand extends StatelessWidget {
  const _Brand({required this.extended});
  final bool extended;

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    const mark = PayeshBrandMark(size: 34);
    if (!extended) {
      return Semantics(
        label: 'پنل مالک پایش',
        child: const KeyedSubtree(key: Key('owner-brand'), child: mark),
      );
    }
    return Row(
      key: const Key('owner-brand'),
      mainAxisSize: MainAxisSize.min,
      children: [
        mark,
        const SizedBox(width: 10),
        Flexible(
          child: Text(
            'پنل مالک پایش',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontWeight: FontWeight.w700, color: tk.primary),
          ),
        ),
      ],
    );
  }
}

/// بخش سروری بدون اتصال به سرور پلتفرم.
class _ServerNeeded extends StatelessWidget {
  const _ServerNeeded({this.onOpenSettings});
  final VoidCallback? onOpenSettings;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(PayeshTokens.space4),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.cloud_off_outlined, size: 40, color: context.tokens.muted),
          const SizedBox(height: 12),
          const Text(
            'این بخش از سرور پلتفرم خوانده می‌شود و هنوز به سرور وصل نیستید.',
            key: Key('server-needed'),
            textAlign: TextAlign.center,
          ),
          if (onOpenSettings != null) ...[
            const SizedBox(height: 12),
            FilledButton(
              key: const Key('open-settings'),
              onPressed: onOpenSettings,
              child: const Text('رفتن به تنظیمات'),
            ),
          ],
        ],
      ),
    ),
  );
}
