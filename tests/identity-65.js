'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 65 — device identity (server/identity.js + server/auth.js + server/index.js)
   Real school server over HTTP, real SQLite file. No mocks.

   ID65-01..20  positive / negative / forgery / replay / expiry checks (list below)
   MUT-*        negative controls: each identity fix is reverted in a throw-away copy
                of server/ and the suite is re-run; every mutant MUST turn its target
                check red (proves the tests really guard the fix).

   Run: node --experimental-sqlite --disable-warning=ExperimentalWarning tests/identity-65.js
        IDENTITY65_NO_MUTANTS=1 skips the mutant pass (local iteration only).
   ═══════════════════════════════════════════════════════════════════ */
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-id65-'));
const GRACE_SEC = 2;
const CAP = 6;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const children = [];

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

async function startServer(root, label) {
  const port = await freePort();
  const data = path.join(TMP, label);
  const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', path.join(root, 'server/index.js')], {
    cwd: root,
    env: Object.assign({}, process.env, {
      PORT: String(port), HOST: '0.0.0.0', PAYESH_DATA: data, PAYESH_LOG: '0',
      PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0', PAYESH_LIVE_MS: '0',
      PAYESH_OUTBOX_AUTO: '0', PAYESH_CLOUD_AUTO: '0', PAYESH_MIRROR: '0',
      PAYESH_REFRESH_GRACE_SEC: String(GRACE_SEC), PAYESH_DEVICE_CAP: String(CAP),
      PAYESH_ACCESS_TTL_MIN: '', PAYESH_DEVICE_STALE_DAYS: '', PAYESH_DEVICE_DAYS: '',
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
  return { child, base, port, dbFile: path.join(data, 'payesh.sqlite') };
}

/* ── the suite: returns {pass, fail, failed:[ids]} ─────────────────────── */
async function suite(srv, { quiet = false } = {}) {
  let pass = 0, fail = 0;
  const failed = [];
  const log = (s) => { if (!quiet) console.log(s); };
  async function test(id, name, fn) {
    try { const d = await fn(); pass++; log(`PASS  ${id}  ${name}${d ? '  → ' + d : ''}`); }
    catch (e) { fail++; failed.push(id); log(`FAIL  ${id}  ${name}  → ${String(e && e.message || e).replace(/\s+/g, ' ').slice(0, 300)}`); }
  }
  async function req(p, { method = 'GET', body, token, base = srv.base, headers = {} } = {}) {
    const h = Object.assign({ 'content-type': 'application/json' }, headers);
    if (token) h.authorization = 'Bearer ' + token;
    const r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    return { status: r.status, data };
  }
  const db = () => new DatabaseSync(srv.dbFile);
  const dbRun = (sql, ...args) => { const d = db(); try { return d.prepare(sql).run(...args); } finally { d.close(); } };
  const dbAll = (sql, ...args) => { const d = db(); try { return d.prepare(sql).all(...args); } finally { d.close(); } };
  const refresh = (device_token, extra = {}) => req('/api/auth/refresh', { method: 'POST', body: Object.assign({ device_token }, extra) });
  const seenTokens = [];
  const keep = (r) => { if (r && r.data) { if (r.data.device_token) seenTokens.push(r.data.device_token); if (r.data.session) seenTokens.push(r.data.session.token); } return r; };

  /* setup + users */
  const setup = keep(await req('/api/setup', { method: 'POST', body: { school_name: 'مدرسهٔ ۶۵', manager_name: 'مدیر ۶۵', password: 'Ident-65x', phone: '09120000651' } }));
  if (setup.status !== 200) throw new Error('setup failed ' + JSON.stringify(setup.data));
  const mgrTok = setup.data.session.token;
  const mk = await req('/api/sync', { method: 'POST', token: mgrTok, body: { ops: [
    { uid: 'id65-t1', collection: 'users', type: 'put', data: { name: 'معلم ۶۵', role: 'teacher', phone: '09120000652', national_id: '1000000652' } },
    { uid: 'id65-t2', collection: 'users', type: 'put', data: { name: 'معاون ۶۵', role: 'vice', phone: '09120000653', national_id: '1000000653' } },
    { uid: 'id65-s1', collection: 'users', type: 'put', data: { name: 'دانش‌آموز ۶۵', role: 'student', phone: '09120000654', national_id: '1000000654' } },
  ] } });
  const idOf = (uid) => mk.data.applied.find(a => a.uid === uid).id;
  const T1 = idOf('id65-t1'), T2 = idOf('id65-t2'), S1 = idOf('id65-s1');
  for (const [id, pw] of [[T1, 'Teach-65x'], [T2, 'Vice-65xx']]) {
    await req('/api/admin/users/' + id + '/password', { method: 'POST', token: mgrTok, body: { password: pw } });
  }
  const login = async (phone, password, extra = {}) => keep(await req('/api/auth/login', { method: 'POST', body: Object.assign({ phone, password, name: 'id65', platform: 'android' }, extra) }));

  /* ── access token ───────────────────────────────────────────────── */
  const A = await login('09120000652', 'Teach-65x');
  await test('ID65-01', 'login → short-lived access token (≤ 15 min) + refresh token', async () => {
    assert.strictEqual(A.status, 200, JSON.stringify(A.data));
    const ttl = Date.parse(A.data.session.expires_at) - Date.now();
    assert.ok(ttl <= 15 * 60000 + 5000 && ttl >= 14 * 60000, 'ttl_ms=' + ttl);
    assert.ok(/^[0-9a-f]{64}$/.test(A.data.device_token));
    assert.ok(A.data.device_id);
    return 'ttl=' + Math.round(ttl / 1000) + 's';
  });
  await test('ID65-02', 'expiry: expired access token → 401; refresh gives a working new one', async () => {
    dbRun('UPDATE sessions SET expires_at=? WHERE token_hash=?', '2000-01-01T00:00:00.000Z', sha256(A.data.session.token));
    const me = await req('/api/me', { token: A.data.session.token });
    assert.strictEqual(me.status, 401);
    assert.strictEqual(me.data.error, 'unauthorized');
    const r = keep(await refresh(A.data.device_token));
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const me2 = await req('/api/me', { token: r.data.session.token });
    assert.strictEqual(me2.status, 200);
    A.cur = r.data;
  });
  await test('ID65-03', 'no sliding extension: using the access token does not push its expiry', async () => {
    const before = dbAll('SELECT expires_at FROM sessions WHERE token_hash=?', sha256(A.cur.session.token))[0].expires_at;
    dbRun('UPDATE sessions SET expires_at=? WHERE token_hash=?', new Date(Date.now() + 60000).toISOString(), sha256(A.cur.session.token));
    for (let i = 0; i < 3; i++) assert.strictEqual((await req('/api/me', { token: A.cur.session.token })).status, 200);
    const after = dbAll('SELECT expires_at FROM sessions WHERE token_hash=?', sha256(A.cur.session.token))[0].expires_at;
    assert.ok(Date.parse(after) - Date.now() <= 61000, 'expiry was extended: ' + after + ' (was ' + before + ')');
  });

  /* ── rotation / grace / reuse ───────────────────────────────────── */
  let prevTok, curTok;
  await test('ID65-04', 'rotation: every refresh returns a NEW refresh token; the new one keeps working', async () => {
    prevTok = A.cur.device_token;
    assert.notStrictEqual(prevTok, A.data.device_token, 'first refresh already rotated');
    const r = keep(await refresh(prevTok));
    assert.strictEqual(r.status, 200);
    assert.notStrictEqual(r.data.device_token, prevTok);
    assert.strictEqual(r.data.rotated, true);
    curTok = r.data.device_token;
    assert.ok(r.data.generation >= 3, 'generation=' + r.data.generation);
    return 'generation=' + r.data.generation;
  });
  await test('ID65-05', 'grace: the previous token within the grace window returns the SAME successor (multi-tab / lost response)', async () => {
    const r = keep(await refresh(prevTok));
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.device_token, curTok);
    assert.strictEqual(r.data.rotated, false);
  });
  let lastSession;
  await test('ID65-06', 'replay after grace ⇒ reuse detected: whole chain revoked (old, current, sessions) + wipe', async () => {
    const live = keep(await refresh(curTok));                 /* legit client moves on */
    assert.strictEqual(live.status, 200);
    lastSession = live.data.session.token;
    const latest = live.data.device_token;
    await sleep(GRACE_SEC * 1000 + 600);
    const r = await refresh(prevTok);                          /* attacker replays a spent token */
    assert.strictEqual(r.status, 401, JSON.stringify(r.data));
    assert.strictEqual(r.data.error, 'device_revoked');
    assert.strictEqual(r.data.reason, 'refresh_reuse');
    assert.strictEqual(r.data.wipe, true);
    const r2 = await refresh(latest);
    assert.strictEqual(r2.status, 401);
    assert.strictEqual(r2.data.error, 'device_revoked', 'the newest token of the chain is dead too');
    const me = await req('/api/me', { token: lastSession });
    assert.strictEqual(me.status, 401);
    assert.strictEqual(me.data.error, 'device_revoked');
    assert.strictEqual(me.data.wipe, true);
  });
  await test('ID65-07', 'forgery: unknown, truncated and bit-flipped refresh tokens → 401 bad_device (no session)', async () => {
    const B = await login('09120000652', 'Teach-65x');
    const t = B.data.device_token;
    const flip = t.slice(0, -1) + (t.slice(-1) === '0' ? '1' : '0');
    for (const bad of ['nope', t.slice(0, 40), flip, 'a'.repeat(64), '']) {
      const r = await refresh(bad);
      assert.strictEqual(r.status, 401, bad);
      assert.strictEqual(r.data.error, 'bad_device');
      assert.ok(!r.data.session);
    }
    assert.strictEqual((await refresh(t)).status, 200, 'the genuine token still works');
  });

  /* ── device public key (proof of possession) ────────────────────── */
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ecPub = ec.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const signP256 = (priv, devId, ts, tok) => crypto.sign('sha256', Buffer.from(`payesh-refresh-v1\n${devId}\n${ts}\n${sha256(tok)}`), { key: priv, dsaEncoding: 'ieee-p1363' }).toString('base64');
  let K;
  await test('ID65-08', 'key-bound device (P-256): refresh needs a valid proof; wrong key / no proof / stale ts are refused', async () => {
    K = await login('09120000653', 'Vice-65xx', { device_pubkey: ecPub });
    assert.strictEqual(K.status, 200, JSON.stringify(K.data));
    const devId = K.data.device_id;
    const none = await refresh(K.data.device_token);
    assert.strictEqual(none.status, 401); assert.strictEqual(none.data.error, 'proof_required');
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const ts1 = Date.now();
    const forged = await refresh(K.data.device_token, { proof: { ts: ts1, sig: signP256(other.privateKey, devId, ts1, K.data.device_token) } });
    assert.strictEqual(forged.status, 401); assert.strictEqual(forged.data.error, 'bad_proof');
    const wrongTok = await refresh(K.data.device_token, { proof: { ts: ts1, sig: signP256(ec.privateKey, devId, ts1, 'f'.repeat(64)) } });
    assert.strictEqual(wrongTok.data.error, 'bad_proof', 'proof is bound to the presented token');
    const old = Date.now() - 3600000;
    const stale = await refresh(K.data.device_token, { proof: { ts: old, sig: signP256(ec.privateKey, devId, old, K.data.device_token) } });
    assert.strictEqual(stale.data.error, 'proof_expired');
    const ts2 = Date.now();
    K.proof = { ts: ts2, sig: signP256(ec.privateKey, devId, ts2, K.data.device_token) };
    const ok = keep(await refresh(K.data.device_token, { proof: K.proof }));
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.data));
    K.spent = K.data.device_token;
    K.cur = ok.data.device_token;
    const listed = (await req('/api/admin/devices', { token: mgrTok })).data.devices.find(d => d.id === devId);
    assert.strictEqual(listed.key_bound, true);
  });
  await test('ID65-09', 'proof replay: a captured {token, proof} pair replayed later is refused (proof_replayed) — no successor leaks', async () => {
    const r = await refresh(K.spent, { proof: K.proof });
    assert.strictEqual(r.status, 401, JSON.stringify(r.data));
    assert.strictEqual(r.data.error, 'proof_replayed');
    assert.ok(!r.data.device_token);
  });
  await test('ID65-10', 'a stolen SPENT token without the private key cannot even revoke the bound device (no DoS)', async () => {
    await sleep(GRACE_SEC * 1000 + 300);
    const r = await refresh(K.spent);
    assert.strictEqual(r.data.error, 'proof_required');
    const ts = Date.now();
    const ok = await refresh(K.cur, { proof: { ts, sig: signP256(ec.privateKey, K.data.device_id, ts, K.cur) } });
    assert.strictEqual(ok.status, 200, 'legit device keeps working: ' + JSON.stringify(ok.data));
    K.cur = ok.data.device_token;
  });
  await test('ID65-11', 'Ed25519 keys work; malformed / RSA / oversized public keys → 400 bad_device_pubkey', async () => {
    const ed = crypto.generateKeyPairSync('ed25519');
    const edPub = ed.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const E = await login('09120000653', 'Vice-65xx', { device_pubkey: edPub });
    assert.strictEqual(E.status, 200, JSON.stringify(E.data));
    const ts = Date.now();
    const sig = crypto.sign(null, Buffer.from(`payesh-refresh-v1\n${E.data.device_id}\n${ts}\n${sha256(E.data.device_token)}`), ed.privateKey).toString('base64');
    assert.strictEqual((await refresh(E.data.device_token, { proof: { ts, sig } })).status, 200);
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    for (const bad of ['not-a-key', 'QUFBQQ==', rsa, 'A'.repeat(500)]) {
      const r = await req('/api/auth/login', { method: 'POST', body: { phone: '09120000653', password: 'Vice-65xx', device_pubkey: bad } });
      assert.strictEqual(r.status, 400, bad.slice(0, 20) + ' ' + JSON.stringify(r.data));
      assert.strictEqual(r.data.error, 'bad_device_pubkey');
    }
  });

  /* ── device cap ─────────────────────────────────────────────────── */
  await test('ID65-12', `per-user device cap (${CAP}): next login 409 device_limit; revoking or a stale device frees a slot`, async () => {
    const active = () => dbAll('SELECT COUNT(*) n FROM devices WHERE user_id=? AND revoked_at IS NULL', T2)[0].n;
    const ids = [];
    while (active() < CAP) { const r = await login('09120000653', 'Vice-65xx'); assert.strictEqual(r.status, 200, JSON.stringify(r.data)); ids.push(r.data.device_id); }
    const over = await login('09120000653', 'Vice-65xx');
    assert.strictEqual(over.status, 409, JSON.stringify(over.data));
    assert.strictEqual(over.data.error, 'device_limit');
    assert.strictEqual(over.data.limit, CAP);
    const del = await req('/api/admin/devices/' + ids[0], { method: 'DELETE', token: mgrTok });
    assert.strictEqual(del.status, 200);
    const again = await login('09120000653', 'Vice-65xx');
    assert.strictEqual(again.status, 200, 'slot freed by manager revoke');
    assert.strictEqual((await login('09120000653', 'Vice-65xx')).status, 409);
    dbRun('UPDATE devices SET last_seen_at=?, created_at=? WHERE id=?', '2001-01-01T00:00:00.000Z', '2001-01-01T00:00:00.000Z', ids[1]);
    const stale = await login('09120000653', 'Vice-65xx');
    assert.strictEqual(stale.status, 200, 'stale device retired: ' + JSON.stringify(stale.data));
    assert.ok(dbAll("SELECT revoke_reason FROM devices WHERE id=?", ids[1])[0].revoke_reason === 'stale');
    return 'active=' + active();
  });

  /* ── manager revoke + remote wipe; revoke-all ───────────────────── */
  await test('ID65-13', 'manager revoke ⇒ the device\'s session gets 401 device_revoked + wipe:true; refresh too', async () => {
    const pc = await req('/api/admin/pair-code', { method: 'POST', token: mgrTok, body: { user_id: S1 } });
    const P = keep(await req('/api/auth/pair', { method: 'POST', body: { code: pc.data.code, name: 'phone', platform: 'android' } }));
    assert.strictEqual(P.status, 200);
    const del = await req('/api/admin/devices/' + P.data.device_id, { method: 'DELETE', token: mgrTok });
    assert.strictEqual(del.status, 200);
    const me = await req('/api/me', { token: P.data.session.token });
    assert.strictEqual(me.status, 401);
    assert.deepStrictEqual([me.data.error, me.data.wipe, me.data.reason], ['device_revoked', true, 'manager']);
    const r = await refresh(P.data.device_token);
    assert.deepStrictEqual([r.status, r.data.error, r.data.wipe], [401, 'device_revoked', true]);
  });
  await test('ID65-14', 'revoke-all(keep_current) kills the OTHER devices\' refresh tokens too; current device survives', async () => {
    const X = await login('09120000652', 'Teach-65x');
    const Y = await login('09120000652', 'Teach-65x');
    const r = await req('/api/auth/revoke-all', { method: 'POST', token: X.data.session.token, body: { keep_current: true } });
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.devices_revoked >= 1, JSON.stringify(r.data));
    assert.ok(!('password' in r.data), 'no password echo');
    const y = await refresh(Y.data.device_token);
    assert.strictEqual(y.status, 401, 'lost phone can no longer mint sessions: ' + JSON.stringify(y.data));
    assert.strictEqual(y.data.error, 'device_revoked');
    const ym = await req('/api/me', { token: Y.data.session.token });
    assert.strictEqual(ym.data.error, 'device_revoked');
    assert.strictEqual((await req('/api/me', { token: X.data.session.token })).status, 200);
    assert.strictEqual((await refresh(X.data.device_token)).status, 200);
  });

  /* ── leaks fixed in this row ────────────────────────────────────── */
  await test('ID65-15', '/api/setup/state: no data_dir/db_file for a LAN caller; the school PC (loopback) still sees them', async () => {
    const ip = lanIp();
    assert.ok(ip, 'no non-loopback IPv4 interface on this host');
    const lan = await req('/api/setup/state', { base: 'http://' + ip + ':' + srv.port });
    assert.strictEqual(lan.status, 200);
    assert.ok(!('data_dir' in lan.data) && !('db_file' in lan.data), JSON.stringify(lan.data));
    assert.ok(!JSON.stringify(lan.data).includes(path.sep + 'payesh.sqlite'));
    const local = await req('/api/setup/state');
    assert.ok(local.data.db_file, 'loopback keeps the path (settings page)');
    return 'lan=' + ip;
  });
  await test('ID65-16', 'admin password set: the raw password is NOT echoed; credentials table still has it', async () => {
    const r = await req('/api/admin/users/' + T1 + '/password', { method: 'POST', token: mgrTok, body: { password: 'Echo-65-check' } });
    assert.strictEqual(r.status, 200);
    assert.ok(!JSON.stringify(r.data).includes('Echo-65-check'), JSON.stringify(r.data));
    const creds = await req('/api/admin/users/credentials', { token: mgrTok });
    assert.strictEqual(String(creds.data.users.find(u => Number(u.id) === Number(T1)).password), 'Echo-65-check');
  });

  /* ── compatibility ──────────────────────────────────────────────── */
  await test('ID65-17', 'pre-row-65 device tokens (meta "device:<hash>") still refresh once and are migrated + rotated', async () => {
    const L = await login('09120000652', 'Echo-65-check');
    const legacy = crypto.randomBytes(32).toString('hex');
    dbRun("INSERT INTO meta(key,value) VALUES(?,?)", 'device:' + sha256(legacy), JSON.stringify({ device_id: L.data.device_id, user_id: T1, created_at: new Date().toISOString() }));
    const r = keep(await refresh(legacy));
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.notStrictEqual(r.data.device_token, legacy);
    assert.strictEqual(dbAll("SELECT COUNT(*) n FROM meta WHERE key=?", 'device:' + sha256(legacy))[0].n, 0, 'legacy meta removed');
  });
  await test('ID65-18', 'pair_codes compat: one reusable code pairs two devices with independent chains', async () => {
    const pc = await req('/api/admin/pair-code', { method: 'POST', token: mgrTok, body: { user_id: S1 } });
    const P1 = keep(await req('/api/auth/pair', { method: 'POST', body: { code: pc.data.code } }));
    const P2 = keep(await req('/api/auth/pair', { method: 'POST', body: { code: pc.data.code } }));
    assert.strictEqual(P1.status, 200); assert.strictEqual(P2.status, 200);
    const n1 = keep(await refresh(P1.data.device_token));
    keep(await refresh(n1.data.device_token));
    await sleep(GRACE_SEC * 1000 + 300);
    assert.strictEqual((await refresh(P1.data.device_token)).data.error, 'device_revoked', 'P1 chain reused ⇒ P1 revoked');
    assert.strictEqual((await refresh(P2.data.device_token)).status, 200, 'P2 untouched');
  });

  /* ── audit + expiry ─────────────────────────────────────────────── */
  await test('ID65-19', 'audit trail has every identity event and never a raw token', async () => {
    const rows = dbAll('SELECT action, before, after FROM audit');
    const acts = new Set(rows.map(r => r.action));
    for (const a of ['device_login', 'refresh_rotate', 'refresh_grace', 'refresh_reuse_detected', 'refresh_bad_proof', 'device_limit', 'device_stale_revoked', 'device_revoke', 'revoke_all_sessions']) {
      assert.ok(acts.has(a), 'missing audit action ' + a);
    }
    const blob = JSON.stringify(rows);
    const leaked = seenTokens.filter(t => t && t.length >= 32 && blob.includes(t));
    assert.strictEqual(leaked.length, 0, 'raw token in audit');
    const stored = JSON.stringify(dbAll('SELECT * FROM device_tokens')) + JSON.stringify(dbAll('SELECT * FROM sessions'));
    assert.strictEqual(seenTokens.filter(t => t && stored.includes(t)).length, 0, 'raw token stored in DB');
    return acts.size + ' distinct actions, ' + seenTokens.length + ' tokens checked';
  });
  await test('ID65-20', 'refresh-token expiry: a token older than 365 days → 401 device_expired', async () => {
    const Z = await login('09120000652', 'Echo-65-check');
    dbRun('UPDATE device_tokens SET issued_at=? WHERE token_hash=?', '2020-01-01T00:00:00.000Z', sha256(Z.data.device_token));
    const r = await refresh(Z.data.device_token);
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.data.error, 'device_expired');
  });
  return { pass, fail, failed };
}

