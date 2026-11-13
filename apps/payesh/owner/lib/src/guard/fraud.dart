// گزارش تراکنش‌های مشکوک اشتراک (ردیف ۱۵۴) — تابع خالص روی پرداخت‌های صندوقچه.
//
// قاعده‌ها (هر کدام یک یافته با شدت):
//   dup_ref          high    یک کد پیگیری/رسید یا کد تراکنش درگاه برای چند پرداخت (حتی در مدرسه‌های مختلف)
//   amount_low       high    مبلغ کمتر از قیمت فعلی همان نقش و همان پلن
//   zero_amount      high    پرداختِ پرداخت‌شده یا تأییدشده با مبلغ صفر یا منفی
//   plan_not_offered medium  پلنی که برای آن نقش عرضه نمی‌شود، یا نقشی که رایگان است
//   no_ref           medium  پرداخت درگاهیِ «پرداخت‌شده» بدون کد تراکنش درگاه
//   burst_user       medium  سه پرداخت یا بیشتر از یک کاربر در ۲۴ ساعت
//   failed_burst     medium  پنج پرداخت ناموفق/ردشده یا بیشتر از یک مدرسه در یک ساعت
//   amount_high      low     مبلغ بیشتر از قیمت فعلی (ممکن است قیمت عوض شده باشد)
//   future_date      low     زمان ثبت پرداخت بیش از ۱۰ دقیقه جلوتر از اکنون
// هیچ چیزی خودکار رد یا لغو نمی‌شود؛ مالک بررسی و تصمیم می‌گیرد.

import 'package:flutter/foundation.dart';

import '../schools/school_registry.dart';

abstract final class FraudSeverity {
  static const String high = 'high';
  static const String medium = 'medium';
  static const String low = 'low';
  static int rank(String s) => switch (s) {
    high => 0,
    medium => 1,
    _ => 2,
  };
}

@immutable
final class FraudFinding {
  const FraudFinding({
    required this.code,
    required this.severity,
    required this.paymentIds,
    required this.titleFa,
    required this.detailFa,
    this.schoolId = '',
  });
  final String code;
  final String severity;
  final List<String> paymentIds;
  final String schoolId;
  final String titleFa;
  final String detailFa;

  /// شناسهٔ پایدار (برای «بررسی شد»).
  String get id => '$code:${([...paymentIds]..sort()).join(',')}';
}

String _s(Object? v) => v == null ? '' : '$v';
int? _int(Object? v) => v is num ? v.round() : int.tryParse(_s(v));
DateTime? _at(Object? v) => DateTime.tryParse(_s(v))?.toUtc();

/// وضعیت مؤثر: تصمیم مالک (اگر هست) بر وضعیت سرور مقدم است.
String effectivePaymentStatus(Map<String, Object?> p) {
  final d = p['decision'];
  if (d is Map && d['status'] is String) return d['status']! as String;
  return _s(p['status']);
}

String _normRef(String r) =>
    r.replaceAll(RegExp(r'[\s\-_/.]'), '').toLowerCase();

const Map<String, String> fraudTitles = {
  'dup_ref': 'کد پیگیری تکراری',
  'amount_low': 'مبلغ کمتر از قیمت',
  'zero_amount': 'پرداخت با مبلغ صفر',
  'plan_not_offered': 'پلن یا نقش بدون عرضه',
  'no_ref': 'پرداخت درگاهی بدون کد تراکنش',
  'burst_user': 'پرداخت‌های پی‌درپی یک کاربر',
  'failed_burst': 'پرداخت‌های ناموفق پی‌درپی',
  'amount_high': 'مبلغ بیشتر از قیمت',
  'future_date': 'زمان ثبت در آینده',
};

