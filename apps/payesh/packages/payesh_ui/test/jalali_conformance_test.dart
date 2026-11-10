// Runs the shared Jalali vectors (docs/cloud/contracts/conformance/jalali-v1.json — generated
// from and checked against the WEB client by tests/conformance-jalali-73.js) on the Dart port.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_ui/payesh_ui.dart';

const vectorsPath =
    '../../../../docs/cloud/contracts/conformance/jalali-v1.json';

void main() {
  final doc =
      jsonDecode(File(vectorsPath).readAsStringSync()) as Map<String, Object?>;
  List<Map<String, Object?>> list(String k) =>
      (doc[k]! as List<Object?>).cast<Map<String, Object?>>();

  test('schema + names identical to the web client', () {
    expect(doc['schema'], 'jalali-v1');
    expect(doc['months'], jalaliMonths);
    expect(doc['weekdays'], jalaliWeekdays);
  });

  test('ISO → Jalali, jdate text, slash form and weekday match the web for every vector', () {
    final dates = list('dates');
    expect(dates.length, greaterThan(2000));
    for (final v in dates) {
      final iso = v['iso']! as String;
      final j = JalaliDate.fromIso(iso)!;
      expect([j.year, j.month, j.day], v['jalali'], reason: iso);
      expect(j.jdate, v['jdate'], reason: iso);
      expect(j.slash, v['slash'], reason: iso);
      expect(j.weekday, v['weekday'], reason: iso);
      expect(j.toIso(), iso, reason: 'round trip $iso');
    }
  });

  test(
    'Jalali input → ISO matches the web import rules (incl. rejections)',
    () {
      for (final v in list('jalali_to_iso')) {
        final want = v['iso']! as String;
        final got = JalaliDate.parse(v['input']! as String)?.toIso() ?? '';
        expect(got, want, reason: '${v['input']}');
      }
    },
  );

  test('digits: Persian rendering and normalisation match fa()/norm()', () {
    for (final v in list('digits')) {
      expect(faDigits(v['latin']), v['fa']);
      expect(latinDigits(v['fa']), v['back']);
    }
  });

  test('unreadable dates render as — like the web jdate', () {
    for (final v in list('invalid_jdate')) {
      expect(jalaliText(v['input']! as String), v['jdate']);
    }
  });
}
