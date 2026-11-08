#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   ارزیاب قواعد هشدار — ردیف ۴۹        (ALERTS-49)

   چرا این ابزار وجود دارد؟
     «قاعدهٔ هشدار» تا وقتی کسی آن را روی یک خرابیِ واقعی اجرا نکرده،
     فقط متن است. این ابزار همان قواعد را روی scrape واقعیِ /metrics
     ارزیابی می‌کند، ورودیِ همیشگی (state) نگه می‌دارد تا `for:` معنا
     داشته باشد، هشدارِ تکراری را در پنجرهٔ تکرار خفه می‌کند و هر رویداد
     را در sink (JSONL) ثبت و در صورت تنظیم ALERT_WEBHOOK به Pager
     تحویل می‌دهد.

   گرامر محدود (عمدی):  expr = `<metric> <op> <number>`
     op ∈ { >, <, >=, <=, == }   ·   عدد اعشاری/منفی مجاز
   هر قاعدهٔ خارج از این گرامر ⇒ خطا (چون «Prometheus می‌خواند ولی ما
   نمی‌توانیم بسنجیم» یعنی دروازهٔ سبزِ بی‌معنا).

   اجرا:
     node tools/alerts-49.mjs --rules deploy/monitoring/alerts-49.yml \
       --metrics-url http://127.0.0.1:8080/metrics \
       --state /tmp/alerts-state.json \
       --sink docs/cloud/reports/evidence/alerts-49.jsonl \
       [--webhook URL] [--repeat 300] [--now 2026-11-08T10:00:00Z] [--json-out f]

   پایان سبز (اجرای عادی):  ALERTS-49 rules=… firing=… pending=… resolved=… suppressed=…
   کد خروج: ۰ = ارزیابی و تحویل درست انجام شد (هشدارِ روشن خطا نیست)
             ۲ = خطای استفاده/گرامر/قاعده
             ۳ = تحویل هشدار ناموفق (ارسال به Pager نشد)
   ═══════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const requireCjs = createRequire(import.meta.url);
const SEVERITY_TO_LEVEL = { critical: 'S1', high: 'S2', warning: 'S3', info: 'S4' };

/* ─────────────────────────── آرگومان‌ها ─────────────────────────── */
function parseArgs(argv) {
  const out = { flags: {}, values: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out.flags[key] = true;
    else { out.values[key] = next; i++; }
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));
const RULES_PATH = path.resolve(ROOT, ARGS.values.rules || 'deploy/monitoring/alerts-49.yml');
const REPEAT_S = Number(ARGS.values.repeat || 300);
const NOW = ARGS.values.now ? new Date(ARGS.values.now) : new Date();
const STATE_PATH = ARGS.values.state ? path.resolve(ARGS.values.state) : null;
const SINK_PATH = ARGS.values.sink ? path.resolve(ARGS.values.sink) : null;
const WEBHOOK = ARGS.values.webhook || process.env.ALERT_WEBHOOK || '';
const JSON_OUT = ARGS.values['json-out'] ? path.resolve(ARGS.values['json-out']) : null;

if (Number.isNaN(NOW.getTime())) { console.error('ALERTS-49-BAD-NOW'); process.exit(2); }

/* ───────────────────── پارسر YAML (زیرمجموعهٔ لازم) ─────────────────────
   فقط همان چیزی که در alerts-49.yml هست: groups/rules/alert/expr/for/
   labels/annotations با مقدار ساده. عمداً هیچ وابستگی خارجی نیست. */
function parseRulesYaml(text) {
  const lines = text.split('\n');
  const groups = [];
  let cur = null, rule = null, section = null;
  const unquote = (v) => {
    let s = String(v).trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
    return s;
  };
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (trimmed.startsWith('- name:') && indent <= 4) {
      cur = { name: unquote(trimmed.slice('- name:'.length)), rules: [] };
      groups.push(cur); rule = null; section = null; continue;
    }
    if (trimmed.startsWith('- alert:')) {
      rule = { alert: unquote(trimmed.slice('- alert:'.length)), labels: {}, annotations: {} };
      if (!cur) { cur = { name: 'default', rules: [] }; groups.push(cur); }
      cur.rules.push(rule); section = null; continue;
    }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(trimmed);
    if (!kv) continue;
    const [, key, rest] = kv;
    if (rule && indent >= 6 && indent <= 8 && ['expr', 'for', 'severity'].includes(key)) {
      rule[key] = unquote(rest); section = null; continue;
    }
    if (rule && ['labels', 'annotations'].includes(key) && rest === '') { section = key; continue; }
    if (rule && section && rest !== '') { rule[section][key] = unquote(rest); continue; }
  }
  return groups;
}

