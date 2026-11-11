#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   Log PII gate (row 85)

   Reads one or more log files (or stdin with "-") and fails when any line
   carries PII or a secret, using the same detector as server/logger.js.
   With --require-json it also fails when a line that should be structured
   is not valid JSON, has a key outside the logger allowlist, or (access-log
   lines, event == "http") lacks request_id / school_id.

   The report never prints the matched value, only file:line and the kind.

   Usage:
     node tools/log-pii-scan-85.mjs [--require-json] [--json-only] FILE… | -
   Exit: 0 = clean · 1 = PII found or structure broken · 2 = usage error
   ═══════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logger = require(path.join(ROOT, 'server', 'logger.js'));

export function scanText(text, { requireJson = false, jsonOnly = false, name = '<input>' } = {}) {
  const findings = [];
  let lines = 0, jsonLines = 0, httpLines = 0;
  const all = String(text).split('\n');
  for (let i = 0; i < all.length; i++) {
    const line = all[i];
    if (!line.trim()) continue;
    const isJson = line.trimStart().startsWith('{');
    if (jsonOnly && !isJson) continue;
    lines++;
    for (const h of logger.scanPii(line)) findings.push({ file: name, line: i + 1, kind: h.kind });
    if (isJson) {
      let obj = null;
      try { obj = JSON.parse(line); jsonLines++; } catch (e) { if (requireJson) findings.push({ file: name, line: i + 1, kind: 'bad_json' }); }
      /* structural PII guard: a key outside the logger allowlist means some code
         path wrote a field nobody reviewed (a name, a body…) — regexes cannot
         recognise a person's name, the allowlist can. */
      if (obj && requireJson) {
        for (const k of Object.keys(obj)) if (!logger.SAFE_KEYS.has(k)) findings.push({ file: name, line: i + 1, kind: 'unknown_key' });
      }
      if (obj && obj.event === 'http') {
        httpLines++;
        if (requireJson) {
          if (!obj.request_id) findings.push({ file: name, line: i + 1, kind: 'missing_request_id' });
          if (!Object.prototype.hasOwnProperty.call(obj, 'school_id')) findings.push({ file: name, line: i + 1, kind: 'missing_school_id' });
        }
      }
    }
  }
  return { lines, jsonLines, httpLines, findings };
}

function main(argv) {
  const flags = new Set(argv.filter(a => a.startsWith('--')));
  const files = argv.filter(a => !a.startsWith('--'));
  if (!files.length) { console.error('usage: log-pii-scan-85.mjs [--require-json] [--json-only] FILE… | -'); return 2; }
  const opts = { requireJson: flags.has('--require-json'), jsonOnly: flags.has('--json-only') };
  let total = { lines: 0, jsonLines: 0, httpLines: 0, findings: [] };
  for (const f of files) {
    let text;
    try { text = f === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(f, 'utf8'); }
    catch (e) { console.error('LOG-PII-85-UNREADABLE ' + f + ' ' + e.code); return 2; }
    const r = scanText(text, Object.assign({ name: f }, opts));
    total.lines += r.lines; total.jsonLines += r.jsonLines; total.httpLines += r.httpLines;
    total.findings.push(...r.findings);
  }
  for (const x of total.findings.slice(0, 50)) console.log(`LOG-PII-85-HIT ${x.file}:${x.line} kind=${x.kind}`);
  const summary = `lines=${total.lines} json=${total.jsonLines} http=${total.httpLines} findings=${total.findings.length}`;
  if (total.findings.length) { console.log('LOG-PII-85-FAILED ' + summary); return 1; }
  console.log('LOG-PII-85-OK ' + summary);
  return 0;
}

let isMain = false;
try { isMain = import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch (e) { isMain = false; }
if (isMain) process.exit(main(process.argv.slice(2)));
