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
const path = require('path');
const s3mem = require('./s3mem');
const sync = require('./sync');
const util = require('./util');
const tenantCtx = require('./tenant-context');

const META = 'outbox:state';
/* ── پاکت امضاشده (F‑06) ─────────────────────────────────────────────
   هویت هر ثبت فقط از نشست/تیکت دستگاه و امضای همین سرور می‌آید.
   هر چیزی که کلاینت دربارهٔ user_id/role/tenant بگوید دور ریخته می‌شود. */
const ENVELOPE_V = 2;
const SIGN_KEY = 'outbox:sign-key';
const PENDING = 'outbox/pending/';
const DONE = 'outbox/done/';
const STATE = 'outbox/state/';
const MAX_ITEM_BYTES = 32 * 1024;
const MAX_DRAIN = 300;
const MAX_DEVICE_ITEMS = 200;
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

/* ── پاکت امضاشده: تنها شکل قابل‌اعتماد نوشتن در صندوقچه ─────────── */
/* مستأجرِ همین نصب/دستگاه — فقط از پیکربندی سرور، هرگز از درخواست */
function serverTenant(store) {
  const meta = Number(store.getMeta('tenant_school_id', null));
  if (Number.isFinite(meta) && meta > 0) return meta;
  const env = Number(process.env.PAYESH_SCHOOL_ID);
  if (Number.isFinite(env) && env > 0) return env;
  return 1;
}

/* کلید امضا به ازای هر مستأجر: پاکتِ مستأجر A با کلید مستأجر B معتبر نیست */
function tenantKeyName(tid) {
  return SIGN_KEY + ':' + Number(tid);
}
function signKey(store, tenantId) {
  const tid = Number(tenantId);
  if (!Number.isFinite(tid) || tid <= 0) return null;
  const rec = store.getMeta(tenantKeyName(tid), null);
  if (rec && rec.secret) return rec.secret;
  const secret = crypto.randomBytes(32).toString('hex');
  store.setMeta(tenantKeyName(tid), { secret, created_at: new Date().toISOString(), tenant_id: tid });
  return secret;
}
/* فقط خواندن — بررسی امضا هرگز کلید نمی‌سازد (fail-closed) */
function existingSignKey(store, tenantId) {
  const rec = store.getMeta(tenantKeyName(tenantId), null);
  return rec && rec.secret ? rec.secret : null;
}

/* فقط همین چند میدان امضا می‌شوند؛ ادعاهای هویتی کلاینت در فهرست نیستند */
function canonicalEnvelope(env) {
  return JSON.stringify({
    v: ENVELOPE_V,
    user_id: Number(env.user_id),
    role: String(env.role || ''),
    tenant_id: Number(env.tenant_id),
    school_id: Number(env.school_id),
    device_id: String(env.device_id || ''),
    issued_at: String(env.issued_at || ''),
    items: (env.items || []).map(i => ({ uid: String(i.uid || ''), op: i.op || null })),
  });
}

function envelopeMac(store, env) {
  const key = signKey(store, env.tenant_id);
  if (!key) return '';
  return crypto.createHmac('sha256', key).update(canonicalEnvelope(env)).digest('base64url');
}

/* هر ثبت فقط میدان‌های عملیاتی را نگه می‌دارد؛ user_id/role/tenant از بدنهٔ
   کلاینت هرگز در پاکت نمی‌نشیند. */
function cleanItems(items) {
  const out = [];
  for (const raw of (Array.isArray(items) ? items : [])) {
    if (!raw || !raw.op || !raw.op.collection) continue;
    const uid = String(raw.uid || '').slice(0, 80);
    if (!uid) continue;
    const op = {
      collection: String(raw.op.collection || '').slice(0, 60),
      type: raw.op.type === 'del' ? 'del' : 'put',
      id: raw.op.id == null ? null : Number(raw.op.id),
      /* F‑06: هر میدان مستأجر که کلاینت داخل داده گذاشته باشد حذف می‌شود؛
         مهرِ مستأجر فقط در لایهٔ اعمال (sync/tenant-context) زده می‌شود. */
      data: tenantCtx.sanitize(raw.op.data && typeof raw.op.data === 'object' ? raw.op.data : {}),
    };
    if (raw.op.base_version != null) op.base_version = Number(raw.op.base_version);
    if (op.type === 'put' && raw.op.base_device) op.base_device = String(raw.op.base_device).slice(0, 60);
    out.push({ uid, op, created_at: raw.created_at || new Date().toISOString() });
  }
  return out;
}

