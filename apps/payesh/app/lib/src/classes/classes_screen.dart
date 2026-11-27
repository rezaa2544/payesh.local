// Row 128, wave W8 — `#/classes` (web PAGES.classes): rooms, classes, grades, branches and
// subjects, with their forms and the delete choices of the web client. Every write is local-first
// through ClassBook (queue first, then the local copy).
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../pulse/web.dart';
import '../school/school_source.dart';

class ClassesController extends SchoolController {
  ClassesController({
    required super.source,
    required super.role,
    required super.uid,
  });

  ClassesView? view;

  /// ردیف ۱۹۵: دبیران مدرسه (برای «دبیر پایه» در فرم کلاس).
  List<(int, String)> teachers = const [];

  /// web `isFieldSchool` — ردیف ۱۹۵: از مقطع مدرسه (متوسطه دوم = رشته‌محور).
  bool get fieldSchool => view?.structure.fieldBased ?? false;

  @override
  Future<void> read(SchoolRecords db) async {
    view = await ClassBook(db).overview();
    teachers = [
      for (final u in await db.allOrEmpty('users'))
        if (u.data['role'] == 'teacher' && u.data['active'] != false)
          (u.id, SchoolRecords.str(u.data['name'])),
    ]..sort((a, b) => a.$2.compareTo(b.$2));
  }

  Future<RecordWrite?> saveRoom({int? id, required String name}) =>
      run((db) => ClassBook(db).saveRoom(id: id, name: name), form: true);

  Future<RecordWrite?> saveClass(ClassDraft d, {int? id}) =>
      run((db) => ClassBook(db).saveClass(d, id: id), form: true);

  Future<int> studentsOf(int id) async =>
      db == null ? 0 : ClassBook(db!).studentsOf(id);

  Future<RecordWrite?> deleteClass(int id) =>
      run((db) => ClassBook(db).deleteClass(id));

  Future<RecordWrite?> merge(int from, int into) =>
      run((db) => ClassBook(db).mergeClass(from, into));

  Future<RecordWrite?> saveLookup({
    int? id,
    required String kind,
    required String name,
    String order = '',
  }) => run(
    (db) =>
        ClassBook(db).saveLookup(id: id, kind: kind, name: name, order: order),
    form: true,
  );

  Future<LookupUsage?> usage(int id) async =>
      db == null ? null : ClassBook(db!).lookupUsage(id);

  Future<RecordWrite?> deleteLookup(int id, LookupDelete how) =>
      run((db) => ClassBook(db).deleteLookup(id, how));

  Future<RecordWrite?> saveSubject({
    int? id,
    required String name,
    required bool workshop,
  }) => run(
    (db) => ClassBook(db).saveSubject(id: id, name: name, workshop: workshop),
    form: true,
  );

  Future<RecordWrite?> deleteSubject(int id) =>
      run((db) => ClassBook(db).deleteSubject(id));
}

/// ردیف ۱۹۵ — خط ساختار مدرسه: کلاس‌محور (ابتدایی / متوسطه اول) یا رشته‌محور (متوسطه دوم).
String structureLine(SchoolStructure st) {
  final head =
      'ساختار مدرسه: ${st.modeFa}${st.level.isEmpty ? ' (مقطع تعیین نشده — در «سیستم ← مشخصات مدرسه» تعیین کنید)' : ' · ${st.level}'}';
  return st.fieldBased
      ? '$head — محور اصلی «پایه × رشته» است و کلاس/کارگاهِ هر زنگ را مدیر در برنامهٔ هفتگی تعیین می‌کند.'
      : '$head — کلاس‌ها ثابت‌اند؛ هر کلاس اتاق و دبیر پایهٔ خودش را دارد و رشته ندارد.';
}

class ClassesScreen extends StatefulWidget {
  const ClassesScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });
  final ClassesController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<ClassesScreen> createState() => _ClassesScreenState();
}

class _ClassesScreenState extends State<ClassesScreen> {
  ClassesController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  Future<void> _open(Widget page) async {
    await openPanel<void>(context, (_) => page);
    c.clearForm();
  }

