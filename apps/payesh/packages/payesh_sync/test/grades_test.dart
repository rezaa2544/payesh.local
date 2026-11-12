// Row 74, wave 3 — native grade entry, unit level (local database + durable outbox, no network).
// Parity target: client/pages.js `PAGES.grades` + `actGradeSave`; server/policy.js
// `GRADE_KINDS` + «تأیید نمره فقط با مدیر است»; server/scope.js `approval_denied`.
import 'package:payesh_core/payesh_core.dart';
import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

const t1 = GradeTerm.first;

Future<(SqliteEngine, SqliteOutbox)> seeded({
  OutboxConfig config = const OutboxConfig(),
}) async {
  final e = SqliteEngine.inMemory();
  final ob = SqliteOutbox(e.database, config: config);
  Future<void> put(String c, int id, Map<String, Object?> d, [int v = 1]) =>
      e.put(c, id, {...d, 'id': id}, version: v);
  await put('classes', 5, {'name': 'دهم الف'});
  await put('classes', 6, {'name': 'یازدهم ب'});
  await put('users', 10, {'name': 'معلم', 'role': 'teacher'});
  await put('schedule', 900, {
    'teacher_id': 10,
    'class_id': 5,
    'subject_id': 41,
    'bell': 1,
  });
  await put('subjects', 40, {'name': 'ادبیات'});
  await put('subjects', 41, {'name': 'ریاضی'});
  await put('subjects', 42, {'name': 'کارگاه برق', 'workshop': true});
  await put('users', 21, {'name': 'بهار', 'role': 'student', 'class_id': 5});
  await put('users', 22, {'name': 'آرش', 'role': 'student', 'class_id': 5});
  await put('users', 24, {
    'name': 'غیرفعال',
    'role': 'student',
    'class_id': 5,
    'active': false,
  });
  await put('users', 25, {'name': 'والد', 'role': 'parent', 'class_id': 5});
  await put('users', 31, {'name': 'کیان', 'role': 'student', 'class_id': 6});
  return (e, ob);
}

GradeBook teacher(SqliteEngine e, SqliteOutbox ob) =>
    GradeBook(engine: e, outbox: ob, role: 'teacher', uid: 10);

GradeBook manager(SqliteEngine e, SqliteOutbox ob) =>
    GradeBook(engine: e, outbox: ob, role: 'manager', uid: 1);

Matcher refused(GradeError k) =>
    throwsA(isA<GradeFailure>().having((f) => f.kind, 'kind', k));

