#!/usr/bin/env node
'use strict';
/* Row 205 — the tables of docs/cloud/reports/HELPER-SIM-205-REPORT.md from summary.json.
   usage: node summarize.js [/work/tmp/sim205/out/summary.json] [trimmed-output.json] */
const fs = require('fs');
const src = process.argv[2] || '/work/tmp/sim205/out/summary.json';
const S = JSON.parse(fs.readFileSync(src, 'utf8'));
const R = S.results;
const rows = [];
const trimmed = { secs_per_phase: S.secs_per_phase, total_s: S.total_s, phases: {} };
const fa = (n) => Number(n).toLocaleString('en-US');
for (const [name, j] of Object.entries(R)) {
  const cpu = j.server.process_cpu ? j.server.process_cpu.user_ms + j.server.process_cpu.system_ms : 0;
  const hs = (j.helpers || []).filter(Boolean);
  const helperCpu = hs.reduce((a, h) => a + (h.probe.cpu ? (h.probe.cpu.user + h.probe.cpu.system) / 1000 : 0), 0);
  const helperBucket = hs.reduce((a, h) => a + h.probe.net.total, 0);
  const work = hs.flatMap(h => h.stats.jobs);
  const p = {
    phase: name, secs: j.secs, cpus: j.cpus_school, devices: j.devices, think_ms: j.think_ms, helpers: hs.length,
    user_requests: j.user_requests, req_per_s: j.req_per_s, attendance_rows: j.attendance_rows,
    sync_p50: j.routes['POST /api/sync'].p50, sync_p95: j.routes['POST /api/sync'].p95,
    pull_p95: j.routes['GET /api/v1/pull'].p95, me_p95: j.routes['GET /api/me'].p95,
    sqlite_statements: j.server.sqlite.statements, sqlite_per_req: j.server.sqlite_per_req, sqlite_ms: j.server.sqlite.ms,
    server_cpu_ms: cpu, server_cpu_ms_per_req: +(cpu / j.user_requests).toFixed(2),
    server_bucket_requests: j.server.bucket_requests_by_server_total,
    server_bucket_by_area: j.server.bucket_requests_by_server,
    outbox_puts: j.server.bucket_requests_by_server['PUT outbox/pending'] || 0,
    helper_bucket_requests: helperBucket, helper_cpu_ms: Math.round(helperCpu),
    bucket_total: j.bucket_total.requests,
    usage_jobs: j.jobs.map(x => ({ at_s: x.at_s, manager_wait_ms: x.ms, by: x.by === 'local' ? 'local:' + x.why : 'helper ' + String(x.by).slice(0, 4), objects: x.objects })),
    helper_work: work.map(w => ({ kind: w.kind, work_ms: w.ms, claim_wait_ms: w.waited_ms })),
    docker_cpu_avg: Object.fromEntries(Object.entries(j.docker || {}).map(([k, v]) => [k.replace('sim205-', ''), v.cpu_avg])),
    route: j.helpers_card && j.helpers_card.route ? j.helpers_card.route.active.join('+') : null,
  };
  trimmed.phases[name] = p;
  rows.push(p);
}
const t = [];
t.push('| فاز | سرور کمکی | درخواست کاربر (در ثانیه) | p95 همگام‌سازی (ms) | دستور SQLite به ازای هر درخواست | CPU سرور مدرسه به ازای هر درخواست (ms) | درخواست سرور مدرسه به صندوقچه | درخواست سرورهای کمکی به صندوقچه | CPU سرورهای کمکی (ms) |');
t.push('|---|---|---|---|---|---|---|---|---|');
for (const p of rows) t.push(`| ${p.phase} | ${p.helpers ? p.helpers + ' روشن' : 'خاموش'} | ${fa(p.user_requests)} (${p.req_per_s}) | ${p.sync_p95} | ${p.sqlite_per_req} | ${p.server_cpu_ms_per_req} | ${fa(p.server_bucket_requests)} (آینهٔ صندوقچه: ${fa(p.outbox_puts)}) | ${fa(p.helper_bucket_requests)} | ${fa(p.helper_cpu_ms)} |`);
const j = [];
j.push('| فاز | کار «فضای مصرفی» (storage.usage) | انتظار مدیر (ms) | چه کسی انجام داد | کار واقعی روی سرور کمکی (ms) | انتظار تا برداشتن کار (ms) |');
j.push('|---|---|---|---|---|---|');
for (const p of rows) {
  const w = [...p.helper_work];
  p.usage_jobs.forEach((u, i) => {
    const hw = u.by.startsWith('helper') ? w.shift() : null;
    j.push(`| ${i ? '' : p.phase} | #${i + 1} (${fa(u.objects || 0)} شیء) | ${fa(u.manager_wait_ms)} | ${u.by} | ${hw ? fa(hw.work_ms) : '—'} | ${hw ? fa(hw.claim_wait_ms) : '—'} |`);
  });
}
console.log(t.join('\n') + '\n\n' + j.join('\n'));
if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(trimmed, null, 1) + '\n');