  /// Native-only: a write still waiting for the server (the web has no offline queue).
  List<Widget> _queued(bool q) =>
      q ? const [WebBadge('در صف ارسال', tone: WebTone.amber)] : const [];

  /// `<div class="row between" style="margin-bottom:8px"><b>…</b><button class="btn sm">…`
  Widget _head(
    String title,
    String addKey,
    String addLabel,
    VoidCallback add, {
    String? icon,
    // row 194: every «+ …» of this page looks like «+ کلاس/کارگاه» (the filled black button)
    bool primary = true,
    String? count,
  }) => WebCardHead(
    title: title,
    icon: icon,
    actions: [
      if (count != null) Text(count, style: Web.small),
      WebBtn(
        '+ $addLabel',
        key: Key(addKey),
        kind: primary ? WebBtnKind.primary : WebBtnKind.normal,
        onPressed: c.busy ? null : add,
      ),
    ],
  );

  /// The «ویرایش» + red «حذف» pair of every web row.
  List<Widget> _rowActions(
    String edit,
    VoidCallback onEdit,
    String delete,
    VoidCallback onDelete,
  ) => [
    WebBtn(
      'ویرایش',
      key: Key(edit),
      kind: WebBtnKind.ghost,
      onPressed: c.busy ? null : onEdit,
    ),
    WebBtn.delete('حذف', key: Key(delete), onPressed: c.busy ? null : onDelete),
  ];

