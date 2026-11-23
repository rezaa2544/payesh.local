// Row 128, wave W11 — the home dashboards (web `PAGES.home`: managerHome / teacherHome /
// studentHomeCard), `PAGES.reports` (weekly attendance per class, class report card, `print`),
// `PAGES['attendance-report']` (one day, every class) and the manager's leave list
// (`leave-set` / `leave-delete`). Reads come from the local copy (SchoolReports); the two leave
// writes go through the outbox first. `print` writes one self-contained HTML file on the device
// (there is no browser window to print from any more).
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_core/io.dart' show Directory, File, Platform;
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../school/school_source.dart';
import '../pulse/pulse.dart';
import '../pulse/web.dart';
import '../users/users_screen.dart' show recordBlocks;

String _jd(String iso) => faDigits(JalaliDate.fromIso(iso)?.slash ?? '—');

// ─────────────────────────────── home ───────────────────────────────

class HomeController extends SchoolController {
  HomeController({
    required super.source,
    required super.role,
    required super.uid,
  });

  Dashboard? dashboard;
  TodayView? today;

  /// Row 172: web `studentHome` = `studentHomeCard()` + `PAGES.record()`.
  StudentRecord? record;

  @override
  Future<void> read(SchoolRecords db) async {
    final r = SchoolReports(db);
    if (role == 'manager') {
      dashboard = await r.dashboard();
    } else {
      today = await r.today();
      if (role == 'student') {
        try {
          record = await UserDirectory(db).myRecord();
        } on RecordFailure {
          // the today card stays; the record part needs this student's own row
          record = null;
        }
      }
    }
  }
}

