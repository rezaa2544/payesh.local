// Row 128, wave W11 — the read-only views the web built from its full copy of the school data,
// computed on the device from the local copy instead: `PAGES.reports` (weekly attendance per
// class + the class report card + `print`), `PAGES['attendance-report']` (one day, every class),
// `PAGES.home` for the manager / teacher / student (`managerHome`, `teacherHome`,
// `studentHomeCard`) and the manager's leave decisions (`leave-set`, `leave-delete`).
// Nothing here talks to a server: reads come from the synced copy, the two leave writes go
// through the durable outbox first (local-first, like every other row-128 write).
import 'package:payesh_data/payesh_data.dart';

import 'records.dart';
import 'timetable.dart';

/// Web `ATT_LABEL`.
const Map<String, String> attLabelFa = {
  'present': 'حاضر',
  'absent': 'غایب',
  'late': 'تأخیر',
  'early_exit': 'خروج',
  'excused': 'موجه',
};

/// Web leave badge labels.
const Map<String, String> leaveStatusFa = {
  'approved': 'تأییدشده',
  'rejected': 'رد شده',
  'pending': 'در انتظار',
};

String _fa(Object n) => '$n'.replaceAllMapped(
  RegExp('[0-9]'),
  (m) => '۰۱۲۳۴۵۶۷۸۹'[int.parse(m[0]!)],
);

int _pct(int part, int all) => all == 0 ? 0 : (part * 100 / all).round();

/// One class row of «حضور هفتگی به تفکیک کلاس».
final class ClassWeek {
  const ClassWeek({
    required this.classId,
    required this.name,
    required this.records,
    required this.present,
    required this.absent,
    required this.late,
  });
  final int classId;
  final String name;
  final int records;
  final int present;
  final int absent;
  final int late;
  int get pct => _pct(present, records);
}

/// One student row of the class report card.
final class ReportRow {
  const ReportRow({
    required this.studentId,
    required this.name,
    required this.scores,
    required this.average,
    required this.attendancePct,
  });
  final int studentId;
  final String name;
  final Map<int, num> scores;
  final double average;
  final int attendancePct;
}

/// «کارنامهٔ کلاسی» (web `classReportTable`).
final class ReportCard {
  const ReportCard({
    required this.classId,
    required this.className,
    required this.subjects,
    required this.rows,
  });
  final int classId;
  final String className;
  final List<(int, String)> subjects;
  final List<ReportRow> rows;
}

/// One class of the day attendance view.
final class DayClass {
  const DayClass({
    required this.classId,
    required this.name,
    required this.records,
    required this.present,
    required this.notPresent,
  });
  final int classId;
  final String name;
  final int records;
  final int present;

  /// (student name, status label) of everyone not present.
  final List<(String, String)> notPresent;
}

/// A cohort (grade + branch) of «پوشش حضور امروز».
final class Coverage {
  const Coverage({
    required this.grade,
    required this.branch,
    required this.name,
    required this.roster,
    required this.checked,
    required this.present,
    required this.absent,
    required this.late,
  });
  final String grade;
  final String branch;
  final String name;
  final int roster;
  final int checked;
  final int present;
  final int absent;
  final int late;
  int get ratio => roster == 0 ? 0 : _pct(checked, roster).clamp(0, 100);
}

/// A room of «پوشش کلاس‌ها» in the current bell.
final class RoomNow {
  const RoomNow({
    required this.id,
    required this.name,
    this.cohort = '',
    this.subject = '',
    this.teacher = '',
  });
  final int id;
  final String name;
  final String cohort;
  final String subject;
  final String teacher;
  bool get busy => subject.isNotEmpty;
}

/// The manager's home (web `managerHome`).
final class Dashboard {
  const Dashboard({
    required this.today,
    required this.weekday,
    required this.students,
    required this.teachers,
    required this.classes,
    required this.recordsToday,
    required this.presentToday,
    required this.absentToday,
    required this.lateToday,
    required this.pendingGrades,
    required this.coverage,
    required this.rooms,
    required this.bell,
    required this.recent,
  });
  final String today;
  final int weekday;
  final int students;
  final int teachers;
  final int classes;
  final int recordsToday;
  final int presentToday;
  final int absentToday;
  final int lateToday;
  final int pendingGrades;
  final List<Coverage> coverage;
  final List<RoomNow> rooms;
  final Bell? bell;