  /// ردیف ۱۹۵ — کلاس‌های ثابتِ مدرسهٔ کلاس‌محور (p2 viewClasses): پایه، اتاق، دبیر پایه، پرشدگی.
  Widget _classesCard(ClassesView v) => WebCard(
    key: const Key('cls-classes'),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        WebCardHead(
          title: 'کلاس‌ها',
          icon: '🏛️',
          actions: [Text('${Web.fa(v.classes.length)} کلاس', style: Web.small)],
        ),
        if (v.classes.isEmpty)
          Text(
            'هنوز کلاسی تعریف نشده — با «+ کلاس جدید» کلاس‌های ثابت (مثل «سوم الف») را بسازید.',
            style: Web.small,
          )
        else
          WebTable(
            key: const Key('cls-classes-table'),
            head: const ['کلاس', 'پایه', 'اتاق', 'دبیر پایه', 'دانش‌آموز', ''],
            rows: [
              for (final r in v.classes)
                [
                  WebWrap(
                    key: Key('cls-class-${r.id}'),
                    spacing: 4,
                    children: [
                      Text(
                        r.name,
                        style: const TextStyle(fontWeight: FontWeight.w700),
                      ),
                      ..._queued(r.queued),
                    ],
                  ),
                  Text(r.grade.isEmpty ? '—' : r.grade),
                  Text(r.room.isEmpty ? '—' : r.room),
                  Text(r.teacher.isEmpty ? '—' : r.teacher),
                  WebBadge(
                    '${Web.fa(r.students)} / ${Web.fa(r.capacity)}',
                    tone: r.students > r.capacity
                        ? WebTone.red
                        : (r.students * 10 >= r.capacity * 9
                              ? WebTone.amber
                              : WebTone.green),
                  ),
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: _rowActions(
                      'cls-class-edit-${r.id}',
                      () => _open(ClassFormPage(controller: c, row: r)),
                      'cls-class-delete-${r.id}',
                      () => _deleteClass(r),
                    ),
                  ),
                ],
            ],
          ),
      ],
    ),
  );

  Future<void> _deleteClass(ClassRow r) async {
    final n = await c.studentsOf(r.id);
    if (!mounted) return;
    final ok = await confirmAction(
      context,
      prefix: 'cls',
      title: 'حذف کلاس',
      message: n > 0
          ? 'کلاس «${r.name}» حذف شود؟ $n دانش‌آموز بدون کلاس می‌شوند (خودشان حذف نمی‌شوند).'
          : 'کلاس «${r.name}» حذف شود؟',
    );
    if (ok) await c.deleteClass(r.id);
  }

  Future<void> _deleteLookup(LookupRow r) async {
    final label = lookupFa[r.kind] ?? 'مورد';
    if (r.classes == 0) {
      final ok = await confirmAction(
        context,
        prefix: 'def',
        title: 'حذف $label',
        message: '«${r.name}» از فهرست $labelها حذف شود؟',
      );
      if (ok) await c.deleteLookup(r.id, LookupDelete.only);
      return;
    }
    final u = await c.usage(r.id);
    if (u == null || !mounted) return;
    final n = u.classes.length;
    final how = await showDialog<LookupDelete>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('حذف $label — ${r.name}'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'این $label در $n کلاس استفاده شده است: ${u.classes.take(8).join('، ')}${n > 8 ? ' …' : ''}',
            ),
            if (u.students > 0)
              Padding(
                padding: const EdgeInsets.only(top: PayeshTokens.space2),
                child: Text(
                  'در این کلاس‌ها ${u.students} دانش‌آموز هست. تکلیفشان چه شود؟',
                ),
              ),
            const SizedBox(height: PayeshTokens.space3),
            OutlinedButton(
              key: const Key('def-del-cascade'),
              onPressed: () => Navigator.pop(ctx, LookupDelete.cascade),
              child: Text(
                '$label و $n کلاسش حذف شوند — دانش‌آموزان بمانند و به «نیازمند پیگیری» بروند',
              ),
            ),
            if (u.students > 0)
              Padding(
                padding: const EdgeInsets.only(top: PayeshTokens.space2),
                child: FilledButton(
                  key: const Key('def-del-students'),
                  style: FilledButton.styleFrom(
                    backgroundColor: Theme.of(ctx).colorScheme.error,
                  ),
                  onPressed: () => Navigator.pop(ctx, LookupDelete.students),
                  child: Text(
                    '$label، $n کلاس و ${u.students} دانش‌آموزش هم حذف شوند',
                  ),
                ),
              ),
            const SizedBox(height: PayeshTokens.space2),
            TextButton(
              key: const Key('def-del-only'),
              onPressed: () => Navigator.pop(ctx, LookupDelete.only),
              child: Text('فقط $label از فهرست حذف شود (کلاس‌ها بمانند)'),
            ),
            TextButton(
              key: const Key('def-del-cancel'),
              onPressed: () => Navigator.pop(ctx),
              child: const Text('انصراف'),
            ),
          ],
        ),
      ),
    );
    if (how == null || !mounted) return;
    if (how == LookupDelete.students) {
      final ok = await confirmAction(
        context,
        prefix: 'def',
        title: 'حذف دانش‌آموزان',
        message:
            '«${r.name}» با $n کلاس و ${u.students} دانش‌آموزش حذف شود؟ این کار برگشت‌پذیر نیست.',
      );
      if (!ok) return;
    }
    await c.deleteLookup(r.id, how);
  }

  Future<void> _deleteSubject(SubjectRow r) async {
    final ok = await confirmAction(
      context,
      prefix: 'sub',
      title: 'حذف درس',
      message:
          'درس «${r.name}» حذف شود؟${r.slots > 0 ? ' (${r.slots} زنگ برنامه به این درس اشاره دارد و حذف می‌شود)' : ''}',
    );
    if (ok) await c.deleteSubject(r.id);
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      final v = c.view;
      // web PAGES.classes: `isFieldSchool` hides «+ کلاس جدید» (field schools get their
      // classes from the grade × branch pairs). ردیف ۱۹۵: ساختار از مقطع مدرسه می‌آید.
      final field = c.fieldSchool;
      final st = v?.structure;
      return SchoolPage(
        prefix: 'cls',
        title: 'کلاس‌ها و تعریف‌ها',
        // ردیف ۱۹۵: ساختار مدرسه (p2 «نوع چیدمان») در خط زیر عنوان — بدون کارت اضافه
        sub: st == null ? null : structureLine(st),
        subKey: const Key('cls-structure'),
        controller: c,
        sync: widget.sync,
        onRetry: widget.onRetry,
        body: const SizedBox.shrink(),
        headActions: [
          if (!field)
            WebBtn(
              '+ کلاس جدید',
              key: const Key('cls-class-add'),
              kind: WebBtnKind.primary,
              onPressed: c.busy
                  ? null
                  : () => _open(ClassFormPage(controller: c)),
            ),
        ],
        children: v == null
            ? const []
            : [
                if (!field) _classesCard(v),
                // row 185: three columns side by side — «پایه‌ها» on the right, «رشته‌ها» in the
                // middle, «کلاس و محل برگزاری» on the left (FlowColumns puts the first on the right)
                // ردیف ۱۹۵: مدرسهٔ کلاس‌محور رشته ندارد — کارت «رشته‌ها» فقط در رشته‌محور
                for (final (kind, title, rows) in [
                  ('grade', 'پایه‌ها', v.grades),
                  if (field) ('branch', 'رشته‌ها', v.branches),
                ])
                  WebCard(
                    key: Key('cls-defs-$kind'),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _head(
                          title,
                          'cls-def-add-$kind',
                          lookupFa[kind]!,
                          () => _open(DefFormPage(controller: c, kind: kind)),
                        ),
                        WebList(
                          children: [
                            for (final r in rows)
                              WebItem(
                                key: Key('cls-def-${r.id}'),
                                title: r.name,
                                // row 197-Q04: the students of this grade/branch (their own
                                // grade/major) — a field school lists no classes, so «بدون
                                // استفاده» alone read as an empty major
                                titleTrailing: [
                                  if (r.students > 0)
                                    WebBadge(
                                      '${Web.fa(r.students)} دانش‌آموز',
                                      key: Key('cls-def-students-${r.id}'),
                                      tone: WebTone.green,
                                    ),
                                  ..._queued(r.queued),
                                ],
                                sub: r.classes > 0
                                    ? '${Web.fa(r.classes)} کلاس از این مورد استفاده می‌کند'
                                    : 'بدون استفاده',
                                actions: _rowActions(
                                  'cls-def-edit-${r.id}',
                                  () => _open(
                                    DefFormPage(
                                      controller: c,
                                      kind: kind,
                                      row: r,
                                    ),
                                  ),
                                  'cls-def-delete-${r.id}',
                                  () => _deleteLookup(r),
                                ),
                              ),
                          ],
                        ),
                      ],
                    ),
                  ),
                WebCard(
                  key: const Key('cls-rooms'),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      _head(
                        field
                            ? 'کلاس‌ها و کارگاه‌ها (محل برگزاری)'
                            : 'فضاهای ویژه (آزمایشگاه، کارگاه، نمازخانه…)',
                        'cls-room-add',
                        'کلاس/کارگاه',
                        () => _open(RoomFormPage(controller: c)),
                        icon: '🏫',
                        count: '${Web.fa(v.rooms.length)} مورد',
                      ),
                      Padding(
                        padding: EdgeInsets.only(bottom: 8),
                        child: Text(
                          field
                              ? 'فقط نام لازم است؛ مدیر همین نام را در برنامهٔ هفتگی به هر زنگ می‌دهد (کلاسِ هر زنگ در رشته‌محور ثابت نیست).'
                              : 'کلاس‌های ثابت اتاق خودشان را دارند؛ این‌جا فقط فضاهای مشترک را تعریف کنید تا در برنامهٔ هفتگی برای زنگ‌های ویژه انتخاب شوند.',
                          style: TextStyle(
                            fontSize: 12.5,
                            color: Web.muted,
                            height: 2,
                          ),
                        ),
                      ),
                      if (v.rooms.isEmpty)
                        Text(
                          'هنوز کلاس یا کارگاهی تعریف نشده است.',
                          style: Web.small,
                        )
                      else
                        WebTable(
                          key: const Key('cls-rooms-table'),
                          head: const ['نام', 'دانش‌آموز', ''],
                          rows: [
                            for (final r in v.rooms)
                              [
                                WebWrap(
                                  key: Key('cls-room-${r.id}'),
                                  spacing: 4,
                                  children: [
                                    Text(
                                      r.name,
                                      style: const TextStyle(
                                        fontWeight: FontWeight.w700,
                                      ),
                                    ),
                                    ..._queued(r.queued),
                                  ],
                                ),
                                Text(Web.fa(r.students)),
                                Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: _rowActions(
                                    'cls-room-edit-${r.id}',
                                    () => _open(
                                      RoomFormPage(controller: c, row: r),
                                    ),
                                    'cls-room-delete-${r.id}',
                                    () => _deleteClass(r),
                                  ),
                                ),
                              ],
                          ],
                        ),
                    ],
                  ),
                ),
                WebCard(
                  key: const Key('cls-subjects'),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      _head(
                        'دروس',
                        'cls-subject-add',
                        'درس',
                        () => _open(SubjectFormPage(controller: c)),
                      ),
                      if (v.subjects.isEmpty)
                        const WebEmpty('درسی تعریف نشده.')
                      else
                        WebList(
                          children: [
                            for (final r in v.subjects)
                              WebItem(
                                key: Key('cls-subject-${r.id}'),
                                title: r.name,
                                titleTrailing: [
                                  if (r.workshop)
                                    const WebBadge(
                                      'کارگاهی',
                                      tone: WebTone.purple,
                                    ),
                                  ..._queued(r.queued),
                                ],
                                sub: '${Web.fa(r.slots)} زنگ در برنامه',
                                actions: _rowActions(
                                  'cls-subject-edit-${r.id}',
                                  () => _open(
                                    SubjectFormPage(controller: c, row: r),
                                  ),
                                  'cls-subject-delete-${r.id}',
                                  () => _deleteSubject(r),
                                ),
                              ),
                          ],
                        ),
                    ],
                  ),
                ),
              ],
      );
    },
  );
}

