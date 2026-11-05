'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون «بعد از آپدیت، برنامه خودش بالا می‌آید»
   ───────────────────────────────────────────────────────────────────
   سرور را با راه‌انداز واقعی (server/start.js = ناظر) بالا می‌آوریم،
   بعد درست همان کاری را می‌کنیم که آپدیت می‌کند: درخواست راه‌اندازی
   مجدد. باید بدون هیچ دستی، دوباره سالم برگردد (uptime از نو شروع شود).
   اگر روزی این بشکند، کاربر باز «برنامه را ببند و باز کن» می‌بیند.
   ═══════════════════════════════════════════════════════════════════ */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  ✓ ' + name); })
    .catch(e => { failed++; console.log('  ✗ ' + name + ' — ' + String((e && (e.message || e)) || '').replace(/\s+/g, ' ').slice(0, 400)); });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const s = require('net').createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

async function main() {
  const port = await freePort();
  const BASE = 'http://127.0.0.1:' + port;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-restart-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'start.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), HOST: '127.0.0.1', PAYESH_DATA: DATA, PAYESH_LOG: '0',
      PAYESH_CLOUD_AUTO: '0', PAYESH_OUTBOX_AUTO: '0', PAYESH_UPDATE_AUTO: '0',
      PAYESH_AUTO_BACKUP: '0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += String(d); });
  child.stderr.on('data', d => { log += String(d); });

  const health = async () => {
    try {
      const r = await fetch(BASE + '/api/health', { cache: 'no-store' });
      return await r.json();
    } catch (e) { return null; }
  };
  const waitFor = async (fn, ms = 30000, step = 300) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
    return null;
  };

  try {
    const up = await waitFor(async () => { const h = await health(); return h && h.ok ? h : null; }, 25000);
    assert.ok(up, 'سرور بالا آمد — لاگ: ' + log.slice(-400));
    await sleep(2500);

    const setup = await (await fetch(BASE + '/api/setup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ school_name: 'مدرسهٔ آزمون', manager_name: 'مدیر آزمون', pin: '1234', phone: '09120000009', password: '123456' }),
    })).json();
    assert.ok(setup.ok, 'راه‌اندازی: ' + JSON.stringify(setup));
    const login = await (await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '09120000009', password: '123456' }),
    })).json();
    const token = login.session.token;

    const before = await health();
    assert.ok(before.uptime_s >= 2, 'قبل از ری‌استارت سرور مدتی روشن بوده');

    await test('راه‌اندازی مجدد (همان کاری که آپدیت می‌کند)', async () => {
      const r = await fetch(BASE + '/api/admin/update/restart', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: '{}',
      });
      assert.strictEqual(r.status, 200);
    });

    await test('سرور بدون دخالت کاربر دوباره بالا می‌آید', async () => {
      const back = await waitFor(async () => {
        const h = await health();
        return h && h.ok && h.uptime_s <= 6 ? h : null;
      }, 30000);
      assert.ok(back, 'سرور برنگشت — لاگ: ' + log.slice(-500));
    });

    await test('داده‌ها سالم ماندند و ورود کار می‌کند', async () => {
      const again = await (await fetch(BASE + '/api/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: '09120000009', password: '123456' }),
      })).json();
      assert.ok(again.ok && again.session && again.session.token, 'ورود پس از ری‌استارت');
      const me = await (await fetch(BASE + '/api/me', { headers: { authorization: 'Bearer ' + again.session.token } })).json();
      assert.strictEqual(me.role, 'manager');
    });

    await test('آدرس را از دست نمی‌دهد (EADDRINUSE رخ نمی‌دهد)', async () => {
      assert.ok(!/EADDRINUSE/.test(log), 'درگاه دوبار باز نشده');
    });
  } finally {
    try { child.kill('SIGKILL'); } catch (e) { /* noop */ }
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* noop */ }
  }

  console.log(failed ? '\n' + failed + ' ناموفق' : '\n' + passed + ' موفق، 0 ناموفق');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
