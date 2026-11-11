'use strict';

const replicaPolicy = require('./replica-policy');
const transfer = require('./transfer');
/* ═══════════════════════════════════════════════════════════════════
   لایهٔ دادهٔ چندمستأجری — مسیر محصول (Gate فاز ۳ · D‑35 · شرط CC‑12‑2)

   هدف: اجرای واقعی RLS روی PostgreSQL از «مسیر خود محصول»، نه از یک
   هارنس جدا. همهٔ دسترسی‌ها از این ماژول و از مسیر HTTP محصول
   (`server/index.js` → `/api/cloud/tenancy/...`) می‌گذرد.

   قاعده‌های سخت:
   ۱) `tenant_id` فقط از توکن امضاشدهٔ نشست می‌آید؛ هیچ فیلدی از بدنه،
      کوئری‌استرینگ یا هدر (مثل X-Tenant) آن را تعیین نمی‌کند.
   ۲) جداسازی در لایهٔ پایگاه‌داده با RLS اعمال می‌شود (نه با فیلتر
      اپلیکیشن). نقش runtime مالک جدول نیست و BYPASSRLS ندارد.
   ۳) زمینهٔ مستأجر با `set_config(..., true)` تراکنش‌محور تنظیم می‌شود،
      پس روی اتصال‌های استخری به درخواست بعدی نشت نمی‌کند.
   ۴) نبود زمینه ⇒ صفر ردیف (fail-closed)، نه «همهٔ ردیف‌ها».
   ═══════════════════════════════════════════════════════════════════ */
const crypto = require('node:crypto');
const scopeMod = require('./scope');
const policy = require('./policy');
const privacy = require('./privacy'); /* row 88: export role allowlist, tombstone retention, cross-school refusal */
const fc = require('./field-crypto'); /* ردیف ۸۷: فیلدهای حساس در jsonb مهرشده‌اند */

const TOKEN_VERSION = 1;
const TABLE = 'tenant_records';
/* بدنهٔ محصول (همهٔ کالکشن‌ها) در یک جدول چندمستأجری با همان سیاست RLS */
const PRODUCT_TABLE = 'product_records';
const JOBS_TABLE = 'product_jobs';
/* ردیف ۳۶: جدول change-feed هر مدرسه (seq صعودی، ایندکس مکان‌نما، retention) */
const FEED_TABLE = 'product_change_feed';
const FEED_DEFAULT_KEEP_DAYS = 30;
const FEED_MAX_KEEP_DAYS = 365;
const FEED_DEFAULT_LIMIT = 200;
const FEED_MAX_LIMIT = 1000;
/* فشرده‌سازی: ردیف‌های قدیمی‌تر از پنجرهٔ «داغ» با gzip ذخیره می‌شوند */
const FEED_DEFAULT_HOT_DAYS = 7;
const FEED_MAX_HOT_DAYS = 365;
/* ردیف ۳۷ — Gateway بی‌حالت */
const OPS_TABLE = 'product_ops';
const QUOTA_TABLE = 'gateway_quota';
/* row 121: school access — slug → tenant, and hashed one-time activation codes / device credentials */
const SCHOOL_TABLE = 'gw_school';
const CRED_TABLE = 'gw_credential';
const MAX_OPS_PER_REQUEST = 200;        /* سقف عملیات هر push */
const MAX_OP_BYTES = 64 * 1024;         /* سقف payload هر عملیات */
const MAX_UID_LEN = 80;
const OWNER_ROLE = 'payesh_owner';
const RUNTIME_ROLE = 'payesh_runtime';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 64 * 1024;

