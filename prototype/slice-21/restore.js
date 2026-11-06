'use strict';
// نمونهٔ فنی ۲۱ — بکاپ امضاشده، بازیابی در قرنطینه، swap اتمی و آشتی پس از بازیابی
// مرجع: ۱۵ §۲.۱ (مانیفست امضاشده + بررسی پیش از بازیابی) · §۳ (رویه) · §۳.۲ (آشتی) · §۴ (رفع F‑02)

const crypto = require('node:crypto');
const { sha256, stableStringify, seal, open } = require('./vault');

const COLLECTIONS = ['students', 'grades', 'attendance', 'users'];
const PROTECTED = new Set(['users', 'sessions', 'audit']);   // از بکاپ کلاینت هرگز نوشته نمی‌شوند

class LiveDB {
  constructor({ collections = COLLECTIONS } = {}) {
    this.collections = collections;
    this.data = new Map(collections.map((c) => [c, []]));
    this.sessions = 0;
  }
  insert(collection, row) {
    if (!this.data.has(collection)) this.data.set(collection, []);
    this.data.get(collection).push({ ...row });
    return row;
  }
  all(collection) { return this.data.get(collection) || []; }
  counts() { const o = {}; for (const c of this.collections) o[c] = this.all(c).length; return o; }
  hash(collection) { return sha256(stableStringify([...this.all(collection)].sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1)))); }
  hashes() { const o = {}; for (const c of this.collections) o[c] = this.hash(c); return o; }
  totalRows() { return this.collections.reduce((a, c) => a + this.all(c).length, 0); }
  snapshot() {
    const rows = {};
    for (const c of this.collections) rows[c] = this.all(c).map((r) => ({ ...r }));
    return { counts: this.counts(), hashes: this.hashes(), rows };
  }
  replaceAll(snapshot) {
    for (const c of this.collections) this.data.set(c, (snapshot.rows[c] || []).map((r) => ({ ...r })));
  }
}

class BackupVault {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    const kp = crypto.generateKeyPairSync('ed25519');
    this.publicKey = kp.publicKey;
    this.privateKey = kp.privateKey;
    this.backups = new Map();
  }

  create({ tenantId, snapshot, key, level = 'B1', id = `bk-${this.now()}`, pendingWrites = 0 }) {
    const aad = `${tenantId}|${id}|${level}`;
    const box = seal(key, snapshot, aad);
    const manifest = {
      backup_id: id, tenant_id: tenantId, level, at: this.now(),
      counts: snapshot.counts, hashes: snapshot.hashes, hash: sha256(stableStringify(snapshot)),
      box_sha256: sha256(box.ct), bytes: Buffer.byteLength(box.ct, 'hex'),
      pending_writes: pendingWrites,
    };
    manifest.sig = crypto.sign(null, Buffer.from(stableStringify(manifest)), this.privateKey).toString('base64');
    const backup = { manifest, box, aad, key };
    this.backups.set(id, backup);
    return backup;
  }

  verify(backup) {
    const m = backup && backup.manifest;
    if (!m || !backup.box) return { ok: false, reason: 'malformed' };
    const payload = { ...m };
    delete payload.sig;
    const okSig = crypto.verify(null, Buffer.from(stableStringify(payload)), this.publicKey, Buffer.from(m.sig || '', 'base64'));
    if (!okSig) return { ok: false, reason: 'manifest_signature_invalid' };   // ۱۵ §۲.۱
    if (sha256(backup.box.ct) !== m.box_sha256) return { ok: false, reason: 'box_sha_mismatch' };
    return { ok: true };
  }

  // دست‌کاری عمدی برای آزمون منفی (فقط در نمونه)
  tamperBox(backup) {
    const ct = backup.box.ct;
    const flipped = (ct[0] === 'a' ? 'b' : 'a') + ct.slice(1);
    return { ...backup, box: { ...backup.box, ct: flipped } };
  }

  tamperManifest(backup) {
    const manifest = { ...backup.manifest, sig: Buffer.from('forged-signature').toString('base64') };
    return { ...backup, manifest };
  }

  open(backup) { return open(backup.key, backup.box, backup.aad); }
}

class Restorer {
  constructor({ vault, live, now = () => Date.now() } = {}) {
    this.vault = vault;
    this.live = live;
    this.now = now;
    this.history = [];
    this.audit = [];
  }

  _audit(entry) {
    const prev = this.audit.length ? this.audit[this.audit.length - 1].hash : 'GENESIS';
    const row = { ...entry, at: this.now(), prev_hash: prev };
    row.hash = sha256(JSON.stringify({ ...row, hash: undefined }));
    this.audit.push(row);
    return row;
  }

