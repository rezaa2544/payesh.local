// Row 128, wave W6 — users and records. Same semantics as the web client:
//   * `PAGES.users` (manager only): search by name / mobile / national id, role filter
//     (`role-filter`), multi-select (`pick-*`) and bulk delete (`users-bulk-delete`);
//   * `PAGES.students`: a teacher sees the students of the classes they teach (from `schedule`),
//     a manager/counselor every student; each with the class name and the grade average;
//   * `PAGES.record`: a student's own attendance %, grades and profile (`userDetailRows`);
//   * the `user` form (`user-add`): name required; national id = exactly 10 digits; mobile =
//     11 digits starting with 09 (`mobile11`); a national id / mobile already used by someone
//     else is refused; a same-name person with the same birth date / father name / mobile is
//     the SAME person unless the manager confirms (web `findUserDuplicates` + `userDupBanner`);
//     a student with a parent name/mobile gets a parent account (re-used when the mobile already
//     belongs to a parent) and a `parent_links` row;
//   * `user-edit` / `user-full`: keep every other stored field; a cleared field is stored empty;
//     a student's father/mother name+mobile are copied to the linked parent accounts;
//   * `user-delete`: deleting a student also removes its parent links and every parent left
//     without a child (`deleteStudentWithParents`).
// The server enforces the same (server/sync.js: unique mobile, default credentials = national id,
// role changes by the manager only). Writes are local-first through SchoolRecords.
import 'package:payesh_data/payesh_data.dart';

import 'grade_scheme.dart';
import 'records.dart';
import 'school_structure.dart' show SchoolStructure;
import 'staff_access.dart';

/// Web `ROLE_FA`.
const Map<String, String> roleFa = {
  'manager': 'مدیر',
  'vice': 'معاون',
  'teacher': 'دبیر',
  'parent': 'ولی',
  'student': 'دانش‌آموز',
  'counselor': 'مشاور',
  'staff': 'کارمند',
  'office': 'اجرایی',
  'guard': 'نگهبان',
};

/// Row 194: the «عوامل اجرایی» of a school — every role that is not a student, a teacher or a
/// parent (مدیر، معاون، مشاور، کارمند، اجرایی، نگهبان).
const Set<String> execRoles = {
  'manager',
  'vice',
  'counselor',
  'staff',
  'office',
  'guard',
};

/// The role-filter value that stands for [execRoles] together.
const String execGroup = 'exec';

/// Role filter chips of the users page. Row 194: only «همه · دانش‌آموز · دبیر · ولی · عوامل
/// اجرایی» — معاون، مشاور و … are all under «عوامل اجرایی».
const List<(String, String)> roleFilters = [
  ('', 'همه'),
  ('student', 'دانش‌آموز'),
  ('teacher', 'دبیر'),
  ('parent', 'ولی'),
  (execGroup, 'عوامل اجرایی'),
];

/// True when [role] passes the users-page filter [filter] ('' = every role).
bool roleMatches(String filter, String role) => filter.isEmpty
    ? true
    : filter == execGroup
    ? execRoles.contains(role)
    : role == filter;

/// Extra profile fields of the user forms (web `USER_EXTRA_FORM`): key, label, numeric.
const List<(String, String, bool)> userExtraFields = [
  ('father_name', 'نام پدر', false),
  ('father_nid', 'کد ملی پدر', true),
  ('father_phone', 'همراه پدر', true),
  ('mother_name', 'نام مادر', false),
  ('mother_nid', 'کد ملی مادر', true),
  ('mother_phone', 'همراه مادر', true),
  ('guardian_phone', 'همراه سرپرست', true),
  ('landline', 'تلفن ثابت', true),
  ('residence', 'محل سکونت', false),
  ('address', 'نشانی', false),
  ('last_gpa', 'معدل سال گذشته', true),
  ('covered', 'حمایتی (بله/خیر)', false),
  ('talent', 'استعداد', false),
];

/// Row 194: personnel fields of a teacher or a staff member (manager only — never pulled by
/// another role): key, label, numeric.
const List<(String, String, bool)> personnelFields = [
  ('personnel_code', 'کد پرسنلی', true),
  ('position', 'سمت', false),
  ('degree', 'مدرک تحصیلی', false),
  ('study_field', 'رشتهٔ تحصیلی', false),
  ('employment', 'نوع استخدام', false),
  ('service_years', 'سابقهٔ خدمت (سال)', true),
  ('start_date', 'تاریخ شروع در این مدرسه', false),
];

/// Row 194: «نوع استخدام» choices.
const List<String> employmentKinds = [
  'رسمی',
  'پیمانی',
  'قراردادی',
  'حق‌التدریس',
  'خرید خدمات',
  'نیروی آزاد',
];

/// Row 194: the rest of a student's family data (education and job of each parent, who the
/// guardian is) and a parent's relation to the student: key, label, numeric.
const List<(String, String, bool)> familyFields = [
  ('father_edu', 'تحصیلات پدر', false),
  ('father_job', 'شغل پدر', false),
  ('mother_edu', 'تحصیلات مادر', false),
  ('mother_job', 'شغل مادر', false),
  ('guardian', 'سرپرست (نسبت و نام)', false),
  ('relation', 'نسبت با دانش‌آموز', false),
  ('job', 'شغل', false),
];

/// Row 202 (owner: «فرم اصلاح باید تمام اطلاعات مربوط به دانش‌آموز را داشته باشد»): the
/// rest of what a school file brings for a student (import keys), so the user form can show
/// and fix every one of them: key, label, numeric.
const List<(String, String, bool)> studentMoreFields = [
  ('failed_count', 'تعداد درس افتاده', true),
  ('father_alive', 'وضعیت حیات پدر', false),
  ('mother_alive', 'وضعیت حیات مادر', false),
  ('guardian_alive', 'وضعیت حیات سرپرست', false),
  ('sisters', 'تعداد خواهر', true),
  ('brothers', 'تعداد برادر', true),
  ('org_type', 'نوع ارگان حمایتی', false),
  ('org_percent', 'درصد حمایت', false),
  ('village', 'نام روستا', false),
  ('residence_status', 'وضعیت اقامت / تابعیت', false),
  ('shenasname_serial', 'سریال شناسنامه', false),
  ('shenasname_seri', 'سری شناسنامه', false),
];

/// Every profile key the new-user form may store.
final Set<String> userProfileKeys = {
  for (final (k, _, _) in [
    ...userExtraFields,
    ...personnelFields,
    ...familyFields,
    ...studentMoreFields,
  ])
    k,
};

/// Row 194: one subject a teacher teaches, for a پایه and a رشته (both optional).
final class TeachDraft {
  const TeachDraft({
    required this.subjectId,
    required this.subject,
    this.grade = '',
    this.branch = '',
  });
  final int subjectId;
  final String subject;
  final String grade;
  final String branch;

  Map<String, Object?> toJson() => {
    'subject_id': subjectId,
    'subject': subject,
    if (grade.trim().isNotEmpty) 'grade': grade.trim(),
    if (branch.trim().isNotEmpty) 'branch': branch.trim(),
  };

  /// «ریاضی — دهم — الکترونیک».
  String get labelFa => [
    subject,
    if (grade.trim().isNotEmpty) grade.trim(),
    if (branch.trim().isNotEmpty) branch.trim(),
  ].join(' — ');

  static List<TeachDraft> listOf(Object? raw) => [
    if (raw is List)
      for (final x in raw)
        if (x is Map && SchoolRecords.asInt(x['subject_id']) != null)
          TeachDraft(
            subjectId: SchoolRecords.asInt(x['subject_id'])!,
            subject: SchoolRecords.str(x['subject']),
            grade: SchoolRecords.str(x['grade']),
            branch: SchoolRecords.str(x['branch']),
          ),
  ];

  @override
  bool operator ==(Object other) =>
      other is TeachDraft &&
      other.subjectId == subjectId &&
      other.grade.trim() == grade.trim() &&
      other.branch.trim() == branch.trim();

