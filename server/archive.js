'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آرشیو دادهٔ سرد و سیاست نگه‌داشت — ردیف ۵۳

   قاعده: پایگاه‌دادهٔ داغ فقط «پنجرهٔ داغ» (پیش‌فرض ۱۲ ماه) را نگه
   می‌دارد؛ هر چه قدیمی‌تر است به یک فایل خودبسنده در ذخیره‌ساز شیء
   منتقل می‌شود و از جدول داغ حذف می‌گردد — ولی هرگز گم نمی‌شود.

   سه تضمین که در آزمون سنجیده می‌شوند:
     ۱) **بدون گم‌شدن داده:** هر ردیف یا در داغ است یا در بایگانی؛
        حذف فقط بعد از نوشتنِ موفق و **بازخوانی و تطبیق هش** انجام می‌شود.
     ۲) **قابل بازگشت:** هر فایل بایگانی را می‌توان دقیقاً به همان
        شناسه‌ها برگرداند (idempotent؛ دو بار بازیابی، داده را تکثیر نمی‌کند).
     ۳) **دسترسی کوتاه‌عمر:** برای خواندن فایل فقط URL امضاشده با عمر
        کوتاه ساخته می‌شود؛ کلید دائمی جایی نمی‌رود (D‑23/F‑04).

   فرمت فایل: JSON خودتوصیف با payload فشرده:
     {v:1, kind:'payesh-archive', collection, month, rows, sha256,
      encoding:'gzip+base64', created_at, data:'<base64(gzip(ndjson))>'}
   چرا JSON و نه بدنهٔ خام gzip؟ چون امضای S3 روی رشتهٔ متنی محاسبه
   می‌شود و بدنهٔ دودویی خام ممکن است در مسیر باینری/متنی خراب شود.
   sha256 روی NDJSON خام است، پس سالم‌بودن محتوا مستقل از کانتینر
   قابل بررسی است.
   ═══════════════════════════════════════════════════════════════════ */
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const s3 = require(path.join(__dirname, '..', 'client', 'lib', 's3mini.js'));

const POLICY = {
  hot_months: 12,             /* پنجرهٔ داغ: یک سال */
  cold_keep_years: 7,         /* نگه‌داشت بایگانی — مکتوب در docs/cloud/53 */
  signed_url_ttl_sec: 300,    /* نشانی امضاشده: ۵ دقیقه */
  signed_url_max_ttl_sec: 900,
  collections: ['attendance', 'grades', 'staff_attendance', 'leaves', 'announcements', 'internships'],
  hot_row_threshold: 60000,   /* آستانهٔ جدول داغ در شبیه‌سازی مقیاس */
};

const MANIFEST = 'archive_manifest';
const ENCODING = 'gzip+base64';

class ArchiveError extends Error {
  constructor(code, details = null) { super(code); this.code = code; this.details = details; }
}

