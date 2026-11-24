'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 178 — change notifications through the Gateway (server/gw-events.js)

   GE-U-*   unit (no database): real HTTP server + fake probe/listen.
            hello/missed, coalescing, topic filter, duplicate seq ignored, fallback poll,
            zero probes with no stream, LISTEN only while a stream is open, 503 cap,
            closeAll for drain, payload parser rejects junk.
   GE-PG-*  real PostgreSQL + two real Gateway processes (only when PAYESH_PG_ADMIN /
            PAYESH_PG_RUNTIME are set — CI api-contract provides them):
            push on instance B ⇒ SSE `change` on instance A (pg_notify after commit),
            tenant isolation, rejected (rolled-back) push sends nothing, 401 without token.

   Run: node tests/gw-events-178.js
   ═══════════════════════════════════════════════════════════════════ */
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..');
const gwEvents = require(path.join(ROOT, 'server/gw-events.js'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let PASS = 0, FAIL = 0;
const failures = [];
async function test(id, name, fn) {
  try { const d = await fn(); PASS++; console.log(`PASS  ${id}  ${name}${d ? '  → ' + d : ''}`); }
  catch (e) { FAIL++; failures.push(id); console.log(`FAIL  ${id}  ${name}  → ${String(e && e.message || e).replace(/\s+/g, ' ').slice(0, 400)}`); }
}

/* minimal SSE reader over node:http (fetch cannot easily stream in node 20 without extras) */
function sse(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.get(url, { headers: Object.assign({ accept: 'text/event-stream' }, headers) }, (res) => {
      const s = { status: res.statusCode, headers: res.headers, events: [], raw: '', res, req: r };
      res.setEncoding('utf8');
      res.on('data', (d) => {
        s.raw += d;
        let i;
        while ((i = s.raw.indexOf('\n\n')) >= 0) {
          const block = s.raw.slice(0, i); s.raw = s.raw.slice(i + 2);
          let ev = 'message', data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) ev = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
            else if (line === ':') ev = 'heartbeat';
          }
          if (ev === 'heartbeat') { s.events.push({ ev }); continue; }
          if (!data) continue;
          try { s.events.push(Object.assign({ ev }, JSON.parse(data))); } catch (e) { /* skip */ }
        }
      });
      s.ended = new Promise(r2 => res.on('close', r2));
      s.close = () => { try { r.destroy(); } catch (e) { /* noop */ } };
      resolve(s);
    });
    r.on('error', reject);
  });
}
async function waitFor(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(10); }
  return null;
}
const of = (s, ev) => s.events.filter(e => e.ev === ev);

function harness(opts = {}) {
  const calls = { probe: 0, listen: 0, closed: 0 };
  const seqs = new Map();
  let push = null, lost = null;
  const hub = gwEvents.create(Object.assign({
    probe: async (tid) => { calls.probe++; return seqs.get(tid) || 0; },
    listen: opts.noListen ? null : async (onPayload, onLost) => {
      calls.listen++;
      if (opts.listenFails) throw new Error('down');
      push = onPayload; lost = onLost;
      return { close: () => { calls.closed++; push = null; } };
    },
    pollMs: 60_000, fallbackPollMs: opts.fallbackPollMs || 60_000, heartbeatMs: opts.heartbeatMs || 60_000,
    coalesceMs: 40, maxStreams: opts.maxStreams || 50, maxPerTenant: opts.maxPerTenant || 50, relistenMs: 60_000,
  }, opts.extra || {}));
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hub.open(req, res, { tenantId: u.searchParams.get('t'), since: u.searchParams.get('since'), topics: u.searchParams.get('topics') });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => {
    const base = 'http://127.0.0.1:' + srv.address().port;
    r({ hub, srv, base, calls, seqs, notifyPg: (p) => push && push(JSON.stringify(p)), lose: () => lost && lost(),
      stop: () => new Promise(r2 => { hub.closeAll(); srv.closeAllConnections(); srv.close(r2); }) });
  }));
}