/* ─────────────────────── گرامر عبارت هشدار ─────────────────────── */
const EXPR_RE = /^([A-Za-z_:][A-Za-z0-9_:]*)\s*(>=|<=|==|>|<)\s*(-?\d+(?:\.\d+)?)$/;
function parseExpr(expr) {
  const m = EXPR_RE.exec(String(expr || '').trim());
  if (!m) throw new Error('unsupported_expr: ' + expr);
  return { metric: m[1], op: m[2], threshold: Number(m[3]) };
}

/* ─────────────────── پارسر متن Prometheus ─────────────────── */
function parseMetrics(text) {
  const series = new Map();   /* name → [{labels, value}] */
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_:][A-Za-z0-9_:]*)(\{[^}]*\})?\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.exec(line);
    if (!m) continue;
    const name = m[1];
    const value = Number(m[3]);
    if (!series.has(name)) series.set(name, []);
    series.get(name).push({ labels: m[2] || '', value });
  }
  return series;
}
/* قاعده روی «بیشترین مقدار میان سری‌ها» ارزیابی می‌شود؛ در scrape تک‌نمونه‌ای
   این همان مقدار است و در چندنمونه‌ای، بدترین حالت را می‌گیرد (سمت ایمن). */
function aggMax(series, name) {
  const rows = series.get(name);
  if (!rows || !rows.length) return null;
  return rows.reduce((a, r) => Math.max(a, r.value), -Infinity);
}

function cmp(value, op, threshold) {
  switch (op) {
    case '>': return value > threshold;
    case '<': return value < threshold;
    case '>=': return value >= threshold;
    case '<=': return value <= threshold;
    case '==': return value === threshold;
    default: return false;
  }
}

function forToSeconds(v) {
  const s = String(v || '0').trim();
  const m = /^(\d+(?:\.\d+)?)(s|m|h|d)?$/.exec(s);
  if (!m) throw new Error('bad_for: ' + v);
  const n = Number(m[1]);
  const unit = m[2] || 's';
  return Math.round(n * ({ s: 1, m: 60, h: 3600, d: 86400 }[unit]));
}

/* ───────────────────────── state (append-only کارنامهٔ هشدار) ───────────────────────── */
function loadState() {
  if (!STATE_PATH) return { alerts: {} };
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (e) { return { alerts: {} }; }
}
function saveState(state) {
  if (!STATE_PATH) return;
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}
function appendSink(records) {
  if (!SINK_PATH || !records.length) return;
  fs.mkdirSync(path.dirname(SINK_PATH), { recursive: true });
  const text = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(SINK_PATH, text);
}

async function deliver(record) {
  if (WEBHOOK) {
    try {
      const res = await fetch(WEBHOOK, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(record),
        signal: AbortSignal.timeout(5000),
      });
      return { delivered: res.ok, status: res.status, sink: 'webhook' };
    } catch (e) {
      return { delivered: false, sink: 'webhook', reason: String((e && e.message) || e).slice(0, 160) };
    }
  }
  if (process.env.PAYESH_ALERT_TELEGRAM_TOKEN && process.env.PAYESH_ALERT_CHAT) {
    try {
      const { notify } = requireCjs('../server/alerts.js');
      const level = SEVERITY_TO_LEVEL[String(record.severity || '').toLowerCase()] || 'S3';
      const title = `${record.alert} (${record.metric} ${record.op} ${record.threshold})`;
      const body = `${record.summary || ''}\nvalue=${record.value} runbook=${record.runbook || '-'}`.trim();
      const r = await notify({ level, key: 'alert49:' + record.alert, title, body });
      return {
        delivered: !!r.sent,
        status: r.sent ? 200 : 502,
        sink: 'telegram',
        message_id: r.message_id || null,
        reason: r.reason || r.error || null,
      };
    } catch (e) {
      return { delivered: false, sink: 'telegram', reason: String((e && e.message) || e).slice(0, 160) };
    }
  }
  return { delivered: false, sink: SINK_PATH ? 'file' : 'none', reason: 'no_webhook_configured' };
}

/* ─────────────────────────── main ─────────────────────────── */
async function getMetricsText() {
  if (ARGS.values['metrics-file']) return fs.readFileSync(path.resolve(ROOT, ARGS.values['metrics-file']), 'utf8');
  const url = ARGS.values['metrics-url'];
  if (!url) throw new Error('need --metrics-url or --metrics-file');
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('metrics_http_' + res.status);
  return await res.text();
}