class DashboardScreen extends StatefulWidget {
  const DashboardScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });
  final HomeController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  HomeController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  void _go(String route) => PulseInline.go(context, route);

  String _bellLabel(Bell? b) => b == null
      ? 'بین زنگ‌های درسی'
      : (b.label.isNotEmpty ? b.label : 'زنگ ${faDigits(b.order)}');

  /// `.dashboard-card-title` + small muted line, the badge on the left (margin-bottom 10).
  Widget _covHead(String title, String sub, Widget badge) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                title,
                style: const TextStyle(
                  color: Web.primary,
                  fontSize: 15,
                  fontWeight: FontWeight.w900,
                ),
              ),
              Text(sub, style: Web.small),
            ],
          ),
        ),
        const SizedBox(width: 9.6),
        badge,
      ],
    ),
  );

  /// `.dashboard-empty`.
  Widget _dashEmpty(String t) => Container(
    padding: const EdgeInsets.all(14),
    decoration: BoxDecoration(
      border: Border.all(color: const Color(0xFF94A3B8)),
      borderRadius: BorderRadius.circular(12),
    ),
    child: Text(
      t,
      textAlign: TextAlign.center,
      style: const TextStyle(color: Web.muted, fontWeight: FontWeight.w600),
    ),
  );

  Widget _coverageCard(Dashboard d, bool twoCol) {
    WebTone tone(Coverage g) => g.roster == 0
        ? (g.checked > 0 ? WebTone.amber : WebTone.none)
        : g.checked >= g.roster
        ? WebTone.green
        : g.checked > 0
        ? WebTone.amber
        : WebTone.red;
    final bs = twoCol ? 10.0 : null;
    const strong = TextStyle(fontWeight: FontWeight.w800);
    return WebCard(
      key: const Key('dash-coverage'),
      padding: const EdgeInsets.all(12),
      margin: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _covHead(
            'پوشش حضور امروز · پایه و رشته',
            'تعداد دانش‌آموزانی که حضورشان برای امروز ثبت شده است.',
            WebBadge(
              '${Web.fa(d.covered)} از ${Web.fa(d.coverage.length)} گروه دارای ثبت',
              key: const Key('dash-covered'),
              tone: d.covered > 0 ? WebTone.green : WebTone.amber,
            ),
          ),
          if (d.coverage.isEmpty)
            _dashEmpty('هنوز پایه یا رشته‌ای برای پوشش حضور تعریف نشده است.')
          else
            WebTable(
              key: const Key('dash-coverage-table'),
              bordered: true,
              fontSize: twoCol ? 12 : 13.5,
              minWidth: twoCol ? null : 680,
              fixed: twoCol ? const [.12, .18, .12, .14, .30, .14] : null,
              cellPadding: twoCol
                  ? const EdgeInsets.symmetric(horizontal: 4.8, vertical: 6.4)
                  : const EdgeInsets.symmetric(horizontal: 7.2, vertical: 8),
              head: const [
                'پایه',
                'رشته',
                'دانش‌آموزان',
                'ثبت‌شده',
                'حاضر / غایب / تأخیر',
                'پوشش',
              ],
              rows: [
                for (final (i, g) in d.coverage.indexed)
                  [
                    Text(g.grade.isEmpty ? '—' : g.grade, style: strong),
                    Text(
                      g.branch.isNotEmpty
                          ? g.branch
                          : (g.grade.isNotEmpty
                                ? '—'
                                : (g.name.isEmpty ? '—' : g.name)),
                      style: strong,
                    ),
                    Text(Web.fa(g.roster)),
                    Text(
                      '${Web.fa(g.checked)} / ${Web.fa(g.roster)}',
                      style: strong,
                    ),
                    Wrap(
                      spacing: 4,
                      runSpacing: 4,
                      children: [
                        WebBadge(
                          '${Web.fa(g.present)} حاضر',
                          tone: WebTone.green,
                          size: bs,
                        ),
                        WebBadge(
                          '${Web.fa(g.absent)} غایب',
                          tone: WebTone.red,
                          size: bs,
                        ),
                        WebBadge(
                          '${Web.fa(g.late)} تأخیر',
                          tone: WebTone.amber,
                          size: bs,
                        ),
                      ],
                    ),
                    Align(
                      alignment: AlignmentDirectional.centerStart,
                      child: WebBadge(
                        g.roster > 0
                            ? '${Web.fa(g.ratio)}٪'
                            : (g.checked > 0 ? 'ثبت دارد' : 'بدون دانش‌آموز'),
                        key: Key('dash-cov-$i'),
                        tone: tone(g),
                        size: bs,
                      ),
                    ),
                  ],
              ],
            ),
        ],
      ),
    );
  }

  Widget _roomsCard(Dashboard d, bool twoCol) {
    final bell = d.bell;
    return WebCard(
      key: const Key('dash-rooms'),
      padding: const EdgeInsets.all(12),
      margin: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _covHead(
            'پوشش کلاس‌ها',
            bell != null
                ? 'وضعیت محل‌ها در زنگ ${bell.label.isNotEmpty ? bell.label : Web.fa(bell.order)} · ${Web.clock24(bell.start)}'
                : 'در حال حاضر زنگ درسی فعالی نیست.',
            WebBadge(
              '${Web.fa(d.rooms.length)} کلاس / محل',
              tone: d.rooms.any((r) => r.busy) ? WebTone.green : WebTone.none,
            ),
          ),
          if (d.rooms.isEmpty)
            _dashEmpty('هنوز کلاس یا محل برگزاری تعریف نشده است.')
          else
            WebTable(
              key: const Key('dash-rooms-table'),
              bordered: true,
              fontSize: twoCol ? 12 : 13.5,
              minWidth: twoCol ? null : 600,
              fixed: twoCol ? const [.18, .20, .26, .18, .18] : null,
              cellPadding: twoCol
                  ? const EdgeInsets.symmetric(horizontal: 4.8, vertical: 6.4)
                  : const EdgeInsets.symmetric(horizontal: 7.2, vertical: 8),
              rowColor: (i) => d.rooms[i].busy
                  ? Color.lerp(Web.card, Web.greenBg, 0.55)
                  : null,
              head: const ['کلاس / محل', 'وضعیت', 'پایه و رشته', 'درس', 'دبیر'],
              rows: [
                for (final r in d.rooms)
                  [
                    Text(
                      r.name.isEmpty ? '—' : r.name,
                      key: Key('dash-room-${r.id}'),
                      style: TextStyle(
                        fontWeight: FontWeight.w800,
                        color: r.busy ? Web.green : null,
                      ),
                    ),
                    Align(
                      alignment: AlignmentDirectional.centerStart,
                      child: WebBadge(
                        r.busy
                            ? 'در حال برگزاری'
                            : (bell != null ? 'خالی در این زنگ' : 'خالی اکنون'),
                        tone: r.busy ? WebTone.green : WebTone.none,
                      ),
                    ),
                    r.busy
                        ? Text(
                            r.cohort.isEmpty ? '—' : r.cohort,
                            style: const TextStyle(
                              fontWeight: FontWeight.w800,
                              color: Web.green,
                            ),
                          )
                        : const Text('—', style: TextStyle(color: Web.muted)),
                    Text(r.busy ? r.subject : '—'),
                    Text(r.busy && r.teacher.isNotEmpty ? r.teacher : '—'),
                  ],
              ],
            ),
        ],
      ),
    );
  }

  /// web `managerHome()`.
  List<Widget> _manager(Dashboard d) {
    final wide = MediaQuery.sizeOf(context).width > 1200;
    final title = MediaQuery.sizeOf(context).width * 0.022;
    return [
      // .topbar.dashboard-topbar
      Container(
        key: const Key('dash-topbar'),
        margin: const EdgeInsets.only(bottom: 14),
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
        decoration: BoxDecoration(
          border: Border.all(color: Web.line),
          borderRadius: BorderRadius.circular(Web.radius),
          gradient: LinearGradient(
            colors: [Color.lerp(Web.card, Web.primary, 0.06)!, Web.card],
          ),
          boxShadow: Web.shadow,
        ),
        child: Wrap(
          alignment: WrapAlignment.spaceBetween,
          crossAxisAlignment: WrapCrossAlignment.center,
          runSpacing: 8,
          children: [
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  'داشبورد مدرسه',
                  key: const Key('web-title'),
                  style: TextStyle(
                    fontSize: title.clamp(20, 27).toDouble(),
                    fontWeight: FontWeight.w900,
                    height: 1.4,
                    letterSpacing: -0.2,
                  ),
                ),
                const WebNowChip(),
              ],
            ),
            // @media (max-width:700px){.dashboard-topbar-left{width:100%;flex-wrap:wrap;gap:8px}}
            (MediaQuery.sizeOf(context).width <= 700
                ? (List<Widget> c) => Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      for (final w in c)
                        if (w is! SizedBox) w,
                    ],
                  )
                : (List<Widget> c) =>
                      Row(mainAxisSize: MainAxisSize.min, children: c))([
              WebBtn(
                '🔄 همگام‌سازی',
                key: const Key('dash-sync'),
                onPressed: widget.onRetry,
              ),
              const SizedBox(width: 9.6),
              WebBtn(
                'اطلاعیهٔ جدید',
                key: const Key('dash-new-notice'),
                kind: WebBtnKind.primary,
                onPressed: () => _go('announcements'),
              ),
              const SizedBox(width: 14),
              Container(
                key: const Key('dash-now'),
                constraints: const BoxConstraints(minWidth: 140),
                padding: const EdgeInsets.symmetric(
                  horizontal: 13,
                  vertical: 9,
                ),
                decoration: BoxDecoration(
                  border: Border.all(
                    color: Color.lerp(Web.line, Web.primary, 0.28)!,
                  ),
                  borderRadius: BorderRadius.circular(14),
                  color: Web.soft.withValues(alpha: 0.75),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.baseline,
                      textBaseline: TextBaseline.alphabetic,
                      children: [
                        const Text(
                          'الان در',
                          style: TextStyle(
                            fontSize: 11,
                            color: Web.muted,
                            height: 1.5,
                          ),
                        ),
                        const SizedBox(width: 5),
                        Text(
                          _bellLabel(d.bell),
                          style: const TextStyle(
                            fontSize: 14,
                            color: Web.primary,
                            fontWeight: FontWeight.w800,
                            height: 1.5,
                          ),
                        ),
                      ],
                    ),
                    Text(
                      '${Web.jDays[d.weekday]} · ${Web.fa(Web.jdate(d.today))}',
                      style: const TextStyle(
                        fontSize: 11,
                        color: Web.muted,
                        height: 1.5,
                      ),
                    ),
                  ],
                ),
              ),
            ]),
          ],
        ),
      ),
      // .grid — pulse.js puts «نبض امروز مدرسه» first, full width
      if (d.students > 0)
        Padding(
          padding: const EdgeInsets.only(bottom: 16),
          child: PulseHero(
            present: d.presentToday,
            of: d.students,
            absent: d.absentToday,
            late: d.lateToday,
          ),
        ),
      WebGrid(
        key: const Key('pulse-stats'),
        children: [
          WebStat(
            icon: 'users',
            num: Web.fa(d.students),
            label: 'دانش‌آموز',
            numKey: const Key('dash-students'),
          ),
          WebStat(
            icon: 'teacher',
            num: Web.fa(d.teachers),
            label: 'دبیر',
            numKey: const Key('dash-teachers'),
          ),
          WebStat(
            icon: 'school',
            num: Web.fa(d.classes),
            label: 'کلاس',
            numKey: const Key('dash-classes'),
          ),
          WebStat(
            icon: 'check',
            num: '${Web.fa(d.presentToday)} / ${Web.fa(d.recordsToday)}',
            label: 'حاضر امروز',
            numKey: const Key('dash-present'),
            numColor: Web.green,
          ),
          WebStat(
            icon: 'cross',
            num: Web.fa(d.absentToday),
            label: 'غایب امروز',
            numKey: const Key('dash-absent'),
            numColor: Web.red,
          ),
          WebStat(
            icon: 'clock',
            num: Web.fa(d.lateToday),
            label: 'تأخیر',
            numKey: const Key('dash-late'),
            numColor: Web.amber,
          ),
          WebStat(
            icon: 'pen',
            num: Web.fa(d.pendingGrades),
            label: 'نمرهٔ در انتظار تأیید',
            numKey: const Key('dash-pending'),
          ),
        ],
      ),
      // .dashboard-coverage-grid (two columns above 1200px, one below)
      Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: wide
            ? WebEqualRow(
                gap: 16,
                children: [_coverageCard(d, true), _roomsCard(d, true)],
              )
            : Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _coverageCard(d, false),
                  const SizedBox(height: 16),
                  _roomsCard(d, false),
                ],
              ),
      ),
      WebGrid(
        min: 160,
        children: [
          for (final (route, title, sub) in const [
            ('users', '👥 کاربران', 'افزودن، کارت پیوند، ورود دسته‌ای'),
            ('reports', '📑 گزارش‌ها', 'حضور، نمره، چاپ کارنامه'),
            ('system', '⚙️ سیستم', 'پشتیبان، دستگاه‌ها، آپدیت'),
          ])
            MouseRegion(
              cursor: SystemMouseCursors.click,
              child: GestureDetector(
                key: Key('dash-go-$route'),
                onTap: () => _go(route),
                child: WebCard(
                  margin: EdgeInsets.zero,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(title, style: Web.b.copyWith(color: Web.primary)),
                      Text(sub, style: Web.small),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
      if (d.recent.isNotEmpty)
        WebCard(
          key: const Key('dash-recent'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('آخرین اطلاعیه‌ها', style: Web.b),
              const SizedBox(height: 8),
              WebList(
                children: [
                  for (final (t, date) in d.recent)
                    WebItem(title: t, sub: Web.jdate(date)),
                ],
              ),
            ],
          ),
        ),
    ];
  }

  /// web `teacherHome()` / `studentHomeCard()`.
  List<Widget> _today(TodayView t) {
    final teacher = c.role == 'teacher';
    final bell = t.bell;
    return [
      if (teacher)
        WebCard(
          key: const Key('dash-bell'),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('زنگ جاری', style: Web.small),
                    Text(
                      bell != null
                          ? '${Web.clock24(bell.start)} – ${Web.clock24(bell.end)}'
                          : t.next != null
                          ? 'زنگ بعدی: ${Web.clock24(t.next!.start)}'
                          : 'زنگ درسی در جریان نیست',
                      key: const Key('dash-bell-text'),
                      style: Web.b.copyWith(fontSize: bell != null ? 17 : null),
                    ),
                  ],
                ),
              ),
              if (bell != null) WebBadge(bell.label, tone: WebTone.purple),
            ],
          ),
        )
      else if (bell != null)
        WebCard(
          key: const Key('dash-bell'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('زنگ جاری', style: Web.small),
              Text(
                '${bell.start} – ${bell.end}',
                key: const Key('dash-bell-text'),
                style: Web.b,
              ),
            ],
          ),
        ),
      WebCard(
        key: const Key('dash-today'),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (teacher)
              WebCardHead(
                title: 'برنامهٔ امروز',
                actions: [
                  Text('${Web.fa(t.slots.length)} زنگ', style: Web.small),
                ],
              )
            else
              const Padding(
                padding: EdgeInsets.only(bottom: 8),
                child: Text('برنامهٔ امروز', style: Web.b),
              ),
            if (t.slots.isEmpty)
              Text(
                teacher ? 'امروز کلاسی در برنامه ندارید.' : 'برنامه‌ای نیست.',
                key: const Key('dash-today-none'),
                style: Web.small,
              ),
            WebList(
              children: [
                for (final s in t.slots)
                  teacher
                      ? Container(
                          key: Key('dash-slot-${s.period}'),
                          decoration: s.current
                              ? BoxDecoration(
                                  borderRadius: BorderRadius.circular(12),
                                  border: Border.all(color: Web.primary),
                                  color: Web.soft,
                                )
                              : null,
                          child: WebItem(
                            leading: SizedBox(
                              width: 64,
                              child: Column(
                                children: [
                                  Text(
                                    Web.clock24(s.start),
                                    style: const TextStyle(
                                      fontWeight: FontWeight.w800,
                                    ),
                                  ),
                                  Text(Web.clock24(s.end), style: Web.small),
                                ],
                              ),
                            ),
                            title: s.className.isEmpty ? '—' : s.className,
                            sub:
                                '${s.subject.isEmpty ? '—' : s.subject} ${s.current ? '· زنگ جاری' : ''}',
                            actions: [
                              WebBadge(
                                s.done ? 'ثبت شده' : 'ثبت نشده',
                                key: Key('dash-done-${s.period}'),
                                tone: s.done ? WebTone.green : WebTone.red,
                              ),
                              WebBtn(
                                'ثبت',
                                kind: WebBtnKind.primary,
                                onPressed: () => _go('attendance'),
                              ),
                            ],
                          ),
                        )
                      : WebItem(
                          key: Key('dash-slot-${s.period}'),
                          leading: SizedBox(
                            width: 56,
                            child: Text(
                              s.start,
                              style: const TextStyle(
                                fontSize: 12.5,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ),
                          title: s.subject,
                          sub: s.teacher,
                        ),
              ],
            ),
          ],
        ),
      ),
      if (teacher)
        WebCard(
          child: Row(
            children: [
              Expanded(
                child: WebBtn(
                  '📝 ثبت نمره',
                  size: WebBtnSize.normal,
                  block: true,
                  onPressed: () => _go('grades'),
                ),
              ),
              const SizedBox(width: 9.6),
              Expanded(
                child: WebBtn(
                  '👥 دانش‌آموزان',
                  size: WebBtnSize.normal,
                  block: true,
                  onPressed: () => _go('students'),
                ),
              ),
            ],
          ),
        ),
    ];
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      final d = c.dashboard;
      final t = c.today;
      final manager = c.role == 'manager';
      return SchoolPage(
        prefix: 'dash',
        title: manager
            ? 'داشبورد مدرسه'
            : c.role == 'teacher'
            ? 'امروز من'
            : 'امروز',
        controller: c,
        sync: widget.sync,
        onRetry: widget.onRetry,
        body: const SizedBox.shrink(),
        // the manager's title row is the `.dashboard-topbar` card itself
        bare: manager,
        sub: t == null
            ? null
            : '${Web.jDays[t.weekday]} · ${Web.jdate(t.today)}',
        headActions: [
          if (!manager)
            WebBtn(
              '🔄',
              key: const Key('dash-sync'),
              onPressed: widget.onRetry,
            ),
        ],
        children: [
          if (d != null) ..._manager(d),
          if (t != null) ..._today(t),
          if (c.record case final r?) ...recordBlocks(r, first: false),
        ],
      );
    },
  );
}