  @override
  int get hashCode => Object.hash(subjectId, grade.trim(), branch.trim());
}

/// Web `fullName`: the last name is not repeated when the name already contains it.
String fullName(Map<String, Object?> u) {
  String norm(Object? v) => '${v ?? ''}'.replaceAll(RegExp(r'\s+'), ' ').trim();
  final n = norm(u['name']);
  final l = norm(u['last_name']);
  if (l.isEmpty) return n;
  if (n.isEmpty) return l;
  final nn = nameKey(n);
  final ll = nameKey(l);
  if (nn == ll || nn.endsWith(' $ll') || nn.split(' ').contains(ll)) return n;
  return '$n $l';
}

/// Web `userNameKey`: Arabic letter forms, honorifics and punctuation do not make a new person.
String nameKey(Object? v) {
  var s = '${v ?? ''}'.toLowerCase();
  s = s
      .replaceAll(RegExp('[يىئ]'), 'ی')
      .replaceAll('ك', 'ک')
      .replaceAll(RegExp('[أإآ]'), 'ا')
      .replaceAll('ؤ', 'و')
      .replaceAll(RegExp('[ةۀ]'), 'ه')
      .replaceAll(RegExp('[\u064B-\u0652\u0640\u200c]'), ' ');
  s = s
      .split(RegExp(r'\s+'))
      .where(
        (w) =>
            !{'سید', 'سیده', 'میر', 'آقا', 'خانم', 'جناب', 'سرکار'}.contains(w),
      )
      .join(' ');
  s = s.replaceAll(RegExp(r'[^\p{L}\p{N} ]', unicode: true), ' ');
  return s.replaceAll(RegExp(r'\s+'), ' ').trim();
}

/// Row 203 (owner: «نام را نوشتی آرتین رحمانی و فامیلی را رحمانی»): a user row keeps the
/// whole name in `name` (and, from an import, `first_name` / `last_name` too). The forms that
/// show «نام» and «نام خانوادگی» apart take them from here: the stored last name is cut off the
/// end of `name`; a name with no stored last name is split before its last word (two words
/// when the last is «زاده»، «نژاد»، «پور»، … : «حسین زاده»).
({String first, String last}) splitName(Map<String, Object?> u) {
  String norm(Object? v) => '${v ?? ''}'.replaceAll(RegExp(r'\s+'), ' ').trim();
  final n = norm(u['name']);
  final l = norm(u['last_name']);
  final f = norm(u['first_name']);
  final words = n.isEmpty ? <String>[] : n.split(' ');
  if (l.isNotEmpty) {
    if (n.isEmpty) return (first: f, last: l);
    final lw = l.split(' ').length;
    if (words.length > lw &&
        nameKey(words.skip(words.length - lw).join(' ')) == nameKey(l)) {
      return (first: words.take(words.length - lw).join(' '), last: l);
    }
    if (nameKey(n) == nameKey(l)) return (first: f, last: l);
    // the name does not hold the last name: [fullName] shows «name last»
    return (first: n, last: l);
  }
  if (words.length < 2) return (first: n, last: '');
  const tails = {
    'زاده', 'نژاد', 'پور', 'فر', 'راد', 'نیا', 'وند', 'منش', 'کیا', 'دوست', //
    'فرد', 'مقدم', 'لو', 'زادە', 'زاد', 'آبادی', 'اصل', 'خواه', 'پناه', 'تبار',
  };
  var cut = words.length - 1;
  if (words.length >= 3 && tails.contains(nameKey(words.last))) cut--;
  return (first: words.take(cut).join(' '), last: words.skip(cut).join(' '));
}

/// The name a user row stores for [first] + [last].
String joinName(String first, String last) =>
    '${first.trim()} ${last.trim()}'.replaceAll(RegExp(r'\s+'), ' ').trim();

/// Row 203: the official check digit of a national id (10 digits).
bool nidChecksumOk(String d) {
  if (!RegExp(r'^\d{10}$').hasMatch(d) || RegExp(r'^(\d)\1{9}$').hasMatch(d)) {
    return false;
  }
  var s = 0;
  for (var i = 0; i < 9; i++) {
    s += (d.codeUnitAt(i) - 48) * (10 - i);
  }
  final r = s % 11;
  final c = d.codeUnitAt(9) - 48;
  return r < 2 ? c == r : c == 11 - r;
}

/// Row 203: Excel drops the leading zeros of a national id («441659330» was «0441659330»).
/// The 10-digit id when the zeros put back give a valid check digit, else ''.
String nidRestoreZeros(Object? raw) {
  final d = SchoolRecords.digitsOnly(raw);
  if (d.length < 8 || d.length > 9) return '';
  final p = d.padLeft(10, '0');
  return nidChecksumOk(p) ? p : '';
}

/// Row 203 (owner: «همه جایی که مشخصات یک کاربر را می‌آورد باید همه اطلاعاتش را نشان دهد»):
/// every field of «مشخصات کامل» for a role, in sections, in the order of the user form —
/// key, label, numeric. `grade`, `field`, `class_id` and `gender` are picked from lists.
/// Row 204 (owner: «مدرسهٔ رشته‌محور هیچ‌جا اسم کلاس نیاید»): with [fieldBased] the student
/// has no «کلاس» field — پایه and رشته already place them.
List<(String, List<(String, String, bool)>)> profileSections(
  String role, {
  bool fieldBased = false,
}) {
  final all = _profileSections(role);
  if (!fieldBased) return all;
  return [
    for (final (title, list) in all)
      (
        title,
        [
          for (final f in list)
            if (f.$1 != 'class_id') f,
        ],
      ),
  ];
}

List<(String, List<(String, String, bool)>)> _profileSections(String role) {
  const personal = [
    ('first_name', 'نام', false),
    ('last_name', 'نام خانوادگی', false),
    ('national_id', 'کد ملی', true),
    ('phone', 'شمارهٔ همراه', true),
    ('birth_date', 'تاریخ تولد', false),
    ('gender', 'جنسیت', false),
  ];
  const tail = [('landline', 'تلفن ثابت', true), ('address', 'نشانی', false)];
  switch (role) {
    case 'student':
      return const [
        (
          'مشخصات دانش‌آموز',
          [
            ...personal,
            ('grade', 'پایه', false),
            ('field', 'رشته', false),
            ('class_id', 'کلاس', false),
            ('last_gpa', 'معدل سال گذشته', true),
            ('failed_count', 'تعداد درس افتاده', true),
            ('covered', 'حمایتی (بله/خیر)', false),
            ('org_type', 'نوع ارگان حمایتی', false),
            ('org_percent', 'درصد حمایت', false),
            ('talent', 'استعداد', false),
            ('shenasname_serial', 'سریال شناسنامه', false),
            ('shenasname_seri', 'سری شناسنامه', false),
            ('sisters', 'تعداد خواهر', true),
            ('brothers', 'تعداد برادر', true),
          ],
        ),
        (
          'مشخصات پدر',
          [
            ('father_name', 'نام پدر', false),
            ('father_nid', 'کد ملی پدر', true),
            ('father_phone', 'همراه پدر', true),
            ('father_edu', 'تحصیلات پدر', false),
            ('father_job', 'شغل پدر', false),
            ('father_alive', 'وضعیت حیات پدر', false),
          ],
        ),
        (
          'مشخصات مادر',
          [
            ('mother_name', 'نام مادر', false),
            ('mother_nid', 'کد ملی مادر', true),
            ('mother_phone', 'همراه مادر', true),
            ('mother_edu', 'تحصیلات مادر', false),
            ('mother_job', 'شغل مادر', false),
            ('mother_alive', 'وضعیت حیات مادر', false),
          ],
        ),
        (
          'سرپرست و نشانی',
          [
            ('guardian', 'سرپرست (نسبت و نام)', false),
            ('guardian_alive', 'وضعیت حیات سرپرست', false),
            ('guardian_phone', 'همراه سرپرست', true),
            ('landline', 'تلفن ثابت', true),
            ('residence', 'محل سکونت', false),
            ('village', 'نام روستا', false),
            ('residence_status', 'وضعیت اقامت / تابعیت', false),
            ('address', 'نشانی', false),
          ],
        ),
      ];
    case 'parent':
      return const [
        (
          'مشخصات ولی',
          [
            ...personal,
            ('relation', 'نسبت با دانش‌آموز', false),
            ('degree', 'تحصیلات', false),
            ('job', 'شغل', false),
            ...tail,
          ],
        ),
      ];
    default:
      return [
        ('مشخصات شخصی', personal),
        (
          'مشخصات پرسنلی',
          [
            ('personnel_code', 'کد پرسنلی', true),
            if (role != 'teacher') ('position', 'سمت / عنوان کار', false),
            ('degree', 'مدرک تحصیلی', false),
            ('study_field', 'رشتهٔ تحصیلی', false),
            ('employment', 'نوع استخدام', false),
            ('service_years', 'سابقهٔ خدمت (سال)', true),
            ('start_date', 'تاریخ شروع در این مدرسه', false),
            ...tail,
          ],
        ),
      ];
  }
}

