'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۱۶۰ — روش‌های ورود و زیرساخت پیامک (کد یک‌بارمصرف)
   ───────────────────────────────────────────────────────────────────
   خواستهٔ مالک (۱۴۰۵/۰۸/۲۴):
     • ورود اول: نام کاربری + رمز عبوری که مدیر مدرسه تعیین می‌کند (پیش‌فرض:
       شمارهٔ همراه / کد ملی) — server/auth.js؛
     • ورود دوم: شمارهٔ همراه + کد پیامکی، و «فراموشی رمز» با همان پیامک؛
     • برای کل سامانه یک پنل پیامک: مالک «پیوند» سرویس‌دهنده را در تنظیمات پنل
       مدیریت خودش می‌گذارد و همهٔ سرورهای مدرسه به آن وصل می‌شوند؛
     • مالک انتخاب می‌کند صفحهٔ اول ورود کدام روش را نشان دهد (و روش دیگر زیرش).

   تنظیمات از کجا می‌آید: همان فهرست مدارس مهرشدهٔ پنل مالک در صندوقچه
   (server/school-registry.js، کلید جدای plain.auth تا ذخیرهٔ «پلن‌ها» آن را پاک نکند):
     plain.auth = {
       primary: 'password' | 'mobile',
       sms: { enabled, url, method: 'GET'|'POST', headers: "Name: value\n…",
              body, message, code_length: 4..8, ok_match }
     }
   جای‌نگهدارها در url / body / headers / message:
     {mobile} 09xxxxxxxxx · {mobile98} 989xxxxxxxxx · {code} · {message} · {minutes} · {school}
   تا وقتی پیوند پنل خالی یا خاموش است همه‌چیز «غیرفعال» است (sms_disabled) و برنامه‌ها
   همان روش نام کاربری/رمز را اول نشان می‌دهند — هیچ کاربری پشت پیامکِ نرسیده قفل نمی‌شود.

   ایمنی کد یک‌بارمصرف:
     • کد با crypto.randomInt ساخته می‌شود و فقط درهم‌سازی‌شدهٔ نمک‌دار (SHA-256) در meta
       می‌ماند — متن کد هیچ‌جا ذخیره یا لاگ نمی‌شود؛
     • عمر ۱۲۰ ثانیه، ۵ تلاش، یک‌بارمصرف؛ فاصلهٔ ارسال دوباره ۶۰ ثانیه؛ سقف ۵ پیامک در ساعت
       و ۱۰ در روز برای هر شماره (ماندگار در پایگاه داده، نه فقط حافظه)؛
     • پاسخ «درخواست کد» برای شمارهٔ ناشناس همان پاسخ شمارهٔ ثبت‌شده است (شمارش کاربران
       از بیرون ممکن نیست) و سقف‌ها برای آن هم شمرده می‌شود.
   ═══════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const { normalizeMobile } = require('./util');

const PRIMARY = ['password', 'mobile'];
const PURPOSES = ['login', 'reset'];
const DEFAULT_MESSAGE = 'پایش — کد ورود شما: {code}\nاین کد {minutes} دقیقه اعتبار دارد؛ آن را به کسی ندهید.';
const LIMITS = Object.freeze({
  ttlMs: 120_000,
  resendMs: 60_000,
  maxAttempts: 5,
  perHour: 5,
  perDay: 10,
});
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const HEADER_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

/* ── تنظیمات ─────────────────────────────────────────────────────── */
function safeUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  try {
    const x = new URL(s.replace(/\{[a-z0-9_]+\}/g, 'x'));
    return (x.protocol === 'https:' || x.protocol === 'http:') && x.hostname ? s.slice(0, 1000) : '';
  } catch (e) { return ''; }
}

function parseHeaders(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (!HEADER_RE.test(name) || /[\r\n]/.test(value)) continue;
    out.push([name, value.slice(0, 500)]);
    if (out.length >= 10) break;
  }
  return out;
}

