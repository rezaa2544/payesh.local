// Row 128 — the parity matrix is complete and honest, and every rule turns red when broken.
// Real repository first (must pass), then in-memory mutations (each must be caught with its code).
'use strict';
const path = require('node:path');

(async () => {
  const root = path.join(__dirname, '..');
  const m = await import(path.join(root, 'tools', 'parity-128.mjs'));
  const base = m.loadRepo(root);
  const matrix = JSON.parse(base.read(m.MATRIX));
  let failures = 0;
  const ok = (id, cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${id}  ${msg}`); if (!cond) failures++; };

  const real = m.check(matrix, base.read, base.exists);
  for (const f of real.failures) console.log('  ' + f);
  ok('PM-01', real.failures.length === 0, `real repository passes (${real.items} items, web surface ${real.web})`);
  ok('PM-02', real.web === real.items, 'every web item is mapped once and nothing else');
  const web = m.extract(base.read);
  ok('PM-03', ['page:users', 'page:schedule', 'act:import-apply', 'form:bells', 'act:diag-fix', 'page:health', 'page:scan'].every((i) => web.has(i)),
    'extraction sees pages, nav-only routes, schedule/import/diag actions and forms');
  const native = matrix.items.filter((i) => i.status === 'native');
  ok('PM-04', native.every((i) => (i.tests || []).length > 0), `every native item names a test (${native.length})`);

  // ---- mutations ----
  const clone = () => JSON.parse(JSON.stringify(matrix));
  const readWith = (file, fn) => (p) => (p === file ? fn(base.read(p)) : base.read(p));
  const MUT = [
    ['MU-01', 'new web page without a matrix row', 'P-01', () => [clone(), readWith('client/pages.js', (s) => s + "\nPAGES.homework = () => '';\n")]],
    ['MU-02', 'new click action without a matrix row', 'P-01', () => [clone(), readWith('client/app.js', (s) => s.replace("case 'retry':", "case 'homework-add': return;\n    case 'retry':"))]],
    ['MU-03', 'new schedule form without a matrix row', 'P-01', () => [clone(), readWith('client/schedule.js', (s) => s.replace('const SCHED_FORMS = {', "const SCHED_FORMS = {\n  'exam': () => {},"))]],
    ['MU-04', 'matrix row whose web source was deleted', 'P-02', () => { const x = clone(); x.items.push({ id: 'act:ghost', status: 'ui', reason_fa: 'x' }); return [x, base.read]; }],
    ['MU-05', 'duplicate matrix row', 'P-03', () => { const x = clone(); x.items.push(Object.assign({}, x.items[0])); return [x, base.read]; }],
    ['MU-06', 'unknown status', 'P-03', () => { const x = clone(); x.items[0].status = 'done'; return [x, base.read]; }],
    ['MU-07', 'native anchor that does not exist', 'P-04', () => { const x = clone(); const n = x.items.find((i) => i.status === 'native'); n.native[0].has = 'Key(\'no-such-key'; return [x, base.read]; }],
    ['MU-08', 'native without a test', 'P-05', () => { const x = clone(); x.items.find((i) => i.status === 'native').tests = []; return [x, base.read]; }],
    ['MU-09', 'test anchor removed from the test file', 'P-05', () => [clone(), readWith('apps/payesh/app/test/attendance_wave2_test.dart', (s) => s.split("'W2-W01").join("'W2-X01"))]],
    ['MU-10', 'retired without a replacement', 'P-06', () => { const x = clone(); x.items.find((i) => i.status === 'retired').replacement = ''; return [x, base.read]; }],
    ['MU-11', 'retired without a reason', 'P-06', () => { const x = clone(); x.items.find((i) => i.status === 'retired').reason_fa = ' '; return [x, base.read]; }],
    ['MU-12', 'planned with an undeclared wave', 'P-07', () => { const x = clone(); const p = x.items.find((i) => i.status === 'planned'); if (p) p.wave = 'W99'; else x.items[0] = Object.assign(x.items[0], { status: 'planned', wave: 'W99' }); return [x, base.read]; }],
    ['MU-13', 'ui item without a reason', 'P-03', () => { const x = clone(); x.items.find((i) => i.status === 'ui').reason_fa = ''; return [x, base.read]; }],
    ['MU-14', 'needed capability silently dropped to «ui»', 'P-01', () => { const x = clone(); x.items = x.items.filter((i) => i.id !== 'page:users'); return [x, base.read]; }],
  ];
  let killed = 0;
  for (const [id, what, code, make] of MUT) {
    const [mx, rd] = make();
    let r;
    try { r = m.check(mx, rd, base.exists); } catch (e) { r = { failures: ['THROW ' + e.message] }; }
    const hit = r.failures.find((f) => f.startsWith(code));
    ok(id, !!hit, `${what} → ${hit || 'NOT CAUGHT (' + (r.failures[0] || 'no failure') + ')'}`);
    if (hit) killed++;
  }
  // P-08: the final gate refuses while anything is planned; passes once nothing is
  const planned = matrix.items.filter((i) => i.status === 'planned').length;
  const fin = m.check(matrix, base.read, base.exists, { final: true });
  ok('MU-15', planned === 0 ? fin.failures.length === 0 : fin.failures.some((f) => f.startsWith('P-08')),
    `--final with ${planned} planned → ${planned ? 'refused (P-08)' : 'passes'}`);
  if (planned === 0 || fin.failures.some((f) => f.startsWith('P-08'))) killed++;

  console.log(failures ? `PARITY-128-TEST-FAILED failures=${failures}` : `PARITY-128-TEST-OK checks=4 mutations=${killed}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); console.log('PARITY-128-TEST-FAILED failures=1'); process.exit(1); });
