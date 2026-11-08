#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   شناسهٔ تصمیم اسناد ۳۱/۳۲/۳۴ — ردیف ۶۰                (ADR-IDS-60)

   مسئله: سه سند تصمیم با شناسهٔ D‑31/D‑32/D‑34 ثبت شده بودند، در حالی که
   همین شماره‌ها از قبل برای تصمیم‌های دیگری (D‑31 محیط بار، D‑32 سقف پلن،
   D‑34 هم‌ترازی وضعیت) به‌کار می‌رفتند. یعنی یک شماره، دو تصمیم.

   این ابزار فقط مستندات/آزمون‌ها را می‌سنجد؛ صفر تغییر منطق محصول.
   قاعده‌ها:
     R1  هر سه سند باید شناسهٔ ADR‑<n> داشته باشند (در سرصفحه).
     R2  هیچ‌کدام نباید شناسهٔ خودش را با D‑<n> بنویسد (هر شکل خط تیره).
     R3  ارجاع‌ها در tests/ و evidence باید همان شکل ADR‑<n> را داشته باشند.
     R4  سند/آزمونی که شمارهٔ سند را با D‑ می‌نویسد ⇒ قرمز (کنترل منفی).

   اجرا: node tools/adr-ids-60.mjs [--root <dir>] [--json]
   کد خروج: ۰ سالم · ۱ نقض
   ═══════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
export const ROOT = path.resolve(arg('root', path.resolve(HERE, '..')));

const HYPHENS = ['\u2011', '-', '\u2013', '\u2014'];
export const DOCS = {
  31: 'docs/cloud/31-adr-local-engine.md',
  32: 'docs/cloud/32-repo-boundary.md',
  34: 'docs/cloud/34-provider-selection.md',
};
export const REF_DIRS = ['tests', 'docs/cloud/reports/evidence'];
/* خودِ ابزار و آزمونش نمونه‌های «غلط» را عمداً نگه می‌دارند تا کنترل منفی
   وجود داشته باشد؛ اسکن‌شدن آن‌ها یعنی سنجش، خودش را قرمز کند. */
export const REF_IGNORE = new Set([
  'tools/adr-ids-60.mjs',
  'tests/adr-ids-60.js',
  /* شاهد و اسکریپتش عمداً شناسهٔ غلط را می‌سازند تا کنترل منفیِ زنده نشان داده شود */
  'docs/cloud/reports/evidence/run-60-adr-ids.sh',
  'docs/cloud/reports/evidence/adr-ids-60.txt',
]);
export const DOC_FILE = { 31: '31-adr-local-engine', 32: '32-repo-boundary', 34: '34-provider-selection' };

/* ارقام فارسی/عربی هم باید تشخیص داده شوند */
export function numVariants(n) {
  const fa = String(n).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
  const ar = String(n).replace(/[0-9]/g, d => '٠١٢٣٤٥٦٧٨٩'[Number(d)]);
  return [String(n), fa, ar];
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* شناسهٔ درست: ADR‑<n> با هر شکل خط تیره */
export function hasAdrId(text, n) {
  return HYPHENS.some(h => new RegExp('ADR' + esc(h) + n + '\\b').test(text));
}
/* شناسهٔ غلط: D‑<n> (نه ADR‑<n> و نه بخشی از کلمهٔ دیگر) */
export function hasBareDId(text, n) {
  /* هرجا D‑<n> آمده باشد (بدون ADR) یعنی شناسهٔ اشتباه؛ وجود ADR‑<n> در جای
     دیگر سند آن را توجیه نمی‌کند. */
  return HYPHENS.some(h => new RegExp('(?<![A-Za-z0-9])D' + esc(h) + n + '(?![0-9])').test(text));
}

function readIf(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }

function walk(dir, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    if (['node_modules', '.git', 'releases', 'data'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(md|js|mjs|cjs|txt|sh|json)$/.test(e.name)) out.push(p);
  }
  return out;
}

export function run(root = ROOT) {
  const problems = [];
  const results = [];
  for (const [n, rel] of Object.entries(DOCS)) {
    const text = readIf(path.join(root, rel));
    if (text === null) { problems.push({ rule: 'R0', file: rel, why: 'سند نیست' }); continue; }
    const head = text.split('\n').slice(0, 12).join('\n');
    const adrOk = hasAdrId(head, n);
    const ownBareD = hasBareDId(text, n);
    if (!adrOk) problems.push({ rule: 'R1', file: rel, why: 'شناسهٔ ADR‑' + n + ' در سرصفحه نیست' });
    if (ownBareD) problems.push({ rule: 'R2', file: rel, why: 'شناسهٔ سند با D‑' + n + ' نوشته شده' });
    results.push({ doc: rel, id: 'ADR-' + n, adr_id_in_header: adrOk, bare_d_in_doc: ownBareD });
  }

  /* R3: ارجاع‌ها در tests/ و evidence — اگر شمارهٔ سند آمده باشد، باید ADR باشد */
  const refs = [];
  for (const d of REF_DIRS) {
    for (const f of walk(path.join(root, d), [])) {
      const relF = path.relative(root, f).split(path.sep).join('/');
      if (REF_IGNORE.has(relF)) continue;
      const text = readIf(f);
      if (text === null) continue;
      for (const n of Object.keys(DOCS)) {
        const nums = numVariants(n);
        const mentionsDoc = new RegExp(esc(DOC_FILE[n]), 'i').test(text) ||
          nums.some(v => new RegExp('ADR[-\\u2011\\u2013]' + esc(v)).test(text)) ||
          nums.some(v => new RegExp('(ردیف|row)\\s*' + esc(v)).test(text));
        const bare = HYPHENS.some(h => numVariants(n).some(v =>
          new RegExp('D' + esc(h) + esc(v) + '(?![0-9])').test(text)));
        if (mentionsDoc && bare) {
          problems.push({ rule: 'R3', file: path.relative(root, f), why: 'ارجاع با D‑' + n + ' به‌جای ADR‑' + n });
        }
        if (hasAdrId(text, n)) refs.push({ file: path.relative(root, f), id: 'ADR-' + n });
      }
    }
  }
  return { ok: problems.length === 0, problems, results, references: refs.slice(0, 40), reference_count: refs.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = run();
  if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    for (const x of r.results) console.log(`DOC ${x.doc} → ${x.id} (header=${x.adr_id_in_header} bareD=${x.bare_d_in_doc})`);
    console.log(`# ارجاع‌های ADR در tests/ و evidence: ${r.reference_count}`);
    for (const p of r.problems) console.log(`PROBLEM ${p.rule} ${p.file} — ${p.why}`);
    console.log(r.ok ? 'ADR-IDS-60-OK' : 'ADR-IDS-60-FAILED');
  }
  process.exit(r.ok ? 0 : 1);
}
