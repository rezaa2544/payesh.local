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
import 'school_import.dart' show importBranchGuess;
import 'school_structure.dart';
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

/// Row 197-Q04: the key of a grade/branch («پایه + رشته») — [normName] without spaces too, so
/// «نقشه‌کشی», «نقشه کشی» and «نقشهکشی» are one branch.
String groupKey(Object? v) => normName(v).replaceAll(' ', '');

/// Row 197-Q04: the branch of a student (the import writes `field`; old rows may have `branch`).
String studentBranch(Map<String, Object?> u) {
  final f = SchoolRecords.str(u['field']);
  return f.isNotEmpty ? f : SchoolRecords.str(u['branch']);
}

/// Row 197-Q04: is [u] (no class of its own) a member of the field-mode class [c]
/// («دهم نقشه کشی» = every 10th-grade student of نقشه کشی)? Rooms never have members.
bool fieldGroupMember(Map<String, Object?> c, Map<String, Object?> u) {
  if (c['kind'] == 'room' || u['role'] != 'student') return false;
  if ((SchoolRecords.asInt(u['class_id']) ?? 0) != 0) return false;
  // «نیازمند پیگیری» (e.g. its class was deleted) waits for the manager, not for a group
  if (SchoolRecords.str(u['followup_reason']).isNotEmpty) return false;
  final branch = SchoolRecords.str(c['branch']);
  final grade = SchoolRecords.str(c['grade']);
  if (branch.isEmpty || grade.isEmpty) return false;
  return groupKey(u['grade']) == groupKey(grade) &&
      groupKey(studentBranch(u)) == groupKey(branch);
}

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
    this.room = '',
    this.capacity = 30,
    this.teacherId,
    this.teacher = '',
  });
  final int id;
  final String name;
  final bool isRoom;

  /// ردیف ۱۹۵ (p2 classModal): اتاق ثابت، ظرفیت و دبیر پایه (سرپرست) کلاس.
  final String room;
  final int capacity;
  final int? teacherId;
  final String teacher;
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
    this.students = 0,
  });
  final int id;
  final String kind;
  final String name;
  final int order;

  /// Classes using this grade/branch.
  final int classes;
  final bool queued;

  /// Row 197-Q04: students of this grade/branch (their own `grade` / `field`).
  final int students;
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
    this.structure = const SchoolStructure(level: '', fieldBased: true),
  });

  /// ردیف ۱۹۵: کلاس‌محور یا رشته‌محور (از مقطع مدرسه).
  final SchoolStructure structure;
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
    this.room = '',
    this.capacity = '',
    this.teacherId,
  });
  final String name;
  final String grade;
  final String branch;

  /// ردیف ۱۹۵ (p2 classModal): اتاق، ظرفیت (متن عددی؛ خالی = ۳۰) و دبیر پایه.
  final String room;
  final String capacity;
  final int? teacherId;

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

/// Row 201 — why a grade/branch probably is another one (for the detail panel).
const Map<String, String> lookupLikeFa = {
  'same': 'همان نام با نگارش دیگر',
  'repeat': 'یک کلمه دو بار نوشته شده',
  'alias': 'هم‌معنی',
};

/// Row 201 — the detail panel of a grade / branch: its students and classes, and the
/// definition it most likely duplicates («تعمیر موتور موتور» → «تعمیر موتور»).
final class LookupDetail {
  const LookupDetail({
    required this.students,
    required this.classes,
    this.likeId,
    this.like = '',
    this.why = '',
  });

  /// (id, name, the other half: the branch of a grade's student / the grade of a branch's).
  final List<(int, String, String)> students;
  final List<String> classes;
  final int? likeId;
  final String like;

  /// A key of [lookupLikeFa]; '' = nothing like it.
  final String why;
}

/// Row 201 — the detail panel of a class / room: who is in it and what the timetable has.
final class ClassDetail {
  const ClassDetail({required this.students, required this.slots});
  final List<(int, String)> students;
  final int slots;
}

