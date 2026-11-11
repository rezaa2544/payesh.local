'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 122 — provider-agnostic infrastructure layer (Control Plane).

   1) ProviderAdapter: the one contract every provider (host / vps / vpc / db) must satisfy.
      Only the `manual` adapter exists. It answers every capacity/usage question with
      { value: null, label: '?' } — "unknown" — and refuses provision(): there is NO
      auto-provisioning until a real provider API is researched and proven (row 124).
   2) Credentials: never stored, returned, logged or audited. A provider keeps only a
      reference `secret:NAME`; resolveCredential() reads the value from the process
      environment on the operator's host, for an adapter call only.
   3) Limited health check: one HTTP(S) status or TCP connect, hard timeout, no redirects,
      no body read, short error codes only, private/loopback/metadata addresses refused
      unless the operator explicitly allows them (PAYESH_INFRA_ALLOW_PRIVATE=1).
   ═══════════════════════════════════════════════════════════════════ */
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const KINDS = Object.freeze(['host', 'vps', 'vpc', 'db', 'storage', 'other']);
const ADAPTER_METHODS = Object.freeze(['describe', 'capabilities', 'capacity', 'usage', 'provision']);
const CREDENTIAL_REF_RE = /^secret:[A-Z][A-Z0-9_]{2,63}$/;
const UNKNOWN = Object.freeze({ value: null, label: '?', source: 'none' });

/* ── ProviderAdapter contract ───────────────────────────────────────── */
function assertAdapter(a) {
  if (!a || typeof a !== 'object') throw new TypeError('adapter must be an object');
  for (const m of ADAPTER_METHODS) {
    if (typeof a[m] !== 'function') throw new TypeError('adapter is missing ' + m + '()');
  }
  const d = a.describe();
  if (!d || typeof d.mode !== 'string' || !Array.isArray(d.kinds) || !d.kinds.every(k => KINDS.includes(k))) {
    throw new TypeError('adapter.describe() must return { mode, kinds[] } with known kinds');
  }
  return a;
}

function notSupported(op) {
  const e = new Error('provider operation not supported: ' + op);
  e.code = 'provider_not_supported';
  return e;
}

/* The manual adapter: the owner registers everything by hand; nothing is fetched or created. */
function manualAdapter() {
  return assertAdapter({
    describe() { return { mode: 'manual', kinds: KINDS.slice(), automated: false }; },
    capabilities() { return { list_services: false, capacity: false, usage: false, provision: false }; },
    async capacity() { return Object.assign({}, UNKNOWN); },
    async usage() { return Object.assign({}, UNKNOWN); },
    async provision() { throw notSupported('provision'); },
  });
}

const ADAPTERS = { manual: manualAdapter };
function getAdapter(mode) {
  const make = ADAPTERS[String(mode || '')];
  if (!make) throw notSupported('adapter:' + String(mode || ''));
  return make();
}

/* ── credentials by reference only ──────────────────────────────────── */
function isCredentialRef(v) { return typeof v === 'string' && CREDENTIAL_REF_RE.test(v); }
function resolveCredential(ref, env = process.env) {
  if (!isCredentialRef(ref)) throw notSupported('credential_ref');
  const v = env[ref.slice('secret:'.length)];
  return typeof v === 'string' && v.length ? v : null;
}
/* What the API may say about a credential: whether one is referenced, never the value. */
function credentialView(ref) {
  return ref ? { credential: 'reference', credential_ref: ref } : { credential: 'none', credential_ref: null };
}

/* ── limited health check ───────────────────────────────────────────── */
function ipv4ToInt(ip) { return ip.split('.').reduce((n, o) => (n * 256) + Number(o), 0); }
function inV4(ip, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipv4ToInt(ip) & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
}
const V4_BLOCK = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]];
function isPrivateAddress(ip) {
  let a = String(ip || '').toLowerCase();
  if (a.startsWith('::ffff:') && net.isIPv4(a.slice(7))) a = a.slice(7);
  if (net.isIPv4(a)) return V4_BLOCK.some(([b, n]) => inV4(a, b, n));
  if (net.isIPv6(a)) {
    return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a);
  }
  return true;
}

function parseEndpoint(url, kind) {
  let u;
  try { u = new URL(String(url || '')); } catch (_) { return null; }
  if (u.username || u.password) return null; /* never credentials in an endpoint */
  if (String(url).length > 300) return null;
  if (kind === 'http' && (u.protocol === 'http:' || u.protocol === 'https:')) return u;
  if (kind === 'tcp' && u.protocol === 'tcp:' && u.port) return u;
  return null;
}