function buildEnvelope(store, { user, device, items }) {
  /* F‑06: مستأجر پاکت فقط از رکورد کاربر در پایگاه‌داده می‌آید */
  const tenantId = Number(user.tenant_id != null ? user.tenant_id : (user.school_id != null ? user.school_id : 1));
  const env = {
    v: ENVELOPE_V,
    user_id: Number(user.id),
    role: String(user.role || ''),
    tenant_id: tenantId,
    school_id: tenantId,
    device_id: String(device || '').slice(0, 60),
    issued_at: new Date().toISOString(),
    items: cleanItems(items),
  };
  env.sig = envelopeMac(store, env);
  return env;
}

/* بررسی امضا + هویتِ سمت‌سرور. نتیجهٔ نامعتبر ⇒ null (fail-closed) */
function verifyEnvelope(store, doc) {
  if (!doc || Number(doc.v) !== ENVELOPE_V || typeof doc.sig !== 'string') return null;
  const env = {
    v: ENVELOPE_V,
    user_id: Number(doc.user_id),
    role: String(doc.role || ''),
    tenant_id: Number(doc.tenant_id),
    school_id: Number(doc.school_id),
    device_id: String(doc.device_id || ''),
    issued_at: String(doc.issued_at || ''),
    items: Array.isArray(doc.items) ? doc.items : [],
    sig: String(doc.sig),
  };
  if (!env.user_id || !env.items.length || !env.tenant_id) return null;
  const key = existingSignKey(store, env.tenant_id);
  if (!key) return null;
  const a = Buffer.from(env.sig);
  const b = Buffer.from(crypto.createHmac('sha256', key).update(canonicalEnvelope(env)).digest('base64url'));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return env;
}

/* ── پذیرش پاکت در drain: امضا + تعلق مستأجر (هر دو لازم) ─────────────
   پاکتِ امضاشده برای مستأجر دیگر، حتی اگر امضایش درست باشد، در این نصب
   اعمال نمی‌شود (سناریوی صندوقچهٔ مشترک بین دو استقرار). */
function acceptEnvelope(store, doc) {
  const env = verifyEnvelope(store, doc);
  if (!env) return { ok: false, reason: 'client_identity_untrusted' };
  const here = serverTenant(store);
  if (Number(env.tenant_id) !== Number(here) || Number(env.school_id) !== Number(here)) {
    return { ok: false, reason: 'cross_tenant', env, expected: here };
  }
  return { ok: true, env };
}

/* ادعاهای هویتیِ کلاینت که هرگز به پاکت راه نمی‌یابند (برای گزارش) */
function ignoredClaims(claims) {
  const out = [];
  if (!claims || typeof claims !== 'object') return out;
  for (const [where, obj] of Object.entries(claims)) {
    if (!obj || typeof obj !== 'object') continue;
    for (const f of ['user_id', 'userId', 'role', 'tenant_id', 'tenantId', 'school_id', 'schoolId']) {
      if (Object.prototype.hasOwnProperty.call(obj, f)) out.push(where + '.' + f);
    }
  }
  return out;
}

