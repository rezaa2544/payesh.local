'use strict';
/* ═══════════════════════════════════════════════════════════════════
   صندوقچهٔ آفلاین — payesh/outbox/…

   چرا: مدرسه شب‌ها خاموش است. اگر کسی (در خانه) با گوشی یا رایانه
   چیزی ثبت کند، همان ثبت در صندوقچهٔ ابری (فقط «حافظه»، هیچ سروری)
   گذاشته می‌شود. اولین دستگاهی که روشن شود — هر دستگاهی که اجازهٔ
   نقش داشته باشد — صندوقچه را می‌خواند و ثبت‌ها را روی دادهٔ خودش
   اعمال می‌کند. نقش هر ثبت همیشه از پایگاه دادهٔ همان دستگاه خوانده
   می‌شود، پس محدودیت‌های نقش سر جای خودشان می‌مانند.

   ساختار صندوقچه (نسبت به پیشوند payesh/):
     outbox/pending/<uid>.json   ← ثبتی که هنوز اعمال نشده
     outbox/done/<uid>.json      ← نشان «اعمال شد» (جلوگیری از تکرار)
     outbox/state/<sid>.json     ← خلاصهٔ هر دانش‌آموز برای اولیا
   ═══════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const s3mem = require('./s3mem');
const sync = require('./sync');

const META = 'outbox:state';
const PENDING = 'outbox/pending/';
const DONE = 'outbox/done/';
const STATE = 'outbox/state/';
const MAX_ITEM_BYTES = 32 * 1024;
const MAX_DRAIN = 300;
/* نقش‌هایی که اجازه دارند «سرور» شوند و صندوقچه را اعمال کنند */
const SERVER_ROLES = new Set(['manager', 'vice', 'teacher', 'staff']);

/* نوشتن فقط اگر محتوا عوض شده باشد — «هر ثانیه نوشتن» نباید پهنای‌باند بسوزاند */
const PUT_HASH = new Map();
async function putIfChanged(cfg, key, text, stable) {
  /* کلید کش باید «صندوقچه + مسیر» باشد؛ وگرنه با عوض شدن صندوقچه،
     فایل به صندوقچهٔ تازه نوشته نمی‌شود. */
  const id = String(cfg.endpoint || '') + '|' + String(cfg.bucket || '') + '|' + key;
  const h = crypto.createHash('sha1').update(String(stable == null ? text : stable)).digest('hex');
  if (PUT_HASH.get(id) === h) return false;
  await s3mem.put(cfg, key, text);
  PUT_HASH.set(id, h);
  return true;
}
function forgetPutHashes(prefix) {
  for (const k of [...PUT_HASH.keys()]) if (!prefix || k.includes(prefix)) PUT_HASH.delete(k);
}

function keyOf(cfg, rel) {
  return String(cfg.prefix || 'payesh/') + rel;
}

function readMeta(store) {
  try {
    const raw = JSON.parse(store.getMeta(META, '{}')) || {};
    return {
      last_drain: raw.last_drain || null,
      last_publish: raw.last_publish || null,
      last_snapshot: raw.last_snapshot || null,
      applied_total: Number(raw.applied_total || 0),
      pending_remote: Number(raw.pending_remote || 0),
      last_error: raw.last_error || null,
    };
  } catch (e) {
    return { last_drain: null, last_publish: null, last_snapshot: null, applied_total: 0, pending_remote: 0, last_error: null };
  }
}

function writeMeta(store, patch) {
  const next = Object.assign(readMeta(store), patch || {});
  try { store.setMeta(META, JSON.stringify(next)); } catch (e) { /* noop */ }
  return next;
}

async function cloud(store) {
  try {
    const c = await s3mem.ensureBucket(store);
    return c && c.enabled ? c : null;
  } catch (e) {
    return null;
  }
}

function newUid(prefix) {
  return (prefix || 'ob') + '-' + Date.now().toString(36) + '-' +
    Math.random().toString(36).slice(2, 8);
}

