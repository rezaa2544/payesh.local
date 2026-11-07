#!/usr/bin/env node
'use strict';
/* ─────────────────────────────────────────────────────────────────────────
   بازپخشی (replay) الگوریتم صفحه‌بندی pull روی دیتابیس واقعی یک مدرسه.

   چرا: در اجرای شبیه‌سازی، بررسی W-04 نشان داد شماردن کل مجموعهٔ attendance
   با صفحه‌بندی، چند ردیف کمتر از شمار واقعی برمی‌گرداند. سرور در
   server/sync.js برای هر صفحه:
       rows = store.changedSince(name, since, ROW_LIMIT + 1)
       next_since = rows[ROW_LIMIT-1].updated_at
   و changedSince در server/db.js شرط «updated_at > since» دارد (اکید).
   پس هر ردیفی که همان میلی‌ثانیهٔ «آخرین ردیف صفحه» را داشته باشد و در آن
   صفحه جا نشده باشد، برای همیشه از دست می‌رود.

   این اسکریپت همان الگوریتم را عیناً روی SQLite تکرار می‌کند و ردیف‌های
   جاافتاده را با شناسه و مهر زمانی نشان می‌دهد. فقط می‌خواند.

   استفاده: node --experimental-sqlite docs/cloud/reports/evidence/sim/pagination-tie-replay.mjs /tmp/payesh-sim/school-0/payesh.sqlite
   ───────────────────────────────────────────────────────────────────────── */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const dbPath = process.argv[2] || '/tmp/payesh-sim/school-0/payesh.sqlite';
const COLLECTION = process.argv[3] || 'attendance';
const LIMIT = 3000; /* همان ROW_LIMIT در server/sync.js */

if (!fs.existsSync(dbPath)) {
  console.error('دیتابیس پیدا نشد: ' + dbPath);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const epoch = '1970-01-01T00:00:00.000Z';

const total = db.prepare('SELECT COUNT(*) AS n FROM records WHERE collection=? AND deleted_at IS NULL').get(COLLECTION).n;

let since = epoch;
let pages = 0;
const seen = new Set();
while (pages < 200) {
  const rows = db.prepare(
    'SELECT id, updated_at FROM records WHERE collection=? AND updated_at > ? ORDER BY updated_at ASC, id ASC LIMIT ?'
  ).all(COLLECTION, since, LIMIT + 1);
  if (!rows.length) break;
  const truncated = rows.length > LIMIT;
  const slice = truncated ? rows.slice(0, LIMIT) : rows;
  for (const r of slice) seen.add(r.id);
  pages++;
  if (!truncated) break;
  since = slice[slice.length - 1].updated_at; /* همان next_since سرور */
}

const all = db.prepare('SELECT id, updated_at, ref2, data FROM records WHERE collection=? AND deleted_at IS NULL').all(COLLECTION);
const missing = all.filter(r => !seen.has(r.id));
const ties = missing.map(m => ({
  id: m.id,
  updated_at: m.updated_at,
  rows_sharing_timestamp: db.prepare('SELECT COUNT(*) AS n FROM records WHERE collection=? AND updated_at=?').get(COLLECTION, m.updated_at).n,
}));

const out = {
  db: dbPath,
  collection: COLLECTION,
  row_limit: LIMIT,
  total_rows: total,
  pages,
  pulled_unique: seen.size,
  missing: missing.length,
  missing_pct: total ? Number(((missing.length / total) * 100).toFixed(4)) : 0,
  missing_rows: ties,
};
console.log(JSON.stringify(out, null, 2));
db.close();
