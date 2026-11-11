#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   Vulnerability gate — row 84 (SBOM + OSV scan in CI)

   Reads the CycloneDX SBOM that tools/sbom-95.mjs builds from the release
   lockfiles (package-lock.json + apps/payesh/pubspec.lock — npm AND pub, so
   the Dart/Flutter client is covered too, which `npm audit` cannot see),
   asks the OSV database (https://api.osv.dev, the same source osv-scanner
   uses) about every registry component, and fails closed:

     OSV-01  a shipped component (scope=required) has an advisory at or above
             policy.fail_at.shipped (default HIGH)
     OSV-02  a dev/CI-only component (scope=excluded) has an advisory at or
             above policy.fail_at.dev (default CRITICAL)
     OSV-03  an advisory's severity cannot be determined → treated as
             policy.unknown_severity (default HIGH) — never silently ignored
     OSV-04  an exception is malformed (missing id/package/reason/expires/
             owner, reason too short, expiry too far in the future)
     OSV-05  OSV cannot be reached / answers garbage → exit 2 (fail closed)

   Exceptions live in tools/osv-policy-84.json. Each one names ONE advisory
   (GHSA/CVE/OSV id or alias) for ONE package, with a reason, an owner and an
   expiry date at most policy.max_exception_days ahead. An expired exception
   stops suppressing its finding. An exception that matches nothing is
   reported as STALE so the list cannot rot.

   Usage:
     node tools/osv-scan-84.mjs [--root DIR] [--sbom FILE] [--lock npm:PATH] [--lock pub:PATH]
                                [--policy FILE] [--out REPORT.json] [--now YYYY-MM-DD]
                                [--osv-cache FILE] [--record FILE] [--expect-fail]
   --osv-cache  answer from a recorded OSV response file instead of the network
                (offline unit tests); --record writes such a file from a live run.
   --expect-fail  negative control: exit 0 only when the gate FAILS with ≥1 finding.
   Last line: OSV-84-OK … | OSV-84-FAIL … | OSV-84-ERROR …
   ═══════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildSbom, DEFAULT_LOCKS } from './sbom-95.mjs';

export const OSV_API = process.env.OSV_API || 'https://api.osv.dev';
export const LEVELS = ['none', 'low', 'medium', 'high', 'critical'];
const rank = s => LEVELS.indexOf(String(s || '').toLowerCase());

export const DEFAULT_POLICY = {
  fail_at: { shipped: 'high', dev: 'critical' },
  unknown_severity: 'high',
  max_exception_days: 90,
  exceptions: [],
};

/* ── CVSS v3.x base score (FIRST spec §7.1, with the 3.1 Roundup) ─────── */
const W = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }, AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 }, CIA: { H: 0.56, L: 0.22, N: 0 },
};
function roundup(x) {
  const i = Math.round(x * 100000);
  return i % 10000 === 0 ? i / 100000 : (Math.floor(i / 10000) + 1) / 10;
}
export function cvss3Score(vector) {
  const m = {};
  for (const part of String(vector || '').split('/')) { const [k, v] = part.split(':'); if (k && v) m[k] = v; }
  if (!/^CVSS:3\.[01]$/.test(`CVSS:${m.CVSS}`)) return null;
  const changed = m.S === 'C';
  const PR = { N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 }[m.PR];
  const AV = W.AV[m.AV], AC = W.AC[m.AC], UI = W.UI[m.UI], C = W.CIA[m.C], I = W.CIA[m.I], A = W.CIA[m.A];
  if ([PR, AV, AC, UI, C, I, A].some(x => x === undefined) || !['U', 'C'].includes(m.S)) return null;
  const iss = 1 - (1 - C) * (1 - I) * (1 - A);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
  const expl = 8.22 * AV * AC * PR * UI;
  if (impact <= 0) return 0;
  return roundup(Math.min((changed ? 1.08 : 1) * (impact + expl), 10));
}
export function ratingOf(score) {
  if (score === null || score === undefined || Number.isNaN(score)) return null;
  if (score === 0) return 'none';
  if (score < 4) return 'low';
  if (score < 7) return 'medium';
  if (score < 9) return 'high';
  return 'critical';
}

/* GHSA's curated label first (it is what npm audit shows), then the highest
   CVSS v3 vector we can score. CVSS v4-only / unscored → null (= unknown). */
