'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون به‌روزرسانی درجا
   ───────────────────────────────────────────────────────────────────
   یک «مخزن جعلی» (سرور HTTP محلی) می‌سازیم که مانیفست و فایل‌ها را
   می‌دهد، و خود برنامهٔ واقعی را روی یک «کپی» از ریشه اجرا می‌کنیم
   (PAYESH_APP_ROOT) تا فایل‌های مخزن دست نخورند.

   چیزهایی که تضمین می‌شود:
     • فقط فایل‌های تغییرکرده دانلود می‌شوند (نه کل برنامه)
     • هش ناجور = هیچ تغییری اعمال نمی‌شود
     • داده‌ها هرگز لمس نمی‌شوند
     • بازگشت به نسخهٔ قبل کار می‌کند
     • فقط مدیر اجازهٔ دیدن/اعمال دارد
   اجرا: npm run test:update
   ═══════════════════════════════════════════════════════════════════ */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++; console.log('  ✓ ' + name);
  }).catch(e => {
    failed++; console.log('  ✗ ' + name + '\n     ' + (e && e.message));
  });
}

function freePort() {
  return new Promise((res, rej) => {
    const s = require('net').createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fn(); if (r) return r; } catch (e) { /* retry */ }
    await sleep(120);
  }
  throw new Error('timeout');
}

/* ── نسخهٔ ۱: آنچه روی سیستم مدرسه نصب است ────────────────────────── */
const V1 = {
  'client/index.html': '<!doctype html><title>v1</title>',
  'client/app.js': 'console.log("v1");\n'.repeat(20),
  'client/styles.css': 'body{color:#111}\n',
  'client/sw.js': '// sw v1\n',
  'server/index.js': '// server v1\n',
  'server/util.js': '// util v1\n',
  'hub/worker.js': '// hub v1\n',
  'package.json': '{"name":"x","version":"0.1.0"}\n',
};

/* ── نسخهٔ ۲: تغییر دو فایل + یک فایل تازه؛ بقیه دست‌نخورده ───────── */
const V2 = Object.assign({}, V1, {
  'client/app.js': 'console.log("v2");\n'.repeat(20),
  'server/index.js': '// server v2\n',
  'client/extra.js': '// فایل تازه در نسخهٔ ۲\n',
});
delete V2['server/util.js'];      /* حذف‌شده در نسخهٔ ۲ */

function manifestFor(version, map) {
  const files = Object.keys(map).sort().map(p => ({
    path: p,
    kind: p.startsWith('client/') ? 'client' : 'server',
    sha256: sha(map[p]),
    size: Buffer.byteLength(map[p]),
  }));
  return {
    version, built_at: new Date().toISOString(), files,
    total_size: files.reduce((a, f) => a + f.size, 0),
  };
}

function writeTree(base, map) {
  for (const rel of Object.keys(map)) {
    const p = path.join(base, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, map[rel]);
  }
}

/* ── مخزن جعلی ────────────────────────────────────────────────────── */
const remote = { manifest: null, files: {}, hits: [] };
function startRemote(port) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    remote.hits.push(u.pathname);
    if (u.pathname === '/releases/manifest.json') {
      if (!remote.manifest) { res.writeHead(404).end('no'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(remote.manifest));
      return;
    }
    const rel = u.pathname.replace(/^\/+/, '');
    if (Object.prototype.hasOwnProperty.call(remote.files, rel)) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(remote.files[rel]);
      return;
    }
    res.writeHead(404).end('not found');
  });
  return new Promise(res => srv.listen(port, '127.0.0.1', () => res(srv)));
}

/* ── سرور واقعی برنامه روی یک کپی ─────────────────────────────────── */
let BASE = '';
let child = null;
let APP = '';
let DATA = '';

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

const read = rel => fs.readFileSync(path.join(APP, rel), 'utf8');
const exists = rel => fs.existsSync(path.join(APP, rel));

