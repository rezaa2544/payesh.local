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
  final Set<int> picked = {};

  /// Set when the add form found the same person; the next save confirms (web banner).
  SamePersonFailure? samePerson;

  bool get canManage => SchoolRecords.rules['users']!.writers.contains(role);

  @override
  Future<void> read(SchoolRecords db) async {
    final dir = UserDirectory(db);
    users = await dir.list(role: roleFilter, query: query);
    classes = [
      for (final c in await db.allOrEmpty('classes'))
        (c.id, SchoolRecords.str(c.data['name'])),
    ]..sort((a, b) => a.$2.compareTo(b.$2));
    picked.removeWhere((id) => !users.any((u) => u.id == id));
  }

  Future<void> filter({String? role, String? search}) async {
    if (role != null) roleFilter = role;
    if (search != null) query = search;
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

  @override
  Future<void> read(SchoolRecords db) async {
    students = await UserDirectory(db).students(query: query);
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
