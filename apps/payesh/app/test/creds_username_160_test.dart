// Row 160 — the manager sets each user's own user name (Latin or a 4–9 digit code) next to the
// mobile on «نام کاربری و رمز»; empty = the user signs in with the mobile again.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_ui/payesh_ui.dart';
import 'package:payesh_sync/payesh_sync.dart';

import 'accounts_wave7_test.dart' show openCreds, serverCreds, fieldText;
import 'school_support.dart';

void main() {
  testWidgets(
    'L160-W06 user name: NEG bad shape (no call), set Latin, set a code, clear = mobile',
    (tester) async {
      final acc = serverCreds();
      await openCreds(tester, 11, accounts: acc);
      expect(fieldText(tester, 'crd-phone'), '09120000011');
      expect(fieldText(tester, 'crd-username'), '');
      await typeKey(tester, 'crd-username', 'ab');
      await tapKey(tester, 'crd-save');
      expect(textOf(tester, 'crd-form-error'), AccountRules.usernameRuleFa);
      expect(acc.calls.where((c) => c.startsWith('set:')), isEmpty);

      await typeKey(tester, 'crd-username', ' Ali.Rezaei ');
      await tapKey(tester, 'crd-save');
      expect(acc.calls, contains('set:11:-:-:u=ali.rezaei'));
      expect(acc.calls.last, 'creds', reason: 'reloaded after the change');
      expect(textOf(tester, 'crd-notice'), 'نام کاربری «ali.rezaei» ثبت شد');
      expect(acc.creds[11]!.username, 'ali.rezaei');
      expect(fieldText(tester, 'crd-username'), 'ali.rezaei');
      expect(fieldText(tester, 'crd-phone'), '09120000011');

      await typeKey(tester, 'crd-username', '۸۰۰۱');
      await tapKey(tester, 'crd-save');
      expect(acc.calls, contains('set:11:-:-:u=8001'));

      await typeKey(tester, 'crd-username', '');
      await tapKey(tester, 'crd-save');
      expect(acc.calls, contains('set:11:-:-:u='));
      expect(textOf(tester, 'crd-notice'), 'نام کاربری = شمارهٔ همراه شد');
      expect(acc.creds[11]!.username, '09120000011');
    },
  );

  testWidgets(
    'L183-W01 «کاربری — نام» on a Windows window: a small panel whose boxes are '
    'standard-width — the mobile as wide as its digits, user name and password a normal size',
    (tester) async {
      tester.view.physicalSize = const Size(1568, 830);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await openCreds(tester, 11);
      expect(find.byKey(const Key('panel')), findsOneWidget);
      expect(tester.getSize(find.byKey(const Key('panel'))).width, kPanelWidth);
      Size box(String k) => tester.getSize(find.byKey(Key(k)));
      expect(box('crd-phone').width, kFieldDigits);
      expect(box('crd-username').width, kFieldText);
      expect(box('crd-password').width, kFieldText);
      expect(box('crd-save').width, kFieldText);
      // NEG: no box spans the panel any more
      for (final k in ['crd-phone', 'crd-username', 'crd-password']) {
        expect(box(k).width, lessThan(kPanelWidth - 100), reason: k);
      }
    },
  );
}
