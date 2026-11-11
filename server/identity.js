'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 65 — device identity for the school server (SQLite)
   Contract: docs/cloud/contracts/native-api-v1.md §7 · ADR: docs/cloud/65-device-identity.md

   1) Access token (sessions.token_hash) is SHORT-LIVED: PAYESH_ACCESS_TTL_MIN (default 15)
      with no sliding extension. Clients renew it with the refresh token.
   2) Refresh token (= device_token) ROTATES on every use. Each token is one row of
      device_tokens (hash only, never the raw token). Presenting a rotated token again:
        - within PAYESH_REFRESH_GRACE_SEC (default 30) → the same successor is returned
          (two tabs / a retry after a lost response must not log the user out);
        - after that → REUSE: the whole chain (device + every session) is revoked,
          audited as refresh_reuse_detected, and the caller gets device_revoked + wipe.
   3) Optional device public key (P-256 or Ed25519, SPKI DER base64) bound at login/pair/
      transfer. A bound device must prove possession on refresh: signature over
      "payesh-refresh-v1\n<device_id>\n<ts>\n<sha256(device_token)>" with ts strictly
      increasing (replay-proof) and within PAYESH_PROOF_SKEW_SEC. A stolen device_token
      without the private key is useless, and cannot even trigger the reuse revocation.
   4) Per-user device cap PAYESH_DEVICE_CAP (default 10). Devices not seen for
      PAYESH_DEVICE_STALE_DAYS (default 30) are retired first; then a new device is
      refused with device_limit (409) — a stolen password cannot evict real devices.
   5) Everything is audited (device_login, refresh_rotate, refresh_grace,
      refresh_reuse_detected, refresh_bad_proof, device_limit, device_stale_revoked,
      device_revoke, revoke_all_devices). No raw token or key material is logged.
   ═══════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const { nowISO, sha256, randomId } = require('./util');

function intEnv(name, def, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Math.trunc(Number(raw));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}
function config() {
  return {
    accessTtlMin: intEnv('PAYESH_ACCESS_TTL_MIN', 15, 1, 24 * 60),
    graceSec: intEnv('PAYESH_REFRESH_GRACE_SEC', 30, 0, 300),
    deviceDays: intEnv('PAYESH_DEVICE_DAYS', 365, 1, 3650),
    cap: intEnv('PAYESH_DEVICE_CAP', 10, 1, 1000),
    staleDays: intEnv('PAYESH_DEVICE_STALE_DAYS', 30, 1, 3650),
    retainDays: intEnv('PAYESH_REFRESH_RETAIN_DAYS', 30, 1, 3650),
    proofSkewSec: intEnv('PAYESH_PROOF_SKEW_SEC', 300, 10, 3600),
  };
}

const PROOF_PREFIX = 'payesh-refresh-v1';

/* ── public key (device identity) ─────────────────────────────────── */
function parsePubkey(b64) {
  if (b64 === undefined || b64 === null || b64 === '') return { ok: true, none: true };
  const s = String(b64).trim();
  if (s.length > 400 || !/^[A-Za-z0-9+/=_-]+$/.test(s)) return { ok: false, error: 'bad_device_pubkey' };
  try {
    const der = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    const t = key.asymmetricKeyType;
    if (t === 'ed25519') return { ok: true, alg: 'ed25519', spki: key.export({ format: 'der', type: 'spki' }).toString('base64') };
    if (t === 'ec' && key.asymmetricKeyDetails && key.asymmetricKeyDetails.namedCurve === 'prime256v1') {
      return { ok: true, alg: 'p256', spki: key.export({ format: 'der', type: 'spki' }).toString('base64') };
    }
    return { ok: false, error: 'bad_device_pubkey' };
  } catch (e) { return { ok: false, error: 'bad_device_pubkey' }; }
}

function proofMessage(deviceId, ts, rawToken) {
  return PROOF_PREFIX + '\n' + deviceId + '\n' + ts + '\n' + sha256(String(rawToken || ''));
}

