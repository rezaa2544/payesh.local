#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   payesh-local — سرور مدرسه
   Node 22 + SQLite (node:sqlite). بدون وابستگی خارجی.
   ex: node --experimental-sqlite server/index.js
   ═══════════════════════════════════════════════════════════════════ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');

const { openStore } = require('./db');
const auth = require('./auth');
const apiVersion = require('./api-version');
const sync = require('./sync');
const policy = require('./policy');
const privacy = require('./privacy'); /* row 88 */
const cfg = require('./config');
const qr = require('./qr');
const s3mem = require('./s3mem');
const outbox = require('./outbox');
const live = require('./live');
const tenancy = require('./tenancy');
const metrics = require('./metrics');
/* row 85: structured JSON logs (request_id + school_id, no PII) */
const logger = require('./logger');

function normDigitsLocal(v) {
  return String(v == null ? '' : v)
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[^\d]/g, '');
}
const update = require('./update');
const mirror = require('./mirror');
const tunnel = require('./tunnel');
const { nowISO, json, normDigits, normalizeMobile, validNationalId, sha256 } = require('./util');

/* ریشهٔ برنامه — آزمون‌ها می‌توانند با PAYESH_APP_ROOT روی یک کپی کار کنند */
const ROOT = process.env.PAYESH_APP_ROOT || path.resolve(__dirname, '..');
const CLIENT_DIR = path.join(ROOT, 'client');
/* اگر پوشهٔ نصب فقط‌خواندنی باشد (Program Files)، به‌روزرسانی فایل‌های رابط
   را این‌جا می‌نویسد و سرور از همین لایه سرو می‌کند. */
const OVERLAY_DIR = path.join(process.env.PAYESH_DATA || path.join(ROOT, 'data'), 'app');
const RELEASES_DIR = path.join(ROOT, 'releases');
const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.PAYESH_DATA || path.join(ROOT, 'data');
/* نقش‌هایی که آینه/پشتیبان را می‌بینند و می‌توانند بازیابی کنند: مدیر و عوامل اجرایی */
/* F‑01: فایل کامل داده/بکاپ فقط برای مدیر — هیچ نقش دیگری کل پایگاه را نمی‌گیرد */
const BACKUP_ROLES = new Set(['manager']);
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MIRROR_DIR = path.join(DATA_DIR, 'mirror');
const DAILY_BACKUP_DIR = path.join(BACKUP_DIR, 'daily');

const store = openStore(path.join(DATA_DIR, 'payesh.sqlite'));

/* ── لایهٔ چندمستأجری (فاز ۳ · CC‑12‑2) ─────────────────────────────
   فقط وقتی روشن می‌شود که اتصال PostgreSQL و کلید امضای توکن تنظیم شده
   باشد؛ در نصب تک‌مدرسه‌ای امروز، مسیرها خاموش می‌مانند و رفتار تغییر نمی‌کند. */
const TENANCY = tenancy.init({
  connectionString: process.env.PAYESH_TENANCY_PG || '',
  secret: process.env.PAYESH_TENANCY_SECRET || '',
});

/* ── تعریف‌های پایه (پایه‌ها و رشته‌ها) ───────────────────────────────
   اگر مدرسه هنوز چیزی تعریف نکرده باشد، فهرست‌های رایج یک‌بار ساخته
   می‌شوند تا فرم کلاس از همان اول پر باشد. مدیر می‌تواند هر کدام را
   ویرایش یا حذف کند و مورد تازه اضافه کند. */
(function ensureLookups() {
  try {
    if ((store.all('lookups') || []).length) return;
    const seed = [
      ['grade', 'دهم'], ['grade', 'یازدهم'], ['grade', 'دوازدهم'],
      ['branch', 'شبکه و نرم‌افزار'], ['branch', 'ریاضی و فیزیک'],
      ['branch', 'علوم تجربی'], ['branch', 'علوم انسانی'],
    ];
    const counters = { grade: 0, branch: 0 };
    for (const [kind, name] of seed) {
      counters[kind] += 1;
      store.insert('lookups', { kind, name, order: counters[kind], school_id: 1, created_at: new Date().toISOString() });
    }
  } catch (e) { /* بی‌صدا: نداشتن این فهرست نباید بالا آمدن سرور را بشکند */ }
})();

/* ── تعمیر خودکار حساب‌های بی‌رمز ────────────────────────────────────
   هر کاربری که شمارهٔ همراه دارد ولی رمز ندارد (مثلاً ولی‌ای که هنگام ثبت
   دانش‌آموز ساخته شد و کد ملی نداشت) تا امروز نمی‌توانست وارد شود و پیام
   «نام کاربری یا رمز اشتباه است» می‌گرفت. این‌جا یک‌بار برای همیشه رمز
   ساخته می‌شود (کد ملی، و اگر نبود رمز تصادفی) و در فهرست کاربران برای
   مدیر نمایش داده می‌شود. پس از تعمیر، فایل ورودِ گوشی هم دوباره منتشر
   می‌شود تا همان لحظه روی گوشی کار کند. */
/* F‑01: پاک‌سازی یک‌بارهٔ رمزهای خام + رمزنگاری در حالت سکون */
try {
  const mig = auth.migrateSecrets(store);
  if (mig.moved) {
    process.env.PAYESH_LOG !== '0' && console.log('🔐 ' + mig.moved + ' رمز قابل‌بازخوانی رمزنگاری شد (بدون متن خام)');
  }
} catch (e) { /* بی‌صدا */ }

(function repairCredentials() {
  try {
    let fixed = 0;
    for (const u of (store.all('users') || [])) {
      if (u.active === false) continue;
      if (!auth.credentialsFor(u)) continue;              /* شماره ندارد؛ نام کاربری ممکن نیست */
      if (u.password_hash && u.phone_hash) continue;       /* سالم است */
      const patched = auth.applyDefaultCredentials(u, store);
      if (patched.password_hash) {
        store.update('users', u.id, {
          password_hash: patched.password_hash,
          phone_hash: patched.phone_hash || patched.password_hash,
          password_enc: patched.password_enc || u.password_enc || null,
          password_plain: undefined,
        });
        fixed += 1;
      }
    }
    if (fixed) {
      process.env.PAYESH_LOG !== '0' && console.log('🔑 ' + fixed + ' حساب بی‌رمز تعمیر شد (رمز ساخته شد)');
      outbox.publishAll(store).catch(() => null);
    }
  } catch (e) { /* بی‌صدا */ }
})();

/* نسخه‌ای که همین پروسه با آن بالا آمده — برای تشخیص «راه‌اندازی مجدد لازم است» */
const RUNNING_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(RELEASES_DIR, 'manifest.json'), 'utf8')).version || '0.0.0'; }
  catch (e) { return '0.0.0'; }
})();

/* ── نسخه و آپدیت ─────────────────────────────────────────────────── */
function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(RELEASES_DIR, 'manifest.json'), 'utf8'));
  } catch (e) {
    return { version: '0.0.0', built_at: null, files: [] };
  }
}
function readHistory(version) {
  try {
    return JSON.parse(fs.readFileSync(path.join(RELEASES_DIR, 'history', version + '.json'), 'utf8'));
  } catch (e) { return null; }
}
function updateCheck(current) {
  const latest = readManifest();
  const cur = readHistory(current);
  /* مقایسه همیشه بر اساس هش است، نه فقط شمارهٔ نسخه:
     اگر همان نسخه دوباره ساخته شده باشد هم تفاوت فایل‌ها دیده می‌شود. */
  const known = new Map((cur ? cur.files : []).map(f => [f.path, f.sha256]));
  const changed = (latest.files || []).filter(f => known.get(f.path) !== f.sha256);
  const removed = [...known.keys()].filter(p => !(latest.files || []).some(f => f.path === p));
  if (cur && !changed.length && !removed.length) {
    return { ok: true, up_to_date: true, version: latest.version, built_at: latest.built_at, server_time: nowISO() };
  }
  /* کلاینت فقط فایل‌های client/ را می‌تواند در کش خودش بنشاند */
  const client = changed
    .filter(f => String(f.path).startsWith('client/') || !String(f.path).includes('/'))
    .map(f => ({ path: String(f.path).replace(/^client\//, ''), sha256: f.sha256, size: f.size }));
  return {
    ok: true,
    up_to_date: false,
    version: latest.version,
    running_version: RUNNING_VERSION,
    restart_pending: latest.version !== RUNNING_VERSION,
    built_at: latest.built_at,
    changed,
    client,
    removed,
    total_size: changed.reduce((a, f) => a + (f.size || 0), 0),
    client_size: client.reduce((a, f) => a + (f.size || 0), 0),
    full_size: (latest.files || []).reduce((a, f) => a + (f.size || 0), 0),
    server_time: nowISO(),
  };
}

/* ── نشست ─────────────────────────────────────────────────────────── */
function actorFrom(req) {
  const h = String(req.headers.authorization || '');
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const s = auth.verifySession(store, token);
  if (!s) return null;
  /* row 85: the access log carries the school of the authenticated actor
     (an opaque number, never the user's name or id) */
  try { req.__payeshLog = { school_id: s.user.school_id != null ? s.user.school_id : null, role: s.user.role }; } catch (e) { /* noop */ }
  return { user: s.user, role: s.user.role, device: s.device, session: s.session };
}

/* ── تیکت کوتاه‌عمرِ صندوقچه برای گوشی (D‑23 / F‑04) ──────────────────
   گوشی هیچ کلیدی نمی‌گیرد: فقط چند نشانی امضاشده که خودشان منقضی می‌شوند
   و هرکدام فقط به یک فایل و یک عمل اجازه می‌دهند. تیکت‌ها به همان مدرسه
   (پیشوند صندوقچه) و همان کاربر بسته‌اند؛ کلید قابل‌جا‌به‌جا‌شدن نیست. */
const PHONE_TICKET_TTL = 7 * 24 * 3600;      /* سقف مطلق SigV4 — قابل افزایش نیست */
const PHONE_DEVICE_TTL = 200 * 24 * 3600;    /* تصمیم مالک: تیکت دستگاه گوشی ۲۰۰ روز */

/* ── تیکت دستگاه (۲۰۰ روز) ───────────────────────────────────────────
   امضای خودِ سرور (HMAC) روی «کاربر + دستگاه + انقضا». گوشی بدون نشست و
   بدون هیچ کلیدی می‌تواند تیکت‌های کوتاه SigV4 را تازه کند. کلید امضا در
   متادیتای سرور می‌ماند و هرگز به کلاینت نمی‌رود. */
function deviceTicketKey(store) {
  const rec = store.getMeta('phone:ticket-key', null);
  if (rec && rec.secret) return rec.secret;
  const secret = crypto.randomBytes(32).toString('hex');
  store.setMeta('phone:ticket-key', { secret, created_at: new Date().toISOString() });
  return secret;
}

function deviceTicketMac(store, userId, device, exp) {
  return crypto.createHmac('sha256', deviceTicketKey(store))
    .update([Number(userId), device, exp].join('.'))
    .digest('base64url');
}

function issueDeviceTicket(store, user, deviceRaw) {
  const device = phoneDeviceId(deviceRaw);
  const exp = Date.now() + PHONE_DEVICE_TTL * 1000;
  return {
    ticket: [Number(user.id), device, exp].join('.') + '.' + deviceTicketMac(store, user.id, device, exp),
    device_id: device,
    issued_at: new Date().toISOString(),
    expires_at: new Date(exp).toISOString(),
    ttl_days: Math.round(PHONE_DEVICE_TTL / 86400),
  };
}

/* فقط دادهٔ امضاشدهٔ سرور پذیرفته می‌شود؛ هویت هرگز از بدنهٔ کلاینت نمی‌آید */
function verifyDeviceTicket(store, raw) {
  const parts = String(raw || '').trim().split('.');
  if (parts.length !== 4) return null;
  const [uid, device, exp, mac] = parts;
  const userId = Number(uid);
  const expires = Number(exp);
  if (!userId || !device || !expires) return null;
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(mac)) return null;
  const expect = deviceTicketMac(store, userId, device, expires);
  const a = Buffer.from(mac), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (expires < Date.now()) return null;
  const user = store.all('users').find(u => Number(u.id) === userId);
  if (!user || user.active === 0 || user.active === false || user.deleted_at) return null;
  /* ابطال صریح دستگاه (فهرست ابطال سمت سرور) هم تیکت را باطل می‌کند */
  const revoked = store.getMeta('phone:revoked-devices', null);
  if (revoked && Array.isArray(revoked.list) && revoked.list.includes(device)) return null;
  return { user, device, expires_at: new Date(expires).toISOString() };
}

function phoneDeviceId(raw) {
  const s = String(raw || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  return s.length >= 6 ? s : ('dev-' + require('crypto').randomBytes(6).toString('hex'));
}

function phoneTickets(store, user, deviceRaw) {
  const cfg = s3mem.usingMeta(store).get();
  if (!cfg.endpoint || !cfg.accessKey || !cfg.secret || !cfg.bucket) return { ok: false, error: 'no_cloud' };
  const device = phoneDeviceId(deviceRaw);
  const prefix = String(cfg.prefix || 'payesh/');
  /* مسیر فایلِ همین دستگاه — فقط برای نمایش/پشتیبانی؛ نوشتن در آن فقط از سرور */
  const deviceKey = prefix + 'outbox/pending/device-' + device + '.json';
  const until = sec => new Date(Date.now() + sec * 1000).toISOString();
  const mk = (method, key, seconds) => ({
    url: s3mem.presign(cfg, { method, key, expires: seconds }),
    method, key, expires_at: until(seconds),
  });
  return {
    ok: true,
    device_id: device,
    device_file: deviceKey,
    config: {
      endpoint: cfg.endpoint, bucket: cfg.bucket, region: cfg.region,
      prefix, pathStyle: cfg.pathStyle,
    },
    tickets: {
      rev_get: mk('GET', prefix + 'realtime/rev.json', PHONE_TICKET_TTL),
      rev_put: mk('PUT', prefix + 'realtime/rev.json', PHONE_TICKET_TTL),
      core_get: mk('GET', prefix + 'data/core.json', PHONE_TICKET_TTL),
      person_get: mk('GET', prefix + 'data/person/' + Number(user.id) + '.json', PHONE_TICKET_TTL),
      /* F‑06: کلاینت اجازهٔ نوشتن مستقیم در صندوقچه را ندارد؛ ثبت‌ها از
         مسیر /api/outbox/submit با هویتِ امضاشدهٔ سرور می‌آیند. */
    },
    submit: { url: '/api/outbox/submit', method: 'POST', header: 'X-Phone-Ticket' },
  };
}

/* ── محدودیت ساده نرخ (در حافظه) ───────────────────────────────────── */
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start > windowMs) { b = { start: now, n: 0 }; buckets.set(key, b); }
  b.n++;
  return b.n <= max;
}

/* ── بدنهٔ درخواست ────────────────────────────────────────────────── */
function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('bad_json')); }
    });
    req.on('error', reject);
  });
}

/* ── فایل‌های استاتیک ─────────────────────────────────────────────── */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.apk': 'application/vnd.android.package-archive', '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};

function safeJoin(base, target) {
  const p = path.normalize(path.join(base, target));
  return p.startsWith(path.normalize(base)) ? p : null;
}

