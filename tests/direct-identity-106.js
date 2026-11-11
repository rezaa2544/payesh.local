'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 106 (ADR-105 §3.1, Proposed): identity + capabilities + revocation
   + RLS in the database, without a Gateway.   DI-01 .. DI-14

   What is real:
     • a fresh PostgreSQL database per run (D-40: the embedded PostgreSQL
       locally, the postgres:16 service in CI);
     • the product migration db/migrations/direct/0001_direct_identity.up.sql,
       applied by the row-86 migrator CLI (lint + ledger + checksum);
     • a separate LOGIN role that is only a member of payesh_direct_client,
       standing in for the provider's request role. Every client query sets
       the verified claims exactly the way a PostgREST-style API layer does:
       set_config('request.jwt.claims', <json>, true) inside the transaction.

   Negative controls (the AC): a revoked user, a disabled user, a revoked or
   foreign device, another role without capability and another school all
   see 0 rows. Capabilities cannot be written by table access or by a
   non-manager or across schools. A role/tenant claim in the token is
   ignored. 5 mutants of the migration are applied inside a rolled-back
   transaction and each one must be caught.

   Run: PAYESH_PG_ADMIN=postgres://postgres@127.0.0.1:5432/payesh_c64 \
        node tests/direct-identity-106.js
        (DI106_REQUIRE_PG=1 turns "no PG" into a failure, as in CI)
   ═══════════════════════════════════════════════════════════════════ */
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'tools', 'migrate-86.mjs');
const DIR = 'db/migrations/direct';
const API_ROLE = 'payesh_d106_api';

let passed = 0, failed = 0, negatives = 0, mutantsKilled = 0;
const failures = [];
async function check(id, desc, fn) {
  const t0 = Date.now();
  try {
    const d = await fn();
    passed++;
    console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}  (${Date.now() - t0}ms)`);
  } catch (e) {
    failed++; failures.push(id);
    console.log(`FAIL  ${id}  ${desc}  → ${String((e && (e.code ? e.code + ' ' : '') + e.message) || e).slice(0, 400)}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
async function refuses(p, codes, what) {
  const want = [].concat(codes);
  try { await p; } catch (e) {
    if (want.includes(e.code)) { negatives++; return e; }
    throw new Error(`${what}: expected ${want.join('|')}, got ${e.code || ''} ${e.message}`);
  }
  throw new Error(`${what}: expected refusal ${want.join('|')}, but it succeeded`);
}
function zero(n, what) { eq(n, 0, what); negatives++; }
function cli(args, url) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT, encoding: 'utf8',
    env: Object.assign({}, process.env, url ? { PAYESH_MIGRATE_URL: url } : {}),
  });
  return { code: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
}
function withDb(url, db, user) {
  const u = new URL(url);
  u.pathname = '/' + db;
  if (user) { u.username = user; u.password = ''; }
  return u.toString();
}

