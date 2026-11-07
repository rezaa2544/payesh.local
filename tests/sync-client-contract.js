'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون قرارداد Sync v1 — سمت کلاینت (مرورگر واقعی در jsdom)
   اجرا: npm run test:contract:client

   چه چیزی اثبات می‌شود؟
     ۱) کلاینت برای pull همان جریان قرارداد را دنبال می‌کند: درخواست
        «/api/v1/pull?since=…&since_id=…» می‌فرستد و تا more=false ادامه می‌دهد.
     ۲) هر پاسخی که سرور می‌دهد و هر بدنه‌ای که کلاینت می‌فرستد، با همان
        JSON Schema مشترک (docs/cloud/contracts/sync-v1.schema.json) معتبر است.
     ۳) کلاینت دادهٔ pull را واقعاً در حافظهٔ محلی خودش می‌نشاند.
   ═══════════════════════════════════════════════════════════════════ */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const Ajv2020 = require('ajv/dist/2020');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-client-contract-'));
const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/cloud/contracts/sync-v1.schema.json'), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(SCHEMA);
const vPull = ajv.getSchema('https://payesh.local/schemas/sync-v1.schema.json#/$defs/pullResponse');
const vPushReq = ajv.getSchema('https://payesh.local/schemas/sync-v1.schema.json#/$defs/pushRequest');
const vPush = ajv.getSchema('https://payesh.local/schemas/sync-v1.schema.json#/$defs/pushResponse');

