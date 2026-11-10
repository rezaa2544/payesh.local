'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 64 — shared conformance vectors, server side (pure, no DB).
   Runs docs/cloud/contracts/vectors/{conflict,scope,version}-v1.json against the
   real server modules. idempotency-v1 / pagination-v1 need a real Gateway +
   PostgreSQL and run in tests/native-contract-64.js.
   The same JSON files are the input of the client-side (Dart) conformance tests.
   Also proves each vector file is well-formed and that a corrupted expectation
   is detected (negative control), so the runner cannot silently pass.

   Run: node tests/contract-vectors-64.js
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..');
const VEC = path.join(ROOT, 'docs/cloud/contracts/vectors');
const convergence = require(path.join(ROOT, 'server/convergence.js'));
const scope = require(path.join(ROOT, 'server/scope.js'));
const apiVersion = require(path.join(ROOT, 'server/api-version.js'));

let pass = 0, fail = 0;
const failures = [];
function check(id, name, fn) {
  try { fn(); pass++; console.log(`PASS  ${id}  ${name}`); }
  catch (e) { fail++; failures.push(id); console.log(`FAIL  ${id}  ${name}  → ${String(e && e.message || e).replace(/\s+/g, ' ').slice(0, 300)}`); }
}
const load = (n) => JSON.parse(fs.readFileSync(path.join(VEC, n), 'utf8'));
const plain = (o) => JSON.parse(JSON.stringify(o));

function runConflict(c) {
  const i = c.input;
  const d = convergence.decide({
    collection: i.collection, type: i.type, incoming: i.incoming, existing: i.existing, base_version: i.base_version,
  });
  return { action: d.action, reason: d.reason, fields: d.fields, auto: d.auto, manual: d.manual };
}

function runVersion(c) {
  const v = apiVersion.check(c.path, c.headers, c.env);
  if (!v) return { status: 200 };
  return { status: v.status, error: v.body.error, reason: v.body.reason, supported_api: v.body.supported_api, message: v.body.message, headers: v.headers };
}

/* ── files ─────────────────────────────────────────────────────────── */
const files = fs.readdirSync(VEC).filter(f => f.endsWith('.json')).sort();
check('VEC-00', 'vector set is complete and well-formed: ' + files.join(', '), () => {
  for (const want of ['conflict-v1.json', 'idempotency-v1.json', 'pagination-v1.json', 'scope-v1.json', 'version-v1.json']) {
    assert.ok(files.includes(want), 'missing ' + want);
  }
  for (const f of files) {
    const v = load(f);
    assert.strictEqual(v.contract, 'native-api-v1', f + ': contract');
    assert.strictEqual(v.vector + '.json', f, f + ': vector name');
    assert.ok(typeof v.description === 'string' && v.description.length > 20, f + ': description');
  }
});

/* ── conflict ──────────────────────────────────────────────────────── */
const conflict = load('conflict-v1.json');
conflict.cases.forEach((c, n) => {
  check('VEC-CF-' + String(n + 1).padStart(2, '0'), 'conflict: ' + c.name, () => {
    assert.deepStrictEqual(plain(runConflict(c)), c.expect);
  });
});
check('VEC-CF-COVER', 'conflict vectors cover every rule class (merge/conflict/noop/apply, delete_vs_edit, fail-closed)', () => {
  const reasons = new Set(conflict.cases.map(c => c.expect.reason));
  for (const r of ['new_row', 'auto_merge_fields', 'sensitive_field_conflict', 'no_change', 'delete_ok', 'delete_vs_edit']) assert.ok(reasons.has(r), 'no case for ' + r);
  assert.ok(conflict.cases.some(c => !convergence.RULES[c.input.collection]), 'no unknown-collection (fail-closed) case');
});

/* ── scope ─────────────────────────────────────────────────────────── */
const sc = load('scope-v1.json');
sc.read.forEach((c, n) => {
  check('VEC-SR-' + String(n + 1).padStart(2, '0'), `scope read: ${c.scope} × ${c.collection} → ${c.expect}`, () => {
    assert.strictEqual(scope.rowInScope(sc.scopes[c.scope], c.collection, c.row), c.expect);
  });
});
sc.write.forEach((c, n) => {
  check('VEC-SW-' + String(n + 1).padStart(2, '0'), `scope write: ${c.scope} × ${c.collection} → ${c.expect.ok ? 'ok' : c.expect.error}`, () => {
    assert.deepStrictEqual(plain(scope.canWriteRow(sc.scopes[c.scope], c.collection, c.row, null)), c.expect);
  });
});

/* ── version policy ────────────────────────────────────────────────── */
const ver = load('version-v1.json');
ver.cases.forEach((c, n) => {
  check('VEC-VER-' + String(n + 1).padStart(2, '0'), 'version: ' + c.name, () => {
    const r = runVersion(c);
    assert.strictEqual(r.status, c.expect_status, 'status ' + JSON.stringify(r));
    if (c.expect_error) assert.strictEqual(r.error, c.expect_error);
    if (c.expect_reason) assert.strictEqual(r.reason, c.expect_reason);
    if (c.expect_supported_api) assert.deepStrictEqual(r.supported_api, c.expect_supported_api);
    if (r.status === 426) {
      assert.ok(/به‌روزرسانی/.test(r.message), 'explicit Persian upgrade message missing');
      assert.ok(r.headers['x-payesh-api'] && r.headers['x-payesh-api-supported'], 'version headers missing');
    }
  });
});
check('VEC-VER-WINDOW', 'window is exactly N, N-1, N-2 (BACK_VERSIONS=2) for every N in 1..6', () => {
  for (let n = 1; n <= 6; n++) {
    const cfg = apiVersion.config({ PAYESH_NATIVE_API_CURRENT: String(n) });
    const want = []; for (let i = Math.max(1, n - 2); i <= n; i++) want.push(i);
    assert.deepStrictEqual(cfg.supported, want, 'N=' + n);
  }
});

/* ── negative controls: the runner must notice a wrong expectation ── */
check('VEC-NEG-01', 'negative control: a flipped conflict expectation is detected', () => {
  const c = plain(conflict.cases.find(x => x.expect.action === 'merge'));
  c.expect.action = 'conflict';
  assert.throws(() => assert.deepStrictEqual(plain(runConflict(c)), c.expect));
});
check('VEC-NEG-02', 'negative control: a widened scope expectation is detected', () => {
  const c = sc.read.find(x => x.expect === false);
  assert.notStrictEqual(scope.rowInScope(sc.scopes[c.scope], c.collection, c.row), true);
});
check('VEC-NEG-03', 'negative control: an old client is NOT silently allowed', () => {
  const r = runVersion({ path: '/api/me', headers: { 'x-payesh-client': 'payesh-native/0.0.9' }, env: {} });
  assert.strictEqual(r.status, 426);
});

console.log(`\nVEC checks=${pass + fail} pass=${pass} fail=${fail}`);
if (fail) { console.log('CONTRACT-VECTORS-64-FAIL ' + failures.join(',')); process.exit(1); }
console.log('CONTRACT-VECTORS-64-OK');
