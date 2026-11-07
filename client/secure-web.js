'use strict';
/* ═══════════════════════════════════════════════════════════════════
   لایهٔ امن دادهٔ روی دستگاه — ردیف ۴۴

   مسئله: کش محلی محصول امروز به‌صورت متن روشن در localStorage/IndexedDB
   می‌نشیند. هر کسی که فایل مرورگر (یا پروفایل WebView) را کپی کند،
   همهٔ دادهٔ مدرسه را می‌خواند.

   این ماژول همان داده را «در حالت سکون» رمز می‌کند:
     • ردیف‌ها جداگانه ذخیره می‌شوند (مثل ردیف ۳۹) ولی payload هر ردیف
       با AES-GCM-256 رمز شده است؛ فقط `k` (کلید ردیف)، `collection` و
       `updated_at` برای پرس‌وجو روشن می‌مانند (ریسک باقی‌ماندهٔ ثبت‌شده).
     • کلید از یک «راز دستگاه» با PBKDF2-SHA256 (۲۱۰٬۰۰۰ دور) مشتق
       می‌شود و **هیچ‌جا در کد/باندل نیست**؛ نه در باندل، نه در فایل،
       نه در دیتابیس. مشتق‌شده هم non-extractable است: exportKey روی آن
       شکست می‌خورد، پس حتی خودِ برنامه هم نمی‌تواند بایت خام کلید را
       بخواند.
     • کپی دیتابیس روی دستگاه دیگر ⇒ بدون راز دستگاه، داده بی‌مصرف است.
     • lock() کلید را از حافظه می‌اندازد ⇒ خواندن تا unlock ناممکن.
     • wipe() کلید و نمک را نابود و ردیف‌ها را پاک می‌کند (W2+W3 در
       سند ۱۳ §۳.۲.۲) — پس از آن هیچ راهی برای بازگشایی نیست.
     • ابطال نشست/دستگاه سمت سرور ⇒ در اولین همگام‌سازی، wipe اجرا
       می‌شود (handleRevocation).

   بدون هیچ وابستگی: فقط WebCrypto و IndexedDB استاندارد.
   تصمیم O‑03 (طراحی کلید در حالت سکون) در همین ردیف بسته می‌شود:
   docs/cloud/44-device-security.md
   ═══════════════════════════════════════════════════════════════════ */

const DB_NAME = 'payesh_secure';
const DB_VERSION = 1;
const STORE = 'secure';
const META = 'meta';

const KDF = {
  name: 'PBKDF2',
  hash: 'SHA-256',
  iterations: 210000,
  saltBytes: 16,
  keyBytes: 256,
};

class SecureError extends Error {
  constructor(code, details = null) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

/* ── ابزارهای پایه ─────────────────────────────────────────────────── */

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new SecureError('webcrypto_unavailable');
  return c.subtle;
}

function randomBytes(n) {
  const c = globalThis.crypto;
  if (!c || !c.getRandomValues) throw new SecureError('webcrypto_unavailable');
  return c.getRandomValues(new Uint8Array(n));
}

function idbFactory() {
  const f = globalThis.indexedDB;
  if (!f) throw new SecureError('indexeddb_unavailable');
  return f;
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new SecureError('idb_error'));
  });
}

function openDb(name) {
  return new Promise((resolve, reject) => {
    const r = idbFactory().open(name, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'k' });
        os.createIndex('collection', 'collection', { unique: false });
        os.createIndex('updated', ['collection', 'updated_at'], { unique: false });
      }
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new SecureError('idb_open_failed'));
  });
}

/* راز دستگاه باید رشتهٔ غیرخالی باشد؛ هیچ پیش‌فرضی در کد نیست */
function normalizeSecret(secret) {
  const s = String(secret == null ? '' : secret);
  if (s.length < 8) throw new SecureError('weak_device_secret', { min: 8, got: s.length });
  return s;
}

async function deriveKey(secret, salt, iterations) {
  const s = normalizeSecret(secret);
  const base = await subtle().importKey('raw', new TextEncoder().encode(s), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: KDF.hash },
    base,
    { name: 'AES-GCM', length: KDF.keyBytes },
    false,                        /* ← non-extractable: کلید خام هرگز بیرون نمی‌آید */
    ['encrypt', 'decrypt']
  );
}

/* ── کلاس اصلی ─────────────────────────────────────────────────────── */

class SecureStore {
  constructor(db, name) {
    this.db = db;
    this.name = name;
    this.key = null;
    this.meta = null;
    this.reads = 0;
    this.writes = 0;
    this.locks = 0;
    this.wipes = 0;
  }

