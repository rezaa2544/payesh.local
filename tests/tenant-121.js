'use strict';
/* Row 121 — create a school from the owner panel → dedicated tenant → initial manager → the
   manager creates users in the SAME school → a user of another school sees 0 rows.
   Real server/gateway.js (school runtime role + platform runtime login) on real PostgreSQL, in a
   fresh throw-away database: tenancy schema + owner-panel migrations 001..005.
     T121-E01  owner POST /api/platform/v1/tenants ×2 → two tenants, subscriptions active, codes
     T121-E02  initial manager activates with slug + one-time code → school token (role from DB)
     T121-E03  manager creates a teacher + data; issues the teacher's code; teacher activates in A
     T121-E04  cross-school: school B's manager pulls 0 rows of A; B cannot issue a code for A's user
     T121-E05  privilege: teacher cannot issue codes nor promote itself; forged/expired tokens 401
     T121-E06  refresh: device secret → token; deactivated user → refresh 401
     T121-E07  data layer: runtime role with tenant B sees 0 rows of A in gw_school / gw_credential /
               product_records. Negative control: a temporary permissive policy (dropped right after)
               makes the same probe see A's rows → the probe discriminates.
     T121-E08  platform controls over HTTP: operator 403, forged owner 403 (42501), replay 200 same
               tenant without a new code, short reason 400
   Run: PAYESH_PG_ADMIN=… PAYESH_PG_RUNTIME=… node tests/tenant-121.js   (CI: api-contract)
   T121_REQUIRE_PG=1 turns "no PostgreSQL" into a failure. No code/token/secret is printed. */
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = process.env.PAYESH_PG_ADMIN || '';
const RUNTIME = process.env.PAYESH_PG_RUNTIME || '';
if (!ADMIN || !RUNTIME) {
  if (process.env.T121_REQUIRE_PG === '1') { console.log('FAIL  PAYESH_PG_ADMIN/RUNTIME required (T121_REQUIRE_PG=1)'); process.exit(1); }
  console.log('BLOCKED — PAYESH_PG_ADMIN and PAYESH_PG_RUNTIME are required (CI provides PostgreSQL)');
  process.exit(3);
}
const tenancy = require(path.join(ROOT, 'server/tenancy.js'));
const platformApi = require(path.join(ROOT, 'apps/owner-panel/server/platform-api.js'));
const { Client } = require('pg');
const SECRET = 't121-' + crypto.randomBytes(16).toString('hex');
const PSECRET = 't121p-' + crypto.randomBytes(16).toString('hex');
const DB = 'payesh_t121_' + crypto.randomBytes(4).toString('hex');
const PLATFORM_LOGIN = 'payesh_t121_platform';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const MIG = path.join(ROOT, 'db/migrations/owner-panel');

let PASS = 0, FAIL = 0, NEG = 0;
async function test(id, name, fn) {
  try { const d = await fn(); PASS++; console.log(`PASS  ${id}  ${name}${d ? '  → ' + d : ''}`); }
  catch (e) { FAIL++; console.log(`FAIL  ${id}  ${name}  → ${String((e && e.stack) || e).replace(/\s+/g, ' ').slice(0, 600)}`); }
}
const neg = (label, cond) => { assert.ok(cond, 'negative control: ' + label); NEG++; };
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
function withDb(url, db, user) {
  const u = new URL(url); u.pathname = '/' + db; if (user) { u.username = user; u.password = ''; } return u.toString();
}

