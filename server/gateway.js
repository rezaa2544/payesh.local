'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Gateway نازک و بی‌حالت — ردیف ۳۷

   زنجیرهٔ هر درخواست: احراز (توکن امضاشده) → tenant از نشست → set_config
   تراکنش‌محور → RLS → endpointهای sync (pull از change-feed، push دسته‌ای).

   قواعد سخت:
   ۱) هیچ وضعیت نشستی در حافظهٔ نمونه نیست: هر نمونه می‌تواند هر درخواستی
      را در هر لحظه سرو کند (idempotency و سهمیه در دیتابیس‌اند).
   ۲) tenant فقط از توکن؛ هدر X-Tenant یا فیلد بدنه هیچ اثری ندارد.
   ۳) سقف‌ها پیش از لمس دیتابیس اعمال می‌شوند: اندازهٔ بدنه، تعداد عملیات،
      اندازهٔ هر عملیات، سقف ردیف pull، سهمیهٔ نرخ هر مستأجر/دستگاه.
   ۴) /healthz = زنده‌بودن فرایند · /readyz = آمادگی واقعی (DB + رفتار درست
      set_config)؛ اگر DB در دسترس نباشد readyz باید 503 بدهد.

   اجرا:  PGURL=... GW_SECRET=... PORT=5660 node server/gateway.js
   ═══════════════════════════════════════════════════════════════════ */
const http = require('node:http');
const tenancy = require('./tenancy');
const metrics = require('./metrics');
/* ردیف ۹۷ (PR-2): API پلتفرم پشت همین Gateway سرو می‌شود، ولی احراز،
   توکن، نقش و pool آن کاملاً جدا از احراز مدرسه است. هیچ URL/توکن/رازی
   در کد hard-code نشده؛ نبود تنظیم ⇒ 503 not_configured (fail-closed). */
const platformApiModule = require('../apps/owner-panel/server/platform-api');
/* row 64: native API version policy (N-1/N-2 window, 426 upgrade_required) */
const apiVersion = require('./api-version');
/* row 66: public Directory bootstrap (school code → cell URL), central DB only */
const directory = require('./directory');
const directoryApiModule = require('./directory-api');
/* row 67: per-feature kill-switch (per-version one is in api-version.js) */
const killSwitch = require('./kill-switch');
const crypto = require('node:crypto');
const logger = require('./logger'); /* row 85: PII detector for caller-supplied request ids */

const PORT = Number(process.env.PORT || 5660);
const HOST = process.env.HOST || '0.0.0.0';
const PGURL = process.env.PGURL || '';
const SECRET = process.env.GW_SECRET || process.env.PAYESH_TENANCY_SECRET || '';
const MAX_BODY = Number(process.env.GW_MAX_BODY || 1024 * 1024);     /* ۱MiB */
const QUOTA_MAX = Number(process.env.GW_QUOTA_MAX || 120);           /* درخواست در پنجره */
const QUOTA_WINDOW = Number(process.env.GW_QUOTA_WINDOW_SEC || 60);
const PULL_MAX = Number(process.env.GW_PULL_MAX || 1000);
const INSTANCE = process.env.GW_INSTANCE || ('gw-' + process.pid);
/* شناسهٔ cell (ردیف ۴۳): اگر تنظیم شود، Gateway فقط توکنِ همین cell را
   می‌پذیرد. خالی ⇒ رفتار تک‌cell ردیف ۳۷ بدون تغییر. */
const CELL = String(process.env.GW_CELL || '').trim();

/* ردیف ۵۲: replica فقط‌خواندنی اختیاری. اگر تنظیم نشود (پیش‌فرض)، همهٔ
   خواندن‌ها روی primary می‌مانند — همان تصمیمی که شاهد ردیف ۴۶ پشتیبانی کرد. */
const REPLICA_URL = String(process.env.PAYESH_PG_REPLICA_URL || '').trim();
/* ردیف ۵۴: توقف نوشتن هنگام انتقال مدرسه بین دیتابیس‌ها. تا وقتی ابزار
   انتقال فعال نشده، هیچ کوئری اضافه‌ای زده نمی‌شود. */
