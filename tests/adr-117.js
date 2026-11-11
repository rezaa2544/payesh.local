#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 117 — staged low-cost ADR + constitution sync + ADR-105 (Parked).

     ADR-01  ADR-105 is on main, verbatim from claude/adr-direct-managed-db@a532393
             (sha256 of the body without the row-117 import note) and says Parked
     ADR-02  constitution clause 25 (data path only through the Gateway) is
             byte-identical to before (sha256 of the line)
     ADR-03  constitution 1.17 + D-48: Parked, PAYESH_TRANSPORT=direct, clause 25
             unchanged, ADR-117 linked; decision ids D-01..D-48 unique, no gaps, D-48 last
     ADR-04  ADR-117: stages A..D each with cost/capacity/gate; every € figure is [E];
             no [M] measured number; no "unlimited" claim; zero-cost stage A
     ADR-05  client/transport.js: Gateway is the default; only an explicit
             PAYESH_TRANSPORT=direct selects the direct path; typos fall back
     ADR-06  docs that cite ADR-105 now resolve; every relative link in ADR-117 exists
     ADR-07  mutants: each reverted control turns its check red
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const P = {
  adr105: 'docs/cloud/105-adr-direct-managed-db.md',
  adr117: 'docs/cloud/117-adr-staged-low-cost.md',
  con: 'docs/00-PAYESH-CLOUD-CONSTITUTION.md',
  transport: 'client/transport.js',
};
const ADR105_ORIG_SHA256 = '9b53e17570fad8287fc7b91bcb11d4f9f6b2379b5227d28d6011faadc60e4923'; // git show a532393:docs/cloud/105-adr-direct-managed-db.md
const CLAUSE25_SHA256 = '8363b19d67febf94d033de959456619ed0cdb7bebc23595789c6e96c496484c6'; // line "25. ..." on main@32461d1
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const assert = (c, m) => { if (!c) throw new Error(m); };

