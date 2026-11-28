import 'package:payesh_data/payesh_data.dart' show EngineRow;
import 'package:payesh_sync/payesh_sync.dart';

import '../family/family_controller.dart' show jalaliToIso;
import '../school/school_source.dart';

/// `#/users` (manager): search, role filter, multi-select, add / edit / full profile / delete.
/// Same flow as the web page; every write is local-first (works offline).
class UsersController extends SchoolController {
  UsersController({
    required super.source,
    required super.role,
    required super.uid,
  });

  List<SchoolUser> users = const [];
  List<(int, String)> classes = const [];
  String roleFilter = '';
  String query = '';

  /// Row 185: «دانش‌آموزان» split by پایه and رشته ('' = all, [noValue] = none set).
  String gradeFilter = '';
  String branchFilter = '';
  List<String> gradeOptions = const [];
  List<String> branchOptions = const [];

  /// The «بدون پایه / بدون رشته» choice of the student filters.
  static const noValue = '-';
  final Set<int> picked = {};

  /// Web «N کاربر» (every user, not the filtered list).
  int total = 0;

  /// Web `followupCount()` and its import-issue part (the amber card).
  int followups = 0;
  int followupIssues = 0;

  /// Row 194: what the new-user form picks from — the school's own definitions (کلاس‌ها و
  /// تعریف‌ها), never a fixed list: پایه‌ها and رشته‌ها the manager defined, the classes with
  /// their پایه/رشته, the subjects (دروس) of the weekly schedule and the students (a parent's
  /// child).
  List<String> definedGrades = const [];
  List<String> definedBranches = const [];

  /// ردیف ۱۹۵: کادر «رشته» فقط در مدرسهٔ رشته‌محور (ابتدایی و متوسطه اول رشته ندارند).
  bool showBranch = true;

  /// Row 204: a field school (رشته‌محور) — a student is placed by پایه and رشته; no «کلاس».
  bool fieldSchool = false;
  List<(int, String, String, String)> classRows = const [];
  List<(int, String)> subjects = const [];
  List<(int, String)> studentRows = const [];

  /// Set when the add form found the same person; the next save confirms (web banner).
  SamePersonFailure? samePerson;

  bool get canManage => SchoolRecords.rules['users']!.writers.contains(role);

  /// Row 200: a big school (≈1200 users) drew every row at once — the page froze on each
  /// click, keystroke and sync. The table now shows [pageSize] rows a page.
  static const pageSize = 50;
  int page = 0;
  int get pages =>
      users.isEmpty ? 1 : (users.length + pageSize - 1) ~/ pageSize;

  /// The rows of the current page.
  List<SchoolUser> get shown {
    final from = page * pageSize;
    if (from >= users.length) return const [];
    final to = from + pageSize;
    return users.sublist(from, to > users.length ? users.length : to);
  }

  void goPage(int p) {
    final next = p < 0 ? 0 : (p >= pages ? pages - 1 : p);
    if (next == page) return;
    page = next;
    emit();
  }

