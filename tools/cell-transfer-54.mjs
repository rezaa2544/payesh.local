#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   ابزار ردیف ۵۴ — مهاجرت یکسان چند cell و انتقال مدرسه بین دیتابیس‌ها

   فعال‌سازی صریح لازم است (شرط ردیف ۵۴):
     PAYESH_CELL_TRANSFER_ENABLED=1

   حالت‌ها:
     --cells url1,url2,...                 اجرای یکسان migration روی همهٔ cellها + اثر انگشت اسکیما
     --transfer --tenant <uuid> --from <url> --to <url>
                                           توقف نوشتن → انتقال → تطبیق سه‌لایه (و rollback خودکار در شکست)
     --freeze --tenant <uuid> --from <url>
     --unfreeze --tenant <uuid> --from <url>
     --rollback --batch <uuid> --to <url>
     --status --tenant <uuid> --from <url>  آیا نوشتن متوقف است؟

   کد خروج: ۰ موفق · ۱ شکست/عدم تطبیق · ۲ ورودی نامعتبر · ۳ غیرفعال (بدون مجوز)
   ═══════════════════════════════════════════════════════════════════ */
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tenancy = require(path.join(ROOT, 'server', 'tenancy.js'));
const transfer = require(path.join(ROOT, 'server', 'transfer.js'));
const { Client } = require('pg');

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const flag = n => argv.includes('--' + n);

const TABLES = [tenancy.PRODUCT_TABLE, tenancy.FEED_TABLE, tenancy.OPS_TABLE, tenancy.QUOTA_TABLE];

async function connect(url) {
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await c.connect();
  return c;
}

/* اثر انگشت اسکیما: همان چیزی که «یکسان بودن» را قابل سنجش می‌کند */
async function schemaFingerprint(c) {
  const q = await c.query(`
    select table_name, column_name, data_type, is_nullable, column_default
    from information_schema.columns
    where table_schema = 'public' and table_name = any($1)
    order by table_name, ordinal_position`, [TABLES]);
  const policies = await c.query(
    `select tablename, policyname, cmd, qual from pg_policies where schemaname = 'public' and tablename = any($1)
     order by tablename, policyname`, [TABLES]);
  const body = JSON.stringify({ cols: q.rows, pol: policies.rows });
  return { sha256: crypto.createHash('sha256').update(body).digest('hex'), columns: q.rowCount, policies: policies.rowCount };
}

async function migrateCells(urls) {
  const out = [];
  for (const url of urls) {
    const c = await connect(url);
    try {
      const before = await schemaFingerprint(c);
      const m1 = await tenancy.migrate(c);
      const after1 = await schemaFingerprint(c);
      /* بار دوم باید هیچ تغییری ندهد (idempotent) */
      await tenancy.migrate(c);
      const after2 = await schemaFingerprint(c);
      out.push({
        url: url.replace(/\/\/[^@]+@/, '//***@'),
        statements: m1.statements || m1.length || null,
        fingerprint: after1.sha256,
        idempotent: after1.sha256 === after2.sha256,
        columns: after1.columns, policies: after1.policies,
        changed_from_empty: before.sha256 !== after1.sha256,
      });
    } finally { await c.end(); }
  }
  const fps = new Set(out.map(o => o.fingerprint));
  const ok = fps.size === 1 && out.every(o => o.idempotent);
  return { ok, cells: out, uniform_fingerprint: fps.size === 1, fingerprint: out[0] && out[0].fingerprint };
}

async function primaryKeyOf(client, rawTable) {
  const table = transfer.table(rawTable);
  const q = await client.query(`
    select a.attname as col
    from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
    where i.indrelid = $1::regclass and i.indisprimary
    order by array_position(i.indkey::int2[], a.attnum)`, [table]);
  if (q.rowCount) return q.rows.map(r => r.col);
  const hasId = await client.query(
    `select 1 from information_schema.columns where table_name = $1 and column_name = 'id'`, [table]);
  return hasId.rowCount ? ['id'] : null;
}

/* Row 66 fix: copied rows keep their source serial values (e.g. change-feed seq).
   Without this, the target's sequence still starts at 1 and the first new write
   after a school transfer collides with a copied row (23505 unique_violation).
   Each serial/identity column's sequence is moved to at least max(column). */