class TenancyError extends Error {
  constructor(code, status = 400, details = null) {
    super(code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/* ── توکن نشست (سطح B) ─────────────────────────────────────────────── */
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function fromB64url(s) { return Buffer.from(String(s), 'base64url'); }

function signToken(claims, secret) {
  const body = b64url(JSON.stringify(Object.assign({ v: TOKEN_VERSION }, claims)));
  const sig = crypto.createHmac('sha256', String(secret)).update(body).digest();
  return `v1.${body}.${b64url(sig)}`;
}

function verifyToken(token, secret, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new TenancyError('unauthorized', 401);
  const [, body, sig] = parts;
  const want = crypto.createHmac('sha256', String(secret)).update(body).digest();
  const got = fromB64url(sig);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    throw new TenancyError('unauthorized', 401);
  }
  let claims;
  try { claims = JSON.parse(fromB64url(body).toString('utf8')); } catch (e) { throw new TenancyError('unauthorized', 401); }
  if (!claims || claims.v !== TOKEN_VERSION) throw new TenancyError('unauthorized', 401);
  if (!UUID_RE.test(String(claims.tid || ''))) throw new TenancyError('unauthorized', 401);
  if (!Number.isFinite(claims.exp) || claims.exp <= now) throw new TenancyError('token_expired', 401);
  return claims;
}

/* ── طرح پایگاه‌داده و سیاست‌ها (منبع حقیقت جداسازی) ───────────────── */
const SCHEMA_SQL = [
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${OWNER_ROLE}') THEN
       CREATE ROLE ${OWNER_ROLE} NOLOGIN;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}') THEN
       CREATE ROLE ${RUNTIME_ROLE} LOGIN;
     END IF;
   END $$`,
  `CREATE TABLE IF NOT EXISTS ${TABLE} (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id uuid NOT NULL,
     kind text NOT NULL,
     body jsonb NOT NULL DEFAULT '{}'::jsonb,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS ${TABLE}_tenant_idx ON ${TABLE} (tenant_id, kind)`,
  `ALTER TABLE ${TABLE} OWNER TO ${OWNER_ROLE}`,
  `ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS ${TABLE}_isolation ON ${TABLE}`,
  `CREATE POLICY ${TABLE}_isolation ON ${TABLE}
     USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
     WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`,
  `GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE}`,
  `REVOKE ALL ON ${TABLE} FROM PUBLIC`,
  `GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABLE} TO ${RUNTIME_ROLE}`,

  /* ── بدنهٔ محصول: همهٔ کالکشن‌ها، یک جدول، جداسازی سخت با RLS ─────── */
  `CREATE TABLE IF NOT EXISTS ${PRODUCT_TABLE} (
     tenant_id uuid NOT NULL,
     collection text NOT NULL,
     record_id bigint NOT NULL,
     version integer NOT NULL DEFAULT 1,
     data jsonb NOT NULL DEFAULT '{}'::jsonb,
     deleted_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (tenant_id, collection, record_id)
   )`,
  `CREATE INDEX IF NOT EXISTS ${PRODUCT_TABLE}_tenant_idx ON ${PRODUCT_TABLE} (tenant_id, collection, record_id)`,
  `ALTER TABLE ${PRODUCT_TABLE} OWNER TO ${OWNER_ROLE}`,
  `ALTER TABLE ${PRODUCT_TABLE} ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE ${PRODUCT_TABLE} FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS ${PRODUCT_TABLE}_isolation ON ${PRODUCT_TABLE}`,
  `CREATE POLICY ${PRODUCT_TABLE}_isolation ON ${PRODUCT_TABLE}
     USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
     WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`,
  `REVOKE ALL ON ${PRODUCT_TABLE} FROM PUBLIC`,
  `GRANT SELECT, INSERT, UPDATE, DELETE ON ${PRODUCT_TABLE} TO ${RUNTIME_ROLE}`,

  /* ── کارهای پس‌زمینه (job) — همچنین مستأجرمحور ───────────────────── */
  `CREATE TABLE IF NOT EXISTS ${JOBS_TABLE} (
     id bigserial PRIMARY KEY,
     tenant_id uuid NOT NULL,
     kind text NOT NULL,
     payload jsonb NOT NULL DEFAULT '{}'::jsonb,
     status text NOT NULL DEFAULT 'pending',
     result jsonb,
     created_at timestamptz NOT NULL DEFAULT now(),
     started_at timestamptz,
     finished_at timestamptz
   )`,
  `CREATE INDEX IF NOT EXISTS ${JOBS_TABLE}_tenant_idx ON ${JOBS_TABLE} (tenant_id, status, id)`,
  `ALTER TABLE ${JOBS_TABLE} OWNER TO ${OWNER_ROLE}`,
  `ALTER TABLE ${JOBS_TABLE} ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE ${JOBS_TABLE} FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS ${JOBS_TABLE}_isolation ON ${JOBS_TABLE}`,
  `CREATE POLICY ${JOBS_TABLE}_isolation ON ${JOBS_TABLE}
     USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
     WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`,
  `REVOKE ALL ON ${JOBS_TABLE} FROM PUBLIC`,
  `GRANT SELECT, INSERT, UPDATE, DELETE ON ${JOBS_TABLE} TO ${RUNTIME_ROLE}`,
  `GRANT USAGE, SELECT ON SEQUENCE ${JOBS_TABLE}_id_seq TO ${RUNTIME_ROLE}`,

  /* ── change-feed هر مدرسه (ردیف ۳۶) — منبع pull قرارداد Sync v1 ────────
     seq صعودیِ سراسری: برای هر مستأجر یک زیرتوالی اکیداً صعودی می‌سازد،
     پس «هم‌مهر بودن» چند تغییر در یک لحظه هرگز باعث گم‌شدن ردیف نمی‌شود.
     retention با سیاست نگه‌داری روزانه (پیش‌فرض ۳۰ روز) اجرا می‌شود. */
  `CREATE TABLE IF NOT EXISTS ${FEED_TABLE} (
     seq bigserial PRIMARY KEY,
     tenant_id uuid NOT NULL,
     collection text NOT NULL,
     record_id bigint NOT NULL,
     op text NOT NULL,
     version integer NOT NULL,
     data jsonb,
     data_gz bytea,
     at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT ${FEED_TABLE}_op_chk CHECK (op IN ('put', 'del'))
   )`,
  /* نصب‌های قدیمی‌تر: ستون فشرده‌سازی به‌صورت افزایشی اضافه می‌شود */
  `ALTER TABLE ${FEED_TABLE} ADD COLUMN IF NOT EXISTS data_gz bytea`,
  `CREATE INDEX IF NOT EXISTS ${FEED_TABLE}_cursor_idx ON ${FEED_TABLE} (tenant_id, seq)`,
  `CREATE INDEX IF NOT EXISTS ${FEED_TABLE}_retention_idx ON ${FEED_TABLE} (tenant_id, at)`,
  `ALTER TABLE ${FEED_TABLE} OWNER TO ${OWNER_ROLE}`,
  `ALTER TABLE ${FEED_TABLE} ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE ${FEED_TABLE} FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS ${FEED_TABLE}_isolation ON ${FEED_TABLE}`,
  `CREATE POLICY ${FEED_TABLE}_isolation ON ${FEED_TABLE}
     USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
     WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`,
  `REVOKE ALL ON ${FEED_TABLE} FROM PUBLIC`,
  /* UPDATE لازم است برای فشرده‌سازیِ درجا (فقط همین دو ستون، و همچنان تحت RLS) */
  `GRANT SELECT, INSERT, DELETE, UPDATE ON ${FEED_TABLE} TO ${RUNTIME_ROLE}`,
  `GRANT USAGE, SELECT ON SEQUENCE ${FEED_TABLE}_seq_seq TO ${RUNTIME_ROLE}`,

  /* ── idempotency عملیات (ردیف ۳۷: Gateway بی‌حالت) ─────────────────────
     کلید (tenant_id, uid): تکرار همان عملیات در هر نمونه‌ای از Gateway
     دوباره اعمال نمی‌شود — وضعیت در دیتابیس است، نه در حافظهٔ نمونه. */
  `CREATE TABLE IF NOT EXISTS ${OPS_TABLE} (
     tenant_id uuid NOT NULL,
     uid text NOT NULL,
     at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (tenant_id, uid)
   )`,
  `ALTER TABLE ${OPS_TABLE} OWNER TO ${OWNER_ROLE}`,
  `ALTER TABLE ${OPS_TABLE} ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE ${OPS_TABLE} FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS ${OPS_TABLE}_isolation ON ${OPS_TABLE}`,
  `CREATE POLICY ${OPS_TABLE}_isolation ON ${OPS_TABLE}
     USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
     WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`,
  `REVOKE ALL ON ${OPS_TABLE} FROM PUBLIC`,
  `GRANT SELECT, INSERT, DELETE ON ${OPS_TABLE} TO ${RUNTIME_ROLE}`,

  /* ── سهمیهٔ نرخ (ردیف ۳۷): پنجرهٔ زمانی در دیتابیس ⇒ بین نمونه‌ها مشترک */
  `CREATE TABLE IF NOT EXISTS ${QUOTA_TABLE} (
     tenant_id uuid NOT NULL,
     device_id text NOT NULL,
     window_start timestamptz NOT NULL,
     hits integer NOT NULL DEFAULT 0,
     PRIMARY KEY (tenant_id, device_id, window_start)
   )`,
  `CREATE INDEX IF NOT EXISTS ${QUOTA_TABLE}_tenant_idx ON ${QUOTA_TABLE} (tenant_id, window_start)`,
  `ALTER TABLE ${QUOTA_TABLE} OWNER TO ${OWNER_ROLE}`,
  `ALTER TABLE ${QUOTA_TABLE} ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE ${QUOTA_TABLE} FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS ${QUOTA_TABLE}_isolation ON ${QUOTA_TABLE}`,
  `CREATE POLICY ${QUOTA_TABLE}_isolation ON ${QUOTA_TABLE}
     USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
     WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`,
  `REVOKE ALL ON ${QUOTA_TABLE} FROM PUBLIC`,
  `GRANT SELECT, INSERT, UPDATE, DELETE ON ${QUOTA_TABLE} TO ${RUNTIME_ROLE}`,

  /* ── row 121: school access (owner panel creates a school → initial manager) ──────────────
     gw_school maps the public school slug to its tenant. Forced RLS: the runtime role can only
     insert/see its own tenant's mapping; resolving a slug BEFORE the tenant is known goes through
     gw_resolve_school() (SECURITY DEFINER, returns one uuid, no listing). */
  `CREATE TABLE IF NOT EXISTS ${SCHOOL_TABLE} (
     slug text PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
     tenant_id uuid NOT NULL UNIQUE,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `ALTER TABLE ${SCHOOL_TABLE} OWNER TO ${OWNER_ROLE}`,
  `ALTER TABLE ${SCHOOL_TABLE} ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE ${SCHOOL_TABLE} FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS ${SCHOOL_TABLE}_isolation ON ${SCHOOL_TABLE}`,
  `CREATE POLICY ${SCHOOL_TABLE}_isolation ON ${SCHOOL_TABLE}
     USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
     WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`,
  `DROP POLICY IF EXISTS ${SCHOOL_TABLE}_resolve ON ${SCHOOL_TABLE}`,
  `CREATE POLICY ${SCHOOL_TABLE}_resolve ON ${SCHOOL_TABLE} FOR SELECT TO ${OWNER_ROLE} USING (true)`,
  `REVOKE ALL ON ${SCHOOL_TABLE} FROM PUBLIC`,
  `GRANT SELECT, INSERT ON ${SCHOOL_TABLE} TO ${RUNTIME_ROLE}`,
  `CREATE OR REPLACE FUNCTION gw_resolve_school(p_slug text) RETURNS uuid
     LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
     AS $fn$ SELECT tenant_id FROM ${SCHOOL_TABLE} WHERE slug = lower(btrim(p_slug)) $fn$`,
  `ALTER FUNCTION gw_resolve_school(text) OWNER TO ${OWNER_ROLE}`,
  `REVOKE ALL ON FUNCTION gw_resolve_school(text) FROM PUBLIC`,
  `GRANT EXECUTE ON FUNCTION gw_resolve_school(text) TO ${RUNTIME_ROLE}`,
  /* hashed secrets only (sha256 over tenant + secret); the raw code/secret is returned once */
  `CREATE TABLE IF NOT EXISTS ${CRED_TABLE} (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id uuid NOT NULL,
     kind text NOT NULL CHECK (kind IN ('activation', 'device')),
     uid bigint NOT NULL CHECK (uid > 0),
     device_id text,
     secret_hash text NOT NULL UNIQUE,
     expires_at timestamptz,
     used_at timestamptz,
     revoked_at timestamptz,
     issued_by bigint,
     created_at timestamptz NOT NULL DEFAULT now(),
     CHECK (kind <> 'device' OR device_id IS NOT NULL)
   )`,
  `CREATE INDEX IF NOT EXISTS ${CRED_TABLE}_tenant_uid_idx ON ${CRED_TABLE} (tenant_id, uid, kind)`,
  `ALTER TABLE ${CRED_TABLE} OWNER TO ${OWNER_ROLE}`,
  `ALTER TABLE ${CRED_TABLE} ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE ${CRED_TABLE} FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS ${CRED_TABLE}_isolation ON ${CRED_TABLE}`,
  `CREATE POLICY ${CRED_TABLE}_isolation ON ${CRED_TABLE}
     USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
     WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`,
  `REVOKE ALL ON ${CRED_TABLE} FROM PUBLIC`,
  `GRANT SELECT, INSERT, UPDATE ON ${CRED_TABLE} TO ${RUNTIME_ROLE}`,
];

/* اجرای مهاجرت با اتصال مدیر (superuser) — بخشی از محصول است، نه هارنس */
async function migrate(client) {
  for (const sql of SCHEMA_SQL) await client.query(sql);
  const v = await client.query('select current_setting($1, true) as v', ['server_version']);
  return { table: TABLE, statements: SCHEMA_SQL.length, server_version: v.rows[0] && v.rows[0].v };
}

/* ── اتصال runtime ─────────────────────────────────────────────────── */
/* ردیف ۴۵ — اندازهٔ pool از محیط قابل تنظیم است تا «بودجهٔ اتصال» یک عدد
   قابل اجرا باشد، نه یک آرزو. سقف سخت ۵۰ است تا یک نمونه نتواند همهٔ
   اتصال‌های مجاز provider را ببلعد (doc: 45-connection-budget.md). */
function poolMax(env = process.env) {
  const raw = Number(env.PAYESH_PG_POOL_MAX || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 4;
  return Math.max(1, Math.min(50, Math.floor(raw)));
}

function createPool({ connectionString, max = poolMax() }) {
  let Pool;
  try { ({ Pool } = require('pg')); }
  catch (e) { throw new TenancyError('pg_driver_missing', 500); }
  return new Pool({ connectionString, max, application_name: 'payesh-tenancy' });
}

/* هر عملیات در یک تراکنش با زمینهٔ مستأجر اجرا می‌شود */
/* ── ردیف ۴۵: اندازه‌گیری واقعی انتظار pool ────────────────────────
   هر بار گرفتن اتصال از pool زمان‌سنجی می‌شود (نه فقط لحظهٔ scrape).
   اگر این عدد بالا برود یعنی اندازهٔ pool به سقف خورده و کلاینت‌ها در
   صف ایستاده‌اند؛ همان چیزی که فرمول بودجه باید از آن جلوگیری کند. */
const poolWait = { events: 0, total_ms: 0, max_ms: 0, over_1000ms: 0 };

function poolWaitReset() { poolWait.events = 0; poolWait.total_ms = 0; poolWait.max_ms = 0; poolWait.over_1000ms = 0; }

function poolWaitSnapshot() {
  return {
    events: poolWait.events,
    mean_ms: poolWait.events ? Math.round((poolWait.total_ms / poolWait.events) * 10) / 10 : 0,
    max_ms: poolWait.max_ms,
    over_1000ms: poolWait.over_1000ms,
  };
}

async function acquire(pool) {
  const t0 = Date.now();
  const client = await pool.connect();
  const wait = Date.now() - t0;
  poolWait.events++;
  poolWait.total_ms += wait;
  if (wait > poolWait.max_ms) poolWait.max_ms = wait;
  if (wait > 1000) poolWait.over_1000ms++;
  return client;
}

async function withTenant(pool, tenantId, fn) {
  if (!UUID_RE.test(String(tenantId || ''))) throw new TenancyError('bad_tenant', 400);
  const client = await acquire(pool);
  try {
    await client.query('BEGIN');
    await client.query("select set_config('app.tenant_id', $1, true)", [String(tenantId)]);
    const out = await fn(client, tenantId);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw e;
  } finally {
    client.release();
  }
}

function rowOf(r) {
  return {
    id: r.id,
    kind: r.kind,
    body: r.body,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
  };
}

/* ── مخزن رکوردهای مستأجرمحور (همان چیزی که مسیر HTTP صدا می‌زند) ──── */
async function listRecords(pool, tenantId, { kind = null, limit = 100 } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  return withTenant(pool, tenantId, async (c) => {
    const q = kind
      ? await c.query(`select id, kind, body, created_at, updated_at from ${TABLE} where kind = $1 order by created_at asc limit $2`, [String(kind), lim])
      : await c.query(`select id, kind, body, created_at, updated_at from ${TABLE} order by created_at asc limit $1`, [lim]);
    return q.rows.map(rowOf);
  });
}

async function getRecord(pool, tenantId, id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  return withTenant(pool, tenantId, async (c) => {
    const q = await c.query(`select id, kind, body, created_at, updated_at from ${TABLE} where id = $1`, [id]);
    return q.rows.length ? rowOf(q.rows[0]) : null;
  });
}

async function createRecord(pool, tenantId, { kind, body = {} } = {}) {
  if (!kind || typeof kind !== 'string') throw new TenancyError('bad_kind', 400);
  if (JSON.stringify(body || {}).length > MAX_BODY_BYTES) throw new TenancyError('body_too_large', 413);
  return withTenant(pool, tenantId, async (c) => {
    /* tenant_id هرگز از ورودی نمی‌آید؛ از زمینهٔ تراکنش خوانده می‌شود */
    const q = await c.query(
      `insert into ${TABLE} (tenant_id, kind, body)
       values (current_setting('app.tenant_id')::uuid, $1, $2::jsonb)
       returning id, kind, body, created_at, updated_at`,
      [kind, JSON.stringify(body || {})]
    );
    return rowOf(q.rows[0]);
  });
}

/* بزرگ‌ترین seq قابل مشاهده در change-feed این مستأجر (همان چیزی که pull
   با آن همگام می‌شود). برای ناوردای read-your-writes ردیف ۵۲ لازم است. */
async function maxFeedSeq(pool, tenantId) {
  if (!UUID_RE.test(String(tenantId || ''))) throw new TenancyError('bad_tenant', 400);
  return withTenant(pool, tenantId, async (c) => {
    const q = await c.query(`select coalesce(max(seq), 0)::bigint as seq from ${FEED_TABLE} where tenant_id = current_setting('app.tenant_id')::uuid`);
    return Number(q.rows[0] && q.rows[0].seq) || 0;
  });
}

async function updateRecord(pool, tenantId, id, { body } = {}) {
  if (!UUID_RE.test(String(id || ''))) return null;
  if (body === undefined) throw new TenancyError('bad_body', 400);
  return withTenant(pool, tenantId, async (c) => {
    const q = await c.query(
      `update ${TABLE} set body = $2::jsonb, updated_at = now() where id = $1
       returning id, kind, body, created_at, updated_at`,
      [id, JSON.stringify(body || {})]
    );
    return q.rows.length ? rowOf(q.rows[0]) : null;
  });
}

async function deleteRecord(pool, tenantId, id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  return withTenant(pool, tenantId, async (c) => {
    const q = await c.query(`delete from ${TABLE} where id = $1 returning id`, [id]);
    return q.rows.length ? q.rows[0].id : null;
  });
}

/* ── وضعیت و مسیر HTTP ─────────────────────────────────────────────── */
const state = { enabled: false, pool: null, secret: '', reason: 'not_initialized' };

function init({ connectionString = '', secret = '' } = {}) {
  const cs = String(connectionString || '').trim();
  const sc = String(secret || '').trim();
  state.pool = null;
  if (!cs) { state.enabled = false; state.reason = 'disabled'; state.secret = ''; return status(); }
  if (sc.length < 16) { state.enabled = false; state.reason = 'weak_secret'; state.secret = ''; return status(); }
  state.pool = createPool({ connectionString: cs });
  state.secret = sc;
  state.enabled = true;
  state.reason = 'enabled';
  return status();
}

function getPool() { return state.pool; }

function status() {
  return { enabled: state.enabled, reason: state.reason, table: TABLE, runtime_role: RUNTIME_ROLE, owner_role: OWNER_ROLE };
}

/* ── بدنهٔ محصول روی PostgreSQL (همان مسیر HTTP محصول) ────────────────
   قاعده: tenant_id فقط از claims توکن می‌آید؛ هیچ داده‌ای از بدنه یا هدر
   آن را تعیین نمی‌کند. حتی اگر اپلیکیشن اشتباه فیلتر کند، RLS جلوی
   دیدن/نوشتن مستأجر دیگر را می‌گیرد. */
const COLLECTION_RE = /^[a-z][a-z0-9_]{1,40}$/;

function productRowOf(r) {
  return {
    collection: r.collection,
    id: Number(r.record_id),
    version: Number(r.version),
    data: fc.openRecord(r.collection, r.record_id, r.data),
    deleted: !!r.deleted_at,
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
  };
}

/* ══════════════════════════════════════════════════════════════════
   ردیف ۵۷ — users در مسیرهای ابری هم همان allowlist را می‌بینند.

   change-feed (listFeed)، listProduct، getProduct و joinProduct برای نقش
   غیرمدیر، فیلدهای رازگونهٔ users (password_hash، password_enc،
   phone_hash، __password_verifier، secret*…) را حذف می‌کنند. مدیر همه
   را می‌بیند (رفتار کنونی). exportProduct کل users فقط برای مدیر است.

   مرحلهٔ دوم (P0): فیلدهای هویتی (کد ملی، کد ملی پدر/مادر، شناسنامه،
   شماره، نشانی) هم از allowlist عمومی خارج شدند — فقط در ردیفِ خودِ
   کاربر (scope.uid) می‌مانند. اسکوپ («ولی: فقط فرزند خودش»، «دبیر:
   فقط کلاس‌های خودش») همچنان برمی‌دارد که کدام ردیف‌ها دیده می‌شوند،
   اما دیگر کدام فیلدهای هویتیِ آن ردیف‌ها را نه.
   ═════════════════════════════════════════════════════════════════ */
function scrubUsersRow(scope, row) {
  if (!row || row.collection !== 'users') return row;
  if (!scope || scope.role === 'manager' || scope.all) return row;
  const data = (row.data && typeof row.data === 'object') ? row.data : null;
  if (!data) return row;
  const self = Number.isFinite(Number(scope.uid)) && Number(row.record_id) === Number(scope.uid);
  return Object.assign({}, row, { data: policy.scrubUser(data, { keepIdentity: self }) });
}

function assertCollection(name) {
  if (!COLLECTION_RE.test(String(name || ''))) throw new TenancyError('bad_collection', 400);
  return String(name);
}

async function listProduct(pool, tenantId, { collection, since = null, limit = 200, claims = null } = {}) {
  const col = assertCollection(collection);
  const lim = Math.max(1, Math.min(1000, Number(limit) || 200));
  return withTenant(pool, tenantId, async (c) => {
    const scope = claims ? await scopeMod.build(c, claims) : null;
    if (scope && !scopeMod.canReadCollection(scope, col)) throw new TenancyError('forbidden_collection', 403, { collection: col });
    const sp = scopeMod.sqlPredicate(scope, since ? 4 : 3);
    const q = since
      ? await c.query(`select r.collection, r.record_id, r.version, r.data, r.deleted_at, r.updated_at
                       from ${PRODUCT_TABLE} r
                       where r.collection = $1 and r.updated_at > $2 and ${sp.sql}
                       order by r.record_id asc limit $3`, [col, String(since), lim, ...sp.params])
      : await c.query(`select r.collection, r.record_id, r.version, r.data, r.deleted_at, r.updated_at
                       from ${PRODUCT_TABLE} r where r.collection = $1 and ${sp.sql}
                       order by r.record_id asc limit $2`, [col, lim, ...sp.params]);
    return q.rows.map(productRowOf).map(r => scrubUsersRow(scope, r));
  });
}

async function getProduct(pool, tenantId, { collection, id, claims = null }) {
  const col = assertCollection(collection);
  return withTenant(pool, tenantId, async (c) => {
    const q = await c.query(`select collection, record_id, version, data, deleted_at, updated_at
                             from ${PRODUCT_TABLE} where collection = $1 and record_id = $2`, [col, Number(id)]);
    if (!q.rows.length) return null;
    if (claims) {
      const scope = await scopeMod.build(c, claims);
      if (!scopeMod.canReadCollection(scope, col)) throw new TenancyError('forbidden_collection', 403, { collection: col });
      if (!scopeMod.rowInScope(scope, col, q.rows[0].data || {})) throw new TenancyError('out_of_scope', 403, { collection: col });
    }
    return scrubUsersRow(claims ? { role: String((claims && claims.role) || ''), uid: Number((claims && claims.uid) || 0) } : null, productRowOf(q.rows[0]));
  });
}

/* درج/به‌روزرسانی با کنترل نسخه (OCC) — tenant از زمینهٔ تراکنش */
/* نوشتن/حذف در «همان تراکنش» — مشترک بین مسیر تکی و مسیر دسته‌ای Gateway */
async function upsertInTx(c, col, rid, data, baseVersion, feedOut = true) {
  const cur = await c.query(`select version from ${PRODUCT_TABLE} where collection = $1 and record_id = $2 for update`, [col, rid]);
  const exists = cur.rows.length > 0;
  const version = exists ? Number(cur.rows[0].version) : 0;
  if (baseVersion != null && Number(baseVersion) !== version) return { conflict: true, version, row: null };
  const q = await c.query(
    `insert into ${PRODUCT_TABLE} (tenant_id, collection, record_id, version, data, deleted_at)
     values (current_setting('app.tenant_id')::uuid, $1, $2, 1, $3::jsonb, null)
     on conflict (tenant_id, collection, record_id)
     do update set data = excluded.data, version = ${PRODUCT_TABLE}.version + 1, deleted_at = null, updated_at = now()
     returning collection, record_id, version, data, deleted_at, updated_at`,
    [col, rid, JSON.stringify(fc.sealRecord(col, rid, data))]
  );
  const row = productRowOf(q.rows[0]);
  if (feedOut) await appendFeed(c, { collection: col, recordId: rid, op: 'put', version: row.version, data: row.data });
  return { conflict: false, version: row.version, row };
}

async function deleteInTx(c, col, rid, feedOut = true) {
  const q = await c.query(
    `update ${PRODUCT_TABLE} set deleted_at = now(), version = version + 1, updated_at = now()
     where collection = $1 and record_id = $2 returning collection, record_id, version`,
    [col, rid]
  );
  if (!q.rows.length) return null;
  const version = Number(q.rows[0].version);
  if (feedOut) await appendFeed(c, { collection: col, recordId: rid, op: 'del', version, data: null });
  return { collection: col, id: rid, version, deleted: true };
}

async function upsertProduct(pool, tenantId, { collection, id, data = {}, base_version = null, claims = null } = {}) {
  const col = assertCollection(collection);
  const rid = Number(id);
  if (!Number.isInteger(rid) || rid < 1) throw new TenancyError('bad_id', 400);
  const clean = cleanData(data); /* ورودی کلاینت هرگز مستأجر را تعیین نمی‌کند */
  return withTenant(pool, tenantId, async (c) => {
    if (claims) {
      const scope = await scopeMod.build(c, claims);
      const cur = await c.query(`select data from ${PRODUCT_TABLE} where collection = $1 and record_id = $2`, [col, rid]);
      const verdict = scopeMod.canWriteRow(scope, col, Object.assign({}, clean, { id: rid }), cur.rows.length ? cur.rows[0].data : null);
      if (!verdict.ok) throw new TenancyError(verdict.error, 403, { collection: col, id: rid });
    }
    const out = await upsertInTx(c, col, rid, clean, base_version);
    return out.conflict ? { conflict: true, version: out.version, data: null } : { conflict: false, row: out.row };
  });
}

async function deleteProduct(pool, tenantId, { collection, id, claims = null }) {
  const col = assertCollection(collection);
  return withTenant(pool, tenantId, async (c) => {
    if (claims) {
      const scope = await scopeMod.build(c, claims);
      const cur = await c.query(`select data from ${PRODUCT_TABLE} where collection = $1 and record_id = $2`, [col, Number(id)]);
      const verdict = scopeMod.canWriteRow(scope, col, cur.rows.length ? cur.rows[0].data : {}, null);
      if (!verdict.ok) throw new TenancyError(verdict.error, 403, { collection: col, id: Number(id) });
    }
    return deleteInTx(c, col, Number(id));
  });
}

/* ═══════ اعمال دسته‌ای عملیات (ردیف ۳۷ — Gateway) ═══════════════════
   همهٔ عملیات یک درخواست در «یک تراکنش» و «یک زمینهٔ مستأجر» اجرا می‌شوند:
   یا همه اعمال می‌شوند یا هیچ‌کدام. idempotency در جدول product_ops است،
   پس تکرار همان uid روی هر نمونه‌ای از Gateway دوباره اعمال نمی‌شود.
   ═══════════════════════════════════════════════════════════════════ */
function cleanData(data) {
  const clean = Object.assign({}, data || {});
  delete clean.tenant_id; delete clean.tenantId;
  delete clean.school_id; delete clean.schoolId;
  return clean;
}

async function applyOps(pool, tenantId, { ops = [], device_id = null, claims = null } = {}) {
  if (!Array.isArray(ops)) throw new TenancyError('bad_ops', 400);
  if (ops.length > MAX_OPS_PER_REQUEST) {
    throw new TenancyError('too_many_ops', 413, { limit: MAX_OPS_PER_REQUEST });
  }
  const prepared = ops.map((op, i) => {
    const uid = String((op && op.uid) || '');
    if (!uid || uid.length > MAX_UID_LEN) throw new TenancyError('bad_uid', 400, { index: i });
    const collection = String((op && op.collection) || '');
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(collection)) throw new TenancyError('unknown_collection', 400, { index: i, uid });
    const type = op.type === 'del' ? 'del' : 'put';
    const id = Number(op.id);
    if (!Number.isInteger(id) || id < 1) throw new TenancyError('bad_id', 400, { index: i, uid });
    const payload = type === 'del' ? null : cleanData(op.data);
    if (payload) {
      const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
      if (bytes > MAX_OP_BYTES) throw new TenancyError('op_too_large', 413, { index: i, uid, limit: MAX_OP_BYTES });
    }
    return { uid, collection, type, id, payload, base_version: op.base_version == null ? null : Number(op.base_version) };
  });

  return withTenant(pool, tenantId, async (c) => {
    /* ── اسکوپ سمت سرور (ردیف ۳۸) ──
       پیش از هر نوشتنی همهٔ عملیات بررسی می‌شوند؛ اگر یکی بیرون از اسکوپ
       باشد کل دسته رد می‌شود (اتمی)، پس نه نیمه‌کاره می‌نویسد و نه چیزی لو می‌رود. */
    let scope = null;
    if (claims) {
      scope = await scopeMod.build(c, claims);
      for (const p of prepared) {
        if (!scopeMod.canWriteCollection(scope, p.collection)) {
          throw new TenancyError('role_denied', 403, { uid: p.uid, collection: p.collection });
        }
        const cur = p.type === 'del'
          ? await c.query(`select data from ${PRODUCT_TABLE} where collection = $1 and record_id = $2`, [p.collection, p.id])
          : null;
        const existing = cur && cur.rows.length ? cur.rows[0].data : null;
        const target = p.type === 'del' ? (existing || {}) : Object.assign({}, p.payload, { id: p.id });
        const verdict = scopeMod.canWriteRow(scope, p.collection, target, existing);
        if (!verdict.ok) throw new TenancyError(verdict.error, 403, { uid: p.uid, collection: p.collection, id: p.id });
      }
    }
    const applied = [];
    const duplicates = [];
    const conflicts = [];
    for (const p of prepared) {
      const seen = await c.query(
        `insert into ${OPS_TABLE} (tenant_id, uid) values (current_setting('app.tenant_id')::uuid, $1)
         on conflict (tenant_id, uid) do nothing returning uid`, [p.uid]
      );
      if (!seen.rows.length) { duplicates.push({ uid: p.uid }); continue; }
      if (p.type === 'del') {
        const out = await deleteInTx(c, p.collection, p.id);
        if (!out) { applied.push({ uid: p.uid, id: p.id, deleted: false, missing: true }); continue; }
        applied.push({ uid: p.uid, id: p.id, deleted: true, version: out.version });
        continue;
      }
      const out = await upsertInTx(c, p.collection, p.id, p.payload, p.base_version);
      if (out.conflict) { conflicts.push({ uid: p.uid, id: p.id, version: out.version }); continue; }
      applied.push({ uid: p.uid, id: p.id, version: out.version, collection: p.collection });
    }
    return {
      applied, duplicates, conflicts,
      counts: { applied: applied.length, duplicates: duplicates.length, conflicts: conflicts.length },
      device_id: device_id || null,
    };
  });
}

/* سهمیهٔ نرخ در دیتابیس (نه در حافظهٔ نمونه) — پنجرهٔ ثابت زمانی.
   هر نمونه‌ای همین جدول را می‌بیند، پس محدودیت بین نمونه‌ها مشترک است. */
async function takeQuota(pool, tenantId, { deviceId = 'unknown', max = 120, windowSec = 60 } = {}) {
  if (!Number.isFinite(max) || max < 1) throw new TenancyError('bad_quota', 500);
  const start = new Date(Math.floor(Date.now() / (windowSec * 1000)) * windowSec * 1000);
  return withTenant(pool, tenantId, async (c) => {
    const q = await c.query(
      `insert into ${QUOTA_TABLE} (tenant_id, device_id, window_start, hits)
       values (current_setting('app.tenant_id')::uuid, $1, $2, 1)
       on conflict (tenant_id, device_id, window_start)
       do update set hits = ${QUOTA_TABLE}.hits + 1
       returning hits`,
      [String(deviceId).slice(0, 80), start.toISOString()]
    );
    const hits = Number(q.rows[0].hits);
    return {
      allowed: hits <= max, hits, max,
      remaining: Math.max(0, max - hits),
      retry_after_ms: hits <= max ? 0 : Math.max(0, start.getTime() + windowSec * 1000 - Date.now()),
      window_start: start.toISOString(), window_sec: windowSec,
    };
  });
}

/* سلامت آمادگی: اتصال + رفتار درست `set_config(..., true)` (بدون نشت زمینه) */
async function readiness(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("select set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true)");
    const inside = await client.query("select current_setting('app.tenant_id', true) as v");
    await client.query('COMMIT');
    const after = await client.query("select current_setting('app.tenant_id', true) as v");
    return {
      ok: true,
      tenant_scoped: (inside.rows[0].v || '') === '00000000-0000-0000-0000-000000000000',
      leaked_after_commit: (after.rows[0].v || '') !== '',
    };
  } finally { client.release(); }
}