  @override
  Future<void> read(SchoolRecords db) async {
    final dir = UserDirectory(db);
    // row 201: every user is read once; search / role / پایه / رشته filter this list in
    // memory (a keystroke used to read the whole database again — letters lagged on the PC)
    // row 200: every collection is read once per load (it was users ×4, lookups ×3, classes ×3)
    final lookups = await db.allOrEmpty('lookups');
    final everyone = await db.allOrEmpty('users');
    final cls = await db.allOrEmpty('classes');
    _every = dir.listFrom(
      rows: everyone,
      classRows: cls,
      links: await db.allOrEmpty('parent_links'),
    );
    final grades = <String>{}, branches = <String>{};
    final defG = <String>[], defB = <String>[];
    for (final l in lookups) {
      final name = SchoolRecords.str(l.data['name']).trim();
      if (name.isEmpty) continue;
      switch (SchoolRecords.str(l.data['kind'])) {
        case 'grade':
          grades.add(name);
          if (!defG.contains(name)) defG.add(name);
        case 'branch':
          branches.add(name);
          if (!defB.contains(name)) defB.add(name);
      }
    }
    _defGrades = grades;
    _defBranches = branches;
    definedGrades = defG;
    definedBranches = defB;
    // ردیف ۱۹۵: رشته فقط در مدرسهٔ رشته‌محور (متوسطه دوم) معنا دارد
    final st = await SchoolStructure.read(db);
    showBranch = st.fieldBased || (st.level.isEmpty && defB.isNotEmpty);
    fieldSchool = st.fieldBased;
    subjects = [
      for (final x in await db.allOrEmpty('subjects'))
        if (SchoolRecords.str(x.data['name']).trim().isNotEmpty)
          (x.id, SchoolRecords.str(x.data['name']).trim()),
    ]..sort((a, b) => a.$2.compareTo(b.$2));
    _keys = [
      for (final u in _every)
        (
          searchKey(SchoolRecords.str(u.data['name'])),
          searchKey(u.phone),
          searchKey(u.nationalId),
        ),
    ];
    _apply();
    total = everyone.length;
    try {
      final f = await Followup(db)
          .viewFrom(users: everyone, classes: cls, lookups: lookups);
      followups = f.total;
      followupIssues = f.issues.length;
    } on Object {
      followups = followupIssues = 0;
    }
    classes = [for (final c in cls) (c.id, SchoolRecords.str(c.data['name']))]
      ..sort((a, b) => a.$2.compareTo(b.$2));
    classRows = [
      for (final c in cls)
        if (SchoolRecords.str(c.data['kind']) != 'room')
          (
            c.id,
            SchoolRecords.str(c.data['name']),
            SchoolRecords.str(c.data['grade']).trim(),
            SchoolRecords.str(c.data['branch']).trim(),
          ),
    ]..sort((a, b) => a.$2.compareTo(b.$2));
    studentRows = [
      for (final u in everyone)
        if (u.data['role'] == 'student') (u.id, fullName(u.data)),
    ]..sort((a, b) => a.$2.compareTo(b.$2));
  }

  List<SchoolUser> _every = const [];
  Set<String> _defGrades = const {};
  Set<String> _defBranches = const {};

  /// Row 201: search text in one form — ي/ك, ZWNJ, Persian/Arabic digits and spaces aside, so
  /// «۰۹۱۲» finds 0912… and «علي» finds «علی».
  /// Perf: the patterns are compiled once — [searchKey] used to build four
  /// fresh [RegExp]s per call, and a keystroke called it for the name, phone
  /// and national id of every one of the school's 1177 users.
  static final _faDigits = RegExp('[۰-۹٠-٩]');
  static final _arabicYeh = RegExp('[ىي]');
  static final _spaceLike = RegExp(r'[\u200c\s]+');
  static String searchKey(String v) => v
      .replaceAllMapped(_faDigits, (m) => SchoolRecords.digitsOnly(m[0]))
      .replaceAll(_arabicYeh, 'ی')
      .replaceAll('ك', 'ک')
      .replaceAll(_spaceLike, '')
      .toLowerCase();

  /// Perf: the search keys of [_every], aligned by index — built once per
  /// load so filtering (every keystroke) is plain substring checks.
  List<(String, String, String)> _keys = const [];

