'use strict';
/* Row 81: the OpenAPI drift gate must be green on the real tree and must turn red on every kind of drift.
   Negative controls run against a temporary copy of the sources, so the real tree is never touched. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'openapi-drift-81.mjs');
let pass = 0; let fail = 0;
const ok = (name, cond, info = '') => { if (cond) { pass++; console.log(`PASS  ${name}${info ? '  → ' + info : ''}`); } else { fail++; console.log(`FAIL  ${name}${info ? '  → ' + info : ''}`); } };

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa81-'));
  fs.mkdirSync(path.join(dir, 'server'));
  for (const f of ['server/index.js', 'server/gateway.js', 'server/tenancy.js', 'openapi.yaml']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  return dir;
}
function run(root) {
  const r = spawnSync(process.execPath, [TOOL, '--root', root], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const edit = (dir, f, fn) => { const p = path.join(dir, f); fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8'))); };

(async () => {
  const lib = await import(TOOL);

  // unit: regex → path
  ok('OA-01 regexToPath numeric id', lib.regexToPath('^\\/api\\/students\\/(\\d+)$') === '/api/students/{id}');
  ok('OA-02 regexToPath collection + id', lib.regexToPath('^\\/api\\/cloud\\/tenancy\\/product\\/([a-z][a-z0-9_]{1,40})\\/(\\d+)$') === '/api/cloud/tenancy/product/{collection}/{id}');
  ok('OA-03 regexToPath file', lib.regexToPath('^\\/api\\/admin\\/backups\\/daily\\/([A-Za-z0-9._-]+\\.json)$') === '/api/admin/backups/daily/{file}');
  let threw = false; try { lib.regexToPath('^\\/api\\/x\\/(.*)$'); } catch (e) { threw = true; }
  ok('OA-04 unsupported regex is an error, not a silent pass', threw);

  // real tree
  const real = run(ROOT);
  const m = real.out.match(/code_routes=(\d+) spec_operations=(\d+)/);
  ok('OA-10 real tree in sync', real.code === 0 && /OPENAPI-DRIFT-81-OK/.test(real.out), m ? `code=${m[1]} spec=${m[2]}` : real.out.slice(0, 200));
  ok('OA-11 route inventory is not trivially small', m && Number(m[1]) >= 90, m ? m[1] : '-');
  const spec = fs.readFileSync(path.join(ROOT, 'openapi.yaml'), 'utf8');
  for (const must of ['/api/auth/login:', '/api/auth/refresh:', '/api/v1/pull:', '/api/sync:', '/api/live/rev:', '/api/gw/v1/pull:', '/api/gw/v1/push:']) {
    ok('OA-12 native-client operation documented ' + must.slice(0, -1), spec.includes('\n  ' + must + '\n'));
  }
  ok('OA-13 owner platform API delegated, not duplicated', !spec.includes('/api/platform/v1') || /owner-panel\/server\/openapi\.json/.test(spec));

  // negative controls
  let d = sandbox();
  edit(d, 'server/index.js', s => s.replace("  if (p === '/api/me' && m === 'GET') {", "  if (p === '/api/zz/new' && m === 'GET') return json({ ok: true });\n  if (p === '/api/me' && m === 'GET') {"));
  let r = run(d);
  ok('OA-20 new route in code without spec ⇒ FAIL', r.code === 1 && /missing-in-spec GET \/api\/zz\/new/.test(r.out));

  d = sandbox();
  edit(d, 'server/index.js', s => s.replace("if (p === '/api/sync' && m === 'POST')", "if (p === '/api/sync' && m === 'PUT')"));
  r = run(d);
  ok('OA-21 method change in code ⇒ FAIL (missing PUT + stale POST)', r.code === 1 && /missing-in-spec PUT \/api\/sync/.test(r.out) && /stale-in-spec POST \/api\/sync/.test(r.out));

  d = sandbox();
  edit(d, 'server/index.js', s => s.replace("  const sm = p.match(", "  const zm = p.match(/^\\/api\\/zz\\/(\\d+)\\/thing$/);\n  if (zm && m === 'DELETE') return json({ ok: true });\n  const sm = p.match("));
  r = run(d);
  ok('OA-22 new regex route ⇒ FAIL', r.code === 1 && /missing-in-spec DELETE \/api\/zz\/\{id\}\/thing/.test(r.out));

  d = sandbox();
  edit(d, 'openapi.yaml', s => s.replace('\npaths:\n', '\npaths:\n  /api/ghost:\n    get:\n      operationId: getGhost\n      responses:\n        \'200\':\n          description: x\n'));
  r = run(d);
  ok('OA-23 spec operation with no code route ⇒ FAIL (stale)', r.code === 1 && /stale-in-spec GET \/api\/ghost/.test(r.out));

  d = sandbox();
  edit(d, 'openapi.yaml', s => s.replace(/\n {2}\/api\/gw\/v1\/push:\n[\s\S]*?(?=\n {2}\/)/, ''));
  r = run(d);
  ok('OA-24 route removed from spec ⇒ FAIL', r.code === 1 && /missing-in-spec POST \/api\/gw\/v1\/push/.test(r.out));

  d = sandbox();
  edit(d, 'server/tenancy.js', s => s.replace("if (pathname === PBASE + '/join' && m === 'POST')", "if (pathname === PBASE + '/join2' && m === 'POST')"));
  r = run(d);
  ok('OA-25 tenancy route rename ⇒ FAIL', r.code === 1 && /missing-in-spec POST \/api\/cloud\/tenancy\/product\/join2/.test(r.out));

  d = sandbox();
  edit(d, 'openapi.yaml', s => s.replace(/^openapi: .*$/m, 'swagger: "2.0"'));
  r = run(d);
  ok('OA-26 non-OpenAPI-3 document ⇒ input error (exit 2)', r.code === 2);

  d = sandbox();
  edit(d, 'openapi.yaml', s => s.replace('      operationId: getV1Pull\n', ''));
  r = run(d);
  ok('OA-27 operation without operationId ⇒ FAIL', r.code === 1 && /operations-without-operationId=1/.test(r.out));

  console.log(`\nOA checks=${pass + fail} pass=${pass} fail=${fail}`);
  console.log(fail ? 'OPENAPI-DRIFT-81-TEST-FAIL' : 'OPENAPI-DRIFT-81-TEST-OK');
  process.exit(fail ? 1 : 0);
})();
