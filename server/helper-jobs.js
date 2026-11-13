'use strict';
/* ═══════════════════════════════════════════════════════════════════
   سرور کمکی (helper) — صندوقچهٔ آروان در نقش «صندوق نامه»
   ───────────────────────────────────────────────────────────────────
   هر سیستمی که پنل مالک روی آن نصب است، به‌طور پیش‌فرض «سرور کمکی» هم هست
   (apps/payesh/owner/lib/src/helper/). سرور مدرسه کارهای پردازشی را به‌جای
   انجام دادن روی خودش، در صندوقچه می‌گذارد؛ هر سرور کمکیِ روشن آن را برمی‌دارد،
   انجام می‌دهد و نتیجه را برمی‌گرداند. هیچ پورت و تنظیم شبکه‌ای لازم نیست.

   پردازش هیچ‌وقت متوقف نمی‌شود: اگر هیچ سرور کمکیِ زنده‌ای نباشد، یا ظرف
   CLAIM_WAIT_MS کسی کار را برندارد، یا سرور کمکی وسط کار خاموش شود (مهلت رزرو
   بگذرد)، همین سرور کار را خودش انجام می‌دهد.

   قرارداد v1 (Node = Dart، بایت‌به‌بایت؛ docs/cloud/contracts/helper-jobs-vectors.json):
     <prefix>helpers/<helper_id>.json   حضور    kind=payesh-helper
     <prefix>jobs/req/<job_id>.json     درخواست kind=payesh-job
     <prefix>jobs/lease/<job_id>.json   رزرو    kind=payesh-job-lease
     <prefix>jobs/res/<job_id>.json     نتیجه   kind=payesh-job-result
   پاکت: {v:1, kind, rev, alg:"HKDF-SHA256/A256GCM", nonce, ct}
     key = HKDF-SHA256(utf8(secret صندوقچه), salt="payesh/helper-jobs", info="v1", 32)
     AES-256-GCM، nonce ۱۲ بایت، AAD = "<kind>/v1/<rev>"، ct = متن رمز || برچسب ۱۶ بایتی
   فقط دارندهٔ کلید همان صندوقچه (پنل مالک و سرورهای مدرسه) می‌تواند کاری بگذارد یا
   نتیجه‌ای بنویسد؛ برچسب GCM یعنی نتیجهٔ دستکاری‌شده باز نمی‌شود.

   فقط کارهای «بدون محتوای مدرسه» (قاعدهٔ D-21): هیچ نوع کاری محتوای خوانای مدرسه را
   به سرور کمکی نمی‌دهد.
     storage.usage   جمع حجم و تعداد فایل‌های صندوقچه به تفکیک بخش
     object.verify   بازخوانی مستقل یک فایل و مقایسهٔ SHA-256 و حجم
     endpoint.check  آیا یک آدرس عمومی از بیرونِ این شبکه در دسترس است؟ (نه IP خصوصی)
     bucket.gc       پاک کردن فایل‌های کهنهٔ صف و حضور
   ═══════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const os = require('os');
const { performance } = require('perf_hooks');
const s3mem = require('./s3mem');
const { trustFetch } = require('./s3-https');
const loadRoute = require('./load-route');

const SALT = Buffer.from('payesh/helper-jobs', 'utf8');
const INFO = Buffer.from('v1', 'utf8');
const ALG = 'HKDF-SHA256/A256GCM';
const K = {
  presence: 'payesh-helper',
  request: 'payesh-job',
  lease: 'payesh-job-lease',
  result: 'payesh-job-result',
  policy: 'payesh-infra-policy',
};
const DIR = { helpers: 'helpers/', req: 'jobs/req/', lease: 'jobs/lease/', res: 'jobs/res/' };
const KINDS = ['storage.usage', 'object.verify', 'endpoint.check', 'bucket.gc'];
/* سیاست زیرساخت که پنل مالک می‌نویسد (ردیف ۱۳۱): {v:1, helpers:bool, off:[service_id], at} */
const POLICY_KEY = 'control/infra-policy.json';
const POLICY_MAX_AGE_MS = 60_000;
/* «نیاز به پردازش کمکی»: بار حلقهٔ رویداد Node یا CPU میزبان در ۵ ثانیهٔ اخیر */
const BUSY_ELU = 0.6;
const BUSY_CPU = 0.75;
const LOAD_SAMPLE_MS = 5_000;

