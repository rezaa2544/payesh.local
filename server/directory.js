'use strict';
/* ═══════════════════════════════════════════════════════════════════
   دایرکتوری مرکزی و مسیردهی مدرسه → cell — ردیف ۴۳

   یک جدول مسیردهی در «دیتابیس مرکزی» نگه می‌دارد که هر مدرسه (کد مدرسه)
   روی کدام cell (دیتابیس مستقل با tenant خودش) زندگی می‌کند. توکن نشست،
   شناسهٔ cell را در خود دارد؛ Gateway هر cell فقط توکنِ همان cell را
   می‌پذیرد. پس حتی اگر مسیر اشتباه داده شود، داده از cell اشتباه بیرون
   نمی‌آید.

   سه قاعدهٔ سخت:
   ۱) کش مسیر با TTL: مسیرها در حافظهٔ فرایند کش می‌شوند تا هر ورود،
      یک کوئری به دیتابیس مرکزی نزند.
   ۲) قطع دایرکتوری = نشست‌های کش‌شده تا N دقیقه ادامه می‌دهند (stale)،
      بعد از آن ۵۰۳ `directory_unavailable` — نه «همه‌چیز باز».
   ۳) شروع با یک cell و بدون تغییر رفتار: اگر `GW_CELL` تنظیم نشده باشد
      Gateway مثل ردیف ۳۷ رفتار می‌کند و توکن قدیمی (بدون claim cell) هم
      پذیرفته می‌شود.
   ═══════════════════════════════════════════════════════════════════ */
const tenancy = require('./tenancy');

const CELLS_TABLE = 'directory_cells';
const ROUTES_TABLE = 'school_routes';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCHOOL_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/i;

const DEFAULTS = {
  ttlSec: Number(process.env.DIR_CACHE_TTL_SEC || 60),
  staleMaxSec: Number(process.env.DIR_STALE_MAX_SEC || 900), /* N دقیقه */
};

class DirectoryError extends Error {
  constructor(code, status = 400, details = null) {
    super(code); this.code = code; this.status = status; this.details = details;
  }
}

