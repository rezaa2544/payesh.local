'use strict';
/* ═══════════════════════════════════════════════════════════════════
   پیدا شدن خودکار سرور مدرسه — بدون «نشانی سرور» در صفحهٔ ورود (ردیف ۱۶۳)
   ───────────────────────────────────────────────────────────────────
   برنامهٔ کاربران هیچ کلیدی از دیتابیس (صندوقچهٔ آروان) ندارد و نباید داشته باشد (D‑23)؛
   همهٔ خواندن/نوشتن‌ها از راه سرور مدرسه است که خودش پیرو دیتابیس پنل مالک است
   (cloud-control.js). تنها چیزی که برنامه باید بداند «سرور مدرسه کجاست» — و این را
   دیگر از کاربر نمی‌پرسیم:

     هر سرور مدرسه هر چند دقیقه یک فهرست کوچک «فقط نشانی» در همان دیتابیس می‌گذارد:
       <prefix>pub/school-servers.json      (x-amz-acl: public-read)
     {v:1, kind:'payesh-school-servers', at, servers:[{instance, school, lan:[…], public_url,
       version, at}]}

   این پرونده عمداً «خواندن عمومی» است و هیچ رازی ندارد: نه کلید، نه کاربر، نه داده؛
   فقط نام مدرسه و نشانی‌های همان سرور (نشانی‌های شبکهٔ محلی و اگر باشد نشانی عمومی).
   بقیهٔ دیتابیس خصوصی می‌ماند (درخواست بی‌امضا ⇒ 403). برنامه این پرونده را با یک GET
   ساده می‌خواند، نشانی‌ها را یکی‌یکی می‌آزماید و اولین سروری که جواب «payesh-local»
   بدهد همان سرور مدرسه است.

   چند سرور روی یک دیتابیس: هر سرور فقط ردیف خودش را (با instance) تازه می‌کند و ردیف
   بقیه را دست نمی‌زند؛ ردیف‌هایی که ۱۰ روز تازه نشده‌اند کنار می‌روند.
   ═══════════════════════════════════════════════════════════════════ */
const s3mem = require('./s3mem');

const KIND = 'payesh-school-servers';
const REL = 'pub/school-servers.json';
const EVERY_MS = 5 * 60_000;
const STALE_MS = 10 * 24 * 3600_000;
const MAX_SERVERS = 50;

const isPrivateLan = (u) => {
  try {
    const h = new URL(u).hostname;
    return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  } catch (e) { return false; }
};

/* ردیف همین سرور — فقط نشانی‌ها (نشانی‌های 169.254 و 127 به درد دستگاه دیگری نمی‌خورند) */
function entryOf({ instance, school, lanUrls, publicUrl, version, now }) {
  const lan = [...new Set((lanUrls || []).filter(isPrivateLan))].slice(0, 8);
  let pub = null;
  try { pub = publicUrl && new URL(publicUrl).protocol === 'https:' ? String(publicUrl).replace(/\/+$/, '') : null; } catch (e) { pub = null; }
  return {
    instance: String(instance || '').slice(0, 40),
    school: school ? String(school).slice(0, 120) : null,
    lan,
    public_url: pub,
    version: version ? String(version).slice(0, 20) : null,
    at: new Date(now == null ? Date.now() : now).toISOString(),
  };
}

/* فهرست تازه = ردیف همین سرور + ردیف‌های تازهٔ بقیه (کهنه‌ها کنار می‌روند) */
function merge(prev, mine, now) {
  const t = now == null ? Date.now() : now;
  const others = (prev && Array.isArray(prev.servers) ? prev.servers : [])
    .filter(s => s && typeof s === 'object' && s.instance && s.instance !== mine.instance)
    .filter(s => { const a = Date.parse(s.at); return Number.isFinite(a) && t - a < STALE_MS; });
  const servers = [mine, ...others]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, MAX_SERVERS);
  const doc = { v: 1, kind: KIND, at: new Date(t).toISOString(), servers };
  /* ردیف ۱۶۴: «سرور مرکزی» که مالک در پنل (زیرساخت ← سرور) تعریف کرده؛ فقط پنل مالک آن را
     می‌نویسد و سرورهای مدرسه هنگام تازه کردن ردیف خودشان دست نمی‌زنند. */
  const c = centralOf(prev);
  if (c) doc.central = c;
  return doc;
}

/* فقط https و بدون مسیر/کاربر (همان قاعدهٔ برنامه: نشانی عمومی بدون https پذیرفته نیست) */
function centralOf(prev) {
  const c = prev && prev.central;
  if (!c || typeof c !== 'object' || typeof c.url !== 'string') return null;
  try {
    const u = new URL(c.url);
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return null;
    return { url: u.origin, at: typeof c.at === 'string' ? c.at.slice(0, 40) : null };
  } catch (e) { return null; }
}

const keyOf = (cfg) => String(cfg.prefix || 'payesh/') + REL;

let lastBody = '';
let lastAt = 0;

/* یک دور: فهرست فعلی را می‌خواند، ردیف خودش را می‌گذارد و با public-read می‌نویسد */
async function publish(store, info, { now } = {}) {
  const cfg = await s3mem.ensureBucket(store);
  if (!cfg || !cfg.enabled) return { ok: false, error: 'no_cloud' };
  const mine = entryOf(Object.assign({}, info, { now }));
  if (!mine.instance) return { ok: false, error: 'no_instance' };
  if (!mine.lan.length && !mine.public_url) return { ok: false, error: 'no_address' };
  let prev = null;
  try { prev = JSON.parse(await s3mem.get(cfg, keyOf(cfg))); } catch (e) { prev = null; }
  if (prev && prev.kind !== KIND) prev = null;
  const doc = merge(prev, mine, now);
  /* اگر چیزی جز زمان عوض نشده و کمتر از یک ساعت گذشته، دوباره نمی‌نویسیم */
  const stable = JSON.stringify(doc.central || null) + JSON.stringify(doc.servers.map(s => Object.assign({}, s, { at: s.instance === mine.instance ? '' : s.at })));
  const t = now == null ? Date.now() : now;
  if (stable === lastBody && t - lastAt < 3600_000) return { ok: true, skipped: 'unchanged', servers: doc.servers.length };
  await s3mem.call(cfg, {
    method: 'PUT', key: keyOf(cfg), body: JSON.stringify(doc),
    headers: { 'x-amz-acl': 'public-read', 'cache-control': 'no-cache, max-age=0' },
  });
  lastBody = stable;
  lastAt = t;
  return { ok: true, key: keyOf(cfg), servers: doc.servers.length };
}

let timer = null;
function start(store, getInfo, { every = EVERY_MS, first = 15_000 } = {}) {
  stop();
  const tick = () => {
    let info;
    try { info = getInfo(); } catch (e) { return; }
    publish(store, info).catch(() => { /* دور بعد */ });
  };
  const t0 = setTimeout(tick, first);
  if (t0.unref) t0.unref();
  timer = setInterval(tick, every);
  if (timer.unref) timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; lastBody = ''; lastAt = 0; }

module.exports = { KIND, REL, STALE_MS, entryOf, merge, centralOf, publish, start, stop, keyOf };