async function advanceSequences(dst, t, names) {
  for (const raw of names) {
    const col = transfer.ident(raw);
    const s = await dst.query('select pg_get_serial_sequence($1, $2) as seq', [t, col]);
    const seq = s.rows[0] && s.rows[0].seq;
    if (!seq) continue;
    const m = await dst.query(`select coalesce(max(${col}), 0)::bigint as mx, pg_sequence_last_value($1::regclass) as lv from ${t}`, [seq]);
    const mx = Number(m.rows[0].mx || 0);
    const lv = m.rows[0].lv == null ? 0 : Number(m.rows[0].lv);
    if (mx > lv) await dst.query('select setval($1::regclass, $2::bigint, true)', [seq, mx]);
  }
}

async function copyTenant(src, dst, tenantId) {
  const batchId = crypto.randomUUID();
  const inserted = {};
  const cols = {};
  for (const raw of TABLES) {
    const t = transfer.table(raw);
    const c = await src.query(
      `select column_name from information_schema.columns where table_name = $1 order by ordinal_position`, [t]);
    if (!c.rowCount) { inserted[t] = []; continue; }
    const names = c.rows.map(r => r.column_name);
    cols[t] = names;
    const hasTenant = names.includes('tenant_id');
    const rows = await src.query(`select * from ${t}${hasTenant ? ' where tenant_id = $1' : ''}`, hasTenant ? [tenantId] : []);
    const pk = await primaryKeyOf(src, t);
    inserted[t] = { pk: pk || [], rows: [] };
    for (const row of rows.rows) {
      const vals = names.map(n => row[n]);
      const ph = names.map((_n, i) => '$' + (i + 1)).join(',');
      /* on conflict do nothing: انتقال دوباره ردیف تکراری نمی‌سازد */
      const r = await dst.query(
        `insert into ${t} (${names.join(',')}) values (${ph}) on conflict do nothing returning 1`, vals);
      if (r.rowCount > 0 && pk) inserted[t].rows.push(pk.map(c => row[c]));
    }
    await advanceSequences(dst, t, names);
  }
  await transfer.ensureTables(dst);
  await dst.query(
    `insert into ${transfer.BATCH_TABLE} (batch_id, tenant_id, direction, tables) values ($1,$2,'copy',$3)`,
    [batchId, tenantId, JSON.stringify(inserted)]);
  return { batchId, inserted };
}

async function transferTenant({ fromUrl, toUrl, tenantId }) {
  const src = await connect(fromUrl);
  const dst = await connect(toUrl);
  const out = { tenant_id: tenantId, steps: [] };
  try {
    /* ۰) اسکیما باید یکسان باشد، وگرنه انتقال بی‌معنی است */
    const fsrc = await schemaFingerprint(src);
    const fdst = await schemaFingerprint(dst);
    out.steps.push({ step: 'schema', ok: fsrc.sha256 === fdst.sha256, from: fsrc.sha256, to: fdst.sha256 });
    if (fsrc.sha256 !== fdst.sha256) return Object.assign(out, { ok: false, reason: 'schema_mismatch' });

    /* ۱) توقف نوشتن */
    await transfer.freeze(src, tenantId, { reason: 'school-transfer', by: 'cell-transfer-54' });
    out.steps.push({ step: 'freeze', ok: true });

    /* ۲) عکس‌برداری مبدأ، انتقال، عکس‌برداری مقصد */
    const before = await transfer.snapshot(src, tenantId, TABLES);
    const copied = await copyTenant(src, dst, tenantId);
    const after = await transfer.snapshot(dst, tenantId, TABLES);
    out.batch_id = copied.batchId;
    out.steps.push({ step: 'copy', ok: true, inserted: Object.fromEntries(Object.entries(copied.inserted).map(([k, v]) => [k, (v && v.rows ? v.rows.length : 0)])) });

    /* ۳) تطبیق سه‌لایه */
    const rec = transfer.reconcile(before, after);
    out.reconciliation = rec;
    out.steps.push({ step: 'reconcile', ok: rec.ok });

    if (!rec.ok) {
      const rb = await rollbackBatch(dst, copied.batchId);
      out.steps.push({ step: 'auto_rollback', ok: rb.ok, removed: rb.removed });
      return Object.assign(out, { ok: false, reason: 'reconciliation_failed' });
    }
    return Object.assign(out, { ok: true, still_frozen: true });
  } finally { await src.end(); await dst.end(); }
}

