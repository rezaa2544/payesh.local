// Row 128, wave W9 — weekly schedule, unit level (local SQLite + durable outbox, no network).
// Parity target: client/schedule.js (schedPage, forms slot/bells/workdays/sched-teacher, actions
// sched-*, slot-del, sub-*, bell-*, schedgen-*).
import 'dart:math';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

// 2026-11-14 is a Saturday (school weekday 0); 2026-11-16 is a Monday (2).
const sat = '2026-11-14';
const mon = '2026-11-16';

Future<(SqliteEngine, SqliteOutbox)> seeded({
  OutboxConfig config = const OutboxConfig(),
}) async {
  final e = SqliteEngine.inMemory();
  final ob = SqliteOutbox(e.database, config: config);
  Future<void> put(String c, int id, Map<String, Object?> d) =>
      e.put(c, id, {...d, 'id': id}, version: 1);
  await put('schools', 1, {
    'name': 'هنرستان',
    'workdays': [0, 1, 2, 3, 4],
  });
  await put('lookups', 1, {'kind': 'grade', 'name': 'دهم'});
  await put('lookups', 2, {'kind': 'branch', 'name': 'الکترونیک'});
  await put('lookups', 3, {'kind': 'grade', 'name': 'هفتم'});
  await put('classes', 5, {
    'name': 'دهم الکترونیک',
    'grade': 'دهم',
    'branch': 'الکترونیک',
    'kind': 'class',
    'teacher_id': 10,
  });
  await put('classes', 6, {'name': 'کارگاه ۱', 'kind': 'room'});
  await put('subjects', 41, {'name': 'ریاضی', 'weekly_hours': 2});
  await put('subjects', 42, {'name': 'فیزیک', 'weekly_hours': 1});
  await put('users', 10, {
    'name': 'دبیر ریاضی',
    'role': 'teacher',
    'subject': 'ریاضی',
  });
  await put('users', 11, {
    'name': 'دبیر فیزیک',
    'role': 'teacher',
    'subject': 'فیزیک',
  });
  await put('users', 12, {
    'name': 'غیرفعال',
    'role': 'teacher',
    'active': false,
  });
  await put('users', 21, {'name': 'بهار', 'role': 'student', 'class_id': 5});
  await put('users', 40, {'name': 'ولی', 'role': 'parent'});
  await put('parent_links', 700, {'parent_id': 40, 'student_id': 21});
  await put('schedule', 900, {
    'class_id': 5,
    'grade': 'دهم',
    'branch': 'الکترونیک',
    'subject_id': 41,
    'teacher_id': 10,
    'weekday': 0,
    'bell_order': 1,
  });
  return (e, ob);
}

SchoolRecords db(
  SqliteEngine e,
  SqliteOutbox ob, [
  String role = 'manager',
  int uid = 1,
]) => SchoolRecords(
  engine: e,
  outbox: ob,
  role: role,
  uid: uid,
  random: Random(9),
  now: () => DateTime.utc(2026, 11, 14, 8),
);

Matcher failsWith(String code) =>
    throwsA(isA<RecordFailure>().having((f) => f.code, 'code', code));

