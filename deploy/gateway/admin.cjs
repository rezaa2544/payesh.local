#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 120 — admin CLI of the multi-tenant Gateway bundle.
   Runs ONCE per install/upgrade with a migration-admin connection
   (PAYESH_PG_ADMIN: a role with CREATEROLE that owns the database).
   The running Gateway never gets this connection.

     node deploy/gateway/admin.cjs migrate [--with-directory]
         tenancy schema (RLS, roles payesh_owner/payesh_runtime) + owner-panel
         migrations 001..N (ledger + sha256, same ledger as owner-panel local-up;
         a changed file that was already applied ⇒ refused) [+ Directory tables]
     node deploy/gateway/admin.cjs logins
         sets the password of payesh_runtime and creates/updates the login
         payesh_platform_login (member of payesh_platform_runtime, NOSUPERUSER,
         NOBYPASSRLS). Passwords come from PAYESH_RUNTIME_PASSWORD /
         PAYESH_PLATFORM_LOGIN_PASSWORD; only a client-side SCRAM-SHA-256
         verifier is sent, so the clear password never reaches server logs.
         Prints the two URL TEMPLATES (password replaced by <PASSWORD>).
     node deploy/gateway/admin.cjs create-owner --login-id <id> [--role platform_owner]
         first owner-panel account (password + TOTP, D-45, max 3). Password is
         asked without echo (or PAYESH_OPERATOR_PASSWORD); the otpauth:// URI is
         printed once and stored nowhere else.
     node deploy/gateway/admin.cjs check
         read-only audit: login roles not SUPERUSER/BYPASSRLS, forced RLS on the
         tenant tables, runtime has no privilege on owner_platform, every
         owner-panel migration applied with the same sha256.

   Exit: 0 ok · 1 failed/refused · 2 usage. No secret is printed.
   ═══════════════════════════════════════════════════════════════════ */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const MIG_DIR = path.join(ROOT, 'db', 'migrations', 'owner-panel');
/* same ledger as apps/owner-panel/scripts/local-up.js: a DB prepared by either tool is
   recognised by the other (asserted in tests/gateway-bundle-120.js) */
const LEDGER = 'public.payesh_owner_local_migrations';
const RUNTIME_ROLE = 'payesh_runtime';
const PLATFORM_LOGIN = 'payesh_platform_login';
const PLATFORM_GROUP = 'payesh_platform_runtime';
const MIN_DB_PASSWORD = 20;
/* every tenant table of server/tenancy.js SCHEMA_SQL (8 × ENABLE + FORCE ROW LEVEL SECURITY) */
const TENANT_TABLES = ['tenant_records', 'product_records', 'product_jobs', 'product_change_feed', 'product_ops', 'gateway_quota', 'gw_school', 'gw_credential'];

class AdminError extends Error {
  constructor(code, fa) { super(fa); this.code = code; }
}

function out(obj) { console.log(JSON.stringify(obj)); }

function migrationFiles(dir = MIG_DIR) {
  return fs.readdirSync(dir).filter(f => /^\d{3}_[a-z0-9_]+\.up\.sql$/.test(f)).sort();
}

