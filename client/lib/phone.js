/* ═══════════════════════════════════════════════════════════════════
   «نسخهٔ گوشی» — کل برنامه بدون هیچ سروری

   روی گوشی (و هر رایانه‌ای که سیستم مدرسه در دسترسش نیست) این فایل
   همان کارهایی را می‌کند که سرور مدرسه می‌کرد:

     ۱) ورود با شمارهٔ همراه و رمز عبور — همان‌هایی که مدیر تعریف کرده.
        رمز روی خود گوشی بررسی می‌شود (PBKDF2) و هیچ سروری لازم نیست.
     ۲) آوردن کل دادهٔ لازم از صندوقچهٔ ابری:
        payesh/data/core.json  +  payesh/data/person/<id>.json
     ۳) ثبت‌ها را مستقیم در صندوقچه می‌گذارد:
        payesh/outbox/pending/<uid>.json
        و اولین دستگاه روشنی (مدرسه/خانه/گوشی کادر) آن‌ها را اعمال می‌کند.

   هیچ سرویس اجرایی ابری در کار نیست؛ فقط همان فضای ذخیره‌سازی رایگان.
   ═══════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  const LS = {
    cfg: 'payesh.cloud.cfg',
    user: 'payesh.phone.user',
  };

  function S3() {
    const api = root.PayeshS3;
    if (!api) throw new Error('no_s3');
    return api;
  }

  function bakedConfig() {
    const b = root.PAYESH_CLOUD || {};
    return {
      endpoint: b.endpoint || '', region: b.region || '', bucket: b.bucket || '',
      accessKey: b.accessKey || '', secret: b.secret || '',
      prefix: b.prefix || 'payesh/', pathStyle: b.pathStyle !== false,
      source: 'baked',
    };
  }

  function storedConfig() {
    try { return JSON.parse(localStorage.getItem(LS.cfg) || 'null'); } catch (e) { return null; }
  }

  function saveConfig(c) {
    try { localStorage.setItem(LS.cfg, JSON.stringify(c)); } catch (e) { /* noop */ }
    return c;
  }

  function hasKeys(c) { return !!(c && c.endpoint && c.accessKey && c.secret); }

  /* نام‌های محتمل صندوقچه — فقط وقتی به کار می‌آید که فهرست‌کردن اجازه نداشته باشد */
  const CANDIDATE_BUCKETS = ['payesh', 'payesh-madrese', 'payesh-school', 'madrese', 'school'];

  function fail(code, detail) {
    const err = new Error(code);
    err.code = code;
    err.detail = detail ? String(detail).slice(0, 200) : null;
    return err;
  }

  async function ready(force) {
    const s3 = S3();
    let c = storedConfig();
    if (!force && hasKeys(c) && c.bucket) return s3.normalize(c);
    if (!hasKeys(c)) c = bakedConfig();
    c = s3.normalize(c);
    if (!hasKeys(c)) throw fail('no_config');
    if (!c.bucket) {
      let names = [];
      let listErr = null;
      try {
        names = await s3.listBuckets(c);
      } catch (e) {
        listErr = e;
      }
      let pick = names.find(n => /payesh|madrese|school/i.test(n)) || names[0];
      /* اگر فهرست‌کردن صندوقچه‌ها اجازه نداشت، نام‌های محتمل را امتحان می‌کنیم */
      if (!pick && !(listErr && listErr.kind === 'network')) {
        for (const guess of CANDIDATE_BUCKETS) {
          try { await s3.list(Object.assign({}, c, { bucket: guess }), { max: 1, prefix: c.prefix }); pick = guess; break; } catch (e) { /* بعدی */ }
        }
      }
      if (!pick) {
        if (listErr && listErr.kind === 'network') throw fail('net', listErr.detail || listErr.message);
        throw fail(listErr ? 'denied' : 'no_bucket', listErr && (listErr.detail || listErr.message));
      }
      c = Object.assign({}, c, { bucket: pick });
    }
    return saveConfig(c);
  }

  /* اجازه می‌دهد سرور (وقتی در دسترس است) نشانی صندوقچه را به گوشی بدهد */
  function adopt(serverConfig) {
    if (!serverConfig || !serverConfig.accessKey) return null;
    const s3 = S3();
    const c = s3.normalize({
      endpoint: serverConfig.endpoint, region: serverConfig.region, bucket: serverConfig.bucket,
      accessKey: serverConfig.accessKey, secret: serverConfig.secret,
      prefix: serverConfig.prefix || 'payesh/', pathStyle: serverConfig.pathStyle !== false,
      source: 'server',
    });
    if (!hasKeys(c)) return null;
    return saveConfig(c);
  }

  /* اگر گوشی یک‌بار سیستم مدرسه را ببیند، نشانی صندوقچه را از آن یاد می‌گیرد
     و بعد از آن در خانه هم بدون هیچ تنظیمی کار می‌کند. */
  async function learnFromServer(baseUrl) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    if (!base) return null;
    try {
      const r = await fetch(base + '/api/phone/config', { cache: 'no-store' });
      if (!r.ok) return null;
      const j = await r.json();
      if (!j || !j.ok || !j.config) return null;
      const c = adopt(j.config);
      if (c && j.ready) saveConfig(Object.assign({}, c, { ready: true }));
      return c;
    } catch (e) {
      return null;
    }
  }


  /* ── تشخیص گام‌به‌گام برای کاربر (بدون اصطلاح فنی) ────────────────
     هر گام می‌گوید کجا گیر کرده‌ایم: اینترنت، صندوقچه، اجازهٔ دسترسی، یا حساب. */
  async function diagnose(phone) {
    const steps = [];
    const s3 = S3();
    let cfg = storedConfig();
    if (!hasKeys(cfg)) cfg = bakedConfig();
    cfg = s3.normalize(cfg);
    steps.push({ ok: hasKeys(cfg), text: 'نشانی و کلیدهای حافظه در برنامه هست', detail: cfg.endpoint || '—' });
    if (!hasKeys(cfg)) return steps;

    /* ۱) آیا اصل اینترنت به سرور حافظه می‌رسد؟ */
    let reach = null;
    try {
      await fetch(cfg.endpoint.replace(/\/+$/, '') + '/', { method: 'HEAD', mode: 'no-cors', cache: 'no-store' });
      reach = { ok: true };
    } catch (e) {
      reach = { ok: false, detail: String(e.message || e).slice(0, 120) };
    }
    steps.push({ ok: reach.ok, text: reach.ok ? 'اینترنت گوشی به سرور حافظه می‌رسد' : 'گوشی به سرور حافظه نمی‌رسد (اینترنت/فیلترشکن)', detail: reach.detail || '' });
    if (!reach.ok) return steps;

    /* ۲) پیدا کردن صندوقچه */
    if (!cfg.bucket) {
      try {
        cfg = await ready(true);
        steps.push({ ok: true, text: 'صندوقچهٔ مدرسه پیدا شد', detail: cfg.bucket });
      } catch (e) {
        steps.push({ ok: false, text: 'صندوقچه پیدا نشد', detail: (e && (e.code || e.message)) || '' });
        return steps;
      }
    } else steps.push({ ok: true, text: 'صندوقچهٔ مدرسه شناخته شده است', detail: cfg.bucket });

    /* ۳) اجازهٔ خواندن (CORS) — اگر نباشد مرورگر جواب را دور می‌ریزد */
    try {
      const probe = await s3.corsProbe(cfg);
      steps.push({
        ok: !!probe.ok,
        text: probe.ok ? 'اجازهٔ خواندن حافظه برای برنامه باز است' : 'اجازهٔ خواندن بسته است — یک‌بار در سیستم مدرسه «حافظهٔ ابری ← بررسی و درست‌کردن دسترسی گوشی» را بزنید',
        detail: probe.ok ? ('allow-origin: ' + probe.allow_origin) : (probe.error || ('کد ' + probe.status)),
      });
      if (!probe.ok) return steps;
    } catch (e) {
      steps.push({ ok: false, text: 'اجازهٔ خواندن بررسی نشد', detail: String(e.message || e).slice(0, 120) });
      return steps;
    }

    /* ۴) حساب این شماره */
    const p = normPhone(phone);
    if (p.length >= 10) {
      try {
        const env = JSON.parse(await s3.get(cfg, cfg.prefix + 'auth/' + p + '.json'));
        steps.push({ ok: !!env.verifier, text: 'حساب این شماره در حافظه هست', detail: (env.user && env.user.name) || '' });
      } catch (e) {
        steps.push({ ok: false, text: 'برای این شماره حساب پیدا نشد — مدیر باید یک‌بار با سیستم مدرسه همگام شود', detail: e && e.status ? ('کد ' + e.status) : '' });
      }
    } else {
      steps.push({ ok: true, text: 'شماره را کامل وارد کنید تا حسابش هم بررسی شود' });
    }
    return steps;
  }

  function normPhone(p) {
    return String(p == null ? '' : p)
      .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
      .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
      .replace(/\D/g, '');
  }

  function hex(buf) {
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function sameHex(a, b) {
    a = String(a || ''); b = String(b || '');
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  /* بررسی «pbkdf2$iter$salt$hash» با WebCrypto */
  async function verify(secret, stored) {
    const parts = String(stored || '').split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
    const iter = Number(parts[1]) || 0;
    const salt = parts[2];
    const want = parts[3];
    if (!iter || !salt || !want) return false;
    const subtle = root.crypto && root.crypto.subtle;
    if (subtle && subtle.importKey) {
      try {
        const enc = new TextEncoder();
        const key = await subtle.importKey('raw', enc.encode(String(secret)), { name: 'PBKDF2' }, false, ['deriveBits']);
        const bits = await subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: iter, hash: 'SHA-256' }, key, 256);
        return sameHex(hex(bits), want);
      } catch (e) { /* می‌رویم سراغ نسخهٔ جاوااسکریپتی */ }
    }
    /* آدرس ناامن (http داخل شبکه) → WebCrypto ندارد؛ خودمان حساب می‌کنیم */
    const H = root.PayeshHash;
    if (!H) return false;
    const calc = H.hex(H.pbkdf2(String(secret), salt, iter, 32));
    return sameHex(calc, want);
  }

  /* ── ورود: همان «شماره + رمز» که مدیر تعریف کرده ─────────────────── */
  async function login(phone, password) {
    const p = normPhone(phone);
    if (p.length < 10) return { ok: false, error: 'bad_phone' };
    if (String(password || '').length < 4) return { ok: false, error: 'bad_password' };
    let cfg;
    try { cfg = await ready(); } catch (e) { return { ok: false, error: (e && e.code) || 'net', detail: e && e.detail }; }
    const s3 = S3();
    let env;
    try {
      env = JSON.parse(await s3.get(cfg, cfg.prefix + 'auth/' + p + '.json'));
    } catch (e) {
      const status = e && e.status;
      if (status === 404) return { ok: false, error: 'not_registered' };
      if (e && e.kind === 'network') return { ok: false, error: 'net', detail: e.detail };
      if (status === 403 || status === 401) return { ok: false, error: 'cors', detail: e.detail };
      return { ok: false, error: 'cors', detail: e && (e.detail || e.message) };
    }
    if (!env || !env.verifier) return { ok: false, error: 'not_registered' };
    if (env.user && env.user.active === false) return { ok: false, error: 'user_inactive' };
    const good = await verify(String(password), env.verifier);
    if (!good) return { ok: false, error: 'bad_credentials' };
    saveConfig(cfg);
    try { localStorage.setItem(LS.user, JSON.stringify(env.user)); } catch (e) { /* noop */ }
    return { ok: true, user: env.user };
  }

  function lastUser() {
    try { return JSON.parse(localStorage.getItem(LS.user) || 'null'); } catch (e) { return null; }
  }

  /* ── آوردن داده: سراسری + فقط دادهٔ خودِ همین کاربر ───────────────── */
  async function pullData(user) {
    const cfg = await ready();
    const s3 = S3();
    const out = { collections: {}, school: null, directory: [], me: null, children: [], at: null, missing: false };
    try {
      const core = JSON.parse(await s3.get(cfg, cfg.prefix + 'data/core.json'));
      out.school = core.school || null;
      out.directory = core.directory || [];
      out.at = core.at || null;
      for (const c of Object.keys(core.collections || {})) out.collections[c] = core.collections[c] || [];
      /* فهرست نام‌ها به‌صورت کاربر هم در دسترس باشد (نام دبیر/دانش‌آموز در فهرست‌ها) */
      out.collections.users = out.directory.map(u => Object.assign({}, u));
    } catch (e) {
      out.missing = true;
    }
    if (user && user.id != null) {
      try {
        const mine = JSON.parse(await s3.get(cfg, cfg.prefix + 'data/person/' + user.id + '.json'));
        out.me = mine.me || null;
        out.children = mine.children || [];
        for (const c of Object.keys(mine.collections || {})) {
          const rows = mine.collections[c] || [];
          const map = new Map((out.collections[c] || []).map(r => [Number(r.id), r]));
          for (const r of rows) map.set(Number(r.id), r);
          out.collections[c] = [...map.values()];
        }
      } catch (e) { /* دادهٔ شخصی هنوز منتشر نشده */ }
    }
    return out;
  }

  /* ── گذاشتن ثبت در صندوقچه (بدون سرور) ──────────────────────────── */
  async function send(item) {
    const cfg = await ready();
    const s3 = S3();
    const uid = String(item && item.uid ? item.uid : '') || ('ob-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
    const body = JSON.stringify({
      v: 1, uid,
      user_id: item.user_id != null ? Number(item.user_id) : null,
      role: item.role || null,
      device_id: item.device_id || 'phone-' + (localStorage.getItem('payesh.device') || 'local'),
      op: item.op || null,
      created_at: new Date().toISOString(),
    });
    await s3.put(cfg, cfg.prefix + 'outbox/pending/' + uid + '.json', body);
    return { ok: true, uid };
  }

  /* چند ثبت در صندوقچه منتظر است؟ (فقط برای نمایش) */
  async function pendingCount() {
    const cfg = await ready();
    const s3 = S3();
    const l = await s3.list(cfg, { prefix: cfg.prefix + 'outbox/pending/', max: 1000 });
    return l.keys.length;
  }

  root.PayeshPhone = {
    ready, adopt, learnFromServer, diagnose, login, verify, pullData, send, pendingCount, lastUser,
    normPhone, saveConfig, storedConfig, bakedConfig,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
