'use strict';
/* ───────────────────────────────────────────────────────────────────
   راه‌انداز هوشمند + ناظر.

   ۱) «npm start» روی هر نسخهٔ Node کار کند:
      node:sqlite در Node 22.5..22.x فقط با پرچم --experimental-sqlite
      بالا می‌آید و در نسخه‌های تازه‌تر پرچم لازم نیست.

   ۲) ناظر (supervisor): اگر سرور برای به‌روزرسانی خودش را ببندد
      (کد خروج ۷۵)، همین‌جا دوباره بالا می‌آید. اگر هم به‌طور غیرمنتظره
      بخوابد، یک‌بار دیگر امتحان می‌شود. پیش از این، بعد از آپدیت،
      پنجرهٔ برنامه بالا نمی‌آمد تا کاربر همه‌چیز را ببندد و باز کند.
   ─────────────────────────────────────────────────────────────────── */
const { spawn } = require('child_process');
const path = require('path');

const ENTRY = path.join(__dirname, 'index.js');
const major = Number(process.versions.node.split('.')[0]);
const minor = Number(process.versions.node.split('.')[1]);

function sqliteReady() {
  try { require('node:sqlite'); return true; } catch (e) { return false; }
}

if (!sqliteReady() && !(major > 22 || (major === 22 && minor >= 5))) {
  console.error('');
  console.error('  ✗ نسخهٔ Node این میزبان «' + process.versions.node + '» است.');
  console.error('  پایش-لوکال به Node 22.5 یا بالاتر نیاز دارد (برای دیتابیس داخلی).');
  console.error('');
  console.error('  در پنل میزبانی، نسخهٔ Node را روی 22 یا 24 بگذارید و دوباره اجرا کنید.');
  console.error('  مثال:  npm start   →   node server/start.js');
  console.error('');
  process.exit(1);
}

const FLAGS = sqliteReady() ? [] : ['--experimental-sqlite', '--disable-warning=ExperimentalWarning'];
const ARGS = (process.env.PAYESH_ARGS || '').trim() ? process.env.PAYESH_ARGS.trim().split(/\s+/) : process.argv.slice(2);
const EXIT_RESTART = 75;

let child = null;
let stopping = false;
let crashes = 0;

function startServer() {
  child = spawn(process.execPath, [...FLAGS, ENTRY, ...ARGS], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: Object.assign({}, process.env, { PAYESH_SUPERVISED: '1' }),
  });
  const startedAt = Date.now();

  child.on('error', err => {
    console.error('[راه‌انداز] اجرای سرور ناموفق بود:', err.message);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) process.exit(0);

    /* درخواست راه‌اندازی مجدد (آپدیت) — همیشه دوباره بالا می‌آید */
    if (code === EXIT_RESTART) {
      console.log('[راه‌انداز] نسخهٔ تازه فعال شد — بالا آمدن دوباره…');
      setTimeout(startServer, 350);
      return;
    }

    /* خروج سریع و غیرعادی: تا ۳ بار دوباره تلاش می‌کنیم */
    const quick = Date.now() - startedAt < 5000;
    if (!signal && code !== 0 && quick && crashes < 3) {
      crashes++;
      const wait = 600 * crashes;
      console.error('[راه‌انداز] سرور بسته شد (کد ' + code + ') — تلاش ' + crashes + ' از ۳…');
      setTimeout(startServer, wait);
      return;
    }

    process.exit(signal ? 0 : (code == null ? 0 : code));
  });
}

function shutdown(sig) {
  stopping = true;
  try { if (child) child.kill(sig); } catch (e) { /* noop */ }
  setTimeout(() => process.exit(0), 1500).unref();
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => shutdown(sig));
}

startServer();