  /// The three latest notices: (title, iso date).
  final List<(String, String)> recent;
  int get covered => coverage.where((c) => c.checked > 0).length;
}

/// One lesson of «برنامهٔ امروز».
final class TodaySlot {
  const TodaySlot({
    required this.period,
    required this.start,
    required this.end,
    required this.classId,
    required this.className,
    required this.subject,
    required this.teacher,
    required this.done,
    required this.current,
  });
  final int period;
  final String start;
  final String end;
  final int? classId;
  final String className;
  final String subject;
  final String teacher;

  /// Attendance of the class is recorded for today.
  final bool done;
  final bool current;
}

/// The teacher's or student's home (web `teacherHome` / `studentHomeCard`).
final class TodayView {
  const TodayView({
    required this.today,
    required this.weekday,
    required this.bell,
    required this.next,
    required this.slots,
  });
  final String today;
  final int weekday;
  final Bell? bell;
  final Bell? next;
  final List<TodaySlot> slots;
}

/// One leave request in the manager's list.
final class LeaveRow {
  const LeaveRow({
    required this.id,
    required this.studentId,
    required this.student,
    required this.date,
    required this.reason,
    required this.status,
    required this.queued,
  });
  final int id;
  final int? studentId;
  final String student;
  final String date;
  final String reason;
  final String status;
  final bool queued;
  String get statusFa => leaveStatusFa[status] ?? leaveStatusFa['pending']!;
}

final class SchoolReports {
  SchoolReports(this.db);
  final SchoolRecords db;

  static int? _int(Object? v) => SchoolRecords.asInt(v);
  static String _s(Object? v) => SchoolRecords.str(v);

  bool get isManager => db.role == 'manager';

  void _requireManager() {
    if (!isManager) {
      throw const RecordFailure('not_allowed', 'دسترسی ندارید.');
    }
  }

  Future<List<EngineRow>> _classes() async =>
      (await db.allOrEmpty('classes'))
        ..sort((a, b) => _s(a.data['name']).compareTo(_s(b.data['name'])));

  /// Web `dashboardIsRoom`.
  static bool isRoom(Map<String, Object?> c) =>
      _s(c['kind']) == 'room' ||
      (_s(c['kind']).isEmpty &&
          _s(c['grade']).isEmpty &&
          _s(c['branch']).isEmpty);

  /// The seven days ending today (web `reports` `week`).
  List<String> week() {
    final t = db.now();
    return [
      for (var i = 0; i < 7; i++)
        t
            .subtract(Duration(days: i))
            .toUtc()
            .toIso8601String()
            .substring(0, 10),
    ];
  }

  /// «حضور هفتگی به تفکیک کلاس».
  Future<List<ClassWeek>> weekly() async {
    _requireManager();
    final days = week().toSet();
    final att = await db.allOrEmpty('attendance');
    return [
      for (final c in await _classes())
        () {
          final rows = [
            for (final a in att)
              if (_int(a.data['class_id']) == c.id &&
                  days.contains(
                    _s(a.data['date']).padRight(10).substring(0, 10),
                  ))
                a,
          ];
          int count(String st) =>
              rows.where((a) => a.data['status'] == st).length;
          return ClassWeek(
            classId: c.id,
            name: _s(c.data['name']),
            records: rows.length,
            present: count('present'),
            absent: count('absent'),
            late: count('late'),
          );
        }(),
    ];
  }

