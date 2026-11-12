// Row 128, wave W9 — the weekly schedule (web client/schedule.js `schedPage`, forms `slot`,
// `bells`, `workdays`, `sched-teacher`, `sched-room`, actions sched-* / slot-del / sub-* / bell-* /
// schedgen-* / workdays-edit). Same semantics as the web client:
//   * the manager plans per grade + branch («پایه و رشته»); the cohort's class row is created on
//     the first saved slot (web `schedGroupFor(…, true)`);
//   * a slot needs a subject and an active school day; the cohort, the teacher (school-wide) and
//     the room must be free at that day + bell — a clash is refused, never stored;
//   * existing clashes (imported/merged data) are listed with up to three free slots to move to;
//   * a substitution (دبیر جایگزین) is for one date that must fall on the slot's weekday, by
//     another teacher who is free at that bell;
//   * bells: rows of start/end (HH:MM, increasing, no overlap) typed lesson or break; lessons are
//     numbered 1..n, breaks get n + k/(k+1); rows removed in the form are deleted;
//   * work days live on schools/1 `workdays` (0 = Saturday … 5 = Thursday);
//   * the generator is the web p2 algorithm (demands by weekly_hours, specialist teachers, least
//     loaded first, one-day spread, displacement); applying only fills empty cells.
// Every write is queue-first through SchoolRecords; multi-row writes reserve queue room first.
// The server re-checks the role (server/policy.js: schedule/bell_schedules/substitutions/schools
// are written by the manager only).
import 'package:payesh_data/payesh_data.dart';

import 'classes.dart' show gradeLevel, normName;
import 'records.dart';

const List<String> schedDayFa = [
  'شنبه',
  'یک‌شنبه',
  'دوشنبه',
  'سه‌شنبه',
  'چهارشنبه',
  'پنج‌شنبه',
];

String _faDigits(Object n) => '$n'.replaceAllMapped(
  RegExp('[0-9]'),
  (m) => '۰۱۲۳۴۵۶۷۸۹'[int.parse(m[0]!)],
);

/// Web `schedTime`: «۷:۴۵» / "7:45" → "07:45"; anything else → ''.
String schedTime(Object? v) {
  final s = SchoolRecords.str(
    v,
  ).replaceAllMapped(RegExp('[۰-۹٠-٩]'), (m) => SchoolRecords.digitsOnly(m[0]));
  final m = RegExp(r'^(\d{1,2}):(\d{2})$').firstMatch(s.replaceAll(' ', ''));
  if (m == null) return '';
  final h = int.parse(m[1]!), min = int.parse(m[2]!);
  if (h > 23 || min > 59) return '';
  return '${'$h'.padLeft(2, '0')}:${'$min'.padLeft(2, '0')}';
}

/// Saturday = 0 … Friday = 6 for an ISO date (web `(getDay() + 1) % 7`).
int schoolWeekday(String iso) {
  final d = DateTime.parse('${iso.substring(0, 10)}T12:00:00');
  return (d.weekday % 7 + 1) % 7;
}

final class Bell {
  const Bell({
    required this.id,
    required this.order,
    required this.start,
    required this.end,
    required this.type,
    required this.label,
  });
  final int id;
  final num order;
  final String start;
  final String end;
  final String type;
  final String label;
  bool get isBreak => type == 'break';
}

/// One row of the bells form (`bells`): id 0 = new.
final class BellDraft {
  const BellDraft({
    this.id = 0,
    this.start = '',
    this.end = '',
    this.type = 'lesson',
  });
  final int id;
  final String start;
  final String end;
  final String type;
}

final class Slot {
  const Slot({
    required this.id,
    required this.classId,
    required this.grade,
    required this.branch,
    required this.day,
    required this.period,
    required this.subjectId,
    required this.subject,
    required this.teacherId,
    required this.teacher,
    required this.roomId,
    required this.room,
    required this.queued,
    this.subToday,
  });
  final int id;
  final int? classId;
  final String grade;
  final String branch;
  final int day;
  final int period;
  final int? subjectId;
  final String subject;
  final int? teacherId;
  final String teacher;
  final int? roomId;
  final String room;
  final bool queued;

  /// The substitute teacher of today, if any.
  final String? subToday;
  String get cohort =>
      grade.isEmpty ? '' : '$grade${branch.isEmpty ? '' : ' $branch'}';
}

final class Sub {
  const Sub({
    required this.id,
    required this.slotId,
    required this.date,
    required this.teacherId,
    required this.teacher,
    required this.slotLabel,
  });
  final int id;
  final int slotId;
  final String date;
  final int teacherId;
  final String teacher;
  final String slotLabel;
}

/// A clash already in the data (web `schedConflicts`).
final class Clash {
  const Clash({
    required this.kind,
    required this.who,
    required this.day,
    required this.period,
    required this.rows,
  });

  /// 'class' | 'teacher'.
  final String kind;
  final String who;
  final int day;
  final int period;
  final List<Slot> rows;
}

final class TeacherOption {
  const TeacherOption(this.id, this.name, this.busy);
  final int id;
  final String name;
  final bool busy;
}

final class TimetableView {
  const TimetableView({
    required this.title,
    required this.days,
    required this.periods,
    required this.slots,
    required this.clashes,
    required this.subs,
    required this.canEdit,
    this.grades = const [],
    this.branches = const [],
    this.grade = '',
    this.branch = '',
    this.cohortClassId,
    this.homeClasses = const [],
    this.children = const [],
  });
  final String title;
  final List<int> days;
  final List<Bell> periods;
  final List<Slot> slots;
  final List<Clash> clashes;
  final List<Sub> subs;
  final bool canEdit;
  final List<String> grades;
  final List<String> branches;
  final String grade;
  final String branch;
  final int? cohortClassId;

