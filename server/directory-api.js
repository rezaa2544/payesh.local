'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Public, stateless Directory bootstrap API — row 66
   Contract: docs/cloud/contracts/native-api-v1.md §3 (schema $defs/directoryResolveResponse)

     GET /api/dir/v1/resolve?school_code=<code>
       200 {ok, schema_version, school_code, cell_id, cell_url, version, ttl, migration_state, stale}
       404 {ok:false, error:'not_found'}           unknown code AND malformed code (identical body:
                                                  the response never tells a valid-looking code
                                                  from an invalid one — no enumeration oracle)
       429 {ok:false, error:'rate_limited', retry_after_ms} + Retry-After (per client address)
       503 {ok:false, error:'directory_unavailable' | 'cell_unavailable' | 'not_configured'}

   Hard rules:
     · read-only: one school per call, never a list, never another school's data;
     · no session, no token, no tenant data — only the route of the asked school;
     · instance state is only a TTL cache and a rate window (any instance can serve any call).
   ═══════════════════════════════════════════════════════════════════ */
const directory = require('./directory');

const DEFAULTS = {
  clientTtlSec: Number(process.env.PAYESH_DIR_CLIENT_TTL_SEC || 300),
  migratingTtlSec: Number(process.env.PAYESH_DIR_MIGRATING_TTL_SEC || 15),
  movedTtlSec: Number(process.env.PAYESH_DIR_MOVED_TTL_SEC || 30),
  rateMax: Number(process.env.PAYESH_DIR_RATE_MAX || 30),
  rateWindowSec: Number(process.env.PAYESH_DIR_RATE_WINDOW_SEC || 60),
  trustProxy: String(process.env.PAYESH_TRUST_PROXY || '') === '1',
};

function clientKey(req, trustProxy) {
  if (trustProxy) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xf) return xf.slice(0, 64);
  }
  return String((req.socket && req.socket.remoteAddress) || 'unknown').replace('::ffff:', '');
}

function createRateLimiter({ max, windowSec, now = Date.now, cap = 20000 }) {
  const hits = new Map();
  return function take(key) {
    const t = now();
    let w = hits.get(key);
    if (!w || t - w.start >= windowSec * 1000) {
      if (hits.size >= cap) hits.clear();               /* bounded memory under a flood */
      w = { start: t, n: 0 };
      hits.set(key, w);
    }
    w.n++;
    if (w.n > max) return { allowed: false, retry_after_ms: Math.max(1, w.start + windowSec * 1000 - t) };
    return { allowed: true, remaining: max - w.n };
  };
}

function ttlFor(state, o) {
  if (state === 'migrating') return o.migratingTtlSec;
  if (state === 'moved') return o.movedTtlSec;
  return o.clientTtlSec;
}

/**
 * @param {{resolver?:object, options?:object}} deps  resolver = directory.createResolver(pool) or null
 * @returns {(req, res, url, json:Function) => Promise<void>}
 */
function createDirectoryApi({ resolver = null, options = {} } = {}) {
  const o = Object.assign({}, DEFAULTS, options);
  const take = createRateLimiter({ max: o.rateMax, windowSec: o.rateWindowSec, now: o.now || Date.now });
  const NOT_FOUND = { ok: false, error: 'not_found' };

  return async function handle(req, res, url, json, extraHeaders = {}) {
    const rl = take(clientKey(req, o.trustProxy));
    if (!rl.allowed) {
      return json(res, 429, { ok: false, error: 'rate_limited', retry_after_ms: rl.retry_after_ms },
        Object.assign({ 'retry-after': String(Math.ceil(rl.retry_after_ms / 1000)) }, extraHeaders));
    }
    if (!resolver) return json(res, 503, { ok: false, error: 'not_configured' }, extraHeaders);
    let code;
    try { code = directory.normalizeCode(url.searchParams.get('school_code')); }
    catch (e) { return json(res, 404, NOT_FOUND, extraHeaders); }
    let route;
    try { route = await resolver.resolve(code); }
    catch (e) {
      return json(res, e.status === 503 ? 503 : 500, { ok: false, error: e.code === 'directory_unavailable' ? 'directory_unavailable' : 'directory_error' }, extraHeaders);
    }
    if (!route) return json(res, 404, NOT_FOUND, extraHeaders);
    if (route.status === 'disabled' || !route.base_url) {
      return json(res, 503, { ok: false, error: 'cell_unavailable' }, extraHeaders);
    }
    const state = route.migration_state || 'stable';
    return json(res, 200, {
      ok: true, schema_version: 1, school_code: route.school_code, cell_id: route.cell_id,
      cell_url: route.base_url, version: Number(route.version || 1), ttl: ttlFor(state, o),
      migration_state: state, stale: !!route.stale,
    }, extraHeaders);
  };
}

module.exports = { createDirectoryApi, createRateLimiter, clientKey, ttlFor, DEFAULTS };
