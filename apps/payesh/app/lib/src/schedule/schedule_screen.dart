// Row 128, wave W9 — `#/schedule` (web client/schedule.js `schedPage`): the weekly grid per
// grade + branch for the manager (slot form, clashes + suggested moves, substitutions, bells,
// work days, generator), the teacher's own teaching / home class, and the read-only view of a
// student or a parent's child. Every write is local-first through Timetable (queue first).
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../pulse/pulse.dart';
import '../pulse/web.dart';
import '../school/school_source.dart';

String _fa(Object n) => '$n'.replaceAllMapped(
  RegExp('[0-9]'),
  (m) => '۰۱۲۳۴۵۶۷۸۹'[int.parse(m[0]!)],
);

class ScheduleController extends SchoolController {
  ScheduleController({
    required super.source,
    required super.role,
    required super.uid,
  });

  TimetableView? view;

  /// Row 166: this week's shift of a rotating school (shown above the grid), or null.
  String? weekShiftFa;
  String? grade;
  String? branch;

  /// ردیف ۱۹۵: کلاسِ انتخاب‌شده در مدرسهٔ کلاس‌محور.
  int? classId;
  int? homeClass;
  int? child;

  /// Clash rows whose suggestions are open (web `sched-conf-sug` toggles a box).
  final Set<int> openSuggestions = {};
  final Map<int, List<(int, int)>> suggestions = {};

  Timetable get _t => Timetable(db!);

  @override
  Future<void> read(SchoolRecords db) async {
    view = await Timetable(db).view(
      grade: grade,
      branch: branch,
      classId: classId,
      homeClass: homeClass,
      child: child,
    );
    weekShiftFa = await Timetable(db).weekShift();
    for (final id in openSuggestions) {
      suggestions[id] = await Timetable(db).suggest(id);
    }
  }

  void pickCohort({String? grade, String? branch}) {
    if (grade != null && grade != this.grade) {
      this.grade = grade;
      this.branch = null; // web: a new grade starts at its first branch
    }
    if (branch != null) this.branch = branch;
    load();
  }

  void pickClass(int? id) {
    classId = id;
    load();
  }

  void pickHome(int? id) {
    homeClass = id;
    load();
  }

  /// `sched-class` (web): the parent's child whose class is shown.
  void pickChild(int id) {
    child = id;
    load();
  }

  Future<void> toggleSuggestions(int id) async {
    if (!openSuggestions.remove(id)) {
      openSuggestions.add(id);
      if (db != null) suggestions[id] = await _t.suggest(id);
    }
    emit();
  }

  Future<RecordWrite?> move(int id, int day, int period) =>
      run((db) => Timetable(db).move(id, day, period));

  Future<List<TeacherOption>> teachers(int day, int period, int? except) =>
      _t.teachers(day: day, period: period, exceptSlot: except);
  Future<List<(int, String)>> subjects() => _t.subjects();
  Future<List<(int, String)>> rooms() => _t.rooms();
  Future<List<int>> workDays() => _t.workDays();
  Future<List<Bell>> lessons() => _t.lessons();
  Future<List<BellDraft>> bellDraft({String? shift}) =>
      _t.bellDraft(shift: shift);

  /// Row 166: rotating shift (the whole school: a morning week, then an afternoon week).
  Future<bool> rotating() => _t.rotating();
  Future<Rotation> rotation() => _t.rotation();
  Future<String?> weekShift() => _t.weekShift();
  Future<RecordWrite?> saveRotatingBells({
    required List<BellDraft> morning,
    required List<BellDraft> afternoon,
    required String first,
    String? start,
  }) => run(
    (db) => Timetable(db).saveRotatingBells(
      morning: morning,
      afternoon: afternoon,
      first: first,
      start: start,
    ),
    form: true,
  );
  Future<GenResult?> generate() async {
    try {
      return await _t.generate();
    } on RecordFailure catch (e) {
      error = e.messageFa;
      emit();
      return null;
    }
  }

  Future<RecordWrite?> saveSlot(SlotDraft d) =>
      run((db) => Timetable(db).saveSlot(d), form: true);
  Future<RecordWrite?> deleteSlot(int id) =>
      run((db) => Timetable(db).deleteSlot(id), form: true);
  Future<RecordWrite?> saveSub(int slot, String iso, int? teacher) =>
      run((db) => Timetable(db).saveSub(slot, iso, teacher), form: true);
  Future<RecordWrite?> deleteSubsOf(int slot) =>
      run((db) => Timetable(db).deleteSubsOf(slot), form: true);
  Future<RecordWrite?> deleteSub(int id) =>
      run((db) => Timetable(db).deleteSub(id));
  Future<RecordWrite?> saveWorkdays(Iterable<int> days) =>
      run((db) => Timetable(db).saveWorkdays(days), form: true);
  Future<RecordWrite?> saveBells(List<BellDraft> rows) =>
      run((db) => Timetable(db).saveBells(rows), form: true);
  Future<RecordWrite?> applyGenerated(GenResult g) =>
      run((db) => Timetable(db).applyGenerated(g), form: true);

  /// `sched-teacher-add` → form `sched-teacher`.
  Future<RecordWrite?> addTeacher(String name) =>
      run((db) => Timetable(db).addTeacher(name), form: true);

  /// `sched-room-add` → form `sched-room` (also listed under classes/rooms).
  Future<RecordWrite?> addRoom(String name) =>
      run((db) => ClassBook(db).saveRoom(name: name), form: true);

  /// `sched-subject-add` → form `subject`.
  Future<RecordWrite?> addSubject(String name) => run(
    (db) => ClassBook(db).saveSubject(name: name, workshop: false),
    form: true,
  );
}

class ScheduleScreen extends StatefulWidget {
  const ScheduleScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });
  final ScheduleController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<ScheduleScreen> createState() => _ScheduleScreenState();
}

class _ScheduleScreenState extends State<ScheduleScreen> {
  ScheduleController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  Future<void> _open(Widget page) async {
    await openPanel<void>(context, (_) => page);
    c.clearForm();
    await c.load();
  }

  Future<void> _openSlot(TimetableView v, int day, int period) async {
    final s = v.at(day, period);
    await _open(
      SlotFormPage(
        controller: c,
        grade: v.grade,
        branch: v.branch,
        classId: s?.classId ?? v.cohortClassId,
        classBased: v.classBased,
        className: v.classBased
            ? [
                    for (final o in v.classOptions)
                      if (o.$1 == v.classId) o.$2,
                  ].firstOrNull ??
                  ''
            : '',
        slot: s,
        day: day,
        period: period,
        subs: [
          for (final x in v.subs)
            if (s != null && x.slotId == s.id) x,
        ],
      ),
    );
  }

