import 'package:flutter/material.dart';
import 'package:payesh_core/payesh_core.dart';
import 'package:payesh_ui/payesh_ui.dart';
import 'package:payesh_update/payesh_update.dart';

import 'attendance/attendance_controller.dart';
import 'attendance/attendance_screen.dart';
import 'family/family_controller.dart';
import 'family/family_screen.dart';
import 'flags.dart';
import 'grades/grades_controller.dart';
import 'grades/grades_screen.dart';
import 'login/login_screens.dart';
import 'notices/notices_controller.dart';
import 'notices/notices_screen.dart';
import 'school/school_entry.dart';
import 'school/school_source.dart';
import 'login/session_controller.dart';
import 'secure/local_storage.dart';

/// Root widget of the native Payesh client (ADR-43). Persian, right-to-left, Material 3, built on
/// the payesh_ui design system (row 73): tokens, light/dark themes, bundled Vazirmatn, Jalali.
class PayeshApp extends StatelessWidget {
  const PayeshApp({
    super.key,
    this.storage,
    this.today,
    this.session,
    this.attendance,
    this.grades,
    this.notices,
    this.family,
    this.school,
    this.onRetrySync,
    this.updater,
    this.openUrl,
  });

  /// Row 148: version + update light at the top of every page (null in tests/local builds).
  /// Windows: changed files only, applied after the app closes, then it reopens by itself.
  final AppUpdater? updater;

  /// Android: the published APK in the system browser.
  final Future<void> Function(Uri url)? openUrl;

  /// Encrypted local database being opened (row 72); null in widget previews.
  final Future<LocalStorage>? storage;

  /// Login wave (row 74): school select → activation → signed in, or the old client. Null in
  /// widget previews (the home screen is shown directly).
  final SessionController? session;

  /// Wave 2 data (local database + outbox + Gateway); null = attendance stays on the web client.
  final AttendanceSource? attendance;

  /// Wave 3 data (same local database + outbox + Gateway); null = grades stay on the web client.
  final GradeSource? grades;

  /// Wave 4 data (same local database + outbox + Gateway); null = notices stay on the web client.
  final NoticeSource? notices;

  /// Wave 5 data (same local database + outbox + Gateway); null = parents pages stay on the web.
  final FamilySource? family;

  /// Row 128 school-management pages (same local database + outbox); null = they stay on the
  /// web client. Each page also needs its wave in `flags.school`.
  final SchoolSource? school;

  /// Badge tap on native pages: run a sync cycle now.
  final VoidCallback? onRetrySync;

  static const Locale fa = PayeshUi.locale;

  Widget _pages(BuildContext context, SessionController s, SignedIn state) {
    final src = attendance;
    final gsrc = grades;
    final nsrc = notices;
    final fsrc = family;
    final role = state.currentRole;
    final uid = state.currentUid;
    final fam = FamilyEntry(
      enabled: fsrc != null && s.flags.uses(NativeWave.parents),
      role: role,
      uid: uid,
      open: () {
        if (fsrc == null || role == null || uid == null) return;
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => FamilyRoute(
              source: fsrc,
              role: role,
              uid: uid,
              sync: s.sync,
              onRetry: onRetrySync,
            ),
          ),
        );
      },
    );
    final att = AttendanceEntry(
      enabled: src != null && s.flags.uses(NativeWave.attendance),
      role: role,
      uid: uid,
      open: () {
        if (src == null || role == null || uid == null) return;
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => AttendanceRoute(
              source: src,
              role: role,
              uid: uid,
              sync: s.sync,
              onRetry: onRetrySync,
              now: today,
            ),
          ),
        );
      },
    );
    final grd = GradesEntry(
      enabled: gsrc != null && s.flags.uses(NativeWave.grades),
      role: role,
      uid: uid,
      open: () {
        if (gsrc == null || role == null || uid == null) return;
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => GradesRoute(
              source: gsrc,
              role: role,
              uid: uid,
              sync: s.sync,
              onRetry: onRetrySync,
            ),
          ),
        );
      },
    );
    final ntc = NoticesEntry(
      enabled: nsrc != null && s.flags.uses(NativeWave.notices),
      role: role,
      uid: uid,
      open: () {
        if (nsrc == null || role == null || uid == null) return;
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => NoticesRoute(
              source: nsrc,
              role: role,
              uid: uid,
              sync: s.sync,
              onRetry: onRetrySync,
            ),
          ),
        );
      },
    );
    final sch = SchoolEntry(
      flags: s.flags,
      source: school,
      role: role,
      uid: uid,
      sync: s.sync,
      onRetry: onRetrySync,
    );
    // Row 165: equal tiles in three short sections; entries that are not tiles (the page is
    // still on the web, or the user must connect once) become one calm note line each.
    final groups = sch.hasTiles
        ? sch.tilesByGroup(context)
        : <String, List<Widget>>{};
    final daily = <Widget>[
      if (fam.isTile) fam,
      ...?groups['daily']?.take(1),
      if (att.isTile) att,
      if (grd.isTile) grd,
      if (ntc.isTile) ntc,
      ...?groups['daily']?.skip(1),
    ];
    final notes = <Widget>[
      if (!fam.isTile) fam,
      if (!att.isTile) att,
      if (!grd.isTile) grd,
      if (!ntc.isTile) ntc,
      if (!sch.hasTiles) sch,
    ];
    return Column(
      key: const Key('home-grid'),
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Row 165: a new version is a clear card with «نصب» (the small light alone was missed).
        if (updater case final u?) UpdateBanner(updater: u, openUrl: openUrl),
        if (daily.isNotEmpty)
          PayeshTileSection(title: 'کار روزانه', tiles: daily),
        if (groups['school'] case final t? when t.isNotEmpty) ...[
          const SizedBox(height: PayeshTokens.space5),
          PayeshTileSection(title: 'مدیریت مدرسه', tiles: t),
        ],
        if (groups['system'] case final t? when t.isNotEmpty) ...[
          const SizedBox(height: PayeshTokens.space5),
          PayeshTileSection(title: 'سیستم و حساب', tiles: t),
        ],
        if (notes.isNotEmpty) HomeNotes(children: notes),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = session;
    final u = updater;
    return PayeshMaterialApp(
      overlay: u == null
          ? null
          : AutoUpdateCheck(
              updater: u,
              child: UpdateLight(updater: u, openUrl: openUrl),
            ),
      home: s == null
          ? HomeScreen(storage: storage, today: today)
          : SessionGate(
              controller: s,
              home: HomeFooter(storage: storage, today: today),
              pages: (context, state) => _pages(context, s, state),
            ),
    );
  }

  /// Injected clock for tests; defaults to the device date (displayed as Jalali).
  final DateTime Function()? today;
}

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key, this.storage, this.today});

  final Future<LocalStorage>? storage;
  final DateTime Function()? today;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('پایش')),
      body: Center(
        child: HomeBody(storage: storage, today: today),
      ),
    );
  }
}

