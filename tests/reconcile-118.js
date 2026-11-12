#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 118 — reconciliation of Notion "Done" against repository truth.

     RC-01  table shape: every row has 10 cells, unique ids R01.., status from the
            allowed set (PASS / PARTIAL / BLOCKED / NOT IMPLEMENTED / UNKNOWN / NOT RUN)
     RC-02  every backticked repo path in path/test/evidence cells exists
     RC-03  PASS/PARTIAL rows carry a label ([S]/[M]) and an existing test;
            BLOCKED / NOT IMPLEMENTED / NOT RUN rows state a gap and a next step
     RC-04  [M] only with evidence that itself says [M]; no "unlimited" capacity claim
     RC-05  security row is UNKNOWN (D-41) — never PASS without a human pentest
     RC-06  truth checks against the repo: the status of R07 (Gateway host deploy),
            R08 (provider layer / infra migration / SPA page / real adapter), R09 (create school → tenant + SPA form),
            R10 (native polling) and R23 (native feature pages) must match what the
            code actually contains — a stale report turns red
     RC-07  mutants: each forbidden edit turns its check red
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DOC = 'docs/cloud/118-reconciliation.md';
const STATUSES = ['PASS', 'PARTIAL', 'BLOCKED', 'NOT IMPLEMENTED', 'UNKNOWN', 'NOT RUN'];
const assert = (c, m) => { if (!c) throw new Error(m); };
const exists = p => fs.existsSync(path.join(ROOT, p));