  /// Teacher: classes where they are the home-room teacher («سرپرستی»).
  final List<(int, String)> homeClasses;

  /// Parent: own children (web `sched-class` picker).
  final List<(int, String)> children;

  Slot? at(int day, int period) {
    for (final s in slots) {
      if (s.day == day && s.period == period) return s;
    }
    return null;
  }
}

/// What the slot form sends (`slot`).
final class SlotDraft {
  const SlotDraft({
    this.id,
    required this.grade,
    this.branch = '',
    this.classId,
    required this.day,
    required this.period,
    this.subjectId,
    this.teacherId,
    this.roomId,
    this.legacyRoom = '',
  });
  final int? id;
  final String grade;
  final String branch;
  final int? classId;
  final int day;
  final int period;
  final int? subjectId;
  final int? teacherId;
  final int? roomId;
  final String legacyRoom;
}

final class GenPlacement {
  GenPlacement(
    this.classId,
    this.subjectId,
    this.teacherId,
    this.day,
    this.period,
  );
  final int classId;
  final int subjectId;
  final int? teacherId;
  int day;
  int period;
}

final class GenUnplaced {
  const GenUnplaced(this.classId, this.subjectId, this.teacherId, this.reason);
  final int classId;
  final int subjectId;
  final int? teacherId;
  final String reason;
}

final class GenResult {
  const GenResult(
    this.placements,
    this.unplaced,
    this.demands,
    this.noSpecialist,
  );
  final List<GenPlacement> placements;
  final List<GenUnplaced> unplaced;
  final int demands;
  final int noSpecialist;
}

final class Timetable {
  Timetable(this.db);
  final SchoolRecords db;

  bool get canManage => db.role == 'manager';

  static int? _int(Object? v) => SchoolRecords.asInt(v);
  static String _s(Object? v) => SchoolRecords.str(v);

  void _requireManager() {
    if (!canManage) {
      throw const RecordFailure(
        'not_allowed',
        'برنامهٔ هفتگی را فقط مدیر تغییر می‌دهد',
      );
    }
  }

  // ─────────────────────────────── reading ───────────────────────────────

  Future<List<int>> workDays() async {
    final s = await db.get('schools', 1);
    final raw = s?.data['workdays'];
    final list = raw is List ? raw : const [0, 1, 2, 3, 4, 5];
    final out = {
      for (final d in list)
        if (_int(d) case final int n when n >= 0 && n < schedDayFa.length) n,
    }.toList()..sort();
    return out;
  }

  /// All bell rows (lessons and breaks) in order.
  Future<List<Bell>> bells() async {
    final rows = await db.allOrEmpty('bell_schedules');
    final out = [
      for (final b in rows)
        Bell(
          id: b.id,
          order: num.tryParse('${b.data['order'] ?? 0}') ?? 0,
          start: _s(b.data['start']),
          end: _s(b.data['end']),
          type: _s(b.data['type']).isEmpty ? 'lesson' : _s(b.data['type']),
          label: _s(b.data['label']),
        ),
    ]..sort((a, b) => a.order.compareTo(b.order));
    return out;
  }

  /// Lesson bells (web `schedLessons`): one per order; four defaults when none is defined.
  Future<List<Bell>> lessons() async {
    final seen = <num>{};
    final out = [
      for (final b in await bells())
        if (!b.isBreak && seen.add(b.order)) b,
    ];
    if (out.isNotEmpty) return out;
    return [
      for (final n in [1, 2, 3, 4])
        Bell(
          id: 0,
          order: n,
          start: '',
          end: '',
          type: 'lesson',
          label: 'زنگ ${_faDigits(n)} (درس)',
        ),
    ];
  }

  Future<Map<int, String>> _names(String collection) async => {
    for (final r in await db.allOrEmpty(collection))
      r.id: _s(r.data['name'] ?? r.data['full_name']),
  };

  Future<List<Slot>> _slots() async {
    final rows = await db.allOrEmpty('schedule');
    final subjects = await _names('subjects');
    final users = await _names('users');
    final classes = await _names('classes');
    final q = db.queuedIds('schedule');
    final today = db.today();
    final subsToday = <int, int>{};
    for (final x in await db.allOrEmpty('substitutions')) {
      final sid = _int(x.data['schedule_id']);
      if (sid != null && _s(x.data['date']).startsWith(today)) {
        subsToday[sid] = _int(x.data['sub_teacher_id']) ?? 0;
      }
    }
    return [
      for (final r in rows)
        Slot(
          id: r.id,
          classId: _int(r.data['class_id']),
          grade: _s(r.data['grade']),
          branch: _s(r.data['branch']),
          day: _int(r.data['weekday']) ?? 0,
          period: _int(r.data['bell_order']) ?? 0,
          subjectId: _int(r.data['subject_id']),
          subject: subjects[_int(r.data['subject_id'])] ?? '—',
          teacherId: _int(r.data['teacher_id']),
          teacher: users[_int(r.data['teacher_id'])] ?? 'بدون دبیر',
          roomId: _int(r.data['room_id']),
          room: _s(r.data['room']).isNotEmpty
              ? _s(r.data['room'])
              : (classes[_int(r.data['room_id'])] ?? ''),
          queued: q.contains(r.id),
          subToday: subsToday.containsKey(r.id)
              ? (users[subsToday[r.id]] ?? 'بدون دبیر')
              : null,
        ),
    ]..sort((a, b) => a.id.compareTo(b.id));
  }

