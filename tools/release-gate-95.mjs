#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   Release gate — row 95 (native release)

   Aggregates every CI gate a native release depends on and prints ONE raw
   summary. Fail-closed: a release is blocked unless EVERY gate in
   docs/release/95-release-gate.json is "success" — failure, cancelled,
   skipped, a missing job or a missing sub-job result all block.

   Input (from .github/workflows/release-gate.yml, job "verdict"):
     NEEDS_JSON = ${{ toJSON(needs) }}
       { "<job>": { "result": "success", "outputs": { "results": "a=success,b=failure" } }, ... }
     The reusable native-client.yml exposes its inner job results through
     outputs.results, so sub-gates (gate-controls, android, windows, …) are
     checked one by one, not only the aggregate.

   Modes:
     --mode rehearsal  (pull_request / workflow_dispatch): CI gates only; the
                        owner's manual [M] checklist is reported PENDING and
                        nothing is published.
     --mode release    (tag native-v*): CI gates AND the owner's signed
                        checklist docs/release/signoff/<tag>.md — every [M]
                        item ticked, rc_sha given, and the only changes since
                        rc_sha under docs/release/ (the device-tested build is
                        byte-for-byte the product being tagged).

   Usage:
     node tools/release-gate-95.mjs [--needs FILE] [--mode rehearsal|release]
       [--tag native-vX.Y.Z] [--sha SHA] [--root DIR] [--config FILE]
       [--out summary.txt] [--json summary.json]
   Exit 0 + RELEASE-GATE-OK | exit 1 + RELEASE-GATE-BLOCKED (reasons listed).
   ═══════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function parseSubResults(s) {
  const out = {};
  for (const part of String(s || '').split(/[,\s]+/)) {
    const m = /^([A-Za-z0-9_.-]+)=([a-z_]+)$/.exec(part);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/* Owner checklist items: lines like "- [ ] **M1** [M] …" */
export function checklistItems(text) {
  const ids = [];
  for (const m of String(text).matchAll(/^- \[ \] \*\*(M\d+)\*\* \[M\]/gm)) ids.push(m[1]);
  return ids;
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function checkSignoff({ root, config, tag }) {
  const problems = [];
  const items = (() => {
    try { return checklistItems(fs.readFileSync(path.join(root, config.owner_checklist), 'utf8')); } catch (e) { problems.push(`owner checklist ${config.owner_checklist} unreadable (${e.code || e.message})`); return []; }
  })();
  if (!items.length && !problems.length) problems.push(`owner checklist ${config.owner_checklist} lists no [M] items`);
  if (!tag || !String(tag).startsWith(config.tag_prefix)) { problems.push(`release tag "${tag || ''}" does not start with ${config.tag_prefix}`); return { problems, items, file: null }; }
  const file = path.posix.join(config.signoff_dir, `${tag}.md`);
  let text;
  try { text = fs.readFileSync(path.join(root, file), 'utf8'); } catch (e) { problems.push(`signoff ${file} missing — the owner has not run the manual checklist for ${tag}`); return { problems, items, file }; }
  const field = k => { const m = new RegExp(`^${k}:[ \\t]*(.*)$`, 'mi').exec(text); return m ? m[1].trim() : ''; };
  if (field('tag') !== tag) problems.push(`signoff tag: "${field('tag')}" ≠ ${tag}`);
  if (!field('owner')) problems.push('signoff owner: empty');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(field('date'))) problems.push(`signoff date: "${field('date')}" is not YYYY-MM-DD`);
  if (field('result') !== 'PASS') problems.push(`signoff result: "${field('result')}" (must be PASS)`);
  for (const id of items) {
    if (!new RegExp(`^- \\[[xX]\\] \\*\\*${id}\\*\\*`, 'm').test(text)) problems.push(`signoff item ${id} not ticked`);
  }
  if (/^- \[ \] /m.test(text)) problems.push('signoff has unticked boxes');
  const rc = field('rc_sha');
  if (!/^[0-9a-f]{40}$/.test(rc)) { problems.push(`signoff rc_sha: "${rc}" is not a full commit sha`); return { problems, items, file }; }
  try {
    try { git(root, ['merge-base', '--is-ancestor', rc, 'HEAD']); } catch (e) { problems.push(`rc_sha ${rc.slice(0, 12)} is not an ancestor of HEAD`); return { problems, items, file }; }
    const changed = git(root, ['diff', '--name-only', rc, 'HEAD']).split('\n').filter(Boolean);
    const allowed = config.signoff_allowed_diff || [];
    const outside = changed.filter(f => !allowed.some(a => f.startsWith(a)));
    if (outside.length) problems.push(`product changed after the device-tested build ${rc.slice(0, 12)}: ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ` (+${outside.length - 5})` : ''}`);
  } catch (e) { problems.push(`git check failed: ${e.message.split('\n')[0]}`); }
  return { problems, items, file };
}

export function evaluate({ config, needs, mode = 'rehearsal', tag = '', sha = '', root = process.cwd(), now = new Date() }) {
  const lines = [];
  const blocked = [];
  const gates = [];
  const n = needs && typeof needs === 'object' ? needs : {};
  if (!config || !Array.isArray(config.gates) || !config.gates.length) blocked.push('config lists no gates');
  for (const g of (config && config.gates) || []) {
    const src = [];
    let ok = Array.isArray(g.jobs) && g.jobs.length > 0;
    if (!ok) src.push('no jobs configured');
    for (const j of g.jobs || []) {
      const r = n[j] && typeof n[j].result === 'string' ? n[j].result : 'missing';
      src.push(`${j}=${r}`);
      if (r !== 'success') ok = false;
      const subs = (g.sub && g.sub[j]) || [];
      if (subs.length) {
        const got = parseSubResults(n[j] && n[j].outputs && n[j].outputs.results);
        for (const s of subs) {
          const sr = got[s] || 'missing';
          src.push(`${j}/${s}=${sr}`);
          if (sr !== 'success') ok = false;
        }
      }
    }
    gates.push({ id: g.id, ok, sources: src });
    lines.push(`GATE ${g.id.padEnd(18)} ${ok ? 'PASS ' : 'BLOCK'}  ${src.join(' ')}  — ${g.title}`);
    if (!ok) blocked.push(`${g.id}: ${src.filter(x => !x.endsWith('=success')).join(' ')}`);
  }
  let manual;
  if (mode === 'release') {
    const s = checkSignoff({ root, config, tag });
    manual = { state: s.problems.length ? 'BLOCK' : 'PASS', file: s.file, items: s.items, problems: s.problems };
    lines.push(`MANUAL ${'[M] owner'.padEnd(18)} ${manual.state === 'PASS' ? 'PASS ' : 'BLOCK'}  ${s.file || '-'} items=${s.items.join(',') || 'none'}`);
    for (const p of s.problems) { lines.push(`  · ${p}`); blocked.push(`MANUAL: ${p}`); }
  } else if (mode === 'rehearsal') {
    let items = [];
    try { items = checklistItems(fs.readFileSync(path.join(root, config.owner_checklist), 'utf8')); } catch (e) { /* reported below */ }
    manual = { state: 'PENDING', items };
    lines.push(`MANUAL ${'[M] owner'.padEnd(18)} PENDING ${config.owner_checklist} items=${items.join(',') || 'none'} (rehearsal: not published; a ${config.tag_prefix}* tag needs ${config.signoff_dir}/<tag>.md)`);
    if (!items.length) blocked.push(`MANUAL: owner checklist ${config.owner_checklist} missing or lists no [M] items`);
  } else {
    blocked.push(`unknown mode "${mode}"`);
  }
  const passN = gates.filter(g => g.ok).length;
  const head = [
    '# release gate (row 95) — raw summary',
    `sha=${sha || 'unknown'}`,
    `mode=${mode}${tag ? ' tag=' + tag : ''}`,
    `date_utc=${now.toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
    `config=docs/release/95-release-gate.json gates=${gates.length}`,
    '',
  ];
  const tail = blocked.length
    ? ['', `RELEASE-GATE-BLOCKED gates_pass=${passN}/${gates.length} reasons=${blocked.length}`, ...blocked.map(b => `  ✗ ${b}`)]
    : ['', `RELEASE-GATE-OK gates_pass=${passN}/${gates.length} manual=${manual.state}${mode === 'rehearsal' ? ' (rehearsal — publish disabled)' : ' — publish allowed'}`];
  return { ok: blocked.length === 0, text: [...head, ...lines, ...tail].join('\n') + '\n', gates, manual, blocked };
}

function main(argv) {
  const a = { mode: 'rehearsal', root: process.cwd(), config: 'docs/release/95-release-gate.json' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) a[k.slice(2)] = argv[++i];
  }
  let config, needs;
  try { config = JSON.parse(fs.readFileSync(path.resolve(a.root, a.config), 'utf8')); } catch (e) { console.log(`RELEASE-GATE-BLOCKED config unreadable: ${e.message}`); return 1; }
  try {
    const raw = a.needs ? fs.readFileSync(a.needs === '-' ? 0 : a.needs, 'utf8') : process.env.NEEDS_JSON;
    needs = JSON.parse(raw || 'null');
  } catch (e) { needs = null; }
  const r = evaluate({ config, needs, mode: a.mode, tag: a.tag || '', sha: a.sha || process.env.GITHUB_SHA || '', root: path.resolve(a.root) });
  process.stdout.write(r.text);
  if (a.out) fs.writeFileSync(a.out, r.text);
  if (a.json) fs.writeFileSync(a.json, JSON.stringify({ ok: r.ok, gates: r.gates, manual: r.manual, blocked: r.blocked }, null, 2) + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + r.text + '```\n'); } catch (e) { /* not fatal */ } }
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
