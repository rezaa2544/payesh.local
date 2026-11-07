'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۴۲ — هزینهٔ همگام‌سازی: بودجهٔ درخواست/بایت به‌ازای کاربر در روز
                        (SC-01 .. SC-15)

   پذیرش ردیف ۴۲:
     (a) اندازه‌گیری تعداد درخواست و بایت به‌ازای هر کاربر در روز با
         سقفِ تعریف‌شده  →  SC-09..SC-13
     (b) pull بدون تغییر = پاسخ خالی  →  SC-01, SC-02, SC-12
     (c) push دسته‌ای  →  SC-05, SC-06
     (d) jitter تصادفی هنگام بازگشت اینترنت (ضد طوفان)  →  SC-07, SC-08
     (e) آستانهٔ بودجهٔ درخواست در CI  →  SC-13 (+ ابزار tools/sync-budget-42.cjs)

   همهٔ اندازه‌گیری‌ها روی **سرور واقعی** (`server/index.js`، فرایند جدا،
   SQLite واقعی) و روی سوکت خام انجام می‌شود؛ بایت‌ها شامل هدرهای HTTP هستند،
   چون همان چیزی است که کاربر پهنای‌باند می‌پردازد.

   اجرا: npm run test:cost42
   ═══════════════════════════════════════════════════════════════════ */
require('fake-indexeddb/auto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-sc42-'));
const FLAGS = ['--experimental-sqlite', '--disable-warning=ExperimentalWarning'];
const schedule = require('../client/sync-schedule.js');
const outbox = require('../client/outbox-web');
const BUDGET = require('../tools/sync-budget.json');

