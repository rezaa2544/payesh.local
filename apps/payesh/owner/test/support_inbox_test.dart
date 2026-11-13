import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_owner/src/net/resilience.dart';
import 'package:payesh_owner/src/pages/support_page.dart';
import 'package:payesh_owner/src/schools/school_registry.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'support/fake_bucket.dart';

/// صندوق پشتیبانی پنل مالک (ردیف ۱۵۲): قرارداد support v1 مشترک با server/support.js.
void main() {
  final vectors = jsonDecode(
    File('../../../docs/cloud/contracts/support-vectors.json')
        .readAsStringSync(),
  ) as Map<String, Object?>;

  List<int> hex(String h) => [
    for (var i = 0; i < h.length; i += 2)
      int.parse(h.substring(i, i + 2), radix: 16),
  ];

  group('قرارداد support v1 (همان بایت‌های Node)', () {
    final cases = vectors['cases']! as Map<String, Object?>;
    final kinds = vectors['kinds']! as Map<String, Object?>;
    for (final name in cases.keys) {
      test('پاکت $name', () async {
        final c = cases[name]! as Map<String, Object?>;
        final plain =
            jsonDecode(c['plaintext']! as String) as Map<String, Object?>;
        final sealed = await sealSchools(
          vectors['secret']! as String,
          kinds[name]! as String,
          vectors['rev']! as int,
          plain,
          nonce: hex(vectors['nonce_hex']! as String),
        );
        expect(jsonEncode(plain), c['plaintext']);
        expect(jsonDecode(sealed), c['envelope']);
        final back = await openSchools(
          vectors['secret']! as String,
          kinds[name]! as String,
          jsonEncode(c['envelope']),
        );
        expect(back!.plain, plain);
      });
    }

    test('ثابت‌ها: نوع‌ها، پوشه‌ها، دسته‌ها، وضعیت‌ها، شناسه', () {
      expect(vectors['salt'], schoolsSalt);
      expect(vectors['kinds'], {
        'ticket': SupportKinds.ticket,
        'reply': SupportKinds.reply,
      });
      expect(vectors['dirs'], {
        'ticket': SupportDirs.ticket,
        'reply': SupportDirs.reply,
      });
      expect(vectors['categories'], supportCategoryTitles.keys.toList());
      expect(vectors['statuses'], supportStatuses);
      expect(vectors['id_re'], supportIdRe.pattern);
    });

    test('ادغام بردار تیکت + پاسخ', () {
      Map<String, Object?> p(String n) =>
          jsonDecode((cases[n]! as Map)['plaintext']! as String)
              as Map<String, Object?>;
      final t = SupportThread.merge(p('ticket'), p('reply'))!;
      expect(t.status, 'answered');
      expect(t.messages.map((m) => m.fromOwner), [false, false, true]);
      expect(t.school, 'دبستان نمونه');
      expect(t.role, 'teacher');
      expect(t.updatedAt, '2026-11-13T09:00:00.000Z');
    });
  });

  group('قاعدهٔ ادغام (همان server/support.js)', () {
    Map<String, Object?> ticket({
      List<String> at = const ['2026-11-13T08:00:00.000Z'],
      bool closed = false,
      String? updated,
    }) => {
      'v': 1,
      'id': 'TKT-0000000A',
      'school_id': 's-1',
      'school': '',
      'name': 'علی',
      'role': 'parent',
      'category': 'weird',
      'subject': 'موضوع',
      'closed_by_user': closed,
      'updated_at': updated ?? at.last,
      'messages': [
        for (final a in at) {'at': a, 'from': 'user', 'text': 'پیام $a'},
      ],
    };

    test('پیام تازهٔ کاربر پس از پاسخ ⇒ دوباره «باز»', () {
      final t = SupportThread.merge(
        ticket(at: ['2026-11-13T08:00:00.000Z', '2026-11-13T10:00:00.000Z']),
        {
          'id': 'TKT-0000000A',
          'status': 'answered',
          'updated_at': '2026-11-13T09:00:00.000Z',
          'messages': [
            {'at': '2026-11-13T09:00:00.000Z', 'text': 'پاسخ'},
          ],
        },
      )!;
      expect(t.status, 'open');
      expect(t.needsAnswer, isTrue);
      expect(t.messages.map((m) => m.fromOwner), [false, true, false]);
      expect(t.category, 'other');
    });

    test('بستن به‌دست کاربر پس از پاسخ ⇒ بسته؛ پاسخِ تیکتی دیگر نادیده', () {
      final t = SupportThread.merge(
        ticket(closed: true, updated: '2026-11-13T11:00:00.000Z'),
        {
          'id': 'TKT-0000000A',
          'status': 'answered',
          'updated_at': '2026-11-13T09:00:00.000Z',
          'messages': <Object?>[],
        },
      )!;
      expect(t.status, 'closed');
      final other = SupportThread.merge(ticket(), {
        'id': 'TKT-0000000B',
        'status': 'closed',
        'updated_at': '2026-11-13T12:00:00.000Z',
      })!;
      expect(other.status, 'open');
      expect(SupportThread.merge({'id': 'bad'}, null), isNull);
    });

    test('پاکت پاسخ تازه پیام‌های قبلی مالک را نگه می‌دارد', () {
      final t = SupportThread.merge(ticket(), {
        'id': 'TKT-0000000A',
        'status': 'answered',
        'updated_at': '2026-11-13T09:00:00.000Z',
        'messages': [
          {'at': '2026-11-13T09:00:00.000Z', 'text': 'پاسخ ۱'},
        ],
      })!;
      final p = t.replyPlain(
        now: '2026-11-13T12:00:00.000Z',
        text: '  پاسخ ۲ ',
        status: 'closed',
      );
      expect(p['status'], 'closed');
      expect((p['messages']! as List).map((m) => (m as Map)['text']), [
        'پاسخ ۱',
        'پاسخ ۲',
      ]);
      final counts = supportCounts([t]);
      expect((counts.open, counts.answered, counts.closed), (0, 1, 0));
    });
  });

  group('SchoolRegistry + صفحهٔ «پشتیبانی» در برابر صندوقچهٔ جعلی', () {
    const sk = 'SK-SUPPORT-TEST';
    late FakeBucket bucket;
    late FakeSecureStore secure;
    late SchoolRegistry reg;
    var clock = DateTime.utc(2026, 11, 13, 10);

    setUpAll(() => s3RetryPolicy = RetryPolicy.none);
    tearDownAll(() => s3RetryPolicy = const RetryPolicy());

    setUp(() async {
      EndpointRoutes.reset();
      clock = DateTime.utc(2026, 11, 13, 10);
      bucket = FakeBucket(() => clock);
      secure = FakeSecureStore();
      await S3Settings(
        endpoint: Uri.https('s3.example.test'),
        accessKey: 'ak',
        secretKey: sk,
        bucket: 'payesh-madrese',
      ).save(secure);
      reg = SchoolRegistry(
        secure: secure,
        s3Factory: bucket.transport,
        now: () => clock,
        hashIterations: 1000,
      );
    });

    Future<void> putTicket(
      String id, {
      String subject = 'حضور و غیاب',
      String role = 'teacher',
      String at = '2026-11-13T08:00:00.000Z',
    }) async => bucket.putText(
      'payesh/${SupportDirs.ticket}$id.json',
      await sealSchools(sk, SupportKinds.ticket, 1, {
        'v': 1,
        'id': id,
        'school_id': 's-0042',
        'school': 'دبستان نمونه',
        'uid': 7,
        'name': 'زهرا کریمی',
        'role': role,
        'category': 'bug',
        'subject': subject,
        'closed_by_user': false,
        'created_at': at,
        'updated_at': at,
        'messages': [
          {'at': at, 'from': 'user', 'text': 'متن $subject'},
        ],
      }),
    );

    test('فهرست، پاسخ، بستن؛ پاکت پاسخ با کلید صندوقچه؛ خطاها', () async {
      await putTicket('TKT-0000000A');
      await putTicket(
        'TKT-0000000B',
        subject: 'پرداخت',
        role: 'manager',
        at: '2026-11-13T09:00:00.000Z',
      );
      // پاکت جعلی با کلید دیگر نادیده
      bucket.putText(
        'payesh/${SupportDirs.ticket}TKT-0000000C.json',
        await sealSchools('other', SupportKinds.ticket, 1, {
          'id': 'TKT-0000000C',
        }),
      );
      var list = await reg.loadSupport();
      expect(list.map((t) => t.id), ['TKT-0000000B', 'TKT-0000000A']);
      expect(list.every((t) => t.needsAnswer), isTrue);

      final a = await reg.answerSupport(
        'TKT-0000000A',
        text: 'لطفاً به‌روز کنید.',
        status: 'answered',
      );
      expect(a.status, 'answered');
      final env = await openSchools(
        sk,
        SupportKinds.reply,
        bucket.text('payesh/${SupportDirs.reply}TKT-0000000A.json')!,
      );
      expect(env!.plain['status'], 'answered');
      expect(env.plain['updated_at'], '2026-11-13T10:00:00.000Z');
      expect((env.plain['messages']! as List).single, {
        'at': '2026-11-13T10:00:00.000Z',
        'from': 'owner',
        'text': 'لطفاً به‌روز کنید.',
      });

      clock = clock.add(const Duration(minutes: 5));
      final closed = await reg.answerSupport('TKT-0000000A', status: 'closed');
      expect(closed.status, 'closed');
      expect(closed.ownerMessages, hasLength(1), reason: 'answer kept');
      final env2 = await openSchools(
        sk,
        SupportKinds.reply,
        bucket.text('payesh/${SupportDirs.reply}TKT-0000000A.json')!,
      );
      expect(env2!.rev, greaterThan(env.rev));

      list = await reg.loadSupport();
      expect(list.first.id, 'TKT-0000000B', reason: 'open first');
      expect(list.last.status, 'closed');

      Future<String> code(Future<Object?> f) async {
        try {
          await f;
          return 'ok';
        } on SchoolsFailure catch (e) {
          return e.code;
        }
      }

      expect(await code(reg.answerSupport('x', status: 'open')), 'bad_id');
      expect(
        await code(reg.answerSupport('TKT-0000000A', status: 'weird')),
        'bad_status',
      );
      expect(
        await code(reg.answerSupport('TKT-0000000A', status: 'answered')),
        'bad_text',
      );
      expect(
        await code(
          reg.answerSupport('TKT-0000000A', text: 'x' * 2001, status: 'open'),
        ),
        'bad_text',
      );
      expect(
        await code(
          reg.answerSupport('TKT-0000000F', text: 'سلام', status: 'answered'),
        ),
        'not_found',
      );
      bucket.down = true;
      expect(await code(reg.loadSupport()), isNot('ok'));
      expect(
        await code(
          reg.answerSupport('TKT-0000000A', text: 'سلام', status: 'answered'),
        ),
        isNot('ok'),
      );
      bucket.down = false;
      await S3Settings.clear(secure);
      expect(await code(reg.loadSupport()), 'not_connected');
      expect(
        await code(
          reg.answerSupport('TKT-0000000A', text: 'سلام', status: 'answered'),
        ),
        'not_connected',
      );
    });

    testWidgets('صفحهٔ «پشتیبانی»: شمارش، پالایه، جست‌وجو، پاسخ، بستن', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1000, 1600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.runAsync(() async {
        await putTicket('TKT-0000000A');
        await putTicket(
          'TKT-0000000B',
          subject: 'پرداخت',
          role: 'manager',
          at: '2026-11-13T09:00:00.000Z',
        );
      });
      final flashes = <(bool, String)>[];
      await tester.pumpWidget(
        MaterialApp(
          theme: PayeshUi.light(look: PayeshLook.nabd),
          home: Directionality(
            textDirection: TextDirection.rtl,
            child: Scaffold(
              body: SupportInboxView(
                registry: reg,
                flash: (ok, t) => flashes.add((ok, t)),
              ),
            ),
          ),
        ),
      );
      Future<void> settle() async {
        for (var i = 0; i < 6; i++) {
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 30)),
          );
          await tester.pump(const Duration(milliseconds: 50));
        }
        await tester.pumpAndSettle();
      }

      await settle();
      expect(find.byKey(const Key('support-row-TKT-0000000A')), findsOneWidget);
      expect(find.byKey(const Key('support-row-TKT-0000000B')), findsOneWidget);
      expect(
        tester
            .widget<StatTile>(find.byKey(const Key('support-count-open')))
            .value,
        2,
      );

      await tester.enterText(find.byKey(const Key('support-search')), 'پرداخت');
      await tester.pump();
      expect(find.byKey(const Key('support-row-TKT-0000000A')), findsNothing);
      await tester.enterText(find.byKey(const Key('support-search')), '');
      await tester.pump();

      await tester.tap(find.byKey(const Key('support-row-TKT-0000000A')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('support-thread')), findsOneWidget);
      expect(find.text('متن حضور و غیاب'), findsOneWidget);
      // NEG: پاسخ خالی
      await tester.tap(find.byKey(const Key('support-send')));
      await settle();
      expect(find.byKey(const Key('support-answer-error')), findsOneWidget);
      await tester.enterText(
        find.byKey(const Key('support-answer')),
        'لطفاً به‌روز کنید.',
      );
      await tester.tap(find.byKey(const Key('support-send')));
      await settle();
      expect(find.byKey(const Key('support-thread')), findsNothing);
      expect(flashes.last.$1, isTrue);
      // فیلتر پیش‌فرض «منتظر پاسخ» ⇒ پاسخ‌داده دیگر دیده نمی‌شود
      expect(find.byKey(const Key('support-row-TKT-0000000A')), findsNothing);
      await tester.tap(find.byKey(const Key('support-filter-answered')));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<StatusBadge>(
              find.byKey(const Key('support-state-TKT-0000000A')),
            )
            .label,
        'پاسخ داده شد',
      );
      await tester.tap(find.byKey(const Key('support-row-TKT-0000000A')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('support-close')));
      await settle();
      expect(flashes.last.$2, contains('بسته'));
      await tester.tap(find.byKey(const Key('support-filter-closed')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('support-row-TKT-0000000A')), findsOneWidget);
      await tester.tap(find.byKey(const Key('support-filter-all')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('support-row-TKT-0000000B')), findsOneWidget);
      await tester.tap(find.byKey(const Key('support-refresh')));
      await settle();
      expect(find.byKey(const Key('support-error')), findsNothing);
    });
  });
}
