'use strict';
// نمونهٔ فنی ۲۰‑ب — آزمون چندمستأجری: نشت بین‌مدرسه‌ای، سقف پلن و حالت‌های اشتراک
// سیستم تحت آزمون: دروازهٔ نمونهٔ ۲۰ (هویت از توکن، هستهٔ تعارض ۱۹) + لایهٔ پلتفرم:
//   سطح A (پنل پلتفرم) در برابر سطح B (مدرسه)، سقف پلن در API، چرخهٔ اشتراک D‑22،
//   مجوز اضطراری D‑21/۱۲‑ب، و فضای ذخیره‌سازی بدون اعتبارنامهٔ پخته در کلاینت (F‑04/D‑23).
// قاعدهٔ سخت: tenant_id فقط از توکن/نشست؛ هیچ فیلدی از بدنه یا کلاینت آن را تعیین نمی‌کند.

const crypto = require('node:crypto');
const { Gateway, AuthError, RequestError, canWrite } = require('../slice-20/lab');
const { sha256 } = require('../slice-19/conflict-server');

// ---------- ثابت‌های مصوب ----------
const SUB_STATES = ['draft', 'provisioning', 'active', 'grace', 'suspended', 'expired', 'canceled'];
// D‑22/۱۶‑ب §۱.۱ — هیچ وضعیت تازه‌ای مجاز نیست؛ «trialing» وجود ندارد (A‑03)
const TRANSITIONS = {
  draft: ['provisioning', 'canceled'],
  provisioning: ['active', 'canceled'],
  active: ['grace', 'suspended', 'canceled'],
  grace: ['active', 'suspended', 'expired', 'canceled'],
  suspended: ['active', 'expired', 'canceled'],
  expired: ['active'],                       // فقط با تمدید از پنل پلتفرم
  canceled: ['archived'],                    // پس از پنجرهٔ خروج داده
};
const RETENTION_DAYS = 180;                   // D‑22
const GRANT_MAX_MS = 72 * 3600 * 1000;        // ۱۲‑ب §۳.۱ سقف سخت
const GRANT_SCOPES = ['metadata', 'content_read'];   // content_write وجود ندارد
const TICKET_TTL_MS = 300_000;                // اعتبارنامهٔ کوتاه‌عمر فضای ذخیره‌سازی (D‑23)
const PLATFORM_ROLES = ['platform_owner', 'platform_operator', 'platform_support'];
const APPROVER_ROLES = ['platform_owner', 'platform_operator'];
const CLIENT_BAKED_CREDENTIALS = null;        // F‑04: هیچ کلید/توکن ذخیره‌سازی در بستهٔ کلاینت نیست

const b64u = (b) => Buffer.from(b).toString('base64url');

class Platform extends Gateway {
  constructor({ secret = crypto.randomBytes(32), now = Date.now } = {}) {
    super({ secret, now });
    this.plans = new Map();
    this.subs = new Map();          // tenant_id → subscription
    this.subEvents = [];            // subscription_event (هر انتقال یک ردیف)
    this.idemKeys = new Set();
    this.grants = new Map();
    this.supportAccessLog = [];
    this.storageObjects = new Map(); // `${prefix}/${path}` → Buffer
    this.storageTickets = new Map();
    this.queue = [];                 // opهای سرور، همواره مستأجرمحور
    this.cache = new Map();
    this.backups = new Map();
    this.capDenials = [];            // شاهد سقف پلن (کد + پیام فارسی)
  }

  // ---------- توکن: سطح A و B ----------
  issueToken({ tenant_id, role, user_id = `u-${role}`, device_id = `dev-${role}`, ttlMs = 3_600_000 }) {
    if (!this.tenants.has(tenant_id)) throw new AuthError('unknown_tenant');
    if (!this.users.has(`${tenant_id}|${user_id}`)) this.addUser({ tenant_id, role, user_id });
    const payload = { v: 1, lvl: 'B', tid: tenant_id, role, uid: user_id, did: device_id, iat: this.now(), exp: this.now() + ttlMs };
    const body = b64u(JSON.stringify(payload));
    const sig = crypto.createHmac('sha256', this.secret).update(body).digest();
    return `${body}.${b64u(sig)}`;
  }

