'use strict';
// نمونهٔ فنی ۲۱ — سنجه‌های انتشار: آستانه‌های هشدار (۱۶ §۶) و معیار go/no‑go پایلوت
// قاعده: تصمیم گسترش فقط با «عکس لحظه‌ای سنجه‌های اندازه‌گیری‌شده» گرفته می‌شود، نه با فرض.

const LEVELS = { P0: 0, P1: 1, P2: 2, P3: 3 };

// آستانه‌ها عیناً از ۱۶ §۶
const THRESHOLDS = [
  { id: 'tenant_leak', level: 'P0', title: 'نشت بین‌مستأجری', test: (s) => s.tenant_leak > 0, value: (s) => s.tenant_leak, limit: 0 },
  { id: 'audit_chain_broken', level: 'P0', title: 'شکست زنجیرهٔ audit', test: (s) => s.audit_chain_broken > 0, value: (s) => s.audit_chain_broken, limit: 0 },
  { id: 'restore_failure', level: 'P0', title: 'شکست آزمون بازیابی', test: (s) => s.restore_failure > 0, value: (s) => s.restore_failure, limit: 0 },
  { id: 'err5xx_rate', level: 'P1', title: 'خطای ۵xx > ۱٪ (۵min)', test: (s) => s.err5xx_rate > 0.01, value: (s) => s.err5xx_rate, limit: 0.01 },
  { id: 'replication_lag_s', level: 'P1', title: 'lag > ۳۰s', test: (s) => s.replication_lag_s > 30, value: (s) => s.replication_lag_s, limit: 30 },
  { id: 'backup_age_h', level: 'P1', title: 'کهنگی بکاپ > ۲۶h', test: (s) => s.backup_age_h > 26, value: (s) => s.backup_age_h, limit: 26 },
  { id: 'disk_pct', level: 'P1', title: 'دیسک > ۸۰٪', test: (s) => s.disk_pct > 80, value: (s) => s.disk_pct, limit: 80 },
  { id: 'readyz_down_s', level: 'P1', title: '/readyz ناموفق > ۶۰s', test: (s) => s.readyz_down_s > 60, value: (s) => s.readyz_down_s, limit: 60 },
  { id: 'queue_ops_per_tenant', level: 'P2', title: 'صف > ۵۰۰ op/tenant برای ۱۵min', test: (s) => s.queue_ops_per_tenant > 500, value: (s) => s.queue_ops_per_tenant, limit: 500 },
  { id: 'conflicts_per_school_day', level: 'P2', title: 'تعارض > ۲۰/روز/مدرسه', test: (s) => s.conflicts_per_school_day > 20, value: (s) => s.conflicts_per_school_day, limit: 20 },
  { id: 'p95_ratio', level: 'P2', title: 'p95 > ۲× هدف', test: (s) => s.p95_ratio > 2, value: (s) => s.p95_ratio, limit: 2 },
];

const REQUIRED_SIGNALS = ['err5xx_rate', 'replication_lag_s', 'backup_age_h', 'disk_pct', 'readyz_down_s',
  'queue_ops_per_tenant', 'conflicts_per_school_day', 'p95_ratio', 'tenant_leak', 'audit_chain_broken', 'restore_failure'];

class Monitor {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.samples = [];
  }

  // عکس لحظه‌ای سنجه‌ها — همهٔ سیگنال‌های لازم باید حاضر باشند
  snapshot(signals, { label = 'sample' } = {}) {
    const missing = REQUIRED_SIGNALS.filter((k) => typeof signals[k] !== 'number');
    if (missing.length) throw new Error(`signals_missing:${missing.join(',')}`);
    const row = { label, at: this.now(), signals: { ...signals } };
    this.samples.push(row);
    return row;
  }

  evaluate(sample) {
    if (!sample) throw new Error('snapshot_required');
    const alerts = [];
    for (const t of THRESHOLDS) {
      if (t.test(sample.signals)) {
        alerts.push({ id: t.id, level: t.level, title: t.title, value: t.value(sample.signals), limit: t.limit });
      }
    }
    const worst = alerts.reduce((acc, a) => (acc === null || LEVELS[a.level] < LEVELS[acc] ? a.level : acc), null);
    const blockers = alerts.filter((a) => a.level === 'P0' || a.level === 'P1');
    const warnings = alerts.filter((a) => a.level === 'P2');
    return {
      at: sample.at,
      verdict: worst === 'P0' ? 'freeze' : blockers.length ? 'no-go' : 'go',
      worst,
      alerts,
      blockers,
      warnings,
      note: worst === 'freeze'
        ? 'P0 ⇒ توقف انتشار و ثبت حادثه (۱۶ §۶)'
        : blockers.length ? 'P1 ⇒ توقف گسترش تا رفع' : warnings.length ? 'P2 ⇒ گسترش مجاز با هشدار' : 'سالم',
    };
  }

  // آخرین عکس لحظه‌ای + ارزیابی آن (ورودی go/no‑go پایلوت)
  latest() {
    const sample = this.samples[this.samples.length - 1];
    return sample ? this.evaluate(sample) : null;
  }
}

module.exports = { Monitor, THRESHOLDS, REQUIRED_SIGNALS, LEVELS };
