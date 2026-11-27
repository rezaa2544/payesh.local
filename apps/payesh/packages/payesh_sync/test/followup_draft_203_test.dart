// Row 203 — «نام» and «نام خانوادگی» apart (never «آرتین رحمانی» + «رحمانی»), the whole
// profile (پایه، رشته، …) in every detail list, follow-up fixes kept as they are typed and
// «ثبت موقت در لیست».
import 'dart:math';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

String nid(int n) {
  final d = n.toString().padLeft(9, '0').split('').map(int.parse).toList();
  var s = 0;
  for (var i = 0; i < 9; i++) {
    s += d[i] * (10 - i);
  }
  final r = s % 11;
  return '${d.join()}${r < 2 ? r : 11 - r}';
}

Future<SchoolRecords> school() async {
  final e = SqliteEngine.inMemory();
  final ob = SqliteOutbox(e.database);
  await e.put('lookups', 1, {
    'id': 1,
    'kind': 'grade',
    'name': 'دهم',
  }, version: 1);
  await e.put('lookups', 2, {
    'id': 2,
    'kind': 'branch',
    'name': 'معماری',
  }, version: 1);
  await e.put('classes', 5, {
    'id': 5,
    'name': 'دهم معماری',
    'grade': 'دهم',
    'branch': 'معماری',
  }, version: 1);
  return SchoolRecords(
    engine: e,
    outbox: ob,
    role: 'manager',
    uid: 1,
    random: Random(7),
  );
}

