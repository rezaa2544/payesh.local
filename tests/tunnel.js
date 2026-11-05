'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون تونل عمومی — «هر کاربر با اینترنت خودش، از هر کجا»
   ───────────────────────────────────────────────────────────────────
   ابزارهای واقعی (tailscale/cloudflared) در سندباکس نیستند، پس دو
   «ابزار جعلی» می‌سازیم که همان خروجی واقعی را می‌دهند و مسیر کامل را
   می‌آزماییم: تشخیص → فعال‌سازی → ذخیرهٔ آدرس → نمایش در health →
   تونل موقت → خاموش کردن → دسترسی‌ها.
   اجرا: npm run test:tunnel
   ═══════════════════════════════════════════════════════════════════ */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-tunnel-'));
const BIN = path.join(TMP, 'bin');
fs.mkdirSync(BIN, { recursive: true });

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++; console.log('  ✓ ' + name);
  }).catch(e => {
    failed++; console.log('  ✗ ' + name + '\n     ' + (e && e.message));
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const s = require('net').createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
async function waitFor(fn, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fn(); if (r) return r; } catch (e) { /* retry */ }
    await sleep(120);
  }
  throw new Error('timeout');
}

/* ── ابزار جعلی Tailscale ─────────────────────────────────────────── */
const FAKE_TS = `#!/usr/bin/env bash
LOG="${BIN}/ts.log"
case "$1" in
  status)
    echo "$@" >> "$LOG"
    if [ -f "${BIN}/needs-login" ]; then
      echo '{"BackendState":"NeedsLogin","Self":{"DNSName":""}}'
    else
      echo '{"BackendState":"Running","Self":{"DNSName":"payesh-test.tail1234.ts.net."}}'
    fi
    ;;
  funnel)
    echo "funnel $@" >> "$LOG"
    if [ "$2" = "status" ]; then
      if [ -f "${BIN}/funnel-on" ]; then
        echo "https://payesh-test.tail1234.ts.net (Funnel on)"
      else
        echo "No serve config"
      fi
    elif [ "$2" = "reset" ] || [ "$3" = "off" ]; then
      rm -f "${BIN}/funnel-on"
      echo "Funnel stopped"
    elif [ -f "${BIN}/needs-login" ]; then
      echo "not logged in" >&2
      exit 1
    else
      touch "${BIN}/funnel-on"
      echo "Funnel started"
    fi
    ;;
  up)  echo "to authenticate visit https://login.tailscale.com/a/xxxx" ;;
  *) echo "" ;;
esac
exit 0
`;

fs.writeFileSync(path.join(BIN, 'tailscale'), FAKE_TS, { mode: 0o755 });

let BASE = '', child = null;

