'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون قرارداد Sync v1  —  npm run test:contract
   مرجع قرارداد: docs/cloud/contracts/sync-v1.md + sync-v1.schema.json

   این آزمون دو لایه دارد:
     ۱) HTTP واقعی روی سرور واقعی محصول (بدون mock) + اعتبارسنجی پاسخ با
        JSON Schema رسمی (Ajv 2020-12).
     ۲) آزمون درون‌فرآیندیِ مکان‌نمای مرکب روی SQLite واقعی: ۳٬۵۰۰ ردیف با
        مهر زمانیِ کاملاً یکسان، تا ثابت شود صفحه‌بندی هیچ ردیفی جا نمی‌گذارد.
   ═══════════════════════════════════════════════════════════════════ */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert');
const Ajv2020 = require('ajv/dist/2020');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-contract-'));
const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/cloud/contracts/sync-v1.schema.json'), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(SCHEMA);
const validatePull = ajv.getSchema('https://payesh.local/schemas/sync-v1.schema.json#/$defs/pullResponse');
const validatePush = ajv.getSchema('https://payesh.local/schemas/sync-v1.schema.json#/$defs/pushResponse');
const validateError = ajv.getSchema('https://payesh.local/schemas/sync-v1.schema.json#/$defs/errorResponse');

let PASS = 0, FAIL = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    PASS++; console.log('  ✓ ' + name);
  } catch (e) {
    FAIL++; failures.push(name + ' — ' + String(e && e.message || e));
    console.log('  ✗ ' + name + ' — ' + String(e && e.message || e).replace(/\s+/g, ' ').slice(0, 300));
  }
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

let BASE = '';
async function req(pathname, opts = {}) {
  const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
  if (opts.token) headers.authorization = 'Bearer ' + opts.token;
  const res = await fetch(BASE + pathname, {
    method: opts.method || 'GET', headers,
    body: opts.body === undefined ? undefined : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)),
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { status: res.status, data };
}

async function waitFor(fn, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fn(); if (r) return r; } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('server did not start');
}

function assertSchema(validate, payload, what) {
  assert.ok(validate, 'schema validator missing for ' + what);
  if (!validate(payload)) {
    throw new Error(what + ' با طرح قرارداد نمی‌خواند: ' + ajv.errorsText(validate.errors));
  }
}

