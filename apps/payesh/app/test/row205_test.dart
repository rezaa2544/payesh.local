// Row 205 — the owner's asks on «نیازمند پیگیری» (field school «کاردانش آینده سازان»):
//   1. a student given پایه + رشته («ذخیره») never comes back to «دانش‌آموزانی که پایه/رشته‌شان
//      کامل نیست»: the stored reason is emptied (not dropped — the LAN server merges, so a
//      dropped key came back on the next pull) and an old stale reason no longer keeps him;
//      a field school's reason never says «کلاس»;
//   2. «📋 ثبت موقت در لیست» right on each import row, and ticks / «انتخاب همه» to
//      temp-register many rows at once.
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

Map<String, Object?> issue(String name, int code, {String bad = ''}) => {
  'name': name,
  'national_id': nid(code),
  'reasons': [
    if (bad.isNotEmpty)
      'کد ملی پدر «$bad» معتبر نیست — باید دقیقاً ۱۰ رقم باشد',
  ],
  'fields': {
    if (bad.isNotEmpty)
      'father_nid': 'کد ملی پدر «$bad» معتبر نیست — باید دقیقاً ۱۰ رقم باشد',
  },
  'raw': {'full_name': name, if (bad.isNotEmpty) 'father_nid': bad},
  'data': {
    'full_name': name,
    'national_id': nid(code),
    'grade': 'دهم',
    'field': 'معماری',
    'father_name': 'پدر $name',
    'role': 'student',
  },
  'status': 'open',
};

Future<void> seed(MemorySchool s) async {
  await s.put('schools', 1, {
    'name': 'کاردانش آینده سازان',
    'level': 'متوسطه دوم',
  });
  await s.put('lookups', 1, {'kind': 'grade', 'name': 'دهم'});
  await s.put('lookups', 2, {'kind': 'grade', 'name': 'دوازدهم'});
  await s.put('lookups', 3, {'kind': 'branch', 'name': 'معماری'});
  await s.put('lookups', 4, {'kind': 'branch', 'name': 'الکتروتکنیک'});
  await s.put('users', 10, {'name': 'مدیر', 'role': 'manager'});
  // the screenshot's student: his field «حسابداری» was deleted (an older web panel wrote
  // «کلاس تازه انتخاب کنید» even in a field school)
  await s.put('users', 30, {
    'name': 'کاندیش احمدی',
    'role': 'student',
    'grade': 'دوازدهم',
    'field': 'حسابداری',
    'followup_reason': 'رشتهٔ «حسابداری» حذف شد — کلاس تازه انتخاب کنید',
  });
  // saved by an older app: grade + field are right, the stale reason stayed on the server
  await s.put('users', 31, {
    'name': 'برگشتی قدیمی',
    'role': 'student',
    'grade': 'دوازدهم',
    'field': 'الکتروتکنیک',
    'followup_reason': 'رشتهٔ «حسابداری» حذف شد — کلاس تازه انتخاب کنید',
  });
  // a reason of its own (not about the place) still stays
  await s.put('users', 32, {
    'name': 'همراه تکراری',
    'role': 'student',
    'grade': 'دهم',
    'field': 'معماری',
    'followup_reason': 'شمارهٔ همراه تکراری بود — با کد ملی وارد می‌شود',
  });
  await s.put(
    'import_issues',
    80,
    issue('آرسین مولایی', 4101, bad: '28409918467'),
  );
  await s.put('import_issues', 81, issue('بردیا کریمی', 4102));
  await s.put('import_issues', 82, issue('پارسا نادری', 4103));
}

Future<void> choose(WidgetTester tester, String dropdown, String text) async {
  await tapKey(tester, dropdown);
  await tester.tap(find.text(text).last);
  await settle(tester);
}

Future<MemorySchool> boot(WidgetTester tester) async {
  tallView(tester);
  final (_, s) = await bootSchool(tester, role: 'manager', seed: seed);
  await openPage(tester, 'followup');
  return s;
}

