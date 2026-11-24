'use strict';
/* ═══════════════════════════════════════════════════════════════════════
   ردیف ۱۷۷ — هاب رویداد (publish / subscribe): «تا چیزی عوض نشده، هیچ‌کس چیزی نپرسد».

   به‌جای این‌که هر دستگاه هر لحظه بپرسد «چیزی عوض شد؟»، خودِ سرور همان لحظهٔ تغییر خبر
   می‌دهد و فقط می‌گوید «کدام بخش» (نام مجموعه‌ها: users، attendance، grades …). دستگاه
   فقط همان بخش را می‌گیرد (‎/api/v1/pull?collections=…‎، با ETag ⇒ اگر چیزی نبود ۳۰۴).

     ۱) هر نوشتن در پایگاه داده (Store.insert / update / remove) ⇒ publish(collection)
     ۲) چند تغییرِ پشت‌سرهم در ۱۵۰ میلی‌ثانیه یک رویداد می‌شوند (coalesce)
     ۳) GET ‎/api/v1/events‎ یک اتصال بازِ Server-Sent Events است: وقتی خبری نیست تقریباً
        صفر بایت (فقط یک «:» چندبایتی هر ۴۵ ثانیه تا NAT/پراکسی اتصال را نبندد)
     ۴) اگر اتصال قطع شود، مرورگر/برنامه خودش دوباره وصل می‌شود و با «seq» آخر می‌فهمد
        چیزی جا مانده یا نه (اگر seq عوض شده بود ⇒ یک pull معمولی)

   داده هرگز در رویداد نیست — فقط نام مجموعه و شماره؛ خواندن داده همان مسیر احراز هویت و
   محدودهٔ (scope) همیشگی ‎/api/v1/pull‎ است.
   ═══════════════════════════════════════════════════════════════════════ */
const { EventEmitter } = require('events');

const COALESCE_MS = 150;
const HEARTBEAT_MS = 45_000;
const MAX_CLIENTS = 1000;

const bus = new EventEmitter();
bus.setMaxListeners(0);

let seq = 0;
let pending = new Set();
let flushTimer = null;
let lastAt = null;
const clients = new Set();

/** شمارهٔ آخرین رویداد (برای دستگاهی که دوباره وصل می‌شود). */
function currentSeq() { return seq; }

/** یک تغییر در مجموعهٔ [collection]؛ چند تغییر نزدیک به هم یک رویداد می‌شوند. */
function publish(collection) {
  pending.add(String(collection || '*'));
  if (flushTimer) return;
  flushTimer = setTimeout(flush, COALESCE_MS);
  flushTimer.unref?.();
}

function flush() {
  flushTimer = null;
  if (!pending.size) return;
  const topics = [...pending].sort();
  pending = new Set();
  seq += 1;
  lastAt = new Date().toISOString();
  bus.emit('change', { seq, topics, at: lastAt });
}

/** شنیدن تغییرها در خودِ سرور (live.js، …). خروجی: تابع لغو. */
function onChange(fn) {
  bus.on('change', fn);
  return () => bus.off('change', fn);
}

/** Store را به هاب وصل می‌کند: هر نوشتن ⇒ publish. */
function attachStore(store) {
  if (!store || typeof store.onWrite !== 'function') return () => {};
  return store.onWrite((collection) => publish(collection));
}

/* ── اتصال SSE ─────────────────────────────────────────────────────── */
function parseTopics(raw) {
  const t = String(raw || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 64);
  return t.length ? new Set(t) : null; // null = همه
}

/**
 * GET ‎/api/v1/events?topics=a,b&since=<seq>‎ — اتصال باز SSE.
 * هر رویداد: ‎event: change\ndata: {"seq":N,"topics":[…],"at":"…"}‎
 */
function serve(req, res, { topics, since, heartbeatMs = HEARTBEAT_MS } = {}) {
  if (clients.size >= MAX_CLIENTS) {
    res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '30' });
    res.end(JSON.stringify({ ok: false, error: 'busy' }));
    return;
  }
  const want = parseTopics(topics);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  req.socket?.setTimeout?.(0);
  req.socket?.setKeepAlive?.(true, 30_000);
  const send = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) { /* closed */ }
  };
  // اگر دستگاه از seq دیگری می‌آید، همان اول می‌گوییم «چیزی جا مانده»
  const s0 = Number(since);
  res.write('retry: 10000\n');
  send('hello', { seq, at: lastAt, missed: Number.isFinite(s0) && s0 !== seq && s0 >= 0 && since !== undefined && since !== null && since !== '' });
  const c = { at: Date.now() };
  clients.add(c);
  const off = onChange((ev) => {
    const hit = want ? ev.topics.filter(t => want.has(t) || t === '*') : ev.topics;
    if (hit.length) send('change', { seq: ev.seq, topics: hit, at: ev.at });
  });
  const hb = setInterval(() => { try { res.write(':\n\n'); } catch (e) { /* closed */ } }, Math.max(1000, heartbeatMs));
  hb.unref?.();
  const close = () => {
    clearInterval(hb);
    off();
    clients.delete(c);
  };
  req.on('close', close);
  res.on('close', close);
  res.on('error', close);
}

/** شمار دستگاه‌های وصل (live.js با آن تصمیم می‌گیرد چقدر زود حافظه را نگاه کند). */
function clientCount() { return clients.size; }

function status() {
  return { seq, at: lastAt, clients: clients.size, coalesce_ms: COALESCE_MS, heartbeat_ms: HEARTBEAT_MS };
}

/* فقط آزمون‌ها */
function _reset() {
  seq = 0; pending = new Set(); lastAt = null;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  bus.removeAllListeners('change');
}

module.exports = {
  publish, onChange, attachStore, serve, clientCount, currentSeq, status,
  COALESCE_MS, HEARTBEAT_MS, _reset, _flush: flush,
};
