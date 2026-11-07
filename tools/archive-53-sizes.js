'use strict';
/* ═══════════════════════════════════════════════════════════════════
   اندازه‌گیری اندازهٔ جدول‌ها پیش و پس از آرشیو — ردیف ۵۳

   اجرا: node --experimental-sqlite --disable-warning=ExperimentalWarning \
           tools/archive-53-sizes.js
   خروجی سبز: ARCHIVE-53-SIZES-OK

   اعداد این ابزار همان اعدادی است که در docs/cloud/53-cold-archive.md
   و در کارت نوشن ردیف ۵۳ ثبت می‌شود. آستانهٔ پذیرش: تعداد ردیف جدول
   داغ پس از آرشیو باید زیر hot_row_threshold (۶۰٬۰۰۰) باشد.
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore } = require('../server/db');
const archive = require('../server/archive');
const { startStub } = require('../tests/lib/s3-stub');
const { seed } = require('../tests/lib/seed-53');

const NOW = new Date('2026-11-07T00:00:00.000Z');
const TOTAL = Number(process.env.AR53_ROWS || 120000);
const HOT = archive.POLICY.hot_months;

function perTable(store) {
  const rows = store.db.prepare(
    `SELECT collection, COUNT(*) n, COALESCE(SUM(LENGTH(data)),0) bytes
       FROM records WHERE deleted_at IS NULL GROUP BY collection ORDER BY collection`
  ).all();
  const out = {};
  for (const r of rows) out[r.collection] = { rows: r.n, bytes: r.bytes };
  return out;
}
const kb = n => (n / 1024).toFixed(0) + ' KiB';

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-ar53-sizes-'));
  const store = openStore(path.join(dir, 'db.sqlite'));
  const stub = await startStub({ accessKey: 'ak-53', secret: 'sk-53', bucket: 'payesh-53' });

  const cols = archive.POLICY.collections.slice(0, 5);
  seed(store, { totalRows: TOTAL, collections: cols, now: NOW });

  const before = perTable(store);
  const hotBefore = archive.hotWindowStats(store);
  const dbBytesBefore = fs.statSync(path.join(dir, 'db.sqlite')).size;

  const run = await archive.archiveColdData(store, { cfg: stub.cfg, now: NOW });
  const after = perTable(store);
  const hotAfter = archive.hotWindowStats(store);
  const dbBytesAfter = fs.statSync(path.join(dir, 'db.sqlite')).size;
  /* VACUUM تا فضای آزادشده واقعاً به دیسک برگردد */
  store.db.exec('VACUUM');
  const dbBytesVacuum = fs.statSync(path.join(dir, 'db.sqlite')).size;

  const pad = (s, n) => String(s).padEnd(n);
  console.log('collection          rows_before  bytes_before   rows_after  bytes_after   archived');
  for (const c of Object.keys(before).sort()) {
    const b = before[c], a = after[c] || { rows: 0, bytes: 0 };
    console.log(pad(c, 20) + pad(b.rows, 12) + pad(kb(b.bytes), 15) + pad(a.rows, 12) + pad(kb(a.bytes), 14) + (b.rows - a.rows));
  }
  console.log('');
  console.log(`hot_window_months      ${HOT}`);
  console.log(`cutoff                 ${run.cutoff}`);
  console.log(`rows_total_before      ${hotBefore.total_rows}`);
  console.log(`rows_hot_after         ${hotAfter.total_rows}`);
  console.log(`rows_archived          ${run.archived_rows}`);
  console.log(`cold_ratio             ${((run.archived_rows / hotBefore.total_rows) * 100).toFixed(1)}%`);
  console.log(`objects                ${run.objects.length}`);
  console.log(`archive_bytes          ${run.bytes} (${kb(run.bytes)})`);
  console.log(`db_bytes_before        ${dbBytesBefore}`);
  console.log(`db_bytes_after_archive ${dbBytesAfter}`);
  console.log(`db_bytes_after_vacuum  ${dbBytesVacuum}`);
  console.log(`signed_url_ttl_sec     ${archive.POLICY.signed_url_ttl_sec} (max ${archive.POLICY.signed_url_max_ttl_sec})`);
  console.log(`cold_keep_years        ${archive.POLICY.cold_keep_years}`);

  /* بازبینی خودکار آستانه‌ها */
  const problems = [];
  if (hotAfter.total_rows > archive.POLICY.hot_row_threshold) problems.push('hot_rows_above_threshold');
  if (hotAfter.oldest_day && hotAfter.oldest_day < run.cutoff) problems.push('cold_row_left_in_hot_table');
  if (hotBefore.total_rows !== hotAfter.total_rows + run.archived_rows) problems.push('row_accounting_mismatch');
  if (!run.objects.length) problems.push('no_archive_objects');
  if (stub.counters.rejected !== 0) problems.push('signature_rejected');
  if (stub.counters.verified < run.objects.length * 2) problems.push('signature_verify_short');

  /* نمونهٔ نشانی امضاشده برای اثبات مسیر خواندن کوتاه‌عمر */
  const url = archive.signedUrl(stub.cfg, run.objects[0].key, { ttlSec: archive.POLICY.signed_url_ttl_sec });
  const resp = await fetch(url);
  console.log(`signed_url_status      ${resp.status}`);
  if (resp.status !== 200) problems.push('signed_url_read_failed');
  const tR = Date.now();
  const restored = await archive.restoreArchive(store, { cfg: stub.cfg, key: run.objects[0].key, now: NOW });
  const restoreMs = Date.now() - tR;
  console.log(`restore_probe          key=${run.objects[0].key} rows=${restored.rows} ms=${restoreMs}`);
  const biggest = run.objects.slice().sort((a, b) => b.bytes - a.bytes)[0];
  const tB = Date.now();
  const big = await archive.restoreArchive(store, { cfg: stub.cfg, key: biggest.key, now: NOW });
  console.log(`restore_largest        key=${biggest.key} rows=${big.rows} bytes=${biggest.bytes} ms=${Date.now() - tB}`);

  await stub.close();
  store.db.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* noop */ }

  console.log('');
  if (problems.length) { console.log('problems: ' + problems.join(',')); console.log('ARCHIVE-53-SIZES-FAIL'); process.exit(1); }
  console.log('ARCHIVE-53-SIZES-OK');
  process.exit(0);
})().catch(e => { console.log('sizes harness error: ' + ((e && e.stack) || e)); process.exit(2); });
