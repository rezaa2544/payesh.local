'use strict';
/* آزمون مرز مخزن — ردیف ۳۲ (ADR-32)
   قاعده: تنها مخزن مرجع `rezaa2544/payesh.local` است؛ `rezaa2544/p2` فقط بایگانی/خواندنی.
   هر ارجاع تازه به مخزن دیگر (یا مسیر بیرون از این مخزن) باید صریحاً در ALLOW ثبت شود،
   وگرنه آزمون fail-closed قرمز می‌شود.

   اجرا: npm run test:boundary
*/
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
let PASS = 0, FAIL = 0;
const failures = [];
function test(name, fn) {
  try { fn(); PASS++; console.log('  ✓ ' + name); }
  catch (e) { FAIL++; failures.push(name + ' — ' + e.message); console.log('  ✗ ' + name + ' — ' + e.message); }
}

/* فایل‌هایی که مجازند به مخزن بایگانی اشاره کنند — هر مورد باید دلیل داشته باشد.
   موارد موجود، سابقهٔ مشروع و فقط-خواندنی‌اند (بازبینی تاریخی + دریافت مقایسه‌ای)؛
   هر ارجاع تازه باید صریحاً همین‌جا با دلیل اضافه شود، وگرنه آزمون قرمز می‌شود. */
const ALLOW = new Map([
  ['docs/cloud/32-repo-boundary.md', 'سند مرز ADR‑32 (خودِ تصمیم)'],
  ['tests/repo-boundary.js', 'همین آزمون'],
  ['docs/01-payesh-upstream-audit.md', 'سابقهٔ بازبینی تاریخی مخزن بایگانی (فقط خواندن)'],
  ['scripts/fetch-upstream.sh', 'اسکریپت دریافت فقط-خواندنی برای مقایسه؛ هیچ push/نوشتنی ندارد'],
]);

const SKIP_DIRS = new Set(['.git', 'node_modules', 'releases', 'backups', '.arena', '.build', 'dist', 'tmp']);
const TEXT_EXT = /\.(md|js|cjs|mjs|json|yml|yaml|sh|txt|html|css|gradle|xml)$/;
const PATTERNS = [
  { re: /rezaa2544\/p2\b/g, why: 'ارجاع به مخزن بایگانی p2' },
  { re: /\.\.\/p2\b/g, why: 'مسیر نسبی بیرون از مخزن (../p2)' },
  { re: /github\.com\/rezaa2544\/(?!payesh\.local\b)[A-Za-z0-9_.-]+/g, why: 'ارجاع به مخزن دیگر' },
];

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(name.name)) continue;
    const p = path.join(dir, name.name);
    if (name.isDirectory()) walk(p, out);
    else if (TEXT_EXT.test(name.name)) out.push(p);
  }
  return out;
}

/* گزارش‌های خام شاهد (.txt) متن اجرای آزمون‌ها را عیناً نقل می‌کنند (از جمله همین
   آزمون)؛ اسکن آن‌ها دور باطل می‌سازد. سندهای .md گزارش همچنان اسکن می‌شوند. */
function isRawEvidenceLog(rel) {
  return rel.startsWith('docs/cloud/reports/evidence/') && rel.endsWith('.txt');
}

const files = walk(ROOT);
const hits = [];
for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (ALLOW.has(rel) || isRawEvidenceLog(rel)) continue;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
  if (!/\b(p2|rezaa2544)\b/.test(text)) continue;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      if (p.re.test(lines[i])) hits.push({ file: rel, line: i + 1, why: p.why, text: lines[i].trim().slice(0, 120) });
    }
  }
}

test('هیچ ارجاع ناشناخته‌ای به مخزن/مسیر بیرونی وجود ندارد (fail-closed)', () => {
  if (hits.length) {
    const msg = hits.slice(0, 6).map(h => `  ${h.file}:${h.line} — ${h.why} — ${h.text}`).join('\n');
    throw new Error(hits.length + ' ارجاع مجازنشده:\n' + msg);
  }
});

test('فهرست مجاز کوچک، صریح و هر مورد دارای دلیل است', () => {
  const expected = ['docs/01-payesh-upstream-audit.md', 'docs/cloud/32-repo-boundary.md', 'scripts/fetch-upstream.sh', 'tests/repo-boundary.js'];
  const got = [...ALLOW.keys()].sort();
  if (JSON.stringify(got) !== JSON.stringify(expected.sort())) throw new Error('ALLOW تغییر کرده: ' + got.join(', '));
  for (const [f, why] of ALLOW) {
    if (!why || why.length < 8) throw new Error('دلیل کافی برای مجازسازی نیست: ' + f);
    if (!fs.existsSync(path.join(ROOT, f))) throw new Error('فایل مجازشده وجود ندارد: ' + f);
  }
});

test('گزارش خام شاهد از اسکن کنار گذاشته می‌شود، ولی سندهای گزارش نه', () => {
  if (!isRawEvidenceLog('docs/cloud/reports/evidence/phase2-decisions.txt')) throw new Error('گزارش خام شاهد کنار گذاشته نمی‌شود');
  if (isRawEvidenceLog('docs/cloud/reports/REVIEW-16-CONDITIONS.md')) throw new Error('سند گزارش به‌اشتباه کنار گذاشته می‌شود');
});

test('اسکریپت دریافت مخزن بایگانی فقط-خواندنی است (هیچ push/commit ندارد)', () => {
  const p = path.join(ROOT, 'scripts/fetch-upstream.sh');
  const text = fs.readFileSync(p, 'utf8');
  for (const bad of ['git push', 'git commit', 'git tag', 'gh pr create']) {
    if (text.includes(bad)) throw new Error('اسکریپت دریافت، عملیات نوشتنی دارد: ' + bad);
  }
  if (!/git clone/.test(text)) throw new Error('اسکریپت دریافت، clone ندارد');
});

test('سند مرز وجود دارد و تصمیم ADR‑32 را ثبت کرده است', () => {
  const p = path.join(ROOT, 'docs/cloud/32-repo-boundary.md');
  if (!fs.existsSync(p)) throw new Error('سند ۳۲ نیست');
  const text = fs.readFileSync(p, 'utf8');
  for (const needle of ['ADR‑32', 'payesh.local', 'فقط-خواندنی']) {
    if (!text.includes(needle)) throw new Error('عبارت «' + needle + '» در سند نیست');
  }
});

test('مخزن مرجع یکتاست: گزارش‌های مرجع فقط payesh.local را نام می‌برند', () => {
  const filesRef = files.filter(f => /docs\/cloud\/reports\/.*\.(md|txt)$/.test(path.relative(ROOT, f).split(path.sep).join('/')));
  for (const f of filesRef) {
    const text = fs.readFileSync(f, 'utf8');
    if (/github\.com\/rezaa2544\/(?!payesh\.local)/.test(text)) throw new Error('ارجاع به مخزن دیگر در ' + path.relative(ROOT, f));
  }
});

console.log('\n' + PASS + ' موفق · ' + FAIL + ' ناموفق\n');
if (FAIL) { console.log('شکست‌ها:\n - ' + failures.join('\n - ')); process.exit(1); }