const TRANSFER_ON = String(process.env.PAYESH_CELL_TRANSFER_ENABLED || '') === '1';
/* اتصال و راز اختصاصی پنل مالک؛ اشتراک pool مدرسه با پلتفرم ممنوع است. */
const PLATFORM_PGURL = String(process.env.PAYESH_PLATFORM_PGURL || '').trim();
const PLATFORM_SECRET = String(process.env.PAYESH_PLATFORM_TOKEN_SECRET || '').trim();
const PLATFORM_RATE_MAX = Number(process.env.PAYESH_PLATFORM_RATE_MAX || 120);
const PLATFORM_RATE_WINDOW = Number(process.env.PAYESH_PLATFORM_RATE_WINDOW_SEC || 60);
/* row 67: graceful drain, request-id, access log, tenant-wide quota */
const DRAIN_TIMEOUT_MS = Math.max(100, Number(process.env.GW_DRAIN_TIMEOUT_MS || 25000));
const ACCESS_LOG = String(process.env.GW_ACCESS_LOG || '1') !== '0';
const TENANT_QUOTA_MAX = Number(process.env.GW_TENANT_QUOTA_MAX || 0);   /* 0 = off */
const TENANT_BUCKET = '__tenant__';
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,64}$/;
let draining = false;
const inflight = new Set();
const startedAt = Date.now();
let pool = null;
let enabled = false;
let replicaPool = null;
/* آخرین seq نوشته‌شده توسط هر دستگاه (در حافظهٔ همین نمونه) — پایهٔ ناوردای
   read-your-writes: دستگاه نوشته‌های خودش را همیشه می‌بیند. */
const ownWriteSeq = new Map();
const OWN_WRITE_CAP = 5000;

function noteOwnWrite(deviceId, seq) {
  const id = String(deviceId || '').slice(0, 64);
  const s = Number(seq);
  if (!id || !Number.isFinite(s) || s <= 0) return;
  const prev = ownWriteSeq.get(id) || 0;
  if (s > prev) ownWriteSeq.set(id, s);
  if (ownWriteSeq.size > OWN_WRITE_CAP) {
    /* ساده و قابل پیش‌بینی: قدیمی‌ترین کلیدها حذف می‌شوند */
    const it = ownWriteSeq.keys();
    for (let i = 0; i < 500 && ownWriteSeq.size > OWN_WRITE_CAP; i++) ownWriteSeq.delete(it.next().value);
  }
}

if (PGURL && SECRET.length >= 16) {
  tenancy.init({ connectionString: PGURL, secret: SECRET });
  pool = tenancy.getPool();
  enabled = !!pool;
}
if (REPLICA_URL) {
  const { Pool } = require('pg');
  replicaPool = new Pool({
    connectionString: REPLICA_URL, max: 2,
    application_name: 'payesh-gateway-replica', statement_timeout: 5000,
  });
  replicaPool.on('error', () => { /* اتصال مردهٔ replica سرویس را نمی‌کشد */ });
}

/* pool جداگانهٔ پلتفرم. انتظار میرود لاگین آن payesh_platform_runtime باشد
   (یا عضو آن)؛ هیچ grant مستقیمی از سوی نقش مدرسه به جداول پلتفرم داده
   نمیشود. بدون PAYESH_PLATFORM_PGURL، مسیرهای پلتفرم پیکربندینشدهاند. */
let platformPool = null;
if (PLATFORM_PGURL) {
  const { Pool } = require('pg');
  platformPool = new Pool({
    connectionString: PLATFORM_PGURL, max: 4,
    application_name: 'payesh-owner-platform', statement_timeout: 5000,
  });
  platformPool.on('error', () => { /* خرابی pool پلتفرم، Gateway مدرسه را نمیکشد */ });
}
/* row 66: the Directory lives in the central database (never a cell's tenant DB).
   Without PAYESH_DIRECTORY_PGURL the resolve endpoint answers 503 not_configured. */
const DIRECTORY_PGURL = String(process.env.PAYESH_DIRECTORY_PGURL || '').trim();
let directoryResolver = null;
if (DIRECTORY_PGURL) {
  const { Pool } = require('pg');
  const directoryPool = new Pool({
    connectionString: DIRECTORY_PGURL, max: 2,
    application_name: 'payesh-directory', statement_timeout: 3000,
  });
  directoryPool.on('error', () => { /* a dead directory connection must not kill the gateway */ });
  directoryResolver = directory.createResolver(directoryPool);
}
const directoryApi = directoryApiModule.createDirectoryApi({ resolver: directoryResolver });

