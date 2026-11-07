'use strict';
/* ═══════════════════════════════════════════════════════════════════
   صندوقچهٔ عملیات ماندگار روی دستگاه — ردیف ۴۰

   مشکل کلاسیک (ریسک E‑14‑2 در docs/cloud/16): صف کلاینت در localStorage
   بود و هنگام ذخیره با `slice(-500)` **کهنه‌ترین عملیات را بی‌صدا دور
   می‌ریخت**؛ اگر کاربر آفلاین زیاد کار می‌کرد یا وسط ارسال برنامه بسته
   می‌شد، ثبت‌ها بی‌خبر گم می‌شدند.

   این ماژول همان صف را با چهار تضمین جایگزین می‌کند:

     ۱) **ماندگاری پیش از ارسال.** هر عملیات اول در IndexedDB نوشته
        می‌شود و فقط بعد از تأیید سرور حذف می‌شود (delete-after-ack).
        هیچ مسیری عملیات تأییدنشده را حذف نمی‌کند.
     ۲) **بقا در crash/restart.** ارسال با «اجاره» (lease) انجام می‌شود:
        عملیاتِ در حال ارسال با `state='inflight'` و `lease_until` ذخیره
        می‌شود؛ اگر برنامه وسط کار بمیرد، پس از پایان اجاره همان عملیات
        دوباره قابل برداشت است. هیچ عملیاتی نه گم می‌شود نه برای همیشه
        در حالت «در حال ارسال» گیر می‌کند.
     ۳) **اعمال دقیقاً یک‌بار.** هر عملیات یک `k` (idempotency key) پایدار
        دارد که در همهٔ تلاش‌ها و بعد از restart همان می‌ماند؛ سرور با
        `uid`/idempotency همان عملیات را یک‌بار اعمال می‌کند
        (server/sync.js → syncSeen/idemRemember).
     ۴) **سقف صف بدون حذف خاموش.** پر شدن صف یک خطای صریح
        `queue_full` برمی‌گرداند و همان عملیات را نمی‌پذیرد؛ عملیات
        قبلی دست‌نخورده می‌مانند و وضعیت برای کاربر قابل مشاهده است.

   بدون هیچ وابستگی: فقط IndexedDB استاندارد. در Node با fake-indexeddb
   آزموده می‌شود؛ در Chrome/WebView همان کد اجرا می‌شود.
   ═══════════════════════════════════════════════════════════════════ */

const DB_NAME = 'payesh_outbox_v1';
const DB_VERSION = 1;
const STORE = 'ops';
const META = 'meta';

const DEFAULTS = {
  capacity: 5000,          /* سقف عملیات فعال (pending+inflight) */
  leaseMs: 30000,          /* اجارهٔ ارسال؛ بعد از آن عملیات «رهاشده» است */
  maxAttempts: 6,          /* بعد از آن → blocked (نیازمند تصمیم/تلاش دستی) */
  baseBackoffMs: 1000,
  maxBackoffMs: 300000,
  batchLimit: 120,         /* هم‌اندازهٔ MAX_OPS سرور */
};

const ACTIVE = ['pending', 'inflight'];

function newKey() {
  const c = (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  /* بازگشت امن برای محیط‌های بدون crypto.randomUUID */
  let s = '';
  for (let i = 0; i < 4; i++) s += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  return s.slice(0, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16) + '-' + s.slice(16, 20) + '-' + s.slice(20, 32);
}

function factory() {
  if (typeof globalThis.indexedDB !== 'undefined' && globalThis.indexedDB) return globalThis.indexedDB;
  throw new Error('indexeddb_unavailable');
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('idb_request_failed'));
  });
}
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('idb_tx_failed'));
    tx.onabort = () => reject(tx.error || new Error('idb_tx_aborted'));
  });
}

async function open(name = DB_NAME, opts = {}) {
  const cfg = Object.assign({}, DEFAULTS, opts);
  const req = factory().open(name, DB_VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains(STORE)) {
      const os = db.createObjectStore(STORE, { keyPath: 'k' });
      os.createIndex('state', 'state', { unique: false });
      os.createIndex('seq', 'seq', { unique: false });
    }
    if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'k' });
  };
  const db = await promisify(req);
  return new Outbox(db, name, cfg);
}

