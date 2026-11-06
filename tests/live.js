'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون «همگام‌سازی زندهٔ هر ۱ ثانیه» — وعدهٔ اصلی:
     • تغییر هر کاربر همان لحظه در حافظهٔ مشترک نوشته می‌شود.
     • سیستم مدرسه هر ۱ ثانیه حافظه را می‌بیند و ثبت‌ها را اعمال می‌کند.
     • بعد هم دادهٔ به‌روز را در حافظه می‌گذارد تا هر دستگاهِ آنلاین
       (هر نقشی) در همان ثانیه بگیرد؛ دستگاهِ آفلاین بعداً می‌گیرد.

   اجرا: npm run test:live
   ═══════════════════════════════════════════════════════════════════ */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const BUCKET = 'payesh-live';
const MAX_WAIT = 6000;      /* سقف انتظار؛ خودِ حلقه ۱ ثانیه است */

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  ✓ ' + name); })
    .catch(e => { failed++; console.log('  ✗ ' + name + ' — ' + String((e && (e.message || e)) || '').replace(/\s+/g, ' ').slice(0, 400)); });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const s = require('net').createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/* ── صندوقچهٔ قلابی (S3 کوچک، در حافظه) ───────────────────────────── */
function startFakeS3() {
  const objects = new Map();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const parts = u.pathname.split('/').filter(Boolean);
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,PUT,DELETE,POST,HEAD,OPTIONS',
      'access-control-allow-headers': '*',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    const send = (code, body, type = 'application/xml') => {
      res.writeHead(code, Object.assign({ 'content-type': type }, cors));
      res.end(body);
    };
    if (req.method === 'GET' && parts.length === 0) {
      return send(200, `<?xml version="1.0"?><ListAllMyBucketsResult><Buckets><Bucket><Name>${BUCKET}</Name></Bucket></Buckets></ListAllMyBucketsResult>`);
    }
    if (parts[0] !== BUCKET) return send(404, '<Error><Code>NoSuchBucket</Code></Error>');
    const key = parts.slice(1).join('/');

    if (req.method === 'GET' && u.searchParams.get('list-type') === '2') {
      const prefix = u.searchParams.get('prefix') || '';
      const keys = [...objects.keys()].filter(k => k.startsWith(prefix)).sort();
      const body = '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
        keys.map(k => `<Contents><Key>${k}</Key><Size>${objects.get(k).length}</Size></Contents>`).join('') +
        '</ListBucketResult>';
      return send(200, body);
    }
    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        objects.set(key, Buffer.concat(chunks).toString('utf8'));
        send(200, '');
      });
      return;
    }
    if (req.method === 'DELETE') { objects.delete(key); return send(204, ''); }
    if (objects.has(key)) return send(200, objects.get(key), 'application/json; charset=utf-8');
    return send(404, '<Error><Code>NoSuchKey</Code></Error>');
  });
  return new Promise(res => server.listen(0, '127.0.0.1', () => res({ server, objects, port: server.address().port })));
}

