#!/usr/bin/env node
// Row 169 — ONE source for every download link a person sees:
//   * the README block  <!-- downloads:start … --> … <!-- downloads:end -->
//   * the body of the GitHub release `downloads` (the «Latest» release, kept on top of the Releases page
//     by .github/workflows/downloads-page.yml).
// Categories (owner order, row 169): Windows 64-bit · Windows 32-bit · Android · cloud server · checksums.
// Every link goes straight to the file (row 161, tests/direct-links-161.js): releases/download/<tag>/<file>.
// The files themselves are uploaded by their publishers (school-native-publish.yml, owner-native-publish.yml,
// build.yml); tests/downloads-169.js proves each linked file is in its publisher's ALLOWED set.
//
// CLI
//   node tools/release/downloads.mjs --write-readme        rewrite the README block in place
//   node tools/release/downloads.mjs --check               exit 1 when the README block is stale
//   node tools/release/downloads.mjs --release-body [--info info.json]   print the release body (markdown)
//     info.json (optional): { "school_build": 182, "owner_build": 182, "data_service": "0.9.22",
//                             "commit": "<sha>", "updated": "2026-11-21T10:00:00Z" }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = 'rezaa2544/payesh.local';
export const README = 'README.md';
export const START = '<!-- downloads:start — tools/release/downloads.mjs می‌سازد؛ دستی ویرایش نکنید (ردیف ۱۶۹) -->';
export const END = '<!-- downloads:end -->';
export const RELEASE_TAG = 'downloads';
export const RELEASE_TITLE = '⬇️ دانلودها — همهٔ برنامه‌های پایش (دسته‌بندی‌شده)';

export const fileUrl = (tag, file) => `https://github.com/${REPO}/releases/download/${tag}/${file}`;
const link = ([tag, file], label) => `[${label || '`' + file + '`'}](${fileUrl(tag, file)})`;

const SCHOOL = 'native-continuous';
const OWNER = 'owner-continuous';
const SERVER = 'school-server-continuous';
const CLOUD = 'continuous';

// The programs. `arch` lists the Windows architectures one installer covers.
export const APPS = {
  school: { name: '🏫 اپ مدرسه', who: 'مدیر، معاون، معلم، کادر و اولیا' },
  owner: { name: '🔑 پنل مالک', who: 'فقط مالک سامانه' },
  server: { name: '🗄️ سرور دیتابیس مدرسه', who: 'فقط روی **یک** رایانهٔ مدرسه' },
  cloud: { name: '☁️ سرور ابری', who: 'اختیاری — مدیر فنی' },
};

export const CATEGORIES = [
  {
    id: 'win64',
    title: '🖥️ ویندوز ۶۴ بیتی',
    sub: 'ویندوز ۷ (SP1)، ۸، ۸٫۱، ۱۰ و ۱۱',
    rows: [
      { app: 'school', file: [SCHOOL, 'payesh-native-setup.exe'], portable: [SCHOOL, 'payesh-native-windows.zip'], note: 'برای همان کاربر نصب می‌شود؛ نیازی به مدیر سیستم نیست' },
      { app: 'owner', file: [OWNER, 'payesh-owner-setup.exe'], portable: [OWNER, 'payesh-owner-windows.zip'], note: 'پنل قبلی را درجا ارتقا می‌دهد و تنظیماتش را نگه می‌دارد' },
      { app: 'server', file: [SERVER, 'payesh-data-service-setup.exe'], note: 'یک فایل برای ۳۲ و ۶۴ بیتی' },
    ],
  },
  {
    id: 'win32',
    title: '🖥️ ویندوز ۳۲ بیتی',
    sub: 'ویندوز ۷ (SP1)، ۸، ۸٫۱ و ۱۰',
    rows: [
      { app: 'server', file: [SERVER, 'payesh-data-service-setup.exe'], note: 'همان فایل ۶۴ بیتی؛ خودش نسخهٔ ۳۲ بیتی را نصب می‌کند' },
    ],
  },
  {
    id: 'android',
    title: '🤖 اندروید',
    sub: 'اندروید ۵٫۰ به بالا',
    rows: [
      { app: 'school', file: [SCHOOL, 'payesh-native.apk'], note: 'روی نسخهٔ قبلی درجا ارتقا می‌یابد' },
      { app: 'owner', file: [OWNER, 'payesh-owner.apk'], note: 'روی نسخهٔ قبلی درجا ارتقا می‌یابد' },
    ],
  },
  {
    id: 'cloud',
    title: '☁️ سرور ابری (اختیاری)',
    sub: 'برای میزبان همیشه‌روشن؛ برنامهٔ نصبی کاربر نیست',
    rows: [{ app: 'cloud', file: [CLOUD, 'payesh-cloud.zip'], note: 'بستهٔ استقرار سرور ابری' }],
  },
];