async function main() {
  console.log('\nRow 106: direct path — identity, capabilities, revocation, RLS (no Gateway)\n');
  const ADMIN = process.env.PAYESH_PG_ADMIN;
  if (!ADMIN) {
    if (process.env.DI106_REQUIRE_PG === '1') throw new Error('PAYESH_PG_ADMIN is required (DI106_REQUIRE_PG=1)');
    console.log('SKIP  row 106 needs PostgreSQL (set PAYESH_PG_ADMIN)');
    return { passed: 0, skipped: true };
  }
  const { Pool, Client } = require('pg');
  const DB = `payesh_d106_${process.pid}_${Date.now().toString(36)}`;

  const root = new Client({ connectionString: ADMIN });
  root.on('error', () => {});
  await root.connect();
  await root.query(`CREATE DATABASE ${DB}`);
  await root.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${API_ROLE}') THEN
        CREATE ROLE ${API_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      END IF; END $$`);
  const DB_URL = withDb(ADMIN, DB);
  let admin = null, api = null;

  try {
    /* ── DI-01 migration through the row-86 migrator ─────────────────── */
    await check('DI-01', 'migration: lint clean, applied once by the row-86 migrator, re-run applies nothing', async () => {
      const l = cli(['lint', '--dir', DIR]);
      assert(l.code === 0 && /MIGRATE-86-OK lint migrations=1 errors=0/.test(l.out), 'lint: ' + l.out);
      const u1 = cli(['up', '--dir', DIR], DB_URL);
      assert(u1.code === 0, 'up: ' + u1.out);
      const u2 = cli(['up', '--dir', DIR], DB_URL);
      assert(u2.code === 0, 'up again: ' + u2.out);
      admin = new Pool({ connectionString: DB_URL, max: 2 });
      admin.on('error', () => {});
      const led = await admin.query(`SELECT id, phase FROM payesh_schema_migrations WHERE track = 'direct'`);
      eq(led.rows.length, 1, 'ledger rows');
      eq(led.rows[0].phase, 'expand', 'phase');
      return `ledger ${led.rows[0].id} (expand), second up = no-op`;
    });

    if (!admin) throw new Error('migration failed; aborting');
    await admin.query(`GRANT payesh_direct_client TO ${API_ROLE}`);
    api = new Pool({ connectionString: withDb(ADMIN, DB, API_ROLE), max: 4 });
    api.on('error', () => {});

    /* a client request: verified claims in the tx-local GUC, then SQL as the API role */
    async function as(claims, fn) {
      const c = await api.connect();
      try {
        await c.query('BEGIN');
        if (claims) await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
        const r = await fn(c);
        await c.query('COMMIT');
        return r;
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    }
    const rows = (claims, sql = 'SELECT tenant_id, collection, record_id FROM payesh_direct.record ORDER BY tenant_id, collection, record_id', p = []) =>
      as(claims, c => c.query(sql, p)).then(r => r.rows);
    const count = async (claims, table = 'record') => Number((await rows(claims, `SELECT count(*)::int AS n FROM payesh_direct.${table}`))[0].n);
    const tok = (u, extra = {}) => Object.assign({ sub: u.sub, device_id: u.device }, extra);

    /* ── fixture: two schools, users, devices, capabilities, records ─── */
    const A = crypto.randomUUID(), B = crypto.randomUUID();
    const boot = async (t, code, sub) => {
      const r = await admin.query('SELECT * FROM payesh_direct.bootstrap_school($1, $2, $3, $4)', [t, code, sub, 'first device']);
      return { id: r.rows[0].user_id, device: r.rows[0].device_id, sub, tenant: t };
    };
    const mA = await boot(A, 'mgr-a', 'sub-mA');
    const mB = await boot(B, 'mgr-b', 'sub-mB');
    const mk = async (mgr, code, sub, role, person = null) => {
      const id = await as(tok(mgr), async c => (await c.query('SELECT payesh_direct.create_user($1, $2, $3, $4) AS id', [code, sub, role, person])).rows[0].id);
      const device = await as(tok(mgr), async c => (await c.query('SELECT payesh_direct.enroll_device($1, $2) AS id', [id, code + ' phone'])).rows[0].id);
      return { id, device, sub, tenant: mgr.tenant };
    };
    const grant = (mgr, u, action, kind, sid = null, coll = null) =>
      as(tok(mgr), async c => Number((await c.query('SELECT payesh_direct.grant_capability($1, $2, $3, $4, $5) AS id', [u.id, action, kind, sid, coll])).rows[0].id));
    const tA = await mk(mA, 'teacher-a', 'sub-tA', 'teacher', 501);
    const tA2 = await mk(mA, 'teacher-a2', 'sub-tA2', 'teacher', 502);
    const pA = await mk(mA, 'parent-a', 'sub-pA', 'parent', 601);
    const gA = await mk(mA, 'guard-a', 'sub-gA', 'guard');
    const cA = await mk(mA, 'counselor-a', 'sub-cA', 'counselor');
    const tB = await mk(mB, 'teacher-b', 'sub-tB', 'teacher', 501);
    await grant(mA, tA, 'read', 'class', 1, 'attendance');
    await grant(mA, tA, 'write', 'class', 1, 'attendance');
    await grant(mA, tA2, 'read', 'school');
    await grant(mA, pA, 'read', 'student', 10);
    await grant(mA, cA, 'read', 'school', null, 'discipline');
    await grant(mB, tB, 'read', 'class', 1);
    const put = (mgr, coll, id, cls, stu) => as(tok(mgr), c => c.query(
      `INSERT INTO payesh_direct.record (tenant_id, collection, record_id, class_id, student_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`, [mgr.tenant, coll, id, cls, stu, { v: `${coll}-${id}` }]));
    for (const [coll, id, cls, stu] of [['attendance', 1, 1, 10], ['attendance', 2, 1, 12], ['attendance', 3, 2, 11],
      ['grades', 4, 1, 10], ['grades', 5, 2, 11], ['announcements', 6, null, null]]) await put(mA, coll, id, cls, stu);
    for (const [coll, id, cls, stu] of [['attendance', 1, 1, 10], ['attendance', 3, 2, 11], ['grades', 4, 1, 10]]) await put(mB, coll, id, cls, stu);
    const keys = rs => rs.map(r => `${r.collection}#${r.record_id}`).join(',');
    const onlyTenant = (rs, t) => rs.every(r => r.tenant_id === t);

    /* ── DI-02 catalog: standard PG, RLS everywhere, no client writes ─── */
    await check('DI-02', 'catalog: RLS on every table (FORCE on record), client has no INSERT/UPDATE/DELETE on identity, definer fns pin search_path, nothing for PUBLIC, roles NOBYPASSRLS, no provider objects', async () => {
      const t = await admin.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'payesh_direct' AND c.relkind = 'r' ORDER BY 1`);
      eq(t.rows.length, 5, 'table count');
      for (const r of t.rows) assert(r.relrowsecurity, `RLS off on ${r.relname}`);
      assert(t.rows.find(r => r.relname === 'record').relforcerowsecurity, 'record must FORCE RLS');
      const w = await admin.query(`SELECT table_name, privilege_type FROM information_schema.role_table_grants
          WHERE table_schema = 'payesh_direct' AND grantee IN ('payesh_direct_client', 'PUBLIC')
            AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')`);
      const bad = w.rows.filter(r => !(r.table_name === 'record' && ['INSERT', 'UPDATE'].includes(r.privilege_type)));
      eq(bad.length, 0, 'unexpected write grants ' + JSON.stringify(bad));
      const f = await admin.query(`SELECT p.proname, p.prosecdef, p.proconfig, p.proacl::text AS acl FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'payesh_direct'`);
      eq(f.rows.length, 16, 'function count');
      for (const r of f.rows) {
        assert((r.proconfig || []).some(x => /^search_path=pg_catalog, pg_temp$/.test(x)), `${r.proname} search_path not pinned`);
        assert(!/(^|[{,])=X/.test(r.acl || ''), `${r.proname} executable by PUBLIC`);
      }
      const defs = f.rows.filter(r => r.prosecdef).map(r => r.proname);
      const clientExec = await admin.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'payesh_direct' AND has_function_privilege('payesh_direct_client', p.oid, 'EXECUTE')`);
      const ce = clientExec.rows.map(r => r.proname);
      for (const hidden of ['bootstrap_school', 'require_manager', 'user_in_tenant']) assert(!ce.includes(hidden), `client can execute ${hidden}`);
      const roles = await admin.query(`SELECT rolname, rolbypassrls, rolsuper, rolcanlogin FROM pg_roles WHERE rolname IN ('payesh_direct_owner', 'payesh_direct_client')`);
      eq(roles.rows.length, 2, 'roles');
      for (const r of roles.rows) assert(!r.rolbypassrls && !r.rolsuper && !r.rolcanlogin, `${r.rolname} must be NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      const sql = require('fs').readFileSync(path.join(ROOT, DIR, '0001_direct_identity.up.sql'), 'utf8').replace(/--[^\n]*/g, '');
      assert(!/\bauth\.|supabase|neon|CREATE\s+EXTENSION|pgjwt|pg_session_jwt/i.test(sql), 'provider-specific object in the migration');
      return `5 tables RLS, ${defs.length} SECURITY DEFINER fns pinned, client exec=${ce.length} (no bootstrap/helpers)`;
    });

    /* ── DI-03 .. DI-05 positive scope ────────────────────────────────── */
    await check('DI-03', 'manager sees every row of the own school and nothing of the other', async () => {
      const a = await rows(tok(mA)), b = await rows(tok(mB));
      eq(a.length, 6, 'manager A rows'); assert(onlyTenant(a, A), 'manager A saw another school');
      eq(b.length, 3, 'manager B rows'); assert(onlyTenant(b, B), 'manager B saw another school');
      return `A=${a.length} B=${b.length}`;
    });
    await check('DI-04', 'teacher with "attendance, class 1" sees exactly that scope', async () => {
      const r = await rows(tok(tA));
      eq(keys(r), 'attendance#1,attendance#2', 'teacher scope'); assert(onlyTenant(r, A), 'tenant');
      return keys(r);
    });
    await check('DI-05', 'parent with "student 10" sees only that child (any collection)', async () => {
      const r = await rows(tok(pA));
      eq(keys(r), 'attendance#1,grades#4', 'parent scope');
      return keys(r);
    });

    /* ── DI-06 revoked / disabled user ⇒ 0 rows ────────────────────────── */
    await check('DI-06', 'NEGATIVE disabled user ⇒ 0 rows everywhere; re-enabled ⇒ back; revoked user ⇒ 0 for good', async () => {
      eq(await count(tok(tA2)), 6, 'tA2 before');
      await as(tok(mA), c => c.query('SELECT payesh_direct.set_user_disabled($1, true)', [tA2.id]));
      for (const tbl of ['record', 'app_user', 'device', 'capability']) zero(await count(tok(tA2), tbl), `disabled ${tbl}`);
      await as(tok(mA), c => c.query('SELECT payesh_direct.set_user_disabled($1, false)', [tA2.id]));
      eq(await count(tok(tA2)), 6, 'tA2 re-enabled');
      await as(tok(mA), c => c.query('SELECT payesh_direct.revoke_user($1)', [tA2.id]));
      for (const tbl of ['record', 'app_user', 'device', 'capability']) zero(await count(tok(tA2), tbl), `revoked ${tbl}`);
      await as(tok(mA), c => c.query('SELECT payesh_direct.set_user_disabled($1, false)', [tA2.id]));
      zero(await count(tok(tA2)), 'revoked stays revoked after enable');
      const caps = await admin.query('SELECT count(*)::int AS n FROM payesh_direct.capability WHERE user_id = $1 AND revoked_at IS NULL', [tA2.id]);
      eq(caps.rows[0].n, 0, 'revoke_user also revokes capabilities');
      await refuses(as(tok(mA), c => c.query('SELECT payesh_direct.revoke_user($1)', [mA.id])), '42501', 'manager revoking self');
      return 'disabled 0/0/0/0, enabled 6, revoked 0/0/0/0 (permanent)';
    });

    /* ── DI-07 devices ───────────────────────────────────────────────── */
    await check('DI-07', 'NEGATIVE revoked device / someone else\'s device / unknown or missing device ⇒ 0 rows; the user\'s other device keeps working', async () => {
      const d2 = await as(tok(mA), async c => (await c.query('SELECT payesh_direct.enroll_device($1, $2) AS id', [tA.id, 'tablet'])).rows[0].id);
      await as(tok(tA), c => c.query('SELECT payesh_direct.revoke_device($1)', [tA.device]));
      zero(await count(tok(tA)), 'revoked device');
      eq(await count({ sub: tA.sub, device_id: d2 }), 2, 'other device');
      zero(await count({ sub: tA.sub, device_id: pA.device }), 'foreign device');
      zero(await count({ sub: tA.sub, device_id: crypto.randomUUID() }), 'unknown device');
      zero(await count({ sub: tA.sub }), 'missing device claim');
      zero(await count({ sub: tA.sub, device_id: 'not-a-uuid' }), 'malformed device claim');
      await refuses(as({ sub: pA.sub, device_id: pA.device }, c => c.query('SELECT payesh_direct.revoke_device($1)', [d2])), 'P0002', 'parent revoking a teacher device');
      await refuses(as(tok(mB), c => c.query('SELECT payesh_direct.revoke_device($1)', [d2])), 'P0002', 'manager B revoking an A device');
      eq(await count({ sub: tA.sub, device_id: d2 }), 2, 'tablet still works after refused revokes');
      tA.device = d2;
      return 'revoked 0, foreign 0, unknown 0, missing 0, malformed 0; tablet 2';
    });

    /* ── DI-08 other role / spoofed claims ───────────────────────────── */
    await check('DI-08', 'NEGATIVE role without capability ⇒ 0 rows; role/tenant claims in the token are ignored', async () => {
      zero(await count(tok(gA)), 'guard');
      zero(await count(tok(cA)), 'counselor (discipline only, none exists)');
      const spoof = tok(tA, { role: 'manager', tenant_id: B, app_metadata: { role: 'manager' }, user_role: 'manager' });
      const r = await rows(spoof);
      eq(keys(r), 'attendance#1,attendance#2', 'spoofed claims changed the scope'); assert(onlyTenant(r, A), 'tenant spoof worked');
      await refuses(as(spoof, c => c.query(`SELECT payesh_direct.grant_capability($1, 'read', 'school')`, [tA.id])), '42501', 'spoofed manager granting');
      negatives++;
      return 'guard 0, counselor 0, spoofed manager/tenant claim ⇒ unchanged 2 rows of A';
    });

    /* ── DI-09 other school ──────────────────────────────────────────── */
    await check('DI-09', 'NEGATIVE other school ⇒ 0 rows (same class/record ids in both schools)', async () => {
      zero((await rows(tok(mB), 'SELECT * FROM payesh_direct.record WHERE tenant_id = $1', [A])).length, 'manager B reading A');
      zero((await rows(tok(tB), 'SELECT * FROM payesh_direct.record WHERE tenant_id = $1', [A])).length, 'teacher B reading A');
      const r = await rows(tok(tB));
      eq(keys(r), 'attendance#1,grades#4', 'teacher B scope'); assert(onlyTenant(r, B), 'teacher B saw A');
      zero((await rows(tok(mB), 'SELECT * FROM payesh_direct.app_user WHERE tenant_id = $1', [A])).length, 'manager B listing A users');
      zero((await rows(tok(mB), 'SELECT * FROM payesh_direct.capability WHERE tenant_id = $1', [A])).length, 'manager B listing A capabilities');
      return 'B→A records 0, users 0, capabilities 0; teacher B own scope 2';
    });

    /* ── DI-10 capability write path ─────────────────────────────────── */
    await check('DI-10', 'NEGATIVE capabilities only via SECURITY DEFINER by a manager of the same school', async () => {
      await refuses(as(tok(tA), c => c.query(`INSERT INTO payesh_direct.capability (tenant_id, user_id, action, scope_kind, granted_by) VALUES ($1, $2, 'read', 'school', $2)`, [A, tA.id])), '42501', 'table INSERT');
      await refuses(as(tok(mA), c => c.query(`INSERT INTO payesh_direct.capability (tenant_id, user_id, action, scope_kind, granted_by) VALUES ($1, $2, 'read', 'school', $2)`, [A, tA.id])), '42501', 'table INSERT even as manager');
      await refuses(as(tok(mA), c => c.query(`UPDATE payesh_direct.capability SET revoked_at = NULL`)), '42501', 'table UPDATE');
      await refuses(as(tok(mA), c => c.query(`DELETE FROM payesh_direct.capability`)), '42501', 'table DELETE');
      await refuses(as(tok(mA), c => c.query(`UPDATE payesh_direct.app_user SET role = 'manager'`)), '42501', 'app_user UPDATE');
      await refuses(as(tok(tA), c => c.query(`SELECT payesh_direct.grant_capability($1, 'read', 'school')`, [tA.id])), '42501', 'teacher granting');
      await refuses(as(tok(tA), c => c.query(`SELECT payesh_direct.create_user('x', 'sub-x', 'manager')`)), '42501', 'teacher creating a manager');
      await refuses(as(tok(mA), c => c.query(`SELECT payesh_direct.grant_capability($1, 'read', 'school')`, [tB.id])), 'P0002', 'manager A granting to a B user');
      const capA = Number((await admin.query(`SELECT id FROM payesh_direct.capability WHERE user_id = $1 LIMIT 1`, [tA.id])).rows[0].id);
      await refuses(as(tok(mB), c => c.query('SELECT payesh_direct.revoke_capability($1)', [capA])), 'P0002', 'manager B revoking A capability');
      await refuses(as(tok(tA), c => c.query(`SELECT * FROM payesh_direct.bootstrap_school($1, 'evil', 'sub-evil')`, [crypto.randomUUID()])), '42501', 'client bootstrap');
      await refuses(as(tok(tA), c => c.query(`SELECT payesh_direct.require_manager()`)), '42501', 'helper not executable');
      const before = await count(tok(tA));
      const cid = await grant(mA, tA, 'read', 'class', 2, 'grades');
      const mid = await count(tok(tA));
      await as(tok(mA), c => c.query('SELECT payesh_direct.revoke_capability($1)', [cid]));
      const after = await count(tok(tA));
      eq(before, 2, 'before'); eq(mid, 3, 'after grant'); eq(after, 2, 'after revoke');
      const auditMgr = await count(tok(mA), 'identity_audit');
      zero(await count(tok(tA), 'identity_audit'), 'teacher reading audit');
      assert(auditMgr >= 10, 'audit trail rows: ' + auditMgr);
      return `11 refusals; grant ⇒ ${before}→${mid}, revoke ⇒ ${after}; audit ${auditMgr} rows (manager only)`;
    });

    /* ── DI-11 record write path ─────────────────────────────────────── */
    await check('DI-11', 'NEGATIVE writes: only inside the write capability; moving a row out of scope, other school, delete ⇒ refused', async () => {
      await as(tok(tA), c => c.query(`INSERT INTO payesh_direct.record (tenant_id, collection, record_id, class_id, student_id) VALUES ($1, 'attendance', 7, 1, 12)`, [A]));
      await refuses(as(tok(tA), c => c.query(`INSERT INTO payesh_direct.record (tenant_id, collection, record_id, class_id) VALUES ($1, 'attendance', 8, 2)`, [A])), '42501', 'insert class 2');
      await refuses(as(tok(tA), c => c.query(`INSERT INTO payesh_direct.record (tenant_id, collection, record_id, class_id) VALUES ($1, 'grades', 9, 1)`, [A])), '42501', 'insert other collection');
      await refuses(as(tok(tA), c => c.query(`INSERT INTO payesh_direct.record (tenant_id, collection, record_id, class_id) VALUES ($1, 'attendance', 10, 1)`, [B])), '42501', 'insert into school B');
      await refuses(as(tok(tA), c => c.query(`UPDATE payesh_direct.record SET class_id = 2 WHERE tenant_id = $1 AND collection = 'attendance' AND record_id = 1`, [A])), '42501', 'move out of scope');
      await refuses(as(tok(tA), c => c.query(`DELETE FROM payesh_direct.record WHERE tenant_id = $1`, [A])), '42501', 'delete');
      await refuses(as(tok(pA), c => c.query(`UPDATE payesh_direct.record SET payload = '{}' WHERE record_id = 1 RETURNING 1`)).then(r => { if (r.rowCount) throw new Error('parent updated a row'); const e = new Error('0 rows'); e.code = 'NOROWS'; throw e; }), 'NOROWS', 'parent (read-only) update touches 0 rows');
      const upd = await as(tok(mB), c => c.query(`UPDATE payesh_direct.record SET payload = '{"x":1}' WHERE tenant_id = $1`, [A]));
      zero(upd.rowCount, 'manager B updating A rows');
      const ok = await as(tok(tA), c => c.query(`UPDATE payesh_direct.record SET version = version + 1, updated_at = now() WHERE tenant_id = $1 AND collection = 'attendance' AND record_id = 1`, [A]));
      eq(ok.rowCount, 1, 'in-scope update');
      return 'in-scope insert+update ok; class 2 / grades / school B / move-out / delete refused; parent & manager B touch 0 rows';
    });

    /* ── DI-12 no / unknown identity ─────────────────────────────────── */
    await check('DI-12', 'NEGATIVE no token, unknown subject ⇒ 0 rows and no identity', async () => {
      for (const tbl of ['record', 'app_user', 'device', 'capability', 'identity_audit']) zero(await count(null, tbl), `no token ${tbl}`);
      zero(await count({ sub: 'sub-nobody', device_id: mA.device }), 'unknown subject with a real device id');
      const who = await rows(null, 'SELECT payesh_direct.current_user_id() AS u, payesh_direct.current_tenant_id() AS t');
      assert(who[0].u === null && who[0].t === null, 'identity without token');
      await refuses(as(null, c => c.query(`SELECT payesh_direct.revoke_device($1)`, [mA.device])), '42501', 'revoke without token');
      return 'no token 0 everywhere; unknown subject 0';
    });

    /* ── DI-13 mutation controls (each mutant must be caught) ─────────── */
    await check('DI-13', 'mutation controls: 5 broken variants of the migration, each caught by the negative checks above', async () => {
      async function underMutant(ddl, claims, probe) {
        const c = await admin.connect();
        try {
          await c.query('BEGIN');
          await c.query(ddl);
          await c.query('SET LOCAL ROLE payesh_direct_client');
          await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
          return await probe(c);
        } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
      }
      const n = async c => Number((await c.query('SELECT count(*)::int AS n FROM payesh_direct.record')).rows[0].n);
      const out = [];
      // M1: identity ignores the disabled/revoked flags ⇒ a disabled parent sees rows again
      await as(tok(mA), c => c.query('SELECT payesh_direct.set_user_disabled($1, true)', [pA.id]));
      zero(await count(tok(pA)), 'disabled parent before M1');
      const m1 = await underMutant(`CREATE OR REPLACE FUNCTION payesh_direct.current_user_id() RETURNS uuid
          LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
          SELECT u.id FROM payesh_direct.app_user u
            JOIN payesh_direct.device d ON d.user_id = u.id AND d.tenant_id = u.tenant_id
           WHERE u.auth_subject = payesh_direct.auth_subject()
             AND d.id = payesh_direct.request_device_id() AND d.revoked_at IS NULL $$`, tok(pA), n);
      assert(m1 > 0, 'M1 not caught'); out.push(`M1 disabled-user leak ${m1}`);
      zero(await count(tok(pA)), 'M1 restored (parent still disabled)');
      await as(tok(mA), c => c.query('SELECT payesh_direct.set_user_disabled($1, false)', [pA.id]));
      eq(await count(tok(pA)), 2, 'parent re-enabled');
      // M2: can_access forgets the tenant ⇒ manager B sees school A
      const m2 = await underMutant(`CREATE OR REPLACE FUNCTION payesh_direct.can_access(p_action text, p_tenant uuid, p_collection text, p_class bigint, p_student bigint)
          RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
          SELECT EXISTS (SELECT 1 FROM payesh_direct.app_user u WHERE u.id = payesh_direct.current_user_id() AND u.role = 'manager') $$`,
        tok(mB), async c => Number((await c.query('SELECT count(*)::int AS n FROM payesh_direct.record WHERE tenant_id = $1', [A])).rows[0].n));
      assert(m2 > 0, 'M2 not caught'); out.push(`M2 cross-school leak ${m2}`);
      // M3: permissive read policy ⇒ a guard without capability sees rows
      const m3 = await underMutant(`DROP POLICY record_read ON payesh_direct.record;
          CREATE POLICY record_read ON payesh_direct.record FOR SELECT TO payesh_direct_client USING (true)`, tok(gA), n);
      assert(m3 > 0, 'M3 not caught'); out.push(`M3 role leak ${m3}`);
      // M4: table write granted ⇒ a teacher grants himself the whole school
      const m4 = await underMutant(`GRANT INSERT ON payesh_direct.capability TO payesh_direct_client;
          GRANT USAGE ON SEQUENCE payesh_direct.capability_id_seq TO payesh_direct_client;
          CREATE POLICY cap_ins ON payesh_direct.capability FOR INSERT TO payesh_direct_client WITH CHECK (true)`, tok(tA),
        async c => (await c.query(`INSERT INTO payesh_direct.capability (tenant_id, user_id, action, scope_kind, granted_by) VALUES ($1, $2, 'read', 'school', $2) RETURNING id`, [A, tA.id])).rowCount);
      assert(m4 === 1, 'M4 not caught'); out.push('M4 self-grant succeeded');
      // M5: the NULL-logic bug found while writing this test (non-manager ⇒ mt NULL ⇒ IF NULL ⇒ no refusal)
      const fs = require('fs');
      const src = fs.readFileSync(path.join(ROOT, DIR, '0001_direct_identity.up.sql'), 'utf8');
      const fn = src.slice(src.indexOf('CREATE OR REPLACE FUNCTION payesh_direct.revoke_device'), src.indexOf('CREATE OR REPLACE FUNCTION payesh_direct.grant_capability'));
      const buggy = fn.replace('NOT coalesce(d.user_id = me OR d.tenant_id = mt, false)', 'NOT (d.user_id = me OR d.tenant_id = mt)');
      assert(buggy !== fn, 'M5 mutation did not apply');
      const tBefore = await count(tok(tA));
      assert(tBefore > 0, 'teacher has rows before M5');
      const m5 = await underMutant(buggy, { sub: pA.sub, device_id: pA.device },
        async c => { await c.query('SELECT payesh_direct.revoke_device($1)', [tA.device]); return 'revoked'; });
      eq(m5, 'revoked', 'M5 not caught'); out.push('M5 parent revoked a teacher device');
      eq(await count(tok(tA)), tBefore, 'M5 restored (teacher device intact)');
      mutantsKilled = 5;
      // and the real schema is unchanged after the rolled-back mutants
      zero(await count(tok(tA2)), 'M1 restored'); zero(await count(tok(gA)), 'M3 restored');
      zero((await rows(tok(mB), 'SELECT * FROM payesh_direct.record WHERE tenant_id = $1', [A])).length, 'M2 restored');
      await refuses(as(tok(tA), c => c.query(`INSERT INTO payesh_direct.capability (tenant_id, user_id, action, scope_kind, granted_by) VALUES ($1, $2, 'read', 'school', $2)`, [A, tA.id])), '42501', 'M4 restored');
      return out.join('; ') + ' — all 5 caught, schema restored';
    });

    /* ── DI-14 rollback and re-apply ─────────────────────────────────── */
    await check('DI-14', 'rollback through the migrator removes the schema; re-apply is clean', async () => {
      await api.end(); api = null;
      await admin.end(); admin = null;
      const r = cli(['rollback', '--to', '0000', '--dir', DIR], DB_URL);
      assert(r.code === 0, 'rollback: ' + r.out);
      const c = new Client({ connectionString: DB_URL }); c.on('error', () => {}); await c.connect();
      try {
        eq((await c.query(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'payesh_direct'`)).rows[0].n, 0, 'schema after rollback');
        const u = cli(['up', '--dir', DIR], DB_URL);
        assert(u.code === 0, 're-up: ' + u.out);
        eq((await c.query(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'payesh_direct'`)).rows[0].n, 16, 'functions after re-up');
      } finally { await c.end(); }
      return 'down ⇒ schema gone; up ⇒ 16 functions';
    });
  } finally {
    if (api) await api.end().catch(() => {});
    if (admin) await admin.end().catch(() => {});
    await root.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [DB]).catch(() => {});
    await root.query(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
    await root.end().catch(() => {});
  }

  const sv = process.env.DI106_SERVER_VERSION || '';
  console.log(`\n# passed=${passed} failed=${failed} negative_controls=${negatives} mutants_killed=${mutantsKilled}${sv ? ' server=' + sv : ''}`);
  if (failed) {
    console.log('DIRECT-IDENTITY-106-FAIL ' + failures.join(','));
    const e = new Error('row 106 failures: ' + failures.join(','));
    e.result = { passed, failed };
    throw e;
  }
  console.log('DIRECT-IDENTITY-106-OK');
  return { passed, negative_controls: negatives, mutants_killed: mutantsKilled };
}

module.exports = { main };
if (require.main === module) main().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
