'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۱۶۷ — یک سرور پایش، همهٔ مدارس پنل مالک
   ───────────────────────────────────────────────────────────────────
   درخواست مالک (۱۴۰۵/۰۸/۲۶): «یه مدرسه جدید تعریف کردم ولی وصل می‌شه و می‌گه سرور
   تعریف نشده. سرور باید خودش اتوماتیک برای هر مدرسهٔ جدید — همهٔ مدرسه‌ها — وصل بشه
   (مثل آینده‌سازان که وصله).»

   تا امروز هر سرور پایش فقط «یک» مدرسه داشت (schools:bound، همه‌جا school_id=1):
   مدرسهٔ دوم پنل مالک سروری نداشت و ورود مدیرش روی همان رایانه «نام کاربری یا رمز
   درست نیست» / «سرور راه‌اندازی نشده» می‌گرفت.

   طرح: سرور اصلی (همان که آینده‌سازان را دارد) برای هر مدرسهٔ دیگر فهرست مالک یک
   «سرور مدرسهٔ میزبانی‌شده» بالا می‌آورد — همان server/index.js، در یک فرایند جدا، با
   پوشهٔ دادهٔ جدا (DATA_DIR/hosted/<id>) و فقط روی 127.0.0.1. پس:
     • دادهٔ هر مدرسه کاملاً جداست (پایگاه، پشتیبان، آینه، کلید امضا)؛ هیچ کدی میان
       مدارس مشترک نمی‌شود و هیچ تغییری در منطق تک‌مدرسه‌ای سرور لازم نیست؛
     • در دیتابیس (صندوقچه) دادهٔ هر مدرسه زیر <prefix>h/<id>/ است؛ پرونده‌های مشترک
       مالک (فهرست مدارس، پرداخت‌ها، رسیدها، پشتیبانی) همان <prefix> اصلی؛
     • همهٔ برنامه‌ها همان یک نشانی را دارند (شبکهٔ محلی، تونل، فهرست نشانی‌ها): سرور
       اصلی هر درخواست را به سرور مدرسهٔ همان کاربر می‌رساند:
         – درخواست با نشست (Bearer): نشست مال کدام سرور است (اصلی، وگرنه از هر سرور
           میزبانی‌شده می‌پرسیم و نتیجه را نگه می‌داریم)؛
         – ورود و بقیهٔ درهای بی‌نشست (refresh، کد پیوند، پیامک، تیکت گوشی، بازگشت
           درگاه): اول سرور اصلی؛ اگر «این کاربر/کد را نمی‌شناسم» گفت، سرورهای دیگر.
   سرور میزبانی‌شده هیچ درخواستی را بدون کلید همین فرایند (سرآیند x-payesh-hosted-key)
   نمی‌پذیرد؛ «از خود رایانه بودن» را هم فقط سرور اصلی تعیین می‌کند (کاربر بیرونی هرگز
   از راه سرور اصلی «محلی» حساب نمی‌شود).

   مدرسه‌ای که سرور دیگری (رسید schools/ack تازه از نمونهٔ دیگر) میزبانش است دست
   نمی‌خورد (همان قاعدهٔ adoptOnLogin: هر رسیدی از نمونهٔ دیگر)؛ مدرسهٔ غیرفعال هم سرور
   تازه نمی‌گیرد.
   ═══════════════════════════════════════════════════════════════════ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const H_KEY = 'x-payesh-hosted-key';
const H_LOCAL = 'x-payesh-hosted-local';
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL_META = 'hosted:control';
const LIST_META = 'hosting:schools';
const SYNC_MS = 60_000;
const READY_MS = 45_000;
/* درهای بی‌نشستی که «کاربر/کد این مدرسه» را در بدنه دارند */
const FALLBACK = new Set([
  'POST /api/auth/login', 'POST /api/auth/refresh', 'POST /api/auth/pair', 'POST /api/auth/transfer/redeem',
  'POST /api/auth/otp/request', 'POST /api/auth/otp/verify', 'POST /api/auth/unlock',
  'POST /api/phone/login', 'POST /api/phone/ticket', 'POST /api/outbox/submit', 'GET /api/sub/callback',
]);
const RETRY_STATUS = new Set([400, 401, 403, 404]);
const MAX_BODY = 4 * 1024 * 1024;

