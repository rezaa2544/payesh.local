// Row 128, wave W8 — classes, rooms, grade/branch definitions and subjects (web `PAGES.classes`,
// forms `class`, `def`, `subject`, actions class-*/room-*/def-*/subject-*). Same semantics as the
// web client (client/app.js `case 'class-delete'` … `kind === 'subject'`):
//   * a room (کلاس/کارگاه, `kind: 'room'`) is only a name, unique across all classes;
//   * a class needs a grade (اول…دوازدهم); "class mode" (≤ 9th) has no branch, "field mode"
//     (≥ 10th, رشته‌محور) needs one; the name defaults to grade + branch and is unique;
//     saving a class attaches students without a class whose grade/branch match, and editing it
//     clears the follow-up flag of its students;
//   * deleting a class never deletes students: they lose the class and go to «نیازمند پیگیری»
//     with the reason;
//   * merging moves students, schedule (a clash in the target slot drops the source slot and its
//     substitutions), grades and attendance, then deletes the source class;
//   * a grade/branch in use can be deleted alone, with its classes (students → follow-up), or with
//     its classes AND their students (grades, attendance, parent links);
//   * deleting a subject removes the schedule slots that use it.
// Every multi-row action checks the queue has room for ALL its ops first (no half-done action).
// The server re-checks the role (server/policy.js: manager only for all of these).
import 'package:payesh_data/payesh_data.dart';

import 'records.dart';
import 'users.dart' show nameKey;

const Map<String, String> lookupFa = {'grade': 'پایه', 'branch': 'رشته'};

/// Web `impNorm`: letter forms, ZWNJ and punctuation do not make a different name.
String normName(Object? v) => '${v ?? ''}'
    .replaceAll(RegExp('[ىي]'), 'ی')
    .replaceAll('ك', 'ک')
    .replaceAll('\u200c', '')
    .replaceAll(RegExp(r'[_\-.:،؛/\\()\[\]{}]'), ' ')
    .replaceAll(RegExp(r'\s+'), ' ')
    .trim()
    .toLowerCase();

/// Grade number 1..12 of a grade text, 0 = not a grade (web `impGradeLevel`). The longest word
/// is matched first, so «یازدهم» is 11 (the web loop answered 10 for it because «دهم» comes
/// first in its table; both are ≥ 10, so the class mode is the same).
int gradeLevel(Object? text) {
  final t = normName(
    '${text ?? ''}'.replaceAllMapped(
      RegExp('[۰-۹٠-٩]'),
      (m) => SchoolRecords.digitsOnly(m[0]),
    ),
  );
  if (t.isEmpty) return 0;
  const words = {
    'دوازدهم': 12,
    'یازدهم': 11,
    'چهارم': 4,
    'پنجم': 5,
    'ششم': 6,
    'هفتم': 7,
    'هشتم': 8,
    'دهم': 10,
    'نهم': 9,
    'سوم': 3,
    'دوم': 2,
    'اول': 1,
  };
  for (final e in words.entries) {
    if (t == e.key || t.contains(e.key)) return e.value;
  }
  final m = RegExp(r'(?:^|\s)(\d{1,2})(?:\s|$)').firstMatch(t);
  final n = m == null ? 0 : int.parse(m[1]!);
  return n >= 1 && n <= 12 ? n : 0;
}

final class ClassRow {
  const ClassRow({
    required this.id,
    required this.name,
    required this.isRoom,
    required this.grade,
    required this.branch,
    required this.mode,
    required this.students,
    required this.queued,
  });
  final int id;
  final String name;
  final bool isRoom;
  final String grade;
  final String branch;

  /// `class` (کلاس‌محور) or `field` (رشته‌محور); '' for rooms.
  final String mode;
  final int students;
  final bool queued;
}

final class LookupRow {
  const LookupRow({
    required this.id,
    required this.kind,
    required this.name,
    required this.order,
    required this.classes,
    required this.queued,
  });
  final int id;
  final String kind;
  final String name;
  final int order;

  /// Classes using this grade/branch.
  final int classes;
  final bool queued;
}

final class SubjectRow {
  const SubjectRow({
    required this.id,
    required this.name,
    required this.workshop,
    required this.slots,
    required this.queued,
  });
  final int id;
  final String name;
  final bool workshop;