/* ═══════════ وضعیت pool/اتصال برای متریک — ردیف ۴۹ ═══════════════════
   فقط شمارش و بولی برمی‌گرداند؛ هیچ شناسه، tenant یا ردیفی خوانده نمی‌شود.
   هدف این است که /metrics بتواند «اتصال DB» و «آمادگی» را از یک منبع
   واقعی بگیرد، نه از حدس. */
async function poolSnapshot(pool) {
  let connections = 0, waitMs = 0;
  /* زمان گرفتن اتصال: همان «pool-wait» واقعی، اندازه‌گیری‌شده در لحظهٔ scrape */
  try {
    const t0 = Date.now();
    const c = await pool.connect();
    waitMs = Date.now() - t0;
    c.release();
  } catch (e) { waitMs = 0; }
  try {
    const r = await pool.query("select count(*)::int as n from pg_stat_activity where datname = current_database()");
    connections = Number(r.rows[0] && r.rows[0].n) || 0;
  } catch (e) { connections = 0; }
  let ready = false;
  try {
    const r = await readiness(pool);
    ready = !!(r.ok && r.tenant_scoped && !r.leaked_after_commit);
  } catch (e) { ready = false; }
  return { ok: connections > 0, connections, ready, wait_ms: waitMs };
}

/* ═══════ change-feed (ردیف ۳۶) ═══════════════════════════════════════
   چرا seq و نه updated_at؟ چون دو تغییر در یک میلی‌ثانیه با `updated_at >`
   از دست می‌روند (همان نقص W‑04 در شبیه‌سازی). seq سراسری، برای هر مستأجر
   زیرتوالیِ اکیداً صعودی و بی‌هم‌مهر می‌دهد ⇒ صفحه‌بندی «دقیقاً یک‌بار».
   ═══════════════════════════════════════════════════════════════════ */

