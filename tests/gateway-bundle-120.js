#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 120 — multi-tenant Gateway bundle: build, preflight, admin CLI,
   selfcheck. Label [S] (sandbox/CI). Real host = [M], NOT RUN here (row 116).

   Static part (npm test, no database):
     GB-01  build: closure has gateway + platform API, no single-school file,
            deps = pg tree without pg-cloudflare, manifest sha256 of every file
     GB-02  env vars come from the code: scan == env-catalog.json (0 missing,
            0 stale); negative controls: a new process.env.X / a stale entry
     GB-03  secret scan: built bundle clean; negative controls: credentialed URL,
            .env file, private key, filled secret in gateway.env.example; a
            <placeholder> is NOT flagged (positive control)
     GB-04  guard refusals: single-school file, dynamic require, extra npm
            module, cloudflare package
     GB-05  preflight (pure): missing/weak/reused secrets, same DB principal,
            half-configured platform, Node 20, field-crypto, unknown-var warning
     GB-06  extracted bundle, empty env: gateway-start.cjs --check ⇒ exit 2
     GB-07  SCRAM-SHA-256 verifier accepted by pg's own SASL client code
            (wrong password ⇒ proof mismatch)
     GB-08  selfcheck vs stub servers: honest ⇒ OK; leaky isolation, Cloudflare
            header, leaked tenant context, forged token accepted, 503 platform ⇒
            FAILED; transport verdicts
     GB-09  owner doc (Persian, every command, [S]/[M], D-09/D-40) + no secret
     GB-10  mutants: each reverted control turns its check red
   PostgreSQL part (PAYESH_PG_ADMIN + PAYESH_PG_RUNTIME; CI api-contract,
   T120_REQUIRE_PG=1 ⇒ missing PG is a failure):
     GB-E1  bundle extracted OUTSIDE the repo resolves pg from its own node_modules
     GB-E2  admin migrate on a fresh DB, idempotent rerun, tampered migration refused
     GB-E3  admin logins: weak/equal passwords refused; SCRAM verifier stored; no
            password in output; check OK afterwards (FAIL before)
     GB-E4  preflight against the DB: superuser PGURL ⇒ exit 3 (and a mutant
            without that control would accept it); runtime principals ⇒ OK;
            closed port ⇒ exit 3
     GB-E5  create-owner → owner logs in with password + TOTP → plan → two schools
     GB-E6  bundled selfcheck with both schools ⇒ OK (activation, write/read,
            isolation, cleanup); codes never printed; reused codes ⇒ FAILED
     GB-E7  SIGTERM ⇒ drain, exit 0; owner-panel local-up ledger is shared
   ═══════════════════════════════════════════════════════════════════ */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'scripts/build-gateway-bundle.mjs');
const SELF = path.join(ROOT, 'deploy/gateway/selfcheck.mjs');
const START = path.join(ROOT, 'deploy/gateway/start.cjs');
const ADMIN = path.join(ROOT, 'deploy/gateway/admin.cjs');
const DOC = path.join(ROOT, 'docs/cloud/120-gateway-bundle.md');
const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy/gateway/env-catalog.json'), 'utf8'));

