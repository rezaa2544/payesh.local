// Row 128, wave W9 — the weekly schedule. Widget tests drive the REAL app shell, page,
// controller and Timetable on an in-memory SQLite + durable outbox; the real server path is
// packages/payesh_sync/test/school_admin_it_test.dart W9-IT-*.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'school_support.dart';

// harness "today" is Thursday 2026-11-12; the slot 900 is on Saturday (0).
final satJ = JalaliDate.fromIso('2026-11-14')!.slash;
final monJ = JalaliDate.fromIso('2026-11-16')!.slash;

Future<void> seed(MemorySchool s) async {
  await s.put('schools', 1, {
    'name': 'هنرستان',
    'workdays': [0, 1, 2, 3, 4],
  });
  await s.put('lookups', 1, {'kind': 'grade', 'name': 'دهم'});
  await s.put('lookups', 2, {'kind': 'branch', 'name': 'الکترونیک'});
  await s.put('lookups', 3, {'kind': 'grade', 'name': 'هفتم'});
  await s.put('classes', 5, {
    'name': 'دهم الکترونیک',
    'grade': 'دهم',
    'branch': 'الکترونیک',
    'kind': 'class',
    'teacher_id': 10,
  });
  await s.put('classes', 6, {'name': 'کارگاه ۱', 'kind': 'room'});
  await s.put('subjects', 41, {'name': 'ریاضی', 'weekly_hours': 2});
  await s.put('subjects', 42, {'name': 'فیزیک', 'weekly_hours': 1});
  await s.put('users', 10, {
    'name': 'دبیر ریاضی',
    'role': 'teacher',
    'subject': 'ریاضی',
  });
  await s.put('users', 11, {
    'name': 'دبیر فیزیک',
    'role': 'teacher',
    'subject': 'فیزیک',
  });
  await s.put('users', 21, {'name': 'بهار', 'role': 'student', 'class_id': 5});
  await s.put('schedule', 900, {
    'class_id': 5,
    'grade': 'دهم',
    'branch': 'الکترونیک',
    'subject_id': 41,
    'teacher_id': 10,
    'weekday': 0,
    'bell_order': 1,
  });
}

Future<MemorySchool> openSchedule(
  WidgetTester tester, {
  String role = 'manager',
  MemorySchool? source,
  Future<void> Function(MemorySchool s)? extra,
}) async {
  final (_, s) = await bootSchool(
    tester,
    role: role,
    seed: (s) async {
      await seed(s);
      if (extra != null) await extra(s);
    },
    source: source,
  );
  await tapKey(tester, 'adm-schedule');
  return s;
}

Future<void> choose(WidgetTester tester, String dropdown, String text) async {
  await tapKey(tester, dropdown);
  await tester.tap(find.text(text).last);
  await settle(tester);
}

