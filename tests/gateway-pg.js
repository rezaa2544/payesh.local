'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون ردیف ۳۷ — Gateway نازک و بی‌حالت
   دو نمونهٔ واقعی (فرایند جدا) + یک نمونهٔ بدتنظیم + PostgreSQL واقعی

   اجرا: bash docs/cloud/reports/evidence/run-37-gateway.sh
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const tenancy = require(path.join(ROOT, 'server/tenancy.js'));

const ADMIN_URL = process.env.PGURL_ADMIN || '';
const RUNTIME_URL = process.env.PGURL_RUNTIME || '';
const SECRET = process.env.TENANCY_SECRET || '';
const GW1 = Number(process.env.GW1_PORT || 0);
const GW2 = Number(process.env.GW2_PORT || 0);
const GW3 = Number(process.env.GW3_PORT || 0);
const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

if (!ADMIN_URL || !RUNTIME_URL || !SECRET || !GW1 || !GW2) {
  console.log('BLOCKED — ENVIRONMENT UNAVAILABLE (PGURL_ADMIN/PGURL_RUNTIME/TENANCY_SECRET/GW ports لازم است)');
  process.exit(3);
}

let passed = 0, failed = 0;
const failures = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(c, m) { if (!c) throw new Error(m); }
async function check(id, desc, fn) {
  try { const d = await fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; failures.push(id + ' — ' + ((e && e.message) || e)); console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e).slice(0, 240)}`); }
}
function token(tid, role = 'manager', did = 'dev-1') {
  return tenancy.signToken({ tid, role, uid: 'u-' + tid.slice(0, 4), did, iat: Date.now(), exp: Date.now() + 600000 }, SECRET);
}
async function gw(port, p, { method = 'GET', tok, body, headers = {}, raw = null } = {}) {
  const h = Object.assign({ 'content-type': 'application/json' }, headers);
  if (tok) h.authorization = 'Bearer ' + tok;
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers: h, body: raw != null ? raw : (body ? JSON.stringify(body) : undefined),
  });
  return { status: r.status, headers: r.headers, data: await r.json().catch(() => null) };
}
function startGateway(port, opts = {}) {
  const child = spawn(process.execPath, ['server/gateway.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), HOST: '127.0.0.1', PGURL: RUNTIME_URL, GW_SECRET: SECRET,
      GW_INSTANCE: 'gw-' + port, GW_PULL_MAX: String(opts.pullMax || 1000),
      GW_QUOTA_MAX: String(opts.quotaMax || 100000), GW_QUOTA_WINDOW_SEC: String(opts.quotaWindow || 60),
      GW_MAX_BODY: String(opts.maxBody || 1024 * 1024), PAYESH_LOG: '0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.__log = '';
  child.stderr.on('data', (d) => { child.__log += String(d); if (process.env.VERBOSE) console.error('[gw:' + port + '] ' + String(d).trim()); });
  child.on('exit', (code) => { child.__exit = code; });
  return child;
}
async function waitUp(port, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); if (r.ok) return true; } catch (e) { /* retry */ }
    await sleep(200);
  }
  return false;
}

(async () => {
  const children = [];
  const { Client } = require('pg');
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const mig = await tenancy.migrate(admin);

  const quotaPort = GW3 || (GW2 + 1);
  const quota2Port = quotaPort + 2;
  children.push(startGateway(GW1, { pullMax: 50 }));
  children.push(startGateway(GW2, { pullMax: 50 }));
  children.push(startGateway(quotaPort, { quotaMax: 5, quotaWindow: 60 }));
  children.push(startGateway(quota2Port, { quotaMax: 5, quotaWindow: 60 }));
  const badPort = quotaPort + 1;
  /* نمونهٔ بدتنظیم: بدون PGURL — برای تفکیک liveness از readiness */
  children.push(spawn(process.execPath, ['server/gateway.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(badPort), HOST: '127.0.0.1', PGURL: '', GW_SECRET: SECRET,
      GW_INSTANCE: 'gw-bad', PAYESH_LOG: '0',
    }),
    stdio: ['ignore', 'ignore', 'ignore'],
  }));

  const up = await Promise.all([waitUp(GW1), waitUp(GW2), waitUp(quotaPort), waitUp(badPort), waitUp(quota2Port)]);
  assert(up.every(Boolean), 'نمونه‌ها بالا نیامدند: ' + JSON.stringify({
    GW1: up[0], GW2: up[1], quota: up[2], bad: up[3], quota2: up[4],
    logs: children.map((c) => ({ exit: c.__exit, log: String(c.__log || '').slice(0, 200) })),
  }));

  const A = token(TENANT_A, 'manager', 'dev-a');
  const B = token(TENANT_B, 'manager', 'dev-b');

  try {
    await check('GW-01', 'دو نمونهٔ مستقل: هر دو /healthz ۲۰۰ با شناسهٔ نمونهٔ متفاوت', async () => {
      const a = await gw(GW1, '/healthz');
      const b = await gw(GW2, '/healthz');
      assert(a.status === 200 && b.status === 200, 'healthz: ' + a.status + '/' + b.status);
      assert(a.headers.get('x-gateway-instance') !== b.headers.get('x-gateway-instance'), 'شناسهٔ نمونه‌ها یکسان است');
      return `${a.data.instance} & ${b.data.instance}`;
    });

    await check('GW-02', '/readyz واقعی: DB + set_config تراکنشی بدون نشت زمینه', async () => {
      for (const port of [GW1, GW2]) {
        const r = await gw(port, '/readyz');
        assert(r.status === 200 && r.data.ok === true, 'readyz ' + port + ': ' + r.status + ' ' + JSON.stringify(r.data));
        assert(r.data.tenant_scoped === true, 'set_config در تراکنش دیده نشد');
        assert(r.data.leaked_after_commit === false, 'زمینهٔ مستأجر پس از commit نشت کرده');
      }
      return 'tenant_scoped=yes leaked=no';
    });

    await check('GW-03', 'تفکیک liveness/readiness: نمونهٔ بی‌DB ⇒ healthz ۲۰۰ ولی readyz ۵۰۳', async () => {
      const h = await gw(badPort, '/healthz');
      const r = await gw(badPort, '/readyz');
      assert(h.status === 200, 'healthz باید ۲۰۰ بماند');
      assert(r.status === 503 && r.data.ok === false, 'readyz باید ۵۰۳ بدهد: ' + r.status + ' ' + JSON.stringify(r.data));
      return `healthz=${h.status} readyz=${r.status} (${r.data.error})`;
    });

    await check('GW-04', 'احراز: بدون توکن ۴۰۱، توکن دست‌کاری‌شده ۴۰۱', async () => {
      const none = await gw(GW1, '/api/gw/v1/pull?since_seq=0');
      assert(none.status === 401, 'بدون توکن باید ۴۰۱ باشد');
      const tampered = await gw(GW1, '/api/gw/v1/pull?since_seq=0', { tok: A.slice(0, -6) + 'AAAAAA' });
      assert(tampered.status === 401 && tampered.data.error === 'unauthorized', 'توکن دست‌کاری‌شده: ' + tampered.status + ' ' + JSON.stringify(tampered.data));
      const expired = tenancy.signToken({ tid: TENANT_A, role: 'manager', uid: 'u', did: 'd', iat: Date.now() - 7200000, exp: Date.now() - 3600000 }, SECRET);
      const ex = await gw(GW2, '/api/gw/v1/pull?since_seq=0', { tok: expired });
      assert(ex.status === 401 && ex.data.error === 'token_expired', 'توکن منقضی: ' + ex.status + ' ' + JSON.stringify(ex.data));
      return 'no-token=401 tampered=401 expired=token_expired';
    });

    await check('GW-05', 'tenant فقط از نشست: هدر X-Tenant و tenant_id در بدنه بی‌اثرند', async () => {
      const r = await gw(GW1, '/api/gw/v1/push', {
        method: 'POST', tok: A,
        headers: { 'x-tenant': TENANT_B, 'x-tenant-id': TENANT_B, 'x-device-id': 'dev-a' },
        body: { ops: [{ uid: 'gw-scope-1', collection: 'classes', id: 11, type: 'put', data: { name: 'دهم الف', tenant_id: TENANT_B, school_id: 99 } }] },
      });
      assert(r.status === 200 && r.data.counts.applied === 1, 'push: ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 160));
      const fa = await gw(GW1, '/api/gw/v1/pull?since_seq=0&collection=classes', { tok: A });
      const fb = await gw(GW2, '/api/gw/v1/pull?since_seq=0&collection=classes', { tok: B });
      assert(fa.data.rows.some((x) => x.id === 11), 'مستأجر A ردیف را نمی‌بیند');
      assert(!fb.data.rows.some((x) => x.id === 11), 'مستأجر B ردیف A را می‌بیند (نشت!)');
      assert(fa.data.rows.find((x) => x.id === 11).data.tenant_id === undefined, 'فیلد tenant_id باید از داده حذف شود');
      return `A=${fa.data.count} B=${fb.data.count} tenant=session-only`;
    });

    await check('GW-06', 'push دسته‌ای ۵ عملیات ⇒ applied=5 و pull همان ۵ ردیف را می‌دهد', async () => {
      const ops = Array.from({ length: 5 }, (_, i) => ({ uid: 'gw-batch-' + i, collection: 'announcements', id: 200 + i, type: 'put', data: { title: 'n' + i } }));
      const r = await gw(GW1, '/api/gw/v1/push', { method: 'POST', tok: A, headers: { 'x-device-id': 'dev-a' }, body: { ops } });
      assert(r.status === 200 && r.data.counts.applied === 5, 'applied: ' + JSON.stringify(r.data).slice(0, 200));
      const p = await gw(GW2, '/api/gw/v1/pull?since_seq=0&collection=announcements', { tok: A });
      const got = p.data.rows.filter((x) => x.id >= 200 && x.id < 205);
      assert(got.length === 5 && got.every((x) => x.op === 'put'), 'feed: ' + got.length);
      return `applied=5 feed_rows=${got.length}`;
    });

    await check('GW-07', 'تکرار همان دسته ⇒ duplicates=5، applied=0 و feed رشد نمی‌کند', async () => {
      const before = await gw(GW1, '/api/gw/v1/pull?since_seq=0&limit=50', { tok: A });
      const ops = Array.from({ length: 5 }, (_, i) => ({ uid: 'gw-batch-' + i, collection: 'announcements', id: 200 + i, type: 'put', data: { title: 'n' + i } }));
      const r = await gw(GW1, '/api/gw/v1/push', { method: 'POST', tok: A, headers: { 'x-device-id': 'dev-a' }, body: { ops } });
      assert(r.status === 200 && r.data.counts.duplicates === 5 && r.data.counts.applied === 0, 'replay: ' + JSON.stringify(r.data).slice(0, 200));
      const after = await gw(GW1, '/api/gw/v1/pull?since_seq=0&limit=50', { tok: A });
      assert(after.data.count === before.data.count, 'feed باید ثابت بماند: ' + before.data.count + '→' + after.data.count);
      return `duplicates=5 feed=${after.data.count}`;
    });

    await check('GW-08', 'بی‌حالتی idempotency: تکرار همان عملیات روی نمونهٔ دیگر هم duplicate است', async () => {
      const ops = [{ uid: 'gw-batch-0', collection: 'announcements', id: 200, type: 'put', data: { title: 'تکرار روی نمونهٔ دوم' } }];
      const r = await gw(GW2, '/api/gw/v1/push', { method: 'POST', tok: A, headers: { 'x-device-id': 'dev-a' }, body: { ops } });
      assert(r.status === 200 && r.data.counts.duplicates === 1 && r.data.counts.applied === 0, 'روی نمونهٔ دوم: ' + JSON.stringify(r.data).slice(0, 160));
      return 'cross-instance duplicate=yes';
    });

    await check('GW-09', 'بی‌حالتی صفحه‌بندی: پیمایش با limit=2 بین دو نمونه ⇒ هر ردیف دقیقاً یک‌بار', async () => {
      const full = await gw(GW1, '/api/gw/v1/pull?since_seq=0&limit=50', { tok: A });
      const expected = full.data.rows.map((r) => r.seq);
      const got = [];
      let since = 0, port = GW1, guard = 0;
      for (;;) {
        const r = await gw(port, `/api/gw/v1/pull?since_seq=${since}&limit=2`, { tok: A });
        got.push(...r.data.rows.map((x) => x.seq));
        if (!r.data.more) break;
        since = r.data.next_seq;
        port = port === GW1 ? GW2 : GW1;             /* آگاهانه بین نمونه‌ها جابه‌جا می‌شویم */
        if (guard++ > 200) throw new Error('حلقهٔ بی‌پایان');
      }
      assert(JSON.stringify(got) === JSON.stringify(expected), `صفحه‌بندی بین نمونه‌ها ناسازگار است (${got.length}≠${expected.length})`);
      return `pages=${guard} rows=${got.length} instances=2`;
    });

    await check('GW-10', 'سقف عملیات: ۲۰۱ عملیات ⇒ ۴۱۳ too_many_ops و هیچ نوشتنی', async () => {
      const ops = Array.from({ length: 201 }, (_, i) => ({ uid: 'gw-many-' + i, collection: 'classes', id: 900 + i, type: 'put', data: { n: i } }));
      const before = (await gw(GW1, '/api/gw/v1/pull?since_seq=0&limit=50', { tok: A })).data.count;
      const r = await gw(GW1, '/api/gw/v1/push', { method: 'POST', tok: A, headers: { 'x-device-id': 'cap-1' }, body: { ops } });
      assert(r.status === 413 && r.data.error === 'too_many_ops', 'پاسخ: ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 120));
      const after = (await gw(GW1, '/api/gw/v1/pull?since_seq=0&limit=50', { tok: A })).data.count;
      assert(before === after, 'نباید چیزی نوشته شود');
      return `limit=${r.data.limit} feed=${after}`;
    });

    await check('GW-11', 'سقف بدنه: درخواست بزرگ‌تر از GW_MAX_BODY ⇒ ۴۱۳ body_too_large', async () => {
      const big = JSON.stringify({ ops: [{ uid: 'gw-big-1', collection: 'classes', id: 1, type: 'put', data: { pad: 'x'.repeat(1024 * 1024 + 64) } }] });
      const r = await gw(GW1, '/api/gw/v1/push', { method: 'POST', tok: A, headers: { 'x-device-id': 'cap-2' }, raw: big });
      assert(r.status === 413, 'پاسخ: ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 120));
      assert(r.data.error === 'body_too_large' || r.data.error === 'op_too_large', 'کد خطا: ' + r.data.error);
      return 'status=413 ' + r.data.error;
    });

    await check('GW-12', 'سقف payload هر عملیات: >۶۴KB ⇒ ۴۱۳ op_too_large', async () => {
      const r = await gw(GW1, '/api/gw/v1/push', {
        method: 'POST', tok: A, headers: { 'x-device-id': 'cap-3' },
        body: { ops: [{ uid: 'gw-op-big', collection: 'classes', id: 2, type: 'put', data: { pad: 'y'.repeat(70 * 1024) } }] },
      });
      assert(r.status === 413 && r.data.error === 'op_too_large', 'پاسخ: ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 120));
      return 'op_too_large limit=' + r.data.detail.limit;
    });

    await check('GW-13', 'سقف ردیف pull: limit بزرگ‌تر از GW_PULL_MAX کلمپ می‌شود', async () => {
      const r = await gw(GW1, '/api/gw/v1/pull?since_seq=0&limit=99999', { tok: A });
      assert(r.status === 200, 'pull: ' + r.status);
      assert(r.data.clamped_limit === 50, 'کلمپ نشد: ' + r.data.clamped_limit);
      assert(r.data.count <= 50, 'بیش از سقف ردیف برگشت');
      return `clamped=${r.data.clamped_limit} rows=${r.data.count}`;
    });

    await check('GW-14', 'سهمیهٔ نرخ: پنجره در دیتابیس است و بین نمونه‌ها مشترک (۶ درخواست ⇒ ۴۲۹ روی هر دو نمونه)', async () => {
      const qDev = 'dev-quota-' + Date.now();
      const qTok = token(TENANT_A, 'manager', qDev);
      const lead = [];
      for (let i = 0; i < 6; i++) {
        const port = i % 2 ? quotaPort : quota2Port;   /* هر دو نمونه سقف ۵ دارند */
        const r = await gw(port, '/api/gw/v1/pull?since_seq=0&limit=1', { tok: qTok, headers: { 'x-device-id': qDev } });
        lead.push({ i, port, status: r.status, remaining: r.headers.get('x-ratelimit-remaining') });
      }
      const limited = lead.filter((x) => x.status === 429);
      assert(limited.length >= 1, 'هیچ ۴۲۹ای نداد: ' + JSON.stringify(lead));
      /* نمونه‌ای که درخواست ششم را نداد باید هم ۴۲۹ بدهد ⇒ سهمیه در DB مشترک است */
      const other = lead[0].port === quotaPort ? quota2Port : quotaPort;
      const blockedOther = await gw(other, '/api/gw/v1/pull?since_seq=0&limit=1', { tok: qTok, headers: { 'x-device-id': qDev } });
      assert(blockedOther.status === 429 && blockedOther.data.retry_after_ms >= 0,
        'نمونهٔ دیگر باید هم ۴۲۹ بدهد (سهمیه مشترک): ' + blockedOther.status);
      const row = await admin.query('select coalesce(sum(hits),0)::int as hits, count(*)::int as windows from gateway_quota where tenant_id = $1 and device_id = $2', [TENANT_A, qDev]);
      assert(Number(row.rows[0].hits) >= 6, 'شمارش سهمیه در DB نیست: ' + JSON.stringify(row.rows));
      return `429 پس از ${lead.findIndex((x) => x.status === 429)} درخواست · hits_in_db=${row.rows[0].hits} · windows=${row.rows[0].windows} · cross-instance=yes`;
    });


    await check('GW-15', 'تعارض OCC از مسیر Gateway: conflicts=1 و بدون ردیف تازه در feed', async () => {
      const p1 = await gw(GW1, '/api/gw/v1/push', { method: 'POST', tok: A, headers: { 'x-device-id': 'occ' }, body: { ops: [{ uid: 'gw-occ-1', collection: 'subjects', id: 301, type: 'put', data: { name: 'ریاضی' } }] } });
      assert(p1.status === 200 && p1.data.counts.applied === 1, 'درج اولیه: ' + JSON.stringify(p1.data).slice(0, 160));
      const ver = p1.data.applied[0].version;
      const before = (await gw(GW2, '/api/gw/v1/pull?since_seq=0&limit=50', { tok: A })).data.count;
      const bad = await gw(GW2, '/api/gw/v1/push', { method: 'POST', tok: A, headers: { 'x-device-id': 'occ' }, body: { ops: [{ uid: 'gw-occ-2', collection: 'subjects', id: 301, type: 'put', base_version: ver + 7, data: { name: 'نفوذ' } }] } });
      assert(bad.status === 200 && bad.data.counts.conflicts === 1, 'تعارض: ' + JSON.stringify(bad.data).slice(0, 160));
      const after = (await gw(GW1, '/api/gw/v1/pull?since_seq=0&limit=50', { tok: A })).data.count;
      assert(after === before, 'تعارض نباید feed بسازد');
      return `version=${ver} conflicts=1 feed_stable=${after}`;
    });

    await check('GW-16', 'اتمی‌بودن دسته: یک عملیات نامعتبر ⇒ کل دسته رد، هیچ ردیفی نوشته نمی‌شود', async () => {
      const before = (await gw(GW1, '/api/gw/v1/pull?since_seq=0&limit=50', { tok: A })).data.count;
      const r = await gw(GW1, '/api/gw/v1/push', {
        method: 'POST', tok: A, headers: { 'x-device-id': 'atom' },
        body: { ops: [
          { uid: 'gw-atom-1', collection: 'classes', id: 400, type: 'put', data: { n: 1 } },
          { uid: 'gw-atom-2', collection: '@@bad@@', id: 401, type: 'put', data: { n: 2 } },
        ] },
      });
      assert(r.status === 400 && r.data.error === 'unknown_collection', 'پاسخ: ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 140));
      const after = (await gw(GW2, '/api/gw/v1/pull?since_seq=0&limit=50', { tok: A })).data.count;
      assert(after === before, 'دستهٔ نامعتبر نباید چیزی بنویسد: ' + before + '→' + after);
      return `rejected=unknown_collection feed_stable=${after}`;
    });

    await check('GW-17', 'جدایی مستأجرها: push مستأجر B هیچ ردیفی از A را تغییر نمی‌دهد', async () => {
      const aBefore = await gw(GW1, '/api/gw/v1/pull?since_seq=0&collection=classes&limit=50', { tok: A });
      const bPush = await gw(GW2, '/api/gw/v1/push', { method: 'POST', tok: B, headers: { 'x-device-id': 'dev-b' }, body: { ops: [{ uid: 'gw-b-1', collection: 'classes', id: 11, type: 'put', data: { name: 'کلاس B' } }] } });
      assert(bPush.status === 200 && bPush.data.counts.applied === 1, 'push B: ' + JSON.stringify(bPush.data).slice(0, 160));
      const aAfter = await gw(GW1, '/api/gw/v1/pull?since_seq=0&collection=classes&limit=50', { tok: A });
      assert(aAfter.data.count === aBefore.data.count, 'feed مستأجر A نباید تغییر کند');
      const aRow = aAfter.data.rows.find((x) => x.id === 11 && x.op === 'put');
      assert(aRow && aRow.data.name === 'دهم الف', 'دادهٔ A باید دست‌نخورده بماند');
      const bRow = (await gw(GW2, '/api/gw/v1/pull?since_seq=0&collection=classes&limit=50', { tok: B })).data.rows.find((x) => x.id === 11);
      assert(bRow && bRow.data.name === 'کلاس B', 'دادهٔ B ثبت نشد');
      return `A_name=${aRow.data.name} B_name=${bRow.data.name}`;
    });

    await check('GW-18', 'توان عبوری: ۳۰۰ عملیات در دسته‌های ۵۰تایی', async () => {
      const t0 = Date.now();
      let applied = 0;
      for (let b = 0; b < 6; b++) {
        const ops = Array.from({ length: 50 }, (_, i) => ({ uid: `gw-perf-${b}-${i}`, collection: 'grades', id: 5000 + b * 50 + i, type: 'put', data: { score: i % 20 } }));
        const r = await gw(b % 2 ? GW2 : GW1, '/api/gw/v1/push', { method: 'POST', tok: A, headers: { 'x-device-id': 'perf' }, body: { ops } });
        assert(r.status === 200, 'batch ' + b + ': ' + r.status);
        applied += r.data.counts.applied;
      }
      const ms = Date.now() - t0;
      assert(applied === 300, 'applied=' + applied);
      return `300 ops · ${ms}ms ≈${Math.round((300 / ms) * 1000)} op/s (دو نمونه)`;
    });

    await check('GW-19', 'مهاجرت Gateway: جدول‌های ops/quota با RLS اجباری ساخته شدند', async () => {
      const q = await admin.query(`select relname, relrowsecurity r, relforcerowsecurity f from pg_class
                                    where relname in ('product_ops','gateway_quota') order by relname`);
      assert(q.rows.length === 2, 'جدول‌ها ساخته نشدند');
      assert(q.rows.every((r) => r.r && r.f), 'RLS اجباری نیست');
      const pol = await admin.query(`select count(*)::int n from pg_policy where polrelid in ('product_ops'::regclass,'gateway_quota'::regclass)`);
      assert(pol.rows[0].n >= 2, 'سیاست مستأجر نیست');
      return `statements=${mig.statements} tables=2`;
    });
  } finally {
    for (const c of children) { try { c.kill('SIGKILL'); } catch (e) { /* noop */ } }
    try { await admin.end(); } catch (e) { /* noop */ }
    try { await tenancy.close(); } catch (e) { /* noop */ }
  }

  console.log('\n' + passed + ' موفق · ' + failed + ' ناموفق');
  if (failed) { console.log('شکست‌ها:\n - ' + failures.join('\n - ')); process.exit(1); }
  fs.rmSync(path.join(os.tmpdir(), 'payesh-gw-none'), { force: true });
})().catch((e) => { console.error('GATEWAY-ERROR', e); process.exit(2); });
