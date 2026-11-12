// Row 128, wave W11 — the home dashboards (web `PAGES.home`: managerHome / teacherHome /
// studentHomeCard), `PAGES.reports` (weekly attendance per class, class report card, `print`),
// `PAGES['attendance-report']` (one day, every class) and the manager's leave list
// (`leave-set` / `leave-delete`). Reads come from the local copy (SchoolReports); the two leave
// writes go through the outbox first. `print` writes one self-contained HTML file on the device
// (there is no browser window to print from any more).
import 'dart:io' show Directory, File, Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../school/school_source.dart';

String _jd(String iso) => faDigits(JalaliDate.fromIso(iso)?.slash ?? '—');

PayeshTone _pctTone(int pct) => pct >= 90
    ? PayeshTone.success
    : pct >= 75
    ? PayeshTone.warning
    : PayeshTone.danger;

Widget _card(
  BuildContext context,
  String title,
  List<Widget> children, {
  Key? key,
  Widget? trailing,
}) => Card(
  key: key,
  child: Padding(
    padding: const EdgeInsets.all(PayeshTokens.space3),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                title,
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
            ?trailing,
          ],
        ),
        const SizedBox(height: PayeshTokens.space2),
        ...children,
      ],
    ),
  ),
);

Widget _table(Key key, List<String> head, List<List<Widget>> rows) =>
    SingleChildScrollView(
      key: key,
      scrollDirection: Axis.horizontal,
      child: DataTable(
        columns: [for (final h in head) DataColumn(label: Text(h))],
        rows: [
          for (final r in rows)
            DataRow(cells: [for (final c in r) DataCell(c)]),
        ],
      ),
    );

// ─────────────────────────────── home ───────────────────────────────

class HomeController extends SchoolController {
  HomeController({
    required super.source,
    required super.role,
    required super.uid,
  });

  Dashboard? dashboard;
  TodayView? today;