async function unit() {
  await test('GE-U-01', 'hello carries the tenant seq; missed only when since differs; SSE headers (no buffering)', async () => {
    const h = await harness();
    h.seqs.set('A', 7);
    const a = await sse(h.base + '/?t=A&since=7');
    const b = await sse(h.base + '/?t=A&since=3');
    const c = await sse(h.base + '/?t=A');
    await waitFor(() => of(a, 'hello').length && of(b, 'hello').length && of(c, 'hello').length);
    assert.strictEqual(a.status, 200);
    assert.match(String(a.headers['content-type']), /text\/event-stream/);
    assert.strictEqual(a.headers['x-accel-buffering'], 'no');
    assert.match(String(a.headers['cache-control']), /no-transform/);
    assert.deepStrictEqual([of(a, 'hello')[0].seq, of(a, 'hello')[0].missed], [7, false]);
    assert.strictEqual(of(b, 'hello')[0].missed, true);
    assert.strictEqual(of(c, 'hello')[0].missed, false, 'no since ⇒ not missed');
    assert.strictEqual(h.calls.probe, 1, 'one probe for the tenant, shared by later streams');
    [a, b, c].forEach(s => s.close()); await h.stop();
    return 'probes=' + h.calls.probe;
  });

  await test('GE-U-02', 'NOTIFY ⇒ one coalesced change per burst, topics merged, duplicate/old seq ignored', async () => {
    const h = await harness();
    const a = await sse(h.base + '/?t=A&since=0');
    await waitFor(() => of(a, 'hello').length);
    await waitFor(() => h.calls.listen === 1);
    h.notifyPg({ t: 'A', s: 5, c: ['homework'] });
    h.notifyPg({ t: 'A', s: 6, c: ['attendance'] });
    h.notifyPg({ t: 'A', s: 6, c: ['grades'] });          /* same seq ⇒ dropped */
    await waitFor(() => of(a, 'change').length);
    await sleep(120);
    const ch = of(a, 'change');
    assert.strictEqual(ch.length, 1, 'coalesced: ' + JSON.stringify(ch));
    assert.strictEqual(ch[0].seq, 6);
    assert.deepStrictEqual(ch[0].topics.sort(), ['attendance', 'homework']);
    h.notifyPg({ t: 'A', s: 4, c: ['x_old'] });            /* older ⇒ dropped */
    await sleep(100);
    assert.strictEqual(of(a, 'change').length, 1);
    a.close(); await h.stop();
    return 'seq=6 topics=' + ch[0].topics.join(',');
  });

  await test('GE-U-03', 'tenant isolation and topic filter: other tenants and unrelated topics get nothing', async () => {
    const h = await harness();
    const a = await sse(h.base + '/?t=A&topics=homework');
    const all = await sse(h.base + '/?t=A');
    const b = await sse(h.base + '/?t=B');
    await waitFor(() => of(a, 'hello').length && of(b, 'hello').length && of(all, 'hello').length);
    await waitFor(() => h.calls.listen === 1);
    h.notifyPg({ t: 'A', s: 1, c: ['grades'] });
    await waitFor(() => of(all, 'change').length);
    await sleep(80);
    assert.strictEqual(of(a, 'change').length, 0, 'filtered topic');
    assert.strictEqual(of(b, 'change').length, 0, 'other tenant');
    h.notifyPg({ t: 'A', s: 2, c: ['homework', 'grades'] });
    await waitFor(() => of(a, 'change').length);
    assert.deepStrictEqual(of(a, 'change')[0].topics, ['homework']);
    h.notifyPg({ t: 'Z', s: 9, c: ['homework'] });          /* tenant without streams here ⇒ ignored */
    await sleep(80);
    assert.strictEqual(of(b, 'change').length, 0);
    [a, all, b].forEach(s => s.close()); await h.stop();
    return 'ok';
  });

  await test('GE-U-04', 'no stream ⇒ zero DB work; LISTEN opens with the first stream and closes after the last', async () => {
    const h = await harness();
    await sleep(100);
    assert.deepStrictEqual([h.calls.probe, h.calls.listen], [0, 0], 'idle instance touches nothing');
    const a = await sse(h.base + '/?t=A');
    const b = await sse(h.base + '/?t=B');
    await waitFor(() => of(a, 'hello').length && of(b, 'hello').length);
    await waitFor(() => h.calls.listen === 1);
    assert.strictEqual(h.calls.listen, 1, 'one LISTEN connection per instance');
    a.close(); await sleep(50);
    assert.strictEqual(h.calls.closed, 0, 'still one stream open');
    b.close();
    await waitFor(() => h.calls.closed === 1);
    assert.strictEqual(h.calls.closed, 1);
    assert.deepStrictEqual([h.hub.status().streams, h.hub.status().tenants], [0, 0]);
    await h.stop();
    return 'listen=1 closed=1';
  });

  await test('GE-U-05', 'fallback when LISTEN is down: periodic max(seq) probe still delivers the change', async () => {
    const h = await harness({ listenFails: true, fallbackPollMs: 120 });
    const a = await sse(h.base + '/?t=A');
    await waitFor(() => of(a, 'hello').length);
    h.seqs.set('A', 3);
    const got = await waitFor(() => of(a, 'change').length, 2000);
    assert.ok(got, 'change via poll');
    assert.deepStrictEqual([of(a, 'change')[0].seq, of(a, 'change')[0].topics], [3, []]);
    assert.strictEqual(h.hub.status().listening, false);
    const before = h.calls.probe;
    a.close(); await sleep(400);
    assert.strictEqual(h.calls.probe, before, 'poll stops with the last stream');
    await h.stop();
    return 'probes=' + before;
  });

  await test('GE-U-06', 'heartbeat comment keeps the stream warm; 503 over the cap; closeAll ends streams (drain)', async () => {
    const h = await harness({ heartbeatMs: 60, maxPerTenant: 2 });
    const a = await sse(h.base + '/?t=A');
    const b = await sse(h.base + '/?t=A');
    const c = await sse(h.base + '/?t=A');
    assert.strictEqual(c.status, 503);
    const hb = await waitFor(() => a.events.some(e => e.ev === 'heartbeat'), 1000);
    assert.ok(hb, 'heartbeat seen');
    h.hub.closeAll();
    await Promise.race([Promise.all([a.ended, b.ended]), sleep(1000)]);
    assert.strictEqual(h.hub.status().streams, 0);
    assert.strictEqual(h.hub.status().rejected, 1);
    await h.stop();
    return 'rejected=1';
  });

  await test('GE-U-07', 'payload parser: junk, wrong types and bad topic names are rejected', async () => {
    assert.strictEqual(gwEvents.parsePayload('nope'), null);
    assert.strictEqual(gwEvents.parsePayload('{"t":1,"s":2}'), null);
    assert.strictEqual(gwEvents.parsePayload('{"t":"a","s":"x"}'), null);
    assert.deepStrictEqual(gwEvents.parsePayload('{"t":"a","s":3,"c":["ok_1","Bad","../x"]}'), { tenant: 'a', seq: 3, topics: ['ok_1'] });
    assert.deepStrictEqual(gwEvents.parseTopics('a1, homework ,DROP,x'), ['a1', 'homework']);
    /* the channel name is written as a literal in gateway.js (LISTEN) and tenancy.js (pg_notify) */
    const fs = require('node:fs');
    assert.strictEqual(gwEvents.CHANNEL, 'payesh_gw_feed');
    assert.ok(fs.readFileSync(path.join(ROOT, 'server/gateway.js'), 'utf8').includes("'LISTEN payesh_gw_feed'"));
    assert.ok(fs.readFileSync(path.join(ROOT, 'server/tenancy.js'), 'utf8').includes("pg_notify('payesh_gw_feed'"));
    return 'ok';
  });
}

