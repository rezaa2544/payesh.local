import 'dart:math';

import 'package:payesh_core/payesh_core.dart' show newIdempotencyKey;

/// Pages of the owner panel, in the order of the retired web panel (`PAGES`).
const List<(String, String)> ownerPages = [
  ('dashboard', 'داشبورد'),
  ('schools', 'مدارس'),
  ('plans', 'پلن و اشتراک'),
  ('limits', 'سقف و مصرف'),
  ('health', 'سلامت'),
  ('infra', 'زیرساخت'),
  ('operators', 'اپراتورها و مجوز'),
  ('reports', 'گزارش'),
  ('audit', 'ممیزی'),
];

/// Shared input rules and display helpers of the owner panel (same patterns as
/// apps/owner-panel/web/app.js; the server re-validates everything).
final RegExp credentialRefRe = RegExp(r'^secret:[A-Z][A-Z0-9_]{2,63}$');
final RegExp providerCodeRe = RegExp(r'^[a-z0-9][a-z0-9_-]{1,39}$');
final RegExp slugRe = RegExp(r'^[a-z0-9][a-z0-9-]{2,39}$');
final RegExp planCodeRe = RegExp(r'^[a-z0-9_-]{2,40}$');
final RegExp regionRe = RegExp(r'^[A-Za-z0-9 ._-]{1,40}$');
final RegExp endpointRe = RegExp(
  r'^(https?|tcp):\/\/[A-Za-z0-9.\-\[\]:]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~\/%-]*)?$',
);
final RegExp loginIdRe = RegExp(r'^[A-Za-z0-9._@-]{3,120}$');

const String secretHint =
    'رمز، توکن یا کلید را هرگز اینجا وارد نکنید. فقط نام Secret تعریف‌شده روی سرور را به شکل secret:NAME بنویسید (مثلاً secret:RADCLOUD_API_TOKEN).';

/// `secret:NAME` or empty; anything else is refused before it leaves the device.
String? credentialError(String v) {
  if (v.isEmpty) return null;
  return credentialRefRe.hasMatch(v)
      ? null
      : 'فقط ارجاع به Secret پذیرفته می‌شود: secret:NAME (حروف بزرگ لاتین، رقم و _).';
}

/// Persian/Arabic-Indic digits → ASCII (user input normalisation).
String normDigits(String? s) {
  final b = StringBuffer();
  for (final r in (s ?? '').runes) {
    if (r >= 0x06F0 && r <= 0x06F9) {
      b.writeCharCode(0x30 + r - 0x06F0);
    } else if (r >= 0x0660 && r <= 0x0669) {
      b.writeCharCode(0x30 + r - 0x0660);
    } else {
      b.writeCharCode(r);
    }
  }
  return b.toString();
}

String _faDigits(String s) {
  final b = StringBuffer();
  for (final r in s.runes) {
    if (r >= 0x30 && r <= 0x39) {
      b.writeCharCode(0x06F0 + r - 0x30);
    } else {
      b.writeCharCode(r);
    }
  }
  return b.toString();
}

/// Number with Persian digits and `٬` thousands separators; `—` for null/empty.
String faNum(Object? n) {
  if (n == null || n == '') return '—';
  final num? x = n is num ? n : num.tryParse('$n');
  if (x == null || x.isNaN || x.isInfinite) return '$n';
  final neg = x < 0;
  final abs = x.abs();
  final String whole;
  String frac = '';
  if (abs == abs.truncate()) {
    whole = abs.toInt().toString();
  } else {
    final parts = abs.toString().split('.');
    whole = parts[0];
    frac = parts.length > 1 ? parts[1] : '';
    if (frac.length > 3) frac = frac.substring(0, 3);
    frac = frac.replaceAll(RegExp(r'0+$'), '');
  }
  final g = StringBuffer();
  for (var i = 0; i < whole.length; i++) {
    if (i > 0 && (whole.length - i) % 3 == 0) g.write('٬');
    g.write(whole[i]);
  }
  final s = '${neg ? '−' : ''}$g${frac.isEmpty ? '' : '٫$frac'}';
  return _faDigits(s);
}

