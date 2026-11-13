import 'digits.dart';
import 'jalali.dart';

/// سال تحصیلی و پایان اشتراک‌ها (ردیف ۱۴۹) — برگردان دقیق server/academic-year.js.
///
/// * همهٔ اشتراک‌ها در پایان سال تحصیلی (۳۱ شهریور ساعت ۲۴ تهران) تمام می‌شوند.
/// * ماهانه: ۳۱ روز از پرداخت (یا از پایان فعلی)، با سقف پایان همان سال.
/// * سالانه: مبلغ کامل، تا پایان سال جاری؛ از ۱ تیر (پنجرهٔ تمدید) تا پایان سال بعد.
/// * هشدار تمدید مدیران از ۱ تیر تا وقتی سال بعد خریده نشده.
///
/// بردار مشترک: docs/cloud/contracts/academic-year-vectors.json.
abstract final class AcademicYear {
  static const Duration tehranOffset = Duration(hours: 3, minutes: 30);
  static const int monthlyDays = 31;
  static const int renewMonth = 4;

  static JalaliDate tehranJalali(DateTime t) {
    final d = t.toUtc().add(tehranOffset);
    return JalaliDate.fromGregorian(d.year, d.month, d.day);
  }

  /// ساعت ۰۰:۰۰ تهرانِ یک روز جلالی (UTC).
  static DateTime tehranMidnight(int jy, int jm, int jd) {
    final (gy, gm, gd) = JalaliDate(jy, jm, jd).toGregorian();
    return DateTime.utc(gy, gm, gd).subtract(tehranOffset);
  }

  /// سال تحصیلی با سال پایانی‌اش (۱۴۰۵-۱۴۰۶ ⇒ 1406).
  static int yearOf(DateTime t) {
    final j = tehranJalali(t);
    return j.month >= 7 ? j.year + 1 : j.year;
  }

  /// ۳۱ شهریور ساعت ۲۴ (= ۱ مهر ۰۰:۰۰ تهران)؛ همیشه بعد از t.
  static DateTime yearEnd(DateTime t) => tehranMidnight(yearOf(t), 7, 1);

  /// ۱ تیر سال تحصیلیِ t.
  static DateTime renewOpen(DateTime t) =>
      tehranMidnight(yearOf(t), renewMonth, 1);

  static bool inRenewWindow(DateTime t) => !t.isBefore(renewOpen(t));

  static DateTime _from(DateTime now, DateTime? cur) =>
      cur != null && cur.isAfter(now) ? cur : now;

  static DateTime _min(DateTime a, DateTime b) => a.isBefore(b) ? a : b;

  static DateTime monthlyEnd(DateTime now, [DateTime? cur]) {
    final from = _from(now, cur);
    return _min(from.add(const Duration(days: monthlyDays)), yearEnd(from));
  }

  static DateTime yearlyEnd(DateTime now, [DateTime? cur]) {
    var end = yearEnd(now);
    if (inRenewWindow(now)) end = yearEnd(end);
    if (cur != null && !cur.isBefore(end)) end = yearEnd(cur);
    return end;
  }

  static DateTime daysEnd(DateTime now, int days, [DateTime? cur]) {
    final from = _from(now, cur);
    return _min(from.add(Duration(days: days)), yearEnd(from));
  }

  static DateTime planEnd(String plan, DateTime now, [DateTime? cur]) =>
      plan == 'yearly' ? yearlyEnd(now, cur) : monthlyEnd(now, cur);

  static bool renewWarning(DateTime now, DateTime? end) {
    if (!inRenewWindow(now)) return false;
    return !(end != null && end.isAfter(yearEnd(now)));
  }

  /// متن کوتاه «تا ۳۱ شهریور ۱۴۰۶» برای پایان سال تحصیلیِ t.
  static String yearEndLabel(DateTime t) =>
      '۳۱ شهریور ${faDigits('${yearOf(t)}')}';
}
