// Row 202 — the owner's four asks:
//   1. «اصلاح» of a follow-up row opens the full student form with the file's values and the
//      wrong boxes framed in red (also for rows saved before 0.9.71 — from their reasons);
//   2–3. a file without titles is mapped from its values (رشته / سرپرست / محل سکونت …) and the
//      guessed columns are marked «🤖 از روی محتوا»;
//   4. «ثبت نهایی» shows a progress window and closes on the result.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'nav_support.dart';
import 'school_support.dart';

String nid(int n) {
  final d = n.toString().padLeft(9, '0').split('').map(int.parse).toList();
  var s = 0;
  for (var i = 0; i < 9; i++) {
    s += d[i] * (10 - i);
  }
  final r = s % 11;
  return '${d.join()}${r < 2 ? r : 11 - r}';
}

Future<void> seed(MemorySchool s) async {
  await s.put('schools', 1, {'name': 'هنرستان'});
  await s.put('lookups', 1, {'kind': 'grade', 'name': 'دهم'});
  await s.put('lookups', 2, {'kind': 'branch', 'name': 'معماری'});
  await s.put('users', 10, {'name': 'مدیر', 'role': 'manager'});
  // 0.9.71 row: the wrong field and the file's own values are kept
  await s.put('import_issues', 80, {
    'name': 'آرسین مولایی',
    'national_id': '3840517575',
    'phone': '09044490545',
    'reasons': [
      'کد ملی مادر «38409918467» معتبر نیست — باید دقیقاً ۱۰ رقم باشد (این مقدار ۱۱ رقم است)؛ همین‌جا اصلاحش کنید.',
    ],
    'fields': {'mother_nid': 'کد ملی مادر «38409918467» معتبر نیست'},
    'raw': {
      'full_name': 'آرسین مولایی',
      'mother_nid': '38409918467',
      'mother_name': 'زهرا',
      'residence': 'روستا',
    },
    'data': {
      'full_name': 'آرسین مولایی',
      'national_id': '3840517575',
      'phone': '09044490545',
      'grade': 'دهم',
      'field': 'معماری',
      'role': 'student',
    },
    'status': 'open',
  });
  // a row saved before 0.9.71: only its sentences
  await s.put('import_issues', 81, {
    'name': 'آتیلا خدری',
    'national_id': '3840544971',
    'reasons': ['موبایل پدر «91234» خوانده نشد — باید ۱۱ رقم و با ۰۹ شروع شود'],
    'data': {
      'full_name': 'آتیلا خدری',
      'national_id': '3840544971',
      'role': 'student',
    },
    'status': 'open',
  });
}

Future<MemorySchool> openFollowup(WidgetTester tester) async {
  tallView(tester);
  final (_, s) = await bootSchool(tester, role: 'manager', seed: seed);
  await openPage(tester, 'followup');
  return s;
}

TextField box(WidgetTester tester, String key) =>
    tester.widget<TextField>(find.byKey(Key(key)));

/// [box] after scrolling it into view (the form list builds lazily).
Future<TextField> boxAt(WidgetTester tester, String key) async {
  final f = find.byKey(Key(key));
  if (f.evaluate().isEmpty) {
    // above what is on screen: scroll back up (reveal only goes down)
    final list = find
        .descendant(
          of: find.byType(ListView).last,
          matching: find.byType(Scrollable),
        )
        .first;
    await tester.scrollUntilVisible(f, -200, scrollable: list);
  }
  await reveal(tester, key);
  return box(tester, key);
}