function hostOf(u) { return u.hostname.replace(/^\[|\]$/g, ''); }

async function resolvePinned(host, lookup) {
  if (net.isIP(host)) return host;
  const r = await lookup(host);
  return r.address;
}

function errorCode(e) {
  const c = e && e.code;
  if (c === 'ETIMEDOUT' || c === 'check_timeout') return 'timeout';
  if (c === 'ECONNREFUSED') return 'refused';
  if (c === 'ECONNRESET' || c === 'EPIPE') return 'reset';
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN' || c === 'ENODATA') return 'dns_failed';
  if (c === 'EHOSTUNREACH' || c === 'ENETUNREACH') return 'unreachable';
  if (typeof c === 'string' && /^(ERR_TLS|CERT_|UNABLE_TO|DEPTH_ZERO|SELF_SIGNED|ERR_SSL)/.test(c)) return 'tls_error';
  return 'check_failed';
}

/* Returns { ok, latency_ms, status_code, error_code }. Never throws, never returns a body. */
async function checkEndpoint(endpoint, options = {}) {
  const timeoutMs = Math.min(Number(options.timeoutMs || 5000), 10000);
  const allowPrivate = options.allowPrivate === true;
  const lookup = options.lookup || ((h) => dns.promises.lookup(h));
  const clock = options.clock || (() => Date.now());
  const u = parseEndpoint(endpoint.url, endpoint.check_kind);
  if (!u) return { ok: false, latency_ms: null, status_code: null, error_code: 'invalid_endpoint' };
  let address;
  try { address = await resolvePinned(hostOf(u), lookup); }
  catch (e) { return { ok: false, latency_ms: null, status_code: null, error_code: 'dns_failed' }; }
  if (!allowPrivate && isPrivateAddress(address)) {
    return { ok: false, latency_ms: null, status_code: null, error_code: 'blocked_address' };
  }
  const started = clock();
  const done = (ok, status, code) => ({ ok, latency_ms: Math.max(0, Math.round(clock() - started)),
    status_code: status == null ? null : status, error_code: ok ? null : code });

  if (endpoint.check_kind === 'tcp') {
    return new Promise((resolve) => {
      const sock = net.connect({ host: address, port: Number(u.port) });
      const t = setTimeout(() => { sock.destroy(); resolve(done(false, null, 'timeout')); }, timeoutMs);
      sock.once('connect', () => { clearTimeout(t); sock.destroy(); resolve(done(true, null, null)); });
      sock.once('error', (e) => { clearTimeout(t); resolve(done(false, null, errorCode(e))); });
    });
  }
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    const req = mod.request({
      method: 'GET',
      host: address,
      servername: net.isIP(hostOf(u)) ? undefined : hostOf(u),
      port: u.port || undefined,
      path: (u.pathname || '/') + (u.search || ''),
      headers: { host: u.host, 'user-agent': 'payesh-owner-health/1', accept: '*/*' },
      timeout: timeoutMs,
      agent: false,
    }, (res) => {
      const status = res.statusCode;
      res.destroy(); /* status line only: no body is read or stored */
      const expected = endpoint.expected_status;
      const okStatus = expected ? status === expected : (status >= 200 && status < 400);
      finish(done(okStatus, status, 'unexpected_status'));
    });
    req.on('timeout', () => { req.destroy(Object.assign(new Error('timeout'), { code: 'check_timeout' })); });
    req.on('error', (e) => finish(done(false, null, errorCode(e))));
    req.end();
  });
}

/* ── view model: never invent a number ──────────────────────────────── */
function metricView(row) {
  if (!row || row.value == null) {
    return { value: null, label: '?', unit: row ? row.unit : null, source: row ? row.source : 'none', observed_at: row ? row.observed_at : null };
  }
  return { value: Number(row.value), label: row.label, unit: row.unit, source: row.source, observed_at: row.observed_at };
}
function healthView(row) {
  if (!row) return { state: 'unknown', checked_at: null, latency_ms: null, status_code: null, error_code: null };
  return { state: row.ok ? 'up' : 'down', checked_at: row.checked_at, latency_ms: row.latency_ms,
    status_code: row.status_code, error_code: row.error_code };
}

module.exports = {
  KINDS, ADAPTER_METHODS, CREDENTIAL_REF_RE, UNKNOWN,
  assertAdapter, manualAdapter, getAdapter, notSupported,
  isCredentialRef, resolveCredential, credentialView,
  isPrivateAddress, parseEndpoint, checkEndpoint, metricView, healthView,
};