  /// «کارنامهٔ کلاسی» of [classId] (web `classReportTable`): every subject that has a mark in
  /// the class, each student's mark per subject, the average of all of the student's marks and
  /// the share of present records.
  Future<ReportCard> card(int classId) async {
    _requireManager();
    final cls = await db.get('classes', classId);
    final users = await db.allOrEmpty('users');
    final roster = [
      for (final u in users)
        if (u.data['role'] == 'student' && _int(u.data['class_id']) == classId)
          u,
    ]..sort((a, b) => _s(a.data['name']).compareTo(_s(b.data['name'])));
    final grades = await db.allOrEmpty('grades');
    final subjectNames = {
      for (final s in await db.allOrEmpty('subjects')) s.id: _s(s.data['name']),
    };
    final subjectIds =
        {
          for (final g in grades)
            if (_int(g.data['class_id']) == classId &&
                _int(g.data['subject_id']) != null)
              _int(g.data['subject_id'])!,
        }.toList()..sort(
          (a, b) => (subjectNames[a] ?? '').compareTo(subjectNames[b] ?? ''),
        );
    final att = [
      for (final a in await db.allOrEmpty('attendance'))
        if (_int(a.data['class_id']) == classId) a,
    ];
    final rows = <ReportRow>[];
    for (final s in roster) {
      final mine = [
        for (final g in grades)
          if (_int(g.data['student_id']) == s.id) g,
      ];
      final scores = <int, num>{};
      for (final id in subjectIds) {
        for (final g in mine) {
          if (_int(g.data['subject_id']) == id && g.data['score'] is num) {
            scores[id] = g.data['score']! as num;
            break;
          }
        }
      }
      final sum = mine.fold<num>(
        0,
        (a, g) => a + (num.tryParse('${g.data['score'] ?? 0}') ?? 0),
      );
      final a = [
        for (final x in att)
          if (_int(x.data['student_id']) == s.id) x,
      ];
      rows.add(
        ReportRow(
          studentId: s.id,
          name: _s(s.data['name']),
          scores: scores,
          average: mine.isEmpty ? 0 : sum / mine.length,
          attendancePct: _pct(
            a.where((x) => x.data['status'] == 'present').length,
            a.length,
          ),
        ),
      );
    }
    return ReportCard(
      classId: classId,
      className: _s(cls?.data['name']),
      subjects: [for (final id in subjectIds) (id, subjectNames[id] ?? '')],
      rows: rows,
    );
  }

  /// `PAGES['attendance-report']`: one day ([iso] `yyyy-mm-dd`), every class.
  Future<List<DayClass>> day(String iso) async {
    _requireManager();
    final names = {
      for (final u in await db.allOrEmpty('users')) u.id: _s(u.data['name']),
    };
    final att = [
      for (final a in await db.allOrEmpty('attendance'))
        if (_s(a.data['date']).startsWith(iso)) a,
    ];
    return [
      for (final c in await _classes())
        () {
          final rows = [
            for (final a in att)
              if (_int(a.data['class_id']) == c.id) a,
          ];
          return DayClass(
            classId: c.id,
            name: _s(c.data['name']),
            records: rows.length,
            present: rows.where((a) => a.data['status'] == 'present').length,
            notPresent: [
              for (final a in rows)
                if (a.data['status'] != 'present')
                  (
                    names[_int(a.data['student_id'])] ?? '',
                    attLabelFa[_s(a.data['status'])] ?? _s(a.data['status']),
                  ),
            ],
          );
        }(),
    ];
  }

  static int _min(String hhmm) {
    final t = schedTime(hhmm);
    if (t.isEmpty) return -1;
    return int.parse(t.substring(0, 2)) * 60 + int.parse(t.substring(3));
  }

  int get _nowMin {
    final n = db.now();
    return n.hour * 60 + n.minute;
  }

  /// Web `currentBell` / `nextBell` (lesson bells only).
  Future<(Bell?, Bell?)> bells() async {
    final lessons = [
      for (final b in await Timetable(db).bells())
        if (!b.isBreak) b,
    ];
    final m = _nowMin;
    Bell? cur, next;
    for (final b in lessons) {
      final s = _min(b.start), e = _min(b.end);
      if (s < 0 || e < 0) continue;
      if (cur == null && m >= s && m <= e) cur = b;
      if (next == null && s > m) next = b;
    }
    return (cur, next);
  }

