// LAB 176 — sandbox reproduction of D-04 (logout leaves the device active → device_limit after
// repeated login/logout) and D-05 (/api/admin/devices returns user_name/role "—").
// Runs the repo's own server/index.js on a throw-away data dir; nothing outside /tmp is touched.
'use strict';
const { spawn } = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const REPO = process.env.REPO || '/work/repo'; const PORT = 18977; const B = 'http://127.0.0.1:' + PORT;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'def04-'));
const srv = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'],
  { cwd: REPO, env: Object.assign({}, process.env, { PORT: String(PORT), PAYESH_DATA: dir, PAYESH_UPDATE_AUTO: '0' }), stdio: ['ignore', 'ignore', 'pipe'] });
const j = async (p, o = {}) => { const r = await fetch(B + p, Object.assign({ headers: Object.assign({ 'content-type': 'application/json' }, o.token ? { authorization: 'Bearer ' + o.token } : {}) }, o)); return { s: r.status, j: await r.json().catch(() => null) }; };
const pub = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
let fail = 0; const out = (id, ok, msg) => { if (!ok) fail++; console.log((ok ? 'CONFIRMED ' : 'NOT-REPRO ') + id + '  ' + msg); };
(async () => {
  for (let i = 0; i < 60; i++) { try { const h = await fetch(B + '/api/health'); if (h.ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 250)); }
  const phone = '09000000999', password = 'repro-' + crypto.randomBytes(6).toString('hex');
  const st = await j('/api/setup', { method: 'POST', body: JSON.stringify({ manager_name: 'Repro Manager', phone, password, school_name: 'Repro' }) });
  console.log('setup', st.s, st.j && st.j.ok);
  // D-04: the SAME client (same device key) logs in and out repeatedly, as a teacher on a shared PC would.
  const key = pub(); const log = [];
  let blockedAt = 0;
  for (let i = 1; i <= 12; i++) {
    const r = await j('/api/auth/login', { method: 'POST', body: JSON.stringify({ phone, password, name: 'shared-pc', platform: 'windows', device_pubkey: key }) });
    const tok = r.j && r.j.session && r.j.session.token;
    log.push(i + ':' + r.s + (r.j && r.j.error ? '/' + r.j.error : ''));
    if (!tok) { blockedAt = i; break; }
    const lo = await j('/api/auth/logout', { method: 'POST', token: tok }); if (lo.s !== 200) log.push('logout' + lo.s);
  }
  console.log('login/logout cycles:', log.join(' '));
  out('D-04', blockedAt > 0, blockedAt ? `cycle ${blockedAt} refused with device_limit after ${blockedAt - 1} clean login→logout cycles from ONE client (setup device + ${blockedAt - 1} orphans = cap 10)` : 'never blocked');
  // D-05: manager device list (cap-exempt loopback claim, same password) → user_name/role
  const c = await j('/api/auth/claim', { method: 'POST', body: JSON.stringify({ phone, password }) });
  const T = c.j && c.j.session && c.j.session.token;
  const L = await j('/api/admin/devices', { token: T });
  const devs = (L.j && L.j.devices) || [];
  const active = devs.filter(d => !d.revoked);
  const names = [...new Set(devs.map(d => d.user_name + '/' + d.role))];
  console.log('admin/devices status', L.s, 'total', devs.length, 'active', active.length, 'distinct user_name/role:', JSON.stringify(names));
  out('D-05', devs.length > 0 && names.every(n => n === '—/—'), 'every device row shows user_name/role "—/—" although all belong to manager "Repro Manager"');
  srv.kill('SIGTERM'); fs.rmSync(dir, { recursive: true, force: true });
  console.log(fail ? 'REPRO-INCOMPLETE' : 'REPRO-OK both defects reproduced');
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); srv.kill(); process.exit(1); });
