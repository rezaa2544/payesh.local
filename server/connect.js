'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۱۷۰ — اتصال خودکار سرور مدرسه به دیتابیس، بی‌وارد کردن هیچ نشانی یا کلیدی.

   مالک در پنل مالک مدرسه را با نام کاربری و رمز مدیر می‌سازد. پنل همان لحظه یک «بستهٔ اتصال»
   منتشر می‌کند: محتوای همان فرمان cloud-control (آدرس، صندوقچه، کلیدها) که با کلیدی از
   «نام کاربری + رمز مدیر» مهر شده است:

     <base>connect/s-<۳۲ نویسهٔ اول sha256("payesh/connect/school/<login>")>.json
     secret = hex(PBKDF2-HMAC-SHA256(password, "payesh/connect/school/<login>", 120000, 32))
     پاکت  = HKDF-SHA256(secret, salt "payesh/connect", info "v1") + AES-256-GCM،
             AAD = "payesh-connect/v1/<rev>"

   پس فایل عمومی است ولی فقط کسی که نام کاربری و رمز مدیر را دارد بازش می‌کند؛ کلید
   دیتابیس در هیچ کد و باندلی نیست (D‑23 بی‌تغییر). بستهٔ مالک (o-…) با شناسه + رمز + کد
   پنل مالک مهر می‌شود و پنل مالک تازه‌نصب با همان سه مقدار وصل می‌شود.

   جای فایل‌ها (به ترتیب): https://payeshschool.ir/payesh/pub/ ، سپس نشانی پختهٔ صندوقچه.
   connect.json هر پایه می‌تواند «base» تازه‌تری بدهد (تا عمق ۲) — یعنی جابه‌جایی دیتابیس بی‌به‌روزرسانی
   برنامه‌ها. سرور می‌تواند فهرست را با PAYESH_CONNECT_URLS (جداشده با فاصله یا ویرگول) عوض کند.

   همتای Dart: apps/payesh/owner/lib/src/local/connect_bundle.dart
   بردار آزمون: docs/cloud/contracts/connect-vectors.json · آزمون: tests/connect-170.js
   ═══════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const s3mem = require('./s3mem');
const control = require('./cloud-control');
const { trustFetch } = require('./s3-https');

const KIND = 'payesh-connect';
const SALT = Buffer.from('payesh/connect', 'utf8');
const INFO = Buffer.from('v1', 'utf8');
const ITER = 120000;
const DEFAULT_BASES = [
  'https://payeshschool.ir/payesh/pub/',
  'https://s3.ir-central1.arvanstorage.ir/payesh-madrese/payesh/pub/',
];

class ConnectError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/* نام کاربری یکدست: فاصله‌ها حذف، حروف کوچک، رقم فارسی/عربی ⇒ لاتین */
function normLogin(login) {
  return String(login == null ? '' : login).trim().toLowerCase()
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

const kindOk = (kind) => kind === 'school' || kind === 'owner';
const saltOf = (kind, login) => 'payesh/connect/' + kind + '/' + normLogin(login);

/* مسیر نسبی بسته زیر پایه */
function bundlePath(kind, login) {
  if (!kindOk(kind)) throw new ConnectError('bad_kind');
  const h = crypto.createHash('sha256').update(saltOf(kind, login), 'utf8').digest('hex').slice(0, 32);
  return 'connect/' + (kind === 'school' ? 's' : 'o') + '-' + h + '.json';
}

/* رمز بسته؛ مالک: password + "\u0000" + code */
function deriveSecret(kind, login, password, code) {
  if (!kindOk(kind)) throw new ConnectError('bad_kind');
  const pw = kind === 'owner' ? String(password || '') + '\u0000' + String(code || '').trim() : String(password || '');
  return crypto.pbkdf2Sync(Buffer.from(pw, 'utf8'), Buffer.from(saltOf(kind, login), 'utf8'), ITER, 32, 'sha256').toString('hex');
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
function unb64u(s, len) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) throw new ConnectError('bad_format');
  const b = Buffer.from(s, 'base64url');
  if (b64u(b) !== s || (len != null && b.length !== len)) throw new ConnectError('bad_format');
  return b;
}
const keyOf = (secret) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(String(secret), 'utf8'), SALT, INFO, 32));
const aadOf = (rev) => Buffer.from(KIND + '/v1/' + rev, 'utf8');