function sendFile(req, res, filePath, opts = {}) {
  let st;
  try { st = fs.statSync(filePath); } catch (e) { return false; }
  if (!st.isFile()) return false;
  const ext = path.extname(filePath).toLowerCase();
  const etag = '"' + crypto.createHash('sha1')
    .update(String(st.size) + ':' + String(st.mtimeMs)).digest('hex').slice(0, 20) + '"';
  const noStore = opts.noStore || false;

  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'etag': etag,
    'cache-control': noStore ? 'no-store' : 'no-cache',
    'x-content-type-options': 'nosniff',
  };
  if (opts.download) headers['content-disposition'] = `attachment; filename="${path.basename(filePath)}"`;

  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return true; }

  const isText = /^(text\/|application\/(json|manifest))/.test(headers['content-type']);
  const accept = String(req.headers['accept-encoding'] || '');
  let body = fs.readFileSync(filePath);
  if (isText && body.length > 500) {
    if (/\bbr\b/.test(accept)) { body = zlib.brotliCompressSync(body); headers['content-encoding'] = 'br'; }
    else if (/\bgzip\b/.test(accept)) { body = zlib.gzipSync(body); headers['content-encoding'] = 'gzip'; }
  }
  headers['content-length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

/* ── تبدیل رکورد کاربر برای کلاینت ─────────────────────────────────── */
function userRow(u) {
  const row = {
    id: u.id, name: u.name, role: u.role, phone: u.phone, national_id: u.national_id || '',
    class_id: u.class_id || null, subject: u.subject || '', active: u.active !== false,
    position: u.position || '', created_at: u.created_at || null,
  };
  /* دانش‌آموز بی‌کلاس: دلیلش هم برمی‌گردد تا در «نیازمند پیگیری» دیده شود */
  if (u.followup_reason) row.followup_reason = u.followup_reason;
  /* فیلدهای شناسنامه‌ای/تکمیلی که از اکسل آمده‌اند */
  for (const k of IMP_STORE_FIELDS) {
    if (u[k] !== undefined && u[k] !== null && u[k] !== '') row[k] = u[k];
  }
  return row;
}
/* ═══════════════ ردیف ۴۹ — آمادگی و متریک ═══════════════════════════
   یک تابع، سه مصرف‌کننده: /api/readyz (پروب)، /metrics (scrape) و آزمون
   هشدار. قبلاً محاسبهٔ آمادگی فقط داخل مسیر readyz بود؛ اگر متریک عدد
   دیگری می‌گفت، هیچ‌کس نمی‌فهمید. حالا همه از همین یک منبع می‌خوانند. */
function readinessChecks() {
  const checks = { db: false, data_writable: false, disk_free_pct: null, backup_age_s: null, mirror_age_s: null };
  try { checks.db = !!(store.get('schools', 1) || true); } catch (e) { checks.db = false; }
  try { fs.accessSync(DATA_DIR, fs.constants.W_OK); checks.data_writable = true; } catch (e) { checks.data_writable = false; }
  try {
    const st = fs.statfsSync ? fs.statfsSync(DATA_DIR) : null;
    if (st && st.blocks) checks.disk_free_pct = +(((st.bavail / st.blocks) * 100).toFixed(1));
  } catch (e) { /* پشتیبانی نمی‌شود */ }
  const ageOf = dir => {
    try {
      const files = fs.readdirSync(dir).map(f => { try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch (e) { return 0; } }).filter(Boolean);
      return files.length ? Math.round((Date.now() - Math.max(...files)) / 1000) : null;
    } catch (e) { return null; }
  };
  checks.backup_age_s = ageOf(BACKUP_DIR);
  checks.mirror_age_s = ageOf(MIRROR_DIR);
  const ready = checks.db && checks.data_writable && (checks.disk_free_pct == null || checks.disk_free_pct >= 5);
  return { checks, ready };
}

const mreg = metrics.create();

/* سنجه‌هایی که در هر scrape از وضعیت واقعی خوانده می‌شوند. */
mreg.onCollect(() => {
  const out = [];
  const add = (name, value, helpText, labels = {}) => out.push({ name, type: 'gauge', help: helpText, labels, value });
  add('payesh_up', 1, 'سرور مدرسه زنده است (همیشه ۱ در پاسخ موفق)');
  add('payesh_uptime_seconds', Math.round(process.uptime()), 'مدت زنده‌بودن فرایند به ثانیه');

  const { checks, ready } = readinessChecks();
  add('payesh_ready', ready ? 1 : 0, 'آمادگی واقعی سرویس (DB + نوشتن داده + فضای دیسک)');
  add('payesh_db_up', checks.db ? 1 : 0, 'دیتابیس مدرسه قابل خواندن است');
  add('payesh_data_writable', checks.data_writable ? 1 : 0, 'دایرکتوری داده قابل نوشتن است');
  if (checks.disk_free_pct != null) add('payesh_disk_free_pct', checks.disk_free_pct, 'درصد فضای آزاد دیسک داده');
  if (checks.backup_age_s != null) add('payesh_backup_age_seconds', checks.backup_age_s, 'عمر جدیدترین نسخهٔ پشتیبان به ثانیه');
  if (checks.mirror_age_s != null) add('payesh_mirror_age_seconds', checks.mirror_age_s, 'عمر جدیدترین آینهٔ داده به ثانیه');

  /* ── lag همگام‌سازی: فاصلهٔ «آخرین تماس هر دستگاه» با الان ──────────
     lag یعنی دستگاه از دید سرور عقب افتاده؛ حداکثر بر همهٔ دستگاه‌های
     فعال گرفته می‌شود تا یک دستگاهِ ساکت زیر میانگین گم نشود. */
  let devices = 0, lagMax = 0;
  try {
    const rows = store.db.prepare("SELECT last_seen_at FROM devices WHERE revoked_at IS NULL").all();
    devices = rows.length;
    const now = Date.now();
    for (const r of rows) {
      if (!r.last_seen_at) continue;
      const t = Date.parse(r.last_seen_at);
      if (!Number.isFinite(t)) continue;
      lagMax = Math.max(lagMax, (now - t) / 1000);
    }
  } catch (e) { /* پایگاه قدیمی/سطح‌دسترسی: صفر گزارش می‌شود */ }
  add('payesh_sync_devices_total', devices, 'تعداد دستگاه‌های فعال (بدون ابطال)');
  add('payesh_sync_lag_seconds', Math.round(lagMax), 'بیشترین فاصلهٔ آخرین تماس دستگاه‌ها تا الان (ثانیه)');

  /* ── عمق صف همگام‌سازی: ردیف‌هایی که هنوز به فضای ابری نرسیده‌اند ── */
  let depth = 0;
  try {
    depth = fs.readdirSync(path.join(DATA_DIR, 'outbox', 'pending')).filter(f => f.endsWith('.json')).length;
  } catch (e) { depth = 0; }
  add('payesh_sync_queue_depth', depth, 'تعداد ردیف در انتظار در صندوقچهٔ ماندگار');

  /* ── حجم داده (بدون هیچ برچسب هویتی) ─────────────────────────────── */
  try {
    const n = store.db.prepare('SELECT COUNT(*) AS n FROM records WHERE deleted_at IS NULL').get();
    add('payesh_records_total', Number(n && n.n) || 0, 'تعداد ردیف‌های زندهٔ پایگاه داده');
  } catch (e) { /* noop */ }

  /* نرخ خطا از شمارندهٔ واقعی درخواست‌ها (پنجرهٔ ۵ دقیقه) */
  add('payesh_http_error_ratio_events', mreg.httpEvents.length, 'تعداد درخواست‌های داخل پنجرهٔ محاسبهٔ نرخ خطا');
  return out;
});

/* انتشار /metrics فقط برای شبکهٔ داخلی/ناظر است؛ اگر توکن تنظیم شود،
   scrape بدون توکن رد می‌شود (پیش‌فرض: باز، چون فقط شمارشِ بی‌هویت است). */
const METRICS_TOKEN = String(process.env.PAYESH_METRICS_TOKEN || '');
function metricsAllowed(req, url) {
  if (!METRICS_TOKEN) return true;
  const h = String(req.headers.authorization || '');
  if (h === 'Bearer ' + METRICS_TOKEN) return true;
  return url.searchParams.get('token') === METRICS_TOKEN;
}

/* ── مسیرهای API ──────────────────────────────────────────────────── */
async function api(req, res, url, ip) {
  const p = url.pathname;
  const q = url.searchParams;
  const m = req.method;

  /* سلامت — کلاینت با همین حالت سروری را تشخیص می‌دهد */
  /* ── آمادگی سرویس (readyz) — ردیف ۲۹: پروب واقعی برای مانیتورینگ/هشدار،
     بدون هیچ مسیر یا راز در پاسخ؛ ۲۰۰ یعنی «آمادهٔ سرویس»، ۵۰۳ یعنی «نه». */
  if (p === '/api/readyz' && m === 'GET') {
    const { checks, ready } = readinessChecks();
    return json({ ok: ready, ready, version: RUNNING_VERSION, uptime_s: Math.round(process.uptime()), checks }, ready ? 200 : 503);
  }

  if (p === '/api/health' && m === 'GET') {
    return json({
      ok: true, name: 'payesh-local', version: RUNNING_VERSION,
      installed_version: readManifest().version,
      restart_pending: readManifest().version !== RUNNING_VERSION,
      time: nowISO(), server_time: nowISO(), uptime_s: Math.round(process.uptime()),
      setup_done: !auth.needsSetup(store), school: (store.get('schools', 1) || {}).name || null,
      /* ردیف ۵۷ (S4): مسیر مطلق سرور (data_dir/db_file) در یک مسیر بدون
         احراز هویت فاش نمی‌شود — کلاینت آن را از /api/setup/state می‌گیرد. */
      public_url: cfg.publicUrl(store) || null,
      instance: cfg.instanceId(store),
      cloud_ready: (() => {
        try { const v = s3mem.usingMeta(store).get(); return !!(v.endpoint && v.bucket && v.accessKey && v.secret); }
        catch (e) { return false; }
      })(),
    });
  }

  /* ── مسیر مستأجرمحور: tenant فقط از توکن، جداسازی با RLS در پایگاه‌داده ── */
  if (p.startsWith('/api/cloud/tenancy/')) {
    let payload = {};
    if (m === 'POST' || m === 'PATCH' || m === 'PUT') {
      try { payload = await readBody(req); } catch (e) { return json({ ok: false, error: 'bad_request' }, 400); }
    }
    if (!TENANCY.enabled) return json({ ok: false, error: 'tenancy_disabled' }, 404);
    const out = await tenancy.route({ method: m, pathname: p, search: q, headers: req.headers, body: payload });
    return json(out.body, out.status);
  }

  if (p === '/api/version' && m === 'GET') {
    const mf = readManifest();
    return json({ ok: true, version: mf.version, built_at: mf.built_at, shell: mf.shell || null });
  }

  if (p === '/api/update/check' && m === 'GET') {
    return json(updateCheck(String(q.get('current') || '0.0.0')));
  }

  /* اطلاعات شبکه برای صفحهٔ نصب و کلاینت (بدون احراز هویت) */
  if (p === '/api/network' && m === 'GET') {
    return json({
      ok: true,
      public_url: cfg.publicUrl(store) || null,
      lan_urls: cfg.lanUrls(PORT),
      port: PORT,
      instance: cfg.instanceId(store),
    });
  }

  /* QR برای آدرس نصب/پیوند — بدون وابستگی خارجی */
  if (p === '/api/qr' && m === 'GET') {
    const text = String(q.get('text') || cfg.publicUrl(store) || (cfg.lanUrls(PORT)[0] || '')).slice(0, 300);
    if (!text) return json({ ok: false, error: 'empty_text' }, 400);
    const scale = Math.max(2, Math.min(16, Number(q.get('scale') || 8)));
    try {
      const png = qr.toPNG(qr.encode(text), scale, 4);
      return { body: png, headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=300' } };
    } catch (e) {
      return json({ ok: false, error: 'qr_failed' }, 400);
    }
  }

  if (p === '/api/setup/state' && m === 'GET') {
    /* ردیف ۶۵: این مسیر بی‌نشست است؛ مسیر دیسک فقط به مرورگرِ خودِ رایانهٔ مدرسه
       (loopback) گفته می‌شود — نه به هر کسی در شبکه (نقشه‌برداری مهاجم). */
    const remote = String((req.socket && req.socket.remoteAddress) || '').replace('::ffff:', '');
    const loopback = remote === '::1' || remote.startsWith('127.');
    return json({ ok: true, needs_setup: auth.needsSetup(store), version: readManifest().version,
      ...(loopback ? { data_dir: DATA_DIR, db_file: path.join(DATA_DIR, 'payesh.sqlite') } : {}),
      school: (store.get('schools', 1) || {}).name || null,
      has_password: !auth.needsSetup(store) ? auth.hasPassword((store.all('users').find(u => u.role === 'manager')) || null) : false });
  }

  if (p === '/api/setup' && m === 'POST') {
    if (!rateLimit('setup:' + ip, 10, 60_000)) return json({ ok: false, error: 'rate_limited' }, 429);
    const body = await readBody(req);
    const r = auth.setup(store, body);
    if (!r.ok) return json(r, 400);
    return json(r);
  }

  if (p === '/api/auth/pair' && m === 'POST') {
    if (!rateLimit('pair:' + ip, 20, 60_000)) return json({ ok: false, error: 'rate_limited' }, 429);
    const body = await readBody(req);
    body.__ip = ip;   /* row 65: audit only; always overwritten, never trusted from the client */
    const r = auth.pair(store, body);
    if (!r.ok) return json(r, r.error === 'device_limit' ? 409 : 400);
    return json(r);
  }

  if (p === '/api/auth/transfer/redeem' && m === 'POST') {
    if (!rateLimit('transfer:' + ip, 20, 60_000)) return json({ ok: false, error: 'rate_limited' }, 429);
    const body = await readBody(req);
    body.__ip = ip;
    const r = auth.redeemTransfer(store, body.code, body);
    return json(r, r.ok ? 200 : (r.error === 'device_limit' ? 409 : 400));
  }



  /* «یک‌بار ورود، همیشه داخل»: دستگاهِ مورد اعتماد بی‌صدا نشست تازه می‌گیرد */
  if (p === '/api/auth/refresh' && m === 'POST') {
    if (!rateLimit('refresh:' + ip, 60, 60_000)) return json({ ok: false, error: 'rate_limited' }, 429);
    const body = await readBody(req);
    body.__ip = ip;
    const r = auth.refreshWithDevice(store, body);
    if (!r.ok) return json(r, 401);
    return json(r);
  }

  /* نجاتِ مدیر: اگر حساب مدیر رمز ندارد و کاربر پشتِ خودِ رایانهٔ مدرسه است،
     یک‌بار می‌تواند شماره + رمز بسازد و بلافاصله وارد شود. (فقط از خود دستگاه) */
  if (p === '/api/auth/claim' && m === 'POST') {
    const remote = String((req.socket && req.socket.remoteAddress) || '').replace('::ffff:', '');
    const local = remote === '::1' || remote === '127.0.0.1' || remote.startsWith('127.');
    if (!local) return json({ ok: false, error: 'local_only' }, 403);
    if (!rateLimit('claim:' + ip, 10, 60_000)) return json({ ok: false, error: 'rate_limited' }, 429);
    const body = await readBody(req);
    const mgr = store.all('users').find(u => u.role === 'manager' && u.active !== false);
    if (!mgr) return json({ ok: false, error: 'no_manager' }, 400);
    const phone = normDigitsLocal(body.phone || mgr.phone || '');
    if (phone.length !== 11) return json({ ok: false, error: 'bad_phone' }, 400);
    const set = auth.setPassword(store, mgr.id, body.password);
    if (!set.ok) return json(set, 400);
    /* شمارهٔ همراه = نام کاربری؛ روی خود دستگاه اجازه داریم آن را با شمارهٔ دلخواه مدیر هم‌تراز کنیم */
    if (!mgr.phone || normDigitsLocal(mgr.phone) !== phone) {
      store.update('users', mgr.id, { phone });
      store.audit({ user_id: mgr.id, role: 'manager', action: 'phone_reset', collection: 'users' });
    }
    store.audit({ user_id: mgr.id, role: 'manager', action: 'password_claim', collection: 'users' });
    const dev = auth.login(store, { phone, password: body.password, name: 'رایانهٔ مدرسه', platform: 'server', __capExempt: true, __ip: ip });
    return json(dev.ok ? Object.assign({ ok: true }, dev) : { ok: true, need_login: true });
  }

  if (p === '/api/auth/login' && m === 'POST') {
    /* محدودیت ورود به ازای «همان شماره» شمرده می‌شود، نه به ازای یک آدرس.
       در مدرسه همهٔ گوشی‌ها یک آدرس مشترک دارند؛ اگر سقف روی آدرس بود،
       ورودِ گروهی کاربران همدیگر را بیرون می‌گذاشت و پیام «رمز اشتباه»
       می‌گرفتند. سقف کلیِ آدرس هم بالا است تا حملهٔ انبوه بسته بماند. */
    const body = await readBody(req);
    const who = normDigitsLocal(body.phone || '');
    if (!rateLimit('login-ip:' + ip, 240, 60_000)) return json({ ok: false, error: 'rate_limited' }, 429);
    if (who && !rateLimit('login-user:' + who, 20, 60_000)) return json({ ok: false, error: 'rate_limited' }, 429);
    body.__ip = ip;
    const r = auth.login(store, body);
    if (!r.ok) {
      if (r.error === 'device_limit') return json(r, 409);
      if (r.error === 'bad_device_pubkey') return json(r, 400);
      store.audit({ action: 'login_failed', role: 'system', collection: 'users', after: { ip } });
      return json(r, 401);
    }
    store.audit({ user_id: r.user.id, role: r.user.role, action: 'login', collection: 'users' });
    return json(r);
  }

  if (p === '/api/auth/unlock' && m === 'POST') {
    if (!rateLimit('unlock:' + ip, 30, 60_000)) return json({ ok: false, error: 'rate_limited' }, 429);
    const body = await readBody(req);
    /* قفل موقت پس از چند رمز اشتباه — روی همان دستگاه، ذخیره‌شده در پایگاه‌داده */
    const devKey = 'lock:' + sha256(String(body.device_token || ip)).slice(0, 32);
    const lock = store.getMeta(devKey, null);
    if (lock && lock.until && Date.parse(lock.until) > Date.now()) {
      return json({ ok: false, error: 'locked', until: lock.until, tries: lock.tries }, 429);
    }
    const r = auth.unlockWithPassword(store, body);
    if (!r.ok) {
      const tries = ((lock && lock.tries) || 0) + 1;
      if (tries >= 8) {
        store.setMeta(devKey, { tries, until: new Date(Date.now() + 10 * 60_000).toISOString() });
        store.audit({ role: 'system', action: 'unlock_locked', collection: 'devices', after: { ip } });
      } else {
        store.setMeta(devKey, { tries, until: null });
      }
      return json(r, 401);
    }
    store.setMeta(devKey, { tries: 0, until: null });
    return json(r);
  }

  /* ── گوشی: ورود و فراداده، بدون هیچ کلیدی (D‑23 / F‑04) ──────────── */
  if (p === '/api/phone/config' && m === 'GET') {
    const c = s3mem.usingMeta(store).get();
    return json({
      ok: true, mode: 'server', keyless: true,
      config: {
        endpoint: c.endpoint, bucket: c.bucket, region: c.region,
        prefix: c.prefix, pathStyle: c.pathStyle,
      },
      ready: !!(c.endpoint && c.bucket && c.accessKey && c.secret),
    });
  }

  if (p === '/api/phone/login' && m === 'POST') {
    const ip = (req.socket && req.socket.remoteAddress) || 'phone';
    if (!rateLimit('phone-login:' + ip, 40, 10 * 60_000)) return json({ ok: false, error: 'too_many' }, 429);
    let body = {};
    try { body = await readBody(req); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400); }
    const r = auth.login(store, {
      phone: body.phone, password: body.password,
      name: body.name || 'گوشی', platform: 'phone', __sessionOnly: true, __ip: ip,
    });
    if (!r.ok) return json(r, 401);
    const t = phoneTickets(store, r.user, body.device_id);
    /* تیکتی که گوشی نگه می‌دارد ۲۰۰ روز زنده است؛ تیکت‌های فایل کوتاه‌عمرند */
    const dt = issueDeviceTicket(store, r.user, (t.ok && t.device_id) || body.device_id);
    /* تیکت نگرفت (حافظهٔ ابری تنظیم نیست) هم ورود موفق است؛ گوشی در صف محلی می‌نویسد */
    return json(Object.assign({
      ok: true, token: r.session, user: auth.publicUser(r.user),
      /* ردیف ۶۵: عمر واقعیِ access token (PAYESH_ACCESS_TTL_MIN)، نه ۲۴ ساعتِ قدیمی؛
         هویت ماندگار گوشی تیکت ۲۰۰ روزهٔ دستگاه است، نه این نشست. */
      expires_hours: auth.accessTtlMs() / 3600000, expires_at: r.session.expires_at, keyless: true,
      device_ticket: dt,
    }, t.ok ? t : { tickets: null, error_cloud: t.error }));
  }

  /* تازه‌سازی تیکت فایل‌ها با تیکت دستگاه (۲۰۰ روز) — بدون نشست، بدون کلید.
     هویت فقط از تیکت امضاشدهٔ سرور خوانده می‌شود، نه از بدنه/هدر قابل‌دستکاری. */
  if (p === '/api/phone/ticket' && m === 'POST') {
    const ip = (req.socket && req.socket.remoteAddress) || 'phone';
    if (!rateLimit('phone-ticket:' + ip, 120, 10 * 60_000)) return json({ ok: false, error: 'too_many' }, 429);
    const headerTicket = String(req.headers['x-phone-ticket'] || '');
    let body = {};
    try { body = await readBody(req); } catch (e) { body = {}; }
    const dt = verifyDeviceTicket(store, headerTicket || body.device_ticket);
    if (!dt) {
      /* اگر نشست معتبر دارد، همان مسیر قبلی؛ وگرنه fail-closed */
      const s = actorFrom(req);
      if (!s) return json({ ok: false, error: 'bad_device_ticket' }, 401);
      const t2 = phoneTickets(store, s.user, body.device_id);
      if (!t2.ok) return json(t2, 409);
      return json(Object.assign(t2, { device_ticket: issueDeviceTicket(store, s.user, t2.device_id) }));
    }
    const t = phoneTickets(store, dt.user, dt.device);
    if (!t.ok) return json(t, 409);
    return json(Object.assign(t, { device_ticket: issueDeviceTicket(store, dt.user, dt.device) }));
  }

  /* ── F‑06: پذیرش ثبت آفلاین؛ هویت فقط از نشست یا تیکت دستگاه ────────
     هر user_id/role/tenant_id که کلاینت در بدنه بفرستد نادیده گرفته
     می‌شود: پاکت با هویتِ همین درخواست امضا و در صندوقچه نوشته می‌شود. */
  if (p === '/api/outbox/submit' && m === 'POST') {
    const ip = (req.socket && req.socket.remoteAddress) || 'phone';
    if (!rateLimit('outbox-submit:' + ip, 240, 10 * 60_000)) return json({ ok: false, error: 'too_many' }, 429);
    let body = {};
    try { body = await readBody(req); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400); }
    const headerTicket = String(req.headers['x-phone-ticket'] || '');
    const ident = verifyDeviceTicket(store, headerTicket || body.device_ticket);
    let who = ident && ident.user;
    let device = ident && ident.device;
    if (!who) {
      const s2 = actorFrom(req);
      if (!s2) return json({ ok: false, error: 'unauthorized' }, 401);
      who = s2.user;
      device = (s2.device && s2.device.id) || body.device_id;
    }
    /* F‑06: ادعاهای هویتی در body/header/query فقط گزارش می‌شوند و هرگز
       به پاکت راه نمی‌یابند؛ هویت از نشست/تیکت است. */
    const claims = { body, header: req.headers, query: Object.fromEntries(url.searchParams) };
    const r = await outbox.submit(store, { user: who, device, items: body.items, claims });
    if (!r.ok) return json(r, r.error === 'no_cloud' ? 409 : 400);
    return json(r);
  }

  /* از این‌جا به بعد نیاز به نشست */
  const actor = actorFrom(req);
  if (!actor && p.startsWith('/api/')) {
    /* ردیف ۶۵ / ۴۴: نشستِ دستگاهِ باطل‌شده ⇒ سیگنال صریح پاک‌سازی از راه دور */
    const h = String(req.headers.authorization || '');
    const gone = h.startsWith('Bearer ') ? auth.sessionDeviceRevoked(store, h.slice(7).trim()) : null;
    if (gone) return json({ ok: false, error: 'device_revoked', reason: gone.reason, wipe: true }, 401);
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  if (p === '/api/me' && m === 'GET') {
    return json({ ok: true, user: userRow(actor.user), role: actor.role, device_id: actor.device ? actor.device.id : null });
  }

  if (p === '/api/auth/logout' && m === 'POST') {
    auth.logout(store, actor.session);
    return json({ ok: true });
  }

  /* F‑01: بستن همهٔ نشست‌ها/دستگاه‌های همین کاربر (مثلاً گوشی گم شده) */
  if (p === '/api/auth/revoke-all' && m === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch (e) { body = {}; }
    const keepCurrent = !!body.keep_current;
    const r = auth.revokeAll(store, actor.user.id, keepCurrent ? actor.session.token_hash : null);
    return json(r);
  }

  /* F‑01: مدیر می‌تواند نشست/دستگاه یک کاربر را باطل کند (کاربر اخراج‌شده) */
  const rv = p.match(/^\/api\/admin\/users\/(\d+)\/revoke$/);
  if (rv && m === 'POST') {
    if (actor.role !== 'manager') return json({ ok: false, error: 'forbidden' }, 403);
    const uid = Number(rv[1]);
    if (!store.get('users', uid)) return json({ ok: false, error: 'not_found' }, 404);
    return json(auth.revokeAll(store, uid, null));
  }

  if (p === '/api/auth/transfer' && m === 'POST') {
    const r = auth.createTransfer(store, actor.user.id, actor.device ? actor.device.id : null);
    return json(Object.assign(r, { public_url: cfg.publicUrl(store) || null }));
  }

  if (p === '/api/bootstrap' && m === 'GET') {
    const school = store.get('schools', 1) || {};
    const year = store.all('school_years').find(y => y.active) || {};
    return json({
      ok: true, server_time: nowISO(),
      school: { id: 1, name: school.name, type: school.type, level: school.level, city: school.city, capabilities: school.capabilities || {} },
      year: { title: year.title || '' },
      user: userRow(actor.user),
      role: actor.role,
      counts: {
        users: store.count('users'), classes: store.count('classes'),
        attendance: store.count('attendance'), grades: store.count('grades'),
      },
      version: readManifest().version,
      update: store.getMeta('update:last', null) || null,
    });
  }

  if (p === '/api/v1/pull' && m === 'GET') {
    const out = sync.pull(store, actor, { since: q.get('since'), since_seq: q.get('since_seq'), since_id: q.get('since_id'), collections: q.get('collections') });
    /* ردیف ۴۲: درخواست بدون تغییر ⇒ ۳۰۴ با بدنهٔ خالی. مکان‌نمای مرکب
       (since, since_id) بخشی از ETag است، پس ۳۰۴ هرگز دادهٔ جامانده را
       پنهان نمی‌کند. */
    if (out && out.etag) {
      res.setHeader('etag', out.etag);
      res.setHeader('cache-control', 'private, no-cache');
      if (String(req.headers['if-none-match'] || '') === out.etag) {
        res.writeHead(304);
        res.end();
        return;
      }
    }
    return json(out);
  }

  const crm = p.match(/^\/api\/conflicts\/(\d+)\/resolve$/);
  if (crm && m === 'POST') {
    const body = await readBody(req, 64 * 1024);
    const ctx = { device_id: actor.device ? actor.device.id : null, ip };
    const out = sync.resolveConflict(store, actor, Number(crm[1]), String(body && body.decision || ''), ctx);
    return json(out, out.ok ? 200 : (out.error === 'forbidden' ? 403 : 400));
  }

  if (p === '/api/sync' && m === 'POST') {
    const body = await readBody(req, 8 * 1024 * 1024);
    const ctx = { device_id: actor.device ? actor.device.id : null, ip };
    const out = sync.push(store, actor, body, ctx);
    /* قرارداد Sync v1: خطای سطح درخواست همیشه 4xx است، نه 200 با ok:false */
    if (!out || !out.ok) return json(out || { ok: false, error: 'write_failed' }, 400);
    /* ثبت‌های تازه در صندوقچهٔ ابری آینه می‌شوند تا اگر «مدرسه» دستگاهی
       دیگر باشد، همان‌ها را هم ببیند. خطای ابر هرگز جلوی ثبت را نمی‌گیرد. */
    if (out && out.ok && (out.applied || []).length) {
      const okUids = new Set((out.applied || []).map(a => a.uid));
      const fresh = (Array.isArray(body && body.ops) ? body.ops : []).filter(op => okUids.has(String(op && op.uid || '')));
      if (fresh.length) {
        outbox.mirror(store, actor, fresh, ctx)
          .then(m => { if (m && m.count) console.log('[outbox] ' + m.count + ' ثبت در صندوقچه آینه شد'); })
          .catch(() => { /* ابر در دسترس نیست — داده روی همین دستگاه محفوظ است */ });
      }
    }
    return json(out);
  }

  /* ── صندوقچهٔ آفلاین: وضعیت، اعمال دستی، خلاصهٔ دانش‌آموز ── */
  if (p === '/api/outbox/state' && m === 'GET') {
    return json(await outbox.state(store));
  }

  /* ── همگام‌سازی زنده: هر دستگاه هر ۱ ثانیه همین را می‌پرسد ────────── */
  if (p === '/api/live/rev' && m === 'GET') {
    return json({
      ok: true, rev: live.localRev(store), at: new Date().toISOString(),
      every_ms: live.INTERVAL_MS, cloud: !!(await live.cloudCfg(store)),
    });
  }

  if (p === '/api/live/state' && m === 'GET') {
    const st = live.status(store);
    let remote = null;
    try { remote = await live.readRemote(store); } catch (e) { remote = null; }
    const ob = await outbox.state(store);
    return json({ ok: true, every_ms: live.INTERVAL_MS, local_rev: st.local_rev,
      published_rev: st.published_rev, seen_rev: st.seen_rev, last: st.last,
      remote: remote ? { rev: remote.rev, at: remote.at, by: remote.by } : null,
      cloud: ob.cloud, bucket: ob.bucket, pending: ob.pending });
  }

  if (p === '/api/outbox/drain' && m === 'POST') {
    if (!outbox.SERVER_ROLES.has(actor.role)) return json({ ok: false, error: 'forbidden' }, 403);
    const out = await outbox.drain(store);
    const snap = await outbox.pushSnapshot(store).catch(() => ({ ok: false }));
    /* نسخهٔ گوشی (بدون سرور) هم تازه می‌شود: رمزها + دادهٔ هر نفر */
    const published = await outbox.publishAll(store).catch(() => null);
    return json(Object.assign({}, out, { snapshot: snap, published }));
  }

  /* انتشار دستی بستهٔ گوشی (وقتی مدیر کاربر یا رمزی را عوض کرده) */
  if (p === '/api/outbox/publish' && m === 'POST') {
    if (!outbox.SERVER_ROLES.has(actor.role)) return json({ ok: false, error: 'forbidden' }, 403);
    const r = await outbox.publishAll(store);
    return json(Object.assign({ ok: !!(r.auth && r.auth.ok) }, r));
  }

  if (p === '/api/outbox/snapshot' && m === 'GET') {
    const sid = Number(q.get('student_id'));
    if (!sid) return json({ ok: false, error: 'bad_student' }, 400);
    if (['parent', 'student'].includes(actor.role)) {
      /* ولی/دانش‌آموز فقط خلاصهٔ همان فرزند خودش را می‌بیند */
      const scope = policy.buildScope(store, actor.user);
      if (!scope.all && !scope.studentIds.has(sid)) return json({ ok: false, error: 'forbidden' }, 403);
    }
    return json(await outbox.readSnapshot(store, sid));
  }

  /* پروندهٔ یک دانش‌آموز با اسکوپ */
  const sm = p.match(/^\/api\/students\/(\d+)$/);
  if (sm && m === 'GET') {
    const id = Number(sm[1]);
    const scope = policy.buildScope(store, actor.user);
    if (!scope.all && !scope.studentIds.has(id)) return json({ ok: false, error: 'out_of_scope' }, 403);
    const u = store.get('users', id);
    if (!u || u.role !== 'student') return json({ ok: false, error: 'not_found' }, 404);
    /* ردیف ۵۷ (مرحلهٔ دوم): دبیر/ولی پروندهٔ دانش‌آموز را می‌بینند اما
       فیلدهای هویتی او (کد ملی، شناسنامه، شماره، نشانی) خیر — فقط مدیر
       و خودِ آن کاربر (درگاهِ پروندۀ شخصی). */
    const selfRow = Number(u.id) === Number(actor.user.id);
    const student = (actor.role === 'manager' || selfRow) ? userRow(u) : policy.scrubUserIdentity(userRow(u));
    return json({
      ok: true, student,
      attendance: store.byRef('attendance', 'ref2', id),
      grades: store.byRef('grades', 'ref2', id),
      internships: store.byRef('internships', 'ref2', id),
    });
  }

  /* ── مدیر ── */
  /* سد کلی: همهٔ /api/admin فقط برای مدیر — به‌جز آینه/پشتیبان/بازیابی که
     «عوامل اجرایی» هم باید ببینند و در صورت از دست رفتن داده استفاده کنند */
  const backupPath = /^\/api\/admin\/(mirror|restore|backups\/daily)/.test(p);
  if (p.startsWith('/api/admin/') && actor.role !== 'manager' && !(backupPath && BACKUP_ROLES.has(actor.role))) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }

  if (p === '/api/admin/stats' && m === 'GET') {
    const today = new Date().toISOString().slice(0, 10);
    const att = store.all('attendance').filter(a => a.date === today);
    const present = att.filter(a => a.status === 'present').length;
    const students = store.count('users', " AND json_extract(data,'$.role')='student'");
    return json({
      ok: true, today, students,
      attendance_today: att.length,
      present_today: present,
      absent_today: att.filter(a => a.status === 'absent').length,
      late_today: att.filter(a => a.status === 'late').length,
      grades_pending: store.count('grades', " AND json_extract(data,'$.status')='pending'"),
      devices: store.db.prepare('SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL').get().n,
      audit: store.recentAudit(15),
      stats: store.stats(),
      version: readManifest().version,
    });
  }

  if (p === '/api/admin/pair-code' && m === 'POST') {
    const body = await readBody(req);
    /* refresh=true ⇒ کد قبلی همان لحظه باطل و کد تازه ساخته می‌شود */
    const r = auth.createPairCode(store, Number(body.user_id), actor.user.id, { refresh: !!body.refresh });
    return json(r, r.ok ? 200 : 400);
  }

  if (p === '/api/admin/network' && m === 'GET') {
    if (actor.role !== 'manager') return json({ ok: false, error: 'forbidden' }, 403);
    return json({
      ok: true,
      public_url: cfg.publicUrl(store) || null,
      lan_urls: cfg.lanUrls(PORT),
      port: PORT,
      instance: cfg.instanceId(store),
      tunnel: await cfg.tunnelStatus(store, { force: q.get('force') === '1' }),
      public: await tunnel.status(store),
    });
  }

  if (p === '/api/admin/network' && m === 'POST') {
    if (actor.role !== 'manager') return json({ ok: false, error: 'forbidden' }, 403);
    const body = await readBody(req);
    if (body.public_url !== undefined) {
      const u = cfg.normalizeUrl(body.public_url);
      if (u && !/^https:\/\//i.test(u)) return json({ ok: false, error: 'https_required' }, 400);
      cfg.setMeta(store, 'public_url', u);
      /* آدرس دستی = اولویت «custom»؛ تونل خودکار آن را بازنویسی نمی‌کند */
      cfg.setMeta(store, 'tunnel_provider', u ? 'custom' : '');
      store.audit({ user_id: actor.user.id, role: 'manager', action: 'network_public_url', collection: 'config', after: { public_url: u } });
    }
    return json({
      ok: true,
      public_url: cfg.publicUrl(store) || null,
      tunnel: await cfg.tunnelStatus(store, { force: true }),
    });
  }

  /* ── تونل عمومی: دسترسی از هر اینترنتی ─────────────────────────── */
  if (p === '/api/admin/tunnel' && m === 'GET') {
    if (actor.role !== 'manager') return json({ ok: false, error: 'forbidden' }, 403);
    const st = await tunnel.status(store);
    st.probe = await cfg.tunnelStatus(store, { force: q.get('force') === '1' });
    return json(st);
  }

  if (p === '/api/admin/tunnel' && m === 'POST') {
    if (actor.role !== 'manager') return json({ ok: false, error: 'forbidden' }, 403);
    const body = await readBody(req).catch(() => ({}));
    const action = String(body.action || 'refresh');

    if (action === 'enable') {
      const r = await tunnel.enableFunnel(PORT);
      if (r.ok) tunnel.rememberPublicUrl(store, r.url, 'tailscale');
      store.audit({ user_id: actor.user.id, role: 'manager', action: 'tunnel_enable', collection: 'config', after: r });
      return json(Object.assign({ ok: r.ok }, r, { status: await tunnel.status(store) }), r.ok ? 200 : 400);
    }

    if (action === 'login') {
      const r = tunnel.login();
      return json(Object.assign({ ok: r.ok }, r, { status: await tunnel.status(store) }), r.ok ? 200 : 400);
    }

    if (action === 'off') {
      if (body.tailscale_too) await tunnel.disableFunnel(PORT);
      cfg.setMeta(store, 'public_url', '');
      store.audit({ user_id: actor.user.id, role: 'manager', action: 'tunnel_off', collection: 'config' });
      return json({ ok: true, status: await tunnel.status(store) });
    }

    if (action !== 'refresh') return json({ ok: false, error: 'unknown_action' }, 400);

    /* refresh: فقط تشخیص */
    const r = await tunnel.refresh(store, { quiet: false });
    return json(Object.assign({ ok: true }, r, { status: await tunnel.status(store) }));
  }

  /* ── حافظهٔ ابری (صندوقچهٔ S3 ایرانی) ─────────────────────────────── */
  /* پیکربندی صندوقچه برای «هر دستگاهِ واردشده» — گوشی/تبلت هم بدون تایپ کلید می‌داند
     کجا بنویسد (برای وقتی که سیستم مدرسه خاموش است). کلید فقط به کاربر واردشده داده می‌شود. */
  if (p === '/api/cloud/config' && m === 'GET') {
    /* D‑23/F‑04: این مسیر فقط «فراداده» می‌دهد — هیچ accessKey/secretی، برای هیچ نقشی.
       نوشتن در صندوقچه فقط از سرور انجام می‌شود (upload: 'server'). */
    let c = s3mem.usingMeta(store).get();
    if (!c.bucket && c.accessKey) { try { c = await s3mem.ensureBucket(store); } catch (e) { /* بعداً */ } }
    return json({
      ok: true,
      config: {
        endpoint: c.endpoint, bucket: c.bucket, region: c.region, prefix: c.prefix,
        pathStyle: c.pathStyle,
      },
      upload: 'server',
      ready: !!(c.endpoint && c.bucket && c.accessKey && c.secret),
    });
  }

  if (p === '/api/admin/cloud' && m === 'GET') {
    /* اگر نام صندوقچه هنوز معلوم نیست، همین‌جا از حساب می‌پرسیم */
    let view = s3mem.usingMeta(store).get();
    if (!view.bucket && view.accessKey && view.secret) {
      try { view = await s3mem.ensureBucket(store); } catch (e) { /* بی‌اینترنت — همان پیش‌فرض */ }
    }
    /* حتی برای مدیر هم کلید بازخوانی نمی‌شود (D‑23): فقط «هست/نیست» و سرنخ چهارنویسه‌ای.
       نوشتن کلید تازه از همین مسیر مجاز است (write-only)، بازخوانی نه. */
    return json({
      ok: true,
      config: {
        endpoint: view.endpoint, bucket: view.bucket, region: view.region, prefix: view.prefix,
        pathStyle: view.pathStyle,
        secret: view.secret ? '••••••••' : '',
        accessKey: view.accessKey ? view.accessKey.slice(0, 4) + '…' : '',
        has_secret: !!view.secret,
        has_access_key: !!view.accessKey,
        configured: !!(view.endpoint && view.bucket && view.accessKey && view.secret),
        source: view.source || (s3mem.usingMeta(store).isDefault() ? 'default' : 'saved'),
        built_in: s3mem.usingMeta(store).isDefault(),
        reveal_allowed: false,
      },
      region_guess: s3mem.regionOf(view),
    });
  }

  if (p === '/api/admin/cloud' && m === 'POST') {
    const body = await readBody(req);
    const cur = s3mem.usingMeta(store).get();
    const next = s3mem.normalize(Object.assign({}, cur, body));
    /* اگر کاربر کلید را با • فرستاد، همان قبلی بماند */
    if (/^•+$/.test(String(body.secret || ''))) next.secret = cur.secret;
    if (/…$/.test(String(body.accessKey || ''))) next.accessKey = cur.accessKey;
    s3mem.usingMeta(store).set(next);
    store.audit({ user_id: actor.user.id, role: 'manager', action: 'cloud_config', collection: 'meta' });
    let out = next;
    if (!out.bucket && out.accessKey && out.secret) {
      try { out = await s3mem.ensureBucket(store); } catch (e) { /* بعداً دوباره */ }
    }
    return json({ ok: true, bucket: out.bucket || null,
      configured: !!(out.endpoint && out.bucket && out.accessKey && out.secret) });
  }

  if (p === '/api/admin/cloud/phone-check' && m === 'POST') {
    if (actor.role !== 'manager') return json({ ok: false, error: 'forbidden' }, 403);
    const steps = [];
    let cfg = s3mem.normalize(s3mem.usingMeta(store).get());
    if (!cfg.bucket) {
      try { cfg = await s3mem.ensureBucket(store); steps.push({ step: 'bucket', ok: !!cfg.bucket, bucket: cfg.bucket || null }); }
      catch (e) { steps.push({ step: 'bucket', ok: false, error: e.message }); }
    } else steps.push({ step: 'bucket', ok: true, bucket: cfg.bucket });
    if (!cfg.bucket) return json({ ok: false, steps });
    let probe = await s3mem.corsProbe(cfg);
    steps.push({ step: 'cors', ok: !!probe.ok, status: probe.status, allow_origin: probe.allow_origin, error: probe.error || null });
    if (!probe.ok && probe.reachable) {
      /* اجازه نبود: همین‌جا می‌گذاریم و دوباره آزمایش می‌کنیم */
      try {
        await s3mem.setCors(cfg);
        steps.push({ step: 'set_cors', ok: true });
      } catch (e) {
        steps.push({ step: 'set_cors', ok: false, error: e.message, status: e.status || 0, detail: String(e.detail || '').slice(0, 200) });
      }
      probe = await s3mem.corsProbe(cfg);
      steps.push({ step: 'cors_after', ok: !!probe.ok, status: probe.status, allow_origin: probe.allow_origin, error: probe.error || null });
    }
    store.audit({ user_id: actor.user.id, role: 'manager', action: 'cloud_phone_check', collection: 'meta' });
    return json({ ok: !!probe.ok, bucket: cfg.bucket, steps });
  }

  if (p === '/api/admin/cloud/reset' && m === 'POST') {
    s3mem.usingMeta(store).clear();
    outbox.forgetPutHashes();
    store.setMeta('live:published', '');
    store.setMeta('live:seen', '');
    store.audit({ user_id: actor.user.id, role: 'manager', action: 'cloud_reset', collection: 'meta' });
    let out = s3mem.usingMeta(store).get();
    try { out = await s3mem.ensureBucket(store); } catch (e) { /* بدون اینترنت */ }
    return json({ ok: true, bucket: out.bucket || null, source: 'default' });
  }

  if (p === '/api/admin/cloud/test' && m === 'POST') {
    const body = await readBody(req);
    const cur = s3mem.usingMeta(store).get();
    const merged = Object.assign({}, cur, body && body.config ? body.config : {});
    if (/^•+$/.test(String(merged.secret || ''))) merged.secret = cur.secret;
    const result = await s3mem.test(s3mem.normalize(merged));
    store.audit({ user_id: actor.user.id, role: 'manager', action: 'cloud_test', collection: 'meta' });
    return json(Object.assign({ ok: !!result.ok }, result));
  }


  if (p === '/api/admin/cloud/cors' && m === 'POST') {
    const body = await readBody(req);
    const cur = s3mem.usingMeta(store).get();
    let cfg = s3mem.normalize(Object.assign({}, cur, body && body.config ? body.config : {}));
    if (/^•+$/.test(String(cfg.secret || ''))) cfg.secret = cur.secret;
    cfg = s3mem.smartParse(cfg);
    try {
      await s3mem.setCors(cfg);
      const back = await s3mem.getCors(cfg);
      store.audit({ user_id: actor.user.id, role: 'manager', action: 'cloud_cors', collection: 'meta' });
      return json({ ok: true, origins: (back && back.origins) || [], applied: s3mem.CORS_XML ? true : true });
    } catch (e) {
      return json({ ok: false, error: e.message, detail: e.detail || null, status: e.status || 0 }, 200);
    }
  }

  /* ── رمز جاری همهٔ کاربران — فقط مدیر، برای اینکه بتواند رمز را بگوید ── */
  if (p === '/api/admin/users/credentials' && m === 'GET') {
    if (actor.role !== 'manager') return json({ ok: false, error: 'forbidden' }, 403);
    /* ردیف ۲۸: پاسخ گاوصندوق نباید در هیچ کشی بنشیند */
    res.setHeader('cache-control', 'no-store, max-age=0');
    res.setHeader('pragma', 'no-cache');
    const rows = (store.all('users') || []).map(u => ({
      id: u.id, name: u.name, role: u.role,
      phone: u.phone || '', password: auth.passwordOf(store, u),
    }));
    return json({ ok: true, users: rows });
  }

  /* ── حذف دسته‌ای کاربران ──────────────────────────────────────────── */
  if (p === '/api/admin/users/bulk-delete' && m === 'POST') {
    if (actor.role !== 'manager') return json({ ok: false, error: 'forbidden' }, 403);
    const body = await readBody(req);
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number)
      .filter(n => Number.isFinite(n) && n > 0 && n !== Number(actor.user.id));
    let deleted = 0, parentsDeleted = 0;
    for (const id of ids) {
      const user = store.get('users', id);
      if (!user) continue;
      /* دانش‌آموز ⇒ پیوندهای ولی پاک و ولیِ بی‌فرزند هم حذف می‌شود */
      const links = (store.all('parent_links') || [])
        .filter(l => Number(l.parent_id) === id || Number(l.student_id) === id);
      const parentIds = [...new Set(links.filter(l => Number(l.student_id) === id).map(l => Number(l.parent_id)))];
      store.remove('users', id);
      for (const l of links) store.remove('parent_links', l.id);
      for (const pid of parentIds) {
        if (!pid || ids.indexOf(pid) > -1) continue;
        const stillLinked = (store.all('parent_links') || []).some(l => Number(l.parent_id) === pid);
        const pu = store.get('users', pid);
        if (stillLinked || !pu || pu.role !== 'parent') continue;
        store.remove('users', pid);
        store.audit({ user_id: actor.user.id, role: 'manager', action: 'user_delete', collection: 'users', record_id: pid, before: auth.publicUser(pu) });
        parentsDeleted += 1;
      }
      store.audit({ user_id: actor.user.id, role: 'manager', action: 'user_delete', collection: 'users', record_id: id, before: auth.publicUser(user) });
      deleted += 1;
    }
    if (deleted) outbox.publishAll(store).catch(() => null);
    return json({ ok: true, deleted, parents_deleted: parentsDeleted });
  }

  /* ── ویرایش/حذف کاربر توسط مدیر (نام کاربری = شماره، رمز) ─────────── */
  const um = p.match(/^\/api\/admin\/users\/(\d+)$/);
  if (um && (m === 'PATCH' || m === 'PUT')) {
    if (actor.role !== 'manager') return json({ ok: false, error: 'forbidden' }, 403);
    const id = Number(um[1]);
    const user = store.get('users', id);
    if (!user) return json({ ok: false, error: 'user_not_found' }, 404);
    const body = await readBody(req);
    const patch = {};
    if (body.name) patch.name = String(body.name).trim().slice(0, 80);
    if (body.phone != null) {
      const phone = normDigits(body.phone);
      if (phone && phone.length < 10) return json({ ok: false, error: 'bad_phone' }, 400);
      const dup = phone && auth.phoneTaken(store, phone, id);
      if (dup) return json({ ok: false, error: 'duplicate_phone', name: dup.name }, 409);
      patch.phone = phone;
    }
    if (body.national_id != null) {
      const nid = normDigits(body.national_id);
      if (nid && !validNationalId(nid)) return json({ ok: false, error: 'bad_national_id' }, 400);
      patch.national_id = nid;
    }
    if (body.active != null) patch.active = !!body.active;
    if (body.role && ['student', 'teacher', 'parent', 'vice', 'counselor', 'office', 'staff', 'manager'].includes(body.role)) patch.role = body.role;
    /* فیلدهای شناسنامه‌ای و تکمیلی (تاریخ تولد، جنسیت، پدر و مادر، …) */
    for (const k of IMP_STORE_FIELDS) {
      if (body[k] === undefined) continue;
      const v = body[k];
      patch[k] = (v === null || v === '') ? '' : v;
    }
    /* شماره‌های همراه همیشه ۱۱ رقمیِ «09…» ذخیره می‌شوند */
    ['phone', 'father_phone', 'mother_phone', 'guardian_phone'].forEach(k => {
      if (patch[k] === undefined) return;
      const v = normalizeMobile(patch[k]);
      if (v) patch[k] = v;
    });
    /* فیلدهای دلخواهی که مدیر خودش در ورود اکسل تعریف کرده (x_…) */
    for (const k of Object.keys(body)) {
      if (!/^x_[\w\u0600-\u06FF-]{1,60}$/.test(k)) continue;
      const v = body[k];
      patch[k] = (v === null || v === '') ? '' : String(v).slice(0, 200);
    }
    if (body.birth_date) {
      const bd = String(body.birth_date).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(bd)) return json({ ok: false, error: 'bad_birth_date' }, 400);
      patch.birth_date = bd;
    }
    if (body.class_id !== undefined) patch.class_id = Number(body.class_id) || null;
    const saved = store.update('users', id, patch);
    let pw = null;
    let shownPassword = null;
    if (body.password) { pw = auth.setPassword(store, id, body.password); shownPassword = String(body.password); }
    else if (body.auto_password) {
      /* «ساخت/بازسازی رمز»: کد ملی، و اگر کد ملی نبود رمز تصادفی —
         هیچ حسابی نباید بی‌رمز بماند. */
      const cur = store.get('users', id) || {};
      const c = auth.credentialsFor(cur);
      if (!c) return json({ ok: false, error: 'no_phone' }, 400);
      pw = auth.setPassword(store, id, c.password);
      shownPassword = c.password;
    }
    store.audit({ user_id: actor.user.id, role: 'manager', action: 'user_update', collection: 'users', record_id: id, after: Object.assign({}, patch, pw ? { password_changed: true } : {}) });
    /* گوشی‌ها بی‌درنگ نام کاربری/رمز تازه را ببینند */
    outbox.publishAll(store).catch(() => null);
    return json({
      ok: true, user: auth.publicUser(store.get('users', id)),
      password: pw && pw.ok ? shownPassword : null,
      password_set: !!(pw && pw.ok), error: pw && !pw.ok ? pw.error : undefined,
    });
  }

  if (um && m === 'DELETE') {
    if (actor.role !== 'manager') return json({ ok: false, error: 'forbidden' }, 403);
    const id = Number(um[1]);
    const user = store.get('users', id);
    if (!user) return json({ ok: false, error: 'user_not_found' }, 404);
    if (id === actor.user.id) return json({ ok: false, error: 'cannot_delete_self' }, 400);
    store.remove('users', id);
    const links = (store.all('parent_links') || [])
      .filter(l => Number(l.parent_id) === id || Number(l.student_id) === id);
    for (const l of links) store.remove('parent_links', l.id);
    store.audit({ user_id: actor.user.id, role: 'manager', action: 'user_delete', collection: 'users', record_id: id, before: auth.publicUser(user) });
    outbox.publishAll(store).catch(() => null);
    return json({ ok: true, deleted: id });
  }

  if (p === '/api/auth/password' && m === 'POST') {
    const body = await readBody(req);
    const r = auth.changeOwnPassword(store, actor.user.id, body.current, body.next);
    if (!r.ok) return json(r, 400);
    store.audit({ user_id: actor.user.id, role: actor.role, action: 'password_change', collection: 'users' });
    return json({ ok: true });
  }

  const pwUser = p.match(/^\/api\/admin\/users\/(\d+)\/password$/);
  if (pwUser && m === 'POST') {
    if (actor.role !== 'manager') return json({ ok: false, error: 'forbidden' }, 403);
    const body = await readBody(req);
    const r = auth.setPassword(store, Number(pwUser[1]), body.password);
    if (!r.ok) return json(r, 400);
    store.audit({ user_id: actor.user.id, role: 'manager', action: 'password_set', collection: 'users', record_id: Number(pwUser[1]) });
    /* ردیف ۶۵: رمز خام دیگر در پاسخ بازتاب نمی‌شود (لاگ پراکسی/کش/ابزار توسعه).
       مدیر همان رمزی را که تایپ کرده در دست دارد؛ جدول رمزها از /api/admin/users/credentials می‌خواند. */
    return json({ ok: true });
  }

  if (p === '/api/admin/devices' && m === 'GET') return json({ ok: true, devices: auth.listDevices(store) });

  const dm = p.match(/^\/api\/admin\/devices\/([a-f0-9]+)$/);
  if (dm && m === 'DELETE') {
    auth.revokeDevice(store, dm[1], 'manager');
    store.audit({ user_id: actor.user.id, role: 'manager', device_id: dm[1], action: 'device_revoke', collection: 'devices', after: { wipe: true } });
    return json({ ok: true });
  }

  /* row 88: deleted-records view (metadata only) and tombstone retention purge — manager only (admin gate) */
  if (p === '/api/admin/tombstones' && m === 'GET') {
    const col = q.get('collection');
    if (col && !policy.collectionAllowed(col)) return json({ ok: false, error: 'bad_collection' }, 400);
    const rows = store.tombstones(Number(q.get('limit') || 200), col || null);
    return json({ ok: true, rows, count: rows.length, retain_days: privacy.tombstoneRetainDays() });
  }
  if (p === '/api/admin/tombstones/purge' && m === 'POST') {
    const body = await readBody(req);
    const days = privacy.checkRetainDays(body && body.retain_days);
    if (days === null) return json({ ok: false, error: 'bad_retain_days', min: privacy.TOMBSTONE_MIN_DAYS, max: privacy.TOMBSTONE_MAX_DAYS }, 400);
    const out = store.purgeTombstones(days);
    store.audit({ user_id: actor.user.id, role: 'manager', action: 'tombstones_purge', collection: 'records', after: { purged: out.purged, retain_days: days } });
    return json(Object.assign({ ok: true }, out));
  }

  if (p === '/api/admin/audit' && m === 'GET') {
    return json({ ok: true, rows: store.recentAudit(Number(q.get('limit') || 100)) });
  }

  /* ── به‌روزرسانی درجا: بررسی، اعمال، بازگشت ─────────────────────── */
  if (p === '/api/admin/update' && m === 'GET') {
    const plan = await update.plan(store, { force: false });
    const last = store.getMeta('update:last', null);
    return json({
      ok: true,
      auto: update.autoCheckEnabled(store),
      auto_apply: update.autoApplyEnabled(store),
      base: String(process.env.PAYESH_UPDATE_BASE || cfg.getMeta(store, 'update_base') || ''),
      bases: update.bases(store),
      running_version: RUNNING_VERSION,
      installed_version: readManifest().version,
      restart_pending: readManifest().version !== RUNNING_VERSION,
      plan,
      last,
      progress: update.status(),
      state: update.snapshot(store),
    });
  }

  /* وضعیت لحظه‌ای به‌روزرسانی — همان شکل snapshot در k3-reval */
  if (p === '/api/admin/update/state' && m === 'GET') {
    update.fullInstallerInfo().catch(() => {});
    return json({ ok: true, state: update.snapshot(store), running_version: RUNNING_VERSION });
  }

  /* مرحلهٔ ۱: دانلود (بدون تغییر برنامه) — کلاینت درصد را از /state می‌خواند */
  if (p === '/api/admin/update/download' && m === 'POST') {
    if (!rateLimit('update-dl:' + ip, 8, 60_000)) return json({ ok: false, error: 'rate_limited' }, 429);
    const r = await update.download(store, { force: true });
    return json(r, r.ok ? 200 : 502);
  }

  /* مرحلهٔ ۲: نصب آنچه دانلود شده */
  if (p === '/api/admin/update/install' && m === 'POST') {
    if (!rateLimit('update-in:' + ip, 6, 60_000)) return json({ ok: false, error: 'rate_limited' }, 429);
    const r = await update.install(store, { by: (actor.user && actor.user.name) || 'manager' });
    if (r.ok && r.applied) {
      if (r.restart) scheduleRestart('update');
      return json(Object.assign(r, { restarting: !!(r.restart && autoRestartEnabled()), state: update.snapshot(store) }));
    }
    return json(Object.assign(r, { state: update.snapshot(store) }), r.ok ? 200 : 502);
  }

  if (p === '/api/admin/update/check' && m === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const plan = await update.plan(store, { force: body.force !== false });
    store.setMeta('update:checked', { at: nowISO(), available: !!plan.available, version: plan.remote_version || null, error: plan.ok ? null : plan.error });
    return json({ ok: true, plan });
  }

  if (p === '/api/admin/update/apply' && m === 'POST') {
    if (!rateLimit('update:' + ip, 6, 60_000)) return json({ ok: false, error: 'rate_limited' }, 429);
    const body = await readBody(req).catch(() => ({}));
    const r = await update.apply(store, { force: true, by: actor.user.name || 'manager' });
    if (r.ok && r.applied) {
      /* اگر کد سرور عوض شده، همین پروسه باید دوباره بالا بیاید */
      if (r.restart) scheduleRestart('update');
      return json(Object.assign(r, { restarting: !!(r.restart && autoRestartEnabled()) }));
    }
    return json(r, r.ok ? 200 : 502);
  }

  if (p === '/api/admin/update/rollback' && m === 'POST') {
    const r = update.rollback(store);
    if (r.ok) scheduleRestart('rollback');
    return json(Object.assign(r, { restarting: r.ok && autoRestartEnabled() }), r.ok ? 200 : 400);
  }

  if (p === '/api/admin/update/settings' && m === 'POST') {
    const body = await readBody(req);
    if (body.auto != null) cfg.setMeta(store, 'update_auto', !!body.auto);
    if (body.auto_apply != null) cfg.setMeta(store, 'update_auto_apply', !!body.auto_apply);
    if (body.base != null) {
      const b = String(body.base).trim();
      if (b && !/^https?:\/\//i.test(b)) return json({ ok: false, error: 'bad_url' }, 400);
      cfg.setMeta(store, 'update_base', b);
    }
    return json({ ok: true, auto: update.autoCheckEnabled(store), auto_apply: update.autoApplyEnabled(store), base: cfg.getMeta(store, 'update_base') || '' });
  }

  if (p === '/api/admin/update/restart' && m === 'POST') {
    scheduleRestart('manual');
    return json({ ok: true, restarting: true });
  }

  if (p === '/api/admin/backup' && m === 'POST') {
    const file = store.backupTo(BACKUP_DIR, 48);
    return json({ ok: true, file: path.basename(file), size: fs.statSync(file).size });
  }
  /* ══ آینهٔ داده + پشتیبان روزانه ══════════════════════════════════
     درخواست کاربر: اطلاعات در خودِ سیستم هم باشد، هر بار با دیتابیس
     مقایسه شود، هر روز یک فایل پشتیبان ساخته و به‌روز شود و بتوان
     همان فایل را در دیتابیس تازه آپلود (بازیابی) کرد. */
  if (p === '/api/admin/mirror' && m === 'GET') {
    if (!BACKUP_ROLES.has(actor.role)) return json({ ok: false, error: 'forbidden' }, 403);
    return json({
      ok: true,
      mirror: mirror.compareMirror(store, MIRROR_DIR),
      daily: mirror.listDaily(DAILY_BACKUP_DIR),
      dirs: { mirror: MIRROR_DIR, daily: DAILY_BACKUP_DIR },
      today: mirror.dayStamp(),
    });
  }
  if (p === '/api/admin/mirror/refresh' && m === 'POST') {
    if (!BACKUP_ROLES.has(actor.role)) return json({ ok: false, error: 'forbidden' }, 403);
    const mres = mirror.refreshMirror(store, MIRROR_DIR, { force: true });
    const dres = mirror.refreshDaily(store, DAILY_BACKUP_DIR);
    store.audit({ role: actor.role, action: 'mirror_refresh', collection: 'users', after: { total: mres.total } });
    return json({
      ok: true,
      mirror: mirror.compareMirror(store, MIRROR_DIR),
      daily: mirror.listDaily(DAILY_BACKUP_DIR),
      dirs: { mirror: MIRROR_DIR, daily: DAILY_BACKUP_DIR },
      today: mirror.dayStamp(),
      written: { mirror: mres.changed, daily: dres.changed },
    });
  }
  if (p === '/api/admin/mirror/download' && m === 'GET') {
    if (!BACKUP_ROLES.has(actor.role)) return json({ ok: false, error: 'forbidden' }, 403);
    const f = path.join(MIRROR_DIR, 'payesh-data.json');
    if (!sendFile(req, res, f, { download: true, noStore: true })) return json({ ok: false, error: 'not_found' }, 404);
    return null;
  }
  if (p === '/api/admin/backups/daily' && m === 'GET') {
    if (!BACKUP_ROLES.has(actor.role)) return json({ ok: false, error: 'forbidden' }, 403);
    return json({ ok: true, files: mirror.listDaily(DAILY_BACKUP_DIR), dir: DAILY_BACKUP_DIR });
  }
  const dailyFile = p.match(/^\/api\/admin\/backups\/daily\/([A-Za-z0-9._-]+\.json)$/);
  if (dailyFile && m === 'GET') {
    if (!BACKUP_ROLES.has(actor.role)) return json({ ok: false, error: 'forbidden' }, 403);
    const f = safeJoin(DAILY_BACKUP_DIR, dailyFile[1]);
    if (!f || !sendFile(req, res, f, { download: true, noStore: true })) return json({ ok: false, error: 'not_found' }, 404);
    return null;
  }
  /* بازیابی: متن فایل پشتیبان روزانه در یک پایگاه (تازه یا همین) */
  if (p === '/api/admin/restore' && m === 'POST') {
    if (!BACKUP_ROLES.has(actor.role)) return json({ ok: false, error: 'forbidden' }, 403);
    const body = await readBody(req, 64 * 1024 * 1024);
    /* پیش از هر بازیابی، یک نسخهٔ ایمنی از وضعیت فعلی */
    let safety = '';
    try { safety = path.basename(store.backupTo(BACKUP_DIR, 48)); } catch (e) { safety = ''; }
    if (actor.role !== 'manager') return json({ ok: false, error: 'forbidden' }, 403);
    const r = mirror.restore(store, body && body.data, { replace: !!(body && body.replace), actor });
    if (!r.ok) return json({ ok: false, error: r.error, safety }, 400);
    try { mirror.refreshMirror(store, MIRROR_DIR, { force: true }); mirror.refreshDaily(store, DAILY_BACKUP_DIR); } catch (e) { /* بی‌صدا */ }
    store.audit({ role: actor.role, action: 'restore', collection: 'users', after: { report: r.report, safety } });
    return json({ ok: true, report: r.report, safety });
  }

  if (p === '/api/admin/backups' && m === 'GET') {
    if (!BACKUP_ROLES.has(actor.role)) return json({ ok: false, error: 'forbidden' }, 403);
    let files = [];
    try { files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.sqlite')).sort().reverse(); } catch (e) { /* noop */ }
    /* ردیف ۲۹: مسیر مطلق سرور بیرون نمی‌رود */
    return json({ ok: true, files, count: files.length });
  }
  const bm = p.match(/^\/api\/admin\/backups\/([A-Za-z0-9._-]+)$/);
  if (bm && m === 'GET') {
    const f = safeJoin(BACKUP_DIR, bm[1]);
    if (!f || !sendFile(req, res, f, { download: true, noStore: true })) return json({ ok: false, error: 'not_found' }, 404);
    return null;
  }

  /* ورود دسته‌ای کاربران (CSV از سمت کلاینت پارس می‌شود) */
  if (p === '/api/admin/import' && m === 'POST') {
    const body = await readBody(req, 8 * 1024 * 1024);
    return json(importUsers(body));
  }

  if (p === '/api/admin/export' && m === 'GET') {
    const collection = String(q.get('collection') || 'users');
    if (!policy.collectionAllowed(collection)) return json({ ok: false, error: 'bad_collection' }, 400);
    /* ردیف ۲۸: خروجی هرگز هش/رمز/اعتبارنامه را بیرون نمی‌دهد.
       ردیف ۵۷ (تصمیم D1): مدیر فیلدهای شناسنامه‌ای (national_id و زیرگروه‌ها) را
       برای امور اداری مدرسه می‌بیند؛ رمز/هش/توکن برای همه نقش‌ها حذف می‌شود. */
    const rows = (store.all(collection) || []).map((row) => exportRow(row, actor.role));
    return { status: 200, headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${collection}.csv"`,
      'cache-control': 'no-store',
    }, body: toCSV(rows) };
  }

  if (p === '/api/admin/settings' && m === 'POST') {
    const body = await readBody(req);
    const s = store.get('schools', 1) || {};
    const patch = {};
    if (body.name) patch.name = String(body.name).slice(0, 80);
    if (body.city != null) patch.city = String(body.city).slice(0, 60);
    if (body.capabilities) patch.capabilities = Object.assign({}, s.capabilities || {}, body.capabilities);
    const saved = store.update('schools', 1, patch);
    return json({ ok: true, school: saved });
  }

  return json({ ok: false, error: 'not_found' }, 404);
}

