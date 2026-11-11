'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۱۰۲ — پنل مالک · اجرای محلی با یک فرمان (local-up)

   هر مورد CLI واقعی را در فرایند فرزند اجرا می‌کند (node apps/owner-panel/scripts/local-up.js):
     LU-01  bind غیر loopback ⇒ رد (کد 2)، هیچ پوشه/پورتی ساخته نمی‌شود
     LU-02  DATABASE_URL غیرمحلی ⇒ رد (کد 2)؛ loopback/سوکت پذیرفته
     LU-03  PAYESH_PLATFORM_PGURL تنظیم‌شده ⇒ رد؛ پوشهٔ داده درون مخزن Git ⇒ رد
     LU-04  --smoke روی پوشهٔ تازه: بنر، migration 001..006، ورود TOTP (غلط ⇒ 401، درست ⇒ 200)،
            داشبورد 200، SPA با CSP، خاموشی تمیز؛ هیچ راز/رمز/otpauth در خروجی نیست
     LU-05  اجرای عادی بار اول: رمز بدون نمایش (env)، otpauth فقط یک‌بار، ورود واقعی با TOTP
            همان otpauth از مبدأ پنل، رازها 0600 خارج از Git؛ توقف با سیگنال
     LU-06  اجرای دوم روی همان پوشه: migrationها تکرار نمی‌شوند، حساب دوباره ساخته نمی‌شود،
            otpauth دوباره چاپ نمی‌شود، راز همان است (توکن اجرای اول هنوز معتبر)
     LU-07  migration تغییرکرده (sha256 متفاوت در دفتر) ⇒ رد
     LU-08  بدون migration 004 ⇒ ورود 501 و smoke قرمز
     LU-09  پوشهٔ ویندوزی start-owner-local.cmd (CRLF، فقط local-up.js) و حضور در بستهٔ وب
     LU-10  (اختیاری) همان smoke روی PostgreSQL محلی واقعی با DATABASE_URL=LOCALUP_PG_URL
   ═══════════════════════════════════════════════════════════════════ */
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'apps', 'owner-panel', 'scripts', 'local-up.js');
const L = require('../scripts/local-up.js');
const auth = require('../server/owner-auth');
const P = '/api/platform/v1';

function cleanEnv(extra = {}) {
  const env = Object.assign({}, process.env);
  for (const k of ['DATABASE_URL', 'PAYESH_PLATFORM_PGURL', 'PAYESH_OPERATOR_PASSWORD', 'PGURL']) delete env[k];
  return Object.assign(env, extra);
}

