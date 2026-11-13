import 'dart:convert';
import 'dart:io';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/local/cloud_control.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_owner/src/net/resilience.dart';
import 'package:payesh_secure/payesh_secure.dart';

/// پیروی سرورهای مدرسه از دیتابیس پنل مالک: بردار مشترک با server/cloud-control.js،
/// درخواست‌های امضاشدهٔ PUT/List (برابر botocore) و رسیدها.

final class _S3 implements S3Transport {
  _S3(this.replies);
  final List<Object> replies;
  final calls = <(String, Uri, Map<String, String>, String?)>[];

  @override
  Future<S3Response> send(
    String method,
    Uri url,
    Map<String, String> headers, [
    List<int>? body,
  ]) async {
    calls.add((
      method,
      url,
      Map.of(headers),
      body == null ? null : utf8.decode(body),
    ));
    final r = replies.isEmpty ? const S3Response(500, '') : replies.removeAt(0);
    if (r is S3Response) return r;
    throw r;
  }

  @override
  void close() {}
}

Map<String, Object?> _vectors() => jsonDecode(
  File('../../../docs/cloud/contracts/cloud-control-vectors.json')
      .readAsStringSync(),
) as Map<String, Object?>;

List<int> _hex(String h) => [
  for (var i = 0; i < h.length; i += 2)
    int.parse(h.substring(i, i + 2), radix: 16),
];

String _toHex(List<int> b) =>
    b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

final _arvan = S3Settings(
  endpoint: normalizeS3Endpoint('s3.ir-central1.arvanstorage.ir')!,
  accessKey: 'AKIDEXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  bucket: 'payesh-madrese',
);
final _at = DateTime.utc(2026, 11, 12, 21, 5, 43);