  /// Web `schedConflicts`: same cohort/class or same teacher twice at one day + bell.
  Future<List<Clash>> clashes([List<Slot>? given]) async {
    final rows = given ?? await _slots();
    final classes = await _names('classes');
    final out = <Clash>[];
    final seenT = <String>{}, seenC = <String>{};
    for (final r in rows) {
      if (r.teacherId != null) {
        final k = '${r.teacherId}|${r.day}|${r.period}';
        if (seenT.add(k)) {
          final all = rows
              .where(
                (x) =>
                    x.teacherId == r.teacherId &&
                    x.day == r.day &&
                    x.period == r.period,
              )
              .toList();
          if (all.length > 1) {
            out.add(
              Clash(
                kind: 'teacher',
                who: r.teacher,
                day: r.day,
                period: r.period,
                rows: all,
              ),
            );
          }
        }
      }
      final kc = '${r.classId}|${r.day}|${r.period}';
      if (seenC.add(kc)) {
        final all = rows
            .where(
              (x) =>
                  x.classId == r.classId &&
                  x.day == r.day &&
                  x.period == r.period,
            )
            .toList();
        if (all.length > 1) {
          out.add(
            Clash(
              kind: 'class',
              who: classes[r.classId] ?? r.cohort,
              day: r.day,
              period: r.period,
              rows: all,
            ),
          );
        }
      }
    }
    out.sort(
      (a, b) => a.day != b.day
          ? a.day - b.day
          : a.period != b.period
          ? a.period - b.period
          : (a.kind == b.kind ? 0 : (a.kind == 'class' ? -1 : 1)),
    );
    return out;
  }

  Future<String> _subLabel(EngineRow? slot) async {
    if (slot == null) return '';
    final subjects = await _names('subjects');
    return '${schedDayFa[(_int(slot.data['weekday']) ?? 0).clamp(0, 5)]} زنگ ${_faDigits(_int(slot.data['bell_order']) ?? 0)}، ${subjects[_int(slot.data['subject_id'])] ?? '—'}';
  }

  /// The page (`page:schedule`) for the signed-in role.
  ///  * manager: the cohort [grade] + [branch] (defaults: first grade, first branch of it);
  ///  * teacher: own teaching, or the home class [homeClass] («سرپرستی»);
  ///  * student: own class/cohort; parent: the child [child] (default: first child).
  Future<TimetableView> view({
    String? grade,
    String? branch,
    int? homeClass,
    int? child,
  }) async {
    db.requireRead('schedule');
    final role = db.role;
    final all = await _slots();
    final days = await workDays();
    final shown = days.isEmpty ? const [0, 1, 2, 3, 4, 5] : days;
    final periods = await lessons();
    final classes = await db.allOrEmpty('classes');
    final groups = [
      for (final c in classes)
        if (c.data['kind'] != 'room') c,
    ]..sort((a, b) => _s(a.data['name']).compareTo(_s(b.data['name'])));
    final subRows = await db.allOrEmpty('substitutions');
    final users = await _names('users');
    Future<List<Sub>> subsOf(List<Slot> rows) async {
      final ids = {for (final r in rows) r.id};
      final out = <Sub>[];
      for (final x in subRows) {
        final sid = _int(x.data['schedule_id']);
        if (sid == null || !ids.contains(sid)) continue;
        out.add(
          Sub(
            id: x.id,
            slotId: sid,
            date: _s(x.data['date']),
            teacherId: _int(x.data['sub_teacher_id']) ?? 0,
            teacher: users[_int(x.data['sub_teacher_id'])] ?? 'بدون دبیر',
            slotLabel: await _subLabel(await db.get('schedule', sid)),
          ),
        );
      }
      out.sort((a, b) => a.date.compareTo(b.date));
      return out;
    }

    bool sameCohort(Slot s, String g, String b) =>
        s.grade.trim() == g.trim() && s.branch.trim() == b.trim();

    if (role == 'manager') {
      final lookups = await db.allOrEmpty('lookups');
      List<String> namesOf(String kind, String field) {
        final set = <String>{
          for (final l in lookups)
            if (l.data['kind'] == kind) _s(l.data['name']),
          for (final c in groups) _s(c.data[field]),
        }..remove('');
        return set.toList()..sort();
      }

      final grades = namesOf('grade', 'grade');
      final g = grade ?? (grades.isEmpty ? '' : grades.first);
      final matching = groups.where((c) => _s(c.data['grade']) == g).toList();
      final branches = <String>{
        for (final c in matching) _s(c.data['branch']),
        ...namesOf('branch', 'branch'),
      }..remove('');
      final b =
          branch ?? (matching.isEmpty ? '' : _s(matching.first.data['branch']));
      final group = _groupOf(classes, g, b);
      final rows = [
        for (final s in all)
          if (sameCohort(s, g, b) ||
              (s.grade.isEmpty && group != null && s.classId == group.id))
            s,
      ];
      return TimetableView(
        title: 'برنامهٔ هفتگی',
        days: shown,
        periods: periods,
        slots: rows,
        clashes: await clashes(all),
        subs: g.isEmpty ? const [] : await subsOf(rows),
        canEdit: g.isNotEmpty,
        grades: grades,
        branches: branches.toList()..sort(),
        grade: g,
        branch: b,
        cohortClassId: group?.id,
      );
    }
    if (role == 'teacher') {
      final home = [
        for (final c in groups)
          if (_int(c.data['teacher_id']) == db.uid) (c.id, _s(c.data['name'])),
      ];
      final inHome = homeClass != null && home.any((h) => h.$1 == homeClass);
      final rows = [
        for (final s in all)
          if (inHome ? s.classId == homeClass : s.teacherId == db.uid) s,
      ];
      final mine = (await clashes(all))
          .where((c) => c.kind == 'teacher' && c.rows.first.teacherId == db.uid)
          .toList();
      return TimetableView(
        title: inHome
            ? 'برنامهٔ کلاسی ${home.firstWhere((h) => h.$1 == homeClass).$2}'
            : 'برنامهٔ هفتگی تدریس من',
        days: shown,
        periods: periods,
        slots: rows,
        clashes: mine,
        subs: const [],
        canEdit: false,
        homeClasses: home,
      );
    }
    // student / parent / other staff: read-only view of one class
    var children = <(int, String)>[];
    int? classId;
    String g = '', b = '';
    Future<void> cohortOf(EngineRow? u) async {
      if (u == null) return;
      classId = _int(u.data['class_id']);
      final cls = classId == null ? null : await db.get('classes', classId!);
      g = _s(u.data['grade']).isNotEmpty
          ? _s(u.data['grade'])
          : _s(cls?.data['grade']);
      b = _s(u.data['branch']).isNotEmpty
          ? _s(u.data['branch'])
          : _s(cls?.data['branch']);
    }

    if (role == 'student') {
      await cohortOf(await db.get('users', db.uid));
    } else if (role == 'parent') {
      final links = await db.allOrEmpty('parent_links');
      for (final l in links) {
        if (_int(l.data['parent_id']) != db.uid) continue;
        final k = await db.get('users', _int(l.data['student_id']) ?? -1);
        if (k != null) children.add((k.id, _s(k.data['name'])));
      }
      children = children.toList()..sort((a, b) => a.$1.compareTo(b.$1));
      final pick = children.any((c) => c.$1 == child)
          ? child
          : (children.isEmpty ? null : children.first.$1);
      if (pick != null) await cohortOf(await db.get('users', pick));
    } else {
      classId = groups.isEmpty ? null : groups.first.id;
    }
    final rows = [
      for (final s in all)
        if ((classId != null && s.classId == classId) ||
            (g.isNotEmpty && sameCohort(s, g, b)))
          s,
    ];
    return TimetableView(
      title: 'برنامهٔ هفتگی',
      days: shown,
      periods: periods,
      slots: rows,
      clashes: const [],
      subs: const [],
      canEdit: false,
      children: children,
    );
  }

