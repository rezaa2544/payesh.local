import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_ui/payesh_ui.dart';

void main() {
  test('exhaustive: every day 1900-01-01 … 2150-12-31 round-trips and is contiguous', () {
    var d = DateTime.utc(1900);
    var prev = JalaliDate.fromDateTime(d);
    var n = 0;
    while (d.year <= 2150) {
      final j = JalaliDate.fromDateTime(d);
      final (y, m, dd) = j.toGregorian();
      expect((y, m, dd), (d.year, d.month, d.day));
      expect(JalaliDate(j.year, j.month, j.day), j, reason: '$j valid');
      if (n > 0) {
        final next = prev.day < JalaliDate.monthLength(prev.year, prev.month)
            ? (prev.year, prev.month, prev.day + 1)
            : prev.month < 12
            ? (prev.year, prev.month + 1, 1)
            : (prev.year + 1, 1, 1);
        expect((j.year, j.month, j.day), next, reason: 'after $prev');
      }
      prev = j;
      d = d.add(const Duration(days: 1));
      n++;
    }
    expect(n, greaterThan(91000));
  });

  test('known dates incl. the Nowruz regression fixed in the web client', () {
    expect(JalaliDate.fromIso('2026-11-10')!.format(), '۱۹ آبان ۱۴۰۵');
    expect(JalaliDate.fromIso('2026-11-10')!.weekdayName, 'سه‌شنبه');
    expect(JalaliDate.fromIso('2024-03-20')!.slash, '1403/01/01');
    expect(JalaliDate.fromIso('2028-03-20')!.slash, '1407/01/01');
    expect(JalaliDate.fromIso('2025-03-20')!.slash, '1403/12/30');
    expect(JalaliDate.fromIso('2025-03-21')!.slash, '1404/01/01');
    expect(JalaliDate(1405, 8, 19).toIso(), '2026-11-10');
    expect(JalaliDate(1405, 8, 19).formatShort(), '۱۴۰۵/۰۸/۱۹');
    expect(
      JalaliDate(1405, 8, 19).format(weekday: true),
      'سه‌شنبه ۱۹ آبان ۱۴۰۵',
    );
  });

  test('leap years and month lengths', () {
    expect(JalaliDate.isLeapYear(1403), isTrue);
    expect(JalaliDate.isLeapYear(1404), isFalse);
    expect(JalaliDate.isLeapYear(1408), isTrue);
    expect(JalaliDate.monthLength(1404, 1), 31);
    expect(JalaliDate.monthLength(1404, 7), 30);
    expect(JalaliDate.monthLength(1404, 12), 29);
    expect(JalaliDate.monthLength(1403, 12), 30);
  });

  test('validation and parsing', () {
    expect(() => JalaliDate(1404, 12, 30), throwsArgumentError);
    expect(() => JalaliDate(1404, 13, 1), throwsArgumentError);
    expect(() => JalaliDate(1404, 7, 31), throwsArgumentError);
    expect(JalaliDate.parse('۱۴۰۵/۸/۱۹'), JalaliDate(1405, 8, 19));
    expect(JalaliDate.parse(null), isNull);
    expect(JalaliDate.fromIso('2026-02-30'), isNull);
    expect(JalaliDate.fromIso('2026-1-1'), isNull);
    expect(JalaliDate.fromIso(null), isNull);
    expect(JalaliDate.fromIso('2026-11-10T23:59:00Z'), JalaliDate(1405, 8, 19));
    expect(jalaliText(null), '—');
    expect(jalaliText('2026-11-10', weekday: true), 'سه‌شنبه ۱۹ آبان ۱۴۰۵');
  });

  test('ordering, equality, toString', () {
    final a = JalaliDate(1405, 1, 1),
        b = JalaliDate(1405, 1, 2),
        c = JalaliDate(1405, 2, 1);
    final list = [c, b, a, JalaliDate(1404, 12, 29)]..sort();
    expect(list.first.year, 1404);
    expect(list.last, c);
    expect(a.compareTo(a), 0);
    expect(a.hashCode, JalaliDate(1405, 1, 1).hashCode);
    expect(a == b, isFalse);
    expect('$a', '1405/01/01');
    expect(JalaliDate.fromGregorian(1500, 6, 1).toIso(), '1500-06-01');
  });

  test('digits helpers', () {
    expect(faDigits(null), '');
    expect(faDigits(2026), '۲۰۲۶');
    expect(latinDigits(null), '');
    expect(latinDigits('۱۲٣abc'), '123abc');
    expect(faNumber(0), '۰');
    expect(faNumber(999), '۹۹۹');
    expect(faNumber(1234567), '۱٬۲۳۴٬۵۶۷');
    expect(faNumber(-1000), '−۱٬۰۰۰');
  });
}