const PRESENCE_FRESH_MS = 90_000;     /* حضوری که از این قدیمی‌تر باشد «خاموش» است */
const CLAIM_WAIT_MS = 20_000;         /* اگر کسی کار را برنداشت ⇒ خودمان */
const JOB_DEADLINE_MS = 10 * 60_000;  /* سقف کل یک کار */
const RESULT_POLL_MS = 2_000;
const GC_JOB_AGE_MS = 60 * 60_000;    /* فایل‌های صف پس از ۱ ساعت */
const GC_HELPER_AGE_MS = 7 * 24 * 3600_000;
const GC_BLOB_AGE_MS = 60 * 24 * 3600_000; /* آینهٔ فایل‌های به‌روزرسانی پنل مالک */
const MAX_VERIFY_BYTES = 512 * 1024 * 1024;
const USAGE_MAX_PAGES = 50;

const ID_RE = /^[0-9a-f]{16}$/;
const JOB_ID_RE = /^[0-9]{13}-[0-9a-f]{16}$/;

class HelperError extends Error {
  constructor(code, detail) { super(detail ? code + ': ' + detail : code); this.code = code; }
}

const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function unb64u(s, len) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) throw new HelperError('bad_format');
  const b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (b64u(b) !== s || (len && b.length !== len)) throw new HelperError('bad_format');
  return b;
}
const keyFor = (secret) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(String(secret), 'utf8'), SALT, INFO, 32));
const aadFor = (kind, rev) => Buffer.from(kind + '/v1/' + rev, 'utf8');

function seal(secret, kind, rev, plainText, nonce) {
  const n = nonce ? Buffer.from(nonce) : crypto.randomBytes(12);
  if (n.length !== 12) throw new HelperError('bad_nonce');
  const c = crypto.createCipheriv('aes-256-gcm', keyFor(secret), n);
  c.setAAD(aadFor(kind, rev));
  const ct = Buffer.concat([c.update(Buffer.from(plainText, 'utf8')), c.final(), c.getAuthTag()]);
  return { v: 1, kind, rev, alg: ALG, nonce: b64u(n), ct: b64u(ct) };
}
function open(secret, kind, env) {
  if (!env || typeof env !== 'object' || env.v !== 1 || env.kind !== kind || env.alg !== ALG) {
    throw new HelperError('bad_format');
  }
  const rev = env.rev;
  if (!Number.isSafeInteger(rev) || rev <= 0) throw new HelperError('bad_format');
  const n = unb64u(env.nonce, 12);
  const ct = unb64u(env.ct);
  if (ct.length < 17) throw new HelperError('bad_format');
  let text;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', keyFor(secret), n);
    d.setAAD(aadFor(kind, rev));
    d.setAuthTag(ct.subarray(ct.length - 16));
    text = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString('utf8');
  } catch (e) {
    throw new HelperError('open_failed');
  }
  let plain;
  try { plain = JSON.parse(text); } catch (e) { throw new HelperError('bad_plain'); }
  if (!plain || typeof plain !== 'object' || plain.v !== 1) throw new HelperError('bad_plain');
  return { rev, plain };
}

const newJobId = (now) => String(now).padStart(13, '0') + '-' + crypto.randomBytes(8).toString('hex');
const jobAt = (id) => Number(String(id).slice(0, 13));
const nameOf = (key) => String(key).split('/').pop().replace(/\.json$/, '');

/* ── خواندن/نوشتن پاکت‌ها ─────────────────────────────────────────── */
async function readEnv(cfg, key, kind) {
  let text;
  try { text = await s3mem.get(cfg, key); } catch (e) {
    if (e && e.status === 404) return null;
    throw e;
  }
  try { return open(cfg.secret, kind, JSON.parse(text)); } catch (e) { return { invalid: true }; }
}
const writeEnv = (cfg, key, kind, now, plain) =>
  s3mem.put(cfg, key, JSON.stringify(seal(cfg.secret, kind, now, JSON.stringify(plain))));
