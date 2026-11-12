// Row 128, wave W10 — `#/followup` (web PAGES.followup) and the bulk-import wizard (web
// client/import.js, the «ورود دسته‌ای از اکسل» modal): students whose grade/branch is not
// complete, open rows of past imports, and the four steps file → columns → check/fix → apply.
// Every write is local-first through Followup / SchoolImport (queue first, then the local copy).
import 'dart:io' show File, FileSystemException;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../school/school_source.dart';
import '../users/users_controller.dart';
import '../users/users_screen.dart';

String _fa(int n) => n.toString().replaceAllMapped(
  RegExp('[0-9]'),
  (m) => '۰۱۲۳۴۵۶۷۸۹'[int.parse(m[0]!)],
);

class FollowupController extends SchoolController {
  FollowupController({
    required super.source,
    required super.role,
    required super.uid,
  });

  FollowupView? view;

  @override
  Future<void> read(SchoolRecords db) async {
    view = await Followup(db).view();
  }

  Future<RecordWrite?> assign(int id, String grade, String branch) =>
      run((db) => Followup(db).assign(id, grade: grade, branch: branch));

  Future<RecordWrite?> ack(int id) => run((db) => Followup(db).ack(id));

  Future<RecordWrite?> issueDone(int id) =>
      run((db) => Followup(db).issueDone(id));

  Future<RecordWrite?> issuesClear() => run((db) => Followup(db).issuesClear());
}

class FollowupScreen extends StatefulWidget {
  const FollowupScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });
  final FollowupController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<FollowupScreen> createState() => _FollowupScreenState();
}

class _FollowupScreenState extends State<FollowupScreen> {
  FollowupController get c => widget.controller;
  final Map<int, String> _grade = {};
  final Map<int, String> _branch = {};

  @override
  void initState() {
    super.initState();
    c.load();
  }

