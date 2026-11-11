'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 82: load test + measurement on a real Gateway and real PostgreSQL
   (LD-01 .. LD-08)

   tools/load-82.mjs drives thousands of virtual devices (own token,
   device id and pull cursor each) against server/gateway.js on PG.
   Every number it reports carries the label [S] (simulated).
   [M] is OWNER-only (T2 managed DB).

   Gates (the same ones CI enforces):
     error rate ≤ 0.5%
     p95 ≤ 1000 ms              (SLO from deploy/monitoring/slo-85.yml)
     no RSS leak (slope and growth)
     no "unlimited" claim, every section labelled

   Negative controls on real gateway processes (tests/fixtures/load-82-inject.cjs):
     an injected memory leak ⇒ leak gate red
     a killed push feature (503) ⇒ error gate red
     an injected 1.2 s delay ⇒ p95 gate red
     an "unlimited" claim, a missing label, or [M] without the owner's
       managed DB ⇒ refused

   Env: PAYESH_PG_ADMIN, PAYESH_PG_RUNTIME.
        LOAD82_REQUIRE_PG=1 turns a missing PG into a failure.
        LOAD82_DEVICES (2000), LOAD82_DURATION (30 s), LOAD82_CONCURRENCY (64)
        LOAD82_OUT=<file>: raw JSON report of the main run (evidence)
   ═══════════════════════════════════════════════════════════════════ */
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = process.env.PAYESH_PG_ADMIN || '';
const RUNTIME = process.env.PAYESH_PG_RUNTIME || '';
const SECRET = 'ld82-' + crypto.randomBytes(16).toString('hex');
const INJECT = path.join(ROOT, 'tests', 'fixtures', 'load-82-inject.cjs');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0, skipped = 0; const failures = [];
async function check(id, desc, fn) {
  try { const d = await fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; failures.push(id); console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 400)}`); }
}
function skip(id, desc, why) { skipped++; console.log(`SKIP  ${id}  ${desc}  → ${why}`); }
function assert(c, m) { if (!c) throw new Error(m); }
function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
const children = [];
async function startGw(name, env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server/gateway.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), HOST: '127.0.0.1', PGURL: RUNTIME, GW_SECRET: SECRET, GW_INSTANCE: 'ld82-' + name,
      GW_QUOTA_MAX: '10000000', GW_QUOTA_WINDOW_SEC: '3600', PAYESH_LOG: '0', GW_ACCESS_LOG: '0',
      PAYESH_FEATURE_KILL: '', PAYESH_CLIENT_KILL: '', GW_TENANT_QUOTA_MAX: '', NODE_OPTIONS: '',
    }, env),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.push(child);
  child.err = ''; child.stderr.on('data', d => { child.err += String(d); });
  child.base = 'http://127.0.0.1:' + port;
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(child.base + '/healthz'); if (r.ok) break; } catch (e) { /* retry */ }
    if (Date.now() - t0 > 20000) throw new Error('gateway ' + name + ' did not start: ' + child.err.slice(0, 300));
    await sleep(100);
  }
  return child;
}
function stopGw(c) { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } }

(async () => {
  const L = await import(pathToFileURL(path.join(ROOT, 'tools', 'load-82.mjs')).href);

  await check('LD-01', 'measurement math: quantiles, least-squares slope, leak verdict (flat RSS ⇒ no leak; +120 MB/min ⇒ leak; noise only ⇒ no leak)', async () => {
    const s = Array.from({ length: 100 }, (_, i) => i + 1);
    assert(L.quantile(s, 0.5) === 50 && L.quantile(s, 0.95) === 95 && L.quantile(s, 0.99) === 99, 'quantile');
    assert(Math.abs(L.slope([[0, 1], [1, 3], [2, 5], [3, 7]]) - 2) < 1e-9, 'slope');
    const flat = Array.from({ length: 30 }, (_, i) => ({ t_s: i, rss_mb: 80 + (i % 3) }));
    const grow = Array.from({ length: 30 }, (_, i) => ({ t_s: i, rss_mb: 80 + 2 * i }));
    const noisy = Array.from({ length: 30 }, (_, i) => ({ t_s: i, rss_mb: 80 + ((i * 7) % 11) }));
    assert(!L.leakVerdict(flat, 2).leak_suspected, 'flat flagged');
    assert(L.leakVerdict(grow, 2).leak_suspected, 'growth not flagged');
    assert(!L.leakVerdict(noisy, 2).leak_suspected, 'noise flagged');
    return `flat=ok grow=leak(${L.leakVerdict(grow, 2).slope_mb_per_min}MB/min) noise=ok`;
  });

  await check('LD-02', 'claims gate: "unlimited"/"نامحدود" claim ⇒ refused; missing label ⇒ refused; target-DB label without managed DB ⇒ refused; CLI --label M without PAYESH_T2_MANAGED_DB ⇒ exit 2', async () => {
    const ok = { label: '[S]', environment: { managed_db_attested: false }, latency_ms: { label: '[S]' }, errors: { label: '[S]' }, throughput: { label: '[S]' }, memory: { label: '[S]' } };
    assert(L.claimsGate(ok).length === 0, 'clean report refused: ' + L.claimsGate(ok));
    const r1 = L.claimsGate(Object.assign({}, ok, { claim_scope: 'supports unlimited devices' }));
    const r2 = L.claimsGate(Object.assign({}, ok, { note: 'ظرفیت نامحدود' }));
    const r3 = L.claimsGate(Object.assign({}, ok, { label: undefined }));
    const r4 = L.claimsGate(Object.assign({}, ok, { label: '[M]', latency_ms: { label: '[M]' }, errors: { label: '[M]' }, throughput: { label: '[M]' }, memory: { label: '[M]' } }));
    const r5 = L.claimsGate(Object.assign({}, ok, { errors: { label: undefined } }));
    assert(r1.some(e => e.startsWith('forbidden_claim')) && r2.some(e => e.startsWith('forbidden_claim')), 'claim not refused');
    assert(r3.includes('missing_label') && r4.includes('label_M_without_managed_db') && r5.includes('unlabelled:errors'), 'label gate');
    const env = Object.assign({}, process.env); delete env.PAYESH_T2_MANAGED_DB;
    const cli = spawnSync(process.execPath, ['tools/load-82.mjs', '--base', 'http://127.0.0.1:9', '--secret', 'x', '--label', 'M', '--duration', '1'], { cwd: ROOT, env, encoding: 'utf8' });
    assert(cli.status === 2 && /OWNER-only/.test(cli.stderr), 'CLI --label M not refused: ' + cli.status + ' ' + cli.stderr.slice(0, 120));
    return 'unlimited⇒red · نامحدود⇒red · no label⇒red · target label unattested⇒red · CLI --label M⇒exit 2';
  });

  if (!ADMIN || !RUNTIME) {
    const why = 'PAYESH_PG_ADMIN/PAYESH_PG_RUNTIME not set';
    if (process.env.LOAD82_REQUIRE_PG === '1') { failed++; failures.push('LD-PG'); console.log('FAIL  LD-PG  PostgreSQL required (LOAD82_REQUIRE_PG=1)  → ' + why); }
    else for (const id of ['LD-03', 'LD-04', 'LD-05', 'LD-06', 'LD-07', 'LD-08']) skip(id, 'needs PostgreSQL', why);
    return finish();
  }
  const pg = require('pg');
  const tenancy = require(path.join(ROOT, 'server', 'tenancy.js'));
  const admin = new pg.Client({ connectionString: ADMIN }); admin.on('error', () => {});
  await admin.connect();
  await tenancy.migrate(admin);
  await admin.end();

  const DEVICES = Number(process.env.LOAD82_DEVICES || 2000);
  const DURATION = Number(process.env.LOAD82_DURATION || 30);
  const CONC = Number(process.env.LOAD82_CONCURRENCY || 64);
  let main;

  await check('LD-03', `main run [S]: ${DEVICES} devices / 20 tenants, ${CONC} concurrent, ${DURATION}s on Gateway+PG ⇒ error rate ≤ 0.5%, p95 ≤ 1000 ms, no RSS leak`, async () => {
    const gw = await startGw('main');
    try {
      main = await L.run({ base: gw.base, secret: SECRET, devices: DEVICES, tenants: 20, duration: DURATION, warmup: 5, concurrency: CONC, pushRatio: 0.2, gwPid: gw.pid });
    } finally { stopGw(gw); }
    if (process.env.LOAD82_OUT) fs.writeFileSync(process.env.LOAD82_OUT, JSON.stringify(main, null, 2) + '\n');
    console.log(L.summary(main).split('\n').map(l => '      ' + l).join('\n'));
    assert(main.gates.red.length === 0, 'gates red: ' + main.gates.red.join(' | '));
    assert(main.throughput.devices_active >= Math.min(DEVICES, 1000), 'too few devices exercised: ' + main.throughput.devices_active);
    return `[S] req=${main.requests.measured} rps=${main.throughput.rps} p50/p95/p99=${main.latency_ms.all.p50}/${main.latency_ms.all.p95}/${main.latency_ms.all.p99}ms err=${main.errors.rate} rss ${main.memory.start_mb}→${main.memory.end_mb}MB slope=${main.memory.slope_mb_per_min}MB/min`;
  });

  await check('LD-04', 'every number is labelled [S]: report sections + summary lines; no capacity claim; raw RSS samples and per-route latency present', async () => {
    assert(main, 'no main report');
    assert(L.claimsGate(main).length === 0, 'claims gate: ' + L.claimsGate(main));
    const lines = L.summary(main).split('\n');
    assert(lines.every(l => l.startsWith('[S] ')), 'unlabelled summary line');
    assert(main.rss_samples.length >= DURATION && main.latency_ms.pull.n > 0 && main.latency_ms.push.n > 0, 'raw data missing');
    return `sections labelled=${['latency_ms', 'errors', 'throughput', 'memory', 'requests', 'gates'].filter(k => main[k].label === '[S]').length}/6 · summary lines=${lines.length} all [S] · rss samples=${main.rss_samples.length}`;
  });

  await check('LD-05', 'negative: memory leak injected into the gateway (64 KB kept per request) ⇒ leak gate red', async () => {
    const gw = await startGw('leak', { NODE_OPTIONS: '--require ' + INJECT, LOAD82_INJECT_LEAK_KB: '64' });
    let r; try { r = await L.run({ base: gw.base, secret: SECRET, devices: 500, tenants: 5, duration: 12, warmup: 2, concurrency: 32, gwPid: gw.pid }); } finally { stopGw(gw); }
    assert(r.memory.leak_suspected && r.gates.red.some(g => g.startsWith('memory_leak')), 'leak not detected: ' + JSON.stringify(r.memory).slice(0, 200));
    return `red: slope=${r.memory.slope_mb_per_min}MB/min growth=${r.memory.growth_mb}MB`;
  });

  await check('LD-06', 'negative: push killed at the gateway (PAYESH_FEATURE_KILL=push ⇒ 503) ⇒ error-rate gate red', async () => {
    const gw = await startGw('err', { PAYESH_FEATURE_KILL: 'push' });
    let r; try { r = await L.run({ base: gw.base, secret: SECRET, devices: 300, tenants: 3, duration: 4, warmup: 1, concurrency: 16, gwPid: gw.pid }); } finally { stopGw(gw); }
    assert(r.gates.red.some(g => g.startsWith('error_rate')), 'error gate stayed green: ' + JSON.stringify(r.errors));
    return `red: error_rate=${r.errors.rate} statuses=${JSON.stringify(r.errors.statuses)}`;
  });

  await check('LD-07', 'negative: 1.2 s delay injected before every gateway request ⇒ p95 gate red', async () => {
    const gw = await startGw('slow', { NODE_OPTIONS: '--require ' + INJECT, LOAD82_INJECT_DELAY_MS: '1200' });
    let r; try { r = await L.run({ base: gw.base, secret: SECRET, devices: 200, tenants: 2, duration: 5, warmup: 1, concurrency: 16, gwPid: gw.pid }); } finally { stopGw(gw); }
    assert(r.gates.red.some(g => g.startsWith('p95')), 'p95 gate stayed green: ' + JSON.stringify(r.latency_ms.all));
    return `red: p95=${r.latency_ms.all.p95}ms`;
  });

  await check('LD-08', 'control: the same short profile on an unmodified gateway is green (the negatives are caused by the injection, not the profile)', async () => {
    const gw = await startGw('ctl');
    let r; try { r = await L.run({ base: gw.base, secret: SECRET, devices: 500, tenants: 5, duration: 12, warmup: 2, concurrency: 32, gwPid: gw.pid }); } finally { stopGw(gw); }
    assert(r.gates.red.length === 0, 'control red: ' + r.gates.red.join(' | '));
    return `green: p95=${r.latency_ms.all.p95}ms err=${r.errors.rate} slope=${r.memory.slope_mb_per_min}MB/min growth=${r.memory.growth_mb}MB`;
  });

  finish();
})().catch((e) => { for (const c of children) stopGw(c); console.log('LOAD-82-FAILED crashed: ' + (e && e.stack || e)); process.exit(1); });

function finish() {
  for (const c of children) stopGw(c);
  console.log(`# passed=${passed} failed=${failed} skipped=${skipped}${failures.length ? ' failures=' + failures.join(',') : ''}`);
  console.log(failed ? 'LOAD-82-TEST-FAILED' : 'LOAD-82-TEST-OK');
  process.exit(failed ? 1 : 0);
}
