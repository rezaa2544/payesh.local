#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   Row 78 — publisher tool for the signed native auto-update.
   Dart side: apps/payesh/packages/payesh_secure/lib/src/native_update.dart
   Doc:       docs/cloud/78-native-auto-update.md

   envelope = { format:"payesh-update-envelope/1", key_id, manifest_b64, sig_b64 }
   sig      = Ed25519(publisher private key, raw manifest bytes)

   node tools/native-update-78.mjs keygen --out <dir OUTSIDE the repo>
        → <dir>/payesh-update-signing.pem (0600) ; prints key_id + public key (base64)
   node tools/native-update-78.mjs sign --key <pem> --manifest <json> [--out <envelope.json>]
   node tools/native-update-78.mjs verify --pub <base64> --envelope <file>
        [--channel pilot] [--platform android] [--installed N] [--highest N] [--now ISO]
   node tools/native-update-78.mjs vectors [--check]
        → docs/cloud/contracts/native-update-vectors-78.json (TEST key only, deterministic)

   The publisher private key belongs to the OWNER. It never enters the repository:
   keygen refuses a target inside a Git work tree, and the static test of row 78
   scans the app and the repo for private keys.
   ═══════════════════════════════════════════════════════════════════ */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENVELOPE_FORMAT = 'payesh-update-envelope/1';
export const MANIFEST_SCHEMA = 'payesh-native-update/1';
export const MAX_ARTIFACT = 512 * 1024 * 1024;
const CHANNELS = ['stable', 'pilot', 'beta'];
const PLATFORMS = ['android', 'windows'];
const VECTORS = path.join(ROOT, 'docs/cloud/contracts/native-update-vectors-78.json');

export class UpdateError extends Error { constructor(code, detail = '') { super(detail ? `${code}: ${detail}` : code); this.code = code; } }
const bad = (d, code = 'upd_bad_manifest') => { throw new UpdateError(code, d); };

function closed(o, keys, what, code = 'upd_bad_manifest') {
  if (!o || typeof o !== 'object' || Array.isArray(o)) bad(`${what}: not an object`, code);
  const extra = Object.keys(o).filter(k => !keys.includes(k));
  if (extra.length) bad(`${what}: unknown ${extra}`, code);
  const miss = keys.filter(k => !(k in o));
  if (miss.length) bad(`${what}: missing ${miss}`, code);
  return o;
}
const str = (v, w) => (typeof v === 'string' && v ? v : bad(w));
const time = (v, w) => { const s = str(v, w); const t = Date.parse(s); if (!s.endsWith('Z') || Number.isNaN(t)) bad(w); return t; };

/** Same rules as UpdateManifest.parse (Dart). */
export function parseManifest(o) {
  const m = closed(o, ['schema', 'channel', 'version', 'build', 'published_at', 'expires_at', 'halt', 'artifacts'], 'manifest');
  if (m.schema !== MANIFEST_SCHEMA) bad('schema');
  if (!CHANNELS.includes(m.channel)) bad('channel');
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(str(m.version, 'version'))) bad('version');
  if (!Number.isInteger(m.build) || m.build <= 0) bad('build');
  const pub = time(m.published_at, 'published_at'), exp = time(m.expires_at, 'expires_at');
  if (exp <= pub) bad('expires_at <= published_at');
  if (typeof m.halt !== 'boolean') bad('halt');
  if (!m.artifacts || typeof m.artifacts !== 'object' || Array.isArray(m.artifacts)) bad('artifacts');
  for (const [k, a] of Object.entries(m.artifacts)) {
    if (!PLATFORMS.includes(k)) bad(`artifacts key: ${k}`);
    closed(a, ['url', 'sha256', 'size'], 'artifact');
    let u; try { u = new URL(str(a.url, 'artifact.url')); } catch { bad('artifact.url must be https'); }
    if (u.protocol !== 'https:' || !u.hostname) bad('artifact.url must be https');
    if (!/^[0-9a-f]{64}$/.test(String(a.sha256))) bad('artifact.sha256');
    if (!Number.isInteger(a.size) || a.size <= 0 || a.size > MAX_ARTIFACT) bad('artifact.size');
  }
  return { ...m, expiresMs: exp };
}

export function keyIdOf(rawPub) { return crypto.createHash('sha256').update(rawPub).digest('hex').slice(0, 16); }
export function privateFromSeed(seed) {
  return crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
}
export function rawPublic(key) { return Buffer.from(crypto.createPublicKey(key).export({ format: 'jwk' }).x, 'base64url'); }

/** Sign the exact bytes of a manifest object (compact JSON). */
export function sign(privateKey, manifestObj) {
  parseManifest(manifestObj);
  const body = Buffer.from(JSON.stringify(manifestObj), 'utf8');
  return envelope(privateKey, body);
}
function envelope(privateKey, body, kidOverride) {
  return {
    format: ENVELOPE_FORMAT,
    key_id: kidOverride || keyIdOf(rawPublic(privateKey)),
    manifest_b64: body.toString('base64'),
    sig_b64: crypto.sign(null, body, privateKey).toString('base64'),
  };
}

