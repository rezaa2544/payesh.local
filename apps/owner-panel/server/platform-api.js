'use strict';
/* ═══════════════════════════════════════════════════════════════════
   API مستقل پنل مالک — PR-2 · `/api/platform/v1`

   پشت Gateway سرو می‌شود، اما هیچ وابستگی به احراز مدرسه ندارد:
     · توکن اختصاصی `platform.v1.<body>.<hmac>` با راز جداگانه
     · نقش معتبر از جدول `owner_platform.platform_users` بازخوانی می‌شود،
       نه از claim توکن و نه از بدنه/هدر
     · محتوا پیشفرض رد است؛ تنها یک رکورد، تنها با grant فعال، و هر خواندن
       یک ردیف `support_access_log` میسازد
     · خروجیها allowlist فیلد دارند؛ national_id / password_* / توکن هرگز
       بیرون نمیرود
     · request-id و rate-limit (در دیتابیس، مشترک بین نمونهها)

   اجرا: PAYESH_PLATFORM_PGURL + PAYESH_PLATFORM_TOKEN_SECRET تنظیم شوند؛
   در غیر این صورت تمام مسیرهای داده 503 `not_configured` میدهند (fail-closed).
   ═══════════════════════════════════════════════════════════════════ */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const auth = require('./owner-auth');

