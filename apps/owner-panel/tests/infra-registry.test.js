'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 122 — provider-agnostic infrastructure layer (migration 006 + /infra API + infra.js).
   PGlite + migrations 001..006; the real platform API under the runtime role (SET LOCAL ROLE);
   the limited health checker against local sockets. Every negative control is counted and each
   one goes red when its control is removed (mutants: docs/cloud/122-infra-layer.md §4).
   ═══════════════════════════════════════════════════════════════════ */
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const api = require('../server/platform-api');
const infra = require('../server/infra');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const MIG = path.join(ROOT, 'db', 'migrations', 'owner-panel');
const SECRET = crypto.randomBytes(32).toString('hex');
const P = '/api/platform/v1';
const read = f => fs.readFileSync(path.join(MIG, f), 'utf8');
/* a value that must never leave the process: placed in env under the referenced name */
const CANARY = 'canary-' + crypto.randomBytes(12).toString('hex');

function adapter(db) {
  return {
    async withTransaction(fn) {
      await db.exec('BEGIN');
      try {
        await db.exec('SET LOCAL ROLE payesh_platform_runtime');
        const r = await fn((sql, params = []) => db.query(sql, params));
        await db.exec('COMMIT');
        return r;
      } catch (e) {
        try { await db.exec('ROLLBACK'); } catch (_) { /* noop */ }
        throw e;
      }
    },
  };
}
async function sqlRejects(db, sql, params, codeRe) {
  try { await db.query(sql, params); } catch (e) { return codeRe.test(String(e.code || '') + ' ' + String(e.message || '')); }
  return false;
}

