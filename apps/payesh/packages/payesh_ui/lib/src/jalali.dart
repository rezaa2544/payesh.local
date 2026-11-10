import 'digits.dart';

/// Persian month names, identical to the web client's `J_MONTHS`.
const List<String> jalaliMonths = [
  'فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', //
  'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند',
];

/// Week days starting on Saturday, identical to the web client's `J_DAYS`.
const List<String> jalaliWeekdays = [
  'شنبه',
  'یک‌شنبه',
  'دوشنبه',
  'سه‌شنبه',
  'چهارشنبه',
  'پنج‌شنبه',
  'جمعه',
];

int _div(int a, int b) => (a / b).floor();

/// A Jalali (Solar Hijri) calendar date — **display only**. Storage, sync and the API always
/// use ISO `yyyy-MM-dd` (Gregorian); convert at the edge with [JalaliDate.fromIso] / [toIso].
///
/// Port of the web client's algorithms (client/app.js `toJalali`, client/import.js
/// `impToGregorian`), verified against the shared vectors
/// docs/cloud/contracts/conformance/jalali-v1.json and an exhaustive round trip.
final class JalaliDate implements Comparable<JalaliDate> {
  const JalaliDate._(this.year, this.month, this.day);

  /// Validating constructor; throws [ArgumentError] for an impossible date (e.g. 1404/12/30).
  factory JalaliDate(int year, int month, int day) {
    if (month < 1 || month > 12 || day < 1 || day > monthLength(year, month)) {
      throw ArgumentError('invalid Jalali date $year/$month/$day');
    }
    return JalaliDate._(year, month, day);
  }

  factory JalaliDate.fromGregorian(int gy, int gm, int gd) {
    const gdm = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    var jy = gy <= 1600 ? 0 : 979;
    gy -= gy <= 1600 ? 621 : 1600;
    final gy2 = gm > 2 ? gy + 1 : gy;
    var days =
        365 * gy +
        _div(gy2 + 3, 4) -
        _div(gy2 + 99, 100) +
        _div(gy2 + 399, 400) -
        80 +
        gd +
        gdm[gm - 1];
    jy += 33 * _div(days, 12053);
    days %= 12053;
    jy += 4 * _div(days, 1461);
    days %= 1461;
    if (days > 365) {
      jy += _div(days - 1, 365);
      days = (days - 1) % 365;
    }
    final jm = days < 186 ? 1 + _div(days, 31) : 7 + _div(days - 186, 30);
    final jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
    return JalaliDate._(jy, jm, jd);
  }

  factory JalaliDate.fromDateTime(DateTime d) =>
      JalaliDate.fromGregorian(d.year, d.month, d.day);

