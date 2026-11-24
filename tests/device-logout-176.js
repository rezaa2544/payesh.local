'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 176 lab — D-04 / D-05 regression (server/auth.js)
   Real school server over HTTP, real SQLite file read back directly. No mocks.

   D-04  explicit logout must retire the session's device, so repeated
         login → logout from one client never fills PAYESH_DEVICE_CAP.
   D-05  /api/admin/devices must show the owning user's real name/role
         (records.data JSON), never "—" for an existing user.

   DL-01  3×CAP login→logout cycles from ONE client: every login succeeds (no device_limit)
   DL-02  after every logout the active-device count in the DB is back to baseline
   DL-03  logged-out device: revoked_at set, revoke_reason='logout', audit 'device_logout'
   DL-04  logged-out access token → 401; its device_token can no longer refresh (device_revoked)
   DL-05  regression: a device that did NOT log out still refreshes and stays active (lock ≠ logout)
   DL-06  regression: the cap itself still holds — CAP live logins without logout ⇒ next is device_limit
   DL-07  D-05: every /api/admin/devices row's user_name/role equals the DB's records.data name/role
   DL-08  D-05: no row of an existing user shows "—"
   MUT-*  negative controls: each fix reverted in a throw-away copy of server/ ⇒ its check goes red

   Run: node --experimental-sqlite --disable-warning=ExperimentalWarning tests/device-logout-176.js
        DL176_NO_MUTANTS=1 skips the mutant pass (local iteration only).
   ═══════════════════════════════════════════════════════════════════ */
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-dl176-'));
const CAP = 4;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const children = [];

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

