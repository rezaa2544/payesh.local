// Row 197-Q04 — student classes apart from rooms; student ↔ grade/branch/class link; attendance
// on the real class. Shape of the user's real school (2026-11-27): vocational «متوسطه دوم», rooms
// and workshops in `classes` (kind room), a duplicate «دهم» grade, students with grade + `field`
// and no class_id (the import never makes classes — 0.8.30).
import 'dart:math';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

const day = '2026-11-28';

Future<(SqliteEngine, SqliteOutbox)> seeded() async {
  final e = SqliteEngine.inMemory();
  final ob = SqliteOutbox(e.database);
  Future<void> put(String c, int id, Map<String, Object?> d) =>
      e.put(c, id, {...d, 'id': id}, version: 1);
  await put('lookups', 1, {'kind': 'grade', 'name': 'دهم', 'order': 1});
  await put('lookups', 2, {'kind': 'grade', 'name': 'یازدهم', 'order': 2});
  await put('lookups', 3, {'kind': 'branch', 'name': 'نقشه کشی', 'order': 1});
  await put('lookups', 4, {
    'kind': 'branch',
    'name': 'تعمیر موتور',
    'order': 2,
  });
  // the same grade defined a second time (server seed + phone) — broke the grade menu
  await put('lookups', 1432326162510474, {
    'kind': 'grade',
    'name': 'دهم',
    'order': 1,
  });
  await put('classes', 50, {'name': 'نقشه کشی', 'kind': 'room'});
  await put('classes', 51, {'name': '202', 'kind': 'room'});
  // a field class with the other spelling (ZWNJ) — still the same group
  await put('classes', 60, {
    'name': 'دهم نقشه‌کشی',
    'grade': 'دهم',
    'branch': 'نقشه‌کشی',
    'mode': 'field',
    'kind': 'class',
  });
  await put('classes', 61, {
    'name': 'دهم تعمیر موتور',
    'grade': 'دهم',
    'branch': 'تعمیر موتور',
    'mode': 'field',
    'kind': 'class',
  });
  await put('users', 10, {'name': 'دبیر', 'role': 'teacher'});
  await put('schedule', 900, {'teacher_id': 10, 'class_id': 60, 'bell': 1});
  // a schedule slot on a room must not turn the room into a class for the teacher
  await put('schedule', 901, {'teacher_id': 10, 'class_id': 50, 'bell': 2});
  for (var i = 0; i < 4; i++) {
    await put('users', 100 + i, {
      'name': 'نقشه $i',
      'role': 'student',
      'grade': 'دهم',
      'field': i.isEven ? 'نقشه کشی' : 'نقشه‌کشی',
      'class_id': null,
    });
  }
  await put('users', 110, {
    'name': 'موتور',
    'role': 'student',
    'grade': 'دهم',
    'field': 'تعمیر موتور',
    'class_id': null,
  });
  await put('users', 111, {
    'name': 'یازدهمی',
    'role': 'student',
    'grade': 'یازدهم',
    'field': 'نقشه کشی',
    'class_id': null,
  });
  await put('users', 112, {
    'name': 'غیرفعال',
    'role': 'student',
    'grade': 'دهم',
    'field': 'نقشه کشی',
    'class_id': null,
    'active': false,
  });
  // placed by hand in another class: never pulled into the group
  await put('users', 113, {
    'name': 'جابه‌جا',
    'role': 'student',
    'grade': 'دهم',
    'field': 'نقشه کشی',
    'class_id': 61,
  });
  await put('users', 114, {
    'name': 'والد',
    'role': 'parent',
    'grade': 'دهم',
    'field': 'نقشه کشی',
  });
  return (e, ob);
}

SchoolRecords db(SqliteEngine e, SqliteOutbox ob) => SchoolRecords(
  engine: e,
  outbox: ob,
  role: 'manager',
  uid: 1,
  random: Random(3),
);

