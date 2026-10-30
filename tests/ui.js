'use strict';
/* آزمون دود رابط: هر صفحه برای سه نقش رندر می‌شود و خطای اجرایی ندارد.
   اجرا: node --experimental-sqlite tests/ui.js   (سرور و داده را خودش می‌سازد) */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-ui-'));
const env = Object.assign({}, process.env, { PAYESH_DATA: TMP, PAYESH_LOG: '0', PAYESH_AUTO_BACKUP: '0' });

const seed = spawnSync(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/seed.js', '--fresh'], { cwd: ROOT, env, encoding: 'utf8' });
const code = (seed.stdout.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/) || [])[0];
if (!code) { console.error(seed.stdout, seed.stderr); throw new Error('کد پیوند پیدا نشد'); }

let PORT, BASE, child, childExited = false;
process.on('exit', () => { childExited = true; try { child && child.kill('SIGKILL'); } catch (e) { /* noop */ } });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function freePort() {
  return new Promise(res => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
async function api(p, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = 'Bearer ' + opts.token;
  const r = await fetch(BASE + p, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return r.json();
}

async function mount(label, token, pathes, device) {
  const html = fs.readFileSync(path.join(ROOT, 'client/index.html'), 'utf8');
  const errors = [];
  const dom = new JSDOM(html, {
    url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true,
    beforeParse(win) {
      win.fetch = (u, o) => fetch(new URL(String(u), BASE), o);
      win.indexedDB = undefined;
      win.addEventListener('error', ev => errors.push(ev.message || String(ev.error)));
      win.addEventListener('unhandledrejection', ev => errors.push('promise: ' + (ev.reason && ev.reason.message)));
    },
  });
  const win = dom.window;
  win.localStorage.setItem('payesh.session', token);
  if (device) win.localStorage.setItem('payesh.device', device);
  win.scrollTo = () => {};
  const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
  win.eval(strip('client/pages.js') + '\n;\n' + strip('client/app.js'));
  win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
  await sleep(400);
  /* نشست آماده است → شروع عادی برنامه */
  win.eval('start()');

  let mounted = false;
  for (let i = 0; i < 120; i++) {
    if (win.document.querySelector('.shell, .sidebar, .bottomnav')) { mounted = true; break; }
    await sleep(100);
  }
  assert.ok(mounted, label + ': پوستهٔ برنامه رندر نشد — ' + (win.document.getElementById('app').textContent || '').slice(0, 120));

  const results = [];
  for (const h of pathes) {
    win.location.hash = h;
    win.dispatchEvent(new win.HashChangeEvent('hashchange'));
    await sleep(250);
    const el = win.document.getElementById('app');
    results.push({ route: h, len: el ? el.textContent.trim().length : 0, html: el ? el.innerHTML.length : 0, text: el ? el.textContent.trim().replace(/\s+/g, ' ').slice(0, 200) : '' });
  }
  console.log(`\n  ${label}:`);
  for (const r of results) console.log(`    ${r.route.padEnd(22)} متن ${String(r.len).padStart(5)} · html ${r.html}${process.env.TEXT ? '\n      » ' + r.text : ''}`);
  if (errors.length) console.log('    ⚠ خطاها:', errors.slice(0, 8));
  const empty = results.filter(r => r.len < 20);
  assert.strictEqual(errors.length, 0, 'خطای اجرایی: ' + errors[0]);
  assert.strictEqual(empty.length, 0, 'صفحهٔ خالی: ' + empty.map(e => e.route).join(', '));
  dom.window.close();
}

(async () => {
  PORT = await freePort();
  BASE = 'http://127.0.0.1:' + PORT;
  child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'],
    { cwd: ROOT, env: Object.assign({}, env, { PORT: String(PORT), HOST: '127.0.0.1' }), stdio: 'ignore' });
  child.on('exit', c => { if (!childExited) console.error('سرور بسته شد: ' + c); });
  for (let i = 0; i < 60; i++) { try { const h = await api('/api/health'); if (h.ok) break; } catch (e) { /* wait */ } await sleep(150); }

  const mgr = await api('/api/auth/pair', { method: 'POST', body: { code, pin: '1234' } });
  assert.ok(mgr.session, 'ورود مدیر');

  const pull = await api('/api/v1/pull?since=1970-01-01T00:00:00.000Z', { token: mgr.session.token });
  const users = pull.collections.users;
  const teacher = users.find(u => u.role === 'teacher');
  const parent = users.find(u => u.role === 'parent');
  const student = users.find(u => u.role === 'student');

  const pair = async (uid) => {
    const pc = await api('/api/admin/pair-code', { method: 'POST', token: mgr.session.token, body: { user_id: uid } });
    const p = await api('/api/auth/pair', { method: 'POST', body: { code: pc.code, pin: '1111' } });
    return { token: p.session.token, device: p.device_token };
  };

  await mount('مدیر', mgr.session.token, ['#/', '#/attendance', '#/grades', '#/students', '#/users', '#/classes', '#/schedule', '#/reports', '#/attendance-report', '#/announcements', '#/system'], mgr.device_token);
  const t = await pair(teacher.id);
  await mount('دبیر', t.token, ['#/', '#/attendance', '#/grades', '#/students', '#/schedule', '#/announcements', '#/system'], t.device);
  const p = await pair(parent.id);
  await mount('ولی', p.token, ['#/', '#/child', '#/leaves', '#/announcements', '#/system'], p.device);
  const st = await pair(student.id);
  await mount('دانش‌آموز', st.token, ['#/', '#/record', '#/announcements', '#/system'], st.device);

  console.log('\n✅ همهٔ صفحه‌ها رندر شدند.\n');
  childExited = true; child.kill('SIGTERM');
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error('\n❌', e.message); try { child.kill(); } catch (x) { /* noop */ } process.exit(1); });