  Future<void> _deleteSub(Sub x) async {
    final ok = await confirmAction(
      context,
      prefix: 'sch',
      title: 'حذف جابه‌جای',
      message:
          'جابه‌جای ${x.slotLabel} (تاریخ ${JalaliDate.fromIso(x.date)?.jdate ?? x.date}) حذف شود؟',
    );
    if (ok) await c.deleteSub(x.id);
  }

  /// `<label class="field grow"><span>…</span><select class="input">`.
  Widget _dropdown<T>(
    String key,
    String label,
    T value,
    List<(T, String)> items,
    ValueChanged<T?> onChanged,
  ) => WebField(
    label: label,
    child: FieldBox(
      width: kFieldText,
      child: DropdownButtonFormField<T>(
        key: Key(key),
        initialValue: items.any((i) => i.$1 == value) ? value : null,
        isExpanded: true,
        isDense: true,
        style: TextStyle(
          fontSize: 15,
          color: Web.ink,
          fontFamily: PayeshTokens.fontFamily,
          package: PayeshTokens.fontPackage,
        ),
        decoration: webInput(),
        items: [
          for (final (v, l) in items)
            DropdownMenuItem<T>(value: v, child: Text(l)),
        ],
        onChanged: onChanged,
      ),
    ),
  );

  Widget? _clashes(TimetableView v) {
    if (c.role != 'manager') {
      if (v.clashes.isEmpty) return null;
      return WebCard(
        key: const Key('sch-my-clashes'),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '⚠️ ${_fa(v.clashes.length)} تداخل ساعتی شما در برنامه',
              style: Web.b.copyWith(color: Web.amber),
            ),
            const SizedBox(height: 4),
            Text(
              v.clashes
                  .map((x) => '${schedDayFa[x.day]} زنگ ${_fa(x.period)}')
                  .join(' · '),
              style: Web.small,
            ),
            const SizedBox(height: 4),
            Text('جابه‌جایی را مدیر انجام می‌دهد.', style: Web.small),
          ],
        ),
      );
    }
    if (v.clashes.isEmpty) {
      return const WebCard(
        child: Align(
          alignment: AlignmentDirectional.centerStart,
          child: WebBadge(
            '✅ بدون تداخل — همهٔ زنگ‌ها آزاد است',
            key: Key('sch-noclash'),
            tone: WebTone.green,
          ),
        ),
      );
    }
    return WebCard(
      key: const Key('sch-clashes'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            '⚠️ ${_fa(v.clashes.length)} تداخل در برنامهٔ هفتگی',
            style: Web.b.copyWith(color: Web.red),
          ),
          const SizedBox(height: 6),
          for (final x in v.clashes)
            Container(
              margin: const EdgeInsets.only(top: 8),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              decoration: BoxDecoration(
                color: Web.card,
                border: Border.all(color: Web.line),
                borderRadius: BorderRadius.circular(8),
              ),
              child: DefaultTextStyle.merge(
                style: const TextStyle(fontSize: 13),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text.rich(
                      TextSpan(
                        children: [
                          TextSpan(
                            text:
                                '${x.kind == 'teacher' ? 'دبیر' : 'پایه و رشته'}: ${x.who}',
                            style: Web.b,
                          ),
                          TextSpan(
                            text:
                                ' — ${schedDayFa[x.day]} زنگ ${_fa(x.period)}: '
                                '${x.rows.map((r) => x.kind == 'teacher' ? r.group : r.subject).join(' و ')}',
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 6),
                    WebWrap(
                      spacing: 8,
                      runSpacing: 6,
                      children: [
                        for (final r in x.rows)
                          WebWrap(
                            spacing: 6,
                            runSpacing: 6,
                            crossAxisAlignment: WrapCrossAlignment.center,
                            children: [
                              Text(
                                '${x.kind == 'teacher' ? 'زنگ «${r.group.isEmpty ? '—' : r.group}»' : 'درس «${r.subject}»'}:',
                                style: TextStyle(color: Web.muted),
                              ),
                              WebBtn(
                                '🔎 پیشنهاد جایِ آزاد',
                                key: Key('sch-sug-${x.kind}-${r.id}'),
                                kind: WebBtnKind.ghost,
                                onPressed: () => c.toggleSuggestions(r.id),
                              ),
                              if (c.openSuggestions.contains(r.id))
                                if ((c.suggestions[r.id] ?? const []).isEmpty)
                                  Text(
                                    'جایِ آزاد پیدا نشد — یک زنگ را دستی خالی کنید.',
                                    style: TextStyle(color: Web.red),
                                  )
                                else
                                  for (final (d, p) in c.suggestions[r.id]!)
                                    WebBtn(
                                      'جابه‌جایی به ${schedDayFa[d]} زنگ ${_fa(p)}',
                                      key: Key(
                                        'sch-move-${x.kind}-${r.id}-$d-$p',
                                      ),
                                      onPressed: c.busy
                                          ? null
                                          : () => c.move(r.id, d, p),
                                    ),
                            ],
                          ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }

  /// web `.timetable`: `grid-template-columns:74px repeat(N,minmax(112px,1fr))`, gap 6,
  /// min-width 640; `.tt-head` muted 12.5px; `.tt-cell` 1px line, radius 10, min-height 52,
  /// dashed + transparent when empty.
  Widget _grid(TimetableView v) {
    final showTeacher = c.role != 'teacher' || c.homeClass != null;
    Widget head(Widget child) => Padding(
      padding: const EdgeInsets.all(4.8),
      child: DefaultTextStyle.merge(
        style: TextStyle(fontSize: 12.5, color: Web.muted),
        textAlign: TextAlign.center,
        child: Center(child: child),
      ),
    );
    Widget cell(int d, Bell b) {
      final p = b.order.toInt();
      final s = v.at(d, p);
      final tap = v.canEdit && !c.busy ? () => _openSlot(v, d, p) : null;
      final content = s == null
          ? Text(v.canEdit ? '+ افزودن' : '—', style: Web.small)
          : Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  s.subject,
                  style: const TextStyle(
                    fontWeight: FontWeight.w700,
                    fontSize: 13,
                  ),
                ),
                Text(showTeacher ? s.teacher : s.group, style: Web.small),
                if (s.room.isNotEmpty)
                  Text(
                    '🏫 ${s.room}',
                    style: TextStyle(fontSize: 12.5, color: Web.muted),
                  ),
                if (s.subToday != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 3),
                    child: WebBadge('🔁 ${s.subToday}', tone: WebTone.amber),
                  ),
                if (s.queued)
                  Icon(
                    Icons.schedule,
                    size: 14,
                    color: Web.muted,
                    semanticLabel: 'در صف ارسال',
                  ),
              ],
            );
      return _TtCell(
        key: Key('sch-cell-$d-$p'),
        empty: s == null,
        onTap: tap,
        child: content,
      );
    }

    final rows = <Widget>[
      WebEqualRow(
        gap: 6,
        firstWidth: 74,
        children: [
          head(const SizedBox.shrink()),
          for (final d in v.days)
            head(Text(schedDayFa[d], style: Web.b.copyWith(fontSize: 12.5))),
        ],
      ),
      for (final b in v.periods)
        WebEqualRow(
          gap: 6,
          firstWidth: 74,
          children: [
            head(
              Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  WebBadge('زنگ ${_fa(b.order.toInt())}', tone: WebTone.purple),
                  if (b.start.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Directionality(
                      textDirection: TextDirection.ltr,
                      child: Text(
                        '${b.start}${b.end.isEmpty ? '' : ' – ${b.end}'}',
                        style: Web.small,
                        textAlign: TextAlign.center,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            for (final d in v.days) cell(d, b),
          ],
        ),
    ];
    final grid = Column(
      key: const Key('sch-grid'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final (i, r) in rows.indexed) ...[
          if (i > 0) const SizedBox(height: 6),
          r,
        ],
      ],
    );
    final minW = math.max(640.0, 74 + v.days.length * (112 + 6.0));
    return LayoutBuilder(
      builder: (context, box) => box.maxWidth >= minW
          ? grid
          : SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: SizedBox(width: minW, child: grid),
            ),
    );
  }

  Widget _subsList(TimetableView v) => Container(
    margin: const EdgeInsets.only(top: 10),
    padding: const EdgeInsets.only(top: 8),
    decoration: BoxDecoration(
      border: Border(top: BorderSide(color: Web.line)),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          '🔁 جابه‌جای‌های موقت این کلاس',
          style: Web.b.copyWith(fontSize: 12.5),
        ),
        const SizedBox(height: 4),
        for (final x in v.subs)
          Padding(
            key: Key('sch-sub-${x.id}'),
            padding: const EdgeInsets.only(bottom: 4),
            child: WebWrap(
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                Text.rich(
                  TextSpan(
                    style: const TextStyle(fontSize: 12.5, height: 2.3),
                    children: [
                      TextSpan(
                        text: '${Web.jdate(x.date)} — ${x.slotLabel} — ',
                      ),
                      TextSpan(text: x.teacher, style: Web.b),
                      const TextSpan(text: ' '),
                    ],
                  ),
                ),
                InkWell(
                  key: Key('sch-sub-del-${x.id}'),
                  onTap: c.busy ? null : () => _deleteSub(x),
                  child: Text(
                    'حذف',
                    style: TextStyle(
                      color: Web.red,
                      fontWeight: FontWeight.w600,
                      fontSize: 12.5,
                    ),
                  ),
                ),
              ],
            ),
          ),
      ],
    ),
  );

  /// Row 172: web `schedPage()` exactly — pageHead (title, «پایه · رشته», «📅 روزهای فعال»
  /// «⏱️ تنظیم زنگ‌ها» «⚙️ تولید خودکار»), the cohort picker card, «نمای من», the clash card,
  /// the timetable card (with the 💡 line and the temporary-swap list).
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      final v = c.view;
      final mgr = c.role == 'manager';
      final clashes = v == null ? null : _clashes(v);
      return SchoolPage(
        prefix: 'sch',
        title: v?.title ?? 'برنامهٔ هفتگی',
        controller: c,
        sync: widget.sync,
        onRetry: widget.onRetry,
        body: const SizedBox.shrink(),
        sub: v?.sub,
        headActions: [
          if (mgr) ...[
            WebBtn(
              '📅 روزهای فعال',
              key: const Key('sch-workdays'),
              kind: WebBtnKind.primary,
              onPressed: () => _open(WorkdaysPage(controller: c)),
            ),
            WebBtn(
              '⏱️ تنظیم زنگ‌ها',
              key: const Key('sch-bells'),
              kind: WebBtnKind.primary,
              onPressed: () => _open(BellsPage(controller: c)),
            ),
          ],
          if (v != null && v.canEdit)
            WebBtn(
              '⚙️ تولید خودکار',
              key: const Key('sch-gen'),
              onPressed: () => _open(GeneratorPage(controller: c)),
            ),
        ],
        children: v == null
            ? const []
            : [
                // row 166: rotating shift — this week's bells (flips every Saturday)
                if (c.weekShiftFa case final w?)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: Align(
                      alignment: AlignmentDirectional.centerStart,
                      child: WebBadge(
                        'شیفت چرخشی — این هفته: $w',
                        key: const Key('sch-week-shift'),
                        tone: WebTone.purple,
                      ),
                    ),
                  ),
                if (mgr && v.classBased)
                  WebCard.tight(
                    key: const Key('sch-class-pick'),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _dropdown<int>('sch-class', 'کلاس', v.classId ?? 0, [
                          for (final o in v.classOptions) o,
                          if (v.classOptions.isEmpty) (0, 'کلاسی تعریف نشده'),
                        ], (id) => c.pickClass(id == 0 ? null : id)),
                        const SizedBox(height: 7),
                        Text(
                          'مدرسهٔ کلاس‌محور: برنامه برای هر کلاسِ ثابت جدا چیده می‌شود'
                          '${v.homeRoom.isEmpty ? '' : ' · اتاق: ${v.homeRoom}'}'
                          '${v.homeroom.isEmpty ? '' : ' · دبیر پایه: ${v.homeroom}'}',
                          key: const Key('sch-class-hint'),
                          style: Web.small,
                        ),
                      ],
                    ),
                  ),
                if (mgr && !v.classBased)
                  WebCard.tight(
                    key: const Key('sch-cohort'),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            Expanded(
                              child: _dropdown<String>(
                                'sch-grade',
                                'پایه',
                                v.grade,
                                [
                                  for (final g in v.grades) (g, g),
                                  if (v.grades.isEmpty) ('', 'پایه تعریف نشده'),
                                ],
                                (g) => c.pickCohort(grade: g),
                              ),
                            ),
                            const SizedBox(width: 10),
                            Expanded(
                              child: _dropdown<String>(
                                'sch-branch',
                                'رشته',
                                v.branch,
                                [
                                  ('', '— بدون رشته —'),
                                  for (final b in v.branches) (b, b),
                                ],
                                (b) => c.pickCohort(branch: b ?? ''),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 7),
                        Text(
                          'مدرسهٔ رشته‌محور: برنامه برای این پایه و رشته چیده می‌شود؛ کلاس/کارگاهِ هر زنگ را شما در همین برنامه تعیین می‌کنید.',
                          style: Web.small,
                        ),
                      ],
                    ),
                  ),
                if (c.role == 'teacher' && v.homeClasses.isNotEmpty)
                  WebCard.tight(
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            'نمای من',
                            style: Web.b.copyWith(fontSize: 12.5),
                          ),
                        ),
                        ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 260),
                          child: FieldBox(
                            width: kFieldText,
                            child: DropdownButtonFormField<int>(
                              key: const Key('sch-home'),
                              initialValue: c.homeClass ?? 0,
                              isExpanded: true,
                              isDense: true,
                              decoration: webInput(),
                              items: [
                                const DropdownMenuItem(
                                  value: 0,
                                  child: Text('تدریس من'),
                                ),
                                for (final (id, n) in v.homeClasses)
                                  DropdownMenuItem(
                                    value: id,
                                    child: Text('سرپرستی: $n'),
                                  ),
                              ],
                              onChanged: (id) =>
                                  c.pickHome(id == null || id == 0 ? null : id),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                if (c.role == 'parent' && v.children.length > 1)
                  WebPills(
                    keyPrefix: 'sch-child',
                    tabs: [for (final (id, n) in v.children) ('$id', n)],
                    selected: '${c.child ?? v.children.first.$1}',
                    onSelected: (id) => c.pickChild(int.parse(id)),
                  ),
                if (mgr && v.classBased && v.classOptions.isEmpty)
                  WebCard(
                    key: const Key('sch-no-class'),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'برای چیدن برنامه، ابتدا کلاس‌های ثابت (مثل «سوم الف») را در بخش «کلاس‌ها» تعریف کنید.',
                          style: Web.small,
                        ),
                        const SizedBox(height: 8),
                        WebBtn(
                          'تعریف کلاس',
                          key: const Key('sch-go-classes-c'),
                          kind: WebBtnKind.primary,
                          size: WebBtnSize.normal,
                          onPressed: () => PulseInline.go(context, 'classes'),
                        ),
                      ],
                    ),
                  ),
                if (mgr && !v.classBased && v.grades.isEmpty)
                  WebCard(
                    key: const Key('sch-no-grade'),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'برای چیدن برنامه، ابتدا پایه و رشته را در بخش «کلاس‌ها» تعریف کنید.',
                          style: Web.small,
                        ),
                        const SizedBox(height: 8),
                        WebBtn(
                          'تعریف پایه و رشته',
                          key: const Key('sch-go-classes'),
                          kind: WebBtnKind.primary,
                          size: WebBtnSize.normal,
                          onPressed: () => PulseInline.go(context, 'classes'),
                        ),
                      ],
                    ),
                  )
                else ...[
                  ?clashes,
                  WebCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _grid(v),
                        if (v.canEdit)
                          Padding(
                            padding: EdgeInsets.only(top: 10),
                            child: Text(
                              '💡 روی خانه بزنید تا درس، دبیر و محل برگزاری را مشخص کنید. روزهای غیرفعال از جدول حذف شده‌اند.',
                              style: TextStyle(
                                fontSize: 12.5,
                                color: Web.muted,
                                height: 2,
                              ),
                            ),
                          ),
                        if (v.canEdit && v.subs.isNotEmpty) _subsList(v),
                      ],
                    ),
                  ),
                  if (v.slots.isEmpty && !v.canEdit)
                    WebCard(
                      child: Text(
                        'برنامهٔ هفتگی برای این پایه یا کاربر هنوز ثبت نشده است.',
                        style: Web.small,
                      ),
                    ),
                ],
              ],
      );
    },
  );
}

