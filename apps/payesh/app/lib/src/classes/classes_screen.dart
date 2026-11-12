// Row 128, wave W8 — `#/classes` (web PAGES.classes): rooms, classes, grades, branches and
// subjects, with their forms and the delete choices of the web client. Every write is local-first
// through ClassBook (queue first, then the local copy).
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../school/school_source.dart';

class ClassesController extends SchoolController {
  ClassesController({
    required super.source,
    required super.role,
    required super.uid,
  });

  ClassesView? view;

  @override
  Future<void> read(SchoolRecords db) async {
    view = await ClassBook(db).overview();
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
    await Navigator.of(context)
        .push(MaterialPageRoute<void>(builder: (_) => page));
    c.clearForm();
  }

  Widget _queued(bool q) => q
      ? const Padding(
          padding: EdgeInsetsDirectional.only(end: PayeshTokens.space1),
          child: StatusBadge(
            'در صف ارسال',
            tone: PayeshTone.warning,
            icon: Icons.schedule,
          ),
        )
      : const SizedBox.shrink();

  Widget _head(
    String title,
    String addKey,
    String addLabel,
    VoidCallback add,
  ) => Padding(
    padding: const EdgeInsets.only(
      top: PayeshTokens.space4,
      bottom: PayeshTokens.space2,
    ),
    child: Row(
      children: [
        Expanded(
          child: Text(title, style: Theme.of(context).textTheme.titleMedium),
        ),
        FilledButton.tonalIcon(
          key: Key(addKey),
          onPressed: c.busy ? null : add,
          icon: const Icon(Icons.add),
          label: Text(addLabel),
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

  Future<void> _merge(ClassRow r) async {
    final targets = [
      for (final x in c.view?.classes ?? const <ClassRow>[])
        if (x.id != r.id) x,
    ];
    final into = await showDialog<int>(
      context: context,
      builder: (ctx) => SimpleDialog(
        title: Text('ادغام «${r.name}» در …'),
        children: [
          for (final t in targets)
            SimpleDialogOption(
              key: Key('cls-merge-to-${t.id}'),
              onPressed: () => Navigator.pop(ctx, t.id),
              child: Text(t.name),
            ),
          SimpleDialogOption(
            key: const Key('cls-merge-cancel'),
            onPressed: () => Navigator.pop(ctx),
            child: const Text('انصراف'),
          ),
        ],
      ),
    );
    if (into == null || !mounted) return;
    final name = targets.firstWhere((t) => t.id == into).name;
    final ok = await confirmAction(
      context,
      prefix: 'cls',
      title: 'ادغام کلاس',
      confirm: 'ادغام',
      message:
          'کلاس «${r.name}» در «$name» ادغام شود؟ دانش‌آموزان و برنامه‌اش به کلاس مقصد منتقل می‌شوند.',
    );
    if (ok) await c.merge(r.id, into);
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

  Widget _menu(String key, List<(String, String, VoidCallback)> items) =>
      PopupMenuButton<int>(
        key: Key(key),
        onSelected: (i) => items[i].$3(),
        itemBuilder: (_) => [
          for (var i = 0; i < items.length; i++)
            PopupMenuItem(
              key: Key(items[i].$1),
              value: i,
              child: Text(items[i].$2),
            ),
        ],
      );

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      final v = c.view;
      return SchoolPage(
        prefix: 'cls',
        title: 'کلاس‌ها و تعریف‌ها',
        controller: c,
        sync: widget.sync,
        onRetry: widget.onRetry,
        body: v == null
            ? const SizedBox.shrink()
            : ListView(
                padding: const EdgeInsets.symmetric(
                  horizontal: PayeshTokens.space4,
                ),
                children: [
                  _head(
                    'کلاس‌ها و کارگاه‌ها (محل برگزاری)',
                    'cls-room-add',
                    'کلاس/کارگاه',
                    () => _open(RoomFormPage(controller: c)),
                  ),
                  if (v.rooms.isEmpty)
                    const Text('هنوز کلاس یا کارگاهی تعریف نشده است.'),
                  for (final r in v.rooms)
                    ListTile(
                      key: Key('cls-room-${r.id}'),
                      title: Text(r.name),
                      subtitle: Text('${r.students} دانش‌آموز'),
                      trailing: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          _queued(r.queued),
                          _menu('cls-room-menu-${r.id}', [
                            (
                              'cls-room-edit-${r.id}',
                              'ویرایش',
                              () => _open(RoomFormPage(controller: c, row: r)),
                            ),
                            (
                              'cls-room-delete-${r.id}',
                              'حذف',
                              () => _deleteClass(r),
                            ),
                          ]),
                        ],
                      ),
                    ),
                  _head(
                    'کلاس‌ها',
                    'cls-class-add',
                    'کلاس جدید',
                    () => _open(ClassFormPage(controller: c)),
                  ),
                  if (v.classes.isEmpty) const Text('کلاسی ساخته نشده.'),
                  for (final r in v.classes)
                    ListTile(
                      key: Key('cls-class-${r.id}'),
                      title: Text(r.name),
                      subtitle: Text(
                        [
                          r.mode == 'field' ? 'رشته‌محور' : 'کلاس‌محور',
                          '${r.students} دانش‌آموز',
                        ].join(' · '),
                      ),
                      trailing: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          _queued(r.queued),
                          _menu('cls-class-menu-${r.id}', [
                            (
                              'cls-class-edit-${r.id}',
                              'ویرایش',
                              () => _open(ClassFormPage(controller: c, row: r)),
                            ),
                            (
                              'cls-class-merge-${r.id}',
                              'ادغام در کلاس دیگر',
                              () => _merge(r),
                            ),
                            (
                              'cls-class-delete-${r.id}',
                              'حذف',
                              () => _deleteClass(r),
                            ),
                          ]),
                        ],
                      ),
                    ),
                  for (final (kind, title, rows) in [
                    ('grade', 'پایه‌ها', v.grades),
                    ('branch', 'رشته‌ها', v.branches),
                  ]) ...[
                    _head(
                      title,
                      'cls-def-add-$kind',
                      lookupFa[kind]!,
                      () => _open(DefFormPage(controller: c, kind: kind)),
                    ),
                    for (final r in rows)
                      ListTile(
                        key: Key('cls-def-${r.id}'),
                        title: Text(r.name),
                        subtitle: Text(
                          r.classes > 0
                              ? '${r.classes} کلاس از این مورد استفاده می‌کند'
                              : 'بدون استفاده',
                        ),
                        trailing: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            _queued(r.queued),
                            _menu('cls-def-menu-${r.id}', [
                              (
                                'cls-def-edit-${r.id}',
                                'ویرایش',
                                () => _open(
                                  DefFormPage(
                                    controller: c,
                                    kind: kind,
                                    row: r,
                                  ),
                                ),
                              ),
                              (
                                'cls-def-delete-${r.id}',
                                'حذف',
                                () => _deleteLookup(r),
                              ),
                            ]),
                          ],
                        ),
                      ),
                  ],
                  _head(
                    'دروس',
                    'cls-subject-add',
                    'درس',
                    () => _open(SubjectFormPage(controller: c)),
                  ),
                  if (v.subjects.isEmpty) const Text('درسی تعریف نشده.'),
                  for (final r in v.subjects)
                    ListTile(
                      key: Key('cls-subject-${r.id}'),
                      title: Text(r.workshop ? '${r.name} · کارگاهی' : r.name),
                      subtitle: Text('${r.slots} زنگ در برنامه'),
                      trailing: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          _queued(r.queued),
                          _menu('cls-subject-menu-${r.id}', [
                            (
                              'cls-subject-edit-${r.id}',
                              'ویرایش',
                              () =>
                                  _open(SubjectFormPage(controller: c, row: r)),
                            ),
                            (
                              'cls-subject-delete-${r.id}',
                              'حذف',
                              () => _deleteSubject(r),
                            ),
                          ]),
                        ],
                      ),
                    ),
                  const SizedBox(height: PayeshTokens.space6),
                ],
              ),
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

  @override
  void dispose() {
    name.dispose();
    super.dispose();
  }

  Widget _pick(
    String key,
    String label,
    List<LookupRow> rows,
    String value,
    ValueChanged<String> set,
  ) {
    final names = [for (final r in rows) r.name];
    // a value not in the definitions still shows (editing an old class must not change it)
    final all = [
      if (value.isNotEmpty && !names.contains(value)) value,
      ...names,
    ];
    return DropdownButtonFormField<String>(
      key: Key(key),
      initialValue: value,
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
    );
  }

  @override
  Widget build(BuildContext context) {
    final v = widget.controller.view;
    return SchoolForm(
      prefix: 'cf',
      title: widget.row == null
          ? 'کلاس جدید'
          : 'ویرایش کلاس — ${widget.row!.name}',
      controller: widget.controller,
      submitLabel: widget.row == null ? 'ایجاد کلاس' : 'ذخیرهٔ تغییرات',
      onSubmit: () async {
        final r = await widget.controller.saveClass(
          ClassDraft(name: name.text, grade: grade, branch: branch, mode: mode),
          id: widget.row?.id,
        );
        if (r != null && context.mounted) Navigator.pop(context);
      },
      fields: [
        DropdownButtonFormField<String>(
          key: const Key('cf-f-mode'),
          initialValue: mode,
          decoration: const InputDecoration(
            labelText: 'نوع چیدمان',
            border: OutlineInputBorder(),
          ),
          items: const [
            DropdownMenuItem(value: '', child: Text('— خودکار از روی پایه —')),
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
        SchoolField('cf-f-name', 'نام کلاس (خالی = از پایه و رشته)', name),
        _pick(
          'cf-f-grade',
          'پایه (الزامی)',
          v?.grades ?? const [],
          grade,
          (x) => grade = x,
        ),
        _pick(
          'cf-f-branch',
          'رشته (فقط رشته‌محور)',
          v?.branches ?? const [],
          branch,
          (x) => branch = x,
        ),
        const Text(
          'اگر پایه یا رشتهٔ دلخواه در فهرست نیست، از بخش «پایه‌ها» یا «رشته‌ها» اضافه کنید.',
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
