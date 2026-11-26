import 'package:payesh_sync/payesh_sync.dart';

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
  List<(int, String, String, String)> classRows = const [];
  List<(int, String)> subjects = const [];
  List<(int, String)> studentRows = const [];

  /// Set when the add form found the same person; the next save confirms (web banner).
  SamePersonFailure? samePerson;

  bool get canManage => SchoolRecords.rules['users']!.writers.contains(role);

  @override
  Future<void> read(SchoolRecords db) async {
    final dir = UserDirectory(db);
    final all = await dir.list(role: roleFilter, query: query);
    final grades = <String>{}, branches = <String>{};
    for (final l in await db.allOrEmpty('lookups')) {
      final name = SchoolRecords.str(l.data['name']).trim();
      if (name.isEmpty) continue;
      switch (SchoolRecords.str(l.data['kind'])) {
        case 'grade':
          grades.add(name);
        case 'branch':
          branches.add(name);
      }
    }
    for (final u in all.where((u) => u.role == 'student')) {
      if (u.grade.trim().isNotEmpty) grades.add(u.grade.trim());
      if (u.branch.trim().isNotEmpty) branches.add(u.branch.trim());
    }
    final defG = <String>[], defB = <String>[];
    for (final l in await db.allOrEmpty('lookups')) {
      final name = SchoolRecords.str(l.data['name']).trim();
      if (name.isEmpty) continue;
      switch (SchoolRecords.str(l.data['kind'])) {
        case 'grade':
          if (!defG.contains(name)) defG.add(name);
        case 'branch':
          if (!defB.contains(name)) defB.add(name);
      }
    }
    definedGrades = defG;
    definedBranches = defB;
    // ردیف ۱۹۵: رشته فقط در مدرسهٔ رشته‌محور (متوسطه دوم) معنا دارد
    final st = await SchoolStructure.read(db);
    showBranch = st.fieldBased || (st.level.isEmpty && defB.isNotEmpty);
    subjects = [
      for (final x in await db.allOrEmpty('subjects'))
        if (SchoolRecords.str(x.data['name']).trim().isNotEmpty)
          (x.id, SchoolRecords.str(x.data['name']).trim()),
    ]..sort((a, b) => a.$2.compareTo(b.$2));
    gradeOptions = grades.toList()..sort();
    branchOptions = branches.toList()..sort();
    bool hit(String value, String want) => want.isEmpty
        ? true
        : want == noValue
        ? value.trim().isEmpty
        : value.trim() == want;
    users = roleFilter == 'student'
        ? [
            for (final u in all)
              if (hit(u.grade, gradeFilter) && hit(u.branch, branchFilter)) u,
          ]
        : all;
    total = (await db.allOrEmpty('users')).length;
    try {
      final f = await Followup(db).view();
      followups = f.total;
      followupIssues = f.issues.length;
    } on Object {
      followups = followupIssues = 0;
    }
    final cls = await db.allOrEmpty('classes');
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
      for (final u in await db.allOrEmpty('users'))
        if (u.data['role'] == 'student') (u.id, fullName(u.data)),
    ]..sort((a, b) => a.$2.compareTo(b.$2));
    picked.removeWhere((id) => !users.any((u) => u.id == id));
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

  @override
  Future<void> read(SchoolRecords db) async {
    final dir = UserDirectory(db);
    students = await dir.students(query: query);
    total = query.trim().isEmpty
        ? students.length
        : (await dir.students(query: '')).length;
  }

  Future<void> search(String q) async {
    query = q;
    await load();
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
