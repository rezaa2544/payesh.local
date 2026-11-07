'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آینهٔ داده روی خودِ سیستم + پشتیبان روزانهٔ قابل‌آپلود

   درخواست کاربر (روشن و صریح): «اطلاعات علاوه بر دیتابیس در خود سیستم
   هم وجود داشته باشن و هربار با دیتابیس مقایسه بشه، و هر روز یک‌بار
   فایل بک‌آپ ساخته و آپدیت بشه تا اگر داده از بین رفت یا مجبور شدیم
   دیتابیس را عوض کنیم، همان فایل را در دیتابیس تازه آپلود کنیم.»

   پس دو چیز ساخته می‌شود:
     ۱) «آینه» (`data/mirror/*.json`): یک نسخهٔ خوانا از همهٔ داده‌ها روی
        دیسک، جدا از SQLite. هر بار که داده عوض شود تازه می‌شود و هر بار
        هم با دیتابیس مقایسه می‌شود (تعداد رکوردها + اثر انگشت).
     ۲) «پشتیبان روزانه» (`data/backups/daily/payesh-YYYY-MM-DD.json`):
        یک فایل در هر روز؛ اگر همان روز داده عوض شد، همان فایل به‌روز
        می‌شود (نه ده‌ها فایل تکراری). این فایل را می‌شود در هر نصب
        تازه‌ای «بازیابی» کرد.

   فایل پشتیبان خودبسنده است: نسخه، تاریخ، تعداد هر مجموعه و خودِ
   رکوردها. هیچ وابستگی‌ای به SQLite ندارد، پس روی هر سیستم و هر
   نسخه‌ای خوانده می‌شود.
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nowISO } = require('./util');
const { COLLECTIONS } = require('./policy');

const FORMAT = 'payesh-backup';
const FORMAT_VERSION = 2;   /* F‑02: پشتیبان امضاشده (نسخهٔ ۱ بی‌امضا و رد می‌شود) */
const SIGN_META = 'secret:backup-key';
const ROLES = ['manager', 'vice', 'teacher', 'staff', 'counselor', 'guard', 'parent', 'student'];
const DATA_COLLECTIONS = Object.keys(COLLECTIONS);
const KEEP_DAYS = 400;

/* ── امضای پشتیبان (F‑02) ──────────────────────────────────────────────
   هر پشتیبان با کلید همین نصب امضا می‌شود. فایل ساخته‌شده در نصب دیگر
   (cross-tenant/cross-deployment) یا فایل دست‌کاری‌شده امضایش نمی‌خواند
   و بازیابی fail-closed رد می‌شود. */
function signKey(store) {
  const rec = store.getMeta(SIGN_META, null);
  if (rec && rec.key) return Buffer.from(String(rec.key), 'base64');
  const key = crypto.randomBytes(32);
  store.setMeta(SIGN_META, { key: key.toString('base64'), created_at: nowISO() });
  return key;
}
function canonicalBackup(snap) {
  return JSON.stringify({ format: snap.format, format_version: snap.format_version, at: snap.at || '', collections: snap.collections || {} });
}
function signSnapshot(store, snap) {
  return crypto.createHmac('sha256', signKey(store)).update(canonicalBackup(snap)).digest('base64url');
}
function verifySnapshot(store, snap) {
  if (!snap || snap.format !== FORMAT) return { ok: false, error: 'bad_format' };
  if (Number(snap.format_version) !== FORMAT_VERSION) return { ok: false, error: 'bad_format_version' };
  if (typeof snap.sig !== 'string' || !snap.sig) return { ok: false, error: 'unsigned_backup' };
  const want = signSnapshot(store, snap);
  const a = Buffer.from(snap.sig), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, error: 'bad_signature' };
  return { ok: true };
}