/* ── نوشتن یک ثبت در صندوقچه ─────────────────────────────────────── */
async function publish(store, items) {
  const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
  if (!list.length) return { ok: true, count: 0, skipped: 'empty' };
  const cfg = await cloud(store);
  if (!cfg) return { ok: false, error: 'no_cloud', count: 0 };
  let count = 0;
  for (const item of list) {
    const uid = String(item.uid || '').slice(0, 80) || newUid();
    const body = JSON.stringify({
      v: 1,
      uid,
      user_id: Number(item.user_id) || null,
      role: item.role || null,
      device_id: item.device_id || null,
      op: item.op || null,
      created_at: item.created_at || new Date().toISOString(),
    });
    if (body.length > MAX_ITEM_BYTES) continue;
    try {
      await s3mem.put(cfg, keyOf(cfg, PENDING + uid + '.json'), body);
      count++;
    } catch (e) {
      writeMeta(store, { last_error: 'publish: ' + String(e.message || e).slice(0, 120) });
      return { ok: false, error: 'publish_failed', detail: String(e.message || e).slice(0, 160), count };
    }
  }
  if (count) writeMeta(store, { last_publish: new Date().toISOString() });
  return { ok: true, count };
}

/* آینه‌کردن ثبت‌های تازه‌ای که همین دستگاه اعمال کرده — تا اگر دستگاه
   دیگری «مدرسه» باشد، همان‌ها را هم ببیند. تکرارشدن ضرری ندارد چون هر
   ثبت شناسهٔ یکتا دارد. */
async function mirror(store, actor, ops, ctx) {
  if (!Array.isArray(ops) || !ops.length) return { ok: true, count: 0 };
  if (!SERVER_ROLES.has(actor.role)) return { ok: true, count: 0, skipped: 'role' };
  return publish(store, ops.map(op => ({
    uid: op && op.uid,
    user_id: actor.user ? actor.user.id : null,
    role: actor.role,
    device_id: ctx && ctx.device_id ? ctx.device_id : null,
    op: { collection: op.collection, type: op.type === 'del' ? 'del' : 'put', id: op.id, data: op.data, base_device: ctx && ctx.device_id },
  })));
}

