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

  try {
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

module.exports = {
  TABLE, OWNER_ROLE, RUNTIME_ROLE, SCHEMA_SQL, TOKEN_VERSION,
  TenancyError, signToken, verifyToken, migrate, createPool, withTenant,
  listRecords, getRecord, createRecord, updateRecord, deleteRecord,
  init, status, route, close,
};

/* CLI: مهاجرت با اتصال مدیر
   PAYESH_TENANCY_ADMIN_URL=postgres://… node server/tenancy.js --migrate  */
if (require.main === module) {
  (async () => {
    const url = String(process.env.PAYESH_TENANCY_ADMIN_URL || '').trim();
    if (!url) { console.error('PAYESH_TENANCY_ADMIN_URL لازم است'); process.exit(2); }
    const { Client } = require('pg');
    const c = new Client({ connectionString: url });
    await c.connect();
    const out = await migrate(c);
    await c.end();
    console.log(JSON.stringify(Object.assign({ ok: true }, out)));
  })().catch((e) => { console.error('migrate failed:', e.message); process.exit(1); });
}
