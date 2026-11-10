'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۹۸ — حذف دومرحله‌ای مدرسه (migration 003 + API)
   مبنا: 12b §100 (owner + تأیید دوم + تأخیر ۲۴ ساعته)، D-22 (حفظ ≥۱۸۰ روز)

   PGlite + migrations 001/002/003؛ API واقعی با نقش runtime (SET LOCAL ROLE).
   هر کنترل منفی شمارش می‌شود. گذر زمان با عقب‌بردن approved_at/not_before
   به‌صورت superuser شبیه‌سازی می‌شود؛ CHECK همچنان «not_before ≥ approved_at+24h»
   را نگه می‌دارد و کوتاه‌کردن مهلت را رد می‌کند (کنترل جدا).
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
    await db.exec(read('001_owner_panel.up.sql'));
    await db.exec(read('002_owner_panel_api.up.sql'));
    await db.exec(read('003_tenant_deletion.up.sql'));

    const id = () => crypto.randomUUID();
    const U = { owner: id(), owner2: id(), operator: id(), support: id(), disabledOwner: id() };
    for (const [uid, login, role, status] of [[U.owner, 'owner-1', 'platform_owner', 'active'],
      [U.owner2, 'owner-2', 'platform_owner', 'active'], [U.operator, 'operator-1', 'platform_operator', 'active'],
      [U.support, 'support-1', 'platform_support', 'active'], [U.disabledOwner, 'owner-x', 'platform_owner', 'disabled']]) {
      await db.query('INSERT INTO owner_platform.platform_users(id,login_id,role,status) VALUES ($1,$2,$3,$4)', [uid, login, role, status]);
    }
    await db.query(`INSERT INTO owner_platform.plans(code,name,storage_mb) VALUES ('basic','پایه',1024)`);
    const A = id(), B = id(), C = id(), GHOST = id();
    for (const t of [A, B, C]) {
      await db.query(`INSERT INTO owner_platform.subscriptions (tenant_id,plan_code,status,starts_at,ends_at)
        VALUES ($1,'basic','active',now()-interval '1 day',now()+interval '30 days')`, [t]);
    }

    const platform = api.createPlatformApi({ db: adapter(db), secret: SECRET, rateLimitMax: 1000 });
    const tok = (sub, role) => api.signPlatformToken({ sub, role, iat: Date.now(), exp: Date.now() + 3600_000, jti: id() }, SECRET);
    const T = { owner: tok(U.owner, 'platform_owner'), owner2: tok(U.owner2, 'platform_owner'),
      operator: tok(U.operator, 'platform_operator'), support: tok(U.support, 'platform_support'),
      disabledOwner: tok(U.disabledOwner, 'platform_owner'),
      /* operator با claim جعلیِ owner که درست امضا شده: نقش واقعی از جدول خوانده می‌شود */
      forgedOwner: tok(U.operator, 'platform_owner') };
    const call = (method, sub, t, body) => platform.dispatch({ method, path: P + sub,
      headers: t ? { authorization: 'Bearer ' + t } : {}, body: body || {} });
    const reason = 'پایان قرارداد و درخواست کتبی مدیر مدرسه';

    /* ── حذف فوری همچنان بسته است ─────────────────────────────────────── */
    const del = await call('DELETE', `/tenants/${A}`, T.owner);
    negative('immediate DELETE stays 403 even for owner', del.status === 403 && del.body.error === 'tenant_deletion_disabled');

    /* ── درخواست ─────────────────────────────────────────────────────── */
    negative('operator cannot request deletion',
      (await call('POST', `/tenants/${A}/deletion-request`, T.operator, { reason, confirm_tenant_id: A })).status === 403);
    negative('support cannot request deletion',
      (await call('POST', `/tenants/${A}/deletion-request`, T.support, { reason, confirm_tenant_id: A })).status === 403);
    const forged = await call('POST', `/tenants/${A}/deletion-request`, T.forgedOwner, { reason, confirm_tenant_id: A });
    negative('operator with signed owner claim is stopped by require_actor', forged.status === 403 && forged.body.data_layer === '42501');
    negative('disabled owner cannot request',
      (await call('POST', `/tenants/${A}/deletion-request`, T.disabledOwner, { reason, confirm_tenant_id: A })).status === 403);
    negative('short reason rejected',
      (await call('POST', `/tenants/${A}/deletion-request`, T.owner, { reason: 'کوتاه', confirm_tenant_id: A })).body.error === 'reason_too_short');
    negative('missing retype rejected',
      (await call('POST', `/tenants/${A}/deletion-request`, T.owner, { reason })).body.error === 'confirm_mismatch');
    negative('retype of another tenant rejected',
      (await call('POST', `/tenants/${A}/deletion-request`, T.owner, { reason, confirm_tenant_id: B })).body.error === 'confirm_mismatch');
    negative('unknown tenant rejected at data layer',
      (await call('POST', `/tenants/${GHOST}/deletion-request`, T.owner, { reason, confirm_tenant_id: GHOST })).status === 403);
    await db.exec('SET ROLE payesh_platform_runtime');
    const directInsert = await sqlRejects(db, `INSERT INTO owner_platform.tenant_deletion_request(tenant_id,requested_by,reason)
      VALUES ($1,$2,$3)`, [A, U.owner, reason], /42501|permission/i);
    const directUpdate = await sqlRejects(db, `UPDATE owner_platform.subscriptions SET status='canceled' WHERE tenant_id=$1`,
      [A], /42501|permission/i);
    await db.exec('RESET ROLE');
    negative('runtime role cannot INSERT a deletion request directly', directInsert);
    negative('runtime role cannot cancel a subscription directly', directUpdate);

    const req = await call('POST', `/tenants/${A}/deletion-request`, T.owner, { reason, confirm_tenant_id: A });
    assert.strictEqual(req.status, 201, 'owner request accepted: ' + JSON.stringify(req.body));
    const RID = req.body.request.id;
    assert.strictEqual(req.body.request.status, 'pending');
    assert.strictEqual(req.body.request.not_before, null, 'no execution time before approval');
    negative('second open request for same tenant ⇒ 409',
      (await call('POST', `/tenants/${A}/deletion-request`, T.owner2, { reason, confirm_tenant_id: A })).status === 409);

    /* ── اجرا پیش از تأیید ممنوع ─────────────────────────────────────── */
    negative('execute while pending ⇒ 403',
      (await call('POST', `/tenant-deletions/${RID}/execute`, T.owner2)).status === 403);

    /* ── تأیید (چهارچشم) ─────────────────────────────────────────────── */
    const self = await call('POST', `/tenant-deletions/${RID}/approve`, T.owner);
    negative('requester cannot approve own request (API)', self.status === 403 && self.body.error === 'four_eyes_required');
    await db.query("SELECT set_config('app.platform_user_id', $1, false)", [U.owner]);
    negative('requester cannot approve own request (SQL function)',
      await sqlRejects(db, `SELECT owner_platform.approve_tenant_deletion($1,$2)`, [RID, A], /42501|cannot approve/i));
    await db.query("SELECT set_config('app.platform_user_id', '', false)");
    negative('self-approval rejected by CHECK even for superuser',
      await sqlRejects(db, `UPDATE owner_platform.tenant_deletion_request SET status='approved', approved_by=requested_by,
        approved_at=now(), not_before=now()+interval '24 hours' WHERE id=$1`, [RID], /tenant_deletion_four_eyes_check|23514/));
    negative('operator cannot approve',
      (await call('POST', `/tenant-deletions/${RID}/approve`, T.operator)).status === 403);
    negative('operator with signed owner claim cannot approve',
      (await call('POST', `/tenant-deletions/${RID}/approve`, T.forgedOwner)).status === 403);

    const appr = await call('POST', `/tenant-deletions/${RID}/approve`, T.owner2);
    assert.strictEqual(appr.status, 200, 'second owner approves: ' + JSON.stringify(appr.body));
    const ap = appr.body.request;
    assert.strictEqual(ap.status, 'approved');
    assert.strictEqual(ap.approved_by, U.owner2);
    const delayMs = new Date(ap.not_before) - new Date(ap.approved_at);
    assert.ok(delayMs >= 24 * 3600_000 && delayMs < 24 * 3600_000 + 1000, 'not_before = approved_at + 24h, got ' + delayMs);
    negative('approving twice rejected',
      (await call('POST', `/tenant-deletions/${RID}/approve`, T.owner2)).status === 403);

    /* ── مهلت ۲۴ ساعته ───────────────────────────────────────────────── */
    const early = await call('POST', `/tenant-deletions/${RID}/execute`, T.owner);
    negative('execute before 24h ⇒ 409 deletion_delay_pending', early.status === 409 && early.body.error === 'deletion_delay_pending');
    await db.query("SELECT set_config('app.platform_user_id', $1, false)", [U.owner]);
    negative('execute before 24h rejected inside SQL function (API pre-check bypassed)',
      await sqlRejects(db, `SELECT owner_platform.execute_tenant_deletion($1,$2)`, [RID, A], /42501|24 hour/i));
    await db.query("SELECT set_config('app.platform_user_id', '', false)");
    negative('shortening the delay is rejected by CHECK even for superuser',
      await sqlRejects(db, `UPDATE owner_platform.tenant_deletion_request SET not_before = approved_at + interval '1 hour' WHERE id=$1`,
        [RID], /tenant_deletion_delay_check|23514/));
    negative('backdated execution (executed_at < not_before) rejected by CHECK',
      await sqlRejects(db, `UPDATE owner_platform.tenant_deletion_request SET status='executed', executed_by=$2,
        executed_at=approved_at, retain_until=approved_at+interval '200 days' WHERE id=$1`, [RID, U.owner], /tenant_deletion_not_early_check|23514/));
    const subStill = await db.query('SELECT status FROM owner_platform.subscriptions WHERE tenant_id=$1', [A]);
    negative('subscription untouched before execution', subStill.rows[0].status === 'active');

    /* گذر زمان: approved_at و not_before با هم ۲۵ ساعت عقب می‌روند (CHECK هنوز برقرار است) */
    await db.query(`UPDATE owner_platform.tenant_deletion_request
      SET approved_at = approved_at - interval '25 hours', not_before = not_before - interval '25 hours' WHERE id=$1`, [RID]);

    negative('operator cannot execute even after delay',
      (await call('POST', `/tenant-deletions/${RID}/execute`, T.operator)).status === 403);
    const ex = await call('POST', `/tenant-deletions/${RID}/execute`, T.owner);
    assert.strictEqual(ex.status, 200, 'execute after delay: ' + JSON.stringify(ex.body));
    const done = ex.body.request;
    assert.strictEqual(done.status, 'executed');
    assert.strictEqual(done.data_destroyed, false, 'no data destroyed');
    assert.strictEqual(done.subscriptions_canceled, 1);
    const keepMs = new Date(done.retain_until) - new Date(done.executed_at);
    assert.ok(keepMs >= 180 * 86400_000, 'retain_until ≥ executed_at + 180 days');
    const subAfter = await db.query('SELECT status, auto_renew FROM owner_platform.subscriptions WHERE tenant_id=$1', [A]);
    assert.strictEqual(subAfter.rows[0].status, 'canceled');
    assert.strictEqual(subAfter.rows[0].auto_renew, false);
    const evt = await db.query(`SELECT count(*)::int AS n FROM owner_platform.subscription_event
      WHERE tenant_id=$1 AND to_status='canceled' AND idempotency_key LIKE 'tenant-deletion:%'`, [A]);
    assert.strictEqual(evt.rows[0].n, 1, 'cancellation recorded in subscription_event');
    const otherTenant = await db.query('SELECT status FROM owner_platform.subscriptions WHERE tenant_id=$1', [B]);
    negative('other tenant unaffected', otherTenant.rows[0].status === 'active');
    negative('execute twice rejected',
      (await call('POST', `/tenant-deletions/${RID}/execute`, T.owner)).status === 403);
    negative('shortening retention below 180 days rejected by CHECK',
      await sqlRejects(db, `UPDATE owner_platform.tenant_deletion_request SET retain_until = executed_at + interval '30 days' WHERE id=$1`,
        [RID], /tenant_deletion_retention_check|23514/));

    /* ── لغو ─────────────────────────────────────────────────────────── */
    const rb = await call('POST', `/tenants/${B}/deletion-request`, T.owner2, { reason, confirm_tenant_id: B });
    const RB = rb.body.request.id;
    await call('POST', `/tenant-deletions/${RB}/approve`, T.owner);
    negative('cancel needs a reason',
      (await call('POST', `/tenant-deletions/${RB}/cancel`, T.owner, { reason: 'نه' })).body.error === 'reason_too_short');
    negative('operator cannot cancel',
      (await call('POST', `/tenant-deletions/${RB}/cancel`, T.operator, { reason })).status === 403);
    const cx = await call('POST', `/tenant-deletions/${RB}/cancel`, T.owner2, { reason: 'مدرسه قرارداد را تمدید کرد' });
    assert.strictEqual(cx.status, 200);
    assert.strictEqual(cx.body.request.status, 'canceled');
    await db.query(`UPDATE owner_platform.tenant_deletion_request
      SET approved_at = approved_at - interval '25 hours', not_before = not_before - interval '25 hours' WHERE id=$1`, [RB]);
    negative('canceled request can never execute, even after delay',
      (await call('POST', `/tenant-deletions/${RB}/execute`, T.owner)).status === 403);
    const subB = await db.query('SELECT status FROM owner_platform.subscriptions WHERE tenant_id=$1', [B]);
    negative('canceled request left subscription active', subB.rows[0].status === 'active');
    const again = await call('POST', `/tenants/${B}/deletion-request`, T.owner, { reason, confirm_tenant_id: B });
    assert.strictEqual(again.status, 201, 'a new request is possible after cancel');

    /* ── خواندن و ممیزی ─────────────────────────────────────────────── */
    negative('operator cannot list deletion requests', (await call('GET', '/tenant-deletions', T.operator)).status === 403);
    const list = await call('GET', '/tenant-deletions', T.owner);
    assert.strictEqual(list.status, 200);
    assert.ok(list.body.requests.length >= 3);
    assert.ok(list.body.requests.every(r => Object.keys(r).every(k => api.FIELDS.deletion.includes(k))), 'allowlisted fields only');
    const aud = await db.query(`SELECT action, actor_id::text AS actor FROM owner_platform.platform_audit
      WHERE action LIKE 'tenant.deletion.%' ORDER BY sequence_id`);
    const actions = aud.rows.map(r => r.action);
    for (const a of ['tenant.deletion.request', 'tenant.deletion.approve', 'tenant.deletion.execute', 'tenant.deletion.cancel']) {
      assert.ok(actions.includes(a), 'audit has ' + a);
    }
    const approveRow = aud.rows.find(r => r.action === 'tenant.deletion.approve');
    assert.strictEqual(approveRow.actor, U.owner2, 'approval audited under the second owner');
    const chain = await db.query(`SELECT encode(previous_hash,'hex') AS p, encode(event_hash,'hex') AS h
      FROM owner_platform.platform_audit ORDER BY sequence_id`);
    for (let i = 1; i < chain.rows.length; i++) assert.strictEqual(chain.rows[i].p, chain.rows[i - 1].h, 'audit chain continuous');
    negative('no failed attempt wrote an audit row (C unaffected)',
      !(await db.query(`SELECT 1 FROM owner_platform.platform_audit WHERE tenant_id=$1`, [C])).rows.length);

    /* ── privilegeها ─────────────────────────────────────────────────── */
    const priv = await db.query(`SELECT
      has_table_privilege('payesh_platform_runtime','owner_platform.tenant_deletion_request','INSERT') AS ins,
      has_table_privilege('payesh_platform_runtime','owner_platform.tenant_deletion_request','UPDATE') AS upd,
      has_table_privilege('payesh_platform_runtime','owner_platform.tenant_deletion_request','DELETE') AS del,
      has_table_privilege('payesh_platform_runtime','owner_platform.subscriptions','UPDATE') AS sub_upd`);
    negative('runtime has no write privilege on deletion table or subscriptions',
      !priv.rows[0].ins && !priv.rows[0].upd && !priv.rows[0].del && !priv.rows[0].sub_upd);

    /* ── معکوس‌پذیری 003 ─────────────────────────────────────────────── */
    await db.exec(read('003_tenant_deletion.down.sql'));
    const after = await db.query(`SELECT to_regclass('owner_platform.tenant_deletion_request') IS NULL AS t_gone,
      to_regprocedure('owner_platform.execute_tenant_deletion(uuid,uuid)') IS NULL AS f_gone,
      to_regprocedure('owner_platform.approve_support_grant(uuid,uuid)') IS NOT NULL AS pr2_kept,
      to_regclass('owner_platform.subscriptions') IS NOT NULL AS pr1_kept`);
    assert.ok(Object.values(after.rows[0]).every(Boolean), 'down 003 removes only its own objects: ' + JSON.stringify(after.rows[0]));
    const stillCanceled = await db.query('SELECT status FROM owner_platform.subscriptions WHERE tenant_id=$1', [A]);
    assert.strictEqual(stillCanceled.rows[0].status, 'canceled', 'rollback does not silently re-activate service');
    await db.exec(read('003_tenant_deletion.up.sql'));
    await db.exec(read('003_tenant_deletion.down.sql'));
    await db.exec(read('002_owner_panel_api.down.sql'));
    await db.exec(read('001_owner_panel.down.sql'));
    const gone = await db.query("SELECT to_regnamespace('owner_platform') IS NULL AS gone");
    assert.strictEqual(gone.rows[0].gone, true, 'full rollback 003→002→001 succeeds');

    assert.ok(checks >= 30, 'negative control count: ' + checks);
  } finally {
    try { await db.close(); } catch (_) { /* noop */ }
    if (hadWindow) global.window = previousWindow;
    else delete global.window;
  }
  return { negative_controls: checks };
}

module.exports = { flow };

if (require.main === module) {
  flow().then(r => { console.log('TENANT-DELETION negative_controls=' + r.negative_controls + ' failures=0'); })
    .catch(e => { console.error('TENANT-DELETION FAILED: ' + (e && e.stack || e)); process.exit(1); });
}