/* ── خواندن صندوقچه و اعمال آن ───────────────────────────────────── */
async function drain(store, { limit = MAX_DRAIN } = {}) {
  const cfg = await cloud(store);
  if (!cfg) return { ok: false, error: 'no_cloud', checked: 0, applied: 0 };
  let listing;
  try {
    listing = await s3mem.list(cfg, { prefix: keyOf(cfg, PENDING), max: limit });
  } catch (e) {
    writeMeta(store, { last_error: 'list: ' + String(e.message || e).slice(0, 120) });
    return { ok: false, error: 'list_failed', detail: String(e.message || e).slice(0, 160), applied: 0 };
  }

  const out = { ok: true, checked: 0, applied: 0, skipped: 0, rejected: 0, details: [] };
  for (const row of listing.keys) {
    const key = row.key;
    if (!/\.json$/.test(key)) continue;
    out.checked++;
    let item;
    try {
      item = JSON.parse(await s3mem.get(cfg, key));
    } catch (e) {
      out.skipped++;
      continue;
    }
    const uid = String(item && item.uid || '').slice(0, 80);
    if (!uid || !item.op) { out.skipped++; continue; }

    /* یک‌بار اعمال شده؟ */
    const doneKey = keyOf(cfg, DONE + uid + '.json');
    let already = false;
    try {
      const marker = await s3mem.get(cfg, doneKey);
      already = !!marker;
    } catch (e) { already = false; }

    if (!already) {
      const user = item.user_id != null ? store.get('users', Number(item.user_id)) : null;
      if (!user || user.active === 0 || user.active === false) {
        out.rejected++;
        await markDone(store, cfg, doneKey, uid, 'no_user');
        continue;
      }
      /* تغییر رمز از روی گوشی: گوشی فقط «نسخهٔ قابل‌بررسی» (PBKDF2) را
         می‌فرستد و آن هم فقط برای خودِ همان کاربر پذیرفته می‌شود. */
      const opData = (item.op && item.op.data) || {};
      const verifier = opData.__password_verifier;
      if (item.op.collection === 'users' && verifier && Number(item.op.id) === Number(item.user_id)) {
        store.update('users', Number(item.op.id), { password_hash: String(verifier), phone_hash: String(verifier) });
        try { store.audit({ user_id: user.id, role: user.role, action: 'password_change_phone', collection: 'users', record_id: Number(item.op.id) }); } catch (e) { /* noop */ }
        out.applied++;
        await markDone(store, cfg, doneKey, uid, 'password');
        try { await s3mem.remove(cfg, key); } catch (e) { /* */ }
        continue;
      }

      const actor = { user, role: user.role, device: null };
      const op = Object.assign({}, item.op, { uid });
      const res = sync.push(store, actor, { ops: [op] }, { device_id: item.device_id || null, outbox: true });
      const okItem = (res.applied || []).length > 0;
      if (okItem) out.applied++;
      else out.rejected++;
      out.details.push({ uid, applied: okItem, rejected: res.rejected || [] });
      await markDone(store, cfg, doneKey, uid, okItem ? 'applied' : 'rejected');
      try { await s3mem.remove(cfg, key); } catch (e) { /* */ }
    } else {
      out.skipped++;
      try { await s3mem.remove(cfg, key); } catch (e) { /* */ }
    }
  }

  const prev = readMeta(store);
  writeMeta(store, {
    last_drain: new Date().toISOString(),
    applied_total: prev.applied_total + out.applied,
    pending_remote: Math.max(0, listing.keys.length - out.checked),
    last_error: null,
  });
  if (out.applied) {
    try {
      store.audit({ role: 'system', action: 'outbox_drain', collection: 'system', after: { applied: out.applied, checked: out.checked } });
    } catch (e) { /* noop */ }
  }
  return out;
}

async function markDone(store, cfg, key, uid, result) {
  try {
    await s3mem.put(cfg, key, JSON.stringify({ uid, result, at: new Date().toISOString() }));
  } catch (e) { /* بدون نشان هم دفعهٔ بعد دوباره امتحان می‌شود */ }
}

/* ── خلاصهٔ هر دانش‌آموز برای اولیا (فقط چند عدد، بدون متن پرونده) ── */
function summary(store, student) {
  const rows = (collection) => {
    try {
      return (store.all(collection) || []).filter(r => Number(r.student_id) === Number(student.id));
    } catch (e) { return []; }
  };
  const attendance = rows('attendance');
  const absents = attendance.filter(a => String(a.status || '') === 'absent').length;
  const grades = rows('grades');
  const lastGrade = grades.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0] || null;
  const leaves = rows('leaves');
  const pendingLeaves = leaves.filter(l => !l.status || String(l.status) === 'pending').length;
  return {
    v: 1,
    student_id: student.id,
    name: student.name || '',
    at: new Date().toISOString(),
    attendance: { total: attendance.length, absents },
    grades: { count: grades.length, last: lastGrade ? { date: lastGrade.date || null, value: lastGrade.value != null ? lastGrade.value : null } : null },
    leaves: { pending: pendingLeaves },
  };
}

async function pushSnapshot(store, { students } = {}) {
  const cfg = await cloud(store);
  if (!cfg) return { ok: false, error: 'no_cloud', count: 0 };
  let list = students;
  if (!Array.isArray(list)) {
    try { list = (store.all('users') || []).filter(u => u.role === 'student'); } catch (e) { list = []; }
  }
  let count = 0;
  for (const st of list) {
    if (!st || st.id == null || st.role !== 'student') continue;
    try {
      if (await putIfChanged(cfg, keyOf(cfg, STATE + st.id + '.json'), JSON.stringify(summary(store, st)))) count++;
    } catch (e) {
      writeMeta(store, { last_error: 'snapshot: ' + String(e.message || e).slice(0, 120) });
      break;
    }
  }
  if (count) writeMeta(store, { last_snapshot: new Date().toISOString() });
  return { ok: true, count };
}

