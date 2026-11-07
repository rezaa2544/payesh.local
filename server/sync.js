'use strict';
/* ───────────────────────────────────────────────────────────────────
   همگام‌سازی — همان قرارداد پایش اصلی (ساده‌شده و تک‌مدرسه‌ای)
   Pull : دلتا بر اساس updated_at + tombstone + server_time
   Push : صف عملیات با idempotency، OCC (base_version) و gate نقش/اسکوپ
   ─────────────────────────────────────────────────────────────────── */
const { nowISO, normalizeMobile } = require('./util');
const policy = require('./policy');
const tenantCtx = require('./tenant-context');
const auth = require('./auth');

const ROW_LIMIT = 3000;          /* سقف ردیف هر کالکشن در هر درخواست */
const MAX_OPS = 200;             /* سقف عملیات هر push (هم‌راستا با کلاینت) */
const EPOCH = '1970-01-01T00:00:00.000Z';

const DEFAULT_COLLECTIONS = [
  'schools', 'school_years', 'users', 'classes', 'subjects', 'lookups', 'schedule', 'bell_schedules',
  'substitutions', 'attendance', 'grades', 'announcements', 'leaves', 'parent_links', 'internships',
  'staff_attendance', 'staff_posts', 'discipline', 'homework', 'exams', 'calendar', 'import_issues',
];

/* شمارهٔ همراه: ارقام فارسی/عربی به لاتین، و اگر اکسل صفرِ اول را
   خورده باشد خودکار ۱۱ رقمی می‌شود (9123456789 ⇒ 09123456789). */
function normalizePhone(v) {
  return normalizeMobile(v) || String(v == null ? '' : v)
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/\D/g, '');
}

function pull(store, actor, params) {
  const since = String(params.since || EPOCH);
  const requested = String(params.collections || '').split(',').map(s => s.trim()).filter(Boolean);
  const list = requested.length ? requested : DEFAULT_COLLECTIONS;
  const scope = policy.buildScope(store, actor.user);
  const collections = {};
  const deleted = [];
  let more = false;
  let nextSince = null;

  for (const name of list) {
    if (!policy.collectionAllowed(name) || !policy.canRead(actor.role, name)) continue;
    const rows = store.changedSince(name, since, ROW_LIMIT + 1);
    const truncated = rows.length > ROW_LIMIT;
    const slice = truncated ? rows.slice(0, ROW_LIMIT) : rows;
    const out = [];
    for (const r of slice) {
      let data;
      try { data = JSON.parse(r.data); } catch (e) { continue; }
      if (r.deleted_at) {
        if (policy.rowInScope(scope, name, data)) deleted.push({ collection: name, id: r.id, at: r.updated_at });
        continue;
      }
      if (!policy.rowInScope(scope, name, data)) continue;
      data._version = r.version;
      /* رمزها فقط برای مدیر می‌آیند؛ بقیهٔ نقش‌ها حتی هش را نمی‌بینند */
      if (name === 'users' && actor.role !== 'manager') {
        delete data.password_hash; delete data.phone_hash; delete data.password_plain;
      }
      out.push(data);
    }
    if (out.length || truncated) collections[name] = out;
    if (truncated) {
      more = true;
      const last = slice[slice.length - 1].updated_at;
      if (!nextSince || last < nextSince) nextSince = last;
    }
  }

  return {
    ok: true,
    server_time: nowISO(),
    since,
    next_since: more ? nextSince : null,
    more,
    collections,
    deleted,
  };
}

function openConflict(store, actor, ctx, info) {
  return store.insert('conflicts', {
    kind: 'conflict', status: 'needs_review', decided_by: null, decided_at: null,
    collection: info.collection, record_id: info.record_id,
    local: info.local || {}, server: info.server || null,
    base_version: info.base_version == null ? null : Number(info.base_version),
    reported_by: actor && actor.user ? actor.user.id : null,
    device_id: ctx.device_id || null, created_at: nowISO(),
  });
}