/* ─────────────── real PostgreSQL + two Gateway processes ─────────────── */
async function pg() {
  const ADMIN = process.env.PAYESH_PG_ADMIN || '', RUNTIME = process.env.PAYESH_PG_RUNTIME || '';
  if (!ADMIN || !RUNTIME) { console.log('SKIP  GE-PG-*  (PAYESH_PG_ADMIN/PAYESH_PG_RUNTIME not set — CI api-contract runs them)'); return; }
  const tenancy = require(path.join(ROOT, 'server/tenancy.js'));
  const { Client } = require('pg');
  const admin = new Client({ connectionString: ADMIN });
  await admin.connect();
  await tenancy.migrate(admin);
  const SECRET = 'ge178-' + crypto.randomBytes(16).toString('hex');
  const RUN = String(Date.now()).slice(-10);
  const tid = (n) => '17817817-' + String(n).padStart(4, '0') + '-4000-8000-' + RUN.padStart(12, '0');
  const token = (t, did) => tenancy.signToken({ tid: t, role: 'manager', uid: 1, did, iat: Date.now(), exp: Date.now() + 600000 }, SECRET);
  const H = (t, did = 'dev-178') => ({ authorization: 'Bearer ' + token(t, did), 'x-device-id': did, 'content-type': 'application/json' });
  const children = [];
  const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  async function startGw(name) {
    const port = await freePort();
    const child = spawn(process.execPath, ['server/gateway.js'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1', PGURL: RUNTIME, GW_SECRET: SECRET,
        GW_INSTANCE: 'ge178-' + name, GW_QUOTA_MAX: '100000', GW_QUOTA_WINDOW_SEC: '3600', PAYESH_LOG: '0', GW_ACCESS_LOG: '0',
        PAYESH_FEATURE_KILL: '', PAYESH_CLIENT_KILL: '' }),
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
  const push = (gw, t, ops) => fetch(gw.base + '/api/gw/v1/push', { method: 'POST', headers: H(t), body: JSON.stringify({ ops }) }).then(async r => ({ status: r.status, data: await r.json() }));
  try {
    const A = await startGw('a'), B = await startGw('b');
    const T1 = tid(1), T2 = tid(2);

    await test('GE-PG-01', '401 without a token; with a token the stream opens with hello', async () => {
      const r = await fetch(A.base + '/api/gw/v1/events');
      assert.strictEqual(r.status, 401);
      const s = await sse(A.base + '/api/gw/v1/events?since=0', H(T1));
      assert.strictEqual(s.status, 200);
      const hello = await waitFor(() => of(s, 'hello')[0], 5000);
      assert.ok(hello, 'hello');
      assert.strictEqual(hello.seq, 0);
      s.close();
      return 'hello seq=0';
    });

    await test('GE-PG-02', 'push on instance B ⇒ change on instance A within 2 s (LISTEN/NOTIFY across instances); seq = feed seq', async () => {
      const s1 = await sse(A.base + '/api/gw/v1/events?since=0', H(T1, 'dev-a'));
      const s2 = await sse(A.base + '/api/gw/v1/events', H(T2, 'dev-b'));
      await waitFor(() => of(s1, 'hello').length && of(s2, 'hello').length, 5000);
      await sleep(400);  /* LISTEN connection established */
      const t0 = Date.now();
      const r = await push(B, T1, [{ uid: 'ge-' + RUN + '-1', collection: 'homework', id: 1, type: 'put', data: { title: 'x' } }]);
      assert.strictEqual(r.status, 200, JSON.stringify(r.data));
      const ch = await waitFor(() => of(s1, 'change')[0], 2000);
      const ms = Date.now() - t0;
      assert.ok(ch, 'change arrived on the other instance');
      assert.deepStrictEqual(ch.topics, ['homework']);
      const pull = await fetch(A.base + '/api/gw/v1/pull?since_seq=0', { headers: H(T1, 'dev-a') }).then(x => x.json());
      const maxSeq = Math.max(...pull.rows.map(x => Number(x.seq)));
      assert.strictEqual(ch.seq, maxSeq, 'notification seq equals the tenant feed seq');
      await sleep(200);
      assert.strictEqual(of(s2, 'change').length, 0, 'other tenant got nothing');
      s1.close(); s2.close();
      return `${ms} ms, seq=${ch.seq}`;
    });

    await test('GE-PG-03', 'a rejected push sends no notification; a duplicate replay neither (only committed writes notify)', async () => {
      const s = await sse(A.base + '/api/gw/v1/events?since=0', H(T1, 'dev-c'));
      await waitFor(() => of(s, 'hello').length, 5000);
      await sleep(400);
      const bad = await push(B, T1, [{ uid: 'ge-' + RUN + '-2', collection: 'homework', id: 2, type: 'put', data: { t: 1 } },
        { uid: 'ge-' + RUN + '-3', collection: 'BAD NAME', id: 3, type: 'put', data: {} }]);
      assert.notStrictEqual(bad.status, 200, 'invalid batch rejected');
      const dup = await push(B, T1, [{ uid: 'ge-' + RUN + '-1', collection: 'homework', id: 1, type: 'put', data: { title: 'x' } }]);
      assert.strictEqual(dup.status, 200);
      assert.strictEqual(dup.data.counts.duplicates, 1);
      await sleep(800);
      assert.strictEqual(of(s, 'change').length, 0, JSON.stringify(of(s, 'change')));
      s.close();
      return 'bad=' + bad.status + ', duplicate silent';
    });
  } finally {
    for (const c of children) { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } }
    await admin.end();
  }
}

(async () => {
  await unit();
  await pg();
  console.log(`\n${FAIL ? 'GW-EVENTS-178-FAIL' : 'GW-EVENTS-178-OK'} pass=${PASS} fail=${FAIL}${failures.length ? ' failed=' + failures.join(',') : ''}`);
  process.exit(FAIL ? 1 : 0);
})().catch((e) => { console.log('GW-EVENTS-178-FAIL crashed: ' + (e && e.stack || e)); process.exit(1); });
