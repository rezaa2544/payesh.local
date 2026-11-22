'use strict';
/* ═══════════════════════════════════════════════════════════
   ردیف ۱۷۰ — اتصال خودکار سرور مدرسه به دیتابیس با ورود مدیر (بی‌وارد کردن نشانی/کلید)
     CN-01  بردارهای مشترک با Dart (docs/cloud/contracts/connect-vectors.json): مسیر، رمز، پاکت
     CN-02  مهر/باز کردن؛ رمز غلط، rev دستکاری‌شده و نوع دیگر ⇒ باز نمی‌شود
     CN-03  یافتن بسته: پایهٔ دامنه (payeshschool.ir) اول؛ connect.json با «base» تازه دنبال می‌شود
     CN-04  سرور تازه + ورود مدیر ⇒ دیتابیس همان تنظیم پنل مالک (source=owner)، بی‌کلید در کد
     CN-05  رمز غلط ⇒ هیچ تنظیمی نوشته نمی‌شود؛ سرورِ وصل ⇒ هیچ درخواستی به شبکه نمی‌رود
     CN-06  شبکه در دسترس نیست ⇒ ورود منتظر نمی‌ماند (۵ دقیقه بی‌درخواست)؛ قلاب پیش از adoptOnLogin
     CN-07  دامنهٔ کُند/بی‌پاسخ ⇒ ورود حداکثر waitMs منتظر می‌ماند (pending)؛ کار در پس‌زمینه تمام و
            سرور وصل می‌شود؛ ورود هم‌زمان کار دوم نمی‌سازد
   ═══════════════════════════════════════════════════════════ */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const connect = require(path.join(ROOT, 'server', 'connect.js'));
const s3mem = require(path.join(ROOT, 'server', 's3mem.js'));
const { openStore } = require(path.join(ROOT, 'server', 'db.js'));

let checks = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); checks++; console.log('ok   ' + name); }
  catch (e) { failures.push(name); console.log('FAIL ' + name + ' — ' + String((e && e.stack) || e).split('\n').slice(0, 4).join(' | ')); }
}

const tmpDirs = [];
function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn170-'));
  tmpDirs.push(dir);
  return openStore(path.join(dir, 'payesh.sqlite'));
}

const V = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/cloud/contracts/connect-vectors.json'), 'utf8'));
const DOMAIN = 'https://payeshschool.ir/payesh/pub/';
const BUCKET = 'https://s3.ir-central1.arvanstorage.ir/payesh-madrese/payesh/pub/';
const CFG = { v: 1, endpoint: 'https://s3.ir-central1.arvanstorage.ir', region: 'ir-central1', bucket: 'payesh-madrese', prefix: 'payesh/', accessKey: 'AK-170-test', secret: 'SK-170-test-only' };

/* شبکهٔ جعلی: نشانی ⇒ متن؛ هر درخواست ثبت می‌شود */
function fakeNet(files) {
  const asked = [];
  const fetcher = async (url) => {
    asked.push(url);
    if (files === null) throw new Error('ENETUNREACH');
    const body = files[url];
    return body == null ? { status: 404, text: async () => '' } : { status: 200, text: async () => body };
  };
  return { fetcher, asked };
}

function bundleFor(login, password, rev = 1763800000000, cfg = CFG) {
  const plain = JSON.stringify(Object.assign({}, cfg, { rev }));
  return JSON.stringify(connect.sealText(connect.deriveSecret('school', login, password), rev, plain));
}

