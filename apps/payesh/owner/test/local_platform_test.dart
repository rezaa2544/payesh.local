import 'dart:convert';

import 'package:crypto/crypto.dart' as hash;
import 'package:flutter_test/flutter_test.dart';
import 'package:payesh_owner/src/local/cloud_control.dart';
import 'package:payesh_owner/src/local/local_platform.dart';
import 'package:payesh_owner/src/local/s3_client.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:payesh_secure/payesh_secure.dart';

/// صندوقچهٔ درون‌حافظه: PUT/GET/List روی مسیر `/<bucket>/<key>` (امضا را بررسی نمی‌کند).
final class MemBucket {
  final objects = <String, String>{};
  int puts = 0;
  bool down = false;

  /// این Access Key را مثل آروان با SignatureDoesNotMatch رد کن (کلید/Secret نادرست).
  String? deny;
}

final class MemS3 implements S3Transport {
  MemS3(this.b);
  final MemBucket b;

  @override
  Future<S3Response> send(
    String method,
    Uri url,
    Map<String, String> headers, [
    List<int>? body,
  ]) async {
    if (b.down) throw const S3Failure('down');
    final d = b.deny;
    if (d != null && '${headers['authorization']}'.contains('Credential=$d/')) {
      return const S3Response(
        403,
        '<Error><Code>SignatureDoesNotMatch</Code></Error>',
      );
    }
    final segs = url.pathSegments;
    if (segs.length == 1 && method == 'GET') {
      final prefix = url.queryParameters['prefix'] ?? '';
      final keys = b.objects.keys.where((k) => k.startsWith(prefix));
      return S3Response(
        200,
        '<ListBucketResult>${keys.map((k) => '<Key>$k</Key>').join()}</ListBucketResult>',
      );
    }
    final key = segs.skip(1).join('/');
    if (method == 'PUT') {
      b.objects[key] = utf8.decode(body!);
      b.puts++;
      return const S3Response(200, '');
    }
    final v = b.objects[key];
    return v == null ? const S3Response(404, '') : S3Response(200, v);
  }

  @override
  void close() {}
}

final _t0 = DateTime.utc(2026, 11, 13, 8);

S3Settings _s3({
  String secret = 'sk-test-0123456789',
  String access = 'ak-test-1',
}) => S3Settings(
  endpoint: normalizeS3Endpoint('s3.ir-central1.arvanstorage.ir')!,
  accessKey: access,
  secretKey: secret,
  bucket: 'payesh-madrese',
);

final class Device {
  Device(
    this.login, {
    MemBucket? bucket,
    FakeSecureStore? store,
    DateTime Function()? now,
    EndpointChecker? checker,
  }) : secure = store ?? FakeSecureStore(),
       bucket = bucket ?? MemBucket() {
    platform = LocalPlatform(
      secure: secure,
      s3Factory: () => MemS3(this.bucket),
      now: now ?? () => _t0,
      checker: checker,
    );
    api = OwnerApi(
      origin: Uri.parse('https://local.payesh.invalid'),
      http: platform,
      now: now ?? () => _t0,
    );
    api.restoreSession(platform.signIn(login));
  }
  final String login;
  final FakeSecureStore secure;
  final MemBucket bucket;
  late final LocalPlatform platform;
  late final OwnerApi api;
}

const _why = 'دلیل آزمایشی برای ثبت';

Future<String> _school(OwnerApi api, String slug) async {
  final r = await api.createSchool(
    provisionOpId: localOwnerSub('op-$slug'),
    slug: slug,
    displayName: 'هنرستان $slug',
    managerName: 'مدیر $slug',
    planCode: 'basic',
    reason: _why,
  );
  expect(r.ok, isTrue, reason: r.message);
  expect(r.status, 201);
  return '${r.object('tenant')!['tenant_id']}';
}

