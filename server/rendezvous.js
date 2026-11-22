'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۱۷۱ — «هر دستگاه، هر شبکه، هر جای دنیا»: نقطهٔ قرار سرورهای مدرسه
   ───────────────────────────────────────────────────────────────────
   تا ردیف ۱۷۰ فهرست «فقط نشانی» سرورهای مدرسه (discovery.js) فقط در صندوقچهٔ آروان بود؛
   صندوقچه از بیرون ایران در دسترس نیست و دامنهٔ پروژه هم هنوز رکوردی نداشت، پس گوشی‌ای که
   بیرون از شبکهٔ مدرسه (یا بیرون از ایران) نصب می‌شد گاهی هیچ فهرستی نمی‌دید.

   حالا هر سرور پایش «نقطهٔ قرار» هم هست:
     • GET  /payesh/pub/school-servers.json  و  GET /api/dir/servers
         همان قالب فهرست discovery.js (kind=payesh-school-servers) — ادغام سه منبع:
         آخرین فهرست صندوقچه + ردیف‌هایی که سرورهای دیگر اعلام کرده‌اند + ردیف خود همین سرور.
         وقتی دامنهٔ payeshschool.ir به سرور مرکزی (serv00) اشاره کند، همان نشانی‌ای که
         برنامه‌ها از ردیف ۱۷۰ اول می‌خوانند (https://payeshschool.ir/payesh/pub/school-servers.json)
         مستقیم از همین مسیر پاسخ می‌گیرد.
     • POST /api/dir/announce
         سرور مدرسه ردیف خودش را به سرور(های) مرکزی اعلام می‌کند. امضا: HMAC-SHA256 با کلیدی
         که از تنظیم همان دیتابیس مالک (bucket + کلیدها) ساخته می‌شود؛ فقط سرورهایی که پیرو
         همان دیتابیس‌اند می‌توانند ردیف بگذارند. پنجرهٔ زمانی ۱۰ دقیقه (بی‌تکرار).
   هیچ رازی در پاسخ نیست: همان نام مدرسه و نشانی‌هایی که فهرست عمومی صندوقچه هم دارد.

   نشانی سرور مرکزی: PAYESH_CENTRAL_URL (محیط)، central فهرست (پنل مالک)، و پیش‌فرض
   https://app.payeshschool.ir — دامنهٔ خود پروژه.
   ═══════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');

const KIND = 'payesh-school-servers';
const DEFAULT_CENTRAL = 'https://app.payeshschool.ir';
const STALE_MS = 10 * 24 * 3600_000;
const SKEW_MS = 10 * 60_000;
const MAX_SERVERS = 50;
const MAX_BODY = 64 * 1024;
const META = 'dir:announced';

let announced = new Map();      /* instance → ردیف اعلام‌شده */
let seenSigs = new Map();       /* امضاهای دیده‌شده در پنجرهٔ زمانی (ضد تکرار) */
let loaded = false;
let lastSaved = 0;
let lastAnnounce = new Map();   /* central → {at, ok} */

const httpsOrigin = (u) => {
  try {
    const x = new URL(String(u));
    return x.protocol === 'https:' && x.hostname && !x.username && !x.password ? x.origin : null;
  } catch (e) { return null; }
};
/* سرور مرکزی فقط https؛ استثنا: همین رایانه (آزمون‌ها و سرور مرکزی پشت پروکسی محلی) */
const centralOrigin = (u) => {
  const o = httpsOrigin(u);
  if (o) return o;
  try {
    const x = new URL(String(u));
    return x.protocol === 'http:' && (x.hostname === '127.0.0.1' || x.hostname === 'localhost') ? x.origin : null;
  } catch (e) { return null; }
};
const isPrivateLan = (u) => {
  try { return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(new URL(u).hostname); } catch (e) { return false; }
};

/** ردیف معتبر (همان قاعدهٔ discovery.entryOf) یا null. */
function cleanEntry(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const instance = typeof raw.instance === 'string' ? raw.instance.trim().slice(0, 40) : '';
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(instance)) return null;
  const at = Date.parse(raw.at);
  if (!Number.isFinite(at) || now - at > STALE_MS || at - now > SKEW_MS) return null;
  const lan = [...new Set((Array.isArray(raw.lan) ? raw.lan : []).filter(u => typeof u === 'string' && isPrivateLan(u)).map(u => {
    try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:' ? x.origin : null; } catch (e) { return null; }
  }).filter(Boolean))].slice(0, 8);
  const pubs = [...new Set([...(Array.isArray(raw.public_urls) ? raw.public_urls : []), raw.public_url].map(httpsOrigin).filter(Boolean))].slice(0, 4);
  if (!lan.length && !pubs.length) return null;
  return {
    instance,
    school: typeof raw.school === 'string' && raw.school ? raw.school.slice(0, 120) : null,
    lan,
    public_url: pubs[0] || null,
    public_urls: pubs,
    version: typeof raw.version === 'string' ? raw.version.slice(0, 20) : null,
    at: new Date(at).toISOString(),
  };
}