  /// Schedule slots using this subject.
  final int slots;
  final bool queued;
}

final class ClassesView {
  const ClassesView({
    required this.rooms,
    required this.classes,
    required this.grades,
    required this.branches,
    required this.subjects,
  });
  final List<ClassRow> rooms;
  final List<ClassRow> classes;
  final List<LookupRow> grades;
  final List<LookupRow> branches;
  final List<SubjectRow> subjects;
}

/// What the class form sends (web form `class`, kind = group).
final class ClassDraft {
  const ClassDraft({
    required this.grade,
    this.name = '',
    this.branch = '',
    this.mode = '',
  });
  final String name;
  final String grade;
  final String branch;

  /// '' = automatic from the grade (≤ 9 → class, ≥ 10 → field).
  final String mode;
}

/// How a grade/branch in use is deleted (web def-delete-only / -cascade / -students).
enum LookupDelete { only, cascade, students }

/// What deleting a grade/branch touches (shown before the choice).
final class LookupUsage {
  const LookupUsage(this.classes, this.students);
  final List<String> classes;
  final int students;
}

final class ClassBook {
  ClassBook(this.db);
  final SchoolRecords db;

  bool get canManage => db.role == 'manager';

  void _requireManager() {
    if (!canManage) {
      throw const RecordFailure(
        'not_allowed',
        'کلاس‌ها و تعریف‌ها فقط برای مدیر است',
      );
    }
  }

  static int? _int(Object? v) => SchoolRecords.asInt(v);
  static String _s(Object? v) => SchoolRecords.str(v);

  Future<ClassesView> overview() async {
    db.requireRead('classes');
    final classes = await db.all('classes');
    final users = await db.allOrEmpty('users');
    final lookups = await db.allOrEmpty('lookups');
    final subjects = await db.allOrEmpty('subjects');
    final schedule = await db.allOrEmpty('schedule');
    final qc = db.queuedIds('classes');
    final ql = db.queuedIds('lookups');
    final qs = db.queuedIds('subjects');
    final count = <int, int>{};
    for (final u in users) {
      if (u.data['role'] != 'student') continue;
      final c = _int(u.data['class_id']);
      if (c != null) count[c] = (count[c] ?? 0) + 1;
    }
    ClassRow row(EngineRow r) => ClassRow(
      id: r.id,
      name: _s(r.data['name']),
      isRoom: r.data['kind'] == 'room',
      grade: _s(r.data['grade']),
      branch: _s(r.data['branch']),
      mode: r.data['kind'] == 'room'
          ? ''
          : (_s(r.data['mode']).isNotEmpty
                ? _s(r.data['mode'])
                : (gradeLevel(r.data['grade'] ?? r.data['name']) >= 10
                      ? 'field'
                      : 'class')),
      students: count[r.id] ?? 0,
      queued: qc.contains(r.id),
    );
    int byName(ClassRow a, ClassRow b) => a.name.compareTo(b.name);
    final all = [for (final c in classes) row(c)];
    List<LookupRow> defs(String kind) {
      final out = [
        for (final l in lookups)
          if (l.data['kind'] == kind)
            LookupRow(
              id: l.id,
              kind: kind,
              name: _s(l.data['name']),
              order: _int(l.data['order']) ?? 0,
              classes: classes
                  .where(
                    (c) =>
                        _s(c.data[kind == 'grade' ? 'grade' : 'branch']) ==
                        _s(l.data['name']),
                  )
                  .length,
              queued: ql.contains(l.id),
            ),
      ]..sort((a, b) => a.name.compareTo(b.name));
      return out;
    }

    return ClassesView(
      rooms: all.where((c) => c.isRoom).toList()..sort(byName),
      classes: all.where((c) => !c.isRoom).toList()..sort(byName),
      grades: defs('grade'),
      branches: defs('branch'),
      subjects: [
        for (final s in subjects)
          SubjectRow(
            id: s.id,
            name: _s(s.data['name']),
            workshop: s.data['workshop'] == true,
            slots: schedule
                .where((x) => _int(x.data['subject_id']) == s.id)
                .length,
            queued: qs.contains(s.id),
          ),
      ]..sort((a, b) => a.name.compareTo(b.name)),
    );
  }

  // ─────────────────────────────── rooms and classes ───────────────────────────────