/* همان قاعدهٔ AuthSettings.of در پنل مالک (Dart) — بردار مشترک docs/cloud/contracts/auth-vectors.json */
function settingsOf(plain) {
  const a = plain && plain.auth && typeof plain.auth === 'object' ? plain.auth : {};
  const s = a.sms && typeof a.sms === 'object' ? a.sms : {};
  const len = Number(s.code_length);
  const method = String(s.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  const url = safeUrl(s.url);
  const sms = {
    enabled: s.enabled === true,
    url,
    method,
    headers: parseHeaders(s.headers),
    body: method === 'POST' ? String(s.body || '').slice(0, 2000) : '',
    message: String(s.message || '').trim().slice(0, 300) || DEFAULT_MESSAGE,
    code_length: Number.isInteger(len) && len >= 4 && len <= 8 ? len : 6,
    ok_match: String(s.ok_match || '').slice(0, 100),
  };
  return {
    primary: PRIMARY.includes(a.primary) ? a.primary : 'password',
    sms,
    sms_ready: sms.enabled && !!sms.url,
  };
}

/* فقط برای آزمون/توسعه: PAYESH_SMS_CONSOLE=1 ⇒ پیامک به‌جای ارسال در لاگ سرور نوشته می‌شود */
function consoleMode() { return process.env.PAYESH_SMS_CONSOLE === '1'; }

function current(store) {
  let plain = null;
  try {
    const r = store.getMeta('schools:registry', null);
    plain = r && r.plain ? r.plain : null;
  } catch (e) { plain = null; }
  const st = settingsOf(plain);
  if (!st.sms_ready && consoleMode()) {
    st.sms = Object.assign({}, st.sms, { enabled: true, url: 'console:', console: true });
    st.sms_ready = true;
  }
  return st;
}

/* آنچه هر برنامه (بی‌نشست) می‌بیند — /api/health و /api/auth/methods */
function publicInfo(store) {
  const st = current(store);
  return {
    /* تا پنل پیامک وصل نشده، صفحهٔ اول همیشه نام کاربری/رمز است (کسی قفل نمی‌شود) */
    primary: st.primary === 'mobile' && st.sms_ready ? 'mobile' : 'password',
    requested_primary: st.primary,
    sms: st.sms_ready,
    code_length: st.sms.code_length,
    ttl_s: LIMITS.ttlMs / 1000,
    resend_s: LIMITS.resendMs / 1000,
  };
}

/* ── ارسال ───────────────────────────────────────────────────────── */
function fill(tpl, vals, enc) {
  return String(tpl || '').replace(/\{([a-z0-9_]+)\}/g, (m, k) => (k in vals ? enc(String(vals[k])) : m));
}
const jsonEnc = (v) => JSON.stringify(v).slice(1, -1);

/* درخواست HTTP پنل را می‌سازد (بدون ارسال) — جدا برای آزمون */
function buildRequest(sms, vals) {
  const all = Object.assign({}, vals);
  all.message = fill(sms.message, all, (x) => x);
  const url = fill(sms.url, all, encodeURIComponent);
  const headers = {};
  for (const [k, v] of sms.headers) headers[k] = fill(v, all, (x) => x.replace(/[\r\n]/g, ' '));
  let body;
  if (sms.method === 'POST') {
    const t = sms.body.trim();
    const isJson = t.startsWith('{') || t.startsWith('[');
    body = fill(sms.body, all, isJson ? jsonEnc : encodeURIComponent);
    const hasType = Object.keys(headers).some(k => k.toLowerCase() === 'content-type');
    if (!hasType) headers['content-type'] = isJson ? 'application/json' : 'application/x-www-form-urlencoded';
  }
  return { url, method: sms.method, headers, body };
}

let transport = null;            /* آزمون: setTransport(fn) */
const consoleLog = [];            /* آزمون/توسعه: آخرین پیامک‌های حالت کنسول */
function setTransport(fn) { transport = fn || null; }

async function deliver(sms, vals, { fetchImpl, timeoutMs = 10_000, log } = {}) {
  if (sms.console) {
    const text = fill(sms.message, vals, (x) => x);
    consoleLog.push({ to: vals.mobile, text, at: Date.now() });
    if (consoleLog.length > 50) consoleLog.shift();
    if (log) log('[sms:console] ' + vals.mobile + ' ← ' + text.replace(/\s+/g, ' '));
    return { ok: true, status: 200 };
  }
  const reqd = buildRequest(sms, vals);
  const f = fetchImpl || transport || globalThis.fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await f(reqd.url, { method: reqd.method, headers: reqd.headers, body: reqd.body, signal: ac.signal, redirect: 'manual' });
    const text = await res.text().catch(() => '');
    const okStatus = res.status >= 200 && res.status < 300;
    const ok = okStatus && (!sms.ok_match || text.includes(sms.ok_match));
    return ok ? { ok: true, status: res.status } : { ok: false, status: res.status, error: 'sms_send_failed' };
  } catch (e) {
    return { ok: false, status: 0, error: 'sms_send_failed' };
  } finally {
    clearTimeout(timer);
  }
}

/* ── کد یک‌بارمصرف ───────────────────────────────────────────────── */
const metaKey = (mobile) => 'otp:' + crypto.createHash('sha256').update('payesh/otp/v1:' + mobile).digest('hex').slice(0, 40);
const hashCode = (salt, mobile, purpose, code) =>
  crypto.createHash('sha256').update(salt + '|' + mobile + '|' + purpose + '|' + code).digest('hex');

function newCode(len) {
  return String(crypto.randomInt(0, 10 ** len)).padStart(len, '0');
}

function readRec(store, mobile) {
  const r = store.getMeta(metaKey(mobile), null);
  return r && typeof r === 'object' ? r : { sent: [] };
}
function saveRec(store, mobile, rec) { store.setMeta(metaKey(mobile), rec); }