async function rollbackBatch(target, batchId) {
  await transfer.ensureTables(target);
  const q = await target.query(`select tenant_id, tables from ${transfer.BATCH_TABLE} where batch_id = $1`, [batchId]);
  if (!q.rowCount) return { ok: false, removed: 0, reason: 'batch_not_found' };
  const tables = q.rows[0].tables || {};
  let removed = 0;
  for (const [raw, meta] of Object.entries(tables)) {
    if (!meta || !Array.isArray(meta.rows) || !meta.rows.length || !Array.isArray(meta.pk) || !meta.pk.length) continue;
    const t = transfer.table(raw);
    const cols = meta.pk.map(c => transfer.ident(c)).join(', ');
    const params = [];
    const tuples = meta.rows.map(pkRow => {
      const ph = pkRow.map(v => { params.push(v); return '$' + params.length; });
      return '(' + ph.join(',') + ')';
    });
    const r = await target.query(`delete from ${t} where (${cols}) in (${tuples.join(',')})`, params);
    removed += r.rowCount;
  }
  await target.query(`delete from ${transfer.BATCH_TABLE} where batch_id = $1`, [batchId]);
  return { ok: true, removed };
}

async function main() {
  if (!transfer.enabled()) {
    console.error('CELL-TRANSFER-54-DISABLED — برای فعال‌سازی PAYESH_CELL_TRANSFER_ENABLED=1 لازم است');
    console.error('  (شرط ردیف ۵۴: تا وقتی ردیف ۴۶ نیاز به دیتابیس دوم را نشان نداده، این مسیر باز نمی‌شود)');
    process.exit(3);
  }
  try {
    if (arg('cells')) {
      const urls = String(arg('cells')).split(',').map(s => s.trim()).filter(Boolean);
      if (!urls.length) throw new Error('فهرست cell خالی است');
      const r = await migrateCells(urls);
      console.log(JSON.stringify(r, null, 2));
      console.log(r.ok ? 'CELL-MIGRATE-54-OK' : 'CELL-MIGRATE-54-FAILED');
      process.exit(r.ok ? 0 : 1);
    }
    if (flag('transfer')) {
      const tenantId = arg('tenant'); const fromUrl = arg('from'); const toUrl = arg('to');
      if (!transfer.UUID_RE.test(String(tenantId || ''))) throw new Error('tenant نامعتبر');
      if (!fromUrl || !toUrl) throw new Error('--from و --to لازم است');
      if (fromUrl === toUrl) throw new Error('مبدأ و مقصد یکی است');
      const r = await transferTenant({ fromUrl, toUrl, tenantId });
      console.log(JSON.stringify(r, null, 2));
      console.log(r.ok ? 'CELL-TRANSFER-54-OK' : 'CELL-TRANSFER-54-FAILED');
      process.exit(r.ok ? 0 : 1);
    }
    if (flag('freeze')) {
      const c = await connect(arg('from'));
      try {
        const r = await transfer.freeze(c, arg('tenant'), { reason: arg('reason', 'manual'), by: 'cell-transfer-54' });
        console.log(JSON.stringify(r));
        process.exit(0);
      } finally { await c.end(); }
    }
    if (flag('unfreeze')) {
      const c = await connect(arg('from'));
      try {
        const r = await transfer.unfreeze(c, arg('tenant'));
        console.log(JSON.stringify(r));
        process.exit(r.unfrozen ? 0 : 1);
      } finally { await c.end(); }
    }
    if (flag('status')) {
      const c = await connect(arg('from'));
      try {
        const frozen = await transfer.isFrozen(c, arg('tenant'));
        console.log(JSON.stringify({ tenant_id: arg('tenant'), frozen }));
        process.exit(0);
      } finally { await c.end(); }
    }
    if (flag('rollback')) {
      const c = await connect(arg('to'));
      try {
        const r = await rollbackBatch(c, arg('batch'));
        console.log(JSON.stringify(r));
        process.exit(r.ok ? 0 : 1);
      } finally { await c.end(); }
    }
    console.error('حالت نامشخص: یکی از --cells/--transfer/--unfreeze/--status/--rollback لازم است');
    process.exit(2);
  } catch (e) {
    console.error('CELL-TRANSFER-54-ERROR ' + e.message);
    process.exit(2);
  }
}

main();
