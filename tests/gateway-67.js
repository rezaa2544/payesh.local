'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 67 — Gateway hardening (server/gateway.js), real processes + real PostgreSQL

   GW67-RID-*   request id: minted on every response, a well-formed caller id is
                echoed, malformed ones are replaced; JSON access log carries it and
                never the query string.
   GW67-RL-*    429 + Retry-After per device and per tenant (GW_TENANT_QUOTA_MAX);
                other devices/tenants unaffected; the reserved tenant bucket cannot
                be claimed through X-Device-Id.
   GW67-VER-*   version header policy: 426 upgrade_required + per-version kill-switch.
   GW67-KS-*    per-feature kill-switch: 503 feature_disabled + Retry-After before
                auth/DB, version-scoped entries, invalid entries visible in /healthz.
   GW67-DR-*    SIGTERM drain: in-flight push completes and is committed, new
                connections refused, /readyz 503 draining on a kept-alive socket,
                exit 0; drain timeout cuts a hung request and exits 2.
   GW67-LOAD-*  short load test (pull+push mix): baseline instance vs hardened
                instance; zero errors on both, unique request ids, latency budget.

   Env: PAYESH_PG_ADMIN, PAYESH_PG_RUNTIME (same as tests/native-contract-64.js).
        GW67_LOAD_OUT=<file>  writes the load-test summary as JSON (evidence).
   Run: node tests/gateway-67.js
   ═══════════════════════════════════════════════════════════════════ */
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
  console.log('BLOCKED — PAYESH_PG_ADMIN and PAYESH_PG_RUNTIME are required (CI provides PostgreSQL)');
  process.exit(3);
}
const tenancy = require(path.join(ROOT, 'server/tenancy.js'));
const SECRET = 'gw67-' + crypto.randomBytes(16).toString('hex');
const RUN = String(Date.now()).slice(-10);
const tid = (n) => '67676767-' + String(n).padStart(4, '0') + '-4000-8000-' + RUN.padStart(12, '0');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let PASS = 0, FAIL = 0;
const failures = [];
async function test(id, name, fn) {
  try { const d = await fn(); PASS++; console.log(`PASS  ${id}  ${name}${d ? '  → ' + d : ''}`); }
  catch (e) { FAIL++; failures.push(id); console.log(`FAIL  ${id}  ${name}  → ${String(e && e.message || e).replace(/\s+/g, ' ').slice(0, 400)}`); }
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const token = (t, did = 'dev-67') => tenancy.signToken({ tid: t, role: 'manager', uid: 1, did, iat: Date.now(), exp: Date.now() + 600000 }, SECRET);
const H = (t, did = 'dev-67', extra = {}) => Object.assign({ authorization: 'Bearer ' + token(t, did), 'x-device-id': did, 'content-type': 'application/json' }, extra);

const children = [];
async function startGw(name, env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server/gateway.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), HOST: '127.0.0.1', PGURL: RUNTIME, GW_SECRET: SECRET, GW_INSTANCE: 'gw67-' + name,
      GW_QUOTA_MAX: '100000', GW_QUOTA_WINDOW_SEC: '3600', PAYESH_LOG: '0',
      PAYESH_FEATURE_KILL: '', PAYESH_CLIENT_KILL: '', GW_TENANT_QUOTA_MAX: '',
    }, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.out = ''; child.err = '';
  child.stdout.on('data', d => { child.out += String(d); });
  child.stderr.on('data', d => { child.err += String(d); });
  child.exited = new Promise(r => child.on('exit', (code, sig) => { child.code = code; child.sig = sig; r(code); }));
  child.base = 'http://127.0.0.1:' + port;
  child.port = port;
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(child.base + '/healthz'); if (r.ok) break; } catch (e) { /* retry */ }
    if (Date.now() - t0 > 20000) throw new Error('gateway ' + name + ' did not start: ' + child.err.slice(0, 300));
    await sleep(100);
  }
  return child;
}
async function req(gw, p, opts = {}) {
  const r = await fetch(gw.base + p, {
    method: opts.method || 'GET', headers: opts.headers || {},
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  let data = null;
  try { data = await r.json(); } catch (e) { data = null; }
  return { status: r.status, headers: r.headers, data };
}
function logLines(gw) {
  return gw.out.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}
async function waitExit(gw, ms) {
  return Promise.race([gw.exited.then(() => true), sleep(ms).then(() => false)]);
}

/* raw HTTP/1.1 on one socket: lets the test hold a request open across SIGTERM */
function rawConn(port) {
  return new Promise((res, rej) => {
    const s = net.connect(port, '127.0.0.1', () => res(s));
    s.on('error', rej);
    s.buf = '';
    s.on('data', d => { s.buf += String(d); });
  });
}
async function waitFor(fn, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(50); }
  return null;
}

(async () => {
  const { Client } = require('pg');
  const admin = new Client({ connectionString: ADMIN });
  await admin.connect();
  await tenancy.migrate(admin);

  /* ── request id + access log ───────────────────────────────────────── */
  const g1 = await startGw('main');
  await test('GW67-RID-01', 'every response carries a minted X-Request-Id (200, 401, 404, 426)', async () => {
    const seen = new Set();
    const cases = [
      ['/healthz', {}, 200], ['/api/gw/v1/pull', {}, 401], ['/nope', { headers: H(tid(1)) }, 404],
      ['/api/gw/v1/pull', { headers: { 'x-payesh-client': 'payesh-native/0.0.1' } }, 426],
    ];
    for (const [p, o, want] of cases) {
      const r = await req(g1, p, o);
      assert.strictEqual(r.status, want, p);
      const id = r.headers.get('x-request-id');
      assert.ok(UUID_RE.test(String(id)), p + ' id=' + id);
      seen.add(id);
    }
    assert.strictEqual(seen.size, cases.length, 'ids are unique');
    return 'statuses 200/401/404/426, ' + seen.size + ' distinct uuids';
  });
  await test('GW67-RID-02', 'a well-formed caller id is echoed; malformed/oversized ones are replaced', async () => {
    const good = 'lb-' + crypto.randomBytes(8).toString('hex');
    const a = await req(g1, '/healthz', { headers: { 'x-request-id': good } });
    assert.strictEqual(a.headers.get('x-request-id'), good);
    for (const bad of ['short', 'has space inside it', 'x'.repeat(65), 'inj\u0000ect-12345', '<script>alert(1)</script>']) {
      let r;
      try { r = await req(g1, '/healthz', { headers: { 'x-request-id': bad } }); }
      catch (e) { continue; /* fetch itself refuses illegal header bytes — also a rejection */ }
      const id = r.headers.get('x-request-id');
      assert.notStrictEqual(id, bad);
      assert.ok(UUID_RE.test(String(id)), 'replaced by a uuid, got ' + id);
    }
    return 'echo=' + good;
  });
  await test('GW67-RID-03', 'JSON access log line per request with request_id/status/ms; no query string, no token', async () => {
    const rid = 'trace-' + crypto.randomBytes(6).toString('hex');
    await req(g1, '/metrics?token=SUPERSECRET67', { headers: { 'x-request-id': rid } });
    await req(g1, '/api/gw/v1/pull?since_seq=0', { headers: Object.assign(H(tid(1)), { 'x-request-id': rid + '-b' }) });
    await sleep(100);
    const lines = logLines(g1);
    const m = lines.find(l => l.event === 'http' && l.request_id === rid);
    assert.ok(m, 'metrics request logged');
    assert.strictEqual(m.path, '/metrics');
    assert.strictEqual(m.status, 200);
    assert.ok(typeof m.ms === 'number' && m.instance === 'gw67-main');
    const p = lines.find(l => l.request_id === rid + '-b');
    assert.ok(p && p.status === 200 && p.path === '/api/gw/v1/pull', JSON.stringify(p));
    assert.ok(!g1.out.includes('SUPERSECRET67'), 'query string leaked into the log');
    assert.ok(!g1.out.includes('Bearer '), 'authorization leaked into the log');
    return lines.filter(l => l.event === 'http').length + ' http log lines';
  });
  await test('GW67-RID-04', 'negative: GW_ACCESS_LOG=0 silences the access log but keeps the header', async () => {
    const q = await startGw('quiet', { GW_ACCESS_LOG: '0' });
    const r = await req(q, '/healthz');
    assert.ok(UUID_RE.test(String(r.headers.get('x-request-id'))));
    await sleep(100);
    assert.strictEqual(logLines(q).filter(l => l.event === 'http').length, 0);
    q.kill('SIGKILL');
  });

  /* ── 429 + Retry-After per device / per tenant ─────────────────────── */
  const gq = await startGw('quota', { GW_QUOTA_MAX: '3', GW_TENANT_QUOTA_MAX: '5', GW_QUOTA_WINDOW_SEC: '3600' });
  const TQ = tid(2), TQ2 = tid(3);
  await test('GW67-RL-01', 'device bucket: 3 × 200 then 429 rate_limited scope=device with Retry-After seconds', async () => {
    const st = [];
    let last;
    for (let i = 0; i < 4; i++) { last = await req(gq, '/api/gw/v1/pull', { headers: H(TQ, 'd1') }); st.push(last.status); }
    assert.deepStrictEqual(st, [200, 200, 200, 429]);
    assert.strictEqual(last.data.error, 'rate_limited');
    assert.strictEqual(last.data.scope, 'device');
    const ra = Number(last.headers.get('retry-after'));
    assert.ok(Number.isInteger(ra) && ra >= 1 && ra <= 3600, 'retry-after=' + last.headers.get('retry-after'));
    assert.strictEqual(ra, Math.max(1, Math.ceil(last.data.retry_after_ms / 1000)));
    assert.strictEqual(last.headers.get('x-ratelimit-remaining'), '0');
    assert.ok(last.headers.get('x-request-id'));
    return 'statuses ' + st.join(',') + ' retry-after=' + ra + 's';
  });
  await test('GW67-RL-02', 'tenant bucket: a 2nd device of the same tenant is cut at the tenant ceiling (5) with scope=tenant', async () => {
    const st = [];
    let last;
    for (let i = 0; i < 3; i++) { last = await req(gq, '/api/gw/v1/pull', { headers: H(TQ, 'd2') }); st.push(last.status); }
    assert.deepStrictEqual(st, [200, 200, 429], 'tenant had 3 hits from d1, so d2 gets 2');
    assert.strictEqual(last.data.scope, 'tenant');
    assert.ok(Number(last.headers.get('retry-after')) >= 1);
    return 'd2 statuses ' + st.join(',');
  });
  await test('GW67-RL-03', 'isolation: another tenant is unaffected; 200 responses carry no Retry-After', async () => {
    const r = await req(gq, '/api/gw/v1/pull', { headers: H(TQ2, 'd1') });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('retry-after'), null);
  });
  await test('GW67-RL-04', 'negative: X-Device-Id "__tenant__" cannot spend or read the reserved tenant bucket', async () => {
    const T = tid(4);
    for (let i = 0; i < 3; i++) assert.strictEqual((await req(gq, '/api/gw/v1/pull', { headers: H(T, '__tenant__') })).status, 200);
    const r = await req(gq, '/api/gw/v1/pull', { headers: H(T, '__tenant__') });
    assert.strictEqual(r.status, 429);
    assert.strictEqual(r.data.scope, 'device', 'cut by its own device bucket, not the tenant one');
    const q = await admin.query(`select device_id, hits from ${tenancy.QUOTA_TABLE} where tenant_id = $1 order by device_id`, [T]);
    const rows = Object.fromEntries(q.rows.map(x => [x.device_id, Number(x.hits)]));
    assert.deepStrictEqual(rows, { __tenant__: 3, x__tenant__: 4 });
    return JSON.stringify(rows);
  });
  gq.kill('SIGKILL');

  /* ── version header + per-version kill-switch (api-version.js) ─────── */
  const gv = await startGw('ver', { PAYESH_MIN_NATIVE_CLIENT: '0.2.0', PAYESH_CLIENT_KILL: '0.3.1' });
  await test('GW67-VER-01', 'X-Payesh-Client too old → 426 upgrade_required(client_too_old); killed version → client_disabled', async () => {
    const a = await req(gv, '/api/gw/v1/pull', { headers: H(tid(5), 'd', { 'x-payesh-client': 'payesh-native/0.1.9' }) });
    assert.strictEqual(a.status, 426); assert.strictEqual(a.data.reason, 'client_too_old');
    const b = await req(gv, '/api/gw/v1/pull', { headers: H(tid(5), 'd', { 'x-payesh-client': 'payesh-native/0.3.1' }) });
    assert.strictEqual(b.status, 426); assert.strictEqual(b.data.reason, 'client_disabled');
    assert.strictEqual(b.headers.get('x-payesh-api'), '1');
  });
  await test('GW67-VER-02', 'negative: supported versions and web callers pass', async () => {
    for (const h of [{ 'x-payesh-client': 'payesh-native/0.3.0' }, { 'x-payesh-client': 'payesh-native/0.3.2' }, {}]) {
      const r = await req(gv, '/api/gw/v1/pull', { headers: H(tid(5), 'd', h) });
      assert.strictEqual(r.status, 200, JSON.stringify(h));
    }
  });
  gv.kill('SIGKILL');

  /* ── per-feature kill-switch ───────────────────────────────────────── */
  const gk = await startGw('kill', { PAYESH_FEATURE_KILL: 'push, pull@<0.2.0, directory, bogus, push@x', PAYESH_FEATURE_KILL_RETRY_SEC: '120' });
  await test('GW67-KS-01', 'killed feature → 503 feature_disabled + Retry-After, before auth (no token still 503)', async () => {
    const a = await req(gk, '/api/gw/v1/push', { method: 'POST', headers: H(tid(6)), body: { ops: [] } });
    assert.strictEqual(a.status, 503); assert.strictEqual(a.data.error, 'feature_disabled'); assert.strictEqual(a.data.feature, 'push');
    assert.strictEqual(a.headers.get('retry-after'), '120');
    const b = await req(gk, '/api/gw/v1/push', { method: 'POST', body: { ops: [] } });
    assert.strictEqual(b.status, 503, 'kill-switch answers before authentication');
    const d = await req(gk, '/api/dir/v1/resolve?school_code=x');
    assert.strictEqual(d.status, 503); assert.strictEqual(d.data.feature, 'directory');
  });
  await test('GW67-KS-02', 'version-scoped entry pull@<0.2.0 binds only older native clients', async () => {
    const old = await req(gk, '/api/gw/v1/pull', { headers: H(tid(6), 'd', { 'x-payesh-client': 'payesh-native/0.1.5' }) });
    assert.strictEqual(old.status, 503); assert.strictEqual(old.data.feature, 'pull');
    const cur = await req(gk, '/api/gw/v1/pull', { headers: H(tid(6), 'd', { 'x-payesh-client': 'payesh-native/0.2.0' }) });
    assert.strictEqual(cur.status, 200);
    const web = await req(gk, '/api/gw/v1/pull', { headers: H(tid(6)) });
    assert.strictEqual(web.status, 200, 'web callers are not bound by a version-scoped entry');
  });
  await test('GW67-KS-03', '/healthz lists active switches and the invalid entries (typos are visible)', async () => {
    const h = await req(gk, '/healthz');
    assert.deepStrictEqual(h.data.kill_switch, { features: ['push', 'pull@<0.2.0', 'directory'], invalid: ['bogus', 'push@x'] });
    assert.strictEqual(h.data.draining, false);
  });
  await test('GW67-KS-04', 'negative: without PAYESH_FEATURE_KILL the same push is applied', async () => {
    const r = await req(g1, '/api/gw/v1/push', { method: 'POST', headers: H(tid(6)), body: { ops: [{ uid: 'ks-1', collection: 'homework', id: 1, type: 'put', data: { title: 'k' } }] } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.counts.applied, 1);
  });
  gk.kill('SIGKILL');

  /* ── SIGTERM drain ─────────────────────────────────────────────────── */
  await test('GW67-DR-01', 'SIGTERM: in-flight push completes + commits, new conns refused, response has connection: close, exit 0', async () => {
    const gd = await startGw('drain', { GW_DRAIN_TIMEOUT_MS: '8000' });
    const T = tid(7);
    const body = JSON.stringify({ ops: [{ uid: 'dr-1', collection: 'homework', id: 7, type: 'put', data: { title: 'drain' } }] });
    const hdr = H(T, 'd-drain');
    const head = `POST /api/gw/v1/push HTTP/1.1\r\nHost: x\r\nAuthorization: ${hdr.authorization}\r\nX-Device-Id: d-drain\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nX-Request-Id: drain-inflight-1\r\n\r\n`;
    const inflight = await rawConn(gd.port);
    inflight.write(head + body.slice(0, 10));                      /* request is now in flight */
    const keep = await rawConn(gd.port);                           /* an idle kept-alive socket with one finished request */
    keep.write('GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n');
    assert.ok(await waitFor(() => keep.buf.includes('"ok":true')), 'keep-alive warm-up');
    await sleep(150);
    gd.kill('SIGTERM');
    await sleep(300);
    assert.ok(gd.exitCode === null, 'must not exit while a request is in flight');
    let refused = false;
    try { await fetch(gd.base + '/healthz'); } catch (e) { refused = true; }
    assert.ok(refused, 'new connections must be refused after SIGTERM');
    inflight.write(body.slice(10));
    const resp = await waitFor(() => /\r\n\r\n[\s\S]*\}/.test(inflight.buf) && inflight.buf, 6000);
    assert.ok(resp, 'in-flight response arrived: ' + inflight.buf.slice(0, 200));
    assert.ok(/^HTTP\/1\.1 200/.test(resp), resp.slice(0, 120));
    assert.ok(/connection: close/i.test(resp), 'draining responses close the socket');
    assert.ok(/x-request-id: drain-inflight-1/i.test(resp));
    assert.ok(/"applied":1/.test(resp), resp.slice(-200));
    const exited = await waitExit(gd, 6000);
    assert.ok(exited, 'process exited after drain');
    assert.strictEqual(gd.code, 0, 'clean drain exits 0, got ' + gd.code + ' ' + gd.err.slice(0, 200));
    const ev = logLines(gd).map(l => l.event);
    assert.ok(ev.includes('drain_start') && ev.includes('drain_done'), ev.join(','));
    assert.strictEqual(logLines(gd).find(l => l.event === 'drain_done').reason, 'drained');
    const c = await admin.query(`select count(*)::int as n from ${tenancy.OPS_TABLE} where tenant_id = $1`, [T]);
    assert.strictEqual(c.rows[0].n, 1, 'the in-flight write is committed');
    inflight.destroy(); keep.destroy();
    return 'exit=0, ops committed=1, events=' + ev.filter(e => e.startsWith('drain')).join('>');
  });
  await test('GW67-DR-02', 'kept-alive socket during drain is closed or answered 503 draining + Retry-After — never served normally', async () => {
    const gd = await startGw('drain2', { GW_DRAIN_TIMEOUT_MS: '4000' });
    const hold = await rawConn(gd.port);
    hold.write('POST /api/gw/v1/push HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 50\r\n\r\n{');
    const keep = await rawConn(gd.port);
    keep.write('GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n');
    assert.ok(await waitFor(() => keep.buf.includes('"ok":true')));
    keep.buf = '';
    /* request 2 on the same socket is written right before SIGTERM is processed */
    gd.kill('SIGTERM');
    await sleep(200);
    keep.write('GET /readyz HTTP/1.1\r\nHost: x\r\n\r\n');
    const r = await waitFor(() => keep.buf || (keep.destroyed && 'closed'), 3000);
    /* either Node already closed the idle socket (closeIdleConnections) or it answered 503 draining */
    if (r !== 'closed' && r) {
      assert.ok(/^HTTP\/1\.1 503/.test(r), r.slice(0, 80));
      assert.ok(/draining/.test(r));
      assert.ok(/retry-after: 1/i.test(r));
    }
    hold.destroy();
    assert.ok(await waitExit(gd, 6000), 'exits once the held socket is gone');
    keep.destroy();
    return r === 'closed' ? 'idle socket closed by drain' : '503 draining';
  });
  await test('GW67-DR-03', 'negative: a hung request beyond GW_DRAIN_TIMEOUT_MS is cut and the process exits 2', async () => {
    const gd = await startGw('drain3', { GW_DRAIN_TIMEOUT_MS: '800' });
    const hung = await rawConn(gd.port);
    hung.write('POST /api/gw/v1/push HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 999\r\n\r\n{"ops":');
    await sleep(150);
    const t0 = Date.now();
    gd.kill('SIGTERM');
    const exited = await waitExit(gd, 5000);
    const dt = Date.now() - t0;
    assert.ok(exited, 'process must not hang forever');
    assert.strictEqual(gd.code, 2, 'forced drain exits 2, got ' + gd.code);
    assert.ok(dt >= 700 && dt < 4500, 'stopped after the timeout, dt=' + dt);
    assert.ok(logLines(gd).some(l => l.event === 'drain_timeout'));
    hung.destroy();
    return 'exit=2 after ' + dt + 'ms';
  });

  /* ── short load test: baseline vs hardened ─────────────────────────── */
  async function load(gw, label, { total = 1200, conc = 24 } = {}) {
    const T = tid(label === 'baseline' ? 8 : 9);
    let i = 0, errors = 0;
    const lat = [], ids = new Set(), statuses = {};
    const t0 = Date.now();
    async function worker(w) {
      for (;;) {
        const n = i++;
        if (n >= total) return;
        const did = 'ld-' + (w % 6);
        const t = process.hrtime.bigint();
        let r;
        try {
          r = n % 4 === 0
            ? await req(gw, '/api/gw/v1/push', { method: 'POST', headers: H(T, did), body: { ops: [{ uid: label + '-' + n, collection: 'homework', id: n + 1, type: 'put', data: { title: 'l' + n } }] } })
            : await req(gw, '/api/gw/v1/pull?since_seq=0&limit=20', { headers: H(T, did) });
        } catch (e) { errors++; statuses.net = (statuses.net || 0) + 1; continue; }
        lat.push(Number(process.hrtime.bigint() - t) / 1e6);
        statuses[r.status] = (statuses[r.status] || 0) + 1;
        if (r.status !== 200) errors++;
        const id = r.headers.get('x-request-id');
        if (id) ids.add(id);
      }
    }
    await Promise.all(Array.from({ length: conc }, (_, w) => worker(w)));
    lat.sort((a, b) => a - b);
    const q = (p) => Math.round(lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] * 10) / 10;
    return { label, total, concurrency: conc, errors, statuses, p50_ms: q(0.5), p95_ms: q(0.95), p99_ms: q(0.99),
      rps: Math.round(total / ((Date.now() - t0) / 1000)), unique_request_ids: ids.size };
  }
  await test('GW67-LOAD-01', 'short load: hardened gateway has no error increase vs baseline; every response has a unique request id', async () => {
    const base = await startGw('load-base', { GW_ACCESS_LOG: '0' });
    const hard = await startGw('load-hard', { GW_ACCESS_LOG: '1', GW_TENANT_QUOTA_MAX: '100000', PAYESH_FEATURE_KILL: 'platform', GW_DRAIN_TIMEOUT_MS: '25000' });
    await load(base, 'warm', { total: 100, conc: 8 });
    const b = await load(base, 'baseline');
    const h = await load(hard, 'hardened');
    const out = { row: 67, date_utc: new Date().toISOString(), node: process.version, baseline: b, hardened: h,
      verdict: { error_increase: h.errors - b.errors, p95_ratio: Math.round((h.p95_ms / Math.max(1, b.p95_ms)) * 100) / 100 } };
    if (process.env.GW67_LOAD_OUT) fs.writeFileSync(process.env.GW67_LOAD_OUT, JSON.stringify(out, null, 2) + '\n');
    console.log('      load ' + JSON.stringify(out.verdict) + ' base=' + JSON.stringify(b) + ' hard=' + JSON.stringify(h));
    assert.strictEqual(b.errors, 0, 'baseline errors');
    assert.strictEqual(h.errors, 0, 'hardened errors');
    assert.strictEqual(h.unique_request_ids, h.total, 'one unique id per response');
    assert.ok(h.p95_ms <= b.p95_ms * 2.5 + 50, `p95 budget: hardened ${h.p95_ms}ms vs baseline ${b.p95_ms}ms`);
    const logged = logLines(hard).filter(l => l.event === 'http' && l.path.startsWith('/api/gw/v1/')).length;
    assert.strictEqual(logged, h.total, 'one access-log line per request');
    base.kill('SIGKILL'); hard.kill('SIGKILL');
    return `errors ${b.errors}→${h.errors}, p95 ${b.p95_ms}→${h.p95_ms}ms, rps ${b.rps}→${h.rps}`;
  });

  for (const c of children) { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } }
  await admin.end();
  console.log(`\n${FAIL ? 'GATEWAY-67-FAIL' : 'GATEWAY-67-OK'} pass=${PASS} fail=${FAIL}${failures.length ? ' failed=' + failures.join(',') : ''}`);
  process.exit(FAIL ? 1 : 0);
})().catch((e) => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch (er) { /* gone */ } }
  console.log('GATEWAY-67-FAIL crashed: ' + (e && e.stack || e));
  process.exit(1);
});
