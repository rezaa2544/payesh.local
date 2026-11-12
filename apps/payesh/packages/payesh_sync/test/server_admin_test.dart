// Row 128, wave W12 — data health (client/diag.js) and the school-server management models
// (PAGES.system manager sections, PAGES.cloud, phone-diagnose), unit level. The real server
// path of LanServerAdmin is packages/payesh_sync/test/school_admin_it_test.dart W12-IT-*.
import 'dart:convert';
import 'dart:math';

import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

Future<(SqliteEngine, SqliteOutbox)> seeded() async {
  final e = SqliteEngine.inMemory();
  final ob = SqliteOutbox(e.database);
  Future<void> put(String c, int id, Map<String, Object?> d) =>
      e.put(c, id, {...d, 'id': id}, version: 1);
  await put('lookups', 1, {'kind': 'grade', 'name': 'دهم'});
  await put('lookups', 2, {'kind': 'grade', 'name': 'دهم '});
  await put('lookups', 3, {'kind': 'branch', 'name': 'شبکه'});
  await put('classes', 5, {
    'name': 'دهم شبکه',
    'grade': 'دهم ',
    'branch': 'شبکه',
  });
  await put('classes', 6, {
    'name': 'دهم شبکه ۲',
    'grade': 'دهم',
    'branch': 'شبکه',
  });
  await put('classes', 7, {'name': 'بی‌پایه'});
  await put('users', 20, {
    'name': 'علی رضایی',
    'role': 'student',
    'class_id': 5,
    'national_id': '0012345678',
    'phone': '09120000001',
  });
  await put('users', 21, {
    'name': 'علي رضايي',
    'role': 'student',
    'class_id': 6,
    'national_id': '0012345678',
    'birth_date': '1390/01/01',
    'father_name': 'حسن',
  });
  await put('users', 22, {
    'name': 'مینا',
    'role': 'student',
    'class_id': 99,
    'national_id': '12345',
  });
  await put('users', 30, {'name': 'ولی', 'role': 'parent'});
  await put('parent_links', 40, {'parent_id': 30, 'student_id': 21});
  await put('parent_links', 41, {'parent_id': 30, 'student_id': 777});
  await put('attendance', 50, {
    'student_id': 20,
    'date': '2026-11-12',
    'status': 'present',
  });
  await put('attendance', 51, {
    'student_id': 20,
    'date': '2026-11-12',
    'status': 'absent',
  });
  await put('attendance', 52, {
    'student_id': 21,
    'date': '2026-11-11',
    'status': 'late',
  });
  await put('grades', 60, {'student_id': 21, 'subject_id': 1, 'score': 15});
  await put('leaves', 70, {
    'student_id': 21,
    'date': '2026-11-20',
    'status': 'pending',
  });
  return (e, ob);
}

SchoolRecords db(SqliteEngine e, SqliteOutbox ob, {String role = 'manager'}) =>
    SchoolRecords(
      engine: e,
      outbox: ob,
      role: role,
      uid: 1,
      now: () => DateTime.utc(2026, 11, 12, 9),
      random: Random(3),
    );

