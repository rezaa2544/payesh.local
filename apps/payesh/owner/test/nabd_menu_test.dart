// ردیف ۱۵۱: منوی کارکردی پنل مالک + پوستهٔ کامل «نبض» (نوار کناری، کپسول تلفن،
// کارت قهرمان داشبورد).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/menu.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:payesh_ui/payesh_ui.dart';

Widget _host(Widget child) => MaterialApp(
  theme: PayeshUi.light(look: PayeshLook.nabd),
  home: Directionality(
    textDirection: TextDirection.rtl,
    child: Scaffold(body: child),
  ),
);

void main() {
  group('ownerMenu', () {
    test('هر صفحه دقیقاً یک بار و گروه‌ها به ترتیب کارکرد', () {
      final all = ownerMenu(local: localPageTitles.keys.toSet());
      final ids = [for (final m in all) m.id];
      expect(ids.toSet().length, ids.length, reason: 'بدون تکرار');
      // همهٔ صفحه‌های سروری (برابری با پنل وب) حاضرند
      for (final (id, _) in ownerPages) {
        expect(ids.where((x) => x == id).length, 1, reason: id);
      }
      // گروه‌ها پیوسته و به همان ترتیب ownerMenuGroups
      final groups = <String>[];
      for (final m in all) {
        if (groups.isEmpty || groups.last != m.group) groups.add(m.group);
      }
      expect(groups, [for (final g in ownerMenuGroups) g.id]);
      // جای درست هر صفحه
      String g(String id) => all.firstWhere((m) => m.id == id).group;
      expect(g('payments'), 'finance');
      expect(g('plans'), 'finance');
      expect(g('infra'), 'infra');
      expect(g('health'), 'infra');
      expect(g('schools'), 'people');
      expect(g('audit'), 'records');
      expect(g('settings'), 'system');
      for (final id in ids) {
        expect(ownerMenuIcons.containsKey(id), isTrue, reason: id);
      }
    });

    test('صفحه‌های محلی فقط وقتی در دسترس‌اند دیده می‌شوند', () {
      final ids = [for (final m in ownerMenu()) m.id];
      expect(ids, isNot(contains('payments')));
      expect(ids, isNot(contains('settings')));
      expect(ids, isNot(contains('support')));
      final withPay = [
        for (final m in ownerMenu(local: {'payments'})) m.id,
      ];
      expect(withPay.indexOf('payments'), withPay.indexOf('plans') + 1);
      expect(menuGroupTitle('finance'), 'مالی و اشتراک');
    });
  });

  testWidgets('NabdSideNav: عنوان گروه‌ها + مورد فعال با گرادیان', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final items = ownerMenu(local: {'payments', 'settings'});
    var picked = -1;
    await tester.pumpWidget(
      _host(
        Row(
          children: [
            NabdSideNav(
              items: items,
              selected: 0,
              extended: true,
              onSelected: (i) => picked = i,
            ),
            const Expanded(child: SizedBox()),
          ],
        ),
      ),
    );
    for (final g in ownerMenuGroups) {
      expect(find.byKey(Key('nav-group-${g.id}')), findsOneWidget);
    }
    final active = find.descendant(
      of: find.byKey(const Key('nav-dashboard')),
      matching: find.byWidgetPredicate(
        (w) =>
            w is Ink &&
            w.decoration is BoxDecoration &&
            (w.decoration! as BoxDecoration).gradient != null,
      ),
    );
    expect(active, findsOneWidget);
    final icon = tester.widget<Icon>(
      find.descendant(
        of: find.byKey(const Key('nav-dashboard')),
        matching: find.byType(Icon),
      ),
    );
    expect(icon.color, Colors.white);
    await tester.tap(find.byKey(const Key('nav-payments')));
    expect(items[picked].id, 'payments');
    expect(tester.takeException(), isNull);
  });

  testWidgets('NabdCapsuleBar: خانه‌های cap-* و «همهٔ بخش‌ها»', (tester) async {
    tester.view.physicalSize = const Size(400, 860);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final all = ownerMenu(local: {'payments'});
    final cap = [
      for (final m in all)
        if (const {'dashboard', 'schools', 'payments', 'infra'}.contains(m.id))
          m,
    ];
    String? picked;
    var more = 0;
    await tester.pumpWidget(
      _host(
        Align(
          alignment: Alignment.bottomCenter,
          child: NabdCapsuleBar(
            items: cap,
            selected: 'schools',
            onSelected: (id) => picked = id,
            onMore: () => more++,
          ),
        ),
      ),
    );
    for (final id in ['dashboard', 'schools', 'payments', 'infra']) {
      expect(find.byKey(Key('cap-$id')), findsOneWidget);
    }
    await tester.tap(find.byKey(const Key('cap-infra')));
    expect(picked, 'infra');
    await tester.tap(find.byKey(const Key('cap-more')));
    expect(more, 1);
    expect(find.text('همهٔ بخش‌ها'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('NabdHeroCard: مقدار و جزئیات', (tester) async {
    await tester.pumpWidget(
      _host(
        const NabdHeroCard(
          key: Key('nabd-hero'),
          title: 'نبض پلتفرم',
          value: 42,
          caption: 'کاربر فعال',
          icon: Icons.favorite_outline,
          details: ['۳ اشتراک', '۲ پلن'],
        ),
      ),
    );
    expect(
      tester.widget<Text>(find.byKey(const Key('nabd-hero-value'))).data,
      contains('۴۲'),
    );
    expect(find.text('۳ اشتراک'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
