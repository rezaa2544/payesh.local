// Row 74, wave 4 — notices. Widget tests drive the REAL screens, the REAL controller and the REAL
// NoticeBoard on a real (in-memory) SQLite + durable outbox; only the Gateway is absent (the real
// Gateway + PostgreSQL path is packages/payesh_sync/test/notices_it_test.dart).
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/app.dart';
import 'package:payesh_app/src/attendance/attendance_controller.dart';
import 'package:payesh_app/src/attendance/attendance_wiring.dart';
import 'package:payesh_app/src/flags.dart';
import 'package:payesh_app/src/grades/grades_controller.dart';
import 'package:payesh_app/src/login/session_controller.dart';
import 'package:payesh_app/src/notices/notices_controller.dart';
import 'package:payesh_data/payesh_data.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_sync/payesh_sync.dart';

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

/// In-memory data source with the real books (all waves share it, like production).
base class MemorySource implements AttendanceSource, GradeSource, NoticeSource {
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
  }) async => NoticeBoard(
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

/// The board is not ready (null) or reading it fails (throws).
final class BrokenSource extends MemorySource {
  BrokenSource({this.missing = false});
  final bool missing;

  @override
  Future<NoticeBoard?> noticeBoardFor({
    required String role,
    required int uid,
  }) async => missing ? null : throw StateError('disk (test)');
}

Future<void> seed(SqliteEngine e) async {
  Future<void> put(int id, Map<String, Object?> d, [int v = 1]) =>
      e.put('announcements', id, {...d, 'id': id}, version: v);
  await put(1, {
    'title': 'اردوی پاییزه',
    'body': 'ثبت‌نام تا پنجشنبه',
    'severity': 'info',
    'date': '2026-11-01',
  });
  await put(2, {
    'title': 'تعطیلی',
    'body': 'مدرسه شنبه تعطیل است',
    'severity': 'important',
    'date': '2026-11-09',
  }, 3);
  await put(3, {
    'title': 'جلسهٔ اولیا',
    'body': 'سه‌شنبه ساعت ۱۰',
    'severity': 'normal',
    'date': '2026-11-10',
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
  String role = 'manager',
  int? savedUid = 10,
  bool online = true,
  String waves = 'login,attendance,grades,notices',
  MemorySource? source,
  bool wireNotices = true,
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
    PayeshApp(
      session: c,
      attendance: src,
      grades: src,
      notices: wireNotices ? src : null,
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

List<int> cardOrder(WidgetTester tester) {
  final cards = tester.widgetList<Card>(find.byType(Card)).toList();
  return [
    for (final c in cards)
      if (c.key case ValueKey<String>(:final value)
          when value.startsWith('ntc-card-'))
        int.parse(value.substring('ntc-card-'.length)),
  ];
}

Future<void> fill(WidgetTester tester, String title, String body) async {
  await tester.enterText(find.byKey(const Key('ntc-title')), title);
  await tester.enterText(find.byKey(const Key('ntc-body')), body);
  await tester.pump();
}

void main() {
  testWidgets(
    'W4-W01 teacher: entry → notices newest first, severity labels; no write controls (negative)',
    (tester) async {
      await boot(tester, role: 'teacher');
      expect(find.byKey(const Key('ntc-entry')), findsOneWidget);
      // earlier waves are still there — one data path
      expect(find.byKey(const Key('att-entry')), findsOneWidget);
      expect(find.byKey(const Key('grd-entry')), findsOneWidget);
      await tapKey(tester, 'ntc-entry');
      expect(textOf(tester, 'ntc-count'), '۳ مورد');
      expect(cardOrder(tester), [3, 2, 1]);
      expect(badgeOf(tester, 'ntc-sev-2'), 'مهم');
      expect(badgeOf(tester, 'ntc-sev-1'), 'اطلاع‌رسانی');
      expect(badgeOf(tester, 'ntc-sev-3'), 'عادی');
      expect(find.byKey(const Key('ntc-date-2')), findsOneWidget);
      expect(textOf(tester, 'ntc-body-2'), 'مدرسه شنبه تعطیل است');
      // NEG: a teacher gets no publish / edit / delete controls
      expect(find.byKey(const Key('ntc-add')), findsNothing);
      expect(find.byKey(const Key('ntc-edit-2')), findsNothing);
      expect(find.byKey(const Key('ntc-delete-2')), findsNothing);
    },
  );

  testWidgets(
    'W4-W02 manager publish: local first, queued badge, AutoSync nudged, newest on top',
    (tester) async {
      final (_, src) = await boot(tester);
      await tapKey(tester, 'ntc-entry');
      await tapKey(tester, 'ntc-add');
      expect(find.text('اطلاعیهٔ جدید'), findsOneWidget);
      await fill(tester, ' امتحان ریاضی ', 'شنبه ساعت ۸');
      await tapKey(tester, 'ntc-sev-opt-important');
      await tapKey(tester, 'ntc-submit');
      // editor closed, back on the list
      expect(find.byKey(const Key('ntc-title')), findsNothing);
      expect(textOf(tester, 'ntc-notice'), 'اطلاعیه منتشر شد');
      expect(src.nudges, 1);
      final op = src.outbox.list().single;
      expect(op.type, 'put');
      expect(op.baseVersion, 0);
      expect(op.payload, {
        'id': op.id,
        'title': 'امتحان ریاضی',
        'body': 'شنبه ساعت ۸',
        'severity': 'important',
        'date': '2026-11-12',
        'author_id': 10,
      });
      expect(cardOrder(tester).first, op.id);
      expect(badgeOf(tester, 'ntc-queued-${op.id}'), 'در صف ارسال');
      expect(find.byKey(const Key('ntc-queued-2')), findsNothing);
      expect(textOf(tester, 'ntc-count'), '۴ مورد');
    },
  );

  testWidgets(
    'W4-W03 empty title / body: refused in the editor, text kept, nothing queued (negative)',
    (tester) async {
      final (_, src) = await boot(tester);
      await tapKey(tester, 'ntc-entry');
      await tapKey(tester, 'ntc-add');
      await fill(tester, '   ', 'متن');
      await tapKey(tester, 'ntc-submit');
      expect(textOf(tester, 'ntc-form-error'), 'عنوان اطلاعیه را بنویسید');
      expect(find.byKey(const Key('ntc-title')), findsOneWidget);
      await fill(tester, 'عنوان', '');
      await tapKey(tester, 'ntc-submit');
      expect(textOf(tester, 'ntc-form-error'), 'متن اطلاعیه را بنویسید');
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('ntc-title')))
            .controller!
            .text,
        'عنوان',
      );
      expect(src.outbox.list(), isEmpty);
      expect(src.nudges, 0);
    },
  );

  testWidgets(
    'W4-W04 manager edit: prefilled, date kept, base = version; unchanged → «تغییری نبود»',
    (tester) async {
      final (_, src) = await boot(tester);
      await tapKey(tester, 'ntc-entry');
      await tapKey(tester, 'ntc-edit-2');
      expect(find.text('ویرایش اطلاعیه'), findsOneWidget);
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('ntc-title')))
            .controller!
            .text,
        'تعطیلی',
      );
      // unchanged save writes nothing
      await tapKey(tester, 'ntc-submit');
      expect(textOf(tester, 'ntc-notice'), 'تغییری نبود');
      expect(src.outbox.list(), isEmpty);
      expect(src.nudges, 0);
      await tapKey(tester, 'ntc-edit-2');
      await fill(tester, 'تعطیلی رسمی', 'شنبه و یکشنبه تعطیل است');
      await tapKey(tester, 'ntc-submit');
      expect(textOf(tester, 'ntc-notice'), 'اطلاعیه ویرایش شد');
      final op = src.outbox.list().single;
      expect(op.id, 2);
      expect(op.baseVersion, 3);
      expect(op.payload!['date'], '2026-11-09');
      expect(op.payload!['severity'], 'important');
      expect(textOf(tester, 'ntc-body-2'), 'شنبه و یکشنبه تعطیل است');
      expect(cardOrder(tester), [
        3,
        2,
        1,
      ], reason: 'date unchanged → same place');
      expect(src.nudges, 1);
    },
  );

  testWidgets(
    'W4-W05 delete asks first: cancel keeps it (negative), confirm queues a tombstone',
    (tester) async {
      final (_, src) = await boot(tester);
      await tapKey(tester, 'ntc-entry');
      await tapKey(tester, 'ntc-delete-1');
      expect(find.text('اطلاعیهٔ «اردوی پاییزه» حذف شود؟'), findsOneWidget);
      await tapKey(tester, 'ntc-delete-cancel');
      expect(cardOrder(tester), [3, 2, 1]);
      expect(src.outbox.list(), isEmpty);
      await tapKey(tester, 'ntc-delete-1');
      await tapKey(tester, 'ntc-delete-confirm');
      expect(textOf(tester, 'ntc-notice'), 'اطلاعیه حذف شد');
      expect(cardOrder(tester), [3, 2]);
      final op = src.outbox.list().single;
      expect(op.type, 'del');
      expect(op.id, 1);
      expect(src.nudges, 1);
    },
  );

  testWidgets(
    'W4-W06 flag / source / role gates: legacy line, wait line, none — never a dead button (negative)',
    (tester) async {
      await boot(tester, waves: 'login,attendance,grades');
      expect(
        textOf(tester, 'ntc-entry-legacy'),
        'اطلاعیه‌ها فعلاً در نسخهٔ وب نمایش داده می‌شود.',
      );
      expect(find.byKey(const Key('ntc-entry')), findsNothing);
      await tester.pumpWidget(const SizedBox());
      await boot(tester, wireNotices: false);
      expect(find.byKey(const Key('ntc-entry-legacy')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await boot(tester, role: 'janitor');
      expect(find.byKey(const Key('ntc-entry')), findsNothing);
      expect(find.byKey(const Key('ntc-entry-legacy')), findsNothing);
    },
  );

  testWidgets(
    'W4-W07 parent reads the notices (read: all) with no write controls',
    (tester) async {
      await boot(tester, role: 'parent', savedUid: 40);
      expect(find.byKey(const Key('ntc-entry')), findsOneWidget);
      // NEG: the earlier waves are teacher/manager pages — not offered to a parent
      expect(find.byKey(const Key('grd-entry')), findsNothing);
      await tapKey(tester, 'ntc-entry');
      expect(cardOrder(tester), [3, 2, 1]);
      expect(find.byKey(const Key('ntc-add')), findsNothing);
      expect(find.byKey(const Key('ntc-delete-3')), findsNothing);
    },
  );

  testWidgets(
    'W4-W08 leaving the editor with unsaved text asks; «ماندن» keeps it (negative)',
    (tester) async {
      final (_, src) = await boot(tester);
      await tapKey(tester, 'ntc-entry');
      await tapKey(tester, 'ntc-add');
      await fill(tester, 'پیش‌نویس', 'متن');
      await tapKey(tester, 'ntc-editor-back');
      await tapKey(tester, 'ntc-discard-cancel');
      expect(find.byKey(const Key('ntc-title')), findsOneWidget);
      await tapKey(tester, 'ntc-editor-back');
      await tapKey(tester, 'ntc-discard-confirm');
      expect(find.byKey(const Key('ntc-title')), findsNothing);
      expect(cardOrder(tester), [3, 2, 1]);
      expect(src.outbox.list(), isEmpty);
      // an untouched editor leaves without asking
      await tapKey(tester, 'ntc-add');
      await tapKey(tester, 'ntc-editor-back');
      expect(find.byKey(const Key('ntc-discard-confirm')), findsNothing);
      expect(find.byKey(const Key('ntc-title')), findsNothing);
    },
  );

  testWidgets(
    'W4-W09 full queue: the editor says so and nothing is written (negative)',
    (tester) async {
      final (_, src) = await boot(
        tester,
        source: MemorySource(config: const OutboxConfig(capacity: 0)),
      );
      await tapKey(tester, 'ntc-entry');
      await tapKey(tester, 'ntc-add');
      await fill(tester, 'عنوان', 'متن');
      await tapKey(tester, 'ntc-submit');
      expect(
        textOf(tester, 'ntc-form-error'),
        'صف ارسال پر است — پیش از ثبت تازه، اتصال را برقرار کنید',
      );
      expect(await tester.runAsync(() => src.engine.count('announcements')), 3);
      expect(src.nudges, 0);
    },
  );

  testWidgets(
    'W4-W10 a pull that brings a new notice refreshes the open page',
    (tester) async {
      final (_, src) = await boot(tester, role: 'teacher');
      await tapKey(tester, 'ntc-entry');
      expect(cardOrder(tester), [3, 2, 1]);
      await tester.runAsync(
        () => src.engine.put('announcements', 7, {
          'id': 7,
          'title': 'تازه از سرور',
          'body': 'x',
          'date': '2026-11-12',
        }),
      );
      src.bump.value++;
      await settle(tester);
      expect(cardOrder(tester), [7, 3, 2, 1]);
      expect(textOf(tester, 'ntc-count'), '۴ مورد');
    },
  );

  testWidgets(
    'W4-W11 the local board is not ready or fails: an error, no empty-list claim (negative)',
    (tester) async {
      for (final (src, msg) in [
        (BrokenSource(missing: true), 'پایگاه محلی هنوز آماده نیست'),
        (BrokenSource(), 'خواندن دادهٔ محلی ناموفق بود'),
      ]) {
        await boot(tester, role: 'teacher', source: src);
        await tapKey(tester, 'ntc-entry');
        expect(textOf(tester, 'ntc-error'), msg);
        expect(find.byKey(const Key('ntc-empty')), findsNothing);
        expect(find.byType(Card), findsNothing);
        await tapKey(tester, 'ntc-back');
        expect(find.byKey(const Key('ntc-entry')), findsOneWidget);
      }
    },
  );

  testWidgets(
    'W4-W12 no notices: an explicit empty state; system back in the editor still asks',
    (tester) async {
      final src = MemorySource();
      final (_, _) = await boot(tester, source: src);
      await tester.runAsync(() async {
        for (final id in [1, 2, 3]) {
          await src.engine.put('announcements', id, {
            'id': id,
            'deleted': true,
          }, version: 9);
        }
      });
      await tapKey(tester, 'ntc-entry');
      expect(find.byKey(const Key('ntc-empty')), findsOneWidget);
      expect(textOf(tester, 'ntc-count'), '۰ مورد');
      await tapKey(tester, 'ntc-add');
      await fill(tester, 'پیش‌نویس', 'متن');
      await tester.binding.handlePopRoute();
      await settle(tester);
      expect(find.byKey(const Key('ntc-discard-confirm')), findsOneWidget);
      await tapKey(tester, 'ntc-discard-confirm');
      expect(find.byKey(const Key('ntc-empty')), findsOneWidget);
    },
  );

  testWidgets(
    'W4-W13 delete with a full queue: page error, the notice stays (negative)',
    (tester) async {
      final (_, src) = await boot(
        tester,
        source: MemorySource(config: const OutboxConfig(capacity: 0)),
      );
      await tapKey(tester, 'ntc-entry');
      await tapKey(tester, 'ntc-delete-2');
      await tapKey(tester, 'ntc-delete-confirm');
      expect(
        textOf(tester, 'ntc-error'),
        'صف ارسال پر است — پیش از ثبت تازه، اتصال را برقرار کنید',
      );
      expect(cardOrder(tester), [3, 2, 1]);
      expect(src.outbox.list(), isEmpty);
      expect(src.nudges, 0);
    },
  );

  group(
    'GatewayAttendanceSource serves notices (production wiring, network-free)',
    () {
      HttpClient offlineClient() =>
          HttpClient()
            ..connectionFactory = (uri, host, port) =>
                Future.error(const SocketException('offline (test)'));

      Future<(SqliteEngine, SessionController, GatewayAttendanceSource)> wire(
        SqliteEngine e,
        String role,
      ) async {
        final c = SessionController(
          api: FakeAccess([FakeAccess.session(role)]),
          accounts: SchoolAccountStore(await savedSchool(role: role)),
          flags: ClientFlags.parse(),
          now: () => today,
        );
        final src = GatewayAttendanceSource(
          storage: Future.value(e),
          session: c,
          client: offlineClient(),
        )..attach();
        await c.start();
        return (e, c, src);
      }

      test('W4-S01 signed in → notice board on the shared database and outbox; none after sign-out', () async {
        final (e, c, src) = await wire(SqliteEngine.inMemory(), 'manager');
        final b = await src.noticeBoardFor(role: 'manager', uid: 10);
        expect(b, isNotNull);
        expect(b!.engine, same(e));
        final g = await src.gradeBookFor(role: 'manager', uid: 10);
        expect(b.outbox, same(g!.outbox));
        expect(DeviceOwner.read(e), 'alborz-12/10');
        final r = await b.publish(title: 'عنوان', body: 'متن');
        expect(r.key, isNotNull);
        src.queued(); // nudges the real AutoSync; offline → stays queued
        expect(b.outbox.list(), hasLength(1));
        await c.signOut();
        await Future<void>.delayed(const Duration(milliseconds: 50));
        expect(await src.noticeBoardFor(role: 'manager', uid: 10), isNull);
        await src.dispose();
        c.dispose();
      });

      test(
        'W4-S02 NEG another user\'s unsent writes block the notice board',
        () async {
          final e = SqliteEngine.inMemory();
          await seed(e);
          e.database.execute(
            "INSERT INTO meta (key, value) VALUES ('device.owner', 'alborz-12/99')",
          );
          SqliteOutbox(e.database).enqueue({
            'collection': 'announcements',
            'type': 'put',
            'id': 1,
            'data': {'title': 'x'},
          });
          final (_, c, src) = await wire(e, 'teacher');
          expect(await src.noticeBoardFor(role: 'teacher', uid: 10), isNull);
          expect(c.sync.value.phase, SyncPhase.attention);
          await src.dispose();
          c.dispose();
        },
      );
    },
  );
}
