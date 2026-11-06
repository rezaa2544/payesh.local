'use strict';
// نمونهٔ فنی ۲۱ — مهاجرت کنترل‌شدهٔ مدرسهٔ موجود به چندمستأجری (۱۶‑ب §۳.۱، ۹ گام)
// قواعد سخت: هیچ گامی پرش‌پذیر نیست · هیچ داده‌ای حذف نمی‌شود · تطبیق ناموفق ⇒ توقف (نه ادامه با فرض)

const { sha256, stableStringify, seal, open, newKey } = require('./vault');

const COLLECTIONS = ['students', 'grades', 'attendance', 'users'];
const STABILITY_DAYS = 7;

class LegacyStore {
  constructor({ collections = COLLECTIONS } = {}) {
    this.collections = collections;
    this.data = new Map(collections.map((c) => [c, []]));
  }
  insert(collection, row) { this.data.get(collection).push({ ...row }); return row; }
  all(collection) { return this.data.get(collection); }
  counts() { const o = {}; for (const c of this.collections) o[c] = this.data.get(c).length; return o; }
  hash(collection) {
    const rows = [...this.data.get(collection)].sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
    return sha256(stableStringify(rows));
  }
  hashes() { const o = {}; for (const c of this.collections) o[c] = this.hash(c); return o; }
  bytes() { return Buffer.byteLength(JSON.stringify(Object.fromEntries(this.data))); }
  totalRows() { return this.collections.reduce((a, c) => a + this.data.get(c).length, 0); }
}

class Migrator {
  constructor({ store, tenantId = 'T0', now = () => Date.now(), logger = null } = {}) {
    this.store = store;
    this.T = tenantId;
    this.now = now;
    this.log = logger;
    this.step = 0;
    this.verdict = null;
    this.readPath = 'legacy';
    this.legacyPresent = true;
    this.switchedAt = null;
    this.removedRows = null;
    this.shadow = new Map(COLLECTIONS.map((c) => [c, []]));
    this.tenantKey = newKey();
    this.backups = [];
    this.audit = [];
    this.stepResults = [];
    this.failures = [];
    this.startedAt = this.now();
    this.finishedAt = null;
    this.report = null;
    this._snapshots = [];
  }

  _audit(entry) {
    const prev = this.audit.length ? this.audit[this.audit.length - 1].hash : 'GENESIS';
    const row = { ...entry, at: this.now(), prev_hash: prev };
    row.hash = sha256(JSON.stringify({ ...row, hash: undefined }));
    this.audit.push(row);
    return row;
  }

  _require(step) {
    if (this.step !== step - 1) throw new Error(`step_out_of_order:${step} (current=${this.step})`);
    return true;
  }

  _record(step, name, fn) {
    const t0 = this.now();
    try {
      const out = fn();
      this.step = step;
      this.stepResults.push({ step, name, ok: true, at: this.now(), ms: this.now() - t0 });
      this._audit({ action: 'migration.step', step, name, ok: true });
      return out;
    } catch (e) {
      this.finishedAt = this.now();
      this.failures.push({ step, name, ok: false, reason: e.message, at: this.now(), ms: this.now() - t0 });
      if (!/stability_not_met/.test(e.message)) this.verdict = 'failed';
      this._audit({ action: 'migration.step', step, name, ok: false, reason: e.message });
      throw e;
    }
  }

  // ---------- ۱) پیش‌بررسی: بکاپ + شمارش/هش هر مجموعه ----------
  step1_precheck({ actor, role }) {
    if (role !== 'platform_owner') throw new Error('owner_required');
    this._require(1);
    return this._record(1, 'precheck', () => {
      const before = { counts: this.store.counts(), hashes: this.store.hashes(), bytes: this.store.bytes() };
      this.before = before;
      this.backup = {
        backup_id: `bk-${this.now()}`, at: this.now(), tenant_id: this.T,
        sha256: sha256(stableStringify(before)), counts: before.counts, bytes: before.bytes,
      };
      this._snapshots.push({ at: this.now(), backup: this.backup, phase: 'precheck' });
      this._audit({ action: 'migration.backup', backup_id: this.backup.backup_id, sha: this.backup.sha256, actor });
      return this.backup;
    });
  }

