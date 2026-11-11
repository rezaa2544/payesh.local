'use strict';
/* Row 119 — server/Node half of the offline proof (the native half, 20 scenarios on the default
   data path, is apps/payesh/packages/payesh_sync/test/offline_119_test.dart).
   Real server/gateway.js + real PostgreSQL, with a TCP fault proxy between them:
     OFF119-G01  PostgreSQL drops every connection → the Gateway process SURVIVES (before row 119
                 an unhandled pg.Pool 'error' event killed it: all schools offline).
                 Negative control: the same Gateway with the pool 'error' handler stripped (preload
                 mutant) dies on the same fault → the test would go red if the fix is reverted.
     OFF119-G02  DB refused → /readyz 503 db_unavailable, push answers a 5xx (no crash, no partial
                 write); DB back → /readyz 200 without restarting the Gateway.
     OFF119-G03  web outbox (client/outbox-web.js) through the real Gateway during the outage:
                 8 transient failures > maxAttempts → never blocked, nothing lost; after recovery
                 exactly once (server feed), retry of the same uid → duplicate verdict.
                 Negative control: the same failures recorded as non-transient → blocked.
     OFF119-G04  FIFO barrier on the web outbox against the real Gateway: a later op does not
                 overtake an earlier op that is in backoff; server seq order = enqueue order.
     OFF119-G05  cross-school: tenant B pulls 0 rows of tenant A's run.
   Run: PAYESH_PG_ADMIN=… PAYESH_PG_RUNTIME=… node tests/offline-119.js   (CI: api-contract)
   OFF119_REQUIRE_PG=1 turns "no PostgreSQL" into a failure. */
require('fake-indexeddb/auto');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = process.env.PAYESH_PG_ADMIN || '';
const RUNTIME = process.env.PAYESH_PG_RUNTIME || '';
if (!ADMIN || !RUNTIME) {
  if (process.env.OFF119_REQUIRE_PG === '1') { console.log('FAIL  PAYESH_PG_ADMIN/RUNTIME required (OFF119_REQUIRE_PG=1)'); process.exit(1); }
  console.log('BLOCKED — PAYESH_PG_ADMIN and PAYESH_PG_RUNTIME are required (CI provides PostgreSQL)');
  process.exit(3);
}
const tenancy = require(path.join(ROOT, 'server/tenancy.js'));
const outbox = require(path.join(ROOT, 'client/outbox-web.js'));
const { Client } = require('pg');
const SECRET = 'off119-' + crypto.randomBytes(16).toString('hex');
const A = crypto.randomUUID();
const B = crypto.randomUUID();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let PASS = 0, FAIL = 0, NEG = 0;
async function test(id, name, fn) {
  try { const d = await fn(); PASS++; console.log(`PASS  ${id}  ${name}${d ? '  → ' + d : ''}`); }
  catch (e) { FAIL++; console.log(`FAIL  ${id}  ${name}  → ${String((e && e.stack) || e).replace(/\s+/g, ' ').slice(0, 500)}`); }
}
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/* TCP fault proxy Gateway ⇄ PostgreSQL: pass | refuse; killAll() drops live connections. */
function pgProxy(upPort) {
  const live = new Set();
  const p = { mode: 'pass', port: 0 };
  const srv = net.createServer((c) => {
    if (p.mode === 'refuse') { c.destroy(); return; }
    const u = net.connect(upPort, '127.0.0.1');
    live.add(c); live.add(u);
    const drop = () => { c.destroy(); u.destroy(); live.delete(c); live.delete(u); };
    c.on('error', drop); u.on('error', drop); c.on('close', drop); u.on('close', drop);
    c.pipe(u); u.pipe(c);
  });
  p.killAll = () => { for (const s of live) s.destroy(); live.clear(); };
  p.close = () => new Promise(r => { p.killAll(); srv.close(() => r()); });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => { p.port = srv.address().port; r(p); }));
}

