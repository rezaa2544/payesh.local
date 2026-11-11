#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   پنل مالک — اجرای محلی با یک فرمان (local-up) · ردیف ۱۰۲

     node apps/owner-panel/scripts/local-up.js            (ویندوز: start-owner-local.cmd)

   فقط آزمایش محلی؛ نه تولید. بدون هیچ Secret ورودی و فقط روی loopback:
     1) دیتابیس محلی می‌سازد: PGlite (PostgreSQL جاسازی‌شده) در پوشهٔ داده، یا
        اگر DATABASE_URL داده شود فقط یک PostgreSQL روی همین دستگاه (loopback/سوکت).
     2) migrationهای 001..004 پنل مالک را idempotent اعمال می‌کند (جدول ثبت + sha256؛
        فایل تغییرکرده ⇒ توقف).
     3) رازها (کلید امضای توکن پلتفرم) را تصادفی در پوشهٔ داده، خارج از Git و با
        مجوز 0600 می‌سازد و در اجراهای بعد همان را به کار می‌برد.
     4) حساب مالک را فقط یک‌بار می‌سازد: رمز بدون نمایش پرسیده می‌شود و URI از نوع
        otpauth:// فقط همان یک‌بار چاپ می‌شود.
     5) Gateway واقعی (server/gateway.js) و سرور پنل (static-server.js) را روی
        127.0.0.1 بالا می‌آورد و http://127.0.0.1:8095 را چاپ می‌کند.

   --smoke (CI روی ubuntu و windows-latest): پوشهٔ دادهٔ تازه، ورود سرتاسری از مبدأ
   پنل با TOTP (کد غلط ⇒ 401، کد درست ⇒ 200)، یک GET داشبورد، صفحهٔ SPA و خاموشی
   تمیز (پورت‌ها بسته، دیتابیس بسته). موفق ⇒ «LOCAL-UP-SMOKE-OK» و کد خروج 0.

   ردها (کد خروج 2): bind غیر loopback، DATABASE_URL غیرمحلی، PAYESH_PLATFORM_PGURL
   تنظیم‌شده، پوشهٔ داده درون مخزن Git.
   ═══════════════════════════════════════════════════════════════════ */
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const auth = require('../server/owner-auth');
const { createOperator, LOGIN_RE } = require('./create-operator');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MIG_DIR = path.join(ROOT, 'db', 'migrations', 'owner-panel');
const PREFIX = '/api/platform/v1';
const LEDGER = 'public.payesh_owner_local_migrations';
const BANNER = [
  '══════════════════════════════════════════════════════════════',
  '  فقط آزمایش محلی؛ نه تولید  ·  LOCAL TESTING ONLY — NOT PRODUCTION',
  '  پنل مالک پایش روی loopback، با دیتابیس و رازهای محلیِ این دستگاه',
  '══════════════════════════════════════════════════════════════',
].join('\n');

class Refusal extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/* ───────────────────────── ورودی و ردها ───────────────────────── */
function parseArgs(argv) {
  const out = { host: '127.0.0.1', port: null, gatewayPort: null, dataDir: null, smoke: false,
    loginId: 'owner', migrationsThrough: null, keepData: false };
  const need = (i) => { if (i >= argv.length) throw new Refusal('bad_args', 'missing value for ' + argv[i - 1]); return argv[i]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') out.host = need(++i);
    else if (a === '--port') out.port = Number(need(++i));
    else if (a === '--gateway-port') out.gatewayPort = Number(need(++i));
    else if (a === '--data-dir') out.dataDir = need(++i);
    else if (a === '--login-id') out.loginId = need(++i);
    else if (a === '--smoke') out.smoke = true;
    else if (a === '--keep-data') out.keepData = true;
    /* فقط برای کنترل منفی «بدون migration 004 ⇒ 501» */
    else if (a === '--migrations-through') out.migrationsThrough = need(++i);
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Refusal('bad_args', 'unknown argument: ' + a);
  }
  for (const k of ['port', 'gatewayPort']) {
    if (out[k] !== null && !(Number.isInteger(out[k]) && out[k] >= 0 && out[k] <= 65535)) throw new Refusal('bad_args', k + ' must be 0..65535');
  }
  if (out.migrationsThrough !== null && !/^\d{3}$/.test(out.migrationsThrough)) throw new Refusal('bad_args', '--migrations-through NNN');
  if (!LOGIN_RE.test(out.loginId)) throw new Refusal('bad_args', 'login id: 3–120 chars of A-Z a-z 0-9 . _ @ -');
  return out;
}

function isLoopbackHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  if (net.isIPv4(h)) return h.split('.')[0] === '127';
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  return !!(m && m[1].split('.')[0] === '127');
}

function assertLoopbackBind(host) {
  if (!isLoopbackHost(host)) {
    throw new Refusal('non_loopback_bind', `refused: --host ${host} is not loopback; local-up only binds 127.0.0.1/::1/localhost`);
  }
}

/** DATABASE_URL فقط اگر به همین دستگاه اشاره کند (loopback یا سوکت یونیکس). */
function assertLocalDatabaseUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch (e) { throw new Refusal('non_local_database_url', 'refused: DATABASE_URL is not a valid URL'); }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Refusal('non_local_database_url', 'refused: DATABASE_URL must be postgres://');
  const hosts = [decodeURIComponent(u.hostname || '')];
  for (const [k, v] of u.searchParams) { if (k.toLowerCase() === 'host' || k.toLowerCase() === 'hostaddr') hosts.push(v); }
  for (const h of hosts) {
    if (h === '') continue;   /* no host ⇒ the pg client defaults to this machine (localhost / unix socket) */
    const socket = h.startsWith('/');
    if (!socket && !isLoopbackHost(h || '')) {
      throw new Refusal('non_local_database_url', `refused: DATABASE_URL host "${h}" is not on this machine (loopback or unix socket only)`);
    }
  }
  return u.toString();
}

function defaultDataDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'PayeshOwnerLocal');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'payesh-owner-local');
}

/** پوشهٔ داده نباید داخل درخت کاری یک مخزن Git باشد (رازها هرگز کامیت نشوند). */
function assertOutsideGit(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) {
      throw new Refusal('data_dir_in_git', `refused: data dir ${dir} is inside the Git work tree ${cur}; choose a folder outside any repository`);
    }
    const up = path.dirname(cur);
    if (up === cur) return;
    cur = up;
  }
}

function assertEnvClean(env) {
  if (String(env.PAYESH_PLATFORM_PGURL || '').trim()) {
    throw new Refusal('platform_pgurl_set', 'refused: PAYESH_PLATFORM_PGURL is set; local-up never connects to a configured (possibly production) platform database. Unset it.');
  }
}

/* ───────────────────────── رازها ───────────────────────── */
function loadOrCreateSecrets(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'secrets.json');
  if (fs.existsSync(file)) {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof s.platform_token_secret !== 'string' || s.platform_token_secret.length < 32) throw new Error('secrets.json is invalid; delete the data dir to start over');
    return { file, created: false, secret: s.platform_token_secret };
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, JSON.stringify({ platform_token_secret: secret, created_at: new Date().toISOString(),
    note: 'local testing only — generated by local-up.js; never copy to a server' }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try { fs.chmodSync(file, 0o600); } catch (_) { /* windows */ }
  return { file, created: true, secret };
}

/* ───────────────────────── دیتابیس ───────────────────────── */
function mutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

