'use strict';
/* ═══════════════════════════════════════════════════════════════════
   گیت منفی برچسب‌ها — ردیف ۵۵ (برچسب‌گذاری اعداد بر قانون اساسی)

   قانون اساسی (بازنگری ۱.۱۲):
     [M] = سنجیده‌شده روی هدف واقعی
     [S] = شبیه‌سازی/ماشین توسعه (loopback، SQLite)
     [E] = برآورد · [A] = فرض · [?] = ناشناخته

   این گیت fail-closed قرمز می‌شود اگر در اسناد ردیف‌های ۴۵/۴۶/۵۰/۵۵/۵۶/۵۷
   و شواهد خام آن‌ها:
     ۱) تعریفِ اشتباهِ برچسب دیده شود (مثل «[M] اندازه‌گیری‌شده در مخزن» —
        تعریف قدیمی که [M] را «سنجیده‌شده» می‌دانست)؛ یا
     ۲) برچسب [M] کنار عددی از اجرای loopback/محلی (ماشین توسعه، SQLite،
        شبیه‌سازی) ظاهر شود — چنین عددی باید [S] باشد.

   کاربردهای مجاز [M] (ارجاع به «هدف واقعی» یا خودِ تعریف برچسب) در ALLOW
   ثبت شده‌اند؛ هر افزودن [M] تازه باید دلیل خودش را این‌جا داشته باشد.

   اجرا: node tests/labels-gate-55.js   (در CI: همان خط در .github/workflows/build.yml)
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');

const FILES = [
  'docs/cloud/45-connection-budget.md',
  'docs/cloud/46-fleet-load.md',
  'docs/cloud/50-pitr-recovery.md',
  'docs/cloud/55-go-nogo.md',
  'docs/cloud/56-owner-decision.md',
  'docs/cloud/57-pentest-package.md',
  /* شواهد خام همین ردیف‌ها */
  'docs/cloud/reports/evidence/conn-budget-45.txt',
  'docs/cloud/reports/evidence/fleet-46.txt',
  'docs/cloud/reports/evidence/fleet-46.json',
  'docs/cloud/reports/evidence/fleet-46-windows-hermes.txt',
  'docs/cloud/reports/evidence/fleet-46-windows-hermes.json',
  'docs/cloud/reports/evidence/load-55-ceiling.json',
  'docs/cloud/reports/evidence/load-55-ceiling-run2.json',
  'docs/cloud/reports/evidence/pitr-50.txt',
  'docs/cloud/reports/evidence/pentest-57-env.json',
  'docs/cloud/reports/evidence/phase2-decisions.txt',
  /* row 82: load test doc + raw evidence (every number [S]) */
  'docs/cloud/82-load-test.md',
  'docs/cloud/reports/evidence/load-82.txt',
  'docs/cloud/reports/evidence/load-82-report.json',
  'docs/cloud/reports/evidence/load-82-direct.txt',
  'docs/cloud/reports/evidence/load-82-direct-report.json',
];

/* تعریفِ اشتباه (قدیم): [M] «اندازه‌گیری‌شده در مخزن/همین مخزن» */
const WRONG_DEF = /\[M\][^\n]{0,60}اندازه‌گیری‌شده در (همین )?مخزن/;

/* کاربردهای مجاز [M] — هر کدام دلیل خودش را دارد */
const ALLOW = [
  { re: /قانون برچسب‌گذاری|سنجیده‌شده روی \*{0,2}هدف واقعی\*{0,2}/, why: 'خودِ تعریف قانون برچسب‌گذاری قانون اساسی' },
  { file: 'docs/cloud/55-go-nogo.md', re: /\[M\].{0,40}Chrome 157/, why: 'ردیف ۳۹: سنجش روی مرورگر واقعی (Chrome 157 و Android 16) — هدف واقعی موتور دادهٔ کلاینت، نه اجرای loopback این سند' },
  { file: 'docs/cloud/46-fleet-load.md', re: /گام .*\[M\]|مرحلهٔ بعدی برای `\[M\]`/, why: 'ارجاع به سنجش آینده روی هدف واقعی (دو میزبان فیزیکی) — عدد نیست' },
  { file: 'docs/cloud/reports/evidence/load-55-ceiling.json', re: /\[S\] نه \[M\]/, why: 'نفیِ صریح: شاهد محلی [S] است، نه [M]' },
  { file: 'docs/cloud/reports/evidence/load-55-ceiling-run2.json', re: /\[S\] نه \[M\]/, why: 'نفیِ صریح: شاهد محلی [S] است، نه [M]' },
  { file: 'docs/cloud/reports/evidence/pitr-50.txt', re: /\[M\]/, why: 'تمام [M]های pitr-50 مرجع «PostgreSQL مدیریت‌شدهٔ تولید» هستند (PT-02 خودش تفکیک [S]/[M] را اجبار می‌کند؛ PITR-50-SIMULATED-OK دست‌نخورده می‌ماند)' },
  { file: 'docs/cloud/50-pitr-recovery.md', re: /\[M\]/, why: 'تمام [M]های این سند مرجع «اجرا روی PostgreSQL مدیریت‌شدهٔ تولید» هستند (پس از O-20)؛ تمرین محلی همان‌جا [S] و PITR-50-SIMULATED-OK دست‌نخورده می‌ماند' },
  { file: 'docs/cloud/reports/evidence/phase2-decisions.txt', re: /شبیه‌سازی\/ماشین توسعه/, why: 'خودِ سطر تعریف برچسب‌ها در شاهد خام' },
];

