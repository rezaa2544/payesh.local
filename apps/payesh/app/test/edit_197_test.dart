// ردیف ۱۹۷ — Q01 (F45/F46/F47): «ویرایش» هر نقش همان فهرست کامل «کاربر جدید» است، با مقدار
// فعلی همان کاربر: کارمند → سمت و تیک‌های سطح دسترسی؛ دبیر → درس‌ها با پایه/رشته؛ دانش‌آموز →
// پایه/رشته/کلاس؛ ولی → نسبت (در پیوند فرزند هم) و وصل کردن فرزند دیگر. نقش‌های اصلی جابه‌جا
// نمی‌شوند و آخرین مدیر سمتش عوض نمی‌شود. روی گوشی دکمه‌های ردیف جدول روی هم نمی‌افتند.
// پوستهٔ واقعی برنامه، صفحه‌ها، کنترلرها و UserDirectory واقعی روی SQLite حافظه‌ای.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_sync/payesh_sync.dart';

import 'accounts_wave7_test.dart' show serverCreds;
import 'nav_support.dart';
import 'school_support.dart';

Future<void> seed(MemorySchool s) async {
  await s.put('lookups', 1, {'kind': 'grade', 'name': 'دهم'});
  await s.put('lookups', 2, {'kind': 'grade', 'name': 'یازدهم'});
  await s.put('lookups', 3, {'kind': 'branch', 'name': 'الکترونیک'});
  await s.put('classes', 5, {
    'name': 'دهم الف',
    'grade': 'دهم',
    'branch': 'الکترونیک',
  });
  await s.put('classes', 6, {'name': 'یازدهم ب', 'grade': 'یازدهم'});
  await s.put('subjects', 41, {'name': 'ریاضی'});
  await s.put('subjects', 42, {'name': 'فیزیک'});
  await s.put('users', 10, {
    'name': 'مدیر',
    'role': 'manager',
    'phone': '09120000010',
  });
  await s.put('users', 30, {
    'name': 'کارمند آزمون',
    'role': 'staff',
    'phone': '09120000030',
    'national_id': '1970000066',
    'position': 'دفتردار',
    'access': ['notices'],
  });
  await s.put('users', 31, {
    'name': 'دبیر آزمون',
    'role': 'teacher',
    'phone': '09120000031',
    'teaches': [
      {'subject_id': 41, 'subject': 'ریاضی', 'grade': 'دهم'},
    ],
    'subject': 'ریاضی',
  });
  await s.put('users', 21, {
    'name': 'بهار سعیدی',
    'role': 'student',
    'class_id': 5,
    'grade': 'دهم',
    'field': 'الکترونیک',
    'father_name': 'رضا',
  });
  await s.put('users', 22, {
    'name': 'آرش',
    'role': 'student',
    'class_id': 6,
    'grade': 'یازدهم',
  });
  await s.put('users', 40, {
    'name': 'مریم',
    'role': 'parent',
    'phone': '09120000040',
    'relation': 'سرپرست',
  });
  await s.put('parent_links', 700, {
    'parent_id': 40,
    'student_id': 21,
    'relation': 'guardian',
  });
}

Future<MemorySchool> openEdit(WidgetTester tester, int id) async {
  tallView(tester);
  final (_, s) = await bootSchool(tester, role: 'manager', seed: seed);
  await openPage(tester, 'users');
  await tapKey(tester, 'usr-edit-$id');
  return s;
}

Future<void> pick(WidgetTester tester, String key, String item) async {
  await tapKey(tester, key);
  await tester.tap(find.text(item).last);
  await settle(tester);
}

Map<String, Object?> userOp(MemorySchool s, int id) => s.outbox
    .list()
    .where((o) => o.collection == 'users' && o.id == id)
    .last
    .payload!;

String fieldText(WidgetTester tester, String key) => tester
    .widget<EditableText>(
      find.descendant(
        of: find.byKey(Key(key)),
        matching: find.byType(EditableText),
      ),
    )
    .controller
    .text;

bool ticked(WidgetTester tester, String key) =>
    tester.widget<CheckboxListTile>(find.byKey(Key(key))).value ?? false;