/** Same decision as UpdateVerifier.evaluate (Dart). keys: { key_id: rawPub }. */
export function evaluate(envBytes, { keys, channel, platform, installed, highest, now }) {
  try {
    let env;
    try { env = JSON.parse(Buffer.from(envBytes).toString('utf8')); } catch { bad('not JSON', 'upd_bad_envelope'); }
    closed(env, ['format', 'key_id', 'manifest_b64', 'sig_b64'], 'envelope', 'upd_bad_envelope');
    if (env.format !== ENVELOPE_FORMAT) bad('format', 'upd_bad_envelope');
    const pub = typeof env.key_id === 'string' ? keys[env.key_id] : null;
    if (!pub) bad(String(env.key_id), 'upd_unknown_key');
    if (typeof env.manifest_b64 !== 'string' || typeof env.sig_b64 !== 'string') bad('fields', 'upd_bad_envelope');
    const body = Buffer.from(env.manifest_b64, 'base64'), sig = Buffer.from(env.sig_b64, 'base64');
    if (sig.length !== 64) bad('length', 'upd_bad_signature');
    const pk = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(pub).toString('base64url') }, format: 'jwk' });
    if (!crypto.verify(null, body, pk, sig)) bad('', 'upd_bad_signature');
    let mo; try { mo = JSON.parse(body.toString('utf8')); } catch { bad('not JSON'); }
    const m = parseManifest(mo);
    if (m.channel !== channel) bad(m.channel, 'upd_wrong_channel');
    if (Date.parse(now) >= m.expiresMs) bad('', 'upd_expired');
    if (m.halt) return { decision: 'halted', reason: 'publisher_halt' };
    const floor = Math.max(installed, highest);
    if (m.build < floor) bad(`${m.build} < ${floor}`, 'upd_rollback');
    if (m.build <= installed) return { decision: 'up_to_date' };
    const a = m.artifacts[platform];
    if (!a) bad(platform, 'upd_no_artifact');
    return { decision: 'available', build: m.build, artifact: a };
  } catch (e) {
    if (e instanceof UpdateError) return { decision: 'refused', code: e.code };
    throw e;
  }
}

/* ── deterministic vectors (TEST key — derived from a public label, worthless) ── */
export function buildVectors() {
  const seed = crypto.createHash('sha256').update('payesh-row78-TEST-ONLY-publisher-key — not a secret').digest();
  const other = crypto.createHash('sha256').update('payesh-row78-TEST-ONLY-attacker-key').digest();
  const key = privateFromSeed(seed), atk = privateFromSeed(other);
  const pub = rawPublic(key), kid = keyIdOf(pub);
  const artifact = Buffer.from('payesh row 78 test artifact\n'.repeat(64), 'utf8');
  const sha = crypto.createHash('sha256').update(artifact).digest('hex');
  const art = { url: 'https://dl.payeshschool.ir/native/payesh-0.2.0+58.apk', sha256: sha, size: artifact.length };
  const base = {
    schema: MANIFEST_SCHEMA, channel: 'pilot', version: '0.2.0', build: 58,
    published_at: '2026-11-10T00:00:00Z', expires_at: '2026-12-10T00:00:00Z', halt: false,
    artifacts: { android: art, windows: { ...art, url: 'https://dl.payeshschool.ir/native/payesh-setup-0.2.0+58.exe' } },
  };
  const raw = (o) => Buffer.from(JSON.stringify(o), 'utf8');
  const signedRaw = (o, k = key, kidO) => envelope(k, raw(o), kidO);
  const tampered = (() => { const e = signedRaw(base); const m = JSON.parse(Buffer.from(e.manifest_b64, 'base64')); m.build = 99; return { ...e, manifest_b64: raw(m).toString('base64') }; })();
  const cases = [
    ['NUV-01', 'valid pilot manifest, newer build', signedRaw(base), 'available'],
    ['NUV-02', 'same build as installed', signedRaw({ ...base, build: 57 }), 'up_to_date'],
    ['NUV-03', 'older build (downgrade / replay of an old release)', signedRaw({ ...base, build: 50 }), 'refused:upd_rollback'],
    ['NUV-04', 'manifest changed after signing (build 99)', tampered, 'refused:upd_bad_signature'],
    ['NUV-05', 'signed by an unknown key', signedRaw(base, atk), 'refused:upd_unknown_key'],
    ['NUV-06', 'attacker key presented under the pinned key_id', signedRaw(base, atk, kid), 'refused:upd_bad_signature'],
    ['NUV-07', 'expired manifest (frozen mirror)', signedRaw({ ...base, published_at: '2026-10-01T00:00:00Z', expires_at: '2026-11-01T00:00:00Z' }), 'refused:upd_expired'],
    ['NUV-08', 'other channel (stable) on a pilot device', signedRaw({ ...base, channel: 'stable' }), 'refused:upd_wrong_channel'],
    ['NUV-09', 'publisher kill-switch (halt)', signedRaw({ ...base, halt: true }), 'halted:publisher_halt'],
    ['NUV-10', 'unknown field in the signed manifest', signedRaw({ ...base, mandatory_now: true }), 'refused:upd_bad_manifest'],
    ['NUV-11', 'plain-http artifact URL', signedRaw({ ...base, artifacts: { android: { ...art, url: 'http://dl.payeshschool.ir/a.apk' } } }), 'refused:upd_bad_manifest'],
    ['NUV-12', 'no artifact for this platform', signedRaw({ ...base, artifacts: { windows: base.artifacts.windows } }), 'refused:upd_no_artifact'],
    ['NUV-13', 'envelope is not JSON', null, 'refused:upd_bad_envelope'],
    ['NUV-14', 'truncated signature', { ...signedRaw(base), sig_b64: signedRaw(base).sig_b64.slice(0, 40) }, 'refused:upd_bad_signature'],
  ].map(([id, title, env, expect]) => ({ id, title, envelope_text: env === null ? 'not json {' : JSON.stringify(env), expect }));
  return {
    _comment: 'Row 78 test vectors. The key below is a TEST key derived from a public label — it signs nothing real. Generated by tools/native-update-78.mjs vectors.',
    test_key_id: kid,
    test_public_key_b64: pub.toString('base64'),
    device: { channel: 'pilot', platform: 'android', installed_build: 57, highest_seen_build: 57, now: '2026-11-15T00:00:00Z' },
    artifact_b64: artifact.toString('base64'),
    artifact_sha256: sha,
    cases,
  };
}