/* ── SCRAM-SHA-256 verifier (RFC 5802 / RFC 7677), like psql \password ── */
function saslprep(pw) {
  return String(pw).replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/g, ' ')
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[\u00AD\u034F\u1806\u180B\u180C\u180D\u200C\u200D\u2060\uFE00-\uFE0F\uFEFF]/g, '').normalize('NFKC');
}
function scramVerifier(password, { salt = crypto.randomBytes(16), iterations = 4096 } = {}) {
  const salted = crypto.pbkdf2Sync(saslprep(password), salt, iterations, 32, 'sha256');
  const clientKey = crypto.createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = crypto.createHash('sha256').update(clientKey).digest();
  const serverKey = crypto.createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

function checkPassword(name, value) {
  const v = String(value || '');
  if (v.length < MIN_DB_PASSWORD) throw new AdminError('weak_password', `${name} باید دست‌کم ${MIN_DB_PASSWORD} نویسهٔ تصادفی باشد.`);
  return v;
}

function urlTemplate(adminUrl, user) {
  const u = new URL(adminUrl);
  u.username = user; u.password = 'PASSWORD';
  return u.toString().replace(':PASSWORD@', ':<PASSWORD>@');
}

async function connect(url) {
  if (!url) throw new AdminError('admin_url_missing', 'PAYESH_PG_ADMIN تنظیم نشده (اتصال مدیر migration).');
  const { Client } = require('pg');
  const c = new Client({ connectionString: url, application_name: 'payesh-gw-admin' });
  await c.connect();
  return c;
}

async function migrateOwnerPanel(c, dir = MIG_DIR) {
  await c.query(`CREATE TABLE IF NOT EXISTS ${LEDGER} (
    name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Map((await c.query(`SELECT name, sha256 FROM ${LEDGER}`)).rows.map(r => [r.name, r.sha256]));
  const applied = [], skipped = [];
  for (const f of migrationFiles(dir)) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const sha = crypto.createHash('sha256').update(sql).digest('hex');
    if (done.has(f)) {
      if (done.get(f) !== sha) throw new AdminError('migration_checksum_mismatch', `${f} پس از اعمال تغییر کرده (sha256 متفاوت)؛ متوقف شد.`);
      skipped.push(f);
      continue;
    }
    const at = sql.search(/^COMMIT;\s*$(?![\s\S]*^COMMIT;)/m);
    if (at < 0) throw new AdminError('migration_no_commit', `${f}: COMMIT; پایانی ندارد.`);
    /* apply + record atomically: the ledger row is injected right before the file's own COMMIT */
    await c.query(sql.slice(0, at) + `INSERT INTO ${LEDGER} (name, sha256) VALUES ('${f}', '${sha}');\n` + sql.slice(at));
    applied.push(f);
  }
  return { applied, skipped };
}

async function cmdMigrate(env, args) {
  const tenancy = require(path.join(ROOT, 'server', 'tenancy.js'));
  const c = await connect(env.PAYESH_PG_ADMIN);
  try {
    const t = await tenancy.migrate(c);
    out({ event: 'tenancy_migrated', statements: t.statements, server_version: t.server_version });
    if (args.includes('--with-directory')) {
      const directory = require(path.join(ROOT, 'server', 'directory.js'));
      await directory.migrate(c);
      out({ event: 'directory_migrated' });
    }
    const o = await migrateOwnerPanel(c);
    out({ event: 'owner_panel_migrated', applied: o.applied, skipped: o.skipped });
  } finally { await c.end(); }
  console.log('GW-ADMIN migrate OK');
}

async function cmdLogins(env) {
  const rt = checkPassword('PAYESH_RUNTIME_PASSWORD', env.PAYESH_RUNTIME_PASSWORD);
  const pl = checkPassword('PAYESH_PLATFORM_LOGIN_PASSWORD', env.PAYESH_PLATFORM_LOGIN_PASSWORD);
  if (rt === pl) throw new AdminError('password_reused', 'دو رمز باید متفاوت باشند.');
  const c = await connect(env.PAYESH_PG_ADMIN);
  try {
    const roles = await c.query(`select rolname from pg_roles where rolname = any($1)`, [[RUNTIME_ROLE, PLATFORM_GROUP]]);
    const have = new Set(roles.rows.map(r => r.rolname));
    if (!have.has(RUNTIME_ROLE) || !have.has(PLATFORM_GROUP)) throw new AdminError('not_migrated', 'نقش‌ها نیستند؛ اول «admin.cjs migrate».');
    await c.query(`ALTER ROLE ${RUNTIME_ROLE} WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD ${c.escapeLiteral(scramVerifier(rt))}`);
    await c.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PLATFORM_LOGIN}') THEN
        CREATE ROLE ${PLATFORM_LOGIN} LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
      END IF; END $$`);
    await c.query(`ALTER ROLE ${PLATFORM_LOGIN} WITH LOGIN INHERIT NOSUPERUSER NOBYPASSRLS PASSWORD ${c.escapeLiteral(scramVerifier(pl))}`);
    await c.query(`GRANT ${PLATFORM_GROUP} TO ${PLATFORM_LOGIN}`);
    out({ event: 'logins_ready', runtime: RUNTIME_ROLE, platform: PLATFORM_LOGIN, password_sent: 'scram-sha-256 verifier only' });
    out({ event: 'url_templates', PGURL: urlTemplate(env.PAYESH_PG_ADMIN, RUNTIME_ROLE),
      PAYESH_PLATFORM_PGURL: urlTemplate(env.PAYESH_PG_ADMIN, PLATFORM_LOGIN) });
  } finally { await c.end(); }
  console.log('GW-ADMIN logins OK');
}

function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return reject(new AdminError('no_tty', 'ترمینال تعاملی نیست؛ PAYESH_OPERATOR_PASSWORD را فقط در همان فرمان بدهید.'));
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

async function cmdCreateOwner(env, args) {
  const { createOperator } = require(path.join(ROOT, 'apps', 'owner-panel', 'scripts', 'create-operator.js'));
  const i = args.indexOf('--login-id');
  const loginId = i >= 0 ? args[i + 1] : '';
  const r = args.indexOf('--role');
  const role = r >= 0 ? args[r + 1] : 'platform_owner';
  if (!loginId) throw new AdminError('usage', 'استفاده: admin.cjs create-owner --login-id <شناسه>');
  let password = env.PAYESH_OPERATOR_PASSWORD;
  if (!password) {
    password = await askHidden('رمز عبور (حداقل ۱۲ نویسه): ');
    const again = await askHidden('تکرار رمز: ');
    if (password !== again) throw new AdminError('password_mismatch', 'دو رمز یکی نبودند.');
  }
  const c = await connect(env.PAYESH_PG_ADMIN);
  let res;
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE payesh_platform_owner');
    res = await createOperator((sql, p = []) => c.query(sql, p), { loginId, role, password });
    await c.query('COMMIT');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) { /* noop */ }
    if (e && e.code === '23514') throw new AdminError('operator_cap', 'سقف ۳ حساب پنل مالک پر است (D-45).');
    if (e && e.code === '23505') throw new AdminError('operator_exists', 'برای این شناسه قبلاً رمز ساخته شده.');
    throw e;
  } finally { await c.end(); }
  out({ event: 'owner_created', role: res.role });
  console.log('این URI را همین حالا در برنامهٔ Authenticator ثبت کنید (دوباره نمایش داده نمی‌شود):');
  console.log(res.otpauth);
  console.log('GW-ADMIN create-owner OK');
}

