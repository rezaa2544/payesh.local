// Row 128, wave W10 — follow-up list, open import rows and the bulk-import wizard. Widget tests
// drive the REAL app shell, page, controllers, Followup and SchoolImport on an in-memory SQLite +
// durable outbox; the real server path is packages/payesh_sync/test/school_admin_it_test.dart
// W10-IT-*.
import 'dart:convert';
import 'dart:io' show FileSystemException;
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/followup/followup_screen.dart';

import 'school_support.dart';

Future<void> seed(MemorySchool s) async {
  await s.put('schools', 1, {'name': 'هنرستان'});
  await s.put('lookups', 1, {'kind': 'grade', 'name': 'دهم'});
  await s.put('lookups', 2, {'kind': 'branch', 'name': 'الکترونیک'});
  await s.put('lookups', 3, {'kind': 'grade', 'name': 'هفتم'});
  await s.put('classes', 5, {
    'name': 'دهم الکترونیک',
    'grade': 'دهم',
    'branch': 'الکترونیک',
    'kind': 'class',
  });
  await s.put('users', 10, {'name': 'مدیر', 'role': 'manager'});
  await s.put('users', 21, {
    'name': 'بی‌کلاس',
    'role': 'student',
    'phone': '09120000021',
  });
  await s.put('users', 22, {'name': 'کامل', 'role': 'student', 'class_id': 5});
  await s.put('import_issues', 70, {
    'name': 'ردیف ناقص',
    'national_id': '0076543219',
    'phone': '',
    'reasons': ['بدون شمارهٔ همراه'],
    'data': {
      'full_name': 'ردیف ناقص',
      'national_id': '0076543219',
      'role': 'student',
    },
    'status': 'open',
  });
  await s.put('import_issues', 71, {
    'name': 'کامل',
    'reasons': ['پایه در فایل نبود'],
    'status': 'open',
  });
}

Future<MemorySchool> openFollowup(
  WidgetTester tester, {
  MemorySchool? source,
  Future<void> Function(MemorySchool s)? extra,
}) async {
  final (_, s) = await bootSchool(
    tester,
    role: 'manager',
    seed: (s) async {
      await seed(s);
      if (extra != null) await extra(s);
    },
    source: source,
  );
  await tapKey(tester, 'adm-followup');
  return s;
}

Future<void> choose(WidgetTester tester, String dropdown, String text) async {
  await tapKey(tester, dropdown);
  await tester.tap(find.text(text).last);
  await settle(tester);
}

/// Back to the top of the page's list (lazy lists drop the items scrolled away).
Future<void> top(WidgetTester tester) async {
  await tester.drag(find.byType(ListView).last, const Offset(0, 4000));
  await settle(tester);
}

