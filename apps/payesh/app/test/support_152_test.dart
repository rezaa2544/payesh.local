// Row 152 — «پشتیبانی و گزارش مشکل»: every signed-in LAN user (also on the paywall) sends
// messages / problem reports to the platform owner through the school server and reads the
// owner's answers. Real screens + real SessionController with scripted LAN, schools and support.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/app.dart';
import 'package:payesh_app/src/flags.dart';
import 'package:payesh_app/src/login/session_controller.dart';
import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'lan_mode_127_test.dart' show FakeLan, NoGateway, lanSession, serverInfo;
import 'schools_145_test.dart' show FakeSchools, paywalled;

SupportTicket _t(
  String id, {
  String status = 'open',
  bool pending = false,
  List<SupportMessage>? messages,
}) => SupportTicket(
  id: id,
  category: 'bug',
  subject: 'حضور و غیاب ذخیره نمی‌شود',
  status: status,
  pending: pending,
  updatedAt: DateTime.utc(2026, 11, 12, 8),
  messages:
      messages ??
      [
        SupportMessage(
          at: DateTime.utc(2026, 11, 12, 8),
          fromOwner: false,
          text: 'بعد از ثبت، صفحه خالی می‌شود.',
        ),
      ],
);

/// Scripted support API: records calls; answers from queues.
final class FakeSupport implements SupportApi {
  final calls = <String>[];
  final inboxes = <Object>[];
  final creates = <Object>[];
  final messages = <Object>[];
  final closes = <Object>[];

  Future<T> _next<T>(List<Object> q, String what) {
    calls.add(what);
    if (q.isEmpty) return Future.error(StateError('unexpected $what'));
    final v = q.removeAt(0);
    return v is T ? Future<T>.value(v as T) : Future<T>.error(v);
  }

  @override
  Future<SupportInbox> list(Uri server, String token) =>
      _next(inboxes, 'list:$token');

  @override
  Future<({SupportTicket ticket, bool reported})> create(
    Uri server,
    String token, {
    required String category,
    required String subject,
    required String text,
  }) => _next(creates, 'create:$category:$subject:$text');

  @override
  Future<({SupportTicket ticket, bool reported})> message(
    Uri server,
    String token,
    String id,
    String text,
  ) => _next(messages, 'message:$id:$text');

  @override
  Future<SupportTicket> close(Uri server, String token, String id) =>
      _next(closes, 'close:$id');
}

