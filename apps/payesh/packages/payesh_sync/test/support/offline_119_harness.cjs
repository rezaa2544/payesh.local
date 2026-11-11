'use strict';
// Test-only harness for test/offline_119_test.dart (row 119): migrates the real tenancy schema on a
// throwaway PostgreSQL and mints short-lived Gateway tokens with server/tenancy.js.
// Tenant ids are fresh per run, so reruns on the same database never see each other's rows.
// No secret is stored anywhere: SECRET is random per run and passed in by the Dart test.
const crypto = require('node:crypto');
const path = require('node:path');
const ROOT = process.env.PAYESH_REPO_ROOT;
const tenancy = require(path.join(ROOT, 'server/tenancy.js'));
const { Client } = require(require.resolve('pg', { paths: [ROOT] }));
const uuid = () => crypto.randomUUID();
(async () => {
  const c = new Client({ connectionString: process.env.PGURL_ADMIN });
  await c.connect();
  await tenancy.migrate(c);
  await c.end();
  const A = uuid();
  const B = uuid();
  const tok = (tid, did, role = 'manager', uid = 1) => tenancy.signToken(
    { tid, role, uid, did, iat: Date.now(), exp: Date.now() + 3600000 },
    process.env.SECRET,
  );
  process.stdout.write(JSON.stringify({
    tenantA: A,
    tenantB: B,
    A1: tok(A, 'dev-1'),
    A2: tok(A, 'dev-2'),
    B: tok(B, 'dev-b'),
    // parent 9001 of school A; linked to student 501 only (the link row is pushed by the test)
    P: tok(A, 'dev-p', 'parent', 9001),
  }));
})().catch((e) => { console.error((e && e.stack) || e); process.exit(1); });
