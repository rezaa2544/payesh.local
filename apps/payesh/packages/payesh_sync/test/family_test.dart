// Row 74, wave 5 — native parents pages, unit level (local database + durable outbox, no
// network). Parity target: client/pages.js `parentHome`, `PAGES.child`, `PAGES.leaves`,
// `actLeaveAdd`; client/app.js `leave` form handler; server/policy.js `buildScope` (parent),
// `canWrite` (parent → leaves only, status pending); server/tenancy.js `MAX_OP_BYTES`.
import 'dart:math';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

/// 22:00 UTC on 11 Nov = 01:30 on 12 Nov in Tehran: the default day must be the UTC day.
final clock = DateTime.utc(2026, 11, 11, 22);

/// Random whose values are scripted (to force an id collision), then a seeded generator.
final class ScriptedRandom implements Random {
  ScriptedRandom(this.script);
  final List<int> script;
  final Random _rest = Random(11);
  @override
  int nextInt(int max) =>
      script.isNotEmpty ? script.removeAt(0) : _rest.nextInt(max);
  @override
  bool nextBool() => _rest.nextBool();
  @override
  double nextDouble() => _rest.nextDouble();
}

/// Parent 30 is linked to students 21 (twice) and 22, and — through a deleted link — to 23;
/// parent 31 is linked to 24.
Future<(SqliteEngine, SqliteOutbox)> seeded({
  OutboxConfig config = const OutboxConfig(),
}) async {
  final e = SqliteEngine.inMemory();
  final ob = SqliteOutbox(e.database, config: config);
  Future<void> put(String c, int id, Map<String, Object?> d, [int v = 1]) =>
      e.put(c, id, {...d, 'id': id}, version: v);
  await put('classes', 5, {'name': 'دهم ریاضی'});
  await put('classes', 6, {'name': 'یازدهم تجربی'});
  await put('subjects', 1, {'name': 'ریاضی'});
  await put('subjects', 2, {'name': 'فیزیک'});
  for (final (id, name, cls) in [
    (21, 'سارا احمدی', 5),
    (22, 'علی احمدی', 6),
    (23, 'مریم احمدی', 5),
    (24, 'رضا کریمی', 5),
  ]) {
    await put('users', id, {'name': name, 'role': 'student', 'class_id': cls});
  }
  await put('users', 30, {'name': 'ولی احمدی', 'role': 'parent'});
  await put('parent_links', 1, {'parent_id': 30, 'student_id': 22});
  await put('parent_links', 2, {'parent_id': 30, 'student_id': 21});
  await put('parent_links', 3, {'parent_id': 30, 'student_id': 21});
  await put('parent_links', 4, {
    'parent_id': 30,
    'student_id': 23,
    'deleted': true,
  });
  await put('parent_links', 5, {'parent_id': 31, 'student_id': 24});
  // student 21: two approved (18, 13), one pending (5), one approved with a practical part
  await put('grades', 101, {
    'student_id': 21,
    'class_id': 5,
    'subject_id': 1,
    'term': 'نوبت اول',
    'score': 18,
    'status': 'approved',
  });
  await put('grades', 102, {
    'student_id': 21,
    'class_id': 5,
    'subject_id': 2,
    'term': 'نوبت اول',
    'score': 5,
    'status': 'pending',
  });
  await put('grades', 103, {
    'student_id': 21,
    'class_id': 5,
    'subject_id': 9, // not on the device
    'term': 'نوبت دوم',
    'score': 13,
    'practical_score': 17,
    'status': 'approved',
  });
  await put('grades', 104, {
    'student_id': 24,
    'class_id': 5,
    'subject_id': 1,
    'term': 'نوبت اول',
    'score': 20,
    'status': 'approved',
  });
  // student 21: 14 attendance days (1..14 Nov), absent on the 3rd and 9th, late on the 12th
  for (var d = 1; d <= 14; d++) {
    final status = switch (d) {
      3 || 9 => 'absent',
      12 => 'late',
      _ => 'present',
    };
    await put('attendance', 4000000000000000 + d * 10000000000 + 21, {
      'student_id': 21,
      'class_id': 5,
      'date': '2026-11-${d.toString().padLeft(2, '0')}',
      'status': status,
    });
  }
  await put('attendance', 4000000000000000 + 15 * 10000000000 + 21, {
    'student_id': 21,
    'class_id': 5,
    'date': '2026-11-15',
    'status': 'sick', // unknown value from some other client
  });
  // student 24 (other family): 2 of 3 present → 66.67 → 67 (rounded, not floored)
  for (final (d, status) in [(1, 'present'), (2, 'present'), (3, 'absent')]) {
    await put('attendance', 4000000000000000 + d * 10000000000 + 24, {
      'student_id': 24,
      'class_id': 5,
      'date': '2026-11-0$d',
      'status': status,
    });
  }
  await put('internships', 201, {
    'student_id': 21,
    'date': '2026-11-05',
    'hours': 4,
    'location': 'کارگاه برق',
    'status': 'approved',
  });
  await put('leaves', 301, {
    'student_id': 21,
    'date': '2026-11-03',
    'reason': 'پزشک',
    'status': 'approved',
  });
  await put('leaves', 302, {
    'student_id': 22,
    'date': '2026-11-10',
    'reason': '',
    'status': 'rejected',
  });
  await put('leaves', 303, {
    'student_id': 21,
    'date': '2026-11-10',
    'reason': 'سفر',
    'status': 'canceled', // web: anything else reads as «در انتظار»
  });
  await put('leaves', 304, {
    'student_id': 24,
    'date': '2026-11-11',
    'reason': 'غیر',
    'status': 'pending',
  });
  return (e, ob);
}