export function severityOf(vuln) {
  const ds = vuln && vuln.database_specific && vuln.database_specific.severity;
  const map = { CRITICAL: 'critical', HIGH: 'high', MODERATE: 'medium', MEDIUM: 'medium', LOW: 'low' };
  if (ds && map[String(ds).toUpperCase()]) return { level: map[String(ds).toUpperCase()], source: 'database_specific' };
  let best = null;
  for (const s of (vuln && vuln.severity) || []) {
    if (s.type !== 'CVSS_V3') continue;
    const sc = cvss3Score(s.score);
    if (sc !== null && (best === null || sc > best)) best = sc;
  }
  for (const a of (vuln && vuln.affected) || []) {
    const es = a.ecosystem_specific && a.ecosystem_specific.severity;
    if (best === null && es && map[String(es).toUpperCase()]) return { level: map[String(es).toUpperCase()], source: 'ecosystem_specific' };
  }
  return best === null ? { level: null, source: 'none' } : { level: ratingOf(best), source: `cvss3=${best}` };
}

/* ── OSV client (live or recorded) ───────────────────────────────────── */
export function queryable(c) {
  /* only registry packages: path/sdk/git pub deps and the like are not in OSV */
  return /^pkg:(npm|pub)\/[^?]+@[^?]+$/.test(c.purl);
}

async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`OSV ${url} → HTTP ${r.status}`);
  return r.json();
}
async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`OSV ${url} → HTTP ${r.status}`);
  return r.json();
}

export function cacheClient(cache) {
  return {
    async batch(purls) { return purls.map(p => (cache.query && cache.query[p]) || []); },
    async vuln(id) { const v = cache.vulns && cache.vulns[id]; if (!v) throw new Error(`recorded OSV cache has no ${id}`); return v; },
  };
}
export function liveClient(api = OSV_API, recorder = null) {
  return {
    async batch(purls) {
      const out = [];
      for (let i = 0; i < purls.length; i += 500) {
        const chunk = purls.slice(i, i + 500);
        const res = await postJson(`${api}/v1/querybatch`, { queries: chunk.map(purl => ({ package: { purl } })) });
        if (!res || !Array.isArray(res.results) || res.results.length !== chunk.length) throw new Error('OSV querybatch: malformed answer');
        res.results.forEach((r, j) => {
          if (r && r.next_page_token) throw new Error(`OSV querybatch: paginated answer for ${chunk[j]} (too many advisories) — refuse to truncate`);
          const ids = ((r && r.vulns) || []).map(v => v.id);
          if (recorder) recorder.query[chunk[j]] = ids;
          out.push(ids);
        });
      }
      return out;
    },
    async vuln(id) {
      const v = await getJson(`${api}/v1/vulns/${encodeURIComponent(id)}`);
      if (!v || v.id !== id) throw new Error(`OSV vuln ${id}: malformed answer`);
      if (recorder) recorder.vulns[id] = v;
      return v;
    },
  };
}