  @override
  Future<void> read(SchoolRecords db) async {
    final r = SchoolReports(db);
    if (role == 'manager') {
      dashboard = await r.dashboard();
    } else {
      today = await r.today();
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

  Widget _stat(
    String key,
    String icon,
    String value,
    String label, [
    PayeshTone tone = PayeshTone.neutral,
  ]) => SizedBox(
    width: 150,
    child: Card(
      key: Key('dash-stat-$key'),
      child: Padding(
        padding: const EdgeInsets.all(PayeshTokens.space3),
        child: Column(
          children: [
            Text(icon, style: const TextStyle(fontSize: 22)),
            Text(
              value,
              key: Key('dash-$key'),
              style: Theme.of(context).textTheme.titleLarge?.copyWith(
                color: tone == PayeshTone.neutral
                    ? null
                    : context.tokens.tone(tone).$1,
              ),
            ),
            Text(label, textAlign: TextAlign.center),
          ],
        ),
      ),
    ),
  );

  String _bellLabel(Bell? b) => b == null
      ? 'بین زنگ‌های درسی'
      : (b.label.isNotEmpty ? b.label : 'زنگ ${faDigits(b.order)}');

  List<Widget> _manager(Dashboard d) => [
    Text(
      'الان در ${_bellLabel(d.bell)} · ${schedDayFa[d.weekday]} ${_jd(d.today)}',
      key: const Key('dash-now'),
    ),
    const SizedBox(height: PayeshTokens.space2),
    Wrap(
      spacing: PayeshTokens.space2,
      runSpacing: PayeshTokens.space2,
      children: [
        _stat('students', '👥', faNumber(d.students), 'دانش‌آموز'),
        _stat('teachers', '👨‍🏫', faNumber(d.teachers), 'دبیر'),
        _stat('classes', '🏛️', faNumber(d.classes), 'کلاس'),
        _stat(
          'present',
          '✅',
          '${faNumber(d.presentToday)} / ${faNumber(d.recordsToday)}',
          'حاضر امروز',
          PayeshTone.success,
        ),
        _stat(
          'absent',
          '❌',
          faNumber(d.absentToday),
          'غایب امروز',
          PayeshTone.danger,
        ),
        _stat('late', '⏰', faNumber(d.lateToday), 'تأخیر', PayeshTone.warning),
        _stat(
          'pending',
          '📝',
          faNumber(d.pendingGrades),
          'نمرهٔ در انتظار تأیید',
          PayeshTone.info,
        ),
      ],
    ),
    _card(
      context,
      'پوشش حضور امروز · پایه و رشته',
      key: const Key('dash-coverage'),
      trailing: StatusBadge(
        '${faNumber(d.covered)} از ${faNumber(d.coverage.length)} گروه دارای ثبت',
        key: const Key('dash-covered'),
        tone: d.covered > 0 ? PayeshTone.success : PayeshTone.warning,
      ),
      [
        if (d.coverage.isEmpty)
          const Text('هنوز پایه یا رشته‌ای برای پوشش حضور تعریف نشده است.')
        else
          _table(
            const Key('dash-coverage-table'),
            const [
              'پایه',
              'رشته',
              'دانش‌آموزان',
              'ثبت‌شده',
              'حاضر / غایب / تأخیر',
              'پوشش',
            ],
            [
              for (final (i, g) in d.coverage.indexed)
                [
                  Text(g.grade.isEmpty ? '—' : g.grade),
                  Text(
                    g.branch.isNotEmpty
                        ? g.branch
                        : (g.grade.isEmpty ? g.name : '—'),
                  ),
                  Text(faNumber(g.roster)),
                  Text('${faNumber(g.checked)} / ${faNumber(g.roster)}'),
                  Text(
                    '${faNumber(g.present)} حاضر · ${faNumber(g.absent)} غایب · ${faNumber(g.late)} تأخیر',
                  ),
                  StatusBadge(
                    g.roster > 0
                        ? '${faNumber(g.ratio)}٪'
                        : (g.checked > 0 ? 'ثبت دارد' : 'بدون دانش‌آموز'),
                    key: Key('dash-cov-$i'),
                    tone: g.roster == 0
                        ? PayeshTone.neutral
                        : g.checked >= g.roster
                        ? PayeshTone.success
                        : g.checked > 0
                        ? PayeshTone.warning
                        : PayeshTone.danger,
                  ),
                ],
            ],
          ),
      ],
    ),
    _card(context, 'پوشش کلاس‌ها', key: const Key('dash-rooms'), [
      Text(
        d.bell == null
            ? 'در حال حاضر زنگ درسی فعالی نیست.'
            : 'وضعیت محل‌ها در ${_bellLabel(d.bell)}',
      ),
      if (d.rooms.isEmpty)
        const Text('هنوز کلاس یا محل برگزاری تعریف نشده است.')
      else
        for (final r in d.rooms)
          ListTile(
            key: Key('dash-room-${r.id}'),
            dense: true,
            title: Text(r.name),
            subtitle: r.busy
                ? Text('${r.cohort} · ${r.subject} · ${r.teacher}')
                : null,
            trailing: StatusBadge(
              r.busy
                  ? 'در حال برگزاری'
                  : (d.bell != null ? 'خالی در این زنگ' : 'خالی اکنون'),
              tone: r.busy ? PayeshTone.success : PayeshTone.neutral,
            ),
          ),
    ]),
    if (d.recent.isNotEmpty)
      _card(context, 'آخرین اطلاعیه‌ها', key: const Key('dash-recent'), [
        for (final (t, date) in d.recent)
          ListTile(dense: true, title: Text(t), subtitle: Text(_jd(date))),
      ]),
  ];

  List<Widget> _today(TodayView t) => [
    _card(context, 'زنگ جاری', key: const Key('dash-bell'), [
      Text(
        t.bell != null
            ? '${faDigits(schedTime(t.bell!.start))} – ${faDigits(schedTime(t.bell!.end))}'
                  '${t.bell!.label.isEmpty ? '' : ' · ${t.bell!.label}'}'
            : t.next != null
            ? 'زنگ بعدی: ${faDigits(schedTime(t.next!.start))}'
            : 'زنگ درسی در جریان نیست',
        key: const Key('dash-bell-text'),
      ),
    ]),
    _card(
      context,
      'برنامهٔ امروز',
      key: const Key('dash-today'),
      trailing: Text('${faNumber(t.slots.length)} زنگ'),
      [
        if (t.slots.isEmpty)
          Text(
            c.role == 'teacher'
                ? 'امروز کلاسی در برنامه ندارید.'
                : 'برنامه‌ای نیست.',
            key: const Key('dash-today-none'),
          ),
        for (final s in t.slots)
          ListTile(
            key: Key('dash-slot-${s.period}'),
            selected: s.current,
            leading: Text(faDigits(s.start.isEmpty ? '—' : s.start)),
            title: Text(
              c.role == 'teacher'
                  ? (s.className.isEmpty ? '—' : s.className)
                  : s.subject,
            ),
            subtitle: Text(
              c.role == 'teacher'
                  ? '${s.subject}${s.current ? ' · زنگ جاری' : ''}'
                  : s.teacher,
            ),
            trailing: c.role == 'teacher'
                ? StatusBadge(
                    s.done ? 'ثبت شده' : 'ثبت نشده',
                    key: Key('dash-done-${s.period}'),
                    tone: s.done ? PayeshTone.success : PayeshTone.danger,
                  )
                : null,
          ),
      ],
    ),
  ];

  @override
  Widget build(BuildContext context) => SchoolPage(
    prefix: 'dash',
    title: c.role == 'manager'
        ? 'داشبورد مدرسه'
        : c.role == 'teacher'
        ? 'امروز من'
        : 'امروز',
    controller: c,
    sync: widget.sync,
    onRetry: widget.onRetry,
    body: ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final d = c.dashboard;
        final t = c.today;
        return ListView(
          padding: const EdgeInsets.all(PayeshTokens.space4),
          children: [
            if (d != null) ..._manager(d),
            if (t != null) ...[
              Text(
                '${schedDayFa[t.weekday]} · ${_jd(t.today)}',
                key: const Key('dash-now'),
              ),
              ..._today(t),
            ],
          ],
        );
      },
    ),
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

  @override
  Widget build(BuildContext context) => SchoolPage(
    prefix: 'rep',
    title: 'گزارش‌ها',
    controller: c,
    sync: widget.sync,
    onRetry: widget.onRetry,
    actions: [
      TextButton.icon(
        key: const Key('rep-print'),
        onPressed: c.busy ? null : c.print,
        icon: const Icon(Icons.print_outlined),
        label: const Text('چاپ'),
      ),
    ],
    body: ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final card = c.card;
        return ListView(
          padding: const EdgeInsets.all(PayeshTokens.space4),
          children: [
            _card(
              context,
              'حضور هفتگی به تفکیک کلاس',
              key: const Key('rep-week'),
              [
                const Text('هفتهٔ اخیر'),
                _table(
                  const Key('rep-week-table'),
                  const ['کلاس', 'ثبت', 'حاضر', 'غایب', 'تأخیر', 'درصد'],
                  [
                    for (final r in c.week)
                      [
                        Text(r.name),
                        Text(faNumber(r.records)),
                        Text(faNumber(r.present)),
                        Text(faNumber(r.absent)),
                        Text(faNumber(r.late)),
                        StatusBadge(
                          '${faNumber(r.pct)}٪',
                          key: Key('rep-pct-${r.classId}'),
                          tone: _pctTone(r.pct),
                        ),
                      ],
                  ],
                ),
              ],
            ),
            _card(context, 'کارنامهٔ کلاسی', key: const Key('rep-card'), [
              if (c.week.isNotEmpty)
                DropdownButtonFormField<int>(
                  key: const Key('rep-class'),
                  initialValue: c.classId,
                  isExpanded: true,
                  decoration: const InputDecoration(
                    labelText: 'کلاس',
                    border: OutlineInputBorder(),
                  ),
                  items: [
                    for (final w in c.week)
                      DropdownMenuItem(value: w.classId, child: Text(w.name)),
                  ],
                  onChanged: (v) {
                    if (v != null) c.pick(v);
                  },
                ),
              const SizedBox(height: PayeshTokens.space2),
              if (card == null || card.rows.isEmpty)
                const Text('دانش‌آموزی نیست.', key: Key('rep-card-none'))
              else
                _table(
                  const Key('rep-card-table'),
                  [
                    'دانش‌آموز',
                    for (final (_, n) in card.subjects) n,
                    'معدل',
                    'حضور',
                  ],
                  [
                    for (final r in card.rows)
                      [
                        Text(r.name),
                        for (final (id, _) in card.subjects)
                          Text(
                            r.scores[id] == null ? '—' : faDigits(r.scores[id]),
                          ),
                        Text(
                          faDigits(r.average.toStringAsFixed(2)),
                          key: Key('rep-avg-${r.studentId}'),
                          style: const TextStyle(fontWeight: FontWeight.bold),
                        ),
                        Text(
                          '${faNumber(r.attendancePct)}٪',
                          key: Key('rep-att-${r.studentId}'),
                        ),
                      ],
                  ],
                ),
              const SizedBox(height: PayeshTokens.space2),
              const Text(
                'میانگین‌ها از نمرات ثبت‌شده محاسبه می‌شوند؛ برای چاپ، دکمهٔ «چاپ» بالا.',
              ),
            ]),
          ],
        );
      },
    ),
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

