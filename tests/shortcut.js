'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون «میان‌بر برنامه» — نسخه‌های قدیمی با یک به‌روزرسانی درست شوند
   ───────────────────────────────────────────────────────────────────
   ویندوز در سندباکس نیست، پس منطق تولید اسکریپت بازسازی میان‌بر و
   کپی فایل‌ها را می‌آزماییم؛ اجرای واقعی فقط روی ویندوز انجام می‌شود.
   اجرا: npm run test:shortcut
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const { buildScript, ensure } = require('../server/shortcut');

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  ✓ ' + name); })
    .catch(e => { failed++; console.log('  ✗ ' + name + '\n     ' + (e && e.message)); });
}

(async () => {
  console.log('\nپایش-لوکال — آزمون میان‌بر «برنامه»\n');

  await test('اسکریپت میان‌بر به wscript + payesh-app.vbs + آیکون اشاره می‌کند', () => {
    const s = buildScript({ root: 'C:\\Payesh', port: 8080 });
    assert.ok(s.includes('C:\\Windows\\System32\\wscript.exe'), 'wscript');
    assert.ok(s.includes('C:\\Payesh\\payesh-app.vbs'), 'vbs');
    assert.ok(s.includes('C:\\Payesh\\payesh.ico'), 'icon');
    assert.ok(/پایش\.lnk/.test(s), 'نام میان‌بر');
    assert.ok(/Remove-Item[^\n]*پایش\.url/.test(s), 'میان‌بر .url قدیمی پاک شود');
    assert.ok(!/TargetPath = .*chrome|TargetPath = .*msedge/i.test(s), 'نباید مستقیم مرورگر را باز کند');
    assert.ok(s.includes('Programs'), 'منوی استارت');
    assert.ok(s.includes('Desktop'), 'دسکتاپ');
  });

  await test('مسیرهای دارای فاصله و آپاستروف سالم می‌مانند', () => {
    const s = buildScript({ root: "C:\\Program Files\\O'Brien\\Payesh", port: 8080 });
    assert.ok(s.includes("'C:\\Program Files\\O''Brien\\Payesh\\payesh-app.vbs'"), 'quote escape');
  });

  await test('روی غیرویندوز بی‌صدا رد می‌شود (اجرا را متوقف نمی‌کند)', async () => {
    const r = await ensure({ root: '/tmp/x' });
    if (process.platform === 'win32') { assert.ok(r); return; }
    assert.strictEqual(r.skipped, true);
    assert.strictEqual(r.reason, 'not_windows');
  });

  await test('حالت برنامه‌ریزی بدون اجرا: فایل‌ها کپی و اسکریپت آماده می‌شود', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-shortcut-'));
    try {
      fs.mkdirSync(path.join(tmp, 'install', 'windows'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'install', 'windows', 'payesh-app.vbs'), 'x');
      fs.writeFileSync(path.join(tmp, 'install', 'windows', 'payesh.ico'), 'y');
      const r = await ensure({ root: tmp, port: 9090, run: false });
      if (process.platform !== 'win32') { assert.strictEqual(r.skipped, true); return; }
      assert.strictEqual(r.ok, true);
      assert.ok(fs.existsSync(path.join(tmp, 'payesh-app.vbs')));
      assert.ok(fs.existsSync(path.join(tmp, 'payesh.ico')));
      assert.ok(r.script.includes('payesh-app.vbs'));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  await test('بدون payesh-app.vbs، میان‌بر دست‌نخورده می‌ماند', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-shortcut-'));
    try {
      const r = await ensure({ root: tmp });
      if (process.platform !== 'win32') { assert.strictEqual(r.skipped, true); return; }
      assert.strictEqual(r.skipped, true);
      assert.strictEqual(r.reason, 'missing_app_vbs');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  await test('فایل‌های واقعی مخزن وجود دارند و VBS منطق انتظار را دارد', () => {
    const vbs = fs.readFileSync(path.join(ROOT, 'install/windows/payesh-app.vbs'), 'utf8');
    assert.ok(vbs.includes('--app='), 'حالت پنجرهٔ مستقل');
    assert.ok(vbs.includes('start-hidden.vbs'), 'روشن‌کردن خودکار سرور');
    assert.ok(vbs.includes('api/health'), 'بررسی سلامت');
    assert.ok(!/chrome\.exe"/.test(vbs.split('\n')[0]));
    const ico = fs.readFileSync(path.join(ROOT, 'install/windows/payesh.ico'));
    assert.strictEqual(ico.readUInt16LE(2), 1, 'ICO type');
    assert.ok(ico.readUInt16LE(4) >= 3, 'چند سایز آیکون');
  });

  console.log('\n' + passed + ' موفق، ' + failed + ' ناموفق\n');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