/// Row 203: the Persian label of a profile key (the key itself when no list names it).
String profileLabel(String k) {
  for (final role in const ['student', 'parent', 'teacher', 'staff']) {
    for (final (_, list) in profileSections(role)) {
      for (final (key, label, _) in list) {
        if (key == k) return label;
      }
    }
  }
  for (final (key, label, _) in [
    ...userExtraFields,
    ...personnelFields,
    ...familyFields,
    ...studentMoreFields,
  ]) {
    if (key == k) return label;
  }
  return const {
        'class_name': 'گروه/شعبه (از فایل)',
        'subject': 'درس',
        'birth_place': 'محل تولد',
        'religion': 'دین',
        'nationality': 'تابعیت',
        'postal_code': 'کد پستی',
        'email': 'ایمیل',
        'note': 'یادداشت',
      }[k] ??
      k;
}

/// Keys of a user row that are bookkeeping, never shown as «سایر اطلاعات».
const Set<String> profileHiddenKeys = {
  'id',
  'name',
  'full_name',
  'role',
  'active',
  'access',
  'class_id',
  'teaches', //
  'password',
  'password_hash',
  'pass',
  'salt',
  'token',
  'pin',
  'username',
  'must_change',
  'created_at',
  'updated_at',
  'deleted',
  'deleted_at',
  'version',
  'followup_ack',
  'school_id',
  'avatar',
  'photo',
  'last_login',
  'login_at',
  'parent_name',
  'parent_phone',
  'import_id', 'import_row', 'source',
  'auto_placed', 'needs_manual', 'existing_id', 'kind', 'status', 'workshop',
};

/// Row 203: a user-row key that is bookkeeping (never shown with the profile).
bool profileHidden(String k) =>
    profileHiddenKeys.contains(k) ||
    k.startsWith('_') ||
    k.startsWith('followup') ||
    k.startsWith('import') ||
    k.startsWith('new_') ||
    k.endsWith('_at') ||
    k.endsWith('_hash') ||
    k.endsWith('_token');

/// One user as the pages show it.
final class SchoolUser {
  const SchoolUser({
    required this.id,
    required this.data,
    this.className = '',
    this.kids = const [],
    this.queued = false,
    this.grade = '',
    this.branch = '',
  });
  final int id;
  final Map<String, Object?> data;
  final String className;

  /// Web `PAGES.users` «پایه» / «رشته»: from the enrolment group (class), or the user's own
  /// fields; for a parent, from the first linked child.
  final String grade;
  final String branch;

  /// For a parent: full names of the linked students.
  final List<String> kids;
  final bool queued;

  String get name => fullName(data);
  String get role => SchoolRecords.str(data['role']);
  String get roleLabel => roleFa[role] ?? role;
  String get phone => SchoolRecords.str(data['phone']);
  String get nationalId => SchoolRecords.str(data['national_id']);
  int? get classId => SchoolRecords.asInt(data['class_id']);
  bool get active => data['active'] != false && data['active'] != 0;
  String field(String k) => SchoolRecords.str(data[k]);
}

/// A student row of `PAGES.students`.
final class StudentRow {
  const StudentRow(this.user, this.className, this.average, this.gradeCount);
  final SchoolUser user;
  final String className;

  /// Row 197 F24: the mean of the numeric grades, null (shown «—») when there is none.
  final double? average;
  final int gradeCount;
}

/// `PAGES.record` for the signed-in student.
final class StudentRecord {
  const StudentRecord({
    required this.user,
    required this.className,
    required this.presentPercent,
    required this.attendanceDays,
    required this.grades,
    required this.details,
    this.gradeValues = const [],
  });
  final SchoolUser user;
  final String className;
  final int presentPercent;
  final int attendanceDays;

  /// (subject, score, approved) — score null for a descriptive grade (row 197 Q09).
  final List<(String, num?, bool)> grades;

  /// What each grade of [grades] shows (same index): the score, or the descriptive level.
  final List<String> gradeValues;

  /// Row 197 F20: «—» rather than «۰٪» when no attendance was taken yet.
  bool get hasAttendance => attendanceDays > 0;

  /// (label, value) — web `userDetailRows`.
  final List<(String, String)> details;
}

/// Input of the new-user form.
final class UserDraft {
  const UserDraft({
    required this.name,
    this.role = 'student',
    this.classId,
    this.nationalId = '',
    this.phone = '',
    this.birthDate = '',
    this.gender = '',
    this.parentName = '',
    this.parentPhone = '',
    this.extra = const {},
    this.grade = '',
    this.branch = '',
    this.parentAccounts = const {},
    this.access = const [],
    this.teaches = const [],
    this.childId,
    this.active,
  });

  /// ردیف ۱۹۷: فقط در ویرایش — فعال/غیرفعال (null = همان قبلی).
  final bool? active;
  final String name;
  final String role;
  final int? classId;
  final String nationalId;
  final String phone;
  final String birthDate;
  final String gender;
  final String parentName;
  final String parentPhone;
  final Map<String, String> extra;

  /// Row 194: a student's پایه and رشته.
  final String grade;
  final String branch;

  /// Row 194: `father` / `mother` — make (or re-use) that parent's account from the father_* /
  /// mother_* fields of [extra], linked to the new student.
  final Set<String> parentAccounts;

  /// Row 194: a staff member's «سطح دسترسی» (keys of [staffAccessAreas]).
  final List<String> access;

  /// Row 194: what a teacher teaches.
  final List<TeachDraft> teaches;

  /// Row 194: a new parent's child (a `parent_links` row is made).
  final int? childId;
}

/// The add form found people who look like the same person (web `userDupBanner`).
final class SamePersonFailure extends RecordFailure {
  SamePersonFailure(this.matches)
    : super(
        'confirm',
        'کاربری با همین نام و مشخصات هست: ${matches.map((u) => u.name).join('، ')} — '
            'اگر شخص دیگری است، دوباره «ذخیره» را بزنید',
      );
  final List<SchoolUser> matches;
}

/// Users, students and records on the device.
final class UserDirectory {
  UserDirectory(this.db);
  final SchoolRecords db;

  static const String users = 'users';

  bool get canManage => db.canWrite(users);

  /// Roles that see every student of the school (web `PAGES.students`).
  /// Row 187: only the manager (معاون = مدیر via `permRole`); the counselor sees its referral
  /// queue only (p2), as the server scope does.
  static const Set<String> wholeSchool = {'manager'};

  Future<Map<int, String>> _classNames() async => {
    for (final c in await db.allOrEmpty('classes'))
      c.id: SchoolRecords.str(c.data['name']),
  };