function sealText(secret, rev, plainText, nonce) {
  const n = nonce ? Buffer.from(nonce) : crypto.randomBytes(12);
  if (n.length !== 12) throw new ConnectError('bad_nonce');
  const c = crypto.createCipheriv('aes-256-gcm', keyOf(secret), n);
  c.setAAD(aadOf(rev));
  const ct = Buffer.concat([c.update(Buffer.from(plainText, 'utf8')), c.final(), c.getAuthTag()]);
  return { v: 1, kind: KIND, rev, alg: 'HKDF-SHA256/A256GCM', nonce: b64u(n), ct: b64u(ct) };
}

function openText(secret, env) {
  if (!env || typeof env !== 'object' || env.v !== 1 || env.kind !== KIND || env.alg !== 'HKDF-SHA256/A256GCM') {
    throw new ConnectError('bad_format');
  }
  const rev = env.rev;
  if (!Number.isSafeInteger(rev) || rev <= 0) throw new ConnectError('bad_format');
  const n = unb64u(env.nonce, 12);
  const ct = unb64u(env.ct);
  if (ct.length < 17) throw new ConnectError('bad_format');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', keyOf(secret), n);
    d.setAAD(aadOf(rev));
    d.setAuthTag(ct.subarray(ct.length - 16));
    return { rev, text: Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString('utf8') };
  } catch (e) {
    throw new ConnectError('open_failed');
  }
}

function basesFrom(env) {
  const raw = String((env || process.env).PAYESH_CONNECT_URLS || '').trim();
  const list = raw ? raw.split(/[\s,]+/) : DEFAULT_BASES;
  return list.filter(u => /^https:\/\/[^\s]+\/$/.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/[^\s]*\/$/.test(u));
}

async function getJson(fetcher, url) {
  /* سقف سخت هر درخواست (DNS + اتصال + پاسخ): دامنهٔ هنوز راه‌نیفتاده نباید ورود را نگه دارد */
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_MS);
  try {
    const r = await Promise.race([
      fetcher(url, { method: 'GET', headers: { 'cache-control': 'no-cache' }, timeoutMs: FETCH_MS, maxBody: 256 * 1024, signal: ac.signal }),
      new Promise((_, rej) => ac.signal.addEventListener('abort', () => rej(new Error('timeout')), { once: true })),
    ]);
    if (!r || r.status !== 200) return { status: r ? r.status : 0 };
    const text = typeof r.text === 'function' ? await r.text() : String(r.body || '');
    return { status: 200, json: JSON.parse(text) };
  } catch (e) {
    return { status: 0 };
  } finally {
    clearTimeout(t);
  }
}

/* بسته را از پایه‌ها می‌خواند (با دنبال کردن «base» در connect.json، تا عمق ۲).
   خروجی: { env, base } یا { error: 'not_found' | 'unreachable' } */
async function fetchBundle(kind, login, { fetcher = trustFetch, env, bases } = {}) {
  const rel = bundlePath(kind, login);
  const seen = new Set();
  let reached = false;
  const tryBase = async (base, depth) => {
    if (seen.has(base)) return null;
    seen.add(base);
    const b = await getJson(fetcher, base + rel);
    if (b.status === 200 || b.status === 404 || b.status === 403) reached = true;
    if (b.status === 200 && b.json && b.json.kind === KIND) return { env: b.json, base };
    if (depth < 2) {
      const idx = await getJson(fetcher, base + 'connect.json');
      if (idx.status === 200) reached = true;
      const next = idx.json && typeof idx.json.base === 'string' ? idx.json.base : '';
      if (next && next !== base && basesFrom({ PAYESH_CONNECT_URLS: next }).length) return tryBase(next, depth + 1);
    }
    return null;
  };
  for (const base of bases || basesFrom(env)) {
    const r = await tryBase(base, 0);
    if (r) return r;
  }
  return { error: reached ? 'not_found' : 'unreachable' };
}