/// Form `class`, kind = room.
class RoomFormPage extends StatefulWidget {
  const RoomFormPage({super.key, required this.controller, this.row});
  final ClassesController controller;
  final ClassRow? row;

  @override
  State<RoomFormPage> createState() => _RoomFormPageState();
}

class _RoomFormPageState extends State<RoomFormPage> {
  late final name = TextEditingController(text: widget.row?.name ?? '');

  @override
  void dispose() {
    name.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SchoolForm(
    prefix: 'room',
    title: widget.row == null
        ? 'کلاس / کارگاه جدید'
        : 'ویرایش — ${widget.row!.name}',
    controller: widget.controller,
    submitLabel: widget.row == null ? 'افزودن' : 'ذخیرهٔ تغییرات',
    onSubmit: () async {
      final r = await widget.controller.saveRoom(
        id: widget.row?.id,
        name: name.text,
      );
      if (r != null && context.mounted) Navigator.pop(context);
    },
    fields: [
      SchoolField('room-f-name', 'نام کلاس / کارگاه', name),
      const Text(
        'همین نام در برنامهٔ هفتگی به هر زنگ داده می‌شود. چیز دیگری لازم نیست.',
      ),
    ],
  );
}

/// Form `class` (kind = group): mode, name, grade, branch.
class ClassFormPage extends StatefulWidget {
  const ClassFormPage({super.key, required this.controller, this.row});
  final ClassesController controller;
  final ClassRow? row;

