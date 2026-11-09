'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const PRIVATE_KEY_PATH = /(?:^|\/)[^/]+\.(?:p12|pfx|jks|keystore)$/i;
const TEXT_EXTENSIONS = new Set([
  '.cjs', '.gradle', '.groovy', '.js', '.json', '.md', '.mjs', '.properties',
  '.ps1', '.sh', '.txt', '.vbs', '.xml', '.yaml', '.yml',
]);
const STATIC_ASSIGNMENTS = [
  /\b(?:storePassword|keyPassword)\s*(?:=|\s)\s*(['"])(?!\s*(?:\$|System\.getenv|System\.getProperty))[^'"\r\n]{4,}\1/gi,
  /\bPAYESH_(?:KEYSTORE_B64|KEYSTORE_PASS|KEY_PASS)\s*[:=]\s*(['"])(?!\s*(?:\$|<REDACTED>))[^'"\r\n]{4,}\1/gi,
  /\bPAYESH_(?:KEYSTORE_B64|KEYSTORE_PASS|KEY_PASS)\s*[:=]\s*(?!['"]?\s*(?:\$|<REDACTED>))[^\s#'"]{4,}/gi,
  /^\s*(?:رمز(?:\s*\([^)]*\))?|password)\s*[:：]\s*(?!<REDACTED>)(\S+)/gim,
];

function inspectEntries(entries) {
  const violations = [];
  for (const entry of entries) {
    const file = entry.path.replaceAll('\\', '/');
    if (PRIVATE_KEY_PATH.test(file)) {
      violations.push({ path: file, reason: 'private signing-key file is tracked' });
      continue;
    }
    if (typeof entry.text !== 'string') continue;
    for (const [index, pattern] of STATIC_ASSIGNMENTS.entries()) {
      // Free-form password labels are only meaningful in the signing manifest;
      // generic application text legitimately discusses user PINs/passwords.
      if (index === 3 && !/(^|\/)SIGNING\.txt$/i.test(file)) continue;
      pattern.lastIndex = 0;
      if (pattern.test(entry.text)) {
        violations.push({ path: file, reason: 'literal signing credential is embedded in tracked text' });
        break;
      }
    }
  }
  return violations;
}

function selfTest() {
  const sample = [
    { path: 'install/android/test.p12', text: '' },
    { path: 'install/android/app/build.gradle', text: ['storePassword', ' "synthetic-not-a-secret"\n'].join('') },
    { path: '.github/workflows/injected-unquoted.yml', text: ['PAYESH_KEYSTORE_PASS', ': synthetic-value\n'].join('') },
    { path: '.github/workflows/injected-quoted.yml', text: ['PAYESH_KEYSTORE_B64', ': "synthetic-value"\n'].join('') },
    { path: 'install/android/SIGNING.txt', text: 'رمز (نمونه): synthetic-not-a-secret\n' },
  ];
  const violations = inspectEntries(sample);
  assert.equal(violations.length, 5, 'all injected key/password forms must be detected');
  assert.ok(violations.every((item) => !item.secret), 'diagnostics must never contain secret values');
  assert.deepEqual(inspectEntries([
    { path: 'install/android/app/build.gradle', text: 'storePassword System.getenv("PAYESH_KEYSTORE_PASS")\n' },
    { path: 'docs/signing.md', text: 'Use PAYESH_KEY_PASS from GitHub Secrets; do not record passwords.\n' },
  ]), [], 'environment-provided credentials and non-literal instructions are allowed');
  console.log('ANDROID-SIGNING-SAFETY-SELFTEST-OK injected=5 fail=0');
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--self-test') return selfTest();
  if (args.length > 0) throw new Error('usage: node tools/check-android-signing-safety.cjs [--self-test]');

  const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'buffer' })
    .toString('utf8').split('\0').filter(Boolean);
  const entries = [];
  for (const file of paths) {
    if (PRIVATE_KEY_PATH.test(file)) {
      entries.push({ path: file, text: '' });
      continue;
    }
    const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext) || !fs.existsSync(file)) continue;
    const content = fs.readFileSync(file);
    if (content.includes(0)) continue;
    entries.push({ path: file, text: content.toString('utf8') });
  }

  const violations = inspectEntries(entries);
  if (violations.length) {
    for (const item of violations) console.error(`ANDROID-SIGNING-SAFETY-FAIL: ${item.path}: ${item.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(`ANDROID-SIGNING-SAFETY-OK scanned=${entries.length} tracked_text_files=${entries.length}`);
}

try {
  main();
} catch (error) {
  console.error(`ANDROID-SIGNING-SAFETY-ERROR: ${error.message}`);
  process.exitCode = 1;
}

module.exports = { inspectEntries };
