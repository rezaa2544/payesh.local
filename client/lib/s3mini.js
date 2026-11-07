/* ═══════════════════════════════════════════════════════════════════
   کلاینت کوچک صندوقچه (S3) — هم در مرورگر، هم در Node
   چهار چیز لازم داریم: فهرست، نوشتن، خواندن، پاک‌کردن.
   هیچ وابستگی ندارد؛ امضا را از sigv4.js می‌گیرد.
   ═══════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const sig = (typeof module === 'object' && module.exports)
    ? require('./sigv4.js')
    : root.PayeshSig;
  const api = factory(sig);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PayeshS3 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (sig) {
  'use strict';

  const DEFAULTS = { endpoint: '', bucket: '', accessKey: '', secret: '', region: '', prefix: 'payesh/', pathStyle: true };

  function normalize(input) {
    const c = Object.assign({}, DEFAULTS, input || {});
    c.endpoint = String(c.endpoint || '').trim().replace(/\/+$/, '');
    c.bucket = String(c.bucket || '').trim().replace(/^\/+|\/+$/g, '');
    c.accessKey = String(c.accessKey || '').trim();
    c.secret = String(c.secret || '');
    c.region = String(c.region || '').trim();
    c.prefix = String(c.prefix || 'payesh/').replace(/^\/+/, '');
    if (c.prefix && !c.prefix.endsWith('/')) c.prefix += '/';
    c.pathStyle = c.pathStyle !== false;
    return c;
  }

  function regionOf(cfg) {
    if (cfg.region) return cfg.region;
    const m = String(cfg.endpoint).match(/ir-[a-z]{3}-[a-z0-9]{2}/i);
    return m ? m[0] : 'us-east-1';
  }

  /* اگر کاربر آدرس صندوقچه را بچسباند (مثل https://mybucket.s3.ir-thr-at1.arvanstorage.ir)
     خودمان باکت را جدا می‌کنیم تا لازم نباشد چیزی را دستی بشکافد. */
  function smartParse(cfg) {
    const c = Object.assign({}, cfg);
    try {
      const u = new URL(c.endpoint.indexOf('://') >= 0 ? c.endpoint : 'https://' + c.endpoint);
      const m = u.host.match(/^([a-z0-9][a-z0-9.\-]*)\.s3[.\-]([a-z0-9.\-]+)$/i);
      if (m && !/^s3[.\-]/i.test(u.host)) {
        c.bucket = c.bucket || m[1];
        c.endpoint = u.protocol + '//s3.' + m[2] + (u.pathname && u.pathname !== '/' ? u.pathname : '');
      }
    } catch (e) { /* آدرس نامعتبر — همان‌جا خطا می‌دهیم */ }
    return c;
  }

  function splitEndpoint(endpoint) {
    const u = new URL(endpoint.indexOf('://') >= 0 ? endpoint : 'https://' + endpoint);
    return { host: u.host, basePath: u.pathname.replace(/\/+$/, ''), scheme: u.protocol.replace(':', '') };
  }

  function buildRequest(cfg, opts) {
    const { host, basePath, scheme } = splitEndpoint(cfg.endpoint);
    const key = String(opts.key || '').replace(/^\/+/, '');
    const p = opts.root
      ? '/'
      : (cfg.pathStyle === false
        ? (key ? '/' + key : '/')
        : ('/' + cfg.bucket + (key ? '/' + key : '')));
    const body = opts.body || '';
    const headers = Object.assign({}, opts.headers || {});
    if (body) headers['content-type'] = headers['content-type'] || 'application/json; charset=utf-8';
    return sig.sign({
      method: opts.method || 'GET',
      host: cfg.pathStyle === false ? cfg.bucket + '.' + host : host,
      path: basePath + p,
      query: opts.query || {},
      headers,
      body,
      region: regionOf(cfg),
      service: 's3',
      scheme,
      accessKey: cfg.accessKey,
      secret: cfg.secret,
    });
  }

  /* نشانی امضاشدهٔ کوتاه‌عمر برای یک کلید مشخص (بدون افشای کلید) */
  function presign(cfg, opts) {
    const { host, basePath, scheme } = splitEndpoint(cfg.endpoint);
    const key = String(opts.key || '').replace(/^\/+/, '');
    const p = cfg.pathStyle === false
      ? (key ? '/' + key : '/')
      : ('/' + cfg.bucket + (key ? '/' + key : ''));
    return sig.presign({
      method: opts.method || 'GET',
      host: cfg.pathStyle === false ? cfg.bucket + '.' + host : host,
      path: basePath + p,
      query: opts.query || {},
      region: regionOf(cfg),
      service: 's3',
      scheme,
      accessKey: cfg.accessKey,
      secret: cfg.secret,
      expires: opts.expires,
    });
  }

  function hint(status, text) {
    if (status === 403) return 'کلیدها یا اجازهٔ دسترسی درست نیست (Access Denied)';
    if (status === 404) return /NoSuchBucket/i.test(text) ? 'صندوقچه با این نام پیدا نشد' : 'فایل یا صندوقچه پیدا نشد';
    if (status === 400) return /region|AuthorizationHeaderMalformed/i.test(text)
      ? 'منطقه (Region) با آدرس نمی‌خواند' : 'درخواست پذیرفته نشد (۴۰۰)';
    if (status === 301) return 'آدرس یا منطقه اشتباه است';
    if (status === 0) return 'شبکه اجازه نداد — احتمالاً CORS صندوقچه تنظیم نشده';
    return 'پاسخ نامنتظر از صندوقچه (' + status + ')';
  }


  /* ── ارتباط مستقیم بومی (نسخهٔ اندروید) ────────────────────────────
     مرورگر برای هر درخواست به یک دامنهٔ دیگر، «اجازهٔ خواندن» (CORS) از
     صندوقچه می‌خواهد؛ اگر صندوقچه آن را نداشته باشد، درخواست بی‌صدا رد
     می‌شود (همان خطای «به صندوقچه نرسیدیم»). خودِ برنامهٔ نصبی اندروید
     می‌تواند همین درخواست را بومی بفرستد: بدون مرورگر، بدون CORS.
     سمت جاوا: PayeshNative.s3(method, url, headersJson, body) → شناسه
     و بعد window.__payeshNativeDone(id, status, body, error). */
  function nativeBridge() {
    try {
      if (typeof window !== 'undefined' && window.PayeshNative
          && typeof window.PayeshNative.s3 === 'function') return window.PayeshNative;
    } catch (e) { /* در مرورگر عادی وجود ندارد */ }
    return null;
  }

  const NATIVE_WAIT = {};
  if (typeof window !== 'undefined' && !window.__payeshNativeDone) {
    window.__payeshNativeDone = function (id, status, body, error) {
      const slot = NATIVE_WAIT[id];
      if (!slot) return;
      delete NATIVE_WAIT[id];
      clearTimeout(slot.timer);
      if (error) { const e = new Error(error); e.kind = 'network'; e.detail = error; slot.reject(e); return; }
      slot.resolve({ status: Number(status) || 0, text: String(body == null ? '' : body) });
    };
  }

  function nativeRequest(method, url, headers, body) {
    const native = nativeBridge();
    if (!native) return null;
    let id;
    try {
      id = native.s3(method, url, JSON.stringify(headers || {}), body == null ? '' : String(body));
    } catch (e) {
      return Promise.reject(Object.assign(new Error('native_bridge_failed'), { kind: 'network', detail: String(e.message || e) }));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!NATIVE_WAIT[id]) return;
        delete NATIVE_WAIT[id];
        reject(Object.assign(new Error('native_timeout'), { kind: 'network', detail: 'timeout' }));
      }, 45000);
      NATIVE_WAIT[id] = { resolve, reject, timer };
    });
  }

  async function call(cfg, opts) {
    const signed = buildRequest(cfg, opts);
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body || undefined;

    /* ۱) اگر نسخهٔ نصبیِ اندروید باشد، درخواست را بومی می‌فرستیم:
          نه مرورگری در کار است، نه اجازهٔ CORS لازم است. */
    const native = nativeBridge();
    if (native) {
      const r = await nativeRequest(method, signed.url, signed.headers, body);
      if (r.status >= 200 && r.status < 300) return { status: r.status, text: r.text };
      const err = new Error(hint(r.status, r.text));
      err.kind = 'http'; err.status = r.status; err.detail = r.text.slice(0, 300);
      throw err;
    }

    /* ۲) در مرورگر/سرور: با CORS. اینترنت موبایل و اتصال‌های کوتاه‌عمر
          گاهی یک لحظه قطع می‌شوند. یک بار دیگر تلاش می‌کنیم — نه فقط برای
          خودِ درخواست، بلکه برای خواندنِ بدنه و پاسخ‌های ۵xx/۴۲۹ هم. */
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let res = null;
      let text = null;
      try {
        res = await fetch(signed.url, {
          method,
          headers: signed.headers,
          body,
          mode: 'cors',
          signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined,
        });
        text = await res.text();
      } catch (e) {
        lastErr = e; res = null;
        if (attempt === 0 && typeof setTimeout === 'function') await new Promise(r => setTimeout(r, 700));
        continue;
      }
      if (!res.ok && (res.status >= 500 || res.status === 429) && attempt === 0) {
        lastErr = new Error('HTTP ' + res.status);
        if (typeof setTimeout === 'function') await new Promise(r => setTimeout(r, 700));
        continue;
      }
      if (!res.ok) {
        const err = new Error(hint(res.status, text));
        err.kind = 'http'; err.status = res.status; err.detail = String(text).slice(0, 300);
        throw err;
      }
      return { status: res.status, text };
    }
    {
      const err = new Error('به صندوقچه نرسیدیم — آدرس/اینترنت/CORS را بررسی کنید');
      err.kind = 'network'; err.detail = (lastErr && (lastErr.name + ': ' + lastErr.message)) || '';
      throw err;
    }
  }

  const tag = (xml, t) => {
    const m = xml.match(new RegExp('<' + t + '>([\\s\\S]*?)</' + t + '>'));
    return m ? m[1] : null;
  };
  const all = (xml, t) => {
    const out = []; const re = new RegExp('<' + t + '>([\\s\\S]*?)</' + t + '>', 'g'); let m;
    while ((m = re.exec(xml))) out.push(m[1]);
    return out;
  };
  const unxml = s => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");

  /* فهرست صندوقچه‌های حساب — برای پیدا کردن خودکار نام صندوقچه */
  async function listBuckets(cfg) {
    const r = await call(smartParse(normalize(cfg)), { method: 'GET', root: true });
    const names = [];
    const re = /<Bucket>[\s\S]*?<Name>([\s\S]*?)<\/Name>[\s\S]*?<\/Bucket>/g;
    let m; while ((m = re.exec(r.text))) names.push(unxml(m[1]));
    if (!names.length) names.push(...all(r.text, 'Name').map(unxml));
    return names;
  }

  async function list(cfg, opts) {
    opts = opts || {};
    const q = { 'list-type': '2', 'max-keys': String(opts.max || 1000) };
    const prefix = opts.prefix !== undefined ? opts.prefix : cfg.prefix;
    if (prefix) q.prefix = prefix;
    if (opts.after) q['start-after'] = opts.after;
    if (opts.token) q['continuation-token'] = opts.token;
    const r = await call(cfg, { method: 'GET', key: '', query: q });
    const keys = all(r.text, 'Key').map(unxml);
    const sizes = all(r.text, 'Size').map(Number);
    const truncated = /<IsTruncated>true<\/IsTruncated>/i.test(r.text);
    return {
      keys: keys.map((k, i) => ({ key: k, size: sizes[i] || 0 })),
      truncated,
      token: truncated ? (tag(r.text, 'NextContinuationToken') || null) : null,
    };
  }

  const put = async (cfg, key, text) => { await call(cfg, { method: 'PUT', key, body: text }); return { key }; };
  const get = async (cfg, key) => (await call(cfg, { method: 'GET', key })).text;
  const remove = async (cfg, key) => { await call(cfg, { method: 'DELETE', key }); return { key }; };

  /* ── CORS صندوقچه ─────────────────────────────────────────────── */
  const CORS_XML = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<CORSConfiguration><CORSRule>' +
    '<AllowedOrigin>*</AllowedOrigin>' +
    '<AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod>' +
    '<AllowedMethod>DELETE</AllowedMethod><AllowedMethod>HEAD</AllowedMethod>' +
    '<AllowedHeader>*</AllowedHeader>' +
    '<ExposeHeader>ETag</ExposeHeader><ExposeHeader>Content-Length</ExposeHeader>' +
    '<MaxAgeSeconds>3600</MaxAgeSeconds>' +
    '</CORSRule></CORSConfiguration>';

  async function setCors(cfg) {
    cfg = smartParse(normalize(cfg));
    await call(cfg, {
      method: 'PUT', key: '', query: { cors: '' }, body: CORS_XML,
      headers: { 'content-type': 'application/xml' },
    });
    return { ok: true };
  }

  async function getCors(cfg) {
    cfg = smartParse(normalize(cfg));
    try {
      const r = await call(cfg, { method: 'GET', key: '', query: { cors: '' } });
      if (/NoSuchCORSConfiguration/i.test(r.text)) return { ok: false, error: 'no_cors' };
      return { ok: true, raw: r.text, origins: all(r.text, 'AllowedOrigin').map(unxml) };
    } catch (e) {
      return { ok: false, error: e.message, status: e.status || 0 };
    }
  }


  /* ── آزمایش دسترسی مرورگر/گوشی (CORS) ───────────────────────────
     همان درخواستی را می‌فرستیم که یک مرورگر می‌فرستد: GET با هدر Origin.
     اگر پاسخ هدرِ access-control-allow-origin داشته باشد، گوشی می‌تواند
     بخواند؛ وگرنه مرورگر جواب را دور می‌ریزد (دقیقاً همان خطای «نرسیدیم»). */
  const PHONE_ORIGIN = 'https://appassets.androidplatform.net';
  async function corsProbe(cfg, origin) {
    cfg = smartParse(normalize(cfg));
    const out = { ok: false, reachable: false, status: 0, allow_origin: null, detail: null, origin: origin || PHONE_ORIGIN, native: !!nativeBridge() };
    /* برنامهٔ نصبی خودش بومی وصل می‌شود؛ اجازهٔ مرورگر لازم نیست */
    if (out.native) {
      try {
        await list(Object.assign({}, cfg, { prefix: cfg.prefix }), { max: 1 });
        out.ok = true; out.reachable = true; out.status = 200; out.allow_origin = 'native';
        return out;
      } catch (e) {
        out.error = (e && e.kind) || 'network';
        out.detail = (e && (e.detail || e.message)) || '';
        return out;
      }
    }
    /* سه درخواست به‌ترتیب: فهرست صندوقچه (همیشه هست)، فایل داده، فایل آزمون */
    const attempts = [
      { key: '', query: { 'list-type': '2', 'max-keys': '1', prefix: cfg.prefix } },
      { key: cfg.prefix + 'data/core.json' },
      { key: cfg.prefix + '_probe.txt' },
    ];
    for (const a of attempts) {
      const signed = buildRequest(cfg, { method: 'GET', key: a.key, query: a.query });
      const headers = Object.assign({}, signed.headers, { origin: out.origin });
      let res;
      try {
        res = await fetch(signed.url, { method: 'GET', headers });
      } catch (e) {
        out.error = 'network';
        out.detail = String(e && e.message || e).slice(0, 160);
        return out;
      }
      out.reachable = true;
      out.status = res.status;
      const acao = res.headers.get('access-control-allow-origin');
      out.allow_origin = acao;
      if (acao) { out.ok = true; return out; }
    }
    return out;
  }

  async function test(cfg) {
    cfg = smartParse(normalize(cfg));
    const out = { ok: false, steps: [], ms: 0, region: regionOf(cfg) };
    if (!cfg.endpoint || !cfg.bucket || !cfg.accessKey || !cfg.secret) {
      out.error = 'چهار مقدار لازم است: آدرس، نام صندوقچه، کلید عمومی، کلید خصوصی';
      return out;
    }
    const t0 = Date.now();
    const key = cfg.prefix + '_probe.txt';
    const token = 'payesh-' + Date.now();
    try {
      const l = await list(cfg, { max: 3 });
      out.steps.push({ name: 'دیدن صندوقچه', ok: true, note: l.keys.length ? l.keys.length + ' فایل' : 'خالی' });
      const t1 = Date.now();
      await put(cfg, key, token);
      out.steps.push({ name: 'نوشتن', ok: true, ms: Date.now() - t1 });
      const back = await get(cfg, key);
      const same = String(back).trim() === token;
      out.steps.push({ name: 'خواندن', ok: same, note: same ? null : 'محتوای برگشتی یکسان نبود' });
      await remove(cfg, key);
      out.steps.push({ name: 'پاک‌کردن', ok: true });
      out.ok = out.steps.every(s => s.ok);
    } catch (e) {
      out.steps.push({ name: 'اتصال', ok: false, note: e.message });
      out.error = e.message; out.kind = e.kind || 'unknown'; out.detail = e.detail || null;
    }
    out.ms = Date.now() - t0;
    return out;
  }

  return { DEFAULTS, normalize, smartParse, regionOf, buildRequest, call, list, listBuckets, put, get, remove, setCors, getCors, corsProbe, nativeBridge, PHONE_ORIGIN, test, presign };
});