/* ── ورود دسته‌ای از اکسل ───────────────────────────────────────────
   چهار نوع فایل، همان چهار نوعی که در نسخهٔ p2 هست:
     students   → دانش‌آموز + کلاس + حساب پدر و مادر + همهٔ فیلدهای تکمیلی
     teachers   → دبیر (درس تخصصی، مدرک، آدرس)
     grades     → نمرهٔ دورهٔ گذشته برای دانش‌آموزِ موجود
     attendance → حضور و غیاب دورهٔ گذشته برای دانش‌آموزِ موجود
   قاعده‌ها:
     • کد ملیِ موجود ⇒ به‌روزرسانی، نه خطای تکراری (مثل p2)
     • کلاس ناشناس ساخته می‌شود
     • شمارهٔ همراه باید یکتا بماند، چون نام کاربری همان است
   ─────────────────────────────────────────────────────────────────── */
const IMP_STORE_FIELDS = ['first_name', 'last_name', 'national_id', 'phone', 'birth_date', 'gender',
  'grade', 'mode',
  'father_nid', 'mother_nid', 'father_name', 'mother_name', 'father_phone', 'mother_phone',
  'field', 'last_gpa', 'failed_count', 'father_edu', 'father_alive', 'father_job',
  'mother_edu', 'mother_alive', 'mother_job', 'guardian', 'guardian_alive', 'sisters', 'brothers',
  'covered', 'org_type', 'org_percent', 'talent', 'landline', 'residence', 'village',
  'residence_status', 'address', 'shenasname_serial', 'shenasname_seri', 'degree', 'subject'];

