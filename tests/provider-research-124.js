'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۱۲۴ — اعتبارسنجی سند پژوهش Providerها (docs/cloud/124-provider-api-research.md)

   PR-01  جدول قابلیت: هر Provider دقیقاً ۴ قابلیت؛ سطح ∈ {L1,L2,L3}؛ برچسب ∈ {[A],[E],[?]}
   PR-02  [A]/[E] فقط با پیوند https؛ بدون منبع ⇒ [?] و L1 (ادعای قابلیت بی‌منبع ممنوع)
   PR-03  هر L3 صریحاً «ممنوع» است (Provisioning خودکار در پنل نیست)
   PR-04  هزینه: هر عدد فقط با منبع (https یا مسیر مخزن) و برچسب [A]/[E]؛ بی‌عدد ⇒ [?]
   PR-05  هم‌خوانی با کد: تا وقتی infra.js فقط آداپتور manual دارد، سند می‌گوید manual پیش‌فرض است
          و هیچ عبارتی ادعای اتصال/اجرای واقعی نمی‌کند
   PR-06  جهش‌ها: هر ویرایش ممنوع قرمز می‌شود
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DOC = 'docs/cloud/124-provider-api-research.md';
const LEVELS = ['L1', 'L2', 'L3'];
const LABELS = ['[A]', '[E]', '[?]'];
const CAPS = ['فهرست منابع', 'وضعیت و سلامت', 'ظرفیت و مصرف', 'Provisioning'];
const DIGIT = /[0-9۰-۹]/;