const children = [];
async function startGw(name, pgUrl, extraEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server/gateway.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), HOST: '127.0.0.1', PGURL: pgUrl, GW_SECRET: SECRET, GW_INSTANCE: 'off119-' + name,
      GW_QUOTA_MAX: '100000', GW_QUOTA_WINDOW_SEC: '3600', PAYESH_LOG: '0',
      PAYESH_FEATURE_KILL: '', PAYESH_CLIENT_KILL: '', GW_TENANT_QUOTA_MAX: '',
    }, extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.err = '';
  child.stderr.on('data', d => { child.err += String(d); });
  child.stdout.on('data', () => {});
  child.dead = false;
  child.exited = new Promise(r => child.on('exit', (code, sig) => { child.dead = true; child.code = code; child.sig = sig; r(code); }));
  child.base = 'http://127.0.0.1:' + port;
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(child.base + '/readyz'); if (r.ok) break; } catch (e) { /* not up */ }
    if (child.dead || Date.now() - t0 > 20000) throw new Error('gateway ' + name + ' did not start: ' + child.err.slice(0, 300));
    await sleep(100);
  }
  return child;
}
const tok = (tid, did) => tenancy.signToken({ tid, role: 'manager', uid: 1, did, iat: Date.now(), exp: Date.now() + 600000 }, SECRET);
async function call(gw, p, tid, did, body) {
  const r = await fetch(gw.base + p, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: 'Bearer ' + tok(tid, did), 'x-device-id': did, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch (e) { data = null; }
  return { status: r.status, data };
}
/* outbox-web `send`: any non-2xx or network error throws (the drain records it as transient) */
const sender = (gw, tid, did) => async (ops) => {
  const r = await call(gw, '/api/gw/v1/push', tid, did, {
    ops: ops.map(o => ({ uid: o.uid || o.k, collection: o.collection, id: o.id, type: o.type || 'put', data: o.data, base_version: o.base_version || 0 })),
  });
  if (r.status !== 200) { const e = new Error('http_' + r.status + ':' + ((r.data && r.data.error) || '')); e.status = r.status; throw e; }
  return r.data;
};
async function feed(gw, tid) {
  const rows = [];
  let since = 0;
  for (;;) {
    const r = await call(gw, '/api/gw/v1/pull?limit=500&since_seq=' + since, tid, 'audit');
    assert.strictEqual(r.status, 200, 'pull ' + JSON.stringify(r.data));
    rows.push(...r.data.rows);
    if (!r.data.more) break;
    since = r.data.next_seq;
  }
  return rows;
}
async function waitReady(gw, want, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    const r = await fetch(gw.base + '/readyz').catch(() => null);
    if (r && r.status === want) return r;
    if (Date.now() - t0 > ms) throw new Error('readyz never ' + want);
    await sleep(100);
  }
}