  Future<void> _import() async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => SchoolOwned(
          create: () =>
              ImportController(source: c.source, role: c.role, uid: c.uid),
          page: (ic) => ImportScreen(
            controller: ic as ImportController,
            sync: widget.sync,
            onRetry: widget.onRetry,
          ),
        ),
      ),
    );
    await c.load();
  }

  /// `issue-fix`: the user form with the row's values (or the user it already became); saving
  /// closes the row.
  Future<void> _fix(ImportIssue i) async {
    final uc = UsersController(source: c.source, role: c.role, uid: c.uid);
    await uc.load();
    if (!mounted) {
      uc.dispose();
      return;
    }
    Future<void> done(RecordWrite _) async {
      await c.issueDone(i.id);
    }

    final existing = i.userId == null
        ? null
        : uc.users.where((u) => u.id == i.userId).firstOrNull;
    final Widget page;
    if (existing != null) {
      page = UserEditPage(controller: uc, user: existing, onSaved: done);
    } else {
      final d = i.data;
      page = UserFormPage(
        controller: uc,
        onSaved: done,
        initial: {
          for (final e in d.entries)
            if (e.value != null && e.value is! Map && e.value is! List)
              e.key: '${e.value}',
          'name': SchoolRecords.str(d['full_name']).isNotEmpty
              ? SchoolRecords.str(d['full_name'])
              : i.name,
          'national_id': SchoolRecords.str(d['national_id']).isNotEmpty
              ? SchoolRecords.str(d['national_id'])
              : i.nationalId,
          'phone': SchoolRecords.str(d['phone']).isNotEmpty
              ? SchoolRecords.str(d['phone'])
              : i.phone,
          'role': SchoolRecords.str(d['role']).isEmpty
              ? 'student'
              : SchoolRecords.str(d['role']),
        },
      );
    }
    await Navigator.of(context)
        .push(MaterialPageRoute<void>(builder: (_) => page));
    uc.dispose();
    await c.load();
  }

  Widget _title(String t, String count, String key) => Padding(
    padding: const EdgeInsets.only(
      top: PayeshTokens.space4,
      bottom: PayeshTokens.space2,
    ),
    child: Row(
      children: [
        Expanded(
          child: Text(t, style: Theme.of(context).textTheme.titleMedium),
        ),
        Text(count, key: Key(key)),
      ],
    ),
  );

  Widget _student(FollowupView v, FollowupStudent s) {
    final g = _grade[s.id] ?? s.grade;
    final b = _branch[s.id] ?? s.branch;
    final grades = [...v.grades, if (g.isNotEmpty && !v.grades.contains(g)) g];
    final branches = [
      ...v.branches,
      if (b.isNotEmpty && !v.branches.contains(b)) b,
    ];
    return Card(
      key: Key('fu-stud-${s.id}'),
      child: Padding(
        padding: const EdgeInsets.all(PayeshTokens.space3),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(s.name, style: const TextStyle(fontWeight: FontWeight.bold)),
            if (s.contact.isNotEmpty)
              Text(s.contact, textDirection: TextDirection.ltr),
            Text('⚠️ ${s.reason}', key: Key('fu-reason-${s.id}')),
            const SizedBox(height: PayeshTokens.space2),
            Row(
              children: [
                Expanded(
                  child: DropdownButtonFormField<String>(
                    key: Key('fu-grade-${s.id}'),
                    initialValue: g.isEmpty ? '' : g,
                    isExpanded: true,
                    decoration: const InputDecoration(
                      labelText: 'پایه',
                      border: OutlineInputBorder(),
                    ),
                    items: [
                      const DropdownMenuItem(
                        value: '',
                        child: Text('— پایه —'),
                      ),
                      for (final x in grades)
                        DropdownMenuItem(value: x, child: Text(x)),
                    ],
                    onChanged: (x) => setState(() => _grade[s.id] = x ?? ''),
                  ),
                ),
                const SizedBox(width: PayeshTokens.space2),
                Expanded(
                  child: DropdownButtonFormField<String>(
                    key: Key('fu-branch-${s.id}'),
                    initialValue: b.isEmpty ? '' : b,
                    isExpanded: true,
                    decoration: const InputDecoration(
                      labelText: 'رشته',
                      border: OutlineInputBorder(),
                    ),
                    items: [
                      const DropdownMenuItem(
                        value: '',
                        child: Text('— رشته —'),
                      ),
                      for (final x in branches)
                        DropdownMenuItem(value: x, child: Text(x)),
                    ],
                    onChanged: (x) => setState(() => _branch[s.id] = x ?? ''),
                  ),
                ),
              ],
            ),
            const SizedBox(height: PayeshTokens.space2),
            Wrap(
              spacing: PayeshTokens.space2,
              children: [
                FilledButton(
                  key: Key('fu-assign-${s.id}'),
                  onPressed: c.busy ? null : () => c.assign(s.id, g, b),
                  child: const Text('ذخیره'),
                ),
                OutlinedButton(
                  key: Key('fu-ack-${s.id}'),
                  onPressed: c.busy ? null : () => c.ack(s.id),
                  child: const Text('حل شد (بی‌کلاس بماند)'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _issue(ImportIssue i) => Card(
    key: Key('fu-issue-${i.id}'),
    child: Padding(
      padding: const EdgeInsets.all(PayeshTokens.space3),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  i.name.isEmpty ? '—' : i.name,
                  style: const TextStyle(fontWeight: FontWeight.bold),
                ),
              ),
              StatusBadge(
                i.userId != null ? 'در سامانه هست' : 'ساخته نشده',
                key: Key('fu-issue-state-${i.id}'),
                tone: i.userId != null ? PayeshTone.success : PayeshTone.danger,
              ),
            ],
          ),
          if (i.nationalId.isNotEmpty || i.phone.isNotEmpty)
            Text(
              [i.nationalId, i.phone].where((x) => x.isNotEmpty).join(' · '),
              textDirection: TextDirection.ltr,
            ),
          for (final r in i.reasons.take(4)) Text('⚠️ $r'),
          Wrap(
            spacing: PayeshTokens.space2,
            children: [
              FilledButton.tonal(
                key: Key('fu-issue-fix-${i.id}'),
                onPressed: c.busy ? null : () => _fix(i),
                child: Text(i.userId != null ? 'اصلاح' : 'ساختن کاربر'),
              ),
              OutlinedButton(
                key: Key('fu-issue-done-${i.id}'),
                onPressed: c.busy ? null : () => c.issueDone(i.id),
                child: const Text('حل شد'),
              ),
            ],
          ),
        ],
      ),
    ),
  );

  @override
  Widget build(BuildContext context) => SchoolPage(
    prefix: 'fu',
    title: 'نیازمند پیگیری',
    controller: c,
    sync: widget.sync,
    onRetry: widget.onRetry,
    actions: [
      TextButton.icon(
        key: const Key('fu-import'),
        onPressed: _import,
        icon: const Icon(Icons.upload_file_outlined),
        label: const Text('ورود دسته‌ای'),
      ),
    ],
    body: ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final v = c.view;
        if (v == null) return const SizedBox.shrink();
        return ListView(
          padding: const EdgeInsets.all(PayeshTokens.space4),
          children: [
            Text(
              '${_fa(v.total)} مورد برای رسیدگی',
              key: const Key('fu-count'),
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const Text(
              'هر چیزی که کامل نیست اینجا جمع می‌شود: ردیف‌های ورود دسته‌ای که ساخته نشدند '
              'یا مشخصاتشان کامل نبود، و دانش‌آموزانی که پایه یا رشته‌شان کامل نیست. '
              'تا اینجا باشند جایی گم نمی‌شوند.',
            ),
            _title(
              'دانش‌آموزانی که پایه/رشته‌شان کامل نیست',
              '${_fa(v.students.length)} نفر',
              'fu-students-count',
            ),
            if (v.students.isEmpty)
              const Text(
                'پایه و رشتهٔ همهٔ دانش‌آموزان کامل است. ✅',
                key: Key('fu-students-none'),
              )
            else
              for (final s in v.students) _student(v, s),
            _title(
              'ردیف‌های ورود دسته‌ای',
              '${_fa(v.issues.length)} ردیف',
              'fu-issues-count',
            ),
            if (v.issues.isEmpty)
              const Text(
                'ردیف ناتمامی از ورود دسته‌ای نمانده. ✅',
                key: Key('fu-issues-none'),
              )
            else ...[
              for (final i in v.issues) _issue(i),
              const SizedBox(height: PayeshTokens.space2),
              FilledButton(
                key: const Key('fu-issues-clear'),
                onPressed: c.busy ? null : c.issuesClear,
                child: const Text('همه را حل‌شده کن'),
              ),
            ],
          ],
        );
      },
    ),
  );
}