/// One `.tt-cell` (hover: soft background + primary border).
class _TtCell extends StatefulWidget {
  const _TtCell({
    super.key,
    required this.empty,
    required this.onTap,
    required this.child,
  });
  final bool empty;
  final VoidCallback? onTap;
  final Widget child;

  @override
  State<_TtCell> createState() => _TtCellState();
}

class _TtCellState extends State<_TtCell> {
  bool hover = false;

  @override
  Widget build(BuildContext context) {
    final on = hover && widget.onTap != null;
    final box = CustomPaint(
      foregroundPainter: widget.empty && !on ? _DashedBox(Web.line, 10) : null,
      child: Container(
        constraints: const BoxConstraints(minHeight: 52),
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7.2),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: on ? Web.soft : (widget.empty ? null : Web.card),
          border: widget.empty && !on
              ? null
              : Border.all(color: on ? Web.primary : Web.line),
          borderRadius: BorderRadius.circular(10),
        ),
        child: DefaultTextStyle.merge(
          style: const TextStyle(fontSize: 13),
          textAlign: TextAlign.center,
          child: widget.child,
        ),
      ),
    );
    if (widget.onTap == null) return box;
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => hover = true),
      onExit: (_) => setState(() => hover = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.onTap,
        child: box,
      ),
    );
  }
}

