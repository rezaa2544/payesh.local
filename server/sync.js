'use strict';
/* ───────────────────────────────────────────────────────────────────
   همگام‌سازی — همان قرارداد پایش اصلی (ساده‌شده و تک‌مدرسه‌ای)
   Pull : دلتا بر اساس updated_at + tombstone + server_time
   Push : صف عملیات با idempotency، OCC (base_version) و gate نقش/اسکوپ
   ─────────────────────────────────────────────────────────────────── */
const { nowISO } = require('./util');
const policy = require('./policy');

const ROW_LIMIT = 3000;          /* سقف ردیف هر کالکشن در هر درخواست */
const MAX_OPS = 200;             /* سقف عملیات هر push (هم‌راستا با کلاینت) */
const EPOCH = '1970-01-01T00:00:00.000Z';

const DEFAULT_COLLECTIONS = [
  'schools', 'school_years', 'users', 'classes', 'subjects', 'schedule', 'bell_schedules',
  'attendance', 'grades', 'announcements', 'leaves', 'parent_links', 'internships',
  'staff_attendance', 'staff_posts', 'discipline', 'homework', 'exams', 'calendar',
];

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
    const incoming = Object.assign({}, op.data || {});

    if (type === 'del') {
      const existing = op.id != null ? store.get(collection, op.id) : null;
      if (!existing) { rejected.push({ uid, error: 'not_found' }); continue; }
      if (role !== 'manager') { rejected.push({ uid, error: 'role_denied' }); continue; }
      store.remove(collection, op.id);
      store.audit({ user_id: actor.user.id, role, device_id: ctx.device_id, collection, record_id: op.id, action: 'delete', before: existing, ip: ctx.ip });
      store.syncMark(uid, actor.user.id, 'deleted');
      applied.push({ uid, id: Number(op.id), deleted: true });
      continue;
    }

    /* شناسه: اگر داده شناسه دارد از آن، وگرنه ساخت شناسهٔ جدید */
    let id = op.id != null ? Number(op.id) : (incoming.id != null ? Number(incoming.id) : null);
    const existing = id != null ? store.get(collection, id) : null;

    if (existing) {
      const base = op.base_version != null ? Number(op.base_version) : null;
      if (base != null && base !== 0 && base !== existing._version) {
        conflicts.push({ uid, collection, id, server_version: existing._version, server: existing });
        continue;
      }
    } else if (op.base_version != null && Number(op.base_version) > 0) {
      conflicts.push({ uid, collection, id, server_version: 0, server: null });
      continue;
    }

    /* gate نقش + مالکیت */
    incoming.school_id = 1;
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

module.exports = { pull, push, ROW_LIMIT, MAX_OPS };