/// Row 201 — the detail panel of a subject: where and by whom it is taught.
final class SubjectDetail {
  const SubjectDetail({
    required this.classes,
    required this.teachers,
    required this.slots,
  });
  final List<String> classes;
  final List<String> teachers;
  final int slots;
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
    final names = {
      for (final u in users)
        if (u.data['role'] == 'teacher') u.id: _s(u.data['name']),
    };
    for (final u in users) {
      if (u.data['role'] != 'student') continue;
      final c = _int(u.data['class_id']);
      if (c != null && c != 0) {
        count[c] = (count[c] ?? 0) + 1;
        continue;
      }
      // row 197-Q04: a student with no class of its own belongs to its «پایه + رشته» group
      // (only active ones — the same list attendance shows)
      if (u.data['active'] == false || u.data['deleted'] == true) continue;
      for (final k in classes) {
        if (fieldGroupMember(k.data, u.data)) {
          count[k.id] = (count[k.id] ?? 0) + 1;
          break;
        }
      }
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
      room: _s(r.data['room']),
      capacity: _int(r.data['capacity']) ?? 30,
      teacherId: _int(r.data['teacher_id']),
      teacher: names[_int(r.data['teacher_id'])] ?? '',
    );
    int byName(ClassRow a, ClassRow b) => a.name.compareTo(b.name);
    final all = [for (final c in classes) row(c)];
    List<LookupRow> defs(String kind) {
      // row 197-Q04: one row per name — a grade defined twice («دهم» and «دهم») made the grade
      // menu of the class form fail (two equal values) and split the counts
      final field = kind == 'grade' ? 'grade' : 'branch';
      final seen = <String>{};
      final out = <LookupRow>[];
      final sorted = [
        for (final l in lookups)
          if (l.data['kind'] == kind && groupKey(l.data['name']).isNotEmpty) l,
      ]..sort((a, b) => a.id.compareTo(b.id));
      for (final l in sorted) {
        final k = groupKey(l.data['name']);
        if (!seen.add(k)) continue;
        out.add(
          LookupRow(
            id: l.id,
            kind: kind,
            name: _s(l.data['name']),
            order: _int(l.data['order']) ?? 0,
            classes: classes
                .where(
                  (c) =>
                      c.data['kind'] != 'room' && groupKey(c.data[field]) == k,
                )
                .length,
            queued: ql.contains(l.id),
            students: users
                .where(
                  (u) =>
                      u.data['role'] == 'student' &&
                      u.data['active'] != false &&
                      groupKey(
                            kind == 'grade'
                                ? u.data['grade']
                                : studentBranch(u.data),
                          ) ==
                          k,
                )
                .length,
          ),
        );
      }
      out.sort((a, b) => a.name.compareTo(b.name));
      return out;
    }