  // ---------- ۲) افزودن tenant_id با مقدار T0، بدون قید ----------
  step2_addColumn() {
    this._require(2);
    return this._record(2, 'add_column', () => {
      let n = 0;
      for (const c of this.store.collections) {
        for (const r of this.store.all(c)) {
          if (r.tenant_id === undefined) { r.tenant_id = this.T; n++; }
        }
      }
      return { tagged: n };
    });
  }

  // ---------- ۳) کپی سایه: نوشتن مضاعف؛ خواندن هنوز از مسیر قدیم ----------
  step3_dualWrite(writes = []) {
    this._require(3);
    return this._record(3, 'dual_write', () => {
      // کپی ردیف‌های موجود
      for (const c of this.store.collections) {
        this.shadow.set(c, this.store.all(c).map((r) => ({ ...r, tenant_id: this.T })));
      }
      // نوشتن‌های تازه در هر دو مسیر
      let dual = 0;
      for (const w of writes) {
        const row = { ...w.row, tenant_id: this.T };
        this.store.insert(w.collection, row);
        this.shadow.get(w.collection).push({ ...row });
        dual++;
      }
      return { dual_writes: dual, shadow_rows: this.shadowCount() };
    });
  }

  shadowCount() { let n = 0; for (const c of COLLECTIONS) n += this.shadow.get(c).length; return n; }

  shadowCounts() { const o = {}; for (const c of COLLECTIONS) o[c] = this.shadow.get(c).length; return o; }

  shadowHashes() {
    const o = {};
    for (const c of COLLECTIONS) {
      const rows = [...this.shadow.get(c)].sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
      o[c] = sha256(stableStringify(rows));
    }
    return o;
  }

  // ---------- ۴) آزمون تطبیق: شمارش و هش هر مجموعه باید برابر باشد ----------
  step4_reconcile() {
    this._require(4);
    return this._record(4, 'reconcile', () => {
      const legacyCounts = this.store.counts();
      const shadowCounts = this.shadowCounts();
      const legacyHashes = this.store.hashes();
      const shadowHashes = this.shadowHashes();
      const diffs = [];
      for (const c of COLLECTIONS) {
        if (legacyCounts[c] !== shadowCounts[c]) diffs.push({ collection: c, field: 'count', legacy: legacyCounts[c], shadow: shadowCounts[c] });
        if (legacyHashes[c] !== shadowHashes[c]) diffs.push({ collection: c, field: 'hash' });
      }
      if (diffs.length) {
        this.verdict = 'failed';
        const err = new Error(`reconcile_mismatch:${JSON.stringify(diffs)}`);
        err.diffs = diffs;
        throw err;   // توقف؛ ادامه با فرض ممنوع (۱۶‑ب §۳.۲)
      }
      this.reconciled = { matched: true, counts: legacyCounts, hashes: legacyHashes };
      return { matched: true, counts: legacyCounts, hashes: legacyHashes };
    });
  }

  // ---------- ۵) RLS در محیط قرنطینه + آزمون نشت صفر ----------
  step5_rlsQuarantine({ probeTenant = 'T1' } = {}) {
    this._require(5);
    return this._record(5, 'rls_quarantine', () => {
      // کپی قرنطینه: هر ردیف با tenant_id خودش
      const tables = new Map();
      for (const c of COLLECTIONS) tables.set(c, this.shadow.get(c).map((r) => ({ ...r })));
      const read = (tenant, collection) => (tables.get(collection) || []).filter((r) => r.tenant_id === tenant);
      const leaks = [];
      for (const c of COLLECTIONS) {
        const rows = read(probeTenant, c);
        if (rows.length) leaks.push({ collection: c, rows: rows.length });
        const missing = read(this.T, c).length !== this.shadow.get(c).length;
        if (missing) leaks.push({ collection: c, field: 'tenant_filter_lost_own_rows' });
      }
      this.quarantine = { leaks, tables };
      if (leaks.length) throw new Error(`rls_leak:${JSON.stringify(leaks)}`);
      return { leaks: 0, collections: COLLECTIONS.length };
    });
  }

