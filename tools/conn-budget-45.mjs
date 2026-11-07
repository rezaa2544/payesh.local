#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   بودجهٔ اتصال و pooling — ردیف ۴۵            (CONN-BUDGET-45)

   سه کار، هیچ‌کدام تزئینی نیست:
     ۱) فرمول بودجه: نمونه‌ها × pool + ذخیره ≤ ظرفیت اتصال DB.
        پیکربندیِ نامعتبر (NaN، صفر، منفی، خارج از سقف) باید **رد** شود.
     ۲) ممیزی «lock نشست/حالت نشستی»: با transaction pooling هر چیزی که به
        نشست گره بخورد (advisory lock، LISTEN، SET SESSION، جدول موقت،
        prepared statement سطح نشست) درست کار نمی‌کند. این ممیزی همان را
        روی کد واقعی می‌گردد و **قرمز** می‌شود اگر پیدا شود.
     ۳) انطباق پیکربندی PgBouncer با فرمول (pool_mode=transaction و
        default_pool_size ≤ بودجه) — تا فایل مستقرشده از سند جدا نیفتد.

   اجرا:
     node tools/conn-budget-45.mjs                       # بودجهٔ پیش‌فرض
     node tools/conn-budget-45.mjs --instances 3 --pool 8 --cap 100
     node tools/conn-budget-45.mjs --json-out /tmp/b.json
   کد خروج: ۰ = بودجه در چارچوب و پیکربندی سالم · ۱ = نقض بودجه یا حالت
            نشستی · ۲ = پیکربندی نامعتبر (NaN/خارج از سقف)
   ═══════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const tenancy = require(path.join(ROOT, 'server', 'tenancy.js'));

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const flag = n => argv.includes('--' + n);

/* ── سقف‌های سخت (از سند، نه از آرزو) ── */
const HARD = {
  max_instances: 12,
  max_pool_per_instance: 50,
  min_cap: 20,
  max_cap: 5000,
  reserve_per_instance: 2,   /* اتصال مدیریت/مهاجرت/پایش */
  spike_headroom_pct: 20,    /* برای لحظهٔ rollout/دو-نسخه‌ای */
};

function num(name, raw, { min, max, fallback }) {
  const v = raw === null || raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(v) || Number.isNaN(v)) throw new Error(`${name}=NaN/نامعتبر`);
  if (!Number.isInteger(v)) throw new Error(`${name} باید عدد صحیح باشد (${raw})`);
  if (v < min || v > max) throw new Error(`${name}=${v} خارج از بازهٔ [${min},${max}]`);
  return v;
}

export function computeBudget({ instances, pool, cap, poolMode = 'transaction' }) {
  const perInstance = pool + HARD.reserve_per_instance;
  const required = instances * perInstance;
  const headroom = Math.round(required * (1 + HARD.spike_headroom_pct / 100));
  return {
    instances, pool_per_instance: pool, reserve_per_instance: HARD.reserve_per_instance,
    per_instance_total: perInstance,
    required_connections: required,
    with_spike_headroom: headroom,
    provider_cap: cap,
    fits: headroom <= cap,
    spare_after_headroom: cap - headroom,
    max_instances_at_this_pool: Math.floor((cap / (1 + HARD.spike_headroom_pct / 100)) / perInstance),
    pool_mode: poolMode,
  };
}

/* ── ممیزی حالت نشستی (transaction pooling) ─────────────────────────
   الگوها عمداً محدود و صریح‌اند: هر موردی که با transaction pooling می‌شکند. */
const SESSION_PATTERNS = [
  { id: 'advisory_lock', re: /\bpg_(try_)?advisory_(x?lock|x?unlock)\b/i },
  { id: 'listen_notify', re: /\b(LISTEN\s+[a-z_]|NOTIFY\s+[a-z_])/i },
  { id: 'set_session', re: /\bSET\s+SESSION\b/i },
  { id: 'set_config_session', re: /set_config\s*\([^)]*,\s*false\s*\)/i },
  { id: 'temp_table', re: /\bCREATE\s+(TEMP|TEMPORARY)\s+TABLE\b/i },
  { id: 'session_prepare', re: /\bPREPARE\s+[a-z_]/i },
];

export function auditSessionState(files) {
  const hits = [];
  for (const rel of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { continue; }
    /* محدودسازی عمدی: تعریف خودِ الگو در همین ابزار و در سند، حالت نشستی نیست */
    const withoutComments = text.split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
    for (const p of SESSION_PATTERNS) {
      const m = p.re.exec(withoutComments);
      if (m) hits.push({ file: rel, pattern: p.id, sample: String(m[0]).slice(0, 60) });
    }
  }
  return hits;
}

/* ── انطباق pgbouncer.ini با بودجه ── */
export function parsePgbouncerIni(text) {
  const out = {};
  out.__sections = [];
  let section = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = /^\[([a-z_]+)\]$/i.exec(line);
    if (sec) { section = sec[1].toLowerCase(); out.__sections.push(section); continue; }
    const m = /^([a-z_]+)\s*=\s*(.+)$/i.exec(line);
    /* کلیدهای داخل [databases] نام پایگاه‌اند، نه تنظیم pooling */
    if (m && section !== 'databases') out[m[1].toLowerCase()] = m[2].trim();
    else if (m && section === 'databases') { out.__databases = out.__databases || []; out.__databases.push(m[1]); }
  }
  return out;
}

