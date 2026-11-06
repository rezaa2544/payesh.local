'use strict';
// نمونهٔ فنی ۲۰ — آزمون امنیت، بار و قطعی سراسری (۰۴ §۳ و §۵ · ۱۶ §۷ · D‑11)
// این فایل «سیستم تحت آزمون» است: دروازهٔ نمونه (Auth + Tenant + نقش) روی هستهٔ تعارض نمونهٔ ۱۹.
// قاعدهٔ سخت: tenant_id فقط از توکن؛ هیچ فیلدی از بدنه آن را تعیین نمی‌کند.

const crypto = require('node:crypto');
const { ConflictServer, sha256 } = require('../slice-19/conflict-server');

const MAX_BATCH = 200;              // server/sync.js:12 — سقف op در هر push
const TARGET_P95_READ_MS = 300;     // ۰۴ §۳ — C‑1
const TARGET_P95_WRITE_MS = 800;    // ۰۴ §۳ — C‑2
const TARGET_ERROR_RATE = 0.001;    // ۰۴ §۳ — C‑3 (< ۰٫۱٪)
const MAX_AUTH_FAILURES = 20;       // قفل دستگاه پس از ۲۰ تلاش ناموفق
const BACKOFF_BASE_MS = 200;
const BACKOFF_CAP_MS = 30_000;

// ماتریس نوشتن نقش×کالکشن (۰۱ §۳.۲ / نمونهٔ ۱۷ policy.js)
const WRITE_MATRIX = {
  manager: ['attendance', 'grades', 'homework', 'exams', 'discipline', 'leaves', 'users',
    'announcements', 'classes', 'subjects', 'schedule', 'lookups', 'calendar'],
  teacher: ['attendance', 'grades', 'homework', 'exams', 'discipline', 'leaves'],
  counselor: ['discipline', 'leaves'],
  parent: ['leaves'],
  student: ['leaves'],
  guard: [],
};
const canWrite = (role, collection) => (WRITE_MATRIX[role] || []).includes(collection);

class AuthError extends Error {
  constructor(code, status = 401) { super(code); this.code = code; this.status = status; }
}
class RequestError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
// قطعی سراسری: هیچ درخواستی پاسخ نمی‌گیرد (F‑C2) یا نمونهٔ اپ از کار افتاده (F‑C4)
class Outage extends Error {
  constructor(kind) { super(kind); this.kind = kind; this.code = 503; }
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const nowMs = () => Date.now();

class Gateway {
  constructor({ secret = crypto.randomBytes(32), now = nowMs } = {}) {
    this.secret = secret;
    this.now = now;
    this.core = new ConflictServer({ now });
    this.state = 'up';                 // up | degraded | down
    this.tenants = new Map();
    this.users = new Map();
    this.revokedDevices = new Set();
    this.authFailures = new Map();     // device_id → تعداد شکست
    this.counters = {
      requests: 0, ok: 0, auth_failed: 0, forbidden: 0, rejected: 0,
      not_found: 0, outages: 0, errors: {},
    };
    this.audit = [];
    this.outages = [];
    this.capacityProbe = null;
  }

  // ---------- حسابرسی زنجیره‌ای (مستقل از نمونهٔ ۱۹، همان قرارداد) ----------
  _audit(entry) {
    const prev = this.audit.length ? this.audit[this.audit.length - 1].hash : 'GENESIS';
    const row = { ...entry, at: this.now(), prev_hash: prev };
    row.hash = sha256(JSON.stringify({ ...row, hash: undefined }));
    this.audit.push(row);
    return row;
  }

  // ---------- تأمین مستأجر و توکن ----------
  provision({ id, code, name }) {
    const t = { id, code, name, status: 'live' };
    this.tenants.set(id, t);
    return t;
  }

  addUser({ tenant_id, role, user_id }) {
    const u = { tenant_id, role, user_id };
    this.users.set(`${tenant_id}|${user_id}`, u);
    return u;
  }

