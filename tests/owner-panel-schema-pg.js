'use strict';

/* PostgreSQL-only PR-1 integration test. Uses a fresh disposable database. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const UP = fs.readFileSync(path.join(ROOT, 'db/migrations/owner-panel/001_owner_panel.up.sql'), 'utf8');
const DOWN = fs.readFileSync(path.join(ROOT, 'db/migrations/owner-panel/001_owner_panel.down.sql'), 'utf8');
const ADMIN_URL = process.env.OWNER_PANEL_TEST_ADMIN_URL || '';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const OWNER = '00000000-0000-4000-8000-000000000001';
const SUPPORT = '00000000-0000-4000-8000-000000000002';
const AUDITOR = '00000000-0000-4000-8000-000000000003';
const SUPPORT2 = '00000000-0000-4000-8000-000000000004';
const SUB_A = '00000000-0000-4000-8000-000000000010';
const SUB_B = '00000000-0000-4000-8000-000000000011';
const ZERO_HASH = Buffer.alloc(32);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function quoteIdent(value) { return '"' + String(value).replace(/"/g, '""') + '"'; }
function testUrl(adminUrl, dbName) {
  const u = new URL(adminUrl);
  u.pathname = '/' + dbName;
  return u.toString();
}
async function mustReject(db, label, sql, params, expected = null) {
  const savepoint = 'case_' + crypto.randomBytes(5).toString('hex');
  await db.query(`SAVEPOINT ${savepoint}`);
  let thrown;
  try { await db.query(sql, params); }
  catch (err) { thrown = err; }
  if (!thrown) {
    await db.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await db.query(`RELEASE SAVEPOINT ${savepoint}`);
    throw new Error(`${label}: query unexpectedly succeeded`);
  }
  await db.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await db.query(`RELEASE SAVEPOINT ${savepoint}`);
  if (expected && thrown.constraint !== expected && thrown.code !== expected) {
    throw new Error(`${label}: expected ${expected}, got code=${thrown.code} constraint=${thrown.constraint} message=${thrown.message}`);
  }
  return thrown;
}
async function checkCase(db, name, sql, params = []) {
  await mustReject(db, `CHECK ${name}`, sql, params, name);
}
function grantInsert(overrides = {}) {
  const base = {
    id: crypto.randomUUID(), tenant_id: A, operator_id: SUPPORT, approved_by: OWNER,
    case_ref: 'case-pr1', scope: 'metadata', reason: 'approved support case',
    starts_at: new Date(Date.now() - 60_000).toISOString(),
    ends_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    school_notified_at: new Date(Date.now() - 120_000).toISOString(),
    revoked_at: null, used_reads: 0, max_actions: 5, open_slot: 1,
  };
  return { ...base, ...overrides };
}
async function insertGrant(db, g) {
  return db.query(`INSERT INTO owner_platform.support_grant
    (id, tenant_id, operator_id, approved_by, case_ref, scope, reason, starts_at, ends_at,
     school_notified_at, revoked_at, used_reads, max_actions, open_slot)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
  [g.id, g.tenant_id, g.operator_id, g.approved_by, g.case_ref, g.scope, g.reason,
    g.starts_at, g.ends_at, g.school_notified_at, g.revoked_at, g.used_reads, g.max_actions, g.open_slot]);
}
async function insertLog(db, grantId, tenantId, recordRef) {
  return db.query(`INSERT INTO owner_platform.support_access_log(grant_id, tenant_id, record_ref)
    VALUES ($1,$2,$3)`, [grantId, tenantId, recordRef]);
}

async function main() {
  if (!ADMIN_URL) throw new Error('OWNER_PANEL_TEST_ADMIN_URL is required; PostgreSQL integration is NOT-RUN without it');
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const dbName = `owner_panel_test_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
  let db;
  let createdDatabase = false;
  try {
    const preexisting = await admin.query("SELECT rolname FROM pg_roles WHERE rolname IN ('payesh_platform_owner','payesh_platform_runtime')");
    assert(preexisting.rows.length === 0, 'use a disposable PostgreSQL cluster with no pre-existing owner-panel roles');
    await admin.query(`CREATE DATABASE ${quoteIdent(dbName)}`);
    createdDatabase = true;
    db = new Client({ connectionString: testUrl(ADMIN_URL, dbName) });
    await db.connect();
    await db.query(UP);
    console.log('PASS migration-up: isolated schema and distinct platform roles created');

    // Seed fixtures as the disposable database administrator.
    await db.query(`INSERT INTO owner_platform.platform_users(id, login_id, role, status) VALUES
      ($1,'owner@example.invalid','platform_owner','active'),
      ($2,'support@example.invalid','platform_support','active'),
      ($3,'owner2@example.invalid','platform_owner','active'),
      ($4,'support2@example.invalid','platform_support','active')`, [OWNER, SUPPORT, AUDITOR, SUPPORT2]);
    await db.query(`INSERT INTO owner_platform.plans(code,name,max_users,max_students,storage_mb,features,price_amount,price_cycle)
      VALUES ('basic','Basic',10,8,512,'{}'::jsonb,0,'none')`);
    await db.query(`INSERT INTO owner_platform.subscriptions(id,tenant_id,plan_code,status,starts_at,ends_at)
      VALUES ($1,$2,'basic','active',now()-interval '1 day',now()+interval '30 days'),
             ($3,$4,'basic','active',now()-interval '1 day',now()+interval '30 days')`, [SUB_A, A, SUB_B, B]);
    await db.query('INSERT INTO owner_platform.tenant_limits(tenant_id,max_users,storage_bytes) VALUES ($1,10,0)', [A]);

    // Every named CHECK in the migration has exactly one negative input below.
    const cases = {
      platform_users_login_id_check: [`INSERT INTO owner_platform.platform_users(login_id,role) VALUES ('   ','platform_support')`, []],
      platform_users_role_check: [`INSERT INTO owner_platform.platform_users(login_id,role) VALUES ('bad-role','school_admin')`, []],
      platform_users_status_check: [`INSERT INTO owner_platform.platform_users(login_id,role,status) VALUES ('bad-status','platform_support','deleted')`, []],
      plans_code_check: [`INSERT INTO owner_platform.plans(code,name,storage_mb) VALUES ('A','Bad code',0)`, []],
      plans_name_check: [`INSERT INTO owner_platform.plans(code,name,storage_mb) VALUES ('bad_name','  ',0)`, []],
      plans_max_users_check: [`INSERT INTO owner_platform.plans(code,name,max_users,storage_mb) VALUES ('bad_name', 'x', -1, 0)`, []],
      plans_max_students_check: [`INSERT INTO owner_platform.plans(code,name,max_students,storage_mb) VALUES ('bad_name', 'x', -1, 0)`, []],
      plans_storage_mb_check: [`INSERT INTO owner_platform.plans(code,name,storage_mb) VALUES ('bad_name','x',-1)`, []],
      plans_features_object_check: [`INSERT INTO owner_platform.plans(code,name,storage_mb,features) VALUES ('bad_name','x',0,'[]'::jsonb)`, []],
      plans_price_amount_check: [`INSERT INTO owner_platform.plans(code,name,storage_mb,price_amount) VALUES ('bad_name','x',0,-1)`, []],
      plans_price_cycle_check: [`INSERT INTO owner_platform.plans(code,name,storage_mb,price_cycle) VALUES ('bad_name','x',0,'daily')`, []],
      subscriptions_status_check: [`INSERT INTO owner_platform.subscriptions(tenant_id,plan_code,status,starts_at,ends_at) VALUES ($1,'basic','trialing',now(),now()+interval '1 day')`, [crypto.randomUUID()]],
      subscriptions_dates_check: [`INSERT INTO owner_platform.subscriptions(tenant_id,plan_code,status,starts_at,ends_at) VALUES ($1,'basic','expired',now(),now())`, [crypto.randomUUID()]],
      subscriptions_grace_days_check: [`INSERT INTO owner_platform.subscriptions(tenant_id,plan_code,status,starts_at,ends_at,grace_days) VALUES ($1,'basic','expired',now(),now()+interval '1 day',366)`, [crypto.randomUUID()]],
      subscriptions_version_check: [`INSERT INTO owner_platform.subscriptions(tenant_id,plan_code,status,starts_at,ends_at,version) VALUES ($1,'basic','expired',now(),now()+interval '1 day',0)`, [crypto.randomUUID()]],
      subscription_event_from_status_check: [`INSERT INTO owner_platform.subscription_event(tenant_id,subscription_id,from_status,to_status,reason,actor_ref,idempotency_key) VALUES ($1,$2,'unknown','active','system','test','c-from')`, [A, SUB_A]],
      subscription_event_to_status_check: [`INSERT INTO owner_platform.subscription_event(tenant_id,subscription_id,to_status,reason,actor_ref,idempotency_key) VALUES ($1,$2,'unknown','system','test','c-to')`, [A, SUB_A]],
      subscription_event_reason_check: [`INSERT INTO owner_platform.subscription_event(tenant_id,subscription_id,to_status,reason,actor_ref,idempotency_key) VALUES ($1,$2,'active','other','test','c-reason')`, [A, SUB_A]],
      subscription_event_idempotency_key_check: [`INSERT INTO owner_platform.subscription_event(tenant_id,subscription_id,to_status,reason,actor_ref,idempotency_key) VALUES ($1,$2,'active','system','test','  ')`, [A, SUB_A]],
      tenant_limits_max_users_check: [`INSERT INTO owner_platform.tenant_limits(tenant_id,max_users,storage_bytes) VALUES ($1,-1,0)`, [crypto.randomUUID()]],
      tenant_limits_max_students_check: [`INSERT INTO owner_platform.tenant_limits(tenant_id,max_students,storage_bytes) VALUES ($1,-1,0)`, [crypto.randomUUID()]],
      tenant_limits_storage_bytes_check: [`INSERT INTO owner_platform.tenant_limits(tenant_id,storage_bytes) VALUES ($1,-1)`, [crypto.randomUUID()]],
      tenant_usage_users_count_check: [`INSERT INTO owner_platform.tenant_usage(tenant_id,users_count) VALUES ($1,-1)`, [crypto.randomUUID()]],
      tenant_usage_students_count_check: [`INSERT INTO owner_platform.tenant_usage(tenant_id,students_count) VALUES ($1,-1)`, [crypto.randomUUID()]],
      tenant_usage_storage_bytes_check: [`INSERT INTO owner_platform.tenant_usage(tenant_id,storage_bytes) VALUES ($1,-1)`, [crypto.randomUUID()]],
      support_grant_scope_check: [`INSERT INTO owner_platform.support_grant(id,tenant_id,operator_id,approved_by,scope,reason,starts_at,ends_at,school_notified_at) VALUES ($1,$2,$3,$4,'content_write','valid enough reason',now(),now()+interval '1 hour',now()-interval '1 minute')`, [crypto.randomUUID(), A, SUPPORT, OWNER]],
      support_grant_reason_check: [`INSERT INTO owner_platform.support_grant(id,tenant_id,operator_id,approved_by,scope,reason,starts_at,ends_at,school_notified_at) VALUES ($1,$2,$3,$4,'metadata','short',now(),now()+interval '1 hour',now()-interval '1 minute')`, [crypto.randomUUID(), A, SUPPORT, OWNER]],
      support_grant_window_check: [`INSERT INTO owner_platform.support_grant(id,tenant_id,operator_id,approved_by,scope,reason,starts_at,ends_at,school_notified_at) VALUES ($1,$2,$3,$4,'metadata','valid enough reason',now(),now(),now()-interval '1 minute')`, [crypto.randomUUID(), A, SUPPORT, OWNER]],
      support_grant_max_72h_check: [`INSERT INTO owner_platform.support_grant(id,tenant_id,operator_id,approved_by,scope,reason,starts_at,ends_at,school_notified_at) VALUES ($1,$2,$3,$4,'metadata','valid enough reason',now(),now()+interval '73 hours',now()-interval '1 minute')`, [crypto.randomUUID(), A, SUPPORT, OWNER]],
      support_grant_approver_check: [`INSERT INTO owner_platform.support_grant(id,tenant_id,operator_id,approved_by,scope,reason,starts_at,ends_at,school_notified_at) VALUES ($1,$2,$3,$3,'metadata','valid enough reason',now(),now()+interval '1 hour',now()-interval '1 minute')`, [crypto.randomUUID(), A, OWNER]],
      support_grant_school_notified_check: [`INSERT INTO owner_platform.support_grant(id,tenant_id,operator_id,approved_by,scope,reason,starts_at,ends_at,school_notified_at) VALUES ($1,$2,$3,$4,'metadata','valid enough reason',now(),now()+interval '1 hour',now()+interval '1 minute')`, [crypto.randomUUID(), A, SUPPORT, OWNER]],
      support_grant_used_reads_check: [`INSERT INTO owner_platform.support_grant(id,tenant_id,operator_id,approved_by,scope,reason,starts_at,ends_at,school_notified_at,used_reads) VALUES ($1,$2,$3,$4,'metadata','valid enough reason',now(),now()+interval '1 hour',now()-interval '1 minute',-1)`, [crypto.randomUUID(), A, SUPPORT, OWNER]],
      support_grant_max_actions_check: [`INSERT INTO owner_platform.support_grant(id,tenant_id,operator_id,approved_by,scope,reason,starts_at,ends_at,school_notified_at,max_actions) VALUES ($1,$2,$3,$4,'metadata','valid enough reason',now(),now()+interval '1 hour',now()-interval '1 minute',0)`, [crypto.randomUUID(), A, SUPPORT, OWNER]],
      support_grant_reads_within_cap_check: [`INSERT INTO owner_platform.support_grant(id,tenant_id,operator_id,approved_by,scope,reason,starts_at,ends_at,school_notified_at,used_reads,max_actions) VALUES ($1,$2,$3,$4,'metadata','valid enough reason',now(),now()+interval '1 hour',now()-interval '1 minute',2,1)`, [crypto.randomUUID(), A, SUPPORT, OWNER]],
      support_grant_open_slot_check: [`INSERT INTO owner_platform.support_grant(id,tenant_id,operator_id,approved_by,scope,reason,starts_at,ends_at,school_notified_at,open_slot) VALUES ($1,$2,$3,$4,'metadata','valid enough reason',now(),now()+interval '1 hour',now()-interval '1 minute',2)`, [crypto.randomUUID(), A, SUPPORT, OWNER]],
      support_access_log_record_ref_check: [`INSERT INTO owner_platform.support_access_log(grant_id,tenant_id,record_ref) VALUES ($1,$2,'  ')`, [null, A]],
      platform_audit_action_check: [`INSERT INTO owner_platform.platform_audit(actor_ref,action,subject_type,previous_hash,event_hash) VALUES ('test',' ','tenant',$1,$2)`, [ZERO_HASH, Buffer.alloc(32, 1)]],
      platform_audit_subject_type_check: [`INSERT INTO owner_platform.platform_audit(actor_ref,action,subject_type,previous_hash,event_hash) VALUES ('test','change',' ',$1,$2)`, [ZERO_HASH, Buffer.alloc(32, 1)]],
      platform_audit_previous_hash_len_check: [`INSERT INTO owner_platform.platform_audit(actor_ref,action,subject_type,previous_hash,event_hash) VALUES ('test','change','tenant',$1,$2)`, [Buffer.from([1]), Buffer.alloc(32, 1)]],
      platform_audit_event_hash_len_check: [`INSERT INTO owner_platform.platform_audit(actor_ref,action,subject_type,previous_hash,event_hash) VALUES ('test','change','tenant',$1,$2)`, [ZERO_HASH, Buffer.from([1])]],
      platform_audit_details_object_check: [`INSERT INTO owner_platform.platform_audit(actor_ref,action,subject_type,details,previous_hash,event_hash) VALUES ('test','change','tenant','[]'::jsonb,$1,$2)`, [ZERO_HASH, Buffer.alloc(32, 1)]],
      invoice_period_check: [`INSERT INTO owner_platform.invoice(tenant_id,period_start,period_end,amount) VALUES ($1,'2026-01-02','2026-01-01',0)`, [crypto.randomUUID()]],
      invoice_amount_check: [`INSERT INTO owner_platform.invoice(tenant_id,period_start,period_end,amount) VALUES ($1,'2026-01-01','2026-02-01',-1)`, [crypto.randomUUID()]],
      invoice_currency_check: [`INSERT INTO owner_platform.invoice(tenant_id,period_start,period_end,amount,currency) VALUES ($1,'2026-01-01','2026-02-01',0,'USD')`, [crypto.randomUUID()]],
      invoice_status_check: [`INSERT INTO owner_platform.invoice(tenant_id,period_start,period_end,amount,status) VALUES ($1,'2026-01-01','2026-02-01',0,'processing')`, [crypto.randomUUID()]],
    };
    const catalog = await db.query(`SELECT conname FROM pg_constraint
      WHERE contype='c' AND connamespace='owner_platform'::regnamespace ORDER BY conname`);
    const actualChecks = catalog.rows.map((r) => r.conname);
    const testChecks = Object.keys(cases).sort();
    assert(actualChecks.join('\n') === testChecks.join('\n'),
      `CHECK coverage drift: missing tests=${actualChecks.filter((x) => !cases[x])}; stale tests=${testChecks.filter((x) => !actualChecks.includes(x))}`);
    const noGrantCase = cases.support_access_log_record_ref_check;
    noGrantCase[1][0] = crypto.randomUUID(); // valid-shaped UUID, intentionally absent grant
    await db.query('BEGIN');
    for (const [name, [sql, params]] of Object.entries(cases)) {
      await checkCase(db, name, sql, params);
    }
    await db.query('COMMIT');
    console.log(`PASS check-negative-matrix: ${actualChecks.length}/${actualChecks.length} named CHECK constraints reject invalid values`);

    // Role/default-deny invariants and non-content privilege boundary.
    await db.query('CREATE TABLE public.product_records (tenant_id uuid NOT NULL, body jsonb NOT NULL)');
    const roleFlags = await db.query(`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
      WHERE rolname IN ('payesh_platform_owner','payesh_platform_runtime') ORDER BY rolname`);
    assert(roleFlags.rows.length === 2 && roleFlags.rows.every((r) => !r.rolsuper && !r.rolbypassrls), 'platform roles must not bypass RLS');
    const invoicePrivilege = await db.query(`SELECT has_table_privilege('payesh_platform_runtime','owner_platform.invoice','SELECT') AS can_read`);
    const contentPrivilege = await db.query(`SELECT has_table_privilege('payesh_platform_runtime','public.product_records','SELECT') AS can_read`);
    const subscriptionMutation = await db.query(`SELECT
      has_table_privilege('payesh_platform_runtime','owner_platform.subscriptions','INSERT') AS can_insert,
      has_table_privilege('payesh_platform_runtime','owner_platform.subscriptions','UPDATE') AS can_update,
      has_table_privilege('payesh_platform_runtime','owner_platform.subscriptions','DELETE') AS can_delete`);
    assert(invoicePrivilege.rows[0].can_read === false, 'runtime must not access structure-only invoice');
    assert(contentPrivilege.rows[0].can_read === false, 'platform runtime must have no school-content privilege');
    assert(Object.values(subscriptionMutation.rows[0]).every((x) => x === false), 'runtime must have no direct subscription mutations');
    const rlsTables = await db.query(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='owner_platform' AND c.relkind='r'`);
    assert(rlsTables.rows.length === 10 && rlsTables.rows.every((r) => r.relrowsecurity && r.relforcerowsecurity),
      `RLS must be ENABLE + FORCE on all 10 tables (found ${rlsTables.rows.length})`);
    console.log('PASS default-deny: roles are non-bypass, all 10 tables FORCE RLS, invoice/content grants absent');
    await db.query('BEGIN');
    await mustReject(db, 'subscription event tenant FK', `INSERT INTO owner_platform.subscription_event(tenant_id,subscription_id,to_status,reason,actor_ref,idempotency_key)
      VALUES ($1,$2,'active','system','test','cross-event')`, [A, SUB_B], '23503');
    await mustReject(db, 'invoice tenant FK', `INSERT INTO owner_platform.invoice(tenant_id,subscription_id,period_start,period_end,amount)
      VALUES ($1,$2,'2026-01-01','2026-02-01',0)`, [A, SUB_B], '23503');
    await db.query('COMMIT');
    console.log('PASS tenant-foreign-keys: events and invoice cannot cross subscription tenants');

    // Real tenant-role RLS test: A cannot see or write B, even with SQL filters omitted.
    await db.query('CREATE ROLE owner_panel_tenant_test NOLOGIN NOSUPERUSER NOBYPASSRLS');
    await db.query('GRANT USAGE ON SCHEMA owner_platform TO owner_panel_tenant_test');
    await db.query('GRANT SELECT, INSERT, UPDATE, DELETE ON owner_platform.subscriptions, owner_platform.tenant_limits, owner_platform.tenant_usage TO owner_panel_tenant_test');
    await db.query('GRANT SELECT ON owner_platform.platform_users TO owner_panel_tenant_test');
    await db.query('BEGIN');
    await db.query('SET LOCAL ROLE owner_panel_tenant_test');
    await db.query("SELECT set_config('app.tenant_id', $1, true)", [A]);
    const visible = await db.query('SELECT tenant_id FROM owner_platform.subscriptions ORDER BY tenant_id');
    assert(visible.rows.length === 1 && visible.rows[0].tenant_id === A, 'tenant A must see only its own subscription');
    const cross = await db.query('SELECT count(*)::int AS n FROM owner_platform.subscriptions WHERE tenant_id=$1', [B]);
    assert(cross.rows[0].n === 0, 'cross-tenant SELECT must return zero rows');
    await mustReject(db, 'RLS insert other tenant', 'INSERT INTO owner_platform.tenant_usage(tenant_id) VALUES ($1)', [B], '42501');
    await mustReject(db, 'RLS update tenant_id', 'UPDATE owner_platform.tenant_limits SET tenant_id=$1 WHERE tenant_id=$2', [B, A], '42501');
    await db.query('COMMIT');
    await db.query('BEGIN');
    await db.query('SET LOCAL ROLE owner_panel_tenant_test');
    const noContext = await db.query('SELECT count(*)::int AS n FROM owner_platform.subscriptions');
    assert(noContext.rows[0].n === 0, 'missing tenant context must fail closed');
    await db.query('COMMIT');
    console.log('PASS tenant-isolation: cross-tenant read/write denied; absent context returns zero rows');

    // The privileged platform runtime can read metadata, but not product records or invoice.
    await db.query('BEGIN');
    await db.query('SET LOCAL ROLE payesh_platform_runtime');
    const metaCount = await db.query('SELECT count(*)::int AS n FROM owner_platform.subscriptions');
    assert(metaCount.rows[0].n === 2, 'platform runtime may read metadata across tenants');
    await mustReject(db, 'content table direct access', 'SELECT * FROM public.product_records', [], '42501');
    await mustReject(db, 'invoice direct access', 'SELECT * FROM owner_platform.invoice', [], '42501');
    await mustReject(db, 'operator cannot create subscriptions through direct INSERT', `INSERT INTO owner_platform.subscriptions(tenant_id,plan_code,status,starts_at,ends_at)
      VALUES ($1,'basic','active',now(),now()+interval '1 day')`, [crypto.randomUUID()], '42501');
    await mustReject(db, 'operator cannot renew through direct subscription UPDATE', 'UPDATE owner_platform.subscriptions SET ends_at=ends_at+interval \'1 day\' WHERE tenant_id=$1', [A], '42501');
    await db.query('COMMIT');
    console.log('PASS content-default-deny: content, invoice, and direct subscription renewal are denied');

    // E1-E16 data-layer invariants: no grant, four-eyes, future/notice/tenant checks,
    // no write scope, bounded duration/reason, revocation/expiry, cap, and append-only reads.
    const active = grantInsert({ scope: 'content_read', max_actions: 2 });
    await insertGrant(db, active);
    await db.query('BEGIN');
    const wrongApprover = grantInsert({ operator_id: SUPPORT, approved_by: SUPPORT2, case_ref: 'wrong-approver' });
    await mustReject(db, 'E2 approval must come from an active platform owner', `INSERT INTO owner_platform.support_grant
      (id,tenant_id,operator_id,approved_by,case_ref,scope,reason,starts_at,ends_at,school_notified_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [wrongApprover.id, wrongApprover.tenant_id, wrongApprover.operator_id, wrongApprover.approved_by, wrongApprover.case_ref,
      wrongApprover.scope, wrongApprover.reason, wrongApprover.starts_at, wrongApprover.ends_at, wrongApprover.school_notified_at], '42501');
    await db.query("SELECT set_config('app.tenant_id',$1,true), set_config('app.platform_user_id',$2,true)", [A, SUPPORT]);
    await mustReject(db, 'E1 read without grant', 'INSERT INTO owner_platform.support_access_log(grant_id,tenant_id,record_ref) VALUES ($1,$2,$3)', [crypto.randomUUID(), A, 'record-1'], '42501');
    await mustReject(db, 'E5 mismatched grant tenant', 'INSERT INTO owner_platform.support_access_log(grant_id,tenant_id,record_ref) VALUES ($1,$2,$3)', [active.id, B, 'record-2'], '42501');
    const future = grantInsert({ operator_id: SUPPORT2, starts_at: new Date(Date.now() + 60_000).toISOString(), ends_at: new Date(Date.now() + 90 * 60_000).toISOString(), school_notified_at: new Date().toISOString(), case_ref: 'future' });
    await insertGrant(db, future);
    await db.query("SELECT set_config('app.platform_user_id',$1,true)", [SUPPORT2]);
    await mustReject(db, 'E3 not active before approved start', 'INSERT INTO owner_platform.support_access_log(grant_id,tenant_id,record_ref) VALUES ($1,$2,$3)', [future.id, A, 'future-record'], '42501');
    await db.query('UPDATE owner_platform.support_grant SET revoked_at=clock_timestamp() WHERE id=$1', [future.id]);
    await db.query("SELECT set_config('app.platform_user_id',$1,true)", [SUPPORT]);
    await mustReject(db, 'E15 another operator context is rejected', 'INSERT INTO owner_platform.support_access_log(grant_id,tenant_id,record_ref) VALUES ($1,$2,$3)', [active.id, A, 'wrong-operator'], '42501');
    await insertLog(db, active.id, A, 'record-a');
    await insertLog(db, active.id, A, 'record-b');
    const used = await db.query('SELECT used_reads FROM owner_platform.support_grant WHERE id=$1', [active.id]);
    assert(used.rows[0].used_reads === 2, 'each logged read consumes one action');
    await mustReject(db, 'E14 action cap', 'INSERT INTO owner_platform.support_access_log(grant_id,tenant_id,record_ref) VALUES ($1,$2,$3)', [active.id, A, 'record-c'], '42501');
    const logs = await db.query('SELECT count(*)::int AS n FROM owner_platform.support_access_log WHERE grant_id=$1', [active.id]);
    assert(logs.rows[0].n === 2, 'E16 each successful read has its own log row');
    await db.query('UPDATE owner_platform.support_grant SET revoked_at=clock_timestamp() WHERE id=$1', [active.id]);
    await mustReject(db, 'E11/E13 revoke is immediate', 'INSERT INTO owner_platform.support_access_log(grant_id,tenant_id,record_ref) VALUES ($1,$2,$3)', [active.id, A, 'after-revoke'], '42501');
    await mustReject(db, 'grant cannot be extended', 'UPDATE owner_platform.support_grant SET ends_at=ends_at+interval \'1 minute\' WHERE id=$1', [active.id], '42501');
    const expired = grantInsert({ operator_id: SUPPORT2, starts_at: new Date(Date.now() - 4 * 60 * 60_000).toISOString(), ends_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString(), school_notified_at: new Date(Date.now() - 5 * 60 * 60_000).toISOString(), case_ref: 'expired' });
    await insertGrant(db, expired);
    await db.query("SELECT set_config('app.platform_user_id',$1,true)", [SUPPORT2]);
    await mustReject(db, 'E12 expired grant denied', 'INSERT INTO owner_platform.support_access_log(grant_id,tenant_id,record_ref) VALUES ($1,$2,$3)', [expired.id, A, 'after-expiry'], '42501');
    await db.query('COMMIT');
    console.log('PASS support-grant-invariants: E1-E16 data-layer scenarios exercised; HTTP token and bulk-route behavior remains PR-2');

    // Audit chain enforces the previous hash and append-only behavior.
    const eventHash = crypto.createHash('sha256').update('first-audit-event').digest();
    await db.query('BEGIN');
    await db.query(`INSERT INTO owner_platform.platform_audit(actor_id,actor_ref,action,subject_type,previous_hash,event_hash)
      VALUES ($1,'owner','grant.create','support_grant',$2,$3)`, [OWNER, ZERO_HASH, eventHash]);
    await mustReject(db, 'audit previous hash mismatch', `INSERT INTO owner_platform.platform_audit(actor_ref,action,subject_type,previous_hash,event_hash)
      VALUES ('owner','grant.revoke','support_grant',$1,$2)`, [ZERO_HASH, crypto.createHash('sha256').update('bad-chain').digest()], '23514');
    await db.query('COMMIT');
    await db.query('BEGIN');
    await mustReject(db, 'audit append-only update', 'UPDATE owner_platform.platform_audit SET action=action WHERE sequence_id=1', [], '42501');
    await mustReject(db, 'audit append-only delete', 'DELETE FROM owner_platform.platform_audit WHERE sequence_id=1', [], '42501');
    await db.query('COMMIT');
    console.log('PASS audit-chain: hash link validated; UPDATE/DELETE rejected');

    // Migration is reversible and can be reapplied. Drop schema grants before the test role.
    await db.query(DOWN);
    await db.query('DROP ROLE owner_panel_tenant_test');
    let exists = await db.query("SELECT to_regnamespace('owner_platform') IS NOT NULL AS present");
    assert(exists.rows[0].present === false, 'down migration removes only its schema');
    const managedRoles = await db.query(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname IN ('payesh_platform_owner','payesh_platform_runtime')`);
    assert(managedRoles.rows[0].n === 0, 'down migration removes migration-owned roles');
    await db.query(UP);
    await db.query(DOWN);
    console.log('PASS migration-down-up: schema and migration-owned roles removed, recreated, and rolled back');
    console.log('SUMMARY pass=7 fail=0 (5 independent verification passes + migration lifecycle + complete CHECK matrix)');
  } finally {
    if (db) { try { await db.end(); } catch (_) {} }
    try { await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(dbName)} WITH (FORCE)`); } catch (err) {
      console.error('cleanup database failed:', err.message);
    }
    if (createdDatabase) {
      try {
        await admin.query(`DO $cleanup$ BEGIN
          IF (SELECT shobj_description(oid, 'pg_authid') FROM pg_catalog.pg_roles WHERE rolname='payesh_platform_runtime') = 'managed by owner-platform migration 001' THEN DROP ROLE payesh_platform_runtime; END IF;
          IF (SELECT shobj_description(oid, 'pg_authid') FROM pg_catalog.pg_roles WHERE rolname='payesh_platform_owner') = 'managed by owner-platform migration 001' THEN DROP ROLE payesh_platform_owner; END IF;
        END $cleanup$`);
      } catch (err) { console.error('cleanup managed roles failed:', err.message); }
    }
    await admin.end();
  }
}

main().catch((err) => {
  console.error('FAIL owner-panel-schema-pg:', err.stack || err.message || err);
  process.exitCode = 1;
});
