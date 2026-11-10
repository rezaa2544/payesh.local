'use strict';
// Test-only harness for test/gateway_it_test.dart (row 75): migrates the real tenancy schema
// on a throwaway PostgreSQL and mints short-lived Gateway tokens with server/tenancy.js.
// No secret is stored anywhere: SECRET is random per run and passed in by the Dart test.
const path = require('node:path');
const ROOT = process.env.PAYESH_REPO_ROOT;
const tenancy = require(path.join(ROOT, 'server/tenancy.js'));
const { Client } = require(require.resolve('pg', { paths: [ROOT] }));
const A = '11111111-1111-1111-1111-111111111175';
const B = '22222222-2222-2222-2222-222222222275';
(async () => {
  const c = new Client({ connectionString: process.env.PGURL_ADMIN });
  await c.connect();
  await tenancy.migrate(c);
  await c.end();
  const tok = (tid, did, ms = 3600000) => tenancy.signToken(
    { tid, role: 'manager', uid: 'u-' + tid.slice(0, 4), did, iat: Date.now(), exp: Date.now() + ms },
    process.env.SECRET,
  );
  process.stdout.write(JSON.stringify({ A: tok(A, 'dev-a'), B: tok(B, 'dev-b') }));
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
