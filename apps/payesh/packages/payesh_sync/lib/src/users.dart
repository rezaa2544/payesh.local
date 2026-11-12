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
import 'records.dart';

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

/// Role filter chips of the users page (web order).
const List<(String, String)> roleFilters = [
  ('', 'همه'),
  ('student', 'دانش‌آموز'),
  ('teacher', 'دبیر'),
  ('parent', 'ولی'),
  ('manager', 'مدیر'),
  ('vice', 'معاون'),
  ('staff', 'کارمند'),
];

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

/// One user as the pages show it.
final class SchoolUser {
  const SchoolUser({
    required this.id,
    required this.data,
    this.className = '',
    this.kids = const [],
    this.queued = false,
  });
  final int id;
  final Map<String, Object?> data;
  final String className;

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
  final double average;
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
  });
  final SchoolUser user;
  final String className;
  final int presentPercent;
  final int attendanceDays;

  /// (subject, score, approved)
  final List<(String, num?, bool)> grades;

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
  });
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
  static const Set<String> wholeSchool = {
    'manager',
    'vice',
    'counselor',
    'office',
  };

  Future<Map<int, String>> _classNames() async => {
    for (final c in await db.allOrEmpty('classes'))
      c.id: SchoolRecords.str(c.data['name']),
  };

  SchoolUser _of(
    EngineRowLike r,
    Map<int, String> classes,
    Set<int> queued, [
    List<String> kids = const [],
  ]) => SchoolUser(
    id: r.id,
    data: r.data,
    className: classes[SchoolRecords.asInt(r.data['class_id'])] ?? '',
    kids: kids,
    queued: queued.contains(r.id),
  );

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
    final classes = await _classNames();
    final queued = db.queuedIds(users);
    final rows = await db.all(users);
    final byId = {for (final r in rows) r.id: r};
    final links = await db.allOrEmpty('parent_links');
    final q = query.trim();
    final out = <SchoolUser>[];
    for (final r in rows) {
      final u = SchoolUser(id: r.id, data: r.data);
      if (role.isNotEmpty && u.role != role) continue;
      if (q.isNotEmpty &&
          !SchoolRecords.str(r.data['name']).contains(q) &&
          !u.phone.contains(q) &&
          !u.nationalId.contains(q)) {
        continue;
      }
      final kids = u.role == 'parent'
          ? [
              for (final l in links)
                if (SchoolRecords.asInt(l.data['parent_id']) == r.id)
                  if (byId[SchoolRecords.asInt(l.data['student_id'])]
                      case final k?)
                    fullName(k.data),
            ]
          : const <String>[];
      out.add(_of(EngineRowLike(r.id, r.data), classes, queued, kids));
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
    final grades = await db.allOrEmpty('grades');
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
      final g = [
        for (final x in grades)
          if (SchoolRecords.asInt(x.data['student_id']) == r.id)
            num.tryParse('${x.data['score'] ?? 0}') ?? 0,
      ];
      final avg = g.isEmpty ? 0.0 : g.fold<num>(0, (a, b) => a + b) / g.length;
      out.add(StudentRow(u, u.className, avg.toDouble(), g.length));
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
    final grades = [
      for (final g in await db.allOrEmpty('grades'))
        if (SchoolRecords.asInt(g.data['student_id']) == db.uid)
          (
            subjects[SchoolRecords.asInt(g.data['subject_id'])] ?? '',
            num.tryParse('${g.data['score'] ?? ''}'),
            g.data['status'] == 'approved',
          ),
    ];
    return StudentRecord(
      user: SchoolUser(id: me.id, data: me.data),
      className: classes[SchoolRecords.asInt(me.data['class_id'])] ?? '',
      presentPercent: att.isEmpty ? 0 : (present * 100 / att.length).round(),
      attendanceDays: att.length,
      grades: grades,
      details: detailRows(me.data),
    );
  }

  /// Web `userDetailRows`.
  static List<(String, String)> detailRows(Map<String, Object?> u) {
    final out = <(String, String)>[];
    void add(String label, Object? v) {
      final t = SchoolRecords.str(v);
      if (t.isNotEmpty && t != '—') out.add((label, t));
    }

    add('تاریخ تولد', u['birth_date']);
    add('جنسیت', u['gender']);
    add('نام پدر', u['father_name']);
    add('کد ملی پدر', u['father_nid']);
    add('همراه پدر', u['father_phone']);
    add('نام مادر', u['mother_name']);
    add('کد ملی مادر', u['mother_nid']);
    add('همراه مادر', u['mother_phone']);
    add('سرپرست', u['guardian']);
    add('معدل سال گذشته', u['last_gpa']);
    add('حمایتی', u['covered']);
    add('استعداد', u['talent']);
    add('تلفن ثابت', u['landline']);
    add('شمارهٔ همراه', u['phone']);
    add('کد ملی', u['national_id']);
    add('محل سکونت', u['residence']);
    add('نشانی', u['address']);
    add('رشته', u['field']);
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

  static String _nid(String raw) {
    final d = SchoolRecords.digitsOnly(raw);
    if (d.isNotEmpty && d.length != 10) {
      throw const RecordFailure('invalid', 'کد ملی باید دقیقاً ۱۰ رقم باشد');
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
      for (final (k, _, _) in userExtraFields)
        if ((d.extra[k] ?? '').trim().isNotEmpty)
          k: k.endsWith('_phone')
              ? (SchoolRecords.mobile11(d.extra[k]).isEmpty
                    ? d.extra[k]!.trim()
                    : SchoolRecords.mobile11(d.extra[k]))
              : d.extra[k]!.trim(),
    };
    db.precheck(users, row);
    final withParent =
        d.role == 'student' &&
        (d.parentName.trim().isNotEmpty || parentPhone.isNotEmpty);
    db.requireRoom(withParent ? 3 : 1);
    final keys = <String>[];
    final id = await db.newId(users);
    keys.add(await db.put(users, id, row));
    var msg =
        'کاربر ساخته شد — نام کاربری: ${phone.isNotEmpty ? phone : (nid.isNotEmpty ? nid : 'ثبت نشده')}'
        '، رمز اولیه: ${nid.isNotEmpty ? 'کد ملی' : 'با «کاربری» تعیین کنید'}';
    final pName = d.parentName.trim();
    if (d.role == 'student' && (pName.isNotEmpty || parentPhone.isNotEmpty)) {
      EngineRowLike? parent;
      if (parentPhone.isNotEmpty) {
        for (final r in rows) {
          if (r.data['role'] == 'parent' &&
              SchoolRecords.digitsOnly(r.data['phone']) == parentPhone) {
            parent = r;
          }
        }
        if (parent == null) await _uniquePhone(parentPhone, null, rows);
      }
      var pid = parent?.id;
      if (pid == null) {
        pid = await db.newId(users);
        keys.add(
          await db.put(users, pid, {
            'name': pName.isEmpty ? 'ولی $name' : pName,
            'role': 'parent',
            'phone': parentPhone,
            'active': true,
          }),
        );
      }
      final lid = await db.newId('parent_links');
      keys.add(
        await db.put('parent_links', lid, {
          'parent_id': pid,
          'student_id': id,
          'relation': 'father',
        }),
      );
      msg += parent == null
          ? ' · حساب ولی هم ساخته شد'
          : ' · به ولیِ موجود وصل شد';
    }
    return RecordWrite(msg, id: id, keys: keys);
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
    if (_same(data, prev.data)) return const RecordWrite('تغییری نبود');
    final k = await db.put(users, id, data, prev: prev);
    return RecordWrite('کاربر ویرایش شد', id: id, keys: [k]);
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
final class EngineRowLike {
  const EngineRowLike(this.id, this.data, [this.version = 0]);
  final int id;
  final Map<String, Object?> data;
  final int version;
}
