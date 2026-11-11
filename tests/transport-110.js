'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 110 (ADR-105, Proposed): direct transport in the JS client behind
   PAYESH_TRANSPORT=direct (default off).                       TR-01 .. TR-08

   AC (Notion row 110):
     • the transport layer is separate from the provider layer
       (client/transport.js ↔ client/provider-postgrest.js) — TR-01, TR-07;
     • NO service key in the client — static scan of every client source
       (JS + Dart) with planted positive controls, plus the runtime refusal
       — TR-03, TR-04;
     • offline work unchanged: the same outbox keeps every op through a
       network outage and drains on reconnect, over the direct path — TR-06;
     • Gateway mode still works: default selection, the exact app.js calls,
       and the existing suite (npm test 111/111) — TR-01, TR-05.

   TR-06/07 run on REAL PostgreSQL through a PostgREST-compatible emulator
   (HTTP; publishable key + HS256 user JWT → SET LOCAL ROLE + claims, as
   PostgREST does). No managed provider is touched: label [S].

   Run: PAYESH_PG_ADMIN=postgres://postgres@127.0.0.1:5432/payesh_c64 node tests/transport-110.js
        (TR110_REQUIRE_PG=1 turns "no PG" into a failure, as in CI)
   ═══════════════════════════════════════════════════════════════════ */