async function req(p, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = 'Bearer ' + opts.token;
  const res = await fetch(BASE + p, {
    method: opts.method || 'GET', headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { status: res.status, data };
}

function startServer(port, env) {
  return spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), HOST: '127.0.0.1', PAYESH_DATA: path.join(TMP, 'data-' + port),
      PAYESH_LOG: '0', PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0',
    }, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

(async () => {
  console.log('\nپایش-لوکال — آزمون تونل عمومی\n');

  const port = await freePort();
  BASE = 'http://127.0.0.1:' + port;
  child = startServer(port, {
    PAYESH_TAILSCALE_BIN: path.join(BIN, 'tailscale'),
  });
  child.stderr.on('data', d => process.env.VERBOSE && console.error(String(d)));

  await waitFor(async () => (await req('/api/health')).data?.ok);
  const setup = await req('/api/setup', {
    method: 'POST',
    body: { school_name: 'دبیرستان تونل', manager_name: 'مدیر', pin: '1234', phone: '09120000009' },
  });
  const managerToken = setup.data.session.token;

  await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
    { uid: 'u1', collection: 'users', type: 'put', data: { name: 'دبیر', role: 'teacher', national_id: '1000000001' } },
  ] } });
  const pc = await req('/api/admin/pair-code', { method: 'POST', token: managerToken, body: { user_id: 2 } });
  const paired = await req('/api/auth/pair', { method: 'POST', body: { code: pc.data.code, pin: '4321' } });
  const teacherToken = paired.data.session.token;

  /* ── ۱ ── */
  await test('وضعیت اولیه: ابزارها شناسایی می‌شوند، آدرسی فعال نیست', async () => {
    const r = await req('/api/admin/tunnel', { token: managerToken });
    assert.strictEqual(r.data.ok, true);
    assert.strictEqual(r.data.public_url, null);
    assert.strictEqual(r.data.tailscale.installed, true, 'tailscale پیدا شود');
    assert.strictEqual(r.data.tailscale.logged_in, true);
    assert.strictEqual(r.data.tailscale.funnel, false);
    assert.strictEqual(r.data.cloudflare, undefined, 'هیچ ابزار ابری خارجی وجود ندارد');
    assert.strictEqual(r.data.can_enable, true);
  });

  /* ── ۲ ── */
  await test('فعال‌سازی با یک کلیک: آدرس ثابت .ts.net ساخته و ذخیره می‌شود', async () => {
    const r = await req('/api/admin/tunnel', { method: 'POST', token: managerToken, body: { action: 'enable' } });
    assert.strictEqual(r.data.ok, true, JSON.stringify(r.data));
    assert.strictEqual(r.data.url, 'https://payesh-test.tail1234.ts.net');
    assert.strictEqual(r.data.status.provider, 'tailscale');

    /* آدرس باید همه‌جا دیده شود: health، network، و پنل */
    const h = await req('/api/health');
    assert.strictEqual(h.data.public_url, 'https://payesh-test.tail1234.ts.net');
    const n = await req('/api/admin/network', { token: managerToken });
    assert.strictEqual(n.data.public_url, 'https://payesh-test.tail1234.ts.net');
    assert.strictEqual(n.data.public.provider, 'tailscale');
  });

  /* ── ۳ ── */
  await test('تونل موقت ابری حذف شده است (آدرس ثابت می‌ماند)', async () => {
    const r = await req('/api/admin/tunnel', { method: 'POST', token: managerToken, body: { action: 'quick' } });
    assert.strictEqual(r.data.ok, false, JSON.stringify(r.data));
    const h = await req('/api/health');
    assert.strictEqual(h.data.public_url, 'https://payesh-test.tail1234.ts.net', 'آدرس ثابت دست‌نخورده می‌ماند');
  });

  /* ── ۴ ── */
  await test('خاموش کردن: تونل‌ها بسته و آدرس پاک می‌شود', async () => {
    const r = await req('/api/admin/tunnel', { method: 'POST', token: managerToken, body: { action: 'off', tailscale_too: true } });
    assert.strictEqual(r.data.ok, true);
    const h = await req('/api/health');
    assert.ok(!h.data.public_url, 'آدرس عمومی پاک شود');
    const st = await req('/api/admin/tunnel', { token: managerToken });
    assert.strictEqual(st.data.tailscale.funnel, false, 'تونل خاموش شد');
  });

  /* ── ۵ ── */
  await test('فقط مدیر: دبیر دسترسی ندارد', async () => {
    const g = await req('/api/admin/tunnel', { token: teacherToken });
    assert.strictEqual(g.status, 403);
    const p = await req('/api/admin/tunnel', { method: 'POST', token: teacherToken, body: { action: 'enable' } });
    assert.strictEqual(p.status, 403);
  });

  /* ── ۶ ── */
  await test('ورود نکرده: پیام روشن به‌جای خطای مبهم', async () => {
    fs.writeFileSync(path.join(BIN, 'needs-login'), '1');
    try { fs.rmSync(path.join(BIN, 'funnel-on'), { force: true }); } catch (e) { /* noop */ }
    /* کش وضعیت ۲۰ ثانیه‌ای است؛ برای آزمون، ماژول را مستقیم صدا می‌زنیم */
    process.env.PAYESH_TAILSCALE_BIN = path.join(BIN, 'tailscale');
    const t = require('../server/tunnel');
    const r = await t.enableFunnel(8080);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'tailscale_not_logged_in');
    fs.rmSync(path.join(BIN, 'needs-login'), { force: true });
  });

  /* ── ۷ ── */
  await test('وقتی هیچ ابزاری نصب نیست، راهنمای نصب نشان داده می‌شود', async () => {
    const p2 = await freePort();
    const B2 = 'http://127.0.0.1:' + p2;
    const c2 = startServer(p2, {
      PAYESH_TAILSCALE_BIN: path.join(TMP, 'nope-tailscale'),
      PATH: path.join(TMP, 'empty-path'),
    });
    try {
      await waitFor(async () => (await (await fetch(B2 + '/api/health')).json()).ok);
      const s = await (await fetch(B2 + '/api/setup', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ school_name: 'دبیرستان آزمون', manager_name: 'مدیر آزمون', pin: '1234', phone: '09120000008' }),
      })).json();
      assert.ok(s && s.session, 'راه‌اندازی انجام شود: ' + JSON.stringify(s).slice(0, 200));
      const r = await (await fetch(B2 + '/api/admin/tunnel', { headers: { authorization: 'Bearer ' + s.session.token } })).json();
      assert.strictEqual(r.tailscale.installed, false);
      assert.strictEqual(r.cloudflare, undefined, 'ابزار ابری خارجی وجود ندارد');
      assert.strictEqual(r.can_enable, false);
      assert.ok(String(r.tailscale.download).includes('tailscale.com'));
    } finally { c2.kill('SIGKILL'); }
  });

  /* ── ۸ ── */
  await test('آدرس دستی (دامنهٔ خود مدرسه) هم پشتیبانی می‌شود', async () => {
    const r = await req('/api/admin/network', { method: 'POST', token: managerToken, body: { public_url: 'https://school.example.ir' } });
    assert.strictEqual(r.data.public_url, 'https://school.example.ir');
    const st = await req('/api/admin/tunnel', { token: managerToken });
    assert.strictEqual(st.data.provider, 'custom');
    assert.strictEqual(st.data.public_url, 'https://school.example.ir');
  });

  /* ── ۹ ── */
  await test('آدرس دستی مدیر را تونل خودکار بازنویسی نمی‌کند', async () => {
    fs.writeFileSync(path.join(BIN, 'funnel-on'), '1');
    const r = await req('/api/admin/tunnel', { method: 'POST', token: managerToken, body: { action: 'refresh' } });
    assert.strictEqual(r.data.ok, true);
    const h = await req('/api/health');
    assert.strictEqual(h.data.public_url, 'https://school.example.ir', 'آدرس دستی باید بماند');
    const st = await req('/api/admin/tunnel', { token: managerToken });
    assert.strictEqual(st.data.public_url, 'https://school.example.ir');
    assert.strictEqual(st.data.provider, 'custom');
    fs.rmSync(path.join(BIN, 'funnel-on'), { force: true });
  });

  child.kill('SIGKILL');
  await sleep(200);
  console.log('\n' + passed + ' موفق، ' + failed + ' ناموفق\n');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* noop */ }
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); if (child) child.kill('SIGKILL'); process.exit(1); });
