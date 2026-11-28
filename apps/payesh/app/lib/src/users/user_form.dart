import 'dart:async';

import 'package:flutter/foundation.dart' show mapEquals;
import 'package:flutter/material.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import '../school/school_source.dart';
import 'users_controller.dart';

/// Row 194: the four kinds of person the form starts with («اول نقش»).
const List<(String, String)> userKinds = [
  ('student', '🎓 دانش‌آموز'),
  ('teacher', '👩‍🏫 دبیر'),
  ('parent', '👨‍👩‍👧 ولی'),
  ('exec', '🧑‍💼 عوامل اجرایی'),
];

/// The roles under «عوامل اجرایی», in the order the manager reads them.
const List<String> execRoleOrder = [
  'vice',
  'counselor',
  'staff',
  'office',
  'guard',
  'manager',
];

/// `user` form (web «کاربر جدید»). Row 194: the role comes first; each role then gets its own
/// complete list —
///   * دانش‌آموز: student data + father, mother and guardian data; the parents' accounts are
///     made with the student (ticks «حساب پدر / مادر ساخته شود»);
///   * دبیر: personal + personnel data and the subjects taught (from «دروس» with پایه and رشته,
///     or a new subject written right here, which also goes into «دروس»);
///   * عوامل اجرایی: the post (معاون، مشاور، …), personal + personnel data and «سطح دسترسی» as
///     ticks the manager controls;
///   * ولی: personal data, relation and the child.
class UserFormPage extends StatefulWidget {
  const UserFormPage({
    super.key,
    required this.controller,
    this.initial = const {},
    this.onSaved,
    this.editing,
    this.issues = const {},
    this.notes = const [],
    this.draft = const {},
    this.onDraft,
    this.onTemp,
  });
  final UsersController controller;

  /// Row 203: what the manager already typed for this follow-up row (form keys), put over the
  /// user's own values when the form edits an existing user.
  final Map<String, String> draft;

  /// Row 203 (owner: «با تغییر در اطلاعات اتوماتیک ذخیره شود و فقط با تأیید نهایی، ذخیرهٔ
  /// نهایی شود»): called a moment after each change with every value changed since the form
  /// opened (form keys); the final save is still «ذخیره».
  final Future<void> Function(Map<String, String> changed)? onDraft;

  /// Row 203 «ثبت موقت در لیست»: shown on a new user; makes the user with its valid values
  /// (in the class picked) and hands the write, the left-out keys and the values to the caller.
  final Future<void> Function(
    RecordWrite w,
    List<String> dropped,
    Map<String, String> values,
  )?
  onTemp;

  /// Row 202 (owner: «قسمت‌های مشکل‌دار باید با کادر قرمز مشخص بشن»): field (data key —
  /// `name`, `national_id`, `phone`, `birth_date`, `gender`, `grade`, `field`, `father_nid`,
  /// …) → what is wrong with it; those boxes open with a red frame and the message under them.
  final Map<String, String> issues;

  /// Row 202: the reasons of a follow-up row, listed above the fields.
  final List<String> notes;

  /// ردیف ۱۹۷ (F45/F47): ویرایش همان کاربر با فهرست کامل نقش خودش (تیک‌های دسترسی کارکنان،
  /// درس‌های دبیر، پایه/رشته/کلاس دانش‌آموز، نسبت و فرزند ولی). null = «کاربر جدید».
  final SchoolUser? editing;

  /// W10 `issue-fix`: the form opens with the values of the import row.
  final Map<String, String> initial;

  /// Runs after a successful save, before the form closes.
  final Future<void> Function(RecordWrite w)? onSaved;

  @override
  State<UserFormPage> createState() => _UserFormPageState();
}

class _UserFormPageState extends State<UserFormPage> {
  late final Map<String, TextEditingController> f = {
    for (final k in [
      'name',
      'national_id',
      'phone',
      'birth_date',
      'newsubject',
    ])
      k: TextEditingController(),
    for (final k in userProfileKeys) k: TextEditingController(),
  };

  /// '' until the manager picks one of [userKinds].
  String kind = '';
  String execRole = 'vice';
  String gender = '';
  String grade = '';
  String branch = '';
  int? classId;
  int? childId;
  String relation = 'پدر';
  String employment = '';
  bool makeFather = true;
  bool makeMother = true;
  final Set<String> access = {};