/* یکسان‌سازی متن فارسی برای تطبیق نام کلاس/درس */
function importKey(x) {
  return String(x == null ? '' : x)
    .replace(/[ىي]/g, 'ی').replace(/ك/g, 'ک')
    .replace(/\u200c/g, ' ')
    .replace(/[_\-.:،؛/\\()\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

/* ── کلاس = پایه + رشته ──────────────────────────────────────────────
   همان قاعدهٔ سمت گوشی/ویندوز: رشته هرگز به‌جای کلاس ساخته نمی‌شود.
   اگر پایه پیدا نشود، کلاسی ساخته نمی‌شود و دانش‌آموز بی‌کلاس می‌ماند
   تا در «نیازمند پیگیری» کامل شود. */
const IMPORT_GRADE_WORDS = ['پیش‌دانشگاهی', 'پیش دانشگاهی',
  'دوازدهم', 'یازدهم', 'دهم', 'نهم', 'هشتم', 'هفتم', 'ششم', 'پنجم', 'چهارم', 'سوم', 'دوم', 'اول'];
const IMPORT_GRADE_NUM = { 12: 'دوازدهم', 11: 'یازدهم', 10: 'دهم', 9: 'نهم', 8: 'هشتم', 7: 'هفتم', 6: 'ششم', 5: 'پنجم', 4: 'چهارم', 3: 'سوم', 2: 'دوم', 1: 'اول' };

function importLev(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[n];
}

/* پایه فقط ۱..۱۲ است؛ «الکترونیک» یا «ریاضی» هرگز پایه نیست. */
function importGradeLevel(txt) {
  let t = importKey(txt);
  if (!t) return 0;
  t = t.replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
       .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const words = { 'اول': 1, 'دوم': 2, 'سوم': 3, 'چهارم': 4, 'پنجم': 5, 'ششم': 6, 'هفتم': 7, 'هشتم': 8, 'نهم': 9, 'دهم': 10, 'یازدهم': 11, 'دوازدهم': 12 };
  for (const w of Object.keys(words)) if (t === w || t.indexOf(w) > -1) return words[w];
  const m = t.match(/(?:^|\s)(\d{1,2})(?:\s|$)/);
  return (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) ? Number(m[1]) : 0;
}

function importGradeCanon(txt, known) {
  const t = importKey(txt);
  if (!t) return '';
  /* «یازدهم» خودش «دهم» را در خود دارد؛ پس اول واژه‌های بلندتر بررسی
     می‌شوند تا پایه اشتباه خوانده نشود. از تعریف‌ها فقط پایه‌های واقعی. */
  const cands = [];
  for (const g of (known || [])) if (importGradeLevel(g)) cands.push({ src: g, key: importKey(g) });
  for (const g of IMPORT_GRADE_WORDS) cands.push({ src: importKey(g) === 'پیش دانشگاهی' ? 'پیش‌دانشگاهی' : g, key: importKey(g) });
  cands.sort((a, b) => b.key.length - a.key.length);
  const tokens = t.split(' ');
  for (const c of cands) if (c.key && tokens.indexOf(c.key) > -1) return c.src;
  for (const c of cands) if (c.key && c.key.length > 2 && t.indexOf(c.key) > -1) return c.src;
  const m = t.match(/(?:^|\s)(\d{1,2})(?:\s|$)/);
  if (m && IMPORT_GRADE_NUM[Number(m[1])]) return IMPORT_GRADE_NUM[Number(m[1])];
  return '';
}

function importBranchCanon(txt, known) {
  let raw = String(txt == null ? '' : txt).replace(/\s+/g, ' ').trim();
  if (!raw) return { name: '', matched: false };
  raw = raw.replace(/(^|\s)رشتهٔ?(\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  const t = importKey(raw);
  if (!t) return { name: '', matched: false };
  let best = '', bestD = 999;
  for (const g of (known || [])) {
    const gn = importKey(g);
    if (!gn) continue;
    if (gn === t) return { name: g, matched: true };
    const d = importLev(gn, t);
    if (d < bestD) { bestD = d; best = g; }
  }
  if (best) {
    const gn = importKey(best);
    if (bestD <= 2 || gn.indexOf(t) > -1 || t.indexOf(gn) > -1) return { name: best, matched: true };
  }
  return { name: raw, matched: false };
}

function importStripGrade(name, grade) {
  const gTokens = importKey(grade).split(' ').filter(Boolean);
  const out = [];
  for (const tok of String(name == null ? '' : name).replace(/[()\[\]\-_/\\]/g, ' ').split(/\s+/)) {
    const t = importKey(tok);
    if (!t) continue;
    if (/^\d{1,2}$/.test(t)) continue;
    if (gTokens.some(g => g === t || g.indexOf(t) > -1 || t.indexOf(g) > -1)) continue;
    out.push(String(tok).trim());
  }
  return out.join(' ').trim();
}

/** پایه و رشتهٔ یک ردیف فایل؛ name خالی یعنی پایه پیدا نشد (کلاس ساخته نشود) */
function importPlaceOf(r, ctx) {
  const grades = (ctx && ctx.grades) || [];
  const branches = (ctx && ctx.branches) || [];
  const cname = String(r.new_class || r.class_name || '').replace(/\s+/g, ' ').trim();
  let grade = importGradeCanon(r.new_grade || r.grade || '', grades);
  if (!grade && cname) grade = importGradeCanon(cname, grades);
  let bc = importBranchCanon(r.new_branch || r.branch || r.field || '', branches);
  if (!bc.name && cname) bc = importBranchCanon(importStripGrade(cname, grade), branches);
  const branch = bc.name || '';
  /* پایه == رشته یعنی فایل رشته را در ستون پایه گذاشته است */
  if (grade && branch && importKey(grade) === importKey(branch)) grade = '';
  return { grade, branch, name: grade ? (grade + (branch ? ' ' + branch : '')).trim() : '', bare: !grade && !!branch };
}

function importEnsureLookup(kind, name) {
  const nm = String(name || '').trim();
  if (!nm) return null;
  const all = store.all('lookups');
  const found = all.find(l => String(l.kind) === String(kind) && importKey(l.name) === importKey(nm));
  if (found) return found;
  return store.insert('lookups', {
    kind, name: nm, order: all.filter(l => String(l.kind) === String(kind)).length + 1,
    school_id: 1, created_at: new Date().toISOString(),
  });
}

function importUsers(body) {
  const kind = ['students', 'teachers', 'grades', 'attendance'].indexOf(body && body.kind) > -1
    ? body.kind : 'students';
  const rows = Array.isArray(body && body.rows) ? body.rows : [];
  const created = [];
  const errors = [];
  const warnings = [];
  let updated = 0, parents = 0, classesMade = 0;

  const classIndex = new Map(store.all('classes').map(c => [importKey(c.name), c]));
  /* تعریف‌های پایه/رشته برای تطبیق؛ اشتباه تایپیِ رشته، رشتهٔ تازه نمی‌سازد */
  const lookupAll = store.all('lookups');
  const placeCtx = {
    grades: lookupAll.filter(l => String(l.kind) === 'grade').map(l => l.name),
    branches: lookupAll.filter(l => String(l.kind) === 'branch').map(l => l.name),
  };
  /* کد ملی‌هایی که در همین درخواست ساخته شده‌اند: تکرارشان در فایل خطاست،
     نه به‌روزرسانی (به‌روزرسانی فقط برای رکوردهای قبلیِ پایگاه داده است). */
  const createdNids = new Set();
  const pickFields = (r, out) => {
    for (const k of IMP_STORE_FIELDS) {
      const v = r[k];
      if (v === undefined || v === null || v === '') continue;
      out[k] = v;
    }
    return out;
  };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const rowNo = Number(r._row) || (i + 2);
    try {
      /* ── نمره و حضور: دانش‌آموز باید از قبل باشد ── */
      if (kind === 'grades' || kind === 'attendance') {
        let stu = null;
        const nid = normDigits(r.national_id || '');
        if (nid) stu = store.all('users').find(u => u.role === 'student' && normDigits(u.national_id) === nid) || null;
        if (!stu && r.full_name) {
          const nm = importKey(r.full_name);
          let cands = store.all('users').filter(u => u.role === 'student' && importKey(u.name) === nm);
          if (cands.length > 1 && r.class_name) {
            const cn = importKey(r.class_name);
            const inCls = cands.filter(u => importKey((store.get('classes', u.class_id) || {}).name) === cn);
            if (inCls.length) cands = inCls;
          }
          if (cands.length === 1) stu = cands[0];
          else if (cands.length > 1) { errors.push({ row: rowNo, error: 'student_ambiguous', name: r.full_name }); continue; }
        }
        if (!stu) { errors.push({ row: rowNo, error: 'student_not_found', nid: nid || undefined, name: r.full_name }); continue; }

        if (kind === 'grades') {
          const want = importKey(r.subject_name || r.subject || '');
          const subs = store.all('subjects');
          let subj = subs.find(x => importKey(x.name) === want)
            || (r.subject_id ? store.get('subjects', Number(r.subject_id)) : null);
          if (!subj && want) subj = subs.find(x => importKey(x.name).indexOf(want) > -1 || want.indexOf(importKey(x.name)) > -1);
          if (!subj) { errors.push({ row: rowNo, error: 'subject_not_found', subject: r.subject || r.subject_name }); continue; }
          const score = Number(r.score);
          if (!Number.isFinite(score) || score < 0 || score > 20) { errors.push({ row: rowNo, error: 'bad_score', score: r.score }); continue; }
          store.insert('grades', {
            student_id: stu.id, class_id: stu.class_id || Number(r.class_id) || null,
            subject_id: subj.id, teacher_id: null,
            term: r.term || 'نوبت اول', exam_type: r.exam_type || 'کلاسی',
            score, max_score: 20, date: r.date || null,
            source: 'import', school_id: 1, created_at: nowISO(),
          });
        } else {
          if (!r.date) { errors.push({ row: rowNo, error: 'bad_date', date: r.date }); continue; }
          const st = ['present', 'absent', 'late', 'excused'].indexOf(r.status) > -1 ? r.status : null;
          if (!st) { errors.push({ row: rowNo, error: 'bad_status', status: r.status }); continue; }
          store.insert('attendance', {
            student_id: stu.id, class_id: stu.class_id || Number(r.class_id) || null,
            date: String(r.date).slice(0, 10), status: st, note: r.note || '',
            source: 'import', school_id: 1, created_at: nowISO(),
          });
        }
        created.push({ id: stu.id });
        continue;
      }

      /* ── دانش‌آموز / دبیر ── */
      const name = String(r.full_name || r.name || '').trim();
      if (!name) { errors.push({ row: rowNo, error: 'missing_name' }); continue; }
      const nid = normDigits(r.national_id || '');
      if (nid && !validNationalId(nid)) { errors.push({ row: rowNo, error: 'bad_national_id', nid }); continue; }

      if (nid && createdNids.has(nid)) { errors.push({ row: rowNo, error: 'duplicate_national_id', nid }); continue; }

      /* کد ملیِ موجود ⇒ به‌روزرسانی همان کاربر (قاعدهٔ p2) */
      let existing = null;
      if (nid) existing = store.all('users').find(u => normDigits(u.national_id) === nid) || null;
      if (!existing && Number(r.existing_id)) existing = store.get('users', Number(r.existing_id));
      const wantRole = kind === 'teachers' ? 'teacher' : 'student';
      if (existing && existing.role !== wantRole) {
        errors.push({ row: rowNo, error: 'nid_owner_conflict', nid, name: existing.name });
        continue;
      }

      const phone = normalizeMobile(r.phone || '') || normDigits(r.phone || '');
      if (phone && auth.phoneTaken(store, phone, existing ? existing.id : null)) {
        errors.push({ row: rowNo, error: 'duplicate_phone', phone });
        continue;
      }

      /* کلاس‌ها همیشه دستی توسط مدیر ساخته می‌شوند — ورود اکسل هرگز کلاس
         نمی‌سازد. اکسل فقط پایه و رشته را ثبت می‌کند و اگر کلاسِ دستی با
         همان نام از قبل هست، دانش‌آموز به آن وصل می‌شود. */
      let classId = Number(r.class_id) || (existing ? Number(existing.class_id) || null : null);
      let studentPlace = null;
      if (kind === 'students') {
        const place = importPlaceOf(r, placeCtx);
        studentPlace = place;
        if (place.grade) importEnsureLookup('grade', place.grade);
        if (place.branch) importEnsureLookup('branch', place.branch);
        let cls = null;
        if (place.name) cls = classIndex.get(importKey(place.name)) || null;
        if (!cls && classId && store.get('classes', classId)) cls = store.get('classes', classId);
        /* هیچ کلاسی ساخته نمی‌شود؛ دانش‌آموز بی‌کلاس می‌ماند تا مدیر خودش
           کلاس را بسازد (اتصال خودکار پس از ساختِ دستی انجام می‌شود). */
        classId = cls ? cls.id : null;
        /* رشته بدون پایه: پایه را باید مدیر بگوید (نه اینکه کلاسی ساخته شود) */
        if (!place.grade && place.branch) {
          warnings.push({
            row: rowNo, error: 'class_without_grade', name,
            reason: 'پایه در فایل نبود (رشته: ' + place.branch + ') — پایه را در «مشخصات کامل» مشخص کنید',
            followup_reason: 'پایه در فایل نبود (رشته: ' + place.branch + ')',
          });
        }
      }

      const base = {
        name,
        role: kind === 'teachers' ? (r.role || 'teacher') : 'student',
        national_id: nid || '',
        phone: phone || '',
        class_id: kind === 'students' ? (classId || null) : (classId || null),
        active: true, school_id: 1,
      };
      /* پایه و رشته روی خود دانش‌آموز ثبت می‌شوند (کلاس دستی است) */
      if (kind === 'students' && studentPlace) {
        if (studentPlace.grade) base.grade = studentPlace.grade;
        if (studentPlace.branch) base.field = studentPlace.branch;
      }
      /* دانش‌آموز بی‌کلاس می‌ماند تا در «نیازمند پیگیری» دیده شود؛ پیام
         «کلاس ساخته نمی‌شود» نداریم — فقط نبودِ پایه پیگیری می‌شود. */
      if (kind === 'students' && !classId) {
        base.followup_reason = String(r.followup_reason || '').trim()
          || (studentPlace && studentPlace.bare ? 'پایهٔ کلاس در فایل نبود (رشته: ' + studentPlace.branch + ')' : 'کلاس مشخص نیست');
      }
      pickFields(r, base);
      if (r.birth_date) base.birth_date = String(r.birth_date).slice(0, 10);
      if (r.gender) base.gender = r.gender;

      let saved;
      if (existing) {
        /* فیلدهای خالیِ فایل، مقدار فعلی را پاک نمی‌کنند */
        const patch = {};
        for (const k of Object.keys(base)) {
          const v = base[k];
          if (v === '' || v === null || v === undefined) continue;
          patch[k] = v;
        }
        saved = store.update('users', existing.id, patch);
        updated += 1;
      } else {
        saved = store.insert('users', auth.applyDefaultCredentials(Object.assign({ created_at: nowISO() }, base), store));
        if (nid) createdNids.add(nid);
        created.push(userRow(saved));
      }

      /* ── حساب پدر و مادر و پیوند ولی ── */
      if (kind === 'students') {
        const fName = String(r.father_name || r.parent_name || '').trim();
        const fPhone = normalizeMobile(r.father_phone || r.parent_phone || '');
        const mPhone = normalizeMobile(r.mother_phone || '');
        /* هر ولی فقط شمارهٔ خودش را می‌گیرد (شمارهٔ دانش‌آموز یا شمارهٔ
           ولیِ دیگر به او داده نمی‌شود، وگرنه دو حساب یک نام کاربری
           پیدا می‌کنند). اگر شماره نداشت، نام کاربری‌اش کد ملی می‌شود
           تا بازهم بتواند وارد شود. */
        const pairs = [
          [normDigits(r.father_nid || (fName ? r.parent_nid : '') || ''), fName, 'پدر', fPhone],
          [normDigits(r.mother_nid || ''), String(r.mother_name || '').trim(), 'مادر', mPhone],
        ];
        for (const [pnid, pname, rel, pphone] of pairs) {
          if (!pnid && !pname && !pphone) continue;
          let parent = null;
          /* ۱) همان ولی از قبل با همین کد ملی */
          if (pnid) parent = store.all('users').find(u => u.role === 'parent' && normDigits(u.national_id) === pnid) || null;
          /* ۲) یا با همین شماره — ولی اگر آن حساب کد ملیِ دیگری دارد (مثلاً
             شماره در فایل برای پدر و مادر یکسان نوشته شده)، حسابش را
             به ولیِ دوم نمی‌دهیم؛ برای دومی حساب جدا با کد ملی ساخته می‌شود. */
          if (!parent && pphone) {
            const cand = auth.phoneTaken(store, pphone, null);
            if (cand && cand.role === 'parent'
              && (!pnid || !normDigits(cand.national_id) || normDigits(cand.national_id) === pnid)) parent = cand;
          }
          /* ولیِ بی‌شماره و بی‌کدملی: با نامش شناخته می‌شود تا تکرار نسازیم */
          if (!parent && pname) {
            parent = store.all('users').find(u => u.role === 'parent' && importKey(u.name) === importKey(pname)
              && !normDigits(u.national_id) && !normDigits(u.phone)) || null;
          }
          if (!parent) {
            /* شماره فقط وقتی به حساب می‌نشیند که از قبل مال کسی نباشد */
            const free = pphone && !auth.phoneTaken(store, pphone, null) ? pphone : '';
            parent = store.insert('users', auth.applyDefaultCredentials({
              name: pname || (rel + ' ' + name), role: 'parent',
              national_id: pnid || '', phone: free,
              active: true, school_id: 1, created_at: nowISO(),
            }, store));
            parents += 1;
            /* نه شماره، نه کد ملی ۱۰ رقمی → راه ورودی ندارد؛ گزارش می‌شود */
            if (!free && !(pnid && pnid.length === 10)) {
              warnings.push({ row: rowNo, error: 'parent_without_login', name: parent.name });
            }
            parent = store.get('users', parent.id) || parent;
          }
          if (!parent) continue;   /* شمارهٔ ولی به کاربر دیگری تعلق داشت */
          const linked = store.all('parent_links').some(l => Number(l.parent_id) === Number(parent.id) && Number(l.student_id) === Number(saved.id));
          if (!linked) store.insert('parent_links', { parent_id: parent.id, student_id: saved.id, relation: rel, school_id: 1, created_at: nowISO() });
        }
      }
    } catch (e) {
      errors.push({ row: rowNo, error: 'write_failed', detail: String((e && e.message) || e).slice(0, 120) });
    }
  }

  store.audit({ role: 'manager', action: 'import_' + kind, collection: 'users', after: { created: created.length, updated, parents, classes: classesMade } });
  return { ok: true, kind, created: created.length, updated, parents, classes: classesMade, errors, warnings, users: created };
}

/* ردیف ۲۸/۵۷: هر میدانی که هش/رمز/راز است از خروجی حذف می‌شود.
   فهرست از policy می‌آید تا مسیر export هم دقیقاً مثل pull بسته باشد —
   password_enc (رمز پلمپ‌شدهٔ قابل‌بازخوانی) هم شامل می‌شود. */
const EXPORT_DENY = policy.SECRET_FIELD_RE;
/* FIX-SEC01b: لایهٔ دفاعی صریح و ثابت در مرز خروجی (علاوه بر allowlist policy):
   رمز/هش/توکن برای همه نقش‌ها حذف می‌شود (حتی اگر policy روزی عریان شود).
   فهرست صریح رمزها (password_hash|password_plain|password_enc و سایر رازها) —
   مرز دوم، مستقل از policy. */
const EXPORT_SECRET_DENY = /^(password_hash|password_plain|password_enc|pin_hash|phone_hash|__password_verifier|token|secret|accessKey)/;
/* فیلدهای شناسنامه‌ای (national_id و زیرگروه‌ها) فقط برای غیرمدیر حذف می‌شوند. */
const EXPORT_IDENTITY_DENY = /^(national_id|father_nid|mother_nid|shenasname_serial|shenasname_seri)/;
function exportRow(row, role) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (k.startsWith('_') || EXPORT_DENY.test(k) || EXPORT_SECRET_DENY.test(k)) continue;
    if (role !== 'manager' && EXPORT_IDENTITY_DENY.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function toCSV(rows) {
  if (!rows.length) return '\uFEFF';
  const keys = [...new Set(rows.flatMap(r => Object.keys(r).filter(k => !k.startsWith('_'))))];
  const esc = v => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s;          /* ضد تزریق فرمول */
    return '"' + s.replace(/"/g, '""') + '"';
  };
  return '\uFEFF' + [keys.join(','), ...rows.map(r => keys.map(k => esc(r[k])).join(','))].join('\n');
}

/* ── سرور ─────────────────────────────────────────────────────────── */
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const ip = cfg.clientIp(req);
  /* row 85: every response carries X-Request-Id (honoured if opaque, else minted) */
  const rid = logger.requestId(req.headers);
  res.setHeader('x-request-id', rid);
  let url;
  try { url = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
  catch (e) { res.writeHead(400).end(); return; }

  /* سرآیندهای امنیتی پایه */
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'geolocation=(), microphone=(), camera=()');
  /* ردیف ۲۸ — سرآیندهای پایه: جلوگیری از حدس نوع محتوا و قاب‌گرفتن صفحه */
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'SAMEORIGIN');

  /* ── اجازهٔ دسترسی برنامه‌های دیگر (CORS) ────────────────────────────
     نسخهٔ اندروید فایل‌هایش را از مبدأ محلی باز می‌کند
     (https://appassets.androidplatform.net) و برای حرف زدن با سیستم مدرسه
     به این سرآیندها نیاز دارد. بدون آن، مرورگر پاسخ را دور می‌ریزد و
     کاربر فقط «به سیستم نرسیدیم» می‌بیند. */
  const origin = String(req.headers.origin || '');
  res.setHeader('access-control-allow-origin', origin || '*');
  res.setHeader('vary', 'Origin');
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization, content-type, accept, x-requested-with, x-payesh-device, x-request-id');
  res.setHeader('access-control-expose-headers', 'content-length, etag, x-request-id');
  res.setHeader('access-control-max-age', '86400');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  /* شمارش واقعی هر پاسخ (کلاس ۲xx..۵xx) برای نرخ خطا — ردیف ۴۹.
     بعد از پایان پاسخ ثبت می‌شود تا کد وضعیت نهایی همان چیزی باشد که
     کلاینت دید، نه آنچه در میانهٔ مسیر ساخته شده بود. */
  res.on('finish', () => { try { mreg.observeHttp(res.statusCode, Date.now(), Date.now() - started); } catch (e) { /* noop */ } });

  try {
    /* ── ردیف ۴۹: متریک و پروب‌های هم‌نام با Gateway ──────────────────
       /healthz = زنده‌بودن فرایند (بدون وابستگی) · /readyz = آمادگی واقعی
       (/api/readyz هم برای سازگاری می‌ماند) · /metrics = scrape استاندارد. */
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, instance: 'payesh-local', version: RUNNING_VERSION, uptime_s: Math.round(process.uptime()) }));
      return;
    }
    if (url.pathname === '/readyz') {
      const { checks, ready } = readinessChecks();
      res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: ready, ready, version: RUNNING_VERSION, uptime_s: Math.round(process.uptime()), checks }));
      return;
    }
    if (url.pathname === '/metrics' || url.pathname === '/api/metrics') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed\n');
        return;
      }
      if (!metricsAllowed(req, url)) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('unauthorized\n');
        return;
      }
      const body = await mreg.render();
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? '' : body);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      /* row 64: native API version policy (web clients send no X-Payesh-Client → untouched) */
      const verdict = apiVersion.check(url.pathname, req.headers);
      if (verdict) {
        res.writeHead(verdict.status, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, verdict.headers));
        res.end(JSON.stringify(verdict.body));
        return;
      }
      if (req.headers['x-payesh-client']) {
        for (const [k, v] of Object.entries(apiVersion.responseHeaders())) res.setHeader(k, v);
      }
      const out = await api(req, res, url, ip);
      if (out && !res.writableEnded) {
        const body = out.body !== undefined ? out.body : JSON.stringify(out);
        const headers = Object.assign({ 'content-type': 'application/json; charset=utf-8' }, out.headers || {});
        if (out.body === undefined && !headers['content-type']) headers['content-type'] = 'application/json; charset=utf-8';
        res.writeHead(out.status || 200, headers);
        res.end(body);
      }
      return;
    }

    /* دانلودها (نصب‌کننده‌ها و APK) */
    if (url.pathname.startsWith('/downloads/')) {
      const rel = url.pathname.replace('/downloads/', '');
      const file = safeJoin(RELEASES_DIR, rel);
      if (file && sendFile(req, res, file, { download: false })) return;
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }

    /* صفحهٔ نصب */
    if (url.pathname === '/install') {
      if (sendFile(req, res, path.join(CLIENT_DIR, 'install.html'))) return;
    }

    /* لینک کارت پیوند: /join/ABCD-EFGH */
    if (url.pathname.startsWith('/join/')) {
      if (sendFile(req, res, path.join(CLIENT_DIR, 'index.html'), { noStore: true })) return;
    }

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    /* لایهٔ نوشتنی: فایل‌هایی که «به‌روزرسانی» جای داده (وقتی پوشهٔ نصب فقط خواندنی است) */
    const over = safeJoin(OVERLAY_DIR, rel);
    if (over && fs.existsSync(over) && sendFile(req, res, over, { noStore: /\.(html|js|webmanifest)$/.test(rel) })) return;
    const file = safeJoin(CLIENT_DIR, rel);
    if (file && sendFile(req, res, file, { noStore: /\.(html|js|webmanifest)$/.test(rel) })) return;

    /* SPA fallback */
    if (sendFile(req, res, path.join(CLIENT_DIR, 'index.html'), { noStore: true })) return;
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  } catch (e) {
    const msg = String(e.message || e);
    const code = msg === 'body_too_large' ? 413 : (msg === 'bad_json' ? 400 : 500);
    /* row 85: error log is JSON too; the message is redacted, the stack and
       the request body are never written (they can carry user data) */
    if (code === 500) logger.error('http_error', { request_id: rid, path: url.pathname, error: 'server_error', detail: msg, component: 'router' });
    const errName = code === 413 ? 'body_too_large' : (code === 400 ? 'bad_json' : 'server_error');
    if (!res.writableEnded) res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    if (!res.writableEnded) res.end(JSON.stringify({ ok: false, error: errName }));
  } finally {
    if (process.env.PAYESH_LOG !== '0') {
      const ms = Date.now() - started;
      if (ms > 300 || url.pathname.startsWith('/api/')) {
        const who = req.__payeshLog || {};
        logger.info('http', {
          request_id: rid, school_id: who.school_id != null ? who.school_id : null, auth: !!req.__payeshLog,
          role: who.role || null, method: req.method, path: url.pathname, status: res.statusCode, ms,
        });
      }
    }
  }
});

