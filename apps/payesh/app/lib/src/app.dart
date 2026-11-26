import 'package:flutter/material.dart';
import 'package:payesh_core/payesh_core.dart';
import 'package:payesh_sync/payesh_sync.dart'
    show grantableRoles, permRole, staffAccessOf, staffAccessPages;
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
import 'login/paywall.dart';
import 'login/subscription_page.dart';
import 'notices/notices_controller.dart';
import 'notices/notices_screen.dart';
import 'pulse/pulse.dart';
import 'pulse/web.dart';
import 'school/school_entry.dart';
import 'school/school_source.dart';
import 'login/session_controller.dart';
import 'secure/local_storage.dart';

/// client/pages.js `navConfig(role)`: (web route, pulse.js icon, label, native page id).
List<(String, String, String, String)> webNavConfig(String? role) =>
    switch (role == null ? null : permRole(role)) {
      'manager' => const [
        ('home', 'home', 'داشبورد', 'today'),
        ('users', 'users', 'کاربران', 'users'),
        ('followup', 'alert', 'پیگیری', 'followup'),
        ('classes', 'school', 'کلاس‌ها', 'classes'),
        ('schedule', 'calendar', 'برنامه', 'schedule'),
        ('attendance-report', 'check', 'حضور', 'attendance-report'),
        // ردیف ۱۹۷ (F28): درخواست‌های مرخصی ولی‌ها باید به مدیر/معاون برسد.
        ('leaves', 'mail', 'مرخصی‌ها', 'leaves'),
        ('reports', 'report', 'گزارش‌ها', 'reports'),
        ('cqueue', 'mail', 'ارجاع مشاور', 'cqueue'),
        ('announcements', 'megaphone', 'اطلاعیه‌ها', 'notices'),
        ('health', 'health', 'سلامت', 'health'),
        ('network', 'globe', 'شبکه', 'network'),
        ('cloud', 'cloud', 'حافظهٔ ابری', 'cloud'),
        ('system', 'gear', 'سیستم', 'system'),
      ],
      'teacher' => const [
        ('home', 'home', 'امروز', 'today'),
        ('schedule', 'calendar', 'برنامه', 'schedule'),
        ('attendance', 'check', 'حضور', 'attendance'),
        ('grades', 'pen', 'نمره', 'grades'),
        ('students', 'users', 'دانش‌آموزان', 'students'),
        ('announcements', 'megaphone', 'اطلاعیه‌ها', 'notices'),
        ('system', 'gear', 'سیستم', 'system'),
      ],
      'parent' => const [
        ('home', 'family', 'فرزندان', 'family'),
        ('schedule', 'calendar', 'برنامه', 'schedule'),
        ('leaves', 'mail', 'مرخصی', 'parent-leaves'),
        ('announcements', 'megaphone', 'اطلاعیه‌ها', 'notices'),
        ('system', 'gear', 'سیستم', 'system'),
      ],
      'student' => const [
        ('home', 'home', 'خانه', 'today'),
        ('schedule', 'calendar', 'برنامه', 'schedule'),
        ('record', 'folder', 'پرونده', 'record'),
        ('announcements', 'megaphone', 'اطلاعیه‌ها', 'notices'),
        ('system', 'gear', 'سیستم', 'system'),
      ],
      // Row 187 (p2): the counselor's home is the referral queue.
      'counselor' => const [
        ('cqueue', 'mail', 'صف ارجاع', 'cqueue'),
        ('home', 'home', 'خانه', 'today'),
        ('announcements', 'megaphone', 'اطلاعیه‌ها', 'notices'),
        ('system', 'gear', 'سیستم', 'system'),
      ],
      _ => const [
        ('home', 'home', 'خانه', 'today'),
        ('announcements', 'megaphone', 'اطلاعیه‌ها', 'notices'),
        ('system', 'gear', 'سیستم', 'system'),
      ],
    };

/// Row 194: pages a ticked staff member may get that are not in the manager's sidebar (the
/// manager reaches them from the home tiles): (web route, pulse.js icon, label, native page id).
const List<(String, String, String, String)> grantNavExtra = [
  ('attendance', 'check', 'ثبت حضور', 'attendance'),
  ('grades', 'pen', 'نمره', 'grades'),
  // «مرخصی‌ها» از ردیف ۱۹۷ در منوی خود مدیر است (webNavConfig).
];

/// Row 194: the signed-in staff member's ticks («سطح دسترسی»), read from the user's own row of
/// the local database and read again whenever a sync changed local data — a tick the manager
/// adds or removes shows up in the menu without signing in again.
final StaffAccessCache staffAccessCache = StaffAccessCache();