// ─────────────────────────────── bulk import wizard ───────────────────────────────

class ImportController extends SchoolController {
  ImportController({
    required super.source,
    required super.role,
    required super.uid,
  });

  /// Reads the chosen file (tests replace it; production: the file system).
  static Future<Uint8List> Function(String path) readFile = (p) =>
      File(p).readAsBytes();

  int step = 1;
  String kind = 'students';
  final Set<String> grades = {};
  ImportSession? session;
  ImportReview? review;
  ImportResult? result;

  @override
  Future<void> read(SchoolRecords db) async {
    final s = session;
    if (step == 3 && s != null) review = await SchoolImport(db).check(s);
  }

  void setKind(String k) {
    kind = k;
    formError = null;
    emit();
  }

  void toggleGrade(String g) {
    if (!grades.remove(g)) grades.add(g);
    formError = null;
    emit();
  }

  /// Form `import-file`: a file path on this device, or pasted CSV text.
  Future<void> openFile(String path, String pasted) async {
    formError = null;
    final p = path.trim();
    if (kind == 'students' && grades.isEmpty) {
      formError = 'اول پایه را انتخاب کنید — بدون پایه، دانش‌آموز و کلاسش ساخته نمی‌شود';
      emit();
      return;
    }
    if (p.isEmpty && pasted.trim().isEmpty) {
      formError = 'فایلی انتخاب نشده';
      emit();
      return;
    }
    busy = true;
    emit();
    try {
      final SheetBook book;
      final String name;
      if (pasted.trim().isNotEmpty) {
        book = SheetReader.csv(pasted);
        name = 'متن چسبانده‌شده';
      } else {
        book = SheetReader.read(p, await readFile(p));
        name = p.split(RegExp(r'[\\/]')).last;
      }
      session = ImportSession.fromBook(
        book,
        kind: kind,
        fileName: name,
        grades: [
          for (final g in importGrades)
            if (grades.contains(g)) g,
        ],
      );
      step = 2;
    } on RecordFailure catch (e) {
      formError = e.messageFa;
    } on FileSystemException catch (e) {
      formError = 'فایل خوانده نشد: ${e.osError?.message ?? e.message}';
    }
    busy = false;
    emit();
  }

  void setMap(int col, String key) {
    session?.map[col] = key;
    emit();
  }

