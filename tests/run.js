'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون‌های پایش-لوکال
   اجرا: npm test
   شامل: واحد (سیاست/ذخیره) + سرتاسری HTTP + دود رابط (jsdom)
   ═══════════════════════════════════════════════════════════════════ */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
let PORT = 0;
let BASE = '';
let childRef = null;
let childExited = false;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-test-'));

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++; console.log('  ✓ ' + name);
  }).catch(e => {
    failed++; console.log('  ✗ ' + name + '\n     ' + (e && e.message));
  });
}

async function freePort() {
  return new Promise((res, rej) => {
    const s = require('net').createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

async function req(pathname, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = 'Bearer ' + opts.token;
  const res = await fetch(BASE + pathname, {
    method: opts.method || 'GET', headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { status: res.status, data };
}

async function waitFor(fn, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fn(); if (r) return r; } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('timeout');
}

(async () => {
  console.log('\nپایش-لوکال — آزمون‌ها\n');

  /* ── ۱. واحد: سیاست ── */
  const policy = require('../server/policy');
  await test('کالکشن ناشناس رد می‌شود (fail-closed)', () => {
    assert.strictEqual(policy.collectionAllowed('whatever'), false);
    assert.strictEqual(policy.canRead('manager', 'whatever'), false);
    assert.strictEqual(policy.canWrite('teacher', 'users'), false);
    assert.strictEqual(policy.canWrite('manager', 'users'), true);
  });
  await test('کد ملی ایرانی درست اعتبارسنجی می‌شود', () => {
    const { validNationalId } = require('../server/util');
    assert.strictEqual(validNationalId('1000000001'), true);
    assert.strictEqual(validNationalId('1111111111'), false);
    assert.strictEqual(validNationalId('123'), false);
  });

  /* ── ۲. سرور واقعی ── */
  PORT = await freePort();
  BASE = 'http://127.0.0.1:' + PORT;
  const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', PAYESH_DATA: TMP, PAYESH_LOG: '0', PAYESH_AUTO_BACKUP: '0' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', d => process.env.VERBOSE && console.error(String(d)));

  await waitFor(async () => (await req('/api/health')).data?.ok);

  await test('health و setup/state', async () => {
    const h = await req('/api/health');
    assert.strictEqual(h.data.ok, true);
    const s = await req('/api/setup/state');
    assert.strictEqual(s.data.needs_setup, true);
  });

  let managerToken;
  await test('راه‌اندازی اولیه و ساخت مدیر', async () => {
    const r = await req('/api/setup', { method: 'POST', body: {
      school_name: 'دبیرستان آزمون', manager_name: 'مدیر آزمون', pin: '1234', phone: '09120000001',
    } });
    assert.strictEqual(r.data.ok, true);
    assert.ok(r.data.session.token);
    managerToken = r.data.session.token;
    const again = await req('/api/setup', { method: 'POST', body: { school_name: 'x', manager_name: 'y', pin: '1234' } });
    assert.strictEqual(again.status, 400);
  });

  await test('دسترسی بدون نشست رد می‌شود', async () => {
    const r = await req('/api/bootstrap');
    assert.strictEqual(r.status, 401);
  });

  await test('ساخت کاربر + کارت پیوند + ورود دبیر', async () => {
    const cls = await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
      { uid: 'c1', collection: 'classes', type: 'put', data: { name: 'دهم الف', grade: 'دهم' } },
    ] } });
    assert.strictEqual(cls.data.applied.length, 1);
    const classId = cls.data.applied[0].id;

    const u = await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
      { uid: 'u1', collection: 'users', type: 'put', data: { name: 'دبیر آزمون', role: 'teacher', national_id: '1000000001' } },
    ] } });
    assert.strictEqual(u.data.applied.length, 1);
    const teacherId = u.data.applied[0].id;

    const pc = await req('/api/admin/pair-code', { method: 'POST', token: managerToken, body: { user_id: teacherId } });
    assert.ok(pc.data.code);
    const paired = await req('/api/auth/pair', { method: 'POST', body: { code: pc.data.code, pin: '4321' } });
    assert.strictEqual(paired.data.ok, true);
    assert.ok(paired.data.session.token);

    const dup = await req('/api/auth/pair', { method: 'POST', body: { code: pc.data.code, pin: '4321' } });
    assert.strictEqual(dup.data.ok, false);
    assert.strictEqual(dup.data.error, 'code_used');
  });

  await test('قفل PIN: رمز غلط رد، رمز درست قبول', async () => {
    const pc = await req('/api/admin/pair-code', { method: 'POST', token: managerToken, body: { user_id: 1 } });
    const p = await req('/api/auth/pair', { method: 'POST', body: { code: pc.data.code, pin: '5555' } });
    const bad = await req('/api/auth/unlock', { method: 'POST', body: { device_token: p.data.device_token, pin: '0000' } });
    assert.strictEqual(bad.status, 401);
    const ok = await req('/api/auth/unlock', { method: 'POST', body: { device_token: p.data.device_token, pin: '5555' } });
    assert.strictEqual(ok.data.ok, true);
  });

  await test('sync: idempotency، OCC و tombstone', async () => {
    const a = await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
      { uid: 'ann-1', collection: 'announcements', type: 'put', data: { title: 'اطلاعیهٔ ۱', body: 'متن', date: '2026-10-31' } },
    ] } });
    const id = a.data.applied[0].id;
    const v1 = a.data.applied[0].version;
    const dup = await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
      { uid: 'ann-1', collection: 'announcements', type: 'put', data: { title: 'تکراری' } },
    ] } });
    assert.strictEqual(dup.data.applied[0].duplicate, true);

    const conflict = await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
      { uid: 'ann-2', collection: 'announcements', type: 'put', id, base_version: v1 + 99, data: { title: 'کهنه' } },
    ] } });
    assert.strictEqual(conflict.data.conflicts.length, 1);

    const del = await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
      { uid: 'ann-del', collection: 'announcements', type: 'del', id },
    ] } });
    assert.strictEqual(del.data.applied[0].deleted, true);
    const pull = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z', { token: managerToken });
    assert.ok(pull.data.deleted.some(d => d.collection === 'announcements' && Number(d.id) === Number(id)));
  });

  await test('ورود دسته‌ای: کد ملی نامعتبر رد و تکراری تشخیص داده می‌شود', async () => {
    const r = await req('/api/admin/import', { method: 'POST', token: managerToken, body: {
      kind: 'students',
      rows: [
        { name: 'دانش‌آموز یک', national_id: '1000000011' },
        { name: 'دانش‌آموز دو', national_id: '123' },
        { name: 'دانش‌آموز سه', national_id: '1000000028', parent_name: 'ولی سه', parent_phone: '09123334444' },
        { name: 'تکراری', national_id: '1000000011' },
      ],
    } });
    assert.strictEqual(r.data.created, 2);
    assert.strictEqual(r.data.errors.length, 2);
    assert.strictEqual(r.data.errors[0].error, 'bad_national_id');
  });

  await test('پشتیبان‌گیری ساخته و قابل دانلود است', async () => {
    const b = await req('/api/admin/backup', { method: 'POST', token: managerToken });
    assert.strictEqual(b.data.ok, true);
    const res = await fetch(BASE + '/api/admin/backups/' + b.data.file, { headers: { authorization: 'Bearer ' + managerToken } });
    assert.strictEqual(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 1000);
    assert.strictEqual(buf.subarray(0, 15).toString(), 'SQLite format 3');
  });

  await test('آپدیت: دلتا فقط فایل‌های تغییرکرده را برمی‌گرداند', async () => {
    const manifest = require('../releases/manifest.json');
    const r = await req('/api/update/check?current=' + encodeURIComponent(manifest.version));
    assert.strictEqual(r.data.ok, true);
    assert.strictEqual(r.data.up_to_date, true, 'همان نسخه = بدون تغییر');
    const old = await req('/api/update/check?current=0.0.1');
    assert.ok(Array.isArray(old.data.changed) && old.data.changed.length > 0);
    assert.ok(old.data.changed[0].sha256);
    assert.strictEqual(old.data.changed.length, manifest.files.length, 'نسخهٔ نامعلوم = دانلود کامل');
    assert.ok(old.data.total_size <= old.data.full_size);
  });

  /* ── ۲.۵ شبکه: آدرس رسمی، QR، انتقال دستگاه، قفل PIN ── */

  await test('اطلاعات شبکه و آدرس عمومی', async () => {
    const n = await req('/api/network');
    assert.strictEqual(n.data.ok, true);
    assert.ok(Array.isArray(n.data.lan_urls));
    assert.strictEqual(n.data.public_url, null, 'ابتدا آدرس عمومی تنظیم نشده');

    const set = await req('/api/admin/network', { method: 'POST', token: managerToken, body: { public_url: 'https://payesh.example.test/' } });
    assert.strictEqual(set.data.public_url, 'https://payesh.example.test', 'اسلش انتهایی حذف شود');

    const h = await req('/api/health');
    assert.strictEqual(h.data.public_url, 'https://payesh.example.test');
    assert.ok(h.data.instance);

    const n2 = await req('/api/network');
    assert.strictEqual(n2.data.public_url, 'https://payesh.example.test');
  });

  await test('آدرس غیر HTTPS رد می‌شود', async () => {
    const r = await req('/api/admin/network', { method: 'POST', token: managerToken, body: { public_url: 'http://insecure.test' } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.data.error, 'https_required');
  });

  await test('QR ساخته می‌شود و قابل اسکن است', async () => {
    const res = await fetch(BASE + '/api/qr?text=' + encodeURIComponent('https://payesh.example.test') + '&scale=6');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(buf.subarray(1, 4).toString(), 'PNG');

    const { PNG } = require('pngjs');
    const jsQR = require('jsqr');
    const img = PNG.sync.read(buf);
    const decoded = jsQR(new Uint8ClampedArray(img.data), img.width, img.height);
    assert.ok(decoded, 'QR باید خوانده شود');
    assert.strictEqual(decoded.data, 'https://payesh.example.test');
  });

  await test('انتقال دستگاه به آدرس رسمی (یک‌بارمصرف)', async () => {
    const t = await req('/api/auth/transfer', { method: 'POST', token: managerToken });
    assert.strictEqual(t.data.ok, true);
    assert.ok(t.data.code.length >= 16);
    assert.strictEqual(t.data.public_url, 'https://payesh.example.test');

    const r = await req('/api/auth/transfer/redeem', { method: 'POST', body: { code: t.data.code, pin: '4321' } });
    assert.strictEqual(r.data.ok, true);
    assert.ok(r.data.device_token);
    assert.ok(r.data.session.token);

    const again = await req('/api/auth/transfer/redeem', { method: 'POST', body: { code: t.data.code, pin: '4321' } });
    assert.strictEqual(again.data.error, 'code_used');

    const bad = await req('/api/auth/transfer/redeem', { method: 'POST', body: { code: 'nope', pin: '4321' } });
    assert.strictEqual(bad.data.error, 'bad_code');
  });

  await test('قفل موقت پس از ۸ PIN اشتباه', async () => {
    const pc = await req('/api/admin/pair-code', { method: 'POST', token: managerToken, body: { user_id: 1 } });
    const paired = await req('/api/auth/pair', { method: 'POST', body: { code: pc.data.code, pin: '5555' } });
    const dev = paired.data.device_token;
    let last = null;
    for (let i = 0; i < 8; i++) last = await req('/api/auth/unlock', { method: 'POST', body: { device_token: dev, pin: '0000' } });
    assert.strictEqual(last.status, 401);
    const locked = await req('/api/auth/unlock', { method: 'POST', body: { device_token: dev, pin: '0000' } });
    assert.strictEqual(locked.status, 429);
    assert.strictEqual(locked.data.error, 'locked');
    assert.ok(locked.data.until);
    /* حتی با PIN درست هم تا پایان قفل باز نمی‌شود */
    const correct = await req('/api/auth/unlock', { method: 'POST', body: { device_token: dev, pin: '5555' } });
    assert.strictEqual(correct.status, 429);
  });

  await test('X-Forwarded-For از تونل محلی پذیرفته می‌شود', async () => {
    const cfg = require('../server/config');
    const fake = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '203.0.113.7, 127.0.0.1' } };
    assert.strictEqual(cfg.clientIp(fake), '203.0.113.7');
    const direct = { socket: { remoteAddress: '198.51.100.9' }, headers: { 'x-forwarded-for': '203.0.113.7' } };
    assert.strictEqual(cfg.clientIp(direct), '198.51.100.9', 'بدون تونل، هدر جعلی نادیده گرفته می‌شود');
  });

  /* ── ۳. دود رابط کاربری ── */
  await test('صفحهٔ ورود در مرورگر بدون خطا رندر می‌شود', async () => {
    const { JSDOM } = require('jsdom');
    const html = fs.readFileSync(path.join(ROOT, 'client/index.html'), 'utf8');
    const dom = new JSDOM(html, {
      url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true,
      beforeParse(win) {
        win.fetch = (u, o) => fetch(new URL(u, BASE), o);
        win.indexedDB = undefined;
        win.navigator.serviceWorker = undefined;
      },
    });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/app.js'));
    win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
    const app = await waitFor(() => {
      const el = win.document.querySelector('#app');
      return el && el.textContent.includes('ورود') ? el : null;
    });
    assert.ok(app.textContent.includes('کارت پیوند') || app.textContent.includes('ورود'));
    dom.window.close();
  });

  childExited = true;
  child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 300));

  console.log(`\n${passed} موفق · ${failed} ناموفق\n`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); try { child.kill(); } catch (x) { /* noop */ } process.exit(1); });
