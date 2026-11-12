// Row 128, wave W10 — bulk import and «نیازمند پیگیری», unit level (local SQLite + durable
// outbox, no network). Parity target: client/import.js (impAutoMap, impCheck, importApplyLocal,
// impSaveIssues), client/lib/xlsx.js, client/pages.js PAGES.followup and the followup-* /
// issue-* / issues-clear actions of client/app.js.
import 'dart:convert';
import 'dart:io' show ZLibEncoder;
import 'dart:math';
import 'dart:typed_data';

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
  await put('lookups', 1, {'kind': 'grade', 'name': 'دهم'});
  await put('lookups', 2, {'kind': 'branch', 'name': 'الکترونیک'});
  await put('lookups', 3, {'kind': 'grade', 'name': 'هفتم'});
  await put('classes', 5, {
    'name': 'دهم الکترونیک',
    'grade': 'دهم',
    'branch': 'الکترونیک',
    'kind': 'class',
  });
  await put('classes', 7, {'name': 'هفتم', 'grade': 'هفتم', 'kind': 'class'});
  await put('subjects', 41, {'name': 'ریاضی'});
  await put('users', 21, {
    'name': 'بهار رضایی',
    'role': 'student',
    'class_id': 5,
    'national_id': '1111111111',
  });
  await put('users', 22, {
    'name': 'آرش',
    'role': 'student',
    'class_id': null,
    'followup_reason': 'پایه در فایل نبود (رشته: الکترونیک)',
  });
  await put('users', 40, {
    'name': 'پدر بهار',
    'role': 'parent',
    'national_id': '2222222222',
    'phone': '09120000040',
  });
  return (e, ob);
}

SchoolRecords db(SqliteEngine e, SqliteOutbox ob, [String role = 'manager']) =>
    SchoolRecords(engine: e, outbox: ob, role: role, uid: 1, random: Random(5));

/// A minimal .xlsx (deflated parts, as Excel writes them).
Uint8List xlsxOf(Map<String, String> parts) {
  final out = BytesBuilder();
  final central = BytesBuilder();
  void u16(BytesBuilder b, int v) => b.add([v & 255, v >> 8 & 255]);
  void u32(BytesBuilder b, int v) =>
      b.add([v & 255, v >> 8 & 255, v >> 16 & 255, v >> 24 & 255]);
  var n = 0;
  for (final e in parts.entries) {
    final name = utf8.encode(e.key);
    final raw = utf8.encode(e.value);
    final comp = ZLibEncoder(raw: true).convert(raw);
    final off = out.length;
    u32(out, 0x04034b50);
    u16(out, 20);
    u16(out, 0);
    u16(out, 8);
    u32(out, 0);
    u32(out, 0);
    u32(out, comp.length);
    u32(out, raw.length);
    u16(out, name.length);
    u16(out, 0);
    out.add(name);
    out.add(comp);
    u32(central, 0x02014b50);
    u16(central, 20);
    u16(central, 20);
    u16(central, 0);
    u16(central, 8);
    u32(central, 0);
    u32(central, 0);
    u32(central, comp.length);
    u32(central, raw.length);
    u16(central, name.length);
    u16(central, 0);
    u16(central, 0);
    u16(central, 0);
    u16(central, 0);
    u32(central, 0);
    u32(central, off);
    central.add(name);
    n++;
  }
  final cdOff = out.length;
  final cd = central.toBytes();
  out.add(cd);
  u32(out, 0x06054b50);
  u16(out, 0);
  u16(out, 0);
  u16(out, n);
  u16(out, n);
  u32(out, cd.length);
  u32(out, cdOff);
  u16(out, 0);
  return out.toBytes();
}

ImportSession csvSession(
  String csv, {
  String kind = 'students',
  List<String> grades = const ['دهم'],
}) => ImportSession.fromBook(
  SheetReader.csv(csv),
  kind: kind,
  fileName: 'f.csv',
  grades: grades,
);

