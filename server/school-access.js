'use strict';
/* Row 121 — school access: from "owner creates a school" to "the school manager holds a
   school token", without a password database and without the platform touching school data
   directly.

   provisionSchool()  called by the owner panel (platform-api POST /tenants) through an
                      injected hook. Under the school runtime role + forced RLS of the NEW
                      tenant: maps slug → tenant, seeds users#1 = initial manager, returns a
                      one-time activation code. Idempotent: a re-run for the same tenant never
                      creates a second manager; it re-issues a code only while the manager has
                      not activated yet.
   activate()         public (no token): school slug + one-time code + device id → school
                      token + device secret. The role/uid come from the school's own users row,
                      never from the request.
   refresh()          public: device id + device secret → fresh token (role re-read, so a
                      deactivated user or a changed role takes effect at the next refresh).
   issueActivation()  manager-only (school token): one-time code for a user of the SAME tenant.

   Secrets (codes, device secrets) are random 160-bit values, returned once, stored only as
   sha256(tenant ':' secret). Nothing here logs a code or a secret.
   Every query also names the tenant explicitly (defence in depth on top of forced RLS). */

const crypto = require('node:crypto');
const tenancy = require('./tenancy');
const policy = require('./policy');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
const DEVICE_RE = /^[A-Za-z0-9._:-]{4,64}$/;
const CODE_RE = /^[A-Z2-7]{32}$/;
const MANAGER_UID = 1;
const DEFAULT_CODE_TTL_MS = 7 * 24 * 3600 * 1000;
const DEFAULT_TOKEN_TTL_MS = 12 * 3600 * 1000;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/* SQL below names the tables literally (constant SQL, values only as $n parameters); keep in step */
if (tenancy.CRED_TABLE !== 'gw_credential' || tenancy.SCHOOL_TABLE !== 'gw_school' || tenancy.PRODUCT_TABLE !== 'product_records') {
  throw new Error('school-access: table names drifted from server/tenancy.js');
}

class AccessError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