function runCli(args, env, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

/** اجرای عادی (بدون --smoke) در پس‌زمینه تا خط «owner panel:» */
function startCli(args, env) {
  const child = spawn(process.execPath, [SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const st = { child, out: '', err: '' };
  st.ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('local-up did not start: ' + st.out + st.err)), 90000);
    child.stdout.on('data', (d) => {
      st.out += d;
      const m = /owner panel: http:\/\/127\.0\.0\.1:(\d+)/.exec(st.out);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
    child.stderr.on('data', (d) => { st.err += d; });
    child.on('exit', (code) => { clearTimeout(t); reject(new Error('local-up exited early ' + code + ': ' + st.out + st.err)); });
  });
  st.stop = () => new Promise((resolve) => {
    child.removeAllListeners('exit');
    child.on('exit', (code, signal) => resolve({ code, signal }));
    child.kill('SIGINT');
  });
  return st;
}

function req(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = Object.assign({ accept: 'application/json' }, headers);
    if (data) { h['content-type'] = 'application/json'; h['content-length'] = String(data.length); }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      const c = []; res.on('data', x => c.push(x));
      res.on('end', () => { const t = Buffer.concat(c).toString(); let j = null; try { j = JSON.parse(t); } catch (_) { /* html */ } resolve({ status: res.statusCode, headers: res.headers, text: t, json: j }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-lu-' + p + '-'));

async function main() {
  const results = [];
  let negatives = 0;
  const neg = (label, cond) => { negatives++; assert.ok(cond, 'negative control: ' + label); };
  const ok = (id, title, detail) => { results.push(id); console.log(`PASS  ${id}  ${title}  → ${detail}`); };

  /* LU-01 */
  for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1']) assert.ok(L.isLoopbackHost(h), h);
  for (const h of ['0.0.0.0', '::', '192.168.1.10', '10.0.0.5', 'example.com', '128.0.0.1', '::ffff:10.0.0.1', '']) neg('not loopback: ' + h, !L.isLoopbackHost(h));
  {
    const dir = path.join(os.tmpdir(), 'payesh-lu-never-' + crypto.randomBytes(4).toString('hex'));
    const r1 = await runCli(['--smoke', '--host', '0.0.0.0', '--data-dir', dir], cleanEnv());
    const r2 = await runCli(['--host', '192.168.1.10', '--data-dir', dir], cleanEnv());
    neg('--host 0.0.0.0 ⇒ exit 2', r1.code === 2 && /non-loopback|not loopback/.test(r1.err));
    neg('--host 192.168.1.10 ⇒ exit 2', r2.code === 2 && /not loopback/.test(r2.err));
    neg('refused before anything is created (no data dir)', !fs.existsSync(dir) && !/owner panel:/.test(r1.out + r2.out));
    ok('LU-01', 'non-loopback bind refused', 'exit 2 ×2, nothing created');
  }

  /* LU-02 */
  for (const u of ['postgres://u@localhost/x', 'postgres://u@127.0.0.1:5432/x', 'postgresql://u@[::1]:5432/x', 'postgres:///x?host=/var/run/postgresql', 'postgres:///x']) {
    assert.doesNotThrow(() => L.assertLocalDatabaseUrl(u), u);
  }
  for (const u of ['postgres://u:p@db.example.com/x', 'postgres://u@10.0.0.5/x', 'postgres://u@127.0.0.1/x?host=db.example.com',
    'postgres://u@localhost/x?hostaddr=10.1.1.1', 'mysql://u@127.0.0.1/x', 'not a url']) {
    let e = null; try { L.assertLocalDatabaseUrl(u); } catch (x) { e = x; }
    neg('non-local DATABASE_URL refused: ' + u, e && e.code === 'non_local_database_url');
  }
  {
    const r = await runCli(['--smoke'], cleanEnv({ DATABASE_URL: 'postgres://postgres:pw@db.example.com:5432/payesh' }));
    neg('CLI with remote DATABASE_URL ⇒ exit 2', r.code === 2 && /not on this machine/.test(r.err) && !/migrations:/.test(r.out));
    ok('LU-02', 'non-local DATABASE_URL refused', 'unit 6 refusals + CLI exit 2; loopback/socket accepted');
  }

  /* LU-03 */
  {
    const r = await runCli(['--smoke'], cleanEnv({ PAYESH_PLATFORM_PGURL: 'postgres://x@db.example.com/p' }));
    neg('PAYESH_PLATFORM_PGURL set ⇒ exit 2', r.code === 2 && /PAYESH_PLATFORM_PGURL/.test(r.err));
    const inRepo = path.join(ROOT, '.payesh-lu-should-not-exist');
    const r2 = await runCli(['--data-dir', inRepo], cleanEnv());
    neg('data dir inside the Git work tree ⇒ exit 2', r2.code === 2 && /inside the Git work tree/.test(r2.err) && !fs.existsSync(inRepo));
    ok('LU-03', 'configured platform DB / data dir in Git refused', 'exit 2 ×2');
  }

  /* LU-04 */
  {
    const dir = path.join(tmp('smoke'), 'data');
    const r = await runCli(['--smoke', '--data-dir', dir, '--keep-data'], cleanEnv());
    assert.strictEqual(r.code, 0, 'smoke exit: ' + r.out + r.err);
    assert.ok(r.out.includes('فقط آزمایش محلی؛ نه تولید') && r.out.includes('LOCAL TESTING ONLY — NOT PRODUCTION'), 'banner');
    assert.ok(/applied=\[001_owner_panel\.up\.sql, 002_owner_panel_api\.up\.sql, 003_tenant_deletion\.up\.sql, 004_owner_login\.up\.sql, 005_tenant_provisioning\.up\.sql, 006_infra_registry\.up\.sql\]/.test(r.out), 'migrations 001..006');
    assert.ok(/wrong TOTP ⇒ 401/.test(r.out) && /login \(password \+ TOTP\) via panel origin ⇒ 200/.test(r.out) && /GET \/dashboard ⇒ 200/.test(r.out), 'smoke steps');
    assert.ok(/clean shutdown/.test(r.out) && /LOCAL-UP-SMOKE-OK/.test(r.out), 'clean shutdown');
    const secret = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')).platform_token_secret;
    neg('token secret never printed', !(r.out + r.err).includes(secret));
    neg('smoke prints no otpauth URI / TOTP secret', !/otpauth:\/\//.test(r.out + r.err));
    if (process.platform !== 'win32') neg('secrets.json mode 0600', (fs.statSync(path.join(dir, 'secrets.json')).mode & 0o777) === 0o600);
    const again = await runCli(['--smoke', '--data-dir', dir], cleanEnv());
    neg('smoke on a used data dir ⇒ refused (needs fresh data)', again.code === 2 && /fresh data dir/.test(again.err));
    ok('LU-04', '--smoke: banner, 5 migrations, TOTP login, dashboard, SPA, clean shutdown', (r.out.match(/LOCAL-UP-SMOKE-OK (.*)/) || [])[1]);
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }

  /* LU-05 / LU-06 / LU-07 */
  {
    const base = tmp('run');
    const dir = path.join(base, 'data');
    const PW = 'local-owner-pass-' + crypto.randomBytes(4).toString('hex');
    const a = startCli(['--data-dir', dir, '--port', '0', '--gateway-port', '0'], cleanEnv({ PAYESH_OPERATOR_PASSWORD: PW }));
    const port = await a.ready;
    const uris = a.out.match(/otpauth:\/\/totp\/[^\s]+/g) || [];
    assert.strictEqual(uris.length, 1, 'otpauth printed exactly once on creation');
    neg('password never printed', !(a.out + a.err).includes(PW));
    const totpSecret = new URL(uris[0]).searchParams.get('secret');
    const badTotp = String((Number(auth.totpAt(totpSecret, Date.now())) + 1) % 1e6).padStart(6, '0');
    const bad = await req(port, 'POST', P + '/auth/login', { login_id: 'owner', password: PW, totp: badTotp });
    neg('wrong TOTP ⇒ 401', bad.status === 401 && bad.json && bad.json.error === 'invalid_credentials');
    const good = await req(port, 'POST', P + '/auth/login', { login_id: 'owner', password: PW, totp: auth.totpAt(totpSecret, Date.now()) });
    assert.strictEqual(good.status, 200, 'login with the printed otpauth: ' + good.text);
    const dash = await req(port, 'GET', P + '/dashboard', undefined, { authorization: 'Bearer ' + good.json.token });
    assert.strictEqual(dash.status, 200, 'dashboard');
    const secretBefore = fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8');
    if (process.platform !== 'win32') {
      assert.strictEqual((fs.statSync(path.join(dir, 'secrets.json')).mode & 0o777), 0o600, 'secrets 0600');
      const s = await a.stop();
      assert.ok(s.code === 0 && /stopped cleanly/.test(a.out), 'SIGINT ⇒ clean stop ' + JSON.stringify(s));
    } else {
      await a.stop();
    }
    ok('LU-05', 'first run: hidden password, otpauth once, TOTP login from the panel origin, secrets 0600', `otpauth×1, wrong TOTP 401, login 200, dashboard 200`);

    const b = startCli(['--data-dir', dir, '--port', '0', '--gateway-port', '0'], cleanEnv());
    const port2 = await b.ready;
    neg('second run: no otpauth', !/otpauth:\/\//.test(b.out));
    assert.ok(/already=\[001_owner_panel\.up\.sql, 002_owner_panel_api\.up\.sql, 003_tenant_deletion\.up\.sql, 004_owner_login\.up\.sql, 005_tenant_provisioning\.up\.sql, 006_infra_registry\.up\.sql\]/.test(b.out) && /applied=\[\]/.test(b.out), 'idempotent migrations: ' + b.out);
    assert.ok(/owner account: already exists/.test(b.out) && /secrets: reused/.test(b.out), 'owner/secret reused');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'), secretBefore, 'secret file unchanged');
    const dash2 = await req(port2, 'GET', P + '/dashboard', undefined, { authorization: 'Bearer ' + good.json.token });
    assert.strictEqual(dash2.status, 200, 'token from run 1 still valid ⇒ same secret');
    await b.stop();
    ok('LU-06', 'second run idempotent: migrations skipped, owner kept, no otpauth, same secret', 'applied=[] already=5, token from run 1 ⇒ 200');

    /* LU-07: دفتر را دست‌کاری کن */
    /* tests/run.js defines a jsdom global.window; PGlite must see Node, not a browser */
    const hadWindow = Object.prototype.hasOwnProperty.call(global, 'window');
    const prevWindow = global.window;
    if (hadWindow) delete global.window;
    try {
      const { PGlite } = require('@electric-sql/pglite');
      const db = new PGlite(path.join(dir, 'pglite'));
      await db.query(`UPDATE ${L.LEDGER} SET sha256 = repeat('0', 64) WHERE name = '002_owner_panel_api.up.sql'`);
      await db.close();
    } finally { if (hadWindow) global.window = prevWindow; }
    const r = await runCli(['--data-dir', dir, '--port', '0', '--gateway-port', '0'], cleanEnv());
    neg('changed migration ⇒ exit 2', r.code === 2 && /002_owner_panel_api\.up\.sql changed after it was applied/.test(r.err));
    ok('LU-07', 'checksum mismatch refused', 'exit 2');
    fs.rmSync(base, { recursive: true, force: true });
  }

  /* LU-08 */
  {
    const r = await runCli(['--smoke', '--migrations-through', '003'], cleanEnv());
    neg('without migration 004 ⇒ 501 and smoke red', r.code === 1 && /login_not_installed \(501\)/.test(r.err) && /"login":501/.test(r.err)
      && /NOT INSTALLED/.test(r.out));
    ok('LU-08', 'without migration 004 ⇒ 501, smoke red', 'exit 1');
  }

  /* LU-09 */
  {
    const cmd = fs.readFileSync(path.join(ROOT, 'apps', 'owner-panel', 'scripts', 'start-owner-local.cmd'));
    const text = cmd.toString('latin1');
    assert.ok(text.includes('\r\n') && !/[^\r]\n/.test(text), 'CRLF line endings');
    assert.ok(/node "%LOCALUP%" %\*/.test(text) && /local-up\.js/.test(text) && /PAYESH_REPO/.test(text), 'wrapper runs local-up.js');
    neg('wrapper contains no URL/secret/bind override', !/https?:\/\/(?!127\.0\.0\.1|nodejs\.org)|0\.0\.0\.0|set\s+"?\w*(PASSWORD|SECRET|PGURL|DATABASE_URL)|--host/i.test(text));
    const { collect } = require('../scripts/package-web.js');
    const entry = collect().find(f => f.name === 'payesh-owner-web/start-owner-local.cmd');
    assert.ok(entry && entry.data.equals(cmd), 'start-owner-local.cmd is in the web bundle');
    ok('LU-09', 'Windows wrapper start-owner-local.cmd (CRLF) in the web bundle', `${cmd.length} bytes`);
  }

  /* LU-10 */
  if (process.env.LOCALUP_PG_URL) {
    const { Client } = require('pg');
    const c = new Client({ connectionString: process.env.LOCALUP_PG_URL });
    c.on('error', () => {});
    await c.connect();
    await c.query(`DROP SCHEMA IF EXISTS owner_platform CASCADE; DROP TABLE IF EXISTS ${L.LEDGER}`);
    await c.end();
    const r = await runCli(['--smoke'], cleanEnv({ DATABASE_URL: process.env.LOCALUP_PG_URL }));
    assert.strictEqual(r.code, 0, 'pg smoke: ' + r.out + r.err);
    assert.ok(/local PostgreSQL \(DATABASE_URL, loopback\)/.test(r.out) && /LOCAL-UP-SMOKE-OK/.test(r.out), 'pg mode');
    const v = (r.out.match(/LOCAL-UP-SMOKE-OK (.*)/) || [])[1];
    ok('LU-10', 'smoke on a real local PostgreSQL (DATABASE_URL loopback)', v);
  } else {
    console.log('NOTE  LU-10  not run: LOCALUP_PG_URL not set (PGlite path covered by LU-04..08)');
  }

  console.log(`# passed=${results.length} negative_controls=${negatives} failures=0`);
  console.log('LOCAL-UP-102-OK');
  return { passed: results.length, negative_controls: negatives };
}

module.exports = { main };

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error('FAIL', e && e.stack || e); console.error('LOCAL-UP-102-FAIL'); process.exit(1); });
}