  issuePlatformToken({ role = 'platform_owner', operator_id = 'op-1', ttlMs = 3_600_000 } = {}) {
    if (!PLATFORM_ROLES.includes(role)) throw new AuthError('platform_role_unknown', 403);
    const payload = { v: 1, lvl: 'A', role, uid: operator_id, iat: this.now(), exp: this.now() + ttlMs };
    const body = b64u(JSON.stringify(payload));
    const sig = crypto.createHmac('sha256', this.secret).update(body).digest();
    return `${body}.${b64u(sig)}`;
  }

  authenticate(authorization) {
    const p = this._verify(String(authorization || '').replace(/^Bearer\s+/i, ''));
    // توکن سطح A هرگز روی API مدرسه پذیرفته نمی‌شود (D‑21)
    if (p.lvl === 'A') throw new AuthError('platform_token_on_school_api', 403);
    if (p.lvl !== 'B' || !p.tid) throw new AuthError('token_level_unknown', 401);
    const tenant = this.tenants.get(p.tid);
    if (!tenant) throw new AuthError('unknown_tenant', 401);
    if (tenant.status === 'archived') throw new AuthError('tenant_archived', 403);
    if (this.revokedDevices.has(p.did)) throw new AuthError('device_revoked', 401);
    const sub = this.subs.get(p.tid);
    const state = sub ? sub.status : 'draft';
    // جدول D‑22 — ورود
    if (state === 'expired') throw new AuthError('subscription_expired', 403);
    if (state === 'canceled' || state === 'archived') throw new AuthError('subscription_canceled', 403);
    if (state === 'draft' || state === 'provisioning') throw new AuthError('subscription_not_active', 403);
    if (state === 'suspended' && p.role !== 'manager') throw new AuthError('subscription_suspended', 403);
    return { tenant_id: p.tid, role: p.role, user_id: p.uid, device_id: p.did, level: 'B', sub_state: state };
  }

  authenticatePlatform(authorization) {
    const p = this._verify(String(authorization || '').replace(/^Bearer\s+/i, ''));
    if (p.lvl === 'B') throw new AuthError('school_token_on_platform_api', 403);
    if (p.lvl !== 'A') throw new AuthError('token_level_unknown', 401);
    if (!PLATFORM_ROLES.includes(p.role)) throw new AuthError('platform_role_unknown', 403);
    return { level: 'A', role: p.role, operator_id: p.uid, tenant_id: null };
  }

  // ---------- پلن، اشتراک ----------
  definePlan({ code, caps = {} }) {
    this.plans.set(code, {
      code,
      caps: {
        users: caps.users ?? Infinity,
        students: caps.students ?? Infinity,
        storage_mb: caps.storage_mb ?? Infinity,
        features: caps.features || [],
      },
    });
    return this.plans.get(code);
  }

  subscribe({ tenant_id, plan, status = 'draft', starts_at = this.now(), ends_at = null, grace_days = 0 }) {
    if (!this.plans.has(plan)) throw new RequestError('plan_unknown');
    if (!SUB_STATES.includes(status)) throw new RequestError('unknown_state');
    const sub = {
      id: `sub-${tenant_id}-${this.subs.size + 1}`, tenant_id, plan, status,
      starts_at, ends_at, grace_days, canceled_at: null, renewed_from: null, open_slot: true,
    };
    this.subs.set(tenant_id, sub);
    this._event({ subscription_id: sub.id, tenant_id, from: null, to: status, actor: 'system', role: 'system', reason: 'provision' });
    return sub;
  }

  _event(row) {
    const prev = this.subEvents.length ? this.subEvents[this.subEvents.length - 1].hash : 'GENESIS';
    const e = { ...row, at: this.now(), prev_hash: prev };
    e.hash = sha256(JSON.stringify({ ...e, hash: undefined }));
    this.subEvents.push(e);
    this._audit({ action: 'subscription.event', tenant: row.tenant_id, from: row.from, to: row.to });
    return e;
  }