/* پاک‌سازی دوره‌ای + بکاپ خودکار */
setInterval(() => { try { auth.prune(store); } catch (e) { /* noop */ } }, 60 * 60 * 1000).unref();
if (process.env.PAYESH_AUTO_BACKUP !== '0') {
  setInterval(() => {
    try { store.backupTo(BACKUP_DIR, 48); } catch (e) { logger.error('backup_failed', { component: 'backup', detail: e.message }); }
  }, 60 * 60 * 1000).unref();
  try { store.backupTo(BACKUP_DIR, 48); } catch (e) { /* noop */ }
}

/* ── آینهٔ داده + پشتیبان روزانه ─────────────────────────────────────
   هر دقیقه داده‌ها روی دیسک آینه می‌شوند (اگر عوض شده باشند) و همان
   لحظه با دیتابیس مقایسه می‌شوند؛ فایل روزانه هم تازه می‌شود. */
let mirrorBusy = false;
async function mirrorTick() {
  if (mirrorBusy) return;
  mirrorBusy = true;
  try {
    const r = mirror.refreshMirror(store, MIRROR_DIR);
    mirror.refreshDaily(store, DAILY_BACKUP_DIR);
    if (r.changed) store.setMeta('mirror_status', { at: nowISO(), ok: true, total: r.total, counts: r.counts });
  } catch (e) {
    store.setMeta('mirror_status', { at: nowISO(), ok: false, error: String(e.message || e) });
  } finally {
    mirrorBusy = false;
  }
}
if (process.env.PAYESH_MIRROR !== '0') {
  const mirrorMs = Math.max(1000, Number(process.env.PAYESH_MIRROR_MS || 60 * 1000));
  setInterval(() => { mirrorTick(); }, mirrorMs).unref();
  setTimeout(() => { mirrorTick(); }, 1500).unref();
}

