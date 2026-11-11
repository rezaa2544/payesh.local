'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 88 — user data delete/export (privacy)
   Doc: docs/security/88-privacy-delete-export.md · Test: tests/privacy-88.js

   One policy module shared by the cloud product path (server/tenancy.js)
   and the local school server (server/index.js + server/db.js):

   1) EXPORT ROLE ALLOWLIST. Who may export, and how much:
        manager            → the whole school (identity fields included — D1/row 57);
        teacher/counselor/
        parent/student     → only rows inside their own server-side scope (row 38),
                             and never anyone else's identity fields;
        guard / unknown    → refused (export_role_denied).
      A role that is not listed here can never export — the allowlist is closed.
   2) NO ONE ELSE'S national_id. For every non-manager export row, the identity
      fields of policy.USER_IDENTITY_FIELDS (national_id, father_nid, mother_nid,
      shenasname_*, phones, address…) are removed from the row — in EVERY
      collection, not only users — unless the row is the caller's own users row.
      Secret fields (password_*, phone_hash, token*…) are removed for everyone.
   3) TOMBSTONE RETENTION. A deleted record stays as a tombstone (deleted_at set)
      so offline devices learn about the delete on their next pull. It is hard-
      purged after PAYESH_TOMBSTONE_RETAIN_DAYS (default 90). The minimum is 31:
      a device unseen for PAYESH_DEVICE_STALE_DAYS (30) is retired and must log in
      again (full resync), and the change feed keeps 30 days — so a tombstone
      older than 31 days can no longer be needed by any live device.
      The tombstone view shows metadata only (collection, id, version, deleted_at),
      never the record body.
   4) CROSS-SCHOOL REQUESTS. The school (tenant) comes only from the signed token.
      A request that names a different school in its body or query
      (tenant_id / tenantId / tid) is REFUSED with cross_tenant (403) instead of
      being silently ignored, so a confused or malicious client is visible in logs.
   ═══════════════════════════════════════════════════════════════════ */
const policy = require('./policy');

const EXPORT_ROLES = Object.freeze({
  manager: 'school',
  teacher: 'scoped',
  counselor: 'scoped',
  parent: 'scoped',
  student: 'scoped',
});

const TOMBSTONE_DEFAULT_DAYS = 90;
const TOMBSTONE_MIN_DAYS = 31;
const TOMBSTONE_MAX_DAYS = 3650;
const TENANT_KEYS = ['tenant_id', 'tenantId', 'tid'];

/** 'school' | 'scoped' | null (refused) */
function exportMode(role) {
  const r = String(role || '');
  return Object.prototype.hasOwnProperty.call(EXPORT_ROLES, r) ? EXPORT_ROLES[r] : null;
}

/** Strip identity fields of other people (and secrets of everyone) from one export row's data. */
function scrubExportData(data, { role, self = false } = {}) {
  const src = (data && typeof data === 'object') ? data : {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (policy.isSecretField(k)) continue;
    if (role !== 'manager' && !self && policy.USER_IDENTITY_FIELDS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Product-row shape ({collection,id,data,…}) → scrubbed copy for `scope` (role + uid).
    opts.subject = a "my data" export: secrets go even for a manager. */
function scrubExportRow(scope, row, opts = {}) {
  if (!row) return row;
  const role = String((scope && scope.role) || '');
  if (role === 'manager' && !opts.subject) return row;
  const self = row.collection === 'users' && scope && Number.isFinite(Number(scope.uid)) && Number(row.id) === Number(scope.uid);
  return Object.assign({}, row, { data: scrubExportData(row.data, { role, self }) });
}

function tombstoneRetainDays(raw = process.env.PAYESH_TOMBSTONE_RETAIN_DAYS) {
  if (raw === undefined || raw === null || raw === '') return TOMBSTONE_DEFAULT_DAYS;
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n < TOMBSTONE_MIN_DAYS || n > TOMBSTONE_MAX_DAYS) return null;
  return n;
}

/** Validate an explicit retain_days from a request; null = invalid (caller answers 400). */
function checkRetainDays(v) {
  if (v === undefined || v === null || v === '') return tombstoneRetainDays();
  return tombstoneRetainDays(v);
}

/** Every school id named by the request (body/query) must equal the token's. */
function crossTenant(tokenTid, ...sources) {
  const want = String(tokenTid || '').toLowerCase();
  for (const src of sources) {
    if (!src) continue;
    for (const k of TENANT_KEYS) {
      let v;
      if (typeof src.get === 'function') v = src.get(k);
      else if (typeof src === 'object' && Object.prototype.hasOwnProperty.call(src, k)) v = src[k];
      if (v === undefined || v === null || v === '') continue;
      if (String(v).toLowerCase() !== want) return { key: k };
    }
  }
  return null;
}

module.exports = {
  EXPORT_ROLES, TOMBSTONE_DEFAULT_DAYS, TOMBSTONE_MIN_DAYS, TOMBSTONE_MAX_DAYS, TENANT_KEYS,
  exportMode, scrubExportData, scrubExportRow, tombstoneRetainDays, checkRetainDays, crossTenant,
};