  static EngineRow? _groupOf(List<EngineRow> classes, String g, String b) {
    if (g.trim().isEmpty) return null;
    for (final c in classes) {
      if (c.data['kind'] != 'room' &&
          _s(c.data['grade']) == g.trim() &&
          _s(c.data['branch']) == b.trim()) {
        return c;
      }
    }
    return null;
  }

  /// Teachers of the slot form, marked busy at [day] + [period] (web 🟢/🔴).
  Future<List<TeacherOption>> teachers({
    int? day,
    int? period,
    int? exceptSlot,
  }) async {
    final rows = await db.allOrEmpty('schedule');
    final out = [
      for (final u in await db.allOrEmpty('users'))
        if (u.data['role'] == 'teacher' && u.data['active'] != false)
          TeacherOption(
            u.id,
            _s(u.data['name']),
            day != null &&
                period != null &&
                _busy(rows, 'teacher_id', u.id, day, period, exceptSlot),
          ),
    ]..sort((a, b) => a.name.compareTo(b.name));
    return out;
  }

  Future<List<(int, String)>> subjects() async => [
    for (final s in await db.allOrEmpty('subjects')) (s.id, _s(s.data['name'])),
  ]..sort((a, b) => a.$2.compareTo(b.$2));

  /// Rooms (web `schedRooms`): kind room, or legacy rows without grade/branch.
  Future<List<(int, String)>> rooms() async => [
    for (final c in await db.allOrEmpty('classes'))
      if (c.data['kind'] == 'room' ||
          (c.data['kind'] == null &&
              _s(c.data['grade']).isEmpty &&
              _s(c.data['branch']).isEmpty))
        (c.id, _s(c.data['name'])),
  ]..sort((a, b) => a.$2.compareTo(b.$2));

  static bool _busy(
    List<EngineRow> rows,
    String field,
    int value,
    int day,
    int period,
    int? except,
  ) => rows.any(
    (x) =>
        _int(x.data[field]) == value &&
        _int(x.data['weekday']) == day &&
        _int(x.data['bell_order']) == period &&
        x.id != except,
  );

  // ─────────────────────────────── writing ───────────────────────────────

