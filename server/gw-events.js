'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۱۷۸ — اعلان تغییر از راه Gateway (SSE)، همتای server/events.js

   ردیف ۱۷۷ اعلان فوری را فقط روی شبکهٔ مدرسه (/api/v1/events) داشت؛ دستگاهی که از
   اینترنت و Gateway همگام می‌شد هنوز «سرکشی» می‌کرد. اینجا هم همان قرارداد:
     GET /api/gw/v1/events?since=<seq>&topics=a,b   (توکن Gateway؛ مستأجر فقط از توکن)
     event: hello  {seq, at, missed}
     event: change {seq, topics, at}   — فقط وقتی چیزی نوشته شد (۱۵۰ms یکجا)
     «:» هر ۴۵ ثانیه تا پراکسی‌ها اتصال را نبندند.

   منبع تغییر (کم‌هزینه برای دیتابیس):
   ۱) PostgreSQL LISTEN/NOTIFY — applyOps داخل همان تراکنش pg_notify می‌زند؛ پس بعد از
      commit به «همهٔ» نمونه‌های Gateway می‌رسد (push روی نمونهٔ ۱، اعلان روی نمونهٔ ۲).
      فقط یک اتصال LISTEN برای هر نمونه، آن هم فقط وقتی دست‌کم یک دستگاه وصل است.
   ۲) پشتیبان: برای هر مستأجرِ دارای اتصال یک کوئری ایندکس‌دار max(seq) — هر ۶۰ ثانیه وقتی
      LISTEN برقرار است، هر ۱۵ ثانیه وقتی نیست. بدون اتصال باز: صفر کوئری.
   هیچ دادهٔ رکوردی در اعلان نیست؛ فقط نام مجموعه‌ها.
   ═══════════════════════════════════════════════════════════════════ */

const HEARTBEAT_MS = 45_000;
const COALESCE_MS = 150;
const CHANNEL = 'payesh_gw_feed';
const TOPIC_RE = /^[a-z][a-z0-9_]{1,40}$/;

function parseTopics(csv) {
  return String(csv || '').split(',').map(s => s.trim()).filter(s => TOPIC_RE.test(s)).slice(0, 40);
}

/** payload of pg_notify: {"t":tenant,"s":seq,"c":[collections]} — bad input ⇒ null */
function parsePayload(txt) {
  try {
    const j = JSON.parse(String(txt || ''));
    const s = Number(j && j.s);
    if (!j || typeof j.t !== 'string' || !Number.isFinite(s)) return null;
    return { tenant: j.t, seq: s, topics: Array.isArray(j.c) ? j.c.map(String).filter(t => TOPIC_RE.test(t)) : [] };
  } catch (e) { return null; }
}

/**
 * @param {object} o
 * @param {(tenantId:string)=>Promise<number>} o.probe   بزرگ‌ترین seq مستأجر
 * @param {(onPayload:(txt:string)=>void, onLost:()=>void)=>Promise<{close:()=>any}>} [o.listen]
 */