void main() {
  late FakeLan lan;
  late FakeSchools schools;
  late FakeSupport support;
  late FakeSecureStore store;

  setUp(() {
    lan = FakeLan();
    schools = FakeSchools();
    support = FakeSupport();
    store = FakeSecureStore();
  });

  Future<SessionController> boot(
    WidgetTester tester, {
    bool withSupport = true,
  }) async {
    tester.view.physicalSize = const Size(900, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final c = SessionController(
      api: NoGateway(),
      accounts: SchoolAccountStore(store),
      flags: ClientFlags.parse(),
      lan: lan,
      schools: schools,
      support: withSupport ? support : null,
      now: () => DateTime.utc(2026, 11, 12, 8),
    );
    addTearDown(c.dispose);
    await tester.pumpWidget(
      PayeshApp(session: c, today: () => DateTime(2026, 11, 12)),
    );
    await c.start();
    await tester.pumpAndSettle();
    return c;
  }

  Future<void> tap(WidgetTester tester, String key) async {
    final f = find.byKey(Key(key));
    await tester.ensureVisible(f);
    await tester.pumpAndSettle();
    await tester.tap(f);
    await tester.pumpAndSettle();
  }

  Future<void> type(WidgetTester tester, String key, String v) async {
    final f = find.byKey(Key(key));
    await tester.ensureVisible(f);
    await tester.enterText(f, v);
    await tester.pump();
  }

  Future<void> signIn(WidgetTester tester, {String role = 'teacher'}) async {
    lan.probes.add(serverInfo());
    await tap(tester, 'use-lan');
    await type(tester, 'lan-server', '192.168.1.10:8080');
    await tap(tester, 'lan-next');
    lan.logins.add(lanSession(role: role, uid: 7, token: 'acc-7'));
    await type(tester, 'lan-phone', '09121234567');
    await type(tester, 'lan-password', 'pass-1234');
    await tap(tester, 'lan-login');
  }

  String text(WidgetTester tester, String key) {
    final w = tester.widget(find.byKey(Key(key)));
    return switch (w) {
      Text() => w.data!,
      StatusBadge() => w.label,
      _ => (w as SelectableText).data!,
    };
  }

  testWidgets(
    'S152-W01 paywalled manager still reaches support: NEG validation (no call), send queued '
    '(school server not on the database), list shows «در صف ارسال»',
    (tester) async {
      await boot(tester);
      schools.subs.add(paywalled());
      await signIn(tester, role: 'manager');
      expect(find.byKey(const Key('paywall')), findsOneWidget);
      support.inboxes.add((tickets: <SupportTicket>[], online: false));
      await tap(tester, 'support-entry');
      expect(support.calls.single, 'list:acc-7');
      expect(find.byKey(const Key('support-empty')), findsOneWidget);
      expect(find.byKey(const Key('support-offline')), findsOneWidget);

      await tap(tester, 'support-new');
      await type(tester, 'support-subject', 'اب');
      await tap(tester, 'support-submit');
      expect(text(tester, 'support-dialog-error'), contains('موضوع'));
      expect(support.calls, hasLength(1), reason: 'no call on invalid input');

      await type(tester, 'support-subject', 'پرداخت ثبت نشد');
      await type(tester, 'support-text', 'مبلغ کسر شد ولی اشتراک فعال نشد.');
      final q = _t('TKT-0A1B2C3D', pending: true);
      support.creates.add((ticket: q, reported: false));
      support.inboxes.add((tickets: [q], online: false));
      await tap(tester, 'support-submit');
      expect(
        support.calls[1],
        'create:bug:پرداخت ثبت نشد:مبلغ کسر شد ولی اشتراک فعال نشد.',
      );
      expect(find.byKey(const Key('support-dialog')), findsNothing);
      expect(find.byKey(const Key('support-sent')), findsOneWidget);
      expect(find.textContaining('به‌محض وصل شدن'), findsOneWidget);
      expect(
        find.byKey(const Key('support-ticket-TKT-0A1B2C3D')),
        findsOneWidget,
      );
      expect(find.textContaining('در صف ارسال'), findsOneWidget);
      expect(text(tester, 'support-status-TKT-0A1B2C3D'), 'باز');
    },
  );

  testWidgets(
    'S152-W02 thread: owner answer shown; reply; close; NEG server error message in Persian',
    (tester) async {
      await boot(tester);
      schools.subs.add(
        const SubStatus(managed: true, access: true, status: 'free'),
      );
      await signIn(tester);
      final answered = _t(
        'TKT-11111111',
        status: 'answered',
        messages: [
          SupportMessage(
            at: DateTime.utc(2026, 11, 12, 8),
            fromOwner: false,
            text: 'گزارش باز نمی‌شود',
          ),
          SupportMessage(
            at: DateTime.utc(2026, 11, 12, 9),
            fromOwner: true,
            text: 'لطفاً برنامه را به‌روز کنید.',
          ),
        ],
      );
      support.inboxes.add((tickets: [answered], online: true));
      await tap(tester, 'support-entry');
      expect(find.byKey(const Key('support-offline')), findsNothing);
      expect(text(tester, 'support-status-TKT-11111111'), 'پاسخ داده شد');
      await tap(tester, 'support-ticket-TKT-11111111');
      expect(find.byKey(const Key('support-msg-1')), findsOneWidget);
      expect(find.text('پشتیبانی پایش'), findsOneWidget);
      expect(find.text('لطفاً برنامه را به‌روز کنید.'), findsOneWidget);

      // NEG: the school server refuses (rate limit) ⇒ Persian message, text kept
      support.messages.add(
        const LanAccessFailure(
          LanAccessError.unknown,
          wire: 'rate_limited',
          status: 429,
        ),
      );
      await type(tester, 'support-reply-text', 'به‌روز کردم، هنوز هست.');
      await tap(tester, 'support-send');
      expect(text(tester, 'support-thread-error'), contains('کمی بعد'));

      final reopened = _t(
        'TKT-11111111',
        messages: [
          ...answered.messages,
          SupportMessage(
            at: DateTime.utc(2026, 11, 12, 10),
            fromOwner: false,
            text: 'به‌روز کردم، هنوز هست.',
          ),
        ],
      );
      support.messages.add((ticket: reopened, reported: true));
      await tap(tester, 'support-send');
      expect(support.calls.last, 'message:TKT-11111111:به‌روز کردم، هنوز هست.');
      expect(find.byKey(const Key('support-msg-2')), findsOneWidget);
      expect(text(tester, 'support-thread-status'), 'باز');
      expect(find.byKey(const Key('support-thread-error')), findsNothing);

      support.closes.add(_t('TKT-11111111', status: 'closed'));
      await tap(tester, 'support-close');
      expect(support.calls.last, 'close:TKT-11111111');
      expect(text(tester, 'support-thread-status'), 'بسته');
      expect(find.byKey(const Key('support-close')), findsNothing);

      support.inboxes.add((
        tickets: [_t('TKT-11111111', status: 'closed')],
        online: true,
      ));
      await tester.tap(find.byType(BackButton));
      await tester.pumpAndSettle();
      expect(text(tester, 'support-status-TKT-11111111'), 'بسته');
    },
  );

  testWidgets('S152-W03 NEG: no support API in this build ⇒ no entry', (
    tester,
  ) async {
    await boot(tester, withSupport: false);
    schools.subs.add(
      const SubStatus(managed: true, access: true, status: 'free'),
    );
    await signIn(tester);
    expect(find.byKey(const Key('support-entry')), findsNothing);
  });

  testWidgets('S152-W04 NEG: list fails ⇒ error shown, refresh retries', (
    tester,
  ) async {
    final c = await boot(tester);
    schools.subs.add(
      const SubStatus(managed: true, access: true, status: 'free'),
    );
    await signIn(tester);
    expect(c.supportAvailable, isTrue);
    support.inboxes.add(
      const LanAccessFailure(LanAccessError.unreachable, wire: 'network'),
    );
    await tap(tester, 'support-entry');
    expect(find.byKey(const Key('support-error')), findsOneWidget);
    support.inboxes.add((tickets: [_t('TKT-22222222')], online: true));
    await tap(tester, 'support-refresh');
    expect(find.byKey(const Key('support-error')), findsNothing);
    expect(
      find.byKey(const Key('support-ticket-TKT-22222222')),
      findsOneWidget,
    );
  });
}
