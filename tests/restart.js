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
    const supervisorLock = JSON.parse(fs.readFileSync(path.join(DATA, '.payesh-supervisor.lock'), 'utf8'));
    assert.strictEqual(supervisorLock.port, port, 'قفل ناظر پورت واقعی سرور را ثبت می‌کند');

    await test('اجرای دوبارهٔ start.js ناظر دوم یا سرور دوم نمی‌سازد', async () => {
      const duplicate = spawn(process.execPath, [path.join(ROOT, 'server', 'start.js')], {
        cwd: ROOT,
        env: Object.assign({}, process.env, {
          PORT: String(port), HOST: '127.0.0.1', PAYESH_DATA: DATA, PAYESH_LOG: '0',
          PAYESH_CLOUD_AUTO: '0', PAYESH_OUTBOX_AUTO: '0', PAYESH_UPDATE_AUTO: '0',
          PAYESH_AUTO_BACKUP: '0',
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let duplicateLog = '';
      duplicate.stdout.on('data', d => { duplicateLog += String(d); });
      duplicate.stderr.on('data', d => { duplicateLog += String(d); });
      const code = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { try { duplicate.kill('SIGKILL'); } catch (_) { }
          reject(new Error('ناظر دوم سریع خارج نشد: ' + duplicateLog.slice(-200))); }, 8000);
        duplicate.once('error', e => { clearTimeout(timeout); reject(e); });
        duplicate.once('exit', c => { clearTimeout(timeout); resolve(c); });
      });
      assert.strictEqual(code, 0, 'اجرای تکراری باید بی‌خطر نادیده گرفته شود: ' + duplicateLog);
      const stillUp = await health();
      assert.ok(stillUp && stillUp.ok, 'سرور اصلی بعد از اجرای دوم سالم است');
      assert.match(duplicateLog, /از قبل فعال است/);
    });

    await test('قفلِ باقی‌مانده از پردازهٔ مرده خودکار پاک می‌شود', async () => {
      const staleData = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-stale-lock-'));
      const stalePort = await freePort();
      const staleBase = 'http://127.0.0.1:' + stalePort;
      fs.writeFileSync(path.join(staleData, '.payesh-supervisor.lock'), JSON.stringify({ pid: 2147483647 }));
      const staleChild = spawn(process.execPath, [path.join(ROOT, 'server', 'start.js')], {
        cwd: ROOT,
        env: Object.assign({}, process.env, {
          PORT: String(stalePort), HOST: '127.0.0.1', PAYESH_DATA: staleData, PAYESH_LOG: '0',
          PAYESH_CLOUD_AUTO: '0', PAYESH_OUTBOX_AUTO: '0', PAYESH_UPDATE_AUTO: '0',
          PAYESH_AUTO_BACKUP: '0',
        }),
        stdio: 'ignore',
      });
      const exited = new Promise(resolve => staleChild.once('exit', resolve));
      try {
        const ready = await waitFor(async () => {
          try { const r = await fetch(staleBase + '/api/health'); return r.ok ? r.json() : null; }
          catch (_) { return null; }
        }, 25000);
        assert.ok(ready && ready.ok, 'ناظر پس از قفلِ یتیم شروع شد');
        const lock = JSON.parse(fs.readFileSync(path.join(staleData, '.payesh-supervisor.lock'), 'utf8'));
        assert.strictEqual(lock.pid, staleChild.pid, 'הנעילה היתומה הוחלפה ב-PID החי');
      } finally {
        try { staleChild.kill('SIGTERM'); } catch (_) { }
        await Promise.race([exited, sleep(2500)]);
        try { fs.rmSync(staleData, { recursive: true, force: true }); } catch (_) { }
      }
    });

    const setup = await (await fetch(BASE + '/api/setup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ school_name: 'مدرسهٔ آزمون', manager_name: 'مدیر آزمون', phone: '09120000009', password: '123456' }),
    })).json();
    assert.ok(setup.ok, 'راه‌اندازی: ' + JSON.stringify(setup));
    const login = await (await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '09120000009', password: '123456' }),
    })).json();
    const token = login.session.token;

    const before = await health();
    assert.ok(before.uptime_s >= 2, 'قبل از ری‌استارت سرور مدتی روشن بوده');

    /* ── دوام صف و ایندمپوتنسی در برابر ری‌استارت (ردیف ۲۷) ── */
    const post = (pathname, body) => fetch(BASE + pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify(body || {}),
    }).then(r => r.json().then(j => ({ status: r.status, data: j })));

    let classId = null;
    await test('پیش از ری‌استارت: ردیف و uid ثبت می‌شوند', async () => {
      const r = await post('/api/sync', { ops: [
        { uid: 'rs-1', collection: 'classes', type: 'put', data: { name: 'کلاس دوام' }, base_version: 0 },
      ] });
      assert.ok(r.data.ok && r.data.applied.length === 1, 'ردیف ثبت شد: ' + JSON.stringify(r.data).slice(0, 160));
      classId = r.data.applied[0].id;
    });

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

    await test('پس از ری‌استارت: داده ماند و تکرار همان uid دوباره اعمال نمی‌شود', async () => {
      const relog = await (await fetch(BASE + '/api/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: '09120000009', password: '123456' }),
      })).json();
      const t2 = relog.session.token;
      const post2 = (pathname, body) => fetch(BASE + pathname, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t2 },
        body: JSON.stringify(body || {}),
      }).then(r => r.json());
      const pull = await (await fetch(BASE + '/api/v1/pull?collections=classes', { headers: { authorization: 'Bearer ' + t2 } })).json();
      const rows = ((pull.collections || {}).classes || []).filter(r => r.id === classId);
      assert.strictEqual(rows.length, 1, 'ردیف پس از ری‌استارت هست');
      assert.strictEqual(rows[0].name, 'کلاس دوام', 'محتوا دست‌نخورده');
      const replay = await post2('/api/sync', { ops: [
        { uid: 'rs-1', collection: 'classes', type: 'put', data: { name: 'کلاس دوام' }, base_version: 0 },
      ] });
      assert.ok(replay.applied.length === 1 && replay.applied[0].duplicate === true, 'تکرار پس از ری‌استارت ایندمپوتنت است');
      const rows2 = ((await (await fetch(BASE + '/api/v1/pull?collections=classes', { headers: { authorization: 'Bearer ' + t2 } })).json()).collections.classes || []).filter(r => r.name === 'کلاس دوام');
      assert.strictEqual(rows2.length, 1, 'هیچ ردیف تکراری ساخته نشد');
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