/* ── policy ──────────────────────────────────────────────────────────── */
const DAY = 86400000;
export function checkPolicy(policy, nowMs) {
  const errors = [];
  const p = Object.assign({}, DEFAULT_POLICY, policy || {});
  p.fail_at = Object.assign({}, DEFAULT_POLICY.fail_at, (policy && policy.fail_at) || {});
  for (const k of ['shipped', 'dev']) if (rank(p.fail_at[k]) < 1) errors.push(`OSV-04 policy.fail_at.${k}="${p.fail_at[k]}" is not one of low|medium|high|critical`);
  if (rank(p.unknown_severity) < 1) errors.push(`OSV-04 policy.unknown_severity="${p.unknown_severity}" is not one of low|medium|high|critical`);
  if (!Array.isArray(p.exceptions)) { errors.push('OSV-04 policy.exceptions is not a list'); p.exceptions = []; }
  p.exceptions.forEach((e, i) => {
    const tag = `exception[${i}] ${e && e.id ? e.id : '?'}`;
    if (!e || typeof e !== 'object') { errors.push(`OSV-04 ${tag}: not an object`); return; }
    for (const f of ['id', 'package', 'reason', 'expires', 'owner']) if (!e[f] || typeof e[f] !== 'string') errors.push(`OSV-04 ${tag}: missing ${f}`);
    if (e.reason && e.reason.trim().length < 20) errors.push(`OSV-04 ${tag}: reason shorter than 20 characters`);
    if (e.expires) {
      const t = Date.parse(`${e.expires}T23:59:59Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(e.expires) || Number.isNaN(t)) errors.push(`OSV-04 ${tag}: expires "${e.expires}" is not YYYY-MM-DD`);
      else if (t - nowMs > p.max_exception_days * DAY) errors.push(`OSV-04 ${tag}: expires ${e.expires} is more than ${p.max_exception_days} days ahead`);
    }
  });
  return { policy: p, errors };
}

/* ── the scan ────────────────────────────────────────────────────────── */
export async function scan({ sbom, policy, client, now = new Date() }) {
  const nowMs = now.getTime();
  const { policy: pol, errors } = checkPolicy(policy, nowMs);
  const comps = sbom.components.filter(queryable);
  const skipped = sbom.components.length - comps.length;
  const idLists = await client.batch(comps.map(c => c.purl));
  const vulnCache = new Map();
  const findings = [];
  for (let i = 0; i < comps.length; i++) {
    for (const id of idLists[i]) {
      if (!vulnCache.has(id)) vulnCache.set(id, await client.vuln(id));
      const v = vulnCache.get(id);
      if (v.withdrawn) continue;
      const sev = severityOf(v);
      const c = comps[i];
      const shipped = c.scope !== 'excluded';
      const level = sev.level || pol.unknown_severity;
      const threshold = shipped ? pol.fail_at.shipped : pol.fail_at.dev;
      findings.push({
        id, aliases: v.aliases || [], package: c.name, version: c.version, purl: c.purl,
        ecosystem: c.purl.startsWith('pkg:npm/') ? 'npm' : 'pub',
        scope: shipped ? 'shipped' : 'dev', severity: sev.level, severity_source: sev.source, effective: level,
        blocking: rank(level) >= rank(threshold), unknown: !sev.level,
        summary: String(v.summary || '').slice(0, 160),
      });
    }
  }
  /* exceptions */
  const used = new Set();
  for (const f of findings) {
    if (!f.blocking) continue;
    const ids = [f.id, ...f.aliases];
    const idx = pol.exceptions.findIndex(e => e && e.package === f.package && ids.includes(e.id));
    if (idx < 0) continue;
    const e = pol.exceptions[idx];
    used.add(idx);
    if (Date.parse(`${e.expires}T23:59:59Z`) < nowMs) { f.exception = { id: e.id, state: 'expired', expires: e.expires }; continue; }
    if (errors.some(x => x.includes(`exception[${idx}]`))) { f.exception = { id: e.id, state: 'invalid' }; continue; }
    f.exception = { id: e.id, state: 'accepted', expires: e.expires, owner: e.owner };
    f.blocking = false;
  }
  const stale = pol.exceptions.map((e, i) => ({ e, i })).filter(x => !used.has(x.i)).map(x => `${x.e && x.e.id} (${x.e && x.e.package})`);
  const blocking = findings.filter(f => f.blocking);
  const violations = [...errors];
  for (const f of blocking) {
    const code = f.unknown ? 'OSV-03' : f.scope === 'shipped' ? 'OSV-01' : 'OSV-02';
    violations.push(`${code} ${f.purl} ${f.id} severity=${f.severity || 'unknown→' + f.effective} scope=${f.scope}${f.exception ? ' exception=' + f.exception.state : ''} — ${f.summary}`);
  }
  return {
    ok: violations.length === 0,
    policy: { fail_at: pol.fail_at, unknown_severity: pol.unknown_severity, max_exception_days: pol.max_exception_days, exceptions: pol.exceptions.length },
    counts: {
      components: sbom.components.length, queried: comps.length, not_in_osv: skipped,
      advisories: findings.length, blocking: blocking.length,
      shipped_findings: findings.filter(f => f.scope === 'shipped').length, dev_findings: findings.filter(f => f.scope === 'dev').length,
      accepted_exceptions: findings.filter(f => f.exception && f.exception.state === 'accepted').length, stale_exceptions: stale.length,
    },
    findings, stale, violations,
  };
}

function parseArgs(argv) {
  const a = { root: process.cwd(), sbom: null, locks: [], policy: null, out: null, now: null, cache: null, record: null, expectFail: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--root') a.root = path.resolve(argv[++i]);
    else if (k === '--sbom') a.sbom = argv[++i];
    else if (k === '--lock') { const [kind, ...f] = String(argv[++i]).split(':'); a.locks.push({ kind, file: f.join(':') }); }
    else if (k === '--policy') a.policy = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--now') a.now = argv[++i];
    else if (k === '--osv-cache') a.cache = argv[++i];
    else if (k === '--record') a.record = argv[++i];
    else if (k === '--expect-fail') a.expectFail = true;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

export async function main(argv) {
  let a;
  try { a = parseArgs(argv); } catch (e) { console.log(`OSV-84-ERROR ${e.message}`); return 2; }
  let sbom;
  if (a.sbom) {
    try { sbom = JSON.parse(fs.readFileSync(path.resolve(a.sbom), 'utf8')); } catch (e) { console.log(`OSV-84-ERROR cannot read SBOM ${a.sbom}: ${e.message}`); return 2; }
  } else {
    const b = buildSbom({ root: a.root, locks: a.locks.length ? a.locks : DEFAULT_LOCKS });
    if (b.violations.length) { for (const v of b.violations) console.log('FAIL  ' + v); console.log(`OSV-84-ERROR SBOM build failed (${b.violations.length} violations)`); return 2; }
    sbom = b.sbom;
  }
  if (!sbom || !Array.isArray(sbom.components) || sbom.bomFormat !== 'CycloneDX') { console.log('OSV-84-ERROR not a CycloneDX SBOM'); return 2; }
  const policyFile = a.policy ? path.resolve(a.policy) : path.join(path.dirname(fileURLToPath(import.meta.url)), 'osv-policy-84.json');
  let policy;
  try { policy = JSON.parse(fs.readFileSync(policyFile, 'utf8')); } catch (e) { console.log(`OSV-84-ERROR cannot read policy ${policyFile}: ${e.message}`); return 2; }
  const now = a.now ? new Date(`${a.now}T12:00:00Z`) : new Date();
  const recorder = a.record ? { query: {}, vulns: {} } : null;
  let client;
  try { client = a.cache ? cacheClient(JSON.parse(fs.readFileSync(a.cache, 'utf8'))) : liveClient(OSV_API, recorder); } catch (e) { console.log(`OSV-84-ERROR cannot read OSV cache: ${e.message}`); return 2; }
  let r;
  try { r = await scan({ sbom, policy, client, now }); } catch (e) { console.log(`OSV-84-ERROR ${e.message}`); return 2; }
  if (recorder) fs.writeFileSync(a.record, JSON.stringify(recorder, null, 2) + '\n');
  const report = Object.assign({ tool: 'osv-scan-84', source: a.cache ? 'recorded' : OSV_API, date_utc: now.toISOString() }, r);
  if (a.out) { fs.mkdirSync(path.dirname(path.resolve(a.out)), { recursive: true }); fs.writeFileSync(a.out, JSON.stringify(report, null, 2) + '\n'); }
  console.log(`policy fail_at shipped>=${r.policy.fail_at.shipped} dev>=${r.policy.fail_at.dev} unknown=${r.policy.unknown_severity} exceptions=${r.policy.exceptions}`);
  console.log(`components=${r.counts.components} queried=${r.counts.queried} not_in_osv=${r.counts.not_in_osv} advisories=${r.counts.advisories}`);
  for (const f of r.findings) console.log(`${f.blocking ? 'BLOCK' : 'note '} ${f.purl} ${f.id} ${f.severity || 'unknown'} (${f.severity_source}) scope=${f.scope}${f.exception ? ' exception=' + f.exception.state : ''}`);
  for (const s of r.stale) console.log(`STALE exception ${s} matches no finding — remove it`);
  for (const v of r.violations) console.log('FAIL  ' + v);
  const line = r.ok
    ? `OSV-84-OK components=${r.counts.components} queried=${r.counts.queried} advisories=${r.counts.advisories} blocking=0 accepted=${r.counts.accepted_exceptions}`
    : `OSV-84-FAIL violations=${r.violations.length} blocking=${r.counts.blocking}`;
  console.log(line);
  if (a.expectFail) {
    const okNeg = !r.ok && r.counts.blocking > 0;
    console.log(okNeg ? 'OSV-84-NEGATIVE-CONTROL-OK (gate rejected the deliberately vulnerable dependency)' : 'OSV-84-NEGATIVE-CONTROL-FAILED (gate did not reject)');
    return okNeg ? 0 : 1;
  }
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(c => { process.exitCode = c; });
}