/** کلید امضای اعلام‌ها — از کلیدهای دیتابیس مالک؛ null وقتی این سرور هنوز به دیتابیس وصل نیست. */
function keyOf(c) {
  /* فقط کلیدهای دیتابیس مالک (نام صندوقچه را سرور گاهی خودش پیدا می‌کند و ممکن است هنوز خالی باشد) */
  if (!c || !c.accessKey || !c.secret) return null;
  return crypto.createHash('sha256')
    .update('payesh-rendezvous-171\u0000' + c.accessKey + '\u0000' + c.secret)
    .digest();
}
const sign = (key, ts, body) => crypto.createHmac('sha256', key).update(String(ts) + '.' + body).digest('hex');

function cloudCfg(store) {
  try { return require('./s3mem').usingMeta(store).get(); } catch (e) { return null; }
}

function load(store) {
  if (loaded) return;
  loaded = true;
  try {
    const m = store.getMeta(META, null);
    const now = Date.now();
    for (const r of (m && Array.isArray(m.servers) ? m.servers : [])) {
      const e = cleanEntry(r, now);
      if (e) announced.set(e.instance, e);
    }
  } catch (e) { /* پایگاه بدون meta */ }
}
function save(store, now = Date.now()) {
  if (now - lastSaved < 60_000) return;
  lastSaved = now;
  try { store.setMeta(META, { at: new Date(now).toISOString(), servers: [...announced.values()] }); } catch (e) { /* اختیاری */ }
}

/** نشانی‌های سرور مرکزی برای اعلام (https، یکتا، بدون خود همین سرور). */
function centralUrls({ doc = null, self = null, env = process.env } = {}) {
  const out = [];
  for (const u of [env.PAYESH_CENTRAL_URL, ...(String(env.PAYESH_CENTRAL_URLS || '').split(/[\s,]+/)), doc && doc.central && doc.central.url, env.PAYESH_NO_DEFAULT_CENTRAL === '1' ? null : DEFAULT_CENTRAL]) {
    const o = centralOrigin(u);
    if (o && o !== centralOrigin(self) && !out.includes(o)) out.push(o);
  }
  return out;
}

/** این سرور خودش «مرکزی» است؟ (PAYESH_CENTRAL=1 یا نشانی عمومی‌اش همان PAYESH_CENTRAL_URL است) */
function isCentral(selfUrl, env = process.env) {
  if (env.PAYESH_CENTRAL === '1') return true;
  const c = httpsOrigin(env.PAYESH_CENTRAL_URL);
  return !!c && c === httpsOrigin(selfUrl);
}

/**
 * فهرست ادغام‌شده: ردیف خود سرور + فهرست صندوقچه + اعلام‌ها؛ برای هر instance تازه‌ترین ردیف.
 * @param {object} o { self: ردیف همین سرور (entryOf) | null, bucketDoc: آخرین فهرست صندوقچه | null, selfUrl }
 */