void main() {
  test('Q04-U01 fieldGroupMember: grade + field/branch by key; never rooms, own class, empty group', () {
    final c = <String, Object?>{
      'grade': 'دهم',
      'branch': 'نقشه‌کشی',
      'kind': 'class',
    };
    final s = <String, Object?>{
      'role': 'student',
      'grade': 'دهم',
      'field': 'نقشه کشی',
    };
    expect(fieldGroupMember(c, s), isTrue);
    expect(
      fieldGroupMember(c, {...s, 'field': null, 'branch': 'نقشه کشی'}),
      isTrue,
    );
    expect(fieldGroupMember({...c, 'kind': 'room'}, s), isFalse);
    expect(fieldGroupMember(c, {...s, 'class_id': 61}), isFalse);
    expect(fieldGroupMember({...c, 'branch': ''}, s), isFalse);
    expect(fieldGroupMember(c, {...s, 'grade': 'یازدهم'}), isFalse);
    expect(fieldGroupMember(c, {...s, 'role': 'parent'}), isFalse);
    expect(
      fieldGroupMember(c, {...s, 'followup_reason': 'کلاس حذف شد'}),
      isFalse,
    );
  });

  test('Q04-U02 attendance: «دهم نقشه‌کشی» lists its real students (both spellings); rooms are not classes', () async {
    final (e, ob) = await seeded();
    final m = AttendanceBook(engine: e, outbox: ob, role: 'manager', uid: 1);
    final cls = await m.classes();
    expect(
      cls.map((c) => c.name),
      unorderedEquals(['دهم نقشه‌کشی', 'دهم تعمیر موتور']),
    );
    expect(cls.firstWhere((c) => c.id == 60).students, 4);
    expect(
      cls.firstWhere((c) => c.id == 61).students,
      2,
      reason: 'own class 113 + group 110',
    );
    final r = await m.roster(60, day);
    expect(r.map((x) => x.studentId), unorderedEquals([100, 101, 102, 103]));
  });

  test('Q04-U03 teacher: scheduled field class has its roster and can be saved; a room slot is no class', () async {
    final (e, ob) = await seeded();
    final t = AttendanceBook(engine: e, outbox: ob, role: 'teacher', uid: 10);
    final cls = await t.classes();
    expect(cls.map((c) => c.id), [60]);
    final res = await t.save(
      classId: 60,
      date: day,
      marks: {101: AttendanceStatus.absent},
    );
    expect(res, isNotNull);
    final ops = ob.list().map((o) => o.payload!).toList();
    expect(
      ops.map((d) => d['student_id']),
      unorderedEquals([100, 101, 102, 103]),
    );
    expect(ops.every((d) => d['class_id'] == 60), isTrue);
    // a student of another group is refused
    await expectLater(
      t.save(classId: 60, date: day, marks: {110: AttendanceStatus.absent}),
      throwsA(isA<AttendanceFailure>()),
    );
  });

  test('Q04-U04 definitions: «دهم» once; majors and grades show student counts; rooms are not counted', () async {
    final (e, ob) = await seeded();
    final v = await ClassBook(db(e, ob)).overview();
    expect(v.grades.map((g) => g.name), ['دهم', 'یازدهم']);
    expect(v.grades.first.id, 1, reason: 'the oldest definition stays');
    final g = {for (final x in v.grades) x.name: x};
    expect(g['دهم']!.students, 6);
    expect(g['یازدهم']!.students, 1);
    final b = {for (final x in v.branches) x.name: x};
    expect(
      b['نقشه کشی']!.students,
      6,
      reason: '4 + 113 + یازدهمی; inactive and parent left out',
    );
    expect(
      b['نقشه کشی']!.classes,
      1,
      reason: 'the room «نقشه کشی» is not a class',
    );
    expect(b['تعمیر موتور']!.students, 1);
    expect(v.rooms.map((r) => r.name), unorderedEquals(['نقشه کشی', '202']));
    expect(v.classes.firstWhere((c) => c.id == 60).students, 4);
  });
}
