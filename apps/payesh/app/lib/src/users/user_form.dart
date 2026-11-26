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
  });
  final UsersController controller;

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
    } else if (const {'student', 'teacher', 'parent'}.contains(r)) {
      kind = r;
    }
    gender = widget.initial['gender'] ?? '';
    grade = widget.initial['grade'] ?? '';
    branch = widget.initial['field'] ?? widget.initial['branch'] ?? '';
    employment = widget.initial['employment'] ?? '';
  }

  @override
  void dispose() {
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
    if (role.isEmpty) {
      c.formError = 'اول نقش را انتخاب کنید';
      c.emit();
      return;
    }
    final extra = <String, String>{
      for (final k in userProfileKeys) k: f[k]!.text,
      if (employment.isNotEmpty) 'employment': employment,
      if (kind == 'parent') 'relation': relation,
    };
    final r = await c.add(
      UserDraft(
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
        access: [
          for (final a in staffAccessAreas)
            if (access.contains(a.key)) a.key,
        ],
        teaches: kind == 'teacher' ? [...teaches] : const [],
        childId: kind == 'parent' ? childId : null,
      ),
    );
    if (r != null) await widget.onSaved?.call(r);
    if (r != null && mounted) Navigator.pop(context);
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
  ) => FieldBox(
    width: kFieldText,
    child: DropdownButtonFormField<T>(
      key: Key(key),
      isExpanded: true,
      initialValue: items.any((x) => x.$1 == value) ? value : null,
      decoration: InputDecoration(
        labelText: label,
        border: const OutlineInputBorder(),
      ),
      items: [
        for (final (v, t) in items)
          DropdownMenuItem<T>(value: v, child: Text(t)),
      ],
      onChanged: (v) {
        if (v is T) setState(() => onChanged(v));
      },
    ),
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
      [const ('', '—'), for (final g in c.definedGrades) (g, g)],
      (v) {
        grade = v;
        classId = null;
      },
    ),
    _drop<String>(
      'usr-f-branch',
      'رشته',
      branch,
      [const ('', '—'), for (final b in c.definedBranches) (b, b)],
      (v) {
        branch = v;
        classId = null;
      },
    ),
    _drop<int?>('usr-f-class', 'کلاس', classId, [
      (null, '—'),
      ..._classesForGrade,
    ], (v) => classId = v),
    _text('usr-f-last_gpa', 'last_gpa', 'معدل سال گذشته', numeric: true),
    _text('usr-f-covered', 'covered', 'حمایتی (بله/خیر)'),
    _text('usr-f-talent', 'talent', 'استعداد'),
    const SchoolFormSection(
      'مشخصات پدر',
      note: 'نام کاربری پدر همراه اوست و رمز اولیه‌اش کد ملی‌اش.',
    ),
    _text('usr-f-father_name', 'father_name', 'نام پدر'),
    _text('usr-f-father_nid', 'father_nid', 'کد ملی پدر', numeric: true),
    _text('usr-f-father_phone', 'father_phone', 'همراه پدر', numeric: true),
    _text('usr-f-father_edu', 'father_edu', 'تحصیلات پدر'),
    _text('usr-f-father_job', 'father_job', 'شغل پدر'),
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
    _text(
      'usr-f-guardian_phone',
      'guardian_phone',
      'همراه سرپرست',
      numeric: true,
    ),
    _text('usr-f-landline', 'landline', 'تلفن ثابت', numeric: true),
    _text('usr-f-residence', 'residence', 'محل سکونت'),
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
                  key: const Key('usr-f-access-every'),
                  onPressed: () => setState(
                    () => access.addAll(staffAccessAreas.map((a) => a.key)),
                  ),
                  child: const Text('همه'),
                ),
                TextButton(
                  key: const Key('usr-f-access-none'),
                  onPressed: () => setState(access.clear),
                  child: const Text('هیچ'),
                ),
              ],
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
                        : (v) => setState(
                            () => v == true
                                ? access.add(a.key)
                                : access.remove(a.key),
                          ),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }

  List<Widget> _exec() => [
    _drop<String>('usr-f-role', 'سمت در مدرسه', execRole, [
      for (final r in execRoleOrder) (r, roleFa[r] ?? r),
    ], (v) => execRole = v),
    const SchoolFormSection('مشخصات شخصی'),
    ..._personal(adult: true),
    ..._personnel(post: true),
    const SchoolFormSection('سطح دسترسی'),
    _accessBlock(),
  ];

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
    _drop<int?>('usr-f-child', 'فرزند (دانش‌آموز)', childId, [
      (null, '—'),
      ...c.studentRows,
    ], (v) => childId = v),
    _text('usr-f-landline', 'landline', 'تلفن ثابت', numeric: true),
    SchoolField('usr-f-address', 'نشانی', f['address']!, lines: 2),
  ];

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) => SchoolForm(
      prefix: 'usr',
      title: 'کاربر جدید',
      controller: c,
      submitLabel: c.samePerson != null ? 'شخص دیگری است — ذخیره' : 'ذخیره',
      onSubmit: _save,
      fields: [
        _kindPicker(),
        ...switch (kind) {
          'student' => _student(),
          'teacher' => _teacher(),
          'exec' => _exec(),
          'parent' => _parent(),
          _ => const <Widget>[],
        },
      ],
    ),
  );
}
