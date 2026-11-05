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

  async function ready(force) {
    const s3 = S3();
    let c = storedConfig();
    if (!force && hasKeys(c) && c.bucket) return s3.normalize(c);
    if (!hasKeys(c)) c = bakedConfig();
    c = s3.normalize(c);
    if (!hasKeys(c)) throw new Error('no_cloud_config');
    if (!c.bucket) {
      const names = await s3.listBuckets(c);
      const pick = names.find(n => /payesh|madrese|school/i.test(n)) || names[0];
      if (!pick) throw new Error('no_bucket');
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
    try { cfg = await ready(); } catch (e) { return { ok: false, error: 'offline' }; }
    const s3 = S3();
    let env;
    try {
      env = JSON.parse(await s3.get(cfg, cfg.prefix + 'auth/' + p + '.json'));
    } catch (e) {
      return { ok: false, error: e && e.status === 404 ? 'not_registered' : 'offline' };
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
    ready, adopt, login, verify, pullData, send, pendingCount, lastUser,
    normPhone, saveConfig, storedConfig, bakedConfig,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
