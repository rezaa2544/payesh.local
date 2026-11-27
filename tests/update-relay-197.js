#!/usr/bin/env node
'use strict';
/* ردیف ۱۹۷-Q05 — رلهٔ به‌روزرسانی از راه سرور مدرسه (server/update-relay.js).
   GitHub جعلی (fetchImpl) ⇒ مانیفست، APK و فایل .gz از راه همین سرور؛ هش نادرست، نام دلخواه و
   هش فهرست‌نشده رد می‌شوند؛ GitHub قطع ⇒ نسخهٔ ذخیره‌شده (stale). مسیر واقعی index.js هم با
   یک سرور HTTP آزموده می‌شود.
   اجرا: node --experimental-sqlite tests/update-relay-197.js */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..');
const relayMod = require(path.join(ROOT, 'server', 'update-relay.js'));

let passed = 0; let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e).toString().split('\n').slice(0, 4).join('\n     ')); }
}
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

/* انتشار جعلی GitHub */
const exe = Buffer.from('payesh_app.exe build 236 '.repeat(50));
const dll = Buffer.from('flutter_windows.dll '.repeat(80));
const apk = Buffer.from('PK\u0003\u0004 fake apk 236 '.repeat(400));
function release({ apkBytes = apk } = {}) {
  const m = {
    schema: 'payesh-app-update/1', build: 236, commit: 'x',
    android: { sha256: sha(apkBytes), size: apkBytes.length },
    files: [
      { path: 'payesh_app.exe', sha256: sha(exe), size: exe.length, gz_size: 1 },
      { path: 'flutter_windows.dll', sha256: sha(dll), size: dll.length, gz_size: 1 },
    ],
  };
  return {
    'native-continuous/app-update.json': Buffer.from(JSON.stringify(m)),
    'native-continuous/payesh-native.apk': apkBytes,
    [`app-files/${sha(exe)}.gz`]: zlib.gzipSync(exe),
    [`app-files/${sha(dll)}.gz`]: zlib.gzipSync(Buffer.from('tampered')), /* هش نمی‌خورد */
  };
}

function fakeFetch(files, log, state = { down: false }) {
  return async (url) => {
    const rel = url.replace(relayMod.UPSTREAM, '').split('?')[0];
    log.push(rel);
    if (state.down) { const e = new Error('ECONNRESET'); throw e; }
    const b = files[rel];
    if (!b) return { status: 404, ok: false, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) };
    return { status: 200, ok: true, headers: new Map([['content-length', String(b.length)]]), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) };
  };
}