void main() {
  test('W3-U01 terms and review labels are exactly the web set', () {
    expect(GradeTerm.values.map((t) => t.wire), [
      'نوبت اول',
      'نوبت دوم',
      'پایانی',
    ]);
    expect(GradeState.values.map((s) => s.labelFa), [
      'جدید',
      'در انتظار',
      'تأییدشده',
    ]);
    expect(GradeTerm.fromWire('پایانی'), GradeTerm.finalTerm);
    for (final v in ['نوبت سوم', '', null, 1]) {
      expect(GradeTerm.fromWire(v), isNull, reason: '$v');
    }
  });

  test('W3-U02 score parsing: Persian digits, decimals, empty = skip', () {
    expect(GradeBook.parseScore('۱۷'), 17);
    expect(GradeBook.parseScore('١٨'), 18);
    expect(GradeBook.parseScore(' 15.5 '), 15.5);
    expect(GradeBook.parseScore('۱۹٫۲۵'), 19.25);
    expect(GradeBook.parseScore('0'), 0);
    expect(GradeBook.parseScore('20'), 20);
    expect(GradeBook.parseScore('20'), isA<int>());
    expect(GradeBook.parseScore(''), isNull);
    expect(GradeBook.parseScore('   '), isNull);
  });

  test('W3-U03 NEG out-of-range or non-decimal scores are refused', () {
    for (final s in [
      '21',
      '20.5',
      '-1',
      'abc',
      '0x10',
      '1e1',
      '15,5',
      '۱۵/۵',
      'NaN',
      '15.',
    ]) {
      expect(
        () => GradeBook.parseScore(s, studentId: 21),
        throwsA(
          isA<GradeFailure>()
              .having((f) => f.kind, 'kind', GradeError.badScore)
              .having((f) => f.detail, 'detail', 21),
        ),
        reason: s,
      );
    }
  });

  test('W3-U04 record id: deterministic, per (class, subject, term, student), '
      'reserved range below 2^53', () {
    int id({int c = 5, int s = 41, GradeTerm t = t1, int st = 21}) =>
        GradeBook.recordId(classId: c, subjectId: s, term: t, studentId: st);
    final a = id();
    expect(id(), a);
    expect({
      id(c: 6),
      id(s: 40),
      id(t: GradeTerm.second),
      id(st: 22),
    }, isNot(contains(a)));
    final seen = <int>{};
    for (var st = 1; st <= 2000; st++) {
      final v = id(st: st);
      expect(v, greaterThanOrEqualTo(GradeBook.idBase));
      expect(v, lessThan(GradeBook.idBase + GradeBook.idSpan));
      seen.add(v);
    }
    expect(seen.length, 2000);
    expect(GradeBook.idBase + GradeBook.idSpan, lessThan(9007199254740992));
    // never inside the attendance range of wave 2
    expect(
      GradeBook.idBase,
      greaterThan(AttendanceBook.idBase + 999999999999999),
    );
  });

  test('W3-U05 classes = attendance rule; subjects sorted; default subject '
      'from the schedule', () async {
    final (e, ob) = await seeded();
    expect((await teacher(e, ob).classes()).map((c) => c.id), [5]);
    expect((await manager(e, ob).classes()).map((c) => c.id), [5, 6]);
    expect((await teacher(e, ob).subjects()).map((s) => s.name), [
      'ادبیات',
      'ریاضی',
      'کارگاه برق',
    ]);
    expect((await teacher(e, ob).defaultSubject(5))!.id, 41);
    // no schedule row for class 6 → first subject (web rule)
    expect((await manager(e, ob).defaultSubject(6))!.id, 40);
  });

  test(
    'W3-U06 NEG parent / student / counselor / guard may not enter grades',
    () async {
      final (e, ob) = await seeded();
      for (final r in [
        'parent',
        'student',
        'counselor',
        'guard',
        '',
        'Manager',
      ]) {
        final b = GradeBook(engine: e, outbox: ob, role: r, uid: 10);
        expect(b.canWrite, isFalse);
        await expectLater(b.classes(), refused(GradeError.notAllowed));
        await expectLater(b.subjects(), refused(GradeError.notAllowed));
        await expectLater(
          b.save(classId: 5, subjectId: 41, term: t1, inputs: {21: '15'}),
          refused(GradeError.notAllowed),
        );
      }
      expect(ob.list(), isEmpty);
    },
  );

  test(
    'W3-U07 sheet = active students of the class, sorted, all «جدید»',
    () async {
      final (e, ob) = await seeded();
      final s = await teacher(e, ob).sheet(classId: 5, subjectId: 41, term: t1);
      expect(s.map((x) => x.studentId), [22, 21]); // آرش، بهار
      expect(
        s.every((x) => x.state == GradeState.fresh && x.score == null),
        isTrue,
      );
    },
  );

  test(
    'W3-U08 NEG another teacher\'s class / unknown subject are refused',
    () async {
      final (e, ob) = await seeded();
      await expectLater(
        teacher(e, ob).sheet(classId: 6, subjectId: 41, term: t1),
        refused(GradeError.unknownClass),
      );
      await expectLater(
        teacher(
          e,
          ob,
        ).save(classId: 6, subjectId: 41, term: t1, inputs: {31: '12'}),
        refused(GradeError.unknownClass),
      );
      await expectLater(
        teacher(e, ob).sheet(classId: 5, subjectId: 99, term: t1),
        refused(GradeError.unknownSubject),
      );
      expect(ob.list(), isEmpty);
    },
  );

  test(
    'W3-U09 teacher save: payload = web row, status pending, queued',
    () async {
      final (e, ob) = await seeded();
      final res = await teacher(
        e,
        ob,
      ).save(classId: 5, subjectId: 41, term: t1, inputs: {21: '۱۷', 22: ''});
      expect(res.written, 1);
      expect(res.messageFa, '1 نمره ذخیره شد');
      final op = ob.list().single;
      expect(op.collection, 'grades');
      expect(op.baseVersion, 0);
      final id = GradeBook.recordId(
        classId: 5,
        subjectId: 41,
        term: t1,
        studentId: 21,
      );
      expect(op.id, id);
      expect(op.payload, {
        'id': id,
        'student_id': 21,
        'class_id': 5,
        'subject_id': 41,
        'term': 'نوبت اول',
        'kind': 'midterm',
        'score': 17,
        'status': 'pending',
      });
      // offline-first: the local copy already shows the grade as «در انتظار»
      final s = await teacher(e, ob).sheet(classId: 5, subjectId: 41, term: t1);
      final bahar = s.firstWhere((x) => x.studentId == 21);
      expect(bahar.score, 17);
      expect(bahar.state, GradeState.pending);
    },
  );

  test(
    'W3-U10 manager save is approved; workshop subject = practical',
    () async {
      final (e, ob) = await seeded();
      await manager(e, ob).save(
        classId: 5,
        subjectId: 42,
        term: GradeTerm.second,
        inputs: {22: '18.5'},
      );
      final p = ob.list().single.payload!;
      expect(p['status'], 'approved');
      expect(p['kind'], 'practical');
      expect(p['score'], 18.5);
      expect(p['practical_score'], 18.5);
      expect(p['term'], 'نوبت دوم');
    },
  );

  test('W3-U11 unchanged / empty fields are skipped → «تغییری نبود»', () async {
    final (e, ob) = await seeded();
    final b = teacher(e, ob);
    await b.save(classId: 5, subjectId: 41, term: t1, inputs: {21: '15'});
    final again = await b.save(
      classId: 5,
      subjectId: 41,
      term: t1,
      inputs: {21: '15.0', 22: '  '},
    );
    expect(again.written, 0);
    expect(again.unchanged, 1);
    expect(again.messageFa, 'تغییری نبود');
    expect(ob.list().length, 1);
  });

  test('W3-U12 a pulled grade is edited in place; the teacher edit drops it '
      'back to pending; other sheets do not count', () async {
    final (e, ob) = await seeded();
    await e.put('grades', 777, {
      'id': 777,
      'student_id': 21,
      'class_id': 5,
      'subject_id': 41,
      'term': 'نوبت اول',
      'kind': 'midterm',
      'score': 12,
      'status': 'approved',
    }, version: 3);
    // other term / other subject of the same student
    await e.put('grades', 778, {
      'id': 778,
      'student_id': 22,
      'class_id': 5,
      'subject_id': 41,
      'term': 'نوبت دوم',
      'score': 9,
    });
    await e.put('grades', 779, {
      'id': 779,
      'student_id': 22,
      'class_id': 5,
      'subject_id': 40,
      'term': 'نوبت اول',
      'score': 9,
    });
    final b = teacher(e, ob);
    final s = await b.sheet(classId: 5, subjectId: 41, term: t1);
    final bahar = s.firstWhere((x) => x.studentId == 21);
    expect(bahar.state, GradeState.approved);
    expect(bahar.score, 12);
    expect(s.firstWhere((x) => x.studentId == 22).score, isNull);
    await b.save(classId: 5, subjectId: 41, term: t1, inputs: {21: '13'});
    final op = ob.list().single;
    expect(op.id, 777);
    expect(op.baseVersion, 3);
    expect(op.payload!['status'], 'pending');
  });

  test(
    'W3-U13 a practical_score is what the sheet shows (web valOf)',
    () async {
      final (e, ob) = await seeded();
      await e.put('grades', 780, {
        'id': 780,
        'student_id': 22,
        'class_id': 5,
        'subject_id': 42,
        'term': 'نوبت اول',
        'score': 10,
        'practical_score': 16,
        'status': 'pending',
      });
      final s = await teacher(e, ob).sheet(classId: 5, subjectId: 42, term: t1);
      expect(s.firstWhere((x) => x.studentId == 22).score, 16);
    },
  );

  test(
    'W3-U14 a second edit before sync is based on version + queued ops',
    () async {
      final (e, ob) = await seeded();
      final b = teacher(e, ob);
      await b.save(classId: 5, subjectId: 41, term: t1, inputs: {21: '10'});
      await b.save(classId: 5, subjectId: 41, term: t1, inputs: {21: '11'});
      expect(ob.list().map((o) => o.baseVersion), [0, 1]);
      expect(ob.list().map((o) => o.payload!['score']), [10, 11]);
    },
  );

  test(
    'W3-U15 NEG one invalid score refuses the whole save (nothing written)',
    () async {
      final (e, ob) = await seeded();
      await expectLater(
        teacher(e, ob).save(
          classId: 5,
          subjectId: 41,
          term: t1,
          inputs: {21: '15', 22: '25'},
        ),
        throwsA(
          isA<GradeFailure>()
              .having((f) => f.kind, 'kind', GradeError.badScore)
              .having((f) => f.detail, 'detail', 22),
        ),
      );
      expect(ob.list(), isEmpty);
      expect(await e.count('grades'), 0);
    },
  );

  test(
    'W3-U16 NEG a student outside the class: refused, nothing written',
    () async {
      final (e, ob) = await seeded();
      for (final sid in [31, 25, 24, 999]) {
        await expectLater(
          teacher(e, ob).save(
            classId: 5,
            subjectId: 41,
            term: t1,
            inputs: {21: '15', sid: '15'},
          ),
          refused(GradeError.notInClass),
        );
      }
      expect(ob.list(), isEmpty);
    },
  );

  test(
    'W3-U17 NEG a full queue refuses the whole sheet (no half save)',
    () async {
      final (e, ob) = await seeded(config: const OutboxConfig(capacity: 1));
      await expectLater(
        teacher(e, ob).save(
          classId: 5,
          subjectId: 41,
          term: t1,
          inputs: {21: '15', 22: '16'},
        ),
        throwsA(
          isA<SyncFailure>().having(
            (f) => f.code,
            'code',
            PayeshErrorCode.queueFull,
          ),
        ),
      );
      expect(ob.list(), isEmpty);
      expect(await e.count('grades'), 0);
    },
  );

  test('W3-U18 NEG a teacher never writes approved — even when editing an '
      'approved grade', () async {
    final (e, ob) = await seeded();
    expect(teacher(e, ob).writeStatus, 'pending');
    expect(manager(e, ob).writeStatus, 'approved');
    await e.put('grades', 781, {
      'id': 781,
      'student_id': 22,
      'class_id': 5,
      'subject_id': 41,
      'term': 'نوبت اول',
      'score': 14,
      'status': 'approved',
    }, version: 2);
    await teacher(
      e,
      ob,
    ).save(classId: 5, subjectId: 41, term: t1, inputs: {21: '19', 22: '15'});
    expect(ob.list().map((o) => o.payload!['status']).toSet(), {'pending'});
  });
  test(
    'W3-U19 duplicate grades of one sheet: the lowest id wins (web dup rule)',
    () async {
      final (e, ob) = await seeded();
      for (final (id, score) in [(901, 11), (900, 13), (902, 15)]) {
        await e.put('grades', id, {
          'id': id,
          'student_id': 21,
          'class_id': 5,
          'subject_id': 41,
          'term': 'نوبت اول',
          'score': score,
        });
      }
      final s = await teacher(e, ob).sheet(classId: 5, subjectId: 41, term: t1);
      final bahar = s.firstWhere((x) => x.studentId == 21);
      expect(bahar.recordId, 900);
      expect(bahar.score, 13);
    },
  );
}