  /// Row 197 (Q06): nobody ticked anything for this person yet — the post's default is open.
  bool accessDefault = false;
  final List<TeachDraft> teaches = [];
  int? teachSubject;
  String teachGrade = '';
  String teachBranch = '';

  UsersController get c => widget.controller;

  String get role => switch (kind) {
    'exec' => execRole,
    '' => '',
    _ => kind,
  };

  @override
  void initState() {
    super.initState();
    for (final e in widget.initial.entries) {
      f[e.key]?.text = e.value;
    }
    // an import row's single «ولی» becomes the father (his account is made with the student)
    for (final (from, to) in const [
      ('parent_name', 'father_name'),
      ('parent_phone', 'father_phone'),
    ]) {
      final v = widget.initial[from] ?? '';
      if (v.isNotEmpty && f[to]!.text.isEmpty) f[to]!.text = v;
    }
    final r = widget.initial['role'] ?? '';
    if (execRoles.contains(r)) {
      kind = 'exec';
      execRole = r;
      // Row 197 (Q06): a new staff member starts with the real default of the post.
      access.addAll(roleDefaultAccess[r] ?? const []);
    } else if (const {'student', 'teacher', 'parent'}.contains(r)) {
      kind = r;
    }
    gender = widget.initial['gender'] ?? '';
    grade = widget.initial['grade'] ?? '';
    branch = widget.initial['field'] ?? widget.initial['branch'] ?? '';
    employment = widget.initial['employment'] ?? '';
    classId = int.tryParse(widget.initial['class_id'] ?? '');
    final u = widget.editing;
    if (u != null) {
      _fillFrom(u);
      // row 202: a wrong value of the file the user row does not have is still shown
      for (final k in widget.issues.keys) {
        final v = widget.initial[k] ?? '';
        if (v.isNotEmpty && (f[k]?.text.isEmpty ?? false)) f[k]!.text = v;
      }
      // row 203: what was already typed for the follow-up row
      for (final e in widget.draft.entries) {
        _put(e.key, e.value);
      }
    }
    // row 203: the class the file named («دهم الف»), when the school has it
    final cn = (widget.initial['class_name'] ?? '').trim();
    if (classId == null && cn.isNotEmpty) {
      classId = c.classRows
          .where((x) => normName(x.$2) == normName(cn))
          .map((x) => x.$1)
          .firstOrNull;
    }
    _start = _values();
    if (widget.onDraft != null) {
      for (final x in f.values) {
        x.addListener(_changed);
      }
    }
  }

  /// Row 203: one form value by its key (dropdowns included).
  void _put(String k, String v) {
    switch (k) {
      case 'gender':
        gender = v;
      case 'grade':
        grade = v;
      case 'field' || 'branch':
        branch = v;
      case 'class_id':
        classId = int.tryParse(v);
      case 'employment':
        employment = v;
      case 'relation':
        if (const {'پدر', 'مادر', 'سرپرست'}.contains(v)) relation = v;
      default:
        f[k]?.text = v;
    }
  }

  /// Row 203: every value of the form (form keys) — what a draft is made of.
  Map<String, String> _values() => {
    for (final e in f.entries)
      if (e.key != 'newsubject') e.key: e.value.text.trim(),
    'gender': gender,
    'grade': grade,
    'field': branch,
    'class_id': classId == null ? '' : '$classId',
    'employment': employment,
    if (kind == 'parent') 'relation': relation,
  };

  late Map<String, String> _start;
  Map<String, String> _sent = const {};
  Timer? _draftTimer;
  String? _draftNote;

  void _changed() {
    if (widget.onDraft == null) return;
    _draftTimer?.cancel();
    _draftTimer = Timer(const Duration(milliseconds: 900), _flushDraft);
  }

  /// Row 203: what changed since the form opened (or was sent before) goes to [onDraft].
  Future<void> _flushDraft() async {
    _draftTimer?.cancel();
    _draftTimer = null;
    final cb = widget.onDraft;
    if (cb == null) return;
    final now = _values();
    final out = <String, String>{
      for (final e in now.entries)
        if (e.value != (_start[e.key] ?? '') || _sent.containsKey(e.key))
          e.key: e.value,
    };
    if (out.isEmpty || mapEquals(out, _sent)) return;
    _sent = out;
    await cb(out);
    if (mounted) {
      setState(() => _draftNote = '✓ اصلاح‌ها ذخیره شد — ثبت نهایی با «ذخیره»');
    }
  }

