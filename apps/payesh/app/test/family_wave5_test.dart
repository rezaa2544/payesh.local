// Row 74, wave 5 — parents pages. Widget tests drive the REAL screens, the REAL controller and
// the REAL FamilyBook on a real (in-memory) SQLite + durable outbox; only the Gateway is absent
// (the real Gateway + PostgreSQL path is packages/payesh_sync/test/family_it_test.dart).
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/app.dart';
import 'package:payesh_app/src/attendance/attendance_controller.dart';
import 'package:payesh_app/src/attendance/attendance_wiring.dart';
import 'package:payesh_app/src/family/family_controller.dart';
import 'package:payesh_app/src/family/family_screen.dart';
import 'package:payesh_app/src/flags.dart';
import 'package:payesh_app/src/grades/grades_controller.dart';
import 'package:payesh_app/src/login/session_controller.dart';
import 'package:payesh_app/src/notices/notices_controller.dart';
import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

const secret32 = 'QRSTUVWXYZ234567ABCDEFGHIJKLMNOP';

/// 12 Nov 2026 = ۲۱ آبان ۱۴۰۵.
final today = DateTime.utc(2026, 11, 12, 8);

/// Network-free school access: refresh answers from a queue (a session or a failure).
final class FakeAccess implements SchoolAccessApi {
  FakeAccess(this.refreshes);
  final List<Object> refreshes;

  static SchoolSession session(String role, {int uid = 10}) => SchoolSession(
    school: 'alborz-12',
    tenantId: 't-1',
    token: 'tok-$uid',
    expiresAt: DateTime.utc(2030),
    role: role,
    uid: uid,
  );

  @override
  Future<SchoolRoute> resolve(String schoolCode) =>
      Future.error(StateError('unexpected resolve'));

  @override
  Future<Activation> activate({
    required Uri cell,
    required String school,
    required String code,
    required String deviceId,
  }) => Future.error(StateError('unexpected activate'));

  @override
  Future<SchoolSession> refresh({
    required Uri cell,
    required String school,
    required String deviceId,
    required String deviceSecret,
  }) {
    if (refreshes.isEmpty) {
      return Future.error(const SchoolAccessFailure(SchoolAccessError.offline));
    }
    final v = refreshes.removeAt(0);
    return v is SchoolSession ? Future.value(v) : Future.error(v);
  }
}

/// In-memory data source with the real books (all waves share it, like production).
base class MemorySource
    implements AttendanceSource, GradeSource, NoticeSource, FamilySource {
  MemorySource({OutboxConfig config = const OutboxConfig()})
    : engine = SqliteEngine.inMemory() {
    outbox = SqliteOutbox(engine.database, config: config);
  }
  final SqliteEngine engine;
  late final SqliteOutbox outbox;
  final ValueNotifier<int> bump = ValueNotifier(0);
  int nudges = 0;

  @override
  Future<AttendanceBook?> bookFor({
    required String role,
    required int uid,
  }) async =>
      AttendanceBook(engine: engine, outbox: outbox, role: role, uid: uid);

  @override
  Future<GradeBook?> gradeBookFor({
    required String role,
    required int uid,
  }) async => GradeBook(engine: engine, outbox: outbox, role: role, uid: uid);

  @override
  Future<NoticeBoard?> noticeBoardFor({
    required String role,
    required int uid,
  }) async => NoticeBoard(engine: engine, outbox: outbox, role: role, uid: uid);

  @override
  Future<FamilyBook?> familyBookFor({
    required String role,
    required int uid,
  }) async => FamilyBook(
    engine: engine,
    outbox: outbox,
    role: role,
    uid: uid,
    now: () => today,
  );

  @override
  void queued() => nudges++;

  @override
  Listenable get changed => bump;
}

/// The book is not ready (null) or reading it fails (throws).
final class BrokenSource extends MemorySource {
  BrokenSource({this.missing = false});
  final bool missing;

