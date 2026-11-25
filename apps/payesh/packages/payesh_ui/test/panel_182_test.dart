import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_ui/payesh_ui.dart';

/// Row 182: detail / edit pages open as a small panel on wide windows, a page on phones.
Widget _host(Size size, void Function(BuildContext) onTap) => MaterialApp(
  theme: PayeshUi.light(look: PayeshLook.minimal),
  home: Builder(
    builder: (context) => Scaffold(
      body: Center(
        child: TextButton(
          key: const Key('go'),
          onPressed: () => onTap(context),
          child: const Text('باز کن'),
        ),
      ),
    ),
  ),
);

class _Page extends StatelessWidget {
  const _Page();
  @override
  Widget build(BuildContext context) {
    final s = MediaQuery.sizeOf(context);
    return Scaffold(
      appBar: AppBar(title: const Text('کاربری — رضا احمدی')),
      body: Text(
        '${s.width.round()}x${s.height.round()}',
        key: const Key('size'),
      ),
    );
  }
}

void main() {
  Future<void> setSize(WidgetTester tester, Size size) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
  }

  testWidgets(
    'PN-01 wide window: a centred panel, ✕ instead of the back arrow',
    (tester) async {
      await setSize(tester, const Size(1500, 900));
      await tester.pumpWidget(
        _host(
          const Size(1500, 900),
          (c) => openPanel<void>(c, (_) => const _Page()),
        ),
      );
      await tester.tap(find.byKey(const Key('go')));
      await tester.pumpAndSettle();
      final panel = tester.getSize(find.byKey(const Key('panel')));
      expect(panel.width, kPanelWidth);
      expect(panel.height, lessThanOrEqualTo(kPanelMaxHeight));
      // the page sees the panel's size, not the window's
      expect(
        find.text('${kPanelWidth.round()}x${panel.height.round()}'),
        findsOneWidget,
      );
      expect(find.byType(CloseButton), findsOneWidget);
      expect(find.byType(BackButton), findsNothing);
      // a click outside keeps the panel (typed data is safe)
      await tester.tapAt(const Offset(20, 20));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('panel')), findsOneWidget);
      await tester.tap(find.byType(CloseButton));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('panel')), findsNothing);
      expect(find.byKey(const Key('go')), findsOneWidget);
    },
  );

  testWidgets('PN-02 phone: the usual full-screen page', (tester) async {
    await setSize(tester, const Size(400, 800));
    await tester.pumpWidget(
      _host(
        const Size(400, 800),
        (c) => openPanel<void>(c, (_) => const _Page()),
      ),
    );
    await tester.tap(find.byKey(const Key('go')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('panel')), findsNothing);
    expect(find.text('400x800'), findsOneWidget);
    expect(find.byType(BackButton), findsOneWidget);
  });

  testWidgets('PN-03 table panel is wider, never wider than the window', (
    tester,
  ) async {
    await setSize(tester, const Size(800, 700));
    await tester.pumpWidget(
      _host(
        const Size(800, 700),
        (c) => openPanel<void>(c, (_) => const _Page(), width: kPanelWideWidth),
      ),
    );
    await tester.tap(find.byKey(const Key('go')));
    await tester.pumpAndSettle();
    expect(tester.getSize(find.byKey(const Key('panel'))).width, 800 - 48);
  });

  testWidgets('PN-04 the panel returns the page result', (tester) async {
    await setSize(tester, const Size(1200, 800));
    bool? got;
    await tester.pumpWidget(
      _host(const Size(1200, 800), (c) async {
        got = await openPanel<bool>(
          c,
          (ctx) => Scaffold(
            body: TextButton(
              key: const Key('ok'),
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('تأیید'),
            ),
          ),
        );
      }),
    );
    await tester.tap(find.byKey(const Key('go')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('ok')));
    await tester.pumpAndSettle();
    expect(got, isTrue);
  });

  for (final wide in [true, false]) {
    testWidgets(
      'PN-05 the back button of a page: ✕ in a panel, the arrow on a phone '
      '(${wide ? 'wide' : 'phone'})',
      (tester) async {
        final size = wide ? const Size(1200, 800) : const Size(400, 800);
        await setSize(tester, size);
        await tester.pumpWidget(
          _host(
            size,
            (c) => openPanel<void>(
              c,
              (ctx) => Scaffold(
                appBar: AppBar(
                  automaticallyImplyLeading: false,
                  leading: IconButton(
                    key: const Key('own-back'),
                    tooltip: backOrCloseTooltip(ctx),
                    icon: backOrCloseIcon(ctx),
                    onPressed: () => Navigator.maybePop(ctx),
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.tap(find.byKey(const Key('go')));
        await tester.pumpAndSettle();
        expect(
          find.byKey(const Key('panel')),
          wide ? findsOneWidget : findsNothing,
        );
        expect(find.byIcon(Icons.close), wide ? findsOneWidget : findsNothing);
        expect(
          find.byType(BackButtonIcon),
          wide ? findsNothing : findsOneWidget,
        );
        expect(find.byTooltip(wide ? 'بستن' : 'بازگشت'), findsOneWidget);
        await tester.tap(find.byKey(const Key('own-back')));
        await tester.pumpAndSettle();
        expect(find.byKey(const Key('own-back')), findsNothing);
      },
    );
  }
}
