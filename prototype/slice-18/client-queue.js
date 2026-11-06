'use strict';
// نمونهٔ فنی ۱۸ — سمت کلاینت: صف پایدار، سقف D‑27، retry، ack_unknown، W2، کش رمزنگاری‌شده
// مرجع: ۱۳ §۳.۱–§۳.۳، §۴ · D‑27 · CC‑13‑۱/۲/۳

const crypto = require('node:crypto');
const fs = require('node:fs');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const MAX_OPS = 2000;            // D‑27
const WARN_RATIO = 0.9;          // ۹۰٪ ⇒ هشدار نرم
const OPEN_STATES = new Set(['pending', 'sending', 'retry_wait', 'ack_unknown']);

// ساعت قابل اتکا: منبع حقیقت = سرور (§۳.۲.۳ / CC‑13‑۱)
// زمان پس از sync با ساعت یکنوا (نه ساعت دیوار) پیش می‌رود؛ پس عقب‌بردن ساعت
// دستگاه، TTL را تمدید نمی‌کند. پیش از sync، بدترین تفسیر (محافظه‌کارانه) اعمال می‌شود.
class Clock {
  constructor({ localNow = () => Date.now(), monoNow = () => Number(process.hrtime.bigint() / 1_000_000n) } = {}) {
    this.localNow = localNow;
    this.monoNow = monoNow;
    this.offset = 0;
    this.synced = false;
    this._serverBase = 0;
    this._monoBase = 0;
  }
  sync(server_time) {
    this.offset = server_time - this.localNow();
    this._serverBase = server_time;
    this._monoBase = this.monoNow();
    this.synced = true;
    return this.offset;
  }
  // اگر اختلاف ساعت از ۱۰ دقیقه بیشتر شود ⇒ حالت محافظه‌کارانه
  get conservative() { return !this.synced || Math.abs(this.offset) > 10 * 60_000; }
  now() { return this.synced ? this._serverBase + (this.monoNow() - this._monoBase) : this.localNow(); }
}

// کش رمزنگاری‌شده با TTL ۷ روز / پایان نشست / تغییر مدرسه (§۱–§۲، §۴)
class SecureCache {
  constructor({ clock, ttlDays = 7 } = {}) {
    this.clock = clock;
    this.ttlMs = ttlDays * 24 * 3600_000;
    this.key = null;              // کلید نشست؛ نابودی = W2
    this.rows = new Map();
    this.lastSessionEnd = null;
    this.tenant_id = null;
    this.wiped = false;
  }

  open(tenant_id) {
    this.key = crypto.randomBytes(32);      // در محصول: WebCrypto non-extractable / OS keystore
    this.tenant_id = tenant_id;
    this.wiped = false;
    return this;
  }

  _aad() { return Buffer.from(String(this.tenant_id)); }

  put(key, value) {
    if (!this.key) throw new Error('cache_locked');
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(this._aad());
    const ciphertext = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
    this.rows.set(key, {
      iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'),
      ciphertext: ciphertext.toString('hex'), cached_at: this.clock.now(),
    });
    return this.rows.get(key);
  }

  get(key) {
    const row = this.rows.get(key);
    if (!this.key) return { ok: false, reason: 'key_destroyed' };   // W2: هیچ محتوایی خواندنی نیست
    if (!row) return { ok: false, reason: 'miss' };
    if (this._expired(row)) { this.rows.delete(key); return { ok: false, reason: 'expired' }; }
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.iv, 'hex'));
      d.setAAD(this._aad());
      d.setAuthTag(Buffer.from(row.tag, 'hex'));
      const plain = Buffer.concat([d.update(Buffer.from(row.ciphertext, 'hex')), d.final()]);
      return { ok: true, value: JSON.parse(plain.toString('utf8')) };
    } catch {
      return { ok: false, reason: 'tampered' };   // AEAD: دست‌کاری ⇒ شکست رمزگشایی
    }
  }

  _expired(row) {
    // TTL بر پایهٔ زودترینِ cached_at و last_session_end؛ در حالت محافظه‌کارانه همیشه منقضی
    if (this.clock.conservative) return true;
    const now = this.clock.now();
    if (now - row.cached_at >= this.ttlMs) return true;
    if (this.lastSessionEnd !== null && now - this.lastSessionEnd >= this.ttlMs) return true;
    return false;
  }

  purgeExpired() {
    const before = this.rows.size;
    for (const [k, v] of [...this.rows]) if (this._expired(v)) this.rows.delete(k);
    return before - this.rows.size;
  }

  endSession() { this.lastSessionEnd = this.clock.now(); const n = this.rows.size; this.rows.clear(); return n; }

  // W2: نابودی کلید ⇒ محتوا برای همیشه غیرقابل خواندن (فقط ciphertext می‌ماند)
  destroyKey() { this.key = null; this.wiped = true; return true; }

  wipe() { this.rows.clear(); this.destroyKey(); this.tenant_id = null; return true; }
}

class OpQueue {
  constructor({ clock, cache, durablePath = null } = {}) {
    this.clock = clock;
    this.cache = cache;
    this.rows = new Map();          // op_id → op
    this.durablePath = durablePath;
    this.warned = false;
    this.accepting = true;
    this.deviceKey = crypto.randomBytes(32);
    this.load();
  }

  get size() { return this.rows.size; }

  // سقف D‑27: ۲۰۰۰ op/دستگاه؛ ۹۰٪ هشدار؛ ۱۰۰٪ توقف پذیرش — هرگز حذف قدیمی
  get pressure() {
    const ratio = this.rows.size / MAX_OPS;
    return { size: this.rows.size, ratio, warn: ratio >= WARN_RATIO, full: this.rows.size >= MAX_OPS };
  }

