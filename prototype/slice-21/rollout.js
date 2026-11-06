'use strict';
// نمونهٔ فنی ۲۱ — پایلوت و انتشار تدریجی: موج‌ها، گیت go/no‑go، توقف و rollback
// قاعده: گسترش فقط پله‌به‌پله، فقط با شاهد سنجه‌های اندازه‌گیری‌شده، و همیشه برگشت‌پذیر.

const { sha256, stableStringify } = require('./vault');

const WAVES = [1, 10, 50, 200];   // مدارس هر موج (۰۴ §۲ / ۱۶‑ب §۵)

class Pilot {
  constructor({ monitor, now = () => Date.now(), totalSchools = 200 } = {}) {
    this.monitor = monitor;
    this.now = now;
    this.totalSchools = totalSchools;
    this.state = 'draft';           // draft | rolling | halted | complete
    this.waveIndex = -1;            // -1 = هنوز هیچ مدرسه‌ای در پایلوت نیست
    this.schools = 0;
    this.frozen = false;
    this.rollbacks = [];
    this.audit = [];
    this._lastEvaluationSerial = 0;
  }

  _audit(entry) {
    const prev = this.audit.length ? this.audit[this.audit.length - 1].hash : 'GENESIS';
    const row = { ...entry, at: this.now(), prev_hash: prev };
    row.hash = sha256(JSON.stringify({ ...row, hash: undefined }));
    this.audit.push(row);
    return row;
  }

  _gate() {
    const evaluation = this.monitor.latest();
    if (!evaluation) throw new Error('evidence_required');   // بدون عکس لحظه‌ای سنجه‌ها: گسترش ممنوع
    if (evaluation.verdict === 'freeze') {
      this.frozen = true;
      this.state = 'halted';
      this._audit({ action: 'pilot.freeze', reason: 'P0', alerts: evaluation.alerts.map((a) => a.id) });
      throw new Error('p0_freeze');
    }
    return evaluation;
  }

  start({ actor, role }) {
    if (role !== 'platform_owner') throw new Error('owner_required');
    if (this.state !== 'draft') throw new Error(`invalid_transition:${this.state}->rolling`);
    this.state = 'rolling';
    this._audit({ action: 'pilot.start', actor });
    return this.status();
  }

  // گسترش به موج بعد — بدون پرش، فقط با PASS گیت
  expand({ actor, role, override = false, reason = '' }) {
    if (role !== 'platform_owner') throw new Error('owner_required');
    if (this.state === 'draft') throw new Error('invalid_transition:draft->rolling');
    if (this.state === 'halted' && !override) throw new Error('pilot_halted');
    const next = this.waveIndex + 1;
    if (next >= WAVES.length) throw new Error('all_waves_done');

    const evaluation = this._gate();
    let used = 'gate';
    if (evaluation.verdict === 'no-go') {
      if (!override) {
        this.state = 'halted';
        this._audit({ action: 'pilot.no_go', wave: next, blockers: evaluation.blockers.map((b) => b.id) });
        const err = new Error('no_go');
        err.evaluation = evaluation;
        throw err;
      }
      if (!reason) throw new Error('override_reason_required');
      used = 'override';
    }

    const add = WAVES[next] - (next === 0 ? 0 : WAVES[next - 1]);
    this.waveIndex = next;
    this.schools = WAVES[next];
    this.state = this.schools >= this.totalSchools ? 'complete' : 'rolling';
    this._audit({
      action: 'pilot.expand', wave: next, schools: this.schools, decision: used,
      actor, reason: used === 'override' ? reason : '', blockers: evaluation.blockers.map((b) => b.id),
      fingerprint: sha256(stableStringify({ wave: next, schools: this.schools, verdict: evaluation.verdict, alerts: evaluation.alerts.map((a) => a.id) })),
    });
    return { ...this.status(), wave: next, addedSchools: add, decision: used, evaluation };
  }

  halt({ actor, reason = 'manual' }) {
    if (this.state === 'halted') return { ...this.status(), idempotent: true };   // توقف مکرر: بی‌اثر
    if (this.state === 'complete') throw new Error('already_complete');
    this.state = 'halted';
    this._audit({ action: 'pilot.halt', actor, reason });
    return { ...this.status(), idempotent: false };
  }

  resume({ actor, role }) {
    if (role !== 'platform_owner') throw new Error('owner_required');
    if (this.state !== 'halted') throw new Error(`invalid_transition:${this.state}->rolling`);
    this.state = 'rolling';
    this._audit({ action: 'pilot.resume', actor });
    return this.status();
  }

  // عقب‌نشینی یک موج: مدارس همان موج از پایلوت بیرون می‌روند؛ موج‌های پیشین دست‌نخورده
  rollbackWave({ actor, reason = 'no_go' }) {
    if (this.waveIndex < 0) throw new Error('nothing_to_rollback');
    const removed = this.schools - (this.waveIndex === 0 ? 0 : WAVES[this.waveIndex - 1]);
    const row = { wave: this.waveIndex, removedSchools: removed, at: this.now(), actor, reason };
    this.rollbacks.push(row);
    this.schools = this.waveIndex === 0 ? 0 : WAVES[this.waveIndex - 1];
    this.waveIndex -= 1;
    this.state = this.waveIndex < 0 ? 'draft' : 'rolling';
    this._audit({ action: 'pilot.rollback_wave', ...row });
    return { ...this.status(), removed };
  }

  status() {
    return {
      state: this.state, waveIndex: this.waveIndex, schools: this.schools,
      totalSchools: this.totalSchools, frozen: this.frozen,
      nextWave: this.waveIndex + 1 < WAVES.length ? WAVES[this.waveIndex + 1] : null,
      waves: WAVES, rollbacks: this.rollbacks.length,
    };
  }
}

module.exports = { Pilot, WAVES };
