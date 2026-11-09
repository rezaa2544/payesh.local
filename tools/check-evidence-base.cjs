'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SHA_RE = /^[0-9a-f]{40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const RESULT_RE = /^(?:PASS|FAIL)(?:\s|:|$)/;
const META_RE = /^(?:base_sha|date_utc|command)=/;

function inspectText(text) {
  const lines = String(text).split(/\r?\n/);
  const first = lines.find((line) => line.trim());
  if (!first) return { checked: false, errors: [] };

  // Legacy evidence with a descriptive/comment preamble is outside this gate.
  // New evidence either starts with PASS/FAIL, or with the required metadata.
  if (first.trim().startsWith('#')) return { checked: false, errors: [] };

  const startsWithMetadata = META_RE.test(first.trim());
  const firstResult = startsWithMetadata
    ? lines.find((line) => {
      const value = line.trim();
      return value && !META_RE.test(value);
    })
    : first;
  if (!firstResult || !RESULT_RE.test(firstResult.trim())) return { checked: false, errors: [] };

  const header = lines.slice(0, 8);
  const shaLines = header.filter((line) => line.startsWith('base_sha='));
  const dateLines = header.filter((line) => line.startsWith('date_utc='));
  const errors = [];
  if (shaLines.length !== 1) errors.push('expected exactly one base_sha= in the first 8 lines');
  else if (!SHA_RE.test(shaLines[0].slice('base_sha='.length).trim())) errors.push('base_sha must be a full 40-character lowercase Git SHA');
  if (dateLines.length !== 1) errors.push('expected exactly one date_utc= in the first 8 lines');
  else if (!DATE_RE.test(dateLines[0].slice('date_utc='.length).trim())) errors.push('date_utc must be UTC ISO-8601 (YYYY-MM-DDTHH:MM:SSZ)');
  return { checked: true, errors };
}

function scanFiles(files) {
  const uniqueFiles = [...new Set(files)].filter((file) => file.endsWith('.txt') && fs.existsSync(file)).sort();
  const failures = [];
  let checked = 0;
  for (const file of uniqueFiles) {
    const result = inspectText(fs.readFileSync(file, 'utf8'));
    if (!result.checked) continue;
    checked += 1;
    for (const error of result.errors) failures.push(`${path.basename(file)}: ${error}`);
  }
  return { checked, files: uniqueFiles.length, failures };
}

function main() {
  const args = process.argv.slice(2);
  let files;
  const filesFromIndex = args.indexOf('--files-from');
  if (filesFromIndex !== -1) {
    const listPath = args[filesFromIndex + 1];
    if (!listPath || !fs.existsSync(listPath)) {
      console.error('EVIDENCE-BASE-FAIL: --files-from requires an existing file list');
      process.exitCode = 1;
      return;
    }
    files = fs.readFileSync(listPath, 'utf8').split(/\r?\n/).filter(Boolean);
  } else {
    files = args.filter((arg) => !arg.startsWith('--'));
    if (files.length === 0) {
      console.error('EVIDENCE-BASE-FAIL: pass evidence file paths or --files-from <list>');
      process.exitCode = 1;
      return;
    }
  }

  const result = scanFiles(files);
  if (result.failures.length) {
    for (const failure of result.failures) console.error(`EVIDENCE-BASE-FAIL: ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`EVIDENCE-BASE-OK checked=${result.checked} txt_files=${result.files}`);
}

if (require.main === module) main();
module.exports = { inspectText, scanFiles };