async function removeKey(cfg, key) {
  try { await s3mem.remove(cfg, key); } catch (e) { /* نبودن هم یعنی پاک */ }
}

/* فهرست کامل زیر یک پیشوند (با صفحه‌بندی) */
async function listAll(cfg, prefix, maxPages = USAGE_MAX_PAGES) {
  const out = [];
  let token = null;
  let pages = 0;
  let truncated = false;
  do {
    const r = await s3mem.list(cfg, { prefix, max: 1000, token: token || undefined });
    out.push(...r.keys);
    token = r.truncated ? r.token : null;
    pages++;
    if (token && pages >= maxPages) { truncated = true; break; }
  } while (token);
  return { keys: out, truncated };
}

/* ── سرورهای کمکیِ زنده ────────────────────────────────────────────── */
async function helpersOnline(cfg, { now = Date.now() } = {}) {
  const { keys } = await listAll(cfg, cfg.prefix + DIR.helpers, 2);
  const out = [];
  for (const k of keys) {
    const id = nameOf(k.key);
    if (!ID_RE.test(id)) continue;
    const r = await readEnv(cfg, k.key, K.presence).catch(() => null);
    if (!r || r.invalid) continue;
    const p = r.plain;
    if (p.helper_id !== id || !Number.isSafeInteger(p.at)) continue;
    out.push({
      helper_id: id,
      host: String(p.host || '').slice(0, 80),
      version: String(p.version || '').slice(0, 40),
      slots: Number(p.slots) || 1,
      paused: p.paused === true,
      kinds: Array.isArray(p.kinds) ? p.kinds.filter(x => KINDS.includes(x)) : [],
      at: p.at,
      done: Number(p.done) || 0,
      failed: Number(p.failed) || 0,
      online: p.paused !== true && now - p.at <= PRESENCE_FRESH_MS && p.at - now <= PRESENCE_FRESH_MS,
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

/* ── اجرای محلیِ هر نوع کار (همان چیزی که سرور کمکی انجام می‌دهد) ───── */
function validParams(cfg, kind, params) {
  const p = params && typeof params === 'object' ? params : {};
  if (kind === 'storage.usage') {
    const prefix = p.prefix === undefined ? cfg.prefix : String(p.prefix);
    if (!prefix.startsWith(cfg.prefix) || prefix.includes('..')) throw new HelperError('bad_params', 'prefix');
    return { prefix };
  }
  if (kind === 'object.verify') {
    const key = String(p.key || '');
    if (!key.startsWith(cfg.prefix) || key.includes('..') || key.length > 512) throw new HelperError('bad_params', 'key');
    const out = { key };
    if (p.sha256 !== undefined) {
      if (!/^[0-9a-f]{64}$/.test(String(p.sha256))) throw new HelperError('bad_params', 'sha256');
      out.sha256 = String(p.sha256);
    }
    if (p.size !== undefined) {
      if (!Number.isSafeInteger(p.size) || p.size < 0) throw new HelperError('bad_params', 'size');
      out.size = p.size;
    }
    return out;
  }
  if (kind === 'endpoint.check') {
    let u;
    try { u = new URL(String(p.url || '')); } catch (e) { throw new HelperError('bad_params', 'url'); }
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new HelperError('bad_params', 'url');
    return { url: u.toString() };
  }
  if (kind === 'bucket.gc') return {};
  throw new HelperError('unknown_kind', kind);
}

/* IP خصوصی/حلقه/محلی ⇒ سرور کمکی هرگز به آن درخواست نمی‌زند (جلوگیری از کاوش شبکهٔ داخلی) */
function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; /* CGNAT */
    return true;
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === '::1' || s === '::') return false;
    if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('ff')) return false;
    const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPublicIp(m[1]);
    return true;
  }
  return false;
}

