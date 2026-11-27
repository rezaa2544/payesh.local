// Row 197 (Q07 / F31, F32, F33) — the school type has a real effect on the manager's home:
// a public school (نمونه دولتی here) gets «هیئت امنا» and «کمک‌های مردمی» (voluntary only, no
// tuition), a غیرانتفاعی school gets «کمک‌ها و شهریه» and no board; changing the school row
// turns the tiles on and off without signing in again.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'nav_support.dart';
import 'school_support.dart';

/// The manager's sidebar entry of a page (the tile grid is the narrow home's).
Finder tile(String id) => navOf(id);

Future<void> openTile(WidgetTester tester, String id) async {
  await openPage(tester, id);
  await settle(tester);
}

void main() {
  testWidgets(
    'F197-W01 public school: board + voluntary contributions, no tuition',
    (tester) async {
      tallView(tester);
      final (_, s) = await bootSchool(
        tester,
        role: 'manager',
        seed: (s) async {
          await s.put('schools', 1, {
            'name': 'نمونه دولتی',
            'school_type': 'exemplary',
            // stale row from before 0.9.64: tuition on in a public school
            'capabilities': {'has_tuition': 1},
          });
          await s.put('users', 10, {'name': 'مدیر', 'role': 'manager'});
        },
      );
      await settle(tester);
      expect(tile('trustees'), findsOneWidget);
      expect(tile('contributions'), findsOneWidget);

      await openTile(tester, 'contributions');
      expect(find.byKey(const Key('fin-public-note')), findsOneWidget);
      expect(find.byKey(const Key('fin-empty')), findsOneWidget);
      await tester.tap(find.byKey(const Key('fin-add')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('fin-f-tuition')),
        findsNothing,
        reason: 'no tuition in a public school',
      );
      await tester.enterText(find.byKey(const Key('fin-f-payer')), 'ولی سارا');
      await tester.enterText(find.byKey(const Key('fin-f-amount')), '۵۰۰۰۰۰۰');
      await tester.enterText(
        find.byKey(const Key('fin-f-purpose')),
        'خرید پروژکتور',
      );
      await tester.tap(find.byKey(const Key('fin-save')));
      await settle(tester);
      final rows = await tester.runAsync(() => s.engine.list('contributions'));
      expect(rows!.single.data['kind'], 'voluntary');
      expect(rows.single.data['amount'], 5000000);
      expect(rows.single.data['payer'], 'ولی سارا');
      expect(
        textIn(tester, 'fin-row-${rows.single.id}'),
        contains('کمک داوطلبانه'),
      );

      await openTile(tester, 'trustees');
      await tester.tap(find.byKey(const Key('board-add-member')));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('board-f-name')),
        'آقای احمدی',
      );
      await tester.tap(find.byKey(const Key('board-save')));
      await settle(tester);
      await tester.tap(find.byKey(const Key('board-add-meeting')));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('board-f-title')),
        'جلسهٔ اول',
      );
      await tester.enterText(
        find.byKey(const Key('board-f-decisions')),
        'تعمیر سرویس بهداشتی از محل کمک‌ها',
      );
      await tester.tap(find.byKey(const Key('board-save')));
      await settle(tester);
      final b = await tester.runAsync(() => s.engine.list('trustees'));
      expect({for (final r in b!) r.data['kind']}, {'member', 'meeting'});
      expect(textIn(tester, 'board-count'), contains('۱ عضو'));
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'F197-W02 غیرانتفاعی: tuition on, no board; switching the type flips the tiles',
    (tester) async {
      tallView(tester);
      final (_, s) = await bootSchool(
        tester,
        role: 'manager',
        seed: (s) async {
          await s.put('schools', 1, {
            'name': 'غیرانتفاعی',
            'school_type': 'non_profit',
            'capabilities': {'has_tuition': 1},
          });
          await s.put('users', 10, {'name': 'مدیر', 'role': 'manager'});
        },
      );
      await settle(tester);
      expect(tile('trustees'), findsNothing);
      await openTile(tester, 'contributions');
      expect(find.byKey(const Key('fin-public-note')), findsNothing);
      await tester.tap(find.byKey(const Key('fin-add')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('fin-f-tuition')), findsOneWidget);
      await tester.tap(find.byKey(const Key('fin-f-tuition')));
      await tester.enterText(find.byKey(const Key('fin-f-payer')), 'ولی');
      await tester.enterText(
        find.byKey(const Key('fin-f-amount')),
        '300000000',
      );
      await tester.tap(find.byKey(const Key('fin-save')));
      await settle(tester);
      final rows = await tester.runAsync(() => s.engine.list('contributions'));
      expect(rows!.single.data['kind'], 'tuition');
      // the school becomes public (a sync brought the new row): the board appears
      await tester.runAsync(() async {
        await s.put('schools', 1, {
          'name': 'غیرانتفاعی',
          'school_type': 'governmental',
          'capabilities': {'has_tuition': 1},
        }, 2);
        s.bump.value++;
      });
      await settle(tester);
      expect(tile('trustees'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('F197-W03 teacher: neither tile', (tester) async {
    tallView(tester);
    await bootSchool(
      tester,
      role: 'teacher',
      seed: (s) async {
        await s.put('schools', 1, {'name': 'م', 'school_type': 'governmental'});
        await s.put('users', 10, {'name': 'دبیر', 'role': 'teacher'});
      },
    );
    await settle(tester);
    expect(tile('trustees'), findsNothing);
    expect(tile('contributions'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
}