/* ── negative controls: revert each fix in a copy of server/ ─────────── */
const MUTANTS = [
  { id: 'MUT-reuse', target: 'ID65-06', file: 'server/identity.js', from: '  if (rec.rotated_at) {\n    const age', to: '  if (false) {\n    const age' },
  { id: 'MUT-proof', target: 'ID65-08', file: 'server/identity.js', from: '  if (!device.pubkey) return null;\n  if (!proof', to: '  return null;\n  if (!proof' },
  { id: 'MUT-proof-replay', target: 'ID65-09', file: 'server/identity.js', from: "  if (device.proof_ts && ts <= Number(device.proof_ts)) return 'proof_replayed';", to: '' },
  { id: 'MUT-cap', target: 'ID65-12', file: 'server/identity.js', from: '  if (n >= cfg.cap) {', to: '  if (false) {' },
  { id: 'MUT-ttl', target: 'ID65-01', file: 'server/auth.js', from: 'new Date(Date.now() + accessTtlMs()).toISOString()', to: 'new Date(Date.now() + 24 * 3600 * 1000).toISOString()' },
  { id: 'MUT-rotation', target: 'ID65-04', file: 'server/auth.js', from: 'device_token: rot.device_token, device_id: device.id,', to: 'device_token: raw, device_id: device.id,' },
  { id: 'MUT-revoke-all', target: 'ID65-14', file: 'server/auth.js', from: "const devices = identity.revokeUserDevices(store, userId, keepDevice, 'revoke_all');", to: 'const devices = 0;' },
  { id: 'MUT-wipe', target: 'ID65-13', file: 'server/index.js', from: "    if (gone) return json({ ok: false, error: 'device_revoked', reason: gone.reason, wipe: true }, 401);", to: '' },
  { id: 'MUT-setup-leak', target: 'ID65-15', file: 'server/index.js', from: '...(loopback ? {', to: '...(true ? {' },
  { id: 'MUT-echo', target: 'ID65-16', file: 'server/index.js', from: "       مدیر همان رمزی را که تایپ کرده در دست دارد؛ جدول رمزها از /api/admin/users/credentials می‌خواند. */\n    return json({ ok: true });", to: "       */\n    return json({ ok: true, password: String(body.password) });" },
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
  console.log('── identity suite on the real tree ──');
  const srv = await startServer(ROOT, 'main');
  const res = await suite(srv);
  srv.child.kill('SIGKILL');
  FAIL += res.fail;
  console.log(`ID checks=${res.pass + res.fail} pass=${res.pass} fail=${res.fail}`);

  let killed = 0;
  if (process.env.IDENTITY65_NO_MUTANTS !== '1') {
    console.log('\n── negative controls: each fix reverted ⇒ its check must go red ──');
    for (const m of MUTANTS) {
      let line;
      try {
        const root = mutantRoot(m);
        const s = await startServer(root, m.id);
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
  for (const c of children) { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* noop */ }
  console.log(`\n${FAIL ? 'IDENTITY-65-FAIL' : 'IDENTITY-65-OK'} checks=${res.pass + res.fail} mutants_killed=${killed}/${process.env.IDENTITY65_NO_MUTANTS === '1' ? 0 : MUTANTS.length}`);
  process.exit(FAIL ? 1 : 0);
})().catch((e) => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch (er) { /* gone */ } }
  console.log('IDENTITY-65-FAIL crashed: ' + (e && e.stack || e));
  process.exit(1);
});