  Future<void> _check() async {
    final d = db;
    final s = session;
    if (d == null || s == null) return;
    try {
      review = await SchoolImport(d).check(s);
    } on RecordFailure catch (e) {
      error = e.messageFa;
    }
  }

  /// `import-check`: answers of a previous file are forgotten.
  Future<void> check() async {
    session?.branchAsk.clear();
    error = null;
    notice = null;
    step = 3;
    await _check();
    emit();
  }

  /// `imp-recheck`.
  Future<void> recheck() async {
    error = null;
    await _check();
    notice = 'دوباره بررسی شد';
    emit();
  }

  /// `imp-branch-yes` (to = the defined branch) / `imp-branch-no` (to = '').
  Future<void> answer(String from, String to) async {
    session?.branchAsk[from] = to;
    await _check();
    emit();
  }

  /// `import-back`.
  void back() {
    step = step > 1 ? step - 1 : 1;
    error = null;
    notice = null;
    emit();
  }

  /// Form `imp-fix`; true = the row is ready now.
  Future<bool> fix(ImportRow row, Map<String, String> values) async {
    session?.fix(row.idx, values);
    await _check();
    final now = review?.rows.where((r) => r.idx == row.idx).firstOrNull;
    final ok = now == null || now.ready;
    error = null;
    notice = now == null
        ? 'ذخیره شد'
        : ok
        ? 'اصلاح شد و به «آمادهٔ ثبت» رفت ✅'
        : 'ذخیره شد — هنوز ${_fa(now.errors.length + now.blocks.length)} مورد مانده';
    emit();
    return ok;
  }

  /// `import-apply`.
  Future<RecordWrite?> apply() {
    final s = session;
    final r = review;
    if (s == null || r == null) return Future.value();
    return run((db) async {
      final res = await SchoolImport(db).apply(s, r);
      result = res;
      step = 4;
      return RecordWrite(res.summaryFa, keys: res.keys);
    });
  }

  /// `import-open` again («فایل بعدی»).
  void restart() {
    step = 1;
    session = null;
    review = null;
    result = null;
    grades.clear();
    error = null;
    notice = null;
    formError = null;
    emit();
  }
}

class ImportScreen extends StatefulWidget {
  const ImportScreen({
    super.key,
    required this.controller,
    required this.sync,
    this.onRetry,
  });
  final ImportController controller;
  final ValueListenable<SyncStatus> sync;
  final VoidCallback? onRetry;

  @override
  State<ImportScreen> createState() => _ImportScreenState();
}

class _ImportScreenState extends State<ImportScreen> {
  ImportController get c => widget.controller;
  final path = TextEditingController();
  final pasted = TextEditingController();

  @override
  void initState() {
    super.initState();
    c.load();
  }

  @override
  void dispose() {
    path.dispose();
    pasted.dispose();
    super.dispose();
  }

  static const _steps = [
    'انتخاب فایل',
    'نگاشت ستون‌ها',
    'بررسی و خطاها',
    'ثبت نهایی',
  ];

  Widget _bar() => Padding(
    padding: const EdgeInsets.only(bottom: PayeshTokens.space3),
    child: Wrap(
      spacing: PayeshTokens.space2,
      children: [
        for (var i = 0; i < _steps.length; i++)
          Chip(
            key: Key('imp-step-${i + 1}'),
            avatar: CircleAvatar(child: Text(_fa(i + 1))),
            label: Text(_steps[i]),
            backgroundColor: i == c.step - 1
                ? Theme.of(context).colorScheme.primaryContainer
                : null,
          ),
      ],
    ),
  );