let passed = 0, failed = 0, negatives = 0, quiet = false, blocked = false;
const failures = [];
const tmpDirs = [];
const say = (...a) => { if (!quiet) console.log(...a); };
async function check(id, desc, fn) {
  try { const d = await fn(); passed++; say(`PASS  ${id}  ${desc}${d ? '  → ' + d : ''}`); }
  catch (e) { failed++; failures.push(id); console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.stack) || e).replace(/\s+/g, ' ').slice(0, 500)}`); }
}
function neg(label, cond) { assert.ok(cond, 'negative control: ' + label); negatives++; }
function tmp(prefix) {
  const base = fs.existsSync('/work/tmp') ? '/work/tmp' : os.tmpdir();
  const d = fs.mkdtempSync(path.join(base, prefix)); tmpDirs.push(d); return d;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer(); s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const cleanEnv = (extra = {}) => {
  const e = { PATH: process.env.PATH, HOME: process.env.HOME || os.tmpdir(), LANG: 'C.UTF-8' };
  return Object.assign(e, extra);
};

/* ── stub Gateway for selfcheck logic (no database) ─────────────────── */
function stubGateway(flaw = {}) {
  const store = { A: [], B: [] };
  const tokens = new Map();
  let seq = 0;
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = '';
    for await (const ch of req) body += ch;
    const send = (st, obj, h = {}) => {
      const headers = Object.assign({ 'content-type': 'application/json' }, h);
      if (flaw.cloudflare) headers['cf-ray'] = '8a1b2c3d4e5f-FRA';
      res.writeHead(st, headers); res.end(JSON.stringify(obj));
    };
    const auth = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (u.pathname === '/healthz') return send(200, { ok: true, instance: 'stub' });
    if (u.pathname === '/readyz') return send(200, { ok: true, tenant_scoped: true, leaked_after_commit: !!flaw.leakCtx });
    if (u.pathname === '/api/platform/v1/dashboard') return send(flaw.platformOff ? 503 : 401, { ok: false });
    if (u.pathname === '/api/gw/v1/session/activate') {
      const b = JSON.parse(body || '{}');
      const k = b.school === 'stub-a' ? 'A' : b.school === 'stub-b' ? 'B' : null;
      if (!k || b.code !== 'CODE' + k) return send(401, { ok: false, error: 'activation_failed' });
      const t = 'tok-' + k + '-' + crypto.randomBytes(4).toString('hex'); tokens.set(t, k);
      return send(200, { ok: true, token: t, role: 'manager' });
    }
    const k = tokens.get(auth);
    if (!k) {
      if (flaw.acceptForged && auth.startsWith('v1.')) return send(200, { ok: true, rows: [], more: false });
      return send(401, { ok: false, error: 'unauthorized' });
    }
    if (u.pathname === '/api/gw/v1/push') {
      const ops = JSON.parse(body).ops;
      for (const op of ops) {
        if (op.type === 'del') store[k] = store[k].filter(r => r.id !== op.id);
        else { const row = { seq: ++seq, collection: op.collection, id: op.id, data: op.data }; store[k].push(row); if (flaw.leakRows) store[k === 'A' ? 'B' : 'A'].push(row); }
      }
      return send(200, { ok: true, applied: ops.map(o => ({ uid: o.uid, id: o.id })) });
    }
    if (u.pathname === '/api/gw/v1/pull') return send(200, { ok: true, rows: store[k], more: false, next_seq: seq });
    return send(404, { ok: false });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, base: 'http://127.0.0.1:' + srv.address().port })));
}
async function selfcheckAgainst(sc, flaw, withCodes = true) {
  const { srv, base } = await stubGateway(flaw);
  try {
    const opts = { base, school: '', code: '', school2: '', code2: '', timeoutMs: 5000 };
    if (withCodes) Object.assign(opts, { school: 'stub-a', code: 'CODEA', school2: 'stub-b', code2: 'CODEB' });
    return await sc.run(opts, { log: () => {} });
  } finally { srv.close(); }
}

/* ── suites (also used by the mutants) ──────────────────────────────── */
function suitePreflight(start) {
  const good = { PGURL: 'postgres://payesh_runtime@db.local:5432/p?sslmode=require', GW_SECRET: 'a'.repeat(40),
    PAYESH_PLATFORM_PGURL: 'postgres://payesh_platform_login@db.local:5432/p?sslmode=require', PAYESH_PLATFORM_TOKEN_SECRET: 'b'.repeat(40),
    PAYESH_METRICS_TOKEN: 'm'.repeat(32) };
  const codes = (env, o) => start.preflight(env, Object.assign({ nodeVersion: '22.11.0' }, o)).errors.map(e => e.code);
  assert.deepStrictEqual(codes(good), [], 'good config has no errors');
  assert.deepStrictEqual(start.preflight(good, { nodeVersion: '22.11.0' }).warnings, [], 'good config has no warnings');
  assert.ok(codes({}).includes('pgurl_missing') && codes({}).includes('gw_secret_missing'), 'empty env');
  assert.ok(codes(Object.assign({}, good, { GW_SECRET: 'short-secret-16ch' })).includes('gw_secret_weak'), 'weak secret');
  assert.ok(codes(Object.assign({}, good, { PAYESH_PLATFORM_PGURL: good.PGURL })).includes('platform_same_principal'), 'same principal');
  assert.ok(codes(Object.assign({}, good, { PAYESH_PLATFORM_TOKEN_SECRET: good.GW_SECRET })).includes('platform_secret_reused'), 'reused secret');
  assert.ok(codes(Object.assign({}, good, { PAYESH_PLATFORM_PGURL: '' })).includes('platform_pgurl_missing'), 'half platform');
  assert.ok(codes(Object.assign({}, good, { PAYESH_PLATFORM_TOKEN_SECRET: '' })).includes('platform_secret_missing'), 'half platform 2');
  assert.ok(codes(good, { nodeVersion: '20.19.0' }).includes('node_version'), 'node 20');
  assert.ok(codes(Object.assign({}, good, { PAYESH_FIELD_CRYPTO: 'required' })).includes('field_keys_missing'), 'field crypto');
  assert.ok(codes(Object.assign({}, good, { PGURL: 'mysql://x@y/z' })).includes('pgurl_invalid'), 'invalid url');
  const w = start.preflight(Object.assign({}, good, { PAYESH_PGURL: 'typo', PGURL: 'postgres://u@db.remote:5432/p' }), { nodeVersion: '22.11.0' }).warnings.map(x => x.code);
  assert.ok(w.includes('unknown_var') && w.includes('db_no_tls'), 'warnings: ' + w.join(','));
  const off = start.preflight(Object.assign({}, good, { PAYESH_PLATFORM_PGURL: '', PAYESH_PLATFORM_TOKEN_SECRET: '' }), { nodeVersion: '22.11.0' });
  assert.ok(off.errors.length === 0 && off.warnings.some(x => x.code === 'platform_off'), 'platform off = warning only');
  return '13 cases';
}

async function suiteScram(admin) {
  const sasl = require(require.resolve('pg/lib/crypto/sasl.js', { paths: [ROOT] }));
  const pw = 'correct horse battery staple 120';
  const v = admin.scramVerifier(pw);
  const m = v.match(/^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/);
  assert.ok(m, 'verifier shape');
  const [iter, saltB64, storedB64, serverB64] = [Number(m[1]), m[2], m[3], m[4]];
  const exchange = async (password) => {
    const s = sasl.startSession(['SCRAM-SHA-256']);
    const serverFirst = `r=${s.clientNonce}${crypto.randomBytes(12).toString('base64')},s=${saltB64},i=${iter}`;
    await sasl.continueSession(s, password, serverFirst);
    const final = s.response;
    const proof = Buffer.from(final.match(/,p=(.+)$/)[1], 'base64');
    const auth = `n=*,r=${s.clientNonce},${serverFirst},${final.replace(/,p=.+$/, '')}`;
    const sig = crypto.createHmac('sha256', Buffer.from(storedB64, 'base64')).update(auth).digest();
    const clientKey = Buffer.from(proof.map((b, i) => b ^ sig[i]));
    const okClient = crypto.createHash('sha256').update(clientKey).digest('base64') === storedB64;
    const serverSig = crypto.createHmac('sha256', Buffer.from(serverB64, 'base64')).update(auth).digest('base64');
    let okServer = true;
    try { sasl.finalizeSession(s, 'v=' + serverSig); } catch (e) { okServer = false; }
    return { okClient, okServer };
  };
  const good = await exchange(pw);
  assert.ok(good.okClient, 'server-side check of the client proof with StoredKey');
  assert.ok(good.okServer, 'client-side check of the server signature with ServerKey');
  const bad = await exchange(pw + 'x');
  neg('wrong password ⇒ proof does not match StoredKey', !bad.okClient && !bad.okServer);
  neg('two verifiers of one password use different salts', admin.scramVerifier(pw) !== v);
  return `iterations=${iter}`;
}

async function suiteSelfcheck(sc) {
  assert.strictEqual(sc.transportVerdict('https://api.example.ir'), 'pass');
  assert.strictEqual(sc.transportVerdict('http://127.0.0.1:5660'), 'warn');
  assert.strictEqual(sc.transportVerdict('http://api.example.ir'), 'fail');
  assert.strictEqual(sc.transportVerdict('http://10.0.0.5:5660'), 'fail');
  const H = (o) => new Headers(o);
  assert.ok(sc.isCloudflare(H({ 'cf-ray': 'x' })) && sc.isCloudflare(H({ server: 'cloudflare' })) && !sc.isCloudflare(H({ server: 'nginx' })));
  const honest = await selfcheckAgainst(sc, {});
  assert.ok(honest.ok, 'honest stub: ' + honest.lines.filter(l => !l.startsWith('PASS')).join(' | '));
  assert.ok(['S09', 'S10', 'S11', 'S12'].every(id => honest.lines.some(l => l.startsWith('PASS') && l.includes(id))), 'full flow passed');
  const noCodes = await selfcheckAgainst(sc, {}, false);
  assert.ok(noCodes.ok && noCodes.skip === 1 && noCodes.lines.some(l => /^SKIP\s+S09/.test(l)) && !noCodes.lines.some(l => /^PASS\s+S(09|10|11)/.test(l)), 'without codes: activation/isolation skipped, never passed');
  const cases = [['leakRows', 'S11'], ['cloudflare', 'S07'], ['leakCtx', 'S02'], ['acceptForged', 'S04'], ['platformOff', 'S05']];
  for (const [flaw, id] of cases) {
    const r = await selfcheckAgainst(sc, { [flaw]: true });
    neg(`${flaw} ⇒ FAILED at ${id}`, !r.ok && r.lines.some(l => l.startsWith('FAIL') && l.includes(id)));
  }
  return `honest OK, ${cases.length} flawed stubs FAILED`;
}

async function suiteGuard(b) {
  const cl = b.closure();
  const deps = b.prodDeps('pg');
  assert.deepStrictEqual(b.guard(cl, deps, CATALOG, ROOT), [], 'real closure passes the guard');
  const bad = (mut) => b.guard(Object.assign({}, cl, mut.cl || {}), mut.deps || deps, CATALOG, ROOT);
  neg('single-school file', bad({ cl: { files: cl.files.concat(['server/index.js']) } }).some(p => p.includes('single-school')));
  neg('dynamic require', bad({ cl: { dynamic: ['server/gateway.js: name'] } }).some(p => p.includes('dynamic')));
  neg('extra npm module', bad({ cl: { external: cl.external.concat(['left-pad']) } }).some(p => p.includes('left-pad')));
  neg('cloudflare package', bad({ deps: deps.concat(['node_modules/pg-cloudflare']) }).some(p => p.includes('cloudflare')));
  return `${cl.files.length} files, deps ${deps.length}`;
}

function suiteSecrets(b, stage) {
  assert.deepStrictEqual(b.scanSecrets(stage, CATALOG), [], 'built bundle has no secret-like content');
  const d = tmp('gb120-sec-');
  const plant = (name, text) => { const dd = fs.mkdtempSync(path.join(d, 'c')); fs.writeFileSync(path.join(dd, name), text); return b.scanSecrets(dd, CATALOG); };
  neg('credentialed DB URL', plant('x.js', "const u = 'postgres://payesh_runtime:hunter2-not-a-template@db/p';").some(f => f.kind === 'db_url_with_password'));
  neg('.env file', plant('.env', 'A=1').some(f => f.kind === 'secret_file_name'));
  neg('private key', plant('k.txt', '-----BEGIN PRIVATE ' + 'KEY-----\nMIIB\n').some(f => f.kind === 'private_key'));
  neg('filled secret in env example', plant('gateway.env.example', 'GW_SECRET=abc123\n').some(f => f.kind === 'secret_value:GW_SECRET'));
  neg('otpauth with secret', plant('o.txt', 'otpauth://totp/Payesh:o?secret=JBSWY3DPEHPK3PXPJBSWY3DP').some(f => f.kind === 'otpauth_secret'));
  assert.deepStrictEqual(plant('gateway.env.example', 'GW_SECRET=<gw_secret>\nPGURL=postgres://payesh_runtime:<PASSWORD>@db/p\n'), [], 'templates are not flagged');
  return '5 planted secrets caught, templates clean';
}

const MUTANTS = [
  ['preflight: weak secret accepted', 'start', s => s.replace('secret.length < MIN_SECRET', 'secret.length < 1')],
  ['preflight: same DB principal accepted', 'start', s => s.replace('else if (pg && ppg === pg)', 'else if (false)')],
  ['preflight: reused platform secret accepted', 'start', s => s.replace('else if (psec === secret)', 'else if (false)')],
  ['selfcheck: isolation leak ignored', 'self', s => s.replace('if (leaked.length) throw', 'if (false) throw')],
  ['selfcheck: Cloudflare not detected', 'self', s => s.replace("return headers.has('cf-ray')", "return false && headers.has('cf-ray')")],
  ['selfcheck: leaked tenant context ignored', 'self', s => s.replace("d.leaked_after_commit !== false", 'false')],
  ['selfcheck: forged token accepted', 'self', s => s.replace("if (r.status !== 401) throw new Error('expected 401, got ' + r.status);\n    line('PASS', 'S04'", "if (false) throw new Error('');\n    line('PASS', 'S04'")],
  ['selfcheck: plain http to a public host passes', 'self', s => s.replace("return 'fail';\n}", "return 'warn';\n}")],
  ['scram: client/server keys swapped', 'admin', s => s.replace("update('Server Key')", "update('Client Key')")],
  ['guard: cloudflare package allowed', 'build', s => s.replace("if (/cloudflare/i.test(d)) problems.push", 'if (false) problems.push')],
  ['secrets: credentialed URL pattern removed', 'build', s => s.replace("['db_url_with_password', /postgres", "['db_url_with_password', /NEVERMATCH/, /postgres")],
];

async function loadMutant(kind, src, dir, i) {
  if (kind === 'start') {
    const d = fs.mkdtempSync(path.join(dir, 's')); fs.copyFileSync(path.join(ROOT, 'deploy/gateway/env-catalog.json'), path.join(d, 'env-catalog.json'));
    const f = path.join(d, 'start.cjs'); fs.writeFileSync(f, src); return require(f);
  }
  if (kind === 'admin') { const f = path.join(dir, 'admin' + i + '.cjs'); fs.writeFileSync(f, src); return require(f); }
  const f = path.join(dir, kind + i + '.mjs'); fs.writeFileSync(f, src); return import(pathToFileURL(f).href);
}
async function runSuiteFor(kind, mod, ctx) {
  if (kind === 'start') return suitePreflight(mod);
  if (kind === 'self') return suiteSelfcheck(mod);
  if (kind === 'admin') return suiteScram(mod);
  /* build: guard + secret scan with the mutated module (ROOT passed explicitly) */
  await suiteGuard(mod);
  return suiteSecrets(mod, ctx.stage);
}

/* ── PostgreSQL end-to-end ─────────────────────────────────────────── */
function withDb(url, db, user) { const u = new URL(url); u.pathname = '/' + db; if (user) { u.username = user; u.password = ''; } return u.toString(); }
function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8', timeout: 120000 }, opts));
  return { status: r.status, out: String(r.stdout || ''), err: String(r.stderr || ''), all: String(r.stdout || '') + String(r.stderr || '') };
}

async function pgPart(ctx) {
  const ADMIN_URL = process.env.PAYESH_PG_ADMIN || '';
  const RUNTIME_URL = process.env.PAYESH_PG_RUNTIME || '';
  if (!ADMIN_URL || !RUNTIME_URL) {
    if (process.env.T120_REQUIRE_PG === '1') { failed++; failures.push('GB-E*'); console.log('FAIL  GB-E*  PAYESH_PG_ADMIN/RUNTIME required (T120_REQUIRE_PG=1)'); }
    else { blocked = true; say('BLOCKED  GB-E1..E7  PostgreSQL part NOT RUN (PAYESH_PG_ADMIN/PAYESH_PG_RUNTIME unset; CI api-contract runs it)'); }
    return;
  }
  const { Client } = require('pg');
  const auth = require(path.join(ROOT, 'apps/owner-panel/server/owner-auth.js'));
  const DB = 'payesh_gb120_' + crypto.randomBytes(4).toString('hex');
  const DB2 = DB + '_lu';
  const root = new Client({ connectionString: ADMIN_URL });
  await root.connect();
  await root.query(`CREATE DATABASE ${DB}`);
  await root.query(`CREATE DATABASE ${DB2}`);
  const adminUrl = withDb(ADMIN_URL, DB);
  const dir = tmp('gb120-e2e-');
  const B = path.join(dir, 'payesh-gateway');
  const secrets = { gw: crypto.randomBytes(24).toString('base64url'), pl: crypto.randomBytes(24).toString('base64url'),
    rt: crypto.randomBytes(18).toString('base64url'), plg: crypto.randomBytes(18).toString('base64url'), op: 'Owner-pass-' + crypto.randomBytes(6).toString('hex') };
  const runtimeUrl = withDb(RUNTIME_URL, DB);
  const platformUrl = withDb(ADMIN_URL, DB, 'payesh_platform_login');
  const gwEnv = (port, extra = {}) => cleanEnv(Object.assign({ PORT: String(port), HOST: '127.0.0.1', PGURL: runtimeUrl, GW_SECRET: secrets.gw,
    PAYESH_PLATFORM_PGURL: platformUrl, PAYESH_PLATFORM_TOKEN_SECRET: secrets.pl, PAYESH_METRICS_TOKEN: 'metrics-' + secrets.gw,
    GW_QUOTA_MAX: '100000', PAYESH_LOG: '0', GW_ACCESS_LOG: '0', GW_INSTANCE: 'gb120' }, extra));
  const nodeIn = (args, env) => run(process.execPath, args, { cwd: B, env });
  let gw = null;
  try {
    await check('GB-E1', 'bundle extracted outside the repo resolves pg from its own node_modules', () => {
      const t = run('tar', ['-xzf', ctx.archive, '-C', dir]);
      assert.strictEqual(t.status, 0, t.err);
      assert.ok(!path.resolve(B).startsWith(ROOT + path.sep), 'extraction dir is outside the repository');
      const r = nodeIn(['-e', "process.stdout.write(require.resolve('pg'))"], cleanEnv());
      assert.strictEqual(r.status, 0, r.err);
      assert.ok(r.out.startsWith(path.join(B, 'node_modules', 'pg')), 'resolved ' + r.out);
      neg('pg-cloudflare is not in the bundle', !fs.existsSync(path.join(B, 'node_modules', 'pg-cloudflare')));
      return 'pg → bundle/node_modules';
    });

    await check('GB-E2', 'admin migrate: fresh DB, idempotent rerun, tampered migration refused', () => {
      const env = cleanEnv({ PAYESH_PG_ADMIN: adminUrl });
      const a = nodeIn(['deploy/gateway/admin.cjs', 'migrate'], env);
      assert.strictEqual(a.status, 0, a.all);
      const ev = a.out.split('\n').filter(Boolean).filter(l => l.startsWith('{')).map(l => JSON.parse(l)).find(x => x.event === 'owner_panel_migrated');
      const files = fs.readdirSync(path.join(B, 'db/migrations/owner-panel')).filter(f => /\.up\.sql$/.test(f));
      assert.strictEqual(ev.applied.length, files.length, 'all owner-panel migrations applied');
      const b2 = nodeIn(['deploy/gateway/admin.cjs', 'migrate'], env);
      assert.strictEqual(b2.status, 0, b2.all);
      const ev2 = b2.out.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l)).find(x => x.event === 'owner_panel_migrated');
      assert.deepStrictEqual([ev2.applied.length, ev2.skipped.length], [0, files.length], 'rerun applies nothing');
      const f1 = path.join(B, 'db/migrations/owner-panel', files[0]);
      const orig = fs.readFileSync(f1, 'utf8');
      fs.writeFileSync(f1, orig.replace(/^BEGIN;/m, 'BEGIN; -- tampered'));
      const c = nodeIn(['deploy/gateway/admin.cjs', 'migrate'], env);
      fs.writeFileSync(f1, orig);
      neg('changed applied migration ⇒ refused', c.status === 1 && c.err.includes('migration_checksum_mismatch'));
      return `${files.length} migrations, rerun 0 applied`;
    });

    await check('GB-E3', 'admin logins: refusals, SCRAM verifier stored, no password printed, check FAIL→OK', async () => {
      const env = (o) => cleanEnv(Object.assign({ PAYESH_PG_ADMIN: adminUrl }, o));
      /* roles are cluster-wide: forget a platform login left by an earlier local run */
      try { await root.query('DROP ROLE IF EXISTS payesh_platform_login'); } catch (e) { /* still granted elsewhere */ }
      const before = nodeIn(['deploy/gateway/admin.cjs', 'check'], env({}));
      neg('check before logins ⇒ FAILED (platform login missing)', before.status === 1 && /FAIL\s+role_exists:payesh_platform_login/.test(before.out));
      const weak = nodeIn(['deploy/gateway/admin.cjs', 'logins'], env({ PAYESH_RUNTIME_PASSWORD: 'short', PAYESH_PLATFORM_LOGIN_PASSWORD: secrets.plg }));
      neg('weak password refused', weak.status === 1 && weak.err.includes('weak_password'));
      const same = nodeIn(['deploy/gateway/admin.cjs', 'logins'], env({ PAYESH_RUNTIME_PASSWORD: secrets.rt, PAYESH_PLATFORM_LOGIN_PASSWORD: secrets.rt }));
      neg('equal passwords refused', same.status === 1 && same.err.includes('password_reused'));
      const ok = nodeIn(['deploy/gateway/admin.cjs', 'logins'], env({ PAYESH_RUNTIME_PASSWORD: secrets.rt, PAYESH_PLATFORM_LOGIN_PASSWORD: secrets.plg }));
      assert.strictEqual(ok.status, 0, ok.all);
      assert.ok(!ok.all.includes(secrets.rt) && !ok.all.includes(secrets.plg), 'no password in output');
      assert.ok(ok.out.includes('payesh_runtime:<PASSWORD>@') && ok.out.includes('payesh_platform_login:<PASSWORD>@'), 'url templates');
      const a = new Client({ connectionString: adminUrl }); await a.connect();
      try {
        const r = await a.query(`select rolname, rolpassword, rolsuper, rolbypassrls from pg_authid where rolname = any($1) order by 1`, [['payesh_platform_login', 'payesh_runtime']]);
        assert.strictEqual(r.rows.length, 2);
        for (const row of r.rows) {
          assert.ok(/^SCRAM-SHA-256\$4096:/.test(row.rolpassword || ''), row.rolname + ' stored as SCRAM verifier');
          assert.ok(!row.rolsuper && !row.rolbypassrls, row.rolname + ' has no bypass');
        }
      } finally { await a.end(); }
      const after = nodeIn(['deploy/gateway/admin.cjs', 'check'], env({}));
      assert.strictEqual(after.status, 0, after.out);
      return after.out.trim().split('\n').pop();
    });

    await check('GB-E4', 'preflight against the DB: superuser refused (exit 3), runtime principals OK, closed port refused', async () => {
      const su = nodeIn(['gateway-start.cjs', '--check'], gwEnv(1, { PGURL: adminUrl }));
      neg('superuser PGURL ⇒ exit 3 role_bypasses_rls', su.status === 3 && su.err.includes('role_bypasses_rls'));
      /* the same check with the control reverted accepts the superuser — the probe discriminates */
      const mdir = fs.mkdtempSync(path.join(dir, 'mut'));
      fs.cpSync(B, mdir, { recursive: true });
      const sp = path.join(mdir, 'deploy/gateway/start.cjs');
      const msrc = fs.readFileSync(sp, 'utf8').replace('if (row.rolsuper || row.rolbypassrls) {', 'if (false) {');
      assert.notStrictEqual(msrc, fs.readFileSync(sp, 'utf8'), 'mutation applied');
      fs.writeFileSync(sp, msrc);
      const mu = run(process.execPath, ['gateway-start.cjs', '--check'], { cwd: mdir, env: gwEnv(1, { PGURL: adminUrl }) });
      neg('mutant without the bypass check accepts the superuser (exit 0)', mu.status === 0);
      const ok = nodeIn(['gateway-start.cjs', '--check'], gwEnv(1));
      assert.strictEqual(ok.status, 0, ok.all);
      assert.ok(ok.out.includes('GW-PREFLIGHT OK'));
      assert.ok(!ok.all.includes(secrets.gw) && !ok.all.includes(secrets.pl), 'no secret in preflight output');
      const dead = nodeIn(['gateway-start.cjs', '--check'], gwEnv(1, { PGURL: 'postgres://payesh_runtime@127.0.0.1:1/' + DB }));
      neg('unreachable DB ⇒ exit 3 db_unreachable', dead.status === 3 && dead.err.includes('db_unreachable'));
      return 'superuser 3, mutant 0, runtime 0, dead 3';
    });

    let codes = null;
    await check('GB-E5', 'create-owner → owner login (password + TOTP) → plan → two schools with one-time codes', async () => {
      const co = nodeIn(['deploy/gateway/admin.cjs', 'create-owner', '--login-id', 'owner-120'],
        cleanEnv({ PAYESH_PG_ADMIN: adminUrl, PAYESH_OPERATOR_PASSWORD: secrets.op }));
      assert.strictEqual(co.status, 0, co.all);
      const uri = (co.out.match(/otpauth:\/\/\S+/) || [])[0];
      assert.ok(uri, 'otpauth URI printed once');
      assert.ok(!co.all.includes(secrets.op), 'password never printed');
      const totpSecret = new URL(uri).searchParams.get('secret');
      const port = await freePort();
      gw = spawn(process.execPath, ['gateway-start.cjs'], { cwd: B, env: gwEnv(port), stdio: ['ignore', 'pipe', 'pipe'] });
      gw.log = ''; gw.stdout.on('data', d => { gw.log += d; }); gw.stderr.on('data', d => { gw.log += d; });
      gw.exited = null; gw.on('exit', (c) => { gw.exited = c; });
      gw.base = 'http://127.0.0.1:' + port;
      const t0 = Date.now();
      for (;;) {
        try { const r = await fetch(gw.base + '/readyz'); if (r.ok) break; } catch (e) { /* starting */ }
        if (gw.exited !== null || Date.now() - t0 > 20000) throw new Error('bundle gateway did not start: ' + gw.log.slice(0, 400));
        await sleep(100);
      }
      const api = async (method, p, body, token) => {
        const r = await fetch(gw.base + '/api/platform/v1' + p, { method, headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, data: await r.json().catch(() => null) };
      };
      const wrong = await api('POST', '/auth/login', { login_id: 'owner-120', password: secrets.op, totp: String((Number(auth.totpAt(totpSecret, Date.now())) + 1) % 1000000).padStart(6, '0') });
      neg('wrong TOTP ⇒ 401', wrong.status === 401);
      const login = await api('POST', '/auth/login', { login_id: 'owner-120', password: secrets.op, totp: auth.totpAt(totpSecret, Date.now()) });
      assert.strictEqual(login.status, 200, JSON.stringify(login.data));
      const tok = login.data.token;
      const plan = await api('POST', '/plans', { code: 'basic', name: 'پایه', max_users: 100, storage_mb: 1024, reason: 'آزمون بستهٔ استقرار ردیف ۱۲۰' }, tok);
      assert.strictEqual(plan.status, 201, JSON.stringify(plan.data));
      codes = {};
      for (const k of ['a', 'b']) {
        const slug = `gb120-${k}-` + crypto.randomBytes(2).toString('hex');
        const r = await api('POST', '/tenants', { provision_op_id: crypto.randomUUID(), slug, display_name: 'مدرسهٔ آزمایشی ' + k,
          manager_name: 'مدیر آزمایشی ' + k, plan_code: 'basic', reason: 'آزمون سرتاسری بستهٔ استقرار ردیف ۱۲۰' }, tok);
        assert.strictEqual(r.status, 201, JSON.stringify(r.data));
        codes[k] = { slug, code: r.data.manager.activation_code };
      }
      return 'owner + 2 schools';
    });

    await check('GB-E6', 'bundled selfcheck: both schools ⇒ OK (S09..S12), codes never printed; reused codes ⇒ FAILED', () => {
      assert.ok(codes, 'schools from GB-E5');
      const args = ['deploy/gateway/selfcheck.mjs', gw.base, '--school', codes.a.slug, '--code', codes.a.code, '--school2', codes.b.slug, '--code2', codes.b.code];
      const r = nodeIn(args, cleanEnv());
      assert.strictEqual(r.status, 0, r.all);
      for (const id of ['S01', 'S02', 'S03', 'S04', 'S05', 'S07', 'S09', 'S10', 'S11', 'S12']) assert.ok(new RegExp('^PASS\\s+' + id, 'm').test(r.out), id + ' PASS\n' + r.out);
      assert.ok(/^WARN\s+S06/m.test(r.out), 'http loopback is WARN ([S]), never PASS');
      assert.ok(!r.all.includes(codes.a.code) && !r.all.includes(codes.b.code), 'codes not printed');
      const again = nodeIn(args, cleanEnv());
      neg('one-time codes reused ⇒ FAILED at S09', again.status === 1 && /^FAIL\s+S09/m.test(again.out));
      return r.out.trim().split('\n').pop().trim();
    });

    await check('GB-E7', 'SIGTERM ⇒ drained exit 0; owner-panel local-up ledger shared with admin migrate', async () => {
      gw.kill('SIGTERM');
      const t0 = Date.now();
      while (gw.exited === null && Date.now() - t0 < 15000) await sleep(50);
      assert.strictEqual(gw.exited, 0, 'drain exit code ' + gw.exited);
      gw = null;
      const lu = require(path.join(ROOT, 'apps/owner-panel/scripts/local-up.js'));
      const db2 = await lu.openDb({ databaseUrl: withDb(ADMIN_URL, DB2) });
      try {
        const t = require(path.join(ROOT, 'server/tenancy.js'));
        const c = new Client({ connectionString: withDb(ADMIN_URL, DB2) }); await c.connect();
        try { await t.migrate(c); } finally { await c.end(); }
        await lu.migrate(db2);
      } finally { await db2.close(); }
      const r = nodeIn(['deploy/gateway/admin.cjs', 'migrate'], cleanEnv({ PAYESH_PG_ADMIN: withDb(ADMIN_URL, DB2) }));
      assert.strictEqual(r.status, 0, r.all);
      const ev = r.out.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l)).find(x => x.event === 'owner_panel_migrated');
      assert.strictEqual(ev.applied.length, 0, 'nothing re-applied after local-up');
      return `skipped ${ev.skipped.length}`;
    });
  } finally {
    if (gw && gw.exited === null) gw.kill('SIGKILL');
    await sleep(200);
    for (const db of [DB, DB2]) {
      try { await root.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`); } catch (e) { /* noop */ }
    }
    await root.end();
  }
}