const dataPrefix = (controlPrefix, sid) => String(controlPrefix || 'payesh/') + 'h/' + sid + '/';
const tokenHash = (t) => crypto.createHash('sha256').update('payesh-hosted:' + String(t)).digest('hex').slice(0, 40);

/* ── سمت سرور میزبانی‌شده ─────────────────────────────────────────── */

/** پیشوند پرونده‌های مشترک مالک برای این پایگاه؛ null یعنی سرور اصلی (همان prefix خودش). */
function controlPrefix(store) {
  try {
    const m = store.getMeta(CONTROL_META, null);
    return m && typeof m.prefix === 'string' && m.prefix ? m.prefix : null;
  } catch (e) { return null; }
}

/** همان تنظیم دیتابیس، با پیشوند پرونده‌های مشترک مالک (فهرست مدارس، پرداخت، رسید، پشتیبانی). */
function withControlPrefix(store, cfg) {
  const cp = cfg ? controlPrefix(store) : null;
  return cp ? Object.assign({}, cfg, { prefix: cp }) : cfg;
}

/** درخواست واقعاً از سرور اصلی همین رایانه آمده؟ (کلید فرایند + 127.0.0.1) */
function trusted(req, key = process.env.PAYESH_HOSTED_KEY) {
  if (!key) return false;
  const remote = String((req.socket && req.socket.remoteAddress) || '').replace('::ffff:', '');
  if (!(remote === '127.0.0.1' || remote === '::1' || remote.startsWith('127.'))) return false;
  const got = Buffer.from(String(req.headers[H_KEY] || ''));
  const want = Buffer.from(String(key));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/**
 * پیام‌های سرور اصلی به سرور میزبانی‌شده. `cloud`: تنظیم دیتابیس سرور اصلی ⇒ همین‌جا با
 * پیشوند داده‌ای جدا ذخیره می‌شود و اگر مدرسه هنوز گره نخورده، از فهرست مالک برداشته می‌شود.
 */
async function onParentMessage(store, msg, { sid, s3mem, schools, auth, instance, send = () => {}, log = () => {} }) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.type === 'cloud' && msg.cfg && typeof msg.cfg === 'object') {
    const cp = String(msg.cfg.prefix || 'payesh/');
    const next = s3mem.normalize(Object.assign({}, msg.cfg, { prefix: dataPrefix(cp, sid), source: 'hosted' }));
    const cur = s3mem.usingMeta(store).get();
    const same = ['endpoint', 'bucket', 'region', 'prefix', 'accessKey', 'secret', 'pathStyle'].every(k => String(cur[k] == null ? '' : cur[k]) === String(next[k] == null ? '' : next[k]));
    if (!same || s3mem.usingMeta(store).isDefault()) s3mem.usingMeta(store).set(next);
    const m = store.getMeta(CONTROL_META, null);
    if (!m || m.prefix !== cp) store.setMeta(CONTROL_META, { prefix: cp, at: new Date().toISOString() });
    const r = await adoptHosted(store, sid, { schools, auth, instance });
    if (r.ok && r.adopted) log('[hosted ' + sid + '] مدرسه از فهرست پنل مالک برداشته شد');
    send({ type: 'adopted', ok: r.ok, error: r.error || null, bound: !!schools.boundOf(store) });
    return r;
  }
  return null;
}