async function checkEndpoint(url, { timeoutMs = 8000, lookup = dns.promises.lookup, allowPrivate = false } = {}) {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) return { reachable: false, error: 'dns' };
  if (!allowPrivate && !addrs.every(a => isPublicIp(a.address))) return { reachable: false, error: 'private_address' };
  const t0 = Date.now();
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = lib.request(u, {
      method: 'HEAD', timeout: timeoutMs,
      lookup: (h, o, cb) => (o && o.all) ? cb(null, [{ address: addrs[0].address, family: net.isIP(addrs[0].address) }])
        : cb(null, addrs[0].address, net.isIP(addrs[0].address)),
    }, (res) => {
      res.resume();
      resolve({ reachable: res.statusCode < 500, status: res.statusCode, ms: Date.now() - t0 });
    });
    req.on('timeout', () => { req.destroy(); resolve({ reachable: false, error: 'timeout', ms: Date.now() - t0 }); });
    req.on('error', (e) => resolve({ reachable: false, error: String(e.code || 'network'), ms: Date.now() - t0 }));
    req.end();
  });
}

async function getBytes(cfg, key) {
  const signed = s3mem.buildRequest(cfg, { method: 'GET', key });
  const res = await trustFetch(signed.url, { method: 'GET', headers: signed.headers, maxBody: MAX_VERIFY_BYTES, timeoutMs: 120000 });
  if (res.status === 404) return null;
  if (!res.ok) throw new HelperError('s3_' + res.status);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_VERIFY_BYTES) throw new HelperError('too_large');
  const b = Buffer.from(await res.arrayBuffer());
  if (b.length > MAX_VERIFY_BYTES) throw new HelperError('too_large');
  return b;
}

async function runLocal(cfg, kind, params, opts = {}) {
  const p = validParams(cfg, kind, params);
  const now = opts.now ? opts.now() : Date.now();
  if (kind === 'storage.usage') {
    const { keys, truncated } = await listAll(cfg, p.prefix);
    const groups = {};
    let bytes = 0;
    for (const k of keys) {
      const rest = k.key.slice(p.prefix.length);
      const g = rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : '(root)';
      groups[g] = groups[g] || { objects: 0, bytes: 0 };
      groups[g].objects++;
      groups[g].bytes += k.size;
      bytes += k.size;
    }
    return { objects: keys.length, bytes, groups, truncated };
  }
  if (kind === 'object.verify') {
    const b = await (opts.getBytes || getBytes)(cfg, p.key);
    if (!b) return { exists: false, size: 0, sha256: null, match: p.sha256 || p.size !== undefined ? false : null };
    const sha = crypto.createHash('sha256').update(b).digest('hex');
    const want = p.sha256 !== undefined || p.size !== undefined;
    return {
      exists: true, size: b.length, sha256: sha,
      match: want ? ((p.sha256 === undefined || p.sha256 === sha) && (p.size === undefined || p.size === b.length)) : null,
    };
  }
  if (kind === 'endpoint.check') {
    return (opts.checkEndpoint || checkEndpoint)(p.url);
  }
  if (kind === 'bucket.gc') {
    const out = { deleted_jobs: 0, deleted_helpers: 0, deleted_blobs: 0 };
    for (const d of [DIR.req, DIR.lease, DIR.res]) {
      const { keys } = await listAll(cfg, cfg.prefix + d, 5);
      for (const k of keys) {
        const id = nameOf(k.key);
        if (!JOB_ID_RE.test(id) || now - jobAt(id) > GC_JOB_AGE_MS) { await removeKey(cfg, k.key); out.deleted_jobs++; }
      }
    }
    const { keys: hk } = await listAll(cfg, cfg.prefix + DIR.helpers, 2);
    for (const k of hk) {
      const r = await readEnv(cfg, k.key, K.presence).catch(() => null);
      const at = r && !r.invalid ? r.plain.at : null;
      if (r && !r.invalid && Number.isSafeInteger(at) && now - at <= GC_HELPER_AGE_MS) continue;
      if (r && r.invalid) continue; /* پاکتِ کلید دیگر: مال ما نیست، دست نمی‌زنیم */
      await removeKey(cfg, k.key); out.deleted_helpers++;
    }
    const { keys: bk } = await listAll(cfg, cfg.prefix + 'updates/owner/', 5);
    for (const k of bk) {
      if (k.modified && now - Date.parse(k.modified) > GC_BLOB_AGE_MS) { await removeKey(cfg, k.key); out.deleted_blobs++; }
    }
    return out;
  }
  throw new HelperError('unknown_kind', kind);
}

