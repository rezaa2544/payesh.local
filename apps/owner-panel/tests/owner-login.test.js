'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۹۸ — صادرکنندهٔ ورود انسانی پنل مالک (D‑45 = O‑17 گزینهٔ A)

   unit():  بردارهای رسمی RFC 6238 / RFC 4226 / RFC 4648، scrypt، پنجرهٔ TOTP
   flow():  PGlite + migrations 001..004؛ API واقعی با نقش runtime؛
            ورود موفق (رمز + TOTP)، تکرار کد، رمز/کد/شناسهٔ نادرست، قفل ۵ شکست،
            کاربر غیرفعال، سهمیه، سقف ۳ حساب، مرز دیتابیس، ممیزی، rollback.
   هر کنترل منفی شمارش می‌شود.
   ═══════════════════════════════════════════════════════════════════ */
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const api = require('../server/platform-api');
const auth = require('../server/owner-auth');
const { createOperator } = require('../scripts/create-operator');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MIG = path.join(ROOT, 'db', 'migrations', 'owner-panel');
const SECRET = crypto.randomBytes(32).toString('hex');
const P = '/api/platform/v1';
const read = f => fs.readFileSync(path.join(MIG, f), 'utf8');

function unit() {
  let checks = 0;
  const ok = (c, m) => { checks++; assert.ok(c, m); };
  /* RFC 6238 Appendix B (SHA1, کلید ASCII «12345678901234567890»، ۸ رقم) */
  const key = Buffer.from('12345678901234567890');
  for (const [t, want] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
    [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
    ok(auth.hotp(key, Math.floor(t / 30), 8) === want, `RFC 6238 vector T=${t}`);
  }
  /* RFC 4226 Appendix D */
  ok(auth.hotp(key, 0) === '755224' && auth.hotp(key, 9) === '520489', 'RFC 4226 HOTP vectors');
  /* RFC 4648 base32 */
  ok(auth.base32Encode(Buffer.from('foobar')) === 'MZXW6YTBOI', 'RFC 4648 base32 encode');
  ok(auth.base32Decode('MZXW6YTBOI').toString() === 'foobar', 'base32 decode round-trip');
  assert.throws(() => auth.base32Decode('not*base32')); checks++;

  const secret = auth.newTotpSecret();
  ok(/^[A-Z2-7]{32}$/.test(secret), '160-bit TOTP secret in base32');
  const t0 = 1_800_000_000_000;
  const code = auth.totpAt(secret, t0);
  ok(auth.verifyTotp(secret, code, t0) === auth.totpStep(t0), 'current code accepted');
  ok(auth.verifyTotp(secret, code, t0 + 30_000) === auth.totpStep(t0), 'previous step accepted (window ±1)');
  ok(auth.verifyTotp(secret, code, t0 + 90_000) === null, 'negative: code 3 steps old rejected');
  ok(auth.verifyTotp(secret, String((Number(code) + 1) % 1e6).padStart(6, '0'), t0) === null, 'negative: wrong code rejected');
  ok(auth.verifyTotp(secret, '12345', t0) === null && auth.verifyTotp(secret, '12345a', t0) === null, 'negative: malformed code rejected');
  ok(auth.verifyTotp('A', code, t0) === null, 'negative: short secret rejected');
  const uri = auth.otpauthUri('owner-1', secret);
  ok(uri.startsWith('otpauth://totp/Payesh%20Owner%3Aowner-1?secret=' + secret) && /digits=6&period=30$/.test(uri), 'otpauth URI');
  ok(auth.ref('login', 'Owner-1 ') === auth.ref('login', 'owner-1') && /^[0-9a-f]{24}$/.test(auth.ref('ip', '1.2.3.4')), 'hashed refs');
  return checks;
}

async function unitAsync() {
  let checks = unit();
  const ok = (c, m) => { checks++; assert.ok(c, m); };
  const h = await auth.hashPassword('correct horse battery');
  ok(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/.test(h), 'scrypt hash format');
  ok(h !== await auth.hashPassword('correct horse battery'), 'random salt');
  ok(await auth.verifyPassword('correct horse battery', h), 'password verifies');
  ok(!(await auth.verifyPassword('correct horse batterz', h)), 'negative: wrong password');
  ok(!(await auth.verifyPassword('correct horse battery', 'plain:text')), 'negative: non-scrypt stored value never matches');
  ok(!(await auth.verifyPassword('x', null)), 'negative: missing hash (unknown user) never matches');
  await assert.rejects(auth.hashPassword('short-pass'), /at least 12/); checks++;
  return checks;
}

function adapter(db) {
  return {
    async withTransaction(fn) {
      await db.exec('BEGIN');
      try {
        await db.exec('SET LOCAL ROLE payesh_platform_runtime');
        const r = await fn((sql, params = []) => db.query(sql, params));
        await db.exec('COMMIT');
        return r;
      } catch (e) {
        try { await db.exec('ROLLBACK'); } catch (_) { /* noop */ }
        throw e;
      }
    },
  };
}

async function asOwner(db, fn) {
  await db.exec('BEGIN');
  try {
    await db.exec('SET LOCAL ROLE payesh_platform_owner');
    const r = await fn((sql, p = []) => db.query(sql, p));
    await db.exec('COMMIT');
    return r;
  } catch (e) {
    try { await db.exec('ROLLBACK'); } catch (_) { /* noop */ }
    throw e;
  }
}

async function rejects(db, sql, params, re) {
  await db.exec('SET ROLE payesh_platform_runtime');
  try { await db.query(sql, params); return false; } catch (e) { return re.test(String(e.code || '') + ' ' + e.message); }
  finally { await db.exec('RESET ROLE'); }
}

async function flow() {
  const hadWindow = Object.prototype.hasOwnProperty.call(global, 'window');
  const previousWindow = global.window;
  if (hadWindow) delete global.window;
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  let negatives = 0;
  const negative = (label, cond) => { negatives++; assert.ok(cond, 'negative control: ' + label); };

  try {
    for (const f of ['001_owner_panel.up.sql', '002_owner_panel_api.up.sql', '003_tenant_deletion.up.sql', '004_owner_login.up.sql']) {
      await db.exec(read(f));
    }
    await db.query(`INSERT INTO owner_platform.plans(code,name,storage_mb) VALUES ('basic','پایه',1024)`);
    const TENANT = crypto.randomUUID();
    const sub = await db.query(`INSERT INTO owner_platform.subscriptions (tenant_id,plan_code,status,starts_at,ends_at)
      VALUES ($1,'basic','active',now()-interval '1 day',now()+interval '30 days') RETURNING id`, [TENANT]);
    /* کاربر بدون رمز (مثلاً حساب قدیمی) — جزو سقف نیست و هرگز وارد نمی‌شود */
    await db.query(`INSERT INTO owner_platform.platform_users(login_id,role) VALUES ('support-legacy','platform_support')`);

    const PW = { owner: 'owner-pass-0001!', operator: 'operator-pass-02', owner2: 'owner2-pass-0003' };
    const owner = await asOwner(db, q => createOperator(q, { loginId: 'owner-1', role: 'platform_owner', password: PW.owner }));
    const operator = await asOwner(db, q => createOperator(q, { loginId: 'operator-1', role: 'platform_operator', password: PW.operator }));
    let badHash = null;
    try { await asOwner(db, q => q(`INSERT INTO owner_platform.platform_credentials(user_id,password_hash,totp_secret)
      SELECT id,'plaintext-password','JBSWY3DPEHPK3PXPJBSWY3DPEH' FROM owner_platform.platform_users WHERE login_id='support-legacy'`)); }
    catch (e) { badHash = e; }
    negative('plaintext password rejected by CHECK (not by cap)', badHash && /platform_credentials_hash_check/.test(badHash.message + (badHash.constraint || '')));
    const owner2 = await asOwner(db, q => createOperator(q, { loginId: 'owner-2', role: 'platform_owner', password: PW.owner2 }));
    let capErr = null;
    try { await asOwner(db, q => createOperator(q, { loginId: 'owner-4', role: 'platform_owner', password: 'fourth-pass-0004' })); }
    catch (e) { capErr = e; }
    negative('4th operator account refused by cap trigger (D-45: max 3)', capErr && capErr.code === '23514');
    const n4 = await db.query(`SELECT count(*)::int AS n FROM owner_platform.platform_users WHERE login_id='owner-4'`);
    negative('cap failure rolls back the user row too', n4.rows[0].n === 0);
    let shortErr = null;
    try { await asOwner(db, q => createOperator(q, { loginId: 'x-short', password: 'short' })); } catch (e) { shortErr = e; }
    negative('script refuses password < 12 chars', shortErr && /at least 12/.test(shortErr.message));
    negative('otpauth printed for enrolment only', /^otpauth:\/\/totp\//.test(owner.otpauth));

    let clock = Date.now();
    const now = () => clock;
    const platform = api.createPlatformApi({ db: adapter(db), secret: SECRET, rateLimitMax: 10000, loginRateMax: 1000, now });
    const login = (body, remote = '10.0.0.1', p = platform) => p.dispatch({ method: 'POST', path: P + '/auth/login', headers: {}, body, remote });
    const code = (who, t = clock) => auth.totpAt(who.totpSecret, t);
    const events = async (uid) => (await db.query(
      'SELECT outcome FROM owner_platform.login_event WHERE user_id IS NOT DISTINCT FROM $1 ORDER BY id', [uid])).rows.map(r => r.outcome);

    /* ── موفق ───────────────────────────────────────────────────────── */
    const good = await login({ login_id: 'owner-1', password: PW.owner, totp: code(owner) });
    assert.strictEqual(good.status, 200, 'owner login: ' + JSON.stringify(good.body));
    const claims = api.verifyPlatformToken(good.body.token, SECRET, clock);
    assert.ok(claims && claims.sub === owner.userId && claims.role === 'platform_owner', 'token claims from table');
    assert.deepStrictEqual(claims.amr, ['pwd', 'otp']);
    assert.ok(claims.exp - claims.iat === 8 * 3600 * 1000 && good.body.expires_at, '8h session');
    const raw = JSON.stringify(good.body);
    negative('login response leaks no hash/secret/password', !/scrypt|totp_secret|password/i.test(raw) && !raw.includes(owner.totpSecret));
    assert.strictEqual(good.headers['cache-control'], 'no-store');
    const dash = await platform.dispatch({ method: 'GET', path: P + '/dashboard', headers: { authorization: 'Bearer ' + good.body.token } });
    assert.strictEqual(dash.status, 200, 'issued token works on the real API');

    /* ── تکرار همان کد ─────────────────────────────────────────────── */
    const replay = await login({ login_id: 'owner-1', password: PW.owner, totp: code(owner) });
    negative('same TOTP code reused ⇒ 401 (replay)', replay.status === 401 && replay.body.error === 'invalid_credentials' && !replay.body.token);
    clock -= 30_000;
    const older = await login({ login_id: 'owner-1', password: PW.owner, totp: code(owner) });
    negative('older-step code after a newer one ⇒ 401', older.status === 401);
    clock += 60_000;
    const next = await login({ login_id: 'owner-1', password: PW.owner, totp: code(owner) });
    assert.strictEqual(next.status, 200, 'next step code accepted');

    /* ── شکست‌ها با پاسخ یکسان ─────────────────────────────────────── */
    clock += 30_000;
    const wrongPw = await login({ login_id: 'operator-1', password: PW.operator + 'x', totp: code(operator) });
    const wrongTotp = await login({ login_id: 'operator-1', password: PW.operator, totp: String((Number(code(operator)) + 1) % 1e6).padStart(6, '0') });
    const unknown = await login({ login_id: 'nobody', password: PW.operator, totp: code(operator) });
    const legacy = await login({ login_id: 'support-legacy', password: PW.operator, totp: code(operator) });
    negative('wrong password ⇒ 401', wrongPw.status === 401);
    negative('wrong TOTP with right password ⇒ 401', wrongTotp.status === 401);
    negative('unknown login ⇒ 401', unknown.status === 401);
    negative('user without credentials can never log in', legacy.status === 401);
    negative('identical body for all failures (no account enumeration)',
      [wrongPw, wrongTotp, unknown, legacy].every(r => JSON.stringify(r.body) === JSON.stringify({ ok: false, error: 'invalid_credentials' })));
    negative('password alone (no TOTP field) ⇒ 400', (await login({ login_id: 'operator-1', password: PW.operator })).status === 400);
    negative('5-digit TOTP ⇒ 400', (await login({ login_id: 'operator-1', password: PW.operator, totp: '12345' })).status === 400);
    negative('non-string fields ⇒ 400', (await login({ login_id: ['operator-1'], password: PW.operator, totp: code(operator) })).status === 400);
    negative('oversized password ⇒ 400', (await login({ login_id: 'operator-1', password: 'x'.repeat(300), totp: code(operator) })).status === 400);

    /* ── قفل پس از ۵ شکست ───────────────────────────────────────────── */
    for (let i = 0; i < 3; i++) await login({ login_id: 'operator-1', password: 'nope-nope-nope', totp: code(operator) });
    const locked = await login({ login_id: 'operator-1', password: PW.operator, totp: code(operator) });
    negative('5 consecutive failures ⇒ locked; correct creds still 401', locked.status === 401);
    const ev = await events(operator.userId);
    assert.deepStrictEqual(ev.slice(-6), ['bad_credentials', 'bad_credentials', 'bad_credentials', 'bad_credentials', 'bad_credentials', 'locked'],
      'login_event records failures then lock: ' + ev.join(','));
    await db.query(`UPDATE owner_platform.platform_credentials SET locked_until = now() - interval '1 second' WHERE user_id=$1`, [operator.userId]);
    const unlocked = await login({ login_id: 'operator-1', password: PW.operator, totp: code(operator) });
    assert.strictEqual(unlocked.status, 200, 'login works after the 15-minute lock expires');
    const opClaims = api.verifyPlatformToken(unlocked.body.token, SECRET, clock);
    assert.strictEqual(opClaims.role, 'platform_operator', 'operator gets operator role, not owner');
    const renew = await platform.dispatch({ method: 'POST', path: `${P}/subscriptions/${sub.rows[0].id}/renew`,
      headers: { authorization: 'Bearer ' + unlocked.body.token }, body: { reason: 'تمدید آزمایشی برای آزمون نقش', days: 30 } });
    negative('operator logged in via issuer still cannot renew (API refuses)', renew.status === 403);

    /* ── کاربر غیرفعال ─────────────────────────────────────────────── */
    clock += 30_000;
    await db.query(`UPDATE owner_platform.platform_users SET status='disabled' WHERE id=$1`, [owner2.userId]);
    const disabled = await login({ login_id: 'owner-2', password: PW.owner2, totp: code(owner2) });
    negative('disabled user with correct password + TOTP ⇒ 401', disabled.status === 401);
    assert.deepStrictEqual(await events(owner2.userId), ['disabled']);
    await db.query(`UPDATE owner_platform.platform_users SET status='active' WHERE id=$1`, [owner2.userId]);

    /* ── سهمیه ─────────────────────────────────────────────────────── */
    const strict = api.createPlatformApi({ db: adapter(db), secret: SECRET, loginRateMax: 3, now });
    for (let i = 0; i < 3; i++) await login({ login_id: 'rate-x', password: 'whatever-whatever', totp: '000000' }, '10.9.9.9', strict);
    const limited = await login({ login_id: 'owner-2', password: PW.owner2, totp: code(owner2) }, '10.9.9.9', strict);
    negative('4th attempt from same IP in window ⇒ 429 even with right creds', limited.status === 429 && limited.body.retry_after_ms > 0);
    for (let i = 0; i < 3; i++) await login({ login_id: 'rate-y', password: 'whatever-whatever', totp: '000000' }, '10.8.' + i + '.1', strict);
    negative('same login id from rotating IPs ⇒ 429', (await login({ login_id: 'rate-y', password: 'x'.repeat(12), totp: '000000' }, '10.7.7.7', strict)).status === 429);
    const unconfigured = api.createPlatformApi({ db: null, secret: '' });
    negative('unconfigured API ⇒ 503 not_configured', (await login({ login_id: 'owner-1', password: PW.owner, totp: '000000' }, 'x', unconfigured)).status === 503);

    /* ── مرز دیتابیس ───────────────────────────────────────────────── */
    negative('runtime cannot SELECT credentials table', await rejects(db, 'SELECT * FROM owner_platform.platform_credentials', [], /42501|permission/i));
    negative('runtime cannot INSERT credentials', await rejects(db,
      `INSERT INTO owner_platform.platform_credentials(user_id,password_hash,totp_secret) VALUES ($1,'x','y')`, [owner.userId], /42501|permission/i));
    negative('runtime cannot UPDATE totp_last_step directly', await rejects(db,
      'UPDATE owner_platform.platform_credentials SET totp_last_step=0', [], /42501|permission/i));
    negative('runtime cannot read login_event directly', await rejects(db, 'SELECT * FROM owner_platform.login_event', [], /42501|permission/i));
    negative('login_event is append-only even for superuser', await (async () => {
      try { await db.query('DELETE FROM owner_platform.login_event'); return false; } catch (e) { return /append-only/.test(e.message); }
    })());
    await db.exec('SET ROLE payesh_platform_runtime');
    const wild = await db.query("SELECT count(*)::int AS n FROM owner_platform.login_lookup('%')");
    await db.exec('RESET ROLE');
    negative('login_lookup is exact-match only (no wildcard listing)', wild.rows[0].n === 0);
    negative('runtime cannot record a forged outcome', await rejects(db,
      "SELECT owner_platform.record_login_attempt($1,'0123456789abcdef01234567',NULL,'locked',1,'r')", [owner.userId], /22023|invalid login outcome/));
    /* ── ممیزی ─────────────────────────────────────────────────────── */
    const audit = await db.query(`SELECT actor_id, details FROM owner_platform.platform_audit WHERE action='auth.login' ORDER BY sequence_id`);
    assert.strictEqual(audit.rows.length, 3, 'one hash-chained audit row per successful login');
    assert.ok(audit.rows.every(r => r.details.amr && r.details.request_id), 'audit has amr + request_id');
    const refs = await db.query('SELECT login_ref, ip_ref FROM owner_platform.login_event');
    negative('login_event stores no raw login id or IP',
      refs.rows.every(r => /^[0-9a-f]{24}$/.test(r.login_ref) && (!r.ip_ref || /^[0-9a-f]{24}$/.test(r.ip_ref))));

    /* ── rollback 004 ⇒ fail-closed 501 ─────────────────────────────── */
    await db.exec(read('004_owner_login.down.sql'));
    const after = await db.query(`SELECT to_regclass('owner_platform.platform_credentials') IS NULL AS c_gone,
      to_regclass('owner_platform.login_event') IS NULL AS e_gone,
      to_regclass('owner_platform.tenant_deletion_request') IS NOT NULL AS pr3_kept,
      to_regprocedure('owner_platform.require_actor(text[])') IS NOT NULL AS pr2_kept`);
    assert.ok(Object.values(after.rows[0]).every(Boolean), 'down 004 removes only its objects: ' + JSON.stringify(after.rows[0]));
    const gone = await login({ login_id: 'owner-1', password: PW.owner, totp: code(owner, clock + 120_000) });
    negative('without migration 004 ⇒ 501 login_not_installed (fail-closed, no token)', gone.status === 501 && gone.body.error === 'login_not_installed' && !gone.body.token);
    await db.exec(read('004_owner_login.up.sql'));
    await db.exec(read('004_owner_login.down.sql'));

    assert.ok(negatives >= 30, 'negative control count: ' + negatives);
  } finally {
    try { await db.close(); } catch (_) { /* noop */ }
    if (hadWindow) global.window = previousWindow;
    else delete global.window;
  }
  return { negative_controls: negatives };
}

module.exports = { unit, unitAsync, flow };

if (require.main === module) {
  (async () => {
    const u = await unitAsync();
    const f = await flow();
    console.log('OWNER-LOGIN unit_checks=' + u + ' negative_controls=' + f.negative_controls + ' failures=0');
  })().catch(e => { console.error('OWNER-LOGIN FAILED: ' + (e && e.stack || e)); process.exit(1); });
}