    return ClassesView(
      structure: await SchoolStructure.read(db),
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
    final structure = await SchoolStructure.read(db);
    if (!structure.gradeFits(grade)) {
      throw RecordFailure(
        'invalid',
        'پایهٔ «$grade» در مقطع این مدرسه («${structure.level}») نیست — پایه‌های مجاز: ${structure.grades.join('، ')}',
      );
    }
    // ردیف ۱۹۵: وقتی مقطع مدرسه معلوم است، نوع چیدمان از خود مقطع می‌آید (ابتدایی و متوسطه اول
    // کلاس‌محور، متوسطه دوم رشته‌محور) — نه از انتخاب دستی.
    final mode = structure.level.isNotEmpty
        ? (structure.fieldBased ? 'field' : 'class')
        : d.mode.trim().isNotEmpty
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
    if (mode == 'field' && !structure.fieldFits(branch)) {
      throw RecordFailure(
        'invalid',
        'رشتهٔ «$branch» جزو شاخه‌های اعلام‌شدهٔ مدرسه نیست — رشته‌ها را در «سیستم ← مشخصات مدرسه» تعیین کنید',
      );
    }
    if (mode == 'class') branch = '';
    final capText = SchoolRecords.digitsOnly(d.capacity.trim());
    final cap = capText.isEmpty ? null : int.tryParse(capText);
    if (d.capacity.trim().isNotEmpty && (cap == null || cap < 1 || cap > 200)) {
      throw const RecordFailure('invalid', 'ظرفیت باید عددی بین ۱ تا ۲۰۰ باشد');
    }
    if (d.teacherId != null) {
      final t = await db.get('users', d.teacherId!);
      if (t == null || t.data['role'] != 'teacher') {
        throw const RecordFailure(
          'invalid',
          'دبیر پایه باید یکی از دبیران مدرسه باشد',
        );
      }
    }
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
        'capacity': cap ?? _int(prev?.data['capacity']) ?? 30,
        'room': d.room.trim(),
        'teacher_id': d.teacherId,
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
    final structure = await SchoolStructure.read(db);
    if (k == 'grade' && gradeLevel(n) == 0) {
      throw RecordFailure(
        'invalid',
        '«$n» پایه نیست — پایه یکی از اول تا دوازدهم است',
      );
    }
    if (k == 'grade' && !structure.gradeFits(n)) {
      throw RecordFailure(
        'invalid',
        'پایهٔ «$n» در مقطع این مدرسه («${structure.level}») نیست — پایه‌های مجاز: ${structure.grades.join('، ')}',
      );
    }
    if (k == 'branch' && structure.level.isNotEmpty && structure.classBased) {
      throw RecordFailure(
        'invalid',
        'مدرسهٔ «${structure.level}» کلاس‌محور است و رشته ندارد — رشته فقط در متوسطه دوم معنا دارد',
      );
    }
    if (k == 'branch' && !structure.fieldFits(n)) {
      throw RecordFailure(
        'invalid',
        'رشتهٔ «$n» جزو شاخه‌های اعلام‌شدهٔ مدرسه نیست — مجاز: ${structure.allowedFields.join('، ')}',
      );
    }
    final all = await db.all('lookups');
    if (all.any(
      (l) => l.data['kind'] == k && _s(l.data['name']) == n && l.id != id,
    )) {
      throw RecordFailure(
        'duplicate',
        id == null
            ? 'این مورد قبلاً ثبت شده است'
            : '${lookupFa[k]} «$n» از قبل هست — برای یکی کردن این دو، «ادغام» را بزنید',
      );
    }
    final prev = id == null
        ? null
        : await db.existing('lookups', id, 'این مورد');
    final lid = id ?? await db.newId('lookups');
    final ord =
        _int(SchoolRecords.digitsOnly(order)) ??
        (all.where((l) => l.data['kind'] == k).length + 1);
    if (id != null && groupKey(n) != groupKey(prev?.data['name'])) {
      if (all.any(
        (l) =>
            l.data['kind'] == k &&
            groupKey(l.data['name']) == groupKey(n) &&
            l.id != id,
      )) {
        throw RecordFailure(
          'duplicate',
          '${lookupFa[k]} «$n» از قبل هست — برای یکی کردن این دو، «ادغام» را بزنید',
        );
      }
    }
    final key = await db.put('lookups', lid, {
      ...?prev?.data,
      'kind': k,
      'name': n,
      'order': ord == 0
          ? all.where((l) => l.data['kind'] == k).length + 1
          : ord,
    }, prev: prev);
    // row 201: a renamed grade/branch takes its students and classes along (they kept the old
    // name and fell out of every list)
    final old = _s(prev?.data['name']);
    final moved = prev == null || old == n
        ? (const <String>[], 0)
        : await _moveLookup(k, old, n);
    return RecordWrite(
      '${lookupFa[k]}${id == null ? ' ثبت شد' : ' ویرایش شد'}'
      '${moved.$2 > 0 ? ' · ${moved.$2} دانش‌آموز هم به‌روز شد' : ''}',
      id: lid,
      keys: [key, ...moved.$1],
    );
  }

