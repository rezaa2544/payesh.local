// Row 74, wave 2 — attendance. Widget tests drive the REAL screens, the REAL controller and the
// REAL AttendanceBook on a real (in-memory) SQLite + durable outbox; only the Gateway is absent
// (the real Gateway + PostgreSQL path is packages/payesh_sync/test/attendance_it_test.dart).
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/app.dart';
import 'package:payesh_app/src/attendance/attendance_controller.dart';
import 'package:payesh_app/src/attendance/attendance_wiring.dart';
import 'package:payesh_app/src/flags.dart';
import 'package:payesh_app/src/login/session_controller.dart';
import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_sync/payesh_sync.dart';

const secret32 = 'QRSTUVWXYZ234567ABCDEFGHIJKLMNOP';
final today = DateTime.utc(2026, 11, 12, 8);
const day = '2026-11-12';

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

/// In-memory data source with the real book; counts AutoSync nudges.
final class MemorySource implements AttendanceSource {
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
  void queued() => nudges++;

  @override
  Listenable get changed => bump;
}

Future<void> seed(SqliteEngine e) async {
  Future<void> put(String c, int id, Map<String, Object?> d, [int v = 1]) =>
      e.put(c, id, {...d, 'id': id}, version: v);
  await put('classes', 5, {'name': 'دهم الف'});
  await put('classes', 6, {'name': 'یازدهم ب'});
  await put('schedule', 900, {'teacher_id': 10, 'class_id': 5});
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
  String waves = 'login,attendance',
  MemorySource? source,
}) async {
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
    PayeshApp(session: c, attendance: src, today: () => today),
  );
  await c.start();
  await tester.pumpAndSettle();
  return (c, src);
}

/// Runs real SQLite work (outside the fake clock) and settles the UI.
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

Future<void> openClass5(WidgetTester tester) async {
  await tapKey(tester, 'att-entry');
  await tapKey(tester, 'att-class-5');
}

bool chipOn(WidgetTester tester, int sid, String wire) =>
    tester.widget<ChoiceChip>(find.byKey(Key('att-$sid-$wire'))).selected;

String textOf(WidgetTester tester, String key) =>
    tester.widget<Text>(find.byKey(Key(key))).data!;

