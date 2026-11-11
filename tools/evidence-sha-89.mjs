#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۸۹ — هر شاهد یک SHA پایهٔ قابل‌اثبات دارد

   «شاهد» = هر فایل ردیابی‌شده در docs/cloud/reports/evidence/ به‌جز کدِ
   مولد (‎.sh/.cjs/.mjs/.js/.py‎). قاعده‌ها:
     • ‎.txt‎  ⇒ سرآیند base_sha=<40 hex> و date_utc= در ۸ خط اول (همان قالب
                check-evidence-base.cjs).
     • ‎.log‎  ⇒ یک SHA کامل ۴۰ رقمی در ۲۵ خط اول (commit_sha در METADATA).
     • بقیه (md/json/jsonl/…) ⇒ base_sha= در ۲۵ خط اول، یا یک ردیف در
                EVIDENCE-SHA-INDEX.tsv (برای فایل‌های تاریخی).
     • هر SHA باید در همین مخزن یک commit باشد؛ وگرنه باید در sha-map.json
       به یک SHA «تازه» نگاشت شده باشد که commit است و نیای HEAD است.

   حالت‌ها:
     --check     دروازهٔ CI (پیش‌فرض). خروج ≠ ۰ ⇒ شاهدی بدون SHA معتبر.
     --backfill  به ‎.txt‎های بدون سرآیند، سرآیندِ «commit افزودن فایل» را
                 اضافه می‌کند (بدنه دست نمی‌خورد؛ provenance صریح است).
     --index     EVIDENCE-SHA-INDEX.tsv و sha-map.json را از تاریخچهٔ git می‌سازد.
     --root <dir>  ریشهٔ مخزن (برای آزمون‌های منفی روی مخزن موقت).
   ═══════════════════════════════════════════════════════════════════ */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const EV_DIR = 'docs/cloud/reports/evidence';
const INDEX = `${EV_DIR}/EVIDENCE-SHA-INDEX.tsv`;
const MAP = `${EV_DIR}/sha-map.json`;
const CODE_EXT = new Set(['.sh', '.cjs', '.mjs', '.js', '.py']);
const SELF = new Set([INDEX, MAP]);
const SHA40 = /\b[0-9a-f]{40}\b/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function git(root, args, opts = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20, ...opts });
}
function isCommit(root, sha) {
  try { git(root, ['cat-file', '-e', `${sha}^{commit}`]); return true; } catch (e) { return false; }
}
function isAncestor(root, sha) {
  try { git(root, ['merge-base', '--is-ancestor', sha, 'HEAD']); return true; } catch (e) { return false; }
}
function headerErrors(text) {
  const { inspectStrictText } = require(path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'check-evidence-base.cjs'));
  return inspectStrictText(text).errors;
}

export function listEvidence(root) {
  return git(root, ['ls-files', '-z', '--', EV_DIR]).split('\0').filter(Boolean)
    .filter(f => !CODE_EXT.has(path.extname(f)) && !SELF.has(f)).sort();
}

