#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 197 — Q12 (F16): the first password of every account is the national id (everyone at
   school knows it). Signing in with it must force a new password before anything else.

     F01  server: login / refresh / unlock with the first password answer must_change: true
     F02  server: the new password may not be the national id (password_is_default) nor the
          current one (password_unchanged); after a real change no must_change, the national
          id no longer signs in
     F03  NEG: an account whose password is not its national id (manager-set, or no national
          id) never gets must_change
     F04  web: must_change ⇒ only «رمز تازه» (no page, no menu); the form refuses the national
          id locally; a successful change opens the panel
     F05  Dart twin: LanSession.mustChange, AccountError.passwordIsDefault/passwordUnchanged,
          SessionGate.forcedPassword → ForcedPasswordScreen
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let passed = 0, failed = 0;
const pending = [];
function check(id, desc, fn) {
  pending.push(async () => {
    try { const d = await fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
    catch (e) { failed++; console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.stack) || e)}`); }
  });
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const J = (x) => JSON.stringify(x);

const auth = require(path.join(ROOT, 'server/auth'));
const { openStore } = require(path.join(ROOT, 'server/db'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpw197-'));
const st = openStore(path.join(TMP, 'a.sqlite'));
const NID = '1970000015';
const PHONE = '09121970001';
const teacher = st.insert('users', auth.applyDefaultCredentials({ name: 'دبیر', role: 'teacher', phone: PHONE, national_id: NID, active: true }, st));
const login = (password, extra) => auth.login(st, Object.assign({ phone: PHONE, password, platform: 'web', name: 'test' }, extra || {}));

check('F01', 'first password ⇒ must_change on login, refresh and unlock', () => {
  const r = login(NID);
  assert(r.ok && r.must_change === true, 'login ' + J(r));
  const fa = login('۱۹۷۰۰۰۰۰۱۵');
  assert(!fa.ok || fa.must_change === true, 'Persian digits ' + J(fa));
  const rf = auth.refreshWithDevice(st, { device_token: r.device_token });
  assert(rf.ok && rf.must_change === true, 'refresh ' + J(rf));
  const un = auth.unlockWithPassword(st, { device_token: rf.device_token || r.device_token, password: NID });
  assert(un.ok && un.must_change === true, 'unlock ' + J(un));
  return 'login, refresh, unlock';
});

check('F02', 'change: not the national id, not the same; afterwards no must_change', () => {
  const d = auth.changeOwnPassword(st, teacher.id, NID, NID);
  assert(d.error === 'password_is_default', 'nid ' + J(d));
  const sp = auth.changeOwnPassword(st, teacher.id, NID, ' ' + NID + ' ');
  assert(sp.error === 'password_is_default', 'nid with spaces ' + J(sp));
  const wrong = auth.changeOwnPassword(st, teacher.id, '0000', 'Gol-1405');
  assert(wrong.error === 'bad_credentials', 'wrong current ' + J(wrong));
  const ok = auth.changeOwnPassword(st, teacher.id, NID, 'Gol-1405');
  assert(ok.ok, 'change ' + J(ok));
  const same = auth.changeOwnPassword(st, teacher.id, 'Gol-1405', 'Gol-1405');
  assert(same.error === 'password_unchanged', 'same ' + J(same));
  const r = login('Gol-1405');
  assert(r.ok && !('must_change' in r), 'new login ' + J(r));
  const rf = auth.refreshWithDevice(st, { device_token: r.device_token });
  assert(rf.ok && !('must_change' in rf), 'refresh ' + J(rf));
  const old = login(NID);
  assert(!old.ok && old.error === 'bad_credentials', 'old nid ' + J(old));
  return 'password_is_default, password_unchanged, then clean';
});

check('F03', 'NEG: manager-set or national-id-less passwords are not forced', () => {
  const m = st.insert('users', { name: 'مدیر', role: 'manager', phone: '09121970099', national_id: '1970000996', active: true });
  auth.setPassword(st, m.id, 'Owner-77');
  const r = auth.login(st, { phone: '09121970099', password: 'Owner-77', platform: 'web', name: 't' });
  assert(r.ok && !r.must_change, 'manager ' + J(r));
  const p = st.insert('users', auth.applyDefaultCredentials({ name: 'ولی', role: 'parent', phone: '09121970098', active: true }, st));
  const pw = auth.passwordOf(st, st.get('users', p.id));
  const r2 = auth.login(st, { phone: '09121970098', password: pw, platform: 'web', name: 't' });
  assert(r2.ok && !r2.must_change, 'no national id ' + J(r2));
  assert(auth.mustChangePassword(st.get('users', p.id)) === false, 'helper');
  return 'no must_change';
});

function web(user) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
    { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
  win.eval(strip('client/lib/xlsx.js') + '\n;\n' + strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/app.js')
    + '\n;window.__t = { S, PAGES, render };');
  const T = win.__t;
  T.S.user = user; T.S.role = user.role; T.S.session = 'x'; T.S.route = 'home';
  T.S.data = { users: new Map([[user.id, user]]), classes: new Map(), schedule: new Map(), subjects: new Map(), announcements: new Map(),
    attendance: new Map(), grades: new Map(), calendar: new Map(), lookups: new Map(), schools: new Map(), parent_links: new Map(), leaves: new Map() };
  T.S.queue = []; T.S.online = false;
  win.flushQueue = async () => {};
  const calls = [];
  win.fetch = async (url, o) => {
    calls.push({ url: String(url), body: o && o.body ? JSON.parse(o.body) : null });
    const body = { ok: true };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
  };
  return { win, T, doc: win.document, calls };
}
async function submit(w, sel) {
  const form = w.doc.querySelector(sel);
  assert(form, 'form ' + sel);
  form.dispatchEvent(new w.win.Event('submit', { bubbles: true, cancelable: true }));
  for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 5));
}

check('F04', 'web: forced «رمز تازه» before any page', async () => {
  const w = web({ id: 7, name: 'دبیر', role: 'teacher', national_id: NID });
  for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 5));   // the boot screen paints first
  w.T.S.user = { id: 7, name: 'دبیر', role: 'teacher', national_id: NID }; w.T.S.session = 'x';
  w.T.S.mustChange = true; w.T.S.loginPw = NID;
  w.T.render();
  const card = w.doc.querySelector('[data-forced-pw]');
  assert(card, 'forced card ' + w.doc.getElementById('app').innerHTML.slice(0, 300));
  assert(!w.doc.querySelector('[data-forced-pw] input[name="current"][type="password"]'), 'current is known — not asked');
  assert(w.doc.querySelector('form[data-form="own-password"][data-forced]'), 'forced form');
  const set = (n, v) => { w.doc.querySelector('form[data-form="own-password"][data-forced]').elements.namedItem(n).value = v; };
  set('next', NID); set('again', NID);
  await submit(w, 'form[data-form="own-password"]');
  assert(!w.calls.some(c => /auth\/password/.test(c.url)), 'national id refused locally');
  assert(w.T.S.mustChange === true, 'still forced');
  if (!w.doc.querySelector('[data-forced-pw]')) throw new Error('after refuse: mc=' + w.T.S.mustChange + ' route=' + w.T.S.route + ' ' + w.doc.getElementById('app').innerHTML.slice(0, 400) + ' toasts=' + w.doc.getElementById('toasts').textContent);
  set('next', 'Gol-1405'); set('again', 'Gol-1405');
  await submit(w, 'form[data-form="own-password"]');
  const call = w.calls.find(c => /auth\/password/.test(c.url));
  assert(call && call.body.current === NID && call.body.next === 'Gol-1405', 'sent ' + J(w.calls));
  assert(w.T.S.mustChange === false && !w.T.S.loginPw, 'cleared');
  assert(!w.doc.querySelector('[data-forced-pw]'), 'panel open');
  // NEG: without must_change the panel opens at once
  const w2 = web({ id: 8, name: 'دبیر', role: 'teacher' });
  for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 5));
  w2.T.S.user = { id: 8, name: 'دبیر', role: 'teacher' }; w2.T.S.session = 'x';
  w2.T.render();
  assert(!w2.doc.querySelector('[data-forced-pw]'), 'not forced');
  return 'forced → refused nid → changed → panel';
});

check('F05', 'Dart twin', () => {
  const rd = (f) => fs.readFileSync(path.join(ROOT, 'apps/payesh', f), 'utf8');
  const lan = rd('packages/payesh_sync/lib/src/lan_access.dart');
  assert(/mustChange: j\['must_change'\] == true/.test(lan), 'LanSession.mustChange');
  const acc = rd('packages/payesh_sync/lib/src/accounts.dart');
  for (const w of ['password_is_default', 'password_unchanged']) assert(acc.includes(`'${w}'`), 'wire ' + w);
  const gate = rd('app/lib/src/login/login_screens.dart');
  assert(/when controller\.mustChangePassword && forcedPassword != null/.test(gate), 'SessionGate');
  const app = rd('app/lib/src/app.dart');
  assert(/forcedPassword:[\s\S]{0,200}ForcedPasswordScreen\(/.test(app), 'wired');
  return 'LanSession, AccountError, SessionGate, app';
});

(async () => {
  for (const p of pending) await p();
  try { st.db.close(); } catch (e) { /* noop */ }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(failed ? 'FIRST-LOGIN-197-FAILED' : 'FIRST-LOGIN-197-OK');
  process.exit(failed ? 1 : 0);
})();