export function checkPgbouncerIni(iniText, budget) {
  const ini = parsePgbouncerIni(iniText);
  const problems = [];
  if (!(ini.__sections || []).includes('databases') || !(ini.__databases || []).length) problems.push('بخش [databases] یا مدخل پایگاه نیست');
  if ((ini['pool_mode'] || '').toLowerCase() !== 'transaction') problems.push('pool_mode باید transaction باشد (نه session)');
  const defPool = Number(ini['default_pool_size']);
  if (!Number.isFinite(defPool) || defPool <= 0) problems.push('default_pool_size نامعتبر');
  else if (defPool > budget.pool_per_instance) problems.push(`default_pool_size=${defPool} از بودجهٔ هر نمونه (${budget.pool_per_instance}) بیشتر است`);
  const maxClient = Number(ini['max_client_conn']);
  if (!Number.isFinite(maxClient) || maxClient <= 0) problems.push('max_client_conn نامعتبر');
  const reserve = Number(ini['reserve_pool_size']);
  if (!Number.isFinite(reserve) || reserve < 0) problems.push('reserve_pool_size نامعتبر');
  return { problems, ini: { pool_mode: ini['pool_mode'], default_pool_size: defPool, max_client_conn: maxClient, reserve_pool_size: reserve } };
}

function listServerFiles() {
  const out = [];
  const walk = dir => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir + '/' + e.name;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.js')) out.push(rel);
    }
  };
  walk('server');
  return out.sort();
}

/* ── main ── */
function main() {
  const jsonOut = arg('json-out', null);
  let instances, pool, cap;
  try {
    instances = num('instances', arg('instances', process.env.CB_INSTANCES), { min: 1, max: HARD.max_instances, fallback: 2 });
    /* پیش‌فرض = مقدار توصیه‌شدهٔ استقرار (PAYESH_PG_POOL_MAX=12)؛ پیش‌فرض کد ۴ است و در بار هدف کافی نیست */
    pool = num('pool', arg('pool', process.env.CB_POOL), { min: 1, max: HARD.max_pool_per_instance, fallback: 12 });
    cap = num('cap', arg('cap', process.env.CB_CAP), { min: HARD.min_cap, max: HARD.max_cap, fallback: Number(process.env.CB_CAP || 100) });
  } catch (e) {
    console.error('CONN-BUDGET-45-BAD-CONFIG ' + e.message);
    process.exit(2);
  }

  const budget = computeBudget({ instances, pool, cap });
  const files = listServerFiles();
  const sessionHits = auditSessionState(files);

  const iniPath = path.join(ROOT, 'deploy', 'pgbouncer', 'pgbouncer.ini');
  let iniCheck = { problems: ['فایل پیکربندی PgBouncer نیست'], ini: {} };
  if (fs.existsSync(iniPath)) iniCheck = checkPgbouncerIni(fs.readFileSync(iniPath, 'utf8'), budget);

  console.log(`# نمونه‌ها × (pool + ذخیره) = ${instances} × (${pool} + ${HARD.reserve_per_instance}) = ${budget.required_connections}`);
  console.log(`# با ${HARD.spike_headroom_pct}٪ سربار پیک/rollout = ${budget.with_spike_headroom} · ظرفیت provider=${cap} ⇒ ${budget.fits ? 'PASS' : 'FAIL'} (باقی‌مانده ${budget.spare_after_headroom})`);
  console.log(`# بیشترین نمونهٔ مجاز با این pool = ${budget.max_instances_at_this_pool}`);
  console.log(`BUDGET instances=${instances} pool=${pool} required=${budget.required_connections} headroom=${budget.with_spike_headroom} cap=${cap} fits=${budget.fits}`);

  console.log(`# ممیزی حالت نشستی روی ${files.length} فایل server/**: ${sessionHits.length} یافته`);
  for (const h of sessionHits) console.log(`SESSION-STATE ${h.pattern} ${h.file} «${h.sample}»`);

  console.log(`# PgBouncer: ${iniCheck.problems.length ? 'مشکل' : 'سازگار'} ${iniCheck.problems.join(' | ')}`);
  console.log(`PGBOUNCER ${JSON.stringify(iniCheck.ini)}`);

  if (jsonOut) {
    fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
    fs.writeFileSync(path.resolve(jsonOut), JSON.stringify({
      at: new Date().toISOString(), budget, session_state_hits: sessionHits,
      pgbouncer: iniCheck, server_files_scanned: files.length, hard_limits: HARD,
    }, null, 2));
  }

  const ok = budget.fits && sessionHits.length === 0 && iniCheck.problems.length === 0;
  console.log(ok ? 'CONN-BUDGET-45-OK' : 'CONN-BUDGET-45-FAILED');
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