void main() {
  testWidgets(
    'R202-01 «اصلاح»: every student field, the file value and a red frame on '
    'the wrong one; typing clears it; saving closes the row',
    (tester) async {
      final s = await openFollowup(tester);
      await tapKey(tester, 'fu-issue-fix-80');
      expect(find.byKey(const Key('usr-f-notes')), findsOneWidget);
      expect(
        (await boxAt(tester, 'usr-f-name')).controller!.text,
        'آرسین مولایی',
      );
      await reveal(tester, 'usr-f-mother_nid');
      final m = box(tester, 'usr-f-mother_nid');
      expect(m.controller!.text, '38409918467');
      expect(m.decoration!.errorText, contains('کد ملی مادر'));
      expect(
        (await boxAt(tester, 'usr-f-mother_name')).controller!.text,
        'زهرا',
      );
      expect(
        (await boxAt(tester, 'usr-f-mother_name')).decoration!.errorText,
        isNull,
      );
      // the fields a school file brings are all in the form
      for (final k in [
        'usr-f-mother_alive',
        'usr-f-guardian_alive',
        'usr-f-village',
        'usr-f-residence_status',
      ]) {
        await reveal(tester, k);
        expect(find.byKey(Key(k)), findsOneWidget, reason: k);
      }
      expect(
        (await boxAt(tester, 'usr-f-residence')).controller!.text,
        'روستا',
      );
      await boxAt(tester, 'usr-f-mother_nid');
      await typeKey(tester, 'usr-f-mother_nid', nid(4321));
      expect(
        (await boxAt(tester, 'usr-f-mother_nid')).decoration!.errorText,
        isNull,
      );
      await tapKey(tester, 'usr-save');
      expect(find.byKey(const Key('usr-save')), findsNothing);
      final stu = s.outbox.list().firstWhere(
        (o) => o.payload?['name'] == 'آرسین مولایی',
      );
      expect(stu.payload!['mother_nid'], nid(4321));
      expect(stu.payload!['residence'], 'روستا');
      expect(find.byKey(const Key('fu-issue-80')), findsNothing);
    },
  );

  testWidgets(
    'R202-02 an old row: the wrong field comes from its reason, with the '
    'quoted value',
    (tester) async {
      await openFollowup(tester);
      await reveal(tester, 'fu-issue-fix-81');
      await tapKey(tester, 'fu-issue-fix-81');
      await reveal(tester, 'usr-f-father_phone');
      final f = box(tester, 'usr-f-father_phone');
      expect(f.controller!.text, '91234');
      expect(f.decoration!.errorText, contains('موبایل پدر'));
      expect((await boxAt(tester, 'usr-f-nid')).decoration!.errorText, isNull);
    },
  );

  testWidgets('R202-03 a file without titles: columns found from values (🤖), then «ثبت» '
      'with the progress window', (tester) async {
    final s = await openFollowup(tester);
    await tapKey(tester, 'fu-import');
    await tapKey(tester, 'imp-grade-دهم');
    final rows = [
      for (final (i, n) in ['سینا کاظمی', 'سارا نوری', 'رضا امینی'].indexed)
        '$n,${nid(700 + i)},${['گرافیک', 'معماری', 'معماری'][i]},'
            '${['والدین', 'فقط پدر', 'والدین'][i]},${['شهر', 'روستا', 'شهر'][i]}',
    ];
    await typeKey(tester, 'imp-paste', '${rows.join('\n')}\n');
    await tapKey(tester, 'imp-next');
    expect(badgeOf(tester, 'imp-mapped'), '۵ ستون نگاشت شد');
    expect(find.byKey(const Key('imp-auto-note')), findsOneWidget);
    for (var i = 0; i < 5; i++) {
      expect(find.byKey(Key('imp-auto-$i')), findsOneWidget);
    }
    await tapKey(tester, 'imp-check');
    // «گرافیک» is new to the school: asked, never added silently (row 201)
    while (find.byKey(const Key('imp-ask')).evaluate().isNotEmpty) {
      if (find.byKey(const Key('imp-new-all')).evaluate().isNotEmpty) {
        await tapKey(tester, 'imp-new-all');
      } else if (find.byKey(const Key('imp-new-add-0')).evaluate().isNotEmpty) {
        await tapKey(tester, 'imp-new-add-0');
      } else {
        await tapKey(tester, 'imp-ask-no-0');
      }
    }
    await tapKey(tester, 'imp-apply');
    expect(find.byKey(const Key('imp-progress')), findsNothing);
    expect(textOf(tester, 'imp-result'), contains('۳ کاربر ثبت شد'));
    final sara = s.outbox.list().firstWhere(
      (o) => o.payload?['name'] == 'سارا نوری',
    );
    expect(sara.payload!['guardian'], 'فقط پدر');
    expect(sara.payload!['residence'], 'روستا');
    expect(sara.payload!['field'], 'معماری');
  });

  testWidgets(
    'R202-04 «ثبت» of a long file: the progress window shows n of m while the '
    'rows are saved, then closes on the result',
    (tester) async {
      final s = await openFollowup(tester);
      await tapKey(tester, 'fu-import');
      await tapKey(tester, 'imp-grade-دهم');
      final b = StringBuffer('نام و نام خانوادگی,کد ملی,رشته\n');
      for (var i = 0; i < 150; i++) {
        b.writeln('دانش آموز ${i + 1},${nid(9000 + i)},معماری');
      }
      await typeKey(tester, 'imp-paste', b.toString());
      await tapKey(tester, 'imp-next');
      await tapKey(tester, 'imp-check');
      expect(textOf(tester, 'imp-stat-ready'), '۱۵۰');
      await reveal(tester, 'imp-apply');
      await tester.tap(find.byKey(const Key('imp-apply')));
      await tester.pump();
      expect(find.byKey(const Key('imp-progress')), findsOneWidget);
      expect(textOf(tester, 'imp-progress-text'), contains(' از '));
      await settle(tester);
      expect(find.byKey(const Key('imp-progress')), findsNothing);
      expect(textOf(tester, 'imp-result'), contains('۱۵۰ کاربر ثبت شد'));
      expect(s.outbox.list().where((o) => o.collection == 'users').length, 150);
    },
  );
}
