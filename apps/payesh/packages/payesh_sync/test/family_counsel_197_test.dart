// Row 197 — Q12 / F27 (parent) and F29 (counselor): the parent ↔ school thread, the
// counselor's appointments, desk and notes, and the record a parent / the counselor reads.
// Server twin: server/parent-msgs.js + server/policy.js (tests/family-counsel-197.js).
import 'dart:io';
import 'dart:math';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

final String repoRoot =
    Platform.environment['PAYESH_REPO_ROOT'] ??
    Directory('../../../..').absolute.path;

const today = '2026-11-12';

Future<(SqliteEngine, SqliteOutbox)> seeded() async {
  final e = SqliteEngine.inMemory();
  final ob = SqliteOutbox(e.database);
  Future<void> put(String c, int id, Map<String, Object?> d) =>
      e.put(c, id, {...d, 'id': id}, version: 1);
  await put('classes', 5, {'name': 'نهم الف', 'grade': '9'});
  await put('classes', 6, {'name': 'دهم', 'grade': '10'});
  await put('subjects', 1, {'name': 'ریاضی'});
  await put('subjects', 2, {'name': 'ادبیات'});
  await put('users', 21, {'name': 'بهار', 'role': 'student', 'class_id': 5});
  await put('users', 22, {'name': 'نگار', 'role': 'student', 'class_id': 6});
  await put('users', 30, {'name': 'خانم دبیر', 'role': 'teacher'});
  await put('users', 31, {'name': 'آقای دبیر', 'role': 'teacher'});
  await put('users', 40, {'name': 'مشاور', 'role': 'counselor'});
  await put('users', 50, {'name': 'ولی بهار', 'role': 'parent'});
  await put('users', 51, {'name': 'مادر بهار', 'role': 'parent'});
  await put('parent_links', 1, {'parent_id': 50, 'student_id': 21});
  await put('parent_links', 2, {'parent_id': 51, 'student_id': 21});
  await put('schedule', 1, {
    'class_id': 5,
    'teacher_id': 30,
    'subject_id': 1,
    'weekday': 0,
  });
  await put('schedule', 2, {
    'class_id': 6,
    'teacher_id': 31,
    'subject_id': 2,
    'weekday': 0,
  });
  await put('grades', 1, {'student_id': 21, 'subject_id': 1, 'score': 18});
  await put('grades', 2, {'student_id': 21, 'subject_id': 1, 'score': 16});
  await put('attendance', 1, {
    'student_id': 21,
    'date': today,
    'status': 'absent',
  });
  await put('discipline', 1, {
    'student_id': 21,
    'kind': 'positive',
    'note': 'همکاری',
    'date': today,
  });
  await put('contributions', 1, {
    'student_id': 21,
    'kind': 'voluntary',
    'amount': 500000,
    'date': today,
  });
  await put('contributions', 2, {
    'student_id': 22,
    'kind': 'voluntary',
    'amount': 1,
    'date': today,
  });
  return (e, ob);
}

SchoolRecords as(SqliteEngine e, SqliteOutbox ob, String role, int uid) =>
    SchoolRecords(
      engine: e,
      outbox: ob,
      role: role,
      uid: uid,
      random: Random(7),
      now: () => DateTime.utc(2026, 11, 12, 9),
    );

Future<void> refused(Future<Object?> Function() f, String code) async {
  try {
    await f();
    fail('expected $code');
  } on RecordFailure catch (x) {
    expect(x.code, code, reason: x.messageFa);
  }
}

List<String> jsList(String src, String name) {
  final m = RegExp('const $name = \\[([^\\]]*)\\]').firstMatch(src)!;
  return [
    for (final s in RegExp("'([^']*)'").allMatches(m.group(1)!)) s.group(1)!,
  ];
}