/* D‑28: حل تعارض فقط با نقش مجاز و با ثبت هویت تصمیم‌گیرنده. */
function resolveConflict(store, actor, id, decision, ctx = {}) {
  const rec = store.get('conflicts', id);
  if (!rec) return { ok: false, error: 'not_found' };
  if (rec.status !== 'needs_review') return { ok: false, error: 'already_resolved' };
  if (!actor || actor.role !== 'manager') return { ok: false, error: 'forbidden' };
  if (decision !== 'local' && decision !== 'server') return { ok: false, error: 'bad_decision' };
  if (!policy.collectionAllowed(rec.collection) || !policy.canWrite(actor.role, rec.collection)) {
    return { ok: false, error: 'forbidden' };
  }
  let appliedTo = null;
  if (decision === 'local') {
    const data = Object.assign({}, rec.local || {});
    delete data._version;
    const cur = rec.record_id != null ? store.get(rec.collection, rec.record_id) : null;
    if (cur) appliedTo = store.update(rec.collection, cur.id, data);
    else appliedTo = store.insert(rec.collection, data, { id: rec.record_id != null ? rec.record_id : undefined });
  }
  const done = store.update('conflicts', rec.id, {
    status: 'resolved', decision, decided_by: actor.user.id,
    decided_role: actor.role, decided_at: nowISO(), device_id: ctx.device_id || null,
  });
  store.audit({
    user_id: actor.user.id, role: actor.role, device_id: ctx.device_id || null,
    collection: rec.collection, record_id: rec.record_id, action: 'conflict_resolve',
    before: { conflict: rec.id, decision: null }, after: { conflict: rec.id, decision }, ip: ctx.ip,
  });
  return { ok: true, conflict: done, record: appliedTo };
}

function noteRejected(store, actor, ctx, info) {
  return store.insert('conflicts', {
    kind: 'rejected', status: 'needs_review', decision: null, decided_by: null, decided_at: null,
    collection: info.collection, record_id: info.record_id == null ? null : Number(info.record_id),
    local: info.local || {}, server: info.server || null, reason: info.reason,
    reported_by: actor && actor.user ? actor.user.id : null,
    device_id: ctx.device_id || null, created_at: nowISO(),
  });
}

