/* ═══════════════════════════════════════════════════════════════════
   پنل مالک پلتفرم پایش — SPA ایستا، فارسی/RTL · PR-3 · ردیف ۹۸

   • مستقل از client/pages.js و هر فایل client/*؛ بدون CDN، فونت یا
     اسکریپت خارجی؛ فقط درخواست same-origin به /api/platform/v1.
   • هیچ innerHTML/eval؛ همهٔ داده با textContent ساخته می‌شود.
   • توکن فقط در حافظه نگه داشته می‌شود (نه localStorage/cookie).
   • نقش در UI فقط برای پنهان‌کردن دکمه است؛ مرجع اختیار، سرور است
     (PR-2: needRole در لبه + require_actor در دیتابیس).
   ═══════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var API = '/api/platform/v1';
  var THEME_KEY = 'payesh-owner-panel-theme';
  var TOKEN_RE = /^platform\.v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  var ROLE_LABEL = {
    platform_owner: 'مالک پلتفرم',
    platform_operator: 'اپراتور',
    platform_support: 'پشتیبان فنی',
  };

  /* آینهٔ UI از اختیارات سرور (apps/owner-panel/server/platform-api.js).
     پنهان‌کردن دکمه امنیت نیست؛ سرور در هر حال 403 می‌دهد. */
  var CAPS = {
    platform_owner:    { renew: true,  deleteRequest: true,  createPlan: true,  suspend: true,  approveGrant: true,  revokeGrant: true,  createUser: true,  requestGrant: false },
    platform_operator: { renew: false, deleteRequest: false, createPlan: false, suspend: true,  approveGrant: false, revokeGrant: false, createUser: false, requestGrant: true },
    platform_support:  { renew: false, deleteRequest: false, createPlan: false, suspend: false, approveGrant: false, revokeGrant: false, createUser: false, requestGrant: true },
  };
  var NO_CAPS = { renew: false, deleteRequest: false, createPlan: false, suspend: false, approveGrant: false, revokeGrant: false, createUser: false, requestGrant: false };

  var PAGES = [
    { id: 'dashboard', title: 'داشبورد',           icon: 'M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 9h8V3h-8z' },
    { id: 'schools',   title: 'مدارس',             icon: 'M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6' },
    { id: 'plans',     title: 'پلن و اشتراک',      icon: 'M4 6h16v12H4zM4 10h16M8 15h3' },
    { id: 'limits',    title: 'سقف و مصرف',        icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2' },
    { id: 'health',    title: 'سلامت',             icon: 'M3 12h4l3-8 4 16 3-8h4' },
    { id: 'operators', title: 'اپراتورها و مجوز',  icon: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 12 0v1M17 11l2 2 4-4' },
    { id: 'reports',   title: 'گزارش',             icon: 'M6 2h9l5 5v15H6zM14 2v6h6M9 13h8M9 17h8' },
    { id: 'audit',     title: 'ممیزی',             icon: 'M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z' },
  ];

  var ERRORS = {
    network: 'ارتباط با سرور برقرار نشد. اتصال شبکه یا Gateway را بررسی کنید.',
    bad_response: 'پاسخ سرور قابل‌خواندن نبود.',
    unauthorized: 'نشست شما معتبر نیست یا منقضی شده است؛ دوباره وارد شوید.',
    role_forbidden: 'نقش شما اجازهٔ این کار را ندارد (سرور درخواست را رد کرد).',
    forbidden: 'لایهٔ داده اجازهٔ این کار را نداد.',
    not_configured: 'API پلتفرم روی سرور پیکربندی نشده است (not_configured).',
    upstream_not_configured: 'آدرس API پلتفرم برای این سرور پنل تنظیم نشده است.',
    upstream_unavailable: 'API پلتفرم در دسترس نیست.',
    rate_limited: 'تعداد درخواست‌ها از سقف گذشت؛ کمی بعد دوباره تلاش کنید.',
    rate_limit_unavailable: 'سامانهٔ سهمیهٔ درخواست در دسترس نیست.',
    reason_too_short: 'دلیل باید دست‌کم ۱۰ نویسه باشد.',
    grant_required: 'برای خواندن محتوا مجوز فعال لازم است.',
    bulk_content_forbidden: 'دریافت انبوه محتوای مدرسه مجاز نیست.',
    tenant_deletion_disabled: 'حذف فوری مدرسه مجاز نیست؛ فقط درخواست حذف با تأیید مالک دوم و مهلت ۲۴ ساعت.',
    four_eyes_required: 'درخواست‌دهندهٔ حذف نمی‌تواند خودش آن را تأیید کند؛ مالک دیگری باید تأیید کند.',
    deletion_delay_pending: 'مهلت ۲۴ ساعتهٔ پس از تأیید هنوز تمام نشده است.',
    confirm_mismatch: 'شناسهٔ تکرارشدهٔ مدرسه با مدرسهٔ انتخاب‌شده یکسان نیست.',
    tenant_not_found: 'مدرسه پیدا نشد.',
    subscription_not_found: 'اشتراک پیدا نشد.',
    request_not_found: 'درخواست پیدا نشد.',
    grant_not_found: 'مجوز پیدا نشد.',
    invalid_scope: 'دامنهٔ مجوز نامعتبر است.',
    invalid_tenant_id: 'شناسهٔ مدرسه نامعتبر است.',
    invalid_input: 'ورودی با قیدهای داده سازگار نیست.',
    conflict: 'این رکورد قبلاً ثبت شده است (برای این مدرسه درخواست باز دیگری وجود دارد).',
    body_too_large: 'حجم درخواست بیش از حد مجاز است.',
    bad_json: 'بدنهٔ درخواست JSON معتبر نیست.',
    login_unavailable: 'صادرکنندهٔ ورود (رمز + TOTP، تصمیم D‑45) روی این سرور نصب نشده است (migration 004)؛ ورود ممکن نیست.',
    login_failed: 'شناسه، رمز یا کد دومرحله‌ای نادرست است. هر کد فقط یک بار پذیرفته می‌شود و پس از ۵ تلاش ناموفق، حساب ۱۵ دقیقه قفل می‌شود.',
    internal_error: 'خطای داخلی سرور.',
    not_found: 'مسیر روی سرور وجود ندارد.',
  };

  function capsFor(role) { return CAPS[role] || NO_CAPS; }

  function b64urlDecode(s) {
    var b = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    var bin = global.atob(b);
    if (typeof global.TextDecoder === 'function') {
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new global.TextDecoder('utf-8').decode(bytes);
    }
    return bin;
  }

  /* فقط برای نمایش نقش و پنهان‌کردن دکمه؛ امضا را سرور بررسی می‌کند. */
  function decodeClaims(token, now) {
    if (!TOKEN_RE.test(String(token || ''))) return null;
    var c;
    try { c = JSON.parse(b64urlDecode(String(token).split('.')[2])); } catch (e) { return null; }
    if (!c || c.typ !== 'platform' || c.v !== 1) return null;
    if (!UUID_RE.test(String(c.sub || ''))) return null;
    if (!Object.prototype.hasOwnProperty.call(ROLE_LABEL, c.role)) return null;
    if (typeof c.exp !== 'number' || c.exp <= (now || Date.now())) return null;
    return { sub: c.sub, role: c.role, exp: c.exp };
  }

  function faNum(n) {
    if (n === null || n === undefined || n === '') return '—';
    var x = Number(n);
    if (!isFinite(x)) return String(n);
    return new Intl.NumberFormat('fa-IR').format(x);
  }
  function faDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { dateStyle: 'medium', timeStyle: 'short' }).format(d);
  }
  function faBytes(n) {
    var x = Number(n);
    if (!isFinite(x)) return '—';
    if (x >= 1073741824) return faNum((x / 1073741824).toFixed(1)) + ' گیگابایت';
    if (x >= 1048576) return faNum((x / 1048576).toFixed(1)) + ' مگابایت';
    if (x >= 1024) return faNum((x / 1024).toFixed(1)) + ' کیلوبایت';
    return faNum(x) + ' بایت';
  }
  function normDigits(s) {
    return String(s || '').replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 0x06F0); })
      .replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); });
  }
  function requestId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
    return 'op-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function shortId(id) { return id ? String(id).slice(0, 8) : '—'; }

  var STATUS_LABEL = {
    active: ['فعال', 'ok'], trialing: ['آزمایشی', 'info'], suspended: ['تعلیق', 'bad'],
    past_due: ['معوق', 'warn'], grace: ['مهلت', 'warn'], canceled: ['لغوشده', 'bad'], expired: ['منقضی', 'bad'],
    disabled: ['غیرفعال', 'bad'], locked: ['قفل', 'bad'],
    pending: ['منتظر تأیید', 'warn'], approved: ['تأییدشده، در مهلت', 'warn'], executed: ['اجراشده (داده نگه‌داری می‌شود)', 'bad'],
  };

  function createApp(opts) {
    var doc = opts.document;
    var win = opts.window || global;
    var fetchImpl = opts.fetch;
    var root = doc.getElementById('app');
    var session = null;
    var current = 'dashboard';
    var flashMsg = null;
    var pending = Promise.resolve();

    /* ── DOM ─────────────────────────────────────────────────────────── */
    function h(tag, attrs, kids) {
      var el = doc.createElement(tag);
      if (attrs) {
        Object.keys(attrs).forEach(function (k) {
          var v = attrs[k];
          if (v === null || v === undefined || v === false) return;
          if (k === 'text') el.textContent = String(v);
          else if (k === 'class') el.className = v;
          else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
          else el.setAttribute(k, v === true ? '' : String(v));
        });
      }
      (kids || []).forEach(function (c) {
        if (c === null || c === undefined || c === false) return;
        el.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
      });
      return el;
    }
    function icon(d) {
      var NS = 'http://www.w3.org/2000/svg';
      var svg = doc.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8');
      svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('aria-hidden', 'true');
      var p = doc.createElementNS(NS, 'path'); p.setAttribute('d', d); svg.appendChild(p);
      return svg;
    }
    function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
    function setState(box, kind, text) {
      clear(box).appendChild(h('div', { class: 'state', 'data-state': kind,
        role: kind === 'error' ? 'alert' : 'status', text: text }));
    }
    function badge(status) {
      var s = STATUS_LABEL[status] || [String(status || '—'), ''];
      return h('span', { class: 'badge ' + s[1], 'data-status': status || '', text: s[0] });
    }
    function table(cols, rows, rowFn) {
      return h('div', { class: 'table-wrap' }, [h('table', null, [
        h('thead', null, [h('tr', null, cols.map(function (c) { return h('th', { scope: 'col', text: c }); }))]),
        h('tbody', null, rows.map(function (r) { return h('tr', null, rowFn(r).map(function (c) {
          return h('td', null, [typeof c === 'string' ? doc.createTextNode(c) : c]); })); })),
      ])]);
    }
    function card(title, kids) { return h('section', { class: 'card' }, [h('h2', { text: title })].concat(kids || [])); }
    function errText(r) {
      var code = r && r.body && r.body.error;
      var base = ERRORS[code] || ERRORS[r && r.kind] || ('خطا' + (r && r.status ? ' (' + faNum(r.status) + ')' : ''));
      var detail = r && r.body && typeof r.body.detail === 'string' ? r.body.detail : '';
      return detail ? base + ' — ' + detail : base;
    }
    function flash(kind, text) { flashMsg = { kind: kind, text: text }; }

    /* ── API: same-origin، بدون cookie، بدون redirect ───────────────── */
    function api(method, path, body) {
      var headers = { accept: 'application/json', 'x-request-id': requestId() };
      if (session) headers.authorization = 'Bearer ' + session.token;
      var init = { method: method, headers: headers, credentials: 'omit', redirect: 'error', cache: 'no-store' };
      if (body !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
      return Promise.resolve().then(function () { return fetchImpl(API + path, init); }).then(function (res) {
        var ct = String((res.headers && res.headers.get && res.headers.get('content-type')) || '');
        if (ct.indexOf('application/json') !== 0) return { ok: false, status: res.status, kind: 'bad_response', body: null };
        return res.json().then(function (j) {
          var out = { ok: res.status >= 200 && res.status < 300 && j && j.ok !== false, status: res.status, body: j };
          if (res.status === 401 && session) { session = null; flash('error', ERRORS.unauthorized); render(); }
          return out;
        }, function () { return { ok: false, status: res.status, kind: 'bad_response', body: null }; });
      }, function () { return { ok: false, status: 0, kind: 'network', body: null }; });
    }

    /* ── پوسته ─────────────────────────────────────────────────────── */
    function themeMode() {
      try { var v = win.localStorage.getItem(THEME_KEY); if (v === 'light' || v === 'dark') return v; } catch (e) { /* noop */ }
      return 'system';
    }
    function applyTheme(mode) {
      var el = doc.documentElement;
      if (mode === 'light' || mode === 'dark') el.setAttribute('data-theme', mode);
      else el.removeAttribute('data-theme');
      try { if (mode === 'system') win.localStorage.removeItem(THEME_KEY); else win.localStorage.setItem(THEME_KEY, mode); } catch (e) { /* noop */ }
    }
    function themeButton() {
      var labels = { system: 'پوسته: سیستم', light: 'پوسته: روشن', dark: 'پوسته: تاریک' };
      var btn = h('button', { type: 'button', class: 'btn', 'data-action': 'theme', text: labels[themeMode()] });
      btn.addEventListener('click', function () {
        var next = { system: 'light', light: 'dark', dark: 'system' }[themeMode()];
        applyTheme(next);
        btn.textContent = labels[next];
      });
      return btn;
    }
    function flashEl() {
      if (!flashMsg) return null;
      var el = h('div', { class: 'flash', 'data-kind': flashMsg.kind, role: flashMsg.kind === 'error' ? 'alert' : 'status', text: flashMsg.text });
      flashMsg = null;
      return el;
    }

    function render() {
      clear(root);
      if (!session) { renderLogin(); pending = Promise.resolve(); return pending; }
      var caps = capsFor(session.role);
      var nav = h('nav', { class: 'sidebar', 'aria-label': 'بخش‌های پنل' }, [
        h('div', { class: 'brand' }, [h('img', { src: 'icons/logo-mark.png', alt: '' }), h('span', { text: 'پنل مالک پایش' })]),
      ].concat(PAGES.map(function (p) {
        return h('button', { type: 'button', class: 'navitem', 'data-page': p.id,
          'aria-current': p.id === current ? 'page' : null,
          onclick: function () { show(p.id); } }, [icon(p.icon), h('span', { text: p.title })]);
      })));
      var page = PAGES.filter(function (p) { return p.id === current; })[0] || PAGES[0];
      var body = h('div', { id: 'page', 'data-page': page.id });
      var main = h('main', { class: 'main' }, [
        h('header', { class: 'topbar' }, [
          h('h1', { text: page.title }),
          h('div', { class: 'who' }, [
            h('span', { class: 'badge info', 'data-role': session.role, text: ROLE_LABEL[session.role] }),
            themeButton(),
            h('button', { type: 'button', class: 'btn', 'data-action': 'logout', onclick: logout, text: 'خروج' }),
          ]),
        ]),
        flashEl(),
        body,
      ]);
      root.appendChild(h('div', { class: 'shell', 'data-caps': Object.keys(caps).filter(function (k) { return caps[k]; }).join(' ') }, [nav, main]));
      pending = Promise.resolve(LOADERS[page.id](body, caps)).catch(function () {
        setState(body, 'error', ERRORS.internal_error);
      });
      return pending;
    }

    function show(id) {
      if (!PAGES.some(function (p) { return p.id === id; })) id = 'dashboard';
      current = id;
      try { if (win.location && win.location.hash !== '#/' + id) win.history.replaceState(null, '', '#/' + id); } catch (e) { /* noop */ }
      return render();
    }
    function logout() { session = null; flash('ok', 'از پنل خارج شدید.'); render(); }
    function setSession(token) {
      var c = decodeClaims(token);
      if (!c) return false;
      session = { token: token, sub: c.sub, role: c.role, exp: c.exp };
      return true;
    }

    /* ── ورود + TOTP (fail-closed) ──────────────────────────────────── */
    function renderLogin() {
      var msg = h('div', { id: 'login-msg' });
      var f = flashEl(); if (f) msg.appendChild(f);
      var idIn = h('input', { class: 'input', name: 'login_id', id: 'login_id', autocomplete: 'username', required: true, dir: 'ltr' });
      var pwIn = h('input', { class: 'input', name: 'password', id: 'password', type: 'password', autocomplete: 'current-password', required: true, dir: 'ltr' });
      var totpIn = h('input', { class: 'input', name: 'totp', id: 'totp', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', required: true, dir: 'ltr' });
      var submit = h('button', { type: 'submit', class: 'btn primary', text: 'ورود' });
      var form = h('form', { class: 'card', id: 'login-form', novalidate: true }, [
        h('h2', { text: 'ورود به پنل مالک' }),
        h('p', { class: 'notice', text: 'این پنل از برنامهٔ مدرسه جداست. ورود دومرحله‌ای (TOTP) اجباری است.' }),
        msg,
        h('label', { for: 'login_id', text: 'شناسهٔ ورود' }), idIn,
        h('label', { for: 'password', text: 'رمز عبور' }), pwIn,
        h('label', { for: 'totp', text: 'کد دومرحله‌ای ۶ رقمی' }), totpIn,
        h('div', { class: 'row', style: null }, [submit, themeButton()]),
      ]);
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var loginId = String(idIn.value || '').trim();
        var password = String(pwIn.value || '');
        var totp = normDigits(totpIn.value).trim();
        pwIn.value = ''; totpIn.value = '';
        clear(msg);
        if (!loginId || !password) { msg.appendChild(h('div', { class: 'flash', 'data-kind': 'error', role: 'alert', text: 'شناسه و رمز را وارد کنید.' })); return; }
        if (!/^[0-9]{6}$/.test(totp)) { msg.appendChild(h('div', { class: 'flash', 'data-kind': 'error', role: 'alert', text: 'کد دومرحله‌ای باید ۶ رقم باشد.' })); return; }
        submit.disabled = true;
        pending = api('POST', '/auth/login', { login_id: loginId, password: password, totp: totp }).then(function (r) {
          submit.disabled = false;
          var tok = r.ok && r.body && typeof r.body.token === 'string' ? r.body.token : '';
          if (tok && setSession(tok)) { current = 'dashboard'; return render(); }
          var text = r.status === 404 || r.status === 501 ? ERRORS.login_unavailable
            : (r.status === 401 ? ERRORS.login_failed : (r.ok ? ERRORS.bad_response : errText(r)));
          msg.appendChild(h('div', { class: 'flash', 'data-kind': 'error', role: 'alert', text: text }));
        });
      });
      root.appendChild(h('div', { class: 'login' }, [
        h('div', { class: 'brand' }, [h('img', { src: 'icons/logo-mark.png', alt: '' }), h('span', { text: 'پنل مالک پلتفرم پایش' })]),
        form,
      ]));
    }

    /* ── دیالوگ تأیید با دلیل اجباری ────────────────────────────────── */
    function confirmDialog(o) {
      return new Promise(function (resolve) {
        var reason = h('textarea', { class: 'input', id: 'dlg-reason', rows: '3', required: true });
        var retype = o.retype ? h('input', { class: 'input', id: 'dlg-retype', dir: 'ltr', autocomplete: 'off' }) : null;
        var err = h('div', { id: 'dlg-error' });
        var extra = (o.fields || []).map(function (f) { return f.el; });
        function close(v) { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); resolve(v); }
        var ok = h('button', { type: 'submit', class: 'btn ' + (o.danger ? 'danger' : 'primary'), 'data-action': 'dlg-submit', text: o.submit || 'تأیید' });
        var cancel = h('button', { type: 'button', class: 'btn', 'data-action': 'dlg-cancel', text: 'انصراف', onclick: function () { close(null); } });
        var form = h('form', { class: 'modal card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dlg-title', novalidate: true }, [
          h('h2', { id: 'dlg-title', text: o.title }),
        ].concat((o.lines || []).map(function (t) { return h('p', { text: t }); }))
          .concat(extra)
          .concat([
            h('label', { for: 'dlg-reason', text: 'دلیل (اجباری، دست‌کم ۱۰ نویسه)' }), reason,
            retype ? h('label', { for: 'dlg-retype', text: 'برای تأیید دوباره، این مقدار را تایپ کنید: ' + o.retype }) : null,
            retype, err, h('div', { class: 'actions' }, [ok, cancel]),
          ]));
        form.addEventListener('submit', function (ev) {
          ev.preventDefault();
          clear(err);
          var r = String(reason.value || '').trim();
          if (r.length < 10) { err.appendChild(h('div', { class: 'flash', 'data-kind': 'error', role: 'alert', text: ERRORS.reason_too_short })); return; }
          if (retype && String(retype.value || '').trim() !== o.retype) { err.appendChild(h('div', { class: 'flash', 'data-kind': 'error', role: 'alert', text: 'مقدار تأیید با مقدار خواسته‌شده یکسان نیست.' })); return; }
          var values = {};
          (o.fields || []).forEach(function (f) { values[f.name] = f.read(); });
          if (o.validate) { var m = o.validate(values); if (m) { err.appendChild(h('div', { class: 'flash', 'data-kind': 'error', role: 'alert', text: m })); return; } }
          close({ reason: r, values: values });
        });
        var wrap = h('div', { class: 'modal-backdrop', id: 'dialog' }, [form]);
        root.appendChild(wrap);
        reason.focus();
      });
    }

    function afterMutation(r, okText) {
      if (r.ok) flash('ok', okText); else flash('error', errText(r));
      return render();
    }

    /* ── صفحه‌ها ───────────────────────────────────────────────────── */
    var LOADERS = {
      dashboard: function (body) {
        var box = h('div'); body.appendChild(box);
        setState(box, 'loading', 'در حال دریافت خلاصه…');
        return api('GET', '/dashboard').then(function (r) {
          if (!r.ok) return setState(box, 'error', errText(r));
          var d = r.body.dashboard || {};
          var items = [['subscriptions', 'اشتراک‌ها'], ['plans', 'پلن‌ها'], ['active_users', 'کاربران فعال پلتفرم'], ['open_grants', 'مجوزهای باز پشتیبانی']];
          if (items.every(function (i) { return !Number(d[i[0]]); })) return setState(box, 'empty', 'هنوز داده‌ای برای خلاصه وجود ندارد.');
          clear(box).appendChild(h('div', { class: 'stats' }, items.map(function (i) {
            return h('div', { class: 'stat', 'data-metric': i[0] }, [h('span', { text: i[1] }), h('b', { text: faNum(d[i[0]]) })]);
          })));
          box.appendChild(h('p', { class: 'notice', text: 'داشبورد فقط شمارش و وضعیت فراداده است؛ محتوای مدارس نمایش داده نمی‌شود.' }));
        });
      },

      schools: function (body, caps) {
        var box = h('div'); body.appendChild(card('فهرست مدارس', [box]));
        var delBox = caps.deleteRequest ? h('div') : null;
        if (delBox) body.appendChild(card('درخواست‌های حذف مدرسه (چهارچشمی + ۲۴ ساعت)', [delBox]));
        setState(box, 'loading', 'در حال دریافت مدارس…');
        if (delBox) setState(delBox, 'loading', 'در حال دریافت درخواست‌های حذف…');
        var calls = [api('GET', '/tenants')];
        if (delBox) calls.push(api('GET', '/tenant-deletions'));
        return Promise.all(calls).then(function (rs) {
          var r = rs[0], d = rs[1];
          var open = {};
          var dels = d && d.ok ? (d.body.requests || []) : [];
          dels.forEach(function (x) { if (x.status === 'pending' || x.status === 'approved') open[x.tenant_id] = x; });
          if (!r.ok) setState(box, 'error', errText(r));
          else if (!(r.body.tenants || []).length) setState(box, 'empty', 'هنوز مدرسه‌ای ثبت نشده است.');
          else clear(box).appendChild(table(['مدرسه', 'پلن', 'وضعیت', 'پایان اشتراک', 'عملیات'], r.body.tenants, function (t) {
            var acts = [];
            if (caps.suspend && t.status !== 'suspended' && t.status !== 'canceled') acts.push(h('button', { type: 'button', class: 'btn', 'data-action': 'suspend', 'data-tenant': t.tenant_id, text: 'تعلیق',
              onclick: function () { suspendTenant(t); } }));
            if (caps.deleteRequest && open[t.tenant_id]) acts.push(h('span', { class: 'badge warn', 'data-deletion': open[t.tenant_id].status, text: 'درخواست حذف باز' }));
            else if (caps.deleteRequest && t.status !== 'canceled') acts.push(h('button', { type: 'button', class: 'btn danger', 'data-action': 'delete-request', 'data-tenant': t.tenant_id, text: 'درخواست حذف',
              onclick: function () { deleteTenant(t); } }));
            return [h('code', { title: t.tenant_id, text: shortId(t.tenant_id) }), t.plan_code || '—', badge(t.status), faDate(t.ends_at),
              acts.length ? h('div', { class: 'actions' }, acts) : h('span', { class: 'badge', text: 'فقط مشاهده' })];
          }));
          if (!delBox) return;
          if (!d.ok) return setState(delBox, 'error', errText(d));
          if (!dels.length) return setState(delBox, 'empty', 'درخواست حذفی ثبت نشده است.');
          clear(delBox).appendChild(table(['مدرسه', 'وضعیت', 'درخواست', 'تأیید', 'اجرا از', 'نگهداری داده تا', 'عملیات'], dels, function (x) {
            var acts = [];
            var mine = session && x.requested_by === session.sub;
            if (x.status === 'pending' && !mine) acts.push(h('button', { type: 'button', class: 'btn primary', 'data-action': 'deletion-approve', 'data-request': x.id, text: 'تأیید (مالک دوم)',
              onclick: function () { approveDeletion(x); } }));
            if (x.status === 'pending' && mine) acts.push(h('span', { class: 'badge', 'data-wait': 'second-owner', text: 'منتظر تأیید مالک دیگر' }));
            if (x.status === 'approved') {
              var due = new Date(x.not_before).getTime() <= Date.now();
              if (due) acts.push(h('button', { type: 'button', class: 'btn danger', 'data-action': 'deletion-execute', 'data-request': x.id, text: 'اجرا',
                onclick: function () { executeDeletion(x); } }));
              else acts.push(h('span', { class: 'badge', 'data-wait': 'delay', text: 'مهلت ۲۴ ساعته در جریان است' }));
            }
            if (x.status === 'pending' || x.status === 'approved') acts.push(h('button', { type: 'button', class: 'btn', 'data-action': 'deletion-cancel', 'data-request': x.id, text: 'لغو',
              onclick: function () { cancelDeletion(x); } }));
            return [h('code', { title: x.tenant_id, text: shortId(x.tenant_id) }), badge(x.status), faDate(x.created_at), faDate(x.approved_at),
              faDate(x.not_before), faDate(x.retain_until), acts.length ? h('div', { class: 'actions' }, acts) : h('span', { text: '—' })];
          }));
          delBox.appendChild(h('p', { class: 'notice', text: 'اجرا یعنی توقف سرویس و لغو اشتراک؛ داده دست‌کم ۱۸۰ روز نگه داشته می‌شود و هیچ داده‌ای از این پنل نابود نمی‌شود.' }));
        });
      },

      plans: function (body, caps) {
        var plansBox = h('div'); var subsBox = h('div');
        var planCard = card('پلن‌ها', [plansBox]);
        if (caps.createPlan) planCard.insertBefore(h('div', { class: 'actions' }, [h('button', { type: 'button', class: 'btn primary', 'data-action': 'create-plan', text: 'پلن جدید', onclick: createPlan })]), plansBox);
        body.appendChild(planCard);
        body.appendChild(card('اشتراک‌ها', [subsBox]));
        setState(plansBox, 'loading', 'در حال دریافت پلن‌ها…');
        setState(subsBox, 'loading', 'در حال دریافت اشتراک‌ها…');
        return Promise.all([api('GET', '/plans'), api('GET', '/subscriptions')]).then(function (rs) {
          var p = rs[0], s = rs[1];
          if (!p.ok) setState(plansBox, 'error', errText(p));
          else if (!(p.body.plans || []).length) setState(plansBox, 'empty', 'هنوز پلنی تعریف نشده است.');
          else clear(plansBox).appendChild(table(['کد', 'نام', 'سقف کاربر', 'سقف هنرجو', 'فضا', 'وضعیت'], p.body.plans, function (x) {
            return [h('code', { text: x.code }), x.name || '—', faNum(x.max_users), faNum(x.max_students), faBytes(Number(x.storage_mb) * 1048576),
              x.archived_at ? h('span', { class: 'badge bad', text: 'بایگانی' }) : h('span', { class: 'badge ok', text: 'فعال' })];
          }));
          if (!s.ok) return setState(subsBox, 'error', errText(s));
          var subs = s.body.subscriptions || [];
          if (!subs.length) return setState(subsBox, 'empty', 'هنوز اشتراکی ثبت نشده است.');
          clear(subsBox).appendChild(table(['مدرسه', 'پلن', 'وضعیت', 'شروع', 'پایان', 'عملیات'], subs, function (x) {
            return [h('code', { title: x.tenant_id, text: shortId(x.tenant_id) }), x.plan_code || '—', badge(x.status), faDate(x.starts_at), faDate(x.ends_at),
              caps.renew ? h('button', { type: 'button', class: 'btn', 'data-action': 'renew', 'data-subscription': x.id, text: 'تمدید', onclick: function () { renew(x); } })
                : h('span', { class: 'badge', text: 'فقط مشاهده' })];
          }));
        });
      },

      limits: function (body) {
        var pick = h('select', { class: 'input', id: 'limits-tenant', 'aria-label': 'انتخاب مدرسه' });
        var detail = h('div', { id: 'limits-detail' });
        var head = h('div');
        body.appendChild(card('سقف و مصرف هر مدرسه', [head, detail]));
        setState(head, 'loading', 'در حال دریافت مدارس…');
        function loadOne(tid) {
          setState(detail, 'loading', 'در حال دریافت سقف و مصرف…');
          return Promise.all([api('GET', '/tenants/' + encodeURIComponent(tid) + '/limits'), api('GET', '/tenants/' + encodeURIComponent(tid) + '/usage')]).then(function (rs) {
            var l = rs[0], u = rs[1];
            if (!l.ok) return setState(detail, 'error', errText(l));
            if (!u.ok) return setState(detail, 'error', errText(u));
            var lim = l.body.limits, use = u.body.usage;
            if (!lim && !use) return setState(detail, 'empty', 'برای این مدرسه هنوز سقف یا مصرفی ثبت نشده است.');
            lim = lim || {}; use = use || {};
            var pct = Number(lim.storage_bytes) > 0 ? Math.round(100 * Number(use.storage_bytes || 0) / Number(lim.storage_bytes)) : null;
            clear(detail).appendChild(table(['شاخص', 'مصرف', 'سقف'], [
              ['کاربران', faNum(use.users_count), faNum(lim.max_users)],
              ['هنرجویان', faNum(use.students_count), faNum(lim.max_students)],
              ['فضای ذخیره‌سازی', faBytes(use.storage_bytes) + (pct === null ? '' : ' (' + faNum(pct) + '٪)'), faBytes(lim.storage_bytes)],
            ], function (row) { return row; }));
            detail.appendChild(h('p', { class: 'notice', text: 'آخرین محاسبهٔ مصرف: ' + faDate(use.last_recalc_at) + ' — تغییر سقف در این نسخه از UI ممکن نیست.' }));
          });
        }
        return api('GET', '/tenants').then(function (r) {
          if (!r.ok) return setState(head, 'error', errText(r));
          var rows = r.body.tenants || [];
          if (!rows.length) { clear(detail); return setState(head, 'empty', 'هنوز مدرسه‌ای ثبت نشده است.'); }
          rows.forEach(function (t) { pick.appendChild(h('option', { value: t.tenant_id, text: shortId(t.tenant_id) + ' · ' + (t.plan_code || '') })); });
          pick.addEventListener('change', function () { pending = loadOne(pick.value); });
          clear(head).appendChild(h('div', null, [h('label', { for: 'limits-tenant', text: 'مدرسه' }), pick]));
          return loadOne(rows[0].tenant_id);
        });
      },

      health: function (body) {
        var box = h('div'); body.appendChild(card('سلامت API پلتفرم (فقط فراداده)', [box]));
        setState(box, 'loading', 'در حال بررسی سلامت…');
        return api('GET', '/health/summary').then(function (r) {
          if (!r.ok) return setState(box, 'error', errText(r));
          var x = r.body;
          clear(box).appendChild(table(['شاخص', 'مقدار'], [
            ['پیکربندی', h('span', { class: 'badge ' + (x.configured ? 'ok' : 'bad'), 'data-health': 'configured', text: x.configured ? 'پیکربندی‌شده' : 'پیکربندی‌نشده' })],
            ['نمونهٔ سرور', h('code', { text: String(x.instance || '—') })],
            ['پیش‌فرض محتوا', h('span', { class: 'badge ok', text: x.content_default === 'deny' ? 'رد (Default Deny)' : String(x.content_default) })],
            ['وضعیت امنیت', h('span', { class: 'badge warn', 'data-health': 'security', text: String(x.security || 'UNKNOWN') })],
          ], function (row) { return row; }));
          box.appendChild(h('p', { class: 'notice', text: 'سلامت جداگانهٔ هر مدرسه (آخرین همگام‌سازی، نسخه، خطاها) هنوز در API وجود ندارد.' }));
        });
      },

      operators: function (body, caps) {
        var usersBox = h('div'); var grantsBox = h('div'); var reqBox = h('div');
        var usersCard = card('کاربران پلتفرم', [usersBox]);
        if (caps.createUser) usersCard.insertBefore(h('div', { class: 'actions' }, [h('button', { type: 'button', class: 'btn primary', 'data-action': 'create-user', text: 'کاربر جدید', onclick: createUser })]), usersBox);
        body.appendChild(usersCard);
        var grantsCard = card('مجوزهای پشتیبانی', [grantsBox]);
        if (caps.requestGrant) grantsCard.insertBefore(h('div', { class: 'actions' }, [h('button', { type: 'button', class: 'btn primary', 'data-action': 'request-grant', text: 'درخواست مجوز', onclick: requestGrant })]), grantsBox);
        body.appendChild(grantsCard);
        if (caps.approveGrant) body.appendChild(card('درخواست‌های ثبت‌شده (از دفتر ممیزی)', [reqBox]));
        setState(usersBox, 'loading', 'در حال دریافت کاربران…');
        setState(grantsBox, 'loading', 'در حال دریافت مجوزها…');
        if (caps.approveGrant) setState(reqBox, 'loading', 'در حال دریافت درخواست‌ها…');
        var calls = [api('GET', '/platform-users'), api('GET', '/support-grants')];
        if (caps.approveGrant) calls.push(api('GET', '/audit'));
        return Promise.all(calls).then(function (rs) {
          var u = rs[0], g = rs[1], a = rs[2];
          if (!u.ok) setState(usersBox, 'error', errText(u));
          else if (!(u.body.users || []).length) setState(usersBox, 'empty', 'کاربری ثبت نشده است.');
          else clear(usersBox).appendChild(table(['شناسهٔ ورود', 'نقش', 'وضعیت', 'ایجاد'], u.body.users, function (x) {
            return [h('code', { text: x.login_id }), ROLE_LABEL[x.role] || x.role, badge(x.status), faDate(x.created_at)];
          }));
          if (!g.ok) setState(grantsBox, 'error', errText(g));
          else if (!(g.body.grants || []).length) setState(grantsBox, 'empty', 'هیچ مجوز پشتیبانی ثبت نشده است.');
          else clear(grantsBox).appendChild(table(['مدرسه', 'دامنه', 'پرونده', 'بازه', 'خواندن', 'وضعیت', 'عملیات'], g.body.grants, function (x) {
            var live = !x.revoked_at && new Date(x.ends_at).getTime() > Date.now();
            return [h('code', { title: x.tenant_id, text: shortId(x.tenant_id) }), x.scope === 'content_read' ? 'خواندن محتوا' : 'فراداده', x.case_ref || '—',
              faDate(x.starts_at) + ' تا ' + faDate(x.ends_at), faNum(x.used_reads) + ' / ' + faNum(x.max_actions),
              x.revoked_at ? h('span', { class: 'badge bad', text: 'ابطال‌شده' }) : (live ? h('span', { class: 'badge ok', text: 'فعال' }) : h('span', { class: 'badge', text: 'پایان‌یافته' })),
              caps.revokeGrant && live ? h('button', { type: 'button', class: 'btn danger', 'data-action': 'revoke-grant', 'data-grant': x.id, text: 'ابطال فوری', onclick: function () { revokeGrant(x); } }) : h('span', { text: '—' })];
          }));
          if (!caps.approveGrant) return;
          if (!a.ok) return setState(reqBox, 'error', errText(a));
          var reqs = (a.body.events || []).filter(function (e) { return e.action === 'grant.request'; });
          if (!reqs.length) return setState(reqBox, 'empty', 'درخواست تازه‌ای در دفتر ممیزی نیست.');
          clear(reqBox).appendChild(table(['زمان', 'درخواست‌دهنده', 'مدرسه', 'دلیل', 'عملیات'], reqs, function (e) {
            return [faDate(e.created_at), h('code', { text: shortId(e.actor_ref) }), h('code', { text: shortId(e.tenant_id) }), e.reason || '—',
              h('button', { type: 'button', class: 'btn primary', 'data-action': 'approve-grant', 'data-request': e.subject_ref, text: 'تأیید (چهارچشمی)', onclick: function () { approveGrant(e); } })];
          }));
          reqBox.appendChild(h('p', { class: 'notice', text: 'تأییدکننده نمی‌تواند همان درخواست‌دهنده باشد؛ سرور این قید را اعمال می‌کند.' }));
        });
      },

      reports: function (body) {
        var box = h('div'); body.appendChild(card('گزارش فراداده (فقط‌خواندنی)', [box]));
        setState(box, 'loading', 'در حال ساخت گزارش…');
        return api('GET', '/subscriptions').then(function (r) {
          if (!r.ok) return setState(box, 'error', errText(r));
          var subs = r.body.subscriptions || [];
          if (!subs.length) return setState(box, 'empty', 'داده‌ای برای گزارش نیست.');
          var byStatus = {}, byPlan = {};
          subs.forEach(function (s) { byStatus[s.status] = (byStatus[s.status] || 0) + 1; byPlan[s.plan_code] = (byPlan[s.plan_code] || 0) + 1; });
          clear(box);
          box.appendChild(h('h3', { text: 'اشتراک‌ها بر اساس وضعیت' }));
          box.appendChild(table(['وضعیت', 'تعداد'], Object.keys(byStatus).sort(), function (k) { return [badge(k), faNum(byStatus[k])]; }));
          box.appendChild(h('h3', { text: 'اشتراک‌ها بر اساس پلن' }));
          box.appendChild(table(['پلن', 'تعداد'], Object.keys(byPlan).sort(), function (k) { return [h('code', { text: k }), faNum(byPlan[k])]; }));
          box.appendChild(h('p', { class: 'notice', text: 'خروجی انبوه محتوای مدارس وجود ندارد و ساخته نمی‌شود.' }));
        });
      },

      audit: function (body) {
        var box = h('div'); body.appendChild(card('دفتر ممیزی زنجیره‌هش', [box]));
        setState(box, 'loading', 'در حال دریافت رویدادها…');
        return api('GET', '/audit').then(function (r) {
          if (!r.ok) return setState(box, 'error', errText(r));
          var ev = r.body.events || [];
          if (!ev.length) return setState(box, 'empty', 'هنوز رویدادی ثبت نشده است.');
          var broken = 0;
          for (var i = 0; i + 1 < ev.length; i++) {
            if (Number(ev[i].sequence_id) === Number(ev[i + 1].sequence_id) + 1 && ev[i].previous_hash !== ev[i + 1].event_hash) broken++;
          }
          clear(box).appendChild(h('p', null, [h('span', { class: 'badge ' + (broken ? 'bad' : 'ok'), 'data-chain': broken ? 'broken' : 'continuous',
            text: broken ? 'گسست در زنجیرهٔ هش: ' + faNum(broken) : 'پیوستگی زنجیرهٔ رویدادهای نمایش‌داده‌شده برقرار است' })]));
          box.appendChild(table(['#', 'زمان', 'عمل', 'عامل', 'موضوع', 'دلیل', 'هش'], ev, function (e) {
            return [faNum(e.sequence_id), faDate(e.created_at), h('code', { text: e.action }), h('code', { text: shortId(e.actor_ref) }),
              (e.subject_type || '') + ' ' + shortId(e.subject_ref), e.reason || '—', h('code', { title: e.event_hash || '', text: String(e.event_hash || '').slice(0, 12) })];
          }));
          box.appendChild(h('p', { class: 'notice', text: 'بررسی پیوستگی در مرورگر فقط نشانگر است؛ بازمحاسبهٔ معتبر هش در آزمون سرور انجام می‌شود.' }));
        });
      },
    };

    /* ── عملیات ─────────────────────────────────────────────────────── */
    function suspendTenant(t) {
      return confirmDialog({ title: 'تعلیق مدرسه', danger: true, submit: 'تعلیق',
        lines: ['دسترسی مدرسهٔ ' + shortId(t.tenant_id) + ' تعلیق می‌شود و رویداد در دفتر ممیزی ثبت خواهد شد.'] })
        .then(function (d) {
          if (!d) return null;
          return (pending = api('POST', '/tenants/' + encodeURIComponent(t.tenant_id) + '/suspend', { reason: d.reason, idempotency_key: requestId() })
            .then(function (r) { return afterMutation(r, 'مدرسه تعلیق شد.'); }));
        });
    }
    function deleteTenant(t) {
      return confirmDialog({ title: 'درخواست حذف مدرسه', danger: true, submit: 'ثبت درخواست حذف', retype: t.tenant_id,
        lines: [
          'حذف مدرسه چهارچشمی است: درخواست شما باید توسط مالک دیگری تأیید شود.',
          'اجرا دست‌کم ۲۴ ساعت پس از تأیید انجام می‌شود تا مدرسه مطلع شود و امکان بازگشت باشد.',
          'اجرا سرویس را متوقف و اشتراک را لغو می‌کند؛ داده دست‌کم ۱۸۰ روز نگه داشته می‌شود.',
        ] }).then(function (d) {
        if (!d) return null;
        return (pending = api('POST', '/tenants/' + encodeURIComponent(t.tenant_id) + '/deletion-request', { reason: d.reason, confirm_tenant_id: t.tenant_id })
          .then(function (r) { return afterMutation(r, 'درخواست حذف ثبت شد؛ منتظر تأیید مالک دیگر.'); }));
      });
    }
    function approveDeletion(x) {
      return confirmDialog({ title: 'تأیید حذف مدرسه (مالک دوم)', danger: true, submit: 'تأیید', retype: x.tenant_id,
        lines: ['با تأیید شما، اجرای حذف مدرسهٔ ' + shortId(x.tenant_id) + ' زودتر از ۲۴ ساعت بعد ممکن نیست.', 'دلیل درخواست: ' + (x.reason || '—')] })
        .then(function (d) {
          if (!d) return null;
          return (pending = api('POST', '/tenant-deletions/' + encodeURIComponent(x.id) + '/approve', { reason: d.reason })
            .then(function (r) { return afterMutation(r, 'حذف تأیید شد؛ اجرا پس از ۲۴ ساعت ممکن است.'); }));
        });
    }
    function cancelDeletion(x) {
      return confirmDialog({ title: 'لغو درخواست حذف', submit: 'لغو درخواست',
        lines: ['درخواست حذف مدرسهٔ ' + shortId(x.tenant_id) + ' بسته می‌شود و اشتراک دست‌نخورده می‌ماند.'] })
        .then(function (d) {
          if (!d) return null;
          return (pending = api('POST', '/tenant-deletions/' + encodeURIComponent(x.id) + '/cancel', { reason: d.reason })
            .then(function (r) { return afterMutation(r, 'درخواست حذف لغو شد.'); }));
        });
    }
    function executeDeletion(x) {
      return confirmDialog({ title: 'اجرای حذف مدرسه', danger: true, submit: 'اجرا', retype: x.tenant_id,
        lines: ['سرویس مدرسهٔ ' + shortId(x.tenant_id) + ' متوقف و اشتراک‌هایش لغو می‌شود.', 'داده دست‌کم ۱۸۰ روز نگه داشته می‌شود؛ نابودی نهایی خارج از این پنل و با تأیید مالک است.'] })
        .then(function (d) {
          if (!d) return null;
          return (pending = api('POST', '/tenant-deletions/' + encodeURIComponent(x.id) + '/execute', { reason: d.reason })
            .then(function (r) { return afterMutation(r, 'حذف اجرا شد؛ سرویس متوقف و داده نگه داشته شد.'); }));
        });
    }
    function renew(s) {
      var days = h('input', { class: 'input', id: 'dlg-days', inputmode: 'numeric', value: '30', dir: 'ltr' });
      return confirmDialog({ title: 'تمدید اشتراک', submit: 'تمدید',
        lines: ['اشتراک مدرسهٔ ' + shortId(s.tenant_id) + ' (پلن ' + (s.plan_code || '—') + ') تمدید می‌شود.'],
        fields: [{ name: 'days', el: h('div', null, [h('label', { for: 'dlg-days', text: 'تعداد روز' }), days]), read: function () { return Number(normDigits(days.value)); } }],
        validate: function (v) { return Number.isInteger(v.days) && v.days >= 1 && v.days <= 366 ? null : 'تعداد روز باید بین ۱ و ۳۶۶ باشد.'; },
      }).then(function (d) {
        if (!d) return null;
        return (pending = api('POST', '/subscriptions/' + encodeURIComponent(s.id) + '/renew', { reason: d.reason, extend_days: d.values.days, idempotency_key: requestId() })
          .then(function (r) { return afterMutation(r, 'اشتراک تمدید شد.'); }));
      });
    }
    function createPlan() {
      var code = h('input', { class: 'input', id: 'dlg-code', dir: 'ltr' });
      var name = h('input', { class: 'input', id: 'dlg-name' });
      var mb = h('input', { class: 'input', id: 'dlg-mb', inputmode: 'numeric', dir: 'ltr', value: '1024' });
      return confirmDialog({ title: 'پلن جدید', submit: 'ثبت پلن',
        fields: [
          { name: 'code', el: h('div', null, [h('label', { for: 'dlg-code', text: 'کد پلن (لاتین)' }), code]), read: function () { return String(code.value || '').trim(); } },
          { name: 'name', el: h('div', null, [h('label', { for: 'dlg-name', text: 'نام' }), name]), read: function () { return String(name.value || '').trim(); } },
          { name: 'mb', el: h('div', null, [h('label', { for: 'dlg-mb', text: 'فضا (مگابایت)' }), mb]), read: function () { return Number(normDigits(mb.value)); } },
        ],
        validate: function (v) { return /^[a-z0-9_-]{2,40}$/.test(v.code) && v.name && v.mb >= 0 ? null : 'کد، نام و فضا را درست وارد کنید.'; },
      }).then(function (d) {
        if (!d) return null;
        return (pending = api('POST', '/plans', { code: d.values.code, name: d.values.name, storage_mb: d.values.mb, reason: d.reason })
          .then(function (r) { return afterMutation(r, 'پلن ثبت شد.'); }));
      });
    }
    function createUser() {
      var login = h('input', { class: 'input', id: 'dlg-login', dir: 'ltr' });
      var role = h('select', { class: 'input', id: 'dlg-role' }, Object.keys(ROLE_LABEL).map(function (k) { return h('option', { value: k, text: ROLE_LABEL[k] }); }));
      return confirmDialog({ title: 'کاربر جدید پلتفرم', submit: 'ثبت',
        fields: [
          { name: 'login_id', el: h('div', null, [h('label', { for: 'dlg-login', text: 'شناسهٔ ورود' }), login]), read: function () { return String(login.value || '').trim(); } },
          { name: 'role', el: h('div', null, [h('label', { for: 'dlg-role', text: 'نقش' }), role]), read: function () { return role.value; } },
        ],
        validate: function (v) { return v.login_id ? null : 'شناسهٔ ورود را وارد کنید.'; },
      }).then(function (d) {
        if (!d) return null;
        return (pending = api('POST', '/platform-users', { login_id: d.values.login_id, role: d.values.role, reason: d.reason })
          .then(function (r) { return afterMutation(r, 'کاربر ثبت شد.'); }));
      });
    }
    function requestGrant() {
      var tenant = h('input', { class: 'input', id: 'dlg-tenant', dir: 'ltr', placeholder: 'UUID مدرسه' });
      var scope = h('select', { class: 'input', id: 'dlg-scope' }, [h('option', { value: 'metadata', text: 'فراداده' }), h('option', { value: 'content_read', text: 'خواندن محتوا (تک‌رکورد)' })]);
      var caseRef = h('input', { class: 'input', id: 'dlg-case', dir: 'ltr' });
      var notified = h('input', { class: 'input', id: 'dlg-notified', type: 'datetime-local', dir: 'ltr' });
      var hours = h('input', { class: 'input', id: 'dlg-hours', inputmode: 'numeric', dir: 'ltr', value: '4' });
      var startIn = h('input', { class: 'input', id: 'dlg-start', type: 'datetime-local', dir: 'ltr' });
      function iso(v) { var d = new Date(v); return isNaN(d.getTime()) ? '' : d.toISOString(); }
      return confirmDialog({ title: 'درخواست مجوز پشتیبانی', submit: 'ارسال برای تأیید مالک',
        lines: ['مجوز تنها پس از تأیید یک مالک دیگر فعال می‌شود، حداکثر ۷۲ ساعت اعتبار دارد و قابل تمدید نیست.'],
        fields: [
          { name: 'tenant_id', el: h('div', null, [h('label', { for: 'dlg-tenant', text: 'شناسهٔ مدرسه' }), tenant]), read: function () { return String(tenant.value || '').trim(); } },
          { name: 'scope', el: h('div', null, [h('label', { for: 'dlg-scope', text: 'دامنه' }), scope]), read: function () { return scope.value; } },
          { name: 'case_ref', el: h('div', null, [h('label', { for: 'dlg-case', text: 'شمارهٔ پرونده' }), caseRef]), read: function () { return String(caseRef.value || '').trim(); } },
          { name: 'notified', el: h('div', null, [h('label', { for: 'dlg-notified', text: 'زمان واقعی اطلاع‌رسانی به مدرسه' }), notified]), read: function () { return iso(notified.value); } },
          { name: 'starts', el: h('div', null, [h('label', { for: 'dlg-start', text: 'شروع مجوز' }), startIn]), read: function () { return iso(startIn.value); } },
          { name: 'hours', el: h('div', null, [h('label', { for: 'dlg-hours', text: 'مدت (ساعت، حداکثر ۷۲)' }), hours]), read: function () { return Number(normDigits(hours.value)); } },
        ],
        validate: function (v) {
          if (!UUID_RE.test(v.tenant_id)) return ERRORS.invalid_tenant_id;
          if (!v.case_ref) return 'شمارهٔ پرونده را وارد کنید.';
          if (!v.notified || !v.starts) return 'زمان اطلاع‌رسانی و شروع را وارد کنید.';
          if (new Date(v.notified).getTime() >= new Date(v.starts).getTime()) return 'مدرسه باید پیش از شروع مجوز مطلع شده باشد.';
          if (!(v.hours >= 1 && v.hours <= 72)) return 'مدت باید بین ۱ تا ۷۲ ساعت باشد.';
          return null;
        },
      }).then(function (d) {
        if (!d) return null;
        var v = d.values;
        var ends = new Date(new Date(v.starts).getTime() + v.hours * 3600000).toISOString();
        return (pending = api('POST', '/support-grants', { tenant_id: v.tenant_id, scope: v.scope, case_ref: v.case_ref, reason: d.reason,
          school_notified_at: v.notified, starts_at: v.starts, ends_at: ends, max_actions: 3 })
          .then(function (r) { return afterMutation(r, 'درخواست مجوز ثبت شد و منتظر تأیید مالک است.'); }));
      });
    }
    function approveGrant(e) {
      return confirmDialog({ title: 'تأیید درخواست مجوز', submit: 'تأیید',
        lines: ['درخواست ' + shortId(e.subject_ref) + ' برای مدرسهٔ ' + shortId(e.tenant_id) + ' تأیید می‌شود.'] })
        .then(function (d) {
          if (!d) return null;
          return (pending = api('POST', '/support-grants/' + encodeURIComponent(e.subject_ref) + '/approve', { reason: d.reason })
            .then(function (r) { return afterMutation(r, 'درخواست تأیید شد.'); }));
        });
    }
    function revokeGrant(g) {
      return confirmDialog({ title: 'ابطال فوری مجوز', danger: true, submit: 'ابطال',
        lines: ['مجوز ' + shortId(g.id) + ' بلافاصله باطل می‌شود.'] })
        .then(function (d) {
          if (!d) return null;
          return (pending = api('POST', '/support-grants/' + encodeURIComponent(g.id) + '/revoke', { reason: d.reason })
            .then(function (r) { return afterMutation(r, 'مجوز باطل شد.'); }));
        });
    }

    function start() {
      applyTheme(themeMode());
      if (opts.session) setSession(opts.session);
      var m = /^#\/([a-z]+)/.exec(String((win.location && win.location.hash) || ''));
      if (m) current = m[1];
      win.addEventListener('hashchange', function () {
        var mm = /^#\/([a-z]+)/.exec(String(win.location.hash || ''));
        if (mm && mm[1] !== current && session) show(mm[1]);
      });
      return show(current);
    }

    return {
      start: start, show: show, logout: logout, setSession: setSession, applyTheme: applyTheme,
      idle: function () { return pending; },
      get session() { return session ? { sub: session.sub, role: session.role, exp: session.exp } : null; },
    };
  }

  var OwnerPanel = { createApp: createApp, CAPS: CAPS, PAGES: PAGES, ERRORS: ERRORS, ROLE_LABEL: ROLE_LABEL,
    capsFor: capsFor, decodeClaims: decodeClaims, faDate: faDate, faNum: faNum, API: API };
  global.OwnerPanel = OwnerPanel;
  if (typeof module === 'object' && module && module.exports) module.exports = OwnerPanel;

  if (global.document && !global.OWNER_PANEL_NO_AUTOBOOT) {
    var boot = function () {
      if (!global.document.getElementById('app')) return;
      createApp({ document: global.document, window: global, fetch: global.fetch.bind(global) }).start();
    };
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
