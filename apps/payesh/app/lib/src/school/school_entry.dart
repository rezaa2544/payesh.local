import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../accounts/accounts_screen.dart';
import '../classes/classes_screen.dart';
import '../flags.dart';
import '../followup/followup_screen.dart';
import '../pulse/pulse.dart';
import '../reports/reports_screen.dart';
import '../system/system_screen.dart';
import '../schedule/schedule_screen.dart';
import '../users/users_controller.dart';
import '../users/users_screen.dart';
import 'school_source.dart';

/// One row-128 page on the signed-in home.
final class SchoolPageSpec {
  const SchoolPageSpec({
    required this.id,
    required this.wave,
    required this.label,
    required this.icon,
    required this.roles,
    required this.build,
  });

  /// Key suffix (`adm-<id>`) and the web route it replaces.
  final String id;
  final SchoolWave wave;
  final String label;
  final IconData icon;

  /// Roles the web navigation shows this page to (client/pages.js `navConfig`).
  final Set<String> roles;
  final Widget Function(SchoolRouteArgs a) build;
}

/// What a page route gets.
final class SchoolRouteArgs {
  const SchoolRouteArgs({
    required this.source,
    required this.role,
    required this.uid,
    required this.sync,
    required this.flags,
    this.onRetry,
  });
  final ClientFlags flags;
  final SchoolSource source;
  final String role;
  final int uid;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;
}