/* ── پذیرش ثبت از گوشی/کلاینت: هویت از actor (نشست یا تیکت) ──────── */
async function submit(store, { user, device, items, claims } = {}) {
  if (!user) return { ok: false, error: 'unauthorized' };
  const clean = cleanItems(items);
  if (!clean.length) return { ok: true, accepted: 0, skipped: 'empty' };
  const cfg = await cloud(store);
  if (!cfg) return { ok: false, error: 'no_cloud', accepted: 0 };
  const dev = String(device || 'unknown').slice(0, 60);
  const key = keyOf(cfg, PENDING + 'device-' + dev + '.json');
  let existing = [];
  try {
    const prev = JSON.parse(await s3mem.get(cfg, key));
    const env = verifyEnvelope(store, prev);
    if (env && Number(env.user_id) === Number(user.id)) existing = env.items;
  } catch (e) { existing = []; }
  const byUid = new Map();
  for (const it of existing.concat(clean)) byUid.set(String(it.uid), it);
  const merged = [...byUid.values()].slice(-MAX_DEVICE_ITEMS);
  const env = buildEnvelope(store, { user, device: dev, items: merged });
  try {
    await s3mem.put(cfg, key, JSON.stringify(env));
  } catch (e) {
    writeMeta(store, { last_error: 'submit: ' + String(e.message || e).slice(0, 120) });
    return { ok: false, error: 'submit_failed', accepted: 0 };
  }
  writeMeta(store, { last_publish: new Date().toISOString() });
  /* F‑06: هر ادعای هویتی کلاینت گزارش می‌شود تا «نادیده گرفته شد» قابل اثبات باشد */
  const ignored = ignoredClaims(claims);
  return { ok: true, accepted: clean.length, pending: merged.length, device_file: key,
    uids: clean.map(i => i.uid), ignored_claims: ignored };
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
async function publish(store, items, actor) {
  /* F‑06: هویت از فراخوانِ سمت‌سرور (نشست یا پاکت امضاشده) می‌آید */
  if (!actor || !actor.user) return { ok: false, error: 'unauthorized', count: 0 };
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
      user_id: Number(actor.user.id),
      role: String(actor.role || actor.user.role || ''),
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
    device_id: ctx && ctx.device_id ? ctx.device_id : null,
    op: { collection: op.collection, type: op.type === 'del' ? 'del' : 'put', id: op.id, data: op.data, base_device: ctx && ctx.device_id },
  })), actor);
}

/* ── خواندن صندوقچه و اعمال آن ───────────────────────────────────── */
async function drain(store, { limit = MAX_DRAIN } = {}) {
  const cfg = await cloud(store);
  if (!cfg) return { ok: false, error: 'no_cloud', checked: 0, applied: 0 };
  /* فهرست صندوقچه گاهی یک لحظه قطع می‌شود؛ سه بار تلاش می‌کنیم تا یک
     اتصالِ لرزان، ثبت‌های خانه را «انگار خالی» نشان ندهد. */
  let listing = null, listErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      listing = await s3mem.list(cfg, { prefix: keyOf(cfg, PENDING), max: limit });
      break;
    } catch (e) {
      listErr = e;
      if (attempt < 2) await new Promise(r => setTimeout(r, attempt === 0 ? 250 : 800));
    }
  }
  if (!listing) {
    writeMeta(store, { last_error: 'list: ' + String((listErr && listErr.message) || listErr).slice(0, 120) });
    return {
      ok: false, error: 'list_failed', checked: 0, applied: 0, skipped: 0, rejected: 0,
      detail: String((listErr && listErr.message) || listErr).slice(0, 160),
    };
  }

  const out = { ok: true, checked: 0, applied: 0, skipped: 0, rejected: 0, details: [] };
  for (const row of listing.keys) {
    const key = row.key;
    if (!/\.json$/.test(key)) continue;
    out.checked++;
    let doc;
    try {
      doc = JSON.parse(await s3mem.get(cfg, key));
    } catch (e) {
      out.skipped++;
      continue;
    }
    /* ── F‑06: فقط پاکتِ امضاشدهٔ همین سرور پذیرفته می‌شود ────────────
       هویت (کاربر/نقش/مستأجر) از پاکتِ امضاشده می‌آید. هر فایل بدون امضای
       معتبر — از جمله فایل‌های قدیمی v1 که user_id را کلاینت نوشته — قرنطینه
       می‌شود و هرگز اعمال نمی‌گردد (بدون حذف: برای بازرسی نگه داشته می‌شود). */
    const verdict = acceptEnvelope(store, doc);
    const env = verdict.ok ? verdict.env : null;
    if (!env) {
      out.rejected++;
      if (verdict.reason === 'cross_tenant') out.cross_tenant = (out.cross_tenant || 0) + 1;
      else out.untrusted = (out.untrusted || 0) + 1;
      try {
        await s3mem.put(cfg, keyOf(cfg, 'outbox/quarantine/' + path.basename(key)),
          JSON.stringify({ reason: verdict.reason, expected_tenant: verdict.expected || null,
            quarantined_at: new Date().toISOString(), raw: doc }));
        await s3mem.remove(cfg, key);
      } catch (e) { /* اگر قرنطینه نشد، فایل می‌ماند و دفعهٔ بعد هم رد می‌شود */ }
      continue;
    }

    const user = store.get('users', Number(env.user_id));
    if (!user || user.active === 0 || user.active === false) {
      out.rejected++;
      try { await s3mem.remove(cfg, key); } catch (e) { /* */ }
      continue;
    }
    /* نقش و مستأجر از خودِ کاربرِ پایگاه داده خوانده می‌شود، نه از پاکت هم */
    const actor = { user, role: user.role, device: null };

    for (const item of env.items) {
      const uid = String((item && item.uid) || '').slice(0, 80);
      if (!uid || !item.op) { out.skipped++; continue; }

      /* یک‌بار اعمال شده؟ */
      const doneKey = keyOf(cfg, DONE + uid + '.json');
      let already = false;
      try {
        const marker = await s3mem.get(cfg, doneKey);
        already = !!marker;
      } catch (e) { already = false; }

      if (already) { out.skipped++; continue; }

      /* تغییر رمز از روی گوشی: فقط «نسخهٔ قابل‌بررسی» (PBKDF2) و فقط برای
         خودِ همان کاربرِ پاکت پذیرفته می‌شود. */
      const opData = (item.op && item.op.data) || {};
      const verifier = opData.__password_verifier;
      if (item.op.collection === 'users' && verifier && Number(item.op.id) === Number(user.id)) {
        store.update('users', Number(item.op.id), { password_hash: String(verifier), phone_hash: String(verifier) });
        try { store.audit({ user_id: user.id, role: user.role, action: 'password_change_phone', collection: 'users', record_id: Number(item.op.id) }); } catch (e) { /* noop */ }
        out.applied++;
        await markDone(store, cfg, doneKey, uid, 'password');
        continue;
      }

      const op = Object.assign({}, item.op, { uid });
      const res = sync.push(store, actor, { ops: [op] }, { device_id: env.device_id || null, outbox: true });
      const okItem = (res.applied || []).length > 0;
      if (okItem) out.applied++;
      else out.rejected++;
      out.details.push({ uid, applied: okItem, rejected: res.rejected || [] });
      await markDone(store, cfg, doneKey, uid, okItem ? 'applied' : 'rejected');
    }

    /* ثبت‌ها اعمال و مُهر شدند؛ خودِ فایل دیگر لازم نیست */
    try { await s3mem.remove(cfg, key); } catch (e) { /* */ }
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
  return util.normDigits(u && u.phone);
}