  /// Row 203 «ثبت موقت در لیست».
  Future<void> _temp() async {
    final d = _draft();
    if (d == null) return;
    final r = await c.addTemporary(d);
    if (r == null) return;
    _draftTimer?.cancel();
    _draftTimer = null;
    final values = _values();
    _sent = values;
    await widget.onTemp?.call(r, c.tempDropped, values);
    if (mounted) Navigator.pop(context);
  }

  /// Row 202: [UserFormPage.issues] under the names of the boxes of this form.
  static String issueBox(String k) => switch (k) {
    'name' || 'full_name' || 'first_name' || 'last_name' => 'usr-f-name',
    'national_id' => 'usr-f-nid',
    'birth_date' => 'usr-f-birth',
    'field' || 'branch' => 'usr-f-branch',
    'class_name' || 'class_id' => 'usr-f-class',
    _ => 'usr-f-$k',
  };

  late final Map<String, String> _preset = {
    for (final e in widget.issues.entries) issueBox(e.key): e.value,
  };

  bool get _isEdit => widget.editing != null;
  bool active = true;

  /// ردیف ۱۹۷: کادرها با مقدار فعلی همان کاربر پر می‌شوند.
  void _fillFrom(SchoolUser u) {
    for (final k in f.keys) {
      if (k == 'newsubject') continue;
      f[k]!.text = u.field(k);
    }
    // row 204: the whole name once — a stored last name is not repeated or dropped
    f['name']!.text = fullName(u.data);
    final r = u.role;
    if (execRoles.contains(r)) {
      kind = 'exec';
      execRole = r;
    } else {
      kind = r;
    }
    gender = u.field('gender');
    grade = u.field('grade');
    branch = u.field('field');
    classId = u.classId;
    employment = u.field('employment');
    active = u.active;
    final rel = u.field('relation');
    if (const {'پدر', 'مادر', 'سرپرست'}.contains(rel)) relation = rel;
    access
      ..clear()
      ..addAll(staffAccessOf(r, u.data['access']));
    accessDefault =
        grantableRoles.contains(r) && accessIsDefault(u.data['access']);
    teaches
      ..clear()
      ..addAll(TeachDraft.listOf(u.data['teaches']));
    makeFather = false;
    makeMother = false;
  }

  @override
  void dispose() {
    // a change typed just before closing is still kept
    if (_draftTimer != null) unawaited(_flushDraft());
    for (final x in f.values) {
      x.dispose();
    }
    super.dispose();
  }

  void _pickKind(String k) => setState(() {
    kind = k;
    c.formError = null;
  });

  Future<void> _save() async {
    final draft = _draft();
    if (draft == null) return;
    final r = _isEdit
        ? await c.update(widget.editing!.id, draft)
        : await c.add(draft);
    if (r != null) {
      _draftTimer?.cancel();
      _draftTimer = null;
      await widget.onSaved?.call(r);
    }
    if (r != null && mounted) Navigator.pop(context);
  }

  UserDraft? _draft() {
    if (role.isEmpty) {
      c.formError = 'اول نقش را انتخاب کنید';
      c.emit();
      return null;
    }
    final extra = <String, String>{
      for (final k in userProfileKeys) k: f[k]!.text,
      if (employment.isNotEmpty) 'employment': employment,
      if (kind == 'parent') 'relation': relation,
    };
    final draft = UserDraft(
      name: f['name']!.text,
      role: role,
      classId: kind == 'student' ? classId : null,
      nationalId: f['national_id']!.text,
      phone: f['phone']!.text,
      birthDate: f['birth_date']!.text,
      gender: gender,
      extra: extra,
      grade: kind == 'student' ? grade : '',
      branch: kind == 'student' ? branch : '',
      parentAccounts: kind == 'student'
          ? {if (makeFather) 'father', if (makeMother) 'mother'}
          : const {},
      // Row 197 (Q06): nothing ticked = «هیچ» on purpose (['none']); the post default is
      // what the form pre-ticks, so it is saved as explicit ticks.
      access: accessForSave(role, access),
      teaches: kind == 'teacher' ? [...teaches] : const [],
      childId: kind == 'parent' ? childId : null,
      active: _isEdit ? active : null,
    );
    return draft;
  }

  // ───────────────────────────── pieces ─────────────────────────────

