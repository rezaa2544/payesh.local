import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_app/src/app.dart';

void main() {
  testWidgets('app starts in Persian, right-to-left', (tester) async {
    await tester.pumpWidget(const PayeshApp());
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('home-title')), findsOneWidget);
    expect(find.text('sync-v1'), findsOneWidget);
    final ctx = tester.element(find.byKey(const Key('home-title')));
    expect(Directionality.of(ctx), TextDirection.rtl);
    expect(Localizations.localeOf(ctx).languageCode, 'fa');
  });
}