/* درخواست به handle() بی‌سرور HTTP */
function call(relay, rel, method = 'GET') {
  return new Promise((resolve) => {
    const chunks = [];
    const res = new (require('node:stream').Writable)({ write(c, e, cb) { chunks.push(Buffer.from(c)); cb(); } });
    res.headersSent = false;
    res.writeHead = (status, headers) => { res.statusCode = status; res.hdrs = headers; res.headersSent = true; };
    const end = res.end.bind(res);
    res.end = (b) => { if (b) chunks.push(Buffer.from(b)); end(); };
    res.on('finish', () => resolve({ status: res.statusCode, headers: res.hdrs || {}, body: Buffer.concat(chunks) }));
    res.destroy = () => resolve({ status: res.statusCode || 0, headers: res.hdrs || {}, body: Buffer.concat(chunks), destroyed: true });
    const url = new URL('http://x' + relayMod.PREFIX + rel);
    relay.handle({ method }, res, url).then((done) => { if (!done) resolve({ status: -1 }); });
  });
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay197-'));
  const log = [];
  const state = { down: false };
  let clock = Date.now();
  const files = release();
  const relay = relayMod.create({ dataDir, fetchImpl: fakeFetch(files, log, state), now: () => clock });

  await check('R01 مانیفست از راه سرور مدرسه بایت‌به‌بایت همان GitHub (fresh)', async () => {
    const r = await call(relay, 'native-continuous/app-update.json');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.equals(files['native-continuous/app-update.json']));
    assert.strictEqual(r.headers['x-payesh-relay'], 'fresh');
    assert.strictEqual(r.headers['cache-control'], 'no-store');
  });

  await check('R02 مانیفست تا ۲ دقیقه از کش (بی درخواست دوباره به GitHub)', async () => {
    const n = log.length;
    const r = await call(relay, 'native-continuous/app-update.json');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(log.length, n);
  });

  await check('R03 APK با اندازه و SHA-256 مانیفست؛ بار دوم از دیسک', async () => {
    const r = await call(relay, 'native-continuous/payesh-native.apk');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(sha(r.body), sha(apk));
    assert.strictEqual(Number(r.headers['content-length']), apk.length);
    const n = log.length;
    const r2 = await call(relay, 'native-continuous/payesh-native.apk');
    assert.strictEqual(sha(r2.body), sha(apk));
    assert.strictEqual(log.length, n, 'APK دوباره دانلود نشود');
  });

  await check('R04 فایل .gz فهرست‌شده با هش درست ⇒ 200 و کش immutable', async () => {
    const r = await call(relay, `app-files/${sha(exe)}.gz`);
    assert.strictEqual(r.status, 200);
    assert.ok(zlib.gunzipSync(r.body).equals(exe));
    assert.match(r.headers['cache-control'], /immutable/);
  });

  await check('R05 فایل .gz با محتوای دست‌کاری‌شده ⇒ 502 و ذخیره نمی‌شود', async () => {
    const r = await call(relay, `app-files/${sha(dll)}.gz`);
    assert.strictEqual(r.status, 502);
    assert.ok(!fs.existsSync(path.join(relay.dir, 'b', `${sha(dll)}.gz`)));
    assert.ok(relay.stats.rejected >= 1);
  });

  await check('R06 هش فهرست‌نشده ⇒ 404 بی‌آنکه فایل از GitHub خواسته شود', async () => {
    const bogus = 'a'.repeat(64) + '.gz';
    const r = await call(relay, `app-files/${bogus}`);
    assert.strictEqual(r.status, 404);
    assert.ok(!log.includes(`app-files/${bogus}`));
  });

  await check('R07 نام/مسیر دلخواه (پیمایش، فایل دیگر انتشار، POST) ⇒ رد بی درخواست به GitHub', async () => {
    const n = log.length;
    for (const rel of ['native-continuous/..%2F..%2Fetc%2Fpasswd', 'native-continuous/secrets.json', 'app-files/x.gz', 'payesh-local-win.zip', 'owner-files/' + 'g'.repeat(64) + '.gz']) {
      const r = await call(relay, rel);
      assert.strictEqual(r.status, 404, rel);
    }
    const p = await call(relay, 'native-continuous/app-update.json', 'POST');
    assert.strictEqual(p.status, 405);
    assert.strictEqual(log.length, n);
  });

  await check('R08 GitHub قطع ⇒ مانیفست ذخیره‌شده با x-payesh-relay: stale', async () => {
    clock += 10 * 60_000;
    state.down = true;
    const r = await call(relay, 'native-continuous/app-update.json');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['x-payesh-relay'], 'stale');
    state.down = false;
  });

  await check('R09 APK با هش نادرست در GitHub ⇒ 502 (هیچ‌وقت APK ناجور جلو نمی‌رود)', async () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'relay197b-'));
    const f2 = release();
    f2['native-continuous/payesh-native.apk'] = Buffer.from('evil');
    const r2 = relayMod.create({ dataDir: dir2, fetchImpl: fakeFetch(f2, []) });
    const r = await call(r2, 'native-continuous/payesh-native.apk');
    assert.strictEqual(r.status, 502);
  });

  await check('R10 کنترل منفی: بی‌رله (GitHub قطع، بی کش) ⇒ 504/502 و نه 200', async () => {
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'relay197c-'));
    const r3 = relayMod.create({ dataDir: dir3, fetchImpl: fakeFetch(release(), [], { down: true }) });
    const r = await call(r3, 'native-continuous/app-update.json');
    assert.ok(r.status >= 500, String(r.status));
  });

  await check('R11 index.js: /api/update-relay/ بی‌نشست سرو می‌شود و مسیر ناشناخته 404 JSON', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
    assert.match(src, /require\('\.\/update-relay'\)\.create\(\{ dataDir: DATA_DIR \}\)/);
    assert.match(src, /url\.pathname\.startsWith\('\/api\/update-relay\/'\) && await updateRelay\.handle\(req, res, url\)/);
    /* سرور HTTP واقعی با همان handle */
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      relay.handle(req, res, url).then(d => { if (!d) { res.writeHead(418); res.end(); } });
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const get = p => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p }, res => {
      const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c), headers: res.headers }));
    }).on('error', reject));
    const a = await get(relayMod.PREFIX + 'native-continuous/payesh-native.apk');
    assert.strictEqual(a.status, 200);
    assert.strictEqual(sha(a.body), sha(apk));
    const b = await get(relayMod.PREFIX + 'nope');
    assert.strictEqual(b.status, 404);
    assert.strictEqual(JSON.parse(b.body).error, 'not_found');
    const c = await get('/api/other');
    assert.strictEqual(c.status, 418);
    srv.close();
  });

  console.log(`UPDATE-RELAY-197 ${failed ? 'FAILED' : 'OK'} ${passed}/${passed + failed}`);
  process.exit(failed ? 1 : 0);
})();