  /// Form `slot` (`sched-slot`): add or edit one cell.
  Future<RecordWrite> saveSlot(SlotDraft d) async {
    _requireManager();
    final grade = d.grade.trim(), branch = d.branch.trim();
    if (grade.isEmpty) {
      throw const RecordFailure('invalid', 'پایه را انتخاب کنید');
    }
    if (d.subjectId == null) {
      throw const RecordFailure('invalid', 'درس را انتخاب کنید');
    }
    if (!(await workDays()).contains(d.day)) {
      throw const RecordFailure('invalid', 'این روز در روزهای فعال مدرسه نیست');
    }
    final rows = await db.allOrEmpty('schedule');
    final classes = await db.all('classes');
    final group = _groupOf(classes, grade, branch);
    final classId = group?.id ?? d.classId;
    bool same(EngineRow x) =>
        _int(x.data['weekday']) == d.day &&
        _int(x.data['bell_order']) == d.period &&
        x.id != d.id;
    final dup = rows.any(
      (x) =>
          same(x) &&
          ((_s(x.data['grade']) == grade && _s(x.data['branch']) == branch) ||
              (_s(x.data['grade']).isEmpty &&
                  classId != null &&
                  _int(x.data['class_id']) == classId)),
    );
    if (dup) {
      throw const RecordFailure(
        'duplicate',
        'این پایه و رشته در آن روز و زنگ برنامه دارد',
      );
    }
    if (d.teacherId != null &&
        _busy(rows, 'teacher_id', d.teacherId!, d.day, d.period, d.id)) {
      throw RecordFailure(
        'duplicate',
        'تداخل ساعت: این دبیر ${schedDayFa[d.day]} زنگ ${_faDigits(d.period)} برنامهٔ دیگری دارد',
      );
    }
    if (d.roomId != null &&
        _busy(rows, 'room_id', d.roomId!, d.day, d.period, d.id)) {
      throw const RecordFailure(
        'duplicate',
        'این محل در آن روز و زنگ رزرو شده است',
      );
    }
    final prev = d.id == null
        ? null
        : await db.existing('schedule', d.id!, 'این زنگ');
    db.requireRoom(group == null ? 2 : 1);
    final keys = <String>[];
    var cid = classId;
    if (group == null) {
      // web schedGroupFor(grade, branch, true): the cohort's class row
      final name = '$grade${branch.isEmpty ? '' : ' $branch'}';
      final byName = classes.where(
        (c) =>
            c.data['kind'] != 'room' &&
            normName(c.data['name']) == normName(name),
      );
      if (byName.isNotEmpty) {
        cid = byName.first.id;
      } else {
        cid = await db.newId('classes');
        keys.add(
          await db.put('classes', cid, {
            'name': name,
            'grade': grade,
            'branch': branch,
            'mode': branch.isEmpty ? 'class' : 'field',
            'grade_level': gradeLevel(grade),
            'kind': 'class',
            'capacity': 30,
          }),
        );
      }
    }
    final roomName = d.roomId == null
        ? d.legacyRoom
        : _s((await db.get('classes', d.roomId!))?.data['name']);
    final id = d.id ?? await db.newId('schedule');
    keys.add(
      await db.put('schedule', id, {
        ...?prev?.data,
        'class_id': cid,
        'grade': grade,
        'branch': branch,
        'subject_id': d.subjectId,
        'teacher_id': d.teacherId,
        'room_id': d.roomId,
        'room': roomName,
        'weekday': d.day,
        'bell_order': d.period,
      }, prev: prev),
    );
    return RecordWrite('برنامه ذخیره شد', id: id, keys: keys);
  }

  /// `slot-del`: the slot and its substitutions.
  Future<RecordWrite> deleteSlot(int id) async {
    _requireManager();
    final r = await db.existing('schedule', id, 'این زنگ');
    final subs = (await db.allOrEmpty('substitutions'))
        .where((x) => _int(x.data['schedule_id']) == id)
        .toList();
    db.requireRoom(subs.length + 1);
    final keys = <String>[
      for (final x in subs) await db.del('substitutions', x),
    ];
    keys.add(await db.del('schedule', r));
    return RecordWrite('زنگ حذف شد', id: id, keys: keys);
  }

  /// `sched-conf-sug`: up to three free (day, bell) for the slot (cohort and teacher free).
  Future<List<(int, int)>> suggest(int id) async {
    final row = await db.get('schedule', id);
    if (row == null) return const [];
    final rows = await db.allOrEmpty('schedule');
    final days = await workDays();
    final periods = [for (final b in await lessons()) b.order.toInt()];
    final out = <(int, int)>[];
    final cls = _int(row.data['class_id']);
    final t = _int(row.data['teacher_id']);
    for (final d in days.isEmpty ? const [0, 1, 2, 3, 4, 5] : days) {
      for (final p in periods) {
        if (out.length >= 3) return out;
        if (_int(row.data['weekday']) == d &&
            _int(row.data['bell_order']) == p) {
          continue;
        }
        if (cls != null && _busy(rows, 'class_id', cls, d, p, id)) continue;
        if (t != null && _busy(rows, 'teacher_id', t, d, p, id)) continue;
        out.add((d, p));
      }
    }
    return out;
  }

  /// `sched-conf-move`.
  Future<RecordWrite> move(int id, int day, int period) async {
    _requireManager();
    final r = await db.existing('schedule', id, 'این زنگ');
    if (!(await workDays()).contains(day)) {
      throw const RecordFailure(
        'invalid',
        'روز انتخاب‌شده در روزهای فعال مدرسه نیست',
      );
    }
    final rows = await db.allOrEmpty('schedule');
    final cls = _int(r.data['class_id']);
    if (cls != null && _busy(rows, 'class_id', cls, day, period, id)) {
      throw const RecordFailure('duplicate', 'این جای کلاس دیگر پر شده است');
    }
    final t = _int(r.data['teacher_id']);
    if (t != null && _busy(rows, 'teacher_id', t, day, period, id)) {
      throw const RecordFailure('duplicate', 'این دبیر در آن ساعت مشغول است');
    }
    final k = await db.put('schedule', id, {
      ...r.data,
      'weekday': day,
      'bell_order': period,
    }, prev: r);
    return RecordWrite(
      'زنگ جابه‌جا شد: ${schedDayFa[day]} زنگ ${_faDigits(period)}',
      id: id,
      keys: [k],
    );
  }

