/* ═══════════════════════════════════════════════════════════════════
   پایش-لوکال — نماها (بدون چارچوب)
   هر تابع یک رشتهٔ HTML برمی‌گرداند. کنش‌ها با data-act مدیریت می‌شوند.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const PAGES = {};
window.PAGES = PAGES;

/* ── اجزای کوچک ─────────────────────────────────────────────────── */
function pageHead(title, sub, actions) {
  return `<div class="topbar">
    <div><h2>${esc(title)}</h2>${sub ? `<div class="small muted">${esc(sub)}</div>` : ''}</div>
    <div class="row no-print">${actions || ''}</div>
  </div>`;
}
function card(body, cls = '') { return `<div class="card ${cls}">${body}</div>`; }
function empty(msg) { return `<div class="card center muted" style="padding:26px">${esc(msg)}</div>`; }
function badge(text, kind = '') { return `<span class="badge ${kind}">${esc(text)}</span>`; }

const ROLE_FA = {
  manager: 'مدیر', vice: 'معاون', teacher: 'دبیر', parent: 'ولی', student: 'دانش‌آموز',
  counselor: 'مشاور', staff: 'کارمند', office: 'اجرایی', guard: 'نگهبان',
};

/* حالت گوشی/بدون سرور (در app.js تعریف می‌شود) */
function isPhoneMode() { return typeof PHONE_MODE !== 'undefined' && PHONE_MODE; }

function navConfig(role) {
  const base = [];
  if (role === 'manager') {
    base.push(['home', '🏠', 'داشبورد'], ['users', '👥', 'کاربران'], ['followup', '⚠️', 'پیگیری'], ['classes', '🏛️', 'کلاس‌ها'],
      ['schedule', '🗓️', 'برنامه'], ['attendance-report', '✅', 'حضور'], ['reports', '📑', 'گزارش‌ها'],
      ['announcements', '📢', 'اطلاعیه‌ها'], ['health', '🩺', 'سلامت'], ['network', '🌐', 'شبکه'],
      ['cloud', '☁️', 'حافظهٔ ابری'], ['system', '⚙️', 'سیستم']);
  } else if (role === 'teacher') {
    base.push(['home', '🏠', 'امروز'], ['schedule', '🗓️', 'برنامه'], ['attendance', '✅', 'حضور'], ['grades', '📝', 'نمره'],
      ['students', '👥', 'دانش‌آموزان'], ['announcements', '📢', 'اطلاعیه‌ها'], ['system', '⚙️', 'سیستم']);
  } else if (role === 'parent') {
    base.push(['home', '👨‍👩‍👦', 'فرزندان'], ['schedule', '🗓️', 'برنامه'], ['leaves', '📨', 'مرخصی'], ['announcements', '📢', 'اطلاعیه‌ها'], ['system', '⚙️', 'سیستم']);
  } else if (role === 'student') {
    base.push(['home', '🏠', 'خانه'], ['schedule', '🗓️', 'برنامه'], ['record', '📁', 'پرونده'], ['announcements', '📢', 'اطلاعیه‌ها'], ['system', '⚙️', 'سیستم']);
  } else {
    base.push(['home', '🏠', 'خانه'], ['announcements', '📢', 'اطلاعیه‌ها'], ['system', '⚙️', 'سیستم']);
  }
  /* روی گوشی «شبکه» و «حافظهٔ ابری» معنا ندارد (سروری در کار نیست) */
  if (isPhoneMode()) return base.filter(([r]) => r !== 'network' && r !== 'cloud');
  return base;
}

/* نوار همیشگیِ بالای برنامه: نسخه + چراغ وضعیت (سبز = به‌روز، کهربایی = نسخهٔ تازه،
   آبی = در حال دانلود) — همان چیزی که در نسخهٔ کامل بالای صفحه دیده می‌شود. */
function updateBarHtml() {
  const cur = (S.server && S.server.version) || (typeof CLIENT_VERSION !== 'undefined' ? CLIENT_VERSION : '');
  const st = S.upd || {};
  const busy = st.status === 'downloading' || st.status === 'installing';
  const ready = st.status === 'ready';
  const avail = !!(S.remote && S.remote.available);
  const latest = st.latest || (S.remote && (S.remote.remote_version || S.remote.version)) || '';
  const dot = busy ? '#2563eb' : (ready || avail) ? '#f59e0b' : '#16a34a';
  const text = busy ? ('در حال دانلود ' + fa(st.percent || 0) + '٪')
    : ready ? ('نسخهٔ ' + esc(latest) + ' آمادهٔ نصب است')
    : avail ? ('نسخهٔ تازهٔ ' + esc(latest) + ' موجود است')
    : 'برنامه به‌روز است';
  const isManager = S.role === 'manager';
  const bundled = typeof BUNDLED !== 'undefined' && BUNDLED;
  if (busy || ready) {
    const body = updateBarBody();
    if (body) return body;
  }
  return `<div class="updbar" id="update-bar" dir="rtl">
    <span class="upd-dot" style="background:${dot}" title="${esc(text)}"></span>
    <span class="small"><b class="ltr">v${esc(cur)}</b> — ${text}</span>
    ${isManager && !bundled && (avail || ready)
      ? `<button class="btn xs primary" data-act="${ready ? 'update-install' : 'update-now'}">${ready ? 'نصب و راه‌اندازی دوباره' : 'دانلود و نصب'}</button>`
      : ''}
    ${isManager && !bundled && !avail && !ready && !busy
      ? `<button class="btn xs ghost" data-act="update-recheck">بررسی آپدیت</button>`
      : ''}
  </div>`;
}

function shellHtml(view) {
  const role = S.role || 'student';
  const nav = navConfig(role);
  const mkNav = (mobile) => nav.map(([r, ico, label]) => {
    const on = S.route === r || (r === 'home' && ['home', 'child', 'record'].includes(S.route));
    return mobile
      ? `<a class="bn ${on ? 'on' : ''}" href="#/${r}"><span class="ico">${ico}</span>${esc(label)}</a>`
      : `<a class="navitem ${on ? 'on' : ''}" href="#/${r}"><span>${ico}</span>${esc(label)}</a>`;
  }).join('');
  return `
  <div class="shell">
    <aside class="sidebar">
      <div class="brand"><span style="font-size:22px">📘</span><span>پایش-لوکال</span></div>
      <div class="small muted" style="margin-bottom:10px">${esc((S.server.school && S.server.school.name) || '')}</div>
      ${nav.slice(0, 1).map(() => '').join('')}
      ${mkNav(false)}
      <div class="navgroup">حساب</div>
      <div class="small muted" style="padding:6px">${esc(S.user ? S.user.name : '')} · ${esc(ROLE_FA[role] || role)}</div>
    </aside>
    <main class="main">${canonicalBarHtml()}${updateBarHtml()}${offlineBarHtml()}${view}</main>
  </div>
  <nav class="bottomnav">${mkNav(true)}</nav>`;
}

/* نوار آدرس عمومی:
   اگر آدرس ثابتِ کارآمدی ثبت نشده، مدیر یک یادآوری کوچک می‌بیند (قابل بستن). */
function canonicalBarHtml() {
  /* روی گوشی هیچ آدرس/شبکه‌ای در کار نیست — هیچ نواری نشان نمی‌دهیم */
  if (typeof PHONE_MODE !== 'undefined' && PHONE_MODE) return '';
  const pub = S.server && S.server.publicUrl;
  if (pub) {
    try { if (location.origin === new URL(pub).origin) return ''; } catch (e) { return ''; }
    if (localStorage.getItem('payesh.originbar.off') === pub) return '';
    return `<div class="banner warn" id="origin-bar">
      <div>🌐 آدرس رسمی برنامه این است؛ با همان هم می‌توانید از هر اینترنتی وارد شوید:
        <span class="ltr small" style="font-weight:700">${esc(pub.replace(/^https?:\/\//, ''))}</span></div>
      <button class="btn sm primary" data-act="transfer">انتقال به آدرس رسمی</button>
    </div>`;
  }
  if (S.role !== 'manager') return '';
  /* هیچ پیام «فقط شبکهٔ مدرسه» نداریم: هر دستگاه خودش کار می‌کند و حافظهٔ
     مشترک ابری همه‌جا در دسترس است. فقط اگر خودِ حافظه تنظیم نشده باشد،
     یک یادآوری کوچک با دکمهٔ تنظیم خودکار نشان می‌دهیم. */
  if (S.server && S.server.cloudReady) return '';
  if (localStorage.getItem('payesh.originbar.off') === 'none') return '';
  return `<div class="banner warn" id="origin-bar">
    <div>☁️ حافظهٔ مشترک ابری هنوز آماده نیست — با یک کلیک خودکار تنظیم می‌شود؛ بعد از آن گوشی و خانه هم به همه‌چیز دسترسی دارند.</div>
    <button class="btn sm primary" data-act="cloud-phone-check">تنظیم خودکار</button>
    <button class="btn sm ghost" data-act="originbar-off">بستن</button>
  </div>`;
}

/* نوار آپدیت:
   ۱) اگر نسخهٔ تازه‌ای در مخزن منتشر شده (S.remote) — مدیر با یک کلیک همان
      بخش‌های تغییرکرده را روی خود سیستم می‌نشاند.
   ۲) وگرنه اگر فایل‌های همین دستگاه با سرور فرق دارند (S.update) — دلتای
      مرورگر اعمال می‌شود. */
function updateBarBody() {
  /* در نسخهٔ بسته‌بندی‌شده (APK) فایل‌ها داخل خود برنامه‌اند؛ آپدیت با نصب APK تازه است */
  if (typeof BUNDLED !== 'undefined' && BUNDLED) return '';
  const r = S.remote;
  const st = S.upd;
  /* حین دانلود، نوار پیشرفت نشان داده می‌شود (مثل k3-reval) */
  if (st && (st.status === 'downloading' || st.status === 'installing')) {
    const pct = Math.max(0, Math.min(100, Number(st.percent) || 0));
    return `<div class="banner info" id="update-bar">
      <div style="flex:1;min-width:200px">
        <div>⬇️ ${st.status === 'installing' ? 'در حال نصب نسخهٔ' : 'در حال دانلود نسخهٔ'} <b>${esc(st.latest || '')}</b>
          ${st.totalKb ? ' — ' + fa(st.receivedKb || 0) + ' از ' + fa(st.totalKb) + ' کیلوبایت' : ''}</div>
        <div style="height:8px;background:#e5e7eb;border-radius:999px;overflow:hidden;margin-top:6px">
          <div style="width:${pct}%;height:100%;background:#6366f1;transition:width .3s"></div></div>
      </div>
      <span class="small" style="font-weight:700">${fa(pct)}٪</span>
    </div>`;
  }
  if (st && st.status === 'ready') {
    return `<div class="banner info" id="update-bar">
      <div>✅ نسخهٔ <b>${esc(st.latest)}</b> دانلود شد و آمادهٔ نصب است${st.mode === 'patch' && st.savedMb ? ` — ${fa(st.savedMb)} مگابایت کم‌تر از نصب کامل` : ''}</div>
      <button class="btn sm primary" data-act="update-install">نصب و راه‌اندازی دوباره</button>
      <button class="btn sm ghost" data-act="update-later">بعداً</button>
    </div>`;
  }
  if (r && r.available && !isUpdateDismissed(r.remote_version)) {
    const kb = Math.max(1, Math.round((r.total_size || 0) / 1024));
    const n = (r.changed || []).length;
    const bits = [];
    if (r.counts && r.counts.client) bits.push(`${fa(r.counts.client)} فایل رابط`);
    if (r.counts && r.counts.server) bits.push(`${fa(r.counts.server)} فایل برنامه`);
    const saved = st && st.mode === 'patch' && st.savedMb ? ` · ${fa(st.savedMb)} مگابایت کم‌تر از نصب کامل` : '';
    return `<div class="banner info" id="update-bar">
      <div>🎁 نسخهٔ <b>${esc(r.remote_version)}</b> منتشر شده — فقط ${fa(n)} فایل تغییر کرده (${fa(kb)} کیلوبایت${bits.length ? ' · ' + bits.join('، ') : ''})${saved}</div>
      <button class="btn sm primary" data-act="update-now">دانلود و نصب (یک کلیک)</button>
      <button class="btn sm ghost" data-act="update-later">بعداً</button>
    </div>`;
  }
  if (!S.update) return '';
  const n = (S.update.changed || []).length;
  const kb = Math.round((S.update.total_size || 0) / 1024);
  return `<div class="banner info" id="update-bar">
    <div>🎁 نسخهٔ <b>${esc(S.update.version)}</b> آماده است — ${fa(n)} فایل تغییر کرده (${fa(kb)} کیلوبایت)</div>
    <button class="btn sm primary" data-act="update-apply">به‌روزرسانی</button>
  </div>`;
}
function isUpdateDismissed(version) {
  try { return localStorage.getItem('payesh.upd.dismiss') === String(version); } catch (e) { return false; }
}
function offlineBarHtml() {
  if (S.online) return '';
  const q = S.queue.length;
  if (S.offline) {
    return `<div class="banner warn">📴 سیستم مدرسه در دسترس نیست — همهٔ فایل‌های برنامه روی همین دستگاه است و آخرین اطلاعات نمایش داده می‌شود.
      ${q ? `${fa(q)} تغییر در صف مانده و با اولین اتصال ارسال می‌شود.` : ''}
      <button class="btn sm ghost" data-act="retry">اتصال دوباره</button></div>`;
  }
  return `<div class="banner warn">📴 آفلاین هستید — برنامه کار می‌کند و ${fa(q)} تغییر در صف است. با وصل شدن شبکه خودکار ارسال می‌شود.</div>`;
}
function updateTopChrome() {
  const bar = $('#update-bar');
  const html = updateBarHtml();
  if (bar) { bar.outerHTML = html || '<div id="update-bar" hidden></div>'; return; }
  if (html) {
    const main = $('.main');
    if (main) main.insertAdjacentHTML('afterbegin', html);
  }
}


/* جایگزینی صفحه با نگه‌داشتن فوکوس و صفحه‌کلید (تنها یک نسخه در app.js هست،
   ولی صفحه‌های ورود این‌جا ساخته می‌شوند؛ پس هر دو مسیر از همین می‌گذرند) */
function setApp(html) {
  const root = $('#app');
  if (!root) return;
  const snap = (typeof focusSnapshot === 'function') ? focusSnapshot() : null;
  root.innerHTML = html;
  if (snap && typeof focusRestore === 'function') focusRestore(snap);
}

/* ══════════════ صفحه‌های ورود ══════════════ */
function renderSetup() {
  setApp(`
  <div class="auth">
    <div class="logo">پ</div>
    <h1>راه‌اندازی پایش-لوکال</h1>
    <div class="sub">این فرم فقط یک‌بار پر می‌شود؛ بعد از آن همیشه صفحهٔ ورود می‌آید.</div>
    <form data-form="setup" class="card">
      <label class="field"><span>نام مدرسه</span><input class="input" name="school_name" required placeholder="دبیرستان کاردانش ..."></label>
      <div class="row">
        <label class="field grow"><span>نوع مدرسه</span>
          <select class="input" name="school_type">
            <option>کاردانش</option><option>فنی و حرفه‌ای</option><option>متوسطه دوم</option>
            <option>متوسطه اول</option><option>ابتدایی</option>
          </select></label>
        <label class="field grow"><span>سال تحصیلی</span><input class="input" name="school_year" value="۱۴۰۵–۱۴۰۶"></label>
      </div>
      <label class="field"><span>نام مدیر</span><input class="input" name="manager_name" required placeholder="نام و نام خانوادگی"></label>
      <label class="field"><span>شمارهٔ همراه مدیر (نام کاربری ورود)</span><input class="input ltr" name="phone" inputmode="numeric" data-digits placeholder="09xxxxxxxxx"></label>
      <label class="field"><span>رمز عبور مدیر</span><input class="input ltr" type="password" name="password" minlength="4" required autocomplete="new-password" placeholder="حداقل ۴ نویسه"></label>
      <label class="field"><span>تکرار رمز عبور</span><input class="input ltr" type="password" name="password2" minlength="4" required autocomplete="new-password"></label>
      <label class="field"><span>PIN سریع برای این دستگاه (اختیاری، ۴ تا ۶ رقم)</span><input class="input pin-input" name="pin" inputmode="numeric" maxlength="6" data-digits placeholder="••••"></label>
      <button class="btn primary block" type="submit">ایجاد مدرسه</button>
      <p class="small muted center" style="margin-top:10px">بعد از این، با «شمارهٔ همراه + رمز عبور» وارد می‌شوید.</p>
    </form>
    <div class="card tight small muted center">
      محل ذخیرهٔ داده: <span class="ltr">${esc((S.server && S.server.dataDir) || '—')}</span>
      ${S.deviceToken ? '<div style="margin-top:6px;color:#b45309">این دستگاه قبلاً به مدرسه وصل بوده باشد؛ اگر دادهٔ قبلی را می‌خواهید، پیش از ساخت مدرسهٔ تازه به مدیر اطلاع دهید.</div>' : ''}
    </div>
  </div>`)
}

function claimCard() {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(location.host || '');
  if (!local) return '';
  if (!(S.server && S.server.setupDone)) return '';
  const noPassword = S.server.hasPassword === false;
  /* پیش‌فرض: اگر رمزی وجود دارد، فقط یک لینک کم‌رنگ؛ اگر ندارد، فرم باز */
  if (!noPassword && !S.claimOpen) {
    return `<p class="small center" style="margin-top:8px"><a href="#" data-act="claim-open">رمز عبور را نمی‌دانم (فقط روی همین رایانه)</a></p>`;
  }
  return `
    <form data-form="claim" class="card">
      <div class="card-title">${noPassword ? 'حساب مدیر هنوز رمز عبور ندارد' : 'تعیین رمز تازهٔ مدیر'}</div>
      <p class="small muted">چون این رایانه خودِ رایانهٔ مدرسه است، از همین‌جا رمز مدیر را می‌سازید و بلافاصله وارد می‌شوید. از گوشی‌های دیگر این کار ممکن نیست.</p>
      <label class="field"><span>شمارهٔ همراه مدیر</span>
        <input class="input ltr" name="phone" inputmode="numeric" data-digits placeholder="09xxxxxxxxx" value="${esc(S.claimPhone || '')}"></label>
      <label class="field"><span>رمز عبور تازه</span>
        <input class="input ltr" type="password" name="password" autocomplete="new-password" placeholder="••••"></label>
      <button class="btn primary block" type="submit">ساختن رمز و ورود</button>
    </form>`;
}

