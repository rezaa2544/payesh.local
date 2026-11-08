'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون شناسهٔ تصمیم اسناد ۳۱/۳۲/۳۴ — ردیف ۶۰    (AD-01 .. AD-09)

   قاعده: شناسهٔ این سه تصمیم ADR‑31/ADR‑32/ADR‑34 است تا با تصمیم‌های
   موجود (D‑31 محیط بار، D‑32 سقف پلن، D‑34 هم‌ترازی وضعیت) قاطی نشود.
   صفر تغییر منطق محصول: فقط سند/آزمون/شاهد.

   اجرا: npm run test:adr60
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const mod = require(path.join(ROOT, 'tools', 'adr-ids-60.mjs'));

let passed = 0, failed = 0; const failures = [];
function check(id, desc, fn) {
  try { const d = fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; failures.push(id); console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e).slice(0, 260)}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }

const NB = '\u2011';

/* ریشهٔ موقت با همان ساختار سه سند (برای کنترل منفی) */
function tmpRoot(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-adr60-'));
  fs.mkdirSync(path.join(dir, 'docs', 'cloud'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs', 'cloud', 'reports', 'evidence'), { recursive: true });
  for (const [n, rel] of Object.entries(mod.DOCS)) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    fs.writeFileSync(path.join(dir, rel), src);
    void n;
  }
  if (mutate) mutate(dir);
  return dir;
}

check('AD-01', 'مخزن واقعی سالم است (هر سه سند با ADR‑<n>)', () => {
  const r = mod.run(ROOT);
  assert(r.ok, 'نقض: ' + JSON.stringify(r.problems).slice(0, 240));
  assert(r.results.length === 3, 'تعداد سند=' + r.results.length);
  return r.results.map(x => x.id).join(' · ');
});

check('AD-02', 'شناسهٔ ADR در سرصفحهٔ هر سه سند هست', () => {
  for (const [n, rel] of Object.entries(mod.DOCS)) {
    const head = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').slice(0, 12).join('\n');
    assert(mod.hasAdrId(head, n), `${rel}: ADR-${n} در سرصفحه نیست`);
  }
  return '3/3';
});

check('AD-03', 'هیچ سند شناسهٔ خودش را با D‑<n> نمی‌نویسد', () => {
  for (const [n, rel] of Object.entries(mod.DOCS)) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert(mod.hasBareDId(text, n) === false, `${rel}: D-${n} باقی مانده`);
  }
  return 'bare D = 0';
});

check('AD-04', 'کنترل منفی: برگرداندن D‑31 در سند ۳۱ ⇒ قرمز', () => {
  const dir = tmpRoot(d => {
    const p = path.join(d, mod.DOCS['31']);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('ADR' + NB + '31', 'D' + NB + '31'));
  });
  const r = mod.run(dir);
  assert(r.ok === false, 'باید قرمز شود');
  const hit = r.problems.filter(p => /31-adr-local-engine/.test(p.file));
  assert(hit.length > 0, 'هیچ نقضی برای سند ۳۱ گزارش نشد: ' + JSON.stringify(r.problems));
  return 'red: ' + hit.map(p => p.rule).join('+');
});

check('AD-05', 'کنترل منفی: D‑32 به‌جای ADR‑32 در متن ⇒ قرمز (R2)', () => {
  const dir = tmpRoot(d => {
    const p = path.join(d, mod.DOCS['32']);
    const text = fs.readFileSync(p, 'utf8') + '\nارجاع قدیمی: D' + NB + '32\n';
    fs.writeFileSync(p, text);
  });
  const r = mod.run(dir);
  assert(r.ok === false, 'باید قرمز شود');
  assert(r.problems.some(p => p.rule === 'R2'), 'R2 گزارش نشد: ' + JSON.stringify(r.problems));
  return 'R2 red';
});

check('AD-06', 'کنترل منفی: ارجاع tests/ با D‑34 به‌جای ADR‑34 ⇒ قرمز (R3)', () => {
  const dir = tmpRoot(d => {
    fs.writeFileSync(path.join(d, 'tests', 'fake-boundary.js'),
      "test('سند مرز 34-provider-selection و D-34', () => {});\n");
  });
  const r = mod.run(dir);
  assert(r.ok === false, 'باید قرمز شود');
  assert(r.problems.some(p => p.rule === 'R3'), 'R3 گزارش نشد: ' + JSON.stringify(r.problems));
  return 'R3 red';
});

check('AD-07', 'ارقام فارسی هم تشخیص داده می‌شوند (ردیف ۳۱ + D‑31)', () => {
  const dir = tmpRoot(d => {
    fs.writeFileSync(path.join(d, 'tests', 'fake-fa.js'),
      "// ردیف ۳۱ — ارجاع قدیمی D" + NB + "31\n");
  });
  const r = mod.run(dir);
  assert(r.ok === false, 'باید قرمز شود');
  assert(r.problems.some(p => p.rule === 'R3'), 'R3 فارسی گزارش نشد');
  return 'fa digits detected';
});

check('AD-08', 'CLI: کد خروج و خروجی JSON درست است', () => {
  const good = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'adr-ids-60.mjs'), '--json'], { encoding: 'utf8' });
  assert(good.status === 0, 'exit=' + good.status);
  const j = JSON.parse(good.stdout);
  assert(j.ok === true && j.results.length === 3, 'JSON ناسازگار');
  const bad = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'adr-ids-60.mjs'), '--root', '/tmp/definitely-not-a-repo'], { encoding: 'utf8' });
  assert(bad.status === 1, 'ریشهٔ ناموجود باید exit=1 بدهد، شد ' + bad.status);
  return 'exit 0/1 + JSON';
});

check('AD-09', 'دامنهٔ بررسی فقط سند/آزمون/شاهد است (منطق محصول دست‌نخورده)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'adr-ids-60.mjs'), 'utf8');
  assert(/REF_DIRS = \['tests', 'docs\/cloud\/reports\/evidence'\]/.test(src), 'دامنهٔ ارجاع‌ها تغییر کرده');
  const r = mod.run(ROOT);
  const files = new Set(r.results.map(x => x.doc));
  for (const f of files) assert(/^docs\/cloud\//.test(f), 'فایل غیرسندی در دامنه: ' + f);
  for (const ref of r.references) assert(/^(tests|docs\/cloud\/reports\/evidence)\//.test(ref.file), 'ارجاع بیرون از دامنه: ' + ref.file);
  return `docs=3 refs=${r.reference_count}`;
});

console.log(`\nAD checks=${passed + failed} pass=${passed} fail=${failed}`);
if (failures.length) console.log('failures: ' + failures.join(','));
console.log(failed === 0 ? 'ADR-IDS-60-TEST-OK' : 'ADR-IDS-60-TEST-FAILED');
process.exit(failed === 0 ? 0 : 1);
