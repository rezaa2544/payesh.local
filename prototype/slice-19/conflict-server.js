'use strict';
// نمونهٔ فنی ۱۹ — تعارض و هم‌گرایی: «نیازمند تصمیم»، حفظ هر دو نسخه، حل با نقش مجاز
// مرجع: ۱۴ §۲–§۵ · D‑28 · آزمون‌های الزامی §۵ (۱–۱۱)

const crypto = require('node:crypto');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// §۲.۱ — قواعد per-entity: ادغام فیلد‌به‌فیلد فقط برای این‌ها مجاز است
const FIELD_MERGE_ALLOWED = new Set(['attendance', 'grades', 'homework', 'users']);

// حل‌کنندهٔ مجاز per-entity (نقش‌های واقعی محصول + اسکوپ کلاس)
const RESOLVERS = {
  attendance: ['manager', 'teacher'],
  grades: ['manager', 'teacher'],
  leaves: ['manager', 'teacher'],
  discipline: ['manager', 'teacher', 'counselor'],
  homework: ['manager', 'teacher'],
  announcements: ['manager'],
  users: ['manager'],
  schedule: ['manager'],
  exams: ['manager'], calendar: ['manager'], lookups: ['manager'], classes: ['manager'], subjects: ['manager'],
};

// کسانی که فقط می‌توانند «انصراف» ثبت کنند (درخواست‌دهنده) — §۲.۱ leaves
const WITHDRAW_ONLY = { leaves: ['parent', 'student'] };

