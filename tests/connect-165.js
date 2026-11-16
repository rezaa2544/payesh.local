'use strict';
/* ═══════════════════════════════════════════════════════════
   ردیف ۱۶۵ — «حالت اتصال» و تونل رایگان Cloudflare (گوشی بیرون از شبکهٔ مدرسه وصل شود)
     C-01  نشانی quick tunnel فقط *.trycloudflare.com از گزارش cloudflared برداشته می‌شود
     C-02  فقط فایلی اجرا می‌شود که SHA-256 آن همان مقدار سنجاق‌شده باشد؛ دانلود ناهمخوان رد
     C-03  QuickTunnel: http2 + درگاه ورودی؛ نشانی پس از «Registered» اعلام؛ افتادن ⇒ روشن شدن دوباره
     C-04  سه شکست پشت‌سرهم /healthz ⇒ فرایند بسته و دوباره روشن (نشانی تازه)
     C-05  فهرست نشانی‌ها: public_urls (فقط https، بدون مسیر) + حفظ connect انتخاب مالک
     C-06  حالت اتصال: فقط پنج حالت؛ ناشناخته ⇒ خودکار؛ ثبت + رسید بدون راز
     C-07  reconcile: lan ⇒ هیچ نشانی؛ cloudflare ⇒ تونل روشن و نشانی اعلام؛ central ⇒ خاموش
     C-08  سرور واقعی: درخواست از درگاه ورودی تونل «از خود رایانه» نیست (راه‌اندازی/نجات بسته)
     C-09  سرور واقعی: نشانی واقعی کاربر از cf-connecting-ip (سقف تلاش هر کاربر جدا)
   ═══════════════════════════════════════════════════════════ */
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');

const ROOT = path.join(__dirname, '..');
const cf = require(path.join(ROOT, 'server', 'quick-tunnel.js'));
const discovery = require(path.join(ROOT, 'server', 'discovery.js'));
const tunnel = require(path.join(ROOT, 'server', 'tunnel.js'));
const cloudControl = require(path.join(ROOT, 'server', 'cloud-control.js'));

let checks = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); checks++; console.log('ok   ' + name); }
  catch (e) { failures.push(name); console.log('FAIL ' + name + ' — ' + String((e && e.stack) || e).split('\n').slice(0, 4).join(' | ')); }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cn165-'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function fakeProc() {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.killed = false;
  p.kill = () => { p.killed = true; setImmediate(() => p.emit('exit', 1)); };
  return p;
}
function memStore() {
  const meta = {};
  return { meta, getMeta: (k, d) => (k in meta ? meta[k] : (d === undefined ? null : d)), setMeta: (k, v) => { meta[k] = v; }, audit: () => {} };
}
function freePort() {
  return new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}
