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
const fs = require('fs');
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

/* حتی اگر پنجرهٔ دسکتاپ بسته و دوباره باز شود، فقط یک ناظر می‌تواند
   برای یک پوشهٔ داده سرور اجرا کند. قفل فایل با PID است؛ قفلِ باقی‌مانده
   از crash سخت، وقتی PID دیگر زنده نیست، خودکار پاک می‌شود. */
const dataDir = path.resolve(process.env.PAYESH_DATA || path.join(process.cwd(), 'data'));
const lockPath = path.join(dataDir, '.payesh-supervisor.lock');
let lockFd = null;

function pidIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }
}

function acquireSupervisorLock() {
  fs.mkdirSync(dataDir, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
      return fd;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      let ownerPid = 0;
      try { ownerPid = Number(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid); } catch (_) { }
      if (pidIsAlive(ownerPid)) return null;
      /* ممکن است نمونهٔ دیگر همین لحظه فایل را ساخته ولی هنوز PID را ننوشته باشد. */
      if (!ownerPid) {
        try {
          if (Date.now() - fs.statSync(lockPath).mtimeMs < 2000) return null;
        } catch (_) { }
      }
      try { fs.unlinkSync(lockPath); } catch (unlinkError) {
        if (!unlinkError || unlinkError.code !== 'ENOENT') return null;
      }
    }
  }
  return null;
}

function releaseSupervisorLock() {
  if (lockFd !== null) {
    try { fs.closeSync(lockFd); } catch (_) { }
    lockFd = null;
  }
  try {
    const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (Number(owner.pid) === process.pid) fs.unlinkSync(lockPath);
  } catch (_) { }
}

let child = null;
let stopping = false;
let crashes = 0;

function startServer() {
  child = spawn(process.execPath, [...FLAGS, ENTRY, ...ARGS], {
    stdio: 'inherit',
    cwd: process.cwd(),
    windowsHide: true,
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

try { lockFd = acquireSupervisorLock(); }
catch (e) {
  console.error('[راه‌انداز] گرفتن قفل یکتایی ناموفق بود:', e.message);
  process.exit(1);
}
if (lockFd === null) {
  console.log('[راه‌انداز] نمونه‌ای برای این پوشهٔ داده از قبل فعال است؛ اجرای تکراری نادیده گرفته شد.');
  process.exit(0);
}
process.on('exit', releaseSupervisorLock);

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => shutdown(sig));
}

startServer();