function push(store, actor, body, ctx = {}) {
  const ops = Array.isArray(body && body.ops) ? body.ops : [];
  if (ops.length > MAX_OPS) return { ok: false, error: 'too_many_ops', limit: MAX_OPS };

  const role = actor.role;
  const applied = [];
  const conflicts = [];
  const rejected = [];

  for (const op of ops) {
    const uid = String(op && op.uid || '');
    if (!uid || uid.length > 80) { rejected.push({ uid, error: 'bad_uid' }); continue; }
    const collection = String(op.collection || '');
    if (!policy.collectionAllowed(collection)) { rejected.push({ uid, error: 'unknown_collection' }); continue; }

    /* idempotency */
    if (store.syncSeen(uid)) { applied.push({ uid, duplicate: true }); continue; }

    const type = op.type === 'del' ? 'del' : 'put';
    let incoming = Object.assign({}, op.data || {});

    if (type === 'del') {
      const existing = op.id != null ? store.get(collection, op.id) : null;
      if (!existing) { rejected.push({ uid, error: 'not_found' }); continue; }
      if (role !== 'manager') {
        const c = noteRejected(store, actor, ctx, { collection, record_id: op.id, local: incoming, server: existing, reason: 'role_denied' });
        rejected.push({ uid, error: 'role_denied', conflict_id: c.id }); continue;
      }
      store.remove(collection, op.id);
      store.audit({ user_id: actor.user.id, role, device_id: ctx.device_id, collection, record_id: op.id, action: 'delete', before: existing, ip: ctx.ip });
      store.syncMark(uid, actor.user.id, 'deleted');
      applied.push({ uid, id: Number(op.id), deleted: true });
      continue;
    }

    /* شناسه: اگر داده شناسه دارد از آن، وگرنه ساخت شناسهٔ جدید */
    let id = op.id != null ? Number(op.id) : (incoming.id != null ? Number(incoming.id) : null);
    const existing = id != null ? store.get(collection, id) : null;

    /* F‑02: تغییر/ساخت نقش فقط با مدیر — پیش از هر مسیر دیگری، حتی پیش از OCC */
    if (collection === 'users' && role !== 'manager') {
      const roleChange = incoming.role !== undefined && (!existing || String(incoming.role) !== String(existing.role));
      if (roleChange) {
        const c = noteRejected(store, actor, ctx, { collection, record_id: id, local: incoming, reason: 'role_change_denied' });
        rejected.push({ uid, error: 'role_change_denied', conflict_id: c.id });
        continue;
      }
    }

    if (existing) {
      const base = op.base_version != null ? Number(op.base_version) : null;
      /* base=0 تنها برای به‌روزرسانی «اثر انگشت رمز» مجاز است؛ هر دادهٔ دیگر
         با base=0 قدیمی تلقی می‌شود تا OCC دور زده نشود (D‑28). */
      const verifierOnly = Object.keys(incoming).length > 0 && Object.keys(incoming).every(k => k === '__password_verifier');
      if (base != null && (base !== existing._version) && !(base === 0 && verifierOnly)) {
        /* D‑28: هر دو نسخه نگه داشته می‌شوند و برای تصمیم مجاز ثبت می‌گردند */
        const rec = openConflict(store, actor, ctx, { collection, record_id: Number(id), local: incoming, server: existing, base_version: base });
        conflicts.push({ uid, collection, id, server_version: existing._version, server: existing, conflict_id: rec.id });
        continue;
      }
    } else if (op.base_version != null && Number(op.base_version) > 0) {
      const rec = openConflict(store, actor, ctx, { collection, record_id: id != null ? Number(id) : null, local: incoming, server: null, base_version: Number(op.base_version) });
      conflicts.push({ uid, collection, id, server_version: 0, server: null, conflict_id: rec.id });
      continue;
    }

    /* کاربران: نام کاربری = شمارهٔ همراه (یکتا) و رمز اولیه = کد ملی */
    if (collection === 'users') {
      if (incoming.phone !== undefined) incoming.phone = normalizePhone(incoming.phone);
      ['father_phone', 'mother_phone', 'guardian_phone'].forEach(k => {
        if (incoming[k] !== undefined && incoming[k] !== '') incoming[k] = normalizePhone(incoming[k]);
      });
      if (incoming.phone) {
        const dup = auth.phoneTaken(store, incoming.phone, id != null ? id : null);
        if (dup) { rejected.push({ uid, error: 'duplicate_phone', detail: 'این شماره قبلاً برای ' + dup.name + ' ثبت شده' }); continue; }
      }
      /* F‑01: هیچ رمز خام/رمزنگاری‌شده‌ای از کلاینت پذیرفته نمی‌شود */
      delete incoming.password_plain;
      delete incoming.password_enc;
      /* F‑02: تغییر نقش فقط با مدیر — نه از همگام‌سازی/مسیرهای جانبی */
      if (incoming.role !== undefined && existing && String(incoming.role) !== String(existing.role) && role !== 'manager') {
        rejected.push({ uid, error: 'role_change_denied' });
        continue;
      }
      if (!existing && incoming.role !== undefined && role !== 'manager') {
        rejected.push({ uid, error: 'role_change_denied' });
        continue;
      }
      if (!existing) {
        incoming = auth.applyDefaultCredentials(incoming, store);
      } else {
        /* ویرایش نام/کلاس نباید رمز را پاک کند: هر فیلد رمزی که از دستگاه
           نیامده باشد، از همان رکورد سرور نگه داشته می‌شود. */
        for (const f of ['password_hash', 'phone_hash', 'password_enc', 'phone', 'national_id']) {
          if (incoming[f] === undefined && existing[f] !== undefined) incoming[f] = existing[f];
        }
      }
    }

    /* F‑05: زمینهٔ مستأجر فقط از سرور/نشست — هیچ school_id/tenant_id کلاینتی پذیرفته نمی‌شود */
    incoming = tenantCtx.stamp(incoming, actor);
    const gate = policy.canWriteRow(store, actor.user, role, collection, incoming, existing);
    if (!gate.ok) { rejected.push({ uid, error: gate.error }); continue; }

    let saved;
    try {
      if (existing) saved = store.update(collection, existing.id, incoming);
      else saved = store.insert(collection, incoming, { id: id != null ? id : undefined });
    } catch (e) {
      rejected.push({ uid, error: 'write_failed', detail: String(e.message || e).slice(0, 120) });
      continue;
    }

    if (['grades', 'attendance', 'users', 'leaves', 'discipline', 'internships'].includes(collection)) {
      store.audit({
        user_id: actor.user.id, role, device_id: ctx.device_id, collection, record_id: saved.id,
        action: existing ? 'update' : 'create', before: existing || null, after: saved, ip: ctx.ip,
      });
    }
    store.syncMark(uid, actor.user.id, 'ok');
    applied.push({ uid, id: saved.id, version: saved._version });
  }

  return { ok: true, server_time: nowISO(), applied, conflicts, rejected };
}

module.exports = { pull, push, resolveConflict, ROW_LIMIT, MAX_OPS };