  /// Form `class` with kind = room (`room-add` / `room-edit`).
  Future<RecordWrite> saveRoom({int? id, required String name}) async {
    _requireManager();
    final n = name.trim();
    if (n.isEmpty) {
      throw const RecordFailure('invalid', 'نام کلاس/کارگاه را بنویسید');
    }
    final all = await db.all('classes');
    for (final c in all) {
      if (c.id != id && normName(c.data['name']) == normName(n)) {
        throw RecordFailure(
          'duplicate',
          'این نام قبلاً ثبت شده: «${_s(c.data['name'])}»',
        );
      }
    }
    final prev = id == null
        ? null
        : await db.existing('classes', id, 'این کلاس');
    final rid = id ?? await db.newId('classes');
    final k = await db.put('classes', rid, {
      ...?prev?.data,
      'name': n,
      'kind': 'room',
    }, prev: prev);
    return RecordWrite(
      id == null ? 'کلاس/کارگاه اضافه شد' : 'ذخیره شد',
      id: rid,
      keys: [k],
    );
  }

  /// Form `class` (`class-add` / `class-edit`).
  Future<RecordWrite> saveClass(ClassDraft d, {int? id}) async {
    _requireManager();
    final grade = d.grade.trim();
    var branch = d.branch.trim();
    if (grade.isEmpty) {
      throw const RecordFailure(
        'invalid',
        'پایه را انتخاب کنید — هر کلاس یک پایه دارد',
      );
    }
    final level = gradeLevel(grade);
    if (level == 0) {
      throw RecordFailure(
        'invalid',
        '«$grade» پایه نیست — پایه یکی از اول تا دوازدهم است. رشته را در کادر رشته بنویسید.',
      );
    }
    if (branch.isNotEmpty && nameKey(grade) == nameKey(branch)) {
      throw RecordFailure(
        'invalid',
        'پایه و رشته یکی شده‌اند — رشته («$branch») را در کادر پایه نوشته‌اید؛ پایه را اصلاح کنید',
      );
    }
    final mode = d.mode.trim().isNotEmpty
        ? d.mode.trim()
        : (level >= 10 ? 'field' : 'class');
    if (mode == 'field' && branch.isEmpty) {
      throw const RecordFailure(
        'invalid',
        'کلاس رشته‌محور باید رشته داشته باشد (مثل «دهم الکترونیک»)',
      );
    }
    if (mode == 'class' && branch.isNotEmpty) {
      throw const RecordFailure(
        'invalid',
        'کلاس کلاس‌محور رشته ندارد — یا نوع چیدمان را «رشته‌محور» کنید یا رشته را خالی بگذارید',
      );
    }
    if (mode == 'class') branch = '';
    final name = d.name.trim().isNotEmpty
        ? d.name.trim()
        : '$grade${branch.isEmpty ? '' : ' $branch'}'.trim();
    final classes = await db.all('classes');
    for (final c in classes) {
      if (c.id != id && _s(c.data['name']) == name) {
        throw RecordFailure('duplicate', 'کلاسی با همین نام هست: «$name»');
      }
    }
    final prev = id == null
        ? null
        : await db.existing('classes', id, 'این کلاس');
    final cid = id ?? await db.newId('classes');
    final users = await db.all('users');
    // students to touch: follow-up cleared (edit) + students without a class that match
    final touched = <EngineRow, Map<String, Object?>>{};
    if (id != null) {
      for (final u in users) {
        if (_int(u.data['class_id']) != id) continue;
        if (_s(u.data['followup_reason']).isEmpty &&
            u.data['followup_ack'] != true) {
          continue;
        }
        touched[u] = {...u.data, 'followup_ack': false}
          ..remove('followup_reason');
      }
    }
    var joined = 0;
    for (final u in users) {
      if (u.data['role'] != 'student' || (_int(u.data['class_id']) ?? 0) != 0) {
        continue;
      }
      final ug = _s(u.data['grade']);
      final ub = _s(u.data['field']).isNotEmpty
          ? _s(u.data['field'])
          : _s(u.data['branch']);
      if (normName(ug) != normName(grade)) continue;
      if (mode == 'field' && normName(ub) != normName(branch)) continue;
      if (mode == 'class' &&
          ub.isNotEmpty &&
          normName(name) != normName('$grade $ub')) {
        continue;
      }
      touched[u] = {...u.data, 'class_id': cid}..remove('followup_reason');
      joined++;
    }
    db.requireRoom(1 + touched.length);
    final keys = <String>[
      await db.put('classes', cid, {
        ...?prev?.data,
        'name': name,
        'grade': grade,
        'branch': branch,
        'mode': mode,
        'grade_level': level,
        'kind': 'class',
        'capacity': _int(prev?.data['capacity']) ?? 30,
      }, prev: prev),
    ];
    for (final e in touched.entries) {
      keys.add(await db.put('users', e.key.id, e.value, prev: e.key));
    }
    return RecordWrite(
      '${id == null ? 'کلاس ساخته شد' : 'کلاس ویرایش شد'}'
      '${joined > 0 ? ' · $joined دانش‌آموز به آن وصل شد' : ''}',
      id: cid,
      keys: keys,
    );
  }