/* افزودن یک ردیف feed؛ فقط با کلاینت داخل تراکنشِ دارای زمینهٔ مستأجر */
async function appendFeed(c, { collection, recordId, op, version, data = null }) {
  const q = await c.query(
    `insert into ${FEED_TABLE} (tenant_id, collection, record_id, op, version, data)
     values (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5::jsonb)
     returning seq, at`,
    [collection, Number(recordId), op === 'del' ? 'del' : 'put', Number(version) || 0,
      data == null ? null : JSON.stringify(fc.sealRecord(collection, recordId, data))]
  );
  return { seq: Number(q.rows[0].seq), at: q.rows[0].at };
}

/* payload ردیف feed: اگر فشرده شده باشد، همان شیء اصلی بازگردانده می‌شود
   (کلاینت هیچ تفاوتی نمی‌بیند؛ فقط فضای دیسک کمتر می‌شود). */
function feedPayload(r) {
  if (r.data != null) return fc.openRecord(r.collection, r.record_id, r.data);
  if (r.data_gz == null) return null;
  let d;
  try { d = JSON.parse(require('node:zlib').gunzipSync(r.data_gz).toString('utf8')); }
  catch (e) { return null; }
  return fc.openRecord(r.collection, r.record_id, d);
}

/* فشرده‌سازی (ردیف ۳۶): ردیف‌های قدیمی‌تر از پنجرهٔ داغ ⇒ gzip + خالی‌کردن jsonb.
   مقدار داده تغییر نمی‌کند؛ فقط نمایش فیزیکی. idempotent است. */