void main() {
  test('W10-U01 CSV: separator detected, quotes, BOM, CRLF', () {
    final b = SheetReader.csv(
      '\uFEFFنام;کد ملی\r\n"علی; رضا";"12""3"\r\nسارا;4\n',
    );
    expect(b.sheets.single.rows, [
      ['نام', 'کد ملی'],
      ['علی; رضا', '12"3'],
      ['سارا', '4'],
    ]);
    expect(SheetReader.csv('a\tb\n1\t2').sheets.single.rows.last, ['1', '2']);
    final bytes = Uint8List.fromList(utf8.encode('x,y\n1,2'));
    expect(SheetReader.read('a.csv', bytes).sheets.single.rows.first, [
      'x',
      'y',
    ]);
  });

  test('W10-U02 xlsx: shared strings, inline strings, numbers, gaps, sheet name', () {
    final x = xlsxOf({
      'xl/workbook.xml': '<workbook><sheets><sheet name="دانش‌آموزان" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>نام</t></si><si><t>کد ملی</t></si><si><r><t>علی </t></r><r><t>رضایی</t></r></si></sst>',
      'xl/worksheets/sheet1.xml':
          '<worksheet><sheetData>'
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
          '<row r="3"><c r="A3" t="s"><v>2</v></c><c r="C3"><v>9123456789</v></c>'
          '<c r="B3" t="inlineStr"><is><t>0012345678 &amp; x</t></is></c></row>'
          '</sheetData></worksheet>',
    });
    final b = SheetReader.read('file.xlsx', x);
    final s = b.firstWithRows!;
    expect(s.name, 'دانش‌آموزان');
    expect(s.rows, [
      ['نام', 'کد ملی'],
      <String>[],
      ['علی رضایی', '0012345678 & x', '9123456789'],
    ]);
    expect(SheetReader.colIndex('AB12'), 27);
    expect(
      () => SheetReader.xlsx(Uint8List.fromList([1, 2, 3, 4])),
      throwsA(isA<RecordFailure>()),
    );
  });

  test(
    'W10-U03 header row + column mapping: parents never map to the student',
    () {
      final s = csvSession(
        'گزارش مدرسه,,,,,,,\n'
        'ردیف,نام,نام خانوادگی,کد ملی,موبایل پدر,شماره تماس مادر,وضعیت حیات,وضعیت حیات,موبایل دانش آموز\n'
        '1,علی,رضایی,0012345678,9121111111,09122222222,زنده,فوت شده,09123333333\n',
      );
      expect(s.headerRow, 2);
      expect(s.map, [
        '',
        'first_name',
        'last_name',
        'national_id',
        'father_phone',
        'mother_phone',
        'father_alive',
        'mother_alive',
        'phone',
      ]);
      expect(s.rows.length, 1);
      expect(
        () => csvSession('نام\nعلی', grades: const []),
        throwsA(
          isA<RecordFailure>().having(
            (f) => f.messageFa,
            'msg',
            contains('پایه'),
          ),
        ),
      );
      expect(() => csvSession('\n,\n'), throwsA(isA<RecordFailure>()));
    },
  );

  test(
    'W10-U04 helpers: Jalali dates, Persian decimals, mobiles Excel broke',
    () {
      expect(importDate('۱۳۹۰/۵/۱۲'), '2011-08-03');
      expect(importDate('1403-12-30'), '2025-03-20');
      expect(importDate('2020-1-2'), '2020-01-02');
      expect(importDate('دیروز'), '');
      expect(importNumber('۱۲/۸۸'), 12.88);
      expect(importNumber('۱۲٫۵'), 12.5);
      expect(importNumber(''), isNull);
      expect(importPickMobile('9123456789'), ('09123456789', true));
      expect(importPickMobile('9.123456789E9'), ('09123456789', true));
      expect(importPickMobile('+98 912 345 6789'), ('09123456789', false));
      expect(importPickMobile('9181763116 - 9181763394').$1, '09181763116');
      expect(importMobileFix('پدر', '912345678').$1, isNull);
      expect(
        importMobileFix('پدر', '912345678').$2,
        contains('یک رقم کم دارد'),
      );
      expect(importGradeCanon('یازدهم شبکه', const []), 'یازدهم');
      expect(importGradeCanon('کلاس 10', const []), 'دهم');
      expect(importBranchCanon('رشته الکترونیگ', const ['الکترونیک']), (
        'الکترونیگ',
        false,
        'الکترونیک',
      ));
      expect(importLev('abc', 'abd'), 1);
      expect(importValidNid('۰۰۱۲۳۴۵۶۷۸'), isTrue);
    },
  );

  test(
    'W10-U05 check: national id rules, duplicates, owners, mobile blocks',
    () async {
      final (e, ob) = await seeded();
      final s = csvSession(
        'نام و نام خانوادگی,کد ملی,موبایل,موبایل پدر,کد ملی پدر,رشته\n'
        'سینا کاظمی,0012345678,09125555555,912345678,,الکترونیک\n'
        'نوید کاظمی,0012345678,,,,الکترونیک\n'
        'کوتاه,12345,,,,الکترونیک\n'
        'بهار رضایی,1111111111,,,,الکترونیک\n'
        'ولی اشتباه,2222222222,,,,الکترونیک\n'
        'تینا,,09120000040,,123,الکترونیک\n',
      );
      final r = await SchoolImport(db(e, ob)).check(s);
      expect(r.rows.length, 6);
      final [a, b, c, d, p, t] = r.rows;
      expect(a.needsFix, isTrue);
      expect(a.blocks.single, contains('یک رقم کم دارد'));
      expect(a.data['class_id'], 5);
      expect(b.errors.single, contains('تکراری'));
      expect(b.errors.single, contains('سطر ۲'));
      expect(c.errors.single, contains('۵ رقم'));
      expect(d.ready, isTrue);
      expect(d.data['existing_id'], 21);
      expect(d.warns, contains('قبلاً ثبت شده — به‌روزرسانی می‌شود'));
      expect(p.errors.single, contains('نقش ولی'));
      expect(t.errors.single, contains('هر شماره یک حساب دارد'));
      expect(t.blocks.single, contains('کد ملی پدر'));
      expect(t.warns, contains('بدون کد ملی'));
      expect(r.ready.length, 1);
      expect(r.badCount, 4);
      expect(r.followCount, 5);
      expect(r.updates, 1);
    },
  );

  test('W10-U06 a branch that only looks like a defined one is asked, never merged', () async {
    final (e, ob) = await seeded();
    final s = csvSession('نام,رشته\nعلی رضایی,الکترونیگ\nسارا نوری,کامپیوتر\n');
    final x = SchoolImport(db(e, ob));
    var r = await x.check(s);
    expect(r.branchAsk, [('الکترونیگ', 'الکترونیک')]);
    expect(r.rows.first.warns.join(), contains('شبیه «الکترونیک»'));
    expect(
      r.rows.last.warns,
      contains('رشتهٔ «کامپیوتر» به فهرست رشته‌ها اضافه می‌شود'),
    );
    s.branchAsk['الکترونیگ'] = 'الکترونیک';
    r = await x.check(s);
    expect(r.branchAsk, isEmpty);
    expect(r.branchFixes, [('الکترونیگ', 'الکترونیک')]);
    expect(r.rows.first.data['field'], 'الکترونیک');
    expect(r.rows.first.data['class_id'], 5);
    s.branchAsk['الکترونیگ'] = '';
    r = await x.check(s);
    expect(r.branchAsk, isEmpty);
    expect(r.rows.first.data['field'], 'الکترونیگ');
    expect(r.rows.first.data['new_branch'], 'الکترونیگ');
  });

  test('W10-U07 grades: file scope, class mode creates the class, field mode never', () async {
    final (e, ob) = await seeded();
    final x = SchoolImport(db(e, ob));
    final s = csvSession(
      'نام,پایه,رشته\nعلی رضایی,هشتم,\nسارا نوری,,\nمینا رحیمی,یازدهم,شبکه\n',
      grades: const ['هشتم', 'یازدهم'],
    );
    final r = await x.check(s);
    expect(r.newClasses, ['هشتم']);
    expect(r.rows[0].data['new_class'], 'هشتم');
    expect(r.rows[1].warns, contains('بدون کلاس'));
    expect(r.rows[2].data['class_id'], isNull);
    expect(r.rows[2].data['new_grade'], 'یازدهم');
    final one = csvSession('نام\nعلی رضایی\n', grades: const ['هفتم']);
    final r1 = await x.check(one);
    expect(r1.rows.single.data['class_id'], 7);
  });

  test('W10-U08 apply students: users, parents (re-used), links, class, update, follow-up', () async {
    final (e, ob) = await seeded();
    final x = SchoolImport(db(e, ob));
    final s = csvSession(
      'نام,کد ملی,موبایل,نام پدر,کد ملی پدر,موبایل مادر,پایه,رشته,معدل,تاریخ تولد\n'
      'علی رضایی,0012345678,9121234567,حسن,2222222222,09127777777,هشتم,,۱۸/۵,۱۳۹۰/۵/۱۲\n'
      'بهار رضایی,1111111111,,,,,دهم,الکترونیک,,\n'
      'سارا نوری,,,,,,یازدهم,شبکه,,\n'
      'بد,1,,,,,دهم,,,\n',
      grades: const ['هشتم', 'دهم', 'یازدهم'],
    );
    final r = await x.check(s);
    expect(r.ready.length, 3);
    final res = await x.apply(s, r);
    expect(res.students, 2);
    expect(res.updated, 1);
    expect(
      res.parents,
      1,
    ); // the father exists (national id), the mother is new
    expect(res.classes, 1);
    expect(res.savedIssues, 2); // «سارا» has no national id, «بد» was refused
    expect(res.openIssues, 2);
    expect(res.summaryFa, contains('۲ کاربر ثبت شد'));
    final users = await e.list('users');
    final ali = users.firstWhere((u) => u.data['name'] == 'علی رضایی');
    expect(ali.data['phone'], '09121234567');
    expect(ali.data['last_gpa'], 18.5);
    expect(ali.data['birth_date'], '2011-08-03');
    final cls = (await e.list('classes'))
        .firstWhere((c) => c.data['name'] == 'هشتم');
    expect(ali.data['class_id'], cls.id);
    final links = await e.list('parent_links');
    expect(
      links.map((l) => (l.data['parent_id'] == 40, l.data['relation'])).toSet(),
      {(true, 'پدر'), (false, 'مادر')},
    );
    final sara = users.firstWhere((u) => u.data['name'] == 'سارا نوری');
    expect(sara.data['class_id'], isNull);
    expect(sara.data['field'], 'شبکه');
    final defs = (await e.list('lookups')).map((l) => l.data['name']).toSet();
    expect(defs, containsAll(['هشتم', 'یازدهم', 'شبکه']));
    final bahar = await e.get('users', 21);
    expect(bahar!.data['field'], 'الکترونیک');
    expect(bahar.data['class_id'], 5);
    final issues = await e.list('import_issues');
    expect(issues.map((i) => i.data['name']).toSet(), {'سارا نوری', 'بد'});
    expect(ob.stats().total, res.keys.length);
    // the same file again: open issues are not saved twice, existing students are updates
    final r2 = await x.check(s);
    final res2 = await x.apply(s, r2);
    expect(res2.savedIssues, 0);
    expect(res2.updated, 2);
  });

  test(
    'W10-U09 apply is all-or-nothing for the queue; teachers/role refused',
    () async {
      final (e, ob) = await seeded(config: const OutboxConfig(capacity: 1));
      final x = SchoolImport(db(e, ob));
      final s = csvSession(
        'نام,کد ملی\nعلی رضایی,0012345678\nسارا نوری,0012345679\n',
      );
      final r = await x.check(s);
      await expectLater(x.apply(s, r), throwsA(isA<SyncFailure>()));
      expect(ob.stats().total, 0);
      expect((await e.list('users')).length, 3);
      final t = SchoolImport(db(e, ob, 'teacher'));
      await expectLater(
        t.check(s),
        throwsA(
          isA<RecordFailure>().having((f) => f.code, 'code', 'not_allowed'),
        ),
      );
      final bad = csvSession('نام,کد ملی\nع,1\n');
      await expectLater(
        x.apply(bad, await x.check(bad)),
        throwsA(
          isA<RecordFailure>().having(
            (f) => f.messageFa,
            'm',
            contains('سطر سالمی'),
          ),
        ),
      );
    },
  );

  test('W10-U10 grades and attendance find the student and subject (deterministic ids)', () async {
    final (e, ob) = await seeded();
    final x = SchoolImport(db(e, ob));
    final g = csvSession(
      'نام,کد ملی,درس,نمره,نوبت\n'
      ',1111111111,ریاضی,۱۸/۲۵,دوم\n'
      'بهار رضایی,,ریاضیات,17,اول\n'
      'ناشناس,,ریاضی,12,\n'
      ',1111111111,شیمی,25,سوم\n',
      kind: 'grades',
      grades: const [],
    );
    final rg = await x.check(g);
    expect(rg.rows[0].data['score'], 18.25);
    expect(rg.rows[0].data['term'], 'نوبت دوم');
    expect(rg.rows[1].data['subject_id'], 41);
    expect(rg.rows[2].errors.single, contains('پیدا نشد'));
    expect(rg.rows[3].errors.length, 2);
    expect(rg.rows[3].warns.join(), contains('نوبت'));
    final res = await x.apply(g, rg);
    expect(res.marks, 2);
    final id = GradeBook.recordId(
      classId: 5,
      subjectId: 41,
      term: GradeTerm.second,
      studentId: 21,
    );
    expect((await e.get('grades', id))!.data['score'], 18.25);
    final a = csvSession(
      'نام,تاریخ,وضعیت\nبهار رضایی,۱۴۰۵/۸/۲۰,غایب\nبهار رضایی,,حاضر\nبهار رضایی,1405/8/21,خواب\n',
      kind: 'attendance',
      grades: const [],
    );
    final ra = await x.check(a);
    expect(ra.rows[0].ready, isTrue);
    expect(ra.rows[1].errors.single, contains('تاریخ الزامی'));
    expect(ra.rows[2].errors.single, contains('شناخته نمی‌شود'));
    await x.apply(a, ra);
    final aid = AttendanceBook.recordId(21, '2026-11-11');
    expect((await e.get('attendance', aid))!.data['status'], 'absent');
  });

  test('W10-U11 in-place fix: corrected values make the row ready; teachers update', () async {
    final (e, ob) = await seeded();
    final x = SchoolImport(db(e, ob));
    final s = csvSession('نام,کد ملی,موبایل پدر\nعلی رضایی,00123,912345678\n');
    var r = await x.check(s);
    final row = r.rows.single;
    expect(row.bad, isTrue);
    expect(s.fixValue(row, 'father_phone'), '0912345678');
    expect(
      importFixFields['students']!.map((f) => f.$1),
      contains('father_phone'),
    );
    s.fix(row.idx, {
      'national_id': '0012345678',
      'father_phone': '09123456789',
    });
    r = await x.check(s);
    expect(r.rows.single.ready, isTrue);
    s.fix(row.idx, {'father_phone': ''});
    r = await x.check(s);
    expect(r.rows.single.data.containsKey('father_phone'), isFalse);
    final t = csvSession(
      'نام و نام خانوادگی,کد ملی,موبایل,درس تخصصی\nبهار رضایی,1111111111,09121110000,ریاضی\nدبیر نو,0012340000,,فیزیک\n',
      kind: 'teachers',
      grades: const [],
    );
    final rt = await x.check(t);
    expect(rt.rows.first.data['existing_id'], 21);
    final res = await x.apply(t, rt);
    expect(res.staff, 1);
    expect(res.updated, 1);
    final nu = (await e.list('users'))
        .firstWhere((u) => u.data['name'] == 'دبیر نو');
    expect(nu.data['role'], 'teacher');
    expect(nu.data['subject'], 'فیزیک');
  });

  test('W10-U12 follow-up: reasons, assign (field/class mode), ack, issues done/clear', () async {
    final (e, ob) = await seeded();
    await e.put('users', 23, {
      'id': 23,
      'name': 'ثمین',
      'role': 'student',
      'class_id': 99,
      'followup_ack': true,
    }, version: 1);
    await e.put('classes', 8, {
      'id': 8,
      'name': 'قدیمی',
      'grade': 'نهم',
    }, version: 1);
    await e.put('users', 24, {
      'id': 24,
      'name': 'پویا',
      'role': 'student',
      'class_id': 8,
    }, version: 1);
    await e.put('import_issues', 60, {
      'id': 60,
      'name': 'بهار رضایی',
      'national_id': '1111111111',
      'reasons': ['بدون شماره'],
      'data': {'full_name': 'بهار رضایی'},
      'status': 'open',
    }, version: 1);
    await e.put('import_issues', 61, {
      'id': 61,
      'name': 'نیامده',
      'status': 'open',
    }, version: 1);
    final f = Followup(db(e, ob));
    var v = await f.view();
    expect(v.students.map((s) => (s.name, s.reason)), [
      ('آرش', 'پایه در فایل نبود (رشته: الکترونیک)'),
      ('پویا', 'پایه‌اش تعریف نشده («نهم»)'),
    ]);
    expect(v.students.first.branch, 'الکترونیک');
    expect(v.grades, ['دهم', 'هفتم']);
    expect(v.issues.map((i) => (i.name, i.userId)), [
      ('بهار رضایی', 21),
      ('نیامده', null),
    ]);
    expect(v.total, 4);
    await expectLater(
      f.assign(22, grade: ''),
      throwsA(
        isA<RecordFailure>().having((x) => x.messageFa, 'm', contains('پایه')),
      ),
    );
    var w = await f.assign(22, grade: 'دهم', branch: 'شبکه');
    expect(w.messageFa, 'پایه و رشته ثبت شد — دهم شبکه');
    final arash = await e.get('users', 22);
    expect(arash!.data['grade'], 'دهم');
    expect(arash.data.containsKey('followup_reason'), isFalse);
    expect(
      (await e.list('lookups')).any((l) => l.data['name'] == 'شبکه'),
      isTrue,
    );
    w = await f.assign(24, grade: 'هفتم');
    expect(w.messageFa, 'در «هفتم» ثبت شد');
    expect((await e.get('users', 24))!.data['class_id'], 7);
    w = await f.assign(24, grade: 'هشتم');
    final c8 = (await e.list('classes'))
        .firstWhere((c) => c.data['name'] == 'هشتم');
    expect((await e.get('users', 24))!.data['class_id'], c8.id);
    await f.ack(24);
    expect((await e.get('users', 24))!.data['followup_ack'], isTrue);
    await f.issueDone(60);
    expect((await e.get('import_issues', 60))!.data['status'], 'done');
    w = await f.issuesClear();
    expect(w.messageFa, '۱ ردیف حل‌شده شد');
    v = await f.view();
    expect(v.total, 0);
    expect((await f.issuesClear()).queued, isFalse);
    await expectLater(
      Followup(db(e, ob, 'teacher')).view(),
      throwsA(
        isA<RecordFailure>().having((x) => x.code, 'code', 'not_allowed'),
      ),
    );
  });
}