function renderPair() {
  const href = location.hash;
  const m = href.match(/#\/join\/([A-Za-z0-9-]+)/);
  const pre = m ? m[1].toUpperCase() : '';
  /* پیش‌فرض همیشه «شمارهٔ همراه + رمز عبور»؛ کد پیوند فقط راهِ سریعِ فرعی است */
  let mode = 'password';
  if (pre) mode = 'pair';
  else if (S.loginMode) mode = S.loginMode;
  else if (S.server && S.server.setupDone && S.server.hasPassword === false) mode = 'pair';
  const body = mode === 'pair' ? `
      <label class="field"><span>کد پیوند</span>
        <input class="input code-input" name="code" value="${esc(pre)}" maxlength="12" placeholder="XXXX-XXXX" autocomplete="off"></label>
      <label class="field"><span>PIN انتخابی شما (۴ تا ۶ رقم)</span>
        <input class="input pin-input" name="pin" inputmode="numeric" maxlength="6" data-digits placeholder="••••" autocomplete="off"></label>
      <button class="btn primary block" type="submit">ورود و ثبت این دستگاه</button>
      <p class="small muted center" style="margin-top:10px">این کد را مدیرِ مدرسه از صفحهٔ «کاربران» → دکمهٔ «کارت پیوند» برای شما چاپ می‌کند.<br>کد فقط برای همین یک‌بار است و ۷ روز اعتبار دارد.</p>
      <p class="small center" style="margin-top:6px"><a href="#" data-act="login-mode" data-id="password">ورود با شمارهٔ همراه و رمز عبور</a></p>`
    : `
      <label class="field"><span>شمارهٔ همراه (یا کد ملی)</span>
        <input class="input ltr" name="phone" inputmode="numeric" data-digits data-focus-key="phone"
          autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false"
          maxlength="11" placeholder="09xxxxxxxxx" autofocus></label>
      <label class="field"><span>رمز عبور</span>
        <input class="input ltr" type="password" name="password" data-focus-key="password"
          autocomplete="new-password" autocorrect="off" autocapitalize="none" spellcheck="false" placeholder="••••••"></label>
      <button class="btn primary block" type="submit">ورود</button>
      <p class="small muted center" style="margin-top:10px">نام کاربری شما شمارهٔ همراهتان است و رمز، کد ملی؛ اگر شمارهٔ همراه ندارید، با کد ملی وارد شوید.</p>
      <p class="small center" style="margin-top:6px"><a href="#" data-act="login-mode" data-id="pair">ورود با کارت پیوند (بدون رمز)</a></p>`;

  setApp(`
  <div class="auth">
    <div class="logo">پ</div>
    <h1>ورود به پایش</h1>
    <div class="sub">${S.server.school ? esc(S.server.school) : 'سامانهٔ مدرسه'}</div>
    <form data-form="${mode === 'pair' ? 'pair' : 'login'}" class="card" autocomplete="off">${body}</form>
    ${claimCard()}
    <div class="card tight small muted">
      سرور: <span class="ltr">${esc(location.host)}</span> · نسخه ${esc(S.server.version || '')}
      ${S.user ? '' : `<br><a href="#" data-act="forget-device">دستگاه دیگری انتخاب شود</a>`}
    </div>
  </div>`)
}

function renderTransfer(code) {
  setApp(`
  <div class="auth">
    <div class="logo">پ</div>
    <h1>انتقال به آدرس رسمی</h1>
    <div class="sub">برای ادامه روی این دستگاه یک PIN تازه انتخاب کنید</div>
    <form data-form="transfer" class="card">
      <input type="hidden" name="code" value="${esc(code)}">
      <label class="field"><span>PIN (۴ تا ۶ رقم)</span>
        <input class="input pin-input" name="pin" inputmode="numeric" maxlength="6" placeholder="••••" autocomplete="new-password"></label>
      <button class="btn primary block" type="submit">فعال‌سازی روی این آدرس</button>
      <p class="small muted center" style="margin-top:10px">همین PIN را فردا برای ورود به برنامه می‌زنید.</p>
    </form>
    <div class="card tight small muted center">
      <a href="#/" data-act="forget-device">انصراف</a>
    </div>
  </div>`)
}

function renderLock() {
  const pw = (S.unlockMode || localStorage.getItem('payesh.authmode')) === 'password';
  const user = (localStorage.getItem('payesh.lastname') || '');
  setApp(`
  <div class="auth">
    <div class="logo">پ</div>
    <h1>پایش</h1>
    <div class="sub">${user ? esc(user) + ' — ' : ''}${pw ? 'رمز عبور خود را وارد کنید' : 'PIN خود را وارد کنید'}</div>
    <form data-form="unlock" class="card">
      ${pw
        ? `<label class="field"><input class="input ltr" type="password" name="password" autocomplete="current-password" placeholder="رمز عبور" autofocus></label>`
        : `<label class="field"><input class="input pin-input" name="pin" inputmode="numeric" maxlength="6" data-digits placeholder="••••" autofocus></label>`}
      <button class="btn primary block" type="submit">ورود</button>
    </form>
    <div class="center small">
      <a href="#" data-act="unlock-mode" data-id="${pw ? 'pin' : 'password'}">${pw ? 'ورود با PIN' : 'ورود با رمز عبور'}</a>
    </div>
    <div class="center" style="margin-top:8px"><a href="#" class="small" data-act="forget-device">این دستگاه من نیست</a></div>
  </div>`)
}

/* صفحهٔ ورود «بدون سرور»: روی گوشی و هر رایانه‌ای که به سیستم مدرسه
   دسترسی ندارد، همین صفحه می‌آید — نه پیام بن‌بست «سرور در دسترس نیست». */
/* نسخهٔ نصب‌شده — برای اینکه کاربر بداند نسخهٔ تازه روی گوشی است یا نه */
function buildStamp() {
  const v = (typeof CLIENT_VERSION !== 'undefined' && CLIENT_VERSION) || '';
  const b = (typeof window !== 'undefined' && window.PAYESH_BUILD) || '';
  return (v ? 'نسخهٔ ' + fa(v) : '') + (b && b.indexOf(v) !== 0 ? ' · ساخت ' + b : '');
}

function renderPhoneLogin(force) {
  /* اگر همین صفحه روی نمایش است، دوباره نساز: بازسازیِ نابهنگام، فوکوس را
     می‌برد و صفحه‌کلید گوشی بسته می‌شود. */
  if (!force && document.querySelector('form[data-form="phone-login"]')) return;
  const last = (window.PayeshPhone && window.PayeshPhone.lastUser && window.PayeshPhone.lastUser()) || null;
  const cloud = (window.PayeshPhone && window.PayeshPhone.storedConfig
      && (window.PayeshPhone.storedConfig() || window.PayeshPhone.bakedConfig()))
    || window.PAYESH_CLOUD || {};
  const cloudLine = cloud.endpoint
    ? `حافظهٔ مشترک: <span class="ltr">${esc(String(cloud.endpoint).replace(/^https?:\/\//, ''))}</span>` +
      (cloud.bucket ? ` · صندوقچه <span class="ltr">${esc(cloud.bucket)}</span>` : ' · صندوقچه خودکار')
    : 'حافظهٔ مشترک در برنامه تنظیم نشده';
  setApp(`
  <div class="auth">
    <div class="logo">پ</div>
    <h1>ورود به پایش</h1>
    <div class="sub">شمارهٔ همراه (یا کد ملی) و رمزی که مدیر مدرسه برایتان ساخته است</div>
    <form data-form="phone-login" class="card" autocomplete="off">
      <label class="field"><span>شمارهٔ همراه (یا کد ملی)</span>
        <input class="input ltr" name="phone" data-focus-key="phone" inputmode="numeric"
          autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false"
          maxlength="11" placeholder="09xxxxxxxxx" value="${esc((last && last.phone) || '')}"></label>
      <label class="field"><span>رمز عبور</span>
        <input class="input ltr" type="password" name="password" data-focus-key="password"
          autocomplete="new-password" autocorrect="off" autocapitalize="none" spellcheck="false"
          placeholder="رمز عبور"></label>
      <button class="btn primary block" type="submit">ورود</button>
      <div class="small muted center" style="margin-top:10px">
        اولین بار کمی طول می‌کشد (اطلاعات از حافظهٔ مدرسه خوانده می‌شود).<br>
        پس از اولین ورود، هر بار بدون اینترنت هم برنامه باز می‌شود.
      </div>
      <div class="small muted center" style="margin-top:6px;font-size:11px">${cloudLine}</div>
      <div class="small muted center" style="margin-top:2px;font-size:10px;opacity:.75">${esc(buildStamp())}</div>
    </form>
    <details class="center small" style="margin-top:12px;max-width:420px">
      <summary style="cursor:pointer">پیام خطا داد؟ اینجا را باز کنید</summary>
      <div class="muted" style="margin-top:8px;text-align:right;line-height:1.9">
        ۱) اینترنت گوشی را روشن کنید (داده همراه یا وای‌فای).<br>
        ۲) اگر بازهم نشد، یک‌بار در <b>سیستم مدرسه</b> برنامه را باز کنید تا تنظیم‌ها و اجازهٔ دسترسی خودکار انجام شود.<br>
        ۳) بعد همین‌جا دوباره «ورود» را بزنید.
      </div>
      <div class="row" style="margin-top:10px"><button class="btn sm" type="button" data-act="phone-diagnose">بررسی دقیق اتصال</button></div>
      <div id="diag-out" class="small" style="margin-top:8px;text-align:right;line-height:2"></div>
    </details>
    <div class="center small" style="margin-top:14px">
      <button class="btn sm ghost" data-act="retry">تلاش مجدد برای اتصال به سیستم مدرسه</button>
    </div>
  </div>`)
}

function renderOffline() {
  renderPhoneLogin();
}

/* ══════════════ داشبورد مدیر ══════════════ */
function managerHome() {
  const students = list('users').filter(u => u.role === 'student' && u.active !== false);
  const teachers = list('users').filter(u => u.role === 'teacher');
  const classes = list('classes');
  const today = todayISO();
  const attToday = list('attendance').filter(a => a.date === today);
  const present = attToday.filter(a => a.status === 'present').length;
  const absent = attToday.filter(a => a.status === 'absent').length;
  const late = attToday.filter(a => a.status === 'late').length;
  const pending = list('grades').filter(g => g.status === 'pending').length;
  const coverage = classes.map(c => {
    const n = attToday.filter(a => Number(a.class_id) === Number(c.id)).length;
    return { c, n };
  });
  const doneCount = coverage.filter(x => x.n > 0).length;
  const recentAnn = sortBy(list('announcements'), 'date').reverse().slice(0, 3);

  return `
  ${pageHead('داشبورد مدرسه', J_DAYS[weekdayIndex()] + ' · ' + jdate(today),
    `<button class="btn sm" data-act="sync">🔄 همگام‌سازی</button>
     <button class="btn sm primary" data-act="goto" data-route="announcements">اطلاعیهٔ جدید</button>`)}
  <div class="grid">
    ${statCard('👥', fa(students.length), 'دانش‌آموز')}
    ${statCard('👨‍🏫', fa(teachers.length), 'دبیر')}
    ${statCard('🏛️', fa(classes.length), 'کلاس')}
    ${statCard('✅', fa(present) + ' / ' + fa(attToday.length), 'حاضر امروز', 'green')}
    ${statCard('❌', fa(absent), 'غایب امروز', 'red')}
    ${statCard('⏰', fa(late), 'تأخیر', 'amber')}
    ${statCard('📝', fa(pending), 'نمرهٔ در انتظار تأیید', 'purple')}
  </div>

  ${card(`<div class="row between" style="margin-bottom:8px"><b>پوشش حضور امروز</b><span class="small muted">${fa(doneCount)} از ${fa(coverage.length)} کلاس</span></div>
    <div class="row">${coverage.map(({ c, n }) => `<span class="badge ${n ? 'green' : 'red'}">${esc(c.name)} ${n ? '✓' : '—'}</span>`).join(' ')}</div>
    ${doneCount < coverage.length ? `<div class="small muted" style="margin-top:8px">کلاس‌هایی که امروز حضور ثبت نکرده‌اند با رنگ قرمز مشخص‌اند.</div>` : ''}`)}

  <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(160px,1fr))">
    <a class="card" href="#/users"><b>👥 کاربران</b><div class="small muted">افزودن، کارت پیوند، ورود دسته‌ای</div></a>
    <a class="card" href="#/reports"><b>📑 گزارش‌ها</b><div class="small muted">حضور، نمره، چاپ کارنامه</div></a>
    <a class="card" href="#/system"><b>⚙️ سیستم</b><div class="small muted">پشتیبان، دستگاه‌ها، آپدیت</div></a>
  </div>

  ${recentAnn.length ? card(`<b>آخرین اطلاعیه‌ها</b><div class="list" style="margin-top:8px">
    ${recentAnn.map(a => `<div class="item"><div class="grow"><div class="t">${esc(a.title)}</div><div class="s">${esc(jdate(a.date))}</div></div></div>`).join('')}
  </div>`) : ''}`;
}

function statCard(ico, num, label, tone = '') {
  return `<div class="card tight stat">
    <div class="ico">${ico}</div>
    <div><div class="num" style="color:${tone === 'red' ? 'var(--red)' : tone === 'green' ? 'var(--green)' : tone === 'amber' ? 'var(--amber)' : 'inherit'}">${num}</div><div class="lbl">${esc(label)}</div></div>
  </div>`;
}

/* ══════════════ خانهٔ دبیر ══════════════ */
function teacherScheduleFor(day) {
  return list('schedule').filter(s => Number(s.teacher_id) === Number(S.user.id) && Number(s.weekday) === Number(day));
}
function currentBell() {
  const bells = sortBy(list('bell_schedules').filter(b => b.type === 'lesson'), 'order');
  const m = nowMin();
  return bells.find(b => m >= toMin(b.start) && m <= toMin(b.end)) || null;
}
function nextBell() {
  const bells = sortBy(list('bell_schedules').filter(b => b.type === 'lesson'), 'order');
  const m = nowMin();
  return bells.find(b => toMin(b.start) > m) || null;
}
function attendanceFor(classId, date) {
  return list('attendance').filter(a => Number(a.class_id) === Number(classId) && a.date === date);
}

function teacherHome() {
  const day = weekdayIndex();
  const rows = teacherScheduleFor(day);
  const bells = new Map(list('bell_schedules').map(b => [Number(b.order), b]));
  const cur = currentBell();
  const nxt = nextBell();
  const today = todayISO();

  const slotCard = (s, highlight) => {
    const b = bells.get(Number(s.bell_order)) || {};
    const cls = byId('classes', s.class_id) || {};
    const subj = byId('subjects', s.subject_id) || {};
    const done = attendanceFor(s.class_id, today).length > 0;
    return `<div class="item" style="${highlight ? 'border-color:var(--primary);background:var(--soft)' : ''}">
      <div style="width:64px;text-align:center">
        <div style="font-weight:800">${esc(b.start || '')}</div>
        <div class="small muted">${esc(b.end || '')}</div>
      </div>
      <div class="grow">
        <div class="t">${esc(cls.name || '—')}</div>
        <div class="s">${esc(subj.name || '—')} ${highlight ? '· زنگ جاری' : ''}</div>
      </div>
      ${done ? badge('ثبت شده', 'green') : badge('ثبت نشده', 'red')}
      <a class="btn sm primary" href="#/attendance/${s.class_id}/${s.bell_order}">ثبت</a>
    </div>`;
  };

  return `
  ${pageHead('امروز من', J_DAYS[day] + ' · ' + jdate(today), `<button class="btn sm" data-act="sync">🔄</button>`)}
  ${cur ? card(`<div class="row between"><div><div class="small muted">زنگ جاری</div><b style="font-size:17px">${esc(cur.start)} – ${esc(cur.end)}</b></div>
      <div class="badge purple">${esc(cur.label || '')}</div></div>`) :
    card(`<div class="row between"><div><div class="small muted">زنگ جاری</div><b>${nxt ? 'زنگ بعدی: ' + esc(nxt.start) : 'زنگ درسی در جریان نیست'}</b></div></div>`)}
  ${card(`<div class="row between" style="margin-bottom:8px"><b>برنامهٔ امروز</b><span class="small muted">${fa(rows.length)} زنگ</span></div>
    ${rows.length ? `<div class="list">${rows.map(s => slotCard(s, cur && Number(s.bell_order) === Number(cur.order))).join('')}</div>` : '<div class="muted small">امروز کلاسی در برنامه ندارید.</div>'}`)}
  ${card(`<div class="row"><a class="btn grow" href="#/grades">📝 ثبت نمره</a><a class="btn grow" href="#/students">👥 دانش‌آموزان</a></div>`)}`;
}

/* ══════════════ حضور و غیاب ══════════════ */
const ATT_LABEL = { present: 'حاضر', absent: 'غایب', late: 'تأخیر', early_exit: 'خروج', excused: 'موجه' };

PAGES.attendance = (params) => {
  const clsId = Number(params[0] || 0);
  const bell = params[1] || '';
  const date = todayISO();
  if (!clsId) {
    const mine = new Set(list('schedule').filter(x => Number(x.teacher_id) === Number(S.user.id)).map(x => Number(x.class_id)));
    const classes = list('classes').filter(c => S.role !== 'teacher' || mine.has(Number(c.id)));
    return pageHead('حضور و غیاب', 'کلاس را انتخاب کنید') + card(classes.length
      ? `<div class="list">${classes.map(c => {
          const n = list('users').filter(u => u.role === 'student' && Number(u.class_id) === Number(c.id)).length;
          const done = attendanceFor(c.id, date).length;
          return `<a class="item" href="#/attendance/${c.id}">
            <div class="grow"><div class="t">${esc(c.name)}</div><div class="s">${fa(n)} دانش‌آموز · ${fa(c.grade || '')}</div></div>
            ${badge(done ? 'ثبت‌شده' : 'ثبت‌نشده', done ? 'green' : 'amber')}</a>`;
        }).join('')}</div>`
      : empty('کلاسی به شما تخصیص نیافته است.'));
  }

  const roster = list('users').filter(u => u.role === 'student' && Number(u.class_id) === clsId && u.active !== false);
  const existing = new Map(attendanceFor(clsId, date).map(a => [Number(a.student_id), a]));
  const cls = byId('classes', clsId) || {};
  const draft = S.attDraft && S.attDraft.key === clsId + ':' + date ? S.attDraft : (S.attDraft = { key: clsId + ':' + date, map: new Map() });
  const statusOf = (sid) => {
    if (draft.map.has(sid)) return draft.map.get(sid);
    const e = existing.get(sid);
    return e ? e.status : 'present';
  };
  const counts = { present: 0, absent: 0, late: 0, early_exit: 0 };
  roster.forEach(s => { const v = statusOf(s.id); if (counts[v] != null) counts[v]++; });

  if (!roster.length) return pageHead('حضور و غیاب', cls.name || '') + empty('دانش‌آموزی برای این کلاس ثبت نشده است.');

  return `${pageHead('حضور و غیاب', (cls.name || '') + ' · ' + jdate(date),
    `<a class="btn sm" href="#/home">بازگشت</a>`)}
  <div class="card tight">
    <div class="row between">
      <span class="badge green">حاضر ${fa(counts.present)}</span>
      <span class="badge red">غایب ${fa(counts.absent)}</span>
      <span class="badge amber">تأخیر ${fa(counts.late)}</span>
      <span class="badge purple">خروج ${fa(counts.early_exit)}</span>
    </div>
  </div>
  ${card(`<div class="row between" style="margin-bottom:6px">
      <b>فهرست کلاس</b>
      <div class="row">
        <button class="btn sm" data-act="att-all" data-status="present">همه حاضر</button>
        <button class="btn sm" data-act="att-all" data-status="absent">همه غایب</button>
      </div></div>
    <div id="att-list">${roster.map(s => {
      const v = statusOf(s.id);
      return `<div class="att-row" data-sid="${s.id}">
        <div class="att-name">${esc(s.name)}</div>
        <div class="att-btns">
          <button class="att-btn ${v === 'present' ? 'on-p' : ''}" data-act="att-set" data-s="present">حاضر</button>
          <button class="att-btn ${v === 'absent' ? 'on-a' : ''}" data-act="att-set" data-s="absent">غایب</button>
          <button class="att-btn ${v === 'late' ? 'on-l' : ''}" data-act="att-set" data-s="late">تأخیر</button>
          <button class="att-btn ${v === 'early_exit' ? 'on-e' : ''}" data-act="att-set" data-s="early_exit">خروج</button>
        </div>
      </div>`;
    }).join('')}</div>
    <button class="btn primary block" style="margin-top:12px" data-act="att-save" data-class="${clsId}" data-bell="${esc(bell)}">ثبت نهایی حضور</button>
  `)}`;
};

/* ══════════════ نمرات ══════════════ */
PAGES.grades = (params) => {
  if (S.role === 'teacher' || S.role === 'manager') {
    const classes = S.role === 'manager' ? list('classes') :
      list('classes').filter(c => teacherScheduleFor(0).concat(teacherScheduleFor(1), teacherScheduleFor(2), teacherScheduleFor(3), teacherScheduleFor(4)).some(s => Number(s.class_id) === Number(c.id)));
    if (!classes.length) return pageHead('ثبت نمره') + empty('کلاسی به شما تخصیص نیافته است.');
    const sel = S.gradeSel || (S.gradeSel = { class: classes[0].id, subject: '', term: 'نوبت اول' });
    const subjects = list('subjects');
    if (!sel.subject) {
      const sc = list('schedule').find(s => Number(s.class_id) === Number(sel.class));
      sel.subject = sc ? sc.subject_id : (subjects[0] && subjects[0].id);
    }
    const roster = list('users').filter(u => u.role === 'student' && Number(u.class_id) === Number(sel.class) && u.active !== false);
    const subject = byId('subjects', sel.subject) || {};
    const existing = new Map(list('grades')
      .filter(g => Number(g.class_id) === Number(sel.class) && Number(g.subject_id) === Number(sel.subject) && String(g.term) === String(sel.term))
      .map(g => [Number(g.student_id), g]));
    const draft = (S.gradeDraft && S.gradeDraft.key === sel.class + ':' + sel.subject + ':' + sel.term)
      ? S.gradeDraft : (S.gradeDraft = { key: sel.class + ':' + sel.subject + ':' + sel.term, map: new Map() });
    const valOf = (sid) => {
      if (draft.map.has(sid)) return draft.map.get(sid);
      const e = existing.get(sid);
      return e ? (e.practical_score != null ? e.practical_score : e.score) : '';
    };
    const isWorkshop = !!subject.workshop;

    return `${pageHead('ثبت نمره', subject.name || 'یک درس را انتخاب کنید')}
    <div class="card tight">
      <div class="row">
        <label class="field grow" style="margin:0"><span>کلاس</span>
          <select class="input" id="g-class">${classes.map(c => `<option value="${c.id}" ${Number(c.id) === Number(sel.class) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <label class="field grow" style="margin:0"><span>درس</span>
          <select class="input" id="g-subject">${subjects.map(s => `<option value="${s.id}" ${Number(s.id) === Number(sel.subject) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
        <label class="field grow" style="margin:0"><span>نوبت</span>
          <select class="input" id="g-term">${['نوبت اول', 'نوبت دوم', 'پایانی'].map(t => `<option ${t === sel.term ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <button class="btn sm" data-act="grade-reload" style="align-self:end">نمایش</button>
      </div>
    </div>
    ${card(`<div class="row between" style="margin-bottom:8px"><b>${esc(subject.name || '')}</b>
        <span class="small muted">${isWorkshop ? 'درس کارگاهی — نمرهٔ عملی' : 'نمره از ۲۰'}</span></div>
      ${roster.length ? `<table><thead><tr><th>دانش‌آموز</th><th style="width:110px">نمره</th><th style="width:90px">وضعیت</th></tr></thead><tbody>
        ${roster.map(s => {
          const e = existing.get(s.id);
          return `<tr><td>${esc(s.name)}</td>
            <td><input class="input ltr" style="padding:.3rem" inputmode="decimal" data-grade="${s.id}" value="${esc(valOf(s.id))}" placeholder="—"></td>
            <td>${e ? badge(e.status === 'approved' ? 'تأییدشده' : 'در انتظار', e.status === 'approved' ? 'green' : 'amber') : badge('جدید', '')}</td></tr>`;
        }).join('')}
      </tbody></table>
      <button class="btn primary block" style="margin-top:12px" data-act="grade-save">ثبت نمرات</button>` :
        '<div class="muted small">دانش‌آموزی در این کلاس نیست.</div>'}
    `)}`;
  }
  return pageHead('نمرات') + empty('دسترسی ندارید.');
};

/* ══════════════ دانش‌آموزان دبیر ══════════════ */
PAGES.students = () => {
  const myClasses = new Set(list('schedule').filter(s => Number(s.teacher_id) === Number(S.user.id)).map(s => Number(s.class_id)));
  const all = ['manager', 'vice', 'counselor', 'office'].includes(S.role);
  const students = list('users').filter(u => u.role === 'student' && (all || myClasses.has(Number(u.class_id))));
  const q = (S.q || '').trim();
  const rows = students.filter(s => !q || String(s.name).includes(q));
  return `${pageHead(all ? 'دانش‌آموزان مدرسه' : 'دانش‌آموزان من', fa(students.length) + ' نفر', '')}
  <div class="card tight"><input class="input" id="q-search" data-focus-key="q-search" data-search="q" placeholder="جستجو…" value="${esc(q)}"></div>
  ${rows.length ? card(`<div class="list">${rows.map(s => {
    const cls = byId('classes', s.class_id) || {};
    const g = list('grades').filter(x => Number(x.student_id) === Number(s.id));
    const avg = g.length ? (g.reduce((a, x) => a + Number(x.score || 0), 0) / g.length) : 0;
    return `<div class="item"><div class="grow"><div class="t">${esc(s.name)}</div><div class="s">${esc(cls.name || '')}</div></div>
      <span class="badge">معدل ${fa(avg.toFixed(1))}</span></div>`;
  }).join('')}</div>`) : empty('دانش‌آموزی یافت نشد.')}`;
};

/* ══════════════ مدیر: کاربران ══════════════ */
PAGES.users = () => {
  if (S.role !== 'manager') return pageHead('کاربران') + empty('دسترسی ندارید.');
  const q = (S.q || '').trim();
  const role = S.roleFilter || '';
  let users = list('users');
  if (role) users = users.filter(u => u.role === role);
  if (q) users = users.filter(u => String(u.name).includes(q) || String(u.phone || '').includes(q) || String(u.national_id || '').includes(q));
  users = users.sort((a, b) => String(a.name).localeCompare(String(b.name))).slice(0, 300);

  const picked = S.picked instanceof Set ? S.picked : new Set();
  const pickedVisible = users.filter(u => picked.has(Number(u.id)));
  const allPicked = users.length > 0 && pickedVisible.length === users.length;

  const openIssues = importIssueRows();
  const fuCount = followupCount();

  return `${pageHead('کاربران', fa(list('users').length) + ' کاربر',
    `<button class="btn sm" data-act="import-open">📥 ورود دسته‌ای (اکسل/CSV)</button>
     <button class="btn sm primary" data-act="user-add">+ کاربر جدید</button>`)}

  ${fuCount ? `<div class="card tight" style="border-color:#fcd34d;background:#fffbeb">
    <div class="row between" style="gap:8px;flex-wrap:wrap">
      <div><b>🕒 ${fa(fuCount)} مورد نیاز به پیگیری دارد</b>
        <div class="small muted" style="margin-top:4px">${fa(openIssues.length)} ردیف از ورود دسته‌ای + ${fa(fuCount - openIssues.length)} دانش‌آموز که کلاسش درست نیست (رشته یا پایه‌اش حذف شده یا پایه نداشت).</div></div>
      <span class="row" style="gap:8px;flex-wrap:wrap">
        <a class="btn sm ghost" href="#/followup">صفحهٔ پیگیری</a>
        <button class="btn sm" data-act="issues-open">مشاهده و اصلاح</button>
      </span>
    </div></div>` : ''}

  <div class="card tight">
    <input class="input" id="q-search" data-focus-key="q-search" data-search="q" placeholder="جستجوی نام، شمارهٔ همراه یا کد ملی…" value="${esc(q)}">
    <div class="pill-tabs" style="margin-top:8px">
      ${[['', 'همه'], ['student', 'دانش‌آموز'], ['teacher', 'دبیر'], ['parent', 'ولی'], ['manager', 'مدیر'], ['vice', 'معاون'], ['staff', 'کارمند']].map(([v, t]) =>
        `<span class="pill ${role === v ? 'on' : ''}" data-act="role-filter" data-role="${v}">${t}</span>`).join('')}
    </div>
  </div>

  ${picked.size ? `<div class="card tight" style="border-color:#b91c1c">
    <div class="row between">
      <b>${fa(picked.size)} کاربر انتخاب شده</b>
      <span class="row" style="gap:8px">
        <button class="btn sm ghost" data-act="pick-clear">لغو انتخاب</button>
        <button class="btn sm" style="background:#b91c1c;color:#fff" data-act="users-bulk-delete">حذف انتخاب‌شده‌ها</button>
      </span>
    </div></div>` : ''}

  ${card(`<div class="small muted" style="margin-bottom:6px">نام کاربری هر نفر همان <b>شمارهٔ همراه</b> است (و اگر شماره نداشت، <b>کد ملی</b>) و رمزش <b>کد ملی</b>؛ رمز کنار هر نفر نوشته شده تا بتوانید به خودش بگویید. این جدول را فقط مدیر می‌بیند.</div>
  <div class="table-wrap"><table><thead><tr>
    <th style="width:34px"><input type="checkbox" data-pick="all" ${allPicked ? 'checked' : ''} title="انتخاب همه"></th>
    <th>نام و نام خانوادگی</th><th>نقش</th><th>پایه</th><th>رشته</th><th>${S.roleFilter === 'parent' ? 'ولیِ چه دانش‌آموزی' : 'دانش‌آموز'}</th><th>نام کاربری</th><th>رمز عبور</th><th></th></tr></thead><tbody>
    ${users.map(u => {
      /* پایه و رشته از گروه ثبت‌نام (کلاس) خوانده می‌شود؛ برای ولی، از فرزندش */
      const link = u.role === 'parent' ? list('parent_links').find(l => Number(l.parent_id) === Number(u.id)) : null;
      const kids = u.role === 'parent' ? list('parent_links').filter(l => Number(l.parent_id) === Number(u.id)).map(l => byId('users', l.student_id)).filter(Boolean) : [];
      const subject = (u.role === 'parent' && kids.length) ? kids[0] : u;
      const grp = byId('classes', subject.class_id) || {};
      const gr = String(grp.grade || subject.grade || '');
      const br = String(grp.branch || subject.branch || '');
      return `<tr${picked.has(Number(u.id)) ? ' style="background:#fef2f2"' : ''}>
      <td><input type="checkbox" data-pick="user" value="${u.id}" ${picked.has(Number(u.id)) ? 'checked' : ''}></td>
      <td>${esc([u.name, u.last_name].filter(Boolean).join(' '))}</td>
      <td>${badge(ROLE_FA[u.role] || u.role, u.role === 'manager' ? 'purple' : '')}</td>
      <td class="small">${gr ? esc(gr) : '<span class="muted">—</span>'}</td>
      <td class="small">${br ? esc(br) : '<span class="muted">—</span>'}</td>
      <td class="small">${u.role === 'parent'
        ? (kids.length ? kids.map(k => esc(k.name)).join('، ') : '<span class="muted">—</span>')
        : (u.role === 'student' ? (gr ? esc(gr + (br ? ' ' + br : '')) : '<span class="muted">—</span>') : '<span class="muted">—</span>')}</td>
      <td class="small ltr">${esc(u.phone || u.national_id || '—')}${u.phone ? '' : ' <span class="muted" style="font-size:10px">(کد ملی)</span>'}</td>
      <td class="small ltr">${(() => {
        const c = S.creds && S.creds[u.id];
        if (!S.creds) return '<span class="muted">…</span>';
        if (c && c.password) return `<b>${esc(c.password)}</b>`;
        return '<span class="muted" title="رمز قبلاً تعیین شده و قابل خواندن نیست">—</span>';
      })()}</td>
      <td class="nowrap">
        ${(!isPhoneMode() && !/^pbkdf2\$/.test(String(u.phone_hash || ''))) ? `<button class="btn sm ghost" data-act="user-auto-pw" data-id="${u.id}" title="رمز گوشی = کد ملی">آماده‌سازی گوشی</button>` : ''}
        <button class="btn sm" data-act="pair-code" data-id="${u.id}">کارت پیوند</button>
        <button class="btn sm ghost" data-act="user-edit" data-id="${u.id}">ویرایش</button>
        <button class="btn sm ghost" data-act="user-delete" data-id="${u.id}" style="color:#b91c1c">حذف</button>
      </td>
    </tr>`;
    }).join('')}
  </tbody></table></div>${users.length ? '' : empty('کاربری با این مشخصات پیدا نشد.')}`)}`;
};

/* ══════════════ پیگیری ردیف‌های ناتمامِ ورود دسته‌ای ══════════════
   هر ردیفی که ساخته نشد یا مشخصاتش ناقص بود اینجا می‌ماند: دلیلش را
   می‌بینید، با یک دکمه فرم کاربر با همان اطلاعات باز می‌شود تا کاملش
   کنید، و بعد «حل شد» می‌زنید. */
function importIssuesTableHtml(all) {
  const rows = all.map(r => {
    const d = r.data || {};
    const existed = list('users').find(u =>
      (r.national_id && String(u.national_id || '') === String(r.national_id)) ||
      (r.phone && String(u.phone || '') === String(r.phone)) ||
      (!r.national_id && !r.phone && String(u.name || '') === String(r.name)));
    return `<tr>
      <td><b>${esc(r.name || '—')}</b>
        ${r.national_id ? `<div class="small muted ltr">${esc(r.national_id)}</div>` : ''}</td>
      <td class="small ltr">${esc(r.phone || '—')}</td>
      <td class="small">${(r.reasons || []).slice(0, 4).map(x => `<div>⚠️ ${esc(x)}</div>`).join('') || '—'}</td>
      <td class="small">${existed ? badge('در سامانه هست', 'green') : badge('ساخته نشده', 'red')}</td>
      <td class="nowrap">
        <button class="btn sm" data-act="issue-fix" data-id="${esc(r.id)}">${existed ? 'اصلاح' : 'ساختن کاربر'}</button>
        <button class="btn sm ghost" data-act="issue-done" data-id="${esc(r.id)}">حل شد</button>
      </td></tr>`;
  }).join('');
  return `<div class="table-wrap" style="max-height:52vh;overflow:auto"><table><thead><tr>
      <th>نام</th><th>شمارهٔ همراه</th><th>دلیل</th><th>وضعیت</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function importIssuesHtml() {
  const all = importIssueRows();
  return `<div class="small muted" style="margin-bottom:8px;line-height:2">
      این فهرست برای ردیف‌هایی است که در ورود دسته‌ای ساخته نشدند یا مشخصاتشان کامل نبود.
      با «ساختن/اصلاح» فرم کاربر با همان اطلاعات باز می‌شود؛ بعد از ذخیره، ردیف از این فهرست برداشته می‌شود.
    </div>
    ${all.length ? importIssuesTableHtml(all) + `<div class="row" style="margin-top:10px;gap:8px">
        <button class="btn ghost" data-act="modal-close">بستن</button>
        <button class="btn primary grow" data-act="issues-clear">همه را حل‌شده کن</button>
      </div>`
      : `<div class="center" style="padding:16px 0"><div style="font-size:32px">✅</div>
         <b>هیچ ردیفی برای پیگیری نمانده</b></div>
         <button class="btn primary block" data-act="modal-close" style="margin-top:10px">باشه</button>`}`;
}

function actImportIssues() {
  S.modalTitle = 'نیازمند پیگیری — ورود دسته‌ای';
  modal(importIssuesHtml());
}

/* ══════════════ «نیازمند پیگیری» — یک جای مشخص و همیشه در دسترس ══════
   دو دسته با هم نشان داده می‌شوند:
     ۱) ردیف‌های ورود دسته‌ای که ساخته نشدند یا مشخصاتشان کامل نبود
     ۲) دانش‌آموزانی که کلاسشان معتبر نیست — رشته/پایه‌شان حذف شده،
        در فایل نبود، یا کلاسشان پایه ندارد
   مورد دوم از خودِ داده حساب می‌شود، پس هر دانش‌آموزی که با حذف رشته
   بی‌کلاس شود بی‌درنگ همین‌جا ظاهر می‌شود.
   ═══════════════════════════════════════════════════════════════════ */
function importIssueRows() {
  return list('import_issues').filter(r => r.status !== 'done')
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** چرا این دانش‌آموز کلاس درست ندارد؟ رشتهٔ خالی برچسب نمی‌خورد. */
function followupStudentReason(u) {
  if (!u || u.role !== 'student') return '';
  if (u.followup_ack) return '';
  const c = u.class_id ? byId('classes', u.class_id) : null;
  if (!c) return u.followup_reason || 'کلاس ندارد';
  const gradeNames = lookupList('grade').map(l => String(l.name));
  const branchNames = lookupList('branch').map(l => String(l.name));
  const g = String(c.grade || '').trim();
  const b = String(c.branch || '').trim();
  if (!g) return u.followup_reason || 'کلاسش پایه ندارد';
  if (gradeNames.length && gradeNames.indexOf(g) < 0) return 'پایه‌اش تعریف نشده («' + g + '»)';
  if (b && branchNames.length && branchNames.indexOf(b) < 0) return 'رشته‌اش تعریف نشده («' + b + '»)';
  /* کلاس سالم است: دلیلِ کهنه نباید او را در فهرست نگه دارد */
  return '';
}

function followupStudents() {
  const out = [];
  for (const u of list('users')) {
    if (u.role !== 'student') continue;
    const r = followupStudentReason(u);
    if (r) out.push({ user: u, reason: r });
  }
  out.sort((a, b) => String(a.user.name).localeCompare(String(b.user.name)));
  return out;
}

function followupCount() {
  return followupStudents().length + importIssueRows().length;
}

function classOptionList(selectedId) {
  const classes = list('classes').sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return classes.map(c => `<option value="${c.id}" ${Number(selectedId) === Number(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
}

PAGES.followup = () => {
  if (S.role !== 'manager') return pageHead('نیازمند پیگیری') + empty('دسترسی ندارید.');
  const studs = followupStudents();
  const issues = importIssueRows();
  const total = studs.length + issues.length;

  const gradeNames = lookupList('grade').map(l => String(l.name)).filter(g => !(typeof impGradeLevel === 'function') || impGradeLevel(g));
  const baseBranchNames = lookupList('branch').map(l => String(l.name));
  const studRows = studs.map(({ user, reason }) => {
    /* رشته از متن دلیل («رشته: نقشه‌کشی») برداشته می‌شود تا مدیر فقط پایه را بزند */
    const m = String(reason || '').match(/رشته:\s*([^)\n]+)/);
    const brGuess = m ? String(m[1]).replace(/\(.*$/, '').trim() : '';
    const cur = byId('classes', user.class_id) || {};
    const gSel = String(cur.grade || '');
    const bSel = String(cur.branch || brGuess || '');
    /* رشتهٔ استخراج‌شده از اکسل حتی اگر هنوز «تعریف» نشده باشد در فهرست می‌آید */
    const fuBranches = bSel && baseBranchNames.indexOf(bSel) < 0 ? baseBranchNames.concat([bSel]) : baseBranchNames;
    const gradeNames2 = gSel && gradeNames.indexOf(gSel) < 0 ? gradeNames.concat([gSel]) : gradeNames;
    return `<tr>
      <td><b>${esc(user.name)}</b>
        <div class="small muted ltr">${esc(user.phone || user.national_id || '')}</div></td>
      <td class="small">⚠️ ${esc(reason)}</td>
      <td class="nowrap">
        <select class="input" id="fu-grade-${user.id}" style="min-width:104px">
          <option value="">— پایه —</option>${gradeNames2.map(g => `<option value="${esc(g)}" ${g === gSel ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select>
        <select class="input" id="fu-branch-${user.id}" style="min-width:118px">
          <option value="">— رشته —</option>${fuBranches.map(b => `<option value="${esc(b)}" ${b === bSel ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
      </td>
      <td class="nowrap">
        <button class="btn sm primary" data-act="followup-assign" data-id="${user.id}">ذخیره</button>
        <button class="btn sm ghost" data-act="followup-ack" data-id="${user.id}" title="بی‌کلاس بماند">حل شد</button>
      </td></tr>`;
  }).join('');

  const studentsCard = card(
    `<div class="row between" style="margin-bottom:8px"><b>دانش‌آموزان بدون کلاسِ درست</b>
       <span class="small muted">${fa(studs.length)} نفر</span></div>` +
    (studs.length
      ? `<div class="table-wrap"><table><thead><tr>
           <th>دانش‌آموز</th><th>دلیل</th><th style="min-width:190px">کلاس درست</th><th></th>
         </tr></thead><tbody>${studRows}</tbody></table></div>`
      : `<div class="small muted">همهٔ دانش‌آموزان کلاس درست دارند. ✅</div>`)
  );

  const issuesCard = card(
    `<div class="row between" style="margin-bottom:8px"><b>ردیف‌های ورود دسته‌ای</b>
       <span class="small muted">${fa(issues.length)} ردیف</span></div>` +
    (issues.length
      ? importIssuesTableHtml(issues) +
        `<div class="row" style="margin-top:10px;gap:8px">
           <button class="btn primary" data-act="issues-clear">همه را حل‌شده کن</button></div>`
      : `<div class="small muted">ردیف ناتمامی از ورود دسته‌ای نمانده. ✅</div>`)
  );

  return `${pageHead('نیازمند پیگیری', fa(total) + ' مورد برای رسیدگی',
      `<button class="btn sm" data-act="import-open">📥 ورود دسته‌ای</button>`)}
  <div class="small muted" style="margin-bottom:10px;line-height:2">
    هر چیزی که کامل نیست اینجا جمع می‌شود: ردیف‌های ورود دسته‌ای که ساخته نشدند،
    و دانش‌آموزانی که کلاسشان درست نیست (مثلاً رشته‌شان حذف شده یا پایه‌اش در فایل نبود).
    تا اینجا باشند جایی گم نمی‌شوند.
  </div>
  ${studentsCard}
  ${issuesCard}`;
};

/* ══════════════ تعریف‌ها (پایه، رشته) ══════════════ */
/* فقط تعریف‌های واقعیِ ثبت‌شده نمایش داده می‌شوند؛ هیچ فهرست پیش‌فرضی در کار
   نیست تا چیزی که حذف شده دیگر برنگردد. */
const LOOKUP_FA = { grade: 'پایه', branch: 'رشته' };

/* فقط چیزی که واقعاً تعریف شده برمی‌گردد. فهرست پیش‌فرضی در کار نیست،
   وگرنه رشته‌ای که مدیر حذف کرده دوباره پایین صفحه ظاهر می‌شد. */
function lookupList(kind) {
  return list('lookups')
    .filter(l => String(l.kind) === String(kind))
    .sort((a, b) => (Number(a.order || 0) - Number(b.order || 0)) || String(a.name).localeCompare(String(b.name)));
}

/* یک ردیف تعریف با دکمه‌های ویرایش و حذف */
function lookupRowHtml(row, kind) {
  const used = kind === 'grade'
    ? list('classes').filter(c => String(c.grade || '') === String(row.name)).length
    : list('classes').filter(c => String(c.branch || '') === String(row.name)).length;
  const actions = `<button class="btn sm ghost" data-act="def-edit" data-id="${row.id}">ویرایش</button>
       <button class="btn sm ghost" style="color:#b91c1c" data-act="def-delete" data-id="${row.id}">حذف</button>`;
  return `<div class="item"><div class="grow"><div class="t">${esc(row.name)}</div>
      <div class="s">${used ? fa(used) + ' کلاس از این مورد استفاده می‌کند' : 'بدون استفاده'}</div></div>
    ${actions}</div>`;
}

/* ══════════════ مدیر: کلاس‌ها و تعریف‌ها ══════════════ */
PAGES.classes = () => {
  if (S.role !== 'manager') return pageHead('کلاس‌ها') + empty('دسترسی ندارید.');
  const classes = list('classes');
  const subjects = list('subjects');
  const countOf = id => list('users').filter(u => u.role === 'student' && Number(u.class_id) === Number(id)).length;
  /* کلاس‌هایی که پایه ندارند یا پایه‌شان از تعریف‌ها حذف شده — همان
     کلاس‌هایی که ورود دسته‌ای قدیمی از رشته ساخته بود. */
  const gradeNames = lookupList('grade').map(l => String(l.name));
  const hasGrade = c => {
    const g = String(c.grade || '').trim();
    if (!g) return false;
    /* پایهٔ واقعی = یکی از اول…دوازدهم؛ «الکترونیک» هرچند در تعریف‌ها باشد پایه نیست */
    if (typeof impGradeLevel === 'function' && !impGradeLevel(g)) return false;
    return !gradeNames.length || gradeNames.indexOf(g) > -1;
  };
  const brokenClasses = classes.filter(c => !hasGrade(c));
  const mergeTargets = classes.filter(hasGrade);
  const brokenCard = brokenClasses.length ? card(
    `<div class="row between" style="margin-bottom:8px"><b>🛠️ کلاس‌هایی که پایه ندارند</b>
       <span class="small muted">${fa(brokenClasses.length)} کلاس</span></div>
     <div class="small muted" style="margin-bottom:8px;line-height:2">
       این کلاس‌ها معمولاً از ورود دسته‌ایِ قدیمی مانده‌اند که رشته را به‌جای کلاس ساخته است.
       هر کدام را در کلاس درستش ادغام کنید (دانش‌آموزان و برنامه‌اش منتقل می‌شوند) یا با «ویرایش» پایه و رشته‌اش را درست کنید.
     </div>
     <div class="table-wrap"><table><thead><tr><th>کلاس</th><th>دانش‌آموز</th><th>ادغام در</th><th></th></tr></thead><tbody>
     ${brokenClasses.map(c => `<tr>
       <td><b>${esc(c.name)}</b><div class="small muted">رشته: ${esc(c.branch || '—')}</div></td>
       <td>${fa(countOf(c.id))}</td>
       <td><select class="input" id="merge-into-${c.id}">
         <option value="">— کلاس درست —</option>
         ${mergeTargets.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}
       </select></td>
       <td class="nowrap">
         <button class="btn sm" data-act="class-merge" data-id="${c.id}">ادغام</button>
         <button class="btn sm ghost" data-act="class-edit" data-id="${c.id}">ویرایش</button>
       </td></tr>`).join('')}
     </tbody></table></div>`) : '';

  return `${pageHead('کلاس‌ها و تعریف‌ها', fa(classes.length) + ' کلاس',
      `<button class="btn sm primary" data-act="class-add">+ کلاس جدید</button>`)}

  ${brokenCard}

  ${card(`<div class="row between" style="margin-bottom:8px"><b>کلاس‌ها</b>
      <span class="small muted">هر کلاس یک پایه و یک رشته دارد</span></div>
    ${classes.length ? `<div class="table-wrap"><table><thead><tr>
        <th>کلاس</th><th>پایه</th><th>رشته</th><th>دانش‌آموز</th><th>عملیات</th></tr></thead><tbody>
      ${classes.map(c => `<tr>
        <td><b>${esc(c.name)}</b></td>
        <td class="small">${esc(c.grade || '—')}</td>
        <td class="small">${esc(c.branch || '—')}</td>
        <td>${fa(countOf(c.id))}</td>
        <td class="nowrap">
          <button class="btn sm ghost" data-act="class-edit" data-id="${c.id}">ویرایش</button>
          <button class="btn sm ghost" style="color:#b91c1c" data-act="class-delete" data-id="${c.id}">حذف</button>
        </td></tr>`).join('')}
      </tbody></table></div>` : empty('هنوز کلاسی ساخته نشده.')}`)}

  ${card(`<div class="row between" style="margin-bottom:8px"><b>پایه‌ها</b>
      <button class="btn sm" data-act="def-add" data-kind="grade">+ پایه</button></div>
    <div class="list">${lookupList('grade').map(r => lookupRowHtml(r, 'grade')).join('')}</div>`)}

  ${card(`<div class="row between" style="margin-bottom:8px"><b>رشته‌ها</b>
      <button class="btn sm" data-act="def-add" data-kind="branch">+ رشته</button></div>
    <div class="list">${lookupList('branch').map(r => lookupRowHtml(r, 'branch')).join('')}</div>`)}

  ${card(`<div class="row between" style="margin-bottom:8px"><b>دروس</b>
      <button class="btn sm" data-act="subject-add">+ درس</button></div>
    ${subjects.length ? `<div class="list">${subjects.map(sub => `<div class="item">
        <div class="grow"><div class="t">${esc(sub.name)}${sub.workshop ? ' <span class="badge purple">کارگاهی</span>' : ''}</div>
        <div class="s">${fa(list('schedule').filter(x => Number(x.subject_id) === Number(sub.id)).length)} زنگ در برنامه</div></div>
        <button class="btn sm ghost" data-act="subject-edit" data-id="${sub.id}">ویرایش</button>
        <button class="btn sm ghost" style="color:#b91c1c" data-act="subject-delete" data-id="${sub.id}">حذف</button>
      </div>`).join('')}</div>` : empty('درسی تعریف نشده.')}`)}`;
};

/* ══════════════ برنامه و زنگ ══════════════ */
PAGES.schedule = () => (typeof window.schedPage === 'function' ? window.schedPage() : empty('برنامه در دسترس نیست.'));

/* ══════════════ گزارش‌ها ══════════════ */
PAGES.reports = () => {
  if (S.role !== 'manager') return pageHead('گزارش‌ها') + empty('دسترسی ندارید.');
  const today = todayISO();
  const classes = list('classes');
  const att = list('attendance');
  const week = [...Array(7)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() - i); return d.toISOString().slice(0, 10); });
  const rows = classes.map(c => {
    const rowsC = att.filter(a => Number(a.class_id) === Number(c.id) && week.includes(a.date));
    const p = rowsC.filter(a => a.status === 'present').length;
    const ab = rowsC.filter(a => a.status === 'absent').length;
    const lt = rowsC.filter(a => a.status === 'late').length;
    const pct = rowsC.length ? Math.round(p / rowsC.length * 100) : 0;
    return { c, p, ab, lt, pct, n: rowsC.length };
  });
  return `${pageHead('گزارش‌ها', 'هفتهٔ اخیر', `<button class="btn sm" data-act="print">🖨️ چاپ</button>`)}
  ${card(`<b>حضور هفتگی به تفکیک کلاس</b>
    <div class="table-wrap"><table><thead><tr><th>کلاس</th><th>ثبت</th><th>حاضر</th><th>غایب</th><th>تأخیر</th><th>درصد</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${esc(r.c.name)}</td><td>${fa(r.n)}</td><td>${fa(r.p)}</td><td>${fa(r.ab)}</td><td>${fa(r.lt)}</td>
      <td>${badge(fa(r.pct) + '٪', r.pct >= 90 ? 'green' : r.pct >= 75 ? 'amber' : 'red')}</td></tr>`).join('')}
    </tbody></table></div>`)}
  ${card(`<div class="row between"><b>کارنامهٔ کلاسی</b>
      <select class="input" style="max-width:240px" id="rc-class" data-set="repClass">
        ${classes.map(c => `<option value="${c.id}" ${Number(S.repClass) === Number(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select></div>
    <div class="table-wrap" style="margin-top:8px">${classReportTable(Number(S.repClass || (classes[0] && classes[0].id)))}</div>
    <div class="small muted" style="margin-top:8px">میانگین‌ها از نمرات ثبت‌شده محاسبه می‌شوند؛ برای چاپ، دکمهٔ «چاپ» بالا.</div>`)}`;
};

function classReportTable(classId) {
  const roster = list('users').filter(u => u.role === 'student' && Number(u.class_id) === Number(classId));
  const subs = [...new Set(list('grades').filter(g => Number(g.class_id) === Number(classId)).map(g => g.subject_id))];
  const att = list('attendance').filter(a => Number(a.class_id) === Number(classId));
  if (!roster.length) return '<div class="muted small">دانش‌آموزی نیست.</div>';
  return `<table><thead><tr><th>دانش‌آموز</th>${subs.map(id => `<th>${esc((byId('subjects', id) || {}).name || '')}</th>`).join('')}<th>معدل</th><th>حضور</th></tr></thead><tbody>
    ${roster.map(s => {
      const gs = list('grades').filter(g => Number(g.student_id) === Number(s.id));
      const cells = subs.map(id => { const g = gs.find(x => Number(x.subject_id) === Number(id)); return `<td>${g ? fa(g.score) : '—'}</td>`; }).join('');
      const avg = gs.length ? gs.reduce((a, x) => a + Number(x.score || 0), 0) / gs.length : 0;
      const a = att.filter(x => Number(x.student_id) === Number(s.id));
      const pct = a.length ? Math.round(a.filter(x => x.status === 'present').length / a.length * 100) : 0;
      return `<tr><td>${esc(s.name)}</td>${cells}<td><b>${fa(avg.toFixed(2))}</b></td><td>${fa(pct)}٪</td></tr>`;
    }).join('')}
  </tbody></table>`;
}

/* ══════════════ حضور — نمای مدیر ══════════════ */
PAGES['attendance-report'] = () => {
  if (S.role !== 'manager') return pageHead('حضور') + empty('دسترسی ندارید.');
  const date = S.attDate || todayISO();
  const all = list('attendance').filter(a => a.date === date);
  const byClass = list('classes').map(c => ({ c, rows: all.filter(a => Number(a.class_id) === Number(c.id)) }));
  return `${pageHead('حضور و غیاب', jdate(date), `<input type="date" class="input" style="max-width:180px" id="att-date" data-focus-key="att-date" data-set="attDate" value="${date}">`)}
  ${byClass.map(({ c, rows }) => card(`<div class="row between"><b>${esc(c.name)}</b>
      <span class="small muted">${rows.length ? fa(rows.filter(r => r.status === 'present').length) + ' حاضر از ' + fa(rows.length) : 'ثبت نشده'}</span></div>
    ${rows.length ? `<div class="row" style="margin-top:6px">${rows.filter(r => r.status !== 'present').map(r => `<span class="badge red">${esc((byId('users', r.student_id) || {}).name || '')} · ${ATT_LABEL[r.status] || r.status}</span>`).join(' ') || '<span class="small muted">همه حاضر</span>'}</div>` : ''}`)).join('')}`;
};

/* ══════════════ اطلاعیه‌ها ══════════════ */
PAGES.announcements = () => {
  const rows = sortBy(list('announcements'), 'date').reverse();
  const canWrite = S.role === 'manager';
  return `${pageHead('اطلاعیه‌ها', fa(rows.length) + ' مورد', canWrite ? `<button class="btn sm primary" data-act="ann-add">+ اطلاعیه</button>` : '')}
  ${rows.length ? rows.map(a => card(`<div class="row between"><b>${esc(a.title)}</b>${badge(jdate(a.date), a.severity === 'important' ? 'red' : a.severity === 'info' ? 'purple' : '')}</div>
    <div class="small" style="margin-top:6px;white-space:pre-wrap">${esc(a.body)}</div>
    ${canWrite ? `<div class="row" style="gap:8px;margin-top:8px">
      <button class="btn sm ghost" data-act="ann-edit" data-id="${a.id}">ویرایش</button>
      <button class="btn sm ghost" style="color:#b91c1c" data-act="ann-delete" data-id="${a.id}">حذف</button>
    </div>` : ''}`)).join('') : empty('اطلاعیه‌ای ثبت نشده.')}`;
};

/* ══════════════ ولی ══════════════ */
function myChildren() {
  const links = list('parent_links').filter(l => Number(l.parent_id) === Number(S.user.id));
  return links.map(l => byId('users', l.student_id)).filter(Boolean);
}

PAGES.home = () => {
  if (S.role === 'manager') return managerHome();
  if (S.role === 'teacher') return teacherHome();
  if (S.role === 'parent') return parentHome();
  if (S.role === 'student') return studentHome();
  return pageHead('خانه') + empty('نقش شما در این نسخه صفحهٔ اختصاصی ندارد.');
};

function parentHome() {
  const kids = myChildren();
  return `${pageHead('فرزندان من', fa(kids.length) + ' فرزند', `<button class="btn sm" data-act="sync">🔄</button>`)}
  ${kids.length ? kids.map(k => {
    const cls = byId('classes', k.class_id) || {};
    const g = list('grades').filter(x => Number(x.student_id) === Number(k.id) && x.status === 'approved');
    const avg = g.length ? (g.reduce((a, x) => a + Number(x.score || 0), 0) / g.length) : 0;
    const att = list('attendance').filter(x => Number(x.student_id) === Number(k.id));
    const pct = att.length ? Math.round(att.filter(x => x.status === 'present').length / att.length * 100) : 0;
    return `<a class="card" href="#/child/${k.id}" style="display:block">
      <div class="row between"><div><b>${esc(k.name)}</b><div class="small muted">${esc(cls.name || '')}</div></div>
        <div class="row"><span class="badge ${avg >= 15 ? 'green' : avg >= 10 ? 'amber' : 'red'}">معدل ${fa(avg.toFixed(1))}</span>
        <span class="badge ${pct >= 90 ? 'green' : 'amber'}">حضور ${fa(pct)}٪</span></div></div>
    </a>`;
  }).join('') : empty('فرزندی به حساب شما متصل نیست — با دفتر مدرسه تماس بگیرید.')}
  ${cloudCard(kids)}
  ${card(`<div class="row"><a class="btn grow" href="#/leaves">📨 درخواست مرخصی</a><a class="btn grow" href="#/announcements">📢 اطلاعیه‌ها</a></div>`)}`;
}

/* ── وضعیت آفلاین و صندوقچهٔ ابری ──
   دادهٔ نمایش‌داده‌شده همان آخرین همگام‌سازی این دستگاه است؛ ثبت‌ها در صف
   می‌مانند و اولین سیستم/دستگاهی که روشن شود آن‌ها را اعمال می‌کند. */
function cloudCard(kids) {
  const q = (S.queue || []).length;
  const ob = S.outbox || {};
  if (!q && !ob.pending) return '';
  const rows = [];
  if (q) rows.push(`<div class="small" style="margin-top:6px">📤 <b>${fa(q)}</b> تغییر روی همین دستگاه ثبت شده و هنوز اعمال نشده.</div>`);
  if (ob.pending) rows.push(`<div class="small" style="margin-top:6px">📦 <b>${fa(ob.pending)}</b> ثبت از دستگاه‌های دیگر در صندوقچهٔ ابری منتظر است.</div>`);
  if (ob.last_drain) rows.push(`<div class="small muted" style="margin-top:4px">آخرین اعمال: ${esc(jdate(ob.last_drain))}</div>`);
  return card(`<div class="row between"><b>📥 صندوقچهٔ ابری</b>${badge('در انتظار اعمال', 'amber')}</div>
    ${rows.join('')}
    <div class="small muted" style="margin-top:6px">لازم نیست کاری کنید: اولین سیستمی که روشن شود (مدرسه، خانه یا گوشیِ کادر) خودش این‌ها را اعمال می‌کند.</div>`);
}

PAGES.child = (params) => {
  const kids = myChildren();
  const k = byId('users', Number(params[0])) || kids[0];
  if (!k) return pageHead('پرونده') + empty('برای حساب شما فرزندی ثبت نشده است.');
  const cls = byId('classes', k.class_id) || {};
  const grades = list('grades').filter(g => Number(g.student_id) === Number(k.id));
  const att = list('attendance').filter(a => Number(a.student_id) === Number(k.id)).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const pct = att.length ? Math.round(att.filter(a => a.status === 'present').length / att.length * 100) : 0;
  const avg = grades.length ? grades.reduce((a, g) => a + Number(g.score || 0), 0) / grades.length : 0;
  const internships = list('internships').filter(i => Number(i.student_id) === Number(k.id));
  return `${pageHead(k.name, cls.name || '', `<a class="btn sm" href="#/home">بازگشت</a>`)}
  <div class="grid">
    ${statCard('📊', fa(avg.toFixed(1)), 'معدل', avg >= 15 ? 'green' : avg >= 10 ? '' : 'red')}
    ${statCard('✅', fa(pct) + '٪', 'حضور', pct >= 90 ? 'green' : 'amber')}
    ${statCard('📝', fa(grades.length), 'نمره ثبت‌شده')}
  </div>
  ${card(`<b>نمرات</b><div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>درس</th><th>نوبت</th><th>نمره</th><th>وضعیت</th></tr></thead><tbody>
    ${grades.map(g => `<tr><td>${esc((byId('subjects', g.subject_id) || {}).name || '—')}</td><td class="small">${esc(g.term || '')}</td>
      <td><b>${fa(g.score)}</b>${g.practical_score != null ? `<span class="small muted"> (عملی ${fa(g.practical_score)})</span>` : ''}</td>
      <td>${badge(g.status === 'approved' ? 'تأییدشده' : 'در انتظار', g.status === 'approved' ? 'green' : 'amber')}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">نمره‌ای ثبت نشده</td></tr>'}
  </tbody></table></div>`)}
  ${card(`<b>حضور و غیاب</b><div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>تاریخ</th><th>وضعیت</th></tr></thead><tbody>
    ${att.slice(0, 12).map(a => `<tr><td>${esc(jdate(a.date))}</td><td>${badge(ATT_LABEL[a.status] || a.status, a.status === 'present' ? 'green' : a.status === 'absent' ? 'red' : 'amber')}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">ثبت نشده</td></tr>'}
  </tbody></table></div>`)}
  ${internships.length ? card(`<b>کارآموزی</b><div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>تاریخ</th><th>ساعت</th><th>محل</th><th>وضعیت</th></tr></thead><tbody>
    ${internships.map(i => `<tr><td>${esc(jdate(i.date))}</td><td>${fa(i.hours)}</td><td class="small">${esc(i.location || '')}</td>
      <td>${badge(i.status === 'approved' ? 'تأییدشده' : 'در انتظار', i.status === 'approved' ? 'green' : 'amber')}</td></tr>`).join('')}
  </tbody></table></div>`) : ''}`;
};

PAGES.leaves = () => {
  const canManage = ['manager', 'vice', 'office', 'staff'].includes(S.role);
  const mine = S.role === 'parent' ? myChildren().map(k => Number(k.id)) : [Number(S.user.id)];
  let rows = list('leaves');
  if (!canManage) rows = rows.filter(l => mine.includes(Number(l.student_id)));
  rows = rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return `${pageHead('مرخصی و غیبت موجه', fa(rows.length) + ' درخواست', `<button class="btn sm primary" data-act="leave-add">+ درخواست</button>`)}
  ${rows.length ? rows.map(l => card(`<div class="row between"><b>${esc((byId('users', l.student_id) || {}).name || '')}</b>
      ${badge(l.status === 'approved' ? 'تأییدشده' : l.status === 'rejected' ? 'رد شده' : 'در انتظار', l.status === 'approved' ? 'green' : l.status === 'rejected' ? 'red' : 'amber')}</div>
    <div class="small muted">${esc(jdate(l.date))} · ${esc(l.reason || '')}</div>
    ${canManage ? `<div class="row" style="gap:8px;margin-top:8px">
      <button class="btn sm" data-act="leave-set" data-id="${l.id}" data-status="approved">تأیید</button>
      <button class="btn sm ghost" data-act="leave-set" data-id="${l.id}" data-status="rejected">رد</button>
      <button class="btn sm ghost" style="color:#b91c1c" data-act="leave-delete" data-id="${l.id}">حذف</button>
    </div>` : ''}`)).join('') : empty('درخواستی ثبت نشده.')}`;
};

/* مشخصات شناسنامه‌ای و خانوادگی — همان فیلدهایی که از اکسل (یا فرم
   کاربر) ذخیره می‌شوند؛ هر کدام پر بود، نمایش داده می‌شود. */
function userDetailRows(u) {
  const rows = [];
  const add = (label, v) => {
    const t = (v === undefined || v === null) ? '' : String(v).trim();
    if (t && t !== '—') rows.push([label, t]);
  };
  add('تاریخ تولد', u.birth_date ? (typeof impIsoToJalali === 'function' ? impIsoToJalali(u.birth_date) : u.birth_date) : '');
  add('جنسیت', u.gender);
  add('شمارهٔ شناسنامه', [u.shenasname_seri, u.shenasname_serial].filter(x => x && String(x).trim()).join(' — '));
  add('نام پدر', u.father_name);
  add('کد ملی پدر', u.father_nid);
  add('همراه پدر', u.father_phone);
  add('نام مادر', u.mother_name);
  add('کد ملی مادر', u.mother_nid);
  add('همراه مادر', u.mother_phone);
  add('سرپرست', u.guardian);
  add('معدل سال گذشته', u.last_gpa != null ? fa(u.last_gpa) : '');
  add('درس‌های تجدیدی', u.failed_count != null ? fa(u.failed_count) : '');
  add('حمایتی', u.covered);
  add('نوع حمایت', u.org_type);
  add('درصد حمایت', u.org_percent != null ? fa(u.org_percent) + '٪' : '');
  add('استعداد', u.talent);
  add('تلفن ثابت', u.landline);
  add('شمارهٔ همراه', u.phone);
  add('کد ملی', u.national_id);
  add('محل سکونت', [u.residence, u.village].filter(x => x && String(x).trim() && String(x).trim() !== '—').join(' — '));
  add('وضعیت سکونت', u.residence_status);
  add('نشانی', u.address);
  add('خواهر', u.sisters != null ? fa(u.sisters) : '');
  add('برادر', u.brothers != null ? fa(u.brothers) : '');
  add('رشته', u.field);
  add('مدرک', u.degree);
  add('درس تخصصی', u.subject);
  return rows;
}

PAGES.record = () => {
  const k = S.user;
  const grades = list('grades').filter(g => Number(g.student_id) === Number(k.id));
  const att = list('attendance').filter(a => Number(a.student_id) === Number(k.id));
  const pct = att.length ? Math.round(att.filter(a => a.status === 'present').length / att.length * 100) : 0;
  const details = userDetailRows(k);
  return `${pageHead('پروندهٔ من', (byId('classes', k.class_id) || {}).name || '')}
  <div class="grid">${statCard('✅', fa(pct) + '٪', 'حضور', pct >= 90 ? 'green' : 'amber')}
    ${statCard('📝', fa(grades.length), 'نمره')}</div>
  ${details.length ? card(`<b>مشخصات</b><div class="table-wrap" style="margin-top:8px"><table><tbody>
    ${details.map(([l, v]) => `<tr><td class="small muted" style="width:40%">${esc(l)}</td><td class="small">${esc(fa(v))}</td></tr>`).join('')}
  </tbody></table></div>`) : ''}
  ${card(`<div class="table-wrap"><table><thead><tr><th>درس</th><th>نمره</th><th>وضعیت</th></tr></thead><tbody>
    ${grades.map(g => `<tr><td>${esc((byId('subjects', g.subject_id) || {}).name || '')}</td><td><b>${fa(g.score)}</b></td>
      <td>${badge(g.status === 'approved' ? 'تأییدشده' : 'در انتظار', g.status === 'approved' ? 'green' : 'amber')}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">—</td></tr>'}
  </tbody></table></div>`)}`;
};

function studentHome() {
  return studentHomeCard() + PAGES.record();
}
function studentHomeCard() {
  const day = weekdayIndex();
  const cls = S.user.class_id;
  const rows = list('schedule').filter(s => Number(s.class_id) === Number(cls) && Number(s.weekday) === day);
  const bells = new Map(list('bell_schedules').map(b => [Number(b.order), b]));
  const cur = currentBell();
  return `${pageHead('امروز', J_DAYS[day] + ' · ' + jdate(todayISO()), `<button class="btn sm" data-act="sync">🔄</button>`)}
  ${cur ? card(`<div class="small muted">زنگ جاری</div><b>${esc(cur.start)} – ${esc(cur.end)}</b>`) : ''}
  ${card(`<b>برنامهٔ امروز</b><div class="list" style="margin-top:8px">
    ${rows.map(s => { const b = bells.get(Number(s.bell_order)) || {}; const subj = byId('subjects', s.subject_id) || {}; const t = byId('users', s.teacher_id) || {};
      return `<div class="item"><div style="width:56px" class="small"><b>${esc(b.start || '')}</b></div><div class="grow"><div class="t">${esc(subj.name || '')}</div><div class="s">${esc(t.name || '')}</div></div></div>`;
    }).join('') || '<div class="muted small">برنامه‌ای نیست.</div>'}
  </div>`)}`;
}

/* ══════════════ سیستم ══════════════ */
/* ══════════════ مدیر: شبکه و دسترسی ══════════════ */
/* ── کارت «دسترسی از هر اینترنتی» ──────────────────────────────────
   همهٔ کاربران اینترنت خودشان را دارند؛ پس مدرسه باید یک آدرس عمومی
   ثابت داشته باشد. تونل از خود سیستم مدرسه به بیرون باز می‌شود. */
function publicAccessCard(n) {
  const p = n.public || {};
  const ts = (p.tailscale || {});
  const on = !!p.public_url;
  const busy = S.tunnelBusy;
  let state;
  if (on) {
    state = badge('فعال — ' + (/ts\.net$/.test(p.public_url) ? 'Tailscale' : 'دستی'), 'green');
  } else if (ts.installed && !ts.logged_in) {
    state = badge('Tailscale نصب است، وارد نشده', 'amber');
  } else if (!ts.installed) {
    state = badge('ابزاری نصب نیست', 'red');
  } else {
    state = badge('خاموش', 'amber');
  }

  let body;
  if (on) {
    body = `<div class="small muted" style="margin-top:8px">آدرس شما، از هر اینترنتی (خانه، مسافرت، موبایل) کار می‌کند:</div>
      <div class="ltr" style="background:var(--soft);padding:10px;border-radius:8px;margin-top:6px;font-weight:700;word-break:break-all">${esc(p.public_url)}</div>
      <div class="row" style="margin-top:10px;flex-wrap:wrap;gap:6px">
        <button class="btn sm" data-act="copy-url" data-id="${esc(p.public_url)}">کپی آدرس</button>
        <button class="btn sm" data-act="tunnel-refresh">${busy ? '…' : 'بازبینی'}</button>
        <button class="btn sm ghost" data-act="tunnel-off">قطع دسترسی اینترنتی</button>
      </div>`;
  } else if (ts.installed && !ts.logged_in) {
    body = `<div class="small muted" style="margin-top:8px">Tailscale نصب است ولی وارد حساب نشده. یک‌بار وارد شوید (مرورگر باز می‌شود) و بعد دکمهٔ فعال‌سازی را بزنید.</div>
      <div class="row" style="margin-top:10px;flex-wrap:wrap;gap:6px">
        <button class="btn sm primary" data-act="tunnel-login">ورود به Tailscale</button>
        <button class="btn sm" data-act="tunnel-refresh">بازبینی وضعیت</button>
      </div>`;
  } else if (ts.installed) {
    body = `<div class="small muted" style="margin-top:8px">Tailscale نصب و آماده است. با یک کلیک آدرس ثابت عمومی ساخته می‌شود (همان آدرسی که بعد از این، همه از هر اینترنتی وارد می‌شوند).</div>
      <div class="row" style="margin-top:10px;flex-wrap:wrap;gap:6px">
        <button class="btn sm primary" data-act="tunnel-enable">${busy ? 'در حال فعال‌سازی…' : 'فعال‌سازی آدرس عمومی'}</button>
        <button class="btn sm ghost" data-act="tunnel-refresh">بازبینی</button>
      </div>`;
  } else {
    body = `<ol class="small" style="margin:8px 0 0;padding-inline-start:18px;line-height:2">
        <li><a href="${esc(ts.download || 'https://tailscale.com/download/windows')}" target="_blank">Tailscale</a> را روی همین سیستم نصب کنید (رایگان، بدون کارت بانکی).</li>
        <li>با حساب رایگان وارد شوید و برگردید؛ بقیه‌اش یک کلیک است.</li>
      </ol>
      <div class="row" style="margin-top:10px;flex-wrap:wrap;gap:6px">
        <button class="btn sm primary" data-act="tunnel-login">ورود / نصب Tailscale</button>
        <button class="btn sm ghost" data-act="tunnel-refresh">بازبینی</button>
      </div>`;
  }

  return card(`<div class="row between"><b>🌍 دسترسی از هر اینترنتی (تونل)</b>${state}</div>
    <div class="small muted" style="margin-top:6px">هیچ کاربری لازم نیست روی مودم مدرسه باشد: سیستم مدرسه یک تونل خروجی می‌سازد و همه با یک آدرس HTTPS ثابت وصل می‌شوند.</div>
    ${body}
    <div class="small muted" style="margin-top:10px">🔒 با فعال شدن آدرس عمومی، سرور از اینترنت دیده می‌شود: PIN همهٔ کاربران را جدی بگیرید و دستگاه‌های ناشناس را از «دستگاه‌ها» باطل کنید.</div>`);
}

PAGES.network = () => {
  if (S.role !== 'manager') return pageHead('شبکه') + empty('دسترسی ندارید.');
  const pub = S.server.publicUrl || '';
  const n = S.network || {};
  const tun = n.tunnel || {};
  const status = !pub
    ? badge('تنظیم نشده', 'amber')
    : (tun.reachable ? badge('در دسترس از اینترنت', 'green') : badge('در دسترس نیست', 'red'));
  return `${pageHead('شبکه و دسترسی', 'هر کاربر اینترنت خودش را دارد؛ همه باید از یک آدرس ثابت وارد شوند',
    `<button class="btn sm" data-act="net-refresh">بازبینی</button>`)}
  ${card(`<div class="row between"><b>آدرس رسمی (HTTPS)</b>${status}</div>
    <div class="small muted" style="margin-top:8px">این آدرس را روی همهٔ گوشی‌ها و رایانه‌ها باز کنید. بدون آن، برنامه فقط داخل Wi-Fi مدرسه کار می‌کند.</div>
    <form data-form="network" style="margin-top:10px">
      <input class="input ltr" name="public_url" value="${esc(pub)}" placeholder="https://payesh.school.ts.net" inputmode="url" autocomplete="off">
      <button class="btn primary block" style="margin-top:8px">ذخیرهٔ آدرس</button>
    </form>
    ${tun.reachable ? `<div class="small muted" style="margin-top:8px">آخرین بررسی: ${esc(tun.latency_ms != null ? fa(tun.latency_ms) + ' میلی‌ثانیه' : '—')}${tun.same_server === false ? ' · ⚠ پاسخ از سرور دیگری آمد' : ''}</div>`
      : (tun.configured ? `<div class="small muted" style="margin-top:8px;color:var(--red,#b91c1c)">تونل پاسخ نداد (${esc(tun.error || 'نامشخص')}) — Tailscale Funnel روی سیستم روشن است؟</div>` : '')}
  `)}
  ${pub ? card(`<div class="row between" style="align-items:flex-start">
      <div><b>کد QR برای نصب سریع</b>
        <div class="small muted" style="margin-top:6px">این کد را روی تخته بزنید یا در گروه بفرستید؛ با دوربین گوشی باز می‌شود.</div>
        <div class="row" style="margin-top:8px"><a class="btn sm" href="${esc(pub)}" target="_blank">باز کردن</a>
          <button class="btn sm" data-act="copy-url" data-id="${esc(pub)}">کپی آدرس</button></div>
      </div>
      <img alt="QR" src="/api/qr?text=${encodeURIComponent(pub)}&scale=6" style="width:150px;height:150px;border-radius:10px;background:#fff;padding:6px">
    </div>`) : ''}
  ${publicAccessCard(n)}
  ${card(`<div class="row between" style="align-items:flex-start">
      <div><b>آدرس‌های شبکهٔ محلی</b>
        <div class="small muted" style="margin-top:6px">
          ${(n.lan_urls || []).map(u => `<div class="ltr">${esc(u)}</div>`).join('') || '<div>—</div>'}
          <div style="margin-top:6px">این آدرس‌ها فقط وقتی گوشی به همان Wi-Fi مدرسه وصل است کار می‌کنند.</div>
          <div style="margin-top:4px">اگر گوشی با همین Wi-Fi هم وصل نشد، احتمالاً Wi-Fi مدرسه اجازهٔ ارتباط دستگاه‌ها با هم را نمی‌دهد (Client Isolation) — در این حالت فقط آدرس رسمی HTTPS بالا کار می‌کند.</div>
        </div>
        ${(n.lan_urls || []).length ? `<div class="row" style="margin-top:8px">
          <button class="btn sm" data-act="copy-url" data-id="${esc(n.lan_urls[0])}">کپی آدرس محلی</button>
          <a class="btn sm" href="${esc(n.lan_urls[0])}" target="_blank">باز کردن</a></div>` : ''}
      </div>
      ${(n.lan_urls || []).length ? `<img alt="QR" src="/api/qr?text=${encodeURIComponent(n.lan_urls[0])}&scale=6" style="width:150px;height:150px;border-radius:10px;background:#fff;padding:6px">` : ''}
    </div>
    ${(n.lan_urls || []).length ? `<div class="small muted" style="margin-top:6px">گوشی داخل مدرسه: این کد را با دوربین گوشی اسکن کنید — بدون تایپ هیچ آدرسی باز می‌شود.</div>` : ''}`)}
  ${card(`<div class="row between"><b>📥 صندوقچهٔ آفلاین</b>${(S.outbox && S.outbox.pending) ? badge('در انتظار اعمال', 'amber') : badge('خالی', 'green')}</div>
    <div class="small muted" style="margin-top:6px">وقتی بعضی دستگاه‌ها خاموش‌اند، ثبت‌هایشان این‌جا می‌ماند و اولین دستگاهی که روشن شود (مدرسه، خانه یا گوشیِ کادر) خودکار اعمالشان می‌کند — لازم نیست کسی کاری کند.</div>
    <div class="row" style="margin-top:8px"><button class="btn sm" data-act="outbox-sync">بررسی و اعمال اکنون</button></div>`)}

  `;
};

/* ── کارت به‌روزرسانی ──────────────────────────────────────────────── */
function updateCard() {
  const r = S.remote || {};
  const last = r.last || S.updateLast || null;
  const running = S.server && S.server.version;
  let line;
  if (!r.ok && r.error) {
    line = `<div class="small" style="color:var(--amber,#b45309);margin-top:6px">منبع آپدیت در دسترس نیست (${esc(r.error === 'source_unreachable' ? 'اینترنت یا آینه' : r.error)}). برنامه بدون آپدیت هم کار می‌کند.</div>`;
  } else if (r.available) {
    const kb = Math.max(1, Math.round((r.total_size || 0) / 1024));
    line = `<div class="small" style="margin-top:6px">نسخهٔ <b>${esc(r.remote_version)}</b> منتشر شده است — ${fa((r.changed || []).length)} فایل تغییر کرده، مجموع ${fa(kb)} کیلوبایت${r.needs_restart ? ' · پس از نصب، برنامه خودکار دوباره راه می‌افتد' : ''}.</div>`;
  } else if (r.ok) {
    line = `<div class="small muted" style="margin-top:6px">برنامه به‌روز است.${r.checked_at ? ' آخرین بررسی: ' + esc(jdate(r.checked_at)) : ''}</div>`;
  } else {
    line = `<div class="small muted" style="margin-top:6px">برای دیدن نسخهٔ تازه، «بررسی آپدیت» را بزنید.</div>`;
  }
  const st = S.upd || {};
  const stLine = st && st.status && st.status !== 'idle'
    ? `<div class="small" style="margin-top:6px">
        ${st.status === 'downloading' ? `⬇️ در حال دانلود ${fa(st.percent || 0)}٪ (${fa(st.receivedKb || 0)} از ${fa(st.totalKb || 0)} کیلوبایت)`
          : st.status === 'ready' ? '✅ دانلود شد و آمادهٔ نصب است'
          : st.status === 'installing' ? '⚙️ در حال نصب…'
          : st.status === 'error' ? `⚠️ ${esc(st.errorText || 'به‌روزرسانی انجام نشد')}`
          : st.status === 'latest' ? '✅ برنامه به‌روز است'
          : esc(st.status)}
      </div>`
    : '';
  const metaLine = (st && st.latest)
    ? `<div class="small muted" style="margin-top:4px">
        نسخهٔ منتشرشده: <b>${esc(st.latest)}</b>
        ${st.sizeKb ? ' · دانلود: ' + fa(st.sizeKb) + ' کیلوبایت' : ''}
        ${st.fullMb ? ' · نصب‌کنندهٔ کامل: ' + fa(st.fullMb) + ' مگابایت' : ''}
        ${st.mode === 'patch' && st.savedMb ? ' · صرفه‌جویی ' + fa(st.savedMb) + ' مگابایت' : ''}
        ${st.checkedAt ? ' · آخرین بررسی: ' + esc(jdate(st.checkedAt)) : ''}
      </div>`
    : '';
  const lastLine = last && last.applied !== false && last.version
    ? `<div class="small muted" style="margin-top:6px">آخرین به‌روزرسانی نصب‌شده: ${esc(last.version)}${last.at ? ' — ' + esc(jdate(last.at)) : ''}${last.files != null ? ' (' + fa(last.files) + ' فایل، ' + fa(Math.max(1, Math.round((last.bytes || 0) / 1024))) + ' کیلوبایت)' : ''}</div>`
    : '';
  return card(`<b>به‌روزرسانی برنامه</b>
    <div class="small muted" style="margin-top:4px">نسخهٔ در حال اجرا: <b>${esc(running || '—')}</b>${r.remote_version && r.remote_version !== running ? ' · منتشرشده: <b>' + esc(r.remote_version) + '</b>' : ''}</div>
    ${line}${metaLine}${stLine}${lastLine}
    <div class="row" style="margin-top:10px;flex-wrap:wrap;gap:6px">
      <button class="btn sm" data-act="update-recheck">${S.remoteBusy ? '…' : 'بررسی آپدیت'}</button>
      ${r.available && st.status !== 'ready' ? `<button class="btn sm primary" data-act="update-now">دانلود و نصب (یک کلیک)</button>` : ''}
      ${r.available && st.status !== 'ready' ? `<button class="btn sm ghost" data-act="update-download">فقط دانلود</button>` : ''}
      ${st.status === 'ready' ? `<button class="btn sm primary" data-act="update-install">نصب نسخهٔ ${esc(st.latest || '')}</button>` : ''}
      ${last && last.version ? `<button class="btn sm ghost" data-act="update-rollback">بازگشت به نسخهٔ قبل</button>` : ''}
    </div>
    <form data-form="update" class="row" style="margin-top:12px;flex-wrap:wrap;gap:8px;align-items:flex-end">
      <label class="field grow" style="min-width:220px"><span>منبع آپدیت (اختیاری)</span>
        <input class="input ltr" name="base" placeholder="https://…/payesh.local/main/" value="${esc(r.base || '')}"></label>
      <button class="btn sm" type="submit">ذخیره</button>
    </form>
    <div class="small muted" style="margin-top:6px">${r.bases && r.bases.length ? 'آینه‌ها: ' + r.bases.map(b => esc(b.replace(/^https?:\/\//, '').replace(/\/$/, ''))).join(' · ') : ''}</div>
    <label class="row" style="margin-top:10px;gap:8px;align-items:center">
      <input type="checkbox" data-act="update-auto" ${r.auto ? 'checked' : ''}> <span class="small">بررسی خودکار نسخهٔ تازه (پیشنهاد می‌شود)</span>
    </label>
    <label class="row" style="margin-top:6px;gap:8px;align-items:center">
      <input type="checkbox" data-act="update-autoapply" ${r.auto_apply ? 'checked' : ''}> <span class="small">نصب خودکار بدون پرسش (شب‌ها، فقط فایل‌های تغییرکرده)</span>
    </label>
    <div class="small muted" style="margin-top:8px">هیچ‌وقت داده‌های مدرسه (پوشهٔ data) دست نمی‌خورد؛ نسخهٔ قبلی برای بازگشت نگه داشته می‌شود.</div>`);
}

function clientUpdateCard() {
  return card(`<b>به‌روزرسانی برنامه</b>
    <div class="small muted" style="margin-top:6px">${S.update ? `نسخهٔ ${esc(S.update.version)} آماده است؛ فقط فایل‌های تغییرکرده دانلود می‌شود.` : 'برنامه به‌روز است.'}</div>
    <div class="row" style="margin-top:8px">
      <button class="btn sm" data-act="update-check">بررسی به‌روزرسانی</button>
      ${S.update ? `<button class="btn sm primary" data-act="update-apply">اعمال (${Math.round((S.update.total_size || 0) / 1024)}KB)</button>` : ''}
    </div>
    <div class="small muted" style="margin-top:8px">به‌روزرسانی خود سیستم را مدیر انجام می‌دهد؛ دستگاه شما خودکار تازه می‌شود.</div>`);
}

PAGES.system = () => {
  const isManager = S.role === 'manager';
  const dev = S.boot && S.boot.counts;
  return `${pageHead('سیستم', 'نسخه ' + esc(S.server.version || '') , '')}
  ${card(`<div class="row between"><b>وضعیت</b>${S.online ? badge('متصل', 'green') : badge('آفلاین', 'amber')}</div>
    <div class="small muted" style="margin-top:6px">
      کاربر: ${esc(S.user.name)} · نقش: ${esc(ROLE_FA[S.role] || S.role)}<br>
      آخرین همگام‌سازی: ${S.lastSync ? esc(jdate(S.lastSync) + ' ' + new Date(S.lastSync).toLocaleTimeString('fa-IR')) : '—'}<br>
      تغییرات در صف: ${fa(S.queue.length)}
    </div>
    <div class="row" style="margin-top:10px">
      <button class="btn sm" data-act="sync">همگام‌سازی</button>
      <button class="btn sm" data-act="lock">🔒 خروج</button>
    </div>`)}
  ${liveCard()}
  ${isManager ? phoneAccessCard() : ''}
  ${accountCard()}
  ${isManager ? updateCard() : clientUpdateCard()}
  ${isManager ? managerSystemSections() : changePinCard()}
  ${card(`<b>راهنمای دستگاه‌ها</b><div class="small muted" style="margin-top:6px">
    ${S.server.publicUrl
      ? `آدرس رسمی را روی گوشی باز کنید و «افزودن به صفحهٔ اصلی» را بزنید:<br><span class="ltr" style="font-weight:700">${esc(S.server.publicUrl)}</span>`
      : `همهٔ دستگاه‌ها از طریق حافظهٔ مشترک ابری به همین اطلاعات می‌رسند؛ آدرس زیر فقط آدرس همین دستگاه است:<br><span class="ltr" style="font-weight:700">http://${esc(location.host)}</span>`}
    <br><a href="/install" target="_blank">صفحهٔ نصب و راهنما</a>
  </div>`)}`;
};

/* وضعیت دسترسی گوشی‌ها — یک نگاه، یک دکمه */
/* وضعیت همگام‌سازی زنده — برای اینکه همه ببینند هر ثانیه به‌روز می‌شود */
function liveCard() {
  const last = (typeof S !== 'undefined' && S.lastSync) ? S.lastSync : '';
  const stamp = last
    ? new Date(last).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—';
  return card(`<div class="row between" style="margin-bottom:6px">
      <b>⚡ همگام‌سازی زنده</b>${badge('هر ۱ ثانیه', 'green')}</div>
    <div class="small muted" style="line-height:1.9">
      هر تغییری که هر کاربر بدهد، همان لحظه در حافظهٔ مشترک نوشته می‌شود و در همان ثانیه به
      دستگاه‌های دیگر می‌رسد. اگر دستگاهِ مقصد خاموش باشد، داده در حافظه می‌ماند و
      اولین ثانیه‌ای که آنلاین شود تحویلش می‌گیرد.
    </div>
    <div class="small" style="margin-top:8px">آخرین به‌روزرسانی روی این دستگاه: <b class="ltr">${esc(stamp)}</b></div>`);
}

function phoneAccessCard() {
  const r = S.phoneCheck;
  const state = !S.server.cloudReady
    ? badge('حافظهٔ مشترک آماده نشده', 'amber')
    : (r ? (r.ok ? badge('گوشی‌ها وصل‌اند', 'green') : badge('گوشی‌ها وصل نیستند', 'red')) : badge('بررسی نشده', 'amber'));
  return card(`<div class="row between"><b>📱 گوشی‌ها به حافظهٔ مدرسه وصل‌اند؟</b>${state}</div>
    <div class="small muted" style="margin-top:6px">اگر گوشی پیام «به حافظه نرسیدیم» می‌دهد، این دکمه را بزنید؛ خودش بررسی و درست می‌کند.</div>
    <div class="row" style="margin-top:10px"><button class="btn sm primary" data-act="cloud-phone-check">بررسی و درست‌کردن</button></div>
    <div id="cloud-phone-out" class="small" style="margin-top:8px">${r ? phoneCheckHtml(r) : ''}</div>`);
}

/* کارت حساب: نام کاربری + تغییر رمز عبور (هر نقشی) */
function accountCard() {
  const u = S.user || {};
  const phone = u.phone || (S.boot && S.boot.user && S.boot.user.phone) || '';
  return card(`<div class="row between"><b>👤 حساب من</b>${badge(ROLE_FA[S.role] || S.role, '')}</div>
    <div class="small muted" style="margin-top:6px">نام: <b>${esc(u.name || '')}</b></div>
    <div class="small muted" style="margin-top:2px">نام کاربری (شمارهٔ همراه): <span class="ltr">${esc(phone || '—')}</span></div>
    ${u.password ? `<div class="small muted" style="margin-top:2px">رمز عبور فعلی: <span class="ltr"><b>${esc(u.password)}</b></span></div>` : ''}
    <form data-form="own-password" style="margin-top:10px">
      <label class="field"><span>رمز فعلی</span><input class="input ltr" type="password" name="current" autocomplete="current-password"></label>
      <label class="field"><span>رمز تازه</span><input class="input ltr" type="password" name="next" autocomplete="new-password"></label>
      <label class="field"><span>تکرار رمز تازه</span><input class="input ltr" type="password" name="again" autocomplete="new-password"></label>
      <button class="btn primary block">تغییر رمز عبور</button>
    </form>
    <div class="small muted" style="margin-top:6px">اگر رمز فعلی را نمی‌دانید، از مدیر بخواهید رمز تازه بگذارد.</div>`);
}

function changePinCard() {
  return card(`<b>تغییر PIN</b>
    <div class="row" style="margin-top:8px">
      <input class="input" id="new-pin" inputmode="numeric" maxlength="6" placeholder="PIN جدید (۴ تا ۶ رقم)" style="max-width:220px">
      <button class="btn sm" data-act="pin-change">ذخیره</button>
    </div>`);
}

function managerSystemSections() {
  const stats = S.boot && S.boot.counts || {};
  return `
  ${card(`<b>پشتیبان‌گیری</b>
    <div class="small muted" style="margin-top:6px">هر ساعت خودکار گرفته می‌شود و ۴۸ نسخه نگه داشته می‌شود.</div>
    <div class="row" style="margin-top:8px"><button class="btn sm" data-act="backup-now">پشتیبان همین حالا</button>
      <button class="btn sm ghost" data-act="backup-list">فهرست نسخه‌ها</button></div>`)}
  ${card(`<b>حافظهٔ ابری</b>
    <div class="small muted" style="margin-top:6px">جایی که وقتی هیچ سیستمی روشن نیست، پیام‌ها و تکالیف نگه داشته می‌شوند تا اولین دستگاه همه را بردارد.</div>
    <button class="btn sm" style="margin-top:8px" data-act="goto" data-route="cloud">تنظیم صندوقچه</button>`)}
  ${card(`<b>دستگاه‌های متصل</b><div id="devices-box" class="small muted" style="margin-top:6px">برای دیدن فهرست، دکمه را بزنید.</div>
    <button class="btn sm" style="margin-top:8px" data-act="devices-list">نمایش دستگاه‌ها</button>`)}
  ${card(`<b>تنظیمات مدرسه</b>
    <label class="field" style="margin-top:8px"><span>نام مدرسه</span><input class="input" id="set-name" value="${esc((S.server.school && S.server.school.name) || '')}"></label>
    <div class="row"><button class="btn sm" data-act="settings-save">ذخیره</button></div>
    <div class="small muted" style="margin-top:8px">قابلیت‌ها: ${Object.entries((S.server.school && S.server.school.capabilities) || {}).filter(([, v]) => v).map(([k]) => esc(k)).join(' · ')}</div>`)}
  ${card(`<b>آمار پایگاه داده</b><div class="small muted" style="margin-top:6px">
    کاربران: ${fa(stats.users || 0)} · کلاس‌ها: ${fa(stats.classes || 0)} · حضور: ${fa(stats.attendance || 0)} · نمره: ${fa(stats.grades || 0)}
  </div><button class="btn sm" style="margin-top:8px" data-act="audit-list">سابقهٔ تغییرات</button>`)}
  ${changePinCard()}`;
}

/* ══════════════════ حافظهٔ ابری ══════════════════ */
PAGES.cloud = () => {
  const c = S.cloud || null;
  const busy = S._cloudBusy;
  const edit = !!S.cloudEdit;
  const row = (id, label, val, ph, type) => `<label class="field" style="margin-top:8px"><span>${label}</span>
    <input class="input" id="${id}" ${type === 'password' ? 'type="password"' : ''} placeholder="${esc(ph || '')}" value="${esc(val || '')}"></label>`;
  const ready = !!(c && c.endpoint && c.accessKey && c.secret && c.bucket);
  return `${pageHead('حافظهٔ ابری', 'جایی در اینترنت که همهٔ دستگاه‌ها رویش می‌نویسند', '')}
  ${card(`<div class="small muted" style="line-height:1.9">
    وقتی هیچ سیستمی در مدرسه روشن نیست، پیام‌ها و تکالیف باید جایی بمانند تا اولین دستگاهِ روشن‌شده همه را بردارد.
    اینجا همان «صندوقچه» است.
  </div>`)}
  ${c === null ? card(`<div class="muted small">در حال خواندن تنظیمات…</div>`) : card(`
    <div class="row between"><b>وضعیت صندوقچه</b>${ready ? badge('آماده', 'green') : (c.accessKey ? badge('در حال آماده‌سازی', 'amber') : badge('تنظیم نشده', 'amber'))}</div>
    ${c.built_in
      ? `<div class="small muted" style="margin-top:8px;line-height:1.9">✅ <b>از قبل داخل برنامه تنظیم شده است</b> — لازم نیست چیزی وارد کنید.
          ${c.bucket ? `<br>صندوقچه: <span class="ltr">${esc(c.bucket)}</span>` : '<br>نام صندوقچه به‌زودی خودکار پیدا می‌شود (به اینترنت نیاز دارد).'}
          <br>سرور: <span class="ltr">${esc(c.endpoint || '')}</span></div>`
      : `<div class="small muted" style="margin-top:8px">تنظیمات دستی روی این دستگاه فعال است (بر پیش‌فرضِ داخل برنامه مقدم است).</div>`}
    <div class="row" style="margin-top:12px;flex-wrap:wrap;gap:6px">
      <button class="btn sm" data-act="cloud-test" ${busy || !ready ? 'disabled' : ''}>آزمایش اتصال</button>
      <button class="btn sm ghost" data-act="cloud-cors" ${busy || !ready ? 'disabled' : ''}>تنظیم خودکار CORS</button>
      <button class="btn sm ghost" data-act="cloud-edit">${edit ? 'بستن کادر تغییر' : 'تغییر تنظیمات'}</button>
      ${c.built_in ? '' : `<button class="btn sm ghost" data-act="cloud-reset">بازگشت به پیش‌فرض برنامه</button>`}
    </div>
    <div id="cloud-out" class="small" style="margin-top:10px"></div>`)}

  ${c && edit ? card(`
    <div class="row between"><b>تنظیمات صندوقچه (تغییر)</b></div>
    <div class="small muted" style="margin-top:4px">فقط وقتی لازم است که صندوقچه عوض شود. مقدار خالی = همان مقدار فعلی می‌ماند.</div>
    ${row('cl-endpoint', 'آدرس سرویس (Endpoint)', c.endpoint, 'https://s3.ir-central1.arvanstorage.ir')}
    ${row('cl-bucket', 'نام صندوقچه (اختیاری — خودکار پیدا می‌شود)', c.bucket, '')}
    ${row('cl-region', 'منطقه (اختیاری)', c.region, 'ir-central1')}
    ${row('cl-access', 'کلید عمومی (Access Key)', c.accessKey, '')}
    ${row('cl-secret', 'کلید خصوصی (Secret Key)', '', 'کلید خصوصی فعلی می‌ماند', 'password')}
    <div class="small muted" style="margin-top:6px">کلید خصوصی ذخیره می‌شود ولی دیگر نمایش داده نمی‌شود؛ برای تغییر، مقدار تازه بگذارید.</div>
    <div class="row" style="margin-top:10px;flex-wrap:wrap;gap:6px">
      <button class="btn sm" data-act="cloud-save" ${busy ? 'disabled' : ''}>ذخیرهٔ تنظیمات تازه</button>
      <button class="btn sm ghost" data-act="cloud-test-browser" ${busy ? 'disabled' : ''}>آزمایش از همین دستگاه</button>
    </div>`) : ''}

  ${card(`<b>📱 دسترسی گوشی‌ها</b>
    <div class="small muted" style="margin-top:6px;line-height:1.9">
      گوشی و رایانهٔ خانه با همین حافظهٔ مشترک کار می‌کنند. این دکمه همه‌چیز را خودش بررسی و درست می‌کند:
      صندوقچه پیدا می‌شود، اجازهٔ خواندن برای گوشی گذاشته می‌شود، و نتیجه را همین‌جا می‌بینید.
    </div>
    <div class="row" style="margin-top:10px;flex-wrap:wrap;gap:6px">
      <button class="btn sm primary" data-act="cloud-phone-check" ${busy ? 'disabled' : ''}>بررسی و درست‌کردن دسترسی گوشی</button>
    </div>
    <div id="cloud-phone-out" class="small" style="margin-top:10px">${S.phoneCheck ? phoneCheckHtml(S.phoneCheck) : ''}</div>`)}

  ${card(`<b>CORS — اجازهٔ مرورگر</b>
    <div class="small muted" style="margin-top:6px;line-height:1.9">
      گوشی‌ها مستقیم با صندوقچه حرف می‌زنند، پس صندوقچه باید به مرورگر اجازه بدهد.
      دکمهٔ <b>«تنظیم خودکار CORS»</b> همین کار را از داخل برنامه انجام می‌دهد؛ لازم نیست در پنل دنبالش بگردید.
      اگر کلید اجازهٔ مدیریت صندوقچه را نداشت، باید در پنل
      (فضای ابری ← صندوقچه ← عملیات ← تنظیمات CORS) دستی یک قانون با
      <span class="ltr">*</span> و متدهای <span class="ltr">GET, PUT, DELETE, HEAD</span> بسازید.
    </div>`)}`;
};

/* نتیجهٔ «بررسی دسترسی گوشی» به زبان ساده */
function phoneCheckHtml(r) {
  if (!r) return '';
  const ok = !!r.ok;
  const steps = (r.steps || []).map(st => {
    const label = {
      bucket: 'پیدا کردن صندوقچه',
      cors: 'اجازهٔ خواندن برای گوشی',
      set_cors: 'گذاشتن اجازهٔ خواندن',
      cors_after: 'آزمایش دوباره بعد از تنظیم',
    }[st.step] || st.step;
    const good = st.ok !== false;
    return `<div>${good ? '✅' : '❌'} ${esc(label)}${st.status ? ' — کد ' + fa(st.status) : ''}${st.error ? ' — ' + esc(st.error) : ''}</div>`;
  }).join('');
  return `${ok ? badge('گوشی می‌تواند بخواند و بنویسد', 'green') : badge('هنوز نشده', 'amber')}
    <div style="margin-top:6px;line-height:1.9">${steps}</div>
    ${ok ? '' : '<div class="muted" style="margin-top:6px">اگر «گذاشتن اجازه» خطا داد، کلیدِ صندوقچه اجازهٔ مدیریت ندارد؛ در پنل ابری یک قانون CORS با <span class="ltr">*</span> و متدهای GET/PUT/DELETE/HEAD بسازید.</div>'}`;
}

/* ══════════════ کنش‌ها ══════════════ */
/* هر پنجره و پیامی که باز می‌شود باید جایی برای نشستن داشته باشد؛
   اگر صفحهٔ میزبان آن را نداشته باشد، خودمان می‌سازیم تا هیچ دکمه‌ای
   بی‌اثر نماند. */
function layerRoot(id) {
  let el = document.getElementById(id);
  if (!el) { el = document.createElement('div'); el.id = id; document.body.appendChild(el); }
  return el;
}

/* ── پنجرهٔ بازشو ─────────────────────────────────────────────────────
   هیچ «هندلر درون‌خطی» (onclick) نداریم؛ همه از یک‌جا مدیریت می‌شوند.
   دلیلش پیدا شدن همین ایراد بود: `onclick="event.stopPropagation()"` روی
   خودِ پنجره، کلیک دکمهٔ ✕ را هم می‌بلعید و دکمه هیچ‌جا کار نمی‌کرد.
   حالا:
     • دکمهٔ ✕ → data-act="modal-close" → بستن
     • کلیک روی پس‌زمینهٔ تیره → بستن (فقط اگر مستقیم روی خودش بزنند)
     • کلید Esc → بستن
   ─────────────────────────────────────────────────────────────────── */
function modal(html) {
  S.modal = html;
  layerRoot('modal-root').innerHTML = `<div class="modal-bg" data-act="modal-bg"><div class="modal" role="dialog" aria-modal="true">
    <div class="row between" style="margin-bottom:8px">
      <b>${esc(S.modalTitle || '')}</b>
      <button type="button" class="btn sm ghost" data-act="modal-close" aria-label="بستن" title="بستن">✕</button>
    </div>
    ${html}</div></div>`;
}
function closeModal() { S.modal = null; layerRoot('modal-root').innerHTML = ''; }

function pairCardHtml(r) {
  return `<div class="paircard">
    <div class="who">${esc(r.user.name)}</div>
    <div class="small muted">${esc(ROLE_FA[r.user.role] || r.user.role)}</div>
    <div class="code">${esc(r.display)}</div>
    <div class="small muted">اعتبار: ${esc(jdate(r.expires_at))}</div>
  </div>
  <div class="small muted">کاربر در صفحهٔ ورود، «ورود با کارت پیوند» را می‌زند، این کد را وارد می‌کند و یک PIN برای خودش انتخاب می‌کند. هر کد فقط یک‌بار کار می‌کند.</div>
  <button class="btn block" style="margin-top:10px" data-act="print">🖨️ چاپ کارت</button>`;
}

async function actPairCode(id) {
  try {
    const r = await api('/api/admin/pair-code', { method: 'POST', body: { user_id: Number(id) } });
    S.modalTitle = 'کارت پیوند';
    modal(pairCardHtml(r));
  } catch (e) { toast('ساخت کد ناموفق: ' + e.message, 'err'); }
}

async function actAttendanceSave(classId, bell) {
  const draft = S.attDraft;
  if (!draft || !draft.map.size) {
    /* اگر چیزی دستی تغییر نکرده، همه «حاضر» فرض می‌شوند */
  }
  const date = todayISO();
  const roster = list('users').filter(u => u.role === 'student' && Number(u.class_id) === Number(classId));
  const existing = new Map(attendanceFor(classId, date).map(a => [Number(a.student_id), a]));
  let n = 0;
  for (const s of roster) {
    const status = draft && draft.map.has(s.id) ? draft.map.get(s.id) : (existing.has(s.id) ? existing.get(s.id).status : 'present');
    const ex = existing.get(s.id);
    if (ex && ex.status === status) continue;
    putLocal('attendance', {
      id: ex ? ex.id : undefined, student_id: s.id, class_id: Number(classId), date, status,
      note: '', source: 'teacher', school_id: 1, _version: ex ? ex._version : 0,
    });
    n++;
  }
  if (draft) draft.map.clear();
  toast(n ? fa(n) + ' رکورد ذخیره شد' : 'تغییری نبود', 'ok');
  saveCache();
  await flushQueue();
  go('home');
}

async function actGradeSave() {
  const inputs = [...document.querySelectorAll('[data-grade]')];
  const sel = S.gradeSel || {};
  const subject = byId('subjects', sel.subject) || {};
  const existing = new Map(list('grades')
    .filter(g => Number(g.class_id) === Number(sel.class) && Number(g.subject_id) === Number(sel.subject) && String(g.term) === String(sel.term))
    .map(g => [Number(g.student_id), g]));
  let n = 0;
  for (const inp of inputs) {
    const sid = Number(inp.getAttribute('data-grade'));
    const raw = norm(inp.value).trim();
    if (!raw) continue;
    const score = Number(raw);
    if (isNaN(score) || score < 0 || score > 20) { toast('نمرهٔ نامعتبر برای یکی از دانش‌آموزان', 'err'); continue; }
    const ex = existing.get(sid);
    if (ex && Number(ex.score) === score) continue;
    const row = {
      id: ex ? ex.id : undefined, student_id: sid, class_id: Number(sel.class), subject_id: Number(sel.subject),
      term: sel.term, kind: subject.workshop ? 'practical' : 'midterm',
      score, status: S.role === 'manager' ? 'approved' : 'pending', school_id: 1, _version: ex ? ex._version : 0,
    };
    if (subject.workshop) row.practical_score = score;
    putLocal('grades', row);
    n++;
  }
  toast(n ? fa(n) + ' نمره ذخیره شد' : 'تغییری نبود', 'ok');
  saveCache();
  await flushQueue();
  render();
}

function actLeaveAdd() {
  const kids = S.role === 'parent' ? myChildren() : [S.user];
  S.modalTitle = 'درخواست مرخصی';
  modal(`<form data-form="leave">
    <label class="field"><span>دانش‌آموز</span><select class="input" name="student_id">
      ${kids.map(k => `<option value="${k.id}">${esc(k.name)}</option>`).join('')}
    </select></label>
    <label class="field"><span>تاریخ</span><input class="input ltr" type="date" name="date" value="${todayISO()}"></label>
    <label class="field"><span>علت</span><textarea class="input" name="reason" placeholder="مثلاً مراجعه به پزشک"></textarea></label>
    <button class="btn primary block">ثبت درخواست</button>
  </form>`);
}

function actAnnAdd(row) {
  const editing = row && row.id;
  S.modalTitle = editing ? 'ویرایش اطلاعیه' : 'اطلاعیهٔ جدید';
  const sev = editing ? String(row.severity || 'normal') : 'normal';
  modal(`<form data-form="ann">
    ${editing ? `<input type="hidden" name="id" value="${esc(row.id)}">` : ''}
    <label class="field"><span>عنوان</span><input class="input" name="title" required value="${esc(editing ? row.title : '')}"></label>
    <label class="field"><span>متن</span><textarea class="input" name="body" required>${esc(editing ? row.body : '')}</textarea></label>
    <label class="field"><span>اهمیت</span><select class="input" name="severity">
      <option value="normal" ${sev === 'normal' ? 'selected' : ''}>عادی</option>
      <option value="info" ${sev === 'info' ? 'selected' : ''}>اطلاع‌رسانی</option>
      <option value="important" ${sev === 'important' ? 'selected' : ''}>مهم</option></select></label>
    <button class="btn primary block">${editing ? 'ذخیرهٔ تغییرات' : 'انتشار'}</button>
  </form>`);
}

function actUserEdit(id) {
  const u = byId('users', Number(id));
  if (!u) return;
  S.modalTitle = 'ویرایش کاربر — ' + u.name;
  modal(`<form data-form="user-edit">
    <input type="hidden" name="id" value="${esc(u.id)}">
    <label class="field"><span>نام و نام خانوادگی</span><input class="input" name="name" value="${esc(u.name)}" required></label>
    <label class="field"><span>نام کاربری (شمارهٔ همراه)</span>
      <input class="input ltr" name="phone" inputmode="numeric" maxlength="11" value="${esc(u.phone || '')}" placeholder="09xxxxxxxxx"></label>
    <div class="row">
      <label class="field grow"><span>تاریخ تولد (شمسی)</span>
        <input class="input ltr" name="birth_date" value="${esc(window.impIsoToJalali ? impIsoToJalali(u.birth_date) : '')}" placeholder="1390/05/12"></label>
      <label class="field grow"><span>جنسیت</span>
        <select class="input" name="gender">
          <option value="">—</option>
          <option value="پسر" ${u.gender === 'پسر' ? 'selected' : ''}>پسر</option>
          <option value="دختر" ${u.gender === 'دختر' ? 'selected' : ''}>دختر</option>
        </select></label>
    </div>
    ${userExtraFieldsHtml(u)}
    <label class="field"><span>رمز عبور تازه (خالی بگذارید تا عوض نشود)</span>
      <input class="input ltr" name="password" placeholder="رمز تازه"></label>
    <div class="row" style="margin-top:6px">
      <label class="row small" style="gap:6px;align-items:center">
        <input type="checkbox" name="active" ${u.active !== false ? 'checked' : ''}> حساب فعال باشد
      </label>
    </div>
    <div class="small muted" style="margin-top:8px">اگر رمز را خالی بگذارید، همان رمز فعلی می‌ماند. رمز اولیهٔ هر کاربر برابر کد ملی اوست.</div>
    <button class="btn primary block" style="margin-top:10px">ذخیره</button>
  </form>`);
}

/* ── کلاس: ایجاد و ویرایش (پایه و رشته از فهرست تعریف‌ها می‌آید) ── */
function classFormHtml(c) {
  const opts = (arr, val) => arr.map(r =>
    `<option value="${esc(r.name)}" ${String(r.name) === String(val || '') ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
  const grades = lookupList('grade');
  const branches = lookupList('branch');
  const editing = c && c.id;
  const pick = (kind, listArr, val) => {
    if (!listArr.length) {
      return `<input class="input" name="${kind}" value="${esc(val || '')}" placeholder="در بخش ${LOOKUP_FA[kind]}ها تعریف کنید">`;
    }
    /* مقدار فعلی اگر در فهرست تعریف‌ها نباشد هم نمایش داده شود، وگرنه
       ویرایشِ یک کلاس قدیمی بی‌خبر، پایه‌اش را عوض می‌کند. */
    const known = val && listArr.some(r => String(r.name) === String(val));
    const extra = val && !known ? `<option value="${esc(val)}" selected>${esc(val)} (تعریف نشده)</option>` : '';
    return `<select class="input" name="${kind}">${extra}${opts(listArr, val)}</select>`;
  };
  const lvlOf = t => (typeof impGradeLevel === 'function' ? impGradeLevel(t) : 0);
  const gl = editing ? (Number(c.grade_level) || lvlOf(c.grade || c.name) || 0) : 0;
  const mode = editing ? (c.mode || (gl >= 10 ? 'field' : 'class')) : '';
  return `<form data-form="class">
    ${editing ? `<input type="hidden" name="id" value="${esc(c.id)}">` : ''}
    <label class="field"><span>نوع چیدمان</span>
      <select class="input" name="mode">
        <option value="" ${mode ? '' : 'selected'}>— خودکار از روی پایه —</option>
        <option value="class" ${mode === 'class' ? 'selected' : ''}>کلاس‌محور (ابتدایی و متوسطه اول)</option>
        <option value="field" ${mode === 'field' ? 'selected' : ''}>رشته‌محور (متوسطه دوم)</option>
      </select></label>
    <div class="small muted" style="margin:-4px 0 8px;line-height:2">
      کلاس‌محور: یک کلاس ثابت مثل «دوم ب» که تا آخر سال عوض نمی‌شود.<br>
      رشته‌محور: پایه + رشته ثابت است (مثل «دهم الکترونیک») و محل برگزاری هر زنگ در برنامهٔ هفتگی نوشته می‌شود.
    </div>
    <label class="field"><span>نام کلاس</span>
      <input class="input" name="name" value="${esc(editing ? c.name : '')}" placeholder="خالی بگذارید تا از پایه و رشته ساخته شود"></label>
    <div class="row">
      <label class="field grow"><span>پایه (الزامی)</span>${pick('grade', grades, editing ? c.grade : '')}</label>
      <label class="field grow"><span>رشته (فقط رشته‌محور)</span>${pick('branch', branches, editing ? c.branch : '')}</label>
    </div>
    <label class="field"><span>ظرفیت</span>
      <input class="input ltr" name="capacity" inputmode="numeric" value="${esc(editing ? (c.capacity || 30) : 30)}"></label>
    <label class="field"><span>دبیر پایه (سرپرست) — اختیاری</span>
      <select class="input" name="teacher_id">
        <option value="">— بدون دبیر پایه —</option>
        ${list('users').filter(u => u.role === 'teacher').map(t => `<option value="${esc(t.id)}" ${Number(t.id) === Number(editing ? c.teacher_id : 0) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
      </select></label>
    <div class="small muted">اگر پایه یا رشتهٔ دلخواه در فهرست نیست، در همین صفحه از بخش «پایه‌ها» یا «رشته‌ها» اضافه کنید.</div>
    <button class="btn primary block" style="margin-top:10px">${editing ? 'ذخیرهٔ تغییرات' : 'ایجاد کلاس'}</button>
  </form>`;
}
function actClassAdd() { S.modalTitle = 'کلاس جدید'; modal(classFormHtml(null)); }
function actClassEdit(id) {
  const c = byId('classes', Number(id));
  if (!c) return toast('این کلاس پیدا نشد — صفحه را دوباره باز کنید', 'err');
  S.modalTitle = 'ویرایش کلاس — ' + c.name;
  modal(classFormHtml(c));
}

/* ── پایه و رشته: افزودن و ویرایش ── */
function defFormHtml(kind, row) {
  const editing = row && row.id;
  return `<form data-form="def">
    <input type="hidden" name="kind" value="${esc(kind)}">
    ${editing ? `<input type="hidden" name="id" value="${esc(row.id)}">` : ''}
    <label class="field"><span>نام ${LOOKUP_FA[kind] || ''}</span>
      <input class="input" name="name" required value="${esc(editing ? row.name : (row && row.name) || '')}"></label>
    <label class="field"><span>ترتیب نمایش (اختیاری)</span>
      <input class="input ltr" name="order" inputmode="numeric" value="${esc(editing ? (row.order || '') : '')}" placeholder="۱، ۲، ۳ …"></label>
    <button class="btn primary block">${editing ? 'ذخیرهٔ تغییرات' : 'ثبت'}</button>
  </form>`;
}
function actDefAdd(kind, name) {
  kind = kind === 'branch' ? 'branch' : 'grade';
  S.modalTitle = 'افزودن ' + (LOOKUP_FA[kind] || 'مورد');
  modal(defFormHtml(kind, { name: name || '' }));
}
function actDefEdit(id) {
  const r = byId('lookups', Number(id));
  if (!r) return toast('این مورد پیدا نشد — صفحه را دوباره باز کنید', 'err');
  S.modalTitle = 'ویرایش ' + (LOOKUP_FA[r.kind] || 'مورد') + ' — ' + r.name;
  modal(defFormHtml(r.kind, r));
}

/* ── درس: افزودن و ویرایش ── */
function subjectFormHtml(sb) {
  const editing = sb && sb.id;
  return `<form data-form="subject">
    ${editing ? `<input type="hidden" name="id" value="${esc(sb.id)}">` : ''}
    <label class="field"><span>نام درس</span>
      <input class="input" name="name" required value="${esc(editing ? sb.name : '')}" placeholder="مثلاً ریاضی ۱"></label>
    <label class="field"><span>نوع درس</span>
      <select class="input" name="workshop">
        <option value="" ${editing && sb.workshop ? '' : 'selected'}>نظری — نمره از ۲۰</option>
        <option value="1" ${editing && sb.workshop ? 'selected' : ''}>کارگاهی — نمرهٔ عملی</option>
      </select></label>
    <button class="btn primary block">${editing ? 'ذخیرهٔ تغییرات' : 'ثبت درس'}</button>
  </form>`;
}
function actSubjectAdd() { S.modalTitle = 'درس جدید'; modal(subjectFormHtml(null)); }
function actSubjectEdit(id) {
  const sb = byId('subjects', Number(id));
  if (!sb) return toast('این درس پیدا نشد — صفحه را دوباره باز کنید', 'err');
  S.modalTitle = 'ویرایش درس — ' + sb.name;
  modal(subjectFormHtml(sb));
}

/* فیلدهای تکمیلیِ فرم کاربر — همان کلیدهایی که از اکسل هم می‌آیند،
   تا کاربر دستی هم بتواند همه‌چیز را ثبت کند. */
const USER_EXTRA_FORM = [
  ['father_name', 'نام پدر', ''], ['father_nid', 'کد ملی پدر', 'num'],
  ['father_phone', 'همراه پدر', 'num'], ['mother_name', 'نام مادر', ''],
  ['mother_nid', 'کد ملی مادر', 'num'], ['mother_phone', 'همراه مادر', 'num'],
  ['landline', 'تلفن ثابت', 'num'], ['residence', 'محل سکونت', ''],
  ['address', 'نشانی', ''], ['last_gpa', 'معدل سال گذشته', 'num'],
  ['covered', 'حمایتی (بله/خیر)', ''], ['talent', 'استعداد', ''],
];
function userExtraFieldsHtml(u) {
  const src = u || {};
  return `<div class="row" style="flex-wrap:wrap">
    ${USER_EXTRA_FORM.map(([k, label, mode]) => `<label class="field grow" style="min-width:150px">
      <span>${esc(label)}</span>
      <input class="input${mode === 'num' ? ' ltr' : ''}" name="${k}"
        ${mode === 'num' ? 'inputmode="numeric"' : ''}
        value="${esc(src[k] == null ? '' : src[k])}"></label>`).join('')}
  </div>`;
}

function actUserAdd(prefill, issueId) {
  S.modalTitle = 'کاربر جدید';
  const P = prefill || {};
  const pv = k => esc(P[k] == null ? '' : P[k]);
  S.fixIssueId = issueId || null;
  const roles = [['student', 'دانش‌آموز'], ['teacher', 'دبیر'], ['parent', 'ولی'], ['vice', 'معاون'],
    ['staff', 'کارمند'], ['office', 'اجرایی'], ['counselor', 'مشاور'], ['guard', 'نگهبان'], ['manager', 'مدیر']];
  modal(`<form data-form="user">
    <label class="field"><span>نام و نام خانوادگی</span><input class="input" name="name" required value="${pv('name')}"></label>
    <div class="row">
      <label class="field grow"><span>نقش</span><select class="input" name="role">
        ${roles.map(([v, t]) => `<option value="${v}" ${(P.role || 'student') === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="field grow"><span>کلاس (دانش‌آموز)</span><select class="input" name="class_id">
        <option value="">—</option>${list('classes').map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
    </div>
    <div class="row">
      <label class="field grow"><span>کد ملی</span><input class="input ltr" name="national_id" inputmode="numeric" maxlength="10" value="${pv('national_id')}"></label>
      <label class="field grow"><span>شمارهٔ همراه (نام کاربری)</span><input class="input ltr" name="phone" inputmode="numeric" maxlength="11" placeholder="09…" value="${pv('phone')}"></label>
    </div>
    <div class="row">
      <label class="field grow"><span>نام ولی (اختیاری)</span><input class="input" name="parent_name" value="${pv('father_name')}"></label>
      <label class="field grow"><span>همراه ولی (اختیاری)</span><input class="input ltr" name="parent_phone" inputmode="numeric" maxlength="11" placeholder="09…" value="${pv('father_phone')}"></label>
    </div>
    <div class="row">
      <label class="field grow"><span>تاریخ تولد (شمسی)</span>
        <input class="input ltr" name="birth_date" placeholder="1390/05/12" value="${esc(P.birth_date && typeof impIsoToJalali === 'function' ? impIsoToJalali(P.birth_date) : '')}"></label>
      <label class="field grow"><span>جنسیت</span>
        <select class="input" name="gender">
          <option value="">—</option>
          <option value="پسر">پسر</option>
          <option value="دختر">دختر</option>
        </select></label>
    </div>
    ${userExtraFieldsHtml(null)}
    <label class="field"><span>رمز عبور (اختیاری — پیش‌فرض: کد ملی)</span>
      <input class="input ltr" name="password" placeholder="اگر خالی بماند، کد ملی می‌شود"></label>
    <div class="small muted" style="margin-top:6px">نام کاربری هر کاربر همان <b>شمارهٔ همراه</b> است و رمزش <b>کد ملی</b>؛ هر دو بعداً از «ویرایش» قابل تغییرند.</div>
    <button class="btn primary block" style="margin-top:10px">ایجاد کاربر</button>
  </form>`);
}

/* ══════════════════════════════════════════════════════════════════
   ورود دسته‌ای از اکسل → client/import.js
   جادوگر چهار مرحله‌ای (انتخاب فایل، نگاشت، بررسی، ثبت) با چهار نوع
   فایل: دانش‌آموزان (۳۹ فیلد + ولی و کلاس)، دبیران، نمرات و حضور.
   ══════════════════════════════════════════════════════════════════ */

async function actBackupNow() {
  try { const r = await api('/api/admin/backup', { method: 'POST' }); toast('پشتیبان ساخته شد: ' + r.file, 'ok'); }
  catch (e) { toast('خطا: ' + e.message, 'err'); }
}

async function actDevices() {
  try {
    const r = await api('/api/admin/devices');
    const box = $('#devices-box');
    if (box) box.innerHTML = r.devices.length ? r.devices.map(d => `<div class="item" style="margin-top:6px">
      <div class="grow"><div class="t">${esc(d.user_name)} <span class="badge">${esc(ROLE_FA[d.role] || d.role)}</span></div>
      <div class="s">${esc(d.name || '')} · ${esc(d.platform)} · ${d.revoked ? 'باطل' : 'فعال'}</div></div>
      ${d.revoked ? '' : `<button class="btn sm danger" data-act="revoke-device" data-id="${d.id}">ابطال</button>`}
    </div>`).join('') : '<div class="muted small">دستگاهی ثبت نشده.</div>';
  } catch (e) { toast(e.message, 'err'); }
}

async function actBackups() {
  try {
    const r = await api('/api/admin/backups');
    S.modalTitle = 'نسخه‌های پشتیبان';
    modal(r.files.length ? `<div class="list">${r.files.map(f => `<div class="item"><div class="grow small ltr">${esc(f)}</div>
      <a class="btn sm" href="/api/admin/backups/${encodeURIComponent(f)}">دانلود</a></div>`).join('')}</div>`
      : '<div class="muted">نسخه‌ای نیست.</div>');
  } catch (e) { toast(e.message, 'err'); }
}

async function actAudit() {
  try {
    const r = await api('/api/admin/audit?limit=60');
    S.modalTitle = 'سابقهٔ تغییرات';
    modal(`<div class="table-wrap"><table><thead><tr><th>زمان</th><th>کاربر</th><th>عملیات</th><th>مجموعه</th></tr></thead><tbody>
      ${r.rows.map(a => `<tr><td class="small">${esc(jdate(a.at) + ' ' + new Date(a.at).toLocaleTimeString('fa-IR'))}</td>
      <td class="small">${esc(a.user_id || '—')}</td><td class="small">${esc(a.action || '')}</td><td class="small">${esc(a.collection || '')}</td></tr>`).join('')}
    </tbody></table></div>`);
  } catch (e) { toast(e.message, 'err'); }
}