class Outbox {
  constructor(db, name, cfg) {
    this.db = db;
    this.name = name;
    this.cfg = cfg;
    this._seq = 0;
    this.events = [];
  }

  _emit(type, payload) {
    this.events.push(Object.assign({ type, at: new Date().toISOString() }, payload || {}));
    if (this.events.length > 200) this.events.shift();
  }

  async _nextSeq() {
    if (this._seq) return ++this._seq;
    const tx = this.db.transaction([META], 'readonly');
    const row = await promisify(tx.objectStore(META).get('seq'));
    await txDone(tx);
    this._seq = (row && Number(row.v)) || 0;
    return ++this._seq;
  }

  async _writeSeq(v) {
    const tx = this.db.transaction([META], 'readwrite');
    tx.objectStore(META).put({ k: 'seq', v });
    await txDone(tx);
  }

  /* ── افزودن عملیات (idempotent روی k) ───────────────────────────── */
  async enqueue(op) {
    const k = String((op && (op.k || op.uid)) || '').trim() || newKey();
    const at = new Date().toISOString();
    const tx = this.db.transaction([STORE, META], 'readwrite');
    const store = tx.objectStore(STORE);
    const existing = await promisify(store.get(k));
    if (existing) {
      await txDone(tx);
      this._emit('duplicate', { k });
      return { ok: true, k, duplicate: true, state: existing.state };
    }
    const all = await promisify(store.getAll());
    const active = all.filter(r => ACTIVE.includes(r.state)).length;
    if (active >= this.cfg.capacity) {
      /* سقف پر شده است: عملیات **پذیرفته نمی‌شود** و هیچ عملیات قبلی
         حذف نمی‌شود. این خطا باید به کاربر نشان داده شود. */
      tx.abort();
      this._emit('queue_full', { active, capacity: this.cfg.capacity });
      return { ok: false, error: 'queue_full', capacity: this.cfg.capacity, used: active };
    }
    const seq = all.reduce((m, r) => Math.max(m, Number(r.seq) || 0), 0) + 1;
    const rec = {
      k,
      seq,
      collection: String(op.collection || ''),
      type: op.type === 'del' ? 'del' : 'put',
      id: op.id == null ? null : Number(op.id),
      localId: op.localId == null ? null : Number(op.localId),
      payload: op.data == null ? null : op.data,
      base_version: Number(op.base_version || 0),
      at: op.at || at,
      state: 'pending',
      attempts: 0,
      lease_until: 0,
      next_at: 0,
      last_error: null,
      created_at: at,
      updated_at: at,
    };
    store.put(rec);
    this._seq = seq;
    try { tx.objectStore(META).put({ k: 'seq', v: seq }); } catch (e) { /* meta اختیاری */ }
    await txDone(tx);
    this._emit('enqueued', { k });
    return { ok: true, k, duplicate: false, seq };
  }

  async enqueueMany(ops) {
    const out = [];
    for (const op of ops || []) out.push(await this.enqueue(op));
    return out;
  }

  /* ── برداشت عملیات برای ارسال (با اجاره) ────────────────────────── */
  async claim(limit = this.cfg.batchLimit, now = Date.now()) {
    const tx = this.db.transaction([STORE], 'readwrite');
    const store = tx.objectStore(STORE);
    const all = await promisify(store.getAll());
    const ready = all
      .filter(r => (r.state === 'pending' && Number(r.next_at || 0) <= now) ||
                   (r.state === 'inflight' && Number(r.lease_until || 0) <= now))
      .sort((a, b) => Number(a.seq) - Number(b.seq))
      .slice(0, Math.max(1, limit));
    for (const r of ready) {
      r.state = 'inflight';
      r.lease_until = now + this.cfg.leaseMs;
      r.updated_at = new Date(now).toISOString();
      store.put(r);
    }
    await txDone(tx);
    if (ready.length) this._emit('claimed', { count: ready.length });
    return ready.map(r => Object.assign({}, r));
  }

  /* علامت‌زدن دستهٔ در حال ارسال (برای درهم‌تنیدگی با حلقهٔ ارسال app.js) */
  async markInflight(keys, now = Date.now()) {
    const set = new Set((keys || []).map(String));
    if (!set.size) return { marked: 0 };
    const tx = this.db.transaction([STORE], 'readwrite');
    const store = tx.objectStore(STORE);
    const all = await promisify(store.getAll());
    let n = 0;
    for (const r of all) {
      if (!set.has(r.k)) continue;
      r.state = 'inflight';
      r.lease_until = now + this.cfg.leaseMs;
      r.updated_at = new Date(now).toISOString();
      store.put(r);
      n++;
    }
    await txDone(tx);
    return { marked: n };
  }

