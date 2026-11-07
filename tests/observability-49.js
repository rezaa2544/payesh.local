'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون پایش و هشدار — ردیف ۴۹          (OB-01 .. OB-18)

   چه چیزی واقعی است؟
     • سرور محصول (`server/index.js`) به‌صورت فرایند جدا، دیتابیس SQLite
       واقعی و دایرکتوری دادهٔ موقت — همان باینری تولید.
     • `/metrics` همان متن Prometheus است که Prometheus می‌خواند.
     • خرابی، **تزریق واقعی** است: دایرکتوری داده فقط‌خواندنی می‌شود و
       آمادگی واقعاً ۵۰۳ می‌دهد؛ بعد همان scrape به ارزیاب قواعد داده
       می‌شود و باید هشدار روشن کند.
     • تحویل هشدار روی HTTP واقعی سنجیده می‌شود (گیرندهٔ محلی به‌جای Pager).

   چه چیزی ادعا نمی‌شود: تحویل به Pager واقعی بیرونی (ردیف ۵۸، OWNER).

   اجرا: npm run test:observability49
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FLAGS = ['--experimental-sqlite', '--disable-warning=ExperimentalWarning'];
const ALERTS = path.join(ROOT, 'tools', 'alerts-49.mjs');
const RULES = path.join(ROOT, 'deploy', 'monitoring', 'alerts-49.yml');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-ob49-'));

let passed = 0, failed = 0;
const failures = [];
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

/* ───────────────────────── ابزار شبکه ───────────────────────── */
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
function rawReq(port, method, urlPath, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, agent: false,
      headers: { connection: 'close' } }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', d => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: buf }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}
async function waitFor(fn, ms = 25000, step = 80) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    try { const r = await fn(); if (r) return r; } catch (e) { last = e; }
    await sleep(step);
  }
  throw new Error('timeout' + (last ? ': ' + last.message : ''));
}

/* ───────────────────────── فرایند سرور ───────────────────────── */
class Proc {
  constructor(script, dataDir, extraEnv = {}) { this.script = script; this.dataDir = dataDir; this.env = extraEnv; this.child = null; this.port = null; }
  async start() {
    this.port = await freePort();
    this.child = spawn(process.execPath, [...FLAGS, this.script], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(this.port), HOST: '127.0.0.1', PAYESH_DATA: this.dataDir,
        PAYESH_LOG: '0', PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0',
      }, this.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write(String(d)); });
    await waitFor(async () => (await rawReq(this.port, 'GET', '/healthz')).status === 200);
    return this;
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

/* ─────────────────── پارسر متن Prometheus ─────────────────── */
const SERIES_RE = /^([A-Za-z_:][A-Za-z0-9_:]*)(\{[^}]*\})?\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;
function parseMetrics(text) {
  const names = new Map();
  const keys = new Set();
  const bad = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = SERIES_RE.exec(line);
    if (!m) { bad.push(line); continue; }
    const key = m[1] + (m[2] || '');
    if (keys.has(key)) bad.push('duplicate:' + key);
    keys.add(key);
    if (!names.has(m[1])) names.set(m[1], []);
    names.get(m[1]).push({ labels: m[2] || '', value: Number(m[3]) });
  }
  return { names, keys, bad };
}
function valueOf(parsed, name) {
  const rows = parsed.names.get(name);
  if (!rows || !rows.length) return null;
  return rows.reduce((a, r) => Math.max(a, r.value), -Infinity);
}

async function scrape(port) {
  const r = await rawReq(port, 'GET', '/metrics');
  assert(r.status === 200, 'metrics status ' + r.status);
  return { text: r.text, parsed: parseMetrics(r.text), headers: r.headers };
}

/* ───────────────────── اجرای ارزیاب هشدار ───────────────────── */
function runAlerts({ metricsText, metricsFile, now, state, sink, webhook, repeat = 300, extra = [], rules }) {
  const args = [ALERTS, '--rules', rules || RULES];
  if (extra.includes('--check-rules')) args.push('--check-rules');
  if (metricsText != null) {
    const f = path.join(WORK, 'scrape-' + Math.random().toString(36).slice(2) + '.txt');
    fs.writeFileSync(f, metricsText);
    args.push('--metrics-file', f);
  } else if (metricsFile) {
    args.push('--metrics-file', metricsFile);
  }
  if (now) args.push('--now', now);
  if (state) args.push('--state', state);
  if (sink) args.push('--sink', sink);
  if (webhook) args.push('--webhook', webhook);
  if (repeat) args.push('--repeat', String(repeat));
  for (const e of extra) if (e !== '--check-rules') args.push(e);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: ROOT, timeout: 30000 });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