/* درخواست کد: ok با sent=true حتی برای شمارهٔ ناشناس (بدون ارسال واقعی) */
async function request(store, input = {}, ctx = {}) {
  const now = ctx.now || Date.now();
  const st = current(store);
  if (!st.sms_ready) return { ok: false, error: 'sms_disabled' };
  const mobile = normalizeMobile(input.phone || input.mobile || '');
  if (!/^09\d{9}$/.test(mobile)) return { ok: false, error: 'bad_phone' };
  const purpose = PURPOSES.includes(input.purpose) ? input.purpose : 'login';
  const rec = readRec(store, mobile);
  const sent = (Array.isArray(rec.sent) ? rec.sent : []).filter(t => Number(t) > now - DAY);
  if (rec.last && now - rec.last < LIMITS.resendMs) {
    return { ok: false, error: 'otp_cooldown', retry_after_s: Math.ceil((LIMITS.resendMs - (now - rec.last)) / 1000) };
  }
  const lastHour = sent.filter(t => t > now - HOUR);
  if (lastHour.length >= LIMITS.perHour || sent.length >= LIMITS.perDay) {
    const oldest = lastHour.length >= LIMITS.perHour ? Math.min(...lastHour) + HOUR : Math.min(...sent) + DAY;
    return { ok: false, error: 'otp_limit', retry_after_s: Math.max(1, Math.ceil((oldest - now) / 1000)) };
  }
  const reply = { ok: true, sent: true, ttl_s: LIMITS.ttlMs / 1000, resend_s: LIMITS.resendMs / 1000, code_length: st.sms.code_length };
  const user = typeof ctx.findUser === 'function' ? ctx.findUser(mobile) : null;
  sent.push(now);
  if (!user || user.active === false) {
    /* ناشناس: همان پاسخ و همان سقف، بدون پیامک و بدون کد */
    saveRec(store, mobile, { sent, last: now });
    return reply;
  }
  const code = newCode(st.sms.code_length);
  const d = await deliver(st.sms, {
    mobile, mobile98: '98' + mobile.slice(1), code,
    minutes: Math.round(LIMITS.ttlMs / 60000), school: String(ctx.school || 'پایش'),
  }, { fetchImpl: ctx.fetchImpl, log: ctx.log });
  if (!d.ok) {
    saveRec(store, mobile, { sent, last: now });
    return { ok: false, error: 'sms_send_failed', status: d.status };
  }
  const salt = crypto.randomBytes(16).toString('hex');
  saveRec(store, mobile, {
    sent, last: now, salt, h: hashCode(salt, mobile, purpose, code),
    purpose, uid: user.id, exp: now + LIMITS.ttlMs, tries: 0,
  });
  return reply;
}

/* بررسی کد: یک‌بارمصرف؛ ۵ تلاش؛ موفق ⇒ { ok, uid, mobile } */
function verify(store, input = {}, ctx = {}) {
  const now = ctx.now || Date.now();
  const st = current(store);
  if (!st.sms_ready) return { ok: false, error: 'sms_disabled' };
  const mobile = normalizeMobile(input.phone || input.mobile || '');
  if (!/^09\d{9}$/.test(mobile)) return { ok: false, error: 'bad_phone' };
  const purpose = PURPOSES.includes(input.purpose) ? input.purpose : 'login';
  const code = String(input.code == null ? '' : input.code).replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[^\d]/g, '');
  const rec = readRec(store, mobile);
  if (!rec.h) return { ok: false, error: 'otp_invalid' };
  const clear = () => saveRec(store, mobile, { sent: rec.sent || [], last: rec.last || 0 });
  if (now > Number(rec.exp || 0)) { clear(); return { ok: false, error: 'otp_expired' }; }
  if ((rec.tries || 0) >= LIMITS.maxAttempts) { clear(); return { ok: false, error: 'otp_locked' }; }
  const want = Buffer.from(String(rec.h), 'hex');
  const got = Buffer.from(hashCode(rec.salt, mobile, purpose, code), 'hex');
  const match = rec.purpose === purpose && code.length === st.sms.code_length &&
    want.length === got.length && crypto.timingSafeEqual(want, got);
  if (!match) {
    const tries = (rec.tries || 0) + 1;
    if (tries >= LIMITS.maxAttempts) { clear(); return { ok: false, error: 'otp_locked' }; }
    saveRec(store, mobile, Object.assign({}, rec, { tries }));
    return { ok: false, error: 'otp_invalid', tries_left: LIMITS.maxAttempts - tries };
  }
  clear();
  return { ok: true, uid: rec.uid, mobile, purpose };
}

/* HTTP status هر خطا */
function statusOf(error) {
  switch (error) {
    case 'sms_disabled': return 503;
    case 'sms_send_failed': return 502;
    case 'otp_cooldown': case 'otp_limit': case 'otp_locked': case 'rate_limited': return 429;
    case 'bad_phone': case 'bad_purpose': case 'bad_password': return 400;
    default: return 401;
  }
}

module.exports = {
  PRIMARY, PURPOSES, LIMITS, DEFAULT_MESSAGE,
  settingsOf, current, publicInfo, parseHeaders, safeUrl, buildRequest, deliver,
  request, verify, statusOf, setTransport, consoleLog, metaKey,
};