  void _requireManager() {
    if (!canManage) {
      throw const RecordFailure(
        'not_allowed',
        'مدیریت کاربران فقط برای مدیر است',
      );
    }
  }

  /// `PAGES.users`: every user (manager only), filtered by role and search, sorted by name.
  Future<List<SchoolUser>> list({String role = '', String query = ''}) async {
    _requireManager();
    // row 200: classes read once; a parent's children come from an index, not a scan of
    // every link per parent
    return listFrom(
      rows: await db.all(users),
      classRows: await db.allOrEmpty('classes'),
      links: await db.allOrEmpty('parent_links'),
      role: role,
      query: query,
    );
  }

  /// Row 201: [list] from rows the caller already read (the users page reads every
  /// collection once per load).
  List<SchoolUser> listFrom({
    required List<EngineRow> rows,
    required List<EngineRow> classRows,
    required List<EngineRow> links,
    String role = '',
    String query = '',
  }) {
    _requireManager();
    final classes = {
      for (final c in classRows) c.id: SchoolRecords.str(c.data['name']),
    };
    final queued = db.queuedIds(users);
    final byId = {for (final r in rows) r.id: r};
    final kidsOf = <int, List<EngineRow>>{};
    for (final l in links) {
      final p = SchoolRecords.asInt(l.data['parent_id']);
      final k = byId[SchoolRecords.asInt(l.data['student_id'])];
      if (p != null && k != null) (kidsOf[p] ??= []).add(k);
    }
    final groups = {for (final c in classRows) c.id: c.data};
    final q = query.trim();
    final out = <SchoolUser>[];
    for (final r in rows) {
      final u = SchoolUser(id: r.id, data: r.data);
      if (!roleMatches(role, u.role)) continue;
      if (q.isNotEmpty &&
          !SchoolRecords.str(r.data['name']).contains(q) &&
          !u.phone.contains(q) &&
          !u.nationalId.contains(q)) {
        continue;
      }
      final kidRows = u.role == 'parent'
          ? (kidsOf[r.id] ?? const <EngineRow>[])
          : const <EngineRow>[];
      final subject = kidRows.isNotEmpty ? kidRows.first.data : r.data;
      final grp =
          groups[SchoolRecords.asInt(subject['class_id'])] ??
          const <String, Object?>{};
      String pick(List<Object?> xs) => xs
          .map(SchoolRecords.str)
          .firstWhere((x) => x.isNotEmpty, orElse: () => '');
      out.add(
        SchoolUser(
          id: r.id,
          data: r.data,
          className: classes[SchoolRecords.asInt(r.data['class_id'])] ?? '',
          kids: [for (final k in kidRows) fullName(k.data)],
          queued: queued.contains(r.id),
          grade: pick([grp['grade'], subject['grade']]),
          branch: pick([grp['branch'], subject['field'], subject['branch']]),
        ),
      );
    }
    out.sort((a, b) => a.name.compareTo(b.name));
    return out;
  }

  /// `PAGES.students`.
  Future<List<StudentRow>> students({String query = ''}) async {
    final all = wholeSchool.contains(db.role);
    if (!all && db.role != 'teacher') {
      throw const RecordFailure(
        'not_reader',
        'نقش شما به فهرست دانش‌آموزان دسترسی ندارد',
      );
    }
    final mine = <int>{
      if (!all)
        for (final s in await db.allOrEmpty('schedule'))
          if (SchoolRecords.asInt(s.data['teacher_id']) == db.uid)
            ?SchoolRecords.asInt(s.data['class_id']),
    };
    final classes = await _classNames();
    // row 200: scores grouped once per student (was a scan of every grade per student)
    final scores = <int, List<num?>>{};
    for (final x in await db.allOrEmpty('grades')) {
      final sid = SchoolRecords.asInt(x.data['student_id']);
      if (sid == null) continue;
      // row 197 F24: a missing or descriptive score is not a 0
      (scores[sid] ??= []).add(averageScore(x.data));
    }
    final q = query.trim();
    final out = <StudentRow>[];
    for (final r in await db.all(users)) {
      if (r.data['role'] != 'student') continue;
      final cid = SchoolRecords.asInt(r.data['class_id']);
      if (!all && !mine.contains(cid)) continue;
      final u = SchoolUser(
        id: r.id,
        data: r.data,
        className: classes[cid] ?? '',
      );
      if (q.isNotEmpty && !SchoolRecords.str(r.data['name']).contains(q)) {
        continue;
      }
      final g = scores[r.id] ?? const <num?>[];
      out.add(StudentRow(u, u.className, averageOf(g), g.length));
    }
    out.sort((a, b) => a.user.name.compareTo(b.user.name));
    return out;
  }

  /// `PAGES.record` of the signed-in student.
  Future<StudentRecord> myRecord() async {
    if (db.role != 'student') {
      throw const RecordFailure('not_reader', 'پرونده فقط برای دانش‌آموز است');
    }
    final me = await db.existing(users, db.uid, 'پروندهٔ شما');
    final classes = await _classNames();
    final subjects = {
      for (final s in await db.allOrEmpty('subjects'))
        s.id: SchoolRecords.str(s.data['name']),
    };
    final att = [
      for (final a in await db.allOrEmpty('attendance'))
        if (SchoolRecords.asInt(a.data['student_id']) == db.uid) a,
    ];
    final present = att.where((a) => a.data['status'] == 'present').length;
    final mine = [
      for (final g in await db.allOrEmpty('grades'))
        if (SchoolRecords.asInt(g.data['student_id']) == db.uid) g,
    ];
    String subjectOf(Map<String, Object?> g) {
      final n = subjects[SchoolRecords.asInt(g['subject_id'])] ?? '';
      // row 197 Q08: a module grade names its module
      return moduleOfTerm(g['term']) == null ? n : '$n — ${g['term']}';
    }

    final grades = [
      for (final g in mine)
        (
          subjectOf(g.data),
          SchoolRecords.str(g.data['kind']) == 'descriptive'
              ? null
              : num.tryParse('${g.data['score'] ?? ''}'),
          g.data['status'] == 'approved',
        ),
    ];
    return StudentRecord(
      user: SchoolUser(id: me.id, data: me.data),
      className: classes[SchoolRecords.asInt(me.data['class_id'])] ?? '',
      presentPercent: att.isEmpty ? 0 : (present * 100 / att.length).round(),
      attendanceDays: att.length,
      grades: grades,
      gradeValues: [for (final g in mine) gradeValueText(g.data)],
      details: detailRows(me.data),
    );
  }

  /// Web `userDetailRows`. Row 203 (owner: «همه جایی که مشخصات یک کاربر را می‌آورد باید
  /// همه اطلاعاتش را نشان دهد»): every field of the role ([profileSections]) the row has —
  /// پایه and رشته included — then whatever else it holds (an import column no form names).
  static List<(String, String)> detailRows(Map<String, Object?> u) {
    final out = <(String, String)>[];
    final seen = <String>{'first_name', 'last_name', 'class_id'};
    void add(String label, Object? v) {
      final t = SchoolRecords.str(v);
      if (t.isNotEmpty && t != '—') out.add((label, t));
    }

    for (final (_, list) in profileSections(SchoolRecords.str(u['role']))) {
      for (final (k, label, _) in list) {
        if (!seen.add(k)) continue;
        add(label, u[k]);
      }
    }
    final rest = [
      for (final e in u.entries)
        if (!seen.contains(e.key) &&
            !profileHidden(e.key) &&
            e.value is! Map &&
            e.value is! List)
          e.key,
    ]..sort();
    for (final k in rest) {
      add(profileLabel(k), u[k]);
    }
    return out;
  }