/* نسخهٔ ناهمگام: برای آزمون تحویل وب‌هوک لازم است، چون گیرنده در همین
   فرایند اجرا می‌شود و spawnSync حلقهٔ رویداد را قفل می‌کند (timeout). */
function runAlertsAsync(opts) {
  return new Promise(resolve => {
    const f = path.join(WORK, 'scrape-' + Math.random().toString(36).slice(2) + '.txt');
    fs.writeFileSync(f, opts.metricsText);
    const args = [ALERTS, '--rules', opts.rules || RULES, '--metrics-file', f,
      '--now', opts.now, '--state', opts.state, '--sink', opts.sink, '--repeat', String(opts.repeat || 300)];
    if (opts.webhook) args.push('--webhook', opts.webhook);
    const c = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    c.on('close', code => resolve({ code, out, err }));
  });
}

/* ───────────────────────── اجرای آزمون ───────────────────────── */
(async () => {
  const dataDir = path.join(WORK, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const srv = await new Proc('server/index.js', dataDir).start();
  const stateFile = path.join(WORK, 'alerts-state.json');
  const sinkFile = path.join(WORK, 'alerts-sink.jsonl');

  try {
    await check('OB-01', '‏/healthz زنده‌بودن فرایند را بدون وابستگی می‌دهد', async () => {
      const r = await rawReq(srv.port, 'GET', '/healthz');
      assert(r.status === 200, 'status ' + r.status);
      const b = JSON.parse(r.text);
      assert(b.ok === true, 'ok != true');
      assert(b.instance === 'payesh-local', 'instance: ' + b.instance);
      return 'status=200 instance=' + b.instance;
    });

    await check('OB-02', '‏/readyz آمادگی واقعی دهنده است (DB + نوشتن + دیسک)', async () => {
      const r = await rawReq(srv.port, 'GET', '/readyz');
      assert(r.status === 200, 'status ' + r.status);
      const b = JSON.parse(r.text);
      assert(b.ready === true, 'ready != true');
      assert(b.checks && b.checks.db === true, 'db check false');
      return `ready=true disk_free=${b.checks.disk_free_pct}`;
    });

    await check('OB-03', '‏/api/readyz سازگار با /readyz است (یک منبع، دو مسیر)', async () => {
      const a = JSON.parse((await rawReq(srv.port, 'GET', '/readyz')).text);
      const b = JSON.parse((await rawReq(srv.port, 'GET', '/api/readyz')).text);
      assert(a.ready === b.ready, `mismatch ${a.ready} vs ${b.ready}`);
      assert(JSON.stringify(a.checks.db) === JSON.stringify(b.checks.db), 'db check mismatch');
      return 'both ready=' + a.ready;
    });

    await check('OB-04', '‏/metrics با قالب متن Prometheus 0.0.4 سرو می‌شود', async () => {
      const r = await rawReq(srv.port, 'GET', '/metrics');
      assert(r.status === 200, 'status ' + r.status);
      assert(/text\/plain.*version=0\.0\.4/.test(String(r.headers['content-type'])), 'content-type: ' + r.headers['content-type']);
      assert(r.text.endsWith('\n'), 'متن با خط تازه تمام نمی‌شود');
      return String(r.headers['content-type']);
    });

    const REQUIRED = ['payesh_up', 'payesh_uptime_seconds', 'payesh_ready', 'payesh_db_up',
      'payesh_sync_lag_seconds', 'payesh_sync_devices_total', 'payesh_sync_queue_depth',
      'payesh_http_requests_total', 'payesh_http_error_ratio', 'payesh_disk_free_pct'];
    await check('OB-05', `خانواده‌های لازم متریک حاضرند (${REQUIRED.length} مورد)`, async () => {
      const { parsed } = await scrape(srv.port);
      const missing = REQUIRED.filter(n => !parsed.names.has(n));
      assert(!missing.length, 'غایب: ' + missing.join(','));
      return 'present=' + REQUIRED.length;
    });

    await check('OB-06', 'هر خط متریک تجزیه‌پذیر است و سری تکراری ندارد', async () => {
      const { parsed, text } = await scrape(srv.port);
      assert(!parsed.bad.length, 'خط بد: ' + parsed.bad.slice(0, 3).join(' | '));
      const helpCount = (text.match(/^# TYPE /gm) || []).length;
      assert(helpCount === parsed.names.size, `TYPE=${helpCount} ولی خانواده=${parsed.names.size}`);
      return `series=${parsed.keys.size} families=${parsed.names.size}`;
    });

    await check('OB-07', 'متریک هیچ راز/شناسه‌ای افشا نمی‌کند', async () => {
      const { text } = await scrape(srv.port);
      const banned = ['token', 'password', 'pin_hash', 'authorization', 'bearer', 'secret', dataDir, '@'];
      const hits = banned.filter(b => text.toLowerCase().includes(String(b).toLowerCase()));
      assert(!hits.length, 'یافت شد: ' + hits.join(','));
      return 'no-secret-labels';
    });

    await check('OB-08', 'lag همگام‌سازی عدد واقعیِ دیتابیس است (دستگاه ساکت دیده می‌شود)', async () => {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(path.join(dataDir, 'payesh.sqlite'));
      const now = Date.now();
      const ins = db.prepare('INSERT OR REPLACE INTO devices(id,user_id,name,platform,pin_hash,created_at,last_seen_at,revoked_at) VALUES(?,?,?,?,?,?,?,?)');
      ins.run('dev-fresh', 1, 'fresh', 'web', 'x', new Date(now - 60e3).toISOString(), new Date(now - 5e3).toISOString(), null);
      ins.run('dev-stale', 1, 'stale', 'android', 'x', new Date(now - 7200e3).toISOString(), new Date(now - 7200e3).toISOString(), null);
      ins.run('dev-revoked', 1, 'revoked', 'web', 'x', new Date(now - 99e5).toISOString(), new Date(now - 99e5).toISOString(), new Date(now).toISOString());
      db.close();
      const { parsed } = await scrape(srv.port);
      const lag = valueOf(parsed, 'payesh_sync_lag_seconds');
      const devices = valueOf(parsed, 'payesh_sync_devices_total');
      assert(devices === 2, 'devices_total=' + devices + ' (ابطال‌شده نباید شمرده شود)');
      assert(lag >= 7100 && lag <= 7400, 'lag=' + lag + ' (انتظار ≈7200)');
      return `devices=2 lag=${lag}s`;
    });

    await check('OB-09', 'عمق صف همگام‌سازی از صندوقچهٔ واقعی خوانده می‌شود', async () => {
      const pending = path.join(dataDir, 'outbox', 'pending');
      fs.mkdirSync(pending, { recursive: true });
      for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(pending, `u${i}.json`), JSON.stringify({ i }));
      let depth = valueOf((await scrape(srv.port)).parsed, 'payesh_sync_queue_depth');
      assert(depth === 3, 'depth=' + depth);
      for (let i = 0; i < 3; i++) fs.unlinkSync(path.join(pending, `u${i}.json`));
      depth = valueOf((await scrape(srv.port)).parsed, 'payesh_sync_queue_depth');
      assert(depth === 0, 'depth=' + depth + ' پس از تخلیه');
      return 'depth 3→0';
    });

    await check('OB-10', 'نرخ خطا فقط خطای سرور (5xx) است، نه هر پاسخ ناموفق', async () => {
      const before = (await scrape(srv.port)).parsed;
      const pick = (parsed, cls) => {
        const rows = parsed.names.get('payesh_http_requests_total') || [];
        const r = rows.find(x => x.labels.includes('class="' + cls + '"'));
        return r ? r.value : 0;
      };
      const errBefore = pick(before, '5xx');
      for (let i = 0; i < 3; i++) {
        const r = await rawReq(srv.port, 'GET', '/api/definitely-not-a-route-' + i);
        /* مسیر محافظت‌شده پیش از ۴۰۴، ۴۰۱ می‌دهد — هر دو «خطای کلاینت»‌اند */
        assert(r.status >= 400 && r.status < 500, 'انتظار خطای 4xx، شد ' + r.status);
      }
      const after = (await scrape(srv.port)).parsed;
      assert(pick(after, '4xx') >= pick(before, '4xx') + 3, 'شمارندهٔ 4xx رشد نکرد');
      assert(pick(after, '5xx') === errBefore, '4xx نباید 5xx شمرده شود');
      const ratio = valueOf(after, 'payesh_http_error_ratio');
      assert(ratio === errBefore / (pick(after, '2xx') + pick(after, '3xx') + pick(after, '4xx') + pick(after, '5xx')) || (errBefore === 0 && ratio === 0),
        'ratio=' + ratio + ' با شمارنده‌های 5xx نمی‌خواند');
      return `4xx grew, 5xx=${errBefore} ratio=${ratio}`;
    });

    await check('OB-11', '‏payesh_ready در متریک با /readyz یکی است (دو عدد متناقض نداریم)', async () => {
      const ready = JSON.parse((await rawReq(srv.port, 'GET', '/readyz')).text).ready;
      const m = valueOf((await scrape(srv.port)).parsed, 'payesh_ready');
      assert((ready ? 1 : 0) === m, `readyz=${ready} metric=${m}`);
      return 'ready=' + ready;
    });

    await check('OB-12', 'همهٔ قواعد هشدار در گرامر محدود تجزیه‌شوند و severity/runbook دارند', async () => {
      const r = runAlerts({ extra: ['--check-rules'] });
      assert(r.code === 0, 'exit=' + r.code + ' ' + r.err.slice(0, 200));
      const rules = r.out.split('\n').filter(l => l.startsWith('ALERT-RULE '));
      assert(rules.length === 10, 'rules=' + rules.length);
      const noSev = rules.filter(l => l.includes('severity=MISSING'));
      assert(!noSev.length, 'قاعده بدون severity: ' + noSev.join(','));
      const yml = fs.readFileSync(RULES, 'utf8');
      const runbooks = (yml.match(/^\s+runbook:\s*\S+/gm) || []).length;
      assert(runbooks >= rules.length, `runbook=${runbooks} rules=${rules.length}`);
      const instants = rules.filter(l => /for=0s/.test(l));
      assert(!instants.length, 'قاعدهٔ بدون for (لرزش/storm): ' + instants.join(','));
      return `rules=${rules.length} runbooks=${runbooks}`;
    });

    const healthy = (await scrape(srv.port)).text;
    await check('OB-13', 'کنترل منفی: روی وضعیت سالم هیچ هشداری روشن نمی‌شود', async () => {
      const r = runAlerts({ metricsText: healthy, now: '2026-11-08T10:00:00Z', state: stateFile, sink: sinkFile });
      assert(r.code === 0, 'exit=' + r.code + ' ' + r.err.slice(0, 200));
      const line = r.out.split('\n').find(l => l.startsWith('ALERTS-49 rules='));
      assert(/firing=0/.test(line), 'هشدار کاذب: ' + line);
      return line.trim();
    });

    let failedScrape = null;
    await check('OB-14', 'خرابی واقعی: دایرکتوری داده فقط‌خواندنی ⇒ readyz ۵۰۳ و هشدار روشن می‌شود', async () => {
      fs.chmodSync(dataDir, 0o555);
      try {
        const r = await rawReq(srv.port, 'GET', '/readyz');
        assert(r.status === 503, 'readyz status=' + r.status + ' (انتظار 503)');
        const body = JSON.parse(r.text);
        assert(body.ready === false, 'ready باید false باشد');
        const sc = await scrape(srv.port);
        failedScrape = sc.text;
        assert(valueOf(sc.parsed, 'payesh_ready') === 0, 'payesh_ready باید ۰ باشد');
        /* سه درخواست ۵۰۳ دیگر: نرخ خطای سرور باید واقعاً بالا برود و با
           شمارنده‌های کلاس 5xx بخواند (نه با حدس). */
        for (let i = 0; i < 3; i++) await rawReq(srv.port, 'GET', '/readyz');
        const sc2 = await scrape(srv.port);
        const rows = sc2.parsed.names.get('payesh_http_requests_total') || [];
        const pick = cls => { const r = rows.find(x => x.labels.includes('class="' + cls + '"')); return r ? r.value : 0; };
        const total = pick('2xx') + pick('3xx') + pick('4xx') + pick('5xx');
        const ratio = valueOf(sc2.parsed, 'payesh_http_error_ratio');
        assert(pick('5xx') >= 3, 'شمارندهٔ 5xx باید ≥۳ باشد، شد ' + pick('5xx'));
        assert(Math.abs(ratio - pick('5xx') / total) < 1e-6, `ratio=${ratio} انتظار=${pick('5xx') / total}`);
        assert(ratio > 0.05, 'نرخ خطا باید از آستانهٔ هشدار بگذرد، شد ' + ratio);
        /* pending در لحظهٔ نقض، سپس firing بعد از `for: 2m` */
        const t0 = runAlerts({ metricsText: failedScrape, now: '2026-11-08T10:10:00Z', state: stateFile, sink: sinkFile });
        assert(/ALERT-PENDING name=PayeshNotReady/.test(t0.out), 'فاز pending دیده نشد: ' + t0.out.slice(-300));
        const t1 = runAlerts({ metricsText: failedScrape, now: '2026-11-08T10:12:05Z', state: stateFile, sink: sinkFile });
        assert(/ALERT-FIRING name=PayeshNotReady/.test(t1.out), 'هشدار روشن نشد: ' + t1.out.slice(-300));
        const recs = fs.readFileSync(sinkFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
        const rec = recs.find(x => x.alert === 'PayeshNotReady' && x.kind === 'firing');
        assert(rec, 'رکورد firing در sink نیست');
        assert(rec.value === 0 && rec.threshold === 1, 'مقدار/آستانه در رکورد: ' + JSON.stringify(rec).slice(0, 160));
        assert(rec.severity === 'critical', 'severity=' + rec.severity);
        assert(rec.runbook && rec.runbook.startsWith('docs/cloud/'), 'runbook غایب');
        return `readyz=503 → pending→firing value=${rec.value}<${rec.threshold}`;
      } finally { fs.chmodSync(dataDir, 0o755); }
    });

    await check('OB-15', 'بازیابی: پس از رفع خرابی، همان قاعده resolve می‌شود', async () => {
      const ok = (await scrape(srv.port)).text;
      const r = runAlerts({ metricsText: ok, now: '2026-11-08T10:20:00Z', state: stateFile, sink: sinkFile });
      assert(r.code === 0, 'exit=' + r.code + ' ' + r.err.slice(0, 200));
      assert(/ALERT-RESOLVED name=PayeshNotReady/.test(r.out), 'resolve ثبت نشد: ' + r.out.slice(-300));
      const recs = fs.readFileSync(sinkFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      assert(recs.some(x => x.alert === 'PayeshNotReady' && x.kind === 'resolved'), 'رکورد resolved در sink نیست');
      return 'resolved-recorded';
    });

    await check('OB-16', 'هشدار تکراری در پنجرهٔ تکرار خفه می‌شود (بدون طوفان هشدار)', async () => {
      /* سه گام: شروع نقض (pending) → عبور از for (firing، یک اعلان) →
         تکرار در پنجره (suppressed، بدون رکورد تازه). */
      const beforeNotReady = fs.readFileSync(sinkFile, 'utf8').trim().split('\n')
        .map(l => JSON.parse(l)).filter(x => x.alert === 'PayeshNotReady').length;
      const t0 = runAlerts({ metricsText: failedScrape, now: '2026-11-08T10:30:00Z', state: stateFile, sink: sinkFile, repeat: 600 });
      assert(/ALERT-PENDING name=PayeshNotReady/.test(t0.out), 'فاز pending نیامد');
      const t1 = runAlerts({ metricsText: failedScrape, now: '2026-11-08T10:32:10Z', state: stateFile, sink: sinkFile, repeat: 600 });
      assert(/ALERT-FIRING name=PayeshNotReady/.test(t1.out), 'هشدار اول روشن نشد: ' + t1.out.slice(-200));
      const countNotReady = () => fs.readFileSync(sinkFile, 'utf8').trim().split('\n')
        .map(l => JSON.parse(l)).filter(x => x.alert === 'PayeshNotReady').length;
      const midNotReady = countNotReady();
      const t2 = runAlerts({ metricsText: failedScrape, now: '2026-11-08T10:33:10Z', state: stateFile, sink: sinkFile, repeat: 600 });
      assert(/ALERT-SUPPRESSED name=PayeshNotReady/.test(t2.out), 'تکرار خفه نشد: ' + t2.out.slice(-300));
      const afterNotReady = countNotReady();
      assert(midNotReady - beforeNotReady === 1, `اعلان اول باید یک رکورد بیفزاید، شد ${midNotReady - beforeNotReady}`);
      assert(afterNotReady === midNotReady, `تکرار نباید رکورد بیفزاید، شد ${afterNotReady - midNotReady}`);
      return 'notify=1 suppressed=1 window=600s';
    });

    await check('OB-17', 'تحویل هشدار روی HTTP واقعی انجام می‌شود (گیرندهٔ محلی به‌جای Pager)', async () => {
      const got = [];
      const srvHook = http.createServer((req, res) => {
        let b = '';
        req.on('data', d => { b += d; });
        req.on('end', () => { try { got.push(JSON.parse(b)); } catch (e) { got.push({ raw: b }); } res.writeHead(204); res.end(); });
      });
      await new Promise(r => srvHook.listen(0, '127.0.0.1', r));
      const hookPort = srvHook.address().port;
      try {
        const whState = path.join(WORK, 'state-webhook.json');
        const whSink = path.join(WORK, 'sink-webhook.jsonl');
        /* گام اول: شروع نقض؛ گام دوم پس از عبور از `for` ⇒ اعلان واقعی */
        await runAlertsAsync({ metricsText: failedScrape, now: '2026-11-08T11:00:00Z', state: whState, sink: whSink, webhook: `http://127.0.0.1:${hookPort}/page` });
        const r = await runAlertsAsync({
          metricsText: failedScrape, now: '2026-11-08T11:02:05Z',
          state: whState, sink: whSink,
          webhook: `http://127.0.0.1:${hookPort}/page`,
        });
        assert(r.code === 0, 'exit=' + r.code + ' ' + r.err.slice(0, 200));
        assert(/delivered=true/.test(r.out), 'تحویل webhook موفق نبود: ' + r.out.slice(-300));
        assert(got.length >= 1, 'گیرندهٔ وب‌هوک چیزی دریافت نکرد');
        const rec = got[0];
        assert(rec.alert === 'PayeshNotReady', 'alert=' + rec.alert);
        assert(rec.severity === 'critical' && rec.value === 0, 'محتوای هشدار ناقص: ' + JSON.stringify(rec).slice(0, 160));
        return `posted=${got.length} alert=${rec.alert} severity=${rec.severity}`;
      } finally { await new Promise(r => srvHook.close(r)); }
    });

    await check('OB-18', 'کنترل منفی: قاعدهٔ خارج از گرامر و متریک غایب، دروازه را قرمز می‌کنند', async () => {
      const badRules = path.join(WORK, 'bad-alerts.yml');
      fs.writeFileSync(badRules, [
        'groups:', '  - name: bad', '    rules:',
        '      - alert: BadExpr', '        expr: rate(payesh_http_requests_total[5m]) > 1',
        '        for: 1m', '        labels:', '          severity: warning',
        '        annotations:', '          summary: x', '          runbook: docs/cloud/49-observability.md',
      ].join('\n'));
      const a = runAlerts({ extra: ['--check-rules'], rules: badRules });
      assert(a.code === 2, 'قاعدهٔ بد باید exit=2 بدهد، داد ' + a.code);
      const b = runAlerts({ metricsText: 'payesh_up 1\n', now: '2026-11-08T12:00:00Z', extra: ['--require-metrics', 'payesh_ready,payesh_sync_lag_seconds'] });
      assert(b.code === 2, 'متریک غایب باید exit=2 بدهد، داد ' + b.code);
      assert(/MISSING-METRICS/.test(b.err), 'پیام MISSING-METRICS نیامد');
      return 'bad-expr=exit2 missing-metrics=exit2';
    });

    await check('OB-19', 'Gateway هم /metrics و /healthz می‌دهد (پیش از تنظیم PG)', async () => {
      const gwData = path.join(WORK, 'gw');
      fs.mkdirSync(gwData, { recursive: true });
      const gw = await new Proc('server/gateway.js', gwData, { PGURL: '', GW_SECRET: '' }).start();
      try {
        const h = await rawReq(gw.port, 'GET', '/healthz');
        assert(h.status === 200, 'gateway healthz=' + h.status);
        const m = await rawReq(gw.port, 'GET', '/metrics');
        assert(m.status === 200, 'gateway metrics=' + m.status);
        const parsed = parseMetrics(m.text);
        assert(!parsed.bad.length, 'خط بد در متریک Gateway');
        assert(valueOf(parsed, 'payesh_up') === 1, 'payesh_up غایب');
        assert(valueOf(parsed, 'payesh_gateway_configured') === 0, 'configured باید ۰ باشد (بدون PGURL)');
        const ready = await rawReq(gw.port, 'GET', '/readyz');
        assert(ready.status === 503, 'readyz بدون PG باید 503 باشد، داد ' + ready.status);
        return 'gateway metrics ok (configured=0, readyz=503)';
      } finally { await gw.kill(); }
    });
  } finally {
    await srv.kill();
  }

  console.log(`\nOB checks=${passed + failed} pass=${passed} fail=${failed}`);
  if (failures.length) console.log('failures: ' + failures.join(','));
  console.log(failed === 0 ? 'OBSERVABILITY-49-OK' : 'OBSERVABILITY-49-FAILED');
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', (e && e.stack) || e); process.exit(1); });
