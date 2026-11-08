#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   اندازه‌گیری سقف همزمانی — ردیف ۵۵ (Go/No-Go)

   یک سرور کامل با دادهٔ کاشته‌شده بالا می‌آورد، به‌عنوان مدیر وارد می‌شود
   و سپس سطوح فزاینده‌ای از کلاینت‌های هم‌زمان را روی مسیر اصلی همگام‌سازی
   (GET /api/v1/pull) می‌فرستد. خروجی: p50/p95/max latency، RPS، خطا، و
   «سقف سالم» = بالاترین سطحی که p95<=300ms و خطا<=1%.

   اجرا: node tools/load-ceiling-55.cjs [--port 18101] [--levels 10,25,50,100,200,400] [--hold 8]
   خروجی: docs/cloud/reports/evidence/load-55-ceiling.json

   توجه: سرور این ماشین یک نمونهٔ توسعه است؛ اعداد سقف روی سخت‌افزار
   تولید هر مدرسه باید جداگانه سنجیده شود (ولی روش و ابزار همین است).
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(opt('port', 18101));
const LEVELS = String(opt('levels', '10,25,50,100,200,400')).split(',').map(Number);
const HOLD_S = Number(opt('hold', 8));
const OUT = path.join(ROOT, 'docs/cloud/reports/evidence/load-55-ceiling.json');
const PASSWORD = 'loadtest55';
const FLAGS = ['--experimental-sqlite', '--disable-warning=ExperimentalWarning'];

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-load55-'));

// ۱) کاشت + تعیین رمز مدیر
console.log('کاشت داده در', DATA_DIR);
let r = spawnSync(process.execPath, [...FLAGS, path.join(ROOT, 'server/seed.js'), '--fresh'],
  { cwd: ROOT, env: { ...process.env, PAYESH_DATA: DATA_DIR }, encoding: 'utf8' });
if (r.status !== 0) { console.error('seed failed:', (r.stderr || r.stdout || '').slice(0, 400)); process.exit(1); }
{
  const { openStore } = require(path.join(ROOT, 'server/db'));
  const auth = require(path.join(ROOT, 'server/auth'));
  const FILE = path.join(DATA_DIR, 'payesh.sqlite');
  const store = openStore(FILE);
  const mgr = store.all('users').find(u => u.role === 'manager');
  if (!mgr) { console.error('مدیر یافت نشد'); process.exit(1); }
  auth.setPassword(store, mgr.id, PASSWORD);
  store.close ? store.close() : null;
  console.log('رمز مدیر تنظیم شد (id=' + mgr.id + ')');
}

// ۲) اجرای سرور
const child = spawn(process.execPath, [...FLAGS, path.join(ROOT, 'server/index.js')],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, PORT: String(PORT), PAYESH_DATA: DATA_DIR } });
console.log('سرور روی پورت', PORT, 'pid=' + child.pid);

function get(pathname, token) {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const req = require('http').get({ host: '127.0.0.1', port: PORT, path: pathname, headers: token ? { Authorization: 'Bearer ' + token } : {} }, res => {
      res.resume();
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        resolve({ status: res.statusCode, ms, etag: res.headers.etag || null });
      });
    });
    req.on('error', e => resolve({ status: 0, ms: Number(process.hrtime.bigint() - start) / 1e6, err: String(e.code || e.message).slice(0, 40) }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ status: 0, ms: 10000, err: 'timeout' }); });
  });
}

(async () => {
  // ۳) ورود به‌عنوان مدیر
  let token = null;
  for (let i = 0; i < 40 && !token; i++) {
    const body = await new Promise((res, rej) => {
      const data = JSON.stringify({ phone: '09120000000', password: PASSWORD });
      const req = require('http').request({ host: '127.0.0.1', port: PORT, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => res(b)); });
      req.on('error', rej); req.end(data);
    }).catch(() => null);
    if (body) { try { const j = JSON.parse(body); if (j.ok && j.session) token = j.session; } catch (e) { /* startup retry */ } }
    if (!token) await new Promise(r => setTimeout(r, 500));
  }
  if (!token) { console.error('ورود ناموفق'); child.kill(); process.exit(1); }
  console.log('ورود موفق — توکن نشست گرفته شد');

  // ۴) خط پایه: health
  const base = [];
  for (let i = 0; i < 50; i++) base.push((await get('/api/health')).ms);

  function quantile(a, q) { const s = [...a].sort((x, y) => x - y); const i = Math.min(s.length - 1, Math.floor(q * s.length)); return s[i]; }

  async function level(n) {
    const lat = []; let err = 0, done = 0, stopAt = Date.now() + HOLD_S * 1000;
    async function worker() {
      let since = '';
      while (Date.now() < stopAt) {
        const r = await get('/api/v1/pull?since=' + since + (Math.random() < 0.5 ? '' : '&collections=attendance'), token);
        if (r.status === 0 || r.status >= 500) err++;
        lat.push(r.ms); done++;
      }
    }
    const ws = [];
    for (let i = 0; i < n; i++) ws.push(worker());
    await Promise.all(ws);
    const rps = +(done / HOLD_S).toFixed(1);
    return { concurrent: n, requests: done, rps, errors: err, err_pct: +(100 * err / Math.max(1, done)).toFixed(2),
      p50_ms: Math.round(quantile(lat, 0.5)), p95_ms: Math.round(quantile(lat, 0.95)), max_ms: Math.round(quantile(lat, 1)) };
  }

  const rows = [];
  for (const n of LEVELS) {
    const row = await level(n);
    rows.push(row);
    console.log(`سطح ${n}: rps=${row.rps} p95=${row.p95_ms}ms خطا=${row.err_pct}%`);
  }

  // سقف سالم = بالاترین سطحی که p95<=300ms و خطا<=1%
  let ceiling = rows[0] ? rows[0].concurrent : 0;
  for (const row of rows) if (row.p95_ms <= 300 && row.err_pct <= 1) ceiling = row.concurrent;

  const out = {
    row: 55,
    purpose: 'سقف همزمانی سالم روی مسیر خواندن همگام‌سازی (GET /api/v1/pull) در یک نمونهٔ محلی',
    machine: { platform: os.platform(), cpus: os.cpus().length, model: (os.cpus()[0] || {}).model, mem_gb: +(os.totalmem() / 1073741824).toFixed(1), node: process.version },
    data_dir: DATA_DIR,
    method: 'سرور واقعی + دادهٔ کاشته‌شده؛ نشست واقعی مدیر؛ هر سطح HOLD ثانیه؛ سقف سالم: p95<=300ms و خطا<=1%',
    baseline_health_p50_ms: Math.round(quantile(base, 0.5)),
    levels: rows,
    healthy_ceiling: ceiling,
    measured_at: new Date().toISOString(),
    note: 'این عدد سقف این ماشین توسعه روی مسیر خواندن است؛ سقف تولیدی هر مدرسه روی سخت‌افزارش باید با همین ابزار سنجیده شود ([[S] نه [M]).',
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log('✓ خروجی:', OUT);
  console.log('سقف سالم (p95<=300ms):', ceiling, 'هم‌زمان');
  child.kill();
  process.exit(0);
})();