/* ── part 1: infra.js units (adapter contract, credentials, health checker) ───────────── */
async function units() {
  let checks = 0;
  const negative = (label, cond) => { checks++; assert.ok(cond, 'negative control: ' + label); };

  const m = infra.manualAdapter();
  assert.deepStrictEqual(m.describe().mode, 'manual');
  negative('manual adapter capacity is unknown, never a number', (await m.capacity()).value === null && (await m.capacity()).label === '?');
  negative('manual adapter usage is unknown', (await m.usage()).value === null);
  let refused = null;
  try { await m.provision({ kind: 'vps' }); } catch (e) { refused = e.code; }
  negative('manual adapter refuses provision() (no auto-provisioning)', refused === 'provider_not_supported');
  negative('capabilities claim nothing automated', Object.values(m.capabilities()).every(v => v === false));
  let noApi = null;
  try { infra.getAdapter('api'); } catch (e) { noApi = e.code; }
  negative('no provider API adapter is installed', noApi === 'provider_not_supported');
  let bad = null;
  try { infra.assertAdapter({ describe: () => ({ mode: 'x', kinds: ['vps'] }), capabilities() {}, capacity() {}, usage() {} }); } catch (e) { bad = e; }
  negative('adapter without provision() is rejected by the contract', bad instanceof TypeError);
  let badKind = null;
  try { infra.assertAdapter({ describe: () => ({ mode: 'x', kinds: ['mainframe'] }), capabilities() {}, capacity() {}, usage() {}, provision() {} }); } catch (e) { badKind = e; }
  negative('adapter with an unknown kind is rejected', badKind instanceof TypeError);

  assert.strictEqual(infra.resolveCredential('secret:RADCLOUD_TOKEN', { RADCLOUD_TOKEN: 'v' }), 'v');
  assert.strictEqual(infra.resolveCredential('secret:RADCLOUD_TOKEN', {}), null);
  let rawRef = null;
  try { infra.resolveCredential('sk_live_123', {}); } catch (e) { rawRef = e.code; }
  negative('a raw value is not a credential reference', rawRef === 'provider_not_supported');
  negative('credentialView never carries a value', JSON.stringify(infra.credentialView('secret:X_TOKEN')) === '{"credential":"reference","credential_ref":"secret:X_TOKEN"}');

  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    negative('private/loopback/metadata address blocked: ' + ip, infra.isPrivateAddress(ip));
  }
  for (const ip of ['8.8.8.8', '185.199.108.153', '2606:50c0:8000::153']) assert.ok(!infra.isPrivateAddress(ip), 'public ' + ip);

  negative('endpoint with user:password is invalid', infra.parseEndpoint('https://u:p@db.example.com/', 'http') === null);
  negative('tcp endpoint needs a port', infra.parseEndpoint('tcp://db.example.com', 'tcp') === null);
  negative('scheme must match check kind', infra.parseEndpoint('tcp://db.example.com:5432', 'http') === null);

  /* local servers */
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    if (req.url === '/redirect') { res.writeHead(302, { location: 'http://169.254.169.254/' }); res.end(); return; }
    if (req.url === '/hang') return; /* never answers */
    if (req.url === '/fail') { res.writeHead(503); res.end('down'); return; }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('BODY-MUST-NOT-BE-READ');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const base = 'http://127.0.0.1:' + port;
  try {
    const blocked = await infra.checkEndpoint({ url: base + '/', check_kind: 'http' });
    negative('loopback target refused by default (SSRF guard)', blocked.ok === false && blocked.error_code === 'blocked_address' && hits === 0);
    const viaDns = await infra.checkEndpoint({ url: 'http://internal.example:' + port + '/', check_kind: 'http' },
      { lookup: async () => ({ address: '10.0.0.5', family: 4 }) });
    negative('hostname resolving to a private address refused', viaDns.error_code === 'blocked_address');
    const up = await infra.checkEndpoint({ url: base + '/', check_kind: 'http' }, { allowPrivate: true });
    assert.ok(up.ok && up.status_code === 200 && up.error_code === null && Number.isInteger(up.latency_ms), JSON.stringify(up));
    negative('result never carries a response body', !JSON.stringify(up).includes('BODY-MUST-NOT-BE-READ'));
    const mism = await infra.checkEndpoint({ url: base + '/', check_kind: 'http', expected_status: 204 }, { allowPrivate: true });
    negative('expected_status mismatch ⇒ down', !mism.ok && mism.error_code === 'unexpected_status' && mism.status_code === 200);
    const five = await infra.checkEndpoint({ url: base + '/fail', check_kind: 'http' }, { allowPrivate: true });
    negative('5xx ⇒ down', !five.ok && five.status_code === 503);
    const before = hits;
    const redir = await infra.checkEndpoint({ url: base + '/redirect', check_kind: 'http' }, { allowPrivate: true });
    negative('redirect is not followed (one request only)', redir.status_code === 302 && hits === before + 1);
    const hang = await infra.checkEndpoint({ url: base + '/hang', check_kind: 'http' }, { allowPrivate: true, timeoutMs: 300 });
    negative('hard timeout', !hang.ok && hang.error_code === 'timeout');
    const tcpUp = await infra.checkEndpoint({ url: 'tcp://127.0.0.1:' + port, check_kind: 'tcp' }, { allowPrivate: true });
    assert.ok(tcpUp.ok, 'tcp connect ok');
    const closed = net.createServer();
    await new Promise(r => closed.listen(0, '127.0.0.1', r));
    const closedPort = closed.address().port;
    await new Promise(r => closed.close(r));
    const tcpDown = await infra.checkEndpoint({ url: 'tcp://127.0.0.1:' + closedPort, check_kind: 'tcp' }, { allowPrivate: true });
    negative('tcp refused ⇒ down with short code', !tcpDown.ok && tcpDown.error_code === 'refused');
  } finally {
    srv.closeAllConnections && srv.closeAllConnections();
    await new Promise(r => srv.close(r));
  }
  return checks;
}