  @override
  Future<FamilyBook?> familyBookFor({
    required String role,
    required int uid,
  }) async => missing ? null : throw StateError('disk (test)');
}

/// Parent 10 → students 22 (class 6) and 21 (class 5); student 23 belongs to another family.
Future<void> seed(SqliteEngine e, {bool links = true}) async {
  Future<void> put(String c, int id, Map<String, Object?> d, [int v = 1]) =>
      e.put(c, id, {...d, 'id': id}, version: v);
  await put('classes', 5, {'name': 'دهم ریاضی'});
  await put('classes', 6, {'name': 'یازدهم تجربی'});
  await put('subjects', 1, {'name': 'ریاضی'});
  await put('subjects', 2, {'name': 'فیزیک'});
  await put('users', 21, {'name': 'سارا', 'role': 'student', 'class_id': 5});
  await put('users', 22, {'name': 'علی', 'role': 'student', 'class_id': 6});
  await put('users', 23, {'name': 'نیما', 'role': 'student', 'class_id': 5});
  if (links) {
    await put('parent_links', 1, {'parent_id': 10, 'student_id': 22});
    await put('parent_links', 2, {'parent_id': 10, 'student_id': 21});
  }
  await put('parent_links', 3, {'parent_id': 11, 'student_id': 23});
  for (final (id, sub, term, score, st) in [
    (101, 1, 'نوبت اول', 18, 'approved'),
    (102, 2, 'نوبت اول', 5, 'pending'),
    (103, 1, 'نوبت دوم', 13, 'approved'),
  ]) {
    await put('grades', id, {
      'student_id': 21,
      'class_id': 5,
      'subject_id': sub,
      'term': term,
      'score': score,
      'status': st,
    });
  }
  for (final (d, st) in [(9, 'present'), (10, 'absent'), (11, 'late')]) {
    await put('attendance', 4000000000000000 + d * 10000000000 + 21, {
      'student_id': 21,
      'class_id': 5,
      'date': '2026-11-${d.toString().padLeft(2, '0')}',
      'status': st,
    });
  }
  await put('internships', 201, {
    'student_id': 21,
    'date': '2026-11-05',
    'hours': 4,
    'location': 'کارگاه برق',
    'status': 'approved',
  });
  await put('leaves', 301, {
    'student_id': 21,
    'date': '2026-11-03',
    'reason': 'پزشک',
    'status': 'approved',
  });
  await put('leaves', 302, {
    'student_id': 23,
    'date': '2026-11-10',
    'reason': 'دیگری',
    'status': 'pending',
  });
}

Future<FakeSecureStore> savedSchool({
  String role = 'teacher',
  int? uid = 10,
}) async {
  final store = FakeSecureStore();
  await SchoolAccountStore(store).save(
    SavedSchool(
      school: 'alborz-12',
      cellUrl: Uri.parse('https://cell-1.example.ir'),
      deviceSecret: secret32,
      role: role,
      uid: uid,
    ),
  );
  return store;
}

Future<(SessionController, MemorySource)> boot(
  WidgetTester tester, {
  String role = 'parent',
  int? savedUid = 10,
  bool online = true,
  String waves = 'login,attendance,grades,notices,parents',
  MemorySource? source,
  bool wireFamily = true,
  bool links = true,
}) async {
  final src = source ?? MemorySource();
  await tester.runAsync(() => seed(src.engine, links: links));
  final c = SessionController(
    api: FakeAccess([if (online) FakeAccess.session(role)]),
    accounts: SchoolAccountStore(await savedSchool(role: role, uid: savedUid)),
    flags: ClientFlags.parse(waves: waves),
    now: () => today,
  );
  addTearDown(c.dispose);
  await tester.pumpWidget(
    PayeshApp(
      session: c,
      attendance: src,
      grades: src,
      notices: src,
      family: wireFamily ? src : null,
      today: () => today,
    ),
  );
  await c.start();
  await tester.pumpAndSettle();
  return (c, src);
}

Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 5; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
    await tester.pumpAndSettle();
  }
}

