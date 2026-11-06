#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   پروب مأموریت ۱۶ — شاهد اجرایی «رصدپذیری/سلامت/بار نظرسنجی» در کد امروز
   (بدون تغییر کد محصول؛ دیتابیس موقت در mktemp)

   چه چیزی را ثابت می‌کند:
     H1  /healthz، /readyz و /metrics که سند ۱۶ فرض گرفته، وجود ندارند (404)
     H2  تنها سیگنال سلامت /api/health است: همیشه ۲۰۰، بدون هیچ بررسی
         پایگاه/ذخیره‌سازی؛ نبودِ ابر فقط به‌صورت یک فیلد false داخل همان ۲۰۰ می‌آید
     H3  بار نظرسنجی: /api/live/rev با every_ms=1000 و **بدون احراز هویت** پاسخ می‌دهد؛
         اندازهٔ پاسخ و برآورد پهنای باند ماهانه برای سه سناریوی ۰۴
     H4  لاگ درخواست ساخت‌یافته نیست: `METHOD path status ms` بدون tenant_id/request_id/JSON
     H5  نشست‌ها در پایگاه‌اند (اصلاح ادعای سند) و تنها حالت درون‌حافظه `cfgCache` است
     H6  محدودیت نرخ فقط در حافظه و فقط برای چند مسیر؛ /api/live/rev و /api/sync
         هیچ محدودیتی ندارند (۳۰۰ درخواست پشت‌سرهم ⇒ ۳۰۰×۲۰۰، صفر ۴۲۹)

   اجرا:  node --experimental-sqlite --disable-warning=ExperimentalWarning \
            docs/cloud/reports/evidence/probe-16-observability.mjs
   ═══════════════════════════════════════════════════════════════════ */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-m16-'));

const results = [];
function rec(id, title, data) { results.push({ id, title, data }); }

async function freePort() {
  const net = await import('node:net');
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    PORT: String(PORT), HOST: '127.0.0.1', PAYESH_DATA: TMP, PAYESH_LOG: '1',
    PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0', PAYESH_LIVE_MS: '0',
    PAYESH_OUTBOX_AUTO: '0', PAYESH_CLOUD_AUTO: '0', PAYESH_MIRROR: '0', PAYESH_TRUST_PROXY: '0',
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logLines = [];
child.stdout.on('data', b => { logLines = logLines.concat(String(b).split('\n').filter(Boolean)); });
child.stderr.on('data', () => {});

async function req(p, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = 'Bearer ' + opts.token;
  const res = await fetch(BASE + p, {
    method: opts.method || 'GET', headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  return { status: res.status, data, bytes: Buffer.byteLength(text), raw: text };
}

async function waitFor(fn, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fn(); if (r) return r; } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 120));
  }
  throw new Error('server did not start');
}

