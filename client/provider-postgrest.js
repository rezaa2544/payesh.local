'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 110 (ADR-105, Proposed) — PROVIDER layer of the direct path.

   The transport layer (client/transport.js) speaks the sync protocol:
   push(ops) / pull(). It reaches the database through a provider object
   with exactly one method:

       rpc(fn, args[]) → Promise<jsonb result of payesh_direct.<fn>(…)>

   This file is the PostgREST flavour of that provider (Supabase and any
   PostgREST-compatible managed PostgreSQL): POST {url}/rest/v1/rpc/<fn> with
   named parameters. Another provider (a different managed host, a pg
   client in tests) only has to implement rpc() — nothing in the transport
   or in the sync protocol changes.

   What the client holds (and nothing more):
     • the PUBLIC client key of the project (Supabase "publishable" / anon
       key) — it only lets a request reach PostgREST; on its own it maps to
       the anon role, which has no access at all (row 109, N-anon-role);
     • the user's own access token (JWT with sub + device_id) — RLS and the
       SECURITY INVOKER sync functions decide everything from it.
   A service key (Supabase secret key / service role) is REFUSED at construction
   and per request; tests/transport-110.js scans the client code for one.

   Only the allowlisted RPCs below can be called, with their named
   parameters; unknown functions never leave the device.
   Dependency-free; works in Node ≥ 18 (global fetch) and browsers.
   ═══════════════════════════════════════════════════════════════════ */

/* fn → ordered parameter names of payesh_direct.<fn> (db/migrations/direct) */
const RPC_PARAMS = Object.freeze({
  sync_push: ['p_ops', 'p_idem'],
  sync_pull: ['p_since', 'p_limit', 'p_collections'],
  sync_resolve_conflict: ['p_id', 'p_decision'],
  my_plan: [],
  register_device_key: ['p_public_key'],
  publish_scope_key: ['p_scope', 'p_smk_gen', 'p_gen', 'p_public_key'],
  put_key_grant: ['p_device', 'p_scope', 'p_smk_gen', 'p_gen', 'p_sealed'],
  current_user_id: [],
  current_tenant_id: [],
  telemetry_ingest: ['p_events', 'p_consent'],   /* row 80: opt-in, PII-free (client/telemetry.js) */
});

class DirectError extends Error {
  constructor(code, message, o = {}) {
    super(message || code);
    this.name = 'DirectError';
    this.code = code;                    /* client-side code: auth, forbidden, rate_limited, unavailable, network, protocol, db */
    this.status = o.status == null ? null : o.status;
    this.sqlstate = o.sqlstate || null;  /* PostgreSQL SQLSTATE when the database refused */
    this.retryable = !!o.retryable;
    this.detail = o.detail || null;
  }
}

