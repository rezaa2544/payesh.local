// Row 197 — Q08 (F34) module-based and Q09 (F35) descriptive assessment on the REAL «نمره»
// screen, controller and GradeBook (in-memory SQLite + durable outbox). Web twin:
// client/pages.js `PAGES.grades` (tests/grades-scheme-197.js).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_sync/payesh_sync.dart';

import 'grades_wave3_test.dart' as w3;
import 'nav_support.dart';

Future<w3.MemorySource> school(
  WidgetTester tester,
  Map<String, Object?> row,
) async {
  final src = w3.MemorySource();
  await tester.runAsync(
    () => src.engine.put('schools', 1, {...row, 'id': 1}, version: 1),
  );
  return src;
}

Future<void> choose(WidgetTester tester, String key, String label) async {
  await tester.ensureVisible(find.byKey(Key(key)));
  await tester.tap(find.byKey(Key(key)));
  await tester.pumpAndSettle();
  await tester.tap(find.text(label).last);
  await w3.settle(tester);
}

Future<List<Map<String, Object?>>> grades(
  WidgetTester tester,
  w3.MemorySource src,
) async =>
    (await tester.runAsync(() => src.engine.byRef('grades', 'class_id', 5)))!
        .map((r) => r.data)
        .toList();

void main() {
  testWidgets(
    'G197-W01 هنرستان: workshop subject → «پودمان ۱..۵», شایستگی + مستمر, module score and course result',
    (tester) async {
      final src = await school(tester, {
        'level': 'متوسطه دوم',
        'school_type': 'vocational',
      });
      await w3.boot(tester, source: src);
      await openPage(tester, 'grades');
      await w3.pick(tester, 'grd-subject', 'کارگاه برق');
      await w3.tapKey(tester, 'grd-show');
      expect(find.byKey(const Key('grd-modular')), findsOneWidget);
      expect(w3.textOf(tester, 'grd-scale'), contains('پودمانی'));
      expect(find.text('پودمان ۱'), findsWidgets);
      await choose(tester, 'grd-c-21', '۲ — احراز شایستگی');
      await tester.enterText(find.byKey(const Key('grd-m-21')), '۳٫۵');
      await tester.pump();
      expect(w3.textOf(tester, 'grd-ms-21'), contains('۱۳٫۵'));
      await w3.tapKey(tester, 'grd-save');
      final g = (await grades(tester, src)).single;
      expect(g['kind'], 'module');
      expect(g['term'], 'پودمان ۱');
      expect(g['competency'], 2);
      expect(g['continuous'], 3.5);
      expect(g['score'], 13.5);
      expect(gradeRowIssue(g), isNull);
      expect(
        w3.textOf(tester, 'grd-result-21'),
        'در حال ارزشیابی (۱ از ۵ پودمان)',
      );
      // NEG: a numeric subject of the same school keeps «نوبت» and 0..20
      await w3.pick(tester, 'grd-subject', 'ریاضی');
      await w3.tapKey(tester, 'grd-show');
      expect(find.byKey(const Key('grd-modular')), findsNothing);
      expect(w3.textOf(tester, 'grd-scale'), 'نمره از ۲۰');
    },
  );

  testWidgets(
    'G197-W02 ابتدایی: descriptive select, «ثبت ارزشیابی», level stored without a number',
    (tester) async {
      final src = await school(tester, {
        'level': 'ابتدایی',
        'school_type': 'governmental',
      });
      await w3.boot(tester, source: src);
      await openPage(tester, 'grades');
      expect(find.byKey(const Key('grd-l-21')), findsOneWidget);
      expect(find.byKey(const Key('grd-21')), findsNothing);
      expect(find.text('ثبت ارزشیابی'), findsOneWidget);
      await choose(tester, 'grd-l-21', 'نیاز به تلاش بیشتر');
      await w3.tapKey(tester, 'grd-save');
      final g = (await grades(tester, src)).single;
      expect(g['kind'], 'descriptive');
      expect(g['level'], 'نیاز به تلاش بیشتر');
      expect(g['score'], isNull);
    },
  );
}