let passed = 0, failed = 0, negatives = 0, quiet = false;
const failures = [];
async function check(id, desc, fn) {
  try { const d = await fn(); passed++; if (!quiet) console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; failures.push(id); console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e)}`); }
}

function parse(doc) {
  const a = doc.indexOf('<!-- RECONCILIATION-TABLE:BEGIN -->'), b = doc.indexOf('<!-- RECONCILIATION-TABLE:END -->');
  assert(a >= 0 && b > a, 'table markers missing');
  const lines = doc.slice(a, b).split('\n').filter(l => /^\| R\d\d \|/.test(l));
  return lines.map(l => {
    const c = l.split(' | ').map(x => x.replace(/^\|\s*/, '').replace(/\s*\|$/, '').trim());
    return { raw: l, cells: c, id: c[0], need: c[1], status: c[2], notion: c[3], path: c[4], test: c[5], evidence: c[6], gap: c[7], risk: c[8], next: c[9] };
  });
}
const baseStatus = s => STATUSES.find(x => s === x || s.startsWith(x + ' ')) || null;
const ticks = s => [...String(s).matchAll(/`([^`]+)`/g)].map(m => m[1]).filter(p => /\//.test(p) && !/[=\s]/.test(p));

function rcShape(rows) {
  assert(rows.length >= 20, 'too few rows: ' + rows.length);
  const ids = new Set();
  for (const r of rows) {
    assert(r.cells.length === 10, r.id + ': expected 10 cells, got ' + r.cells.length);
    assert(!ids.has(r.id), 'duplicate id ' + r.id); ids.add(r.id);
    assert(baseStatus(r.status), r.id + ': invalid status "' + r.status + '"');
  }
  return rows.length + ' rows';
}
function rcPaths(rows) {
  let n = 0;
  for (const r of rows) for (const cell of [r.path, r.test, r.evidence]) for (const p of ticks(cell)) { assert(exists(p), r.id + ': missing ' + p); n++; }
  return n + ' paths';
}
function rcRules(rows) {
  for (const r of rows) {
    const s = baseStatus(r.status);
    if (s === 'PASS' || s === 'PARTIAL') {
      assert(/\[(S|M)\]/.test(r.status), r.id + ': PASS/PARTIAL needs [S] or [M]');
      const t = ticks(r.test); assert(t.length && t.every(exists), r.id + ': PASS/PARTIAL needs an existing test');
    }
    if (s === 'BLOCKED' || s === 'NOT IMPLEMENTED' || s === 'NOT RUN') {
      assert(r.gap && r.gap !== '—', r.id + ': gap required');
      assert(r.next && r.next !== '—', r.id + ': next step required');
    }
  }
}
function rcLabels(rows, doc) {
  for (const r of rows) {
    if (/\[M\]/.test(r.status)) {
      const ev = ticks(r.evidence); assert(ev.length && ev.every(p => exists(p) && /\[M\]/.test(fs.readFileSync(path.join(ROOT, p), 'utf8'))), r.id + ': [M] without [M] evidence');
    }
  }
  const noProhib = doc.split('\n').filter(l => !/ممنوع|مجاز نیست|forbidden/i.test(l)).join('\n');
  assert(!/(نامحدود|unlimited)/i.test(noProhib), 'unlimited claim');
}
function rcSecurity(rows) {
  const sec = rows.find(r => /^امنیت$/.test(r.need));
  assert(sec, 'security row missing');
  assert(baseStatus(sec.status) === 'UNKNOWN', 'security must be UNKNOWN until a human pentest (D-41)');
}

/* ── repo truth probes (each returns true when the feature is present) ── */
const TRUTH = {
  gatewayHostDeploy: () => fs.readdirSync(path.join(ROOT, 'deploy')).some(f => /gateway/i.test(f)) || /server\/gateway\.js/.test(fs.readFileSync(path.join(ROOT, 'deploy/README.md'), 'utf8')),
  // provider layer = an infra-registry migration (row 122); 005 went to tenant provisioning (row 121)
  providerLayer: () => fs.readdirSync(path.join(ROOT, 'db/migrations/owner-panel')).some(f => /^\d{3}_infra_.*\.up\.sql$/.test(f)),
  createSchool: () => /method:\s*'POST',\s*path:\s*'\/tenants'\s*,/.test(fs.readFileSync(path.join(ROOT, 'apps/owner-panel/server/platform-api.js'), 'utf8')),
  // row 123: the owner SPA has an «زیرساخت» page and a «ساخت مدرسه» form
  infraUi: () => /id:\s*'infra'/.test(fs.readFileSync(path.join(ROOT, 'apps/owner-panel/web/app.js'), 'utf8')),
  createSchoolUi: () => /api\('POST',\s*'\/tenants'/.test(fs.readFileSync(path.join(ROOT, 'apps/owner-panel/web/app.js'), 'utf8')),
  // a real provider adapter (row 124) = any ADAPTERS key other than `manual`
  providerApi: () => { const m = /const ADAPTERS = \{([^}]*)\}/.exec(fs.readFileSync(path.join(ROOT, 'apps/owner-panel/server/infra.js'), 'utf8')); return !!m && m[1].split(',').map(x => x.split(':')[0].trim()).some(k => k && k !== 'manual'); },
  nativePolling: () => { const d = path.join(ROOT, 'apps/payesh/packages/payesh_sync/lib/src'); return fs.readdirSync(d).some(f => /poll/i.test(fs.readFileSync(path.join(d, f), 'utf8'))); },
  nativePages: () => { const out = []; (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else out.push(p); } })(path.join(ROOT, 'apps/payesh/app/lib')); const waves = new Set(); for (const p of out) { const m = /(attendance|grades|notices|login|parents)/i.exec(path.relative(ROOT, p)); if (m) waves.add(m[1].toLowerCase()); } return waves.size; },
};
function rcTruth(rows, truth) {
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  const st = id => { assert(by[id], id + ' missing'); return baseStatus(by[id].status); };
  const t = truth || TRUTH;
  if (!t.gatewayHostDeploy()) assert(['BLOCKED', 'NOT IMPLEMENTED'].includes(st('R07')), 'R07: no Gateway deploy package in deploy/ yet status=' + st('R07'));
  else assert(st('R07') !== 'NOT IMPLEMENTED', 'R07: Gateway deploy exists — update the report');
  if (!t.providerLayer()) assert(st('R08') === 'NOT IMPLEMENTED', 'R08: no infra migration yet status=' + st('R08'));
  else assert(st('R08') !== 'NOT IMPLEMENTED', 'R08: infra migration exists — update the report');
  if (!t.createSchool()) assert(st('R09') === 'NOT IMPLEMENTED', 'R09: no POST /tenants yet status=' + st('R09'));
  else assert(st('R09') !== 'NOT IMPLEMENTED', 'R09: POST /tenants exists — update the report');
  if (st('R09') === 'PASS') assert(t.createSchool() && t.createSchoolUi(), 'R09: PASS needs both POST /tenants and the SPA form');
  if (st('R08') === 'PASS') assert(t.providerLayer() && t.infraUi() && t.providerApi(), 'R08: PASS needs migration, SPA page and a real provider adapter (row 124)');
  if (!t.nativePolling()) assert(['PARTIAL', 'NOT IMPLEMENTED'].includes(st('R10')), 'R10: native client has no polling yet status=' + st('R10'));
  /* row 74: number of native waves present (0..5) — partial migration may only be PARTIAL */
  const waves = Number(t.nativePages());
  if (!waves) assert(st('R23') === 'NOT IMPLEMENTED', 'R23: no native feature pages yet status=' + st('R23'));
  else if (waves < 5) assert(st('R23') === 'PARTIAL', 'R23: ' + waves + '/5 native waves — must be PARTIAL status=' + st('R23'));
  else assert(st('R23') !== 'NOT IMPLEMENTED', 'R23: native pages exist — update the report');
  return Object.entries(t).map(([k, f]) => k + '=' + f()).join(' ');
}