/* ── سیاست زیرساخت (پنل مالک ⇐ همهٔ سرورها) ─────────────────────────── */
/* ردیف ۱۵۳: mode (db | helpers | external) و external (نشانی سرور بیرونی) اختیاری‌اند؛
   سیاست قدیمی بدون mode ⇒ helpers ? 'helpers' : 'db'. کلید هر سیستم کمکی در off با «helper:<id>». */
function validPolicy(p) {
  return !!p && p.v === 1 && typeof p.helpers === 'boolean' && Array.isArray(p.off) &&
    p.off.every(x => typeof x === 'string') && Number.isSafeInteger(p.at) &&
    (p.mode === undefined || loadRoute.MODES.includes(p.mode)) &&
    (p.external === undefined || (typeof p.external === 'string' && p.external.length <= 300));
}
const helperOff = (policy, id) => !!policy && Array.isArray(policy.off) && policy.off.includes('helper:' + id);
let policyCache = { key: '', at: 0, value: null };
async function readPolicy(cfg, { now = Date.now(), maxAgeMs = POLICY_MAX_AGE_MS } = {}) {
  const ck = cfg.bucket + '|' + cfg.prefix + '|' + keyFor(cfg.secret).toString('hex').slice(0, 16);
  if (policyCache.key === ck && now - policyCache.at < maxAgeMs) return policyCache.value;
  let value = null;
  try {
    const r = await readEnv(cfg, cfg.prefix + POLICY_KEY, K.policy);
    if (r && !r.invalid && validPolicy(r.plain)) value = r.plain;
  } catch (e) {
    /* صندوقچه موقتاً در دسترس نیست: آخرین سیاست شناخته‌شده */
    value = policyCache.key === ck ? policyCache.value : null;
  }
  policyCache = { key: ck, at: now, value };
  return value;
}
const writePolicy = (cfg, policy) => writeEnv(cfg, cfg.prefix + POLICY_KEY, K.policy, policy.at, policy);

/* بار همین سرور در ۵ ثانیهٔ اخیر (نمونه‌برداری با تایمر unref) */
function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) { for (const v of Object.values(c.times)) total += v; idle += c.times.idle; }
  return { idle, total };
}
const load = { elu: 0, cpu: 0, timer: null, lastElu: null, lastCpu: null };
function sampleLoad() {
  const e = performance.eventLoopUtilization();
  const c = cpuTimes();
  if (load.lastElu) {
    load.elu = performance.eventLoopUtilization(e, load.lastElu).utilization;
    const dt = c.total - load.lastCpu.total;
    load.cpu = dt > 0 ? Math.max(0, Math.min(1, 1 - (c.idle - load.lastCpu.idle) / dt)) : 0;
  }
  load.lastElu = e; load.lastCpu = c;
}
function busyNow() {
  if (!load.timer) {
    sampleLoad();
    load.timer = setInterval(sampleLoad, LOAD_SAMPLE_MS);
    load.timer.unref();
  }
  return load.elu >= BUSY_ELU || load.cpu >= BUSY_CPU;
}

/* آیا این کار به سرور کمکی نیاز دارد؟ null = بله؛ وگرنه دلیلِ انجام روی همین سرور.
   ردیف ۱۵۳: حالت «فقط دیتابیس» ⇒ هرگز؛ وگرنه وقتی مسیر بار سیستم‌های کمکی را به کار گرفته
   (زمان پاسخ/خطای دیتابیس یا سرور بیرونی بالا رفته) یا خود سرور شلوغ است. */