// ─────────────────────────────── reports ───────────────────────────────

class ReportsController extends SchoolController {
  ReportsController({
    required super.source,
    required super.role,
    required super.uid,
  });

  /// Writes the printable file and returns where it is (tests replace it).
  static Future<String> Function(String fileName, String html) save = _saveFile;

  static Future<String> _saveFile(String fileName, String html) async {
    final home =
        Platform.environment['USERPROFILE'] ?? Platform.environment['HOME'];
    var dir = home == null
        ? null
        : Directory('$home${Platform.pathSeparator}Documents');
    if (dir == null || !dir.existsSync()) dir = Directory.systemTemp;
    final f = File('${dir.path}${Platform.pathSeparator}$fileName');
    await f.writeAsString(html, flush: true);
    return f.path;
  }

  List<ClassWeek> week = const [];
  ReportCard? card;
  int? classId;
  String school = '';

  @override
  Future<void> read(SchoolRecords db) async {
    final r = SchoolReports(db);
    week = await r.weekly();
    school = SchoolRecords.str((await db.get('schools', 1))?.data['name']);
    final classes = week.map((w) => w.classId).toList();
    if (classId == null || !classes.contains(classId)) {
      classId = classes.firstOrNull;
    }
    card = classId == null ? null : await r.card(classId!);
  }