void main() {
  testWidgets('R205-01 «ذخیره» پایه و رشته: the reason is emptied on the row sent, the student '
      'leaves the list for good; a stale reason does not keep a complete student; '
      'no «کلاس» in a field school', (tester) async {
    final s = await boot(tester);
    // 31 (complete, stale reason) is not listed; 32 (own reason) is
    expect(find.byKey(const Key('fu-stud-31')), findsNothing);
    expect(find.byKey(const Key('fu-stud-32')), findsOneWidget);
    expect(find.byKey(const Key('fu-stud-30')), findsOneWidget);
    final why = textOf(tester, 'fu-reason-30');
    expect(why, contains('حسابداری'));
    expect(why, isNot(contains('کلاس')));
    expect(why, contains('پایه و رشته'));
    // the grade opens chosen from what he has
    await choose(tester, 'fu-branch-30', 'الکتروتکنیک');
    await tapKey(tester, 'fu-assign-30');
    expect(find.byKey(const Key('fu-stud-30')), findsNothing);
    final sent = s.outbox.list().lastWhere(
      (o) => o.collection == 'users' && o.id == 30,
    );
    // explicit '' — a dropped key was kept by the server's merge and came back on pull
    expect(sent.payload!.containsKey('followup_reason'), isTrue);
    expect(sent.payload!['followup_reason'], '');
    expect(sent.payload!['grade'], 'دوازدهم');
    expect(sent.payload!['field'], 'الکتروتکنیک');
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'R205-02 «📋 ثبت موقت در لیست» on the row itself: in the users list now, the row '
    'stays marked «ثبت موقت»; the wrong father id is left out',
    (tester) async {
      final s = await boot(tester);
      await reveal(tester, 'fu-issue-temp-btn-80');
      await tapKey(tester, 'fu-issue-temp-btn-80');
      expect(find.byKey(const Key('fu-issue-80')), findsOneWidget);
      expect(find.byKey(const Key('fu-issue-temp-80')), findsOneWidget);
      expect(find.byKey(const Key('fu-issue-temp-btn-80')), findsNothing);
      expect(find.byKey(const Key('fu-issue-pick-80')), findsNothing);
      final made = s.outbox.list().firstWhere(
        (o) => o.collection == 'users' && o.payload?['name'] == 'آرسین مولایی',
      );
      expect(made.payload!['grade'], 'دهم');
      expect(made.payload!['field'], 'معماری');
      expect('${made.payload!['father_nid'] ?? ''}', '');
      final row = await tester.runAsync(
        () => s.engine.get('import_issues', 80),
      );
      expect(row!.data['temp_user_id'], made.id);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'R205-03 «انتخاب همه» + «ثبت موقت انتخاب‌شده‌ها»: every open row at once, each once',
    (tester) async {
      final s = await boot(tester);
      await reveal(tester, 'fu-issues-all');
      await tapKey(tester, 'fu-issues-all');
      expect(
        find.descendant(
          of: find.byKey(const Key('fu-issues-temp')),
          matching: find.textContaining('(۳)'),
        ),
        findsOneWidget,
      );
      await tapKey(tester, 'fu-issues-temp');
      // asks first (many rows)
      await tapKey(tester, 'fu-temp-confirm-ok');
      for (final id in [80, 81, 82]) {
        expect(find.byKey(Key('fu-issue-temp-$id')), findsOneWidget);
      }
      expect(find.byKey(const Key('fu-issues-all')), findsNothing);
      final names = s.outbox
          .list()
          .where(
            (o) => o.collection == 'users' && o.payload?['role'] == 'student',
          )
          .map((o) => o.payload!['name'])
          .toList();
      expect(
        names,
        containsAll(['آرسین مولایی', 'بردیا کریمی', 'پارسا نادری']),
      );
      expect(names.toSet().length, names.length);
      // ticks one by one too
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'R205-04 a single tick enables the bulk button for that row only',
    (tester) async {
      final s = await boot(tester);
      await reveal(tester, 'fu-issue-pick-81');
      await tapKey(tester, 'fu-issue-pick-81');
      expect(
        find.descendant(
          of: find.byKey(const Key('fu-issues-temp')),
          matching: find.textContaining('(۱)'),
        ),
        findsOneWidget,
      );
      await tapKey(tester, 'fu-issues-temp');
      expect(find.byKey(const Key('fu-issue-temp-81')), findsOneWidget);
      expect(find.byKey(const Key('fu-issue-temp-80')), findsNothing);
      expect(find.byKey(const Key('fu-issue-temp-82')), findsNothing);
      final made = s.outbox
          .list()
          .where(
            (o) => o.collection == 'users' && o.payload?['role'] == 'student',
          )
          .map((o) => o.payload!['name'])
          .toList();
      expect(made, ['بردیا کریمی']);
      expect(tester.takeException(), isNull);
    },
  );
}