/* نام کاربریِ ورود: شمارهٔ همراه، و اگر نداشت کد ملی — همان قاعده‌ای که
   در auth.credentialsFor هست، تا ولیِ بی‌شماره هم روی گوشی وارد شود. */
function loginKey(u) {
  const phone = phoneKey(u);
  if (phone.length >= 10) return phone;
  const nid = util.normDigits(u && u.national_id);
  return nid.length === 10 ? nid : '';
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
    const login = loginKey(u);
    if (!login || !u.phone_hash) continue;
    const stable = JSON.stringify({
      v: 1, login, phone: phoneKey(u), verifier: u.phone_hash,
      user: { id: u.id, name: u.name, role: u.role, class_id: u.class_id || null, phone: phoneKey(u), active: u.active !== false },
    });
    const body = JSON.stringify(Object.assign(JSON.parse(stable), { at: new Date().toISOString() }));
    try {
      if (await putIfChanged(cfg, keyOf(cfg, 'auth/' + login + '.json'), body, stable)) count++;
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

/* همان بستهٔ سراسری که گوشی می‌بیند — برای سرو کردن مستقیم از سرور */
function corePayload(store) {
  const core = { v: 1, school: (store.all('schools') || [])[0] || null, collections: {}, directory: directory(store) };
  for (const c of CORE_COLLECTIONS) {
    try { core.collections[c] = (store.all(c) || []).map(safeRow); } catch (e) { core.collections[c] = []; }
  }
  core.at = new Date().toISOString();
  return core;
}

async function publishData(store) {
  const cfg = await cloud(store);
  if (!cfg) return { ok: false, error: 'no_cloud', count: 0 };
  const core = corePayload(store);
  delete core.at;
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
  submit, verifyEnvelope, buildEnvelope, acceptEnvelope, serverTenant, signKey, ignoredClaims,
  corePayload, directory,
  publish, mirror, drain, pushSnapshot, readSnapshot, state, start, stop, putIfChanged, forgetPutHashes,
  publishAuth, publishData, publishAll, personData, CORE_COLLECTIONS, PERSON_COLLECTIONS,
  SERVER_ROLES, summary, PENDING, DONE, STATE, loginKey,
};
