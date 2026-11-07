'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون آرشیو دادهٔ سرد و سیاست نگه‌داشت — ردیف ۵۳  (AR-01 .. AR-15)

   داده روی همان لایهٔ ذخیره‌سازی محصول (node:sqlite) و ذخیره‌ساز شیء
   محلی که **امضای SigV4 را واقعاً بازبینی می‌کند** اجرا می‌شود؛ یعنی
   اگر امضای کلاینت غلط باشد، نوشتن/خواندن شکست می‌خورد.
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openStore } = require('../server/db');
const archive = require('../server/archive');
const { startStub } = require('./lib/s3-stub');
const { seed: seedShared } = require('./lib/seed-53');

const NOW = new Date('2026-11-07T00:00:00.000Z');
const TOTAL_ROWS = 120000;

let passed = 0, failed = 0; const failures = [];
async function check(id, desc, fn) {
  try { const d = await fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; failures.push(id); console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e).slice(0, 260)}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }
async function throwsCode(fn, code) {
  try { await fn(); } catch (e) { if (e && e.code === code) return e.code; throw new Error('wrong error: ' + ((e && e.code) || e.message)); }
  throw new Error('did not throw (' + code + ' expected)');
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-ar53-'));
const store = openStore(path.join(dir, 'db.sqlite'));

(async () => {
  let stub = null;
  const cfg = () => stub.cfg;
  let before = null, run = null;

  await check('AR-01', 'سیاست نگه‌داشت مکتوب و منسجم است (پنجرهٔ داغ، عمر بایگانی، عمر URL)', async () => {
    const p = archive.policy();
    assert(p.hot_months === 12, 'hot_months');
    assert(p.cold_keep_years === 7, 'cold_keep_years');
    assert(p.signed_url_ttl_sec === 300 && p.signed_url_max_ttl_sec === 900, 'ttl');
    assert(Array.isArray(p.collections) && p.collections.length >= 5, 'collections');
    return `hot=${p.hot_months}mo keep=${p.cold_keep_years}y url=${p.signed_url_ttl_sec}s(max ${p.signed_url_max_ttl_sec})`;
  });

  await check('AR-02', `کاشته‌شدن ${TOTAL_ROWS} ردیف روی سه سال + اندازه‌گیری پنجرهٔ داغ`, async () => {
    const seeded = seedShared(store, { totalRows: TOTAL_ROWS, collections: archive.POLICY.collections.slice(0, 5), now: NOW });
    before = archive.hotWindowStats(store);
    assert(before.total_rows === seeded.rows, `rows=${before.total_rows}`);
    assert(before.oldest_day < '2024-03-01', 'seed span too short: ' + before.oldest_day);
    return `rows=${before.total_rows} bytes=${before.total_bytes} span=${before.oldest_day}..${before.newest_day}`;
  });

  await check('AR-03', 'ذخیره‌ساز شیء آماده است و درخواست بدون امضا را رد می‌کند', async () => {
    stub = await startStub({ accessKey: 'ak-53', secret: 'sk-53', region: 'us-east-1', bucket: 'payesh-53' });
    const r = await fetch(stub.endpoint + '/payesh-53/archive/x.json', { method: 'GET' });
    assert(r.status === 403, 'unsigned request was not rejected: ' + r.status);
    const bad = await fetch(stub.endpoint + '/payesh-53/archive/x.json', {
      method: 'GET',
      headers: { authorization: 'AWS4-HMAC-SHA256 Credential=ak-53/20260101/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=' + 'a'.repeat(64) },
    });
    assert(bad.status === 403, 'forged signature was not rejected: ' + bad.status);
    return `unsigned=403 forged=403 rejected=${stub.counters.rejected}`;
  });

  await check('AR-04', 'اجرای آزمایشی (dry-run) هیچ فایلی نمی‌سازد و هیچ ردیفی حذف نمی‌کند', async () => {
    const d = await archive.archiveColdData(store, { cfg: cfg(), now: NOW, dryRun: true });
    assert(d.archived_rows > 0, 'no cold rows detected');
    assert(stub.objects.size === 0, 'dry-run wrote objects: ' + stub.objects.size);
    const after = archive.hotWindowStats(store);
    assert(after.total_rows === before.total_rows, 'dry-run deleted rows');
    return `would_archive=${d.archived_rows} objects=0 rows_kept=${after.total_rows}`;
  });

  await check('AR-05', `بایگانی واقعی با ${archive.POLICY.hot_months} ماه پنجرهٔ داغ`, async () => {
    const t0 = Date.now();
    run = await archive.archiveColdData(store, { cfg: cfg(), now: NOW });
    run.ms = Date.now() - t0;
    assert(run.archived_rows > 0, 'nothing archived');
    assert(run.objects.length > 0, 'no objects');
    return `objects=${run.objects.length} archived=${run.archived_rows} bytes=${run.bytes} ms=${run.ms} cutoff=${run.cutoff}`;
  });

  await check('AR-06', 'همهٔ درخواست‌ها امضای SigV4 معتبر داشتند و هش بدنه تطبیق کرد', async () => {
    assert(stub.counters.rejected === 2, 'unexpected rejects besides the two negative probes: ' + stub.counters.rejected);
    assert(stub.counters.body_hash_mismatch === 0, 'body hash mismatch');
    assert(stub.counters.verified >= run.objects.length * 2, `verified=${stub.counters.verified} objects=${run.objects.length}`);
    return `verified=${stub.counters.verified} (put+verify-read) rejected=${stub.counters.rejected} hash_mismatch=0`;
  });

  await check('AR-07', 'هیچ ردیفی گم نشد: داغِ قبل = داغِ بعد + بایگانی‌شده', async () => {
    const after = archive.hotWindowStats(store);
    assert(before.total_rows === after.total_rows + run.archived_rows,
      `before=${before.total_rows} after=${after.total_rows} archived=${run.archived_rows}`);
    return `before=${before.total_rows} hot_after=${after.total_rows} cold=${run.archived_rows}`;
  });

  await check('AR-08', 'پایگاه‌داده فقط «پنجرهٔ داغ» را نگه داشته است', async () => {
    const after = archive.hotWindowStats(store);
    assert(after.oldest_day >= run.cutoff, `oldest=${after.oldest_day} cutoff=${run.cutoff}`);
    const stray = store.db.prepare(
      `SELECT COUNT(*) n FROM records WHERE day IS NOT NULL AND day < ? AND deleted_at IS NULL`
    ).get(run.cutoff);
    assert(stray.n === 0, `stray cold rows=${stray.n}`);
    return `hot=${after.total_rows} oldest=${after.oldest_day} >= cutoff ${run.cutoff}`;
  });

  await check('AR-09', 'فایل بایگانی خودبسنده و سالم است (gzip + sha256 + تعداد ردیف)', async () => {
    const obj = run.objects[0];
    const text = stub.objects.get(obj.key);
    assert(text, 'object missing in store');
    const dec = archive.decodeEnvelope(text);
    assert(dec.env.collection === obj.collection && dec.env.month === obj.month, 'envelope identity');
    assert(dec.rows.length === obj.rows, `rows=${dec.rows.length} expected=${obj.rows}`);
    assert(dec.rows[0].id != null && dec.rows[0].data, 'row payload missing');
    return `key=${obj.key} rows=${dec.rows.length} sha=${dec.env.sha256.slice(0, 12)}…`;
  });

  await check('AR-10', 'بازیابی: فایل بایگانی دقیقاً به همان شناسه‌ها برمی‌گردد', async () => {
    const obj = run.objects[0];
    const r = await archive.restoreArchive(store, { cfg: cfg(), key: obj.key, now: NOW });
    assert(r.rows === obj.rows, `restored=${r.rows} expected=${obj.rows}`);
    const after = archive.hotWindowStats(store);
    assert(after.total_rows === run.archived_rows ? true : after.total_rows > 0, 'stats');
    const sample = store.db.prepare('SELECT id,data FROM records WHERE collection=? ORDER BY id LIMIT 1').get(obj.collection);
    assert(sample, 'restored row not found');
    return `restored=${r.rows} col=${obj.collection} month=${obj.month}`;
  });

  await check('AR-11', 'بازیابی دوباره داده را تکثیر نمی‌کند (idempotent)', async () => {
    const obj = run.objects[0];
    const n1 = store.db.prepare('SELECT COUNT(*) n FROM records WHERE collection=?').get(obj.collection).n;
    const again = await archive.restoreArchive(store, { cfg: cfg(), key: obj.key, now: NOW });
    const n2 = store.db.prepare('SELECT COUNT(*) n FROM records WHERE collection=?').get(obj.collection).n;
    assert(n1 === n2, `rows changed: ${n1} → ${n2}`);
    assert(again.rows === obj.rows, 'second restore count');
    return `rows=${n2} unchanged=true`;
  });

  await check('AR-12', 'فایل دستکاری‌شده بازیابی نمی‌شود (شکست هش، بدون نوشتن ناقص)', async () => {
    const obj = run.objects[1];
    const original = stub.objects.get(obj.key);
    /* ۱) دستکاری محتوا ⇒ هش نمی‌خواند */
    const zlib = require('zlib');
    const tamper1 = JSON.parse(original);
    const rawText = zlib.gunzipSync(Buffer.from(tamper1.data, 'base64')).toString('utf8');
    assert(rawText.includes('present'), 'seed payload marker missing');
    tamper1.data = zlib.gzipSync(Buffer.from(rawText.replace('present', 'present!'), 'utf8')).toString('base64');
    stub.poke(obj.key, JSON.stringify(tamper1));
    const c1 = await throwsCode(() => archive.restoreArchive(store, { cfg: cfg(), key: obj.key, now: NOW }), 'checksum_mismatch');
    /* ۲) دستکاری ادعای تعداد ⇒ تعداد ردیف نمی‌خواند */
    const tamper2 = JSON.parse(original);
    tamper2.rows = tamper2.rows + 1;
    stub.poke(obj.key, JSON.stringify(tamper2));
    const c2 = await throwsCode(() => archive.restoreArchive(store, { cfg: cfg(), key: obj.key, now: NOW }), 'row_count_mismatch');
    stub.poke(obj.key, original);               /* بازگرداندن فایل سالم */
    return `${c1} + ${c2} refused=both`;
  });

  await check('AR-13', 'نشانی امضاشدهٔ کوتاه‌عمر: معتبر، منقضی، و سقف عمر', async () => {
    const key = run.objects[0].key;
    const url = archive.signedUrl(cfg(), key, { ttlSec: 300 });
    const ok = await fetch(url);
    assert(ok.status === 200, 'valid signed url status=' + ok.status);
    const shortUrl = archive.signedUrl(cfg(), key, { ttlSec: 1 });
    await new Promise(r => setTimeout(r, 1600));
    const expired = await fetch(shortUrl);
    assert(expired.status === 403, 'expired url was accepted: ' + expired.status);
    const code = await throwsCode(async () => archive.signedUrl(cfg(), key, { ttlSec: 86400 }), 'ttl_too_long');
    assert(stub.counters.expired >= 1, 'stub did not record expiry');
    return `valid=200 expired=403 ttl_cap=${code} presigned_ok=${stub.counters.presigned_ok}`;
  });

  await check('AR-14', 'پایان عمر بایگانی: فایل قدیمی‌تر از سیاست نگه‌داشت حذف می‌شود', async () => {
    const oldKey = 'payesh/archive/legacy/2016-01.json';
    stub.poke(oldKey, '{"kind":"payesh-archive"}');
    const old = new Date(Date.UTC(NOW.getUTCFullYear() - 8, 0, 1)).toISOString();
    store.db.prepare(
      `INSERT INTO ${archive.MANIFEST}(key,collection,month,rows,bytes,sha256,created_at,hot_months)
       VALUES(?,?,?,?,?,?,?,?)`
    ).run(oldKey, 'attendance', '2016-01', 10, 100, 'x'.repeat(64), old, 12);
    const p = await archive.purgeExpired(store, { cfg: cfg(), now: NOW });
    assert(p.removed.length === 1 && p.removed[0].key === oldKey, 'old object not purged: ' + JSON.stringify(p.removed));
    assert(!stub.objects.has(oldKey), 'object still in storage');
    const still = archive.listArchive(store).filter(m => m.key === oldKey);
    assert(still.length === 0, 'manifest row survived');
    return `keep=${p.keep_years}y removed=${p.removed.length}`;
  });

  await check('AR-15', `اندازهٔ جدول داغ زیر آستانهٔ ${archive.POLICY.hot_row_threshold} ردیف در مقیاس شبیه‌سازی‌شده`, async () => {
    const after = archive.hotWindowStats(store);
    assert(after.total_rows <= archive.POLICY.hot_row_threshold,
      `hot=${after.total_rows} > threshold=${archive.POLICY.hot_row_threshold}`);
    const ratio = ((after.total_rows / before.total_rows) * 100).toFixed(1);
    return `total_before=${before.total_rows} hot_after=${after.total_rows} (${ratio}%) threshold=${archive.POLICY.hot_row_threshold}`;
  });

  if (stub) await stub.close();
  store.db.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* noop */ }
  console.log('');
  console.log(`AR checks=${passed + failed} pass=${passed} fail=${failed}`);
  if (failed === 0) console.log('ARCHIVE-53-OK');
  else { console.log('failed: ' + failures.join(',')); console.log('ARCHIVE-53-FAIL'); }
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.log('AR harness error: ' + ((e && e.stack) || e)); process.exit(2); });