  // انتقال وضعیت: فقط جدول مجاز، فقط با رخداد ثبت‌شده، با کلید idempotency یکتا
  transition({ tenant_id, to, actor, role, reason = null, idempotency_key = null }) {
    const sub = this.subs.get(tenant_id);
    if (!sub) throw new RequestError('subscription_missing', 404);
    if (!SUB_STATES.includes(to) && to !== 'archived') throw new RequestError('unknown_state');
    if (idempotency_key) {
      if (this.idemKeys.has(idempotency_key)) throw new RequestError('duplicate_idempotency', 409);
    }
    const allowed = TRANSITIONS[sub.status] || [];
    if (!allowed.includes(to)) throw new RequestError(`transition_forbidden:${sub.status}->${to}`, 409);
    if (to === 'canceled' && !reason) throw new RequestError('reason_required');
    if (to === 'archived' && sub.status !== 'canceled') throw new RequestError('transition_forbidden', 409);
    if (idempotency_key) this.idemKeys.add(idempotency_key);
    const from = sub.status;
    sub.status = to;
    if (to === 'expired') sub.expired_at = this.now();
    if (to === 'canceled') { sub.canceled_at = this.now(); sub.reason = reason; }
    if (to === 'active' && from !== 'active') sub.renewed_at = this.now();
    this._event({ subscription_id: sub.id, tenant_id, from, to, actor, role, reason, idempotency_key });
    return { ...sub };
  }

  retentionUntil(tenant_id) {
    const sub = this.subs.get(tenant_id);
    const base = sub && (sub.expired_at || sub.canceled_at);
    return base ? base + RETENTION_DAYS * 86_400_000 : null;
  }

  // حذف دائمی: هرگز خودکار؛ فقط پس از ۱۸۰ روز و با سیاست مکتوب (D‑22)
  purgeData({ tenant_id, policy_ref, now = this.now() }) {
    const until = this.retentionUntil(tenant_id);
    if (!until) throw new RequestError('retention_not_started', 409);
    if (now < until) throw new RequestError('retention_period_active', 409);
    if (!policy_ref) throw new RequestError('policy_required', 409);
    const prefix = `${tenant_id}|`;
    let removed = 0;
    for (const key of [...this.core.records.keys()]) {
      if (key.startsWith(prefix)) { this.core.records.delete(key); removed++; }
    }
    this._audit({ action: 'tenant.purge', tenant: tenant_id, policy_ref, removed });
    return { removed, policy_ref };
  }

  _plan(tenant_id) {
    const sub = this.subs.get(tenant_id);
    return sub ? this.plans.get(sub.plan) : null;
  }

  _denyCap(code, message_fa) {
    this.capDenials.push({ code, message_fa, at: this.now() });
    const e = new RequestError(code, 409);
    e.message_fa = message_fa;
    throw e;
  }

  _countUsers(tenant_id) {
    let n = 0;
    for (const k of this.users.keys()) if (k.startsWith(`${tenant_id}|`)) n++;
    return n;
  }

  _countRecords(tenant_id, collection) {
    let n = 0;
    for (const [k, r] of this.core.records) if (k.startsWith(`${tenant_id}|${collection}|`) && r.version > 0) n++;
    return n;
  }

  _storageBytes(tenant_id) {
    const tenant = this.tenants.get(tenant_id);
    const prefix = `${tenant.storage_prefix}/`;
    let n = 0;
    for (const [k, v] of this.storageObjects) if (k.startsWith(prefix)) n += v.length;
    return n;
  }

  // ---------- سقف پلن در API (سمت سرور، مستقل از ادعای کلاینت) ----------
  createUser({ session, user_id, role, client_counts = null }) {
    this._assertService(session, 'write', 'users');
    const plan = this._plan(session.tenant_id);
    const cap = plan ? plan.caps.users : Infinity;
    const used = this._countUsers(session.tenant_id);       // شمارش سروری؛ client_counts نادیده
    if (used >= cap) this._denyCap('plan_cap_users', `سقف کاربران پلن شما پر شده است (${used}/${cap}).`);
    if (this.users.has(`${session.tenant_id}|${user_id}`)) throw new RequestError('user_exists', 409);
    return this.addUser({ tenant_id: session.tenant_id, role, user_id });
  }