let gw = null;
async function startGw(pgUrl, platformUrl) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server/gateway.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), HOST: '127.0.0.1', PGURL: pgUrl, GW_SECRET: SECRET, GW_INSTANCE: 't121',
      PAYESH_PLATFORM_PGURL: platformUrl, PAYESH_PLATFORM_TOKEN_SECRET: PSECRET,
      GW_QUOTA_MAX: '100000', GW_QUOTA_WINDOW_SEC: '3600', PAYESH_LOG: '0', GW_ACCESS_LOG: '0',
      PAYESH_FEATURE_KILL: '', PAYESH_CLIENT_KILL: '', GW_TENANT_QUOTA_MAX: '', GW_CELL: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.err = '';
  child.stderr.on('data', d => { child.err += String(d); });
  child.stdout.on('data', () => {});
  child.dead = false;
  child.on('exit', () => { child.dead = true; });
  child.base = 'http://127.0.0.1:' + port;
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(child.base + '/readyz'); if (r.ok) break; } catch (e) { /* not up */ }
    if (child.dead || Date.now() - t0 > 20000) throw new Error('gateway did not start: ' + child.err.slice(0, 300));
    await sleep(100);
  }
  return child;
}
async function http(method, p, { token, body, device } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  if (device) headers['x-device-id'] = device;
  const r = await fetch(gw.base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch (e) { data = null; }
  return { status: r.status, data };
}
async function pullAll(token, device) {
  const rows = [];
  let since = 0;
  for (;;) {
    const r = await http('GET', '/api/gw/v1/pull?limit=500&since_seq=' + since, { token, device });
    assert.strictEqual(r.status, 200, 'pull ' + JSON.stringify(r.data));
    rows.push(...r.data.rows);
    if (!r.data.more) break;
    since = r.data.next_seq;
  }
  return rows;
}
const claimsOf = (t) => JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8'));

(async () => {
  const root = new Client({ connectionString: ADMIN });
  await root.connect();
  await root.query(`CREATE DATABASE ${DB}`);
  const adminUrl = withDb(ADMIN, DB);
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  let exitCode = 1;
  try {
    await tenancy.migrate(admin);
    for (const f of ['001_owner_panel.up.sql', '002_owner_panel_api.up.sql', '003_tenant_deletion.up.sql',
      '004_owner_login.up.sql', '005_tenant_provisioning.up.sql']) {
      await admin.query(fs.readFileSync(path.join(MIG, f), 'utf8'));
    }
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PLATFORM_LOGIN}') THEN
        CREATE ROLE ${PLATFORM_LOGIN} LOGIN INHERIT NOSUPERUSER NOBYPASSRLS;
      END IF; END $$`);
    await admin.query(`GRANT payesh_platform_runtime TO ${PLATFORM_LOGIN}`);
    const U = { owner: crypto.randomUUID(), operator: crypto.randomUUID() };
    await admin.query(`INSERT INTO owner_platform.platform_users(id,login_id,role,status) VALUES
      ($1,'owner-121','platform_owner','active'), ($2,'operator-121','platform_operator','active')`, [U.owner, U.operator]);
    await admin.query(`INSERT INTO owner_platform.plans(code,name,max_users,storage_mb) VALUES ('basic','پایه',100,1024)`);
    gw = await startGw(withDb(RUNTIME, DB), withDb(ADMIN, DB, PLATFORM_LOGIN));
    const ptok = (sub, role) => platformApi.signPlatformToken({ sub, role, iat: Date.now(), exp: Date.now() + 3600_000, jti: crypto.randomUUID() }, PSECRET);
    const PT = { owner: ptok(U.owner, 'platform_owner'), operator: ptok(U.operator, 'platform_operator'),
      forged: ptok(U.operator, 'platform_owner') };
    const reason = 'قرارداد امضاشده و درخواست کتبی مدیر مدرسه';
    const S = {};
    const sa = 'alborz-' + crypto.randomBytes(2).toString('hex');
    const sb = 'zagros-' + crypto.randomBytes(2).toString('hex');

    await test('T121-E01', 'owner creates two schools → two dedicated tenants, active, one-time codes', async () => {
      for (const [k, slug, mgr] of [['A', sa, 'مدیر البرز'], ['B', sb, 'مدیر زاگرس']]) {
        const op = crypto.randomUUID();
        const r = await http('POST', '/api/platform/v1/tenants', { token: PT.owner,
          body: { provision_op_id: op, slug, display_name: 'مدرسهٔ ' + k, manager_name: mgr, plan_code: 'basic', reason } });
        assert.strictEqual(r.status, 201, JSON.stringify(r.data));
        assert.strictEqual(r.data.tenant.status, 'active');
        assert.ok(/^[A-Z2-7]{32}$/.test(r.data.manager.activation_code), 'code shape');
        S[k] = { tid: r.data.tenant.tenant_id, slug, op, code: r.data.manager.activation_code, mgr };
      }
      assert.notStrictEqual(S.A.tid, S.B.tid);
      const st = await admin.query(`SELECT tenant_id::text, status FROM owner_platform.subscriptions WHERE tenant_id = ANY($1::uuid[]) ORDER BY 1`, [[S.A.tid, S.B.tid]]);
      assert.deepStrictEqual(st.rows.map(r => r.status), ['active', 'active']);
      const users = await admin.query(`SELECT tenant_id::text AS t, data->>'role' AS role, data->>'name' AS name FROM product_records WHERE collection='users' ORDER BY 2`);
      assert.strictEqual(users.rows.length, 2, 'one manager per school');
      for (const k of ['A', 'B']) assert.ok(users.rows.some(r => r.t === S[k].tid && r.role === 'manager' && r.name === S[k].mgr));
      const stored = await admin.query(`SELECT secret_hash FROM gw_credential`);
      neg('only hashes stored — the raw code is nowhere in gw_credential',
        stored.rows.every(r => r.secret_hash !== S.A.code && r.secret_hash !== S.B.code && /^[0-9a-f]{64}$/.test(r.secret_hash)));
      return `A=${S.A.tid.slice(0, 8)}… B=${S.B.tid.slice(0, 8)}…`;
    });

    await test('T121-E02', 'initial manager activates → school token (tid A, role manager from DB); code is one-time', async () => {
      const wrongSchool = await http('POST', '/api/gw/v1/session/activate', { body: { school: S.B.slug, code: S.A.code, device_id: 'mgr-a-phone' } });
      neg('A\'s code at school B ⇒ 401', wrongSchool.status === 401);
      const ghost = await http('POST', '/api/gw/v1/session/activate', { body: { school: 'no-such-school', code: S.A.code, device_id: 'mgr-a-phone' } });
      neg('unknown slug ⇒ same 401 body as a bad code (no school enumeration)',
        ghost.status === 401 && JSON.stringify(ghost.data) === JSON.stringify(wrongSchool.data));
      const r = await http('POST', '/api/gw/v1/session/activate', { body: { school: S.A.slug, code: S.A.code, device_id: 'mgr-a-phone' } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.data));
      const c = claimsOf(r.data.token);
      assert.deepStrictEqual([c.tid, c.role, c.uid, c.did], [S.A.tid, 'manager', 1, 'mgr-a-phone']);
      S.A.mtok = r.data.token; S.A.mdev = r.data.device_secret;
      const reuse = await http('POST', '/api/gw/v1/session/activate', { body: { school: S.A.slug, code: S.A.code, device_id: 'thief' } });
      neg('code reuse ⇒ 401', reuse.status === 401);
      const rb = await http('POST', '/api/gw/v1/session/activate', { body: { school: S.B.slug, code: S.B.code, device_id: 'mgr-b-phone' } });
      assert.strictEqual(rb.status, 200);
      S.B.mtok = rb.data.token;
      return 'manager A + manager B activated';
    });

    await test('T121-E03', 'manager A creates a teacher + data in the same school; teacher activates in A and reads A', async () => {
      const push = await http('POST', '/api/gw/v1/push', { token: S.A.mtok, device: 'mgr-a-phone', body: { ops: [
        { uid: 'u121-1', collection: 'users', id: 2, type: 'put', data: { id: 2, name: 'معلم البرز', role: 'teacher', active: true }, base_version: 0 },
        { uid: 'u121-2', collection: 'announcements', id: 1, type: 'put', data: { title: 'اطلاعیهٔ البرز' }, base_version: 0 },
      ] } });
      assert.strictEqual(push.status, 200, JSON.stringify(push.data));
      assert.strictEqual(push.data.applied.length, 2);
      const code = await http('POST', '/api/gw/v1/admin/activation-codes', { token: S.A.mtok, device: 'mgr-a-phone', body: { uid: 2 } });
      assert.strictEqual(code.status, 201, JSON.stringify(code.data));
      assert.strictEqual(code.data.role, 'teacher');
      const t = await http('POST', '/api/gw/v1/session/activate', { body: { school: S.A.slug, code: code.data.activation_code, device_id: 'tch-a-phone' } });
      assert.strictEqual(t.status, 200, JSON.stringify(t.data));
      const c = claimsOf(t.data.token);
      assert.deepStrictEqual([c.tid, c.role, c.uid], [S.A.tid, 'teacher', 2]);
      S.A.ttok = t.data.token; S.A.tdev = t.data.device_secret;
      const rows = await pullAll(S.A.ttok, 'tch-a-phone');
      assert.ok(rows.some(r => r.collection === 'announcements' && r.data && r.data.title === 'اطلاعیهٔ البرز'), 'teacher reads A');
      const dbRows = await admin.query(`SELECT count(*)::int AS n FROM product_records WHERE tenant_id=$1 AND collection='users'`, [S.A.tid]);
      assert.strictEqual(dbRows.rows[0].n, 2, 'users created in tenant A only');
      return `teacher pulled ${rows.length} rows of A`;
    });

    await test('T121-E04', 'cross-school: B\'s manager sees 0 rows of A and cannot issue a code for A\'s user', async () => {
      const rows = await pullAll(S.B.mtok, 'mgr-b-phone');
      const leaked = rows.filter(r => JSON.stringify(r).includes('البرز'));
      neg('B pulls 0 rows of A', leaked.length === 0);
      assert.ok(rows.length >= 1 && rows.every(r => !(r.collection === 'users' && Number(r.record_id || r.id) === 2)), 'B sees only B');
      const x = await http('POST', '/api/gw/v1/admin/activation-codes', { token: S.B.mtok, device: 'mgr-b-phone', body: { uid: 2 } });
      neg('B manager → code for uid 2 (exists only in A) ⇒ 404', x.status === 404);
      const tRows = await pullAll(S.A.ttok, 'tch-a-phone');
      neg('A teacher pulls 0 rows of B', tRows.filter(r => JSON.stringify(r).includes('زاگرس')).length === 0);
      return `B_rows=${rows.length} rows_of_A_seen_by_B=${leaked.length}`;
    });

    await test('T121-E05', 'privilege: teacher cannot issue codes or promote itself; forged/expired tokens 401', async () => {
      const x = await http('POST', '/api/gw/v1/admin/activation-codes', { token: S.A.ttok, device: 'tch-a-phone', body: { uid: 2 } });
      neg('teacher issue code ⇒ 403 manager_only', x.status === 403 && x.data.error === 'manager_only');
      const promote = await http('POST', '/api/gw/v1/push', { token: S.A.ttok, device: 'tch-a-phone', body: { ops: [
        { uid: 'u121-esc', collection: 'users', id: 2, type: 'put', data: { id: 2, name: 'معلم البرز', role: 'manager', active: true }, base_version: 1 }] } });
      neg('teacher self-promotion push ⇒ 403', promote.status === 403);
      const role = await admin.query(`SELECT data->>'role' AS r FROM product_records WHERE tenant_id=$1 AND collection='users' AND record_id=2`, [S.A.tid]);
      neg('role unchanged in DB', role.rows[0].r === 'teacher');
      const forged = tenancy.signToken({ tid: S.A.tid, role: 'manager', uid: 1, did: 'x', iat: Date.now(), exp: Date.now() + 60000 }, 'wrong-secret-' + 'x'.repeat(16));
      neg('token signed with another secret ⇒ 401', (await http('GET', '/api/gw/v1/pull', { token: forged, device: 'x' })).status === 401);
      const expired = tenancy.signToken({ tid: S.A.tid, role: 'manager', uid: 1, did: 'x', iat: Date.now() - 7200000, exp: Date.now() - 1000 }, SECRET);
      neg('expired token ⇒ 401', (await http('GET', '/api/gw/v1/pull', { token: expired, device: 'x' })).status === 401);
    });

    await test('T121-E06', 'refresh: device secret → token (role re-read); deactivated user → refresh 401', async () => {
      const ok = await http('POST', '/api/gw/v1/session/refresh', { body: { school: S.A.slug, device_id: 'tch-a-phone', device_secret: S.A.tdev } });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.data));
      assert.strictEqual(claimsOf(ok.data.token).role, 'teacher');
      neg('refresh with another device id ⇒ 401',
        (await http('POST', '/api/gw/v1/session/refresh', { body: { school: S.A.slug, device_id: 'other', device_secret: S.A.tdev } })).status === 401);
      neg('refresh at another school ⇒ 401',
        (await http('POST', '/api/gw/v1/session/refresh', { body: { school: S.B.slug, device_id: 'tch-a-phone', device_secret: S.A.tdev } })).status === 401);
      const off = await http('POST', '/api/gw/v1/push', { token: S.A.mtok, device: 'mgr-a-phone', body: { ops: [
        { uid: 'u121-off', collection: 'users', id: 2, type: 'put', data: { id: 2, name: 'معلم البرز', role: 'teacher', active: false }, base_version: 1 }] } });
      assert.strictEqual(off.status, 200, JSON.stringify(off.data));
      neg('deactivated teacher ⇒ refresh 401',
        (await http('POST', '/api/gw/v1/session/refresh', { body: { school: S.A.slug, device_id: 'tch-a-phone', device_secret: S.A.tdev } })).status === 401);
      const mgr = await http('POST', '/api/gw/v1/session/refresh', { body: { school: S.A.slug, device_id: 'mgr-a-phone', device_secret: S.A.mdev } });
      assert.strictEqual(mgr.status, 200);
    });

    await test('T121-E07', 'data layer: runtime with tenant B sees 0 rows of A; permissive-policy mutant is detected', async () => {
      const rt = new Client({ connectionString: withDb(RUNTIME, DB) });
      await rt.connect();
      const probe = async (c, tid) => {
        await c.query('BEGIN');
        await c.query("select set_config('app.tenant_id', $1, true)", [tid]);
        const n = {};
        for (const t of ['gw_school', 'gw_credential', 'product_records']) {
          n[t] = (await c.query(`select count(*)::int as n from ${t} where tenant_id = $1`, [S.A.tid])).rows[0].n;
        }
        await c.query('COMMIT');
        return n;
      };
      const asB = await probe(rt, S.B.tid);
      neg('runtime (tenant B) sees 0 rows of A', asB.gw_school === 0 && asB.gw_credential === 0 && asB.product_records === 0);
      const asA = await probe(rt, S.A.tid);
      assert.ok(asA.gw_school === 1 && asA.gw_credential > 0 && asA.product_records > 0, 'probe sees A as A: ' + JSON.stringify(asA));
      const noTenant = (await rt.query('select count(*)::int as n from gw_credential')).rows[0].n;
      neg('no tenant context ⇒ 0 credential rows', noTenant === 0);
      neg('slug resolver returns one id, not a list', (await rt.query('select gw_resolve_school($1) as t', [S.A.slug])).rows[0].t === S.A.tid);
      /* negative control: break isolation inside a transaction that is rolled back */
      /* the mutant must be visible to another session → create it, probe, drop it in finally */
      await admin.query('CREATE POLICY t121_mutant ON gw_credential FOR SELECT TO payesh_runtime USING (true)');
      const leakC = new Client({ connectionString: withDb(RUNTIME, DB) });
      await leakC.connect();
      let leak;
      try { leak = await probe(leakC, S.B.tid); } finally {
        await admin.query('DROP POLICY IF EXISTS t121_mutant ON gw_credential');
        await leakC.end();
      }
      neg('mutant (permissive policy) ⇒ probe sees A\'s credentials (control discriminates)', leak.gw_credential > 0);
      const after = await probe(rt, S.B.tid);
      neg('policy restored ⇒ 0 again', after.gw_credential === 0);
      await rt.end();
      return `B_sees_A=${JSON.stringify(asB)} mutant_sees=${leak.gw_credential}`;
    });

    await test('T121-E08', 'platform controls over HTTP: operator/forged 403, short reason 400, replay 200 without new code', async () => {
      const body = (over) => Object.assign({ provision_op_id: crypto.randomUUID(), slug: 'dena-' + crypto.randomBytes(2).toString('hex'),
        display_name: 'مدرسهٔ دنا', manager_name: 'مدیر دنا', plan_code: 'basic', reason }, over || {});
      const op = await http('POST', '/api/platform/v1/tenants', { token: PT.operator, body: body() });
      neg('operator ⇒ 403', op.status === 403);
      const fg = await http('POST', '/api/platform/v1/tenants', { token: PT.forged, body: body() });
      neg('forged owner claim ⇒ 403 (data layer 42501)', fg.status === 403 && fg.data.data_layer === '42501');
      neg('short reason ⇒ 400', (await http('POST', '/api/platform/v1/tenants', { token: PT.owner, body: body({ reason: 'کم' }) })).status === 400);
      neg('school token is not a platform token ⇒ 401',
        (await http('POST', '/api/platform/v1/tenants', { token: S.A.mtok, body: body() })).status === 401);
      const rep = await http('POST', '/api/platform/v1/tenants', { token: PT.owner,
        body: { provision_op_id: S.A.op, slug: S.A.slug, display_name: 'مدرسهٔ A', manager_name: S.A.mgr, plan_code: 'basic', reason } });
      neg('replay of A\'s op ⇒ 200 same tenant, manager already active ⇒ no new code',
        rep.status === 200 && rep.data.tenant.tenant_id === S.A.tid && rep.data.manager.activated === true && rep.data.manager.activation_code === null);
      const n = await admin.query(`SELECT count(*)::int AS n FROM owner_platform.tenant_registry`);
      neg('refusals created no tenant', n.rows[0].n === 2);
      const managers = await admin.query(`SELECT count(*)::int AS n FROM product_records WHERE tenant_id=$1 AND collection='users' AND data->>'role'='manager'`, [S.A.tid]);
      neg('replay created no second manager', managers.rows[0].n === 1);
      const audit = await admin.query(`SELECT action FROM owner_platform.platform_audit WHERE tenant_id = ANY($1::uuid[]) ORDER BY sequence_id`, [[S.A.tid, S.B.tid]]);
      assert.deepStrictEqual(audit.rows.map(r => r.action), ['tenant.provision', 'tenant.activate', 'tenant.provision', 'tenant.activate']);
      const dump = JSON.stringify((await admin.query('SELECT details FROM owner_platform.platform_audit')).rows);
      neg('no activation code in platform audit', !dump.includes(S.A.code) && !dump.includes(S.B.code));
    });

    assert.strictEqual(gw.dead, false, 'gateway must survive the run');
    console.log(`TENANT-121 passed=${PASS} failed=${FAIL} negative_controls=${NEG}`);
    exitCode = FAIL ? 1 : 0;
  } catch (e) {
    console.log('FAIL  T121-SETUP  ' + String((e && e.stack) || e).replace(/\s+/g, ' ').slice(0, 600));
    exitCode = 1;
  } finally {
    if (gw && !gw.dead) gw.kill('SIGTERM');
    await sleep(300);
    await admin.end().catch(() => {});
    await root.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
    await root.end().catch(() => {});
  }
  process.exit(exitCode);
})();
