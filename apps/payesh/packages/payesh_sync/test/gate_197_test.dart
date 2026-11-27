// Row 197 (Q06 / F38, F44) — «درِ مدرسه»: the guard's visitors (in/out) and today's early exits,
// plus the post defaults of the staff ticks ([] = default, ['none'] = nothing). Unit level: local
// SQLite + durable outbox, no network. The JS copy is checked by tests/staff-roles-197.js.
import 'dart:math';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

final _now = DateTime.utc(2026, 11, 27, 7, 30);

Future<(SqliteEngine, SchoolRecords)> seeded() async {
  final e = SqliteEngine.inMemory();
  final ob = SqliteOutbox(e.database, config: const OutboxConfig());
  Future<void> put(String c, int id, Map<String, Object?> d) =>
      e.put(c, id, {...d, 'id': id}, version: 1);
  await put('users', 4, {'name': 'نگهبان', 'role': 'guard'});
  await put('classes', 10, {'name': 'دهم برق'});
  await put('users', 21, {'name': 'سارا', 'role': 'student', 'class_id': 10});
  await put('users', 22, {'name': 'بهار', 'role': 'student', 'class_id': 10});
  await put('users', 23, {'name': 'آرش', 'role': 'student'});
  await put('leaves', 1, {
    'student_id': 21,
    'date': '2026-11-27',
    'kind': 'hours',
    'time_from': '10:00',
    'time_to': '12:00',
    'status': 'approved',
  });
  await put('leaves', 2, {
    'student_id': 22,
    'date': '2026-11-26',
    'date_to': '2026-11-28',
    'kind': 'days',
    'status': 'approved',
  });
  await put('leaves', 3, {
    'student_id': 23,
    'date': '2026-11-27',
    'kind': 'hours',
    'time_from': '09:00',
    'status': 'pending',
  });
  await put('leaves', 4, {
    'student_id': 23,
    'date': '2026-11-20',
    'kind': 'hours',
    'time_from': '08:00',
    'status': 'approved',
  });
  final db = SchoolRecords(
    engine: e,
    outbox: ob,
    // a granted area runs «as manager» locally (app.dart `_nav` … as: 'manager'); the server
    // still checks the guard's own grant (tests/staff-roles-197.js R03/R07)
    role: 'manager',
    uid: 4,
    random: Random(7),
    now: () => _now,
  );
  return (e, db);
}

void main() {
  test(
    'G-01 post defaults: [] = the post default, [none] = nothing, ticks win',
    () {
      expect(staffAccessOf('staff', const []), [
        'attendance',
        'leaves',
        'notices',
      ]);
      expect(staffAccessOf('office', null), [
        'attendance',
        'leaves',
        'notices',
        'classes',
        'grades',
        'reports',
      ]);
      expect(staffAccessOf('guard', ''), ['gate']);
      expect(staffAccessOf('counselor', const []), isEmpty);
      expect(staffAccessOf('guard', const ['none']), isEmpty);
      expect(staffAccessOf('guard', const ['leaves']), ['leaves']);
      expect(accessForSave('staff', const <String>{}), ['none']);
      expect(accessForSave('staff', const {'grades', 'x'}), ['grades']);
      expect(accessToStore('office', const ['root']), ['none']);
      expect(accessToStore('teacher', const ['gate']), isEmpty);
      expect(accessIsDefault(const []), isTrue);
      expect(accessIsDefault(const ['none']), isFalse);
      expect(staffAccessWrites(const ['gate']), {'visitors'});
      expect(staffAccessPages(const ['gate']), contains('gate'));
    },
  );

  test(
    'G-02 early exits: only approved leaves covering today, hourly first',
    () async {
      final (_, db) = await seeded();
      final x = await GateBook(db).earlyExits();
      expect([for (final e in x) e.student], ['سارا', 'بهار']);
      expect(x.first.hours, isTrue);
      expect(x.first.timeFrom, '10:00');
      expect(x.first.className, 'دهم برق');
      expect(x.last.hours, isFalse);
    },
  );

  test(
    'G-03 a visitor comes in and goes out; the rows go to the outbox',
    () async {
      final (e, db) = await seeded();
      final g = GateBook(db);
      final w = await g.checkIn(
        name: ' آقای رضایی ',
        phone: '0912 000 1111',
        reason: 'پیگیری پرونده',
        host: 'معاون',
      );
      var today = await g.today();
      expect(today, hasLength(1));
      expect(today.single.name, 'آقای رضایی');
      expect(today.single.inside, isTrue);
      expect(today.single.queued, isTrue);
      final row = (await e.get('visitors', w.id!))!.data;
      expect(row['date'], '2026-11-27');
      expect(row['in_at'], _now.toIso8601String());
      await g.checkOut(today.single);
      today = await g.today();
      expect(today.single.inside, isFalse);
      expect(today.single.outAt, isNotEmpty);
    },
  );

  test(
    'G-04 a visitor without a name is refused before anything is written',
    () async {
      final (e, db) = await seeded();
      await expectLater(
        GateBook(db).checkIn(name: '   '),
        throwsA(
          isA<RecordFailure>().having((f) => f.code, 'code', 'visitor_name'),
        ),
      );
      expect(await db.allOrEmpty('visitors'), isEmpty);
      expect(
        visitorIssue({
          'name': 'x',
          'date': '27/11',
          'in_at': _now.toIso8601String(),
        }),
        'bad_date',
      );
      expect(
        visitorIssue({
          'name': 'x',
          'date': '2026-11-27',
          'in_at': '2026-11-27T10:00:00Z',
          'out_at': '2026-11-27T09:00:00Z',
        }),
        'bad_time',
      );
    },
  );
}
