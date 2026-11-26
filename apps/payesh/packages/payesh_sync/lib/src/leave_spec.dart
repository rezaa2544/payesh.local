// ردیف ۱۹۷ (Q02 / F25): شکل کامل درخواست مرخصی — روزانه (یک روز یا بازهٔ چندروزه) یا ساعتی
// (خروج زودهنگام / ورود دیرتر، ساعت از–تا)، نوع مرخصی، و پیوست گواهی (عکس فشرده). همین قواعد
// در server/policy.js (`leaveIssue`) هم اجرا می‌شود تا درخواست ناقص از هیچ مسیری ثبت نشود.
import 'dart:convert';

/// نوع‌های مرخصی (مقدار سیمی → برچسب فارسی)، به همان ترتیب فرم.
const Map<String, String> leaveTypesFa = {
  'sick': 'استعلاجی (بیماری)',
  'family': 'خانوادگی',
  'personal': 'شخصی / ضروری',
  'travel': 'سفر',
  'other': 'سایر',
};

/// برچسب کوتاه نوع (برچسب «مرخصی (…)» در حضور و غیاب).
const Map<String, String> leaveTypesShortFa = {
  'sick': 'استعلاجی',
  'family': 'خانوادگی',
  'personal': 'شخصی',
  'travel': 'سفر',
  'other': 'سایر',
};

/// حالت مرخصی: روزانه یا ساعتی.
const Map<String, String> leaveKindsFa = {
  'day': 'روزانه',
  'hours': 'ساعتی (خروج زودهنگام / ورود دیرتر)',
};

/// بیشترین طول یک درخواست روزانه (روز).
const int leaveMaxDays = 31;

/// سقف اندازهٔ پیوست (نویسه‌های data URI) — زیر سقف ۶۴ کیلوبایتی هر عملیات همگام‌سازی.
const int leaveAttachMax = 60000;

/// بیشترین طول علت.
const int leaveReasonMax = 500;

final RegExp _isoDay = RegExp(r'^\d{4}-\d{2}-\d{2}$');
final RegExp _hhmm = RegExp(r'^([01]\d|2[0-3]):[0-5]\d$');
final RegExp _dataImage = RegExp(
  r'^data:image/(jpeg|png);base64,[A-Za-z0-9+/=]+$',
);

DateTime? _day(Object? v) {
  final s = '${v ?? ''}';
  if (!_isoDay.hasMatch(s)) return null;
  final t = DateTime.tryParse('${s}T00:00:00Z');
  return t != null && t.toIso8601String().substring(0, 10) == s ? t : null;
}

String _s(Object? v) => v == null ? '' : '$v'.trim();

/// تعداد روزهای یک درخواست روزانه (حداقل ۱).
int leaveDays(Map<String, Object?> d) {
  final a = _day(d['date']);
  final b = _day(d['date_to']);
  if (a == null || b == null || b.isBefore(a)) return 1;
  return b.difference(a).inDays + 1;
}

/// خطای قاعده‌ای درخواست (همان کدهای server/policy.js)، یا null وقتی درست است.
String? leaveIssue(Map<String, Object?> d) {
  final from = _day(d['date']);
  if (from == null) return 'bad_date';
  final kind = _s(d['kind']).isEmpty ? 'day' : _s(d['kind']);
  if (!leaveKindsFa.containsKey(kind)) return 'bad_kind';
  final to = _s(d['date_to']);
  if (kind == 'day' && to.isNotEmpty) {
    final t = _day(to);
    if (t == null) return 'bad_date';
    if (t.isBefore(from)) return 'bad_range';
    if (t.difference(from).inDays + 1 > leaveMaxDays) return 'range_too_long';
  }
  if (kind == 'hours') {
    final a = _s(d['time_from']);
    final b = _s(d['time_to']);
    if (!_hhmm.hasMatch(a) || !_hhmm.hasMatch(b)) return 'bad_time';
    if (a.compareTo(b) >= 0) return 'bad_time';
    if (to.isNotEmpty && to != _s(d['date'])) return 'bad_range';
  }
  final type = _s(d['type']);
  if (type.isNotEmpty && !leaveTypesFa.containsKey(type)) return 'bad_type';
  if (_s(d['reason']).length > leaveReasonMax) return 'reason_too_long';
  final att = _s(d['attachment']);
  if (att.isNotEmpty &&
      (att.length > leaveAttachMax || !_dataImage.hasMatch(att))) {
    return 'bad_attachment';
  }
  return null;
}

