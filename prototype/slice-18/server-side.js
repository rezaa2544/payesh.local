'use strict';
// نمونهٔ فنی ۱۸ — سمت سرور: قرارداد صف، اعمال idempotent، ترتیب، orphaned، review
// مرجع: ۱۳ §۳.۱–§۳.۳ و ماتریس ۱۳ CC‑13‑۱، CC‑13‑۲ · D‑27 · F‑06 (هویت فقط از نشست)

const crypto = require('node:crypto');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

class ServerReject extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

class QueueServer {
  constructor({ now = () => Date.now(), reviewDays = 30 } = {}) {
    this.now = now;
    this.reviewDays = reviewDays;
    this.applied = new Map();          // `${tenant}|${op_id}` → result  (UNIQUE(tenant_id, op_id))
    this.records = new Map();          // `${tenant}|${collection}|${record_id}` → { version, data }
    this.openOps = new Map();          // `${tenant}|${op_id}` → { op metadata, payload, created_at }
    this.orphaned = [];                // ردیف‌های سمت سرور برای صف ابطال‌شده
    this.decisions = [];               // queue_decision(op_id, actor, action, reason, ts)
    this.revoked = new Set();          // userId های ابطال‌شده (W1)
    this.serial = 0;
  }

  _key(tenant, collection, recordId) { return `${tenant}|${collection}|${recordId}`; }

  // ابطال نشست/دستگاه (W1) — بی‌درنگ و مستقل از اتصال دستگاه
  revokeUser(userId) { this.revoked.add(userId); }

  // قصهٔ اصلی: دریافت دستهٔ op از دستگاه
  push(session, ops) {
    if (!session || session.revoked || this.revoked.has(session.user_id)) {
      return { status: 401, server_time: this.now(), results: [], reason: 'session_revoked' };
    }
    const results = [];
    for (const op of ops) results.push(this._apply(session, op));
    return { status: 200, server_time: this.now(), results };
  }

  _apply(session, op) {
    const tenant = session.tenant_id;                       // F‑06: tenant از نشست، نه از بدنه
    if (!op || !op.op_id) return { op_id: null, status: 'rejected', reason: 'op_id_required' };

    // idempotency: بازپخش همان نتیجه، بدون افزایش نسخه
    const appliedKey = `${tenant}|${op.op_id}`;
    if (this.applied.has(appliedKey)) {
      const prev = this.applied.get(appliedKey);
      return { op_id: op.op_id, status: 'applied', replay: true, server_seq: prev.server_seq, version: prev.version };
    }

    if (op.tenant_id && op.tenant_id !== tenant) {
      // tenant_id متخاصم نادیده گرفته می‌شود؛ فقط ثبت می‌شود
      op = { ...op, tenant_id_spoof_ignored: op.tenant_id };
    }

    if (op.payload !== undefined && op.payload_hash !== sha256(JSON.stringify(op.payload))) {
      const r = { op_id: op.op_id, status: 'rejected', reason: 'payload_hash_mismatch' };
      this._remember(tenant, op, r); return r;
    }

    const recordKey = this._key(tenant, op.collection, op.record_id);
    const rec = this.records.get(recordKey) || { version: 0, data: null };

    if (typeof op.base_version === 'number' && op.base_version > rec.version) {
      const r = { op_id: op.op_id, status: 'ordering', code: 409, reason: 'base_version_ahead' };
      this._remember(tenant, op, r); return r;
    }
    if (typeof op.base_version === 'number' && op.base_version < rec.version) {
      const r = { op_id: op.op_id, status: 'conflict', code: 409, reason: 'base_version_stale', server_version: rec.version };
      this._remember(tenant, op, r); return r;
    }

    // اعمال
    this.serial += 1;
    const next = { version: rec.version + 1, data: op.payload ?? null };
    this.records.set(recordKey, next);
    const result = { op_id: op.op_id, status: 'applied', server_seq: this.serial, version: next.version };
    this.applied.set(appliedKey, result);
    this._remember(tenant, op, result);
    return result;
  }

  _remember(tenant, op, result) {
    const key = `${tenant}|${op.op_id}`;
    if (!this.openOps.has(key)) {
      this.openOps.set(key, {
        op_id: op.op_id, tenant_id: tenant, collection: op.collection, record_id: op.record_id,
        payload_hash: op.payload_hash || null, payload: op.payload ?? null,
        created_at: this.now(), state: 'open',
      });
    }
    if (result.status === 'applied' || result.status === 'rejected') {
      this.openOps.get(key).state = result.status;
    }
  }

  record(tenant, collection, recordId) {
    return this.records.get(this._key(tenant, collection, recordId)) || { version: 0, data: null };
  }

  // قاعدهٔ ۳۰ روز: عملیات باز و کهنه ⇒ review (payload کامل حفظ؛ هیچ حذفی)
  sweepStale() {
    const cutoff = this.now() - this.reviewDays * 24 * 3600_000;
    const moved = [];
    for (const row of this.openOps.values()) {
      if (row.state === 'open' && row.created_at <= cutoff) {
        row.state = 'review';
        moved.push(row.op_id);
      }
    }
    return moved;
  }

  // تعیین تکلیف انسانی روی ردیف review (۰۷): approve / reject / edit — هر تصمیم ثبت می‌شود
  decide(actor, op_id, action, reason = '') {
    const row = [...this.openOps.values()].find((r) => r.op_id === op_id);
    if (!row) return { ok: false, reason: 'not_found' };
    if (!['approve', 'reject', 'edit'].includes(action)) return { ok: false, reason: 'bad_action' };
    if (!reason) return { ok: false, reason: 'reason_required' };
    if (action === 'approve') row.state = 'approved';
    if (action === 'reject') row.state = 'rejected_by_human';
    if (action === 'edit') row.state = 'edited';
    const decision = { op_id, actor, action, reason, ts: this.now(), from: 'review' };
    this.decisions.push(decision);
    return { ok: true, decision };
  }

  // ابطال دستگاه: تعیین تکلیف صف پیش از W2 (D‑27 / §۳.۲.۲)
  // applyOnRevoke: نتیجهٔ تلاش «ارسال فوری یک‌باره»؛ اگر نیامد ⇒ orphaned سمت سرور
  adjudicateRevocation(session, { appliedOpIds = [], attemptedOpIds = [], attemptedOps = [] } = {}) {
    const applied = new Set(appliedOpIds);
    const out = { applied: [], orphaned: [], unknown: [] };
    for (const op_id of attemptedOpIds) {
      const key = `${session.tenant_id}|${op_id}`;
      const row = this.openOps.get(key);
      if (applied.has(op_id) || (row && row.state === 'applied')) {
        out.applied.push(op_id);
        if (row) row.state = 'applied';
        continue;
      }
      // نتیجه قابل بازیابی نیست ⇒ ردیف orphaned سمت سرور، با متادیتای کافی برای حسابرسی
      const attested = (attemptedOps || []).find((a) => a.op_id === op_id);
      this.orphaned.push({
        op_id, tenant_id: session.tenant_id, user_id: session.user_id,
        payload_hash: row ? row.payload_hash : (attested ? attested.payload_hash : null),
        created_at_server: this.now(), state: 'orphaned',
      });
      if (row) row.state = 'orphaned';
      out.orphaned.push(op_id);
    }
    return out;
  }

  // متادیتای عملیات حتی پس از نابودی کلید محلی، سمت سرور می‌ماند
  opMetadata(op_id) {
    return [...this.openOps.values()].filter((r) => r.op_id === op_id);
  }
}

module.exports = { QueueServer, ServerReject, sha256 };
