// Row 128, wave W9 — `#/schedule` (web client/schedule.js `schedPage`): the weekly grid per
// grade + branch for the manager (slot form, clashes + suggested moves, substitutions, bells,
// work days, generator), the teacher's own teaching / home class, and the read-only view of a
// student or a parent's child. Every write is local-first through Timetable (queue first).
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

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
  String? grade;
  String? branch;
  int? homeClass;
  int? child;

  /// Clash rows whose suggestions are open (web `sched-conf-sug` toggles a box).
  final Set<int> openSuggestions = {};
  final Map<int, List<(int, int)>> suggestions = {};

  Timetable get _t => Timetable(db!);

  @override
  Future<void> read(SchoolRecords db) async {
    view = await Timetable(db)
        .view(grade: grade, branch: branch, homeClass: homeClass, child: child);
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
  Future<List<BellDraft>> bellDraft() => _t.bellDraft();
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
    await Navigator.of(context)
        .push(MaterialPageRoute<void>(builder: (_) => page));
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

  Widget _dropdown<T>(
    String key,
    String label,
    T value,
    List<(T, String)> items,
    ValueChanged<T?> onChanged,
  ) => DropdownButtonFormField<T>(
    key: Key(key),
    initialValue: items.any((i) => i.$1 == value) ? value : null,
    decoration: InputDecoration(
      labelText: label,
      border: const OutlineInputBorder(),
    ),
    items: [
      for (final (v, l) in items) DropdownMenuItem<T>(value: v, child: Text(l)),
    ],
    onChanged: onChanged,
  );

  Widget _clashes(TimetableView v) {
    if (c.role != 'manager') {
      if (v.clashes.isEmpty) return const SizedBox.shrink();
      return Card(
        child: ListTile(
          key: const Key('sch-my-clashes'),
          title: Text('⚠️ ${_fa(v.clashes.length)} تداخل ساعتی شما در برنامه'),
          subtitle: Text(
            '${v.clashes.map((x) => '${schedDayFa[x.day]} زنگ ${_fa(x.period)}').join(' · ')}\nجابه‌جایی را مدیر انجام می‌دهد.',
          ),
        ),
      );
    }
    if (v.clashes.isEmpty) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: PayeshTokens.space2),
        child: StatusBadge(
          'بدون تداخل — همهٔ زنگ‌ها آزاد است',
          key: Key('sch-noclash'),
          tone: PayeshTone.success,
          icon: Icons.check_circle_outline,
        ),
      );
    }
    final err = Theme.of(context).colorScheme.error;
    return Card(
      key: const Key('sch-clashes'),
      child: Padding(
        padding: const EdgeInsets.all(PayeshTokens.space3),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '⚠️ ${_fa(v.clashes.length)} تداخل در برنامهٔ هفتگی',
              style: TextStyle(color: err, fontWeight: FontWeight.bold),
            ),
            for (final x in v.clashes) ...[
              const Divider(),
              Text(
                '${x.kind == 'teacher' ? 'دبیر' : 'پایه و رشته'}: ${x.who} — ${schedDayFa[x.day]} زنگ ${_fa(x.period)}',
              ),
              for (final r in x.rows)
                Wrap(
                  spacing: PayeshTokens.space2,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Text(
                      x.kind == 'teacher'
                          ? 'زنگ «${r.cohort.isEmpty ? '—' : r.cohort}»'
                          : 'درس «${r.subject}»',
                    ),
                    TextButton.icon(
                      key: Key('sch-sug-${x.kind}-${r.id}'),
                      onPressed: () => c.toggleSuggestions(r.id),
                      icon: const Icon(Icons.search),
                      label: const Text('پیشنهاد جایِ آزاد'),
                    ),
                    if (c.openSuggestions.contains(r.id))
                      if ((c.suggestions[r.id] ?? const []).isEmpty)
                        Text(
                          'جایِ آزاد پیدا نشد — یک زنگ را دستی خالی کنید.',
                          style: TextStyle(color: err),
                        )
                      else
                        for (final (d, p) in c.suggestions[r.id]!)
                          OutlinedButton(
                            key: Key('sch-move-${x.kind}-${r.id}-$d-$p'),
                            onPressed: c.busy ? null : () => c.move(r.id, d, p),
                            child: Text(
                              'جابه‌جایی به ${schedDayFa[d]} زنگ ${_fa(p)}',
                            ),
                          ),
                  ],
                ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _grid(TimetableView v) {
    final showTeacher = c.role != 'teacher' || c.homeClass != null;
    Widget cell(int d, Bell b) {
      final p = b.order.toInt();
      final s = v.at(d, p);
      final content = s == null
          ? Text(
              v.canEdit ? '+ افزودن' : '—',
              style: Theme.of(context).textTheme.bodySmall,
            )
          : Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  s.subject,
                  style: const TextStyle(fontWeight: FontWeight.bold),
                ),
                Text(
                  showTeacher ? s.teacher : s.cohort,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                if (s.room.isNotEmpty)
                  Text(
                    '🏫 ${s.room}',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                if (s.subToday != null)
                  StatusBadge('🔁 ${s.subToday}', tone: PayeshTone.warning),
                if (s.queued)
                  const Icon(
                    Icons.schedule,
                    size: 14,
                    semanticLabel: 'در صف ارسال',
                  ),
              ],
            );
      return InkWell(
        key: Key('sch-cell-$d-$p'),
        onTap: v.canEdit && !c.busy ? () => _openSlot(v, d, p) : null,
        child: Container(
          width: 120,
          constraints: const BoxConstraints(minHeight: 72),
          padding: const EdgeInsets.all(PayeshTokens.space1),
          alignment: Alignment.center,
          child: content,
        ),
      );
    }

    return Card(
      child: SingleChildScrollView(
        key: const Key('sch-grid'),
        scrollDirection: Axis.horizontal,
        child: Table(
          defaultColumnWidth: const IntrinsicColumnWidth(),
          border: TableBorder.all(color: Theme.of(context).dividerColor),
          children: [
            TableRow(
              children: [
                const SizedBox(width: 72),
                for (final d in v.days)
                  Padding(
                    padding: const EdgeInsets.all(PayeshTokens.space2),
                    child: Text(
                      schedDayFa[d],
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontWeight: FontWeight.bold),
                    ),
                  ),
              ],
            ),
            for (final b in v.periods)
              TableRow(
                children: [
                  Padding(
                    padding: const EdgeInsets.all(PayeshTokens.space1),
                    child: Column(
                      children: [
                        Text('زنگ ${_fa(b.order.toInt())}'),
                        if (b.start.isNotEmpty)
                          Text(
                            '${b.start}${b.end.isEmpty ? '' : ' – ${b.end}'}',
                            textDirection: TextDirection.ltr,
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                      ],
                    ),
                  ),
                  for (final d in v.days) cell(d, b),
                ],
              ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      final v = c.view;
      final mgr = c.role == 'manager';
      return SchoolPage(
        prefix: 'sch',
        title: v?.title ?? 'برنامهٔ هفتگی',
        controller: c,
        sync: widget.sync,
        onRetry: widget.onRetry,
        actions: [
          if (mgr) ...[
            IconButton(
              key: const Key('sch-workdays'),
              tooltip: 'روزهای فعال',
              icon: const Icon(Icons.date_range_outlined),
              onPressed: () => _open(WorkdaysPage(controller: c)),
            ),
            IconButton(
              key: const Key('sch-bells'),
              tooltip: 'تنظیم زنگ‌ها',
              icon: const Icon(Icons.timer_outlined),
              onPressed: () => _open(BellsPage(controller: c)),
            ),
          ],
          if (v != null && v.canEdit)
            IconButton(
              key: const Key('sch-gen'),
              tooltip: 'تولید خودکار',
              icon: const Icon(Icons.auto_fix_high_outlined),
              onPressed: () => _open(GeneratorPage(controller: c)),
            ),
        ],
        body: v == null
            ? const SizedBox.shrink()
            : ListView(
                padding: const EdgeInsets.all(PayeshTokens.space4),
                children: [
                  if (mgr) ...[
                    if (v.grades.isEmpty)
                      const Text(
                        'برای چیدن برنامه، ابتدا پایه و رشته را در بخش «کلاس‌ها» تعریف کنید.',
                        key: Key('sch-no-grade'),
                      )
                    else ...[
                      _dropdown<String>('sch-grade', 'پایه', v.grade, [
                        for (final g in v.grades) (g, g),
                      ], (g) => c.pickCohort(grade: g)),
                      const SizedBox(height: PayeshTokens.space2),
                      _dropdown<String>('sch-branch', 'رشته', v.branch, [
                        ('', '— بدون رشته —'),
                        for (final b in v.branches) (b, b),
                      ], (b) => c.pickCohort(branch: b ?? '')),
                      const Padding(
                        padding: EdgeInsets.only(top: PayeshTokens.space1),
                        child: Text(
                          'برنامه برای این پایه و رشته چیده می‌شود؛ محل برگزاری را برای هر زنگ جداگانه انتخاب کنید.',
                        ),
                      ),
                    ],
                  ],
                  if (c.role == 'teacher' && v.homeClasses.isNotEmpty)
                    _dropdown<int>('sch-home', 'نمای من', c.homeClass ?? 0, [
                      (0, 'تدریس من'),
                      for (final (id, n) in v.homeClasses) (id, 'سرپرستی: $n'),
                    ], (id) => c.pickHome(id == 0 ? null : id)),
                  if (c.role == 'parent' && v.children.length > 1)
                    Wrap(
                      spacing: PayeshTokens.space2,
                      children: [
                        for (final (id, n) in v.children)
                          ChoiceChip(
                            key: Key('sch-child-$id'),
                            label: Text(n),
                            selected: (c.child ?? v.children.first.$1) == id,
                            onSelected: (_) => c.pickChild(id),
                          ),
                      ],
                    ),
                  _clashes(v),
                  if (!mgr || v.grades.isNotEmpty) _grid(v),
                  if (v.canEdit)
                    const Padding(
                      padding: EdgeInsets.only(top: PayeshTokens.space2),
                      child: Text(
                        '💡 روی خانه بزنید تا درس، دبیر و محل برگزاری را مشخص کنید. روزهای غیرفعال از جدول حذف شده‌اند.',
                      ),
                    ),
                  if (v.subs.isNotEmpty) ...[
                    const SizedBox(height: PayeshTokens.space3),
                    Text(
                      '🔁 جابه‌جای‌های موقت این کلاس',
                      style: Theme.of(context).textTheme.titleSmall,
                    ),
                    for (final x in v.subs)
                      ListTile(
                        key: Key('sch-sub-${x.id}'),
                        title: Text('${x.slotLabel} — ${x.teacher}'),
                        subtitle: Text(
                          JalaliDate.fromIso(x.date)?.jdate ?? x.date,
                        ),
                        trailing: IconButton(
                          key: Key('sch-sub-del-${x.id}'),
                          tooltip: 'حذف',
                          icon: const Icon(Icons.delete_outline),
                          onPressed: c.busy ? null : () => _deleteSub(x),
                        ),
                      ),
                  ],
                  if (v.slots.isEmpty && !v.canEdit)
                    const Padding(
                      padding: EdgeInsets.only(top: PayeshTokens.space3),
                      child: Text(
                        'برنامهٔ هفتگی برای این پایه یا کاربر هنوز ثبت نشده است.',
                      ),
                    ),
                ],
              ),
      );
    },
  );
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
        TextField(
          key: Key('${widget.k}-name'),
          controller: t,
          autofocus: true,
          decoration: InputDecoration(
            labelText: widget.label,
            border: const OutlineInputBorder(),
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
    this.slot,
    this.subs = const [],
  });
  final ScheduleController controller;
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

  DropdownButtonFormField<int?> _pick(
    String key,
    String label,
    int? value,
    List<(int?, String)> items,
    ValueChanged<int?> onChanged,
  ) => DropdownButtonFormField<int?>(
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
  );

  @override
  Widget build(BuildContext context) {
    final editing = widget.slot != null;
    final cohort =
        '${widget.grade}${widget.branch.isEmpty ? '' : ' · ${widget.branch}'}';
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
        Text('پایه و رشته: $cohort', key: const Key('slot-cohort')),
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
          'محل برگزاری',
          room,
          [
            (
              null,
              widget.slot != null &&
                      widget.slot!.roomId == null &&
                      widget.slot!.room.isNotEmpty
                  ? 'مکان قبلی: ${widget.slot!.room}'
                  : '— انتخاب محل —',
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
          Wrap(
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
  List<_BellRow>? rows;

  @override
  void initState() {
    super.initState();
    widget.controller.bellDraft().then((d) {
      if (mounted) setState(() => rows = [for (final b in d) _BellRow(b)]);
    });
  }

  @override
  void dispose() {
    for (final r in rows ?? const <_BellRow>[]) {
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

  @override
  Widget build(BuildContext context) {
    var lesson = 0, brk = 0;
    return SchoolForm(
      prefix: 'bell',
      title: 'تنظیم زنگ‌ها',
      controller: widget.controller,
      submitLabel: 'ذخیرهٔ ساعت‌ها',
      onSubmit: () async {
        final w = await widget.controller.saveBells([
          for (final r in rows ?? const <_BellRow>[]) r.draft,
        ]);
        if (w != null && context.mounted) Navigator.pop(context);
      },
      fields: [
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
                    DropdownButtonFormField<String>(
                      key: Key('bell-t-$i'),
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