function b64uJson(part) {
  const s = String(part).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s + '='.repeat((4 - (s.length % 4)) % 4);
  const txt = typeof Buffer !== 'undefined' ? Buffer.from(pad, 'base64').toString('utf8')
    : decodeURIComponent(Array.prototype.map.call(atob(pad), c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
  return JSON.parse(txt);
}
/* the JWT payload WITHOUT verifying it — only used to refuse privileged keys */
function jwtClaims(token) {
  const p = String(token || '').split('.');
  if (p.length !== 3 || !/^eyJ/.test(p[0])) return null;
  try { return b64uJson(p[1]); } catch (e) { return null; }
}

/* roles a client must never hold; the literal list is the only allowed
   occurrence in client code (tests/transport-110.js counts the markers) */
const PRIVILEGED_ROLES = ['service_role', 'supabase_admin', 'postgres', 'supabase_auth_admin']; // key-guard-110
const SECRET_PREFIXES = ['sb_secret_'];                                                       // key-guard-110

function keyKind(key) {
  const k = String(key || '').trim();
  if (!k) return { ok: false, why: 'client_key_required' };
  if (SECRET_PREFIXES.some(p => k.startsWith(p))) return { ok: false, why: 'service_key_forbidden' };
  const c = jwtClaims(k);
  if (c) {
    const role = String(c.role || '');
    if (PRIVILEGED_ROLES.includes(role)) return { ok: false, why: 'service_key_forbidden' };
    if (role !== 'anon') return { ok: false, why: 'client_key_must_be_anon', role };
    return { ok: true, kind: 'anon-jwt' };
  }
  if (k.startsWith('sb_publishable_')) return { ok: true, kind: 'publishable' };
  return { ok: true, kind: 'opaque' };
}
function assertClientKey(key) {
  const r = keyKind(key);
  if (!r.ok) throw new DirectError(r.why, r.why + (r.role ? ' (role ' + r.role + ')' : ''));
  return r.kind;
}
/* the user's token: a JWT, never a privileged role */
function assertUserToken(token) {
  const c = jwtClaims(token);
  if (!c) throw new DirectError('auth', 'user token missing or not a JWT');
  if (PRIVILEGED_ROLES.includes(String(c.role || ''))) throw new DirectError('service_key_forbidden', 'a privileged token is not a user token');
  return c;
}

function checkUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch (e) { throw new DirectError('bad_url', 'provider url is not a URL'); }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new DirectError('bad_url', 'provider url must be https (http only on loopback)');
  if (u.username || u.password) throw new DirectError('bad_url', 'no credentials in the provider url');
  if (u.search || u.hash) throw new DirectError('bad_url', 'provider url carries no query or fragment');
  return u.origin + u.pathname.replace(/\/+$/, '');
}

function namedArgs(fn, args) {
  const names = RPC_PARAMS[fn];
  const a = Array.isArray(args) ? args : [];
  if (a.length > names.length) throw new DirectError('protocol', `${fn}: too many arguments`);
  const body = {};
  names.forEach((n, i) => {
    if (i >= a.length || a[i] === undefined) return;
    let v = a[i];
    /* sync_push takes jsonb: DirectSync passes the JSON text */
    if ((n === 'p_ops' || n === 'p_events') && typeof v === 'string') v = JSON.parse(v);
    body[n] = v;
  });
  return body;
}

/* PostgREST error body → DirectError (status mapping follows PostgREST) */
async function toError(res) {
  let j = null;
  try { j = await res.json(); } catch (e) { /* not json */ }
  const sqlstate = j && typeof j.code === 'string' && /^[0-9A-Z]{5}$/.test(j.code) ? j.code : null;
  const msg = (j && (j.message || j.msg || j.error)) || ('http ' + res.status);
  const o = { status: res.status, sqlstate, detail: j && (j.details || j.hint) || null };
  if (res.status === 401) return new DirectError('auth', msg, o);
  if (res.status === 429) return new DirectError('rate_limited', msg, Object.assign(o, { retryable: true }));
  if (res.status >= 500 && sqlstate !== '54000') return new DirectError('unavailable', msg, Object.assign(o, { retryable: true }));
  if (sqlstate === '54000') return new DirectError('plan_limit', msg, o);   /* plan cap: not retried blindly */
  if (res.status === 403 || sqlstate === '42501') return new DirectError('forbidden', msg, o);
  return new DirectError('db', msg, o);
}

class PostgrestProvider {
  /**
   * @param {object} o
   * @param {string} o.url            project url (https://<ref>.supabase.co or any PostgREST origin)
   * @param {string} o.clientKey      the PUBLIC client key (publishable / anon) — never a service key
   * @param {() => string|Promise<string>} o.token  the user's current access token (JWT)
   * @param {string} [o.schema]       exposed schema (default payesh_direct)
   * @param {typeof fetch} [o.fetch]
   * @param {number} [o.timeoutMs]
   */
  constructor({ url, clientKey, token, schema = 'payesh_direct', fetch: f = null, timeoutMs = 30000 } = {}) {
    this.base = checkUrl(url);
    this.keyKind = assertClientKey(clientKey);
    if (typeof token !== 'function') throw new DirectError('auth', 'token() is required');
    this.clientKey = String(clientKey).trim();
    this.token = token;
    this.schema = schema;
    this.fetch = f || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!this.fetch) throw new DirectError('protocol', 'no fetch available');
    this.timeoutMs = timeoutMs;
    this.calls = 0;
  }

  async rpc(fn, args = []) {
    if (!Object.prototype.hasOwnProperty.call(RPC_PARAMS, fn)) throw new DirectError('rpc_not_allowed', 'rpc not allowed: ' + fn);
    const tok = String(await this.token() || '');
    assertUserToken(tok);
    const body = JSON.stringify(namedArgs(fn, args));
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), this.timeoutMs) : null;
    let res;
    this.calls++;
    try {
      res = await this.fetch(this.base + '/rest/v1/rpc/' + fn, {
        method: 'POST',
        headers: {
          apikey: this.clientKey,
          authorization: 'Bearer ' + tok,
          'content-type': 'application/json',
          accept: 'application/json',
          'content-profile': this.schema,
          'accept-profile': this.schema,
        },
        body,
        signal: ctl ? ctl.signal : undefined,
      });
    } catch (e) {
      throw new DirectError('network', 'network: ' + ((e && e.message) || e), { retryable: true });
    } finally { if (timer) clearTimeout(timer); }
    if (!res.ok) throw await toError(res);
    const txt = await res.text();
    if (!txt) return null;
    try { return JSON.parse(txt); } catch (e) { throw new DirectError('protocol', fn + ': response is not JSON', { status: res.status }); }
  }
}

const api = { PostgrestProvider, DirectError, RPC_PARAMS, assertClientKey, assertUserToken, keyKind, jwtClaims, checkUrl, namedArgs };
if (typeof module === 'object' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.PayeshPostgrest = api;
