// Row 201 — the owner's four points after 0.9.69: a smart Excel import of branches (sure fixes
// by itself, asks for the rest, nothing created silently), a users search that filters in
// memory, the follow-up rows with exactly «✏️ اصلاح» and «حذف / نادیده گرفتن», and the items of
// «کلاس‌ها» opening their details with editing right there.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/pulse/web.dart';

import 'nav_support.dart';
import 'school_support.dart';

Future<void> seed(MemorySchool s) async {
  await s.put('schools', 1, {'name': 'کاردانش', 'level': 'متوسطه دوم'});
  await s.put('lookups', 1, {'kind': 'grade', 'name': 'دهم'});
  await s.put('lookups', 10, {'kind': 'branch', 'name': 'تعمیر موتور'});
  await s.put('lookups', 11, {'kind': 'branch', 'name': 'تعمیر موتور موتور'});
  await s.put('lookups', 12, {'kind': 'branch', 'name': 'الکتروتکنیک'});
  await s.put('lookups', 13, {'kind': 'branch', 'name': 'نقشه کشی'});
  await s.put('classes', 20, {
    'name': 'دهم تعمیر موتور',
    'grade': 'دهم',
    'branch': 'تعمیر موتور',
    'kind': 'group',
  });
  await s.put('classes', 30, {'name': 'کارگاه برق', 'kind': 'room'});
  await s.put('subjects', 40, {'name': 'ریاضی'});
  await s.put('users', 10, {'name': 'مدیر', 'role': 'manager'});
  await s.put('users', 100, {
    'name': 'علی موتوری',
    'role': 'student',
    'grade': 'دهم',
    'field': 'تعمیر موتور',
    'national_id': '0012345678',
  });
  await s.put('users', 101, {
    'name': 'رضا تکراری',
    'role': 'student',
    'grade': 'دهم',
    'field': 'تعمیر موتور موتور',
    'phone': '09121112233',
  });
  await s.put('import_issues', 70, {
    'name': 'آتیلا خدری',
    'national_id': '3840544971',
    'phone': '09187864105',
    'reasons': [
      'کد ملی مادر «38409918467» معتبر نیست — باید دقیقاً ۱۰ رقم باشد (این مقدار ۱۱ رقم است)؛ همین‌جا اصلاحش کنید.',
    ],
    'data': {
      'full_name': 'آتیلا خدری',
      'national_id': '3840544971',
      'role': 'student',
      'mother_nid': '38409918467',
    },
    'status': 'open',
  });
}

Future<MemorySchool> boot(WidgetTester tester, String page) async {
  tester.view.physicalSize = const Size(1280, 900);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final (_, s) = await bootSchool(tester, role: 'manager', seed: seed);
  await openPage(tester, page);
  return s;
}

