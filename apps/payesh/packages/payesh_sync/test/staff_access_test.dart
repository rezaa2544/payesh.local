// Row 194 — «سطح دسترسی» of the executive staff, the five role groups of the users page, the
// new-user form per role (parents' accounts with a student, a teacher's subjects, a staff
// member's ticks) and the p2 automatic class placement of the import (unit level: local SQLite +
// durable outbox, no network). The JS ↔ Dart copy of the access table is checked by
// tests/access-194.js (AC-08).
import 'dart:math';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

Future<(SqliteEngine, SqliteOutbox)> seeded() async {
  final e = SqliteEngine.inMemory();
  final ob = SqliteOutbox(e.database, config: const OutboxConfig());
  Future<void> put(String c, int id, Map<String, Object?> d) =>
      e.put(c, id, {...d, 'id': id}, version: 1);
  await put('users', 1, {'name': 'مدیر', 'role': 'manager'});
  await put('users', 2, {'name': 'معاون', 'role': 'vice'});
  await put('users', 3, {'name': 'مشاور', 'role': 'counselor'});
  await put('users', 4, {'name': 'نگهبان', 'role': 'guard'});
  await put('users', 10, {'name': 'دبیر', 'role': 'teacher'});
  await put('users', 21, {'name': 'دانش‌آموز', 'role': 'student'});
  await put('users', 40, {
    'name': 'ولی',
    'role': 'parent',
    'phone': '09120000040',
    'national_id': '0011111111',
  });
  return (e, ob);
}

UserDirectory dir(SqliteEngine e, SqliteOutbox ob) => UserDirectory(
  SchoolRecords(
    engine: e,
    outbox: ob,
    role: 'manager',
    uid: 1,
    random: Random(4),
  ),
);

