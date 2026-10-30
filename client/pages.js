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

const ROLE_FA = { manager: 'مدیر', teacher: 'دبیر', parent: 'ولی', student: 'دانش‌آموز', counselor: 'مشاور', guard: 'نگهبان' };

function navConfig(role) {
  const base = [];
  if (role === 'manager') {
    base.push(['home', '🏠', 'داشبورد'], ['users', '👥', 'کاربران'], ['classes', '🏛️', 'کلاس‌ها'],
      ['schedule', '🗓️', 'برنامه'], ['attendance-report', '✅', 'حضور'], ['reports', '📑', 'گزارش‌ها'],
      ['announcements', '📢', 'اطلاعیه‌ها'], ['network', '🌐', 'شبکه'], ['system', '⚙️', 'سیستم']);
  } else if (role === 'teacher') {
    base.push(['home', '🏠', 'امروز'], ['attendance', '✅', 'حضور'], ['grades', '📝', 'نمره'],
      ['students', '👥', 'دانش‌آموزان'], ['announcements', '📢', 'اطلاعیه‌ها'], ['system', '⚙️', 'سیستم']);
  } else if (role === 'parent') {
    base.push(['home', '👨‍👩‍👦', 'فرزندان'], ['leaves', '📨', 'مرخصی'], ['announcements', '📢', 'اطلاعیه‌ها'], ['system', '⚙️', 'سیستم']);
  } else if (role === 'student') {
    base.push(['home', '🏠', 'خانه'], ['record', '📁', 'پرونده'], ['announcements', '📢', 'اطلاعیه‌ها'], ['system', '⚙️', 'سیستم']);
  } else {
    base.push(['home', '🏠', 'خانه'], ['announcements', '📢', 'اطلاعیه‌ها'], ['system', '⚙️', 'سیستم']);
  }
  return base;
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

/* اگر کاربر از آدرس محلی (فقط شبکهٔ مدرسه) وارد شده، به آدرس رسمی هدایتش کن */
function canonicalBarHtml() {
  const pub = S.server && S.server.publicUrl;
  if (!pub) return '';
  try { if (location.origin === new URL(pub).origin) return ''; } catch (e) { return ''; }
  return `<div class="banner warn" id="origin-bar">
    <div>🌐 این آدرس فقط داخل شبکهٔ مدرسه کار می‌کند. برای استفاده از هر اینترنتی (خانه و موبایل)، آدرس رسمی را باز کنید:
      <span class="ltr small" style="font-weight:700">${esc(pub.replace(/^https?:\/\//, ''))}</span></div>
    <button class="btn sm primary" data-act="transfer">انتقال به آدرس رسمی</button>
  </div>`;
}

function updateBarHtml() {
  if (!S.update) return '';
  const n = (S.update.changed || []).length;
  const kb = Math.round((S.update.total_size || 0) / 1024);
  return `<div class="banner info" id="update-bar">
    <div>🎁 نسخهٔ <b>${esc(S.update.version)}</b> آماده است — ${fa(n)} فایل تغییر کرده (${fa(kb)} کیلوبایت)</div>
    <button class="btn sm primary" data-act="update-apply">به‌روزرسانی</button>
  </div>`;
}
function offlineBarHtml() {
  if (S.online) return '';
  const q = S.queue.length;
  return `<div class="banner warn">📴 آفلاین هستید — برنامه کار می‌کند و ${fa(q)} تغییر در صف است. با وصل شدن شبکه خودکار ارسال می‌شود.</div>`;
}
function updateTopChrome() {
  const bar = $('#update-bar');
  if (!bar && S.update) {
    const main = $('.main');
    if (main) main.insertAdjacentHTML('afterbegin', updateBarHtml());
  }
}

/* ══════════════ صفحه‌های ورود ══════════════ */
function renderSetup() {
  $('#app').innerHTML = `
  <div class="auth">
    <div class="logo">پ</div>
    <h1>راه‌اندازی پایش-لوکال</h1>
    <div class="sub">این فرم فقط یک‌بار پر می‌شود.</div>
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
      <label class="field"><span>شمارهٔ همراه مدیر</span><input class="input ltr" name="phone" inputmode="numeric" placeholder="09xxxxxxxxx"></label>
      <label class="field"><span>PIN ورود مدیر (۴ تا ۶ رقم)</span><input class="input pin-input" name="pin" inputmode="numeric" maxlength="6" required placeholder="••••"></label>
      <button class="btn primary block" type="submit">ایجاد مدرسه</button>
      <p class="small muted center" style="margin-top:10px">پس از این مرحله، برای هر کاربر «کارت پیوند» می‌سازید.</p>
    </form>
  </div>`;
}

function renderPair() {
  const href = location.hash;
  const m = href.match(/#\/join\/([A-Za-z0-9-]+)/);
  const pre = m ? m[1].toUpperCase() : '';
  $('#app').innerHTML = `
  <div class="auth">
    <div class="logo">پ</div>
    <h1>ورود به پایش</h1>
    <div class="sub">با «کارت پیوند» مدرسه وارد شوید — بدون رمز و بدون پیامک</div>
    <form data-form="pair" class="card">
      <label class="field"><span>کد پیوند</span>
        <input class="input code-input" name="code" value="${esc(pre)}" maxlength="12" placeholder="XXXX-XXXX" autocomplete="off"></label>
      <label class="field"><span>PIN انتخابی شما (۴ تا ۶ رقم)</span>
        <input class="input pin-input" name="pin" inputmode="numeric" maxlength="6" placeholder="••••" autocomplete="off"></label>
      <button class="btn primary block" type="submit">ورود و ثبت این دستگاه</button>
      <p class="small muted center" style="margin-top:10px">اگر کد ندارید، از دفتر مدرسه بخواهید.</p>
    </form>
    <div class="card tight small muted">
      سرور: <span class="ltr">${esc(location.host)}</span> · نسخه ${esc(S.server.version || '')}
      ${S.user ? '' : `<br><a href="#" data-act="forget-device">دستگاه دیگری انتخاب شود</a>`}
    </div>
  </div>`;
}

function renderTransfer(code) {
  $('#app').innerHTML = `
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
  </div>`;
}

function renderLock() {
  $('#app').innerHTML = `
  <div class="auth">
    <div class="logo">پ</div>
    <h1>پایش</h1>
    <div class="sub">PIN خود را وارد کنید</div>
    <form data-form="unlock" class="card">
      <label class="field"><input class="input pin-input" id="pin" name="pin" inputmode="numeric" maxlength="6" placeholder="••••" autofocus></label>
      <button class="btn primary block" type="submit">ورود</button>
    </form>
    <div class="center"><a href="#" class="small" data-act="forget-device">این دستگاه من نیست</a></div>
  </div>`;
}

function renderOffline() {
  $('#app').innerHTML = `
  <div class="auth">
    <div class="logo">پ</div>
    <h1>سرور در دسترس نیست</h1>
    <div class="sub">از Wi-Fi مدرسه استفاده کنید یا اتصال سرور را بررسی کنید.</div>
    <div class="card small muted">
      آدرس این صفحه: <span class="ltr">${esc(location.host || location.pathname)}</span><br>
      اگر روی گوشی هستید، مطمئن شوید به Wi-Fi مدرسه وصل هستید.
    </div>
    <button class="btn primary block" data-act="retry">تلاش مجدد</button>
  </div>`;
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
  <div class="card tight"><input class="input" placeholder="جستجو…" value="${esc(q)}" oninput="S.q=this.value;clearTimeout(window._q);window._q=setTimeout(()=>render(),250)"></div>
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
  if (q) users = users.filter(u => String(u.name).includes(q) || String(u.phone || '').includes(q));
  users = users.sort((a, b) => String(a.name).localeCompare(String(b.name))).slice(0, 300);
  return `${pageHead('کاربران', fa(list('users').length) + ' کاربر',
    `<button class="btn sm" data-act="import-open">📥 ورود دسته‌ای</button>
     <button class="btn sm primary" data-act="user-add">+ کاربر جدید</button>`)}
  <div class="card tight">
    <input class="input" placeholder="جستجوی نام یا شماره…" value="${esc(q)}" oninput="S.q=this.value;clearTimeout(window._q);window._q=setTimeout(()=>render(),250)">
    <div class="pill-tabs" style="margin-top:8px">
      ${[['', 'همه'], ['student', 'دانش‌آموز'], ['teacher', 'دبیر'], ['parent', 'ولی'], ['manager', 'مدیر']].map(([v, t]) =>
        `<span class="pill ${role === v ? 'on' : ''}" data-act="role-filter" data-role="${v}">${t}</span>`).join('')}
    </div>
  </div>
  ${card(`<div class="table-wrap"><table><thead><tr><th>نام</th><th>نقش</th><th>کلاس</th><th>همراه</th><th></th></tr></thead><tbody>
    ${users.map(u => `<tr>
      <td>${esc(u.name)}</td>
      <td>${badge(ROLE_FA[u.role] || u.role, u.role === 'manager' ? 'purple' : '')}</td>
      <td class="small">${esc((byId('classes', u.class_id) || {}).name || '—')}</td>
      <td class="small ltr">${esc(u.phone || '—')}</td>
      <td><button class="btn sm" data-act="pair-code" data-id="${u.id}">کارت پیوند</button></td>
    </tr>`).join('')}
  </tbody></table></div>`)}`;
};

/* ══════════════ مدیر: کلاس‌ها ══════════════ */
PAGES.classes = () => {
  if (S.role !== 'manager') return pageHead('کلاس‌ها') + empty('دسترسی ندارید.');
  const classes = list('classes');
  return `${pageHead('کلاس‌ها و دروس', fa(classes.length) + ' کلاس', `<button class="btn sm primary" data-act="class-add">+ کلاس</button>`)}
  ${card(`<div class="table-wrap"><table><thead><tr><th>کلاس</th><th>پایه</th><th>رشته</th><th>دانش‌آموز</th></tr></thead><tbody>
    ${classes.map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.grade || '—')}</td><td class="small">${esc(c.branch || '—')}</td>
      <td>${fa(list('users').filter(u => u.role === 'student' && Number(u.class_id) === Number(c.id)).length)}</td></tr>`).join('')}
  </tbody></table></div>`)}
  ${card(`<b>دروس</b><div class="row" style="margin-top:8px">${list('subjects').map(s => `<span class="badge ${s.workshop ? 'purple' : ''}">${esc(s.name)}${s.workshop ? ' · کارگاهی' : ''}</span>`).join(' ')}</div>`)}`;
};

/* ══════════════ برنامه و زنگ ══════════════ */
PAGES.schedule = () => {
  const classes = list('classes');
  const bells = sortBy(list('bell_schedules'), 'order');
  const days = [0, 1, 2, 3, 4];
  const sel = Number(S.schedClass || (classes[0] && classes[0].id) || 0);
  const rows = list('schedule').filter(s => Number(s.class_id) === sel);
  const cell = (day, order) => {
    const s = rows.find(x => Number(x.weekday) === day && Number(x.bell_order) === Number(order));
    if (!s) return '<td class="muted">—</td>';
    const subj = byId('subjects', s.subject_id) || {};
    const t = byId('users', s.teacher_id) || {};
    return `<td><div style="font-size:12.5px"><b>${esc(subj.name || '')}</b></div><div class="small muted">${esc(String(t.name || '').split(' ')[0])}</div></td>`;
  };
  return `${pageHead('برنامهٔ هفتگی', 'نمای خواندنی', '')}
  <div class="card tight"><div class="pill-tabs">
    ${classes.map(c => `<span class="pill ${Number(c.id) === sel ? 'on' : ''}" data-act="sched-class" data-id="${c.id}">${esc(c.name)}</span>`).join('')}
  </div></div>
  ${card(`<div class="table-wrap"><table><thead><tr><th>زنگ</th>${days.map(d => `<th>${J_DAYS[d]}</th>`).join('')}</tr></thead><tbody>
    ${bells.filter(b => b.type === 'lesson').map(b => `<tr><td class="small"><b>${esc(b.start)}</b><br><span class="muted">${esc(b.end)}</span></td>
      ${days.map(d => cell(d, b.order)).join('')}</tr>`).join('')}
  </tbody></table></div>`)}
  <div class="small muted" style="padding:0 6px">ویرایش برنامه در نسخهٔ بعدی از همین صفحه اضافه می‌شود؛ فعلاً از دادهٔ ورودی/اکسل استفاده می‌شود.</div>`;
};

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
      <select class="input" style="max-width:240px" id="rc-class" onchange="S.repClass=this.value;render()">
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
  return `${pageHead('حضور و غیاب', jdate(date), `<input type="date" class="input" style="max-width:180px" value="${date}" onchange="S.attDate=this.value;render()">`)}
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
    <div class="small" style="margin-top:6px;white-space:pre-wrap">${esc(a.body)}</div>`)).join('') : empty('اطلاعیه‌ای ثبت نشده.')}`;
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