  async failMany(keys, error, now = Date.now()) {
    let n = 0;
    for (const k of keys || []) {
      const r = await this.fail(k, { error, now });
      if (r && r.ok) n++;
    }
    return { failed: n };
  }

  /* ── تأیید سرور ⇒ حذف (تنها مسیر حذف موفق) ───────────────────────── */
  async ack(k) {
    const tx = this.db.transaction([STORE], 'readwrite');
    const store = tx.objectStore(STORE);
    const row = await promisify(store.get(k));
    if (!row) { await txDone(tx); return { ok: true, already: true }; }
    store.delete(k);
    await txDone(tx);
    this._emit('acked', { k });
    return { ok: true, k };
  }

  async ackMany(keys) {
    let n = 0;
    for (const k of keys || []) { const r = await this.ack(k); if (r.ok) n++; }
    return { ok: true, acked: n };
  }

  /* ── شکست ارسال: عقب‌نشینی نمایی؛ بعد از سقف تلاش → blocked ─────── */
  async fail(k, info = {}) {
    const now = info.now == null ? Date.now() : Number(info.now);
    const tx = this.db.transaction([STORE], 'readwrite');
    const store = tx.objectStore(STORE);
    const row = await promisify(store.get(k));
    if (!row) { await txDone(tx); return { ok: false, error: 'not_found' }; }
    row.attempts = Number(row.attempts || 0) + 1;
    row.last_error = String(info.error || 'send_failed').slice(0, 200);
    row.updated_at = new Date(now).toISOString();
    row.lease_until = 0;
    if (row.attempts >= this.cfg.maxAttempts) {
      row.state = 'blocked';
      row.next_at = 0;
    } else {
      const backoff = Math.min(this.cfg.baseBackoffMs * Math.pow(2, row.attempts - 1), this.cfg.maxBackoffMs);
      row.state = 'pending';
      row.next_at = now + backoff;
    }
    store.put(row);
    await txDone(tx);
    this._emit(row.state === 'blocked' ? 'blocked' : 'retry', { k, attempts: row.attempts, next_at: row.next_at });
    return { ok: true, k, state: row.state, attempts: row.attempts, next_at: row.next_at };
  }

  /* ── بازیابی پس از restart: اجاره‌های رهاشده → pending ───────────── */
  async recover(now = Date.now()) {
    const tx = this.db.transaction([STORE], 'readwrite');
    const store = tx.objectStore(STORE);
    const all = await promisify(store.getAll());
    let n = 0;
    for (const r of all) {
      if (r.state === 'inflight' && Number(r.lease_until || 0) > now) continue;
      if (r.state === 'inflight') {
        r.state = 'pending';
        r.lease_until = 0;
        r.updated_at = new Date(now).toISOString();
        store.put(r);
        n++;
      }
    }
    await txDone(tx);
    if (n) this._emit('recovered', { count: n });
    return { recovered: n };
  }

  async retry(k, now = Date.now()) {
    const tx = this.db.transaction([STORE], 'readwrite');
    const store = tx.objectStore(STORE);
    const row = await promisify(store.get(k));
    if (!row) { await txDone(tx); return { ok: false, error: 'not_found' }; }
    row.state = 'pending';
    row.attempts = 0;
    row.next_at = 0;
    row.lease_until = 0;
    row.updated_at = new Date(now).toISOString();
    store.put(row);
    await txDone(tx);
    return { ok: true, k };
  }

  async list(filter = {}) {
    const tx = this.db.transaction([STORE], 'readonly');
    const all = await promisify(tx.objectStore(STORE).getAll());
    await txDone(tx);
    const rows = all
      .filter(r => (filter.state ? r.state === filter.state : true))
      .sort((a, b) => Number(a.seq) - Number(b.seq));
    return rows.map(r => Object.assign({}, r));
  }

  async count(state) {
    const rows = await this.list(state ? { state } : {});
    return rows.length;
  }