async function openDb({ databaseUrl, dataDir }) {
  if (databaseUrl) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: databaseUrl, max: 4, application_name: 'payesh-owner-local-up' });
    pool.on('error', () => { /* connection drop must not crash local-up */ });
    const r = await pool.query('SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user');
    if (!r.rows[0] || !r.rows[0].rolsuper) {
      await pool.end();
      throw new Refusal('needs_superuser', 'refused: DATABASE_URL must use a local superuser (migrations create roles and schemas)');
    }
    return {
      kind: 'postgres',
      exec: (sql) => pool.query(sql),
      query: (sql, p = []) => pool.query(sql, p),
      async tx(role, fn) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          if (role) await c.query(`SET LOCAL ROLE ${role}`);
          const out = await fn((sql, p = []) => c.query(sql, p));
          await c.query('COMMIT');
          return out;
        } catch (e) {
          try { await c.query('ROLLBACK'); } catch (_) { /* noop */ }
          throw e;
        } finally { c.release(); }
      },
      close: () => pool.end(),
    };
  }
  let PGlite;
  try { ({ PGlite } = require('@electric-sql/pglite')); } catch (e) {
    throw new Refusal('pglite_missing', 'embedded database not installed: run "npm ci" in the repository first (or set DATABASE_URL to a local PostgreSQL)');
  }
  const dir = path.join(dataDir, 'pglite');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new PGlite(dir);
  await db.waitReady;
  const lock = mutex();   /* PGlite = one connection: transactions must not interleave */
  return {
    kind: 'pglite',
    exec: (sql) => lock(() => db.exec(sql)),
    query: (sql, p = []) => lock(() => db.query(sql, p)),
    tx(role, fn) {
      return lock(async () => {
        await db.exec('BEGIN');
        try {
          if (role) await db.exec(`SET LOCAL ROLE ${role}`);
          const out = await fn((sql, p = []) => db.query(sql, p));
          await db.exec('COMMIT');
          return out;
        } catch (e) {
          try { await db.exec('ROLLBACK'); } catch (_) { /* noop */ }
          throw e;
        }
      });
    },
    close: () => lock(() => db.close()),
  };
}

function migrationFiles(through) {
  return fs.readdirSync(MIG_DIR).filter(f => /^\d{3}_[a-z0-9_]+\.up\.sql$/.test(f)).sort()
    .filter(f => through === null || f.slice(0, 3) <= through);
}

/** هر فایل migration تراکنش خودش را دارد؛ ثبت در دفتر درست پیش از COMMIT همان فایل تزریق می‌شود
    تا اعمال و ثبت اتمیک باشند. فایل اعمال‌شده با sha256 متفاوت ⇒ توقف. */
