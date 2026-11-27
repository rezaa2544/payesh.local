// Row 203 — the owner's four asks:
//   1. a follow-up «اصلاح» keeps what was fixed as it is typed (two of three fields fixed ⇒
//      those two are saved); only «ذخیره» closes the row;
//   2. «ثبت موقت در لیست»: the student is in the users / class list now and the row stays to
//      be completed;
//   3. «مشخصات کامل»: «نام» without the last name (not «آرتین رحمانی» + «رحمانی»);
//   4. «مشخصات کامل» holds every field (پایه، رشته، … and any other column of the file).
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
  await s.put('classes', 5, {
    'name': 'دهم معماری',
    'grade': 'دهم',
    'branch': 'معماری',
  });
  await s.put('users', 10, {'name': 'مدیر', 'role': 'manager'});
  await s.put('users', 21, {
    'name': 'آرتین رحمانی',
    'first_name': 'آرتین',
    'last_name': 'رحمانی',
    'role': 'student',
    'grade': 'یازدهم',
    'field': 'معماری',
    'father_edu': 'دیپلم',
    'mother_alive': 'در قید حیات',
    'x_hobby': 'فوتبال',
  });
  // two wrong fields: the mother's and the father's national id
  await s.put('import_issues', 80, {
    'name': 'آرسین مولایی',
    'national_id': '3840517575',
    'reasons': [
      'کد ملی مادر «38409918467» معتبر نیست — باید دقیقاً ۱۰ رقم باشد',
      'کد ملی پدر «28409918467» معتبر نیست — باید دقیقاً ۱۰ رقم باشد',
    ],
    'fields': {
      'mother_nid':
          'کد ملی مادر «38409918467» معتبر نیست — باید دقیقاً ۱۰ رقم باشد',
      'father_nid':
          'کد ملی پدر «28409918467» معتبر نیست — باید دقیقاً ۱۰ رقم باشد',
    },
    'raw': {
      'full_name': 'آرسین مولایی',
      'mother_nid': '38409918467',
      'father_nid': '28409918467',
    },
    'data': {
      'full_name': 'آرسین مولایی',
      'national_id': '3840517575',
      'grade': 'دهم',
      'field': 'معماری',
      'class_name': 'دهم معماری',
      'role': 'student',
    },
    'status': 'open',
  });
}

Future<MemorySchool> boot(WidgetTester tester, String page) async {
  tallView(tester);
  final (_, s) = await bootSchool(tester, role: 'manager', seed: seed);
  await openPage(tester, page);
  return s;
}

TextField box(WidgetTester tester, String key) =>
    tester.widget<TextField>(find.byKey(Key(key)));

/// Scrolls [key] into view, up or down (the form list builds lazily).
Future<void> at(WidgetTester tester, String key) async {
  final f = find.byKey(Key(key));
  if (f.evaluate().isEmpty) {
    final list = find
        .descendant(
          of: find.byType(ListView).last,
          matching: find.byType(Scrollable),
        )
        .first;
    await tester.scrollUntilVisible(f, -200, scrollable: list);
  }
  await reveal(tester, key);
}

/// Lets the form's auto-save run (it waits a moment after the last key).
Future<void> autosave(WidgetTester tester) async {
  await tester.pump(const Duration(seconds: 1));
  await settle(tester);
}

