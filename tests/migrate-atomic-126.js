'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 126 (CI finding) — tenancy.migrate() is atomic under live traffic.

   Root cause found in native-client gateway-real (W2-IT-01..04, W3-IT-02:
   "503 quota_unavailable"): every Dart IT harness runs tenancy.migrate() on the
   shared database while other harnesses already serve requests. migrate() ran
   statement by statement outside a transaction, so between DROP POLICY and
   CREATE POLICY a FORCE-RLS table had no policy and PostgreSQL refused every
   write ("new row violates row-level security policy for table gateway_quota").
   In production the same window opens on every rolling deploy/restart of a
   Gateway instance while another one serves schools; two instances starting at
   once also broke each other (42710 policy exists / tuple concurrently updated).

     M126-01  migrate = one transaction + pg_advisory_xact_lock, retries 40P01/40001
     M126-02  3 concurrent migrators + 6 runtime writers (real takeQuota upserts):
              0 RLS refusals, 0 other errors, 0 migration failures
     M126-03  NEGATIVE CONTROL: the previous statement-by-statement migrate under
              the same load must produce RLS refusals or migration failures
     M126-04  schema still complete afterwards: every FORCE-RLS table has its policy

   Row 129 (CI finding, gateway-real W2-IT-03 / W3-IT-03 / W3-IT-08 "applied 0"): the row-126
   migrate upgraded table locks statement by statement, so a concurrent multi-table push deadlocked
   with it (40P01) and the live push — not only the migration — could be the victim (503, outbox
   stays pending). Fix: steady-state migrate is DDL-free (fingerprint), a real migration takes all
   tenancy tables ACCESS EXCLUSIVE up front in one fixed order, and withTenant re-runs a whole
   transaction on 40P01/40001.
     M126-05  3 forced migrators + 6 REAL multi-table pushes (tenancy.applyOps): 0 deadlocks, 0 lost pushes
     M126-06  NEGATIVE CONTROL: the row-126 migrate under the same load deadlocks (40P01)
     M126-07  withTenant re-runs a deadlock victim (deterministic cycle); NEGATIVE with
              PAYESH_PG_TX_ATTEMPTS=1 the victim fails with 40P01
     M126-08  steady state: migrate skips DDL (no table lock — finishes while a live transaction holds
              product_ops/product_records); drift (a dropped policy) is detected and repaired

   Run: PAYESH_PG_ADMIN=… PAYESH_PG_RUNTIME=… node tests/migrate-atomic-126.js  (CI: api-contract)
   MIG126_REQUIRE_PG=1 turns "no PostgreSQL" into a failure; without it → BLOCKED (exit 3).
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = process.env.PAYESH_PG_ADMIN || '';
const RUNTIME = process.env.PAYESH_PG_RUNTIME || '';
if (!ADMIN || !RUNTIME) {
  if (process.env.MIG126_REQUIRE_PG === '1') { console.log('FAIL  PAYESH_PG_ADMIN/RUNTIME required (MIG126_REQUIRE_PG=1)'); process.exit(1); }
  console.log('BLOCKED — PAYESH_PG_ADMIN and PAYESH_PG_RUNTIME are required (CI provides PostgreSQL)');
  process.exit(3);
}

const { Client, Pool } = require('pg');
const tenancy = require(path.join(ROOT, 'server/tenancy.js'));
const DB = 'payesh_mig126';
const withDb = (url, db) => { const u = new URL(url); u.pathname = '/' + db; return u.toString(); };
const TID = '12612612-6126-4126-8126-126126126126';

let passed = 0, failed = 0;
async function check(id, desc, fn) {
  try { const d = await fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e)}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

/* the row-126 implementation (before row 129), kept verbatim as the M126-06 negative control */
async function row126Migrate(client) {
  await client.query('BEGIN');
  try {
    await client.query('select pg_advisory_xact_lock($1::bigint)', ['7061796573680126']);
    for (const sql of tenancy.SCHEMA_SQL) await client.query(sql);
    await client.query('COMMIT');
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) { /* noop */ } throw e; }
}

/* the pre-row-126 implementation, kept verbatim as the negative control */
async function legacyMigrate(client) {
  for (const sql of tenancy.SCHEMA_SQL) await client.query(sql);
}

