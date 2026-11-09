'use strict';

const assert = require('node:assert/strict');
const { inspectStrictText } = require('./check-evidence-base.cjs');

const sha = 'b8508aea95cbb7a9ebe157d7e65831160aeaacd2';
const date = '2026-10-30T00:00:00Z';
const cases = [
  ['valid metadata after descriptive preamble is accepted', `# Evidence\nbase_sha=${sha}\ndate_utc=${date}\n\nPASS recorded`, true, null],
  ['missing SHA is rejected even when file starts with a comment', `# Evidence\ndate_utc=${date}\n\nPASS recorded`, false, 'base_sha'],
  ['short SHA is rejected', `base_sha=b8508ae\ndate_utc=${date}\nPASS recorded`, false, '40-character'],
  ['metadata outside the first eight lines is rejected', `# one\n# two\n# three\n# four\n# five\n# six\n# seven\n# eight\nbase_sha=${sha}\ndate_utc=${date}\nPASS recorded`, false, 'first 8 lines'],
];

for (const [name, input, expected, expectedError] of cases) {
  const result = inspectStrictText(input);
  assert.equal(result.checked, true, name);
  assert.equal(result.errors.length === 0, expected, name);
  if (expectedError) assert.ok(result.errors.some((error) => error.includes(expectedError)), name);
  console.log(`PASS ${name}`);
}
console.log(`EVIDENCE-BASE-STRICT-SELFTEST-OK checks=${cases.length} fail=0`);
