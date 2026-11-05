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
    cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', PAYESH_DATA: TMP, PAYESH_LOG: '0', PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0' }),
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

  await test('اپلیکیشن اندروید: آدرس سرویس را خودش پیدا می‌کند (بدون پرسش از کاربر)', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'android-config.json'), 'utf8'));
    assert.strictEqual(cfg.app, 'payesh-local');
    assert.strictEqual(typeof cfg.url, 'string', 'کلید url باید باشد (حتی خالی)');

    const main = fs.readFileSync(path.join(ROOT, 'install/android/app/src/main/java/ir/payesh/local/MainActivity.java'), 'utf8');
    assert.ok(main.includes('BuildConfig.PAYESH_URL'), 'آدرس پخته‌شده در APK');
    assert.ok(main.includes('CONFIG_URLS'), 'پیکربندی مرکزی مخزن');
    assert.ok(/void scanLan\(/.test(main), 'جستجوی خودکار در شبکه');
    assert.ok(/MAX_AUTO_TRIES/.test(main), 'تلاش دوبارهٔ خودکار');

    /* شروع برنامه نباید مستقیم آدرس بپرسد — همان شکایتی که کاربر داشت */
    const onCreate = main.slice(main.indexOf('protected void onCreate'), main.indexOf('private int dp('));
    assert.ok(onCreate.includes('connect(true)'), 'شروع برنامه اتصال خودکار است');
    const asksOnStart = onCreate.split('\n').some(l => l.trim() === 'askServer();');
    assert.ok(!asksOnStart, 'در اولین اجرا آدرس پرسیده نمی‌شود (فقط دکمهٔ اضطراری)');

    /* نحو جاوا هم بررسی می‌شود تا خطای کامپایل به CI نرسد */
    const { parse } = require('java-parser');
    parse(main);
    assert.ok(main.includes('KEY_PUBLIC') && main.includes('learnPublicUrl'),
      'آدرس عمومی را از خود سرور یاد می‌گیرد (کار در خانه)');
    assert.ok(/candidates\(\)/.test(main), 'فهرست آدرس‌های جایگزین');

    /* سیستم مدرسه خاموش → همان صفحهٔ قبلی از کش گوشی */
    assert.ok(/private void showOffline\(/.test(main), 'دکمهٔ آفلاین در گوشی');
    assert.ok(main.includes('LOAD_CACHE_ELSE_NETWORK'), 'خواندن از کش بدون شبکه');
    assert.ok(main.includes('KEY_LAST'), 'آخرین نشانی موفق ذخیره می‌شود');
    assert.ok(main.includes('optJSONArray("urls")'), 'چند آدرس از مخزن (سرور پشتیبان)');

    const gradle = fs.readFileSync(path.join(ROOT, 'install/android/app/build.gradle'), 'utf8');
    assert.ok(gradle.includes('buildConfigField'), 'PAYESH_URL در BuildConfig ساخته می‌شود');
    assert.ok(gradle.includes('PAYESH_APP_URL'), 'متغیر محیطی برای پختن آدرس');
  });

  await test('برنامهٔ ویندوز: پنجرهٔ واقعی است، نه مرورگر', () => {
    const app = fs.readFileSync(path.join(ROOT, 'desktop/PayeshApp.cs'), 'utf8');
    const iss = fs.readFileSync(path.join(ROOT, 'installer/payesh.iss'), 'utf8');

    /* ۱) خود فایل برنامه: پنجرهٔ WinForms + WebView2 */
    assert.ok(/class\s+\w+\s*:\s*Form/.test(app), 'فرم WinForms');
    assert.ok(app.includes('Microsoft.Web.WebView2.WinForms'), 'WebView2 داخل پنجره');
    assert.ok(app.includes('CoreWebView2Environment') || app.includes('WebView2'), 'موتور نمایش داخلی');
    assert.ok(!/Process\.Start\("http.*localhost:8080/.test(app), 'باز کردن مرورگر مسیر اصلی نیست');

    /* ۲) نصب‌کننده: میان‌بر اصلی باید خود exe باشد */
    const icons = iss.slice(iss.indexOf('[Icons]'), iss.indexOf('[Registry]'));
    const mainIcon = icons.split('\n').find(l => l.includes('{group}') && l.includes('{#AppName}'));
    assert.ok(mainIcon, 'میان‌بر برنامه در منوی شروع');
    assert.ok(mainIcon.includes('{app}\\desktop\\Payesh.exe'), 'میان‌بر به Payesh.exe اشاره می‌کند');
    assert.ok(!mainIcon.includes('explorer.exe'), 'میان‌بر برنامه explorer.exe نیست');
    assert.ok(!mainIcon.includes('wscript.exe'), 'میان‌بر برنامه اسکریپت VBS نیست');
    assert.ok(!/explorer\.exe"; Parameters: "http:\/\/localhost:8080/.test(icons),
      'میان‌بر «باز کردن در مرورگر» وجود ندارد');

    /* ۳) اجرای پس از نصب = برنامه، نه مرورگر */
    const run = iss.slice(iss.indexOf('[Run]'));
    assert.ok(run.includes('{app}\\desktop\\Payesh.exe'), 'اجرای پس از نصب برنامه را باز می‌کند');

    /* ۴) خودکار بودن: سرور را بالا می‌آورد و منتظر آماده شدن می‌ماند */
    assert.ok(app.includes('/api/health'), 'انتظار برای آماده شدن سرور');
    assert.ok(app.includes('server/index.js') || app.includes('"server"'), 'اجرای سرور محلی');
    assert.ok(app.includes('--tray'), 'حالت سینی سیستم برای اجرای خودکار');

    /* ۴.۲) نقش این رایانه با «سیستم مدرسه» یکی است: اگر فایل‌های سرور هست، سرور است
       (باگ 0.4.3: یک تنظیم چسبندهٔ mode=client سیستم مدرسه را برای همیشه «کاربر» می‌کرد) */
    assert.ok(app.includes('bool hasServer'), 'وجود فایل‌های سرور تعیین‌کننده است');
    assert.ok(!/mode"\) == "client"/.test(app), 'تنظیم چسبندهٔ mode=client حذف شده');
    assert.ok(!app.includes('SaveIni(_settingsFile, "mode", "client")'), 'دکمهٔ جستجو رایانه را کاربر نمی‌کند');

    /* ۴.۲.۵) چند سرور: هر رایانه‌ای می‌تواند سرور باشد */
    assert.ok(/SplitList\(/.test(app) && app.includes('"urls"'), 'چند آدرس (سرور اصلی + پشتیبان)');
    assert.ok(/RemoteAddresses\(/.test(app), 'خواندن آرایهٔ urlها از مخزن');

    /* ۴.۳) حالت آفلاین: سیستم مدرسه خاموش است → آخرین وضعیت ذخیره‌شده */
    assert.ok(/private void ShowOffline\(/.test(app), 'دکمهٔ نمایش آخرین وضعیت');
    assert.ok(/SaveIni\(_settingsFile, "last_url", url\)/.test(app), 'آخرین نشانی موفق ذخیره می‌شود');
    assert.ok(app.includes('حالت آفلاین'), 'نوار آفلاین');

    /* ۴.۵) کلیک دوباره روی آیکون = آوردن پنجرهٔ موجود، نه پیام «باز است» */
    assert.ok(app.includes('TryOpenExisting'), 'سیگنال تک‌نمونه‌ای');
    assert.ok(/BringToFrontFromSecond/.test(app), 'آوردن پنجرهٔ سینی به جلو');
    assert.ok(!/MessageBox\.Show\(\s*"پایش/.test(app), 'پیام بن‌بست «باز است» برنگشته');

    /* ۵) اتصال از هر اینترنت: نردبان آدرس شامل آدرس عمومی */
    assert.ok(/public_url/.test(app), 'آدرس عمومی HTTPS در نردبان اتصال');
    assert.ok(/ScanLan\(/.test(app), 'شبکهٔ محلی فقط آخرین گزینه');

    /* ۵.۵) برنامه در {app}\desktop است و سرور در {app} → ریشهٔ نصب باید یک پله بالا برود
       (باگ 0.4.2: برنامه خودش را «کاربر» می‌دید و هیچ سروری بالا نمی‌آمد) */
    assert.ok(/ResolveRoot\(/.test(app), 'تشخیص ریشهٔ نصب');
    assert.ok(app.includes('Directory.GetParent'), 'پوشهٔ desktop → ریشهٔ نصب');
    assert.ok(app.includes('runtime", "node.exe"'), 'Node همراه بسته پیدا می‌شود');

    /* ۶) نگهبان زمان کامپایل: بدون exe، نصب‌کننده ساخته نمی‌شود */
    assert.ok(/FileExists\([\s\S]{0,160}?Payesh\.exe/.test(iss), 'ISCC بدون Payesh.exe باید خطا بدهد');
    assert.ok(/FileExists\([\s\S]{0,160}?WebView2Loader\.dll/.test(iss), 'ISCC بدون WebView2Loader باید خطا بدهد');
    assert.ok(/FileExists\([\s\S]{0,160}?runtime\\node\.exe/.test(iss), 'ISCC بدون Node باید خطا بدهد');

    /* ۷) اسکریپت ساخت و CI */
    const ps = fs.readFileSync(path.join(ROOT, 'desktop/build.ps1'), 'utf8');
    assert.ok(ps.includes('WebView2'), 'SDK وب‌ویو در ساخت');
    assert.ok(ps.includes('Payesh.exe'), 'خروجی exe');
    const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/build.yml'), 'utf8');
    assert.ok(ci.includes('desktop\\build.ps1'), 'CI برنامه را می‌سازد');
  });

  await test('دسترسی از هر اینترنتی: تونل خودکار روشن می‌شود', () => {
    const tunnel = fs.readFileSync(path.join(ROOT, 'server/tunnel.js'), 'utf8');
    const index = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    assert.ok(/function autoStart\(/.test(tunnel), 'راه‌اندازی خودکار تونل');
    assert.ok(tunnel.includes('PAYESH_TUNNEL_AUTO'), 'کلید خاموش/روشن');
    assert.ok(/autoStart\(\)/.test(tunnel) || /autoStart\(store/.test(tunnel), 'در start فراخوانی می‌شود');
    assert.ok(tunnel.includes('cloudflaredBin()'), 'تونل موقت بدون حساب');
    assert.ok(/path\.join\(HERE, 'cloudflared\.exe'\)/.test(tunnel), 'cloudflared همراه برنامه هم پیدا می‌شود');
    const iss = fs.readFileSync(path.join(ROOT, 'installer/payesh.iss'), 'utf8');
    assert.ok(iss.includes('cloudflared-windows-amd64.exe'), 'نصب‌کننده پشتیبان تونل را می‌آورد');
    assert.ok(index.includes('tunnel.start('), 'سرور تونل را راه می‌اندازد');

    /* آدرس عمومی باید در health منتشر شود تا کلاینت‌ها یاد بگیرند */
    const health = index.slice(index.indexOf("'/api/health'"));
    assert.ok(health.slice(0, 900).includes('public_url'), 'public_url در /api/health');
  });

  await test('استقرار ابری: بستهٔ آماده، داکر و اسکریپت VPS', () => {
    const need = ['deploy/README.md', 'deploy/vps-setup.sh', 'deploy/payesh.service',
      'deploy/backup.sh', 'deploy/selfcheck.mjs', 'deploy/.env.example',
      'Dockerfile', 'docker-compose.yml', 'scripts/build-cloud-bundle.mjs'];
    for (const f of need) assert.ok(fs.existsSync(path.join(ROOT, f)), 'فایل موجود: ' + f);

    const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    assert.ok(/FROM node:22/.test(docker), 'Node 22 برای node:sqlite');
    assert.ok(docker.includes('--experimental-sqlite'), 'پرچم sqlite در اجرا');
    assert.ok(/PAYESH_DATA=\/data/.test(docker), 'دادهٔ ماندگار در volume');
    assert.ok(/EXPOSE 8080/.test(docker), 'درگاه');

    const vps = fs.readFileSync(path.join(ROOT, 'deploy/vps-setup.sh'), 'utf8');
    assert.ok(vps.includes('systemctl enable --now payesh'), 'سرویس systemd');
    assert.ok(vps.includes('PAYESH_TUNNEL_AUTO=0'), 'تونل روی ابر خاموش');
    assert.ok(/certbot/.test(vps), 'SSL خودکار با دامنه');
    assert.ok(/23\.5|minor.*-ge 5|node:sqlite/i.test(vps), 'بررسی نسخهٔ Node');

    const env = fs.readFileSync(path.join(ROOT, 'deploy/.env.example'), 'utf8');
    assert.ok(env.includes('PAYESH_DATA') && env.includes('PAYESH_PUBLIC_URL'), 'متغیرهای لازم');

    const bundle = fs.readFileSync(path.join(ROOT, 'scripts/build-cloud-bundle.mjs'), 'utf8');
    assert.ok(bundle.includes('payesh-cloud.zip'), 'خروجی ZIP برای پنل');
    assert.ok(bundle.includes('START-HERE.txt'), 'راهنمای کنار بسته');

    const check = fs.readFileSync(path.join(ROOT, 'deploy/selfcheck.mjs'), 'utf8');
    assert.ok(check.includes('/api/health') && check.includes('setup_done'), 'بررسی سلامت استقرار');
  });


  await test('حافظهٔ ابری: امضای S3 درست و چرخهٔ نوشتن/خواندن سالم', async () => {
    const sig = require(path.join(ROOT, 'client', 'lib', 'sigv4.js'));
    const s3 = require(path.join(ROOT, 'server', 's3mem.js'));
    const http = require('http');
    const crypto = require('crypto');

    /* ۱) پایهٔ هش */
    assert.equal(sig.sha256hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    /* ۲) وکتور رسمی AWS (S3 GET Object) — اگر این درست باشد امضا سالم است */
    const v = sig.sign({
      method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt',
      region: 'us-east-1', service: 's3', headers: { Range: 'bytes=0-9' },
      amzDate: '20130524T000000Z', accessKey: 'AKIAIOSFODNN7EXAMPLE',
      secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
    assert.equal(v.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
      'امضای S3 مطابق نمونهٔ رسمی AWS');

    /* ۳) سرور ساختگی S3 که امضا را با crypto خودِ Node چک می‌کند */
    const SECRET = 'testsecret';
    const store = new Map();
    const ham = (k, m) => crypto.createHmac('sha256', k).update(m).digest();
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const buf = Buffer.concat(chunks);
        const url = new URL(req.url, 'http://x');
        const auth = req.headers.authorization || '';
        const m = auth.match(/Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)/);
        if (!m) { res.writeHead(403); return res.end('<Error><Code>AccessDenied</Code></Error>'); }
        const [, , date, region, signed, sigv] = m;
        const hashPayload = crypto.createHash('sha256').update(buf).digest('hex');
        const names = signed.split(';');
        const vals = names.map(n => n === 'host' ? req.headers.host : (n === 'content-type' ? req.headers['content-type'] || '' : req.headers[n] || ''));
        const canonHeaders = names.map((n, i) => n + ':' + String(vals[i]).trim() + '\n').join('');
        const qs = [...url.searchParams.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
          .map(([k, val]) => encodeURIComponent(k) + '=' + encodeURIComponent(val)).join('&');
        const canon = [req.method, url.pathname, qs, canonHeaders, signed, hashPayload].join('\n');
        const sts = ['AWS4-HMAC-SHA256', req.headers['x-amz-date'], date + '/' + region + '/s3/aws4_request',
          crypto.createHash('sha256').update(canon).digest('hex')].join('\n');
        let k = ham('AWS4' + SECRET, date); k = ham(k, region); k = ham(k, 's3'); k = ham(k, 'aws4_request');
        if (crypto.createHmac('sha256', k).update(sts).digest('hex') !== sigv) {
          res.writeHead(403, { 'content-type': 'application/xml' });
          return res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
        }
        const pDec = decodeURIComponent(url.pathname);
        if (!pDec.startsWith('/b1')) { res.writeHead(404); return res.end('<Error><Code>NoSuchBucket</Code></Error>'); }
        const key = pDec.slice(4).replace(/^\//, '');
        if (req.method === 'PUT' && key) { store.set(key, buf.toString()); res.writeHead(200); return res.end(); }
        if (req.method === 'GET' && !key) {
          const prefix = url.searchParams.get('prefix') || '';
          const keys = [...store.keys()].filter(x => x.startsWith(prefix)).sort();
          res.writeHead(200, { 'content-type': 'application/xml' });
          return res.end('<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
            keys.map(x => '<Contents><Key>' + x + '</Key><Size>' + store.get(x).length + '</Size></Contents>').join('') +
            '</ListBucketResult>');
        }
        if (req.method === 'GET' && key) {
          if (!store.has(key)) { res.writeHead(404); return res.end('<Error><Code>NoSuchKey</Code></Error>'); }
          res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(store.get(key));
        }
        if (req.method === 'DELETE' && key) { store.delete(key); res.writeHead(204); return res.end(); }
        res.writeHead(400); res.end('bad');
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const cfg = s3.normalize({ endpoint: 'http://127.0.0.1:' + port, bucket: 'b1', accessKey: 'AK', secret: SECRET, prefix: 'payesh/' });
    try {
      const out = await s3.test(cfg);
      assert.ok(out.ok, 'چرخهٔ آزمایش سالم: ' + JSON.stringify(out.steps));
      assert.ok(out.steps.length >= 4, 'چهار مرحله گزارش شود');

      await s3.put(cfg, 'payesh/x.json', '{"x":1}');
      const list = await s3.list(cfg, { max: 10 });
      assert.equal(list.keys.length, 1, 'فهرست فایل');
      assert.equal((await s3.get(cfg, 'payesh/x.json')).trim(), '{"x":1}', 'خواندن محتوا');

      /* خطای رمز غلط باید پیام فارسی بدهد، نه استثنای خام */
      const bad = await s3.test(s3.normalize(Object.assign({}, cfg, { secret: 'wrong' })));
      assert.ok(!bad.ok && /دسترسی|کلید/.test(bad.error || ''), 'پیام خطای فارسی: ' + bad.error);
    } finally {
      await new Promise(r => server.close(r));
    }

    /* ۴) مسیرهای API و صفحهٔ رابط */
    const idx = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    assert.ok(idx.includes("'/api/admin/cloud/test'"), 'مسیر آزمایش');
    assert.ok(idx.includes("'/api/admin/cloud'"), 'مسیر تنظیمات');
    const pages = fs.readFileSync(path.join(ROOT, 'client/pages.js'), 'utf8');
    assert.ok(pages.includes('PAGES.cloud'), 'صفحهٔ حافظهٔ ابری');
    const html = fs.readFileSync(path.join(ROOT, 'client/index.html'), 'utf8');
    assert.ok(html.includes('/lib/s3mini.js') && html.includes('/lib/sigv4.js'), 'کتابخانه‌ها در صفحه');
    const sw = fs.existsSync(path.join(ROOT, 'client/sw.js'));
    assert.ok(sw, 'سرویس‌ورکر');
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

  await test('bootstrap برای ولی، توکن ابری فرزند می‌دهد', async () => {
    const imp = await req('/api/admin/import', { method: 'POST', token: managerToken, body: {
      kind: 'students',
      rows: [{ name: 'دانش‌آموز ابری', national_id: '1000000036', parent_name: 'ولی ابری', parent_phone: '09121234567' }],
    } });
    assert.strictEqual(imp.data.created, 1);

    await req('/api/admin/network', { method: 'POST', token: managerToken, body: { hub_url: 'https://hub.example.test', hub_enabled: true } });

    const pull = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z', { token: managerToken });
    const parent = pull.data.collections.users.find(u => u.name === 'ولی ابری');
    assert.ok(parent, 'ولی ساخته شد');

    const pc = await req('/api/admin/pair-code', { method: 'POST', token: managerToken, body: { user_id: parent.id } });
    const paired = await req('/api/auth/pair', { method: 'POST', body: { code: pc.data.code, pin: '3333' } });
    const boot = await req('/api/bootstrap', { token: paired.data.session.token });
    assert.strictEqual(boot.data.hub.enabled, true);
    assert.strictEqual(boot.data.hub.url, 'https://hub.example.test');
    assert.strictEqual(boot.data.hub.children.length, 1);
    assert.strictEqual(boot.data.hub.children[0].token.length, 64, 'توکن HMAC هر خانواده');

    /* دبیر نباید توکن ابری بگیرد */
    const teacherBoot = await req('/api/bootstrap', { token: (await req('/api/auth/pair', { method: 'POST', body: { code: (await req('/api/admin/pair-code', { method: 'POST', token: managerToken, body: { user_id: 2 } })).data.code, pin: '4444' } })).data.session.token });
    assert.strictEqual(teacherBoot.data.hub.enabled, true);
    assert.deepStrictEqual(teacherBoot.data.hub.children, []);
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