const platformApi = platformApiModule.createPlatformApi({
  db: platformApiModule.createPgAdapter(platformPool),
  secret: PLATFORM_SECRET,
  rateLimitMax: PLATFORM_RATE_MAX,
  rateLimitWindowSec: PLATFORM_RATE_WINDOW,
  instance: INSTANCE,
});

/* تصمیم مقصد خواندن (ردیف ۵۲). replica فقط اگر واقعاً تازه باشد استفاده
   می‌شود؛ و اگر دستگاه نوشته‌ای دارد که replica ندیده ⇒ primary. */
async function readSource(deviceId, tenantId) {
  if (!replicaPool || !enabled) return { pool, decision: { target: 'primary', reason: replicaPool ? 'disabled' : 'no_replica_configured', fallback: false } };
  const ownSeq = ownWriteSeq.get(String(deviceId || '').slice(0, 64)) || 0;
  let lagMs = null, replicaSeq = null;
  try {
    lagMs = await tenancy.replicaPolicy.measureLagMs({
      primaryQuery: q => pool.query(q), replicaQuery: q => replicaPool.query(q),
    });
    const rs = await replicaPool.query('select max(seq)::bigint as seq from product_change_feed');
    replicaSeq = rs.rows[0] && rs.rows[0].seq !== null ? Number(rs.rows[0].seq) : null;
  } catch (e) { lagMs = null; replicaSeq = null; }
  const decision = tenancy.replicaPolicy.chooseReadTarget({ replica_url: REPLICA_URL, lag_ms: lagMs, own_write_seq: ownSeq, replica_seq: replicaSeq });
  return { pool: decision.target === 'replica' ? replicaPool : pool, decision };
}

function json(res, status, body, extraHeaders = {}) {
  /* row 67: the request id travels in the X-Request-Id header of EVERY response
     (set in the server callback); bodies stay unchanged so contract schemas and
     the uniform-404 rule (identical bodies) keep holding. */
  if (draining && !res.headersSent) extraHeaders = Object.assign({ connection: 'close' }, extraHeaders);
  const payload = JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-gateway-instance': INSTANCE,
  }, extraHeaders));
  res.end(payload);
}

/* ═══════════ ردیف ۴۹ — متریک نمونهٔ Gateway ═════════════════════════
   «pool-wait» و «اتصال DB» فقط اینجا معنا دارند: در Gateway است که چند
   نمونه به یک PostgreSQL وصل می‌شوند. /metrics اینجا همان قالب متن
   Prometheus را می‌دهد تا یک Prometheus، مدرسه و ابر را با هم scrape کند.

   صداقت عدد: صف انتظار pool از شمارندهٔ واقعی driver خوانده می‌شود و
   زمان انتظار، اندازه‌گیریِ همان acquire در مسیر quota است — نه تخمین. */
const mreg = metrics.create();

mreg.onCollect(() => {
  const out = [];
  const add = (name, value, help, labels = {}) => out.push({ name, type: 'gauge', help, labels, value });
  add('payesh_up', 1, 'نمونهٔ Gateway زنده است');
  add('payesh_gateway_configured', enabled ? 1 : 0, 'Gateway به PostgreSQL و کلید امضا تنظیم شده است');
  add('payesh_uptime_seconds', Math.round((Date.now() - startedAt) / 1000), 'مدت زنده‌بودن نمونه به ثانیه');
  if (pool) {
    add('payesh_pg_pool_total', Number(pool.totalCount) || 0, 'تعداد کل اتصال‌های pool');
    add('payesh_pg_pool_idle', Number(pool.idleCount) || 0, 'اتصال‌های بی‌کار pool');
    /* ردیف ۴۵: انتظار واقعی pool روی همهٔ گرفتن‌های اتصال (نه فقط لحظهٔ scrape) */
    const w = tenancy.poolWaitSnapshot();
    add('payesh_pg_pool_acquire_events_total', w.events, 'تعداد گرفتن اتصال از pool');
    add('payesh_pg_pool_acquire_mean_ms', w.mean_ms, 'میانگین انتظار pool (میلی‌ثانیه)');
    add('payesh_pg_pool_acquire_max_ms', w.max_ms, 'بیشینهٔ انتظار pool (میلی‌ثانیه)');
    add('payesh_pg_pool_acquire_over_1s_total', w.over_1000ms, 'گرفتن اتصال با انتظار بیش از ۱ ثانیه');
  }
  return out;
});

