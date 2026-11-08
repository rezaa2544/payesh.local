'use strict';
/* ═══════════════════════════════════════════════════════════════════
   متریک و شمارنده — ردیف ۴۹

   چرا ماژول جدا؟ چون شمارنده‌ها باید در همان مسیر درخواستِ واقعی
   به‌روز شوند و در لحظهٔ scrape از وضعیت واقعی سرور خوانده شوند.
   هیچ عددی «ساختگی» نیست: هر سنجه از دیتابیس، پوشهٔ داده یا شمارندهٔ
   واقعی درخواست‌ها می‌آید.

   قالب خروجی: Prometheus text exposition 0.0.4 (متن ساده، بدون وابستگی).
   قاعدهٔ سخت: هیچ شناسهٔ کاربر/دانش‌آموز/توکن در سنجه‌ها نیست؛
   فقط شمارش و مدت (بدون برچسبِ هویتی) — تا /metrics خودش نشت نداشته باشد.
   ═══════════════════════════════════════════════════════════════════ */

/* پنجرهٔ خطا: نرخ خطا روی ۵ دقیقهٔ گذشته محاسبه می‌شود، نه کل عمر فرایند
   (نرخ کل عمر، خرابیِ تازه را در نویز میانگین گم می‌کند). */
const ERROR_WINDOW_MS = 5 * 60_000;

function fmtNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 1e6) / 1e6);
}

function escLabel(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labelText(labels) {
  const keys = Object.keys(labels || {}).sort();
  if (!keys.length) return '';
  return '{' + keys.map(k => `${k}="${escLabel(labels[k])}"`).join(',') + '}';
}

class Registry {
  constructor() {
    /* name → {type, help} */
    this.meta = new Map();
    /* name|labelText → {name, labels, value} */
    this.samples = new Map();
    /* collector: () => [{name, type, help, labels, value}] — در لحظهٔ scrape */
    this.collectors = [];
    /* حلقهٔ رویدادهای HTTP برای نرخ خطا */
    this.httpEvents = [];
    this.windowMs = ERROR_WINDOW_MS;
  }

  _def(name, type, help) {
    const cur = this.meta.get(name);
    if (!cur) this.meta.set(name, { type, help: help || name });
    else if (help && cur.help === name) cur.help = help;
    return name;
  }

  set(name, labels, value, { type = 'gauge', help = null } = {}) {
    this._def(name, type, help);
    const key = name + '|' + labelText(labels);
    this.samples.set(key, { name, labels: labels || {}, value: Number(value) || 0 });
    return this;
  }

  inc(name, labels, by = 1, opts = {}) {
    const key = name + '|' + labelText(labels);
    const cur = this.samples.get(key);
    const next = cur ? cur.value + Number(by) : Number(by);
    return this.set(name, labels, next, Object.assign({ type: 'counter' }, opts));
  }

  get(name, labels = {}) {
    const s = this.samples.get(name + '|' + labelText(labels));
    return s ? s.value : null;
  }

  onCollect(fn) { this.collectors.push(fn); return this; }

  /* ── هر درخواست، پس از پایان پاسخ ─────────────────────────────── */
  observeHttp(statusCode, at = Date.now()) {
    const code = Number(statusCode) || 0;
    const cls = code >= 500 ? '5xx' : code >= 400 ? '4xx' : code >= 300 ? '3xx' : '2xx';
    this.inc('payesh_http_requests_total', { class: cls }, 1, { help: 'شمارش درخواست‌های HTTP بر پایهٔ کلاس پاسخ' });
    this.httpEvents.push({ t: at, err: code >= 500 });
    this._trim(at);
  }

  _trim(now) {
    const cut = now - this.windowMs;
    let i = 0;
    while (i < this.httpEvents.length && this.httpEvents[i].t < cut) i++;
    if (i) this.httpEvents.splice(0, i);
  }

  /* نرخ خطای ۵xx در پنجرهٔ جاری؛ ۰ وقتی درخواستی نبوده */
  errorRatio(now = Date.now()) {
    this._trim(now);
    const total = this.httpEvents.length;
    if (!total) return 0;
    const errs = this.httpEvents.filter(e => e.err).length;
    return errs / total;
  }

  /* async است چون بعضی collectorها (مثل وضعیت pool در Gateway) کوئری DB
     می‌زنند؛ جمع‌کردنِ ناهمگام، عدد را واقعی نگه می‌دارد. */
  async render(now = Date.now()) {
    /* سنجه‌های لحظه‌ای از collectorها (وضعیت واقعی، هر scrape تازه خوانده می‌شود) */
    const live = new Map(this.samples); /* کپی: سنجه‌های ثابت */
    for (const fn of this.collectors) {
      let out = [];
      try {
        out = fn(now) || [];
        if (out && typeof out.then === 'function') out = await out;
      } catch (e) {
        /* خطای collector نباید scrape را بشکند، اما باید دیده شود */
        this.inc('payesh_metrics_collector_errors_total', { kind: String((e && e.code) || 'error') }, 1);
        out = [];
      }
      for (const s of out) {
        this._def(s.name, s.type || 'gauge', s.help || null);
        live.set(s.name + '|' + labelText(s.labels), { name: s.name, labels: s.labels || {}, value: Number(s.value) || 0 });
      }
    }
    /* دو سنجهٔ مشتق که همیشه باید باشند */
    const ratio = this.errorRatio(now);
    if (!this.meta.has('payesh_http_error_ratio')) this._def('payesh_http_error_ratio', 'gauge', 'نرخ پاسخ‌های 5xx در ۵ دقیقهٔ گذشته');
    live.set('payesh_http_error_ratio|', { name: 'payesh_http_error_ratio', labels: {}, value: ratio });

    const byName = new Map();
    for (const s of live.values()) {
      if (!byName.has(s.name)) byName.set(s.name, []);
      byName.get(s.name).push(s);
    }
    const names = Array.from(byName.keys()).sort();
    const lines = [];
    for (const name of names) {
      const m = this.meta.get(name) || { type: 'gauge', help: name };
      lines.push(`# HELP ${name} ${m.help.replace(/\n/g, ' ')}`);
      lines.push(`# TYPE ${name} ${m.type}`);
      const rows = byName.get(name).slice().sort((a, b) => labelText(a.labels).localeCompare(labelText(b.labels)));
      for (const r of rows) lines.push(`${r.name}${labelText(r.labels)} ${fmtNum(r.value)}`);
    }
    return lines.join('\n') + '\n';
  }

  reset() { this.samples.clear(); this.httpEvents = []; this.collectors = []; this.meta.clear(); return this; }
}

function create() { return new Registry(); }

module.exports = { create, Registry, labelText, fmtNum };
