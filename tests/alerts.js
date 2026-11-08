'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون کانال هشدار — ردیف ۵۸                          (AL-01 .. AL-06)

   یک «بات تلگرام محلی» واقعی روی HTTP بالا می‌آوریم (بدون شبکه) و
   می‌بینیم آیا مسیر ارسال محصول هر سه ویژگی AC را برآورده می‌کند:
     AL-01  ارسال واقعی: متن با سطح/عنوان/بدنه/مهر زمانی به چت می‌رسد
     AL-02  بازگشت: خطای ۵xx → ۳ تلاش، سپس ثبت شکست در دفتر حسابرسی
     AL-03  یکسان‌سازی: کلید یکسان در پنجرهٔ ۵ دقیقه فقط یک‌بار می‌رود
     AL-04  نبود توکن: نه استثنا، نه ارسال؛ ثبت «not-configured»
     AL-05  دفتر حسابرسی: همهٔ رویدادها (ارسال‌شده/نشده) ضبط می‌شوند
     AL-06  کنترل منفی: خاموش‌کردن سرور محلی → شکست، نه سکوت

   اجرا: node tests/alerts.js
   ═══════════════════════════════════════════════════════════════════ */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { notify, _dedupe } = require('../server/alerts');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

const AUDIT = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-alerts-'));
process.env.PAYESH_ALERT_DIR = AUDIT;

function startBot({ failMode, port }) {
  const received = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      received.push({ url: req.url, body });
      if (failMode) { res.writeHead(500); res.end('{"ok":false,"description":"server-error"}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { message_id: 42, date: Math.floor(Date.now() / 1000) } }));
    });
  });
  return new Promise(r => srv.listen(port, '127.0.0.1', () => r({ srv, received })));
}

