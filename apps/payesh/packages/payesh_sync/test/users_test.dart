// Row 128, wave W6 — users and records, unit level (local SQLite + durable outbox, no network).
// Parity target: client/pages.js PAGES.users / PAGES.students / PAGES.record, client/app.js
// `user` / `user-edit` / `user-full` forms, `user-delete`, `users-bulk-delete`,
// `deleteStudentWithParents`, `findUserDuplicates`.
import 'dart:math';

import 'package:payesh_core/payesh_core.dart';
import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

Future<(SqliteEngine, SqliteOutbox)> seeded({
  OutboxConfig config = const OutboxConfig(),
}) async {
  final e = SqliteEngine.inMemory();
  final ob = SqliteOutbox(e.database, config: config);
  Future<void> put(String c, int id, Map<String, Object?> d) =>
      e.put(c, id, {...d, 'id': id}, version: 1);
  await put('classes', 5, {'name': 'دهم الف', 'grade': 'دهم'});
  await put('classes', 6, {'name': 'یازدهم'});
  await put('subjects', 41, {'name': 'ریاضی'});
  await put('users', 1, {
    'name': 'مدیر',
    'role': 'manager',
    'phone': '09120000001',
  });
  await put('users', 10, {
    'name': 'دبیر ریاضی',
    'role': 'teacher',
    'phone': '09120000010',
  });
  await put('users', 21, {
    'name': 'بهار',
    'last_name': 'سعیدی',
    'role': 'student',
    'class_id': 5,
    'national_id': '0012345678',
    'birth_date': '2010-03-01',
    'father_name': 'رضا',
  });
  await put('users', 22, {
    'name': 'آرسام سعیدی',
    'last_name': 'سعیدی',
    'role': 'student',
    'class_id': 6,
  });
  await put('users', 23, {'name': 'نیما', 'role': 'student', 'class_id': 5});
  await put('users', 40, {
    'name': 'رضا سعیدی',
    'role': 'parent',
    'phone': '09120000040',
  });
  await put('users', 41, {
    'name': 'مریم',
    'role': 'parent',
    'phone': '09120000041',
  });
  await put('parent_links', 700, {
    'parent_id': 40,
    'student_id': 21,
    'relation': 'پدر',
  });
  await put('parent_links', 701, {
    'parent_id': 40,
    'student_id': 23,
    'relation': 'پدر',
  });
  await put('parent_links', 702, {
    'parent_id': 41,
    'student_id': 21,
    'relation': 'مادر',
  });
  await put('schedule', 900, {
    'teacher_id': 10,
    'class_id': 5,
    'subject_id': 41,
  });
  await put('grades', 1, {
    'student_id': 21,
    'subject_id': 41,
    'score': 18,
    'status': 'approved',
  });
  await put('grades', 2, {'student_id': 21, 'subject_id': 41, 'score': 15});
  await put('attendance', 1, {'student_id': 21, 'status': 'present'});
  await put('attendance', 2, {'student_id': 21, 'status': 'absent'});
  await put('attendance', 3, {'student_id': 21, 'status': 'present'});
  await put('attendance', 4, {'student_id': 21, 'status': 'present'});
  return (e, ob);
}

UserDirectory dir(
  SqliteEngine e,
  SqliteOutbox ob, {
  String role = 'manager',
  int uid = 1,
}) => UserDirectory(
  SchoolRecords(engine: e, outbox: ob, role: role, uid: uid, random: Random(6)),
);

Matcher refused(String code) =>
    throwsA(isA<RecordFailure>().having((f) => f.code, 'code', code));

