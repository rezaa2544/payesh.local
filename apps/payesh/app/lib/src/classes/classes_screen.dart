// Row 128, wave W8 — `#/classes` (web PAGES.classes): rooms, classes, grades, branches and
// subjects, with their forms and the delete choices of the web client. Every write is local-first
// through ClassBook (queue first, then the local copy).
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../pulse/web.dart';
import '../school/school_source.dart';
import '../users/users_controller.dart';
import '../users/users_screen.dart';
import 'class_details.dart';

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
    schoolFieldBased.value = view!.structure.fieldBased;
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

  /// Row 201: the details of an item (read when its panel opens).
  Future<LookupDetail?> lookupDetail(int id) async =>
      db == null ? null : ClassBook(db!).lookupDetail(id);

  /// Row 204: the students «بدون پایه» / «بدون رشته».
  Future<LookupDetail?> unassignedDetail(String kind) async =>
      db == null ? null : ClassBook(db!).unassignedDetail(kind);
  Future<ClassDetail?> classDetail(int id) async =>
      db == null ? null : ClassBook(db!).classDetail(id);
  Future<SubjectDetail?> subjectDetail(int id) async =>
      db == null ? null : ClassBook(db!).subjectDetail(id);

  /// Row 201 `def-merge`.
  Future<RecordWrite?> mergeLookup(int from, int into) =>
      run((db) => ClassBook(db).mergeLookup(from, into));
}