  /// `sub-save`: substitute teacher for one date of the slot.
  Future<RecordWrite> saveSub(
    int slotId,
    String dateIso,
    int? teacherId,
  ) async {
    _requireManager();
    final slot = await db.get('schedule', slotId);
    if (slot == null) {
      throw const RecordFailure('unknown', 'اول زنگ را ذخیره کنید');
    }
    if (!RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(dateIso)) {
      throw const RecordFailure('invalid', 'تاریخ شمسی معتبر را وارد کنید');
    }
    if (teacherId == null) {
      throw const RecordFailure('invalid', 'دبیر جایگزین را انتخاب کنید');
    }
    if (teacherId == _int(slot.data['teacher_id'])) {
      throw const RecordFailure(
        'invalid',
        'دبیر جایگزین نمی‌تواند همان دبیرِ این زنگ باشد',
      );
    }
    final wd = _int(slot.data['weekday']) ?? 0;
    if (schoolWeekday(dateIso) != wd) {
      throw RecordFailure('invalid', 'تاریخ باید روز «${schedDayFa[wd]}» باشد');
    }
    final rows = await db.allOrEmpty('schedule');
    if (_busy(
      rows,
      'teacher_id',
      teacherId,
      wd,
      _int(slot.data['bell_order']) ?? 0,
      slotId,
    )) {
      throw const RecordFailure('duplicate', 'این دبیر در آن ساعت کلاس دارد');
    }
    final ex = (await db.allOrEmpty('substitutions'))
        .where((x) => _int(x.data['schedule_id']) == slotId)
        .firstOrNull;
    final id = ex?.id ?? await db.newId('substitutions');
    final k = await db.put('substitutions', id, {
      ...?ex?.data,
      'schedule_id': slotId,
      'class_id': _int(slot.data['class_id']),
      'sub_teacher_id': teacherId,
      'date': dateIso,
    }, prev: ex);
    return RecordWrite('جابه‌جای ثبت شد', id: id, keys: [k]);
  }

  /// `sub-del`: every substitution of the slot.
  Future<RecordWrite> deleteSubsOf(int slotId) async {
    _requireManager();
    final subs = (await db.allOrEmpty('substitutions'))
        .where((x) => _int(x.data['schedule_id']) == slotId)
        .toList();
    db.requireRoom(subs.length);
    final keys = [for (final x in subs) await db.del('substitutions', x)];
    return RecordWrite('جابه‌جای حذف شد', id: slotId, keys: keys);
  }

  /// `sub-del-route`: one substitution from the list under the grid.
  Future<RecordWrite> deleteSub(int id) async {
    _requireManager();
    final r = await db.existing('substitutions', id, 'این جابه‌جای');
    return RecordWrite(
      'جابه‌جای حذف شد',
      id: id,
      keys: [await db.del('substitutions', r)],
    );
  }

  /// Form `workdays`.
  Future<RecordWrite> saveWorkdays(Iterable<int> days) async {
    _requireManager();
    final list = {
      for (final d in days)
        if (d >= 0 && d < schedDayFa.length) d,
    }.toList()..sort();
    if (list.isEmpty) {
      throw const RecordFailure('invalid', 'دست‌کم یک روز فعال انتخاب کنید');
    }
    final prev = await db.get('schools', 1);
    final k = await db.put('schools', 1, {
      ...?prev?.data,
      'workdays': list,
    }, prev: prev);
    return RecordWrite('روزهای فعال مدرسه ذخیره شد', id: 1, keys: [k]);
  }

  /// The draft the bells form opens with (web `schedBellModal`).
  Future<List<BellDraft>> bellDraft() async {
    final b = await bells();
    if (b.isNotEmpty) {
      return [
        for (final x in b)
          BellDraft(id: x.id, start: x.start, end: x.end, type: x.type),
      ];
    }
    return const [
      BellDraft(),
      BellDraft(type: 'break'),
      BellDraft(),
      BellDraft(type: 'break'),
      BellDraft(),
      BellDraft(type: 'break'),
      BellDraft(),
    ];
  }

  static String _ordinal(int n) {
    const o = [
      'اول',
      'دوم',
      'سوم',
      'چهارم',
      'پنجم',
      'ششم',
      'هفتم',
      'هشتم',
      'نهم',
      'دهم',
    ];
    return n >= 1 && n <= o.length ? o[n - 1] : _faDigits(n);
  }

  /// Form `bells` (bell-edit / bell-add / bell-del happen in the draft list).
  Future<RecordWrite> saveBells(List<BellDraft> rows) async {
    _requireManager();
    if (rows.isEmpty) {
      throw const RecordFailure('invalid', 'دست‌کم یک زنگ تعریف کنید');
    }
    int mins(String t) =>
        int.parse(t.substring(0, 2)) * 60 + int.parse(t.substring(3));
    var prevEnd = -1;
    for (var i = 0; i < rows.length; i++) {
      final s = schedTime(rows[i].start), e = schedTime(rows[i].end);
      if (s.isEmpty || e.isEmpty) {
        throw RecordFailure(
          'invalid',
          'زمان شروع و پایان ردیف ${_faDigits(i + 1)} را وارد کنید',
        );
      }
      if (mins(s) >= mins(e)) {
        throw const RecordFailure(
          'invalid',
          'پایان هر زنگ باید بعد از شروع آن باشد',
        );
      }
      if (mins(s) < prevEnd) {
        throw const RecordFailure(
          'invalid',
          'ساعت ردیف‌ها باید به‌ترتیب باشند و با هم هم‌پوشانی نداشته باشند',
        );
      }
      prevEnd = mins(e);
    }
    if (rows.every((r) => r.type == 'break')) {
      throw const RecordFailure('invalid', 'دست‌کم یک زنگ درسی لازم است');
    }
    final existing = await db.allOrEmpty('bell_schedules');
    final keep = {
      for (final r in rows)
        if (r.id != 0) r.id,
    };
    final drop = existing.where((b) => !keep.contains(b.id)).toList();
    db.requireRoom(rows.length + drop.length);
    var lesson = 0, brk = 0;
    final keys = <String>[];
    for (final r in rows) {
      final isBreak = r.type == 'break';
      if (isBreak) {
        brk++;
      } else {
        lesson++;
        brk = 0;
      }
      final prev = r.id == 0
          ? null
          : existing.where((b) => b.id == r.id).firstOrNull;
      final id = prev?.id ?? await db.newId('bell_schedules');
      keys.add(
        await db.put('bell_schedules', id, {
          ...?prev?.data,
          'order': isBreak ? lesson + brk / (brk + 1) : lesson,
          'start': schedTime(r.start),
          'end': schedTime(r.end),
          'type': isBreak ? 'break' : 'lesson',
          'label': isBreak
              ? 'تفریح ${_ordinal(brk)}'
              : 'زنگ ${_faDigits(lesson)} (درس)',
        }, prev: prev),
      );
    }
    for (final b in drop) {
      keys.add(await db.del('bell_schedules', b));
    }
    return RecordWrite('زنگ‌ها ذخیره شد', keys: keys);
  }