  // دانش‌آموز: ساخت فقط توسط ناظر مدرسه و با سقف پلن (سمت سرور)
  createStudent({ session, student_id, fields = {} }) {
    this._assertService(session, 'write', 'students');
    if (session.role !== 'manager') throw new RequestError('role_denied', 403);
    const plan = this._plan(session.tenant_id);
    const cap = plan ? plan.caps.students : Infinity;
    const used = this._countRecords(session.tenant_id, 'students');   // شمارش سروری
    if (used >= cap) this._denyCap('plan_cap_students', `سقف دانش‌آموز پلن شما پر شده است (${used}/${cap}).`);
    const key = `${session.tenant_id}|students|${student_id}`;
    if (this.core.records.has(key)) throw new RequestError('record_exists', 409);
    this.core.records.set(key, { version: 1, fields: { ...fields }, history: {} });
    return { student_id, version: 1 };
  }

  // کاشت دادهٔ آزمون در سمت سرور (نه مسیر API) — فقط برای آماده‌سازی صحنه
  seedRow({ tenant_id, collection, record_id, fields = {} }) {
    const key = `${tenant_id}|${collection}|${record_id}`;
    this.core.records.set(key, { version: 1, fields: { ...fields }, history: {} });
    return { key, version: 1 };
  }

  requireFeature(session, feature) {
    const plan = this._plan(session.tenant_id);
    const list = plan ? plan.caps.features : [];
    if (!list.includes(feature)) this._denyCap('plan_feature_disabled', `قابلیت «${feature}» در پلن شما فعال نیست.`);
    return true;
  }

  // ---------- گیت اشتراک برای خواندن/نوشتن ----------
  _stateOf(session) {
    const sub = this.subs.get(session.tenant_id);
    return sub ? sub.status : 'draft';
  }

  _assertService(session, kind, collection = '') {
    const state = this._stateOf(session);
    if (state === 'expired') throw new RequestError('subscription_expired', 403);
    if (state === 'canceled' || state === 'archived') throw new RequestError('subscription_canceled', 403);
    if (state === 'draft' || state === 'provisioning') throw new RequestError('subscription_not_active', 403);
    if (state === 'suspended') {
      if (kind === 'write' && collection !== 'subscription') throw new RequestError('subscription_suspended', 403);
      if (kind === 'read' && collection !== 'subscription') throw new RequestError('subscription_read_limited', 403);
    }
    return { state, warning: state === 'grace' ? 'subscription_grace_warning' : null };
  }

  readSync(session, { collection, record_id }) {
    const gate = this._assertService(session, 'read', collection);
    const out = super.readSync(session, { collection, record_id });
    return gate.warning ? { ...out, warning: gate.warning } : out;
  }

  pushSync(session, batch) {
    this._assertService(session, 'write', batch && batch[0] ? batch[0].collection : '');
    if (!Array.isArray(batch) || !batch.length) throw new RequestError('empty_batch');
    for (const op of batch) {
      // tenant_id از بدنه هرگز معتبر نیست؛ اختلاف با نشست ⇒ رد صریح
      if (op && op.tenant_id !== undefined && op.tenant_id !== session.tenant_id) {
        throw new RequestError('tenant_mismatch', 403);
      }
      if (op && op.collection === 'students') {
        const plan = this._plan(session.tenant_id);
        const cap = plan ? plan.caps.students : Infinity;
        const rec = this.core.record(session.tenant_id, 'students', op.record_id);
        const isNew = !rec || rec.version === 0;
        if (isNew && this._countRecords(session.tenant_id, 'students') >= cap) {
          this._denyCap('plan_cap_students', `سقف دانش‌آموز پلن شما پر شده است (${cap}).`);
        }
      }
    }
    return super.pushSync(session, batch);
  }

  // حذف: فقط ردیف مستأجر خودی؛ کلید مستأجر دیگر هرگز لمس نمی‌شود
  removeRow({ session, collection, record_id }) {
    this._assertService(session, 'write', collection);
    const key = `${session.tenant_id}|${collection}|${record_id}`;
    const rec = this.core.records.get(key);
    if (!rec || rec.version === 0) throw new RequestError('not_found', 404);
    this.core.records.delete(key);
    this._audit({ action: 'row.delete', tenant: session.tenant_id, collection, record_id });
    return { deleted: true };
  }