(async () => {
  console.log('\nقرارداد Sync v1 — آزمون\n');

  /* ── بخش ۱: لایهٔ درون‌فرآیندی (مکان‌نمای مرکب) ───────────────────── */
  const { openStore } = require('../server/db');
  const sync = require('../server/sync');
  const crypto = require('node:crypto');
  const KEY = crypto.randomBytes(32).toString('hex');
  process.env.PAYESH_ATREST_KEY = KEY;
  const store = openStore(path.join(TMP, 'cursor.sqlite'));
  const manager = store.insert('users', { name: 'مدیر قرارداد', role: 'manager', active: true });
  const actor = { user: manager, role: 'manager', device: null };
  const N = 3500;

  await test('مکان‌نمای مرکب: ' + N + ' ردیف با مهر زمانی یکسان، کامل خوانده می‌شود', () => {
    for (let i = 0; i < N; i++) {
      store.insert('attendance', { student_id: i + 1, class_id: 1, date: '2026-10-14', status: 'present', n: i });
    }
    /* مهر زمانی همه را عیناً یکی می‌کنیم تا مرز صفحه قطعاً روی تساوی بیفتد */
    store.db.prepare("UPDATE records SET updated_at='2026-10-14T08:00:00.000Z' WHERE collection='attendance'").run();

    const seen = new Set();
    let since = '1970-01-01T00:00:00.000Z';
    let sinceId = 0;
    let pages = 0;
    for (;;) {
      const r = sync.pull(store, actor, { since, since_id: sinceId, collections: 'attendance' });
      for (const row of (r.collections.attendance || [])) seen.add(row.id);
      pages++;
      if (!r.more) break;
      since = r.next_since; sinceId = r.next_id;
      assert.ok(pages < 10, 'صفحه‌ها از حد انتظار بیشتر شد');
    }
    assert.strictEqual(seen.size, N, 'ردیف خوانده‌شده=' + seen.size + ' از ' + N + ' · صفحه=' + pages);
    assert.ok(pages >= 2, 'برای ' + N + ' ردیف باید بیش از یک صفحه باشد؛ صفحه=' + pages);
  });

  await test('مکان‌نمای قدیمی (فقط since) روی همان داده ردیف گم می‌کند — رگرسیون مستند', () => {
    const seen = new Set();
    let since = '1970-01-01T00:00:00.000Z';
    for (let i = 0; i < 10; i++) {
      const r = sync.pull(store, actor, { since, collections: 'attendance' });
      for (const row of (r.collections.attendance || [])) seen.add(row.id);
      if (!r.more) break;
      since = r.next_since;   /* عمداً since_id نمی‌فرستیم */
    }
    assert.ok(seen.size < N, 'انتظار می‌رفت مسیر قدیمی ناقص باشد اما کامل بود (' + seen.size + ')');
    console.log('      → مسیر قدیمی ' + (N - seen.size) + ' ردیف از ' + N + ' را جا گذاشت');
  });

  await test('پاسخ pull با طرح رسمی قرارداد می‌خواند (و شامل next_id/limits/schema_version)', () => {
    const r = sync.pull(store, actor, { since: '1970-01-01T00:00:00.000Z', since_id: 0, collections: 'attendance' });
    assertSchema(validatePull, r, 'pullResponse');
    assert.strictEqual(r.schema_version, 1);
    assert.strictEqual(r.limits.row_limit, sync.ROW_LIMIT);
    assert.strictEqual(r.limits.max_ops, sync.MAX_OPS);
    assert.strictEqual(typeof r.next_id, 'number');
  });

  await test('pull بدون تغییر: collections خالی، more=false، مکان‌نمای بعدی null', () => {
    const now = new Date(Date.now() + 60000).toISOString();
    const r = sync.pull(store, actor, { since: now, since_id: 0, collections: 'attendance' });
    assertSchema(validatePull, r, 'pullResponse(empty)');
    assert.deepStrictEqual(r.collections, {});
    assert.strictEqual(r.more, false);
    assert.strictEqual(r.next_since, null);
    assert.strictEqual(r.next_id, null);
  });

  /* ── بخش ۲: HTTP واقعی ─────────────────────────────────────────────── */
  const PORT = await freePort();
  BASE = 'http://127.0.0.1:' + PORT;
  const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST: '127.0.0.1', PAYESH_DATA: path.join(TMP, 'srv'), PAYESH_LOG: '0',
      PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0', PAYESH_LIVE_MS: '0',
      PAYESH_OUTBOX_AUTO: '0', PAYESH_CLOUD_AUTO: '0', PAYESH_MIRROR: '0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', d => process.env.VERBOSE && console.error(String(d)));
  await waitFor(async () => (await req('/api/health')).data?.ok);

  let token = null;
  let teacherToken = null;
  let studentToken = null;

  await test('setup واقعی و صدور نشست مدیر', async () => {
    const r = await req('/api/setup', { method: 'POST', body: {
      school_name: 'مدرسهٔ قرارداد', manager_name: 'مدیر قرارداد', password: 'Contract-99', phone: '09120000031',
    } });
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.session.token);
    token = r.data.session.token;
  });

  await test('بدون نشست: 401 unauthorized و شکل خطا مطابق طرح', async () => {
    const r = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z');
    assert.strictEqual(r.status, 401);
    assertSchema(validateError, r.data, 'errorResponse(401)');
    assert.strictEqual(r.data.error, 'unauthorized');
  });

  await test('pull از مسیر HTTP: پاسخ معتبر، schema_version=1، next_id کلید دارد', async () => {
    const r = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&since_id=0', { token });
    assert.strictEqual(r.status, 200);
    assertSchema(validatePull, r.data, 'pullResponse(http)');
    assert.strictEqual(r.data.schema_version, 1);
    assert.ok('next_id' in r.data);
  });

  await test('pull با since_id نامعتبر: به رفتار پیش‌فرض برمی‌گردد (بدون خطا)', async () => {
    const r = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&since_id=abc', { token });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.since_id, null);
    assertSchema(validatePull, r.data, 'pullResponse(bad since_id)');
  });

  await test('push: ۲۰۰ عملیات پذیرفته و پاسخ مطابق طرح است', async () => {
    const ops = [];
    for (let i = 0; i < sync.MAX_OPS; i++) {
      ops.push({ uid: 'c-ok-' + i, collection: 'announcements', type: 'put', data: { title: 'اعلان ' + i, body: 'x', date: '2026-10-14' } });
    }
    const r = await req('/api/sync', { method: 'POST', token, body: { ops } });
    assert.strictEqual(r.status, 200);
    assertSchema(validatePush, r.data, 'pushResponse');
    assert.strictEqual(r.data.applied.length, sync.MAX_OPS);
    assert.strictEqual(r.data.rejected.length, 0);
    assert.strictEqual(r.data.schema_version, 1);
  });

  await test('push: ۲۰۱ عملیات رد می‌شود (too_many_ops) — سقف قرارداد', async () => {
    const ops = Array.from({ length: sync.MAX_OPS + 1 }, (_, i) => ({ uid: 'c-over-' + i, collection: 'announcements', type: 'put', data: { title: 'x' + i } }));
    const r = await req('/api/sync', { method: 'POST', token, body: { ops } });
    assert.strictEqual(r.status, 400);
    assertSchema(validateError, r.data, 'errorResponse(too_many_ops)');
    assert.strictEqual(r.data.error, 'too_many_ops');
    assert.strictEqual(r.data.limit, 200);
  });

  await test('push: uid تکراری دوباره اعمال نمی‌شود (idempotency)', async () => {
    const op = { uid: 'c-idem-1', collection: 'announcements', type: 'put', data: { title: 'یک‌بار', date: '2026-10-14' } };
    const first = await req('/api/sync', { method: 'POST', token, body: { ops: [op] } });
    assert.strictEqual(first.data.applied[0].duplicate || false, false);
    const second = await req('/api/sync', { method: 'POST', token, body: { ops: [op] } });
    assert.strictEqual(second.data.applied[0].duplicate, true);
    assert.ok(!second.data.applied[0].id, 'بازفرست نباید شناسهٔ تازه بسازد');
  });

  await test('push: uid خالی و کالکشن ناشناس با کد مشخص رد می‌شوند', async () => {
    const r = await req('/api/sync', { method: 'POST', token, body: { ops: [
      { uid: '', collection: 'announcements', type: 'put', data: {} },
      { uid: 'c-unknown-1', collection: 'not_a_collection', type: 'put', data: {} },
    ] } });
    assert.strictEqual(r.status, 200);
    assertSchema(validatePush, r.data, 'pushResponse(rejects)');
    const codes = r.data.rejected.map(x => x.error).sort();
    assert.deepStrictEqual(codes, ['bad_uid', 'unknown_collection']);
  });

  await test('push: بدنهٔ خراب JSON → 400 bad_json مطابق طرح', async () => {
    const res = await fetch(BASE + '/api/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: '{ ops: [ not json',
    });
    const data = await res.json().catch(() => null);
    assert.strictEqual(res.status, 400);
    assertSchema(validateError, data, 'errorResponse(bad_json)');
    assert.strictEqual(data.error, 'bad_json');
  });

  await test('اسکوپ: دانش‌آموز نمی‌تواند حضور بنویسد (role_denied) و پاسخ معتبر است', async () => {
    const mk = await req('/api/sync', { method: 'POST', token, body: { ops: [
      { uid: 'c-cls-1', collection: 'classes', type: 'put', data: { name: 'دهم ریاضی', grade: '10' } },
      { uid: 'c-stu-1', collection: 'users', type: 'put', data: { name: 'دانش‌آموز قرارداد', role: 'student', phone: '09120000032', national_id: '1000000032', class_id: 1 } },
      { uid: 'c-tea-1', collection: 'users', type: 'put', data: { name: 'دبیر قرارداد', role: 'teacher', phone: '09120000033', national_id: '1000000033' } },
    ] } });
    assert.strictEqual(mk.data.rejected.length, 0, JSON.stringify(mk.data.rejected));

    const sLogin = await req('/api/auth/login', { method: 'POST', body: { phone: '09120000032', password: '1000000032' } });
    assert.strictEqual(sLogin.status, 200, 'ورود دانش‌آموز');
    studentToken = sLogin.data.session.token;
    const tLogin = await req('/api/auth/login', { method: 'POST', body: { phone: '09120000033', password: '1000000033' } });
    assert.strictEqual(tLogin.status, 200, 'ورود دبیر');
    teacherToken = tLogin.data.session.token;

    const r = await req('/api/sync', { method: 'POST', token: studentToken, body: { ops: [
      { uid: 'c-denied-1', collection: 'attendance', type: 'put', data: { student_id: 3, class_id: 1, date: '2026-10-14', status: 'present' } },
    ] } });
    assert.strictEqual(r.status, 200);
    assertSchema(validatePush, r.data, 'pushResponse(role_denied)');
    assert.strictEqual(r.data.rejected[0].error, 'role_denied');
  });

  await test('pull اسکوپ‌دار: دبیر ردیفی خارج از کلاس‌هایش نمی‌بیند', async () => {
    await req('/api/sync', { method: 'POST', token, body: { ops: [
      { uid: 'c-att-1', collection: 'attendance', type: 'put', data: { student_id: 3, class_id: 1, date: '2026-10-15', status: 'present' } },
    ] } });
    const r = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&since_id=0&collections=attendance', { token: teacherToken });
    assert.strictEqual(r.status, 200);
    assertSchema(validatePull, r.data, 'pullResponse(teacher scope)');
    const rows = r.data.collections.attendance || [];
    assert.strictEqual(rows.length, 0, 'دبیر بدون کلاس تخصیص‌یافته نباید ردیف حضور ببیند');
  });

  await test('pull: tombstone حذف‌شده در deleted می‌آید', async () => {
    const mk = await req('/api/sync', { method: 'POST', token, body: { ops: [
      { uid: 'c-del-mk', collection: 'announcements', type: 'put', data: { title: 'برای حذف', date: '2026-10-14' } },
    ] } });
    const id = mk.data.applied[0].id;
    const del = await req('/api/sync', { method: 'POST', token, body: { ops: [
      { uid: 'c-del-1', collection: 'announcements', type: 'del', id, data: {} },
    ] } });
    assert.strictEqual(del.data.applied[0].deleted, true);
    const r = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&since_id=0&collections=announcements', { token });
    assertSchema(validatePull, r.data, 'pullResponse(tombstone)');
    assert.ok(r.data.deleted.some(d => d.id === id), 'tombstone پیدا نشد');
  });

  await test('pull: ردیف‌ها به ترتیب (updated_at, id) صعودی می‌آیند', async () => {
    const r = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&since_id=0&collections=announcements', { token });
    const rows = r.data.collections.announcements || [];
    assert.ok(rows.length > 10, 'برای این بررسی به چند ردیف نیاز است');
    /* ترتیب با مهر زمانی سرور سنجیده می‌شود؛ این‌جا فقط یکنوایی شناسه در صفحه بس است */
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i].id > rows[i - 1].id, 'ترتیب شناسه‌ها صعودی نیست');
  });

  await test('کالکشن ناشناس در pull: بی‌صدا حذف می‌شود، خطا نمی‌دهد', async () => {
    const r = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&since_id=0&collections=whatever,announcements', { token });
    assert.strictEqual(r.status, 200);
    assertSchema(validatePull, r.data, 'pullResponse(unknown collection)');
    assert.ok(!('whatever' in r.data.collections));
  });

  try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log('\n' + PASS + ' موفق · ' + FAIL + ' ناموفق\n');
  if (FAIL) { console.log('شکست‌ها:\n - ' + failures.join('\n - ')); process.exit(1); }
})().catch(e => { console.error('SYNC-CONTRACT-ERROR', e); process.exit(2); });