  Widget _text(String key, String k, String label, {bool numeric = false}) =>
      SchoolField(key, label, f[k]!, numeric: numeric);

  Widget _drop<T>(
    String key,
    String label,
    T value,
    List<(T, String)> items,
    ValueChanged<T> onChanged,
  ) => Builder(
    builder: (context) {
      final issues = FieldIssueScope.maybeOf(context);
      return FieldBox(
        width: kFieldText,
        child: DropdownButtonFormField<T>(
          key: Key(key),
          isExpanded: true,
          initialValue: items.any((x) => x.$1 == value) ? value : null,
          decoration: InputDecoration(
            labelText: label,
            border: const OutlineInputBorder(),
            // row 202: a wrong grade / branch / gender of the import row is framed red too
            errorText: issues?.of(key),
            errorMaxLines: 3,
          ),
          items: [
            for (final (v, t) in items)
              DropdownMenuItem<T>(value: v, child: Text(t)),
          ],
          onChanged: (v) {
            FieldIssueScope.maybeOf(context)?.clear(key);
            if (v is T) setState(() => onChanged(v));
            _changed();
          },
        ),
      );
    },
  );

  Widget _kindPicker() => SchoolFormFull(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'نقش این کاربر چیست؟',
          style: Theme.of(context).textTheme.titleSmall
              ?.copyWith(fontWeight: FontWeight.w800),
        ),
        const SizedBox(height: PayeshTokens.space2),
        Wrap(
          spacing: PayeshTokens.space2,
          runSpacing: PayeshTokens.space2,
          children: [
            for (final (k, label) in userKinds)
              ChoiceChip(
                key: Key('usr-f-kind-$k'),
                label: Text(label),
                selected: kind == k,
                onSelected: (_) => _pickKind(k),
              ),
          ],
        ),
        if (kind.isEmpty)
          Padding(
            padding: const EdgeInsets.only(top: PayeshTokens.space2),
            child: Text(
              'با انتخاب نقش، فهرست کامل مشخصات همان نقش باز می‌شود.',
              key: const Key('usr-f-kind-hint'),
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
      ],
    ),
  );

  List<Widget> _personal({required bool adult}) => [
    _text('usr-f-name', 'name', 'نام و نام خانوادگی *'),
    _text('usr-f-nid', 'national_id', 'کد ملی', numeric: true),
    _text('usr-f-phone', 'phone', 'شمارهٔ همراه (نام کاربری)', numeric: true),
    _text('usr-f-birth', 'birth_date', 'تاریخ تولد'),
    _drop<String>(
      'usr-f-gender',
      'جنسیت',
      gender,
      adult
          ? const [('مرد', 'مرد'), ('زن', 'زن')]
          : const [('پسر', 'پسر'), ('دختر', 'دختر')],
      (v) => gender = v,
    ),
  ];

  List<Widget> _personnel({required bool post}) => [
    SchoolFormSection('مشخصات پرسنلی', note: 'فقط مدیر این بخش را می‌بیند.'),
    _text('usr-f-personnel_code', 'personnel_code', 'کد پرسنلی', numeric: true),
    if (post) _text('usr-f-position', 'position', 'سمت / عنوان کار'),
    _text('usr-f-degree', 'degree', 'مدرک تحصیلی'),
    _text('usr-f-study_field', 'study_field', 'رشتهٔ تحصیلی'),
    _drop<String>('usr-f-employment', 'نوع استخدام', employment, [
      for (final k in employmentKinds) (k, k),
    ], (v) => employment = v),
    _text(
      'usr-f-service_years',
      'service_years',
      'سابقهٔ خدمت (سال)',
      numeric: true,
    ),
    _text('usr-f-start_date', 'start_date', 'تاریخ شروع در این مدرسه'),
    _text('usr-f-landline', 'landline', 'تلفن ثابت', numeric: true),
    SchoolField('usr-f-address', 'نشانی', f['address']!, lines: 2),
  ];

  List<(int, String)> get _classesForGrade {
    final all = c.classRows;
    final hit = [
      for (final x in all)
        if ((grade.isEmpty || x.$3.isEmpty || x.$3 == grade) &&
            (branch.isEmpty || x.$4.isEmpty || x.$4 == branch))
          (x.$1, x.$2),
    ];
    return hit.isEmpty ? [for (final x in all) (x.$1, x.$2)] : hit;
  }

  List<Widget> _student() => [
    const SchoolFormSection('مشخصات دانش‌آموز'),
    ..._personal(adult: false),
    _drop<String>(
      'usr-f-grade',
      'پایه',
      grade,
      [
        const ('', '—'),
        // row 203: the student's own پایه stays shown even if the school list lacks it
        for (final g in {...c.definedGrades, if (grade.isNotEmpty) grade})
          (g, g),
      ],
      (v) {
        grade = v;
        classId = null;
      },
    ),
    if (c.showBranch || branch.isNotEmpty)
      _drop<String>(
        'usr-f-branch',
        'رشته',
        branch,
        [
          const ('', '—'),
          for (final b in {...c.definedBranches, if (branch.isNotEmpty) branch})
            (b, b),
        ],
        (v) {
          branch = v;
          classId = null;
        },
      ),
    // row 204: a field school places a student by پایه + رشته — no «کلاس» to choose
    if (!c.fieldSchool)
      _drop<int?>('usr-f-class', 'کلاس', classId, [
        (null, '—'),
        ..._classesForGrade,
      ], (v) => classId = v),
    _text('usr-f-last_gpa', 'last_gpa', 'معدل سال گذشته', numeric: true),
    _text(
      'usr-f-failed_count',
      'failed_count',
      'تعداد درس افتاده',
      numeric: true,
    ),
    _text('usr-f-covered', 'covered', 'حمایتی (بله/خیر)'),
    _text('usr-f-org_type', 'org_type', 'نوع ارگان حمایتی'),
    _text('usr-f-org_percent', 'org_percent', 'درصد حمایت'),
    _text('usr-f-talent', 'talent', 'استعداد'),
    _text('usr-f-shenasname_serial', 'shenasname_serial', 'سریال شناسنامه'),
    _text('usr-f-shenasname_seri', 'shenasname_seri', 'سری شناسنامه'),
    _text('usr-f-sisters', 'sisters', 'تعداد خواهر', numeric: true),
    _text('usr-f-brothers', 'brothers', 'تعداد برادر', numeric: true),
    const SchoolFormSection(
      'مشخصات پدر',
      note: 'نام کاربری پدر همراه اوست و رمز اولیه‌اش کد ملی‌اش.',
    ),
    _text('usr-f-father_name', 'father_name', 'نام پدر'),
    _text('usr-f-father_nid', 'father_nid', 'کد ملی پدر', numeric: true),
    _text('usr-f-father_phone', 'father_phone', 'همراه پدر', numeric: true),
    _text('usr-f-father_edu', 'father_edu', 'تحصیلات پدر'),
    _text('usr-f-father_job', 'father_job', 'شغل پدر'),
    _text('usr-f-father_alive', 'father_alive', 'وضعیت حیات پدر'),
    if (!_isEdit)
      SchoolFormFull(
        child: CheckboxListTile(
          key: const Key('usr-f-make-father'),
          contentPadding: EdgeInsets.zero,
          controlAffinity: ListTileControlAffinity.leading,
          value: makeFather,
          title: const Text(
            'حساب کاربری پدر هم ساخته شود و به دانش‌آموز وصل شود',
          ),
          onChanged: (v) => setState(() => makeFather = v ?? false),
        ),
      ),
    const SchoolFormSection(
      'مشخصات مادر',
      note: 'نام کاربری مادر همراه اوست و رمز اولیه‌اش کد ملی‌اش.',
    ),
    _text('usr-f-mother_name', 'mother_name', 'نام مادر'),
    _text('usr-f-mother_nid', 'mother_nid', 'کد ملی مادر', numeric: true),
    _text('usr-f-mother_phone', 'mother_phone', 'همراه مادر', numeric: true),
    _text('usr-f-mother_edu', 'mother_edu', 'تحصیلات مادر'),
    _text('usr-f-mother_job', 'mother_job', 'شغل مادر'),
    _text('usr-f-mother_alive', 'mother_alive', 'وضعیت حیات مادر'),
    if (!_isEdit)
      SchoolFormFull(
        child: CheckboxListTile(
          key: const Key('usr-f-make-mother'),
          contentPadding: EdgeInsets.zero,
          controlAffinity: ListTileControlAffinity.leading,
          value: makeMother,
          title: const Text(
            'حساب کاربری مادر هم ساخته شود و به دانش‌آموز وصل شود',
          ),
          onChanged: (v) => setState(() => makeMother = v ?? false),
        ),
      ),
    const SchoolFormSection('سرپرست و نشانی'),
    _text('usr-f-guardian', 'guardian', 'سرپرست (نسبت و نام)'),
    _text('usr-f-guardian_alive', 'guardian_alive', 'وضعیت حیات سرپرست'),
    _text(
      'usr-f-guardian_phone',
      'guardian_phone',
      'همراه سرپرست',
      numeric: true,
    ),
    _text('usr-f-landline', 'landline', 'تلفن ثابت', numeric: true),
    _text('usr-f-residence', 'residence', 'محل سکونت'),
    _text('usr-f-village', 'village', 'نام روستا'),
    _text('usr-f-residence_status', 'residence_status', 'وضعیت اقامت / تابعیت'),
    SchoolField('usr-f-address', 'نشانی', f['address']!, lines: 2),
  ];

  Future<void> _newSubject() async {
    final made = await c.addSubject(f['newsubject']!.text);
    if (made == null || !mounted) return;
    setState(() {
      f['newsubject']!.clear();
      teachSubject = made.$1;
    });
  }

  void _addTeach() {
    final id = teachSubject;
    if (id == null) {
      c.formError = 'درس را از فهرست انتخاب کنید یا درس تازه بنویسید';
      c.emit();
      return;
    }
    final name = c.subjects.firstWhere((x) => x.$1 == id).$2;
    final t = TeachDraft(
      subjectId: id,
      subject: name,
      grade: teachGrade,
      branch: teachBranch,
    );
    setState(() {
      if (!teaches.contains(t)) teaches.add(t);
      c.formError = null;
    });
  }

  List<Widget> _teacher() => [
    const SchoolFormSection('مشخصات شخصی'),
    ..._personal(adult: true),
    ..._personnel(post: false),
    const SchoolFormSection(
      'دروسی که تدریس می‌کند',
      note:
          'درس را از «دروس» مدرسه (همان فهرست برنامهٔ هفتگی) با پایه و رشته انتخاب کنید؛ اگر '
          'در فهرست نیست، همین‌جا بنویسید تا در «دروس» هم ثبت شود.',
    ),
    _drop<int?>('usr-f-teach-subject', 'درس', teachSubject, [
      (null, c.subjects.isEmpty ? 'هنوز درسی تعریف نشده' : '—'),
      for (final x in c.subjects) (x.$1, x.$2),
    ], (v) => teachSubject = v),
    _drop<String>('usr-f-teach-grade', 'پایه', teachGrade, [
      const ('', 'همهٔ پایه‌ها'),
      for (final g in c.definedGrades) (g, g),
    ], (v) => teachGrade = v),
    if (c.showBranch)
      _drop<String>('usr-f-teach-branch', 'رشته', teachBranch, [
        const ('', 'همهٔ رشته‌ها'),
        for (final b in c.definedBranches) (b, b),
      ], (v) => teachBranch = v),
    Align(
      alignment: AlignmentDirectional.centerStart,
      child: FilledButton.tonal(
        key: const Key('usr-f-teach-add'),
        onPressed: c.busy ? null : _addTeach,
        child: const Text('+ افزودن به دروس این دبیر'),
      ),
    ),
    SchoolField(
      'usr-f-newsubject',
      'نام درس تازه (اگر در فهرست نیست)',
      f['newsubject']!,
    ),
    Align(
      alignment: AlignmentDirectional.centerStart,
      child: OutlinedButton(
        key: const Key('usr-f-newsubject-add'),
        onPressed: c.busy ? null : _newSubject,
        child: const Text('+ ثبت درس تازه در «دروس»'),
      ),
    ),
    SchoolFormFull(
      child: teaches.isEmpty
          ? Text(
              'هنوز درسی برای این دبیر انتخاب نشده.',
              key: const Key('usr-f-teach-none'),
              style: Theme.of(context).textTheme.bodySmall,
            )
          : Wrap(
              key: const Key('usr-f-teach-list'),
              spacing: PayeshTokens.space2,
              runSpacing: PayeshTokens.space2,
              children: [
                for (final (i, t) in teaches.indexed)
                  InputChip(
                    key: Key('usr-f-teach-$i'),
                    label: Text(t.labelFa),
                    onDeleted: () => setState(() => teaches.removeAt(i)),
                  ),
              ],
            ),
    ),
  ];

  Widget _accessBlock() {
    final all = !grantableRoles.contains(execRole);
    return SchoolFormFull(
      child: Column(
        key: const Key('usr-f-access'),
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (all)
            Text(
              '${roleFa[execRole]} همهٔ دسترسی‌های مدیر را دارد — تیک لازم نیست.',
              key: const Key('usr-f-access-all'),
            )
          else
            Row(
              children: [
                Expanded(
                  child: Text(
                    execRole == 'counselor'
                        ? 'صف ارجاع مشاور همیشه برای مشاور هست؛ بقیه را تیک بزنید.'
                        : 'هر کاری که این شخص باید انجام دهد را تیک بزنید؛ بقیه بسته می‌ماند.',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
                TextButton(
                  key: const Key('usr-f-access-default-btn'),
                  onPressed: () => setState(() {
                    access
                      ..clear()
                      ..addAll(roleDefaultAccess[execRole] ?? const []);
                    accessDefault = false;
                  }),
                  child: const Text('پیش‌فرض سمت'),
                ),
                TextButton(
                  key: const Key('usr-f-access-every'),
                  onPressed: () => setState(() {
                    access.addAll(staffAccessAreas.map((a) => a.key));
                    accessDefault = false;
                  }),
                  child: const Text('همه'),
                ),
                TextButton(
                  key: const Key('usr-f-access-none'),
                  onPressed: () => setState(() {
                    access.clear();
                    accessDefault = false;
                  }),
                  child: const Text('هیچ'),
                ),
              ],
            ),
          if (!all && accessDefault)
            Text(
              'برای این شخص هنوز تیکی ذخیره نشده؛ پیش‌فرض سمت «${roleFa[execRole] ?? execRole}» باز است (همین تیک‌ها).',
              key: const Key('usr-f-access-default'),
              style: Theme.of(context).textTheme.bodySmall,
            ),
          if (!all && access.isEmpty)
            Text(
              'هیچ کاری تیک نخورده: این شخص بعد از ورود فقط راهنمای «دسترسی ندارید» را می‌بیند.',
              key: const Key('usr-f-access-empty'),
              style: Theme.of(context).textTheme.bodySmall,
            ),
          Wrap(
            spacing: PayeshTokens.space2,
            children: [
              for (final a in staffAccessAreas)
                SizedBox(
                  width: 300,
                  child: CheckboxListTile(
                    key: Key('usr-f-access-${a.key}'),
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    controlAffinity: ListTileControlAffinity.leading,
                    value: all || access.contains(a.key),
                    title: Text(a.label),
                    subtitle: Text(a.hint),
                    onChanged: all
                        ? null
                        : (v) => setState(() {
                            v == true
                                ? access.add(a.key)
                                : access.remove(a.key);
                            accessDefault = false;
                          }),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }

  List<Widget> _exec() => [
    _drop<String>(
      'usr-f-role',
      'سمت در مدرسه',
      execRole,
      [for (final r in execRoleOrder) (r, roleFa[r] ?? r)],
      (v) {
        execRole = v;
        // Row 197 (Q06): a new person gets the default of the post just picked.
        if (!_isEdit) {
          access
            ..clear()
            ..addAll(roleDefaultAccess[v] ?? const []);
        }
      },
    ),
    const SchoolFormSection('مشخصات شخصی'),
    ..._personal(adult: true),
    ..._personnel(post: true),
    const SchoolFormSection('سطح دسترسی'),
    _accessBlock(),
  ];

  /// ردیف ۱۹۷: سرِ فرم ویرایش — نقش (ثابت) و فعال/غیرفعال.
  Widget _editHead() {
    final u = widget.editing!;
    return SchoolFormFull(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            kind == 'exec'
                ? 'نقش: عوامل اجرایی — سمت را از فهرست «سمت در مدرسه» می‌شود عوض کرد'
                : 'نقش: ${u.roleLabel} (برای نقش دیگر کاربر تازه بسازید)',
            key: const Key('usr-f-edit-role'),
            style: Theme.of(context).textTheme.titleSmall
                ?.copyWith(fontWeight: FontWeight.w800),
          ),
          if (u.kids.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: PayeshTokens.space1),
              child: Text(
                'فرزندان وصل‌شده: ${u.kids.join('، ')}',
                key: const Key('usr-f-edit-kids'),
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          SwitchListTile(
            key: const Key('usr-e-active'),
            contentPadding: EdgeInsets.zero,
            title: Text(active ? 'فعال' : 'غیرفعال (ورود بسته است)'),
            value: active,
            onChanged: (v) => setState(() => active = v),
          ),
        ],
      ),
    );
  }

  List<Widget> _parent() => [
    const SchoolFormSection(
      'مشخصات ولی',
      note: 'نام کاربری همان همراه است و رمز اولیه کد ملی.',
    ),
    ..._personal(adult: true),
    _drop<String>('usr-f-relation', 'نسبت با دانش‌آموز', relation, const [
      ('پدر', 'پدر'),
      ('مادر', 'مادر'),
      ('سرپرست', 'سرپرست'),
    ], (v) => relation = v),
    _text('usr-f-degree', 'degree', 'تحصیلات'),
    _text('usr-f-job', 'job', 'شغل'),
    _drop<int?>(
      'usr-f-child',
      _isEdit ? 'وصل کردن فرزند دیگر' : 'فرزند (دانش‌آموز)',
      childId,
      [(null, '—'), ...c.studentRows],
      (v) => childId = v,
    ),
    _text('usr-f-landline', 'landline', 'تلفن ثابت', numeric: true),
    SchoolField('usr-f-address', 'نشانی', f['address']!, lines: 2),
  ];

  /// Row 202: what the import found wrong in this row, above the fields.
  Widget _notesBox() {
    final theme = Theme.of(context);
    return SchoolFormFull(
      child: Container(
        key: const Key('usr-f-notes'),
        padding: const EdgeInsets.all(PayeshTokens.space2),
        decoration: BoxDecoration(
          color: theme.colorScheme.errorContainer.withValues(alpha: 0.35),
          border: Border.all(color: theme.colorScheme.error),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              _preset.isEmpty
                  ? 'ایرادهای این ردیف در فایل:'
                  : 'ایرادهای این ردیف در فایل — ${fieldsToFixFa(_preset.length)}:',
              style: theme.textTheme.titleSmall?.copyWith(
                fontWeight: FontWeight.w800,
              ),
            ),
            for (final n in widget.notes)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text('• $n', style: theme.textTheme.bodySmall),
              ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    // row 203: a change typed just before closing is saved as the form goes (the follow-up
    // list waits for it before it is read again)
    builder: (context, _) => PopScope(
      onPopInvokedWithResult: (didPop, _) {
        if (didPop && _draftTimer != null) unawaited(_flushDraft());
      },
      child: SchoolForm(
        prefix: 'usr',
        title: _isEdit ? 'ویرایش — ${widget.editing!.name}' : 'کاربر جدید',
        controller: c,
        submitLabel: c.samePerson != null ? 'شخص دیگری است — ذخیره' : 'ذخیره',
        onSubmit: _save,
        presetIssues: _preset,
        footer: _draftNote == null
            ? null
            : Text(
                _draftNote!,
                key: const Key('usr-f-draft-saved'),
                style: TextStyle(
                  color: Colors.green.shade800,
                  fontWeight: FontWeight.w600,
                ),
              ),
        actions: [
          if (widget.onTemp != null && !_isEdit && kind == 'student')
            Tooltip(
              message:
                  'مشخصات هنوز کامل نیست ولی نامش در فهرست کاربران و '
                  '${c.fieldSchool ? 'پایه و رشته' : 'کلاس'} ثبت شود؛ مقدارهای نادرست '
                  'ثبت نمی‌شوند و ردیف برای تکمیل در «پیگیری» می‌ماند.',
              child: OutlinedButton.icon(
                key: const Key('usr-f-temp'),
                style: OutlinedButton.styleFrom(minimumSize: const Size(0, 46)),
                onPressed: c.busy ? null : _temp,
                icon: const Icon(Icons.playlist_add, size: 20),
                label: const Text('ثبت موقت در لیست'),
              ),
            ),
        ],
        fields: [
          if (widget.notes.isNotEmpty) _notesBox(),
          if (_isEdit) _editHead() else _kindPicker(),
          ...switch (kind) {
            'student' => _student(),
            'teacher' => _teacher(),
            'exec' => _exec(),
            'parent' => _parent(),
            _ => const <Widget>[],
          },
        ],
      ),
    ),
  );
}
