'use strict';
/* ═══════════════════════════════════════════════════════════════════
   همگام‌سازی زندهٔ هر یک ثانیه — از آنِ همه (مدیر، عوامل اجرایی، دبیر،
   دانش‌آموز، ولی) و روی همهٔ دستگاه‌ها (رایانهٔ مدرسه و گوشی‌ها).

   ایده ساده است:
     ۱) هر تغییر، همان لحظه در «حافظهٔ مشترک» (Arvan) نوشته می‌شود.
     ۲) در حافظه یک فایل کوچک به نام realtime/rev.json هست که فقط
        می‌گوید «چیزی عوض شد» (و کدام بخش: کل داده یا پروندهٔ اشخاص).
     ۳) همهٔ دستگاه‌ها هر ۱ ثانیه فقط همین فایل کوچک را می‌خوانند
        (چند صد بایت). اگر «مُهر» عوض شده باشد، همان لحظه بخشِ
        تغییرکرده را می‌گیرند.
     ۴) اگر دستگاه مقصد آنلاین نباشد، داده در همان حافظه می‌ماند و
        اولین ثانیه‌ای که آنلاین شود تحویل می‌گیرد.

   این ماژول سمتِ «سیستم مدرسه» را انجام می‌دهد: نوشتن تغییرهای محلی
   در حافظه، و برداشتن تغییرهای دستگاه‌های دیگر (گوشی‌ها) هر ثانیه.
   ردیف ۱۷۷ (خواستهٔ مالک: «تا تغییری نشده، الکی هر لحظه همه‌چیز را چک نکن»):
     • تغییرِ همین سیستم دیگر با پرسیدنِ هر‌ثانیه پیدا نمی‌شود؛ هاب رویداد (events.js)
       همان لحظهٔ نوشتن خبر می‌دهد و فقط آن‌وقت در حافظه نوشته می‌شود.
     • نگاه به مُهر حافظه (تغییر گوشی‌ها) «تطبیقی» است: پس از هر فعالیت (تغییر محلی، تغییر
       گوشی، دستگاهی که وصل شد/پرسید) تا ۲ دقیقه هر ۱ ثانیه؛ بعد هر بار دو برابر تا سقف
       ۶۰ ثانیه وقتی دستگاهی وصل است، و ۵ دقیقه وقتی هیچ‌کس وصل نیست و فعالیتی نبوده.
       بیکار: ~۱٬۴۴۰ درخواست در روز به‌جای ۸۶٬۴۰۰ (۶۰ برابر کمتر)؛ در کار: همان ۱ ثانیه.
   ═══════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const s3mem = require('./s3mem');
const outbox = require('./outbox');

const REV_KEY = 'realtime/rev.json';
const INTERVAL_MS = 1000;          /* هنگام فعالیت: هر ۱ ثانیه (خواستهٔ قبلی مالک) */
const ACTIVE_WINDOW_MS = 120_000;  /* ردیف ۱۷۷: پس از هر فعالیت، ۲ دقیقه سریع */
const IDLE_MAX_MS = 60_000;        /* بیکار ولی دستگاهی وصل است */
const ASLEEP_MAX_MS = 300_000;     /* هیچ دستگاهی وصل نیست و فعالیتی نبوده */
const events = require('./events');

const token = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* نتیجهٔ «صندوقچه کدام است» را چند ثانیه نگه می‌داریم تا حلقهٔ یک‌ثانیه‌ای
   وقتی اینترنت نیست، هر ثانیه درخواست تازه به شبکه نفرستد. */
let cfgCache = { at: 0, cfg: null };
async function cloudCfg(store, { fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && now - cfgCache.at < 10_000) return cfgCache.cfg;
  try {
    const c = await s3mem.ensureBucket(store);
    cfgCache = { at: now, cfg: c && c.enabled ? c : null };
    return cfgCache.cfg;
  } catch (e) {
    cfgCache = { at: now, cfg: null };
    return null;
  }
}

function keyOf(cfg, rel) { return String(cfg.prefix || 'payesh/') + rel; }

