// Row 185 — the owner app: the section cards of a page sit side by side in columns (no
// full-width card around two words), a section with a big table keeps the whole width, and a
// phone keeps one column.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/app.dart';
import 'package:payesh_owner/src/platform.dart';
import 'package:payesh_owner/src/widgets.dart';
import 'package:payesh_ui/payesh_ui.dart';

import 'support/fake_backend.dart';

Future<void> _open(WidgetTester tester, Size size) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    OwnerApp(
      store: MemorySettingsStore({'origin': 'https://owner.example.ir'}),
      httpFactory: () => FakeBackend(),
    ),
  );
  await tester.pumpAndSettle();
  await tester.enterText(find.byKey(const Key('login_id')), 'owner');
  await tester.enterText(find.byKey(const Key('password')), 'pw-owner-1');
  await tester.enterText(find.byKey(const Key('totp')), '123456');
  await tester.tap(find.byKey(const Key('login-submit')));
  await tester.pumpAndSettle();
}

Rect _card(WidgetTester tester, String title) => tester.getRect(
  find.ancestor(of: find.text(title), matching: find.byType(Card)).first,
);

void main() {
  testWidgets(
    'O185-01 «اپراتورها و مجوز» on a Windows window: small sections side by side, the users table full width',
    (tester) async {
      await _open(tester, const Size(1366, 860));
      await tester.tap(find.byKey(const Key('nav-operators')));
      await tester.pumpAndSettle();
      final grants = _card(tester, 'مجوزهای پشتیبانی');
      final reqs = _card(tester, 'درخواست‌های ثبت‌شده (از دفتر ممیزی)');
      final users = _card(tester, 'کاربران پلتفرم');
      expect(grants.top, reqs.top, reason: 'one row');
      expect(grants.left, greaterThan(reqs.left), reason: 'first on the right');
      expect(
        users.width,
        greaterThan(grants.width * 1.8),
        reason: 'table: wide',
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('O185-02 a phone keeps one column (NEG: no squeeze)', (
    tester,
  ) async {
    await _open(tester, const Size(400, 860));
    await tester.tap(find.byKey(const Key('cap-more')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('nav-operators')).last);
    await tester.pumpAndSettle();
    final grants = _card(tester, 'مجوزهای پشتیبانی');
    final users = _card(tester, 'کاربران پلتفرم');
    expect(grants.width, closeTo(users.width, 1));
    expect(tester.takeException(), isNull);
  });

  test(
    'O185-03 a section with a 4+ column table is wide, a short list is not',
    () {
      expect(
        ownerWideBlock(
          const PayeshSection(
            title: 't',
            child: OwnerTable(columns: ['a', 'b', 'c', 'd'], rows: []),
          ),
        ),
        isTrue,
      );
      expect(
        ownerWideBlock(
          const PayeshSection(
            title: 't',
            child: OwnerTable(columns: ['a', 'b'], rows: []),
          ),
        ),
        isFalse,
      );
      expect(ownerWideBlock(const SizedBox()), isTrue, reason: 'not a card');
    },
  );
}