/* اتصال‌های واقعیِ DB و آمادگی، با یک کوئری سبک در هر scrape. */
mreg.onCollect(() => {
  const out = [];
  if (!enabled || !pool) return out;
  /* این جمع‌بندی وضعیت است، نه دادهٔ مستأجر: RLS روی جدول‌های محصول اعمال
     می‌شود و pg_stat_activity فقط شمارش اتصال است. */
  const p = tenancy.poolSnapshot(pool);
  return p.then(snap => {
    out.push({ name: 'payesh_db_connections', type: 'gauge', help: 'اتصال‌های فعال به PostgreSQL از دید pg_stat_activity', labels: {}, value: snap.connections });
    out.push({ name: 'payesh_pg_pool_wait_seconds', type: 'gauge', help: 'مدت گرفتن یک اتصال از pool در همین scrape (ثانیه)', labels: {}, value: snap.wait_ms / 1000 });
    out.push({ name: 'payesh_db_up', type: 'gauge', help: 'PostgreSQL قابل دسترس است', labels: {}, value: snap.ok ? 1 : 0 });
    out.push({ name: 'payesh_ready', type: 'gauge', help: 'آمادگی واقعی Gateway (DB + رفتار درست set_config)', labels: {}, value: snap.ready ? 1 : 0 });
    return out;
  }).catch(() => {
    out.push({ name: 'payesh_db_up', type: 'gauge', help: 'PostgreSQL قابل دسترس است', labels: {}, value: 0 });
    out.push({ name: 'payesh_ready', type: 'gauge', help: 'آمادگی واقعی Gateway (DB + رفتار درست set_config)', labels: {}, value: 0 });
    return out;
  });
});

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        /* به‌جای قطع سوکت، بدنهٔ اضافی را تخلیه می‌کنیم تا پاسخ ۴۱۳ واقعاً به
           کلاینت برسد (قطع سوکت در HTTP/1.1 به خطای شبکه در کلاینت تبدیل می‌شود). */
        chunks.length = 0;
        req.removeAllListeners('data');
        req.resume();
        reject(Object.assign(new Error('body_too_large'), { code: 'body_too_large', status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(Object.assign(new Error('bad_json'), { code: 'bad_json', status: 400 })); }
    });
    req.on('error', reject);
  });
}