/// Every row-128 page, in the web navigation's order.
final List<SchoolPageSpec> schoolPages = [
  SchoolPageSpec(
    id: 'home',
    wave: SchoolWave.reports,
    label: 'امروز',
    icon: Icons.today_outlined,
    roles: const {'manager', 'teacher', 'student'},
    build: (a) => SchoolOwned(
      create: () => HomeController(source: a.source, role: a.role, uid: a.uid),
      page: (c) => DashboardScreen(
        controller: c as HomeController,
        sync: a.sync,
        onRetry: a.onRetry,
      ),
    ),
  ),
  SchoolPageSpec(
    id: 'users',
    wave: SchoolWave.users,
    label: 'کاربران',
    icon: Icons.people_alt_outlined,
    roles: const {'manager'},
    build: (a) => SchoolOwned(
      create: () => UsersController(source: a.source, role: a.role, uid: a.uid),
      page: (c) => UsersScreen(
        controller: c as UsersController,
        sync: a.sync,
        onRetry: a.onRetry,
        accounts: a.flags.usesSchool(SchoolWave.accounts),
      ),
    ),
  ),
  SchoolPageSpec(
    id: 'students',
    wave: SchoolWave.users,
    label: 'دانش‌آموزان',
    icon: Icons.school_outlined,
    roles: const {'manager', 'teacher', 'counselor'},
    build: (a) => SchoolOwned(
      create: () =>
          StudentsController(source: a.source, role: a.role, uid: a.uid),
      page: (c) => StudentsScreen(
        controller: c as StudentsController,
        sync: a.sync,
        onRetry: a.onRetry,
      ),
    ),
  ),
  SchoolPageSpec(
    id: 'record',
    wave: SchoolWave.users,
    label: 'پروندهٔ من',
    icon: Icons.badge_outlined,
    roles: const {'student'},
    build: (a) => SchoolOwned(
      create: () =>
          RecordController(source: a.source, role: a.role, uid: a.uid),
      page: (c) => RecordScreen(
        controller: c as RecordController,
        sync: a.sync,
        onRetry: a.onRetry,
      ),
    ),
  ),
  SchoolPageSpec(
    id: 'followup',
    wave: SchoolWave.followup,
    label: 'نیازمند پیگیری',
    icon: Icons.report_problem_outlined,
    roles: const {'manager'},
    build: (a) => SchoolOwned(
      create: () =>
          FollowupController(source: a.source, role: a.role, uid: a.uid),
      page: (c) => FollowupScreen(
        controller: c as FollowupController,
        sync: a.sync,
        onRetry: a.onRetry,
      ),
    ),
  ),
  SchoolPageSpec(
    id: 'classes',
    wave: SchoolWave.classes,
    label: 'کلاس‌ها و تعریف‌ها',
    icon: Icons.class_outlined,
    roles: const {'manager'},
    build: (a) => SchoolOwned(
      create: () =>
          ClassesController(source: a.source, role: a.role, uid: a.uid),
      page: (c) => ClassesScreen(
        controller: c as ClassesController,
        sync: a.sync,
        onRetry: a.onRetry,
      ),
    ),
  ),
  SchoolPageSpec(
    id: 'schedule',
    wave: SchoolWave.schedule,
    label: 'برنامهٔ هفتگی',
    icon: Icons.calendar_view_week_outlined,
    roles: const {'manager', 'teacher', 'parent', 'student'},
    build: (a) => SchoolOwned(
      create: () =>
          ScheduleController(source: a.source, role: a.role, uid: a.uid),
      page: (c) => ScheduleScreen(
        controller: c as ScheduleController,
        sync: a.sync,
        onRetry: a.onRetry,
      ),
    ),
  ),
  SchoolPageSpec(
    id: 'password',
    wave: SchoolWave.accounts,
    label: 'تغییر رمز من',
    icon: Icons.password_outlined,
    roles: const {
      'manager',
      'vice',
      'teacher',
      'counselor',
      'staff',
      'office',
      'parent',
      'student',
    },
    build: (a) => SchoolOwned(
      create: () =>
          OwnPasswordController(source: a.source, role: a.role, uid: a.uid),
      page: (c) => OwnPasswordPage(controller: c as OwnPasswordController),
    ),
  ),
  SchoolPageSpec(
    id: 'attendance-report',
    wave: SchoolWave.reports,
    label: 'گزارش حضور',
    icon: Icons.fact_check_outlined,
    roles: const {'manager'},
    build: (a) => SchoolOwned(
      create: () =>
          DayReportController(source: a.source, role: a.role, uid: a.uid),
      page: (c) => DayReportScreen(
        controller: c as DayReportController,
        sync: a.sync,
        onRetry: a.onRetry,
      ),
    ),
  ),
  SchoolPageSpec(
    id: 'reports',
    wave: SchoolWave.reports,
    label: 'گزارش‌ها',
    icon: Icons.summarize_outlined,
    roles: const {'manager'},
    build: (a) => SchoolOwned(
      create: () =>
          ReportsController(source: a.source, role: a.role, uid: a.uid),
      page: (c) => ReportsScreen(
        controller: c as ReportsController,
        sync: a.sync,
        onRetry: a.onRetry,
      ),
    ),
  ),
  SchoolPageSpec(
    id: 'leaves',
    wave: SchoolWave.reports,
    label: 'مرخصی‌ها',
    icon: Icons.event_busy_outlined,
    roles: const {'manager'},
    build: (a) => SchoolOwned(
      create: () =>
          LeaveDeskController(source: a.source, role: a.role, uid: a.uid),
      page: (c) => LeaveDeskScreen(
        controller: c as LeaveDeskController,
        sync: a.sync,
        onRetry: a.onRetry,
      ),
    ),
  ),
  SchoolPageSpec(
    id: 'health',
    wave: SchoolWave.server,
    label: 'سلامت داده',
    icon: Icons.health_and_safety_outlined,
    roles: const {'manager'},
    build: _health,
  ),
  // Row 172: web `PAGES.network` («شبکه»), between «سلامت» and «حافظهٔ ابری» as in navConfig.
  SchoolPageSpec(
    id: 'network',
    wave: SchoolWave.server,
    label: 'شبکه',
    icon: Icons.public,
    roles: const {'manager'},
    build: _network,
  ),
  SchoolPageSpec(
    id: 'cloud',
    wave: SchoolWave.server,
    label: 'حافظهٔ ابری',
    icon: Icons.cloud_outlined,
    roles: const {'manager'},
    build: _cloud,
  ),
  SchoolPageSpec(
    id: 'system',
    wave: SchoolWave.server,
    label: 'سیستم',
    icon: Icons.settings_outlined,
    roles: const {
      'manager',
      'vice',
      'teacher',
      'counselor',
      'staff',
      'office',
      'parent',
      'student',
    },
    build: (a) => Builder(
      builder: (context) => SchoolOwned(
        create: () =>
            SystemController(source: a.source, role: a.role, uid: a.uid),
        page: (c) => SystemScreen(
          controller: c as SystemController,
          sync: a.sync,
          onRetry: a.onRetry,
          openCloud: () => openPanel<void>(context, (_) => _cloud(a)),
        ),
      ),
    ),
  ),
];

