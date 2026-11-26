// ردیف ۱۹۷ (Q02 / F25 + F28) — مرخصی کامل در سطح واحد (SQLite محلی + صف پایدار، بدون شبکه):
// قواعد مشترک leave_spec (همان policy.leaveIssue سرور و leaveIssue وب)، ثبت مرخصی به‌دست مدیر،
// شمارش «در انتظار»، ترتیب فهرست، و پیوند مرخصی تأییدشده با فهرست حضور و غیاب.
import 'dart:math';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

final now = DateTime.utc(2026, 11, 12, 9, 10);
const png1 =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

Future<(SqliteEngine, SqliteOutbox)> seeded() async {
  final e = SqliteEngine.inMemory();
  final ob = SqliteOutbox(e.database);
  Future<void> put(String c, int id, Map<String, Object?> d) =>
      e.put(c, id, {...d, 'id': id}, version: 1);
  await put('classes', 5, {'name': 'دهم الف', 'kind': 'class'});
  await put('users', 10, {'name': 'دبیر', 'role': 'teacher'});
  await put('schedule', 900, {'teacher_id': 10, 'class_id': 5, 'bell': 1});
  await put('users', 21, {'name': 'بهار', 'role': 'student', 'class_id': 5});
  await put('users', 22, {'name': 'آرش', 'role': 'student', 'class_id': 5});
  await put('users', 23, {'name': 'سارا', 'role': 'student', 'class_id': 5});
  await put('users', 24, {
    'name': 'انتقالی',
    'role': 'student',
    'class_id': 5,
    'active': false,
  });
  return (e, ob);
}

SchoolRecords db(
  SqliteEngine e,
  SqliteOutbox ob, {
  String role = 'manager',
  int uid = 1,
}) => SchoolRecords(
  engine: e,
  outbox: ob,
  role: role,
  uid: uid,
  now: () => now,
  random: Random(3),
);

final _ascii = RegExp(r'[0-9]');

