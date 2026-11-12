'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 120 — startup file of the multi-tenant Gateway bundle.

   Panels ("Setup Node.js App", Passenger) and systemd both start THIS file
   (the bundle root has a one-line gateway-start.cjs that requires it).

   Before the Gateway opens a port it refuses (exit 2) a configuration that
   would run unsafely, and (exit 3) a database principal that would silently
   bypass tenant isolation:
     · Node < 22, PGURL missing, GW_SECRET < 32 chars
     · platform API half-configured, its secret equal to GW_SECRET, or its
       DB URL equal to PGURL (the two principals must stay separate)
     · PAYESH_FIELD_CRYPTO=required without keys
     · the PGURL / PAYESH_PLATFORM_PGURL role is SUPERUSER or BYPASSRLS
       (RLS would not apply → one school could read another's rows)
     · the tenancy schema is missing (run admin.cjs migrate first)
   Warnings (start anyway): platform API off, /metrics open, unknown
   GW_/PAYESH_ variable (typo), plain DB connection without TLS to a
   non-local host.

   node deploy/gateway/start.cjs            → preflight, then listen
   node deploy/gateway/start.cjs --check    → preflight only, exit 0/2/3
   Nothing secret is ever printed: only variable NAMES and verdicts.
   ═══════════════════════════════════════════════════════════════════ */
const path = require('node:path');
const catalog = require('./env-catalog.json');

const ROOT = path.resolve(__dirname, '..', '..');
const KNOWN = new Set(catalog.vars.map(v => v.name));
const MIN_SECRET = 32;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '']);

function parseDbUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (!/^postgres(ql)?:$/.test(u.protocol)) return null;
    return { host: u.hostname, db: u.pathname.replace(/^\//, ''), user: decodeURIComponent(u.username || ''),
      ssl: /(^|&)sslmode=(require|verify-ca|verify-full)(&|$)/.test(u.search.slice(1)) };
  } catch (e) { return null; }
}

/** Pure configuration check (no network). Returns { errors, warnings } of { code, fa }. */
function preflight(env = process.env, { nodeVersion = process.versions.node } = {}) {
  const errors = [], warnings = [];
  const E = (code, fa) => errors.push({ code, fa });
  const W = (code, fa) => warnings.push({ code, fa });
  const major = Number(String(nodeVersion).split('.')[0]);
  if (!(major >= 22)) E('node_version', `Node ${nodeVersion} قدیمی است؛ نسخهٔ ۲۲ یا بالاتر را در پنل انتخاب کنید.`);

  const pg = String(env.PGURL || '').trim();
  const pgu = pg ? parseDbUrl(pg) : null;
  if (!pg) E('pgurl_missing', 'PGURL تنظیم نشده (اتصال نقش payesh_runtime).');
  else if (!pgu) E('pgurl_invalid', 'PGURL یک نشانی postgres:// معتبر نیست.');

  const secret = String(env.GW_SECRET || env.PAYESH_TENANCY_SECRET || '');
  if (!secret) E('gw_secret_missing', 'GW_SECRET تنظیم نشده.');
  else if (secret.length < MIN_SECRET) E('gw_secret_weak', `GW_SECRET کوتاه است (حداقل ${MIN_SECRET} نویسهٔ تصادفی).`);

  const ppg = String(env.PAYESH_PLATFORM_PGURL || '').trim();
  const psec = String(env.PAYESH_PLATFORM_TOKEN_SECRET || '');
  if (!ppg && !psec) {
    W('platform_off', 'API پنل مالک خاموش است (PAYESH_PLATFORM_PGURL و PAYESH_PLATFORM_TOKEN_SECRET خالی) — ساخت مدرسه از پنل ممکن نیست.');
  } else {
    if (!ppg) E('platform_pgurl_missing', 'PAYESH_PLATFORM_TOKEN_SECRET هست ولی PAYESH_PLATFORM_PGURL نیست.');
    else if (!parseDbUrl(ppg)) E('platform_pgurl_invalid', 'PAYESH_PLATFORM_PGURL یک نشانی postgres:// معتبر نیست.');
    else if (pg && ppg === pg) E('platform_same_principal', 'PAYESH_PLATFORM_PGURL نباید با PGURL یکی باشد (دو نقش جدا لازم است).');
    if (!psec) E('platform_secret_missing', 'PAYESH_PLATFORM_PGURL هست ولی PAYESH_PLATFORM_TOKEN_SECRET نیست.');
    else if (psec.length < MIN_SECRET) E('platform_secret_weak', `PAYESH_PLATFORM_TOKEN_SECRET کوتاه است (حداقل ${MIN_SECRET} نویسه).`);
    else if (psec === secret) E('platform_secret_reused', 'PAYESH_PLATFORM_TOKEN_SECRET نباید با GW_SECRET یکی باشد.');
  }

  if (String(env.PAYESH_FIELD_CRYPTO || '').toLowerCase() === 'required' && !String(env.PAYESH_FIELD_KEYS || '').trim()) {
    E('field_keys_missing', 'PAYESH_FIELD_CRYPTO=required ولی PAYESH_FIELD_KEYS خالی است.');
  }
  if (!String(env.PAYESH_METRICS_TOKEN || '')) W('metrics_open', '/metrics بدون توکن باز است؛ روی میزبان عمومی PAYESH_METRICS_TOKEN بگذارید.');
  if (env.PLATFORM_API_DEBUG) W('debug_on', 'PLATFORM_API_DEBUG روشن است؛ در تولید خاموشش کنید.');
  if (String(env.PAYESH_PG_ADMIN || '')) W('admin_url_in_runtime', 'PAYESH_PG_ADMIN در محیط Gateway است؛ فقط برای admin.cjs لازم است — از محیط دائمی پاکش کنید.');
  for (const [name, u] of [['PGURL', pgu], ['PAYESH_PLATFORM_PGURL', ppg ? parseDbUrl(ppg) : null]]) {
    if (u && !LOCAL_HOSTS.has(u.host) && !u.ssl) W('db_no_tls', `${name} به میزبان غیرمحلی بدون sslmode=require وصل می‌شود.`);
  }
  for (const k of Object.keys(env)) {
    if (/^(GW_|PAYESH_)/.test(k) && !KNOWN.has(k)) W('unknown_var', `متغیر ناشناختهٔ ${k} (غلط تایپی؟) — فهرست: deploy/gateway/env-catalog.json`);
  }
  return { errors, warnings };
}