function helperNeed(kind, { policy, busy, route = null }) {
  if (policy && (policy.helpers === false || policy.mode === 'db')) return 'helpers_disabled';
  if (kind === 'endpoint.check') return null;   /* دید «از بیرون» فقط از سیستم دیگر */
  if (busy) return null;
  if (route && Array.isArray(route.active) && route.active.includes('helpers')) return null;
  return 'not_needed';                          /* دیتابیس و سرور جا دارند ⇒ بدون تأخیر صف */
}

/* مسیر بار همین سرور با سیاست جاری (ردیف ۱۵۳) */
async function routeNow(policy, { busy = false, now = Date.now() } = {}) {
  const mode = loadRoute.modeOf(policy);
  if (mode === 'external' && policy && policy.external) {
    await loadRoute.probeExternal(policy.external, trustFetch, now).catch(() => null);
  }
  return loadRoute.tick(policy, { busy, now });
}

/* ── ارسال یک کار: سرور کمکی ⇐ یا خودمان (هرگز متوقف نمی‌شود) ─────────── */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function runJob(cfg, kind, params, opts = {}) {
  const now = opts.now || Date.now;
  const wait = opts.sleep || sleep;
  const claimWait = opts.claimWaitMs || CLAIM_WAIT_MS;
  const pollMs = opts.pollMs || RESULT_POLL_MS;
  const deadlineMs = opts.deadlineMs || JOB_DEADLINE_MS;
  const p = validParams(cfg, kind, params);
  const local = async (why) => {
    const result = await runLocal(cfg, kind, p, opts);
    return { ok: true, by: 'local', why, result };
  };
  if (opts.preferLocal) return local('prefer_local');
  /* مسیر عادی: همین سرور مستقیم با دیتابیس. سرور کمکی فقط هنگام نیاز. */
  const policy = opts.policy !== undefined ? opts.policy : await readPolicy(cfg, { now: now() });
  const busy = typeof opts.busy === 'function' ? !!opts.busy() : opts.busy !== undefined ? !!opts.busy : busyNow();
  const route = opts.route !== undefined ? opts.route : await routeNow(policy, { busy, now: now() });
  const skip = helperNeed(kind, { policy, busy, route });
  if (skip) return local(skip);
  let online = [];
  try { online = (await helpersOnline(cfg, { now: now() })).filter(h => h.online && h.kinds.includes(kind) && !helperOff(policy, h.helper_id)); }
  catch (e) { return local('bucket_unreachable'); }
  if (!online.length) return local('no_helper');

  const t0 = now();
  const id = newJobId(t0);
  const keys = { req: cfg.prefix + DIR.req + id + '.json', lease: cfg.prefix + DIR.lease + id + '.json', res: cfg.prefix + DIR.res + id + '.json' };
  const cleanup = () => Promise.all([removeKey(cfg, keys.req), removeKey(cfg, keys.lease), removeKey(cfg, keys.res)]);
  try {
    await writeEnv(cfg, keys.req, K.request, t0, {
      v: 1, job_id: id, kind, params: p, from: String(opts.from || 'school-server').slice(0, 80),
      created_at: t0, deadline_at: t0 + deadlineMs,
    });
  } catch (e) { return local('bucket_unreachable'); }

  let claimedBy = null;
  for (;;) {
    await wait(pollMs);
    const t = now();
    let res = null;
    try { res = await readEnv(cfg, keys.res, K.result); } catch (e) { /* موقتی */ }
    if (res && !res.invalid && res.plain.job_id === id) {
      await cleanup();
      if (res.plain.ok) return { ok: true, by: res.plain.helper_id, result: res.plain.result };
      /* خطای خود کار (مثلاً پارامتر) را دوباره محلی امتحان نمی‌کنیم مگر خطای زیرساخت باشد */
      if (res.plain.error === 'bad_params' || res.plain.error === 'unknown_kind') {
        return { ok: false, by: res.plain.helper_id, error: res.plain.error };
      }
      return local('helper_failed');
    }
    let lease = null;
    try { lease = await readEnv(cfg, keys.lease, K.lease); } catch (e) { /* موقتی */ }
    if (lease && !lease.invalid && lease.plain.job_id === id) {
      claimedBy = lease.plain.helper_id;
      if (Number(lease.plain.until) < t) { await cleanup(); return local('lease_expired'); }
    } else if (!claimedBy && t - t0 >= claimWait) {
      await cleanup(); return local('not_claimed');
    } else if (claimedBy) {
      await cleanup(); return local('lease_lost');
    }
    if (t - t0 >= deadlineMs) { await cleanup(); return local('deadline'); }
  }
}