  async stats() {
    const all = await this.list();
    const by = s => all.filter(r => r.state === s).length;
    const active = all.filter(r => ACTIVE.includes(r.state)).length;
    const inflight = all.filter(r => r.state === 'inflight');
    const oldest = all.reduce((m, r) => (r.created_at && (!m || r.created_at < m) ? r.created_at : m), null);
    return {
      total: all.length,
      pending: by('pending'),
      inflight: inflight.length,
      blocked: by('blocked'),
      active,
      capacity: this.cfg.capacity,
      used: active,
      full: active >= this.cfg.capacity,
      free: Math.max(0, this.cfg.capacity - active),
      oldest_created_at: oldest,
      lease_expired: inflight.filter(r => Number(r.lease_until || 0) <= Date.now()).length,
    };
  }

  /**
   * حلقهٔ ارسال: claim → send → ack/fail.
   * @param {object} o {send, now, limit, onApplied, onRejected, onConflict}
   */
  async drain(o = {}) {
    if (typeof o.send !== 'function') throw new Error('send_required');
    const limit = o.limit || this.cfg.batchLimit;
    const res = { batches: 0, claimed: 0, applied: 0, rejected: 0, conflicts: 0, failed: 0, stopped: null, retry_at: null };
    let now = o.now == null ? Date.now() : Number(o.now);
    for (;;) {
      const batch = await this.claim(limit, now);
      if (!batch.length) break;
      res.batches++;
      res.claimed += batch.length;
      const t0 = Date.now();
      let response = null;
      try {
        response = await o.send(batch.map(toWire));
      } catch (e) {
        /* شبکه قطع/برنامه بسته شد: همهٔ دسته با backoff برمی‌گردند و
           op ها می‌مانند؛ همان k دوباره فرستاده می‌شود. */
        for (const r of batch) {
          const f = await this.fail(r.k, { error: (e && e.message) || 'send_failed', now: (o.now == null ? Date.now() : Number(o.now)) });
          res.failed++;
          if (f.next_at) res.retry_at = Math.max(res.retry_at || 0, f.next_at);
        }
        res.stopped = 'network';
        res.send_ms = Date.now() - t0;
        break;
      }
      const applied = new Map(((response && response.applied) || []).map(a => [String(a.uid), a]));
      const rejected = new Map(((response && response.rejected) || []).map(a => [String(a.uid), a]));
      const conflicts = new Map(((response && response.conflicts) || []).map(a => [String(a.uid), a]));
      for (const r of batch) {
        const uid = r.k;
        if (rejected.has(uid)) {
          res.rejected++;
          if (o.onRejected) await o.onRejected(r, rejected.get(uid));
          await this.ack(uid);            /* از صف خارج، ولی در فهرست بررسی ثبت شده */
          continue;
        }
        if (conflicts.has(uid)) {
          res.conflicts++;
          if (o.onConflict) await o.onConflict(r, conflicts.get(uid));
          await this.ack(uid);
          continue;
        }
        if (applied.has(uid)) {
          res.applied++;
          if (o.onApplied) await o.onApplied(r, applied.get(uid));
          await this.ack(uid);
          continue;
        }
        /* عملیاتی که سرور نه تأیید و نه رد کرد: صف نباید آن را دور بریزد */
        await this.fail(uid, { error: 'no_verdict', now: (o.now == null ? Date.now() : Number(o.now)) });
        res.failed++;
      }
      res.send_ms = Date.now() - t0;
      if (!batch.length) break;
    }
    return res;
  }

  close() { try { this.db.close(); } catch (e) { /* noop */ } }
}

/* تبدیل رکورد صف به شکل wire که سرور انتظار دارد (قرارداد Sync v1) */
function toWire(rec) {
  const op = { uid: rec.k, collection: rec.collection, type: rec.type };
  if (rec.id != null && Number(rec.id) > 0) op.id = Number(rec.id);
  if (rec.localId != null) op.localId = rec.localId;
  if (rec.type === 'put') { op.data = rec.payload || {}; op.base_version = Number(rec.base_version || 0); }
  if (rec.at) op.at = rec.at;
  return op;
}

const api = { open, Outbox, DEFAULTS, DB_NAME, DB_VERSION, STORE, META, ACTIVE, toWire, newKey };
if (typeof module === 'object' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.PayeshOutbox = api;
