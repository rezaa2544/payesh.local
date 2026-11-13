// پشتیبانی — پیام و گزارش مشکل کاربران به مالک (ردیف ۱۵۲).
//
// برنامهٔ کاربر فقط با سرور مدرسه حرف می‌زند (همان مسیر اشتراک):
//   GET  /api/support          تیکت‌های همین کاربر + پاسخ‌های مالک
//   POST /api/support          {category, subject, text}
//   POST /api/support/message  {id, text}
//   POST /api/support/close    {id}
// سرور مدرسه تیکت را مهرشده در صندوقچهٔ مالک می‌گذارد (server/support.js) و اگر صندوقچه در
// دسترس نبود در صف ارسال نگه می‌دارد؛ پنل مالک پاسخ را جدا می‌نویسد.
import 'lan_access.dart';

/// دسته‌های تیکت (همان server/support.js CATEGORIES و docs/cloud/contracts/support-vectors.json).
const List<(String, String)> supportCategories = [
  ('bug', 'گزارش مشکل / خطا'),
  ('question', 'پرسش'),
  ('payment', 'پرداخت و اشتراک'),
  ('account', 'حساب کاربری و ورود'),
  ('suggestion', 'پیشنهاد'),
  ('other', 'سایر'),
];

String supportCategoryFa(String id) => supportCategories
    .firstWhere((c) => c.$1 == id, orElse: () => supportCategories.last)
    .$2;

String supportStatusFa(String s) => switch (s) {
  'answered' => 'پاسخ داده شد',
  'closed' => 'بسته',
  _ => 'باز',
};

/// یک پیام در گفت‌وگو.
final class SupportMessage {
  const SupportMessage({
    required this.at,
    required this.fromOwner,
    required this.text,
  });
  final DateTime? at;
  final bool fromOwner;
  final String text;

  static SupportMessage? fromJson(Object? j) {
    if (j is! Map) return null;
    final text = j['text'];
    if (text is! String) return null;
    return SupportMessage(
      at: DateTime.tryParse('${j['at'] ?? ''}'),
      fromOwner: j['from'] == 'owner',
      text: text,
    );
  }
}

/// یک تیکت پشتیبانی.
final class SupportTicket {
  const SupportTicket({
    required this.id,
    required this.category,
    required this.subject,
    required this.status,
    required this.messages,
    this.pending = false,
    this.updatedAt,
  });

  final String id;
  final String category;
  final String subject;

  /// open | answered | closed
  final String status;
  final List<SupportMessage> messages;

  /// هنوز به صندوقچهٔ مالک نرسیده (سرور مدرسه دوباره می‌فرستد).
  final bool pending;
  final DateTime? updatedAt;

  bool get closed => status == 'closed';
  bool get answered => status == 'answered';

  static SupportTicket? fromJson(Object? j) {
    if (j is! Map) return null;
    final id = j['id'];
    if (id is! String || id.isEmpty) return null;
    return SupportTicket(
      id: id,
      category: '${j['category'] ?? 'other'}',
      subject: '${j['subject'] ?? ''}',
      status: '${j['status'] ?? 'open'}',
      pending: j['pending'] == true,
      updatedAt: DateTime.tryParse('${j['updated_at'] ?? ''}'),
      messages: [
        if (j['messages'] is List)
          for (final m in j['messages']! as List) ?SupportMessage.fromJson(m),
      ],
    );
  }
}

/// پاسخ «فهرست»: تیکت‌ها + اینکه سرور مدرسه به صندوقچه وصل بود یا نه.
typedef SupportInbox = ({List<SupportTicket> tickets, bool online});

/// پیام فارسی خطاهای پشتیبانی.
String supportErrorFa(LanAccessFailure e) => switch (e.wire) {
  'bad_subject' => 'موضوع را بنویسید (دست‌کم ۳ نویسه)',
  'bad_text' => 'متن پیام را بنویسید',
  'too_many_messages' =>
    'این گفت‌وگو خیلی طولانی شده است — یک پیام تازه بفرستید',
  'not_found' || 'bad_id' => 'این گفت‌وگو پیدا نشد',
  'rate_limited' => 'پیام‌های زیادی فرستاده‌اید — کمی بعد دوباره امتحان کنید',
  _ => e.messageFa,
};

/// سرور مدرسه + توکن تازه برای یک بار گفت‌وگو با پشتیبانی.
typedef SupportLink = ({SupportApi api, Uri server, String token});

abstract interface class SupportApi {
  Future<SupportInbox> list(Uri server, String token);
  Future<({SupportTicket ticket, bool reported})> create(
    Uri server,
    String token, {
    required String category,
    required String subject,
    required String text,
  });
  Future<({SupportTicket ticket, bool reported})> message(
    Uri server,
    String token,
    String id,
    String text,
  );
  Future<SupportTicket> close(Uri server, String token, String id);
}

/// همان [LanAccessClient] (زمان‌سنج‌ها، نگاشت خطا، سرآیندها).
final class LanSupportClient implements SupportApi {
  LanSupportClient(this.client);
  final LanAccessClient client;

  static SupportTicket _ticket(Map<String, Object?> j) {
    final t = SupportTicket.fromJson(j['ticket']);
    if (t == null) {
      throw const LanAccessFailure(LanAccessError.unknown, wire: 'bad_body');
    }
    return t;
  }

  @override
  Future<SupportInbox> list(Uri server, String token) async {
    final j = await client.request(
      'GET',
      server.resolve('/api/support'),
      null,
      token: token,
    );
    return (
      tickets: [
        if (j['tickets'] is List)
          for (final t in j['tickets']! as List) ?SupportTicket.fromJson(t),
      ],
      online: j['online'] == true,
    );
  }

  @override
  Future<({SupportTicket ticket, bool reported})> create(
    Uri server,
    String token, {
    required String category,
    required String subject,
    required String text,
  }) async {
    final j = await client.request('POST', server.resolve('/api/support'), {
      'category': category,
      'subject': subject.trim(),
      'text': text.trim(),
    }, token: token);
    return (ticket: _ticket(j), reported: j['reported'] == true);
  }

  @override
  Future<({SupportTicket ticket, bool reported})> message(
    Uri server,
    String token,
    String id,
    String text,
  ) async {
    final j = await client.request(
      'POST',
      server.resolve('/api/support/message'),
      {'id': id, 'text': text.trim()},
      token: token,
    );
    return (ticket: _ticket(j), reported: j['reported'] == true);
  }

  @override
  Future<SupportTicket> close(Uri server, String token, String id) async =>
      _ticket(
        await client.request('POST', server.resolve('/api/support/close'), {
          'id': id,
        }, token: token),
      );
}
