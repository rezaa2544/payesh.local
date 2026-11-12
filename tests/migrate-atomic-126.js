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
    const s = await load(c => tenancy.migrate(c), { secs: Number(process.env.MIG126_SECS || 6), stopOnFailure: false });
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

  const root2 = new Client({ connectionString: ADMIN });
  await root2.connect();
  await root2.query(`drop database if exists ${DB} with (force)`).catch(() => root2.query(`drop database if exists ${DB}`));
  await root2.end();
  console.log(`\nchecks=${passed + failed} pass=${passed} fail=${failed}`);
  console.log(failed ? `MIGRATE-ATOMIC-126-FAILED fail=${failed}` : 'MIGRATE-ATOMIC-126-OK');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