export const SUMS = [
  { label: 'اپ مدرسه (ویندوز و اندروید)', file: [SCHOOL, 'SHA256SUMS'] },
  { label: 'پنل مالک (ویندوز و اندروید)', file: [OWNER, 'SHA256SUMS'] },
  { label: 'سرور دیتابیس مدرسه', file: [SERVER, 'SHA256SUMS'] },
];

// Technical channels: files for the in-app updater / machines, never for a person.
export const TECHNICAL = [
  { tag: 'app-files', what: 'تکه‌های به‌روزرسانی خودکار اپ مدرسهٔ ویندوز (فقط تغییرات، gzip با نام هش)' },
  { tag: 'owner-files', what: 'تکه‌های به‌روزرسانی خودکار پنل مالک ویندوز (فقط تغییرات)' },
  { tag: CLOUD, what: 'مانیفست به‌روزرسانی و بستهٔ سرور ابری (بستهٔ سرور در جدول بالا هست)' },
  { tag: SCHOOL, what: 'محل انتشار اپ مدرسه + مانیفست به‌روزرسانی (app-update.json)' },
  { tag: OWNER, what: 'محل انتشار پنل مالک + مانیفست به‌روزرسانی (owner-update.json)' },
  { tag: SERVER, what: 'محل انتشار سرور دیتابیس مدرسه' },
];

/** Every [tag, file] a person can click in the generated surfaces. */
export function allLinks() {
  const out = [];
  for (const c of CATEGORIES) for (const r of c.rows) { out.push(r.file); if (r.portable) out.push(r.portable); }
  for (const s of SUMS) out.push(s.file);
  return out;
}

function table(c) {
  const lines = [
    `### ${c.title} — ${c.sub}`,
    '',
    '| برنامه | برای چه کسی | دانلود | بدون نصب (قابل‌حمل) | توضیح |',
    '|---|---|---|---|---|',
  ];
  for (const r of c.rows) {
    const a = APPS[r.app];
    lines.push(`| ${a.name} | ${a.who} | **${link(r.file, '⤓ `' + r.file[1] + '`')}** | ${r.portable ? link(r.portable) : '—'} | ${r.note || ''} |`);
  }
  return lines.join('\n');
}

function sumsTable() {
  return [
    '### 🔐 بررسی سلامت فایل (SHA-256)',
    '',
    '| برای | فایل |',
    '|---|---|',
    ...SUMS.map((s) => `| ${s.label} | ${link(s.file)} |`),
  ].join('\n');
}

const HELP = [
  '**کدام را بگیرم؟**',
  '- **ویندوز ۳۲ یا ۶۴ بیتی؟** ویندوز ۱۰/۱۱: تنظیمات ← System ← About ← «System type». ویندوز ۷/۸: کنترل پنل ← System ← «System type».',
  '- **سرور دیتابیس مدرسه** فقط روی یک رایانهٔ مدرسه نصب می‌شود. همهٔ اپ‌ها خودشان آن را پیدا می‌کنند و نیازی به وارد کردن نشانی نیست.',
  '- **پنل مالک** فقط برای مالک سامانه است، نه برای مدرسه.',
  '- نصب‌کننده‌های ویندوز هنوز امضای کد ندارند، پس SmartScreen هشدار می‌دهد: «More info» ← «Run anyway». برای اطمینان، هش فایل را با `SHA256SUMS` مقایسه کنید (`Get-FileHash نام-فایل`).',
  '- 🍎 آیفون/آیپد فایل نصبی ندارد. 🐧 روی لینوکس: `sudo bash install/linux/install.sh`.',
].join('\n');

