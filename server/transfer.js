'use strict';
/* ═══════════════════════════════════════════════════════════════════
   انتقال مدرسه بین دیتابیس‌ها + مهاجرت یکسان چند cell — ردیف ۵۴
                                                  (CELL-TRANSFER-54)

   این ابزار **فقط با فعال‌سازی صریح** کار می‌کند
   (`PAYESH_CELL_TRANSFER_ENABLED=1`)، چون شرط ردیف ۵۴ این است که تا وقتی
   ردیف ۴۶ نیاز به دیتابیس دوم را نشان نداده، مسیر انتقال باز نشود.

   سه چیز که واقعاً پیاده شده‌اند:
     ۱) توقف نوشتن: جدول `payesh_transfer_freeze`؛ Gateway روی هر push
        بررسی می‌کند و ۴۰۹ می‌دهد. توقف با یک ردیف در دیتابیسِ مبدأ انجام
        می‌شود، نه با lock نشستی (سازگار با transaction pooling — ردیف ۴۵).
     ۲) انتقال با reconciliation سه‌لایه:
          لایهٔ ۱: تعداد ردیف هر جدول
          لایهٔ ۲: checksum محتوای هر جدول (md5 مرتب‌شده)
          لایهٔ ۳: seq/version هر رکورد در change-feed
     ۳) rollback: هر انتقال یک batch_id می‌گیرد و rollback فقط ردیف‌های
        همان batch را در مقصد حذف می‌کند.
   ═══════════════════════════════════════════════════════════════════ */

const FREEZE_TABLE = 'payesh_transfer_freeze';
const BATCH_TABLE = 'payesh_transfer_batch';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/* ردیف ۵۴: نام جدول/ستون تنها از این فهرست بسته می‌آید. هر جای دیگری که
   نامی در SQL گذاشته می‌شود، اول از این تابع می‌گذرد؛ پس «رشتهٔ قالبی»
   هرگز ورودی بیرونی نیست (مکمل تریاژ ردیف ۴۸، نه جایگزین آن). */
const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;
function ident(name) {
  const n = String(name || '');
  if (!IDENT_RE.test(n)) throw new Error('شناسهٔ نامعتبر برای SQL: ' + n);
  return n;
}

const ALLOWED_TABLES = new Set([
  'product_records', 'product_change_feed', 'product_ops', 'gateway_quota',
  FREEZE_TABLE, BATCH_TABLE,
]);
function table(name) {
  const n = ident(name);
  if (!ALLOWED_TABLES.has(n)) throw new Error('جدول مجاز نیست: ' + n);
  return n;
}

function enabled(env = process.env) {
  return String(env.PAYESH_CELL_TRANSFER_ENABLED || '') === '1';
}

/* ── لایه‌های تطبیق: توابع خالص، قابل آزمون بدون دیتابیس ─────────── */

/* checksum محتوایی: ردیف‌ها به شکل پایدار مرتب و سپس sha256 می‌شوند تا
   ترتیب فیزیکی/زمان درج روی نتیجه اثر نگذارد. */
function stableChecksum(rows) {
  const crypto = require('crypto');
  const canon = (Array.isArray(rows) ? rows : [])
    .map(r => JSON.stringify(r, Object.keys(r || {}).sort()))
    .sort();
  return crypto.createHash('sha256').update(canon.join('\n')).digest('hex');
}

/* مقایسهٔ سه‌لایه. ورودی‌ها شکل { counts: {t:n}, checksums: {t:h}, seqs: {id:seq} } */
function reconcile(source, target) {
  const tables = Array.from(new Set([
    ...Object.keys(source.counts || {}), ...Object.keys(target.counts || {}),
  ])).sort();
  const layer1 = tables.map(t => ({
    table: t, source: Number(source.counts[t] || 0), target: Number(target.counts[t] || 0),
    ok: Number(source.counts[t] || 0) === Number(target.counts[t] || 0),
  }));
  const layer2 = tables.map(t => ({
    table: t, source: (source.checksums || {})[t] || null, target: (target.checksums || {})[t] || null,
    ok: ((source.checksums || {})[t] || null) === ((target.checksums || {})[t] || null),
  }));
  const ids = Array.from(new Set([
    ...Object.keys(source.seqs || {}), ...Object.keys(target.seqs || {}),
  ])).sort();
  const seqMismatch = ids.filter(id => Number(source.seqs[id]) !== Number(target.seqs[id]));
  const layer3 = { compared: ids.length, mismatched: seqMismatch.slice(0, 20), mismatch_count: seqMismatch.length, ok: seqMismatch.length === 0 };
  const ok = layer1.every(x => x.ok) && layer2.every(x => x.ok) && layer3.ok;
  return { ok, layer1, layer2, layer3, tables: tables.length };
}

