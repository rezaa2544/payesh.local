'use strict';
/* ───────────────────────────────────────────────────────────────────
   لایهٔ ذخیره‌سازی — SQLite (node:sqlite، بدون وابستگی بومی)
   مدل: یک جدول عمومی «records» با JSON + ستون‌های ایندکس‌دار.
   چرا؟ چون کلاینت با همین مجموعه‌ها کار می‌کند و لازم نیست ۸۷ جدول بسازیم.
   ─────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('\n  ✗ دیتابیس داخلی (node:sqlite) در این نسخهٔ Node نیست: ' + process.versions.node);
  console.error('    Node 22.5 یا بالاتر لازم است. یا از «npm start» استفاده کنید (خودش پرچم لازم را می‌زند)،');
  console.error('    یا دستور را با پرچم اجرا کنید: node --experimental-sqlite server/index.js\n');
  process.exit(1);
}
const { nowISO } = require('./util');

/* ستون‌های ایندکس برای کوئری‌های داغ (scope و تاریخ) */
const INDEXERS = {
  attendance: d => ({ ref1: d.class_id, ref2: d.student_id, day: d.date }),
  grades: d => ({ ref1: d.class_id, ref2: d.student_id, day: d.term || null }),
  users: d => ({ ref1: d.class_id, ref2: null, day: null }),
  parent_links: d => ({ ref1: d.parent_id, ref2: d.student_id, day: null }),
  schedule: d => ({ ref1: d.class_id, ref2: d.teacher_id, day: d.weekday }),
  leaves: d => ({ ref1: null, ref2: d.student_id, day: d.date }),
  internships: d => ({ ref1: null, ref2: d.student_id, day: d.date }),
  staff_attendance: d => ({ ref1: null, ref2: d.user_id, day: d.date }),
  announcements: d => ({ ref1: null, ref2: null, day: d.date }),
  devices: d => ({ ref1: d.user_id, ref2: null, day: null }),
};

/* ستون‌هایی که در نسخه‌های قدیمی نبودند و باید اضافه شوند */
const ADDED_COLUMNS = [
  ['pair_codes', 'code_plain', 'TEXT'],
  ['pair_codes', 'revoked_at', 'TEXT'],
];

class Store {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS records (
        collection TEXT NOT NULL,
        id         INTEGER NOT NULL,
        data       TEXT NOT NULL,
        version    INTEGER NOT NULL DEFAULT 1,
        ref1       INTEGER,
        ref2       INTEGER,
        day        TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        PRIMARY KEY (collection, id)
      );
      CREATE INDEX IF NOT EXISTS ix_records_sync ON records(collection, updated_at);
      /* قرارداد Sync v1: مکان‌نمای مرکب (updated_at, id) */
      CREATE INDEX IF NOT EXISTS ix_records_sync_id ON records(collection, updated_at, id);
      CREATE INDEX IF NOT EXISTS ix_records_ref1 ON records(collection, ref1, updated_at);
      CREATE INDEX IF NOT EXISTS ix_records_ref2 ON records(collection, ref2, updated_at);
      CREATE INDEX IF NOT EXISTS ix_records_day  ON records(collection, day);

