// Row 128, wave W10 — «نیازمند پیگیری» (web `PAGES.followup`, client/pages.js
// followupStudents / importIssueRows; actions followup-assign / followup-ack / issue-done /
// issues-clear / issue-fix in client/app.js). Two lists, computed from the data itself:
//   * students whose grade/branch is not complete: no valid class, a class without a grade, a
//     grade or branch that is no longer defined, or a reason left by the import — unless the
//     manager said «حل شد» (`followup_ack`);
//   * open rows of a bulk import that were not created or are incomplete (`import_issues`).
// Assigning a grade stores grade + branch on the student; field mode (≥ 10th) never creates a
// class (the manager builds classes by hand), class mode attaches/creates the class «grade».
import 'package:payesh_data/payesh_data.dart';

import 'classes.dart' show gradeLevel, normName;
import 'records.dart';

final class FollowupStudent {
  const FollowupStudent({
    required this.id,
    required this.name,
    required this.contact,
    required this.reason,
    required this.grade,
    required this.branch,
  });
  final int id;
  final String name;
  final String contact;
  final String reason;

  /// Preselected grade/branch (current class, else the branch named in the reason).
  final String grade;
  final String branch;
}

final class ImportIssue {
  const ImportIssue({
    required this.id,
    required this.name,
    required this.nationalId,
    required this.phone,
    required this.reasons,
    required this.data,
    required this.userId,
  });
  final int id;
  final String name;
  final String nationalId;
  final String phone;
  final List<String> reasons;
  final Map<String, Object?> data;

  /// The user this row already became (national id / mobile / name), null = not created.
  final int? userId;
}

final class FollowupView {
  const FollowupView({
    required this.students,
    required this.issues,
    required this.grades,
    required this.branches,
  });
  final List<FollowupStudent> students;
  final List<ImportIssue> issues;

  /// Defined grades (only real grades) and branches, sorted (web `lookupList`).
  final List<String> grades;
  final List<String> branches;
  int get total => students.length + issues.length;
}

final class Followup {
  Followup(this.db);
  final SchoolRecords db;

  static String _s(Object? v) => SchoolRecords.str(v);
  static int? _int(Object? v) => SchoolRecords.asInt(v);

  void _requireManager() {
    if (db.role != 'manager') {
      throw const RecordFailure('not_allowed', 'پیگیری فقط برای مدیر است');
    }
  }

  /// Web `followupStudentReason`; '' = nothing to follow up.
  static String reasonOf(
    Map<String, Object?> u,
    Map<int, EngineRow> classes,
    List<String> grades,
    List<String> branches,
  ) {
    if (u['role'] != 'student' || u['followup_ack'] == true) return '';
    final own = _s(u['followup_reason']);
    final c = classes[_int(u['class_id']) ?? -1];
    if (c == null) {
      // field mode (≥ 10th): grade + branch on the student is complete — classes are built by
      // hand (the web list kept such students forever after «ذخیره», against its own rule)
      final g = _s(u['grade']);
      if (own.isEmpty &&
          gradeLevel(g) >= 10 &&
          (grades.isEmpty || grades.contains(g))) {
        return '';
      }
      return own.isNotEmpty ? own : 'پایه و رشته ندارد';
    }
    final g = _s(c.data['grade']);
    final b = _s(c.data['branch']);
    if (g.isEmpty) return own.isNotEmpty ? own : 'پایه‌اش در فایل نبود';
    if (grades.isNotEmpty && !grades.contains(g)) {
      return 'پایه‌اش تعریف نشده («$g»)';
    }
    if (b.isNotEmpty && branches.isNotEmpty && !branches.contains(b)) {
      return 'رشته‌اش تعریف نشده («$b»)';
    }
    return '';
  }

  Future<FollowupView> view() async {
    _requireManager();
    final users = await db.all('users');
    final classes = {for (final c in await db.allOrEmpty('classes')) c.id: c};
    final lookups = await db.allOrEmpty('lookups');
    List<String> defs(String k) => [
      for (final l in lookups)
        if (l.data['kind'] == k && _s(l.data['name']).isNotEmpty)
          _s(l.data['name']),
    ]..sort();
    final grades = defs('grade');
    final branches = defs('branch');
    final students = <FollowupStudent>[];
    for (final u in users) {
      final reason = reasonOf(u.data, classes, grades, branches);
      if (reason.isEmpty) continue;
      final c = classes[_int(u.data['class_id']) ?? -1];
      final m = RegExp(r'رشته:\s*([^)\n]+)').firstMatch(reason);
      final guess = m == null
          ? ''
          : m[1]!.replaceFirst(RegExp(r'\(.*$'), '').trim();
      final cb = _s(c?.data['branch']);
      students.add(
        FollowupStudent(
          id: u.id,
          name: _s(u.data['name']),
          contact: _s(u.data['phone']).isNotEmpty
              ? _s(u.data['phone'])
              : _s(u.data['national_id']),
          reason: reason,
          grade: _s(c?.data['grade']),
          branch: cb.isNotEmpty ? cb : guess,
        ),
      );
    }
    students.sort((a, b) => a.name.compareTo(b.name));
    final issues = <ImportIssue>[];
    for (final i in await db.allOrEmpty('import_issues')) {
      if (i.data['status'] == 'done') continue;
      final nid = _s(i.data['national_id']);
      final phone = _s(i.data['phone']);
      final name = _s(i.data['name']);
      int? uid;
      for (final u in users) {
        if ((nid.isNotEmpty && _s(u.data['national_id']) == nid) ||
            (phone.isNotEmpty && _s(u.data['phone']) == phone) ||
            (nid.isEmpty && phone.isEmpty && _s(u.data['name']) == name)) {
          uid = u.id;
          break;
        }
      }
      final reasons = i.data['reasons'];
      final data = i.data['data'];
      issues.add(
        ImportIssue(
          id: i.id,
          name: name,
          nationalId: nid,
          phone: phone,
          reasons: reasons is List ? [for (final r in reasons) '$r'] : const [],
          data: data is Map
              ? {for (final e in data.entries) '${e.key}': e.value}
              : const {},
          userId: uid,
        ),
      );
    }
    issues.sort((a, b) => a.name.compareTo(b.name));
    return FollowupView(
      students: students,
      issues: issues,
      grades: [
        for (final g in grades)
          if (gradeLevel(g) > 0) g,
      ],
      branches: branches,
    );
  }