  // ---------- فضای ذخیره‌سازی: بی‌اعتبارنامه در کلاینت (F‑04) ----------
  issueUploadTicket(session, { path, max_bytes = 1_048_576, ttlMs = TICKET_TTL_MS } = {}) {
    this._assertService(session, 'write', 'storage');
    const tenant = this.tenants.get(session.tenant_id);
    const ttl = Math.min(ttlMs, TICKET_TTL_MS);
    const id = `tk-${crypto.randomBytes(6).toString('hex')}`;
    const ticket = {
      id, tenant_id: tenant.id, prefix: tenant.storage_prefix, path,
      exp: this.now() + ttl, max_bytes, single_use: true,
    };
    this.storageTickets.set(id, { ...ticket, used: false });
    // بلیت هیچ کلید/رمز دائمی ندارد؛ فقط مسیر مقید + انقضا
    return { ...ticket };
  }

  putObject({ ticketId, session, bytes }) {
    this._assertService(session, 'write', 'storage');
    const t = this.storageTickets.get(ticketId);
    if (!t) throw new RequestError('ticket_unknown', 403);
    if (t.tenant_id !== session.tenant_id) throw new RequestError('tenant_mismatch', 403);
    if (t.used) throw new RequestError('ticket_used', 403);
    if (this.now() > t.exp) throw new RequestError('ticket_expired', 403);
    const buf = Buffer.from(bytes);
    if (buf.length > t.max_bytes) throw new RequestError('ticket_size_exceeded', 413);
    const plan = this._plan(session.tenant_id);
    const capBytes = (plan ? plan.caps.storage_mb : Infinity) * 1_048_576;
    if (this._storageBytes(session.tenant_id) + buf.length > capBytes) {
      this._denyCap('plan_cap_storage', 'سقف فضای ذخیره‌سازی پلن شما پر شده است.');
    }
    const key = `${t.prefix}/${t.path}`;
    this.storageObjects.set(key, buf);
    t.used = true;
    return { key, size: buf.length };
  }

  getObject(session, key) {
    this._assertService(session, 'read', 'storage');
    const tenant = this.tenants.get(session.tenant_id);
    if (!String(key).startsWith(`${tenant.storage_prefix}/`)) throw new RequestError('tenant_mismatch', 403);
    const v = this.storageObjects.get(key);
    if (!v) throw new RequestError('not_found', 404);
    return v;
  }

  // ---------- صف، کش، بکاپ: نام‌فضای مستأجرمحور ----------
  enqueue(session, { op_id, collection, record_id, payload }) {
    this._assertService(session, 'write', collection);
    if (!op_id) throw new RequestError('op_malformed');
    const row = { tenant_id: session.tenant_id, op_id, collection, record_id, payload, at: this.now() };
    this.queue.push(row);
    return row;
  }

  listQueue(session) {
    return this.queue.filter((r) => r.tenant_id === session.tenant_id);
  }

  flushQueue(session) {
    const mine = this.listQueue(session);
    for (const row of mine) {
      this.core.apply(session, {
        op_id: row.op_id, collection: row.collection, record_id: row.record_id,
        fields: row.payload, base_version: 0,
      });
    }
    this.queue = this.queue.filter((r) => r.tenant_id !== session.tenant_id);
    return mine.length;
  }

  cachePut(session, key, value) {
    this.cache.set(`${session.tenant_id}|${key}`, { value, at: this.now() });
    return true;
  }

  cacheGet(session, key) {
    const row = this.cache.get(`${session.tenant_id}|${key}`);
    return row ? row.value : undefined;
  }

