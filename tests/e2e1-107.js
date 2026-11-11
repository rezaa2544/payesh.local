'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 107 — e2e1 library (tools/e2e1.js) against the shared vectors.
   E1-01 .. E1-10, no database needed (the database half is
   tests/e2e-keys-107.js on real PostgreSQL).

   Run: node tests/e2e1-107.js        (also registered in tests/run.js)
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const e2e = require('../tools/e2e1.js');

const ROOT = path.resolve(__dirname, '..');
const VECTORS = path.join(ROOT, 'docs/cloud/contracts/e2e1-vectors-107.json');

async function main(opts = {}) {
  const log = opts.quiet ? () => {} : (...a) => console.log(...a);
  let passed = 0, failed = 0, negatives = 0;
  const failures = [];
  const check = async (id, desc, fn) => {
    try { const d = await fn(); passed++; log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); } catch (e) {
      failed++; failures.push(id); log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e).slice(0, 300)}`);
    }
  };
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
  const refuses = (fn, code, what) => {
    try { fn(); } catch (e) { if (e.code === code) { negatives++; return; } throw new Error(`${what}: expected ${code}, got ${e.code || ''} ${e.message}`); }
    throw new Error(`${what}: expected ${code}, but it opened`);
  };
  const U = s => e2e.unb64u(s);
  log('\nRow 107: e2e1 — device-side encryption library (JS reference) vs shared vectors\n');
  const V = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));

  await check('E1-01', 'vector file is exactly what the generator produces (no hand edits, no drift)', async () => {
    const gen = await import(pathToFileURL(path.join(ROOT, 'tools/e2e1-vectors-107.mjs')).href);
    eq(gen.render() === fs.readFileSync(VECTORS, 'utf8'), true, 'vectors stale — run node tools/e2e1-vectors-107.mjs');
    return `${V.scope_keys.length} scope keys, 1 record × ${V.record.opens.length} readers, ${V.record.negatives.length + V.grant.negatives.length} negative vectors`;
  });

  await check('E1-02', 'X25519 matches RFC 7748 §6.1 (both directions)', () => {
    const x = V.x25519_rfc7748; const H = s => Buffer.from(s, 'hex');
    eq(e2e.publicFromPrivate(H(x.alice_priv_hex)).toString('hex'), x.alice_pub_hex, 'alice pub');
    eq(e2e.publicFromPrivate(H(x.bob_priv_hex)).toString('hex'), x.bob_pub_hex, 'bob pub');
    eq(e2e.x25519(H(x.alice_priv_hex), H(x.bob_pub_hex)).toString('hex'), x.shared_hex, 'a→b');
    eq(e2e.x25519(H(x.bob_priv_hex), H(x.alice_pub_hex)).toString('hex'), x.shared_hex, 'b→a');
    return 'shared 4a5d9d5b…';
  });

  await check('E1-03', 'scope keys: derivation matches vectors; different tenant / scope / generation ⇒ different key', () => {
    for (const s of V.scope_keys) {
      const k = e2e.deriveScopeKey(U(s.smk), s.tenant, s.scope, s.smk_gen, s.gen);
      eq(k.kid, s.kid, 'kid'); eq(e2e.b64u(k.priv), s.priv, s.kid + ' priv'); eq(e2e.b64u(k.pub), s.pub, s.kid + ' pub');
    }
    const s = V.scope_keys[2];
    const base = e2e.b64u(e2e.deriveScopeKey(U(s.smk), s.tenant, s.scope, s.smk_gen, s.gen).priv);
    const variants = [
      e2e.deriveScopeKey(U(s.smk), '5d1c0f7e-8a2b-4e3d-b6c4-91a0f2e7d302', s.scope, s.smk_gen, s.gen),
      e2e.deriveScopeKey(U(s.smk), s.tenant, 'class:8:attendance', s.smk_gen, s.gen),
      e2e.deriveScopeKey(U(s.smk), s.tenant, s.scope, s.smk_gen, s.gen + 1),
      e2e.deriveScopeKey(U(s.smk), s.tenant, s.scope, s.smk_gen + 1, s.gen),
    ];
    for (const v of variants) { assert(e2e.b64u(v.priv) !== base, 'collision ' + v.kid); negatives++; }
    return `${V.scope_keys.length} keys equal, 4 variants distinct`;
  });

  await check('E1-04', 'record envelope: deterministic seal equals the vector; manager, school reader, class teacher and parent each open it', () => {
    const r = V.record; const f = r.fixed;
    const dir = new Map(r.recipients.map(x => [e2e.parseKid(x.kid).scope, { kid: x.kid, pub: U(x.pub) }]));
    const sealed = e2e.sealRecord(r.meta, JSON.parse(r.plaintext), dir, { eph: U(f.eph), dek: U(f.dek), iv: U(f.iv), wrapIvs: f.wrap_ivs.map(U) });
    eq(sealed, r.sealed, 'sealed');
    eq(e2e.recordAad(r.meta.tenant_id, r.meta.collection, r.meta.record_id, r.meta.version), r.aad, 'aad');
    for (const o of r.opens) eq(e2e.open(r.sealed, new Map([[o.key.kid, U(o.key.priv)]]), o.aad).toString('utf8'), o.plaintext, o.why);
    assert(!r.sealed.includes('CANARY') && !r.sealed.includes('absent'), 'plaintext visible in the envelope');
    return `${r.sealed.length} chars, recipients ${e2e.recipientsOf(r.sealed).join(' ')}`;
  });

  await check('E1-05', 'NEGATIVE record vectors: moved row / other version / other school / other collection / tampered / rotated-out key / wrong key / truncated', () => {
    for (const n of V.record.negatives) refuses(() => e2e.open(n.envelope, new Map([[n.key.kid, U(n.key.priv)]]), n.aad), n.expect, n.name);
    return V.record.negatives.map(n => n.name).join(', ');
  });

  await check('E1-06', 'key grants: sealed to the device, bound to tenant+device+kid; an SMK grant lets a manager keyring derive every scope key', () => {
    const g = V.grant; const f = g.fixed;
    eq(e2e.sealGrant(U(g.device_pub), g.tenant, g.device_id, g.kid, U(g.secret), { eph: U(f.eph), dek: U(f.dek), iv: U(f.iv), wrapIvs: f.wrap_ivs.map(U) }), g.sealed, 'grant sealed');
    eq(e2e.b64u(e2e.openGrant(g.sealed, U(g.device_priv), g.tenant, g.device_id, g.kid)), g.secret, 'grant opens');
    for (const n of g.negatives) refuses(() => e2e.openGrant(n.envelope, U(g.device_priv), g.tenant, n.device_id, n.kid), n.expect, n.name);
    refuses(() => e2e.openGrant(g.sealed, e2e.generateKeyPair().priv, g.tenant, g.device_id, g.kid), 'e2e_open_failed', 'another device key');
    const sg = g.smk_grant; const sf = sg.fixed;
    eq(e2e.sealGrant(U(g.device_pub), g.tenant, g.device_id, sg.kid, U(sg.secret), { eph: U(sf.eph), dek: U(sf.dek), iv: U(sf.iv), wrapIvs: sf.wrap_ivs.map(U) }), sg.sealed, 'smk grant sealed');
    const ring = new e2e.Keyring(g.tenant);
    ring.addGrant(sg.kid, e2e.openGrant(sg.sealed, U(g.device_priv), g.tenant, g.device_id, sg.kid));
    const row = Object.assign({}, V.record.meta, { sealed: V.record.sealed });
    eq(JSON.stringify(ring.openRecord(row)), V.record.plaintext, 'manager keyring opens the record');
    const teacher = new e2e.Keyring(g.tenant); teacher.addGrant(g.kid, U(g.secret));
    eq(JSON.stringify(teacher.openRecord(row)), V.record.plaintext, 'teacher keyring opens the record');
    refuses(() => teacher.openRecord(Object.assign({}, row, { record_id: 9002 })), 'e2e_open_failed', 'teacher keyring, moved row');
    return 'grant + smk grant equal vectors; 3 grant negatives; keyrings open';
  });

  await check('E1-07', 'random sealing: fresh DEK/IV/ephemeral key every time, round-trips 1 B … 256 KiB and Persian text', () => {
    const t = '0b7e6a52-3f0c-4c1e-9a55-2f1d7c0e9a01';
    const smk = e2e.newSmk();
    const k = e2e.deriveScopeKey(smk, t, 'school:notes', 1, 0);
    const aad = e2e.recordAad(t, 'notes', 1, 1);
    const a = e2e.seal([{ kid: k.kid, pub: k.pub }], 'یادداشت مشاور', aad);
    const b = e2e.seal([{ kid: k.kid, pub: k.pub }], 'یادداشت مشاور', aad);
    assert(a !== b, 'two seals of the same plaintext are identical');
    eq(e2e.open(a, new Map([[k.kid, k.priv]]), aad).toString('utf8'), 'یادداشت مشاور', 'persian');
    for (const n of [1, 1000, 262144]) {
      const pt = Buffer.alloc(n, 0x61);
      assert(e2e.open(e2e.seal([{ kid: k.kid, pub: k.pub }], pt, aad), new Map([[k.kid, k.priv]]), aad).equals(pt), 'len ' + n);
    }
    return 'nondeterministic, sizes 1/1000/262144 ok';
  });

  await check('E1-08', 'NEGATIVE malformed input fails closed: low-order key, non-canonical base64url, short wrap, duplicate recipient, bad routing, bad kid', () => {
    refuses(() => e2e.x25519(e2e.generateKeyPair().priv, Buffer.alloc(32)), 'e2e_bad_key', 'all-zero public key');
    const s = V.record.sealed; const p = s.split('.');
    refuses(() => e2e.parse([p[0], p[1] + 'A', p[2], p[3], p[4]].join('.')), 'e2e_bad_format', 'eph 33 bytes');
    refuses(() => e2e.parse([p[0], p[1], p[2], p[3], p[4].split('~')[0].slice(0, -4)].join('.')), 'e2e_bad_format', 'short wrap');
    refuses(() => e2e.parse('e2e2' + s.slice(4)), 'e2e_bad_format', 'unknown version');
    refuses(() => e2e.parse(s + '.x'), 'e2e_bad_format', 'extra part');
    const k = e2e.deriveScopeKey(e2e.newSmk(), V.grant.tenant, 'school:x', 1, 0);
    refuses(() => e2e.seal([{ kid: k.kid, pub: k.pub }, { kid: k.kid, pub: k.pub }], 'x', 'a'), 'e2e_bad_scope', 'duplicate recipient');
    refuses(() => e2e.recordAad(V.grant.tenant, 'Attendance', 1, 1), 'e2e_bad_record', 'collection case');
    refuses(() => e2e.recordAad(V.grant.tenant, 'attendance', 0, 1), 'e2e_bad_record', 'record id 0');
    refuses(() => e2e.kidOf('class:7:attendance', 0, 0), 'e2e_bad_scope', 'smk_gen 0');
    refuses(() => e2e.scopeName('class', 'attendance', 'x; drop'), 'e2e_bad_scope', 'scope injection');
    refuses(() => e2e.open(s, new Map(), V.record.aad), 'e2e_no_key', 'no key');
    const meta = Object.assign({}, V.record.meta);
    refuses(() => e2e.sealRecord(meta, {}, new Map([['school:attendance', { kid: k.kid, pub: k.pub }]])), 'e2e_no_scope_key', 'record without the smk recipient');
    const sk = e2e.deriveScopeKey(e2e.newSmk(), meta.tenant_id, 'smk', 1, 0);
    eq(e2e.recipientsOf(e2e.sealRecord(meta, {}, new Map([['smk', sk]]))).join(','), 'smk@1+0', 'unpublished scopes skipped, smk kept');
    return '12 refusals; unpublished optional scopes skipped';
  });

  await check('E1-09', 'rotation: after class key gen+1 and re-seal, the revoked holder (old generation) cannot open; current holders and the manager can', () => {
    const t = V.grant.tenant; const smk = U(V.scope_keys[0].smk);
    const meta = { tenant_id: t, collection: 'attendance', record_id: 77, version: 1, class_id: 7, student_id: 42 };
    const dirAt = g => new Map(e2e.recordScopes(meta).map(sc => { const k = e2e.deriveScopeKey(smk, t, sc, 1, sc.startsWith('class:') ? g : 0); return [sc, k]; }));
    const old = dirAt(0).get('class:7:attendance');
    const v1 = e2e.sealRecord(meta, { s: 'present' }, dirAt(0));
    eq(JSON.stringify(e2e.openRecord(Object.assign({}, meta, { sealed: v1 }), new Map([[old.kid, old.priv]]))), '{"s":"present"}', 'gen0 opens v1');
    const meta2 = Object.assign({}, meta, { version: 2 });
    const v2 = e2e.sealRecord(meta2, { s: 'present' }, dirAt(1));
    refuses(() => e2e.openRecord(Object.assign({}, meta2, { sealed: v2 }), new Map([[old.kid, old.priv]])), 'e2e_no_key', 'revoked teacher, gen0 key, v2');
    refuses(() => e2e.openRecord(Object.assign({}, meta2, { sealed: v2 }), new Map([[e2e.kidOf('class:7:attendance', 1, 1), old.priv]])), 'e2e_open_failed', 'revoked teacher relabels gen0 key as gen1');
    const ring = new e2e.Keyring(t); ring.addGrant('smk@1+0', smk);
    eq(JSON.stringify(ring.openRecord(Object.assign({}, meta2, { sealed: v2 }))), '{"s":"present"}', 'manager after rotation');
    return 'v2 sealed to class:7:attendance@1+1; gen 1+0 refused';
  });

  await check('E1-10', 'mutation control: an envelope sealed WITHOUT binding the row (empty AAD) is caught by the moved-row check', () => {
    const t = V.grant.tenant; const k = e2e.deriveScopeKey(e2e.newSmk(), t, 'school:attendance', 1, 0);
    const broken = e2e.seal([{ kid: k.kid, pub: k.pub }], 'x', '');
    refuses(() => e2e.open(broken, new Map([[k.kid, k.priv]]), e2e.recordAad(t, 'attendance', 5, 1)), 'e2e_open_failed', 'unbound envelope');
    return 'unbound envelope refused under a real row AAD';
  });

  log(`\n# passed=${passed} failed=${failed} negative_controls=${negatives}`);
  log(failed ? `E2E1-107-FAIL ${failures.join(',')}` : 'E2E1-107-OK');
  return { passed, failed, negatives, failures };
}

module.exports = { main };
if (require.main === module) main().then(r => process.exit(r.failed ? 1 : 0), e => { console.error(e); process.exit(1); });