  Future<void> pick(int id) async {
    classId = id;
    await load();
  }

  /// `print`.
  Future<void> print() async {
    final d = db;
    if (d == null) return;
    busy = true;
    error = null;
    emit();
    try {
      final html = SchoolReports.printable(
        school: school.isEmpty ? 'پایش' : school,
        dateFa: _jd(d.today()),
        week: week,
        card: card,
      );
      final path = await save('payesh-report-${d.today()}.html', html);
      notice = 'نسخهٔ چاپی ذخیره شد: $path — آن را باز کنید و چاپ بگیرید';
    } on Exception catch (e) {
      error = 'فایل چاپی ذخیره نشد: $e';
    }
    busy = false;
    emit();
  }
}

class ReportsScreen extends StatefulWidget {
  const ReportsScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });
  final ReportsController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<ReportsScreen> createState() => _ReportsScreenState();
}

class _ReportsScreenState extends State<ReportsScreen> {
  ReportsController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  static WebTone _tone(int pct) => pct >= 90
      ? WebTone.green
      : pct >= 75
      ? WebTone.amber
      : WebTone.red;

  /// Row 172: web `PAGES.reports` exactly — pageHead «گزارش‌ها» + «هفتهٔ اخیر» with «🖨️ چاپ»;
  /// the weekly table card; «کارنامهٔ کلاسی» with the class select (max 240) on the left.
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      final card = c.card;
      return SchoolPage(
        prefix: 'rep',
        title: 'گزارش‌ها',
        controller: c,
        sync: widget.sync,
        onRetry: widget.onRetry,
        body: const SizedBox.shrink(),
        sub: 'هفتهٔ اخیر',
        headActions: [
          WebBtn(
            '🖨️ چاپ',
            key: const Key('rep-print'),
            onPressed: c.busy ? null : c.print,
          ),
        ],
        children: [
          WebCard(
            key: const Key('rep-week'),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text('حضور هفتگی به تفکیک کلاس', style: Web.b),
                WebTable(
                  key: const Key('rep-week-table'),
                  head: const ['کلاس', 'ثبت', 'حاضر', 'غایب', 'تأخیر', 'درصد'],
                  rows: [
                    for (final r in c.week)
                      [
                        Text(r.name),
                        Text(Web.fa(r.records)),
                        Text(Web.fa(r.present)),
                        Text(Web.fa(r.absent)),
                        Text(Web.fa(r.late)),
                        Align(
                          alignment: AlignmentDirectional.centerStart,
                          child: WebBadge(
                            '${Web.fa(r.pct)}٪',
                            key: Key('rep-pct-${r.classId}'),
                            tone: _tone(r.pct),
                          ),
                        ),
                      ],
                  ],
                ),
              ],
            ),
          ),
          WebCard(
            key: const Key('rep-card'),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    const Expanded(child: Text('کارنامهٔ کلاسی', style: Web.b)),
                    if (c.week.isNotEmpty)
                      SizedBox(
                        width: 240,
                        child: DropdownButtonFormField<int>(
                          key: const Key('rep-class'),
                          initialValue: c.classId,
                          isExpanded: true,
                          isDense: true,
                          style: const TextStyle(
                            fontSize: 15,
                            color: Web.ink,
                            fontFamily: 'Vazirmatn',
                          ),
                          decoration: webInput(),
                          items: [
                            for (final w in c.week)
                              DropdownMenuItem(
                                value: w.classId,
                                child: Text(w.name),
                              ),
                          ],
                          onChanged: (v) {
                            if (v != null) c.pick(v);
                          },
                        ),
                      ),
                  ],
                ),
                const SizedBox(height: 8),
                if (card == null || card.rows.isEmpty)
                  const Text(
                    'دانش‌آموزی نیست.',
                    key: Key('rep-card-none'),
                    style: Web.small,
                  )
                else
                  WebTable(
                    key: const Key('rep-card-table'),
                    head: [
                      'دانش‌آموز',
                      for (final (_, n) in card.subjects) n,
                      'معدل',
                      'حضور',
                    ],
                    rows: [
                      for (final r in card.rows)
                        [
                          Text(r.name),
                          for (final (id, _) in card.subjects)
                            Text(
                              r.scores[id] == null
                                  ? '—'
                                  : faDigits(r.scores[id]),
                            ),
                          Text(
                            faDigits(r.average.toStringAsFixed(2)),
                            key: Key('rep-avg-${r.studentId}'),
                            style: const TextStyle(fontWeight: FontWeight.w700),
                          ),
                          Text(
                            '${Web.fa(r.attendancePct)}٪',
                            key: Key('rep-att-${r.studentId}'),
                          ),
                        ],
                    ],
                  ),
                const SizedBox(height: 8),
                const Text(
                  'میانگین‌ها از نمرات ثبت‌شده محاسبه می‌شوند؛ برای چاپ، دکمهٔ «چاپ» بالا.',
                  style: Web.small,
                ),
              ],
            ),
          ),
        ],
      );
    },
  );
}