/* ── سرور مدرسه: وضعیت سرورهای کمکی + بررسی بیرونیِ آدرس عمومی ─────── */
const META_PUBLIC_CHECK = 'helper:public_check';
let timer = null;
let routeTimer = null;
const ROUTE_TICK_MS = 5_000;

async function status(store) {
  const cfg = s3mem.usingMeta(store).get();
  if (!cfg || !cfg.enabled) return { configured: false, helpers: [], online: 0 };
  const use = (p) => ({ use_helpers: loadRoute.modeOf(p) !== 'db', when: 'need', mode: loadRoute.modeOf(p), load: loadRoute.snapshot() });
  try {
    const helpers = await helpersOnline(cfg);
    const policy = await readPolicy(cfg);
    return Object.assign({ configured: true, helpers, online: helpers.filter(h => h.online).length, public_check: store.getMeta(META_PUBLIC_CHECK, null) }, use(policy));
  } catch (e) {
    return Object.assign({ configured: true, error: 'unreachable', helpers: [], online: 0, public_check: store.getMeta(META_PUBLIC_CHECK, null) }, use(null));
  }
}

async function checkPublicUrl(store, url, opts = {}) {
  const cfg = s3mem.usingMeta(store).get();
  if (!url) return null;
  let r;
  if (!cfg || !cfg.enabled) {
    r = { ok: true, by: 'local', why: 'not_configured', result: await (opts.checkEndpoint || checkEndpoint)(url) };
  } else {
    r = await runJob(cfg, 'endpoint.check', { url }, Object.assign({ from: 'school-server' }, opts));
  }
  const rec = Object.assign({ url, by: r.by, why: r.why || null, at: new Date().toISOString() }, r.result || { reachable: false, error: r.error });
  store.setMeta(META_PUBLIC_CHECK, rec);
  return rec;
}

function start(store, { everyMs = 30 * 60_000, publicUrl = () => null, log = (m) => console.log(m) } = {}) {
  if (timer) return;
  const tick = async () => {
    const url = publicUrl();
    if (!url) return;
    try {
      const r = await checkPublicUrl(store, url);
      if (r) log('[helper] بررسی بیرونی آدرس عمومی: ' + (r.reachable ? 'در دسترس' : 'در دسترس نیست') + ' (' + (r.by === 'local' ? 'محلی' : 'سرور کمکی ' + r.by) + ')');
    } catch (e) { /* دفعهٔ بعد */ }
  };
  setTimeout(tick, 60_000).unref();
  timer = setInterval(tick, everyMs);
  timer.unref();
  /* ردیف ۱۵۳: مسیر بار هر ۵ ثانیه تازه می‌شود (بالا/پایین رفتن حتی بدون کار تازه؛ سنجه‌های /metrics) */
  routeTimer = setInterval(async () => {
    try {
      const cfg = s3mem.usingMeta(store).get();
      const policy = cfg && cfg.enabled ? await readPolicy(cfg) : null;
      await routeNow(policy, { busy: busyNow() });
    } catch (e) { /* گام بعد */ }
  }, ROUTE_TICK_MS);
  routeTimer.unref();
}

module.exports = {
  K, DIR, KINDS, SALT: SALT.toString('utf8'), PRESENCE_FRESH_MS, CLAIM_WAIT_MS, GC_JOB_AGE_MS,
  HelperError, seal, open, keyFor, newJobId, jobAt, isPublicIp, validParams,
  helpersOnline, runLocal, runJob, checkEndpoint, status, checkPublicUrl, start, listAll,
  POLICY_KEY, readPolicy, writePolicy, validPolicy, helperNeed, busyNow, routeNow, helperOff,
  _resetPolicyCache: () => { policyCache = { key: '', at: 0, value: null }; },
};