void main() {
  testWidgets(
    'R203-01 a fix is kept as it is typed; the row stays until «ذخیره»',
    (tester) async {
      final s = await boot(tester, 'followup');
      await tapKey(tester, 'fu-issue-fix-80');
      // one of the two wrong fields is fixed, then the form is closed without «ذخیره»
      await typeKey(tester, 'usr-f-mother_nid', nid(4321));
      await autosave(tester);
      expect(find.byKey(const Key('usr-f-draft-saved')), findsOneWidget);
      final row = await tester.runAsync(
        () => s.engine.get('import_issues', 80),
      );
      expect((row!.data['draft'] as Map)['mother_nid'], nid(4321));
      expect((row.data['fields'] as Map).keys, ['father_nid']);
      await tapKey(tester, 'usr-form-back');
      expect(find.byKey(const Key('fu-issue-80')), findsOneWidget);
      expect(textOf(tester, 'fu-issue-draft-80'), contains('ذخیره شده'));
      // open again: the fix is there, only the father's id is still red
      await tapKey(tester, 'fu-issue-fix-80');
      await reveal(tester, 'usr-f-mother_nid');
      final m = box(tester, 'usr-f-mother_nid');
      expect(m.controller!.text, nid(4321));
      expect(m.decoration!.errorText, isNull);
      await at(tester, 'usr-f-father_nid');
      expect(box(tester, 'usr-f-father_nid').decoration!.errorText, isNotNull);
      // a change typed just before closing is not lost either
      await typeKey(tester, 'usr-f-father_nid', nid(4322));
      await tapKey(tester, 'usr-form-back');
      await settle(tester);
      final again = await tester.runAsync(
        () => s.engine.get('import_issues', 80),
      );
      expect((again!.data['draft'] as Map)['father_nid'], nid(4322));
      // the final save closes the row
      await tapKey(tester, 'fu-issue-fix-80');
      await tapKey(tester, 'usr-save');
      expect(find.byKey(const Key('fu-issue-80')), findsNothing);
      final stu = s.outbox.list().lastWhere(
        (o) => o.collection == 'users' && o.payload?['name'] == 'آرسین مولایی',
      );
      expect(stu.payload!['mother_nid'], nid(4321));
      expect(stu.payload!['father_nid'], nid(4322));
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'R203-02 «ثبت موقت در لیست»: in the class now, still on the follow-up list',
    (tester) async {
      final s = await boot(tester, 'followup');
      await tapKey(tester, 'fu-issue-fix-80');
      await tapKey(tester, 'usr-f-temp');
      expect(find.byKey(const Key('usr-f-temp')), findsNothing);
      expect(find.byKey(const Key('fu-issue-80')), findsOneWidget);
      expect(find.byKey(const Key('fu-issue-temp-80')), findsOneWidget);
      final made = s.outbox.list().firstWhere(
        (o) => o.payload?['name'] == 'آرسین مولایی' && o.collection == 'users',
      );
      // the wrong ids are left out, the class the file named is taken
      expect(made.payload!['class_id'], 5);
      expect('${made.payload!['mother_nid'] ?? ''}', '');
      // «اصلاح» now edits that user; the final save closes the row
      await tapKey(tester, 'fu-issue-fix-80');
      await typeKey(tester, 'usr-f-mother_nid', nid(4321));
      await at(tester, 'usr-f-father_nid');
      await typeKey(tester, 'usr-f-father_nid', nid(4322));
      await tapKey(tester, 'usr-save');
      expect(find.byKey(const Key('fu-issue-80')), findsNothing);
      final users = s.outbox
          .list()
          .where((o) => o.collection == 'users')
          .map((o) => o.id)
          .toSet();
      expect(users, hasLength(1));
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'R203-03 «مشخصات کامل»: «نام» without the last name; پایه، رشته and every '
    'other field; the name is made of both',
    (tester) async {
      final s = await boot(tester, 'users');
      await tapKey(tester, 'usr-full-21');
      expect(box(tester, 'usr-p-name').controller!.text, 'آرتین');
      expect(box(tester, 'usr-p-last_name').controller!.text, 'رحمانی');
      String pick(String k) =>
          tester
              .widget<DropdownButtonFormField<String>>(find.byKey(Key(k)))
              .initialValue ??
          '';
      expect(pick('usr-p-grade'), 'یازدهم');
      expect(pick('usr-p-field'), 'معماری');
      await reveal(tester, 'usr-p-father_edu');
      expect(box(tester, 'usr-p-father_edu').controller!.text, 'دیپلم');
      await reveal(tester, 'usr-p-mother_alive');
      expect(box(tester, 'usr-p-mother_alive').controller!.text, 'در قید حیات');
      // a column of the file no form names is shown too
      await reveal(tester, 'usr-p-x_hobby');
      expect(box(tester, 'usr-p-x_hobby').controller!.text, 'فوتبال');
      await typeKey(tester, 'usr-p-last_name', 'رحمانی‌پور');
      await tapKey(tester, 'usr-save');
      final row = await tester.runAsync(() => s.engine.get('users', 21));
      expect(row!.data['name'], 'آرتین رحمانی‌پور');
      expect(row.data['last_name'], 'رحمانی‌پور');
      expect(row.data['grade'], 'یازدهم');
      expect(tester.takeException(), isNull);
    },
  );
}