async function readSnapshot(store, studentId) {
  const cfg = await cloud(store);
  if (!cfg) return { ok: false, error: 'no_cloud' };
  try {
    const text = await s3mem.get(cfg, keyOf(cfg, STATE + Number(studentId) + '.json'));
    return { ok: true, snapshot: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: 'not_found' };
  }
}

/* ── وضعیت برای رابط کاربری ──────────────────────────────────────── */
async function state(store) {
  const meta = readMeta(store);
  const cfg = await cloud(store);
  let pending = null;
  if (cfg) {
    try {
      const l = await s3mem.list(cfg, { prefix: keyOf(cfg, PENDING), max: 1 });
      pending = l.keys.length;
    } catch (e) { pending = null; }
  }
  return {
    ok: true,
    cloud: !!cfg,
    bucket: cfg ? cfg.bucket : null,
    pending,
    last_drain: meta.last_drain,
    last_publish: meta.last_publish,
    last_snapshot: meta.last_snapshot,
    applied_total: meta.applied_total,
    last_error: meta.last_error,
    roles: Array.from(SERVER_ROLES),
  };
}

/* ── خودکار: اولین دستگاهی که روشن است، هر چند دقیقه صندوقچه را می‌کشد ── */
let timer = null;
let running = false;
function start(store, { everyMs = 3 * 60_000 } = {}) {
  if (timer) clearInterval(timer);
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const cfg = await cloud(store);
      if (cfg) {
        await drain(store);
        await pushSnapshot(store);
        await publishAll(store);
      }
    } catch (e) {
      writeMeta(store, { last_error: String(e.message || e).slice(0, 120) });
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 40_000).unref?.();
  timer = setInterval(tick, everyMs);
  timer.unref?.();
  return { ok: true, everyMs };
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}


/* ═══════════════════════════════════════════════════════════════════
   نسخهٔ گوشی (بدون سرور): برنامهٔ اندروید/ویندوز خودش «کل برنامه» است؛
   پس باید هم بتواند شماره+رمز را خودش بررسی کند و هم دادهٔ لازم را
   داشته باشد. هر دو در همان صندوقچهٔ ابری منتشر می‌شوند:

     auth/<phone>.json       ← برای بررسی رمز روی گوشی (PBKDF2)
     data/core.json          ← کلاس‌ها، درس‌ها، برنامه، اطلاعیه‌ها، فهرست نام‌ها
     data/person/<id>.json   ← فقط دادهٔ خودِ همان کاربر (و فرزندانش)
   ═══════════════════════════════════════════════════════════════════ */
const CORE_COLLECTIONS = ['schools', 'school_years', 'classes', 'subjects', 'lookups', 'schedule', 'announcements', 'bells'];
const PERSON_COLLECTIONS = ['attendance', 'grades', 'leaves', 'internships', 'discipline', 'notes', 'staff_attendance'];

function phoneKey(u) {
  return String(u.phone || '').replace(/\D/g, '');
}

function safeRow(row) {
  const out = Object.assign({}, row);
  delete out.password_hash;
  delete out.phone_hash;
  delete out.password_plain;
  delete out.pin_hash;
  return out;
}

function directory(store) {
  return (store.all('users') || []).map(u => ({
    id: u.id, name: u.name, role: u.role, class_id: u.class_id || null,
    phone: u.role === 'manager' ? u.phone || '' : '', active: u.active !== false,
  }));
}