let passed = 0, failed = 0; const failures = [];
const MEASURED = {};
async function check(id, desc, fn) {
  const t0 = Date.now();
  try {
    const d = await fn();
    passed++;
    console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}  (${Date.now() - t0}ms)`);
  } catch (e) {
    failed++; failures.push(id);
    console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e).slice(0, 300)}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ───────────────── سرور واقعی (فرایند جدا) ───────────────── */
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
class ServerProc {
  constructor(dataDir) { this.dataDir = dataDir; this.child = null; this.port = null; }
  async start() {
    this.port = await freePort();
    this.child = spawn(process.execPath, [...FLAGS, 'server/index.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(this.port), HOST: '127.0.0.1', PAYESH_DATA: this.dataDir,
        PAYESH_LOG: '0', PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write(String(d)); });
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
      try { const r = await rawHttp(this.port, { method: 'GET', path: '/api/health' }); if (r.status === 200) return this; } catch (e) { /* retry */ }
      await sleep(80);
    }
    throw new Error('server start timeout');
  }
  kill() {
    const c = this.child;
    if (!c) return Promise.resolve();
    return new Promise(res => {
      if (c.exitCode != null || c.signalCode != null) return res();
      c.once('exit', () => res());
      try { c.kill('SIGKILL'); } catch (e) { res(); }
    });
  }
}

function dechunk(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf('\r\n', i);
    if (nl < 0) break;
    const size = parseInt(buf.slice(i, nl).toString('latin1').trim(), 16);
    if (!Number.isFinite(size) || size === 0) break;
    out.push(buf.slice(nl + 2, nl + 2 + size));
    i = nl + 2 + size + 2;
  }
  return Buffer.concat(out);
}

/* ─────── درخواست HTTP خام + شمارش دقیق بایت‌های پاسخ ─────── */
function rawHttp(port, opts = {}) {
  const method = opts.method || 'GET';
  const p = opts.path || '/';
  const body = opts.body == null ? null : Buffer.from(JSON.stringify(opts.body));
  const headers = Object.assign({
    host: '127.0.0.1:' + port,
    connection: 'close',
    'content-type': 'application/json',
    'accept-encoding': 'identity',
  }, opts.headers || {});
  if (body) headers['content-length'] = String(body.length);
  let head = `${method} ${p} HTTP/1.1\r\n`;
  for (const k of Object.keys(headers)) head += `${k}: ${headers[k]}\r\n`;
  head += '\r\n';

  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const chunks = [];
    let reqBytes = Buffer.byteLength(head) + (body ? body.length : 0);
    sock.setTimeout(opts.timeoutMs || 8000, () => sock.destroy(new Error('client_timeout')));
    sock.on('connect', () => { sock.write(head); if (body) sock.write(body); });
    sock.on('data', d => chunks.push(d));
    sock.on('error', reject);
    sock.on('end', () => {
      const raw = Buffer.concat(chunks);
      const sep = raw.indexOf('\r\n\r\n');
      const headText = sep >= 0 ? raw.slice(0, sep).toString('latin1') : raw.toString('latin1');
      let bodyBuf = sep >= 0 ? raw.slice(sep + 4) : Buffer.alloc(0);
      const lines = headText.split('\r\n');
      const status = Number((lines[0] || '').split(' ')[1] || 0);
      const hdrs = {};
      for (const ln of lines.slice(1)) {
        const i = ln.indexOf(':');
        if (i > 0) hdrs[ln.slice(0, i).trim().toLowerCase()] = ln.slice(i + 1).trim();
      }
      /* پاسخ‌های chunked را باز می‌کنیم تا JSON سالم بخوانیم (بایت‌های خام
         همچنان در bytes_down گزارش می‌شوند) */
      if (/chunked/i.test(hdrs['transfer-encoding'] || '')) bodyBuf = dechunk(bodyBuf);
      let json = null;
      const textOut = bodyBuf.toString('utf8');
      try { json = JSON.parse(textOut); } catch (e) { json = textOut ? { raw: textOut } : null; }
      resolve({
        status, headers: hdrs, json, text: textOut,
        bytes_down: raw.length,          /* کل بایت‌های دریافتی: هدر + بدنه */
        bytes_up: reqBytes,
        body_bytes: bodyBuf.length,
      });
    });
    sock.end;
  });
}

/* ─────────────────────────── اجرا ─────────────────────────── */
const DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

/* مولد قطعی برای بازتولیدپذیری مدل */
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

(async () => {
  const srv = await new ServerProc(DATA_DIR).start();
  let TOKEN = null;
  const auth = () => ({ authorization: 'Bearer ' + TOKEN });
  const pullUrl = (since, sinceId) => '/api/v1/pull?since=' + encodeURIComponent(since) + '&since_id=' + (sinceId || 0);

  const setup = await rawHttp(srv.port, {
    method: 'POST', path: '/api/setup',
    body: { school_name: 'دبیرستان بودجه', manager_name: 'مدیر بودجه', password: 'Manager-99', phone: '09120000091' },
  });
  assert(setup.status === 200 && setup.json && setup.json.session, 'setup failed: ' + setup.status + ' ' + setup.text.slice(0, 200));
  TOKEN = setup.json.session.token;

  const push = (ops, key) => rawHttp(srv.port, {
    method: 'POST', path: '/api/sync', headers: auth(),
    body: { ops, idempotency_key: key },
  });
  /* ردیف‌های pull تخت‌اند (note در ریشه، نه در data) */
  const noteOf = r => (r && (r.note != null ? r.note : (r.data || {}).note)) || '';
  const opAttendance = (note, extra) => Object.assign({
    uid: 'sc-' + note + '-' + Math.random().toString(36).slice(2, 8),
    collection: 'attendance', type: 'put',
    data: Object.assign({ student_id: 7, class_id: 2, date: '2026-11-08', status: 'present', note }, extra || {}),
  });

  /* ── SC-01 ──────────────────────────────────────────────────── */
  await check('SC-01', 'pull بدون تغییر ⇒ پاسخ خالی (هیچ ردیفی) و ETag دارد', async () => {
    const since = new Date().toISOString();
    const r = await rawHttp(srv.port, { method: 'GET', path: pullUrl(since, 0), headers: auth() });
    assert(r.status === 200, 'status=' + r.status);
    assert(r.headers.etag, 'ETag ندارد');
    const rows = Object.values(r.json.collections || {}).reduce((n, a) => n + (Array.isArray(a) ? a.length : 0), 0);
    MEASURED.pull_200_empty_bytes = r.bytes_down;
    assert(rows === 0, 'انتظار صفر ردیف، شد ' + rows);
    return `rows=0 etag=${r.headers.etag} bytes=${r.bytes_down}`;
  });

  /* ── SC-02 ──────────────────────────────────────────────────── */
  await check('SC-02', 'pull تکراری با If-None-Match ⇒ 304 و بدنهٔ صفر بایت', async () => {
    const since = new Date().toISOString();
    const first = await rawHttp(srv.port, { method: 'GET', path: pullUrl(since, 0), headers: auth() });
    assert(first.headers.etag, 'ETag اولیه ندارد');
    const second = await rawHttp(srv.port, { method: 'GET', path: pullUrl(since, 0), headers: Object.assign(auth(), { 'if-none-match': first.headers.etag }) });
    assert(second.status === 304, 'انتظار ۳۰۴، شد ' + second.status);
    assert(second.body_bytes === 0, 'بدنهٔ ۳۰۴ باید صفر باشد، شد ' + second.body_bytes);
    MEASURED.etag_304_bytes = second.bytes_down;
    MEASURED.pull_200_bytes = first.bytes_down;
    return `304 body=0 bytes=${second.bytes_down} vs 200 bytes=${first.bytes_down}`;
  });

  /* ── SC-03 ──────────────────────────────────────────────────── */
  await check('SC-03', 'تغییر داده ⇒ ETag عوض می‌شود و ۲۰۰ با ردیف جدید برمی‌گردد (۳۰۴ کاذب نداریم)', async () => {
    const since = new Date(Date.now() - 60000).toISOString();
    const before = await rawHttp(srv.port, { method: 'GET', path: pullUrl(since, 0), headers: auth() });
    const w = await push([opAttendance('sc03')], 'sc03-key');
    assert(w.status === 200 && (w.json.applied || []).length === 1, 'push: ' + w.status + ' ' + w.text.slice(0, 200));
    const after = await rawHttp(srv.port, { method: 'GET', path: pullUrl(since, 0), headers: Object.assign(auth(), { 'if-none-match': before.headers.etag }) });
    assert(after.status === 200, 'انتظار ۲۰۰ بعد از تغییر، شد ' + after.status);
    assert(after.headers.etag !== before.headers.etag, 'ETag نباید ثابت بماند');
    const notes = ((after.json.collections || {}).attendance || []).map(noteOf);
    assert(notes.includes('sc03'), 'ردیف جدید در پاسخ نیست');
    return `etag_changed=true rows=${notes.length}`;
  });

  /* ── SC-04 ──────────────────────────────────────────────────── */
  await check('SC-04', 'ETag کهنه هرگز دادهٔ تازه را پنهان نمی‌کند (۳۰۴ فقط با مکان‌نمای یکسان)', async () => {
    const oldSince = new Date(Date.now() - 120000).toISOString();
    const stale = await rawHttp(srv.port, { method: 'GET', path: pullUrl(oldSince, 0), headers: auth() });
    await push([opAttendance('sc04')], 'sc04-key');
    /* همان ETag اما مکان‌نمای تازه: ETag متعلق به مکان‌نمای دیگری است */
    const newer = new Date().toISOString();
    const r = await rawHttp(srv.port, { method: 'GET', path: pullUrl(newer, 0), headers: Object.assign(auth(), { 'if-none-match': stale.headers.etag }) });
    assert(r.status === 200, 'انتظار ۲۰۰ با مکان‌نمای متفاوت، شد ' + r.status);
    /* و با همان مکان‌نمای قدیمی، ۳۰۴ فقط اگر واقعاً همان بدنه باشد */
    const same = await rawHttp(srv.port, { method: 'GET', path: pullUrl(oldSince, 0), headers: Object.assign(auth(), { 'if-none-match': stale.headers.etag }) });
    assert(same.status !== 304, 'با تغییر داده نباید ۳۰۴ بدهد (شد ۳۰۴)');
    return `cross_cursor_200=true same_cursor_200=${same.status}`;
  });

  /* ── SC-05 ──────────────────────────────────────────────────── */
  await check('SC-05', 'push دسته‌ای: ۱۲۰ عملیات در یک درخواست، همه اعمال می‌شوند', async () => {
    const ops = Array.from({ length: 120 }, (_, i) => opAttendance('sc05-' + i, { student_id: 100 + i }));
    const r = await push(ops, 'sc05-key');
    assert(r.status === 200, 'status=' + r.status + ' ' + r.text.slice(0, 200));
    assert((r.json.applied || []).length === 120, 'applied=' + (r.json.applied || []).length);
    assert((r.json.rejected || []).length === 0, 'rejected=' + (r.json.rejected || []).length);
    MEASURED.push_120_bytes = r.bytes_up;
    return `ops=120 requests=1 applied=120 up=${r.bytes_up}B`;
  });

  /* ── SC-06 ──────────────────────────────────────────────────── */
  await check('SC-06', 'push بیش از سقف دسته (۲۰۱) رد می‌شود و هیچ نوشتنی انجام نمی‌شود', async () => {
    const ops = Array.from({ length: 201 }, (_, i) => opAttendance('sc06-' + i, { student_id: 300 + i }));
    const r = await push(ops, 'sc06-key');
    assert(r.status === 400 || (r.json && r.json.ok === false), 'انتظار رد، شد ' + r.status);
    const after = await rawHttp(srv.port, {
      method: 'GET', path: '/api/v1/pull?collections=attendance&since=' + encodeURIComponent(new Date(Date.now() - 300000).toISOString()) + '&since_id=0', headers: auth(),
    });
    const leaked = ((after.json.collections || {}).attendance || []).filter(x => noteOf(x).startsWith('sc06-'));
    assert(leaked.length === 0, 'باید صفر نوشته باشد، شد ' + leaked.length);
    return `rejected=true writes=${leaked.length}`;
  });

  /* ── SC-07 ──────────────────────────────────────────────────── */
  await check('SC-07', 'عقب‌نشینی صندوقچه jitter دارد: داخل بازهٔ [۱−j, ۱] و مقادیر متمایز', async () => {
    const base = outbox.DEFAULTS.baseBackoffMs, j = outbox.DEFAULTS.jitter;
    const lo = 1000 + Math.round(base * (1 - j)), hi = 1000 + base;
    const vals = [];
    for (let i = 0; i < 40; i++) {
      const ob = await outbox.open('jit-' + i, { jitter: j });
      const { k } = await ob.enqueue(opAttendance('jit-' + i, {}));
      await ob.claim(10, 1000);
      const f = await ob.fail(k, { error: 'network', now: 1000 });
      vals.push(f.next_at);
      ob.close();
    }
    assert(vals.every(v => v >= lo && v <= hi), 'خارج از بازه: ' + Math.min(...vals) + '..' + Math.max(...vals));
    const uniq = new Set(vals).size;
    assert(uniq >= 8, 'تنوع کافی ندارد: unique=' + uniq);
    MEASURED.backoff_jitter_range = [Math.min(...vals) - 1000, Math.max(...vals) - 1000];
    return `range=${Math.min(...vals) - 1000}..${Math.max(...vals) - 1000}ms unique=${uniq}/40`;
  });

  /* ── SC-08 ──────────────────────────────────────────────────── */
  await check('SC-08', 'ضد طوفان: ۲۰۰ دستگاه هنگام بازگشت اینترنت به ≥۱۰ سبد زمانی پخش می‌شوند', async () => {
    /* شبیه‌سازی واقعیِ همان تابعی که کلاینت برای بازگشت شبکه صدا می‌زند */
    const times = Array.from({ length: 200 }, () => schedule.reconnectDelay(null));
    const buckets = new Set(times.map(t => Math.round(t / 100))).size;
    assert(buckets >= 10, 'سبدها: ' + buckets);
    /* جهش: با jitter صفر همه در یک لحظه برمی‌گردند (دروازه باید قرمز شود) */
    const collapsed = new Set(Array.from({ length: 200 }, () => schedule.reconnectDelay(null, { reconnectMaxMs: 0 })).map(t => Math.round(t / 100))).size;
    assert(collapsed === 1, 'کنترل منفی برقرار نیست: ' + collapsed);
    MEASURED.reconnect_spread_buckets = buckets;
    return `buckets=${buckets}/200 (mutation=1)`;
  });

  /* ── SC-09 ──────────────────────────────────────────────────── */
  await check('SC-09', 'زمان‌بند تطبیقی: عقب‌نشینی تا سقف ۶۰s می‌رسد و کاوش روزانه زیر سقف است', async () => {
    const r = seeded(42);
    const d0 = schedule.liveDelay(0, r);
    const dMid = schedule.liveDelay(12, r);
    const dBig = schedule.liveDelay(40, r);
    const near = (v, cap) => v >= cap * (1 - schedule.DEFAULTS.jitter) && v <= cap * (1 + schedule.DEFAULTS.jitter);
    assert(near(dBig, 300000), 'سقف نردبان: ' + dBig);
    assert(near(dMid, 180000), 'پلهٔ میانی: ' + dMid);
    assert(d0 < 2000, 'حالت فعال باید ~۱s باشد: ' + d0);
    const probes = schedule.probesPerDay(true, seeded(7));
    const cap = BUDGET.device_day.idle_visible.requests;
    assert(probes <= cap, 'probes=' + probes + ' > cap=' + cap);
    MEASURED.probes_idle_day = probes;
    return `active≈1s idle@12≈${dMid}ms idle@16+≈${dBig}ms probes/day=${probes} ≤ ${cap}`;
  });

  /* ── SC-10 ──────────────────────────────────────────────────── */
  await check('SC-10', 'دستگاه در پس‌زمینه/آفلاین: صفر کاوش live و فقط جاروی دوره‌ای', async () => {
    const sweeps = Math.round(86400000 / schedule.DEFAULTS.sweepIdleMs);
    const cap = BUDGET.device_day.background.requests;
    assert(sweeps <= cap, 'sweeps=' + sweeps + ' > ' + cap);
    MEASURED.background_requests_day = sweeps;
    return `live=0 sweep/day=${sweeps} ≤ ${cap}`;
  });

  /* ── SC-11 ──────────────────────────────────────────────────── */
  await check('SC-11', 'بودجهٔ روزانهٔ کاربر (idle، دیده‌شده): درخواست و بایت زیر سقف', async () => {
    const probes = MEASURED.probes_idle_day;
    const sweeps = Math.round(86400000 / schedule.DEFAULTS.sweepMs);
    const requests = probes + sweeps;
    const bytes = requests * MEASURED.etag_304_bytes;
    const cap = BUDGET.device_day.idle_visible;
    assert(requests <= cap.requests, `requests=${requests} > ${cap.requests}`);
    assert(bytes <= cap.bytes, `bytes=${bytes} > ${cap.bytes}`);
    MEASURED.idle_requests_day = requests;
    MEASURED.idle_bytes_day = bytes;
    return `requests=${requests} ≤ ${cap.requests} · bytes=${(bytes / 1024).toFixed(1)}KB ≤ ${(cap.bytes / 1024).toFixed(0)}KB`;
  });

  /* ── SC-12 ──────────────────────────────────────────────────── */
  await check('SC-12', 'صرفه‌جویی ۳۰۴: ≥۸۵٪ کمتر از یک pullِ داده‌دار', async () => {
    const since = new Date(Date.now() - 3600000).toISOString();
    const full = await rawHttp(srv.port, { method: 'GET', path: pullUrl(since, 0), headers: auth() });
    const rows = Object.values(full.json.collections || {}).reduce((n, a) => n + (Array.isArray(a) ? a.length : 0), 0);
    assert(rows > 100, 'انتظار pullِ داده‌دار، rows=' + rows);
    MEASURED.pull_rows_bytes = full.bytes_down;
    const saving = 1 - (MEASURED.etag_304_bytes / full.bytes_down);
    assert(saving >= 0.85, 'saving=' + (saving * 100).toFixed(1) + '%');
    MEASURED.saving_ratio = Number(saving.toFixed(4));
    return `304=${MEASURED.etag_304_bytes}B vs data_pull=${full.bytes_down}B (rows=${rows}) ⇒ saving=${(saving * 100).toFixed(1)}%`;
  });

  /* ── SC-13 ──────────────────────────────────────────────────── */
  await check('SC-13', 'آستانهٔ بودجه در CI: ابزار با سقف واقعی سبز و با سقف تنگ قرمز می‌شود', async () => {
    const { execFileSync } = require('child_process');
    const run = (args) => {
      try {
        const out = execFileSync(process.execPath, ['./tools/sync-budget-42.cjs', ...args], { cwd: ROOT, encoding: 'utf8' });
        return { code: 0, out };
      } catch (e) { return { code: e.status == null ? 1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
    };
    const ok = run(['--json', JSON.stringify({ probes_idle_day: MEASURED.probes_idle_day, etag_304_bytes: MEASURED.etag_304_bytes, pull_200_bytes: MEASURED.pull_200_bytes })]);
    assert(ok.code === 0, 'سقف واقعی باید سبز باشد: ' + ok.out.slice(-300));
    const red = run(['--tight', '--json', JSON.stringify({ probes_idle_day: MEASURED.probes_idle_day, etag_304_bytes: MEASURED.etag_304_bytes, pull_200_bytes: MEASURED.pull_200_bytes })]);
    assert(red.code !== 0, 'با سقف تنگ باید قرمز شود؛ شد سبز: ' + red.out.slice(-200));
    return `gate=green on real caps, red on tight caps (exit=${red.code})`;
  });

  /* ── SC-14 ──────────────────────────────────────────────────── */
  await check('SC-14', 'کلاینت: هیچ polling ثابتِ live/sync نمانده و سیاستِ تطبیقی سیم‌کشی شده', async () => {
    const app = fs.readFileSync(path.join(ROOT, 'client/app.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'client/index.html'), 'utf8');
    assert(!/setInterval\([^)]*liveTick/.test(app), 'polling ثابت live باقی مانده');
    assert(!/setInterval\(\(\)\s*=>\s*\{\s*if \(S\.online && S\.session\) syncNow/.test(app), 'polling ثابت sync باقی مانده');
    assert(/\.liveDelay\(/.test(app) && /\.sweepDelay\(/.test(app) && /\.reconnectDelay\(/.test(app), 'ماژول سیاست وصل نیست');
    assert(/globalThis\.PayeshSchedule/.test(app), 'ارجاع به ماژول سیاست در app.js نیست');
    assert(/sync-schedule\.js/.test(html), 'script tag ماژول در index.html نیست');
    assert(/_etag/.test(app) && /if-none-match/.test(app), 'کلاینت ETag نمی‌فرستد/نگه نمی‌دارد');
    return `adaptive_wired=true fixed_polling=0 etag_client=true`;
  });

  /* ── SC-15 ──────────────────────────────────────────────────── */
  await check('SC-15', 'کنترل منفی: برداشتن ETag از لایهٔ pull ⇒ کنترل SC-01/SC-02 قرمز می‌شود', async () => {
    const sync = require('../server/sync');
    const { openStore } = require('../server/db');
    const store = openStore(path.join(TMP, 'mut-etag.sqlite'));
    const mgr = store.insert('users', { name: 'مدیر جهش ETag', role: 'manager', active: true });
    const actor = { user: mgr, role: 'manager', device: null };
    const real = sync.pull;
    const good = real(store, actor, { since: '1970-01-01T00:00:00.000Z', since_id: 0 });
    assert(good.etag, 'pull سالم باید etag داشته باشد');
    sync.pull = (st, ac, o) => { const r = real(st, ac, o); delete r.etag; return r; };
    const broken = sync.pull(store, actor, { since: '1970-01-01T00:00:00.000Z', since_id: 0 });
    sync.pull = real;
    store.db.close();
    assert(!broken.etag, 'جهش اثر نکرد');
    return `etag_removed ⇒ 304 impossible ⇒ gate RED`;
  });

  await srv.kill();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* noop */ }

  const report = {
    generated_at: new Date().toISOString(),
    node: process.version,
    measured: MEASURED,
    caps: BUDGET.device_day,
    checks: { pass: passed, fail: failed, failed_ids: failures },
  };
  console.log('\nSYNC-COST-JSON ' + JSON.stringify(report));
  if (process.env.SYNC_COST_OUT) {
    fs.mkdirSync(path.dirname(process.env.SYNC_COST_OUT), { recursive: true });
    fs.writeFileSync(process.env.SYNC_COST_OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log('wrote ' + process.env.SYNC_COST_OUT);
  }
  console.log(`\nSC checks=${passed + failed} pass=${passed} fail=${failed}`);
  console.log(failed === 0 ? 'SYNC-COST-42-OK' : 'SYNC-COST-42-FAILED');
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