/* ── مهاجرت دیتابیس مرکزی (فقط نقش مدیر/مالک) ── */
const DIRECTORY_SQL = [
  `CREATE TABLE IF NOT EXISTS ${CELLS_TABLE} (
     cell_id     uuid PRIMARY KEY,
     name        text NOT NULL,
     region      text NOT NULL DEFAULT 'local',
     status      text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','draining','disabled')),
     created_at  timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS ${ROUTES_TABLE} (
     school_code text PRIMARY KEY,
     cell_id     uuid NOT NULL REFERENCES ${CELLS_TABLE}(cell_id) ON DELETE RESTRICT,
     updated_at  timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS ${ROUTES_TABLE}_cell_idx ON ${ROUTES_TABLE}(cell_id)`,
  /* row 66: public bootstrap API — data-plane URL per cell, route version and
     migration state per school (expand-only, old readers keep working). */
  `ALTER TABLE ${CELLS_TABLE} ADD COLUMN IF NOT EXISTS base_url text`,
  `ALTER TABLE ${ROUTES_TABLE} ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1`,
  `ALTER TABLE ${ROUTES_TABLE} ADD COLUMN IF NOT EXISTS migration_state text NOT NULL DEFAULT 'stable'`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${ROUTES_TABLE}_migration_state_chk') THEN
       ALTER TABLE ${ROUTES_TABLE} ADD CONSTRAINT ${ROUTES_TABLE}_migration_state_chk
         CHECK (migration_state IN ('stable','migrating','moved'));
     END IF;
   END $$`,
];

const MIGRATION_STATES = ['stable', 'migrating', 'moved'];
const BASE_URL_RE = /^https?:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?(?:\/[A-Za-z0-9._~\/-]{0,200})?$/;

async function migrate(client) {
  for (const sql of DIRECTORY_SQL) await client.query(sql);
  return { statements: DIRECTORY_SQL.length, cells: CELLS_TABLE, routes: ROUTES_TABLE };
}

function normalizeCode(code) {
  const c = String(code || '').trim().toLowerCase();
  if (!SCHOOL_RE.test(c)) throw new DirectoryError('bad_school_code', 400);
  return c;
}

/* ── درج/به‌روزرسانی مسیر (اداری؛ فقط از مسیر مدیر) ── */
async function upsertCell(pool, { cellId, name, region = 'local', status = 'active', baseUrl = null }) {
  if (!UUID_RE.test(String(cellId || ''))) throw new DirectoryError('bad_cell_id', 400);
  if (!['active', 'draining', 'disabled'].includes(status)) throw new DirectoryError('bad_cell_status', 400);
  if (baseUrl != null && !BASE_URL_RE.test(String(baseUrl))) throw new DirectoryError('bad_base_url', 400);
  const q = await pool.query(
    `insert into ${CELLS_TABLE} (cell_id, name, region, status, base_url) values ($1,$2,$3,$4,$5)
     on conflict (cell_id) do update set name = excluded.name, region = excluded.region, status = excluded.status,
       base_url = coalesce(excluded.base_url, ${CELLS_TABLE}.base_url)
     returning cell_id, name, region, status, base_url`, [cellId, String(name || cellId), region, status, baseUrl]
  );
  return q.rows[0];
}

/* A route change (new cell or new migration state) bumps `version`, so a client
   that cached version N knows its cache is stale the moment it sees N+1. */
async function upsertRoute(pool, { schoolCode, cellId, migrationState = 'stable' }) {
  const code = normalizeCode(schoolCode);
  if (!UUID_RE.test(String(cellId || ''))) throw new DirectoryError('bad_cell_id', 400);
  if (!MIGRATION_STATES.includes(migrationState)) throw new DirectoryError('bad_migration_state', 400);
  const q = await pool.query(
    `insert into ${ROUTES_TABLE} (school_code, cell_id, migration_state) values ($1,$2,$3)
     on conflict (school_code) do update set cell_id = excluded.cell_id, migration_state = excluded.migration_state,
       version = ${ROUTES_TABLE}.version + (case when ${ROUTES_TABLE}.cell_id is distinct from excluded.cell_id
         or ${ROUTES_TABLE}.migration_state is distinct from excluded.migration_state then 1 else 0 end),
       updated_at = now()
     returning school_code, cell_id, version, migration_state, updated_at`, [code, cellId, migrationState]
  );
  return q.rows[0];
}

async function setMigrationState(pool, schoolCode, migrationState) {
  const code = normalizeCode(schoolCode);
  if (!MIGRATION_STATES.includes(migrationState)) throw new DirectoryError('bad_migration_state', 400);
  const q = await pool.query(
    `update ${ROUTES_TABLE} set migration_state = $2,
       version = version + (case when migration_state is distinct from $2 then 1 else 0 end), updated_at = now()
     where school_code = $1 returning school_code, cell_id, version, migration_state`, [code, migrationState]
  );
  if (!q.rows.length) throw new DirectoryError('unknown_school', 404);
  return q.rows[0];
}

/* ── مسیردهی با کش TTL و stale ──
   pool: دیتابیس مرکزی. cache عمداً در سطح فرایند است (بی‌حالت داخل cell). */
function createResolver(pool, { ttlSec = DEFAULTS.ttlSec, staleMaxSec = DEFAULTS.staleMaxSec, now = Date.now } = {}) {
  const cache = new Map();
  const stats = { hits: 0, misses: 0, stale: 0, errors: 0 };

  async function readRow(code) {
    const q = await pool.query(
      `select r.school_code, r.cell_id, r.updated_at, r.version, r.migration_state, c.name, c.status, c.base_url
         from ${ROUTES_TABLE} r join ${CELLS_TABLE} c on c.cell_id = r.cell_id
        where r.school_code = $1`, [code]
    );
    return q.rows.length ? q.rows[0] : null;
  }

  async function resolve(schoolCode) {
    const code = normalizeCode(schoolCode);
    const t = now();
    const hit = cache.get(code);
    if (hit && t - hit.at < ttlSec * 1000) {
      stats.hits++;
      return Object.assign({ school_code: code }, hit.cell, { cached: true, stale: false, age_ms: t - hit.at });
    }
    try {
      const row = await readRow(code);
      if (!row) { cache.delete(code); return null; }
      const cell = {
        cell_id: row.cell_id, name: row.name, status: row.status, base_url: row.base_url || null,
        version: Number(row.version || 1), migration_state: row.migration_state || 'stable',
      };
      cache.set(code, { at: t, cell });
      stats.misses++;
      return Object.assign({ school_code: code }, cell, { cached: false, stale: false, age_ms: 0 });
    } catch (e) {
      stats.errors++;
      if (hit && t - hit.at < (ttlSec + staleMaxSec) * 1000) {
        stats.stale++;
        return Object.assign({ school_code: code }, hit.cell, { cached: true, stale: true, age_ms: t - hit.at });
      }
      throw new DirectoryError('directory_unavailable', 503, { school_code: code });
    }
  }

  return {
    resolve, stats: () => Object.assign({}, stats), cacheSize: () => cache.size,
    clear: () => cache.clear(),
    invalidate: (code) => { try { cache.delete(normalizeCode(code)); } catch (e) { /* bad code: nothing cached */ } },
    config: { ttl_sec: ttlSec, stale_max_sec: staleMaxSec },
  };
}

/* ── ورود: مدرسه → cell → توکن حاوی cell ──
   امضای توکن همان مسیر ردیف ۲۶/۳۷ است؛ فقط claim `cell` اضافه می‌شود. */
async function issueSession(resolver, { schoolCode, uid, role, did = null, tenantId, secret, ttlMs = 600000, now = Date.now() }) {
  const route = await resolver.resolve(schoolCode);
  if (!route) throw new DirectoryError('unknown_school', 404, { school_code: String(schoolCode || '') });
  if (route.status === 'disabled') throw new DirectoryError('cell_disabled', 409, { cell_id: route.cell_id });
  const tid = tenantId;
  if (!UUID_RE.test(String(tid || ''))) throw new DirectoryError('bad_tenant', 400);
  const token = tenancy.signToken({
    tid, cell: route.cell_id, role, uid, did: did || `d-${String(uid)}`,
    iat: now, exp: now + ttlMs,
  }, secret);
  return { token, cell_id: route.cell_id, tenant_id: tid, stale: route.stale, cached: route.cached };
}

module.exports = {
  DirectoryError, migrate, upsertCell, upsertRoute, setMigrationState, createResolver, issueSession,
  normalizeCode, MIGRATION_STATES, BASE_URL_RE, CELLS_TABLE, ROUTES_TABLE, DIRECTORY_SQL, DEFAULTS,
};
