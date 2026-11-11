'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Per-feature kill-switch — row 67 (Gateway hardening).
   Contract: docs/cloud/contracts/native-api-v1.md §6.

   The per-client-version kill-switch lives in api-version.js (PAYESH_CLIENT_KILL
   → 426 upgrade_required). This module switches a whole FEATURE off at the edge,
   before authentication or any database access, so an operator can stop a
   misbehaving path (e.g. push during an incident) without a deploy:

     PAYESH_FEATURE_KILL = <entry>[,<entry>…]
       entry := <feature>                 every caller
              | <feature>@<semver>        only native clients of exactly that version
              | <feature>@<<semver>       only native clients older than that version
     feature := pull | push | directory | platform

   A killed request answers 503 { ok:false, error:'feature_disabled', feature }
   with Retry-After (PAYESH_FEATURE_KILL_RETRY_SEC, default 300). Unknown features
   and malformed entries match nothing; they are listed in config().invalid and
   surfaced by /healthz (kill_switch.invalid) so a typo is visible at once.
   ═══════════════════════════════════════════════════════════════════ */
const { parseClient, parseSemver } = require('./api-version');

const FEATURES = Object.freeze({
  pull: (p) => p === '/api/gw/v1/pull',
  push: (p) => p === '/api/gw/v1/push',
  directory: (p) => p === '/api/dir/v1/resolve',
  platform: (p) => p === '/api/platform/v1' || p.startsWith('/api/platform/v1/'),
});

function cmp(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; }
  return 0;
}

function config(env = process.env) {
  const rules = [];
  const invalid = [];
  for (const raw of String(env.PAYESH_FEATURE_KILL || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const m = /^([a-z]+)(?:@(<)?(\d{1,4}\.\d{1,4}\.\d{1,4}))?$/.exec(raw);
    if (!m || !FEATURES[m[1]]) { invalid.push(raw.slice(0, 40)); continue; }
    rules.push({ feature: m[1], op: m[3] ? (m[2] ? 'lt' : 'eq') : 'all', version: m[3] ? parseSemver(m[3]) : null });
  }
  const retry = Math.trunc(Number(env.PAYESH_FEATURE_KILL_RETRY_SEC || 300));
  return { rules, invalid, retrySec: Number.isFinite(retry) && retry > 0 ? Math.min(retry, 86400) : 300 };
}

function featureOf(pathname) {
  for (const [name, match] of Object.entries(FEATURES)) if (match(pathname)) return name;
  return null;
}

/**
 * @returns {null | {status:number, body:object, headers:object}} null = allowed.
 */
function check(pathname, headers, env = process.env) {
  const feature = featureOf(pathname);
  if (!feature) return null;
  const cfg = config(env);
  if (!cfg.rules.length) return null;
  let client = null;
  try { client = parseClient(headers || {}); } catch (e) { client = null; }
  const ver = client && !client.bad ? client.version : null;
  const hit = cfg.rules.some((r) => {
    if (r.feature !== feature) return false;
    if (r.op === 'all') return true;
    if (!ver) return false;                     /* version-scoped rules only bind native clients */
    return r.op === 'eq' ? cmp(ver, r.version) === 0 : cmp(ver, r.version) < 0;
  });
  if (!hit) return null;
  return {
    status: 503,
    headers: { 'retry-after': String(cfg.retrySec) },
    body: { ok: false, error: 'feature_disabled', feature, retry_after_s: cfg.retrySec },
  };
}

module.exports = { check, config, featureOf, FEATURES: Object.keys(FEATURES) };