  /// From an ISO date (`2026-11-10`, or a full timestamp — only the date part is used, as the
  /// web's `jdate`). Returns null when it cannot be read.
  static JalaliDate? fromIso(String? iso) {
    if (iso == null || iso.length < 10) return null;
    final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})').firstMatch(iso);
    if (m == null) return null;
    final y = int.parse(m[1]!), mo = int.parse(m[2]!), d = int.parse(m[3]!);
    final dt = DateTime.utc(y, mo, d);
    if (dt.year != y || dt.month != mo || dt.day != d) return null;
    return JalaliDate.fromGregorian(y, mo, d);
  }

  /// Parses user input like `۱۴۰۵/۸/۱۹`, `1405-08-19`, `١٤٠٥/٠٨/١٩` — the web import rules
  /// (`impJalaliToIso`): year 1201‥1699, month 1‥12, day 1‥31; otherwise null.
  static JalaliDate? parse(String? input) {
    final m = RegExp(r'(\d{4})\D(\d{1,2})\D(\d{1,2})')
        .firstMatch(latinDigits(input));
    if (m == null) return null;
    final y = int.parse(m[1]!), mo = int.parse(m[2]!), d = int.parse(m[3]!);
    if (!(y > 1200 && y < 1700) || mo < 1 || mo > 12 || d < 1 || d > 31) {
      return null;
    }
    return JalaliDate._(y, mo, d);
  }

  final int year;
  final int month;
  final int day;

  /// Gregorian (year, month, day) — same arithmetic as the web `impToGregorian`.
  (int, int, int) toGregorian() {
    var jy = year;
    var gy = jy <= 979 ? 621 : 1600;
    jy -= jy <= 979 ? 0 : 979;
    var days =
        365 * jy +
        _div(jy, 33) * 8 +
        _div(jy % 33 + 3, 4) +
        78 +
        day +
        (month < 7 ? (month - 1) * 31 : (month - 7) * 30 + 186);
    gy += 400 * _div(days, 146097);
    days %= 146097;
    if (days > 36524) {
      days--;
      gy += 100 * _div(days, 36524);
      days %= 36524;
      if (days >= 365) days++;
    }
    gy += 4 * _div(days, 1461);
    days %= 1461;
    if (days > 365) {
      gy += _div(days - 1, 365);
      days = (days - 1) % 365;
    }
    var gd = days + 1;
    final leap = (gy % 4 == 0 && gy % 100 != 0) || gy % 400 == 0;
    final sal = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    var gm = 1;
    for (; gm <= 12 && gd > sal[gm]; gm++) {
      gd -= sal[gm];
    }
    return (gy, gm, gd);
  }

  String _p2(int n) => n.toString().padLeft(2, '0');

  /// ISO `yyyy-MM-dd` for storage / sync.
  String toIso() {
    final (y, m, d) = toGregorian();
    return '${y.toString().padLeft(4, '0')}-${_p2(m)}-${_p2(d)}';
  }

  /// 0 = Saturday … 6 = Friday (web `weekdayIndex`).
  int get weekday {
    final (y, m, d) = toGregorian();
    return (DateTime.utc(y, m, d).weekday % 7 + 1) % 7;
  }

  String get monthName => jalaliMonths[month - 1];
  String get weekdayName => jalaliWeekdays[weekday];

  /// Web `jdate` text with Latin digits, e.g. `19 آبان 1405` (used for vector parity).
  String get jdate => '$day $monthName $year';

  /// Web `impIsoToJalali` form `1405/08/19`.
  String get slash => '$year/${_p2(month)}/${_p2(day)}';

  /// What the user sees: `۱۹ آبان ۱۴۰۵`.
  String format({bool weekday = false}) =>
      faDigits(weekday ? '$weekdayName $jdate' : jdate);

  /// Numeric display `۱۴۰۵/۰۸/۱۹`.
  String formatShort() => faDigits(slash);

  /// Leap year by the same arithmetic used for conversion (30 Esfand exists).
  static bool isLeapYear(int year) {
    final next = JalaliDate._(year + 1, 1, 1).toGregorian();
    final last = JalaliDate._(year, 12, 29).toGregorian();
    return DateTime.utc(
          next.$1,
          next.$2,
          next.$3,
        ).difference(DateTime.utc(last.$1, last.$2, last.$3)).inDays ==
        2;
  }

  static int monthLength(int year, int month) => month <= 6
      ? 31
      : month <= 11
      ? 30
      : (isLeapYear(year) ? 30 : 29);

  @override
  int compareTo(JalaliDate o) => year != o.year
      ? year - o.year
      : (month != o.month ? month - o.month : day - o.day);

  @override
  bool operator ==(Object other) =>
      other is JalaliDate &&
      other.year == year &&
      other.month == month &&
      other.day == day;

  @override
  int get hashCode => Object.hash(year, month, day);

  @override
  String toString() => slash;
}

/// ISO → displayed Jalali (`۱۹ آبان ۱۴۰۵`); `—` when empty/unreadable (web `jdate` behaviour).
String jalaliText(String? iso, {bool weekday = false}) =>
    JalaliDate.fromIso(iso)?.format(weekday: weekday) ?? '—';