require('fake-indexeddb/auto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const T = require('../client/transport.js');
const P = require('../client/provider-postgrest.js');
const outbox = require('../client/outbox-web.js');
const engineWeb = require('../client/engine-web.js');

let passed = 0, failed = 0, skipped = 0;
const failures = [];
async function check(id, desc, fn) {
  const t0 = Date.now();
  try {
    const d = await fn();
    if (d === 'SKIP') { skipped++; console.log(`SKIP  ${id}  ${desc}`); return; }
    passed++;
    console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}  (${Date.now() - t0}ms)`);
  } catch (e) {
    failed++; failures.push(id);
    console.log(`FAIL  ${id}  ${desc}  → ${String((e && (e.code ? e.code + ' ' : '') + e.message) || e).slice(0, 600)}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
async function throwsCode(p, code, m) {
  try { await (typeof p === 'function' ? p() : p); } catch (e) { if (e.code === code) return; throw new Error(`${m}: expected ${code}, got ${e.code} ${e.message}`); }
  throw new Error(`${m}: expected ${code}, nothing thrown`);
}
const b64u = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function jwt(claims, secret = 'x') {
  const h = b64u({ alg: 'HS256', typ: 'JWT' }), p = b64u(claims);
  return `${h}.${p}.` + crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
}
let dbSeq = 0;
const freshName = t => `t110-${t}-${process.pid}-${++dbSeq}`;

/* ── the static scanner of TR-04 (exported for its own positive controls) ── */
const SCAN_ROOTS = ['client', 'apps/payesh/app/lib', 'apps/payesh/packages'];
const SCAN_EXT = /\.(js|mjs|cjs|html|json|dart|ts)$/;
const SECRET_PATTERNS = [
  ['service-role name', /service_role|SERVICE_ROLE/],
  ['supabase secret key', /sb_secret_[A-Za-z0-9_-]*/],
  ['supabase admin role', /supabase_admin|supabase_auth_admin/],
  ['server DB credentials env', /PAYESH_PG_(ADMIN|RUNTIME)|PAYESH_MIGRATE_URL|DATABASE_URL/],
  ['postgres url', /postgres(ql)?:\/\/[^'"\s]*@/],
];
function jwtLiterals(src) {
  const out = [];
  for (const m of src.matchAll(/eyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/g)) {
    let role = null;
    try { role = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')).role || null; } catch (e) { role = '?'; }
    if (role !== 'anon') out.push(`JWT literal with role ${role}`);
  }
  return out;
}
function scanText(rel, src) {
  const hits = [];
  let guard = false;
  src.split('\n').forEach((line, i) => {
    /* the refusal lists themselves: one marked line, or a marked begin/end block (counted below) */
    if (/key-guard-110-begin/.test(line)) { guard = true; return; }
    if (/key-guard-110-end/.test(line)) { guard = false; return; }
    if (guard || /key-guard-110/.test(line)) return;
    for (const [what, re] of SECRET_PATTERNS) if (re.test(line)) hits.push(`${rel}:${i + 1} ${what}`);
  });
  for (const j of jwtLiterals(src)) hits.push(`${rel}: ${j}`);
  return hits;
}
function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.dart_tool', 'build', 'coverage', 'test', 'goldens'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (SCAN_EXT.test(e.name)) out.push(p);
  }
  return out;
}

async function main() {
  console.log('\nRow 110: direct transport in the JS client (PAYESH_TRANSPORT=direct, default off) — transport ↔ provider\n');

  await check('TR-01', 'selection: unset / gateway / typo → Gateway (typo flagged); only "direct" turns the direct path on; direct without a provider is an error, never a silent fallback', async () => {
    eq(T.transportMode({}), { mode: 'gateway', requested: null, valid: true }, 'unset');
    eq(T.transportMode({ PAYESH_TRANSPORT: 'gateway' }).mode, 'gateway', 'gateway');
    eq(T.transportMode({ PAYESH_TRANSPORT: ' Direct ' }).mode, 'direct', 'direct (case/space)');
    eq(T.transportMode({ PAYESH_TRANSPORT: 'drect' }), { mode: 'gateway', requested: 'drect', valid: false }, 'typo');
    eq(T.DEFAULT_MODE, 'gateway', 'default');
    let factoryCalls = 0;
    const g = T.createTransport({ env: {}, api: async () => ({}), direct: () => { factoryCalls++; return {}; } });
    eq([g.mode, factoryCalls], ['gateway', 0], 'default mode never builds the direct path');
    await throwsCode(() => T.createTransport({ env: { PAYESH_TRANSPORT: 'direct' }, api: async () => ({}) }), 'direct_not_configured', 'direct w/o provider');
    /* layering: the transport module knows no URL, key or HTTP; the provider knows no sync protocol */
    const ts = fs.readFileSync(path.join(ROOT, 'client/transport.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const ps = fs.readFileSync(path.join(ROOT, 'client/provider-postgrest.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const w of ['fetch(', 'apikey', 'authorization', '/rest/v1', 'https:']) assert(!ts.includes(w), 'transport layer mentions ' + w);
    for (const w of ['outbox', 'convergence', 'sealRecord', 'drain']) assert(!ps.includes(w), 'provider layer mentions ' + w);
    return 'default gateway; direct only on request; layers independent';
  });

  await check('TR-02', 'provider: POST {url}/rest/v1/rpc/<fn>, named parameters, publishable key + user JWT, schema profile; allowlisted RPCs only; https (http only on loopback); no credentials in the URL', async () => {
    const seen = [];
    const fake = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, text: async () => '{"ok":true}' }; };
    const tok = jwt({ sub: 's', device_id: 'd', role: 'authenticated' });
    const pr = new P.PostgrestProvider({ url: 'https://proj.example.co/', clientKey: 'sb_publishable_abc', token: () => tok, fetch: fake });
    await pr.rpc('sync_push', [JSON.stringify([{ uid: 'u1' }]), null]);
    await pr.rpc('sync_pull', [5, '50', ['attendance']]);
    eq(seen[0].url, 'https://proj.example.co/rest/v1/rpc/sync_push', 'url');
    eq(JSON.parse(seen[0].init.body), { p_ops: [{ uid: 'u1' }], p_idem: null }, 'named args, jsonb as JSON');
    eq(JSON.parse(seen[1].init.body), { p_since: 5, p_limit: '50', p_collections: ['attendance'] }, 'pull args');
    const h = seen[0].init.headers;
    eq([h.apikey, h.authorization, h['content-profile'], h['accept-profile'], seen[0].init.method], ['sb_publishable_abc', 'Bearer ' + tok, 'payesh_direct', 'payesh_direct', 'POST'], 'headers');
    await throwsCode(pr.rpc('bootstrap_school', []), 'rpc_not_allowed', 'internal fn');
    await throwsCode(pr.rpc('create_user', []), 'rpc_not_allowed', 'admin fn');
    await throwsCode(pr.rpc('sync_resolve_conflict', [1, 'x', 3]), 'protocol', 'too many args');
    eq(seen.length, 2, 'refused calls never reach the network');
    for (const u of ['http://proj.example.co', 'https://u:p@proj.example.co', 'https://proj.example.co/?apikey=1', 'ftp://x', 'nope'])
      await throwsCode(() => new P.PostgrestProvider({ url: u, clientKey: 'sb_publishable_a', token: () => tok, fetch: fake }), 'bad_url', u);
    new P.PostgrestProvider({ url: 'http://127.0.0.1:9', clientKey: 'sb_publishable_a', token: () => tok, fetch: fake });
    return `${Object.keys(P.RPC_PARAMS).length} allowlisted RPCs; 5 bad urls refused`;
  });

  await check('TR-03', 'runtime refusal: secret key (sb_secret_…), service_role / supabase_admin / postgres JWTs, a non-anon JWT as client key, and a privileged token as the user token — all refused before any byte is sent', async () => {
    let net = 0;
    const fake = async () => { net++; return { ok: true, status: 200, text: async () => 'null' }; };
    const user = jwt({ sub: 's', device_id: 'd', role: 'authenticated' });
    const bad = { 'sb_secret_x1': 'service_key_forbidden', [jwt({ role: 'service_role' })]: 'service_key_forbidden', [jwt({ role: 'supabase_admin' })]: 'service_key_forbidden',
      [jwt({ role: 'postgres' })]: 'service_key_forbidden', [jwt({ role: 'authenticated' })]: 'client_key_must_be_anon', '': 'client_key_required' };
    for (const [k, code] of Object.entries(bad)) await throwsCode(() => new P.PostgrestProvider({ url: 'https://p.example', clientKey: k, token: () => user, fetch: fake }), code, 'client key ' + k.slice(0, 14));
    for (const k of ['sb_publishable_ok', jwt({ role: 'anon', iss: 'supabase' })]) new P.PostgrestProvider({ url: 'https://p.example', clientKey: k, token: () => user, fetch: fake });
    const pr = new P.PostgrestProvider({ url: 'https://p.example', clientKey: 'sb_publishable_ok', token: () => jwt({ role: 'service_role' }), fetch: fake });
    await throwsCode(pr.rpc('my_plan'), 'service_key_forbidden', 'privileged user token');
    const pr2 = new P.PostgrestProvider({ url: 'https://p.example', clientKey: 'sb_publishable_ok', token: () => 'not-a-jwt', fetch: fake });
    await throwsCode(pr2.rpc('my_plan'), 'auth', 'opaque user token');
    eq(net, 0, 'network calls');
    return `${Object.keys(bad).length + 2} privileged/invalid credentials refused, 0 requests sent`;
  });

  await check('TR-04', 'static: no service key / DB credential / privileged JWT anywhere in client code (client/**, native app + packages lib) — scanner proven by planted positive controls; the refusal lists are the only marked exceptions', async () => {
    const files = SCAN_ROOTS.flatMap(r => walk(path.join(ROOT, r), []));
    assert(files.length > 40, 'scan covers too few files: ' + files.length);
    assert(files.some(f => f.endsWith('provider-postgrest.js')) && files.some(f => f.endsWith('direct_transport.dart')), 'scan misses the direct transport sources');
    const hits = [];
    let markers = 0;
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      const rel = path.relative(ROOT, f);
      markers += (src.match(/key-guard-110/g) || []).length;
      hits.push(...scanText(rel, src));
    }
    eq(hits, [], 'secrets in client code');
    eq(markers, 4, 'marked refusal lists (2 JS lines + 1 Dart begin/end block)');
    /* positive controls: the scanner must catch each planted secret */
    const planted = {
      'sb_secret_': "const k = 'sb_secret_AbC123';",
      service_role: 'role: "service_role"',
      env: 'process.env.PAYESH_PG_ADMIN',
      url: "const u = 'postgres://postgres:pw@db.x.co:5432/postgres';",
      jwt: `const k = '${jwt({ role: 'service_role', iss: 'supabase' })}';`,
      dart: "final key = String.fromEnvironment('SUPABASE_SERVICE_ROLE_KEY');",
    };
    for (const [n, src] of Object.entries(planted)) assert(scanText('planted', src).length > 0, 'scanner misses planted ' + n);
    assert(scanText('ok', `const k = '${jwt({ role: 'anon' })}';`).length === 0, 'anon JWT is a public key');
    return `${files.length} files clean; ${Object.keys(planted).length} planted controls caught; ${markers} marked guard lines`;
  });

  await check('TR-05', 'Gateway mode unchanged: the outbox drains through gatewayTransport with exactly app.js\'s calls (POST /api/sync {ops}, GET /api/v1/pull?since=&since_id=); verdicts flow back unchanged', async () => {
    const calls = [];
    const api = async (p, o) => {
      calls.push([p, o.method || 'GET', o.body ? Object.keys(o.body) : null]);
      if (p === '/api/sync') return { ok: true, applied: o.body.ops.map(x => ({ uid: x.uid, id: x.id, version: 1 })), conflicts: [], rejected: [] };
      return { schema_version: 1, collections: {}, deleted: [], more: false };
    };
    const t = T.createTransport({ env: {}, api });
    const ob = await outbox.open(freshName('gw'));
    for (let i = 1; i <= 3; i++) await ob.enqueue({ collection: 'homework', type: 'put', id: i, data: { t: i } });
    const r = await ob.drain({ send: ops => t.push(ops) });
    await t.pullPage({ since: '2026-01-01T00:00:00Z', sinceId: 7 });
    eq([r.applied, (await ob.stats()).active], [3, 0], 'drained');
    eq(calls, [['/api/sync', 'POST', ['ops']], ['/api/v1/pull?since=2026-01-01T00%3A00%3A00Z&since_id=7', 'GET', null]], 'calls');
    const app = fs.readFileSync(path.join(ROOT, 'client/app.js'), 'utf8');
    assert(app.includes("api('/api/sync', { method: 'POST', body: { ops: batch }, noAuthRedirect: false })") && app.includes("api('/api/v1/pull?since=' + encodeURIComponent(since) + '&since_id=' + sinceId"), 'app.js gateway calls changed');
    ob.close();
    return 'same calls as client/app.js; npm test keeps the Gateway suite';
  });

  /* ── real PostgreSQL through a PostgREST-compatible emulator ── */
  const ADMIN = process.env.PAYESH_PG_ADMIN;
  if (!ADMIN) {
    if (process.env.TR110_REQUIRE_PG === '1') throw new Error('PAYESH_PG_ADMIN is required (TR110_REQUIRE_PG=1)');
    for (const id of ['TR-06', 'TR-07', 'TR-08']) await check(id, 'needs PostgreSQL (set PAYESH_PG_ADMIN)', async () => 'SKIP');
    return finish();
  }
  const e2e = require('../tools/e2e1.js');
  const { DirectSync } = require('../tools/direct-sync.js');
  const { Pool, Client } = require('pg');
  const DB = `payesh_t110_${process.pid}_${Date.now().toString(36)}`;
  const AUTH = 'payesh_t110_authenticator';
  const JWT_SECRET = crypto.randomBytes(32).toString('hex');
  const PUBLISHABLE = 'sb_publishable_' + crypto.randomBytes(12).toString('hex');
  const root = new Client({ connectionString: ADMIN }); root.on('error', () => {});
  await root.connect();
  await root.query(`CREATE DATABASE ${DB}`);
  await root.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${AUTH}') THEN
      CREATE ROLE ${AUTH} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF; END $$`);
  const u = new URL(ADMIN); u.pathname = '/' + DB;
  const DB_URL = u.toString();
  let admin = null, auth = null, server = null;
  const stats = { requests: 0, refused: 0 };
  try {
    const m = spawnSync(process.execPath, [path.join(ROOT, 'tools/migrate-86.mjs'), 'up', '--dir', 'db/migrations/direct'], { cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, { PAYESH_MIGRATE_URL: DB_URL }) });
    if (m.status !== 0) throw new Error('migrate: ' + m.stdout + m.stderr);
    admin = new Pool({ connectionString: DB_URL, max: 3 }); admin.on('error', () => {});
    await admin.query(`GRANT payesh_direct_client TO ${AUTH}`);
    const au = new URL(DB_URL); au.username = AUTH; au.password = '';
    auth = new Pool({ connectionString: au.toString(), max: 4 }); auth.on('error', () => {});

    /* PostgREST emulator: apikey gate, HS256 JWT, SET LOCAL ROLE + claims, named-arg RPC */
    const verify = t => {
      const [h, p, s] = String(t || '').split('.');
      if (!s || crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url') !== s) return null;
      const c = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
      return c.exp && c.exp < Date.now() / 1000 ? null : c;
    };
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', async () => {
        stats.requests++;
        const send = (st, j) => { if (st >= 400) stats.refused++; res.writeHead(st, { 'content-type': 'application/json' }); res.end(j === undefined ? '' : JSON.stringify(j)); };
        const mt = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(req.url);
        if (req.method !== 'POST' || !mt) return send(404, { message: 'not found' });
        if (req.headers.apikey !== PUBLISHABLE) return send(401, { message: 'Invalid API key' });
        const claims = verify(String(req.headers.authorization || '').replace(/^Bearer /, ''));
        if (!claims || claims.role !== 'authenticated') return send(401, { code: 'PGRST301', message: 'JWT invalid' });
        if (req.headers['content-profile'] !== 'payesh_direct') return send(406, { message: 'schema' });
        let args;
        try { args = body ? JSON.parse(body) : {}; } catch (e) { return send(400, { message: 'bad json' }); }
        const names = Object.keys(args);
        if (!names.every(n => /^p_[a-z_]+$/.test(n))) return send(400, { message: 'bad arg' });
        const c = await auth.connect();
        try {
          await c.query('BEGIN');
          await c.query('SET LOCAL ROLE payesh_direct_client');
          await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
          const vals = names.map(n => (n === 'p_ops' ? JSON.stringify(args[n]) : args[n]));
          const r = await c.query(`SELECT payesh_direct.${mt[1]}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) AS r`, vals);
          await c.query('COMMIT');
          send(200, r.rows[0].r);
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {});
          send(e.code === '42501' ? 403 : e.code === 'P0002' ? 404 : e.code && /^(22|23|54|P0|55)/.test(e.code) ? 400 : 500, { code: e.code, message: e.message, details: e.detail || null });
        } finally { c.release(); }
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const URL_BASE = `http://127.0.0.1:${server.address().port}`;
    const net = { down: false, sent: 0 };
    const fetchVia = async (url, init) => { if (net.down) throw new TypeError('fetch failed'); net.sent++; return fetch(url, init); };

    /* a school: manager device 1 (+ device 2) through bootstrap; keys through the provider */
    const t = crypto.randomUUID();
    const sub = 'sub-t110-' + t.slice(0, 8);
    const boot = (await admin.query('SELECT * FROM payesh_direct.bootstrap_school($1, $2, $3, $4)', [t, 'mgr', sub, 'phone 1'])).rows[0];
    const asMgr = async (sql, p) => {
      const c = await auth.connect();
      try { await c.query('BEGIN'); await c.query('SET LOCAL ROLE payesh_direct_client');
        await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub, device_id: boot.device_id })]);
        const r = await c.query(sql, p); await c.query('COMMIT'); return r.rows;
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    };
    const dev2id = (await asMgr('SELECT payesh_direct.enroll_device($1, $2) AS id', [boot.user_id, 'phone 2']))[0].id;
    const token = dev => () => jwt({ sub, device_id: dev, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 600 }, JWT_SECRET);
    const provider = dev => new P.PostgrestProvider({ url: URL_BASE, clientKey: PUBLISHABLE, token: token(dev), fetch: fetchVia });
    const smk = e2e.newSmk();
    const directory = new Map();
    const devs = [{ id: boot.device_id, kp: e2e.generateKeyPair() }, { id: dev2id, kp: e2e.generateKeyPair() }];
    for (const d of devs) { d.pr = provider(d.id); await d.pr.rpc('register_device_key', [e2e.b64u(d.kp.pub)]); }
    for (const sc of ['smk', 'school:attendance', 'school:homework', 'class:1:attendance']) {
      const k = e2e.deriveScopeKey(smk, t, sc, 1, 0);
      await devs[0].pr.rpc('publish_scope_key', [sc, 1, 0, e2e.b64u(k.pub)]);
      directory.set(sc, { kid: k.kid, pub: k.pub });
    }
    const smkKid = e2e.kidOf('smk', 1, 0);
    for (const d of devs) {
      await devs[0].pr.rpc('put_key_grant', [d.id, 'smk', 1, 0, e2e.sealGrant(d.kp.pub, t, d.id, smkKid, smk)]);
      d.ring = new e2e.Keyring(t);
      d.ring.addGrant(smkKid, smk);
      d.sync = new DirectSync({ tenant: t, call: (fn, a) => d.pr.rpc(fn, a), keyring: d.ring, directory });
      d.transport = T.createTransport({ env: { PAYESH_TRANSPORT: 'direct' }, direct: () => d.sync });
      d.outbox = await outbox.open(freshName('dev'));
      d.engine = await engineWeb.open(freshName('eng'));
    }
    const [D1, D2] = devs;

    await check('TR-06', 'offline unchanged over the direct path: ops queued offline survive a network outage (same uids, backoff), drain on reconnect, replay = duplicate; the other device pulls and decrypts into its engine', async () => {
      const ops = [
        { collection: 'attendance', type: 'put', id: 1, data: { class_id: 1, student_id: 10, status: 'present', note: 'a' } },
        { collection: 'attendance', type: 'put', id: 2, data: { class_id: 1, student_id: 11, status: 'absent' } },
        { collection: 'homework', type: 'put', id: 3, data: { title: 'ریاضی', due: '1405-09-01' } },
        { collection: 'homework', type: 'put', localId: -1, data: { title: 'no id' } },
      ];
      for (const o of ops) assert((await D1.outbox.enqueue(o)).ok, 'enqueue');
      net.down = true;
      const sentBefore = net.sent;
      const off = await D1.outbox.drain({ send: x => D1.transport.push(x), now: 1000 });
      const s1 = await D1.outbox.stats();
      eq([off.stopped, off.failed, s1.active, net.sent - sentBefore], ['network', 4, 4, 0], 'outage keeps every op');
      net.down = false;
      const rejected = [];
      const on = await D1.outbox.drain({ send: x => D1.transport.push(x), now: 10 * 60 * 1000 + 1000, onRejected: (r, v) => rejected.push(v.error) });
      eq([on.applied, on.rejected, (await D1.outbox.stats()).active], [3, 1, 0], 'reconnect drains');
      eq(rejected, ['direct_id_required'], 'op without an id is reported, not lost silently');
      /* replay of an acknowledged uid (app crashed before ack): duplicate, no second write */
      const first = (await D1.outbox.list({})).length;
      const uid = 'replay-' + crypto.randomUUID();
      await D1.outbox.enqueue({ k: uid, collection: 'homework', type: 'put', id: 4, data: { title: 'r' } });
      await D1.outbox.drain({ send: x => D1.transport.push(x), now: 20 * 60 * 1000 });
      await D1.outbox.enqueue({ k: uid, collection: 'homework', type: 'put', id: 4, data: { title: 'r' } });
      let dup = null;
      await D1.outbox.drain({ send: x => D1.transport.push(x), now: 21 * 60 * 1000, onApplied: (r, v) => { dup = v; } });
      eq([first, dup && dup.duplicate], [0, true], 'replay is a duplicate');
      const pulled = await D2.transport.pullInto(D2.engine);
      const r1 = await D2.engine.get('attendance', 1), h3 = await D2.engine.get('homework', 3);
      eq([pulled.rows, r1 && r1.data.status, r1 && r1.version, h3 && h3.data.title], [4, 'present', 1, 'ریاضی'], 'device 2 engine');
      const ver = (await admin.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE sealed LIKE 'e2e1.%')::int AS s FROM payesh_direct.record WHERE tenant_id = $1`, [t])).rows[0];
      eq([ver.n, ver.s], [4, 4], 'database holds ciphertext only');
      return `outage: 4 kept, 0 requests; reconnect: 3 applied + 1 reported; replay duplicate; device 2 pulled ${pulled.rows} rows`;
    });

    await check('TR-07', 'two devices, offline edits on the same record through the same outbox: manual field on both sides → conflict (both versions kept); auto fields on both sides → merged on the device into one new version; nothing lost', async () => {
      await D1.transport.pullInto(D1.engine);
      /* D2 edits status (manual), D1 edits note offline on the same base */
      await D2.outbox.enqueue({ collection: 'attendance', type: 'put', id: 1, base_version: 1, data: { class_id: 1, student_id: 10, status: 'late' } });
      await D1.outbox.enqueue({ collection: 'attendance', type: 'put', id: 1, base_version: 1, data: { class_id: 1, student_id: 10, status: 'excused' } });
      const a = await D2.outbox.drain({ send: x => D2.transport.push(x) });
      const conflicts = [];
      const b = await D1.outbox.drain({ send: x => D1.transport.push(x), onConflict: (r, v) => conflicts.push(v) });
      eq([a.applied, b.applied + b.conflicts, (await D1.outbox.stats()).active, (await D2.outbox.stats()).active], [1, 1, 0, 0], 'every op got a verdict');
      const c = (await admin.query('SELECT count(*)::int AS n FROM payesh_direct.sync_conflict WHERE tenant_id = $1', [t])).rows[0].n;
      eq(c, b.conflicts, 'conflicts recorded in the database');
      await D1.transport.pullInto(D1.engine);
      const r = await D1.engine.get('attendance', 1);
      assert(r && r.version >= 2, 'device 1 sees the newer version');
      eq(b.conflicts, 1, 'manual field (status) on both sides → conflict');
      /* auto fields on both sides of record 2 → merged on the device, one new version with both */
      await D2.outbox.enqueue({ collection: 'attendance', type: 'put', id: 2, base_version: 1, data: { note: 'از دستگاه ۲' } });
      await D1.outbox.enqueue({ collection: 'attendance', type: 'put', id: 2, base_version: 1, data: { arrival_time: '08:05' } });
      eq((await D2.outbox.drain({ send: x => D2.transport.push(x) })).applied, 1, 'd2 auto edit');
      const mr = await D1.outbox.drain({ send: x => D1.transport.push(x) });
      eq([mr.applied, mr.conflicts], [1, 0], 'auto edits merge');
      await D2.transport.pullInto(D2.engine);
      const m2 = await D2.engine.get('attendance', 2);
      eq([m2.version, m2.data.note, m2.data.arrival_time, m2.data.status], [3, 'از دستگاه ۲', '08:05', 'absent'], 'merged document');
      return `manual: D2 applied, D1 conflict (both versions kept); auto: merged on the device (v3 has both edits); ${D1.sync.stats.stale} stale rounds, ${D1.sync.stats.merged} merge`;
    });

    await check('TR-08', 'the provider over HTTP: wrong publishable key → 401 auth, forged JWT → 401, a privileged token never leaves the device, the database\'s own refusals arrive as SQLSTATE (42501, 54000)', async () => {
      const wrong = new P.PostgrestProvider({ url: URL_BASE, clientKey: 'sb_publishable_wrong', token: token(D1.id), fetch: fetchVia });
      await throwsCode(wrong.rpc('my_plan'), 'auth', 'wrong client key');
      const forged = new P.PostgrestProvider({ url: URL_BASE, clientKey: PUBLISHABLE, token: () => jwt({ sub, device_id: D1.id, role: 'authenticated' }, 'not-the-secret'), fetch: fetchVia });
      await throwsCode(forged.rpc('my_plan'), 'auth', 'forged jwt');
      const before = stats.requests;
      const priv = new P.PostgrestProvider({ url: URL_BASE, clientKey: PUBLISHABLE, token: () => jwt({ role: 'service_role' }, JWT_SECRET), fetch: fetchVia });
      await throwsCode(priv.rpc('my_plan'), 'service_key_forbidden', 'privileged token');
      eq(stats.requests, before, 'privileged token sent');
      try { await D1.pr.rpc('sync_resolve_conflict', [999999, 'server']); throw new Error('no error'); } catch (e) { assert(e.sqlstate === 'P0002' && e.code === 'db', 'unknown conflict → P0002: ' + e.code + ' ' + e.sqlstate); }
      await admin.query('INSERT INTO payesh_direct.tenant_plan (tenant_id, max_ops_per_push) VALUES ($1, 1)', [t]);
      const big = [5, 6].map(id => ({ uid: crypto.randomUUID(), collection: 'homework', id, type: 'put', base_version: 0, data: { title: 'x' } }));
      try { await D1.transport.push(big); throw new Error('no error'); } catch (e) { eq([e.code, e.sqlstate], ['plan_limit', '54000'], 'plan cap'); }
      await admin.query('DELETE FROM payesh_direct.tenant_plan WHERE tenant_id = $1', [t]);
      return `emulator served ${stats.requests} requests (${stats.refused} refused)`;
    });
    for (const d of devs) { d.outbox.close(); try { d.engine.db.close(); } catch (e) { /* noop */ } }
  } finally {
    if (server) await new Promise(r => server.close(r));
    if (auth) await auth.end().catch(() => {});
    if (admin) await admin.end().catch(() => {});
    await root.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
    await root.end().catch(() => {});
  }
  return finish();
}
function finish() {
  console.log(`\n# passed=${passed} failed=${failed} skipped=${skipped}`);
  console.log(failed ? `TRANSPORT-110-FAIL ${failures.join(',')}` : 'TRANSPORT-110-OK');
  return { passed, failed, skipped, failures };
}

if (require.main === module) {
  main().then(r => { if (r.failed) process.exit(1); }).catch(e => { console.error(e); process.exit(1); });
}
module.exports = { main, scanText };