/// Entry buttons of the row-128 pages on the signed-in home. A page shows only when the build
/// ships its wave, the role sees it in the web navigation, and the device knows the user —
/// never a dead button.
class SchoolEntry extends StatelessWidget {
  const SchoolEntry({
    super.key,
    required this.flags,
    required this.source,
    required this.role,
    required this.uid,
    required this.sync,
    this.onRetry,
  });

  final ClientFlags flags;
  final SchoolSource? source;
  final String? role;
  final int? uid;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  List<SchoolPageSpec> get visible => [
    for (final p in schoolPages)
      if (role != null && p.roles.contains(role) && flags.usesSchool(p.wave)) p,
  ];

  @override
  Widget build(BuildContext context) {
    final src = source;
    final pages = visible;
    if (src == null || role == null || pages.isEmpty) {
      return const SizedBox.shrink(key: Key('adm-entry-none'));
    }
    if (uid == null) {
      return const Text(
        'برای مدیریت مدرسه یک بار به سرور مدرسه وصل شوید.',
        key: Key('adm-entry-wait'),
      );
    }
    // Row 165: the tiles go into the sections of the home grid (app.dart); this widget itself
    // only stands in for them where a caller places it directly.
    return PayeshTileGrid(
      key: const Key('adm-entry'),
      children: [for (final g in tilesByGroup(context).values) ...g],
    );
  }

  /// Row 165: true when the pages are home tiles (else a short note or nothing).
  bool get hasTiles =>
      source != null && role != null && uid != null && visible.isNotEmpty;

  /// The page tiles of the home, by section (`daily` / `school` / `system`).
  Map<String, List<Widget>> tilesByGroup(BuildContext context) {
    final src = source;
    final out = <String, List<Widget>>{};
    if (src == null || role == null || uid == null) return out;
    final args = SchoolRouteArgs(
      source: src,
      role: role!,
      uid: uid!,
      sync: sync,
      flags: flags,
      onRetry: onRetry,
    );
    for (final p in visible) {
      final g = schoolPageGroups[p.id] ?? 'school';
      (out[g] ??= []).add(
        PayeshTile(
          key: Key('adm-${p.id}'),
          icon: p.icon,
          label: p.label,
          tone: switch (g) {
            'daily' => PayeshTone.success,
            'system' => PayeshTone.warning,
            _ => PayeshTone.info,
          },
          onTap: () =>
              Navigator.of(context)
                  .push(MaterialPageRoute<void>(builder: (_) => p.build(args))),
        ),
      );
    }
    return out;
  }

  SchoolRouteArgs? get _args {
    final src = source;
    if (src == null || role == null || uid == null) return null;
    return SchoolRouteArgs(
      source: src,
      role: role!,
      uid: uid!,
      sync: sync,
      flags: flags,
      onRetry: onRetry,
    );
  }

  /// Row 170: the pages as «نبض» sidebar / drawer entries.
  List<PulseNavItem> navItems() {
    final args = _args;
    if (args == null) return const [];
    return [
      for (final p in visible)
        PulseNavItem(
          id: p.id == 'home' ? 'today' : p.id,
          label: p.label,
          icon: p.icon,
          page: (_) => p.build(args),
        ),
    ];
  }