async function load(migrateFn, { secs, stopOnFailure }) {
  const admin = withDb(ADMIN, DB), runtime = withDb(RUNTIME, DB);
  const pool = new Pool({ connectionString: runtime, max: 8 });
  const s = { ok: 0, rls: 0, other: 0, migs: 0, migErr: 0, errs: new Set() };
  let stop = false;
  const failedNow = () => s.rls + s.other + s.migErr > 0;
  const writer = async (i) => {
    while (!stop) {
      try { await tenancy.takeQuota(pool, TID, { deviceId: 'mig126-' + i, max: 1e9, windowSec: 60 }); s.ok++; }
      catch (e) { if (/row-level security/.test(e.message)) s.rls++; else { s.other++; s.errs.add(String(e.code) + ' ' + e.message.slice(0, 90)); } }
      if (stopOnFailure && failedNow()) stop = true;
    }
  };
  const migrator = async () => {
    while (!stop) {
      const c = new Client({ connectionString: admin });
      await c.connect();
      try { await migrateFn(c); s.migs++; }
      catch (e) { s.migErr++; s.errs.add('migrate ' + String(e.code) + ' ' + e.message.slice(0, 90)); }
      finally { await c.end(); }
      if (stopOnFailure && failedNow()) stop = true;
    }
  };
  const jobs = [0, 1, 2, 3, 4, 5].map(writer).concat([migrator(), migrator(), migrator()]);
  const t0 = Date.now();
  while (!stop && Date.now() - t0 < secs * 1000) await new Promise(r => setTimeout(r, 50));
  stop = true;
  await Promise.all(jobs);
  await pool.end();
  return s;
}
/* row 129: writers that run real multi-table pushes (ops ledger + product record + change feed) */
async function pushLoad({ secs, stopOnFailure, attempts, migrateFn = c => tenancy.migrate(c, { force: true }) }) {
  const prev = process.env.PAYESH_PG_TX_ATTEMPTS;
  process.env.PAYESH_PG_TX_ATTEMPTS = String(attempts);
  const admin = withDb(ADMIN, DB), runtime = withDb(RUNTIME, DB);
  const pool = new Pool({ connectionString: runtime, max: 8 });
  const s = { ok: 0, deadlock: 0, other: 0, migs: 0, migErr: 0, migDeadlock: 0, errs: new Set(), retries0: tenancy.txRetryCount() };
  let stop = false, seq = 0;
  const run = Math.random().toString(36).slice(2, 8);
  const failedNow = () => s.deadlock + s.other + s.migErr > 0;
  const writer = async (i) => {
    while (!stop) {
      const n = ++seq;
      try {
        const r = await tenancy.applyOps(pool, TID, { ops: [
          { uid: `m129-${run}-${i}-${n}-a`, collection: 'notes', type: 'put', id: 1 + (n % 40), data: { body: 'x' + n }, base_version: null },
          { uid: `m129-${run}-${i}-${n}-b`, collection: 'tags', type: 'put', id: 1 + (n % 40), data: { body: 'y' + n }, base_version: null },
        ] });
        if (r.counts.applied + r.counts.conflicts !== 2) throw new Error('push lost an op: ' + JSON.stringify(r.counts));
        s.ok++;
      } catch (e) { if (e && e.code === '40P01') s.deadlock++; else { s.other++; s.errs.add(String(e.code) + ' ' + String(e.message).slice(0, 90)); } }
      if (stopOnFailure && failedNow()) stop = true;
    }
  };
  const migrator = async () => {
    while (!stop) {
      const c = new Client({ connectionString: admin });
      await c.connect();
      try { await migrateFn(c); s.migs++; }
      catch (e) { if (e && e.code === '40P01') s.migDeadlock++; s.migErr++; s.errs.add('migrate ' + String(e.code) + ' ' + e.message.slice(0, 90)); }
      finally { await c.end(); }
      if (stopOnFailure && failedNow()) stop = true;
    }
  };
  const jobs = [0, 1, 2, 3, 4, 5].map(writer).concat([migrator(), migrator(), migrator()]);
  const t0 = Date.now();
  while (!stop && Date.now() - t0 < secs * 1000) await new Promise(r => setTimeout(r, 50));
  stop = true;
  await Promise.all(jobs);
  await pool.end();
  if (prev === undefined) delete process.env.PAYESH_PG_TX_ATTEMPTS; else process.env.PAYESH_PG_TX_ATTEMPTS = prev;
  s.retries = tenancy.txRetryCount() - s.retries0;
  return s;
}
const fmtPush = s => `pushes=${s.ok} deadlock_victims=${s.deadlock} other=${s.other} migrations=${s.migs} migrate_failed=${s.migErr} tx_reruns=${s.retries}` +
  (s.errs.size ? ' [' + [...s.errs].slice(0, 3).join(' | ') + ']' : '');

const fmt = s => `writes=${s.ok} rls_refused=${s.rls} other=${s.other} migrations=${s.migs} migrate_failed=${s.migErr}` +
  (s.errs.size ? ' [' + [...s.errs].slice(0, 3).join(' | ') + ']' : '');