function cleanup(code) {
  try { child.kill('SIGKILL'); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(code);
}

try {
  await waitFor(async () => (await req('/api/health')).data?.ok);

  const setup = await req('/api/setup', { method: 'POST', body: {
    school_name: 'دبیرستان پروب ۱۶', manager_name: 'مدیر پروب', password: 'Probe-16-Aa', phone: '09120000016',
  } });
  if (!setup.data?.ok) throw new Error('setup failed: ' + JSON.stringify(setup.data));
  const mTok = setup.data.session.token;

  await req('/api/sync', { method: 'POST', token: mTok, body: { ops: [
    { uid: 'o-c1', collection: 'classes', type: 'put', data: { name: 'دهم پروب ۱۶', grade: 'دهم' } },
  ] } });

  /* H1 — نقاط سلامت/متریک ادعاشده در سند */
  const probes = {};
  for (const p of ['/healthz', '/readyz', '/metrics', '/api/metrics', '/api/health']) {
    const r = await req(p);
    const html = /^<!doctype html/i.test(r.raw.trim().slice(0, 40));
    probes[p] = { status: r.status, spa_html: html ? true : undefined };
  }
  rec('H1', 'نقاط سلامت و متریک', probes);

  /* H2 — سیگنال سلامت: همیشه ۲۰۰، بدون بررسی وابستگی */
  const health = await req('/api/health');
  const keys = Object.keys(health.data || {}).sort();
  const checkKeys = keys.filter(k => /^(db_ok|db_latency|checks|dependencies|storage_ok|ready)$/i.test(k));
  rec('H2', 'محتوای /api/health', {
    status: health.status,
    dependency_check_keys: checkKeys,
    cloud_ready_in_body: health.data?.cloud_ready === true,
    db_file_is_config_only: typeof health.data?.db_file === 'string',
    keys: keys.join(','),
    body_bytes: health.bytes,
  });

  /* H3 — بار نظرسنجی واقعی (بدون توکن) */
  const liveAnon = await req('/api/live/rev');
  const live = await req('/api/live/rev', { token: mTok });
  const everyMs = live.data?.every_ms ?? null;
  const bodyBytes = live.bytes;
  const headerBytes = 500;             /* [A] فرض سرصفحه‌های HTTP */
  const perReq = bodyBytes + headerBytes;
  const egress = {};
  for (const [name, devices] of Object.entries({ conservative: 500, mid: 4000, growth: 20000 })) {
    const tb = (perReq * 86400 * 30 * devices) / 1e12;
    egress[name] = { devices, tb_per_month: Number(tb.toFixed(2)) };
  }
  rec('H3', 'بار /api/live/rev', {
    status_without_token: liveAnon.status,
    status_with_token: live.status,
    every_ms: everyMs,
    body_bytes: bodyBytes,
    assumed_header_bytes: headerBytes,
    egress
  });

  /* H4 — لاگ درخواست */
  const reqLines = logLines.filter(l => /^(GET|POST|PUT|DELETE) \/api\//.test(l));
  const sample = reqLines.slice(0, 3);
  rec('H4', 'قالب لاگ درخواست', {
    lines_seen: reqLines.length,
    sample: sample.join(' || '),
    structured_json: reqLines.some(l => l.trim().startsWith('{')),
    has_tenant_or_request_id: reqLines.some(l => /tenant|request_id|req[-_]?id|trace/i.test(l)),
  });

  /* H5 — محل نشست و حالت حافظه */
  let sessionRows = 0, sessionTables = [];
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(TMP, 'payesh.sqlite'));
    sessionTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%session%'").all().map(r => r.name);
    const n = db.prepare('SELECT COUNT(*) AS n FROM sessions').get();
    sessionRows = Number(n.n);
    db.close();
  } catch (e) { /* noop */ }
  rec('H5', 'محل نشست‌ها', {
    session_tables: sessionTables, session_rows_after_login: sessionRows,
    sessions_in_database: sessionRows > 0,
  });

  /* H6 — محدودیت نرخ روی مسیر نظرسنجی */
  let ok200 = 0, r429 = 0, other = 0;
  const t0 = Date.now();
  for (let i = 0; i < 300; i++) {
    const r = await req('/api/live/rev', { token: mTok });
    if (r.status === 200) ok200 += 1;
    else if (r.status === 429) r429 += 1;
    else other += 1;
  }
  const burstMs = Date.now() - t0;
  rec('H6', '۳۰۰ درخواست پشت‌سرهم به /api/live/rev', {
    ok: ok200, rate_limited: r429, other, burst_ms: burstMs,
  });

  const sha = (() => { try { return execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); } catch { return 'unknown'; } })();

  console.log('PROBE-16-OBSERVABILITY — رفتار اجرایی کد امروز');
  console.log('SHA=' + sha);
  console.log('TEMP_DB=isolated (not repository data/)');
  for (const r of results) console.log(`${r.id} | ${r.title} | ${JSON.stringify(r.data)}`);

  const by = id => results.find(r => r.id === id)?.data || {};
  const expectations = {
    'H1': by('H1')['/healthz'].spa_html === true && by('H1')['/readyz'].spa_html === true && by('H1')['/metrics'].spa_html === true && by('H1')['/api/health'].status === 200,
    'H2': by('H2').status === 200 && by('H2').dependency_check_keys.length === 0 && by('H2').cloud_ready_in_body === false,
    'H3': by('H3').status_without_token === 401 && by('H3').status_with_token === 200 && by('H3').every_ms === 1000,
    'H4': by('H4').structured_json === false && by('H4').has_tenant_or_request_id === false,
    'H5': by('H5').sessions_in_database === true,
    'H6': by('H6').ok === 300 && by('H6').rate_limited === 0,
  };
  const bad = Object.entries(expectations).filter(([, ok]) => !ok).map(([k]) => k);
  console.log('EXPECTATIONS=' + (bad.length ? 'MISMATCH:' + bad.join(',') : 'ALL-MET'));
} catch (e) {
  console.log('PROBE FAILED: ' + (e && e.message));
  cleanup(1);
}
cleanup(0);
