// ردیف ۱۵۰: SchoolProfile.validate بایت‌به‌بایت با server/school-profile.js (بردارهای مشترک).
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_ui/payesh_ui.dart';

const vectorsPath =
    '../../../../docs/cloud/contracts/school-profile-vectors.json';

void main() {
  final v =
      jsonDecode(File(vectorsPath).readAsStringSync()) as Map<String, Object?>;

  test('ثابت‌ها همان سرور', () {
    expect(v['levels'], schoolLevels);
    expect(v['genders'], schoolGenders);
    expect(v['shifts'], schoolShifts);
    expect(v['kinds'], schoolKindsFa);
    expect(v['school_types'], [for (final d in schoolTypeDefs) d.$1]);
    expect(v['caps'], [for (final d in capDefs) d.$1]);
    expect(v['branches'], schoolBranches);
    final max = v['max']! as Map;
    expect(max['capacity'], maxCapacity);
    expect(max['staff'], maxStaff);
    expect(max['excuse'], maxExcuseMinutes);
    expect(max['boom'], maxBoomChars);
  });

  test('همهٔ بردارها (خطا یا patch)', () {
    final cases = (v['cases']! as List).cast<Map<String, Object?>>();
    expect(cases.length, greaterThanOrEqualTo(20));
    for (final c in cases) {
      final r = SchoolProfile.validate(
        (c['input']! as Map).cast<String, Object?>(),
      );
      if (c['error'] != null) {
        expect(r.error, c['error'], reason: '${c['id']}');
        expect(r.patch, isNull);
        expect(schoolProfileErrorsFa.containsKey(r.error), isTrue);
        expect(r.messageFa, isNotEmpty);
      } else {
        expect(r.error, isNull, reason: '${c['id']}');
        expect(r.messageFa, isNull);
        expect(
          jsonEncode(r.patch),
          jsonEncode(c['patch']),
          reason: '${c['id']}',
        );
      }
    }
  });

  test('وابستگی‌ها: نوع مدرسه ⇒ قابلیت‌ها؛ شب ⇒ شبانه', () {
    expect(capsForType('boarding')['has_dorm'], 1);
    expect(capsForType('governmental')['has_tuition'], 0);
    expect(capsForType('vocational')['has_workshop'], 1);
    expect(capsForType('x')['has_second_term_exam'], 1);
    final r = SchoolProfile.validate({
      'level': 'ابتدایی',
      'gender': 'دخترانه',
      'shift': 'هر دو',
      'capacity': 1.5,
      'work_days': [0],
      'excuse_window_minutes': 0,
    });
    expect(r.error, 'capacity');
    final ok = SchoolProfile.validate({
      'level': 'ابتدایی',
      'gender': 'دخترانه',
      'shift': 'هر دو',
      'capacity': 40.0,
      'work_days': [1.0, 0],
      'excuse_window_minutes': '۱۰',
      'branches': ['نظری'],
    });
    expect(ok.patch!['capabilities'], containsPair('has_evening', 1));
    expect(ok.patch!['branches'], isEmpty);
    expect(ok.patch!['work_days'], [0, 1]);
    expect(ok.patch!['excuse_window_minutes'], 10);
    expect(
      SchoolProfile.validate({
        'level': 'ابتدایی',
        'gender': 'دخترانه',
        'capacity': 40,
        'work_days': [1.5],
        'excuse_window_minutes': 1,
      }).error,
      'work_days',
    );
    expect(weekDays.length, 7);
    expect(defaultWorkDays, [0, 1, 2, 3, 4]);
    expect(capDefaults['has_tuition'], 1);
  });
}