  /// Validated mobile: '' or 11 digits starting with 09.
  static String _mobile(String raw, {String whatFa = 'شمارهٔ همراه'}) {
    if (SchoolRecords.digitsOnly(raw).isEmpty) return '';
    final m = SchoolRecords.mobile11(raw);
    if (!RegExp(r'^09\d{9}$').hasMatch(m)) {
      throw RecordFailure(
        'invalid',
        '$whatFa «${raw.trim()}» درست نیست — باید ۱۱ رقم و با ۰۹ شروع شود',
      );
    }
    return m;
  }

  static String _nid(String raw, {String whatFa = 'کد ملی'}) {
    final d = SchoolRecords.digitsOnly(raw);
    if (d.isNotEmpty && d.length != 10) {
      // row 203: the zeros Excel dropped («441659330» ⇒ «0441659330»)
      final z = nidRestoreZeros(d);
      if (z.isNotEmpty) return z;
      throw RecordFailure('invalid', '$whatFa باید دقیقاً ۱۰ رقم باشد');
    }
    return d;
  }

  Future<void> _uniquePhone(
    String phone,
    int? except,
    List<EngineRowLike> rows,
  ) async {
    if (phone.isEmpty) return;
    for (final r in rows) {
      if (r.id == except) continue;
      if (SchoolRecords.digitsOnly(r.data['phone']) == phone) {
        throw RecordFailure(
          'duplicate',
          'این شمارهٔ همراه برای «${fullName(r.data)}» ثبت شده است — دو کاربر نمی‌توانند یک نام کاربری داشته باشند',
        );
      }
    }
  }

  Future<List<EngineRowLike>> _rows() async => [
    for (final r in await db.all(users)) EngineRowLike(r.id, r.data, r.version),
  ];

  /// `user` form. [samePersonOk] = the manager confirmed after a [SamePersonFailure].
  Future<RecordWrite> add(UserDraft d, {bool samePersonOk = false}) async {
    _requireManager();
    final name = d.name.trim();
    if (name.isEmpty) throw const RecordFailure('invalid', 'نام را بنویسید');
    if (!roleFa.containsKey(d.role)) {
      throw RecordFailure('invalid', 'نقش «${d.role}» شناخته نیست');
    }
    final nid = _nid(d.nationalId);
    final phone = _mobile(d.phone);
    final parentPhone = _mobile(d.parentPhone, whatFa: 'همراه ولی');
    final rows = await _rows();
    final nk = nameKey(name);
    final same = <SchoolUser>[];
    for (final r in rows) {
      if (nid.isNotEmpty &&
          SchoolRecords.digitsOnly(r.data['national_id']) == nid) {
        throw RecordFailure(
          'duplicate',
          'این کد ملی برای «${fullName(r.data)}» ثبت شده است — همان شخص است؛ به‌جای ساختن کاربر تازه، همان را ویرایش کنید',
        );
      }
      if (phone.isNotEmpty &&
          SchoolRecords.digitsOnly(r.data['phone']) == phone) {
        throw RecordFailure(
          'duplicate',
          'این شمارهٔ همراه برای «${fullName(r.data)}» ثبت شده است — همان شخص است؛ همان را ویرایش کنید',
        );
      }
      if (nk.isEmpty || nameKey(r.data['name']) != nk) continue;
      final dob = d.birthDate.trim();
      final father = nameKey(d.extra['father_name']);
      if ((dob.isNotEmpty &&
              SchoolRecords.str(r.data['birth_date']).startsWith(dob)) ||
          (father.isNotEmpty && nameKey(r.data['father_name']) == father)) {
        same.add(SchoolUser(id: r.id, data: r.data));
      }
    }
    if (same.isNotEmpty && !samePersonOk) throw SamePersonFailure(same);
    final row = <String, Object?>{
      'name': name,
      'role': d.role,
      'class_id': d.classId,
      'national_id': nid,
      'phone': phone,
      if (d.birthDate.trim().isNotEmpty) 'birth_date': d.birthDate.trim(),
      if (d.gender.trim().isNotEmpty) 'gender': d.gender.trim(),
      'active': true,
      for (final k in userProfileKeys)
        if ((d.extra[k] ?? '').trim().isNotEmpty)
          k: k.endsWith('_phone')
              ? (SchoolRecords.mobile11(d.extra[k]).isEmpty
                    ? d.extra[k]!.trim()
                    : SchoolRecords.mobile11(d.extra[k]))
              : d.extra[k]!.trim(),
      if (d.role == 'student' && d.grade.trim().isNotEmpty)
        'grade': d.grade.trim(),
      if (d.role == 'student' && d.branch.trim().isNotEmpty)
        'field': d.branch.trim(),
      if (d.role == 'teacher' && d.teaches.isNotEmpty) ...{
        'teaches': [
          for (final t in {...d.teaches}) t.toJson(),
        ],
        'subject': {for (final t in d.teaches) t.subject}.join('، '),
      },
      if (grantableRoles.contains(d.role))
        'access': accessToStore(d.role, d.access),
    };
    db.precheck(users, row);
    // Row 194: the parents' accounts are planned (and checked) before anything is written.
    final plan = d.role == 'student'
        ? await _parentPlan(d, name, nid, phone, parentPhone, rows)
        : const <_ParentPlan>[];
    final child = d.role == 'parent' && d.childId != null
        ? await db.existing(users, d.childId!, 'این دانش‌آموز')
        : null;
    db.requireRoom(
      1 +
          plan.fold<int>(0, (n, p) => n + (p.reuse == null ? 2 : 1)) +
          (child == null ? 0 : 1),
    );
    final keys = <String>[];
    final id = await db.newId(users);
    keys.add(await db.put(users, id, row));
    var msg =
        'کاربر ساخته شد — نام کاربری: ${phone.isNotEmpty ? phone : (nid.isNotEmpty ? nid : 'ثبت نشده')}'
        '، رمز اولیه: ${nid.isNotEmpty ? 'کد ملی' : 'با «کاربری» تعیین کنید'}';
    final made = <String, int>{};
    for (final p in plan) {
      var pid = p.reuse?.id ?? (p.phone.isEmpty ? null : made[p.phone]);
      final fresh = pid == null;
      if (pid == null) {
        pid = await db.newId(users);
        keys.add(
          await db.put(users, pid, {
            'name': p.name,
            'role': 'parent',
            'phone': p.phone,
            if (p.nid.isNotEmpty) 'national_id': p.nid,
            'relation': p.relationFa,
            'active': true,
          }),
        );
        if (p.phone.isNotEmpty) made[p.phone] = pid;
      }
      final lid = await db.newId('parent_links');
      keys.add(
        await db.put('parent_links', lid, {
          'parent_id': pid,
          'student_id': id,
          'relation': p.relation,
        }),
      );
      msg += p.legacy
          ? (fresh ? ' · حساب ولی هم ساخته شد' : ' · به ولیِ موجود وصل شد')
          : fresh
          ? ' · حساب ${p.whoFa} ساخته شد'
          : ' · به حساب موجود ${p.whoFa} وصل شد';
    }
    if (child != null) {
      final lid = await db.newId('parent_links');
      keys.add(
        await db.put('parent_links', lid, {
          'parent_id': id,
          'student_id': child.id,
          'relation': switch ((d.extra['relation'] ?? '').trim()) {
            'پدر' => 'father',
            'مادر' => 'mother',
            _ => 'guardian',
          },
        }),
      );
      msg += ' · به «${fullName(child.data)}» وصل شد';
    }
    return RecordWrite(msg, id: id, keys: keys);
  }

