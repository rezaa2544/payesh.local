'use strict';
// سنجه‌ها: صدک‌ها، منابع، ظرفیت، هزینه و گلوگاه — همه از اندازه‌گیری واقعی، بدون عدد ساختگی (D‑11)

function percentile(sortedSamples, p) {
  if (!sortedSamples.length) return null;
  const idx = Math.min(sortedSamples.length - 1, Math.max(0, Math.ceil((p / 100) * sortedSamples.length) - 1));
  return sortedSamples[idx];
}

function summarize(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return { n: 0, p50: null, p95: null, p99: null, max: null, mean: null };
  const sum = s.reduce((a, b) => a + b, 0);
  const r = (v) => Math.round(v * 1000) / 1000;
  return { n, p50: r(percentile(s, 50)), p95: r(percentile(s, 95)), p99: r(percentile(s, 99)), max: r(s[n - 1]), mean: r(sum / n) };
}

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

function resourceSnapshot() {
  const cpu = process.cpuUsage();
  const mem = process.memoryUsage();
  return { cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000, heapUsedMB: round(mem.heapUsed / 2 ** 20), rssMB: round(mem.rss / 2 ** 20) };
}

function resourceDelta(a, b) {
  return {
    cpuMs: round((b.cpuUserMs + b.cpuSystemMs) - (a.cpuUserMs + a.cpuSystemMs), 1),
    cpuUserMs: round(b.cpuUserMs - a.cpuUserMs, 1),
    rssDeltaMB: round(b.rssMB - a.rssMB),
    heapDeltaMB: round(b.heapUsedMB - a.heapUsedMB),
  };
}

// دسته‌بندی خطا: ۵xx و قطعی از ۴xx جدا می‌شوند (C‑3 فقط ۵xx را می‌شمارد)
function classify(err) {
  if (!err) return 'none';
  if (err.kind === 'dc_down' || err.kind === 'app_unavailable') return 'outage';
  if (err.kind === 'network') return 'network';
  const st = err.status || 0;
  if (st >= 500) return '5xx';
  if (st === 429) return 'rate_limited';
  if (st === 404) return 'not_found';
  if (st === 403) return 'forbidden';
  if (st === 401) return 'auth';
  if (st >= 400) return '4xx';
  return 'other';
}

// ---------- مدل هزینه: قیمت واحد نامعلوم ⇒ هیچ جمع کلی ادعا نمی‌شود (۱۶ §۷.۲) ----------
const UNIT_PRICES = {
  p_egress: [0.008, 0.012],    // €/GB — بازهٔ عمومی [E]؛ قرارداد میزبان (O‑HOST) ?
  p_storage: [0.010, 0.015],   // €/GB‑ماه [E]
  p_vcpu: null,                // ?
  p_db: null,                  // ?
};

function costModel({ cpuSeconds = 0, writeOps = 0, readOps = 0, egressGB = 0, storageGB = 0, logGB = 0, tenants = 1 } = {}) {
  const rng = (gb, p) => [round(gb * p[0]), round(gb * p[1])];
  const known = {
    egressEUR: rng(egressGB, UNIT_PRICES.p_egress),
    storageEUR: rng(storageGB, UNIT_PRICES.p_storage),
    logEUR: rng(logGB, UNIT_PRICES.p_storage),
  };
  const knownSubtotalEUR = [
    round(known.egressEUR[0] + known.storageEUR[0] + known.logEUR[0]),
    round(known.egressEUR[1] + known.storageEUR[1] + known.logEUR[1]),
  ];
  return {
    unitPrices: UNIT_PRICES,
    known, knownSubtotalEUR,
    unknown: ['p_vcpu', 'p_db', 'total'],
    total: null,                                  // هرگز ادعا نمی‌شود
    measured: { cpuSeconds: round(cpuSeconds, 2), writeOps, readOps, tenants, opsPerCpuSecond: cpuSeconds > 0 ? round((writeOps + readOps) / cpuSeconds) : null },
    note: 'اجزای شناخته‌شده با بازهٔ عمومی [E]؛ p_vcpu و p_db نامعلوم (O‑HOST) ⇒ جمع کل ادعا نمی‌شود.',
  };
}

// ---------- ظرفیت و گلوگاه: فقط از اندازه‌گیری همان اجرا ----------
function capacityReport(stages) {
  const ok = stages.filter((s) => s.errorRate < 0.001);
  const best = ok.reduce((a, b) => (b.rps > a.rps ? b : a), ok[0] || null);
  return {
    source: 'measured',
    basis: best ? `stage:${best.label} (workers=${best.workers}, ops=${best.ops})` : 'no-stage-passed',
    rps: best ? best.rps : 0,
    stageLabel: best ? best.label : null,
    note: 'این عدد ظرفیت «یک فرایند نمونه روی همین ماشین» است، نه ظرفیت تولید (D‑11).',
  };
}

function bottleneckReport({ capacity, readOps, writeOps, cpuMs, ops, auditRows, conflictScanMs, conflictScanRows }) {
  const cpuPerOpUs = ops > 0 && cpuMs > 0 ? round((cpuMs * 1000) / ops, 1) : null;
  return {
    measured: [
      {
        id: 'poll_1s_dominance',
        title: 'نظرسنجی ۱‑ثانیه‌ای دستگاه‌ها گلوگاه غالب RPS است (۰۴ §۱)',
        evidence: `نسبت خواندن/نوشتن در این اجرا ${writeOps ? round(readOps / writeOps, 2) : 'n/a'}؛ RPS_نظرسنجی = تعداد دستگاه ÷ ۱s، مستقل از حجم نوشتن`,
      },
      {
        id: 'single_process_cpu',
        title: 'سقف واقعی، یک فرایند تک‌رشته‌ای است',
        evidence: `${capacity.rps} op/s اندازه‌گیری‌شده · ${cpuPerOpUs}µs CPU به ازای هر op`,
      },
      {
        id: 'serialized_audit_chain',
        title: 'زنجیرهٔ حسابرسی سریال، هر نوشتن را به نوبت می‌برد',
        evidence: `${auditRows} ردیف حسابرسی برای ${writeOps} نوشتن ⇒ O(1) اما تک‌نخی`,
      },
      {
        id: 'conflict_scan_linear',
        title: 'نمای تعارض‌های باز خطی است',
        evidence: conflictScanMs === null
          ? 'اندازه‌گیری نشده ⇒ UNKNOWN (ادعا نمی‌شود)'
          : `${conflictScanRows} ردیف در ${conflictScanMs}ms — خطی نسبت به تعداد تعارض باز`,
      },
    ],
  };
}

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

module.exports = {
  percentile, summarize, resourceSnapshot, resourceDelta, classify,
  costModel, capacityReport, bottleneckReport, stableStringify, UNIT_PRICES, round,
};