/// CSS `border:1px dashed` around a rounded box.
class _DashedBox extends CustomPainter {
  const _DashedBox(this.color, this.radius);
  final Color color;
  final double radius;

  @override
  void paint(Canvas canvas, Size size) {
    final path = Path()
      ..addRRect(
        RRect.fromRectAndRadius(
          (Offset.zero & size).deflate(0.5),
          Radius.circular(radius),
        ),
      );
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;
    for (final m in path.computeMetrics()) {
      var d = 0.0;
      while (d < m.length) {
        canvas.drawPath(m.extractPath(d, math.min(d + 3, m.length)), paint);
        d += 6;
      }
    }
  }

  @override
  bool shouldRepaint(_DashedBox old) => old.color != color;
}

/// Asks for one name (forms `sched-teacher`, `sched-room`, and the short `subject` form).
Future<String?> _askName(
  BuildContext context, {
  required String key,
  required String title,
  required String label,
  required String hint,
}) => showDialog<String>(
  context: context,
  builder: (_) => _NameDialog(k: key, title: title, label: label, hint: hint),
);

class _NameDialog extends StatefulWidget {
  const _NameDialog({
    required this.k,
    required this.title,
    required this.label,
    required this.hint,
  });
  final String k;
  final String title;
  final String label;
  final String hint;

