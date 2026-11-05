#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   آماده‌سازی پوشهٔ نصب ویندوز (.build/win) برای ساخت payesh-setup.exe
   ───────────────────────────────────────────────────────────────────
   • فقط فایل‌های لازم برای اجرا + نصب
   • اگر runtime/node.exe وجود داشته باشد (CI آن را می‌آورد)، همراه بسته
     می‌شود تا نصب بدون اینترنت هم کامل انجام شود
   اجرا: node scripts/stage-windows.mjs
   ═══════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = path.join(ROOT, '.build', 'win');
const RUNTIME = path.join(ROOT, 'runtime', 'node.exe');

const DIRS = ['client', 'server', 'hub', 'docs', 'install', 'releases'];
const FILES = [
  'package.json', 'README.md',
  'start.bat', 'start.sh', 'install.bat', 'uninstall.bat',
  'LICENSE', 'NOTICE',
];

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

function copyDir(rel) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) return false;
  fs.cpSync(src, path.join(STAGE, rel), {
    recursive: true,
    filter: (p) => !/[\\/](node_modules|\.gradle|build)[\\/]?$/.test(p),
  });
  return true;
}

for (const d of DIRS) copyDir(d);
for (const f of FILES) {
  const src = path.join(ROOT, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(STAGE, f));
}

/* فقط مانیفست و تاریخچه از releases — نه بسته‌های zip */
const rel = path.join(STAGE, 'releases');
for (const f of fs.readdirSync(rel)) {
  if (/\.(zip|tar\.gz)$/.test(f)) fs.rmSync(path.join(rel, f), { force: true });
}

/* برنامهٔ ویندوز (desktop/Payesh.exe) اگر ساخته شده باشد در .build/win/desktop می‌نشیند */
if (fs.existsSync(path.join(STAGE, 'desktop', 'Payesh.exe'))) {
  const s2 = fs.statSync(path.join(STAGE, 'desktop', 'Payesh.exe'));
  console.log(`   🖥️  Payesh.exe موجود است (${(s2.size / 1024).toFixed(0)}KB)`);
} else {
  console.log('   ⚠️  desktop/Payesh.exe ساخته نشده — میان‌بر به حالت مرورگر برمی‌گردد');
}

/* Node قابل حمل (اختیاری) */
let withNode = false;
if (fs.existsSync(RUNTIME)) {
  fs.mkdirSync(path.join(STAGE, 'runtime'), { recursive: true });
  fs.copyFileSync(RUNTIME, path.join(STAGE, 'runtime', 'node.exe'));
  withNode = true;
}

/* پوشهٔ داده ساخته نمی‌شود؛ نصب‌کننده/برنامه خودش می‌سازد */
function du(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? du(p) : fs.statSync(p).size;
  }
  return n;
}
const files = (function count(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? count(p) : 1;
  }
  return n;
})(STAGE);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
console.log(`📁 صحنهٔ نصب: ${path.relative(ROOT, STAGE)} — ${files} فایل، ${(du(STAGE) / 1024 / 1024).toFixed(1)}MB`);
console.log(`   نسخه: ${pkg.version} · Node همراه: ${withNode ? 'بله' : 'خیر (نصب‌کننده از اینترنت می‌گیرد)'}`);
if (!withNode) console.log('   ⚠️  runtime/node.exe نبود؛ برای نصب آفلاین آن را در runtime/ بگذارید.');