(async () => {
  await check('CN-01 shared vectors: path, PBKDF2 secret and envelope equal docs/cloud/contracts/connect-vectors.json', () => {
    assert.strictEqual(V.iterations, connect.ITER);
    assert.ok(V.vectors.length >= 3);
    for (const v of V.vectors) {
      assert.strictEqual(connect.normLogin(v.login), v.norm, v.login);
      assert.strictEqual(connect.bundlePath(v.kind, v.login), v.path, v.login);
      const secret = connect.deriveSecret(v.kind, v.login, v.password, v.code);
      assert.strictEqual(secret, v.secret_hex, v.login);
      assert.deepStrictEqual(connect.sealText(secret, V.rev, V.plaintext, Buffer.from(V.nonce_hex, 'hex')), v.envelope, v.login);
      assert.strictEqual(connect.openText(secret, v.envelope).text, V.plaintext);
    }
    /* «۰۹۱۲…» و «0912…» یک فایل‌اند؛ بزرگ و کوچک یکی */
    assert.strictEqual(connect.bundlePath('school', '۰۹۱۲۰۰۰۱۷۰۱'), connect.bundlePath('school', '09120001701'));
    assert.strictEqual(connect.bundlePath('school', 'REZAA170'), connect.bundlePath('school', 'rezaa170'));
    assert.notStrictEqual(connect.bundlePath('school', 'rezaa170'), connect.bundlePath('owner', 'rezaa170'));
  });

  await check('CN-02 NEG wrong password / changed rev / other kind never open', () => {
    const v = V.vectors[0];
    const bad = (fn) => assert.throws(fn, (e) => e instanceof connect.ConnectError);
    bad(() => connect.openText(connect.deriveSecret('school', v.login, v.password + 'x'), v.envelope));
    bad(() => connect.openText(v.secret_hex, Object.assign({}, v.envelope, { rev: V.rev + 1 })));
    bad(() => connect.openText(v.secret_hex, Object.assign({}, v.envelope, { kind: 'payesh-cloud-control' })));
    const o = V.vectors.find((x) => x.kind === 'owner');
    bad(() => connect.openText(connect.deriveSecret('owner', o.login, o.password, '654321'), o.envelope));
    assert.strictEqual(connect.openText(connect.deriveSecret('owner', o.login, o.password, '123456'), o.envelope).text, V.plaintext);
  });

  await check('CN-03 discovery: domain first; connect.json «base» followed (moved database, no app update)', async () => {
    const moved = 'https://s3.ir-thr-at1.arvanstorage.ir/payesh-new/payesh/pub/';
    const rel = connect.bundlePath('school', 'rezaa170');
    const net = fakeNet({
      [DOMAIN + 'connect.json']: JSON.stringify({ v: 1, kind: 'payesh-connect-index', base: moved }),
      [moved + rel]: bundleFor('rezaa170', 'Madrese-1403'),
    });
    const r = await connect.fetchBundle('school', 'rezaa170', { fetcher: net.fetcher, env: {} });
    assert.strictEqual(r.base, moved);
    assert.strictEqual(net.asked[0], DOMAIN + rel, 'the domain is asked first');
    assert.deepStrictEqual(connect.basesFrom({}), [DOMAIN, BUCKET]);
    assert.deepStrictEqual(connect.basesFrom({ PAYESH_CONNECT_URLS: 'https://a.example/x/, http://evil.example/y/' }), ['https://a.example/x/']);
  });

  await check('CN-04 fresh server + manager login ⇒ connected to the owner database (source=owner)', async () => {
    connect._reset();
    const st = newStore();
    assert.strictEqual(s3mem.saved(st), null);
    const net = fakeNet({ [BUCKET + connect.bundlePath('school', '09120001701')]: bundleFor('09120001701', '0012345679') });
    const r = await connect.bootstrapFromLogin(st, '۰۹۱۲۰۰۰۱۷۰۱', '0012345679', { fetcher: net.fetcher, env: {} });
    assert.strictEqual(r.state, 'ok', JSON.stringify(r));
    const saved = s3mem.saved(st);
    assert.ok(saved && saved.enabled);
    assert.strictEqual(saved.source, 'owner');
    assert.strictEqual(saved.bucket, 'payesh-madrese');
    assert.strictEqual(saved.accessKey, 'AK-170-test');
    assert.strictEqual(st.getMeta('cloud:control_rev', ''), '1763800000000');
  });

  await check('CN-05 NEG wrong password writes nothing; an already connected server never asks the network', async () => {
    connect._reset();
    const st = newStore();
    const net = fakeNet({ [DOMAIN + connect.bundlePath('school', 'rezaa170')]: bundleFor('rezaa170', 'Madrese-1403') });
    const r = await connect.bootstrapFromLogin(st, 'rezaa170', 'wrong-pass', { fetcher: net.fetcher, env: {} });
    assert.strictEqual(r.state, 'bad_credentials');
    assert.strictEqual(s3mem.saved(st), null);
    const ok = await connect.bootstrapFromLogin(st, 'rezaa170', 'Madrese-1403', { fetcher: net.fetcher, env: {} });
    assert.strictEqual(ok.state, 'ok');
    const n = net.asked.length;
    const again = await connect.bootstrapFromLogin(st, 'rezaa170', 'Madrese-1403', { fetcher: net.fetcher, env: {} });
    assert.strictEqual(again.state, 'already_connected');
    assert.strictEqual(net.asked.length, n);
    /* بستهٔ دستکاری‌شده با تنظیم نامعتبر (http بیرونی) پذیرفته نمی‌شود */
    connect._reset();
    const st2 = newStore();
    const evil = fakeNet({ [DOMAIN + connect.bundlePath('school', 'x1')]: bundleFor('x1', 'pw-123456', 5, Object.assign({}, CFG, { endpoint: 'http://evil.example' })) });
    assert.strictEqual((await connect.bootstrapFromLogin(st2, 'x1', 'pw-123456', { fetcher: evil.fetcher, env: {} })).state, 'invalid');
    assert.strictEqual(s3mem.saved(st2), null);
  });

  await check('CN-06 offline: no wait on the next logins (5-minute cache); hook runs before adoptOnLogin', async () => {
    connect._reset();
    const st = newStore();
    const net = fakeNet(null);
    assert.strictEqual((await connect.bootstrapFromLogin(st, 'rezaa170', 'pw-1', { fetcher: net.fetcher, env: {} })).state, 'unreachable');
    const n = net.asked.length;
    const r = await connect.bootstrapFromLogin(st, 'rezaa170', 'pw-1', { fetcher: net.fetcher, env: {} });
    assert.ok(r.cached && r.state === 'unreachable');
    assert.strictEqual(net.asked.length, n);
    const idx = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    const login = idx.indexOf("p === '/api/auth/login'");
    const hook = idx.indexOf('connect.bootstrapFromLogin(store, body.phone, body.password)', login);
    const adopt = idx.indexOf('schools.adoptOnLogin(store, body.phone', login);
    assert.ok(login > 0 && hook > login && adopt > hook, 'the connect hook must run before adoptOnLogin');
    /* هیچ کلیدی در کد: فقط نشانی پایه‌ها */
    const src = fs.readFileSync(path.join(ROOT, 'server/connect.js'), 'utf8');
    assert.ok(!/accessKey\s*:\s*'[^']+'/.test(src) && !/secret\s*:\s*'[^']+'/.test(src));
  });

  await check('CN-07 slow domain: the login waits at most waitMs (pending); the background work still connects; no duplicate work', async () => {
    connect._reset();
    const st = newStore();
    const files = { [DOMAIN + connect.bundlePath('school', 'rezaa170')]: bundleFor('rezaa170', 'Madrese-1403') };
    const net = fakeNet(files);
    let release;
    const gate = new Promise((r) => { release = r; });
    const slow = async (url, o) => { await gate; return net.fetcher(url, o); };
    const t0 = Date.now();
    const a = await connect.bootstrapFromLogin(st, 'rezaa170', 'Madrese-1403', { fetcher: slow, env: {}, waitMs: 150 });
    assert.strictEqual(a.state, 'pending');
    assert.ok(Date.now() - t0 < 1500, 'the login was held ' + (Date.now() - t0) + ' ms');
    const b = connect.bootstrapFromLogin(st, 'rezaa170', 'Madrese-1403', { fetcher: slow, env: {}, waitMs: 0 });
    release();
    assert.strictEqual((await b).state, 'ok');
    assert.strictEqual(net.asked.filter((u) => u.endsWith(connect.bundlePath('school', 'rezaa170'))).length, 1, 'one fetch for both logins');
    assert.ok(s3mem.saved(st), 'connected by the background work');
    const src = fs.readFileSync(path.join(ROOT, 'server/connect.js'), 'utf8');
    assert.ok(/LOGIN_WAIT_MS = \d{3,4};/.test(src) && /ac\.abort\(\)/.test(src), 'login wait bound and per-request hard timeout');
  });

  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* */ } }
  console.log(failures.length ? `CONNECT-170-FAIL ${failures.length}/${checks + failures.length}` : `CONNECT-170-OK ${checks}/${checks}`);
  process.exit(failures.length ? 1 : 0);
})();