/* ── آدرس موقتیِ نسخه‌های قدیمی: در شروع پاک می‌شود ── */
try {
  const purged = tunnel.purgeStalePublicUrl(store);
  if (purged.cleared) console.log('[network] آدرس موقت قدیمی پاک شد:', purged.url);
} catch (e) { /* بی‌خیال */ }

/* ── رمز گوشی: هیچ حسابی نباید «رمزِ گوشی ندارد» بماند ──
   • هر رمز PBKDF2 که هست، همان برای گوشی هم گذاشته می‌شود (همان رمز).
   • حسابی که هیچ رمزی ندارد و کد ملی دارد، رمزش کد ملی می‌شود.
   • رمزهای قدیمی scrypt فقط روی سیستم مدرسه کار می‌کنند؛ گوشی برای آن‌ها
     رمز نمی‌گیرد و مدیر از «ویرایش» رمز تازه می‌گذارد. */
try {
  const users = store.all('users') || [];
  let fixed = 0;
  for (const u of users) {
    const pwIsPbkdf2 = /^pbkdf2\$/.test(String(u.password_hash || ''));
    const phIsPbkdf2 = /^pbkdf2\$/.test(String(u.phone_hash || ''));
    const patch = {};
    if (pwIsPbkdf2 && !phIsPbkdf2) patch.phone_hash = u.password_hash;
    else if (!u.password_hash && !u.phone_hash) {
      const next = auth.applyDefaultCredentials(u, store);
      if (next.password_hash) { patch.password_hash = next.password_hash; patch.phone_hash = next.password_hash; }
    }
    if (Object.keys(patch).length) { store.update('users', u.id, patch); fixed++; }
  }
  if (fixed) console.log('[auth] رمز گوشی برای ' + fixed + ' حساب تنظیم شد');
} catch (e) {
  logger.warn('phone_password_check_failed', { component: 'auth', detail: e.message });
}