  /// The manager's home (web `managerHome`).
  Future<Dashboard> dashboard() async {
    _requireManager();
    final today = db.today();
    final weekday = schoolWeekday(today);
    final users = await db.allOrEmpty('users');
    final students = [
      for (final u in users)
        if (u.data['role'] == 'student' && u.data['active'] != false) u,
    ];
    final classes = await _classes();
    final byId = {for (final c in classes) c.id: c};
    final att = [
      for (final a in await db.allOrEmpty('attendance'))
        if (_s(a.data['date']).startsWith(today)) a,
    ];
    int count(Iterable<EngineRow> rows, String st) =>
        rows.where((a) => a.data['status'] == st).length;

    // coverage by cohort (grade + branch), not by the room the lesson is held in
    final groups = <String, _Group>{};
    _Group group(String g, String b, int? classId, String name) {
      final key = g.isNotEmpty || b.isNotEmpty
          ? 'cohort|$g\u001f$b'
          : 'class|${classId ?? 'unknown'}';
      final x = groups.putIfAbsent(key, () => _Group(g, b, name));
      if (classId != null) x.classIds.add(classId);
      return x;
    }

    for (final c in classes) {
      if (isRoom(c.data)) continue;
      final g = _s(c.data['grade']), b = _s(c.data['branch']);
      if (g.isNotEmpty || b.isNotEmpty) group(g, b, c.id, _s(c.data['name']));
    }
    for (final s in students) {
      final cid = _int(s.data['class_id']);
      final cls = byId[cid]?.data ?? const {};
      final g = _s(s.data['grade']).isNotEmpty
          ? _s(s.data['grade'])
          : _s(cls['grade']);
      final b = _s(s.data['branch']).isNotEmpty
          ? _s(s.data['branch'])
          : _s(cls['branch']);
      group(
        g,
        b,
        cid,
        _s(cls['name']).isNotEmpty ? _s(cls['name']) : _s(s.data['name']),
      ).students.add(s.id);
    }
    final coverage =
        [
          for (final x in groups.values)
            () {
              final rows = [
                for (final a in att)
                  if (x.classIds.contains(_int(a.data['class_id'])) ||
                      x.students.contains(_int(a.data['student_id'])))
                    a,
              ];
              final ids = {
                for (final a in rows)
                  if (_int(a.data['student_id']) case final int id) id,
              };
              return Coverage(
                grade: x.grade,
                branch: x.branch,
                name: x.name,
                roster: x.students.length,
                checked: ids.isNotEmpty ? ids.length : rows.length,
                present: count(rows, 'present'),
                absent: count(rows, 'absent'),
                late: count(rows, 'late'),
              );
            }(),
        ]..sort((a, b) {
          final g = a.grade.compareTo(b.grade);
          if (g != 0) return g;
          final br = a.branch.compareTo(b.branch);
          return br != 0 ? br : a.name.compareTo(b.name);
        });

    // rooms in use in the current bell
    final (bell, _) = await bells();
    final names = {for (final u in users) u.id: _s(u.data['name'])};
    final subjects = {
      for (final s in await db.allOrEmpty('subjects')) s.id: _s(s.data['name']),
    };
    final slots = bell == null
        ? const <EngineRow>[]
        : [
            for (final s in await db.allOrEmpty('schedule'))
              if (_int(s.data['weekday']) == weekday &&
                  _int(s.data['bell_order']) == bell.order.toInt())
                s,
          ];
    final rooms = <RoomNow>[];
    for (final r in classes) {
      if (!isRoom(r.data)) continue;
      EngineRow? slot;
      for (final s in slots) {
        final sc = byId[_int(s.data['class_id'])]?.data;
        final rid =
            _int(s.data['room_id']) ??
            (sc != null && _s(sc['kind']) == 'room'
                ? _int(s.data['class_id'])
                : null);
        if (rid == r.id) {
          slot = s;
          break;
        }
      }
      if (slot == null) {
        rooms.add(RoomNow(id: r.id, name: _s(r.data['name'])));
        continue;
      }
      final cohort = byId[_int(slot.data['class_id'])]?.data ?? const {};
      final g = _s(slot.data['grade']).isNotEmpty
          ? _s(slot.data['grade'])
          : _s(cohort['grade']);
      final b = _s(slot.data['branch']).isNotEmpty
          ? _s(slot.data['branch'])
          : _s(cohort['branch']);
      rooms.add(
        RoomNow(
          id: r.id,
          name: _s(r.data['name']),
          cohort: g.isEmpty ? '—' : (b.isEmpty ? g : '$g · $b'),
          subject: subjects[_int(slot.data['subject_id'])] ?? '—',
          teacher: names[_int(slot.data['teacher_id'])] ?? '—',
        ),
      );
    }
    final notices = (await db.allOrEmpty('announcements'))
      ..sort((a, b) => _s(b.data['date']).compareTo(_s(a.data['date'])));
    return Dashboard(
      today: today,
      weekday: weekday,
      students: students.length,
      teachers: users.where((u) => u.data['role'] == 'teacher').length,
      classes: classes.length,
      recordsToday: att.length,
      presentToday: count(att, 'present'),
      absentToday: count(att, 'absent'),
      lateToday: count(att, 'late'),
      pendingGrades: (await db.allOrEmpty('grades'))
          .where((g) => g.data['status'] == 'pending')
          .length,
      coverage: coverage,
      rooms: rooms,
      bell: bell,
      recent: [
        for (final n in notices.take(3))
          (_s(n.data['title']), _s(n.data['date'])),
      ],
    );
  }

