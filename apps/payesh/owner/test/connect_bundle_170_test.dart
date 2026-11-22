// Row 170 — automatic database connection («بستهٔ اتصال»): the owner panel publishes a bundle
// sealed with the manager's user name + password (and the owner's id + password + code); a fresh
// school server / owner panel opens it — no address or key typed, no key in any code (D-23).
// The same vectors as server/connect.js (docs/cloud/contracts/connect-vectors.json).
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/local/cloud_control.dart';
import 'package:payesh_owner/src/local/connect_bundle.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_owner/src/net/resilience.dart';
import 'package:payesh_owner/src/schools/school_registry.dart';
import 'package:payesh_secure/payesh_secure.dart';

import 'support/fake_bucket.dart';

/// payeshschool.ir only serves `connect.json` pointing at the bucket (the DNS «moved» case).
final class _Domain implements S3Transport {
  _Domain(this.inner, this.base);
  final S3Transport inner;
  final String base;

  @override
  Future<S3Response> send(
    String method,
    Uri url,
    Map<String, String> headers, [
    List<int>? body,
  ]) async {
    if (url.host == 'payeshschool.ir') {
      if (url.path == '/payesh/pub/connect.json') {
        return S3Response(200, jsonEncode({'v': 1, 'base': base}));
      }
      return const S3Response(404, '');
    }
    return inner.send(method, url, headers, body);
  }

  @override
  void close() {}
}

void main() {
  final vectors = jsonDecode(
    File('../../../docs/cloud/contracts/connect-vectors.json')
        .readAsStringSync(),
  ) as Map<String, Object?>;
  final clock = DateTime.utc(2026, 11, 22, 10);
  final db = S3Settings(
    endpoint: Uri.https('s3.example.test'),
    accessKey: 'AK-170',
    secretKey: 'SK-170',
    bucket: 'payesh-madrese',
  );

  setUpAll(() => s3RetryPolicy = RetryPolicy.none);
  tearDownAll(() => s3RetryPolicy = const RetryPolicy());
  setUp(EndpointRoutes.reset);

  test('CB-01 the shared vectors: path, PBKDF2 secret and envelope equal the server', () async {
    final rev = vectors['rev']! as int;
    final plain = vectors['plaintext']! as String;
    final nonce = [
      for (var i = 0; i < 24; i += 2)
        int.parse(
          (vectors['nonce_hex']! as String).substring(i, i + 2),
          radix: 16,
        ),
    ];
    expect(vectors['iterations'], connectIterations);
    for (final v
        in (vectors['vectors']! as List).cast<Map<String, Object?>>()) {
      final kind = v['kind'] as String, login = v['login'] as String;
      expect(connectNorm(login), v['norm']);
      expect(connectBundlePath(kind, login), v['path']);
      final secret = await connectSecret(
        kind,
        login,
        v['password'] as String,
        code: (v['code'] ?? '') as String,
      );
      expect(secret, v['secret_hex']);
      expect(
        await sealConnect(secret, rev, plain, nonce: nonce),
        v['envelope'],
      );
      expect(
        await openConnectText(
          secret,
          (v['envelope'] as Map).cast<String, Object?>(),
        ),
        plain,
      );
    }
    expect(
      connectBundlePath('school', '۰۹۱۲۰۰۰۱۷۰۱'),
      connectBundlePath('school', '09120001701'),
    );
  });

  test('CB-02 createSchool / resetManagerPassword publish the school bundle (public, no-cache); '
      'only the right password opens it', () async {
    final bucket = FakeBucket(() => clock);
    final secure = FakeSecureStore();
    await db.save(secure);
    final reg = SchoolRegistry(
      secure: secure,
      s3Factory: bucket.transport,
      now: () => clock,
      hashIterations: 1000,
    );
    final id = await reg.createSchool({
      'name': 'هنرستان اتصال خودکار',
      'code': '17017017',
      'province': 'تهران',
      'county': 'تهران',
      'manager': {
        'name': 'مدیر',
        'phone': '09120001701',
        'national_id': '0012345679',
        'username': 'rezaa170',
      },
    }, password: '0012345679');
    await reg.connectPublishing;
    expect(id, isNotEmpty);
    final base = connectBaseOf(db);
    for (final login in ['rezaa170', 'REZAA170', '09120001701']) {
      final key = '$connectPubDir${connectBundlePath('school', login)}';
      expect(bucket.text(key), isNotNull, reason: login);
      expect(bucket.putHeaders[key]?['x-amz-acl'], 'public-read');
      expect(bucket.putHeaders[key]?['cache-control'], 'no-cache');
      final env = await fetchConnectBundle(
        bucket.transport(),
        'school',
        login,
        bases: [base],
      );
      final s = await openConnect(
        await connectSecret('school', login, '0012345679'),
        env!,
      );
      expect(s?.secretKey, 'SK-170');
      expect(s?.bucket, 'payesh-madrese');
      expect(
        await openConnect(
          await connectSecret('school', login, 'wrong-pass'),
          env,
        ),
        isNull,
      );
    }
    final idx = jsonDecode(bucket.text('${connectPubDir}connect.json')!) as Map;
    expect(idx['base'], base);
    expect(idx['kind'], 'payesh-connect-index');
    // the plaintext is exactly the cloud-control plaintext the servers already accept
    final env = await fetchConnectBundle(
      bucket.transport(),
      'school',
      'rezaa170',
      bases: [base],
    );
    final text = await openConnectText(
      await connectSecret('school', 'rezaa170', '0012345679'),
      env!,
    );
    expect(text, controlPlaintext(db, env['rev']! as int));

    await reg.resetManagerPassword(id, 'Reset170x');
    await reg.connectPublishing;
    final env2 = await fetchConnectBundle(
      bucket.transport(),
      'school',
      'rezaa170',
      bases: [base],
    );
    expect(
      await openConnect(
        await connectSecret('school', 'rezaa170', 'Reset170x'),
        env2!,
      ),
      isNotNull,
    );
    expect(
      await openConnect(
        await connectSecret('school', 'rezaa170', '0012345679'),
        env2,
      ),
      isNull,
      reason: 'the old password no longer opens the bundle',
    );
  });

  test('CB-03 owner on a fresh device: discovered through the domain index (moved base) with '
      'login id + password + code only', () async {
    final bucket = FakeBucket(() => clock);
    await publishConnectBundle(
      s: db,
      t: bucket.transport(),
      kind: 'owner',
      login: 'Owner',
      password: 'Owner-pass-1',
      code: '123456',
      now: () => clock,
    );
    final t = _Domain(bucket.transport(), connectBaseOf(db));
    final found = await discoverOwnerDatabase(
      t,
      login: 'owner',
      password: 'Owner-pass-1',
      code: ' 123456 ',
      bases: const ['https://payeshschool.ir/payesh/pub/'],
    );
    expect(found?.sameTarget(db), isTrue);
    expect(
      await discoverOwnerDatabase(
        t,
        login: 'owner',
        password: 'Owner-pass-1',
        code: '654321',
        bases: const ['https://payeshschool.ir/payesh/pub/'],
      ),
      isNull,
    );
    // NEG: nothing published for another login
    expect(
      await fetchConnectBundle(
        t,
        'owner',
        'someone-else',
        bases: const ['https://payeshschool.ir/payesh/pub/'],
      ),
      isNull,
    );
  });
}
