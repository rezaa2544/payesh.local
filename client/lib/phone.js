/* ═══════════════════════════════════════════════════════════════════
   گوشی/تبلت — بدون هیچ کلیدی در برنامه (D‑23 / F‑04)

   قاعده: کلید و رازِ صندوقچه **هرگز** به گوشی نمی‌رود. گوشی از سرورِ
   مدرسه (یا نشانی عمومی آن) یک «تیکت» کوتاه‌عمر می‌گیرد: چند نشانی
   امضاشده که
     ۱) خودشان منقضی می‌شوند، و
     ۲) فقط به همان یک فایل و همان یک عمل (خواندن/نوشتن) اجازه می‌دهند.
   پس اگر گوشی گم شود یا برنامه باز شود، هیچ کلید دائمی بیرون نمی‌رود.

   گوشی یک‌بار که در مدرسه وارد شود، تیکت‌ها را با خودش نگه می‌دارد و در
   خانه هم — وقتی سیستم مدرسه روشن نیست — می‌خواند و ثبت می‌کند.
   اگر تیکت تمام شده باشد، ثبت‌ها در صفِ همین گوشی می‌مانند و اولین
   باری که تیکت تازه گرفت، خودکار فرستاده می‌شوند.
   ═══════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  const LS = {
    base: 'payesh.phone.base',
    token: 'payesh.phone.token',
    user: 'payesh.phone.user',
    device: 'payesh.phone.device',
    verifier: 'payesh.phone.verifier',
    tickets: 'payesh.phone.tickets',
    data: 'payesh.phone.data',
    rev: 'payesh.phone.rev',
    outbox: 'payesh.phone.outbox',
    queue: 'payesh.phone.queue',
    cfg: 'payesh.cloud.cfg',
  };
  const QUEUE_MAX = 300;
  const OUTBOX_MAX = 200;

  function readJSON(key, dflt) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return dflt;
      const v = JSON.parse(raw);
      return v == null ? dflt : v;
    } catch (e) { return dflt; }
  }
  function writeJSON(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* noop */ }
  }

  function fail(code, detail) {
    const err = new Error(code);
    err.code = code;
    err.detail = detail ? String(detail).slice(0, 200) : null;
    return err;
  }

  /* ── نشانی سیستم مدرسه ──────────────────────────────────────────── */
  function normBase(u) { return String(u || '').trim().replace(/\/+$/, ''); }

  function apiBase() {
    const explicit = normBase(root.PAYESH_API_BASE);
    if (explicit) return explicit;
    const saved = normBase(localStorage.getItem(LS.base));
    if (saved) return saved;
    try {
      if (root.location && /^https?:/.test(String(root.location.origin))) return normBase(root.location.origin);
    } catch (e) { /* noop */ }
    return '';
  }

  function setBase(u) {
    const b = normBase(u);
    if (b) { try { localStorage.setItem(LS.base, b); } catch (e) { /* noop */ } }
    return b;
  }

  function token() {
    try { return localStorage.getItem(LS.token) || ''; } catch (e) { return ''; }
  }

  async function api(path, opts) {
    opts = opts || {};
    const base = apiBase();
    if (!base) throw fail('no_server');
    let res;
    try {
      res = await fetch(base + path, {
        method: opts.method || 'GET',
        headers: Object.assign({ 'Content-Type': 'application/json' },
          token() ? { Authorization: 'Bearer ' + token() } : {}, opts.headers || {}),
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        cache: 'no-store',
      });
    } catch (e) { throw fail('net', e && e.message); }
    let j = null;
    try { j = JSON.parse(await res.text()); } catch (e) { j = null; }
    if (res.status === 401) {
      try { localStorage.removeItem(LS.token); } catch (e) { /* noop */ }
      throw fail('unauthorized', (j && j.error) || '');
    }
    if (!res.ok || !j || j.ok === false) throw fail((j && j.error) || ('http_' + res.status), j && j.detail);
    return j;
  }

  /* ── تیکت‌ها ─────────────────────────────────────────────────────── */
  function tickets() {
    const t = readJSON(LS.tickets, null);
    return t && t.tickets ? t : null;
  }

  function ticketFresh(t) {
    if (!t || !t.tickets) return false;
    let soonest = Infinity;
    for (const k of Object.keys(t.tickets)) {
      const at = Date.parse(t.tickets[k].expires_at || '');
      if (isFinite(at) && at < soonest) soonest = at;
    }
    return soonest > Date.now() + 60_000;
  }

  function saveTickets(j) {
    if (!j || !j.tickets) return null;
    const cur = {
      at: new Date().toISOString(),
      device_id: j.device_id || (localStorage.getItem(LS.device) || ''),
      device_file: j.device_file || '',
      config: j.config || {},
      tickets: j.tickets,
    };
    if (cur.device_id) { try { localStorage.setItem(LS.device, cur.device_id); } catch (e) { /* noop */ } }
    writeJSON(LS.tickets, cur);
    return cur;
  }

  async function refreshTickets() {
    if (!token()) return null;
    const j = await api('/api/phone/ticket', { method: 'POST', body: { device_id: localStorage.getItem(LS.device) || '' } });
    return saveTickets(j);
  }

  async function ensureTickets() {
    let t = tickets();
    if (ticketFresh(t)) return t;
    try {
      const fresh = await refreshTickets();
      if (fresh && ticketFresh(fresh)) return fresh;
    } catch (e) { /* بدون سرور — همان تیکت کهنه را امتحان می‌کنیم */ }
    if (t) return t;
    throw fail('no_ticket', 'یک‌بار در مدرسه وارد شوید تا گوشی تیکت بگیرد');
  }

  /* یک درخواست روی نشانی امضاشده (بدون هیچ کلیدی) */
  async function req(url, opts) {
    opts = opts || {};
    let res;
    try {
      res = await fetch(url, {
        method: opts.method || 'GET',
        headers: opts.body != null ? { 'Content-Type': 'application/json; charset=utf-8' } : {},
        body: opts.body != null ? String(opts.body) : undefined,
        cache: 'no-store',
      });
    } catch (e) { throw fail('net', e && e.message); }
    const text = await res.text().catch(() => '');
    if (res.status === 403 || res.status === 400) {
      try { localStorage.removeItem(LS.tickets); } catch (e) { /* noop */ }
      throw fail('ticket_expired', text.slice(0, 160));
    }
    if (!res.ok) {
      const e = fail('http_' + res.status, text.slice(0, 160));
      e.status = res.status;
      throw e;
    }
    return text;
  }

  async function s3get(name) {
    const t = await ensureTickets();
    const tk = t.tickets[name];
    if (!tk) throw fail('no_ticket', name);
    try {
      return await req(tk.url);
    } catch (e) {
      if (e.code !== 'ticket_expired' || !token()) throw e;
      const fresh = await refreshTickets();
      const again = fresh && fresh.tickets[name];
      if (!again) throw e;
      return req(again.url);
    }
  }

  async function s3put(name, body) {
    const t = await ensureTickets();
    const tk = t.tickets[name];
    if (!tk) throw fail('no_ticket', name);
    try {
      return await req(tk.url, { method: 'PUT', body });
    } catch (e) {
      if (e.code !== 'ticket_expired' || !token()) throw e;
      const fresh = await refreshTickets();
      const again = fresh && fresh.tickets[name];
      if (!again) throw e;
      return req(again.url, { method: 'PUT', body });
    }
  }

  /* ── پیکربندی (فقط فراداده؛ هیچ کلیدی) ──────────────────────────── */
  function bakedConfig() {
    const b = root.PAYESH_CLOUD || {};
    return {
      endpoint: b.endpoint || '', region: b.region || '', bucket: b.bucket || '',
      prefix: b.prefix || 'payesh/', pathStyle: b.pathStyle !== false,
      keyless: true, source: 'baked',
    };
  }

  function storedConfig() {
    const t = tickets();
    if (!t || !t.config) return null;
    return Object.assign({}, t.config, { keyless: true, source: 'ticket' });
  }

  /* سازگاری با کدهای قدیمی: هر چیزی که «کلید» باشد دور ریخته می‌شود */
  function saveConfig(c) {
    const safe = Object.assign({}, c || {});
    delete safe.accessKey; delete safe.secret; delete safe.sessionToken;
    if (tickets()) {
      const t = tickets();
      t.config = Object.assign({}, t.config, {
        endpoint: safe.endpoint || t.config.endpoint,
        bucket: safe.bucket || t.config.bucket,
        region: safe.region || t.config.region,
        prefix: safe.prefix || t.config.prefix,
        pathStyle: safe.pathStyle !== false,
      });
      writeJSON(LS.tickets, t);
    }
    return safe;
  }

  function hasKeys() { return false; } /* دیگر هیچ کلیدی روی گوشی نیست */

  async function ready(force) {
    if (!force) {
      const t = tickets();
      if (t) return Object.assign({}, t.config, { keyless: true, source: 'ticket' });
    }
    await ensureTickets();
    const t = tickets();
    return Object.assign({}, (t && t.config) || bakedConfig(), { keyless: true, source: 'ticket' });
  }

  function adopt(serverConfig) {
    if (!serverConfig) return null;
    const meta = {
      endpoint: serverConfig.endpoint || '', region: serverConfig.region || '',
      bucket: serverConfig.bucket || '', prefix: serverConfig.prefix || 'payesh/',
      pathStyle: serverConfig.pathStyle !== false,
    };
    const t = tickets();
    if (t) { t.config = meta; writeJSON(LS.tickets, t); }
    return Object.assign({}, meta, { keyless: true, source: 'server' });
  }

  async function learnFromServer(baseUrl) {
    const base = setBase(baseUrl) || apiBase();
    if (!base) return null;
    try {
      const j = await api('/api/phone/config');
      return adopt(j && j.config);
    } catch (e) { return null; }
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
    const H = root.PayeshHash;
    if (!H) return false;
    const calc = H.hex(H.pbkdf2(String(secret), salt, iter, 32));
    return sameHex(calc, want);
  }

  function localVerifier(password) {
    const H = root.PayeshHash;
    if (!H) return '';
    const salt = hex(root.crypto && root.crypto.getRandomValues
      ? root.crypto.getRandomValues(new Uint8Array(8))
      : Array.from({ length: 8 }, () => Math.floor(Math.random() * 256)));
    return 'pbkdf2$150000$' + salt + '$' + H.hex(H.pbkdf2(String(password), salt, 150000, 32));
  }

  /* ── ورود: یک‌بار با سیستم مدرسه، بعد از آن حتی بدون سرور ──────────── */
  async function login(phone, password) {
    const p = normPhone(phone);
    if (p.length < 10) return { ok: false, error: 'bad_phone' };
    if (String(password || '').length < 4) return { ok: false, error: 'bad_password' };
    try {
      const j = await api('/api/phone/login', {
        method: 'POST',
        body: { phone: p, password, name: 'گوشی', platform: 'phone', device_id: localStorage.getItem(LS.device) || '' },
      });
      try { localStorage.setItem(LS.token, j.token || ''); } catch (e) { /* noop */ }
      writeJSON(LS.user, j.user || null);
      saveTickets(j);
      const v = localVerifier(password);
      if (v) { try { localStorage.setItem(LS.verifier, v); } catch (e) { /* noop */ } }
      return { ok: true, user: j.user || null, online: true };
    } catch (e) {
      const last = lastUser();
      const cached = localStorage.getItem(LS.verifier) || '';
      if ((e.code === 'net' || e.code === 'no_server') && last && cached && normPhone(last.phone) === p) {
        const good = await verify(String(password), cached);
        if (good) return { ok: true, user: last, offline: true };
        return { ok: false, error: 'bad_credentials' };
      }
      if (e.code === 'net' || e.code === 'no_server') {
        return { ok: false, error: 'net', detail: 'به سیستم مدرسه نمی‌رسیم؛ اولین ورود باید در مدرسه باشد' };
      }
      return { ok: false, error: e.code || 'bad_credentials', detail: e.detail };
    }
  }

  function lastUser() {
    return readJSON(LS.user, null);
  }

  /* ── داده: سراسری + فقط دادهٔ خودِ همین کاربر ─────────────────────── */
  async function readRev() {
    try {
      const text = await s3get('rev_get');
      let j = {};
      try { j = JSON.parse(text) || {}; } catch (e) { j = {}; }
      writeJSON(LS.rev, { rev: String(j.rev || ''), at: j.at || new Date().toISOString() });
      drainQueue();
      return { ok: true, rev: String(j.rev || ''), at: j.at || null, online: true };
    } catch (e) {
      /* نبودِ فایل «مُهر» یعنی هنوز چیزی منتشر نشده — خطا نیست */
      if (e && e.status === 404) {
        writeJSON(LS.rev, { rev: '', at: new Date().toISOString() });
        return { ok: true, rev: '', at: null, online: true };
      }
      const cached = readJSON(LS.rev, null);
      if (cached) return { ok: true, rev: String(cached.rev || ''), at: cached.at || null, offline: true, stale: true };
      return { ok: false, error: (e && e.code) || 'net' };
    }
  }

  async function bumpRev() {
    const body = {
      v: 1, rev: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      at: new Date().toISOString(), by: 'device',
    };
    try { await s3put('rev_put', JSON.stringify(body)); return true; } catch (e) { return false; }
  }

  async function pullData(user) {
    const out = { collections: {}, school: null, directory: [], me: null, children: [], at: null, missing: false };
    try {
      const core = JSON.parse(await s3get('core_get'));
      out.school = core.school || null;
      out.directory = core.directory || [];
      out.at = core.at || null;
      const cols = core.collections || {};
      for (const c of Object.keys(cols)) out.collections[c] = cols[c] || [];
      out.collections.users = out.directory.map(u => Object.assign({}, u));
    } catch (e) {
      out.missing = true;
      out.error = (e && e.code) || 'net';
    }
    if (!out.missing) {
      try {
        const mine = JSON.parse(await s3get('person_get'));
        out.me = mine.me || null;
        out.children = mine.children || [];
        const cols = mine.collections || {};
        for (const c of Object.keys(cols)) {
          const map = new Map((out.collections[c] || []).map(r => [Number(r.id), r]));
          for (const r of cols[c] || []) map.set(Number(r.id), r);
          out.collections[c] = [...map.values()];
        }
      } catch (e) { /* دادهٔ شخصی هنوز منتشر نشده */ }
      writeJSON(LS.data, out);
      return out;
    }
    const cached = readJSON(LS.data, null);
    if (cached) return Object.assign({}, cached, { stale: true, offline: true });
    return Object.assign(out, { offline: true });
  }

  /* ── ثبت از گوشی: در فایل همین دستگاه، با تیکتِ نوشتن ───────────────── */
  async function flushOutbox() {
    const items = readJSON(LS.outbox, []);
    if (!items.length) return 0;
    await s3put('outbox_put', JSON.stringify({ v: 1, device_id: localStorage.getItem(LS.device) || '', items }));
    return items.length;
  }

  async function send(item) {
    const op = (item && item.op) || null;
    if (!op || !op.collection) return { ok: false, error: 'bad_op' };
    const uid = String(item.uid || '') || ('ob-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
    const entry = {
      uid,
      user_id: item.user_id != null ? Number(item.user_id) : null,
      role: item.role || null,
      device_id: item.device_id || ('phone-' + (localStorage.getItem(LS.device) || 'local')),
      op,
      created_at: new Date().toISOString(),
    };
    const items = readJSON(LS.outbox, []);
    items.push(entry);
    while (items.length > OUTBOX_MAX) items.shift();
    writeJSON(LS.outbox, items);
    try {
      await flushOutbox();
      await bumpRev();
      return { ok: true, uid, online: true };
    } catch (e) {
      const q = readJSON(LS.queue, []);
      q.push(entry);
      while (q.length > QUEUE_MAX) q.shift();
      writeJSON(LS.queue, q);
      return { ok: true, uid, queued: true, offline: true };
    }
  }

  /* صفِ گوشی، اولین باری که نوشتن ممکن شد، خالی می‌شود */
  let draining = false;
  async function drainQueue() {
    if (draining) return 0;
    const q = readJSON(LS.queue, []);
    if (!q.length) return 0;
    draining = true;
    let sent = 0;
    const rest = [];
    let blocked = false;
    for (const it of q) {
      if (blocked) { rest.push(it); continue; }
      try {
        const items = readJSON(LS.outbox, []);
        if (!items.some(x => x.uid === it.uid)) items.push(it);
        writeJSON(LS.outbox, items);
        await flushOutbox();
        sent++;
      } catch (e) {
        blocked = true;
        rest.push(it);
      }
    }
    writeJSON(LS.queue, rest);
    draining = false;
    if (sent) await bumpRev();
    return sent;
  }

  async function pendingCount() {
    const local = readJSON(LS.outbox, []).length + readJSON(LS.queue, []).length;
    return local;
  }

  /* ── تشخیص گام‌به‌گام (بدون اصطلاح فنی) ─────────────────────────── */
  async function diagnose(phone) {
    const steps = [];
    const base = apiBase();
    steps.push({
      ok: !!base,
      text: base ? 'نشانی سیستم مدرسه شناخته شده است' : 'نشانی سیستم مدرسه را از روی QR/لینک وارد کنید',
      detail: base || '—',
    });
    let cfg = null;
    try {
      cfg = await api('/api/phone/config');
      const c = (cfg && cfg.config) || {};
      steps.push({
        ok: !!c.endpoint,
        text: c.endpoint ? 'حافظهٔ ابری روی سرور تنظیم شده است' : 'روی سرور هنوز حافظهٔ ابری تنظیم نشده',
        detail: c.bucket || c.region || '',
      });
    } catch (e) {
      steps.push({ ok: false, text: 'به سیستم مدرسه دسترسی نداریم (اینترنت/آدرس)', detail: (e && e.code) || '' });
    }
    const t = tickets();
    const fresh = ticketFresh(t);
    steps.push({
      ok: !!t,
      text: t ? (fresh ? 'این گوشی تیکت معتبر دارد (بدون هیچ کلیدی)' : 'تیکت این گوشی منقضی شده — یک‌بار به مدرسه وصل شوید') : 'این گوشی هنوز تیکت ندارد — یک‌بار با شماره و رمز وارد شوید',
      detail: t && t.tickets && t.tickets.outbox_put ? String(t.tickets.outbox_put.expires_at || '') : '',
    });
    const user = lastUser();
    if (user) {
      steps.push({ ok: true, text: 'حساب این گوشی: ' + String(user.name || ''), detail: String(user.role || '') });
    }
    const p = normPhone(phone);
    if (p.length >= 10) {
      steps.push({
        ok: !!(user && normPhone(user.phone) === p),
        text: user && normPhone(user.phone) === p ? 'همین شماره روی گوشی وارد شده است' : 'این شماره روی گوشی وارد نشده — یک‌بار در مدرسه وارد شوید',
        detail: '',
      });
    }
    const q = readJSON(LS.queue, []).length;
    if (q) steps.push({ ok: true, text: faDigits(q) + ' ثبت در صف این گوشی است و خودکار فرستاده می‌شود' });
    return steps;
  }

  function faDigits(n) {
    return String(n).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
  }

  root.PayeshPhone = {
    ready, adopt, learnFromServer, diagnose, login, verify, pullData, send, pendingCount,
    readRev, bumpRev, lastUser, normPhone, saveConfig, storedConfig, bakedConfig,
    drainQueue, hasKeys, apiBase, setBase,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