void main() {
  test('W9-U01 helpers: clock text, Saturday-based weekday, default bells and work days', () async {
    expect(schedTime('۷:۴۵'), '07:45');
    expect(schedTime('24:00'), '');
    expect(schedTime('abc'), '');
    expect(schoolWeekday(sat), 0);
    expect(schoolWeekday(mon), 2);
    expect(schoolWeekday('2026-11-20'), 6, reason: 'Friday');
    final (e, ob) = await seeded();
    final t = Timetable(db(e, ob));
    expect(await t.workDays(), [0, 1, 2, 3, 4]);
    final l = await t.lessons();
    expect(l.map((b) => b.order), [1, 2, 3, 4]);
    expect(l.first.label, 'زنگ ۱ (درس)');
  });

  test('W9-U02 manager view: cohort picker, cohort rows only, today\'s substitute shown', () async {
    final (e, ob) = await seeded();
    await e.put('schedule', 901, {
      'id': 901,
      'class_id': 99,
      'grade': 'هفتم',
      'subject_id': 42,
      'weekday': 1,
      'bell_order': 1,
    }, version: 1);
    await e.put('substitutions', 950, {
      'id': 950,
      'schedule_id': 900,
      'sub_teacher_id': 11,
      'date': sat,
    }, version: 1);
    final t = Timetable(db(e, ob));
    final v = await t.view();
    expect(v.grades, ['دهم', 'هفتم']);
    expect(v.grade, 'دهم');
    expect(v.branch, 'الکترونیک');
    expect(v.canEdit, isTrue);
    expect(v.slots.map((s) => s.id), [900]);
    expect(v.at(0, 1)!.subToday, 'دبیر فیزیک');
    expect(v.subs.single.teacher, 'دبیر فیزیک');
    expect(v.days, [0, 1, 2, 3, 4], reason: 'Thursday is not a work day');
    final v7 = await t.view(grade: 'هفتم', branch: '');
    expect(v7.slots.map((s) => s.id), [901]);
  });

  test(
    'W9-U03 read-only views: teacher (mine / home class), student, parent',
    () async {
      final (e, ob) = await seeded();
      final teacher = await Timetable(db(e, ob, 'teacher', 10)).view();
      expect(teacher.title, 'برنامهٔ هفتگی تدریس من');
      expect(teacher.slots.single.id, 900);
      expect(teacher.homeClasses.single.$1, 5);
      expect(teacher.canEdit, isFalse);
      final other = await Timetable(db(e, ob, 'teacher', 11)).view();
      expect(other.slots, isEmpty);
      final home = await Timetable(db(e, ob, 'teacher', 10)).view(homeClass: 5);
      expect(home.title, contains('دهم الکترونیک'));
      final st = await Timetable(db(e, ob, 'student', 21)).view();
      expect(st.slots.single.subject, 'ریاضی');
      final pa = await Timetable(db(e, ob, 'parent', 40)).view();
      expect(pa.children.single.$2, 'بهار');
      expect(pa.slots.single.id, 900);
      expect(pa.canEdit, isFalse);
    },
  );

  test('W9-U04 save slot: the cohort class is reused; a new cohort creates its class row', () async {
    final (e, ob) = await seeded();
    final t = Timetable(db(e, ob));
    final w = await t.saveSlot(
      const SlotDraft(
        grade: 'دهم',
        branch: 'الکترونیک',
        day: 1,
        period: 2,
        subjectId: 42,
        teacherId: 11,
        roomId: 6,
      ),
    );
    final r = await e.get('schedule', w.id!);
    expect(r!.data['class_id'], 5);
    expect(r.data['room'], 'کارگاه ۱');
    expect(ob.list(), hasLength(1));
    final w2 = await t.saveSlot(
      const SlotDraft(grade: 'هفتم', day: 1, period: 2, subjectId: 41),
    );
    expect(ob.list().map((o) => o.collection), [
      'schedule',
      'classes',
      'schedule',
    ]);
    final cls = await e.get(
      'classes',
      (await e.get('schedule', w2.id!))!.data['class_id']! as int,
    );
    expect(cls!.data['name'], 'هفتم');
    expect(cls.data['mode'], 'class');
    expect(cls.data['grade_level'], 7);
  });

  test('W9-U05 NEG slot rules: no subject, inactive day, cohort / teacher / room clash → refused, nothing queued', () async {
    final (e, ob) = await seeded();
    final t = Timetable(db(e, ob));
    await expectLater(
      t.saveSlot(
        const SlotDraft(grade: 'دهم', branch: 'الکترونیک', day: 1, period: 1),
      ),
      failsWith('invalid'),
    );
    await expectLater(
      t.saveSlot(
        const SlotDraft(
          grade: 'دهم',
          branch: 'الکترونیک',
          day: 5,
          period: 1,
          subjectId: 41,
        ),
      ),
      failsWith('invalid'),
    );
    await expectLater(
      t.saveSlot(
        const SlotDraft(
          grade: 'دهم',
          branch: 'الکترونیک',
          day: 0,
          period: 1,
          subjectId: 42,
        ),
      ),
      failsWith('duplicate'),
    );
    await expectLater(
      t.saveSlot(
        const SlotDraft(
          grade: 'هفتم',
          day: 0,
          period: 1,
          subjectId: 41,
          teacherId: 10,
        ),
      ),
      throwsA(
        isA<RecordFailure>().having(
          (f) => f.messageFa,
          'msg',
          contains('تداخل ساعت'),
        ),
      ),
    );
    await e.put('schedule', 903, {
      'id': 903,
      'class_id': 77,
      'room_id': 6,
      'weekday': 2,
      'bell_order': 3,
    }, version: 1);
    await expectLater(
      t.saveSlot(
        const SlotDraft(
          grade: 'هفتم',
          day: 2,
          period: 3,
          subjectId: 41,
          roomId: 6,
        ),
      ),
      failsWith('duplicate'),
    );
    expect(ob.list(), isEmpty);
    // editing the same slot in place is not a clash with itself
    await t.saveSlot(
      const SlotDraft(
        id: 900,
        grade: 'دهم',
        branch: 'الکترونیک',
        day: 0,
        period: 1,
        subjectId: 41,
        teacherId: 10,
      ),
    );
    expect(ob.list(), hasLength(1));
  });

  test('W9-U06 teacher options are marked busy at that bell; inactive teachers hidden', () async {
    final (e, ob) = await seeded();
    final t = Timetable(db(e, ob));
    final o = await t.teachers(day: 0, period: 1);
    expect(o.map((x) => (x.name, x.busy)), [
      ('دبیر ریاضی', true),
      ('دبیر فیزیک', false),
    ]);
    final self = await t.teachers(day: 0, period: 1, exceptSlot: 900);
    expect(self.every((x) => !x.busy), isTrue);
  });

  test('W9-U07 clashes in the data → listed; suggestions are free for class and teacher; move', () async {
    final (e, ob) = await seeded();
    await e.put('schedule', 904, {
      'id': 904,
      'class_id': 5,
      'grade': 'دهم',
      'branch': 'الکترونیک',
      'subject_id': 42,
      'teacher_id': 10,
      'weekday': 0,
      'bell_order': 1,
    }, version: 1);
    final t = Timetable(db(e, ob));
    final c = await t.clashes();
    expect(c.map((x) => x.kind), ['class', 'teacher']);
    final sug = await t.suggest(904);
    expect(sug, [(0, 2), (0, 3), (0, 4)]);
    await t.move(904, 0, 2);
    expect(await t.clashes(), isEmpty);
    // NEG moving into an occupied cell / an inactive day
    await expectLater(t.move(904, 0, 1), failsWith('duplicate'));
    await expectLater(t.move(904, 5, 1), failsWith('invalid'));
  });

  test('W9-U08 substitution: date must be the slot weekday, another free teacher; one per slot', () async {
    final (e, ob) = await seeded();
    final t = Timetable(db(e, ob));
    await expectLater(t.saveSub(900, mon, 11), failsWith('invalid'));
    await expectLater(t.saveSub(900, sat, 10), failsWith('invalid'));
    await expectLater(t.saveSub(900, sat, null), failsWith('invalid'));
    await expectLater(t.saveSub(900, 'bad', 11), failsWith('invalid'));
    expect(ob.list(), isEmpty);
    final w = await t.saveSub(900, sat, 11);
    final again = await t.saveSub(900, '2026-11-21', 11);
    expect(again.id, w.id, reason: 'the slot keeps a single substitution');
    expect((await e.get('substitutions', w.id!))!.data['date'], '2026-11-21');
    await t.deleteSubsOf(900);
    expect(await e.get('substitutions', w.id!), isNull);
  });

  test('W9-U09 delete slot removes its substitutions; delete one substitution from the list', () async {
    final (e, ob) = await seeded();
    final t = Timetable(db(e, ob));
    final s = await t.saveSub(900, sat, 11);
    await t.deleteSub(s.id!);
    expect(await e.get('substitutions', s.id!), isNull);
    final s2 = await t.saveSub(900, sat, 11);
    final w = await t.deleteSlot(900);
    expect(w.keys, hasLength(2));
    expect(await e.get('schedule', 900), isNull);
    expect(await e.get('substitutions', s2.id!), isNull);
  });

  test('W9-U10 bells: validation, lesson/break numbering, removed rows deleted; work days', () async {
    final (e, ob) = await seeded();
    final t = Timetable(db(e, ob));
    final d = await t.bellDraft();
    expect(d.map((b) => b.type), [
      'lesson',
      'break',
      'lesson',
      'break',
      'lesson',
      'break',
      'lesson',
    ]);
    await expectLater(
      t.saveBells(const [BellDraft(start: '08:00')]),
      failsWith('invalid'),
    );
    await expectLater(
      t.saveBells(const [BellDraft(start: '09:00', end: '08:00')]),
      failsWith('invalid'),
    );
    await expectLater(
      t.saveBells(const [
        BellDraft(start: '08:00', end: '09:00'),
        BellDraft(start: '08:30', end: '09:30'),
      ]),
      failsWith('invalid'),
    );
    await expectLater(
      t.saveBells(const [
        BellDraft(start: '08:00', end: '09:00', type: 'break'),
      ]),
      failsWith('invalid'),
    );
    await t.saveBells(const [
      BellDraft(start: '۷:۳۰', end: '08:15'),
      BellDraft(start: '08:15', end: '08:30', type: 'break'),
      BellDraft(start: '08:30', end: '09:15'),
    ]);
    final b = await t.bells();
    expect(b.map((x) => (x.order, x.label)), [
      (1, 'زنگ ۱ (درس)'),
      (1.5, 'تفریح اول'),
      (2, 'زنگ ۲ (درس)'),
    ]);
    expect(b.first.start, '07:30');
    expect((await t.lessons()).map((x) => x.order), [1, 2]);
    await t.saveBells([
      BellDraft(id: b.first.id, start: '07:30', end: '08:15'),
    ]);
    expect((await t.bells()).map((x) => x.id), [b.first.id]);
    await expectLater(t.saveWorkdays(const []), failsWith('invalid'));
    await t.saveWorkdays(const [5, 0, 0, 2]);
    expect(await t.workDays(), [0, 2, 5]);
    expect(
      (await e.get('schools', 1))!.data['name'],
      'هنرستان',
      reason: 'other fields kept',
    );
  });

  test('W9-U11 generator: demands by weekly hours, specialists, one-day spread; apply fills only empty cells', () async {
    final (e, ob) = await seeded();
    final t = Timetable(db(e, ob));
    final g = await t.generate();
    // ریاضی 2 h/week (1 already placed) + فیزیک 1 → 2 demands for the one cohort
    expect(g.demands, 2);
    expect(g.unplaced, isEmpty);
    expect(g.noSpecialist, 0);
    final math = g.placements.firstWhere((p) => p.subjectId == 41);
    expect(math.teacherId, 10);
    expect(
      math.day,
      isNot(0),
      reason: 'the existing math lesson is on Saturday: spread to another day',
    );
    final phys = g.placements.firstWhere((p) => p.subjectId == 42);
    expect(phys.teacherId, 11);
    expect((phys.day, phys.period), (0, 2));
    // a cell filled between preview and apply is skipped
    await e.put('schedule', 905, {
      'id': 905,
      'class_id': 5,
      'weekday': 0,
      'bell_order': 2,
    }, version: 1);
    final w = await t.applyGenerated(g);
    expect(w.messageFa, contains('رد شد'));
    expect(w.keys, hasLength(1));
  });

  test('W9-U12 NEG teacher: every write refused, nothing queued; full queue refuses multi-row up front', () async {
    final (e, ob) = await seeded();
    final t = Timetable(db(e, ob, 'teacher', 10));
    await expectLater(
      t.saveSlot(
        const SlotDraft(
          grade: 'دهم',
          branch: 'الکترونیک',
          day: 1,
          period: 1,
          subjectId: 41,
        ),
      ),
      failsWith('not_allowed'),
    );
    await expectLater(t.deleteSlot(900), failsWith('not_allowed'));
    await expectLater(t.saveWorkdays(const [0]), failsWith('not_allowed'));
    await expectLater(
      t.saveBells(const [BellDraft(start: '08:00', end: '09:00')]),
      failsWith('not_allowed'),
    );
    await expectLater(t.addTeacher('x'), failsWith('not_allowed'));
    await expectLater(t.generate(), failsWith('not_allowed'));
    expect(ob.list(), isEmpty);
    final (e2, ob2) = await seeded(config: const OutboxConfig(capacity: 1));
    final m = Timetable(db(e2, ob2));
    await m.saveSub(900, sat, 11);
    await expectLater(m.deleteSlot(900), throwsA(isA<SyncFailure>()));
    expect(await e2.get('schedule', 900), isNotNull);
  });
}
