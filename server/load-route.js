'use strict';
/* ═══════════════════════════════════════════════════════════════════
   مسیر بار (ردیف ۱۵۳) — سه حالت معماری و بالا/پایین رفتن خودکار با زمان پاسخ
   ───────────────────────────────────────────────────────────────────
   حالت‌ها (پنل مالک ⇐ سیاست زیرساخت payesh/control/infra-policy.json، فیلد mode):
     db        فقط دیتابیس؛ سیستم‌های پنل مالک هیچ پردازشی نمی‌گیرند.
     helpers   دیتابیس اصلی؛ سیستم‌های پنل مالک (هر کدام کلید جدا) فقط وقتی دیتابیس کمک بخواهد.
     external  سرور بیرونی اصلی ⇐ زیر بار: دیتابیس هم ⇐ باز زیر بار: سیستم‌های کمکی.
               اگر سرور بیرونی تنظیم نشده یا در دسترس نیست، همان زنجیرهٔ helpers.

   سنجش: زمان پاسخ p95 و نرخ خطا در ۶۰ ثانیهٔ اخیر (پنجرهٔ لغزان، نه میانگین ساده) +
   شلوغی خود سرور. بالا رفتن فوری است (یک پله در هر نمونه)؛ پایین آمدن فقط وقتی همان
   زیرساختی که باعث بالا رفتن شد ۶۰ ثانیه پیوسته آرام بماند (پسماند ⇒ بدون نوسان).
   قرارداد مشترک Node = Dart: docs/cloud/contracts/load-route-vectors.json
   (owner/lib/src/infra/load_route.dart).
   ═══════════════════════════════════════════════════════════════════ */

const MODES = ['db', 'helpers', 'external'];
const THRESHOLDS = Object.freeze({
  hi_ms: 1200,      /* p95 بالاتر ⇒ زیر بار */
  lo_ms: 500,       /* p95 پایین‌تر ⇒ آرام */
  err_hi: 0.2,      /* نرخ خطای بالاتر ⇒ زیر بار */
  err_lo: 0.05,     /* نرخ خطای پایین‌تر ⇒ آرام */
  hold_ms: 60000,   /* آرامش پیوسته پیش از پایین آمدن */
  min_samples: 5,   /* با نمونهٔ کمتر، زمان پاسخ داوری نمی‌شود (فقط خطا) */
  window_ms: 60000,
  window_max: 200,
});

const modeOf = (p) => {
  if (p && MODES.includes(p.mode)) return p.mode;
  return p && p.helpers === false ? 'db' : 'helpers';
};

function chainFor(mode, extOk) {
  if (mode === 'db') return ['db'];
  if (mode === 'external' && extOk) return ['external', 'db', 'helpers'];
  return ['db', 'helpers'];
}

/* m = {p95, err, n, busy} یا null (بدون سنجه، مثلاً سیستم‌های کمکی) */
function stressed(m, t) {
  if (!m) return false;
  if (m.busy === true) return true;
  if (m.err > t.err_hi) return true;
  return m.n >= t.min_samples && m.p95 > t.hi_ms;
}
function calm(m, t) {
  if (!m) return true;
  if (m.busy === true || m.err >= t.err_lo) return false;
  return m.n < t.min_samples || m.p95 < t.lo_ms;
}

const initialState = () => ({ v: 1, chain: ['db'], level: 0, changed_ms: 0, calm_ms: null, reason: 'start' });

/* یک گام: state قبلی + نمونهٔ تازه ⇒ state تازه (تابع خالص، بدون ساعت و شبکه).
   s = {now_ms, mode, ext: {ok, p95, err, n}|null, db: {p95, err, n, busy}, helpers: عدد|null}
   helpers = تعداد سیستم‌های کمکیِ فعال (null = نامعلوم ⇒ فرض: هست). */
function step(prev, s, t = THRESHOLDS) {
  const st = Object.assign(initialState(), prev || {});
  const now = s.now_ms;
  const extOk = !!(s.ext && s.ext.ok);
  const chain = chainFor(MODES.includes(s.mode) ? s.mode : 'helpers', extOk);
  let { level, changed_ms, calm_ms, reason } = st;
  if (chain.join('>') !== st.chain.join('>')) {
    level = 0; changed_ms = now; calm_ms = null;
    reason = s.mode === 'external' && !extOk ? 'external_down' : 'mode';
  }
  const metric = (tier) => tier === 'external' ? s.ext : tier === 'db' ? s.db : null;
  const last = chain[level];
  if (level < chain.length - 1 && stressed(metric(last), t)) {
    const next = chain[level + 1];
    if (next === 'helpers' && s.helpers === 0) {
      reason = 'no_helpers';
    } else {
      level += 1; changed_ms = now; calm_ms = null; reason = 'escalate:' + last;
    }
  } else if (level > 0) {
    const trigger = chain[level - 1];
    if (calm(metric(trigger), t)) {
      if (calm_ms == null) calm_ms = now;
      if (now - calm_ms >= t.hold_ms) {
        level -= 1; changed_ms = now; calm_ms = null; reason = 'recovered:' + trigger;
      }
    } else {
      calm_ms = null;
    }
  }
  return { v: 1, chain, level, changed_ms, calm_ms, reason };
}