/* ── صندوقچهٔ پیش‌فرض: در شروع نام صندوقچه را پیدا می‌کنیم و اجازهٔ CORS را
      هم خودکار می‌گذاریم — گوشی‌ها بدون هیچ کاری می‌توانند بخوانند/بنویسند. ── */
if (process.env.PAYESH_CLOUD_AUTO !== '0') {
  setTimeout(() => {
    s3mem.ensureBucket(store)
      .then(async c => {
        if (!c.bucket) return;
        console.log('[cloud] صندوقچه:', c.bucket, '·', c.endpoint);
        try {
          let probe = await s3mem.corsProbe(c);
          if (!probe.ok && probe.reachable) {
            await s3mem.setCors(c);
            probe = await s3mem.corsProbe(c);
            console.log('[cloud] اجازهٔ CORS خودکار تنظیم شد — ' + (probe.ok ? 'گوشی می‌تواند بخواند ✅' : 'هنوز نه ❌'));
          } else if (probe.ok) {
            console.log('[cloud] اجازهٔ گوشی از قبل باز است ✅');
          } else {
            console.log('[cloud] به صندوقچه نرسیدیم:', probe.detail || probe.error || '');
          }
        } catch (e) {
          console.log('[cloud] تنظیم CORS ناموفق:', e.message);
        }
      })
      .catch(e => console.log('[cloud] تشخیص صندوقچه ناموفق:', e.message));
  }, 2500).unref();
}

