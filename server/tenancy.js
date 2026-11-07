'use strict';
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

const TOKEN_VERSION = 1;
const TABLE = 'tenant_records';
/* بدنهٔ محصول (همهٔ کالکشن‌ها) در یک جدول چندمستأجری با همان سیاست RLS */
const PRODUCT_TABLE = 'product_records';
const JOBS_TABLE = 'product_jobs';
const OWNER_ROLE = 'payesh_owner';
const RUNTIME_ROLE = 'payesh_runtime';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 64 * 1024;

class TenancyError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
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
];

/* اجرای مهاجرت با اتصال مدیر (superuser) — بخشی از محصول است، نه هارنس */
async function migrate(client) {
  for (const sql of SCHEMA_SQL) await client.query(sql);
  const v = await client.query('select current_setting($1, true) as v', ['server_version']);
  return { table: TABLE, statements: SCHEMA_SQL.length, server_version: v.rows[0] && v.rows[0].v };
}

/* ── اتصال runtime ─────────────────────────────────────────────────── */
function createPool({ connectionString, max = 4 }) {
  let Pool;
  try { ({ Pool } = require('pg')); }
  catch (e) { throw new TenancyError('pg_driver_missing', 500); }
  return new Pool({ connectionString, max, application_name: 'payesh-tenancy' });
}

/* هر عملیات در یک تراکنش با زمینهٔ مستأجر اجرا می‌شود */
async function withTenant(pool, tenantId, fn) {
  if (!UUID_RE.test(String(tenantId || ''))) throw new TenancyError('bad_tenant', 400);
  const client = await pool.connect();
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
    data: r.data,
    deleted: !!r.deleted_at,
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
  };
}

function assertCollection(name) {
  if (!COLLECTION_RE.test(String(name || ''))) throw new TenancyError('bad_collection', 400);
  return String(name);
}

async function listProduct(pool, tenantId, { collection, since = null, limit = 200 } = {}) {
  const col = assertCollection(collection);
  const lim = Math.max(1, Math.min(1000, Number(limit) || 200));
  return withTenant(pool, tenantId, async (c) => {
    const q = since
      ? await c.query(`select collection, record_id, version, data, deleted_at, updated_at
                       from ${PRODUCT_TABLE}
                       where collection = $1 and updated_at > $2
                       order by record_id asc limit $3`, [col, String(since), lim])
      : await c.query(`select collection, record_id, version, data, deleted_at, updated_at
                       from ${PRODUCT_TABLE} where collection = $1
                       order by record_id asc limit $2`, [col, lim]);
    return q.rows.map(productRowOf);
  });
}

async function getProduct(pool, tenantId, { collection, id }) {
  const col = assertCollection(collection);
  return withTenant(pool, tenantId, async (c) => {
    const q = await c.query(`select collection, record_id, version, data, deleted_at, updated_at
                             from ${PRODUCT_TABLE} where collection = $1 and record_id = $2`, [col, Number(id)]);
    return q.rows.length ? productRowOf(q.rows[0]) : null;
  });
}

/* درج/به‌روزرسانی با کنترل نسخه (OCC) — tenant از زمینهٔ تراکنش */
async function upsertProduct(pool, tenantId, { collection, id, data = {}, base_version = null } = {}) {
  const col = assertCollection(collection);
  const rid = Number(id);
  if (!Number.isInteger(rid) || rid < 1) throw new TenancyError('bad_id', 400);
  const clean = Object.assign({}, data);
  delete clean.tenant_id; delete clean.tenantId; /* ورودی کلاینت هرگز مستأجر را تعیین نمی‌کند */
  delete clean.school_id; delete clean.schoolId;
  return withTenant(pool, tenantId, async (c) => {
    const cur = await c.query(`select version from ${PRODUCT_TABLE} where collection = $1 and record_id = $2 for update`, [col, rid]);
    const exists = cur.rows.length > 0;
    const version = exists ? Number(cur.rows[0].version) : 0;
    if (base_version != null && Number(base_version) !== version) {
      return { conflict: true, version, data: null };
    }
    const q = await c.query(
      `insert into ${PRODUCT_TABLE} (tenant_id, collection, record_id, version, data, deleted_at)
       values (current_setting('app.tenant_id')::uuid, $1, $2, 1, $3::jsonb, null)
       on conflict (tenant_id, collection, record_id)
       do update set data = excluded.data, version = ${PRODUCT_TABLE}.version + 1, deleted_at = null, updated_at = now()
       returning collection, record_id, version, data, deleted_at, updated_at`,
      [col, rid, JSON.stringify(clean)]
    );
    return { conflict: false, row: productRowOf(q.rows[0]) };
  });
}