FamilyBook book(
  SqliteEngine e,
  SqliteOutbox ob, {
  String role = 'parent',
  int uid = 30,
  Random? random,
}) => FamilyBook(
  engine: e,
  outbox: ob,
  role: role,
  uid: uid,
  now: () => clock,
  random: random ?? Random(3),
);

Matcher refusedWith(FamilyError k) =>
    isA<FamilyFailure>().having((f) => f.kind, 'kind', k);

void main() {
  test('W5-U01 leave states and labels are exactly the web badge', () {
    expect(LeaveState.values.map((s) => s.labelFa), [
      'در انتظار',
      'تأییدشده',
      'رد شده',
    ]);
    expect(LeaveState.fromWire('approved'), LeaveState.approved);
    expect(LeaveState.fromWire('rejected'), LeaveState.rejected);
    for (final v in ['pending', 'canceled', 'x', null]) {
      expect(LeaveState.fromWire(v), LeaveState.pending);
    }
  });

  test('W5-U02 home: exactly the linked children, link order, one card each; deleted link ignored', () async {
    final (e, ob) = await seeded();
    final kids = await book(e, ob).children();
    expect(kids.map((k) => k.id), [22, 21]);
    expect(kids.map((k) => k.name), ['علی احمدی', 'سارا احمدی']);
    expect(kids.map((k) => k.className), ['یازدهم تجربی', 'دهم ریاضی']);
    // another parent sees only their own child
    final other = await book(e, ob, uid: 31).children();
    expect(other.map((k) => k.id), [24]);
    expect(other.single.attendancePercent, 67);
  });

  test('W5-U03 average = approved grades only; attendance = present / all, rounded; none → null', () async {
    final (e, ob) = await seeded();
    final kids = await book(e, ob).children();
    final sara = kids.firstWhere((k) => k.id == 21);
    expect(sara.average, 15.5); // (18 + 13) / 2 — the pending 5 is not counted
    expect(sara.approvedGrades, 2);
    // 15 records, 11 present → 73.33 → 73 (the unknown value counts as a record, like the web)
    expect(sara.attendanceRecords, 15);
    expect(sara.attendancePercent, 73);
    final ali = kids.firstWhere((k) => k.id == 22);
    expect(ali.average, isNull);
    expect(ali.attendancePercent, isNull);
  });

  test('W5-U04 child page: grades with review state, subject «—» when missing, practical part', () async {
    final (e, ob) = await seeded();
    final r = await book(e, ob).child(21);
    expect(r.summary.name, 'سارا احمدی');
    expect(r.grades.map((g) => g.id), [101, 102, 103]);
    expect(r.grades.map((g) => g.subject), ['ریاضی', 'فیزیک', '—']);
    expect(r.grades.map((g) => g.approved), [true, false, true]);
    expect(r.grades[2].practicalScore, 17);
    expect(r.grades[0].practicalScore, isNull);
    expect(r.grades[1].term, 'نوبت اول');
    expect(r.internships.single.location, 'کارگاه برق');
    expect(r.internships.single.hours, 4);
    expect(r.internships.single.approved, isTrue);
  });

  test('W5-U05 child page: latest 12 attendance records, newest first; unknown value kept raw', () async {
    final (e, ob) = await seeded();
    final r = await book(e, ob).child(21);
    expect(r.attendance, hasLength(FamilyBook.recentAttendance));
    expect(r.attendance.first.date, '2026-11-15');
    expect(r.attendance.first.status, isNull);
    expect(r.attendance.first.raw, 'sick');
    expect(r.attendance[3].date, '2026-11-12');
    expect(r.attendance[3].status, AttendanceStatus.late);
    expect(r.attendance.last.date, '2026-11-04');
  });

  test('W5-U06 child page of a student who is not linked is refused — no fallback child (negative)', () async {
    final (e, ob) = await seeded();
    for (final sid in [24, 23, 999]) {
      await expectLater(
        book(e, ob).child(sid),
        throwsA(refusedWith(FamilyError.notLinked)),
      );
    }
  });

  test('W5-U07 only a parent uses these pages (negative)', () async {
    final (e, ob) = await seeded();
    for (final role in ['manager', 'teacher', 'student', 'counselor', 'x']) {
      final b = book(e, ob, role: role);
      expect(b.isParent, isFalse);
      await expectLater(
        b.children(),
        throwsA(refusedWith(FamilyError.notParent)),
      );
      await expectLater(
        b.child(21),
        throwsA(refusedWith(FamilyError.notParent)),
      );
      await expectLater(
        b.leaveRequests(),
        throwsA(refusedWith(FamilyError.notParent)),
      );
      await expectLater(
        b.requestLeave(studentId: 21),
        throwsA(refusedWith(FamilyError.notParent)),
      );
    }
    expect(ob.list(), isEmpty);
  });

  test('W5-U08 leave list: own children only, newest day first, same day by id; states mapped', () async {
    final (e, ob) = await seeded();
    final ls = await book(e, ob).leaveRequests();
    expect(ls.map((l) => l.id), [303, 302, 301]);
    expect(ls.map((l) => l.state), [
      LeaveState.pending,
      LeaveState.rejected,
      LeaveState.approved,
    ]);
    expect(ls.map((l) => l.studentName), [
      'سارا احمدی',
      'علی احمدی',
      'سارا احمدی',
    ]);
    expect(ls.any((l) => l.id == 304), isFalse);
  });

  test('W5-U09 leave request: pending, UTC day by default, trimmed reason, by_id, base 0, queued first', () async {
    final (e, ob) = await seeded();
    final b = book(e, ob);
    final r = await b.requestLeave(studentId: 22, reason: '  مراجعه به پزشک  ');
    expect(r.messageFa, startsWith('درخواست ثبت شد'));
    final op = ob.list().single;
    expect(op.collection, 'leaves');
    expect(op.type, 'put');
    expect(op.id, r.id);
    expect(op.baseVersion, 0);
    expect(op.payload, {
      'id': r.id,
      'student_id': 22,
      'date': '2026-11-11',
      'reason': 'مراجعه به پزشک',
      'status': 'pending',
      'by_id': 30,
    });
    final stored = await e.get('leaves', r.id);
    expect(stored!.data, op.payload);
    final ls = await b.leaveRequests();
    expect(ls.first.id, r.id);
    expect(ls.first.queued, isTrue);
    expect(ls.where((l) => l.id != r.id).every((l) => !l.queued), isTrue);
    // an empty reason is allowed (the web field is optional)
    final r2 = await b.requestLeave(studentId: 21, date: '2026-11-20');
    expect((await e.get('leaves', r2.id))!.data['reason'], '');
    expect((await e.get('leaves', r2.id))!.data['date'], '2026-11-20');
  });

  test('W5-U10 leave request for a student who is not linked: refused, nothing written (negative)', () async {
    final (e, ob) = await seeded();
    final before = await e.count('leaves');
    for (final sid in [24, 23, 999]) {
      await expectLater(
        book(e, ob).requestLeave(studentId: sid),
        throwsA(refusedWith(FamilyError.notLinked)),
      );
    }
    expect(ob.list(), isEmpty);
    expect(await e.count('leaves'), before);
  });

  test(
    'W5-U11 bad dates are refused before anything is written (negative)',
    () async {
      final (e, ob) = await seeded();
      final before = await e.count('leaves');
      for (final d in [
        '2026-02-30',
        '2026-13-01',
        '1405/08/21',
        '2026-1-5',
        'x',
      ]) {
        await expectLater(
          book(e, ob).requestLeave(studentId: 21, date: d),
          throwsA(refusedWith(FamilyError.badDate)),
        );
      }
      expect(FamilyBook.validDay('2028-02-29'), isTrue);
      expect(FamilyBook.validDay('2026-02-29'), isFalse);
      expect(ob.list(), isEmpty);
      expect(await e.count('leaves'), before);
    },
  );

  test('W5-U12 ids: inside [3e15, 4e15) (below attendance), distinct, a local collision is re-drawn', () async {
    final (e, ob) = await seeded();
    final ids = <int>{};
    final b = book(e, ob);
    for (var i = 0; i < 20; i++) {
      ids.add((await b.requestLeave(studentId: 21)).id);
    }
    expect(ids, hasLength(20));
    for (final id in ids) {
      expect(id, greaterThanOrEqualTo(FamilyBook.idBase));
      expect(id, lessThan(FamilyBook.idBase + FamilyBook.idSpan));
      expect(id, lessThan(4000000000000000));
    }
    // force the first draw onto an existing record: (0 << 32 | 7) % span → idBase + 7
    await e.put('leaves', FamilyBook.idBase + 7, {
      'id': FamilyBook.idBase + 7,
      'student_id': 21,
      'status': 'approved',
    }, version: 4);
    final r = await book(
      e,
      ob,
      random: ScriptedRandom([0, 7]),
    ).requestLeave(studentId: 21);
    expect(r.id, isNot(FamilyBook.idBase + 7));
    expect((await e.get('leaves', FamilyBook.idBase + 7))!.version, 4);
    expect(
      (await e.get('leaves', FamilyBook.idBase + 7))!.data['status'],
      'approved',
    );
  });

  test(
    'W5-U13 full queue or oversize reason: refused, nothing written (negative)',
    () async {
      final (e, ob) = await seeded(config: const OutboxConfig(capacity: 0));
      final before = await e.count('leaves');
      await expectLater(
        book(e, ob).requestLeave(studentId: 21, reason: 'x'),
        throwsA(isA<SyncFailure>()),
      );
      expect(await e.count('leaves'), before);
      final (e2, ob2) = await seeded();
      await expectLater(
        book(e2, ob2).requestLeave(
          studentId: 21,
          reason: 'ا' * (FamilyBook.maxOpBytes ~/ 2),
        ),
        throwsA(refusedWith(FamilyError.tooLarge)),
      );
      expect(ob2.list(), isEmpty);
      expect(await e2.count('leaves'), before);
    },
  );
}