async function compressFeed(pool, tenantId, { hotDays = FEED_DEFAULT_HOT_DAYS } = {}) {
  const days = Number(hotDays);
  if (!Number.isFinite(days) || days < 1 || days > FEED_MAX_HOT_DAYS) throw new TenancyError('bad_hot_days', 400);
  const zlib = require('node:zlib');
  return withTenant(pool, tenantId, async (c) => {
    const q = await c.query(
      `select seq, data::text as payload, octet_length(data::text) as raw_bytes
         from ${FEED_TABLE}
        where data is not null and data_gz is null
          and at < now() - ($1::int || ' days')::interval
        order by seq asc`, [Math.floor(days)]
    );
    let rawBytes = 0, gzBytes = 0, done = 0;
    for (const row of q.rows) {
      const gz = zlib.gzipSync(Buffer.from(String(row.payload), 'utf8'));
      await c.query(`update ${FEED_TABLE} set data_gz = $2, data = null where seq = $1`, [row.seq, gz]);
      rawBytes += Number(row.raw_bytes) || 0; gzBytes += gz.length; done++;
    }
    return {
      compressed: done, raw_bytes: rawBytes, gz_bytes: gzBytes,
      saved_bytes: rawBytes - gzBytes,
      ratio: rawBytes ? Math.round((gzBytes / rawBytes) * 1000) / 1000 : null,
      hot_days: Math.floor(days),
    };
  });
}