void main() {
  testWidgets(
    'E197-01 کارمند: فرم ویرایش سمت و تیک‌های دسترسی را با مقدار فعلی دارد؛ تیک تازه و '
    'سمت تازه (مشاور) ذخیره می‌شود؛ فیلدهای خانوادهٔ دانش‌آموز در آن نیست',
    (tester) async {
      final s = await openEdit(tester, 30);
      expect(
        tester.widget<Text>(find.byKey(const Key('usr-form-title'))).data,
        'ویرایش — کارمند آزمون',
      );
      expect(find.byKey(const Key('usr-f-kind-student')), findsNothing);
      expect(find.byKey(const Key('usr-f-father_name')), findsNothing);
      expect(find.byKey(const Key('usr-f-last_gpa')), findsNothing);
      expect(fieldText(tester, 'usr-f-position'), 'دفتردار');
      expect(fieldText(tester, 'usr-f-nid'), '1970000066');
      expect(ticked(tester, 'usr-f-access-notices'), isTrue);
      expect(ticked(tester, 'usr-f-access-attendance'), isFalse);
      await tapKey(tester, 'usr-f-access-attendance');
      await pick(tester, 'usr-f-role', 'مشاور');
      await tapKey(tester, 'usr-save');
      final op = userOp(s, 30);
      expect(op['role'], 'counselor');
      expect(op['access'], ['attendance', 'notices']);
      expect(op['position'], 'دفتردار');
      expect(op['phone'], '09120000030');
      expect(find.byKey(const Key('usr-form-title')), findsNothing);
    },
  );

  testWidgets('E197-02 دبیر: درس‌های فعلی در فرم ویرایش هست؛ حذف یکی و افزودن «فیزیک — یازدهم» '
      'هم teaches و هم subject را عوض می‌کند', (tester) async {
    final s = await openEdit(tester, 31);
    expect(find.text('ریاضی — دهم'), findsOneWidget);
    await pick(tester, 'usr-f-teach-subject', 'فیزیک');
    await pick(tester, 'usr-f-teach-grade', 'یازدهم');
    await tapKey(tester, 'usr-f-teach-add');
    expect(find.text('فیزیک — یازدهم'), findsOneWidget);
    // حذف «ریاضی — دهم» (اولین چیپ)
    await tester.tap(
      find.descendant(
        of: find.byKey(const Key('usr-f-teach-0')),
        matching: find.byIcon(Icons.clear),
      ),
    );
    await settle(tester);
    await tapKey(tester, 'usr-save');
    final op = userOp(s, 31);
    expect(op['teaches'], [
      {'subject_id': 42, 'subject': 'فیزیک', 'grade': 'یازدهم'},
    ]);
    expect(op['subject'], 'فیزیک');
    expect(op['role'], 'teacher');
    expect(op.containsKey('access'), isFalse);
  });

  testWidgets(
    'E197-03 دانش‌آموز: پایه/رشته/کلاس فعلی در فرم است؛ بردن به «یازدهم ب» ذخیره می‌شود؛ '
    'تیک «حساب پدر ساخته شود» در ویرایش نیست و نام پدر می‌ماند',
    (tester) async {
      final s = await openEdit(tester, 21);
      expect(find.byKey(const Key('usr-f-make-father')), findsNothing);
      expect(fieldText(tester, 'usr-f-father_name'), 'رضا');
      await pick(tester, 'usr-f-grade', 'یازدهم');
      await pick(tester, 'usr-f-class', 'یازدهم ب');
      await tapKey(tester, 'usr-save');
      final op = userOp(s, 21);
      expect(op['class_id'], 6);
      expect(op['grade'], 'یازدهم');
      expect(op['father_name'], 'رضا');
      // پیوند ولی دست نخورد و حساب تازه‌ای ساخته نشد
      expect(
        s.outbox.list().where((o) => o.collection == 'parent_links'),
        isEmpty,
      );
      expect(
        s.outbox.list().where((o) => o.collection == 'users'),
        hasLength(1),
      );
    },
  );

  testWidgets(
    'E197-04 ولی: نسبت «مادر» در کاربر و در پیوند فرزند ثبت می‌شود و فرزند دوم وصل می‌شود',
    (tester) async {
      final s = await openEdit(tester, 40);
      expect(textOf(tester, 'usr-f-edit-kids'), contains('بهار سعیدی'));
      await pick(tester, 'usr-f-relation', 'مادر');
      await pick(tester, 'usr-f-child', 'آرش');
      await tapKey(tester, 'usr-save');
      expect(userOp(s, 40)['relation'], 'مادر');
      final links = [
        for (final o in s.outbox.list())
          if (o.collection == 'parent_links') o,
      ];
      expect(links, hasLength(2));
      expect(links.first.id, 700);
      expect(links.first.payload!['relation'], 'mother');
      expect(links.last.payload!['student_id'], 22);
      expect(links.last.payload!['parent_id'], 40);
      expect(links.last.payload!['relation'], 'mother');
    },
  );

  testWidgets(
    'E197-05 (NEG) کد ملی تکراری رد می‌شود و هیچ چیز در صف نمی‌رود؛ غیرفعال کردن کار می‌کند',
    (tester) async {
      final s = await openEdit(tester, 31);
      await typeKey(tester, 'usr-f-nid', '1970000066');
      await tapKey(tester, 'usr-save');
      expect(textOf(tester, 'usr-form-error'), contains('کارمند آزمون'));
      expect(s.outbox.list(), isEmpty);
      await typeKey(tester, 'usr-f-nid', '');
      await tapKey(tester, 'usr-e-active');
      await tapKey(tester, 'usr-save');
      expect(userOp(s, 31)['active'], false);
    },
  );

  testWidgets(
    'E197-06 گوشی (۴۱۱×۹۱۴): دکمه‌های ردیف کاربر روی هم نمی‌افتند و هر لمس همان کار را باز می‌کند',
    (tester) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 1080 / 411;
      addTearDown(tester.view.reset);
      final src = MemorySchool()..accounts = serverCreds();
      await bootSchool(tester, role: 'manager', seed: seed, source: src);
      await openPage(tester, 'users');
      for (final id in [30, 31, 21, 40]) {
        final keys = [
          'usr-full-$id',
          'usr-creds-$id',
          'usr-pair-$id',
          'usr-edit-$id',
          'usr-delete-$id',
        ].where((k) => find.byKey(Key(k)).evaluate().isNotEmpty).toList();
        expect(keys.length, greaterThanOrEqualTo(4), reason: 'ردیف $id');
        final rects = [
          for (final k in keys) tester.getRect(find.byKey(Key(k))),
        ];
        // پیش از ۱۹۷: ستون ۱۲۰ نقطه‌ای، پنج ردیف دکمه و «مشخصات کامل» دوخطی (۵۵ نقطه)
        final tops = {for (final r in rects) r.top.round()};
        expect(tops.length, lessThanOrEqualTo(3), reason: 'ردیف $id: $rects');
        final block = rects.reduce((a, b) => a.expandToInclude(b));
        expect(block.height, lessThan(130), reason: 'ردیف $id: $block');
        expect(
          block.width,
          greaterThan(250),
          reason: 'پهنای کامل ردیف: $block',
        );
        for (var i = 0; i < rects.length; i++) {
          expect(rects[i].width, greaterThan(40), reason: keys[i]);
          expect(rects[i].height, inInclusiveRange(34, 44), reason: keys[i]);
          for (var j = i + 1; j < rects.length; j++) {
            final o = rects[i].intersect(rects[j]);
            expect(
              o.width > 0.5 && o.height > 0.5,
              isFalse,
              reason:
                  '${keys[i]} روی ${keys[j]} افتاده: ${rects[i]} / ${rects[j]}',
            );
          }
          // دکمه کامل در صفحه است (بیرون از لبه نیست)
          expect(rects[i].left, greaterThanOrEqualTo(0), reason: keys[i]);
          expect(rects[i].right, lessThanOrEqualTo(411.5), reason: keys[i]);
        }
      }
      // لمس «کاربری» فرم کاربری را باز می‌کند، نه ویرایش (F46)
      await tester.ensureVisible(find.byKey(const Key('usr-creds-30')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('usr-creds-30')));
      await settleAsync(tester);
      expect(find.text('ویرایش — کارمند آزمون'), findsNothing);
    },
  );

  group('E197-07 لایهٔ داده (NEG)', () {
    Future<UserDirectory> dir(MemorySchool s) async {
      await seed(s);
      final db = (await s.recordsFor(role: 'manager', uid: 10))!;
      return UserDirectory(db);
    }

    testWidgets('دانش‌آموز را نمی‌شود دبیر کرد', (tester) async {
      await tester.runAsync(() async {
        final d = await dir(MemorySchool());
        await expectLater(
          d.update(21, const UserDraft(name: 'بهار سعیدی', role: 'teacher')),
          throwsA(
            isA<RecordFailure>().having(
              (e) => e.messageFa,
              'message',
              contains('کاربر تازه'),
            ),
          ),
        );
      });
    });

    testWidgets('تنها مدیر مدرسه را نمی‌شود به معاون برد', (tester) async {
      await tester.runAsync(() async {
        final d = await dir(MemorySchool());
        await expectLater(
          d.update(10, const UserDraft(name: 'مدیر', role: 'vice')),
          throwsA(
            isA<RecordFailure>().having(
              (e) => e.messageFa,
              'message',
              contains('تنها مدیر'),
            ),
          ),
        );
      });
    });

    testWidgets('بی‌تغییر = «تغییری نبود» و صف خالی', (tester) async {
      await tester.runAsync(() async {
        final s = MemorySchool();
        final d = await dir(s);
        final r = await d.update(
          22,
          const UserDraft(
            name: 'آرش',
            role: 'student',
            classId: 6,
            grade: 'یازدهم',
          ),
        );
        expect(r.messageFa, 'تغییری نبود');
        expect(s.outbox.list(), isEmpty);
      });
    });
  });
}
