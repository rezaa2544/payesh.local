// Row 74, wave 3 — grades. Widget tests drive the REAL screens, the REAL controller and the REAL
// GradeBook on a real (in-memory) SQLite + durable outbox; only the Gateway is absent (the real
// Gateway + PostgreSQL path is packages/payesh_sync/test/grades_it_test.dart).
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/app.dart';
import 'package:payesh_app/src/attendance/attendance_controller.dart';
import 'package:payesh_app/src/attendance/attendance_wiring.dart';
import 'package:payesh_app/src/flags.dart';
import 'package:payesh_app/src/grades/grades_controller.dart';
import 'package:payesh_app/src/login/session_controller.dart';
import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_sync/payesh_sync.dart';

import 'nav_support.dart';

const secret32 = 'QRSTUVWXYZ234567ABCDEFGHIJKLMNOP';
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

/// In-memory data source with the real books (attendance + grades share it, like production).
final class MemorySource implements AttendanceSource, GradeSource {
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
  void queued() => nudges++;

  @override
  Listenable get changed => bump;
}

Future<void> seed(SqliteEngine e) async {
  Future<void> put(String c, int id, Map<String, Object?> d, [int v = 1]) =>
      e.put(c, id, {...d, 'id': id}, version: v);
  await put('classes', 5, {'name': 'دهم الف'});
  await put('classes', 6, {'name': 'یازدهم ب'});
  await put('schedule', 900, {
    'teacher_id': 10,
    'class_id': 5,
    'subject_id': 41,
  });
  await put('subjects', 40, {'name': 'ادبیات'});
  await put('subjects', 41, {'name': 'ریاضی'});
  await put('subjects', 42, {'name': 'کارگاه برق', 'workshop': true});
  await put('users', 21, {'name': 'بهار', 'role': 'student', 'class_id': 5});
  await put('users', 22, {'name': 'آرش', 'role': 'student', 'class_id': 5});
  await put('users', 23, {'name': 'سارا', 'role': 'student', 'class_id': 5});
  await put('users', 31, {'name': 'کیان', 'role': 'student', 'class_id': 6});
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
  String role = 'teacher',
  int? savedUid = 10,
  bool online = true,
  String waves = 'login,attendance,grades',
  MemorySource? source,
  bool wireGrades = true,
  bool tall = true,
}) async {
  if (tall) tallView(tester);
  final src = source ?? MemorySource();
  await tester.runAsync(() => seed(src.engine));
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
      grades: wireGrades ? src : null,
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

/// Row 172: the web «نمره» page opens on the teacher's first class (class 5 here).
Future<void> openClass5(WidgetTester tester) async {
  await openPage(tester, 'grades');
  expect(find.byKey(const Key('grd-sheet')), findsOneWidget);
}

/// Picks [label] in the web select [key] (the choice applies with «نمایش»).
Future<void> pick(WidgetTester tester, String key, String label) async {
  await tester.ensureVisible(find.byKey(Key(key)));
  await tester.tap(find.byKey(Key(key)));
  await tester.pumpAndSettle();
  await tester.tap(find.text(label).last);
  await tester.pumpAndSettle();
}

/// What a screen reader hears for the score field of [sid].
String fieldLabel(WidgetTester tester, int sid) =>
    tester.getSemantics(find.byKey(Key('grd-$sid'))).getSemanticsData().label;

Future<void> type(WidgetTester tester, int sid, String v) async {
  await tester.ensureVisible(find.byKey(Key('grd-$sid')));
  await tester.enterText(find.byKey(Key('grd-$sid')), v);
  await tester.pump();
}

String textOf(WidgetTester tester, String key) =>
    tester.widget<Text>(find.byKey(Key(key))).data!;

String stateOf(WidgetTester tester, int sid) => tester
    .widget<Text>(
      find.descendant(
        of: find.byKey(Key('grd-state-$sid')),
        matching: find.byType(Text),
      ),
    )
    .data!;

String fieldOf(WidgetTester tester, int sid) =>
    tester.widget<TextField>(find.byKey(Key('grd-$sid'))).controller!.text;

void main() {
  testWidgets(
    'W3-W01 teacher: «نمره» page = web: own classes in «پایه / رشته», the scheduled subject, all «جدید»',
    (tester) async {
      await boot(tester);
      // Row 172: the web teacher navigation has «نمره» (and «حضور», same data path)
      expect(navOf('grades'), findsOneWidget);
      expect(navOf('attendance'), findsOneWidget);
      await openPage(tester, 'grades');
      // web `S.gradeSel`: no class list — the first own class is open from the start
      expect(find.byKey(const Key('grd-sheet')), findsOneWidget);
      expect(textOf(tester, 'grd-scale'), 'نمره از ۲۰');
      await tester.tap(find.byKey(const Key('grd-class')));
      await tester.pumpAndSettle();
      expect(find.text('دهم الف'), findsWidgets);
      // NEG: another teacher's class is not offered
      expect(find.text('یازدهم ب'), findsNothing);
      await tester.tap(find.text('دهم الف').last);
      await tester.pumpAndSettle();
      // default subject = the class's schedule row (web rule), term = نوبت اول
      expect(textOf(tester, 'grd-subject-name'), 'ریاضی');
      expect(find.text('نوبت اول'), findsWidgets);
      final rows = tester
          .widgetList(
            find.byWidgetPredicate((w) => '${w.key}'.contains("'grd-row-")),
          )
          .length;
      expect(rows, 3);
      expect(find.text('دانش‌آموز'), findsOneWidget);
      expect(find.text('ثبت نمرات'), findsOneWidget);
      for (final s in [21, 22, 23]) {
        expect(stateOf(tester, s), 'جدید');
        expect(fieldOf(tester, s), '');
      }
      expect(
        tester.getTopLeft(find.byKey(const Key('grd-22'))).dy,
        lessThan(tester.getTopLeft(find.byKey(const Key('grd-21'))).dy),
        reason: 'sorted by name like the web roster (آرش before بهار)',
      );
    },
  );

  testWidgets(
    'W3-W02 save: local first, queued, «در انتظار», AutoSync nudged; Persian digits ok',
    (tester) async {
      final (_, src) = await boot(tester);
      await openClass5(tester);
      await type(tester, 21, '۱۷');
      await type(tester, 22, '12.5');
      // the web button has no change count
      expect(find.text('ثبت نمرات'), findsOneWidget);
      await tapKey(tester, 'grd-save');
      expect(textOf(tester, 'grd-notice'), '۲ نمره ذخیره شد');
      expect(src.nudges, 1);
      final ops = src.outbox.list();
      expect(ops.length, 2);
      expect(ops.map((o) => o.payload!['status']).toSet(), {'pending'});
      expect(
        {for (final o in ops) o.payload!['student_id']: o.payload!['score']},
        {21: 17, 22: 12.5},
      );
      expect(stateOf(tester, 21), 'در انتظار');
      expect(stateOf(tester, 23), 'جدید');
      expect(fieldOf(tester, 21), '17');
    },
  );

  testWidgets(
    'W3-W03 NEG invalid score: named error, field marked, nothing queued',
    (tester) async {
      final h = tester.ensureSemantics();
      final (_, src) = await boot(tester);
      await openClass5(tester);
      await type(tester, 21, '18');
      await type(tester, 23, '25');
      await tapKey(tester, 'grd-save');
      expect(
        textOf(tester, 'grd-error'),
        'نمرهٔ نامعتبر برای یکی از دانش‌آموزان: سارا',
      );
      // marked: red border (web `.input` error look) + «نامعتبر» for screen readers
      expect(fieldLabel(tester, 23), contains('نامعتبر'));
      expect(fieldLabel(tester, 21), isNot(contains('نامعتبر')));
      expect(src.outbox.list(), isEmpty);
      expect(src.nudges, 0);
      // the typed values are kept for correction
      expect(fieldOf(tester, 21), '18');
      await type(tester, 23, '19');
      expect(fieldLabel(tester, 23), isNot(contains('نامعتبر')));
      await tapKey(tester, 'grd-save');
      expect(src.outbox.list().length, 2);
      h.dispose();
    },
  );

  testWidgets(
    'W3-W04 manager: no «نمره» page (web: «دسترسی ندارید»); the book still approves manager grades',
    (tester) async {
      final (_, src) = await boot(tester, role: 'manager');
      expect(navOf('grades'), findsNothing);
      final c = GradesController(source: src, role: 'manager', uid: 10);
      addTearDown(c.dispose);
      await tester.runAsync(c.load);
      expect(c.classes.map((k) => k.id).toSet(), {5, 6});
      expect(c.open?.id, 5);
      c.edit(22, '20');
      await tester.runAsync(c.save);
      expect(src.outbox.list().single.payload!['status'], 'approved');
      expect(
        c.sheet.firstWhere((e) => e.studentId == 22).state.labelFa,
        'تأییدشده',
      );
    },
  );

  testWidgets('W3-W05 NEG parent / student: no grade entry at all', (
    tester,
  ) async {
    for (final role in ['parent', 'student']) {
      await boot(tester, role: role);
      expect(navOf('grades'), findsNothing, reason: role);
      expect(find.text('ثبت نمره'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    }
  });

  testWidgets(
    'W3-W06 NEG wave off or no data path → no native «نمره», never a dead button',
    (tester) async {
      await boot(tester, waves: 'login,attendance');
      expect(navOf('grades'), findsNothing);
      // attendance (wave 2) is unaffected
      expect(navOf('attendance'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await boot(tester, wireGrades: false);
      expect(navOf('grades'), findsNothing);
    },
  );

  testWidgets(
    'W3-W07 NEG user id unknown on this device (never online) → no «نمره»',
    (tester) async {
      await boot(tester, savedUid: null, online: false);
      expect(navOf('grades'), findsNothing);
    },
  );

  testWidgets(
    'W3-W08 workshop subject = practical; «نمایش» with unsaved scores asks first',
    (tester) async {
      final (_, src) = await boot(tester);
      await openClass5(tester);
      await type(tester, 21, '15');
      await pick(tester, 'grd-subject', 'کارگاه برق');
      await tapKey(tester, 'grd-show');
      // unsaved field → confirmation; «ماندن» keeps the sheet and the text
      expect(find.text('نمره‌های ذخیره نشده'), findsOneWidget);
      await tapKey(tester, 'grd-discard-cancel');
      expect(textOf(tester, 'grd-scale'), 'نمره از ۲۰');
      expect(fieldOf(tester, 21), '15');
      await tapKey(tester, 'grd-show');
      await tapKey(tester, 'grd-discard-confirm');
      expect(textOf(tester, 'grd-scale'), 'درس کارگاهی — نمرهٔ عملی');
      expect(textOf(tester, 'grd-subject-name'), 'کارگاه برق');
      expect(fieldOf(tester, 21), '');
      await type(tester, 21, '16');
      await tapKey(tester, 'grd-save');
      final p = src.outbox.list().single.payload!;
      expect(p['subject_id'], 42);
      expect(p['kind'], 'practical');
      expect(p['practical_score'], 16);
    },
  );

  testWidgets(
    'W3-W09 term change reads another sheet; switching back with unsaved asks',
    (tester) async {
      final (_, src) = await boot(tester);
      await tester.runAsync(
        () => src.engine.put('grades', 501, {
          'id': 501,
          'student_id': 21,
          'class_id': 5,
          'subject_id': 41,
          'term': 'نوبت دوم',
          'score': 11,
          'status': 'approved',
        }),
      );
      await openClass5(tester);
      expect(fieldOf(tester, 21), '');
      await pick(tester, 'grd-term', 'نوبت دوم');
      await tapKey(tester, 'grd-show');
      expect(fieldOf(tester, 21), '11');
      expect(stateOf(tester, 21), 'تأییدشده');
      await type(tester, 22, '9');
      await pick(tester, 'grd-term', 'نوبت اول');
      await tapKey(tester, 'grd-show');
      expect(find.text('نمره‌های ذخیره نشده'), findsOneWidget);
      await tapKey(tester, 'grd-discard-confirm');
      expect(fieldOf(tester, 21), '');
      expect(fieldOf(tester, 22), '');
      expect(src.outbox.list(), isEmpty);
    },
  );

  testWidgets('W3-W10 NEG full outbox: clear message, nothing half-saved', (
    tester,
  ) async {
    final src = MemorySource(config: const OutboxConfig(capacity: 1));
    await boot(tester, source: src);
    await openClass5(tester);
    await type(tester, 21, '10');
    await type(tester, 22, '11');
    await tapKey(tester, 'grd-save');
    expect(textOf(tester, 'grd-error'), startsWith('صف ارسال پر است'));
    expect(src.outbox.list(), isEmpty);
    expect(await tester.runAsync(() => src.engine.count('grades')), 0);
  });

  testWidgets('W3-W11 a finished pull re-reads the open sheet', (tester) async {
    final (_, src) = await boot(tester);
    await openClass5(tester);
    expect(stateOf(tester, 23), 'جدید');
    await tester.runAsync(
      () => src.engine.put('grades', 502, {
        'id': 502,
        'student_id': 23,
        'class_id': 5,
        'subject_id': 41,
        'term': 'نوبت اول',
        'score': 14,
        'status': 'approved',
      }, version: 2),
    );
    src.bump.value++;
    await settle(tester);
    expect(stateOf(tester, 23), 'تأییدشده');
    expect(fieldOf(tester, 23), '14');
  });

  testWidgets(
    'W3-W12 a11y: each field is announced «نمره»; the review state is text, not colour',
    (tester) async {
      final h = tester.ensureSemantics();
      await boot(tester);
      await openClass5(tester);
      final f = tester.widget<TextField>(find.byKey(const Key('grd-21')));
      // web input: placeholder «—», no visible label
      expect(f.decoration!.hintText, '—');
      expect(
        f.keyboardType,
        const TextInputType.numberWithOptions(decimal: true),
      );
      expect(fieldLabel(tester, 21), contains('نمره'));
      expect(stateOf(tester, 21), 'جدید');
      expect(find.bySemanticsLabel(RegExp('نمره')), findsWidgets);
      h.dispose();
    },
  );

  group('GatewayAttendanceSource serves grades (production wiring, network-free)', () {
    HttpClient offlineClient() =>
        HttpClient()
          ..connectionFactory = (uri, host, port) =>
              Future.error(const SocketException('offline (test)'));

    test(
      'W3-S01 signed in → grade book on the same database; none after sign-out',
      () async {
        final e = SqliteEngine.inMemory();
        final c = SessionController(
          api: FakeAccess([FakeAccess.session('teacher')]),
          accounts: SchoolAccountStore(await savedSchool()),
          flags: ClientFlags.parse(),
          now: () => today,
        );
        final src = GatewayAttendanceSource(
          storage: Future.value(e),
          session: c,
          client: offlineClient(),
        )..attach();
        await c.start();
        final g = await src.gradeBookFor(role: 'teacher', uid: 10);
        expect(g, isNotNull);
        expect(g!.engine, same(e));
        expect(DeviceOwner.read(e), 'alborz-12/10');
        // one outbox for both pages: an attendance op and a grade op share the queue
        final a = await src.bookFor(role: 'teacher', uid: 10);
        expect(a!.outbox, same(g.outbox));
        await c.signOut();
        await Future<void>.delayed(const Duration(milliseconds: 50));
        expect(await src.gradeBookFor(role: 'teacher', uid: 10), isNull);
        await src.dispose();
        c.dispose();
      },
    );

    test('W3-S02 NEG another user\'s unsent writes block the grade book too', () async {
      final e = SqliteEngine.inMemory();
      await seed(e);
      e.database.execute(
        "INSERT INTO meta (key, value) VALUES ('device.owner', 'alborz-12/99')",
      );
      SqliteOutbox(e.database).enqueue({
        'collection': 'grades',
        'type': 'put',
        'id': 1,
        'data': {'student_id': 21},
      });
      final c = SessionController(
        api: FakeAccess([FakeAccess.session('teacher')]),
        accounts: SchoolAccountStore(await savedSchool()),
        flags: ClientFlags.parse(),
        now: () => today,
      );
      final src = GatewayAttendanceSource(
        storage: Future.value(e),
        session: c,
        client: offlineClient(),
      )..attach();
      await c.start();
      expect(await src.gradeBookFor(role: 'teacher', uid: 10), isNull);
      expect(c.sync.value.phase, SyncPhase.attention);
      expect(await e.count('grades'), 0);
      expect(await e.count('users'), 4);
      await src.dispose();
      c.dispose();
    });
  });
}