class ConflictServer {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.records = new Map();      // `${tenant}|${collection}|${record_id}` → { version, fields, history }
    this.conflicts = [];           // ردیف‌های conflict (هر دو نسخه تا ابد)
    this.audit = [];
    this.serial = 0;
    this._appliedOps = new Map();  // idempotency: `${tenant}|${op_id}` → result
  }

  _key(tenant, collection, id) { return `${tenant}|${collection}|${id}`; }
  _rec(tenant, collection, id) {
    return this.records.get(this._key(tenant, collection, id)) || { version: 0, fields: {}, history: {} };
  }
  _beforeHash(rec) { return sha256(JSON.stringify(rec.fields)); }

  _audit(entry) {
    const prev = this.audit.length ? this.audit[this.audit.length - 1].hash : 'GENESIS';
    const row = { ...entry, at: this.now(), prev_hash: prev };
    row.hash = sha256(JSON.stringify({ ...row, hash: undefined }));
    this.audit.push(row);
    return row;
  }

  // ارسال op از دستگاه
  apply(session, op) {
    const tenant = session.tenant_id;
    const idem = `${tenant}|${op.op_id}`;
    if (this._appliedOps.has(idem)) return this._appliedOps.get(idem);

    const rec = this._rec(tenant, op.collection, op.record_id);
    const isNew = rec.version === 0;
    // §۳ قاعدهٔ ۷ / آزمون ۷: base_version برای update اجباری (۰ یا null ⇒ رد)
    if (!isNew && (op.base_version === null || op.base_version === undefined || op.base_version === 0)) {
      const r = { op_id: op.op_id, status: 'rejected', reason: 'base_version_required' };
      this._appliedOps.set(idem, r);
      this._audit({ tenant, action: 'op.reject', op_id: op.op_id, reason: r.reason, session_role: session.role });
      return r;
    }
    if (op.base_version > rec.version) {
      const r = { op_id: op.op_id, status: 'ordering', code: 409 };
      this._appliedOps.set(idem, r);
      return r;
    }

    const touched = Object.keys(op.fields || {});
    // تعارض واقعی: فیلدهایی که بعد از base_version عوض شده‌اند
    const conflicted = touched.filter((f) => rec.history[f] && rec.history[f].version > op.base_version);
    const clean = touched.filter((f) => !conflicted.includes(f));

    if (conflicted.length && !FIELD_MERGE_ALLOWED.has(op.collection)) {
      // ردیف واحد تعارض: کل ردیف متعارض است (نه ادغام)
      this._raiseConflicts(session, op, rec, ['*'], op.fields, rec.fields);
      const r = {
        op_id: op.op_id, status: 'conflict', code: 409,
        conflict: { record_id: op.record_id, fields: ['*'], server_version: rec.version, before_hash: this._beforeHash(rec) },
      };
      this._appliedOps.set(idem, r);
      return r;
    }

    if (conflicted.length) {
      // ادغام فیلدهای مستقل مجاز است؛ فیلدهای متعارض «نیازمند تصمیم» می‌شوند
      let next = { ...rec, fields: { ...rec.fields }, history: { ...rec.history } };
      if (clean.length) next = this._commit(next, clean, op.fields);
      this.records.set(this._key(tenant, op.collection, op.record_id), next);
      this._raiseConflicts(session, op, next, conflicted.sort(), op.fields, rec.fields);
      const r = {
        op_id: op.op_id, status: 'conflict', code: 409, merged_fields: clean.sort(),
        conflict: { record_id: op.record_id, fields: conflicted.sort(), server_version: next.version, before_hash: this._beforeHash(next) },
      };
      this._appliedOps.set(idem, r);
      this._audit({ tenant, action: 'conflict.open', op_id: op.op_id, fields: conflicted.sort(), auto_merged: clean.sort(), session_role: session.role });
      return r;
    }

    const next = this._commit(rec, touched.sort(), op.fields);   // ترتیب قطعی: field_name صعودی
    this.records.set(this._key(tenant, op.collection, op.record_id), next);
    const r = { op_id: op.op_id, status: 'applied', server_seq: ++this.serial, version: next.version };
    this._appliedOps.set(idem, r);
    this._audit({ tenant, action: 'op.apply', op_id: op.op_id, fields: touched.sort(), version: next.version, session_role: session.role });
    return r;
  }

  _commit(rec, fields, values) {
    const version = rec.version + 1;
    const out = { version, fields: { ...rec.fields }, history: { ...rec.history } };
    for (const f of [...fields].sort()) {           // determinism: ترتیب قطعی
      out.fields[f] = values[f];
      out.history[f] = { version, value: values[f] };
    }
    return out;
  }

  // ردیف تعارض با قید یکتایی مستند ۱۴ §۲ (شامل raised_by_op_id)
  _raiseConflicts(session, op, rec, fields, localValues, serverValues) {
    for (const field of fields) {
      const exists = this.conflicts.find((c) =>
        c.tenant_id === session.tenant_id && c.collection === op.collection && c.record_id === op.record_id &&
        c.field === field && c.server_version === rec.version && c.raised_by_op_id === op.op_id);
      if (exists) continue;                          // همان op دوباره: یک ردیف، نه دو
      this.conflicts.push({
        id: crypto.randomUUID(), tenant_id: session.tenant_id, collection: op.collection, record_id: op.record_id,
        field,
        base_version: op.base_version, server_version: rec.version,
        local_value: field === '*' ? localValues : localValues[field],
        server_value: field === '*' ? serverValues : (serverValues[field] ?? null),
        status: 'open', raised_by_op_id: op.op_id,
        resolved_by: null, resolved_at: null, resolution: null, reason: null,
        before_hash: this._beforeHash(rec), after_hash: null, audit_id: null,
        created_at: this.now(),
      });
    }
  }

  openConflicts(tenant, extra = {}) {
    return this.conflicts.filter((c) => c.tenant_id === tenant && c.status === 'open' &&
      Object.entries(extra).every(([k, v]) => c[k] === v));
  }

  // پاسخ ۴۰۹ بدون لو دادن محتوا (§۳ قاعدهٔ ۶ / آزمون ۸)
  conflictView(conflict) {
    return {
      record_id: conflict.record_id, field: conflict.field,
      server_version: conflict.server_version, before_hash: conflict.before_hash,
      conflicting_fields: [conflict.field],
    };
  }

  // حل تعارض — فقط نقش مجاز با اسکوپ؛ هر تصمیم در audit
  resolve(session, conflictId, { resolution, reason = '', value = undefined } = {}) {
    const c = this.conflicts.find((x) => x.id === conflictId && x.tenant_id === session.tenant_id);
    if (!c) return { ok: false, code: 404, reason: 'not_found' };
    if (c.status === 'resolved') return { ok: true, idempotent: true, conflict: c };   // آزمون ۳
    if (c.status === 'orphaned') return { ok: false, code: 409, reason: 'conflict_orphaned' };

    const withdrawOnly = WITHDRAW_ONLY[c.collection] || [];
    const isRequesterWithdraw = withdrawOnly.includes(session.role) && resolution === 'dismiss';
    const allowedRoles = RESOLVERS[c.collection] || [];
    if (!isRequesterWithdraw) {
      if (!allowedRoles.includes(session.role)) {
        this._audit({ tenant: session.tenant_id, action: 'conflict.resolve.deny', conflict_id: c.id, session_role: session.role, reason: 'role_denied' });
        return { ok: false, code: 403, reason: 'role_denied' };
      }
      // اسکوپ: دبیر فقط برای کلاس‌های خودش
      if (session.role === 'teacher' && !(session.class_ids || []).includes(c.record_id.split(':')[0])) {
        this._audit({ tenant: session.tenant_id, action: 'conflict.resolve.deny', conflict_id: c.id, session_role: session.role, reason: 'out_of_scope' });
        return { ok: false, code: 403, reason: 'out_of_scope' };
      }
    }
    if (['merged', 'custom'].includes(resolution) && !reason) return { ok: false, code: 400, reason: 'reason_required' };
    if (!['take_local', 'take_server', 'merged', 'custom', 'dismiss'].includes(resolution)) return { ok: false, code: 400, reason: 'bad_resolution' };

    const key = this._key(session.tenant_id, c.collection, c.record_id);
    const rec = this.records.get(key) || { version: 0, fields: {}, history: {} };
    let next = { ...rec, fields: { ...rec.fields }, history: { ...rec.history } };

    if (resolution === 'take_local' || resolution === 'custom') {
      const v = resolution === 'custom' ? value : c.local_value;
      next = this._commit(next, [c.field === '*' ? 'value' : c.field], { [c.field === '*' ? 'value' : c.field]: v });
      this.records.set(key, next);
    } else if (resolution === 'merged') {
      const v = value !== undefined ? value : c.local_value;
      next = this._commit(next, [c.field === '*' ? 'value' : c.field], { [c.field === '*' ? 'value' : c.field]: v });
      this.records.set(key, next);
    } else if (resolution === 'take_server') {
      // نسخهٔ سرور دست‌نخورده می‌ماند؛ نسخهٔ محلی فقط در ردیف تعارض حفظ می‌شود
    }

    c.status = resolution === 'dismiss' ? 'dismissed' : 'resolved';
    c.resolution = resolution;
    c.reason = reason || (resolution === 'dismiss' ? 'withdrawn_by_requester' : null);
    c.resolved_by = session.user_id;
    c.resolved_at = this.now();
    c.after_hash = resolution === 'take_server' || resolution === 'dismiss' ? this._beforeHash(rec) : sha256(JSON.stringify(next.fields));
    const audit = this._audit({
      tenant: session.tenant_id, action: 'conflict.resolve', conflict_id: c.id, resolution,
      actor: session.user_id, role: session.role, reason: c.reason, version: next.version,
    });
    c.audit_id = audit.hash;
    return { ok: true, conflict: c, version: next.version };
  }

  // وضعیت مدرسه: تعارض‌های حل‌نشده شمرده می‌شوند (شفافیت §۳ قاعدهٔ ۴)
  status(tenant) {
    return {
      open: this.conflicts.filter((c) => c.tenant_id === tenant && c.status === 'open').length,
      resolved: this.conflicts.filter((c) => c.tenant_id === tenant && c.status === 'resolved').length,
      dismissed: this.conflicts.filter((c) => c.tenant_id === tenant && c.status === 'dismissed').length,
      orphaned: this.conflicts.filter((c) => c.tenant_id === tenant && c.status === 'orphaned').length,
    };
  }

  // تعارض باز + ابطال دستگاه: قبل از W2 ثبت، پس از wipe «orphaned» — نه حذف (§۳ قاعدهٔ ۵)
  orphanAfterWipe(session) {
    const rows = this.conflicts.filter((c) => c.tenant_id === session.tenant_id && c.status === 'open');
    for (const c of rows) { c.status = 'orphaned'; c.orphaned_at = this.now(); }
    this._audit({ tenant: session.tenant_id, action: 'conflict.orphaned', count: rows.length, actor: session.user_id });
    return rows.map((c) => c.id);
  }

  record(tenant, collection, id) { return this._rec(tenant, collection, id); }
}

module.exports = { ConflictServer, FIELD_MERGE_ALLOWED, RESOLVERS, WITHDRAW_ONLY, sha256 };