/* خواندن صفحه‌ای feed از مکان‌نمای seq — دقیقاً یک‌بار، بدون تکرار/جاافتادگی */
async function listFeed(pool, tenantId, { sinceSeq = 0, collection = null, limit = FEED_DEFAULT_LIMIT, claims = null } = {}) {
  const since = Number(sinceSeq);
  if (!Number.isFinite(since) || since < 0) throw new TenancyError('bad_since_seq', 400);
  const lim = Math.max(1, Math.min(FEED_MAX_LIMIT, Number(limit) || FEED_DEFAULT_LIMIT));
  const col = collection ? assertCollection(collection) : null;
  return withTenant(pool, tenantId, async (c) => {
    /* اسکوپ فقط از توکن (ردیف ۳۸): هر ردیف feed با ر دیف محصول join می‌شود تا
       هم payload فشرده‌شده مشکلی نسازد و هم شرط اسکوپ روی دادهٔ زنده اعمال شود. */
    const scope = claims ? await scopeMod.build(c, claims) : null;
    if (scope && col && !scopeMod.canReadCollection(scope, col)) {
      throw new TenancyError('forbidden_collection', 403, { collection: col });
    }
    const sp = scopeMod.sqlPredicate(scope, 3);
    const q = await c.query(
      `select f.seq, f.collection, f.record_id, f.op, f.version, f.data, f.data_gz, f.at
         from ${FEED_TABLE} f
         left join ${PRODUCT_TABLE} r on r.collection = f.collection and r.record_id = f.record_id
        where f.seq > $1 and ($2::text is null or f.collection = $2) and ${sp.sql}
        order by f.seq asc
        limit ${lim + 1}`,
      [since, col, ...sp.params]
    );
    const more = q.rows.length > lim;
    const rows = (more ? q.rows.slice(0, lim) : q.rows).map(r => ({
      seq: Number(r.seq), collection: r.collection, id: Number(r.record_id),
      op: r.op, version: Number(r.version), data: feedPayload(r), at: r.at,
    }));
    /* ردیف ۵۷: فیلدهای رازگونهٔ users فقط برای مدیر در feed می‌آیند */
    const feedRows = scope ? rows.map(r => scrubUsersRow(scope, r)) : rows;
    return {
      rows: feedRows, count: feedRows.length, more,
      next_seq: rows.length ? rows[rows.length - 1].seq : since,
      scope: scope ? { role: scope.role, all: scope.all } : { role: 'internal', all: true },
      limits: { max_limit: FEED_MAX_LIMIT, default_keep_days: FEED_DEFAULT_KEEP_DAYS },
    };
  });
}

/* retention: حذف ردیف‌های قدیمی‌تر از پنجرهٔ نگه‌داری — فقط همان مستأجر (RLS) */
async function pruneFeed(pool, tenantId, { keepDays = FEED_DEFAULT_KEEP_DAYS, collection = null } = {}) {
  const days = Number(keepDays);
  if (!Number.isFinite(days) || days < 1 || days > FEED_MAX_KEEP_DAYS) throw new TenancyError('bad_keep_days', 400);
  const col = collection ? assertCollection(collection) : null;
  return withTenant(pool, tenantId, async (c) => {
    const q = await c.query(
      `delete from ${FEED_TABLE}
        where at < now() - ($1::int || ' days')::interval
          and ($2::text is null or collection = $2)
        returning seq`,
      [Math.floor(days), col]
    );
    const left = await c.query(`select count(*)::int as n from ${FEED_TABLE}`);
    return { deleted: q.rowCount, remaining: Number(left.rows[0].n), keep_days: Math.floor(days) };
  });
}

/* آمار feed برای /healthz — بدون افشای دادهٔ ردیف‌ها */
async function feedStats(pool, tenantId) {
  return withTenant(pool, tenantId, async (c) => {
    const q = await c.query(`select count(*)::int as n, coalesce(max(seq), 0)::bigint as max_seq,
                                    min(at) as oldest_at from ${FEED_TABLE}`);
    return { count: Number(q.rows[0].n), max_seq: Number(q.rows[0].max_seq), oldest_at: q.rows[0].oldest_at };
  });
}

/* join دو کالکشن روی یک کلید در jsonb — همچنان داخل زمینهٔ مستأجر */
async function joinProduct(pool, tenantId, { left, right, on, limit = 200, claims = null } = {}) {
  const l = assertCollection(left); const r = assertCollection(right);
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(String(on || ''))) throw new TenancyError('bad_join_key', 400);
  const lim = Math.max(1, Math.min(1000, Number(limit) || 200));
  const claimsScope = claims ? { role: String(claims.role || ''), uid: Number((claims && claims.uid) || 0) } : null;
  /* ردیف ۸۷: روی فیلدِ مهرشده (IV تصادفی) join معنا ندارد ⇒ صریح رد می‌شود */
  if (fc.isSensitiveField(l, String(on)) || fc.isSensitiveField(r, String(on))) throw new TenancyError('sealed_join_key', 400, { on: String(on) });
  return withTenant(pool, tenantId, async (c) => {
    const q = await c.query(
      `select l.collection as left_collection, l.record_id as left_id, l.data as left_data,
              r.collection as right_collection, r.record_id as right_id, r.data as right_data
       from ${PRODUCT_TABLE} l
       join ${PRODUCT_TABLE} r
         on r.collection = $2 and r.deleted_at is null
        and r.data->>$3 = l.data->>$3
       where l.collection = $1 and l.deleted_at is null
       order by l.record_id asc limit $4`,
      [l, r, String(on), lim]
    );
    return q.rows.map((x) => ({
      left: { collection: x.left_collection, id: Number(x.left_id), data: fc.openRecord(x.left_collection, x.left_id, x.left_data) },
      right: { collection: x.right_collection, id: Number(x.right_id), data: fc.openRecord(x.right_collection, x.right_id, x.right_data) },
    })).map(pair => ({
      left: scrubUsersRow(claimsScope, pair.left),
      right: scrubUsersRow(claimsScope, pair.right),
    }));
  });
}

async function exportProduct(pool, tenantId, { collection, claims = null }) {
  const col = assertCollection(collection);
  /* row 88: closed role allowlist (server/privacy.js). Unknown/guard roles never export. */
  const mode = claims ? privacy.exportMode(claims.role) : 'school';
  if (!mode) throw new TenancyError('export_role_denied', 403, { role: String((claims && claims.role) || '') });
  /* ردیف ۵۷: خروجیِ کاملِ users فقط مدیر است */
  if (col === 'users' && mode !== 'school') {
    throw new TenancyError('forbidden', 403, { collection: col });
  }
  return withTenant(pool, tenantId, async (c) => {
    /* row 88: a non-manager export is limited to the caller's server-side scope (row 38).
       Constant SQL + the same rowInScope() the push path uses (no dynamic SQL; export is rare). */
    const scope = (claims && mode !== 'school') ? await scopeMod.build(c, claims) : null;
    if (scope && !scopeMod.canReadCollection(scope, col)) throw new TenancyError('forbidden_collection', 403, { collection: col });
    const q = await c.query(`select r.collection, r.record_id, r.version, r.data, r.deleted_at, r.updated_at
                             from ${PRODUCT_TABLE} r where r.collection = $1 and r.deleted_at is null
                             order by r.record_id asc`, [col]);
    const who = { role: claims ? String(claims.role || '') : 'manager', uid: claims ? claims.uid : null };
    const rows = q.rows.map(productRowOf)
      .filter(r => !scope || scopeMod.rowInScope(scope, col, Object.assign({}, r.data, { id: r.id })))
      .map(r => privacy.scrubExportRow(who, r));
    return { collection: col, count: rows.length, scope: mode, rows };
  });
}

/* row 88: "my data" export — every collection the caller may read, inside their scope.
   The caller's own users row keeps its identity fields; nobody else's does. */
