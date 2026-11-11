'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۸۹ — دروازهٔ «هیچ شاهدی بدون SHA» + کنترل‌های منفی

   ES-01      مخزن واقعی: همهٔ شواهد SHA معتبر دارند (tools/evidence-sha-89.mjs --check)
   ES-02..11  مخزن git موقت: هر نوع خرابی باید دروازه را قرمز کند و حالت سالم سبز بماند
   ES-12      backfill بدنه را بایت‌به‌بایت حفظ می‌کند (حتی UTF-8 بریده)
   ES-13..14  ابزار T2 (tools/t2-measure.mjs): محلی فقط [S]، دور بدون تأیید مالک [?]؛ اندازه‌گیری واقعی محلی اگر PG باشد
   ES-15      شاهد ci-negative-proof-57.txt: کنترل منفی نشت ۵۷ واقعاً در CI قرمز شد
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools/evidence-sha-89.mjs');
const EV = 'docs/cloud/reports/evidence';
let passed = 0, failed = 0;
const failures = [];
function assert(c, m) { if (!c) throw new Error(m); }
function check(id, desc, fn) {
  try { const d = fn(); passed++; console.log(`PASS  ${id}  ${desc}${d === undefined ? '' : '  → ' + d}`); }
  catch (e) { failed++; failures.push(id); console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e).slice(0, 400)}`); }
}
function run(args, opts = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', ...opts });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const G = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

function tmpRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-es89-'));
  G(d, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(d, EV), { recursive: true });
  fs.writeFileSync(path.join(d, 'README'), 'x\n');
  G(d, 'add', '-A'); G(d, ...ID, 'commit', '-qm', 'init');
  return d;
}
function commitAll(d, msg) { G(d, 'add', '-A'); G(d, ...ID, 'commit', '-qm', msg); return G(d, 'rev-parse', 'HEAD'); }
const write = (d, rel, body) => fs.writeFileSync(path.join(d, EV, rel), body);
const hdr = (sha) => `base_sha=${sha}\ndate_utc=2026-11-11T00:00:00Z\ncommand=node x\n\nPASS ok\n`;
function expectRed(d, needle, extra = []) {
  const r = run(['--check', '--root', d, ...extra]);
  assert(r.code !== 0, 'gate stayed green: ' + r.out.slice(-300));
  assert(r.out.includes(needle), `expected "${needle}" in: ${r.out.slice(-400)}`);
  return 'red: ' + needle;
}
function expectGreen(d, extra = []) {
  const r = run(['--check', '--root', d, ...extra]);
  assert(r.code === 0 && /EVIDENCE-SHA-89-OK/.test(r.out), 'gate red: ' + r.out.slice(-400));
  return r.out.trim().split('\n').pop();
}

const temps = [];
try {
  check('ES-01', 'real repository: every evidence file carries a resolvable base SHA (txt header / log commit_sha / index / sha-map)', () => {
    const r = run(['--check']);
    assert(r.code === 0, r.out.slice(-1500));
    return r.out.trim().split('\n').pop();
  });

  const d = tmpRepo(); temps.push(d);
  const c0 = G(d, 'rev-parse', 'HEAD');

  check('ES-02', 'healthy temp repo with one valid txt is green', () => { write(d, 'ok.txt', hdr(c0)); commitAll(d, 'ok'); return expectGreen(d); });
  check('ES-03', 'NEGATIVE: txt without base_sha= is rejected', () => { write(d, 'nosha.txt', 'PASS something\n'); commitAll(d, 'nosha'); return expectRed(d, 'expected exactly one base_sha'); });
  check('ES-04', 'NEGATIVE: short base_sha is rejected', () => { write(d, 'nosha.txt', hdr(c0.slice(0, 7))); commitAll(d, 'short'); return expectRed(d, '40-character'); });
  check('ES-05', 'NEGATIVE: well-formed SHA that is not a commit here (rebased/local) and not mapped is rejected', () => {
    write(d, 'nosha.txt', hdr('1'.repeat(40))); commitAll(d, 'ghost'); return expectRed(d, 'is not a commit in this repository and is not mapped');
  });
  check('ES-06', 'sha-map old→new (new = real ancestor commit) makes the ghost SHA acceptable', () => {
    write(d, 'sha-map.json', JSON.stringify({ version: 1, entries: [{ old: '1'.repeat(40), new: c0, kind: 'test' }] }));
    commitAll(d, 'map'); return expectGreen(d);
  });
  check('ES-07', 'NEGATIVE: sha-map whose new SHA is not a commit is rejected', () => {
    write(d, 'sha-map.json', JSON.stringify({ version: 1, entries: [{ old: '1'.repeat(40), new: '2'.repeat(40), kind: 'test' }] }));
    commitAll(d, 'badmap'); return expectRed(d, 'is not a commit in this repository');
  });
  check('ES-08', 'NEGATIVE: .log without a 40-hex commit SHA is rejected', () => {
    write(d, 'sha-map.json', JSON.stringify({ version: 1, entries: [{ old: '1'.repeat(40), new: c0, kind: 'test' }] }));
    write(d, 'run.log', '# METADATA\n# commit_sha: deadbeef\nok\n'); commitAll(d, 'log'); const r = expectRed(d, 'no 40-hex commit SHA');
    write(d, 'run.log', `# METADATA\n# commit_sha: ${c0}\nok\n`); commitAll(d, 'log-fix'); expectGreen(d); return r;
  });
  check('ES-09', 'NEGATIVE: .json without base_sha and without an index row is rejected; --index fixes it', () => {
    write(d, 'bench.json', '{"x":1}\n'); commitAll(d, 'json'); const r = expectRed(d, 'no row in');
    const ix = run(['--index', '--root', d]); assert(ix.code === 0, ix.out);
    commitAll(d, 'index'); expectGreen(d); return r;
  });
  check('ES-10', 'NEGATIVE: stale index row for a deleted file is rejected', () => {
    fs.rmSync(path.join(d, EV, 'bench.json')); commitAll(d, 'rm'); return expectRed(d, 'stale row');
  });
  check('ES-11', 'NEGATIVE: a shallow clone fails closed (SHA resolution needs full history) unless --allow-shallow', () => {
    run(['--index', '--root', d]); commitAll(d, 'reindex'); expectGreen(d);
    const s = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-es89s-')); temps.push(s);
    G(os.tmpdir(), 'clone', '-q', '--depth', '1', 'file://' + d, s);
    const r = expectRed(s, 'repository is shallow');
    const ok = run(['--check', '--root', s, '--allow-shallow']);
    assert(ok.code === 0, 'allow-shallow: ' + ok.out.slice(-300));
    return r;
  });
  check('ES-12', 'backfill: header = commit that first added the file; body byte-identical (incl. a truncated UTF-8 sequence)', () => {
    const e = tmpRepo(); temps.push(e);
    const body = Buffer.concat([Buffer.from('PASS  N7  gate rejected → ه', 'utf8'), Buffer.from([0xd9]), Buffer.from('\nPASS end\n')]);
    fs.writeFileSync(path.join(e, EV, 'old.txt'), body);
    const add = commitAll(e, 'old evidence');
    expectRed(e, 'expected exactly one base_sha');
    const b = run(['--backfill', '--root', e]); assert(/backfilled_txt=1/.test(b.out), b.out);
    const now = fs.readFileSync(path.join(e, EV, 'old.txt'));
    const parts = now.toString('latin1').split('\n');
    assert(parts[0] === `base_sha=${add}`, 'sha: ' + parts[0]);
    assert(Buffer.from(parts.slice(3).join('\n'), 'latin1').equals(body), 'body changed');
    commitAll(e, 'backfill'); return expectGreen(e);
  });

  const T2 = path.join(ROOT, 'tools/t2-measure.mjs');
  check('ES-13', 'T2 tool + runbook exist; local target refused without --allow-local, tagged [S] with it; remote without owner confirmation is [?], never [M]', () => {
    assert(fs.existsSync(T2) && fs.existsSync(path.join(ROOT, 'docs/cloud/T2-runbook.md')), 'missing tool or runbook');
    const env = (u) => Object.assign({}, process.env, { DATABASE_URL: u });
    const a = spawnSync(process.execPath, [T2, '--dry-run'], { encoding: 'utf8', env: env('postgres://u@127.0.0.1:5432/x') });
    assert(a.status !== 0 && /refused/.test(a.stdout + a.stderr), 'local accepted without --allow-local');
    const b = spawnSync(process.execPath, [T2, '--dry-run', '--allow-local'], { encoding: 'utf8', env: env('postgres://u@127.0.0.1:5432/x') });
    assert(b.status === 0 && /tag=\[S\]/.test(b.stdout) && /database_contacted=false/.test(b.stdout), b.stdout + b.stderr);
    const c = spawnSync(process.execPath, [T2, '--dry-run', '--json'], { encoding: 'utf8', env: env('postgres://u@db.example.com:5432/x') });
    const j = JSON.parse(c.stdout);
    assert(j.evidence_tag === '?' && j.database_contacted === false, c.stdout);
    return 'local=[S] remote=[?] dry-run never contacts';
  });
  check('ES-14', 'T2 tool really measures a local PostgreSQL as [S] (skipped without PAYESH_PG_ADMIN)', () => {
    const url = process.env.PAYESH_PG_ADMIN;
    if (!url) return 'SKIP (no PAYESH_PG_ADMIN)';
    const r = spawnSync(process.execPath, [T2, '--allow-local', '--json'], { encoding: 'utf8', env: Object.assign({}, process.env, { DATABASE_URL: url }) });
    assert(r.status === 0, r.stdout + r.stderr);
    const j = JSON.parse(r.stdout);
    assert(j.evidence_tag === 'S' && Number.isFinite(j.database_size_bytes) && Array.isArray(j.relations), JSON.stringify(j).slice(0, 300));
    return `tag=[S] db_bytes=${j.database_size_bytes} relations=${j.relations.length}`;
  });
  check('ES-15', 'ci-negative-proof-57.txt: header OK, cites a CI run, shows PULL-LEAK-57-FAILED + NEGATIVE-LEAK-CONTROL-OK', () => {
    const p = path.join(ROOT, EV, 'ci-negative-proof-57.txt');
    const t = fs.readFileSync(p, 'utf8');
    assert(/^base_sha=[0-9a-f]{40}$/m.test(t.split('\n').slice(0, 8).join('\n')), 'header');
    assert(/run_id=\d+/.test(t) && /job_id=\d+/.test(t), 'run/job ids');
    assert(t.includes('PULL-LEAK-57-FAILED') && t.includes('NEGATIVE-LEAK-CONTROL-OK'), 'negative proof lines');
    return 'ok';
  });
} finally {
  for (const t of temps) { try { fs.rmSync(t, { recursive: true, force: true }); } catch (e) { /* */ } }
}
console.log(`\n# passed=${passed} failed=${failed}`);
if (failed) { console.log('EVIDENCE-SHA-89-TESTS-FAILED ' + failures.join(',')); process.exit(1); }
console.log('EVIDENCE-SHA-89-TESTS-OK');