void main() {
  test('S203-01 splitName: the last name is never left in «نام»', () {
    ({String first, String last}) sp(Map<String, Object?> m) => splitName(m);
    expect(sp({'name': 'آرتین رحمانی', 'last_name': 'رحمانی'}), (
      first: 'آرتین',
      last: 'رحمانی',
    ));
    expect(
      sp({
        'name': 'محمد مهدی  رحمانی',
        'first_name': 'محمد مهدی',
        'last_name': 'رحمانی',
      }),
      (first: 'محمد مهدی', last: 'رحمانی'),
    );
    expect(sp({'name': 'علی حسین زاده'}), (first: 'علی', last: 'حسین زاده'));
    expect(sp({'name': 'سارا محمدی'}), (first: 'سارا', last: 'محمدی'));
    expect(sp({'name': 'رضا'}), (first: 'رضا', last: ''));
    // an old row whose «نام» does not hold the last name
    expect(sp({'name': 'آرسام', 'last_name': 'سعیدی'}), (
      first: 'آرسام',
      last: 'سعیدی',
    ));
    expect(joinName(' آرتین ', 'رحمانی'), 'آرتین رحمانی');
  });

  test(
    'S203-02 saveFull: first + last make the name; پایه/رشته/کلاس are kept',
    () async {
      final db = await school();
      await db.engine.put('users', 21, {
        'id': 21,
        'name': 'آرتین رحمانی',
        'first_name': 'آرتین',
        'last_name': 'رحمانی',
        'role': 'student',
        'father_edu': 'دیپلم',
        'x_hobby': 'فوتبال',
        'followup_reason': 'نباید دیده شود',
      }, version: 1);
      final w = await UserDirectory(db).saveFull(21, {
        'first_name': 'آرتین',
        'last_name': 'رحمانی‌پور',
        'grade': 'دهم',
        'field': 'معماری',
        'class_id': '5',
      });
      expect(w.id ?? 21, 21);
      final row = (await db.engine.get('users', 21))!.data;
      expect(row['name'], 'آرتین رحمانی‌پور');
      expect(row['first_name'], 'آرتین');
      expect(row['last_name'], 'رحمانی‌پور');
      expect(row['grade'], 'دهم');
      expect(row['field'], 'معماری');
      expect(row['class_id'], 5);
      final rows = UserDirectory.detailRows(row);
      expect(rows, contains(('پایه', 'دهم')));
      expect(rows, contains(('رشته', 'معماری')));
      expect(rows, contains(('تحصیلات پدر', 'دیپلم')));
      expect(rows, contains(('x_hobby', 'فوتبال')));
      expect(rows.any((r) => r.$2 == 'نباید دیده شود'), isFalse);
      // the student sections name every import field of a student
      final keys = {
        for (final (_, l) in profileSections('student'))
          for (final (k, _, _) in l) k,
      };
      for (final k in const [
        'grade',
        'field',
        'father_job',
        'mother_alive',
        'guardian',
        'guardian_alive',
        'residence',
        'village',
        'residence_status',
        'shenasname_serial',
        'org_percent',
        'sisters',
      ]) {
        expect(keys, contains(k));
      }
      // a rename by «name» alone drops a stale first / last name
      await UserDirectory(db).saveFull(21, {'first_name': 'آرین'});
      expect(
        (await db.engine.get('users', 21))!.data['name'],
        'آرین رحمانی‌پور',
      );
    },
  );

  test(
    'S203-03 a national id whose leading zero Excel dropped is put back',
    () async {
      expect(nidRestoreZeros('441659330'), '0441659330');
      expect(nidChecksumOk('0441659330'), isTrue);
      expect(nidRestoreZeros('441659331'), '');
      expect(nidRestoreZeros('12345'), '');
      final db = await school();
      final s = ImportSession.fromBook(
        SheetReader.csv(
          'نام,نام خانوادگی,کد ملی\n'
          'آرتین,رحمانی,441659330\n',
        ),
        kind: 'students',
        fileName: 'z.xlsx',
        grades: const ['دهم'],
      );
      final r = await SchoolImport(db).check(s);
      final row = r.rows.single;
      expect(row.problems, isEmpty);
      expect(row.data['national_id'], '0441659330');
    },
  );

  test(
    'S203-04 saveDraft keeps the fixed fields; the rest stay on the row',
    () async {
      final db = await school();
      final s = ImportSession.fromBook(
        SheetReader.csv(
          'نام و نام خانوادگی,کد ملی,کد ملی پدر,کد ملی مادر\n'
          'آرسین مولایی,${nid(77)},38409918467,28409918467\n'
          'سالم سالمی,${nid(78)},${nid(79)},${nid(80)}\n',
        ),
        kind: 'students',
        fileName: 'f.xlsx',
        grades: const ['دهم'],
      );
      final r = await SchoolImport(db).check(s);
      await SchoolImport(db).apply(s, r);
      ImportIssue one(FollowupView v) =>
          v.issues.singleWhere((x) => x.name == 'آرسین مولایی');
      var i = one(await Followup(db).view());
      expect(i.fields.keys.toSet(), {'father_nid', 'mother_nid'});
      final before = i.reasons.length;
      // the father's id is fixed, the mother's is typed wrong again
      await Followup(db)
          .saveDraft(i.id, {'father_nid': nid(501), 'mother_nid': '123'});
      i = one(await Followup(db).view());
      expect(i.fields.keys, ['mother_nid']);
      expect(i.reasons.length, lessThan(before));
      expect(i.draft['father_nid'], nid(501));
      expect(i.draft['mother_nid'], '123');
      // the next save adds to the draft — the first fix is not lost
      await Followup(db).saveDraft(i.id, {'mother_nid': nid(502)});
      i = one(await Followup(db).view());
      expect(i.fields, isEmpty);
      expect(i.draft['father_nid'], nid(501));
      expect(i.draft['mother_nid'], nid(502));
      // nothing new ⇒ nothing written
      final w = await Followup(db).saveDraft(i.id, {'mother_nid': nid(502)});
      expect(w.messageFa, 'تغییری نبود');
      // «ثبت موقت»: the row stays on the list, now with its user
      final (t, _) = await UserDirectory(db)
          .addTemporary(const UserDraft(name: 'آرسین مولایی', classId: 5));
      await Followup(db).saveDraft(i.id, const {}, tempUserId: t.id);
      i = one(await Followup(db).view());
      expect(i.tempUserId, t.id);
      expect(i.userId, t.id);
    },
  );

  test(
    'S203-05 ثبت موقت: the user is made with its right values only',
    () async {
      final db = await school();
      await db.engine.put('users', 30, {
        'id': 30,
        'name': 'مریم احمدی',
        'role': 'student',
        'phone': '09120000030',
      }, version: 1);
      final (w, dropped) = await UserDirectory(db).addTemporary(
        const UserDraft(
          name: 'آرتین رحمانی',
          classId: 5,
          nationalId: '1234567890',
          phone: '09120000030',
          extra: {'father_nid': '999', 'father_name': 'رضا رحمانی'},
        ),
      );
      expect(w.messageFa, startsWith('ثبت موقت شد'));
      expect(dropped.toSet(), {'national_id', 'phone', 'father_nid'});
      final row = (await db.engine.get('users', w.id!))!.data;
      expect(row['class_id'], 5);
      expect(row['father_name'], 'رضا رحمانی');
      expect(SchoolRecords.str(row['national_id']), '');
      expect(SchoolRecords.str(row['phone']), '');
    },
  );
}