/// Bytes → Persian size text (same thresholds as the web panel).
String faBytes(Object? n) {
  final num? x = n is num ? n : num.tryParse('${n ?? ''}');
  if (x == null || x.isNaN || x.isInfinite) return '—';
  String one(num v) => faNum(num.parse(v.toStringAsFixed(1)));
  if (x >= 1073741824) return '${one(x / 1073741824)} گیگابایت';
  if (x >= 1048576) return '${one(x / 1048576)} مگابایت';
  if (x >= 1024) return '${one(x / 1024)} کیلوبایت';
  return '${faNum(x)} بایت';
}

String shortId(Object? id) {
  final s = id == null ? '' : '$id';
  if (s.isEmpty) return '—';
  return s.length > 8 ? s.substring(0, 8) : s;
}

/// New request/idempotency id (v4 UUID).
String requestId([Random? random]) => newIdempotencyKey(random);

/// (label, tone) of a status; tone ∈ ok/info/warn/bad/'' like the web badges.
const Map<String, (String, String)> statusLabels = {
  'active': ('فعال', 'ok'),
  'trialing': ('آزمایشی', 'info'),
  'suspended': ('تعلیق', 'bad'),
  'past_due': ('معوق', 'warn'),
  'grace': ('مهلت', 'warn'),
  'canceled': ('لغوشده', 'bad'),
  'expired': ('منقضی', 'bad'),
  'disabled': ('غیرفعال', 'bad'),
  'locked': ('قفل', 'bad'),
  'pending': ('منتظر تأیید', 'warn'),
  'provisioning': ('در حال ساخت', 'warn'),
  'approved': ('تأییدشده، در مهلت', 'warn'),
  'executed': ('اجراشده (داده نگه‌داری می‌شود)', 'bad'),
};

(String, String) statusLabel(Object? status) =>
    statusLabels['$status'] ??
    (status == null || status == '' ? '—' : '$status', '');

const List<(String, String)> infraMetrics = [
  ('capacity_cpu', 'ظرفیت CPU'),
  ('usage_cpu', 'مصرف CPU'),
  ('capacity_memory', 'ظرفیت حافظه'),
  ('usage_memory', 'مصرف حافظه'),
  ('capacity_disk', 'ظرفیت دیسک'),
  ('usage_disk', 'مصرف دیسک'),
  ('capacity_connections', 'ظرفیت اتصال'),
  ('usage_connections', 'اتصال‌های فعال'),
  ('error_rate', 'نرخ خطا'),
  ('latency_p95', 'تأخیر p95'),
];
const Map<String, String> infraUnits = {
  'cores': 'هسته',
  'percent': 'درصد',
  'mb': 'مگابایت',
  'gb': 'گیگابایت',
  'count': 'عدد',
  'ms': 'میلی‌ثانیه',
  'ratio': 'نسبت',
};
const Map<String, String> infraDefaultUnit = {
  'capacity_cpu': 'cores',
  'usage_cpu': 'percent',
  'capacity_memory': 'gb',
  'usage_memory': 'gb',
  'capacity_disk': 'gb',
  'usage_disk': 'gb',
  'capacity_connections': 'count',
  'usage_connections': 'count',
  'error_rate': 'percent',
  'latency_p95': 'ms',
};
const Map<String, (String, String)> infraLabels = {
  'M': ('اندازه‌گیری‌شده [M]', 'ok'),
  'E': ('برآورد [E]', 'warn'),
  '?': ('بدون داده', ''),
};
const Map<String, String> infraProviderKinds = {
  'host': 'هاست',
  'vps': 'VPS',
  'vpc': 'VPC',
  'db': 'پایگاه داده',
  'storage': 'ذخیره‌سازی',
  'other': 'سایر',
};
const Map<String, String> infraServiceKinds = {
  'gateway': 'Gateway',
  'postgres': 'PostgreSQL',
  'host': 'هاست',
  'vps': 'VPS',
  'vpc': 'VPC',
  'storage': 'ذخیره‌سازی',
  'backup': 'پشتیبان',
  'other': 'سایر',
};
const Map<String, (String, String)> infraHealth = {
  'up': ('سالم', 'ok'),
  'down': ('قطع', 'bad'),
  'unknown': ('نامعلوم', ''),
};
const Map<String, String> infraChanges = {
  'disable_provider': 'غیرفعال‌سازی ارائه‌دهنده',
  'enable_provider': 'فعال‌سازی ارائه‌دهنده',
  'set_credential_ref': 'تغییر ارجاع Secret',
  'disable_endpoint': 'غیرفعال‌سازی Endpoint',
};
const Map<String, (String, String)> infraChangeStatus = {
  'pending': ('منتظر تأیید مالک', 'warn'),
  'executed': ('اجراشده', 'ok'),
  'rejected': ('ردشده', 'bad'),
};

