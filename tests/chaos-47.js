'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون آشوب همگام‌سازی — ردیف ۴۷   (CH-01 .. CH-16)

   سه جزء واقعی، هیچ شبیه‌سازی جایگزین آن‌ها نیست:
     ۱) سرور محصول: `server/index.js` به‌صورت **فرایند جدا** روی HTTP
        با دیتابیس SQLite واقعی و دایرکتوری دادهٔ موقت.
     ۲) پروکسی TCP خطا-تزریق: قطع قبل/وسط درخواست، قطع وسط پاسخ،
        blackhole و «crash سرور دقیقاً لحظهٔ ارسال پاسخ».
     ۳) صندوقچهٔ ماندگار دستگاه: `client/outbox-web.js` روی IndexedDB
        استاندارد (fake-indexeddb) — همان کدی که در مرورگر اجرا می‌شود.

   سنجه‌های پذیرش ردیف ۴۷ در همهٔ سناریوها باید صفر بمانند:
     data_loss=0 · duplicate=0 · cross_tenant=0
   و سه آزمون «جهش» (mutation) ثابت می‌کنند همین سنجه‌ها با خراب‌کردن
   عمدی کنترل قرمز می‌شوند؛ دروازهٔ سبز، خالی نیست.

   اجرا: npm run test:chaos47
   ═══════════════════════════════════════════════════════════════════ */
require('fake-indexeddb/auto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-ch47-'));
const FLAGS = ['--experimental-sqlite', '--disable-warning=ExperimentalWarning'];