let passed = 0, failed = 0, negatives = 0, quiet = false;
const failures = [];
async function check(id, desc, fn) {
  try { const d = await fn(); passed++; if (!quiet) console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; failures.push(id); console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e)}`); }
}

function stripImportNote(text) {
  const lines = text.split('\n');
  const i = lines.findIndex(l => l.startsWith('> **یادداشت ورود به `main`'));
  if (i < 0) return { body: text, found: false };
  let j = i; while (j < lines.length && lines[j].startsWith('>')) j++;
  const start = lines[i - 1] === '' ? i - 1 : i;
  return { body: lines.slice(0, start).concat(lines.slice(j)).join('\n'), found: true };
}
function suiteAdr105(t) {
  const { body, found } = stripImportNote(t);
  assert(found, 'row-117 import note missing');
  assert(sha(body) === ADR105_ORIG_SHA256, 'ADR-105 body differs from a532393');
  const status = t.split('\n').find(l => l.startsWith('| وضعیت |')) || '';
  assert(/\*\*Parked/.test(status) && /PAYESH_TRANSPORT=direct/.test(status), 'status row must say Parked + PAYESH_TRANSPORT=direct');
  assert(/فعال‌سازی فقط با امضای مالک/.test(status), 'activation must require the owner signature');
}
function clause25(con) { return con.split('\n').find(l => l.startsWith('25. ')) || ''; }
function suiteClause25(con) { assert(sha(clause25(con)) === CLAUSE25_SHA256, 'clause 25 changed'); }
function suiteConstitution(con) {
  assert(/\| نسخهٔ سند \| \*\*۱٫۱۷\*\*/.test(con), 'version must be 1.17');
  assert(/\| بازنگری ۱٫۱۷ \|/.test(con), 'revision row 1.17 missing');
  const d48 = con.split('\n').find(l => l.startsWith('| **D‑48** |')) || '';
  assert(d48, 'D-48 missing');
  for (const k of ['Parked', 'PAYESH_TRANSPORT=direct', 'بند ۲۵ و D‑36 بی‌تغییر', '117-adr-staged-low-cost.md', 'تأیید کتبی', 'D‑09']) assert(d48.includes(k), 'D-48 missing: ' + k);
  const ids = [...con.matchAll(/^\| \*\*D‑(\d+)\*\* \|/gm)].map(m => Number(m[1]));
  assert(new Set(ids).size === ids.length, 'duplicate decision id');
  assert(ids[ids.length - 1] === 48 && Math.max(...ids) === 48, 'D-48 must be the newest (last, highest) decision');
  for (let n = 1; n <= 48; n++) assert(ids.includes(n), 'decision log gap at D-' + n);
  assert(/`docs\/cloud\/105-adr-direct-managed-db\.md` \| ADR‑105 [^|]*Parked/.test(con), 'appendix B must list ADR-105 as Parked');
}
function stageRows(t) {
  return t.split('\n').filter(l => /^\| \*\*[A-D] — /.test(l));
}
function gateRows(t) {
  const sec = t.split('## ۴.')[1] || '';
  return (sec.split('## ۵.')[0] || '').split('\n').filter(l => /^\| [A-D] \|/.test(l));
}
function suiteAdr117(t) {
  const st = stageRows(t);
  assert(st.length === 4 && ['A', 'B', 'C', 'D'].every((s, i) => st[i].startsWith('| **' + s + ' — ')), 'stage table A..D: got ' + st.length);
  for (const r of st) {
    const cells = r.split('|').slice(1, -1).map(c => c.trim());
    assert(cells.length === 6, 'stage row needs 6 cells');
    assert(/\[(A|E|\?)\]/.test(cells[4]), 'cost cell needs a label: ' + cells[0]);
    assert(/\[(M|S|\?)\]/.test(cells[5]), 'capacity cell needs a label: ' + cells[0]);
  }
  assert(/\*\*۰\*\*/.test(st[0].split('|')[5]), 'stage A must be zero added cost');
  const gr = gateRows(t);
  assert(gr.length === 4 && ['A', 'B', 'C', 'D'].every((s, i) => gr[i].startsWith('| ' + s + ' |')), 'gate table A..D: got ' + gr.length);
  for (const g of gr) { const c = g.split('|').slice(1, -1).map(x => x.trim()); assert(c.length === 3 && c[1].length > 20 && c[2].length > 20, 'gate cells must be filled: ' + c[0]); assert(/\[(M|S)\]/.test(c[1] + c[2]), 'gate needs evidence label: ' + c[0]); }
  for (const line of t.split('\n')) {
    for (const m of line.matchAll(/(\d[\d٫.,]*\s*(?:تا\s*[\d٫.,]+\s*)?€|€\s*\d|[۰-۹][۰-۹٫]*\s*(?:تا\s*[۰-۹٫]+\s*)?€)/g)) {
      const after = line.slice(m.index, m.index + 40);
      assert(/\[E\]/.test(after), '€ figure without [E]: ' + after);
    }
    assert(!/\[M\][^|\n]{0,40}(rps|ms\b|p95)\s*[≈=]?\s*[\d۰-۹]/.test(line), '[M] next to a number: ' + line.slice(0, 80));
  }
  const noProhib = t.split('\n').filter(l => !/ممنوع/.test(l)).join('\n');
  assert(!/(نامحدود|unlimited|infinite)/i.test(noProhib), 'unlimited claim outside a prohibition');
  for (const k of ['Parked', 'PAYESH_TRANSPORT=direct', 'بند ۲۵', 'D‑40', 'D‑09', 'UNKNOWN', 'Provider-agnostic']) assert(t.includes(k), 'ADR-117 missing ' + k);
}
function suiteTransport(tr) {
  const m = tr.transportMode;
  assert(m({}).mode === 'gateway' && m({}).valid === true, 'unset → gateway');
  assert(m({ PAYESH_TRANSPORT: '' }).mode === 'gateway', 'empty → gateway');
  assert(m({ PAYESH_TRANSPORT: 'gateway' }).mode === 'gateway', 'gateway → gateway');
  const typo = m({ PAYESH_TRANSPORT: 'drect' }); assert(typo.mode === 'gateway' && typo.valid === false, 'typo → gateway (invalid)');
  assert(m({ PAYESH_TRANSPORT: 'direct' }).mode === 'direct', 'explicit direct → direct');
  const t = tr.createTransport({ env: {}, api: async () => ({}) });
  assert(t.mode === 'gateway', 'createTransport default must be gateway');
  let threw = false; try { tr.createTransport({ env: { PAYESH_TRANSPORT: 'direct' }, api: async () => ({}) }); } catch (e) { threw = e.code === 'direct_not_configured'; }
  assert(threw, 'direct without a configured provider must refuse');
}
function suiteLinks(adr117) {
  for (const f of ['106-direct-identity-rls.md', '110-direct-transport.md', '111-backup-restore.md']) {
    const t = read('docs/cloud/' + f); assert(/ADR‑105|ADR-105|105-adr/.test(t), f + ' should cite ADR-105');
  }
  assert(fs.existsSync(path.join(ROOT, P.adr105)), 'ADR-105 file missing (dangling references)');
  const links = [...adr117.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)].map(m => m[1]).filter(h => !/^https?:/.test(h));
  for (const h of links) assert(fs.existsSync(path.join(ROOT, 'docs/cloud', h)), 'broken link ' + h);
  const refs = [...adr117.matchAll(/`((?:reports|tools|client|server)\/[^`]+)`/g)].map(m => m[1]);
  for (const r of refs) {
    const p1 = path.join(ROOT, 'docs/cloud', r), p2 = path.join(ROOT, r);
    assert(fs.existsSync(p1) || fs.existsSync(p2), 'missing referenced file ' + r);
  }
  return links.length + ' links, ' + refs.length + ' file refs';
}
function loadTransport(src) {
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', src)(mod, mod.exports, require);
  return mod.exports;
}