function randomCode() {
  const b = crypto.randomBytes(20);           /* 160 bits → 32 base32 chars */
  let bits = 0, val = 0, out = '';
  for (const byte of b) {
    val = (val << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return out;
}
function hashSecret(tenantId, secret) {
  return crypto.createHash('sha256').update(String(tenantId) + ':' + String(secret)).digest('hex');
}
function normCode(code) { return String(code || '').toUpperCase().replace(/[\s-]/g, ''); }

async function readUser(c, uid) {
  const r = await c.query(
    `select data from product_records
      where tenant_id = current_setting('app.tenant_id')::uuid
        and collection = 'users' and record_id = $1 and deleted_at is null`, [uid]);
  if (!r.rows.length) return null;
  const d = r.rows[0].data || {};
  const role = String(d.role || '');
  if (!policy.ROLES.includes(role) || d.active === false) return null;
  return { uid, role };
}

async function newActivation(c, tenantId, uid, issuedBy, ttlMs) {
  /* one live code per user: older unused codes are revoked */
  await c.query(`update gw_credential set revoked_at = now()
                  where tenant_id = current_setting('app.tenant_id')::uuid and kind = 'activation' and uid = $1 and used_at is null and revoked_at is null`, [uid]);
  const code = randomCode();
  await c.query(
    `insert into gw_credential (tenant_id, kind, uid, secret_hash, expires_at, issued_by)
     values (current_setting('app.tenant_id')::uuid, 'activation', $1, $2, now() + ($3 || ' milliseconds')::interval, $4)`,
    [uid, hashSecret(tenantId, code), String(Math.max(60000, Number(ttlMs) || DEFAULT_CODE_TTL_MS)), issuedBy]);
  return code;
}

async function provisionSchool(pool, { tenantId, slug, managerName, codeTtlMs } = {}) {
  if (!SLUG_RE.test(String(slug || ''))) throw new AccessError('bad_slug', 400);
  const name = String(managerName || '').trim();
  if (name.length < 2 || name.length > 120) throw new AccessError('bad_manager_name', 400);
  return tenancy.withTenant(pool, tenantId, async (c) => {
    const owner = await c.query('select gw_resolve_school($1) as tid', [slug]);
    const mapped = owner.rows[0] && owner.rows[0].tid;
    if (mapped && String(mapped) !== String(tenantId)) throw new AccessError('slug_taken', 409);
    if (!mapped) {
      await c.query(`insert into gw_school (slug, tenant_id)
                     values ($1, current_setting('app.tenant_id')::uuid)`, [slug]);
    }
    const existing = await c.query(
      `select 1 from product_records
        where tenant_id = current_setting('app.tenant_id')::uuid and collection = 'users' and record_id = $1`, [MANAGER_UID]);
    if (!existing.rows.length) {
      await tenancy.upsertInTx(c, 'users', MANAGER_UID, { id: MANAGER_UID, name, role: 'manager', active: true }, null);
    }
    const activated = await c.query(
      `select 1 from gw_credential where tenant_id = current_setting('app.tenant_id')::uuid and kind = 'device' and uid = $1 limit 1`, [MANAGER_UID]);
    if (activated.rows.length) {
      return { tenant_id: tenantId, slug, manager_uid: MANAGER_UID, manager_activated: true, activation_code: null,
        idempotent: true };
    }
    const code = await newActivation(c, tenantId, MANAGER_UID, null, codeTtlMs);
    return { tenant_id: tenantId, slug, manager_uid: MANAGER_UID, manager_activated: false, activation_code: code,
      idempotent: !!mapped };
  });
}

async function resolveTenant(pool, slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!SLUG_RE.test(s)) throw new AccessError('activation_failed', 401);
  const r = await pool.query('select gw_resolve_school($1) as tid', [s]);
  const tid = r.rows[0] && r.rows[0].tid;
  if (!tid) throw new AccessError('activation_failed', 401);   /* same answer as a bad code */
  return String(tid);
}

function issueToken({ tenantId, user, deviceId, secret, cell, ttlMs, now }) {
  /* milliseconds, like directory.issueSession and tenancy.verifyToken */
  const iat = now || Date.now();
  const exp = iat + (Number(ttlMs) || DEFAULT_TOKEN_TTL_MS);
  const claims = { tid: tenantId, role: user.role, uid: user.uid, did: deviceId, iat, exp };
  if (cell) claims.cell = cell;
  return { token: tenancy.signToken(claims, secret), expires_at: exp, role: user.role, uid: user.uid };
}

async function activate(pool, { school, code, deviceId, secret, cell, tokenTtlMs } = {}) {
  if (!secret) throw new AccessError('not_configured', 503);
  if (!DEVICE_RE.test(String(deviceId || ''))) throw new AccessError('bad_device_id', 400);
  const c0 = normCode(code);
  if (!CODE_RE.test(c0)) throw new AccessError('activation_failed', 401);
  const tenantId = await resolveTenant(pool, school);
  return tenancy.withTenant(pool, tenantId, async (c) => {
    const r = await c.query(
      `select id, uid from gw_credential
        where tenant_id = current_setting('app.tenant_id')::uuid and kind = 'activation' and secret_hash = $1 and used_at is null and revoked_at is null
          and expires_at > now() for update`, [hashSecret(tenantId, c0)]);
    if (!r.rows.length) throw new AccessError('activation_failed', 401);
    const user = await readUser(c, Number(r.rows[0].uid));
    if (!user) throw new AccessError('activation_failed', 401);
    await c.query(`update gw_credential set used_at = now() where tenant_id = current_setting('app.tenant_id')::uuid and id = $1`, [r.rows[0].id]);
    await c.query(`update gw_credential set revoked_at = now()
                    where tenant_id = current_setting('app.tenant_id')::uuid and kind = 'device' and uid = $1 and device_id = $2 and revoked_at is null`, [user.uid, deviceId]);
    const deviceSecret = randomCode();
    await c.query(
      `insert into gw_credential (tenant_id, kind, uid, device_id, secret_hash)
       values (current_setting('app.tenant_id')::uuid, 'device', $1, $2, $3)`,
      [user.uid, deviceId, hashSecret(tenantId, deviceSecret)]);
    return Object.assign({ tenant_id: tenantId, device_secret: deviceSecret },
      issueToken({ tenantId, user, deviceId, secret, cell, ttlMs: tokenTtlMs }));
  });
}

async function refresh(pool, { school, deviceId, deviceSecret, secret, cell, tokenTtlMs } = {}) {
  if (!secret) throw new AccessError('not_configured', 503);
  if (!DEVICE_RE.test(String(deviceId || ''))) throw new AccessError('bad_device_id', 400);
  const s0 = normCode(deviceSecret);
  if (!CODE_RE.test(s0)) throw new AccessError('refresh_failed', 401);
  let tenantId;
  try { tenantId = await resolveTenant(pool, school); } catch (e) { throw new AccessError('refresh_failed', 401); }
  return tenancy.withTenant(pool, tenantId, async (c) => {
    const r = await c.query(
      `select uid from gw_credential
        where tenant_id = current_setting('app.tenant_id')::uuid and kind = 'device' and device_id = $1 and secret_hash = $2 and revoked_at is null`,
      [deviceId, hashSecret(tenantId, s0)]);
    if (!r.rows.length) throw new AccessError('refresh_failed', 401);
    const user = await readUser(c, Number(r.rows[0].uid));
    if (!user) throw new AccessError('refresh_failed', 401);
    return Object.assign({ tenant_id: tenantId },
      issueToken({ tenantId, user, deviceId, secret, cell, ttlMs: tokenTtlMs }));
  });
}

async function issueActivation(pool, claims, { uid, codeTtlMs } = {}) {
  if (!claims || claims.role !== 'manager') throw new AccessError('manager_only', 403);
  const target = Number(uid);
  if (!Number.isInteger(target) || target < 1) throw new AccessError('bad_uid', 400);
  /* tenant only from the signed token; the user must exist in THIS tenant (RLS) */
  return tenancy.withTenant(pool, claims.tid, async (c) => {
    const user = await readUser(c, target);
    if (!user) throw new AccessError('user_not_found', 404);
    const code = await newActivation(c, claims.tid, target, Number(claims.uid) || null, codeTtlMs);
    return { uid: target, role: user.role, activation_code: code };
  });
}

module.exports = {
  provisionSchool, activate, refresh, issueActivation, hashSecret, randomCode,
  AccessError, SLUG_RE, MANAGER_UID,
};