  exportBackup(session) {
    if (session.level === 'A') throw new RequestError('platform_no_content_access', 403);  // D‑21
    if (session.role !== 'manager') throw new RequestError('role_denied', 403);
    const tenant = this.tenants.get(session.tenant_id);
    const rows = {};
    for (const [k, r] of this.core.records) {
      if (!k.startsWith(`${tenant.id}|`) || r.version === 0) continue;
      const [, collection, id] = k.split('|');
      (rows[collection] = rows[collection] || []).push({ id, fields: r.fields, version: r.version });
    }
    const body = { tenant_id: tenant.id, storage_prefix: tenant.storage_prefix, rows, at: this.now() };
    body.hash = sha256(JSON.stringify(rows));
    this.backups.set(tenant.id, body);
    return body;
  }

  importBackup(session, backup) {
    if (session.role !== 'manager') throw new RequestError('role_denied', 403);
    if (!backup || backup.tenant_id !== session.tenant_id) throw new RequestError('tenant_mismatch', 403);
    let applied = 0;
    for (const [collection, list] of Object.entries(backup.rows || {})) {
      for (const row of list) {
        this.core.apply(session, { op_id: `imp-${collection}-${row.id}-${applied}`, collection, record_id: row.id, fields: row.fields, base_version: 0 });
        applied++;
      }
    }
    return { applied };
  }

  // ---------- مجوز اضطراری D‑21 (۱۲‑ب §۳) ----------
  requestGrant({ token, tenant_id, scope, reason, case_ref, ttlMs = 30 * 60 * 1000 }) {
    const s = this.authenticatePlatform(token);
    if (s.role !== 'platform_support' && s.role !== 'platform_owner' && s.role !== 'platform_operator') {
      throw new RequestError('role_denied', 403);
    }
    if (!GRANT_SCOPES.includes(scope)) throw new RequestError('scope_not_allowed', 403);   // content_write ممنوع
    if (!reason || String(reason).trim().length < 10) throw new RequestError('reason_required', 403);
    if (ttlMs <= 0 || ttlMs > GRANT_MAX_MS) throw new RequestError('grant_ttl_invalid', 403);
    if (!this.tenants.has(tenant_id)) throw new RequestError('unknown_tenant', 404);
    const id = `gr-${crypto.randomBytes(5).toString('hex')}`;
    const g = {
      id, tenant_id, operator_id: s.operator_id, operator_role: s.role,
      approved_by: null, approved_role: null, case_ref, scope, reason,
      starts_at: this.now(), ends_at: this.now() + ttlMs,
      school_notified_at: null, revoked_at: null, used_reads: 0, max_actions: 50,
    };
    this.grants.set(id, g);
    return { ...g };
  }

  approveGrant({ token, grant_id }) {
    const s = this.authenticatePlatform(token);
    const g = this.grants.get(grant_id);
    if (!g) throw new RequestError('grant_unknown', 404);
    if (!APPROVER_ROLES.includes(s.role)) throw new RequestError('approver_not_allowed', 403);
    if (s.operator_id === g.operator_id) throw new RequestError('self_approval_forbidden', 403);  // چهار‌چشمی
    g.approved_by = s.operator_id;
    g.approved_role = s.role;
    this._audit({ action: 'grant.approve', grant_id, tenant: g.tenant_id, approver: s.operator_id });
    return { ...g };
  }

  notifySchool({ token, grant_id }) {
    const session = this.authenticate(token);       // مدیر مدرسه (سطح B)
    if (session.role !== 'manager') throw new RequestError('role_denied', 403);
    const g = this.grants.get(grant_id);
    if (!g) throw new RequestError('grant_unknown', 404);
    if (g.tenant_id !== session.tenant_id) throw new RequestError('tenant_mismatch', 403);
    g.school_notified_at = this.now();
    this._audit({ action: 'grant.notified', grant_id, tenant: g.tenant_id });
    return { ...g };
  }

  _activeGrant(grant_id, support) {
    const g = this.grants.get(grant_id);
    if (!g) throw new RequestError('grant_unknown', 404);
    if (g.revoked_at) throw new RequestError('grant_revoked', 403);
    if (!g.approved_by) throw new RequestError('grant_not_approved', 403);
    if (!g.school_notified_at) throw new RequestError('school_not_notified', 403);
    if (this.now() > g.ends_at) throw new RequestError('grant_expired', 403);
    if (g.used_reads >= g.max_actions) throw new RequestError('grant_exhausted', 403);
    if (support && g.tenant_id !== support.tenant_id) throw new RequestError('tenant_mismatch', 403);
    return g;
  }

