#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   آزمون «همان‌طور که روی گوشی است» — بدون سرور، فقط صندوقچهٔ ابری.
   ورود دبیر و دانش‌آموز با شماره+رمز، و بالا آمدن پنل نقشِ خودشان.
   اگر جایی صفحهٔ «این بخش به سیستم مدرسه نیاز دارد» یا خطای اجرایی
   رخ دهد، این آزمون شکست می‌خورد.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PREFIX = 'payesh/';

const teacher = { id: 7, name: 'دبیر تست', role: 'teacher', phone: '09185678901', active: true };
const student = { id: 9, name: 'دانش‌آموز تست', role: 'student', phone: '09121234567', active: true, class_id: 1 };
const parent = { id: 11, name: 'ولی تست', role: 'parent', phone: '09129999999', active: true };
const vice = { id: 12, name: 'معاون تست', role: 'vice', phone: '09128888888', active: true };
const staff = { id: 13, name: 'عامل اجرایی تست', role: 'staff', phone: '09127777777', active: true };
const password = '123456';

const core = {
  at: '2026-11-05T10:00:00.000Z',
  school: { id: 1, name: 'دبیرستان تست', type: 'کاردانش', level: 'متوسطه دوم' },
  directory: [teacher, student, parent, vice, staff].map(u => ({ id: u.id, name: u.name, role: u.role })),
  collections: {
    users: [teacher, student, parent, vice, staff],
    classes: [{ id: 1, name: 'کلاس الف', grade: 'دهم' }],
    schedule: [{ id: 1, class_id: 1, subject: 'ریاضی', teacher_id: 7, day: 0, hour: 1 }],
    attendance: [],
    grades: [],
    announcements: [{ id: 1, title: 'اطلاعیهٔ تست', body: 'سلام', date: '2026-11-04' }],
  },
};

function verifier(seed) {
  const H = require(path.join(ROOT, 'client/lib/hash.js')) || {};
  return null; /* با PayeshHash داخل صفحه ساخته می‌شود */
}

async function makeWindow() {
  const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><head></head><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>', {
    url: 'https://appassets.androidplatform.net/assets/www/index.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  });
  const win = dom.window;
  win.PAYESH_API_BASE = 'http://127.0.0.1:9';      /* سیستم مدرسه در دسترس نیست */
  win.PAYESH_BUNDLED = true;
  win.PAYESH_CLOUD = {
    endpoint: 'https://s3.ir-central1.arvanstorage.ir', bucket: 'payesh-test',
    accessKey: 'AKIATEST', secret: 'secret', region: 'ir-central1', prefix: PREFIX,
  };
  try { win.crypto = require('crypto').webcrypto; } catch (e) { /* noop */ }
  win.matchMedia = win.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
  win.scrollTo = () => {};

  /* همهٔ فایل‌ها مثل مرورگر در یک دامنهٔ مشترک اجرا می‌شوند */
  const code = ['lib/sigv4.js', 'lib/s3mini.js', 'lib/hash.js', 'lib/phone.js', 'pages.js', 'app.js']
    .map(f => fs.readFileSync(path.join(ROOT, 'client', f), 'utf8'))
    .join('\n;\n');
  win.eval(code);
  const H = win.PayeshHash;
  const mk = plain => {
    const salt = 'a1b2c3d4e5f60718';
    return 'pbkdf2$150000$' + salt + '$' + H.hex(H.pbkdf2(String(plain), salt, 150000, 32));
  };

  /* صندوقچهٔ قلابی */
  const objects = {};
  for (const u of [teacher, student, parent, vice, staff]) {
    objects[PREFIX + 'auth/' + u.phone + '.json'] = JSON.stringify({ verifier: mk(password), user: u });
  }
  objects[PREFIX + 'data/core.json'] = JSON.stringify(core);
  for (const u of [teacher, student, vice, staff]) {
    objects[PREFIX + 'data/person/' + u.id + '.json'] = JSON.stringify({ me: u, children: [], collections: {} });
  }
  /* ولی: فقط پروندهٔ فرزند خودش */
  objects[PREFIX + 'data/person/' + parent.id + '.json'] = JSON.stringify({
    me: parent,
    children: [{ id: student.id, name: student.name, class_id: 1, role: 'student' }],
    collections: {
      attendance: [{ id: 1, student_id: student.id, class_id: 1, date: '2026-11-04', status: 'present' }],
      grades: [{ id: 1, student_id: student.id, class_id: 1, subject: 'ریاضی', score: 18, status: 'approved' }],
    },
  });

  const requests = [];
  win.fetch = async (url, opts = {}) => {
    const u = String(url);
    requests.push((opts.method || 'GET') + ' ' + u);
    if (/\/api\//.test(u) || !/arvanstorage/.test(u)) throw new TypeError('Failed to fetch');
    const parsed = new URL(u);
    const key = decodeURIComponent(parsed.pathname.replace(/^\/[^/]+\//, '')) || decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    const mkRes = (status, text) => ({
      ok: status >= 200 && status < 300, status, text: async () => text,
      json: async () => JSON.parse(text),
      headers: { get: () => null },
    });
    if (parsed.searchParams.get('list-type') === '2' || (key === '' && !parsed.pathname.split('/').filter(Boolean)[1])) {
      const names = Object.keys(objects).map(k => k.slice(PREFIX.length));
      return mkRes(200, '<?xml version="1.0"?><ListBucketResult>' + names.map(n => `<Contents><Key>${PREFIX}${n}</Key></Contents>`).join('') + '</ListBucketResult>');
    }
    const k = key.startsWith(PREFIX) ? key : PREFIX + key;
    if (opts.method === 'PUT') { objects[k] = String(opts.body || ''); return mkRes(200, ''); }
    if (objects[k] != null) return mkRes(200, objects[k]);
    return mkRes(404, '<Error><Code>NoSuchKey</Code></Error>');
  };
  win.__requests = requests;
  win.__objects = objects;
  /* خطاهای اجرایی را جمع می‌کنیم تا هیچ‌کدام از چشم آزمون در نرود */
  win.__errors = [];
  win.addEventListener('error', ev => win.__errors.push(String((ev && ev.message) || ev)));
  win.addEventListener('unhandledrejection', ev => win.__errors.push('rejection: ' + String((ev && ev.reason && (ev.reason.message || ev.reason)) || ev)));
  win.confirm = () => false;          /* کارهای حذفی در آزمون انجام نشوند */
  win.prompt = () => null;
  win.alert = () => {};
  win.dispatchEvent(new win.Event('DOMContentLoaded'));
  await new Promise(r => setTimeout(r, 1200));
  return win;
}

function toastText(win) {
  return [...win.document.querySelectorAll('#toasts .toast')].map(t => t.textContent).join(' | ');
}

async function login(win, phone) {
  const form = win.document.querySelector('form[data-form="phone-login"]');
  if (!form) throw new Error('صفحهٔ ورود گوشی نیامد — متن صفحه: ' + win.document.body.textContent.slice(0, 200));
  form.querySelector('[name="phone"]').value = phone;
  form.querySelector('[name="password"]').value = password;
  form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 2500));
}

