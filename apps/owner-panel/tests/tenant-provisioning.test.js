'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 121 — create a school from the owner panel (migration 005 + POST /tenants), platform half.
   PGlite + migrations 001..005; the real platform API with the runtime role (SET LOCAL ROLE).
   The school half (users#1 manager, activation, cross-school 0 rows) runs on real PostgreSQL in
   tests/tenant-121.js; here the school side is a recording hook so the saga can be driven
   through every failure point. Every negative control is counted.
   ═══════════════════════════════════════════════════════════════════ */
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const api = require('../server/platform-api');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const MIG = path.join(ROOT, 'db', 'migrations', 'owner-panel');
const SECRET = crypto.randomBytes(32).toString('hex');
const P = '/api/platform/v1';
const read = f => fs.readFileSync(path.join(MIG, f), 'utf8');

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

async function flow() {
  const hadWindow = Object.prototype.hasOwnProperty.call(global, 'window');
  const previousWindow = global.window;
  if (hadWindow) delete global.window;
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  let checks = 0;
  const negative = (label, cond) => { checks++; assert.ok(cond, 'negative control: ' + label); };
  try {
    for (const f of ['001_owner_panel.up.sql', '002_owner_panel_api.up.sql', '003_tenant_deletion.up.sql',
      '004_owner_login.up.sql', '005_tenant_provisioning.up.sql']) await db.exec(read(f));
    const id = () => crypto.randomUUID();
    const U = { owner: id(), operator: id(), support: id(), disabledOwner: id() };
    for (const [uid, login, role, status] of [[U.owner, 'owner-1', 'platform_owner', 'active'],
      [U.operator, 'operator-1', 'platform_operator', 'active'], [U.support, 'support-1', 'platform_support', 'active'],
      [U.disabledOwner, 'owner-x', 'platform_owner', 'disabled']]) {
      await db.query('INSERT INTO owner_platform.platform_users(id,login_id,role,status) VALUES ($1,$2,$3,$4)', [uid, login, role, status]);
    }
    await db.query(`INSERT INTO owner_platform.plans(code,name,max_users,max_students,storage_mb) VALUES ('basic','پایه',50,600,1024)`);
    await db.query(`INSERT INTO owner_platform.plans(code,name,storage_mb,archived_at) VALUES ('old','قدیمی',10,now())`);

    /* recording school-side hook; fail on demand */
    const calls = [];
    let failNext = null;
    const provisioner = async (args) => {
      calls.push(args);
      if (failNext) { const e = failNext; failNext = null; throw e; }
      return { manager_uid: 1, manager_activated: false, activation_code: 'CODE' + calls.length + 'X'.repeat(27) };
    };
    const platform = api.createPlatformApi({ db: adapter(db), secret: SECRET, rateLimitMax: 1000, schoolProvisioner: provisioner });
    const bare = api.createPlatformApi({ db: adapter(db), secret: SECRET, rateLimitMax: 1000 });
    const tok = (sub, role) => api.signPlatformToken({ sub, role, iat: Date.now(), exp: Date.now() + 3600_000, jti: id() }, SECRET);
    const T = { owner: tok(U.owner, 'platform_owner'), operator: tok(U.operator, 'platform_operator'),
      support: tok(U.support, 'platform_support'), disabledOwner: tok(U.disabledOwner, 'platform_owner'),
      forgedOwner: tok(U.operator, 'platform_owner') };
    const call = (p, t, body) => p.dispatch({ method: 'POST', path: P + '/tenants',
      headers: t ? { authorization: 'Bearer ' + t } : {}, body: body || {} });
    const reason = 'قرارداد امضاشده با مدرسه و درخواست کتبی مدیر';
    const req = (over) => Object.assign({ provision_op_id: id(), slug: 'school-a', display_name: 'دبیرستان الف',
      manager_name: 'مدیر الف', plan_code: 'basic', reason }, over || {});
    const count = async (sql, p) => Number((await db.query(sql, p || [])).rows[0].n);
    const registryN = () => count('SELECT count(*)::int AS n FROM owner_platform.tenant_registry');
    const subsN = () => count('SELECT count(*)::int AS n FROM owner_platform.subscriptions');

    /* ── refusals before any write ─────────────────────────────────────── */
    negative('no token ⇒ 401', (await call(platform, null, req())).status === 401);
    const op = await call(platform, T.operator, req());
    negative('operator ⇒ 403 role_forbidden', op.status === 403 && op.body.error === 'role_forbidden');
    negative('support ⇒ 403', (await call(platform, T.support, req())).status === 403);
    const forged = await call(platform, T.forgedOwner, req());
    negative('operator with signed owner claim ⇒ 403 at data layer (require_actor)', forged.status === 403 && forged.body.data_layer === '42501');
    negative('disabled owner ⇒ 403', (await call(platform, T.disabledOwner, req())).status === 403);
    negative('short reason ⇒ 400', (await call(platform, T.owner, req({ reason: 'کوتاه' }))).body.error === 'reason_too_short');
    negative('missing op id ⇒ 400', (await call(platform, T.owner, req({ provision_op_id: '' }))).body.error === 'invalid_provision_op_id');
    negative('bad slug ⇒ 400', (await call(platform, T.owner, req({ slug: 'A B' }))).body.error === 'invalid_slug');
    negative('no manager name ⇒ 400', (await call(platform, T.owner, req({ manager_name: '' }))).body.error === 'invalid_manager_name');
    negative('unknown plan ⇒ 400', (await call(platform, T.owner, req({ plan_code: 'nope' }))).status === 400);
    negative('archived plan ⇒ 400', (await call(platform, T.owner, req({ plan_code: 'old' }))).status === 400);
    const nc = await call(bare, T.owner, req());
    negative('no school-side hook ⇒ 503, nothing written', nc.status === 503 && nc.body.error === 'school_provisioning_not_configured');
    negative('refusals wrote nothing', (await registryN()) === 0 && (await subsN()) === 0 && calls.length === 0);

    /* direct table access by the runtime role is closed; only the SECURITY DEFINER function writes */
    await db.exec('SET ROLE payesh_platform_runtime');
    const directIns = await sqlRejects(db, `INSERT INTO owner_platform.tenant_registry(slug,display_name,provision_op_id,plan_code,created_by)
      VALUES ('x-school','x',$1,'basic',$2)`, [id(), U.owner], /42501|permission/i);
    const noActor = await sqlRejects(db, `SELECT owner_platform.provision_tenant($1,'y-school','y','basic')`, [id()], /42501|actor/i);
    await db.exec('RESET ROLE');
    negative('runtime cannot INSERT into tenant_registry directly', directIns);
    negative('provision_tenant without actor context ⇒ 42501', noActor);

    /* ── happy path ────────────────────────────────────────────────────── */
    const OP = id();
    const a = await call(platform, T.owner, req({ provision_op_id: OP }));
    assert.strictEqual(a.status, 201, 'owner create: ' + JSON.stringify(a.body));
    const TA = a.body.tenant.tenant_id;
    assert.ok(/^[0-9a-f-]{36}$/.test(TA) && a.body.tenant.status === 'active' && a.body.tenant.slug === 'school-a');
    assert.strictEqual(a.body.manager.uid, 1);
    assert.ok(a.body.manager.activation_code, 'one-time code returned to the owner');
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual({ t: calls[0].tenantId, s: calls[0].slug, m: calls[0].managerName },
      { t: TA, s: 'school-a', m: 'مدیر الف' }, 'school hook receives the new tenant');
    const sub = (await db.query('SELECT status FROM owner_platform.subscriptions WHERE tenant_id=$1', [TA])).rows;
    assert.deepStrictEqual(sub.map(r => r.status), ['active'], 'subscription draft→provisioning→active');
    const ev = (await db.query('SELECT from_status, to_status FROM owner_platform.subscription_event WHERE tenant_id=$1 ORDER BY occurred_at', [TA])).rows;
    assert.deepStrictEqual(ev.map(r => (r.from_status || '∅') + '→' + r.to_status), ['∅→provisioning', 'provisioning→active']);
    const lim = (await db.query('SELECT max_users, max_students, storage_bytes FROM owner_platform.tenant_limits WHERE tenant_id=$1', [TA])).rows[0];
    assert.deepStrictEqual([lim.max_users, lim.max_students, Number(lim.storage_bytes)], [50, 600, 1024 * 1048576]);
    const audit = (await db.query('SELECT action, reason, details FROM owner_platform.platform_audit WHERE tenant_id=$1 ORDER BY sequence_id', [TA])).rows;
    assert.deepStrictEqual(audit.map(r => r.action), ['tenant.provision', 'tenant.activate']);
    assert.ok(audit.every(r => r.reason === reason));
    negative('activation code never written to audit',
      !JSON.stringify(audit).includes(a.body.manager.activation_code));
    const list = await platform.dispatch({ method: 'GET', path: P + '/tenants', headers: { authorization: 'Bearer ' + T.owner } });
    assert.ok(list.body.tenants.some(t => t.tenant_id === TA), 'new school listed in the panel');

    /* ── idempotency (16b §1.4) ────────────────────────────────────────── */
    const again = await call(platform, T.owner, req({ provision_op_id: OP }));
    negative('replay of the same op ⇒ 200, same tenant, no second subscription',
      again.status === 200 && again.body.idempotent === true && again.body.tenant.tenant_id === TA
      && (await count('SELECT count(*)::int AS n FROM owner_platform.subscriptions WHERE tenant_id=$1', [TA])) === 1
      && (await registryN()) === 1);
    negative('replay adds no audit rows',
      (await count('SELECT count(*)::int AS n FROM owner_platform.platform_audit WHERE tenant_id=$1', [TA])) === 2);
    negative('same op id for another slug ⇒ 409',
      (await call(platform, T.owner, req({ provision_op_id: OP, slug: 'school-z' }))).status === 409);
    negative('same slug with a new op id ⇒ 409 (one slug, one tenant forever)',
      (await call(platform, T.owner, req())).status === 409 && (await registryN()) === 1);

    /* ── saga: school side fails → stays provisioning, retry converges ─── */
    const OPB = id();
    failNext = Object.assign(new Error('school db down'), { status: 503 });
    const bFail = await call(platform, T.owner, req({ provision_op_id: OPB, slug: 'school-b', display_name: 'دبستان ب', manager_name: 'مدیر ب' }));
    negative('school side down ⇒ 502 with tenant left in provisioning',
      bFail.status === 502 && bFail.body.error === 'school_provisioning_failed' && bFail.body.status === 'provisioning');
    const TB = bFail.body.tenant_id;
    const bState = (await db.query('SELECT r.status AS rs, s.status AS ss FROM owner_platform.tenant_registry r JOIN owner_platform.subscriptions s USING (tenant_id) WHERE tenant_id=$1', [TB])).rows[0];
    negative('half-provisioned school is not active', bState.rs === 'provisioning' && bState.ss === 'provisioning');
    const bOk = await call(platform, T.owner, req({ provision_op_id: OPB, slug: 'school-b', display_name: 'دبستان ب', manager_name: 'مدیر ب' }));
    negative('retry with the same op ⇒ same tenant, now active',
      bOk.status === 200 && bOk.body.tenant.tenant_id === TB && bOk.body.tenant.status === 'active'
      && (await count('SELECT count(*)::int AS n FROM owner_platform.subscriptions WHERE tenant_id=$1', [TB])) === 1);
    assert.notStrictEqual(TA, TB, 'each school gets its own tenant id');

    /* activate_tenant: owner only */
    await db.query("SELECT set_config('app.platform_user_id', $1, false)", [U.operator]);
    negative('operator cannot call activate_tenant', await sqlRejects(db, 'SELECT owner_platform.activate_tenant($1)', [TB], /42501|not allowed/i));
    await db.query("SELECT set_config('app.platform_user_id', '', false)");

    /* migration 005 rollback is clean and reversible */
    await db.exec(read('005_tenant_provisioning.down.sql'));
    negative('after 005 down, POST /tenants fails closed (no registry function)',
      (await call(platform, T.owner, req({ provision_op_id: id(), slug: 'school-c' }))).status >= 400);
    await db.exec(read('005_tenant_provisioning.up.sql'));
    return { negative_controls: checks, tenants: 2 };
  } finally {
    await db.close();
    if (hadWindow) global.window = previousWindow;
  }
}

module.exports = { flow };
if (require.main === module) {
  flow().then((r) => { console.log('TENANT-PROVISIONING-121 negative_controls=' + r.negative_controls + ' failures=0'); })
    .catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
}