async function main(opts) {
  quiet = !!(opts && opts.quiet);
  passed = 0; failed = 0; negatives = 0; blocked = false; failures.length = 0;
  const b = await import(pathToFileURL(BUILD).href);
  const sc = await import(pathToFileURL(SELF).href);
  const start = require(START);
  const admin = require(ADMIN);
  const ctx = {};
  await check('GB-01', 'build: gateway closure, no single-school file, pg without pg-cloudflare, manifest sha256', () => {
    const out = tmp('gb120-build-');
    const r = b.build({ outDir: out, log: () => {} });
    assert.ok(r.ok, (r.problems || []).join('; '));
    ctx.stage = r.stage;
    ctx.archive = r.archives.find(a => a.endsWith('.tar.gz'));
    assert.ok(ctx.archive && fs.existsSync(ctx.archive), 'tar.gz archive');
    for (const f of ['server/gateway.js', 'server/tenancy.js', 'server/school-access.js', 'apps/owner-panel/server/platform-api.js', 'apps/owner-panel/server/openapi.json', 'deploy/gateway/start.cjs', 'deploy/gateway/admin.cjs', 'deploy/gateway/selfcheck.mjs'])
      assert.ok(r.closure.files.includes(f), 'closure has ' + f);
    for (const f of b.FORBIDDEN) neg('closure excludes ' + f, !fs.existsSync(path.join(r.stage, f)));
    assert.ok(r.deps.includes('node_modules/pg') && !r.deps.some(d => /cloudflare/.test(d)), 'deps');
    for (const f of ['gateway-start.cjs', 'package.json', 'gateway.env.example', 'START-HERE.txt', 'BUNDLE-MANIFEST.json', 'deploy/gateway/payesh-gateway.service', 'docs/cloud/120-gateway-bundle.md'])
      assert.ok(fs.existsSync(path.join(r.stage, f)), 'bundle has ' + f);
    const man = JSON.parse(fs.readFileSync(path.join(r.stage, 'BUNDLE-MANIFEST.json'), 'utf8'));
    for (const e of man.files) assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(path.join(r.stage, e.path))).digest('hex'), e.sha256, 'sha256 ' + e.path);
    const pj = JSON.parse(fs.readFileSync(path.join(r.stage, 'package.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(pj.dependencies), ['pg']);
    assert.strictEqual(pj.main, 'gateway-start.cjs');
    return `${man.files.length} files, ${r.closure.files.length} in closure`;
  });
  await check('GB-02', 'env vars come from the code: scan == catalog; new/stale var detected', () => {
    const cl = b.closure();
    const d = b.envDrift(cl.files, CATALOG);
    assert.deepStrictEqual([d.missing, d.stale], [[], []], JSON.stringify(d));
    for (const v of CATALOG.vars) assert.ok(['required', 'recommended', 'optional', 'admin', 'internal'].includes(v.need) && /[\u0600-\u06FF]/.test(v.fa), 'catalog entry ' + v.name);
    const copy = tmp('gb120-env-');
    for (const f of cl.files) { fs.mkdirSync(path.dirname(path.join(copy, f)), { recursive: true }); fs.copyFileSync(path.join(ROOT, f), path.join(copy, f)); }
    fs.appendFileSync(path.join(copy, 'server/gateway.js'), '\nconst NEW_KNOB = process.env.PAYESH_NEW_KNOB;\n');
    neg('new process.env var in code ⇒ missing', b.envDrift(cl.files, CATALOG, copy).missing.includes('PAYESH_NEW_KNOB'));
    const extra = { vars: CATALOG.vars.concat([{ name: 'PAYESH_GONE', need: 'optional', fa: 'x' }]) };
    neg('catalog entry the code no longer reads ⇒ stale', b.envDrift(cl.files, extra).stale.includes('PAYESH_GONE'));
    const ex = fs.readFileSync(path.join(ctx.stage, 'gateway.env.example'), 'utf8');
    for (const v of CATALOG.vars.filter(x => x.need !== 'internal')) assert.ok(ex.includes(v.name + '='), 'env example lists ' + v.name);
    return `${d.used.length} vars`;
  });
  await check('GB-03', 'secret scan: bundle clean; planted secrets caught; templates not flagged', () => suiteSecrets(b, ctx.stage));
  await check('GB-04', 'guard refusals (single-school, dynamic require, extra module, cloudflare)', () => suiteGuard(b));
  await check('GB-05', 'preflight rules (pure)', () => suitePreflight(start));
  await check('GB-06', 'extracted bundle with an empty environment refuses to start (exit 2)', () => {
    const r = run(process.execPath, ['gateway-start.cjs', '--check'], { cwd: ctx.stage, env: cleanEnv() });
    neg('empty env ⇒ exit 2', r.status === 2 && r.err.includes('GW-PREFLIGHT REFUSED (config)'));
    assert.ok(r.err.includes('pgurl_missing') && r.err.includes('gw_secret_missing'), r.err);
    const w = run(process.execPath, ['gateway-start.cjs'], { cwd: ctx.stage, env: cleanEnv({ PGURL: 'postgres://u@127.0.0.1/x', GW_SECRET: 'short' }) });
    neg('weak secret ⇒ exit 2 without listening', w.status === 2 && !w.out.includes('gateway_listening'));
    return 'exit 2';
  });
  await check('GB-07', 'SCRAM-SHA-256 verifier verified by pg SASL client code', () => suiteScram(admin));
  await check('GB-08', 'selfcheck vs stub servers + transport/Cloudflare verdicts', () => suiteSelfcheck(sc));
  await check('GB-09', 'owner doc: Persian, every command, [S]/[M], D-09/D-40, no secret', () => {
    const doc = fs.readFileSync(DOC, 'utf8');
    for (const k of ['build-gateway-bundle.mjs', 'admin.cjs migrate', 'admin.cjs logins', 'admin.cjs create-owner', 'admin.cjs check',
      'gateway-start.cjs', '--check', 'selfcheck.mjs', '--school2', 'payesh-gateway.service', 'gateway.env.example', 'env-catalog.json',
      '[S]', '[M]', 'D‑09', 'D‑40', '۱۱۶', 'BYPASSRLS', 'NOT RUN']) assert.ok(doc.includes(k), 'doc missing ' + k);
    assert.ok((doc.match(/[\u0600-\u06FF]/g) || []).length > 2500, 'doc must be Persian');
    assert.ok(!/postgres(ql)?:\/\/[^\s'"`<>]+:[^\s@'"`<>]+@/.test(doc), 'no credentialed URL in doc');
    for (const v of CATALOG.vars.filter(x => x.need === 'required' || x.need === 'recommended')) assert.ok(doc.includes(v.name), 'doc lists ' + v.name);
  });
  await check('GB-10', 'mutants: each reverted control turns red', async () => {
    const dir = tmp('gb120-mut-'); const missed = [];
    const srcs = { start: fs.readFileSync(START, 'utf8'), self: fs.readFileSync(SELF, 'utf8'), admin: fs.readFileSync(ADMIN, 'utf8'), build: fs.readFileSync(BUILD, 'utf8') };
    let killed = 0;
    for (let i = 0; i < MUTANTS.length; i++) {
      const [name, kind, mut] = MUTANTS[i];
      const ms = mut(srcs[kind]);
      if (ms === srcs[kind]) throw new Error(name + ': mutation did not apply');
      let red = false;
      const n0 = negatives;
      try { const m = await loadMutant(kind, ms, dir, i); await runSuiteFor(kind, m, ctx); } catch (e) { red = true; }
      negatives = n0;
      if (red) killed++; else missed.push(name);
    }
    if (missed.length) throw new Error('mutants survived: ' + missed.join('; '));
    negatives += killed;
    return `${killed}/${MUTANTS.length} killed`;
  });
  if (!opts || opts.pg !== false) await pgPart(ctx);
  else blocked = true;
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* noop */ } }
  tmpDirs.length = 0;
  return { passed, failed, negatives, blocked, failures: failures.slice() };
}

module.exports = { main };
if (require.main === module) {
  main().then(r => {
    console.log(`\nGATEWAY-BUNDLE-120 ${r.failed ? 'FAILED' : 'OK'} passed=${r.passed} failed=${r.failed} negative_controls=${r.negatives}${r.blocked ? ' (PostgreSQL part BLOCKED — NOT RUN)' : ''}`);
    process.exit(r.failed ? 1 : 0);
  }, e => { console.error(e); process.exit(1); });
}