async function publishAuth(store) {
  const cfg = await cloud(store);
  if (!cfg) return { ok: false, error: 'no_cloud', count: 0 };
  let count = 0;
  for (const u of (store.all('users') || [])) {
    const phone = phoneKey(u);
    if (!phone || !u.phone_hash) continue;
    const stable = JSON.stringify({
      v: 1, phone, verifier: u.phone_hash,
      user: { id: u.id, name: u.name, role: u.role, class_id: u.class_id || null, phone, active: u.active !== false },
    });
    const body = JSON.stringify(Object.assign(JSON.parse(stable), { at: new Date().toISOString() }));
    try {
      if (await putIfChanged(cfg, keyOf(cfg, 'auth/' + phone + '.json'), body, stable)) count++;
    } catch (e) {
      writeMeta(store, { last_error: 'auth: ' + String(e.message || e).slice(0, 120) });
      break;
    }
  }
  return { ok: true, count };
}

function personData(store, user) {
  const ids = new Set([Number(user.id)]);
  if (user.role === 'parent') {
    for (const l of (store.all('parent_links') || [])) {
      if (Number(l.parent_id) === Number(user.id)) ids.add(Number(l.student_id));
    }
  }
  const out = { v: 1, user_id: user.id, role: user.role, at: new Date().toISOString(), collections: {} };
  for (const c of PERSON_COLLECTIONS) {
    let rows = [];
    try { rows = store.all(c) || []; } catch (e) { rows = []; }
    out.collections[c] = rows
      .filter(r => ids.has(Number(r.student_id)) || (c === 'staff_attendance' && ids.has(Number(r.user_id))))
      .map(safeRow);
  }
  /* کاربر فقط خودش را در فهرست می‌بیند (بدون دادهٔ دیگران) */
  out.me = safeRow(store.get('users', user.id) || {});
  if (user.role === 'parent') {
    out.children = [];
    for (const sid of ids) {
      if (Number(sid) === Number(user.id)) continue;
      const st = store.get('users', Number(sid));
      if (st) out.children.push({ id: st.id, name: st.name, class_id: st.class_id || null, role: st.role });
    }
  }
  return out;
}

async function publishData(store) {
  const cfg = await cloud(store);
  if (!cfg) return { ok: false, error: 'no_cloud', count: 0 };
  const core = { v: 1, school: (store.all('schools') || [])[0] || null, collections: {}, directory: directory(store) };
  for (const c of CORE_COLLECTIONS) {
    try { core.collections[c] = (store.all(c) || []).map(safeRow); } catch (e) { core.collections[c] = []; }
  }
  let count = 0;
  try {
    /* «at» هر ثانیه عوض می‌شود؛ برای مقایسه حذفش می‌کنیم تا هر ثانیه ننویسیم */
    const stableCore = JSON.stringify(Object.assign({}, core, { directory: core.directory }));
    core.at = new Date().toISOString();
    if (await putIfChanged(cfg, keyOf(cfg, 'data/core.json'), JSON.stringify(core), stableCore)) count++;
  } catch (e) {
    writeMeta(store, { last_error: 'data: ' + String(e.message || e).slice(0, 120) });
    return { ok: false, error: 'publish_failed', detail: String(e.message || e), count };
  }
  for (const u of (store.all('users') || [])) {
    if (u.active === false) continue;
    if (!['manager', 'vice', 'teacher', 'parent', 'student', 'staff', 'counselor'].includes(u.role)) continue;
    try {
      const pd = personData(store, u);
      const stablePerson = JSON.stringify(Object.assign({}, pd, { at: undefined }));
      if (await putIfChanged(cfg, keyOf(cfg, 'data/person/' + u.id + '.json'), JSON.stringify(pd), stablePerson)) count++;
    } catch (e) { break; }
  }
  writeMeta(store, { last_data: new Date().toISOString() });
  return { ok: true, count };
}

async function publishAll(store) {
  const a = await publishAuth(store);
  const d = await publishData(store);
  return { auth: a, data: d };
}

module.exports = {
  publish, mirror, drain, pushSnapshot, readSnapshot, state, start, stop, putIfChanged, forgetPutHashes,
  publishAuth, publishData, publishAll, personData, CORE_COLLECTIONS, PERSON_COLLECTIONS,
  SERVER_ROLES, summary, PENDING, DONE, STATE,
};