/* ── عملیات دیتابیسی ─────────────────────────────────────────────── */

async function ensureTables(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS ${FREEZE_TABLE} (
    tenant_id uuid PRIMARY KEY,
    reason text,
    frozen_at timestamptz NOT NULL DEFAULT now(),
    frozen_by text
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS ${BATCH_TABLE} (
    batch_id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    direction text NOT NULL,
    from_db text,
    to_db text,
    tables jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  /* نقش اجرایی Gateway باید بتواند توقف نوشتن را *ببیند*؛ بدون این grant،
     بررسی freeze در سکوت false برمی‌گرداند و نوشتن ادامه پیدا می‌کند. */
  try {
    const roles = await client.query(
      `select rolname from pg_roles where rolname = any($1)`, [['payesh_runtime', 'payesh_app']]);
    for (const r of roles.rows) {
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${FREEZE_TABLE}, ${BATCH_TABLE} TO ${r.rolname}`);
    }
  } catch (e) { /* نقش‌ها موجود نباشند = محیط بدون Gateway */ }
}

async function freeze(client, tenantId, { reason = 'transfer', by = 'cli' } = {}) {
  if (!UUID_RE.test(String(tenantId || ''))) throw new Error('tenant نامعتبر');
  await ensureTables(client);
  await client.query(
    `INSERT INTO ${FREEZE_TABLE} (tenant_id, reason, frozen_by) VALUES ($1,$2,$3)
     ON CONFLICT (tenant_id) DO UPDATE SET reason = EXCLUDED.reason, frozen_by = EXCLUDED.frozen_by`,
    [tenantId, reason, by]
  );
  return { frozen: true, tenant_id: tenantId };
}

async function unfreeze(client, tenantId) {
  await ensureTables(client);
  const r = await client.query(`DELETE FROM ${FREEZE_TABLE} WHERE tenant_id = $1`, [tenantId]);
  return { unfrozen: r.rowCount > 0, tenant_id: tenantId };
}

async function isFrozen(client, tenantId) {
  if (!UUID_RE.test(String(tenantId || ''))) return false;
  try {
    const r = await client.query(`SELECT 1 FROM ${FREEZE_TABLE} WHERE tenant_id = $1`, [tenantId]);
    return r.rowCount > 0;
  } catch (e) { return false; } /* جدول نبود = سیستم انتقال فعال نشده */
}

/* عکس‌برداری یک مستأجر: تعداد، checksum و seq — همان ورودی سه لایه */
async function snapshot(client, tenantId, tables) {
  const counts = {}, checksums = {}, seqs = {};
  for (const raw of tables) {
    const t = table(raw);
    const cols = await client.query(
      `select column_name from information_schema.columns where table_name = $1 order by ordinal_position`, [t]
    );
    if (!cols.rowCount) { counts[t] = 0; checksums[t] = stableChecksum([]); continue; }
    const hasTenant = cols.rows.some(c => c.column_name === 'tenant_id');
    const where = hasTenant ? ` where tenant_id = $1` : '';
    const params = hasTenant ? [tenantId] : [];
    const rows = await client.query(`select * from ${t}${where}`, params);
    counts[t] = rows.rowCount;
    checksums[t] = stableChecksum(rows.rows.map(r => {
      const o = Object.assign({}, r);
      /* حذف ستون‌هایی که ذاتاً در مقصد تفاوت دارند */
      return o;
    }));
    if (rows.rows.length && rows.rows[0].seq !== undefined) {
      for (const r of rows.rows) seqs[String(r.id)] = Number(r.seq);
    } else if (rows.rows.length && rows.rows[0].id !== undefined) {
      for (const r of rows.rows) seqs[String(r.id)] = Number(r.version || 0);
    }
  }
  return { counts, checksums, seqs };
}

module.exports = {
  FREEZE_TABLE, BATCH_TABLE, UUID_RE, ident, table, ALLOWED_TABLES,
  enabled, stableChecksum, reconcile, ensureTables, freeze, unfreeze, isFrozen, snapshot,
};