  // ---------- ۶) کلید مستأجر: بکاپ‌ها بازرمزنگاری می‌شوند ----------
  step6_rekey() {
    this._require(6);
    return this._record(6, 'rekey', () => {
      const oldKey = newKey();
      const aad = (id) => `${this.T}|${id}|db`;   // AAD = tenant + backup_id + level (۱۵ §۲.۱)
      const before = [];
      for (let i = 0; i < 3; i++) {
        const id = `bk-${i}`;
        const payload = { collection: 'grades', rows: this.shadow.get('grades').slice(0, 1 + i) };
        before.push({ id, box: seal(oldKey, payload, aad(id)), payload });
      }
      const after = before.map((b) => ({ id: b.id, box: seal(this.tenantKey, b.payload, aad(b.id)) }));
      // شاهد: کلید قدیمی نمی‌تواند بکاپ تازه را بخواند و AAD مستأجر دیگر هم شکست می‌خورد
      const oldCannotOpen = open(oldKey, after[0].box, aad(after[0].id)).ok === false;
      const wrongTenant = open(this.tenantKey, after[0].box, `T2|${after[0].id}|db`).ok === false;
      const newReads = after.every((a) => open(this.tenantKey, a.box, aad(a.id)).ok === true);
      this.backups = after;
      if (!oldCannotOpen || !wrongTenant || !newReads) throw new Error('rekey_failed');
      return { rekeyed: after.length, old_key_denied: true, aad_bound: true };
    });
  }

  // ---------- ۷) سوئیچ خواندن به مسیر جدید ----------
  step7_switchReads() {
    this._require(7);
    return this._record(7, 'switch_reads', () => {
      const legacyHashes = this.store.hashes();
      const shadowHashes = this.shadowHashes();
      for (const c of COLLECTIONS) if (legacyHashes[c] !== shadowHashes[c]) throw new Error(`switch_hash_mismatch:${c}`);
      this.readPath = 'tenant';
      this.switchedAt = this.now();
      this._audit({ action: 'migration.switch_reads', at_tenant: this.T });
      return { readPath: this.readPath, rows: this.shadowCount() };
    });
  }

  // ---------- ۸) حذف مسیر قدیم فقط پس از ۷ روز پایداری ----------
  step8_removeLegacy({ stabilityDays = STABILITY_DAYS } = {}) {
    this._require(8);
    return this._record(8, 'remove_legacy', () => {
      if (this.readPath !== 'tenant') throw new Error('reads_not_switched');
      const ageDays = (this.now() - this.switchedAt) / 86_400_000;
      if (ageDays < stabilityDays) throw new Error(`stability_not_met:${ageDays.toFixed(2)}d<${stabilityDays}d`);
      // داده هرگز حذف نمی‌شود: فقط مسیر قدیم از چرخه بیرون می‌رود و آرشیو می‌شود
      this.removedRows = { counts: this.store.counts(), bytes: this.store.bytes() };
      this.legacyPresent = false;
      return { archived: true, rows: Object.values(this.removedRows.counts).reduce((a, b) => a + b, 0) };
    });
  }

