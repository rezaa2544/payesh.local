#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   Row 66 — reference (Node) client for the Directory bootstrap API.
   The Flutter client implements the same rules (contract: native-api-v1.md §3):

   1. resolve(school_code) is cached for exactly `ttl` seconds from the answer;
      inside the TTL no network call is made.
   2. `migration_state = migrating` → the client HOLDS writes (keeps its outbox)
      and asks again after `ttl` (short while migrating). Nothing is dropped.
   3. `migration_state = moved` or a newer `version` → the cached route, token and
      data-plane URL are discarded; the client re-authenticates for the new cell.
   4. A data-plane answer `409 write_frozen` or `403 wrong_cell` (or a network
      error) invalidates the cached route immediately; the outbox is kept and the
      next flush re-resolves.
   5. Ops keep their idempotency `uid` across cells, so re-sending after a move
      can only produce `duplicates`, never a second application.

   CLI:  node tools/directory-client-66.mjs <directory-base-url> <school_code>
   ═══════════════════════════════════════════════════════════════════ */

export const CLIENT_HEADER = 'payesh-native/0.1.0';

export class DirectoryClient {
  constructor({ directoryUrl, fetchImpl = globalThis.fetch, now = Date.now, clientHeader = CLIENT_HEADER } = {}) {
    if (!directoryUrl) throw new Error('directoryUrl required');
    this.base = String(directoryUrl).replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.now = now;
    this.clientHeader = clientHeader;
    this.cache = new Map();
    this.stats = { network: 0, cache_hits: 0, invalidations: 0 };
  }

  invalidate(code) {
    if (this.cache.delete(String(code).toLowerCase())) this.stats.invalidations++;
  }

  async resolve(code, { force = false } = {}) {
    const key = String(code).toLowerCase();
    const hit = this.cache.get(key);
    if (!force && hit && this.now() < hit.expires_at) { this.stats.cache_hits++; return hit.route; }
    this.stats.network++;
    const res = await this.fetch(`${this.base}/api/dir/v1/resolve?school_code=${encodeURIComponent(code)}`, {
      headers: { 'x-payesh-client': this.clientHeader, accept: 'application/json' },
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 404) { this.cache.delete(key); const e = new Error('unknown_school'); e.code = 'not_found'; throw e; }
    if (res.status === 429) {
      const e = new Error('rate_limited'); e.code = 'rate_limited';
      e.retryAfterMs = Number(body.retry_after_ms) || Number(res.headers.get('retry-after')) * 1000 || 1000;
      throw e;
    }
    if (res.status !== 200 || !body.ok) { const e = new Error(body.error || ('http_' + res.status)); e.code = body.error || 'directory_error'; throw e; }
    const prev = hit && hit.route;
    const route = Object.assign({}, body, { changed: !prev || prev.version !== body.version || prev.cell_id !== body.cell_id });
    this.cache.set(key, { route, expires_at: this.now() + Number(body.ttl) * 1000 });
    return route;
  }
}

/** Minimal outbox-backed sync client that follows Directory moves (rules 2–5). */
export class CellSyncClient {
  constructor({ dir, schoolCode, tokenFor, deviceId = 'dev-66', fetchImpl = globalThis.fetch }) {
    this.dir = dir; this.code = schoolCode; this.tokenFor = tokenFor; this.deviceId = deviceId; this.fetch = fetchImpl;
    this.outbox = []; this.token = null; this.cellId = null; this.log = [];
  }

  enqueue(...ops) { for (const op of ops) this.outbox.push(op); }

  async headers(route) {
    if (!this.token || this.cellId !== route.cell_id) {
      this.token = await this.tokenFor(route);           /* rule 3: new cell → new token */
      this.cellId = route.cell_id;
    }
    return { authorization: 'Bearer ' + this.token, 'x-device-id': this.deviceId, 'x-payesh-client': CLIENT_HEADER, 'content-type': 'application/json' };
  }

  /** @returns {{sent:number, held:boolean, reason?:string, counts?:object, cell_id?:string}} */
  async flush() {
    if (!this.outbox.length) return { sent: 0, held: false };
    const route = await this.dir.resolve(this.code);
    if (route.migration_state === 'migrating') {        /* rule 2 */
      this.log.push({ held: 'migrating', version: route.version });
      return { sent: 0, held: true, reason: 'migrating' };
    }
    let res;
    try {
      res = await this.fetch(route.cell_url + '/api/gw/v1/push', {
        method: 'POST', headers: await this.headers(route), body: JSON.stringify({ ops: this.outbox }),
      });
    } catch (e) {
      this.dir.invalidate(this.code);                    /* rule 4 */
      return { sent: 0, held: true, reason: 'network' };
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 409 || (res.status === 403 && /wrong_cell|missing_cell/.test(String(body.error)))) {
      this.dir.invalidate(this.code);                    /* rule 4 */
      this.token = null;
      this.log.push({ held: body.error, cell_id: route.cell_id });
      return { sent: 0, held: true, reason: body.error };
    }
    if (res.status !== 200) throw new Error('push failed: ' + res.status + ' ' + JSON.stringify(body));
    const done = new Set([...body.applied, ...body.duplicates, ...body.conflicts].map(x => x.uid));
    const sent = this.outbox.length;
    this.outbox = this.outbox.filter(op => !done.has(op.uid));
    this.log.push({ pushed: sent, cell_id: route.cell_id, counts: body.counts });
    return { sent, held: false, counts: body.counts, cell_id: route.cell_id };
  }

  async pullAll() {
    const route = await this.dir.resolve(this.code);
    const rows = [];
    let since = 0;
    for (let i = 0; i < 1000; i++) {
      const res = await this.fetch(`${route.cell_url}/api/gw/v1/pull?since_seq=${since}&limit=200`, { headers: await this.headers(route) });
      const body = await res.json();
      if (res.status !== 200) throw new Error('pull failed: ' + res.status + ' ' + JSON.stringify(body));
      rows.push(...body.rows);
      since = body.next_seq;
      if (!body.more) break;
    }
    return { rows, cell_id: route.cell_id };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [base, code] = process.argv.slice(2);
  if (!base || !code) { console.error('usage: directory-client-66.mjs <directory-base-url> <school_code>'); process.exit(2); }
  const c = new DirectoryClient({ directoryUrl: base });
  c.resolve(code).then(r => { console.log(JSON.stringify(r, null, 2)); }, e => { console.error(e.code || e.message); process.exit(1); });
}