/** سرور تازهٔ میزبانی‌شده ⇒ همان مدرسهٔ فهرست مالک (مدیر با نام کاربری/رمز پنل مالک وارد می‌شود). */
async function adoptHosted(store, sid, { schools, auth, instance, now = Date.now() }) {
  if (schools.boundOf(store)) return { ok: true, adopted: false };
  if (!auth.needsSetup(store)) return { ok: false, error: 'not_fresh' };
  const cfg = schools.cloud(store);
  if (!cfg) return { ok: false, error: 'not_managed' };
  let reg;
  try { reg = await schools.pullRegistry(store, cfg); } catch (e) { reg = schools.registry(store); }
  if (!reg) return { ok: false, error: 'registry_unreachable' };
  const sch = (reg.plain.schools || []).find(s => s && s.id === sid);
  if (!sch || !sch.manager || !sch.manager.password_hash) return { ok: false, error: 'not_found' };
  try {
    const ack = await schools.readEnv(cfg, cfg.prefix + schools.DIR.ack + sch.id + '.json', schools.K.ack);
    if (ack && !ack.invalid && ack.plain.instance && ack.plain.instance !== instance) {
      return { ok: false, error: 'school_hosted_elsewhere' };
    }
  } catch (e) { return { ok: false, error: 'registry_unreachable' }; }
  schools.adoptSchool(store, sch, { instance });
  await schools.writeAck(store, { instance, now }).catch(() => {});
  return { ok: true, adopted: true };
}

/** نشست/دستگاه/کد پرداخت مال همین سرور است؟ (فقط برای سرور اصلی) */
function owns(store, body, { auth, identity, schools }) {
  const b = body && typeof body === 'object' ? body : {};
  try {
    if (b.token && auth.verifySession(store, String(b.token))) return true;
    if (b.device_token && identity.lookup(store, String(b.device_token))) return true;
    if (b.payment && schools.subsState(store).payments.some(p => p && p.id === String(b.payment))) return true;
  } catch (e) { /* نه */ }
  return false;
}

/* ── سمت سرور اصلی ───────────────────────────────────────────────── */

/** پاسخی که در حافظه جمع می‌شود (برای «اول سرور اصلی، بعد بقیه»). */
class CapturedResponse {
  constructor() { this.statusCode = 200; this.headers = {}; this.chunks = []; this.headersSent = false; this.writableEnded = false; this._done = null; this.done = new Promise(r => { this._done = r; }); }
  setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }
  getHeader(k) { return this.headers[String(k).toLowerCase()]; }
  removeHeader(k) { delete this.headers[String(k).toLowerCase()]; }
  hasHeader(k) { return String(k).toLowerCase() in this.headers; }
  writeHead(status, a, b) {
    this.statusCode = status;
    const h = typeof a === 'object' && a ? a : (typeof b === 'object' && b ? b : null);
    if (h) for (const [k, v] of Object.entries(h)) this.setHeader(k, v);
    this.headersSent = true;
    return this;
  }
  write(c) { if (c != null) this.chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); this.headersSent = true; return true; }
  end(c) { if (c != null && typeof c !== 'function') this.write(c); this.writableEnded = true; this.headersSent = true; this._done(); return this; }
  on() { return this; } once() { return this; } emit() { return false; } flushHeaders() {}
  get body() { return Buffer.concat(this.chunks); }
  json() { try { return JSON.parse(this.body.toString('utf8')); } catch (e) { return null; } }
}

function replay(res, cap) {
  if (res.writableEnded) return;
  const headers = Object.assign({}, cap.headers);
  delete headers['content-length'];
  res.writeHead(cap.statusCode, headers);
  res.end(cap.body);
}

