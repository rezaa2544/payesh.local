#!/usr/bin/env node
/* Row 107 — shared test vectors for e2e1 (JS reference ⇄ Dart port).

   Every "random" input is derived from SHA-256 of a label, so the output is
   byte-deterministic. The JS test (tests/e2e1-107.js) regenerates and diffs;
   the Dart test (payesh_secure/test/e2e1_test.dart) must reproduce every
   derived key and every sealed envelope exactly, and open/refuse the same way.

   Usage: node tools/e2e1-vectors-107.mjs            write the file
          node tools/e2e1-vectors-107.mjs --check    exit 1 if the file differs
*/
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const e2e = require('./e2e1.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FILE = path.join(ROOT, 'docs/cloud/contracts/e2e1-vectors-107.json');

const seed = (label, n = 32) => crypto.createHash('sha256').update('payesh/e2e1/vector|' + label).digest().subarray(0, n);
const h = b => Buffer.from(b).toString('hex');
const B = e2e.b64u;

export function build() {
  const tenant = '0b7e6a52-3f0c-4c1e-9a55-2f1d7c0e9a01';
  const other = '5d1c0f7e-8a2b-4e3d-b6c4-91a0f2e7d302';
  const smk = seed('smk-1');
  const scopes = [
    ['smk', 1, 0], ['school:attendance', 1, 0], ['class:7:attendance', 1, 0],
    ['class:7:attendance', 1, 1], ['student:42:attendance', 1, 0], ['smk', 2, 0], ['class:7:attendance', 2, 0],
  ];
  const keys = scopes.map(([s, sg, g]) => e2e.deriveScopeKey(smk, tenant, s, sg, g));
  const byKid = new Map(keys.map(k => [k.kid, k]));
  const dir = new Map([['smk', byKid.get('smk@1+0')], ['school:attendance', byKid.get('school:attendance@1+0')],
    ['class:7:attendance', byKid.get('class:7:attendance@1+1')], ['student:42:attendance', byKid.get('student:42:attendance@1+0')]]);

  /* the canary is what the dump test greps for: it must never reach the database in clear */
  const payload = { student: 42, status: 'absent', note: 'غیبت موجه — گواهی پزشک', national_id: 'CANARY-0012345678' };
  const meta = { tenant_id: tenant, collection: 'attendance', record_id: 9001, version: 3, class_id: 7, student_id: 42 };
  const fixed = { eph: seed('rec-eph'), dek: seed('rec-dek'), iv: seed('rec-iv', 12), wrapIvs: [0, 1, 2, 3].map(i => seed('rec-wiv-' + i, 12)) };
  const plaintext = JSON.stringify(payload);
  const sealed = e2e.sealRecord(meta, payload, dir, fixed);
  const aad = e2e.recordAad(tenant, 'attendance', 9001, 3);

  const dev = e2e.keyPairFromPrivate(seed('device-1'));
  const deviceId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const classKey = byKid.get('class:7:attendance@1+1');
  const gfixed = { eph: seed('grant-eph'), dek: seed('grant-dek'), iv: seed('grant-iv', 12), wrapIvs: [seed('grant-wiv', 12)] };
  const grant = e2e.sealGrant(dev.pub, tenant, deviceId, classKey.kid, classKey.priv, gfixed);
  const smkGrant = e2e.sealGrant(dev.pub, tenant, deviceId, 'smk@1+0', smk,
    { eph: seed('sgrant-eph'), dek: seed('sgrant-dek'), iv: seed('sgrant-iv', 12), wrapIvs: [seed('sgrant-wiv', 12)] });

  const k = kid => ({ kid, priv: B(byKid.get(kid).priv) });
  const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
  const parts = sealed.split('.');
  const bodyAt = parts[0].length + parts[1].length + parts[2].length + 3 + 5;
  const opens = [
    { why: 'manager via the smk scope', key: k('smk@1+0'), aad, plaintext },
    { why: 'school-wide attendance reader', key: k('school:attendance@1+0'), aad, plaintext },
    { why: 'class 7 teacher (current generation 1+1)', key: k('class:7:attendance@1+1'), aad, plaintext },
    { why: 'parent of student 42', key: k('student:42:attendance@1+0'), aad, plaintext },
  ];
  const negatives = [
    { name: 'moved_row', why: 'same ciphertext presented as record 9002', envelope: sealed, aad: e2e.recordAad(tenant, 'attendance', 9002, 3), key: k('class:7:attendance@1+1'), expect: 'e2e_open_failed' },
    { name: 'other_version', why: 'version 3 ciphertext presented as version 4', envelope: sealed, aad: e2e.recordAad(tenant, 'attendance', 9001, 4), key: k('class:7:attendance@1+1'), expect: 'e2e_open_failed' },
    { name: 'other_school', why: 'copied into another tenant', envelope: sealed, aad: e2e.recordAad(other, 'attendance', 9001, 3), key: k('smk@1+0'), expect: 'e2e_open_failed' },
    { name: 'other_collection', why: 'copied into grades', envelope: sealed, aad: e2e.recordAad(tenant, 'grades', 9001, 3), key: k('student:42:attendance@1+0'), expect: 'e2e_open_failed' },
    { name: 'tampered_body', why: 'one base64url char of the body changed', envelope: flip(sealed, bodyAt), aad, key: k('class:7:attendance@1+1'), expect: 'e2e_open_failed' },
    { name: 'rotated_out', why: 'the previous class key generation (1+0) after rotation', envelope: sealed, aad, key: k('class:7:attendance@1+0'), expect: 'e2e_no_key' },
    { name: 'wrong_key_same_kid', why: 'a different private key under the right kid', envelope: sealed, aad, key: { kid: 'class:7:attendance@1+1', priv: B(byKid.get('class:7:attendance@2+0').priv) }, expect: 'e2e_open_failed' },
    { name: 'bad_format', why: 'truncated envelope', envelope: parts.slice(0, 3).join('.'), aad, key: k('smk@1+0'), expect: 'e2e_bad_format' },
  ];
  const grantNegatives = [
    { name: 'grant_other_device', why: 'grant replayed for another device id', envelope: grant, device_id: 'a3bb189e-8bf9-4888-9912-ace4e6543002', kid: classKey.kid, expect: 'e2e_open_failed' },
    { name: 'grant_other_kid', why: 'grant presented as the student scope key', envelope: grant, device_id: deviceId, kid: 'student:42:attendance@1+0', expect: 'e2e_open_failed' },
  ];

  return {
    _doc: 'Row 107 — e2e1 shared vectors (generated by tools/e2e1-vectors-107.mjs; do not edit). Binary values are base64url without padding unless the key ends in _hex. JS: tests/e2e1-107.js. Dart: apps/payesh/packages/payesh_secure/test/e2e1_test.dart.',
    version: e2e.VERSION,
    x25519_rfc7748: {
      alice_priv_hex: '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a',
      alice_pub_hex: '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a',
      bob_priv_hex: '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb',
      bob_pub_hex: 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f',
      shared_hex: '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742',
    },
    scope_keys: keys.map(x => ({ tenant, smk: B(smk), scope: x.scope, smk_gen: x.smkGen, gen: x.gen, kid: x.kid, priv: B(x.priv), pub: B(x.pub) })),
    record: {
      meta, plaintext, aad,
      recipients: [...dir.values()].map(x => ({ kid: x.kid, pub: B(x.pub) })),
      fixed: { eph: B(fixed.eph), dek: B(fixed.dek), iv: B(fixed.iv), wrap_ivs: fixed.wrapIvs.map(B) },
      sealed, opens, negatives,
    },
    grant: {
      tenant, device_id: deviceId, device_priv: B(dev.priv), device_pub: B(dev.pub),
      kid: classKey.kid, secret: B(classKey.priv), aad: e2e.grantAad(tenant, deviceId, classKey.kid),
      fixed: { eph: B(gfixed.eph), dek: B(gfixed.dek), iv: B(gfixed.iv), wrap_ivs: gfixed.wrapIvs.map(B) },
      sealed: grant, negatives: grantNegatives,
      smk_grant: { kid: 'smk@1+0', secret: B(smk), sealed: smkGrant,
        fixed: { eph: B(seed('sgrant-eph')), dek: B(seed('sgrant-dek')), iv: B(seed('sgrant-iv', 12)), wrap_ivs: [B(seed('sgrant-wiv', 12))] } },
    },
    _check: { smk_hex_sha256: h(crypto.createHash('sha256').update(smk).digest()) },
  };
}

export function render() { return JSON.stringify(build(), null, 2) + '\n'; }

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('e2e1-vectors-107.mjs')) {
  const text = render();
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : '';
    if (cur !== text) { console.log('E2E1-VECTORS-107-STALE ' + path.relative(ROOT, FILE)); process.exit(1); }
    console.log('E2E1-VECTORS-107-OK ' + path.relative(ROOT, FILE));
  } else {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, text);
    console.log('wrote ' + path.relative(ROOT, FILE));
  }
}
