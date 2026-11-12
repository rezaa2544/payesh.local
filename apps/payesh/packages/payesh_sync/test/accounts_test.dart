// Row 128 / W7 — local account rules + the LAN error mapping of the lock/claim endpoints.
import 'dart:math';

import 'package:payesh_secure/payesh_secure.dart';
import 'package:payesh_sync/payesh_sync.dart';
import 'package:test/test.dart';

void main() {
  test(
    'W7-U01 random password: 8 characters, no look-alikes, differs per call',
    () {
      final r = Random(7);
      final a = AccountRules.randomPassword(r);
      final b = AccountRules.randomPassword(r);
      expect(a, matches(RegExp(r'^[a-hjkmnp-z2-9]{8}$')));
      expect(a, isNot(b));
      for (var i = 0; i < 200; i++) {
        expect(
          AccountRules.randomPassword(r),
          isNot(matches(RegExp('[ilo01]'))),
        );
      }
    },
  );

  test('W7-U02 username = mobile, else a 10-digit national id, else none (server credentialsFor)', () {
    expect(
      AccountRules.usernameOf({
        'phone': '09121112233',
        'national_id': '0012345678',
      }),
      '09121112233',
    );
    expect(
      AccountRules.usernameOf({'phone': '', 'national_id': '0012345678'}),
      '0012345678',
    );
    expect(AccountRules.usernameOf({'national_id': '12345'}), '');
    expect(AccountRules.usernameOf({}), '');
  });

  test('W7-U03 NEG short password refused locally', () {
    expect(
      () => AccountRules.checkPassword('abc'),
      throwsA(
        isA<AccountFailure>().having(
          (f) => f.kind,
          'kind',
          AccountError.shortPassword,
        ),
      ),
    );
    AccountRules.checkPassword('abcd');
  });

  test('W7-U04 lock / claim errors: locked → wait with the server time, local_only → server only', () {
    final until = DateTime.now()
        .add(const Duration(minutes: 10))
        .toIso8601String();
    final l = mapLanError(429, {'error': 'locked', 'until': until}, null);
    expect(l.kind, LanAccessError.rateLimited);
    expect(l.retryAfter!.inSeconds, greaterThan(500));
    expect(
      mapLanError(403, {'error': 'local_only'}, null).kind,
      LanAccessError.setupLocalOnly,
    );
    expect(
      mapLanError(401, {'error': 'bad_credentials'}, null).kind,
      LanAccessError.badCredentials,
    );
  });

  test(
    'W7-U05 NEG claim to a non-loopback server is refused before any request',
    () async {
      final c = LanAccessClient();
      addTearDown(c.close);
      await expectLater(
        c.claim(
          server: Uri.parse('http://192.168.1.10:8080'),
          phone: '09120000128',
          password: 'x1234',
        ),
        throwsA(
          isA<LanAccessFailure>().having(
            (f) => f.kind,
            'kind',
            LanAccessError.setupLocalOnly,
          ),
        ),
      );
    },
  );

  test('W7-U06 lock flag: kept until cleared; sign-out clears it', () async {
    final store = FakeSecureStore();
    final s = LanAccountStore(store);
    expect(await s.isLocked(), isFalse);
    await s.setLocked(true);
    expect(await s.isLocked(), isTrue);
    await s.clear();
    expect(await s.isLocked(), isFalse);
  });
}
