'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 110 (ADR-105, Proposed) — TRANSPORT layer of the client: how the
   outbox reaches the cloud and how the change feed comes back.

   Two transports with the SAME shape, so the outbox (client/outbox-web.js,
   drain({send})) and the pull loop do not know which one is in use:

       push(ops)  → { applied[], conflicts[], rejected[] }   (Sync v1 shape)
       pull(o)    → transport-specific page loop

     gateway  the existing path (rows 64/67): POST /api/sync and
              GET /api/v1/pull through the app's api() helper. DEFAULT.
     direct   ADR-105: tools/direct-sync.js (DirectSync — e2e sealing, the
              device-side merge, OCC + uid idempotency in the database) over
              a PROVIDER (client/provider-postgrest.js or any object with
              rpc(fn, args)). The transport never sees URLs or keys.

   Selection: PAYESH_TRANSPORT=direct turns the direct path on; anything
   else (unset, 'gateway', a typo) keeps the Gateway. The direct path is
   OFF by default and requesting it without a provider is an error — never
   a silent fallback to a different backend.

   Offline behaviour is unchanged: both transports throw on network
   failure, and the outbox keeps every op (same uid) with its backoff.
   ═══════════════════════════════════════════════════════════════════ */

const MODES = Object.freeze(['gateway', 'direct']);
const DEFAULT_MODE = 'gateway';

/** PAYESH_TRANSPORT → { mode, requested, valid } */
function transportMode(env) {
  const raw = env && env.PAYESH_TRANSPORT != null ? String(env.PAYESH_TRANSPORT) : '';
  const v = raw.trim().toLowerCase();
  if (!v) return { mode: DEFAULT_MODE, requested: null, valid: true };
  if (MODES.includes(v)) return { mode: v, requested: raw, valid: true };
  return { mode: DEFAULT_MODE, requested: raw, valid: false };
}

/* ── gateway: exactly the calls client/app.js makes today ── */
function gatewayTransport({ api }) {
  if (typeof api !== 'function') throw new Error('gateway_api_required');
  return {
    mode: 'gateway',
    async push(ops) {
      return api('/api/sync', { method: 'POST', body: { ops }, noAuthRedirect: false });
    },
    async pullPage({ since = '', sinceId = 0 } = {}) {
      return api('/api/v1/pull?since=' + encodeURIComponent(since) + '&since_id=' + Number(sinceId || 0), {});
    },
  };
}

/* ── direct: DirectSync over a provider ── */
function directTransport({ sync, idemKey = null }) {
  if (!sync || typeof sync.push !== 'function' || typeof sync.pull !== 'function') throw new Error('direct_sync_required');
  return {
    mode: 'direct',
    /* outbox wire ops (toWire): {uid, collection, type, id?, localId?, data?, base_version}.
       The direct path has no server-side id allocation: an op without a
       positive id cannot be written and is reported, not dropped silently. */
    async push(ops) {
      const ok = [], early = [];
      for (const o of ops || []) {
        if (!(Number(o.id) > 0)) early.push({ uid: String(o.uid), error: 'direct_id_required' });
        else ok.push({ uid: String(o.uid), collection: o.collection, id: Number(o.id), type: o.type === 'del' ? 'del' : 'put', base_version: Number(o.base_version || 0), data: o.data || {} });
      }
      if (!ok.length) return { ok: true, applied: [], conflicts: [], rejected: early };
      const r = await sync.push(ok, typeof idemKey === 'function' ? idemKey(ok) : null);
      return { ok: true, replayed: !!r.replayed, server_time: r.server_time, applied: r.applied, conflicts: r.conflicts, rejected: early.concat(r.rejected || []) };
    },
    /* apply the feed to a local engine (client/engine-web.js API: put/del) */
    async pullInto(engine, o = {}) {
      const writes = [];
      const res = await sync.pull((k, doc, row) => {
        if (doc == null) writes.push(['del', row.collection, Number(row.id)]);
        else {
          const data = Object.assign({}, doc); delete data._version; delete data._updated_at;
          writes.push(['put', row.collection, Number(row.id), data, Number(row.version)]);
        }
      }, o);
      for (const w of writes) {
        if (w[0] === 'del') await engine.del(w[1], w[2]);
        else await engine.put(w[1], w[2], w[3], { version: w[4] });
      }
      return { pages: res.pages, since: res.since, rows: writes.length };
    },
  };
}

/**
 * The one entry point the app uses.
 * @param {object} o
 * @param {object} [o.env]       where PAYESH_TRANSPORT is read from (process.env / baked config)
 * @param {Function} [o.api]     the app's api(path, opts) helper (gateway)
 * @param {() => object} [o.direct]  factory → DirectSync-like {push, pull}; only called in direct mode
 */
function createTransport({ env = {}, api = null, direct = null } = {}) {
  const sel = transportMode(env);
  if (sel.mode === 'direct') {
    if (typeof direct !== 'function') {
      const e = new Error('direct_not_configured'); e.code = 'direct_not_configured'; throw e;
    }
    return Object.assign(directTransport({ sync: direct() }), { selection: sel });
  }
  return Object.assign(gatewayTransport({ api }), { selection: sel });
}

const api = { MODES, DEFAULT_MODE, transportMode, gatewayTransport, directTransport, createTransport };
if (typeof module === 'object' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.PayeshTransport = api;
