// ردیف ۱۵۲: کارخواه پشتیبانی برنامهٔ کاربر در برابر سرور واقعی HTTP (loopback).
import 'dart:convert';
import 'dart:io';

import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

void main() {
  late HttpServer srv;
  late Uri base;
  late LanSupportClient c;
  final seen = <String>[];
  final bodies = <Object?>[];

  Map<String, Object?> ticket(
    String id,
    String status, {
    bool pending = false,
  }) => {
    'id': id,
    'category': 'bug',
    'subject': 'حضور و غیاب',
    'status': status,
    'pending': pending,
    'created_at': '2026-11-13T08:00:00.000Z',
    'updated_at': '2026-11-13T09:00:00.000Z',
    'messages': [
      {'at': '2026-11-13T08:00:00.000Z', 'from': 'user', 'text': 'خطا'},
      {'at': '2026-11-13T09:00:00.000Z', 'from': 'owner', 'text': 'رفع شد'},
      'bad-entry',
    ],
  };

  setUp(() async {
    seen.clear();
    bodies.clear();
    srv = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    base = Uri.parse('http://127.0.0.1:${srv.port}');
    c = LanSupportClient(LanAccessClient(timeout: const Duration(seconds: 5)));
    srv.listen((req) async {
      final text = await utf8.decodeStream(req);
      seen.add(
        '${req.method} ${req.uri.path} ${req.headers.value('authorization') ?? '-'}',
      );
      final b = text.isEmpty ? null : jsonDecode(text);
      bodies.add(b);
      Object? out;
      var st = 200;
      switch ('${req.method} ${req.uri.path}') {
        case 'GET /api/support':
          out = {
            'ok': true,
            'online': true,
            'tickets': [
              ticket('TKT-0A1B2C3D', 'answered'),
              'junk',
              <String, Object?>{},
            ],
          };
        case 'POST /api/support':
          final m = b! as Map;
          if ('${m['subject']}'.length < 3) {
            st = 400;
            out = {'ok': false, 'error': 'bad_subject'};
          } else {
            out = {
              'ok': true,
              'reported': false,
              'ticket': ticket('TKT-11111111', 'open', pending: true),
            };
          }
        case 'POST /api/support/message':
          final m = b! as Map;
          if (m['id'] == 'TKT-00000000') {
            st = 404;
            out = {'ok': false, 'error': 'not_found'};
          } else {
            out = {
              'ok': true,
              'reported': true,
              'ticket': ticket('${m['id']}', 'open'),
            };
          }
        case 'POST /api/support/close':
          out = {
            'ok': true,
            'ticket': {'nope': 1},
          };
        default:
          st = 404;
          out = {'ok': false, 'error': 'not_found'};
      }
      req.response
        ..statusCode = st
        ..headers.contentType = ContentType.json
        ..write(jsonEncode(out));
      await req.response.close();
    });
  });

  tearDown(() => srv.close(force: true));

  test('فهرست: تیکت‌ها با پیام‌های کاربر و مالک؛ ورودی خراب نادیده', () async {
    final inbox = await c.list(base, 'tok-1');
    expect(inbox.online, isTrue);
    expect(inbox.tickets, hasLength(1));
    final t = inbox.tickets.single;
    expect(t.id, 'TKT-0A1B2C3D');
    expect(t.answered, isTrue);
    expect(t.closed, isFalse);
    expect(t.pending, isFalse);
    expect(t.updatedAt, DateTime.utc(2026, 11, 13, 9));
    expect(t.messages.map((m) => m.fromOwner), [false, true]);
    expect(t.messages.last.text, 'رفع شد');
    expect(seen.single, 'GET /api/support Bearer tok-1');
  });

  test('تیکت تازه + پیام + بستن؛ خطاها با پیام فارسی', () async {
    final r = await c.create(
      base,
      'tok-1',
      category: 'payment',
      subject: '  پرداخت ثبت نشد ',
      text: ' مبلغ کسر شد ',
    );
    expect(r.reported, isFalse);
    expect(r.ticket.pending, isTrue);
    expect(bodies.last, {
      'category': 'payment',
      'subject': 'پرداخت ثبت نشد',
      'text': 'مبلغ کسر شد',
    });
    final m = await c.message(base, 'tok-1', 'TKT-11111111', ' کد ۱۲۳ ');
    expect(m.reported, isTrue);
    expect(bodies.last, {'id': 'TKT-11111111', 'text': 'کد ۱۲۳'});

    await expectLater(
      c.create(base, 'tok-1', category: 'bug', subject: 'x', text: 'متن'),
      throwsA(
        isA<LanAccessFailure>().having(supportErrorFa, 'fa', contains('موضوع')),
      ),
    );
    await expectLater(
      c.message(base, 'tok-1', 'TKT-00000000', 'سلام'),
      throwsA(
        isA<LanAccessFailure>().having(
          supportErrorFa,
          'fa',
          contains('پیدا نشد'),
        ),
      ),
    );
    // پاسخ بدون تیکت معتبر ⇒ bad_body
    await expectLater(
      c.close(base, 'tok-1', 'TKT-11111111'),
      throwsA(
        isA<LanAccessFailure>().having((e) => e.wire, 'wire', 'bad_body'),
      ),
    );
  });

  test('برچسب‌های فارسی دسته و وضعیت', () {
    expect(supportCategories.map((c) => c.$1), [
      'bug',
      'question',
      'payment',
      'account',
      'suggestion',
      'other',
    ]);
    expect(supportCategoryFa('payment'), 'پرداخت و اشتراک');
    expect(supportCategoryFa('???'), 'سایر');
    expect(supportStatusFa('answered'), 'پاسخ داده شد');
    expect(supportStatusFa('closed'), 'بسته');
    expect(supportStatusFa('open'), 'باز');
    for (final w in ['bad_text', 'too_many_messages', 'rate_limited', 'x']) {
      expect(
        supportErrorFa(LanAccessFailure(LanAccessError.unknown, wire: w)),
        isNotEmpty,
      );
    }
    expect(SupportTicket.fromJson({'id': ''}), isNull);
    expect(SupportMessage.fromJson({'text': 1}), isNull);
  });
}
