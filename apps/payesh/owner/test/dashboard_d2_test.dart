// Row 181 — design 2 («مینیمال حرفه‌ای») owner overview: KPI numbers, the «مدارس» card with
// its three tabs and state pills, and the compact DB light on the page-head date line.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/local/local_platform.dart';
import 'package:payesh_owner/src/pages/dashboard_d2.dart';
import 'package:payesh_owner/src/schools/school_registry.dart';
import 'package:payesh_owner/src/status/status_lights.dart';
import 'package:payesh_ui/payesh_ui.dart';

Future<void> _pump(
  WidgetTester tester,
  Widget child, {
  bool dark = false,
}) async {
  tester.view.physicalSize = const Size(1400, 1000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: dark
          ? PayeshUi.dark(look: PayeshLook.minimal)
          : PayeshUi.light(look: PayeshLook.minimal),
      home: Directionality(
        textDirection: TextDirection.rtl,
        child: Scaffold(body: SingleChildScrollView(child: child)),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  final now = DateTime(2026, 11, 25, 10);
  String iso(DateTime d) => d.toUtc().toIso8601String();

  SchoolsView view() => SchoolsView(
    connected: true,
    rev: 1,
    plain: {
      'schools': [
        {
          'id': 's1',
          'name': 'دبیرستان البرز',
          'county': 'کرج',
          'created_at': iso(now),
        },
        {'id': 's2', 'name': 'دبستان فردوسی', 'province': 'تهران'},
        {'id': 's3', 'name': 'هنرستان خوارزمی'},
        {'id': 's4', 'name': 'دبیرستان مطهری'},
        {'id': 's5', 'name': 'دبستان سعدی'},
        {'id': 's6', 'name': 'مدرسهٔ خاموش', 'active': false},
      ],
    },
    acks: {
      's1': {
        'at': iso(now.subtract(const Duration(minutes: 1))),
        'version': '0.9.38',
        'users': {'total': 120},
        'subs': [
          {'status': 'active'},
        ],
      },
      's2': {
        'at': iso(now.subtract(const Duration(minutes: 2))),
        'version': '0.9.38',
        'users': {'total': 30},
        'subs': [
          {'status': 'trial', 'end': iso(now.add(const Duration(days: 9)))},
        ],
      },
      's3': {
        'at': iso(now.subtract(const Duration(hours: 3))),
        'version': '0.9.38',
        'users': {'total': 50},
      },
      's4': {
        'at': iso(now.subtract(const Duration(minutes: 1))),
        'version': '0.9.30',
        'users': {'total': 10},
      },
    },
    payments: [
      {'status': 'paid', 'amount': 25000000, 'paid_at': iso(now)},
      {
        'status': 'paid',
        'amount': 20000000,
        'paid_at': iso(now.subtract(const Duration(days: 31))),
      },
      {'status': 'pending', 'amount': 99, 'paid_at': iso(now)},
    ],
  );

  test('OwnerOverview.of: states, counts and revenue from host reports', () {
    final ov = OwnerOverview.of(view(), now);
    final by = {for (final s in ov.schools) s.id: s};
    expect(by['s1']!.state, SchoolState.online);
    expect(by['s1']!.place, 'کرج');
    expect(by['s2']!.state, SchoolState.trial);
    expect(by['s2']!.label, contains('آزمایشی'));
    expect(by['s2']!.trial, isTrue);
    expect(by['s3']!.state, SchoolState.offline);
    expect(by['s3']!.label, startsWith('آفلاین · '));
    expect(by['s4']!.state, SchoolState.outdated);
    expect(by['s4']!.label, 'به‌روزرسانی معوق');
    expect(by['s5']!.state, SchoolState.none);
    expect(by['s6']!.state, SchoolState.inactive);
    expect(
      [
        for (final s in ov.schools)
          if (s.attention) s.id,
      ],
      ['s3', 's4', 's5', 's6'],
    );
    expect(ov.activeSchools, 5);
    expect(ov.totalSchools, 6);
    expect(ov.newThisMonth, 1);
    expect(ov.users, 210);
    expect(ov.reporting, 4);
    expect(ov.hostsOnline, 3);
    expect(ov.revenueMonth, 25000000);
    expect(ov.revenuePrev, 20000000);
  });

  test('OwnerOverview.of: an empty registry gives calm zeroes', () {
    final ov = OwnerOverview.of(
      const SchoolsView(connected: true, rev: 0, plain: {}),
      now,
    );
    expect(ov.schools, isEmpty);
    expect((ov.users, ov.reporting, ov.revenueMonth), (0, 0, 0));
  });

  testWidgets('KPI cards: big number, small sub line and delta tone', (
    tester,
  ) async {
    final ov = OwnerOverview.of(view(), now);
    await _pump(
      tester,
      Wrap(
        children: [for (final k in ov.kpis()) SizedBox(width: 300, child: k)],
      ),
    );
    for (final k in [
      'metric-schools',
      'metric-users',
      'metric-revenue',
      'metric-health',
    ]) {
      expect(find.byKey(Key(k)), findsOneWidget, reason: k);
    }
    expect(find.text('مدارس فعال'), findsOneWidget);
    expect(find.text('+۱ این ماه'), findsOneWidget);
    expect(
      find.text('۲٫۵'),
      findsOneWidget,
      reason: '25,000,000 rials = 2.5 million toman',
    );
    expect(find.text('میلیون تومان · +۲۵٪'), findsOneWidget);
    expect(find.text('۷۵٪'), findsOneWidget, reason: '3 of 4 hosts fresh');
    expect(find.text('۳ از ۴ سرور وصل'), findsOneWidget);
  });

  testWidgets('KPI cards with no reports say so instead of zero health', (
    tester,
  ) async {
    final ov = OwnerOverview.of(
      const SchoolsView(connected: true, rev: 0, plain: {}),
      now,
    );
    await _pump(tester, Column(children: ov.kpis()), dark: true);
    expect(find.text('—'), findsOneWidget);
    expect(find.text('سروری گزارش نداده'), findsOneWidget);
    expect(find.text('هنوز گزارشی نرسیده'), findsOneWidget);
  });

  testWidgets('«مدارس» card: tabs filter, «مشاهدهٔ همه» opens the list', (
    tester,
  ) async {
    var opened = 0;
    final ov = OwnerOverview.of(view(), now);
    await _pump(
      tester,
      SchoolsOverviewCard(overview: ov, onOpenAll: () => opened++),
    );
    expect(find.byKey(const Key('dash-schools')), findsOneWidget);
    // max 5 rows
    expect(find.byKey(const Key('dash-school-s1')), findsOneWidget);
    expect(find.byKey(const Key('dash-school-s6')), findsNothing);
    expect(find.byKey(const Key('dash-school-state-s1')), findsOneWidget);
    expect(find.text('آنلاین'), findsOneWidget);
    expect(find.text('به‌روزرسانی معوق'), findsOneWidget);

    await tester.tap(find.byKey(const Key('dash-schools-tab-trial')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('dash-school-s2')), findsOneWidget);
    expect(find.byKey(const Key('dash-school-s1')), findsNothing);

    await tester.tap(find.byKey(const Key('dash-schools-tab-attention')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('dash-school-s1')), findsNothing);
    expect(find.byKey(const Key('dash-school-s3')), findsOneWidget);
    expect(find.byKey(const Key('dash-school-s6')), findsOneWidget);

    await tester.tap(find.byKey(const Key('dash-schools-tab-all')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('dash-school-s1')), findsOneWidget);

    await tester.tap(find.byKey(const Key('dash-schools-all')));
    expect(opened, 1);
  });

  testWidgets('«مدارس» card: empty registry and empty tab', (tester) async {
    final ov = OwnerOverview.of(
      const SchoolsView(connected: true, rev: 0, plain: {}),
      now,
    );
    await _pump(
      tester,
      SchoolsOverviewCard(overview: ov, onOpenAll: null),
      dark: true,
    );
    expect(find.byKey(const Key('dash-schools-empty')), findsOneWidget);
    await tester.tap(find.byKey(const Key('dash-schools-tab-trial')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('dash-schools-empty')), findsOneWidget);
  });

  testWidgets('DbLight.compact: dot + «دیتابیس» + state word; tap re-checks', (
    tester,
  ) async {
    var probes = 0;
    var reply = 'synced';
    final m = DbMonitor(
      probe: () async {
        probes++;
        return PlatformSync(state: reply);
      },
    );
    addTearDown(m.dispose);
    await _pump(tester, DbLight(monitor: m, compact: true));
    expect(find.text('دیتابیس'), findsOneWidget);
    expect(find.byKey(const Key('db-light-unknown')), findsOneWidget);
    await tester.tap(find.byKey(const Key('db-light')));
    await tester.pump();
    await tester.pump();
    expect(probes, 1);
    expect(find.text(' وصل'), findsOneWidget);
    reply = 'error';
    await tester.tap(find.byKey(const Key('db-light')));
    await tester.pump();
    await tester.pump();
    expect(find.text(' قطع'), findsOneWidget);
    reply = 'not_configured';
    await m.refresh();
    await tester.pump();
    expect(find.text(' تنظیم نشده'), findsOneWidget);
  });
}
