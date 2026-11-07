#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════════
   healthcheck / alerting — ردیف ۲۹ (Monitoring & Alerts)

   یک پروب واقعی و بدون وابستگی برای مانیتورینگ بیرونی (cron/systemd timer,
   Uptime Kuma, Zabbix, …). آستانه‌ها همان جدول §۶ سند ۱۶ است.

   استفاده:
     node scripts/healthcheck.mjs --url=http://127.0.0.1:3000
     node scripts/healthcheck.mjs --url=… --backup_stale_h=26 --disk_min=20 --p95_ms=…

   خروجی: یک خط JSON با {ok, severity, alerts[], checks{}} روی stdout
   کد خروج: 0 = سالم · 1 = هشدار (P2/P3) · 2 = بحرانی (P0/P1) · 3 = خطای خودِ پروب

   P0/P1 (خروج ۲): readyz ناموفق · disk > آستانه · کهنگی بکاپ > آستانه · آینه کهنه
   P2/P3 (خروج ۱): پایداری پروب، تأخیر بالای هدف
   ═══════════════════════════════════════════════════════════════════════ */

const ARGS = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? 'true' : m[2]] : [a, 'true'];
}));

const URL_BASE = String(ARGS.url || process.env.PAYESH_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const BACKUP_STALE_H = Number(ARGS.backup_stale_h || 26);   /* §۶ P1: کهنگی بکاپ > ۲۶h */
const MIRROR_STALE_S = Number(ARGS.mirror_stale_s || 600);  /* §۶ P1: lag آینه/بکاپ */
const DISK_MIN_PCT = Number(ARGS.disk_min || 20);           /* §۶ P1: دیسک > ۸۰٪ پر ⇒ آزاد < ۲۰٪ */
const TIMEOUT_MS = Number(ARGS.timeout_ms || 5000);

const alerts = [];
const checks = {};

const crit = (code, msg) => alerts.push({ severity: 'P1', code, message: msg });
const warn = (code, msg) => alerts.push({ severity: 'P2', code, message: msg });

async function getJson(path) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(URL_BASE + path, { signal: ctl.signal });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { body = null; }
    return { status: r.status, body, text };
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  try {
    const t0 = Date.now();
    const live = await getJson('/api/health');
    checks.health_status = live.status;
    checks.health_latency_ms = Date.now() - t0;
    if (live.status !== 200 || !live.body || !live.body.ok) {
      crit('health_failed', `GET /api/health → ${live.status}`);
    } else {
      checks.version = live.body.version;
      checks.uptime_s = live.body.uptime_s;
      checks.setup_done = !!live.body.setup_done;
    }

    const ready = await getJson('/api/readyz');
    checks.readyz_status = ready.status;
    if (ready.status !== 200 || !ready.body || !ready.body.ready) {
      crit('readyz_failed', `GET /api/readyz → ${ready.status} ${(ready.body && (ready.body.checks && JSON.stringify(ready.body.checks))) || ''}`.trim());
    }
    if (ready.body && ready.body.checks) {
      checks.disk_free_pct = ready.body.checks.disk_free_pct;
      checks.backup_age_s = ready.body.checks.backup_age_s;
      checks.mirror_age_s = ready.body.checks.mirror_age_s;
      if (checks.disk_free_pct != null && checks.disk_free_pct < DISK_MIN_PCT) {
        crit('disk_low', `فقط ${checks.disk_free_pct}% دیسک آزاد است (آستانه ${DISK_MIN_PCT}%)`);
      }
      if (checks.backup_age_s != null && checks.backup_age_s > BACKUP_STALE_H * 3600) {
        crit('backup_stale', `کهنگی بکاپ ${Math.round(checks.backup_age_s / 3600)}h (آستانه ${BACKUP_STALE_H}h)`);
      }
      if (checks.backup_age_s === null) {
        crit('backup_missing', 'هیچ فایل بکاپی یافت نشد');
      }
      if (checks.mirror_age_s != null && checks.mirror_age_s > MIRROR_STALE_S) {
        crit('mirror_stale', `کهنگی آینه ${checks.mirror_age_s}s (آستانه ${MIRROR_STALE_S}s)`);
      }
    }

    const healthLatencyLimit = Number(ARGS.health_max_ms || 1000);
    if (checks.health_latency_ms > healthLatencyLimit) {
      warn('health_slow', `تأخیر /api/health ${checks.health_latency_ms}ms > ${healthLatencyLimit}ms`);
    }
  } catch (e) {
    alerts.push({ severity: 'P0', code: 'probe_error', message: String(e && e.message || e) });
  }

  const severe = alerts.some(a => a.severity === 'P0' || a.severity === 'P1');
  const any = alerts.length > 0;
  const out = {
    ok: !severe && !any,
    severity: severe ? 'P1' : (any ? 'P2' : 'ok'),
    target: URL_BASE,
    at: new Date().toISOString(),
    alerts,
    checks,
  };
  console.log(JSON.stringify(out));
  return severe ? 2 : (any ? 1 : 0);
}

main().then(code => process.exit(code)).catch(e => {
  console.log(JSON.stringify({ ok: false, severity: 'P0', alerts: [{ severity: 'P0', code: 'probe_error', message: String(e && e.message || e) }], checks }));
  process.exit(3);
});
