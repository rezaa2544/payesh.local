'use strict';
/* آزمون جریان کاربری واقعی:
   دبیر → حضور و غیاب کلاس → ثبت نهایی → بررسی رسیدن داده به سرور
   مدیر → انتشار اطلاعیه → بررسی
   ولی  → درخواست مرخصی → بررسی
   اجرا: node --experimental-sqlite tests/flow.js */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-flow-'));
const env = Object.assign({}, process.env, { PAYESH_DATA: TMP, PAYESH_LOG: '0', PAYESH_AUTO_BACKUP: '0' });
const seed = spawnSync(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/seed.js', '--fresh'], { cwd: ROOT, env, encoding: 'utf8' });
const adminCode = (seed.stdout.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/) || [])[0];

const sleep = ms => new Promise(r => setTimeout(r, ms));
let BASE = '', child = null, exited = false;
process.on('exit', () => { exited = true; try { child && child.kill('SIGKILL'); } catch (e) { /* noop */ } });

async function api(p, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = 'Bearer ' + opts.token;
  const r = await fetch(BASE + p, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return r.json();
}

async function openAs(token, device) {
  const html = fs.readFileSync(path.join(ROOT, 'client/index.html'), 'utf8');
  const errors = [];
  const dom = new JSDOM(html, {
    url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true,
    beforeParse(win) {
      win.fetch = (u, o) => fetch(new URL(String(u), BASE), o);
      win.indexedDB = undefined;
      win.scrollTo = () => {};
      win.alert = () => {};
      win.addEventListener('error', ev => errors.push(ev.message || String(ev.error)));
      win.addEventListener('unhandledrejection', ev => errors.push('promise: ' + (ev.reason && ev.reason.message)));
    },
  });
  const win = dom.window;
  win.localStorage.setItem('payesh.session', token);
  win.localStorage.setItem('payesh.device', device);
  const strip = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
  win.eval(strip('client/pages.js') + '\n;\n' + strip('client/app.js'));
  win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
  await sleep(300);
  win.eval('start()');
  for (let i = 0; i < 100; i++) {
    if (win.document.querySelector('.shell, .sidebar, .bottomnav')) break;
    await sleep(100);
  }
  win.errors = errors;
  return win;
}

async function go(win, hash) {
  win.location.hash = hash;
  win.dispatchEvent(new win.HashChangeEvent('hashchange'));
  await sleep(300);
}

(async () => {
  const net = require('net');
  const port = await new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  BASE = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'],
    { cwd: ROOT, env: Object.assign({}, env, { PORT: String(port), HOST: '127.0.0.1' }), stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await api('/api/health')).ok) break; } catch (e) { /* wait */ } await sleep(150); }

  console.log('\nجریان کاربری\n');
  const mgr = await api('/api/auth/pair', { method: 'POST', body: { code: adminCode, pin: '1234' } });
  const MT = mgr.session.token;
  const pull = await api('/api/v1/pull?since=1970-01-01T00:00:00.000Z', { token: MT });
  const teacher = pull.collections.users.find(u => u.role === 'teacher');
  const parent = pull.collections.users.find(u => u.role === 'parent');
  const sched = pull.collections.schedule.find(s => Number(s.teacher_id) === Number(teacher.id));
  assert.ok(sched, 'برنامهٔ دبیر');

  /* ── دبیر: حضور و غیاب ── */
  const tp = await api('/api/admin/pair-code', { method: 'POST', token: MT, body: { user_id: teacher.id } });
  const tPair = await api('/api/auth/pair', { method: 'POST', body: { code: tp.code, pin: '1111' } });
  const tw = await openAs(tPair.session.token, tPair.device_token);

  await go(tw, '#/attendance/' + sched.class_id);
  const rows = tw.document.querySelectorAll('.att-row');
  assert.ok(rows.length > 0, 'فهرست دانش‌آموزان کلاس');
  console.log('  ✓ فهرست کلاس دبیر: ' + rows.length + ' دانش‌آموز');

  const firstSid = Number(rows[0].getAttribute('data-sid'));
  rows[0].querySelector('.att-btn[data-s="absent"]').dispatchEvent(new tw.MouseEvent('click', { bubbles: true }));
  await sleep(100);
  assert.ok(rows[0].querySelector('.att-btn[data-s="absent"]').className.includes('on-a'), 'دکمهٔ غایب فعال شود');
  tw.document.querySelector('[data-act="att-save"]').dispatchEvent(new tw.MouseEvent('click', { bubbles: true }));
  await sleep(1500);

  const today = new Date(Date.now() + (() => 0)()).toISOString().slice(0, 10);
  const after = await api('/api/v1/pull?since=1970-01-01T00:00:00.000Z', { token: MT });
  const saved = after.collections.attendance.filter(a => Number(a.student_id) === firstSid && a.date === today);
  assert.ok(saved.length >= 1, 'حضور در سرور ثبت شود');
  assert.strictEqual(saved[0].status, 'absent');
  console.log('  ✓ حضور ثبت شد (server): دانش‌آموز ' + firstSid + ' → غایب');

  /* ── مدیر: اطلاعیه ── */
  const mw = await openAs(MT, mgr.device_token);
  await go(mw, '#/announcements');
  mw.document.querySelector('[data-act="ann-add"]').dispatchEvent(new mw.MouseEvent('click', { bubbles: true }));
  await sleep(300);
  const form = mw.document.querySelector('form[data-form="ann"]');
  assert.ok(form, 'فرم اطلاعیه باز شود');
  form.elements.title.value = 'اطلاعیهٔ آزمون';
  form.elements.body.value = 'متن آزمون';
  form.dispatchEvent(new mw.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(1500);
  const afterAnn = await api('/api/v1/pull?since=1970-01-01T00:00:00.000Z', { token: MT });
  assert.ok(afterAnn.collections.announcements.some(a => a.title === 'اطلاعیهٔ آزمون'), 'اطلاعیه در سرور');
  console.log('  ✓ اطلاعیه از رابط منتشر و در سرور ثبت شد');

  /* ── ولی: درخواست مرخصی ── */
  const pp = await api('/api/admin/pair-code', { method: 'POST', token: MT, body: { user_id: parent.id } });
  const pPair = await api('/api/auth/pair', { method: 'POST', body: { code: pp.code, pin: '2222' } });
  const pw = await openAs(pPair.session.token, pPair.device_token);
  await go(pw, '#/child');
  assert.ok(pw.document.body.textContent.includes('معدل'), 'صفحهٔ فرزند برای ولی');
  await go(pw, '#/leaves');
  pw.document.querySelector('[data-act="leave-add"]').dispatchEvent(new pw.MouseEvent('click', { bubbles: true }));
  await sleep(300);
  const lf = pw.document.querySelector('form[data-form="leave"]');
  assert.ok(lf, 'فرم مرخصی');
  lf.elements.reason.value = 'مراجعه به پزشک';
  lf.dispatchEvent(new pw.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(1500);
  const afterLeave = await api('/api/v1/pull?since=1970-01-01T00:00:00.000Z', { token: MT });
  assert.ok(afterLeave.collections.leaves.some(l => l.reason === 'مراجعه به پزشک'), 'مرخصی در سرور');
  console.log('  ✓ درخواست مرخصی از پنل ولی به سرور رسید');

  const errs = [...tw.errors, ...mw.errors, ...pw.errors];
  assert.strictEqual(errs.length, 0, 'خطای اجرایی: ' + errs[0]);

  console.log('\n✅ جریان‌ها سالم.\n');
  exited = true; child.kill('SIGTERM');
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error('\n❌', e.message); try { child.kill(); } catch (x) { /* noop */ } process.exit(1); });
