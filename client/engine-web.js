'use strict';
/* ═══════════════════════════════════════════════════════════════════
   موتور دادهٔ سمت کلاینت (IndexedDB) — ردیف ۳۹

   جای ذخیرهٔ «یک blob بزرگ» در localStorage/یک کلید IDB، هر ردیف محصول
   جداگانه در یک object store با ایندکس ذخیره می‌شود تا ۱۰۰هزار ردیف
   بدون بارگذاری کل دیتاست در حافظه قابل پرس‌وجو باشد.

   همین API است که صفحه‌های UI برای خواندن/نوشتن داده صدا می‌زنند
   (get/list/byRef/since/put/del) — چه در Node (مسیر امروز) و چه در
   مرورگر/WebView (مسیر این ردیف).

   بدون هیچ وابستگی: فقط IndexedDB استاندارد (W3C). در Node با
   fake-indexeddb آزموده می‌شود؛ در Chrome/WebView همان کد اجرا می‌شود.
   ═══════════════════════════════════════════════════════════════════ */

const DB_NAME = 'payesh_engine';
const DB_VERSION = 1;
const STORE = 'rows';
const DEFAULT_CHUNK = 2000;

let idb = null;
function factory() {
  if (idb) return idb;
  if (typeof globalThis.indexedDB !== 'undefined' && globalThis.indexedDB) { idb = globalThis.indexedDB; return idb; }
  throw new Error('indexeddb_unavailable');
}

function open(name = DB_NAME) {
  return new Promise((resolve, reject) => {
    const req = factory().open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'k' });
        os.createIndex('collection', 'collection', { unique: false });
        os.createIndex('refs', 'refKeys', { unique: false, multiEntry: true });
        os.createIndex('updated', ['collection', 'updated_at'], { unique: false });
      }
    };
    req.onsuccess = () => resolve(new Engine(req.result));
    req.onerror = () => reject(req.error || new Error('open_failed'));
  });
}

function refKeysOf(data, refFields) {
  const fields = refFields || Object.keys(data || {}).filter(k => /_id$|^id$/.test(k));
  const out = [];
  for (const f of fields) {
    const v = data && data[f];
    if (v === null || v === undefined || typeof v === 'object') continue;
    out.push(`${f}:${v}`);
  }
  return out;
}

class Engine {
  constructor(db, name = DB_NAME) {
    this.db = db;
    this.name = name;
    this._writes = 0;
    this._reads = 0;
  }