class StaffAccessCache extends ChangeNotifier {
  String _key = '';
  List<String> _access = const [];
  SchoolSource? _src;
  int _gen = 0;

  /// The ticks known now for [uid] ([] until the first read finished; [] for roles that are
  /// not ticked — the role itself decides).
  List<String> current(SchoolSource src, String role, int uid) {
    if (!grantableRoles.contains(role)) return const [];
    final key = '${identityHashCode(src)}/$role/$uid';
    if (key != _key) {
      _src?.changed.removeListener(_reload);
      _key = key;
      _access = const [];
      _src = src..changed.addListener(_reload);
      _role = role;
      _uid = uid;
      _reload();
    }
    return _access;
  }

  String _role = '';
  int _uid = 0;

  Future<void> _reload() async {
    final src = _src;
    if (src == null) return;
    final gen = ++_gen;
    try {
      final db = await src.recordsFor(role: _role, uid: _uid);
      final row = await db?.get('users', _uid);
      final next = staffAccessOf(_role, row?.data['access']);
      if (gen != _gen) return;
      if (next.join(',') != _access.join(',')) {
        _access = next;
        notifyListeners();
      }
    } on Object {
      // a closed or not-yet-open local database: keep what is known
    }
  }
}

/// Root widget of the native Payesh client (ADR-43). Persian, right-to-left, Material 3, built on
/// the payesh_ui design system (row 73): tokens, light/dark themes, bundled Vazirmatn, Jalali.
/// Row 192: the app's navigator — the top-left strip lives in an overlay above it, so its
/// subscription badge opens the «اشتراک» page through this key.
final GlobalKey<NavigatorState> payeshAppNavigator = GlobalKey<NavigatorState>(
  debugLabel: 'payesh-app',
);

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
    this.whatsNew,
    this.themeMode,
  });

  /// Row 179: روشن / تاریک / سیستم chosen by the user (kept in prefs `theme`); null = the
  /// device decides (tests, previews).
  final PayeshThemeMode? themeMode;

  /// Row 179: the app's look — «مینیمال حرفه‌ای», chosen by the owner.
  static const look = PayeshLook.minimal;

  /// Keeps the web-parity palette ([Web]) in step with the resolved theme; true when it changed.
  static bool syncPalette(ThemeData theme) {
    final dark = theme.brightness == Brightness.dark;
    if (Web.palette.flat && Web.dark == dark) return false;
    final p = WebPalette.fromTokens(
      PayeshTokens.of(look, theme.brightness),
      theme.brightness,
    );
    Web.use(p);
    return true;
  }

  /// Row 148: version + update light at the top of every page (null in tests/local builds).
  /// Windows: changed files only, applied after the app closes, then it reopens by itself.
  final AppUpdater? updater;

  /// Android: the published APK in the system browser.
  final Future<void> Function(Uri url)? openUrl;

  /// Row 179: where the «seen» release is kept (installed app only; null in tests).
  final WhatsNewStore? whatsNew;

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

  /// Route builders of the wave pages (null = not available for this user / build).
  ({
    WidgetBuilder? attendance,
    WidgetBuilder? grades,
    WidgetBuilder? notices,
    WidgetBuilder? family,
  })
  _routes(SessionController s, SignedIn state, {String? as}) {
    final src = attendance;
    final gsrc = grades;
    final nsrc = notices;
    final fsrc = family;
    final role = as ?? state.currentRole;
    final uid = state.currentUid;
    if (role == null || uid == null) {
      return (attendance: null, grades: null, notices: null, family: null);
    }
    return (
      attendance: src == null
          ? null
          : (_) => AttendanceRoute(
              source: src,
              role: role,
              uid: uid,
              sync: s.sync,
              onRetry: onRetrySync,
              now: today,
            ),
      grades: gsrc == null
          ? null
          : (_) => GradesRoute(
              source: gsrc,
              role: role,
              uid: uid,
              sync: s.sync,
              onRetry: onRetrySync,
            ),
      notices: nsrc == null
          ? null
          : (_) => NoticesRoute(
              source: nsrc,
              role: role,
              uid: uid,
              sync: s.sync,
              onRetry: onRetrySync,
            ),
      family: fsrc == null
          ? null
          : (_) => FamilyRoute(
              source: fsrc,
              role: role,
              uid: uid,
              sync: s.sync,
              onRetry: onRetrySync,
            ),
    );
  }

  ({
    FamilyEntry fam,
    AttendanceEntry att,
    GradesEntry grd,
    NoticesEntry ntc,
    SchoolEntry sch,
  })
  _entries(
    BuildContext context,
    SessionController s,
    SignedIn state, {
    String? as,
  }) {
    final src = attendance;
    final gsrc = grades;
    final nsrc = notices;
    final fsrc = family;
    final role = as ?? state.currentRole;
    final uid = state.currentUid;
    final r = _routes(s, state, as: as);
    final fam = FamilyEntry(
      enabled: fsrc != null && s.flags.uses(NativeWave.parents),
      role: role,
      uid: uid,
      open: () {
        final b = r.family;
        if (b != null) {
          Navigator.of(context).push(MaterialPageRoute<void>(builder: b));
        }
      },
    );
    final att = AttendanceEntry(
      enabled: src != null && s.flags.uses(NativeWave.attendance),
      role: role,
      uid: uid,
      open: () {
        final b = r.attendance;
        if (b != null) {
          Navigator.of(context).push(MaterialPageRoute<void>(builder: b));
        }
      },
    );
    final grd = GradesEntry(
      enabled: gsrc != null && s.flags.uses(NativeWave.grades),
      role: role,
      uid: uid,
      open: () {
        final b = r.grades;
        if (b != null) {
          Navigator.of(context).push(MaterialPageRoute<void>(builder: b));
        }
      },
    );
    final ntc = NoticesEntry(
      enabled: nsrc != null && s.flags.uses(NativeWave.notices),
      role: role,
      uid: uid,
      open: () {
        final b = r.notices;
        if (b != null) {
          Navigator.of(context).push(MaterialPageRoute<void>(builder: b));
        }
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
    return (fam: fam, att: att, grd: grd, ntc: ntc, sch: sch);
  }

  /// Row 172: the sidebar is the web `navConfig(role)` exactly — same pages, labels, icons and
  /// order (client/pages.js). A web page this build has no native page for is left out (never
  /// a dead entry); native pages the web sidebar does not list are not added.
  List<PulseNavItem> _nav(
    BuildContext context,
    SessionController s,
    SignedIn state,
  ) {
    final own = _navOf(context, s, state, webNavConfig(state.currentRole));
    // Row 194: what the manager ticked for this staff member («سطح دسترسی») — those pages open
    // as the manager's pages; the school server accepts only the ticked collections.
    final role = state.currentRole;
    final uid = state.currentUid;
    final src = school;
    final access = src == null || role == null || uid == null
        ? const <String>[]
        : staffAccessCache.current(src, role, uid);
    if (access.isEmpty) return own;
    final pages = staffAccessPages(access);
    final granted = _navOf(context, s, state, [
      for (final n in [...webNavConfig('manager'), ...grantNavExtra])
        if (pages.contains(n.$4)) n,
    ], as: 'manager');
    final ids = {for (final m in granted) m.id};
    final kept = [
      for (final m in own)
        if (!ids.contains(m.id)) m,
    ];
    final at = kept.indexWhere((m) => m.id == 'system');
    return [
      ...at < 0 ? kept : kept.take(at),
      for (final m in granted)
        if (!kept.any((k) => k.id == m.id)) m,
      if (at >= 0) ...kept.skip(at),
    ];
  }

  List<PulseNavItem> _navOf(
    BuildContext context,
    SessionController s,
    SignedIn state,
    List<(String, String, String, String)> config, {
    String? as,
  }) {
    final e = _entries(context, s, state, as: as);
    final r = _routes(s, state, as: as);
    final native = <String, PulseNavItem>{
      for (final m in e.sch.navItems()) m.id: m,
      if (e.att.isTile && r.attendance != null)
        'attendance': PulseNavItem(
          id: 'attendance',
          label: 'حضور',
          icon: Icons.how_to_reg_outlined,
          page: r.attendance!,
        ),
      if (e.grd.isTile && r.grades != null)
        'grades': PulseNavItem(
          id: 'grades',
          label: 'نمره',
          icon: Icons.grading_outlined,
          page: r.grades!,
        ),
      if (e.ntc.isTile && r.notices != null)
        'notices': PulseNavItem(
          id: 'notices',
          label: 'اطلاعیه‌ها',
          icon: Icons.campaign_outlined,
          page: r.notices!,
        ),
      if (e.fam.isTile && r.family != null)
        'family': PulseNavItem(
          id: 'family',
          label: 'فرزندان',
          icon: Icons.family_restroom_outlined,
          page: r.family!,
        ),
      // Row 172: the parent's «مرخصی» (web `#/leaves`) — same data as «فرزندان»
      if (e.fam.isTile && family != null && state.currentUid != null)
        'parent-leaves': PulseNavItem(
          id: 'parent-leaves',
          label: 'مرخصی',
          icon: Icons.mail_outline,
          page: (_) => FamilyRoute(
            source: family!,
            role: state.currentRole!,
            uid: state.currentUid!,
            sync: s.sync,
            onRetry: onRetrySync,
            leaves: true,
          ),
        ),
    };
    return [
      for (final (route, icon, label, from) in config)
        if (native[from] case final m?)
          PulseNavItem(
            id: route,
            label: label,
            icon: m.icon,
            webIcon: icon,
            page: m.page,
          ),
    ];
  }

  Widget _pages(BuildContext context, SessionController s, SignedIn state) {
    final e = _entries(context, s, state);
    final (fam, att, grd, ntc, sch) = (e.fam, e.att, e.grd, e.ntc, e.sch);
    final hero = sch.pulseHero();
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
        // Row 170: «نبض امروز مدرسه» of the web panel on the manager's home
        ?hero,
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
    return PulseApp(
      updater: u,
      openUrl: openUrl,
      child: PayeshMaterialApp(
        navigatorKey: payeshAppNavigator,
        look: look,
        themeController: themeMode,
        onTheme: syncPalette,
        // Row 177: version + update light and the subscription badge in the top-left corner.
        overlayAlignment: Alignment.topLeft,
        overlay: u == null && themeMode == null
            ? null
            : Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (u != null)
                    AutoUpdateCheck(
                      updater: u,
                      child: TopStatus(
                        updater: u,
                        session: s,
                        openUrl: openUrl,
                      ),
                    ),
                  // Row 179: روشن / تاریک / سیستم, on every page
                  if (themeMode != null)
                    const Padding(
                      padding: EdgeInsetsDirectional.only(start: 4),
                      child: PayeshThemeButton(compact: true),
                    ),
                ],
              ),
        // Row 179: «چه چیزهایی تازه است؟» once after every update (Android, Windows, Win32).
        home: WhatsNewGate(
          store: whatsNew,
          audience: NoteAudience.school,
          appVersion: u?.channel.version,
          child: s == null
              ? HomeScreen(storage: storage, today: today)
              : ListenableBuilder(
                  // row 194: the menu follows the staff member's ticks
                  listenable: staffAccessCache,
                  builder: (context, _) => SessionGate(
                    controller: s,
                    home: HomeFooter(storage: storage, today: today),
                    pages: (context, state) => _pages(context, s, state),
                    nav: (context, state) => _nav(context, s, state),
                    accountName: _accountName,
                    admin: () => school?.admin,
                  ),
                ),
        ),
      ),
    );
  }

  /// Row 172: «name · role» of the sidebar — the user's own row of the local database.
  Future<String?> _accountName(SignedIn state) async {
    final src = school;
    final role = state.currentRole;
    final uid = state.currentUid;
    if (src == null || role == null || uid == null) return null;
    final db = await src.recordsFor(role: role, uid: uid);
    final row = await db?.get('users', uid);
    final n = row?.data['name'];
    return n is String ? n : null;
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

/// Row 177: the always-visible top-left corner of the school app — the subscription badge
/// («🎁 تست رایگان — N روز») at the very left and the version pill (with its update light) next
/// to it. The badge shows only for a signed-in, managed user with access ([showsSubStatus]).
class TopStatus extends StatelessWidget {
  const TopStatus({
    super.key = const Key('top-status'),
    required this.updater,
    this.session,
    this.openUrl,
  });

  final AppUpdater updater;
  final SessionController? session;
  final Future<void> Function(Uri url)? openUrl;

  @override
  Widget build(BuildContext context) {
    final s = session;
    return Row(
      mainAxisSize: MainAxisSize.min,
      // RTL: the first child is on the right, so the badge ends up in the corner
      children: [
        UpdateLight(updater: updater, openUrl: openUrl),
        if (s != null)
          ListenableBuilder(
            listenable: s,
            builder: (context, _) => showsSubStatus(s)
                ? Padding(
                    padding: const EdgeInsetsDirectional.only(start: 6),
                    child: SubBadge(
                      sub: s.sub!,
                      // Row 192: the badge opens the «اشتراک» page
                      onTap: () {
                        final nav = payeshAppNavigator.currentContext;
                        if (nav != null) openSubscription(nav, s);
                      },
                    ),
                  )
                : const SizedBox.shrink(),
          ),
      ],
    );
  }
}