async function main() {
  let groups;
  try { groups = parseRulesYaml(fs.readFileSync(RULES_PATH, 'utf8')); }
  catch (e) { console.error('ALERTS-49-RULES-UNREADABLE ' + e.message); process.exit(2); }

  const rules = [];
  try {
    for (const g of groups) for (const r of g.rules) {
      const parsed = parseExpr(r.expr);
      rules.push(Object.assign({}, r, parsed, { group: g.name, for_s: forToSeconds(r.for) }));
    }
  } catch (e) { console.error('ALERTS-49-BAD-RULE ' + e.message); process.exit(2); }
  if (!rules.length) { console.error('ALERTS-49-NO-RULES'); process.exit(2); }

  /* فقط اعتبارسنجی قواعد (بدون scrape) — برای آزمون و CI */
  if (ARGS.flags['check-rules']) {
    for (const r of rules) {
      console.log(`ALERT-RULE name=${r.alert} group=${r.group} expr="${r.metric} ${r.op} ${r.threshold}" for=${r.for_s}s severity=${r.labels.severity || 'MISSING'}`);
    }
    console.log(`ALERTS-49-CHECK rules=${rules.length} groups=${groups.length}`);
    process.exit(0);
  }

  const series = parseMetrics(await getMetricsText());
  const requireMetrics = String(ARGS.values['require-metrics'] || '').split(',').map(s => s.trim()).filter(Boolean);
  const missing = requireMetrics.filter(n => !series.has(n));
  if (missing.length) { console.error('ALERTS-49-MISSING-METRICS ' + missing.join(',')); process.exit(2); }

  const state = loadState();
  const nowMs = NOW.getTime();
  const records = [];
  const tally = { firing: 0, pending: 0, resolved: 0, suppressed: 0, nodata: 0 };
  const delivery = [];

  for (const r of rules) {
    const value = aggMax(series, r.metric);
    const prev = state.alerts[r.alert] || null;
    if (value === null) {
      tally.nodata++;
      console.log(`ALERT-NODATA name=${r.alert} metric=${r.metric}`);
      continue;
    }
    const breach = cmp(value, r.op, r.threshold);
    if (!breach) {
      const wasLive = prev && (prev.state === 'firing' || prev.state === 'pending');
      if (wasLive && prev.state === 'firing') {
        tally.resolved++;
        const rec = {
          at: NOW.toISOString(), kind: 'resolved', alert: r.alert, metric: r.metric, op: r.op,
          threshold: r.threshold, value, severity: r.labels.severity || null, runbook: r.annotations.runbook || null,
        };
        records.push(rec);
        console.log(`ALERT-RESOLVED name=${r.alert} value=${value}`);
      }
      delete state.alerts[r.alert];
      continue;
    }
    /* نقض آستانه: مرحلهٔ pending تا رسیدن به for، سپس firing */
    if (!prev || !prev.first_breach) {
      state.alerts[r.alert] = { first_breach: NOW.toISOString(), state: 'pending', last_notify: null };
    }
    const st = state.alerts[r.alert];
    const elapsed = (nowMs - new Date(st.first_breach).getTime()) / 1000;
    if (elapsed < r.for_s) {
      tally.pending++;
      console.log(`ALERT-PENDING name=${r.alert} value=${value} ${r.op} ${r.threshold} elapsed=${Math.round(elapsed)}s for=${r.for_s}s`);
      continue;
    }
    st.state = 'firing';
    const last = st.last_notify ? new Date(st.last_notify).getTime() : 0;
    const rec = {
      at: NOW.toISOString(), kind: 'firing', alert: r.alert, metric: r.metric, op: r.op,
      threshold: r.threshold, value, severity: r.labels.severity || null,
      owner: r.labels.owner || null, summary: r.annotations.summary || null,
      runbook: r.annotations.runbook || null, for_s: r.for_s, group: r.group,
    };
    if (last && nowMs - last < REPEAT_S * 1000) {
      tally.suppressed++;
      console.log(`ALERT-SUPPRESSED name=${r.alert} value=${value} (تکرار در پنجرهٔ ${REPEAT_S}s)`);
      continue;
    }
    tally.firing++;
    st.last_notify = NOW.toISOString();
    const out = await deliver(rec);
    delivery.push({ alert: r.alert, delivered: out.delivered, sink: out.sink, status: out.status, reason: out.reason });
    records.push(Object.assign(rec, { delivery: out }));
    console.log(`ALERT-FIRING name=${r.alert} value=${value} ${r.op} ${r.threshold} severity=${rec.severity} delivered=${out.delivered}`);
  }

  saveState(state);
  appendSink(records);

  if (JSON_OUT) {
    fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
    fs.writeFileSync(JSON_OUT, JSON.stringify({
      at: NOW.toISOString(), rules: rules.length, groups: groups.length,
      metrics: Array.from(series.keys()).sort(), tally, records, delivery,
      webhook: WEBHOOK ? 'configured' : 'none',
    }, null, 2));
  }

  console.log(`ALERTS-49 rules=${rules.length} firing=${tally.firing} pending=${tally.pending} resolved=${tally.resolved} suppressed=${tally.suppressed} nodata=${tally.nodata}`);
  const failedDelivery = delivery.filter(d => !d.delivered && d.reason !== 'no_webhook_configured');
  if (failedDelivery.length) {
    console.error('ALERTS-49-DELIVERY-FAILED ' + failedDelivery.map(d => d.alert + ':' + d.reason).join(','));
    process.exit(3);
  }
}

main().catch(e => { console.error('ALERTS-49-FATAL', (e && e.message) || e); process.exit(2); });