function assert(c, m) { if (!c) throw new Error(m); }
function section(doc, n) {
  const re = new RegExp('^## ' + n + '\\.', 'm');
  const m = re.exec(doc); assert(m, 'section ' + n + ' missing');
  const rest = doc.slice(m.index + 3);
  const next = /^## /m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}
function rows(sec) {
  return sec.split('\n').filter(l => l.startsWith('| ') && !/^\|\s*-/.test(l))
    .slice(1).map(l => l.replace(/^\|\s*|\s*\|\s*$/g, '').split(/\s+\|\s+/));
}
const capRows = doc => rows(section(doc, '۲')).map(c => ({ provider: c[0], cap: c[1], level: c[2], label: c[3], source: c[4], note: c[5] || '' }));
const costRows = doc => rows(section(doc, '۳')).map(c => ({ provider: c[0], item: c[1], value: c[2], label: c[3], source: c[4] || '' }));

function prShape(doc) {
  const r = capRows(doc);
  assert(r.length >= 8, 'capability table too small: ' + r.length);
  const by = {};
  for (const x of r) {
    assert(LEVELS.includes(x.level), `${x.provider}/${x.cap}: level ${x.level} not in L1/L2/L3`);
    assert(LABELS.includes(x.label), `${x.provider}/${x.cap}: label ${x.label} not in [A]/[E]/[?]`);
    assert(CAPS.includes(x.cap), `${x.provider}: unknown capability ${x.cap}`);
    (by[x.provider] = by[x.provider] || []).push(x.cap);
  }
  for (const [p, cs] of Object.entries(by)) {
    assert(cs.length === 4 && CAPS.every(c => cs.includes(c)), p + ': needs exactly the 4 capabilities, has ' + cs.join(','));
  }
  assert(by.RadCloud, 'RadCloud row missing');
  return Object.keys(by).length + ' providers';
}
function prSources(doc) {
  for (const x of capRows(doc)) {
    const hasLink = /<https:\/\/[^>\s]+>/.test(x.source);
    if (x.label === '[A]' || x.label === '[E]') assert(hasLink, `${x.provider}/${x.cap}: ${x.label} without https source`);
    if (!hasLink) assert(x.label === '[?]' && x.level === 'L1', `${x.provider}/${x.cap}: no source ⇒ must be L1 [?]`);
  }
}
function prL3(doc) {
  for (const x of capRows(doc)) if (x.level === 'L3') assert(/ممنوع/.test(x.note), `${x.provider}/${x.cap}: L3 must state it is forbidden in the panel`);
  assert(/L3[^\n]*فعلاً ممنوع/.test(section(doc, '۱')), 'level table must say L3 is forbidden for now');
}
function prCost(doc) {
  const r = costRows(doc);
  assert(r.length >= 1, 'cost table empty');
  for (const x of r) {
    const numeric = DIGIT.test(x.value);
    const src = /<https:\/\/[^>\s]+>/.test(x.source) || /`docs\/[^`]+`/.test(x.source);
    if (numeric) {
      assert(src, `${x.provider}/${x.item}: number without source`);
      assert(/\[(A|E)\]/.test(x.label), `${x.provider}/${x.item}: number needs [A] or [E]`);
    } else {
      assert(/\[\?\]/.test(x.label), `${x.provider}/${x.item}: no number ⇒ [?]`);
    }
    const m = /`(docs\/[^`]+)`/.exec(x.source);
    if (m) assert(fs.existsSync(path.join(ROOT, m[1])), 'cost source path missing: ' + m[1]);
  }
}
function adapters() {
  const m = /const ADAPTERS = \{([^}]*)\}/.exec(fs.readFileSync(path.join(ROOT, 'apps/owner-panel/server/infra.js'), 'utf8'));
  return m ? m[1].split(',').map(x => x.split(':')[0].trim()).filter(Boolean) : [];
}
function prCode(doc, adapterList) {
  const a = adapterList || adapters();
  if (a.length === 1 && a[0] === 'manual') {
    assert(/آداپتور `manual` می‌ماند/.test(section(doc, '۴')), 'only manual adapter exists — doc must say manual stays default');
    const rc = capRows(doc).filter(x => x.provider === 'RadCloud');
    assert(rc.every(x => x.level === 'L1'), 'RadCloud has no adapter — all RadCloud rows must be L1');
  }
  assert(!/(متصل شد|اجرا شد روی|با موفقیت فراخوانی|connected successfully)/.test(doc), 'doc must not claim a real API call');
  assert(/NOT RUN/.test(doc) && /\[M\]/.test(section(doc, '۵')), 'NOT RUN [M] section required');
  return 'adapters=' + a.join(',');
}

const setCell = (doc, provider, cap, idx, val) => doc.split('\n').map(l => {
  if (!l.startsWith('| ' + provider + ' | ' + cap + ' |')) return l;
  const c = l.split(' | '); c[idx] = val; return c.join(' | ');
}).join('\n');
const MUTANTS = [
  ['M1 [A] claim without a source', d => prSources(setCell(d, 'ArvanCloud', 'فهرست منابع', 4, '—'))],
  ['M2 RadCloud capability claimed without source', d => prSources(setCell(d, 'RadCloud', 'وضعیت و سلامت', 2, 'L2'))],
  ['M3 L3 without «ممنوع»', d => prL3(d.replace('`POST /v1/projects` و تغییر اندازه با `PATCH /v1/projects/{ref}/billing/addons`. **در پنل ممنوع است.**', '`POST /v1/projects`.'))],
  ['M4 invalid level word', d => prShape(setCell(d, 'Neon', 'Provisioning', 2, 'L4'))],
  ['M5 missing capability row', d => prShape(d.split('\n').filter(l => !l.startsWith('| Supabase | ظرفیت و مصرف |')).join('\n'))],
  ['M6 fabricated cost (number, no source)', d => prCost(d.replace('| ArvanCloud | سرور ابری | — | [?] |', '| ArvanCloud | سرور ابری | ۲٬۵۰۰٬۰۰۰ تومان | [E] |'))],
  ['M7 claims a real API call', d => prCode(d + '\nAPI آروان با موفقیت فراخوانی شد.\n')],
  ['M8 manual default removed while only manual exists', d => prCode(d.replace('آداپتور `manual` می‌ماند', 'آداپتور arvancloud پیش‌فرض است'), ['manual'])],
  ['M9 cost source path does not exist', d => prCost(d.replace('`docs/cloud/117-adr-staged-low-cost.md`', '`docs/cloud/117-missing.md`').replace('| RadCloud | هاست فعلی | از قبل پرداخت شده؛ مبلغ در مخزن نیست |', '| RadCloud | هاست فعلی | ۱ سال پرداخت‌شده |'))],
];

async function main(opts) {
  const quiet = !!(opts && opts.quiet);
  const doc = fs.readFileSync(path.join(ROOT, DOC), 'utf8');
  const out = []; let passed = 0; const failures = [];
  const run = (id, desc, fn) => { try { const d = fn(); passed++; out.push(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); } catch (e) { failures.push(id + ': ' + e.message); out.push(`FAIL  ${id}  ${desc}  → ${e.message}`); } };
  run('PR-01', 'capability table shape', () => prShape(doc));
  run('PR-02', 'claims need https sources; no source ⇒ L1 [?]', () => prSources(doc));
  run('PR-03', 'L3 is forbidden in the panel', () => prL3(doc));
  run('PR-04', 'costs only with source', () => prCost(doc));
  run('PR-05', 'consistent with code (manual adapter), no run claims', () => prCode(doc));
  let killed = 0;
  run('PR-06', 'mutants turn red', () => {
    for (const [name, fn] of MUTANTS) { let red = false; try { fn(doc); } catch (_) { red = true; } assert(red, 'mutant survived: ' + name); killed++; }
    return killed + '/' + MUTANTS.length + ' killed';
  });
  if (!quiet) out.forEach(l => console.log(l));
  const r = { passed, failed: failures.length, failures, negatives: killed };
  if (!quiet) console.log(`\nPROVIDER-RESEARCH-124 ${r.failed ? 'FAILED' : 'OK'} passed=${passed} failed=${r.failed} negative_controls=${killed}`);
  return r;
}
module.exports = { main };
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0));