  @override
  State<_NameDialog> createState() => _NameDialogState();
}

class _NameDialogState extends State<_NameDialog> {
  // owned by the dialog: it outlives the pop until the exit animation ends
  final t = TextEditingController();

  @override
  void dispose() {
    t.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text(widget.title),
    content: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(widget.hint),
        const SizedBox(height: PayeshTokens.space2),
        FieldBox(
          child: TextField(
            key: Key('${widget.k}-name'),
            controller: t,
            autofocus: true,
            decoration: InputDecoration(
              labelText: widget.label,
              border: const OutlineInputBorder(),
            ),
          ),
        ),
      ],
    ),
    actions: [
      TextButton(
        key: Key('${widget.k}-cancel'),
        onPressed: () => Navigator.pop(context),
        child: const Text('انصراف'),
      ),
      FilledButton(
        key: Key('${widget.k}-ok'),
        onPressed: () => Navigator.pop(context, t.text),
        child: const Text('ثبت'),
      ),
    ],
  );
}

/// Form `slot` (`sched-slot`): day, bell, subject, teacher (busy marked), room; delete; and the
/// substitution block of an existing slot (`sub-save` / `sub-del`).
class SlotFormPage extends StatefulWidget {
  const SlotFormPage({
    super.key,
    required this.controller,
    required this.grade,
    required this.branch,
    required this.day,
    required this.period,
    this.classId,
    this.classBased = false,
    this.className = '',
    this.slot,
    this.subs = const [],
  });
  final ScheduleController controller;

  /// ردیف ۱۹۵: زنگِ کلاسِ ثابت (کلاس‌محور) — محل اختیاری است (پیش‌فرض اتاق خود کلاس).
  final bool classBased;
  final String className;
  final String grade;
  final String branch;
  final int? classId;
  final Slot? slot;
  final int day;
  final int period;
  final List<Sub> subs;

  @override
  State<SlotFormPage> createState() => _SlotFormPageState();
}

class _SlotFormPageState extends State<SlotFormPage> {
  static const int addNew = -1;
  ScheduleController get c => widget.controller;
  late int day = widget.slot?.day ?? widget.day;
  late int period = widget.slot?.period ?? widget.period;
  late int? subject = widget.slot?.subjectId;
  late int? teacher = widget.slot?.teacherId;
  late int? room = widget.slot?.roomId;
  late final subDate = TextEditingController(
    text: widget.subs.isEmpty
        ? ''
        : (JalaliDate.fromIso(widget.subs.first.date)?.slash ?? ''),
  );
  late int? subTeacher = widget.subs.isEmpty
      ? null
      : widget.subs.first.teacherId;
  List<int> days = const [];
  List<Bell> bells = const [];
  List<(int, String)> subjects = const [];
  List<(int, String)> rooms = const [];
  List<TeacherOption> teachers = const [];
  int _gen = 0;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  @override
  void dispose() {
    subDate.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    final g = ++_gen;
    final d = await c.workDays();
    final b = await c.lessons();
    final s = await c.subjects();
    final r = await c.rooms();
    final t = await c.teachers(day, period, widget.slot?.id);
    if (!mounted || g != _gen) return;
    setState(() {
      days = d.isEmpty ? const [0, 1, 2, 3, 4, 5] : d;
      bells = b;
      subjects = s;
      rooms = r;
      teachers = t;
    });
  }

  Future<void> _addSubject() async {
    final n = await _askName(
      context,
      key: 'slot-add-subject',
      title: 'درس جدید',
      label: 'نام درس',
      hint: 'درس به فهرست دروس هم اضافه می‌شود.',
    );
    if (n == null) return;
    final w = await c.addSubject(n);
    if (w != null) subject = w.id;
    await _refresh();
  }

  Future<void> _addTeacher() async {
    final n = await _askName(
      context,
      key: 'slot-add-teacher',
      title: 'دبیر جدید',
      label: 'نام و نام خانوادگی',
      hint: 'حساب دبیر با نقش «دبیر» ساخته می‌شود؛ شمارهٔ همراه، کد ملی و اطلاعات دیگر را بعداً در بخش کاربران تکمیل کنید.',
    );
    if (n == null) return;
    final w = await c.addTeacher(n);
    if (w != null) teacher = w.id;
    await _refresh();
  }

  Future<void> _addRoom() async {
    final n = await _askName(
      context,
      key: 'slot-add-room',
      title: 'محل برگزاری جدید',
      label: 'نام محل',
      hint: 'این محل در فهرست کلاس‌ها/محل‌ها نیز ذخیره می‌شود.',
    );
    if (n == null) return;
    final w = await c.addRoom(n);
    if (w != null) room = w.id;
    await _refresh();
  }

  Future<void> _delete() async {
    final s = widget.slot!;
    final ok = await confirmAction(
      context,
      prefix: 'slot',
      title: 'حذف زنگ',
      message:
          'درس «${s.subject}» در ${schedDayFa[s.day]} زنگ ${_fa(s.period)} حذف شود؟',
    );
    if (!ok) return;
    final w = await c.deleteSlot(s.id);
    if (w != null && mounted) Navigator.pop(context);
  }

  Future<void> _saveSub() async {
    final j = JalaliDate.parse(subDate.text);
    if (j == null) {
      c.formError = 'تاریخ شمسی معتبر را وارد کنید';
      c.emit();
      return;
    }
    final w = await c.saveSub(widget.slot!.id, j.toIso(), subTeacher);
    if (w != null && mounted) Navigator.pop(context);
  }

  Future<void> _deleteSubs() async {
    final w = await c.deleteSubsOf(widget.slot!.id);
    if (w != null && mounted) Navigator.pop(context);
  }