const SUBJECT_EXPORT_MAX = 5000;
async function exportSubject(pool, tenantId, { claims }) {
  const mode = claims ? privacy.exportMode(claims.role) : null;
  if (!mode) throw new TenancyError('export_role_denied', 403, { role: String((claims && claims.role) || '') });
  return withTenant(pool, tenantId, async (c) => {
    const scope = await scopeMod.build(c, claims);
    const cols = Object.keys(policy.COLLECTIONS).filter(n => policy.collectionAllowed(n) && scopeMod.canReadCollection(scope, n));
    const q = await c.query(`select r.collection, r.record_id, r.version, r.data, r.deleted_at, r.updated_at
                             from ${PRODUCT_TABLE} r
                             where r.collection = any($1::text[]) and r.deleted_at is null
                             order by r.collection asc, r.record_id asc`, [cols]);
    /* a manager's own data is their users row (the school export is /export) */
    const mine = (r) => (scope.all
      ? (r.collection === 'users' && r.id === Number(scope.uid))
      : scopeMod.rowInScope(scope, r.collection, Object.assign({}, r.data, { id: r.id })));
    const all = q.rows.map(productRowOf).filter(mine);
    const truncated = all.length > SUBJECT_EXPORT_MAX;
    const rows = all.slice(0, SUBJECT_EXPORT_MAX).map(r => privacy.scrubExportRow({ role: scope.role, uid: scope.uid }, r, { subject: true }));
    const byCollection = {};
    for (const r of rows) byCollection[r.collection] = (byCollection[r.collection] || 0) + 1;
    return { subject: { role: scope.role, uid: scope.uid }, count: rows.length, truncated, by_collection: byCollection, rows };
  });
}

/* row 88: tombstone view (metadata only — never the body) and retention purge. Manager only. */
async function listTombstones(pool, tenantId, { collection = null, limit = 200 } = {}) {
  const col = collection ? assertCollection(collection) : null;
  const lim = Math.max(1, Math.min(1000, Number(limit) || 200));
  return withTenant(pool, tenantId, async (c) => {
    const q = await c.query(`select collection, record_id, version, deleted_at
                               from ${PRODUCT_TABLE}
                              where deleted_at is not null and ($1::text is null or collection = $1)
                              order by deleted_at desc, collection asc, record_id asc limit $2`, [col, lim]);
    return q.rows.map(r => ({
      collection: r.collection, id: Number(r.record_id), version: Number(r.version),
      deleted_at: r.deleted_at instanceof Date ? r.deleted_at.toISOString() : r.deleted_at,
    }));
  });
}

async function purgeTombstones(pool, tenantId, { retain_days: retainDays } = {}) {
  const days = privacy.checkRetainDays(retainDays);
  if (days === null) {
    throw new TenancyError('bad_retain_days', 400, { min: privacy.TOMBSTONE_MIN_DAYS, max: privacy.TOMBSTONE_MAX_DAYS });
  }
  return withTenant(pool, tenantId, async (c) => {
    const q = await c.query(`delete from ${PRODUCT_TABLE}
                              where deleted_at is not null and deleted_at < now() - ($1::int || ' days')::interval
                              returning collection`, [days]);
    const byCollection = {};
    for (const r of q.rows) byCollection[r.collection] = (byCollection[r.collection] || 0) + 1;
    const left = await c.query(`select count(*)::int as n from ${PRODUCT_TABLE} where deleted_at is not null`);
    return { purged: q.rowCount, by_collection: byCollection, tombstones_left: Number(left.rows[0].n), retain_days: days };
  });
}

async function enqueueJob(pool, tenantId, { kind, payload = {} } = {}) {
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(String(kind || ''))) throw new TenancyError('bad_job_kind', 400);
  return withTenant(pool, tenantId, async (c) => {
    const q = await c.query(
      `insert into ${JOBS_TABLE} (tenant_id, kind, payload)
       values (current_setting('app.tenant_id')::uuid, $1, $2::jsonb)
       returning id, kind, status, created_at`,
      [String(kind), JSON.stringify(payload)]
    );
    return { id: Number(q.rows[0].id), kind: q.rows[0].kind, status: q.rows[0].status };
  });
}

async function claimJob(pool, tenantId) {
  return withTenant(pool, tenantId, async (c) => {
    const q = await c.query(
      `update ${JOBS_TABLE} set status = 'running', started_at = now()
       where id = (select id from ${JOBS_TABLE} where status = 'pending'
                   order by id asc limit 1 for update skip locked)
       returning id, kind, payload, status`
    );
    return q.rows.length ? { id: Number(q.rows[0].id), kind: q.rows[0].kind, payload: q.rows[0].payload, status: q.rows[0].status } : null;
  });
}

async function completeJob(pool, tenantId, { id, status = 'done', result = {} } = {}) {
  const st = status === 'failed' ? 'failed' : 'done';
  return withTenant(pool, tenantId, async (c) => {
    const q = await c.query(
      `update ${JOBS_TABLE} set status = $1, result = $2::jsonb, finished_at = now()
       where id = $3 returning id, status`,
      [st, JSON.stringify(result), Number(id)]
    );
    return q.rows.length ? { id: Number(q.rows[0].id), status: q.rows[0].status } : null;
  });
}

function bearer(headers) {
  const raw = String((headers && (headers.authorization || headers.Authorization)) || '');
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1] : '';
}

async function route({ method, pathname, search, headers = {}, body = {} }) {
  if (!state.enabled) return { status: 404, body: { ok: false, error: 'tenancy_disabled' } };

  let claims;
  try { claims = verifyToken(bearer(headers), state.secret); }
  catch (e) { return { status: e.status || 401, body: { ok: false, error: e.code || 'unauthorized' } }; }

  /* مستأجر فقط از توکن — هیچ کلید دیگری در درخواست اثر ندارد */
  const tid = claims.tid;
  /* row 88: a request naming another school is refused, not silently re-scoped */
  const xt = privacy.crossTenant(tid, body, search);
  if (xt) return { status: 403, body: { ok: false, error: 'cross_tenant', key: xt.key } };
  const base = '/api/cloud/tenancy/records';
  const m = String(method || 'GET').toUpperCase();
  const kind = search && typeof search.get === 'function' ? search.get('kind') : null;
  const limit = search && typeof search.get === 'function' ? search.get('limit') : null;

  const PBASE = '/api/cloud/tenancy/product';

  try {
    /* ── مسیر محصول: بدنهٔ ۲۶ کالکشن روی PostgreSQL با RLS ─────────── */
    /* ── change-feed هر مدرسه (ردیف ۳۶) ─────────────────────────────── */
    if (pathname === PBASE + '/feed' && m === 'GET') {
      const out = await listFeed(state.pool, tid, {
        sinceSeq: search.get('since_seq'), collection: search.get('collection'), limit: search.get('limit'), claims,
      });
      return { status: 200, body: Object.assign({ ok: true }, out) };
    }
    if (pathname === PBASE + '/feed/stats' && m === 'GET') {
      return { status: 200, body: { ok: true, feed: await feedStats(state.pool, tid) } };
    }
    if (pathname === PBASE + '/feed/compress' && m === 'POST') {
      if (String(claims.role || '') !== 'manager') return { status: 403, body: { ok: false, error: 'forbidden' } };
      const out = await compressFeed(state.pool, tid, { hotDays: (body && body.hot_days) });
      return { status: 200, body: Object.assign({ ok: true }, out) };
    }
    if (pathname === PBASE + '/feed/prune' && m === 'POST') {
      /* حذف شاهد/دادهٔ قدیمی فقط با نقش مدیر — نه هر دستگاهی */
      if (String(claims.role || '') !== 'manager') return { status: 403, body: { ok: false, error: 'forbidden' } };
      const out = await pruneFeed(state.pool, tid, {
        keepDays: (body && body.keep_days), collection: (body && body.collection),
      });
      return { status: 200, body: Object.assign({ ok: true }, out) };
    }
    if (pathname === PBASE + '/join' && m === 'POST') {
      const rows = await joinProduct(state.pool, tid, Object.assign({}, body || {}, { claims }));
      return { status: 200, body: { ok: true, rows, count: rows.length } };
    }
    if (pathname === PBASE + '/export' && m === 'POST') {
      const out = await exportProduct(state.pool, tid, Object.assign({}, body || {}, { claims }));
      return { status: 200, body: Object.assign({ ok: true }, out) };
    }
    if (pathname === PBASE + '/export/me' && m === 'POST') {
      return { status: 200, body: Object.assign({ ok: true }, await exportSubject(state.pool, tid, { claims })) };
    }
    if (pathname === PBASE + '/tombstones' && m === 'GET') {
      if (String(claims.role || '') !== 'manager') return { status: 403, body: { ok: false, error: 'forbidden' } };
      const rows = await listTombstones(state.pool, tid, { collection: search.get('collection'), limit: search.get('limit') });
      return { status: 200, body: { ok: true, rows, count: rows.length, retain_days: privacy.tombstoneRetainDays() } };
    }
    if (pathname === PBASE + '/tombstones/purge' && m === 'POST') {
      if (String(claims.role || '') !== 'manager') return { status: 403, body: { ok: false, error: 'forbidden' } };
      return { status: 200, body: Object.assign({ ok: true }, await purgeTombstones(state.pool, tid, body || {})) };
    }
    if (pathname === PBASE + '/jobs' && m === 'POST') {
      return { status: 201, body: { ok: true, job: await enqueueJob(state.pool, tid, body || {}) } };
    }
    if (pathname === PBASE + '/jobs/claim' && m === 'POST') {
      const job = await claimJob(state.pool, tid);
      return job ? { status: 200, body: { ok: true, job } } : { status: 204, body: { ok: true, job: null } };
    }
    const cjm = pathname.match(/^\/api\/cloud\/tenancy\/product\/jobs\/(\d+)\/complete$/);
    if (cjm && m === 'POST') {
      return { status: 200, body: { ok: true, job: await completeJob(state.pool, tid, Object.assign({ id: Number(cjm[1]) }, body || {})) } };
    }
    if (pathname === PBASE) {
      if (m === 'GET') {
        const rows = await listProduct(state.pool, tid, {
          collection: search.get('collection'), since: search.get('since'), limit: search.get('limit'), claims,
        });
        return { status: 200, body: { ok: true, rows, count: rows.length } };
      }
      if (m === 'POST' || m === 'PUT') {
        const out = await upsertProduct(state.pool, tid, Object.assign({}, body || {}, { claims }));
        if (out.conflict) return { status: 409, body: { ok: false, error: 'version_conflict', version: out.version } };
        return { status: 201, body: { ok: true, row: out.row } };
      }
      return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
    }
    const pm = pathname.match(/^\/api\/cloud\/tenancy\/product\/([a-z][a-z0-9_]{1,40})\/(\d+)$/);
    if (pm) {
      const collection = pm[1]; const rid = Number(pm[2]);
      if (m === 'GET') {
        const row = await getProduct(state.pool, tid, { collection, id: rid, claims });
        return row ? { status: 200, body: { ok: true, row } } : { status: 404, body: { ok: false, error: 'not_found' } };
      }
      if (m === 'DELETE') {
        const gone = await deleteProduct(state.pool, tid, { collection, id: rid, claims });
        return gone ? { status: 200, body: { ok: true, deleted: gone } } : { status: 404, body: { ok: false, error: 'not_found' } };
      }
      return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
    }
    if (pathname === base) {
      if (m === 'GET') return { status: 200, body: { ok: true, records: await listRecords(state.pool, tid, { kind, limit }) } };
      if (m === 'POST') {
        const rec = await createRecord(state.pool, tid, { kind: body && body.kind, body: (body && body.body) || {} });
        return { status: 201, body: { ok: true, record: rec } };
      }
      return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
    }
    if (pathname.startsWith(base + '/')) {
      const id = pathname.slice(base.length + 1);
      if (!UUID_RE.test(id)) return { status: 404, body: { ok: false, error: 'not_found' } };
      if (m === 'GET') {
        const rec = await getRecord(state.pool, tid, id);
        return rec ? { status: 200, body: { ok: true, record: rec } } : { status: 404, body: { ok: false, error: 'not_found' } };
      }
      if (m === 'PATCH' || m === 'PUT') {
        const rec = await updateRecord(state.pool, tid, id, { body: body && body.body });
        return rec ? { status: 200, body: { ok: true, record: rec } } : { status: 404, body: { ok: false, error: 'not_found' } };
      }
      if (m === 'DELETE') {
        const gone = await deleteRecord(state.pool, tid, id);
        return gone ? { status: 200, body: { ok: true, deleted: gone } } : { status: 404, body: { ok: false, error: 'not_found' } };
      }
      return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
    }
    return { status: 404, body: { ok: false, error: 'not_found' } };
  } catch (e) {
    const code = e && e.code ? String(e.code) : 'tenancy_error';
    const known = e instanceof TenancyError;
    return { status: known ? (e.status || 400) : 500, body: { ok: false, error: code } };
  }
}

