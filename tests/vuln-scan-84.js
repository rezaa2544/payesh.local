#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   Row 84 — SBOM + vulnerability gate (tools/osv-scan-84.mjs)

   Offline checks run against OSV answers recorded for the fixture lockfiles
   in tests/fixtures/vuln-84 (a deliberately vulnerable npm + pub dependency
   set). The live checks query https://api.osv.dev for the fixture and for the
   real repository SBOM; they run when OSV is reachable and are mandatory with
   VULN84_REQUIRE_LIVE=1 (CI).

     VS-01  CVSS v3.1 base-score calculator vs FIRST reference vectors
     VS-02  NEGATIVE: vulnerable fixture ⇒ gate red (npm shipped, pub shipped, dev critical)
     VS-03  clean fixture ⇒ gate green
     VS-04  valid exception suppresses exactly its advisory, nothing else
     VS-05  NEGATIVE: expired exception ⇒ finding blocks again
     VS-06  NEGATIVE: malformed exceptions (no owner, short reason, expiry > 90 d) ⇒ red
     VS-07  exception matched through an alias (CVE id)
     VS-08  NEGATIVE: unknown severity counts as HIGH; withdrawn advisories ignored
     VS-09  dev threshold: dev-only HIGH is reported but not blocking
     VS-10  NEGATIVE: OSV unreachable ⇒ exit 2 (fail closed)
     VS-11  stale exception is reported
     VS-12  --expect-fail: 0 on the vulnerable fixture, 1 on the clean one
     VS-13  LIVE: OSV still rejects the vulnerable fixture
     VS-14  LIVE: the real repository SBOM (npm + pub) passes the policy
     VS-15  wiring: CI steps, policy sane, SBOM in the build workflow, doc present
   Last line: VULN-84-OK checks=N | VULN-84-FAILED
   ═══════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools/osv-scan-84.mjs');
const FIX = path.join(ROOT, 'tests/fixtures/vuln-84');
const REC = path.join(FIX, 'osv-recorded.json');
const NOW = '2026-11-11';
const REQUIRE_LIVE = process.env.VULN84_REQUIRE_LIVE === '1';

let pass = 0, fail = 0;
const results = [];
async function check(id, title, fn) {
  try {
    const note = await fn();
    if (note === 'SKIP') { console.log(`SKIP  ${id}  ${title}`); results.push({ id, ok: null }); return; }
    pass++; console.log(`PASS  ${id}  ${title}${note ? '  → ' + note : ''}`); results.push({ id, ok: true });
  } catch (e) {
    fail++; console.log(`FAIL  ${id}  ${title}  → ${e.message}`); results.push({ id, ok: false });
  }
}
function assert(c, m) { if (!c) throw new Error(m); }

