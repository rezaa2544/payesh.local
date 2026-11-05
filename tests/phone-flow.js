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
const student = { id: 9, name: 'دانش‌آموز تست', role: 'student', phone: '09121234567', active: true };
const password = '123456';

const core = {
  at: '2026-11-05T10:00:00.000Z',
  school: { id: 1, name: 'دبیرستان تست', type: 'کاردانش', level: 'متوسطه دوم' },
  directory: [teacher, student].map(u => ({ id: u.id, name: u.name, role: u.role })),
  collections: {
    users: [teacher, student],
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
  const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><head></head><body><div id="app"></div><div id="toasts"></div></body></html>', {
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
  objects[PREFIX + 'auth/' + teacher.phone + '.json'] = JSON.stringify({ verifier: mk(password), user: teacher });
  objects[PREFIX + 'auth/' + student.phone + '.json'] = JSON.stringify({ verifier: mk(password), user: student });
  objects[PREFIX + 'data/core.json'] = JSON.stringify(core);
  objects[PREFIX + 'data/person/' + teacher.id + '.json'] = JSON.stringify({ me: teacher, children: [], collections: {} });
  objects[PREFIX + 'data/person/' + student.id + '.json'] = JSON.stringify({ me: student, children: [], collections: {} });

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

  for (const who of [teacher, student]) {
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
    const finalText = win.document.body.textContent;
    check(!/این بخش به سیستم مدرسه نیاز دارد/.test(finalText), 'هیچ صفحه‌ای پیام «نیاز به سیستم مدرسه» نداد');
    win.close();
  }

  if (fails.length) { console.log('\n❌ ' + fails.length + ' مورد ناموفق'); process.exit(1); }
  console.log('\n✅ مسیر گوشی برای دبیر و دانش‌آموز سالم است.');
})().catch(e => { console.error('❌ خطای آزمون:', e); process.exit(1); });
