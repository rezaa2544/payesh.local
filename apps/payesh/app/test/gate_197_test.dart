// Row 197 (Q06 / F38, F41, F44) — staff posts after login: the guard lands on «درِ مدرسه»
// (today's leave-approved exits + visitors in/out) with no ticks at all; a staff member the
// manager set to «هیچ» sees the «دسترسی ندارید» guide instead of an unexplained short menu;
// a کارمند with no ticks gets the real default (attendance, leaves, notices).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'nav_support.dart';
import 'school_support.dart';

Future<void> base(MemorySchool s) async {
  await s.put('schools', 1, {'name': 'هنرستان نمونه'});
  await s.put('classes', 5, {'name': 'دهم شبکه', 'grade': 'دهم'});
  await s.put('users', 21, {
    'name': 'بهار سعیدی',
    'role': 'student',
    'class_id': 5,
  });
  await s.put('users', 22, {'name': 'نیما', 'role': 'student', 'class_id': 5});
  await s.put('leaves', 7, {
    'student_id': 21,
    'date': '2026-11-12',
    'kind': 'hours',
    'time_from': '10:30',
    'time_to': '12:00',
    'status': 'approved',
  });
  await s.put('leaves', 8, {
    'student_id': 22,
    'date': '2026-11-12',
    'kind': 'hours',
    'time_from': '09:00',
    'status': 'pending',
  });
}

void main() {
  testWidgets(
    'G197-W01 guard, no ticks: «درِ مدرسه» — exits of today, a visitor in and out',
    (tester) async {
      tallView(tester);
      final (_, s) = await bootSchool(
        tester,
        role: 'guard',
        seed: (s) async {
          await base(s);
          await s.put('users', 10, {
            'name': 'نگهبان',
            'role': 'guard',
            'access': <String>[],
          });
        },
      );
      await settle(tester);
      await openPage(tester, 'gate');
      expect(find.text('نقش شما به این بخش دسترسی ندارد'), findsNothing);
      expect(find.byKey(const Key('gate-exit-7')), findsOneWidget);
      expect(
        find.byKey(const Key('gate-exit-8')),
        findsNothing,
        reason: 'pending leave',
      );
      expect(textIn(tester, 'gate-exit-7'), contains('بهار سعیدی'));
      expect(textIn(tester, 'gate-exit-7'), contains('دهم شبکه'));
      expect(find.byKey(const Key('gate-visitors-empty')), findsOneWidget);
      await tester.tap(find.byKey(const Key('gate-add')));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('gate-f-name')),
        'آقای رضایی',
      );
      await tester.enterText(find.byKey(const Key('gate-f-host')), 'معاون');
      await tester.tap(find.byKey(const Key('gate-save')));
      await settle(tester);
      final rows = await tester.runAsync(() => s.engine.list('visitors'));
      expect(rows!.single.data['name'], 'آقای رضایی');
      expect(rows.single.data['date'], '2026-11-12');
      final id = rows.single.id;
      expect(textIn(tester, 'gate-visitor-$id'), contains('داخل مدرسه'));
      await tester.tap(find.byKey(Key('gate-out-$id')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('gate-confirm-ok')));
      await settle(tester);
      expect(textIn(tester, 'gate-visitor-$id'), contains('خارج شد'));
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('G197-W02 «هیچ»: the guide says why and where access is opened', (
    tester,
  ) async {
    tallView(tester);
    await bootSchool(
      tester,
      role: 'office',
      seed: (s) async {
        await base(s);
        await s.put('users', 10, {
          'name': 'اجرایی',
          'role': 'office',
          'access': ['none'],
        });
      },
    );
    await settle(tester);
    expect(navOf('gate'), findsNothing);
    expect(navOf('attendance'), findsNothing);
    await openPage(tester, 'today');
    expect(find.byKey(const Key('noaccess-guide')), findsOneWidget);
    expect(textIn(tester, 'noaccess-how'), contains('سطح دسترسی'));
    expect(textIn(tester, 'noaccess-default'), contains('نمرات'));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('G197-W03 کارمند, no ticks: the real default pages, no guide', (
    tester,
  ) async {
    tallView(tester);
    await bootSchool(
      tester,
      role: 'staff',
      seed: (s) async {
        await base(s);
        await s.put('users', 10, {'name': 'کارمند', 'role': 'staff'});
      },
    );
    await settle(tester);
    await revealNav(tester, 'leaves');
    expect(navOf('leaves'), findsOneWidget);
    expect(find.byKey(const Key('noaccess-guide')), findsNothing);
    expect(navOf('gate'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
}
