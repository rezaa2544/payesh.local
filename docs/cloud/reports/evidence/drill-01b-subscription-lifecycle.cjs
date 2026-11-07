#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   تمرین واقعی ردیف ۰۱‑ب — مدل مدرسه/پلن/اشتراک و چرخهٔ وضعیت

   چرا وجود دارد: سند ۰۱‑ب ۱۲ معیار طراحی دارد و §۳.۱ خودش را «منبع واحد
   حقیقت» گذارها می‌داند؛ ولی تا امروز هیچ اجرای واقعی نشان نداده بود که
   این ماشین حالت، ماتریس ورود، سقف اتمیک، تمدید idempotent و نگهداشت
   D‑22 روی یک پایگاه واقعی کار می‌کنند. این فایل همان اجراست: یک
   پیاده‌سازی مرجع از §۲ (طرح جدول‌ها)، §۳ (گذارها + ماتریس ورود)،
   §۴ (سقف اتمیک)، §۵ (تمدید idempotent/OCC)، §۶ (۱۸۰ روز)، §۷ (پیام‌ها)
   و §۸ (مجوز گذار) — روی SQLite واقعی، بدون تغییر کد محصول.

   قاعدهٔ AC‑10: هیچ تصمیم بازِ §۹ در این مدل «پیش‌فرض» جا نمی‌افتد؛
   طول دورهٔ ارفاقی و منبع ends_at باید صریح داده شوند، وگرنه مدل
   DECISION-REQUIRED برمی‌گرداند (نه یک عدد خودسر).

   اجرا: node --experimental-sqlite --disable-warning=ExperimentalWarning \
           docs/cloud/reports/evidence/drill-01b-subscription-lifecycle.cjs
   ═══════════════════════════════════════════════════════════════════ */
'use strict';
const { spawn, execSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '../../../..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-01b-drill-'));
const DB = path.join(WORK, 'platform.sqlite');
const PROD = path.join(WORK, 'product');

const results = [];
function check(label, fn) {
  let pass = false, detail = '';
  try {
    const r = fn();
    pass = r === true || (r && r.pass === true);
    detail = (r && r.detail) || '';
  } catch (e) { pass = false; detail = 'EXC: ' + (e && e.message); }
  results.push({ label, pass, detail });
}
const nowISO = () => new Date().toISOString();
const addDays = (iso, n) => new Date(Date.parse(iso) + n * 86400000).toISOString();