  /// Row 203 «ثبت موقت در لیست» (owner: «دانش‌آموز اطلاعاتش ناقص است ولی لازم است توی لیست
  /// کلاسی اسمش ثبت شود»): [add] with only what is valid — a national id / mobile that is not
  /// 10 / 11 digits (or belongs to another user), a parent's wrong national id or mobile, are
  /// left out (they stay on the follow-up row to be completed). The name is still required.
  /// Returns the write and the keys that were left out.
  Future<(RecordWrite, List<String>)> addTemporary(
    UserDraft d, {
    bool samePersonOk = false,
  }) async {
    _requireManager();
    final rows = await _rows();
    final dropped = <String>[];
    bool usedBy(String k, String v) =>
        rows.any((r) => SchoolRecords.digitsOnly(r.data[k]) == v);
    String okNid(String k, String raw, {bool unique = false}) {
      final v = SchoolRecords.digitsOnly(raw);
      if (v.isEmpty) return '';
      // the check digit too: a wrong id stays for the follow-up row to fix
      final z = v.length == 10
          ? (nidChecksumOk(v) ? v : '')
          : nidRestoreZeros(v);
      if (z.isEmpty || (unique && usedBy('national_id', z))) {
        dropped.add(k);
        return '';
      }
      return z;
    }

    String okPhone(String k, String raw, {bool unique = false}) {
      if (SchoolRecords.digitsOnly(raw).isEmpty) return '';
      final m = SchoolRecords.mobile11(raw);
      if (!RegExp(r'^09\d{9}$').hasMatch(m) || (unique && usedBy('phone', m))) {
        dropped.add(k);
        return '';
      }
      return m;
    }

    final phone = okPhone('phone', d.phone, unique: true);
    final extra = <String, String>{...d.extra};
    for (final k in extra.keys.toList()) {
      final v = extra[k]!;
      if (k.endsWith('_nid')) {
        extra[k] = okNid(k, v);
      } else if (k.endsWith('_phone')) {
        var m = okPhone(k, v);
        // a parent's mobile that is the student's own, or a teacher's / staff member's
        // username, cannot make the parent's account
        if (m.isNotEmpty &&
            (m == phone ||
                rows.any(
                  (r) =>
                      r.data['role'] != 'parent' &&
                      SchoolRecords.digitsOnly(r.data['phone']) == m,
                ))) {
          dropped.add(k);
          m = '';
        }
        extra[k] = m;
      }
    }
    final clean = UserDraft(
      name: d.name,
      role: d.role,
      classId: d.classId,
      nationalId: okNid('national_id', d.nationalId, unique: true),
      phone: phone,
      birthDate: d.birthDate,
      gender: d.gender,
      extra: extra,
      grade: d.grade,
      branch: d.branch,
      parentAccounts: d.parentAccounts,
      access: d.access,
      teaches: d.teaches,
      childId: d.childId,
    );
    final w = await add(clean, samePersonOk: samePersonOk);
    return (
      RecordWrite(
        'ثبت موقت شد — «${d.name.trim()}» در فهرست کاربران و '
        '${(await SchoolStructure.read(db)).fieldBased ? 'پایه و رشته‌اش' : 'کلاسش'} هست و برای تکمیل مشخصات '
        'در «پیگیری» می‌ماند',
        id: w.id,
        keys: w.keys,
      ),
      dropped,
    );
  }

  /// Row 194: which parent accounts a new student brings — the father and the mother from the
  /// father_* / mother_* fields (when ticked), else the old single «ولی» name + mobile. A parent
  /// already in the school (same mobile or national code) is re-used, never duplicated; a
  /// mobile of a non-parent user is refused (it is that user's username).
  Future<List<_ParentPlan>> _parentPlan(
    UserDraft d,
    String name,
    String nid,
    String phone,
    String parentPhone,
    List<EngineRowLike> rows,
  ) async {
    final want = <(String, String, String, String)>[
      for (final rel in ['father', 'mother'])
        if (d.parentAccounts.contains(rel))
          (
            rel,
            (d.extra['${rel}_name'] ?? '').trim(),
            d.extra['${rel}_nid'] ?? '',
            d.extra['${rel}_phone'] ?? '',
          ),
    ];
    if (want.isEmpty &&
        (d.parentName.trim().isNotEmpty || parentPhone.isNotEmpty)) {
      want.add(('guardian', d.parentName.trim(), '', parentPhone));
    }
    final out = <_ParentPlan>[];
    for (final (rel, pName, rawNid, rawPhone) in want) {
      // the old single «ولی» of the form / an import row
      final legacy = rel == 'guardian';
      final who = rel == 'mother' ? 'مادر' : (legacy ? 'ولی' : 'پدر');
      final m = _mobile(rawPhone, whatFa: 'همراه $who');
      var n = _nid(rawNid, whatFa: 'کد ملی $who');
      if (pName.isEmpty && m.isEmpty && n.isEmpty) continue;
      if (m.isNotEmpty && m == phone) {
        throw RecordFailure(
          'invalid',
          'همراه $who با همراه خود دانش‌آموز یکی است — نام کاربری هر نفر جداست',
        );
      }
      EngineRowLike? reuse;
      for (final r in rows) {
        if (r.data['role'] != 'parent') continue;
        if ((m.isNotEmpty && SchoolRecords.digitsOnly(r.data['phone']) == m) ||
            (n.isNotEmpty &&
                SchoolRecords.digitsOnly(r.data['national_id']) == n)) {
          reuse = r;
          break;
        }
      }
      if (reuse == null) {
        await _uniquePhone(m, null, rows);
        // the code of a parent who is also a teacher/staff here stays on that user only
        if (n.isNotEmpty &&
            (n == nid ||
                rows.any(
                  (r) => SchoolRecords.digitsOnly(r.data['national_id']) == n,
                ))) {
          n = '';
        }
      }
      out.add(
        _ParentPlan(
          relation: legacy ? 'father' : rel,
          legacy: legacy,
          whoFa: who,
          name: pName.isNotEmpty ? pName : '$who $name',
          nid: n,
          phone: m,
          reuse: reuse,
        ),
      );
    }
    return out;
  }

  /// `user-edit`: name, mobile, active, birth date, gender and the extra fields.
  Future<RecordWrite> edit(
    int id, {
    required String name,
    required String phone,
    required bool active,
    String? birthDate,
    String? gender,
    Map<String, String> extra = const {},
  }) async {
    _requireManager();
    final prev = await db.existing(users, id, 'این کاربر');
    final m = _mobile(phone);
    await _uniquePhone(m, id, await _rows());
    final data = <String, Object?>{
      ...prev.data,
      'name': name.trim().isEmpty ? prev.data['name'] : name.trim(),
      'phone': m,
      'active': active,
      'birth_date': ?birthDate?.trim(),
      'gender': ?gender?.trim(),
    };
    _extras(data, prev.data, extra);
    _alignName(data, prev.data);
    if (_same(data, prev.data)) return const RecordWrite('تغییری نبود');
    final k = await db.put(users, id, data, prev: prev);
    return RecordWrite('کاربر ویرایش شد', id: id, keys: [k]);
  }