function req(port, method, p, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: Object.assign({ 'content-type': 'application/json' }, headers, data ? { 'content-length': Buffer.byteLength(data) } : {}) }, res => {
      let t = '';
      res.on('data', d => { t += d; });
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (e) { j = null; } resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  await check('C-01 نشانی quick tunnel از گزارش cloudflared (فقط trycloudflare.com)', () => {
    const line = '2026-11-16T07:00:01Z INF |  https://producing-spin-bookmarks-opposition.trycloudflare.com                     |';
    assert.strictEqual(cf.parseUrl(line), 'https://producing-spin-bookmarks-opposition.trycloudflare.com');
    assert.strictEqual(cf.parseUrl('see https://api.trycloudflare.com.evil.example/x'), 'https://api.trycloudflare.com', 'فقط میزبان');
    assert.strictEqual(cf.parseUrl('http://abc.trycloudflare.com'), null, 'بدون https رد');
    assert.strictEqual(cf.parseUrl('https://abc.cloudflare.com'), null);
    assert.strictEqual(cf.parseUrl(''), null);
  });

  await check('C-02 فقط فایل با SHA-256 سنجاق‌شده اجرا/پذیرفته می‌شود', async () => {
    const good = Buffer.from('fake-cloudflared-binary-165');
    const pin = { name: 'x', size: good.length, sha256: crypto.createHash('sha256').update(good).digest('hex') };
    const f = path.join(tmp, 'cf.bin');
    fs.writeFileSync(f, good);
    assert.strictEqual(await cf.verifyFile(f, pin), true);
    const f2 = path.join(tmp, 'cf2.bin');
    fs.writeFileSync(f2, Buffer.from('fake-cloudflared-binary-16X'));
    assert.strictEqual(await cf.verifyFile(f2, pin), false, 'هم‌اندازه ولی دستکاری‌شده');
    const dest = path.join(tmp, 'bin', 'cloudflared');
    await cf.download(dest, pin, { fetchStream: async () => Readable.from([good]) });
    assert.strictEqual(await cf.verifyFile(dest, pin), true, 'دانلود درست');
    fs.rmSync(dest);
    await assert.rejects(cf.download(dest, pin, { fetchStream: async () => Readable.from([Buffer.from('evil')]) }), /sha_mismatch/);
    assert.ok(!fs.existsSync(dest) && !fs.existsSync(dest + '.part'), 'فایل ناهمخوان نمی‌ماند');
    assert.ok(/^[0-9a-f]{64}$/.test(cf.PIN.files['win32-x64'].sha256) && /^[0-9a-f]{64}$/.test(cf.PIN.files['linux-x64'].sha256));
    assert.ok(cf.downloadUrl(cf.PIN.files['win32-x64']).startsWith('https://github.com/cloudflare/cloudflared/releases/download/' + cf.PIN.version + '/'));
  });

  await check('C-03 QuickTunnel: http2 به درگاه ورودی؛ نشانی پس از ثبت؛ افتادن ⇒ دوباره روشن', async () => {
    const procs = [];
    const urls = [];
    let argsSeen = null;
    const t = new cf.QuickTunnel({
      bin: '/x/cloudflared', port: 18091,
      spawnImpl: (bin, args) => { argsSeen = args; const p = fakeProc(); procs.push(p); return p; },
      onUrl: (u) => urls.push(u),
    });
    t.start();
    assert.deepStrictEqual(argsSeen, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', 'http://127.0.0.1:18091']);
    procs[0].stderr.emit('data', 'INF |  https://aaa-bbb.trycloudflare.com  |');
    assert.deepStrictEqual(urls, [], 'پیش از ثبت اتصال اعلام نمی‌شود');
    procs[0].stderr.emit('data', 'INF Registered tunnel connection connIndex=0 protocol=http2');
    assert.deepStrictEqual(urls, ['https://aaa-bbb.trycloudflare.com']);
    assert.strictEqual(t.info().state, 'on');
    t._again = function () { this.restarts++; this.start(); };
    procs[0].emit('exit', 1);
    assert.deepStrictEqual(urls, ['https://aaa-bbb.trycloudflare.com', null], 'نشانی کهنه پس گرفته می‌شود');
    assert.strictEqual(procs.length, 2, 'دوباره روشن شد');
    procs[1].stderr.emit('data', 'https://ccc-ddd.trycloudflare.com\nRegistered tunnel connection');
    assert.strictEqual(urls[2], 'https://ccc-ddd.trycloudflare.com');
    t.stop();
    assert.strictEqual(procs[1].killed, true);
    await sleep(5);
    assert.strictEqual(procs.length, 2, 'پس از خاموش کردن روشن نمی‌شود');
    assert.strictEqual(t.info().state, 'off');
  });

  await check('C-04 سه شکست پشت‌سرهم /healthz ⇒ دوباره روشن', async () => {
    const procs = [];
    let ok = true;
    const t = new cf.QuickTunnel({ bin: 'x', port: 1, spawnImpl: () => { const p = fakeProc(); procs.push(p); return p; }, probe: async () => ok });
    t._again = function () { this.restarts++; this.start(); };
    t.start();
    procs[0].stdout.emit('data', 'https://e-f.trycloudflare.com Registered tunnel connection');
    assert.strictEqual(await t.check(), true);
    ok = false;
    await t.check(); await t.check();
    assert.strictEqual(procs[0].killed, false, 'دو شکست هنوز نه');
    await t.check();
    assert.strictEqual(procs[0].killed, true, 'سومی ⇒ بسته');
    await sleep(5);
    assert.strictEqual(procs.length, 2, 'دوباره روشن');
    t.stop();
  });

  await check('C-05 فهرست نشانی‌ها: public_urls فقط https بدون مسیر؛ connect مالک حفظ می‌شود', () => {
    const e = discovery.entryOf({ instance: 'i1', school: null, lanUrls: ['http://192.168.1.120:8080'], publicUrl: 'https://x.trycloudflare.com/',
      publicUrls: ['https://a.ts.net', 'http://bad.example', 'https://u:p@evil.example', 'https://x.trycloudflare.com/path'], version: '0.9.19', now: 0 });
    assert.deepStrictEqual(e.public_urls, ['https://a.ts.net', 'https://x.trycloudflare.com']);
    assert.strictEqual(e.public_url, 'https://a.ts.net');
    const prev = { v: 1, kind: discovery.KIND, servers: [], connect: { mode: 'cloudflare', at: '2026-11-16T00:00:00Z' }, central: { url: 'https://c.example.ir' } };
    const doc = discovery.merge(prev, e, Date.now());
    assert.deepStrictEqual(doc.connect, { mode: 'cloudflare', at: '2026-11-16T00:00:00Z' });
    assert.ok(doc.central && doc.central.url === 'https://c.example.ir');
    assert.strictEqual(discovery.merge({ connect: { mode: 'rm -rf' } }, e, Date.now()).connect, undefined, 'حالت ناشناخته حذف');
    assert.deepStrictEqual(discovery.CONNECT_MODES, tunnel.MODES.slice());
  });

  await check('C-06 حالت اتصال: پنج حالت، ناشناخته ⇒ خودکار، رسید سرور بدون راز', () => {
    const st = memStore();
    assert.strictEqual(tunnel.connectMode(st), 'auto');
    assert.strictEqual(tunnel.setConnectMode(st, 'nope'), false);
    assert.strictEqual(tunnel.setConnectMode(st, 'cloudflare'), true);
    assert.strictEqual(tunnel.setConnectMode(st, 'cloudflare'), false, 'تکراری ⇒ بدون تغییر');
    assert.strictEqual(tunnel.connectMode(st), 'cloudflare');
    st.meta['cfg:connect_mode'] = 'weird';
    assert.strictEqual(tunnel.connectMode(st), 'auto');
    st.meta['cfg:connect_urls'] = JSON.stringify(['https://a.trycloudflare.com', 'http://x', 5]);
    assert.deepStrictEqual(tunnel.publicUrls(st), ['https://a.trycloudflare.com']);
    const info = cloudControl.publicInfo(st);
    assert.ok(info.connect && info.connect.mode === 'auto' && Array.isArray(info.connect.public_urls));
    assert.ok(!/secret|access|token|password/i.test(JSON.stringify(info)), 'بدون راز');
  });

  await check('C-07 reconcile: lan ⇒ بدون نشانی؛ cloudflare ⇒ تونل و اعلام؛ central ⇒ خاموش', async () => {
    const st = memStore();
    const fake = { url: null, started: 0, stopped: 0, start() { this.started++; this.url = 'https://q-r.trycloudflare.com'; }, stop() { this.stopped++; this.url = null; }, check: async () => true };
    const prevEnv = process.env.PAYESH_TAILSCALE_BIN;
    process.env.PAYESH_TAILSCALE_BIN = path.join(tmp, 'no-tailscale');
    const changes = [];
    tunnel.start(st, { port: 18080, ingressPort: 18091, dataDir: tmp, everyMs: 3600_000, onChange: (u) => changes.push(u) });
    tunnel.stop();
    tunnel.__mgrForTest().cf = fake;
    tunnel.__mgrForTest().store = st;
    tunnel.setConnectMode(st, 'cloudflare');
    await sleep(5);
    let r = await tunnel.reconcile();
    assert.deepStrictEqual(r, { mode: 'cloudflare', urls: ['https://q-r.trycloudflare.com'] });
    assert.strictEqual(st.meta['cfg:public_url'], 'https://q-r.trycloudflare.com');
    assert.strictEqual(st.meta['cfg:tunnel_provider'], 'cloudflare');
    assert.ok(changes.length >= 1, 'تغییر ⇒ انتشار بی‌درنگ');
    tunnel.setConnectMode(st, 'lan');
    await sleep(5);
    r = await tunnel.reconcile();
    assert.deepStrictEqual(r.urls, [], 'فقط شبکهٔ داخلی');
    assert.strictEqual(st.meta['cfg:public_url'], '');
    assert.ok(fake.stopped >= 1, 'تونل خاموش شد');
    tunnel.setConnectMode(st, 'central');
    await sleep(5);
    r = await tunnel.reconcile();
    assert.deepStrictEqual(r.urls, []);
    /* بدون درگاه ورودی جدا هرگز Cloudflare روشن نمی‌شود */
    tunnel.__mgrForTest().ingress = 18080;
    tunnel.setConnectMode(st, 'cloudflare');
    await sleep(5);
    const before = fake.started;
    r = await tunnel.reconcile();
    assert.strictEqual(fake.started, before, 'درگاه اصلی هرگز تونل نمی‌شود');
    tunnel.stop();
    if (prevEnv === undefined) delete process.env.PAYESH_TAILSCALE_BIN; else process.env.PAYESH_TAILSCALE_BIN = prevEnv;
  });

  /* ── سرور واقعی با درگاه ورودی تونل ── */
  const PORT = await freePort();
  const TPORT = await freePort();
  const DATA = path.join(tmp, 'data');
  const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST: '127.0.0.1', PAYESH_TUNNEL_PORT: String(TPORT), PAYESH_DATA: DATA, PAYESH_LOG: '0',
      PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0', PAYESH_LIVE_MS: '0', PAYESH_OUTBOX_AUTO: '0', PAYESH_CLOUD_AUTO: '0',
      PAYESH_TUNNEL_AUTO: '0', PAYESH_DISCOVERY: '0', PAYESH_NO_RESTART: '1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  try {
    const t0 = Date.now();
    for (;;) {
      try { const a = await req(PORT, 'GET', '/healthz'); const b = await req(TPORT, 'GET', '/healthz'); if (a.status === 200 && b.status === 200) break; } catch (e) { /* هنوز نه */ }
      if (Date.now() - t0 > 20000) throw new Error('server did not start: ' + out.slice(-400));
      await sleep(150);
    }

    await check('C-08 درخواست از درگاه تونل «از خود رایانه» نیست (راه‌اندازی/نجات/مسیر داده بسته)', async () => {
      const local = await req(PORT, 'GET', '/api/setup/state');
      const viaTunnel = await req(TPORT, 'GET', '/api/setup/state');
      assert.strictEqual(local.status, 200);
      assert.strictEqual(viaTunnel.status, 200);
      assert.ok(local.json.data_dir, 'از خود رایانه: محلی');
      assert.ok(!viaTunnel.json.data_dir, 'مسیر داده از تونل دیده نمی‌شود');
      const claim = await req(TPORT, 'POST', '/api/auth/claim', { body: { username: 'x', password: 'y' } });
      assert.strictEqual(claim.status, 403);
      assert.strictEqual(claim.json && claim.json.error, 'local_only');
      const setup = await req(TPORT, 'POST', '/api/setup', { body: { school: 'x', username: 'manager1', password: 'Strong-Pass-165' } });
      assert.ok(setup.status === 403 && setup.json && /local_only/.test(setup.json.error), 'راه‌اندازی از تونل بسته: ' + setup.status + ' ' + JSON.stringify(setup.json));
    });

    await check('C-09 سقف تلاش هر کاربر تونل جدا (cf-connecting-ip)', async () => {
      const cfg = require(path.join(ROOT, 'server', 'config.js'));
      const fakeReq = (h, pub) => ({ __public: pub, headers: h, socket: { remoteAddress: '127.0.0.1' } });
      assert.strictEqual(cfg.clientIp(fakeReq({ 'cf-connecting-ip': '5.6.7.8' }, true)), '5.6.7.8');
      assert.strictEqual(cfg.clientIp(fakeReq({ 'x-forwarded-for': '9.9.9.9, 1.1.1.1' }, true)), '9.9.9.9');
      assert.strictEqual(cfg.clientIp(fakeReq({}, true)), 'tunnel');
      const r = await req(TPORT, 'GET', '/api/health', { headers: { 'cf-connecting-ip': '5.6.7.8' } });
      assert.strictEqual(r.status, 200, 'سرور از تونل جواب می‌دهد');
    });
  } finally {
    child.kill();
    await sleep(200);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* noop */ }
  }

  if (failures.length) { console.log('CONNECT-165-FAIL failures=' + failures.length); process.exit(1); }
  console.log('CONNECT-165-OK checks=' + checks);
  process.exit(0);
})().catch((e) => { console.log('FAIL fatal — ' + (e && e.stack)); console.log('CONNECT-165-FAIL failures=1'); process.exit(1); });