  /* یک تراکنش با نتیجهٔ درونی؛ cursorها با Promise خودشان مقدار را می‌دهند
     و تراکنش فقط وقتی کامل شود نتیجه برگردانده می‌شود. */
  _tx(mode, fn) {
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = this.db.transaction(STORE, mode); } catch (e) { return reject(e); }
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('tx_failed'));
      tx.onabort = () => reject(tx.error || new Error('tx_aborted'));
      try {
        const r = fn(tx.objectStore(STORE));
        if (r && typeof r.then === 'function') r.then(v => { result = v; }, e => reject(e));
      } catch (e) { try { tx.abort(); } catch (_) { /* noop */ } reject(e); }
    });
  }

  _req(r) {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error('req_failed'));
    });
  }

  /* ── نوشتن ── */
  async put(collection, id, data, { version = 1, refFields = null, updated_at = null } = {}) {
    const row = {
      k: `${collection}/${id}`, collection, id: Number(id), data: data || {},
      version, refKeys: refKeysOf(data, refFields),
      updated_at: updated_at || new Date().toISOString(),
    };
    this._writes++;
    return this._tx('readwrite', os => this._req(os.put(row))).then(() => row);
  }

  /* درج دسته‌ای در یک تراکنش — قلب بارگذاری ۱۰۰هزار ردیف */
  async putMany(rows, { refFields = null } = {}) {
    if (!Array.isArray(rows) || !rows.length) return 0;
    this._writes += rows.length;
    const now = new Date().toISOString();
    return this._tx('readwrite', os => {
      for (const r of rows) {
        os.put({
          k: `${r.collection}/${r.id}`, collection: r.collection, id: Number(r.id),
          data: r.data || {}, version: r.version || 1,
          refKeys: refKeysOf(r.data, r.refFields || refFields),
          updated_at: r.updated_at || now,
        });
      }
      return null;
    }).then(() => rows.length);
  }

  async loadChunked(rows, { chunk = DEFAULT_CHUNK, refFields = null, onProgress = null } = {}) {
    let done = 0;
    for (let i = 0; i < rows.length; i += chunk) {
      await this.putMany(rows.slice(i, i + chunk), { refFields });
      done += Math.min(chunk, rows.length - i);
      if (onProgress) onProgress(done, rows.length);
    }
    return done;
  }

  async del(collection, id) {
    this._writes++;
    return this._tx('readwrite', os => this._req(os.delete(`${collection}/${id}`)));
  }

  async clear() {
    return this._tx('readwrite', os => this._req(os.clear()));
  }

  /* ── خواندن ── */
  async get(collection, id) {
    this._reads++;
    const row = await this._tx('readonly', os => this._req(os.get(`${collection}/${id}`)));
    return row || null;
  }

  async count(collection) {
    this._reads++;
    const n = await this._tx('readonly', os => {
      if (!collection) return this._req(os.count());
      return this._req(os.index('collection').count(IDBKeyRange.only(collection)));
    });
    return Number(n || 0);
  }

  async list(collection, { limit = 100, offset = 0 } = {}) {
    this._reads++;
    const out = [];
    return this._tx('readonly', os => {
      const idx = os.index('collection');
      return new Promise((resolve, reject) => {
        let skipped = 0;
        const req = idx.openCursor(IDBKeyRange.only(collection));
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur || out.length >= limit) return resolve(out);
          if (skipped < offset) { skipped++; return cur.continue(); }
          out.push(cur.value);
          cur.continue();
        };
        req.onerror = () => reject(req.error || new Error('cursor_failed'));
      });
    });
  }

  /* همان کاری که UI برای «همهٔ حضور و غیاب این کلاس» می‌کند */
  async byRef(collection, field, value) {
    this._reads++;
    const key = `${field}:${value}`;
    const out = [];
    return this._tx('readonly', os => {
      const idx = os.index('refs');
      return new Promise((resolve, reject) => {
        const req = idx.openCursor(IDBKeyRange.only(key));
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return resolve(out);
          if (cur.value.collection === collection) out.push(cur.value);
          cur.continue();
        };
        req.onerror = () => reject(req.error || new Error('cursor_failed'));
      });
    });
  }

  /* همگام‌سازی: ردیف‌های تغییریافته بعد از یک مهر زمانی */
  async since(collection, isoTime, { limit = 1000 } = {}) {
    this._reads++;
    const range = IDBKeyRange.bound([collection, isoTime], [collection, '\uffff'], false, false);
    const out = [];
    return this._tx('readonly', os => {
      const idx = os.index('updated');
      return new Promise((resolve, reject) => {
        const req = idx.openCursor(range);
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur || out.length >= limit) return resolve(out);
          out.push(cur.value);
          cur.continue();
        };
        req.onerror = () => reject(req.error || new Error('cursor_failed'));
      });
    });
  }

  async stats() {
    const total = await this.count(null);
    const perCollection = {};
    const rows = await this._tx('readonly', os => {
      const out = {};
      return new Promise((resolve, reject) => {
        const req = os.index('collection').openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return resolve(out);
          const c = cur.value.collection;
          out[c] = (out[c] || 0) + 1;
          cur.continue();
        };
        req.onerror = () => reject(req.error || new Error('cursor_failed'));
      });
    });
    Object.assign(perCollection, rows);
    return { total, collections: perCollection, writes: this._writes, reads: this._reads };
  }

  close() { try { this.db.close(); } catch (e) { /* noop */ } }
}

/* برای بنچمارک: ساخت N ردیف نمونه بدون نگه‌داشتن حجم اضافی */
function makeRows(n, { collections = ['attendance', 'grades', 'users', 'schedule'], startId = 1 } = {}) {
  const rows = new Array(n);
  for (let i = 0; i < n; i++) {
    const c = collections[i % collections.length];
    const id = startId + i;
    rows[i] = {
      collection: c, id, version: 1,
      data: {
        id, class_id: (i % 40) + 1, student_id: (i % 900) + 1,
        teacher_id: (i % 25) + 1, status: ['present', 'absent', 'late'][i % 3],
        score: (i % 20) + 0.5, date: '2026-11-' + String((i % 28) + 1).padStart(2, '0'),
        note: 'ردیف نمونهٔ شمارهٔ ' + i,
      },
      updated_at: new Date(Date.UTC(2026, 10, 1, 0, 0, i % 60)).toISOString(),
    };
  }
  return rows;
}

const api = { open, Engine, makeRows, DB_NAME, STORE, DB_VERSION, DEFAULT_CHUNK };
if (typeof module === 'object' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.PayeshEngine = api;