function sha256hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function ensureManifest(store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS ${MANIFEST} (
    key          TEXT PRIMARY KEY,
    collection   TEXT NOT NULL,
    month        TEXT NOT NULL,
    rows         INTEGER NOT NULL,
    bytes        INTEGER NOT NULL,
    sha256       TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    hot_months   INTEGER NOT NULL,
    restored_at  TEXT
  )`);
  store.db.exec(`CREATE INDEX IF NOT EXISTS ix_${MANIFEST}_col ON ${MANIFEST}(collection, month)`);
}

/* ماه تقویمی هر ردیف: ستون day اگر بود، وگرنه updated_at */
function monthOf(row) {
  const src = (row.day && String(row.day).slice(0, 10)) || String(row.updated_at || '').slice(0, 10);
  const m = src.match(/^(\d{4})-(\d{2})/);
  if (!m) throw new ArchiveError('bad_row_date', { id: row.id, collection: row.collection });
  return m[1] + '-' + m[2];
}

function cutoffDate(now, hotMonths) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - hotMonths, 1));
  return d.toISOString().slice(0, 10);
}

function hotWindowStats(store, { collections = POLICY.collections } = {}) {
  const out = { collections: {}, total_rows: 0, total_bytes: 0, oldest_day: null, newest_day: null };
  for (const c of collections) {
    const r = store.db.prepare(
      `SELECT COUNT(*) n, COALESCE(SUM(LENGTH(data)),0) bytes, MIN(day) oldest, MAX(day) newest
         FROM records WHERE collection=? AND deleted_at IS NULL`
    ).get(c);
    out.collections[c] = { rows: r.n, bytes: r.bytes, oldest_day: r.oldest || null, newest_day: r.newest || null };
    out.total_rows += r.n;
    out.total_bytes += r.bytes;
    if (r.oldest && (!out.oldest_day || r.oldest < out.oldest_day)) out.oldest_day = r.oldest;
    if (r.newest && (!out.newest_day || r.newest > out.newest_day)) out.newest_day = r.newest;
  }
  return out;
}

/* ردیف‌های کهنه‌تر از پنجرهٔ داغ، گروه‌بندی‌شده بر ماه */
function selectCold(store, collection, cutoff) {
  return store.db.prepare(
    `SELECT id, data, version, ref1, ref2, day, created_at, updated_at
       FROM records
      WHERE collection=? AND deleted_at IS NULL
        AND ((day IS NOT NULL AND day < ?) OR (day IS NULL AND substr(updated_at,1,10) < ?))
      ORDER BY id`
  ).all(collection, cutoff, cutoff).map(r => Object.assign({ collection }, r));
}

function envelopeFor(collection, month, rows, createdAt) {
  const ndjson = rows.map(r => JSON.stringify({
    collection, id: r.id, version: r.version, data: JSON.parse(r.data),
    ref1: r.ref1, ref2: r.ref2, day: r.day, created_at: r.created_at, updated_at: r.updated_at,
  })).join('\n');
  const gz = zlib.gzipSync(Buffer.from(ndjson, 'utf8'));
  return {
    v: 1,
    kind: 'payesh-archive',
    collection,
    month,
    rows: rows.length,
    bytes_raw: Buffer.byteLength(ndjson, 'utf8'),
    sha256: sha256hex(ndjson),
    encoding: ENCODING,
    created_at: createdAt,
    data: gz.toString('base64'),
  };
}

function decodeEnvelope(text) {
  let env;
  try { env = JSON.parse(text); } catch (e) { throw new ArchiveError('bad_envelope_json'); }
  if (!env || env.kind !== 'payesh-archive' || env.encoding !== ENCODING) throw new ArchiveError('bad_envelope_kind');
  let raw;
  try { raw = zlib.gunzipSync(Buffer.from(env.data, 'base64')).toString('utf8'); }
  catch (e) { throw new ArchiveError('bad_envelope_gzip'); }
  const sum = sha256hex(raw);
  if (sum !== env.sha256) throw new ArchiveError('checksum_mismatch', { expected: env.sha256, got: sum });
  const rows = raw.split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch (e) { throw new ArchiveError('bad_row_json'); }
  });
  if (rows.length !== env.rows) throw new ArchiveError('row_count_mismatch', { env: env.rows, got: rows.length });
  return { env, rows };
}

/**
 * بایگانی دادهٔ سرد.
 * @param {object} store  Store محصول (node:sqlite)
 * @param {object} opts   {cfg, now, hotMonths, collections, dryRun, verify}
 */
async function archiveColdData(store, opts = {}) {
  const cfg = opts.cfg;
  if (!cfg || !cfg.endpoint || !cfg.bucket) throw new ArchiveError('storage_not_configured');
  const now = opts.now || new Date();
  const hotMonths = opts.hotMonths == null ? POLICY.hot_months : Number(opts.hotMonths);
  const collections = opts.collections || POLICY.collections;
  const dryRun = !!opts.dryRun;
  const verify = opts.verify !== false;
  const cutoff = cutoffDate(now, hotMonths);
  const createdAt = now.toISOString();

  ensureManifest(store);
  const result = { cutoff, hot_months: hotMonths, dry_run: dryRun, collections: {}, objects: [], archived_rows: 0, bytes: 0 };

  for (const collection of collections) {
    const cold = selectCold(store, collection, cutoff);
    result.collections[collection] = { cold_rows: cold.length, objects: 0, archived_rows: 0 };
    if (!cold.length) continue;

    const byMonth = new Map();
    for (const r of cold) {
      const m = monthOf(r);
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m).push(r);
    }

    for (const month of [...byMonth.keys()].sort()) {
      const rows = byMonth.get(month);
      const key = `${cfg.prefix || ''}archive/${collection}/${month}.json`;
      const env = envelopeFor(collection, month, rows, createdAt);
      const body = JSON.stringify(env);

      if (!dryRun) {
        await s3.put(cfg, key, body);
        if (verify) {
          /* بازخوانی و تطبیق: تا این لحظه هیچ ردیفی حذف نشده است */
          const back = await s3.get(cfg, key);
          decodeEnvelope(back);                    /* هش و تعداد ردیف‌ها بررسی می‌شود */
        }
        const del = store.db.prepare('DELETE FROM records WHERE collection=? AND id=?');
        store.db.exec('BEGIN');
        try {
          for (const r of rows) del.run(collection, r.id);
          store.db.prepare(
            `INSERT INTO ${MANIFEST}(key,collection,month,rows,bytes,sha256,created_at,hot_months)
             VALUES(?,?,?,?,?,?,?,?)
             ON CONFLICT(key) DO UPDATE SET rows=excluded.rows, bytes=excluded.bytes,
               sha256=excluded.sha256, created_at=excluded.created_at, hot_months=excluded.hot_months`
          ).run(key, collection, month, env.rows, Buffer.byteLength(body, 'utf8'), env.sha256, createdAt, hotMonths);
          store.db.exec('COMMIT');
        } catch (e) { store.db.exec('ROLLBACK'); throw e; }
      }

      result.objects.push({ key, collection, month, rows: env.rows, bytes: Buffer.byteLength(body, 'utf8'), sha256: env.sha256 });
      result.collections[collection].objects++;
      result.collections[collection].archived_rows += rows.length;
      result.archived_rows += rows.length;
      result.bytes += Buffer.byteLength(body, 'utf8');
    }
  }
  return result;
}

/** بازگرداندن یک فایل بایگانی به پایگاه‌داده (idempotent) */
async function restoreArchive(store, opts = {}) {
  const cfg = opts.cfg;
  if (!cfg) throw new ArchiveError('storage_not_configured');
  const key = String(opts.key || '');
  if (!key) throw new ArchiveError('bad_key');
  ensureManifest(store);
  const text = await s3.get(cfg, key);
  const { env, rows } = decodeEnvelope(text);
  const nowISO = (opts.now || new Date()).toISOString();

  const up = store.db.prepare(
    `INSERT INTO records(collection,id,data,version,ref1,ref2,day,created_at,updated_at,deleted_at)
     VALUES(?,?,?,?,?,?,?,?,?,NULL)
     ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data, version=excluded.version,
       ref1=excluded.ref1, ref2=excluded.ref2, day=excluded.day, updated_at=excluded.updated_at,
       deleted_at=NULL`
  );
  let inserted = 0;
  store.db.exec('BEGIN');
  try {
    for (const r of rows) {
      up.run(r.collection || env.collection, Number(r.id), JSON.stringify(r.data), Number(r.version) || 1,
        r.ref1 == null ? null : Number(r.ref1), r.ref2 == null ? null : Number(r.ref2),
        r.day || null, r.created_at || nowISO, r.updated_at || nowISO);
      inserted++;
    }
    store.db.prepare(`UPDATE ${MANIFEST} SET restored_at=? WHERE key=?`).run(nowISO, key);
    store.db.exec('COMMIT');
  } catch (e) { store.db.exec('ROLLBACK'); throw e; }
  return { key, collection: env.collection, month: env.month, rows: inserted, sha256: env.sha256 };
}

function listArchive(store, { collection = null } = {}) {
  ensureManifest(store);
  const sql = collection
    ? `SELECT * FROM ${MANIFEST} WHERE collection=? ORDER BY month`
    : `SELECT * FROM ${MANIFEST} ORDER BY collection, month`;
  const st = store.db.prepare(sql);
  return (collection ? st.all(collection) : st.all());
}

/** نشانی امضاشدهٔ کوتاه‌عمر برای خواندن یک فایل بایگانی */
function signedUrl(cfg, key, { ttlSec = POLICY.signed_url_ttl_sec } = {}) {
  const ttl = Number(ttlSec);
  if (!Number.isFinite(ttl) || ttl <= 0) throw new ArchiveError('bad_ttl');
  if (ttl > POLICY.signed_url_max_ttl_sec) {
    throw new ArchiveError('ttl_too_long', { max: POLICY.signed_url_max_ttl_sec, got: ttl });
  }
  return s3.presign(cfg, { method: 'GET', key, expires: ttl });
}

/** حذف فایل‌های بایگانی قدیمی‌تر از سیاست نگه‌داشت (پایان عمر) */
async function purgeExpired(store, opts = {}) {
  const cfg = opts.cfg;
  const now = opts.now || new Date();
  const keepYears = opts.keepYears == null ? POLICY.cold_keep_years : Number(opts.keepYears);
  const limit = new Date(Date.UTC(now.getUTCFullYear() - keepYears, now.getUTCMonth(), now.getUTCDate())).toISOString();
  ensureManifest(store);
  const rows = store.db.prepare(`SELECT * FROM ${MANIFEST} WHERE created_at < ?`).all(limit);
  const removed = [];
  for (const r of rows) {
    await s3.remove(cfg, r.key);
    store.db.prepare(`DELETE FROM ${MANIFEST} WHERE key=?`).run(r.key);
    removed.push({ key: r.key, rows: r.rows, created_at: r.created_at });
  }
  return { keep_years: keepYears, cutoff: limit, removed };
}

function policy() { return JSON.parse(JSON.stringify(POLICY)); }

module.exports = {
  POLICY, MANIFEST, ENCODING, ArchiveError,
  policy, hotWindowStats, cutoffDate, monthOf, selectCold,
  archiveColdData, restoreArchive, listArchive, signedUrl, purgeExpired,
  ensureManifest, decodeEnvelope, envelopeFor,
};