void main() {
  // پاسخ‌های اسکریپتی: هر درخواست دقیقاً یک پاسخ (تلاش دوباره در resilience_test.dart)
  setUpAll(() => s3RetryPolicy = RetryPolicy.none);
  tearDownAll(() => s3RetryPolicy = const RetryPolicy());
  setUp(EndpointRoutes.reset);
  group('shared vector (Node server/cloud-control.js = Dart)', () {
    final v = _vectors();
    final secret = v['secret']! as String;
    final rev = v['rev']! as int;
    final env = (v['envelope']! as Map).cast<String, Object?>();

    test('HKDF key, byte-exact envelope, open', () async {
      expect(_toHex(await controlKey(secret)), v['key_hex']);
      final sealed = await sealControlText(
        secret,
        rev,
        v['plaintext']! as String,
        nonce: _hex(v['nonce_hex']! as String),
      );
      expect(sealed, env);
      expect(await openControlText(secret, env), v['plaintext']);
    });

    test('object name per access key (same kid as the server)', () {
      final kids = (v['kid_of_access_key']! as Map).cast<String, String>();
      expect(kids, isNotEmpty);
      kids.forEach((ak, kid) {
        expect(controlKid(ak), kid);
        expect(controlObjectKey(ak), 'payesh/control/cloud-$kid.json');
      });
    });

    test('the panel writes exactly the plaintext the server expects', () {
      final p = jsonDecode(v['plaintext']! as String) as Map<String, Object?>;
      final target = S3Settings(
        endpoint: normalizeS3Endpoint(p['endpoint']! as String)!,
        accessKey: p['accessKey']! as String,
        secretKey: p['secret']! as String,
        bucket: p['bucket']! as String,
      );
      expect(controlPlaintext(target, rev), v['plaintext']);
    });

    test('NEG: changed rev, wrong secret, bad envelope never open', () async {
      for (final f in (v['must_fail']! as List).cast<Map<String, Object?>>()) {
        await expectLater(
          openControlText(
            (f['secret'] as String?) ?? secret,
            (f['envelope']! as Map).cast<String, Object?>(),
          ),
          throwsA(isA<SecretBoxAuthenticationError>()),
          reason: f['why'] as String?,
        );
      }
      for (final bad in [
        {...env, 'v': 2},
        {...env, 'kind': 'x'},
        {...env, 'rev': 0},
        {...env, 'nonce': 'AA'},
        {...env, 'nonce': 'AAECAwQFBgcICQoL='},
        {...env, 'ct': 'AAAA'},
      ]) {
        await expectLater(openControlText(secret, bad), throwsFormatException);
      }
      expect(
        () => sealControlText(secret, 1, 'x', nonce: [1, 2]),
        throwsArgumentError,
      );
    });
  });

  group('signed requests (same signatures as botocore)', () {
    test('ListObjectsV2 with query', () async {
      final t = _S3([
        const S3Response(
          200,
          '<ListBucketResult><Contents><Key>payesh/control/ack/a&amp;b.json</Key>'
          '</Contents></ListBucketResult>',
        ),
      ]);
      final keys = await s3ListKeys(
        _arvan,
        t,
        ackPrefix,
        max: 50,
        now: () => _at,
      );
      expect(keys, ['payesh/control/ack/a&b.json']);
      final (m, url, h, _) = t.calls.single;
      expect(m, 'GET');
      expect(
        url.toString(),
        'https://s3.ir-central1.arvanstorage.ir/payesh-madrese?list-type=2&max-keys=50&prefix=payesh%2Fcontrol%2Fack%2F',
      );
      expect(
        h['authorization'],
        'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261112/ir-central1/s3/aws4_request, '
        'SignedHeaders=host;x-amz-content-sha256;x-amz-date, '
        'Signature=94f7dee7432be5de0ca2dd7e312bb02ee938bd9bc26484da5ec68d4df9b3a935',
      );
    });

    test('PUT JSON with body hash and content-type', () async {
      final t = _S3([const S3Response(200, '')]);
      await s3PutJson(
        _arvan,
        t,
        'payesh/control/cloud.json',
        '{"v":1}',
        now: () => _at,
      );
      final (m, url, h, body) = t.calls.single;
      expect(m, 'PUT');
      expect(url.path, '/payesh-madrese/payesh/control/cloud.json');
      expect(body, '{"v":1}');
      expect(h['content-type'], 'application/json; charset=utf-8');
      expect(
        h['authorization'],
        'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261112/ir-central1/s3/aws4_request, '
        'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, '
        'Signature=63b8f790b786f0421634a0c16e69cd0350a2423d242d85a5d4be3ea06e8f643d',
      );
    });

    test('GET: 404 ⇒ null; NoSuchBucket / errors ⇒ S3Failure', () async {
      final t = _S3([
        const S3Response(404, '<Error><Code>NoSuchKey</Code></Error>'),
        const S3Response(200, 'hello'),
        const S3Response(404, '<Error><Code>NoSuchBucket</Code></Error>'),
        const S3Response(404, '<Error><Code>NoSuchKey</Code></Error>'),
        const SocketException('down'),
      ]);
      expect(await s3GetText(_arvan, t, 'x'), isNull);
      expect(await s3GetText(_arvan, t, 'x'), 'hello');
      await expectLater(
        s3GetText(_arvan, t, 'x'),
        throwsA(
          isA<S3Failure>().having((e) => e.messageFa, 'm', contains('صندوقچه')),
        ),
      );
      await expectLater(
        s3PutJson(_arvan, t, 'x', '{}'),
        throwsA(isA<S3Failure>()),
      );
      await expectLater(
        s3ListKeys(_arvan, t, 'p'),
        throwsA(
          isA<S3Failure>().having(
            (e) => e.toString(),
            's',
            contains('اینترنت'),
          ),
        ),
      );
      expect(
        await s3ListKeys(_arvan, _S3([const S3Response(404, '')]), 'p'),
        isEmpty,
      );
    });
  });

  group('bucket helpers', () {
    test('pasted bucket URL, pick rule = school server rule, validation', () {
      expect(
        splitBucketHost(
          'https://payesh-madrese.s3.ir-central1.arvanstorage.ir',
        ),
        ('https://s3.ir-central1.arvanstorage.ir', 'payesh-madrese'),
      );
      expect(
        splitBucketHost('payesh-madrese.s3.ir-central1.arvanstorage.ir/'),
        ('https://s3.ir-central1.arvanstorage.ir', 'payesh-madrese'),
      );
      expect(splitBucketHost('s3.ir-central1.arvanstorage.ir'), isNull);
      expect(splitBucketHost(''), isNull);
      expect(splitBucketHost('http://[bad'), isNull);
      expect(pickBucket(const []), isNull);
      expect(pickBucket(const ['a-1', 'my-payesh', 'madrese']), 'my-payesh');
      expect(pickBucket(const ['a-1', 'school-x']), 'school-x');
      expect(pickBucket(const ['a-1', 'b-2']), 'a-1');
      String? v(String b) => validateS3Form(
        endpoint: 's3.ir-central1.arvanstorage.ir',
        accessKey: 'AKID',
        secretKey: 'SECRET',
        bucket: b,
      );
      expect(v(''), isNull);
      expect(v('payesh-madrese'), isNull);
      expect(v('Payesh'), contains('نام صندوقچه'));
      expect(v('-bad'), contains('نام صندوقچه'));
      final s = _arvan.withBucket('');
      expect(S3Settings.decode(s.encode())!.bucket, '');
      expect(S3Settings.decode(_arvan.encode())!.bucket, 'payesh-madrese');
      expect(
        S3Settings.decode(
          '{"v":1,"endpoint":"s3.ir-central1.arvanstorage.ir","access_key":"a",'
          '"secret_key":"b","bucket":"Bad_Name"}',
        ),
        isNull,
      );
      expect(_arvan.sameTarget(_arvan.withBucket('payesh-madrese')), isTrue);
      expect(_arvan.sameTarget(s), isFalse);
    });
  });

  group('publish + followers', () {
    final old = S3Settings(
      endpoint: normalizeS3Endpoint('s3.ir-northwest1.arvanstorage.ir')!,
      accessKey: 'AK-OLD',
      secretKey: 'SK-OLD',
      bucket: 'payesh-old',
    );

    test(
      'writes the new bucket and the old one (each sealed with its own key)',
      () async {
        final t = _S3([const S3Response(200, ''), const S3Response(200, '')]);
        final (r, warn) = await publishControl(
          target: _arvan,
          previous: old,
          transport: t,
          rev: 42,
        );
        expect(warn, isNull);
        expect(r.rev, 42);
        expect(r.buckets, ['payesh-madrese', 'payesh-old']);
        expect(t.calls[1].$2.host, 's3.ir-northwest1.arvanstorage.ir');
        expect(t.calls[1].$3['authorization'], contains('/ir-northwest1/s3/'));
        final inNew = jsonDecode(t.calls[0].$4!) as Map<String, Object?>;
        final inOld = jsonDecode(t.calls[1].$4!) as Map<String, Object?>;
        expect(
          await openControlText(_arvan.secretKey, inNew),
          contains('"rev":42'),
        );
        expect(
          jsonDecode(await openControlText('SK-OLD', inOld)),
          containsPair('bucket', 'payesh-madrese'),
        );
        for (final c in t.calls) {
          expect(c.$4, isNot(contains('SK-OLD')));
          expect(c.$4, isNot(contains(_arvan.secretKey)));
        }
      },
    );

    test('only the keys changed (same bucket) ⇒ two objects, neither overwrites the other', () async {
      final t = _S3([const S3Response(200, ''), const S3Response(200, '')]);
      final rotated = S3Settings(
        endpoint: _arvan.endpoint,
        accessKey: 'AK-ROTATED',
        secretKey: 'SK-ROTATED',
        bucket: _arvan.bucket,
      );
      final (r, w) = await publishControl(
        target: rotated,
        previous: _arvan,
        transport: t,
        rev: 9,
      );
      expect(w, isNull);
      expect(r.buckets, ['payesh-madrese', 'payesh-madrese']);
      expect(
        t.calls[0].$2.path,
        '/payesh-madrese/${controlObjectKey('AK-ROTATED')}',
      );
      expect(
        t.calls[1].$2.path,
        '/payesh-madrese/${controlObjectKey(_arvan.accessKey)}',
      );
      expect(t.calls[0].$2.path, isNot(t.calls[1].$2.path));
      final forOld = jsonDecode(t.calls[1].$4!) as Map<String, Object?>;
      expect(
        jsonDecode(await openControlText(_arvan.secretKey, forOld)),
        containsPair('accessKey', 'AK-ROTATED'),
      );
    });

    test(
      'same target ⇒ one write; old bucket refused ⇒ warning only',
      () async {
        final t = _S3([const S3Response(200, '')]);
        final (r, w) = await publishControl(
          target: _arvan,
          previous: _arvan,
          transport: t,
          rev: 1,
        );
        expect(r.buckets, ['payesh-madrese']);
        expect(w, isNull);
        final t2 = _S3([
          const S3Response(200, ''),
          const S3Response(
            403,
            '<Error><Code>InvalidAccessKeyId</Code></Error>',
          ),
        ]);
        final (r2, w2) = await publishControl(
          target: _arvan,
          previous: old,
          transport: t2,
          rev: 2,
        );
        expect(r2.buckets, ['payesh-madrese']);
        expect(w2, contains('payesh-old'));
        expect(w2, contains('Access Key'));
        await expectLater(
          publishControl(
            target: _arvan,
            transport: _S3([
              const S3Response(403, '<Error><Code>AccessDenied</Code></Error>'),
            ]),
            rev: 3,
          ),
          throwsA(isA<S3Failure>()),
        );
      },
    );

    test('followers: parsed, newest first, junk skipped', () async {
      final t = _S3([
        const S3Response(
          200,
          '<ListBucketResult>'
          '<Contents><Key>payesh/control/ack/a.json</Key></Contents>'
          '<Contents><Key>payesh/control/ack/b.json</Key></Contents>'
          '<Contents><Key>payesh/control/ack/c.json</Key></Contents>'
          '<Contents><Key>payesh/control/ack/gone.json</Key></Contents>'
          '<Contents><Key>payesh/control/ack/readme.txt</Key></Contents>'
          '</ListBucketResult>',
        ),
        const S3Response(
          200,
          '{"v":1,"server_id":"a","host":"PC-A","rev":5,"ok":true,"at":"2026-11-12T08:00:00Z","version":"0.9.2"}',
        ),
        const S3Response(
          200,
          '{"v":1,"server_id":"b","rev":6,"ok":false,"error":"x","at":"2026-11-12T09:00:00Z"}',
        ),
        const S3Response(200, 'not json'),
        const S3Response(404, '<Error><Code>NoSuchKey</Code></Error>'),
      ]);
      final f = await readFollowers(_arvan, t);
      expect(f.map((x) => x.id), ['b', 'a']);
      expect(f[0].host, '—');
      expect(f[0].ok, isFalse);
      expect(f[0].error, 'x');
      expect(f[1].version, '0.9.2');
      expect(Follower.fromJson('{"v":1,"server_id":1,"rev":1}'), isNull);
      expect(Follower.fromJson('[]'), isNull);
      final store = FakeSecureStore();
      expect(await loadPublishedRev(store), isNull);
      await store.write(ControlKeys.rev, '77');
      expect(await loadPublishedRev(store), 77);
    });
  });
}