async function audit(c, dir = MIG_DIR) {
  const findings = [];
  const add = (ok, id, detail) => findings.push({ ok, id, detail });
  const roles = await c.query(`select rolname, rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname = any($1)`,
    [[RUNTIME_ROLE, PLATFORM_LOGIN, PLATFORM_GROUP]]);
  const byName = Object.fromEntries(roles.rows.map(r => [r.rolname, r]));
  for (const n of [RUNTIME_ROLE, PLATFORM_LOGIN]) {
    const r = byName[n];
    add(!!r, 'role_exists:' + n, r ? 'present' : 'missing (run migrate / logins)');
    if (r) add(!r.rolsuper && !r.rolbypassrls, 'role_no_bypass:' + n, `super=${r.rolsuper} bypassrls=${r.rolbypassrls}`);
  }
  if (byName[PLATFORM_LOGIN]) {
    const m = await c.query(`select pg_has_role($1, $2, 'MEMBER') as m`, [PLATFORM_LOGIN, PLATFORM_GROUP]);
    add(m.rows[0].m === true, 'platform_login_member', String(m.rows[0].m));
  }
  const rls = await c.query(`select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c
    join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = any($1)`, [TENANT_TABLES]);
  const seen = new Map(rls.rows.map(r => [r.relname, r]));
  for (const t of TENANT_TABLES) {
    const r = seen.get(t);
    add(!!(r && r.relrowsecurity && r.relforcerowsecurity), 'forced_rls:' + t, r ? `enabled=${r.relrowsecurity} forced=${r.relforcerowsecurity}` : 'table missing');
  }
  const priv = await c.query(`select count(*)::int as n from information_schema.role_table_grants
    where grantee = $1 and table_schema = 'owner_platform'`, [RUNTIME_ROLE]);
  add(priv.rows[0].n === 0, 'runtime_no_owner_platform', `grants=${priv.rows[0].n}`);
  const led = await c.query(`select to_regclass('${LEDGER}') is not null as t`);
  if (!led.rows[0].t) add(false, 'owner_panel_migrations', 'ledger missing (run migrate)');
  else {
    const done = new Map((await c.query(`SELECT name, sha256 FROM ${LEDGER}`)).rows.map(r => [r.name, r.sha256]));
    for (const f of migrationFiles(dir)) {
      const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f), 'utf8')).digest('hex');
      add(done.get(f) === sha, 'migration:' + f, done.has(f) ? (done.get(f) === sha ? 'applied' : 'sha256 differs') : 'not applied');
    }
  }
  return findings;
}

async function cmdCheck(env) {
  const c = await connect(env.PAYESH_PG_ADMIN);
  let findings;
  try { findings = await audit(c); } finally { await c.end(); }
  for (const f of findings) console.log(`${f.ok ? 'PASS' : 'FAIL'}  ${f.id}  ${f.detail}`);
  const bad = findings.filter(f => !f.ok).length;
  console.log(bad ? `GW-ADMIN check FAILED ${bad}/${findings.length}` : `GW-ADMIN check OK ${findings.length}/${findings.length}`);
  if (bad) process.exitCode = 1;
}

const COMMANDS = { migrate: cmdMigrate, logins: cmdLogins, 'create-owner': cmdCreateOwner, check: cmdCheck };

async function main(argv = process.argv.slice(2), env = process.env) {
  const cmd = argv[0];
  if (!COMMANDS[cmd]) {
    console.error('استفاده: node deploy/gateway/admin.cjs <migrate [--with-directory] | logins | create-owner --login-id X | check>');
    process.exitCode = 2;
    return;
  }
  try { await COMMANDS[cmd](env, argv.slice(1)); }
  catch (e) {
    if (e instanceof AdminError) { console.error(JSON.stringify({ event: 'refused', code: e.code, fa: e.message })); }
    else { console.error(JSON.stringify({ event: 'failed', code: (e && e.code) || 'error', detail: String((e && e.message) || e).slice(0, 200) })); }
    console.error(`GW-ADMIN ${cmd} FAILED`);
    process.exitCode = 1;
  }
}

module.exports = { scramVerifier, saslprep, migrateOwnerPanel, migrationFiles, audit, urlTemplate, AdminError, LEDGER, TENANT_TABLES, main };
if (require.main === module) main();