  /// Row 201: the filtered list from the users already read — no database work.
  void _apply() {
    final q = searchKey(query.trim());
    final all = <SchoolUser>[
      for (final (i, u) in _every.indexed)
        if (roleMatches(roleFilter, u.role) &&
            (q.isEmpty ||
                i >= _keys.length ||
                _keys[i].$1.contains(q) ||
                _keys[i].$2.contains(q) ||
                _keys[i].$3.contains(q)))
          u,
    ];
    // row 204: one option per grade — «پایه دهم», «۱۰» and «دهم» are the same grade (the
    // classes page counts them together), a defined name wins over a student's spelling
    final grades = <String, String>{for (final g in _defGrades) gradeKey(g): g};
    final branches = <String, String>{
      for (final b in _defBranches) groupKey(b): b,
    };
    for (final u in all) {
      if (u.role != 'student') continue;
      final g = u.grade.trim(), b = u.branch.trim();
      if (gradeKey(g).isNotEmpty) grades.putIfAbsent(gradeKey(g), () => g);
      if (groupKey(b).isNotEmpty) branches.putIfAbsent(groupKey(b), () => b);
    }
    gradeOptions = grades.values.toList()
      ..sort(
        (a, b) => gradeLevel(a) != gradeLevel(b)
            ? gradeLevel(a).compareTo(gradeLevel(b))
            : a.compareTo(b),
      );
    branchOptions = branches.values.toList()..sort();
    bool hit(String value, String want, bool Function(String, String) same) =>
        want.isEmpty
        ? true
        : want == noValue
        ? value.trim().isEmpty
        : same(value, want);
    users = roleFilter == 'student'
        ? [
            for (final u in all)
              if (hit(u.grade, gradeFilter, sameGrade) &&
                  hit(u.branch, branchFilter, sameBranch))
                u,
          ]
        : all;
    if (page >= pages) page = pages - 1;
    final ids = {for (final u in users) u.id};
    picked.removeWhere((id) => !ids.contains(id));
  }

  Future<void> filter({
    String? role,
    String? search,
    String? grade,
    String? branch,
  }) async {
    if (role != null && role != roleFilter) {
      roleFilter = role;
      gradeFilter = branchFilter = '';
    }
    if (search != null) query = search;
    if (grade != null) gradeFilter = grade;
    if (branch != null) branchFilter = branch;
    page = 0;
    // row 201: once the page has its data a filter is instant (in memory)
    if (db != null && !loading) {
      _apply();
      emit();
      return;
    }
    await load();
  }

  void togglePick(int id) {
    picked.contains(id) ? picked.remove(id) : picked.add(id);
    emit();
  }

  void pickAll(bool on) {
    picked.clear();
    if (on) picked.addAll(users.map((u) => u.id));
    emit();
  }

  void clearPicks() {
    picked.clear();
    emit();
  }

  Future<RecordWrite?> add(UserDraft d) async {
    final confirmed = samePerson != null;
    RecordWrite? res;
    final out = await run((db) async {
      try {
        res = await UserDirectory(db).add(d, samePersonOk: confirmed);
        samePerson = null;
        return res!;
      } on SamePersonFailure catch (e) {
        samePerson = e;
        rethrow;
      }
    }, form: true);
    return out;
  }

  /// Row 203: the keys «ثبت موقت در لیست» left out (wrong values) at the last [addTemporary].
  List<String> tempDropped = const [];

  /// Row 203 «ثبت موقت در لیست»: the user is made with only its valid values.
  Future<RecordWrite?> addTemporary(UserDraft d) async {
    final confirmed = samePerson != null;
    return run((db) async {
      try {
        final (w, dropped) = await UserDirectory(db)
            .addTemporary(d, samePersonOk: confirmed);
        samePerson = null;
        tempDropped = dropped;
        return w;
      } on SamePersonFailure catch (e) {
        samePerson = e;
        rethrow;
      }
    }, form: true);
  }

  /// Row 194: «+ درس جدید» inside the teacher form — the subject goes into «دروس» (the same
  /// list the weekly schedule uses) and is returned to be picked right away.
  Future<(int, String)?> addSubject(String name) async {
    final n = name.trim();
    if (n.isEmpty) {
      formError = 'نام درس را بنویسید';
      emit();
      return null;
    }
    final had = subjects.where((x) => x.$2 == n).firstOrNull;
    if (had != null) return had;
    final w = await run(
      (db) => ClassBook(db).saveSubject(name: n, workshop: false),
      form: true,
    );
    final id = w?.id;
    if (id == null) return null;
    final made = (id, n);
    if (!subjects.any((x) => x.$1 == id)) {
      subjects = [...subjects, made]..sort((a, b) => a.$2.compareTo(b.$2));
    }
    emit();
    return made;
  }