async function deleteProduct(pool, tenantId, { collection, id }) {
  const col = assertCollection(collection);
  return withTenant(pool, tenantId, async (c) => {
    const q = await c.query(
      `update ${PRODUCT_TABLE} set deleted_at = now(), version = version + 1, updated_at = now()
       where collection = $1 and record_id = $2 returning collection, record_id, version`,
      [col, Number(id)]
    );
    return q.rows.length ? { collection: col, id: Number(q.rows[0].record_id), version: Number(q.rows[0].version), deleted: true } : null;
  });
}

/* join دو کالکشن روی یک کلید در jsonb — همچنان داخل زمینهٔ مستأجر */
async function joinProduct(pool, tenantId, { left, right, on, limit = 200 } = {}) {
  const l = assertCollection(left); const r = assertCollection(right);
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(String(on || ''))) throw new TenancyError('bad_join_key', 400);
  const lim = Math.max(1, Math.min(1000, Number(limit) || 200));
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
      left: { collection: x.left_collection, id: Number(x.left_id), data: x.left_data },
      right: { collection: x.right_collection, id: Number(x.right_id), data: x.right_data },
    }));
  });
}

async function exportProduct(pool, tenantId, { collection }) {
  const col = assertCollection(collection);
  return withTenant(pool, tenantId, async (c) => {
    const q = await c.query(`select collection, record_id, version, data, deleted_at, updated_at
                             from ${PRODUCT_TABLE} where collection = $1 and deleted_at is null
                             order by record_id asc`, [col]);
    return { collection: col, count: q.rows.length, rows: q.rows.map(productRowOf) };
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
  const base = '/api/cloud/tenancy/records';
  const m = String(method || 'GET').toUpperCase();
  const kind = search && typeof search.get === 'function' ? search.get('kind') : null;
  const limit = search && typeof search.get === 'function' ? search.get('limit') : null;

  const PBASE = '/api/cloud/tenancy/product';

  try {
    /* ── مسیر محصول: بدنهٔ ۲۶ کالکشن روی PostgreSQL با RLS ─────────── */
    if (pathname === PBASE + '/join' && m === 'POST') {
      const rows = await joinProduct(state.pool, tid, body || {});
      return { status: 200, body: { ok: true, rows, count: rows.length } };
    }
    if (pathname === PBASE + '/export' && m === 'POST') {
      const out = await exportProduct(state.pool, tid, body || {});
      return { status: 200, body: Object.assign({ ok: true }, out) };
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
          collection: search.get('collection'), since: search.get('since'), limit: search.get('limit'),
        });
        return { status: 200, body: { ok: true, rows, count: rows.length } };
      }
      if (m === 'POST' || m === 'PUT') {
        const out = await upsertProduct(state.pool, tid, body || {});
        if (out.conflict) return { status: 409, body: { ok: false, error: 'version_conflict', version: out.version } };
        return { status: 201, body: { ok: true, row: out.row } };
      }
      return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
    }
    const pm = pathname.match(/^\/api\/cloud\/tenancy\/product\/([a-z][a-z0-9_]{1,40})\/(\d+)$/);
    if (pm) {
      const collection = pm[1]; const rid = Number(pm[2]);
      if (m === 'GET') {
        const row = await getProduct(state.pool, tid, { collection, id: rid });
        return row ? { status: 200, body: { ok: true, row } } : { status: 404, body: { ok: false, error: 'not_found' } };
      }
      if (m === 'DELETE') {
        const gone = await deleteProduct(state.pool, tid, { collection, id: rid });
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

module.exports = {
  TABLE, PRODUCT_TABLE, JOBS_TABLE, OWNER_ROLE, RUNTIME_ROLE, SCHEMA_SQL, TOKEN_VERSION,
  TenancyError, signToken, verifyToken, migrate, rollbackProduct, createPool, withTenant,
  listRecords, getRecord, createRecord, updateRecord, deleteRecord,
  listProduct, getProduct, upsertProduct, deleteProduct, joinProduct, exportProduct,
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