const setStatus = (doc, id, s) => doc.split('\n').map(l => {
  if (!l.startsWith('| ' + id + ' |')) return l;
  const c = l.split(' | '); c[2] = s; return c.join(' | ');
}).join('\n');
const MUTANTS = [
  // M1: with POST /tenants present (row 121) a report that still says NOT IMPLEMENTED must go red;
  // with it absent, a PASS claim must go red.
  ['M1 create-school status disagrees with code', d => rcTruth(parse(setStatus(d, 'R09', TRUTH.createSchool() ? 'NOT IMPLEMENTED' : 'PASS [S]')))],
  ['M2 security claimed PASS', d => rcSecurity(parse(setStatus(d, 'R15', 'PASS [S]')))],
  ['M3 native pages claimed PASS', d => rcTruth(parse(setStatus(d, 'R23', 'PASS [S]')))],
  // M13 (row 74): report must follow the native waves both ways (present → not NOT IMPLEMENTED; absent → NOT IMPLEMENTED)
  ['M13 native pages status disagrees with code', d => TRUTH.nativePages() ? rcTruth(parse(setStatus(d, 'R23', 'NOT IMPLEMENTED'))) : rcTruth(parse(d), Object.assign({}, TRUTH, { nativePages: () => 1 }))],
  ['M4 evidence path that does not exist', d => rcPaths(parse(d.replace('`docs/cloud/reports/evidence/gateway-67.txt`', '`docs/cloud/reports/evidence/gateway-67-missing.txt`')))],
  ['M5 PASS without a test', d => rcRules(parse(d.split('\n').map(l => l.startsWith('| R13 |') ? l.replace('`tests/convergence-fuzz-83.js`', '—') : l).join('\n')))],
  ['M6 invalid status word', d => rcShape(parse(setStatus(d, 'R02', 'DONE')))],
  ['M7 [M] without [M] evidence', d => rcLabels(parse(setStatus(d, 'R04', 'PASS [M]')), d)],
  ['M8 unlimited claim', d => rcLabels(parse(d), d + '\nاین سامانه کاربر نامحدود را پشتیبانی می‌کند.\n')],
  ['M9 blocked row without next step', d => rcRules(parse(d.split('\n').map(l => { if (!l.startsWith('| R07 |')) return l; const c = l.split(' | '); c[9] = '— |'; return c.join(' | '); }).join('\n')))],
  // M11/M12 (row 123): PASS claims must be backed by UI and (for R08) a real provider adapter
  ['M11 create-school PASS without the SPA form', d => rcTruth(parse(setStatus(d, 'R09', 'PASS [S]')), Object.assign({}, TRUTH, { createSchoolUi: () => false }))],
  ['M12 control plane PASS while only the manual adapter exists', d => rcTruth(parse(setStatus(d, 'R08', 'PASS [S]')), Object.assign({}, TRUTH, { providerApi: () => false }))],
  // M10: report must track the infra migration both ways (absent → NOT IMPLEMENTED; present → anything else)
  ['M10 provider layer status disagrees with code', d => TRUTH.providerLayer() ? rcTruth(parse(setStatus(d, 'R08', 'NOT IMPLEMENTED'))) : rcTruth(parse(d), Object.assign({}, TRUTH, { providerLayer: () => true }))],
];

async function main(opts) {
  quiet = !!(opts && opts.quiet);
  passed = 0; failed = 0; negatives = 0; failures.length = 0;
  const doc = fs.readFileSync(path.join(ROOT, DOC), 'utf8');
  let rows = [];
  await check('RC-01', 'table shape, unique ids, allowed statuses', () => { rows = parse(doc); return rcShape(rows); });
  await check('RC-02', 'every cited path exists', () => rcPaths(rows));
  await check('RC-03', 'PASS/PARTIAL have label+test; open rows have gap+next', () => rcRules(rows));
  await check('RC-04', '[M] only with [M] evidence; no unlimited claim', () => rcLabels(rows, doc));
  await check('RC-05', 'security is UNKNOWN (D-41)', () => rcSecurity(rows));
  await check('RC-06', 'truth checks vs repository (R07/R08/R09/R10/R23)', () => rcTruth(rows));
  await check('RC-07', 'mutants: each forbidden edit turns red', () => {
    const missed = [];
    for (const [name, fn] of MUTANTS) { let red = false; try { fn(doc); } catch (_) { red = true; } if (red) negatives++; else missed.push(name); }
    if (missed.length) throw new Error('mutants survived: ' + missed.join('; '));
    return negatives + '/' + MUTANTS.length + ' killed';
  });
  return { passed, failed, negatives, failures: failures.slice() };
}
module.exports = { main, parse, TRUTH };
if (require.main === module) {
  main().then(r => {
    console.log(`\nRECONCILE-118 ${r.failed ? 'FAILED' : 'OK'} passed=${r.passed} failed=${r.failed} negative_controls=${r.negatives}`);
    process.exit(r.failed ? 1 : 0);
  }, e => { console.error(e); process.exit(1); });
}