/** Database principal check. Returns { errors, warnings }; throws only on programming errors. */
async function dbPreflight(env = process.env, { timeoutMs = 10000 } = {}) {
  const errors = [], warnings = [];
  let Client;
  try { ({ Client } = require('pg')); } catch (e) {
    errors.push({ code: 'pg_driver_missing', fa: 'بستهٔ pg پیدا نشد (پوشهٔ node_modules بسته را کامل بارگذاری کنید).' });
    return { errors, warnings };
  }
  const targets = [['PGURL', env.PGURL, true]];
  if (env.PAYESH_PLATFORM_PGURL) targets.push(['PAYESH_PLATFORM_PGURL', env.PAYESH_PLATFORM_PGURL, false]);
  for (const [name, url, school] of targets) {
    const c = new Client({ connectionString: url, connectionTimeoutMillis: timeoutMs, application_name: 'payesh-gw-preflight' });
    try {
      await c.connect();
    } catch (e) {
      errors.push({ code: 'db_unreachable', fa: `${name}: اتصال به PostgreSQL برقرار نشد (${String((e && e.code) || (e && e.message) || e).slice(0, 80)}).` });
      try { await c.end(); } catch (_) { /* noop */ }
      continue;
    }
    try {
      const r = await c.query('select rolsuper, rolbypassrls, current_user as who from pg_roles where rolname = current_user');
      const row = r.rows[0] || {};
      if (row.rolsuper || row.rolbypassrls) {
        errors.push({ code: 'role_bypasses_rls', fa: `${name} با نقش «${row.who}» وصل شده که ${row.rolsuper ? 'SUPERUSER' : 'BYPASSRLS'} است؛ جداسازی مدرسه‌ها (RLS) اعمال نمی‌شود. نقش runtime جدا بسازید (admin.cjs logins).` });
      }
      /* each principal only probes its own schema (the school runtime has no USAGE on owner_platform) */
      const rel = school ? 'public.product_records' : 'owner_platform.platform_users';
      const s = await c.query(`select case when n.oid is not null and has_schema_privilege(n.oid, 'USAGE')
               then to_regclass($1::text) is not null else false end as ok
        from (select 1) x left join pg_namespace n on n.nspname = split_part($1::text, '.', 1)`, [rel]);
      if (!(s.rows[0] && s.rows[0].ok)) {
        errors.push(school
          ? { code: 'schema_missing', fa: 'جدول‌های چندمستأجری نیستند؛ اول «node deploy/gateway/admin.cjs migrate» را اجرا کنید.' }
          : { code: 'platform_schema_missing', fa: 'طرح owner_platform نیست یا این نقش به آن دسترسی ندارد؛ «admin.cjs migrate» و «admin.cjs logins» را اجرا کنید.' });
      }
    } catch (e) {
      errors.push({ code: 'db_check_failed', fa: `${name}: بررسی نقش ناموفق بود (${String((e && e.code) || (e && e.message) || e).slice(0, 80)}).` });
    } finally {
      try { await c.end(); } catch (e) { /* noop */ }
    }
  }
  return { errors, warnings };
}

function report(kind, items) {
  for (const it of items) console.error(JSON.stringify({ event: 'preflight_' + kind, code: it.code, fa: it.fa }));
}

async function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  const cfg = preflight(process.env);
  report('warning', cfg.warnings);
  if (cfg.errors.length) { report('error', cfg.errors); console.error('GW-PREFLIGHT REFUSED (config)'); process.exit(2); }
  const db = await dbPreflight(process.env);
  report('warning', db.warnings);
  if (db.errors.length) { report('error', db.errors); console.error('GW-PREFLIGHT REFUSED (database)'); process.exit(3); }
  if (check) { console.log('GW-PREFLIGHT OK'); return; }
  const gw = require(path.join(ROOT, 'server', 'gateway.js'));
  const host = process.env.HOST || '0.0.0.0';
  gw.server.listen(gw.PORT, host, () => {
    console.log(JSON.stringify({ event: 'gateway_listening', port: gw.PORT, host, instance: gw.INSTANCE, bundle: 'row-120' }));
  });
  process.on('SIGTERM', () => gw.drain('SIGTERM'));
  process.on('SIGINT', () => gw.drain('SIGINT'));
}

module.exports = { preflight, dbPreflight, parseDbUrl, main, MIN_SECRET };
if (require.main === module) main().catch((e) => { console.error('GW-PREFLIGHT CRASH', (e && e.message) || e); process.exit(1); });
