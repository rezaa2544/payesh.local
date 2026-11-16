#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 163 — the school server is found WITHOUT an address on the login screen.

     DS-01  the server writes <prefix>pub/school-servers.json with x-amz-acl: public-read,
            signed with the bucket key (the only object it makes public)
     DS-02  the document carries ONLY addresses: instance, school name, private LAN urls,
            https public url, version, time — no key, no user, no data
     DS-03  loopback / link-local / public http addresses are dropped; only https public url
     DS-04  other servers' rows are kept; rows older than 10 days are dropped; own row replaced
     DS-05  unchanged content is not rewritten within the hour (no bandwidth burn)
     DS-06  no cloud configured ⇒ nothing is sent
     DS-07  index.js starts the publisher (PAYESH_DISCOVERY=0 turns it off)
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');

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

process.env.PAYESH_S3_ACCESS_KEY = 'AKIA-TEST-163';
process.env.PAYESH_S3_SECRET = 'secret-test-163';
const s3mem = require(path.join(ROOT, 'server/s3mem'));
const discovery = require(path.join(ROOT, 'server/discovery'));

/* صندوقچهٔ قلابی: درخواست‌ها و هدرها را نگه می‌دارد */
const objects = new Map();
const calls = [];
s3mem.setFetch(async (url, opts = {}) => {
  const u = new URL(url);
  const method = (opts.method || 'GET').toUpperCase();
  const headers = {};
  for (const [k, v] of Object.entries(opts.headers || {})) headers[k.toLowerCase()] = v;
  const key = decodeURIComponent(u.pathname.replace(/^\/[^/]+\//, ''));
  calls.push({ method, key, headers, body: opts.body });
  const res = (status, text) => ({ ok: status < 300, status, text: async () => text, headers: { get: () => null } });
  if (method === 'PUT') { objects.set(key, String(opts.body || '')); return res(200, ''); }
  if (objects.has(key)) return res(200, objects.get(key));
  return res(404, '<Error><Code>NoSuchKey</Code></Error>');
});

const meta = new Map([['cloud:config', JSON.stringify({ bucket: 'payesh-test', source: 'saved' })]]);
const store = { getMeta: (k, d) => (meta.has(k) ? meta.get(k) : d), setMeta: (k, v) => meta.set(k, v) };
const KEY = 'payesh/pub/school-servers.json';
const T0 = Date.parse('2026-11-15T10:00:00Z');
const info = {
  instance: 'dd9286ad1f5d3ccb', school: 'آینده سازان',
  lanUrls: ['http://192.168.1.120:8080', 'http://10.10.1.1:8080', 'http://169.254.4.206:8080', 'http://127.0.0.1:8080', 'http://100.106.84.72:8080'],
  publicUrl: 'https://school.tail1234.ts.net/', version: '0.9.17',
};

check('DS-01', 'public-read PUT of pub/school-servers.json, signed', async () => {
  const r = await discovery.publish(store, info, { now: T0 });
  assert(r.ok && r.key === KEY, JSON.stringify(r));
  const put = calls.find(c => c.method === 'PUT');
  assert(put && put.key === KEY, 'no PUT on ' + KEY);
  assert(put.headers['x-amz-acl'] === 'public-read', 'not public-read');
  assert(/AWS4-HMAC-SHA256/.test(put.headers.authorization || ''), 'not signed');
  assert(calls.filter(c => c.method === 'PUT').length === 1, 'more than one object written');
  return put.key;
});

check('DS-02', 'only addresses — no key, user or data', async () => {
  const doc = JSON.parse(objects.get(KEY));
  assert(doc.v === 1 && doc.kind === 'payesh-school-servers', 'kind');
  const s = doc.servers[0];
  assert(JSON.stringify(Object.keys(s).sort()) === JSON.stringify(['at', 'instance', 'lan', 'public_url', 'public_urls', 'school', 'version']), Object.keys(s).join(','));
  const txt = objects.get(KEY);
  assert(!/AKIA-TEST-163|secret-test-163|password|phone|token/i.test(txt), 'secret-looking content');
  return s.school;
});

check('DS-03', 'loopback / link-local / CGNAT dropped; https public url kept', async () => {
  const s = JSON.parse(objects.get(KEY)).servers[0];
  assert(JSON.stringify(s.lan) === JSON.stringify(['http://192.168.1.120:8080', 'http://10.10.1.1:8080']), JSON.stringify(s.lan));
  assert(s.public_url === 'https://school.tail1234.ts.net', s.public_url);
  const e = discovery.entryOf({ instance: 'x', lanUrls: [], publicUrl: 'http://1.2.3.4:8080' });
  assert(e.public_url === null, 'plain http public url accepted');
  return s.lan.length + ' lan';
});

check('DS-04', 'other servers kept, stale dropped, own row replaced', async () => {
  const doc = JSON.parse(objects.get(KEY));
  doc.servers.push({ instance: 'other1', school: 'دیگر', lan: ['http://192.168.5.2:8080'], public_url: null, version: '0.9.16', at: new Date(T0 - 3600_000).toISOString() });
  doc.servers.push({ instance: 'old1', school: 'کهنه', lan: ['http://192.168.9.9:8080'], public_url: null, version: '0.9.1', at: new Date(T0 - 11 * 24 * 3600_000).toISOString() });
  objects.set(KEY, JSON.stringify(doc));
  const r = await discovery.publish(store, Object.assign({}, info, { lanUrls: ['http://192.168.1.121:8080'] }), { now: T0 + 60_000 });
  assert(r.ok, JSON.stringify(r));
  const next = JSON.parse(objects.get(KEY));
  const ids = next.servers.map(s => s.instance);
  assert(JSON.stringify(ids) === JSON.stringify(['dd9286ad1f5d3ccb', 'other1']), ids.join(','));
  assert(next.servers[0].lan[0] === 'http://192.168.1.121:8080', 'own row not replaced');
  return ids.join(',');
});

check('DS-05', 'unchanged content is not rewritten within the hour', async () => {
  const before = calls.filter(c => c.method === 'PUT').length;
  const r = await discovery.publish(store, Object.assign({}, info, { lanUrls: ['http://192.168.1.121:8080'] }), { now: T0 + 5 * 60_000 });
  assert(r.skipped === 'unchanged', JSON.stringify(r));
  assert(calls.filter(c => c.method === 'PUT').length === before, 'rewritten');
  const r2 = await discovery.publish(store, Object.assign({}, info, { lanUrls: ['http://192.168.1.121:8080'] }), { now: T0 + 2 * 3600_000 });
  assert(r2.ok && !r2.skipped, 'not refreshed after an hour');
  return 'skip, then refresh';
});

check('DS-06', 'no cloud ⇒ nothing sent', async () => {
  const n = calls.length;
  delete process.env.PAYESH_S3_ACCESS_KEY; delete process.env.PAYESH_S3_SECRET;
  const empty = { getMeta: (k, d) => d, setMeta() {} };
  const r = await discovery.publish(empty, info, { now: T0 });
  process.env.PAYESH_S3_ACCESS_KEY = 'AKIA-TEST-163'; process.env.PAYESH_S3_SECRET = 'secret-test-163';
  assert(!r.ok && calls.length === n, JSON.stringify(r));
  return r.error;
});

check('DS-07', 'index.js starts the publisher, PAYESH_DISCOVERY=0 turns it off', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  assert(/PAYESH_DISCOVERY !== '0'/.test(src) && /require\('\.\/discovery'\)\.start\(store/.test(src), 'not wired');
  return 'wired';
});

(async () => {
  for (const p of pending) await p();
  discovery.stop();
  console.log(`DISCOVERY-163  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
