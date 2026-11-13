// صندوق پشتیبانی پنل مالک (ردیف ۱۵۲ · درخواست مالک ۲۰۲۶‑۱۱‑۱۳).
//
// قرارداد support v1 (همان server/support.js و docs/cloud/contracts/support-vectors.json):
//   payesh/schools/support/<TKT-id>.json        تیکت + پیام‌های کاربر   kind=payesh-support-ticket (سرور مدرسه)
//   payesh/schools/support-reply/<TKT-id>.json  پاسخ‌ها و وضعیت مالک     kind=payesh-support-reply  (همین پنل)
// هر پرونده یک نویسنده دارد؛ اینجا فقط ادغام و نمایش است.

abstract final class SupportKinds {
  static const String ticket = 'payesh-support-ticket';
  static const String reply = 'payesh-support-reply';
}

abstract final class SupportDirs {
  static const String ticket = 'schools/support/';
  static const String reply = 'schools/support-reply/';
}

const List<String> supportStatuses = ['open', 'answered', 'closed'];
final RegExp supportIdRe = RegExp(r'^TKT-[0-9A-F]{8}$');

const Map<String, String> supportCategoryTitles = {
  'bug': 'گزارش مشکل / خطا',
  'question': 'پرسش',
  'payment': 'پرداخت و اشتراک',
  'account': 'حساب کاربری و ورود',
  'suggestion': 'پیشنهاد',
  'other': 'سایر',
};

const Map<String, String> supportStatusTitles = {
  'open': 'باز — منتظر پاسخ',
  'answered': 'پاسخ داده شد',
  'closed': 'بسته',
};

const Map<String, String> supportRoleTitles = {
  'manager': 'مدیر',
  'deputy': 'معاون',
  'teacher': 'دبیر',
  'student': 'دانش‌آموز',
  'parent': 'ولی',
};

typedef SupportMsg = ({String at, bool fromOwner, String text});

/// یک گفت‌وگو: تیکت سرور مدرسه + پاسخ‌های مالک، ادغام‌شده به ترتیب زمان.
final class SupportThread {
  const SupportThread({
    required this.id,
    required this.schoolId,
    required this.school,
    required this.name,
    required this.role,
    required this.category,
    required this.subject,
    required this.status,
    required this.messages,
    required this.updatedAt,
  });

  final String id;
  final String schoolId;
  final String school;
  final String name;
  final String role;
  final String category;
  final String subject;

  /// open | answered | closed (وضعیت مؤثر پس از ادغام)
  final String status;
  final List<SupportMsg> messages;
  final String updatedAt;

  bool get needsAnswer => status == 'open';
  List<SupportMsg> get ownerMessages => [
    for (final m in messages)
      if (m.fromOwner) m,
  ];

  static List<SupportMsg> _msgs(Object? v, {required bool owner}) => [
    if (v is List)
      for (final m in v)
        if (m is Map && m['text'] is String && m['at'] is String)
          (
            at: m['at']! as String,
            fromOwner: owner,
            text: m['text']! as String,
          ),
  ];

  /// ادغام تیکت (سرور مدرسه) و پاسخ (مالک) — همان قاعدهٔ server/support.js:
  /// وضعیت مالک فقط وقتی معتبر است که پس از آخرین پیام کاربر گذاشته شده باشد؛ بستن به‌دست
  /// کاربر پس از آخرین وضعیت مالک ⇒ بسته.
  static SupportThread? merge(
    Map<String, Object?> ticket,
    Map<String, Object?>? reply,
  ) {
    final id = '${ticket['id'] ?? ''}';
    if (!supportIdRe.hasMatch(id)) return null;
    if (reply != null && reply['id'] != id) reply = null;
    final users = _msgs(ticket['messages'], owner: false);
    final owners = _msgs(reply?['messages'], owner: true);
    final all = [...users, ...owners]..sort((a, b) => a.at.compareTo(b.at));
    final lastUser = users.isEmpty ? '' : users.last.at;
    final tUpdated = '${ticket['updated_at'] ?? lastUser}';
    final st = reply?['status'];
    final stAt =
        '${reply?['updated_at'] ?? (owners.isEmpty ? '' : owners.last.at)}';
    var status = 'open';
    if (st is String &&
        supportStatuses.contains(st) &&
        stAt.compareTo(lastUser) >= 0) {
      status = st;
    }
    if (ticket['closed_by_user'] == true && tUpdated.compareTo(stAt) >= 0) {
      status = 'closed';
    }
    final updated = [tUpdated, stAt]..sort();
    return SupportThread(
      id: id,
      schoolId: '${ticket['school_id'] ?? ''}',
      school: '${ticket['school'] ?? ''}',
      name: '${ticket['name'] ?? ''}',
      role: '${ticket['role'] ?? ''}',
      category: supportCategoryTitles.containsKey(ticket['category'])
          ? ticket['category']! as String
          : 'other',
      subject: '${ticket['subject'] ?? ''}',
      status: status,
      messages: all,
      updatedAt: updated.last,
    );
  }

  /// پاکت پاسخ تازهٔ مالک: پیام‌های قبلی مالک + پیام تازه (اختیاری) + وضعیت.
  Map<String, Object?> replyPlain({
    required String now,
    String? text,
    required String status,
  }) => {
    'v': 1,
    'id': id,
    'status': status,
    'updated_at': now,
    'by': 'owner',
    'messages': [
      for (final m in ownerMessages)
        {'at': m.at, 'from': 'owner', 'text': m.text},
      if (text != null && text.trim().isNotEmpty)
        {'at': now, 'from': 'owner', 'text': text.trim()},
    ],
  };
}

/// خلاصهٔ صندوق برای نشان «پشتیبانی» و داشبورد.
typedef SupportCounts = ({int open, int answered, int closed});

SupportCounts supportCounts(List<SupportThread> list) => (
  open: list.where((t) => t.status == 'open').length,
  answered: list.where((t) => t.status == 'answered').length,
  closed: list.where((t) => t.status == 'closed').length,
);