(async () => {
  const fails = [];
  const check = (ok, msg) => { if (!ok) fails.push(msg); console.log((ok ? '  ✅ ' : '  ❌ ') + msg); };

  for (const who of [teacher, student, parent, vice, staff]) {
    console.log('\n— ورود ' + who.role + ' —');
    const win = await makeWindow();
    await login(win, who.phone);
    const text = win.document.body.textContent;
    check(!/این بخش به سیستم مدرسه نیاز دارد/.test(text), 'پیام «این بخش به سیستم مدرسه نیاز دارد» دیده نمی‌شود');
    check(!/ورود ناموفق/.test(text + toastText(win)), 'ورود ناموفق نبود: ' + toastText(win));
    check(!/\[object Object\]/.test(text), 'جای خالی «[object Object]» نیست');
    check(text.includes('خوش آمدید') || text.includes(who.name) || !win.document.querySelector('form[data-form="phone-login"]'),
      'از صفحهٔ ورود گذشتیم');
    for (const route of ['home', 'schedule', 'attendance', 'grades', 'reports', 'announcements', 'system', 'child', 'leaves', 'users', 'classes']) {
      win.location.hash = '#/' + route;
      win.dispatchEvent(new win.HashChangeEvent('hashchange'));
      await new Promise(r => setTimeout(r, 120));
    }
    /* همهٔ دکمه‌های هر صفحه هم زده می‌شوند: هیچ‌کدام نباید «نیاز به سیستم
       مدرسه» بدهند یا خطای اجرایی بسازند. */
    const acts = new Set();
    for (const route of ['home', 'schedule', 'attendance', 'grades', 'reports', 'announcements', 'system', 'child', 'leaves', 'users', 'classes', 'home']) {
      win.location.hash = '#/' + route;
      win.dispatchEvent(new win.HashChangeEvent('hashchange'));
      await new Promise(r => setTimeout(r, 150));
      for (const el of win.document.querySelectorAll('[data-act]')) acts.add(el.getAttribute('data-act'));
    }
    for (const act of acts) {
      const el = win.document.querySelector('[data-act="' + act + '"]');
      if (!el) continue;
      try {
        el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
      } catch (e) { win.__errors.push('click ' + act + ': ' + e.message); }
      await new Promise(r => setTimeout(r, 90));
      const now = win.document.body.textContent + ' ' + toastText(win);
      if (/این بخش به سیستم مدرسه نیاز دارد/.test(now)) fails.push('دکمهٔ «' + act + '» پیام «نیاز به سیستم مدرسه» داد');
      if (/ورود ناموفق/.test(now)) fails.push('دکمهٔ «' + act + '» خطای ورود داد');
      /* داخل پنجره‌های باز هم همهٔ دکمه‌ها زده می‌شوند (یک سطح) */
      const inner = [...win.document.querySelectorAll('#modal-root [data-act]')]
        .map(e => e.getAttribute('data-act'))
        .filter(a => a !== 'modal-close');
      for (const a2 of inner) {
        const el2 = win.document.querySelector('#modal-root [data-act="' + a2 + '"]');
        if (!el2) continue;
        try { el2.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true })); }
        catch (e) { win.__errors.push('click ' + act + '>' + a2 + ': ' + e.message); }
        await new Promise(r => setTimeout(r, 60));
        const t2 = win.document.body.textContent + ' ' + toastText(win);
        if (/این بخش به سیستم مدرسه نیاز دارد/.test(t2)) fails.push('دکمهٔ «' + act + ' › ' + a2 + '» پیام «نیاز به سیستم مدرسه» داد');
        if (/ورود ناموفق/.test(t2)) fails.push('دکمهٔ «' + act + ' › ' + a2 + '» خطای ورود داد');
      }
      /* بستن پنجرهٔ باز، تا دکمهٔ بعدی هم قابل زدن باشد */
      const close = win.document.querySelector('[data-act="modal-close"], [data-act="modal-x"]');
      if (close) { try { close.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); } catch (e) { /* noop */ } }
      await new Promise(r => setTimeout(r, 40));
    }
    check(win.__errors.length === 0, 'هیچ خطای اجرایی نبود' + (win.__errors.length ? ': ' + win.__errors.slice(0, 3).join(' | ') : ''));
    check(acts.size > 0, 'دکمه‌ها بررسی شدند (' + acts.size + ' مورد)');
    if (who.role === 'parent') {
      win.location.hash = '#/home';
      win.dispatchEvent(new win.HashChangeEvent('hashchange'));
      await new Promise(r => setTimeout(r, 200));
      const homeText = win.document.body.textContent;
      check(!/فرزندی به حساب شما متصل نیست/.test(homeText), 'ولی فرزندش را می‌بیند (نه پیام «فرزندی متصل نیست»)');
      check(homeText.includes(student.name), 'نام فرزند روی صفحهٔ ولی هست');
      win.location.hash = '#/child/' + student.id;
      win.dispatchEvent(new win.HashChangeEvent('hashchange'));
      await new Promise(r => setTimeout(r, 200));
      const childText = win.document.body.textContent;
      check(!/برای حساب شما فرزندی ثبت نشده/.test(childText), 'صفحهٔ پروندهٔ فرزند برای ولی باز می‌شود');
      check(childText.includes('حضور') || childText.includes('نمرات'), 'پروندهٔ فرزند اطلاعات دارد');

      /* ولی باید بتواند درخواست مرخصی بدهد و بی‌مدرسه هم به صف برود */
      win.location.hash = '#/leaves';
      win.dispatchEvent(new win.HashChangeEvent('hashchange'));
      await new Promise(r => setTimeout(r, 200));
      const addBtn = win.document.querySelector('[data-act="leave-add"]');
      check(!!addBtn, 'دکمهٔ درخواست مرخصی برای ولی هست');
      if (addBtn) {
        addBtn.click();
        await new Promise(r => setTimeout(r, 150));
        const form = win.document.querySelector('form[data-form="leave"]');
        check(!!form, 'فرم مرخصی برای ولی باز می‌شود');
        if (form) {
          check(form.elements.student_id && form.elements.student_id.options.length > 0, 'دانش‌آموز در فرم مرخصی انتخاب‌شدنی است');
          if (form.elements.reason) form.elements.reason.value = 'آزمون';
          form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
          await new Promise(r => setTimeout(r, 400));
          const keys = Object.keys(win.__objects);
          check(keys.some(k => /outbox/.test(k)), 'درخواست مرخصی در صف ماند (بدون مدرسه هم ثبت می‌شود)');
          check(!win.document.querySelector('form[data-form="leave"]'), 'فرم پس از ثبت بسته شد');
        }
      }
      win.location.hash = '#/home';
      win.dispatchEvent(new win.HashChangeEvent('hashchange'));
      await new Promise(r => setTimeout(r, 200));
    }
    const finalText = win.document.body.textContent;
    check(!/این بخش به سیستم مدرسه نیاز دارد/.test(finalText), 'هیچ صفحه‌ای پیام «نیاز به سیستم مدرسه» نداد');
    win.close();
  }

  if (fails.length) { console.log('\n❌ ' + fails.length + ' مورد ناموفق'); process.exit(1); }
  console.log('\n✅ مسیر گوشی برای دبیر و دانش‌آموز سالم است.');
})().catch(e => { console.error('❌ خطای آزمون:', e); process.exit(1); });