  /// ردیف ۱۹۷ (F45/F47): ویرایش کامل هر نقش با همان فهرست فرم «کاربر جدید» — پیش از این
  /// ویرایش برای همه فیلدهای دانش‌آموز را نشان می‌داد و پس از ساخت، تیک‌های دسترسی کارکنان،
  /// درس‌های دبیر، پایه/رشته/کلاس دانش‌آموز و نسبت ولی هرگز عوض نمی‌شد.
  ///   * نقش دانش‌آموز/دبیر/ولی ثابت می‌ماند (جابه‌جایی آن پرونده را می‌شکند)؛ میان سمت‌های
  ///     «عوامل اجرایی» (معاون، مشاور، کارمند، …) جابه‌جایی مجاز است؛
  ///   * کادر خالی = پاک شدن همان مقدار (مثل ویرایش قبلی)؛ حساب پدر/مادر در ویرایش ساخته نمی‌شود.
  Future<RecordWrite> update(int id, UserDraft d) async {
    _requireManager();
    final prev = await db.existing(users, id, 'این کاربر');
    final prevRole = SchoolRecords.str(prev.data['role']);
    final name = d.name.trim();
    if (name.isEmpty) throw const RecordFailure('invalid', 'نام را بنویسید');
    var role = prevRole;
    if (d.role != prevRole) {
      if (execRoles.contains(prevRole) && execRoles.contains(d.role)) {
        role = d.role;
      } else {
        throw RecordFailure(
          'invalid',
          'نقش «${roleFa[prevRole] ?? prevRole}» را نمی‌شود به «${roleFa[d.role] ?? d.role}» '
              'تغییر داد — برای نقش دیگر کاربر تازه بسازید',
        );
      }
    }
    final nid = _nid(d.nationalId);
    final phone = _mobile(d.phone);
    final rows = await _rows();
    for (final r in rows) {
      if (r.id == id) continue;
      if (nid.isNotEmpty &&
          SchoolRecords.digitsOnly(r.data['national_id']) == nid) {
        throw RecordFailure(
          'duplicate',
          'این کد ملی برای «${fullName(r.data)}» ثبت شده است',
        );
      }
    }
    await _uniquePhone(phone, id, rows);
    // مدرسه بی‌مدیر نماند: آخرین مدیر را نمی‌شود به سمت دیگر برد
    if (prevRole == 'manager' &&
        role != 'manager' &&
        !rows.any(
          (r) =>
              r.id != id &&
              SchoolRecords.str(r.data['role']) == 'manager' &&
              r.data['active'] != false,
        )) {
      throw const RecordFailure(
        'invalid',
        'این تنها مدیر مدرسه است — اول مدیر دیگری تعریف کنید، بعد سمت او را عوض کنید',
      );
    }
    final data = <String, Object?>{...prev.data, 'name': name, 'role': role};
    _alignName(data, prev.data);
    // کادر خالی فقط مقدار موجود را پاک می‌کند؛ کلید تازهٔ خالی ساخته نمی‌شود («تغییری نبود»)
    void put(String k, String v) {
      if (v.isNotEmpty) {
        data[k] = v;
      } else if (SchoolRecords.str(prev.data[k]).isNotEmpty) {
        data[k] = '';
      }
    }

    put('national_id', nid);
    put('phone', phone);
    put('birth_date', d.birthDate.trim());
    put('gender', d.gender.trim());
    if (d.active != null) data['active'] = d.active;
    _extras(data, prev.data, {
      for (final k in userProfileKeys)
        if (d.extra.containsKey(k)) k: d.extra[k]!,
    });
    if (role == 'student') {
      if (d.classId != null || prev.data['class_id'] != null) {
        data['class_id'] = d.classId;
      }
      put('grade', d.grade.trim());
      put('field', d.branch.trim());
    }
    if (role == 'teacher' &&
        (d.teaches.isNotEmpty ||
            TeachDraft.listOf(prev.data['teaches']).isNotEmpty)) {
      final t = {...d.teaches}.toList();
      data['teaches'] = [for (final x in t) x.toJson()];
      data['subject'] = {for (final x in t) x.subject}.join('، ');
    }
    if (grantableRoles.contains(role)) {
      data['access'] = accessToStore(role, d.access);
    } else if (prev.data.containsKey('access')) {
      data['access'] = const <String>[];
    }
    db.precheck(users, data);
    // ولی: نسبت در پیوندهای فرزند هم عوض شود و فرزند تازه (اگر انتخاب شد) وصل شود
    final relKey = switch (SchoolRecords.str(data['relation'])) {
      'پدر' => 'father',
      'مادر' => 'mother',
      _ => 'guardian',
    };
    final links = role == 'parent'
        ? [
            for (final l in await db.allOrEmpty('parent_links'))
              if (SchoolRecords.asInt(l.data['parent_id']) == id) l,
          ]
        : const <EngineRow>[];
    final relinks =
        role == 'parent' && SchoolRecords.str(data['relation']).isNotEmpty
        ? [
            for (final l in links)
              if (SchoolRecords.str(l.data['relation']) != relKey &&
                  !const {
                    'پدر',
                    'مادر',
                  }.contains(SchoolRecords.str(l.data['relation'])))
                l,
          ]
        : const <EngineRow>[];
    final child =
        role == 'parent' &&
            d.childId != null &&
            !links.any(
              (l) => SchoolRecords.asInt(l.data['student_id']) == d.childId,
            )
        ? await db.existing(users, d.childId!, 'این دانش‌آموز')
        : null;
    final same = _same(data, prev.data);
    if (same && relinks.isEmpty && child == null) {
      return const RecordWrite('تغییری نبود');
    }
    db.requireRoom((same ? 0 : 1) + relinks.length + (child == null ? 0 : 1));
    final keys = <String>[if (!same) await db.put(users, id, data, prev: prev)];
    for (final l in relinks) {
      keys.add(
        await db.put('parent_links', l.id, {
          ...l.data,
          'relation': relKey,
        }, prev: l),
      );
    }
    var msg = 'کاربر ویرایش شد';
    if (role != prevRole) msg += ' — سمت: ${roleFa[role] ?? role}';
    if (child != null) {
      final lid = await db.newId('parent_links');
      keys.add(
        await db.put('parent_links', lid, {
          'parent_id': id,
          'student_id': child.id,
          'relation': relKey,
        }),
      );
      msg += ' · به «${fullName(child.data)}» وصل شد';
    }
    return RecordWrite(msg, id: id, keys: keys);
  }

  /// W7 `user-creds`, username part: the mobile number IS the username — an ordinary users
  /// field, so it goes through the offline queue (the server re-checks uniqueness).
  Future<RecordWrite> setUsername(int id, String phone) async {
    _requireManager();
    final prev = await db.existing(users, id, 'این کاربر');
    final m = _mobile(phone);
    if (m.isEmpty) {
      throw const RecordFailure(
        'invalid',
        'نام کاربری (شمارهٔ همراه) را بنویسید — ۱۱ رقم و با ۰۹',
      );
    }
    await _uniquePhone(m, id, await _rows());
    if (m == '${prev.data['phone'] ?? ''}') {
      return const RecordWrite('تغییری نبود');
    }
    final k = await db.put(users, id, {...prev.data, 'phone': m}, prev: prev);
    return RecordWrite('نام کاربری در صف ارسال است', id: id, keys: [k]);
  }

  /// Row 203: `first_name` / `last_name` follow a changed `name` — a stale last name made
  /// [fullName] show «آرتین کریمی رحمانی» after the name was edited.
  static void _alignName(Map<String, Object?> data, Map<String, Object?> prev) {
    final n = SchoolRecords.str(data['name']);
    if (nameKey(n) == nameKey(prev['name'])) return;
    final l = SchoolRecords.str(data['last_name']);
    final f = SchoolRecords.str(data['first_name']);
    if (l.isEmpty && f.isEmpty) return;
    final words = n.split(RegExp(r'\s+'));
    final lw = l.isEmpty ? 0 : l.split(RegExp(r'\s+')).length;
    if (lw > 0 &&
        words.length > lw &&
        nameKey(words.skip(words.length - lw).join(' ')) == nameKey(l)) {
      data['first_name'] = words.take(words.length - lw).join(' ');
      return;
    }
    // row 204 (owner: «نام هیچ‌وقت نام خانوادگی را نداشته باشد»): a new last name is cut
    // off the new name, so «نام» and «نام خانوادگی» stay apart and never repeat each other
    final cut = splitName({'name': n});
    data['first_name'] = cut.first;
    data['last_name'] = cut.last;
  }

  static void _extras(
    Map<String, Object?> data,
    Map<String, Object?> prev,
    Map<String, String> extra,
  ) {
    for (final e in extra.entries) {
      final v = e.value.trim();
      if (v.isNotEmpty) {
        data[e.key] =
            e.key.endsWith('_phone') && SchoolRecords.mobile11(v).isNotEmpty
            ? SchoolRecords.mobile11(v)
            : v;
      } else if (SchoolRecords.str(prev[e.key]).isNotEmpty) {
        data[e.key] = '';
      }
    }
  }