  /// Students of [classId] (for the delete confirmation).
  Future<int> studentsOf(int classId) async => (await db.allOrEmpty('users'))
      .where(
        (u) =>
            u.data['role'] == 'student' && _int(u.data['class_id']) == classId,
      )
      .length;

  /// `class-delete`: students stay, without a class, in «نیازمند پیگیری».
  Future<RecordWrite> deleteClass(int id) async {
    _requireManager();
    final c = await db.existing('classes', id, 'این کلاس');
    final kids = (await db.all('users'))
        .where(
          (u) => u.data['role'] == 'student' && _int(u.data['class_id']) == id,
        )
        .toList();
    db.requireRoom(1 + kids.length);
    final reason =
        'کلاس «${_s(c.data['name'])}» حذف شد — کلاس تازه انتخاب کنید';
    final keys = <String>[
      for (final u in kids)
        await db.put('users', u.id, {
          ...u.data,
          'class_id': null,
          'followup_reason': reason,
          'followup_ack': false,
        }, prev: u),
    ];
    keys.add(await db.del('classes', c));
    return RecordWrite(
      'کلاس حذف شد${kids.isEmpty ? '' : ' · ${kids.length} دانش‌آموز بدون کلاس شد'}',
      id: id,
      keys: keys,
    );
  }

  /// `class-merge`: everything of [from] moves into [into]; [from] is deleted.
  Future<RecordWrite> mergeClass(int from, int into) async {
    _requireManager();
    if (from == into) {
      throw const RecordFailure('invalid', 'کلاس مقصد را انتخاب کنید');
    }
    final src = await db.existing('classes', from, 'کلاس مبدأ');
    await db.existing('classes', into, 'کلاس مقصد');
    final users = (await db.all('users'))
        .where((u) => _int(u.data['class_id']) == from)
        .toList();
    final schedule = await db.allOrEmpty('schedule');
    final subs = await db.allOrEmpty('substitutions');
    final grades = (await db.allOrEmpty('grades'))
        .where((g) => _int(g.data['class_id']) == from)
        .toList();
    final att = (await db.allOrEmpty('attendance'))
        .where((a) => _int(a.data['class_id']) == from)
        .toList();
    bool sameSlot(EngineRow a, EngineRow b) =>
        _int(a.data['weekday']) == _int(b.data['weekday']) &&
        _int(a.data['bell_order']) == _int(b.data['bell_order']);
    final moveSlots = <EngineRow>[];
    final dropSlots = <EngineRow>[];
    final dropSubs = <EngineRow>[];
    for (final sg in schedule.where((x) => _int(x.data['class_id']) == from)) {
      final clash = schedule.any(
        (x) => _int(x.data['class_id']) == into && sameSlot(x, sg),
      );
      if (clash) {
        dropSlots.add(sg);
        dropSubs.addAll(
          subs.where((x) => _int(x.data['schedule_id']) == sg.id),
        );
      } else {
        moveSlots.add(sg);
      }
    }
    db.requireRoom(
      users.length +
          moveSlots.length +
          dropSlots.length +
          dropSubs.length +
          grades.length +
          att.length +
          1,
    );
    final keys = <String>[];
    for (final u in users) {
      keys.add(
        await db.put(
          'users',
          u.id,
          {...u.data, 'class_id': into, 'followup_ack': false}
            ..remove('followup_reason'),
          prev: u,
        ),
      );
    }
    for (final sb in dropSubs) {
      keys.add(await db.del('substitutions', sb));
    }
    for (final sg in dropSlots) {
      keys.add(await db.del('schedule', sg));
    }
    for (final sg in moveSlots) {
      keys.add(
        await db.put('schedule', sg.id, {
          ...sg.data,
          'class_id': into,
        }, prev: sg),
      );
    }
    for (final g in grades) {
      keys.add(
        await db.put('grades', g.id, {...g.data, 'class_id': into}, prev: g),
      );
    }
    for (final a in att) {
      keys.add(
        await db.put('attendance', a.id, {
          ...a.data,
          'class_id': into,
        }, prev: a),
      );
    }
    keys.add(await db.del('classes', src));
    return RecordWrite(
      'کلاس ادغام شد${users.isEmpty ? '' : ' · ${users.length} دانش‌آموز منتقل شد'}',
      id: into,
      keys: keys,
    );
  }

