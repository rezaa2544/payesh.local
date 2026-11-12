// Row 126 — the NATIVE owner client against the REAL owner stack: server/gateway.js +
// apps/owner-panel/server/platform-api.js + migrations 001..006 on PostgreSQL (PGlite or
// a local DATABASE_URL), started by apps/owner-panel/scripts/native-it-harness.js.
// Real password + real TOTP login, every page's reads and the owner/operator mutations,
// four-eyes and 24h-delay refusals, credential-reference refusal, audit hash chain.
//
// Runs when PAYESH_OWNER_IT=1 (CI job `owner-native-it`); prints OWNER-NATIVE-IT-OK.
@Tags(['real-server'])
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:payesh_owner_api/payesh_owner_api.dart';
import 'package:test/test.dart';

import 'support/totp.dart';

final bool enabled = Platform.environment['PAYESH_OWNER_IT'] == '1';

void main() {
  late Process harness;
  late Map<String, Object?> env;
  late Uri gateway;
  late Uri panel;
  late List<String> tenants;
  final apis = <OwnerApi>[];

  Map<String, Object?> account(String k) =>
      (env['accounts']! as Map<String, Object?>)[k]! as Map<String, Object?>;

  OwnerApi client(Uri origin, {void Function()? onUnauthorized}) {
    final a = OwnerApi(
      origin: origin,
      http: IoOwnerHttp(),
      onUnauthorized: onUnauthorized,
    );
    apis.add(a);
    return a;
  }

  Future<OwnerApi> signIn(String key, {Uri? origin}) async {
    final a = client(origin ?? gateway);
    final acc = account(key);
    final r = await a.login(
      loginId: acc['login_id']! as String,
      password: acc['password']! as String,
      totp: totpAt(acc['totp_secret']! as String, DateTime.now()),
    );
    expect(r.ok, isTrue, reason: 'login $key: ${r.error}');
    return a;
  }

  setUpAll(() async {
    if (!enabled) return;
    final root = Directory.current.uri.resolve('../../../../').toFilePath();
    harness = await Process.start('node', [
      '${root}apps/owner-panel/scripts/native-it-harness.js',
    ], workingDirectory: root);
    harness.stderr.transform(utf8.decoder).listen(stderr.write);
    final ready = Completer<String>();
    harness.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen((l) {
          if (l.startsWith('NATIVE-IT-READY ') && !ready.isCompleted) {
            ready.complete(l.substring('NATIVE-IT-READY '.length));
          }
        });
    unawaited(
      harness.exitCode.then((c) {
        if (!ready.isCompleted) ready.completeError('harness exited $c');
      }),
    );
    env = jsonDecode(
      await ready.future.timeout(const Duration(minutes: 2)),
    ) as Map<String, Object?>;
    gateway = normalizeOrigin(env['gateway']! as String)!;
    panel = normalizeOrigin(env['panel']! as String)!;
    tenants = List<String>.from(env['tenants']! as List);
  });

  tearDownAll(() async {
    if (!enabled) return;
    for (final a in apis) {
      a.close();
    }
    await harness.stdin.close();
    await harness.exitCode.timeout(
      const Duration(seconds: 30),
      onTimeout: () {
        harness.kill();
        return -1;
      },
    );
  });

  test(
    'native owner client ⇄ real Gateway + platform API + PostgreSQL',
    () async {
      final steps = <String>[];
      void step(String s) {
        steps.add(s);
        stdout.writeln('  ✓ $s');
      }

      // ── health (readable without a session; no data) ────────────────────
      final anon = client(gateway);
      final h = await anon.healthSummary();
      expect(h.ok, isTrue, reason: h.message);
      expect(h.body!['content_default'], 'deny');
      final noAuth = await anon.dashboard();
      expect(noAuth.status, 401);
      step('health readable without session; dashboard without token ⇒ 401');

      // ── login: wrong TOTP refused, right TOTP accepted ──────────────────
      final acc = account('owner');
      final good = totpAt(acc['totp_secret']! as String, DateTime.now());
      final wrong = ((int.parse(good) + 1) % 1000000).toString().padLeft(
        6,
        '0',
      );
      final bad = await client(gateway).login(
        loginId: acc['login_id']! as String,
        password: acc['password']! as String,
        totp: wrong,
      );
      expect(bad.error, ownerErrors['login_failed']);
      final owner = await signIn('owner');
      expect(owner.session!.role, OwnerRole.owner);
      expect(owner.session!.claims.sub, acc['id']);
      step('password + wrong TOTP ⇒ refused; password + TOTP ⇒ owner session');

      // ── dashboard / schools / plans / limits ────────────────────────────
      final d = await owner.dashboard();
      expect(d.ok, isTrue, reason: d.message);
      expect(
        d.object('dashboard')!.keys,
        containsAll(['subscriptions', 'plans', 'active_users', 'open_grants']),
      );
      final t = await owner.tenants();
      expect(t.ok, isTrue, reason: t.message);
      expect(
        t.list('tenants').map((x) => x['tenant_id']),
        containsAll(tenants),
      );
      step('dashboard counters; tenants list has the seeded schools');

      final p0 = await owner.createPlan(
        code: 'pro-native',
        name: 'حرفه‌ای',
        storageMb: 2048,
        reason: 'آزمون اپ بومی پنل مالک',
      );
      expect(p0.ok, isTrue, reason: p0.message);
      final plans = await owner.plans();
      expect(
        plans.list('plans').map((x) => x['code']),
        containsAll(['basic', 'pro-native']),
      );
      step('create plan ⇒ listed');

      final subs0 = (await owner.subscriptions()).list('subscriptions');
      final s0 = subs0.firstWhere((s) => s['tenant_id'] == tenants[0]);
      final before = DateTime.parse(s0['ends_at']! as String);
      final rn = await owner.renew(
        s0['id']! as String,
        'تمدید آزمایشی اپ بومی',
        30,
      );
      expect(rn.ok, isTrue, reason: rn.message);
      final s0b = (await owner.subscriptions())
          .list('subscriptions')
          .firstWhere((s) => s['id'] == s0['id']);
      expect(
        DateTime.parse(s0b['ends_at']! as String).difference(before).inDays,
        30,
      );
      step('renew subscription +30 days (server value)');

      final lim = await owner.limits(tenants[0]);
      final use = await owner.usage(tenants[0]);
      expect(lim.object('limits')!['max_students'], 400);
      expect(use.object('usage')!['students_count'], 230);
      expect(faBytes(use.object('usage')!['storage_bytes']), '۲۵۶ مگابایت');
      step('limits + usage of a school');

      // ── suspend + two-person deletion with 24h delay ───────────────────
      final su = await owner.suspendTenant(tenants[1], 'تعلیق آزمایشی اپ بومی');
      expect(su.ok, isTrue, reason: su.message);
      final t1 = (await owner.tenants())
          .list('tenants')
          .firstWhere((x) => x['tenant_id'] == tenants[1]);
      expect(t1['status'], 'suspended');
      step('suspend school ⇒ status suspended');

      final dr = await owner.requestDeletion(tenants[0], 'درخواست حذف آزمایشی');
      expect(dr.ok, isTrue, reason: dr.message);
      final dels = (await owner.tenantDeletions()).list('requests');
      final req = dels.firstWhere((x) => x['tenant_id'] == tenants[0]);
      expect(req['status'], 'pending');
      expect(req['requested_by'], acc['id']);
      final self = await owner.approveDeletion(
        req['id']! as String,
        'تأیید توسط خود درخواست‌دهنده',
      );
      expect(self.ok, isFalse);
      expect(self.message, startsWith(ownerErrors['four_eyes_required']!));
      final owner2 = await signIn('owner2');
      final ap = await owner2.approveDeletion(
        req['id']! as String,
        'تأیید مالک دوم آزمایشی',
      );
      expect(ap.ok, isTrue, reason: ap.message);
      final early = await owner2.executeDeletion(
        req['id']! as String,
        'اجرای زودهنگام آزمایشی',
      );
      expect(early.ok, isFalse);
      expect(early.message, startsWith(ownerErrors['deletion_delay_pending']!));
      final cancel = await owner.cancelDeletion(
        req['id']! as String,
        'لغو درخواست حذف آزمایشی',
      );
      expect(cancel.ok, isTrue, reason: cancel.message);
      step(
        'deletion: self-approve ⇒ four_eyes_required; owner2 approves; early execute ⇒ deletion_delay_pending; cancel',
      );

      // ── create school: this stack has no school DB ──────────────────────
      final opId = requestId();
      Future<ApiResult> create() => owner.createSchool(
        provisionOpId: opId,
        slug: 'school-native',
        displayName: 'هنرستان آزمایشی',
        managerName: 'مدیر آزمایشی',
        planCode: 'basic',
        reason: 'ساخت مدرسهٔ آزمایشی',
      );
      final cs = await create();
      expect(cs.ok, isFalse);
      expect(
        cs.message,
        startsWith(ownerErrors['school_provisioning_failed']!),
      );
      final retry = await create();
      expect(retry.ok, isFalse);
      expect(
        retry.message,
        startsWith(ownerErrors['school_provisioning_failed']!),
      );
      step(
        'create school ⇒ school_provisioning_failed on a stack without a school DB; same-op retry is safe',
      );

      // ── operator: role limits, support grant with four eyes ─────────────
      final op = await signIn('operator');
      expect(op.session!.caps.renew, isFalse);
      final opRenew = await op.renew(
        s0['id']! as String,
        'اپراتور نباید تمدید کند',
        5,
      );
      expect(opRenew.status, 403);
      expect(opRenew.message, startsWith(ownerErrors['role_forbidden']!));
      final opUser = await op.createUser(
        'should-not',
        'platform_support',
        'اپراتور نباید کاربر بسازد',
      );
      expect(opUser.status, 403);
      final now = DateTime.now().toUtc();
      final g = await op.requestGrant(
        tenantId: tenants[0],
        scope: 'metadata',
        caseRef: 'CASE-126',
        reason: 'بررسی مشکل همگام‌سازی مدرسه',
        schoolNotifiedAt: now.subtract(const Duration(minutes: 5)),
        startsAt: now.add(const Duration(minutes: 1)),
        hours: 4,
      );
      expect(g.ok, isTrue, reason: g.message);
      final events = (await owner.audit()).list('events');
      final ev = events.firstWhere(
        (e) => e['action'] == 'grant.request' && e['tenant_id'] == tenants[0],
      );
      final ag = await owner.approveGrant(
        ev['subject_ref']! as String,
        'تأیید مجوز پشتیبانی آزمایشی',
      );
      expect(ag.ok, isTrue, reason: ag.message);
      final grants = (await owner.supportGrants()).list('grants');
      final grant = grants.firstWhere((x) => x['case_ref'] == 'CASE-126');
      final rv = await owner.revokeGrant(
        grant['id']! as String,
        'ابطال مجوز آزمایشی',
      );
      expect(rv.ok, isTrue, reason: rv.message);
      final users = (await owner.platformUsers()).list('users');
      expect(
        users.map((u) => u['login_id']),
        containsAll(['native-owner', 'native-owner2', 'native-operator']),
      );
      step(
        'operator: renew/createUser ⇒ 403; grant request → owner approves → revoke; users listed',
      );

      // ── infrastructure (manual registry, two-step changes) ──────────────
      final raw = await owner.infraAddProvider(
        code: 'rawcred',
        displayName: 'Raw',
        kind: 'host',
        credentialRef: 'hunter2-raw-token',
        reason: 'نباید رمز خام پذیرفته شود',
      );
      expect(raw.ok, isFalse);
      expect(credentialError('hunter2-raw-token'), isNotNull);
      final pr = await owner.infraAddProvider(
        code: 'radcloud',
        displayName: 'RadCloud',
        kind: 'host',
        credentialRef: 'secret:RADCLOUD_API_TOKEN',
        reason: 'ثبت دستی ارائه‌دهنده',
      );
      expect(pr.ok, isTrue, reason: pr.message);
      var inf = await owner.infra();
      final prov = inf
          .list('providers')
          .firstWhere((x) => x['code'] == 'radcloud');
      expect(prov['credential_ref'], 'secret:RADCLOUD_API_TOKEN');
      final sv = await owner.infraAddService(
        providerId: prov['id']! as String,
        name: 'gateway-main',
        kind: 'gateway',
        region: 'thr-1',
        reason: 'ثبت سرویس آزمایشی',
      );
      expect(sv.ok, isTrue, reason: sv.message);
      inf = await owner.infra();
      final svc = inf
          .list('services')
          .firstWhere((x) => x['name'] == 'gateway-main');
      final epr = await owner.infraAddEndpoint(
        serviceId: svc['id']! as String,
        url: 'https://gateway.example.invalid/healthz',
        checkKind: 'http',
        expectedStatus: 200,
        reason: 'ثبت Endpoint آزمایشی',
      );
      expect(epr.ok, isTrue, reason: epr.message);
      final m1 = await owner.infraRecordMetric(
        serviceId: svc['id']! as String,
        metric: 'capacity_cpu',
        unit: 'cores',
        value: 4,
        label: 'M',
        reason: 'ثبت دستی ظرفیت',
      );
      expect(m1.ok, isTrue, reason: m1.message);
      final m2 = await owner.infraRecordMetric(
        serviceId: svc['id']! as String,
        metric: 'usage_cpu',
        unit: 'percent',
        reason: 'مصرف نامعلوم است',
      );
      expect(m2.ok, isTrue, reason: m2.message);
      inf = await owner.infra();
      final svc2 = inf.list('services').firstWhere((x) => x['id'] == svc['id']);
      final metrics = svc2['metrics']! as Map<String, Object?>;
      expect((metrics['capacity_cpu']! as Map)['value'], 4);
      expect((metrics['capacity_cpu']! as Map)['label'], 'M');
      final usageCpu = metrics['usage_cpu'] as Map?;
      expect(usageCpu == null || usageCpu['value'] == null, isTrue);
      final ep = inf
          .list('endpoints')
          .firstWhere(
            (x) => x['url'] == 'https://gateway.example.invalid/healthz',
          );
      final ck = await owner.infraCheck(ep['id']! as String);
      expect(ck.ok, isTrue, reason: ck.message);
      expect(ck.object('check'), isNotNull);
      final ck2 = await owner.infraCheck(ep['id']! as String);
      expect(ck2.ok, isFalse);
      expect(ck2.message, startsWith(ownerErrors['check_cooldown']!));
      final chq = await op.infraRequestChange(
        action: 'disable_endpoint',
        targetId: ep['id']! as String,
        reason: 'درخواست غیرفعال‌سازی آزمایشی',
      );
      expect(chq.ok, isTrue, reason: chq.message);
      final changes = (await owner.infraChanges()).list('changes');
      final ch = changes.firstWhere(
        (x) => x['target_id'] == ep['id'] && x['status'] == 'pending',
      );
      final opApprove = await op.infraApprove(
        ch['id']! as String,
        'اپراتور نباید تأیید کند',
      );
      expect(opApprove.status, 403);
      final okApprove = await owner.infraApprove(
        ch['id']! as String,
        'تأیید مالک برای غیرفعال‌سازی',
      );
      expect(okApprove.ok, isTrue, reason: okApprove.message);
      inf = await owner.infra();
      expect(
        inf.list('endpoints').firstWhere((x) => x['id'] == ep['id'])['enabled'],
        isFalse,
      );
      step(
        'infra: raw credential refused; provider/service/endpoint/metrics; check + cooldown; operator request → owner approve',
      );

      // ── audit hash chain + report ───────────────────────────────────────
      final all = (await owner.audit()).list('events');
      expect(all.length, greaterThan(10));
      expect(auditChainBreaks(all), 0);
      final subsNow = (await owner.subscriptions()).list('subscriptions');
      final rep = subscriptionReport(subsNow);
      expect(
        rep.byPlan['basic'],
        subsNow.where((x) => x['plan_code'] == 'basic').length,
      );
      expect(rep.byStatus.values.fold<int>(0, (a, b) => a + b), subsNow.length);
      expect(rep.byStatus['suspended'], 1);
      step(
        'audit: ${all.length} events, hash chain continuous; report aggregates',
      );

      // ── same client through the owner-panel server origin (proxy) ───────
      final viaPanel = client(panel);
      final hp = await viaPanel.healthSummary();
      expect(hp.ok, isTrue, reason: hp.message);
      step('same API through the owner-panel server origin');

      // ── a forged/expired session is dropped on 401 ──────────────────────
      var dropped = 0;
      final forged = OwnerApi(
        origin: gateway,
        http: IoOwnerHttp(),
        onUnauthorized: () => dropped++,
      );
      apis.add(forged);
      final tok = op.session!.token;
      final parts = tok.split('.');
      final tampered =
          '${parts[0]}.${parts[1]}.${parts[2]}.${parts[3].split('').reversed.join()}';
      expect(
        OwnerClaims.decode(tampered),
        isNotNull,
        reason: 'shape stays valid',
      );
      final r401 = await _withToken(forged, tampered).dashboard();
      expect(r401.status, 401);
      expect(dropped, 1);
      step('tampered token ⇒ 401 ⇒ session dropped');

      stdout.writeln(
        'OWNER-NATIVE-IT-OK steps=${steps.length} db=${env['database']}',
      );
    },
    skip: enabled ? false : 'set PAYESH_OWNER_IT=1 (CI job owner-native-it)',
    timeout: const Timeout(Duration(minutes: 4)),
  );
}

/// Puts [token] into [api] through the real login path's state (test-only helper).
OwnerApi _withToken(OwnerApi api, String token) {
  api.debugSetSession(token);
  return api;
}