/// Row 204: a student of a grade/branch list opens its own edit form (the users page's) so a
/// wrong or empty پایه/رشته is corrected right there; every figure is read again after.
Future<void> openStudentEdit(
  BuildContext context,
  ClassesController c,
  int id,
) async {
  final uc = UsersController(source: c.source, role: c.role, uid: c.uid);
  await uc.load();
  final u = uc.users.where((x) => x.id == id).firstOrNull;
  if (u == null || !context.mounted) {
    uc.dispose();
    return;
  }
  await openPanel<void>(context, (_) => UserEditPage(controller: uc, user: u));
  uc.dispose();
  await c.load(quiet: true);
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

  /// Row 201: a table cell that opens the row's details + edit.
  Widget _tap(String key, VoidCallback open, Widget child) => MouseRegion(
    cursor: SystemMouseCursors.click,
    child: GestureDetector(
      key: Key(key),
      behavior: HitTestBehavior.opaque,
      onTap: c.busy ? null : open,
      child: child,
    ),
  );

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
                  _tap(
                    'cls-class-open-${r.id}',
                    () => _open(ClassFormPage(controller: c, row: r)),
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
      // row 204: a venue is «محل برگزاری»; a field school's group keeps its students' پایه و رشته
      title: r.isRoom
          ? 'حذف محل برگزاری'
          : c.fieldSchool
          ? 'حذف گروه پایه و رشته'
          : 'حذف کلاس',
      message: r.isRoom
          ? '«${r.name}» از محل‌های برگزاری حذف شود؟'
          : c.fieldSchool
          ? '«${r.name}» حذف شود؟ دانش‌آموزانش با همان پایه و رشته می‌مانند.'
          : n > 0
          ? 'کلاس «${r.name}» حذف شود؟ $n دانش‌آموز بدون کلاس می‌شوند (خودشان حذف نمی‌شوند).'
          : 'کلاس «${r.name}» حذف شود؟',
    );
    if (ok) await c.deleteClass(r.id);
  }

  Future<void> _deleteLookup(LookupRow r) async {
    final label = lookupFa[r.kind] ?? 'مورد';
    // row 204: a field school has no «کلاس» — its پایه+رشته groups are named by the other half
    final field = c.fieldSchool;
    String used(int n) => field
        ? '${Web.fa(n)} ${r.kind == 'branch' ? 'پایه' : 'رشته'}'
        : '${Web.fa(n)} کلاس';
    if (r.classes == 0 && (!field || r.students == 0)) {
      final ok = await confirmAction(
        context,
        prefix: 'def',
        title: 'حذف $label',
        message: r.students > 0
            ? '«${r.name}» از فهرست $labelها حذف شود؟ ${Web.fa(r.students)} دانش‌آموزش '
                  'می‌مانند و تا $label تازه بگیرند در «بدون $label» شمرده می‌شوند.'
            : '«${r.name}» از فهرست $labelها حذف شود؟',
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
            if (n > 0)
              Text(
                'این $label در ${used(n)} استفاده شده است: ${u.classes.take(8).join('، ')}${n > 8 ? ' …' : ''}',
              ),
            if (u.students > 0)
              Padding(
                padding: const EdgeInsets.only(top: PayeshTokens.space2),
                child: Text(
                  field
                      ? '${Web.fa(u.students)} دانش‌آموز این $label هست. تکلیفشان چه شود؟'
                      : 'در این کلاس‌ها ${u.students} دانش‌آموز هست. تکلیفشان چه شود؟',
                ),
              ),
            const SizedBox(height: PayeshTokens.space3),
            OutlinedButton(
              key: const Key('def-del-cascade'),
              onPressed: () => Navigator.pop(ctx, LookupDelete.cascade),
              child: Text(
                field
                    ? '$label حذف شود — دانش‌آموزانش بمانند و به «نیازمند پیگیری» بروند'
                    : '$label و $n کلاسش حذف شوند — دانش‌آموزان بمانند و به «نیازمند پیگیری» بروند',
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
                    field
                        ? '$label و ${Web.fa(u.students)} دانش‌آموزش هم حذف شوند'
                        : '$label، $n کلاس و ${u.students} دانش‌آموزش هم حذف شوند',
                  ),
                ),
              ),
            const SizedBox(height: PayeshTokens.space2),
            TextButton(
              key: const Key('def-del-only'),
              onPressed: () => Navigator.pop(ctx, LookupDelete.only),
              child: Text(
                field
                    ? 'فقط $label از فهرست حذف شود (دانش‌آموزان و برنامه دست نخورند)'
                    : 'فقط $label از فهرست حذف شود (کلاس‌ها بمانند)',
              ),
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
        message: field
            ? '«${r.name}» با ${u.students} دانش‌آموزش حذف شود؟ این کار برگشت‌پذیر نیست.'
            : '«${r.name}» با $n کلاس و ${u.students} دانش‌آموزش حذف شود؟ این کار برگشت‌پذیر نیست.',
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
        // row 204: a field school has no «کلاس» but its venues
        title: field ? 'پایه‌ها، رشته‌ها و محل برگزاری' : 'کلاس‌ها و تعریف‌ها',
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
                                // row 201: the item opens its details + edit
                                onTap: c.busy
                                    ? null
                                    : () => _open(
                                        DefFormPage(
                                          controller: c,
                                          kind: kind,
                                          row: r,
                                        ),
                                      ),
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
                                // row 204: a field school has no «کلاس» — a branch is in N
                                // grades, a grade has N branches
                                sub: field
                                    ? (r.others > 0
                                          ? (kind == 'branch'
                                                ? 'در ${Web.fa(r.others)} پایه'
                                                : '${Web.fa(r.others)} رشته')
                                          : r.students > 0
                                          ? null
                                          : 'بدون استفاده')
                                    : r.classes > 0
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
                            // row 204: the students no grade/branch above counted (empty or
                            // unknown), so the column adds up to every student
                            if ((kind == 'grade' ? v.noGrade : v.noBranch) > 0)
                              WebItem(
                                key: Key('cls-def-none-$kind'),
                                title: 'بدون ${lookupFa[kind]}',
                                onTap: c.busy
                                    ? null
                                    : () => _open(
                                        UnassignedPage(
                                          controller: c,
                                          kind: kind,
                                        ),
                                      ),
                                titleTrailing: [
                                  WebBadge(
                                    '${Web.fa(kind == 'grade' ? v.noGrade : v.noBranch)} دانش‌آموز',
                                    key: Key('cls-def-none-students-$kind'),
                                    tone: WebTone.amber,
                                  ),
                                ],
                                sub:
                                    '${lookupFa[kind]} خالی یا ناشناخته — برای دیدن و درست‌کردن باز کنید',
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
                                _tap(
                                  'cls-room-open-${r.id}',
                                  () => _open(
                                    RoomFormPage(controller: c, row: r),
                                  ),
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
                                onTap: c.busy
                                    ? null
                                    : () => _open(
                                        SubjectFormPage(controller: c, row: r),
                                      ),
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
      if (widget.row != null)
        SchoolFormFull(
          child: DetailLoader<ClassDetail>(
            read: () => widget.controller.classDetail(widget.row!.id),
            builder: (context, d) => DetailCard(
              key: const Key('room-detail'),
              stats: [
                ('دانش‌آموز', Web.fa(d.students.length)),
                ('زنگ در برنامهٔ هفتگی', Web.fa(d.slots)),
              ],
              namesTitle: d.students.isEmpty ? '' : 'دانش‌آموزان',
              names: [for (final (_, n) in d.students) n],
            ),
          ),
        ),
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
        if (widget.row != null)
          SchoolFormFull(
            child: DetailLoader<ClassDetail>(
              read: () => widget.controller.classDetail(widget.row!.id),
              builder: (context, d) => DetailCard(
                key: const Key('cf-detail'),
                stats: [
                  if (widget.row!.grade.isNotEmpty) ('پایه', widget.row!.grade),
                  if (widget.row!.branch.isNotEmpty)
                    ('رشته', widget.row!.branch),
                  (
                    'دانش‌آموز',
                    '${Web.fa(d.students.length)} از ${Web.fa(widget.row!.capacity)}',
                  ),
                  if (widget.row!.teacher.isNotEmpty)
                    ('دبیر پایه', widget.row!.teacher),
                  if (widget.row!.room.isNotEmpty) ('اتاق', widget.row!.room),
                  ('زنگ در برنامهٔ هفتگی', Web.fa(d.slots)),
                ],
                // row 204: a sorted list with details, not a cloud of names
                below: LookupStudents(
                  key: const Key('def-students'),
                  kind: 'class',
                  detail: LookupDetail(students: d.members, classes: const []),
                  field: st.fieldBased,
                  filters: false,
                  empty: 'هنوز دانش‌آموزی در این کلاس نیست.',
                  onOpen: (id) =>
                      openStudentEdit(context, widget.controller, id),
                ),
              ),
            ),
          ),
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

  int _rev = 0;

  /// Row 204: the figures of this row as the page has them now (after an edit).
  LookupRow _fresh(LookupRow row) {
    final v = widget.controller.view;
    final all = widget.kind == 'grade' ? v?.grades : v?.branches;
    return all?.where((r) => r.id == row.id).firstOrNull ?? row;
  }

  Future<void> _student(int id) async {
    await openStudentEdit(context, widget.controller, id);
    if (mounted) setState(() => _rev++);
  }

  Future<void> _merge(int into, String intoName) async {
    final row = widget.row!;
    if (!await confirmMerge(
      context,
      row,
      intoName,
      field: widget.controller.fieldSchool,
    )) {
      return;
    }
    final r = await widget.controller.mergeLookup(row.id, into);
    if (r != null && mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final label = lookupFa[widget.kind] ?? 'مورد';
    final row = widget.row;
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
        if (row != null)
          SchoolFormFull(
            child: DetailLoader<LookupDetail>(
              // row 204: read again after a student of the list was edited
              key: ValueKey(_rev),
              read: () => widget.controller.lookupDetail(row.id),
              builder: (context, d) => lookupDetailCard(
                context,
                _fresh(row),
                d,
                onMerge: _merge,
                field: widget.controller.fieldSchool,
                onOpen: _student,
              ),
            ),
          ),
        SchoolField('def-f-name', 'نام $label', name),
        SchoolField(
          'def-f-order',
          'ترتیب نمایش (اختیاری)',
          order,
          numeric: true,
        ),
        if (row != null)
          SchoolFormFull(
            child: LookupMergeRow(
              row: row,
              field: widget.controller.fieldSchool,
              others: [
                for (final o
                    in (widget.kind == 'grade'
                            ? widget.controller.view?.grades
                            : widget.controller.view?.branches) ??
                        const <LookupRow>[])
                  if (o.id != row.id) o,
              ],
              onMerge: (o) => _merge(o.id, o.name),
            ),
          ),
        if (row != null)
          Text(
            widget.controller.fieldSchool
                ? 'تغییر نام، دانش‌آموزان و برنامهٔ همین $label را هم به نام تازه می‌برد.'
                : 'تغییر نام، دانش‌آموزان و کلاس‌های همین مورد را هم به نام تازه می‌برد.',
          ),
      ],
    );
  }
}

/// Row 204 — «بدون پایه» / «بدون رشته»: the students no definition counted, with the same
/// list and filters as a grade/branch; each opens its edit form to be corrected.
class UnassignedPage extends StatefulWidget {
  const UnassignedPage({
    super.key,
    required this.controller,
    required this.kind,
  });
  final ClassesController controller;
  final String kind;

  @override
  State<UnassignedPage> createState() => _UnassignedPageState();
}

class _UnassignedPageState extends State<UnassignedPage> {
  int _rev = 0;

  @override
  Widget build(BuildContext context) {
    final label = lookupFa[widget.kind] ?? 'مورد';
    return SchoolForm(
      prefix: 'none',
      title: 'دانش‌آموزان بدون $label',
      controller: widget.controller,
      submitLabel: 'بستن',
      onSubmit: () => Navigator.pop(context),
      fields: [
        SchoolFormFull(
          child: Text(
            '$label این دانش‌آموزان خالی است یا با هیچ‌کدام از $labelهای تعریف‌شده جور نیست؛ '
            'برای همین در شمار هیچ $label نیامده‌اند. روی نام هر نفر بزنید و $label درست را '
            'انتخاب کنید — همهٔ شمارها همان لحظه به‌روز می‌شوند.',
            style: Web.small.copyWith(color: Web.muted),
          ),
        ),
        SchoolFormFull(
          child: DetailLoader<LookupDetail>(
            key: ValueKey(_rev),
            read: () => widget.controller.unassignedDetail(widget.kind),
            builder: (context, d) => DetailCard(
              key: const Key('none-detail'),
              stats: [
                ('دانش‌آموز', Web.fa(d.students.length)),
                if (d.inactive > 0)
                  ('غیرفعال (در شمار نیست)', Web.fa(d.inactive)),
              ],
              below: LookupStudents(
                key: const Key('def-students'),
                kind: widget.kind,
                detail: d,
                field: widget.controller.fieldSchool,
                empty: 'همهٔ دانش‌آموزان $label درست دارند.',
                onOpen: (id) async {
                  await openStudentEdit(context, widget.controller, id);
                  if (mounted) setState(() => _rev++);
                },
              ),
            ),
          ),
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
      if (widget.row != null)
        SchoolFormFull(
          child: DetailLoader<SubjectDetail>(
            read: () => widget.controller.subjectDetail(widget.row!.id),
            builder: (context, d) => DetailCard(
              key: const Key('sub-detail'),
              stats: [
                ('زنگ در برنامهٔ هفتگی', Web.fa(d.slots)),
                // row 204: a field school's groups are «پایه و رشته»
                (
                  widget.controller.fieldSchool ? 'پایه و رشته' : 'کلاس',
                  Web.fa(d.classes.length),
                ),
                ('دبیر', Web.fa(d.teachers.length)),
                ('نوع', widget.row!.workshop ? 'کارگاهی' : 'نظری'),
              ],
              namesTitle: d.slots == 0
                  ? ''
                  : widget.controller.fieldSchool
                  ? 'پایه و رشته‌ها و دبیران'
                  : 'کلاس‌ها و دبیران',
              names: [...d.classes, ...d.teachers.map((t) => '👤 $t')],
            ),
          ),
        ),
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