void main() {
  test('W6-U01 users page: manager only, role filter, search on name/mobile/national id, sorted', () async {
    final (e, ob) = await seeded();
    final d = dir(e, ob);
    expect((await d.list()).length, 7);
    expect((await d.list(role: 'parent')).map((u) => u.id), [40, 41]);
    expect((await d.list(query: '0012345678')).single.id, 21);
    expect((await d.list(query: '09120000010')).single.id, 10);
    final rows = await d.list(role: 'student');
    expect(rows.map((u) => u.name), [
      'آرسام سعیدی',
      'بهار سعیدی',
      'نیما',
    ], reason: 'fullName never repeats the last name');
    expect(rows.firstWhere((u) => u.id == 21).className, 'دهم الف');
    expect(
      (await d.list(role: 'parent')).first.kids,
      containsAll(['بهار سعیدی', 'نیما']),
    );
    await expectLater(
      dir(e, ob, role: 'teacher', uid: 10).list(),
      refused('not_allowed'),
    );
  });

  test('W6-U02 students page: a teacher sees only the classes they teach; average of grades', () async {
    final (e, ob) = await seeded();
    final t = await dir(e, ob, role: 'teacher', uid: 10).students();
    expect(t.map((s) => s.user.id), [21, 23]);
    expect(t.first.average, 16.5);
    expect(t.first.className, 'دهم الف');
    expect((await dir(e, ob).students()).length, 3);
    expect((await dir(e, ob).students(query: 'نیما')).single.user.id, 23);
    await expectLater(
      dir(e, ob, role: 'parent', uid: 40).students(),
      refused('not_reader'),
    );
  });

  test(
    'W6-U03 record page: the student\'s attendance %, grades and profile',
    () async {
      final (e, ob) = await seeded();
      final r = await dir(e, ob, role: 'student', uid: 21).myRecord();
      expect(r.presentPercent, 75);
      expect(r.grades, [('ریاضی', 18, true), ('ریاضی', 15, false)]);
      expect(r.className, 'دهم الف');
      expect(r.details, contains(('نام پدر', 'رضا')));
      await expectLater(dir(e, ob).myRecord(), refused('not_reader'));
    },
  );

  test('W6-U04 add: student with a new parent → user + parent + link queued (offline)', () async {
    final (e, ob) = await seeded();
    final w = await dir(e, ob).add(
      const UserDraft(
        name: 'سارا',
        classId: 6,
        nationalId: '۰۰۹۸۷۶۵۴۳۲',
        phone: '9121112233',
        parentName: 'علی',
        parentPhone: '09124445566',
        extra: {'father_name': 'علی', 'mother_phone': '9127778899'},
      ),
    );
    expect(w.keys, hasLength(3));
    final s = (await e.get('users', w.id!))!.data;
    expect(s['national_id'], '0098765432');
    expect(s['phone'], '09121112233');
    expect(s['mother_phone'], '09127778899');
    expect(
      w.id! >= SchoolRecords.idBaseOf('users') &&
          w.id! < SchoolRecords.idBaseOf('parent_links'),
      isTrue,
    );
    final ops = ob.list();
    expect(ops.map((o) => '${o.collection}:${o.type}:${o.baseVersion}'), [
      'users:put:0',
      'users:put:0',
      'parent_links:put:0',
    ]);
    expect(ops[1].payload!['role'], 'parent');
    expect(ops[2].payload!['student_id'], w.id);
    expect(ops[2].payload!['parent_id'], ops[1].id);
  });

  test('W6-U05 add: an existing parent mobile re-uses that parent', () async {
    final (e, ob) = await seeded();
    final w = await dir(
      e,
      ob,
    ).add(const UserDraft(name: 'کیان', parentPhone: '09120000041'));
    expect(w.keys, hasLength(2));
    expect(ob.list().last.payload!['parent_id'], 41);
    expect(w.messageFa, contains('ولیِ موجود'));
  });

  test('W6-U06 add refuses: empty name, bad national id / mobile, used national id / mobile (negative)', () async {
    final (e, ob) = await seeded();
    final d = dir(e, ob);
    await expectLater(d.add(const UserDraft(name: '  ')), refused('invalid'));
    await expectLater(
      d.add(const UserDraft(name: 'x', nationalId: '12345')),
      refused('invalid'),
    );
    await expectLater(
      d.add(const UserDraft(name: 'x', phone: '0812345')),
      refused('invalid'),
    );
    await expectLater(
      d.add(const UserDraft(name: 'x', nationalId: '0012345678')),
      refused('duplicate'),
    );
    await expectLater(
      d.add(const UserDraft(name: 'x', phone: '۰۹۱۲۰۰۰۰۰۱۰')),
      refused('duplicate'),
    );
    await expectLater(
      d.add(const UserDraft(name: 'x', role: 'admin')),
      refused('invalid'),
    );
    await expectLater(
      dir(e, ob, role: 'teacher', uid: 10).add(const UserDraft(name: 'x')),
      refused('not_allowed'),
    );
    expect(ob.list(), isEmpty);
  });

  test('W6-U07 add: same name + birth date = same person until the manager confirms', () async {
    final (e, ob) = await seeded();
    final d = dir(e, ob);
    const draft = UserDraft(name: 'بهار', birthDate: '2010-03-01');
    await expectLater(
      d.add(draft),
      throwsA(
        isA<SamePersonFailure>().having(
          (f) => f.matches.single.id,
          'match',
          21,
        ),
      ),
    );
    expect(ob.list(), isEmpty);
    final w = await d.add(draft, samePersonOk: true);
    expect(w.keys, hasLength(1));
  });

  test('W6-U08 edit keeps other fields, clears emptied extras, refuses a used mobile', () async {
    final (e, ob) = await seeded();
    final d = dir(e, ob);
    final w = await d.edit(
      21,
      name: 'بهار',
      phone: '9125550000',
      active: false,
      extra: {'father_name': ''},
    );
    expect(w.keys, hasLength(1));
    final s = (await e.get('users', 21))!.data;
    expect(s['national_id'], '0012345678');
    expect(s['phone'], '09125550000');
    expect(s['active'], false);
    expect(s['father_name'], '');
    expect(ob.list().single.baseVersion, 1);
    final same = await d.edit(
      21,
      name: 'بهار',
      phone: '09125550000',
      active: false,
      extra: {'father_name': ''},
    );
    expect(same.keys, isEmpty, reason: 'unchanged → nothing queued');
    await expectLater(
      d.edit(21, name: 'x', phone: '09120000010', active: true),
      refused('duplicate'),
    );
    await expectLater(
      d.edit(999, name: 'x', phone: '', active: true),
      refused('unknown'),
    );
  });

  test('W6-U09 full profile: the student\'s father/mother details follow to the parent accounts', () async {
    final (e, ob) = await seeded();
    final w = await dir(e, ob).saveFull(21, {
      'father_name': 'رضا سعیدی‌نیا',
      'mother_phone': '9126660000',
    });
    expect(w.keys, hasLength(3));
    expect((await e.get('users', 40))!.data['name'], 'رضا سعیدی‌نیا');
    expect((await e.get('users', 41))!.data['phone'], '09126660000');
    expect(w.messageFa, contains('ولی'));
    await expectLater(
      dir(e, ob).saveFull(21, {'mother_phone': '123'}),
      refused('invalid'),
    );
  });

  test('W6-U10 delete a student: links go; a parent with another child stays, a lone parent goes', () async {
    final (e, ob) = await seeded();
    final d = dir(e, ob);
    expect(await d.orphanParentsOf(21), ['مریم']);
    final w = await d.delete(21);
    expect(await e.get('users', 21), isNull);
    expect(await e.get('users', 40), isNotNull, reason: 'still parent of 23');
    expect(await e.get('users', 41), isNull);
    expect(await e.get('parent_links', 700), isNull);
    expect(await e.get('parent_links', 701), isNotNull);
    expect(w.messageFa, contains('مریم'));
    expect(ob.list().every((o) => o.type == 'del'), isTrue);
  });

  test('W6-U11 bulk delete; never your own account (negative)', () async {
    final (e, ob) = await seeded();
    final d = dir(e, ob);
    await expectLater(d.bulkDelete({1, 10}), refused('in_use'));
    await expectLater(d.delete(1), refused('in_use'));
    await expectLater(d.bulkDelete({}), refused('invalid'));
    expect(ob.list(), isEmpty);
    final w = await d.bulkDelete({21, 23});
    expect(w.messageFa, startsWith('2 '));
    expect(await e.get('users', 40), isNull, reason: 'both children gone');
    expect(await e.get('users', 41), isNull);
  });

  test('W6-U12 full queue: a student+parent add is refused whole, nothing written (negative)', () async {
    final (e, ob) = await seeded(config: const OutboxConfig(capacity: 2));
    await expectLater(
      dir(e, ob).add(const UserDraft(name: 'سارا', parentName: 'علی')),
      throwsA(
        isA<SyncFailure>().having(
          (s) => s.code,
          'code',
          PayeshErrorCode.queueFull,
        ),
      ),
    );
    expect(ob.list(), isEmpty);
    expect(await e.count('users'), 7);
  });
}