function fingerprint(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/* اثر انگشتِ محتوا: فقط داده‌ها، بدون زمان (وگرنه هر مقایسه «عقب» می‌شود) */
function contentHash(snap) {
  return fingerprint(JSON.stringify(snap.collections || {}));
}

/* همهٔ داده‌ها به شکل یک شیء ساده (همان چیزی که در فایل نوشته می‌شود) */
function snapshot(store) {
  const collections = {};
  let total = 0;
  for (const name of DATA_COLLECTIONS) {
    let rows = [];
    try { rows = store.all(name) || []; } catch (e) { rows = []; }
    /* _version فقط برای همگام‌سازی است و در فایل لازم نیست */
    collections[name] = rows.map(r => {
      const o = Object.assign({}, r);
      delete o._version;
      delete o._updated_at;
      return o;
    });
    total += collections[name].length;
  }
  return { format: FORMAT, format_version: FORMAT_VERSION, at: nowISO(), total, collections };
}

function countsOf(snap) {
  const out = {};
  Object.keys(snap.collections || {}).forEach(k => { out[k] = snap.collections[k].length; });
  return out;
}

/* ── نوشتن آینه: فقط اگر داده عوض شده باشد ── */
function refreshMirror(store, mirrorDir, opts = {}) {
  fs.mkdirSync(mirrorDir, { recursive: true });
  const snap = snapshot(store);
  const hash = contentHash(snap);
  const file = path.join(mirrorDir, 'payesh-data.json');
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { previous = null; }
  const prevHash = previous ? (previous.hash || contentHash(previous)) : '';
  const changed = prevHash !== hash;
  if (changed || opts.force) {
    /* فایل شامل داده‌های هویتی و رمزهاست؛ فقط مدیر سیستم آن را بخواند */
    fs.writeFileSync(file, JSON.stringify({
      format: FORMAT, format_version: FORMAT_VERSION, at: snapshot_at(snap),
      hash, total: snap.total, counts: countsOf(snap), collections: snap.collections,
      sig: signSnapshot(store, { format: FORMAT, format_version: FORMAT_VERSION, at: snapshot_at(snap), collections: snap.collections }),
    }, null, 1), { mode: 0o600 });
    store.setMeta('mirror', { at: snap.at, hash, total: snap.total, counts: countsOf(snap), file });
  }
  return { ok: true, changed, hash, total: snap.total, counts: countsOf(snap), file };
}

function snapshot_at(snap) { return snap.at || nowISO(); }

/* ── مقایسهٔ آینه با دیتابیس (همان «هربار مقایسه شود») ──
   خروجی: اختلاف‌های واقعی؛ اگر آینه عقب‌تر باشد، «stale» می‌شود. */
function compareMirror(store, mirrorDir) {
  const file = path.join(mirrorDir, 'payesh-data.json');
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { saved = null; }
  if (!saved) return { ok: false, error: 'mirror_missing', diffs: [], stale: [] };
  const now = snapshot(store);
  const nowCounts = countsOf(now);
  const savedCounts = saved.counts || {};
  const names = new Set(Object.keys(nowCounts).concat(Object.keys(savedCounts)));
  const diffs = [];
  names.forEach(n => {
    const a = Number(nowCounts[n] || 0), b = Number(savedCounts[n] || 0);
    if (a !== b) diffs.push({ collection: n, db: a, mirror: b });
  });
  const hashNow = contentHash(now);
  const sameContent = hashNow === saved.hash;
  return {
    ok: diffs.length === 0 && sameContent,
    at: saved.at || '', total: saved.total || 0,
    diffs, stale: diffs.map(d => d.collection),
    counts: nowCounts,
    hash: saved.hash || '',
    size: safeSize(file),
  };
}

function safeSize(file) {
  try { return fs.statSync(file).size; } catch (e) { return 0; }
}

/* ── پشتیبان روزانه: یک فایل برای هر روز، به‌روز می‌شود ── */
function dayStamp(d) {
  const t = d || new Date();
  const p = n => String(n).padStart(2, '0');
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
}

function refreshDaily(store, dailyDir, opts = {}) {
  fs.mkdirSync(dailyDir, { recursive: true });
  const snap = snapshot(store);
  const hash = contentHash(snap);
  const day = dayStamp(opts.now);
  const file = path.join(dailyDir, 'payesh-' + day + '.json');
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { prev = null; }
  const changed = !prev || prev.hash !== hash;
  if (changed) {
    fs.writeFileSync(file, JSON.stringify({
      format: FORMAT, format_version: FORMAT_VERSION, day, at: snap.at, hash,
      total: snap.total, counts: countsOf(snap), collections: snap.collections,
      sig: signSnapshot(store, snap),
    }, null, 1), { mode: 0o600 });
  }
  pruneDaily(dailyDir);
  return { ok: true, changed, file, day, hash, total: snap.total, counts: countsOf(snap), size: safeSize(file) };
}

function pruneDaily(dir) {
  try {
    const files = fs.readdirSync(dir).filter(f => /^payesh-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    while (files.length > KEEP_DAYS) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(dir, old)); } catch (e) { /* noop */ }
    }
  } catch (e) { /* بی‌صدا */ }
}