  /// Row 170: «نبض امروز مدرسه» at the top of the manager's home (null for the other roles or
  /// while the reports page is not in this build).
  Widget? pulseHero() {
    final args = _args;
    if (args == null ||
        role != 'manager' ||
        !visible.any((p) => p.id == 'home')) {
      return null;
    }
    return SchoolOwned(
      key: const Key('pulse-home'),
      create: () =>
          HomeController(source: args.source, role: args.role, uid: args.uid),
      page: (c) => _PulseHome(controller: c as HomeController),
    );
  }
}

class _PulseHome extends StatefulWidget {
  const _PulseHome({required this.controller});
  final HomeController controller;

  @override
  State<_PulseHome> createState() => _PulseHomeState();
}

class _PulseHomeState extends State<_PulseHome> {
  @override
  void initState() {
    super.initState();
    widget.controller.load();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final d = widget.controller.dashboard;
      if (d == null) return const SizedBox.shrink();
      String n(int v) => faNumber(v);
      return Padding(
        padding: const EdgeInsets.only(bottom: PayeshTokens.space5),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            PulseHero(
              present: d.presentToday,
              of: d.students,
              absent: d.absentToday,
              late: d.lateToday,
            ),
            const SizedBox(height: PayeshTokens.space3),
            // the stat cards of the web dashboard (ids `home-*`: the «امروز» page has its own)
            PulseStatGrid(
              key: const Key('pulse-stats'),
              children: [
                PulseStat(
                  id: 'home-students',
                  icon: Icons.people_alt_outlined,
                  value: n(d.students),
                  label: 'دانش‌آموز',
                ),
                PulseStat(
                  id: 'home-teachers',
                  icon: Icons.school_outlined,
                  value: n(d.teachers),
                  label: 'دبیر',
                ),
                PulseStat(
                  id: 'home-classes',
                  icon: Icons.class_outlined,
                  value: n(d.classes),
                  label: 'کلاس',
                ),
                PulseStat(
                  id: 'home-present',
                  icon: Icons.fact_check_outlined,
                  value: '${n(d.presentToday)} / ${n(d.recordsToday)}',
                  label: 'حاضر امروز',
                  tone: PayeshTone.success,
                ),
                PulseStat(
                  id: 'home-absent',
                  icon: Icons.highlight_off,
                  value: n(d.absentToday),
                  label: 'غایب امروز',
                  tone: PayeshTone.danger,
                ),
                PulseStat(
                  id: 'home-late',
                  icon: Icons.schedule,
                  value: n(d.lateToday),
                  label: 'تأخیر',
                  tone: PayeshTone.warning,
                ),
                PulseStat(
                  id: 'home-pending',
                  icon: Icons.edit_note,
                  value: n(d.pendingGrades),
                  label: 'نمرهٔ در انتظار تأیید',
                  tone: PayeshTone.info,
                ),
              ],
            ),
          ],
        ),
      );
    },
  );
}

/// Row 165: home section of each page (daily work · school management · system & account).
const Map<String, String> schoolPageGroups = {
  'home': 'daily',
  'followup': 'daily',
  'record': 'daily',
  'users': 'school',
  'students': 'school',
  'classes': 'school',
  'schedule': 'school',
  'attendance-report': 'school',
  'reports': 'school',
  'leaves': 'school',
  'health': 'system',
  'network': 'system',
  'cloud': 'system',
  'system': 'system',
  'password': 'system',
};

Widget _health(SchoolRouteArgs a) => SchoolOwned(
  create: () => HealthController(source: a.source, role: a.role, uid: a.uid),
  page: (c) => HealthScreen(
    controller: c as HealthController,
    sync: a.sync,
    onRetry: a.onRetry,
  ),
);

Widget _network(SchoolRouteArgs a) => SchoolOwned(
  create: () => NetworkController(source: a.source, role: a.role, uid: a.uid),
  page: (c) => NetworkScreen(
    controller: c as NetworkController,
    sync: a.sync,
    onRetry: a.onRetry,
  ),
);

Widget _cloud(SchoolRouteArgs a) => SchoolOwned(
  create: () => CloudController(source: a.source, role: a.role, uid: a.uid),
  page: (c) => CloudScreen(
    controller: c as CloudController,
    sync: a.sync,
    onRetry: a.onRetry,
  ),
);