  /// Row 201: students and classes of the grade/branch [from] go to [to] (a rename or a
  /// merge); a class that would then have the name of another one is merged into it.
  /// Returns the write keys and the number of students changed.
  Future<(List<String>, int)> _moveLookup(
    String kind,
    String from,
    String to,
  ) async {
    final k = groupKey(from);
    if (k.isEmpty || k == groupKey(to) && from == to) return (<String>[], 0);
    final field = kind == 'grade' ? 'grade' : 'branch';
    final users = await db.allOrEmpty('users');
    final classes = await db.allOrEmpty('classes');
    final kids = [
      for (final u in users)
        if (u.data['role'] == 'student' &&
            (kind == 'grade'
                ? groupKey(u.data['grade']) == k
                : groupKey(u.data['field']) == k ||
                      groupKey(u.data['branch']) == k))
          u,
    ];
    final touched = [
      for (final c in classes)
        if (c.data['kind'] != 'room' && groupKey(c.data[field]) == k) c,
    ];
    db.requireRoom(kids.length + touched.length);
    final keys = <String>[];
    for (final u in kids) {
      final d = {...u.data};
      if (kind == 'grade') {
        d['grade'] = to;
      } else {
        if (groupKey(d['field']) == k) d['field'] = to;
        if (groupKey(d['branch']) == k) d['branch'] = to;
      }
      keys.add(await db.put('users', u.id, d, prev: u));
    }
    final merges = <(int, int)>[];
    for (final c in touched) {
      final g = _s(c.data['grade']), b = _s(c.data['branch']);
      final ng = kind == 'grade' ? to : g;
      final nb = kind == 'grade' ? b : to;
      final name = _s(c.data['name']);
      // a name made of its grade and branch («دهم تعمیر موتور موتور») follows them
      final auto =
          groupKey(name) == groupKey('$g $b') || groupKey(name) == groupKey(g);
      final newName = !auto
          ? name
          : (groupKey(name) == groupKey(g) && b.isEmpty
                ? ng
                : '$ng${nb.isEmpty ? '' : ' $nb'}');
      final twin = classes
          .where(
            (x) =>
                x.id != c.id &&
                x.data['kind'] != 'room' &&
                groupKey(x.data['name']) == groupKey(newName),
          )
          .firstOrNull;
      if (twin != null) {
        merges.add((c.id, twin.id));
        continue;
      }
      keys.add(
        await db.put('classes', c.id, {
          ...c.data,
          'name': newName,
          'grade': ng,
          'branch': nb,
        }, prev: c),
      );
    }
    for (final (a, b) in merges) {
      keys.addAll((await mergeClass(a, b)).keys);
    }
    return (keys, kids.length);
  }

  /// Row 201 `def-merge`: everything of the grade/branch [from] (students, classes) goes to
  /// [into]; [from] — and any other definition written the same way — is deleted.
  Future<RecordWrite> mergeLookup(int from, int into) async {
    _requireManager();
    if (from == into) {
      throw const RecordFailure('invalid', 'مقصد ادغام را انتخاب کنید');
    }
    final a = await db.existing('lookups', from, 'این مورد');
    final b = await db.existing('lookups', into, 'مقصد ادغام');
    final k = _s(a.data['kind']) == 'grade' ? 'grade' : 'branch';
    if (_s(b.data['kind']) != _s(a.data['kind'])) {
      throw const RecordFailure(
        'invalid',
        'پایه فقط با پایه و رشته فقط با رشته ادغام می‌شود',
      );
    }
    final fromName = _s(a.data['name']), toName = _s(b.data['name']);
    final moved = await _moveLookup(k, fromName, toName);
    final keys = [...moved.$1];
    for (final l in await db.all('lookups')) {
      if (l.id != into &&
          l.data['kind'] == a.data['kind'] &&
          groupKey(l.data['name']) == groupKey(fromName)) {
        keys.add(await db.del('lookups', l));
      }
    }
    return RecordWrite(
      '«$fromName» در «$toName» ادغام شد'
      '${moved.$2 > 0 ? ' · ${moved.$2} دانش‌آموز منتقل شد' : ''}',
      id: into,
      keys: keys,
    );
  }