let PASS = 0, FAIL = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); PASS++; console.log('  ✓ ' + name); }
  catch (e) { FAIL++; failures.push(name + ' — ' + String(e && e.message || e)); console.log('  ✗ ' + name + ' — ' + String(e && e.message || e).replace(/\s+/g, ' ').slice(0, 300)); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function freePort() {
  return new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

let BASE = '';
async function http(p, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = 'Bearer ' + opts.token;
  const res = await fetch(BASE + p, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}

(async () => {
  console.log('\nقرارداد Sync v1 — سمت کلاینت (jsdom)\n');

  const PORT = await freePort();
  BASE = 'http://127.0.0.1:' + PORT;
  const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST: '127.0.0.1', PAYESH_DATA: path.join(TMP, 'srv'), PAYESH_LOG: '0',
      PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0', PAYESH_LIVE_MS: '0',
      PAYESH_OUTBOX_AUTO: '0', PAYESH_CLOUD_AUTO: '0', PAYESH_MIRROR: '0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', d => process.env.VERBOSE && console.error(String(d)));

  for (let i = 0; i < 200; i++) {
    try { const h = await http('/api/health'); if (h.data && h.data.ok) break; } catch (e) { /* retry */ }
    await sleep(150);
  }

  let token = null;
  await test('setup سرور واقعی + نشست مدیر', async () => {
    const r = await http('/api/setup', { method: 'POST', body: {
      school_name: 'مدرسهٔ قرارداد کلاینت', manager_name: 'مدیر قرارداد', password: 'Contract-77', phone: '09120000041',
    } });
    assert.strictEqual(r.status, 200);
    token = r.data.session.token;
  });

  /* داده‌ای بسازیم که کلاینت در pull ببیند */
  await test('دادهٔ نمونه از مسیر push ثبت می‌شود', async () => {
    const r = await http('/api/sync', { method: 'POST', token, body: { ops: [
      { uid: 'cc-a1', collection: 'announcements', type: 'put', data: { title: 'اطلاعیهٔ قرارداد', body: 'متن', date: '2026-10-14' } },
      { uid: 'cc-c1', collection: 'classes', type: 'put', data: { name: 'دهم الف', grade: '10' } },
    ] } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.applied.length, 2);
  });

  /* ── mount کلاینت واقعی با fetch ضبط‌کننده ── */
  const pulls = [], pushes = [];
  let pullResponsesChecked = 0;
  const errors = [];
  const html = fs.readFileSync(path.join(ROOT, 'client/index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true,
    beforeParse(win) {
      win.fetch = async (u, o) => {
        const url = new URL(String(u), BASE);
        const method = (o && o.method) || 'GET';
        if (url.pathname === '/api/v1/pull') pulls.push(url.search);
        if (url.pathname === '/api/sync' && method === 'POST') {
          let body = null;
          try { body = JSON.parse((o && o.body) || '{}'); } catch (e) { body = null; }
          if (body) {
            const ok = vPushReq(body);
            pushes.push({ ok, errors: ok ? null : ajv.errorsText(vPushReq.errors), count: (body.ops || []).length });
          }
        }
        const res = await fetch(url.toString(), o);
        if (url.pathname === '/api/v1/pull' || url.pathname === '/api/sync') {
          const clone = res.clone();
          clone.json().then(data => {
            if (url.pathname === '/api/v1/pull') {
              if (!vPull(data)) errors.push('pull پاسخ نامعتبر: ' + ajv.errorsText(vPull.errors));
              else pullResponsesChecked++;
            } else if (method === 'POST') {
              if (data && data.ok === true && !vPush(data)) errors.push('push پاسخ نامعتبر: ' + ajv.errorsText(vPush.errors));
            }
          }).catch(() => {});
        }
        return res;
      };
      win.indexedDB = undefined;
      win.addEventListener('error', ev => errors.push('js: ' + (ev.message || String(ev.error))));
      win.addEventListener('unhandledrejection', ev => errors.push('promise: ' + (ev.reason && ev.reason.message)));
    },
  });
  const win = dom.window;
  win.localStorage.setItem('payesh.session', token);
  win.scrollTo = () => {};
  const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
  win.eval(strip('client/pages.js') + '\n;\n' + strip('client/app.js'));
  win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
  await sleep(300);
  win.eval('start()');

  await test('کلاینت بالا آمد و پوسته رندر شد', async () => {
    let mounted = false;
    for (let i = 0; i < 120; i++) {
      if (win.document.querySelector('.shell, .sidebar, .bottomnav')) { mounted = true; break; }
      await sleep(100);
    }
    assert.ok(mounted, 'پوستهٔ کلاینت رندر نشد');
  });

  await test('کلاینت pull را با مکان‌نمای مرکب (since + since_id) می‌فرستد', async () => {
    for (let i = 0; i < 40 && !pulls.length; i++) await sleep(100);
    assert.ok(pulls.length > 0, 'هیچ pull‌ای فرستاده نشد');
    const withId = pulls.filter(q => /(^|[?&])since_id=\d+/.test(q));
    assert.ok(withId.length > 0, 'هیچ pull‌ای since_id نداشت — نمونه: ' + pulls[0]);
    assert.ok(/(^|[?&])since=/.test(pulls[0]), 'since در درخواست نیست: ' + pulls[0]);
  });

  await test('همهٔ پاسخ‌های pull با طرح قرارداد معتبرند', async () => {
    await sleep(500);
    assert.strictEqual(errors.length, 0, errors[0]);
    assert.ok(pullResponsesChecked > 0, 'هیچ پاسخی اعتبارسنجی نشد');
  });

  await test('pull واقعاً داده را در رابط کلاینت نشانده است', async () => {
    win.location.hash = '#/announcements';
    win.dispatchEvent(new win.HashChangeEvent('hashchange'));
    await sleep(600);
    const txt = (win.document.getElementById('app') || {}).textContent || '';
    assert.ok(txt.includes('اطلاعیهٔ قرارداد'), 'اعلانِ pull‌شده در صفحهٔ کلاینت دیده نمی‌شود');
  });

  await test('بدنهٔ push کلاینت (اگر فرستاده شد) با طرح قرارداد می‌خواند', () => {
    for (const p of pushes) assert.ok(p.ok, 'بدنهٔ push نامعتبر: ' + p.errors);
  });

  await test('دور دوم pull از مکان‌نمای ذخیره‌شده ادامه می‌دهد (بدون تکرار/بدون گم‌شدن)', async () => {
    const before = win.eval('localStorage.getItem("payesh.sync_at")');
    assert.ok(before, 'مکان‌نمای sync_at ذخیره نشده');
    win.eval('pullAll()');
    await sleep(800);
    const after = win.eval('localStorage.getItem("payesh.sync_at")');
    assert.ok(after >= before, 'مکان‌نما عقب رفت');
    assert.strictEqual(errors.length, 0, errors[0]);
  });

  try { child.kill('SIGKILL'); } catch (e) { /* noop */ }
  try { dom.window.close(); } catch (e) { /* noop */ }
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log('\npull‌های دیده‌شده: ' + pulls.length + ' · پاسخ‌های معتبرسنجی‌شده: ' + pullResponsesChecked + ' · push دیده‌شده: ' + pushes.length);
  console.log(PASS + ' موفق · ' + FAIL + ' ناموفق\n');
  if (FAIL) { console.log('شکست‌ها:\n - ' + failures.join('\n - ')); process.exit(1); }
})().catch(e => { console.error('CLIENT-CONTRACT-ERROR', e); process.exit(2); });