void main() {
  test('SA-01 the ticks: only known keys, only for ticked roles, in the table order', () {
    expect(staffAccessOf('counselor', ['notices', 'x', 'attendance']), [
      'attendance',
      'notices',
    ]);
    expect(staffAccessOf('guard', 'leaves, grades'), ['leaves', 'grades']);
    expect(staffAccessOf('teacher', ['attendance']), isEmpty);
    expect(
      staffAccessOf('vice', ['attendance']),
      isEmpty,
      reason: 'معاون = مدیر',
    );
    expect(staffAccessOf('manager', ['attendance']), isEmpty);
    expect(staffAccessPages(['classes', 'reports']), {
      'classes',
      'reports',
      'attendance-report',
    });
    expect(
      staffAccessWrites(['reports']),
      isEmpty,
      reason: 'reports = read only',
    );
    expect(staffAccessWrites(['schedule']), {
      'schedule',
      'bell_schedules',
      'substitutions',
    });
    expect(grantableRoles, {'counselor', 'staff', 'office', 'guard'});
  });

  test('SA-02 users page: «همه · دانش‌آموز · دبیر · ولی · عوامل اجرایی»; معاون، مشاور، '
      'نگهبان and the manager are all «عوامل اجرایی»', () async {
    expect(
      [for (final (_, l) in roleFilters) l],
      ['همه', 'دانش‌آموز', 'دبیر', 'ولی', 'عوامل اجرایی'],
    );
    final (e, ob) = await seeded();
    final d = dir(e, ob);
    expect((await d.list(role: execGroup)).map((u) => u.id).toSet(), {
      1,
      2,
      3,
      4,
    });
    expect((await d.list(role: 'teacher')).map((u) => u.id), [10]);
    expect(roleMatches('', 'guard'), isTrue);
    expect(roleMatches(execGroup, 'teacher'), isFalse);
  });

  test('SA-03 new staff member: the ticks are stored (unknown dropped); a teacher never '
      'carries ticks', () async {
    final (e, ob) = await seeded();
    final d = dir(e, ob);
    final w = await d.add(
      const UserDraft(
        name: 'کارمند دفتر',
        role: 'office',
        phone: '09120000077',
        access: ['notices', 'hack', 'leaves'],
        extra: {'personnel_code': '۱۲۳', 'employment': 'پیمانی'},
      ),
    );
    final row = (await e.get('users', w.id!))!.data;
    expect(row['access'], ['leaves', 'notices']);
    expect(row['employment'], 'پیمانی');
    final t = await d.add(
      const UserDraft(
        name: 'دبیر تازه',
        role: 'teacher',
        access: ['attendance'],
        teaches: [
          TeachDraft(subjectId: 41, subject: 'ریاضی', grade: 'دهم'),
          TeachDraft(subjectId: 41, subject: 'ریاضی', grade: 'دهم'),
          TeachDraft(subjectId: 42, subject: 'فیزیک', branch: 'الکترونیک'),
        ],
      ),
    );
    final tr = (await e.get('users', t.id!))!.data;
    expect(tr.containsKey('access'), isFalse);
    expect(
      (tr['teaches']! as List).length,
      2,
      reason: 'a duplicate is kept once',
    );
    expect(tr['subject'], 'ریاضی، فیزیک');
  });

  test('SA-04 new student: father and mother accounts made and linked; an existing parent '
      '(same mobile or national code) is re-used; NEG a parent mobile that is another '
      'user\'s username is refused before anything is written', () async {
    final (e, ob) = await seeded();
    final d = dir(e, ob);
    final w = await d.add(
      const UserDraft(
        name: 'کیان',
        role: 'student',
        grade: 'دهم',
        branch: 'الکترونیک',
        parentAccounts: {'father', 'mother'},
        extra: {
          'father_name': 'علی',
          'father_phone': '9124445566',
          'mother_name': 'سارا',
          'mother_nid': '0011111111',
        },
      ),
    );
    expect(w.messageFa, contains('حساب پدر ساخته شد'));
    expect(w.messageFa, contains('به حساب موجود مادر وصل شد'));
    final st = (await e.get('users', w.id!))!.data;
    expect(st['grade'], 'دهم');
    expect(st['field'], 'الکترونیک');
    final ops = ob.list();
    expect(ops.map((o) => o.collection), [
      'users',
      'users',
      'parent_links',
      'parent_links',
    ]);
    expect(ops[1].payload!['phone'], '09124445566');
    expect(ops[3].payload!['parent_id'], 40);
    expect(ops[3].payload!['relation'], 'mother');
    final before = ob.list().length;
    await expectLater(
      d.add(
        const UserDraft(
          name: 'نوید',
          role: 'student',
          parentAccounts: {'father'},
          extra: {'father_phone': '09120000040x'},
        ),
      ),
      completes,
      reason: 'the same mobile as an existing parent → linked, not refused',
    );
    await d.add(
      const UserDraft(
        name: 'مهتاب',
        role: 'student',
        parentAccounts: {'father'},
        extra: {'father_phone': '09120000040'},
      ),
    );
    expect(ob.list().length, before + 2 + 2);
  });

  test('SA-05 NEG a parent mobile that belongs to a teacher is refused; nothing queued', () async {
    final (e, ob) = await seeded();
    await e.put('users', 11, {
      'id': 11,
      'name': 'دبیر ۲',
      'role': 'teacher',
      'phone': '09125550000',
    }, version: 1);
    final d = dir(e, ob);
    await expectLater(
      d.add(
        const UserDraft(
          name: 'کیان',
          role: 'student',
          parentAccounts: {'father'},
          extra: {'father_phone': '09125550000'},
        ),
      ),
      throwsA(isA<RecordFailure>().having((f) => f.code, 'code', 'duplicate')),
    );
    expect(ob.list(), isEmpty);
  });

  test('SA-06 placement rules: defaults (auto on, both optional rules off); «تفکیک '
      'جنسیتی» is off in a boys\' or girls\' school', () {
    const d = PlaceRules();
    expect(d.toJson(), {
      'autoDistribute': true,
      'separateGender': false,
      'keepSiblings': false,
    });
    final saved = {'autoDistribute': false, 'separateGender': true};
    expect(PlaceRules.of(saved).separateGender, isTrue);
    expect(PlaceRules.of(saved, mixed: false).separateGender, isFalse);
    expect(PlaceRules.of(saved).autoDistribute, isFalse);
    expect(importMixedSchool('پسرانه'), isFalse);
    expect(importMixedSchool('مختلط'), isTrue);
    expect(importMixedSchool(null), isTrue);
  });
}
