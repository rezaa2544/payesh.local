// Row 197 — Q08 (F34) module-based assessment (هنرستان فنی‌وحرفه‌ای / کاردانش), Q09 (F35)
// descriptive assessment (ابتدایی), Q12 (F20/F24) «—» instead of 0, Q11 (F3) Excel decimals and
// the row 204 leftovers (field-based profile without «کلاس», name split on edit).
// Parity: server/grade-scheme.js (`gradeIssue`), client/pages.js (`gradeSchemeOf`,
// `moduleResultOf`, `avgOfGrades`), client/lib/xlsx.js (`numberText`).
import 'dart:math';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

Future<(SqliteEngine, SqliteOutbox)> seeded(Map<String, Object?> school) async {
  final e = SqliteEngine.inMemory();
  final ob = SqliteOutbox(e.database);
  Future<void> put(String c, int id, Map<String, Object?> d) =>
      e.put(c, id, {...d, 'id': id}, version: 1);
  await put('schools', 1, school);
  await put('classes', 5, {'name': 'دهم', 'grade': 'دهم'});
  await put('subjects', 41, {'name': 'ادبیات'});
  await put('subjects', 42, {'name': 'نقشه‌کشی فنی', 'workshop': true});
  await put('users', 21, {'name': 'بهار', 'role': 'student', 'class_id': 5});
  await put('users', 22, {'name': 'آرش', 'role': 'student', 'class_id': 5});
  return (e, ob);
}

GradeBook manager(SqliteEngine e, SqliteOutbox ob) =>
    GradeBook(engine: e, outbox: ob, role: 'manager', uid: 1);

Matcher refused(GradeError k) =>
    throwsA(isA<GradeFailure>().having((f) => f.kind, 'kind', k));

const vocational = {'level': 'متوسطه دوم', 'school_type': 'vocational'};
const primary = {'level': 'ابتدایی', 'school_type': 'governmental'};