  issueToken({ tenant_id, role, user_id = `u-${role}`, device_id = `dev-${role}`, ttlMs = 3_600_000 }) {
    if (!this.tenants.has(tenant_id)) throw new AuthError('unknown_tenant');
    if (!this.users.has(`${tenant_id}|${user_id}`)) this.addUser({ tenant_id, role, user_id });
    const payload = {
      v: 1, tid: tenant_id, role, uid: user_id, did: device_id,
      iat: this.now(), exp: this.now() + ttlMs,
    };
    const body = b64u(JSON.stringify(payload));
    const sig = crypto.createHmac('sha256', this.secret).update(body).digest();
    return `${body}.${b64u(sig)}`;
  }

  _verify(token) {
    const parts = String(token).split('.');
    if (parts.length !== 2) throw new AuthError('token_malformed');
    const [body, sigB64] = parts;
    const expect = crypto.createHmac('sha256', this.secret).update(body).digest();
    let got;
    try { got = Buffer.from(sigB64, 'base64url'); } catch { throw new AuthError('bad_signature'); }
    if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) throw new AuthError('bad_signature');
    let payload;
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new AuthError('token_malformed'); }
    if (!payload || payload.alg === 'none' || payload.v !== 1) throw new AuthError('alg_not_allowed');
    if (typeof payload.exp !== 'number' || payload.exp <= this.now()) throw new AuthError('token_expired');
    return payload;
  }

  // «هدر مجوز» — توکن تنها منبع هویت است
  authenticate(authorization, clientKey = 'client-anon') {
    if (!authorization) { this.counters.auth_failed++; throw new AuthError('auth_required'); }
    const raw = String(authorization).replace(/^Bearer\s+/i, '');
    const deviceGuess = String(clientKey);
    const fails = this.authFailures.get(deviceGuess) || 0;
    if (fails >= MAX_AUTH_FAILURES) { this.counters.auth_failed++; throw new AuthError('rate_limited', 429); }
    let payload;
    try {
      payload = this._verify(raw);
    } catch (e) {
      this.authFailures.set(deviceGuess, fails + 1);
      this.counters.auth_failed++;
      this._audit({ action: 'auth.deny', reason: e.code, device: deviceGuess.slice(0, 12) });
      throw e;
    }
    const tenant = this.tenants.get(payload.tid);
    if (!tenant) throw new AuthError('unknown_tenant');
    if (tenant.status !== 'live') throw new AuthError('tenant_suspended', 403);
    if (this.revokedDevices.has(payload.did)) throw new AuthError('device_revoked', 401);
    this.authFailures.delete(deviceGuess);
    return { tenant_id: payload.tid, role: payload.role, user_id: payload.uid, device_id: payload.did };
  }

  // ---------- چرخهٔ خرابی ----------
  armOutage(kind) {
    this.state = kind === 'degraded' ? 'degraded' : 'down';
    const row = { kind: this.state, started_at: this.now() };
    this.outages.push(row);
    this._audit({ action: 'outage.begin', kind: this.state });
    return row;
  }

  recover() {
    const open = this.outages.find((o) => !o.ended_at);
    if (open) open.ended_at = this.now();
    this.state = 'up';
    this._audit({ action: 'outage.end', duration_ms: open ? open.ended_at - open.started_at : 0 });
    return open;
  }

  _guardState() {
    if (this.state === 'down') { this.counters.outages++; throw new Outage('dc_down'); }
    if (this.state === 'degraded') { this.counters.outages++; throw new Outage('app_unavailable'); }
  }

  // ---------- نوشتن (معادل /api/sync) ----------
  // مسیر همگام: صف آفلاین نمونهٔ ۱۸ قرارداد همگام دارد (flush بدون await)
  pushSync(session, batch) {
    this.counters.requests++;
    this._guardState();
    if (!Array.isArray(batch) || batch.length === 0) throw new RequestError('empty_batch');
    if (batch.length > MAX_BATCH) throw new RequestError('batch_too_large', 413);

    // اعتبارسنجی کامل پیش از هر اعمال — دسته اتمیک است (هیچ نیمه‌اعمالی)
    for (const op of batch) {
      if (!op || typeof op !== 'object' || !op.op_id) throw new RequestError('op_malformed');
      if (!canWrite(session.role, op.collection)) {
        this.counters.forbidden++;
        this._audit({ action: 'write.deny', tenant: session.tenant_id, role: session.role, collection: op.collection });
        throw new AuthError('role_denied', 403);
      }
      if (op.payload_hash !== sha256(JSON.stringify(op.payload))) {
        this.counters.rejected++;
        return { server_time: this.now(), results: batch.map((o) => ({ op_id: o.op_id, status: 'rejected', reason: 'payload_hash_mismatch' })) };
      }
    }

    const results = batch.map((op) => {
      const r = this.core.apply(session, {
        op_id: op.op_id, collection: op.collection, record_id: op.record_id,
        fields: op.payload, base_version: op.base_version,
      });
      return r;
    });
    this.counters.ok++;
    return { server_time: this.now(), results };
  }

  // نقطهٔ تعویض واقعی در event loop — برای سنجش تأخیر زیر هم‌زمانی
  async push(session, batch) {
    await Promise.resolve();
    return this.pushSync(session, batch);
  }

  // ---------- خواندن ----------
  readSync(session, { collection, record_id }) {
    this.counters.requests++;
    this._guardState();
    const rec = this.core.record(session.tenant_id, collection, record_id);
    // پاسخ یکنواخت: ردیف مستأجر دیگر و ردیف ناموجود از هم قابل تفکیک نیستند (بدون اوراکل وجود)
    if (!rec || rec.version === 0) {
      this.counters.not_found++;
      throw new RequestError('not_found', 404);
    }
    this.counters.ok++;
    return { version: rec.version, fields: { ...rec.fields }, server_time: this.now() };
  }

  async read(session, ref) {
    await Promise.resolve();
    return this.readSync(session, ref);
  }

  status(session) { return this.core.status(session.tenant_id); }
}

