// Row 194 — «ورود دسته‌ای از اکسل», a faithful copy of the p2 wizard (rezaa2544/p2
// src/js/34-excel-import.js `viewImport`, `impRulesCard`, `impCapTable`, `impManualBlock`):
//   * the four steps on top, joined by arrows; a finished step turns green and points on;
//   * step 1 — «📄 فایل اطلاعات مدرسه را انتخاب کنید»: the kind, the dashed drop zone whose
//     «انتخاب فایل» opens the SYSTEM file dialog, the three ✅ notes and «⚙️ قواعد کلاس‌بندی
//     خودکار»; the پایه list is the school's own (defined by the manager), never 1–12;
//   * step 2 — «🔗 هر ستون فایل به کدام فیلد سامانه است؟»: column / sample / field, mapped rows
//     green;
//   * step 3 — the stat cards, «📊 نتیجهٔ کلاس‌بندی پیش از ثبت», «🖐️ نیازمند بررسی دستی»
//     (explicit capacity raise) and «بررسی ردیف‌به‌ردیف» (plus the native in-place fixes);
//   * step 4 — «🎉 ورود اطلاعات کامل شد» with the four result cards.
// Every write stays local-first through SchoolImport (queue first, then the local copy).
import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:payesh_core/io.dart' show File, FileSystemException;
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../platform/file_pick.dart';
import '../pulse/web.dart';
import '../school/school_source.dart';
import 'followup_screen.dart' show ImportFixPage;

String _fa(int n) => n.toString().replaceAllMapped(
  RegExp('[0-9]'),
  (m) => '۰۱۲۳۴۵۶۷۸۹'[int.parse(m[0]!)],
);

class ImportController extends SchoolController {
  ImportController({
    required super.source,
    required super.role,
    required super.uid,
  });

  /// Reads a file by path (tests replace it; production: the file system).
  static Future<Uint8List> Function(String path) readFile = (p) =>
      File(p).readAsBytes();

  /// «انتخاب فایل»: the system file dialog (tests replace it).
  static Future<PickedFile?> Function() pickFile = pickSystemFile;

  int step = 1;
  String kind = 'students';
  final Set<String> grades = {};
  ImportSession? session;
  ImportReview? review;
  ImportResult? result;

  /// The پایه‌ها the manager defined (کلاس‌ها ← پایه‌ها), in their order — the wizard offers
  /// only these (row 194).
  List<String> definedGrades = const [];

  /// Row 202: the رشته‌ها the manager defined — a column of the file without a title is a
  /// رشته when its values are these (or common branch names).
  List<String> definedBranches = const [];

  /// Row 202 (owner: «موقع ثبت نهایی برنامه قفل می‌شود»): progress of `imp-apply` —
  /// stage `prepare` (rows of the file) then `write` (records saved), done of total.
  String progStage = '';
  int progDone = 0;
  int progTotal = 0;

  /// p2 `placeSettings` / `isMixedSchool`.
  PlaceRules rules = const PlaceRules();
  bool mixed = true;
  String schoolGender = '';