void main() {
  test(
    'W12-U01 data health: same checks as the web, failures first by severity; '
    'NEG a teacher cannot run it',
    () async {
      final (e, ob) = await seeded();
      final h = DataHealth(db(e, ob));
      final run = await h.run();
      expect(run.rows, hasLength(DataHealth.checks.length));
      expect(DataHealth.checks.map((c) => c.id), [
        'dup-nid', 'dup-login', 'dup-person', 'invalid-nid', 'orphan-link', //
        'orphan-class-ref',
        'no-class',
        'class-no-grade',
        'dup-class',
        'dup-lookup',
        'dup-attendance', 'dup-grade', 'sched-conflict', 'stuck-queue',
      ]);
      final bad = {for (final r in run.bad) r.check.id: r.result};
      expect(
        run.bad
            .take(4)
            .every((r) => r.check.severity == HealthSeverity.critical),
        isTrue,
      );
      expect(bad['dup-nid']!.message, '1 کد ملی بین چند کاربر مشترک است');
      expect(bad['dup-nid']!.items.single.members.map((m) => m.id), [20, 21]);
      expect(bad['dup-person']!.count, 1);
      expect(bad['invalid-nid']!.items.single.note, '12345');
      expect(bad['orphan-link']!.items.single.id, 41);
      expect(bad['orphan-class-ref']!.items.single.name, 'مینا');
      expect(bad['class-no-grade']!.items.single.id, 7);
      expect(bad['dup-class']!.count, 1);
      expect(bad['dup-lookup']!.count, 1);
      expect(bad['dup-attendance']!.count, 1);
      expect(
        run.good.map((r) => r.check.id),
        containsAll(['dup-grade', 'sched-conflict', 'stuck-queue']),
      );
      expect(run.critical, greaterThanOrEqualTo(4));
      expect(run.warning, greaterThanOrEqualTo(1));
      expect(DataHealth.normName(' علي_رضايي '), 'علی رضایی');
      expect(DataHealth.loginKey({'phone': '۰۹۱۲۰۰۰۰۰۰۱'}), '09120000001');
      expect(DataHealth.loginKey({'national_id': '0012345678'}), '0012345678');
      expect(DataHealth.loginKey({'national_id': '12'}), '');
      await expectLater(
        DataHealth(db(e, ob, role: 'teacher')).run(),
        throwsA(
          isA<RecordFailure>().having((f) => f.code, 'code', 'not_allowed'),
        ),
      );
      expect(() => DataHealth.checkOf('nope'), throwsA(isA<RecordFailure>()));
      await expectLater(h.check('nope'), throwsA(isA<RecordFailure>()));
    },
  );

  test('W12-U02 safe fixes queue their repairs (orphan link, deleted class, duplicate '
      'lookup, duplicate attendance); NEG unsafe checks are refused', () async {
    final (e, ob) = await seeded();
    final h = DataHealth(db(e, ob));
    final link = await h.fix('orphan-link');
    expect(link.messageFa, '1 پیوند بی‌صاحب پاک شد');
    expect(await e.get('parent_links', 41), isNull);
    final cls = await h.fix('orphan-class-ref');
    expect(cls.messageFa, '1 دانش‌آموز به «نیازمند پیگیری» منتقل شد');
    expect((await e.get('users', 22))!.data['class_id'], isNull);
    final lk = await h.fix('dup-lookup');
    expect(lk.messageFa, '1 تعریف تکراری پاک شد و کلاس‌ها به نام اصلی برگشتند');
    expect((await e.get('classes', 5))!.data['grade'], 'دهم');
    expect(await e.get('lookups', 2), isNull);
    final att = await h.fix('dup-attendance');
    expect(att.messageFa, '1 ثبت حضور تکراری حذف شد (اولی نگه داشته شد)');
    expect(await e.get('attendance', 50), isNotNull);
    expect(await e.get('attendance', 51), isNull);
    expect((await h.fix('dup-attendance')).messageFa, 'چیزی برای اصلاح نمانده');
    expect(ob.list().map((o) => o.type).toSet(), {'put', 'del'});
    for (final id in ['dup-nid', 'dup-login', 'invalid-nid', 'dup-grade']) {
      await expectLater(h.fix(id), throwsA(isA<RecordFailure>()), reason: id);
    }
  });

  test('W12-U03 merge: the kept account takes empty fields, dependants move, the duplicate '
      'is deleted; NEG nothing to merge / missing main account', () async {
    final (e, ob) = await seeded();
    final h = DataHealth(db(e, ob));
    final grp = await h.mergeGroup('0012345678');
    expect(grp.map((m) => m.id), [20, 21]);
    expect(grp.first.contact, '09120000001');
    final r = await h.merge(20, [20, 21]);
    expect(r.messageFa, 'ادغام شد · 4 رکورد منتقل و 1 حساب تکراری حذف شد');
    expect(await e.get('users', 21), isNull);
    final keep = (await e.get('users', 20))!.data;
    expect(keep['birth_date'], '1390/01/01');
    expect(keep['father_name'], 'حسن');
    expect(keep['class_id'], 5);
    expect((await e.get('grades', 60))!.data['student_id'], 20);
    expect((await e.get('leaves', 70))!.data['student_id'], 20);
    expect((await e.get('parent_links', 40))!.data['student_id'], 20);
    expect((await e.get('attendance', 52))!.data['student_id'], 20);
    expect(await h.mergeGroup('0012345678'), hasLength(1));
    await expectLater(h.merge(20, [20]), throwsA(isA<RecordFailure>()));
    await expectLater(h.merge(999, [20]), throwsA(isA<RecordFailure>()));
  });

  test('W12-U04 a duplicate parent link is dropped, not doubled; stuck queue over 20', () async {
    final (e, ob) = await seeded();
    await e.put('parent_links', 42, {
      'id': 42,
      'parent_id': 30,
      'student_id': 20,
    }, version: 1);
    final rec = db(e, ob);
    final h = DataHealth(rec);
    await h.merge(20, [21]);
    expect(await e.get('parent_links', 40), isNull);
    expect((await e.get('parent_links', 42))!.data['student_id'], 20);
    for (var i = 0; i < 21; i++) {
      await rec.put('announcements', 9000000000000000 + i, {'title': 't$i'});
    }
    final q = await h.check('stuck-queue');
    expect(q.ok, isFalse);
    expect(q.message, contains('تغییر هنوز ارسال نشده است'));
  });

  test(
    'W12-U05 server models read the web\'s fields; the cloud key is never kept',
    () {
      final m = MirrorState.fromJson({
        'mirror': {
          'ok': false,
          'at': '2026-11-12T08:00:00Z',
          'total': 120,
          'diffs': [
            {'collection': 'users', 'db': 10, 'mirror': 9},
          ],
        },
        'daily': [
          {'file': 'payesh-2026-11-12.json', 'total': 120, 'size': 2048},
        ],
      });
      expect(m.ok, isFalse);
      expect(m.diffs.single.collection, 'users');
      expect(m.daily.single.day, '2026-11-12');
      final c = CloudConfig.fromJson({
        'config': {
          'endpoint': 'https://s3.example',
          'bucket': 'b',
          'accessKey': 'AKIA…',
          'secret': '••••••••',
          'has_access_key': true,
          'has_secret': true,
          'configured': false,
          'built_in': true,
        },
      });
      expect(c.stateFa, 'در حال آماده‌سازی');
      expect(c.accessHint, 'AKIA…');
      expect(CloudConfig.fromJson(const {}).stateFa, 'تنظیم نشده');
      expect(const CloudForm(endpoint: ' https://x ', secret: '').toJson(), {
        'endpoint': 'https://x',
      });
      final t = CloudOutcome.test({
        'ok': true,
        'steps': [
          {'name': 'نوشتن', 'ok': true, 'ms': 12},
        ],
      });
      expect(t.headlineFa, 'حافظهٔ ابری سالم است');
      expect(t.steps.single.ms, 12);
      expect(
        CloudOutcome.test({'ok': false, 'error': 'x'}).headlineFa,
        'وصل نشد — x',
      );
      final cors = CloudOutcome.cors({
        'ok': true,
        'origins': ['*'],
      });
      expect(cors.steps.single.name, 'دامنه‌های مجاز: *');
      expect(
        CloudOutcome.cors({'ok': false, 'error': 'denied'}).steps.single.note,
        'denied',
      );
      final p = CloudOutcome.phone({
        'ok': false,
        'steps': [
          {'step': 'bucket', 'ok': true},
          {'step': 'set_cors', 'ok': false, 'status': 403, 'error': 'denied'},
        ],
      });
      expect(p.headlineFa, 'هنوز نشده');
      expect(p.steps.last.name, 'گذاشتن اجازهٔ خواندن');
      expect(p.steps.last.note, 'کد 403 — denied');
      final d = DeviceInfo.fromJson({
        'id': 'ab',
        'user_name': 'x',
        'role': 'teacher',
        'revoked': true,
      });
      expect(d.revoked, isTrue);
      expect(AuditEntry.fromJson({'at': 'a', 'action': 'put'}).user, '—');
      expect(
        ServerHealth.fromJson({'version': '1', 'cloud_ready': true}).cloudReady,
        isTrue,
      );
      expect(
        const RestoreReport(3, 'b.sqlite').messageFa,
        'بازیابی انجام شد · 3 رکورد · نسخهٔ ایمنی: b.sqlite',
      );
      expect(
        const AdminFailure(AdminError.unknown, 'x').messageFa,
        'انجام نشد: x',
      );
      for (final k in AdminError.values) {
        expect(AdminFailure(k).messageFa, isNotEmpty);
        expect(AdminFailure(k).toString(), contains(k.name));
      }
    },
  );

  test('W12-U06 restore file checks (NEG not JSON, not a Payesh backup, too large); '
      'connection diagnosis without a server', () async {
    expect(
      BackupFile.parse(
        utf8.encode('{"format":"payesh-backup","collections":{}}'),
      )['format'],
      'payesh-backup',
    );
    expect(
      () => BackupFile.parse(utf8.encode('nope')),
      throwsA(
        isA<AdminFailure>().having((f) => f.kind, 'kind', AdminError.badFile),
      ),
    );
    expect(
      () => BackupFile.parse(utf8.encode('{"format":"x"}')),
      throwsA(
        isA<AdminFailure>().having((f) => f.kind, 'kind', AdminError.notBackup),
      ),
    );
    expect(
      () => BackupFile.parse(List.filled(BackupFile.maxBytes + 1, 32)),
      throwsA(
        isA<AdminFailure>().having((f) => f.kind, 'kind', AdminError.tooLarge),
      ),
    );
    final steps = await diagnoseConnection(
      server: null,
      admin: null,
      signedIn: false,
      queued: 2,
    );
    expect(steps.map((s) => s.ok), [false, false, false]);
    expect(steps.last.textFa, '2 تغییر هنوز در صف ارسال است');
  });
}