(async () => {
  const admin = new Client({ connectionString: ADMIN });
  await admin.connect();
  await tenancy.migrate(admin);
  await admin.end();
  const rt = new URL(RUNTIME);
  const upPort = Number(rt.port || 5432);
  const proxy = await pgProxy(upPort);
  const viaProxy = new URL(RUNTIME); viaProxy.port = String(proxy.port);
  const gw = await startGw('main', viaProxy.toString());

  await test('OFF119-G01', 'PostgreSQL drops all connections → Gateway survives; mutant without pool error handler dies', async () => {
    assert.strictEqual((await call(gw, '/api/gw/v1/push', A, 'd1', { ops: [{ uid: 'g01-warm', collection: 'announcements', id: 119001, type: 'put', data: { title: 'warm' }, base_version: 0 }] })).status, 200);
    proxy.killAll(); // idle pooled connections die under the Gateway
    await sleep(600);
    assert.strictEqual(gw.dead, false, 'gateway crashed: ' + gw.err.slice(0, 300));
    const r = await fetch(gw.base + '/healthz');
    assert.strictEqual(r.status, 200);
    /* negative control: identical Gateway, but every pg.Pool 'error' listener is stripped
       (= the row-119 fix reverted) → the same fault kills the process */
    const pre = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'off119-')), 'strip-pool-error.cjs');
    fs.writeFileSync(pre, `const pg=require(${JSON.stringify(require.resolve('pg'))});const on=pg.Pool.prototype.on;pg.Pool.prototype.on=function(ev,fn){return ev==='error'?this:on.call(this,ev,fn);};\n`);
    const mut = await startGw('mutant', viaProxy.toString(), { NODE_OPTIONS: '--require ' + pre });
    assert.strictEqual((await call(mut, '/api/gw/v1/push', A, 'd1', { ops: [{ uid: 'g01-mut', collection: 'announcements', id: 119002, type: 'put', data: { title: 'm' }, base_version: 0 }] })).status, 200);
    proxy.killAll();
    await Promise.race([mut.exited, sleep(3000)]);
    assert.strictEqual(mut.dead, true, 'mutant should have crashed — negative control did not discriminate');
    NEG++;
    return `survived=yes mutant_exit=${mut.code}${mut.sig ? '/' + mut.sig : ''}`;
  });

  let ob;
  await test('OFF119-G02', 'DB refused → readyz 503 + push 5xx (no crash); DB back → readyz 200 without restart', async () => {
    proxy.mode = 'refuse'; proxy.killAll();
    const r = await waitReady(gw, 503);
    const body = await r.json().catch(() => ({}));
    const p = await call(gw, '/api/gw/v1/push', A, 'd1', { ops: [{ uid: 'g02-x', collection: 'announcements', id: 119003, type: 'put', data: { title: 'x' }, base_version: 0 }] });
    assert.ok(p.status >= 500, 'push during outage = ' + p.status);
    assert.strictEqual(gw.dead, false);
    return `readyz=503 ${body.error || ''} push=${p.status}/${(p.data && p.data.error) || ''}`;
  });

  await test('OFF119-G03', 'web outbox through real Gateway: 8 transient failures never block; recovery → exactly once; retry → duplicate', async () => {
    ob = await outbox.open('off119-g03-' + Date.now(), { maxAttempts: 3, baseBackoffMs: 100, maxBackoffMs: 400, jitter: 0 });
    const ids = [119101, 119102, 119103];
    for (const id of ids) await ob.enqueue({ k: 'g03-' + id + '-' + A.slice(0, 8), collection: 'announcements', id, type: 'put', data: { title: 'g03 ' + id } });
    const send = sender(gw, A, 'd-web');
    let t = Date.now();
    for (let i = 0; i < 8; i++) { const r = await ob.drain({ send, now: t }); assert.strictEqual(r.stopped, 'network'); t += 10000; }
    const st = await ob.list();
    assert.strictEqual(st.filter(o => o.state === 'blocked').length, 0, 'transient failures blocked the queue');
    assert.strictEqual(st.length, 3);
    assert.ok(st[0].attempts >= 8);
    /* negative control: the same failures as NON-transient → blocked after maxAttempts */
    const neg = await outbox.open('off119-g03neg-' + Date.now(), { maxAttempts: 3, baseBackoffMs: 100, jitter: 0 });
    await neg.enqueue({ k: 'neg-1', collection: 'announcements', id: 1, type: 'put', data: {} });
    let f; for (let i = 0; i < 3; i++) f = await neg.fail('neg-1', { error: 'http_503', now: Date.now() + i * 10000, transient: false });
    assert.strictEqual(f.state, 'blocked', 'negative control did not block');
    NEG++;
    proxy.mode = 'pass';
    await waitReady(gw, 200);
    let applied = 0;
    for (let i = 0; i < 20 && applied < 3; i++) { const r = await ob.drain({ send, now: t + i * 10000 }); applied += r.applied; if (applied < 3) await sleep(150); }
    assert.strictEqual(applied, 3);
    const rows = (await feed(gw, A)).filter(r => ids.includes(Number(r.id)));
    assert.deepStrictEqual(rows.map(r => Number(r.id)).sort(), ids, 'exactly once (append-only feed)');
    const again = await sender(gw, A, 'd-web')([{ k: 'g03-119101-' + A.slice(0, 8), collection: 'announcements', id: 119101, type: 'put', data: { title: 'g03 119101' } }]);
    assert.strictEqual((again.duplicates || again.applied.filter(a => a.duplicate)).length, 1, 'retry is a duplicate: ' + JSON.stringify(again));
    assert.strictEqual((await feed(gw, A)).filter(r => Number(r.id) === 119101).length, 1);
    return `attempts=${st[0].attempts}>maxAttempts blocked=0 applied=3 feed_rows=3 retry=duplicate`;
  });

  await test('OFF119-G04', 'FIFO barrier against the real Gateway: later op waits for the earlier op in backoff', async () => {
    const q = await outbox.open('off119-g04-' + Date.now(), { baseBackoffMs: 1000, maxBackoffMs: 4000, jitter: 0 });
    const t = Date.now();
    await q.enqueue({ k: 'g04-c-' + A.slice(0, 8), collection: 'classes', id: 119201, type: 'put', data: { name: 'دهم ب' } });
    const down = async () => { throw new Error('offline'); };
    await q.drain({ send: down, now: t });
    await q.enqueue({ k: 'g04-s-' + A.slice(0, 8), collection: 'announcements', id: 119202, type: 'put', data: { title: 'برنامه', class_id: 119201 } });
    const early = await q.drain({ send: sender(gw, A, 'd-web'), now: t + 100 });
    assert.strictEqual(early.claimed, 0, 'dependent op overtook the earlier op');
    const r = await q.drain({ send: sender(gw, A, 'd-web'), now: t + 1100 });
    assert.strictEqual(r.applied, 2);
    const rows = await feed(gw, A);
    const a = rows.find(x => Number(x.id) === 119201), b = rows.find(x => Number(x.id) === 119202);
    assert.ok(Number(a.seq) < Number(b.seq), 'server order');
    return `early_claimed=0 seq ${a.seq} < ${b.seq}`;
  });

  await test('OFF119-G05', 'cross-school: tenant B sees 0 rows of tenant A', async () => {
    const aRows = await feed(gw, A);
    const bRows = await feed(gw, B);
    assert.ok(aRows.length >= 5);
    assert.strictEqual(bRows.length, 0);
    return `a_rows=${aRows.length} b_rows=0`;
  });

  for (const c of children) if (!c.dead) c.kill('SIGKILL');
  await proxy.close();
  console.log(`OFFLINE-119-NODE passed=${PASS} failed=${FAIL} negative_controls=${NEG}`);
  if (FAIL === 0 && NEG === 2) console.log('OFFLINE-119-NODE-OK');
  process.exit(FAIL === 0 && NEG === 2 ? 0 : 1);
})().catch((e) => { console.log('FAIL  harness  ' + ((e && e.stack) || e)); for (const c of children) c.kill('SIGKILL'); process.exit(1); });