  readAsSupport({ token, grant_id, collection, record_id }) {
    const s = this.authenticatePlatform(token);
    const g0 = this.grants.get(grant_id);
    if (!g0) throw new RequestError('grant_unknown', 404);
    if (g0.operator_id !== s.operator_id) throw new RequestError('grant_not_yours', 403);
    const g = this._activeGrant(grant_id);
    if (g.scope !== 'content_read') throw new RequestError('scope_metadata_only', 403);
    const rec = this.core.record(g.tenant_id, collection, record_id);
    if (!rec || rec.version === 0) throw new RequestError('not_found', 404);
    g.used_reads++;
    const log = { grant_id, tenant_id: g.tenant_id, collection, record_id, at: this.now(), support: s.operator_id };
    this.supportAccessLog.push(log);
    this._audit({ action: 'support.content_read', grant_id, tenant: g.tenant_id, record_id });
    return { fields: { ...rec.fields }, version: rec.version, logged: true };
  }

  readAsSupportBulk({ token, grant_id }) {
    this.authenticatePlatform(token);
    this._activeGrant(grant_id);
    throw new RequestError('bulk_download_denied', 403);   // D‑21: بدون دانلود انبوه
  }

  revokeGrant({ token, grant_id }) {
    const g = this.grants.get(grant_id);
    if (!g) throw new RequestError('grant_unknown', 404);
    const raw = String(token || '').replace(/^Bearer\s+/i, '');
    const p = this._verify(raw);
    let actor = 'system';
    if (p.lvl === 'A') {
      const s = this.authenticatePlatform(token);
      const allowed = APPROVER_ROLES.includes(s.role) || s.role === 'platform_support';
      if (!allowed) throw new RequestError('role_denied', 403);
      actor = s.operator_id;
    } else {
      const s = this.authenticate(token);          // توکن مدرسه — آفلاین نیست: نشست معتبر لازم است
      if (s.role !== 'manager' || s.tenant_id !== g.tenant_id) throw new RequestError('role_denied', 403);
      actor = `school:${s.user_id}`;
    }
    g.revoked_at = this.now();
    g.revoked_by = actor;
    this._audit({ action: 'grant.revoke', grant_id, tenant: g.tenant_id, by: actor });
    return { ...g };
  }

  // ---------- پنل پلتفرم: فقط فراداده، هرگز محتوا ----------
  platformSnapshot({ token }) {
    const s = this.authenticatePlatform(token);
    const tenants = [...this.tenants.values()].map((t) => {
      const sub = this.subs.get(t.id);
      return {
        id: t.id, code: t.code, status: t.status,
        plan: sub ? sub.plan : null, subscription: sub ? sub.status : null,
        users: this._countUsers(t.id), students: this._countRecords(t.id, 'students'),
      };
    });
    return { view: 'metadata', role: s.role, tenants, content_included: false };
  }
}

// دامنهٔ اثبات — صریح و بدون ادعای اضافی (اصل ۱۰ قانون اساسی)
const PROVEN = [
  'tenant isolation in this prototype data layer (read/write/delete, queue, cache, backup, storage)',
  'tenant derived from token/session only; request body tenant is rejected',
  'plan caps enforced server-side in the API layer of the prototype',
  'subscription state matrix per D-22 (login/read/write) incl. 180-day retention',
  'support_grant per D-21/12b: approval, notification, expiry, revocation, per-read logging, no bulk',
  'level A vs level B token separation',
];
const NOT_PROVEN = [
  'production_ready',
  'product_code_isolation',
  'real_postgres_rls',
  'product_api_endpoints',
  'capacity_or_sla',
  'security_gate',
];

module.exports = {
  Platform, PROVEN, NOT_PROVEN, AuthError, RequestError, canWrite,
  SUB_STATES, TRANSITIONS, RETENTION_DAYS, GRANT_MAX_MS, GRANT_SCOPES, TICKET_TTL_MS,
  PLATFORM_ROLES, APPROVER_ROLES, CLIENT_BAKED_CREDENTIALS, sha256,
};
