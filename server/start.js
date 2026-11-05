'use strict';
/* ───────────────────────────────────────────────────────────────────
   راه‌انداز هوشمند — «npm start» روی هر نسخهٔ Node کار کند.
   مشکل: node:sqlite در Node 22.5..22.x فقط با پرچم --experimental-sqlite
   بالا می‌آید، و در نسخه‌های جدیدتر پرچم لازم نیست (و ممکن است حذف شود).
   راه‌حل: اول بی‌پرچم امتحان می‌کنیم؛ اگر نشد، خودمان با پرچم دوباره اجرا
   می‌شویم. اگر نسخه خیلی قدیمی بود، پیام فارسی روشن می‌دهیم.
   ─────────────────────────────────────────────────────────────────── */
const { spawn } = require('child_process');
const path = require('path');

const ENTRY = path.join(__dirname, 'index.js');
const major = Number(process.versions.node.split('.')[0]);
const minor = Number(process.versions.node.split('.')[1]);

function sqliteReady() {
  try { require('node:sqlite'); return true; } catch (e) { return false; }
}

if (sqliteReady()) {
  require(ENTRY);
} else if (major > 22 || (major === 22 && minor >= 5)) {
  // نسخه درست است ولی این فرایند بدون پرچم بالا آمده → با پرچم دوباره اجرا کن
  const args = ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', ENTRY, ...process.argv.slice(2)];
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });
  child.on('exit', code => process.exit(code === null ? 1 : code));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { try { child.kill(sig); } catch (e) { /* noop */ } });
  }
} else {
  console.error('');
  console.error('  ✗ نسخهٔ Node این میزبان «' + process.versions.node + '» است.');
  console.error('  پایش-لوکال به Node 22.5 یا بالاتر نیاز دارد (برای دیتابیس داخلی).');
  console.error('');
  console.error('  در پنل میزبانی، نسخهٔ Node را روی 22 یا 24 بگذارید و دوباره اجرا کنید.');
  console.error('  مثال:  npm start   →   node server/start.js');
  console.error('');
  process.exit(1);
}