async function migrate(db, { through = null } = {}) {
  await db.exec(`CREATE TABLE IF NOT EXISTS ${LEDGER} (
    name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Map((await db.query(`SELECT name, sha256 FROM ${LEDGER}`)).rows.map(r => [r.name, r.sha256]));
  const applied = [], skipped = [];
  for (const f of migrationFiles(through)) {
    const sql = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
    const sha = crypto.createHash('sha256').update(sql).digest('hex');
    if (done.has(f)) {
      if (done.get(f) !== sha) throw new Refusal('migration_checksum_mismatch', `refused: ${f} changed after it was applied (sha256 differs); start with a fresh data dir`);
      skipped.push(f);
      continue;
    }
    const at = sql.search(/^COMMIT;\s*$(?![\s\S]*^COMMIT;)/m);
    if (at < 0) throw new Error(`${f}: no trailing COMMIT;`);
    const record = `INSERT INTO ${LEDGER} (name, sha256) VALUES ('${f}', '${sha}');\n`;
    await db.exec(sql.slice(0, at) + record + sql.slice(at));
    applied.push(f);
  }
  return { applied, skipped };
}

async function hasLogin(db) {
  const t = await db.query(`SELECT to_regclass('owner_platform.platform_credentials') AS t`);
  return !!(t.rows[0] && t.rows[0].t);
}

async function ownerCount(db) {
  const r = await db.query(`SELECT count(*)::int AS n FROM owner_platform.platform_credentials c
    JOIN owner_platform.platform_users u ON u.id = c.user_id WHERE u.role = 'platform_owner'`);
  return r.rows[0].n;
}

async function ensureOwner(db, { loginId, password }) {
  if (await ownerCount(db) > 0) return { created: false };
  const r = await db.tx('payesh_platform_owner', q => createOperator(q, { loginId, role: 'platform_owner', password }));
  return { created: true, userId: r.userId, otpauth: r.otpauth, totpSecret: r.totpSecret };
}

function runtimeAdapter(db) {
  return { withTransaction: (fn) => db.tx('payesh_platform_runtime', fn) };
}

/* ───────────────────────── سرورها ───────────────────────── */
function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(server.address().port); });
  });
}

async function startServers({ db, secret, host, gatewayPort, panelPort }) {
  /* Gateway در همین فرایند و فقط با مسیرهای پلتفرم: هیچ اتصال دیتابیس مدرسه/replica/Directory */
  for (const k of ['PGURL', 'PAYESH_PG_REPLICA_URL', 'PAYESH_DIRECTORY_PGURL', 'PAYESH_PLATFORM_PGURL']) delete process.env[k];
  process.env.PAYESH_PLATFORM_TOKEN_SECRET = secret;
  if (!process.env.GW_ACCESS_LOG) process.env.GW_ACCESS_LOG = '0';
  if (!process.env.GW_INSTANCE) process.env.GW_INSTANCE = 'local-up';
  const gw = require('../../../server/gateway.js');
  gw.usePlatformDb(runtimeAdapter(db));
  const gwPort = await listen(gw.server, gatewayPort, host);
  const { createOwnerPanelServer } = require('../server/static-server');
  const panel = createOwnerPanelServer({ upstream: `http://${host.includes(':') ? `[${host}]` : host}:${gwPort}` });
  const port = await listen(panel, panelPort, host);
  return { gw, panel, gwPort, port };
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    try { server.closeAllConnections(); } catch (_) { /* noop */ }
  });
}

function request(port, host, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = Object.assign({ accept: 'application/json' }, headers);
    if (data) { h['content-type'] = 'application/json'; h['content-length'] = String(data.length); }
    const req = http.request({ host, port, method, path: p, headers: h, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* html */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function portClosed(port, host) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    s.once('connect', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(true));
  });
}

/* ───────────────────────── رمز عبور ───────────────────────── */
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return reject(new Refusal('no_tty', 'no TTY: set PAYESH_OPERATOR_PASSWORD (min 12 chars) for this one command, or run in a terminal'));
    process.stderr.write(prompt);
    let value = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
        process.stderr.write('\n'); resolve(value);
      } else if (ch === '\u0003') { stdin.setRawMode(false); process.exit(130); }
      else if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
      else value += ch;
    };
    stdin.on('data', onData);
  });
}

async function obtainPassword() {
  if (process.env.PAYESH_OPERATOR_PASSWORD) return process.env.PAYESH_OPERATOR_PASSWORD;
  const a = await askHidden(`owner password (min ${auth.MIN_PASSWORD} chars, not shown): `);
  const b = await askHidden('repeat password: ');
  if (a !== b) throw new Refusal('password_mismatch', 'passwords do not match');
  return a;
}