  /// Row 201: the detail panel of a grade/branch.
  Future<LookupDetail> lookupDetail(int id) async {
    db.requireRead('classes');
    final l = await db.existing('lookups', id, 'این مورد');
    final kind = _s(l.data['kind']) == 'grade' ? 'grade' : 'branch';
    final name = _s(l.data['name']);
    final k = groupKey(name);
    final students = <(int, String, String)>[
      for (final u in await db.allOrEmpty('users'))
        if (u.data['role'] == 'student' &&
            u.data['active'] != false &&
            groupKey(
                  kind == 'grade' ? u.data['grade'] : studentBranch(u.data),
                ) ==
                k)
          (
            u.id,
            _s(u.data['name']),
            kind == 'grade' ? studentBranch(u.data) : _s(u.data['grade']),
          ),
    ]..sort((a, b) => a.$2.compareTo(b.$2));
    final field = kind == 'grade' ? 'grade' : 'branch';
    final classes = [
      for (final c in await db.allOrEmpty('classes'))
        if (c.data['kind'] != 'room' && groupKey(c.data[field]) == k)
          _s(c.data['name']),
    ]..sort();
    // the definition this one duplicates (never the other way round: «تعمیر موتور» is not
    // offered to go into «تعمیر موتور موتور»)
    int? likeId;
    var like = '', why = '';
    if (kind == 'branch') {
      final others = [
        for (final o in await db.allOrEmpty('lookups'))
          if (o.data['kind'] == 'branch' &&
              o.id != id &&
              groupKey(o.data['name']).isNotEmpty)
            o,
      ];
      final (to, w) = importBranchGuess(name, [
        for (final o in others) _s(o.data['name']),
      ]);
      if (lookupLikeFa.containsKey(w) && !(w == 'same' && to == name)) {
        likeId = others.firstWhere((o) => _s(o.data['name']) == to).id;
        like = to;
        why = w;
      }
    }
    return LookupDetail(
      students: students,
      classes: classes,
      likeId: likeId,
      like: like,
      why: why,
    );
  }

  /// Row 201: the detail panel of a class / room.
  Future<ClassDetail> classDetail(int id) async {
    db.requireRead('classes');
    final c = await db.existing('classes', id, 'این کلاس');
    final students = <(int, String)>[
      for (final u in await db.allOrEmpty('users'))
        if (u.data['role'] == 'student' &&
            u.data['active'] != false &&
            (_int(u.data['class_id']) == id ||
                fieldGroupMember(c.data, u.data)))
          (u.id, _s(u.data['name'])),
    ]..sort((a, b) => a.$2.compareTo(b.$2));
    final slots = (await db.allOrEmpty('schedule'))
        .where((x) => _int(x.data['class_id']) == id)
        .length;
    return ClassDetail(students: students, slots: slots);
  }

  /// Row 201: the detail panel of a subject.
  Future<SubjectDetail> subjectDetail(int id) async {
    db.requireRead('classes');
    await db.existing('subjects', id, 'این درس');
    final slots = (await db.allOrEmpty('schedule'))
        .where((x) => _int(x.data['subject_id']) == id)
        .toList();
    final cls = {
      for (final c in await db.allOrEmpty('classes')) c.id: _s(c.data['name']),
    };
    final ppl = {
      for (final u in await db.allOrEmpty('users')) u.id: _s(u.data['name']),
    };
    return SubjectDetail(
      classes: {
        for (final x in slots)
          if ((cls[_int(x.data['class_id'])] ?? '').isNotEmpty)
            cls[_int(x.data['class_id'])]!,
      }.toList()..sort(),
      teachers: {
        for (final x in slots)
          if ((ppl[_int(x.data['teacher_id'])] ?? '').isNotEmpty)
            ppl[_int(x.data['teacher_id'])]!,
      }.toList()..sort(),
      slots: slots.length,
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
