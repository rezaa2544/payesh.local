/*
 * پروب مرز پنل مالک/اپراتور — ردیف ۱۲‑ب (فاز ۲)
 * اجرا: node docs/cloud/reports/evidence/probe-12b-boundary.cjs
 *   (داخل دروازه: bash docs/cloud/reports/evidence/gen-cc12b-evidence.sh)
 *
 * ورودی‌ها (قابل جایگزینی برای آزمون منفی):
 *   CC12B_POLICY_FILE  پیش‌فرض server/policy.js
 *   CC12B_DOC          پیش‌فرض docs/cloud/12b-owner-panel-boundaries.md
 *   CC12B_DOC_01B      پیش‌فرض docs/cloud/01b-school-plan-subscription.md
 *
 * خروجی: خطوط ✓/✗ و سپس SUMMARY pass=N fail=M ؛ کد خروج ≠0 اگر هر بررسی شکست بخورد.
 */
'use strict';
const fs = require('node:fs');

const POLICY = process.env.CC12B_POLICY_FILE || 'server/policy.js';
const DOC = process.env.CC12B_DOC || 'docs/cloud/12b-owner-panel-boundaries.md';
const DOC01B = process.env.CC12B_DOC_01B || 'docs/cloud/01b-school-plan-subscription.md';

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.log(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function read(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// ---------- مرجع D-24 (۱۰ نقش نسخهٔ اول؛ office وجود ندارد) ----------
const D24 = ['platform_owner', 'platform_operator', 'platform_support', 'school_admin',
  'vice_principal', 'teacher', 'counselor', 'student', 'parent', 'guard'];
const PLATFORMISH = ['platform_owner', 'platform_operator', 'platform_support', 'owner', 'operator', 'support'];

// ---------- الف) مرز محصول: ROLES ----------
const policySrc = read(POLICY);
ok('فایل policy محصول خوانده شد', policySrc !== null, POLICY);
const m = policySrc ? policySrc.match(/const ROLES = \[([^\]]*)\]/) : null;
const roles = m ? m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : [];
ok('ROLES از server/policy.js قابل استخراج است', roles.length > 0, `roles=${roles.join(',') || 'none'}`);
ok('هیچ نقش پلتفرمی (owner/operator/support) در ROLES محصول نیست (default-deny)',
  roles.length > 0 && !roles.some((r) => PLATFORMISH.includes(r)), `roles=${roles.join(',')}`);
// نگاشت مستند ۰۱‑ب: نام محصول «manager» = نقش مصوب «school_admin»
const ROLE_MAP = { manager: 'school_admin' };
const mapped = roles.map((r) => ROLE_MAP[r] || r);
ok('همهٔ نقش‌های محصول پس از نگاشت مستند (manager→school_admin) زیرمجموعهٔ D-24 هستند',
  roles.length > 0 && mapped.every((r) => D24.includes(r)), `roles=${roles.join(',')} mapped=${mapped.join(',')}`);
ok('نگاشت manager→school_admin در سند ۰۱‑ب مستند شده است',
  (read(DOC01B) || '').includes('`school_admin`') && (read(DOC01B) || '').includes('`manager`'));
ok('نقش خارج از D-24 («office»/«staff»/«vice») در محصول صادر نمی‌شود',
  roles.length > 0 && !roles.includes('office') && !roles.includes('staff') && !roles.includes('vice'));

// ---------- ب) سند ۱۲‑ب: دامنهٔ D-20 و ناحیهٔ مالی ----------
const doc = read(DOC);
ok('سند ۱۲‑ب خوانده شد', doc !== null, DOC);
const D20_SECTIONS = ['داشبورد', 'مدارس', 'پلن/اشتراک', 'محدودیت/مصرف', 'سلامت فنی', 'اپراتورها', 'گزارش', 'امنیت/ممیزی'];
const missingD20 = doc ? D20_SECTIONS.filter((k) => !doc.includes(k)) : D20_SECTIONS;
ok('هشت بخش درون‌دامنهٔ D-20 در جدول نگاشت §۲.۱ آمده است',
  doc !== null && /۲\.۱ نگاشت/.test(doc) && missingD20.length === 0, `missing=${missingD20.join(',')}`);
ok('بخش ۸ (مالی) در جدول نگاشت صریحاً ❌ و خارج از v1 است',
  doc !== null && /۸ — مالی/.test(doc) && /خارج از v1/.test(doc));
ok('ناحیهٔ مالی صریحاً خارج از نسخهٔ اول علامت خورده (D-20/O-15)',
  doc !== null && /مالی/.test(doc) && /(خارج از نسخهٔ اول|فاز بعد|O‑15)/.test(doc));
ok('سند ۱۲‑ب تصمیم باز پنل را فهرست می‌کند (بدون انتخاب یک‌طرفه)',
  doc !== null && /##\s*۷\./.test(doc) && /تصمیم باز/.test(doc));

// ---------- ج) support_grant: تنها درِ محتوا، هم‌سان با ۰۱‑ب ----------
const doc01b = read(DOC01B);
ok('سند ۰۱‑ب (پیش‌نیاز ۱۲‑ب) خوانده شد', doc01b !== null, DOC01B);

const grant = [
  ['approved_by اجباری و ≠ درخواست‌دهنده (چهارچشمی)',
    doc !== null && doc.includes('approved_by') && /approved_by\s*<>\s*operator_id|approved_by <> operator_id/.test(doc)],
  ['school_notified_at اجباری پیش از شروع (D-21)',
    doc !== null && doc.includes('school_notified_at')],
  ['scope فقط metadata/content_read — content_write هرگز',
    doc !== null && /content_write/.test(doc) && /(هرگز|ENUM)/.test(doc)],
  ['reason اجباری با حداقل طول',
    doc !== null && /reason/.test(doc) && /(≥۱۰|۱۰ نویسه)/.test(doc)],
  ['سقف سخت ۷۲ ساعت (ends_at ≤ starts_at + 72h)',
    doc !== null && /(۷۲h|۷۲ ساعت)/.test(doc)],
  ['ابطال فوری یک‌طرفهٔ مدیر مدرسه (revoked_at)',
    doc !== null && doc.includes('revoked_at') && /(فوری|یک‌طرفه)/.test(doc)],
  ['هر خواندن محتوا در support_access_log ثبت می‌شود',
    doc !== null && doc.includes('support_access_log')],
  ['جدول یکتا و هم‌سان با ۰۱‑ب §۲.۶ (approved_by + school_notified_at در هر دو)',
    doc !== null && doc01b !== null && doc01b.includes('approved_by') &&
    doc01b.includes('school_notified_at') && doc.includes('۰۱‑ب §۲.۶'.replace('§', '§')) || false],
];
for (const [name, cond] of grant) ok(name, cond === true);

// ---------- د) ماتریس پذیرش ۱۲‑ب ----------
const acSection = doc ? (doc.split('## ۶.')[1] || '') : '';
const acRows = (acSection.match(/^\|\s*AC[^\|]*\|/gm) || []).length;
ok('ماتریس پذیرش ۱۲‑ب هفت ردیف دارد', acRows === 7, `rows=${acRows}`);
const acPass = (acSection.match(/✅/g) || []).length;
ok('همهٔ هفت معیار در سند PASS علامت خورده‌اند', acPass >= 7, `✅=${acPass}`);

console.log('');
console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