/** null = proof accepted; otherwise an error code. Never throws. */
function verifyProof(device, rawToken, proof, cfg = config()) {
  if (!device.pubkey) return null;
  if (!proof || typeof proof !== 'object') return 'proof_required';
  const ts = Number(proof.ts);
  if (!Number.isSafeInteger(ts) || ts <= 0) return 'bad_proof';
  if (Math.abs(Date.now() - ts) > cfg.proofSkewSec * 1000) return 'proof_expired';
  if (device.proof_ts && ts <= Number(device.proof_ts)) return 'proof_replayed';
  const sig = String(proof.sig || '');
  if (!sig || sig.length > 300) return 'bad_proof';
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(device.pubkey, 'base64'), format: 'der', type: 'spki' });
    const msg = Buffer.from(proofMessage(device.id, ts, rawToken), 'utf8');
    const sigBuf = Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const ok = device.pubkey_alg === 'ed25519'
      ? crypto.verify(null, msg, key, sigBuf)
      : crypto.verify('sha256', msg, { key, dsaEncoding: 'ieee-p1363' }, sigBuf);
    return ok ? null : 'bad_proof';
  } catch (e) { return 'bad_proof'; }
}

/* ── refresh-token chain ──────────────────────────────────────────── */
function issueToken(store, deviceId, generation) {
  const raw = randomId(32);
  store.db.prepare('INSERT INTO device_tokens(token_hash,device_id,generation,issued_at) VALUES(?,?,?,?)')
    .run(sha256(raw), String(deviceId), Number(generation), nowISO());
  return raw;
}

/** Find the token row (or a pre-row-65 meta token, migrated on first use). */
function lookup(store, raw) {
  const t = String(raw || '');
  if (!t || t.length > 200) return null;
  const h = sha256(t);
  let rec = store.db.prepare('SELECT * FROM device_tokens WHERE token_hash=?').get(h);
  if (!rec) {
    /* legacy (before row 65): meta "device:<hash>" — adopt it as generation 0 */
    const legacy = store.getMeta('device:' + h, null);
    if (!legacy || !legacy.device_id) return null;
    store.db.prepare('INSERT OR IGNORE INTO device_tokens(token_hash,device_id,generation,issued_at) VALUES(?,?,?,?)')
      .run(h, String(legacy.device_id), 0, String(legacy.created_at || nowISO()));
    try { store.db.prepare('DELETE FROM meta WHERE key=?').run('device:' + h); } catch (e) { /* noop */ }
    rec = store.db.prepare('SELECT * FROM device_tokens WHERE token_hash=?').get(h);
  }
  const device = rec ? store.db.prepare('SELECT * FROM devices WHERE id=?').get(rec.device_id) : null;
  return rec && device ? { rec, device } : null;
}

/**
 * Rotate (or replay within grace). Returns
 *   { ok:true, device_token, rotated:boolean }            normal / grace
 *   { ok:false, error:'device_revoked', reason:'refresh_reuse' }  reuse ⇒ chain revoked
 *   { ok:false, error:'device_expired' }                   refresh token older than deviceDays
 */
function rotate(store, found, cfg = config(), ctx = {}) {
  const { rec, device } = found;
  const now = Date.now();
  if (rec.rotated_at) {
    const age = now - Date.parse(rec.rotated_at);
    if (age <= cfg.graceSec * 1000 && rec.successor_enc && ctx.openSecret) {
      const succ = ctx.openSecret(store, rec.successor_enc);
      const succRec = succ ? store.db.prepare('SELECT * FROM device_tokens WHERE token_hash=?').get(sha256(succ)) : null;
      if (succRec && !succRec.rotated_at) {
        audit(store, device, 'refresh_grace', { generation: rec.generation, age_ms: age }, ctx.ip);
        return { ok: true, device_token: succ, rotated: false, generation: succRec.generation };
      }
    }
    /* reuse of a spent refresh token ⇒ the chain is compromised: revoke everything */
    store.db.prepare('UPDATE device_tokens SET reused_at=? WHERE token_hash=?').run(nowISO(), rec.token_hash);
    revokeDevice(store, device.id, 'refresh_reuse');
    audit(store, device, 'refresh_reuse_detected', { generation: rec.generation, rotated_at: rec.rotated_at }, ctx.ip);
    return { ok: false, error: 'device_revoked', reason: 'refresh_reuse', wipe: true };
  }
  if (now - Date.parse(rec.issued_at) > cfg.deviceDays * 86400000) return { ok: false, error: 'device_expired' };
  const next = issueToken(store, device.id, Number(rec.generation) + 1);
  store.db.prepare('UPDATE device_tokens SET rotated_at=?, successor_enc=? WHERE token_hash=?')
    .run(nowISO(), cfg.graceSec > 0 && ctx.sealSecret ? ctx.sealSecret(store, next) : null, rec.token_hash);
  audit(store, device, 'refresh_rotate', { generation: Number(rec.generation) + 1 }, ctx.ip);
  return { ok: true, device_token: next, rotated: true, generation: Number(rec.generation) + 1 };
}

