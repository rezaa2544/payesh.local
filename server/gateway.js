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

const startedAt = Date.now();
let pool = null;
let enabled = false;

if (PGURL && SECRET.length >= 16) {
  tenancy.init({ connectionString: PGURL, secret: SECRET });
  pool = tenancy.getPool();
  enabled = !!pool;
}

function json(res, status, body, extraHeaders = {}) {
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
  const d = String(headers['x-device-id'] || '').trim();
  return d ? d.slice(0, 80) : 'unknown';
}

async function handle(req, res, url) {
  const m = String(req.method || 'GET').toUpperCase();
  const p = url.pathname;

  /* ── متریک (ردیف ۴۹): همان قالب مدرسه، برای scrape یکسان ───────────── */
  if (p === '/metrics' && (m === 'GET' || m === 'HEAD')) {
    const body = await mreg.render();
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store', 'x-gateway-instance': INSTANCE });
    res.end(m === 'HEAD' ? '' : body);
    return;
  }

  /* ── زنده‌بودن: هیچ وابستگی‌ای جز خود فرایند ندارد ─────────────────── */
  if (p === '/healthz') {
    return json(res, 200, { ok: true, instance: INSTANCE, cell: CELL || null, uptime_s: Math.round((Date.now() - startedAt) / 1000), pid: process.pid });
  }

  /* ── آمادگی واقعی: اتصال DB + رفتار درست set_config(...,true) ─────── */
  if (p === '/readyz') {
    if (!enabled) return json(res, 503, { ok: false, instance: INSTANCE, error: 'not_configured' });
    try {
      const r = await tenancy.readiness(pool);
      const ok = r.ok && r.tenant_scoped && !r.leaked_after_commit;
      return json(res, ok ? 200 : 503, Object.assign({ instance: INSTANCE, cell: CELL || null }, r, { ok }));
    } catch (e) {
      return json(res, 503, { ok: false, instance: INSTANCE, error: 'db_unavailable', detail: String(e.message || e).slice(0, 120) });
    }
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
    return json(res, 429, { ok: false, error: 'rate_limited', retry_after_ms: quota.retry_after_ms, limit: quota.max }, quotaHeaders);
  }

  /* ── pull: یک کوئری ایندکس‌دار روی change-feed ─────────────────────── */
  if (p === '/api/gw/v1/pull' && m === 'GET') {
    const sinceSeq = Number(url.searchParams.get('since_seq') || 0);
    const wantLimit = Number(url.searchParams.get('limit') || 200);
    const limit = Math.max(1, Math.min(PULL_MAX, Number.isFinite(wantLimit) ? wantLimit : 200));
    try {
      /* اسکوپ نقش سمت سرور (ردیف ۳۸): scope فقط از claims توکن؛
         هر مقدار scope در query/هدر/بدنه نادیده گرفته می‌شود. */
      const out = await tenancy.listFeed(pool, tenantId, {
        sinceSeq, collection: url.searchParams.get('collection'), limit, claims,
      });
      return json(res, 200, Object.assign({ ok: true, schema_version: 1, instance: INSTANCE, clamped_limit: limit }, out,
        { limits: { max_limit: PULL_MAX, default_limit: 200 } }), quotaHeaders);
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
      const out = await tenancy.applyOps(pool, tenantId, { ops, device_id: deviceId, claims });
      return json(res, 200, Object.assign({ ok: true, schema_version: 1, instance: INSTANCE }, out), quotaHeaders);
    } catch (e) {
      return json(res, e.status || 500, { ok: false, error: e.code || 'push_failed', detail: e.details || null }, quotaHeaders);
    }
  }

  return json(res, 404, { ok: false, error: 'not_found' });
}

const server = http.createServer((req, res) => {
  res.on('finish', () => { try { mreg.observeHttp(res.statusCode); } catch (e) { /* noop */ } });
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  handle(req, res, url).catch((e) => json(res, 500, { ok: false, error: 'gateway_error', detail: String(e.message || e).slice(0, 120) }));
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(JSON.stringify({ event: 'gateway_listening', instance: INSTANCE, port: PORT, host: HOST, configured: enabled }));
  });
}

module.exports = { server, handle, INSTANCE, PORT, mreg };
