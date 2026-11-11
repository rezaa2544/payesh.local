'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 107 (ADR-105 §3.2, Proposed) — device-side end-to-end encryption
   "e2e1": reference implementation in JavaScript (Node ≥ 20, node:crypto
   only). The Dart port is apps/payesh/packages/payesh_secure/lib/src/e2e1.dart;
   both must reproduce docs/cloud/contracts/e2e1-vectors-107.json byte for byte.

   Primitives (all standard, no custom crypto):
     X25519 (RFC 7748) · HKDF-SHA256 (RFC 5869) · AES-256-GCM (96-bit IV, 128-bit tag)

   Key hierarchy (the database only ever sees public keys and ciphertext):
     SMK        32 random bytes per school and generation (smk_gen). Lives only
                on manager devices, sealed to each manager device (key_grant).
     scope key  X25519 key pair DERIVED from the SMK:
                  priv = HKDF(ikm=SMK, salt="payesh/e2e1",
                              info="payesh/e2e1/scope|<tenant>|<scope>|<smk_gen>|<gen>")
                scope = smk | school:<collection> | class:<id>:<collection>
                        | student:<id>:<collection>
                The public half is published (scope_key table) so ANY writer can
                encrypt to a scope; only holders of the private half can read.
                kid = "<scope>@<smk_gen>+<gen>". Rotation = gen+1 (one scope) or
                smk_gen+1 (everything); a revoked holder cannot derive the new key.
     device key X25519 key pair generated on the device; private half stays in
                the device's secure store (row 72), public half is registered.

   Record envelope (one random DEK per record version):
     body = AES-GCM(DEK, iv, plaintext, AAD)
     AAD  = "payesh/e2e1|<tenant>|<collection>|<record_id>|<version>"
     for every recipient scope:  ss  = X25519(eph_priv, scope_pub)
                                 kek = HKDF(ss, salt=eph_pub||scope_pub,
                                            info="payesh/e2e1/wrap|<kid>|<AAD>")
                                 w   = AES-GCM(kek, iv_w, DEK, aad=kid)
     text: e2e1.<eph_pub>.<iv>.<body>.<kid>!<iv_w>!<w>~<kid>!<iv_w>!<w>…   (base64url)
   Because AAD is bound into the body AND every wrap, a ciphertext copied to
   another row, another school, another collection or another version does
   not open (fails closed with a single error code, no oracle detail).

   Key grant: the same envelope with one recipient (the device public key,
   kid "device"), AAD "payesh/e2e1/grant|<tenant>|<device_id>|<granted kid>",
   plaintext = the scope private key (or the SMK for scope "smk").

   Recovery of lost keys (password / paper backup / support grant) is an owner
   decision (row 105); it plugs in as another recipient and is NOT part of e2e1.
   ═══════════════════════════════════════════════════════════════════ */
const crypto = require('node:crypto');

const VERSION = 'e2e1';
const SALT = Buffer.from('payesh/e2e1');
const SCOPE_RE = /^(smk|school:[a-z_]{1,40}|class:[0-9]{1,18}:[a-z_]{1,40}|student:[0-9]{1,18}:[a-z_]{1,40})$/;
const KID_RE = /^(smk|school:[a-z_]{1,40}|class:[0-9]{1,18}:[a-z_]{1,40}|student:[0-9]{1,18}:[a-z_]{1,40})@[0-9]{1,9}\+[0-9]{1,9}$|^device$/;
const B64U_RE = /^[A-Za-z0-9_-]*$/;

class E2EError extends Error {
  constructor(code, detail) { super(code + (detail ? ': ' + detail : '')); this.code = code; }
}

function b64u(buf) { return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function unb64u(s, len) {
  if (typeof s !== 'string' || !B64U_RE.test(s)) throw new E2EError('e2e_bad_format', 'base64url');
  const b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (b64u(b) !== s) throw new E2EError('e2e_bad_format', 'non-canonical base64url');
  if (len !== undefined && b.length !== len) throw new E2EError('e2e_bad_format', `expected ${len} bytes`);
  return b;
}

/* ── X25519 with raw 32-byte keys (DER wrappers per RFC 8410) ────────── */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
function privKeyObject(priv) {
  if (!Buffer.isBuffer(priv) || priv.length !== 32) throw new E2EError('e2e_bad_key', 'private key must be 32 bytes');
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, priv]), format: 'der', type: 'pkcs8' });
}
function pubKeyObject(pub) {
  if (!Buffer.isBuffer(pub) || pub.length !== 32) throw new E2EError('e2e_bad_key', 'public key must be 32 bytes');
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pub]), format: 'der', type: 'spki' });
}
function publicFromPrivate(priv) {
  const der = crypto.createPublicKey(privKeyObject(priv)).export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(der.length - 32));
}
function keyPairFromPrivate(priv) { return { priv: Buffer.from(priv), pub: publicFromPrivate(priv) }; }
function generateKeyPair() { return keyPairFromPrivate(crypto.randomBytes(32)); }
function x25519(priv, pub) {
  let ss;
  /* OpenSSL itself refuses some low-order points (ERR_OSSL_FAILED_DURING_DERIVATION) */
  try { ss = crypto.diffieHellman({ privateKey: privKeyObject(priv), publicKey: pubKeyObject(pub) }); } catch (e) {
    if (e instanceof E2EError) throw e;
    throw new E2EError('e2e_bad_key', 'X25519 derivation failed');
  }
  /* RFC 7748 §6.1: an all-zero shared secret means a low-order public key */
  if (ss.every(b => b === 0)) throw new E2EError('e2e_bad_key', 'low-order public key');
  return ss;
}
function hkdf(ikm, salt, info) { return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), 32)); }