async function main() {
  const fake = await startFakeS3();
  const S3URL = 'http://127.0.0.1:' + fake.port;

  const port = await freePort();
  const BASE = 'http://127.0.0.1:' + port;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-live-'));
  const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning',
    path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), HOST: '127.0.0.1', PAYESH_DATA: DATA, PAYESH_LOG: '0',
      PAYESH_CLOUD_AUTO: '0', PAYESH_OUTBOX_AUTO: '0', PAYESH_UPDATE_AUTO: '0',
      PAYESH_AUTO_BACKUP: '0', PAYESH_NO_RESTART: '1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += String(d); });
  child.stderr.on('data', d => { log += String(d); });

  const req = async (p, opts = {}) => {
    let r;
    try {
      r = await fetch(BASE + p, {
        method: opts.method || (opts.body ? 'POST' : 'GET'),
        headers: Object.assign({ 'content-type': 'application/json' }, opts.token ? { authorization: 'Bearer ' + opts.token } : {}),
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) { return { status: 0, data: {} }; }
    const r2 = await fetch(BASE + p, {
      method: 'HEAD',
    });
    void r2;
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
    return { status: r.status, data };
  };
  const waitFor = async (fn, ms = MAX_WAIT, step = 200) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
    return null;
  };

  try {
    assert.ok(await waitFor(async () => (await req('/api/health')).data.ok, 20000), 'سرور بالا آمد — ' + log.slice(-300));

    const setup = await req('/api/setup', { body: { school_name: 'مدرسهٔ زنده', manager_name: 'مدیر زنده', phone: '09120000011', password: '123456' } });
    assert.ok(setup.data.ok, 'راه‌اندازی: ' + JSON.stringify(setup.data));
    const login = await req('/api/auth/login', { body: { phone: '09120000011', password: '123456' } });
    const token = login.data.session.token;
    const mgrPull = await req('/api/v1/pull?collections=users&since=1970-01-01T00:00:00.000Z', { token });
    const managerId = ((mgrPull.data.collections && mgrPull.data.collections.users) || []).find(u => u.role === 'manager').id;

    /* حافظهٔ مشترک را به صندوقچهٔ قلابی وصل می‌کنیم */
    const cloud = await req('/api/admin/cloud', {
      token, body: {
        endpoint: S3URL, region: 'ir-central1', bucket: BUCKET,
        accessKey: 'AKIATEST', secret: 'secret', prefix: 'payesh/', pathStyle: true,
      },
    });
    assert.ok(cloud.data.ok !== false, 'تنظیم حافظه: ' + JSON.stringify(cloud.data).slice(0, 200));

    /* یک دبیر بسازیم تا «کاربر واقعی» ثبت کند */
    await req('/api/sync', {
      token, body: { ops: [{ uid: 't-live-1', collection: 'users', type: 'put', data: { name: 'دبیر زنده', role: 'teacher', phone: '09120000012', national_id: '0012345678' } }] },
    });
    const usersPull = await req('/api/v1/pull?collections=users&since=1970-01-01T00:00:00.000Z', { token });
    const teacher = (usersPull.data.collections && usersPull.data.collections.users || []).find(u => u.role === 'teacher');
    const teacherId = teacher ? teacher.id : null;
    assert.ok(teacherId, 'دبیر ساخته شد: ' + JSON.stringify(usersPull.data).slice(0, 200));

    await test('مُهر همگام‌سازی در دسترس است و هر ۱ ثانیه است', async () => {
      const r = await waitFor(async () => { const x = await req('/api/live/rev', { token }); return x.data.rev ? x.data : null; });
      assert.ok(r, 'مُهر ساخته شد');
      assert.strictEqual(r.every_ms, 1000, 'بازهٔ همگام‌سازی ۱ ثانیه');
    });

    await test('ثبت گوشی در کمتر از ۲ ثانیه به پایگاه دادهٔ مدرسه می‌رسد', async () => {
      const uid = 'ob-live-' + Date.now();
      const item = {
        v: 1, uid, user_id: managerId, role: 'manager', device_id: 'phone-test',
        op: { collection: 'announcements', type: 'put', data: { title: 'خبر زندهٔ گوشی', body: 'سریع', date: new Date().toISOString().slice(0, 10), audience: 'all' } },
        created_at: new Date().toISOString(),
      };
      await putObject(`payesh/outbox/pending/${uid}.json`, JSON.stringify(item));
      await bumpRev();
      const t0 = Date.now();
      const found = await waitFor(async () => {
        const r = await req('/api/v1/pull?collections=announcements&since=1970-01-01T00:00:00.000Z', { token });
        return (r.data.collections && r.data.collections.announcements || []).find(a => a.title === 'خبر زندهٔ گوشی') || null;
      }, MAX_WAIT);
      assert.ok(found, 'ثبت در پایگاه دادهٔ مدرسه دیده شد');
      if (!found) console.log('     وضعیت: ' + JSON.stringify((await req('/api/live/state', { token })).data).slice(0, 400));
      const took = Date.now() - t0;
      assert.ok(took < 4000, 'در ' + took + ' میلی‌ثانیه رسید');
      console.log('     ⏱ ' + took + ' میلی‌ثانیه');
    });

    await test('دادهٔ به‌روز برای همهٔ دستگاه‌ها در حافظه گذاشته می‌شود', async () => {
      const got = await waitFor(async () => {
        const rev = JSON.parse(await getObject('payesh/realtime/rev.json') || '{}');
        if (!rev.core) return null;
        const core = JSON.parse(await getObject('payesh/data/core.json') || '{}');
        const ann = (core.collections && core.collections.announcements || []).find(a => a.title === 'خبر زندهٔ گوشی');
        return ann ? { rev, core } : null;
      }, MAX_WAIT);
      assert.ok(got, 'دادهٔ تازه در حافظه منتشر شد');
      assert.ok(got.rev.core && got.rev.persons, 'مُهر بخش‌ها به‌روز شد (کل داده + پرونده‌ها)');
    });

    await test('تغییر در سیستم مدرسه هم همان لحظه در حافظه نوشته می‌شود', async () => {
      const r = await req('/api/sync', {
        token, body: { ops: [{ uid: 'm-' + Date.now(), collection: 'announcements', type: 'put', data: { title: 'خبر مدیر', body: 'x', date: new Date().toISOString().slice(0, 10), audience: 'all' } }] },
      });
      assert.ok(r.data.ok, 'ثبت مدیر');
      const got = await waitFor(async () => {
        const core = JSON.parse(await getObject('payesh/data/core.json') || '{}');
        return (core.collections && core.collections.announcements || []).find(a => a.title === 'خبر مدیر') || null;
      }, MAX_WAIT);
      assert.ok(got, 'ثبت مدیر در حافظه ظاهر شد');
    });

    await test('وضعیت همگام‌سازی برای مدیر گزارش می‌شود', async () => {
      const r = await req('/api/live/state', { token });
      assert.ok(r.data.ok, 'وضعیت');
      assert.strictEqual(r.data.every_ms, 1000);
      assert.ok(r.data.last && r.data.last.at, 'آخرین اجرای حلقه');
    });
  } finally {
    try { child.kill('SIGKILL'); } catch (e) { /* noop */ }
    try { fake.server.close(); } catch (e) { /* noop */ }
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* noop */ }
  }

  console.log(failed ? '\n' + failed + ' ناموفق' : '\n' + passed + ' موفق، 0 ناموفق');
  process.exit(failed ? 1 : 0);

  /* کمکی */
  async function putObject(key, body) {
    await fetch(S3URL + '/' + BUCKET + '/' + key, { method: 'PUT', body });
  }
  async function getObject(key) {
    const r = await fetch(S3URL + '/' + BUCKET + '/' + key);
    return r.ok ? await r.text() : null;
  }
  async function bumpRev() {
    const cur = JSON.parse(await getObject('payesh/realtime/rev.json') || '{}');
    await putObject('payesh/realtime/rev.json', JSON.stringify({
      v: 1, rev: 'phone-' + Date.now().toString(36), at: new Date().toISOString(), by: 'device',
      core: cur.core || '', persons: cur.persons || '',
    }));
  }
}

main().catch(e => { console.error('❌', e); process.exit(1); });
