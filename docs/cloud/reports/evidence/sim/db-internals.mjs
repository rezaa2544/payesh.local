#!/usr/bin/env node
'use strict';
/* ─────────────────────────────────────────────────────────────────────────
   خواندن مستقیمِ فقط-خواندنی از دیتابیس‌های شبیه‌سازی، بعد از پایان اجرا.

   چرا جدا از harness است: هش شاهد شبیه‌سازی (harness_sha256) باید با فایلی
   که واقعاً اجرا شد یکی بماند؛ پس اندازه‌گیری‌های تکمیلیِ پس از اجرا اینجا
   انجام می‌شوند و به همان دیتابیس‌های واقعی نگاه می‌کنند (هیچ نوشتنی ندارند).

   استفاده:
     node --experimental-sqlite docs/cloud/reports/evidence/sim/db-internals.mjs [root]
   ───────────────────────────────────────────────────────────────────────── */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] || '/tmp/payesh-sim';
const schools = [0, 1, 2, 3].filter(i => fs.existsSync(path.join(root, 'school-' + i, 'payesh.sqlite')));
const rows = [];

for (const i of schools) {
  const file = path.join(root, 'school-' + i, 'payesh.sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  const one = (sql, ...a) => { try { return db.prepare(sql).get(...a).n; } catch (e) { return 'ERR:' + e.message; } };
  const collections = {};
  for (const r of db.prepare('SELECT collection AS c, COUNT(*) AS n FROM records WHERE deleted_at IS NULL GROUP BY collection ORDER BY n DESC').all()) collections[r.c] = r.n;
  const deleted = one('SELECT COUNT(*) n FROM records WHERE deleted_at IS NOT NULL');
  const auditKinds = {};
  for (const r of db.prepare('SELECT action AS a, COUNT(*) AS n FROM audit GROUP BY action ORDER BY n DESC').all()) auditKinds[r.a] = r.n;
  const roles = {};
  for (const r of db.prepare("SELECT json_extract(data,'$.role') AS r, COUNT(*) AS n FROM records WHERE collection='users' AND deleted_at IS NULL GROUP BY r").all()) roles[r.r] = r.n;
  rows.push({
    school: i,
    db_bytes: fs.statSync(file).size,
    tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name),
    integrity: String(db.prepare('PRAGMA integrity_check').get().integrity_check),
    audit_rows: one('SELECT COUNT(*) n FROM audit'),
    sync_log_rows: one('SELECT COUNT(*) n FROM sync_log'),
    sessions: one('SELECT COUNT(*) n FROM sessions'),
    devices: one('SELECT COUNT(*) n FROM devices'),
    conflicts: collections.conflicts || 0,
    deleted_rows: deleted,
    audit_by_action: auditKinds,
    users_by_role: roles,
    collections,
  });
  db.close();
}

console.log(JSON.stringify({ root, generated_at: new Date().toISOString(), schools: rows }, null, 2));
