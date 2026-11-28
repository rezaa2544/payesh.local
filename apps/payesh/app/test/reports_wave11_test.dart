// Row 128, wave W11 — home dashboards, reports (+ print), the day attendance view and the
// manager's leave decisions. Widget tests drive the REAL app shell, pages, controllers and
// SchoolReports on an in-memory SQLite + durable outbox; the real server path is
// packages/payesh_sync/test/school_admin_it_test.dart W11-IT-*.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/reports/reports_screen.dart';

import 'nav_support.dart';
import 'school_support.dart';

// harness "today" is Thursday 2026-11-12 08:00 — inside the first lesson bell.
Future<void> seed(MemorySchool s, {int teacher = 10}) async {
  await s.put('schools', 1, {'name': 'هنرستان نمونه'});
  await s.put('classes', 5, {
    'name': 'دهم الکترونیک',
    'grade': 'دهم',
    'branch': 'الکترونیک',
    'kind': 'class',
  });
  await s.put('classes', 6, {'name': 'کارگاه ۱', 'kind': 'room'});
  await s.put('classes', 7, {'name': 'هفتم', 'grade': 'هفتم', 'kind': 'class'});
  await s.put('users', teacher, {'name': 'دبیر ریاضی', 'role': 'teacher'});
  await s.put('users', 21, {'name': 'بهار', 'role': 'student', 'class_id': 5});
  await s.put('users', 22, {'name': 'آرش', 'role': 'student', 'class_id': 5});
  await s.put('users', 23, {'name': 'سارا', 'role': 'student', 'class_id': 7});
  await s.put('subjects', 41, {'name': 'ریاضی'});
  await s.put('subjects', 42, {'name': 'فیزیک'});
  await s.put('bell_schedules', 1, {
    'order': 1,
    'start': '08:00',
    'end': '08:45',
    'type': 'lesson',
    'label': 'زنگ اول',
  });
  await s.put('bell_schedules', 3, {
    'order': 2,
    'start': '09:00',
    'end': '09:45',
    'type': 'lesson',
  });
  await s.put('schedule', 900, {
    'class_id': 5,
    'subject_id': 41,
    'teacher_id': teacher,
    'weekday': 5,
    'bell_order': 2,
  });
  await s.put('schedule', 901, {
    'class_id': 7,
    'subject_id': 42,
    'teacher_id': teacher,
    'weekday': 5,
    'bell_order': 1,
    'room_id': 6,
  });
  var a = 0;
  Future<void> att(int cls, int st, String date, String status) => s.put(
    'attendance',
    ++a,
    {'class_id': cls, 'student_id': st, 'date': date, 'status': status},
  );
  await att(5, 21, '2026-11-12', 'present');
  await att(5, 22, '2026-11-12', 'absent');
  await att(5, 21, '2026-11-09', 'late');
  var g = 0;
  Future<void> grade(int st, int sub, num score, String status) =>
      s.put('grades', ++g, {
        'class_id': 5,
        'student_id': st,
        'subject_id': sub,
        'score': score,
        'status': status,
      });
  await grade(21, 41, 18, 'approved');
  await grade(21, 42, 16, 'pending');
  await grade(22, 41, 12, 'approved');
  await s.put('announcements', 80, {
    'title': 'جلسهٔ اولیا',
    'date': '2026-11-11',
  });
  await s.put('leaves', 60, {
    'student_id': 21,
    'date': '2026-11-15',
    'reason': 'پزشکی',
    'status': 'pending',
    'created_at': '2026-11-10T08:00:00Z',
  });
  await s.put('leaves', 61, {
    'student_id': 22,
    'date': '2026-11-16',
    'reason': 'سفر',
    'status': 'pending',
    'created_at': '2026-11-11T08:00:00Z',
  });
}

Future<MemorySchool> open(
  WidgetTester tester,
  String page, {
  String role = 'manager',
}) async {
  // Row 172: the web-layout pages are long lists of cards — a tall window keeps them built
  tester.view.physicalSize = const Size(2400, 24000);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  final (_, s) = await bootSchool(
    tester,
    role: role,
    seed: (s) async {
      // the signed-in user is uid 10 (see school_support.dart)
      await seed(s, teacher: role == 'teacher' ? 10 : 11);
      if (role != 'teacher') {
        await s.put('users', 10, {
          'name': role == 'student' ? 'نوید' : 'مدیر',
          'role': role,
          if (role == 'student') 'class_id': 5,
        });
      }
    },
  );
  // ردیف ۱۹۷ (F28): «مرخصی‌ها» در منوی مدیر است (پیش‌تر نبود و درخواست ولی به مدیر نمی‌رسید)
  await openPage(tester, page);
  return s;
}