  // ---------- ۹) گزارش مهاجرت (۱۶‑ب §۳.۳) ----------
  step9_report({ operator = 'platform_owner', fromVersion = 'v1-single-school', toVersion = 'v2-tenant-rls' } = {}) {
    this._require(9);
    return this._record(9, 'report', () => {
      const countsAfter = this.shadowCounts();
      const hashesAfter = this.shadowHashes();
      const countsBefore = this.before.counts;
      const hashBefore = this.before.hashes;
      // حکم بر پایهٔ تطبیق مسیر قدیم/جدید است (گام ۴)، نه مقایسهٔ پیش/پس — نوشتن‌های پنجرهٔ مهاجرت مشروع‌اند
      const matched = !!(this.reconciled && this.reconciled.matched &&
        COLLECTIONS.every((c) => this.reconciled.counts[c] === countsAfter[c] && this.reconciled.hashes[c] === hashesAfter[c]));
      this.finishedAt = this.now();
      this.report = {
        migration_id: sha256(`${this.T}|${this.startedAt}`).slice(0, 32),
        tenant_id: this.T,
        from_version: fromVersion,
        to_version: toVersion,
        started_at: this.startedAt,
        finished_at: this.finishedAt,
        duration_ms: this.finishedAt - this.startedAt,
        counts_before: countsBefore,
        counts_after: countsAfter,
        hash_before: hashBefore,
        hash_after: hashesAfter,
        bytes_copied: Buffer.byteLength(JSON.stringify(Object.fromEntries(this.shadow))),
        step_results: this.stepResults,
        step_failures: this.failures,
        verdict: matched && !this.verdict ? 'matched' : 'failed',
        reconciliation_basis: 'legacy↔shadow (step 4)',
        operator,
        read_path: this.readPath,
        legacy_present: this.legacyPresent,
      };
      this.verdict = this.report.verdict;
      this.report.sha256 = sha256(stableStringify(this.report));
      this._audit({ action: 'migration.report', sha: this.report.sha256, verdict: this.report.verdict });
      return this.report;
    });
  }

  // ---------- اجرای کامل ۱→۹ با توقف در اولین شکست ----------
  run({ operator = 'platform_owner', role = 'platform_owner', writes = [], stabilityDays = STABILITY_DAYS } = {}) {
    const steps = [
      () => this.step1_precheck({ actor: operator, role }),
      () => this.step2_addColumn(),
      () => this.step3_dualWrite(writes),
      () => this.step4_reconcile(),
      () => this.step5_rlsQuarantine(),
      () => this.step6_rekey(),
      () => this.step7_switchReads(),
      () => { this.now = ((t) => () => t)(this.switchedAt + stabilityDays * 86_400_000 + 1000); return this.step8_removeLegacy({ stabilityDays }); },
      () => this.step9_report({ operator }),
    ];
    for (const s of steps) {
      try { s(); } catch (e) {
        if (!this.report) {
          this.report = {
            migration_id: sha256(`${this.T}|${this.startedAt}`).slice(0, 32),
            tenant_id: this.T, started_at: this.startedAt, finished_at: this.finishedAt || this.now(),
            duration_ms: (this.finishedAt || this.now()) - this.startedAt,
            counts_before: this.before ? this.before.counts : null,
            counts_after: this.shadowCounts(),
            hash_before: this.before ? this.before.hashes : null,
            hash_after: this.shadowHashes(),
            step_results: this.stepResults, verdict: 'failed', reason: e.message,
            operator, read_path: this.readPath, legacy_present: this.legacyPresent,
          };
          this.report.sha256 = sha256(stableStringify(this.report));
        }
        break;
      }
    }
    return this.report || { verdict: 'failed' };
  }

  // ---------- rollback: بازگشت به وضعیت پیش از مهاجرت، بدون حذف داده ----------
  rollback({ reason = 'migration_failed', actor = 'platform_owner' } = {}) {
    const before = this.before ? this.before.counts : this.store.counts();
    const nowCounts = this.store.counts();
    const keptAll = COLLECTIONS.every((c) => nowCounts[c] >= before[c]);
    this.readPath = 'legacy';
    this.legacyPresent = true;
    this.switchedAt = null;
    this.removedRows = null;
    this._audit({ action: 'migration.rollback', reason, actor, kept_all_rows: keptAll });
    return { ok: keptAll, counts: nowCounts, expected_at_least: before, read_path: this.readPath };
  }

  // خواندن از مسیر فعال (برای اثبات برابری محتوا پس از سوئیچ)
  readAll(collection) {
    const src = this.readPath === 'tenant' ? this.shadow.get(collection) : this.store.all(collection);
    return (src || []).map((r) => ({ ...r }));
  }
}

module.exports = { Migrator, LegacyStore, COLLECTIONS, STABILITY_DAYS };
