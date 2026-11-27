// Row 198-U3 — «the phone owner panel asks to define servers»: the owner bundle (o-…) was only
// published at account creation / password login, and the PC owner panel keeps a persistent
// session, so the real bucket had NO payesh/pub/connect/ at all. The account bundle (a-…) is
// sealed with the stored account hashes ⇒ the PC publishes it while it is open, without the
// password; a fresh phone opens it with login id + password + code and re-salts its record so
// later starts connect with no password either. Still no database key in any code (D-23).
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/local/acct_connect.dart';
import 'package:payesh_owner/src/local/connect_bundle.dart';
import 'package:payesh_owner/src/local/local_account.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_owner/src/net/resilience.dart';
import 'package:payesh_secure/payesh_secure.dart';

import 'support/fake_bucket.dart';

Future<({List<int> pw, List<int> code})> _syncHasher(
  String pw,
  String code,
  List<int> salt,
  int it,
) async => LocalAccountRecord.hashesFor(pw, code, salt, it);

void main() {
  final clock = DateTime.utc(2026, 11, 27, 10);
  final db = S3Settings(
    endpoint: Uri.https('s3.example.test'),
    accessKey: 'AK-198',
    secretKey: 'SK-198',
    bucket: 'payesh-madrese',
  );
  const it = 1000; // fast; production records carry their own count (120 000)

  setUpAll(() => s3RetryPolicy = RetryPolicy.none);
  tearDownAll(() => s3RetryPolicy = const RetryPolicy());
  setUp(EndpointRoutes.reset);

  LocalAccountRecord pcRecord() => LocalAccountRecord.create(
    loginId: 'Owner',
    password: 'Owner-pass-1',
    code: '123456',
    iterations: it,
  );

  AcctConnector conn(SecureStore s, FakeBucket b) => AcctConnector(
    secure: s,
    transport: b.transport,
    bases: [connectBaseOf(db)],
    now: () => clock,
    hasher: _syncHasher,
  );

  test('AC-01 PC with database settings publishes a-… (public, no-cache) without the password; '
      'a second run writes nothing (no version churn, lesson of U1)', () async {
    final bucket = FakeBucket(() => clock);
    final pc = FakeSecureStore();
    final rec = pcRecord();
    expect(await conn(pc, bucket).publishIfChanged(db, rec), isTrue);
    final key = 'payesh/pub/${acctBundlePath('owner')}';
    expect(bucket.text(key), isNotNull);
    expect(bucket.putHeaders[key]?['x-amz-acl'], 'public-read');
    final env = jsonDecode(bucket.text(key)!) as Map<String, Object?>;
    expect(env['kind'], acctKind);
    // no key / secret in clear
    expect(bucket.text(key), isNot(contains('SK-198')));
    expect(bucket.text(key), isNot(contains('AK-198')));
    final puts = bucket.log.where((l) => l.startsWith('PUT')).length;
    // same process again → nothing; fresh process (mark stored) → one GET, no PUT
    expect(await conn(pc, bucket).publishIfChanged(db, rec), isFalse);
    expect(bucket.log.where((l) => l.startsWith('PUT')).length, puts);
    // settings changed → re-published
    final moved = S3Settings(
      endpoint: db.endpoint,
      accessKey: 'AK-2',
      secretKey: 'SK-2',
      bucket: db.bucket,
    );
    expect(await conn(pc, bucket).publishIfChanged(moved, rec), isTrue);
  });

  test('AC-02 fresh phone: login id + password + code ⇒ settings saved, record re-salted; '
      'next start connects with the record alone', () async {
    final bucket = FakeBucket(() => clock);
    await conn(FakeSecureStore(), bucket).publishIfChanged(db, pcRecord());

    final phone = FakeSecureStore();
    final rec = await conn(phone, bucket)
        .tryWithPassword('owner', 'Owner-pass-1', '123456');
    expect(rec, isNotNull);
    expect((await S3Settings.load(phone))?.sameTarget(db), isTrue);
    expect(rec!.verify('owner', 'Owner-pass-1', '123456'), isTrue);
    expect(
      LocalAccountRecord.decode((await phone.read(LocalAccountKeys.account))!)
          .salt,
      rec.salt,
    );
    // phone lost its settings (e.g. reset of DB only) → record alone is enough
    await S3Settings.clear(phone);
    expect(await conn(phone, bucket).tryWithRecord(rec), AcctOutcome.connected);
    expect((await S3Settings.load(phone))?.sameTarget(db), isTrue);
  });

  test('AC-03 NEG: wrong password/code opens nothing; another salt asks for one password login; '
      'no bundle ⇒ none', () async {
    final bucket = FakeBucket(() => clock);
    await conn(FakeSecureStore(), bucket).publishIfChanged(db, pcRecord());
    final phone = FakeSecureStore();
    expect(
      await conn(phone, bucket).tryWithPassword('owner', 'Owner-pass-1', '654321'),
      isNull,
    );
    expect(
      await conn(phone, bucket).tryWithPassword('owner', 'wrong-pass-9', '123456'),
      isNull,
    );
    expect(await S3Settings.load(phone), isNull);
    final own = LocalAccountRecord.create(
      loginId: 'owner',
      password: 'Owner-pass-1',
      code: '123456',
      iterations: it,
    );
    expect(await conn(phone, bucket).tryWithRecord(own), AcctOutcome.needsPassword);
    final other = LocalAccountRecord.create(
      loginId: 'someone',
      password: 'Owner-pass-1',
      code: '123456',
      iterations: it,
    );
    expect(await conn(phone, bucket).tryWithRecord(other), AcctOutcome.none);
  });
}