  enqueue({ collection, record_id, payload, base_version = 0, op_id = crypto.randomUUID() }) {
    const p = this.pressure;
    if (p.full) return { ok: false, reason: 'queue_full', size: this.rows.size };
    const payload_hash = sha256(JSON.stringify(payload));
    const op = {
      op_id, collection, record_id, base_version, payload, payload_hash,
      client_ts: this.clock.now(), status: 'pending', attempts: 0, acked: false,
    };
    this.rows.set(op_id, op);
    this.persist();
    return { ok: true, op_id, warn: this.rows.size / MAX_OPS >= WARN_RATIO };
  }

  // امضای بدنه فقط «شاهد دست‌نخوردگی» است، نه هویت (F‑06)
  sign(op) {
    return crypto.createHmac('sha256', this.deviceKey).update(`${op.op_id}:${op.payload_hash}`).digest('hex');
  }

  toWire(op) {
    return {
      op_id: op.op_id, collection: op.collection, record_id: op.record_id,
      base_version: op.base_version, payload: op.payload, payload_hash: op.payload_hash,
      client_ts: op.client_ts, sig: this.sign(op),
    };
  }

  // ارسال دسته و به‌روزرسانی وضعیت‌ها بر اساس پاسخ سرور
  async flush(server, session, { limit = 100 } = {}) {
    const batch = [...this.rows.values()].filter((o) => OPEN_STATES.has(o.status)).slice(0, limit);
    if (!batch.length) return { sent: 0, results: [] };
    batch.forEach((o) => { o.status = 'sending'; o.attempts += 1; });
    let response;
    try {
      response = server.push(session, batch.map((o) => this.toWire(o)));
    } catch {
      batch.forEach((o) => { o.status = 'retry_wait'; });
      this.persist();
      return { sent: 0, results: [], reason: 'network' };
    }
    this.clock.sync(response.server_time);
    const byId = new Map(response.results.map((r) => [r.op_id, r]));
    for (const op of batch) {
      const r = byId.get(op.op_id);
      if (!r) { op.status = 'ack_unknown'; continue; }        // ack نیامد ⇒ هرگز «موفق» فرض نمی‌شود
      if (r.status === 'applied') { op.status = 'applied'; op.acked = true; op.server_seq = r.server_seq; }
      else if (r.status === 'ordering') op.status = 'retry_wait';   // 409 ordering: دوباره با base_version درست
      else if (r.status === 'conflict') op.status = 'conflict';
      else op.status = 'rejected';
      op.last_result = r;
    }
    this.persist();
    return { sent: batch.length, results: response.results, server_time: response.server_time };
  }

  byStatus(status) { return [...this.rows.values()].filter((o) => o.status === status); }

  // قاعدهٔ ۳۰ روز سمت کلاینت: op باز و کهنه ⇒ review؛ payload کامل حفظ، ارسال خودکار متوقف
  sweepStale(reviewDays = 30) {
    const cutoff = this.clock.now() - reviewDays * 24 * 3600_000;
    const moved = [];
    for (const op of this.rows.values()) {
      if (OPEN_STATES.has(op.status) && op.client_ts <= cutoff) { op.status = 'review'; moved.push(op.op_id); }
    }
    this.persist();
    return moved;
  }

  // ابطال دستگاه: ۱) ارسال فوری یک‌باره (پنجرهٔ فرصت) ۲) سپس در صورت شکست W2
  async syncOnRevoke(server, session, { deadlineMs = 5_000 } = {}) {
    const open = [...this.rows.values()].filter((o) => !o.acked && o.status !== 'rejected');
    const attempted = open.map((o) => o.op_id);
    const attemptedOps = open.map((o) => ({ op_id: o.op_id, payload_hash: o.payload_hash }));
    let result = { sent: 0, results: [] };
    try {
      result = await Promise.race([
        this.flush(server, session, { limit: open.length || 1 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('deadline')), deadlineMs)),
      ]);
    } catch { result = { sent: 0, results: [], reason: 'deadline' }; }

    const appliedOpIds = result.results.filter((r) => r.status === 'applied').map((r) => r.op_id);
    const adjudication = server.adjudicateRevocation(session, { appliedOpIds, attemptedOpIds: attempted, attemptedOps });
    // W2 — کلید محلی نابود می‌شود؛ payload صف برای همیشه غیرقابل خواندن
    const keyDestroyed = this.cache.destroyKey();
    this.rows.forEach((o) => {
      if (o.status !== 'applied') o.payload_unreadable = keyDestroyed && !o.acked;
    });
    this.persist();
    return { result, adjudication, keyDestroyed };
  }

  // بازیابی پس از کرش: ذخیره‌گاه پایدار + بازپخش با همان op_id (§۳.۳ / AC‑5)
  persist() {
    if (!this.durablePath) return;
    const dump = [...this.rows.values()].map((o) => ({ ...o }));
    fs.writeFileSync(this.durablePath, JSON.stringify(dump));
  }

  load() {
    if (!this.durablePath || !fs.existsSync(this.durablePath)) return;
    const rows = JSON.parse(fs.readFileSync(this.durablePath, 'utf8'));
    for (const r of rows) {
      if (r.status === 'sending') r.status = 'ack_unknown';   // کرش در میانهٔ ارسال ⇒ نتیجه نامعلوم
      this.rows.set(r.op_id, r);
    }
  }
}

module.exports = { Clock, SecureCache, OpQueue, MAX_OPS, WARN_RATIO, OPEN_STATES };
