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
import 'school_import.dart' show importFieldOk, importProblemFields;

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
    this.fields = const {},
    this.raw = const {},
    this.draft = const {},
    this.tempUserId,
  });
  final int id;
  final String name;
  final String nationalId;
  final String phone;
  final List<String> reasons;
  final Map<String, Object?> data;

  /// The user this row already became (national id / mobile / name), null = not created.
  final int? userId;

  /// Row 202: field → what is wrong with it (import keys: `national_id`, `father_nid`, …);
  /// rows saved before 0.9.71 get it from their [reasons].
  final Map<String, String> fields;

  /// Row 202: the values of the file row as they were (import keys), so a value the import
  /// could not take (a 9-digit national id) is still shown in the fix form.
  final Map<String, String> raw;

  /// Row 203 (owner: «با تغییر در اطلاعات اتوماتیک ذخیره شود و فقط با تأیید نهایی، ذخیرهٔ
  /// نهایی شود»): what the manager already typed in «✏️ اصلاح» (form keys — `name`,
  /// `national_id`, `father_nid`, `class_id`, …), kept until the final save.
  final Map<String, String> draft;

  /// Row 203 «ثبت موقت در لیست»: the user made from this row while it is still incomplete.
  final int? tempUserId;

  /// The fields of the row the manager has fixed so far (in [draft], no longer in [fields]).
  int get fixedCount => draft.length;
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

  /// Row 200: a page that already read users / classes / lookups passes them in (a big
  /// school's users list read them four times per load).
  Future<FollowupView> view() => viewFrom();

  Future<FollowupView> viewFrom({
    List<EngineRow>? users,
    List<EngineRow>? classes,
    List<EngineRow>? lookups,
  }) async {
    _requireManager();
    final everyone = users ?? await db.all('users');
    final byClass = {
      for (final c in classes ?? await db.allOrEmpty('classes')) c.id: c,
    };
    final defsRows = lookups ?? await db.allOrEmpty('lookups');
    return _view(everyone, byClass, defsRows);
  }

  static final _branchGuess = RegExp(r'رشته:\s*([^)\n]+)');

  Future<FollowupView> _view(
    List<EngineRow> users,
    Map<int, EngineRow> classes,
    List<EngineRow> lookups,
  ) async {
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
      final m = _branchGuess.firstMatch(reason);
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
    // row 200: one index instead of a scan of every user per open issue (75 × 1177);
    // the first user wins, as the scan did
    final byNid = <String, int>{},
        byPhone = <String, int>{},
        byName = <String, int>{};
    for (final u in users) {
      final n = _s(u.data['national_id']);
      final p = _s(u.data['phone']);
      if (n.isNotEmpty) byNid.putIfAbsent(n, () => u.id);
      if (p.isNotEmpty) byPhone.putIfAbsent(p, () => u.id);
      byName.putIfAbsent(_s(u.data['name']), () => u.id);
    }
    final order = {for (final (i, u) in users.indexed) u.id: i};
    final issues = <ImportIssue>[];
    for (final i in await db.allOrEmpty('import_issues')) {
      if (i.data['status'] == 'done') continue;
      final nid = _s(i.data['national_id']);
      final phone = _s(i.data['phone']);
      final name = _s(i.data['name']);
      int? uid;
      if (nid.isEmpty && phone.isEmpty) {
        uid = byName[name];
      } else {
        final a = nid.isEmpty ? null : byNid[nid];
        final b = phone.isEmpty ? null : byPhone[phone];
        uid = a == null
            ? b
            : b == null || order[a]! <= order[b]!
            ? a
            : b;
      }
      final temp = _int(i.data['temp_user_id']);
      if (temp != null && order.containsKey(temp)) uid = temp;
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
          fields: () {
            final f = i.data['fields'];
            if (f is Map && f.isNotEmpty) {
              return {for (final e in f.entries) '${e.key}': '${e.value}'};
            }
            return importProblemFields(
              reasons is List ? [for (final r in reasons) '$r'] : const [],
            );
          }(),
          raw: () {
            final r = i.data['raw'];
            return r is Map
                ? {for (final e in r.entries) '${e.key}': '${e.value ?? ''}'}
                : const <String, String>{};
          }(),
          draft: () {
            final r = i.data['draft'];
            return r is Map
                ? {for (final e in r.entries) '${e.key}': '${e.value ?? ''}'}
                : const <String, String>{};
          }(),
          tempUserId: temp != null && order.containsKey(temp) ? temp : null,
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

  /// Row 203 (owner: «اگر سه بخش از اطلاعاتش ناقص بود و دو تا را اصلاح کردیم، آن دو بخش باید
  /// ذخیره شود»): what the manager typed in «✏️ اصلاح» ([values], form keys) is kept on the
  /// follow-up row; a wrong field whose new value is right ([importFieldOk]) leaves [fields]
  /// and its reasons leave the list, the rest stay (red) — the row closes only with the final
  /// save ([issueDone]). [tempUserId]: the row was «ثبت موقت» as that user.
  Future<RecordWrite> saveDraft(
    int id,
    Map<String, String> values, {
    int? tempUserId,
  }) async {
    _requireManager();
    final r = await db.existing('import_issues', id, 'این ردیف');
    String norm(Object? v) => _s(v).replaceAll(RegExp(r'\s+'), ' ').trim();
    final data = r.data['data'] is Map
        ? {for (final e in (r.data['data'] as Map).entries) '${e.key}': e.value}
        : <String, Object?>{};
    final raw = r.data['raw'] is Map
        ? {
            for (final e in (r.data['raw'] as Map).entries)
              '${e.key}': '${e.value ?? ''}',
          }
        : <String, String>{};
    final reasons = r.data['reasons'] is List
        ? [for (final x in r.data['reasons'] as List) '$x']
        : <String>[];
    final stored = r.data['fields'];
    final fields = stored is Map && stored.isNotEmpty
        ? {for (final e in stored.entries) '${e.key}': '${e.value}'}
        : importProblemFields(reasons);
    final draft = r.data['draft'] is Map
        ? {
            for (final e in (r.data['draft'] as Map).entries)
              '${e.key}': '${e.value ?? ''}',
          }
        : <String, String>{};
    // the value the row had before: the file's own value, else what the import kept
    String before(String k) {
      final ik = k == 'name' ? 'full_name' : k;
      final a = norm(raw[ik]);
      if (a.isNotEmpty) return a;
      if (k == 'name') return norm(r.data['name']);
      return norm(data[ik]);
    }

    for (final e in values.entries) {
      final v = norm(e.value);
      if (v == before(e.key) && !draft.containsKey(e.key)) continue;
      draft[e.key] = v;
    }
    // which wrong fields are right now
    final fixed = <String>{};
    for (final k in fields.keys) {
      final fk = k == 'full_name' ? 'name' : k;
      String? v = draft[fk];
      if (k == 'grade') {
        final g = draft['grade'] ?? '';
        final c = draft['class_id'] ?? '';
        if (g.isNotEmpty || c.isNotEmpty) v = g.isNotEmpty ? g : c;
      }
      if (v == null || v == before(fk)) continue;
      if (importFieldOk(k, v)) fixed.add(k);
    }
    final gone = <String>{for (final k in fixed) ...fields[k]!.split('\n')};
    final left = {
      for (final e in fields.entries)
        if (!fixed.contains(e.key)) e.key: e.value,
    };
    final row = <String, Object?>{
      ...r.data,
      'draft': draft,
      'fields': left,
      'reasons': [
        for (final x in reasons)
          if (!gone.contains(x)) x,
      ],
      'fixed': [
        ...{
          if (r.data['fixed'] is List)
            for (final x in r.data['fixed'] as List) '$x',
          ...gone,
        },
      ],
      'draft_at': db.now().toUtc().toIso8601String(),
      'temp_user_id': ?tempUserId,
    };
    // the list shows (and finds the user by) the corrected name / national id / mobile
    final nid = SchoolRecords.digitsOnly(draft['national_id']);
    if (nid.length == 10) row['national_id'] = nid;
    final ph = SchoolRecords.mobile11(draft['phone'] ?? '');
    if (RegExp(r'^09\d{9}$').hasMatch(ph)) row['phone'] = ph;
    if (importFieldOk('name', draft['name'] ?? '')) row['name'] = draft['name'];
    final had = r.data['draft'] is Map ? '${r.data['draft']}' : '{}';
    if (had == '$draft' && tempUserId == null) {
      return RecordWrite('تغییری نبود', id: id);
    }
    final k = await db.put('import_issues', id, row, prev: r);
    final n = left.length;
    return RecordWrite(
      n == 0
          ? 'همهٔ ایرادها اصلاح شد — برای ثبت نهایی «ذخیره» را بزنید'
          : 'اصلاح‌ها ذخیره شد — ${_faN(n)} مورد مانده',
      id: id,
      keys: [k],
    );
  }

  static String _faN(int n) => '$n'.replaceAllMapped(
    RegExp('[0-9]'),
    (m) => '۰۱۲۳۴۵۶۷۸۹'[int.parse(m[0]!)],
  );

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
