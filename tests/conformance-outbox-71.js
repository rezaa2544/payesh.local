'use strict';
/* Row 71 — shared outbox conformance vectors against the web outbox (client/outbox-web.js).
   The same vectors (docs/cloud/contracts/conformance/outbox-v1.json) run against the Dart outbox in
   apps/payesh/packages/payesh_sync (test/outbox_conformance_test.dart). Run: node tests/conformance-outbox-71.js */
require('fake-indexeddb/auto');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const outbox = require('../client/outbox-web');

const FILE = path.join(__dirname, '..', 'docs', 'cloud', 'contracts', 'conformance', 'outbox-v1.json');
const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));

async function runCase(c, idx) {
  const ob = await outbox.open('conf-outbox-' + idx + '-' + Date.now(), c.config);
  try {
    for (const [i, s] of c.steps.entries()) {
      const at = `step ${i} ${s.op}`;
      switch (s.op) {
        case 'enqueue': {
          const r = await ob.enqueue(s.input);
          assert.deepStrictEqual(pick(r, Object.keys(s.expect)), s.expect, at);
          break;
        }
        case 'list':
          assert.deepStrictEqual((await ob.list()).map(r => r.k), s.expect_keys, at);
          break;
        case 'claim':
          assert.deepStrictEqual((await ob.claim(s.limit, s.now)).map(r => r.k), s.expect_keys, at);
          break;
        case 'fail': {
          const r = await ob.fail(s.k, { error: s.error, now: s.now, transient: !!s.transient });
          assert.deepStrictEqual(pick(r, Object.keys(s.expect)), s.expect, at);
          break;
        }
        case 'ack': await ob.ack(s.k); break;
        case 'retry': await ob.retry(s.k); break;
        case 'recover':
          assert.deepStrictEqual(await ob.recover(s.now), s.expect, at);
          break;
        case 'stats': {
          const st = await ob.stats();
          assert.deepStrictEqual(pick(st, Object.keys(s.expect)), s.expect, at);
          break;
        }
        case 'get': {
          const r = (await ob.list()).find(x => x.k === s.k);
          assert.ok(r, at + ' missing ' + s.k);
          assert.deepStrictEqual(pick(r, Object.keys(s.expect)), s.expect, at);
          break;
        }
        case 'drain': {
          const script = [...s.script];
          const sent = [];
          const res = await ob.drain({
            now: s.now,
            send: async wire => {
              sent.push(wire.map(w => w.uid));
              const ans = script.shift() || {};
              if (ans.throw) throw new Error(ans.throw);
              const m = k => (ans[k] || []).map(uid => ({ uid }));
              return { ok: true, applied: m('applied'), rejected: m('rejected'), conflicts: m('conflicts') };
            },
          });
          assert.deepStrictEqual(pick(res, Object.keys(s.expect)), s.expect, at);
          if (s.expect_sent) assert.deepStrictEqual(sent, s.expect_sent, at + ' sent');
          break;
        }
        case 'wire': {
          const r = (await ob.list()).find(x => x.k === s.k);
          assert.deepStrictEqual(outbox.toWire(r), s.expect, at);
          break;
        }
        default: throw new Error('unknown op ' + s.op);
      }
    }
  } finally { ob.close(); }
}

(async () => {
  console.log(`\noutbox conformance ${doc.id} v${doc.version} — web outbox (IndexedDB)\n`);
  let passed = 0, failed = 0;
  for (const [i, c] of doc.cases.entries()) {
    try { await runCase(c, i); passed++; console.log('  ✓ ' + c.name); }
    catch (e) { failed++; console.log('  ✗ ' + c.name + ' — ' + String(e.message || e).replace(/\s+/g, ' ').slice(0, 500)); }
  }
  console.log(`\n  ${passed} passed, ${failed} failed (cases=${doc.cases.length})`);
  if (failed || passed !== doc.cases.length) { console.log('CONFORMANCE-OUTBOX-WEB-FAIL'); process.exit(1); }
  console.log('CONFORMANCE-OUTBOX-WEB-OK');
})();