  Widget _pick(
    String key,
    String label,
    int? value,
    List<(int?, String)> items,
    ValueChanged<int?> onChanged,
  ) => FieldBox(
    width: kFieldText,
    child: DropdownButtonFormField<int?>(
      key: Key(key),
      initialValue: items.any((i) => i.$1 == value) ? value : null,
      isExpanded: true,
      decoration: InputDecoration(
        labelText: label,
        border: const OutlineInputBorder(),
      ),
      items: [
        for (final (v, l) in items)
          DropdownMenuItem<int?>(
            value: v,
            child: Text(l, overflow: TextOverflow.ellipsis),
          ),
      ],
      onChanged: onChanged,
    ),
  );

  @override
  Widget build(BuildContext context) {
    final editing = widget.slot != null;
    final cohort = widget.classBased
        ? widget.className
        : '${widget.grade}${widget.branch.isEmpty ? '' : ' · ${widget.branch}'}';
    return SchoolForm(
      prefix: 'slot',
      title: editing
          ? 'ویرایش زنگ'
          : 'افزودن درس — ${schedDayFa[widget.day]} زنگ ${_fa(widget.period)}',
      controller: c,
      submitLabel: 'ذخیرهٔ زنگ',
      onSubmit: () async {
        final w = await c.saveSlot(
          SlotDraft(
            id: widget.slot?.id,
            grade: widget.grade,
            branch: widget.branch,
            classId: widget.classId,
            day: day,
            period: period,
            subjectId: subject,
            teacherId: teacher,
            roomId: room,
            legacyRoom: widget.slot?.roomId == null
                ? (widget.slot?.room ?? '')
                : '',
          ),
        );
        if (w != null && context.mounted) Navigator.pop(context);
      },
      fields: [
        Text(
          widget.classBased ? 'کلاس: $cohort' : 'پایه و رشته: $cohort',
          key: const Key('slot-cohort'),
        ),
        _pick(
          'slot-f-day',
          'روز فعال مدرسه',
          day,
          [for (final d in days) (d, schedDayFa[d])],
          (v) {
            day = v ?? day;
            _refresh();
          },
        ),
        _pick(
          'slot-f-period',
          'زنگ',
          period,
          [
            for (final b in bells)
              (
                b.order.toInt(),
                b.label.isEmpty ? 'زنگ ${_fa(b.order.toInt())}' : b.label,
              ),
          ],
          (v) {
            period = v ?? period;
            _refresh();
          },
        ),
        _pick(
          'slot-f-subject',
          'درس',
          subject,
          [
            (null, '— انتخاب درس —'),
            ...subjects,
            (addNew, '＋ تعریف درس تازه…'),
          ],
          (v) {
            if (v == addNew) {
              _addSubject();
            } else {
              setState(() => subject = v);
            }
          },
        ),
        _pick(
          'slot-f-teacher',
          'دبیر',
          teacher,
          [
            (null, '— بدون دبیر —'),
            for (final t in teachers)
              (
                t.id,
                '${t.busy ? '🔴' : '🟢'} ${t.name}${t.busy ? ' — در این ساعت مشغول' : ''}',
              ),
            (addNew, '＋ ثبت دبیر تازه…'),
          ],
          (v) {
            if (v == addNew) {
              _addTeacher();
            } else {
              setState(() => teacher = v);
            }
          },
        ),
        _pick(
          'slot-f-room',
          widget.classBased
              ? 'محل (اختیاری — فقط فضای ویژه؛ پیش‌فرض اتاق خود کلاس)'
              : 'محل برگزاری (کلاس/کارگاه) *',
          room,
          [
            (
              null,
              widget.slot != null &&
                      widget.slot!.roomId == null &&
                      widget.slot!.room.isNotEmpty
                  ? 'مکان قبلی: ${widget.slot!.room}'
                  : (widget.classBased
                        ? '— اتاق خود کلاس —'
                        : '— انتخاب محل —'),
            ),
            ...rooms,
            (addNew, '＋ افزودن محل تازه…'),
          ],
          (v) {
            if (v == addNew) {
              _addRoom();
            } else {
              setState(() => room = v);
            }
          },
        ),
        const Text(
          '🟢 دبیر آزاد · 🔴 دبیر مشغول در همان ساعت — ثبت زنگِ دارای تداخل ممکن نیست.',
        ),
        if (editing) ...[
          OutlinedButton.icon(
            key: const Key('slot-delete'),
            style: OutlinedButton.styleFrom(
              foregroundColor: Theme.of(context).colorScheme.error,
            ),
            onPressed: c.busy ? null : _delete,
            icon: const Icon(Icons.delete_outline),
            label: const Text('حذف این زنگ'),
          ),
          const Divider(),
          Text(
            '🔁 جابه‌جای موقت',
            style: Theme.of(context).textTheme.titleSmall,
          ),
          const Text(
            'اگر دبیر در روز خاصی غایب است، برای همان تاریخ دبیر جایگزین تعیین کنید.',
          ),
          if (widget.subs.isNotEmpty)
            Text(
              'جابه‌جای فعلی: ${widget.subs.first.teacher} در ${JalaliDate.fromIso(widget.subs.first.date)?.jdate ?? widget.subs.first.date}',
              key: const Key('slot-sub-current'),
            ),
          SchoolField(
            'slot-sub-date',
            'تاریخ شمسی (مثلاً ۱۴۰۵/۰۸/۲۵)',
            subDate,
            numeric: true,
          ),
          _pick('slot-sub-teacher', 'دبیر جایگزین', subTeacher, [
            (null, '— انتخاب دبیر —'),
            for (final t in teachers) (t.id, t.name),
          ], (v) => setState(() => subTeacher = v)),
          WebWrap(
            spacing: PayeshTokens.space2,
            children: [
              FilledButton.tonal(
                key: const Key('slot-sub-save'),
                onPressed: c.busy ? null : _saveSub,
                child: const Text('ثبت جابه‌جای'),
              ),
              if (widget.subs.isNotEmpty)
                TextButton(
                  key: const Key('slot-sub-del'),
                  onPressed: c.busy ? null : _deleteSubs,
                  child: const Text('حذف جابه‌جای'),
                ),
            ],
          ),
        ],
      ],
    );
  }
}

/// Form `workdays` (`workdays-edit`).
class WorkdaysPage extends StatefulWidget {
  const WorkdaysPage({super.key, required this.controller});
  final ScheduleController controller;

  @override
  State<WorkdaysPage> createState() => _WorkdaysPageState();
}

class _WorkdaysPageState extends State<WorkdaysPage> {
  Set<int>? on;

  @override
  void initState() {
    super.initState();
    widget.controller.workDays().then((d) {
      if (mounted) setState(() => on = d.toSet());
    });
  }

