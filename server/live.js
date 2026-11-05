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
   ═══════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const s3mem = require('./s3mem');
const outbox = require('./outbox');

const REV_KEY = 'realtime/rev.json';
const INTERVAL_MS = 1000;          /* خواستهٔ صریح: هر ۱ ثانیه */

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

/* ── یک تیکِ یک‌ثانیه‌ای ─────────────────────────────────────────── */
let timer = null;
let running = false;
let last = { at: null, pushed: 0, pulled: 0, error: null };

async function tick(store) {
  if (running) return;
  running = true;
  try {
    const cfg = await cloudCfg(store);
    if (!cfg) { last = Object.assign({}, last, { error: 'no_cloud', at: new Date().toISOString() }); return; }

    /* ۱) تغییرهای همین سیستم (کاربری که در رایانهٔ مدرسه کار می‌کند)
          بی‌درنگ در حافظهٔ مشترک نوشته می‌شوند. */
    const mine = localRev(store);
    if (mine !== String(store.getMeta('live:published', ''))) {
      const r = await outbox.publishAll(store);
      if (r && (r.data && r.data.ok)) {
        await writeRev(store, cfg, { core: token(), persons: token() });
        store.setMeta('live:published', mine);
        last.pushed++;
      }
    }

    /* ۲) تغییرهای دیگر دستگاه‌ها (گوشی‌ها) خوانده و اعمال می‌شوند. */
    const rev = await readRemote(store);
    if (rev && rev.rev && rev.rev !== String(store.getMeta('live:seen', ''))) {
      store.setMeta('live:seen', rev.rev);
      const d = await outbox.drain(store);
      if (d && d.applied) {
        bumpLocal(store);
        last.pulled += d.applied;
      }
    }
    last.at = new Date().toISOString();
    last.error = null;
  } catch (e) {
    last.error = String((e && e.message) || e).slice(0, 160);
  } finally {
    running = false;
  }
}

function start(store, { everyMs = INTERVAL_MS } = {}) {
  if (timer) clearInterval(timer);
  /* آزمون‌های قطعی می‌توانند با PAYESH_LIVE_MS=0 خاموشش کنند */
  if (Number(everyMs) === 0) return null;
  const loop = () => { tick(store).catch(() => {}); };
  /* یک‌بار بلافاصله، بعد هر ثانیه */
  setTimeout(loop, 800).unref?.();
  timer = setInterval(loop, Math.max(500, everyMs));
  timer.unref?.();
  return timer;
}

function stop() { if (timer) clearInterval(timer); timer = null; }

function status(store) {
  return {
    every_ms: INTERVAL_MS,
    last,
    local_rev: localRev(store),
    published_rev: String(store.getMeta('live:published', '')),
    seen_rev: String(store.getMeta('live:seen', '')),
  };
}

module.exports = { start, stop, status, readRemote, writeRev, localRev, bumpLocal, cloudCfg, keyOf, REV_KEY, INTERVAL_MS, token };
