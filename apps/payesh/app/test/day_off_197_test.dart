// Row 197 — Q10 (F36) «تعطیل / غیرحضوری»: the manager announces a day off from «اطلاعیه‌ها»;
// every role sees the banner (home, اطلاعیه‌ها, حضور); a closed day takes no attendance.
// Real screens + controllers + books on in-memory SQLite (web twin: tests/day-off-197.js).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/pulse/web.dart';
import 'package:payesh_data/payesh_data.dart';

import 'family_wave5_test.dart' as w5;
import 'nav_support.dart';
import 'school_support.dart';
import 'notices_wave4_test.dart' as w4;

Future<void> seedSchool(SqliteEngine e) async {
  Future<void> put(String c, int id, Map<String, Object?> d) =>
      e.put(c, id, {...d, 'id': id}, version: 1);
  await put('classes', 5, {'name': 'دهم الف'});
  await put('schedule', 900, {'teacher_id': 10, 'class_id': 5});
  await put('users', 21, {'name': 'بهار', 'role': 'student', 'class_id': 5});
  await put('exams', 70, {
    'date': '2026-11-13',
    'title': 'ریاضی',
    'kind': 'internal',
  });
}

void main() {
  testWidgets(
    'DO197-01 manager: «اعلام تعطیلی» → calendar row + important notice, listed, «لغو» removes it',
    (tester) async {
      final src = w4.MemorySource();
      await tester.runAsync(() => seedSchool(src.engine));
      await w4.boot(tester, source: src);
      await openPage(tester, 'announcements');
      expect(find.byKey(const Key('ntc-dayoff-card')), findsOneWidget);
      expect(find.byKey(const Key('ntc-dayoff-none')), findsOneWidget);
      await w4.tapKey(tester, 'ntc-dayoff-add');
      // NEG: no reason → refused in the form, nothing written
      await w4.tapKey(tester, 'dof-submit');
      expect(find.byKey(const Key('dof-error')), findsOneWidget);
      expect(src.outbox.list(), isEmpty);
      await tester.enterText(
        find.byKey(const Key('dof-reason')),
        'آلودگی هوا به اعلام استانداری',
      );
      await w4.tapKey(tester, 'dof-submit');
      expect(find.byKey(const Key('dof-submit')), findsNothing);
      final cal = await tester.runAsync(() => src.engine.list('calendar'));
      final row = cal!.single;
      expect(row.data['date'], '2026-11-13'); // tomorrow by default
      expect(row.data['kind'], 'closed');
      expect(find.byKey(Key('ntc-dayoff-${row.id}')), findsOneWidget);
      final notices = await tester.runAsync(
        () => src.engine.list('announcements'),
      );
      final n = notices!.firstWhere((r) => r.data['kind'] == 'day_off');
      expect(n.data['severity'], 'important');
      expect(n.data['body'], contains('آلودگی هوا'));
      expect(find.byKey(Key('ntc-card-${n.id}')), findsOneWidget);
      expect(src.nudges, greaterThan(0));
      await w4.tapKey(tester, 'ntc-dayoff-cancel-${row.id}');
      expect(find.byKey(Key('ntc-dayoff-${row.id}')), findsNothing);
      expect(await tester.runAsync(() => src.engine.list('calendar')), isEmpty);
    },
  );

  testWidgets(
    'DO197-02 teacher: banners on اطلاعیه‌ها / حضور; a closed day cannot be saved',
    (tester) async {
      final src = w4.MemorySource();
      await tester.runAsync(() async {
        await seedSchool(src.engine);
        await src.engine.put('calendar', 1, {
          'id': 1,
          'date': '2026-11-12',
          'kind': 'closed',
          'reason': 'کمبود انرژی',
        }, version: 1);
        await src.engine.put('calendar', 2, {
          'id': 2,
          'date': '2026-11-13',
          'kind': 'remote',
          'reason': 'آلودگی هوا',
        }, version: 1);
      });
      await w4.boot(tester, role: 'teacher', source: src);
      await openPage(tester, 'announcements');
      expect(find.byKey(const Key('ntc-dayoff-today')), findsOneWidget);
      // NEG: no manager controls for a teacher
      expect(find.byKey(const Key('ntc-dayoff-add')), findsNothing);
      await openPage(tester, 'attendance');
      await w4.tapKey(tester, 'att-class-5');
      expect(find.byKey(const Key('att-dayoff')), findsOneWidget);
      expect(textIn(tester, 'att-dayoff'), contains('تعطیل'));
      final save = tester.widget(find.byKey(const Key('att-save')));
      final onPressed = switch (save) {
        final WebBtn b => b.onPressed,
        final ButtonStyleButton b => b.onPressed,
        _ => fail('att-save is ${save.runtimeType}'),
      };
      expect(onPressed, isNull);
    },
  );

  Future<void> putDays(
    Future<void> Function(String, int, Map<String, Object?>) put,
  ) async {
    await put('calendar', 1, {
      'id': 1,
      'date': '2026-11-13',
      'kind': 'remote',
      'reason': 'آلودگی هوا',
    });
    // NEG: a day off of another day draws nothing
    await put('calendar', 2, {
      'id': 2,
      'date': '2026-11-20',
      'kind': 'closed',
      'reason': 'دیگر',
    });
  }

  testWidgets(
    'DO197-03 home: «فردا غیرحضوری است» on the teacher\'s and the parent\'s home',
    (tester) async {
      tester.view.physicalSize = const Size(2400, 24000);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      await bootSchool(
        tester,
        role: 'teacher',
        seed: (s) async {
          await s.put('users', 10, {'name': 'دبیر', 'role': 'teacher'});
          await putDays((c, id, d) => s.put(c, id, d));
        },
      );
      await openPage(tester, 'home');
      expect(find.byKey(const Key('dash-dayoff-tomorrow')), findsOneWidget);
      expect(textIn(tester, 'dash-dayoff-tomorrow'), contains('غیرحضوری'));
      expect(textIn(tester, 'dash-dayoff-tomorrow'), contains('آلودگی هوا'));
      expect(find.byKey(const Key('dash-dayoff-today')), findsNothing);
      await tester.pumpWidget(const SizedBox());

      final src = w5.MemorySource();
      await tester.runAsync(
        () => putDays((c, id, d) => src.engine.put(c, id, d, version: 1)),
      );
      await w5.boot(tester, source: src);
      await settleAsync(tester);
      expect(find.byKey(const Key('fam-dayoff-tomorrow')), findsOneWidget);
      expect(textIn(tester, 'fam-dayoff-tomorrow'), contains('غیرحضوری'));
      expect(find.byKey(const Key('fam-dayoff-today')), findsNothing);
    },
  );
}
