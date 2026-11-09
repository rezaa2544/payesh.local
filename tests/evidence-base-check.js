'use strict';

const assert = require('node:assert/strict');
const { inspectText } = require('../tools/check-evidence-base.cjs');

const SHA = 'd04620943b570b6b3175b0c02957fad247665a42';
const DATE = '2026-11-09T15:33:09Z';
let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

test('شاهد PASS با SHA و تاریخ معتبر پذیرفته می‌شود', () => {
  const result = inspectText(`base_sha=${SHA}\ndate_utc=${DATE}\ncommand=node test.js\n\nPASS آزمون`);
  assert.equal(result.checked, true);
  assert.deepEqual(result.errors, []);
});

test('شاهد FAIL بدون base_sha رد می‌شود (کنترل منفی)', () => {
  const result = inspectText(`date_utc=${DATE}\n\nFAIL آزمون`);
  assert.equal(result.checked, true);
  assert.ok(result.errors.some((error) => error.includes('base_sha')));
});

test('شاهد PASS با SHA کوتاه رد می‌شود (کنترل منفی)', () => {
  const result = inspectText(`base_sha=d046209\ndate_utc=${DATE}\n\nPASS آزمون`);
  assert.equal(result.checked, true);
  assert.ok(result.errors.some((error) => error.includes('40-character')));
});

test('گزارش دارای توضیح مقدماتی قدیمی خارج از دامنه می‌ماند', () => {
  const result = inspectText(`# توضیح تاریخی\nPASS متن قدیمی`);
  assert.equal(result.checked, false);
  assert.deepEqual(result.errors, []);
});

if (process.exitCode) process.exit(1);
console.log(`EVIDENCE-BASE-TESTS-OK checks=${passed} fail=0`);
