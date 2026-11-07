'use strict';
/* ═══════════════════════════════════════════════════════════════════
   مهاجرت بدنهٔ محصول از SQLite به جدول چندمستأجری PostgreSQL (F‑05)
   ───────────────────────────────────────────────────────────────────
   اجرا (مهاجرت):
     PAYESH_TENANCY_ADMIN_URL=postgres://… \
     node scripts/tenancy-migrate-product.js --db <path.db> --tenant <uuid> --apply

   اجرا (rollback، فقط مستأجر هدف):
     PAYESH_TENANCY_ADMIN_URL=… PAYESH_TENANCY_CONFIRM=1 \
     node scripts/tenancy-migrate-product.js --tenant <uuid> --rollback

   قواعد:
     • tenant_id فقط از آرگومان/محیط این ابزار می‌آید (ابزار مدیر)، نه از داده.
     • هر ردیف با همان version و deleted_at منتقل می‌شود؛ idempotent است.
     • rollback فقط ردیف‌های همان tenant را حذف می‌کند (بازرسی RLS را خراب نمی‌کند).
   ═══════════════════════════════════════════════════════════════════ */
const path = require('node:path');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function arg(name, def = null) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : def;
}

async function main() {
  const tenant = String(arg('tenant', process.env.TENANT_ID || '')).trim();
  if (!UUID_RE.test(tenant)) throw new Error('--tenant یک UUID معتبر لازم است');
  const adminUrl = String(process.env.PAYESH_TENANCY_ADMIN_URL || '').trim();
  if (!adminUrl) throw new Error('PAYESH_TENANCY_ADMIN_URL لازم است');

  const { Client } = require('pg');
  const c = new Client({ connectionString: adminUrl });
  await c.connect();
  try {
    if (process.argv.includes('--rollback')) {
      if (String(process.env.PAYESH_TENANCY_CONFIRM || '') !== '1') {
        throw new Error('برای rollback باید PAYESH_TENANCY_CONFIRM=1 تنظیم شود');
      }
      await c.query('BEGIN');
      await c.query("select set_config('app.tenant_id', $1, true)", [tenant]);
      const del = await c.query('delete from product_records where tenant_id = $1 returning record_id', [tenant]);
      await c.query('COMMIT');
      console.log(JSON.stringify({ ok: true, mode: 'rollback', tenant, deleted: del.rowCount }));
      return;
    }

    const dbPath = String(arg('db', '')).trim();
    if (!dbPath) throw new Error('--db مسیر پایگاه‌دادهٔ SQLite لازم است');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
    let rows = [];
    try {
      rows = db.prepare('SELECT collection, id, data, version, deleted_at FROM records').all();
    } catch (e) {
      throw new Error('جدول records خوانده نشد: ' + e.message);
    }
    db.close();

    await c.query('BEGIN');
    await c.query("select set_config('app.tenant_id', $1, true)", [tenant]);
    let imported = 0;
    for (const r of rows) {
      const data = JSON.parse(r.data || '{}');
      delete data.tenant_id; delete data.school_id;
      await c.query(
        `insert into product_records (tenant_id, collection, record_id, version, data, deleted_at)
         values ($1, $2, $3, $4, $5::jsonb, $6)
         on conflict (tenant_id, collection, record_id)
         do update set data = excluded.data, version = excluded.version, deleted_at = excluded.deleted_at, updated_at = now()`,
        [tenant, String(r.collection), Number(r.id), Number(r.version) || 1, JSON.stringify(data), r.deleted_at || null]
      );
      imported++;
    }
    await c.query('COMMIT');
    console.log(JSON.stringify({ ok: true, mode: 'apply', tenant, imported }));
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw e;
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error('migrate-product failed:', e.message); process.exit(1); });