/* ── «مُهر» محلی: هر تغییری در هر جدولی این را عوض می‌کند ─────────── */
function localRev(store) {
  let seq = 0;
  try { seq = Number(store.getMeta('live:seq', 0)) || 0; } catch (e) { seq = 0; }
  let at = '';
  try { at = store.maxUpdatedAt() || ''; } catch (e) { at = ''; }
  return seq + ':' + at;
}
function bumpLocal(store) {
  try { store.setMeta('live:seq', (Number(store.getMeta('live:seq', 0)) || 0) + 1); } catch (e) { /* noop */ }
}

/* ── خواندن/نوشتن مُهر مشترک ─────────────────────────────────────── */
async function readRemote(store, opts) {
  const cfg = await cloudCfg(store, opts);
  if (!cfg) return null;
  try {
    const text = await s3mem.get(cfg, keyOf(cfg, REV_KEY));
    const j = JSON.parse(text);
    return j && j.rev ? j : null;
  } catch (e) {
    return null;
  }
}

async function writeRev(store, cfg, patch) {
  const cur = (await readRemote(store)) || {};
  const body = Object.assign({ v: 1, rev: token(), at: new Date().toISOString(), by: 'school' },
    { core: cur.core || token(), persons: cur.persons || token() }, patch || {});
  try {
    await s3mem.put(cfg, keyOf(cfg, REV_KEY), JSON.stringify(body));
    return body;
  } catch (e) {
    return null;
  }
}

/* ── نوشتن فایل‌ها فقط وقتی عوض شده‌اند (پهنای‌باند کم بماند) ───── */
const hashes = new Map();
function hashOf(text) { return crypto.createHash('sha1').update(text).digest('hex'); }

async function publishChanged(store, cfg) {
  /* outbox.publishAll نسخه‌های به‌روزِ auth و data را می‌سازد؛ اما ما
     نمی‌خواهیم هر ثانیه همه را دوباره بنویسیم، پس یک لایهٔ کش داریم. */
  const before = hashes.size;
  await outbox.publishAll(store);
  return hashes.size !== before || true;
}

/* ── یک تیک ────────────────────────────────────────────────────────── */
let timer = null;
let running = false;
let dirty = false;       /* تغییر محلی منتشرنشده (از هاب رویداد) */
let lastActivity = 0;    /* آخرین فعالیت (ms) */
let delayMs = INTERVAL_MS;
let opts = { everyMs: INTERVAL_MS, idleMaxMs: IDLE_MAX_MS, asleepMaxMs: ASLEEP_MAX_MS, activeWindowMs: ACTIVE_WINDOW_MS };
let storeRef = null;
let offEvents = null;
let last = { at: null, pushed: 0, pulled: 0, checks: 0, error: null };

/** فعالیت ⇒ چند دقیقه سریع نگاه کن (دستگاهی پرسید، وصل شد، یا چیزی نوشت). */
function touch() {
  lastActivity = Date.now();
  if (storeRef && delayMs > opts.everyMs && !running) reschedule(opts.everyMs);
}

/** قاعدهٔ تطبیقی (خالص، آزمون‌پذیر): تا [activeWindowMs] پس از فعالیت ⇒ [everyMs]؛ بعد هر بار
 *  دو برابر تا سقف — [idleMaxMs] اگر دستگاهی وصل است، وگرنه [asleepMaxMs]. */
function adaptiveDelay({ now, lastActivity: la, prevDelay, clients, opts: o }) {
  if (now - la < o.activeWindowMs) return o.everyMs;
  const cap = clients > 0 ? o.idleMaxMs : o.asleepMaxMs;
  return Math.min(cap, Math.max(o.everyMs, prevDelay * 2));
}

/** فاصلهٔ نگاه بعدی (تطبیقی). */
function nextDelay(changed) {
  const now = Date.now();
  if (changed) lastActivity = now;
  return adaptiveDelay({ now, lastActivity, prevDelay: delayMs, clients: events.clientCount(), opts });
}

