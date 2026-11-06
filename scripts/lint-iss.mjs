#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   بازبینی installer/payesh.iss قبل از ISCC
   ───────────────────────────────────────────────────────────────────
   Inno Setup فقط روی ویندوز اجرا می‌شود، پس خطاهای ساده (دستور تکراری،
   فایل منبع ناموجود) در CI دیر و مبهم لو می‌روند. این اسکریپت همان‌ها را
   از قبل می‌گیرد.  اجرا: node scripts/lint-iss.mjs
   ═══════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ISS = path.join(ROOT, 'installer', 'payesh.iss');
const STAGE = path.join(ROOT, '.build', 'win');

const text = fs.readFileSync(ISS, 'utf8').replace(/^\uFEFF/, '');
const errors = [];
const warnings = [];

let section = '(header)';
const seen = new Map(); // `${section}:${directive}` → line
const lines = text.split('\n');

lines.forEach((rawLine, idx) => {
  const ln = idx + 1;
  const line = rawLine.trim();
  if (!line) return;
  if (/^\[.+\]$/.test(line)) { section = line.slice(1, -1).toLowerCase(); return; }
  /* در بخش [Code] زبان پاسکال است: «;» جداکنندهٔ دستور است، نه کامنت.
     (این اشتباه یک‌بار کل ساخت نصب‌کننده را انداخت: 'BEGIN' expected) */
  if (section === 'code') {
    if (line.startsWith(';')) {
      errors.push(`خط ${ln}: در [Code] کامنت با «;» نوشته شده — پاسکال آن را دستور می‌بیند؛ از // استفاده کنید`);
    }
    return;
  }
  if (line.startsWith(';')) return;
  if (line.startsWith('#')) return; // دستورهای پیش‌پردازنده

  const value = line.slice(line.indexOf(':') + 1);
  if ((value.match(/"/g) || []).length % 2 !== 0) {
    errors.push(`خط ${ln}: کوتیشن جفت نشده → ${line}`);
  }

  /* فقط [Setup] دستور یگانه دارد؛ بقیهٔ بخش‌ها چندخطی‌اند */
  if (section === 'setup') {
    const m = line.match(/^([A-Za-z][A-Za-z0-9]*)\s*=/);
    if (!m) return;
    const key = m[1].toLowerCase();
    if (seen.has(key)) {
      errors.push(`خط ${ln}: دستور تکراری "${m[1]}" در [Setup] (اولین بار خط ${seen.get(key)}) — ISCC این را رد می‌کند`);
    } else {
      seen.set(key, ln);
    }
  }
});

/* ── [Code]: تعادل begin/end و سلامت کامنت‌ها ────────────────────── */
(function checkCode() {
  const i = text.search(/^\[Code\]\s*$/m);
  if (i < 0) return;
  let rest = text.slice(i).replace(/^\[Code\]\s*$/, '');
  const nxt = rest.search(/^\[[A-Za-z]+\]\s*$/m);
  if (nxt > 0) rest = rest.slice(0, nxt);
  let clean = '', inStr = false;
  for (let k = 0; k < rest.length; k++) {
    const c = rest[k];
    if (inStr) {
      if (c === "'") {
        if (rest[k + 1] === "'") { k++; continue; }
        inStr = false;
      }
      clean += ' ';
      continue;
    }
    if (c === "'") { inStr = true; clean += ' '; continue; }
    if (c === '{') { const e = rest.indexOf('}', k); k = e < 0 ? rest.length : e; clean += ' '; continue; }
    if (c === '/' && rest[k + 1] === '/') { const e = rest.indexOf('\n', k); k = e < 0 ? rest.length : e; continue; }
    clean += c;
  }
  const begins = (clean.match(/\bbegin\b/gi) || []).length;
  const ends = (clean.match(/\bend\b/gi) || []).length;
  if (begins !== ends) errors.push(`بخش [Code]: تعداد begin (${begins}) با end (${ends}) یکی نیست — ISCC نمی‌تواند کامپایل کند`);
})();

/* پرونده‌های مورد نیاز */
const win2posix = (r) => String(r).replace(/\\/g, '/');

function need(rel, why) {
  const p = path.join(ROOT, win2posix(rel));
  if (!fs.existsSync(p)) errors.push(`فایل پیدا نشد: ${rel} (${why})`);
  return p;
}

const iconMatch = text.match(/^SetupIconFile\s*=\s*(.+)$/m);
if (iconMatch) need(iconMatch[1].trim(), 'SetupIconFile');
else warnings.push('SetupIconFile تنظیم نشده — نصب‌کننده آیکون پیش‌فرض دارد');

/* منابع [Files]: وقتی .build/win آماده است، وجودشان را چک کن */
if (fs.existsSync(STAGE)) {
  const srcRe = /^Source:\s*"([^"]+)"/gm;
  let m;
  while ((m = srcRe.exec(text))) {
    const rel = win2posix(m[1]);
    const abs = path.join(ROOT, rel);
    if (rel.includes('*')) {
      const dir = path.dirname(abs);
      if (!fs.existsSync(dir)) errors.push(`پوشهٔ منبع پیدا نشد: ${rel}`);
    } else if (!fs.existsSync(abs)) {
      errors.push(`فایل منبع پیدا نشد: ${rel}`);
    }
  }
} else {
  warnings.push('.build/win موجود نیست؛ وجود فایل‌های [Files] بررسی نشد (اول npm run stage:win)');
}

/* آیکون باید حداقل یک تصویر ۳۲×۳۲ داشته باشد (ISCC گاهی رد می‌کند) */
const icoPath = iconMatch && path.join(ROOT, win2posix(iconMatch[1].trim()));
if (icoPath && fs.existsSync(icoPath)) {
  const buf = fs.readFileSync(icoPath);
  const count = buf.readUInt16LE(4);
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) errors.push('payesh.ico فایل ICO معتبر نیست');
  if (count < 1) errors.push('payesh.ico هیچ تصویری ندارد');
}

/* نام‌های ارائه‌شده ولی استفاده‌نشده */
for (const name of ['AppVersion', 'AppExeName']) {
  if (!new RegExp(`#define\\s+${name}\\b`).test(text) && !text.includes(`#ifndef ${name}`)) {
    warnings.push(`{#${name}} تعریف نشده`);
  }
}

/* میان‌بر «برنامه» باید به payesh-app.vbs برود، نه .url */
if (/DestName:\s*"|\.url/i.test(text) && /\{group\}[^\n]*\.url/.test(text)) {
  errors.push('میان‌بر .url باقی مانده — باید .lnk با wscript/payesh-app.vbs باشد');
}

for (const w of warnings) console.log('⚠️  ' + w);
if (errors.length) {
  for (const e of errors) console.error('❌ ' + e);
  console.error(`\n${errors.length} خطا در installer/payesh.iss`);
  process.exit(1);
}
console.log('✅ installer/payesh.iss سالم است (' + lines.length + ' خط، بخش‌ها: ' +
  [...new Set(lines.filter(l => /^\[.+\]$/.test(l.trim())).map(l => l.trim()))].join(' ') + ')');