async function close() {
  if (state.pool) { const p = state.pool; state.pool = null; state.enabled = false; await p.end(); }
}

/* ── rollback مهاجرت بدنهٔ محصول (فقط با تأیید صریح) ────────────────── */
async function rollbackProduct(client) {
  const sqls = [
    `DROP TABLE IF EXISTS ${JOBS_TABLE}`,
    `DROP TABLE IF EXISTS ${PRODUCT_TABLE}`,
  ];
  for (const sql of sqls) await client.query(sql);
  return { dropped: [JOBS_TABLE, PRODUCT_TABLE], statements: sqls.length };
}

/* ردیف ۸۷: مهرِ دوبارهٔ همهٔ فیلدهای حساسِ یک مستأجر با کلید فعال
   (چرخش کلید / مهاجرت متن سادهٔ قدیمی). نسخه و feed seq عوض نمی‌شوند. */
async function rekeyFields(pool, tenantId) {
  const out = { records: 0, feed: 0 };
  if (!fc.enabled()) return out;
  const zlib = require('node:zlib');
  const cols = fc.sealedCollections();
  return withTenant(pool, tenantId, async (c) => {
    const q = await c.query(`select collection, record_id, data from ${PRODUCT_TABLE} where collection = any($1::text[])`, [cols]);
    for (const r of q.rows) {
      if (!fc.needsReseal(r.collection, r.data)) continue;
      const next = fc.sealRecord(r.collection, r.record_id, fc.openRecord(r.collection, r.record_id, r.data));
      await c.query(`update ${PRODUCT_TABLE} set data = $3::jsonb where collection = $1 and record_id = $2`, [r.collection, r.record_id, JSON.stringify(next)]);
      out.records++;
    }
    const f = await c.query(`select seq, collection, record_id, data, data_gz from ${FEED_TABLE} where collection = any($1::text[])`, [cols]);
    for (const r of f.rows) {
      if (r.data != null) {
        if (!fc.needsReseal(r.collection, r.data)) continue;
        const next = fc.sealRecord(r.collection, r.record_id, fc.openRecord(r.collection, r.record_id, r.data));
        await c.query(`update ${FEED_TABLE} set data = $2::jsonb where seq = $1`, [r.seq, JSON.stringify(next)]);
        out.feed++;
      } else if (r.data_gz != null) {
        let d; try { d = JSON.parse(zlib.gunzipSync(r.data_gz).toString('utf8')); } catch (e) { continue; }
        if (!fc.needsReseal(r.collection, d)) continue;
        const next = fc.sealRecord(r.collection, r.record_id, fc.openRecord(r.collection, r.record_id, d));
        await c.query(`update ${FEED_TABLE} set data_gz = $2 where seq = $1`, [r.seq, zlib.gzipSync(Buffer.from(JSON.stringify(next), 'utf8'))]);
        out.feed++;
      }
    }
    return out;
  });
}

module.exports = { SCHOOL_TABLE, CRED_TABLE, upsertInTx, rekeyFields, replicaPolicy, transfer, maxFeedSeq, scopeMod, getPool, applyOps, takeQuota, readiness, poolSnapshot, poolMax, acquire, poolWaitReset, poolWaitSnapshot, appendFeed, listFeed, pruneFeed, compressFeed, feedStats, feedPayload, FEED_TABLE, OPS_TABLE, QUOTA_TABLE, MAX_OPS_PER_REQUEST, MAX_OP_BYTES,
  TABLE, PRODUCT_TABLE, JOBS_TABLE, OWNER_ROLE, RUNTIME_ROLE, SCHEMA_SQL, TOKEN_VERSION,
  TenancyError, signToken, verifyToken, migrate, rollbackProduct, createPool, withTenant,
  listRecords, getRecord, createRecord, updateRecord, deleteRecord,
  listProduct, getProduct, upsertProduct, deleteProduct, joinProduct, exportProduct, exportSubject, listTombstones, purgeTombstones,
  enqueueJob, claimJob, completeJob,
  init, status, route, close,
};

/* CLI: مهاجرت با اتصال مدیر
   PAYESH_TENANCY_ADMIN_URL=postgres://… node server/tenancy.js --migrate  */
if (require.main === module) {
  (async () => {
    const url = String(process.env.PAYESH_TENANCY_ADMIN_URL || '').trim();
    const mode = process.argv.slice(2)[0] || '--migrate';
    if (!url) { console.error('PAYESH_TENANCY_ADMIN_URL لازم است'); process.exit(2); }
    const { Client } = require('pg');
    const c = new Client({ connectionString: url });
    await c.connect();
    let out;
    if (mode === '--migrate') out = await migrate(c);
    else if (mode === '--rollback-product') {
      if (String(process.env.PAYESH_TENANCY_CONFIRM || '') !== '1') {
        console.error('برای rollback باید PAYESH_TENANCY_CONFIRM=1 تنظیم شود');
        process.exit(3);
      }
      out = await rollbackProduct(c);
    } else { console.error('حالت ناشناخته:', mode); process.exit(2); }
    await c.end();
    console.log(JSON.stringify(Object.assign({ ok: true, mode }, out)));
  })().catch((e) => { console.error('tenancy cli failed:', e.message); process.exit(1); });
}