void main() {
  group('leave_spec — همان کدهای سرور و وب', () {
    test('L197-U01 روزانه/بازه/ساعتی درست ⇒ null؛ هر خطا کد خودش', () {
      expect(leaveIssue({'date': '2026-11-12'}), isNull);
      expect(
        leaveIssue({'date': '2026-11-12', 'date_to': '2026-11-14'}),
        isNull,
      );
      expect(
        leaveIssue({
          'date': '2026-11-12',
          'kind': 'hours',
          'time_from': '10:00',
          'time_to': '11:30',
        }),
        isNull,
      );
      expect(leaveIssue({'date': '2026-02-30'}), 'bad_date');
      expect(leaveIssue({'date': ''}), 'bad_date');
      expect(
        leaveIssue({'date': '2026-11-12', 'date_to': '2026-11-10'}),
        'bad_range',
      );
      expect(
        leaveIssue({'date': '2026-11-01', 'date_to': '2026-12-02'}),
        'range_too_long',
      );
      // ۳۱ روز دقیقاً مجاز است
      expect(
        leaveIssue({'date': '2026-11-01', 'date_to': '2026-12-01'}),
        isNull,
      );
      expect(
        leaveIssue({
          'date': '2026-11-12',
          'kind': 'hours',
          'time_from': '11:00',
          'time_to': '11:00',
        }),
        'bad_time',
      );
      expect(
        leaveIssue({
          'date': '2026-11-12',
          'kind': 'hours',
          'time_from': '9:00',
          'time_to': '11:00',
        }),
        'bad_time',
      );
      expect(leaveIssue({'date': '2026-11-12', 'kind': 'week'}), 'bad_kind');
      expect(leaveIssue({'date': '2026-11-12', 'type': 'vip'}), 'bad_type');
      expect(
        leaveIssue({'date': '2026-11-12', 'reason': 'ا' * 501}),
        'reason_too_long',
      );
      expect(
        leaveIssue({
          'date': '2026-11-12',
          'attachment': 'data:text/html;base64,PHNjcmlwdD4=',
        }),
        'bad_attachment',
      );
      expect(
        leaveIssue({
          'date': '2026-11-12',
          'attachment': 'data:image/png;base64,${'A' * leaveAttachMax}',
        }),
        'bad_attachment',
      );
      expect(leaveIssue({'date': '2026-11-12', 'attachment': png1}), isNull);
    });

    test('L197-U02 پیام‌ها فارسی و با رقم فارسی؛ روزها، پوشش و زمان نمایش', () {
      for (final c in [
        'bad_date',
        'bad_range',
        'range_too_long',
        'bad_time',
        'bad_kind',
        'bad_type',
        'reason_too_long',
        'bad_attachment',
      ]) {
        final m = leaveIssueFa(c);
        expect(m, isNot('درخواست مرخصی پذیرفته نشد'), reason: c);
        expect(_ascii.hasMatch(m), isFalse, reason: '$c: $m');
      }
      final range = {'date': '2026-11-12', 'date_to': '2026-11-14'};
      expect(leaveDays(range), 3);
      expect(leaveDays({'date': '2026-11-12'}), 1);
      expect(leaveCovers(range, '2026-11-12'), isTrue);
      expect(leaveCovers(range, '2026-11-14'), isTrue);
      expect(leaveCovers(range, '2026-11-15'), isFalse);
      expect(leaveCovers(range, '2026-11-11'), isFalse);
      // ساعتی فقط همان روز را می‌پوشاند، حتی اگر date_to جامانده باشد
      expect(
        leaveCovers({
          'date': '2026-11-12',
          'kind': 'hours',
          'date_to': '2026-11-20',
        }, '2026-11-13'),
        isFalse,
      );
      String jd(String iso) => 'J$iso';
      expect(leaveWhenFa(range, jd), 'J2026-11-12 تا J2026-11-14 (۳ روز)');
      expect(
        leaveWhenFa({
          'date': '2026-11-12',
          'kind': 'hours',
          'time_from': '10:00',
          'time_to': '12:00',
        }, jd),
        'J2026-11-12 · ساعت ۱۰:۰۰ تا ۱۲:۰۰',
      );
    });

    test(
      'L197-U03 پیوست: بایت‌ها رفت‌وبرگشت؛ NEG نوع ناشناخته و بیش از سقف',
      () {
        final bytes = leaveAttachmentBytes({'attachment': png1})!;
        expect(bytes.take(4), [0x89, 0x50, 0x4E, 0x47]);
        expect(leaveAttachmentUri(bytes), png1);
        expect(leaveAttachmentUri([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), isNull);
        expect(
          leaveAttachmentUri([0xFF, 0xD8, 0xFF, ...List.filled(50000, 7)]),
          isNull,
        );
        expect(
          leaveAttachmentBytes({'attachment': 'data:text/plain,hi'}),
          isNull,
        );
        expect(leaveAttachmentBytes({}), isNull);
      },
    );
  });

  group('SchoolReports — میز مرخصی مدیر', () {
    test('L197-U04 ثبت با تأیید فوری ⇒ approved + decided_by، شناسه در بازهٔ مرخصی، اول صف بعد '
        'نسخهٔ محلی؛ بدون تأیید ⇒ pending و در صدر فهرست', () async {
      final (e, ob) = await seeded();
      final r = SchoolReports(db(e, ob));
      final w = await r.addLeave(
        studentId: 21,
        date: '2026-11-12',
        dateTo: '2026-11-14',
        type: 'sick',
        reason: ' سرماخوردگی ',
        attachment: png1,
      );
      expect(w.messageFa, 'مرخصی ثبت و تأیید شد');
      expect(
        w.id,
        inInclusiveRange(
          FamilyBook.idBase,
          FamilyBook.idBase + FamilyBook.idSpan - 1,
        ),
      );
      final op = ob.list().single;
      expect(op.collection, 'leaves');
      expect(op.payload!['status'], 'approved');
      expect(op.payload!['decided_by'], 1);
      expect(op.payload!['decided_at'], '2026-11-12T09:10:00.000Z');
      expect(op.payload!['date_to'], '2026-11-14');
      expect(op.payload!['reason'], 'سرماخوردگی');
      expect(op.payload!['attachment'], png1);
      expect((await e.get('leaves', w.id!))!.data['status'], 'approved');
      final h = await r.addLeave(
        studentId: 22,
        date: '2026-11-13',
        kind: 'hours',
        timeFrom: '10:00',
        timeTo: '11:00',
        approve: false,
      );
      expect(h.messageFa, 'مرخصی ثبت شد');
      final hp = ob.list().last.payload!;
      expect(hp['status'], 'pending');
      expect(hp.containsKey('decided_by'), isFalse);
      expect(hp.containsKey('date_to'), isFalse);
      expect(await r.pendingLeaves(), 1);
      final list = await r.leaves();
      expect(list.first.id, h.id, reason: 'در انتظار پیش از بررسی‌شده');
      expect((await r.dashboard()).pendingLeaves, 1);
    });

    test('L197-U05 NEG: بازهٔ وارونه، ساعت نادرست، دانش‌آموز غیرفعال/ناموجود و دبیر رد می‌شوند؛ '
        'هیچ چیزی در صف نمی‌رود', () async {
      final (e, ob) = await seeded();
      final r = SchoolReports(db(e, ob));
      Matcher code(String c) =>
          throwsA(isA<RecordFailure>().having((f) => f.code, 'code', c));
      await expectLater(
        r.addLeave(studentId: 21, date: '2026-11-12', dateTo: '2026-11-10'),
        code('bad_range'),
      );
      await expectLater(
        r.addLeave(
          studentId: 21,
          date: '2026-11-12',
          kind: 'hours',
          timeFrom: '12:00',
          timeTo: '10:00',
        ),
        code('bad_time'),
      );
      await expectLater(
        r.addLeave(studentId: 24, date: '2026-11-12'),
        code('not_found'),
      );
      await expectLater(
        r.addLeave(studentId: 10, date: '2026-11-12'),
        code('not_found'),
      );
      await expectLater(
        SchoolReports(db(e, ob, role: 'teacher', uid: 10))
            .addLeave(studentId: 21, date: '2026-11-12'),
        code('not_allowed'),
      );
      expect(ob.list(), isEmpty);
      final picks = await r.leaveStudents();
      expect(picks.map((p) => p.id), [
        22,
        21,
        23,
      ], reason: 'فعال‌ها، به ترتیب نام');
      expect(picks.first.label, 'آرش — دهم الف');
    });
  });

  group('AttendanceBook — مرخصی در فهرست حضور', () {
    test(
      'L197-U06 تمام‌روز ⇒ برچسب و پیش‌فرض «موجه» در ذخیره؛ ساعتی ⇒ برچسب ساعت و «حاضر»؛ '
      'NEG در انتظار / رد شده / روز دیگر بی‌اثر؛ تمام‌روز بر ساعتی مقدم',
      () async {
        final (e, ob) = await seeded();
        Future<void> lv(int id, Map<String, Object?> d) =>
            e.put('leaves', id, {...d, 'id': id}, version: 1);
        await lv(1, {
          'student_id': 21,
          'date': '2026-11-11',
          'date_to': '2026-11-13',
          'type': 'family',
          'status': 'approved',
        });
        await lv(2, {
          'student_id': 21,
          'date': '2026-11-12',
          'kind': 'hours',
          'time_from': '08:00',
          'time_to': '09:00',
          'status': 'approved',
        });
        await lv(3, {
          'student_id': 22,
          'date': '2026-11-12',
          'kind': 'hours',
          'time_from': '10:00',
          'time_to': '12:00',
          'status': 'approved',
        });
        await lv(4, {
          'student_id': 23,
          'date': '2026-11-12',
          'status': 'pending',
        });
        await lv(5, {
          'student_id': 23,
          'date': '2026-11-12',
          'status': 'rejected',
        });
        await lv(6, {
          'student_id': 23,
          'date': '2026-11-13',
          'status': 'approved',
        });
        final book = AttendanceBook(
          engine: e,
          outbox: ob,
          role: 'teacher',
          uid: 10,
        );
        final roster = {
          for (final r in await book.roster(5, '2026-11-12')) r.studentId: r,
        };
        expect(roster[21]!.leave, 'مرخصی (خانوادگی)');
        expect(roster[21]!.leaveAllDay, isTrue);
        expect(roster[22]!.leave, 'مرخصی ساعتی ۱۰:۰۰ تا ۱۲:۰۰');
        expect(roster[22]!.leaveAllDay, isFalse);
        expect(roster[23]!.leave, isNull);
        expect(roster[23]!.leaveAllDay, isFalse);
        final res = await book.save(classId: 5, date: '2026-11-12');
        expect(res.written, 3);
        final st = {
          for (final o in ob.list())
            o.payload!['student_id']: o.payload!['status'],
        };
        expect(st, {21: 'excused', 22: 'present', 23: 'present'});
        // علامت دستی معلم بر پیش‌فرض مقدم است
        final (e2, ob2) = await seeded();
        await e2.put('leaves', 1, {
          'id': 1,
          'student_id': 21,
          'date': '2026-11-12',
          'status': 'approved',
        }, version: 1);
        await AttendanceBook(
          engine: e2,
          outbox: ob2,
          role: 'teacher',
          uid: 10,
        ).save(
          classId: 5,
          date: '2026-11-12',
          marks: {21: AttendanceStatus.present},
        );
        expect(
          ob2
              .list()
              .firstWhere((o) => o.payload!['student_id'] == 21)
              .payload!['status'],
          'present',
        );
      },
    );
  });
}