void main() {
  testWidgets('W9-W01 manager grid: cohort, cell with subject + teacher, only work days, no clash; '
      'NEG a student sees the same week read-only', (tester) async {
    await openSchedule(tester);
    expect(find.byKey(const Key('sch-grade')), findsOneWidget);
    expect(find.byKey(const Key('sch-noclash')), findsOneWidget);
    expect(find.text('ریاضی'), findsOneWidget);
    expect(find.text('دبیر ریاضی'), findsOneWidget);
    expect(find.text('پنج‌شنبه'), findsNothing, reason: 'not a work day');
    expect(find.byKey(const Key('sch-cell-4-4')), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await bootSchool(
      tester,
      role: 'student',
      seed: (s) async {
        await seed(s);
        await s.put('users', 10, {
          'name': 'بهار',
          'role': 'student',
          'class_id': 5,
        });
      },
    );
    await tapKey(tester, 'adm-schedule');
    expect(find.text('ریاضی'), findsOneWidget);
    expect(find.byKey(const Key('sch-workdays')), findsNothing);
    await tapKey(tester, 'sch-cell-1-1');
    expect(
      find.byKey(const Key('slot-save')),
      findsNothing,
      reason: 'read-only',
    );
  });

  testWidgets('W9-W02 teacher: own teaching, home-class view; no edit tools', (
    tester,
  ) async {
    await openSchedule(tester, role: 'teacher');
    expect(find.text('برنامهٔ هفتگی تدریس من'), findsOneWidget);
    expect(find.text('ریاضی'), findsOneWidget);
    expect(find.byKey(const Key('sch-gen')), findsNothing);
    await choose(tester, 'sch-home', 'سرپرستی: دهم الکترونیک');
    expect(find.textContaining('برنامهٔ کلاسی دهم الکترونیک'), findsOneWidget);
  });

  testWidgets(
    'W9-W03 add a slot: NEG no subject refused (form stays); teacher marked free/busy; saved offline',
    (tester) async {
      final s = await openSchedule(tester);
      await tapKey(tester, 'sch-cell-1-2');
      expect(find.text('پایه و رشته: دهم · الکترونیک'), findsOneWidget);
      await tapKey(tester, 'slot-save');
      expect(textOf(tester, 'slot-form-error'), 'درس را انتخاب کنید');
      expect(s.outbox.list(), isEmpty);
      await choose(tester, 'slot-f-subject', 'فیزیک');
      await choose(tester, 'slot-f-teacher', '🟢 دبیر فیزیک');
      await choose(tester, 'slot-f-room', 'کارگاه ۱');
      await tapKey(tester, 'slot-save');
      expect(find.byKey(const Key('slot-save')), findsNothing);
      expect(textOf(tester, 'sch-notice'), 'برنامه ذخیره شد');
      final op = s.outbox.list().single;
      expect(op.collection, 'schedule');
      expect(op.payload!['class_id'], 5);
      expect(op.payload!['room'], 'کارگاه ۱');
      expect(find.text('فیزیک'), findsOneWidget);
    },
  );

  testWidgets(
    'W9-W04 NEG teacher clash: another cohort at the same bell → busy mark + refused, nothing queued',
    (tester) async {
      final s = await openSchedule(tester);
      await choose(tester, 'sch-grade', 'هفتم');
      await tapKey(tester, 'sch-cell-0-1');
      await choose(tester, 'slot-f-subject', 'ریاضی');
      await choose(
        tester,
        'slot-f-teacher',
        '🔴 دبیر ریاضی — در این ساعت مشغول',
      );
      await tapKey(tester, 'slot-save');
      expect(textOf(tester, 'slot-form-error'), contains('تداخل ساعت'));
      expect(s.outbox.list(), isEmpty);
      // moving the form to a free bell clears the busy mark
      await choose(tester, 'slot-f-period', 'زنگ ۲ (درس)');
      await tapKey(tester, 'slot-save');
      expect(find.byKey(const Key('slot-save')), findsNothing);
      final op = s.outbox.list().last;
      expect(op.payload!['bell_order'], 2);
      expect(s.outbox.list().map((o) => o.collection), [
        'classes',
        'schedule',
      ], reason: 'the هفتم cohort class is created');
    },
  );

  testWidgets('W9-W05 edit and delete a slot (NEG cancel keeps it)', (
    tester,
  ) async {
    final s = await openSchedule(tester);
    await tapKey(tester, 'sch-cell-0-1');
    await choose(tester, 'slot-f-subject', 'فیزیک');
    await tapKey(tester, 'slot-save');
    expect(find.text('فیزیک'), findsOneWidget);
    await tapKey(tester, 'sch-cell-0-1');
    await tapKey(tester, 'slot-delete');
    await tapKey(tester, 'slot-confirm-cancel');
    expect(s.outbox.list(), hasLength(1));
    await tapKey(tester, 'slot-delete');
    await tapKey(tester, 'slot-confirm-ok');
    expect(find.byKey(const Key('slot-save')), findsNothing);
    expect(await tester.runAsync(() => s.engine.get('schedule', 900)), isNull);
  });

  testWidgets(
    'W9-W06 substitution: NEG wrong weekday / same teacher; saved; listed; deleted from the list',
    (tester) async {
      final s = await openSchedule(tester);
      await tapKey(tester, 'sch-cell-0-1');
      await typeKey(tester, 'slot-sub-date', monJ);
      await choose(tester, 'slot-sub-teacher', 'دبیر فیزیک');
      await tapKey(tester, 'slot-sub-save');
      expect(textOf(tester, 'slot-form-error'), 'تاریخ باید روز «شنبه» باشد');
      await typeKey(tester, 'slot-sub-date', 'نامعتبر');
      await tapKey(tester, 'slot-sub-save');
      expect(
        textOf(tester, 'slot-form-error'),
        'تاریخ شمسی معتبر را وارد کنید',
      );
      await typeKey(tester, 'slot-sub-date', satJ);
      await choose(tester, 'slot-sub-teacher', 'دبیر ریاضی');
      await tapKey(tester, 'slot-sub-save');
      expect(textOf(tester, 'slot-form-error'), contains('همان دبیر'));
      expect(s.outbox.list(), isEmpty);
      await choose(tester, 'slot-sub-teacher', 'دبیر فیزیک');
      await tapKey(tester, 'slot-sub-save');
      expect(find.byKey(const Key('slot-save')), findsNothing);
      final op = s.outbox.list().single;
      expect(op.collection, 'substitutions');
      expect(op.payload!['date'], '2026-11-14');
      final id = op.id;
      await reveal(tester, 'sch-sub-$id');
      expect(find.textContaining('دبیر فیزیک'), findsWidgets);
      await tapKey(tester, 'sch-sub-del-$id');
      await tapKey(tester, 'sch-confirm-ok');
      expect(find.byKey(Key('sch-sub-$id')), findsNothing);
      // sub-del from the slot form removes the slot's substitution too
      await tapKey(tester, 'sch-cell-0-1');
      await typeKey(tester, 'slot-sub-date', satJ);
      await choose(tester, 'slot-sub-teacher', 'دبیر فیزیک');
      await tapKey(tester, 'slot-sub-save');
      await tapKey(tester, 'sch-cell-0-1');
      await reveal(tester, 'slot-sub-current');
      expect(textOf(tester, 'slot-sub-current'), contains('دبیر فیزیک'));
      await tapKey(tester, 'slot-sub-del');
      expect(find.byKey(const Key('slot-save')), findsNothing);
      final subs = await tester.runAsync(() => s.engine.list('substitutions'));
      expect(subs, isEmpty);
    },
  );

  testWidgets(
    'W9-W07 clashes in the data: listed, suggestion → move; the clash is gone',
    (tester) async {
      final s = await openSchedule(
        tester,
        extra: (s) => s.put('schedule', 904, {
          'class_id': 5,
          'grade': 'دهم',
          'branch': 'الکترونیک',
          'subject_id': 42,
          'teacher_id': 10,
          'weekday': 0,
          'bell_order': 1,
        }),
      );
      expect(find.byKey(const Key('sch-clashes')), findsOneWidget);
      expect(find.textContaining('۲ تداخل'), findsOneWidget);
      await tapKey(tester, 'sch-sug-class-904');
      await tapKey(tester, 'sch-move-class-904-0-2');
      expect(textOf(tester, 'sch-notice'), 'زنگ جابه‌جا شد: شنبه زنگ ۲');
      expect(find.byKey(const Key('sch-noclash')), findsOneWidget);
      expect(s.outbox.list().single.payload!['bell_order'], 2);
    },
  );

  testWidgets(
    'W9-W08 bells: NEG empty row refused; rows removed/added; the grid shows the new bells',
    (tester) async {
      final s = await openSchedule(tester);
      await tapKey(tester, 'sch-bells');
      await reveal(tester, 'bell-row-6');
      expect(find.byKey(const Key('bell-row-6')), findsOneWidget);
      await tapKey(tester, 'bell-save');
      expect(
        textOf(tester, 'bell-form-error'),
        'زمان شروع و پایان ردیف ۱ را وارد کنید',
      );
      await tester.drag(find.byType(ListView).last, const Offset(0, 3000));
      await settle(tester);
      for (var i = 0; i < 6; i++) {
        await tapKey(tester, 'bell-del-1');
      }
      await tapKey(tester, 'bell-del-0');
      expect(textOf(tester, 'bell-form-error'), 'دست‌کم یک زنگ لازم است');
      await typeKey(tester, 'bell-s-0', '۷:۳۰');
      await typeKey(tester, 'bell-e-0', '08:15');
      await tapKey(tester, 'bell-add');
      await typeKey(tester, 'bell-e-1', '09:00');
      await tapKey(tester, 'bell-save');
      expect(find.byKey(const Key('bell-save')), findsNothing);
      expect(s.outbox.list().map((o) => o.collection), [
        'bell_schedules',
        'bell_schedules',
      ]);
      expect(find.text('07:30 – 08:15'), findsOneWidget);
      expect(
        find.byKey(const Key('sch-cell-0-3')),
        findsNothing,
        reason: 'two lessons now',
      );
    },
  );

  testWidgets(
    'W9-W09 work days: NEG none refused; Thursday added → its column appears',
    (tester) async {
      final s = await openSchedule(tester);
      await tapKey(tester, 'sch-workdays');
      for (var i = 0; i < 5; i++) {
        await tapKey(tester, 'wd-day-$i');
      }
      await tapKey(tester, 'wd-save');
      expect(textOf(tester, 'wd-form-error'), 'دست‌کم یک روز فعال انتخاب کنید');
      expect(s.outbox.list(), isEmpty);
      await tapKey(tester, 'wd-day-0');
      await tapKey(tester, 'wd-day-5');
      await tapKey(tester, 'wd-save');
      expect(find.text('پنج‌شنبه'), findsOneWidget);
      expect(find.text('یک‌شنبه'), findsNothing);
      expect(s.outbox.list().single.payload!['workdays'], [0, 5]);
    },
  );

  testWidgets(
    'W9-W10 generator preview → apply fills empty cells; inline teacher/room/subject '
    'from the slot form; NEG full queue refuses a multi-row delete',
    (tester) async {
      final s = await openSchedule(tester);
      await tapKey(tester, 'sch-gen');
      expect(
        textOf(tester, 'gen-stats'),
        startsWith('تقاضا: ۲ زنگ · قابلِ ثبت: ۲'),
      );
      await tapKey(tester, 'gen-save');
      expect(textOf(tester, 'sch-notice'), '۲ زنگ ثبت شد');
      expect(s.outbox.list(), hasLength(2));
      // the grid's own horizontal scroll does not bring a low cell up: scroll the page
      await tester.drag(find.byType(ListView).first, const Offset(0, -300));
      await settle(tester);
      await tapKey(tester, 'sch-cell-3-4');
      await choose(tester, 'slot-f-teacher', '＋ ثبت دبیر تازه…');
      await typeKey(tester, 'slot-add-teacher-name', 'دبیر تازه');
      await tapKey(tester, 'slot-add-teacher-ok');
      await choose(tester, 'slot-f-room', '＋ افزودن محل تازه…');
      await typeKey(tester, 'slot-add-room-name', 'کارگاه برق');
      await tapKey(tester, 'slot-add-room-ok');
      await choose(tester, 'slot-f-subject', '＋ تعریف درس تازه…');
      await typeKey(tester, 'slot-add-subject-name', 'نقشه‌کشی');
      await tapKey(tester, 'slot-add-subject-ok');
      await tapKey(tester, 'slot-save');
      expect(find.byKey(const Key('slot-save')), findsNothing);
      final ops = s.outbox.list().skip(2).map((o) => o.collection).toList();
      expect(ops, ['users', 'classes', 'subjects', 'schedule']);
      expect(find.text('نقشه‌کشی'), findsOneWidget);
      expect(find.text('دبیر تازه'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      final full = MemorySchool(config: const OutboxConfig(capacity: 1));
      await openSchedule(
        tester,
        source: full,
        extra: (s) => s.put('substitutions', 950, {
          'schedule_id': 900,
          'sub_teacher_id': 11,
          'date': '2026-11-14',
        }),
      );
      await tapKey(tester, 'sch-cell-0-1');
      await choose(tester, 'slot-f-subject', 'فیزیک');
      await tapKey(tester, 'slot-save'); // fills the queue (capacity 1)
      await tapKey(tester, 'sch-cell-0-1');
      await tapKey(tester, 'slot-delete');
      await tapKey(tester, 'slot-confirm-ok');
      expect(textOf(tester, 'slot-form-error'), contains('صف ارسال پر است'));
      expect(
        await tester.runAsync(() => full.engine.get('schedule', 900)),
        isNotNull,
      );
      expect(
        await tester.runAsync(() => full.engine.get('substitutions', 950)),
        isNotNull,
      );
    },
  );

  testWidgets('W9-W11 parent: one tab per child (web sched-class), each child\'s class week; '
      'NEG no edit tools', (tester) async {
    await bootSchool(
      tester,
      role: 'parent',
      seed: (s) async {
        await seed(s);
        await s.put('classes', 7, {
          'name': 'هفتم الف',
          'grade': 'هفتم',
          'kind': 'class',
        });
        await s.put('users', 22, {
          'name': 'نیما',
          'role': 'student',
          'class_id': 7,
        });
        await s.put('schedule', 910, {
          'class_id': 7,
          'grade': 'هفتم',
          'subject_id': 42,
          'teacher_id': 11,
          'weekday': 2,
          'bell_order': 3,
        });
        await s.put('parent_links', 700, {'parent_id': 10, 'student_id': 21});
        await s.put('parent_links', 701, {'parent_id': 10, 'student_id': 22});
      },
    );
    await tapKey(tester, 'adm-schedule');
    expect(find.text('ریاضی'), findsOneWidget);
    expect(find.text('فیزیک'), findsNothing);
    await tapKey(tester, 'sch-child-22');
    expect(find.text('فیزیک'), findsOneWidget);
    expect(find.text('ریاضی'), findsNothing);
    expect(find.byKey(const Key('sch-bells')), findsNothing);
    expect(find.byKey(const Key('sch-gen')), findsNothing);
  });
}
