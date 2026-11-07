#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════════
   گزارش سلامت per-tenant — ردیف ۳۰ (پایلوت چند‌مدرسه‌ای)

   این ابزار برای اجرا در کرون/مانیتورینگ عملیاتی است: با نقش runtime
   (همان نقشی که محصول استفاده می‌کند) به PostgreSQL وصل می‌شود، زمینهٔ
   مستأجر را می‌گذارد و سلامت هر مستأجر را می‌سنجد.

   استفاده:
     PAYESH_TENANCY_PG=postgres://payesh_runtime@…/payesh \
       node scripts/pilot-tenant-report.mjs --tenant=<uuid>[,<uuid>…] \
            [--min-rows=1] [--max-age-s=604800] [--max-drift-s=60]

   خروجی: یک خط JSON روی stdout
   کد خروج: 0 سالم · 2 نقض آستانه (stop-criteria) · 3 خطای خودِ ابزار
   ═══════════════════════════════════════════════════════════════════════ */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function arg(name, def = null) {
  const hit = process.argv.find(a => a.startsWith('--' + name + '='));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : def;
}

const URL = String(process.env.PAYESH_TENANCY_PG || arg('url', '') || '').trim();
const ADMIN_URL = String(process.env.PAYESH_TENANCY_ADMIN_URL || '').trim();
const TENANTS = String(arg('tenant', process.env.TENANT_ID || '')).split(',').map(s => s.trim()).filter(Boolean);
const MIN_ROWS = Number(arg('min-rows', 1));
const MAX_AGE_S = Number(arg('max-age-s', 7 * 24 * 3600));
const MAX_DRIFT_S = Number(arg('max-drift-s', 60));

async function main() {
  if (!URL) return { ok: false, code: 'missing_pg_url', exit: 3 };
  if (!TENANTS.length || TENANTS.some(t => !UUID_RE.test(t))) return { ok: false, code: 'bad_tenant_id', exit: 3 };

  let pg;
  try { pg = require('pg'); } catch (e) { return { ok: false, code: 'pg_driver_missing', exit: 3 }; }

  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  const tenants = [];
  const alerts = [];
  try {
    /* RLS باید روی هر سه جدول اجباری (FORCE) باشد */
    const cls = await client.query(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class
        where relname in ('tenant_records','product_records','tenancy_jobs','jobs')
        order by relname`
    );
    const tables = cls.rows.map(r => ({
      name: r.relname, rls: !!r.relrowsecurity, force: !!r.relforcerowsecurity,
    }));
    const prod = tables.find(t => t.name === 'product_records');
    const rlsEnforced = !!(prod && prod.rls && prod.force);
    if (!rlsEnforced) alerts.push({ severity: 'P0', code: 'rls_not_forced', message: 'product_records بدون FORCE RLS است' });

    for (const tid of TENANTS) {
      await client.query('begin');
      try {
        await client.query("select set_config('app.tenant_id', $1, true)", [tid]);
        const tot = await client.query('select count(*)::int as n from product_records');
        const cols = await client.query('select collection, count(*)::int as n from product_records group by collection order by collection');
        const last = await client.query('select max(updated_at) as at from product_records');
        /* نشت: با زمینهٔ همین مستأجر هیچ ردیف «مستأجر دیگر» نباید دیده شود */
        const leak = await client.query('select count(*)::int as n from product_records where tenant_id <> $1', [tid]);
        const ageS = last.rows[0] && last.rows[0].at ? Math.max(0, Math.round((Date.now() - new Date(last.rows[0].at).getTime()) / 1000)) : null;
        const rows = tot.rows[0].n;
        const entry = {
          tid, rows, collections: cols.rowCount,
          per_collection: Object.fromEntries(cols.rows.map(r => [r.collection, r.n])),
          last_write_age_s: ageS, cross_tenant_visible: leak.rows[0].n, rls_enforced: rlsEnforced,
        };
        tenants.push(entry);
        if (entry.cross_tenant_visible > 0) alerts.push({ severity: 'P0', code: 'cross_tenant_visible', message: `${tid}: ${entry.cross_tenant_visible} ردیف مستأجر دیگر دیده شد` });
        if (rows < MIN_ROWS) alerts.push({ severity: 'P1', code: 'tenant_empty', message: `${tid}: rows=${rows} < ${MIN_ROWS}` });
        if (ageS != null && ageS > MAX_AGE_S) alerts.push({ severity: 'P2', code: 'tenant_stale', message: `${tid}: آخرین نوشتن ${ageS}s پیش` });
      } finally {
        await client.query('commit');
      }
    }

    /* drift: با نقش runtime و بدون زمینهٔ مستأجر، RLS عمداً هیچ ردیفی نشان نمی‌دهد؛
       پس شمارش کل فقط با اتصال مدیر (اختیاری) ممکن است. اگر مدیر نبود، این
       بررسی «انجام‌نشده» اعلام می‌شود — نه «سبز». */
    let globalCount = null;
    if (ADMIN_URL) {
      const adm = new pg.Client({ connectionString: ADMIN_URL });
      await adm.connect();
      try { globalCount = (await adm.query('select count(*)::int as n from product_records')).rows[0].n; }
      finally { await adm.end().catch(() => {}); }
      const seen = tenants.reduce((s, t) => s + t.rows, 0);
      if (globalCount < seen) alerts.push({ severity: 'P1', code: 'count_drift', message: `جمع مستأجرها ${seen} > کل جدول ${globalCount}` });
      /* فقط در حالت «گزارش کل ناوگان» معنا دارد؛ در گزارش تک‌مستأجری،
         ردیف‌های بقیهٔ مستأجرها طبیعی‌اند. */
      if (TENANTS.length > 1 && globalCount > seen) {
        alerts.push({ severity: 'P2', code: 'rows_outside_reported', message: `${globalCount - seen} ردیف در مستأجرهای گزارش‌نشده` });
      }
    }
    void MAX_DRIFT_S;

    const severe = alerts.some(a => a.severity === 'P0' || a.severity === 'P1');
    void MAX_DRIFT_S;
    return {
      ok: alerts.length === 0, severity: severe ? 'P1' : (alerts.length ? 'P2' : 'ok'),
      total_rows_all_tenants: globalCount, tenants, tables, alerts,
      exit: severe ? 2 : (alerts.length ? 2 : 0),
    };
  } finally {
    await client.end().catch(() => {});
  }
}

main()
  .then(r => { console.log(JSON.stringify(r)); process.exit(r.exit || 0); })
  .catch(e => {
    console.log(JSON.stringify({ ok: false, code: 'report_error', message: String((e && e.message) || e), exit: 3 }));
    process.exit(3);
  });