  @override
  Widget build(BuildContext context) => SchoolForm(
    prefix: 'wd',
    title: 'روزهای فعال مدرسه',
    controller: widget.controller,
    submitLabel: 'ذخیرهٔ روزهای فعال',
    onSubmit: () async {
      final w = await widget.controller.saveWorkdays(on ?? const {});
      if (w != null && context.mounted) Navigator.pop(context);
    },
    fields: [
      const Text(
        'روزهایی را که مدرسه در آن‌ها برنامه دارد علامت بزنید. فقط همین روزها در جدول و پیشنهادهای چیدمان نمایش داده می‌شوند.',
      ),
      if (on != null)
        for (var i = 0; i < schedDayFa.length; i++)
          CheckboxListTile(
            key: Key('wd-day-$i'),
            title: Text(schedDayFa[i]),
            value: on!.contains(i),
            onChanged: (v) => setState(() {
              if (v ?? false) {
                on!.add(i);
              } else {
                on!.remove(i);
              }
            }),
          ),
    ],
  );
}

/// Form `bells` (`bell-edit`, rows added with `bell-add`, removed with `bell-del`).
class BellsPage extends StatefulWidget {
  const BellsPage({super.key, required this.controller});
  final ScheduleController controller;

  @override
  State<BellsPage> createState() => _BellsPageState();
}

class _BellRow {
  _BellRow(BellDraft b)
    : id = b.id,
      start = TextEditingController(text: b.start),
      end = TextEditingController(text: b.end),
      type = b.type;
  final int id;
  final TextEditingController start;
  final TextEditingController end;
  String type;
  BellDraft get draft =>
      BellDraft(id: id, start: start.text, end: end.text, type: type);
  void dispose() {
    start.dispose();
    end.dispose();
  }
}

class _BellsPageState extends State<BellsPage> {
  /// The rows on screen: the one set, or the morning / afternoon set of a rotating school.
  List<_BellRow>? rows;

  /// Row 166: rotating school ⇒ both sets kept while switching between them.
  bool rotating = false;
  String shown = shiftMorningFa;
  final Map<String, List<_BellRow>> sets = {};
  String first = shiftMorningFa;
  String? start;
  String? thisWeek;

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    final c = widget.controller;
    final rot = await c.rotating();
    if (!rot) {
      final d = await c.bellDraft();
      if (mounted) setState(() => rows = [for (final b in d) _BellRow(b)]);
      return;
    }
    final r = await c.rotation();
    final m = await c.bellDraft(shift: shiftMorningFa);
    final a = await c.bellDraft(shift: shiftAfternoonFa);
    final w = await c.weekShift();
    if (!mounted) return;
    setState(() {
      rotating = true;
      first = r.first;
      start = r.start;
      thisWeek = w;
      sets[shiftMorningFa] = [for (final b in m) _BellRow(b)];
      sets[shiftAfternoonFa] = [for (final b in a) _BellRow(b)];
      shown = w ?? shiftMorningFa;
      rows = sets[shown];
    });
  }

  @override
  void dispose() {
    final all = rotating
        ? [for (final l in sets.values) ...l]
        : (rows ?? const <_BellRow>[]);
    for (final r in all) {
      r.dispose();
    }
    super.dispose();
  }

  void _add() => setState(() {
    final last = rows!.isEmpty ? null : rows!.last;
    rows!.add(_BellRow(BellDraft(start: last?.end.text ?? '')));
  });

  void _del(int i) {
    if (rows!.length <= 1) {
      widget.controller.formError = 'دست‌کم یک زنگ لازم است';
      widget.controller.emit();
      return;
    }
    setState(() => rows!.removeAt(i).dispose());
  }

  void _show(String shift) => setState(() {
    shown = shift;
    rows = sets[shift];
  });

  DateTime _now() => widget.controller.db?.now() ?? DateTime.now();

  String _flip(String s) =>
      s == shiftMorningFa ? shiftAfternoonFa : shiftMorningFa;

  List<Widget> _rotationHeader() => [
    Text(
      'شیفت مدرسه «چرخشی» است: کل مدرسه یک هفته صبح و هفتهٔ بعد بعدازظهر. زنگ‌های صبح و بعدازظهر را جدا وارد کنید و شیفت هفتهٔ اول را انتخاب کنید؛ از آن به بعد هر هفته (از شنبه) خودکار جابه‌جا می‌شود.',
      key: const Key('bell-rotation-help'),
    ),
    const SizedBox(height: PayeshTokens.space3),
    FieldBox(
      width: kFieldText,
      child: DropdownButtonFormField<String>(
        isExpanded: true,
        key: const Key('bell-first'),
        initialValue: first,
        decoration: const InputDecoration(
          labelText: 'شیفت هفتهٔ اول',
          border: OutlineInputBorder(),
        ),
        items: [
          for (final s in rotationShiftsFa)
            DropdownMenuItem(value: s, child: Text(s)),
        ],
        onChanged: (v) => setState(() => first = v ?? shiftMorningFa),
      ),
    ),
    const SizedBox(height: PayeshTokens.space2),
    Text(() {
      final st = start == null ? null : DateTime.tryParse(start!);
      final from = st == null ? '' : 'هفتهٔ اول از شنبه ${jalaliText(start)}؛ ';
      final cur = st == null
          ? first
          : Rotation(first: first, start: start!).shiftOn(_now());
      return '$fromاین هفته: $cur · هفتهٔ بعد: ${_flip(cur)}';
    }(), key: const Key('bell-week')),
    Align(
      alignment: AlignmentDirectional.centerStart,
      child: TextButton(
        key: const Key('bell-start-now'),
        onPressed: () =>
            setState(() => start = Rotation.iso(Rotation.saturdayOf(_now()))),
        child: const Text('هفتهٔ اول = همین هفته'),
      ),
    ),
    const SizedBox(height: PayeshTokens.space2),
    SegmentedButton<String>(
      key: const Key('bell-shift'),
      segments: [
        for (final s in rotationShiftsFa)
          ButtonSegment(
            value: s,
            label: Text('زنگ‌های $s', key: Key('bell-shift-$s')),
          ),
      ],
      selected: {shown},
      onSelectionChanged: (v) => _show(v.first),
    ),
    const SizedBox(height: PayeshTokens.space2),
  ];

  @override
  Widget build(BuildContext context) {
    var lesson = 0, brk = 0;
    return SchoolForm(
      prefix: 'bell',
      title: rotating ? 'تنظیم زنگ‌ها (شیفت چرخشی)' : 'تنظیم زنگ‌ها',
      controller: widget.controller,
      submitLabel: 'ذخیرهٔ ساعت‌ها',
      onSubmit: () async {
        final c = widget.controller;
        final w = rotating
            ? await c.saveRotatingBells(
                morning: [for (final r in sets[shiftMorningFa]!) r.draft],
                afternoon: [for (final r in sets[shiftAfternoonFa]!) r.draft],
                first: first,
                start: start,
              )
            : await c.saveBells([
                for (final r in rows ?? const <_BellRow>[]) r.draft,
              ]);
        if (w != null && context.mounted) Navigator.pop(context);
      },
      fields: [
        if (rotating) ..._rotationHeader(),
        const Text(
          'برای هر ردیف زمان شروع و پایان را وارد کنید. «درس» به‌صورت زنگ در جدول می‌آید؛ «تفریح» فاصلهٔ بین زنگ‌هاست.',
        ),
        if (rows != null)
          for (var i = 0; i < rows!.length; i++)
            Card(
              key: Key('bell-row-$i'),
              child: Padding(
                padding: const EdgeInsets.all(PayeshTokens.space2),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            rows![i].type == 'break'
                                ? 'تفریح ${_fa(++brk)}'
                                : 'زنگ ${_fa(++lesson)} (درس)',
                          ),
                        ),
                        TextButton(
                          key: Key('bell-del-$i'),
                          onPressed: () => _del(i),
                          child: const Text('حذف'),
                        ),
                      ],
                    ),
                    Row(
                      children: [
                        Expanded(
                          child: SchoolField(
                            'bell-s-$i',
                            'شروع',
                            rows![i].start,
                            numeric: true,
                          ),
                        ),
                        const SizedBox(width: PayeshTokens.space2),
                        Expanded(
                          child: SchoolField(
                            'bell-e-$i',
                            'پایان',
                            rows![i].end,
                            numeric: true,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: PayeshTokens.space2),
                    FieldBox(
                      width: kFieldText,
                      child: DropdownButtonFormField<String>(
                        isExpanded: true,
                        key: rotating
                            ? Key('bell-t-$shown-$i')
                            : Key('bell-t-$i'),
                        initialValue: rows![i].type,
                        decoration: const InputDecoration(
                          labelText: 'این ردیف',
                          border: OutlineInputBorder(),
                        ),
                        items: const [
                          DropdownMenuItem(
                            value: 'lesson',
                            child: Text('زنگ درس'),
                          ),
                          DropdownMenuItem(
                            value: 'break',
                            child: Text('زنگ تفریح'),
                          ),
                        ],
                        onChanged: (v) =>
                            setState(() => rows![i].type = v ?? 'lesson'),
                      ),
                    ),
                  ],
                ),
              ),
            ),
        OutlinedButton.icon(
          key: const Key('bell-add'),
          onPressed: rows == null ? null : _add,
          icon: const Icon(Icons.add),
          label: const Text('افزودن زنگ'),
        ),
      ],
    );
  }
}