void main() {
  group('scheme', () {
    test('S197-01 which scheme: ابتدایی descriptive, هنرستان workshop modular, explicit wins', () {
      expect(
        gradeSchemeOf(primary, {'workshop': true}),
        GradeScheme.descriptive,
      );
      expect(
        gradeSchemeOf(vocational, {'workshop': true}),
        GradeScheme.modular,
      );
      expect(
        gradeSchemeOf(vocational, {'workshop': false}),
        GradeScheme.numeric,
      );
      expect(
        gradeSchemeOf(vocational, {'workshop': true, 'modular': false}),
        GradeScheme.numeric,
      );
      expect(
        gradeSchemeOf({'school_type': 'governmental'}, {'modular': true}),
        GradeScheme.modular,
      );
      expect(
        gradeSchemeOf({'school_type': 'kardanesh'}, {'workshop': true}),
        GradeScheme.modular,
      );
    });

    test('S197-02 module score = competency × 5 + continuous; server rule mirrored', () {
      expect(moduleScore(2, 3.5), 13.5);
      expect(moduleScore(3, 0), 15);
      expect(moduleTerm(3), 'پودمان ۳');
      expect(moduleOfTerm('پودمان 4'), 4);
      expect(moduleOfTerm('نوبت اول'), isNull);
      Map<String, Object?> m([Map<String, Object?> x = const {}]) => {
        'kind': 'module',
        'term': 'پودمان ۱',
        'competency': 2,
        'continuous': 3.5,
        'score': 13.5,
        ...x,
      };
      expect(gradeRowIssue(m()), isNull);
      expect(gradeRowIssue(m({'score': 14})), 'bad_module');
      expect(gradeRowIssue(m({'competency': 4, 'score': 23.5})), 'bad_module');
      expect(
        gradeRowIssue(m({'continuous': 2.3, 'score': 12.3})),
        'bad_module',
      );
      expect(gradeRowIssue(m({'term': 'نوبت اول'})), 'bad_module');
      expect(
        gradeRowIssue({'kind': 'descriptive', 'level': 'خوب', 'score': null}),
        isNull,
      );
      expect(
        gradeRowIssue({'kind': 'descriptive', 'level': 'عالی'}),
        'bad_level',
      );
      expect(gradeRowIssue({'kind': 'midterm', 'score': 21}), 'bad_score');
      expect(descriptiveLevels, [
        'خیلی خوب',
        'خوب',
        'قابل قبول',
        'نیاز به تلاش بیشتر',
      ]);
    });

    test('S197-03 course result: pass 12 on all five, else «ناتمام»', () {
      final ok = ModuleResult(const [12, 15, 20, 13.5, 16]);
      expect(ok.passed, isTrue);
      expect(ok.average, 15.3);
      expect(ok.labelFa, 'قبول — ۱۵٫۳');
      final fail = ModuleResult(const [12, 10, 20, 13.5, 11.5]);
      expect(fail.failed, [2, 5]);
      expect(fail.average, isNull);
      expect(fail.labelFa, 'ناتمام (پودمان ۲، پودمان ۵)');
      final part = ModuleResult(const [12, null, 20, null, null]);
      expect(part.labelFa, 'در حال ارزشیابی (۲ از ۵ پودمان)');
    });
  });

  group('GradeBook', () {
    test(
      'S197-04 modular subject: «پودمان» terms only, module row written',
      () async {
        final (e, ob) = await seeded(vocational);
        final b = manager(e, ob);
        final subs = {for (final s in await b.subjects()) s.id: s};
        expect(subs[42]!.scheme, GradeScheme.modular);
        expect(subs[41]!.scheme, GradeScheme.numeric);
        expect(
          GradeTerm.of(GradeScheme.modular).map((t) => t.wire).first,
          'پودمان ۱',
        );
        await expectLater(
          b.save(
            classId: 5,
            subjectId: 42,
            term: GradeTerm.first,
            inputs: {21: '2'},
          ),
          refused(GradeError.wrongTerm),
        );
        await expectLater(
          b.save(
            classId: 5,
            subjectId: 41,
            term: GradeTerm.module1,
            inputs: {21: '18'},
          ),
          refused(GradeError.wrongTerm),
        );
        final w = await b.save(
          classId: 5,
          subjectId: 42,
          term: GradeTerm.module1,
          inputs: {21: '۲', 22: '1'},
          continuous: {21: '۳٫۵', 22: '5'},
        );
        expect(w.written, 2);
        final rows = [
          for (final r in await e.byRef('grades', 'class_id', 5)) r.data,
        ];
        final bahar = rows.firstWhere((r) => r['student_id'] == 21);
        expect(bahar['kind'], 'module');
        expect(bahar['term'], 'پودمان ۱');
        expect(bahar['competency'], 2);
        expect(bahar['continuous'], 3.5);
        expect(bahar['score'], 13.5);
        expect(gradeRowIssue(bahar), isNull);
        final sheet = await b.sheet(
          classId: 5,
          subjectId: 42,
          term: GradeTerm.module1,
        );
        expect(sheet.firstWhere((x) => x.studentId == 22).score, 10);
        // unchanged → nothing written
        final again = await b.save(
          classId: 5,
          subjectId: 42,
          term: GradeTerm.module1,
          inputs: {21: '2'},
          continuous: {21: '3.5'},
        );
        expect(again.written, 0);
        expect(again.unchanged, 1);
        final res = await b.moduleResults(classId: 5, subjectId: 42);
        expect(res[22]!.failed, [1]);
        expect(res[21]!.labelFa, 'در حال ارزشیابی (۱ از ۵ پودمان)');
      },
    );

    test('S197-05 bad module input refused before any write', () async {
      final (e, ob) = await seeded(vocational);
      final b = manager(e, ob);
      for (final (c, m) in [
        ('4', '1'),
        ('2', '5.5'),
        ('2', '2.3'),
        ('x', '1'),
      ]) {
        await expectLater(
          b.save(
            classId: 5,
            subjectId: 42,
            term: GradeTerm.module2,
            inputs: {21: '2', 22: c},
            continuous: {21: '3', 22: m},
          ),
          throwsA(isA<GradeFailure>()),
          reason: '$c/$m',
        );
      }
      expect(ob.list(), isEmpty);
    });

    test('S197-06 ابتدایی: descriptive level, no number', () async {
      final (e, ob) = await seeded(primary);
      final b = manager(e, ob);
      final subs = await b.subjects();
      expect(subs.every((s) => s.scheme == GradeScheme.descriptive), isTrue);
      final w = await b.save(
        classId: 5,
        subjectId: 41,
        term: GradeTerm.first,
        inputs: {21: 'قابل قبول'},
      );
      expect(w.written, 1);
      final row = (await e.byRef('grades', 'class_id', 5)).single.data;
      expect(row['kind'], 'descriptive');
      expect(row['level'], 'قابل قبول');
      expect(row['score'], isNull);
      expect(gradeValueText(row), 'قابل قبول');
      expect(averageScore(row), isNull);
      await expectLater(
        b.save(
          classId: 5,
          subjectId: 41,
          term: GradeTerm.first,
          inputs: {22: '18'},
        ),
        refused(GradeError.badLevel),
      );
    });
  });

  group('subjects', () {
    test(
      'S197-07 saveSubject(modular:) is stored and drives SubjectRow.scheme',
      () async {
        final (e, ob) = await seeded({
          'level': 'متوسطه دوم',
          'school_type': 'governmental',
        });
        final db = SchoolRecords(
          engine: e,
          outbox: ob,
          role: 'manager',
          uid: 1,
          random: Random(3),
        );
        final cb = ClassBook(db);
        var v = await cb.overview();
        expect(
          v.subjects.firstWhere((s) => s.id == 42).scheme,
          GradeScheme.numeric,
        );
        await cb.saveSubject(
          id: 42,
          name: 'نقشه‌کشی فنی',
          workshop: true,
          modular: true,
        );
        expect((await e.get('subjects', 42))!.data['modular'], isTrue);
        v = await cb.overview();
        expect(
          v.subjects.firstWhere((s) => s.id == 42).scheme,
          GradeScheme.modular,
        );
        // null = keep the stored choice
        await cb.saveSubject(id: 42, name: 'نقشه‌کشی', workshop: true);
        expect((await e.get('subjects', 42))!.data['modular'], isTrue);
      },
    );
  });

  group('«—» not 0 (F20/F24)', () {
    test('S197-08 averages skip empty, descriptive and module rows', () {
      expect(averageOf(const []), isNull);
      expect(averageOf([null, 18, 16]), 17);
      expect(averageScore({'kind': 'midterm', 'score': ''}), isNull);
      expect(averageScore({'kind': 'midterm', 'score': '17.5'}), 17.5);
      expect(averageScore({'kind': 'module', 'score': 13}), isNull);
      expect(gradeValueText({'kind': 'midterm', 'score': 17.5}), '۱۷٫۵');
      expect(gradeValueText({'kind': 'midterm'}), '—');
    });
  });

  group('F3 Excel decimals', () {
    test('S197-09 float noise read as written; mobiles recovered', () {
      expect(excelNumberText('91887514.390000001'), '91887514.39');
      expect(excelNumberText('9188751439.0000001'), '9188751439');
      expect(excelNumberText('9.188751439E9'), '9188751439');
      expect(excelNumberText('18.75'), '18.75');
      expect(excelNumberText('12'), '12');
      for (final v in [
        '91887514.390000001',
        '9188751439.0000001',
        '9.188751439E9',
        '09188751439',
      ]) {
        expect(importPickMobile(v).$1, '09188751439', reason: v);
      }
      expect(importPickMobile('18.75').$1, '');
    });
  });

  group('row 204 leftovers', () {
    test('S204-L1 field-based profile has no «کلاس»', () {
      bool hasClass(bool fb) => profileSections(
        'student',
        fieldBased: fb,
      ).any((s) => s.$2.any((f) => f.$1 == 'class_id'));
      expect(hasClass(false), isTrue);
      expect(hasClass(true), isFalse);
      expect(
        profileSections('student', fieldBased: true).expand((s) => s.$2).length,
        profileSections('student').expand((s) => s.$2).length - 1,
      );
    });

    test(
      'S204-L2 a renamed user gets first/last split, never a doubled surname',
      () async {
        final (e, ob) = await seeded(vocational);
        await e.put('users', 30, {
          'id': 30,
          'name': 'آرتین کریمی',
          'first_name': 'آرتین',
          'last_name': 'کریمی',
          'role': 'student',
          'phone': '09120000030',
        }, version: 1);
        final db = SchoolRecords(
          engine: e,
          outbox: ob,
          role: 'manager',
          uid: 1,
          random: Random(3),
        );
        await UserDirectory(db)
            .edit(30, name: 'آرتین رحمانی', phone: '09120000030', active: true);
        final u = (await e.get('users', 30))!.data;
        expect(u['first_name'], 'آرتین');
        expect(u['last_name'], 'رحمانی');
        expect(fullName(u), 'آرتین رحمانی');
      },
    );
  });
}
