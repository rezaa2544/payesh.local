#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   ساخت بستهٔ آمادهٔ آپلود برای میزبان‌های اشتراکی (پنل Node.js)
   خروجی: releases/payesh-cloud.zip
   محتوا: فقط چیزهایی که برای اجرا لازم است — بدون آندروید/ویندوز/تست
   اجرا:  node scripts/build-cloud-bundle.mjs
   ═══════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = path.join(ROOT, '.build', 'cloud');
const OUT = path.join(ROOT, 'releases', 'payesh-cloud.zip');

const DIRS = ['client', 'server', 'docs'];
const FILES = ['package.json', 'README.md', 'LICENSE', 'NOTICE'];

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

for (const d of DIRS) {
  const src = path.join(ROOT, d);
  if (!fs.existsSync(src)) continue;
  fs.cpSync(src, path.join(STAGE, d), { recursive: true });
}
for (const f of FILES) {
  const src = path.join(ROOT, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(STAGE, f));
}
// اسکریپت‌های استقرار و بررسی سلامت هم همراه باشند
fs.mkdirSync(path.join(STAGE, 'deploy'), { recursive: true });
for (const f of ['selfcheck.mjs', 'backup.sh', '.env.example']) {
  const src = path.join(ROOT, 'deploy', f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(STAGE, 'deploy', f));
}

/* راهنمای کوتاه کنار بسته — همان چیزی که در پنل لازم است */
fs.writeFileSync(path.join(STAGE, 'START-HERE.txt'), [
  'پایش — بستهٔ استقرار ابری',
  '',
  'دستور شروع (Startup command):',
  '  node --experimental-sqlite --disable-warning=ExperimentalWarning server/index.js',
  '',
  'متغیرهای محیطی:',
  '  PAYESH_DATA=<مسیر ماندگار، مثلاً /home/user/payesh/data>',
  '  PAYESH_PUBLIC_URL=https://<آدرس نهایی>',
  '  PAYESH_TUNNEL_AUTO=0',
  '  PORT=<اگر پنل خودش تعیین می‌کند، دست نزنید>',
  '',
  'نیاز: Node.js 22.5 یا بالاتر.',
  'بعد از استقرار: node deploy/selfcheck.mjs https://<آدرس نهایی>',
  '',
].join('\n'));

fs.rmSync(OUT, { force: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const zip = spawnSync('zip', ['-r', '-q', '-9', OUT, '.'], { cwd: STAGE });
if (zip.error || zip.status !== 0) {
  console.error('⛔ دستور zip در دسترس نیست. روی ویندوز: از PowerToys/7zip استفاده کنید یا بگویید نسخهٔ tar بسازم.');
  process.exit(1);
}

const files = (function count(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? count(p) : 1;
  }
  return n;
})(STAGE);
const kb = (fs.statSync(OUT).size / 1024).toFixed(0);

console.log(`✅ ${path.relative(ROOT, OUT)} — ${kb}KB، ${files} فایل`);
console.log('   در پنل میزبانی آپلود کنید (نوع: Node.js، نسخه: 22) و START-HERE.txt را ببینید.');