(async () => {
  console.log('\nپایش-لوکال — آزمون به‌روزرسانی درجا\n');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-upd-'));
  APP = path.join(tmp, 'app');
  DATA = path.join(tmp, 'data');
  fs.mkdirSync(APP, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });

  /* نصب نسخهٔ ۱ */
  writeTree(APP, V1);
  fs.mkdirSync(path.join(APP, 'releases', 'history'), { recursive: true });
  fs.writeFileSync(path.join(APP, 'releases', 'manifest.json'), JSON.stringify(manifestFor('0.1.0', V1), null, 2));
  fs.writeFileSync(path.join(APP, 'releases', 'history', '0.1.0.json'), JSON.stringify(manifestFor('0.1.0', V1), null, 2));

  const remotePort = await freePort();
  const remoteSrv = await startRemote(remotePort);
  const REMOTE = `http://127.0.0.1:${remotePort}/`;

  const port = await freePort();
  BASE = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning',
    path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), HOST: '127.0.0.1',
      PAYESH_APP_ROOT: APP, PAYESH_DATA: DATA, PAYESH_LOG: '0', PAYESH_AUTO_BACKUP: '0',
      PAYESH_UPDATE_BASE: REMOTE, PAYESH_UPDATE_AUTO: '0', PAYESH_NO_RESTART: '1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', d => process.env.VERBOSE && console.error(String(d)));

  await waitFor(async () => (await req('/api/health')).data?.ok);

  const setup = await req('/api/setup', {
    method: 'POST',
    body: { school_name: 'دبیرستان آزمون', manager_name: 'مدیر آزمون', pin: '1234', phone: '09120000001' },
  });
  const managerToken = setup.data.session.token;

  /* دبیر برای آزمون دسترسی */
  await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
    { uid: 'u1', collection: 'users', type: 'put', data: { name: 'دبیر آزمون', role: 'teacher', national_id: '1000000001' } },
  ] } });
  const pc = await req('/api/admin/pair-code', { method: 'POST', token: managerToken, body: { user_id: 2 } });
  const paired = await req('/api/auth/pair', { method: 'POST', body: { code: pc.data.code, pin: '4321' } });
  const teacherToken = paired.data.session.token;

  /* ── ۱. دسترسی ── */
  await test('فقط مدیر به به‌روزرسانی دسترسی دارد', async () => {
    const t = await req('/api/admin/update', { token: teacherToken });
    assert.strictEqual(t.status, 403);
    const t2 = await req('/api/admin/update/apply', { method: 'POST', token: teacherToken, body: {} });
    assert.strictEqual(t2.status, 403);
    const m = await req('/api/admin/update', { token: managerToken });
    assert.strictEqual(m.data.ok, true);
    assert.strictEqual(m.data.running_version, '0.1.0');
  });

  /* ── ۲. منبع در دسترس نیست ── */
  await test('منبع ناموجود: خطای تمیز، برنامه سالم می‌ماند', async () => {
    const bad = await req('/api/admin/update/settings', { method: 'POST', token: managerToken, body: { base: 'http://127.0.0.1:1/' } });
    assert.strictEqual(bad.data.ok, true);
    const c = await req('/api/admin/update/check', { method: 'POST', token: managerToken, body: { force: true } });
    assert.strictEqual(c.data.plan.ok, false);
    assert.strictEqual(c.data.plan.error, 'source_unreachable');
    assert.ok(Array.isArray(c.data.plan.errors) && c.data.plan.errors.length >= 1);
    const h = await req('/api/health');
    assert.strictEqual(h.data.ok, true, 'سرور نباید سقوط کند');
    const back = await req('/api/admin/update/settings', { method: 'POST', token: managerToken, body: { base: REMOTE } });
    assert.strictEqual(back.data.ok, true);
  });

  /* ── ۳. دلتا ── */
  await test('دلتا: فقط فایل‌های تغییرکرده شناسایی می‌شوند', async () => {
    remote.manifest = manifestFor('0.2.0', V2);
    remote.files = V2;
    const c = await req('/api/admin/update/check', { method: 'POST', token: managerToken, body: { force: true } });
    const p = c.data.plan;
    assert.strictEqual(p.ok, true);
    assert.strictEqual(p.available, true);
    assert.strictEqual(p.local_version, '0.1.0');
    assert.strictEqual(p.remote_version, '0.2.0');
    const paths = p.changed.map(f => f.path).sort();
    assert.deepStrictEqual(paths, ['client/app.js', 'client/extra.js', 'server/index.js'], 'فقط سه فایل تغییر کرده');
    assert.deepStrictEqual(p.removed, ['server/util.js'], 'فایل حذف‌شده گزارش شود');
    assert.strictEqual(p.needs_restart, true, 'کد سرور عوض شده = راه‌اندازی مجدد');
    assert.ok(p.total_size < p.changed.reduce((a, f) => a + f.size, 0) + 1);
    const full = manifestFor('0.2.0', V2).total_size;
    assert.ok(p.total_size < full, 'حجم دلتا کمتر از کل برنامه است');
    assert.ok(p.client.length === 2 && p.server.length === 1);
  });

  /* ── ۴. اعمال ── */
  await test('اعمال: فقط همان فایل‌ها دانلود و نوشته می‌شوند', async () => {
    remote.hits = [];
    const before = read('client/styles.css');
    const r = await req('/api/admin/update/apply', { method: 'POST', token: managerToken, body: {} });
    assert.strictEqual(r.data.ok, true, JSON.stringify(r.data));
    assert.strictEqual(r.data.applied, true);
    assert.strictEqual(r.data.version, '0.2.0');
    assert.strictEqual(r.data.files, 3);
    assert.strictEqual(r.data.restart, true);

    /* محتوا عوض شده */
    assert.strictEqual(read('client/app.js'), V2['client/app.js']);
    assert.strictEqual(read('server/index.js'), '// server v2\n');
    assert.strictEqual(read('client/extra.js'), V2['client/extra.js']);
    /* فایل حذف‌شده واقعاً نیست */
    assert.strictEqual(exists('server/util.js'), false);
    /* فایل دست‌نخورده همان است */
    assert.strictEqual(read('client/styles.css'), before);

    /* دانلودها: مانیفست + فقط ۳ فایل (نه ۸) */
    const filesHit = remote.hits.filter(h => h !== '/releases/manifest.json');
    assert.strictEqual(filesHit.length, 3, 'فقط سه فایل دانلود شد، نه کل برنامه: ' + filesHit.join(', '));
    assert.ok(!filesHit.includes('/client/styles.css'), 'فایل بدون تغییر دانلود نشد');

    /* مانیفست محلی و تاریخچه به‌روز شده */
    const local = JSON.parse(fs.readFileSync(path.join(APP, 'releases', 'manifest.json'), 'utf8'));
    assert.strictEqual(local.version, '0.2.0');
    assert.ok(fs.existsSync(path.join(APP, 'releases', 'history', '0.2.0.json')));

    /* نسخهٔ قبلی برای بازگشت نگه داشته شده */
    assert.ok(fs.existsSync(path.join(DATA, 'backups', 'update-0.2.0', 'client', 'app.js')));
  });

  /* ── ۵. داده‌ها ── */
  await test('داده‌های مدرسه دست نمی‌خورند', async () => {
    const b = await req('/api/bootstrap', { token: managerToken });
    assert.strictEqual(b.data.ok, true);
    assert.strictEqual(b.data.school.name, 'دبیرستان آزمون');
    assert.ok(fs.existsSync(path.join(DATA, 'payesh.sqlite')));
    assert.ok(!fs.existsSync(path.join(DATA, 'updates')) || fs.readdirSync(path.join(DATA, 'updates')).length === 0,
      'پوشهٔ موقت دانلود پاک شود');
  });

  /* ── ۶. بررسی مجدد = به‌روز ── */
  await test('پس از نصب: «به‌روز است» و بدون دانلود', async () => {
    remote.hits = [];
    const c = await req('/api/admin/update/check', { method: 'POST', token: managerToken, body: { force: true } });
    assert.strictEqual(c.data.plan.available, false);
    const r = await req('/api/admin/update/apply', { method: 'POST', token: managerToken, body: {} });
    assert.strictEqual(r.data.applied, false);
    assert.strictEqual(r.data.up_to_date, true);
    assert.strictEqual(remote.hits.filter(h => h !== '/releases/manifest.json').length, 0);
    /* نسخهٔ نصب‌شده با نسخهٔ در حال اجرا فرق دارد → نیاز به راه‌اندازی مجدد */
    const h = await req('/api/health');
    assert.strictEqual(h.data.installed_version, '0.2.0');
  });

  /* ── ۷. هش ناجور ── */
  await test('فایل خراب/هش ناجور: هیچ تغییری اعمال نمی‌شود', async () => {
    const V3 = Object.assign({}, V2, { 'client/app.js': 'console.log("v3");\n'.repeat(20) });
    const m3 = manifestFor('0.3.0', V3);
    /* هش اعلام‌شده با محتوای واقعی نمی‌خواند */
    m3.files.find(f => f.path === 'client/app.js').sha256 = 'd'.repeat(64);
    remote.manifest = m3;
    /* همان اندازه، محتوای جابه‌جا — تا واقعاً آزمون هش باشد نه اندازه */
    remote.files = Object.assign({}, V3, { 'client/app.js': V3['client/app.js'].replace(/v3/g, 'X3') });

    const beforeApp = read('client/app.js');
    const beforeManifest = fs.readFileSync(path.join(APP, 'releases', 'manifest.json'), 'utf8');
    const r = await req('/api/admin/update/apply', { method: 'POST', token: managerToken, body: {} });
    assert.strictEqual(r.data.ok, false);
    assert.strictEqual(r.data.error, 'download_failed');
    assert.match(String(r.data.detail), /hash_mismatch/, 'خطا باید از جنس ناسازگاری هش باشد: ' + r.data.detail);
    assert.strictEqual(read('client/app.js'), beforeApp, 'فایل دست‌نخورده');
    assert.strictEqual(fs.readFileSync(path.join(APP, 'releases', 'manifest.json'), 'utf8'), beforeManifest);
  });

  /* ── ۸. بازگشت ── */
  await test('بازگشت به نسخهٔ قبل، فایل‌ها را برمی‌گرداند', async () => {
    remote.manifest = manifestFor('0.2.0', V2);
    remote.files = V2;
    const r = await req('/api/admin/update/rollback', { method: 'POST', token: managerToken, body: {} });
    assert.strictEqual(r.data.ok, true, JSON.stringify(r.data));
    assert.strictEqual(r.data.version, '0.1.0');
    assert.strictEqual(read('client/app.js'), V1['client/app.js']);
    assert.strictEqual(read('server/index.js'), '// server v1\n');
    assert.strictEqual(read('server/util.js'), '// util v1\n', 'فایل حذف‌شده برگشت');
    const local = JSON.parse(fs.readFileSync(path.join(APP, 'releases', 'manifest.json'), 'utf8'));
    assert.strictEqual(local.version, '0.1.0');
  });

  /* ── ۹. فقط کلاینت = بدون راه‌اندازی مجدد ── */
  await test('تغییر فقط در کلاینت: راه‌اندازی مجدد لازم نیست', async () => {
    const V4 = Object.assign({}, V1, { 'client/styles.css': 'body{color:#222}\n' });
    remote.manifest = manifestFor('0.4.0', V4);
    remote.files = V4;
    const c = await req('/api/admin/update/check', { method: 'POST', token: managerToken, body: { force: true } });
    assert.strictEqual(c.data.plan.needs_restart, false);
    assert.strictEqual(c.data.plan.changed.length, 1);
    assert.strictEqual(c.data.plan.client.length, 1);
    const r = await req('/api/admin/update/apply', { method: 'POST', token: managerToken, body: {} });
    assert.strictEqual(r.data.applied, true);
    assert.strictEqual(r.data.restart, false);
    assert.strictEqual(read('client/styles.css'), 'body{color:#222}\n');
  });

  /* ── ۱۰. مسیر ناامن ── */
  await test('مسیرهای ناامن (..، data/) رد می‌شوند', async () => {
    const { isUpdatable } = require('../server/update');
    assert.strictEqual(isUpdatable('client/app.js'), true);
    assert.strictEqual(isUpdatable('server/index.js'), true);
    assert.strictEqual(isUpdatable('data/payesh.sqlite'), false);
    assert.strictEqual(isUpdatable('../outside.js'), false);
    assert.strictEqual(isUpdatable('/etc/passwd'), false);
    assert.strictEqual(isUpdatable('client/../../x.js'), false);
    assert.strictEqual(isUpdatable('C:/windows/system32/x.dll'), false);
  });

  child.kill('SIGKILL');
  remoteSrv.close();
  await sleep(150);
  console.log('\n' + passed + ' موفق، ' + failed + ' ناموفق\n');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* noop */ }
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); if (child) child.kill('SIGKILL'); process.exit(1); });
