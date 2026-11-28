// Row 205 — a student given پایه + رشته on «نیازمند پیگیری» never comes back: the reason is
// emptied (a dropped key survived the LAN server's merge and came back with the next pull),
// a stale «… حذف شد» reason does not keep a complete student, and a field school's reason
// never says «کلاس».
import 'dart:math';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

Future<SchoolRecords> school({bool field = true}) async {
  final e = SqliteEngine.inMemory();
  final ob = SqliteOutbox(e.database);
  var id = 0;
  Future<void> put(String c, Map<String, Object?> d) =>
      e.put(c, ++id, {'id': id, ...d}, version: 1);
  await e.put('schools', 1, {
    'id': 1,
    'name': 'کاردانش آینده سازان',
    'level': field ? 'متوسطه دوم' : 'ابتدایی',
  }, version: 1);
  await put('lookups', {'kind': 'grade', 'name': 'دوازدهم'});
  await put('lookups', {'kind': 'branch', 'name': 'الکتروتکنیک'});
  await e.put('users', 30, {
    'id': 30,
    'name': 'کاندیش احمدی',
    'role': 'student',
    'grade': 'دوازدهم',
    'field': 'حسابداری',
    'followup_reason': 'رشتهٔ «حسابداری» حذف شد — کلاس تازه انتخاب کنید',
  }, version: 1);
  return SchoolRecords(
    engine: e,
    outbox: ob,
    role: 'manager',
    uid: 1,
    random: Random(5),
  );
}

void main() {
  test(
    'S205-01 assign empties the reason on the row sent (never drops the key)',
    () async {
      final db = await school();
      final before = await Followup(db).view();
      expect(before.students.map((s) => s.id), [30]);
      // a field school: «پایه و رشته», never «کلاس»
      expect(before.students.single.reason, contains('حسابداری'));
      expect(before.students.single.reason, isNot(contains('کلاس')));
      // the grade he has opens chosen; the deleted field does not
      expect(before.students.single.grade, 'دوازدهم');
      expect(before.students.single.branch, isNot('حسابداری'));
      await Followup(db).assign(30, grade: 'دوازدهم', branch: 'الکتروتکنیک');
      final sent = db.outbox.list().lastWhere(
        (o) => o.collection == 'users' && o.id == 30,
      );
      expect(sent.payload!.containsKey('followup_reason'), isTrue);
      expect(sent.payload!['followup_reason'], '');
      expect((await Followup(db).view()).students, isEmpty);
    },
  );

  test('S205-02 the server still had the old reason (older app): the student with a '
      'defined grade and field is not listed again after the pull', () async {
    final db = await school();
    // what a pull brings back from a server that merged a put without the key
    await db.engine.put('users', 30, {
      'id': 30,
      'name': 'کاندیش احمدی',
      'role': 'student',
      'grade': 'دوازدهم',
      'field': 'الکتروتکنیک',
      'followup_ack': false,
      'followup_reason': 'رشتهٔ «حسابداری» حذف شد — کلاس تازه انتخاب کنید',
    }, version: 3);
    expect((await Followup(db).view()).students, isEmpty);
  });

  test(
    'S205-03 reasonOf: a stale place reason goes, a reason of its own stays',
    () {
      const grades = ['دوازدهم'], branches = ['الکتروتکنیک'];
      String why(Map<String, Object?> u) => Followup.reasonOf(
        {'role': 'student', ...u},
        const {},
        grades,
        branches,
      );
      const stale = 'رشتهٔ «حسابداری» حذف شد — کلاس تازه انتخاب کنید';
      expect(
        why({
          'grade': 'دوازدهم',
          'field': 'الکتروتکنیک',
          'followup_reason': stale,
        }),
        '',
      );
      expect(
        why({
          'grade': 'پایه دوازدهم',
          'field': 'الکتروتکنیک',
          'followup_reason': stale,
        }),
        '',
      );
      // the field is still the deleted one ⇒ stays
      expect(
        why({
          'grade': 'دوازدهم',
          'field': 'حسابداری',
          'followup_reason': stale,
        }),
        stale,
      );
      // no grade ⇒ stays
      expect(why({'field': 'الکتروتکنیک', 'followup_reason': stale}), stale);
      // a reason that is not about the place stays
      const phone = 'شمارهٔ همراه تکراری بود — با کد ملی وارد می‌شود';
      expect(
        why({
          'grade': 'دوازدهم',
          'field': 'الکتروتکنیک',
          'followup_reason': phone,
        }),
        phone,
      );
      // an emptied reason = none
      expect(
        why({
          'grade': 'دوازدهم',
          'field': 'الکتروتکنیک',
          'followup_reason': '',
        }),
        '',
      );
    },
  );

  test('S205-04 a class school keeps its «کلاس» wording', () async {
    final db = await school(field: false);
    final v = await Followup(db).view();
    expect(v.students.single.reason, contains('کلاس'));
  });
}