function readRaw(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('body_too_large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** همان درخواست، با بدنه‌ای که دوباره خوانده می‌شود */
function fakeReq(req, buf) {
  const r = Readable.from(buf.length ? [buf] : []);
  r.method = req.method; r.url = req.url; r.headers = req.headers;
  r.socket = req.socket; r.connection = req.socket; r.httpVersion = req.httpVersion;
  if (req.__public) r.__public = true;
  return r;
}

function bearerOf(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

/** از درون پاسخ ورود/refresh: نشست و توکن دستگاه ⇒ همین سرور */
function tokensIn(j) {
  const out = [];
  if (!j || typeof j !== 'object') return out;
  const s = j.session;
  if (typeof s === 'string') out.push(s);
  else if (s && typeof s === 'object' && typeof s.token === 'string') out.push(s.token);
  if (typeof j.device_token === 'string') out.push(j.device_token);
  if (typeof j.token === 'string') out.push(j.token);
  if (j.payment && typeof j.payment === 'object' && typeof j.payment.id === 'string') out.push('pay:' + j.payment.id);
  return out;
}

/**
 * مدیر میزبانی: سرورهای مدرسه‌های دیگر را بالا نگه می‌دارد و درخواست‌ها را می‌رساند.
 * `spawn(sid, env)` باید یک فرایند با کانال IPC بدهد (پیش‌فرض: child_process.fork همین index.js).
 */
function createHost(opts) {
  const {
    store, dataDir, entry, schools, s3mem, auth, instanceId, publicUrl = () => null,
    isLocal = () => false, clientIp = () => '', log = (m) => console.log(m),
    spawn = null, env = process.env, execArgv = process.execArgv,
  } = opts;
  const key = crypto.randomBytes(24).toString('hex');
  const children = new Map();   /* sid → {sid, proc, port, instance, ready, readyAt, adopted, restarts, stopped} */
  const cache = new Map();      /* tokenHash → sid */
  let timer = null;
  let stopped = false;

  const list = () => { const l = store.getMeta(LIST_META, []); return Array.isArray(l) ? l.filter(x => x && ID_RE.test(String(x.school_id || ''))) : []; };
  const remember = (sid) => {
    const l = list();
    if (l.some(x => x.school_id === sid)) return;
    store.setMeta(LIST_META, l.concat([{ school_id: sid, at: new Date().toISOString() }]));
  };
  const cacheSet = (t, sid) => { if (!t) return; if (cache.size > 20000) cache.clear(); cache.set(tokenHash(t), sid); };

  function cloudCfg() {
    try {
      const c = s3mem.usingMeta(store).get();
      if (!c || !c.endpoint || !c.accessKey || !c.secret) return null;
      const out = {};
      for (const k of ['endpoint', 'bucket', 'region', 'prefix', 'accessKey', 'secret', 'pathStyle']) out[k] = c[k];
      out.prefix = String(withControlPrefix(store, c).prefix || 'payesh/');
      return out;
    } catch (e) { return null; }
  }

  function defaultSpawn(sid, childEnv) {
    const { fork } = require('child_process');
    return fork(entry, [], { env: childEnv, execArgv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  }

  function start(sid) {
    if (stopped || children.has(sid) || !ID_RE.test(sid)) return children.get(sid) || null;
    const dir = path.join(dataDir, 'hosted', sid);
    fs.mkdirSync(dir, { recursive: true });
    const childEnv = Object.assign({}, env, {
      PAYESH_DATA: dir, PORT: '0', HOST: '127.0.0.1', PAYESH_HOSTED: sid, PAYESH_HOSTED_KEY: key,
      PAYESH_DISCOVERY: '0', PAYESH_NO_RESTART: '1', PAYESH_HOSTING: '0',
    });
    for (const k of ['PAYESH_TUNNEL_PORT', 'PAYESH_SUPERVISED', 'PAYESH_TENANT_ID', 'SERVER_PORT']) delete childEnv[k];
    const c = { sid, proc: null, port: 0, instance: null, adopted: false, restarts: (children.get(sid) || {}).restarts || 0, stopped: false };
    let markReady;
    c.ready = new Promise(r => { markReady = r; });
    c.markReady = markReady;
    children.set(sid, c);
    let proc;
    try { proc = (spawn || defaultSpawn)(sid, childEnv); } catch (e) { children.delete(sid); log('[hosting] ' + sid + ' بالا نیامد: ' + e.message); return null; }
    c.proc = proc;
    const tag = '[school ' + sid + '] ';
    const pipeLog = (s) => s && s.on && s.on('data', (d) => { for (const line of String(d).split('\n')) if (line.trim()) log(tag + line); });
    pipeLog(proc.stdout); pipeLog(proc.stderr);
    proc.on('message', (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'ready') {
        c.port = Number(m.port) || 0; c.instance = m.instance || null;
        const cc = cloudCfg();
        if (cc) { try { proc.send({ type: 'cloud', cfg: cc, public_url: publicUrl() }); } catch (e) { /* noop */ } } else c.markReady(c);
      } else if (m.type === 'adopted') {
        c.adopted = !!m.bound; c.readyAt = Date.now();
        if (m.error && m.error !== 'not_fresh') log('[hosting] ' + sid + ': ' + m.error);
        c.markReady(c);
      }
    });
    proc.on('exit', (code) => {
      c.stopped = true; c.port = 0;
      if (children.get(sid) === c) children.delete(sid);
      c.markReady(null);
      if (stopped) return;
      const n = c.restarts + 1;
      log('[hosting] سرور مدرسهٔ ' + sid + ' بسته شد (کد ' + code + ') — راه‌اندازی دوباره');
      setTimeout(() => { if (!stopped && !children.has(sid)) { const nc = start(sid); if (nc) nc.restarts = n; } }, Math.min(60_000, 1000 * 2 ** Math.min(n, 6))).unref();
    });
    log('[hosting] سرور مدرسهٔ ' + sid + ' راه‌اندازی شد (' + dir + ')');
    return c;
  }

  async function ready(sid, ms = READY_MS) {
    const c = children.get(sid) || start(sid);
    if (!c) return null;
    const r = await Promise.race([c.ready, new Promise(res => setTimeout(() => res(null), ms).unref())]);
    return r && r.port ? r : null;
  }

  const ourInstances = () => new Set([instanceId(), ...[...children.values()].map(c => c.instance).filter(Boolean)]);

  /** هر مدرسهٔ فهرست مالک که این‌جا یا جای دیگر میزبان ندارد ⇒ همین‌جا. */
  async function sync() {
    if (stopped) return { ok: false, error: 'stopped' };
    const reg = schools.registry(store);
    const b = schools.boundOf(store);
    const hosted = new Set(list().map(x => x.school_id));
    for (const sid of hosted) if (!children.has(sid)) start(sid);
    const cc = cloudCfg();
    for (const c of children.values()) if (c.port && cc) { try { c.proc.send({ type: 'cloud', cfg: cc, public_url: publicUrl() }); } catch (e) { /* noop */ } }
    if (!reg || !b) return { ok: true, started: [], hosted: [...hosted] };
    const cfg = schools.cloud(store);
    const started = [];
    for (const sch of reg.plain.schools || []) {
      const sid = sch && String(sch.id || '');
      if (!sid || !ID_RE.test(sid) || sid === b.school_id || hosted.has(sid)) continue;
      if (sch.active === false || !sch.manager || !sch.manager.password_hash) continue;
      if (cfg) {
        try {
          const ack = await schools.readEnv(cfg, cfg.prefix + schools.DIR.ack + sid + '.json', schools.K.ack);
          if (ack && !ack.invalid && ack.plain.instance && !ourInstances().has(ack.plain.instance)) continue;
        } catch (e) { continue; /* دیتابیس در دسترس نیست: دور بعد */ }
      }
      remember(sid);
      hosted.add(sid);
      start(sid);
      started.push(sid);
    }
    return { ok: true, started, hosted: [...hosted] };
  }

  /** ورود مدیر مدرسه‌ای که هنوز سرور ندارد (پیش از دور بعدی sync) */
  async function prepareLogin(body) {
    const reg = schools.registry(store);
    const b = schools.boundOf(store);
    if (!reg || !b || !body) return null;
    const sch = schools.findManager(reg.plain, body.phone);
    if (!sch || sch.id === b.school_id || !ID_RE.test(String(sch.id))) return null;
    if (!children.has(sch.id)) {
      const r = await sync();
      if (!r.hosted || !r.hosted.includes(sch.id)) return null;
    }
    return ready(sch.id);
  }

  function forward(c, req, res, buf, { capture = false } = {}) {
    return new Promise((resolve) => {
      const headers = Object.assign({}, req.headers);
      for (const k of Object.keys(headers)) if (k.startsWith('x-payesh-hosted')) delete headers[k];
      headers[H_KEY] = key;
      headers[H_LOCAL] = isLocal(req) ? '1' : '0';
      headers['x-forwarded-for'] = String(clientIp(req) || '');
      delete headers['cf-connecting-ip'];
      headers.host = '127.0.0.1:' + c.port;
      if (buf) { headers['content-length'] = String(buf.length); delete headers['transfer-encoding']; }
      const out = capture ? new CapturedResponse() : res;
      const preq = http.request({ host: '127.0.0.1', port: c.port, method: req.method, path: req.url, headers }, (pres) => {
        const h = Object.assign({}, pres.headers);
        if (capture) {
          out.writeHead(pres.statusCode, h);
          pres.on('data', d => out.write(d));
          pres.on('end', () => { out.end(); resolve(out); });
          pres.on('error', () => { out.end(); resolve(out); });
        } else {
          if (!res.headersSent) res.writeHead(pres.statusCode, h);
          pres.pipe(res);
          pres.on('end', () => resolve(out));
          pres.on('error', () => resolve(out));
        }
      });
      preq.setTimeout(10 * 60_000, () => preq.destroy(new Error('timeout')));
      preq.on('error', () => {
        if (capture) { out.writeHead(502, { 'content-type': 'application/json; charset=utf-8' }); out.end(JSON.stringify({ ok: false, error: 'school_server_unavailable' })); resolve(out); return; }
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        if (!res.writableEnded) res.end(JSON.stringify({ ok: false, error: 'school_server_unavailable' }));
        resolve(out);
      });
      if (buf) preq.end(buf); else req.pipe(preq);
    });
  }

  /** «این نشست/دستگاه/پرداخت مال کدام سرور است؟» از همهٔ سرورهای میزبانی‌شده */
  async function whoOwns(body) {
    const live = [...children.values()].filter(c => c.port);
    if (!live.length) return null;
    const data = Buffer.from(JSON.stringify(body));
    const ask = (c) => new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: c.port, method: 'POST', path: '/__hosted/owns',
        headers: { [H_KEY]: key, [H_LOCAL]: '0', 'content-type': 'application/json', 'content-length': String(data.length) } }, (pres) => {
        let t = ''; pres.on('data', d => { t += d; }); pres.on('end', () => { try { resolve(JSON.parse(t).owns === true ? c.sid : null); } catch (e) { resolve(null); } });
      });
      r.setTimeout(5000, () => r.destroy());
      r.on('error', () => resolve(null));
      r.end(data);
    });
    const got = await Promise.all(live.map(ask));
    return got.find(Boolean) || null;
  }

  const busy = () => children.size > 0 || list().length > 0;

  /**
   * درِ ورودی سرور اصلی. `base(req, res)` = همان handler تک‌مدرسه‌ای.
   * `rootOwnsToken(token)` = نشست مال سرور اصلی است؟
   */
  async function route(req, res, base, { rootOwnsToken }) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { return base(req, res); }
    if (url.pathname.startsWith('/__hosted/')) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found'); return undefined; }
    if (!busy() || req.method === 'OPTIONS' || !url.pathname.startsWith('/api/')) return base(req, res);

    const token = bearerOf(req);
    if (token) {
      if (rootOwnsToken(token)) return base(req, res);
      let sid = cache.get(tokenHash(token)) || null;
      if (!sid || !children.get(sid) || !children.get(sid).port) {
        sid = await whoOwns({ token });
        if (sid) cacheSet(token, sid);
      }
      const c = sid ? children.get(sid) : null;
      if (c && c.port) return forward(c, req, res, null);
      return base(req, res);
    }

    const k = req.method + ' ' + url.pathname;
    if (!FALLBACK.has(k)) return base(req, res);
    let buf;
    try { buf = await readRaw(req); } catch (e) {
      res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'body_too_large' }));
      return undefined;
    }
    let body = {};
    try { body = buf.length ? JSON.parse(buf.toString('utf8')) : {}; } catch (e) { body = {}; }
    if (k === 'POST /api/auth/login') { try { await prepareLogin(body); } catch (e) { /* ادامه */ } }

    /* بازگشت درگاه: پرداخت مال کدام سرور است (پاسخ سرور اصلی برای پرداخت ناشناس هم ۲۰۰ است) */
    if (k === 'GET /api/sub/callback') {
      const pid = String(url.searchParams.get('payment') || '');
      let sid = pid ? cache.get(tokenHash('pay:' + pid)) || null : null;
      if (!sid && pid) { sid = await whoOwns({ payment: pid }); if (sid) cacheSet('pay:' + pid, sid); }
      const c = sid ? children.get(sid) : null;
      if (c && c.port) return replay(res, await forward(c, req, res, buf, { capture: true }));
      return base(fakeReq(req, buf), res);
    }
    /* refresh: اگر می‌دانیم دستگاه مال کیست، مستقیم */
    const known = body.device_token ? cache.get(tokenHash(body.device_token)) : null;
    if (known && children.get(known) && children.get(known).port) {
      const cap = await forward(children.get(known), req, res, buf, { capture: true });
      if (cap.statusCode < 400) { for (const t of tokensIn(cap.json())) cacheSet(t, known); }
      return replay(res, cap);
    }

    const rootCap = new CapturedResponse();
    await Promise.resolve(base(fakeReq(req, buf), rootCap));
    await Promise.race([rootCap.done, new Promise(r => setTimeout(r, 30_000).unref())]);
    if (!RETRY_STATUS.has(rootCap.statusCode)) return replay(res, rootCap);
    const rj = rootCap.json();
    if (rj && (rj.error === 'local_only' || rj.error === 'rate_limited' || rj.error === 'bad_json')) return replay(res, rootCap);

    for (const c of [...children.values()]) {
      if (!c.port) continue;
      const cap = await forward(c, req, res, buf, { capture: true });
      if (cap.statusCode < 400) {
        for (const t of tokensIn(cap.json())) cacheSet(t, c.sid);
        return replay(res, cap);
      }
    }
    return replay(res, rootCap);
  }

  function startTimer({ everyMs = SYNC_MS, firstMs = 8000 } = {}) {
    if (timer) return;
    const tick = () => sync().catch(() => {});
    setTimeout(tick, firstMs).unref();
    timer = setInterval(tick, everyMs);
    timer.unref();
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    for (const c of children.values()) { try { c.proc.kill(); } catch (e) { /* noop */ } }
    children.clear();
  }

  function status() {
    return [...children.values()].map(c => ({ school_id: c.sid, port: c.port || null, instance: c.instance, adopted: c.adopted, restarts: c.restarts }));
  }

  return { key, start, ready, sync, route, prepareLogin, whoOwns, startTimer, stop, status, list, children, cacheSize: () => cache.size };
}

module.exports = {
  H_KEY, H_LOCAL, FALLBACK, CONTROL_META, LIST_META,
  dataPrefix, controlPrefix, withControlPrefix, trusted, onParentMessage, adoptHosted, owns,
  createHost, CapturedResponse, tokensIn,
};
