// ردیف ۱۴۹ — بردار مشترک پایان اشتراک‌ها (Node server/academic-year.js = Dart AcademicYear).
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_ui/payesh_ui.dart';

const vectorsPath =
    '../../../../docs/cloud/contracts/academic-year-vectors.json';

void main() {
  final doc =
      jsonDecode(File(vectorsPath).readAsStringSync()) as Map<String, Object?>;

  test('Jalali ⇄ Gregorian vectors', () {
    for (final j in (doc['jalali']! as List).cast<List<Object?>>()) {
      final g = JalaliDate(
        j[3]! as int,
        j[4]! as int,
        j[5]! as int,
      ).toGregorian();
      expect([g.$1, g.$2, g.$3], j.sublist(0, 3));
      final r = JalaliDate.fromGregorian(
        j[0]! as int,
        j[1]! as int,
        j[2]! as int,
      );
      expect([r.year, r.month, r.day], j.sublist(3));
    }
  });

  test('every case matches Node', () {
    final cases = (doc['cases']! as List).cast<Map<String, Object?>>();
    expect(cases.length, greaterThanOrEqualTo(10));
    String iso(DateTime t) => t.toUtc().toIso8601String();
    for (final c in cases) {
      final name = c['name']! as String;
      final now = DateTime.parse(c['now']! as String);
      final cur = c['cur_end'] == null
          ? null
          : DateTime.parse(c['cur_end']! as String);
      expect(AcademicYear.yearOf(now), c['academic_year'], reason: name);
      expect(iso(AcademicYear.yearEnd(now)), c['year_end'], reason: name);
      expect(iso(AcademicYear.renewOpen(now)), c['renew_open'], reason: name);
      expect(AcademicYear.inRenewWindow(now), c['in_renew'], reason: name);
      expect(
        iso(AcademicYear.monthlyEnd(now, cur)),
        c['monthly_end'],
        reason: name,
      );
      expect(
        iso(AcademicYear.yearlyEnd(now, cur)),
        c['yearly_end'],
        reason: name,
      );
      expect(
        iso(AcademicYear.daysEnd(now, 10, cur)),
        c['days10_end'],
        reason: name,
      );
      expect(
        AcademicYear.renewWarning(now, cur),
        c['renew_warning'],
        reason: name,
      );
    }
  });

  test('planEnd and yearEndLabel', () {
    final t = DateTime.utc(2026, 11, 13, 10);
    expect(AcademicYear.planEnd('yearly', t), AcademicYear.yearlyEnd(t));
    expect(AcademicYear.planEnd('monthly', t), AcademicYear.monthlyEnd(t));
    expect(AcademicYear.yearEndLabel(t), '۳۱ شهریور ۱۴۰۶');
  });
}
