#!/usr/bin/env node
/* ردیف ۸۷ — چرخش کلید رمزنگاری فیلدی (و مهاجرت متن سادهٔ قدیمی)

   ترتیب چرخش (کار مالک؛ کلید اصلی/KMS دست مالک است):
     1) کلید نو بسازید:  node tools/field-rekey-87.mjs --new-key
     2) PAYESH_FIELD_KEYS="k2:<نو>,k1:<قدیم>"  (کلید نو اول)
     3) سرور را متوقف کنید و اجرا کنید:
          node --experimental-sqlite tools/field-rekey-87.mjs --sqlite <PAYESH_DATA>/payesh.sqlite
        برای PostgreSQL (هر مستأجر):
          PAYESH_TENANCY_PG=postgres://… node tools/field-rekey-87.mjs --pg-tenant <uuid>
     4) وقتی خروجی «remaining_old_kid=0» شد، k1 را از PAYESH_FIELD_KEYS بردارید.
   خروجی هیچ کلید یا متن ساده‌ای چاپ نمی‌کند. */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function main(argv = process.argv.slice(2)) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  if (argv.includes('--new-key')) {
    /* فقط روی ترمینال مالک چاپ می‌شود؛ هرگز در مخزن ذخیره نکنید */
    console.log(randomBytes(32).toString('base64'));
    return 0;
  }
  const fc = require(path.join(ROOT, 'server/field-crypto.js'));
  const kr = fc.keyring();
  if (!kr.active) { console.error('FIELD-REKEY-87-FAILED PAYESH_FIELD_KEYS is empty'); return 2; }
  const sqlite = arg('--sqlite');
  const tenant = arg('--pg-tenant');
  if (!sqlite && !tenant) { console.error('usage: --sqlite <file> | --pg-tenant <uuid> | --new-key'); return 2; }
  if (sqlite) {
    const { openStore } = require(path.join(ROOT, 'server/db.js'));
    const store = openStore(path.resolve(sqlite));           /* باز کردن خودش مهاجرت می‌کند */
    const again = store.rekeyFields();
    let old = 0;
    for (const c of fc.sealedCollections()) {
      for (const r of store.db.prepare('SELECT data FROM records WHERE collection=?').all(c)) {
        try { if (fc.needsReseal(c, JSON.parse(r.data))) old++; } catch (e) { /* */ }
      }
    }
    store.close();
    console.log(`FIELD-REKEY-87 sqlite active_kid=${kr.active} second_pass=${JSON.stringify(again)} remaining_old_kid=${old}`);
    if (old) return 1;
  }
  if (tenant) {
    const tenancy = require(path.join(ROOT, 'server/tenancy.js'));
    const cs = process.env.PAYESH_TENANCY_PG || '';
    if (!cs) { console.error('FIELD-REKEY-87-FAILED PAYESH_TENANCY_PG is empty'); return 2; }
    const pool = tenancy.createPool({ connectionString: cs });
    try {
      const r = await tenancy.rekeyFields(pool, tenant);
      const again = await tenancy.rekeyFields(pool, tenant);
      console.log(`FIELD-REKEY-87 pg tenant=${tenant} active_kid=${kr.active} resealed=${JSON.stringify(r)} remaining_old_kid=${again.records + again.feed}`);
      if (again.records + again.feed) return 1;
    } finally { await pool.end().catch(() => {}); }
  }
  console.log('FIELD-REKEY-87-OK');
  return 0;
}

const isMain = () => { try { return import.meta.url === pathToFileURL(realpathSync(path.resolve(process.argv[1]))).href; } catch (e) { return false; } };
if (process.argv[1] && isMain()) {
  main().then((c) => process.exit(c), (e) => { console.error('FIELD-REKEY-87-FAILED ' + (e && e.code ? e.code : e && e.message)); process.exit(1); });
}
