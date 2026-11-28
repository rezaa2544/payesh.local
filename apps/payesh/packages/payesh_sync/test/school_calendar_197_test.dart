// Row 197 — Q10 (F36) a sudden day off («تعطیل» / «غیرحضوری»). Web twin: client/pages.js
// `dayOffOf` + client/app.js form `dayoff`; server twin: server/school-calendar.js
// (tests/day-off-197.js).
import 'dart:math';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

const tomorrow = '2026-11-13';
const later = '2026-11-16';

Future<(SqliteEngine, SqliteOutbox, SchoolRecords)> seeded() async {
  final e = SqliteEngine.inMemory();
  final ob = SqliteOutbox(e.database);
  Future<void> put(String c, int id, Map<String, Object?> d) =>
      e.put(c, id, {...d, 'id': id}, version: 1);
  await put('classes', 5, {'name': 'هفتم'});
  await put('users', 10, {'name': 'دبیر', 'role': 'teacher'});
  await put('schedule', 900, {
    'teacher_id': 10,
    'class_id': 5,
    'subject_id': 1,
  });
  await put('users', 21, {'name': 'بهار', 'role': 'student', 'class_id': 5});
  await put('exams', 1, {
    'date': tomorrow,
    'title': 'ریاضی',
    'kind': 'internal',
  });
  await put('exams', 2, {
    'date': tomorrow,
    'title': 'نهایی',
    'kind': 'national',
  });
  await put('exams', 3, {'date': later, 'title': 'علوم', 'kind': 'internal'});
  final db = SchoolRecords(
    engine: e,
    outbox: ob,
    role: 'manager',
    uid: 1,
    random: Random(3),
  );
  return (e, ob, db);
}

String jd(String iso) => 'J$iso';

void main() {
  test('C197-01 row shape = server/school-calendar.js', () {
    Map<String, Object?> d([Map<String, Object?> x = const {}]) => {
      'date': tomorrow,
      'kind': 'closed',
      'reason': 'آلودگی هوا',
      ...x,
    };
    expect(dayOffIssue(d()), isNull);
    expect(dayOffIssue(d({'kind': 'remote'})), isNull);
    expect(dayOffIssue(d({'date': '2026-02-30'})), 'bad_date');
    expect(dayOffIssue(d({'kind': 'holiday'})), 'bad_kind');
    expect(dayOffIssue(d({'reason': ' '})), 'reason_required');
    expect(dayOffIssue(d({'exams_to': tomorrow})), 'bad_range');
    expect(dayOffIssue(d({'exams_to': later})), isNull);
    expect(DayOffKind.values.map((k) => k.labelFa), ['تعطیل', 'غیرحضوری']);
  });

  test(
    'C197-02 announce: calendar row, important notice, internal exams moved',
    () async {
      final (e, ob, db) = await seeded();
      final r = await SchoolCalendar(db).announce(
        date: tomorrow,
        kind: DayOffKind.closed,
        reason: 'کمبود انرژی',
        examsTo: later,
        today: '2026-11-12',
        jdate: jd,
      );
      expect(r.moved, 1);
      expect(r.national, 1);
      expect(r.messageFa, contains('امتحان نهایی'));
      final row = (await e.get('calendar', r.id))!.data;
      expect(row['kind'], 'closed');
      expect(row['exams_to'], later);
      expect(dayOffIssue(row), isNull);
      final n = (await e.get('announcements', r.noticeId!))!.data;
      expect(n['severity'], 'important');
      expect(n['title'], 'تعطیل — J$tomorrow');
      expect(n['body'], contains('کمبود انرژی'));
      expect((await e.get('exams', 1))!.data['date'], later);
      expect((await e.get('exams', 1))!.data['moved_from'], tomorrow);
      expect((await e.get('exams', 2))!.data['date'], tomorrow);
      expect((await e.get('exams', 3))!.data['date'], later);
      expect(ob.list().length, 3); // calendar + exam + notice
      expect(
        (await SchoolCalendar(db).upcoming('2026-11-12')).single.date,
        tomorrow,
      );
      await expectLater(
        SchoolCalendar(db).announce(
          date: tomorrow,
          kind: DayOffKind.remote,
          reason: 'دوباره',
          today: '2026-11-12',
          jdate: jd,
        ),
        throwsA(isA<RecordFailure>()),
      );
    },
  );

  test('C197-03 attendance: closed day refused, remote day only present; cancel restores', () async {
    final (e, ob, db) = await seeded();
    final book = AttendanceBook(
      engine: e,
      outbox: ob,
      role: 'teacher',
      uid: 10,
    );
    final r = await SchoolCalendar(db).announce(
      date: tomorrow,
      kind: DayOffKind.closed,
      reason: 'آلودگی هوا',
      notify: false,
      today: '2026-11-12',
      jdate: jd,
    );
    expect(r.noticeId, isNull);
    expect((await book.dayOff(tomorrow))!.kind, DayOffKind.closed);
    await expectLater(
      book.save(classId: 5, date: tomorrow),
      throwsA(
        isA<AttendanceFailure>().having(
          (f) => f.kind,
          'kind',
          AttendanceError.dayOff,
        ),
      ),
    );
    await e.put('calendar', r.id, {
      ...(await e.get('calendar', r.id))!.data,
      'kind': 'remote',
    }, version: 1);
    await expectLater(
      book.save(
        classId: 5,
        date: tomorrow,
        marks: {21: AttendanceStatus.absent},
      ),
      throwsA(isA<AttendanceFailure>()),
    );
    final ok = await book.save(
      classId: 5,
      date: tomorrow,
      marks: {21: AttendanceStatus.present},
    );
    expect(ok.written, 1);
    // NEG: another day takes absences
    final other = await book.save(
      classId: 5,
      date: later,
      marks: {21: AttendanceStatus.absent},
    );
    expect(other.written, 1);
    await SchoolCalendar(db).cancel(r.id);
    expect(await book.dayOff(tomorrow), isNull);
  });
}