  /// Form `sched-teacher`: a teacher account by name only (completed later under users).
  Future<RecordWrite> addTeacher(String name) async {
    _requireManager();
    final n = name.trim();
    if (n.isEmpty) {
      throw const RecordFailure('invalid', 'نام دبیر را وارد کنید');
    }
    final id = await db.newId('users');
    final k = await db.put('users', id, {
      'name': n,
      'role': 'teacher',
      'active': true,
      'profile_incomplete': true,
    });
    return RecordWrite(
      'دبیر با نقش دبیر ساخته شد؛ اطلاعات تکمیلی را در بخش کاربران وارد کنید',
      id: id,
      keys: [k],
    );
  }

  // ─────────────────────────────── generator ───────────────────────────────

  /// `schedgen-open`: the web p2 generator over this school's data (preview only).
  Future<GenResult> generate() async {
    _requireManager();
    final classes = await db.allOrEmpty('classes');
    final cohorts = <String, (int, String, String)>{};
    for (final c in classes) {
      if (c.data['kind'] == 'room' || _s(c.data['grade']).isEmpty) continue;
      cohorts.putIfAbsent(
        '${_s(c.data['grade'])}|${_s(c.data['branch'])}',
        () => (c.id, _s(c.data['grade']), _s(c.data['branch'])),
      );
    }
    int cohortId(String g, String b, int? fallback) =>
        cohorts['${g.trim()}|${b.trim()}']?.$1 ?? fallback ?? 0;
    final subjects = await db.allOrEmpty('subjects');
    final teachers = [
      for (final u in await db.allOrEmpty('users'))
        if (u.data['role'] == 'teacher' && u.data['active'] != false)
          (
            u.id,
            subjects
                .where((s) => _s(s.data['name']) == _s(u.data['subject']))
                .firstOrNull
                ?.id,
          ),
    ];
    final existing = [
      for (final r in await db.allOrEmpty('schedule'))
        (
          cls: cohortId(
            _s(r.data['grade']),
            _s(r.data['branch']),
            _int(r.data['class_id']),
          ),
          teacher: _int(r.data['teacher_id']),
          subject: _int(r.data['subject_id']),
          day: _int(r.data['weekday']) ?? 0,
          period: _int(r.data['bell_order']) ?? 0,
        ),
    ];
    final wd = await workDays();
    final days = wd.isEmpty ? const [0, 1, 2, 3, 4, 5] : wd;
    final ppd = (await lessons()).length;

    bool subjMatch(EngineRow s, (int, String, String) c) {
      final sg = _s(s.data['grade']), sb = _s(s.data['branch']);
      if (sg.isNotEmpty && c.$2.isNotEmpty && sg != c.$2) return false;
      if (sb.isNotEmpty && c.$3.isNotEmpty && sb != c.$3) return false;
      return true;
    }

    int hoursOf(EngineRow s) =>
        (_int(s.data['weekly_hours']) ?? 0).clamp(0, 99);
    final specOf = <int, List<int>>{
      for (final s in subjects)
        s.id: [
          for (final t in teachers)
            if (t.$2 == s.id) t.$1,
        ]..sort(),
    };
    final load = <int, int>{for (final t in teachers) t.$1: 0};
    final classBusy = <String>{}, teacherBusy = <String>{};
    final covered = <String, int>{};
    final classSubjDays = <String, Set<int>>{};
    for (final r in existing) {
      if (r.teacher != null) load[r.teacher!] = (load[r.teacher!] ?? 0) + 1;
      classBusy.add('${r.cls}|${r.day}|${r.period}');
      if (r.teacher != null) {
        teacherBusy.add('${r.teacher}|${r.day}|${r.period}');
      }
      if (r.subject != null) {
        final k = '${r.cls}|${r.subject}';
        covered[k] = (covered[k] ?? 0) + 1;
        (classSubjDays[k] ??= {}).add(r.day);
      }
    }
    final hours = {for (final s in subjects) s.id: hoursOf(s)};
    final demands = <(int, int)>[];
    for (final c in cohorts.values) {
      for (final s in subjects) {
        if (!subjMatch(s, c)) continue;
        final h = (hoursOf(s) - (covered['${c.$1}|${s.id}'] ?? 0)).clamp(0, 99);
        for (var i = 0; i < h; i++) {
          demands.add((c.$1, s.id));
        }
      }
    }
    demands.sort((a, b) {
      final sa = (specOf[a.$2] ?? const []).isEmpty ? 1 : 0;
      final sb = (specOf[b.$2] ?? const []).isEmpty ? 1 : 0;
      if (sa != sb) return sa - sb;
      final ha = hours[a.$2] ?? 0, hb = hours[b.$2] ?? 0;
      if (ha != hb) return hb - ha;
      if (a.$1 != b.$1) return a.$1.compareTo(b.$1);
      return a.$2.compareTo(b.$2);
    });
    int? pickTeacher(int subId) {
      final c = [...?specOf[subId]]
        ..sort((a, b) {
          final d = (load[a] ?? 0) - (load[b] ?? 0);
          return d != 0 ? d : a.compareTo(b);
        });
      return c.isEmpty ? null : c.first;
    }

    bool free(int cls, int? t, int d, int p) =>
        !classBusy.contains('$cls|$d|$p') &&
        (t == null || !teacherBusy.contains('$t|$d|$p'));
    (int, int)? findSlot(int cls, int? t, int subId) {
      final used = classSubjDays['$cls|$subId'] ?? const <int>{};
      for (var pass = 0; pass < 2; pass++) {
        for (final d in days) {
          if (pass == 0 && used.contains(d)) continue;
          for (var p = 1; p <= ppd; p++) {
            if (free(cls, t, d, p)) return (d, p);
          }
        }
      }
      return null;
    }

    final placements = <GenPlacement>[];
    final unplaced = <GenUnplaced>[];
    var noSpecialist = 0;
    void commit(GenPlacement pl) {
      placements.add(pl);
      classBusy.add('${pl.classId}|${pl.day}|${pl.period}');
      if (pl.teacherId != null) {
        teacherBusy.add('${pl.teacherId}|${pl.day}|${pl.period}');
        load[pl.teacherId!] = (load[pl.teacherId!] ?? 0) + 1;
      }
      (classSubjDays['${pl.classId}|${pl.subjectId}'] ??= {}).add(pl.day);
    }

    void uncommit(GenPlacement pl) {
      placements.remove(pl);
      classBusy.remove('${pl.classId}|${pl.day}|${pl.period}');
      if (pl.teacherId != null) {
        teacherBusy.remove('${pl.teacherId}|${pl.day}|${pl.period}');
        load[pl.teacherId!] = ((load[pl.teacherId!] ?? 1) - 1).clamp(
          0,
          1 << 30,
        );
      }
    }

    (int, int)? displace(int cls, int? t, int subId) {
      for (final v in [...placements]) {
        if (v.classId != cls) continue;
        uncommit(v);
        final alt = findSlot(v.classId, v.teacherId, v.subjectId);
        if (alt != null && (alt.$1 != v.day || alt.$2 != v.period)) {
          final mine = findSlot(cls, t, subId);
          if (mine != null) {
            v.day = alt.$1;
            v.period = alt.$2;
            commit(v);
            return mine;
          }
        }
        commit(v);
      }
      return null;
    }

    for (final (cls, subId) in demands) {
      final t = pickTeacher(subId);
      if (t == null) noSpecialist++;
      final slot = findSlot(cls, t, subId) ?? displace(cls, t, subId);
      if (slot != null) {
        commit(GenPlacement(cls, subId, t, slot.$1, slot.$2));
      } else {
        unplaced.add(
          GenUnplaced(
            cls,
            subId,
            t,
            t == null
                ? 'جایِ خالی برای کلاس نیست'
                : 'جایِ خالیِ مشترک برای کلاس و دبیر نیست',
          ),
        );
      }
    }
    return GenResult(placements, unplaced, demands.length, noSpecialist);
  }