/// Row 165: notes under the home grid (a page still on the web, or «connect once») — one calm
/// line each in a soft box; entries with nothing to say render nothing.
class HomeNotes extends StatelessWidget {
  const HomeNotes({super.key, required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Padding(
      padding: const EdgeInsets.only(top: PayeshTokens.space4),
      child: DefaultTextStyle.merge(
        style: TextStyle(color: t.muted, fontSize: 13, height: 1.6),
        child: Column(
          key: const Key('home-notes'),
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: children,
        ),
      ),
    );
  }
}

/// Row 165: quiet footer of the signed-in home — today (Jalali) and whether the encrypted local
/// database opened. Replaces the old debug-like block (title, `sync-v1`, …).
class HomeFooter extends StatelessWidget {
  const HomeFooter({super.key, this.storage, this.today});

  final Future<LocalStorage>? storage;
  final DateTime Function()? today;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final style = TextStyle(color: t.muted, fontSize: 12);
    return DefaultTextStyle.merge(
      style: style,
      textAlign: TextAlign.center,
      child: Column(
        key: const Key('home-footer'),
        mainAxisSize: MainAxisSize.min,
        children: [
          JalaliDateText(
            (today ?? DateTime.now)().toIso8601String().substring(0, 10),
            key: const Key('home-today'),
            style: style,
          ),
          if (storage != null) ...[
            const SizedBox(height: 2),
            StorageStatus(storage: storage!),
          ],
        ],
      ),
    );
  }
}

/// Home content of the preview screen (no session).
class HomeBody extends StatelessWidget {
  const HomeBody({super.key, this.storage, this.today});

  final Future<LocalStorage>? storage;
  final DateTime Function()? today;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const Text('نسخهٔ بومی پایش', key: Key('home-title')),
        const SizedBox(height: 8),
        JalaliDateText(
          (today ?? DateTime.now)().toIso8601String().substring(0, 10),
          key: const Key('home-today'),
        ),
        const SizedBox(height: 8),
        const Text(PayeshApi.syncContract, key: Key('home-contract')),
        if (storage != null) ...[
          const SizedBox(height: 8),
          StorageStatus(storage: storage!),
        ],
      ],
    );
  }
}

/// Shows whether the encrypted local database opened (owner device check, row 72).
class StorageStatus extends StatelessWidget {
  const StorageStatus({super.key, required this.storage});

  final Future<LocalStorage> storage;

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<LocalStorage>(
      future: storage,
      builder: (context, snap) {
        if (snap.hasError) {
          return const Text(
            'خطای ذخیره‌سازی امن — داده‌ای باز نشد',
            key: Key('storage-error'),
          );
        }
        if (!snap.hasData) {
          return const Text('در حال باز کردن پایگاه محلی…');
        }
        final s = snap.data!;
        return Text(
          s.quarantined == null
              ? 'پایگاه محلی رمزنگاری‌شده فعال است'
              : 'پایگاه محلی قبلی قابل رمزگشایی نبود؛ پایگاه تازه ساخته شد',
          key: const Key('storage-ok'),
        );
      },
    );
  }
}
