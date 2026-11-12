import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../flags.dart';
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
    this.onRetry,
  });
  final SchoolSource source;
  final String role;
  final int uid;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;
}

/// Every row-128 page, in the web navigation's order.
final List<SchoolPageSpec> schoolPages = [
  SchoolPageSpec(
    id: 'users',
    wave: SchoolWave.users,
    label: 'کاربران',
    icon: Icons.people_alt_outlined,
    roles: const {'manager'},
    build: (a) => _Owned(
      create: () => UsersController(source: a.source, role: a.role, uid: a.uid),
      page: (c) => UsersScreen(
        controller: c as UsersController,
        sync: a.sync,
        onRetry: a.onRetry,
      ),
    ),
  ),
  SchoolPageSpec(
    id: 'students',
    wave: SchoolWave.users,
    label: 'دانش‌آموزان',
    icon: Icons.school_outlined,
    roles: const {'manager', 'teacher', 'counselor'},
    build: (a) => _Owned(
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
    build: (a) => _Owned(
      create: () =>
          RecordController(source: a.source, role: a.role, uid: a.uid),
      page: (c) => RecordScreen(
        controller: c as RecordController,
        sync: a.sync,
        onRetry: a.onRetry,
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
    final args = SchoolRouteArgs(
      source: src,
      role: role!,
      uid: uid!,
      sync: sync,
      onRetry: onRetry,
    );
    return Wrap(
      key: const Key('adm-entry'),
      spacing: PayeshTokens.space2,
      runSpacing: PayeshTokens.space2,
      children: [
        for (final p in pages)
          FilledButton.tonalIcon(
            key: Key('adm-${p.id}'),
            onPressed: () => Navigator.of(context)
                .push(MaterialPageRoute<void>(builder: (_) => p.build(args))),
            icon: Icon(p.icon),
            label: Text(p.label),
          ),
      ],
    );
  }
}

/// Owns a page controller for one visit (disposed when the route closes).
class _Owned extends StatefulWidget {
  const _Owned({required this.create, required this.page});
  final SchoolController Function() create;
  final Widget Function(SchoolController c) page;

  @override
  State<_Owned> createState() => _OwnedState();
}

class _OwnedState extends State<_Owned> {
  late final SchoolController c = widget.create();

  @override
  void dispose() {
    c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.page(c);
}
