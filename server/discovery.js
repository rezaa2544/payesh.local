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

   ردیف ۱۶۵: هر ردیف همهٔ نشانی‌های عمومی همان سرور را هم دارد (public_urls — Tailscale،
   تونل Cloudflare، نشانی دستی؛ public_url = بهترینِ آن‌ها برای برنامه‌های قدیمی). پنل مالک
   «حالت اتصال» را در connect:{mode,at} می‌نویسد؛ سرورها آن را نگه می‌دارند، هر دقیقه
   می‌خوانند و تونل‌ها را مطابقش روشن/خاموش می‌کنند (tunnel.js). وقتی نشانی تونل عوض شد،
   فهرست بی‌درنگ (kick) تازه می‌شود، نه پنج دقیقهٔ بعد.
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
const httpsOrigin = (u) => {
  try {
    const x = new URL(String(u));
    return x.protocol === 'https:' && x.hostname && !x.username && !x.password ? x.origin : null;
  } catch (e) { return null; }
};

function entryOf({ instance, school, lanUrls, publicUrl, publicUrls, version, now }) {
  const lan = [...new Set((lanUrls || []).filter(isPrivateLan))].slice(0, 8);
  const pubs = [...new Set([...(Array.isArray(publicUrls) ? publicUrls : []), publicUrl].map(httpsOrigin).filter(Boolean))].slice(0, 4);
  return {
    instance: String(instance || '').slice(0, 40),
    school: school ? String(school).slice(0, 120) : null,
    lan,
    public_url: pubs[0] || null,
    public_urls: pubs,
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
  /* ردیف ۱۶۵: «حالت اتصال» انتخاب مالک — مثل central فقط پنل مالک می‌نویسد */
  const k = connectOf(prev);
  if (k) doc.connect = k;
  return doc;
}

const CONNECT_MODES = ['auto', 'cloudflare', 'tailscale', 'central', 'lan'];
/** connect:{mode,at} معتبر یا null (حالت ناشناخته ⇒ null ⇒ سرور روی «خودکار» می‌ماند). */
function connectOf(prev) {
  const k = prev && prev.connect;
  if (!k || typeof k !== 'object' || !CONNECT_MODES.includes(k.mode)) return null;
  return { mode: k.mode, at: typeof k.at === 'string' ? k.at.slice(0, 40) : null };
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
/* ردیف ۱۷۱: آخرین فهرستی که از صندوقچه خوانده شد (برای نقطهٔ قرار و پاسخ «مدرسه جای دیگر است») */
let lastDocSeen = null;
const lastDoc = () => lastDocSeen;

/* ردیف ۱۷۱: ردیف همین سرور را به سرور(های) مرکزی هم اعلام می‌کند — حتی وقتی صندوقچه در دسترس نیست */
async function announceNow(store, info, opts = {}) {
  const mine = entryOf(Object.assign({}, info, { now: opts.now }));
  if (!mine.instance || (!mine.lan.length && !mine.public_url)) return [];
  return require('./rendezvous').announce(store, mine, Object.assign({ doc: lastDocSeen, selfUrl: info && info.publicUrl }, opts));
}

/* یک دور: فهرست فعلی را می‌خواند، ردیف خودش را می‌گذارد و با public-read می‌نویسد */
async function publish(store, info, { now, onDoc = null } = {}) {
  const cfg = await s3mem.ensureBucket(store);
  if (!cfg || !cfg.enabled) return { ok: false, error: 'no_cloud' };
  const mine = entryOf(Object.assign({}, info, { now }));
  if (!mine.instance) return { ok: false, error: 'no_instance' };
  if (!mine.lan.length && !mine.public_url) return { ok: false, error: 'no_address' };
  let prev = null;
  try { prev = JSON.parse(await s3mem.get(cfg, keyOf(cfg))); } catch (e) { prev = null; }
  if (prev && prev.kind !== KIND) prev = null;
  if (prev) lastDocSeen = prev;
  if (onDoc && prev) { try { onDoc(prev); } catch (e) { /* noop */ } }
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

/** فقط خواندن فهرست (برای حالت اتصال)؛ null اگر نشد. */
async function read(store) {
  const cfg = await s3mem.ensureBucket(store);
  if (!cfg || !cfg.enabled) return null;
  try {
    const doc = JSON.parse(await s3mem.get(cfg, keyOf(cfg)));
    if (doc && doc.kind === KIND) lastDocSeen = doc;
    return doc && doc.kind === KIND ? doc : null;
  } catch (e) { return null; }
}

let timer = null;
let watchTimer = null;
let kickTimer = null;
let tickFn = null;
/**
 * [onConnect]({mode,at}|null) هر بار که فهرست خوانده شد (هر دقیقه و هنگام هر انتشار).
 */
function start(store, getInfo, { every = EVERY_MS, first = 15_000, watchEvery = 60_000, onConnect = null } = {}) {
  stop();
  const onDoc = onConnect ? (doc) => onConnect(connectOf(doc)) : null;
  const tick = () => {
    let info;
    try { info = getInfo(); } catch (e) { return; }
    publish(store, info, { onDoc }).catch(() => { /* دور بعد */ })
      .then(() => (process.env.PAYESH_ANNOUNCE === '0' ? null : announceNow(store, info)))
      .catch(() => { /* دور بعد */ });
  };
  tickFn = tick;
  const t0 = setTimeout(tick, first);
  if (t0.unref) t0.unref();
  timer = setInterval(tick, every);
  if (timer.unref) timer.unref();
  if (onDoc && watchEvery > 0) {
    watchTimer = setInterval(() => { read(store).then(d => { if (d) onDoc(d); }).catch(() => {}); }, watchEvery);
    if (watchTimer.unref) watchTimer.unref();
  }
}
/** نشانی عوض شد ⇒ چند ثانیه بعد منتشر کن (نه پنج دقیقهٔ بعد). */
function kick(delayMs = 2_000) {
  if (!tickFn) return false;
  clearTimeout(kickTimer);
  kickTimer = setTimeout(tickFn, delayMs);
  if (kickTimer.unref) kickTimer.unref();
  return true;
}
function stop() {
  if (timer) clearInterval(timer);
  if (watchTimer) clearInterval(watchTimer);
  clearTimeout(kickTimer);
  timer = null; watchTimer = null; tickFn = null; lastBody = ''; lastAt = 0; lastDocSeen = null;
}

module.exports = { KIND, REL, STALE_MS, CONNECT_MODES, entryOf, merge, centralOf, connectOf, publish, read, start, stop, kick, keyOf, lastDoc, announceNow };