(async () => {
  console.log('# row 126 atomic tenancy.migrate — node ' + process.version);
  const root = new Client({ connectionString: ADMIN });
  await root.connect();
  await root.query(`drop database if exists ${DB}`);
  await root.query(`create database ${DB}`);
  await root.end();
  {
    const c = new Client({ connectionString: withDb(ADMIN, DB) });
    await c.connect();
    try { await tenancy.migrate(c); } finally { await c.end(); }
  }

  await check('M126-01', 'migrate = one transaction + advisory lock, deadlock retry', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/tenancy.js'), 'utf8');
    const body = src.slice(src.indexOf('async function migrate('), src.indexOf('/* ── اتصال runtime'));
    const iBegin = body.indexOf("client.query('BEGIN')"), iLock = body.indexOf('pg_advisory_xact_lock'),
      iLoop = body.indexOf('for (const sql of SCHEMA_SQL)'), iCommit = body.indexOf("client.query('COMMIT')");
    assert(iBegin > 0 && iBegin < iLock && iLock < iLoop && iLoop < iCommit, 'BEGIN → advisory lock → schema → COMMIT');
    assert(/ROLLBACK/.test(body) && /40P01/.test(body), 'rollback + 40P01 retry');
    assert(Array.isArray(tenancy.SCHEMA_SQL) && tenancy.SCHEMA_SQL.length > 50, 'SCHEMA_SQL exported');
    return `${tenancy.SCHEMA_SQL.length} statements in one transaction`;
  });

  await check('M126-02', '3 concurrent migrators + 6 runtime writers: nothing refused, nothing broken', async () => {
    const s = await load(c => tenancy.migrate(c, { force: true }), { secs: Number(process.env.MIG126_SECS || 6), stopOnFailure: false });
    assert(s.rls === 0 && s.other === 0 && s.migErr === 0, fmt(s));
    assert(s.migs >= 10 && s.ok >= 500, 'load too small to prove anything: ' + fmt(s));
    return fmt(s);
  });

  await check('M126-03', 'NEGATIVE: the old statement-by-statement migrate breaks under the same load', async () => {
    const s = await load(legacyMigrate, { secs: 20, stopOnFailure: true });
    assert(s.rls + s.migErr > 0, 'legacy migrate survived 20 s of concurrent load — the test cannot see the race: ' + fmt(s));
    return fmt(s);
  });

  await check('M126-04', 'schema complete afterwards: every FORCE-RLS table has its isolation policy', async () => {
    const c = new Client({ connectionString: withDb(ADMIN, DB) });
    await c.connect();
    try {
      await tenancy.migrate(c);
      const r = await c.query(`select c.relname, (select count(*) from pg_policies p where p.tablename = c.relname)::int as n
                                 from pg_class c where c.relforcerowsecurity and c.relkind = 'r' order by 1`);
      assert(r.rows.length >= 8, 'expected the tenancy FORCE-RLS tables, got ' + r.rows.length);
      const bare = r.rows.filter(x => x.n < 1).map(x => x.relname);
      assert(!bare.length, 'FORCE-RLS table without policy: ' + bare.join(', '));
      return `${r.rows.length} tables, all with a policy`;
    } finally { await c.end(); }
  });

  await check('M126-05', 'row 129: 3 forced migrators + 6 REAL multi-table pushes: no deadlock, no push lost', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/tenancy.js'), 'utf8');
    const mig = src.slice(src.indexOf('async function migrate('), src.indexOf('/* ── اتصال runtime'));
    assert(mig.indexOf('MIGRATE_LOCK_SQL') > 0 && mig.indexOf('MIGRATE_LOCK_SQL') < mig.indexOf('for (const sql of SCHEMA_SQL)'), 'migrate: all tables locked up front, before the DDL');
    const s = await pushLoad({ secs: Number(process.env.MIG126_SECS || 8), stopOnFailure: false, attempts: 4 });
    assert(s.deadlock === 0 && s.other === 0 && s.migErr === 0, fmtPush(s));
    assert(s.migs >= 10 && s.ok >= 200, 'load too small to prove anything: ' + fmtPush(s));
    return fmtPush(s);
  });

  await check('M126-06', 'NEGATIVE: the row-126 migrate (lock upgrades statement by statement) deadlocks under the same load', async () => {
    const s = await pushLoad({ secs: 30, stopOnFailure: true, attempts: 1, migrateFn: row126Migrate });
    assert(s.deadlock + s.migDeadlock > 0, 'no 40P01 in 30 s — the test cannot see the race: ' + fmtPush(s));
    return fmtPush(s);
  });

  await check('M126-07', 'withTenant re-runs a deadlock victim; NEGATIVE: PAYESH_PG_TX_ATTEMPTS=1 surfaces 40P01', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/tenancy.js'), 'utf8');
    const body = src.slice(src.indexOf('async function withTenant('), src.indexOf('let txRetries'));
    assert(/RETRYABLE_TX\.has\(e\.code\)/.test(body) && /ROLLBACK/.test(body) && /attempt >= attempts/.test(body), 'withTenant: rollback + bounded 40P01/40001 re-run');
    const cycle = async (attempts) => {
      const prev = process.env.PAYESH_PG_TX_ATTEMPTS;
      process.env.PAYESH_PG_TX_ATTEMPTS = String(attempts);
      const pool = new Pool({ connectionString: withDb(RUNTIME, DB), max: 4 });
      let calls = 0, arrived = 0, release;
      const barrier = new Promise(r => { release = r; });
      const tx = (first, second) => tenancy.withTenant(pool, TID, async (c) => {
        calls++;
        await c.query('select pg_advisory_xact_lock($1)', [first]);
        if (++arrived === 2) release();
        await barrier;
        await c.query('select pg_advisory_xact_lock($1)', [second]);
        return 'ok';
      });
      const res = await Promise.allSettled([tx(129001, 129002), tx(129002, 129001)]);
      await pool.end();
      if (prev === undefined) delete process.env.PAYESH_PG_TX_ATTEMPTS; else process.env.PAYESH_PG_TX_ATTEMPTS = prev;
      return { calls, ok: res.filter(r => r.status === 'fulfilled').length,
        dl: res.filter(r => r.status === 'rejected' && r.reason && r.reason.code === '40P01').length };
    };
    const good = await cycle(4);
    assert(good.ok === 2 && good.calls === 3, 'default: both transactions must commit after one re-run: ' + JSON.stringify(good));
    const bad = await cycle(1);
    assert(bad.ok === 1 && bad.dl === 1, 'ATTEMPTS=1: exactly one deadlock victim must surface: ' + JSON.stringify(bad));
    return `default ok=${good.ok} calls=${good.calls} · no-retry ok=${bad.ok} 40P01=${bad.dl}`;
  });

  await check('M126-08', 'steady state: migrate is DDL-free (no table lock); drift is repaired', async () => {
    const admin = new Client({ connectionString: withDb(ADMIN, DB) });
    const live = new Client({ connectionString: withDb(RUNTIME, DB) });
    await admin.connect(); await live.connect();
    try {
      const first = await tenancy.migrate(admin);
      assert(first.skipped === true && first.fingerprint === tenancy.SCHEMA_FINGERPRINT, 'schema current ⇒ skipped: ' + JSON.stringify(first));
      await live.query('BEGIN');
      await live.query("select set_config('app.tenant_id', $1, true)", [TID]);
      await live.query("insert into product_ops (tenant_id, uid) values ($1, 'm129-hold') on conflict do nothing", [TID]);
      await live.query('select 1 from product_records limit 1');
      await admin.query("set statement_timeout = '3s'");
      const t0 = Date.now();
      const held = await tenancy.migrate(admin);
      const ms = Date.now() - t0;
      await admin.query('set statement_timeout = 0');
      await live.query('ROLLBACK');
      assert(held.skipped === true && ms < 2000, `migrate waited behind a live transaction (${ms} ms)`);
      await admin.query('drop policy if exists gateway_quota_isolation on gateway_quota');
      const pols = async () => (await admin.query(`select count(*)::int n from pg_policy where polrelid = 'gateway_quota'::regclass`)).rows[0].n;
      assert(await pols() === 0, 'drift setup: policy still present');
      const repaired = await tenancy.migrate(admin);
      assert(repaired.skipped === false && await pols() >= 1, 'drift not repaired: ' + JSON.stringify(repaired));
      return `skipped=${first.skipped} under live tx ${ms} ms · drift → full run, policy restored`;
    } finally { await admin.end(); await live.end().catch(() => {}); }
  });

  const root2 = new Client({ connectionString: ADMIN });
  await root2.connect();
  await root2.query(`drop database if exists ${DB} with (force)`).catch(() => root2.query(`drop database if exists ${DB}`));
  await root2.end();
  console.log(`\nchecks=${passed + failed} pass=${passed} fail=${failed}`);
  console.log(failed ? `MIGRATE-ATOMIC-126-FAILED fail=${failed}` : 'MIGRATE-ATOMIC-126-OK');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
