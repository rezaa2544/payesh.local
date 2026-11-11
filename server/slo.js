'use strict';
/* ═══════════════════════════════════════════════════════════════════
   SLO definitions as code (row 85)

   This file is the single source of the objectives. Three things read it:
     • server/metrics.js turns real request outcomes into SLI and burn-rate
       gauges on /metrics;
     • deploy/monitoring/slo-85.yml holds the alert rules, and
       tests/observability-85.js checks that every threshold there equals
       the value derived here, so the two cannot drift apart silently;
     • docs/cloud/85-observability-slo.md explains the numbers.

   Burn rate = (bad fraction observed in the window) / (error budget).
   A burn rate of 1 spends exactly the whole budget over the SLO period.
   The thresholds follow the multi-window guidance from the Google SRE
   Workbook: 14.4× is 2% of a 30-day budget in 1 hour (page); 6× is 5% in
   6 hours (ticket). The local evaluator only knows `<metric> <op> <number>`
   over a 5-minute window, so the short window plus `for:` stands in for the
   long/short window pair.
   ═══════════════════════════════════════════════════════════════════ */

const SLOS = Object.freeze([
  Object.freeze({
    id: 'availability',
    description: 'Share of HTTP requests answered without a 5xx',
    objective: 0.995,            /* 99.5% over 30 days ⇒ ~3h36m budget */
    period_days: 30,
    sli: 'non_5xx / all',
    burn_metric: 'payesh_slo_availability_burn_rate',
  }),
  Object.freeze({
    id: 'latency',
    description: 'Share of HTTP requests answered within threshold_ms',
    objective: 0.95,
    threshold_ms: 1000,
    period_days: 30,
    sli: 'duration <= threshold_ms / all',
    burn_metric: 'payesh_slo_latency_burn_rate',
  }),
]);

const BURN = Object.freeze({ fast: 14.4, slow: 6 });

/* A p95 ceiling is a sanity alert, not an SLO: it fires on a sustained
   tail even when the request mix hides it from the ratio SLI. */
const P95_CEILING_SECONDS = 1.5;

function budget(slo) { return 1 - slo.objective; }

function burnRate(badFraction, slo) {
  const b = budget(slo);
  if (!(b > 0)) return 0;
  const f = Number(badFraction);
  return Number.isFinite(f) && f > 0 ? f / b : 0;
}

function byId(id) { return SLOS.find(s => s.id === id) || null; }

/* The alert set that slo-85.yml must contain (name → metric/op/threshold/severity). */
function expectedRules() {
  return [
    { alert: 'PayeshSloAvailabilityFastBurn', metric: byId('availability').burn_metric, op: '>', threshold: BURN.fast, severity: 'critical' },
    { alert: 'PayeshSloAvailabilitySlowBurn', metric: byId('availability').burn_metric, op: '>', threshold: BURN.slow, severity: 'warning' },
    { alert: 'PayeshSloLatencyFastBurn', metric: byId('latency').burn_metric, op: '>', threshold: BURN.fast, severity: 'critical' },
    { alert: 'PayeshSloLatencySlowBurn', metric: byId('latency').burn_metric, op: '>', threshold: BURN.slow, severity: 'warning' },
    { alert: 'PayeshLatencyP95High', metric: 'payesh_http_latency_p95_seconds', op: '>', threshold: P95_CEILING_SECONDS, severity: 'warning' },
  ];
}

module.exports = { SLOS, BURN, P95_CEILING_SECONDS, budget, burnRate, byId, expectedRules };