/// همان بازسازی زنجیرهٔ هش سرور.
String _stable(Object? v) {
  if (v is Map) {
    final keys = v.keys.map((k) => '$k').toList()..sort();
    return '{${keys.map((k) => '${jsonEncode(k)}:${_stable(v[k])}').join(',')}}';
  }
  if (v is List) return '[${v.map(_stable).join(',')}]';
  return jsonEncode(v);
}

void main() {
  group('local platform: every section works without a platform server', () {
    test('fresh install: seeded plan + this owner; dashboard counts', () async {
      final d = Device('rezaa254');
      final r = await d.api.dashboard();
      expect(r.ok, isTrue);
      expect(r.object('dashboard'), {
        'subscriptions': 0,
        'plans': 1,
        'active_users': 1,
        'open_grants': 0,
      });
      final users = (await d.api.platformUsers()).list('users');
      expect(users.single['login_id'], 'rezaa254');
      expect(users.single['role'], 'platform_owner');
      expect(users.single['id'], localOwnerSub('rezaa254'));
      final plan = (await d.api.plans()).list('plans').single;
      expect(plan['code'], 'basic');
      expect(plan['max_users'], isNull, reason: 'بدون سقف');
      expect(plan['storage_mb'], isNull, reason: 'بدون سقف');
      final h = await d.api.healthSummary();
      expect(h.body!['mode'], 'local');
      expect(h.body!['configured'], isTrue);
      expect((h.body!['database']! as Map)['state'], 'not_configured');
    });

    test('schools: create (idempotent), limits, suspend, renew', () async {
      final d = Device('rezaa254');
      final tid = await _school(d.api, 'school-12');
      final again = await d.api.createSchool(
        provisionOpId: localOwnerSub('op-school-12'),
        slug: 'school-12',
        displayName: 'هنرستان school-12',
        managerName: 'مدیر',
        planCode: 'basic',
        reason: _why,
      );
      expect(again.status, 200);
      expect(again.body!['idempotent'], isTrue);
      final dup = await d.api.createSchool(
        provisionOpId: localOwnerSub('op-other'),
        slug: 'school-12',
        displayName: 'هنرستان',
        managerName: 'مدیر',
        planCode: 'basic',
        reason: _why,
      );
      expect(dup.status, 409);
      final badPlan = await d.api.createSchool(
        provisionOpId: localOwnerSub('op-3'),
        slug: 'school-13',
        displayName: 'هنرستان',
        managerName: 'مدیر',
        planCode: 'gold',
        reason: _why,
      );
      expect(badPlan.status, 400);
      expect(badPlan.message, contains('پلن'));
      final short = await d.api.createSchool(
        provisionOpId: localOwnerSub('op-4'),
        slug: 'school-14',
        displayName: 'هنرستان',
        managerName: 'مدیر',
        planCode: 'basic',
        reason: 'کوتاه',
      );
      expect(short.body!['error'], 'reason_too_short');

      final t = (await d.api.tenants()).list('tenants').single;
      expect(t['tenant_id'], tid);
      expect(t['display_name'], 'هنرستان school-12');
      expect(t['slug'], 'school-12');
      expect(t['status'], 'active');
      final lim = (await d.api.limits(tid)).object('limits')!;
      expect(lim['max_users'], isNull);
      expect(lim['storage_bytes'], isNull);
      expect((await d.api.usage(tid)).body!['usage'], isNull);

      expect((await d.api.suspendTenant(tid, _why)).ok, isTrue);
      final sub = (await d.api.subscriptions()).list('subscriptions').single;
      expect(sub['status'], 'suspended');
      final r = await d.api.renew('${sub['id']}', _why, 60);
      expect(r.ok, isTrue);
      final after = (await d.api.subscriptions()).list('subscriptions').single;
      expect(after['status'], 'active');
      expect(
        DateTime.parse('${after['ends_at']}'),
        _t0.add(const Duration(days: 90)),
      );
      expect((await d.api.call('DELETE', '/tenants/$tid')).status, 403);
      expect((await d.api.call('GET', '/tenants/$tid/content')).status, 403);
    });

    test('plans + operators', () async {
      final d = Device('rezaa254');
      expect(
        (await d.api.createPlan(
          code: 'gold',
          name: 'طلایی',
          storageMb: 2048,
          reason: _why,
        )).status,
        201,
      );
      expect(
        (await d.api.createPlan(
          code: 'gold',
          name: 'طلایی',
          storageMb: 1,
          reason: _why,
        )).status,
        409,
      );
      expect(
        (await d.api.createPlan(
          code: 'Bad Code',
          name: 'x',
          storageMb: 1,
          reason: _why,
        )).status,
        400,
      );
      final tid = await _school(d.api, 'school-gold');
      expect(tid, isNotEmpty);
      expect((await d.api.plans()).list('plans').map((p) => p['code']), [
        'basic',
        'gold',
      ]);
      expect(
        (await d.api.createUser('ops-1', 'platform_operator', _why)).status,
        201,
      );
      expect(
        (await d.api.createUser('ops-1', 'platform_operator', _why)).status,
        409,
      );
      expect((await d.api.createUser('x', 'root', _why)).status, 400);
      expect((await d.api.platformUsers()).list('users'), hasLength(2));
      // مالک درخواست مجوز پشتیبانی نمی‌دهد (چهارچشم): فقط تأیید
      final g = await d.api.requestGrant(
        tenantId: tid,
        scope: 'metadata',
        caseRef: 'C-1',
        reason: _why,
        schoolNotifiedAt: _t0,
        startsAt: _t0.add(const Duration(hours: 1)),
        hours: 2,
      );
      expect(g.body!['error'], 'role_forbidden');
      expect((await d.api.supportGrants()).list('grants'), isEmpty);
    });

    test('audit: same hash chain as the server, newest first', () async {
      final d = Device('rezaa254');
      await _school(d.api, 'school-a');
      final events = (await d.api.audit()).list('events');
      expect(events.map((e) => e['action']), [
        'tenant.activate',
        'tenant.provision',
      ]);
      var prev = '00' * 32;
      for (final e in events.reversed) {
        expect(e['previous_hash'], prev);
        final payload = {
          for (final k in [
            'event_id',
            'actor_id',
            'actor_ref',
            'action',
            'subject_type',
            'subject_ref',
            'tenant_id',
            'reason',
            'details',
          ])
            k: e[k],
        };
        final bytes = [
          for (var i = 0; i < prev.length; i += 2)
            int.parse(prev.substring(i, i + 2), radix: 16),
          ...utf8.encode(_stable(payload)),
        ];
        expect(e['event_hash'], hash.sha256.convert(bytes).toString());
        expect(e['actor_ref'], 'rezaa254');
        prev = '${e['event_hash']}';
      }
    });

    test('kept on this device across restarts (no database)', () async {
      final store = FakeSecureStore();
      final a = Device('rezaa254', store: store);
      await _school(a.api, 'school-keep');
      expect(store.values[platformStateKey], contains('school-keep'));
      final b = Device('rezaa254', store: store);
      expect((await b.api.tenants()).list('tenants'), hasLength(1));
    });

    test(
      'tokens: none / foreign / expired ⇒ 401; login route is not a backdoor',
      () async {
        final d = Device('rezaa254');
        final other = Device('rezaa254');
        final api = OwnerApi(
          origin: Uri.parse('https://local.payesh.invalid'),
          http: d.platform,
          now: () => _t0,
        );
        expect((await api.dashboard()).status, 401);
        api.restoreSession(other.platform.signIn('rezaa254'));
        expect((await api.dashboard()).status, 401);
        final l = await api.login(
          loginId: 'rezaa254',
          password: 'x',
          totp: '123456',
        );
        expect(l.ok, isFalse);
        d.platform.signOut();
        expect((await d.api.dashboard()).status, 401);
      },
    );
  });

  group('deletion: four eyes + 24 h, across two owner devices', () {
    test(
      'requester cannot approve; second owner approves; delay; execute',
      () async {
        var now = _t0;
        final bucket = MemBucket();
        final a = Device('owner-a', bucket: bucket, now: () => now);
        final b = Device('owner-b', bucket: bucket, now: () => now);
        for (final d in [a, b]) {
          await _s3().save(d.secure);
        }
        final tid = await _school(a.api, 'school-del');
        expect(
          (await a.api.requestDeletion(tid, _why)).status,
          201,
          reason: 'request',
        );
        expect(
          (await a.api.requestDeletion(tid, _why)).status,
          409,
          reason: 'one open request',
        );
        final req = (await a.api.tenantDeletions()).list('requests').single;
        final rid = '${req['id']}';
        expect(
          (await a.api.approveDeletion(rid, _why)).body!['error'],
          'four_eyes_required',
        );
        // دستگاه دوم همان داده را از صندوقچه می‌بیند و تأیید می‌کند
        final seen = (await b.api.tenantDeletions()).list('requests');
        expect(seen.single['id'], rid);
        final ap = await b.api.approveDeletion(rid, _why);
        expect(ap.ok, isTrue, reason: ap.message);
        now = now.add(const Duration(hours: 2));
        final early = await a.api.executeDeletion(rid, _why);
        expect(early.status, 409);
        expect(early.body!['error'], 'deletion_delay_pending');
        now = now.add(const Duration(hours: 23));
        final ex = await a.api.executeDeletion(rid, _why);
        expect(ex.ok, isTrue, reason: ex.message);
        final row = ex.object('request')!;
        expect(row['status'], 'executed');
        expect(row['data_destroyed'], isFalse);
        expect(
          DateTime.parse('${row['retain_until']}'),
          now.add(const Duration(days: 180)),
        );
        final sub = (await b.api.subscriptions()).list('subscriptions').single;
        expect(sub['status'], 'canceled');
      },
    );

    test('cancel needs a reason; closed request cannot be approved', () async {
      final d = Device('owner-a');
      final tid = await _school(d.api, 'school-c');
      expect(
        (await d.api.requestDeletion(tid, _why)).body!['request'],
        isNotNull,
      );
      final rid =
          '${(await d.api.tenantDeletions()).list('requests').single['id']}';
      expect(
        (await d.api.cancelDeletion(rid, 'کوتاه')).body!['error'],
        'reason_too_short',
      );
      expect((await d.api.cancelDeletion(rid, _why)).ok, isTrue);
      expect(
        (await d.api.call('POST', '/tenants/$tid/deletion-request', {
          'reason': _why,
          'confirm_tenant_id': 'other',
        })).body!['error'],
        'confirm_mismatch',
      );
    });
  });

  group('infrastructure', () {
    test('register, refuse raw credentials, metrics, change + approve, checks + alerts', () async {
      var now = _t0;
      var up = false;
      final d = Device(
        'rezaa254',
        now: () => now,
        checker: (e) async => up
            ? const CheckOutcome(ok: true, latencyMs: 12, statusCode: 200)
            : const CheckOutcome(ok: false, errorCode: 'connection_refused'),
      );
      final raw = await d.api.call('POST', '/infra/providers', {
        'code': 'arvan',
        'display_name': 'آروان',
        'kind': 'storage',
        'secret_key': 'abc',
        'reason': _why,
      });
      expect(raw.body!['error'], 'credentials_not_accepted');
      expect(
        (await d.api.infraAddProvider(
          code: 'arvan',
          displayName: 'آروان',
          kind: 'storage',
          credentialRef: 'plain',
          reason: _why,
        )).body!['error'],
        'credential_must_be_reference',
      );
      final p = await d.api.infraAddProvider(
        code: 'arvan',
        displayName: 'آروان',
        kind: 'storage',
        credentialRef: 'secret:ARVAN_KEY',
        reason: _why,
      );
      expect(p.status, 201);
      final pid = '${p.object('provider')!['id']}';
      final s = await d.api.infraAddService(
        providerId: pid,
        name: 'payesh-madrese',
        kind: 'storage',
        region: 'ir-central1',
        reason: _why,
      );
      final sid = '${s.object('service')!['id']}';
      expect(
        (await d.api.infraAddEndpoint(
          serviceId: sid,
          url: 'https://u:p@x.ir',
          checkKind: 'http',
          reason: _why,
        )).body!['error'],
        'invalid_endpoint',
      );
      final e = await d.api.infraAddEndpoint(
        serviceId: sid,
        url: 'https://s3.ir-central1.arvanstorage.ir/',
        checkKind: 'http',
        reason: _why,
      );
      final eid = '${e.object('endpoint')!['id']}';
      expect(
        (await d.api.infraRecordMetric(
          serviceId: sid,
          metric: 'usage_disk',
          unit: 'gb',
          value: 3,
          label: 'X',
          reason: _why,
        )).body!['error'],
        'label_required',
      );
      expect(
        (await d.api.infraRecordMetric(
          serviceId: sid,
          metric: 'usage_disk',
          unit: 'gb',
          value: 3,
          reason: _why,
        )).status,
        201,
      );
      var inf = await d.api.infra();
      final svc = inf.list('services').single;
      final m = (svc['metrics']! as Map)['usage_disk'] as Map;
      expect(m['value'], 3);
      expect(m['label'], 'M');
      expect(((svc['metrics']! as Map)['usage_cpu'] as Map)['label'], '?');
      expect(inf.list('providers').single['credential'], 'reference');
      expect(
        inf.list('endpoints').single['health'],
        containsPair('state', 'unknown'),
      );

      for (var i = 0; i < 3; i++) {
        final c = await d.api.infraCheck(eid);
        expect(c.ok, isTrue);
        expect((c.body!['check']! as Map)['ok'], isFalse);
        if (i < 2) {
          expect(
            (await d.api.infraCheck(eid)).body!['error'],
            'check_cooldown',
          );
        }
        now = now.add(const Duration(seconds: 31));
      }
      inf = await d.api.infra();
      expect(inf.list('open_alerts').single['kind'], 'endpoint_down');
      expect(
        inf.list('endpoints').single['health'],
        containsPair('state', 'down'),
      );
      up = true;
      final ok = await d.api.infraCheck(eid);
      expect((ok.body!['alert']! as Map)['closed'], isNotNull);
      expect((await d.api.infra()).list('open_alerts'), isEmpty);

      final ch = await d.api.infraRequestChange(
        action: 'disable_provider',
        targetId: pid,
        reason: _why,
      );
      expect(ch.status, 201);
      final cid = '${ch.object('change')!['id']}';
      expect((await d.api.infraApprove(cid, _why)).ok, isTrue);
      expect((await d.api.infraApprove(cid, _why)).status, 403);
      expect(
        (await d.api.infra()).list('providers').single['status'],
        'disabled',
      );
      final actions = (await d.api.audit())
          .list('events')
          .map((x) => x['action'])
          .toSet();
      expect(
        actions,
        containsAll([
          'infra.provider.register',
          'infra.alert.open',
          'infra.alert.close',
          'infra.change.approve',
        ]),
      );
    });
  });

  group('database (Arvan bucket): everything is kept there, sealed', () {
    test(
      'write sealed, second device reads the same, health shows synced',
      () async {
        final bucket = MemBucket();
        final a = Device('rezaa254', bucket: bucket);
        await _s3().save(a.secure);
        await _school(a.api, 'school-cloud');
        final key = platformObjectKey('ak-test-1');
        expect(key, startsWith('payesh/platform/state-'));
        final env = jsonDecode(bucket.objects[key]!) as Map<String, Object?>;
        expect(env['kind'], platformStateKind);
        expect(bucket.objects[key], isNot(contains('school-cloud')));
        final clear = await openBox(
          secret: 'sk-test-0123456789',
          salt: platformStateSalt,
          kind: platformStateKind,
          env: env,
        );
        expect(clear, contains('school-cloud'));

        final b = Device('rezaa254', bucket: bucket);
        await _s3().save(b.secure);
        final t = (await b.api.tenants()).list('tenants');
        expect(t.single['slug'], 'school-cloud');
        final h = await b.api.healthSummary();
        final db = h.body!['database']! as Map;
        expect(db['state'], 'synced');
        expect(db['bucket'], 'payesh-madrese');
        expect(h.body!['school_servers'], 0);
      },
    );

    test('database connected later: existing data is uploaded', () async {
      var now = _t0;
      final bucket = MemBucket();
      final a = Device('rezaa254', bucket: bucket, now: () => now);
      await _school(a.api, 'school-later');
      expect(bucket.puts, 0);
      await _s3().save(a.secure);
      now = now.add(const Duration(seconds: 20));
      await a.api.dashboard();
      expect(bucket.objects[platformObjectKey('ak-test-1')], isNotNull);
      final s = await a.platform.syncNow();
      expect(s.state, 'synced');
    });

    test('wrong key / unreachable: error is shown, data still works locally, nothing overwritten', () async {
      final bucket = MemBucket();
      final a = Device('rezaa254', bucket: bucket);
      await _s3().save(a.secure);
      await _school(a.api, 'school-x');
      final before = bucket.objects[platformObjectKey('ak-test-1')];
      bucket.deny = 'ak-bad';
      final b = Device('rezaa254', bucket: bucket);
      await _s3(access: 'ak-bad').save(b.secure);
      final h = await b.api.healthSummary();
      final db = h.body!['database']! as Map;
      expect(db['state'], 'error');
      expect('${db['error']}', isNotEmpty);
      final puts = bucket.puts;
      await _school(b.api, 'school-offline');
      expect(bucket.puts, puts, reason: 'بدون خواندن موفق، چیزی نوشته نمی‌شود');
      expect(bucket.objects[platformObjectKey('ak-test-1')], before);
      bucket.down = true;
      final c = Device('rezaa254', bucket: bucket);
      await _s3().save(c.secure);
      expect((await c.api.dashboard()).ok, isTrue);
      expect(
        ((await c.api.healthSummary()).body!['database']! as Map)['state'],
        'error',
      );
    });
  });

  test(
    'envelope sealed with an earlier secret of the same key is replaced',
    () async {
      final bucket = MemBucket();
      bucket.objects[platformObjectKey('ak-test-1')] = jsonEncode(
        await sealBox(
          secret: 'sk-old-secret-000',
          salt: platformStateSalt,
          kind: platformStateKind,
          rev: 5,
          plaintext: '{"v":1,"rev":5}',
        ),
      );
      final a = Device('rezaa254', bucket: bucket);
      await _s3().save(a.secure);
      await _school(a.api, 'school-new-secret');
      final env = jsonDecode(
        bucket.objects[platformObjectKey('ak-test-1')]!,
      ) as Map<String, Object?>;
      expect(
        await openBox(
          secret: 'sk-test-0123456789',
          salt: platformStateSalt,
          kind: platformStateKind,
          env: env,
        ),
        contains('school-new-secret'),
      );
    },
  );

  test('owner id is stable per login id (same on every device)', () {
    expect(localOwnerSub('rezaa254'), localOwnerSub(' rezaa254 '));
    expect(localOwnerSub('rezaa254'), isNot(localOwnerSub('other')));
    expect(
      RegExp(
        r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      ).hasMatch(localOwnerSub('rezaa254')),
      isTrue,
    );
    expect(controlKid('ak-test-1'), hasLength(16));
  });
}