void main() {
  test('FC197-01 constants equal server/parent-msgs.js; rules + id slots', () {
    final src = File('$repoRoot/server/parent-msgs.js').readAsStringSync();
    expect(msgTo, jsList(src, 'MSG_TO'));
    expect(msgKinds, jsList(src, 'MSG_KINDS'));
    expect(msgStatuses, jsList(src, 'MSG_STATUSES'));
    expect(noteKinds, jsList(src, 'NOTE_KINDS'));
    expect(guidanceTracks, jsList(src, 'GUIDANCE_TRACKS'));
    expect(
      src.contains(
        'text: $msgTextMax, reply: $msgReplyMax, note: $noteTextMax',
      ),
      isTrue,
    );
    final r = SchoolRecords.rules['parent_msgs']!;
    expect(r.writers, {'manager', 'teacher', 'counselor', 'parent'});
    expect(SchoolRecords.rules['contributions']!.readers, {
      'manager',
      'parent',
    });
    final b1 = SchoolRecords.idBaseOf('parent_msgs');
    final b2 = SchoolRecords.idBaseOf('counselor_notes');
    expect(b1, 2800000000000000);
    expect(b2 + SchoolRecords.idSlotSpan <= FamilyBook.idBase, isTrue);
    // the same verdicts as the server for the shapes tests/family-counsel-197.js sends
    final ok = {
      'student_id': 21,
      'to': 'school',
      'kind': 'message',
      'text': 'سلام',
    };
    expect(msgIssue(ok), '');
    expect(msgIssue({...ok, 'to': 'teacher'}), 'teacher_required');
    expect(
      msgIssue({
        ...ok,
        'to': 'teacher',
        'teacher_id': 30,
        'kind': 'appointment',
      }),
      'bad_to',
    );
    expect(msgIssue({...ok, 'text': ' '}), 'text_required');
    expect(msgIssue({...ok, 'text': 'x' * 1001}), 'text_too_long');
    expect(msgIssue({...ok, 'want_date': '2026-02-30'}), 'bad_date');
    expect(msgIssue({...ok, 'appt_time': '10:30'}), 'bad_date');
    expect(
      msgIssue({...ok, 'appt_date': today, 'appt_time': '25:00'}),
      'bad_time',
    );
    expect(msgIssue({...ok, 'status': 'done'}), 'bad_status');
    expect(
      msgIssue({...ok, 'status': 'scheduled', 'appt_date': today}),
      'appt_required',
    );
    expect(
      noteIssue({'student_id': 21, 'kind': 'guidance', 'track': 'هنر'}),
      'bad_track',
    );
    expect(noteIssue({'student_id': 21, 'kind': 'session'}), 'text_required');
    expect(
      noteIssue({'student_id': 21, 'kind': 'guidance', 'track': 'علوم تجربی'}),
      '',
    );
  });

  test(
    'FC197-02 parent sends to school / a teacher of the child / the counselor',
    () async {
      final (e, ob) = await seeded();
      final p = ParentMessages(as(e, ob, 'parent', 50));
      final teachers = await p.teachersOf(21);
      expect(
        [for (final t in teachers) (t.teacherId, t.label)],
        [(30, 'دبیرِ ریاضی')],
      );
      final w = await p.send(
        studentId: 21,
        to: 'school',
        text: 'برای جلسه وقت می‌خواهم',
      );
      final row = (await e.get('parent_msgs', w.id!))!.data;
      expect(row['parent_id'], 50);
      expect(row['status'], 'open');
      expect(row['teacher_id'], isNull);
      expect(w.id! >= SchoolRecords.idBaseOf('parent_msgs'), isTrue);
      await p.send(
        studentId: 21,
        to: 'teacher',
        teacherId: 30,
        text: 'تکلیف ریاضی',
      );
      await p.send(
        studentId: 21,
        to: 'counselor',
        kind: 'appointment',
        text: 'ملاقات',
        wantDate: '2026-11-15',
      );
      expect(ob.list().length, 3);
      // NEG
      await refused(
        () => p.send(studentId: 22, to: 'school', text: 'x'),
        'out_of_scope',
      );
      await refused(
        () => p.send(studentId: 21, to: 'teacher', teacherId: 31, text: 'x'),
        'teacher_required',
      );
      await refused(
        () => p.send(
          studentId: 21,
          to: 'teacher',
          teacherId: 30,
          kind: 'appointment',
          text: 'x',
        ),
        'bad_to',
      );
      await refused(
        () => p.send(studentId: 21, to: 'school', text: '  '),
        'text_required',
      );
      await refused(
        () =>
            ParentMessages(as(e, ob, 'teacher', 30))
                .send(studentId: 21, to: 'school', text: 'x'),
        'not_allowed',
      );
      expect(ob.list().length, 3);
      // both parents see every thread of the child
      expect((await ParentMessages(as(e, ob, 'parent', 51)).list()).length, 3);
    },
  );

  test(
    'FC197-03 recipients see their own threads and answer; counselor books',
    () async {
      final (e, ob) = await seeded();
      final p = ParentMessages(as(e, ob, 'parent', 50));
      final a = await p.send(studentId: 21, to: 'school', text: 'a');
      final b = await p.send(
        studentId: 21,
        to: 'teacher',
        teacherId: 30,
        text: 'b',
      );
      final c = await p.send(
        studentId: 21,
        to: 'counselor',
        kind: 'appointment',
        text: 'c',
      );
      final t30 = ParentMessages(as(e, ob, 'teacher', 30));
      final t31 = ParentMessages(as(e, ob, 'teacher', 31));
      final co = ParentMessages(as(e, ob, 'counselor', 40));
      final m = ParentMessages(as(e, ob, 'manager', 1));
      expect([for (final x in await t30.list()) x.id], [b.id]);
      expect(await t31.list(), isEmpty);
      expect([for (final x in await co.list()) x.id], [c.id]);
      expect((await m.list()).length, 3);
      expect((await t30.list()).single.toLabel, 'دبیرِ ریاضی');

      await t30.answer(b.id!, reply: 'فردا بررسی می‌کنم', status: 'answered');
      final rb = (await e.get('parent_msgs', b.id!))!.data;
      expect(rb['reply'], 'فردا بررسی می‌کنم');
      expect(rb['replied_by'], 30);
      expect(rb['text'], 'b');
      await co.answer(
        c.id!,
        status: 'scheduled',
        apptDate: '2026-11-16',
        apptTime: '10:30',
      );
      final rc = (await e.get('parent_msgs', c.id!))!.data;
      expect(
        (rc['status'], rc['appt_date'], rc['appt_time']),
        ('scheduled', '2026-11-16', '10:30'),
      );
      await m.answer(a.id!, status: 'closed');
      // NEG
      await refused(
        () => t31.answer(b.id!, reply: 'x', status: 'answered'),
        'out_of_scope',
      );
      await refused(() => t30.answer(b.id!, status: 'open'), 'bad_status');
      await refused(
        () => co.answer(c.id!, status: 'scheduled'),
        'appt_required',
      );
      await refused(
        () => co.answer(
          c.id!,
          status: 'scheduled',
          apptDate: '2026-11-16',
          apptTime: '9',
        ),
        'bad_time',
      );
      await refused(() => p.answer(a.id!, status: 'answered'), 'not_allowed');
      // the counselor books for the parents of any student; the parent sees it
      final bk = await co.book(
        studentId: 22,
        apptDate: '2026-11-20',
        apptTime: '09:00',
        text: 'جلسهٔ هدایت',
      );
      final rk = (await e.get('parent_msgs', bk.id!))!.data;
      expect(
        (rk['status'], rk['kind'], rk['parent_id'], rk['replied_by']),
        ('scheduled', 'appointment', null, 40),
      );
      await refused(
        () => co.book(studentId: 30, apptDate: '2026-11-20', text: 'x'),
        'out_of_scope',
      );
      await refused(
        () => co.book(studentId: 22, apptDate: '', text: 'x'),
        'appt_required',
      );
      await refused(
        () => t30.book(studentId: 22, apptDate: '2026-11-20', text: 'x'),
        'not_allowed',
      );
      // open first, then newest: the parent's list shows statuses
      final mine = await p.list(studentId: 21);
      expect(
        {for (final x in mine) x.status},
        {'closed', 'answered', 'scheduled'},
      );
    },
  );

  test('FC197-04 parent child page: record of own child only; contributions; absent today', () async {
    final (e, ob) = await seeded();
    final db = as(e, ob, 'parent', 50);
    final rec = await UserDirectory(db).recordOf(21);
    expect(rec.average, 17.0);
    expect(rec.reportCard, [('ریاضی', '۱۷٫۰')]);
    expect([for (final d in rec.discipline) d.note], ['همکاری']);
    await refused(() => UserDirectory(db).recordOf(22), 'not_reader');
    final x = ChildExtras(db);
    expect([for (final r in await x.contributions(21)) r.id], [1]);
    expect(await x.todayStatus(21), 'absent');
    expect(await x.todayStatus(22), '');
    // a teacher has the class pages, not the record; the student only their own
    await refused(
      () => UserDirectory(as(e, ob, 'teacher', 30)).recordOf(21),
      'not_reader',
    );
    await refused(
      () => UserDirectory(as(e, ob, 'student', 22)).recordOf(21),
      'not_reader',
    );
    expect(
      (await UserDirectory(as(e, ob, 'student', 21)).myRecord()).average,
      17.0,
    );
  });

  test('FC197-05 counselor: every student, read-only record, session/guidance notes', () async {
    final (e, ob) = await seeded();
    final db = as(e, ob, 'counselor', 40);
    final d = CounselorDesk(db);
    expect([for (final s in await d.students()) s.name], ['بهار', 'نگار']);
    expect([for (final s in await d.students(query: 'نگ')) s.id], [22]);
    final rec = await UserDirectory(db).recordOf(22);
    expect(rec.className, 'دهم');
    expect((await UserDirectory(db).recordOf(21)).average, 17.0);
    await d.addNote(studentId: 21, kind: 'session', text: 'گفتگو دربارهٔ غیبت');
    final g = await d.addNote(
      studentId: 21,
      kind: 'guidance',
      track: 'علوم تجربی',
      text: 'علاقه به زیست',
    );
    final row = (await e.get('counselor_notes', g.id!))!.data;
    expect(
      (row['kind'], row['track'], row['author_id'], row['date']),
      ('guidance', 'علوم تجربی', 40, today),
    );
    expect(g.id! >= SchoolRecords.idBaseOf('counselor_notes'), isTrue);
    expect(
      {for (final n in await d.notesOf(21)) n.kind},
      {'session', 'guidance'},
    );
    await refused(
      () => d.addNote(studentId: 21, kind: 'guidance', track: 'هنر'),
      'bad_track',
    );
    await refused(
      () => d.addNote(studentId: 21, kind: 'session'),
      'text_required',
    );
    await refused(
      () => d.addNote(studentId: 21, kind: 'x', text: 'y'),
      'bad_kind',
    );
    await refused(
      () =>
          CounselorDesk(as(e, ob, 'manager', 1))
              .addNote(studentId: 21, kind: 'session', text: 'x'),
      'not_allowed',
    );
    await refused(
      () => CounselorDesk(as(e, ob, 'teacher', 30)).students(),
      'not_allowed',
    );
    // the counselor never writes grades (role rule) — read only record
    expect(db.canWrite('grades'), isFalse);
    expect(db.canRead('counselor_notes'), isTrue);
    expect(as(e, ob, 'manager', 1).canRead('counselor_notes'), isFalse);
  });

  test('FC197-06 student never reads parent_msgs; parent never reads counselor_notes', () async {
    final (e, ob) = await seeded();
    expect(as(e, ob, 'student', 21).canRead('parent_msgs'), isFalse);
    expect(as(e, ob, 'parent', 50).canRead('counselor_notes'), isFalse);
    expect(await ParentMessages(as(e, ob, 'student', 21)).list(), isEmpty);
  });
}