  @override
  Future<void> read(SchoolRecords db) async {
    final defs = <(int, String)>[];
    final lookups = await db.allOrEmpty('lookups');
    definedBranches = [
      for (final l in lookups)
        if (l.data['kind'] == 'branch' &&
            SchoolRecords.str(l.data['name']).trim().isNotEmpty)
          SchoolRecords.str(l.data['name']).trim(),
    ];
    for (final l in lookups) {
      if (l.data['kind'] != 'grade') continue;
      final n = SchoolRecords.str(l.data['name']).trim();
      if (n.isEmpty || defs.any((d) => d.$2 == n)) continue;
      defs.add((SchoolRecords.asInt(l.data['order']) ?? 999, n));
    }
    if (defs.isEmpty) {
      for (final c in await db.allOrEmpty('classes')) {
        final g = SchoolRecords.str(c.data['grade']).trim();
        if (g.isNotEmpty && !defs.any((d) => d.$2 == g)) defs.add((999, g));
      }
    }
    defs.sort((a, b) {
      final o = a.$1.compareTo(b.$1);
      if (o != 0) return o;
      final l = gradeLevel(a.$2).compareTo(gradeLevel(b.$2));
      return l != 0 ? l : a.$2.compareTo(b.$2);
    });
    definedGrades = [for (final d in defs) d.$2];
    grades.removeWhere((g) => !definedGrades.contains(g));
    final school = (await db.get('schools', 1))?.data ?? const {};
    schoolGender = SchoolRecords.str(school['gender']);
    mixed = importMixedSchool(school['gender']);
    rules = PlaceRules.of(school['place_rules'], mixed: mixed);
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

  String? _gradeGate() {
    if (kind != 'students') return null;
    if (definedGrades.isEmpty) {
      return 'هنوز پایه‌ای تعریف نشده — اول در «کلاس‌ها» پایه‌های مدرسه را تعریف کنید';
    }
    if (grades.isEmpty) {
      return 'اول پایه را انتخاب کنید — بدون پایه، دانش‌آموز و کلاسش ساخته نمی‌شود';
    }
    return null;
  }

  void _open(SheetBook book, String name) {
    session = ImportSession.fromBook(
      book,
      kind: kind,
      fileName: name,
      grades: [
        for (final g in definedGrades)
          if (grades.contains(g)) g,
      ],
      branches: definedBranches,
    );
    step = 2;
  }

  /// «انتخاب فایل»: the system dialog, then straight to «نگاشت ستون‌ها».
  Future<void> chooseFile() async {
    formError = _gradeGate();
    if (formError != null || busy) {
      emit();
      return;
    }
    busy = true;
    emit();
    try {
      final f = await pickFile();
      if (f != null) _open(SheetReader.read(f.name, f.bytes), f.name);
    } on FilePickFailure catch (e) {
      formError = e.messageFa;
    } on RecordFailure catch (e) {
      formError = e.messageFa;
    } on FileSystemException catch (e) {
      formError = 'فایل خوانده نشد: ${e.osError?.message ?? e.message}';
    }
    busy = false;
    emit();
  }

  /// A file path on this device, or pasted CSV text (the other way in).
  Future<void> openFile(String path, String pasted) async {
    formError = _gradeGate();
    if (formError != null) {
      emit();
      return;
    }
    final p = path.trim();
    if (p.isEmpty && pasted.trim().isEmpty) {
      formError = 'فایلی انتخاب نشده';
      emit();
      return;
    }
    busy = true;
    emit();
    try {
      if (pasted.trim().isNotEmpty) {
        _open(SheetReader.csv(pasted), 'متن چسبانده‌شده');
      } else {
        _open(
          SheetReader.read(p, await readFile(p)),
          p.split(RegExp(r'[\\/]')).last,
        );
      }
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

  /// `imp-preview`: answers of a previous file are forgotten.
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

  /// Row 201 «همهٔ رشته‌های تازه اضافه شوند».
  Future<void> answerAll(List<(String, String)> answers) async {
    for (final (from, to) in answers) {
      session?.branchAsk[from] = to;
    }
    await _check();
    emit();
  }

  /// `imp-back`.
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

  /// p2 `place-rules-save`.
  Future<RecordWrite?> saveRules(PlaceRules r) =>
      run((db) => SchoolImport(db).savePlaceRules(r));

  /// p2 `imp-raise-cap` — the preview is built again with the new capacity.
  Future<RecordWrite?> raiseCap(int classId, String raw) {
    final n = int.tryParse(SchoolRecords.digitsOnly(raw));
    return run((db) => SchoolImport(db).raiseCapacity(classId, n ?? 0));
  }

  /// `imp-commit`.
  Future<RecordWrite?> apply() async {
    final s = session;
    final r = review;
    if (s == null || r == null) return null;
    progStage = 'prepare';
    progDone = 0;
    progTotal = r.ready.length;
    final pending = run((db) async {
      final res = await SchoolImport(
        db,
        onProgress: (stage, done, total) {
          progStage = stage;
          progDone = done;
          progTotal = total;
          emit();
        },
      ).apply(s, r);
      result = res;
      step = 4;
      return RecordWrite(res.summaryFa, keys: res.keys);
    });
    // after the reading again of run(): «در حال ثبت» closes on the result (or the refusal)
    final w = await pending;
    progStage = '';
    emit();
    return w;
  }

  /// `imp-reset` («ورود فایل دیگر»).
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
  final pasted = TextEditingController();
  final Map<int, TextEditingController> caps = {};
  PlaceRules? draftRules;

  @override
  void initState() {
    super.initState();
    c.load();
  }

  @override
  void dispose() {
    pasted.dispose();
    for (final x in caps.values) {
      x.dispose();
    }
    super.dispose();
  }

  static const _steps = [
    'انتخاب فایل',
    'نگاشت ستون‌ها',
    'بررسی و خطاها',
    'ثبت نهایی',
  ];

  /// p2 `barTop`, row 194: boxes joined by arrows; a finished step is green.
  Widget _bar() {
    final cur = c.step - 1;
    Widget box(int i) {
      final done = i < cur || (c.step == 4 && i == 3);
      final now = i == cur && !done;
      final bg = done ? Web.greenBg : (now ? Web.card : Web.soft);
      final edge = done ? Web.green : (now ? Web.primary : Web.line);
      final dot = done ? Web.green : (now ? Web.primary : Web.line);
      return Container(
        key: Key('imp-step-${i + 1}'),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
        decoration: BoxDecoration(
          color: bg,
          border: Border.all(color: edge, width: now || done ? 1.6 : 1),
          borderRadius: BorderRadius.circular(Web.radius),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 26,
              height: 26,
              alignment: Alignment.center,
              decoration: BoxDecoration(color: dot, shape: BoxShape.circle),
              child: Text(
                done ? '✓' : _fa(i + 1),
                key: done ? Key('imp-step-${i + 1}-done') : null,
                style: TextStyle(
                  fontWeight: FontWeight.w800,
                  fontSize: 12.5,
                  color: done || now ? Colors.white : Web.muted,
                ),
              ),
            ),
            const SizedBox(width: 8),
            Flexible(
              child: Text(
                _steps[i],
                style: Web.small.copyWith(
                  fontWeight: FontWeight.w800,
                  color: done ? Web.green : (now ? Web.primary : Web.muted),
                ),
              ),
            ),
          ],
        ),
      );
    }

    Widget arrow(int i, {required bool down}) {
      final done = i < cur || c.step == 4;
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
        child: Icon(
          down ? Icons.arrow_downward : Icons.arrow_forward,
          key: Key('imp-arrow-${i + 1}'),
          size: 20,
          color: done ? Web.green : Web.line,
        ),
      );
    }

    return WebCard(
      child: LayoutBuilder(
        builder: (context, box0) {
          if (box0.maxWidth >= 620) {
            return Row(
              children: [
                for (var i = 0; i < 4; i++) ...[
                  Expanded(child: box(i)),
                  if (i < 3) arrow(i, down: false),
                ],
              ],
            );
          }
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (var i = 0; i < 4; i++) ...[
                box(i),
                if (i < 3) Center(child: arrow(i, down: true)),
              ],
            ],
          );
        },
      ),
    );
  }

  Widget _error() => c.formError == null
      ? const SizedBox.shrink()
      : Padding(
          padding: const EdgeInsets.only(top: 10),
          child: Text(
            c.formError!,
            key: const Key('imp-form-error'),
            style: TextStyle(color: Web.red),
          ),
        );

  List<Widget> _stepFile() {
    final blocked =
        c.kind == 'students' && (c.grades.isEmpty || c.definedGrades.isEmpty);
    return [
      WebCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const WebCardHead(
              icon: '📄',
              title: 'فایل اطلاعات مدرسه را انتخاب کنید',
            ),
            WebField(
              label: 'نوع اطلاعات',
              child: FieldBox(
                width: kFieldText,
                child: DropdownButtonFormField<String>(
                  key: const Key('imp-kind'),
                  initialValue: c.kind,
                  isExpanded: true,
                  decoration: webInput(),
                  items: [
                    for (final MapEntry(:key, :value) in importKindFa.entries)
                      DropdownMenuItem(value: key, child: Text(value)),
                  ],
                  onChanged: (v) => c.setKind(v ?? 'students'),
                ),
              ),
            ),
            if (c.kind == 'students') ...[
              Text(
                'این فایل شامل چه پایه‌هایی است؟',
                style: Web.b.copyWith(fontSize: 13),
              ),
              const SizedBox(height: 4),
              Text(
                'فقط پایه‌هایی که در «کلاس‌ها» تعریف کرده‌اید. اگر یک پایه تیک بخورد، همان به '
                'همهٔ سطرهای بی‌پایه داده می‌شود؛ اگر چند پایه (فایل کل مدرسه)، دانش‌آموزِ بی‌پایه '
                'در «نیازمند پیگیری» می‌آید.',
                style: Web.small.copyWith(color: Web.muted),
              ),
              const SizedBox(height: 8),
              if (c.definedGrades.isEmpty)
                Text(
                  '⚠️ هنوز پایه‌ای تعریف نشده — اول در «کلاس‌ها» پایه‌های مدرسه را تعریف کنید.',
                  key: const Key('imp-grade-none'),
                  style: TextStyle(color: Web.amber),
                )
              else
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    for (final g in c.definedGrades)
                      FilterChip(
                        key: Key('imp-grade-$g'),
                        label: Text(g),
                        selected: c.grades.contains(g),
                        onSelected: (_) => c.toggleGrade(g),
                      ),
                  ],
                ),
              if (c.definedGrades.isNotEmpty && c.grades.isEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(
                    '⚠️ تا یک پایه انتخاب نکنید، فایل باز نمی‌شود — پایه برای ثبت دانش‌آموز لازم است.',
                    key: const Key('imp-grade-hint'),
                    style: TextStyle(color: Web.amber),
                  ),
                ),
            ],
            const SizedBox(height: 14),
            // p2: the dashed drop zone with the file input
            CustomPaint(
              painter: _DashedBox(color: Web.line, radius: 14),
              child: Container(
                key: const Key('imp-drop'),
                padding: const EdgeInsets.symmetric(
                  vertical: 30,
                  horizontal: 16,
                ),
                decoration: BoxDecoration(
                  color: Web.soft,
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Column(
                  children: [
                    const Text('📊', style: TextStyle(fontSize: 40)),
                    const SizedBox(height: 10),
                    Text(
                      'فایل را انتخاب کنید',
                      style: Web.b.copyWith(fontSize: 14),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'فرمت‌های xlsx و csv',
                      style: Web.small.copyWith(color: Web.muted),
                    ),
                    const SizedBox(height: 12),
                    WebBtn(
                      c.busy ? 'در حال باز کردن…' : '📂 انتخاب فایل',
                      key: const Key('imp-pick'),
                      kind: WebBtnKind.primary,
                      size: WebBtnSize.normal,
                      onPressed: c.busy || blocked ? null : c.chooseFile,
                    ),
                  ],
                ),
              ),
            ),
            _error(),
            const SizedBox(height: 14),
            Text(
              '✅ نیازی به قالب آماده نیست؛ همان فایل موجود مدرسه با هر ترتیب ستونی قابل استفاده است.\n'
              '✅ ردیف‌های تیتر خودکار تشخیص داده می‌شوند و ستون‌ها هوشمند نگاشت می‌شوند.\n'
              '✅ تاریخ شمسی، اعداد فارسی و شماره‌های ناقص خودکار اصلاح یا گزارش می‌شوند.',
              style: Web.small.copyWith(color: Web.muted, height: 2),
            ),
            const SizedBox(height: 10),
            const Divider(height: 1),
            const SizedBox(height: 10),
            Text(
              'راه دیگر: متن CSV را بچسبانید (از اکسل: انتخاب ← کپی)',
              style: Web.small.copyWith(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 6),
            SchoolField('imp-paste', 'متن CSV', pasted, lines: 3),
            const SizedBox(height: 8),
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: WebBtn(
                'بعدی — نگاشت ستون‌ها',
                key: const Key('imp-next'),
                onPressed: c.busy || blocked
                    ? null
                    : () => c.openFile('', pasted.text),
              ),
            ),
          ],
        ),
      ),
      if (c.kind == 'students') _rulesCard(),
    ];
  }

  /// p2 `impRulesCard`.
  Widget _rulesCard() {
    final r = draftRules ?? c.rules;
    Widget chk(
      String id,
      bool on,
      String label,
      String hint,
      ValueChanged<bool>? onChanged,
    ) => Opacity(
      opacity: onChanged == null ? .55 : 1,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 10),
        decoration: BoxDecoration(
          border: Border(bottom: BorderSide(color: Web.line)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Checkbox(
              key: Key('imp-$id'),
              value: on,
              onChanged: onChanged == null
                  ? null
                  : (v) => onChanged(v ?? false),
            ),
            const SizedBox(width: 6),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(label, style: Web.b.copyWith(fontSize: 13)),
                  const SizedBox(height: 2),
                  Text(
                    hint,
                    style: Web.small.copyWith(color: Web.muted, height: 1.9),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
    void set(PlaceRules x) => setState(() => draftRules = x);
    return WebCard(
      key: const Key('imp-rules'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const WebCardHead(icon: '⚙️', title: 'قواعد کلاس‌بندی خودکار'),
          chk(
            'pr-auto',
            r.autoDistribute,
            'توزیع خودکار میان شعبه‌ها',
            'اگر فایل فقط «دهم تجربی» بنویسد و مدرسه چند شعبه داشته باشد، دانش‌آموز به '
                'کم‌جمعیت‌ترین شعبهٔ دارای جا می‌رود. شعبه‌ای که در فایل صریح آمده همیشه محترم است.',
            (v) => set(
              PlaceRules(
                autoDistribute: v,
                separateGender: r.separateGender,
                keepSiblings: r.keepSiblings,
              ),
            ),
          ),
          chk(
            'pr-gender',
            r.separateGender,
            'تفکیک جنسیتی شعبه‌ها',
            c.mixed
                ? 'دانش‌آموز به شعبه‌ای با جنسیت غالب مخالف فرستاده نمی‌شود. کلاس خالی جنسیت ندارد و '
                      'همه‌کس می‌تواند برود.'
                : 'این مدرسه ${c.schoolGender.isEmpty ? 'تک‌جنسیتی' : c.schoolGender} است و همهٔ '
                      'دانش‌آموزانش یک جنسیت دارند؛ این قاعده اینجا بی‌اثر است.',
            c.mixed
                ? (v) => set(
                    PlaceRules(
                      autoDistribute: r.autoDistribute,
                      separateGender: v,
                      keepSiblings: r.keepSiblings,
                    ),
                  )
                : null,
          ),
          chk(
            'pr-sib',
            r.keepSiblings,
            'خواهر و برادر هم‌کلاس شوند',
            'تشخیص فقط از روی کد ملی پدر یا مادر است، نه نام خانوادگی. تنها در همان پایه اعمال '
                'می‌شود و اگر شعبه پر باشد، ظرفیت مقدم است.',
            (v) => set(
              PlaceRules(
                autoDistribute: r.autoDistribute,
                separateGender: r.separateGender,
                keepSiblings: v,
              ),
            ),
          ),
          const SizedBox(height: 12),
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: WebBtn(
              'ذخیرهٔ قواعد',
              key: const Key('imp-rules-save'),
              onPressed: c.busy
                  ? null
                  : () async {
                      final w = await c.saveRules(r);
                      if (w != null && mounted) {
                        setState(() => draftRules = null);
                      }
                    },
            ),
          ),
        ],
      ),
    );
  }

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
      WebCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            WebCardHead(
              icon: '🔗',
              title: 'هر ستون فایل به کدام فیلد سامانه است؟',
              actions: [
                StatusBadge(
                  '${_fa(s.mapped)} ستون نگاشت شد',
                  key: const Key('imp-mapped'),
                  tone: PayeshTone.info,
                ),
              ],
            ),
            Text(
              '«${s.fileName}» — برگهٔ «${s.sheetName}» با ${_fa(s.rows.length)} سطر',
              style: Web.small.copyWith(color: Web.muted),
            ),
            if (s.detected.any((i) => s.map[i].isNotEmpty))
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  '🤖 ${_fa(s.detected.where((i) => s.map[i].isNotEmpty).length)} ستونِ بی‌عنوان یا '
                  'ناآشنا از روی داده‌هایش شناخته شد (رشته، سرپرست، محل سکونت، کد ملی، موبایل، …) — '
                  'یک نگاه بیندازید و اگر جایی درست نیست، همان‌جا عوضش کنید.',
                  key: const Key('imp-auto-note'),
                  style: Web.small.copyWith(color: Web.muted),
                ),
              ),
            const SizedBox(height: 8),
            WebTable(
              head: const ['ستون فایل', 'نمونه داده', 'فیلد سامانه'],
              rowColor: (i) => s.map[i].isNotEmpty ? Web.greenBg : null,
              rows: [
                for (var i = 0; i < s.headers.length; i++)
                  [
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(s.headers[i], style: Web.b.copyWith(fontSize: 13)),
                        if (s.detected.contains(i) && s.map[i].isNotEmpty)
                          Text(
                            '🤖 از روی محتوا',
                            key: Key('imp-auto-$i'),
                            style: Web.small.copyWith(color: Web.muted),
                          ),
                      ],
                    ),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 260),
                      child: Text(() {
                        final x = [
                          for (final r in s.rows.take(2))
                            if (i < r.length && r[i].trim().isNotEmpty)
                              r[i].trim(),
                        ].join(' · ');
                        return x.isEmpty ? '—' : x;
                      }(), style: Web.small.copyWith(color: Web.muted)),
                    ),
                    FieldBox(
                      width: kFieldDigits,
                      child: DropdownButtonFormField<String>(
                        key: Key('imp-map-$i'),
                        initialValue: s.map[i],
                        isExpanded: true,
                        decoration: webInput(),
                        items: [
                          const DropdownMenuItem(
                            value: '',
                            child: Text('— نادیده بگیر —'),
                          ),
                          for (final (k, label, req, _) in ordered)
                            DropdownMenuItem(
                              value: k,
                              child: Text(req ? '$label *' : label),
                            ),
                        ],
                        onChanged: (v) => c.setMap(i, v ?? ''),
                      ),
                    ),
                  ],
              ],
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                WebBtn(
                  'بازگشت',
                  key: const Key('imp-prev'),
                  kind: WebBtnKind.ghost,
                  onPressed: c.back,
                ),
                WebBtn(
                  'بررسی داده‌ها ←',
                  key: const Key('imp-check'),
                  kind: WebBtnKind.primary,
                  onPressed: c.busy ? null : c.check,
                ),
              ],
            ),
          ],
        ),
      ),
    ];
  }

  Widget _msgs(ImportRow r, {bool warns = true}) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      for (final e in r.errors)
        Text('⛔ $e', style: Web.small.copyWith(color: Web.red)),
      for (final b in r.blocks)
        Text('✏️ $b', style: Web.small.copyWith(color: Web.amber)),
      if (warns)
        for (final w in r.warns)
          if (!r.blocks.contains(w))
            Text('⚠️ $w', style: Web.small.copyWith(color: Web.muted)),
    ],
  );

  String _place(ImportRow r) => [
    SchoolRecords.str(r.data['grade']),
    SchoolRecords.str(r.data['field']),
  ].where((x) => x.isNotEmpty).join(' ');

  /// Row 202: «ثبت نهایی» with a window that says what is happening and how far it is —
  /// the screen no longer looks frozen while hundreds of students are saved.
  Future<void> _applyWithProgress() async {
    final nav = Navigator.of(context);
    var open = true;
    unawaited(
      showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (_) => PopScope(
          canPop: false,
          child: ListenableBuilder(
            listenable: c,
            builder: (context, _) {
              final t = c.progTotal;
              final d = c.progDone.clamp(0, t > 0 ? t : 0);
              final writing = c.progStage == 'write';
              final kind = c.session?.kind ?? 'students';
              final who = switch (kind) {
                'teachers' => 'دبیران',
                'grades' => 'نمره‌ها',
                'attendance' => 'حضور و غیاب',
                _ => 'دانش‌آموزان و اولیا',
              };
              return AlertDialog(
                key: const Key('imp-progress'),
                title: Text(
                  writing ? 'در حال ثبت $who…' : 'در حال آماده‌سازی ردیف‌ها…',
                ),
                content: SizedBox(
                  width: 380,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      LinearProgressIndicator(
                        value: t > 0 ? d / t : null,
                        minHeight: 8,
                      ),
                      const SizedBox(height: 12),
                      Text(
                        t == 0
                            ? 'لطفاً صبر کنید…'
                            : writing
                            ? '${_fa(d)} از ${_fa(t)} رکورد ثبت شد'
                            : '${_fa(d)} از ${_fa(t)} ردیف خوانده و آماده شد',
                        key: const Key('imp-progress-text'),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'برنامه را نبندید؛ چند لحظه بیشتر طول نمی‌کشد.',
                        style: Web.small.copyWith(color: Web.muted),
                      ),
                    ],
                  ),
                ),
              );
            },
          ),
        ),
      ).whenComplete(() => open = false),
    );
    try {
      await c.apply();
    } finally {
      if (open && mounted) nav.pop();
    }
  }

  Future<void> _openFix(ImportRow r) async {
    await openPanel<void>(context, (_) => ImportFixPage(controller: c, row: r));
  }

  Widget _stat(String icon, String n, String label, Color color, Key key) =>
      WebStat(icon: icon, num: n, label: label, numKey: key, numColor: color);

  /// p2 `impCapTable`.
  Widget _capTable(ImportReview r) {
    final over = r.capRows.where((x) => x.over).length;
    return WebCard(
      key: const Key('imp-cap'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          WebCardHead(
            icon: '📊',
            title: 'نتیجهٔ کلاس‌بندی پیش از ثبت',
            actions: [
              if (r.autoCount > 0)
                WebBadge(
                  '${_fa(r.autoCount)} نفر خودکار',
                  tone: WebTone.purple,
                ),
              if (over > 0)
                WebBadge(
                  '${_fa(over)} کلاس فراتر از ظرفیت',
                  key: const Key('imp-cap-over'),
                  tone: WebTone.red,
                ),
            ],
          ),
          WebTable(
            head: const ['کلاس', 'اکنون', 'افزوده', 'مجموع', 'ظرفیت', 'وضعیت'],
            rowColor: (i) => r.capRows[i].over ? Web.redBg : null,
            rows: [
              for (final x in r.capRows)
                () {
                  final pct = x.cap > 0 ? (x.after * 100 / x.cap).round() : 0;
                  final col = x.over
                      ? Web.red
                      : (pct > 90 ? Web.amber : Web.primary);
                  return [
                    Text(x.name, style: Web.b.copyWith(fontSize: 13)),
                    Text(_fa(x.before), style: TextStyle(color: Web.muted)),
                    Text(
                      '+${_fa(x.added)}',
                      style: TextStyle(
                        color: Web.primary,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    Text(
                      _fa(x.after),
                      key: Key('imp-cap-after-${x.id}'),
                      style: TextStyle(color: col, fontWeight: FontWeight.w800),
                    ),
                    Text(_fa(x.cap), style: TextStyle(color: Web.muted)),
                    x.over
                        ? const WebBadge('فراتر از ظرفیت', tone: WebTone.red)
                        : SizedBox(
                            width: 120,
                            child: ClipRRect(
                              borderRadius: BorderRadius.circular(99),
                              child: LinearProgressIndicator(
                                value: math.min(100, pct) / 100,
                                minHeight: 7,
                                color: col,
                                backgroundColor: Web.track,
                              ),
                            ),
                          ),
                  ];
                }(),
            ],
          ),
          if (over > 0)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Text(
                '⛔ مجموع این کلاس‌ها از ظرفیت رد شده است. پیش از ثبت، ظرفیت را اصلاح کنید یا '
                'ردیف‌ها را جابه‌جا کنید.',
                style: Web.small.copyWith(color: Web.red),
              ),
            ),
        ],
      ),
    );
  }

  /// p2 `impManualBlock`: all sections full — no class is made, the capacity is not ignored;
  /// the other rows are saved as usual.
  Widget _manualBlock(ImportReview r) {
    final seen = <int>{};
    final cls = [
      for (final m in r.manualRows)
        for (final x in m.candidates)
          if (seen.add(x.id)) x,
    ];
    return Container(
      key: const Key('imp-manual'),
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(
        border: Border.all(color: Web.red),
        borderRadius: BorderRadius.circular(Web.radius),
      ),
      child: WebCard(
        margin: EdgeInsets.zero,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            WebCardHead(
              icon: '🖐️',
              title: 'نیازمند بررسی دستی',
              actions: [
                WebBadge('${_fa(r.manualRows.length)} ردیف', tone: WebTone.red),
              ],
            ),
            Text(
              'همهٔ شعبه‌های این پایه پر هستند. سامانه عمداً نه کلاس تازه ساخته و نه ظرفیت را '
              'نادیده گرفته است.\n✅ بقیهٔ ردیف‌ها بدون مشکل ثبت می‌شوند؛ این‌ها کنار گذاشته '
              'می‌شوند (در «نیازمند پیگیری» می‌مانند).',
              style: Web.small.copyWith(color: Web.muted, height: 2),
            ),
            const SizedBox(height: 8),
            WebTable(
              head: const ['#', 'نام', 'کلاس درخواستی', 'وضعیت شعبه‌ها'],
              rows: [
                for (final m in r.manualRows.take(100))
                  [
                    Text(_fa(m.row)),
                    Text(
                      m.name.isEmpty ? '—' : m.name,
                      style: Web.b.copyWith(fontSize: 13),
                    ),
                    Text(m.wanted.isEmpty ? '—' : m.wanted),
                    Text(
                      m.candidates
                          .map((x) => '${x.name} ${_fa(x.n)}/${_fa(x.cap)}')
                          .join(' · '),
                      style: Web.small.copyWith(color: Web.muted),
                    ),
                  ],
              ],
            ),
            const SizedBox(height: 10),
            Text('افزایش ظرفیت کلاس', style: Web.b.copyWith(fontSize: 13)),
            Padding(
              padding: const EdgeInsets.only(top: 6, bottom: 10),
              child: Text(
                'ظرفیت تازه را صریح وارد کنید؛ سامانه خودش آن را بالا نمی‌برد.',
                style: Web.small.copyWith(color: Web.muted),
              ),
            ),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final x in cls)
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 6,
                    ),
                    decoration: BoxDecoration(
                      border: Border.all(color: Web.line),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(x.name, style: Web.b.copyWith(fontSize: 12.5)),
                        const SizedBox(width: 6),
                        Text(
                          '${_fa(x.n)}/${_fa(x.cap)}',
                          style: Web.small.copyWith(color: Web.muted),
                        ),
                        const SizedBox(width: 6),
                        FieldBox(
                          width: kFieldTiny,
                          child: TextField(
                            key: Key('imp-cap-in-${x.id}'),
                            controller: caps.putIfAbsent(
                              x.id,
                              () => TextEditingController(text: '${x.cap}'),
                            ),
                            keyboardType: TextInputType.number,
                            decoration: webInput(),
                          ),
                        ),
                        const SizedBox(width: 6),
                        WebBtn(
                          'ثبت',
                          key: Key('imp-cap-save-${x.id}'),
                          size: WebBtnSize.xs,
                          onPressed: c.busy
                              ? null
                              : () => c.raiseCap(x.id, caps[x.id]!.text),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  /// Row 201: one asked branch — «بله» (when there is a guess), «نه / تازه است», or the
  /// right branch picked from the school's list.
  Widget _askRow(
    ImportReview r,
    String from,
    String text, {
    (String, String, String)? yes,
    required String noLabel,
    required String noKey,
    required String pickKey,
  }) {
    final picks = [
      for (final b in r.branchChoices)
        if (b != yes?.$3) b,
    ];
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Wrap(
        spacing: 8,
        runSpacing: 6,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Text(text, style: const TextStyle(fontWeight: FontWeight.w600)),
          if (yes != null)
            WebBtn(
              yes.$1,
              key: Key(yes.$2),
              kind: WebBtnKind.primary,
              onPressed: c.busy ? null : () => c.answer(from, yes.$3),
            ),
          WebBtn(
            noLabel,
            key: Key(noKey),
            kind: WebBtnKind.ghost,
            onPressed: c.busy ? null : () => c.answer(from, ''),
          ),
          if (picks.isNotEmpty)
            PopupMenuButton<String>(
              key: Key(pickKey),
              tooltip: 'رشتهٔ درست را انتخاب کنید',
              onSelected: (b) => c.answer(from, b),
              itemBuilder: (_) => [
                for (final b in picks)
                  PopupMenuItem<String>(value: b, child: Text(b)),
              ],
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
                child: Text(
                  'همان رشتهٔ دیگری است… ▾',
                  style: Web.small.copyWith(color: Web.muted),
                ),
              ),
            ),
        ],
      ),
    );
  }

  List<Widget> _stepCheck(ImportReview r) {
    final ready = r.ready;
    final todo = r.todo;
    return [
      if (r.pendingAsks > 0)
        WebCard(
          key: const Key('imp-ask'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              WebCardHead(
                icon: '❓',
                title: '${_fa(r.pendingAsks)} رشته نیاز به تأیید شما دارد',
              ),
              Text(
                'این نام‌ها در فهرست رشته‌های مدرسه نیستند. اگر همان رشتهٔ موجود است «بله» را بزنید '
                '(یا رشتهٔ درست را از فهرست انتخاب کنید) تا زیر همان رشته ثبت شوند؛ اگر رشتهٔ '
                'جداست «نه» — هیچ رشته‌ای بدون پاسخ شما ساخته یا ادغام نمی‌شود.',
                style: Web.small.copyWith(color: Web.muted),
              ),
              for (var i = 0; i < r.branchAsk.length; i++)
                _askRow(
                  r,
                  r.branchAsk[i].$1,
                  '«${r.branchAsk[i].$1}» شبیه «${r.branchAsk[i].$2}» است',
                  yes: (
                    'بله، همان «${r.branchAsk[i].$2}» است',
                    'imp-ask-yes-$i',
                    r.branchAsk[i].$2,
                  ),
                  noLabel: 'نه، رشتهٔ جداست',
                  noKey: 'imp-ask-no-$i',
                  pickKey: 'imp-ask-pick-$i',
                ),
              for (var i = 0; i < r.branchNew.length; i++)
                _askRow(
                  r,
                  r.branchNew[i],
                  'رشتهٔ «${r.branchNew[i]}» در فهرست رشته‌ها نیست',
                  noLabel: 'رشتهٔ تازه است — اضافه شود',
                  noKey: 'imp-new-add-$i',
                  pickKey: 'imp-new-pick-$i',
                ),
              if (r.branchNew.length > 1)
                Padding(
                  padding: const EdgeInsets.only(top: 10),
                  child: Align(
                    alignment: AlignmentDirectional.centerStart,
                    child: WebBtn(
                      'همهٔ ${_fa(r.branchNew.length)} رشتهٔ تازه اضافه شوند',
                      key: const Key('imp-new-all'),
                      kind: WebBtnKind.ghost,
                      onPressed: c.busy
                          ? null
                          : () => c.answerAll([
                              for (final b in r.branchNew) (b, ''),
                            ]),
                    ),
                  ),
                ),
            ],
          ),
        ),
      if (r.branchFixes.isNotEmpty)
        Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Wrap(
            key: const Key('imp-fixes'),
            spacing: 6,
            runSpacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text('✍️ رشته‌ها خودکار یکی شد:', style: Web.small),
              for (var i = 0; i < r.branchFixes.length; i++)
                WebWrap(
                  key: Key('imp-bfix-$i'),
                  spacing: 2,
                  children: [
                    WebBadge(
                      '«${r.branchFixes[i].$1}» ← ${r.branchFixes[i].$2}',
                      tone: WebTone.green,
                    ),
                    WebBtn(
                      'جدا بماند',
                      key: Key('imp-bfix-undo-$i'),
                      kind: WebBtnKind.ghost,
                      size: WebBtnSize.xs,
                      onPressed: c.busy
                          ? null
                          : () => c.answer(r.branchFixes[i].$1, ''),
                    ),
                  ],
                ),
            ],
          ),
        ),
      // p2: statCard ×4 (کل / آماده / خطا / به‌روزرسانی)
      WebGrid(
        min: 170,
        children: [
          _stat(
            '📋',
            _fa(r.rows.length),
            'کل ردیف‌ها',
            Web.ink,
            const Key('imp-stat-total'),
          ),
          _stat(
            '✅',
            _fa(ready.length),
            'آماده ثبت',
            Web.green,
            const Key('imp-stat-ready'),
          ),
          _stat(
            '⛔',
            _fa(todo.length),
            r.badCount > 0
                ? 'دارای خطا (${_fa(r.badCount)} ثبت‌نشدنی)'
                : 'نیازمند اصلاح',
            Web.red,
            const Key('imp-stat-todo'),
          ),
          _stat(
            '♻️',
            _fa(r.updates),
            'به‌روزرسانی موجود',
            Web.amber,
            const Key('imp-stat-updates'),
          ),
        ],
      ),
      if (r.autoCount > 0 || r.manualRows.isNotEmpty)
        WebGrid(
          min: 220,
          children: [
            _stat(
              '🎯',
              _fa(r.autoCount),
              'کلاس‌بندی خودکار',
              Web.primary,
              const Key('imp-stat-auto'),
            ),
            _stat(
              '🖐️',
              _fa(r.manualRows.length),
              'نیازمند بررسی دستی',
              r.manualRows.isEmpty ? Web.green : Web.red,
              const Key('imp-stat-manual'),
            ),
          ],
        ),
      if (r.capRows.isNotEmpty) _capTable(r),
      if (r.manualRows.isNotEmpty) _manualBlock(r),
      WebCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            WebCardHead(
              title: 'بررسی ردیف‌به‌ردیف',
              actions: [
                if (r.newClasses.isNotEmpty)
                  WebBadge(
                    'کلاس‌های جدید: ${r.newClasses.join('، ')}',
                    key: const Key('imp-newclasses'),
                    tone: WebTone.amber,
                  ),
                if (todo.isNotEmpty)
                  WebBtn(
                    '🔄 بررسی دوباره',
                    key: const Key('imp-recheck'),
                    kind: WebBtnKind.ghost,
                    size: WebBtnSize.xs,
                    onPressed: c.recheck,
                  ),
              ],
            ),
            Text(
              '✅ ${_fa(ready.length)} ردیف آمادهٔ ثبت'
              '${r.updates > 0 ? ' — ${_fa(r.updates)} به‌روزرسانی' : ''}'
              '${todo.isEmpty ? '' : ' · ✏️ ${_fa(todo.length)} ردیف تا اصلاح نشود ثبت نمی‌شود — همین‌جا درستش کنید'}',
              key: const Key('imp-ready-count'),
              style: Web.small,
            ),
            if (r.phonesFixed > 0)
              Text(
                '☎️ صفرِ اولِ ${_fa(r.phonesFixed)} شمارهٔ همراه در فایل نبود — خودکار به قالب ۱۱ رقمی «09…» برگردانده شد.',
                key: const Key('imp-phones'),
                style: Web.small.copyWith(color: Web.muted),
              ),
            const SizedBox(height: 8),
            WebTable(
              head: const ['#', 'وضعیت', 'نام', 'کد ملی', 'پیام‌ها', ''],
              rowColor: (i) {
                final x = [...todo.take(200), ...ready.take(200)][i];
                return x.bad ? Web.redBg : null;
              },
              rows: [
                for (final x in [...todo.take(200), ...ready.take(200)])
                  [
                    Text(_fa(x.row)),
                    WebBadge(
                      x.bad
                          ? 'خطا'
                          : x.needsFix
                          ? 'نیازمند اصلاح'
                          : (x.warns.isEmpty ? 'سالم' : 'با هشدار'),
                      key: Key(
                        x.ready ? 'imp-ready-${x.idx}' : 'imp-todo-${x.idx}',
                      ),
                      tone: x.bad
                          ? WebTone.red
                          : (x.needsFix || x.warns.isNotEmpty)
                          ? WebTone.amber
                          : WebTone.green,
                    ),
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          x.name.isEmpty ? '—' : x.name,
                          style: Web.b.copyWith(fontSize: 13),
                        ),
                        if (_place(x).isNotEmpty)
                          Text(
                            _place(x),
                            style: Web.small.copyWith(color: Web.muted),
                          ),
                      ],
                    ),
                    Text(
                      SchoolRecords.str(x.data['national_id']).isEmpty
                          ? '—'
                          : SchoolRecords.str(x.data['national_id']),
                      style: Web.small.copyWith(color: Web.muted),
                    ),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 420),
                      child: _msgs(x, warns: x.ready),
                    ),
                    x.ready
                        ? const SizedBox.shrink()
                        : WebBtn(
                            'اصلاح',
                            key: Key('imp-fix-${x.idx}'),
                            size: WebBtnSize.xs,
                            onPressed: () => _openFix(x),
                          ),
                  ],
              ],
            ),
            if (todo.length > 200 || ready.length > 200)
              Text(
                '۲۰۰ ردیف اول هر دسته نمایش داده شد؛ همهٔ ردیف‌های سالم ثبت می‌شوند و بقیه را بعد '
                'از ثبت از «نیازمند پیگیری» اصلاح کنید.',
                style: Web.small.copyWith(color: Web.muted),
              ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                WebBtn(
                  'بازگشت به نگاشت',
                  key: const Key('imp-prev'),
                  kind: WebBtnKind.ghost,
                  onPressed: c.back,
                ),
                WebBtn(
                  ready.isEmpty
                      ? 'ردیفی برای ثبت نیست'
                      : 'ثبت ${_fa(ready.length)} ردیف در سامانه',
                  key: const Key('imp-apply'),
                  kind: WebBtnKind.primary,
                  onPressed: c.busy || ready.isEmpty || r.pendingAsks > 0
                      ? null
                      : _applyWithProgress,
                ),
                if (r.pendingAsks > 0)
                  Text(
                    'اول به ${_fa(r.pendingAsks)} پرسش رشته (بالای صفحه) پاسخ دهید.',
                    key: const Key('imp-apply-wait'),
                    style: Web.small.copyWith(color: Web.red),
                  ),
                if (todo.isNotEmpty)
                  Text(
                    '${_fa(todo.length)} ردیف فعلاً ثبت نمی‌شود؛ اگر همین‌جا اصلاحش نکنید، پس از '
                    'ثبت در «نیازمند پیگیری» می‌ماند.',
                    style: Web.small.copyWith(color: Web.muted),
                  ),
              ],
            ),
          ],
        ),
      ),
    ];
  }

  List<Widget> _stepDone(ImportResult r) {
    final kind = c.session?.kind ?? 'students';
    final marks = kind == 'grades' || kind == 'attendance';
    return [
      WebCard(
        padding: const EdgeInsets.symmetric(vertical: 30, horizontal: 16),
        child: Column(
          children: [
            const Text('🎉', style: TextStyle(fontSize: 44)),
            const SizedBox(height: 10),
            Text('ورود اطلاعات کامل شد', style: Web.b.copyWith(fontSize: 17)),
            const SizedBox(height: 16),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 640),
              child: WebGrid(
                min: 140,
                children: [
                  _stat(
                    '➕',
                    _fa(r.created),
                    kind == 'grades'
                        ? 'نمره ثبت‌شده'
                        : kind == 'attendance'
                        ? 'حضور ثبت‌شده'
                        : 'رکورد جدید',
                    Web.green,
                    const Key('imp-done-created'),
                  ),
                  marks
                      ? _stat(
                          '⏭️',
                          _fa(r.savedIssues),
                          'ردیف ردشده',
                          Web.primary,
                          const Key('imp-done-skipped'),
                        )
                      : _stat(
                          '♻️',
                          _fa(r.updated),
                          'به‌روزرسانی',
                          Web.primary,
                          const Key('imp-done-updated'),
                        ),
                  _stat(
                    '👨‍👩‍👦',
                    _fa(r.parents),
                    'حساب ولی',
                    Web.purple,
                    const Key('imp-done-parents'),
                  ),
                  _stat(
                    '🏛️',
                    _fa(r.classes),
                    'کلاس جدید',
                    Web.amber,
                    const Key('imp-done-classes'),
                  ),
                ],
              ),
            ),
            Text(r.summaryFa, key: const Key('imp-result'), style: Web.small),
            if (kind == 'students')
              Text(
                '🎓 دانش‌آموز: ${_fa(r.students)} · 👨‍👩‍👦 اولیا: ${_fa(r.parents)} · '
                '♻️ به‌روزرسانی: ${_fa(r.updated)} · 🏛️ کلاس تازه: ${_fa(r.classes)}',
                key: const Key('imp-result-detail'),
                style: Web.small.copyWith(color: Web.muted),
              ),
            if (r.errors.isNotEmpty)
              Text(
                '${_fa(r.errors.length)} ردیف ثبت نشد: '
                '${r.errors.take(8).map((e) => 'سطر ${_fa(e.$1)}: ${importErrorFa[e.$2] ?? e.$2}').join(' · ')}',
                key: const Key('imp-errors'),
                style: Web.small.copyWith(color: Web.red),
              ),
            const SizedBox(height: 8),
            Text(
              'نام کاربری هر نفر شمارهٔ همراه اوست و رمزش کد ملی؛ اگر کسی شمارهٔ همراه نداشت، نام '
              'کاربری‌اش کد ملی اوست. حساب‌ها پس از رسیدن به سیستم مدرسه فعال می‌شوند.',
              textAlign: TextAlign.center,
              style: Web.small.copyWith(color: Web.muted),
            ),
            if (r.savedIssues > 0)
              Text(
                '🕒 ${_fa(r.savedIssues)} ردیف در «نیازمند پیگیری» ذخیره شد تا بعداً کامل شوند.',
                key: const Key('imp-saved'),
                style: Web.small,
              ),
            if (r.openIssues > 0)
              Text(
                'در کل ${_fa(r.openIssues)} ردیف نیازمند پیگیری در فهرست مانده است.',
                style: Web.small.copyWith(color: Web.muted),
              ),
            const SizedBox(height: 18),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              alignment: WrapAlignment.center,
              children: [
                WebBtn(
                  'ورود فایل دیگر',
                  key: const Key('imp-again'),
                  kind: WebBtnKind.primary,
                  onPressed: () {
                    pasted.clear();
                    c.restart();
                  },
                ),
                if (r.openIssues > 0)
                  WebBtn(
                    '🕒 فهرست پیگیری',
                    key: const Key('imp-issues-open'),
                    onPressed: () => Navigator.maybePop(context),
                  ),
                WebBtn(
                  'تمام',
                  key: const Key('imp-done'),
                  kind: WebBtnKind.ghost,
                  onPressed: () => Navigator.maybePop(context),
                ),
              ],
            ),
          ],
        ),
      ),
    ];
  }

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

/// p2 `border:2px dashed var(--border);border-radius:14px`.
class _DashedBox extends CustomPainter {
  _DashedBox({required this.color, required this.radius});
  final Color color;
  final double radius;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;
    final path = Path()
      ..addRRect(
        RRect.fromRectAndRadius(Offset.zero & size, Radius.circular(radius)),
      );
    for (final m in path.computeMetrics()) {
      var d = 0.0;
      while (d < m.length) {
        canvas.drawPath(m.extractPath(d, math.min(d + 7, m.length)), paint);
        d += 12;
      }
    }
  }

  @override
  bool shouldRepaint(_DashedBox old) =>
      old.color != color || old.radius != radius;
}