  static async open({ name = DB_NAME, secret, iterations = KDF.iterations } = {}) {
    const db = await openDb(name);
    const store = new SecureStore(db, name);
    await store._loadMeta();
    if (!store.meta) {
      const salt = randomBytes(KDF.saltBytes);
      store.meta = {
        key: 'kdf',
        kdf: KDF.name,
        hash: KDF.hash,
        iterations,
        salt,
        created_at: new Date().toISOString(),
      };
      await store._putMeta(store.meta);
    }
    if (secret) await store.unlock(secret);
    return store;
  }

  get locked() { return !this.key; }

  isLocked() { return this.locked; }

  async _loadMeta() {
    const tx = this.db.transaction(META, 'readonly');
    const r = await req(tx.objectStore(META).get('kdf'));
    this.meta = r || null;
  }

  async _putMeta(rec) {
    const tx = this.db.transaction(META, 'readwrite');
    tx.objectStore(META).put(rec);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  }

  async _delMeta(key) {
    const tx = this.db.transaction(META, 'readwrite');
    tx.objectStore(META).delete(key);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  }

  async unlock(secret) {
    const s = normalizeSecret(secret);
    this.key = await deriveKey(s, this.meta.salt, this.meta.iterations);
    return { unlocked: true, iterations: this.meta.iterations, kdf: this.meta.kdf };
  }

  lock() {
    this.key = null;
    this.locks++;
    return { locked: true };
  }

  _requireKey() {
    if (!this.key) throw new SecureError('locked');
    return this.key;
  }

  async _seal(obj) {
    const key = this._requireKey();
    const iv = randomBytes(12);
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
    return { iv, ct };
  }

  async _open(rec) {
    const key = this._requireKey();
    let plain;
    try {
      plain = await subtle().decrypt({ name: 'AES-GCM', iv: rec.iv }, key, rec.ct);
    } catch (e) {
      throw new SecureError('decrypt_failed', { k: rec.k });
    }
    let parsed;
    try { parsed = JSON.parse(new TextDecoder().decode(plain)); }
    catch (e) { throw new SecureError('decrypt_failed', { k: rec.k, reason: 'json' }); }
    this.reads++;
    return {
      collection: rec.collection,
      id: parsed.id,
      version: parsed.version,
      data: parsed.data,
      updated_at: rec.updated_at,
    };
  }

  async put(collection, id, data, { version = 1, updated_at = new Date().toISOString() } = {}) {
    const col = String(collection);
    const rid = Number(id);
    if (!col) throw new SecureError('bad_collection');
    if (!Number.isFinite(rid)) throw new SecureError('bad_id');
    const { iv, ct } = await this._seal({ id: rid, version: Number(version) || 1, data: data == null ? null : data });
    const rec = { k: col + ':' + rid, collection: col, updated_at: String(updated_at), v: 1, iv, ct };
    const tx = this.db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(rec);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    this.writes++;
    return { collection: col, id: rid, updated_at: rec.updated_at };
  }

  async putMany(rows, { chunk = 500 } = {}) {
    const list = Array.isArray(rows) ? rows : [];
    let n = 0;
    for (let i = 0; i < list.length; i += chunk) {
      const slice = list.slice(i, i + chunk);
      /* رمزکردن‌ها موازی، نوشتن در یک تراکنش */
      const sealed = await Promise.all(slice.map(async r => {
        const col = String(r.collection);
        const rid = Number(r.id);
        if (!col) throw new SecureError('bad_collection');
        if (!Number.isFinite(rid)) throw new SecureError('bad_id');
        const { iv, ct } = await this._seal({ id: rid, version: Number(r.version) || 1, data: r.data == null ? null : r.data });
        return {
          k: col + ':' + rid, collection: col,
          updated_at: String(r.updated_at || new Date().toISOString()), v: 1, iv, ct,
        };
      }));
      const tx = this.db.transaction(STORE, 'readwrite');
      const os = tx.objectStore(STORE);
      for (const rec of sealed) os.put(rec);
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
      n += sealed.length;
      this.writes += sealed.length;
    }
    return { written: n };
  }

  async get(collection, id) {
    this._requireKey();
    const tx = this.db.transaction(STORE, 'readonly');
    const rec = await req(tx.objectStore(STORE).get(String(collection) + ':' + Number(id)));
    if (!rec) return null;
    return this._open(rec);
  }

  async list(collection, { limit = 200 } = {}) {
    this._requireKey();
    const tx = this.db.transaction(STORE, 'readonly');
    const idx = tx.objectStore(STORE).index('collection');
    const recs = await req(idx.getAll(String(collection), Number(limit) || 200));
    return Promise.all(recs.map(r => this._open(r)));
  }

  async since(collection, iso, { limit = 500 } = {}) {
    this._requireKey();
    const col = String(collection);
    const from = String(iso || '');
    const tx = this.db.transaction(STORE, 'readonly');
    const idx = tx.objectStore(STORE).index('updated');
    const range = IDBKeyRange.bound([col, from], [col, '\uffff']);
    const recs = await req(idx.getAll(range, Number(limit) || 500));
    return Promise.all(recs.map(r => this._open(r)));
  }