/* SHA جاسازی‌شده در خودِ فایل (یا null) */
export function embeddedSha(root, file) {
  let text;
  try { text = fs.readFileSync(path.join(root, file), 'utf8'); } catch (e) { return null; }
  const lines = text.split(/\r?\n/);
  const ext = path.extname(file);
  if (ext === '.txt') {
    const l = lines.slice(0, 8).map(s => s.trim()).find(s => s.startsWith('base_sha='));
    const v = l ? l.slice(9) : '';
    return /^[0-9a-f]{40}$/.test(v) ? v : null;
  }
  const head = lines.slice(0, 25).join('\n');
  if (ext === '.log') { const m = head.match(SHA40); return m ? m[0] : null; }
  const m = head.match(/base_sha["'`*:= ]+([0-9a-f]{40})\b/);
  return m ? m[1] : null;
}

function firstAdd(root, file) {
  const out = git(root, ['log', '--diff-filter=A', '--format=%H %cI', '--', file]).trim().split('\n').filter(Boolean);
  if (!out.length) return null;
  const [sha, iso] = out[out.length - 1].split(' ');
  return { sha, date: new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

function readIndex(root) {
  const p = path.join(root, INDEX);
  const rows = new Map();
  if (!fs.existsSync(p)) return rows;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [file, sha, date, source] = line.split('\t');
    rows.set(file, { sha, date, source });
  }
  return rows;
}
function readMap(root) {
  const p = path.join(root, MAP);
  if (!fs.existsSync(p)) return { entries: [] };
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/* ── backfill ── */
export function backfill(root) {
  let changed = 0;
  for (const file of listEvidence(root).filter(f => f.endsWith('.txt'))) {
    const abs = path.join(root, file);
    const text = fs.readFileSync(abs, 'utf8');
    if (!headerErrors(text).length) continue;
    const fa = firstAdd(root, file);
    if (!fa) continue;                                  /* هنوز commit نشده: کار نویسندهٔ همان PR است */
    /* بایت‌به‌بایت (latin1): بعضی شواهد قدیمی UTF-8 بریده دارند؛ بدنه نباید حتی یک بایت عوض شود */
    const lines = fs.readFileSync(abs).toString('latin1').split('\n');
    for (let i = 0; i < Math.min(8, lines.length); i++) {
      /* سرآیند ناقص/نادرستِ قدیمی حفظ می‌شود، اما با نام orig_ تا «دقیقاً یکی» بماند */
      lines[i] = lines[i].replace(/^(\s*)(base_sha|date_utc)=/, '$1orig_$2=');
    }
    const head = [
      `base_sha=${fa.sha}`,
      `date_utc=${fa.date}`,
      'provenance=backfill-89: base_sha/date_utc = the commit that first added this file (the original run SHA was not recorded); the body below is unchanged',
    ];
    fs.writeFileSync(abs, Buffer.concat([Buffer.from(head.join('\n') + '\n', 'utf8'), Buffer.from(lines.join('\n'), 'latin1')]));
    changed++;
  }
  return changed;
}

/* ── index + map ── */
export function buildIndex(root, { hermes = [] } = {}) {
  const rows = [];
  const unresolved = new Map();
  for (const file of listEvidence(root)) {
    const sha = embeddedSha(root, file);
    if (sha) {
      if (!isCommit(root, sha)) {
        const fa = firstAdd(root, file);
        if (fa) {
          const e = unresolved.get(sha) || { old: sha, new: fa.sha, kind: 'rebased-or-local', source: 'commit that first added the evidence file citing the old SHA', files: [] };
          e.files.push(file);
          unresolved.set(sha, e);
        }
      }
      continue;
    }
    const fa = firstAdd(root, file);
    if (fa) rows.push(`${file}\t${fa.sha}\t${fa.date}\tgit-first-add`);
  }
  const header = [
    '# row 89 — base SHA for historical evidence files that do not embed one.',
    '# columns: path<TAB>base_sha<TAB>date_utc<TAB>source ; source=git-first-add means: the commit that first added the file.',
    '# New evidence must embed its own SHA (txt: base_sha= header; log: commit_sha; others: base_sha=). Regenerate: node tools/evidence-sha-89.mjs --index',
  ];
  fs.writeFileSync(path.join(root, INDEX), header.concat(rows).join('\n') + '\n');
  const map = {
    version: 1,
    generated_by: 'tools/evidence-sha-89.mjs --index',
    rule: 'every SHA cited by evidence must be a commit in this repository; if it is not (rebased/squashed/local), it must appear here as old -> new where new is a commit that is an ancestor of main',
    entries: hermes.concat([...unresolved.values()].sort((a, b) => a.old.localeCompare(b.old))),
  };
  fs.writeFileSync(path.join(root, MAP), JSON.stringify(map, null, 2) + '\n');
  return { indexed: rows.length, mapped: map.entries.length };
}

/* ── check (دروازهٔ CI) ── */
export function check(root, { allowShallow = false } = {}) {
  const failures = [];
  const shallow = git(root, ['rev-parse', '--is-shallow-repository']).trim() === 'true';
  if (shallow && !allowShallow) failures.push('repository is shallow — use actions/checkout fetch-depth: 0 (SHA resolution needs full history)');
  const index = readIndex(root);
  let map;
  try { map = readMap(root); } catch (e) { failures.push(`${MAP}: invalid JSON (${e.message})`); map = { entries: [] }; }
  const mapped = new Map();
  for (const e of map.entries || []) {
    if (!e || !/^[0-9a-f]{7,40}$/.test(String(e.old || ''))) { failures.push(`${MAP}: bad old sha ${JSON.stringify(e && e.old)}`); continue; }
    if (!/^[0-9a-f]{40}$/.test(String(e.new || ''))) { failures.push(`${MAP}: ${e.old} -> new must be a full 40-hex SHA`); continue; }
    if (!shallow) {
      if (!isCommit(root, e.new)) failures.push(`${MAP}: ${e.old} -> ${e.new} is not a commit in this repository`);
      else if (!isAncestor(root, e.new)) failures.push(`${MAP}: ${e.old} -> ${e.new} is not an ancestor of HEAD`);
    }
    mapped.set(e.old, e.new);
  }
  const files = listEvidence(root);
  const stats = { files: files.length, txt: 0, log: 0, other_embedded: 0, indexed: 0, mapped_refs: 0 };
  for (const file of files) {
    const ext = path.extname(file);
    let text = '';
    try { text = fs.readFileSync(path.join(root, file), 'utf8'); } catch (e) { failures.push(`${file}: unreadable`); continue; }
    let sha = embeddedSha(root, file);
    if (ext === '.txt') {
      stats.txt++;
      for (const err of headerErrors(text)) failures.push(`${file}: ${err}`);
      if (!sha) continue;
    } else if (ext === '.log') {
      stats.log++;
      if (!sha) { failures.push(`${file}: no 40-hex commit SHA in the first 25 lines`); continue; }
    } else if (sha) {
      stats.other_embedded++;
    } else {
      const row = index.get(file);
      if (!row) { failures.push(`${file}: no base_sha= in the first 25 lines and no row in ${INDEX}`); continue; }
      if (!/^[0-9a-f]{40}$/.test(row.sha || '')) { failures.push(`${INDEX}: ${file} has a bad sha`); continue; }
      if (!DATE_RE.test(row.date || '')) failures.push(`${INDEX}: ${file} has a bad date_utc`);
      stats.indexed++;
      sha = row.sha;
    }
    if (shallow) continue;
    if (!isCommit(root, sha)) {
      if (mapped.has(sha)) stats.mapped_refs++;
      else failures.push(`${file}: SHA ${sha.slice(0, 12)} is not a commit in this repository and is not mapped in ${MAP}`);
    }
  }
  for (const f of index.keys()) if (!files.includes(f)) failures.push(`${INDEX}: stale row for missing file ${f}`);
  return { ok: failures.length === 0, failures, stats };
}

/* هفت نگاشت تأییدشدهٔ گزارش sha-remap-hermes-30-60.md (ردیف‌های ۳۰–۶۰) */
export function hermesEntries(root) {
  const p = path.join(root, EV_DIR, 'sha-remap-hermes-30-60.md');
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\|\s*`([0-9a-f]{7})`\s*\|\s*`([0-9a-f]{40})`\s*\|\s*([^|]+)\|/);
    if (m) out.push({ old: m[1], new: m[2], kind: 'hermes-remap', source: 'sha-remap-hermes-30-60.md', subject: m[3].trim(), files: [] });
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--root');
  const root = i >= 0 ? path.resolve(argv[i + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (argv.includes('--backfill')) {
    const n = backfill(root);
    console.log(`EVIDENCE-SHA-89 backfilled_txt=${n}`);
  }
  if (argv.includes('--index')) {
    const r = buildIndex(root, { hermes: hermesEntries(root) });
    console.log(`EVIDENCE-SHA-89 index_rows=${r.indexed} sha_map_entries=${r.mapped}`);
  }
  if (argv.includes('--backfill') || argv.includes('--index')) {
    if (!argv.includes('--check')) return 0;
  }
  const r = check(root, { allowShallow: argv.includes('--allow-shallow') });
  for (const f of r.failures) console.log(`EVIDENCE-SHA-FAIL ${f}`);
  const s = r.stats;
  console.log(`${r.ok ? 'EVIDENCE-SHA-89-OK' : 'EVIDENCE-SHA-89-FAILED'} files=${s.files} txt=${s.txt} log=${s.log} other_embedded=${s.other_embedded} indexed=${s.indexed} mapped_refs=${s.mapped_refs} failures=${r.failures.length}`);
  return r.ok ? 0 : 1;
}

const isMain = () => { try { return import.meta.url === pathToFileURL(fs.realpathSync(path.resolve(process.argv[1]))).href; } catch (e) { return false; } };
if (process.argv[1] && isMain()) process.exit(main());