function create(o = {}) {
  const probe = o.probe;
  const listen = o.listen || null;
  const pollMs = Math.max(50, Number(o.pollMs || 60_000));
  const fallbackPollMs = Math.max(50, Number(o.fallbackPollMs || 15_000));
  const heartbeatMs = Math.max(20, Number(o.heartbeatMs || HEARTBEAT_MS));
  const coalesceMs = Math.max(0, Number(o.coalesceMs == null ? COALESCE_MS : o.coalesceMs));
  const maxStreams = Math.max(1, Number(o.maxStreams || 2000));
  const maxPerTenant = Math.max(1, Number(o.maxPerTenant || 300));
  const relistenMs = Math.max(50, Number(o.relistenMs || 30_000));

  const tenants = new Map();   /* tid → {streams:Set, seq, at, pending, flush, poll} */
  let total = 0;
  let listener = null, listening = false, listenTimer = null, listenBusy = false;
  const stats = { notifies: 0, probes: 0, changes: 0, rejected: 0 };

  function send(res, ev, data) {
    try { res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) { /* closed */ }
  }

  function ensureListen() {
    if (!listen || listening || listenBusy || listenTimer || total === 0) return;
    listenBusy = true;
    Promise.resolve().then(() => listen(onPayload, onLost)).then((h) => {
      listenBusy = false;
      if (total === 0) { try { h && h.close && h.close(); } catch (e) { /* noop */ } return; }
      listener = h; listening = true;
    }, () => { listenBusy = false; onLost(); });
  }
  function onLost() {
    listening = false; listener = null;
    if (listenTimer || total === 0) return;
    listenTimer = setTimeout(() => { listenTimer = null; ensureListen(); }, relistenMs);
    if (listenTimer.unref) listenTimer.unref();
  }
  function stopListen() {
    if (listenTimer) { clearTimeout(listenTimer); listenTimer = null; }
    const h = listener; listener = null; listening = false;
    if (h && h.close) { try { Promise.resolve(h.close()).catch(() => {}); } catch (e) { /* noop */ } }
  }

  function onPayload(txt) {
    const p = parsePayload(txt);
    if (!p) return;
    stats.notifies++;
    notify(p.tenant, p.seq, p.topics);
  }

  /** a write committed for [tid] up to [seq]; [topics] empty ⇒ «همه» */
  function notify(tid, seq, topics) {
    const t = tenants.get(tid);
    if (!t) return false;                         /* هیچ دستگاهی از این مستأجر روی این نمونه وصل نیست */
    const s = Number(seq);
    if (!Number.isFinite(s) || s <= t.seq) return false;   /* تکراری (مثلاً پشتیبان پس از NOTIFY) */
    t.seq = s; t.at = new Date().toISOString();
    const list = Array.isArray(topics) ? topics : [];
    /* pending: undefined = چیزی در صف نیست · null = همه · Set = این مجموعه‌ها */
    if (!list.length) t.pending = null;
    else if (t.pending === undefined) t.pending = new Set(list);
    else if (t.pending) for (const x of list) t.pending.add(x);
    if (!t.flush) {
      t.flush = setTimeout(() => flush(tid), coalesceMs);
      if (t.flush.unref) t.flush.unref();
    }
    return true;
  }

  function flush(tid) {
    const t = tenants.get(tid);
    if (!t) return;
    t.flush = null;
    const all = t.pending === null;
    const topics = all ? [] : [...t.pending];
    t.pending = undefined;
    stats.changes++;
    for (const st of t.streams) {
      const mine = all || !st.topics.length ? topics : topics.filter(x => st.topics.includes(x));
      if (!all && st.topics.length && !mine.length) continue;
      send(st.res, 'change', { seq: t.seq, topics: mine, at: t.at });
    }
  }

  function schedulePoll(tid) {
    const t = tenants.get(tid);
    if (!t || t.poll) return;
    t.poll = setTimeout(async () => {
      t.poll = null;
      if (!tenants.has(tid)) return;
      try { stats.probes++; notify(tid, await probe(tid), []); } catch (e) { /* DB موقتاً در دسترس نیست — نوبت بعد */ }
      schedulePoll(tid);
    }, listening ? pollMs : fallbackPollMs);
    if (t.poll.unref) t.poll.unref();
  }

  /** ⇒ true: stream باز شد · false: سقف اتصال (۵۰۳ داده شد) */
  async function open(req, res, { tenantId, since, topics }) {
    const t0 = tenants.get(tenantId);
    if (total >= maxStreams || (t0 && t0.streams.size >= maxPerTenant)) {
      stats.rejected++;
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '60' });
      res.end(JSON.stringify({ ok: false, error: 'too_many_streams' }));
      return false;
    }
    let t = t0;
    if (!t) {
      t = { streams: new Set(), seq: -1, at: null, pending: undefined, flush: null, poll: null };
      tenants.set(tenantId, t);
    }
    const st = { res, topics: parseTopics(topics), hb: null };
    t.streams.add(st);
    total++;
    ensureListen();
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(st.hb);
      t.streams.delete(st);
      total--;
      if (!t.streams.size && tenants.get(tenantId) === t) {
        clearTimeout(t.flush); clearTimeout(t.poll);
        tenants.delete(tenantId);
      }
      if (total === 0) stopListen();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',             /* nginx/serv00: بدون بافر */
      connection: 'keep-alive',
    });
    if (res.flushHeaders) res.flushHeaders();
    try { if (req.socket) { req.socket.setNoDelay(true); req.socket.setTimeout(0); } } catch (e) { /* noop */ }
    res.write('retry: 10000\n');

    if (t.seq < 0) {
      try { stats.probes++; const s = await probe(tenantId); if (Number(s) > t.seq) t.seq = Number(s); }
      catch (e) { t.seq = Math.max(t.seq, 0); }
      if (t.seq < 0) t.seq = 0;
    }
    if (closed) return true;
    const s0 = since === null || since === undefined || since === '' ? null : Number(since);
    send(res, 'hello', { seq: t.seq, at: t.at, missed: s0 !== null && Number.isFinite(s0) && s0 >= 0 && s0 !== t.seq });
    st.hb = setInterval(() => { try { res.write(':\n\n'); } catch (e) { /* noop */ } }, heartbeatMs);
    if (st.hb.unref) st.hb.unref();
    schedulePoll(tenantId);
    return true;
  }

  /** drain: همهٔ streamها بسته می‌شوند تا خاموشی منتظر آن‌ها نماند */
  function closeAll() {
    for (const t of [...tenants.values()]) {
      for (const st of [...t.streams]) { try { st.res.end(); } catch (e) { /* noop */ } }
    }
    stopListen();
  }

  function status() {
    return { streams: total, tenants: tenants.size, listening, ...stats };
  }

  return { open, notify, closeAll, status, onPayload };
}

module.exports = { create, parsePayload, parseTopics, CHANNEL, HEARTBEAT_MS, COALESCE_MS };