function tmp(name, obj) {
  const p = path.join(os.tmpdir(), `vuln84-${process.pid}-${name}`);
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  return p;
}
const basePolicy = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/osv-policy-84.json'), 'utf8'));
function run(args, env = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000 });
  const out = (r.stdout || '') + (r.stderr || '');
  return { code: r.status, out, last: out.trim().split('\n').pop() };
}
const VULN = ['--root', FIX, '--lock', 'npm:package-lock.json', '--lock', 'pub:pubspec.lock'];
const CLEAN = ['--root', FIX, '--lock', 'npm:clean-package-lock.json'];
function offline(args, policy, extra = []) {
  const pol = tmp('policy-' + Math.random().toString(36).slice(2) + '.json', policy || basePolicy());
  const out = tmp('report-' + Math.random().toString(36).slice(2) + '.json', '{}');
  const r = run([...args, '--osv-cache', REC, '--policy', pol, '--now', NOW, '--out', out, ...extra]);
  let report = null; try { report = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (e) { /* none */ }
  return Object.assign(r, { report });
}
async function osvReachable() {
  try { const r = await fetch('https://api.osv.dev/v1/vulns/GHSA-9324-jv53-9cc8', { signal: AbortSignal.timeout(15000) }); return r.ok; } catch (e) { return false; }
}

(async () => {
  const lib = await import(pathToFileURL(TOOL).href);
  console.log(`# row 84 vulnerability gate — node ${process.version} — now=${NOW} — require_live=${REQUIRE_LIVE}`);

  await check('VS-01', 'CVSS v3.1 base score matches FIRST reference vectors', async () => {
    const v = [
      ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 9.8], ['CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N', 6.1],
      ['CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:H/A:H', 7.4], ['CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H', 7.2],
      ['CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H', 8.8], ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H', 10],
      ['CVSS:3.0/AV:P/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N', 1.6], ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N', 0],
    ];
    for (const [vec, want] of v) assert(lib.cvss3Score(vec) === want, `${vec} → ${lib.cvss3Score(vec)} want ${want}`);
    assert(lib.cvss3Score('CVSS:4.0/AV:N') === null && lib.cvss3Score('garbage') === null, 'non-v3 vector must be unscored');
    assert(lib.ratingOf(9.8) === 'critical' && lib.ratingOf(7.0) === 'high' && lib.ratingOf(6.9) === 'medium' && lib.ratingOf(0.1) === 'low', 'rating bands');
    return `${v.length} vectors`;
  });

  let vulnReport = null;
  await check('VS-02', 'NEGATIVE: deliberately vulnerable npm + pub dependencies ⇒ gate red', async () => {
    const r = offline(VULN);
    vulnReport = r.report;
    assert(r.code === 1, `exit ${r.code} (want 1): ${r.last}`);
    assert(/^OSV-84-FAIL/.test(r.last), r.last);
    const b = r.report.findings.filter(f => f.blocking);
    assert(b.some(f => f.purl === 'pkg:npm/lodash@4.17.15' && f.scope === 'shipped'), 'lodash 4.17.15 (npm, shipped) not blocking');
    assert(b.some(f => f.purl === 'pkg:pub/dio@4.0.0' && f.id === 'GHSA-9324-jv53-9cc8'), 'dio 4.0.0 (pub, shipped) not blocking');
    assert(b.some(f => f.purl === 'pkg:npm/minimist@1.2.5' && f.scope === 'dev' && f.severity === 'critical'), 'minimist 1.2.5 (dev, critical) not blocking');
    assert(!r.report.findings.some(f => f.blocking && f.severity === 'medium'), 'a MODERATE advisory blocked');
    assert(!r.report.findings.some(f => f.purl.includes('collection')), 'clean pub package reported');
    return `blocking=${b.length} advisories=${r.report.counts.advisories}`;
  });

  await check('VS-03', 'clean fixture (lodash 4.18.1) ⇒ gate green', async () => {
    const r = offline(CLEAN);
    assert(r.code === 0 && /^OSV-84-OK/.test(r.last), `exit ${r.code}: ${r.last}`);
    return r.last;
  });

  const exc = (o) => Object.assign({ id: 'GHSA-9324-jv53-9cc8', package: 'dio', reason: 'test-only: fixture exception that must suppress exactly one advisory', owner: 'security@payesh (test)', expires: '2026-12-31' }, o);

  await check('VS-04', 'valid exception suppresses exactly its advisory', async () => {
    const p = basePolicy(); p.exceptions = [exc()];
    const r = offline(VULN, p);
    const dio = r.report.findings.find(f => f.id === 'GHSA-9324-jv53-9cc8');
    assert(dio && !dio.blocking && dio.exception.state === 'accepted', 'dio advisory still blocking / not marked accepted');
    assert(r.code === 1, 'gate turned green although lodash/minimist are still vulnerable');
    assert(r.report.counts.blocking === vulnReport.counts.blocking - 1, `blocking ${r.report.counts.blocking} vs ${vulnReport.counts.blocking}`);
    return `accepted=1 remaining_blocking=${r.report.counts.blocking}`;
  });

  await check('VS-05', 'NEGATIVE: expired exception ⇒ finding blocks again', async () => {
    const p = basePolicy(); p.exceptions = [exc({ expires: '2026-11-01' })];
    const r = offline(VULN, p);
    const dio = r.report.findings.find(f => f.id === 'GHSA-9324-jv53-9cc8');
    assert(dio.blocking && dio.exception.state === 'expired', 'expired exception still suppresses');
    assert(r.out.includes('exception=expired'), 'expired state not printed');
    return 'state=expired, blocking';
  });

  await check('VS-06', 'NEGATIVE: malformed exceptions ⇒ OSV-04, gate red', async () => {
    const cases = [[{ owner: undefined }, 'missing owner'], [{ reason: 'because' }, 'reason shorter'], [{ expires: '2027-12-31' }, 'days ahead'], [{ expires: '31/12/2026' }, 'not YYYY-MM-DD']];
    for (const [o, needle] of cases) {
      const e = exc(o); if (o.owner === undefined && 'owner' in o) delete e.owner;
      const p = basePolicy(); p.exceptions = [e];
      const r = offline(CLEAN, p);
      assert(r.code === 1, `${needle}: exit ${r.code}`);
      assert(r.out.includes('OSV-04') && r.out.includes(needle), `${needle}: no OSV-04 line`);
    }
    const p = basePolicy(); p.fail_at.shipped = 'severe';
    assert(offline(CLEAN, p).code === 1, 'unknown threshold accepted');
    return `${cases.length + 1} malformed policies rejected`;
  });

  await check('VS-07', 'exception matched through an alias (CVE-2021-31402)', async () => {
    const p = basePolicy(); p.exceptions = [exc({ id: 'CVE-2021-31402' })];
    const r = offline(VULN, p);
    const dio = r.report.findings.find(f => f.id === 'GHSA-9324-jv53-9cc8');
    assert(!dio.blocking && dio.exception.id === 'CVE-2021-31402', 'alias did not match');
    const p2 = basePolicy(); p2.exceptions = [exc({ package: 'http' })];
    const r2 = offline(VULN, p2);
    assert(r2.report.findings.find(f => f.id === 'GHSA-9324-jv53-9cc8').blocking, 'exception for another package suppressed dio');
    return 'alias ok; wrong package ignored';
  });

  await check('VS-08', 'NEGATIVE: unknown severity ⇒ treated as HIGH (OSV-03); withdrawn ignored', async () => {
    const rec = JSON.parse(fs.readFileSync(REC, 'utf8'));
    rec.query['pkg:npm/lodash@4.18.1'] = ['TEST-UNSCORED-1', 'TEST-WITHDRAWN-1'];
    rec.vulns['TEST-UNSCORED-1'] = { id: 'TEST-UNSCORED-1', summary: 'synthetic advisory without any severity', affected: [] };
    rec.vulns['TEST-WITHDRAWN-1'] = { id: 'TEST-WITHDRAWN-1', withdrawn: '2026-01-01T00:00:00Z', database_specific: { severity: 'CRITICAL' } };
    const cache = tmp('rec-unknown.json', rec);
    const pol = tmp('pol-unknown.json', basePolicy());
    const r = run([...CLEAN, '--osv-cache', cache, '--policy', pol, '--now', NOW]);
    assert(r.code === 1 && r.out.includes('OSV-03') && r.out.includes('TEST-UNSCORED-1'), `unknown severity did not block: ${r.last}`);
    assert(!r.out.includes('TEST-WITHDRAWN-1'), 'withdrawn advisory reported');
    return 'unknown→high blocks; withdrawn skipped';
  });

  await check('VS-09', 'dev-only HIGH is reported but does not block (threshold CRITICAL)', async () => {
    const lib2 = lib;
    const sbom = { bomFormat: 'CycloneDX', components: [{ name: 'lodash', version: '4.17.15', purl: 'pkg:npm/lodash@4.17.15', scope: 'excluded' }] };
    const r = await lib2.scan({ sbom, policy: basePolicy(), client: lib2.cacheClient(JSON.parse(fs.readFileSync(REC, 'utf8'))), now: new Date(NOW) });
    assert(r.ok && r.findings.length === 5 && r.findings.every(f => !f.blocking && f.scope === 'dev'), JSON.stringify(r.counts));
    const p = basePolicy(); p.fail_at.dev = 'high';
    const r2 = await lib2.scan({ sbom, policy: p, client: lib2.cacheClient(JSON.parse(fs.readFileSync(REC, 'utf8'))), now: new Date(NOW) });
    assert(!r2.ok, 'stricter dev threshold did not block');
    return 'dev HIGH: note at critical threshold, blocks at high';
  });

  await check('VS-10', 'NEGATIVE: OSV unreachable ⇒ exit 2 (fail closed)', async () => {
    const r = run([...CLEAN, '--now', NOW], { OSV_API: 'http://127.0.0.1:9' });
    assert(r.code === 2 && /^OSV-84-ERROR/.test(r.last), `exit ${r.code}: ${r.last}`);
    return r.last.slice(0, 90);
  });

  await check('VS-11', 'stale exception is reported', async () => {
    const p = basePolicy(); p.exceptions = [exc({ id: 'GHSA-0000-0000-0000', package: 'nothing' })];
    const r = offline(CLEAN, p);
    assert(r.code === 0 && r.out.includes('STALE exception GHSA-0000-0000-0000'), r.out.slice(-300));
    return 'STALE line printed';
  });

  await check('VS-12', '--expect-fail: 0 on vulnerable fixture, 1 on clean fixture', async () => {
    const a = offline(VULN, null, ['--expect-fail']);
    const b = offline(CLEAN, null, ['--expect-fail']);
    assert(a.code === 0 && a.out.includes('OSV-84-NEGATIVE-CONTROL-OK'), `vulnerable: ${a.code}`);
    assert(b.code === 1 && b.out.includes('OSV-84-NEGATIVE-CONTROL-FAILED'), `clean: ${b.code}`);
    return 'ok';
  });

  const live = await osvReachable();
  await check('VS-13', 'LIVE: api.osv.dev rejects the deliberately vulnerable fixture', async () => {
    if (!live) { if (REQUIRE_LIVE) throw new Error('OSV unreachable and VULN84_REQUIRE_LIVE=1'); return 'SKIP'; }
    const r = run([...VULN, '--expect-fail']);
    assert(r.code === 0 && r.out.includes('OSV-84-NEGATIVE-CONTROL-OK'), `exit ${r.code}: ${r.last}`);
    return (r.out.match(/OSV-84-FAIL[^\n]*/) || [''])[0];
  });

  await check('VS-14', 'LIVE: the real repository SBOM (npm + pub) passes the policy', async () => {
    if (!live) { if (REQUIRE_LIVE) throw new Error('OSV unreachable and VULN84_REQUIRE_LIVE=1'); return 'SKIP'; }
    const out = process.env.VULN84_REPORT || path.join(os.tmpdir(), `vuln84-${process.pid}-repo.json`);
    const r = run(['--root', ROOT, '--out', out]);
    assert(r.code === 0 && /^OSV-84-OK/.test(r.last), `exit ${r.code}: ${r.out.slice(-600)}`);
    const rep = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert(rep.counts.queried >= 150, `only ${rep.counts.queried} components queried`);
    assert(rep.findings.length === 0 || rep.findings.every(f => !f.blocking), 'blocking finding in a green report');
    return r.last;
  });

  await check('VS-15', 'wiring: CI runs SBOM + OSV + negative control; policy sane; doc present', async () => {
    const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/release-gate.yml'), 'utf8');
    assert(wf.includes('tools/osv-scan-84.mjs --sbom') && wf.includes('--expect-fail') && wf.includes('tests/vuln-scan-84.js'), 'release-gate.yml lacks the row-84 steps');
    const bw = fs.readFileSync(path.join(ROOT, '.github/workflows/build.yml'), 'utf8');
    assert(bw.includes('tools/sbom-95.mjs') && bw.includes('tools/osv-scan-84.mjs'), 'build.yml does not produce an SBOM + scan per build');
    const p = basePolicy();
    assert(p.fail_at.shipped === 'high' && ['high', 'critical'].includes(p.fail_at.dev) && p.unknown_severity === 'high', 'policy thresholds weakened');
    assert(p.max_exception_days <= 90, 'max_exception_days > 90');
    const { errors } = lib.checkPolicy(p, Date.parse(NOW));
    assert(errors.length === 0, errors.join('; '));
    const doc = fs.readFileSync(path.join(ROOT, 'docs/security/84-sbom-vuln-scan.md'), 'utf8');
    assert(doc.includes('osv-policy-84.json') && doc.includes('expires'), 'doc does not explain exceptions');
    const allow = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/deps-allowlist.json'), 'utf8'));
    assert((allow.entries || []).every(e => e.reason && e.expires), 'row-48 allowlist entry without reason/expiry');
    return `exceptions=${p.exceptions.length} allowlist48=${(allow.entries || []).length}`;
  });

  const skipped = results.filter(r => r.ok === null).length;
  console.log(`checks=${pass + fail} pass=${pass} fail=${fail} skipped=${skipped}`);
  console.log(fail ? 'VULN-84-FAILED' : `VULN-84-OK checks=${pass}${skipped ? ' (live skipped)' : ''}`);
  process.exit(fail ? 1 : 0);
})();
