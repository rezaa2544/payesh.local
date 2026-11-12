'use strict';
// Test-only harness for test/school_access_it_test.dart (row 74, wave 1). Uses the REAL server
// modules on a throwaway PostgreSQL:
//   setup  — migrates tenancy + Directory, provisions a school (manager + one-time code) through
//            server/school-access.js, registers a cell (base_url = GW_URL) and three routes:
//            the school (stable), a "moving" school (migrating) and one on a disabled cell.
//   issue  — the manager issues a NEW one-time code (TENANT) via issueActivation.
// Slugs/tenants are fresh per run. Codes go to stdout for the test only; nothing is stored.
const crypto = require('node:crypto');
const path = require('node:path');
const ROOT = process.env.PAYESH_REPO_ROOT;
const tenancy = require(path.join(ROOT, 'server/tenancy.js'));
const directory = require(path.join(ROOT, 'server/directory.js'));
const access = require(path.join(ROOT, 'server/school-access.js'));
const { Pool } = require(require.resolve('pg', { paths: [ROOT] }));

(async () => {
  const pool = new Pool({ connectionString: process.env.PGURL_ADMIN, max: 2 });
  try {
    if (process.argv[2] === 'issue') {
      const r = await access.issueActivation(pool, { role: 'manager', tid: process.env.TENANT, uid: 1 }, { uid: 1 });
      process.stdout.write(JSON.stringify({ code: r.activation_code }));
      return;
    }
    const c = await pool.connect();
    try { await tenancy.migrate(c); await directory.migrate(c); } finally { c.release(); }
    const tid = crypto.randomUUID();
    const tag = crypto.randomBytes(3).toString('hex');
    const slug = 'alborz-' + tag;
    const p = await access.provisionSchool(pool, { tenantId: tid, slug, managerName: 'مدیر البرز' });
    const cell = crypto.randomUUID();
    const dead = crypto.randomUUID();
    await directory.upsertCell(pool, { cellId: cell, name: 'cell-74', baseUrl: process.env.GW_URL });
    await directory.upsertCell(pool, { cellId: dead, name: 'cell-74-off', status: 'disabled', baseUrl: process.env.GW_URL });
    await directory.upsertRoute(pool, { schoolCode: slug, cellId: cell });
    await directory.upsertRoute(pool, { schoolCode: 'moving-' + tag, cellId: cell, migrationState: 'migrating' });
    await directory.upsertRoute(pool, { schoolCode: 'offline-' + tag, cellId: dead });
    process.stdout.write(JSON.stringify({
      tenant: tid, slug, code: p.activation_code, moving: 'moving-' + tag, offline: 'offline-' + tag,
    }));
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error((e && e.stack) || e); process.exit(1); });
