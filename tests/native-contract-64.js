'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 64 — native API v1 conformance test (server side)
   Contract: docs/cloud/contracts/native-api-v1.md + native-api-v1.schema.json

   Every endpoint a native client calls is exercised over REAL HTTP against the REAL
   server (no mocks) and its response is validated with the official JSON Schema
   (Ajv 2020-12): positive, negative (error envelope) and invalid-structure cases.

   Part A — school server (server/index.js, SQLite): health, version, update, setup,
            login, pairing, refresh, me, device list/revoke, sync-v1 pull/push,
            version policy (426 upgrade_required).
   Part B — Gateway + Directory on real PostgreSQL (server/gateway.js): healthz/readyz,
            directory resolve, gateway pull/push, and the idempotency + pagination
            vectors. Needs PAYESH_PG_ADMIN + PAYESH_PG_RUNTIME; without them Part B
            prints BLOCKED and the run fails unless NATIVE_CONTRACT_ALLOW_NO_PG=1
            (local runs only — CI always provides PostgreSQL).

   Run: node --experimental-sqlite tests/native-contract-64.js
   ═══════════════════════════════════════════════════════════════════ */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert');
const Ajv2020 = require('ajv/dist/2020');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-c64-'));
const CONTRACTS = path.join(ROOT, 'docs/cloud/contracts');
const NATIVE = JSON.parse(fs.readFileSync(path.join(CONTRACTS, 'native-api-v1.schema.json'), 'utf8'));
const SYNC = JSON.parse(fs.readFileSync(path.join(CONTRACTS, 'sync-v1.schema.json'), 'utf8'));
const VEC = (n) => JSON.parse(fs.readFileSync(path.join(CONTRACTS, 'vectors', n), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(SYNC);
ajv.addSchema(NATIVE);
const V = (name) => {
  const f = ajv.getSchema(NATIVE.$id + '#/$defs/' + name);
  if (!f) throw new Error('no schema ' + name);
  return f;
};
const NATIVE_HDR = { 'x-payesh-client': 'payesh-native/0.1.0', 'x-payesh-api': '1' };

let PASS = 0, FAIL = 0;
const failures = [];
const covered = new Set();
async function test(id, name, fn) {
  try { const d = await fn(); PASS++; console.log(`PASS  ${id}  ${name}${d ? '  → ' + d : ''}`); }
  catch (e) { FAIL++; failures.push(id); console.log(`FAIL  ${id}  ${name}  → ${String(e && e.message || e).replace(/\s+/g, ' ').slice(0, 400)}`); }
}
function conforms(def, payload, what) {
  const v = V(def);
  if (!v(payload)) throw new Error(`${what || def} does not match $defs/${def}: ${ajv.errorsText(v.errors)} · body=${JSON.stringify(payload).slice(0, 200)}`);
  covered.add(def);
}
function rejects(def, payload, what) {
  const v = V(def);
  assert.ok(!v(payload), `${what}: schema $defs/${def} accepted an invalid structure`);
}
const clone = (o) => JSON.parse(JSON.stringify(o));

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
async function http(base, pathname, opts = {}) {
  const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
  if (opts.token) headers.authorization = 'Bearer ' + opts.token;
  const res = await fetch(base + pathname, {
    method: opts.method || 'GET', headers,
    body: opts.body === undefined ? undefined : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)),
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { status: res.status, data, headers: res.headers };
}
async function waitFor(fn, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fn(); if (r) return r; } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('service did not start');
}

const children = [];
function cleanup() {
  for (const c of children) { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* noop */ }
}

async function partA() {
  console.log('\n── Part A: school server (server/index.js) ──');
  const PORT = await freePort();
  const BASE = 'http://127.0.0.1:' + PORT;
  const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST: '127.0.0.1', PAYESH_DATA: path.join(TMP, 'srv'), PAYESH_LOG: '0',
      PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0', PAYESH_LIVE_MS: '0',
      PAYESH_OUTBOX_AUTO: '0', PAYESH_CLOUD_AUTO: '0', PAYESH_MIRROR: '0',
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.push(child);
  child.stderr.on('data', d => process.env.VERBOSE && console.error(String(d)));
  await waitFor(async () => (await http(BASE, '/api/health')).data?.ok);
  const req = (p, o) => http(BASE, p, o);

  await test('NC-A01', 'GET /api/health → healthResponse (no data_dir/db_file leak)', async () => {
    const r = await req('/api/health', { headers: NATIVE_HDR });
    assert.strictEqual(r.status, 200);
    conforms('healthResponse', r.data);
  });
  await test('NC-A02', 'GET /api/version → versionResponse', async () => {
    const r = await req('/api/version');
    assert.strictEqual(r.status, 200);
    conforms('versionResponse', r.data);
  });
  await test('NC-A03', 'GET /api/update/check (old + current) → updateCheckResponse (both branches)', async () => {
    const old = await req('/api/update/check?current=0.0.0', { headers: NATIVE_HDR });
    assert.strictEqual(old.status, 200);
    conforms('updateCheckResponse', old.data, 'update(old)');
    const cur = await req('/api/update/check?current=' + encodeURIComponent(old.data.version));
    conforms('updateCheckResponse', cur.data, 'update(current)');
    return 'old.up_to_date=' + old.data.up_to_date + ' cur.up_to_date=' + cur.data.up_to_date;
  });

  let mgr = null;
  await test('NC-A04', 'POST /api/setup → authSessionResponse (first manager session)', async () => {
    const r = await req('/api/setup', { method: 'POST', body: {
      school_name: 'مدرسهٔ قرارداد ۶۴', manager_name: 'مدیر قرارداد', password: 'Contract-64x', phone: '09120000641',
    } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    conforms('authSessionResponse', r.data, 'setup');
    mgr = r.data;
  });
  await test('NC-A05', 'POST /api/auth/login (native headers) → authSessionResponse + X-Payesh-Api headers', async () => {
    const body = { phone: '09120000641', password: 'Contract-64x', name: 'Pixel', platform: 'android' };
    conforms('loginRequest', body);
    const r = await req('/api/auth/login', { method: 'POST', body, headers: NATIVE_HDR });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    conforms('authSessionResponse', r.data, 'login');
    assert.strictEqual(r.headers.get('x-payesh-api'), '1');
    assert.strictEqual(r.headers.get('x-payesh-api-supported'), '1');
    mgr = r.data;
  });
  await test('NC-A06', 'login negatives: wrong password 401, short phone 401 → errorResponse; no secret in body', async () => {
    const bad = await req('/api/auth/login', { method: 'POST', body: { phone: '09120000641', password: 'wrong-pass' } });
    assert.strictEqual(bad.status, 401);
    conforms('errorResponse', bad.data, 'login(bad_credentials)');
    assert.strictEqual(bad.data.error, 'bad_credentials');
    const short = await req('/api/auth/login', { method: 'POST', body: { phone: '12', password: 'x' } });
    assert.strictEqual(short.status, 401);
    conforms('errorResponse', short.data, 'login(bad_phone)');
    assert.ok(!/password_hash|phone_hash/.test(JSON.stringify([bad.data, short.data])));
  });

  let student = null;
  await test('NC-A07', 'POST /api/sync (manager) → syncPushResponse; creates the users used below', async () => {
    const body = { ops: [
      { uid: 'nc64-cls-1', collection: 'classes', type: 'put', data: { name: 'دهم', grade: '10' } },
      { uid: 'nc64-stu-1', collection: 'users', type: 'put', data: { name: 'دانش‌آموز ۶۴', role: 'student', phone: '09120000642', national_id: '1000000642', class_id: 1 } },
    ] };
    conforms('syncPushRequest', body);
    const r = await req('/api/sync', { method: 'POST', token: mgr.session.token, body, headers: NATIVE_HDR });
    assert.strictEqual(r.status, 200);
    conforms('syncPushResponse', r.data);
    assert.strictEqual(r.data.rejected.length, 0, JSON.stringify(r.data.rejected));
    student = r.data.applied.find(a => a.uid === 'nc64-stu-1');
    assert.ok(student && student.id, 'student id');
  });
  await test('NC-A08', 'GET /api/v1/pull → syncPullResponse', async () => {
    const r = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&since_id=0', { token: mgr.session.token, headers: NATIVE_HDR });
    assert.strictEqual(r.status, 200);
    conforms('syncPullResponse', r.data);
  });

  let paired = null;
  await test('NC-A09', 'POST /api/auth/pair (code from /api/admin/pair-code) → authSessionResponse', async () => {
    const pc = await req('/api/admin/pair-code', { method: 'POST', token: mgr.session.token, body: { user_id: student.id } });
    assert.strictEqual(pc.status, 200, JSON.stringify(pc.data));
    const body = { code: pc.data.code, name: 'Galaxy', platform: 'android' };
    conforms('pairRequest', body);
    const r = await req('/api/auth/pair', { method: 'POST', body, headers: NATIVE_HDR });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    conforms('authSessionResponse', r.data, 'pair');
    assert.strictEqual(r.data.user.role, 'student');
    paired = r.data;
  });
  await test('NC-A10', 'pair negative: unknown code → 400 errorResponse(bad_code)', async () => {
    const r = await req('/api/auth/pair', { method: 'POST', body: { code: 'ZZZZ-ZZZZ' } });
    assert.strictEqual(r.status, 400);
    conforms('errorResponse', r.data);
    assert.strictEqual(r.data.error, 'bad_code');
  });
  await test('NC-A11', 'POST /api/auth/refresh → authSessionResponse (fresh session)', async () => {
    const body = { device_token: paired.device_token };
    conforms('refreshRequest', body);
    const r = await req('/api/auth/refresh', { method: 'POST', body, headers: NATIVE_HDR });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    conforms('authSessionResponse', r.data, 'refresh');
    assert.notStrictEqual(r.data.session.token, paired.session.token);
    paired.session = r.data.session;
    if (r.data.device_token) paired.device_token = r.data.device_token;
  });
  await test('NC-A12', 'GET /api/me → meResponse; without token → 401 errorResponse', async () => {
    const r = await req('/api/me', { token: paired.session.token, headers: NATIVE_HDR });
    assert.strictEqual(r.status, 200);
    conforms('meResponse', r.data);
    const anon = await req('/api/me');
    assert.strictEqual(anon.status, 401);
    conforms('errorResponse', anon.data, 'me(anon)');
  });
  let devices = null;
  await test('NC-A13', 'GET /api/admin/devices → deviceListResponse (manager); student → 403 errorResponse', async () => {
    const r = await req('/api/admin/devices', { token: mgr.session.token, headers: NATIVE_HDR });
    assert.strictEqual(r.status, 200);
    conforms('deviceListResponse', r.data);
    devices = r.data.devices;
    const s = await req('/api/admin/devices', { token: paired.session.token });
    assert.strictEqual(s.status, 403);
    conforms('errorResponse', s.data, 'devices(student)');
  });
  await test('NC-A14', 'DELETE /api/admin/devices/{id} → okResponse; revoked device: refresh 401 errorResponse, session dead', async () => {
    const me = await req('/api/me', { token: paired.session.token });
    const id = me.data.device_id;
    assert.ok(devices.some(d => d.id === id), 'paired device listed');
    const del = await req('/api/admin/devices/' + id, { method: 'DELETE', token: mgr.session.token, headers: NATIVE_HDR });
    assert.strictEqual(del.status, 200);
    conforms('okResponse', del.data, 'revoke');
    const rf = await req('/api/auth/refresh', { method: 'POST', body: { device_token: paired.device_token } });
    assert.strictEqual(rf.status, 401);
    conforms('errorResponse', rf.data, 'refresh(revoked)');
    assert.strictEqual(rf.data.error, 'device_revoked');
    const dead = await req('/api/me', { token: paired.session.token });
    assert.strictEqual(dead.status, 401);
  });
  await test('NC-A15', 'POST /api/auth/logout → okResponse; session no longer valid', async () => {
    const lg = await req('/api/auth/login', { method: 'POST', body: { phone: '09120000641', password: 'Contract-64x' } });
    const out = await req('/api/auth/logout', { method: 'POST', token: lg.data.session.token, body: {} });
    assert.strictEqual(out.status, 200);
    conforms('okResponse', out.data, 'logout');
    assert.strictEqual((await req('/api/me', { token: lg.data.session.token })).status, 401);
  });
  await test('NC-A16', 'version policy over HTTP: old client 426 upgradeRequired, newer api 400, malformed 400, web untouched', async () => {
    const old = await req('/api/me', { token: mgr.session.token, headers: { 'x-payesh-client': 'payesh-native/0.0.9' } });
    assert.strictEqual(old.status, 426);
    conforms('upgradeRequired', old.data, '426');
    const newer = await req('/api/me', { token: mgr.session.token, headers: { 'x-payesh-client': 'payesh-native/0.1.0', 'x-payesh-api': '2' } });
    assert.strictEqual(newer.status, 400);
    conforms('apiVersionUnsupported', newer.data, 'api 2');
    const bad = await req('/api/auth/login', { method: 'POST', body: {}, headers: { 'x-payesh-client': 'curl/8' } });
    assert.strictEqual(bad.status, 400);
    conforms('apiVersionUnsupported', bad.data, 'malformed');
    const web = await req('/api/me', { token: mgr.session.token });
    assert.strictEqual(web.status, 200);
    assert.strictEqual(web.headers.get('x-payesh-api'), null, 'web clients get no native headers');
    const health = await req('/api/health', { headers: { 'x-payesh-client': 'payesh-native/0.0.1' } });
    assert.strictEqual(health.status, 200, 'health is exempt');
  });
  await test('NC-A17', 'malformed JSON body → 400 errorResponse(bad_json) on /api/sync', async () => {
    const r = await req('/api/sync', { method: 'POST', token: mgr.session.token, body: '{ ops: [ nope' });
    assert.strictEqual(r.status, 400);
    conforms('errorResponse', r.data);
  });
  return { mgr };
}

function structureNegatives(samples) {
  console.log('\n── invalid-structure controls (schema must reject) ──');
  return test('NC-S01', 'mutated responses are rejected by the schema (12 mutations)', async () => {
    const s = samples;
    let n = 0;
    const m = (def, fn, what) => { const x = clone(s[def]); fn(x); rejects(def, x, what); n++; };
    m('authSessionResponse', x => { delete x.session.token; }, 'session without token');
    m('authSessionResponse', x => { x.session.token = 'short'; }, 'token not hex');
    m('authSessionResponse', x => { x.user.password_hash = 'pbkdf2$...'; }, 'secret leaked in user');
    m('authSessionResponse', x => { x.ok = 'true'; }, 'ok as string');
    m('meResponse', x => { x.role = 'superuser'; }, 'unknown role');
    m('healthResponse', x => { x.data_dir = '/srv/payesh'; }, 'data_dir leak');
    m('deviceListResponse', x => { x.devices = [{ id: 'xyz', user_id: 'a' }]; }, 'bad device');
    m('upgradeRequired', x => { delete x.message; }, '426 without message');
    m('upgradeRequired', x => { x.supported_api = []; }, '426 with empty window');
    m('directoryResolveResponse', x => { x.other_schools = ['a']; }, 'extra field (enumeration surface)');
    m('directoryResolveResponse', x => { x.migration_state = 'gone'; }, 'unknown migration state');
    m('errorResponse', x => { x.ok = true; }, 'error with ok:true');
    return n + ' mutations rejected';
  });
}

async function partB() {
  console.log('\n── Part B: Gateway + Directory on PostgreSQL (server/gateway.js) ──');
  const ADMIN = process.env.PAYESH_PG_ADMIN || '';
  const RUNTIME = process.env.PAYESH_PG_RUNTIME || '';
  if (!ADMIN || !RUNTIME) {
    console.log('BLOCKED — Part B needs PAYESH_PG_ADMIN and PAYESH_PG_RUNTIME (CI provides them)');
    if (process.env.NATIVE_CONTRACT_ALLOW_NO_PG !== '1') { FAIL++; failures.push('NC-B-BLOCKED'); }
    return null;
  }
  const tenancy = require(path.join(ROOT, 'server/tenancy.js'));
  const directory = require(path.join(ROOT, 'server/directory.js'));
  const { Client } = require('pg');
  const admin = new Client({ connectionString: ADMIN });
  await admin.connect();
  await tenancy.migrate(admin);
  await directory.migrate(admin);
  const SECRET = 'c64-' + require('node:crypto').randomBytes(16).toString('hex');
  const CELL = '6464aaaa-0000-4000-8000-000000000064';
  await directory.upsertCell(admin, { cellId: CELL, name: 'cell-64', baseUrl: 'https://cell64.a.b' });
  await directory.upsertRoute(admin, { schoolCode: 'school-64', cellId: CELL });

  const PORT = await freePort();
  const BASE = 'http://127.0.0.1:' + PORT;
  const gw = spawn(process.execPath, ['server/gateway.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST: '127.0.0.1', PGURL: RUNTIME, GW_SECRET: SECRET, GW_INSTANCE: 'gw-c64',
      GW_PULL_MAX: '50', GW_QUOTA_MAX: '100000', PAYESH_DIRECTORY_PGURL: ADMIN, PAYESH_DIR_RATE_MAX: '1000', PAYESH_LOG: '0',
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.push(gw);
  let log = '';
  gw.stderr.on('data', d => { log += String(d); });
  await waitFor(async () => (await http(BASE, '/healthz')).data?.ok).catch(e => { throw new Error(e.message + ' ' + log.slice(0, 300)); });
  const req = (p, o) => http(BASE, p, o);
  const tok = (tid, did = 'dev-c64') => tenancy.signToken({ tid, role: 'manager', uid: 1, did, iat: Date.now(), exp: Date.now() + 600000 }, SECRET);
  const T1 = '64646464-1111-4111-8111-' + String(Date.now()).slice(-12).padStart(12, '0');
  const T2 = '64646464-2222-4222-8222-' + String(Date.now()).slice(-12).padStart(12, '0');
  const H = (tid) => Object.assign({ authorization: 'Bearer ' + tok(tid), 'x-device-id': 'dev-c64' }, NATIVE_HDR);
  const samples = {};

  await test('NC-B01', 'GET /healthz → gwHealthzResponse; GET /readyz → gwReadyzResponse(ok)', async () => {
    const h = await req('/healthz');
    conforms('gwHealthzResponse', h.data);
    const r = await req('/readyz');
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    conforms('gwReadyzResponse', r.data);
  });
  await test('NC-B02', 'GET /api/dir/v1/resolve → directoryResolveResponse', async () => {
    const r = await req('/api/dir/v1/resolve?school_code=SCHOOL-64', { headers: NATIVE_HDR });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    conforms('directoryResolveResponse', r.data);
    assert.strictEqual(r.data.cell_url, 'https://cell64.a.b');
    assert.strictEqual(r.data.school_code, 'school-64');
    samples.directoryResolveResponse = r.data;
  });
  await test('NC-B03', 'resolve negatives: unknown and malformed codes → identical 404 errorResponse(not_found)', async () => {
    const a = await req('/api/dir/v1/resolve?school_code=no-such-school');
    const b = await req('/api/dir/v1/resolve?school_code=' + encodeURIComponent('../../etc'));
    const c = await req('/api/dir/v1/resolve');
    for (const r of [a, b, c]) { assert.strictEqual(r.status, 404); conforms('errorResponse', r.data); }
    assert.deepStrictEqual(a.data, b.data);
    assert.deepStrictEqual(a.data, c.data);
  });
  await test('NC-B04', 'POST /api/gw/v1/push + GET pull → gwPushResponse / gwPullResponse', async () => {
    const body = { ops: [{ uid: 'nc64-b4', collection: 'homework', id: 1, type: 'put', data: { title: 'x' } }] };
    conforms('gwPushRequest', body);
    const p = await req('/api/gw/v1/push', { method: 'POST', headers: H(T2), body });
    assert.strictEqual(p.status, 200, JSON.stringify(p.data));
    conforms('gwPushResponse', p.data);
    const g = await req('/api/gw/v1/pull?since_seq=0&limit=10', { headers: H(T2) });
    assert.strictEqual(g.status, 200, JSON.stringify(g.data));
    conforms('gwPullResponse', g.data);
    assert.strictEqual(g.data.rows.length, 1);
    assert.strictEqual(g.headers.get('x-payesh-api'), '1');
  });
  await test('NC-B05', 'gateway negatives: no token 401, bad ops 400, old client 426 — all schema-valid', async () => {
    const a = await req('/api/gw/v1/pull', { headers: NATIVE_HDR });
    assert.strictEqual(a.status, 401); conforms('errorResponse', a.data, 'no token');
    const b = await req('/api/gw/v1/push', { method: 'POST', headers: H(T2), body: { ops: 'nope' } });
    assert.strictEqual(b.status, 400); conforms('errorResponse', b.data, 'bad_ops');
    const c = await req('/api/gw/v1/pull', { headers: Object.assign({}, H(T2), { 'x-payesh-client': 'payesh-native/0.0.1' }) });
    assert.strictEqual(c.status, 426); conforms('upgradeRequired', c.data, 'gw 426');
    const d = await req('/api/dir/v1/resolve?school_code=school-64', { headers: { 'x-payesh-client': 'payesh-native/0.0.1' } });
    assert.strictEqual(d.status, 426, 'directory honours the version policy too');
  });

  const idem = VEC('idempotency-v1.json');
  for (const [n, st] of idem.steps.entries()) {
    await test('NC-B-IDEM-' + String(n + 1).padStart(2, '0'), 'vector idempotency-v1: ' + st.name, async () => {
      const r = await req('/api/gw/v1/push', { method: 'POST', headers: H(T1), body: { ops: st.ops } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.data));
      conforms('gwPushResponse', r.data);
      assert.deepStrictEqual(r.data.counts, st.expect);
    });
  }

  const pg = VEC('pagination-v1.json');
  const TP = '64646464-3333-4333-8333-' + String(Date.now()).slice(-12).padStart(12, '0');
  await test('NC-B-PAGE-01', `vector pagination-v1: walk ${pg.seed_rows} rows with limit ${pg.walk.limit}`, async () => {
    const ops = [];
    for (let i = 1; i <= pg.seed_rows; i++) ops.push({ uid: 'pg64-' + i, collection: 'homework', id: i, type: 'put', data: { title: 't' + i } });
    const seed = await req('/api/gw/v1/push', { method: 'POST', headers: H(TP), body: { ops } });
    assert.strictEqual(seed.data.counts.applied, pg.seed_rows, JSON.stringify(seed.data.counts));
    let cursor = 0; const sizes = [], mores = [], seen = new Set(); let last = 0;
    for (let i = 0; i < 10; i++) {
      const r = await req(`/api/gw/v1/pull?since_seq=${cursor}&limit=${pg.walk.limit}`, { headers: H(TP) });
      conforms('gwPullResponse', r.data);
      sizes.push(r.data.count); mores.push(r.data.more);
      for (const row of r.data.rows) { assert.ok(!seen.has(row.seq), 'repeated seq ' + row.seq); seen.add(row.seq); }
      if (r.data.rows.length) assert.ok(r.data.next_seq > last, 'cursor must strictly increase');
      last = r.data.next_seq; cursor = r.data.next_seq;
      if (!r.data.more) break;
    }
    assert.deepStrictEqual(sizes, pg.walk.expect_pages);
    assert.deepStrictEqual(mores, pg.walk.expect_more);
    assert.strictEqual(seen.size, pg.walk.expect_unique_total);
    const tail = await req(`/api/gw/v1/pull?since_seq=${cursor}&limit=${pg.walk.limit}`, { headers: H(TP) });
    assert.strictEqual(tail.data.count, 0); assert.strictEqual(tail.data.more, false);
    assert.strictEqual(tail.data.next_seq, cursor, 'empty page keeps the cursor');
    return 'pages=' + sizes.join('/');
  });
  for (const [n, c] of pg.clamp.entries()) {
    await test('NC-B-PAGE-C' + (n + 1), `vector pagination-v1: limit=${c.limit} → clamped_limit ${c.expect_clamped_limit}`, async () => {
      const r = await req('/api/gw/v1/pull?since_seq=0&limit=' + encodeURIComponent(c.limit), { headers: H(TP) });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.data.clamped_limit, c.expect_clamped_limit);
    });
  }
  await admin.end();
  return samples;
}

(async () => {
  console.log('Native API v1 conformance — row 64');
  let samples = {};
  try {
    await test('NC-00', 'schema compiles; role enum mirrors server/policy.js ROLES', async () => {
      const policy = require(path.join(ROOT, 'server/policy.js'));
      assert.deepStrictEqual(NATIVE.$defs.role.enum, policy.ROLES);
      for (const k of Object.keys(NATIVE.$defs)) V(k);
      return Object.keys(NATIVE.$defs).length + ' defs';
    });
    const a = await partA();
    const b = await partB();
    const base = (a && a.mgr) || {};
    samples = Object.assign({
      authSessionResponse: base.session ? base : { ok: true, user: { id: 1, name: 'x', role: 'manager' }, session: { token: 'a'.repeat(64), expires_at: '2026-11-10T00:00:00.000Z' }, device_token: 'b'.repeat(64) },
      meResponse: { ok: true, user: { id: 1, name: 'x', role: 'manager' }, role: 'manager', device_id: null },
      healthResponse: { ok: true, name: 'payesh-local', version: '0.9.2', server_time: '2026-11-10T00:00:00.000Z', setup_done: true },
      deviceListResponse: { ok: true, devices: [] },
      upgradeRequired: { ok: false, error: 'upgrade_required', reason: 'client_too_old', min_client: '0.1.0', supported_api: [1], current_api: 1, client: '0.0.9', message: 'به‌روزرسانی' },
      directoryResolveResponse: { ok: true, schema_version: 1, school_code: 'school-64', cell_id: '6464aaaa-0000-4000-8000-000000000064', cell_url: 'https://cell64.a.b', version: 1, ttl: 300, migration_state: 'stable', stale: false },
      errorResponse: { ok: false, error: 'not_found' },
    }, b || {});
    for (const k of ['authSessionResponse', 'meResponse', 'healthResponse', 'deviceListResponse', 'upgradeRequired', 'directoryResolveResponse', 'errorResponse']) {
      if (!V(k)(samples[k])) throw new Error('positive sample for ' + k + ' is itself invalid: ' + ajv.errorsText(V(k).errors));
    }
    await structureNegatives(samples);
    await test('NC-COVER', 'every response $def was exercised against a real server response', async () => {
      const responseDefs = Object.keys(NATIVE.$defs).filter(k => /Response$|^upgradeRequired$|^apiVersionUnsupported$/.test(k));
      const pgOnly = new Set(['directoryResolveResponse', 'gwPullResponse', 'gwPushResponse', 'gwHealthzResponse', 'gwReadyzResponse']);
      const missing = responseDefs.filter(k => !covered.has(k) && !(pgOnly.has(k) && !process.env.PAYESH_PG_ADMIN));
      assert.deepStrictEqual(missing, []);
      return covered.size + ' defs covered';
    });
  } catch (e) {
    FAIL++; failures.push('NC-CRASH'); console.log('FAIL  NC-CRASH  ' + (e && e.stack || e));
  } finally {
    cleanup();
  }
  console.log(`\nNC checks=${PASS + FAIL} pass=${PASS} fail=${FAIL}`);
  if (FAIL) { console.log('NATIVE-CONTRACT-64-FAIL ' + failures.join(',')); process.exit(1); }
  console.log('NATIVE-CONTRACT-64-OK');
  process.exit(0);
})();