void main() {
  testWidgets('W10-W01 the list: incomplete students and open import rows; NEG a teacher has no '
      'follow-up page and a complete student is not listed', (tester) async {
    await openFollowup(tester);
    expect(textOf(tester, 'fu-count'), '۳ مورد برای رسیدگی');
    expect(find.byKey(const Key('fu-stud-21')), findsOneWidget);
    expect(find.byKey(const Key('fu-stud-22')), findsNothing);
    expect(textOf(tester, 'fu-reason-21'), '⚠️ پایه و رشته ندارد');
    await reveal(tester, 'fu-issue-state-70');
    expect(badgeOf(tester, 'fu-issue-state-70'), 'ساخته نشده');
    await reveal(tester, 'fu-issue-state-71');
    expect(badgeOf(tester, 'fu-issue-state-71'), 'در سامانه هست');
    await tester.pumpWidget(const SizedBox());
    await bootSchool(tester, role: 'teacher', seed: seed);
    expect(find.byKey(const Key('adm-followup')), findsNothing);
  });

  testWidgets(
    'W10-W02 followup-assign: NEG no grade refused (nothing queued); a 7th grade gets its class',
    (tester) async {
      final s = await openFollowup(tester);
      await tapKey(tester, 'fu-assign-21');
      expect(textOf(tester, 'fu-error'), 'اول پایه را انتخاب کنید');
      expect(s.outbox.list(), isEmpty);
      await choose(tester, 'fu-grade-21', 'هفتم');
      await tapKey(tester, 'fu-assign-21');
      expect(textOf(tester, 'fu-notice'), 'در «هفتم» ثبت شد');
      expect(s.outbox.list().map((o) => o.collection), ['classes', 'users']);
      expect(s.outbox.list().last.payload!['grade'], 'هفتم');
      expect(find.byKey(const Key('fu-stud-21')), findsNothing);
      expect(find.byKey(const Key('fu-students-none')), findsOneWidget);
    },
  );

  testWidgets(
    'W10-W03 followup-ack keeps the student without a class and leaves the list',
    (tester) async {
      final s = await openFollowup(tester);
      await tapKey(tester, 'fu-ack-21');
      expect(textOf(tester, 'fu-notice'), 'از فهرست پیگیری برداشته شد');
      final op = s.outbox.list().single;
      expect(op.payload!['followup_ack'], isTrue);
      expect(op.payload!['class_id'], isNull);
      expect(find.byKey(const Key('fu-stud-21')), findsNothing);
    },
  );

  testWidgets(
    'W10-W04 issue-done and issues-clear close the import rows (queued)',
    (tester) async {
      final s = await openFollowup(tester);
      await tapKey(tester, 'fu-issue-done-71');
      expect(find.byKey(const Key('fu-issue-71')), findsNothing);
      expect(s.outbox.list().single.payload!['status'], 'done');
      await tapKey(tester, 'fu-issues-clear');
      expect(textOf(tester, 'fu-notice'), '۱ ردیف حل‌شده شد');
      expect(find.byKey(const Key('fu-issues-none')), findsOneWidget);
      expect(s.outbox.list(), hasLength(2));
    },
  );

  testWidgets(
    'W10-W05 issue-fix: the user form opens with the row\'s values; NEG a bad national '
    'id keeps the row open; saving creates the user and closes the row',
    (tester) async {
      final s = await openFollowup(tester);
      await tapKey(tester, 'fu-issue-fix-70');
      final name = tester.widget<TextField>(
        find.byKey(const Key('usr-f-name')),
      );
      expect(name.controller!.text, 'ردیف ناقص');
      await typeKey(tester, 'usr-f-nid', '123');
      await tapKey(tester, 'usr-save');
      expect(find.byKey(const Key('usr-form-error')), findsOneWidget);
      expect(s.outbox.list(), isEmpty);
      await typeKey(tester, 'usr-f-nid', '0076543219');
      await typeKey(tester, 'usr-f-phone', '09120000070');
      await tapKey(tester, 'usr-save');
      expect(find.byKey(const Key('usr-save')), findsNothing);
      expect(s.outbox.list().map((o) => o.collection), [
        'users',
        'import_issues',
      ]);
      expect(find.byKey(const Key('fu-issue-70')), findsNothing);
      expect(badgeOf(tester, 'fu-issue-state-71'), 'در سامانه هست');
    },
  );

  testWidgets(
    'W10-W06 import wizard: NEG no grade blocks the file step; map → check → fix a short mobile '
    '→ branch question → apply (users + open rows queued); a refused row stays in follow-up',
    (tester) async {
      final s = await openFollowup(tester);
      await tapKey(tester, 'fu-import');
      expect(find.byKey(const Key('imp-grade-hint')), findsOneWidget);
      await reveal(tester, 'imp-next');
      expect(
        tester
            .widget<FilledButton>(find.byKey(const Key('imp-next')))
            .onPressed,
        isNull,
      );
      await tapKey(tester, 'imp-grade-دهم');
      await typeKey(
        tester,
        'imp-paste',
        'نام و نام خانوادگی,کد ملی,موبایل,رشته\n'
            'سینا کاظمی,0012345678,0912555555,الکترونیک\n'
            'سارا نوری,0023456789,09126666666,الکترونیگ\n'
            'بد,12,,الکترونیک\n',
      );
      await tapKey(tester, 'imp-next');
      expect(badgeOf(tester, 'imp-mapped'), '۴ ستون نگاشت شد');
      await tapKey(tester, 'imp-check');
      expect(find.byKey(const Key('imp-ask')), findsOneWidget);
      expect(badgeOf(tester, 'imp-stat-total'), 'کل ردیف‌ها: ۳');
      await tapKey(tester, 'imp-ask-yes-0');
      expect(find.byKey(const Key('imp-ask')), findsNothing);
      await top(tester);
      expect(find.byKey(const Key('imp-fixes')), findsOneWidget);
      expect(badgeOf(tester, 'imp-stat-ready'), 'آمادهٔ ثبت: ۱');
      // a short mobile is fixed in place
      await tapKey(tester, 'imp-fix-0');
      await typeKey(tester, 'imp-fix-f-phone', '09125555555');
      await tapKey(tester, 'imp-fix-save');
      expect(textOf(tester, 'imp-notice'), 'اصلاح شد و به «آمادهٔ ثبت» رفت ✅');
      expect(badgeOf(tester, 'imp-stat-ready'), 'آمادهٔ ثبت: ۲');
      await tapKey(tester, 'imp-recheck');
      expect(textOf(tester, 'imp-notice'), 'دوباره بررسی شد');
      expect(
        s.outbox.list(),
        isEmpty,
        reason: 'nothing is written before «ثبت»',
      );
      await tapKey(tester, 'imp-apply');
      expect(textOf(tester, 'imp-result'), contains('۲ کاربر ثبت شد'));
      expect(find.byKey(const Key('imp-saved')), findsOneWidget);
      final cols = s.outbox.list().map((o) => o.collection).toSet();
      expect(cols, containsAll(['users', 'import_issues']));
      final sara = s.outbox.list().firstWhere(
        (o) => o.payload?['name'] == 'سارا نوری',
      );
      expect(sara.payload!['class_id'], 5);
      await tapKey(tester, 'imp-issues-open');
      expect(find.byKey(const Key('fu-issues-count')), findsOneWidget);
      expect(find.text('بد'), findsOneWidget);
    },
  );

  testWidgets('W10-W07 import-open from a file on the device; import-back; NEG an unreadable '
      'file is reported and the wizard stays on step 1', (tester) async {
    final saved = ImportController.readFile;
    addTearDown(() => ImportController.readFile = saved);
    ImportController.readFile = (p) async {
      if (p.contains('missing')) {
        throw const FileSystemException('not found', 'missing.csv');
      }
      return Uint8List.fromList(utf8.encode('نام\nعلی رضایی\n'));
    };
    await openFollowup(tester);
    await tapKey(tester, 'fu-import');
    await tapKey(tester, 'imp-grade-هفتم');
    await typeKey(tester, 'imp-path', '/data/missing.csv');
    await tapKey(tester, 'imp-next');
    expect(textOf(tester, 'imp-form-error'), startsWith('فایل خوانده نشد'));
    await typeKey(tester, 'imp-path', r'C:\school\list.csv');
    await tapKey(tester, 'imp-next');
    expect(find.textContaining('«list.csv»'), findsOneWidget);
    await tapKey(tester, 'imp-prev');
    expect(find.byKey(const Key('imp-path')), findsOneWidget);
    await tapKey(tester, 'imp-next');
    await tapKey(tester, 'imp-check');
    expect(textOf(tester, 'imp-newclasses'), contains('هفتم'));
    await tapKey(tester, 'imp-prev');
    expect(find.byKey(const Key('imp-check')), findsOneWidget);
  });

  testWidgets('W10-W08 imp-branch-no: a look-alike branch stays separate and is added to the '
      'list on «ثبت»; NEG nothing is merged by itself', (tester) async {
    final s = await openFollowup(tester);
    await tapKey(tester, 'fu-import');
    await tapKey(tester, 'imp-grade-دهم');
    await typeKey(
      tester,
      'imp-paste',
      'نام و نام خانوادگی,کد ملی,رشته\nسارا نوری,0023456789,الکترونیگ\n',
    );
    await tapKey(tester, 'imp-next');
    await tapKey(tester, 'imp-check');
    expect(badgeOf(tester, 'imp-stat-ready'), 'آمادهٔ ثبت: ۱');
    expect(find.byKey(const Key('imp-ask')), findsOneWidget);
    await tapKey(tester, 'imp-ask-no-0');
    expect(find.byKey(const Key('imp-ask')), findsNothing);
    expect(find.byKey(const Key('imp-fixes')), findsNothing);
    expect(
      find.textContaining('رشتهٔ «الکترونیگ» به فهرست رشته‌ها اضافه می‌شود'),
      findsOneWidget,
    );
    await tapKey(tester, 'imp-apply');
    final ops = s.outbox.list();
    expect(
      ops.any(
        (o) => o.collection == 'lookups' && o.payload!['name'] == 'الکترونیگ',
      ),
      isTrue,
    );
    final sara = ops.firstWhere((o) => o.payload?['name'] == 'سارا نوری');
    expect(sara.payload!['class_id'], isNot(5));
  });
}