// ─────────────────────────────── attendance report ───────────────────────────────

class DayReportController extends SchoolController {
  DayReportController({
    required super.source,
    required super.role,
    required super.uid,
  });

  String? date;
  List<DayClass> classes = const [];

  @override
  Future<void> read(SchoolRecords db) async {
    date ??= db.today();
    classes = await SchoolReports(db).day(date!);
  }

  Future<void> setDate(String iso) async {
    date = iso;
    await load();
  }

  Future<void> shift(int days) async {
    final d = DateTime.parse('${date ?? db?.today()}T12:00:00Z')
        .add(Duration(days: days));
    date = d.toIso8601String().substring(0, 10);
    await load();
  }
}

class DayReportScreen extends StatefulWidget {
  const DayReportScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });
  final DayReportController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<DayReportScreen> createState() => _DayReportScreenState();
}

class _DayReportScreenState extends State<DayReportScreen> {
  DayReportController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  /// Row 172: web `PAGES['attendance-report']` exactly — pageHead «حضور و غیاب» + jdate with
  /// the Jalali date input; one card per class: name, «N حاضر از M» / «ثبت نشده», the red
  /// badges of the absent/late (or «همه حاضر»).
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) => SchoolPage(
      prefix: 'atr',
      title: 'حضور و غیاب',
      controller: c,
      sync: widget.sync,
      onRetry: widget.onRetry,
      body: const SizedBox.shrink(),
      sub: c.date == null ? null : Web.jdate(c.date),
      headActions: [
        if (c.date != null)
          SizedBox(
            width: 180,
            child: WebJalaliField(
              key: const Key('atr-date'),
              iso: c.date,
              onChanged: c.setDate,
            ),
          ),
      ],
      children: [
        for (final d in c.classes)
          WebCard(
            key: Key('atr-class-${d.classId}'),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(child: Text(d.name, style: Web.b)),
                    Text(
                      d.records > 0
                          ? '${Web.fa(d.present)} حاضر از ${Web.fa(d.records)}'
                          : 'ثبت نشده',
                      key: Key('atr-count-${d.classId}'),
                      style: Web.small,
                    ),
                  ],
                ),
                if (d.records > 0)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: d.notPresent.isEmpty
                        ? const Text('همه حاضر', style: Web.small)
                        : Wrap(
                            spacing: 4,
                            runSpacing: 4,
                            children: [
                              for (final (i, (n, l)) in d.notPresent.indexed)
                                WebBadge(
                                  '$n · $l',
                                  key: Key('atr-miss-${d.classId}-$i'),
                                  tone: WebTone.red,
                                ),
                            ],
                          ),
                  ),
              ],
            ),
          ),
      ],
    ),
  );
}

