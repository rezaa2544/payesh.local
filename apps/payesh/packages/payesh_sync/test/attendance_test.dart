// Row 74, wave 2 — native attendance, unit level (local database + durable outbox, no network).
// Parity target: client/pages.js `actAttendanceSave` + `ATT_LABEL`; server/policy.js `ATT_STATUS`.
import 'package:payesh_core/payesh_core.dart';
import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

const day = '2026-11-12';

Future<(SqliteEngine, SqliteOutbox)> seeded({
  OutboxConfig config = const OutboxConfig(),
}) async {
  final e = SqliteEngine.inMemory();
  final ob = SqliteOutbox(e.database, config: config);
  Future<void> put(String c, int id, Map<String, Object?> d, [int v = 1]) =>
      e.put(c, id, {...d, 'id': id}, version: v);
  await put('classes', 5, {'name': 'دهم الف'});
  await put('classes', 6, {'name': 'یازدهم ب'});
  await put('classes', 7, {'name': 'دوازدهم ج'});
  await put('users', 10, {'name': 'معلم', 'role': 'teacher'});
  await put('users', 11, {
    'name': 'معلم دوم',
    'role': 'teacher',
    'class_id': 7,
  });
  // pulled rows may carry ids as strings — same as JSON from older clients
  await put('schedule', 900, {'teacher_id': 10, 'class_id': '5', 'bell': 1});
  await put('schedule', 901, {'teacher_id': 10, 'class_id': 5, 'bell': 2});
  await put('users', 21, {'name': 'بهار', 'role': 'student', 'class_id': 5});
  await put('users', 22, {'name': 'آرش', 'role': 'student', 'class_id': 5});
  await put('users', 23, {'name': 'سارا', 'role': 'student', 'class_id': '5'});
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

AttendanceBook teacher(SqliteEngine e, SqliteOutbox ob, {int uid = 10}) =>
    AttendanceBook(engine: e, outbox: ob, role: 'teacher', uid: uid);

Matcher refused(AttendanceError k) =>
    throwsA(isA<AttendanceFailure>().having((f) => f.kind, 'kind', k));

void main() {
  ownerTests();
  test('W2-U01 statuses and labels are exactly the web/server set', () {
    expect(AttendanceStatus.values.map((s) => s.wire), [
      'present',
      'absent',
      'late',
      'early_exit',
      'excused',
    ]);
    expect(AttendanceStatus.values.map((s) => s.labelFa), [
      'حاضر',
      'غایب',
      'تأخیر',
      'خروج',
      'موجه',
    ]);
    expect(AttendanceStatus.fromWire('early_exit'), AttendanceStatus.earlyExit);
  });

  test(
    'W2-U02 NEG unknown / missing status is null, never mapped to present',
    () {
      for (final v in ['Present', 'absent ', '', null, 1, 'sick']) {
        expect(AttendanceStatus.fromWire(v), isNull, reason: '$v');
      }
    },
  );

  test('W2-U03 date key = UTC day, the web todayISO rule', () {
    expect(AttendanceBook.dateOf(DateTime.utc(2026, 11, 12, 23, 59)), day);
    // 00:30 in Tehran (+03:30) is still the previous UTC day — same as the web client
    expect(
      AttendanceBook.dateOf(DateTime.parse('2026-11-13T00:30:00+03:30')),
      day,
    );
  });

  test('W2-U04 record id: deterministic, reserved range, below 2^53', () {
    final a = AttendanceBook.recordId(21, day);
    expect(AttendanceBook.recordId(21, day), a);
    expect(AttendanceBook.recordId(22, day), isNot(a));
    expect(AttendanceBook.recordId(21, '2026-11-13'), isNot(a));
    expect(a, greaterThan(AttendanceBook.idBase));
    final max = AttendanceBook.recordId(
      AttendanceBook.maxStudentId,
      '2293-10-15',
    );
    expect(max, lessThan(9007199254740992));
  });

  test('W2-U05 NEG record id refuses bad dates and student ids', () {
    for (final d in [
      '2026-13-01',
      '2026-02-30',
      '26-11-12',
      '2019-12-31',
      '',
      '2026-11-12T00',
    ]) {
      expect(
        () => AttendanceBook.recordId(21, d),
        refused(AttendanceError.badDate),
        reason: d,
      );
    }
    for (final s in [0, -1, AttendanceBook.maxStudentId + 1]) {
      expect(
        () => AttendanceBook.recordId(s, day),
        refused(AttendanceError.badStudent),
      );
    }
  });

  test(
    'W2-U06 teacher classes = schedule teacher_id + own class; manager = all',
    () async {
      final (e, ob) = await seeded();
      expect((await teacher(e, ob).classes()).map((c) => c.id), [5]);
      expect((await teacher(e, ob, uid: 11).classes()).map((c) => c.id), [7]);
      final m = AttendanceBook(engine: e, outbox: ob, role: 'manager', uid: 1);
      expect((await m.classes()).map((c) => c.name), [
        'دهم الف',
        'دوازدهم ج',
        'یازدهم ب',
      ]);
    },
  );

  test(
    'W2-U07 NEG parent / student / counselor / guard may not take attendance',
    () async {
      final (e, ob) = await seeded();
      for (final r in [
        'parent',
        'student',
        'counselor',
        'guard',
        '',
        'Teacher',
      ]) {
        final b = AttendanceBook(engine: e, outbox: ob, role: r, uid: 10);
        expect(b.canWrite, isFalse);
        await expectLater(b.classes(), refused(AttendanceError.notAllowed));
        await expectLater(
          b.save(classId: 5, date: day),
          refused(AttendanceError.notAllowed),
        );
      }
      expect(ob.list(), isEmpty);
    },
  );

  test(
    'W2-U08 roster = active students of the class, sorted, no other roles',
    () async {
      final (e, ob) = await seeded();
      final r = await teacher(e, ob).roster(5, day);
      expect(r.map((x) => x.studentId), [22, 21, 23]); // آرش، بهار، سارا
      expect(r.every((x) => x.recorded == null), isTrue);
    },
  );

  test(
    'W2-U09 NEG another teacher\'s class is refused (local scope)',
    () async {
      final (e, ob) = await seeded();
      await expectLater(
        teacher(e, ob).roster(6, day),
        refused(AttendanceError.unknownClass),
      );
      await expectLater(
        teacher(e, ob).save(classId: 6, date: day),
        refused(AttendanceError.unknownClass),
      );
      expect(ob.list(), isEmpty);
    },
  );

  test('W2-U10 first save: everyone defaults to present, marks applied, all queued', () async {
    final (e, ob) = await seeded();
    final res = await teacher(e, ob).save(
      classId: 5,
      date: day,
      marks: {21: AttendanceStatus.absent, 23: AttendanceStatus.late},
    );
    expect(res.written, 3);
    expect(res.unchanged, 0);
    expect(res.messageFa, '3 رکورد ذخیره شد');
    final ops = ob.list();
    expect(ops.map((o) => o.collection).toSet(), {'attendance'});
    expect(ops.every((o) => o.baseVersion == 0), isTrue);
    final byStudent = {
      for (final o in ops) o.payload!['student_id']: o.payload!,
    };
    expect(byStudent[21]!['status'], 'absent');
    expect(byStudent[22]!['status'], 'present');
    expect(byStudent[23]!['status'], 'late');
    expect(byStudent[22], {
      'id': AttendanceBook.recordId(22, day),
      'student_id': 22,
      'class_id': 5,
      'date': day,
      'status': 'present',
      'note': '',
      'source': 'teacher',
    });
    // offline-first: the local copy already shows the new state
    final r = await teacher(e, ob).roster(5, day);
    expect(
      r.firstWhere((x) => x.studentId == 21).recorded,
      AttendanceStatus.absent,
    );
  });

  test(
    'W2-U11 unchanged students are skipped; nothing changed = «تغییری نبود»',
    () async {
      final (e, ob) = await seeded();
      final b = teacher(e, ob);
      await b.save(classId: 5, date: day);
      expect(ob.list().length, 3);
      final again = await b.save(
        classId: 5,
        date: day,
        marks: {21: AttendanceStatus.present},
      );
      expect(again.written, 0);
      expect(again.unchanged, 3);
      expect(again.messageFa, 'تغییری نبود');
      expect(ob.list().length, 3);
    },
  );

  test(
    'W2-U12 a pulled record is updated in place with its id, version and note',
    () async {
      final (e, ob) = await seeded();
      await e.put('attendance', 777, {
        'id': 777,
        'student_id': 21,
        'class_id': 5,
        'date': day,
        'status': 'absent',
        'note': 'تماس با خانواده',
      }, version: 4);
      // another day's record of the same student does not count
      await e.put('attendance', 778, {
        'id': 778,
        'student_id': 22,
        'class_id': 5,
        'date': '2026-11-11',
        'status': 'absent',
      });
      final b = teacher(e, ob);
      final r = await b.roster(5, day);
      expect(
        r.firstWhere((x) => x.studentId == 21).recorded,
        AttendanceStatus.absent,
      );
      expect(r.firstWhere((x) => x.studentId == 22).recorded, isNull);
      await b.save(
        classId: 5,
        date: day,
        marks: {21: AttendanceStatus.excused},
      );
      final op = ob.list().firstWhere((o) => o.payload!['student_id'] == 21);
      expect(op.id, 777);
      expect(op.baseVersion, 4);
      expect(op.payload!['note'], 'تماس با خانواده');
    },
  );

  test(
    'W2-U13 a second edit before sync is based on version + queued ops',
    () async {
      final (e, ob) = await seeded();
      final b = teacher(e, ob);
      await b.save(classId: 5, date: day, marks: {21: AttendanceStatus.absent});
      await b.save(classId: 5, date: day, marks: {21: AttendanceStatus.late});
      final ops = ob
          .list()
          .where((o) => o.payload!['student_id'] == 21)
          .toList();
      expect(ops.map((o) => o.baseVersion), [0, 1]);
      expect(ops.map((o) => o.payload!['status']), ['absent', 'late']);
    },
  );

  test(
    'W2-U14 NEG a student outside the class: refused, nothing written',
    () async {
      final (e, ob) = await seeded();
      for (final sid in [31, 25, 24, 999]) {
        await expectLater(
          teacher(e, ob).save(
            classId: 5,
            date: day,
            marks: {22: AttendanceStatus.absent, sid: AttendanceStatus.absent},
          ),
          refused(AttendanceError.notInClass),
        );
      }
      expect(ob.list(), isEmpty);
      expect(await e.count('attendance'), 0);
    },
  );

  test('W2-U15 NEG bad date: refused before any write', () async {
    final (e, ob) = await seeded();
    for (final d in ['2026-11-31', 'today', '1403-08-22x']) {
      await expectLater(
        teacher(e, ob).save(classId: 5, date: d),
        refused(AttendanceError.badDate),
      );
    }
    expect(ob.list(), isEmpty);
  });

  test(
    'W2-U16 NEG a full queue refuses the whole class (no half save)',
    () async {
      final (e, ob) = await seeded(config: const OutboxConfig(capacity: 2));
      await expectLater(
        teacher(e, ob).save(classId: 5, date: day),
        throwsA(
          isA<SyncFailure>().having(
            (f) => f.code,
            'code',
            PayeshErrorCode.queueFull,
          ),
        ),
      );
      expect(ob.list(), isEmpty);
      expect(await e.count('attendance'), 0);
    },
  );

  test(
    'W2-U17 NEG a stored unknown status is shown as not recorded and rewritten',
    () async {
      final (e, ob) = await seeded();
      await e.put('attendance', 800, {
        'id': 800,
        'student_id': 22,
        'class_id': 5,
        'date': day,
        'status': 'sick',
      }, version: 2);
      final r = await teacher(e, ob).roster(5, day);
      expect(r.firstWhere((x) => x.studentId == 22).recorded, isNull);
      await teacher(e, ob).save(classId: 5, date: day);
      final op = ob.list().firstWhere((o) => o.id == 800);
      expect(op.payload!['status'], 'present');
      expect(op.baseVersion, 2);
    },
  );

  test(
    'W2-U18 queued ops drain through a push sender with the wire contract',
    () async {
      final (e, ob) = await seeded();
      await teacher(
        e,
        ob,
      ).save(classId: 5, date: day, marks: {21: AttendanceStatus.absent});
      final sent = <Map<String, Object?>>[];
      final r = await ob.drain((ops) async {
        sent.addAll(ops);
        return PushVerdicts.fromJson({
          'applied': [
            for (final o in ops) {'uid': o['uid'], 'id': o['id'], 'version': 1},
          ],
        });
      });
      expect(r.applied, 3);
      expect(ob.list(), isEmpty);
      expect(
        sent.every(
          (o) => o['collection'] == 'attendance' && o['type'] == 'put',
        ),
        isTrue,
      );
      expect(sent.every((o) => (o['uid'] as String).isNotEmpty), isTrue);
      expect(sent.map((o) => o['uid']).toSet().length, 3);
    },
  );

  test(
    'W2-U19 «ثبت شده / ثبت نشده» badge follows the day\'s records',
    () async {
      final (e, ob) = await seeded();
      final b = teacher(e, ob);
      expect(await b.recorded(5, day), isFalse);
      await b.save(classId: 5, date: day);
      expect(await b.recorded(5, day), isTrue);
      expect(await b.recorded(5, '2026-11-13'), isFalse);
    },
  );
}

void ownerTests() {
  group('DeviceOwner (shared device / school change)', () {
    test(
      'W2-U20 first user claims an empty device; same user again = same',
      () async {
        final e = SqliteEngine.inMemory();
        final ob = SqliteOutbox(e.database);
        expect(await DeviceOwner.claim(e, ob, 'alborz/10'), DeviceClaim.fresh);
        expect(DeviceOwner.read(e), 'alborz/10');
        await e.put('users', 21, {'id': 21});
        expect(await DeviceOwner.claim(e, ob, 'alborz/10'), DeviceClaim.same);
        expect(await e.count(), 1);
      },
    );

    test('W2-U21 another user with nothing unsent: old rows, cursor and review wiped', () async {
      final (e, ob) = await seeded();
      expect(await DeviceOwner.claim(e, ob, 'alborz/10'), DeviceClaim.switched);
      e.database.execute(
        "INSERT INTO meta (key, value) VALUES ('gw.since_seq', '42')",
      );
      expect(await DeviceOwner.claim(e, ob, 'alborz/11'), DeviceClaim.switched);
      expect(await e.count(), 0);
      expect(
        e.database.select("SELECT 1 FROM meta WHERE key = 'gw.since_seq'"),
        isEmpty,
      );
      expect(DeviceOwner.read(e), 'alborz/11');
      expect(DeviceClaim.switched.messageFa, isNull);
    });

    test('W2-U22 NEG another user while writes are queued: blocked, nothing wiped or sent', () async {
      final (e, ob) = await seeded();
      // seeded rows were pulled for alborz/10
      e.database.execute(
        "INSERT INTO meta (key, value) VALUES ('device.owner', 'alborz/10')",
      );
      await teacher(e, ob).save(classId: 5, date: day);
      final rows = await e.count();
      for (final other in ['alborz/11', 'damavand/10']) {
        expect(
          await DeviceOwner.claim(e, ob, other),
          DeviceClaim.blockedByQueue,
        );
      }
      expect(DeviceClaim.blockedByQueue.messageFa, contains('کاربر دیگری'));
      expect(ob.list().length, 3);
      expect(await e.count(), rows);
      expect(DeviceOwner.read(e), 'alborz/10');
    });

    test(
      'W2-U23 NEG an open review item of the old user also blocks the switch',
      () async {
        final (e, ob) = await seeded();
        // seeded rows were pulled for alborz/10
        e.database.execute(
          "INSERT INTO meta (key, value) VALUES ('device.owner', 'alborz/10')",
        );
        ensureReviewTable(e.database);
        addReview(
          e.database,
          const ReviewItem(
            kind: 'conflict',
            uid: 'k1',
            at: '2026-11-12T08:00:00Z',
            collection: 'attendance',
            id: 1,
          ),
        );
        expect(
          await DeviceOwner.claim(e, ob, 'alborz/11'),
          DeviceClaim.blockedByQueue,
        );
        // decided by a human → the switch may proceed
        e.database.execute("UPDATE sync_review SET status = 'resolved'");
        expect(
          await DeviceOwner.claim(e, ob, 'alborz/11'),
          DeviceClaim.switched,
        );
      },
    );
  });
}