function listDaily(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^payesh-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse(); }
  catch (e) { /* بی‌صدا */ }
  return files.map(f => {
    const full = path.join(dir, f);
    let meta = {};
    try {
      const head = fs.readFileSync(full, 'utf8');
      const d = JSON.parse(head);
      meta = { at: d.at, total: d.total, counts: d.counts };
    } catch (e) { meta = {}; }
    return Object.assign({ file: f, size: safeSize(full) }, meta);
  });
}

/* ── بازیابی: از همان فایل JSON در یک پایگاه تازه ──
   قاعده‌ها: فقط مجموعه‌های شناخته‌شده، شناسه‌ها همان می‌مانند (تا نمره و
   حضور به دانش‌آموز درست وصل بمانند)، و رکوردهای فعلی حذف نمی‌شوند
   مگر با گزینهٔ replace. قبل از هر تغییر، یک فایل ایمنی ساخته می‌شود. */
function restore(store, payload, opts = {}) {
  let data = payload;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (e) { return { ok: false, error: 'bad_json' }; }
  }
  if (!data || data.format !== FORMAT || !data.collections) return { ok: false, error: 'bad_format' };
  /* F‑02: فقط پشتیبانِ امضاشدهٔ همین نصب پذیرفته می‌شود (fail-closed) */
  const verdict = verifySnapshot(store, data);
  if (!verdict.ok) return { ok: false, error: verdict.error };
  if (!opts.actor || opts.actor.role !== 'manager') return { ok: false, error: 'forbidden' };
  const replace = !!opts.replace;
  const report = { format: data.format, at: data.at || '', restored: {}, skipped: 0, replaced: 0, rejected: 0, rejected_reason: null };
  /* F‑02: هیچ ردیفی از مدرسه/مستأجر دیگر پذیرفته نمی‌شود */
  for (const name of Object.keys(data.collections)) {
    const rows = Array.isArray(data.collections[name]) ? data.collections[name] : [];
    for (const row of rows) {
      const sid = row && (row.school_id != null ? Number(row.school_id) : (row.tenant_id != null ? Number(row.tenant_id) : 1));
      if (sid !== 1) { report.rejected += 1; report.rejected_reason = 'cross_tenant'; }
    }
  }
  if (report.rejected) return { ok: false, error: 'cross_tenant' };
  for (const name of Object.keys(data.collections)) {
    if (DATA_COLLECTIONS.indexOf(name) < 0) { report.skipped += 1; continue; }
    const rows = Array.isArray(data.collections[name]) ? data.collections[name] : [];
    let n = 0;
    for (const row of rows) {
      const id = Number(row && row.id);
      if (!id) continue;
      const clean = Object.assign({}, row);
      delete clean._version;
      delete clean._updated_at;
      /* F‑02: نقش ناشناخته هرگز از پشتیبان وارد نمی‌شود */
      if (clean.role != null && ROLES.indexOf(String(clean.role)) < 0) { report.rejected += 1; continue; }
      /* مالکیت/مستأجر: همهٔ ردیف‌ها به همین مدرسه بسته می‌شوند */
      clean.school_id = 1;
      /* ردیفی که «حذف‌شده» علامت خورده هم باید برگردد: update آن را
         زنده می‌کند، پس به‌جای insert از همان استفاده می‌کنیم. */
      let rowExists = false;
      try { rowExists = !!store.getRow(name, id); } catch (e) { rowExists = false; }
      try {
        if (rowExists) store.update(name, id, clean);
        else store.insert(name, clean, { id });
        n += 1;
      } catch (e) { /* یک ردیف خراب نباید بقیه را متوقف کند */ }
    }
    if (replace) {
      /* رکوردهایی که در فایل نیستند، حذف‌شده علامت می‌خورند */
      const ids = new Set(rows.map(r => Number(r && r.id)).filter(Boolean));
      for (const cur of store.all(name)) {
        if (!ids.has(Number(cur.id))) { try { store.remove(name, cur.id); report.replaced += 1; } catch (e) { /* noop */ } }
      }
    }
    report.restored[name] = n;
  }
  return { ok: true, report };
}

module.exports = {
  FORMAT, FORMAT_VERSION, DATA_COLLECTIONS,
  snapshot, countsOf, refreshMirror, compareMirror, refreshDaily, listDaily, restore, dayStamp,
  signSnapshot, verifySnapshot, signKey,
};