let passed = 0, failed = 0; const failures = [];
async function check(id, desc, fn) {
  const t0 = Date.now();
  try {
    const d = await fn();
    passed++;
    console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}  (${Date.now() - t0}ms)`);
  } catch (e) {
    failed++; failures.push(id);
    console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e).slice(0, 300)}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ───────────────────────── سرور واقعی ───────────────────────── */
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

class ServerProc {
  constructor(dataDir) { this.dataDir = dataDir; this.child = null; this.port = null; this.starts = 0; }
  async start(port) {
    this.port = port || await freePort();
    this.child = spawn(process.execPath, [...FLAGS, 'server/index.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(this.port), HOST: '127.0.0.1', PAYESH_DATA: this.dataDir,
        PAYESH_LOG: '0', PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.starts++;
    const c = this.child;
    c.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write(String(d)); });
    await waitFor(async () => {
      try { const r = await rawReq(this.port, 'GET', '/api/health'); return r.status === 200; } catch (e) { return false; }
    }, 25000);
    return this;
  }
  kill(signal = 'SIGKILL') {
    const c = this.child;
    if (!c) return Promise.resolve();
    return new Promise(res => {
      /* فرایندی که با سیگنال مرده، exitCode=null و signalCode پر است؛
         بدون این شرط، once('exit') روی فرایند مرده هرگز صدا زده نمی‌شد. */
      if (c.exitCode != null || c.signalCode != null) return res();
      c.once('exit', () => res());
      try { c.kill(signal); } catch (e) { res(); }
    });
  }
  async restart() { const p = this.port; await this.kill('SIGKILL'); await sleep(150); return this.start(p); }
}

async function waitFor(fn, ms = 15000, step = 80) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    try { const r = await fn(); if (r) return r; } catch (e) { last = e; }
    await sleep(step);
  }
  throw new Error('timeout' + (last ? ': ' + last.message : ''));
}

/* ─────────────────────── درخواست HTTP خام ─────────────────────── */
function rawReq(port, method, urlPath, body, token, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = require('http').request({
      host: '127.0.0.1', port, path: urlPath, method,
      /* اتصال تازه برای هر درخواست: keep-alive سوکت قدیمی را دوباره استفاده
         می‌کرد و خطای تزریق‌شده روی سوکت تازه هرگز دیده نمی‌شد. */
      agent: false,
      headers: Object.assign(
        { 'content-type': 'application/json', connection: 'close' },
        data ? { 'content-length': data.length } : {},
        token ? { authorization: 'Bearer ' + token } : {},
      ),
    }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (e) { json = { raw: buf }; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('client_timeout')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/* ─────────────────── پروکسی خطا-تزریق (TCP واقعی) ─────────────────── */
function makeProxy(targetPort) {
  let target = targetPort;
  const st = {
    mode: 'pass', conns: 0, cut_request: 0, cut_mid_request: 0, cut_mid_response: 0,
    blackholed: 0, forwarded: 0, crash_on_response: 0, bytes_up: 0, bytes_down: 0,
    cutAfterBytes: 260, blackholeMs: 4000, onResponse: null,
  };
  const server = net.createServer(client => {
    st.conns++;
    const mode = st.mode;
    if (mode === 'cut_request') { st.cut_request++; client.destroy(); return; }
    if (mode === 'blackhole') {
      st.blackholed++;
      const t = setTimeout(() => { try { client.destroy(); } catch (e) { /* noop */ } }, st.blackholeMs);
      client.on('close', () => clearTimeout(t));
      client.on('error', () => clearTimeout(t));
      return;                                  /* هیچ بایتی به سرور نمی‌رسد */
    }
    const up = net.connect(target, '127.0.0.1');
    let reqBytes = 0;
    const cutBoth = () => {
      try { client.destroy(); } catch (e) { /* noop */ }
      try { up.destroy(); } catch (e) { /* noop */ }
    };
    client.on('data', d => {
      reqBytes += d.length; st.bytes_up += d.length;
      if (mode === 'cut_mid_request' && reqBytes > st.cutAfterBytes) { st.cut_mid_request++; cutBoth(); return; }
      if (!up.destroyed) up.write(d);
    });
    up.on('data', d => {
      st.bytes_down += d.length;
      if (mode === 'cut_mid_response') { st.cut_mid_response++; cutBoth(); return; }
      if (mode === 'crash_on_response') {
        st.crash_on_response++; cutBoth();
        if (typeof st.onResponse === 'function') st.onResponse();
        return;
      }
      if (!client.destroyed) client.write(d);
    });
    if (mode === 'pass') st.forwarded++;
    client.on('error', () => { try { up.destroy(); } catch (e) { /* noop */ } });
    up.on('error', () => { try { client.destroy(); } catch (e) { /* noop */ } });
    client.on('close', () => { try { up.destroy(); } catch (e) { /* noop */ } });
  });
  return new Promise(res => {
    server.listen(0, '127.0.0.1', () => res({
      port: server.address().port, st,
      setMode(m) { st.mode = m; },
      setTarget(p) { targetPort = p; },
      close() { return new Promise(r => server.close(() => r())); },
    }));
  });
}

/* ───────────────────── سنجه‌های پذیرش ردیف ۴۷ ───────────────────── */
function invariants(rows, expectedNotes) {
  const seen = new Map();
  for (const r of rows) {
    const k = String(r.note || '');
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  const duplicate = [...seen.entries()].filter(([, n]) => n > 1).reduce((a, [, n]) => a + (n - 1), 0);
  const missing = expectedNotes.filter(n => !seen.has(n));
  const crossTenant = rows.filter(r => Number(r.school_id) !== 1 || r.tenant_id != null || r.tenantId != null).length;
  return { data_loss: missing.length, duplicate, cross_tenant: crossTenant, missing: missing.slice(0, 5), total: rows.length };
}
function assertClean(inv, tag) {
  const bad = [];
  if (inv.data_loss) bad.push('data_loss=' + inv.data_loss + ' (' + inv.missing.join(',') + ')');
  if (inv.duplicate) bad.push('duplicate=' + inv.duplicate);
  if (inv.cross_tenant) bad.push('cross_tenant=' + inv.cross_tenant);
  assert(!bad.length, tag + ': ' + bad.join(' · '));
  return `data_loss=0 duplicate=0 cross_tenant=0 rows=${inv.total}`;
}

/* ───────────────────────────── اجرا ───────────────────────────── */
const DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const TALLY = { data_loss: 0, duplicate: 0, cross_tenant: 0, scenarios: 0 };

(async () => {
  const srv = await new ServerProc(DATA_DIR).start();
  let BASE_TOKEN = null;
  let proxy = await makeProxy(srv.port);

  const via = (p, method, url, body, timeout) => rawReq(p, method, url, body, BASE_TOKEN, timeout);
  const dir = async (method, urlPath, body, timeout) => {
    const res = await via(proxy.port, method, urlPath, body, timeout);
    if (process.env.CHAOS_DEBUG) console.log('DEBUG_DIR', res.status, JSON.stringify(res.body).slice(0, 300));
    return res;
  };

  const setup = await rawReq(srv.port, 'POST', '/api/setup', {
    school_name: 'دبیرستان آشوب', manager_name: 'مدیر آشوب', password: 'Manager-99', phone: '09120000077',
  });
  assert(setup.status === 200 && setup.body && setup.body.session && setup.body.session.token, 'setup failed: ' + JSON.stringify(setup.body).slice(0, 200));
  BASE_TOKEN = setup.body.session.token;

  const pullRows = async () => {
    const r = await rawReq(srv.port, 'GET', '/api/v1/pull?collections=attendance&since=1970-01-01T00:00:00.000Z', null, BASE_TOKEN);
    assert(r.status === 200 && r.body && r.body.ok, 'pull failed: ' + r.status);
    return (r.body.collections && r.body.collections.attendance) || [];
  };
  const notes = ops => ops.map(o => o.data.note);

  let seq = 0;
  const op = (note, extra) => Object.assign({
    uid: 'ch47-' + (++seq) + '-' + note.replace(/\s+/g, '_'),
    collection: 'attendance', type: 'put',
    data: { student_id: 11, class_id: 3, date: '2026-11-08', status: 'present', note },
    base_version: 0, at: new Date().toISOString(),
  }, extra || {});

  let obSeq = 0;
  const openBox = (tag) => require('../client/outbox-web').open(`ch47_${tag}_${++obSeq}`, { leaseMs: 1500 });
  const sendVia = (idempotency_key) => async (ops) => (await dir('POST', '/api/sync', { ops, idempotency_key })).body;
  const enqueueAll = async (ob, ops) => { for (const o of ops) await ob.enqueue(o); return ops.length; };

  console.log('\nپایش-لوکال — آزمون آشوب همگام‌سازی (ردیف ۴۷)\n');

  /* ── CH-01 ─────────────────────────────────────────────────────── */
  await check('CH-01', 'مسیر پایه: دستهٔ ۱۰ عملیاتی از صندوقچه به سرور واقعی، بدون خطا', async () => {
    proxy.setMode('pass');
    const ob = await openBox('base');
    const ops = Array.from({ length: 10 }, (_, i) => op('پایه-' + (i + 1)));
    await enqueueAll(ob, ops);
    const r = await ob.drain({ send: sendVia('base-1'), now: Date.now() });
    assert(r.applied === 10 && r.failed === 0, 'drain: ' + JSON.stringify(r));
    const st = await ob.stats();
    assert(st.pending === 0, 'queue pending=' + st.pending);
    const rows = await pullRows();
    const inv = invariants(rows, notes(ops));
    TALLY.scenarios++; TALLY.data_loss += inv.data_loss; TALLY.duplicate += inv.duplicate; TALLY.cross_tenant += inv.cross_tenant;
    ob.close();
    return 'applied=10 ' + assertClean(inv, 'CH-01');
  });

  /* ── CH-02 ─────────────────────────────────────────────────────── */
  await check('CH-02', 'قطع شبکه پیش از ارسال: هیچ op گم نمی‌شود و هیچ نوشتنی رخ نمی‌دهد', async () => {
    proxy.setMode('cut_request');
    const ob = await openBox('cut-before');
    const ops = Array.from({ length: 10 }, (_, i) => op('قطع-قبل-' + (i + 1)));
    await enqueueAll(ob, ops);
    const r = await ob.drain({ send: sendVia('cut-before-1'), now: Date.now() });
    assert(r.stopped === 'network', 'stopped=' + r.stopped);
    const st = await ob.stats();
    assert(st.pending === 10 && st.inflight === 0, 'queue ' + JSON.stringify(st));
    const rows = await pullRows();
    const present = rows.filter(x => /^قطع-قبل-/.test(String(x.note))).length;
    assert(present === 0, 'با شبکهٔ قطع نوشته شد: ' + present);
    TALLY.scenarios++;
    ob.close(); proxy.setMode('pass');
    return `stopped=network pending=10 server_rows=0 cut=${proxy.st.cut_request}`;
  });

  /* ── CH-03 ─────────────────────────────────────────────────────── */
  await check('CH-03', 'بازگشت شبکه و ارسال دوبارهٔ همان صندوقچه: هر op دقیقاً یک‌بار', async () => {
    /* صندوقچهٔ CH-02 دوباره باز می‌شود (همان نام) — ماندگاری واقعی */
    const ob = await require('../client/outbox-web').open(`ch47_cut-before_${obSeq}`, { leaseMs: 1500 });
    const before = await ob.stats();
    assert(before.pending === 10, 'pending=' + before.pending);
    proxy.setMode('pass');
    const r = await ob.drain({ send: sendVia('cut-before-1'), now: Date.now() + 120000 });
    assert(r.applied === 10 && r.failed === 0, 'drain ' + JSON.stringify(r));
    const rows = await pullRows();
    const list = Array.from({ length: 10 }, (_, i) => 'قطع-قبل-' + (i + 1));
    const inv = invariants(rows, list);
    TALLY.scenarios++; TALLY.data_loss += inv.data_loss; TALLY.duplicate += inv.duplicate; TALLY.cross_tenant += inv.cross_tenant;
    const st = await ob.stats();
    assert(st.pending === 0, 'pending=' + st.pending);
    ob.close();
    return 'replayed_after_restore=10 ' + assertClean(inv, 'CH-03');
  });

  /* ── CH-04 ─────────────────────────────────────────────────────── */
  await check('CH-04', 'قطع وسط پاسخ پس از اعمال سرور: دستگاه خطا می‌بیند، replay تکرار نمی‌سازد', async () => {
    proxy.setMode('cut_mid_response');
    const ob = await openBox('cut-response');
    const ops = Array.from({ length: 10 }, (_, i) => op('قطع-پاسخ-' + (i + 1)));
    await enqueueAll(ob, ops);
    const r1 = await ob.drain({ send: sendVia('cut-response-1'), now: Date.now(), limit: 20 });
    assert(r1.stopped === 'network' || r1.failed > 0, 'باید خطای شبکه ببیند: ' + JSON.stringify(r1));
    const st1 = await ob.stats();
    assert(st1.pending >= 10, 'op ها پس از خطا باید در صف بمانند: ' + JSON.stringify(st1));
    const rowsAfterCut = (await pullRows()).filter(x => /^قطع-پاسخ-/.test(String(x.note))).length;
    proxy.setMode('pass');
    const r2 = await ob.drain({ send: sendVia('cut-response-1'), now: Date.now() + 120000, limit: 20 });
    assert(r2.failed === 0, 'drain دوم ' + JSON.stringify(r2));
    const rows = await pullRows();
    const inv = invariants(rows, notes(ops));
    TALLY.scenarios++; TALLY.data_loss += inv.data_loss; TALLY.duplicate += inv.duplicate; TALLY.cross_tenant += inv.cross_tenant;
    ob.close();
    assert(rowsAfterCut === 10, 'سرور پیش از قطع پاسخ اعمال نکرده بود: ' + rowsAfterCut);
    return `server_applied_before_cut=${rowsAfterCut} queue_kept=${st1.pending} ` + assertClean(inv, 'CH-04');
  });

  /* ── CH-05 ─────────────────────────────────────────────────────── */
  await check('CH-05', 'crash سرور درست وسط push: بازگشت فرایند و replay بدون دادهٔ گم‌شده/تکراری', async () => {
    const ops = Array.from({ length: 10 }, (_, i) => op('سقوط-' + (i + 1)));
    let killed = null;
    proxy.st.onResponse = () => { killed = srv.kill('SIGKILL'); };
    proxy.setMode('crash_on_response');
    const ob = await openBox('crash');
    await enqueueAll(ob, ops);
    const r1 = await ob.drain({ send: sendVia('crash-1'), now: Date.now(), limit: 20 });
    assert(r1.stopped === 'network' || r1.failed > 0, 'خطای شبکه دیده نشد: ' + JSON.stringify(r1));
    if (killed) await killed;
    proxy.st.onResponse = null;
    proxy.setMode('pass');
    await srv.restart();
    proxy.setTarget(srv.port);
    const r2 = await ob.drain({ send: sendVia('crash-1'), now: Date.now() + 180000, limit: 20 });
    assert(r2.failed === 0, 'drain پس از restart ' + JSON.stringify(r2));
    const rows = await pullRows();
    const inv = invariants(rows, notes(ops));
    TALLY.scenarios++; TALLY.data_loss += inv.data_loss; TALLY.duplicate += inv.duplicate; TALLY.cross_tenant += inv.cross_tenant;
    ob.close();
    return `server_restarts=${srv.starts} ` + assertClean(inv, 'CH-05');
  });

  /* ── CH-06 ─────────────────────────────────────────────────────── */
  await check('CH-06', 'تکرار همان دسته با همان idempotency_key: پاسخ replay و صفر نوشتن تازه', async () => {
    const ops = Array.from({ length: 5 }, (_, i) => op('کلید-' + (i + 1)));
    const b1 = await rawReq(proxy.port, 'POST', '/api/sync', { ops, idempotency_key: 'idem-47-A' }, BASE_TOKEN);
    assert(b1.status === 200 && b1.body.applied.length === 5, 'push اول ' + JSON.stringify(b1.body).slice(0, 160));
    const rowsBefore = (await pullRows()).length;
    const b2 = await rawReq(proxy.port, 'POST', '/api/sync', { ops, idempotency_key: 'idem-47-A' }, BASE_TOKEN);
    const rowsAfter = (await pullRows()).length;
    assert(b2.body.replayed === true, 'پاسخ تکراری replay نشد: ' + JSON.stringify(b2.body).slice(0, 160));
    assert(rowsAfter === rowsBefore, 'نوشتن تکراری: ' + rowsBefore + '→' + rowsAfter);
    const inv = invariants(await pullRows(), notes(ops));
    TALLY.scenarios++; TALLY.data_loss += inv.data_loss; TALLY.duplicate += inv.duplicate; TALLY.cross_tenant += inv.cross_tenant;
    assertClean(inv, 'CH-06');
    return `rows_before=${rowsBefore} rows_after=${rowsAfter} replayed=true`;
  });

  /* ── CH-07 ─────────────────────────────────────────────────────── */
  await check('CH-07', 'همان uid با کلید تازه (replay بدون idempotency): سرور duplicate می‌دهد نه نوشتن دوم', async () => {
    const one = op('uid-تکراری');
    const a = await rawReq(proxy.port, 'POST', '/api/sync', { ops: [one], idempotency_key: 'uid-key-1' }, BASE_TOKEN);
    assert(a.status === 200 && a.body.applied.length === 1, 'push اول');
    const ver1 = a.body.applied[0].version;
    const b = await rawReq(proxy.port, 'POST', '/api/sync', { ops: [one], idempotency_key: 'uid-key-2' }, BASE_TOKEN);
    assert(b.status === 200, 'push دوم');
    const dup = (b.body.applied || []).some(x => x.duplicate) || (b.body.rejected || []).some(x => x.duplicate);
    assert(dup || (b.body.applied.length === 1 && b.body.applied[0].version === ver1), 'نتیجهٔ تکرار: ' + JSON.stringify(b.body).slice(0, 200));
    const rows = await pullRows();
    const inv = invariants(rows, ['uid-تکراری']);
    TALLY.scenarios++; TALLY.data_loss += inv.data_loss; TALLY.duplicate += inv.duplicate; TALLY.cross_tenant += inv.cross_tenant;
    assertClean(inv, 'CH-07');
    return `duplicate_marked=true version_stable=${ver1}`;
  });

  /* ── CH-08 ─────────────────────────────────────────────────────── */
  await check('CH-08', 'رخداد خارج از ترتیب: op کهنه مقدار جدیدتر را بازنویسی نمی‌کند', async () => {
    const seed = await rawReq(proxy.port, 'POST', '/api/sync', {
      ops: [op('ترتیب', { data: { student_id: 12, class_id: 3, date: '2026-11-08', status: 'present', note: 'ترتیب' } })],
      idempotency_key: 'order-seed',
    }, BASE_TOKEN);
    const id = seed.body.applied[0].id, v1 = seed.body.applied[0].version;
    const newer = await rawReq(proxy.port, 'POST', '/api/sync', {
      ops: [{ uid: 'order-new', collection: 'attendance', type: 'put', id, base_version: v1, data: { status: 'late' } }],
      idempotency_key: 'order-new',
    }, BASE_TOKEN);
    assert(newer.body.applied.length === 1, 'نوشتن جدیدتر اعمال نشد');
    const stale = await rawReq(proxy.port, 'POST', '/api/sync', {
      ops: [{ uid: 'order-old', collection: 'attendance', type: 'put', id, base_version: v1, data: { status: 'absent' } }],
      idempotency_key: 'order-old',
    }, BASE_TOKEN);
    const row = (await pullRows()).find(r => Number(r.id) === Number(id));
    assert(String(row.status) === 'late', 'مقدار جدیدتر بازنویسی شد: ' + row.status);
    assert(stale.body.conflicts.length === 1, 'تعارض ثبت نشد: ' + JSON.stringify(stale.body).slice(0, 160));
    const inv = invariants(await pullRows(), ['ترتیب']);
    TALLY.scenarios++; TALLY.data_loss += inv.data_loss; TALLY.duplicate += inv.duplicate; TALLY.cross_tenant += inv.cross_tenant;
    assertClean(inv, 'CH-08');
    return `kept=late stale_op=conflict version=${row._version}`;
  });

  /* ── CH-09 ─────────────────────────────────────────────────────── */
  await check('CH-09', 'تغییر ساعت دستگاه: برنده با زمان سرور تعیین می‌شود، نه at کلاینت', async () => {
    const future = new Date(Date.now() + 3 * 86400000).toISOString();
    const past = new Date(Date.now() - 365 * 86400000).toISOString();
    const seed = await rawReq(proxy.port, 'POST', '/api/sync', {
      ops: [op('ساعت', { at: past, data: { student_id: 13, class_id: 3, date: '2026-11-08', status: 'present', note: 'ساعت' } })],
      idempotency_key: 'clock-seed',
    }, BASE_TOKEN);
    const id = seed.body.applied[0].id, v = seed.body.applied[0].version;
    /* دستگاه با ساعت جلو، اول می‌فرستد */
    const first = await rawReq(proxy.port, 'POST', '/api/sync', {
      ops: [{ uid: 'clock-future', collection: 'attendance', type: 'put', id, base_version: v, at: future, data: { note: 'یادداشت ساعت جلو' } }],
      idempotency_key: 'clock-future',
    }, BASE_TOKEN);
    assert(first.body.applied.length === 1, 'نوشتن اول اعمال نشد');
    const v2 = (await pullRows()).find(r => Number(r.id) === Number(id))._version;
    /* دستگاه با ساعت عقب، بعد می‌فرستد — باید برنده باشد چون دیرتر رسیده */
    const second = await rawReq(proxy.port, 'POST', '/api/sync', {
      ops: [{ uid: 'clock-past', collection: 'attendance', type: 'put', id, base_version: v2, at: past, data: { note: 'یادداشت ساعت عقب' } }],
      idempotency_key: 'clock-past',
    }, BASE_TOKEN);
    assert(second.body.applied.length === 1, 'نوشتن دوم اعمال نشد');
    const row = (await pullRows()).find(r => Number(r.id) === Number(id));
    assert(row.note === 'یادداشت ساعت عقب', 'ساعت کلاینت برنده شد: ' + row.note);
    const inv = invariants(await pullRows(), ['یادداشت ساعت عقب']);
    TALLY.scenarios++; TALLY.data_loss += inv.data_loss; TALLY.duplicate += inv.duplicate; TALLY.cross_tenant += inv.cross_tenant;
    assertClean(inv, 'CH-09');
    return 'winner=last_received clock_ignored=true';
  });

  /* ── CH-10 ─────────────────────────────────────────────────────── */
  await check('CH-10', 'قطع وسط درخواست: دستهٔ نیمه‌رسیده نه گم می‌شود نه دوباره نوشته', async () => {
    proxy.st.cutAfterBytes = 300;
    proxy.setMode('cut_mid_request');
    const ob = await openBox('cut-request');
    const ops = Array.from({ length: 10 }, (_, i) => op('نیمه-' + (i + 1), { data: { student_id: 14, class_id: 3, date: '2026-11-08', status: 'present', note: 'نیمه-' + (i + 1) } }));
    await enqueueAll(ob, ops);
    const r1 = await ob.drain({ send: sendVia('half-1'), now: Date.now(), limit: 20 });
    assert(r1.stopped === 'network' || r1.failed > 0, 'خطا دیده نشد: ' + JSON.stringify(r1));
    proxy.setMode('pass');
    const r2 = await ob.drain({ send: sendVia('half-1'), now: Date.now() + 180000, limit: 20 });
    assert(r2.failed === 0, 'drain دوم ' + JSON.stringify(r2));
    const inv = invariants(await pullRows(), notes(ops));
    TALLY.scenarios++; TALLY.data_loss += inv.data_loss; TALLY.duplicate += inv.duplicate; TALLY.cross_tenant += inv.cross_tenant;
    ob.close();
    return `cut_bytes=${proxy.st.cutAfterBytes} ` + assertClean(inv, 'CH-10');
  });

  /* ── CH-11 ─────────────────────────────────────────────────────── */
  await check('CH-11', 'blackhole (اتصال بی‌پاسخ): مهلت کلاینت، صف سالم، سپس دقیقاً یک‌بار', async () => {
    proxy.st.blackholeMs = 600;
    proxy.setMode('blackhole');
    const ob = await openBox('blackhole');
    const ops = Array.from({ length: 6 }, (_, i) => op('سیاه‌چال-' + (i + 1), { data: { student_id: 15, class_id: 3, date: '2026-11-08', status: 'present', note: 'سیاه‌چال-' + (i + 1) } }));
    await enqueueAll(ob, ops);
    const r1 = await ob.drain({ send: async (batch) => (await dir('POST', '/api/sync', { ops: batch, idempotency_key: 'bh-1' }, 2500)).body, now: Date.now(), limit: 20 });
    assert(r1.stopped === 'network', 'blackhole باید خطای شبکه بدهد: ' + JSON.stringify(r1));
    const st = await ob.stats();
    assert(st.pending === 6, 'صف ' + JSON.stringify(st));
    proxy.setMode('pass');
    const r2 = await ob.drain({ send: sendVia('bh-1'), now: Date.now() + 180000, limit: 20 });
    assert(r2.failed === 0, 'drain دوم ' + JSON.stringify(r2));
    const inv = invariants(await pullRows(), notes(ops));
    TALLY.scenarios++; TALLY.data_loss += inv.data_loss; TALLY.duplicate += inv.duplicate; TALLY.cross_tenant += inv.cross_tenant;
    ob.close();
    return `blackholed=${proxy.st.blackholed} ` + assertClean(inv, 'CH-11');
  });

  /* ── CH-12 ─────────────────────────────────────────────────────── */
  await check('CH-12', 'بستن ناگهانی برنامه وسط ارسال: lease بازیابی و ارسال دوباره بدون تکرار', async () => {
    const name = 'ch47_app-crash_' + (++obSeq);
    const ob1 = await require('../client/outbox-web').open(name, { leaseMs: 1000 });
    const ops = Array.from({ length: 8 }, (_, i) => op('کرش‌برنامه-' + (i + 1), { data: { student_id: 16, class_id: 3, date: '2026-11-08', status: 'present', note: 'کرش‌برنامه-' + (i + 1) } }));
    await enqueueAll(ob1, ops);
    const claimed = await ob1.claim(20, Date.now());
    assert(claimed.length === 8, 'claim=' + claimed.length);
    /* اینجا «برنامه می‌بندد»: هیچ ack ای انجام نمی‌شود */
    ob1.close();
    const ob2 = await require('../client/outbox-web').open(name, { leaseMs: 1000 });
    const rec = await ob2.recover(Date.now() + 1500);
    assert(rec.recovered === 8, 'recovered=' + JSON.stringify(rec));
    const r = await ob2.drain({ send: sendVia('app-crash-1'), now: Date.now() + 2000, limit: 20 });
    assert(r.failed === 0, 'drain ' + JSON.stringify(r));
    const inv = invariants(await pullRows(), notes(ops));
    TALLY.scenarios++; TALLY.data_loss += inv.data_loss; TALLY.duplicate += inv.duplicate; TALLY.cross_tenant += inv.cross_tenant;
    ob2.close();
    return `recovered=8 ` + assertClean(inv, 'CH-12');
  });

  /* ── CH-13 ─────────────────────────────────────────────────────── */
  await check('CH-13', 'نشت متقاطع مستأجر: school_id/tenant_id کلاینتی پذیرفته نمی‌شود', async () => {
    const evil = op('متقاطع');
    evil.data = Object.assign({}, evil.data, { school_id: 999, tenant_id: 'evil-tenant', tenantId: 'evil-2' });
    const r = await rawReq(proxy.port, 'POST', '/api/sync', { ops: [evil], idempotency_key: 'xt-1' }, BASE_TOKEN);
    assert(r.status === 200 && r.body.applied.length === 1, 'push ' + JSON.stringify(r.body).slice(0, 160));
    const row = (await pullRows()).find(x => x.note === 'متقاطع');
    assert(Number(row.school_id) === 1, 'school_id=' + row.school_id);
    assert(row.tenant_id == null && row.tenantId == null, 'میدان مستأجر نشت کرد: ' + JSON.stringify(row).slice(0, 160));
    const inv = invariants(await pullRows(), ['متقاطع']);
    TALLY.scenarios++; TALLY.data_loss += inv.data_loss; TALLY.duplicate += inv.duplicate; TALLY.cross_tenant += inv.cross_tenant;
    assertClean(inv, 'CH-13');
    return 'client_tenant_fields_stripped=true';
  });

  /* ── CH-14 ─────────────────────────────────────────────────────── */
  await check('CH-14', 'طوفان آشوب: ۵ دور × ۴۰ op با خطای تصادفی واقعی، بدون گم‌شدن/تکرار', async () => {
    const ob = await openBox('storm');
    const all = [];
    const modes = ['cut_mid_response', 'cut_mid_request', 'blackhole', 'pass', 'cut_request'];
    proxy.st.blackholeMs = 400;
    for (let round = 0; round < 5; round++) {
      const ops = Array.from({ length: 40 }, (_, i) => op(`طوفان-${round + 1}-${i + 1}`, { data: { student_id: 17, class_id: 3, date: '2026-11-08', status: 'present', note: `طوفان-${round + 1}-${i + 1}` } }));
      all.push(...ops);
      await enqueueAll(ob, ops);
      proxy.setMode(modes[round % modes.length]);
      await ob.drain({ send: async (batch) => (await dir('POST', '/api/sync', { ops: batch, idempotency_key: 'storm-' + round }, 2500)).body, now: Date.now(), limit: 120 });
      proxy.setMode('pass');
      await ob.drain({ send: sendVia('storm-fix-' + round), now: Date.now() + 240000, limit: 120 });
    }
    const st = await ob.stats();
    assert(st.pending === 0 && st.inflight === 0, 'صف ' + JSON.stringify(st));
    const inv = invariants(await pullRows(), notes(all));
    TALLY.scenarios++; TALLY.data_loss += inv.data_loss; TALLY.duplicate += inv.duplicate; TALLY.cross_tenant += inv.cross_tenant;
    ob.close();
    assert(inv.total >= 200, 'ردیف‌ها: ' + inv.total);
    return `ops=200 ` + assertClean(inv, 'CH-14');
  });

  /* ── CH-15..17 — کنترل منفی: خراب‌کردن عمدی کنترل‌ها ─────────── */
  await check('CH-15', 'کنترل منفی ۱: حذف idempotency در سرور ⇒ duplicate>0 و دروازه قرمز می‌شود', async () => {
    const { openStore } = require('../server/db');
    const sync = require('../server/sync');
    const s2 = openStore(path.join(TMP, 'mut-idem.sqlite'));
    const mgr = s2.insert('users', { name: 'مدیر جهش', role: 'manager', active: true });
    sync.push(s2, { user: mgr, role: 'manager', device: null }, {
      ops: [{ uid: 'mut-1', collection: 'attendance', type: 'put', data: { student_id: 1, class_id: 1, date: '2026-11-08', status: 'present', note: 'جهش' } }],
    });
    /* خراب‌کردن عمدی: دفعهٔ دوم انگار op تازه است */
    const realSeen = s2.syncSeen.bind(s2);
    s2.syncSeen = () => null;
    sync.push(s2, { user: mgr, role: 'manager', device: null }, {
      ops: [{ uid: 'mut-1', collection: 'attendance', type: 'put', data: { student_id: 1, class_id: 1, date: '2026-11-08', status: 'present', note: 'جهش' } }],
    });
    s2.syncSeen = realSeen;
    const rows = s2.all('attendance');
    const inv = invariants(rows, ['جهش']);
    assert(inv.duplicate > 0, 'با حذف idempotency باید duplicate>0 شود، شد: ' + JSON.stringify(inv));
    s2.db.close();
    return `injected duplicate=${inv.duplicate} ⇒ gate would be RED`;
  });

  await check('CH-16', 'کنترل منفی ۲: حذف مهر مستأجر ⇒ cross_tenant>0 و دروازه قرمز می‌شود', async () => {
    const tenantCtx = require('../server/tenant-context');
    const real = tenantCtx.stamp;
    tenantCtx.stamp = (data) => Object.assign({}, data);        /* خراب‌کاری عمدی */
    const { openStore } = require('../server/db');
    const sync = require('../server/sync');
    const s3 = openStore(path.join(TMP, 'mut-tenant.sqlite'));
    const mgr = s3.insert('users', { name: 'مدیر جهش ۲', role: 'manager', active: true });
    sync.push(s3, { user: mgr, role: 'manager', device: null }, {
      ops: [{ uid: 'mut-t1', collection: 'attendance', type: 'put', data: { student_id: 1, class_id: 1, date: '2026-11-08', status: 'present', note: 'نشت', school_id: 999 } }],
    });
    tenantCtx.stamp = real;
    const inv = invariants(s3.all('attendance'), ['نشت']);
    assert(inv.cross_tenant > 0, 'با حذف مهر باید cross_tenant>0 شود، شد: ' + JSON.stringify(inv));
    s3.db.close();
    return `injected cross_tenant=${inv.cross_tenant} ⇒ gate would be RED`;
  });

  await check('CH-17', 'کنترل منفی ۳: کلاینت بی‌دوام (دورریختن op در خطا) ⇒ data_loss>0 و دروازه قرمز می‌شود', async () => {
    proxy.setMode('cut_request');
    const ob = await openBox('mut-loss');
    const ops = Array.from({ length: 5 }, (_, i) => op('گم‌شدن-' + (i + 1), { data: { student_id: 18, class_id: 3, date: '2026-11-08', status: 'present', note: 'گم‌شدن-' + (i + 1) } }));
    await enqueueAll(ob, ops);
    /* کلاینت خراب: در خطا op را دور می‌ریزد (رفتار نسخهٔ قبل از ردیف ۴۰) */
    const brokenSend = async () => { throw new Error('network_down'); };
    try {
      const batch = await ob.claim(20, Date.now());
      try { await brokenSend(batch); } catch (e) { for (const r of batch) await ob.ack(r.k); }
    } catch (e) { /* noop */ }
    proxy.setMode('pass');
    const inv = invariants(await pullRows(), notes(ops));
    ob.close();
    assert(inv.data_loss > 0, 'کلاینت بی‌دوام باید data_loss>0 بدهد، داد: ' + JSON.stringify(inv));
    return `injected data_loss=${inv.data_loss} ⇒ gate would be RED`;
  });

  /* ── جمع‌بندی ─────────────────────────────────────────────────── */
  await proxy.close();
  await srv.kill('SIGKILL');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* noop */ }

  console.log(`\nCHAOS scenarios=${TALLY.scenarios} data_loss=${TALLY.data_loss} duplicate=${TALLY.duplicate} cross_tenant=${TALLY.cross_tenant}`);
  console.log(`CHAOS checks=${passed + failed} pass=${passed} fail=${failed}`);
  const red = TALLY.data_loss + TALLY.duplicate + TALLY.cross_tenant;
  if (failed === 0 && red === 0 && TALLY.scenarios >= 10) {
    console.log('CHAOS-47-OK');
    process.exit(0);
  }
  console.log('failed: ' + failures.join(','));
  console.log('CHAOS-47-FAIL');
  process.exit(1);
})().catch(async e => {
  console.log('CHAOS-47-ERROR: ' + String((e && e.stack) || e).slice(0, 600));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (x) { /* noop */ }
  process.exit(2);
});