let violations = [];
let checks = 0;

function allowed(rel, line) {
  for (const a of ALLOW) {
    if (a.file && a.file !== rel) continue;
    if (a.re.test(line)) return a.why;
  }
  return null;
}

function scan(rel, text, sink) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    /* ۱) تعریف اشتباه */
    if (WRONG_DEF.test(line)) {
      sink.push(`${rel}:${i + 1} — تعریف اشتباه برچسب: «[M] اندازه‌گیری‌شده در مخزن». قانون اساسی: [M] = سنجیده‌شده روی هدف واقعی، [S] = شبیه‌سازی/ماشین توسعه`);
    }
    /* ۲) [M] کنار عدد اجرای محلی */
    if (line.includes('[M]')) {
      const why = allowed(rel, line);
      if (!why) {
        sink.push(`${rel}:${i + 1} — برچسب [M] بدون مجوز: ${line.trim().slice(0, 140)} :: اگر عدد از اجرای loopback/ماشین توسعه/SQLite است باید [S] باشد؛ در غیر این صورت دلیلش را در ALLOW آزمون ثبت کنید.`);
      } else {
        checks++;
      }
    }
  }
}

/* ── ۱) گیت روی فایل‌های مخزن ─────────────────────────────────── */
let missing = 0;
for (const rel of FILES) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) { violations.push(`${rel} — فایل گیت موجود نیست`); missing++; continue; }
  scan(rel, fs.readFileSync(full, 'utf8'), violations);
}

/* ── ۲) کنترل منفی: گیت باید تعاریف اشتباه را ببیند ─────────── */
const NEG = path.join(os.tmpdir(), `labels-gate-55-negative-${process.pid}.md`);
fs.writeFileSync(NEG, [
  '## نمونهٔ قرمز',
  'برچسب‌ها: [M] اندازه‌گیری‌شده در مخزن · [A] فرض مهندسی',
  'سقف: ۱۵۶۰ RPS [M] روی ماشین توسعه (loopback)',
  'سقف: ۱۵۶۰ RPS [S] روی ماشین توسعه (loopback)',
  '',
].join('\n'));
const negHits = [];
scan('negative-fixture.md', fs.readFileSync(NEG, 'utf8'), negHits);
fs.unlinkSync(NEG);

const negWrongDef = negHits.some(h => h.includes('تعریف اشتباه'));
const negBadM = negHits.some(h => h.includes('برچسب [M] بدون مجوز'));
const negCleanS = !negHits.some(h => h.includes('۱۵۶۰ RPS [S]'));

/* ─ـ گزارش ───────────────────────────────────────────────────── */
console.log('\nگیت برچسب‌های قانون اساسی — ردیف‌های ۴۵/۴۶/۵۰/۵۵/۵۶/۵۷');
console.log(`  فایل‌های اسکن‌شده: ${FILES.length - missing} · کاربردهای مجاز [M]: ${checks}`);

const out = [];
const ok = (c, m) => { out.push((c ? '  ✓ ' : '  ✗ ') + m); return c; };

let good = true;
good = ok(missing === 0, `همهٔ فایل‌های گیت موجودند (${FILES.length} فایل)`) && good;
good = ok(violations.length === 0, `هیچ تعریف اشتباه یا [M] بدون مجازی در اسناد نیست (${violations.length} مورد)`) && good;
good = ok(negWrongDef, 'کنترل منفی: تعریف «[M] اندازه‌گیری‌شده در مخزن» شناسایی می‌شود') && good;
good = ok(negBadM, 'کنترل منفی: «۱۵۶۰ RPS [M] روی ماشین توسعه» شناسایی می‌شود') && good;
good = ok(negCleanS, 'کنترل منفی: «۱۵۶۰ RPS [S] روی ماشین توسعه» شناسایی نمی‌شود (مثبت کاذب نیست)') && good;

console.log(out.join('\n'));
if (violations.length) {
  console.log('\nموارد قرمز:');
  for (const v of violations) console.log('  ✗ ' + v);
}
console.log(negHits.length === 3
  ? `\nکنترل منفی: هر دو تخطی شناسایی شد (تعریف اشتباه + [M] کنار عدد محلی) و ردیفِ [S] سبز ماند`
  : `\nکنترل منفی: تعداد غیرمنتظره=${negHits.length}`);

if (!good || violations.length) {
  console.log('\nLABELS-GATE-55-FAIL');
  process.exit(1);
}
console.log('\nLABELS-GATE-55-OK');