/// `schedgen-open` → preview; `schedgen-apply` fills only empty cells.
class GeneratorPage extends StatefulWidget {
  const GeneratorPage({super.key, required this.controller});
  final ScheduleController controller;

  @override
  State<GeneratorPage> createState() => _GeneratorPageState();
}

class _GeneratorPageState extends State<GeneratorPage> {
  GenResult? res;
  Map<int, String> classNames = const {};
  Map<int, String> subjectNames = const {};

  @override
  void initState() {
    super.initState();
    _run();
  }

  Future<void> _run() async {
    final c = widget.controller;
    final r = await c.generate();
    final db = c.db;
    if (db == null) return;
    final cn = {
      for (final x in await db.allOrEmpty('classes'))
        x.id: SchoolRecords.str(x.data['name']),
    };
    final sn = {for (final (id, n) in await c.subjects()) id: n};
    if (mounted) {
      setState(() {
        res = r;
        classNames = cn;
        subjectNames = sn;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final r = res;
    final byClass = <int, (int, List<GenUnplaced>)>{};
    for (final p in r?.placements ?? const <GenPlacement>[]) {
      final e = byClass[p.classId] ?? (0, <GenUnplaced>[]);
      byClass[p.classId] = (e.$1 + 1, e.$2);
    }
    for (final u in r?.unplaced ?? const <GenUnplaced>[]) {
      final e = byClass[u.classId] ?? (0, <GenUnplaced>[]);
      byClass[u.classId] = (e.$1, [...e.$2, u]);
    }
    final ids = byClass.keys.toList()..sort();
    return SchoolForm(
      prefix: 'gen',
      title: 'پیش‌نمایش تولید خودکار',
      controller: widget.controller,
      submitLabel: 'همین برنامه ثبت شود',
      onSubmit: () async {
        if (r == null) return;
        final w = await widget.controller.applyGenerated(r);
        if (w != null && context.mounted) Navigator.pop(context);
      },
      fields: [
        if (r == null)
          const Center(child: CircularProgressIndicator())
        else ...[
          Text(
            'تقاضا: ${_fa(r.demands)} زنگ · قابلِ ثبت: ${_fa(r.placements.length)} · تعیین‌نشده: ${_fa(r.unplaced.length)}'
            '${r.noSpecialist > 0 ? ' · بدونِ دبیرِ متخصص: ${_fa(r.noSpecialist)} (با «بدون دبیر» ثبت می‌شود)' : ''}'
            '\nثبت فقط در خانه‌های خالی انجام می‌شود؛ برنامهٔ فعلی دست‌نخورده می‌ماند.',
            key: const Key('gen-stats'),
          ),
          if (ids.isEmpty)
            const Text(
              'تقاضایی نیست (درسِ هم‌خوان با کلاس‌ها پیدا نشد — برای هر درس «ساعت در هفته» را تعیین کنید).',
            ),
          for (final id in ids)
            Card(
              key: Key('gen-class-$id'),
              child: ListTile(
                title: Text(classNames[id] ?? 'کلاس $id'),
                subtitle: Text(
                  [
                    '${_fa(byClass[id]!.$1)} زنگ',
                    for (final u in byClass[id]!.$2)
                      '⚠️ ${subjectNames[u.subjectId] ?? '—'} — ${u.reason}',
                  ].join('\n'),
                ),
              ),
            ),
        ],
      ],
    );
  }
}