/* ── صندوقچهٔ آفلاین: اولین دستگاهی که روشن شود، ثبت‌های بقیه را اعمال می‌کند ── */
if (process.env.PAYESH_OUTBOX_AUTO !== '0') {
  outbox.start(store, { everyMs: Number(process.env.PAYESH_OUTBOX_EVERY_MS || 3 * 60_000) });
}

/* ── راه‌اندازی مجدد خودکار پس از آپدیت ───────────────────────────── */
function autoRestartEnabled() { return process.env.PAYESH_NO_RESTART !== '1'; }
let restarting = false;
function closeServerForRestart() {
  /* تایمر به‌روزرسانی را اول متوقف کنیم: وگرنه ممکن است در پنجرهٔ بین
     close() و خروج فرآیند شلیک کند و با «database is not open» بیندازد. */
  try { update.stop(); } catch (e) { /* noop */ }
  try { server.close(); } catch (e) { /* noop */ }
  try { if (server.closeAllConnections) server.closeAllConnections(); } catch (e) { /* noop */ }
  try { store.close(); } catch (e) { /* noop */ }
}

function scheduleRestart(reason) {
  if (restarting || !autoRestartEnabled()) return;
  restarting = true;
  console.log('[update] راه‌اندازی مجدد (' + reason + ')…');
  setTimeout(() => {
    closeServerForRestart();
    /* اگر «ناظر» (server/start.js) بالای سرِ ماست، خودش دوباره بالا می‌آورد.
       وگرنه خودمان یک نمونهٔ تازه اجرا می‌کنیم. */
    if (process.env.PAYESH_SUPERVISED === '1') {
      setTimeout(() => process.exit(75), 120);
      return;
    }
    setTimeout(() => {
      try {
        const { spawn } = require('child_process');
        const entry = require('path').resolve(process.argv[1] || 'server/index.js');
        const child = spawn(process.execPath, [entry].concat(process.argv.slice(2)), {
          cwd: process.cwd(), env: process.env, stdio: 'inherit', detached: true,
        });
        child.on('error', err => logger.error('restart_failed', { component: 'update', detail: err.message }));
        child.unref();
      } catch (e) {
        logger.error('restart_failed', { component: 'update', detail: e.message });
      }
      setTimeout(() => process.exit(0), 250);
    }, 600);
  }, 120);
}

function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

let listenTries = 0;
server.on('error', err => {
  if (err && err.code === 'EADDRINUSE' && listenTries < 12) {
    listenTries++;
    console.log('[server] درگاه ' + PORT + ' هنوز آزاد نشده — تلاش ' + listenTries);
    setTimeout(() => server.listen(PORT, HOST), 500);
    return;
  }
  logger.error('server_error', { component: 'server', detail: err && err.message });
});

server.listen(PORT, HOST, () => {
  const ips = lanAddresses();
  const mf = readManifest();
  console.log('');
  console.log('  پایش-لوکال  ·  نسخهٔ ' + mf.version);
  console.log('  ─────────────────────────────────────────');
  console.log('  آدرس روی همین سیستم : http://localhost:' + PORT);
  ips.forEach(ip => console.log('  آدرس در شبکهٔ مدرسه : http://' + ip + ':' + PORT));
  console.log('  داده               : ' + path.join(DATA_DIR, 'payesh.sqlite'));
  console.log('  بکاپ               : ' + BACKUP_DIR);
  console.log('  راه‌اندازی         : ' + (auth.needsSetup(store) ? 'انجام نشده — از مرورگر اول را انجام دهید' : 'انجام شده'));
  const pub = cfg.publicUrl(store);
  console.log('  آدرس عمومی (همه)   : ' + (pub || 'تنظیم نشده — پنل مدیر ← شبکه'));
  console.log('');
  /* تونل عمومی: اگر Tailscale Funnel روشن باشد، آدرس را برمی‌داریم */
  try { tunnel.start(store, { port: PORT }); } catch (e) { logger.error('start_failed', { component: 'tunnel', detail: e.message }); }

  /* همگام‌سازی زنده: هر ۱ ثانیه — تغییرها به حافظهٔ مشترک می‌روند و
     تغییرهای گوشی‌ها همان‌جا برداشته می‌شوند. */
  try { live.start(store, { everyMs: Number(process.env.PAYESH_LIVE_MS || live.INTERVAL_MS) }); } catch (e) { logger.error('start_failed', { component: 'live', detail: e.message }); }

  /* بررسی خودکار نسخهٔ منتشرشده (اگر «نصب خودکار» روشن باشد، خودش اعمال می‌کند) */
  try {
    update.start(store, {
      onApply: async (plan) => {
        const r = await update.apply(store, { force: false, by: 'auto' });
        if (r.ok && r.applied && r.restart) scheduleRestart('auto');
        return r;
      },
    });
  } catch (e) { logger.error('start_failed', { component: 'update', detail: e.message }); }
});

process.on('SIGINT', () => { try { update.stop(); } catch (e) { /* noop */ } store.close(); process.exit(0); });
process.on('SIGTERM', () => { try { update.stop(); } catch (e) { /* noop */ } store.close(); process.exit(0); });