  List<Widget> _stepFile() => [
    DropdownButtonFormField<String>(
      key: const Key('imp-kind'),
      initialValue: c.kind,
      isExpanded: true,
      decoration: const InputDecoration(
        labelText: 'نوع اطلاعات',
        border: OutlineInputBorder(),
      ),
      items: [
        for (final MapEntry(:key, :value) in importKindFa.entries)
          DropdownMenuItem(value: key, child: Text(value)),
      ],
      onChanged: (v) => c.setKind(v ?? 'students'),
    ),
    if (c.kind == 'students') ...[
      const SizedBox(height: PayeshTokens.space3),
      const Text(
        'این فایل شامل چه پایه‌هایی است؟ اگر فقط یک پایه تیک بخورد، همان به همهٔ سطرهای بی‌پایه '
        'داده می‌شود؛ اگر چند پایه (فایل کل مدرسه)، دانش‌آموزِ بی‌پایه در «نیازمند پیگیری» می‌آید.',
      ),
      Wrap(
        spacing: PayeshTokens.space2,
        children: [
          for (final g in importGrades)
            FilterChip(
              key: Key('imp-grade-$g'),
              label: Text(g),
              selected: c.grades.contains(g),
              onSelected: (_) => c.toggleGrade(g),
            ),
        ],
      ),
      if (c.grades.isEmpty)
        Text(
          '⚠️ تا یک پایه انتخاب نکنید، مرحلهٔ بعد باز نمی‌شود — پایه برای ثبت دانش‌آموز لازم است.',
          key: const Key('imp-grade-hint'),
          style: TextStyle(color: context.tokens.warning),
        ),
    ],
    const SizedBox(height: PayeshTokens.space3),
    const Text(
      '✅ نیازی به قالب آماده نیست؛ همان فایل موجود مدرسه با هر ترتیب ستونی قابل استفاده است. '
      'ردیف تیتر خودکار تشخیص داده می‌شود؛ تاریخ شمسی، اعداد فارسی، معدلِ «۱۲/۸۸» و شماره‌های '
      'ناقص خودکار اصلاح یا گزارش می‌شوند.',
    ),
    const SizedBox(height: PayeshTokens.space3),
    SchoolField(
      'imp-path',
      'مسیر فایل اکسل (xlsx) یا CSV روی همین دستگاه',
      path,
    ),
    const SizedBox(height: PayeshTokens.space3),
    SchoolField(
      'imp-paste',
      'یا متن CSV را اینجا بچسبانید (از اکسل: انتخاب ← کپی)',
      pasted,
      lines: 4,
    ),
    if (c.formError != null)
      Padding(
        padding: const EdgeInsets.only(top: PayeshTokens.space2),
        child: Text(
          c.formError!,
          key: const Key('imp-form-error'),
          style: TextStyle(color: Theme.of(context).colorScheme.error),
        ),
      ),
    const SizedBox(height: PayeshTokens.space3),
    FilledButton(
      key: const Key('imp-next'),
      onPressed: c.busy || (c.kind == 'students' && c.grades.isEmpty)
          ? null
          : () => c.openFile(path.text, pasted.text),
      child: const Text('بعدی — نگاشت ستون‌ها'),
    ),
  ];

  List<Widget> _stepMap(ImportSession s) {
    final fields = importFields[s.kind]!;
    const order = [
      'first_name', 'last_name', 'full_name', 'national_id', 'phone', //
      'father_name', 'father_nid', 'father_phone', 'mother_name', 'mother_nid',
      'mother_phone',
      'guardian',
      'guardian_phone',
      'grade',
      'field',
      'class_name',
      'birth_date', 'gender',
    ];
    final ordered = [
      for (final k in order) ...fields.where((f) => f.$1 == k),
      ...fields.where((f) => !order.contains(f.$1)),
    ];
    return [
      Row(
        children: [
          Expanded(
            child: Text(
              '«${s.fileName}» — برگهٔ «${s.sheetName}» با ${_fa(s.rows.length)} سطر',
            ),
          ),
          StatusBadge(
            '${_fa(s.mapped)} ستون نگاشت شد',
            key: const Key('imp-mapped'),
            tone: PayeshTone.info,
          ),
        ],
      ),
      for (var i = 0; i < s.headers.length; i++)
        Padding(
          padding: const EdgeInsets.only(top: PayeshTokens.space3),
          child: DropdownButtonFormField<String>(
            key: Key('imp-map-$i'),
            initialValue: s.map[i],
            isExpanded: true,
            decoration: InputDecoration(
              labelText: s.headers[i],
              helperText: [
                for (final r in s.rows.take(2))
                  if (i < r.length && r[i].trim().isNotEmpty) r[i].trim(),
              ].join(' · '),
              border: const OutlineInputBorder(),
            ),
            items: [
              const DropdownMenuItem(value: '', child: Text('— نادیده بگیر —')),
              for (final (k, label, req, _) in ordered)
                DropdownMenuItem(
                  value: k,
                  child: Text(req ? '$label *' : label),
                ),
            ],
            onChanged: (v) => c.setMap(i, v ?? ''),
          ),
        ),
      const SizedBox(height: PayeshTokens.space3),
      Row(
        children: [
          OutlinedButton(
            key: const Key('imp-prev'),
            onPressed: c.back,
            child: const Text('مرحلهٔ قبل'),
          ),
          const SizedBox(width: PayeshTokens.space2),
          Expanded(
            child: FilledButton(
              key: const Key('imp-check'),
              onPressed: c.busy ? null : c.check,
              child: Text('بررسی ${_fa(s.rows.length)} سطر'),
            ),
          ),
        ],
      ),
    ];
  }