Future<void> tapKey(WidgetTester tester, String key) async {
  await tester.ensureVisible(find.byKey(Key(key)));
  await tester.tap(find.byKey(Key(key)));
  await settle(tester);
}

String textOf(WidgetTester tester, String key) =>
    tester.widget<Text>(find.byKey(Key(key))).data!;

String badgeOf(WidgetTester tester, String key) => tester
    .widget<Text>(
      find.descendant(of: find.byKey(Key(key)), matching: find.byType(Text)),
    )
    .data!;

void main() {
  testWidgets(
    'W5-W01 parent: entry → one card per linked child, class, approved average and attendance',
    (tester) async {
      await boot(tester);
      expect(find.byKey(const Key('fam-entry')), findsOneWidget);
      expect(find.byKey(const Key('ntc-entry')), findsOneWidget);
      await tapKey(tester, 'fam-entry');
      expect(textOf(tester, 'fam-count'), '۲ فرزند');
      expect(find.byKey(const Key('fam-card-22')), findsOneWidget);
      expect(find.byKey(const Key('fam-card-21')), findsOneWidget);
      expect(find.byKey(const Key('fam-card-23')), findsNothing);
      expect(textOf(tester, 'fam-class-21'), 'دهم ریاضی');
      expect(badgeOf(tester, 'fam-avg-21'), 'معدل ۱۵.۵');
      expect(badgeOf(tester, 'fam-att-21'), 'حضور ۳۳٪');
      final avg = tester.widget<StatusBadge>(
        find.byKey(const Key('fam-avg-21')),
      );
      expect(avg.tone, PayeshTone.success);
      // no grade / no record: «—», neutral — never a misleading 0
      expect(badgeOf(tester, 'fam-avg-22'), 'معدل —');
      expect(badgeOf(tester, 'fam-att-22'), 'حضور —');
      expect(
        tester.widget<StatusBadge>(find.byKey(const Key('fam-att-22'))).tone,
        PayeshTone.neutral,
      );
    },
  );

  testWidgets(
    'W5-W02 child page: grades with review state, attendance states, internship',
    (tester) async {
      await boot(tester);
      await tapKey(tester, 'fam-entry');
      await tapKey(tester, 'fam-open-21');
      expect(find.text('سارا'), findsWidgets);
      expect(badgeOf(tester, 'chd-avg'), 'معدل ۱۵.۵');
      expect(badgeOf(tester, 'chd-count'), '۳ نمره ثبت‌شده');
      expect(badgeOf(tester, 'chd-state-101'), 'تأییدشده');
      expect(badgeOf(tester, 'chd-state-102'), 'در انتظار');
      expect(textOf(tester, 'chd-score-103'), '۱۳');
      final days = [
        for (final d in [11, 10, 9]) 4000000000000000 + d * 10000000000 + 21,
      ];
      expect(badgeOf(tester, 'chd-day-state-${days[0]}'), 'تأخیر');
      expect(badgeOf(tester, 'chd-day-state-${days[1]}'), 'غایب');
      expect(
        tester
            .widget<StatusBadge>(find.byKey(Key('chd-day-state-${days[1]}')))
            .tone,
        PayeshTone.danger,
      );
      expect(find.byKey(const Key('chd-int-201')), findsOneWidget);
      await tapKey(tester, 'chd-back');
      expect(find.byKey(const Key('fam-card-21')), findsOneWidget);
    },
  );

  testWidgets(
    'W5-W03 child without grades or attendance: explicit empty rows',
    (tester) async {
      await boot(tester);
      await tapKey(tester, 'fam-entry');
      await tapKey(tester, 'fam-open-22');
      expect(find.byKey(const Key('chd-grades-empty')), findsOneWidget);
      expect(find.byKey(const Key('chd-att-empty')), findsOneWidget);
      expect(badgeOf(tester, 'chd-count'), '۰ نمره ثبت‌شده');
    },
  );

  testWidgets(
    'W5-W04 leave request: today by default, pending, queued badge, AutoSync nudged',
    (tester) async {
      final (_, src) = await boot(tester);
      await tapKey(tester, 'fam-entry');
      await tapKey(tester, 'fam-leaves');
      expect(textOf(tester, 'lvs-count'), '۱ درخواست');
      expect(find.byKey(const Key('lvs-card-302')), findsNothing);
      expect(badgeOf(tester, 'lvs-state-301'), 'تأییدشده');
      await tapKey(tester, 'lvs-add');
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('lvf-date')))
            .controller!
            .text,
        '۱۴۰۵/۰۸/۲۱',
      );
      await tester.tap(find.byKey(const Key('lvf-student')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('سارا').last);
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('lvf-reason')),
        ' مراجعه به پزشک ',
      );
      await tapKey(tester, 'lvf-submit');
      expect(find.byKey(const Key('lvf-reason')), findsNothing);
      expect(textOf(tester, 'lvs-notice'), startsWith('درخواست ثبت شد'));
      expect(textOf(tester, 'lvs-count'), '۲ درخواست');
      final op = src.outbox.list().single;
      expect(op.collection, 'leaves');
      expect(op.payload!['student_id'], 21);
      expect(op.payload!['date'], '2026-11-12');
      expect(op.payload!['reason'], 'مراجعه به پزشک');
      expect(op.payload!['status'], 'pending');
      expect(badgeOf(tester, 'lvs-state-${op.id}'), 'در انتظار');
      expect(find.byKey(Key('lvs-queued-${op.id}')), findsOneWidget);
      expect(src.nudges, 1);
    },
  );

  testWidgets(
    'W5-W05 a day that does not exist (۱۴۰۵/۰۷/۳۱) or junk: refused in the form, nothing queued (negative)',
    (tester) async {
      final (_, src) = await boot(tester);
      await tapKey(tester, 'fam-entry');
      await tapKey(tester, 'fam-leaves');
      await tapKey(tester, 'lvs-add');
      for (final d in ['۱۴۰۵/۰۷/۳۱', '۱۴۰۵/۱۳/۰۱', 'فردا', '']) {
        await tester.enterText(find.byKey(const Key('lvf-date')), d);
        await tapKey(tester, 'lvf-submit');
        expect(textOf(tester, 'lvf-error'), 'تاریخ را درست انتخاب کنید');
      }
      expect(find.byKey(const Key('lvf-reason')), findsOneWidget);
      expect(src.outbox.list(), isEmpty);
      expect(src.nudges, 0);
      // a valid Jalali day with Latin digits is accepted
      await tester.enterText(find.byKey(const Key('lvf-date')), '1405-8-25');
      await tapKey(tester, 'lvf-submit');
      expect(src.outbox.list().single.payload!['date'], '2026-11-16');
    },
  );

  testWidgets(
    'W5-W06 full queue: the form says so and nothing is written (negative)',
    (tester) async {
      final (_, src) = await boot(
        tester,
        source: MemorySource(config: const OutboxConfig(capacity: 0)),
      );
      await tapKey(tester, 'fam-entry');
      await tapKey(tester, 'fam-leaves');
      await tapKey(tester, 'lvs-add');
      await tapKey(tester, 'lvf-submit');
      expect(
        textOf(tester, 'lvf-error'),
        'صف ارسال پر است — پیش از ثبت تازه، اتصال را برقرار کنید',
      );
      expect(await tester.runAsync(() => src.engine.count('leaves')), 2);
      expect(src.nudges, 0);
    },
  );

  testWidgets(
    'W5-W07 flag / source / role gates: legacy line, wait line, none — never a dead button (negative)',
    (tester) async {
      await boot(tester, waves: 'login,attendance,grades,notices');
      expect(find.byKey(const Key('fam-entry-legacy')), findsOneWidget);
      expect(find.byKey(const Key('fam-entry')), findsNothing);
      await boot(tester, wireFamily: false);
      expect(find.byKey(const Key('fam-entry-legacy')), findsOneWidget);
      // parents without the earlier waves stays off (waves are strictly in order)
      await boot(tester, waves: 'login,attendance,grades,parents');
      expect(find.byKey(const Key('fam-entry-legacy')), findsOneWidget);
      // offline first start of a saved parent whose uid is not known yet: a wait line
      await boot(tester, savedUid: null, online: false);
      expect(find.byKey(const Key('fam-entry-wait')), findsOneWidget);
      expect(find.byKey(const Key('fam-entry')), findsNothing);
      await boot(tester, role: 'teacher');
      expect(find.byKey(const Key('fam-entry-none')), findsOneWidget);
      expect(find.byKey(const Key('fam-entry-legacy')), findsNothing);
      expect(
        ClientFlags.parse(waves: 'login,attendance,grades,parents')
            .uses(NativeWave.parents),
        isFalse,
      );
    },
  );

  testWidgets(
    'W5-W08 leaving the form with a typed reason asks; «ماندن» keeps it (negative)',
    (tester) async {
      final (_, src) = await boot(tester);
      await tapKey(tester, 'fam-entry');
      await tapKey(tester, 'fam-leaves');
      await tapKey(tester, 'lvs-add');
      await tester.enterText(find.byKey(const Key('lvf-reason')), 'سفر');
      await tapKey(tester, 'lvf-back');
      await tapKey(tester, 'lvf-discard-cancel');
      expect(find.byKey(const Key('lvf-reason')), findsOneWidget);
      await tester.binding.handlePopRoute();
      await settle(tester);
      await tapKey(tester, 'lvf-discard-confirm');
      expect(find.byKey(const Key('lvf-reason')), findsNothing);
      expect(src.outbox.list(), isEmpty);
      // an untouched form leaves without asking
      await tapKey(tester, 'lvs-add');
      await tapKey(tester, 'lvf-back');
      expect(find.byKey(const Key('lvf-discard-confirm')), findsNothing);
      expect(find.byKey(const Key('lvf-reason')), findsNothing);
    },
  );

  testWidgets(
    'W5-W09 no linked child: the web message, and no request can be started (negative)',
    (tester) async {
      await boot(tester, links: false);
      await tapKey(tester, 'fam-entry');
      expect(
        textOf(tester, 'fam-empty'),
        'فرزندی به حساب شما متصل نیست — با دفتر مدرسه تماس بگیرید.',
      );
      expect(find.byType(Card), findsNothing);
      await tapKey(tester, 'fam-leaves');
      expect(find.byKey(const Key('lvs-empty')), findsOneWidget);
      final fab = tester.widget<FloatingActionButton>(
        find.byKey(const Key('lvs-add')),
      );
      expect(fab.onPressed, isNull);
    },
  );

  testWidgets(
    'W5-W10 a pull that brings the school\'s decision refreshes the open pages',
    (tester) async {
      final (_, src) = await boot(tester);
      await tapKey(tester, 'fam-entry');
      await tapKey(tester, 'fam-open-21');
      expect(badgeOf(tester, 'chd-state-102'), 'در انتظار');
      await tester.runAsync(
        () => src.engine.put('grades', 102, {
          'id': 102,
          'student_id': 21,
          'class_id': 5,
          'subject_id': 2,
          'term': 'نوبت اول',
          'score': 5,
          'status': 'approved',
        }, version: 2),
      );
      src.bump.value++;
      await settle(tester);
      expect(badgeOf(tester, 'chd-state-102'), 'تأییدشده');
      expect(badgeOf(tester, 'chd-avg'), 'معدل ۱۲.۰');
      await tapKey(tester, 'chd-back');
      expect(badgeOf(tester, 'fam-avg-21'), 'معدل ۱۲.۰');
    },
  );

  testWidgets(
    'W5-W11 the local book is not ready or fails: an error, no empty-family claim (negative)',
    (tester) async {
      for (final (src, msg) in [
        (BrokenSource(missing: true), 'پایگاه محلی هنوز آماده نیست'),
        (BrokenSource(), 'خواندن دادهٔ محلی ناموفق بود'),
      ]) {
        await boot(tester, source: src);
        await tapKey(tester, 'fam-entry');
        expect(textOf(tester, 'fam-error'), msg);
        expect(find.byKey(const Key('fam-empty')), findsNothing);
        expect(find.byKey(const Key('fam-leaves')), findsNothing);
        await tapKey(tester, 'fam-back');
        expect(find.byKey(const Key('fam-entry')), findsOneWidget);
      }
    },
  );

  test('W5-U jalaliToIso: real days only', () {
    expect(jalaliToIso('۱۴۰۵/۰۸/۲۱'), '2026-11-12');
    expect(jalaliToIso('1405/1/1'), '2026-03-21');
    expect(jalaliToIso('۱۴۰۵/۰۶/۳۱'), isNotNull);
    expect(jalaliToIso('۱۴۰۵/۰۷/۳۱'), isNull);
    expect(jalaliToIso('x'), isNull);
    expect(averageTone(14.9), PayeshTone.warning);
    expect(averageTone(15), PayeshTone.success);
    expect(averageTone(9.99), PayeshTone.danger);
    expect(attendanceTone(90), PayeshTone.success);
    expect(attendanceTone(89), PayeshTone.warning);
    expect(leaveTone(LeaveState.rejected), PayeshTone.danger);
  });

  group('GatewayAttendanceSource serves the parents pages (production wiring, network-free)', () {
    HttpClient offlineClient() =>
        HttpClient()
          ..connectionFactory = (uri, host, port) =>
              Future.error(const SocketException('offline (test)'));

    Future<(SessionController, GatewayAttendanceSource)> wire(
      SqliteEngine e,
    ) async {
      final c = SessionController(
        api: FakeAccess([FakeAccess.session('parent')]),
        accounts: SchoolAccountStore(await savedSchool(role: 'parent')),
        flags: ClientFlags.parse(),
        now: () => today,
      );
      final src = GatewayAttendanceSource(
        storage: Future.value(e),
        session: c,
        client: offlineClient(),
      )..attach();
      await c.start();
      return (c, src);
    }

    test('W5-S01 signed in → parents book on the shared database and outbox; none after sign-out', () async {
      final e = SqliteEngine.inMemory();
      final (c, src) = await wire(e);
      final b = await src.familyBookFor(role: 'parent', uid: 10);
      expect(b, isNotNull);
      expect(b!.engine, same(e));
      final n = await src.noticeBoardFor(role: 'parent', uid: 10);
      expect(b.outbox, same(n!.outbox));
      expect(DeviceOwner.read(e), 'alborz-12/10');
      await c.signOut();
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(await src.familyBookFor(role: 'parent', uid: 10), isNull);
      await src.dispose();
      c.dispose();
    });

    test('W5-S02 NEG another user\'s unsent writes block the parents book', () async {
      final e = SqliteEngine.inMemory();
      await seed(e);
      e.database.execute(
        "INSERT INTO meta (key, value) VALUES ('device.owner', 'alborz-12/99')",
      );
      SqliteOutbox(e.database).enqueue({
        'collection': 'leaves',
        'type': 'put',
        'id': 1,
        'data': {'student_id': 21},
      });
      final (c, src) = await wire(e);
      expect(await src.familyBookFor(role: 'parent', uid: 10), isNull);
      expect(c.sync.value.phase, SyncPhase.attention);
      await src.dispose();
      c.dispose();
    });
  });
}