/* ───────────────────────── اجرا ───────────────────────── */
async function smokeChecks({ port, host, loginId, password, totpSecret, log }) {
  const results = {};
  const totp = auth.totpAt(totpSecret, Date.now());
  const wrong = String((Number(totp) + 1) % 1e6).padStart(6, '0');
  const bad = await request(port, host, 'POST', PREFIX + '/auth/login', { login_id: loginId, password, totp: wrong });
  results.wrong_totp = bad.status;
  if (bad.status === 501) throw Object.assign(new Error('login_not_installed (501): migration 004 is missing'), { results });
  if (bad.status !== 401) throw Object.assign(new Error('wrong TOTP was not rejected with 401: ' + bad.status), { results });
  log(`smoke: wrong TOTP ⇒ ${bad.status} ${bad.json && bad.json.error}`);
  const good = await request(port, host, 'POST', PREFIX + '/auth/login', { login_id: loginId, password, totp });
  results.login = good.status;
  if (good.status !== 200 || !good.json || !good.json.token) throw Object.assign(new Error('login failed: ' + good.status + ' ' + good.text.slice(0, 120)), { results });
  log(`smoke: login (password + TOTP) via panel origin ⇒ ${good.status}`);
  const dash = await request(port, host, 'GET', PREFIX + '/dashboard', undefined, { authorization: 'Bearer ' + good.json.token });
  results.dashboard = dash.status;
  if (dash.status !== 200 || !dash.json || dash.json.ok === false) throw Object.assign(new Error('dashboard GET failed: ' + dash.status), { results });
  log(`smoke: GET /dashboard ⇒ ${dash.status}`);
  const page = await request(port, host, 'GET', '/', undefined, { accept: 'text/html' });
  results.spa = page.status;
  if (page.status !== 200 || !/<html/i.test(page.text) || !String(page.headers['content-security-policy'] || '').includes("frame-ancestors 'none'")) {
    throw Object.assign(new Error('panel page not served with CSP: ' + page.status), { results });
  }
  log(`smoke: GET / (SPA + CSP) ⇒ ${page.status}`);
  const noAuth = await request(port, host, 'GET', PREFIX + '/dashboard');
  results.dashboard_no_token = noAuth.status;
  if (noAuth.status !== 401) throw Object.assign(new Error('dashboard without token was not 401: ' + noAuth.status), { results });
  return results;
}