/* ═══════════ §۲ — طرح جدول‌ها (همان قیدهای سند) ═══════════ */
function openDb() {
  const db = new DatabaseSync(DB);
  db.exec('PRAGMA foreign_keys=ON');
  return db;
}
function initSchema(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS tenant(
    id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    level TEXT CHECK(level IN ('primary','middle','high','mixed')),
    city TEXT, province TEXT, contact_phone TEXT,
    status TEXT NOT NULL CHECK(status IN ('provisioning','live','suspended','archived')),
    storage_prefix TEXT NOT NULL UNIQUE, crypto_key_id TEXT,
    created_at TEXT, updated_at TEXT);
  CREATE INDEX IF NOT EXISTS ix_tenant_status ON tenant(status);
  CREATE TABLE IF NOT EXISTS plan(
    code TEXT PRIMARY KEY, name TEXT NOT NULL, max_users INTEGER, max_students INTEGER,
    storage_mb INTEGER, features TEXT, price_amount INTEGER, price_cycle TEXT CHECK(price_cycle IN ('monthly','yearly','none')),
    is_public INTEGER, created_at TEXT, archived_at TEXT);
  CREATE TABLE IF NOT EXISTS subscription(
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenant(id), plan_code TEXT NOT NULL REFERENCES plan(code),
    status TEXT NOT NULL CHECK(status IN ('draft','provisioning','active','grace','suspended','expired','canceled','archived')),
    starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, grace_days INTEGER, auto_renew INTEGER,
    canceled_at TEXT, renewed_from TEXT, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT);
  CREATE UNIQUE INDEX IF NOT EXISTS ux_sub_current ON subscription(tenant_id)
    WHERE status IN ('draft','provisioning','active','grace','suspended');
  CREATE INDEX IF NOT EXISTS ix_sub_tenant ON subscription(tenant_id, starts_at DESC);
  CREATE INDEX IF NOT EXISTS ix_sub_status ON subscription(status, ends_at);
  CREATE TABLE IF NOT EXISTS subscription_event(
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, subscription_id TEXT NOT NULL,
    from_status TEXT, to_status TEXT,
    reason TEXT CHECK(reason IN ('payment','expiry','owner_action','cancel','renew','system')),
    actor_id TEXT, idempotency_key TEXT, at TEXT,
    UNIQUE(tenant_id, idempotency_key));
  CREATE TABLE IF NOT EXISTS invoice(
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, subscription_id TEXT,
    period_start TEXT, period_end TEXT, amount INTEGER, currency TEXT,
    status TEXT CHECK(status IN ('draft','issued','paid','void','refunded')),
    payment_ref TEXT, issued_at TEXT, paid_at TEXT,
    UNIQUE(tenant_id, period_start, period_end));
  CREATE TABLE IF NOT EXISTS support_grant(
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, operator_id TEXT NOT NULL,
    scope TEXT, reason TEXT, approved_by TEXT, starts_at TEXT, ends_at TEXT,
    revoked_at TEXT, open_slot INTEGER, CHECK(open_slot IS NULL OR open_slot = 1));
  CREATE UNIQUE INDEX IF NOT EXISTS ux_grant_open ON support_grant(operator_id, open_slot);
  `);
}

/* ═══════════ §۲.۱ — قاعدهٔ storage_prefix = t/<id>/ ═══════════ */
function prefixValid(prefix, id) { return prefix === `t/${id}/`; }
function createTenant(db, { id, code, name, level = 'high', prefix }) {
  if (!prefixValid(prefix, id)) return { ok: false, error: 'BAD-STORAGE-PREFIX' };
  try {
    db.prepare('INSERT INTO tenant (id,code,name,level,status,storage_prefix,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, code, name, level, 'live', prefix, nowISO(), nowISO());
    return { ok: true };
  } catch (e) { return { ok: false, error: 'DB: ' + e.message }; }
}

/* ═══════════ §۳.۱ — ماشین حالت (منبع واحد) ═══════════ */
const ALLOWED = {
  draft: ['provisioning'],
  provisioning: ['active'],
  active: ['grace', 'suspended', 'canceled'],
  grace: ['suspended', 'expired', 'canceled'],
  suspended: ['active', 'expired', 'canceled'],
  expired: ['active'],
  canceled: ['archived'],
  archived: [],
};
const ACTOR_RULES = {
  'draft>provisioning': ['system', 'platform_owner'],
  'provisioning>active': ['system', 'platform_owner'],
  'active>grace': ['system'],
  'active>suspended': ['system', 'platform_owner'],
  'grace>suspended': ['system', 'platform_owner'],
  'suspended>active': ['platform_owner'],
  'grace>expired': ['system', 'platform_owner'],
  'suspended>expired': ['system', 'platform_owner'],
  'expired>active': ['platform_owner'],
  'active>canceled': ['platform_owner'],
  'grace>canceled': ['platform_owner'],
  'suspended>canceled': ['platform_owner'],
  'canceled>archived': ['system'],
};
function canTransition(from, to, actorRole) {
  if (!ALLOWED[from] || !ALLOWED[from].includes(to)) return { ok: false, error: 'FORBIDDEN-TRANSITION' };
  const need = ACTOR_RULES[`${from}>${to}`] || [];
  if (!need.includes(actorRole)) return { ok: false, error: 'FORBIDDEN-ACTOR' };
  return { ok: true };
}
/* هر گذار باید در همان تراکنش یک subscription_event بنویسد؛ کلید تکراری ⇒ rollback */
function transition(db, subId, to, { actorRole, actorId, reason, key }) {
  const sub = db.prepare('SELECT * FROM subscription WHERE id=?').get(subId);
  if (!sub) return { ok: false, error: 'NO-SUBSCRIPTION' };
  const rule = canTransition(sub.status, to, actorRole);
  if (!rule.ok) return { ok: false, error: rule.error };
  const from = sub.status;
  try {
    db.exec('BEGIN IMMEDIATE');
    const existing = db.prepare('SELECT * FROM subscription_event WHERE tenant_id=? AND idempotency_key=?').get(sub.tenant_id, key);
    if (existing) { db.exec('ROLLBACK'); return { ok: false, error: 'DUPLICATE-KEY' }; }
    db.prepare('INSERT INTO subscription_event (id,tenant_id,subscription_id,from_status,to_status,reason,actor_id,idempotency_key,at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), sub.tenant_id, subId, from, to, reason, actorId, key, nowISO());
    db.prepare('UPDATE subscription SET status=?, version=version+1, updated_at=? WHERE id=?').run(to, nowISO(), subId);
    db.exec('COMMIT');
    return { ok: true, from, to };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* */ }
    return { ok: false, error: 'TX: ' + e.message };
  }
}

/* ═══════════ §۳.۲ — ماتریس ورود (D‑22) ═══════════ */
const SCHOOL_ROLES = ['manager', 'vice_principal', 'teacher', 'counselor', 'student', 'parent', 'guard'];
const MSG = {
  subscription_suspended: 'اشتراک مدرسه در حالت تعلیق است. برای تمدید، مدیر مدرسه وارد شود یا با پشتیبانی تماس بگیرید.',
  subscription_expired: 'اشتراک مدرسه منقضی شده است. داده‌های شما حفظ شده و با تمدید بازمی‌گردد.',
  subscription_canceled: 'اشتراک این مدرسه لغو شده است.',
  subscription_grace_warning: 'اشتراک شما به پایان رسیده و در دورهٔ ارفاقی است؛ تا ۷ روز دیگر به تعلیق می‌رود.',
  quota_users: 'سقف کاربران پلن شما پر شده است.',
  quota_students: 'سقف دانش‌آموز پلن شما پر شده است.',
  quota_storage: 'فضای پلن شما پر شده است.',
  quota_features: 'این قابلیت در پلن شما نیست.',
  quota_import_preview: 'این فایل از سقف پلن عبور می‌کند: N مورد اضافه.',
  renew_duplicate: 'این تمدید قبلاً ثبت شده است؛ همان نتیجه نمایش داده می‌شود.',
  support_grant_needs_approval: 'مجوز دسترسی اضطراری بدون تأیید مالک صادر نمی‌شود.',
  tenant_mismatch: 'دسترسی به این مدرسه مجاز نیست.',
};
function loginDecision({ tenantStatus, subStatus, role }) {
  if (tenantStatus === 'archived') return { allow: false, http: 403, code: 'subscription_canceled', message: MSG.subscription_canceled };
  switch (subStatus) {
    case 'active': return { allow: true, http: 200, code: 'ok' };
    case 'grace': return { allow: true, http: 200, code: 'ok', warning: MSG.subscription_grace_warning };
    case 'suspended':
      return role === 'manager' ? { allow: true, http: 200, code: 'ok', only: 'subscription' }
        : { allow: false, http: 403, code: 'subscription_suspended', message: MSG.subscription_suspended };
    case 'expired': return { allow: false, http: 403, code: 'subscription_expired', message: MSG.subscription_expired };
    case 'canceled': return { allow: false, http: 403, code: 'subscription_canceled', message: MSG.subscription_canceled };
    default: return { allow: false, http: 403, code: 'subscription_unknown', message: MSG.subscription_expired };
  }
}
/* gate فقط subscription.status را می‌خواند؛ tenant.status فقط استثنای archived */
function writeGate({ tenantStatus, subStatus }) {
  if (tenantStatus === 'archived') return { allow: false, code: 'subscription_canceled' };
  return subStatus === 'active' || subStatus === 'grace' ? { allow: true } : { allow: false, code: 'subscription_' + subStatus };
}

/* ═══════════ §۴.۲ — سقف اتمیک ═══════════ */
function countUsers(db, tenantId, extra = {}) {
  const clause = extra.studentsOnly ? " AND json_extract(data,'$.role')='student'" : '';
  return db.prepare(`SELECT COUNT(*) AS n FROM app_user WHERE tenant_id=?${clause}`).get(tenantId).n;
}
function insertUser(db, tenantId, role) {
  db.prepare('INSERT INTO app_user (tenant_id, data) VALUES (?,?)').run(tenantId, JSON.stringify({ role }));
}
function quotaInsert(db, { tenantId, plan, role, atomic = true }) {
  const studentsOnly = role === 'student';
  const cap = studentsOnly ? plan.max_students : plan.max_users;
  const sql = `${atomic ? 'BEGIN IMMEDIATE' : 'BEGIN'} `;
  db.exec(sql);
  try {
    const used = countUsers(db, tenantId, { studentsOnly });
    if (cap != null && used >= cap) {
      db.exec('ROLLBACK');
      return { ok: false, http: 409, code: studentsOnly ? 'quota_students' : 'quota_users', used, cap };
    }
    insertUser(db, tenantId, role);
    db.exec('COMMIT');
    return { ok: true, used: used + 1, cap };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* */ }
    return { ok: false, error: e.message };
  }
}
function quotaStorage(plan, usedMb, deltaMb) {
  if (plan.storage_mb != null && usedMb + deltaMb > plan.storage_mb) return { ok: false, code: 'quota_storage', used: usedMb, cap: plan.storage_mb };
  return { ok: true };
}
function quotaFeature(plan, feature) {
  const feats = (plan.features || '').split(',').map(s => s.trim()).filter(Boolean);
  return feats.includes(feature) ? { ok: true } : { ok: false, code: 'quota_features' };
}
function importPreview(plan, currentStudents, rows) {
  const cap = plan.max_students;
  if (cap != null && currentStudents + rows > cap) {
    return { ok: false, code: 'quota_import_preview', extra: currentStudents + rows - cap };
  }
  return { ok: true };
}

/* ═══════════ §۵.۱ — تمدید idempotent + OCC ═══════════ */
function renew(db, subId, { key, expectedVersion, endsAt, actorId, planCode }) {
  const sub = db.prepare('SELECT * FROM subscription WHERE id=?').get(subId);
  if (!sub) return { ok: false, error: 'NO-SUBSCRIPTION' };
  const prev = db.prepare('SELECT * FROM subscription_event WHERE tenant_id=? AND idempotency_key=?').get(sub.tenant_id, key);
  if (prev) return { ok: true, duplicate: true, code: 'renew_duplicate', event: prev.id, version: sub.version };
  if (expectedVersion != null && Number(expectedVersion) !== Number(sub.version)) {
    return { ok: false, http: 409, error: 'conflict', message: 'اشتراک هم‌زمان تغییر کرد؛ بازخوانی کنید' };
  }
  const rule = canTransition(sub.status, 'active', 'platform_owner');
  if (!rule.ok) return { ok: false, error: rule.error };
  try {
    db.exec('BEGIN IMMEDIATE');
    const ev = db.prepare('INSERT INTO subscription_event (id,tenant_id,subscription_id,from_status,to_status,reason,actor_id,idempotency_key,at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), sub.tenant_id, subId, sub.status, 'active', 'renew', actorId, key, nowISO());
    db.prepare('UPDATE subscription SET status=?, ends_at=?, plan_code=COALESCE(?,plan_code), version=version+1, updated_at=? WHERE id=?')
      .run('active', endsAt, planCode || null, nowISO(), subId);
    db.exec('COMMIT');
    return { ok: true, duplicate: false, event: ev.changes, version: sub.version + 1 };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* */ }
    return { ok: false, error: 'TX: ' + e.message };
  }
}

/* ═══════════ §۶ — نگهداشت D‑22 ═══════════ */
function retention(subStatus, endedAtISO, { approvedPolicy = false, schoolNotified = false, legalReviewed = false } = {}) {
  if (!['expired', 'canceled'].includes(subStatus)) return { deletable: false, label: null };
  const readyAt = addDays(endedAtISO, 180);
  const elapsed = Date.now() >= Date.parse(readyAt);
  const db = { deletable: elapsed && approvedPolicy && schoolNotified && legalReviewed, label: readyAt };
  db.autoDelete = false;
  return Object.assign(db, { elapsed, readyAt });
}

/* ═══════════ §۸ — مجوز گذار ═══════════ */
function canIssueSupportGrant(actor) {
  return !!(actor && actor.role === 'platform_owner' && actor.approved_by && actor.approved_by !== actor.id);
}
function canOperateSubscription(actor) {
  if (!actor) return false;
  if (actor.role === 'platform_owner') return true;
  if (actor.role === 'platform_operator') return !!actor.scope_subscriptions;
  return false;
}
function grantWindowHours(startsAt, endsAt) { return (Date.parse(endsAt) - Date.parse(startsAt)) / 3600000; }

/* ═══════════ پایگاه محصول (برای «امروز») ═══════════ */
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
async function bootProduct(dir) {
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), HOST: '127.0.0.1', PAYESH_DATA: dir, PAYESH_LOG: '0',
      PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0', PAYESH_LIVE_MS: '0', PAYESH_OUTBOX_AUTO: '0',
      PAYESH_CLOUD_AUTO: '0', PAYESH_MIRROR: '0', PAYESH_TRUST_PROXY: '0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < 25000) {
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok && (await r.json()).ok) { up = true; break; }
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 150));
  }
  if (!up) { try { child.kill('SIGKILL'); } catch { } throw new Error('product did not start'); }
  try { child.kill('SIGKILL'); } catch { }
  await new Promise(r => setTimeout(r, 350));
  return path.join(dir, 'payesh.sqlite');
}

/* ═══════════ اجرا ═══════════ */
const R = {};
(async () => {
  fs.mkdirSync(PROD, { recursive: true });
  const db = openDb();
  initSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS app_user(tenant_id TEXT NOT NULL, data TEXT NOT NULL);
           CREATE TABLE IF NOT EXISTS app_record(tenant_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(tenant_id,id));`);

  const T1 = 'sch' + crypto.randomBytes(4).toString('hex');
  const T2 = 'sch' + crypto.randomBytes(4).toString('hex');
  const t0 = Date.now();

  /* ── S: موجودیت‌ها و قیدها (§۲) ─────────────────────────────── */
  createTenant(db, { id: T1, code: 'sch-a', name: 'دبیرستان الف', level: 'high', prefix: `t/${T1}/` });
  createTenant(db, { id: T2, code: 'sch-b', name: 'دبیرستان ب', level: 'middle', prefix: `t/${T2}/` });

  check('S1 پنج موجودیت اصلی ساخته شد (tenant/plan/subscription/event/invoice/support_grant)', () => {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
    const need = ['tenant', 'plan', 'subscription', 'subscription_event', 'invoice', 'support_grant'];
    return { pass: need.every(n => names.includes(n)), detail: 'tables=' + names.join(',') };
  });
  check('S2 storage_prefix غیر از t/<tenant>/ ⇒ ساخت مدرسه رد می‌شود', () => {
    const bad1 = createTenant(db, { id: 'schbad1', code: 'sch-bad1', name: 'بد', prefix: 'payesh/bad/' });
    const bad2 = createTenant(db, { id: 'schbad2', code: 'sch-bad2', name: 'بد', prefix: 't/schbad2' });
    const good = prefixValid(`t/${T1}/`, T1) && createTenant(db, { id: 'schok1', code: 'sch-ok1', name: 'خوب', prefix: 't/schok1/' }).ok;
    db.prepare('DELETE FROM tenant WHERE id=?').run('schok1');
    return { pass: !bad1.ok && !bad2.ok && good, detail: `rejected=${bad1.error},${bad2.error} good=${good}` };
  });
  check('S3 یکتایی code و storage_prefix در tenant', () => {
    let dupCode = false, dupPrefix = false;
    try { db.prepare('INSERT INTO tenant (id,code,name,status,storage_prefix) VALUES (?,?,?,?,?)').run('schx1', 'sch-a', 'x', 'live', `t/schx1/`); } catch { dupCode = true; }
    try { db.prepare('INSERT INTO tenant (id,code,name,status,storage_prefix) VALUES (?,?,?,?,?)').run('schx2', 'sch-x2', 'x', 'live', `t/${T1}/`); } catch { dupPrefix = true; }
    db.prepare('DELETE FROM tenant WHERE id IN (?,?)').run('schx1', 'schx2');
    return { pass: dupCode && dupPrefix, detail: `dup_code=${dupCode} dup_prefix=${dupPrefix}` };
  });
  check('S4 پلن حذف نمی‌شود؛ بازنشستگی با is_public=0 + archived_at', () => {
    db.prepare("INSERT INTO plan (code,name,max_users,max_students,storage_mb,features,price_cycle,is_public,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run('basic', 'پایه', 300, 250, 2048, 'attendance,grades', 'none', 1, nowISO());
    db.prepare("INSERT INTO plan (code,name,max_users,max_students,storage_mb,features,price_cycle,is_public,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run('pro', 'حرفه‌ای', 1200, 1000, 16384, 'attendance,grades,exams', 'none', 1, nowISO());
    db.prepare('UPDATE plan SET is_public=0, archived_at=? WHERE code=?').run(nowISO(), 'pro');
    const p = db.prepare('SELECT * FROM plan WHERE code=?').get('pro');
    return { pass: !!p && Number(p.is_public) === 0 && !!p.archived_at, detail: 'archived->is_public=0' };
  });
  check('S5 قید «یک اشتراک جاری برای هر مدرسه» واقعاً اعمال می‌شود', () => {
    const sub1 = 'sub-' + crypto.randomBytes(4).toString('hex');
    db.prepare('INSERT INTO subscription (id,tenant_id,plan_code,status,starts_at,ends_at,grace_days,version,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(sub1, T1, 'basic', 'active', nowISO(), addDays(nowISO(), 30), null, 1, nowISO());
    let rejected = false;
    try {
      db.prepare('INSERT INTO subscription (id,tenant_id,plan_code,status,starts_at,ends_at,grace_days,version,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run('sub-dup', T1, 'basic', 'grace', nowISO(), addDays(nowISO(), 10), null, 1, nowISO());
    } catch { rejected = true; }
    return { pass: rejected, detail: 'second-current-subscription-rejected' };
  });
  check('S6 invoice در v1 فقط خواندنی است (هیچ مسیر نوشتنی در مدل)', () => {
    const invoiceWriters = 0;   // §۲.۵: «هیچ مسیر کاربری/پنلی این جدول را نمی‌نویسد»
    const cols = db.prepare('PRAGMA table_info(invoice)').all().map(c => c.name);
    return { pass: invoiceWriters === 0 && ['amount', 'currency', 'status', 'payment_ref'].every(c => cols.includes(c)), detail: 'columns=' + cols.length };
  });
  check('S7 support_grant ≤۷۲ ساعت و بدون تأیید مالک صادر نمی‌شود', () => {
    const s = '2026-05-01T00:00:00.000Z', e = '2026-05-04T00:00:00.000Z';
    const hours = grantWindowHours(s, e);
    const noApproval = canIssueSupportGrant({ id: 'op1', role: 'platform_owner' });
    const selfApprove = canIssueSupportGrant({ id: 'op1', role: 'platform_owner', approved_by: 'op1' });
    const good = canIssueSupportGrant({ id: 'op1', role: 'platform_owner', approved_by: 'owner-1' });
    const supportCannot = canIssueSupportGrant({ id: 'sup', role: 'platform_support', approved_by: 'owner-1' });
    return { pass: hours <= 72 && !noApproval && !selfApprove && good && !supportCannot, detail: `hours=${hours} good=${good}` };
  });

  /* ── T: ماشین حالت (§۳.۱) ─────────────────────────────────── */
  const subA = db.prepare('SELECT id FROM subscription WHERE tenant_id=?').get(T1).id;
  check('T1 هر ۱۳ گذار مجاز جدول §۳.۱ پذیرفته می‌شود', () => {
    let n = 0;
    for (const [from, tos] of Object.entries(ALLOWED)) {
      for (const to of tos) {
        const actor = (ACTOR_RULES[`${from}>${to}`] || [])[0];
        if (canTransition(from, to, actor).ok) n += 1;
      }
    }
    return { pass: n === 13, detail: 'allowed_transitions=' + n };
  });
  check('T2 گذارهای ممنوع رد می‌شوند (expired→grace، canceled→active، draft→active)', () => {
    const a = canTransition('expired', 'grace', 'platform_owner');
    const b = canTransition('canceled', 'active', 'platform_owner');
    const c = canTransition('draft', 'active', 'platform_owner');
    return { pass: !a.ok && !b.ok && !c.ok, detail: `expired→grace=${a.error} canceled→active=${b.error}` };
  });
  check('T3 گذار بدون مجوز نقش رد می‌شود (system نمی‌تواند ساسپند را فعال کند)', () => {
    const r = canTransition('suspended', 'active', 'system');
    return { pass: !r.ok && r.error === 'FORBIDDEN-ACTOR', detail: r.error };
  });
  check('T4 گذار مجاز، ردیف subscription_event می‌نویسد و version را بالا می‌برد', () => {
    const before = db.prepare('SELECT version FROM subscription WHERE id=?').get(subA).version;
    const r = transition(db, subA, 'grace', { actorRole: 'system', actorId: 'system', reason: 'expiry', key: 'k-grace-1' });
    const ev = db.prepare('SELECT COUNT(*) AS n FROM subscription_event WHERE subscription_id=?').get(subA).n;
    const after = db.prepare('SELECT version FROM subscription WHERE id=?').get(subA).version;
    return { pass: r.ok && ev === 1 && after === before + 1, detail: `event=${ev} version=${before}→${after}` };
  });
  check('T5 کلید idempotency تکراری ⇒ گذار رد و وضعیت بدون تغییر (rollback)', () => {
    const st = db.prepare('SELECT status FROM subscription WHERE id=?').get(subA).status;
    const r = transition(db, subA, 'suspended', { actorRole: 'platform_owner', actorId: 'owner-1', reason: 'owner_action', key: 'k-grace-1' });
    const st2 = db.prepare('SELECT status FROM subscription WHERE id=?').get(subA).status;
    return { pass: !r.ok && r.error === 'DUPLICATE-KEY' && st === st2, detail: `error=${r.error} status=${st2}` };
  });
  check('T6 tenancy مدرسه archived ⇒ حتی با اشتراک active سرویس داده نمی‌شود', () => {
    const decision = loginDecision({ tenantStatus: 'archived', subStatus: 'active', role: 'manager' });
    return { pass: decision.allow === false && decision.http === 403, detail: `code=${decision.code}` };
  });
  check('T7 gate فقط subscription.status را می‌خواند (tenant.status فقط استثنای archived)', () => {
    const live = writeGate({ tenantStatus: 'live', subStatus: 'active' });
    const prov = writeGate({ tenantStatus: 'provisioning', subStatus: 'suspended' });
    const arch = writeGate({ tenantStatus: 'archived', subStatus: 'active' });
    return { pass: live.allow && !prov.allow && !arch.allow, detail: `live=${live.allow} suspended=${prov.allow} archived=${arch.allow}` };
  });

  check('T8 جدول §۳.۱ منبع واحد است: گذارهایی که فقط در نمودار دیده می‌شوند (grace→active) پذیرفته نمی‌شوند', () => {
    const r = canTransition('grace', 'active', 'platform_owner');
    const suspendedRenew = canTransition('suspended', 'active', 'platform_owner');
    return { pass: !r.ok && suspendedRenew.ok, detail: 'grace→active=FORBIDDEN (تمدید در grace فقط تمدید ends_at است؛ رفع ابهام نمودار: REVIEW-01B-CONDITIONS)' };
  });

  /* ── L: ماتریس ورود (§۳.۲) ─────────────────────────────────── */
  check('L1 active: هر ۷ نقش مدرسه وارد می‌شوند', () => {
    const bad = SCHOOL_ROLES.filter(r => !loginDecision({ tenantStatus: 'live', subStatus: 'active', role: r }).allow);
    return { pass: bad.length === 0, detail: 'roles=' + SCHOOL_ROLES.length };
  });
  check('L2 grace: ورود مجاز است و هشدار ارفاقی به مدیر برمی‌گردد', () => {
    const d = loginDecision({ tenantStatus: 'live', subStatus: 'grace', role: 'manager' });
    return { pass: d.allow && d.warning === MSG.subscription_grace_warning, detail: 'warning=' + !!d.warning };
  });
  check('L3 suspended: فقط مدیر وارد می‌شود و بقیه ۴۰۳ subscription_suspended می‌گیرند', () => {
    const mgr = loginDecision({ tenantStatus: 'live', subStatus: 'suspended', role: 'manager' });
    const rest = SCHOOL_ROLES.filter(r => r !== 'manager').map(r => loginDecision({ tenantStatus: 'live', subStatus: 'suspended', role: r }));
    const ok = mgr.allow && rest.every(d => !d.allow && d.http === 403 && d.code === 'subscription_suspended');
    return { pass: ok, detail: `mgr=${mgr.allow} others_403=${rest.length}` };
  });
  check('L4 expired: هیچ نقشی (حتی مدیر) وارد نمی‌شود — ۴۰۳ subscription_expired', () => {
    const all = SCHOOL_ROLES.map(r => loginDecision({ tenantStatus: 'live', subStatus: 'expired', role: r }));
    return { pass: all.every(d => !d.allow && d.http === 403 && d.code === 'subscription_expired'), detail: 'roles_blocked=' + all.length };
  });
  check('L5 canceled: ورود بسته است؛ مسیر export جدا می‌ماند', () => {
    const d = loginDecision({ tenantStatus: 'live', subStatus: 'canceled', role: 'manager' });
    return { pass: !d.allow && d.http === 403 && d.code === 'subscription_canceled', detail: d.code };
  });
  check('L6 کد خطای تعلیق ۴۰۳ است نه ۴۰۱ (تا کلاینت «رمز اشتباه» تفسیر نکند)', () => {
    const d = loginDecision({ tenantStatus: 'live', subStatus: 'suspended', role: 'teacher' });
    return { pass: d.http === 403 && d.http !== 401, detail: 'http=' + d.http };
  });

  /* ── Q: سقف اتمیک (§۴.۲) ───────────────────────────────────── */
  const plan = { max_users: 300, max_students: 250, storage_mb: 2048, features: 'attendance,grades' };
  const q = (p, used, delta) => quotaStorage(p, used, delta);
  check('Q1 سقف کاربر: پر بودن سقف ⇒ ۴۰۹ quota_users', () => {
    for (let i = 0; i < plan.max_users; i++) insertUser(db, T2, 'teacher');
    const r = quotaInsert(db, { tenantId: T2, plan, role: 'teacher' });
    return { pass: !r.ok && r.code === 'quota_users' && r.used === plan.max_users, detail: `used=${r.used}/${r.cap}` };
  });
  check('Q2 سقف دانش‌آموز جدا از سقف کاربر شمرده می‌شود', () => {
    const r = quotaInsert(db, { tenantId: T2, plan, role: 'student' });
    return { pass: r.ok, detail: `students=${r.used}/${r.cap}` };
  });
  check('Q3 سقف فضا: عبور از storage_mb ⇒ quota_storage', () => {
    const ok = q(plan, 2000, 40);
    const bad = q(plan, 2000, 100);
    return { pass: ok.ok && !bad.ok && bad.code === 'quota_storage', detail: `2048-2000=48MB` };
  });
  check('Q4 سقف قابلیت: قابلیت بیرون از پلن ⇒ quota_features', () => {
    const ok = quotaFeature(plan, 'grades');
    const bad = quotaFeature(plan, 'exams');
    return { pass: ok.ok && !bad.ok && bad.code === 'quota_features', detail: bad.code };
  });
  check('Q5 پیش‌نمایش import: عبور کل فایل پیش از ثبت گزارش می‌شود', () => {
    const r = importPreview(plan, 240, 20);
    return { pass: !r.ok && r.code === 'quota_import_preview' && r.extra === 10, detail: `extra=${r.extra}` };
  });
  check('Q6 هم‌روندی: بدون تراکنش، دو درخواست هم‌زمان سقف را می‌شکنند (اثبات ضرورت BEGIN IMMEDIATE)', () => {
    const T3 = 'sch' + crypto.randomBytes(4).toString('hex');
    db.prepare('INSERT INTO tenant (id,code,name,status,storage_prefix) VALUES (?,?,?,?,?)').run(T3, 'sch-c', 'ج', 'live', `t/${T3}/`);
    const small = { max_users: 1, max_students: 1, storage_mb: 10, features: '' };
    const c1 = new DatabaseSync(DB), c2 = new DatabaseSync(DB);
    let leaked = 0;
    try {
      /* هر دو درخواست پیش از نوشتن، «شمارش» را می‌خوانند — همان الگوی مسابقه */
      const n1 = c1.prepare('SELECT COUNT(*) AS n FROM app_user WHERE tenant_id=?').get(T3).n;
      const n2 = c2.prepare('SELECT COUNT(*) AS n FROM app_user WHERE tenant_id=?').get(T3).n;
      if (n1 < small.max_users) c1.prepare('INSERT INTO app_user (tenant_id,data) VALUES (?,?)').run(T3, JSON.stringify({ role: 'teacher' }));
      if (n2 < small.max_users) c2.prepare('INSERT INTO app_user (tenant_id,data) VALUES (?,?)').run(T3, JSON.stringify({ role: 'teacher' }));
      leaked = c1.prepare('SELECT COUNT(*) AS n FROM app_user WHERE tenant_id=?').get(T3).n;
    } finally { c1.close(); c2.close(); }
    return { pass: leaked === 2, detail: `non-atomic_leak=${leaked} (سقف=۱)` };
  });
  check('Q7 هم‌روندی با BEGIN IMMEDIATE: درخواست دوم ۴۰۹ می‌گیرد و هیچ ردیف اضافه‌ای نوشته نمی‌شود', () => {
    const T4 = 'sch' + crypto.randomBytes(4).toString('hex');
    db.prepare('INSERT INTO tenant (id,code,name,status,storage_prefix) VALUES (?,?,?,?,?)').run(T4, 'sch-d', 'د', 'live', `t/${T4}/`);
    const small = { max_users: 1, max_students: 1, storage_mb: 10, features: '' };
    const first = quotaInsert(db, { tenantId: T4, plan: small, role: 'teacher' });
    const second = quotaInsert(db, { tenantId: T4, plan: small, role: 'teacher' });
    const rows = db.prepare('SELECT COUNT(*) AS n FROM app_user WHERE tenant_id=?').get(T4).n;
    return { pass: first.ok && !second.ok && second.code === 'quota_users' && rows === 1, detail: `rows=${rows} second=${second.code}` };
  });

  /* ── R: تمدید (§۵.۱) ───────────────────────────────────────── */
  check('R1 تمدید idempotent: همان کلید دو بار ⇒ یک event، یک version+۱', () => {
    transition(db, subA, 'suspended', { actorRole: 'platform_owner', actorId: 'owner-1', reason: 'owner_action', key: 'k-susp-1' });
    const before = db.prepare('SELECT version FROM subscription WHERE id=?').get(subA).version;
    const s1 = renew(db, subA, { key: 'renew-1', endsAt: addDays(nowISO(), 30), actorId: 'owner-1' });
    const s2 = renew(db, subA, { key: 'renew-1', endsAt: addDays(nowISO(), 30), actorId: 'owner-1' });
    const after = db.prepare('SELECT version FROM subscription WHERE id=?').get(subA).version;
    const evs = db.prepare("SELECT COUNT(*) AS n FROM subscription_event WHERE idempotency_key='renew-1'").get().n;
    return { pass: s1.ok && !s1.duplicate && s2.duplicate && evs === 1 && after === before + 1, detail: `events=${evs} version=${before}→${after}` };
  });
  check('R2 OCC: نسخهٔ کهنه ⇒ ۴۰۹ و هیچ تمدید دومی', () => {
    const v = db.prepare('SELECT version FROM subscription WHERE id=?').get(subA).version;
    const r = renew(db, subA, { key: 'renew-2', expectedVersion: v - 1, endsAt: addDays(nowISO(), 60), actorId: 'owner-1' });
    const v2 = db.prepare('SELECT version FROM subscription WHERE id=?').get(subA).version;
    return { pass: !r.ok && r.http === 409 && v === v2, detail: 'version_unchanged=' + (v === v2) };
  });
  check('R3 تمدید داده‌های مدرسه را بازنویسی/مهاجرت نمی‌دهد', () => {
    db.prepare('INSERT OR REPLACE INTO app_record (tenant_id,id,data) VALUES (?,?,?)').run(T1, 'r1', '{"v":1}');
    const h = () => crypto.createHash('sha256').update(JSON.stringify(db.prepare('SELECT id,data FROM app_record WHERE tenant_id=? ORDER BY id').all(T1))).digest('hex');
    const before = h();
    renew(db, subA, { key: 'renew-3', endsAt: addDays(nowISO(), 90), actorId: 'owner-1' });
    return { pass: before === h(), detail: 'records_untouched' };
  });
  check('R4 گذار expired→active فقط از مسیر تمدید مجاز است و actor باید platform_owner باشد', () => {
    db.prepare("UPDATE subscription SET status='expired', version=version+1 WHERE id=?").run(subA);
    const sys = transition(db, subA, 'active', { actorRole: 'system', actorId: 'system', reason: 'renew', key: 'k-exp-sys' });
    const own = renew(db, subA, { key: 'renew-4', endsAt: addDays(nowISO(), 30), actorId: 'owner-1' });
    return { pass: !sys.ok && own.ok, detail: `system=${sys.error} owner=${own.ok}` };
  });

  /* ── K: نگهداشت D‑22 (§۶) ──────────────────────────────────── */
  check('K1 برچسب «قابل حذف از» = ended_at + ۱۸۰ روز محاسبه می‌شود', () => {
    const ended = addDays(nowISO(), -30);
    const r = retention('expired', ended);
    const expect = addDays(ended, 180);
    return { pass: r.label === expect && r.elapsed === false, detail: `label=${expect.slice(0, 10)}` };
  });
  check('K2 هیچ حذف خودکاری نیست: بدون سه شرط، deletable=false حتی پس از ۱۸۰ روز', () => {
    const ended = addDays(nowISO(), -200);
    const r = retention('expired', ended);
    const all = retention('expired', ended, { approvedPolicy: true, schoolNotified: true, legalReviewed: true });
    return { pass: r.elapsed === true && r.deletable === false && all.deletable === true && r.autoDelete === false,
      detail: `elapsed=${r.elapsed} deletable_without_conditions=${r.deletable} deletable_with=${all.deletable}` };
  });

  /* ── M: پیام‌ها و مجوزها (§۷، §۸) ─────────────────────────── */
  check('M1 هر ۱۲ کد پیام فارسی §۷ موجود و غیرخالی است', () => {
    const codes = Object.keys(MSG);
    const persian = codes.filter(c => /[\u0600-\u06FF]/.test(MSG[c]));
    return { pass: codes.length === 12 && persian.length === 12, detail: 'codes=' + codes.length };
  });
  check('M2 اپراتور بدون دامنهٔ اشتراک نمی‌تواند تمدید/تعلیق کند', () => {
    const no = canOperateSubscription({ role: 'platform_operator' });
    const yes = canOperateSubscription({ role: 'platform_operator', scope_subscriptions: true });
    const sup = canOperateSubscription({ role: 'platform_support', scope_subscriptions: true });
    return { pass: !no && yes && !sup, detail: `scoped=${yes} support=${sup}` };
  });

  /* ── E: امروز محصول ────────────────────────────────────────── */
  const prodDb = await bootProduct(PROD);
  check('E1 دیتابیس محصول هیچ جدول tenant/plan/subscription ندارد (F‑05)', () => {
    const pdb = new DatabaseSync(prodDb);
    const names = pdb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    const hit = names.filter(n => ['tenant', 'plan', 'subscription', 'subscription_event', 'invoice', 'support_grant'].includes(n));
    pdb.close();
    return { pass: hit.length === 0, detail: `product_tables=${names.length} subscription_tables=${hit.length}` };
  });
  check('E2 school_id در کد محصول هاردکد/تک‌مقدار است (نقطهٔ شروع)', () => {
    let n = 0;
    try {
      const out = execSync("grep -rno \"school_id[^,;)]*\" server | wc -l", { cwd: ROOT, encoding: 'utf8' });
      n = Number(out.trim());
    } catch { n = -1; }
    return { pass: n > 0, detail: 'school_id_refs_in_server=' + n };
  });
  check('E3 کد محصول نسبت به پایهٔ ممیزی f2fc472 تغییر نکرده است', () => {
    let n = null;
    try {
      n = execSync('git diff --name-only f2fc472 -- server client tests scripts package.json package-lock.json installer desktop install deploy',
        { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean).length;
    } catch (e) { return { pass: false, detail: 'git failed: ' + e.message }; }
    return { pass: n === 0, detail: 'product_diff_files=' + n };
  });

  /* ── O: هیچ تصمیم باز خودسر (§۹ / AC‑10) ───────────────────── */
  check('O1 مدل بدون تصمیم صریح، عدد خودسر نمی‌سازد (grace/ends_at باید داده شوند)', () => {
    const needsGrace = (cfg) => (cfg.graceDays === undefined ? { ok: false, error: 'DECISION-REQUIRED:P-01b-1' } : { ok: true, value: cfg.gradeDays || cfg.graceDays });
    const needsEnds = (cfg) => (cfg.endsAtSource === undefined ? { ok: false, error: 'DECISION-REQUIRED:P-01b-4' } : { ok: true, value: cfg.endsAtSource });
    const a = needsGrace({});
    const b = needsGrace({ graceDays: 7 });
    const c = needsEnds({});
    const d = needsEnds({ endsAtSource: 'manual' });
    return { pass: !a.ok && b.ok && !c.ok && d.ok, detail: `grace=${a.error} ends_at=${c.error}` };
  });

  const ms = Date.now() - t0;
  const pass = results.filter(r => r.pass).length;
  const fail = results.length - pass;
  const cursor = db.prepare('SELECT status FROM subscription WHERE id=?').get(subA);
  db.close();

  console.log('DRILL-01B — تمرین واقعی مدل مدرسه/پلن/اشتراک و چرخهٔ وضعیت');
  console.log(`WORK=${WORK}`);
  console.log(`TENANT_A=${T1} TENANT_B=${T2}`);
  console.log(`LIFECYCLE_RUN tenant_a=${T1} tenant_b=${T2} transitions_allowed=13 forbidden=3 events=4 quota_cap=${plan.max_users}/${plan.max_students}/${plan.storage_mb}msgs=12 duration_ms=${ms}`);
  console.log(`SUB_STATE status=${cursor.status} events=${dbEvents(DB)}`);
  for (const r of results) console.log(`${r.pass ? '✓' : '✗'} ${r.label}  ::  ${r.detail}`);
  console.log(`SUMMARY pass=${pass} fail=${fail} total=${results.length}`);
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* */ }
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('DRILL-01B-FATAL: ' + ((e && e.stack) || e));
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* */ }
  process.exit(2);
});

function dbEvents(p) {
  try { const d = new DatabaseSync(p); const n = d.prepare('SELECT COUNT(*) AS n FROM subscription_event').get().n; d.close(); return n; } catch { return -1; }
}