function bearer(headers) {
  const h = String(headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

function deviceOf(headers) {
  let d = String(headers['x-device-id'] || '').trim();
  /* the tenant-wide quota bucket name can never be claimed by a device */
  if (d.startsWith('__')) d = 'x' + d;
  return d ? d.slice(0, 80) : 'unknown';
}

/* row 67: accept a well-formed caller id (end-to-end tracing), else mint one */
function requestIdOf(headers) {
  const h = String(headers['x-request-id'] || '').trim();
  /* row 85: an id that looks like PII (phone, national code…) is replaced too */
  return REQUEST_ID_RE.test(h) && logger.scanPii(h).length === 0 ? h : crypto.randomUUID();
}

function retryAfterSec(ms) { return String(Math.max(1, Math.ceil(Number(ms || 0) / 1000))); }

/* ── متریک (ردیف ۴۹): همان قالب مدرسه، برای scrape یکسان ─────────────
   ردیف ۵۷ (S4): اگر PAYESH_METRICS_TOKEN تنظیم شود، scrape بدون توکن
   ۴۰۱ می‌گیرد — درست مثل سرور محصول. (پیش‌فرض: باز، چون فقط شمارشِ
   بی‌هویت است؛ ابزارهای بار/پایش داخلی بدون توکن کار می‌کنند.) */
const METRICS_TOKEN = String(process.env.PAYESH_METRICS_TOKEN || '');
function metricsAllowed(req, url) {
  if (!METRICS_TOKEN) return true;
  const h = String(req.headers.authorization || '');
  if (h === 'Bearer ' + METRICS_TOKEN) return true;
  return url.searchParams.get('token') === METRICS_TOKEN;
}
async function handle(req, res, url) {
  const m = String(req.method || 'GET').toUpperCase();
  const p = url.pathname;

  if (p === '/metrics' && (m === 'GET' || m === 'HEAD')) {
    if (!metricsAllowed(req, url)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('unauthorized\n');
      return;
    }
    const body = await mreg.render();
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store', 'x-gateway-instance': INSTANCE });
    res.end(m === 'HEAD' ? '' : body);
    return;
  }

  /* ── زنده‌بودن: هیچ وابستگی‌ای جز خود فرایند ندارد ─────────────────── */
  if (p === '/healthz') {
    const ks = killSwitch.config();
    return json(res, 200, { ok: true, instance: INSTANCE, cell: CELL || null, uptime_s: Math.round((Date.now() - startedAt) / 1000), pid: process.pid,
      draining, kill_switch: { features: ks.rules.map(r => r.feature + (r.version ? '@' + (r.op === 'lt' ? '<' : '') + r.version.join('.') : '')), invalid: ks.invalid } });
  }

  /* ── آمادگی واقعی: اتصال DB + رفتار درست set_config(...,true) ─────── */
  if (p === '/readyz') {
    /* row 67: a draining instance must leave the load balancer at once */
    if (draining) return json(res, 503, { ok: false, instance: INSTANCE, error: 'draining' }, { 'retry-after': '1' });
    if (!enabled) return json(res, 503, { ok: false, instance: INSTANCE, error: 'not_configured' });
    try {
      const r = await tenancy.readiness(pool);
      const ok = r.ok && r.tenant_scoped && !r.leaked_after_commit;
      return json(res, ok ? 200 : 503, Object.assign({ instance: INSTANCE, cell: CELL || null }, r, { ok }));
    } catch (e) {
      return json(res, 503, { ok: false, instance: INSTANCE, error: 'db_unavailable', detail: String(e.message || e).slice(0, 120) });
    }
  }

  /* ── ردیف ۹۷: namespace مستقل پلتفرم، پیش از احراز مدرسه ─────────────
     مسیرهای /api/platform/v1 هرگز وارد زنجیرهٔ verifyToken مدرسه نمیشوند و
     توکن مدرسه هم توسط verifyPlatformToken ساختاراً رد میشود. */
  if (p === '/api/platform/v1' || p.startsWith('/api/platform/v1/')) {
    const killedPlatform = killSwitch.check(p, req.headers);
    if (killedPlatform) return json(res, killedPlatform.status, killedPlatform.body, killedPlatform.headers);
    return platformApi.handle(req, res, url);
  }

  /* ── row 64: version policy for native clients, before auth and DB ─── */
  const verdict = apiVersion.check(p, req.headers);
  if (verdict) return json(res, verdict.status, verdict.body, verdict.headers);
  if (req.headers['x-payesh-client']) {
    for (const [k, v] of Object.entries(apiVersion.responseHeaders())) res.setHeader(k, v);
  }
  /* ── row 67: per-feature kill-switch, before auth and DB ───────────── */
  const killed = killSwitch.check(p, req.headers);
  if (killed) return json(res, killed.status, killed.body, killed.headers);

  /* ── row 66: public Directory resolve (no token, no tenant data) ────── */
  if (p === '/api/dir/v1/resolve' && m === 'GET') {
    return directoryApi(req, res, url, json);
  }

  if (!enabled) return json(res, 503, { ok: false, error: 'not_configured' });

  /* ── احراز: توکن امضاشده؛ tenant فقط از نشست ───────────────────────── */
  let claims;
  try { claims = tenancy.verifyToken(bearer(req.headers), SECRET); }
  catch (e) { return json(res, e.status || 401, { ok: false, error: e.code || 'unauthorized' }); }
  /* ── اتصال توکن به cell (ردیف ۴۳) ──────────────────────────────────── */
  if (CELL) {
    if (!claims.cell) return json(res, 403, { ok: false, error: 'missing_cell', cell: CELL });
    if (String(claims.cell).toLowerCase() !== CELL.toLowerCase()) {
      return json(res, 403, { ok: false, error: 'wrong_cell', cell: CELL });
    }
  }
  const tenantId = claims.tid;
  /* row 85: the access log names the school (tenant id from the signed token) */
  res.__school = tenantId || null;
  const deviceId = deviceOf(req.headers);
  /* نقش/کاربر فقط از توکن — هیچ سرآیند یا فیلدی آن را تعیین نمی‌کند */

  /* ── سهمیهٔ نرخ (مشترک بین نمونه‌ها، در دیتابیس) ───────────────────── */
  let quota;
  try { quota = await tenancy.takeQuota(pool, tenantId, { deviceId, max: QUOTA_MAX, windowSec: QUOTA_WINDOW }); }
  catch (e) { return json(res, 503, { ok: false, error: 'quota_unavailable' }); }
  const quotaHeaders = {
    'x-ratelimit-limit': String(quota.max),
    'x-ratelimit-remaining': String(quota.remaining),
    'x-ratelimit-window-sec': String(quota.window_sec),
  };
  if (!quota.allowed) {
    return json(res, 429, { ok: false, error: 'rate_limited', scope: 'device', retry_after_ms: quota.retry_after_ms, limit: quota.max },
      Object.assign({ 'retry-after': retryAfterSec(quota.retry_after_ms) }, quotaHeaders));
  }
  /* row 67: optional tenant-wide ceiling on top of the per-device bucket, so many
     devices of one school cannot starve the shared pool. Same DB table, reserved key. */
  if (TENANT_QUOTA_MAX > 0) {
    let tq;
    try { tq = await tenancy.takeQuota(pool, tenantId, { deviceId: TENANT_BUCKET, max: TENANT_QUOTA_MAX, windowSec: QUOTA_WINDOW }); }
    catch (e) { return json(res, 503, { ok: false, error: 'quota_unavailable' }); }
    if (!tq.allowed) {
      return json(res, 429, { ok: false, error: 'rate_limited', scope: 'tenant', retry_after_ms: tq.retry_after_ms, limit: tq.max },
        Object.assign({ 'retry-after': retryAfterSec(tq.retry_after_ms) }, quotaHeaders));
    }
  }

  /* ── pull: یک کوئری ایندکس‌دار روی change-feed ─────────────────────── */
  if (p === '/api/gw/v1/pull' && m === 'GET') {
    const sinceSeq = Number(url.searchParams.get('since_seq') || 0);
    const wantLimit = Number(url.searchParams.get('limit') || 200);
    const limit = Math.max(1, Math.min(PULL_MAX, Number.isFinite(wantLimit) ? wantLimit : 200));
    try {
      /* اسکوپ نقش سمت سرور (ردیف ۳۸): scope فقط از claims توکن؛
         هر مقدار scope در query/هدر/بدنه نادیده گرفته می‌شود. */
      const src = await readSource(deviceId, tenantId);
      const out = await tenancy.listFeed(src.pool, tenantId, {
        sinceSeq, collection: url.searchParams.get('collection'), limit, claims,
      });
      return json(res, 200, Object.assign({ ok: true, schema_version: 1, instance: INSTANCE, clamped_limit: limit }, out,
        { limits: { max_limit: PULL_MAX, default_limit: 200 }, read_from: src.decision.target, read_reason: src.decision.reason }),
        quotaHeaders);
    } catch (e) {
      return json(res, e.status || 500, { ok: false, error: e.code || 'pull_failed', detail: e.details || null }, quotaHeaders);
    }
  }

  /* ── push: دستهٔ عملیات، اتمی، idempotent، با سقف‌ها ────────────────── */
  if (p === '/api/gw/v1/push' && m === 'POST') {
    let body;
    try { body = await readBody(req, MAX_BODY); }
    catch (e) {
      return json(res, e.status || 400, { ok: false, error: e.code || 'bad_request', limit: MAX_BODY },
        Object.assign({ connection: 'close' }, quotaHeaders));
    }
    const ops = Array.isArray(body && body.ops) ? body.ops : null;
    if (!ops) return json(res, 400, { ok: false, error: 'bad_ops' }, quotaHeaders);
    if (ops.length > tenancy.MAX_OPS_PER_REQUEST) {
      return json(res, 413, { ok: false, error: 'too_many_ops', limit: tenancy.MAX_OPS_PER_REQUEST }, quotaHeaders);
    }
    try {
      if (TRANSFER_ON && await tenancy.transfer.isFrozen(pool, tenantId)) {
        return json(res, 409, { ok: false, error: 'write_frozen', detail: 'tenant is being transferred' }, quotaHeaders);
      }
      const out = await tenancy.applyOps(pool, tenantId, { ops, device_id: deviceId, claims });
      /* ناوردای read-your-writes: بزرگ‌ترین seq این دستگاه ثبت می‌شود.
         فقط وقتی replica وجود دارد لازم است (بدون replica همه‌چیز primary است). */
      if (REPLICA_URL) {
        try { noteOwnWrite(deviceId, await tenancy.maxFeedSeq(pool, tenantId)); } catch (e) { /* ثبت نشد = بدبینانه: خواندن از primary */ }
      }
      return json(res, 200, Object.assign({ ok: true, schema_version: 1, instance: INSTANCE }, out), quotaHeaders);
    } catch (e) {
      return json(res, e.status || 500, { ok: false, error: e.code || 'push_failed', detail: e.details || null }, quotaHeaders);
    }
  }

  return json(res, 404, { ok: false, error: 'not_found' });
}

function logLine(obj) {
  try { process.stdout.write(JSON.stringify(Object.assign({ ts: new Date().toISOString(), instance: INSTANCE }, obj)) + '\n'); } catch (e) { /* noop */ }
}

const server = http.createServer((req, res) => {
  const t0 = process.hrtime.bigint();
  const rid = requestIdOf(req.headers);
  res.__rid = rid;
  res.setHeader('x-request-id', rid);
  inflight.add(res);
  res.on('close', () => inflight.delete(res));
  res.on('finish', () => {
    inflight.delete(res);
    try { mreg.observeHttp(res.statusCode, Date.now(), Number(process.hrtime.bigint() - t0) / 1e6); } catch (e) { /* noop */ }
    /* access log: path only (never the query string — /metrics?token=…) and no body */
    if (ACCESS_LOG) {
      const pathOnly = String(req.url || '').split('?')[0].slice(0, 120);
      logLine({ event: 'http', request_id: rid, school_id: res.__school || null, method: req.method, path: pathOnly, status: res.statusCode,
        ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10 });
    }
    if (draining) server.closeIdleConnections();
  });
  /* row 67: requests that reach a draining instance on a kept-alive socket */
  if (draining) {
    return json(res, 503, { ok: false, error: 'draining' }, { 'retry-after': '1' });
  }
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  handle(req, res, url).catch((e) => json(res, 500, { ok: false, error: 'gateway_error', detail: String(e.message || e).slice(0, 120) }));
});

/* ═══════════ row 67 — graceful drain on SIGTERM/SIGINT ══════════════
   1) stop accepting (server.close) and fail /readyz so the balancer stops routing;
   2) let in-flight requests finish (their responses carry connection: close);
   3) close DB pools and exit 0 — or, after GW_DRAIN_TIMEOUT_MS, cut the remaining
      sockets and exit 2 so the orchestrator can tell a forced stop apart. */
let drainDone = false;
function drain(signal) {
  if (draining) return;
  draining = true;
  logLine({ event: 'drain_start', signal, inflight: inflight.size, timeout_ms: DRAIN_TIMEOUT_MS });
  const finish = async (reason) => {
    if (drainDone) return;
    drainDone = true;
    clearTimeout(timer);
    const closers = [];
    try { closers.push(Promise.resolve(tenancy.close && tenancy.close())); } catch (e) { /* noop */ }
    for (const pl of [replicaPool, platformPool]) { if (pl) closers.push(pl.end().catch(() => {})); }
    await Promise.race([Promise.allSettled(closers), new Promise(r => setTimeout(r, 2000))]);
    logLine({ event: 'drain_done', reason, inflight: inflight.size });
    process.exit(reason === 'drained' ? 0 : 2);
  };
  const timer = setTimeout(() => {
    logLine({ event: 'drain_timeout', inflight: inflight.size });
    try { server.closeAllConnections(); } catch (e) { /* noop */ }
    finish('timeout');
  }, DRAIN_TIMEOUT_MS);
  for (const r of inflight) { if (!r.headersSent) { try { r.setHeader('connection', 'close'); } catch (e) { /* noop */ } } }
  server.close(() => finish('drained'));
  server.closeIdleConnections();
}

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    logLine({ event: 'gateway_listening', port: PORT, host: HOST, configured: enabled });
  });
  process.on('SIGTERM', () => drain('SIGTERM'));
  process.on('SIGINT', () => drain('SIGINT'));
}

module.exports = { server, handle, drain, requestIdOf, INSTANCE, PORT, mreg, platformApi };