/* ── CLI ─────────────────────────────────────────────────────────── */
function insideGit(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === 'true';
}
function arg(a, k) { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; }

function main(argv) {
  const [cmd, ...a] = argv;
  if (cmd === 'vectors') {
    const text = JSON.stringify(buildVectors(), null, 2) + '\n';
    if (a.includes('--check')) {
      const cur = fs.existsSync(VECTORS) ? fs.readFileSync(VECTORS, 'utf8') : '';
      if (cur !== text) { console.error('NATIVE-UPDATE-78 vectors out of date: run node tools/native-update-78.mjs vectors'); return 1; }
      console.log('NATIVE-UPDATE-78 vectors up to date'); return 0;
    }
    fs.writeFileSync(VECTORS, text); console.log('wrote', path.relative(ROOT, VECTORS)); return 0;
  }
  if (cmd === 'keygen') {
    const out = arg(a, '--out');
    if (!out) { console.error('usage: keygen --out <dir outside the repository>'); return 2; }
    fs.mkdirSync(out, { recursive: true });
    if (insideGit(out)) { console.error('refused: --out is inside a Git work tree; the publisher key must never be committed'); return 2; }
    const f = path.join(out, 'payesh-update-signing.pem');
    if (fs.existsSync(f)) { console.error(`refused: ${f} exists (never overwrite a publisher key)`); return 2; }
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(f, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    const pub = rawPublic(privateKey);
    console.log(JSON.stringify({ key_id: keyIdOf(pub), public_key_b64: pub.toString('base64'), private_key_file: f }));
    return 0;
  }
  if (cmd === 'sign') {
    const k = arg(a, '--key'), m = arg(a, '--manifest');
    if (!k || !m) { console.error('usage: sign --key <pem> --manifest <json> [--out f]'); return 2; }
    try {
      const env = sign(crypto.createPrivateKey(fs.readFileSync(k)), JSON.parse(fs.readFileSync(m, 'utf8')));
      const text = JSON.stringify(env) + '\n';
      const out = arg(a, '--out'); if (out) fs.writeFileSync(out, text); else process.stdout.write(text);
      return 0;
    } catch (e) { console.error('refused:', e.message); return 1; }
  }
  if (cmd === 'verify') {
    const p = arg(a, '--pub'), e = arg(a, '--envelope');
    if (!p || !e) { console.error('usage: verify --pub <b64> --envelope <file>'); return 2; }
    const pub = Buffer.from(p, 'base64');
    const r = evaluate(fs.readFileSync(e), {
      keys: { [keyIdOf(pub)]: pub }, channel: arg(a, '--channel') || 'pilot', platform: arg(a, '--platform') || 'android',
      installed: Number(arg(a, '--installed') || 0), highest: Number(arg(a, '--highest') || 0), now: arg(a, '--now') || new Date().toISOString(),
    });
    console.log(JSON.stringify(r)); return r.decision === 'refused' ? 1 : 0;
  }
  console.error('usage: native-update-78.mjs keygen|sign|verify|vectors'); return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