  /// «امروز من» (teacher: own lessons) / «امروز» (student: own class or cohort).
  Future<TodayView> today() async {
    final today = db.today();
    final weekday = schoolWeekday(today);
    final tt = Timetable(db);
    final work = (await tt.workDays()).contains(weekday);
    final me = await db.get('users', db.uid);
    final classes = {
      for (final c in await db.allOrEmpty('classes')) c.id: c.data,
    };
    final myClass = _int(me?.data['class_id']);
    final g = _s(me?.data['grade']).isNotEmpty
        ? _s(me?.data['grade'])
        : _s(classes[myClass]?['grade']);
    final b = _s(me?.data['branch']).isNotEmpty
        ? _s(me?.data['branch'])
        : _s(classes[myClass]?['branch']);
    bool mine(EngineRow s) => switch (db.role) {
      'teacher' => _int(s.data['teacher_id']) == db.uid,
      'student' =>
        (myClass != null && _int(s.data['class_id']) == myClass) ||
            (g.isNotEmpty &&
                _s(s.data['grade']) == g &&
                _s(s.data['branch']) == b),
      _ => false,
    };
    final (cur, next) = await bells();
    final bellOf = {
      for (final x in await tt.bells())
        if (!x.isBreak) x.order.toInt(): x,
    };
    final names = {
      for (final u in await db.allOrEmpty('users')) u.id: _s(u.data['name']),
    };
    final subjects = {
      for (final s in await db.allOrEmpty('subjects')) s.id: _s(s.data['name']),
    };
    final doneClasses = {
      for (final a in await db.allOrEmpty('attendance'))
        if (_s(a.data['date']).startsWith(today)) _int(a.data['class_id']),
    };
    final slots = [
      if (work)
        for (final s in await db.allOrEmpty('schedule'))
          if (_int(s.data['weekday']) == weekday && mine(s))
            () {
              final p = _int(s.data['bell_order']) ?? 0;
              final cid = _int(s.data['class_id']);
              return TodaySlot(
                period: p,
                start: schedTime(bellOf[p]?.start),
                end: schedTime(bellOf[p]?.end),
                classId: cid,
                className: _s(classes[cid]?['name']).isNotEmpty
                    ? _s(classes[cid]?['name'])
                    : [
                        _s(s.data['grade']),
                        _s(s.data['branch']),
                      ].where((x) => x.isNotEmpty).join(' '),
                subject: subjects[_int(s.data['subject_id'])] ?? '—',
                teacher: names[_int(s.data['teacher_id'])] ?? '',
                done: doneClasses.contains(cid),
                current: cur != null && cur.order.toInt() == p,
              );
            }(),
    ]..sort((a, b) => a.period.compareTo(b.period));
    return TodayView(
      today: today,
      weekday: weekday,
      bell: cur,
      next: next,
      slots: slots,
    );
  }

  // ─────────────────────────────── leaves (manager) ───────────────────────────────

  /// Web `PAGES.leaves` for the manager: every request, newest first.
  Future<List<LeaveRow>> leaves() async {
    _requireManager();
    final names = {
      for (final u in await db.allOrEmpty('users')) u.id: _s(u.data['name']),
    };
    final q = db.queuedIds('leaves');
    final rows = (await db.allOrEmpty('leaves'))
      ..sort(
        (a, b) => _s(b.data['created_at']).compareTo(_s(a.data['created_at'])),
      );
    return [
      for (final l in rows)
        LeaveRow(
          id: l.id,
          studentId: _int(l.data['student_id']),
          student: names[_int(l.data['student_id'])] ?? '',
          date: _s(l.data['date']),
          reason: _s(l.data['reason']),
          status: _s(l.data['status']).isEmpty
              ? 'pending'
              : _s(l.data['status']),
          queued: q.contains(l.id),
        ),
    ];
  }

