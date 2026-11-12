#!/usr/bin/env node
// Row 128 — capability parity between the web school client and the native Flutter app.
//
// The web client's surface is extracted MECHANICALLY from its sources (pages, click actions,
// forms, nav routes) so a new web feature can never slip past the matrix. Every extracted item
// must be mapped in docs/cloud/128-parity-matrix.json to exactly one of:
//   native   — a native screen/control exists (file anchor) AND a test exists (test anchor);
//   planned  — a row-128 wave (W6..W12) will build it (only allowed until the row closes);
//   retired  — removed on purpose: reason_fa AND replacement are mandatory (row 128: no needed
//              capability is removed without a replacement);
//   ui       — pure web mechanics, no capability (closing a modal, a nav link): reason_fa.
//
//   P-01 every extracted web item is in the matrix          P-05 every test anchor exists
//   P-02 no matrix item without a web source (stale)          P-06 retired: reason + replacement
//   P-03 status/fields valid, no duplicate ids                P-07 planned: wave declared
//   P-04 every native anchor exists in its file               P-08 --final: nothing planned
//
// Usage: node tools/parity-128.mjs [--final] [--json]
// Last line: PARITY-128-OK items=N native=N planned=N retired=N ui=N [final]  |  PARITY-128-FAILED failures=N
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MATRIX = 'docs/cloud/128-parity-matrix.json';
export const CLIENT = ['client/pages.js', 'client/app.js', 'client/schedule.js', 'client/import.js', 'client/diag.js', 'client/scan.js'];
const STATUSES = new Set(['native', 'planned', 'retired', 'ui']);

/** Web client surface: `kind:name` ids. `read(path)` returns the file text. */
export function extract(read) {
  const out = new Set();
  const pages = read('client/pages.js');
  const app = read('client/app.js');
  const sched = read('client/schedule.js');
  for (const m of pages.matchAll(/^PAGES(?:\.([a-z]+)|\['([a-z-]+)'\]) *=/gm)) out.add('page:' + (m[1] || m[2]));
  // nav routes (navConfig) — a route can be served outside PAGES (health → diag.js)
  const nav = pages.slice(pages.indexOf('function navConfig'), pages.indexOf('function updateBarHtml'));
  for (const m of nav.matchAll(/\['([a-z-]+)', '[^']*', '[^']*'\]/g)) out.add('page:' + m[1]);
  // routes handled directly by app.js (scan page before sign-in)
  for (const m of app.matchAll(/S\.route === '([a-z-]+)' && typeof window\.render[A-Z]/g)) out.add('page:' + m[1]);
  const s = app.indexOf("case 'modal-close'");
  const e = app.indexOf('async function handleSubmit');
  if (s < 0 || e < 0) throw new Error('app.js anchors moved: click switch / handleSubmit');
  for (const m of app.slice(s, e).matchAll(/case '([a-z0-9_-]+)':/g)) out.add('act:' + m[1]);
  for (const m of app.slice(e).matchAll(/kind === '([a-z0-9_-]+)'/g)) out.add('form:' + m[1]);
  const sa = sched.slice(sched.indexOf('const SCHED_ACTIONS'), sched.indexOf('const SCHED_FORMS'));
  for (const m of sa.matchAll(/^ {2}'([a-z-]+)':/gm)) out.add('act:' + m[1]);
  const sf = sched.slice(sched.indexOf('const SCHED_FORMS'), sched.indexOf('window.SCHED_ACTIONS'));
  for (const m of sf.matchAll(/^ {2}'?([a-z-]+)'?:/gm)) out.add('form:' + m[1]);
  for (const f of CLIENT) {
    const t = read(f);
    for (const m of t.matchAll(/data-act="([a-z0-9_-]+)"/g)) out.add('act:' + m[1]);
    for (const m of t.matchAll(/data-form="([a-z0-9_-]+)"/g)) out.add('form:' + m[1]);
  }
  return out;
}

export function check(matrix, read, exists, opts = {}) {
  const failures = [];
  const fail = (code, msg) => failures.push(`${code} ${msg}`);
  const web = extract(read);
  const ids = new Map();
  for (const it of matrix.items || []) {
    if (ids.has(it.id)) fail('P-03', `duplicate id ${it.id}`);
    ids.set(it.id, it);
  }
  for (const id of [...web].sort()) if (!ids.has(id)) fail('P-01', `web item not in the matrix: ${id}`);
  for (const id of [...ids.keys()].sort()) if (!web.has(id)) fail('P-02', `matrix item has no web source (stale): ${id}`);
  const waves = matrix.waves || {};
  const fileCache = new Map();
  const has = (f, needle) => {
    if (!fileCache.has(f)) fileCache.set(f, exists(f) ? read(f) : null);
    const t = fileCache.get(f);
    return t != null && t.includes(needle);
  };
  const count = { native: 0, planned: 0, retired: 0, ui: 0 };
  for (const it of ids.values()) {
    if (!STATUSES.has(it.status)) { fail('P-03', `${it.id}: unknown status ${it.status}`); continue; }
    count[it.status]++;
    if (it.status === 'native') {
      if (!Array.isArray(it.native) || !it.native.length) fail('P-04', `${it.id}: native without a native anchor`);
      for (const a of it.native || []) if (!has(a.file, a.has)) fail('P-04', `${it.id}: ${a.file} lacks «${a.has}»`);
      if (!Array.isArray(it.tests) || !it.tests.length) fail('P-05', `${it.id}: native without a test`);
      for (const a of it.tests || []) if (!has(a.file, a.has)) fail('P-05', `${it.id}: test ${a.file} lacks «${a.has}»`);
    }
    if (it.status === 'retired') {
      if (!String(it.reason_fa || '').trim()) fail('P-06', `${it.id}: retired without reason_fa`);
      if (!String(it.replacement || '').trim()) fail('P-06', `${it.id}: retired without a replacement`);
    }
    if (it.status === 'ui' && !String(it.reason_fa || '').trim()) fail('P-03', `${it.id}: ui without reason_fa`);
    if (it.status === 'planned') {
      if (!it.wave || !waves[it.wave]) fail('P-07', `${it.id}: planned without a declared wave`);
      if (opts.final) fail('P-08', `${it.id}: still planned (${it.wave}) — row 128 cannot close`);
    }
  }
  return { failures, count, web: web.size, items: ids.size };
}

export function loadRepo(root) {
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const exists = (p) => fs.existsSync(path.join(root, p));
  return { read, exists };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const final = process.argv.includes('--final');
  const { read, exists } = loadRepo(root);
  const matrix = JSON.parse(read(MATRIX));
  const r = check(matrix, read, exists, { final });
  const c = r.count;
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 1));
  const byWave = {};
  for (const it of matrix.items) if (it.status === 'planned') byWave[it.wave] = (byWave[it.wave] || 0) + 1;
  console.log('planned by wave: ' + (Object.keys(byWave).sort().map((w) => `${w}=${byWave[w]}`).join(' ') || 'none'));
  for (const f of r.failures) console.log('FAIL ' + f);
  console.log(r.failures.length
    ? `PARITY-128-FAILED failures=${r.failures.length}`
    : `PARITY-128-OK items=${r.items} native=${c.native} planned=${c.planned} retired=${c.retired} ui=${c.ui}${final ? ' final' : ''}`);
  process.exit(r.failures.length ? 1 : 0);
}