List<FraudFinding> suspiciousPayments(
  List<Map<String, Object?>> payments,
  SubSettings settings, {
  required DateTime now,
}) {
  final out = <FraudFinding>[];
  String who(Map<String, Object?> p) {
    final n = _s(p['name']);
    return '${n.isEmpty ? 'کاربر ${_s(p['uid'])}' : n} (${_s(p['id'])})';
  }

  // dup_ref
  final byRef = <String, List<Map<String, Object?>>>{};
  final shown = <String, String>{};
  for (final p in payments) {
    for (final raw in {_s(p['ref']), _s(p['gateway_ref'])}) {
      final r = _normRef(raw);
      if (r.length < 4) continue;
      shown.putIfAbsent(r, () => raw);
      final l = byRef.putIfAbsent(r, () => []);
      if (!l.contains(p)) l.add(p);
    }
  }
  for (final e in byRef.entries) {
    final ids = {for (final p in e.value) _s(p['id'])};
    if (ids.length < 2) continue;
    final schools = {for (final p in e.value) _s(p['school_id'])};
    out.add(
      FraudFinding(
        code: 'dup_ref',
        severity: FraudSeverity.high,
        paymentIds: ids.toList()..sort(),
        schoolId: schools.length == 1 ? schools.first : '',
        titleFa: fraudTitles['dup_ref']!,
        detailFa:
            'کد پیگیری «${shown[e.key]}» برای ${ids.length} پرداخت '
            '${schools.length > 1 ? 'در ${schools.length} مدرسهٔ مختلف ' : ''}ثبت شده است.',
      ),
    );
  }

  for (final p in payments) {
    final id = _s(p['id']);
    final st = effectivePaymentStatus(p);
    final amount = _int(p['amount']);
    final role = _s(p['role']);
    final plan = _s(p['plan']);
    final school = _s(p['school_id']);
    final counted = st == 'paid' || st == 'approved' || st == 'pending';
    if (_s(p['method']) == 'gateway' &&
        _s(p['status']) == 'paid' &&
        _s(p['approved_by']) == 'gateway' &&
        _normRef(_s(p['gateway_ref'])).isEmpty) {
      out.add(
        FraudFinding(
          code: 'no_ref',
          severity: FraudSeverity.medium,
          paymentIds: [id],
          schoolId: school,
          titleFa: fraudTitles['no_ref']!,
          detailFa:
              '${who(p)}: درگاه «پرداخت‌شده» گزارش داده ولی کد تراکنش برنگردانده است.',
        ),
      );
    }
    if (amount != null && amount <= 0 && (st == 'paid' || st == 'approved')) {
      out.add(
        FraudFinding(
          code: 'zero_amount',
          severity: FraudSeverity.high,
          paymentIds: [id],
          schoolId: school,
          titleFa: fraudTitles['zero_amount']!,
          detailFa:
              '${who(p)} با مبلغ ${amount < 0 ? 'منفی' : 'صفر'} '
              '${st == 'paid' ? 'پرداخت‌شده' : 'تأییدشده'} است.',
        ),
      );
      continue;
    }
    if (counted && role.isNotEmpty && plan.isNotEmpty) {
      final free = settings.roles[role] == 'free';
      final price = settings.rolePrices[role]?[plan];
      if (free || (settings.rolePrices.containsKey(role) && price == null)) {
        out.add(
          FraudFinding(
            code: 'plan_not_offered',
            severity: FraudSeverity.medium,
            paymentIds: [id],
            schoolId: school,
            titleFa: fraudTitles['plan_not_offered']!,
            detailFa: free
                ? '${who(p)}: نقش «$role» رایگان است ولی پرداخت ثبت شده.'
                : '${who(p)}: پلن «$plan» برای نقش «$role» عرضه نمی‌شود.',
          ),
        );
      } else if (price != null && amount != null && amount > 0) {
        if (amount < price) {
          out.add(
            FraudFinding(
              code: 'amount_low',
              severity: FraudSeverity.high,
              paymentIds: [id],
              schoolId: school,
              titleFa: fraudTitles['amount_low']!,
              detailFa:
                  '${who(p)}: $amount ریال پرداخت شده؛ قیمت فعلی $price ریال است.',
            ),
          );
        } else if (amount > price) {
          out.add(
            FraudFinding(
              code: 'amount_high',
              severity: FraudSeverity.low,
              paymentIds: [id],
              schoolId: school,
              titleFa: fraudTitles['amount_high']!,
              detailFa:
                  '${who(p)}: $amount ریال پرداخت شده؛ قیمت فعلی $price ریال است '
                  '(شاید قیمت پس از پرداخت عوض شده).',
            ),
          );
        }
      }
    }
    final at = _at(p['created_at']);
    if (at != null &&
        at.isAfter(now.toUtc().add(const Duration(minutes: 10)))) {
      out.add(
        FraudFinding(
          code: 'future_date',
          severity: FraudSeverity.low,
          paymentIds: [id],
          schoolId: school,
          titleFa: fraudTitles['future_date']!,
          detailFa: '${who(p)}: زمان ثبت ${_s(p['created_at'])} است.',
        ),
      );
    }
  }

  // پنجره‌های زمانی
  List<List<Map<String, Object?>>> windows(
    Iterable<Map<String, Object?>> list,
    Duration span,
    int min,
  ) {
    final sorted = [
      for (final p in list)
        if (_at(p['created_at']) != null) p,
    ]..sort((a, b) => _at(a['created_at'])!.compareTo(_at(b['created_at'])!));
    final res = <List<Map<String, Object?>>>[];
    var i = 0;
    while (i < sorted.length) {
      final start = _at(sorted[i]['created_at'])!;
      var j = i;
      while (j + 1 < sorted.length &&
          _at(sorted[j + 1]['created_at'])!.difference(start) <= span) {
        j++;
      }
      if (j - i + 1 >= min) {
        res.add(sorted.sublist(i, j + 1));
        i = j + 1;
      } else {
        i++;
      }
    }
    return res;
  }

  final byUser = <String, List<Map<String, Object?>>>{};
  final failedBySchool = <String, List<Map<String, Object?>>>{};
  for (final p in payments) {
    final st = effectivePaymentStatus(p);
    if (st == 'failed' || st == 'rejected') {
      failedBySchool.putIfAbsent(_s(p['school_id']), () => []).add(p);
    } else if (st != 'cancelled') {
      byUser
          .putIfAbsent('${_s(p['school_id'])}|${_s(p['uid'])}', () => [])
          .add(p);
    }
  }
  for (final e in byUser.entries) {
    for (final w in windows(e.value, const Duration(hours: 24), 3)) {
      out.add(
        FraudFinding(
          code: 'burst_user',
          severity: FraudSeverity.medium,
          paymentIds: [for (final p in w) _s(p['id'])]..sort(),
          schoolId: _s(w.first['school_id']),
          titleFa: fraudTitles['burst_user']!,
          detailFa: '${who(w.first)}: ${w.length} پرداخت در کمتر از ۲۴ ساعت.',
        ),
      );
    }
  }
  for (final e in failedBySchool.entries) {
    for (final w in windows(e.value, const Duration(hours: 1), 5)) {
      out.add(
        FraudFinding(
          code: 'failed_burst',
          severity: FraudSeverity.medium,
          paymentIds: [for (final p in w) _s(p['id'])]..sort(),
          schoolId: e.key,
          titleFa: fraudTitles['failed_burst']!,
          detailFa:
              'مدرسهٔ ${e.key}: ${w.length} پرداخت ناموفق یا ردشده در کمتر از یک ساعت.',
        ),
      );
    }
  }
  out.sort((a, b) {
    final r = FraudSeverity.rank(a.severity) - FraudSeverity.rank(b.severity);
    return r != 0 ? r : a.id.compareTo(b.id);
  });
  return out;
}