void main() {
  testWidgets('W11-W01 manager home: counts, cohort coverage, the room in use now, latest notice; '
      'NEG a teacher has no reports, day view or leave list', (tester) async {
    await open(tester, 'home');
    // row 180 design 2: greeting, the ring card, the week and the absent / late list
    expect(find.byKey(const Key('dash-topbar')), findsOneWidget);
    expect(textIn(tester, 'dash-now'), contains('زنگ اول'));
    expect(textOf(tester, 'pulse-of'), '۱ نفر از ۳ دانش‌آموز');
    expect(textIn(tester, 'pulse-a'), contains('غایب ۱'));
    expect(textIn(tester, 'dash-away'), contains('غایب'));
    expect(badgeOf(tester, 'dash-covered'), '۱ از ۲ گروه دارای ثبت');
    expect(badgeOf(tester, 'dash-cov-0'), '۱۰۰٪');
    await reveal(tester, 'dash-room-6');
    // Row 172: the web rooms table — class, lesson and teacher in their own cells
    expect(find.byKey(const Key('dash-room-6')), findsOneWidget);
    expect(find.textContaining('فیزیک'), findsWidgets);
    expect(find.textContaining('دبیر ریاضی'), findsWidgets);
    expect(find.text('در حال برگزاری'), findsOneWidget);
    await reveal(tester, 'dash-recent');
    expect(find.text('جلسهٔ اولیا'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await bootSchool(tester, role: 'teacher', seed: (s) => seed(s));
    expect(navOf('home'), findsOneWidget);
    for (final k in ['reports', 'attendance-report', 'leaves']) {
      expect(navOf(k), findsNothing, reason: k);
    }
  });

  testWidgets('W11-W02 teacher and student home: today\'s lessons, the current bell, attendance '
      'recorded or not', (tester) async {
    await open(tester, 'home', role: 'teacher');
    expect(find.text('امروز من'), findsWidgets);
    expect(textIn(tester, 'dash-bell-text'), contains('08:00 – 08:45'));
    expect(badgeOf(tester, 'dash-done-1'), 'ثبت نشده');
    expect(badgeOf(tester, 'dash-done-2'), 'ثبت شده');
    expect(find.text('فیزیک · زنگ جاری'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await open(tester, 'home', role: 'student');
    expect(find.text('امروز'), findsWidgets);
    expect(find.byKey(const Key('dash-slot-2')), findsOneWidget);
    expect(find.byKey(const Key('dash-slot-1')), findsNothing);
    expect(find.text('ریاضی'), findsOneWidget);
    expect(find.byKey(const Key('dash-done-2')), findsNothing);
    // Row 197 (Q12 / F21): the student home = «امروز» + open homework + upcoming exams +
    // the latest discipline notes; the record is its own page («پروندهٔ من»), not repeated
    expect(find.byKey(const Key('home-homework')), findsOneWidget);
    expect(find.byKey(const Key('home-exams')), findsOneWidget);
    expect(find.byKey(const Key('home-discipline')), findsOneWidget);
    expect(find.text('پروندهٔ من'), findsNothing);
    expect(find.byKey(const Key('rec-present')), findsNothing);
    expect(find.byKey(const Key('rec-grades')), findsNothing);
  });

  testWidgets('W11-W03 reports: weekly share per class, class report card, another class; print '
      'writes one HTML file; NEG a failed write is reported', (tester) async {
    final saved = ReportsController.save;
    addTearDown(() => ReportsController.save = saved);
    final files = <String, String>{};
    ReportsController.save = (name, html) async {
      files[name] = html;
      return '/docs/$name';
    };
    await open(tester, 'reports');
    expect(badgeOf(tester, 'rep-pct-5'), '۳۳٪');
    expect(badgeOf(tester, 'rep-pct-7'), '۰٪');
    expect(textOf(tester, 'rep-avg-21'), '۱۷.۰۰');
    expect(textOf(tester, 'rep-att-21'), '۵۰٪');
    expect(textOf(tester, 'rep-avg-22'), '۱۲.۰۰');
    await tapKey(tester, 'rep-print');
    expect(
      textOf(tester, 'rep-notice'),
      'نسخهٔ چاپی ذخیره شد: /docs/payesh-report-2026-11-12.html — آن را باز کنید و چاپ بگیرید',
    );
    final html = files.values.single;
    expect(html, contains('هنرستان نمونه — گزارش‌ها'));
    // row 204: a field school (هنرستان) prints «پایه و رشته», never «کلاس»
    expect(html, contains('کارنامهٔ پایه و رشته — دهم الکترونیک'));
    await tapKey(tester, 'rep-class');
    await tester.tap(find.text('هفتم').last);
    await settle(tester);
    // row 197 F20/F24: no grade ⇒ «—», never «۰.۰۰»
    expect(textOf(tester, 'rep-avg-23'), '—');
    expect(textOf(tester, 'rep-att-23'), '—');
    expect(find.byKey(const Key('rep-avg-21')), findsNothing);
    ReportsController.save = (name, html) async =>
        throw const FormatException('disk full');
    await tapKey(tester, 'rep-print');
    expect(textOf(tester, 'rep-error'), startsWith('فایل چاپی ذخیره نشد'));
  });

  testWidgets(
    'W11-W04 attendance report: today per class, everyone not present; other days',
    (tester) async {
      await open(tester, 'attendance-report');
      // Row 172: the web Jalali date input (typed) replaces the ‹ › day buttons
      String shown() => tester
          .widget<TextField>(
            find.descendant(
              of: find.byKey(const Key('atr-date')),
              matching: find.byType(TextField),
            ),
          )
          .controller!
          .text;
      expect(shown(), '۱۴۰۵/۰۸/۲۱');
      expect(textOf(tester, 'atr-count-5'), '۱ حاضر از ۲');
      expect(badgeOf(tester, 'atr-miss-5-0'), 'آرش · غایب');
      expect(textOf(tester, 'atr-count-7'), 'ثبت نشده');
      await typeKey(tester, 'atr-date', '1405/08/20');
      await settle(tester);
      expect(textOf(tester, 'atr-count-5'), 'ثبت نشده');
      await typeKey(tester, 'atr-date', '1405/08/18');
      await settle(tester);
      expect(badgeOf(tester, 'atr-miss-5-0'), 'بهار · تأخیر');
      await typeKey(tester, 'atr-date', '1405/08/19');
      await settle(tester);
      expect(shown(), '1405/08/19');
    },
  );

  testWidgets('W11-W05 leaves: approve and reject (queued with who decided); delete asks first '
      '(NEG cancel keeps it)', (tester) async {
    final s = await open(tester, 'leaves');
    expect(textOf(tester, 'lvd-count'), '۲ درخواست · ۲ در انتظار');
    expect(badgeOf(tester, 'lvd-status-60'), 'در انتظار');
    await tapKey(tester, 'lvd-approve-60');
    expect(textOf(tester, 'lvd-notice'), 'درخواست تأیید شد');
    expect(badgeOf(tester, 'lvd-status-60'), 'تأییدشده');
    final op = s.outbox.list().single;
    expect(op.collection, 'leaves');
    expect(op.payload!['decided_by'], 10);
    await tapKey(tester, 'lvd-reject-61');
    expect(badgeOf(tester, 'lvd-status-61'), 'رد شده');
    await tapKey(tester, 'lvd-delete-61');
    await tapKey(tester, 'lvd-confirm-cancel');
    expect(find.byKey(const Key('lvd-row-61')), findsOneWidget);
    expect(s.outbox.list(), hasLength(2));
    await tapKey(tester, 'lvd-delete-61');
    await tapKey(tester, 'lvd-confirm-ok');
    expect(find.byKey(const Key('lvd-row-61')), findsNothing);
    expect(textOf(tester, 'lvd-notice'), 'درخواست حذف شد');
    expect(s.outbox.list().last.type, 'del');
    expect(await tester.runAsync(() => s.engine.get('leaves', 61)), isNull);
  });

  // ردیف ۱۹۷ (Q02 / F28): مدیر مرخصی را می‌بیند، ثبت می‌کند و گواهی را باز می‌کند
  const png1 =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

  Future<void> pick(WidgetTester tester, String key, String text) async {
    await tester.ensureVisible(find.byKey(Key(key)));
    await tester.tap(find.byKey(Key(key)));
    await tester.pumpAndSettle();
    await tester.tap(find.text(text).last);
    await tester.pumpAndSettle();
  }

  testWidgets(
    'W11-197a داشبورد مدیر: کارت «۲ درخواست مرخصی در انتظار تأیید» → صفحهٔ مرخصی‌ها',
    (tester) async {
      await open(tester, 'home');
      expect(textOf(tester, 'dash-leaves-text'), contains('۲ درخواست مرخصی'));
      await tapKey(tester, 'dash-leaves');
      expect(find.byKey(const Key('lvd-row-60')), findsOneWidget);
    },
  );

  testWidgets(
    'W11-197b ثبت مرخصی به‌دست مدیر: NEG بی‌دانش‌آموز رد؛ چندروزه + تأیید فوری ⇒ approved با '
    'decided_by و پیوست؛ «مشاهدهٔ گواهی» تصویر را باز می‌کند',
    (tester) async {
      final s = await open(tester, 'leaves');
      LeaveDeskForm.pick = () async => png1;
      addTearDown(() => LeaveDeskForm.pick = null);
      await tapKey(tester, 'lvd-add');
      // پهنای ۸۰۰ ⇒ صفحهٔ کامل فرم (گوشی)
      expect(find.byKey(const Key('lvm-save')), findsOneWidget);
      // NEG: دانش‌آموز انتخاب نشده
      await tapKey(tester, 'lvm-save');
      expect(find.text('دانش‌آموز را انتخاب کنید'), findsOneWidget);
      expect(s.outbox.list(), isEmpty);
      await pick(tester, 'lvm-student', 'بهار — دهم الکترونیک');
      await tester.enterText(
        find.byKey(const Key('lvm-date-to')),
        '۱۴۰۵/۰۸/۲۲',
      );
      await pick(tester, 'lvm-type', 'استعلاجی (بیماری)');
      await tester.enterText(find.byKey(const Key('lvm-reason')), 'سرماخوردگی');
      await tapKey(tester, 'lvm-attach');
      await tapKey(tester, 'lvm-save');
      expect(find.byKey(const Key('lvm-save')), findsNothing);
      final op = s.outbox.list().single;
      expect(op.collection, 'leaves');
      expect(op.payload!['student_id'], 21);
      expect(op.payload!['date'], '2026-11-12');
      expect(op.payload!['date_to'], '2026-11-13');
      expect(op.payload!['status'], 'approved');
      expect(op.payload!['decided_by'], 10);
      expect(op.payload!['type'], 'sick');
      expect(op.payload!['attachment'], png1);
      expect(textOf(tester, 'lvd-count'), '۳ درخواست · ۲ در انتظار');
      final id = op.id;
      expect(textOf(tester, 'lvd-when-$id'), contains('(۲ روز)'));
      await tapKey(tester, 'lvd-att-$id');
      expect(find.byKey(const Key('lv-att-dialog')), findsOneWidget);
      expect(find.byKey(const Key('lv-att-image')), findsOneWidget);
      await tapKey(tester, 'lv-att-close');
      expect(find.byKey(const Key('lv-att-dialog')), findsNothing);
      // NEG: درخواست‌های بدون گواهی دکمهٔ گواهی ندارند
      expect(find.byKey(const Key('lvd-att-60')), findsNothing);
    },
  );

  testWidgets(
    'W11-197c ثبت مرخصی ساعتی بدون تأیید فوری ⇒ pending و در صدر فهرست',
    (tester) async {
      final s = await open(tester, 'leaves');
      await tapKey(tester, 'lvd-add');
      await pick(tester, 'lvm-student', 'آرش — دهم الکترونیک');
      await pick(tester, 'lvm-kind', 'ساعتی (خروج زودهنگام / ورود دیرتر)');
      await tester.enterText(find.byKey(const Key('lvm-time-from')), '10');
      await tester.enterText(find.byKey(const Key('lvm-time-to')), '11:30');
      await tapKey(tester, 'lvm-approve');
      await tapKey(tester, 'lvm-save');
      final op = s.outbox.list().single;
      expect(op.payload!['status'], 'pending');
      expect(op.payload!.containsKey('decided_by'), isFalse);
      expect(op.payload!['time_from'], '10:00');
      expect(op.payload!['time_to'], '11:30');
      expect(textOf(tester, 'lvd-count'), '۳ درخواست · ۳ در انتظار');
    },
  );
}