const PREFIX = '/api/platform/v1';
const TOKEN_PREFIX = 'platform.v1';
const ROLES = new Set(['platform_owner', 'platform_operator', 'platform_support']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RID_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const MAX_BODY = 32 * 1024;
/* allowlist دفاع در عمق: حتی اگر فیلدی به اشتباه در لیست خروجی آمد، بیرون نرود. */
const FORBIDDEN_KEY_RE = /^(national_id|password.*|.*token.*|.*secret.*|authorization|cookie|api_key)$/i;

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

/** Issue a platform token. Used by tests and by the login issuer (POST /auth/login, D‑45). */
function signPlatformToken(claims, secret) {
  if (!secret || String(secret).length < 16) throw new Error('platform token secret must be at least 16 characters');
  const body = b64url(JSON.stringify(Object.assign({ typ: 'platform', v: 1 }, claims)));
  const sig = crypto.createHmac('sha256', String(secret)).update(`${TOKEN_PREFIX}.${body}`).digest();
  return `${TOKEN_PREFIX}.${body}.${b64url(sig)}`;
}

/** Verify a platform token. School tokens (`v1.…`) are structurally rejected. */
function verifyPlatformToken(token, secret, now = Date.now()) {
  if (!secret || String(secret).length < 16) return null;
  const parts = String(token || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'platform' || parts[1] !== 'v1') return null;
  const [, , body, sig] = parts;
  const want = crypto.createHmac('sha256', String(secret)).update(`${TOKEN_PREFIX}.${body}`).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let c;
  try { c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!c || c.typ !== 'platform' || c.v !== 1) return null;
  if (!UUID_RE.test(String(c.sub || ''))) return null;
  if (!ROLES.has(c.role)) return null;
  if (!Number.isFinite(c.exp) || c.exp <= now) return null;
  return c;
}

function project(row, keys) {
  const out = {};
  if (!row || typeof row !== 'object') return out;
  for (const k of keys) {
    if (FORBIDDEN_KEY_RE.test(k)) continue;
    if (Object.prototype.hasOwnProperty.call(row, k)) out[k] = row[k];
  }
  return out;
}
function projectRows(rows, keys) { return (rows || []).map(r => project(r, keys)); }

/** pg Pool → the tiny `withTransaction(q)` interface the API needs. */
function createPgAdapter(pool, options = {}) {
  if (!pool) return null;
  const setRole = !!options.setRole;
  return {
    async withTransaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (setRole) await client.query('SET LOCAL ROLE payesh_platform_runtime');
        const result = await fn((sql, params = []) => client.query(sql, params));
        await client.query('COMMIT');
        return result;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

function bearer(headers) {
  const h = String((headers && headers.authorization) || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}
function ok(body, status = 200, headers = {}) { return { status, body, headers }; }
function err(status, error, extra = {}) {
  return { status, body: Object.assign({ ok: false, error }, extra) };
}

/* ── قرارداد مسیرها (منبع واحد برای router و OpenAPI) ─────────────────── */
const PLATFORM_ROUTES = [
  { method: 'GET',    path: '/health/summary',                              auth: false, handler: 'healthSummary' },
  { method: 'GET',    path: '/openapi.json',                               auth: false, handler: 'openapi' },
  /* ردیف ۹۸ / D‑45 — ورود انسانی: رمز + TOTP، بدون توکن قبلی */
  { method: 'POST',   path: '/auth/login',                                 auth: false, handler: 'authLogin' },
  { method: 'GET',    path: '/dashboard',                                  auth: true,  handler: 'dashboard' },
  { method: 'GET',    path: '/tenants',                                    auth: true,  handler: 'tenants' },
  /* row 121 — create a school: owner only, reason, provision_op_id (16b §1.4 saga) */
  { method: 'POST',   path: '/tenants',                                    auth: true,  handler: 'tenantsCreate' },
  { method: 'GET',    path: '/tenants/{tenant_id}',                         auth: true,  handler: 'tenant' },
  { method: 'DELETE', path: '/tenants/{tenant_id}',                         auth: true,  handler: 'deleteTenant' },
  { method: 'GET',    path: '/tenants/{tenant_id}/limits',                  auth: true,  handler: 'limits' },
  { method: 'GET',    path: '/tenants/{tenant_id}/usage',                   auth: true,  handler: 'usage' },
  { method: 'GET',    path: '/tenants/{tenant_id}/content',                 auth: true,  handler: 'bulkContent' },
  { method: 'GET',    path: '/tenants/{tenant_id}/content/{collection}/{record_ref}', auth: true, handler: 'contentRecord' },
  { method: 'GET',    path: '/plans',                                      auth: true,  handler: 'plansList' },
  { method: 'POST',   path: '/plans',                                      auth: true,  handler: 'plansCreate' },
  { method: 'GET',    path: '/subscriptions',                              auth: true,  handler: 'subscriptions' },
  { method: 'POST',   path: '/subscriptions/{subscription_id}/renew',      auth: true,  handler: 'subscriptionRenew' },
  { method: 'POST',   path: '/tenants/{tenant_id}/suspend',                auth: true,  handler: 'tenantSuspend' },
  { method: 'GET',    path: '/platform-users',                             auth: true,  handler: 'platformUsers' },
  { method: 'POST',   path: '/platform-users',                             auth: true,  handler: 'platformUsersCreate' },
  { method: 'GET',    path: '/support-grants',                             auth: true,  handler: 'supportGrants' },
  { method: 'POST',   path: '/support-grants',                             auth: true,  handler: 'supportGrantsRequest' },
  { method: 'POST',   path: '/support-grants/{request_id}/approve',        auth: true,  handler: 'supportGrantApprove' },
  { method: 'POST',   path: '/support-grants/{grant_id}/revoke',           auth: true,  handler: 'supportGrantRevoke' },
  { method: 'GET',    path: '/audit',                                      auth: true,  handler: 'audit' },
  /* ردیف ۹۸ — حذف دومرحله‌ای: owner درخواست، owner دیگر تأیید، اجرا ≥۲۴ساعت پس از تأیید (12b §100، D-22) */
  { method: 'GET',    path: '/tenant-deletions',                           auth: true,  handler: 'tenantDeletions' },
  { method: 'POST',   path: '/tenants/{tenant_id}/deletion-request',       auth: true,  handler: 'tenantDeletionRequest' },
  { method: 'POST',   path: '/tenant-deletions/{request_id}/approve',      auth: true,  handler: 'tenantDeletionApprove' },
  { method: 'POST',   path: '/tenant-deletions/{request_id}/cancel',       auth: true,  handler: 'tenantDeletionCancel' },
  { method: 'POST',   path: '/tenant-deletions/{request_id}/execute',      auth: true,  handler: 'tenantDeletionExecute' },
];

function compile(route) {
  const names = [];
  const source = route.path.replace(/\{([a-z_]+)\}/g, (_, n) => { names.push(n); return '([^/]+)'; });
  return { re: new RegExp(`^${source}$`), names };
}
const COMPILED = PLATFORM_ROUTES.map(r => Object.assign({}, r, compile(r)));

/* ── allowlist خروجی ─────────────────────────────────────────────────── */
const FIELDS = {
  subscription: ['id', 'tenant_id', 'plan_code', 'status', 'starts_at', 'ends_at', 'grace_days', 'auto_renew', 'canceled_at', 'version', 'updated_at'],
  plan: ['code', 'name', 'max_users', 'max_students', 'storage_mb', 'features', 'price_amount', 'price_cycle', 'is_public', 'created_at', 'updated_at', 'archived_at'],
  limits: ['tenant_id', 'max_users', 'max_students', 'storage_bytes', 'updated_at'],
  usage: ['tenant_id', 'users_count', 'students_count', 'storage_bytes', 'last_recalc_at'],
  user: ['id', 'login_id', 'role', 'status', 'created_at', 'updated_at'],
  grant: ['id', 'tenant_id', 'operator_id', 'approved_by', 'case_ref', 'scope', 'reason', 'starts_at', 'ends_at', 'school_notified_at', 'revoked_at', 'used_reads', 'max_actions', 'open_slot', 'created_at'],
  request: ['id', 'tenant_id', 'operator_id', 'case_ref', 'scope', 'reason', 'starts_at', 'ends_at', 'school_notified_at', 'max_actions', 'status', 'approved_by', 'created_at'],
  deletion: ['id', 'tenant_id', 'requested_by', 'reason', 'status', 'approved_by', 'approved_at', 'not_before',
    'canceled_by', 'canceled_at', 'cancel_reason', 'executed_by', 'executed_at', 'retain_until', 'created_at',
    'subscriptions_canceled', 'data_destroyed'],
  audit: ['sequence_id', 'event_id', 'actor_id', 'actor_ref', 'action', 'subject_type', 'subject_ref', 'tenant_id', 'reason', 'details', 'created_at'],
};

/* ── زنجیرهٔ هش حسابرسی ──────────────────────────────────────────────── */
function canonical(o) { return JSON.stringify(o); }
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}
/* payload فقط از ستونهای ذخیرهشده ساخته میشود تا آزمون بتواند همان هش را
   از روی ردیف دیتابیس بازتولید کند (بدون وابستگی به حافظهٔ فرایند). */
function auditPayload(row) {
  return stable({
    event_id: row.event_id,
    actor_id: row.actor_id,
    actor_ref: row.actor_ref,
    action: row.action,
    subject_type: row.subject_type,
    subject_ref: row.subject_ref == null ? null : row.subject_ref,
    tenant_id: row.tenant_id == null ? null : row.tenant_id,
    reason: row.reason == null ? null : row.reason,
    details: row.details || {},
  });
}
async function appendAudit(q, ctx, spec) {
  const eventId = crypto.randomUUID();
  const details = Object.assign({}, spec.details || {}, { request_id: ctx.requestId });
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await q('SELECT encode(event_hash, \'hex\') AS h FROM owner_platform.platform_audit ORDER BY sequence_id DESC LIMIT 1');
    const previousHex = (head.rows[0] && head.rows[0].h) || '00'.repeat(32);
    const row = {
      event_id: eventId,
      actor_id: ctx.claims.sub,
      actor_ref: spec.actor_ref || ctx.claims.sub,
      action: spec.action,
      subject_type: spec.subject_type,
      subject_ref: spec.subject_ref || null,
      tenant_id: spec.tenant_id || null,
      reason: spec.reason || null,
      details,
    };
    const eventHex = crypto.createHash('sha256')
      .update(Buffer.from(previousHex, 'hex'))
      .update(Buffer.from(auditPayload(row), 'utf8'))
      .digest('hex');
    try {
      await q(`INSERT INTO owner_platform.platform_audit
        (event_id, actor_id, actor_ref, action, subject_type, subject_ref,
         tenant_id, reason, details, previous_hash, event_hash)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb, decode($10,'hex'), decode($11,'hex'))`,
      [eventId, ctx.claims.sub, row.actor_ref, row.action, row.subject_type,
        row.subject_ref, row.tenant_id, row.reason, stable(details), previousHex, eventHex]);
      return { event_id: eventId, previous_hash: previousHex, event_hash: eventHex };
    } catch (e) {
      /* رقابت دو تراکنش روی head زنجیره: دوباره head تازه بخوان. */
      if (e && e.code === '23514' && attempt < 2) continue;
      throw e;
    }
  }
}

function needRole(ctx, roles) {
  /* لایهٔ نخست؛ مرجع نهایی همان require_actor() در دیتابیس است. */
  if (!roles.includes(ctx.claims.role)) return err(403, 'role_forbidden', { required: roles });
  return null;
}
function needTenant(params) {
  const id = String(params.tenant_id || '');
  return UUID_RE.test(id) ? id : null;
}
function needReason(body) {
  const r = String((body && body.reason) || '').trim();
  return r.length >= 10 ? r : null;
}

/* ── handlerها ───────────────────────────────────────────────────────── */
const HANDLERS = {
  healthSummary(_q, ctx) {
    return ok({ ok: true, namespace: PREFIX, instance: ctx.instance,
      configured: true, auth: 'platform.v1 HMAC token (separate from school auth)',
      content_default: 'deny', security: 'UNKNOWN' });
  },
  openapi(_q, ctx) { return ok(ctx.openapi); },

  async dashboard(q) {
    const r = await q(`SELECT
      (SELECT count(*)::int FROM owner_platform.subscriptions) AS subscriptions,
      (SELECT count(*)::int FROM owner_platform.plans) AS plans,
      (SELECT count(*)::int FROM owner_platform.platform_users WHERE status='active') AS active_users,
      (SELECT count(*)::int FROM owner_platform.support_grant
        WHERE revoked_at IS NULL AND ends_at > clock_timestamp()) AS open_grants`);
    return ok({ ok: true, dashboard: project(r.rows[0], ['subscriptions', 'plans', 'active_users', 'open_grants']) });
  },
  async tenants(q) {
    const r = await q('SELECT * FROM owner_platform.subscriptions ORDER BY tenant_id LIMIT 200');
    return ok({ ok: true, tenants: projectRows(r.rows, FIELDS.subscription), count: r.rows.length });
  },
  async tenant(q, ctx) {
    const t = needTenant(ctx.params);
    if (!t) return err(400, 'invalid_tenant_id');
    const r = await q('SELECT * FROM owner_platform.subscriptions WHERE tenant_id=$1', [t]);
    if (!r.rows.length) return err(404, 'tenant_not_found');
    return ok({ ok: true, tenant: project(r.rows[0], FIELDS.subscription) });
  },
  deleteTenant() {
    /* حذف فوری هرگز؛ فقط گردش دومرحله‌ای زیر با مهلت ۲۴ ساعت. */
    return err(403, 'tenant_deletion_disabled',
      { detail: 'حذف فوری مدرسه مجاز نیست؛ از درخواست حذف + تأیید مالک دوم + مهلت ۲۴ ساعت استفاده کنید.',
        flow: 'POST /tenants/{tenant_id}/deletion-request' });
  },
  async limits(q, ctx) {
    const t = needTenant(ctx.params);
    if (!t) return err(400, 'invalid_tenant_id');
    const r = await q('SELECT * FROM owner_platform.tenant_limits WHERE tenant_id=$1', [t]);
    return ok({ ok: true, limits: r.rows.length ? project(r.rows[0], FIELDS.limits) : null });
  },
  async usage(q, ctx) {
    const t = needTenant(ctx.params);
    if (!t) return err(400, 'invalid_tenant_id');
    const r = await q('SELECT * FROM owner_platform.tenant_usage WHERE tenant_id=$1', [t]);
    return ok({ ok: true, usage: r.rows.length ? project(r.rows[0], FIELDS.usage) : null });
  },
  bulkContent() {
    return err(403, 'bulk_content_forbidden',
      { detail: 'فهرست/خروجیگیری انبوه محتوا تعریف نشده است؛ فقط یک رکورد با grant فعال.' });
  },
  async contentRecord(q, ctx) {
    const t = needTenant(ctx.params);
    if (!t) return err(400, 'invalid_tenant_id');
    const collection = String(ctx.params.collection || '');
    const ref = String(ctx.params.record_ref || '');
    if (!/^[a-z0-9_]{1,40}$/.test(collection) || !/^[0-9]{1,18}$/.test(ref)) {
      return err(400, 'invalid_record_reference');
    }
    /* grant فعال، همین مستأجر، همین اپراتور، scope=content_read */
    const g = await q(`SELECT id FROM owner_platform.support_grant
      WHERE tenant_id=$1 AND operator_id=$2 AND scope='content_read'
        AND revoked_at IS NULL AND starts_at <= clock_timestamp()
        AND ends_at > clock_timestamp() AND school_notified_at < starts_at
      ORDER BY starts_at DESC LIMIT 1`, [t, ctx.claims.sub]);
    if (!g.rows.length) return err(403, 'grant_required');
    const r = await q('SELECT owner_platform.read_school_record($1,$2,$3,$4) AS result',
      [g.rows[0].id, t, collection, ref]);
    const data = r.rows[0].result;
    return ok({ ok: true, content: project(data,
      ['found', 'grant_id', 'tenant_id', 'collection', 'record_ref', 'read_log_id', 'data']) });
  },

  async plansList(q) {
    const r = await q('SELECT * FROM owner_platform.plans ORDER BY code LIMIT 200');
    return ok({ ok: true, plans: projectRows(r.rows, FIELDS.plan), count: r.rows.length });
  },
  async plansCreate(q, ctx) {
    const denied = needRole(ctx, ['platform_owner']);
    if (denied) return denied;
    const b = ctx.body || {};
    const r = await q('SELECT owner_platform.create_plan($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) AS result',
      [String(b.code || ''), String(b.name || ''), b.max_users ?? null, b.max_students ?? null,
        Number(b.storage_mb ?? 0), canonical(b.features || {}), Number(b.price_amount ?? 0),
        String(b.price_cycle || 'none'), !!b.is_public]);
    await appendAudit(q, ctx, { action: 'plan.create', subject_type: 'plan',
      subject_ref: String(b.code || ''), reason: String(b.reason || 'plan created by platform owner'),
      details: { code: String(b.code || '') } });
    return ok({ ok: true, plan: project(r.rows[0].result, FIELDS.plan) }, 201);
  },
  async subscriptions(q) {
    const r = await q(`SELECT * FROM owner_platform.subscriptions ORDER BY tenant_id, starts_at DESC LIMIT 200`);
    return ok({ ok: true, subscriptions: projectRows(r.rows, FIELDS.subscription), count: r.rows.length });
  },
  async subscriptionRenew(q, ctx) {
    const denied = needRole(ctx, ['platform_owner']);
    if (denied) return denied;
    const sid = String(ctx.params.subscription_id || '');
    if (!UUID_RE.test(sid)) return err(400, 'invalid_subscription_id');
    const reason = needReason(ctx.body);
    if (!reason) return err(400, 'reason_too_short');
    /* مستأجر از دیتابیس میآید، نه از بدنهٔ درخواست */
    const found = await q('SELECT tenant_id FROM owner_platform.subscriptions WHERE id=$1', [sid]);
    if (!found.rows.length) return err(404, 'subscription_not_found');
    const tenantId = found.rows[0].tenant_id;
    const key = String((ctx.body && ctx.body.idempotency_key) || ctx.requestId);
    const r = await q('SELECT owner_platform.apply_subscription_transition($1,$2,$3,$4,$5,$6) AS result',
      [sid, tenantId, 'active', reason, key, Number((ctx.body && ctx.body.extend_days) || 30)]);
    const result = r.rows[0].result;
    await appendAudit(q, ctx, { action: 'subscription.renew', subject_type: 'subscription',
      subject_ref: sid, tenant_id: tenantId, reason,
      details: { idempotent: !!result.idempotent } });
    return ok({ ok: true, transition: result });
  },
  async tenantSuspend(q, ctx) {
    const denied = needRole(ctx, ['platform_owner', 'platform_operator']);
    if (denied) return denied;
    const t = needTenant(ctx.params);
    if (!t) return err(400, 'invalid_tenant_id');
    const reason = needReason(ctx.body);
    if (!reason) return err(400, 'reason_too_short');
    const sub = await q('SELECT id FROM owner_platform.subscriptions WHERE tenant_id=$1 LIMIT 1', [t]);
    if (!sub.rows.length) return err(404, 'tenant_not_found');
    const key = String((ctx.body && ctx.body.idempotency_key) || ctx.requestId);
    const r = await q('SELECT owner_platform.apply_subscription_transition($1,$2,$3,$4,$5,$6) AS result',
      [sub.rows[0].id, t, 'suspended', reason, key, 1]);
    await appendAudit(q, ctx, { action: 'tenant.suspend', subject_type: 'tenant',
      subject_ref: t, tenant_id: t, reason, details: {} });
    return ok({ ok: true, transition: r.rows[0].result });
  },

  async platformUsers(q) {
    const r = await q('SELECT * FROM owner_platform.platform_users ORDER BY created_at LIMIT 200');
    return ok({ ok: true, users: projectRows(r.rows, FIELDS.user), count: r.rows.length });
  },
  async platformUsersCreate(q, ctx) {
    const denied = needRole(ctx, ['platform_owner']);
    if (denied) return denied;
    const b = ctx.body || {};
    const r = await q('SELECT owner_platform.register_platform_user($1,$2,$3) AS result',
      [String(b.login_id || ''), String(b.role || ''), String(b.status || 'active')]);
    await appendAudit(q, ctx, { action: 'platform_user.create', subject_type: 'platform_user',
      subject_ref: String(b.login_id || ''), reason: String(b.reason || 'platform user registered'),
      details: { role: String(b.role || '') } });
    return ok({ ok: true, user: project(r.rows[0].result, FIELDS.user) }, 201);
  },
  async supportGrants(q) {
    const r = await q('SELECT * FROM owner_platform.support_grant ORDER BY created_at DESC LIMIT 200');
    return ok({ ok: true, grants: projectRows(r.rows, FIELDS.grant), count: r.rows.length });
  },
  async supportGrantsRequest(q, ctx) {
    /* مالک فقط تأیید میکند؛ درخواست از اپراتور/پشتیبانی است (چهارچشم). */
    const denied = needRole(ctx, ['platform_operator', 'platform_support']);
    if (denied) return denied;
    const b = ctx.body || {};
    const scope = String(b.scope || '');
    if (!['metadata', 'content_read'].includes(scope)) return err(400, 'invalid_scope',
      { detail: 'content_write و هر دامنهٔ دیگر رد میشود؛ فقط metadata|content_read.' });
    const t = needTenant({ tenant_id: b.tenant_id });
    if (!t) return err(400, 'invalid_tenant_id');
    const r = await q('SELECT owner_platform.request_support_grant($1,$2,$3,$4,$5,$6,$7,$8) AS result',
      [t, scope, String(b.reason || ''), b.case_ref == null ? null : String(b.case_ref),
        b.starts_at, b.ends_at, b.school_notified_at, Number(b.max_actions || 1)]);
    await appendAudit(q, ctx, { action: 'grant.request', subject_type: 'support_grant_request',
      subject_ref: r.rows[0].result.id, tenant_id: t, reason: String(b.reason || ''),
      details: { scope } });
    return ok({ ok: true, request: project(r.rows[0].result, FIELDS.request) }, 201);
  },
  async supportGrantApprove(q, ctx) {
    const denied = needRole(ctx, ['platform_owner']);
    if (denied) return denied;
    const rid = String(ctx.params.request_id || '');
    if (!UUID_RE.test(rid)) return err(400, 'invalid_request_id');
    const found = await q('SELECT tenant_id FROM owner_platform.support_grant_request WHERE id=$1', [rid]);
    if (!found.rows.length) return err(404, 'request_not_found');
    const t = found.rows[0].tenant_id;
    const r = await q('SELECT owner_platform.approve_support_grant($1,$2) AS result', [rid, t]);
    await appendAudit(q, ctx, { action: 'grant.approve', subject_type: 'support_grant',
      subject_ref: r.rows[0].result.grant_id, tenant_id: t,
      reason: String((ctx.body || {}).reason || 'grant approved by platform owner'), details: {} });
    return ok({ ok: true, approval: r.rows[0].result });
  },
  async supportGrantRevoke(q, ctx) {
    const denied = needRole(ctx, ['platform_owner']);
    if (denied) return denied;
    const gid = String(ctx.params.grant_id || '');
    if (!UUID_RE.test(gid)) return err(400, 'invalid_grant_id');
    const found = await q('SELECT tenant_id FROM owner_platform.support_grant WHERE id=$1', [gid]);
    if (!found.rows.length) return err(404, 'grant_not_found');
    const t = found.rows[0].tenant_id;
    const reason = needReason(ctx.body);
    if (!reason) return err(400, 'reason_too_short');
    const r = await q('SELECT owner_platform.revoke_support_grant($1,$2,$3) AS result', [gid, t, reason]);
    await appendAudit(q, ctx, { action: 'grant.revoke', subject_type: 'support_grant',
      subject_ref: gid, tenant_id: t, reason, details: {} });
    return ok({ ok: true, revocation: r.rows[0].result });
  },
  async tenantDeletions(q, ctx) {
    const denied = needRole(ctx, ['platform_owner']);
    if (denied) return denied;
    const r = await q(`SELECT * FROM owner_platform.tenant_deletion_request
      ORDER BY created_at DESC LIMIT 200`);
    return ok({ ok: true, requests: projectRows(r.rows, FIELDS.deletion), count: r.rows.length });
  },
  async tenantDeletionRequest(q, ctx) {
    const denied = needRole(ctx, ['platform_owner']);
    if (denied) return denied;
    const t = needTenant(ctx.params);
    if (!t) return err(400, 'invalid_tenant_id');
    const reason = needReason(ctx.body);
    if (!reason) return err(400, 'reason_too_short');
    /* تأیید دوباره: شناسهٔ مدرسه باید عیناً در بدنه تکرار شود */
    if (String((ctx.body && ctx.body.confirm_tenant_id) || '') !== t) return err(400, 'confirm_mismatch');
    const r = await q('SELECT owner_platform.request_tenant_deletion($1,$2) AS result', [t, reason]);
    const row = r.rows[0].result;
    await appendAudit(q, ctx, { action: 'tenant.deletion.request', subject_type: 'tenant_deletion_request',
      subject_ref: row.id, tenant_id: t, reason, details: {} });
    return ok({ ok: true, request: project(row, FIELDS.deletion) }, 201);
  },
  async tenantDeletionApprove(q, ctx) {
    const denied = needRole(ctx, ['platform_owner']);
    if (denied) return denied;
    const found = await deletionTenant(q, ctx);
    if (found.error) return found.error;
    if (found.row.requested_by === ctx.claims.sub) return err(403, 'four_eyes_required');
    const r = await q('SELECT owner_platform.approve_tenant_deletion($1,$2) AS result', [found.row.id, found.row.tenant_id]);
    const row = r.rows[0].result;
    await appendAudit(q, ctx, { action: 'tenant.deletion.approve', subject_type: 'tenant_deletion_request',
      subject_ref: row.id, tenant_id: row.tenant_id,
      reason: String((ctx.body || {}).reason || 'deletion approved by second platform owner'),
      details: { not_before: row.not_before } });
    return ok({ ok: true, request: project(row, FIELDS.deletion) });
  },
  async tenantDeletionCancel(q, ctx) {
    const denied = needRole(ctx, ['platform_owner']);
    if (denied) return denied;
    const found = await deletionTenant(q, ctx);
    if (found.error) return found.error;
    const reason = needReason(ctx.body);
    if (!reason) return err(400, 'reason_too_short');
    const r = await q('SELECT owner_platform.cancel_tenant_deletion($1,$2,$3) AS result',
      [found.row.id, found.row.tenant_id, reason]);
    const row = r.rows[0].result;
    await appendAudit(q, ctx, { action: 'tenant.deletion.cancel', subject_type: 'tenant_deletion_request',
      subject_ref: row.id, tenant_id: row.tenant_id, reason, details: {} });
    return ok({ ok: true, request: project(row, FIELDS.deletion) });
  },
  async tenantDeletionExecute(q, ctx) {
    const denied = needRole(ctx, ['platform_owner']);
    if (denied) return denied;
    const found = await deletionTenant(q, ctx);
    if (found.error) return found.error;
    const row0 = found.row;
    if (row0.status === 'approved') {
      const due = await q('SELECT clock_timestamp() >= $1::timestamptz AS due', [row0.not_before]);
      /* پیام روشن برای UI؛ مرجع نهایی همان بررسی داخل execute_tenant_deletion است */
      if (!due.rows[0].due) return err(409, 'deletion_delay_pending', { not_before: row0.not_before });
    }
    const r = await q('SELECT owner_platform.execute_tenant_deletion($1,$2) AS result', [row0.id, row0.tenant_id]);
    const row = r.rows[0].result;
    await appendAudit(q, ctx, { action: 'tenant.deletion.execute', subject_type: 'tenant_deletion_request',
      subject_ref: row.id, tenant_id: row.tenant_id,
      reason: String((ctx.body || {}).reason || 'deletion executed after four-eyes approval and 24h delay'),
      details: { retain_until: row.retain_until, subscriptions_canceled: row.subscriptions_canceled, data_destroyed: false } });
    return ok({ ok: true, request: project(row, FIELDS.deletion) });
  },
  async audit(q) {
    const r = await q(`SELECT sequence_id, event_id, actor_id, actor_ref, action, subject_type,
      subject_ref, tenant_id, reason, details, created_at,
      encode(previous_hash,'hex') AS previous_hash, encode(event_hash,'hex') AS event_hash
      FROM owner_platform.platform_audit ORDER BY sequence_id DESC LIMIT 100`);
    return ok({ ok: true, events: projectRows(r.rows,
      FIELDS.audit.concat(['previous_hash', 'event_hash'])), count: r.rows.length });
  },
};

async function deletionTenant(q, ctx) {
  const rid = String(ctx.params.request_id || '');
  if (!UUID_RE.test(rid)) return { error: err(400, 'invalid_request_id') };
  const r = await q('SELECT * FROM owner_platform.tenant_deletion_request WHERE id=$1', [rid]);
  if (!r.rows.length) return { error: err(404, 'request_not_found') };
  return { row: r.rows[0] };
}

/* ── row 121: POST /tenants — create a school (16b §1 steps 1,2,5,8,9; §1.4 saga) ──────────
   Three steps, each idempotent under the same provision_op_id, so a retry after any failure
   converges instead of forking a second school:
     1) platform tx: provision_tenant() (registry + subscription 'provisioning' + limits) + audit
     2) school side (injected hook, school runtime role, forced RLS of the new tenant):
        slug → tenant mapping, users#1 = initial manager, one-time activation code
     3) platform tx: activate_tenant() (subscription → active) + audit
   The activation code is returned once to the owner (no-store) and is never written to audit. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
async function createTenantSaga(db, provisioner, ctx) {
  const denied = needRole(ctx, ['platform_owner']);
  if (denied) return denied;
  if (typeof provisioner !== 'function') return err(503, 'school_provisioning_not_configured');
  const b = ctx.body || {};
  const opId = String(b.provision_op_id || '');
  if (!UUID_RE.test(opId)) return err(400, 'invalid_provision_op_id');
  const slug = String(b.slug || '').trim();
  if (!SLUG_RE.test(slug)) return err(400, 'invalid_slug');
  const name = String(b.display_name || '').trim();
  if (name.length < 2 || name.length > 120) return err(400, 'invalid_display_name');
  const managerName = String(b.manager_name || '').trim();
  if (managerName.length < 2 || managerName.length > 120) return err(400, 'invalid_manager_name');
  const plan = String(b.plan_code || '');
  const reason = needReason(b);
  if (!reason) return err(400, 'reason_too_short');
  const asActor = (fn) => db.withTransaction(async (q) => {
    await q("SELECT set_config('app.platform_user_id', $1, true), set_config('app.tenant_id', '', true)", [ctx.claims.sub]);
    return fn(q);
  });
  const reg = await asActor(async (q) => {
    const r = await q('SELECT owner_platform.provision_tenant($1,$2,$3,$4) AS result', [opId, slug, name, plan]);
    const out = r.rows[0].result;
    if (!out.idempotent) {
      await appendAudit(q, ctx, { action: 'tenant.provision', subject_type: 'tenant', subject_ref: out.tenant_id,
        tenant_id: out.tenant_id, reason, details: { slug, plan_code: plan, provision_op_id: opId } });
    }
    return out;
  });
  let school;
  try {
    school = await provisioner({ tenantId: reg.tenant_id, slug, managerName, opId });
  } catch (e) {
    /* the registry row stays 'provisioning'; the same request is safe to retry */
    return err(e && e.status === 409 ? 409 : 502, e && e.status === 409 ? 'slug_taken_in_school_db' : 'school_provisioning_failed',
      { tenant_id: reg.tenant_id, status: 'provisioning', retry: 'same provision_op_id' });
  }
  const act = await asActor(async (q) => {
    const r = await q('SELECT owner_platform.activate_tenant($1) AS result', [reg.tenant_id]);
    const out = r.rows[0].result;
    if (!out.idempotent) {
      await appendAudit(q, ctx, { action: 'tenant.activate', subject_type: 'tenant', subject_ref: reg.tenant_id,
        tenant_id: reg.tenant_id, reason, details: { slug, provision_op_id: opId, manager_uid: school.manager_uid } });
    }
    return out;
  });
  return ok({ ok: true,
    tenant: { tenant_id: act.tenant_id, slug: act.slug, display_name: act.display_name, plan_code: act.plan_code,
      status: act.status },
    manager: { uid: school.manager_uid, school: slug, activated: !!school.manager_activated,
      activation_code: school.activation_code || null },
    idempotent: !!reg.idempotent }, reg.idempotent ? 200 : 201);
}