  /// `followup-assign`: grade (required) + branch on the student.
  Future<RecordWrite> assign(
    int id, {
    required String grade,
    String branch = '',
  }) async {
    _requireManager();
    final g = grade.trim();
    final b = branch.trim();
    if (g.isEmpty) {
      throw const RecordFailure('invalid', 'اول پایه را انتخاب کنید');
    }
    final u = await db.existing('users', id, 'این دانش‌آموز');
    final level = gradeLevel(g);
    final patch = {...u.data, 'grade': g, 'field': b, 'followup_ack': false}
      ..remove('followup_reason');
    final keys = <String>[];
    final lookups = await db.allOrEmpty('lookups');
    var className = '';
    if (level >= 10) {
      patch['class_id'] = null;
      final needBranch =
          b.isNotEmpty &&
          !lookups.any(
            (l) =>
                l.data['kind'] == 'branch' &&
                normName(l.data['name']) == normName(b),
          );
      db.requireRoom(needBranch ? 2 : 1);
      if (needBranch) {
        keys.add(
          await db.put('lookups', await db.newId('lookups'), {
            'kind': 'branch',
            'name': b,
            'order':
                lookups.where((l) => l.data['kind'] == 'branch').length + 1,
          }),
        );
      }
    } else {
      EngineRow? cls;
      for (final c in await db.allOrEmpty('classes')) {
        if (_s(c.data['name']) == g) cls = c;
      }
      db.requireRoom(cls == null ? 2 : 1);
      var cid = cls?.id;
      if (cid == null) {
        cid = await db.newId('classes');
        keys.add(
          await db.put('classes', cid, {
            'name': g,
            'grade': g,
            'branch': '',
            'mode': 'class',
            'grade_level': level,
            'kind': 'class',
            'capacity': 30,
          }),
        );
      }
      patch['class_id'] = cid;
      className = cls == null ? g : _s(cls.data['name']);
    }
    keys.add(await db.put('users', id, patch, prev: u));
    return RecordWrite(
      level >= 10
          ? 'پایه و رشته ثبت شد${b.isEmpty ? '' : ' — $g $b'}'
          : 'در «$className» ثبت شد',
      id: id,
      keys: keys,
    );
  }

  /// `followup-ack`: stays as it is and leaves the list.
  Future<RecordWrite> ack(int id) async {
    _requireManager();
    final u = await db.existing('users', id, 'این دانش‌آموز');
    final k = await db.put('users', id, {
      ...u.data,
      'followup_ack': true,
    }, prev: u);
    return RecordWrite('از فهرست پیگیری برداشته شد', id: id, keys: [k]);
  }

  /// `issue-done`.
  Future<RecordWrite> issueDone(int id) async {
    _requireManager();
    final r = await db.existing('import_issues', id, 'این ردیف');
    final k = await db.put('import_issues', id, {
      ...r.data,
      'status': 'done',
      'closed_at': db.now().toUtc().toIso8601String(),
    }, prev: r);
    return RecordWrite('از فهرست پیگیری برداشته شد', id: id, keys: [k]);
  }

  /// `issues-clear`: every open import row → done (all-or-nothing for the queue).
  Future<RecordWrite> issuesClear() async {
    _requireManager();
    final open = [
      for (final r in await db.allOrEmpty('import_issues'))
        if (r.data['status'] != 'done') r,
    ];
    if (open.isEmpty) return const RecordWrite('ردیفی برای پیگیری نمانده');
    db.requireRoom(open.length);
    final at = db.now().toUtc().toIso8601String();
    final keys = [
      for (final r in open)
        await db.put('import_issues', r.id, {
          ...r.data,
          'status': 'done',
          'closed_at': at,
        }, prev: r),
    ];
    final n = '${open.length}'.replaceAllMapped(
      RegExp('[0-9]'),
      (m) => '۰۱۲۳۴۵۶۷۸۹'[int.parse(m[0]!)],
    );
    return RecordWrite('$n ردیف حل‌شده شد', keys: keys);
  }
}
