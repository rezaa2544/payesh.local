'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 82, direct path: load test + measurement on the sync RPCs + RLS of
   real PostgreSQL (ADR-105 §3.3, Proposed).        LDD-01 .. LDD-10

   tools/load-82-direct.mjs: 2,000 devices / 20 schools call
   payesh_direct.sync_pull / sync_push with PostgREST transaction
   semantics (SET LOCAL ROLE payesh_direct_client + verified claims, one
   transaction per call, fixed pool) from a LOGIN role without BYPASSRLS.
   Every number is [S]. [M] is OWNER-only (T2).

   Gates: error rate ≤ 0.5% · p95 ≤ 1000 ms · op integrity (no stale /
   conflict / rejected / duplicate, records in the DB = records applied) ·
   no session leak (no idle-in-transaction left, peak ≤ pool) · tenant
   isolation under load (RLS) · labels / no "unlimited" claim.

   Negatives on the same live database (each injection is undone after):
     LDD-04 a 5-ops-per-minute plan                      ⇒ error gate red
     LDD-05 a 1.2 s sleep trigger on record              ⇒ p95 gate red
     LDD-06 a transaction left open by the API role      ⇒ session gate red
     LDD-07 record_read replaced by USING (true)         ⇒ isolation red
   LDD-08 control: the same short profile, injections undone, is green.
   LDD-09 the finding of this row (migration 0006): the feed query uses
          the tenant index condition + InitPlans on head, and goes back to
          a per-row can_access() filter without it.
   LDD-10 defence in depth from 0006: can_access() forced to true still
          leaves school B blind to school A (policy tenant predicate).

   Env: PAYESH_PG_ADMIN. LOAD82D_REQUIRE_PG=1 turns a missing PG into a
        failure. LOAD82D_DEVICES (2000), LOAD82D_DURATION (30),
        LOAD82D_CONCURRENCY (64), LOAD82D_OUT=<file> raw JSON of the main run.
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = process.env.PAYESH_PG_ADMIN || '';
const UP6 = path.join(ROOT, 'db/migrations/direct/0006_direct_rls_initplan.up.sql');
const DOWN6 = path.join(ROOT, 'db/migrations/direct/0006_direct_rls_initplan.down.sql');
let passed = 0, failed = 0, skipped = 0; const failures = [];
async function check(id, desc, fn) {
  try { const d = await fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; failures.push(id); console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 400)}`); }
}
function skip(id, desc, why) { skipped++; console.log(`SKIP  ${id}  ${desc}  → ${why}`); }
function assert(c, m) { if (!c) throw new Error(m); }

/* injections: constant SQL, executed by the database owner, undone after */
const INJ = Object.freeze({
  tinyPlan: 'UPDATE payesh_direct.tenant_plan SET max_ops_per_window = 5, window_sec = 60',
  bigPlan: 'UPDATE payesh_direct.tenant_plan SET max_ops_per_window = 10000000, window_sec = 60',
  resetUsage: 'UPDATE payesh_direct.tenant_usage SET window_ops = 0',
  sleepFn: `CREATE OR REPLACE FUNCTION public.ld82_sleep() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN PERFORM pg_sleep(1.2); RETURN NEW; END $$`,
  sleepOn: `CREATE TRIGGER ld82_sleep BEFORE INSERT OR UPDATE ON payesh_direct.record
            FOR EACH ROW EXECUTE FUNCTION public.ld82_sleep()`,
  sleepOff: 'DROP TRIGGER IF EXISTS ld82_sleep ON payesh_direct.record',
  sleepFnOff: 'DROP FUNCTION IF EXISTS public.ld82_sleep()',
  openRls: `DROP POLICY IF EXISTS record_read ON payesh_direct.record;
            CREATE POLICY record_read ON payesh_direct.record FOR SELECT TO payesh_direct_client USING (true)`,
  canAccessDef: `SELECT pg_get_functiondef('payesh_direct.can_access(text, uuid, text, bigint, bigint)'::regprocedure) AS d`,
  canAccessTrue: `CREATE OR REPLACE FUNCTION payesh_direct.can_access(p_action text, p_tenant uuid, p_collection text, p_class bigint, p_student bigint)
                  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT true $$`,
  countTenant: 'SELECT count(*)::int AS n FROM payesh_direct.record WHERE tenant_id = $1',
  feedPlan: 'EXPLAIN SELECT r.seq FROM payesh_direct.record r WHERE r.seq > 0 ORDER BY r.seq LIMIT 51',
});

(async () => {
  const L = await import(pathToFileURL(path.join(ROOT, 'tools', 'load-82-direct.mjs')).href);

  await check('LDD-01', 'gates on synthetic reports: green baseline; stale op / record mismatch / idle-in-transaction / peak over pool / foreign row / "unlimited" each ⇒ red; CLI --label M without PAYESH_T2_MANAGED_DB ⇒ exit 2', async () => {
    const base = () => ({
      label: '[S]', requests: { label: '[S]', measured: 1000 },
      latency_ms: { label: '[S]', all: { p95: 100 } }, errors: { label: '[S]', rate: 0 },
      throughput: { label: '[S]' }, memory: { label: '[S]' },
      op_integrity: { stale: 0, conflicts: 0, rejected: 0, duplicates: 0, records_db: 10, records_expected: 10 },
      sessions: { pool: 32, peak: 32, idle_in_tx_after: 0 }, isolation: { foreign_rows: 0, mismatched: 0 },
    });
    assert(L.gates(base()).length === 0, 'baseline red: ' + L.gates(base()));
    const muts = {
      stale: r => { r.op_integrity.stale = 1; }, records: r => { r.op_integrity.records_db = 9; },
      idle: r => { r.sessions.idle_in_tx_after = 1; }, peak: r => { r.sessions.peak = 33; },
      foreign: r => { r.isolation.foreign_rows = 3; }, claim: r => { r.claim_scope = 'unlimited devices'; },
      label: r => { r.errors.label = undefined; }, p95: r => { r.latency_ms.all.p95 = 1001; }, err: r => { r.errors.rate = 0.006; },
    };
    const red = [];
    for (const [k, f] of Object.entries(muts)) { const r = base(); f(r); const g = L.gates(r); assert(g.length > 0, k + ' stayed green'); red.push(k); }
    const env = Object.assign({}, process.env); delete env.PAYESH_T2_MANAGED_DB;
    const cli = spawnSync(process.execPath, ['tools/load-82-direct.mjs', '--label', 'M', '--duration', '1'], { cwd: ROOT, env, encoding: 'utf8' });
    assert(cli.status === 2 && /OWNER-only/.test(cli.stderr), 'CLI [M] not refused: ' + cli.status + ' ' + cli.stderr.slice(0, 200));
    return `baseline green; red: ${red.join(',')}; CLI label M without the owner flag: exit 2`;
  });

  if (!ADMIN) {
    const why = 'PAYESH_PG_ADMIN not set';
    if (process.env.LOAD82D_REQUIRE_PG === '1') { failed++; failures.push('LDD-PG'); console.log('FAIL  LDD-PG  PostgreSQL required (LOAD82D_REQUIRE_PG=1)  → ' + why); }
    else for (const id of ['LDD-02', 'LDD-03', 'LDD-04', 'LDD-05', 'LDD-06', 'LDD-07', 'LDD-08', 'LDD-09', 'LDD-10']) skip(id, 'needs PostgreSQL', why);
    return finish();
  }

  const DEVICES = Number(process.env.LOAD82D_DEVICES || 2000);
  const DURATION = Number(process.env.LOAD82D_DURATION || 30);
  const CONC = Number(process.env.LOAD82D_CONCURRENCY || 64);
  const SHORT = { devices: 200, duration: 6, warmup: 1, concurrency: 16 };
  let ctx, main;
  try {
    ctx = await L.prepare({ devices: DEVICES, tenants: 20, pool: 32 });
    console.log(`      setup [S]: ${DEVICES} devices / 20 schools enrolled + keys registered in ${ctx.setupMs} ms (${ctx.migrateOut})`);

    await check('LDD-02', `main run [S]: ${DEVICES} devices / 20 schools, ${CONC} concurrent, pool 32, ${DURATION}s on the direct RPCs + RLS ⇒ error rate ≤ 0.5%, p95 ≤ 1000 ms, op integrity, no session leak, isolation`, async () => {
      main = await L.run(ctx, { duration: DURATION, warmup: 5, concurrency: CONC, pushRatio: 0.2 });
      if (process.env.LOAD82D_OUT) fs.writeFileSync(process.env.LOAD82D_OUT, JSON.stringify(main, null, 2) + '\n');
      console.log(L.summary(main).split('\n').map(l => '      ' + l).join('\n'));
      assert(main.gates.red.length === 0, 'gates red: ' + main.gates.red.join(' | '));
      assert(main.op_integrity.applied > 500 && main.latency_ms.pull.n > 0 && main.latency_ms.push.n > 0, 'too little traffic');
      return `[S] calls=${main.requests.measured} rps=${main.throughput.rps} p50/p95/p99=${main.latency_ms.all.p50}/${main.latency_ms.all.p95}/${main.latency_ms.all.p99}ms err=${main.errors.rate} ops=${main.op_integrity.applied} records=${main.op_integrity.records_db}/${main.op_integrity.records_expected} sessions peak=${main.sessions.peak}/${main.sessions.pool}`;
    });

    await check('LDD-03', 'every number is labelled [S]: report sections + summary lines; no capacity claim; per-RPC latency and session samples present', async () => {
      assert(main, 'no main report');
      const keys = ['requests', 'latency_ms', 'errors', 'throughput', 'op_integrity', 'sessions', 'isolation', 'memory', 'gates'];
      const bad = keys.filter(k => main[k].label !== '[S]');
      assert(!bad.length, 'unlabelled: ' + bad);
      const lines = L.summary(main).split('\n');
      assert(lines.every(l => l.startsWith('[S] ')), 'unlabelled summary line');
      assert(main.session_samples.length >= DURATION - 2, 'session samples missing');
      return `sections labelled=${keys.length}/${keys.length} · summary lines=${lines.length} all [S] · session samples=${main.session_samples.length}`;
    });

    await check('LDD-04', 'negative: plan cut to 5 ops per minute per school ⇒ sync_push refuses ⇒ error-rate gate red', async () => {
      await ctx.owner.query(INJ.tinyPlan);
      let r;
      try { r = await L.run(ctx, Object.assign({}, SHORT, { pushRatio: 0.5 })); }
      finally { await ctx.owner.query(INJ.bigPlan); await ctx.owner.query(INJ.resetUsage); }
      assert(r.gates.red.some(g => g.startsWith('error_rate')), 'error gate stayed green: ' + JSON.stringify(r.errors));
      return `red: error_rate=${r.errors.rate} sqlstates=${JSON.stringify(r.errors.sqlstates)}`;
    });

    await check('LDD-05', 'negative: 1.2 s sleep trigger on payesh_direct.record ⇒ p95 gate red', async () => {
      await ctx.owner.query(INJ.sleepFn); await ctx.owner.query(INJ.sleepOn);
      let r;
      try { r = await L.run(ctx, Object.assign({}, SHORT, { pushRatio: 0.9 })); }
      finally { await ctx.owner.query(INJ.sleepOff); await ctx.owner.query(INJ.sleepFnOff); }
      assert(r.gates.red.some(g => g.startsWith('p95')), 'p95 gate stayed green: ' + JSON.stringify(r.latency_ms.all));
      return `red: p95=${r.latency_ms.all.p95}ms`;
    });

    await check('LDD-06', 'negative: a transaction left open by the API role during the run ⇒ session-leak gate red', async () => {
      const { Client } = require('pg');
      const u = new URL(ctx.dbUrl); u.username = L.API_ROLE; u.password = '';
      const leak = new Client({ connectionString: u.toString() }); leak.on('error', () => {});
      await leak.connect();
      let r;
      try {
        await leak.query('BEGIN'); await leak.query('SELECT 1');
        r = await L.run(ctx, SHORT);
      } finally { await leak.query('ROLLBACK').catch(() => {}); await leak.end().catch(() => {}); }
      assert(r.gates.red.some(g => g.startsWith('session_leak')), 'session gate stayed green: ' + JSON.stringify(r.sessions));
      return `red: idle_in_tx_after=${r.sessions.idle_in_tx_after} peak=${r.sessions.peak}/${r.sessions.pool}`;
    });

    await check('LDD-07', 'negative: RLS mutant record_read USING (true) ⇒ isolation gate red (devices see other schools)', async () => {
      await ctx.owner.query(INJ.openRls);
      let r;
      try { r = await L.run(ctx, SHORT); }
      finally { await ctx.owner.query(fs.readFileSync(UP6, 'utf8')); }
      assert(r.gates.red.some(g => g.startsWith('isolation')), 'isolation gate stayed green: ' + JSON.stringify(r.isolation));
      return `red: foreign_rows=${r.isolation.foreign_rows} mismatched=${r.isolation.mismatched}/${r.isolation.schools_checked}`;
    });

    await check('LDD-08', 'control: the same short profile with every injection undone is green (the negatives come from the injections)', async () => {
      const r = await L.run(ctx, SHORT);
      assert(r.gates.red.length === 0, 'control red: ' + r.gates.red.join(' | '));
      return `green: p95=${r.latency_ms.all.p95}ms err=${r.errors.rate} isolation foreign=${r.isolation.foreign_rows} sessions idle_tx=${r.sessions.idle_in_tx_after}`;
    });

    await check('LDD-09', 'finding of this row (migration 0006): as a device, the feed walk uses record_feed_idx with tenant_id = InitPlan; with 0006 rolled back it filters can_access() row by row and has no tenant index condition', async () => {
      const dev = ctx.devices[0];
      const plan = async () => {
        const c = await ctx.api.connect();
        try {
          await c.query('BEGIN'); await c.query('SET LOCAL ROLE payesh_direct_client');
          await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(dev.claims)]);
          const r = await c.query(INJ.feedPlan);
          await c.query('ROLLBACK');
          return r.rows.map(x => x['QUERY PLAN']).join('\n');
        } finally { c.release(); }
      };
      const head = await plan();
      assert(/InitPlan/.test(head) && /Index Cond: \(\(tenant_id = \$\d\)/.test(head), 'head plan without tenant index condition:\n' + head);
      await ctx.owner.query(fs.readFileSync(DOWN6, 'utf8'));
      let before;
      try { before = await plan(); } finally { await ctx.owner.query(fs.readFileSync(UP6, 'utf8')); }
      assert(!/tenant_id = \$/.test(before) && /can_access/.test(before), 'pre-0006 plan unexpectedly tenant-indexed:\n' + before);
      const again = await plan();
      assert(/Index Cond: \(\(tenant_id = \$\d\)/.test(again), 're-applied 0006 plan lost the tenant condition');
      return 'head: tenant_id = $InitPlan index condition · without 0006: per-row can_access filter · re-applied: tenant condition back';
    });

    await check('LDD-10', 'defence in depth from 0006: with can_access() forced to true, a device of school B still sees zero records of school A (the policy tenant predicate holds on its own); restored after', async () => {
      const def = (await ctx.owner.query(INJ.canAccessDef)).rows[0].d;
      const A = ctx.schools[0], B = ctx.schools[1];
      const devB = ctx.devices.find(d => d.school === B);
      const seeA = async () => {
        const c = await ctx.api.connect();
        try {
          await c.query('BEGIN'); await c.query('SET LOCAL ROLE payesh_direct_client');
          await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(devB.claims)]);
          const r = await c.query(INJ.countTenant, [A.tenant]);
          await c.query('ROLLBACK');
          return r.rows[0].n;
        } finally { c.release(); }
      };
      const truthA = (await ctx.owner.query(INJ.countTenant, [A.tenant])).rows[0].n;
      assert(truthA > 0, 'school A has no records');
      await ctx.owner.query(INJ.canAccessTrue);
      let seen;
      try { seen = await seeA(); } finally { await ctx.owner.query(def); }
      assert(seen === 0, `B saw ${seen} of A's rows with can_access forced true`);
      const back = (await ctx.owner.query(INJ.canAccessDef)).rows[0].d;
      assert(back === def, 'can_access not restored');
      return `can_access→true: B sees 0/${truthA} of A's records · can_access restored`;
    });
  } finally {
    await L.teardown(ctx).catch(e => console.log('      teardown: ' + e.message));
  }
  finish();
})().catch((e) => { console.log('LOAD-82-DIRECT-TEST-FAILED crashed: ' + (e && e.stack || e)); process.exit(1); });

function finish() {
  console.log(`# passed=${passed} failed=${failed} skipped=${skipped}${failures.length ? ' failures=' + failures.join(',') : ''}`);
  console.log(failed ? 'LOAD-82-DIRECT-TEST-FAILED' : 'LOAD-82-DIRECT-TEST-OK');
  process.exit(failed ? 1 : 0);
}