function gcmSeal(key, iv, pt, aad) {
  const c = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(aad, 'utf8'));
  return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
}
function gcmOpen(key, iv, ct, aad) {
  if (ct.length < 16) throw new E2EError('e2e_open_failed');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(ct.subarray(ct.length - 16));
    return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  } catch { throw new E2EError('e2e_open_failed'); }
}

/* ── scope keys ─────────────────────────────────────────────────────── */
function scopeName(kind, collection, id) {
  let s;
  if (kind === 'smk') s = 'smk';
  else if (kind === 'school') s = `school:${collection}`;
  else if (kind === 'class' || kind === 'student') s = `${kind}:${id}:${collection}`;
  else throw new E2EError('e2e_bad_scope', String(kind));
  if (!SCOPE_RE.test(s)) throw new E2EError('e2e_bad_scope', s);
  return s;
}
function kidOf(scope, smkGen, gen) {
  const k = `${scope}@${smkGen}+${gen}`;
  if (!KID_RE.test(k) || !Number.isInteger(smkGen) || !Number.isInteger(gen) || smkGen < 1 || gen < 0) throw new E2EError('e2e_bad_scope', k);
  return k;
}
function parseKid(kid) {
  if (!KID_RE.test(kid) || kid === 'device') throw new E2EError('e2e_bad_scope', kid);
  const at = kid.lastIndexOf('@'); const plus = kid.lastIndexOf('+');
  return { scope: kid.slice(0, at), smkGen: Number(kid.slice(at + 1, plus)), gen: Number(kid.slice(plus + 1)) };
}
function newSmk() { return crypto.randomBytes(32); }
/* derive the X25519 key pair of one scope generation from the school master key */
function deriveScopeKey(smk, tenant, scope, smkGen, gen) {
  if (!Buffer.isBuffer(smk) || smk.length !== 32) throw new E2EError('e2e_bad_key', 'SMK must be 32 bytes');
  const kid = kidOf(scope, smkGen, gen);
  const priv = hkdf(smk, SALT, `payesh/e2e1/scope|${tenant}|${scope}|${smkGen}|${gen}`);
  return Object.assign({ kid, scope, smkGen, gen }, keyPairFromPrivate(priv));
}

/* ── envelope ───────────────────────────────────────────────────────── */
/* recipients: [{ kid, pub }]; fixed: { eph, dek, iv, wrapIvs[] } only for test vectors */
function seal(recipients, plaintext, aad, fixed = {}) {
  if (!Array.isArray(recipients) || recipients.length === 0) throw new E2EError('e2e_no_recipient');
  const pt = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  const eph = fixed.eph ? keyPairFromPrivate(fixed.eph) : generateKeyPair();
  const dek = fixed.dek || crypto.randomBytes(32);
  const iv = fixed.iv || crypto.randomBytes(12);
  const body = gcmSeal(dek, iv, pt, aad);
  const seen = new Set();
  const wraps = recipients.map((r, i) => {
    if (!KID_RE.test(r.kid) || seen.has(r.kid)) throw new E2EError('e2e_bad_scope', 'recipient ' + r.kid);
    seen.add(r.kid);
    const pub = Buffer.isBuffer(r.pub) ? r.pub : unb64u(r.pub, 32);
    const kek = hkdf(x25519(eph.priv, pub), Buffer.concat([eph.pub, pub]), `payesh/e2e1/wrap|${r.kid}|${aad}`);
    const wiv = (fixed.wrapIvs && fixed.wrapIvs[i]) || crypto.randomBytes(12);
    return `${r.kid}!${b64u(wiv)}!${b64u(gcmSeal(kek, wiv, dek, r.kid))}`;
  });
  return `${VERSION}.${b64u(eph.pub)}.${b64u(iv)}.${b64u(body)}.${wraps.join('~')}`;
}
function parse(text) {
  if (typeof text !== 'string' || text.length > 1048576) throw new E2EError('e2e_bad_format');
  const p = text.split('.');
  if (p.length !== 5 || p[0] !== VERSION) throw new E2EError('e2e_bad_format', 'header');
  const wraps = p[4].split('~').map(w => {
    const q = w.split('!');
    if (q.length !== 3 || !KID_RE.test(q[0])) throw new E2EError('e2e_bad_format', 'wrap');
    return { kid: q[0], iv: unb64u(q[1], 12), ct: unb64u(q[2], 48) };
  });
  return { ephPub: unb64u(p[1], 32), iv: unb64u(p[2], 12), body: unb64u(p[3]), wraps };
}
/* the kids an envelope is readable with (routing only — not authenticated by itself) */
function recipientsOf(text) { return parse(text).wraps.map(w => w.kid); }
/* keys: Map kid → private key (Buffer). Returns the plaintext Buffer. */
function open(text, keys, aad) {
  const e = parse(text);
  for (const w of e.wraps) {
    const priv = keys.get(w.kid);
    if (!priv) continue;
    const pub = publicFromPrivate(priv);
    const kek = hkdf(x25519(priv, e.ephPub), Buffer.concat([e.ephPub, pub]), `payesh/e2e1/wrap|${w.kid}|${aad}`);
    const dek = gcmOpen(kek, w.iv, w.ct, w.kid);
    return gcmOpen(dek, e.iv, e.body, aad);
  }
  throw new E2EError('e2e_no_key');
}

