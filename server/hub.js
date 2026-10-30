'use strict';
/* ═══════════════════════════════════════════════════════════════════
   اتصال مدرسه به Hub ابری
   • هر دانش‌آموز یک «نمای خانواده» دارد که با کلید مدرسه امضا می‌شود
   • هنگام روشن بودن سیستم، تغییرات به Hub فرستاده می‌شود
   • درخواست‌های ثبت‌شده در Hub (مثلاً مرخصی شبانه) کشیده و اعمال می‌شود
   ═══════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const { nowISO, sha256 } = require('./util');
const cfg = require('./config');

function schoolKey(store) {
  let k = cfg.getMeta(store, 'hub_key');
  if (!k) {
    k = crypto.randomBytes(24).toString('hex');
    cfg.setMeta(store, 'hub_key', k);
  }
  return k;
}

function familyToken(store, studentId) {
  return crypto.createHmac('sha256', schoolKey(store)).update('family:' + Number(studentId)).digest('hex');
}
function familyKey(store, studentId) {
  return sha256(familyToken(store, studentId));
}

/* ── ساخت خلاصهٔ هر دانش‌آموز ─────────────────────────────────────── */
function buildProjection(store, student, announcements) {
  const sid = Number(student.id);
  const cls = student.class_id ? store.get('classes', student.class_id) : null;
  const att = store.all('attendance').filter(a => Number(a.student_id) === sid);
  const present = att.filter(a => a.status === 'present').length;
  const absent = att.filter(a => a.status === 'absent').length;
  const late = att.filter(a => a.status === 'late').length;
  const percent = att.length ? Math.round((present / att.length) * 100) : null;

  const subjects = new Map(store.all('subjects').map(s => [Number(s.id), s.name]));
  const grades = store.all('grades')
    .filter(g => Number(g.student_id) === sid)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .slice(0, 20)
    .map(g => ({
      subject: subjects.get(Number(g.subject_id)) || '',
      term: g.term || '', score: g.score,
      practical: g.practical_score != null ? g.practical_score : null,
      status: g.status || 'pending',
    }));

  const recent = att
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 12)
    .map(a => ({ date: a.date, status: a.status }));

  return {
    name: student.name,
    class_name: cls ? cls.name : '',
    attendance: { percent, present, absent, late, total: att.length, recent },
    grades,
    announcements: announcements.slice(0, 5).map(a => ({ title: a.title, date: a.date, severity: a.severity || 'info' })),
    generated_at: nowISO(),
  };
}

function pushedHashes(store) {
  return store.getMeta('hub:pushed', {}) || {};
}

/* ── ارسال تغییرات ────────────────────────────────────────────────── */
async function push(store, { force = false, batch = 200 } = {}) {
  const h = cfg.hubConfig(store);
  if (!h.enabled || !h.url) return { ok: false, error: 'hub_disabled' };

  const announcements = store.all('announcements').sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const students = store.all('users').filter(u => u.role === 'student' && u.active !== false);
  const hashes = pushedHashes(store);

  const rows = [];
  for (const st of students) {
    const payload = buildProjection(store, st, announcements);
    /* زمان تولید نباید در مقایسهٔ تغییرات اثر بگذارد، وگرنه هر بار «تغییر» می‌بینیم */
    const stable = Object.assign({}, payload);
    delete stable.generated_at;
    const hash = sha256(JSON.stringify(stable));
    if (!force && hashes[st.id] === hash) continue;
    rows.push({
      student_id: Number(st.id),
      family_key: familyKey(store, st.id),
      updated_at: nowISO(),
      payload,
      _hash: hash,
    });
  }

  let sent = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    const res = await fetch(h.url.replace(/\/+$/, '') + '/v1/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + schoolKey(store) },
      body: JSON.stringify({ rows: chunk.map(r => ({ student_id: r.student_id, family_key: r.family_key, updated_at: r.updated_at, payload: r.payload })) }),
      signal: AbortSignal.timeout(15000),
    });
    const out = await res.json();
    if (!out.ok) throw new Error(out.error || 'hub_push_failed');
    for (const r of chunk) hashes[r.student_id] = r._hash;
    sent += chunk.length;
  }
  store.setMeta('hub:pushed', hashes);
  store.setMeta('hub:last_push', nowISO());
  return { ok: true, sent, total: students.length };
}

/* ── کشیدن صف درخواست‌ها ──────────────────────────────────────────── */
async function drain(store) {
  const h = cfg.hubConfig(store);
  if (!h.enabled || !h.url) return { ok: false, error: 'hub_disabled' };
  const base = h.url.replace(/\/+$/, '');

  const res = await fetch(base + '/v1/outbox?limit=100', {
    headers: { authorization: 'Bearer ' + schoolKey(store) },
    signal: AbortSignal.timeout(15000),
  });
  const out = await res.json();
  if (!out.ok) throw new Error(out.error || 'hub_pull_failed');

  const applied = [];
  const ack = [];
  for (const row of out.rows || []) {
    ack.push(row.id);
    const seenKey = 'hub:seen:' + row.uid;
    if (store.getMeta(seenKey, null)) continue;
    let payload = {};
    try { payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {}); } catch (e) { payload = {}; }

    if (row.kind === 'leave') {
      const student = store.get('users', row.student_id);
      if (!student) continue;
      store.insert('leaves', {
        student_id: Number(row.student_id),
        date: String(payload.date || nowISO().slice(0, 10)),
        reason: String(payload.reason || 'درخواست از برنامه (آفلاین)').slice(0, 300),
        status: 'pending',
        school_id: 1,
        created_by: null,
        source: 'hub',
      });
      applied.push({ kind: 'leave', student_id: row.student_id, uid: row.uid });
      store.audit({ role: 'system', action: 'hub_leave_applied', collection: 'leaves', after: { uid: row.uid, student_id: row.student_id } });
    }
    store.setMeta(seenKey, { at: nowISO() });
  }

  if (ack.length) {
    await fetch(base + '/v1/outbox/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + schoolKey(store) },
      body: JSON.stringify({ ids: ack }),
      signal: AbortSignal.timeout(15000),
    });
  }
  store.setMeta('hub:last_drain', nowISO());
  return { ok: true, fetched: (out.rows || []).length, applied: applied.length, items: applied };
}

/* ── همگام‌سازی کامل ──────────────────────────────────────────────── */
async function sync(store, opts = {}) {
  const results = {};
  try { results.push = await push(store, opts); } catch (e) { results.push = { ok: false, error: String(e.message || e) }; }
  try { results.drain = await drain(store); } catch (e) { results.drain = { ok: false, error: String(e.message || e) }; }
  return results;
}

function start(store, everyMs = 5 * 60_000) {
  let running = false;
  const tick = async () => {
    const h = cfg.hubConfig(store);
    if (!h.enabled || !h.url || running) return;
    running = true;
    try { await sync(store); } catch (e) { /* بی‌صدا */ }
    running = false;
  };
  setTimeout(tick, 20_000);
  return setInterval(tick, everyMs);
}

module.exports = { schoolKey, familyToken, familyKey, buildProjection, push, drain, sync, start };
