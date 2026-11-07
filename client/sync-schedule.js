'use strict';
/* ───────────────────────────────────────────────────────────────────
   ردیف ۴۲ — سیاستِ زمان‌بندی همگام‌سازی (قابل آزمون، مشترک با app.js)
   هدف: «حرکت از polling ثابت به همگام‌سازیِ تطبیقی» تا سقف بودجهٔ
   درخواست/بایت به‌ازای هر کاربر در روز رعایت شود.

   قواعد:
   ۱) حالت فعال: هر ۱ ثانیه (وقتی داده واقعاً در حال تغییر است).
   ۲) حالت بی‌کار: عقب‌نشینی نمایی ۱.۶× تا سقف ۶۰ ثانیه.
   ۳) همیشه jitter تصادفی (پیش‌فرض ۲۵٪ ±) تا دستگاه‌ها هم‌زمان نکوبند.
   ۴) پس‌زمینه/آفلاین: هیچ درخواستی.
   ۵) بازگشت اینترنت: تأخیر تصادفی ۰..۲ ثانیه (ضد طوفان).
   این ماژول هیچ وابستگی‌ای ندارد و هم در مرورگر و هم در Node بار می‌شود.
   ─────────────────────────────────────────────────────────────────── */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PayeshSchedule = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULTS = {
    activeMs: 1000,      /* حالت فعال */
    maxMs: 60000,        /* سقف حالت بی‌کار */
    backoff: 1.6,        /* ضریب عقب‌نشینی */
    jitter: 0.25,        /* ±۲۵٪ */
    sweepMs: 300000,     /* جاروی دوره‌ای در حالت فعال */
    sweepIdleMs: 900000, /* جاروی دوره‌ای در پس‌زمینه/آفلاین */
    sweepJitter: 0.3,    /* ±۳۰٪ روی جارو */
    reconnectMaxMs: 2000,/* ضد طوفان بازگشت اینترنت */
    /* نردبان بی‌کاری: هرچه دستگاه بیشتر بی‌کار بماند، سقفِ کاوش بالاتر
       می‌رود تا بودجهٔ روزانهٔ درخواست/بایت رعایت شود. اولین تغییر داده
       (یا بازگشت کاربر/شبکه) نردبان را صفر می‌کند. */
    idleLadder: [{ after: 12, capMs: 180000 }, { after: 16, capMs: 300000 }],
    floorMs: 250,        /* کفِ تأخیر */
  };

  /* rand ∈ [0,1) — در تست‌ها با مولد قطعی تزریق می‌شود */
  const rnd = (rand) => (typeof rand === 'function' ? Number(rand()) : Math.random());

  function capFor(idle, cfg) {
    const c = cfg && cfg.maxMs ? cfg : Object.assign({}, DEFAULTS, cfg || {});
    let cap = c.maxMs;
    for (const step of c.idleLadder || []) if (idle >= step.after) cap = Math.max(cap, step.capMs);
    return cap;
  }

  function liveDelay(idle, rand, cfg) {
    const c = Object.assign({}, DEFAULTS, cfg || {});
    const n = Math.max(0, Number(idle) || 0);
    const base = Math.min(c.activeMs * Math.pow(c.backoff, n), capFor(n, c));
    const factor = 1 + (rnd(rand) * 2 - 1) * c.jitter;
    return Math.max(c.floorMs, Math.round(base * factor));
  }

  function sweepDelay(active, rand, cfg) {
    const c = Object.assign({}, DEFAULTS, cfg || {});
    const base = active ? c.sweepMs : c.sweepIdleMs;
    const factor = 1 + (rnd(rand) * 2 - 1) * c.sweepJitter;
    return Math.max(c.floorMs, Math.round(base * factor));
  }

  function reconnectDelay(rand, cfg) {
    const c = Object.assign({}, DEFAULTS, cfg || {});
    return Math.round(rnd(rand) * c.reconnectMaxMs);
  }

  /* مدلِ روزانه: چند درخواستِ «کاوش» (probe) در ۲۴ ساعت با این سیاست؟
     idle=true یعنی دستگاه دیده می‌شود ولی داده‌ای تغییر نمی‌کند. */
  function probesPerDay(idle, rand, cfg) {
    const c = Object.assign({}, DEFAULTS, cfg || {});
    const DAY = 86400000;
    let t = 0, n = 0, level = 0;
    while (t < DAY) {
      const d = liveDelay(idle ? level : 0, rand, c);
      t += d;
      if (t >= DAY) break;
      n++;
      if (idle) level = Math.min(level + 1, 40);
    }
    return n;
  }

  return { DEFAULTS, liveDelay, sweepDelay, reconnectDelay, probesPerDay, capFor };
});