  Future<RecordWrite?> edit(
    int id, {
    required String name,
    required String phone,
    required bool active,
    Map<String, String> extra = const {},
  }) => run(
    (db) =>
        UserDirectory(db)
            .edit(id, name: name, phone: phone, active: active, extra: extra),
    form: true,
  );

  /// ردیف ۱۹۷: ویرایش کامل هر نقش (فرم «کاربر جدید» در حالت ویرایش).
  Future<RecordWrite?> update(int id, UserDraft d) =>
      run((db) => UserDirectory(db).update(id, d), form: true);

  Future<RecordWrite?> saveFull(int id, Map<String, String> fields) =>
      run((db) => UserDirectory(db).saveFull(id, fields), form: true);

  Future<List<String>> orphanParents(int id) async =>
      db == null ? const [] : UserDirectory(db!).orphanParentsOf(id);

  Future<RecordWrite?> delete(int id) =>
      run((db) => UserDirectory(db).delete(id));

  Future<RecordWrite?> deletePicked() async {
    final r = await run((db) => UserDirectory(db).bulkDelete({...picked}));
    if (r != null) clearPicks();
    return r;
  }

  @override
  void clearForm() {
    samePerson = null;
    super.clearForm();
  }
}

/// `#/students`: the teacher's (or the whole school's) students with class and average.
class StudentsController extends SchoolController {
  StudentsController({
    required super.source,
    required super.role,
    required super.uid,
  });

  List<StudentRow> students = const [];
  String query = '';

  /// Web pageHead «N نفر» counts every student of the page, not the search hits.
  int total = 0;

  /// Row 197 (Q12 / F19): the teacher's own classes and their homework; per-student
  /// discipline notes and «ارجاع به مشاور». The server checks the class is the teacher's.
  bool get teacher => role == 'teacher';
  List<EngineRow> classes = const [];
  List<Homework> homework = const [];

  @override
  Future<void> read(SchoolRecords db) async {
    final dir = UserDirectory(db);
    students = await dir.students(query: query);
    total = query.trim().isEmpty
        ? students.length
        : (await dir.students(query: '')).length;
    if (teacher) {
      final notes = ClassNotes(db);
      classes = await notes.myClasses();
      homework = await notes.homework(
        classIds: {for (final c in classes) c.id},
      );
    }
  }

  Future<void> search(String q) async {
    query = q;
    await load();
  }

  /// [due] is a Jalali day as typed (or empty).
  Future<RecordWrite?> addHomework({
    required int? classId,
    required String title,
    String body = '',
    String due = '',
  }) {
    String? iso;
    if (due.trim().isNotEmpty) {
      iso = jalaliToIso(due);
      if (iso == null) return _refuse('مهلت را مثل ۱۴۰۵/۰۹/۰۶ بنویسید');
    }
    if (classId == null) return _refuse('کلاس را انتخاب کنید');
    return run(
      (db) => ClassNotes(
        db,
      ).addHomework(classId: classId, title: title, body: body, due: iso ?? ''),
      form: true,
    );
  }

  Future<RecordWrite?> deleteHomework(Homework h) =>
      run((db) => ClassNotes(db).deleteHomework(h));

  Future<RecordWrite?> addDiscipline(
    StudentRow s,
    DisciplineKind kind,
    String note,
  ) {
    final cid = s.user.classId;
    if (cid == null) return _refuse('کلاس این دانش‌آموز ثبت نشده است');
    return run(
      (db) => ClassNotes(db).addDiscipline(
        studentId: s.user.id,
        classId: cid,
        kind: kind,
        note: note,
      ),
      form: true,
    );
  }

  Future<RecordWrite?> refer(StudentRow s, String reason) =>
      run((db) => CounselorQueue(db).refer(s.user.id, reason), form: true);

  Future<RecordWrite?> _refuse(String why) async {
    formError = why;
    emit();
    return null;
  }
}

/// `#/record`: the signed-in student's own record.
class RecordController extends SchoolController {
  RecordController({
    required super.source,
    required super.role,
    required super.uid,
  });

  StudentRecord? record;

  @override
  Future<void> read(SchoolRecords db) async {
    record = await UserDirectory(db).myRecord();
  }
}