function mapError(e) {
  const code = e && e.code;
  if (code === '42501') return err(403, 'forbidden', { data_layer: '42501' });
  if (code === '23514') return err(400, 'invalid_input', { data_layer: '23514' });
  if (code === '23505') return err(409, 'conflict', { data_layer: '23505' });
  if (code === '23503' || code === '22P02' || code === '22007') return err(400, 'invalid_input', { data_layer: code });
  return err(500, 'internal_error');
}

function createPlatformApi(options = {}) {
  const db = options.db || null;
  const secret = String(options.secret || '');
  const now = options.now || (() => Date.now());
  const rateMax = Number(options.rateLimitMax || 120);
  const windowSec = Number(options.rateLimitWindowSec || 60);
  const instance = String(options.instance || ('platform-' + process.pid));
  const configured = !!db && secret.length >= 16;
  const loginMax = Number(options.loginRateMax || 10);
  const loginWindowSec = Number(options.loginRateWindowSec || 300);
  const tokenTtlMs = Number(options.tokenTtlMs || 8 * 3600 * 1000);
  /* row 121: school-side provisioning hook (Gateway injects school-access.provisionSchool) */
  const schoolProvisioner = typeof options.schoolProvisioner === 'function' ? options.schoolProvisioner : null;
  const openapi = JSON.parse(fs.readFileSync(path.join(__dirname, 'openapi.json'), 'utf8'));

  function match(method, sub) {
    for (const r of COMPILED) {
      if (r.method !== method) continue;
      const m = r.re.exec(sub);
      if (!m) continue;
      const params = {};
      r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return null;
  }

  function errorOut(status, error, extra, rid, rateHeaders) {
    return { status, headers: Object.assign({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-request-id': rid,
      'x-platform-instance': instance,
    }, rateHeaders || {}), body: Object.assign({ ok: false, error }, extra || {}) };
  }

  /* ── POST /auth/login — D‑45: رمز + TOTP اجباری، حداکثر ۳ حساب، بدون محدودیت IP ──
     ترتیب: اعتبارسنجی شکل → سهمیه (شناسه و IP، در دیتابیس) → login_lookup →
     scrypt + TOTP → record_login_attempt (تکرار/قفل/ممیزی، مرجع نهایی) → توکن.
     هر شکست یک پاسخ یکسان 401 دارد تا وجود حساب، قفل یا غیرفعال بودن لو نرود. */
  async function login(input, rid, reply) {
    if (!configured) return reply(503, { ok: false, error: 'not_configured' });
    const b = input.body && typeof input.body === 'object' ? input.body : {};
    const loginId = typeof b.login_id === 'string' ? b.login_id.trim() : '';
    const password = typeof b.password === 'string' ? b.password : '';
    const code = typeof b.totp === 'string' ? b.totp.trim() : '';
    if (!loginId || loginId.length > 120 || !password || password.length > 256 || !/^[0-9]{6}$/.test(code)) {
      return reply(400, { ok: false, error: 'invalid_login_request' });
    }
    const loginRef = auth.ref('login', loginId);
    const ipRef = auth.ref('ip', input.remote || 'unknown');
    const bucket = Math.floor(now() / 1000 / loginWindowSec) * loginWindowSec;
    let hits;
    try {
      hits = await db.withTransaction(async (q) => {
        let max = 0;
        for (const subject of ['login-id:' + loginRef, 'login-ip:' + ipRef]) {
          const r = await q(`INSERT INTO owner_platform.api_rate_limit (subject, window_start, hits)
            VALUES ($1,$2,1)
            ON CONFLICT (subject, window_start)
            DO UPDATE SET hits = owner_platform.api_rate_limit.hits + 1
            RETURNING hits`, [subject, bucket]);
          max = Math.max(max, Number(r.rows[0].hits));
        }
        return max;
      });
    } catch (e) {
      return reply(503, { ok: false, error: 'rate_limit_unavailable' });
    }
    if (hits > loginMax) {
      return reply(429, { ok: false, error: 'rate_limited',
        retry_after_ms: Math.max(1, (bucket + loginWindowSec) * 1000 - now()) });
    }
    let row;
    try {
      row = await db.withTransaction(async (q) =>
        (await q('SELECT * FROM owner_platform.login_lookup($1)', [loginId])).rows[0] || null);
    } catch (e) {
      if (e && (e.code === '42883' || e.code === '42P01')) return reply(501, { ok: false, error: 'login_not_installed' });
      return reply(503, { ok: false, error: 'login_unavailable' });
    }
    const pwOk = await auth.verifyPassword(password, row && row.password_hash);
    const step = row && pwOk ? auth.verifyTotp(row.totp_secret, code, now()) : null;
    const measured = !row ? 'unknown_login' : (pwOk && step !== null ? 'ok' : 'bad_credentials');
    let outcome;
    try {
      outcome = await db.withTransaction(async (q) => {
        const r = await q('SELECT owner_platform.record_login_attempt($1,$2,$3,$4,$5,$6) AS outcome',
          [row ? row.user_id : null, loginRef, ipRef, measured, step, rid]);
        const o = r.rows[0].outcome;
        if (o === 'ok') {
          await q("SELECT set_config('app.platform_user_id', $1, true)", [row.user_id]);
          await appendAudit(q, { requestId: rid, claims: { sub: row.user_id } }, {
            action: 'auth.login', subject_type: 'platform_user', subject_ref: row.user_id,
            details: { amr: ['pwd', 'otp'] } });
        }
        return o;
      });
    } catch (e) {
      if (process.env.PLATFORM_API_DEBUG) console.error('PLATFORM_LOGIN_ERROR', e);
      return reply(503, { ok: false, error: 'login_unavailable' });
    }
    if (outcome !== 'ok') return reply(401, { ok: false, error: 'invalid_credentials' });
    const iat = now();
    const exp = iat + tokenTtlMs;
    const token = signPlatformToken({ sub: row.user_id, role: row.role, iat, exp,
      jti: crypto.randomUUID(), amr: ['pwd', 'otp'] }, secret);
    return reply(200, { ok: true, token, expires_at: new Date(exp).toISOString(),
      user: { id: row.user_id, role: row.role } });
  }

  async function dispatch(input) {
    const method = String(input.method || 'GET').toUpperCase();
    const fullPath = String(input.path || '/');
    const headers = input.headers || {};
    let rid = String(headers['x-request-id'] || '').trim();
    if (!RID_RE.test(rid)) rid = crypto.randomUUID();
    const baseHeaders = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-request-id': rid,
      'x-platform-instance': instance,
    };
    const reply = (status, body, extra) => ({
      status, body, headers: Object.assign({}, baseHeaders, extra || {}),
    });

    if (!fullPath.startsWith(PREFIX)) return reply(404, { ok: false, error: 'not_found' });
    let sub = fullPath.slice(PREFIX.length) || '/';
    if (sub.length > 1 && sub.endsWith('/')) sub = sub.slice(0, -1);

    const found = match(method, sub);
    if (!found) return reply(404, { ok: false, error: 'not_found', namespace: PREFIX });
    const { route, params } = found;

    if (!route.auth) {
      if (route.handler === 'authLogin') return login(input, rid, reply);
      if (route.handler === 'healthSummary') {
        return reply(200, { ok: true, namespace: PREFIX, instance,
          configured, auth: configured ? 'platform.v1 HMAC token (separate from school auth)' : 'not_configured',
          content_default: 'deny', security: 'UNKNOWN' });
      }
      return reply(200, openapi);
    }
    if (!configured) return reply(503, { ok: false, error: 'not_configured' });

    const claims = verifyPlatformToken(bearer(headers), secret, now());
    if (!claims) return reply(401, { ok: false, error: 'unauthorized' });

    /* سهمیهٔ نرخ در دیتابیس، مستقل از نمونهٔ Gateway */
    const subject = 'user:' + claims.sub;
    const bucket = Math.floor(now() / 1000 / windowSec) * windowSec;
    let hits;
    try {
      hits = await db.withTransaction(async (q) => {
        const r = await q(`INSERT INTO owner_platform.api_rate_limit (subject, window_start, hits)
          VALUES ($1,$2,1)
          ON CONFLICT (subject, window_start)
          DO UPDATE SET hits = owner_platform.api_rate_limit.hits + 1
          RETURNING hits`, [subject, bucket]);
        return Number(r.rows[0].hits);
      });
    } catch (e) {
      return reply(503, { ok: false, error: 'rate_limit_unavailable' });
    }
    const rateHeaders = {
      'x-ratelimit-limit': String(rateMax),
      'x-ratelimit-remaining': String(Math.max(0, rateMax - hits)),
      'x-ratelimit-window-sec': String(windowSec),
    };
    if (hits > rateMax) {
      return errorOut(429, 'rate_limited',
        { retry_after_ms: Math.max(1, (bucket + windowSec) * 1000 - now()) }, rid, rateHeaders);
    }

    const ctx = {
      claims, params, body: input.body || {}, query: input.query || {},
      requestId: rid, instance, openapi, now,
    };
    try {
      if (route.handler === 'tenantsCreate') {
        const out = await createTenantSaga(db, schoolProvisioner, ctx);
        return reply(out.status, out.body, Object.assign({}, rateHeaders, out.headers || {}));
      }
      const out = await db.withTransaction(async (q) => {
        await q("SELECT set_config('app.platform_user_id', $1, true), set_config('app.tenant_id', $2, true)",
          [claims.sub, params.tenant_id || (input.body && input.body.tenant_id) || '']);
        return HANDLERS[route.handler](q, ctx);
      });
      return reply(out.status, out.body, Object.assign({}, rateHeaders, out.headers || {}));
    } catch (e) {
      if (process.env.PLATFORM_API_DEBUG) console.error('PLATFORM_API_ERROR', e);
      const mapped = mapError(e);
      return reply(mapped.status, mapped.body, rateHeaders);
    }
  }

  async function handle(req, res, url) {
    let body = {};
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      try { body = await readJsonBody(req, MAX_BODY); }
      catch (e) {
        const out = e.status ? { status: e.status, body: { ok: false, error: e.code } }
          : { status: 400, body: { ok: false, error: 'bad_json' } };
        res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(out.body));
        return;
      }
    }
    const query = {};
    try { url.searchParams.forEach((v, k) => { query[k] = v; }); } catch (_) { /* noop */ }
    let out;
    try {
      out = await dispatch({ method, path: url.pathname, headers: req.headers, body, query,
        remote: (req.socket && req.socket.remoteAddress) || '' });
    } catch (e) {
      out = { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' },
        body: { ok: false, error: 'internal_error' } };
    }
    res.writeHead(out.status, out.headers);
    res.end(JSON.stringify(out.body));
  }

  return { dispatch, handle, configured, prefix: PREFIX, routes: PLATFORM_ROUTES };
}

function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        chunks.length = 0;
        req.removeAllListeners('data');
        req.resume();
        reject(Object.assign(new Error('body_too_large'), { code: 'body_too_large', status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('bad_json')); }
    });
    req.on('error', reject);
  });
}

module.exports = {
  PREFIX, TOKEN_PREFIX, ROLES, PLATFORM_ROUTES, FIELDS,
  signPlatformToken, verifyPlatformToken, createPlatformApi,
  createPgAdapter, project, projectRows, auditPayload, canonical, stable,
};