const MUTANTS = [
  ['M1 ADR-105 marked Accepted', () => suiteAdr105(read(P.adr105).replace('**Parked — مسیر جایگزین', '**Accepted — مسیر جایگزین'))],
  ['M2 ADR-105 body edited', () => suiteAdr105(read(P.adr105).replace('## ۸. وضعیت امنیت', '## ۸. امنیت'))],
  ['M3 clause 25 rewritten (direct allowed)', () => suiteClause25(read(P.con).replace('هیچ کلاینتی مستقیم به دیتابیس وصل نمی‌شود', 'کلاینت می‌تواند با RLS مستقیم وصل شود'))],
  ['M4 D-48 dropped', () => suiteConstitution(read(P.con).split('\n').filter(l => !l.startsWith('| **D‑48** |')).join('\n'))],
  ['M5 stage D gate removed', () => suiteAdr117(read(P.adr117).split('\n').filter(l => !l.startsWith('| D |')).join('\n'))],
  ['M6 € figure without [E]', () => suiteAdr117(read(P.adr117).replace('T3 حدود ۸۹ تا ۳۰۰ €/ماه [E]', 'T3 حدود ۸۹ تا ۳۰۰ €/ماه'))],
  ['M7 unlimited claim', () => suiteAdr117(read(P.adr117) + '\nاین معماری کاربر نامحدود را پشتیبانی می‌کند.\n')],
  ['M8 transport default flipped to direct', () => suiteTransport(loadTransport(read(P.transport).replace("const DEFAULT_MODE = 'gateway';", "const DEFAULT_MODE = 'direct';")))],
  ['M9 [M] number claimed in stage table', () => suiteAdr117(read(P.adr117).replace('rps ≈ ۶۲۳', '[M] rps ≈ ۶۲۳'))],
];

async function main(opts) {
  quiet = !!(opts && opts.quiet);
  passed = 0; failed = 0; negatives = 0; failures.length = 0;
  await check('ADR-01', 'ADR-105 on main verbatim from a532393 + Parked', () => suiteAdr105(read(P.adr105)));
  await check('ADR-02', 'constitution clause 25 unchanged', () => suiteClause25(read(P.con)));
  await check('ADR-03', 'constitution 1.17 + D-48 + decision ids', () => suiteConstitution(read(P.con)));
  await check('ADR-04', 'ADR-117 stages/gates/labels, no unlimited, € → [E]', () => suiteAdr117(read(P.adr117)));
  await check('ADR-05', 'transport: Gateway default, direct only explicit', () => suiteTransport(require(path.join(ROOT, P.transport))));
  await check('ADR-06', 'ADR-105 references resolve; ADR-117 links exist', () => suiteLinks(read(P.adr117)));
  await check('ADR-07', 'mutants: each reverted control turns red', () => {
    const missed = [];
    for (const [name, fn] of MUTANTS) { let red = false; try { fn(); } catch (_) { red = true; } if (red) negatives++; else missed.push(name); }
    if (missed.length) throw new Error('mutants survived: ' + missed.join('; '));
    return negatives + '/' + MUTANTS.length + ' killed';
  });
  return { passed, failed, negatives, failures: failures.slice() };
}
module.exports = { main };
if (require.main === module) {
  main().then(r => {
    console.log(`\nADR-117 ${r.failed ? 'FAILED' : 'OK'} passed=${r.passed} failed=${r.failed} negative_controls=${r.negatives}`);
    process.exit(r.failed ? 1 : 0);
  }, e => { console.error(e); process.exit(1); });
}
