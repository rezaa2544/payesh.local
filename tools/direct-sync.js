'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 108 (ADR-105 §3.3, Proposed) — device side of the direct-path sync
   protocol (JavaScript reference; the app wires it in row 110).

   The database (db/migrations/direct/0003_direct_sync.up.sql) owns what
   needs one authority: server-receipt order, OCC ("write only on top of the
   version you have seen"), uid idempotency, the change-feed cursor, RLS
   scope and the plan caps. Rows are end-to-end encrypted (row 107), so the
   field-level domain rules (D-28 / row 41, server/convergence.js, the
   conflict-v1 vectors) run HERE, on the device, on decrypted rows:

     push(ops, idemKey)
       1. every put is sealed as the FULL document of version base+1 —
          shadow(base) ∘ patch, where shadow is the last server-confirmed
          copy (never the optimistic replica, so chained offline edits keep
          the same semantics as the Gateway: no rebase);
       2. sync_push; ops the database reports `stale` come back with the
          current ciphertext; the device decrypts and decides with
          convergence.decide exactly like server/sync.js:
            merge  → re-send the SAME uid: mergedDoc, base = server_version
            noop   → re-send with verdict 'noop'
            conflict → re-send with verdict 'conflict' (both versions kept)
            impossible (tombstone) → verdict 'reject' (write_failed / not_found)
       3. the database merges the partial answers of the batch under the
          same idempotency key; the final answer has the Gateway/sync.js
          shape { applied[], conflicts[], rejected[] } (+ duplicates).
     pull()       sync_pull pages (seq cursor) → shadow + replica
     resolve()    manager: sync_resolve_conflict; 'local' re-writes the
                  local patch on top of the current row (same as sync.js).

   Transport is pluggable: call(fn, args) → the jsonb result of
   payesh_direct.<fn>(…) — a PostgREST /rpc call or a pg client.
   ═══════════════════════════════════════════════════════════════════ */
const e2e = require('./e2e1.js');
const convergence = require('../server/convergence.js');

const MAX_ROUNDS = 6;
const key = (collection, id) => collection + '#' + Number(id);
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const routingOf = doc => ({ class_id: num(doc && doc.class_id), student_id: num(doc && doc.student_id) });
function plainDoc(doc) {
  const o = Object.assign({}, doc);
  delete o._version; delete o._updated_at;
  return o;
}

/* conflict payloads are sealed under their own AAD domain so a local patch can
   never be replayed as a record version (and vice versa) */
function conflictAad(tenant, collection, id, uid) {
  return `payesh/e2e1/conflict|${tenant}|${collection}|${Number(id)}|${uid}`;
}

class DirectSync {
  /**
   * @param {object} o
   * @param {string} o.tenant      school id (uuid)
   * @param {(fn:string, args:any[]) => Promise<any>} o.call  RPC transport
   * @param {e2e.Keyring} o.keyring   this device's keys (its own grants)
   * @param {() => Promise<Map>|Map} o.directory  scope → newest public key
   */
  constructor({ tenant, call, keyring, directory }) {
    this.tenant = tenant;
    this.call = call;
    this.keyring = keyring;
    this.directory = directory;
    this.shadow = new Map();     /* key → { doc, version } last confirmed by the server */
    this.since = 0;
    this.stats = { pushes: 0, rounds: 0, stale: 0, merged: 0, noop: 0, conflicts: 0, rejected: 0 };
  }

  async dir() { return typeof this.directory === 'function' ? this.directory() : this.directory; }

  async sealDoc(collection, id, version, doc) {
    const r = routingOf(doc);
    const meta = { tenant_id: this.tenant, collection, record_id: Number(id), version, class_id: r.class_id, student_id: r.student_id };
    return { sealed: e2e.sealRecord(meta, plainDoc(doc), await this.dir()), routing: r };
  }

  openRow(row) {
    const doc = this.keyring.openRecord({ tenant_id: this.tenant, collection: row.collection, record_id: Number(row.id), version: Number(row.version), sealed: row.sealed });
    return Object.assign(doc, { id: Number(row.id), _version: Number(row.version) });
  }

  async sealConflict(collection, id, uid, patch) {
    const r = routingOf(patch);
    const meta = { collection, class_id: r.class_id, student_id: r.student_id };
    const d = await this.dir();
    const recipients = e2e.recordScopes(meta).map(s => d.get(s)).filter(Boolean);
    return e2e.seal(recipients, Buffer.from(JSON.stringify(plainDoc(patch)), 'utf8'), conflictAad(this.tenant, collection, id, uid));
  }

  openConflict(c) {
    if (!c.local_sealed) return {};
    const pt = e2e.open(c.local_sealed, this.keyring.forEnvelope(c.local_sealed), conflictAad(this.tenant, c.collection, c.record_id, c.uid));
    return JSON.parse(pt.toString('utf8'));
  }

  /* first-round op: a put is the full doc of version base+1 */
  async wireOp(o) {
    const base = o.base_version == null ? 0 : Number(o.base_version);
    if (o.type === 'del') return { uid: o.uid, collection: o.collection, id: Number(o.id), type: 'del', base_version: base };
    const sh = this.shadow.get(key(o.collection, o.id));
    /* shadow at exactly base ⇒ the real next document; otherwise the database
       is guaranteed to answer stale (server ≥ shadow > base) and nothing of
       this ciphertext is ever stored */
    const doc = Object.assign({}, sh && sh.version === base ? sh.doc : {}, o.data || {}, { id: Number(o.id) });
    const s = await this.sealDoc(o.collection, o.id, base + 1, doc);
    return { uid: o.uid, collection: o.collection, id: Number(o.id), type: 'put', base_version: base, sealed: s.sealed, class_id: s.routing.class_id, student_id: s.routing.student_id };
  }

  /* the device-side verdict on a stale op — server/sync.js semantics */
  async verdict(o, st) {
    const base = o.base_version == null ? 0 : Number(o.base_version);
    const existing = st.deleted || !st.sealed ? null : this.openRow(st);
    const w = { uid: o.uid, collection: o.collection, id: Number(o.id), type: o.type, base_version: base };
    if (o.type === 'del') {
      if (!existing) return Object.assign(w, { verdict: 'reject', error: 'not_found' });
      const d = convergence.decide({ collection: o.collection, type: 'del', incoming: o.data || {}, existing, base_version: base });
      if (d.action === 'conflict') return Object.assign(w, { verdict: 'conflict', class_id: existing.class_id == null ? null : num(existing.class_id), student_id: num(existing.student_id) });
      return Object.assign(w, { base_version: Number(st.server_version) });     /* delete_ok on the current version */
    }
    const incoming = Object.assign({}, o.data || {});
    if (!existing) {
      if (base > 0) {
        const r = routingOf(incoming);
        return Object.assign(w, { verdict: 'conflict', sealed: await this.sealConflict(o.collection, o.id, o.uid, incoming), class_id: r.class_id, student_id: r.student_id });
      }
      return Object.assign(w, { verdict: 'reject', error: 'write_failed' });   /* id of a tombstone */
    }
    const d = convergence.decide({ collection: o.collection, type: 'put', incoming, existing, base_version: base });
    const sv = Number(st.server_version);
    if (d.action === 'noop') { this.stats.noop++; return Object.assign(w, { base_version: sv, verdict: 'noop' }); }
    if (d.action === 'conflict') {
      this.stats.conflicts++;
      const r = routingOf(existing);
      return Object.assign(w, { verdict: 'conflict', sealed: await this.sealConflict(o.collection, o.id, o.uid, incoming), class_id: r.class_id, student_id: r.student_id });
    }
    /* merge (auto fields) or the documented verifier exception (apply) */
    const next = d.action === 'merge' ? convergence.mergedDoc(existing, incoming, d.fields) : Object.assign({}, existing, incoming);
    if (d.action === 'merge') this.stats.merged++;
    const s = await this.sealDoc(o.collection, o.id, sv + 1, Object.assign(plainDoc(next), { id: Number(o.id) }));
    return Object.assign(w, { base_version: sv, sealed: s.sealed, class_id: s.routing.class_id, student_id: s.routing.student_id });
  }

  /**
   * Push a batch of outbox ops ({uid, collection, id, type, base_version, data}).
   * Returns the sync.js-shaped answer: applied (incl. {uid, duplicate:true}),
   * conflicts, rejected, replayed.
   */
  async push(ops, idemKey) {
    this.stats.pushes++;
    const byUid = new Map(ops.map(o => [o.uid, o]));
    let wire = [];
    for (const o of ops) wire.push(await this.wireOp(o));
    let resp = null;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      this.stats.rounds++;
      resp = await this.call('sync_push', [JSON.stringify(wire), idemKey || null]);
      if (resp.replayed || !resp.stale || !resp.stale.length) break;
      this.stats.stale += resp.stale.length;
      wire = [];
      for (const st of resp.stale) wire.push(await this.verdict(byUid.get(st.uid), st));
    }
    if (resp.stale && resp.stale.length) throw new Error('direct sync: still stale after ' + MAX_ROUNDS + ' rounds');
    /* confirmed writes refresh the shadow only through pull (the server copy) */
    return {
      ok: true, replayed: !!resp.replayed, server_time: resp.server_time,
      applied: resp.applied.concat(resp.duplicates.map(d => ({ uid: d.uid, duplicate: true }))),
      conflicts: resp.conflicts, rejected: resp.rejected, raw: resp,
    };
  }

  /**
   * Pull the change-feed from this.since; onRow(key, doc|null) for every row
   * (null = tombstone). Keeps the shadow in step.
   */
  async pull(onRow, { limit = 50, collections = null } = {}) {
    let pages = 0;
    for (let guard = 0; guard < 10000; guard++) {
      const r = await this.call('sync_pull', [this.since, String(limit), collections]);
      pages++;
      for (const row of r.rows) {
        const k = key(row.collection, row.id);
        if (row.deleted) { this.shadow.delete(k); if (onRow) onRow(k, null, row); continue; }
        const doc = this.openRow(row);
        this.shadow.set(k, { doc: plainDoc(doc), version: Number(row.version) });
        if (onRow) onRow(k, doc, row);
      }
      this.since = Number(r.next_seq);
      if (!r.more) return { pages, since: this.since };
    }
    throw new Error('direct sync: pull did not finish');
  }

  /**
   * Manager: resolve conflict c (a sync_conflict row). 'local' writes the
   * local patch on top of the CURRENT row as a new version (sync.js does the
   * same server-side); the verdict itself is recorded by the database.
   */
  async resolve(c, decision, uid) {
    const res = await this.call('sync_resolve_conflict', [Number(c.id), decision]);
    if (decision !== 'local') return { res };
    const patch = plainDoc(this.openConflict(c));
    await this.pull();
    const sh = this.shadow.get(key(c.collection, c.record_id));
    if (!sh) return { res, skipped: 'row_gone' };
    const doc = Object.assign({}, sh.doc, patch, { id: Number(c.record_id) });
    const s = await this.sealDoc(c.collection, c.record_id, sh.version + 1, doc);
    const w = await this.call('sync_push', [JSON.stringify([{ uid, collection: c.collection, id: Number(c.record_id), type: 'put', base_version: sh.version, sealed: s.sealed, class_id: s.routing.class_id, student_id: s.routing.student_id }]), null]);
    return { res, write: w };
  }
}

module.exports = { DirectSync, conflictAad, routingOf, plainDoc, key };