// ─────────────────────────────── leaves (manager) ───────────────────────────────

class LeaveDeskController extends SchoolController {
  LeaveDeskController({
    required super.source,
    required super.role,
    required super.uid,
  });

  List<LeaveRow> rows = const [];

  @override
  Future<void> read(SchoolRecords db) async {
    rows = await SchoolReports(db).leaves();
  }

  Future<RecordWrite?> decide(int id, String status) =>
      run((db) => SchoolReports(db).decide(id, status));

  Future<RecordWrite?> delete(int id) =>
      run((db) => SchoolReports(db).deleteLeave(id));
}

class LeaveDeskScreen extends StatefulWidget {
  const LeaveDeskScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });
  final LeaveDeskController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<LeaveDeskScreen> createState() => _LeaveDeskScreenState();
}

class _LeaveDeskScreenState extends State<LeaveDeskScreen> {
  LeaveDeskController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  Future<void> _delete(LeaveRow l) async {
    final ok = await confirmAction(
      context,
      prefix: 'lvd',
      title: 'حذف درخواست',
      message: 'این درخواست مرخصی حذف شود؟',
    );
    if (ok) await c.delete(l.id);
  }

  /// Row 172: web `PAGES.leaves` (manager view) — pageHead «مرخصی و غیبت موجه» + «N درخواست»;
  /// per request: bold name, state badge, «date · reason», «تأیید» / «رد» / «حذف».
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) => SchoolPage(
      prefix: 'lvd',
      title: 'مرخصی و غیبت موجه',
      controller: c,
      sync: widget.sync,
      onRetry: widget.onRetry,
      body: const SizedBox.shrink(),
      sub: '${faNumber(c.rows.length)} درخواست',
      subKey: const Key('lvd-count'),
      children: [
        if (c.rows.isEmpty)
          const WebEmpty('درخواستی ثبت نشده.', key: Key('lvd-none')),
        for (final l in c.rows)
          WebCard(
            key: Key('lvd-row-${l.id}'),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        l.student.isEmpty ? '—' : l.student,
                        style: Web.b,
                      ),
                    ),
                    if (l.queued) ...[
                      const WebBadge('در صف ارسال', tone: WebTone.amber),
                      const SizedBox(width: 6),
                    ],
                    WebBadge(
                      l.statusFa,
                      key: Key('lvd-status-${l.id}'),
                      tone: l.status == 'approved'
                          ? WebTone.green
                          : l.status == 'rejected'
                          ? WebTone.red
                          : WebTone.amber,
                    ),
                  ],
                ),
                Text(
                  '${Web.jdate(l.date)} · ${l.reason}',
                  style: const TextStyle(
                    fontSize: 12.5,
                    color: Web.muted,
                    height: 1.6,
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      WebBtn(
                        'تأیید',
                        key: Key('lvd-approve-${l.id}'),
                        onPressed: c.busy
                            ? null
                            : () => c.decide(l.id, 'approved'),
                      ),
                      WebBtn(
                        'رد',
                        key: Key('lvd-reject-${l.id}'),
                        kind: WebBtnKind.ghost,
                        onPressed: c.busy
                            ? null
                            : () => c.decide(l.id, 'rejected'),
                      ),
                      WebBtn.delete(
                        'حذف',
                        key: Key('lvd-delete-${l.id}'),
                        onPressed: c.busy ? null : () => _delete(l),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
      ],
    ),
  );
}