  @override
  State<ClassFormPage> createState() => _ClassFormPageState();
}

class _ClassFormPageState extends State<ClassFormPage> {
  late final name = TextEditingController(text: widget.row?.name ?? '');
  late String grade = widget.row?.grade ?? '';
  late String branch = widget.row?.branch ?? '';
  late String mode = widget.row?.mode ?? '';
  late final room = TextEditingController(text: widget.row?.room ?? '');
  late final capacity = TextEditingController(
    text: widget.row == null ? '' : '${widget.row!.capacity}',
  );
  late int? teacher = widget.row?.teacherId;

  @override
  void dispose() {
    name.dispose();
    room.dispose();
    capacity.dispose();
    super.dispose();
  }

  Widget _pick(
    String key,
    String label,
    List<LookupRow> rows,
    String value,
    ValueChanged<String> set, {
    List<String> extra = const [],
  }) {
    // row 197-Q04: one item per name (a grade defined twice made the menu fail) + the grades of
    // the school's level, so the menu is never empty or broken
    final seen = <String>{};
    final names = [
      for (final n in [...rows.map((r) => r.name), ...extra])
        if (n.trim().isNotEmpty && seen.add(groupKey(n))) n,
    ];
    // a value not in the definitions still shows (editing an old class must not change it)
    final all = [
      if (value.isNotEmpty && !seen.contains(groupKey(value))) value,
      ...names,
    ];
    return FieldBox(
      width: kFieldText,
      child: DropdownButtonFormField<String>(
        key: Key(key),
        isExpanded: true,
        // the same name written another way («نقشه‌کشی» / «نقشه کشی») selects its item
        initialValue: value.isEmpty
            ? value
            : all.firstWhere(
                (n) => groupKey(n) == groupKey(value),
                orElse: () => value,
              ),
        decoration: InputDecoration(
          labelText: label,
          border: const OutlineInputBorder(),
        ),
        items: [
          const DropdownMenuItem(value: '', child: Text('—')),
          for (final n in all)
            DropdownMenuItem(
              value: n,
              child: Text(names.contains(n) ? n : '$n (تعریف نشده)'),
            ),
        ],
        onChanged: (v) => setState(() => set(v ?? '')),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final v = widget.controller.view;
    final st =
        v?.structure ?? const SchoolStructure(level: '', fieldBased: false);
    return SchoolForm(
      prefix: 'cf',
      title: widget.row == null
          ? 'کلاس جدید'
          : 'ویرایش کلاس — ${widget.row!.name}',
      controller: widget.controller,
      submitLabel: widget.row == null ? 'ایجاد کلاس' : 'ذخیرهٔ تغییرات',
      onSubmit: () async {
        final r = await widget.controller.saveClass(
          ClassDraft(
            name: name.text,
            grade: grade,
            branch: branch,
            mode: mode,
            room: room.text,
            capacity: capacity.text,
            teacherId: teacher,
          ),
          id: widget.row?.id,
        );
        if (r != null && context.mounted) Navigator.pop(context);
      },
      fields: [
        // ردیف ۱۹۵: وقتی مقطع مدرسه معلوم است، نوع چیدمان از مقطع می‌آید و انتخابی نیست
        if (st.level.isNotEmpty)
          Text(
            'نوع چیدمان: ${st.modeFa} (مقطع ${st.level})',
            key: const Key('cf-mode-fixed'),
          )
        else
          FieldBox(
            width: kFieldText,
            child: DropdownButtonFormField<String>(
              key: const Key('cf-f-mode'),
              isExpanded: true,
              initialValue: mode,
              decoration: const InputDecoration(
                labelText: 'نوع چیدمان',
                border: OutlineInputBorder(),
              ),
              items: const [
                DropdownMenuItem(
                  value: '',
                  child: Text('— خودکار از روی پایه —'),
                ),
                DropdownMenuItem(
                  value: 'class',
                  child: Text('کلاس‌محور (ابتدایی و متوسطه اول)'),
                ),
                DropdownMenuItem(
                  value: 'field',
                  child: Text('رشته‌محور (متوسطه دوم)'),
                ),
              ],
              onChanged: (x) => setState(() => mode = x ?? ''),
            ),
          ),
        SchoolField(
          'cf-f-name',
          st.fieldBased
              ? 'نام کلاس (خالی = از پایه و رشته)'
              : 'نام کلاس (مثل «سوم الف»؛ خالی = نام پایه)',
          name,
        ),
        _pick(
          'cf-f-grade',
          'پایه (الزامی)',
          v?.grades ?? const [],
          grade,
          (x) => grade = x,
          extra: st.grades,
        ),
        if (!(st.level.isNotEmpty && st.classBased))
          _pick(
            'cf-f-branch',
            'رشته (فقط رشته‌محور)',
            v?.branches ?? const [],
            branch,
            (x) => branch = x,
          ),
        SchoolField(
          'cf-f-room',
          st.fieldBased ? 'اتاق پیش‌فرض (اختیاری)' : 'اتاق کلاس (اختیاری)',
          room,
        ),
        SchoolField(
          'cf-f-capacity',
          'ظرفیت (خالی = ۳۰)',
          capacity,
          numeric: true,
        ),
        FieldBox(
          width: kFieldText,
          child: DropdownButtonFormField<int>(
            key: const Key('cf-f-teacher'),
            isExpanded: true,
            initialValue: widget.controller.teachers.any((t) => t.$1 == teacher)
                ? teacher
                : 0,
            decoration: const InputDecoration(
              labelText: 'دبیر پایه (سرپرست کلاس)',
              border: OutlineInputBorder(),
            ),
            items: [
              const DropdownMenuItem(value: 0, child: Text('— انتخاب دبیر —')),
              for (final (id, n) in widget.controller.teachers)
                DropdownMenuItem(value: id, child: Text(n)),
            ],
            onChanged: (x) =>
                setState(() => teacher = x == null || x == 0 ? null : x),
          ),
        ),
        Text(
          st.classBased
              ? 'اگر پایهٔ دلخواه در فهرست نیست، از بخش «پایه‌ها» اضافه کنید.'
              : 'اگر پایه یا رشتهٔ دلخواه در فهرست نیست، از بخش «پایه‌ها» یا «رشته‌ها» اضافه کنید.',
        ),
      ],
    );
  }
}

/// Form `def` (grade / branch).
class DefFormPage extends StatefulWidget {
  const DefFormPage({
    super.key,
    required this.controller,
    required this.kind,
    this.row,
  });
  final ClassesController controller;
  final String kind;
  final LookupRow? row;

  @override
  State<DefFormPage> createState() => _DefFormPageState();
}

class _DefFormPageState extends State<DefFormPage> {
  late final name = TextEditingController(text: widget.row?.name ?? '');
  late final order = TextEditingController(
    text: widget.row == null || widget.row!.order == 0
        ? ''
        : '${widget.row!.order}',
  );

  @override
  void dispose() {
    name.dispose();
    order.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final label = lookupFa[widget.kind] ?? 'مورد';
    return SchoolForm(
      prefix: 'def',
      title: widget.row == null
          ? 'افزودن $label'
          : 'ویرایش $label — ${widget.row!.name}',
      controller: widget.controller,
      submitLabel: widget.row == null ? 'ثبت' : 'ذخیرهٔ تغییرات',
      onSubmit: () async {
        final r = await widget.controller.saveLookup(
          id: widget.row?.id,
          kind: widget.kind,
          name: name.text,
          order: order.text,
        );
        if (r != null && context.mounted) Navigator.pop(context);
      },
      fields: [
        SchoolField('def-f-name', 'نام $label', name),
        SchoolField(
          'def-f-order',
          'ترتیب نمایش (اختیاری)',
          order,
          numeric: true,
        ),
      ],
    );
  }
}

/// Form `subject`.
class SubjectFormPage extends StatefulWidget {
  const SubjectFormPage({super.key, required this.controller, this.row});
  final ClassesController controller;
  final SubjectRow? row;

  @override
  State<SubjectFormPage> createState() => _SubjectFormPageState();
}

class _SubjectFormPageState extends State<SubjectFormPage> {
  late final name = TextEditingController(text: widget.row?.name ?? '');
  late bool workshop = widget.row?.workshop ?? false;

  @override
  void dispose() {
    name.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SchoolForm(
    prefix: 'sub',
    title: widget.row == null ? 'درس جدید' : 'ویرایش درس — ${widget.row!.name}',
    controller: widget.controller,
    submitLabel: widget.row == null ? 'ثبت درس' : 'ذخیرهٔ تغییرات',
    onSubmit: () async {
      final r = await widget.controller.saveSubject(
        id: widget.row?.id,
        name: name.text,
        workshop: workshop,
      );
      if (r != null && context.mounted) Navigator.pop(context);
    },
    fields: [
      SchoolField('sub-f-name', 'نام درس', name),
      StatefulBuilder(
        builder: (context, set) => SwitchListTile(
          key: const Key('sub-f-workshop'),
          title: const Text('کارگاهی — نمرهٔ عملی'),
          value: workshop,
          onChanged: (x) => set(() => workshop = x),
        ),
      ),
    ],
  );
}