function mergedDoc(store, { self = null, bucketDoc = null, selfUrl = null, now = Date.now(), env = process.env } = {}) {
  if (store) load(store);
  const best = new Map();
  const put = (r) => {
    const e = cleanEntry(r, now);
    if (!e) return;
    const cur = best.get(e.instance);
    if (!cur || Date.parse(e.at) > Date.parse(cur.at)) best.set(e.instance, e);
  };
  for (const r of (bucketDoc && Array.isArray(bucketDoc.servers) ? bucketDoc.servers : [])) put(r);
  for (const r of announced.values()) put(r);
  if (self) put(self);
  const servers = [...best.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, MAX_SERVERS);
  const doc = { v: 1, kind: KIND, at: new Date(now).toISOString(), servers };
  const fromBucket = bucketDoc && bucketDoc.central && httpsOrigin(bucketDoc.central.url);
  const envCentral = httpsOrigin(env.PAYESH_CENTRAL_URL);
  const selfCentral = isCentral(selfUrl, env) ? httpsOrigin(selfUrl) : null;
  const central = fromBucket || envCentral || selfCentral;
  if (central) doc.central = { url: central, at: (bucketDoc && bucketDoc.central && bucketDoc.central.at) || null };
  if (bucketDoc && bucketDoc.connect && typeof bucketDoc.connect === 'object') doc.connect = bucketDoc.connect;
  return doc;
}

/** همهٔ نشانی‌های یک سرور (شبکهٔ محلی، بعد عمومی) از آنچه این سرور می‌داند. */
function addressesOf(instance, { bucketDoc = null, self = null } = {}) {
  const want = String(instance || '').trim();
  if (!want) return [];
  const doc = mergedDoc(null, { bucketDoc, self });
  const e = doc.servers.find(s => s.instance === want);
  return e ? [...e.public_urls, ...e.lan] : [];
}

/** اعلام رسیده را می‌سنجد و نگه می‌دارد. خروجی {status, body}. */
function receive(store, raw, headers, { now = Date.now(), cfg = null } = {}) {
  load(store);
  const key = keyOf(cfg || cloudCfg(store));
  if (!key) return { status: 503, body: { ok: false, error: 'not_connected' } };
  const ts = Number(headers['x-payesh-ts']);
  const sig = String(headers['x-payesh-sig'] || '');
  if (!Number.isFinite(ts) || Math.abs(now - ts) > SKEW_MS || !/^[0-9a-f]{64}$/.test(sig)) {
    return { status: 401, body: { ok: false, error: 'bad_signature' } };
  }
  const want = Buffer.from(sign(key, ts, raw), 'hex');
  const got = Buffer.from(sig, 'hex');
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return { status: 401, body: { ok: false, error: 'bad_signature' } };
  for (const [s, t] of seenSigs) if (now - t > SKEW_MS) seenSigs.delete(s);
  if (seenSigs.has(sig)) return { status: 409, body: { ok: false, error: 'replay' } };
  seenSigs.set(sig, now);
  let body;
  try { body = JSON.parse(raw); } catch (e) { return { status: 400, body: { ok: false, error: 'bad_json' } }; }
  const e = cleanEntry(body && body.entry, now);
  if (!e) return { status: 400, body: { ok: false, error: 'bad_entry' } };
  announced.set(e.instance, e);
  if (announced.size > MAX_SERVERS * 2) {
    const keep = [...announced.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, MAX_SERVERS);
    announced = new Map(keep.map(x => [x.instance, x]));
  }
  save(store, now);
  return { status: 200, body: { ok: true, instance: e.instance } };
}