async function tick(store) {
  if (running) return false;
  running = true;
  let changed = false;
  try {
    const cfg = await cloudCfg(store);
    if (!cfg) { last = Object.assign({}, last, { error: 'no_cloud', at: new Date().toISOString() }); return false; }

    /* ۱) تغییرهای همین سیستم (کاربری که در رایانهٔ مدرسه کار می‌کند) — فقط وقتی هاب
          رویداد خبر داده (یا بار اول)، نه با پرسیدن هر ثانیه. */
    if (dirty) {
      dirty = false;
      const r = await outbox.publishAll(store);
      if (r && (r.data && r.data.ok)) {
        await writeRev(store, cfg, { core: token(), persons: token() });
        store.setMeta('live:published', localRev(store));
        last.pushed++;
        changed = true;
      } else {
        dirty = true; /* بعداً دوباره */
      }
    }

    /* ۲) تغییرهای دیگر دستگاه‌ها (گوشی‌ها) خوانده و اعمال می‌شوند. */
    last.checks++;
    const rev = await readRemote(store);
    if (rev && rev.rev && rev.rev !== String(store.getMeta('live:seen', ''))) {
      store.setMeta('live:seen', rev.rev);
      const d = await outbox.drain(store);
      if (d && d.applied) {
        bumpLocal(store);
        last.pulled += d.applied;
      }
      changed = true;
    }
    last.at = new Date().toISOString();
    last.error = null;
  } catch (e) {
    last.error = String((e && e.message) || e).slice(0, 160);
  } finally {
    running = false;
  }
  return changed;
}

function reschedule(ms) {
  if (timer) clearTimeout(timer);
  delayMs = Math.max(0, ms);
  timer = setTimeout(loop, delayMs);
  timer.unref?.();
}

function loop() {
  const store = storeRef;
  if (!store) return;
  tick(store).catch(() => false).then((changed) => {
    if (!storeRef) return;
    if (dirty) { reschedule(opts.everyMs); return; } /* تغییری وسط کار رسید */
    reschedule(nextDelay(changed));
  });
}

function start(store, { everyMs = INTERVAL_MS, idleMaxMs, asleepMaxMs, activeWindowMs } = {}) {
  stop();
  /* آزمون‌های قطعی می‌توانند با PAYESH_LIVE_MS=0 خاموشش کنند */
  if (Number(everyMs) === 0) return null;
  const fast = Math.max(500, Number(everyMs) || INTERVAL_MS);
  const envAct = process.env.PAYESH_LIVE_ACTIVE_MS;
  opts = {
    everyMs: fast,
    idleMaxMs: Math.max(fast, Number(idleMaxMs || process.env.PAYESH_LIVE_IDLE_MS) || IDLE_MAX_MS),
    asleepMaxMs: Math.max(fast, Number(asleepMaxMs || process.env.PAYESH_LIVE_ASLEEP_MS) || ASLEEP_MAX_MS),
    activeWindowMs: Math.max(0, Number(activeWindowMs != null ? activeWindowMs : (envAct != null && envAct !== '' ? envAct : ACTIVE_WINDOW_MS))),
  };
  storeRef = store;
  lastActivity = Date.now();
  /* فقط یک‌بار هنگام روشن شدن: تغییرهایی که وقتی سرور خاموش بود ثبت شده‌اند */
  try { dirty = localRev(store) !== String(store.getMeta('live:published', '')); } catch (e) { dirty = true; }
  /* تغییر محلی ⇒ همان لحظه (پس از ادغام ۱۵۰ms هاب) منتشر شود */
  offEvents = events.onChange(() => {
    dirty = true;
    lastActivity = Date.now();
    if (!running) reschedule(0);
  });
  reschedule(800); /* یک‌بار تقریباً بلافاصله */
  return timer;
}

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
  storeRef = null;
  if (offEvents) offEvents();
  offEvents = null;
}

function status(store) {
  return {
    every_ms: opts.everyMs,
    /* ردیف ۱۷۷: نگاه تطبیقی — فاصلهٔ فعلی و سقف‌ها */
    delay_ms: timer ? delayMs : null,
    idle_max_ms: opts.idleMaxMs,
    asleep_max_ms: opts.asleepMaxMs,
    active_window_ms: opts.activeWindowMs,
    clients: events.clientCount(),
    last,
    local_rev: localRev(store),
    published_rev: String(store.getMeta('live:published', '')),
    seen_rev: String(store.getMeta('live:seen', '')),
  };
}

module.exports = { start, stop, status, touch, nextDelay, adaptiveDelay, ACTIVE_WINDOW_MS, IDLE_MAX_MS, ASLEEP_MAX_MS, readRemote, writeRev, localRev, bumpLocal, cloudCfg, keyOf, REV_KEY, INTERVAL_MS, token };