async function startServer(root, label) {
  const port = await freePort();
  const data = path.join(TMP, label);
  const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', path.join(root, 'server/index.js')], {
    cwd: root,
    env: Object.assign({}, process.env, {
      PORT: String(port), HOST: '127.0.0.1', PAYESH_DATA: data, PAYESH_LOG: '0',
      PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0', PAYESH_LIVE_MS: '0',
      PAYESH_OUTBOX_AUTO: '0', PAYESH_CLOUD_AUTO: '0', PAYESH_MIRROR: '0',
      PAYESH_DEVICE_CAP: String(CAP), PAYESH_ACCESS_TTL_MIN: '', PAYESH_DEVICE_STALE_DAYS: '', PAYESH_DEVICE_DAYS: '',
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.push(child);
  child.err = '';
  child.stderr.on('data', d => { child.err += String(d); });
  const base = 'http://127.0.0.1:' + port;
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch (e) { /* retry */ }
    if (Date.now() - t0 > 20000) throw new Error('server did not start: ' + child.err.slice(0, 400));
    await sleep(120);
  }
  return { child, base, dbFile: path.join(data, 'payesh.sqlite') };
}

async function suite(srv, { quiet = false } = {}) {
  let pass = 0, fail = 0;
  const failed = [];
  const check = (id, ok, msg) => {
    if (ok) pass++; else { fail++; if (!failed.includes(id)) failed.push(id); }
    if (!quiet || !ok) console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${msg}`);
  };
  const call = async (p, { method = 'GET', body, token } = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;
    const r = await fetch(srv.base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const db = () => new DatabaseSync(srv.dbFile, { readOnly: true });
  const q = (sql, ...a) => { const d = db(); try { return d.prepare(sql).all(...a); } finally { d.close(); } };

  const phone = '09000001760';
  const password = 'dl176-' + crypto.randomBytes(6).toString('hex');
  const st = await call('/api/setup', { method: 'POST', body: { manager_name: 'Lab176 Manager', phone, password, school_name: 'Lab176' } });
  if (!(st.status === 200 && st.json.ok)) throw new Error('setup failed ' + st.status + ' ' + JSON.stringify(st.json).slice(0, 120));
  const mgr = q("SELECT id, data FROM records WHERE collection='users'").map(r => ({ id: r.id, u: JSON.parse(r.data) })).find(r => r.u.role === 'manager');
  const activeOf = (uid) => q('SELECT COUNT(*) n FROM devices WHERE user_id=? AND revoked_at IS NULL', uid)[0].n;
  const login = (name) => call('/api/auth/login', { method: 'POST', body: { phone, password, name, platform: 'windows' } });

  /* D-04 */
  const baseline = activeOf(mgr.id);
  const cycles = 3 * CAP;
  let okLogins = 0, backToBase = 0, revokedOk = 0, auditOk = 0, tokenDead = 0, refreshDead = 0;
  const trail = [];
  for (let i = 1; i <= cycles; i++) {
    const r = await login('shared-pc');
    trail.push(i + ':' + r.status + (r.json.error ? '/' + r.json.error : ''));
    if (!(r.status === 200 && r.json.session)) break;
    okLogins++;
    const tok = r.json.session.token, dev = r.json.device_id, dtok = r.json.device_token;
    const lo = await call('/api/auth/logout', { method: 'POST', token: tok });
    if (lo.status !== 200) trail.push('logout' + lo.status);
    if (activeOf(mgr.id) === baseline) backToBase++;
    const row = q('SELECT revoked_at, revoke_reason FROM devices WHERE id=?', dev)[0] || {};
    if (row.revoked_at && row.revoke_reason === 'logout') revokedOk++;
    if (q("SELECT COUNT(*) n FROM audit WHERE action='device_logout' AND device_id=?", dev)[0].n === 1) auditOk++;
    if (i === 1 || i === cycles) {
      const me = await call('/api/me', { token: tok });
      if (me.status === 401) tokenDead++;
      const rf = await call('/api/auth/refresh', { method: 'POST', body: { device_token: dtok } });
      if (rf.status === 401 && rf.json.error === 'device_revoked') refreshDead++;
    }
  }
  check('DL-01', okLogins === cycles, `${okLogins}/${cycles} login→logout cycles succeeded with cap ${CAP} [${trail.join(' ')}]`);
  check('DL-02', backToBase === cycles, `active devices back to baseline ${baseline} after ${backToBase}/${cycles} logouts (now ${activeOf(mgr.id)})`);
  check('DL-03', revokedOk === cycles && auditOk === cycles, `revoke_reason=logout ${revokedOk}/${cycles}, audit device_logout ${auditOk}/${cycles}`);
  check('DL-04', tokenDead === 2 && refreshDead === 2, `after logout: /api/me 401 ${tokenDead}/2, refresh device_revoked ${refreshDead}/2`);

  /* DL-05: lock ≠ logout — a device that stays signed in keeps working */
  const keep = await login('kept-laptop');
  const rf = keep.json.device_token ? await call('/api/auth/refresh', { method: 'POST', body: { device_token: keep.json.device_token } }) : { status: 0, json: {} };
  const keptRow = keep.json.device_id ? q('SELECT revoked_at FROM devices WHERE id=?', keep.json.device_id)[0] : null;
  check('DL-05', keep.status === 200 && rf.status === 200 && rf.json.ok && keptRow && !keptRow.revoked_at,
    `non-logged-out device: login ${keep.status}, refresh ${rf.status}, still active=${!!(keptRow && !keptRow.revoked_at)}`);

  /* DL-06: cap still enforced for devices that never log out */
  const live = [];
  let limited = null;
  for (let i = 0; i < CAP + 1; i++) {
    const r = await login('live-' + i);
    if (r.status === 200 && r.json.session) live.push(r.json.session.token);
    else { limited = r; break; }
  }
  const act = activeOf(mgr.id);
  check('DL-06', !!limited && limited.json.error === 'device_limit' && act === CAP,
    `cap ${CAP} still enforced: refused=${limited ? limited.status + '/' + limited.json.error : 'never'} with ${act} active`);

  /* D-05 — claim (loopback, cap-exempt) gives a manager session */
  const c = await call('/api/auth/claim', { method: 'POST', body: { phone, password } });
  const L = await call('/api/admin/devices', { token: c.json.session && c.json.session.token });
  const devs = (L.json && L.json.devices) || [];
  const users = new Map(q("SELECT id, data FROM records WHERE collection='users'").map(r => [Number(r.id), JSON.parse(r.data)]));
  let match = 0, dash = 0;
  for (const d of devs) {
    const u = users.get(Number(d.user_id));
    if (u && d.user_name === u.name && d.role === u.role) match++;
    if (u && (d.user_name === '—' || d.role === '—')) dash++;
  }
  check('DL-07', L.status === 200 && devs.length > 0 && match === devs.length,
    `admin/devices ${L.status}: ${match}/${devs.length} rows match DB records.data name/role (e.g. ${devs[0] ? JSON.stringify(devs[0].user_name + '/' + devs[0].role) : '-'})`);
  check('DL-08', devs.length > 0 && dash === 0, `${dash} rows of existing users show "—"`);
  return { pass, fail, failed };
}

const MUTANTS = [
  { id: 'MUT-logout-keeps-device', target: 'DL-01', file: 'server/auth.js', from: "    identity.revokeDevice(store, session.device_id, 'logout');", to: '' },
  { id: 'MUT-devices-name-column', target: 'DL-07', file: 'server/auth.js', from: "(SELECT data FROM records WHERE collection='users' AND id=d.user_id) AS user_json", to: "(SELECT name FROM records WHERE collection='users' AND id=d.user_id) AS user_json" },
  { id: 'MUT-cap-off', target: 'DL-06', file: 'server/identity.js', from: '  if (n >= cfg.cap) {', to: '  if (false) {' },
];

function mutantRoot(m) {
  const root = path.join(TMP, 'root-' + m.id);
  fs.mkdirSync(root, { recursive: true });
  for (const e of fs.readdirSync(ROOT)) {
    if (e === 'server' || e === '.git') continue;
    fs.symlinkSync(path.join(ROOT, e), path.join(root, e));
  }
  fs.cpSync(path.join(ROOT, 'server'), path.join(root, 'server'), { recursive: true });
  const f = path.join(root, m.file);
  const src = fs.readFileSync(f, 'utf8');
  if (!src.includes(m.from)) throw new Error(m.id + ': mutation anchor not found in ' + m.file);
  fs.writeFileSync(f, src.replace(m.from, m.to));
  return root;
}

(async () => {
  let FAIL = 0;
  console.log('── D-04/D-05 suite on the real tree ──');
  const srv = await startServer(ROOT, 'main');
  const res = await suite(srv);
  srv.child.kill('SIGKILL');
  FAIL += res.fail;
  console.log(`DL checks=${res.pass + res.fail} pass=${res.pass} fail=${res.fail}`);
  let killed = 0;
  if (process.env.DL176_NO_MUTANTS !== '1') {
    console.log('\n── negative controls: each fix reverted ⇒ its check must go red ──');
    for (const m of MUTANTS) {
      let line;
      try {
        const s = await startServer(mutantRoot(m), m.id);
        let r;
        try { r = await suite(s, { quiet: true }); } catch (e) { r = { fail: 1, failed: ['crash:' + e.message.slice(0, 60)] }; }
        s.child.kill('SIGKILL');
        const ok = r.failed.includes(m.target);
        if (ok) killed++; else FAIL++;
        line = `${ok ? 'PASS' : 'FAIL'}  ${m.id}  revert in ${m.file} ⇒ ${m.target} red  → red=[${r.failed.join(',')}]`;
      } catch (e) { FAIL++; line = `FAIL  ${m.id}  ${e.message}`; }
      console.log(line);
    }
    console.log(`MUTANTS total=${MUTANTS.length} killed=${killed}`);
  }
  console.log(`\n${FAIL ? 'DEVICE-LOGOUT-176-FAIL' : 'DEVICE-LOGOUT-176-OK'} checks=${res.pass + res.fail} mutants_killed=${killed}/${process.env.DL176_NO_MUTANTS === '1' ? 0 : MUTANTS.length}`);
  for (const c of children) { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } }
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(FAIL ? 1 : 0);
})().catch(e => {
  console.error('DEVICE-LOGOUT-176-ERROR', e && e.stack || e);
  for (const c of children) { try { c.kill('SIGKILL'); } catch (er) { /* gone */ } }
  process.exit(1);
});
