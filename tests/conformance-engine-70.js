'use strict';
/* Row 70 — shared engine conformance vectors against the web engine (client/engine-web.js).
   The same vectors (docs/cloud/contracts/conformance/engine-v1.json) run against the Dart SQLite
   engine in apps/payesh/packages/payesh_data (test/conformance_test.dart). Passing both proves parity.
   Run: node tests/conformance-engine-70.js */
require('fake-indexeddb/auto');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const engine = require('../client/engine-web');

const FILE = path.join(__dirname, '..', 'docs', 'cloud', 'contracts', 'conformance', 'engine-v1.json');
const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));

const norm = r => (r ? {
  k: r.k, collection: r.collection, id: r.id, data: r.data, version: r.version,
  refKeys: [...(r.refKeys || [])].sort(), updated_at: r.updated_at,
} : null);
const normExpect = r => (r ? Object.assign({}, r, { refKeys: [...(r.refKeys || [])].sort() }) : null);

async function runCase(c, idx) {
  const db = await engine.open('conf-' + idx + '-' + Date.now());
  try {
    for (const [i, s] of c.steps.entries()) {
      const at = `step ${i} ${s.op}`;
      switch (s.op) {
        case 'put':
          await db.put(s.collection, s.id, s.data, { version: s.version || 1, refFields: s.refFields || null, updated_at: s.updated_at || null });
          break;
        case 'putMany': {
          const n = await db.putMany(s.rows);
          if ('expect' in s) assert.strictEqual(n, s.expect, at);
          break;
        }
        case 'get':
          assert.deepStrictEqual(norm(await db.get(s.collection, s.id)), normExpect(s.expect), at);
          break;
        case 'count':
          assert.strictEqual(await db.count(s.collection), s.expect, at);
          break;
        case 'list':
          assert.deepStrictEqual((await db.list(s.collection, { limit: s.limit, offset: s.offset })).map(r => r.id), s.expect_ids, at);
          break;
        case 'byRef':
          assert.deepStrictEqual((await db.byRef(s.collection, s.field, s.value)).map(r => r.id), s.expect_ids, at);
          break;
        case 'since':
          assert.deepStrictEqual((await db.since(s.collection, s.iso, { limit: s.limit })).map(r => r.id), s.expect_ids, at);
          break;
        case 'del':
          await db.del(s.collection, s.id);
          break;
        case 'clear':
          await db.clear();
          break;
        case 'stats': {
          const st = await db.stats();
          assert.deepStrictEqual({ total: st.total, collections: st.collections }, s.expect, at);
          break;
        }
        default:
          throw new Error('unknown op ' + s.op);
      }
    }
  } finally { db.close(); }
}

(async () => {
  console.log(`\nengine conformance ${doc.id} v${doc.version} — web engine (IndexedDB)\n`);
  let passed = 0, failed = 0;
  for (const [i, c] of doc.cases.entries()) {
    try { await runCase(c, i); passed++; console.log('  ✓ ' + c.name); }
    catch (e) { failed++; console.log('  ✗ ' + c.name + ' — ' + String(e.message || e).replace(/\s+/g, ' ').slice(0, 400)); }
  }
  console.log(`\n  ${passed} passed, ${failed} failed (cases=${doc.cases.length})`);
  if (failed || passed !== doc.cases.length) { console.log('CONFORMANCE-ENGINE-WEB-FAIL'); process.exit(1); }
  console.log('CONFORMANCE-ENGINE-WEB-OK');
})();