      CREATE TABLE IF NOT EXISTS seq (collection TEXT PRIMARY KEY, n INTEGER NOT NULL);

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        name TEXT,
        platform TEXT,
        pin_hash TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_devices_user ON devices(user_id);

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        device_id TEXT,
        user_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS pair_codes (
        code_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_by INTEGER,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        code_plain TEXT,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        user_id INTEGER,
        role TEXT,
        device_id TEXT,
        collection TEXT,
        record_id INTEGER,
        action TEXT,
        before TEXT,
        after TEXT,
        ip TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_audit_at ON audit(at);

      CREATE TABLE IF NOT EXISTS sync_log (
        uid TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        user_id INTEGER,
        result TEXT
      );
    `);
    /* ستون‌های تازه در پایگاه‌های قدیمی (بدون از دست رفتن هیچ داده‌ای) */
    for (const [table, col, type] of ADDED_COLUMNS) {
      try {
        const cols = this.db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
        if (cols.length && cols.indexOf(col) < 0) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
      } catch (e) { /* جدول هنوز ساخته نشده یا ستون هست */ }
    }
  }

  /* آخرین زمان تغییر در همهٔ داده‌ها — برای «همگام‌سازی زندهٔ» هر ثانیه */
  maxUpdatedAt() {
    try {
      const r = this.db.prepare('SELECT MAX(updated_at) AS m FROM records').get();
      return (r && r.m) || '';
    } catch (e) { return ''; }
  }

  /* ── meta ── */
  getMeta(key, fallback = null) {
    const r = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    if (!r) return fallback;
    try { return JSON.parse(r.value); } catch (e) { return fallback; }
  }
  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value));
  }

  /* ── شناسه‌های یکتا به ازای هر مجموعه ── */
  nextId(collection) {
    const row = this.db.prepare('SELECT n FROM seq WHERE collection=?').get(collection);
    let n = row ? row.n : 0;
    /* اگر داده‌ای از قبل با شناسهٔ بزرگ‌تر آمده باشد (import)، از آن جلوتر برو */
    const maxRow = this.db.prepare('SELECT MAX(id) AS m FROM records WHERE collection=?').get(collection);
    if (maxRow && maxRow.m != null && maxRow.m >= n) n = maxRow.m;
    n += 1;
    this.db.prepare('INSERT INTO seq(collection,n) VALUES(?,?) ON CONFLICT(collection) DO UPDATE SET n=excluded.n')
      .run(collection, n);
    return n;
  }

  /* ── خواندن ── */
  getRow(collection, id) {
    return this.db.prepare('SELECT * FROM records WHERE collection=? AND id=?').get(collection, Number(id)) || null;
  }
  get(collection, id) {
    const r = this.getRow(collection, id);
    if (!r || r.deleted_at) return null;
    return Object.assign(JSON.parse(r.data), { _version: r.version, _updated_at: r.updated_at });
  }
  /* همهٔ ردیف‌ها (شامل حذف‌شده‌ها برای sync) */
  /* پیمایش افزایشی. اگر since_id داده شود، مکان‌نما «مرکب» است:
     (updated_at, id) — تا ردیف‌هایی که همان میلی‌ثانیهٔ مرز صفحه را دارند
     گم نشوند (قرارداد Sync v1، §۴). بدون since_id رفتار قدیمی حفظ می‌شود. */
  changedSince(collection, sinceISO, limit = 5000, sinceId = null) {
    if (sinceId != null && Number.isFinite(Number(sinceId))) {
      return this.db.prepare(
        `SELECT * FROM records WHERE collection=? AND (updated_at > ? OR (updated_at = ? AND id > ?))
         ORDER BY updated_at ASC, id ASC LIMIT ?`
      ).all(collection, sinceISO, sinceISO, Number(sinceId), limit);
    }
    return this.db.prepare(
      `SELECT * FROM records WHERE collection=? AND updated_at > ? ORDER BY updated_at ASC, id ASC LIMIT ?`
    ).all(collection, sinceISO, limit);
  }
  all(collection) {
    return this.db.prepare('SELECT * FROM records WHERE collection=? AND deleted_at IS NULL ORDER BY id').all(collection)
      .map(r => Object.assign(JSON.parse(r.data), { _version: r.version }));
  }
  byRef(collection, column, value) {
    if (column !== 'ref1' && column !== 'ref2') throw new Error('bad column');
    return this.db.prepare(`SELECT * FROM records WHERE collection=? AND ${column}=? AND deleted_at IS NULL ORDER BY id`)
      .all(collection, Number(value))
      .map(r => Object.assign(JSON.parse(r.data), { _version: r.version }));
  }
  count(collection, where = '', params = []) {
    const r = this.db.prepare(
      `SELECT COUNT(*) AS n FROM records WHERE collection=? AND deleted_at IS NULL ${where}`
    ).get(collection, ...params);
    return r ? r.n : 0;
  }

  /* ── نوشتن ── */
  insert(collection, data, opts = {}) {
    const id = opts.id != null ? Number(opts.id) : this.nextId(collection);
    const ts = opts.at || nowISO();
    const idx = (INDEXERS[collection] || (() => ({})))(Object.assign({ id }, data));
    this.db.prepare(
      `INSERT INTO records(collection,id,data,version,ref1,ref2,day,created_at,updated_at)
       VALUES(?,?,?,1,?,?,?,?,?)`
    ).run(collection, id, JSON.stringify(Object.assign({}, data, { id })),
      idx.ref1 == null ? null : Number(idx.ref1),
      idx.ref2 == null ? null : Number(idx.ref2),
      idx.day == null ? null : String(idx.day), ts, ts);
    return this.get(collection, id);
  }

  update(collection, id, patch) {
    const row = this.getRow(collection, id);
    if (!row) return null;
    const merged = Object.assign(JSON.parse(row.data), patch, { id: Number(id) });
    const idx = (INDEXERS[collection] || (() => ({})))(merged);
    const ts = nowISO();
    this.db.prepare(
      `UPDATE records SET data=?, version=version+1, ref1=?, ref2=?, day=?, updated_at=?, deleted_at=NULL
       WHERE collection=? AND id=?`
    ).run(JSON.stringify(merged),
      idx.ref1 == null ? null : Number(idx.ref1),
      idx.ref2 == null ? null : Number(idx.ref2),
      idx.day == null ? null : String(idx.day),
      ts, collection, Number(id));
    return this.get(collection, id);
  }

  remove(collection, id) {
    const ts = nowISO();
    this.db.prepare('UPDATE records SET deleted_at=?, updated_at=?, version=version+1 WHERE collection=? AND id=?')
      .run(ts, ts, collection, Number(id));
    return true;
  }

  versionOf(collection, id) {
    const r = this.getRow(collection, id);
    return r ? r.version : 0;
  }

  /* ── audit ── */
  audit(entry) {
    /* F‑01: هیچ رمز/هش/وریفایری در لاگ حسابرسی نمی‌نشیند */
    const clean = (v) => {
      if (v == null || typeof v !== 'object') return v;
      const out = Object.assign({}, v);
      for (const k of ['password_hash', 'phone_hash', 'password_plain', 'password_enc', '__password_verifier', 'secret', 'accessKey']) delete out[k];
      return out;
    };
    entry = Object.assign({}, entry, { before: clean(entry.before), after: clean(entry.after) });
    this.db.prepare(
      `INSERT INTO audit(at,user_id,role,device_id,collection,record_id,action,before,after,ip)
       VALUES(?,?,?,?,?,?,?,?,?,?)`
    ).run(nowISO(), entry.user_id || null, entry.role || null, entry.device_id || null,
      entry.collection || null, entry.record_id == null ? null : Number(entry.record_id),
      entry.action || null,
      entry.before == null ? null : JSON.stringify(entry.before).slice(0, 4000),
      entry.after == null ? null : JSON.stringify(entry.after).slice(0, 4000),
      entry.ip || null);
  }
  recentAudit(limit = 100) {
    return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(Math.min(limit, 500));
  }

  /* ── idempotency ── */
  syncSeen(uid) { return !!this.db.prepare('SELECT uid FROM sync_log WHERE uid=?').get(uid); }
  syncMark(uid, userId, result) {
    this.db.prepare('INSERT OR IGNORE INTO sync_log(uid,at,user_id,result) VALUES(?,?,?,?)')
      .run(uid, nowISO(), userId || null, JSON.stringify(result).slice(0, 500));
  }

  /* ── پشتیبان‌گیری ── */
  backupTo(dir, keep = 48) {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = nowISO().replace(/[:.]/g, '-');
    const file = path.join(dir, `payesh-${stamp}.sqlite`);
    this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const files = fs.readdirSync(dir).filter(f => /^payesh-.*\.sqlite$/.test(f)).sort();
    while (files.length > keep) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(dir, old)); } catch (e) { /* noop */ }
    }
    return file;
  }

  stats() {
    return {
      file: this.file,
      size_bytes: fs.existsSync(this.file) ? fs.statSync(this.file).size : 0,
      collections: this.db.prepare('SELECT collection, COUNT(*) AS n FROM records WHERE deleted_at IS NULL GROUP BY collection ORDER BY n DESC').all(),
    };
  }

  close() { try { this.db.close(); } catch (e) { /* noop */ } }
}

function openStore(file) { return new Store(file); }

module.exports = { openStore, INDEXERS };
