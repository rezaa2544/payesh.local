#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 171 — any device, any network, anywhere: the rendezvous of school servers.

     RZ-01  an announced row keeps ONLY addresses (private LAN, https public); bad rows are dropped
     RZ-02  announce signature: right key accepted; wrong key / stale time / replay refused
     RZ-03  merged list = bucket list + announced rows + own row, freshest row per instance; central
     RZ-04  a REAL server (index.js) accepts a signed announce and serves it at
            /payesh/pub/school-servers.json (the domain path every app reads first) with CORS *
     RZ-05  an unsigned announce to the real server is refused (401) and changes nothing
     RZ-06  login answers «school_hosted_elsewhere» WITH the host's instance + addresses (409)
     RZ-07  the publisher also announces to the central server(s) (PAYESH_ANNOUNCE=0 turns it off)
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let passed = 0, failed = 0;
const pending = [];
function check(id, desc, fn) {
  pending.push(async () => {
    try { const d = await fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
    catch (e) { failed++; console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e)}`); }
  });
}
const assert = (c, m) => { if (!c) throw new Error(m); };

process.env.PAYESH_S3_ACCESS_KEY = 'AKIA-TEST-171';
process.env.PAYESH_S3_SECRET = 'secret-test-171';
process.env.PAYESH_NO_DEFAULT_CENTRAL = '1';
const rz = require(path.join(ROOT, 'server/rendezvous'));
const s3mem = require(path.join(ROOT, 'server/s3mem'));

const memStore = () => { const m = new Map(); return { getMeta: (k, d) => (m.has(k) ? m.get(k) : d), setMeta: (k, v) => m.set(k, v) }; };
const NOW = Date.now();
const iso = (t) => new Date(t).toISOString();
const row = (instance, extra = {}) => Object.assign({ instance, school: 'هنرستان ' + instance, lan: ['http://192.168.1.10:8080'], public_urls: ['https://' + instance + '.example.ir'], version: '0.9.27', at: iso(NOW) }, extra);

check('RZ-01', 'only addresses survive; bad rows dropped', async () => {
  const e = rz.cleanEntry(row('abcd1234', { lan: ['http://192.168.1.10:8080', 'http://127.0.0.1:8080', 'http://8.8.8.8:8080'], public_urls: ['http://plain.example.ir', 'https://ok.example.ir/path?q=1', 'https://u:p@bad.example.ir'], password: 'x', token: 'y' }));
  assert(e && e.lan.length === 1 && e.lan[0] === 'http://192.168.1.10:8080', 'lan ' + JSON.stringify(e && e.lan));
  assert(e.public_urls.length === 1 && e.public_urls[0] === 'https://ok.example.ir', 'pub ' + JSON.stringify(e.public_urls));
  assert(!('password' in e) && !('token' in e), 'extra keys kept');
  assert(rz.cleanEntry(row('x')) === null, 'short instance accepted');
  assert(rz.cleanEntry(row('abcd1234', { at: iso(NOW - 11 * 24 * 3600_000) })) === null, 'stale accepted');
  assert(rz.cleanEntry(row('abcd1234', { lan: [], public_urls: [] })) === null, 'no address accepted');
  return 'lan 1, https 1, no extras';
});

check('RZ-02', 'signature: right key yes; wrong key / stale / replay no', async () => {
  const store = memStore();
  const cfg = { bucket: 'payesh-b', accessKey: 'ak', secret: 'sk' };
  const key = rz.keyOf(cfg);
  const body = JSON.stringify({ v: 1, entry: row('school0001') });
  const ts = Date.now();
  const ok = rz.receive(store, body, { 'x-payesh-ts': String(ts), 'x-payesh-sig': rz.sign(key, ts, body) }, { cfg });
  assert(ok.status === 200, 'good refused ' + JSON.stringify(ok));
  const again = rz.receive(store, body, { 'x-payesh-ts': String(ts), 'x-payesh-sig': rz.sign(key, ts, body) }, { cfg });
  assert(again.status === 409, 'replay accepted ' + again.status);
  const other = rz.keyOf({ bucket: 'payesh-b', accessKey: 'ak', secret: 'OTHER' });
  assert(rz.keyOf({ bucket: '', accessKey: 'ak', secret: 'sk' }).equals(key), 'bucket name must not matter');
  const bad = rz.receive(store, body, { 'x-payesh-ts': String(ts + 1), 'x-payesh-sig': rz.sign(other, ts + 1, body) }, { cfg });
  assert(bad.status === 401, 'wrong key accepted ' + bad.status);
  const old = ts - 11 * 60_000;
  const stale = rz.receive(store, body, { 'x-payesh-ts': String(old), 'x-payesh-sig': rz.sign(key, old, body) }, { cfg });
  assert(stale.status === 401, 'stale accepted ' + stale.status);
  const none = rz.receive(memStore(), body, { 'x-payesh-ts': String(ts) }, { cfg: { bucket: '', accessKey: '', secret: '' } });
  assert(none.status === 503, 'unconnected accepted ' + none.status);
  return '200 / 409 / 401 / 401 / 503';
});

check('RZ-03', 'merged list: freshest per instance + central', async () => {
  rz._reset();
  const store = memStore();
  const cfg = { bucket: 'payesh-b', accessKey: 'ak', secret: 'sk' };
  const key = rz.keyOf(cfg);
  const body = JSON.stringify({ v: 1, entry: row('school0001', { at: iso(NOW - 1000), public_urls: ['https://new.example.ir'] }) });
  const ts = Date.now();
  rz.receive(store, body, { 'x-payesh-ts': String(ts), 'x-payesh-sig': rz.sign(key, ts, body) }, { cfg });
  const bucketDoc = { kind: rz.KIND, servers: [row('school0001', { at: iso(NOW - 60_000), public_urls: ['https://old.example.ir'] }), row('school0002')], central: { url: 'https://app.payeshschool.ir', at: null } };
  const doc = rz.mergedDoc(store, { bucketDoc, self: row('central01') });
  const ids = doc.servers.map(s => s.instance).sort().join(',');
  assert(ids === 'central01,school0001,school0002', ids);
  const s1 = doc.servers.find(s => s.instance === 'school0001');
  assert(s1.public_url === 'https://new.example.ir', 'not freshest ' + s1.public_url);
  assert(doc.central && doc.central.url === 'https://app.payeshschool.ir', 'central ' + JSON.stringify(doc.central));
  const addr = rz.addressesOf('school0001', { bucketDoc });
  assert(addr[0] === 'https://new.example.ir' && addr.includes('http://192.168.1.10:8080'), 'addressesOf ' + JSON.stringify(addr));
  const selfC = rz.mergedDoc(memStore(), { selfUrl: 'https://c.example.ir', env: { PAYESH_CENTRAL: '1' } });
  assert(selfC.central && selfC.central.url === 'https://c.example.ir', 'self central');
  return `${doc.servers.length} rows, central ok`;
});

/* ── سرور واقعی ── */
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const req = (method, port, p, body, headers = {}) => new Promise((resolve, reject) => {
  const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}, headers) }, (res) => {
    let t = ''; res.on('data', c => { t += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (e) { j = null; } resolve({ status: res.statusCode, json: j, headers: res.headers }); });
  });
  r.on('error', reject); if (data) r.write(data); r.end();
});
let box = null;
async function boot() {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rz171-'));
  const env = Object.assign({}, process.env, {
    PORT: String(port), HOST: '127.0.0.1', PAYESH_DATA: dir, PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0',
    PAYESH_LIVE_MS: '0', PAYESH_OUTBOX_AUTO: '0', PAYESH_CLOUD_AUTO: '0', PAYESH_MIRROR: '0', PAYESH_HEADLESS: '1',
    PAYESH_DISCOVERY: '0', PAYESH_NO_RESTART: '1', PAYESH_CENTRAL: '1', PAYESH_PUBLIC_URL: 'https://central.example.ir',
  });
  const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const b = { port, child, log: '' };
  child.stdout.on('data', (c) => { b.log += c; }); child.stderr.on('data', (c) => { b.log += c; });
  for (let i = 0; i < 200; i++) {
    const up = await req('GET', port, '/api/health').then(r => r.status === 200, () => false);
    if (up) return b;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server not up\n' + b.log.slice(-1500));
}

check('RZ-04', 'real server: signed announce ⇒ listed at the domain path, CORS *', async () => {
  box = await boot();
  rz._reset();
  const store = memStore();
  const env = { PAYESH_CENTRAL_URL: 'http://127.0.0.1:' + box.port, PAYESH_NO_DEFAULT_CENTRAL: '1' };
  const r = await rz.announce(store, rz.cleanEntry(row('school0777', { school: 'آینده‌سازان' })), { env });
  assert(r.length === 1 && r[0].ok, 'announce ' + JSON.stringify(r) + '\n' + box.log.slice(-800));
  const g = await req('GET', box.port, '/payesh/pub/school-servers.json', null, { origin: 'https://appassets.androidplatform.net' });
  assert(g.status === 200 && g.json && g.json.kind === 'payesh-school-servers', 'list ' + g.status);
  const e = g.json.servers.find(s => s.instance === 'school0777');
  assert(e && e.school === 'آینده‌سازان' && e.public_url === 'https://school0777.example.ir', 'row missing ' + JSON.stringify(g.json.servers));
  assert(g.json.central && g.json.central.url === 'https://central.example.ir', 'central ' + JSON.stringify(g.json.central));
  assert(g.headers['access-control-allow-origin'], 'no CORS');
  const g2 = await req('GET', box.port, '/api/dir/servers');
  assert(g2.status === 200 && g2.json.servers.some(s => s.instance === 'school0777'), 'api path');
  return `${g.json.servers.length} rows, central=${g.json.central.url}`;
});

check('RZ-05', 'real server: unsigned / wrongly signed announce refused', async () => {
  const body = JSON.stringify({ v: 1, entry: row('evil00001') });
  const a = await req('POST', box.port, '/api/dir/announce', body);
  const ts = Date.now();
  const b = await req('POST', box.port, '/api/dir/announce', body, { 'x-payesh-ts': String(ts), 'x-payesh-sig': rz.sign(rz.keyOf({ bucket: 'x', accessKey: 'y', secret: 'z' }), ts, body) });
  const g = await req('GET', box.port, '/api/dir/servers');
  assert(a.status === 401 && b.status === 401, `${a.status}/${b.status}`);
  assert(!g.json.servers.some(s => s.instance === 'evil00001'), 'evil row listed');
  return '401 / 401, not listed';
});

check('RZ-06', 'login 409 carries the host instance + addresses', async () => {
  const idx = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  const reg = fs.readFileSync(path.join(ROOT, 'server/school-registry.js'), 'utf8');
  assert(/out\.instance = a\.instance/.test(idx) && /rendezvous\.addressesOf\(a\.instance/.test(idx), 'index.js elsewhere() not wired');
  assert((idx.match(/json\(elsewhere\(a\)/g) || []).length === 2, 'both 409 paths');
  assert((reg.match(/error: 'school_hosted_elsewhere', instance:/g) || []).length === 2, 'registry instance');
  return 'adopt + link paths';
});

check('RZ-07', 'publisher announces to central (PAYESH_ANNOUNCE=0 off)', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/discovery.js'), 'utf8');
  assert(/PAYESH_ANNOUNCE === '0'/.test(src) && /announceNow\(store, info\)/.test(src), 'not wired');
  assert(rz.centralUrls({ env: {} }).includes('https://app.payeshschool.ir'), 'default central missing');
  assert(!rz.centralUrls({ env: { PAYESH_CENTRAL_URL: 'http://evil.example.ir' , PAYESH_NO_DEFAULT_CENTRAL: '1' } }).length, 'plain http central accepted');
  return 'wired; default https://app.payeshschool.ir';
});

(async () => {
  for (const p of pending) await p();
  if (box) box.child.kill('SIGTERM');
  void s3mem;
  console.log(`RENDEZVOUS-171  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