/* ── records ────────────────────────────────────────────────────────── */
function recordAad(tenant, collection, recordId, version) {
  if (!/^[0-9a-f-]{36}$/.test(tenant) || !/^[a-z_]{1,40}$/.test(collection) || !(Number(recordId) > 0) || !(Number(version) > 0)) {
    throw new E2EError('e2e_bad_record', 'routing metadata');
  }
  return `payesh/e2e1|${tenant}|${collection}|${recordId}|${version}`;
}
/* which scopes a record is sealed to: managers (smk), school-wide readers of the
   collection, the class and the student it belongs to */
function recordScopes(meta) {
  const s = [scopeName('smk'), scopeName('school', meta.collection)];
  if (meta.class_id != null) s.push(scopeName('class', meta.collection, meta.class_id));
  if (meta.student_id != null) s.push(scopeName('student', meta.collection, meta.student_id));
  return s;
}
/* directory: Map scope → { kid, pub } (the CURRENT generation, from scope_key).
   The smk scope is mandatory (managers can always read and recover). Any other
   scope without a published key is skipped — fail-closed: that audience reads
   nothing until a manager publishes its key and re-seals the row. */
function sealRecord(meta, payload, directory, fixed) {
  const recipients = [];
  for (const sc of recordScopes(meta)) {
    const k = directory.get(sc);
    if (!k) { if (sc === 'smk') throw new E2EError('e2e_no_scope_key', sc); continue; }
    recipients.push({ kid: k.kid, pub: k.pub });
  }
  return seal(recipients, Buffer.from(JSON.stringify(payload), 'utf8'),
    recordAad(meta.tenant_id, meta.collection, meta.record_id, meta.version), fixed);
}
function openRecord(row, keys) {
  const pt = open(row.sealed, keys, recordAad(row.tenant_id, row.collection, row.record_id, row.version));
  return JSON.parse(pt.toString('utf8'));
}

/* ── key grants ─────────────────────────────────────────────────────── */
function grantAad(tenant, deviceId, kid) { return `payesh/e2e1/grant|${tenant}|${deviceId}|${kid}`; }
function sealGrant(devicePub, tenant, deviceId, kid, secret, fixed) {
  if (!Buffer.isBuffer(secret) || secret.length !== 32) throw new E2EError('e2e_bad_key', 'granted secret must be 32 bytes');
  parseKid(kid);
  return seal([{ kid: 'device', pub: devicePub }], secret, grantAad(tenant, deviceId, kid), fixed);
}
function openGrant(text, devicePriv, tenant, deviceId, kid) {
  const s = open(text, new Map([['device', devicePriv]]), grantAad(tenant, deviceId, kid));
  if (s.length !== 32) throw new E2EError('e2e_open_failed');
  return s;
}

/* A keyring built from opened grants: an SMK grant yields every scope key of
   that SMK generation on demand; a scope grant yields exactly that key. */
class Keyring {
  constructor(tenant) { this.tenant = tenant; this.smk = new Map(); this.keys = new Map(); }
  addGrant(kid, secret) {
    const k = parseKid(kid);
    if (k.scope === 'smk') { this.smk.set(k.smkGen, secret); this.keys.set(kid, deriveScopeKey(secret, this.tenant, 'smk', k.smkGen, k.gen).priv); }
    else this.keys.set(kid, secret);
  }
  /* Map kid → priv covering every kid of the envelope we can reach */
  forEnvelope(text) {
    const out = new Map();
    for (const kid of recipientsOf(text)) {
      if (kid === 'device') continue;
      if (this.keys.has(kid)) { out.set(kid, this.keys.get(kid)); continue; }
      const k = parseKid(kid);
      const smk = this.smk.get(k.smkGen);
      if (smk) out.set(kid, deriveScopeKey(smk, this.tenant, k.scope, k.smkGen, k.gen).priv);
    }
    return out;
  }
  openRecord(row) { return openRecord(row, this.forEnvelope(row.sealed)); }
}

module.exports = {
  VERSION, E2EError, b64u, unb64u, generateKeyPair, keyPairFromPrivate, publicFromPrivate, x25519, hkdf,
  scopeName, kidOf, parseKid, newSmk, deriveScopeKey, seal, open, parse, recipientsOf,
  recordAad, recordScopes, sealRecord, openRecord, grantAad, sealGrant, openGrant, Keyring,
};