  /// `schedgen-apply`: only empty cells are filled; the current plan is untouched.
  Future<RecordWrite> applyGenerated(GenResult g) async {
    _requireManager();
    final rows = await db.allOrEmpty('schedule');
    final add = <GenPlacement>[];
    var skip = 0;
    final taken = <String>{
      for (final r in rows)
        '${_int(r.data['class_id'])}|${_int(r.data['weekday'])}|${_int(r.data['bell_order'])}',
    };
    final tTaken = <String>{
      for (final r in rows)
        if (_int(r.data['teacher_id']) != null)
          '${_int(r.data['teacher_id'])}|${_int(r.data['weekday'])}|${_int(r.data['bell_order'])}',
    };
    for (final p in g.placements) {
      if (taken.contains('${p.classId}|${p.day}|${p.period}') ||
          (p.teacherId != null &&
              tTaken.contains('${p.teacherId}|${p.day}|${p.period}'))) {
        skip++;
        continue;
      }
      taken.add('${p.classId}|${p.day}|${p.period}');
      if (p.teacherId != null) {
        tTaken.add('${p.teacherId}|${p.day}|${p.period}');
      }
      add.add(p);
    }
    db.requireRoom(add.length);
    final keys = <String>[];
    for (final p in add) {
      final c = await db.get('classes', p.classId);
      keys.add(
        await db.put('schedule', await db.newId('schedule'), {
          'class_id': p.classId,
          'grade': _s(c?.data['grade']),
          'branch': _s(c?.data['branch']),
          'subject_id': p.subjectId,
          'teacher_id': p.teacherId,
          'room_id': null,
          'room': '',
          'weekday': p.day,
          'bell_order': p.period,
        }),
      );
    }
    return RecordWrite(
      '${_faDigits(add.length)} زنگ ثبت شد'
      '${skip > 0 ? ' (${_faDigits(skip)} خانه پرشده بود و رد شد)' : ''}'
      '${g.unplaced.isNotEmpty ? '؛ ${_faDigits(g.unplaced.length)} زنگ تعیین‌نشده ماند' : ''}',
      keys: keys,
    );
  }
}