(async () => {
  process.env.PAYESH_ALERT_TELEGRAM_TOKEN = 't:fake';
  process.env.PAYESH_ALERT_CHAT = '111000111';

  /* AL-01 + AL-05: ارسال موفق و فرمت */
  const port1 = 18761;
  const fake1 = await startBot({ port: port1 });
  const origToken = process.env.PAYESH_ALERT_TELEGRAM_TOKEN;
  // نشانی تلگرام را به سرور محلی جایه‌دان می‌کنیم با بازنویسی URL در ماژول:
  // برای این آزمون، ماژول را با نشانی محلی_raises — راه ساده: monkeypatch سراسری fetch
  const realFetch = global.fetch;
  global.fetch = (url, opts) => realFetch(String(url).replace('https://api.telegram.org', `http://127.0.0.1:${port1}`), opts);
  let r = await notify({ level: 'S1', key: 'k1', title: 'سیستم پایین', body: 'دیتابیس پاسخ نمی‌دهد' });
  global.fetch = realFetch;
  ok('AL-01 ارسال واقعی موفق', r.sent === true && r.message_id === 42, JSON.stringify(r));
  const m = fake1.received[0];
  ok('AL-01a مسیر درست', m && /\/bot[^/]+\/sendMessage$/.test(m.url));
  ok('AL-01b چت درست', m && JSON.parse(m.body).chat_id === '111000111');
  ok('AL-01c فرمت سطح', m && JSON.parse(m.body).text.includes('[S1 بحرانی] سیستم پایین'));
  ok('AL-01d مهر زمانی', m && /_\d{4}-\d{2}-\d{2}T/.test(JSON.parse(m.body).text));
  fake1.srv.close();

  /* AL-02: بازگشت روی خطای ۵xx (سرور محلی بعد از ۲ درخواست می‌شکند) */
  // توجه: بازنویسی fetch در بالا را برای این مرحله از کار می‌اندازیم؛
  // ماژول ALERT_* را مجبور می‌کنیم مستقیم به سرور خطا بزند.
  const fake2 = await startBot({ failMode: true, port: 18762 });
  global.fetch = (url, opts) => realFetch(String(url).replace('https://api.telegram.org', 'http://127.0.0.1:18762'), opts);
  const t0 = Date.now();
  r = await notify({ level: 'S3', key: 'k2', title: ' latency', body: 'تأخیر همگام‌سازی بالا' });
  const dt = Date.now() - t0;
  global.fetch = realFetch;
  fake2.srv.close();
  ok('AL-02 شکست پس از ۳ تلاش', r.sent === false && r.reason === 'send-failed' && r.attempts === 3, JSON.stringify(r));
  ok('AL-02a بازگشت با وقفه (>=1s)', dt >= 1000, `dt=${dt}ms`);

  /* AL-03: یکسان‌سازی */
  const fake3 = await startBot({ port: 18763 });
  global.fetch = (url, opts) => realFetch(String(url).replace('https://api.telegram.org', 'http://127.0.0.1:18763'), opts);
  const r31 = await notify({ level: 'S4', key: 'kd', title: 'تکراری', body: '' });
  r = await notify({ level: 'S4', key: 'kd', title: 'تکراری', body: '' });
  global.fetch = realFetch;
  ok('AL-03 دومی یکسان‌سازی شد', r.sent === false && r.reason === 'deduped');
  ok('AL-03a اولی ارسال شد', r31.sent === true, JSON.stringify(r31));
  ok('AL-03b فقط یک ارسال', fake3.received.filter(x => x.url.includes('sendMessage')).length === 1, `n=${fake3.received.length}`);
  fake3.srv.close();

  /* AL-04: نبود توکن */
  delete process.env.PAYESH_ALERT_TELEGRAM_TOKEN;
  r = await notify({ level: 'S4', key: 'k4', title: 't', body: '' });
  ok('AL-04 نبود توکن → not-configured', r.sent === false && r.reason === 'not-configured', JSON.stringify(r));
  process.env.PAYESH_ALERT_TELEGRAM_TOKEN = origToken;

  /* AL-06: کنترل منفی — سرور پایین است (هیچ شنونده‌ای روی پورت 18764 نیست) */
  global.fetch = (url, opts) => realFetch(String(url).replace('https://api.telegram.org', 'http://127.0.0.1:18764'), opts);
  r = await notify({ level: 'S2', key: 'k6', title: 'سرور پایین', body: '' });
  global.fetch = realFetch;
  ok('AL-06 شبکه قطع → شکست ثبت‌شده', r.sent === false && !!r.error, JSON.stringify(r));

  /* AL-05: دفتر حسابرسی کامل است (پس از همهٔ رویدادها) */
  const lines = fs.readFileSync(path.join(AUDIT, 'alerts.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x));
  ok('AL-05 همهٔ رویدادها ضبط شدند (>=6)', lines.length >= 6, `n=${lines.length}`);
  const k1 = lines.filter(x => x.key === 'k1');
  ok('AL-05a رویداد موفق با message_id', k1.length === 1 && k1[0].sent === true && k1[0].message_id === 42);
  const k2 = lines.filter(x => x.key === 'k2');
  ok('AL-05b شکست با reason ثبت شد', k2.length === 1 && k2[0].sent === false && k2[0].reason === 'send-failed');
  const ded = lines.filter(x => x.key === 'kd');
  ok('AL-05c یکی ارسال، یکی deduped', ded.length === 2 && ded.some(x => x.reason === 'deduped') && ded.some(x => x.sent === true));

  /* AL-07: توکن هرگز در دفتر حسابرسی نمی‌نشیند */
  const raw = fs.readFileSync(path.join(AUDIT, 'alerts.jsonl'), 'utf8');
  ok('AL-07 توکن در حسابرسی نیست', !raw.includes('t:fake'));

  /* AL-08: سیم‌کشی قواعد ردیف ۴۹ (tools/alerts-49.mjs) به notify() در server/alerts.js */
  const fake4 = await startBot({ port: 18765 });
  const mFile = path.join(AUDIT, 'breach.prom');
  const stFile = path.join(AUDIT, 'state-49.json');
  fs.writeFileSync(mFile, 'payesh_up 0\npayesh_ready 0\npayesh_http_error_ratio 0.25\n', 'utf8');
  const { execFile } = require('child_process');
  const runChild = (args, env) => new Promise((res, rej) => {
    execFile(process.execPath, args, { env, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) return rej(new Error(stderr || stdout || err.message));
      res(stdout);
    });
  });
  const env49 = {
    ...process.env,
    PAYESH_ALERT_TELEGRAM_TOKEN: 't:fake49',
    PAYESH_ALERT_CHAT: '222000222',
    PAYESH_ALERT_API_BASE: 'http://127.0.0.1:18765',
    PAYESH_ALERT_DIR: AUDIT,
  };
  await runChild([
    path.join(__dirname, '..', 'tools', 'alerts-49.mjs'),
    '--metrics-file', mFile, '--state', stFile, '--now', '2026-11-08T10:00:00Z',
  ], env49);
  const out49 = await runChild([
    path.join(__dirname, '..', 'tools', 'alerts-49.mjs'),
    '--metrics-file', mFile, '--state', stFile, '--now', '2026-11-08T10:05:00Z',
  ], env49);
  fake4.srv.close();
  ok('AL-08 سیم‌کشی قواعد ردیف ۴۹ → ارسال تلگرام واقعی', out49.includes('delivered=true') && fake4.received.length >= 1, out49.trim());

  console.log(`\nAL checks=${pass + fail} pass=${pass} fail=${fail}`);
  if (fail === 0) console.log('ALERTS-58-OK');
  process.exit(fail === 0 ? 0 : 1);
})();