/* ── device lifecycle ─────────────────────────────────────────────── */
function revokeDevice(store, deviceId, reason = 'manager') {
  const t = nowISO();
  store.db.prepare('UPDATE devices SET revoked_at=COALESCE(revoked_at, ?), revoke_reason=COALESCE(revoke_reason, ?) WHERE id=?')
    .run(t, String(reason).slice(0, 40), String(deviceId));
  store.db.prepare('UPDATE sessions SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL').run(t, String(deviceId));
  /* spent successors are dropped: nothing in the chain can be replayed into a session */
  store.db.prepare('UPDATE device_tokens SET successor_enc=NULL WHERE device_id=?').run(String(deviceId));
}

/** Retire stale devices, then refuse when the user already has `cap` active devices. */
function checkCap(store, userId, cfg = config(), ip) {
  const cutoff = new Date(Date.now() - cfg.staleDays * 86400000).toISOString();
  const stale = store.db.prepare(
    'SELECT id FROM devices WHERE user_id=? AND revoked_at IS NULL AND COALESCE(last_seen_at, created_at) < ?'
  ).all(Number(userId), cutoff);
  for (const d of stale) {
    revokeDevice(store, d.id, 'stale');
    audit(store, { id: d.id, user_id: userId }, 'device_stale_revoked', { stale_days: cfg.staleDays }, ip);
  }
  const n = store.db.prepare('SELECT COUNT(*) n FROM devices WHERE user_id=? AND revoked_at IS NULL').get(Number(userId)).n;
  if (n >= cfg.cap) {
    audit(store, { id: null, user_id: userId }, 'device_limit', { active: n, limit: cfg.cap }, ip);
    return { ok: false, error: 'device_limit', limit: cfg.cap, active: n };
  }
  return null;
}

function revokeUserDevices(store, userId, exceptDeviceId, reason = 'revoke_all') {
  const rows = store.db.prepare('SELECT id FROM devices WHERE user_id=? AND revoked_at IS NULL').all(Number(userId));
  let n = 0;
  for (const d of rows) {
    if (exceptDeviceId && d.id === exceptDeviceId) continue;
    revokeDevice(store, d.id, reason);
    n++;
  }
  return n;
}

/** Was this access token issued to a device that has since been revoked? (remote wipe signal) */
function sessionDeviceRevoked(store, token) {
  if (!token) return null;
  const s = store.db.prepare('SELECT device_id FROM sessions WHERE token_hash=?').get(sha256(String(token)));
  if (!s || !s.device_id) return null;
  const d = store.db.prepare('SELECT revoked_at, revoke_reason FROM devices WHERE id=?').get(s.device_id);
  return d && d.revoked_at ? { reason: d.revoke_reason || 'manager' } : null;
}

function prune(store, cfg = config()) {
  const graceCut = new Date(Date.now() - Math.max(cfg.graceSec, 1) * 1000).toISOString();
  store.db.prepare('UPDATE device_tokens SET successor_enc=NULL WHERE rotated_at IS NOT NULL AND rotated_at < ? AND successor_enc IS NOT NULL').run(graceCut);
  const retainCut = new Date(Date.now() - cfg.retainDays * 86400000).toISOString();
  store.db.prepare('DELETE FROM device_tokens WHERE rotated_at IS NOT NULL AND rotated_at < ?').run(retainCut);
}

function audit(store, device, action, after, ip) {
  try {
    store.audit({ user_id: device && device.user_id != null ? Number(device.user_id) : null, role: 'system',
      device_id: device && device.id ? String(device.id) : null, action, collection: 'devices', after: after || null, ip: ip || null });
  } catch (e) { /* audit must never break auth */ }
}

module.exports = {
  config, parsePubkey, proofMessage, verifyProof, issueToken, lookup, rotate,
  revokeDevice, revokeUserDevices, checkCap, sessionDeviceRevoked, prune, audit, PROOF_PREFIX,
};