  /* byRef روی payload رمزشده ایندکس‌پذیر نیست؛ رمزگشایی و پالایش می‌شود.
     هزینه‌اش برای مجموعهٔ محدود کالکشن قابل قبول است و در ۴۴ مستند شده. */
  async byRef(collection, field, value) {
    this._requireKey();
    const rows = await this.listAll(collection);
    const f = String(field);
    return rows.filter(r => r.data && String(r.data[f]) === String(value));
  }

  async listAll(collection) {
    this._requireKey();
    const tx = this.db.transaction(STORE, 'readonly');
    const idx = tx.objectStore(STORE).index('collection');
    const recs = await req(idx.getAll(String(collection)));
    return Promise.all(recs.map(r => this._open(r)));
  }

  async count(collection = null) {
    const tx = this.db.transaction(STORE, 'readonly');
    const os = tx.objectStore(STORE);
    const n = collection == null
      ? await req(os.count())
      : await req(os.index('collection').count(String(collection)));
    return n;
  }

  async stats() {
    const total = await this.count(null);
    const out = { total, collections: {}, locked: this.locked, reads: this.reads, writes: this.writes, locks: this.locks, wipes: this.wipes };
    const tx = this.db.transaction(STORE, 'readonly');
    const keys = await req(tx.objectStore(STORE).index('collection').getAllKeys());
    for (const k of keys) {
      const col = String(k).split(':')[0];
      out.collections[col] = (out.collections[col] || 0) + 1;
    }
    return out;
  }

  async del(collection, id) {
    const tx = this.db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(String(collection) + ':' + Number(id));
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    return { deleted: true };
  }

  async clear(collection = null) {
    if (collection == null) {
      const tx = this.db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
      return { cleared: 'all' };
    }
    const tx = this.db.transaction(STORE, 'readwrite');
    const idx = tx.objectStore(STORE).index('collection');
    const keys = await req(idx.getAllKeys(String(collection)));
    const os = tx.objectStore(STORE);
    for (const k of keys) os.delete(k);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    return { cleared: String(collection), rows: keys.length };
  }

  /* چرخش راز: همان ردیف‌ها، نمک تازه، کلید تازه. راز قدیمی دیگر کار نمی‌کند. */
  async rotate(newSecret) {
    const rows = [];
    const keys = [];
    {
      const tx = this.db.transaction(STORE, 'readonly');
      const recs = await req(tx.objectStore(STORE).getAll());
      for (const rec of recs) { keys.push(rec); rows.push(await this._open(rec)); }
    }
    const salt = randomBytes(KDF.saltBytes);
    this.meta = Object.assign({}, this.meta, { salt, iterations: this.meta.iterations, rotated_at: new Date().toISOString() });
    await this._putMeta(this.meta);
    this.key = await deriveKey(newSecret, salt, this.meta.iterations);
    const payload = rows.map(r => ({ collection: r.collection, id: r.id, version: r.version, data: r.data, updated_at: r.updated_at }));
    if (keys.length) await this.clear(null);
    if (payload.length) await this.putMany(payload);
    return { rotated: true, rows: payload.length };
  }

  /* W2 + W3: نابودی کلید/نمک و پاک‌سازی ردیف‌ها؛ پس از آن بازگشایی ناممکن است. */
  async wipe(reason = 'manual') {
    const before = await this.count(null);
    this.key = null;
    await this._delMeta('kdf');
    this.meta = null;
    const tx = this.db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    this.wipes++;
    return {
      wiped: true, reason: String(reason), rows_deleted: before,
      key_destroyed: true, salt_destroyed: true, at: new Date().toISOString(),
    };
  }

  /* ابطال دستگاه/نشست: پنجرهٔ ارسال فوری (sync-on-revoke) بیرون این ماژول
     است؛ این‌جا فقط تعیین تکلیف محلی انجام می‌شود — بدون ACK کاذب. */
  async handleRevocation({ reason = 'device_revoked', notify = null } = {}) {
    const out = await this.wipe(reason);
    if (typeof notify === 'function') { try { notify(out); } catch (e) { /* noop */ } }
    return out;
  }

  close() { try { this.db.close(); } catch (e) { /* noop */ } }
}

/* ── پوشش نازک برای کش محصول (کلید='data') ────────────────────────────
   app.js همان `data` را می‌نویسد/می‌خواند؛ این‌جا فقط رمزشده. */
async function cacheStore({ secret, name = 'payesh_cache_secure' } = {}) {
  return SecureStore.open({ name, secret });
}

const api = { SecureStore, SecureError, cacheStore, KDF, DB_NAME, STORE, META };
if (typeof module === 'object' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.PayeshSecure = api;