/* ── وضعیت ابری: وقتی سیستم مدرسه خاموش است، ولی از Hub می‌خواند ── */
function cloudCard(kids) {
  const hub = S.hub || {};
  if (!hub.enabled) return '';
  const rows = kids.map(k => ({ kid: k, d: (S.hubData || {})[Number(k.id)] })).filter(x => x.d);
  const anyData = rows.length > 0;
  return card(`<div class="row between"><b>☁️ ابر پایش</b>
      ${S.hubOffline ? badge('سیستم مدرسه در دسترس نیست', 'amber') : badge('متصل', 'green')}</div>
    <div class="small muted" style="margin-top:6px">
      ${anyData
        ? 'آخرین وضعیت ثبت‌شده در فضای ابری. ثبت‌ها و درخواست‌های شما در صف می‌مانند و با روشن شدن سیستم مدرسه اعمال می‌شوند.'
        : 'برای دیدن آخرین وضعیت وقتی مدرسه تعطیل است، از همین دکمه استفاده کنید.'}
    </div>
    ${anyData ? rows.map(({ kid, d }) => `<div class="item" style="margin-top:8px">
        <div class="grow"><div class="t">${esc(kid.name)}</div>
          <div class="s">حضور ${fa(d.attendance && d.attendance.percent != null ? d.attendance.percent : '—')}٪ · ${fa((d.grades || []).length)} نمره</div></div>
        <span class="small muted">${esc(d.updated_at ? jdate(d.updated_at) : '')}</span></div>`).join('') : ''}
    <button class="btn sm block" style="margin-top:10px" data-act="hub-load">دریافت از ابر</button>`);
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
  const mine = S.role === 'parent' ? myChildren().map(k => Number(k.id)) : [Number(S.user.id)];
  const rows = list('leaves').filter(l => mine.includes(Number(l.student_id))).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return `${pageHead('مرخصی و غیبت موجه', '', `<button class="btn sm primary" data-act="leave-add">+ درخواست</button>`)}
  ${rows.length ? rows.map(l => card(`<div class="row between"><b>${esc((byId('users', l.student_id) || {}).name || '')}</b>
      ${badge(l.status === 'approved' ? 'تأییدشده' : l.status === 'rejected' ? 'رد شده' : 'در انتظار', l.status === 'approved' ? 'green' : l.status === 'rejected' ? 'red' : 'amber')}</div>
    <div class="small muted">${esc(jdate(l.date))} · ${esc(l.reason || '')}</div>`)).join('') : empty('درخواستی ثبت نشده.')}`;
};