/** ردیف همین سرور را به سرور(های) مرکزی اعلام می‌کند و فهرست آن‌ها را برمی‌گرداند (بهترین تلاش). */
async function announce(store, entry, { doc = null, selfUrl = null, fetcher = globalThis.fetch, env = process.env, now = Date.now(), timeoutMs = 10_000 } = {}) {
  const key = keyOf(cloudCfg(store));
  if (!key || !entry || !entry.instance || typeof fetcher !== 'function') return [];
  const body = JSON.stringify({ v: 1, entry });
  const out = [];
  for (const c of centralUrls({ doc, self: selfUrl, env })) {
    const prev = lastAnnounce.get(c);
    /* سرور مرکزیِ در دسترس‌نبوده را هر بار نمی‌کوبیم: حداکثر هر ۱۵ دقیقه */
    if (prev && !prev.ok && now - prev.at < 15 * 60_000) continue;
    const ts = Date.now();
    let ok = false;
    try {
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
      try {
        const r = await fetcher(c + '/api/dir/announce', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-payesh-ts': String(ts), 'x-payesh-sig': sign(key, ts, body) },
          body, signal: ctl ? ctl.signal : undefined,
        });
        ok = !!(r && r.ok);
        if (ok) {
          /* فهرست مرکزی ⇒ همین سرور هم نشانی بقیه را می‌داند (برای پاسخ «مدرسه جای دیگر است») */
          try {
            const g = await fetcher(c + '/api/dir/servers', { signal: ctl ? ctl.signal : undefined });
            const d = g && g.ok ? await g.json() : null;
            if (d && d.kind === KIND) {
              for (const r2 of (Array.isArray(d.servers) ? d.servers : [])) {
                const e2 = cleanEntry(r2, Date.now());
                if (e2 && e2.instance !== entry.instance) {
                  const cur = announced.get(e2.instance);
                  if (!cur || Date.parse(e2.at) > Date.parse(cur.at)) announced.set(e2.instance, e2);
                }
              }
            }
          } catch (e) { /* فقط اعلام مهم بود */ }
        }
      } finally { if (t) clearTimeout(t); }
    } catch (e) { ok = false; }
    lastAnnounce.set(c, { at: now, ok });
    out.push({ url: c, ok });
  }
  return out;
}

/**
 * مسیرهای HTTP نقطهٔ قرار. true یعنی پاسخ داده شد.
 * @param {object} ctx { store, self(): ردیف خود, bucketDoc(): آخرین فهرست صندوقچه, selfUrl() }
 */
async function handle(req, res, url, ctx) {
  const p = url.pathname;
  const send = (status, obj, extra = {}) => {
    res.writeHead(status, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache, max-age=0' }, extra));
    res.end(JSON.stringify(obj));
    return true;
  };
  if ((p === '/payesh/pub/school-servers.json' || p === '/api/dir/servers') && (req.method === 'GET' || req.method === 'HEAD')) {
    let self = null, bucketDoc = null, selfUrl = null;
    try { self = ctx.self(); } catch (e) { self = null; }
    try { bucketDoc = ctx.bucketDoc(); } catch (e) { bucketDoc = null; }
    try { selfUrl = ctx.selfUrl(); } catch (e) { selfUrl = null; }
    return send(200, mergedDoc(ctx.store, { self, bucketDoc, selfUrl }), { 'access-control-allow-origin': '*' });
  }
  if (p === '/api/dir/announce' && req.method === 'POST') {
    let raw = '';
    try {
      raw = await new Promise((resolve, reject) => {
        let n = 0; const parts = [];
        req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error('too_big')); req.destroy(); } else parts.push(c); });
        req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
        req.on('error', reject);
      });
    } catch (e) { return send(413, { ok: false, error: 'too_big' }); }
    const r = receive(ctx.store, raw, req.headers);
    return send(r.status, r.body);
  }
  return false;
}

module.exports = {
  KIND, DEFAULT_CENTRAL, cleanEntry, keyOf, sign, centralUrls, isCentral, mergedDoc, addressesOf, receive, announce, handle,
  _reset() { announced = new Map(); seenSigs = new Map(); loaded = false; lastSaved = 0; lastAnnounce = new Map(); },
};