/* ── part 2: migration 006 + /infra API on PGlite ─────────────────────────────────────── */
async function flow() {
  const hadWindow = Object.prototype.hasOwnProperty.call(global, 'window');
  const previousWindow = global.window;
  if (hadWindow) delete global.window;
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  let checks = 0;
  const negative = (label, cond) => { checks++; assert.ok(cond, 'negative control: ' + label); };
  const prevEnv = process.env.RADCLOUD_API_TOKEN;
  process.env.RADCLOUD_API_TOKEN = CANARY;
  try {
    for (const f of ['001_owner_panel.up.sql', '002_owner_panel_api.up.sql', '003_tenant_deletion.up.sql',
      '004_owner_login.up.sql', '005_tenant_provisioning.up.sql', '006_infra_registry.up.sql']) await db.exec(read(f));
    const id = () => crypto.randomUUID();
    const U = { owner: id(), operator: id(), support: id() };
    for (const [uid, login, role] of [[U.owner, 'owner-1', 'platform_owner'], [U.operator, 'operator-1', 'platform_operator'],
      [U.support, 'support-1', 'platform_support']]) {
      await db.query("INSERT INTO owner_platform.platform_users(id,login_id,role,status) VALUES ($1,$2,$3,'active')", [uid, login, role]);
    }
    /* scripted checker: the API's network step, driven deterministically */
    const script = [];
    const seen = [];
    const checker = async (endpoint) => { seen.push(endpoint.url); return script.shift() || { ok: true, latency_ms: 5, status_code: 200, error_code: null }; };
    const platform = api.createPlatformApi({ db: adapter(db), secret: SECRET, rateLimitMax: 10000, healthChecker: checker, checkCooldownSec: 0 });
    const strict = api.createPlatformApi({ db: adapter(db), secret: SECRET, rateLimitMax: 10000, healthChecker: checker });
    const tok = (sub, role) => api.signPlatformToken({ sub, role, iat: Date.now(), exp: Date.now() + 3600_000, jti: id() }, SECRET);
    const T = { owner: tok(U.owner, 'platform_owner'), operator: tok(U.operator, 'platform_operator'),
      support: tok(U.support, 'platform_support'), forgedOwner: tok(U.operator, 'platform_owner') };
    const call = (p, method, sub, t, body) => p.dispatch({ method, path: P + sub,
      headers: t ? { authorization: 'Bearer ' + t } : {}, body: body || {} });
    const post = (sub, t, body, p = platform) => call(p, 'POST', sub, t, body);
    const get = (sub, t) => call(platform, 'GET', sub, t);
    const count = async (sql, p) => Number((await db.query(sql, p || [])).rows[0].n);
    const auditActions = async () => (await db.query("SELECT action FROM owner_platform.platform_audit WHERE action LIKE 'infra.%' ORDER BY sequence_id")).rows.map(r => r.action);

    /* ── registration refusals ─────────────────────────────────────────── */
    const prov = { code: 'radcloud', display_name: 'RadCloud', kind: 'host', reason: 'ثبت هاست مرحلهٔ A' };
    negative('no token ⇒ 401', (await post('/infra/providers', null, prov)).status === 401);
    negative('support ⇒ 403', (await post('/infra/providers', T.support, prov)).status === 403);
    for (const k of ['password', 'api_key', 'token', 'secret', 'connection_string']) {
      const r = await post('/infra/providers', T.operator, Object.assign({}, prov, { [k]: CANARY }));
      negative('raw credential field rejected: ' + k, r.status === 400 && r.body.error === 'credentials_not_accepted');
    }
    const rawRef = await post('/infra/providers', T.operator, Object.assign({}, prov, { credential_ref: CANARY }));
    negative('credential_ref that is not secret:NAME ⇒ 400', rawRef.status === 400 && rawRef.body.error === 'credential_must_be_reference');
    const apiMode = await post('/infra/providers', T.owner, Object.assign({}, prov, { api_mode: 'api' }));
    negative('api_mode=api ⇒ 501 (no adapter until row 124)', apiMode.status === 501);
    negative('refusals wrote nothing', (await count('SELECT count(*)::int AS n FROM owner_platform.infra_provider')) === 0);

    /* ── happy path: manual registration ───────────────────────────────── */
    const p1 = await post('/infra/providers', T.operator, Object.assign({}, prov, { credential_ref: 'secret:RADCLOUD_API_TOKEN' }));
    assert.strictEqual(p1.status, 201, JSON.stringify(p1.body));
    const PID = p1.body.provider.id;
    assert.strictEqual(p1.body.provider.credential, 'reference');
    assert.strictEqual(p1.body.provider.adapter.mode, 'manual');
    negative('duplicate provider code ⇒ 409', (await post('/infra/providers', T.owner, prov)).status === 409);
    const pdb = await post('/infra/providers', T.owner, { code: 'managed-pg', display_name: 'Managed PG', kind: 'db' });
    assert.strictEqual(pdb.status, 201);
    assert.strictEqual(pdb.body.provider.credential, 'none');
    const s1 = await post('/infra/services', T.operator, { provider_id: PID, name: 'gateway-1', kind: 'gateway', region: 'IR-THR' });
    assert.strictEqual(s1.status, 201, JSON.stringify(s1.body));
    const SID = s1.body.service.id;
    negative('endpoint with user:password ⇒ 400', (await post('/infra/endpoints', T.operator,
      { service_id: SID, url: 'https://admin:' + CANARY + '@gw.example.com/healthz', check_kind: 'http' })).status === 400);
    negative('endpoint scheme/kind mismatch ⇒ 400', (await post('/infra/endpoints', T.operator,
      { service_id: SID, url: 'https://gw.example.com/healthz', check_kind: 'tcp' })).status === 400);
    const e1 = await post('/infra/endpoints', T.operator, { service_id: SID, url: 'https://gw.example.com/healthz', check_kind: 'http', expected_status: 200 });
    assert.strictEqual(e1.status, 201, JSON.stringify(e1.body));
    const EID = e1.body.endpoint.id;

    /* ── data boundary: runtime role has no table writes; CHECKs repeat the rules ─────── */
    await db.exec('SET ROLE payesh_platform_runtime');
    const directIns = await sqlRejects(db, `INSERT INTO owner_platform.infra_provider(code,display_name,kind,created_by)
      VALUES ('x-host','x','host',$1)`, [U.owner], /42501|permission/i);
    const noActor = await sqlRejects(db, "SELECT owner_platform.infra_register_provider('y-host','y','host',NULL,NULL)", [], /42501|actor/i);
    await db.exec('RESET ROLE');
    negative('runtime cannot INSERT into infra_provider directly', directIns);
    negative('register without actor context ⇒ 42501', noActor);
    negative('DB CHECK: raw credential in credential_ref', await sqlRejects(db, `INSERT INTO owner_platform.infra_provider(code,display_name,kind,credential_ref,created_by)
      VALUES ('z-host','Zed host','host',$1,$2)`, [CANARY, U.owner], /infra_provider_credential_ref_check/));
    negative('DB CHECK: userinfo in endpoint url', await sqlRejects(db, `INSERT INTO owner_platform.infra_endpoint(service_id,url,check_kind)
      VALUES ($1,'https://u:p@h.example.com/','http')`, [SID], /infra_endpoint_(no_userinfo|url)_check/));
    negative('DB CHECK: number labelled unknown', await sqlRejects(db, `INSERT INTO owner_platform.infra_metric(service_id,metric,value,unit,label,source)
      VALUES ($1,'usage_cpu',50,'percent','?','manual')`, [SID], /infra_metric_unknown_check/));
    negative('DB CHECK: missing number labelled measured', await sqlRejects(db, `INSERT INTO owner_platform.infra_metric(service_id,metric,value,unit,label,source)
      VALUES ($1,'usage_cpu',NULL,'percent','M','manual')`, [SID], /infra_metric_unknown_check/));

    /* ── "unknown", never invented ─────────────────────────────────────── */
    let sum = await get('/infra', T.support);
    assert.strictEqual(sum.status, 200, JSON.stringify(sum.body));
    negative('provisioning is declared manual (no auto-provisioning claim)', sum.body.provisioning.automated === false);
    const svc = sum.body.services.find(s => s.id === SID);
    negative('service with no data ⇒ every metric value=null label=?',
      Object.values(svc.metrics).length === 10 && Object.values(svc.metrics).every(m => m.value === null && m.label === '?'));
    negative('endpoint never checked ⇒ health unknown', sum.body.endpoints.find(e => e.id === EID).health.state === 'unknown');
    negative('summary never contains the referenced secret value', !JSON.stringify(sum.body).includes(CANARY));

    const noLabel = await post('/infra/metrics', T.operator, { service_id: SID, metric: 'usage_cpu', value: 40, unit: 'percent' });
    negative('a number without M/E label ⇒ 400', noLabel.status === 400 && noLabel.body.error === 'label_required');
    negative('source=provider_api ⇒ 501', (await post('/infra/metrics', T.operator,
      { service_id: SID, metric: 'usage_cpu', value: 40, unit: 'percent', label: 'M', source: 'provider_api' })).status === 501);
    await db.query("SELECT set_config('app.platform_user_id', $1, false)", [U.owner]);
    negative('DB refuses provider_api metrics (no adapter)', await sqlRejects(db,
      "SELECT owner_platform.infra_record_metric($1,'usage_cpu',1,'percent','M','provider_api')", [SID], /42501|adapter/i));
    await db.query("SELECT set_config('app.platform_user_id', '', false)");
    const mm = await post('/infra/metrics', T.operator, { service_id: SID, metric: 'capacity_memory', value: 2048, unit: 'mb', label: 'M', source: 'probe' });
    assert.strictEqual(mm.status, 201, JSON.stringify(mm.body));
    const mu = await post('/infra/metrics', T.operator, { service_id: SID, metric: 'usage_disk', unit: 'percent' });
    assert.ok(mu.status === 201 && mu.body.metric.value === null && mu.body.metric.label === '?', 'explicit unknown recorded as ?');
    sum = await get('/infra', T.owner);
    const svc2 = sum.body.services.find(s => s.id === SID);
    assert.deepStrictEqual([svc2.metrics.capacity_memory.value, svc2.metrics.capacity_memory.label], [2048, 'M']);
    negative('other metrics stay unknown after one entry', svc2.metrics.usage_cpu.value === null && svc2.metrics.usage_disk.label === '?');

    /* ── limited health check + alerts ─────────────────────────────────── */
    script.push({ ok: false, latency_ms: null, status_code: null, error_code: 'timeout' },
      { ok: false, latency_ms: null, status_code: 503, error_code: 'unexpected_status' });
    const c1 = await post('/infra/endpoints/' + EID + '/check', T.operator);
    const c2 = await post('/infra/endpoints/' + EID + '/check', T.operator);
    assert.ok(c1.status === 200 && !c1.body.check.ok && c2.status === 200, JSON.stringify(c2.body));
    negative('2 failures ⇒ no alert yet', !c2.body.alert.opened && (await count('SELECT count(*)::int AS n FROM owner_platform.infra_alert')) === 0);
    script.push({ ok: false, latency_ms: null, status_code: null, error_code: 'refused' });
    const c3 = await post('/infra/endpoints/' + EID + '/check', T.operator);
    negative('3rd consecutive failure ⇒ one alert opened', !!c3.body.alert.opened);
    script.push({ ok: false, latency_ms: null, status_code: null, error_code: 'refused' });
    await post('/infra/endpoints/' + EID + '/check', T.operator);
    negative('further failures do not open a second alert',
      (await count('SELECT count(*)::int AS n FROM owner_platform.infra_alert WHERE closed_at IS NULL')) === 1);
    sum = await get('/infra', T.owner);
    assert.strictEqual(sum.body.endpoints.find(e => e.id === EID).health.state, 'down');
    assert.strictEqual(sum.body.open_alerts.length, 1);
    const c5 = await post('/infra/endpoints/' + EID + '/check', T.operator);
    negative('success closes the alert', !!c5.body.alert.closed
      && (await count('SELECT count(*)::int AS n FROM owner_platform.infra_alert WHERE closed_at IS NULL')) === 0);
    const cool = await post('/infra/endpoints/' + EID + '/check', T.operator, {}, strict);
    negative('per-endpoint cooldown ⇒ 429 (no check storm)', cool.status === 429 && cool.body.error === 'check_cooldown');
    negative('support cannot trigger checks', (await post('/infra/endpoints/' + EID + '/check', T.support)).status === 403);
    negative('unknown endpoint ⇒ 404', (await post('/infra/endpoints/' + id() + '/check', T.operator)).status === 404);
    negative('health history is append-only', await sqlRejects(db,
      'UPDATE owner_platform.infra_health_check SET ok = true WHERE endpoint_id = $1', [EID], /42501|append/i));
    negative('metric history is append-only', await sqlRejects(db,
      'DELETE FROM owner_platform.infra_metric WHERE service_id = $1', [SID], /42501|append/i));

    /* ── risky changes: request → owner approval → executed once, audited ───────────── */
    const shortR = await post('/infra/changes', T.operator, { action: 'disable_provider', target_id: PID, reason: 'کوتاه' });
    negative('change without a real reason ⇒ 400', shortR.status === 400 && shortR.body.error === 'reason_too_short');
    negative('raw credential in change payload ⇒ 400', (await post('/infra/changes', T.operator,
      { action: 'set_credential_ref', target_id: PID, reason: 'چرخش کلید طبق رویه', payload: { token: CANARY } })).body.error === 'credentials_not_accepted');
    negative('set_credential_ref to a raw value ⇒ 400', (await post('/infra/changes', T.operator,
      { action: 'set_credential_ref', target_id: PID, reason: 'چرخش کلید طبق رویه', payload: { credential_ref: CANARY } })).body.error === 'credential_must_be_reference');
    const rq = await post('/infra/changes', T.operator, { action: 'disable_provider', target_id: PID, reason: 'پایان قرارداد میزبانی آزمایشی' });
    assert.strictEqual(rq.status, 201, JSON.stringify(rq.body));
    const RQ = rq.body.change.id;
    negative('request alone changes nothing', (await db.query('SELECT status FROM owner_platform.infra_provider WHERE id=$1', [PID])).rows[0].status === 'active');
    const opApprove = await post('/infra/changes/' + RQ + '/approve', T.operator);
    negative('operator cannot approve ⇒ 403 role_forbidden', opApprove.status === 403 && opApprove.body.error === 'role_forbidden');
    const forged = await post('/infra/changes/' + RQ + '/approve', T.forgedOwner);
    negative('signed owner claim on an operator ⇒ 403 at data layer', forged.status === 403 && forged.body.data_layer === '42501');
    await db.query("SELECT set_config('app.platform_user_id', $1, false)", [U.operator]);
    negative('DB: operator cannot call infra_approve_change', await sqlRejects(db, 'SELECT owner_platform.infra_approve_change($1)', [RQ], /42501|not allowed/i));
    await db.query("SELECT set_config('app.platform_user_id', '', false)");
    const ap = await post('/infra/changes/' + RQ + '/approve', T.owner, { reason: 'تأیید مالک پس از بررسی' });
    assert.strictEqual(ap.status, 200, JSON.stringify(ap.body));
    assert.strictEqual(ap.body.change.status, 'executed');
    assert.strictEqual((await db.query('SELECT status FROM owner_platform.infra_provider WHERE id=$1', [PID])).rows[0].status, 'disabled');
    negative('approved change cannot execute twice', (await post('/infra/changes/' + RQ + '/approve', T.owner)).status === 403);
    negative('no new service under a disabled provider', (await post('/infra/services', T.owner,
      { provider_id: PID, name: 'gateway-2', kind: 'gateway' })).status === 400);
    const rk = await post('/infra/changes', T.owner, { action: 'set_credential_ref', target_id: PID, reason: 'چرخش کلید طبق رویهٔ فصلی', payload: { credential_ref: 'secret:RADCLOUD_API_TOKEN_V2' } });
    assert.strictEqual(rk.status, 201);
    assert.strictEqual((await post('/infra/changes/' + rk.body.change.id + '/approve', T.owner)).status, 200);
    assert.strictEqual((await db.query('SELECT credential_ref FROM owner_platform.infra_provider WHERE id=$1', [PID])).rows[0].credential_ref, 'secret:RADCLOUD_API_TOKEN_V2');
    const de = await post('/infra/changes', T.operator, { action: 'disable_endpoint', target_id: EID, reason: 'endpoint قدیمی جایگزین شد' });
    await post('/infra/changes/' + de.body.change.id + '/approve', T.owner);
    negative('disabled endpoint cannot be checked ⇒ 409', (await post('/infra/endpoints/' + EID + '/check', T.operator)).status === 409);
    negative('change for a missing target ⇒ 400', (await post('/infra/changes', T.operator,
      { action: 'disable_endpoint', target_id: id(), reason: 'هدف ناموجود برای آزمون' })).status === 400);

    /* ── audit: every write + alert transition, never a secret ─────────── */
    const acts = await auditActions();
    for (const a of ['infra.provider.register', 'infra.service.register', 'infra.endpoint.register', 'infra.metric.record',
      'infra.alert.open', 'infra.alert.close', 'infra.change.request', 'infra.change.approve']) {
      assert.ok(acts.includes(a), 'audited: ' + a);
    }
    const approvals = acts.filter(a => a === 'infra.change.approve').length;
    negative('each executed change has exactly one approval audit row', approvals === 3);
    const auditDump = JSON.stringify((await db.query("SELECT * FROM owner_platform.platform_audit WHERE action LIKE 'infra.%'")).rows);
    negative('audit never contains the secret value or a raw credential', !auditDump.includes(CANARY));
    negative('health checks are not audited one by one (only alert transitions)', !acts.includes('infra.check'));
    negative('checker was never handed a credential', seen.every(u => !u.includes('@') && !u.includes(CANARY)));

    /* ── migration 006 rollback is clean and reversible ─────────────────── */
    await db.exec(read('006_infra_registry.down.sql'));
    negative('after 006 down, /infra fails closed', (await get('/infra', T.owner)).status >= 400);
    await db.exec(read('006_infra_registry.up.sql'));
    negative('after 006 up again, registry is empty and works', (await get('/infra', T.owner)).body.providers.length === 0);
    return { negative_controls: checks };
  } finally {
    if (prevEnv === undefined) delete process.env.RADCLOUD_API_TOKEN; else process.env.RADCLOUD_API_TOKEN = prevEnv;
    await db.close();
    if (hadWindow) global.window = previousWindow;
  }
}

async function all() {
  const u = await units();
  const f = await flow();
  return { unit_controls: u, negative_controls: u + f.negative_controls };
}

module.exports = { units, flow, all };
if (require.main === module) {
  all().then((r) => { console.log('INFRA-122 negative_controls=' + r.negative_controls + ' unit_controls=' + r.unit_controls + ' failures=0'); })
    .catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
}