PAGES.record = () => {
  const k = S.user;
  const grades = list('grades').filter(g => Number(g.student_id) === Number(k.id));
  const att = list('attendance').filter(a => Number(a.student_id) === Number(k.id));
  const pct = att.length ? Math.round(att.filter(a => a.status === 'present').length / att.length * 100) : 0;
  return `${pageHead('پروندهٔ من', (byId('classes', k.class_id) || {}).name || '')}
  <div class="grid">${statCard('✅', fa(pct) + '٪', 'حضور', pct >= 90 ? 'green' : 'amber')}
    ${statCard('📝', fa(grades.length), 'نمره')}</div>
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
  ${card(`<b>راه‌اندازی تونل رایگان (Tailscale Funnel)</b>
    <ol class="small" style="margin:8px 0 0;padding-inline-start:18px;line-height:2">
      <li>روی همین سیستم، Tailscale را نصب و با یک حساب رایگان وارد شوید.</li>
      <li>در ترمینال: <code class="ltr">tailscale funnel 8080 on</code></li>
      <li>آدرسی مثل <span class="ltr">https://payesh-xxx.ts.net</span> می‌گیرید؛ همان را بالا ذخیره کنید.</li>
      <li>در Tailscale، گزینهٔ Funnel باید برای همین دستگاه فعال بماند تا آدرس ثابت بماند.</li>
    </ol>
    <div class="small muted" style="margin-top:8px">توجه: با فعال شدن آدرس عمومی، این سرور از اینترنت قابل دسترسی است؛ PIN همهٔ کاربران را جدی بگیرید و دستگاه‌های ناشناس را از «دستگاه‌ها» باطل کنید.</div>`)}
  ${card(`<b>آدرس‌های شبکهٔ محلی</b><div class="small muted" style="margin-top:6px">
    ${(n.lan_urls || []).map(u => `<div class="ltr">${esc(u)}</div>`).join('') || '<div>—</div>'}
    <div style="margin-top:6px">این آدرس‌ها فقط وقتی گوشی به همان Wi-Fi وصل است کار می‌کنند. برای همین، آدرس رسمی بالا را به همه بدهید.</div>
  </div>`)}
  ${card(`<div class="row between"><b>☁️ Hub ابری</b>${n.hub && n.hub.enabled ? badge('فعال', 'green') : badge('غیرفعال', 'amber')}</div>
    <div class="small muted" style="margin-top:6px">با فعال بودن Hub، ولی و دانش‌آموز حتی وقتی سیستم مدرسه خاموش است آخرین وضعیت را می‌بینند و درخواست مرخصی‌شان در صف می‌ماند. دادهٔ هر دانش‌آموز جداگانه و بدون کد ملی فرستاده می‌شود.</div>
    <form data-form="hub" style="margin-top:10px">
      <input class="input ltr" name="hub_url" value="${esc((n.hub && n.hub.url) || '')}" placeholder="https://payesh-hub.xxx.workers.dev" inputmode="url" autocomplete="off">
      <label class="row small" style="margin-top:8px;gap:6px;align-items:center">
        <input type="checkbox" name="hub_enabled" ${n.hub && n.hub.enabled ? 'checked' : ''}> فعال باشد
      </label>
      <button class="btn primary block" style="margin-top:8px">ذخیرهٔ Hub</button>
    </form>
    <div class="small muted" style="margin-top:10px">کلید مدرسه (در Worker به‌عنوان <span class="ltr">SCHOOL_KEY</span> تنظیم کنید):</div>
    <div class="ltr small" style="background:var(--soft);padding:8px;border-radius:8px;word-break:break-all;margin-top:4px">${esc((n.hub && n.hub.key) || '—')}</div>
    <div class="row" style="margin-top:8px">
      <button class="btn sm" data-act="hub-sync">همگام‌سازی اکنون</button>
      <span class="small muted">آخرین ارسال: ${esc(n.hub && n.hub.last_push ? jdate(n.hub.last_push) : '—')} · آخرین دریافت: ${esc(n.hub && n.hub.last_drain ? jdate(n.hub.last_drain) : '—')}</span>
    </div>`)}`;
};

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
  ${card(`<b>به‌روزرسانی برنامه</b>
    <div class="small muted" style="margin-top:6px">${S.update ? `نسخهٔ ${esc(S.update.version)} آماده است.` : 'برنامه به‌روز است. فقط فایل‌های تغییرکرده دانلود می‌شوند.'}</div>
    <div class="row" style="margin-top:8px">
      <button class="btn sm" data-act="update-check">بررسی آپدیت</button>
      ${S.update ? `<button class="btn sm primary" data-act="update-apply">نصب آپدیت (${Math.round((S.update.total_size || 0) / 1024)}KB)</button>` : ''}
    </div>`)}
  ${isManager ? managerSystemSections() : changePinCard()}
  ${card(`<b>راهنمای دستگاه‌ها</b><div class="small muted" style="margin-top:6px">
    ${S.server.publicUrl
      ? `آدرس رسمی را روی گوشی باز کنید و «افزودن به صفحهٔ اصلی» را بزنید:<br><span class="ltr" style="font-weight:700">${esc(S.server.publicUrl)}</span>`
      : `آدرس زیر فقط داخل شبکهٔ مدرسه کار می‌کند. برای دسترسی از هر اینترنتی، <a href="#/network">آدرس رسمی</a> را تنظیم کنید:<br><span class="ltr" style="font-weight:700">http://${esc(location.host)}</span>`}
    <br><a href="/install" target="_blank">صفحهٔ نصب و راهنما</a>
  </div>`)}`;
};

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

/* ══════════════ کنش‌ها ══════════════ */
function modal(html) {
  S.modal = html;
  $('#modal-root').innerHTML = `<div class="modal-bg" data-act="modal-close"><div class="modal" onclick="event.stopPropagation()">
    <div class="row between" style="margin-bottom:8px"><b>${esc(S.modalTitle || '')}</b><button class="btn sm ghost" data-act="modal-close">✕</button></div>
    ${html}</div></div>`;
}
function closeModal() { S.modal = null; $('#modal-root').innerHTML = ''; }

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

function actAnnAdd() {
  S.modalTitle = 'اطلاعیهٔ جدید';
  modal(`<form data-form="ann">
    <label class="field"><span>عنوان</span><input class="input" name="title" required></label>
    <label class="field"><span>متن</span><textarea class="input" name="body" required></textarea></label>
    <label class="field"><span>اهمیت</span><select class="input" name="severity">
      <option value="normal">عادی</option><option value="info">اطلاع‌رسانی</option><option value="important">مهم</option></select></label>
    <button class="btn primary block">انتشار</button>
  </form>`);
}

function actUserAdd() {
  S.modalTitle = 'کاربر جدید';
  modal(`<form data-form="user">
    <label class="field"><span>نام و نام خانوادگی</span><input class="input" name="name" required></label>
    <div class="row">
      <label class="field grow"><span>نقش</span><select class="input" name="role">
        <option value="student">دانش‌آموز</option><option value="teacher">دبیر</option><option value="parent">ولی</option>
        <option value="counselor">مشاور</option></select></label>
      <label class="field grow"><span>کلاس (دانش‌آموز)</span><select class="input" name="class_id">
        <option value="">—</option>${list('classes').map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
    </div>
    <div class="row">
      <label class="field grow"><span>کد ملی</span><input class="input ltr" name="national_id" inputmode="numeric" maxlength="10"></label>
      <label class="field grow"><span>همراه</span><input class="input ltr" name="phone" inputmode="numeric"></label>
    </div>
    <button class="btn primary block">ایجاد و صدور کارت پیوند</button>
  </form>`);
}

function actImport() {
  S.modalTitle = 'ورود دسته‌ای از CSV';
  modal(`<form data-form="import">
    <div class="small muted" style="margin-bottom:8px">
      ستون‌های پیشنهادی: <span class="ltr">name, national_id, phone, class_name, parent_name, parent_phone</span><br>
      سطر اول می‌تواند عنوان ستون‌ها باشد. فایل اکسل را با «ذخیره به‌صورت CSV» خروجی بگیرید.
    </div>
    <label class="field"><span>نوع</span><select class="input" name="kind"><option value="students">دانش‌آموزان</option><option value="staff">دبیران/کارکنان</option></select></label>
    <label class="field"><span>فایل CSV</span><input class="input" type="file" name="file" accept=".csv,text/csv"></label>
    <button class="btn primary block">بارگذاری و ثبت</button>
  </form>`);
}

function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim().toLowerCase());
  const hasHeader = header.some(h => ['name', 'نام', 'national_id', 'کد ملی'].includes(h));
  const keys = hasHeader ? header : ['name', 'national_id', 'phone', 'class_name'];
  const data = hasHeader ? rows.slice(1) : rows;
  return data.filter(r => r.some(c => String(c).trim())).map(r => {
    const o = {};
    keys.forEach((k, i) => {
      const map = { 'نام': 'name', 'کد ملی': 'national_id', 'همراه': 'phone', 'کلاس': 'class_name', 'نام ولی': 'parent_name', 'همراه ولی': 'parent_phone' };
      o[map[k] || k] = (r[i] || '').trim();
    });
    return o;
  });
}

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
