// Row 187 — every role gets exactly its access on the device (the p2 definitions):
// معاون (vice) = مدیر; the counselor's referral queue; staff/office/guard read-only.
import 'dart:math';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

SchoolRecords db(SqliteEngine e, SqliteOutbox ob, String role, int uid) =>
    SchoolRecords(
      engine: e,
      outbox: ob,
      role: role,
      uid: uid,
      random: Random(187),
    );

void main() {
  test('R187-01 permRole: only vice/deputy become manager', () {
    expect(permRole('vice'), 'manager');
    expect(permRole('deputy'), 'manager');
    for (final r in [
      'manager',
      'teacher',
      'parent',
      'student',
      'counselor',
      'guard',
      'staff',
      'office',
    ]) {
      expect(permRole(r), r);
    }
    expect(roleNameFa('vice'), 'معاون');
  });

  test('R187-02 a vice reads and writes every collection like the manager', () {
    final e = SqliteEngine.inMemory();
    final ob = SqliteOutbox(e.database);
    final v = db(e, ob, 'vice', 2);
    final m = db(e, ob, 'manager', 1);
    expect(v.role, 'manager');
    for (final c in SchoolRecords.rules.keys) {
      expect(v.canRead(c), m.canRead(c), reason: 'read $c');
      expect(v.canWrite(c), m.canWrite(c), reason: 'write $c');
    }
    expect(() => v.requireRead('users'), returnsNormally);
    expect(() => v.requireWrite('app_settings'), returnsNormally);
    expect(UserDirectory.wholeSchool.contains(v.role), isTrue);
  });

  test('R187-03 staff, office and guard: common data only, no writes', () {
    final e = SqliteEngine.inMemory();
    final ob = SqliteOutbox(e.database);
    for (final r in ['staff', 'office', 'guard']) {
      final d = db(e, ob, r, 9);
      expect(d.canRead('announcements'), isTrue, reason: r);
      for (final c in SchoolRecords.rules.keys) {
        expect(d.canWrite(c), isFalse, reason: '$r writes $c');
      }
    }
  });

  test('R187-04 the manager refers, the counselor handles; no grades, no discipline', () async {
    final e = SqliteEngine.inMemory();
    final ob = SqliteOutbox(e.database);
    await e.put('users', 3, {
      'id': 3,
      'name': 'الف',
      'role': 'student',
      'grade': 'دهم',
      'branch': 'شبکه',
    }, version: 1);
    await e.put('attendance', 4000000000000001, {
      'student_id': 3,
      'date': DateTime.now().toUtc().toIso8601String().substring(0, 10),
      'status': 'absent',
    }, version: 1);
    final mgr = CounselorQueue(db(e, ob, 'vice', 2));
    expect(mgr.canRefer, isTrue);
    expect((await mgr.students()).single.id, 3);
    final w = await mgr.refer(3, 'تأخیر مکرر');
    expect(w.queued, isTrue);
    expect(
      w.id! ~/ SchoolRecords.idSlotSpan,
      SchoolRecords.idBaseOf('counselor_refs') ~/ SchoolRecords.idSlotSpan,
    );
    await expectLater(mgr.refer(3, '  '), throwsA(isA<RecordFailure>()));

    final cdb = db(e, ob, 'counselor', 5);
    final q = CounselorQueue(cdb);
    expect(q.canRefer, isFalse);
    expect(q.canHandle, isTrue);
    expect(cdb.canWrite('discipline'), isFalse);
    final list = await q.list();
    expect(list.single.studentName, 'الف');
    expect(list.single.cohort, 'دهم · شبکه');
    expect(list.single.absent, 1);
    expect(list.single.open, isTrue);
    await q.handle(list.single, 'با ولی تماس گرفته شد');
    final after = (await q.list()).single;
    expect(after.open, isFalse);
    expect(after.note, 'با ولی تماس گرفته شد');
    await expectLater(q.refer(3, 'x'), throwsA(isA<RecordFailure>()));
    expect(ob.list().length, 2);
  });
}