  /// `leave-set` (approved / rejected), with who decided and when.
  Future<RecordWrite> decide(int id, String status) async {
    _requireManager();
    final st = status == 'rejected' ? 'rejected' : 'approved';
    final l = await db.existing('leaves', id, 'این درخواست');
    final k = await db.put('leaves', id, {
      ...l.data,
      'status': st,
      'decided_by': db.uid,
      'decided_at': db.now().toUtc().toIso8601String(),
    }, prev: l);
    return RecordWrite(
      st == 'approved' ? 'درخواست تأیید شد' : 'درخواست رد شد',
      id: id,
      keys: [k],
    );
  }

  /// `leave-delete`.
  Future<RecordWrite> deleteLeave(int id) async {
    _requireManager();
    final l = await db.existing('leaves', id, 'این درخواست');
    final k = await db.del('leaves', l);
    return RecordWrite('درخواست حذف شد', id: id, keys: [k]);
  }

  // ─────────────────────────────── print ───────────────────────────────

  static String _esc(String s) => s
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');

  /// `print`: the report page as one self-contained, right-to-left HTML document (no external
  /// file, script or font) that any browser or word processor on the device prints.
  static String printable({
    required String school,
    required String dateFa,
    required List<ClassWeek> week,
    ReportCard? card,
  }) {
    final b = StringBuffer()
      ..write(
        '<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">',
      )
      ..write('<title>گزارش‌ها — ${_esc(school)}</title><style>')
      ..write(
        'body{font-family:Tahoma,sans-serif;margin:24px}table{border-collapse:collapse;',
      )
      ..write(
        'width:100%;margin:8px 0 20px}th,td{border:1px solid #999;padding:4px 8px;',
      )
      ..write('text-align:center}h1{font-size:18px}h2{font-size:15px}')
      ..write('</style></head><body>')
      ..write(
        '<h1>${_esc(school)} — گزارش‌ها</h1><p>هفتهٔ منتهی به ${_esc(dateFa)}</p>',
      )
      ..write(
        '<h2>حضور هفتگی به تفکیک کلاس</h2><table><thead><tr><th>کلاس</th><th>ثبت</th>',
      )
      ..write(
        '<th>حاضر</th><th>غایب</th><th>تأخیر</th><th>درصد</th></tr></thead><tbody>',
      );
    for (final r in week) {
      b.write(
        '<tr><td>${_esc(r.name)}</td><td>${_fa(r.records)}</td><td>${_fa(r.present)}</td>'
        '<td>${_fa(r.absent)}</td><td>${_fa(r.late)}</td><td>${_fa(r.pct)}٪</td></tr>',
      );
    }
    b.write('</tbody></table>');
    if (card != null) {
      b.write(
        '<h2>کارنامهٔ کلاسی — ${_esc(card.className)}</h2><table><thead><tr><th>دانش‌آموز</th>',
      );
      for (final (_, n) in card.subjects) {
        b.write('<th>${_esc(n)}</th>');
      }
      b.write('<th>معدل</th><th>حضور</th></tr></thead><tbody>');
      for (final r in card.rows) {
        b.write('<tr><td>${_esc(r.name)}</td>');
        for (final (id, _) in card.subjects) {
          b.write(
            '<td>${r.scores[id] == null ? '—' : _fa(r.scores[id]!)}</td>',
          );
        }
        b.write(
          '<td><b>${_fa(r.average.toStringAsFixed(2))}</b></td><td>${_fa(r.attendancePct)}٪</td></tr>',
        );
      }
      b.write('</tbody></table>');
    }
    b.write('</body></html>');
    return b.toString();
  }
}

final class _Group {
  _Group(this.grade, this.branch, this.name);
  final String grade;
  final String branch;
  final String name;
  final Set<int> classIds = {};
  final Set<int> students = {};
}
