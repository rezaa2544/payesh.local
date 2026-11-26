// Row 187 — «نقش شما به این بخش دسترسی ندارد» for a معاون: the role `vice` was not a known
// role anywhere, so every page refused it and only «سیستم» was left. Now معاون has exactly
// the manager's access (permRole), and every other role gets its p2 definition.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/app.dart';
import 'package:payesh_app/src/login/session_controller.dart';

import 'nav_support.dart';
import 'school_support.dart';

Future<void> seed(MemorySchool s) async {
  await s.put('schools', 1, {'name': 'هنرستان نمونه'});
  await s.put('classes', 5, {'name': 'دهم شبکه', 'grade': 'دهم'});
  await s.put('users', 21, {
    'name': 'بهار سعیدی',
    'role': 'student',
    'class_id': 5,
    'grade': 'دهم',
    'branch': 'شبکه',
  });
  await s.put('users', 22, {'name': 'نیما', 'role': 'student', 'class_id': 5});
}

Future<void> seedVice(MemorySchool s) async {
  await seed(s);
  await s.put('users', 10, {'name': '1', 'role': 'vice'});
}

Future<void> seedCounselor(MemorySchool s) async {
  await seed(s);
  await s.put('users', 10, {'name': 'مشاور', 'role': 'counselor'});
  await s.put('counselor_refs', 2100000000000001, {
    'student_id': 21,
    'reason': 'تأخیر مکرر',
    'status': 'open',
    'referred_at': '2026-11-10T08:00:00Z',
  });
}

void main() {
  test('R187-A01 the vice navigation is the manager navigation', () {
    expect(webNavConfig('vice'), webNavConfig('manager'));
    expect(webNavConfig('deputy'), webNavConfig('manager'));
    expect(webNavConfig('counselor').first.$1, 'cqueue');
    for (final r in ['staff', 'office', 'guard']) {
      expect(webNavConfig(r).map((e) => e.$1), [
        'home',
        'announcements',
        'system',
      ]);
    }
  });

  test('R187-A02 SignedIn: permission role manager, label معاون', () {
    const s = SignedIn(school: 'x', role: 'vice', uid: 10);
    expect(s.currentRole, 'manager');
    expect(s.titleRole, 'vice');
    expect(s.roleFa, 'معاون');
  });

  testWidgets('R187-A03 a vice opens the manager pages (users) — no refusal', (
    tester,
  ) async {
    tallView(tester);
    await bootSchool(tester, role: 'vice', seed: seedVice);
    expect(navOf('users'), findsOneWidget);
    expect(navOf('classes'), findsOneWidget);
    await openPage(tester, 'users');
    expect(find.text('نقش شما به این بخش دسترسی ندارد'), findsNothing);
    expect(find.byKey(const Key('usr-row-21')), findsOneWidget);
    await openPage(tester, 'system');
    // the label keeps the saved role
    expect(find.textContaining('نقش: معاون'), findsOneWidget);
    expect(find.text('نقش شما به این بخش دسترسی ندارد'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('R187-A04 counselor: the referral queue, handled with a note', (
    tester,
  ) async {
    tallView(tester);
    await bootSchool(tester, role: 'counselor', seed: seedCounselor);
    expect(navOf('students'), findsNothing);
    expect(navOf('users'), findsNothing);
    await openPage(tester, 'cqueue');
    expect(find.byKey(const Key('cq-add')), findsNothing);
    final row = find.byKey(const Key('cq-row-2100000000000001'));
    expect(row, findsOneWidget);
    expect(textIn(tester, 'cq-row-2100000000000001'), contains('بهار سعیدی'));
    expect(textIn(tester, 'cq-row-2100000000000001'), contains('تأخیر مکرر'));
    await tester.tap(find.byKey(const Key('cq-done-2100000000000001')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('cq-note')), 'تماس با ولی');
    await tester.tap(find.byKey(const Key('cq-done-save')));
    await settle(tester);
    expect(textIn(tester, 'cq-row-2100000000000001'), contains('پیگیری شد'));
    expect(textIn(tester, 'cq-row-2100000000000001'), contains('تماس با ولی'));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('R187-A05 the manager refers a student to the counselor', (
    tester,
  ) async {
    tallView(tester);
    final (_, s) = await bootSchool(
      tester,
      role: 'manager',
      seed: (s) async {
        await seed(s);
        await s.put('users', 10, {'name': 'مدیر', 'role': 'manager'});
      },
    );
    await openPage(tester, 'cqueue');
    expect(find.byKey(const Key('cq-empty')), findsOneWidget);
    await tester.tap(find.byKey(const Key('cq-add')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('cq-f-student')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('بهار سعیدی').last);
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('cq-f-reason')), 'غیبت مکرر');
    await tester.tap(find.byKey(const Key('cq-save')));
    await settle(tester);
    final rows = await tester.runAsync(() => s.engine.list('counselor_refs'));
    expect(rows!.single.data['student_id'], 21);
    expect(rows.single.data['status'], 'open');
    await tester.pumpWidget(const SizedBox());
  });
}