export function readmeBlock() {
  return [
    START,
    '## ⬇️ دانلودها',
    '',
    'همهٔ لینک‌ها **مستقیم خود فایل** (آخرین ساخت) را دانلود می‌کنند. برنامه‌ها پس از نصب، به‌روزرسانی را خودشان خبر می‌دهند.',
    '',
    ...CATEGORIES.flatMap((c) => [table(c), '']),
    sumsTable(),
    '',
    HELP,
    END,
  ].join('\n');
}

export function releaseBody(info = {}) {
  const v = [];
  if (info.school_build) v.push(`اپ مدرسه **0.2.${info.school_build}**`);
  if (info.owner_build) v.push(`پنل مالک **1.1.${info.owner_build}**`);
  if (info.data_service) v.push(`سرور دیتابیس مدرسه **${info.data_service}**`);
  return [
    'این صفحه **فهرست دسته‌بندی‌شدهٔ همهٔ دانلودهای پایش** است. هر لینک مستقیم آخرین نسخهٔ همان فایل را دانلود می‌کند.',
    v.length ? `\nنسخه‌های فعلی: ${v.join(' · ')}` : '',
    '',
    ...CATEGORIES.flatMap((c) => [table(c), '']),
    sumsTable(),
    '',
    HELP,
    '',
    '---',
    '### ⚙️ انتشارهای فنی — دستی دانلود نکنید',
    'بقیهٔ انتشارهای این مخزن برای به‌روزرسانی خودکار و CI هستند:',
    '',
    '| انتشار | چیست |',
    '|---|---|',
    ...TECHNICAL.map((t) => `| \`${t.tag}\` | ${t.what} |`),
    '',
    info.updated || info.commit ? `<sub>به‌روزشده: ${info.updated || ''}${info.commit ? ' · commit ' + String(info.commit).slice(0, 7) : ''} — tools/release/downloads.mjs</sub>` : '<sub>tools/release/downloads.mjs</sub>',
  ].join('\n');
}

/** README with the block replaced (or inserted after the opening note when it does not exist yet). */
export function applyToReadme(text) {
  const block = readmeBlock();
  const s = text.indexOf(START.slice(0, 22));
  const e = text.indexOf(END);
  if (s >= 0 && e > s) return text.slice(0, s) + block + text.slice(e + END.length);
  throw new Error('README has no downloads block (markers missing)');
}

export function readmeBlockOf(text) {
  const s = text.indexOf(START.slice(0, 22));
  const e = text.indexOf(END);
  return s >= 0 && e > s ? text.slice(s, e + END.length) : null;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const rp = path.join(ROOT, README);
  const args = process.argv.slice(2);
  if (args.includes('--write-readme')) {
    fs.writeFileSync(rp, applyToReadme(fs.readFileSync(rp, 'utf8')));
    console.log('DOWNLOADS-README-WRITTEN');
  } else if (args.includes('--check')) {
    const cur = readmeBlockOf(fs.readFileSync(rp, 'utf8'));
    if (cur !== readmeBlock()) { console.log('DOWNLOADS-README-STALE — run: node tools/release/downloads.mjs --write-readme'); process.exit(1); }
    console.log('DOWNLOADS-README-OK links=' + allLinks().length);
  } else if (args.includes('--release-body')) {
    const i = args.indexOf('--info');
    const info = i >= 0 ? JSON.parse(fs.readFileSync(args[i + 1], 'utf8')) : {};
    process.stdout.write(releaseBody(info) + '\n');
  } else {
    console.error('usage: downloads.mjs --write-readme | --check | --release-body [--info info.json]');
    process.exit(2);
  }
}