  // ─────────────────────────────── grades / branches ───────────────────────────────

  /// Form `def` (`def-add` / `def-edit`).
  Future<RecordWrite> saveLookup({
    int? id,
    required String kind,
    required String name,
    String order = '',
  }) async {
    _requireManager();
    final k = kind == 'branch' ? 'branch' : 'grade';
    final n = name.trim();
    if (n.isEmpty) throw const RecordFailure('invalid', 'نام را بنویسید');
    final all = await db.all('lookups');
    if (all.any(
      (l) => l.data['kind'] == k && _s(l.data['name']) == n && l.id != id,
    )) {
      throw const RecordFailure('duplicate', 'این مورد قبلاً ثبت شده است');
    }
    final prev = id == null
        ? null
        : await db.existing('lookups', id, 'این مورد');
    final lid = id ?? await db.newId('lookups');
    final ord =
        _int(SchoolRecords.digitsOnly(order)) ??
        (all.where((l) => l.data['kind'] == k).length + 1);
    final key = await db.put('lookups', lid, {
      ...?prev?.data,
      'kind': k,
      'name': n,
      'order': ord == 0
          ? all.where((l) => l.data['kind'] == k).length + 1
          : ord,
    }, prev: prev);
    return RecordWrite(
      '${lookupFa[k]}${id == null ? ' ثبت شد' : ' ویرایش شد'}',
      id: lid,
      keys: [key],
    );
  }

  List<EngineRow> _linked(EngineRow l, List<EngineRow> classes) {
    final field = l.data['kind'] == 'grade' ? 'grade' : 'branch';
    return classes
        .where((c) => _s(c.data[field]) == _s(l.data['name']))
        .toList();
  }

  Future<LookupUsage> lookupUsage(int id) async {
    final l = await db.existing('lookups', id, 'این مورد');
    final linked = _linked(l, await db.all('classes'));
    final ids = {for (final c in linked) c.id};
    final students = (await db.allOrEmpty('users'))
        .where(
          (u) =>
              u.data['role'] == 'student' &&
              ids.contains(_int(u.data['class_id'])),
        )
        .length;
    return LookupUsage([for (final c in linked) _s(c.data['name'])], students);
  }