  Widget _msgs(ImportRow r, {bool warns = true}) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      for (final e in r.errors)
        Text(
          '⛔ $e',
          style: TextStyle(color: Theme.of(context).colorScheme.error),
        ),
      for (final b in r.blocks)
        Text('✏️ $b', style: TextStyle(color: context.tokens.warning)),
      if (warns)
        for (final w in r.warns)
          if (!r.blocks.contains(w)) Text('⚠️ $w'),
    ],
  );

  String _place(ImportRow r) => [
    SchoolRecords.str(r.data['grade']),
    SchoolRecords.str(r.data['field']),
  ].where((x) => x.isNotEmpty).join(' ');

  Future<void> _openFix(ImportRow r) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ImportFixPage(controller: c, row: r),
      ),
    );
  }

  List<Widget> _stepCheck(ImportReview r) {
    final ready = r.ready;
    final todo = r.todo;
    return [
      if (r.branchAsk.isNotEmpty)
        Card(
          key: const Key('imp-ask'),
          child: Padding(
            padding: const EdgeInsets.all(PayeshTokens.space3),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  '❓ ${_fa(r.branchAsk.length)} رشته نیاز به تأیید شما دارد',
                  style: const TextStyle(fontWeight: FontWeight.bold),
                ),
                const Text(
                  'این نام‌ها در فهرست رشته‌ها نیستند و فقط شبیه یک رشتهٔ موجود هستند. اگر اشتباه '
                  'تایپی است «بله» را بزنید تا زیر همان رشته ثبت شوند؛ اگر رشتهٔ جداست «نه» — هیچ '
                  'رشته‌ای خودبه‌خود ادغام نمی‌شود.',
                ),
                for (var i = 0; i < r.branchAsk.length; i++)
                  Padding(
                    padding: const EdgeInsets.only(top: PayeshTokens.space2),
                    child: Wrap(
                      spacing: PayeshTokens.space2,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        Text(
                          '«${r.branchAsk[i].$1}» شبیه «${r.branchAsk[i].$2}»',
                        ),
                        FilledButton(
                          key: Key('imp-ask-yes-$i'),
                          onPressed: () =>
                              c.answer(r.branchAsk[i].$1, r.branchAsk[i].$2),
                          child: Text('بله، همان «${r.branchAsk[i].$2}» است'),
                        ),
                        OutlinedButton(
                          key: Key('imp-ask-no-$i'),
                          onPressed: () => c.answer(r.branchAsk[i].$1, ''),
                          child: const Text('نه، رشتهٔ جداست'),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ),
      if (r.branchFixes.isNotEmpty)
        Text(
          '✍️ غلط تایپی اصلاح شد: ${r.branchFixes.map((f) => '«${f.$1}» ← ${f.$2}').join(' · ')}',
          key: const Key('imp-fixes'),
        ),
      Wrap(
        spacing: PayeshTokens.space2,
        runSpacing: PayeshTokens.space2,
        children: [
          StatusBadge(
            'کل ردیف‌ها: ${_fa(r.rows.length)}',
            key: const Key('imp-stat-total'),
          ),
          StatusBadge(
            'آمادهٔ ثبت: ${_fa(ready.length)}',
            key: const Key('imp-stat-ready'),
            tone: PayeshTone.success,
          ),
          StatusBadge(
            'نیازمند اصلاح: ${_fa(todo.length)}'
            '${r.badCount > 0 ? ' (${_fa(r.badCount)} ثبت‌نشدنی)' : ''}',
            key: const Key('imp-stat-todo'),
            tone: PayeshTone.danger,
          ),
          StatusBadge(
            'نیازمند پیگیری: ${_fa(r.followCount)}',
            key: const Key('imp-stat-follow'),
            tone: PayeshTone.warning,
          ),
        ],
      ),
      if (todo.isNotEmpty) ...[
        const SizedBox(height: PayeshTokens.space3),
        Row(
          children: [
            Expanded(
              child: Text(
                '✏️ ${_fa(todo.length)} ردیف تا اصلاح نشود ثبت نمی‌شود — همین‌جا درستش کنید',
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
            TextButton(
              key: const Key('imp-recheck'),
              onPressed: c.recheck,
              child: const Text('🔄 بررسی دوباره'),
            ),
          ],
        ),
        for (final t in todo.take(200))
          Card(
            key: Key('imp-todo-${t.idx}'),
            child: Padding(
              padding: const EdgeInsets.all(PayeshTokens.space3),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    'سطر ${_fa(t.row)} — ${t.name.isEmpty ? '—' : t.name}  ${_place(t)}',
                    style: const TextStyle(fontWeight: FontWeight.bold),
                  ),
                  _msgs(t, warns: false),
                  Align(
                    alignment: AlignmentDirectional.centerEnd,
                    child: FilledButton.tonal(
                      key: Key('imp-fix-${t.idx}'),
                      onPressed: () => _openFix(t),
                      child: const Text('اصلاح'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        if (todo.length > 200)
          const Text(
            '۲۰۰ ردیف اول نمایش داده شد؛ بقیه را بعد از ثبت از «نیازمند پیگیری» اصلاح کنید.',
          ),
      ],
      const SizedBox(height: PayeshTokens.space3),
      Text(
        '✅ ${_fa(ready.length)} ردیف آمادهٔ ثبت'
        '${r.updates > 0 ? ' — ${_fa(r.updates)} به‌روزرسانی' : ''}',
        key: const Key('imp-ready-count'),
        style: Theme.of(context).textTheme.titleMedium,
      ),
      if (r.newClasses.isNotEmpty)
        Text(
          '🏛️ کلاس‌های جدید ساخته می‌شوند: ${r.newClasses.join('، ')}',
          key: const Key('imp-newclasses'),
        ),
      if (r.phonesFixed > 0)
        Text(
          '☎️ صفرِ اولِ ${_fa(r.phonesFixed)} شمارهٔ همراه در فایل نبود — خودکار به قالب ۱۱ رقمی «09…» برگردانده شد.',
          key: const Key('imp-phones'),
        ),
      for (final x in ready.take(60))
        ListTile(
          key: Key('imp-ready-${x.idx}'),
          dense: true,
          title: Text(x.name.isEmpty ? '—' : x.name),
          subtitle: _msgs(x),
          trailing: Text(_place(x)),
        ),
      if (ready.length > 60)
        const Text('۶۰ ردیف اول نمایش داده شد؛ همهٔ آن‌ها ثبت می‌شوند.'),
      const SizedBox(height: PayeshTokens.space3),
      Row(
        children: [
          OutlinedButton(
            key: const Key('imp-prev'),
            onPressed: c.back,
            child: const Text('بازگشت به نگاشت'),
          ),
          const SizedBox(width: PayeshTokens.space2),
          Expanded(
            child: FilledButton(
              key: const Key('imp-apply'),
              onPressed: c.busy || ready.isEmpty ? null : c.apply,
              child: Text(
                ready.isEmpty
                    ? 'ردیفی برای ثبت نیست'
                    : 'ثبت ${_fa(ready.length)} ردیف',
              ),
            ),
          ),
        ],
      ),
      if (todo.isNotEmpty)
        Text(
          '${_fa(todo.length)} ردیف فعلاً ثبت نمی‌شود؛ اگر همین‌جا اصلاحش نکنید، پس از ثبت در '
          '«نیازمند پیگیری» می‌ماند.',
        ),
    ];
  }

  List<Widget> _stepDone(ImportResult r) => [
    const Center(child: Text('🎉', style: TextStyle(fontSize: 40))),
    Center(
      child: Text(
        'ورود اطلاعات کامل شد',
        style: Theme.of(context).textTheme.titleLarge,
      ),
    ),
    const SizedBox(height: PayeshTokens.space3),
    Text(r.summaryFa, key: const Key('imp-result')),
    if (c.session?.kind == 'students')
      Text(
        '🎓 دانش‌آموز: ${_fa(r.students)} · 👨‍👩‍👦 اولیا: ${_fa(r.parents)} · '
        '♻️ به‌روزرسانی: ${_fa(r.updated)} · 🏛️ کلاس تازه: ${_fa(r.classes)}',
        key: const Key('imp-result-detail'),
      ),
    if (r.errors.isNotEmpty)
      Text(
        '${_fa(r.errors.length)} ردیف ثبت نشد: '
        '${r.errors.take(8).map((e) => 'سطر ${_fa(e.$1)}: ${importErrorFa[e.$2] ?? e.$2}').join(' · ')}',
        key: const Key('imp-errors'),
        style: TextStyle(color: Theme.of(context).colorScheme.error),
      ),
    const Text(
      'نام کاربری هر نفر شمارهٔ همراه اوست و رمزش کد ملی؛ اگر کسی شمارهٔ همراه نداشت، نام کاربری‌اش '
      'کد ملی اوست. حساب‌ها پس از رسیدن به سیستم مدرسه فعال می‌شوند.',
    ),
    if (r.savedIssues > 0)
      Text(
        '🕒 ${_fa(r.savedIssues)} ردیف در «نیازمند پیگیری» ذخیره شد تا بعداً کامل شوند.',
        key: const Key('imp-saved'),
      ),
    if (r.openIssues > 0)
      Text(
        'در کل ${_fa(r.openIssues)} ردیف نیازمند پیگیری در فهرست مانده است.',
      ),
    const SizedBox(height: PayeshTokens.space3),
    Wrap(
      spacing: PayeshTokens.space2,
      alignment: WrapAlignment.center,
      children: [
        OutlinedButton(
          key: const Key('imp-again'),
          onPressed: () {
            path.clear();
            pasted.clear();
            c.restart();
          },
          child: const Text('فایل بعدی'),
        ),
        if (r.openIssues > 0)
          FilledButton.tonal(
            key: const Key('imp-issues-open'),
            onPressed: () => Navigator.maybePop(context),
            child: const Text('🕒 فهرست پیگیری'),
          ),
        FilledButton(
          key: const Key('imp-done'),
          onPressed: () => Navigator.maybePop(context),
          child: const Text('تمام'),
        ),
      ],
    ),
  ];

  @override
  Widget build(BuildContext context) => SchoolPage(
    prefix: 'imp',
    title: 'ورود دسته‌ای از اکسل',
    controller: c,
    sync: widget.sync,
    onRetry: widget.onRetry,
    body: ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final s = c.session;
        final r = c.review;
        final res = c.result;
        return ListView(
          padding: const EdgeInsets.all(PayeshTokens.space4),
          children: [
            _bar(),
            ...switch (c.step) {
              2 when s != null => _stepMap(s),
              3 when r != null => _stepCheck(r),
              4 when res != null => _stepDone(res),
              _ => _stepFile(),
            },
          ],
        );
      },
    ),
  );
}

/// Form `imp-fix` (web `impFixCardHtml`): correct one row in place, then everything is checked
/// again; the leading zero of a mobile is already filled in.
class ImportFixPage extends StatefulWidget {
  const ImportFixPage({super.key, required this.controller, required this.row});
  final ImportController controller;
  final ImportRow row;

  @override
  State<ImportFixPage> createState() => _ImportFixPageState();
}

class _ImportFixPageState extends State<ImportFixPage> {
  late final List<(String, String, bool)> fields =
      importFixFields[widget.controller.session?.kind ?? 'students']!;
  late final Map<String, TextEditingController> f = {
    for (final (k, _, _) in fields)
      k: TextEditingController(
        text: widget.controller.session?.fixValue(widget.row, k) ?? '',
      ),
  };

  @override
  void dispose() {
    for (final x in f.values) {
      x.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    await widget.controller.fix(widget.row, {
      for (final e in f.entries) e.key: e.value.text,
    });
    if (mounted) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final r = widget.row;
    return SchoolForm(
      prefix: 'imp-fix',
      title: 'سطر ${_fa(r.row)} — ${r.name.isEmpty ? '—' : r.name}',
      controller: widget.controller,
      submitLabel: '✔ ذخیره و بررسی دوباره',
      onSubmit: _save,
      fields: [
        for (final e in r.errors)
          Text(
            '⛔ $e',
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          ),
        for (final b in r.blocks) Text('✏️ $b'),
        for (final (k, label, numeric) in fields)
          SchoolField('imp-fix-f-$k', label, f[k]!, numeric: numeric),
        const Text(
          'صفرِ اولِ شماره‌ها خودکار گذاشته شده است؛ اگر یک رقم کم است، همین‌جا کاملش کنید.',
        ),
      ],
    );
  }
}
