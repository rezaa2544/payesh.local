// Row 128, wave W11 — home dashboards, reports (+ print), the day attendance view and the
// manager's leave decisions. Widget tests drive the REAL app shell, pages, controllers and
// SchoolReports on an in-memory SQLite + durable outbox; the real server path is
// packages/payesh_sync/test/school_admin_it_test.dart W11-IT-*.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/reports/reports_screen.dart';

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
  await tapKey(tester, 'adm-$page');
  return s;
}

void main() {
  testWidgets('W11-W01 manager home: counts, cohort coverage, the room in use now, latest notice; '
      'NEG a teacher has no reports, day view or leave list', (tester) async {
    await open(tester, 'home');
    expect(find.text('داشبورد مدرسه'), findsOneWidget);
    expect(textOf(tester, 'dash-now'), contains('زنگ اول'));
    expect(textOf(tester, 'dash-students'), '۳');
    expect(textOf(tester, 'dash-present'), '۱ / ۲');
    expect(textOf(tester, 'dash-absent'), '۱');
    expect(textOf(tester, 'dash-pending'), '۱');
    expect(badgeOf(tester, 'dash-covered'), '۱ از ۲ گروه دارای ثبت');
    expect(badgeOf(tester, 'dash-cov-0'), '۱۰۰٪');
    await reveal(tester, 'dash-room-6');
    expect(find.text('هفتم · فیزیک · دبیر ریاضی'), findsOneWidget);
    expect(find.text('در حال برگزاری'), findsOneWidget);
    await reveal(tester, 'dash-recent');
    expect(find.text('جلسهٔ اولیا'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await bootSchool(tester, role: 'teacher', seed: (s) => seed(s));
    expect(find.byKey(const Key('adm-home')), findsOneWidget);
    for (final k in ['reports', 'attendance-report', 'leaves']) {
      expect(find.byKey(Key('adm-$k')), findsNothing, reason: k);
    }
  });

  testWidgets('W11-W02 teacher and student home: today\'s lessons, the current bell, attendance '
      'recorded or not', (tester) async {
    await open(tester, 'home', role: 'teacher');
    expect(find.text('امروز من'), findsOneWidget);
    expect(textOf(tester, 'dash-bell-text'), '۰۸:۰۰ – ۰۸:۴۵ · زنگ اول');
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
    expect(html, contains('کارنامهٔ کلاسی — دهم الکترونیک'));
    await tapKey(tester, 'rep-class');
    await tester.tap(find.text('هفتم').last);
    await settle(tester);
    expect(textOf(tester, 'rep-avg-23'), '۰.۰۰');
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
      expect(textOf(tester, 'atr-date'), '۱۴۰۵/۰۸/۲۱');
      expect(textOf(tester, 'atr-count-5'), '۱ حاضر از ۲');
      expect(badgeOf(tester, 'atr-miss-5-0'), 'آرش · غایب');
      expect(textOf(tester, 'atr-count-7'), 'ثبت نشده');
      await tapKey(tester, 'atr-prev');
      expect(textOf(tester, 'atr-date'), '۱۴۰۵/۰۸/۲۰');
      expect(textOf(tester, 'atr-count-5'), 'ثبت نشده');
      await tapKey(tester, 'atr-prev');
      await tapKey(tester, 'atr-prev');
      expect(badgeOf(tester, 'atr-miss-5-0'), 'بهار · تأخیر');
      await tapKey(tester, 'atr-next');
      expect(textOf(tester, 'atr-date'), '۱۴۰۵/۰۸/۱۹');
    },
  );

  testWidgets('W11-W05 leaves: approve and reject (queued with who decided); delete asks first '
      '(NEG cancel keeps it)', (tester) async {
    final s = await open(tester, 'leaves');
    expect(textOf(tester, 'lvd-count'), '۲ درخواست');
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
}
