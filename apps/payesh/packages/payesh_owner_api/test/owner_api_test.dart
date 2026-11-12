import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:test/test.dart';

import 'support/fake_http.dart';

void main() {
  group('normalizeOrigin (same policy as the retired WebView shells)', () {
    test('https origins are accepted and normalised', () {
      expect(
        normalizeOrigin(' https://Owner.Example.ir/ ').toString(),
        'https://owner.example.ir',
      );
      expect(
        normalizeOrigin('https://a.ir:8443').toString(),
        'https://a.ir:8443',
      );
      expect(normalizeOrigin('https://a.ir:443').toString(), 'https://a.ir');
    });
    test('http only on loopback', () {
      expect(
        normalizeOrigin('http://127.0.0.1:8095').toString(),
        'http://127.0.0.1:8095',
      );
      expect(
        normalizeOrigin('http://localhost').toString(),
        'http://localhost',
      );
      expect(normalizeOrigin('http://owner.example.ir'), isNull);
      expect(normalizeOrigin('http://192.168.1.10:8095'), isNull);
    });
    test('paths, queries, fragments, user-info and junk are refused', () {
      for (final bad in [
        null,
        '',
        'owner.example.ir',
        'ftp://a.ir',
        'https://a.ir/panel',
        'https://a.ir/?x=1',
        'https://a.ir/#x',
        'https://u:p@a.ir',
        'https://${'a' * 270}.ir',
        'javascript:alert(1)',
        'file:///etc/passwd',
      ]) {
        expect(normalizeOrigin(bad), isNull, reason: '$bad');
      }
    });
  });

  group('OwnerClaims.decode (display only, fail closed)', () {
    test('valid token → role + caps', () {
      final c = OwnerClaims.decode(fakeToken(role: 'platform_operator'))!;
      expect(c.role, OwnerRole.operator);
      expect(OwnerCaps.of(c.role).renew, isFalse);
      expect(OwnerCaps.of(c.role).suspend, isTrue);
    });
    test(
      'expired, wrong type/version, unknown role, bad sub, bad shape → null',
      () {
        final past = DateTime.now().subtract(const Duration(minutes: 1));
        for (final t in [
          fakeToken(exp: past.millisecondsSinceEpoch),
          fakeToken(typ: 'school'),
          fakeToken(v: 2),
          fakeToken(role: 'manager'),
          fakeToken(sub: 'not-a-uuid'),
          'v1.abc.def',
          'platform.v1.%%%.sig',
          'platform.v1.bm90LWpzb24.sig',
          '',
        ]) {
          expect(OwnerClaims.decode(t), isNull, reason: t);
        }
      },
    );
  });

  group('OwnerCaps', () {
    test('owner/operator/support match the server role model', () {
      expect(OwnerCaps.of(OwnerRole.owner).granted, [
        'renew',
        'deleteRequest',
        'createPlan',
        'suspend',
        'approveGrant',
        'revokeGrant',
        'createUser',
        'createSchool',
        'infraRegister',
        'infraCheck',
        'infraRequestChange',
        'infraApprove',
      ]);
      expect(OwnerCaps.of(OwnerRole.support).granted, ['requestGrant']);
      expect(OwnerCaps.of(null).granted, isEmpty);
      expect(roleLabel('platform_support'), 'پشتیبان فنی');
      expect(roleLabel('x'), 'x');
    });
  });

  group('rules + formatting', () {
    test('digits, numbers, bytes, ids', () {
      expect(normDigits('۱۲۳٤٥6'), '123456');
      expect(faNum(1234567), '۱٬۲۳۴٬۵۶۷');
      expect(faNum(null), '—');
      expect(faNum(''), '—');
      expect(faNum('abc'), 'abc');
      expect(faNum(-12), '−۱۲');
      expect(faNum(1.25), '۱٫۲۵');
      expect(faBytes(512), '۵۱۲ بایت');
      expect(faBytes(1536), '۱٫۵ کیلوبایت');
      expect(faBytes(268435456), '۲۵۶ مگابایت');
      expect(faBytes(1073741824), '۱ گیگابایت');
      expect(faBytes(null), '—');
      expect(shortId('8e5500a4-7826-46c1'), '8e5500a4');
      expect(shortId(null), '—');
      expect(requestId(), matches(RegExp(r'^[0-9a-f-]{36}$')));
    });
    test('credential references only', () {
      expect(credentialError(''), isNull);
      expect(credentialError('secret:RADCLOUD_API_TOKEN'), isNull);
      expect(credentialError('hunter2'), isNotNull);
      expect(credentialError('secret:lower'), isNotNull);
      expect(credentialError('Bearer abc'), isNotNull);
    });
    test('endpoint validation', () {
      expect(
        endpointError('https://gw.example.ir/healthz', 'http', ''),
        isNull,
      );
      expect(endpointError('tcp://db.example.ir:5432', 'tcp', ''), isNull);
      expect(endpointError('https://u:p@x.ir', 'http', ''), contains('رمز'));
      expect(endpointError('gw.example.ir', 'http', ''), isNotNull);
      expect(endpointError('https://x.ir', 'tcp', ''), contains('هم‌خوان'));
      expect(endpointError('https://x.ir', 'http', '۲۰۰'), isNull);
      expect(endpointError('https://x.ir', 'http', '42'), isNotNull);
    });
    test('support grant validation', () {
      final now = DateTime.utc(2026, 11, 12, 10);
      String? v({
        String t = '11111111-2222-4333-8444-555555555555',
        String c = 'C-1',
        DateTime? n,
        DateTime? s,
        num h = 4,
      }) => supportGrantError(
        tenantId: t,
        caseRef: c,
        notified: n ?? now,
        starts: s ?? now.add(const Duration(hours: 1)),
        hours: h,
      );
      expect(v(), isNull);
      expect(v(t: 'x'), contains('مدرسه'));
      expect(v(c: ''), contains('پرونده'));
      expect(v(s: now), contains('پیش از'));
      expect(v(h: 73), contains('۷۲'));
      expect(v(h: 0), isNotNull);
      expect(
        supportGrantError(
          tenantId: '11111111-2222-4333-8444-555555555555',
          caseRef: 'c',
          notified: null,
          starts: now,
          hours: 1,
        ),
        isNotNull,
      );
    });
    test('status labels, audit chain, report', () {
      expect(statusLabel('suspended'), ('تعلیق', 'bad'));
      expect(statusLabel('weird'), ('weird', ''));
      expect(statusLabel(null).$1, '—');
      final ok = [
        {'sequence_id': 3, 'previous_hash': 'h2', 'event_hash': 'h3'},
        {'sequence_id': 2, 'previous_hash': 'h1', 'event_hash': 'h2'},
        {'sequence_id': 1, 'previous_hash': null, 'event_hash': 'h1'},
      ];
      expect(auditChainBreaks(ok), 0);
      final bad = [
        {'sequence_id': 3, 'previous_hash': 'XX', 'event_hash': 'h3'},
        ...ok.skip(1),
      ];
      expect(auditChainBreaks(bad), 1);
      final r = subscriptionReport([
        {'status': 'active', 'plan_code': 'basic'},
        {'status': 'active', 'plan_code': 'pro'},
        {'status': 'suspended', 'plan_code': 'basic'},
      ]);
      expect(r.byStatus, {'active': 2, 'suspended': 1});
      expect(r.byPlan, {'basic': 2, 'pro': 1});
    });
  });

  group('errorText', () {
    test('server code, client kind, status fallback, detail', () {
      expect(
        errorText(status: 403, body: {'error': 'four_eyes_required'}),
        ownerErrors['four_eyes_required'],
      );
      expect(errorText(kind: 'network'), ownerErrors['network']);
      expect(errorText(status: 418), 'خطا (۴۱۸)');
      expect(
        errorText(
          status: 400,
          body: {'error': 'invalid_input', 'detail': 'slug'},
        ),
        '${ownerErrors['invalid_input']} — slug',
      );
    });
  });

  group('OwnerApi over a fake transport', () {
    final origin = normalizeOrigin('https://owner.example.ir')!;

    test('login: client-side checks before any request', () async {
      final http = FakeOwnerHttp((_) => jsonRes(200, {'ok': true}));
      final api = OwnerApi(origin: origin, http: http);
      expect(
        (await api.login(loginId: ' ', password: 'x', totp: '123456')).error,
        'شناسه و رمز را وارد کنید.',
      );
      expect(
        (await api.login(loginId: 'a', password: 'x', totp: '12345')).error,
        'کد دومرحله‌ای باید ۶ رقم باشد.',
      );
      expect(http.sent, isEmpty);
    });

    test(
      'login: Persian digits normalised, token kept in memory, Bearer sent',
      () async {
        final tok = fakeToken();
        final http = FakeOwnerHttp(
          (s) => s.url.path.endsWith('/auth/login')
              ? jsonRes(200, {'ok': true, 'token': tok})
              : jsonRes(200, {
                  'ok': true,
                  'dashboard': {'plans': 1},
                }),
        );
        final api = OwnerApi(origin: origin, http: http);
        final r = await api.login(
          loginId: ' owner ',
          password: 'pw',
          totp: '۱۲۳۴۵۶',
        );
        expect(r.ok, isTrue);
        expect(api.session!.role, OwnerRole.owner);
        final login = http.sent.single;
        expect(
          login.url.toString(),
          'https://owner.example.ir/api/platform/v1/auth/login',
        );
        expect(login.json, {
          'login_id': 'owner',
          'password': 'pw',
          'totp': '123456',
        });
        expect(login.headers.containsKey('authorization'), isFalse);
        expect(
          login.headers['x-request-id'],
          matches(RegExp(r'^[0-9a-f-]{36}$')),
        );
        final d = await api.dashboard();
        expect(d.ok, isTrue);
        expect(d.object('dashboard'), {'plans': 1});
        expect(http.sent.last.headers['authorization'], 'Bearer $tok');
        expect(http.sent.last.body, isNull);
      },
    );

    test('login failures map to the panel texts', () async {
      Future<String?> fail(OwnerHttpResponse res) async {
        final api = OwnerApi(origin: origin, http: FakeOwnerHttp((_) => res));
        final r = await api.login(loginId: 'a', password: 'b', totp: '123456');
        expect(api.session, isNull);
        return r.error;
      }

      expect(
        await fail(jsonRes(401, {'ok': false, 'error': 'login_failed'})),
        ownerErrors['login_failed'],
      );
      expect(
        await fail(jsonRes(501, {'ok': false})),
        ownerErrors['login_unavailable'],
      );
      expect(
        await fail(jsonRes(404, {'ok': false})),
        ownerErrors['login_unavailable'],
      );
      expect(
        await fail(jsonRes(200, {'ok': true, 'token': 'garbage'})),
        ownerErrors['bad_response'],
      );
      expect(
        await fail(jsonRes(429, {'ok': false, 'error': 'rate_limited'})),
        ownerErrors['rate_limited'],
      );
      expect(
        await fail(const OwnerHttpResponse(502, 'text/html', '<html>')),
        ownerErrors['bad_response'],
      );
    });

    test('non-JSON, broken JSON and network errors', () async {
      final api1 = OwnerApi(
        origin: origin,
        http: FakeOwnerHttp(
          (_) => const OwnerHttpResponse(200, 'text/html', '<html>'),
        ),
      );
      final r1 = await api1.tenants();
      expect((r1.ok, r1.kind), (false, 'bad_response'));
      final api2 = OwnerApi(
        origin: origin,
        http: FakeOwnerHttp(
          (_) => const OwnerHttpResponse(200, 'application/json', '{'),
        ),
      );
      expect((await api2.tenants()).kind, 'bad_response');
      final api3 = OwnerApi(
        origin: origin,
        http: FakeOwnerHttp((_) => throw const OwnerNetworkException('down')),
      );
      final r3 = await api3.tenants();
      expect(
        (r3.ok, r3.status, r3.message),
        (false, 0, ownerErrors['network']),
      );
      final api4 = OwnerApi(
        origin: origin,
        http: FakeOwnerHttp(
          (_) => jsonRes(200, {'ok': false, 'error': 'forbidden'}),
        ),
      );
      expect((await api4.plans()).ok, isFalse);
      expect(r1.list('tenants'), isEmpty);
    });

    test('401 on an authenticated call drops the session once', () async {
      var calls = 0;
      final http = FakeOwnerHttp(
        (s) => s.url.path.endsWith('/auth/login')
            ? jsonRes(200, {'ok': true, 'token': fakeToken()})
            : jsonRes(401, {'ok': false, 'error': 'unauthorized'}),
      );
      final api = OwnerApi(
        origin: origin,
        http: http,
        onUnauthorized: () => calls++,
      );
      await api.login(loginId: 'a', password: 'b', totp: '000000');
      expect(api.session, isNotNull);
      final r = await api.audit();
      expect(r.status, 401);
      expect(api.session, isNull);
      expect(calls, 1);
      await api.audit();
      expect(calls, 1, reason: 'no session ⇒ no second sign-out');
    });

    test('expired session is dropped locally', () async {
      var now = DateTime.now();
      final tok = fakeToken(
        exp: now.add(const Duration(minutes: 5)).millisecondsSinceEpoch,
      );
      final api = OwnerApi(
        origin: origin,
        http: FakeOwnerHttp((_) => jsonRes(200, {'ok': true, 'token': tok})),
        now: () => now,
      );
      await api.login(loginId: 'a', password: 'b', totp: '000000');
      expect(api.session, isNotNull);
      now = now.add(const Duration(minutes: 6));
      expect(api.session, isNull);
      api.signOut();
    });

    test('every mutation hits the same route/body as the web panel', () async {
      final http = FakeOwnerHttp((_) => jsonRes(200, {'ok': true}));
      final api = OwnerApi(origin: origin, http: http);
      final starts = DateTime.utc(2026, 11, 12, 12);
      final notified = DateTime.utc(2026, 11, 12, 9);
      await api.createSchool(
        provisionOpId: 'op',
        slug: 'school-12',
        displayName: 'هنرستان',
        managerName: 'مدیر',
        planCode: 'basic',
        reason: 'r' * 10,
      );
      await api.suspendTenant('t/1', 'reason-1234');
      await api.requestDeletion('t1', 'reason-1234');
      await api.approveDeletion('d1', 'reason-1234');
      await api.cancelDeletion('d1', 'reason-1234');
      await api.executeDeletion('d1', 'reason-1234');
      await api.renew('s1', 'reason-1234', 30);
      await api.createPlan(
        code: 'pro',
        name: 'حرفه‌ای',
        storageMb: 2048,
        reason: 'reason-1234',
      );
      await api.createUser('op2', 'platform_operator', 'reason-1234');
      await api.requestGrant(
        tenantId: 't1',
        scope: 'metadata',
        caseRef: 'C-1',
        reason: 'reason-1234',
        schoolNotifiedAt: notified,
        startsAt: starts,
        hours: 4,
      );
      await api.approveGrant('g1', 'reason-1234');
      await api.revokeGrant('g1', 'reason-1234');
      await api.infraAddProvider(
        code: 'radcloud',
        displayName: 'RadCloud',
        kind: 'host',
        reason: 'reason-1234',
      );
      await api.infraAddProvider(
        code: 'arvan',
        displayName: 'Arvan',
        kind: 'vps',
        credentialRef: 'secret:ARVAN_KEY',
        reason: 'reason-1234',
      );
      await api.infraAddService(
        providerId: 'p1',
        name: 'gw',
        kind: 'gateway',
        reason: 'reason-1234',
      );
      await api.infraAddEndpoint(
        serviceId: 's1',
        url: 'https://x.ir/h',
        checkKind: 'http',
        expectedStatus: 200,
        reason: 'reason-1234',
      );
      await api.infraRecordMetric(
        serviceId: 's1',
        metric: 'usage_cpu',
        unit: 'percent',
        value: 12.5,
        label: 'E',
        reason: 'reason-1234',
      );
      await api.infraRecordMetric(
        serviceId: 's1',
        metric: 'usage_cpu',
        unit: 'percent',
        reason: 'reason-1234',
      );
      await api.infraCheck('e1');
      await api.infraRequestChange(
        action: 'set_credential_ref',
        targetId: 'p1',
        reason: 'reason-1234',
        payload: {'credential_ref': ''},
      );
      await api.infraRequestChange(
        action: 'disable_endpoint',
        targetId: 'e1',
        reason: 'reason-1234',
      );
      await api.infraApprove('c1', 'reason-1234');
      final paths = http.sent
          .map(
            (s) =>
                '${s.method} ${s.url.path.replaceFirst(OwnerApi.prefix, '')}',
          )
          .toList();
      expect(paths, [
        'POST /tenants',
        'POST /tenants/t%2F1/suspend',
        'POST /tenants/t1/deletion-request',
        'POST /tenant-deletions/d1/approve',
        'POST /tenant-deletions/d1/cancel',
        'POST /tenant-deletions/d1/execute',
        'POST /subscriptions/s1/renew',
        'POST /plans',
        'POST /platform-users',
        'POST /support-grants',
        'POST /support-grants/g1/approve',
        'POST /support-grants/g1/revoke',
        'POST /infra/providers',
        'POST /infra/providers',
        'POST /infra/services',
        'POST /infra/endpoints',
        'POST /infra/metrics',
        'POST /infra/metrics',
        'POST /infra/endpoints/e1/check',
        'POST /infra/changes',
        'POST /infra/changes',
        'POST /infra/changes/c1/approve',
      ]);
      Map<String, Object?> b(int i) => http.sent[i].json;
      expect(b(0), {
        'provision_op_id': 'op',
        'slug': 'school-12',
        'display_name': 'هنرستان',
        'manager_name': 'مدیر',
        'plan_code': 'basic',
        'reason': 'r' * 10,
      });
      expect(b(1)['idempotency_key'], isA<String>());
      expect(b(2), {'reason': 'reason-1234', 'confirm_tenant_id': 't1'});
      expect(b(6)['extend_days'], 30);
      expect(b(7), {
        'code': 'pro',
        'name': 'حرفه‌ای',
        'storage_mb': 2048,
        'reason': 'reason-1234',
      });
      expect(b(9), {
        'tenant_id': 't1',
        'scope': 'metadata',
        'case_ref': 'C-1',
        'reason': 'reason-1234',
        'school_notified_at': '2026-11-12T09:00:00.000Z',
        'starts_at': '2026-11-12T12:00:00.000Z',
        'ends_at': '2026-11-12T16:00:00.000Z',
        'max_actions': 3,
      });
      expect(b(12).containsKey('credential_ref'), isFalse);
      expect(b(12)['api_mode'], 'manual');
      expect(b(13)['credential_ref'], 'secret:ARVAN_KEY');
      expect(b(14)['region'], isNull);
      expect(b(16), {
        'service_id': 's1',
        'metric': 'usage_cpu',
        'unit': 'percent',
        'source': 'manual',
        'reason': 'reason-1234',
        'value': 12.5,
        'label': 'E',
      });
      expect(b(17).containsKey('label'), isFalse);
      expect(b(17)['value'], isNull);
      expect(b(18), isEmpty);
      expect(b(19)['payload'], {'credential_ref': ''});
      expect(b(20).containsKey('payload'), isFalse);
      api.close();
      expect(http.closed, isTrue);
    });
  });
}