  // بازیابی: فقط owner + reason · قرنطینه پیش از swap · بدون نوشتن در صورت شکست بررسی
  restore({ actor, role, tenantId, backup, reason = '', outbox = [], clientBackup = null }) {
    if (role !== 'platform_owner') throw new Error('owner_required');
    if (!reason) throw new Error('reason_required');
    const t0 = Number(process.hrtime.bigint() / 1000n) / 1000;
    const liveBefore = this.live.counts();
    const liveHashBefore = this.live.hashes();

    const v = this.vault.verify(backup);
    if (!v.ok) {
      this._audit({ action: 'restore.deny', reason: v.reason, actor, tenant: tenantId });
      const err = new Error(`integrity_failed:${v.reason}`);
      err.reason = v.reason;
      throw err;   // صفر ردیف نوشته شد
    }

    const opened = this.vault.open(backup);
    if (!opened.ok) throw new Error('undecryptable');

    // ۱) قرنطینه: مقایسه از روی دادهٔ رمزگشایی‌شده، پیش از هر swap
    const snapshot = opened.value;
    const qCounts = {};
    const qHashes = {};
    for (const c of COLLECTIONS) {
      qCounts[c] = (snapshot.rows[c] || []).length;
      qHashes[c] = sha256(stableStringify([...(snapshot.rows[c] || [])].sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))));
    }
    const mismatch = COLLECTIONS.filter((c) => qCounts[c] !== backup.manifest.counts[c] || qHashes[c] !== backup.manifest.hashes?.[c]);
    if (mismatch.length) {
      this._audit({ action: 'restore.deny', reason: 'quarantine_mismatch', actor, tenant: tenantId });
      const err = new Error(`quarantine_mismatch:${mismatch.join(',')}`);
      err.mismatch = mismatch;
      throw err;   // محیط زنده دست‌نخورده
    }

    // ۲) swap اتمی + ابطال نشست‌ها (W1)
    const sessionsBefore = this.live.sessions;
    this.live.replaceAll(snapshot);
    this.live.sessions = 0;
    const quarantine = { counts: qCounts, hashes: qHashes, matched: true };

    // ۳) آشتی پس از بازیابی (۱۵ §۳.۲)
    const reconciliation = { applied: 0, conflicted: 0, lost: 0, quarantined: 0, rejected_protected_tables: 0 };
    const present = new Set();
    for (const c of COLLECTIONS) for (const r of this.live.all(c)) present.add(`${c}|${r.id}`);
    for (const op of outbox) {
      const key = `${op.collection}|${op.row.id}`;
      if (present.has(key)) { reconciliation.conflicted++; continue; }   // تعارض با موتور ۱۴ حل می‌شود
      this.live.insert(op.collection, { ...op.row, imported_from: 'outbox', imported_at: this.now() });
      present.add(key);
      reconciliation.applied++;
    }
    const declared = Number(backup.manifest.pending_writes || 0);
    reconciliation.lost = Math.max(0, declared - reconciliation.applied - reconciliation.conflicted);

    // ۴) بکاپ کلاینت هرگز روی users/sessions/audit نوشته نمی‌شود (رفع F‑02)
    if (clientBackup) {
      for (const [collection, rows] of Object.entries(clientBackup.rows || {})) {
        if (PROTECTED.has(collection)) { reconciliation.rejected_protected_tables += rows.length; continue; }
        for (const row of rows) {
          const key = `${collection}|${row.id}`;
          if (present.has(key)) { reconciliation.conflicted++; continue; }   // تکرار ⇒ بی‌اثر
          this.live.insert(collection, { ...row, imported_from: 'client', imported_at: this.now() });
          present.add(key);
          reconciliation.quarantined++;
        }
      }
    }

    const t1 = Number(process.hrtime.bigint() / 1000n) / 1000;
    const report = {
      tenant_id: tenantId,
      backup_id: backup.manifest.backup_id,
      backup_sha256: backup.manifest.hash,
      box_sha256: backup.manifest.box_sha256,
      actor, reason,
      verdict: 'verified',
      counts_before: liveBefore,
      counts_after: this.live.counts(),
      hash_before: liveHashBefore,
      hash_after: this.live.hashes(),
      sessions_revoked: sessionsBefore,
      quarantine,
      reconciliation,
      rto_ms: Math.round((t1 - t0) * 1000) / 1000,
      rpo_label: '≤ 24h (بدون WAL-archive) — هدف، نه اندازه‌گیری',
      at: this.now(),
    };
    report.sha256 = sha256(stableStringify(report));
    this._audit({ action: 'restore.swap', backup_id: report.backup_id, sha: report.sha256, actor });
    this.history.push(report);
    return report;
  }
}

module.exports = { LiveDB, BackupVault, Restorer, COLLECTIONS, PROTECTED };
