'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Native API version policy — row 64 (§4), reused by row 67.
   Contract: docs/cloud/contracts/native-api-v1.md §5.

   Native clients identify themselves with two headers:
     X-Payesh-Client: payesh-native/<semver>   (required for native clients)
     X-Payesh-Api:    <integer>                 (contract major; default 1)

   Rules (evaluated before any authentication or database access):
     1. No X-Payesh-Client header        → web / legacy client, untouched (pass).
     2. Header present but malformed      → 400 bad_client_header.
     3. Api newer than the server         → 400 api_version_unsupported.
     4. Api older than CURRENT - 2 (N-2)  → 426 upgrade_required.
     5. Client semver < minimum           → 426 upgrade_required.
     6. Client semver on the kill-list    → 426 upgrade_required (row 67 kill-switch).
   Every native response carries X-Payesh-Api / X-Payesh-Api-Supported so a client
   can warn before it falls out of the window.
   ═══════════════════════════════════════════════════════════════════ */

const CLIENT_RE = /^payesh-native\/(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:[-+][0-9A-Za-z.-]{1,40})?$/;
const SEMVER_RE = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;
/** how many older contract majors stay supported (N-1 and N-2) */
const BACK_VERSIONS = 2;
/** paths that must always answer, whatever the client version (discovery/probes) */
const EXEMPT = new Set(['/api/health', '/api/version', '/api/readyz', '/healthz', '/readyz', '/metrics', '/api/metrics']);

const UPGRADE_MESSAGE = 'نسخهٔ برنامه قدیمی است و دیگر پشتیبانی نمی‌شود. لطفاً برنامه را به‌روزرسانی کنید.';

function parseSemver(s) {
  const m = SEMVER_RE.exec(String(s || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; }
  return 0;
}

function config(env = process.env) {
  const current = Math.max(1, Math.trunc(Number(env.PAYESH_NATIVE_API_CURRENT || 1)) || 1);
  const minClient = parseSemver(env.PAYESH_MIN_NATIVE_CLIENT || '0.1.0') || [0, 1, 0];
  const killed = String(env.PAYESH_CLIENT_KILL || '').split(',').map(s => s.trim()).filter(Boolean)
    .map(parseSemver).filter(Boolean);
  const oldest = Math.max(1, current - BACK_VERSIONS);
  return { current, oldest, minClient, killed, supported: range(oldest, current) };
}

function range(a, b) { const out = []; for (let i = a; i <= b; i++) out.push(i); return out; }

/** Parse the identity headers. Returns null for non-native (web) callers. */
function parseClient(headers) {
  const raw = headers && headers['x-payesh-client'];
  if (raw === undefined || raw === null || raw === '') return null;
  const m = CLIENT_RE.exec(String(raw).trim());
  const apiRaw = headers['x-payesh-api'];
  const api = apiRaw === undefined || apiRaw === '' ? 1 : (/^\d{1,3}$/.test(String(apiRaw).trim()) ? Number(apiRaw) : NaN);
  if (!m || !Number.isInteger(api) || api < 1) return { bad: true, raw: String(raw).slice(0, 80) };
  return { version: [Number(m[1]), Number(m[2]), Number(m[3])], text: m[1] + '.' + m[2] + '.' + m[3], api };
}

function responseHeaders(cfg = config()) {
  return { 'x-payesh-api': String(cfg.current), 'x-payesh-api-supported': cfg.supported.join(',') };
}

function upgradeBody(cfg, reason, client) {
  return {
    ok: false, error: 'upgrade_required', reason,
    min_client: cfg.minClient.join('.'), supported_api: cfg.supported, current_api: cfg.current,
    client: client && client.text ? client.text : null, message: UPGRADE_MESSAGE,
  };
}

/**
 * Decide whether a request may proceed.
 * @returns {null | {status:number, body:object, headers:object}} null = allowed.
 */
function check(pathname, headers, env = process.env) {
  if (EXEMPT.has(pathname)) return null;
  const client = parseClient(headers || {});
  if (!client) return null;                                   /* rule 1: web client */
  const cfg = config(env);
  const h = responseHeaders(cfg);
  if (client.bad) return { status: 400, headers: h, body: { ok: false, error: 'bad_client_header', supported_api: cfg.supported } };
  if (client.api > cfg.current) {
    return { status: 400, headers: h, body: { ok: false, error: 'api_version_unsupported', supported_api: cfg.supported, current_api: cfg.current } };
  }
  if (client.api < cfg.oldest) return { status: 426, headers: h, body: upgradeBody(cfg, 'api_too_old', client) };
  if (cmp(client.version, cfg.minClient) < 0) return { status: 426, headers: h, body: upgradeBody(cfg, 'client_too_old', client) };
  if (cfg.killed.some(k => cmp(k, client.version) === 0)) return { status: 426, headers: h, body: upgradeBody(cfg, 'client_disabled', client) };
  return null;
}

module.exports = { check, parseClient, parseSemver, config, responseHeaders, BACK_VERSIONS, EXEMPT, UPGRADE_MESSAGE };
