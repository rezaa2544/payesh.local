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

/* مانیفست نسخه — بدون آن، نسخه روی میزبان «0.0.0» گزارش می‌شود */
fs.mkdirSync(path.join(STAGE, 'releases', 'history'), { recursive: true });
for (const f of ['manifest.json']) {
  const src = path.join(ROOT, 'releases', f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(STAGE, 'releases', f));
}
const histSrc = path.join(ROOT, 'releases', 'history');
if (fs.existsSync(histSrc)) {
  for (const f of fs.readdirSync(histSrc)) {
    if (f.endsWith('.json')) fs.copyFileSync(path.join(histSrc, f), path.join(STAGE, 'releases', 'history', f));
  }
}

/* راهنمای کوتاه کنار بسته — همان چیزی که در پنل لازم است */
fs.writeFileSync(path.join(STAGE, 'START-HERE.txt'), [
  'پایش-لوکال — بستهٔ استقرار ابری',
  '════════════════════════════════',
  '',
  '۱) در پنل: اپلیکیشن جدید از نوع Node.js بسازید، نسخهٔ Node را ۲۲ یا ۲۴ بگذارید',
  '   (نام‌های دیگر آن در بعضی پنل‌ها: runtime / engine version).',
  '',
  '۲) همین ZIP را آپلود کنید (نه از طریق GitHub، تا مطمئن باشیم همین نسخه است).',
  '',
  '۳) دستور شروع (Start / Startup command):',
  '     npm start',
  '   اگر پنل «npm start» را پیشنهاد داد، همان را بپذیرید.',
  '   (دستور کامل، اگر لازم شد: node server/start.js)',
  '',
  '۴) متغیرهای محیطی (Environment / Secrets):',
  '     PAYESH_DATA        = <مسیر ماندگار، مثلاً /home/panel/payesh/data>',
  '     PAYESH_PUBLIC_URL  = https://<آدرسی که پنل به شما می‌دهد>',
  '     PAYESH_TUNNEL_AUTO = 0',
  '   درگاه (PORT یا SERVER_PORT) را دستی نگذارید؛ خود برنامه از پنل می‌خواند',
  '   و روی 0.0.0.0 گوش می‌دهد.',
  '',
  '۵) اگر پنل «Domains / دامنه» دارد، همان آدرس را به این اپلیکیشن وصل کنید.',
  '',
  '۶) آدرس را باز کنید → «راه‌اندازی پایش-لوکال» (نام مدرسه، مدیر، PIN).',
  '',
  '۷) بررسی سلامت (روی رایانهٔ خودتان، داخل همین پوشه):',
  '     node deploy/selfcheck.mjs https://<آدرس نهایی>',
  '',
  '⚠️ نکتهٔ داده: تا یک‌بار ری‌استارت نکرده و مطمئن نشده‌اید داده می‌ماند،',
  '   دادهٔ واقعی مدرسه را وارد نکنید. با «deploy/backup.sh» یا بکاپ پنل،',
  '   یک نسخه همیشه بیرون از میزبان نگه دارید.',
  '',
  'نیاز: Node.js 22.5 یا بالاتر (برای دیتابیس داخلی SQLite).',
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
console.log('   در پنل میزبانی آپلود کنید (نوع: Node.js، نسخه: 22/24)، دستور شروع: npm start');