// ---------- شبکهٔ کلاینت: قطعی، از دست رفتن ack، عقب‌نشینی ----------
class Network {
  constructor(gateway) {
    this.gateway = gateway;
    this.mode = 'up';              // up | offline
    this.dropResults = new Set();  // op_idهایی که پاسخ‌شان گم می‌شود (ack_unknown)
    this.delivered = 0;
    this.lostAcks = 0;
  }

  // قرارداد صف نمونهٔ ۱۸: push همگام است و خطا با throw اعلام می‌شود
  server() {
    return { push: (session, batch) => this.pushSync(session, batch) };
  }

  pushSync(session, batch) {
    if (this.mode === 'offline') throw new Outage('network');
    const res = this.gateway.pushSync(session, batch);
    if (this.dropResults.size) {
      const kept = res.results.filter((r) => !this.dropResults.has(r.op_id));
      this.lostAcks += res.results.length - kept.length;
      this.dropResults.clear();
      this.delivered++;
      return { server_time: res.server_time, results: kept };
    }
    this.delivered++;
    return res;
  }

  async push(session, batch) {
    await Promise.resolve();
    return this.pushSync(session, batch);
  }

  async read(session, ref) {
    await Promise.resolve();
    if (this.mode === 'offline') throw new Outage('network');
    return this.pushSafeRead(session, ref);
  }

  pushSafeRead(session, ref) { return this.gateway.readSync(session, ref); }
}

// عقب‌نشینی نمایی با سقف — هرگز حلقهٔ تنگ
function backoffMs(attempt, { base = BACKOFF_BASE_MS, cap = BACKOFF_CAP_MS } = {}) {
  const n = Math.max(1, attempt | 0);
  return Math.min(cap, base * 2 ** (n - 1));
}

module.exports = {
  Gateway, Network, AuthError, RequestError, Outage, canWrite, backoffMs,
  MAX_BATCH, MAX_AUTH_FAILURES, WRITE_MATRIX,
  TARGET_P95_READ_MS, TARGET_P95_WRITE_MS, TARGET_ERROR_RATE,
};