void main() {
  testWidgets(
    'W2-W01 teacher: entry → own classes with «ثبت نشده» → roster, default حاضر',
    (tester) async {
      await boot(tester);
      expect(find.byKey(const Key('att-entry')), findsOneWidget);
      await tapKey(tester, 'att-entry');
      expect(find.byKey(const Key('att-class-5')), findsOneWidget);
      // NEG: another teacher's class is not listed
      expect(find.byKey(const Key('att-class-6')), findsNothing);
      expect(find.text('ثبت نشده'), findsOneWidget);
      await tapKey(tester, 'att-class-5');
      expect(find.text('دهم الف'), findsWidgets);
      // sorted like the web roster; every student starts at present
      final rows = tester
          .widgetList<Card>(
            find.byWidgetPredicate(
              (w) => w is Card && '${w.key}'.contains('att-row-'),
            ),
          )
          .map((w) => '${w.key}')
          .toList();
      expect(rows, [
        "[<'att-row-22'>]",
        "[<'att-row-21'>]",
        "[<'att-row-23'>]",
      ]);
      for (final s in [21, 22, 23]) {
        expect(chipOn(tester, s, 'present'), isTrue);
        expect(chipOn(tester, s, 'absent'), isFalse);
      }
      for (final l in ['حاضر', 'غایب', 'تأخیر', 'خروج', 'موجه']) {
        expect(find.text(l), findsNWidgets(3));
      }
    },
  );

  testWidgets(
    'W2-W02 mark + save offline: written locally, queued, نوتیس like the web toast',
    (tester) async {
      final (_, src) = await boot(tester);
      await openClass5(tester);
      await tapKey(tester, 'att-21-absent');
      await tapKey(tester, 'att-23-late');
      expect(chipOn(tester, 21, 'absent'), isTrue);
      expect(chipOn(tester, 21, 'present'), isFalse);
      await tapKey(tester, 'att-save');
      expect(textOf(tester, 'att-notice'), '۳ رکورد ذخیره شد');
      final ops = src.outbox.list();
      expect(ops.length, 3);
      expect(
        {for (final o in ops) o.payload!['student_id']: o.payload!['status']},
        {21: 'absent', 22: 'present', 23: 'late'},
      );
      expect(src.nudges, 1);
      // after saving, the chips show the stored state
      expect(chipOn(tester, 21, 'absent'), isTrue);
      expect(find.byKey(const Key('att-row-new')), findsNothing);
      // back to the list: the class is now «ثبت شده»
      await tapKey(tester, 'att-back');
      expect(find.text('ثبت شده'), findsOneWidget);
    },
  );

  testWidgets(
    'W2-W03 NEG saving with nothing changed → «تغییری نبود», nothing queued',
    (tester) async {
      final (_, src) = await boot(tester);
      await openClass5(tester);
      await tapKey(tester, 'att-save');
      expect(src.outbox.list().length, 3);
      await tapKey(tester, 'att-save');
      expect(textOf(tester, 'att-notice'), 'تغییری نبود');
      expect(src.outbox.list().length, 3);
      expect(src.nudges, 1);
    },
  );

  testWidgets(
    'W2-W04 a pulled record is preselected and only real changes are sent',
    (tester) async {
      final src = MemorySource();
      await tester.runAsync(
        () => src.engine.put('attendance', 501, {
          'id': 501,
          'student_id': 22,
          'class_id': 5,
          'date': day,
          'status': 'late',
        }, version: 3),
      );
      await boot(tester, source: src);
      await openClass5(tester);
      expect(chipOn(tester, 22, 'late'), isTrue);
      await tapKey(tester, 'att-22-excused');
      await tapKey(tester, 'att-save');
      final op = src.outbox.list().firstWhere((o) => o.id == 501);
      expect(op.baseVersion, 3);
      expect(op.payload!['status'], 'excused');
    },
  );

  testWidgets('W2-W05 NEG parent / student: no attendance entry at all', (
    tester,
  ) async {
    for (final r in ['parent', 'student']) {
      await boot(tester, role: r);
      expect(find.byKey(const Key('att-entry')), findsNothing, reason: r);
      expect(find.byKey(const Key('att-entry-none')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    }
  });

  testWidgets(
    'W2-W06 NEG wave flag off: the old (web) client keeps attendance',
    (tester) async {
      await boot(tester, waves: 'login');
      expect(find.byKey(const Key('att-entry')), findsNothing);
      expect(find.byKey(const Key('att-entry-legacy')), findsOneWidget);
    },
  );

  testWidgets(
    'W2-W07 NEG offline before the first refresh and no saved user id: no dead button',
    (tester) async {
      await boot(tester, online: false, savedUid: null);
      expect(find.byKey(const Key('att-entry')), findsNothing);
      expect(find.byKey(const Key('att-entry-wait')), findsOneWidget);
    },
  );

  testWidgets(
    'W2-W08 offline with a saved user id: attendance still works (offline-first)',
    (tester) async {
      final (c, src) = await boot(tester, online: false);
      expect(c.sync.value.phase, SyncPhase.offline);
      await openClass5(tester);
      await tapKey(tester, 'att-22-absent');
      await tapKey(tester, 'att-save');
      expect(src.outbox.list().length, 3);
    },
  );

  testWidgets(
    'W2-W09 the badge shows the outbox: queued, offline and needs-review counts',
    (tester) async {
      final (c, _) = await boot(tester);
      await openClass5(tester);
      c.publishOutbox(
        const SyncStatus(
          phase: SyncPhase.queued,
          pending: 3,
          inflight: 0,
          blocked: 0,
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('3 مورد در صف ارسال'), findsOneWidget);
      expect(find.byKey(const Key('sync-queued')), findsOneWidget);
      c.publishOutbox(
        const SyncStatus(
          phase: SyncPhase.offline,
          pending: 3,
          inflight: 0,
          blocked: 0,
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('آفلاین — 3 مورد در صف ارسال'), findsOneWidget);
      c.publishOutbox(
        const SyncStatus(
          phase: SyncPhase.attention,
          pending: 0,
          inflight: 0,
          blocked: 1,
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('sync-attention')), findsOneWidget);
    },
  );

  testWidgets(
    'W2-W10 NEG back with unsaved marks asks first; «ماندن» keeps them',
    (tester) async {
      final (_, src) = await boot(tester);
      await openClass5(tester);
      await tapKey(tester, 'att-21-absent');
      await tapKey(tester, 'att-back');
      expect(find.byKey(const Key('att-discard-confirm')), findsOneWidget);
      await tapKey(tester, 'att-discard-cancel');
      expect(chipOn(tester, 21, 'absent'), isTrue);
      await tapKey(tester, 'att-back');
      await tapKey(tester, 'att-discard-confirm');
      expect(find.byKey(const Key('att-class-5')), findsOneWidget);
      expect(src.outbox.list(), isEmpty);
    },
  );

  testWidgets('W2-W11 NEG full outbox: clear message, nothing half-saved', (
    tester,
  ) async {
    final src = MemorySource(config: const OutboxConfig(capacity: 2));
    await boot(tester, source: src);
    await openClass5(tester);
    await tapKey(tester, 'att-save');
    expect(textOf(tester, 'att-error'), contains('صف ارسال پر است'));
    expect(src.outbox.list(), isEmpty);
    expect(src.nudges, 0);
  });

  testWidgets('W2-W12 a finished pull re-reads the page (new class appears)', (
    tester,
  ) async {
    final (_, src) = await boot(tester);
    await tapKey(tester, 'att-entry');
    expect(find.byKey(const Key('att-class-6')), findsNothing);
    await tester.runAsync(
      () => src.engine.put('schedule', 901, {
        'id': 901,
        'teacher_id': 10,
        'class_id': 6,
      }),
    );
    src.bump.value++;
    await settle(tester);
    expect(find.byKey(const Key('att-class-6')), findsOneWidget);
  });

  testWidgets(
    'W2-W13 sign-out warns when writes are still unsent (and not otherwise)',
    (tester) async {
      final (c, _) = await boot(tester);
      Future<void> openDialog() async {
        await tapKey(tester, 'session-menu');
        await tapKey(tester, 'sign-out');
      }

      await openDialog();
      expect(find.byKey(const Key('sign-out-unsent')), findsNothing);
      await tapKey(tester, 'sign-out-cancel');
      c.publishOutbox(
        const SyncStatus(
          phase: SyncPhase.queued,
          pending: 2,
          inflight: 1,
          blocked: 0,
        ),
      );
      await tester.pumpAndSettle();
      await openDialog();
      expect(textOf(tester, 'sign-out-unsent'), startsWith('۳ ثبت'));
      await tapKey(tester, 'sign-out-cancel');
    },
  );

  testWidgets(
    'W2-W14 a11y: chips carry the student name + status; status is text, not colour',
    (tester) async {
      final h = tester.ensureSemantics();
      await boot(tester);
      await openClass5(tester);
      final chip = tester.widget<ChoiceChip>(
        find.byKey(const Key('att-21-absent')),
      );
      expect(chip.tooltip, 'بهار: غایب');
      expect((chip.label as Text).data, 'غایب');
      expect(chip.avatar, isA<Icon>());
      h.dispose();
    },
  );

  group('GatewayAttendanceSource (production wiring, network-free)', () {
    HttpClient offlineClient() =>
        HttpClient()
          ..connectionFactory = (uri, host, port) =>
              Future.error(const SocketException('offline (test)'));

    Future<(SessionController, GatewayAttendanceSource, SqliteEngine)> wire({
      required SqliteEngine engine,
      String role = 'teacher',
      int uid = 10,
    }) async {
      final c = SessionController(
        api: FakeAccess([FakeAccess.session(role, uid: uid)]),
        accounts: SchoolAccountStore(await savedSchool(role: role, uid: uid)),
        flags: ClientFlags.parse(),
        now: () => today,
      );
      final src = GatewayAttendanceSource(
        storage: Future.value(engine),
        session: c,
        client: offlineClient(),
      )..attach();
      await c.start();
      return (c, src, engine);
    }

    test(
      'W2-S01 signed in → device claimed for school/uid, book available',
      () async {
        final e = SqliteEngine.inMemory();
        final (c, src, _) = await wire(engine: e);
        final b = await src.bookFor(role: 'teacher', uid: 10);
        expect(b, isNotNull);
        expect(DeviceOwner.read(e), 'alborz-12/10');
        await c.signOut();
        await Future<void>.delayed(const Duration(milliseconds: 50));
        expect(
          await src.bookFor(role: 'teacher', uid: 10),
          isNull,
          reason: 'stopped after sign-out',
        );
        await src.dispose();
        c.dispose();
      },
    );

    test('W2-S02 NEG unsent writes of another user: sync blocked, badge needs review, no wipe', () async {
      final e = SqliteEngine.inMemory();
      await seed(e);
      e.database.execute(
        "INSERT INTO meta (key, value) VALUES ('device.owner', 'alborz-12/99')",
      );
      SqliteOutbox(e.database).enqueue({
        'collection': 'attendance',
        'type': 'put',
        'id': 1,
        'data': {'student_id': 21},
      });
      final (c, src, _) = await wire(engine: e);
      expect(await src.bookFor(role: 'teacher', uid: 10), isNull);
      expect(c.sync.value.phase, SyncPhase.attention);
      expect(c.sync.value.lastError, contains('کاربر دیگری'));
      expect(await e.count('users'), 4);
      expect(DeviceOwner.read(e), 'alborz-12/99');
      await src.dispose();
      c.dispose();
    });

    test('W2-S03 user switch with nothing unsent: old rows wiped before the new pull', () async {
      final e = SqliteEngine.inMemory();
      await seed(e);
      e.database.execute(
        "INSERT INTO meta (key, value) VALUES ('device.owner', 'alborz-12/99')",
      );
      final (c, src, _) = await wire(engine: e);
      expect(await src.bookFor(role: 'teacher', uid: 10), isNotNull);
      expect(await e.count('users'), 0);
      expect(DeviceOwner.read(e), 'alborz-12/10');
      await src.dispose();
      c.dispose();
    });

    test('W2-S04 the Gateway unreachable: the outbox status reaches the session badge', () async {
      final e = SqliteEngine.inMemory();
      final (c, src, _) = await wire(engine: e);
      await src.bookFor(role: 'teacher', uid: 10);
      await src.retry();
      expect(c.sync.value.phase, SyncPhase.offline);
      expect(c.sync.value.lastError, isNotNull);
      await c.signOut();
      await src.dispose();
      c.dispose();
    });
  });
}