  @override
  Widget build(BuildContext context) => SchoolPage(
    prefix: 'atr',
    title: 'حضور و غیاب',
    controller: c,
    sync: widget.sync,
    onRetry: widget.onRetry,
    body: ListenableBuilder(
      listenable: c,
      builder: (context, _) => ListView(
        padding: const EdgeInsets.all(PayeshTokens.space4),
        children: [
          Row(
            children: [
              IconButton(
                key: const Key('atr-prev'),
                tooltip: 'روز قبل',
                onPressed: () => c.shift(-1),
                icon: const Icon(Icons.chevron_right),
              ),
              Expanded(
                child: Text(
                  c.date == null ? '—' : _jd(c.date!),
                  key: const Key('atr-date'),
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              IconButton(
                key: const Key('atr-next'),
                tooltip: 'روز بعد',
                onPressed: () => c.shift(1),
                icon: const Icon(Icons.chevron_left),
              ),
            ],
          ),
          for (final d in c.classes)
            _card(
              context,
              d.name,
              key: Key('atr-class-${d.classId}'),
              trailing: Text(
                d.records > 0
                    ? '${faNumber(d.present)} حاضر از ${faNumber(d.records)}'
                    : 'ثبت نشده',
                key: Key('atr-count-${d.classId}'),
              ),
              [
                if (d.records > 0)
                  d.notPresent.isEmpty
                      ? const Text('همه حاضر')
                      : Wrap(
                          spacing: PayeshTokens.space2,
                          runSpacing: PayeshTokens.space2,
                          children: [
                            for (final (i, (n, l)) in d.notPresent.indexed)
                              StatusBadge(
                                '$n · $l',
                                key: Key('atr-miss-${d.classId}-$i'),
                                tone: PayeshTone.danger,
                              ),
                          ],
                        ),
              ],
            ),
        ],
      ),
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

  @override
  Widget build(BuildContext context) => SchoolPage(
    prefix: 'lvd',
    title: 'مرخصی و غیبت موجه',
    controller: c,
    sync: widget.sync,
    onRetry: widget.onRetry,
    body: ListenableBuilder(
      listenable: c,
      builder: (context, _) => ListView(
        padding: const EdgeInsets.all(PayeshTokens.space4),
        children: [
          Text(
            '${faNumber(c.rows.length)} درخواست',
            key: const Key('lvd-count'),
          ),
          if (c.rows.isEmpty)
            const Text('درخواستی ثبت نشده.', key: Key('lvd-none')),
          for (final l in c.rows)
            _card(
              context,
              l.student.isEmpty ? '—' : l.student,
              key: Key('lvd-row-${l.id}'),
              trailing: StatusBadge(
                l.statusFa,
                key: Key('lvd-status-${l.id}'),
                tone: l.status == 'approved'
                    ? PayeshTone.success
                    : l.status == 'rejected'
                    ? PayeshTone.danger
                    : PayeshTone.warning,
              ),
              [
                Text('${_jd(l.date)} · ${l.reason}'),
                if (l.queued) const Text('در صف ارسال'),
                Wrap(
                  spacing: PayeshTokens.space2,
                  children: [
                    FilledButton(
                      key: Key('lvd-approve-${l.id}'),
                      onPressed: c.busy
                          ? null
                          : () => c.decide(l.id, 'approved'),
                      child: const Text('تأیید'),
                    ),
                    OutlinedButton(
                      key: Key('lvd-reject-${l.id}'),
                      onPressed: c.busy
                          ? null
                          : () => c.decide(l.id, 'rejected'),
                      child: const Text('رد'),
                    ),
                    TextButton(
                      key: Key('lvd-delete-${l.id}'),
                      onPressed: c.busy ? null : () => _delete(l),
                      child: Text(
                        'حذف',
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
        ],
      ),
    ),
  );
}
