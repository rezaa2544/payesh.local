// Row 128, wave W11 — reports, the day attendance view, home dashboards and the manager's leave
// decisions, unit level (local SQLite + durable outbox, no network). Parity target:
// client/pages.js PAGES.reports / classReportTable / PAGES['attendance-report'] / managerHome /
// teacherHome / studentHomeCard / PAGES.leaves and the leave-set / leave-delete / print actions
// of client/app.js.
import 'dart:math';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

/// Thursday 2026-11-12, 09:10 — inside the second lesson bell.
final now = DateTime.utc(2026, 11, 12, 9, 10);

Future<(SqliteEngine, SqliteOutbox)> seeded({
  List<int> workdays = const [0, 1, 2, 3, 4, 5],
}) async {
  final e = SqliteEngine.inMemory();
  final ob = SqliteOutbox(e.database);
  Future<void> put(String c, int id, Map<String, Object?> d) =>
      e.put(c, id, {...d, 'id': id}, version: 1);
  await put('schools', 1, {'name': 'هنرستان', 'workdays': workdays});
  await put('classes', 5, {
    'name': 'دهم الکترونیک',
    'grade': 'دهم',
    'branch': 'الکترونیک',
    'kind': 'class',
  });
  await put('classes', 6, {'name': 'کارگاه ۱', 'kind': 'room'});
  await put('classes', 7, {'name': 'هفتم', 'grade': 'هفتم', 'kind': 'class'});
  await put('users', 10, {'name': 'دبیر ریاضی', 'role': 'teacher'});
  await put('users', 21, {'name': 'بهار', 'role': 'student', 'class_id': 5});
  await put('users', 22, {'name': 'آرش', 'role': 'student', 'class_id': 5});
  await put('users', 23, {'name': 'سارا', 'role': 'student', 'class_id': 7});
  await put('users', 24, {
    'name': 'غیرفعال',
    'role': 'student',
    'class_id': 7,
    'active': false,
  });
  await put('subjects', 41, {'name': 'ریاضی'});
  await put('subjects', 42, {'name': 'فیزیک'});
  await put('bell_schedules', 1, {
    'order': 1,
    'start': '08:00',
    'end': '08:45',
    'type': 'lesson',
  });
  await put('bell_schedules', 2, {
    'order': 1.5,
    'start': '08:45',
    'end': '09:00',
    'type': 'break',
  });
  await put('bell_schedules', 3, {
    'order': 2,
    'start': '09:00',
    'end': '09:45',
    'type': 'lesson',
  });
  await put('schedule', 900, {
    'class_id': 5,
    'subject_id': 41,
    'teacher_id': 10,
    'weekday': 5,
    'bell_order': 2,
    'room_id': 6,
  });
  await put('schedule', 901, {
    'class_id': 7,
    'subject_id': 42,
    'teacher_id': 10,
    'weekday': 5,
    'bell_order': 1,
  });
  var a = 0;
  Future<void> att(int cls, int st, String date, String status) => put(
    'attendance',
    ++a,
    {'class_id': cls, 'student_id': st, 'date': date, 'status': status},
  );
  await att(5, 21, '2026-11-12', 'present');
  await att(5, 22, '2026-11-12', 'absent');
  await att(5, 21, '2026-11-09', 'late');
  await att(5, 21, '2026-11-01', 'present');
  var g = 0;
  Future<void> grade(int st, int sub, num score, String status) =>
      put('grades', ++g, {
        'class_id': 5,
        'student_id': st,
        'subject_id': sub,
        'score': score,
        'status': status,
      });
  await grade(21, 41, 18, 'approved');
  await grade(21, 42, 16, 'pending');
  await grade(22, 41, 12, 'approved');
  for (final (i, d) in [
    '2026-11-01',
    '2026-11-10',
    '2026-11-05',
    '2026-11-11',
  ].indexed) {
    await put('announcements', 80 + i, {'title': 'خبر $d', 'date': d});
  }
  await put('leaves', 60, {
    'student_id': 21,
    'date': '2026-11-15',
    'reason': 'پزشکی',
    'status': 'pending',
    'created_at': '2026-11-10T08:00:00Z',
  });
  await put('leaves', 61, {
    'student_id': 22,
    'date': '2026-11-16',
    'reason': 'سفر',
    'status': 'approved',
    'created_at': '2026-11-11T08:00:00Z',
  });
  return (e, ob);
}