  static bool _same(Map<String, Object?> a, Map<String, Object?> b) {
    if (a.length != b.length) return false;
    for (final k in a.keys) {
      if ('${a[k]}' != '${b[k]}') return false;
    }
    return true;
  }

  /// `user-full`: the complete profile; a student's parents follow their name/mobile.
  Future<RecordWrite> saveFull(int id, Map<String, String> fields) async {
    _requireManager();
    final prev = await db.existing(users, id, 'کاربر');
    final data = <String, Object?>{...prev.data};
    final f = {...fields};
    // row 203: «نام» and «نام خانوادگی» apart; `name` keeps the whole name
    if (f.containsKey('first_name') || f.containsKey('last_name')) {
      final was = splitName(prev.data);
      final fn = (f['first_name'] ?? was.first).trim();
      final ln = (f['last_name'] ?? was.last).trim();
      f['name'] = joinName(fn, ln);
      f['first_name'] = fn;
      f['last_name'] = ln;
    }
    // row 203: the class of a student is picked in «مشخصات کامل» too
    if (f.containsKey('class_id')) {
      final c = f.remove('class_id')!.trim();
      final cid = int.tryParse(c);
      if (cid != null || prev.data['class_id'] != null) data['class_id'] = cid;
    }
    if (f.containsKey('phone')) f['phone'] = _mobile(f['phone']!);
    if (f.containsKey('national_id')) {
      f['national_id'] = _nid(f['national_id']!);
    }
    const phones = {
      'father_phone': 'همراه پدر',
      'mother_phone': 'همراه مادر',
      'guardian_phone': 'همراه سرپرست',
    };
    for (final MapEntry(:key, :value) in phones.entries) {
      if (f.containsKey(key)) f[key] = _mobile(f[key]!, whatFa: value);
    }
    _extras(data, prev.data, f);
    if (SchoolRecords.str(data['name']).isEmpty) {
      throw const RecordFailure('invalid', 'نام را بنویسید');
    }
    final rows = await _rows();
    await _uniquePhone(SchoolRecords.str(data['phone']), id, rows);
    if (_same(data, prev.data)) return const RecordWrite('تغییری نبود');
    final linked = (await db.allOrEmpty('parent_links'))
        .where((l) => SchoolRecords.asInt(l.data['student_id']) == id)
        .length;
    db.requireRoom(1 + linked);
    final keys = [await db.put(users, id, data, prev: prev)];
    var parents = 0;
    if (prev.data['role'] == 'student') {
      // the web client links with «father» (user form) or «پدر»/«مادر» (import) — both count
      const rel = {
        'پدر': ('father_name', 'father_phone'),
        'father': ('father_name', 'father_phone'),
        'مادر': ('mother_name', 'mother_phone'),
        'mother': ('mother_name', 'mother_phone'),
      };
      for (final l in await db.allOrEmpty('parent_links')) {
        if (SchoolRecords.asInt(l.data['student_id']) != id) continue;
        final hit = rel[SchoolRecords.str(l.data['relation'])];
        if (hit == null) continue;
        final p = await db.get(
          users,
          SchoolRecords.asInt(l.data['parent_id']) ?? -1,
        );
        if (p == null) continue;
        final pd = {...p.data};
        final n = SchoolRecords.str(data[hit.$1]);
        final ph = SchoolRecords.str(data[hit.$2]);
        if (n.isNotEmpty) pd['name'] = n;
        if (ph.isNotEmpty) pd['phone'] = ph;
        if (_same(pd, p.data)) continue;
        await _uniquePhone(ph, p.id, rows);
        keys.add(await db.put(users, p.id, pd, prev: p));
        parents++;
      }
    }
    return RecordWrite(
      'مشخصات ذخیره شد${parents > 0 ? ' — حساب ولی هم به‌روز شد' : ''}',
      id: id,
      keys: keys,
    );
  }

  /// Names of the parents that would go with this student (for the confirm dialog).
  Future<List<String>> orphanParentsOf(int studentId) async {
    final links = await db.allOrEmpty('parent_links');
    final mine = links.where(
      (l) => SchoolRecords.asInt(l.data['student_id']) == studentId,
    );
    final out = <String>[];
    for (final pid in {
      for (final l in mine) ?SchoolRecords.asInt(l.data['parent_id']),
    }) {
      final others = links.any(
        (l) =>
            SchoolRecords.asInt(l.data['parent_id']) == pid &&
            SchoolRecords.asInt(l.data['student_id']) != studentId,
      );
      final p = others ? null : await db.get(users, pid);
      if (p != null) out.add(fullName(p.data));
    }
    return out;
  }

  Future<(List<String>, List<String>)> _deleteOne(
    int id,
    Set<int> going,
  ) async {
    final prev = await db.existing(users, id, 'این کاربر');
    if (id == db.uid) {
      throw const RecordFailure('in_use', 'حساب خودتان را نمی‌توانید حذف کنید');
    }
    final keys = <String>[];
    final removed = <String>[];
    if (prev.data['role'] == 'student') {
      final links = await db.allOrEmpty('parent_links');
      final mine = [
        for (final l in links)
          if (SchoolRecords.asInt(l.data['student_id']) == id) l,
      ];
      for (final l in mine) {
        keys.add(await db.del('parent_links', l));
      }
      keys.add(await db.del(users, prev));
      for (final pid in {
        for (final l in mine) ?SchoolRecords.asInt(l.data['parent_id']),
      }) {
        if (going.contains(pid)) continue;
        final still = (await db.allOrEmpty('parent_links'))
            .any((l) => SchoolRecords.asInt(l.data['parent_id']) == pid);
        final p = still ? null : await db.get(users, pid);
        if (p == null) continue;
        keys.add(await db.del(users, p));
        removed.add(fullName(p.data));
      }
    } else {
      keys.add(await db.del(users, prev));
    }
    return (keys, removed);
  }

  Future<int> _opsFor(Iterable<int> ids) async {
    final links = await db.allOrEmpty('parent_links');
    var n = 0;
    for (final id in ids) {
      n +=
          1 +
          2 *
              links
                  .where((l) => SchoolRecords.asInt(l.data['student_id']) == id)
                  .length;
    }
    return n;
  }

  /// `user-delete`.
  Future<RecordWrite> delete(int id) async {
    _requireManager();
    db.requireRoom(await _opsFor([id]));
    final (keys, removed) = await _deleteOne(id, const {});
    return RecordWrite(
      'کاربر حذف شد${removed.isEmpty ? '' : ' · ولی هم حذف شد: ${removed.join('، ')}'}',
      id: id,
      keys: keys,
    );
  }

  /// `users-bulk-delete`.
  Future<RecordWrite> bulkDelete(Set<int> ids) async {
    _requireManager();
    if (ids.isEmpty) {
      throw const RecordFailure('invalid', 'هیچ کاربری انتخاب نشده');
    }
    if (ids.contains(db.uid)) {
      throw const RecordFailure('in_use', 'حساب خودتان را نمی‌توانید حذف کنید');
    }
    db.requireRoom(await _opsFor(ids));
    final keys = <String>[];
    var n = 0;
    for (final id in ids) {
      if (await db.get(users, id) == null) continue;
      final (k, _) = await _deleteOne(id, ids);
      keys.addAll(k);
      n++;
    }
    return RecordWrite('$n کاربر حذف شد', keys: keys);
  }
}

/// Minimal row view used inside this file (id, data, version).
final class _ParentPlan {
  const _ParentPlan({
    required this.relation,
    required this.whoFa,
    required this.name,
    required this.nid,
    required this.phone,
    this.reuse,
    this.legacy = false,
  });
  final bool legacy;
  final String relation;
  final String whoFa;
  final String name;
  final String nid;
  final String phone;
  final EngineRowLike? reuse;

  String get relationFa => legacy ? 'پدر' : whoFa;
}

final class EngineRowLike {
  const EngineRowLike(this.id, this.data, [this.version = 0]);
  final int id;
  final Map<String, Object?> data;
  final int version;
}