const routeOf = (st) => ({
  chain: st.chain.slice(),
  level: st.level,
  primary: st.chain[0],
  active: st.chain.slice(0, st.level + 1),
  reason: st.reason,
});

/* p95 به روش «رتبهٔ نزدیک»: مرتب‌سازی صعودی، عنصر ceil(0.95·n)−۱ */
function p95(values) {
  if (!values.length) return 0;
  const a = values.slice().sort((x, y) => x - y);
  return a[Math.max(0, Math.ceil(0.95 * a.length) - 1)];
}

/* پنجرهٔ لغزان زمان پاسخ و خطا */
class LatencyWindow {
  constructor(t = THRESHOLDS) { this.t = t; this.items = []; }
  record(ms, ok, at = Date.now()) {
    this.items.push({ ms: Math.max(0, Math.round(ms)), ok: !!ok, at });
    if (this.items.length > this.t.window_max) this.items.splice(0, this.items.length - this.t.window_max);
  }
  stats(now = Date.now()) {
    const from = now - this.t.window_ms;
    this.items = this.items.filter(x => x.at >= from);
    const n = this.items.length;
    const okMs = this.items.filter(x => x.ok).map(x => x.ms);
    const errors = n - okMs.length;
    return {
      n,
      p95: p95(okMs),
      avg: okMs.length ? Math.round(okMs.reduce((a, b) => a + b, 0) / okMs.length) : 0,
      err: n ? Math.round((errors / n) * 1000) / 1000 : 0,
      per_min: Math.round(n * 60000 / this.t.window_ms),
    };
  }
}

/* ── وضعیت همین سرور (Node) ──────────────────────────────────────────── */
const db = new LatencyWindow();
const ext = new LatencyWindow();
let state = initialState();
let extProbe = { url: '', ok: false, at: 0, ms: 0 };

/* fetch اندازه‌گیری‌شده برای s3mini: هر درخواست واقعی به دیتابیس یک نمونه است */
function metered(fetchFn) {
  return (url, opts) => {
    const t0 = Date.now();
    return fetchFn(url, opts).then((r) => {
      db.record(Date.now() - t0, r.status < 500);
      return r;
    }, (e) => {
      db.record(Date.now() - t0, false);
      throw e;
    });
  };
}

/* بررسی سرور بیرونی: GET <url>/healthz هر ۳۰ ثانیه (فقط در حالت external) */
const EXT_PROBE_MS = 30000;
async function probeExternal(url, fetchFn, now = Date.now()) {
  if (!url) { extProbe = { url: '', ok: false, at: now, ms: 0 }; return extProbe; }
  if (extProbe.url === url && now - extProbe.at < EXT_PROBE_MS) return extProbe;
  const t0 = Date.now();
  let ok = false;
  try {
    const r = await fetchFn(url.replace(/\/+$/, '') + '/healthz', { method: 'GET', timeoutMs: 5000, maxBody: 65536 });
    ok = r.status >= 200 && r.status < 400;
  } catch (e) { ok = false; }
  const ms = Date.now() - t0;
  ext.record(ms, ok, now);
  extProbe = { url, ok, at: now, ms };
  return extProbe;
}

/* یک گام برای همین سرور با سیاست جاری (policy از دیتابیس) */
function tick(policy, { busy = false, now = Date.now(), helpers = null } = {}) {
  const mode = modeOf(policy);
  const url = policy && typeof policy.external === 'string' ? policy.external : '';
  const es = ext.stats(now);
  const extState = mode === 'external' && url && extProbe.url === url
    ? Object.assign({ ok: extProbe.ok && now - extProbe.at < 3 * EXT_PROBE_MS }, es)
    : null;
  state = step(state, { now_ms: now, mode, ext: extState, db: Object.assign({ busy: !!busy }, db.stats(now)), helpers });
  return routeOf(state);
}

function snapshot(now = Date.now()) {
  return { route: routeOf(state), db: db.stats(now), external: extProbe.url ? Object.assign({ ok: extProbe.ok }, ext.stats(now)) : null };
}

function _reset() { db.items = []; ext.items = []; state = initialState(); extProbe = { url: '', ok: false, at: 0, ms: 0 }; }

module.exports = {
  MODES, THRESHOLDS, modeOf, chainFor, stressed, calm, initialState, step, routeOf, p95,
  LatencyWindow, metered, probeExternal, tick, snapshot, db, _reset,
};