SchoolRecords db(
  SqliteEngine e,
  SqliteOutbox ob, {
  String role = 'manager',
  int uid = 1,
  DateTime? at,
}) => SchoolRecords(
  engine: e,
  outbox: ob,
  role: role,
  uid: uid,
  now: () => at ?? now,
  random: Random(3),
);

Matcher notAllowed() =>
    throwsA(isA<RecordFailure>().having((f) => f.code, 'code', 'not_allowed'));

void main() {
  test('W11-U01 weekly attendance per class: only the last seven days; NEG a teacher is refused', () async {
    final (e, ob) = await seeded();
    final w = await SchoolReports(db(e, ob)).weekly();
    expect(w.map((x) => x.name), ['دهم الکترونیک', 'هفتم', 'کارگاه ۱']);
    final c = w.first;
    expect((c.records, c.present, c.absent, c.late, c.pct), (3, 1, 1, 1, 33));
    expect(w.last.records, 0);
    expect(w.last.pct, 0);
    await expectLater(
      SchoolReports(db(e, ob, role: 'teacher', uid: 10)).weekly(),
      notAllowed(),
    );
  });

  test('W11-U02 class report card: subjects with a mark, marks, average of all marks, attendance share', () async {
    final (e, ob) = await seeded();
    final r = await SchoolReports(db(e, ob)).card(5);
    expect(r.className, 'دهم الکترونیک');
    expect(r.subjects, [(41, 'ریاضی'), (42, 'فیزیک')]);
    expect(r.rows.map((x) => x.name), ['آرش', 'بهار']);
    final [arash, bahar] = r.rows;
    expect(bahar.scores, {41: 18, 42: 16});
    expect(bahar.average, 17);
    expect(bahar.attendancePct, 67);
    expect(arash.scores, {41: 12});
    expect(arash.attendancePct, 0);
    final empty = await SchoolReports(db(e, ob)).card(6);
    expect(empty.rows, isEmpty);
  });

  test('W11-U03 one day, every class: present count and everyone not present with the label', () async {
    final (e, ob) = await seeded();
    final d = await SchoolReports(db(e, ob)).day('2026-11-12');
    final c5 = d.firstWhere((x) => x.classId == 5);
    expect((c5.records, c5.present), (2, 1));
    expect(c5.notPresent, [('آرش', 'غایب')]);
    expect(d.firstWhere((x) => x.classId == 7).records, 0);
    final other = await SchoolReports(db(e, ob)).day('2026-11-09');
    expect(other.first.notPresent, [('بهار', 'تأخیر')]);
    await expectLater(
      SchoolReports(db(e, ob, role: 'parent', uid: 30)).day('2026-11-12'),
      notAllowed(),
    );
  });

  test('W11-U04 manager dashboard: counts, cohort coverage, rooms in the current bell, latest notices', () async {
    final (e, ob) = await seeded();
    final d = await SchoolReports(db(e, ob)).dashboard();
    expect(d.weekday, 5, reason: 'Thursday');
    expect((d.students, d.teachers, d.classes), (3, 1, 3));
    expect(
      (d.recordsToday, d.presentToday, d.absentToday, d.lateToday),
      (2, 1, 1, 0),
    );
    expect(d.pendingGrades, 1);
    expect(d.bell!.order, 2);
    expect(d.coverage.map((c) => (c.grade, c.roster, c.checked, c.ratio)), [
      ('دهم', 2, 2, 100),
      ('هفتم', 1, 0, 0),
    ]);
    expect(d.covered, 1);
    final room = d.rooms.single;
    expect(
      (room.name, room.busy, room.subject, room.teacher, room.cohort),
      ('کارگاه ۱', true, 'ریاضی', 'دبیر ریاضی', 'دهم · الکترونیک'),
    );
    expect(d.recent.map((n) => n.$2), [
      '2026-11-11',
      '2026-11-10',
      '2026-11-05',
    ]);
    // between bells: no room is busy
    final later = await SchoolReports(
      db(e, ob, at: DateTime.utc(2026, 11, 12, 12)),
    ).dashboard();
    expect(later.bell, isNull);
    expect(later.rooms.single.busy, isFalse);
  });

  test('W11-U05 today: the teacher\'s own lessons (current bell, attendance done), the student\'s '
      'class; NEG a day off has no lessons', () async {
    final (e, ob) = await seeded();
    final t = await SchoolReports(db(e, ob, role: 'teacher', uid: 10)).today();
    expect(t.bell!.order, 2);
    expect(t.next, isNull);
    expect(t.slots.map((s) => (s.period, s.className, s.done, s.current)), [
      (1, 'هفتم', false, false),
      (2, 'دهم الکترونیک', true, true),
    ]);
    expect(t.slots.last.start, '09:00');
    final s = await SchoolReports(db(e, ob, role: 'student', uid: 21)).today();
    expect(s.slots.single.subject, 'ریاضی');
    expect(s.slots.single.teacher, 'دبیر ریاضی');
    final early = await SchoolReports(
      db(e, ob, role: 'teacher', uid: 10, at: DateTime.utc(2026, 11, 12, 7)),
    ).today();
    expect(early.bell, isNull);
    expect(early.next!.order, 1);
    final (e2, ob2) = await seeded(workdays: const [0, 1, 2, 3, 4]);
    final off = await SchoolReports(db(e2, ob2, role: 'teacher', uid: 10))
        .today();
    expect(off.slots, isEmpty);
  });

  test('W11-U06 leaves: newest first; approve/reject with who and when; delete; queued before the '
      'local copy; NEG a teacher or parent cannot decide', () async {
    final (e, ob) = await seeded();
    final r = SchoolReports(db(e, ob));
    final l = await r.leaves();
    expect(l.map((x) => x.id), [61, 60]);
    expect(l.last.statusFa, 'در انتظار');
    expect(l.first.statusFa, 'تأییدشده');
    final w = await r.decide(60, 'rejected');
    expect(w.messageFa, 'درخواست رد شد');
    final op = ob.list().single;
    expect(op.collection, 'leaves');
    expect(op.payload!['status'], 'rejected');
    expect(op.payload!['decided_by'], 1);
    expect(op.payload!['decided_at'], '2026-11-12T09:10:00.000Z');
    expect((await e.get('leaves', 60))!.data['status'], 'rejected');
    expect((await r.leaves()).last.queued, isTrue);
    expect((await r.decide(60, 'anything')).messageFa, 'درخواست تأیید شد');
    await r.deleteLeave(61);
    expect(await e.get('leaves', 61), isNull);
    expect(ob.list().last.type, 'del');
    await expectLater(
      SchoolReports(db(e, ob, role: 'teacher', uid: 10)).decide(60, 'approved'),
      notAllowed(),
    );
    await expectLater(
      SchoolReports(db(e, ob, role: 'parent', uid: 30)).deleteLeave(60),
      notAllowed(),
    );
    expect(ob.list(), hasLength(3));
  });

  test('W11-U07 print: one self-contained right-to-left HTML document, names escaped', () async {
    final (e, ob) = await seeded();
    final r = SchoolReports(db(e, ob));
    final html = SchoolReports.printable(
      school: 'هنرستان <تست>',
      dateFa: '۱۴۰۵/۰۸/۲۱',
      week: await r.weekly(),
      card: await r.card(5),
    );
    expect(html, startsWith('<!doctype html><html lang="fa" dir="rtl">'));
    expect(html, contains('هنرستان &lt;تست&gt;'));
    expect(html, contains('<td>دهم الکترونیک</td><td>۳</td>'));
    expect(html, contains('<td><b>۱۷.۰۰</b></td><td>۶۷٪</td>'));
    expect(html, isNot(contains('http')));
    expect(html, isNot(contains('<script')));
  });
}