async function run(opts, io = {}) {
  const log = io.log || ((m) => process.stdout.write(m + '\n'));
  const env = io.env || process.env;
  assertLoopbackBind(opts.host);
  assertEnvClean(env);
  const databaseUrl = env.DATABASE_URL ? assertLocalDatabaseUrl(env.DATABASE_URL) : null;
  let dataDir = opts.dataDir ? path.resolve(opts.dataDir) : null;
  let tempData = false;
  if (!dataDir && opts.smoke) { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-owner-smoke-')); tempData = true; }
  if (!dataDir) dataDir = defaultDataDir();
  assertOutsideGit(dataDir);

  log(BANNER);
  log(`data dir: ${dataDir}${tempData ? ' (temporary, smoke)' : ''}`);
  const secrets = loadOrCreateSecrets(dataDir);
  log(`secrets: ${secrets.created ? 'generated' : 'reused'} (${path.basename(secrets.file)}, mode 0600, outside Git; never printed)`);
  const db = await openDb({ databaseUrl, dataDir });
  log(`database: ${db.kind === 'pglite' ? 'embedded PostgreSQL (PGlite) in data dir' : 'local PostgreSQL (DATABASE_URL, loopback)'}`);
  let servers = null;
  const state = { dataDir, db: db.kind };
  const shutdown = async () => {
    if (servers) { await closeServer(servers.panel); await closeServer(servers.gw.server); }
    await db.close();
    if (tempData && !opts.keepData) fs.rmSync(dataDir, { recursive: true, force: true });
  };
  try {
    const m = await migrate(db, { through: opts.migrationsThrough });
    state.migrations = m;
    log(`migrations: applied=[${m.applied.join(', ')}] already=[${m.skipped.join(', ')}]`);

    let owner = { created: false };
    let password = null;
    if (await hasLogin(db)) {
      if (opts.smoke) {
        if (await ownerCount(db) > 0) throw new Refusal('smoke_needs_fresh_data', 'refused: --smoke needs a fresh data dir (an owner account already exists)');
        password = crypto.randomBytes(18).toString('base64url');
      } else if (await ownerCount(db) === 0) {
        password = await obtainPassword();
      }
      if (password) owner = await ensureOwner(db, { loginId: opts.loginId, password });
      if (owner.created && !opts.smoke) {
        log(`owner account created: login_id=${opts.loginId} (password not shown)`);
        log('Scan ONCE in an authenticator app, then clear this terminal (it is not stored or shown again):');
        log(owner.otpauth);
      } else if (owner.created) {
        log(`owner account created: login_id=${opts.loginId} (smoke: password and TOTP secret kept in memory only)`);
      } else {
        log('owner account: already exists (use your authenticator app)');
      }
    } else {
      log('owner login: NOT INSTALLED (migration 004 not applied) — POST /auth/login answers 501');
    }

    servers = await startServers({ db, secret: secrets.secret, host: opts.host,
      gatewayPort: opts.gatewayPort !== null ? opts.gatewayPort : (opts.smoke ? 0 : 8090),
      panelPort: opts.port !== null ? opts.port : (opts.smoke ? 0 : 8095) });
    const shown = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
    state.url = `http://${shown}:${servers.port}`;
    log(`gateway: http://${shown}:${servers.gwPort} (platform routes only)`);
    log(`owner panel: ${state.url}`);

    if (!opts.smoke) {
      log('Press Ctrl+C to stop.');
      await new Promise((resolve) => {
        const stop = () => resolve();
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
      });
      log('stopping…');
      await shutdown();
      log('stopped cleanly');
      return state;
    }

    const loginId = opts.loginId;
    let results;
    if (!owner.created) {
      /* بدون 004: ورود باید 501 بدهد ⇒ smoke قرمز */
      const r = await request(servers.port, opts.host, 'POST', PREFIX + '/auth/login', { login_id: loginId, password: 'x'.repeat(16), totp: '000000' });
      throw Object.assign(new Error(r.status === 501 ? 'login_not_installed (501): migration 004 is missing'
        : 'owner login unavailable: ' + r.status), { results: { login: r.status } });
    }
    results = await smokeChecks({ port: servers.port, host: opts.host, loginId, password, totpSecret: owner.totpSecret, log });
    const ports = [servers.port, servers.gwPort];
    await shutdown();
    servers = null;
    const closed = await Promise.all(ports.map(p => portClosed(p, opts.host)));
    if (!closed.every(Boolean)) throw new Error('ports still open after shutdown');
    log(`smoke: clean shutdown (panel + gateway ports closed, database closed${tempData && !opts.keepData ? ', temp data removed' : ''})`);
    log('LOCAL-UP-SMOKE-OK ' + JSON.stringify(results));
    state.smoke = results;
    return state;
  } catch (e) {
    try { await shutdown(); } catch (_) { /* noop */ }
    throw e;
  }
}

module.exports = {
  parseArgs, isLoopbackHost, assertLoopbackBind, assertLocalDatabaseUrl, assertOutsideGit, assertEnvClean,
  defaultDataDir, loadOrCreateSecrets, openDb, migrate, migrationFiles, ensureOwner, run, Refusal, BANNER, LEDGER,
};

if (require.main === module) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { process.stderr.write('local-up: ' + e.message + '\n'); process.exit(2); }
  if (opts.help) {
    process.stdout.write('usage: node apps/owner-panel/scripts/local-up.js [--port 8095] [--gateway-port 8090] [--data-dir DIR] [--login-id owner] [--smoke]\n' +
      '       DATABASE_URL=postgres://postgres@127.0.0.1:5432/payesh_owner (optional, local only)\n');
    process.exit(0);
  }
  run(opts).then(() => process.exit(0)).catch((e) => {
    if (e instanceof Refusal) { process.stderr.write('local-up: ' + e.message + '\n'); process.exit(2); }
    process.stderr.write((opts.smoke ? 'LOCAL-UP-SMOKE-FAIL ' : 'local-up: ') + (e && e.message || e) +
      (e && e.results ? ' ' + JSON.stringify(e.results) : '') + '\n');
    process.exit(1);
  });
}
