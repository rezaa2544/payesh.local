'use strict';
/* ═══════════════════════════════════════════════════════════════════════
   Row 177 — event-driven sync: «تا تغییری نشده، الکی هر لحظه همه‌چیز را چک نکن».
   Real school server over HTTP + a counting fake S3. No mocks inside the server.

   EV-01  Store write ⇒ ONE coalesced event naming every changed collection
   EV-02  adaptive rule: 1 s inside the activity window, then ×2 up to 60 s (devices
          connected) / 5 min (nobody connected)
   EV-03  GET /api/v1/events without a session ⇒ 401
   EV-04  SSE: hello on connect; a write by another device ⇒ «change» with the collection
          name within 1 s; the event carries NO record data
   EV-05  topic filter: a subscriber of «grades» hears nothing about «announcements»
   EV-06  idle SSE connection: no bytes at all between hello and the next change
   EV-07  reconnect with an old `since` ⇒ hello.missed=true; with the current seq ⇒ false
   EV-08  a local write is published to S3 at once (event), even while the S3 check is slow
   EV-09  idle: S3 rev.json reads back off (far fewer than one per second) and nothing is
          written to S3 while nothing changes
   EV-10  a phone change (S3 mailbox) still arrives — within the idle cap
   EV-11  /api/v1/pull with If-None-Match after the event ⇒ only that collection, 304 when
          nothing changed (the «only the related part» half)
   PR-01  processing control: policy proc {paused,cpu} round-trips through the sealed infra
          policy and the server follows it on the next policy read; old policies stay valid
   PR-02  env overrides policy (PAYESH_PROC_PAUSED / PAYESH_CPU_PCT); invalid values ignored
   PR-03  CPU cap: «busy» threshold = cap; duty cycle rest = work×(100−cap)/cap (capped 5 s)
   PR-04  invalid proc (cpu 5 / 150, paused not boolean) ⇒ whole policy rejected
   PR-05  mirror is not rebuilt when nothing was written (event seq unchanged)

   Run: node --experimental-sqlite --disable-warning=ExperimentalWarning tests/events-177.js
   ═══════════════════════════════════════════════════════════════════════ */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BUCKET = 'payesh-ev';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(id, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${id} ${detail}`); } else { fail++; console.log(`FAIL ${id} ${detail}`); }
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/* ── counting fake S3 ─────────────────────────────────────────────── */
function startFakeS3() {
  const objects = new Map();
  const log = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const parts = u.pathname.split('/').filter(Boolean);
    const send = (code, body, type = 'application/xml') => { res.writeHead(code, { 'content-type': type }); res.end(body); };
    if (req.method === 'GET' && parts.length === 0) {
      return send(200, `<?xml version="1.0"?><ListAllMyBucketsResult><Buckets><Bucket><Name>${BUCKET}</Name></Bucket></Buckets></ListAllMyBucketsResult>`);
    }
    if (parts[0] !== BUCKET) return send(404, '<Error><Code>NoSuchBucket</Code></Error>');
    const key = parts.slice(1).join('/');
    log.push({ at: Date.now(), m: req.method, key, list: u.searchParams.get('list-type') === '2' });
    if (req.method === 'GET' && u.searchParams.get('list-type') === '2') {
      const prefix = u.searchParams.get('prefix') || '';
      const keys = [...objects.keys()].filter(k => k.startsWith(prefix)).sort();
      return send(200, '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
        keys.map(k => `<Contents><Key>${k}</Key><Size>${objects.get(k).length}</Size></Contents>`).join('') + '</ListBucketResult>');
    }
    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => { objects.set(key, Buffer.concat(chunks).toString('utf8')); send(200, ''); });
      return;
    }
    if (req.method === 'DELETE') { objects.delete(key); return send(204, ''); }
    if (req.method === 'HEAD') { res.writeHead(objects.has(key) ? 200 : 404); res.end(); return; }
    if (objects.has(key)) return send(200, objects.get(key), 'application/json; charset=utf-8');
    return send(404, '<Error><Code>NoSuchKey</Code></Error>');
  });
  return new Promise(res => server.listen(0, '127.0.0.1', () => res({ server, objects, log, port: server.address().port })));
}

/* ── SSE reader over a raw http request (counts every byte) ──────── */
function openSse(base, token, query = '') {
  return new Promise((resolve) => {
    const u = new URL(base + '/api/v1/events' + query);
    const st = { status: 0, events: [], bytes: 0, raw: '', req: null, close() { try { this.req.destroy(); } catch (e) { /* noop */ } } };
    const r = http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: token ? { authorization: 'Bearer ' + token } : {} }, (res) => {
      st.status = res.statusCode;
      st.type = String(res.headers['content-type'] || '');
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (d) => {
        st.bytes += Buffer.byteLength(d);
        st.raw += d;
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = (block.match(/^event: (.*)$/m) || [])[1];
          const data = (block.match(/^data: (.*)$/m) || [])[1];
          if (ev) { let j = null; try { j = JSON.parse(data); } catch (e) { j = data; } st.events.push({ ev, data: j, at: Date.now(), bytes: st.bytes }); }
        }
      });
      resolve(st);
    });
    r.on('error', () => resolve(st));
    st.req = r;
  });
}

async function main() {
  /* EV-01 / EV-02: units */
  {
    const events = require(path.join(ROOT, 'server/events.js'));
    const { openStore } = require(path.join(ROOT, 'server/db.js'));
    events._reset();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-ev177-u-'));
    const store = openStore(path.join(dir, 'u.sqlite'));
    events.attachStore(store);
    const got = [];
    events.onChange((e) => got.push(e));
    store.insert('users', { name: 'a' });
    store.insert('users', { name: 'b' });
    const g = store.insert('grades', { score: 10 });
    store.update('grades', g.id, { score: 11 });
    await sleep(events.COALESCE_MS + 120);
    check('EV-01', got.length === 1 && JSON.stringify(got[0].topics) === '["grades","users"]' && got[0].seq === 1,
      `4 writes in 2 collections ⇒ ${got.length} event(s) ${JSON.stringify(got.map(e => e.topics))}`);
    store.remove('users', 1);
    await sleep(events.COALESCE_MS + 120);
    check('EV-01b', got.length === 2 && got[1].topics[0] === 'users' && got[1].seq === 2, 'remove ⇒ its own event, seq 2');
    try { store.close(); } catch (e) { /* noop */ }
    events._reset();

    const live = require(path.join(ROOT, 'server/live.js'));
    const o = { everyMs: 1000, activeWindowMs: 120000, idleMaxMs: 60000, asleepMaxMs: 300000 };
    const seqOf = (clients, n) => { const out = []; let d = 1000; for (let i = 0; i < n; i++) { d = live.adaptiveDelay({ now: 1e9, lastActivity: 0, prevDelay: d, clients, opts: o }); out.push(d / 1000); } return out; };
    const active = live.adaptiveDelay({ now: 1e9, lastActivity: 1e9 - 5000, prevDelay: 64000, clients: 0, opts: o });
    const withClients = seqOf(2, 9);
    const nobody = seqOf(0, 10);
    check('EV-02', active === 1000 && withClients[withClients.length - 1] === 60 && nobody[nobody.length - 1] === 300 &&
      withClients[0] === 2 && withClients[1] === 4,
      `active ⇒ ${active / 1000}s; idle+clients ${withClients.join(',')}s; idle+nobody ${nobody.join(',')}s`);
    // reads per idle day (after the first minutes): 86400 before ⇒ 1440 (clients) / 288 (nobody)
    console.log(`     idle S3 reads/day: before 86400 · now ${86400 / 60} (devices connected) · ${86400 / 300} (nobody)`);
  }

  /* PR-01..04: processing control (unit, real sealed policy in a fake S3) */
  const fake = await startFakeS3();
  {
    const s3mem = require(path.join(ROOT, 'server/s3mem.js'));
    const hj = require(path.join(ROOT, 'server/helper-jobs.js'));
    const proc = require(path.join(ROOT, 'server/processing.js'));
    const cfg = s3mem.normalize({ endpoint: 'http://127.0.0.1:' + fake.port, region: 'ir-central1', bucket: BUCKET, accessKey: 'AKIAPR', secret: 'pr-secret', prefix: 'payesh/', pathStyle: true });
    const saveEnv = { p: process.env.PAYESH_PROC_PAUSED, c: process.env.PAYESH_CPU_PCT };
    delete process.env.PAYESH_PROC_PAUSED; delete process.env.PAYESH_CPU_PCT;
    proc._reset();
    const pol = { v: 1, helpers: true, mode: 'helpers', external: '', off: [], at: Date.now(), proc: { paused: true, cpu: 40 } };
    await hj.writePolicy(cfg, pol);
    hj._resetPolicyCache();
    const read = await hj.readPolicy(cfg);
    const st1 = proc.status();
    const old = hj.validPolicy({ v: 1, helpers: true, off: [], at: 1 });
    check('PR-01', read && read.proc.cpu === 40 && st1.paused === true && st1.cpu_pct === 40 && st1.source === 'policy' && old,
      `policy proc ⇒ server ${JSON.stringify(st1)}; policy without proc still valid: ${old}`);
    const e1 = proc.apply(read, { PAYESH_PROC_PAUSED: '0', PAYESH_CPU_PCT: '70' });
    const e2 = proc.apply(read, { PAYESH_CPU_PCT: '5' });
    const e3 = proc.apply({ v: 1 }, {});
    check('PR-02', e1.paused === false && e1.cpu_pct === 70 && e1.source === 'env' && e2.cpu_pct === 40 && e2.source === 'policy' && e3.paused === false && e3.cpu_pct === null && e3.source === 'default',
      `env 0/70 ⇒ ${JSON.stringify(e1)}; env cpu=5 ignored ⇒ ${e2.cpu_pct}; no proc ⇒ ${e3.source}`);
    proc.apply({ proc: { paused: false, cpu: 25 } }, {});
    const r25 = [proc.busyCpu(0.75), proc.restMs(100), proc.restMs(10000)];
    proc.apply({ proc: { paused: false, cpu: 100 } }, {});
    const r100 = [proc.busyCpu(0.75), proc.restMs(100)];
    proc.apply(null, {});
    const rNone = [proc.busyCpu(0.75), proc.restMs(100)];
    check('PR-03', r25[0] === 0.25 && r25[1] === 300 && r25[2] === proc.MAX_REST_MS && r100[0] === 1 && r100[1] === 0 && rNone[0] === 0.75 && rNone[1] === 0,
      `cap 25% ⇒ busy≥${r25[0]}, rest after 100 ms work ${r25[1]} ms (cap ${r25[2]}); 100% ⇒ ${r100}; none ⇒ ${rNone}`);
    const bad = [{ paused: true, cpu: 5 }, { paused: true, cpu: 150 }, { paused: 'yes' }, null]
      .map(p => hj.validPolicy({ v: 1, helpers: true, off: [], at: 1, proc: p }));
    check('PR-04', bad.every(b => b === false), `invalid proc ⇒ ${JSON.stringify(bad)}`);
    /* PR-06/07 (row 178): «pause» also stops the helper server's background work; CPU cap on background local jobs */
    fake.objects.clear();
    proc.apply({ proc: { paused: true, cpu: 50 } }, {});
    const before = fake.objects.size;
    let ran = 0;
    const checkEndpoint = async () => { ran++; return { reachable: true }; };
    const bg = await hj.runJob(cfg, 'endpoint.check', { url: 'https://example.org/' }, { background: true, checkEndpoint, claimWaitMs: 50 });
    const user = await hj.runJob(cfg, 'endpoint.check', { url: 'https://example.org/' }, { checkEndpoint, claimWaitMs: 50 });
    const hjSrc = fs.readFileSync(path.join(ROOT, 'server/helper-jobs.js'), 'utf8');
    const routeGated = /if \(processing\.paused\(\)\) \{ routeSkipped\+\+; return; \}\s*await routeNow/.test(hjSrc) &&
      /const policy = cfg && cfg\.enabled \? await readPolicy\(cfg\) : null;\s*\/\*[^]*?\*\/\s*if \(processing\.paused\(\)\)/.test(hjSrc);
    check('PR-06', bg.ok === false && bg.error === 'processing_paused' && user.ok === true && user.by === 'local' && user.why === 'processing_paused' &&
      ran === 1 && fake.objects.size === before && routeGated,
      `paused: background job ⇒ ${bg.error} (not run), user request ⇒ ${user.by}/${user.why}, checks run=${ran}, queue writes=${fake.objects.size - before}; 5 s route tick keeps reading the policy but skips routing: ${routeGated}`);
    proc.apply({ proc: { paused: false, cpu: 50 } }, {});
    const rests = [];
    const slow = async () => { await new Promise(r => setTimeout(r, 30)); return { reachable: true }; };
    const throttle = async (ms) => { rests.push(ms); return proc.restMs(ms); };
    await hj.runJob(cfg, 'endpoint.check', { url: 'https://example.org/' }, { preferLocal: true, background: true, checkEndpoint: slow, throttle });
    await hj.runJob(cfg, 'endpoint.check', { url: 'https://example.org/' }, { preferLocal: true, checkEndpoint: slow, throttle });
    check('PR-07', rests.length === 1 && rests[0] >= 25 && proc.restMs(rests[0]) === rests[0],
      `cap 50%: background local job rests after ${rests[0]} ms work (rest ${proc.restMs(rests[0] || 0)} ms); user request not throttled (${rests.length} throttle call)`);
    fake.objects.clear();
    hj._resetPolicyCache();
    proc._reset();
    if (saveEnv.p !== undefined) process.env.PAYESH_PROC_PAUSED = saveEnv.p;
    if (saveEnv.c !== undefined) process.env.PAYESH_CPU_PCT = saveEnv.c;
    const idx = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    check('PR-05', /const r = seq === mirrorSeq \? \{ changed: false \} : mirror\.refreshMirror/.test(idx) && /if \(mirrorBusy \|\| processing\.paused\(\)\) return;/.test(idx),
      'mirror rebuild gated on the write-event seq and on «pause»');
  }

  /* real server */
  const S3URL = 'http://127.0.0.1:' + fake.port;
  const port = await freePort();
  const BASE = 'http://127.0.0.1:' + port;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-ev177-'));
  const ACTIVE = 1500, IDLE = 3000;
  const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', path.join(ROOT, 'server/index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), HOST: '127.0.0.1', PAYESH_DATA: DATA, PAYESH_LOG: '0',
      PAYESH_CLOUD_AUTO: '0', PAYESH_OUTBOX_AUTO: '0', PAYESH_UPDATE_AUTO: '0', PAYESH_AUTO_BACKUP: '0', PAYESH_NO_RESTART: '1',
      PAYESH_MIRROR: '0', PAYESH_LIVE_MS: '1000', PAYESH_LIVE_ACTIVE_MS: String(ACTIVE), PAYESH_LIVE_IDLE_MS: String(IDLE), PAYESH_LIVE_ASLEEP_MS: String(IDLE),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let slog = '';
  child.stdout.on('data', d => { slog += d; });
  child.stderr.on('data', d => { slog += d; });
  const req = async (p, opts = {}) => {
    try {
      const r = await fetch(BASE + p, {
        method: opts.method || (opts.body ? 'POST' : 'GET'),
        headers: Object.assign({ 'content-type': 'application/json' }, opts.token ? { authorization: 'Bearer ' + opts.token } : {}, opts.headers || {}),
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      const text = await r.text();
      let data = null; try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
      return { status: r.status, data, headers: r.headers };
    } catch (e) { return { status: 0, data: {} }; }
  };
  const waitFor = async (fn, ms = 8000, step = 100) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; };
  const streams = [];
  try {
    if (!await waitFor(async () => (await req('/api/health')).data.ok, 20000)) throw new Error('server did not start ' + slog.slice(-300));
    const setup = await req('/api/setup', { body: { school_name: 'EV177', manager_name: 'مدیر', phone: '09120000177', password: 'Ev-177-pass' } });
    const token = (setup.data.session && setup.data.session.token) || setup.data.token || (await req('/api/auth/login', { body: { phone: '09120000177', password: 'Ev-177-pass' } })).data.token;
    if (!token) throw new Error('no token ' + JSON.stringify(setup.data).slice(0, 200));
    const cloud = await req('/api/admin/cloud', { token, body: { endpoint: S3URL, region: 'ir-central1', bucket: BUCKET, accessKey: 'AKIATEST', secret: 'secret', prefix: 'payesh/', pathStyle: true } });
    if (cloud.data.ok === false) throw new Error('cloud ' + JSON.stringify(cloud.data).slice(0, 200));
    // first publish settles
    await waitFor(async () => fake.objects.has('payesh/realtime/rev.json'), 8000);
    const put = (title, collection = 'announcements') => req('/api/sync', { token, body: { ops: [{ uid: 'ev-' + Math.random().toString(36).slice(2), collection, type: 'put', data: collection === 'announcements' ? { title, body: 'x', date: new Date().toISOString().slice(0, 10), audience: 'all' } : { student_id: 1, subject_id: 1, score: 15, title } }] } });

    /* EV-03 */
    const anon = await openSse(BASE, null);
    check('EV-03', anon.status === 401, `no session ⇒ ${anon.status}`);
    anon.close();

    /* EV-04 / EV-06 */
    const all = await openSse(BASE, token);
    streams.push(all);
    await waitFor(async () => all.events.length >= 1, 3000);
    const hello = all.events[0];
    await sleep(1200);
    const idleBytes = all.bytes - (hello ? hello.bytes : 0);
    check('EV-06', idleBytes === 0, `idle SSE for 1.2 s after hello: ${idleBytes} bytes`);
    const t0 = Date.now();
    await put('EV177 خبر');
    const ch = await waitFor(async () => all.events.find(e => e.ev === 'change' && e.data.topics.includes('announcements')), 3000, 20);
    const took = ch ? ch.at - t0 : -1;
    check('EV-04', all.status === 200 && /text\/event-stream/.test(all.type) && hello && hello.ev === 'hello' && ch && took < 1000 && !all.raw.includes('EV177 خبر'),
      `status ${all.status} ${all.type}; hello=${hello && hello.ev}; change in ${took} ms ${ch ? JSON.stringify(ch.data) : ''}; record text in stream: ${all.raw.includes('EV177 خبر')}`);

    /* EV-05 */
    const grades = await openSse(BASE, token, '?topics=grades');
    streams.push(grades);
    await waitFor(async () => grades.events.length >= 1, 3000);
    await put('EV177 فقط خبر');
    await sleep(700);
    const noise = grades.events.filter(e => e.ev === 'change').length;
    await put('EV177 نمره', 'grades');
    const hit = await waitFor(async () => grades.events.find(e => e.ev === 'change'), 3000, 20);
    check('EV-05', noise === 0 && hit && JSON.stringify(hit.data.topics) === '["grades"]', `announcements ⇒ ${noise} events to the grades subscriber; grades ⇒ ${hit ? JSON.stringify(hit.data.topics) : 'none'}`);

    /* EV-07 */
    const seqNow = Math.max(...all.events.filter(e => e.data && e.data.seq != null).map(e => e.data.seq));
    const old = await openSse(BASE, token, '?since=0');
    const cur = await openSse(BASE, token, '?since=' + seqNow);
    streams.push(old, cur);
    await waitFor(async () => old.events.length && cur.events.length, 3000);
    check('EV-07', old.events[0] && old.events[0].data.missed === true && cur.events[0] && cur.events[0].data.missed === false,
      `since=0 ⇒ missed=${old.events[0] && old.events[0].data.missed}; since=${seqNow} ⇒ missed=${cur.events[0] && cur.events[0].data.missed}`);
    for (const s of [grades, old, cur]) s.close();

    /* EV-09: idle — wait for the activity window to pass, then count */
    await sleep(ACTIVE + 1500);
    const w0 = Date.now();
    const WINDOW = 9000;
    await sleep(WINDOW);
    const inWin = fake.log.filter(r => r.at >= w0 && r.at < w0 + WINDOW);
    const revReads = inWin.filter(r => r.m === 'GET' && r.key === 'payesh/realtime/rev.json').length;
    const puts = inWin.filter(r => r.m === 'PUT').length;
    check('EV-09', revReads <= 5 && puts === 0, `idle ${WINDOW / 1000}s: ${revReads} rev.json reads (fixed 1 s loop: ~${WINDOW / 1000}), ${puts} S3 writes`);

    /* EV-08: local write while the check is slow ⇒ published at once */
    const t1 = Date.now();
    await put('EV177 فوری');
    const pub = await waitFor(async () => {
      const core = fake.objects.get('payesh/data/core.json');
      return core && core.includes('EV177 فوری') ? Date.now() : null;
    }, 6000, 50);
    check('EV-08', pub && pub - t1 < 1500, `local write ⇒ in S3 after ${pub ? pub - t1 : 'never'} ms (S3 check interval was up to ${IDLE / 1000}s)`);

    /* EV-10: phone change via the S3 mailbox */
    await sleep(ACTIVE + 1500);
    const st = (await req('/api/live/state', { token })).data;
    const uid = 'ev-phone-' + Date.now();
    /* a phone's signed envelope lands in the S3 mailbox (same path a real phone uses: server-signed, F-06) */
    const sub = await req('/api/outbox/submit', { token, body: { items: [{ uid, op: { collection: 'announcements', type: 'put', data: { title: 'EV177 گوشی', body: 'p', date: new Date().toISOString().slice(0, 10), audience: 'all' } } }] } });
    if (!sub.data.ok) throw new Error('submit ' + JSON.stringify(sub.data).slice(0, 200));
    const rev = JSON.parse(fake.objects.get('payesh/realtime/rev.json') || '{}');
    fake.objects.set('payesh/realtime/rev.json', JSON.stringify(Object.assign(rev, { rev: 'phone-' + Date.now(), by: 'phone' })));
    const t2 = Date.now();
    const arrived = await waitFor(async () => {
      const r = await fetch(BASE + '/api/v1/pull?collections=announcements&since=1970-01-01T00:00:00.000Z', { headers: { authorization: 'Bearer ' + token } }).then(x => x.json()).catch(() => ({}));
      return ((r.collections && r.collections.announcements) || []).find(a => a.title === 'EV177 گوشی') ? Date.now() : null;
    }, IDLE * 3, 200);
    const sseHeard = !!await waitFor(async () => all.events.some(e => e.ev === 'change' && e.at >= t2 && e.data.topics.includes('announcements')), 2000, 20);
    /* …and is republished for every other device (core.json in S3) */
    const fanout = await waitFor(async () => { const core = fake.objects.get('payesh/data/core.json'); return core && core.includes('EV177 گوشی') ? Date.now() : null; }, 3000, 50);
    if (!arrived || !sseHeard || !fanout) console.log('     outbox: ' + JSON.stringify(sub.data).slice(0,200) + ' ' + [...fake.objects.keys()].filter(k => k.includes('outbox')).map(k => k + ' ' + fake.objects.get(k).slice(0, 200)).join(' | '));
    if (!arrived || !sseHeard || !fanout) console.log('     state: ' + JSON.stringify((await req('/api/live/state', { token })).data).slice(0, 700));
    check('EV-10', arrived && arrived - t2 <= IDLE + 2500 && sseHeard && fanout, `phone change in DB after ${arrived ? arrived - t2 : 'never'} ms (idle cap ${IDLE} ms, delay was ${st.delay_ms} ms); SSE told the devices: ${sseHeard}; republished to S3 for other devices after ${fanout ? fanout - t2 : 'never'} ms`);

    /* EV-11 */
    const p1 = await fetch(BASE + '/api/v1/pull?collections=grades&since=1970-01-01T00:00:00.000Z', { headers: { authorization: 'Bearer ' + token } });
    const etag = p1.headers.get('etag');
    const b1 = await p1.json();
    const p2 = await fetch(BASE + '/api/v1/pull?collections=grades&since=1970-01-01T00:00:00.000Z', { headers: { authorization: 'Bearer ' + token, 'if-none-match': etag || '' } });
    const keys = Object.keys(b1.collections || {});
    check('EV-11', etag && p2.status === 304 && keys.length === 1 && keys[0] === 'grades', `collections=grades ⇒ ${JSON.stringify(keys)}; same again with ETag ⇒ ${p2.status}`);
    all.close();
  } catch (e) {
    fail++;
    console.log('FAIL EV-XX ' + (e && e.stack || e) + ' — server log: ' + slog.slice(-400));
  } finally {
    for (const s of streams) s.close();
    try { child.kill('SIGKILL'); } catch (e) { /* noop */ }
    try { fake.server.close(); } catch (e) { /* noop */ }
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* noop */ }
  }
  console.log(fail ? `EVENTS-177-FAIL ${pass} passed, ${fail} failed` : `EVENTS-177-OK ${pass}/${pass}`);
  process.exit(fail ? 1 : 0);
}

main();