/// Hash-chain breaks among the shown audit events (newest first): consecutive sequence
/// ids whose `previous_hash` does not equal the next event's `event_hash`. Display-only
/// indicator, like the web panel; the authoritative recomputation runs in server tests.
int auditChainBreaks(List<Map<String, Object?>> events) {
  var broken = 0;
  for (var i = 0; i + 1 < events.length; i++) {
    final a = num.tryParse('${events[i]['sequence_id']}');
    final b = num.tryParse('${events[i + 1]['sequence_id']}');
    if (a != null &&
        b != null &&
        a == b + 1 &&
        events[i]['previous_hash'] != events[i + 1]['event_hash']) {
      broken++;
    }
  }
  return broken;
}

/// Subscriptions counted by status and by plan (the read-only «گزارش» page).
({Map<String, int> byStatus, Map<String, int> byPlan}) subscriptionReport(
  List<Map<String, Object?>> subs,
) {
  final byStatus = <String, int>{};
  final byPlan = <String, int>{};
  for (final s in subs) {
    final st = '${s['status']}';
    final pl = '${s['plan_code']}';
    byStatus[st] = (byStatus[st] ?? 0) + 1;
    byPlan[pl] = (byPlan[pl] ?? 0) + 1;
  }
  return (byStatus: byStatus, byPlan: byPlan);
}

/// Validation of the «درخواست مجوز پشتیبانی» form; null = valid.
String? supportGrantError({
  required String tenantId,
  required String caseRef,
  required DateTime? notified,
  required DateTime? starts,
  required num hours,
}) {
  if (!RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    caseSensitive: false,
  ).hasMatch(tenantId)) {
    return 'شناسهٔ مدرسه نامعتبر است.';
  }
  if (caseRef.isEmpty) return 'شمارهٔ پرونده را وارد کنید.';
  if (notified == null || starts == null) {
    return 'زمان اطلاع‌رسانی و شروع را وارد کنید.';
  }
  if (!notified.isBefore(starts)) {
    return 'مدرسه باید پیش از شروع مجوز مطلع شده باشد.';
  }
  if (!(hours >= 1 && hours <= 72) || hours != hours.truncate()) {
    return 'مدت باید بین ۱ تا ۷۲ ساعت باشد.';
  }
  return null;
}

/// Validation of «ثبت Endpoint»; null = valid.
String? endpointError(String url, String checkKind, String expectedStatus) {
  if (url.contains('@')) return 'نام کاربری یا رمز در نشانی مجاز نیست.';
  if (!endpointRe.hasMatch(url)) {
    return 'نشانی باید با http://، https:// یا tcp:// شروع شود.';
  }
  if ((checkKind == 'tcp') != url.startsWith('tcp://')) {
    return 'نوع بررسی با پروتکل نشانی هم‌خوان نیست.';
  }
  final n = normDigits(expectedStatus);
  if (n.isNotEmpty) {
    final v = num.tryParse(n);
    if (v == null || v < 100 || v > 599) {
      return 'کد مورد انتظار باید بین ۱۰۰ و ۵۹۹ باشد.';
    }
  }
  return null;
}