void main() {
  testWidgets(
    'R201-01 follow-up rows: two actions on one line; «اصلاح» = the user form '
    'with the row; NEG no «ساخته نشده» chip, «حذف» asks first',
    (tester) async {
      final s = await boot(tester, 'followup');
      await reveal(tester, 'fu-issue-70');
      expect(find.text('ساخته نشده'), findsNothing);
      expect(find.text('ساختن کاربر'), findsNothing);
      expect(find.text('حل شد'), findsNothing);
      final fix = find.byKey(const Key('fu-issue-fix-70'));
      final del = find.byKey(const Key('fu-issue-done-70'));
      expect(tester.widget<WebBtn>(fix).label, '✏️ اصلاح');
      expect(tester.widget<WebBtn>(del).label, 'حذف / نادیده گرفتن');
      // one line each, side by side (they were squeezed into a column, word by word)
      expect(tester.getSize(fix).height, lessThan(48));
      expect(tester.getSize(del).height, lessThan(48));
      expect(
        (tester.getCenter(fix).dy - tester.getCenter(del).dy).abs(),
        lessThan(4),
      );
      await tapKey(tester, 'fu-issue-done-70');
      await tapKey(tester, 'fu-issue-confirm-cancel');
      expect(s.outbox.list(), isEmpty);
      await tapKey(tester, 'fu-issue-fix-70');
      await reveal(tester, 'usr-f-mother_nid');
      final nid = tester.widget<TextField>(
        find.byKey(const Key('usr-f-mother_nid')),
      );
      expect(nid.controller!.text, '38409918467');
    },
  );

  testWidgets('R201-02 import: a word written twice / a synonym are fixed and listed; a new '
      'branch is asked; NEG «ثبت» waits for the answer', (tester) async {
    final s = await boot(tester, 'followup');
    await tapKey(tester, 'fu-import');
    await tapKey(tester, 'imp-grade-دهم');
    await typeKey(
      tester,
      'imp-paste',
      'نام و نام خانوادگی,کد ملی,رشته\n'
          'سینا کاظمی,0012345679,تعمیر موتورموتور\n'
          'سارا نوری,0023456789,برق صنعتی\n'
          'مینا رحیمی,0034567891,معماری\n'
          'نیما راد,0045678912,حسابداری\n',
    );
    await tapKey(tester, 'imp-next');
    await tapKey(tester, 'imp-check');
    expect(find.byKey(const Key('imp-ask')), findsOneWidget);
    expect(find.text('رشتهٔ «حسابداری» در فهرست رشته‌ها نیست'), findsOneWidget);
    expect(find.byKey(const Key('imp-fixes')), findsOneWidget);
    expect(find.text('«تعمیر موتورموتور» ← تعمیر موتور'), findsOneWidget);
    expect(find.text('«برق صنعتی» ← الکتروتکنیک'), findsOneWidget);
    expect(find.text('«معماری» ← نقشه کشی'), findsOneWidget);
    await reveal(tester, 'imp-apply');
    expect(
      tester.widget<WebBtn>(find.byKey(const Key('imp-apply'))).onPressed,
      isNull,
    );
    expect(find.byKey(const Key('imp-apply-wait')), findsOneWidget);
    await tester.drag(find.byType(ListView).last, const Offset(0, 4000));
    await settle(tester);
    await tapKey(tester, 'imp-new-add-0');
    expect(find.byKey(const Key('imp-ask')), findsNothing);
    await reveal(tester, 'imp-apply');
    expect(
      tester.widget<WebBtn>(find.byKey(const Key('imp-apply'))).onPressed,
      isNotNull,
    );
    expect(s.outbox.list(), isEmpty, reason: 'nothing written before «ثبت»');
  });

  testWidgets(
    'R201-03 classes: a branch opens its details; the duplicate offers «ادغام» and '
    'its students move; a class and a subject open their details too',
    (tester) async {
      final s = await boot(tester, 'classes');
      await tester.tap(find.text('تعمیر موتور موتور').first);
      await settleAsync(tester);
      expect(find.byKey(const Key('def-detail')), findsOneWidget);
      expect(find.byKey(const Key('def-like')), findsOneWidget);
      // row 204: a sorted table of the students with their details, not a cloud of names
      expect(find.byKey(const Key('def-students-table')), findsOneWidget);
      expect(find.byKey(const Key('def-stu-101')), findsOneWidget);
      expect(find.text('رضا تکراری'), findsWidgets);
      expect(find.byKey(const Key('def-f-name')), findsOneWidget);
      await tapKey(tester, 'def-like-merge');
      await tapKey(tester, 'def-merge-confirm-ok');
      await settleAsync(tester);
      expect(find.byKey(const Key('def-detail')), findsNothing);
      expect(find.text('تعمیر موتور موتور'), findsNothing);
      final moved = s.outbox.list().where(
        (o) => o.collection == 'users' && o.id == 101,
      );
      expect(moved.single.payload!['field'], 'تعمیر موتور');
      // a room and a subject
      await tester.tap(find.byKey(const Key('cls-room-open-30')));
      await settleAsync(tester);
      expect(find.byKey(const Key('room-detail')), findsOneWidget);
      expect(find.byKey(const Key('room-f-name')), findsOneWidget);
      await tapKey(tester, 'room-form-back');
      await reveal(tester, 'cls-subject-40');
      await tester.tap(find.text('ریاضی').first);
      await settleAsync(tester);
      expect(find.byKey(const Key('sub-detail')), findsOneWidget);
      expect(find.byKey(const Key('sub-f-name')), findsOneWidget);
    },
  );

  testWidgets(
    'R201-04 users search filters in memory: ي/ك and Persian digits match',
    (tester) async {
      await boot(tester, 'users');
      await typeKey(tester, 'usr-search', 'علي');
      await tester.pump(const Duration(milliseconds: 200));
      await settle(tester);
      expect(find.text('علی موتوری'), findsWidgets);
      expect(find.text('رضا تکراری'), findsNothing);
      await typeKey(tester, 'usr-search', '۰۹۱۲۱۱۱');
      await tester.pump(const Duration(milliseconds: 200));
      await settle(tester);
      expect(find.text('رضا تکراری'), findsWidgets);
      expect(find.text('علی موتوری'), findsNothing);
    },
  );
}