/// پیام فارسی هر کد خطای مرخصی (سرور یا دستگاه).
String leaveIssueFa(String code) => switch (code) {
  'bad_date' => 'تاریخ را درست انتخاب کنید',
  'bad_range' => 'تاریخ پایان نباید پیش از تاریخ شروع باشد',
  'range_too_long' => 'هر درخواست حداکثر ${_faDigits('$leaveMaxDays')} روز است',
  'bad_kind' => 'نوع مرخصی (روزانه/ساعتی) درست نیست',
  'bad_time' => 'ساعت شروع و پایان را درست بنویسید (مثلاً ۱۰:۰۰ تا ۱۲:۳۰)',
  'bad_type' => 'نوع مرخصی شناخته نشد',
  'reason_too_long' => 'علت بیش از ${_faDigits('$leaveReasonMax')} نویسه است',
  'bad_attachment' => 'پیوست باید عکس (JPG/PNG) و کم‌حجم باشد',
  'leave_decided' => 'این درخواست بررسی شده و دیگر تغییر نمی‌کند',
  'approval_denied' => 'تأیید یا رد مرخصی فقط با مدیر/معاون است',
  _ => 'درخواست مرخصی پذیرفته نشد',
};

/// زمان درخواست برای نمایش: «۲۱ آبان تا ۲۳ آبان (۳ روز)» یا «… · ساعت ۱۰:۰۰ تا ۱۲:۰۰».
String leaveWhenFa(Map<String, Object?> d, String Function(String iso) jdate) {
  final from = _s(d['date']);
  final to = _s(d['date_to']);
  if (_s(d['kind']) == 'hours') {
    return '${jdate(from)} · ساعت ${_faDigits(_s(d['time_from']))} تا ${_faDigits(_s(d['time_to']))}';
  }
  if (to.isNotEmpty && to != from) {
    return '${jdate(from)} تا ${jdate(to)} (${_faDigits('${leaveDays(d)}')} روز)';
  }
  return jdate(from);
}

/// برچسب زیر نام دانش‌آموز در حضور و غیاب (همان `leaveTagFa` وب): «مرخصی (استعلاجی)» یا
/// «مرخصی ساعتی ۱۰:۰۰ تا ۱۲:۰۰».
String leaveTagFa(Map<String, Object?> d) {
  if (_s(d['kind']) == 'hours') {
    return 'مرخصی ساعتی ${_faDigits(_s(d['time_from']))} تا ${_faDigits(_s(d['time_to']))}';
  }
  final type = leaveTypesShortFa[_s(d['type'])];
  return type == null ? 'مرخصی' : 'مرخصی ($type)';
}

/// آیا این مرخصی روز [iso] را می‌پوشاند؟ (برای «مرخصی» در حضور و غیاب)
bool leaveCovers(Map<String, Object?> d, String iso) {
  final from = _s(d['date']);
  if (from.isEmpty) return false;
  final to = _s(d['date_to']).isEmpty || _s(d['kind']) == 'hours'
      ? from
      : _s(d['date_to']);
  return iso.compareTo(from) >= 0 && iso.compareTo(to) <= 0;
}

/// بایت‌های عکس پیوست (یا null).
List<int>? leaveAttachmentBytes(Map<String, Object?> d) {
  final att = _s(d['attachment']);
  final i = att.indexOf(',');
  if (i < 0 || !att.startsWith('data:image/')) return null;
  try {
    return base64Decode(att.substring(i + 1));
  } on FormatException {
    return null;
  }
}

/// data URI از بایت‌های عکس؛ null وقتی نوع شناخته نیست یا از سقف بزرگ‌تر است.
String? leaveAttachmentUri(List<int> bytes) {
  final jpeg = bytes.length > 3 && bytes[0] == 0xFF && bytes[1] == 0xD8;
  final png = bytes.length > 8 && bytes[0] == 0x89 && bytes[1] == 0x50;
  if (!jpeg && !png) return null;
  final uri =
      'data:image/${jpeg ? 'jpeg' : 'png'};base64,${base64Encode(bytes)}';
  return uri.length > leaveAttachMax ? null : uri;
}

String _faDigits(String s) {
  const fa = '۰۱۲۳۴۵۶۷۸۹';
  return s.replaceAllMapped(RegExp(r'\d'), (m) => fa[int.parse(m[0]!)]);
}