  /// `def-delete` (unused) / `def-delete-only` / `def-delete-cascade` / `def-delete-students`.
  Future<RecordWrite> deleteLookup(int id, LookupDelete how) async {
    _requireManager();
    final l = await db.existing('lookups', id, 'این مورد');
    final label = lookupFa[l.data['kind']] ?? 'مورد';
    if (how == LookupDelete.only) {
      final k = await db.del('lookups', l);
      return RecordWrite('حذف شد', id: id, keys: [k]);
    }
    final linked = _linked(l, await db.all('classes'));
    final ids = {for (final c in linked) c.id};
    final users = await db.all('users');
    final schedule = await db.allOrEmpty('schedule');
    final subs = await db.allOrEmpty('substitutions');
    final slots = schedule
        .where((x) => ids.contains(_int(x.data['class_id'])))
        .toList();
    final slotIds = {for (final s in slots) s.id};
    final slotSubs = subs
        .where((x) => slotIds.contains(_int(x.data['schedule_id'])))
        .toList();
    final keys = <String>[];
    if (how == LookupDelete.cascade) {
      final kept = users
          .where((u) => ids.contains(_int(u.data['class_id'])))
          .toList();
      db.requireRoom(
        slotSubs.length + slots.length + kept.length + linked.length + 1,
      );
      final reason =
          '${l.data['kind'] == 'grade' ? 'پایهٔ «' : 'رشتهٔ «'}${_s(l.data['name'])}» حذف شد — کلاس تازه انتخاب کنید';
      for (final sb in slotSubs) {
        keys.add(await db.del('substitutions', sb));
      }
      for (final sg in slots) {
        keys.add(await db.del('schedule', sg));
      }
      for (final u in kept) {
        keys.add(
          await db.put('users', u.id, {
            ...u.data,
            'class_id': null,
            'followup_reason': reason,
            'followup_ack': false,
          }, prev: u),
        );
      }
      for (final c in linked) {
        keys.add(await db.del('classes', c));
      }
      keys.add(await db.del('lookups', l));
      return RecordWrite(
        '$label و ${linked.length} کلاس حذف شد'
        '${kept.isEmpty ? '' : ' · ${kept.length} دانش‌آموز به «نیازمند پیگیری» رفت'}',
        id: id,
        keys: keys,
      );
    }
    // students: the students of those classes go too, with their grades, attendance and links
    final students = users
        .where(
          (u) =>
              u.data['role'] == 'student' &&
              ids.contains(_int(u.data['class_id'])),
        )
        .toList();
    final sids = {for (final s in students) s.id};
    final grades = (await db.allOrEmpty('grades'))
        .where((g) => sids.contains(_int(g.data['student_id'])))
        .toList();
    final att = (await db.allOrEmpty('attendance'))
        .where((a) => sids.contains(_int(a.data['student_id'])))
        .toList();
    final links = (await db.allOrEmpty('parent_links'))
        .where((p) => sids.contains(_int(p.data['student_id'])))
        .toList();
    db.requireRoom(
      grades.length +
          att.length +
          links.length +
          students.length +
          slotSubs.length +
          slots.length +
          linked.length +
          1,
    );
    for (final g in grades) {
      keys.add(await db.del('grades', g));
    }
    for (final a in att) {
      keys.add(await db.del('attendance', a));
    }
    for (final p in links) {
      keys.add(await db.del('parent_links', p));
    }
    for (final s in students) {
      keys.add(await db.del('users', s));
    }
    for (final sb in slotSubs) {
      keys.add(await db.del('substitutions', sb));
    }
    for (final sg in slots) {
      keys.add(await db.del('schedule', sg));
    }
    for (final c in linked) {
      keys.add(await db.del('classes', c));
    }
    keys.add(await db.del('lookups', l));
    return RecordWrite(
      '${students.length} دانش‌آموز و ${linked.length} کلاس حذف شد',
      id: id,
      keys: keys,
    );
  }

  // ─────────────────────────────── subjects ───────────────────────────────

  /// Form `subject` (`subject-add` / `subject-edit`).
  Future<RecordWrite> saveSubject({
    int? id,
    required String name,
    required bool workshop,
  }) async {
    _requireManager();
    final n = name.trim();
    if (n.isEmpty) throw const RecordFailure('invalid', 'نام درس را بنویسید');
    final prev = id == null
        ? null
        : await db.existing('subjects', id, 'این درس');
    final sid = id ?? await db.newId('subjects');
    final k = await db.put('subjects', sid, {
      ...?prev?.data,
      'name': n,
      'workshop': workshop,
    }, prev: prev);
    return RecordWrite(
      id == null ? 'درس ثبت شد' : 'درس ویرایش شد',
      id: sid,
      keys: [k],
    );
  }

  /// `subject-delete`: the schedule slots using it go too.
  Future<RecordWrite> deleteSubject(int id) async {
    _requireManager();
    final sb = await db.existing('subjects', id, 'این درس');
    final slots = (await db.allOrEmpty('schedule'))
        .where((x) => _int(x.data['subject_id']) == id)
        .toList();
    db.requireRoom(slots.length + 1);
    final keys = <String>[for (final sg in slots) await db.del('schedule', sg)];
    keys.add(await db.del('subjects', sb));
    return RecordWrite('درس حذف شد', id: id, keys: keys);
  }
}