/* همان deriveSecret بی‌قفل کردن حلقهٔ رویداد (PBKDF2 کند است) */
function deriveSecretAsync(kind, login, password, code) {
  if (!kindOk(kind)) return Promise.reject(new ConnectError('bad_kind'));
  const pw = kind === 'owner' ? String(password || '') + '\u0000' + String(code || '').trim() : String(password || '');
  return new Promise((resolve, reject) => crypto.pbkdf2(Buffer.from(pw, 'utf8'), Buffer.from(saltOf(kind, login), 'utf8'), ITER, 32, 'sha256',
    (err, key) => (err ? reject(err) : resolve(key.toString('hex')))));
}

/* «بسته‌ای نیست / دیتابیس در دسترس نیست» تا ۵ دقیقه دوباره پرسیده نمی‌شود — ورودهای بعدی
   روی سرورِ عمداً بی‌دیتابیس منتظر شبکه نمی‌مانند. */
const MISS_MS = 5 * 60_000;
let misses = new Map();

/* ورود مدیر روی سرور مدرسهٔ وصل‌نشده ⇒ بسته را باز و سرور را به همان دیتابیس وصل می‌کند.
   خروجی state: already_connected | not_found | unreachable | bad_credentials | invalid | ok */
const FETCH_MS = 8000;
/* ورود حداکثر این‌قدر منتظر اتصال می‌ماند؛ بعد کار در پس‌زمینه تمام می‌شود و ورودهای بعدی
   سرورِ وصل‌شده را می‌بینند (یک کار در جریان به ازای هر نام کاربری). */
const LOGIN_WAIT_MS = 2500;
let inflight = new Map();

function bootstrapFromLogin(store, login, password, opts = {}) {
  if (s3mem.saved(store)) return Promise.resolve({ state: 'already_connected' });
  const key = bundlePath('school', login) + '\u0000' + crypto.createHash('sha256').update(String(password || '')).digest('hex');
  let work = inflight.get(key);
  if (!work) {
    work = bootstrapNow(store, login, password, opts).finally(() => inflight.delete(key));
    inflight.set(key, work);
  }
  const wait = opts.waitMs == null ? LOGIN_WAIT_MS : opts.waitMs;
  if (!(wait > 0)) return work;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve({ state: 'pending' }), wait);
    work.then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function bootstrapNow(store, login, password, { fetcher, env, bases } = {}) {
  if (s3mem.saved(store)) return { state: 'already_connected' };
  if (!normLogin(login) || !password) return { state: 'bad_credentials' };
  const rel = bundlePath('school', login);
  const miss = misses.get(rel);
  if (miss && Date.now() - miss.at < MISS_MS) return { state: miss.state, cached: true };
  const f = await fetchBundle('school', login, { fetcher, env, bases });
  if (!f.env) {
    misses.set(rel, { state: f.error, at: Date.now() });
    if (misses.size > 500) misses = new Map();
    return { state: f.error };
  }
  misses.delete(rel);
  let opened;
  try {
    opened = openText(await deriveSecretAsync('school', login, password), f.env);
  } catch (e) {
    return { state: e.code === 'open_failed' ? 'bad_credentials' : 'invalid' };
  }
  let cfg;
  try {
    const plain = JSON.parse(opened.text);
    if (!plain || plain.rev !== opened.rev) throw new Error('rev');
    cfg = control.validConfig(plain);
  } catch (e) {
    return { state: 'invalid' };
  }
  s3mem.usingMeta(store).set(Object.assign({}, s3mem.normalize(cfg), { source: 'owner' }));
  try { store.setMeta('cloud:control_rev', String(opened.rev)); } catch (e) { /* اختیاری */ }
  try { store.audit({ role: 'system', action: 'cloud_connect_bundle', collection: 'meta' }); } catch (e) { /* اختیاری */ }
  return { state: 'ok', bucket: cfg.bucket, base: f.base };
}

module.exports = {
  KIND, ITER, DEFAULT_BASES, ConnectError, normLogin, bundlePath, deriveSecret, sealText, openText,
  basesFrom, fetchBundle, bootstrapFromLogin, deriveSecretAsync,
  _reset() { misses = new Map(); inflight = new Map(); },
};
