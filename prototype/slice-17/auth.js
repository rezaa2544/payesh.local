'use strict';
// احراز هویت نمونه: scrypt برای گذرواژه، توکن HMAC با انقضای مطلق/بی‌کاری،
// ذخیرهٔ hash توکن (نه خود توکن) — مطابق ۱۲ §۳ (sessions + tenant_id + absolute/idle).
// زنجیرهٔ audit با prev_hash/hash (۱۲ §۳ ردیف audit).

const crypto = require('node:crypto');

const PASSWORD_PARAMS = { N: 2 ** 14, r: 8, p: 1, keylen: 32 };

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const key = crypto.scryptSync(password, salt, PASSWORD_PARAMS.keylen, {
    N: PASSWORD_PARAMS.N, r: PASSWORD_PARAMS.r, p: PASSWORD_PARAMS.p,
  });
  return `scrypt$${PASSWORD_PARAMS.N}$${salt.toString('hex')}$${key.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [algo, N, saltHex, keyHex] = String(stored).split('$');
  if (algo !== 'scrypt') return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(keyHex, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length, {
    N: Number(N), r: PASSWORD_PARAMS.r, p: PASSWORD_PARAMS.p,
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const b64 = (buf) => Buffer.from(buf).toString('base64url');

class Sessions {
  constructor(store, secret, { absoluteMs = 8 * 3600_000, idleMs = 30 * 60_000, now = () => Date.now() } = {}) {
    this.store = store;
    this.secret = secret;
    this.absoluteMs = absoluteMs;
    this.idleMs = idleMs;
    this.now = now;
    this.rows = new Map(); // token_hash → session row
  }

  issue(user) {
    const now = this.now();
    const session = {
      sid: crypto.randomUUID(),
      user_id: user.id,
      tenant_id: user.tenant_id,
      role: user.role,
      absolute_expires_at: now + this.absoluteMs,
      idle_expires_at: now + this.idleMs,
      revoked: false,
    };
    const payload = b64(JSON.stringify({
      sid: session.sid, sub: session.user_id, tid: session.tenant_id, role: session.role,
      aexp: session.absolute_expires_at, iexp: session.idle_expires_at,
    }));
    const sig = b64(crypto.createHmac('sha256', this.secret).update(payload).digest());
    const token = `${payload}.${sig}`;
    session.token_hash = sha256(token);
    this.rows.set(session.token_hash, session);
    return { token, session };
  }

  // verify ⇒ { ok, session } یا { ok:false, reason }
  verify(token) {
    if (typeof token !== 'string' || token.split('.').length !== 2) return { ok: false, reason: 'malformed' };
    const [payload, sig] = token.split('.');
    const expected = b64(crypto.createHmac('sha256', this.secret).update(payload).digest());
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
    let claims;
    try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
    catch { return { ok: false, reason: 'malformed' }; }
    const session = this.rows.get(sha256(token));
    if (!session) return { ok: false, reason: 'unknown_session' };
    if (session.revoked) return { ok: false, reason: 'revoked' };
    const now = this.now();
    if (now > session.absolute_expires_at) return { ok: false, reason: 'expired_absolute' };
    if (now > session.idle_expires_at) return { ok: false, reason: 'expired_idle' };
    if (claims.tid !== session.tenant_id) return { ok: false, reason: 'tenant_mismatch' };
    session.idle_expires_at = now + this.idleMs; // تمدید بی‌کاری
    return { ok: true, session };
  }

  revoke(token) {
    const row = this.rows.get(sha256(token));
    if (!row) return false;
    row.revoked = true;
    return true;
  }
}

// audit زنجیره‌ای: هر ردیف به hash ردیف پیشین همان مستأجر گره می‌خورد
class AuditLog {
  constructor() { this.rows = []; }

  append(entry) {
    const prev = [...this.rows].reverse().find((r) => r.tenant_id === entry.tenant_id);
    const prev_hash = prev ? prev.hash : 'GENESIS';
    const body = JSON.stringify({ ...entry, prev_hash });
    const row = { ...entry, prev_hash, hash: sha256(body) };
    this.rows.push(row);
    return row;
  }

  list(tenant_id) { return this.rows.filter((r) => r.tenant_id === tenant_id); }

  verifyChain(tenant_id) {
    let prev = 'GENESIS';
    for (const row of this.rows.filter((r) => r.tenant_id === tenant_id)) {
      if (row.prev_hash !== prev) return false;
      const body = JSON.stringify({ ...row, prev_hash: row.prev_hash, hash: undefined });
      const clean = JSON.parse(body);
      delete clean.hash;
      if (sha256(JSON.stringify(clean)) !== row.hash) return false;
      prev = row.hash;
    }
    return true;
  }
}

module.exports = { hashPassword, verifyPassword, Sessions, AuditLog, sha256 };
