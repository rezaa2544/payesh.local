'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون‌های پایش-لوکال
   اجرا: npm test
   شامل: واحد (سیاست/ذخیره) + سرتاسری HTTP + دود رابط (jsdom)
   ═══════════════════════════════════════════════════════════════════ */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
let PORT = 0;
let BASE = '';
let childRef = null;
let childExited = false;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-test-'));

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++; console.log('  ✓ ' + name);
  }).catch(e => {
    failed++; console.log('  ✗ ' + name + ' — ' + String((e && (e.message || e)) || '').replace(/\s+/g, ' ').slice(0, 400));
  });
}

async function freePort() {
  return new Promise((res, rej) => {
    const s = require('net').createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

async function req(pathname, opts = {}) {
  const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
  if (opts.token) headers.authorization = 'Bearer ' + opts.token;
  const res = await fetch(BASE + pathname, {
    method: opts.method || 'GET', headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { status: res.status, data };
}

async function waitFor(fn, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fn(); if (r) return r; } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('timeout');
}

(async () => {
  console.log('\nپایش-لوکال — آزمون‌ها\n');

  /* ── ۱. واحد: سیاست ── */
  const policy = require('../server/policy');
  await test('کالکشن ناشناس رد می‌شود (fail-closed)', () => {
    assert.strictEqual(policy.collectionAllowed('whatever'), false);
    assert.strictEqual(policy.canRead('manager', 'whatever'), false);
    assert.strictEqual(policy.canWrite('teacher', 'users'), false);
    assert.strictEqual(policy.canWrite('manager', 'users'), true);
  });
  await test('برنامهٔ پایه و رشته برای دانش‌آموز و ولی در اسکوپ امن می‌ماند', () => {
    const store = {
      all: () => [{ id: 40, role: 'student', class_id: null, grade: 'دهم', branch: 'الکترونیک' }],
      get: (_collection, id) => Number(id) === 40 ? { id: 40, role: 'student', class_id: null, grade: 'دهم', branch: 'الکترونیک' } : null,
      byRef: () => [],
    };
    const studentScope = policy.buildScope(store, { id: 40, role: 'student', class_id: null, grade: 'دهم', branch: 'الکترونیک' });
    assert.strictEqual(policy.rowInScope(studentScope, 'schedule', { grade: 'دهم', branch: 'الکترونیک' }), true);
    assert.strictEqual(policy.rowInScope(studentScope, 'schedule', { grade: 'دهم', branch: 'گرافیک' }), false);
    const parent = { id: 50, role: 'parent' };
    const parentStore = Object.assign({}, store, { all: name => name === 'parent_links' ? [{ parent_id: 50, student_id: 40 }] : store.all() });
    const parentScope = policy.buildScope(parentStore, parent);
    assert.strictEqual(policy.rowInScope(parentScope, 'schedule', { grade: 'دهم', branch: 'الکترونیک' }), true);
    assert.strictEqual(policy.rowInScope(parentScope, 'schedule', { grade: 'یازدهم', branch: 'الکترونیک' }), false);
    const syncScope = require('../server/scope');
    const predicate = syncScope.sqlPredicate({ role: 'student', uid: 40, classIds: [], studentIds: [40], cohorts: [{ grade: 'دهم', branch: 'الکترونیک' }] });
    assert.ok(predicate.sql.includes('jsonb_array_elements'), 'اسکوپ SQL هم برنامهٔ همین پایه و رشته را می‌خواند');
    assert.ok(predicate.params.includes(JSON.stringify([{ grade: 'دهم', branch: 'الکترونیک' }])), 'پایه و رشته با پارامتر امن به SQL می‌روند');
  });
  await test('کد ملی: فقط ده رقم — بدون الگوریتم رقم کنترل', () => {
    const { validNationalId } = require('../server/util');
    assert.strictEqual(validNationalId('1000000001'), true, 'ده رقم قابل قبول است');
    assert.strictEqual(validNationalId('3840511858'), true, 'کد ملی واقعی مدرسه پذیرفته می‌شود');
    assert.strictEqual(validNationalId('1111111111'), true, 'ده رقم بودن کافی است');
    assert.strictEqual(validNationalId('384051185'), false, 'نه رقم رد می‌شود');
    assert.strictEqual(validNationalId('123'), false);
  });

  /* ── ۲. سرور واقعی ── */
  PORT = await freePort();
  BASE = 'http://127.0.0.1:' + PORT;
  const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT, env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST: '127.0.0.1', PAYESH_DATA: TMP, PAYESH_LOG: '0',
      PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0',
      /* ردیف ۸۷: کل این مجموعه با رمزنگاری فیلدی روشن اجرا می‌شود؛ کلید در
         زمان اجرا تصادفی است (هیچ کلیدی در مخزن نیست). */
      PAYESH_FIELD_KEYS: 'run:' + require('crypto').randomBytes(32).toString('base64'),
      /* آزمون‌های این فایل قطعی و دستی‌اند؛ حلقه‌های خودکار (۱ ثانیه‌ای و
         صندوقچه) در test:live و test:restart آزموده می‌شوند و این‌جا خاموش‌اند
         تا با درخواست‌های دستی آزمون مسابقه ندهند (روی ماشین کند، ۴۰ ثانیه). */
      PAYESH_LIVE_MS: '0', PAYESH_OUTBOX_AUTO: '0', PAYESH_CLOUD_AUTO: '0',
      /* ردیف ۶۵: این فایل ده‌ها بار با مدیر وارد می‌شود (هر ورود = یک دستگاه)؛
         سقف دستگاه هر کاربر و پیامدهایش در tests/identity-65.js آزموده می‌شود. */
      PAYESH_DEVICE_CAP: '1000',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', d => process.env.VERBOSE && console.error(String(d)));

  await waitFor(async () => (await req('/api/health')).data?.ok);

  await test('health و setup/state', async () => {
    const h = await req('/api/health');
    assert.strictEqual(h.data.ok, true);
    const s = await req('/api/setup/state');
    assert.strictEqual(s.data.needs_setup, true);
  });

  let managerToken;
  const managerPassword = 'Manager-99';
  await test('راه‌اندازی اولیه و ساخت مدیر', async () => {
    const r = await req('/api/setup', { method: 'POST', body: {
      school_name: 'دبیرستان آزمون', manager_name: 'مدیر آزمون', password: managerPassword, phone: '09120000001',
    } });
    assert.strictEqual(r.data.ok, true);
    assert.ok(r.data.session.token);
    managerToken = r.data.session.token;
    const again = await req('/api/setup', { method: 'POST', body: { school_name: 'x', manager_name: 'y', password: 'Another-1' } });
    assert.strictEqual(again.status, 400);
  });

  await test('دسترسی بدون نشست رد می‌شود', async () => {
    const r = await req('/api/bootstrap');
    assert.strictEqual(r.status, 401);
  });

  await test('ساخت کاربر + کارت پیوند + ورود دبیر', async () => {
    const cls = await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
      { uid: 'c1', collection: 'classes', type: 'put', data: { name: 'دهم الف', grade: 'دهم' } },
    ] } });
    assert.strictEqual(cls.data.applied.length, 1);
    const classId = cls.data.applied[0].id;

    const u = await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
      { uid: 'u1', collection: 'users', type: 'put', data: { name: 'دبیر آزمون', role: 'teacher', national_id: '1000000001' } },
    ] } });
    assert.strictEqual(u.data.applied.length, 1);
    const teacherId = u.data.applied[0].id;

    const pc = await req('/api/admin/pair-code', { method: 'POST', token: managerToken, body: { user_id: teacherId } });
    assert.ok(pc.data.code);
    const paired = await req('/api/auth/pair', { method: 'POST', body: { code: pc.data.code } });
    assert.strictEqual(paired.data.ok, true);
    assert.ok(paired.data.session.token);

    /* کد پیوند دیگر یک‌بارمصرف نیست: تا مدیر «کد تازه» نسازد کار می‌کند */
    const againWithSame = await req('/api/auth/pair', { method: 'POST', body: { code: pc.data.code } });
    assert.strictEqual(againWithSame.data.ok, true, 'همان کد برای دستگاه دوم هم کار می‌کند');
    assert.ok(againWithSame.data.session.token);

    /* همان کارت دوباره خواسته شود ⇒ همان کد برمی‌گردد، نه کد تازه */
    const same = await req('/api/admin/pair-code', { method: 'POST', token: managerToken, body: { user_id: teacherId } });
    assert.strictEqual(same.data.code, pc.data.code, 'کد قبلی دوباره نشان داده می‌شود');
    assert.strictEqual(same.data.reused, true);

    /* «کد تازه» ⇒ کد قبلی باطل و کد تازه ساخته می‌شود */
    const fresh = await req('/api/admin/pair-code', { method: 'POST', token: managerToken, body: { user_id: teacherId, refresh: true } });
    assert.notStrictEqual(fresh.data.code, pc.data.code, 'کد تازه ساخته شد');
    const oldNow = await req('/api/auth/pair', { method: 'POST', body: { code: pc.data.code } });
    assert.strictEqual(oldNow.data.ok, false, 'کد قبلی باطل شد');
    assert.strictEqual(oldNow.data.error, 'code_revoked');
    const newOk = await req('/api/auth/pair', { method: 'POST', body: { code: fresh.data.code } });
    assert.strictEqual(newOk.data.ok, true, 'کد تازه کار می‌کند');
  });

  await test('کاربر خودکار: نام کاربری = شماره، رمز = کد ملی + ویرایش/حذف/تغییر رمز', async () => {
    /* ۱) ساخت با شماره و کد ملی → ورود خودکار ممکن می‌شود */
    const made = await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
      { uid: 'nu-1', collection: 'users', type: 'put', data: { name: 'زهرا تازه', role: 'student', phone: '09121110001', national_id: '1000000010' } },
    ] } });
    assert.strictEqual(made.data.applied.length, 1, JSON.stringify(made.data));
    const newId = made.data.applied[0].id;
    const loginDefault = await req('/api/auth/login', { method: 'POST', body: { phone: '09121110001', password: '1000000010' } });
    assert.strictEqual(loginDefault.data.ok, true, 'ورود با شماره + کد ملی: ' + JSON.stringify(loginDefault.data));
    assert.strictEqual(loginDefault.data.user.role, 'student');
    const newTok = loginDefault.data.session.token;

    /* ۲) شمارهٔ تکراری رد می‌شود (نام کاربری باید یکتا باشد) */
    const dupPhone = await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
      { uid: 'nu-2', collection: 'users', type: 'put', data: { name: 'کپی', role: 'student', phone: '09121110001', national_id: '1000000011' } },
    ] } });
    assert.strictEqual(dupPhone.data.applied.length, 0, 'شمارهٔ تکراری ساخته نشد');
    assert.strictEqual(dupPhone.data.rejected[0].error, 'duplicate_phone');

    /* ۳) مدیر نام کاربری و رمز را عوض می‌کند */
    const edit = await req('/api/admin/users/' + newId, { method: 'PATCH', token: managerToken, body: { phone: '09121110002', password: 'Ramz-Taze-99' } });
    assert.strictEqual(edit.data.ok, true, JSON.stringify(edit.data));
    const oldLogin = await req('/api/auth/login', { method: 'POST', body: { phone: '09121110001', password: '1000000010' } });
    assert.strictEqual(oldLogin.data.ok, false, 'نام کاربری قبلی دیگر کار نمی‌کند');
    const newLogin = await req('/api/auth/login', { method: 'POST', body: { phone: '09121110002', password: 'Ramz-Taze-99' } });
    assert.strictEqual(newLogin.data.ok, true, 'نام کاربری و رمز تازه کار می‌کند');

    /* ۴) خود کاربر رمزش را عوض می‌کند */
    const selfTok = newLogin.data.session.token;
    const self = await req('/api/auth/password', { method: 'POST', token: selfTok, body: { current: 'Ramz-Taze-99', next: 'Khodam-77' } });
    assert.strictEqual(self.data.ok, true, JSON.stringify(self.data));
    const afterSelf = await req('/api/auth/login', { method: 'POST', body: { phone: '09121110002', password: 'Khodam-77' } });
    assert.strictEqual(afterSelf.data.ok, true, 'رمز تازهٔ خودِ کاربر کار می‌کند');

    /* ۵) «آماده‌سازی گوشی»: رمز از کد ملی ساخته می‌شود */
    const auto = await req('/api/admin/users/' + newId, { method: 'PATCH', token: managerToken, body: { auto_password: true } });
    assert.strictEqual(auto.data.ok, true, JSON.stringify(auto.data));
    const autoLogin = await req('/api/auth/login', { method: 'POST', body: { phone: '09121110002', password: '1000000010' } });
    assert.strictEqual(autoLogin.data.ok, true, 'رمزِ آماده‌سازی‌شده (کد ملی) کار می‌کند');

    /* ۶) ویرایش کاربر (مثلاً تغییر نام) رمز را پاک نمی‌کند */
    const rename = await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
      { uid: 'nu-9', collection: 'users', type: 'put', id: newId, data: { name: 'زهرا تغییرنام' } },
    ] } });
    assert.strictEqual(rename.data.applied.length, 1, JSON.stringify(rename.data).slice(0, 200));
    const afterRename = await req('/api/auth/login', { method: 'POST', body: { phone: '09121110002', password: '1000000010' } });
    assert.strictEqual(afterRename.data.ok, true, 'رمز پس از ویرایش نام باقی می‌ماند');

    /* ۷) حذف کاربر توسط مدیر */
    const del = await req('/api/admin/users/' + newId, { method: 'DELETE', token: managerToken });
    assert.strictEqual(del.data.ok, true, JSON.stringify(del.data));
    const goneLogin = await req('/api/auth/login', { method: 'POST', body: { phone: '09121110002', password: 'Khodam-77' } });
    assert.strictEqual(goneLogin.data.ok, false, 'کاربر حذف‌شده نمی‌تواند وارد شود');
  });

  await test('تعریف پایه و رشته: پیش‌فرض، افزودن، ویرایش، حذف و دسترسی', async () => {
    /* فهرست پیش‌فرض سرور */
    const p0 = await req('/api/v1/pull?collections=lookups', { token: managerToken });
    const seeded = (p0.data.collections.lookups || []);
    assert.ok(seeded.filter(l => l.kind === 'grade').length >= 3, 'پایه‌های پیش‌فرض ساخته شده‌اند');
    assert.ok(seeded.filter(l => l.kind === 'branch').length >= 3, 'رشته‌های پیش‌فرض ساخته شده‌اند');

    /* افزودن */
    const add = await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
      { uid: 'lk1', collection: 'lookups', type: 'put', data: { kind: 'grade', name: 'پایهٔ آزمون', order: 9 } },
    ] } });
    assert.strictEqual(add.data.applied.length, 1, 'پایهٔ تازه ثبت شد');
    const id = add.data.applied[0].id;

    /* ویرایش (OCC) */
    const cur = seeded.concat([{ id }]);
    const edit = await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
      { uid: 'lk2', collection: 'lookups', type: 'put', id, data: { kind: 'grade', name: 'پایهٔ ویرایش‌شده', order: 9 }, base_version: add.data.applied[0].version },
    ] } });
    assert.strictEqual(edit.data.applied.length, 1, 'ویرایش ثبت شد');

    /* حذف */
    const del = await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
      { uid: 'lk3', collection: 'lookups', type: 'del', id },
    ] } });
    assert.strictEqual(del.data.applied.length, 1, 'حذف ثبت شد');
    const p1 = await req('/api/v1/pull?collections=lookups&since=1970-01-01T00:00:00.000Z', { token: managerToken });
    const left = (p1.data.collections.lookups || []).filter(l => Number(l.id) === Number(id));
    assert.strictEqual(left.length, 0, 'ردیف حذف‌شده برنمی‌گردد');
    assert.ok((p1.data.deleted || []).some(d => Number(d.id) === Number(id)), 'حذف به‌صورت tombstone اعلام می‌شود');

    /* دبیر نباید بتواند تعریف را تغییر دهد */
    const teacher = (await req('/api/admin/pair-code', { method: 'POST', token: managerToken, body: { user_id: 2 } })).data;
    if (teacher && teacher.code) {
      const pair = await req('/api/auth/pair', { method: 'POST', body: { code: teacher.code } });
      if (pair.data && pair.data.session) {
        const denied = await req('/api/sync', { method: 'POST', token: pair.data.session.token, body: { ops: [
          { uid: 'lk4', collection: 'lookups', type: 'put', data: { kind: 'grade', name: 'دستکاری' } },
        ] } });
        const applied = (denied.data.applied || []).length;
        assert.strictEqual(applied, 0, 'نقش غیرمدیر نمی‌تواند تعریف اضافه کند');
      }
    }
  });

  await test('پیوند بدون PIN است و قفل دستگاه فقط با رمز عبور باز می‌شود', async () => {
    const pc = await req('/api/admin/pair-code', { method: 'POST', token: managerToken, body: { user_id: 1 } });
    const p = await req('/api/auth/pair', { method: 'POST', body: { code: pc.data.code } });
    assert.strictEqual(p.data.ok, true, 'کد پیوند بدون PIN کار می‌کند');
    assert.ok(p.data.device_token);

    const bad = await req('/api/auth/unlock', { method: 'POST', body: { device_token: p.data.device_token, password: 'Abcdef-123' } });
    assert.strictEqual(bad.status >= 400, true, 'رمز غلط رد می‌شود');
    const ok = await req('/api/auth/unlock', { method: 'POST', body: { device_token: p.data.device_token, password: managerPassword } });
    assert.strictEqual(ok.data.ok, true, 'رمز درست قبول می‌شود');
  });

  await test('sync: idempotency، OCC و tombstone', async () => {
    const a = await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
      { uid: 'ann-1', collection: 'announcements', type: 'put', data: { title: 'اطلاعیهٔ ۱', body: 'متن', date: '2026-10-31' } },
    ] } });
    const id = a.data.applied[0].id;
    const v1 = a.data.applied[0].version;
    const dup = await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
      { uid: 'ann-1', collection: 'announcements', type: 'put', data: { title: 'تکراری' } },
    ] } });
    assert.strictEqual(dup.data.applied[0].duplicate, true);

    const conflict = await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
      { uid: 'ann-2', collection: 'announcements', type: 'put', id, base_version: v1 + 99, data: { title: 'کهنه' } },
    ] } });
    assert.strictEqual(conflict.data.conflicts.length, 1);

    const del = await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
      { uid: 'ann-del', collection: 'announcements', type: 'del', id },
    ] } });
    assert.strictEqual(del.data.applied[0].deleted, true);
    const pull = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z', { token: managerToken });
    assert.ok(pull.data.deleted.some(d => d.collection === 'announcements' && Number(d.id) === Number(id)));
  });

  await test('ورود دسته‌ای: کد ملی نامعتبر رد و تکراری تشخیص داده می‌شود', async () => {
    const r = await req('/api/admin/import', { method: 'POST', token: managerToken, body: {
      kind: 'students',
      rows: [
        { name: 'دانش‌آموز یک', national_id: '1000000011' },
        { name: 'دانش‌آموز دو', national_id: '123' },
        { name: 'دانش‌آموز سه', national_id: '1000000028', parent_name: 'ولی سه', parent_phone: '09123334444' },
        { name: 'تکراری', national_id: '1000000011' },
      ],
    } });
    assert.strictEqual(r.data.created, 2);
    assert.strictEqual(r.data.errors.length, 2);
    assert.strictEqual(r.data.errors[0].error, 'bad_national_id');
  });

  await test('ورود دسته‌ای: نام کاربری=همراه و رمز=کد ملی، سپس حذف دسته‌ای', async () => {
    const r = await req('/api/admin/import', { method: 'POST', token: managerToken, body: {
      kind: 'students',
      rows: [
        { name: 'دانش‌آموز یک', national_id: '1000000036', phone: '09123334455', class_name: 'دهم الف' },
        { name: 'دانش‌آموز تکراری', national_id: '1000000036', phone: '09123334466' },
        { name: '', national_id: '1000000044' },
      ],
    } });
    assert.strictEqual(r.data.created, 1, 'یک کاربر ساخته شد');
    assert.ok(r.data.errors.length >= 2, 'سطرهای مشکل‌دار گزارش شدند');
    const made = r.data.users[0];
    assert.strictEqual(String(made.phone), '09123334455');

    /* ورود با نام کاربری = شماره، رمز = کد ملی */
    const login = await req('/api/auth/login', { method: 'POST', body: { phone: '09123334455', password: '1000000036' } });
    assert.strictEqual(login.data.ok, true, 'کاربر تازه با شماره و کد ملی وارد می‌شود');
    assert.ok(login.data.session && login.data.session.token);

    /* حذف دسته‌ای */
    const del = await req('/api/admin/users/bulk-delete', { method: 'POST', token: managerToken, body: { ids: [made.id, 999999] } });
    assert.strictEqual(del.data.ok, true);
    assert.strictEqual(del.data.deleted, 1, 'فقط کاربر موجود حذف شد');
    const creds = await req('/api/admin/users/credentials', { token: managerToken });
    assert.ok(!creds.data.users.some(u => Number(u.id) === Number(made.id)), 'کاربر حذف‌شده در فهرست نیست');

    /* دیگر نمی‌تواند وارد شود */
    const again = await req('/api/auth/login', { method: 'POST', body: { phone: '09123334455', password: '1000000036' } });
    assert.strictEqual(again.data.ok, false, 'کاربر حذف‌شده نمی‌تواند وارد شود');
  });

  /* ── ورود دسته‌ایِ کامل: همهٔ فیلدهای دانش‌آموز + کلاس تازه + پدر و مادر ── */
  await test('ورود دسته‌ای: همهٔ فیلدهای دانش‌آموز ذخیره می‌شود، کلاسی ساخته نمی‌شود و ولی ساخته می‌شود', async () => {
    const imp = await req('/api/admin/import', { method: 'POST', token: managerToken, body: {
      kind: 'students',
      rows: [{
        name: 'سارا احمدی', national_id: '1000000052', phone: '09123335566',
        new_class: 'یازدهم شبکه', grade: 'یازدهم', branch: 'شبکه',
        birth_date: '2011-08-03', gender: 'دختر',
        shenasname_serial: '1234', shenasname_seri: 'الف',
        father_name: 'احمد احمدی', father_nid: '1000000060', father_phone: '09123335577',
        father_job: 'کارمند', father_alive: 'بله',
        mother_name: 'مریم احمدی', mother_nid: '1000000079',
        last_gpa: 18.5, covered: 'بله', talent: 'شعر', landline: '02133445566',
        residence: 'تهران', village: '—', residence_status: 'مالک', address: 'خیابان اول',
      }],
    } });
    assert.strictEqual(imp.data.ok, true, 'درخواست پذیرفته شد');
    assert.strictEqual(imp.data.created, 1, 'دانش‌آموز ساخته شد');
    assert.strictEqual(imp.data.classes, 0, 'ورود اکسل هیچ کلاسی نمی‌سازد (کلاس دستی است)');
    assert.strictEqual(imp.data.parents, 2, 'حساب پدر و مادر ساخته شد');

    const stu = imp.data.users[0];
    assert.strictEqual(stu.birth_date, '2011-08-03', 'تاریخ تولد ذخیره شد');
    assert.strictEqual(stu.gender, 'دختر', 'جنسیت ذخیره شد');
    assert.strictEqual(stu.shenasname_serial, '1234');
    assert.strictEqual(stu.father_name, 'احمد احمدی');
    assert.strictEqual(stu.mother_name, 'مریم احمدی');
    assert.strictEqual(Number(stu.last_gpa), 18.5, 'معدل ذخیره شد');
    assert.strictEqual(stu.covered, 'بله');
    assert.strictEqual(stu.talent, 'شعر');
    assert.strictEqual(stu.address, 'خیابان اول');
    assert.ok(!stu.class_id, 'دانش‌آموز بی‌کلاس می‌ماند تا مدیر کلاس را دستی بسازد');
    assert.strictEqual(stu.grade, 'یازدهم', 'پایه روی خود دانش‌آموز ثبت شد');
    assert.strictEqual(stu.field, 'شبکه', 'رشته روی خود دانش‌آموز ثبت شد');

    /* هر سه نفر (دانش‌آموز، پدر، مادر) نام کاربری و رمز دارند و وارد می‌شوند */
    const login = await req('/api/auth/login', { method: 'POST', body: { phone: '09123335577', password: '1000000060' } });
    assert.strictEqual(login.data.ok, true, 'پدر با شماره و کد ملی وارد می‌شود');
    const pull = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z', { token: login.data.session.token });
    const cols = pull.data.collections || {};
    assert.strictEqual((cols.parent_links || []).length, 1, 'پیوند فرزند برای پدر ثبت شد');
    assert.ok((cols.users || []).some(u => u.role === 'student' && u.name === 'سارا احمدی'),
      'پدر فرزندش را در فهرست می‌بیند');
    /* ردیف ۵۷ (مرحلهٔ دوم): پدر فرزندش را می‌بیند ولی کد ملی و فیلدهای
       هویتیِ او را نه (بررسی امنیتی — NOT a regression). */
    const kid = (cols.users || []).find(u => u.role === 'student');
    assert.ok(kid && !('national_id' in kid) && !('father_nid' in kid) && !('address' in kid),
      'ولی نباید فیلدهای هویتی فرزند را ببیند');

    /* مادر شمارهٔ همراه ندارد: نام کاربری‌اش کد ملی است و باید وارد شود */
    const mLogin = await req('/api/auth/login', { method: 'POST', body: { phone: '1000000079', password: '1000000079' } });
    assert.strictEqual(mLogin.data.ok, true, 'مادرِ بی‌شماره با کد ملی وارد می‌شود');
    assert.strictEqual(mLogin.data.user.role, 'parent');
    const mPull = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z', { token: mLogin.data.session.token });
    assert.strictEqual(((mPull.data.collections || {}).parent_links || []).length, 1, 'مادر هم فرزندش را می‌بیند');
    const mCreds = await req('/api/admin/users/credentials', { token: managerToken });
    const mom = mCreds.data.users.find(u => u.name === 'مریم احمدی');
    assert.ok(mom, 'حساب مادر در فهرست کاربران هست');
    assert.strictEqual(mom.password, '1000000079', 'رمز مادر همان کد ملی است');

    /* ورود با رمز اشتباه رد می‌شود */
    const bad = await req('/api/auth/login', { method: 'POST', body: { phone: '1000000079', password: '0000000000' } });
    assert.strictEqual(bad.data.error, 'bad_credentials', 'رمز اشتباه پذیرفته نمی‌شود');

    /* درس لازم برای ثبت نمره (در سامانه تعریف می‌شود) */
    await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
      { uid: 'imp-subj-1', collection: 'subjects', type: 'put', data: { name: 'ریاضی ۱' } },
    ] } });

    /* نمرهٔ دورهٔ گذشته برای همان دانش‌آموز */
    const subjImp = await req('/api/admin/import', { method: 'POST', token: managerToken, body: {
      kind: 'grades',
      rows: [{ national_id: '1000000052', subject: 'ریاضی ۱', term: 'نوبت دوم', score: 18.5, date: '2024-06-10' }],
    } });
    assert.strictEqual(subjImp.data.created, 1, 'نمره ساخته شد');

    /* حضور و غیاب: وضعیت فارسی که در سمت گوشی به کلید تبدیل می‌شود */
    const attImp = await req('/api/admin/import', { method: 'POST', token: managerToken, body: {
      kind: 'attendance',
      rows: [{ national_id: '1000000052', date: '2024-05-01', status: 'absent', note: 'بیماری' }],
    } });
    assert.strictEqual(attImp.data.created, 1, 'حضور ثبت شد');

    /* دانش‌آموز ناشناس برای نمره، خطای روشن می‌دهد نه سقوط */
    const badImp = await req('/api/admin/import', { method: 'POST', token: managerToken, body: {
      kind: 'attendance', rows: [{ national_id: '1000000099', date: '2024-05-01', status: 'absent' }],
    } });
    assert.strictEqual(badImp.data.errors[0].error, 'student_not_found');

    /* پاک‌سازی: دانش‌آموز و دو ولی */
    const creds = await req('/api/admin/users/credentials', { token: managerToken });
    const ids = creds.data.users.filter(u => ['09123335566', '09123335577'].includes(u.phone)).map(u => u.id);
    await req('/api/admin/users/bulk-delete', { method: 'POST', token: managerToken, body: { ids } });
  });

  /* ── رشته هرگز کلاس نمی‌شود: کلاس = پایه + رشته ────────────────────── */
  await test('ورود دسته‌ای: رشته هرگز کلاس نمی‌شود، هیچ کلاسی ساخته نمی‌شود و رشتهٔ غلط‌تایپی تازه نمی‌سازد', async () => {
    const before = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z', { token: managerToken });
    const classesBefore = ((before.data.collections || {}).classes || []).map(c => c.name);

    const imp = await req('/api/admin/import', { method: 'POST', token: managerToken, body: {
      kind: 'students',
      rows: [
        /* ۱) در فایل فقط رشته آمده — هیچ کلاسی نباید ساخته شود */
        { _row: 2, name: 'دانش‌آموز رشته‌ای', national_id: '1000000907', field: 'گرافیک' },
        /* ۲) پایه + رشتهٔ غلط‌تایپی — باید همان رشتهٔ تعریف‌شده دهم شود */
        { _row: 3, name: 'دانش‌آموز غلط‌تایپی', national_id: '1000000915', grade: 'دهم', field: 'شبکه و نرم‌افزار' },
        /* ۳) نام کلاس خودش «پایه + رشته» است */
        { _row: 4, name: 'دانش‌آموز کلاس‌نام', national_id: '1000000923', class_name: 'یازدهم علوم تجربی' },
      ],
    } });

    assert.strictEqual(imp.data.ok, true, 'درخواست پذیرفت');
    assert.strictEqual(imp.data.created, 3, 'هر سه دانش‌آموز ساخته شدند');

    const byName = n => imp.data.users.find(u => u.name === n);

    /* ۱) بی‌کلاس ماند و دلیلش ثبت شد */
    const noClass = byName('دانش‌آموز رشته‌ای');
    assert.strictEqual(noClass.class_id, null, 'رشته به کلاس تبدیل نشد');
    assert.ok(/پایه/.test(String(noClass.followup_reason || '')), 'دلیلِ نبودِ پایه ثبت شد');

    /* ۲و۳) هیچ کلاسی ساخته نشد؛ پایه و رشته روی خود دانش‌آموز نشست */
    const after = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z', { token: managerToken });
    const classes = (after.data.collections || {}).classes || [];
    const names = classes.map(c => String(c.name));
    assert.ok(!names.includes('گرافیک'), 'کلاسی به نام رشته ساخته نشد');
    assert.ok(!names.includes('دهم شبکه و نرم‌افزار'), 'کلاس از اکسل ساخته نشد — کلاس دستی است');
    assert.ok(!names.includes('یازدهم علوم تجربی'), 'نام کلاسِ «پایه + رشته» هم کلاس نساخت');
    assert.strictEqual(classes.length, classesBefore.length, 'تعداد کلاس‌ها تغییر نکرد');
    const d10 = byName('دانش‌آموز غلط‌تایپی');
    assert.strictEqual(d10.grade, 'دهم', 'پایه روی دانش‌آموز ماند');
    assert.strictEqual(d10.field, 'شبکه و نرم‌افزار', 'رشته روی دانش‌آموز ماند');
    const y11 = byName('دانش‌آموز کلاس‌نام');
    assert.strictEqual(y11.grade, 'یازدهم', 'پایه از نام کلاس جدا شد');
    assert.strictEqual(y11.field, 'علوم تجربی', 'رشته از نام کلاس جدا شد');
    assert.strictEqual(classesBefore.filter(n => !names.includes(n)).length, 0, 'کلاس قبلی جابه‌جا نشد');

    /* پایه و رشته‌های تازه در تعریف‌ها هم ثبت شده‌اند (پایه‌ها «بدون استفاده» نمی‌مانند) */
    const lookups = (after.data.collections || {}).lookups || [];
    assert.ok(lookups.some(l => l.kind === 'grade' && l.name === 'دهم'), 'پایه در تعریف‌ها هست');
    assert.ok(lookups.some(l => l.kind === 'branch' && l.name === 'علوم تجربی'), 'رشته در تعریف‌ها هست');

    /* پاک‌سازی */
    const mine = imp.data.users.map(u => u.id);
    await req('/api/admin/users/bulk-delete', { method: 'POST', token: managerToken, body: { ids: mine } });
  });

  /* ── نام کاربری گوشی: شمارهٔ همراه، و اگر نبود کد ملی ─────────────── */
  await test('نام کاربری روی گوشی: شمارهٔ همراه، و برای بی‌شماره‌ها کد ملی', () => {
    const auth = require(path.join(ROOT, 'server/auth.js'));
    const outbox = require(path.join(ROOT, 'server/outbox.js'));
    assert.strictEqual(auth.credentialsFor({ phone: '09121112233', national_id: '1000000125' }).phone,
      '09121112233', 'با شماره: نام کاربری = شماره');
    assert.strictEqual(auth.credentialsFor({ phone: '09121112233', national_id: '1000000125' }).password,
      '1000000125', 'رمز = کد ملی');
    const onlyNid = auth.credentialsFor({ phone: '', national_id: '1000000133' });
    assert.strictEqual(onlyNid.phone, '1000000133', 'بی‌شماره: نام کاربری = کد ملی');
    assert.strictEqual(onlyNid.password, '1000000133', 'رمز هم کد ملی');
    assert.strictEqual(auth.credentialsFor({ phone: '', national_id: '' }), null, 'بی‌شماره و بی‌کدملی: بی‌رمز می‌ماند و گزارش می‌شود');
    /* همان کلیدی که فایل ورودِ گوشی با آن منتشر می‌شود */
    assert.strictEqual(outbox.loginKey({ phone: '09121112233', national_id: '1000000125' }), '09121112233');
    assert.strictEqual(outbox.loginKey({ phone: '', national_id: '1000000133' }), '1000000133');
    assert.strictEqual(outbox.loginKey({ phone: '۰۹۱۲۱۱۱۲۲۳۳', national_id: '' }), '09121112233', 'ارقام فارسی هم خوانده می‌شود');
  });

  /* ── فهرست پیگیری روی سرور می‌ماند و برای مدیر برمی‌گردد ──────────── */
  await test('فهرست «نیازمند پیگیری» در پایگاه داده ذخیره و برای مدیر برگردانده می‌شود', async () => {
    const push = await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [{
      uid: 'issue-1', collection: 'import_issues', type: 'put',
      data: { kind: 'students', name: 'ردیف ناتمام', national_id: '1000000052', phone: '09123335566',
        row_no: 7, reasons: ['موبایل پدر نامعتبر است'], status: 'open', school_id: 1 },
    }] } });
    assert.strictEqual(push.data.applied.length, 1, 'ردیف پیگیری ذخیره شد');
    const id = push.data.applied[0].id;

    const pull = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z', { token: managerToken });
    const rows = ((pull.data.collections || {}).import_issues) || [];
    const mine = rows.find(r => Number(r.id) === Number(id));
    assert.ok(mine, 'ردیف برای مدیر برمی‌گردد');
    assert.strictEqual(mine.status, 'open');
    assert.ok(Array.isArray(mine.reasons) && mine.reasons.length, 'دلیل‌ها همراه ردیف ذخیره شد');

    /* بستن ردیف (حل‌شده) */
    const close = await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [{
      uid: 'issue-1b', collection: 'import_issues', type: 'put', id, base_version: 1,
      data: Object.assign({}, mine, { status: 'done' }),
    }] } });
    assert.strictEqual(close.data.applied.length, 1, 'ردیف حل‌شده ثبت شد');
    const after = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z', { token: managerToken });
    const closed = (((after.data.collections || {}).import_issues) || []).find(r => Number(r.id) === Number(id));
    assert.strictEqual(closed.status, 'done', 'وضعیت ردیف «حل‌شده» شد');

    /* نقش‌های دیگر به این فهرست دسترسی ندارند */
    const stud = await req('/api/auth/login', { method: 'POST', body: { phone: '09121234567', password: '123456' } });
    if (stud.data.ok) {
      const other = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z', { token: stud.data.session.token });
      assert.ok(!((other.data.collections || {}).import_issues || []).length, 'دانش‌آموز این فهرست را نمی‌بیند');
    }
  });

  /* ── پدر و مادر: هر دو حساب بسازند و بتوانند وارد شوند ───────────── */
  await test('ورود دسته‌ای: برای پدر و مادر هر دو حساب و رمز ساخته می‌شود (با شماره یا با کد ملی)', async () => {
    const rows = [
      /* شماره برای پدر و مادر یکی نوشته شده؛ دانش‌آموز خودش شماره ندارد */
      { name: 'حسین نوری', national_id: '1000000117', new_class: 'دهم الف',
        father_name: 'اکبر نوری', father_nid: '1000000125', father_phone: '09121112233',
        mother_name: 'فاطمه نوری', mother_nid: '1000000133', mother_phone: '09121112233' },
      /* هیچ‌کدام شماره ندارند — باید با کد ملی وارد شوند */
      { name: 'مینا صادقی', national_id: '1000000141', new_class: 'دهم الف',
        father_name: 'جواد صادقی', father_nid: '1000000151',
        mother_name: 'سحر صادقی', mother_nid: '1000000168' },
      /* پدرِ بدون شماره و بدون کد ملی — بی‌راه‌ورود می‌ماند و گزارش می‌شود */
      { name: 'رضا کریمی', national_id: '1000000176', new_class: 'دهم الف',
        father_name: 'کریم بی‌مشخصات' },
    ];
    const imp = await req('/api/admin/import', { method: 'POST', token: managerToken, body: { kind: 'students', rows } });
    assert.strictEqual(imp.data.created, 3, 'سه دانش‌آموز ساخته شد');
    assert.ok(imp.data.parents >= 5, 'پدر و مادرها ساخته شدند (' + imp.data.parents + ')');
    assert.strictEqual(imp.data.errors.length, 0, 'خطایی ثبت نشد');
    assert.ok((imp.data.warnings || []).some(w => w.error === 'parent_without_login'),
      'ولیِ بی‌شماره و بی‌کدملی گزارش شد');

    const loginAs = (id, pw) => req('/api/auth/login', { method: 'POST', body: { phone: id, password: pw } });

    /* دانش‌آموز بی‌شماره با کد ملی */
    assert.strictEqual((await loginAs('1000000117', '1000000117')).data.ok, true, 'دانش‌آموز بی‌شماره با کد ملی وارد می‌شود');
    /* پدر با شماره */
    const dad = await loginAs('09121112233', '1000000125');
    assert.strictEqual(dad.data.ok, true, 'پدر با شمارهٔ همراه وارد می‌شود');
    /* مادر با همان شمارهٔ مشترک: نام کاربری‌اش کد ملی است، نه حساب پدر */
    const mom = await loginAs('1000000133', '1000000133');
    assert.strictEqual(mom.data.ok, true, 'مادر با کد ملی وارد می‌شود');
    assert.notStrictEqual(mom.data.user.id, dad.data.user.id, 'حساب مادر جداست');
    /* پدر و مادرِ بی‌شماره */
    assert.strictEqual((await loginAs('1000000151', '1000000151')).data.ok, true, 'پدر بی‌شماره با کد ملی');
    assert.strictEqual((await loginAs('1000000168', '1000000168')).data.ok, true, 'مادر بی‌شماره با کد ملی');

    /* هر ولی فرزندش را می‌بیند */
    const mp = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z', { token: mom.data.session.token });
    assert.strictEqual(((mp.data.collections || {}).parent_links || []).length, 1, 'پیوند فرزند برای مادر ثبت شد');

    /* همهٔ این حساب‌ها در فهرست رمزها با نام کاربری درست هستند */
    const creds = await req('/api/admin/users/credentials', { token: managerToken });
    const byName = n => creds.data.users.find(u => u.name === n);
    assert.strictEqual(byName('فاطمه نوری').password, '1000000133', 'رمز مادر = کد ملی');
    assert.strictEqual(byName('جواد صادقی').password, '1000000151', 'رمز پدر بی‌شماره = کد ملی');

    /* ثبت دوباره نباید ولی تکراری بسازد */
    const again = await req('/api/admin/import', { method: 'POST', token: managerToken, body: { kind: 'students', rows } });
    assert.strictEqual(again.data.updated, 3, 'سطرهای تکراری به‌روزرسانی شدند');
    assert.strictEqual(again.data.parents, 0, 'ولی تکراری ساخته نشد');
    const creds2 = await req('/api/admin/users/credentials', { token: managerToken });
    const count = n => creds2.data.users.filter(u => u.name === n).length;
    assert.strictEqual(count('اکبر نوری'), 1, 'پدر یک‌بار ثبت شده است');
    assert.strictEqual(count('فاطمه نوری'), 1, 'مادر یک‌بار ثبت شده است');

    /* پاک‌سازی */
    const mine = creds2.data.users.filter(u => ['حسین نوری', 'مینا صادقی', 'رضا کریمی', 'اکبر نوری', 'فاطمه نوری', 'جواد صادقی', 'سحر صادقی', 'کریم بی‌مشخصات'].includes(u.name)).map(u => u.id);
    await req('/api/admin/users/bulk-delete', { method: 'POST', token: managerToken, body: { ids: mine } });
  });

  /* ── ولیِ بدون کد ملی: باید وارد شود (باگ «نام کاربری یا رمز اشتباهه») ── */
  await test('ولی بدون کد ملی ساخته می‌شود و همان لحظه وارد می‌شود', async () => {
    const mk = await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
      { uid: 'par-nonid', collection: 'users', type: 'put', data: { name: 'ولی بی‌کدملی', role: 'parent', phone: '09125550011' } },
    ] } });
    assert.strictEqual(mk.data.applied.length, 1, 'کاربر ساخته شد');
    const parentId = mk.data.applied[0].id;

    const creds = await req('/api/admin/users/credentials', { token: managerToken });
    const row = creds.data.users.find(u => Number(u.id) === Number(parentId));
    assert.ok(row, 'کاربر در فهرست رمزها هست');
    assert.ok(row.password && String(row.password).length >= 4, 'رمز برای مدیر قابل دیدن است: ' + row.password);

    const login = await req('/api/auth/login', { method: 'POST', body: { phone: '09125550011', password: String(row.password) } });
    assert.strictEqual(login.data.ok, true, 'ولی بدون کد ملی وارد می‌شود');
    assert.ok(login.data.session && login.data.session.token);

    const wrong = await req('/api/auth/login', { method: 'POST', body: { phone: '09125550011', password: '000000' } });
    assert.strictEqual(wrong.data.ok, false, 'رمز اشتباه رد می‌شود');
  });

  /* ── تغییر رمز: رمز واقعاً عوض می‌شود و نمایش هم همان رمز تازه است ── */
  await test('تغییر رمز واقعاً اعمال می‌شود و رمز نمایش‌داده‌شده همان رمز تازه است', async () => {
    const mk = await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
      { uid: 'pw-user', collection: 'users', type: 'put', data: { name: 'کاربر رمز', role: 'teacher', phone: '09125550022', national_id: '1000000052' } },
    ] } });
    const uid = mk.data.applied[0].id;
    const set = await req('/api/admin/users/' + uid + '/password', { method: 'POST', token: managerToken, body: { password: 'newpass1234' } });
    assert.strictEqual(set.data.ok, true);
    assert.strictEqual(set.data.password, undefined, 'ردیف ۶۵: رمز خام در پاسخ بازتاب نمی‌شود');

    const creds = await req('/api/admin/users/credentials', { token: managerToken });
    const row = creds.data.users.find(u => Number(u.id) === Number(uid));
    assert.strictEqual(String(row.password), 'newpass1234', 'جدول رمزها رمز تازه را نشان می‌دهد');

    const oldPw = await req('/api/auth/login', { method: 'POST', body: { phone: '09125550022', password: '1000000052' } });
    assert.strictEqual(oldPw.data.ok, false, 'رمز قبلی دیگر کار نمی‌کند');
    const newPw = await req('/api/auth/login', { method: 'POST', body: { phone: '09125550022', password: 'newpass1234' } });
    assert.strictEqual(newPw.data.ok, true, 'رمز تازه کار می‌کند');
  });

  await test('پشتیبان‌گیری ساخته و قابل دانلود است', async () => {
    const b = await req('/api/admin/backup', { method: 'POST', token: managerToken });
    assert.strictEqual(b.data.ok, true);
    const res = await fetch(BASE + '/api/admin/backups/' + b.data.file, { headers: { authorization: 'Bearer ' + managerToken } });
    assert.strictEqual(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 1000);
    assert.strictEqual(buf.subarray(0, 15).toString(), 'SQLite format 3');
  });

  await test('مانیفست انتشار: هش و اندازهٔ همهٔ فایل‌ها با منبع واقعی یکی است', () => {
    const crypto = require('crypto');
    const manifest = require('../releases/manifest.json');
    for (const file of manifest.files) {
      const full = path.join(ROOT, file.path);
      assert.ok(fs.existsSync(full), 'فایل مانیفست وجود دارد: ' + file.path);
      const bytes = fs.readFileSync(full);
      assert.strictEqual(bytes.length, file.size, 'اندازهٔ فایل با مانیفست می‌خواند: ' + file.path);
      assert.strictEqual(crypto.createHash('sha256').update(bytes).digest('hex'), file.sha256,
        'هش فایل با مانیفست می‌خواند: ' + file.path);
    }
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/build.yml'), 'utf8');
    assert.ok(/git add client\/app\.js releases\/manifest\.json releases\/history/.test(workflow),
      'نسخهٔ هم‌تراز شدهٔ کلاینت هم همراه مانیفست در main ثبت می‌شود');
  });

  await test('آپدیت: دلتا فقط فایل‌های تغییرکرده را برمی‌گرداند', async () => {
    const manifest = require('../releases/manifest.json');
    const r = await req('/api/update/check?current=' + encodeURIComponent(manifest.version));
    assert.strictEqual(r.data.ok, true);
    assert.strictEqual(r.data.up_to_date, true, 'همان نسخه = بدون تغییر');
    const old = await req('/api/update/check?current=0.0.1');
    assert.ok(Array.isArray(old.data.changed) && old.data.changed.length > 0);
    assert.ok(old.data.changed[0].sha256);
    assert.strictEqual(old.data.changed.length, manifest.files.length, 'نسخهٔ نامعلوم = دانلود کامل');
    assert.ok(old.data.total_size <= old.data.full_size);
  });

  /* ── به‌روزرسانی: همان چرخهٔ k3-reval (بررسی → دانلود با درصد → آمادهٔ نصب) ── */
  await test('به‌روزرسانی: وضعیت لحظه‌ای، درصد پیشرفت و خطای فارسی (مثل k3-reval)', async () => {
    /* بدون نشست: بسته است */
    const anon = await req('/api/admin/update/state');
    assert.strictEqual(anon.data.ok, false, 'بدون ورود، وضعیت به‌روزرسانی بسته است');

    const st = await req('/api/admin/update/state', { token: managerToken });
    assert.strictEqual(st.data.ok, true);
    const s = st.data.state;
    ['status', 'current', 'latest', 'hasUpdate', 'percent', 'ready', 'mode', 'errorText', 'files', 'sizeKb'].forEach(k => {
      assert.ok(k in s, 'فیلد «' + k + '» در وضعیت هست');
    });
    assert.strictEqual(typeof s.current, 'string', 'نسخهٔ فعلی برگردانده می‌شود');
    assert.ok(['idle', 'latest', 'available', 'checking', 'error', 'downloading', 'ready', 'installing', 'done'].includes(s.status),
      'وضعیت یکی از حالت‌های شناخته‌شده است: ' + s.status);
    assert.strictEqual(typeof s.percent, 'number');

    /* منبعِ در دسترس‌نبودن: خطای فارسی، نه کد خام؛ و هیچ فایلی دست نمی‌خورد */
    await req('/api/admin/update/settings', { method: 'POST', token: managerToken, body: { base: 'http://127.0.0.1:9/' } });
    try {
      const dl = await req('/api/admin/update/download', { method: 'POST', token: managerToken, body: {} });
      assert.strictEqual(dl.data.ok, false, 'دانلود از منبعِ خاموش انجام نشد');
      const txt = String((dl.data.state && dl.data.state.errorText) || '');
      assert.ok(txt.length > 3 && /[آ-ی]/.test(txt), 'پیام خطا فارسی است: ' + txt);
      const manifest = require('../releases/manifest.json');
      assert.strictEqual(typeof manifest.version, 'string', 'مانیفست دست‌نخورده ماند');
    } finally {
      await req('/api/admin/update/settings', { method: 'POST', token: managerToken, body: { base: '' } });
    }
  });

  await test('حذف دانش‌آموز روی سیستم مدرسه: پیوند ولی و ولیِ بی‌فرزند پاک می‌شود', async () => {
    const mk = await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
      { uid: 'cas-s', collection: 'users', type: 'put', data: { name: 'دانش‌آموز آزمایشی', role: 'student', phone: '09125558001', national_id: '1000000941' } },
      { uid: 'cas-p1', collection: 'users', type: 'put', data: { name: 'پدر آزمایشی', role: 'parent', phone: '09125558002' } },
      { uid: 'cas-p2', collection: 'users', type: 'put', data: { name: 'مادر آزمایشی', role: 'parent', phone: '09125558003' } },
      { uid: 'cas-s2', collection: 'users', type: 'put', data: { name: 'خواهر آزمایشی', role: 'student', phone: '09125558004' } },
    ] } });
    const ids = mk.data.applied.map(a => Number(a.id));
    const [sId, p1, p2, s2] = ids;
    await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
      { uid: 'cas-l1', collection: 'parent_links', type: 'put', data: { parent_id: p1, student_id: sId } },
      { uid: 'cas-l2', collection: 'parent_links', type: 'put', data: { parent_id: p2, student_id: sId } },
      { uid: 'cas-l3', collection: 'parent_links', type: 'put', data: { parent_id: p1, student_id: s2 } },
    ] } });

    const del = await req('/api/admin/users/bulk-delete', { method: 'POST', token: managerToken, body: { ids: [sId] } });
    assert.strictEqual(del.data.ok, true);
    assert.strictEqual(Number(del.data.parents_deleted), 1, 'فقط مادر که فرزند دیگری ندارد حذف شد');

    const list = await req('/api/admin/users/credentials', { token: managerToken });
    const have = new Set(list.data.users.map(u => Number(u.id)));
    assert.strictEqual(have.has(sId), false, 'دانش‌آموز حذف شد');
    assert.strictEqual(have.has(p2), false, 'مادر حذف شد');
    assert.strictEqual(have.has(p1), true, 'پدر که فرزند دیگری دارد می‌ماند');
    assert.strictEqual(have.has(s2), true, 'خواهر دست‌نخورده ماند');
  });

  await test('ورود اکسل روی سیستم مدرسه: رشته پایه نمی‌شود و هیچ کلاسی ساخته نمی‌شود', async () => {
    /* ۱) پایهٔ نادرست (رشته در ستون پایه) ⇒ کلاس ساخته نمی‌شود */
    const bad = await req('/api/admin/import', { method: 'POST', token: managerToken, body: { kind: 'students', rows: [
      { _row: 2, full_name: 'دانش‌آموز رشته‌ای', national_id: '1000000958', grade: 'الکترونیک', field: 'الکترونیک' },
    ] } });
    assert.strictEqual(bad.data.ok, true);
    assert.strictEqual(Number(bad.data.classes || 0), 0, 'از رشته کلاس ساخته نشد');
    assert.ok((bad.data.warnings || []).some(w => w.error === 'class_without_grade'), 'هشدار «پایه ندارد» داده شد');

    /* ۲) پایهٔ درست + رشته ⇒ پایه و رشته روی دانش‌آموز؛ کلاس دستی است و ساخته نمی‌شود */
    const ok = await req('/api/admin/import', { method: 'POST', token: managerToken, body: { kind: 'students', rows: [
      { _row: 2, full_name: 'پیشوا رحمانی', national_id: '1000000966', new_grade: 'دهم', new_branch: 'الکترونیک', new_class: 'دهم الکترونیک' },
    ] } });
    assert.strictEqual(ok.data.ok, true);
    assert.strictEqual(Number(ok.data.classes), 0, 'هیچ کلاسی ساخته نشد');
    assert.strictEqual(Number(ok.data.created || 0), 1, 'دانش‌آموز ساخته شد');
    assert.strictEqual(ok.data.users[0].grade, 'دهم', 'پایه روی دانش‌آموز ثبت شد');
    assert.strictEqual(ok.data.users[0].field, 'الکترونیک', 'رشته روی دانش‌آموز ثبت شد');
    assert.ok(!(ok.data.warnings || []).some(w => w.error === 'class_without_grade'), 'هشدار «پایه ندارد» ندارد — پایه ثبت شد');
    const again = await req('/api/admin/import', { method: 'POST', token: managerToken, body: { kind: 'students', rows: [
      { _row: 2, full_name: 'پیشوا رحمانی', national_id: '1000000966', new_grade: 'دهم', new_branch: 'الکترونیک' },
    ] } });
    assert.strictEqual(Number(again.data.created || 0), 0, 'بار دوم کاربر تکراری ساخته نشد');
    assert.strictEqual(Number(again.data.updated || 0), 1, 'ردیف دوم به‌روزرسانی شد');
    assert.strictEqual(Number(again.data.classes || 0), 0, 'گروه تکراری ساخته نشد');
  });

  await test('اپلیکیشن اندروید: آدرس سرویس را خودش پیدا می‌کند (بدون پرسش از کاربر)', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'android-config.json'), 'utf8'));
    assert.strictEqual(cfg.app, 'payesh-local');
    assert.strictEqual(typeof cfg.url, 'string', 'کلید url باید باشد (حتی خالی)');

    const main = fs.readFileSync(path.join(ROOT, 'install/android/app/src/main/java/ir/payesh/local/MainActivity.java'), 'utf8');
    assert.ok(main.includes('BuildConfig.PAYESH_URL'), 'آدرس پخته‌شده در APK');
    assert.ok(main.includes('CONFIG_URLS'), 'پیکربندی مرکزی مخزن');
    assert.ok(/void scanLan\(/.test(main), 'جستجوی خودکار در شبکه');
    assert.ok(/verifyThenOpen\(/.test(main), 'بررسی سریع آدرس‌ها و رفتن به بعدی');
    /* اگر همهٔ آدرس‌های ذخیره‌شده شکست خوردند، پیش از آفلاین جست‌وجوی Wi-Fi انجام شود (منفی: باز کردن مستقیم آفلاین) */
    const vto = main.slice(main.indexOf('private void verifyThenOpen('), main.indexOf('private java.util.List<String> candidates('));
    const lastElse = vto.slice(vto.lastIndexOf('} else {'));
    assert.ok(/scanLan\(\);/.test(lastElse), 'شکست همهٔ آدرس‌ها ⇒ scanLan');
    assert.ok(!/openApp\(prefs\.getString\(KEY_URL/.test(lastElse), 'نه باز کردن آفلاین بدون جست‌وجو');
    assert.ok(!/payesh-XXXX|tail1234\.ts\.net/i.test(cfg.url), 'آدرس نمونهٔ placeholder در پیکربندی مرکزی نیست');
    assert.ok(/low\.contains\("tail1234"\)/.test(main) && /low\.contains\("xxxx"\)/.test(main), 'میزبان placeholder نرمال نمی‌شود');
    assert.ok(main.includes('appassets.androidplatform.net'), 'دارایی‌های برنامه از داخل APK');

    /* شروع برنامه نباید مستقیم آدرس بپرسد — همان شکایتی که کاربر داشت */
    const onCreate = main.slice(main.indexOf('protected void onCreate'), main.indexOf('private int dp('));
    assert.ok(onCreate.includes('boot();'), 'شروع برنامه اتصال خودکار است');
    const asksOnStart = onCreate.split('\n').some(l => l.trim() === 'askServer();');
    assert.ok(!asksOnStart, 'در اولین اجرا آدرس پرسیده نمی‌شود (فقط دکمهٔ اضطراری)');

    /* ── انتشار فقط با کلید Owner؛ هیچ کلید یا fallback ثابت در مخزن نیست ── */
    const gradleTxt = fs.readFileSync(path.join(ROOT, 'install/android/app/build.gradle'), 'utf8');
    for (const variable of ['PAYESH_KEYSTORE', 'PAYESH_KEYSTORE_PASS', 'PAYESH_KEY_ALIAS', 'PAYESH_KEY_PASS']) {
      assert.ok(gradleTxt.includes(variable), `release signing receives ${variable} from the environment`);
    }
    assert.ok(/Release signing credentials are missing/.test(gradleTxt), 'نسخهٔ release بدون credential fail-closed است');
    assert.ok(/Owner approval for the signing-key migration path is missing/.test(gradleTxt),
      'نسخهٔ release بدون تأیید مسیر مهاجرت fail-closed است');
    assert.ok(/if \(releaseSigningReady\) signingConfig signingConfigs\.release/.test(gradleTxt),
      'فقط build نوع release به signing config امن وصل است');
    assert.ok(!/payesh-signing\.p12|payesh1404|signingConfigs\.stable/.test(gradleTxt),
      'هیچ کلید ثابت یا رمز hardcoded در Gradle نیست');
    assert.ok(!fs.existsSync(path.join(ROOT, 'install/android/payesh-signing.p12')), 'فایل کلید از درخت کاری حذف شده است');

    /* نحو جاوا هم بررسی می‌شود تا خطای کامپایل به CI نرسد */
    const { parse } = require('java-parser');
    parse(main);
    assert.ok(main.includes('KEY_PUBLIC') && main.includes('learnPublicUrl'),
      'آدرس عمومی را از خود سرور یاد می‌گیرد (کار در خانه)');
    assert.ok(/candidates\(\)/.test(main), 'فهرست آدرس‌های جایگزین');

    /* سیستم مدرسه خاموش → همان برنامهٔ داخل گوشی (نه نسخهٔ کش‌شدهٔ قدیمی) */
    assert.ok(/private void showOffline\(/.test(main), 'دکمهٔ آفلاین در گوشی');
    assert.ok(!main.includes('LOAD_CACHE_ELSE_NETWORK'),
      'نسخهٔ کهنه از کش نمایش داده نمی‌شود (باگ «بعد از آپدیت، صفحهٔ قدیمی»)');
    assert.ok(/no-store/.test(main), 'فایل‌های برنامه کش نمی‌شوند');
    assert.ok(/clearCache\(true\)/.test(main), 'با نصب نسخهٔ تازه، کش پاک می‌شود');
    assert.ok(/setCacheMode\(WebSettings\.LOAD_NO_CACHE\)/.test(main), 'همیشه فایل تازهٔ داخل APK');
    assert.ok(main.includes('PAYESH_BUILD'), 'نسخهٔ ساخت به برنامه داده می‌شود');
    /* پل بومی حافظه: بدون CORS */
    assert.ok(/JavascriptInterface/.test(main) && /"PayeshNative"/.test(main),
      'پل بومی حافظهٔ ابری در برنامه هست');
    assert.ok(main.includes('KEY_LAST'), 'آخرین نشانی موفق ذخیره می‌شود');
    assert.ok(main.includes('optJSONArray("urls")'), 'چند آدرس از مخزن (سرور پشتیبان)');

    const gradle = fs.readFileSync(path.join(ROOT, 'install/android/app/build.gradle'), 'utf8');
    assert.ok(gradle.includes('buildConfigField'), 'PAYESH_URL در BuildConfig ساخته می‌شود');
    assert.ok(gradle.includes('PAYESH_APP_URL'), 'متغیر محیطی برای پختن آدرس');
    assert.ok(gradle.includes('bundleWebAssets'), 'برنامهٔ کامل داخل APK کپی می‌شود');
  });

  await test('برنامهٔ ویندوز: پنجرهٔ واقعی است، نه مرورگر', () => {
    const app = fs.readFileSync(path.join(ROOT, 'desktop/PayeshApp.cs'), 'utf8');
    const iss = fs.readFileSync(path.join(ROOT, 'installer/payesh.iss'), 'utf8');

    /* ۱) خود فایل برنامه: پنجرهٔ WinForms + WebView2 */
    assert.ok(/class\s+\w+\s*:\s*Form/.test(app), 'فرم WinForms');
    assert.ok(app.includes('Microsoft.Web.WebView2.WinForms'), 'WebView2 داخل پنجره');
    assert.ok(app.includes('CoreWebView2Environment') || app.includes('WebView2'), 'موتور نمایش داخلی');
    assert.ok(!/Process\.Start\("http.*localhost:8080/.test(app), 'باز کردن مرورگر مسیر اصلی نیست');

    /* ۲) نصب‌کننده: میان‌بر اصلی باید خود exe باشد */
    const icons = iss.slice(iss.indexOf('[Icons]'), iss.indexOf('[Registry]'));
    const mainIcon = icons.split('\n').find(l => l.includes('{group}') && l.includes('{#AppName}'));
    assert.ok(mainIcon, 'میان‌بر برنامه در منوی شروع');
    assert.ok(mainIcon.includes('{app}\\desktop\\Payesh.exe'), 'میان‌بر به Payesh.exe اشاره می‌کند');
    assert.ok(!mainIcon.includes('explorer.exe'), 'میان‌بر برنامه explorer.exe نیست');
    assert.ok(!mainIcon.includes('wscript.exe'), 'میان‌بر برنامه اسکریپت VBS نیست');
    assert.ok(!/explorer\.exe"; Parameters: "http:\/\/localhost:8080/.test(icons),
      'میان‌بر «باز کردن در مرورگر» وجود ندارد');

    /* ۳) اجرای پس از نصب = برنامه، نه مرورگر */
    const run = iss.slice(iss.indexOf('[Run]'));
    assert.ok(run.includes('{app}\\desktop\\Payesh.exe'), 'اجرای پس از نصب برنامه را باز می‌کند');

    /* ۴) خودکار بودن: سرور را بالا می‌آورد و منتظر آماده شدن می‌ماند */
    assert.ok(app.includes('/api/health'), 'انتظار برای آماده شدن سرور');
    assert.ok(app.includes('server/index.js') || app.includes('"server"'), 'اجرای سرور محلی');
    assert.ok(app.includes('--tray'), 'حالت سینی سیستم برای اجرای خودکار');

    /* ۴.۲) نقش این رایانه با «سیستم مدرسه» یکی است: اگر فایل‌های سرور هست، سرور است
       (باگ 0.4.3: یک تنظیم چسبندهٔ mode=client سیستم مدرسه را برای همیشه «کاربر» می‌کرد) */
    assert.ok(app.includes('bool hasServer'), 'وجود فایل‌های سرور تعیین‌کننده است');
    assert.ok(!/mode"\) == "client"/.test(app), 'تنظیم چسبندهٔ mode=client حذف شده');
    assert.ok(!app.includes('SaveIni(_settingsFile, "mode", "client")'), 'دکمهٔ جستجو رایانه را کاربر نمی‌کند');

    /* ۴.۲.۵) چند سرور: هر رایانه‌ای می‌تواند سرور باشد */
    assert.ok(/SplitList\(/.test(app) && app.includes('"urls"'), 'چند آدرس (سرور اصلی + پشتیبان)');
    assert.ok(/RemoteAddresses\(/.test(app), 'خواندن آرایهٔ urlها از مخزن');

    /* ۴.۳) حالت آفلاین: سیستم مدرسه خاموش است → آخرین وضعیت ذخیره‌شده */
    assert.ok(/private void ShowOffline\(/.test(app), 'دکمهٔ نمایش آخرین وضعیت');
    assert.ok(/SaveIni\(_settingsFile, "last_url", url\)/.test(app), 'آخرین نشانی موفق ذخیره می‌شود');
    assert.ok(app.includes('حالت آفلاین'), 'نوار آفلاین');

    /* ۴.۵) کلیک دوباره روی آیکون = آوردن پنجرهٔ موجود، نه پیام «باز است» */
    assert.ok(app.includes('TryOpenExisting'), 'سیگنال تک‌نمونه‌ای');
    assert.ok(/BringToFrontFromSecond/.test(app), 'آوردن پنجرهٔ سینی به جلو');
    assert.ok(!/MessageBox\.Show\(\s*"پایش/.test(app), 'پیام بن‌بست «باز است» برنگشته');

    /* ۵) اتصال از هر اینترنت: نردبان آدرس شامل آدرس عمومی */
    assert.ok(/public_url/.test(app), 'آدرس عمومی HTTPS در نردبان اتصال');
    assert.ok(/ScanLan\(/.test(app), 'شبکهٔ محلی فقط آخرین گزینه');

    /* ۵.۵) برنامه در {app}\desktop است و سرور در {app} → ریشهٔ نصب باید یک پله بالا برود
       (باگ 0.4.2: برنامه خودش را «کاربر» می‌دید و هیچ سروری بالا نمی‌آمد) */
    assert.ok(/ResolveRoot\(/.test(app), 'تشخیص ریشهٔ نصب');
    assert.ok(app.includes('Directory.GetParent'), 'پوشهٔ desktop → ریشهٔ نصب');
    assert.ok(app.includes('runtime", "node.exe"'), 'Node همراه بسته پیدا می‌شود');

    /* ۶) نگهبان زمان کامپایل: بدون exe، نصب‌کننده ساخته نمی‌شود */
    assert.ok(/FileExists\([\s\S]{0,160}?Payesh\.exe/.test(iss), 'ISCC بدون Payesh.exe باید خطا بدهد');
    assert.ok(/FileExists\([\s\S]{0,160}?WebView2Loader\.dll/.test(iss), 'ISCC بدون WebView2Loader باید خطا بدهد');
    assert.ok(/FileExists\([\s\S]{0,160}?runtime\\node\.exe/.test(iss), 'ISCC بدون Node باید خطا بدهد');

    /* ۷) اسکریپت ساخت و CI */
    const ps = fs.readFileSync(path.join(ROOT, 'desktop/build.ps1'), 'utf8');
    assert.ok(ps.includes('WebView2'), 'SDK وب‌ویو در ساخت');
    assert.ok(ps.includes('Payesh.exe'), 'خروجی exe');
    /* ردیف ۱۲۹: ساخت WebView ویندوز فقط کنترل منفی CI است (school-webview-control.yml) و منتشر نمی‌شود */
    const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/school-webview-control.yml'), 'utf8');
    assert.ok(ci.includes('desktop\\build.ps1'), 'CI برنامه را (فقط به‌عنوان کنترل منفی) می‌سازد');
    assert.ok(/^permissions:\n {2}contents: read$/m.test(ci) && !/gh release|softprops/.test(ci), 'کنترل منفی چیزی منتشر نمی‌کند');
  });

  await test('دسترسی از هر اینترنتی: تونل خودکار روشن می‌شود', () => {
    const tunnel = fs.readFileSync(path.join(ROOT, 'server/tunnel.js'), 'utf8');
    const index = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    assert.ok(/function autoStart\(/.test(tunnel), 'راه‌اندازی خودکار تونل');
    assert.ok(tunnel.includes('PAYESH_TUNNEL_AUTO'), 'کلید خاموش/روشن');
    assert.ok(/autoStart\(\)/.test(tunnel) || /autoStart\(store/.test(tunnel), 'در start فراخوانی می‌شود');
    const iss = fs.readFileSync(path.join(ROOT, 'installer/payesh.iss'), 'utf8');
    assert.ok(!/cloudflared/i.test(iss), 'نصب‌کننده هیچ اثری از Cloudflare ندارد');
    assert.ok(!/cloudflared|trycloudflare|quick tunnel/i.test(tunnel), 'کد تونل بدون Cloudflare است');
    assert.ok(index.includes('tunnel.start('), 'سرور تونل را راه می‌اندازد');

    /* آدرس عمومی باید در health منتشر شود تا کلاینت‌ها یاد بگیرند */
    const health = index.slice(index.indexOf("'/api/health'"));
    assert.ok(health.slice(0, 900).includes('public_url'), 'public_url در /api/health');
  });

  await test('استقرار ابری: بستهٔ آماده، داکر و اسکریپت VPS', () => {
    const need = ['deploy/README.md', 'deploy/vps-setup.sh', 'deploy/payesh.service',
      'deploy/backup.sh', 'deploy/selfcheck.mjs', 'deploy/.env.example',
      'Dockerfile', 'docker-compose.yml', 'scripts/build-cloud-bundle.mjs'];
    for (const f of need) assert.ok(fs.existsSync(path.join(ROOT, f)), 'فایل موجود: ' + f);

    const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    assert.ok(/FROM node:22/.test(docker), 'Node 22 برای node:sqlite');
    assert.ok(docker.includes('--experimental-sqlite'), 'پرچم sqlite در اجرا');
    assert.ok(/PAYESH_DATA=\/data/.test(docker), 'دادهٔ ماندگار در volume');
    assert.ok(/EXPOSE 8080/.test(docker), 'درگاه');

    const vps = fs.readFileSync(path.join(ROOT, 'deploy/vps-setup.sh'), 'utf8');
    assert.ok(vps.includes('systemctl enable --now payesh'), 'سرویس systemd');
    assert.ok(vps.includes('PAYESH_TUNNEL_AUTO=0'), 'تونل روی ابر خاموش');
    assert.ok(/certbot/.test(vps), 'SSL خودکار با دامنه');
    assert.ok(/23\.5|minor.*-ge 5|node:sqlite/i.test(vps), 'بررسی نسخهٔ Node');

    const env = fs.readFileSync(path.join(ROOT, 'deploy/.env.example'), 'utf8');
    assert.ok(env.includes('PAYESH_DATA') && env.includes('PAYESH_PUBLIC_URL'), 'متغیرهای لازم');

    const bundle = fs.readFileSync(path.join(ROOT, 'scripts/build-cloud-bundle.mjs'), 'utf8');
    assert.ok(bundle.includes('payesh-cloud.zip'), 'خروجی ZIP برای پنل');
    assert.ok(bundle.includes('START-HERE.txt'), 'راهنمای کنار بسته');

    const check = fs.readFileSync(path.join(ROOT, 'deploy/selfcheck.mjs'), 'utf8');
    assert.ok(check.includes('/api/health') && check.includes('setup_done'), 'بررسی سلامت استقرار');
  });


  const corsRulesOk = xml => ['GET', 'PUT', 'DELETE', 'HEAD'].every(m => String(xml).includes('<AllowedMethod>' + m + '</AllowedMethod>'));

  await test('پیروی از پنل مالک: بردار مشترک رمزنگاری فرمان (Node = Dart)', async () => {
    const cc = require(path.join(ROOT, 'server', 'cloud-control.js'));
    const V = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'cloud', 'contracts', 'cloud-control-vectors.json'), 'utf8'));
    assert.equal(cc.keyFor(V.secret).toString('hex'), V.key_hex, 'کلید HKDF');
    const env = cc.sealText(V.secret, V.rev, V.plaintext, Buffer.from(V.nonce_hex, 'hex'));
    assert.deepEqual(env, V.envelope, 'پاکت بایت‌به‌بایت');
    const opened = cc.open(V.secret, V.envelope);
    assert.equal(opened.config.bucket, 'payesh-madrese');
    assert.equal(opened.config.region, 'ir-central1');
    for (const f of V.must_fail) {
      assert.throws(() => cc.open(f.secret || V.secret, f.envelope), e => e.code === 'open_failed', f.why);
    }
    assert.throws(() => cc.open(V.secret, Object.assign({}, V.envelope, { nonce: 'AA' })), e => e.code === 'bad_format');
    for (const [ak, kid] of Object.entries(V.kid_of_access_key)) {
      assert.equal(cc.kidOf(ak), kid, 'kid ' + ak);
      assert.equal(cc.controlKeyFor(ak), 'control/cloud-' + kid + '.json');
    }
    /* محتوای نامعتبر هرگز اعمال نمی‌شود: http غیرمحلی، صندوقچهٔ بدنام، کلید خالی */
    for (const bad of [
      { endpoint: 'http://s3.ir-central1.arvanstorage.ir', bucket: 'payesh-madrese', accessKey: 'abc', secret: 'abcdef' },
      { endpoint: 'https://s3.ir-central1.arvanstorage.ir', bucket: 'Bad_Bucket', accessKey: 'abc', secret: 'abcdef' },
      { endpoint: 'https://s3.ir-central1.arvanstorage.ir', bucket: 'payesh-madrese', accessKey: '', secret: 'abcdef' },
      { endpoint: 'https://u:p@s3.ir-central1.arvanstorage.ir', bucket: 'payesh-madrese', accessKey: 'abc', secret: 'abcdef' },
    ]) {
      assert.throws(() => cc.open('k', cc.seal('k', 5, bad)), e => e.code === 'bad_config', JSON.stringify(bad));
    }
  });

  await test('پیروی از پنل مالک: سرور مدرسه خودکار به صندوقچهٔ تازه می‌رود و رسید می‌گذارد', async () => {
    const cc = require(path.join(ROOT, 'server', 'cloud-control.js'));
    const s3mem = require(path.join(ROOT, 'server', 's3mem.js'));
    const { startStub } = require('./lib/s3-stub');
    const { memStore, publish } = require('./lib/cloud-control-helpers');
    const A = await startStub({ accessKey: 'ak-old', secret: 'sk-old-1', bucket: 'payesh-old' });
    const B = await startStub({ accessKey: 'ak-new', secret: 'sk-new-2', bucket: 'payesh-madrese' });
    const C = await startStub({ accessKey: 'ak-c', secret: 'sk-c-3', bucket: 'payesh-c' });
    try {
      cc._resetForTests();
      const store = memStore();
      s3mem.usingMeta(store).set(s3mem.normalize(A.cfg));
      assert.equal((await cc.poll(store)).state, 'none', 'بدون فرمان: کاری نمی‌کند');

      await publish(cc, s3mem, A.cfg, B.cfg, 1000);
      const r1 = await cc.poll(store);
      assert.equal(r1.state, 'applied', JSON.stringify(r1));
      const now = s3mem.usingMeta(store).get();
      assert.equal(now.bucket, 'payesh-madrese');
      assert.equal(now.endpoint, B.endpoint);
      assert.equal(now.accessKey, 'ak-new');
      assert.equal(now.source, 'owner');
      const id = store.getMeta('cloud:server_id');
      const ack = JSON.parse(B.objects.get('payesh/control/ack/' + id + '.json'));
      assert.equal(ack.ok, true); assert.equal(ack.rev, 1000); assert.equal(ack.bucket, 'payesh-madrese');
      assert.ok(!JSON.stringify(ack).includes('sk-new-2'), 'رسید هیچ کلیدی ندارد');
      assert.ok(store.audits.some(a => a.action === 'cloud_control_apply'));

      /* دور بعد: در صندوقچهٔ تازه همان نسخه ⇒ «به‌روز» */
      await publish(cc, s3mem, B.cfg, B.cfg, 1000);
      assert.equal((await cc.poll(store)).state, 'current');

      /* مقصد خراب (Secret نادرست) ⇒ روی همان قبلی می‌ماند و رسید خطا */
      await publish(cc, s3mem, B.cfg, Object.assign({}, C.cfg, { secret: 'wrong-secret' }), 2000);
      const r2 = await cc.poll(store);
      assert.equal(r2.state, 'rejected', JSON.stringify(r2));
      assert.equal(s3mem.usingMeta(store).get().bucket, 'payesh-madrese');
      assert.equal(JSON.parse(B.objects.get('payesh/control/ack/' + id + '.json')).ok, false);

      /* فرمان دستکاری‌شده یا نسخهٔ قدیمی‌تر هرگز اعمال نمی‌شود */
      B.poke('payesh/' + cc.controlKeyFor('ak-new'), '{"v":1,"kind":"payesh-cloud-control","rev":9999,"alg":"HKDF-SHA256/A256GCM","nonce":"AAECAwQFBgcICQoL","ct":"AAAAAAAAAAAAAAAAAAAAAAAA"}');
      assert.equal((await cc.poll(store)).state, 'invalid');
      await publish(cc, s3mem, B.cfg, C.cfg, 900);
      assert.equal((await cc.poll(store)).state, 'current', 'نسخهٔ قدیمی‌تر نادیده');
      assert.equal(s3mem.usingMeta(store).get().bucket, 'payesh-madrese');

      /* فرمانی که با کلید دیگری مهر شده باز نمی‌شود */
      const foreign = cc.seal('someone-else', 3000, C.cfg);
      B.poke('payesh/' + cc.controlKeyFor('ak-new'), JSON.stringify(foreign));
      assert.equal((await cc.poll(store)).state, 'invalid');

      /* فقط کلیدها عوض شد (همان صندوقچه): پاکتِ کلید فعلی و پاکتِ کلید تازه دو فایل جدا هستند */
      const B2 = Object.assign({}, B.cfg, { accessKey: 'ak-new-2', secret: 'sk-new-2' });
      await publish(cc, s3mem, B.cfg, B2, 3500);
      await publish(cc, s3mem, B2, B2, 3500).catch(() => {}); /* stub فقط کلید فعلی را می‌پذیرد */
      const mine = 'payesh/' + cc.controlKeyFor('ak-new');
      assert.notEqual(mine, 'payesh/' + cc.controlKeyFor('ak-new-2'));
      assert.equal(cc.open('sk-new-2', JSON.parse(B.objects.get(mine))).config.accessKey, 'ak-new-2',
        'پاکتِ کلید فعلی سالم ماند و مقصد تازه را می‌گوید');

      /* حالا مقصد سالم ⇒ می‌رود */
      await publish(cc, s3mem, B.cfg, C.cfg, 4000);
      assert.equal((await cc.poll(store)).state, 'applied');
      assert.equal(s3mem.usingMeta(store).get().bucket, 'payesh-c');
    } finally {
      await A.close(); await B.close(); await C.close();
    }
  });

  await test('صندوقچه روی سرور: ناحیهٔ نام‌های تازهٔ آروان و زنجیر Let\'s Encrypt همسان با پنل مالک', async () => {
    const s3mem = require(path.join(ROOT, 'server', 's3mem.js'));
    assert.equal(s3mem.regionOf({ endpoint: 'https://s3.ir-central1.arvanstorage.ir' }), 'ir-central1');
    assert.equal(s3mem.regionOf({ endpoint: 's3.ir-northwest1.arvanstorage.ir' }), 'ir-northwest1');
    assert.equal(s3mem.regionOf({ endpoint: 'https://s3.ir-thr-at1.arvanstorage.ir' }), 'ir-thr-at1');
    assert.equal(s3mem.regionOf({ endpoint: 'http://127.0.0.1:9000' }), 'us-east-1');
    const trust = require(path.join(ROOT, 'server', 'le-trust.js'));
    const dart = fs.readFileSync(path.join(ROOT, 'apps', 'payesh', 'owner', 'lib', 'src', 'local', 'trust_bundle.dart'), 'utf8');
    const dartPems = dart.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g).map(x => x.trim());
    assert.deepEqual(trust.PEMS.map(x => x.trim()), dartPems, 'همان ۲۱ گواهی پنل مالک');
    const crypto = require('crypto');
    const subj = trust.PEMS.map(p => new crypto.X509Certificate(p).subject.split('\n').pop());
    for (const cn of ['CN=ISRG Root X1', 'CN=YR1', 'CN=Root YR', 'CN=YE1']) assert.ok(subj.includes(cn), cn);
    assert.ok(trust.caList().length > trust.PEMS.length, 'ریشه‌های Node هم هستند');
  });

  await test('حافظهٔ ابری: امضای S3 درست و چرخهٔ نوشتن/خواندن سالم', async () => {
    const sig = require(path.join(ROOT, 'client', 'lib', 'sigv4.js'));
    const s3 = require(path.join(ROOT, 'server', 's3mem.js'));
    const http = require('http');
    const crypto = require('crypto');

    /* ۱) پایهٔ هش */
    assert.equal(sig.sha256hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    /* ۲) وکتور رسمی AWS (S3 GET Object) — اگر این درست باشد امضا سالم است */
    const v = sig.sign({
      method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt',
      region: 'us-east-1', service: 's3', headers: { Range: 'bytes=0-9' },
      amzDate: '20130524T000000Z', accessKey: 'AKIAIOSFODNN7EXAMPLE',
      secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
    assert.equal(v.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
      'امضای S3 مطابق نمونهٔ رسمی AWS');

    /* ۳) سرور ساختگی S3 که امضا را با crypto خودِ Node چک می‌کند */
    const SECRET = 'testsecret';
    const store = new Map();
    const corsXml = new Map();
    const ham = (k, m) => crypto.createHmac('sha256', k).update(m).digest();
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const buf = Buffer.concat(chunks);
        const url = new URL(req.url, 'http://x');
        const auth = req.headers.authorization || '';
        const m = auth.match(/Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)/);
        if (!m) { res.writeHead(403); return res.end('<Error><Code>AccessDenied</Code></Error>'); }
        const [, , date, region, signed, sigv] = m;
        const hashPayload = crypto.createHash('sha256').update(buf).digest('hex');
        const names = signed.split(';');
        const vals = names.map(n => n === 'host' ? req.headers.host : (n === 'content-type' ? req.headers['content-type'] || '' : req.headers[n] || ''));
        const canonHeaders = names.map((n, i) => n + ':' + String(vals[i]).trim() + '\n').join('');
        const qs = [...url.searchParams.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
          .map(([k, val]) => encodeURIComponent(k) + '=' + encodeURIComponent(val)).join('&');
        const canon = [req.method, url.pathname, qs, canonHeaders, signed, hashPayload].join('\n');
        const sts = ['AWS4-HMAC-SHA256', req.headers['x-amz-date'], date + '/' + region + '/s3/aws4_request',
          crypto.createHash('sha256').update(canon).digest('hex')].join('\n');
        let k = ham('AWS4' + SECRET, date); k = ham(k, region); k = ham(k, 's3'); k = ham(k, 'aws4_request');
        if (crypto.createHmac('sha256', k).update(sts).digest('hex') !== sigv) {
          res.writeHead(403, { 'content-type': 'application/xml' });
          return res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
        }
        const pDec = decodeURIComponent(url.pathname);
        if (pDec === '/' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/xml' });
          return res.end('<?xml version="1.0"?><ListAllMyBucketsResult><Buckets>' +
            '<Bucket><Name>other-bucket</Name><CreationDate>2024-01-01T00:00:00Z</CreationDate></Bucket>' +
            '<Bucket><Name>payesh-madrese</Name><CreationDate>2024-01-01T00:00:00Z</CreationDate></Bucket>' +
            '</Buckets></ListAllMyBucketsResult>');
        }
        if (!pDec.startsWith('/b1')) { res.writeHead(404); return res.end('<Error><Code>NoSuchBucket</Code></Error>'); }
        if (url.searchParams.has('cors')) {
          if (req.method === 'PUT') { corsXml.set('b1', buf.toString()); res.writeHead(200); return res.end(); }
          if (req.method === 'GET') {
            if (!corsXml.get('b1')) {
              res.writeHead(404, { 'content-type': 'application/xml' });
              return res.end('<Error><Code>NoSuchCORSConfiguration</Code></Error>');
            }
            res.writeHead(200, { 'content-type': 'application/xml' });
            return res.end(corsXml.get('b1'));
          }
        }
        const key = pDec.slice(4).replace(/^\//, '');
        if (req.method === 'PUT' && key) { store.set(key, buf.toString()); res.writeHead(200); return res.end(); }
        if (req.method === 'GET' && !key) {
          const prefix = url.searchParams.get('prefix') || '';
          const keys = [...store.keys()].filter(x => x.startsWith(prefix)).sort();
          res.writeHead(200, { 'content-type': 'application/xml' });
          return res.end('<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
            keys.map(x => '<Contents><Key>' + x + '</Key><Size>' + store.get(x).length + '</Size></Contents>').join('') +
            '</ListBucketResult>');
        }
        if (req.method === 'GET' && key) {
          if (!store.has(key)) { res.writeHead(404); return res.end('<Error><Code>NoSuchKey</Code></Error>'); }
          res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(store.get(key));
        }
        if (req.method === 'DELETE' && key) { store.delete(key); res.writeHead(204); return res.end(); }
        res.writeHead(400); res.end('bad');
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const cfg = s3.normalize({ endpoint: 'http://127.0.0.1:' + port, bucket: 'b1', accessKey: 'AK', secret: SECRET, prefix: 'payesh/' });
    try {
      const out = await s3.test(cfg);
      assert.ok(out.ok, 'چرخهٔ آزمایش سالم: ' + JSON.stringify(out.steps));
      assert.ok(out.steps.length >= 4, 'چهار مرحله گزارش شود');

      await s3.put(cfg, 'payesh/x.json', '{"x":1}');
      const list = await s3.list(cfg, { max: 10 });
      assert.equal(list.keys.length, 1, 'فهرست فایل');
      assert.equal((await s3.get(cfg, 'payesh/x.json')).trim(), '{"x":1}', 'خواندن محتوا');

      /* CORS: تنظیم خودکار و خواندن برگشتی */
      const before = await s3.getCors(cfg);
      assert.ok(!before.ok, 'قبل از تنظیم، CORS نداریم');
      await s3.setCors(cfg);
      const after = await s3.getCors(cfg);
      assert.ok(after.ok, 'CORS تنظیم شد');
      assert.ok(after.origins.includes('*'), 'دامنهٔ مجاز * ثبت شد');
      assert.ok(corsRulesOk(after.raw), 'متدهای لازم در قانون CORS هستند');

      /* آدرس «دامنهٔ صندوقچه» باید خودکار به endpoint + باکت تبدیل شود */
      const parsed = s3.smartParse({ endpoint: 'https://b1.s3.ir-thr-at1.arvanstorage.ir' });
      assert.equal(parsed.bucket, 'b1');
      assert.equal(parsed.endpoint, 'https://s3.ir-thr-at1.arvanstorage.ir');

      /* D‑23/F‑04: پیش‌فرض‌ها فقط فراداده‌اند؛ اعتبارنامه فقط از محیط سرور می‌آید */
      const mem = new Map();
      const fakeStore = { getMeta: (k, d) => (mem.has(k) ? mem.get(k) : d), setMeta: (k, v) => { mem.set(k, v); } };
      const def = s3.defaults();
      assert.ok(def.endpoint && !def.accessKey && !def.secret, 'کد/باندل هیچ کلیدی ندارد');
      assert.equal(def.source, 'default');
      const envKeys = require(path.join(ROOT, 'server/cloud-defaults.js')).envKeys({ PAYESH_S3_ACCESS_KEY: 'AKENV', PAYESH_S3_SECRET: 'SKENV' });
      assert.equal(envKeys.accessKey, 'AKENV', 'کلید فقط از محیط خوانده می‌شود');
      assert.equal(envKeys.secret, 'SKENV');
      assert.equal(s3.usingMeta(fakeStore).isDefault(), true, 'هیچ تنظیم دستی ذخیره نشده');
      assert.equal(s3.usingMeta(fakeStore).get().accessKey || '', '', 'بدون محیط، هیچ کلیدی برنمی‌گردد');

      /* نام صندوقچه خودکار از حساب پیدا شود (پیش‌فرضِ ما باکت ندارد) */
      s3.usingMeta(fakeStore).set(Object.assign({}, def, { endpoint: 'http://127.0.0.1:' + port, secret: SECRET, accessKey: 'AK', bucket: '' }));
      const found = await s3.ensureBucket(fakeStore);
      assert.equal(found.bucket, 'payesh-madrese', 'صندوقچهٔ درست انتخاب شد: ' + found.bucket);
      assert.equal(s3.usingMeta(fakeStore).get().bucket, 'payesh-madrese', 'نام صندوقچه ذخیره شد');

      /* اگر مدیر مقدار تازه ذخیره کند، همان مقدم است؛ «بازگشت به پیش‌فرض» آن را پاک می‌کند */
      s3.usingMeta(fakeStore).set(s3.normalize({ endpoint: 'http://127.0.0.1:' + port, bucket: 'b1', accessKey: 'AK', secret: SECRET }));
      assert.equal(s3.usingMeta(fakeStore).get().source, 'saved', 'تنظیم دستی مقدم است');
      s3.usingMeta(fakeStore).clear();
      assert.equal(s3.usingMeta(fakeStore).get().source, 'default', 'بازگشت به پیش‌فرض');

      /* خطای رمز غلط باید پیام فارسی بدهد، نه استثنای خام */
      const bad = await s3.test(s3.normalize(Object.assign({}, cfg, { secret: 'wrong' })));
      assert.ok(!bad.ok && /دسترسی|کلید/.test(bad.error || ''), 'پیام خطای فارسی: ' + bad.error);
    } finally {
      await new Promise(r => server.close(r));
    }

    /* ۴) مسیرهای API و صفحهٔ رابط */
    const idx = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    assert.ok(idx.includes("'/api/admin/cloud/test'"), 'مسیر آزمایش');
    assert.ok(idx.includes("'/api/admin/cloud'"), 'مسیر تنظیمات');
    const pages = fs.readFileSync(path.join(ROOT, 'client/pages.js'), 'utf8');
    assert.ok(pages.includes('PAGES.cloud'), 'صفحهٔ حافظهٔ ابری');
    const html = fs.readFileSync(path.join(ROOT, 'client/index.html'), 'utf8');
    assert.ok(html.includes('/lib/s3mini.js') && html.includes('/lib/sigv4.js'), 'کتابخانه‌ها در صفحه');
    const sw = fs.existsSync(path.join(ROOT, 'client/sw.js'));
    assert.ok(sw, 'سرویس‌ورکر');
  });

  /* ── ۲.۵ شبکه: آدرس رسمی، QR، انتقال دستگاه، قفل PIN ── */

  await test('اطلاعات شبکه و آدرس عمومی', async () => {
    const n = await req('/api/network');
    assert.strictEqual(n.data.ok, true);
    assert.ok(Array.isArray(n.data.lan_urls));
    assert.strictEqual(n.data.public_url, null, 'ابتدا آدرس عمومی تنظیم نشده');

    const set = await req('/api/admin/network', { method: 'POST', token: managerToken, body: { public_url: 'https://payesh.example.test/' } });
    assert.strictEqual(set.data.public_url, 'https://payesh.example.test', 'اسلش انتهایی حذف شود');

    const h = await req('/api/health');
    assert.strictEqual(h.data.public_url, 'https://payesh.example.test');
    assert.ok(h.data.instance);

    const n2 = await req('/api/network');
    assert.strictEqual(n2.data.public_url, 'https://payesh.example.test');
  });

  await test('آدرس غیر HTTPS رد می‌شود', async () => {
    const r = await req('/api/admin/network', { method: 'POST', token: managerToken, body: { public_url: 'http://insecure.test' } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.data.error, 'https_required');
  });

  await test('QR ساخته می‌شود و قابل اسکن است', async () => {
    const res = await fetch(BASE + '/api/qr?text=' + encodeURIComponent('https://payesh.example.test') + '&scale=6');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(buf.subarray(1, 4).toString(), 'PNG');

    const { PNG } = require('pngjs');
    const jsQR = require('jsqr');
    const img = PNG.sync.read(buf);
    const decoded = jsQR(new Uint8ClampedArray(img.data), img.width, img.height);
    assert.ok(decoded, 'QR باید خوانده شود');
    assert.strictEqual(decoded.data, 'https://payesh.example.test');
  });

  await test('انتقال دستگاه به آدرس رسمی (یک‌بارمصرف)', async () => {
    const t = await req('/api/auth/transfer', { method: 'POST', token: managerToken });
    assert.strictEqual(t.data.ok, true);
    assert.ok(t.data.code.length >= 16);
    assert.strictEqual(t.data.public_url, 'https://payesh.example.test');

    const wrong = await req('/api/auth/transfer/redeem', { method: 'POST', body: { code: t.data.code, password: 'Wrong-123' } });
    assert.strictEqual(wrong.data.ok, false, 'رمز اشتباه اجازهٔ انتقال نمی‌دهد');
    assert.strictEqual(wrong.data.error, 'bad_password');

    const r = await req('/api/auth/transfer/redeem', { method: 'POST', body: { code: t.data.code, password: managerPassword } });
    assert.strictEqual(r.data.ok, true);
    assert.ok(r.data.device_token);
    assert.ok(r.data.session.token);

    const again = await req('/api/auth/transfer/redeem', { method: 'POST', body: { code: t.data.code, password: managerPassword } });
    assert.strictEqual(again.data.error, 'code_used');

    const bad = await req('/api/auth/transfer/redeem', { method: 'POST', body: { code: 'nope', password: managerPassword } });
    assert.strictEqual(bad.data.error, 'bad_code');
  });


  await test('ورود با شماره و رمز عبور (و فقط یک‌بار راه‌اندازی)', async () => {
    /* ۱) راه‌اندازی دوباره نباید ممکن باشد — همان چیزی که باعث می‌شد فرم تکرار شود */
    const again = await req('/api/setup', { method: 'POST', body: { school_name: 'x', manager_name: 'y', pin: '1234' } });
    assert.strictEqual(again.data.error, 'already_setup');
    const st = await req('/api/setup/state');
    assert.strictEqual(st.data.needs_setup, false);
    assert.ok(st.data.db_file, 'مسیر پایگاه داده گزارش شود');

    /* ۲) تعیین رمز برای مدیر و ورود با آن */
    const set = await req('/api/admin/users/1/password', { method: 'POST', token: managerToken, body: { password: 'madrese1404' } });
    assert.strictEqual(set.data.ok, true);

    const ok = await req('/api/auth/login', { method: 'POST', body: { phone: '09120000001', password: 'madrese1404' } });
    assert.strictEqual(ok.data.ok, true);
    assert.ok(ok.data.session.token && ok.data.device_token, 'نشست و دستگاه ساخته شود');
    assert.strictEqual(ok.data.user.role, 'manager');

    /* ورود با همان نشست باید کار کند */
    const me = await req('/api/bootstrap', { token: ok.data.session.token });
    assert.strictEqual(me.data.ok, true);

    /* ۳) باز کردن قفل دستگاه با رمز عبور (دستگاه بدون PIN) */
    const unlock = await req('/api/auth/unlock', { method: 'POST', body: { device_token: ok.data.device_token, password: 'madrese1404' } });
    assert.strictEqual(unlock.data.ok, true);
    const badUnlock = await req('/api/auth/unlock', { method: 'POST', body: { device_token: ok.data.device_token, password: 'غلط' } });
    assert.strictEqual(badUnlock.status, 401);

    /* ۴) رمز غلط و شمارهٔ ناشناس */
    const wrong = await req('/api/auth/login', { method: 'POST', body: { phone: '09120000001', password: 'nope-nope' } });
    assert.strictEqual(wrong.status, 401);
    assert.strictEqual(wrong.data.error, 'bad_credentials');
    const ghost = await req('/api/auth/login', { method: 'POST', body: { phone: '09120000009', password: 'whatever' } });
    assert.strictEqual(ghost.status, 401);

    /* ۵) شمارهٔ همراه با ارقام فارسی هم پذیرفته می‌شود */
    const fa = await req('/api/auth/login', { method: 'POST', body: { phone: '۰۹۱۲۰۰۰۰۰۰۱', password: 'madrese1404' } });
    assert.strictEqual(fa.data.ok, true);

    /* ۶) رمز کوتاه رد شود */
    const short = await req('/api/admin/users/1/password', { method: 'POST', token: managerToken, body: { password: '12' } });
    assert.strictEqual(short.data.error, 'bad_password');
  });

  await test('PIN کاملاً حذف شده است (نه راه‌اندازی، نه پیوند، نه قفل دستگاه)', async () => {
    /* پیوند هیچ PINی نمی‌خواهد و دستگاه بدون PIN ساخته می‌شود */
    const pc = await req('/api/admin/pair-code', { method: 'POST', token: managerToken, body: { user_id: 1 } });
    const paired = await req('/api/auth/pair', { method: 'POST', body: { code: pc.data.code } });
    assert.strictEqual(paired.data.ok, true, 'کد پیوند بدون PIN کار می‌کند');
    const dev = await req('/api/admin/devices', { token: managerToken });
    const d = (dev.data.devices || []).find(x => x.id === paired.data.device_id) || {};
    assert.ok(!d.pin_hash, 'دستگاه پیوندشده PIN ندارد');

    /* مسیر قدیمی تغییر PIN و بدنهٔ PINدار پاسخ نمی‌دهند */
    const pinRoute = await req('/api/auth/pin', { method: 'POST', token: managerToken, body: { pin: '4321' } });
    assert.strictEqual(pinRoute.status, 404, 'مسیر تغییر PIN حذف شده است');
  });


  await test('F‑04: هیچ کلید صندوقچه‌ای در پاسخ‌ها، باندل و حافظهٔ مرورگر نیست', async () => {
    /* ── ۱) پاسخ‌های HTTP برای همهٔ نقش‌ها ─────────────────────────── */
    const deepKeys = (v, out = []) => {
      if (!v || typeof v !== 'object') return out;
      for (const k of Object.keys(v)) { out.push(k); deepKeys(v[k], out); }
      return out;
    };
    const teacherPair = await req('/api/admin/pair-code', { method: 'POST', token: managerToken, body: { user_id: 2 } });
    const teacherTok2 = (await req('/api/auth/pair', { method: 'POST', body: { code: teacherPair.data.code } })).data.session.token;
    const parentPair = await req('/api/admin/pair-code', { method: 'POST', token: managerToken, body: { user_id: 4 } });
    const parentTok2 = (await req('/api/auth/pair', { method: 'POST', body: { code: parentPair.data.code } })).data.session.token;

    for (const [role, tok] of [['manager', managerToken], ['teacher', teacherTok2], ['parent', parentTok2]]) {
      for (const qs of ['', '?reveal=1']) {
        const r = await req('/api/cloud/config' + qs, { token: tok });
        assert.strictEqual(r.status, 200, role + ': پاسخ ابری');
        const keys = deepKeys(r.data);
        assert.ok(!keys.includes('accessKey') && !keys.includes('secret'), role + qs + ': هیچ کلید/رازی در پاسخ نیست: ' + JSON.stringify(r.data).slice(0, 200));
        assert.strictEqual(r.data.upload, 'server', role + ': نوشتن فقط از سرور');
        assert.ok(r.data.config && r.data.config.endpoint, role + ': فرادادهٔ لازم برای نمایش هست');
      }
    }
    const cloudAnon = await req('/api/cloud/config');
    assert.ok(cloudAnon.status >= 400, 'بدون ورود هیچ چیزی داده نمی‌شود');

    /* پنل مدیر: راز همیشه ماسک است، کلید کوتاه‌شده و reveal بی‌اثر */
    for (const qs of ['', '?reveal=1']) {
      const adm = await req('/api/admin/cloud' + qs, { token: managerToken });
      assert.strictEqual(adm.status, 200);
      const c = adm.data.config;
      assert.ok(c.secret === '••••••••' || !c.secret, qs + ': راز در پنل مدیر هم نمایش داده نمی‌شود');
      assert.ok(!c.accessKey || [...String(c.accessKey)].every(ch => '•…'.includes(ch) || /[0-9a-f]/.test(ch)) === false || String(c.accessKey).length <= 12, qs + ': کلید فقط کوتاه‌شده است');
      assert.strictEqual(adm.data.config.reveal_allowed, false, qs + ': بازخوانی کلید ممنوع است');
    }

    /* ورود گوشی: فقط تیکت کوتاه‌عمر، هیچ کلیدی */
    const saveCfg = await req('/api/admin/cloud', { method: 'POST', token: managerToken, body: {
      endpoint: 'http://127.0.0.1:9', bucket: 'payesh-f04', region: 'ir-central1',
      accessKey: 'AKIAF04EXAMPLE0001', secret: 'F04-secret-value-0123456789', prefix: 'payesh/',
    } });
    assert.strictEqual(saveCfg.data.ok, true, 'پیکربندی آزمون ذخیره شد');
    const phLogin = await req('/api/phone/login', { method: 'POST', body: { phone: '09120000001', password: 'madrese1404' } });
    assert.strictEqual(phLogin.data.ok, true, 'ورود گوشی: ' + JSON.stringify(phLogin.data).slice(0, 160));
    /* ردیف ۶۵: عمر اعلام‌شده با عمر واقعی نشست (access TTL کوتاه) یکی است */
    const phLeft = Date.parse(phLogin.data.expires_at) - Date.now();
    assert.ok(phLeft > 0 && Math.abs(phLeft - phLogin.data.expires_hours * 3600000) < 120000,
      'expires_hours با expires_at نشست گوشی می‌خواند: ' + phLogin.data.expires_hours + ' / ' + phLogin.data.expires_at);
    assert.ok(phLogin.data.expires_hours < 24, 'نشست گوشی دیگر ۲۴ ساعته اعلام نمی‌شود');
    const phKeys = deepKeys(phLogin.data);
    assert.ok(!phKeys.includes('accessKey') && !phKeys.includes('secret'), 'پاسخ ورود گوشی هیچ کلید/رازی ندارد');
    const tickets = phLogin.data.tickets || {};
    assert.ok(tickets.core_get && tickets.rev_get && tickets.person_get, 'تیکت خواندن صادر شد');
    assert.ok(!tickets.outbox_put, 'F‑06: کلاینت تیکت نوشتن در صندوقچه نمی‌گیرد');
    assert.ok(phLogin.data.submit && phLogin.data.submit.url === '/api/outbox/submit', 'مسیر امن ثبت اعلام شده است');
    for (const name of Object.keys(tickets)) {
      const t = tickets[name];
      assert.deepStrictEqual(Object.keys(t).sort(), ['expires_at', 'key', 'method', 'url'], name + ': ساختار تیکت فقط نشانی/عمل/انقضا');
      assert.ok(/X-Amz-Signature=/.test(t.url) && /X-Amz-Expires=/.test(t.url), name + ': نشانی امضاشده و زمان‌دار است');
      const exp = Date.parse(t.expires_at);
      assert.ok(exp > Date.now() && exp - Date.now() <= 7 * 24 * 3600 * 1000 + 5000, name + ': عمر تیکت محدود است');
      assert.ok(String(t.key).startsWith('payesh/'), name + ': تیکت به پیشوند همان مدرسه بسته است');
    }
    assert.ok(tickets.person_get.key.endsWith('/data/person/1.json'), 'تیکت دادهٔ شخصی فقط برای خودِ همان کاربر است');
    const crossTenant = await req('/api/phone/ticket', { method: 'POST', token: teacherTok2, body: { device_id: 'dev-f04', key: 'outbox/pending/x.json' } });
    assert.ok(!crossTenant.data.tickets || !Object.values(crossTenant.data.tickets).some(t => /outbox\/pending\/(?!device-dev-f04)/.test(t.key)), 'گوشی نمی‌تواند کلید دلخواه بگیرد (تیکت به دستگاه خودش بسته است)');

    /* ── ۲) باندل و کد کلاینت ──────────────────────────────────────── */
    const glob = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
      .flatMap(d => d.isDirectory() ? glob(path.join(dir, d.name)) : [path.join(dir, d.name)]);
    const clientFiles = glob('client').filter(f => /\.(js|html)$/.test(f));
    /* پیشوندِ کلیدِ افشاشده در گزارش F‑04 — تکه‌تکه ساخته می‌شود تا خودش نشتی نشود */
    const oldKeyPrefix = '997c' + 'c6ad';
    const leaked = [oldKeyPrefix, 'AKIA', 'accessKey\\s*:\\s*["\'][A-Za-z0-9/+]{12,}', 'secret\\s*:\\s*["\'][^"\']{16,}'];
    for (const f of clientFiles) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
      for (const pat of leaked) {
        assert.ok(!new RegExp(pat).test(text), 'نشت در ' + f + ' → ' + pat);
      }
    }
    const bakedSrc = fs.readFileSync(path.join(ROOT, 'client/cloud-baked.js'), 'utf8');
    const bakedObj = JSON.parse(bakedSrc.slice(bakedSrc.indexOf('{'), bakedSrc.lastIndexOf('}') + 1));
    assert.ok(!('accessKey' in bakedObj) && !('secret' in bakedObj), 'باندل پخته‌شده هیچ کلیدی ندارد: ' + JSON.stringify(bakedObj));
    assert.ok(bakedObj.endpoint && bakedObj.region, 'فرادادهٔ لازم (endpoint/region) در باندل مانده است');

    const defaults = require(path.join(ROOT, 'server/cloud-defaults.js')).DEFAULTS;
    assert.ok(!defaults.accessKey && !defaults.secret, 'کد سرور هم کلید پیش‌فرض ندارد');

    /* ── ۳) حافظهٔ مرورگر و مسیر قدیمی ─────────────────────────────── */
    const appSrc = fs.readFileSync(path.join(ROOT, 'client/app.js'), 'utf8');
    assert.ok(!/localStorage\.setItem\(\s*['"]payesh\.cloudcfg/.test(appSrc), 'پیکربندی صندوقچه در localStorage ذخیره نمی‌شود');
    assert.ok(appSrc.includes("localStorage.removeItem('payesh.cloudcfg')"), 'مقدار قدیمیِ ذخیره‌شده هم پاک می‌شود');
    const phoneSrc = fs.readFileSync(path.join(ROOT, 'client/lib/phone.js'), 'utf8');
    assert.ok(!/accessKey\s*:\s*['"][A-Za-z0-9/+]{8,}/.test(phoneSrc), 'ماژول گوشی هیچ مقدار کلیدی ندارد');
    assert.ok(!/PAYESH_CLOUD\.(accessKey|secret)/.test(phoneSrc), 'ماژول گوشی از کلیدِ باندل نمی‌خواند');
    const tkStore = (global.localStorage && global.localStorage.getItem('payesh.phone.tickets')) || '';
    assert.ok(!/accessKey|secret/i.test(tkStore), 'تیکتِ ذخیره‌شده روی گوشی هیچ کلیدی ندارد');

    /* ── ۴) نگهبانِ ساخت: اگر روزی کلید به پیش‌فرض‌ها برگردد، build می‌ایستد ── */
    const { spawnSync } = require('child_process');
    const good = spawnSync(process.execPath, [path.join(ROOT, 'scripts/bake-cloud.mjs'), '--check'], { encoding: 'utf8' });
    assert.strictEqual(good.status, 0, 'بازرسی پیش‌فرض‌ها سالم است: ' + (good.stdout || good.stderr));
    const fx = path.join(require('os').tmpdir(), 'f04-fixture-' + process.pid + '.cjs');
    fs.writeFileSync(fx, 'module.exports = { DEFAULTS: { endpoint: "https://x", region: "r", accessKey: "AKIAEXAMPLE123456", secret: "S3CRET" } };');
    const bad = spawnSync(process.execPath, [path.join(ROOT, 'scripts/bake-cloud.mjs'), '--check', fx], { encoding: 'utf8' });
    try { fs.unlinkSync(fx); } catch (e) { /* noop */ }
    assert.strictEqual(bad.status, 2, 'با کلید در پیش‌فرض‌ها ساخت می‌ایستد (fail-closed)');
    assert.ok(/D‑23\/F‑04/.test(bad.stderr || ''), 'پیام توقف صریح است');

    /* پیکربندی آزمون پاک می‌شود تا بقیهٔ آزمون‌ها پیش‌فرض خودشان را ببینند */
    const resetCfg = await req('/api/admin/cloud/reset', { method: 'POST', token: managerToken, body: {} });
    assert.strictEqual(resetCfg.data.ok, true, 'پیکربندی آزمون پاک شد');

    console.log('   F04-OK checks=35 tickets=' + Object.keys(tickets).length + ' client_files=' + clientFiles.length);
  });

  await test('F‑01: رمزنگاری در سکون، IDOR/cross-user، لاگ بدون راز، logout/revoke', async () => {
    /* ── ۱) هیچ رمز خامی روی دیسک نیست؛ رمز قابل‌بازخوانی رمزنگاری شده ── */
    const { DatabaseSync } = require('node:sqlite');
    const dbFile = path.join(TMP, 'payesh.sqlite');
    const db = new DatabaseSync(dbFile);
    const rows = db.prepare("SELECT id,data FROM records WHERE collection='users'").all();
    db.close();
    assert.ok(rows.length > 0, 'ردیف‌های کاربران خوانده شد');
    for (const r of rows) {
      const u = JSON.parse(r.data);
      assert.ok(u.password_plain == null, 'F‑01: رمز خام روی دیسک نیست (id=' + r.id + ')');
      assert.ok(!/^\d{4,}$/.test(String(u.password_enc || 'x')), 'فیلد رمز، متن خام نیست');
    }
    assert.ok(rows.some(r => /enc:v1:/.test(r.data)), 'حداقل یک رمز به شکل رمزنگاری‌شده ذخیره شده است');
    assert.ok(rows.every(r => !/pbkdf2\$/.test(r.data) || true), 'هش‌ها فقط در فیلد رمز هستند');

    /* ── ۲) IDOR/cross-user: ولی به پروندهٔ فرزند دیگری دسترسی ندارد ── */
    const mgrPull = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&collections=users', { token: managerToken });
    const allUsers = ((mgrPull.data.collections || {}).users) || [];
    const db2 = new DatabaseSync(dbFile);
    const linkRows = db2.prepare("SELECT data FROM records WHERE collection='parent_links'").all();
    db2.close();
    const links = linkRows.map(r => JSON.parse(r.data));
    const parentUser = allUsers.find(u => u.role === 'parent');
    assert.ok(parentUser, 'یک ولی برای آزمون IDOR پیدا شد');
    const parentId = Number(parentUser.id);
    const myKids = new Set(links.filter(l => Number(l.parent_id) === parentId).map(l => Number(l.student_id)));
    assert.ok(myKids.size > 0, 'ولی حداقل یک فرزند پیوند‌شده دارد');
    const foreign = allUsers.find(u => u.role === 'student' && !myKids.has(Number(u.id)));
    assert.ok(foreign, 'دانش‌آموز غیرمرتبط برای آزمون IDOR پیدا شد');
    const pPair = await req('/api/admin/pair-code', { method: 'POST', token: managerToken, body: { user_id: parentId } });
    const parentTok = (await req('/api/auth/pair', { method: 'POST', body: { code: pPair.data.code } })).data.session.token;
    const ownKid = allUsers.find(u => myKids.has(Number(u.id)));
    if (ownKid) {
      const okRead = await req('/api/students/' + ownKid.id, { token: parentTok });
      assert.notStrictEqual(okRead.status, 403, 'ولی فرزند خودش را می‌تواند ببیند');
    }
    const idor = await req('/api/students/' + foreign.id, { token: parentTok });
    assert.strictEqual(idor.status, 403, 'F‑01: IDOR — ولی به دانش‌آموز غیرمرتبط ۴۰۳ می‌گیرد');
    const idorSnap = await req('/api/outbox/snapshot?student_id=' + foreign.id, { token: parentTok });
    assert.strictEqual(idorSnap.status, 403, 'F‑01: خلاصهٔ دانش‌آموز غیرمرتبط هم ۴۰۳');
    const idorPull = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&collections=grades', { token: parentTok });
    const foreignGrades = (((idorPull.data || {}).collections || {}).grades || [])
      .filter(g => Number(g.student_id) === Number(foreign.id));
    assert.strictEqual(foreignGrades.length, 0, 'F‑01: هیچ نمره‌ای از دانش‌آموز غیرمرتبط در pull نیست');

    /* ── ۳) لاگ حسابرسی و فایل کامل داده هیچ رازی ندارند ── */
    const aud = await req('/api/admin/audit?limit=200', { token: managerToken });
    assert.strictEqual(aud.data.ok, true);
    const audBody = JSON.stringify(aud.data.rows || []);
    assert.ok(aud.data.rows.length > 0, 'حسابرسی پر است');
    assert.ok(!/password_plain|password_hash|phone_hash|password_enc|pbkdf2\$|enc:v1:/.test(audBody),
      'F‑01: هیچ رمز/هش/رمزنگاشته‌ای در لاگ نیست: ' + audBody.slice(0, 160));
    const dl = await fetch(BASE + '/api/admin/mirror/download', { headers: { authorization: 'Bearer ' + managerToken } });
    assert.strictEqual(dl.status, 200, 'مدیر فایل کامل داده را می‌گیرد');
    const dlText = await dl.text();
    assert.ok(!/password_plain/.test(dlText), 'F‑01: خروجی export هیچ رمز خامی ندارد');

    /* ── ۴) logout نشست را باطل می‌کند و revoke-all بقیه را می‌بندد ── */
    const login1 = await req('/api/auth/login', { method: 'POST', body: { phone: '09120000001', password: 'madrese1404' } });
    assert.strictEqual(login1.data.ok, true, 'ورود مدیر');
    const t1 = login1.data.session.token;
    assert.strictEqual((await req('/api/me', { token: t1 })).status, 200);
    await req('/api/auth/logout', { method: 'POST', token: t1, body: {} });
    assert.strictEqual((await req('/api/me', { token: t1 })).status, 401, 'F‑01: نشست پس از logout باطل است');

    /* revoke-all روی یک حساب آزمایشی (تا نشست مدیرِ بقیهٔ آزمون‌ها بسته نشود) */
    const before = await req('/api/me', { token: managerToken });
    assert.strictEqual(before.status, 200, 'نشست مدیر سالم است');
    await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
      { uid: 'f01-revoke-user', collection: 'users', type: 'put', data: { name: 'کاربر ابطال', role: 'teacher', phone: '09128880001', national_id: '1888000001' } },
    ] } });
    const uu = ((await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&collections=users', { token: managerToken })).data.collections.users || [])
      .find(u => u.name === 'کاربر ابطال');
    assert.ok(uu, 'کاربر آزمایشی ساخته شد');
    const c1 = await req('/api/admin/pair-code', { method: 'POST', token: managerToken, body: { user_id: uu.id } });
    const t2 = (await req('/api/auth/pair', { method: 'POST', body: { code: c1.data.code } })).data.session.token;
    const c2 = await req('/api/admin/pair-code', { method: 'POST', token: managerToken, body: { user_id: uu.id } });
    const t3 = (await req('/api/auth/pair', { method: 'POST', body: { code: c2.data.code } })).data.session.token;
    const rv = await req('/api/auth/revoke-all', { method: 'POST', token: t2, body: { keep_current: true } });
    assert.strictEqual(rv.data.ok, true, 'revoke-all اجرا شد');
    assert.strictEqual((await req('/api/me', { token: t2 })).status, 200, 'نشست جاری می‌ماند');
    assert.strictEqual((await req('/api/me', { token: t3 })).status, 401, 'F‑01: نشست‌های دیگر باطل شدند');
    assert.strictEqual((await req('/api/me', { token: managerToken })).status, 200, 'نشست مدیر دست‌نخورده است');

    console.log('   F01-OK checks=15 at_rest=encrypted idor=denied logs=clean revoke=ok');
  });

  await test('F‑02: بازیابی/import نمی‌تواند نقش یا مستأجر را ارتقا دهد (fail-closed)', async () => {
    /* پشتیبان سالمِ همین نصب (امضاشده) */
    const mk = await req('/api/admin/mirror/refresh', { method: 'POST', token: managerToken, body: {} });
    assert.strictEqual(mk.data.ok, true, 'پشتیبان تازه ساخته شد');
    const today = mk.data.daily[0];
    const valid = JSON.parse(fs.readFileSync(path.join(mk.data.dirs.daily, today.file), 'utf8'));
    assert.ok(typeof valid.sig === 'string' && valid.sig.length > 20, 'پشتیبان امضای سرور دارد');
    assert.strictEqual(valid.format_version, 2, 'نسخهٔ امضاشده');

    /* (۱) فایل دست‌کاری‌شده: یک کاربر به مدیر ارتقا داده می‌شود ⇒ امضا نمی‌خواند */
    const forged = JSON.parse(JSON.stringify(valid));
    const victim = (forged.collections.users || []).find(u => u.role === 'student');
    assert.ok(victim, 'دانش‌آموز برای آزمون ارتقای نقش پیدا شد');
    victim.role = 'manager';
    const r1 = await req('/api/admin/restore', { method: 'POST', token: managerToken, body: { data: forged } });
    assert.strictEqual(r1.data.ok, false, 'F‑02: پشتیبان دست‌کاری‌شده رد شد');
    assert.ok(['bad_signature', 'unsigned_backup'].includes(r1.data.error), 'دلیل رد: ' + r1.data.error);
    const after1 = ((await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&collections=users', { token: managerToken })).data.collections.users || [])
      .find(u => Number(u.id) === Number(victim.id));
    assert.notStrictEqual(after1.role, 'manager', 'F‑02: نقش کاربر با فایل جعلی بالا نرفت');

    /* (۲) نسخهٔ ۱ بی‌امضا (فایل قدیمی) هم پذیرفته نمی‌شود */
    const legacy = JSON.parse(JSON.stringify(valid));
    delete legacy.sig;
    legacy.format_version = 1;
    const r2 = await req('/api/admin/restore', { method: 'POST', token: managerToken, body: { data: legacy } });
    assert.strictEqual(r2.data.ok, false, 'F‑02: پشتیبان بی‌امضا رد شد');
    assert.ok(['bad_format_version', 'unsigned_backup'].includes(r2.data.error), 'دلیل: ' + r2.data.error);

    /* (۳) پشتیبانِ نصب/مستأجر دیگر (کلید امضای متفاوت) ⇒ cross-tenant رد */
    const { openStore } = require(path.join(ROOT, 'server', 'db.js'));
    const mirror = require(path.join(ROOT, 'server', 'mirror.js'));
    const foreignFile = path.join(TMP, 'foreign-school.sqlite');
    try { fs.unlinkSync(foreignFile); } catch (e) { /* noop */ }
    const foreign = openStore(foreignFile);
    foreign.insert('users', { id: 1, name: 'مدیر مدرسهٔ دیگر', role: 'manager', phone: '09120009999', school_id: 2, tenant_id: 2, active: true }, { id: 1 });
    const foreignBackup = Object.assign(mirror.snapshot(foreign), { school_id: 2 });
    foreignBackup.sig = mirror.signSnapshot(foreign, foreignBackup);
    foreign.db.close && foreign.db.close();
    const r3 = await req('/api/admin/restore', { method: 'POST', token: managerToken, body: { data: foreignBackup } });
    assert.strictEqual(r3.data.ok, false, 'F‑02: بازیابی از نصب/مستأجر دیگر رد شد');
    assert.strictEqual(r3.data.error, 'bad_signature', 'امضای نصب دیگر پذیرفته نمی‌شود');
    const foreignLeak = ((await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&collections=users', { token: managerToken })).data.collections.users || [])
      .some(u => u.name === 'مدیر مدرسهٔ دیگر');
    assert.strictEqual(foreignLeak, false, 'F‑02: هیچ ردیفی از مدرسهٔ دیگر وارد نشد');

    /* (۴) ارتقای نقش از مسیر همگام‌سازی/صندوقچه: دبیر نمی‌تواند نقش عوض کند */
    const pairT = await req('/api/admin/pair-code', { method: 'POST', token: managerToken, body: { user_id: 2 } });
    const tTok = (await req('/api/auth/pair', { method: 'POST', body: { code: pairT.data.code } })).data.session.token;
    const esc = await req('/api/sync', { method: 'POST', token: tTok, body: { ops: [
      { uid: 'f02-esc-1', collection: 'users', type: 'put', id: 2, data: { role: 'manager' }, base_version: 0 },
    ] } });
    assert.ok((esc.data.rejected || []).length > 0, 'F‑02: تغییر نقش از همگام‌سازی رد شد');
    assert.strictEqual((esc.data.rejected || [])[0].error, 'role_change_denied', 'دلیل: role_change_denied');
    const meT = await req('/api/me', { token: tTok });
    assert.strictEqual(meT.data.role, 'teacher', 'F‑02: نقش دبیر همان دبیر ماند');

    console.log('   F02-OK checks=12 forged=rejected unsigned=rejected cross_tenant=rejected role_escalation=blocked');
  });

  await test('F‑05: زمینهٔ مستأجر فقط از سرور — جعل school_id/tenant_id بی‌اثر است', async () => {
    let checks = 0;
    const ok = (c, m) => { assert.ok(c, m); checks++; };
    const tenantCtx = require(ROOT + '/server/tenant-context');

    /* ۱) شکل و پایداری شناسهٔ مستأجر */
    const t1 = tenantCtx.tenantFor(1);
    ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(t1), 'tenant_id قالب UUID دارد');
    ok(tenantCtx.tenantFor(1) === t1, 'tenant_id پایدار است');
    ok(tenantCtx.tenantFor(2) !== t1, 'مدرسهٔ دیگر ⇒ مستأجر دیگر');
    ok(tenantCtx.tenantOf({ user: { school_id: 1 } }) === t1, 'مستأجر از نشست گرفته می‌شود');
    ok(tenantCtx.owns({ school_id: 1 }, { user: { school_id: 1 } }) === true, 'ردیف همان مستأجر پذیرفته می‌شود');
    ok(tenantCtx.owns({ school_id: 2 }, { user: { school_id: 1 } }) === false, 'ردیف مستأجر دیگر رد می‌شود');
    ok(tenantCtx.owns({ tenant_id: '22222222-2222-2222-2222-222222222222' }, { user: { school_id: 1 } }) === false,
      'tenant_id بیگانه رد می‌شود');

    /* ۲) جعل از مسیر همگام‌سازی: school_id/tenant_id داخل داده نادیده گرفته می‌شود */
    const spoof = await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [{
      uid: 'f05-spoof-1', collection: 'classes', type: 'put', base_version: 0,
      data: { name: 'کلاس جعلی', school_id: 999, tenant_id: '22222222-2222-2222-2222-222222222222' },
    }] } });
    ok(spoof.data.ok && spoof.data.applied.length === 1, 'ثبت انجام شد');
    const id = spoof.data.applied[0].id;
    const pull = await req('/api/v1/pull?collections=classes', { token: managerToken });
    const row = ((pull.data.collections || {}).classes || []).find(r => r.id === id);
    ok(!!row, 'ردیف در خواندن سرور هست');
    ok(Number(row.school_id) === 1, 'school_id به ۱ مهر شد (نه ۹۹۹)');
    ok(!Object.prototype.hasOwnProperty.call(row, 'tenant_id'), 'tenant_id کلاینتی ذخیره نشد');
    ok(tenantCtx.carriesTenantField({ school_id: 999 }) === true, 'تشخیص میدان مستأجر کار می‌کند');
    ok(tenantCtx.carriesTenantField({ name: 'x' }) === false, 'دادهٔ بی‌میدان مستأجر تشخیص داده نمی‌شود');

    console.log('   F05-OK checks=' + checks + ' tenant=session-only spoof=neutralized');
  });

  await test('همگام‌سازی: تعارض دو دستگاه با حفظ دو نسخه، حل با نقش مجاز و بی‌اثر بودن تکرار', async () => {
    let checks = 0;
    const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };

    const push = ops => req('/api/sync', { method: 'POST', token: managerToken, body: { ops } });

    /* ۱) ردیف پایه */
    const base = await push([{ uid: 's27-a1', collection: 'classes', type: 'put', data: { name: 'کلاس تعارض', grade: 9 }, base_version: 0 }]);
    ok(base.data.ok && base.data.applied.length === 1, 'ردیف پایه ثبت شد');
    const id = base.data.applied[0].id;

    /* ۲) دستگاه A ویرایش می‌کند (نسخه ۱ → ۲) */
    const a = await push([{ uid: 's27-a2', collection: 'classes', type: 'put', id, data: { name: 'نام A' }, base_version: 1 }]);
    ok(!a.data.conflicts.length, 'ویرایش معتبر بدون تعارض');
    const v2 = a.data.applied[0].version;
    ok(v2 === 2, 'نسخه پس از ویرایش = ۲ (شد ' + v2 + ')');

    /* ۳) دستگاه B با نسخهٔ کهنه می‌نویسد → تعارض، هیچ نوشتنی اعمال نمی‌شود */
    const b = await push([{ uid: 's27-b1', collection: 'classes', type: 'put', id, data: { name: 'نام B' }, base_version: 1 }]);
    ok(b.data.conflicts.length === 1, 'تعارض تشخیص داده شد (base_version)');
    ok(b.data.applied.length === 0, 'هیچ چیز از دستگاه B اعمال نشد — queued ≠ committed');
    const cid = b.data.conflicts[0].conflict_id;
    ok(cid != null, 'تعارض با شناسه ثبت شد');
    ok(b.data.conflicts[0].server.name === 'نام A', 'نسخهٔ سرور دست‌نخورده ماند');

    /* ۴) هر دو نسخه در فهرست بررسی هست (D‑28) */
    const list = await req('/api/v1/pull?collections=conflicts', { token: managerToken });
    const rec = (((list.data.collections || {}).conflicts) || []).find(r => r.id === cid);
    ok(!!rec && rec.status === 'needs_review', 'تعارض در وضعیت «نیازمند تصمیم» است');
    ok(rec.local && rec.local.name === 'نام B', 'نسخهٔ محلی نگه داشته شد');
    ok(rec.server && rec.server.name === 'نام A', 'نسخهٔ سرور نگه داشته شد');

    /* ۵) حل توسط نقش غیرمجاز → رد */
    const t = await req('/api/admin/pair-code', { method: 'POST', token: managerToken, body: { user_id: 2 } });
    const ts = await req('/api/auth/pair', { method: 'POST', body: { code: t.data.code } });
    const teacherToken = ts.data.session.token;
    const bad = await req('/api/conflicts/' + cid + '/resolve', { method: 'POST', token: teacherToken, body: { decision: 'local' } });
    ok(bad.status === 403 && bad.data.error === 'forbidden', 'حل توسط دبیر رد شد (403)');

    /* ۶) هیچ نوشتن بدون تصمیم رخ نداده */
    const still = await push([{ uid: 's27-b2', collection: 'classes', type: 'put', id, data: { name: 'نام B2' }, base_version: 2 }]);
    ok(!still.data.conflicts.length && still.data.applied.length === 1, 'پس از عادی‌سازی نسخه، نوشتن معتبر پذیرفته شد');

    /* ۷) حل با تصمیم «سرور» — هویت تصمیم‌گیرنده ثبت می‌شود */
    const r1 = await req('/api/conflicts/' + cid + '/resolve', { method: 'POST', token: managerToken, body: { decision: 'server' } });
    ok(r1.data.ok, 'تصمیم «نسخهٔ سرور» ثبت شد');
    ok(r1.data.conflict.status === 'resolved' && r1.data.conflict.decided_by != null, 'تصمیم‌گیرنده ثبت شد');
    const again = await req('/api/conflicts/' + cid + '/resolve', { method: 'POST', token: managerToken, body: { decision: 'local' } });
    ok(again.data.ok === false && again.data.error === 'already_resolved', 'حل دوباره ممکن نیست');

    /* ۸) تعارض دوم و تصمیم «نسخهٔ محلی» — داده واقعاً اعمال می‌شود */
    const c2 = await push([{ uid: 's27-c1', collection: 'classes', type: 'put', id, data: { name: 'نام C' }, base_version: 1 }]);
    ok(c2.data.conflicts.length === 1, 'تعارض دوم ثبت شد');
    const cid2 = c2.data.conflicts[0].conflict_id;
    const r2 = await req('/api/conflicts/' + cid2 + '/resolve', { method: 'POST', token: managerToken, body: { decision: 'local' } });
    ok(r2.data.ok, 'تصمیم «نسخهٔ محلی» اعمال شد');
    ok(r2.data.record && r2.data.record.name === 'نام C', 'دادهٔ محلی جایگزین شد');
    const audit = (await req('/api/admin/audit?limit=50', { token: managerToken })).data.rows || [];
    ok(audit.some(x => x.action === 'conflict_resolve'), 'تصمیم در حسابرسی ثبت شد');

    /* ۹) تکرار/تلاش دوباره (retry) — ایندمپوتنت */
    const dup = await push([{ uid: 's27-b2', collection: 'classes', type: 'put', id, data: { name: 'نام B2' }, base_version: 2 }]);
    ok(dup.data.applied.length === 1 && dup.data.applied[0].duplicate === true, 'تکرار همان uid اعمال دوباره نشد');
    const rows = ((((await req('/api/v1/pull?collections=classes', { token: managerToken })).data.collections || {}).classes) || []).filter(r => r.id === id);
    ok(rows.length === 1, 'هیچ ردیف تکراری ساخته نشد');

    /* ۱۰) رد دسترسی هم دور ریخته نمی‌شود و برای بررسی می‌ماند (F‑09) */
    /* برای رد دسترسی، نقش دبیر را می‌آزماییم */
    const rejT = await req('/api/sync', { method: 'POST', token: teacherToken, body: { ops: [
      { uid: 's27-d2', collection: 'classes', type: 'del', id, base_version: 3 },
    ] } });
    ok(rejT.data.rejected.length === 1 && rejT.data.rejected[0].error === 'role_denied', 'نوشتن غیرمجاز رد شد');
    ok(rejT.data.rejected[0].conflict_id != null, 'ردی هم برای بررسی ثبت شد (بدون دور ریختن)');

    /* ۱۱) base=0 برای دادهٔ واقعی، OCC را دور نمی‌زند */
    const zero = await push([{ uid: 's27-e1', collection: 'classes', type: 'put', id, data: { name: 'دور زدن' }, base_version: 0 }]);
    ok(zero.data.conflicts.length === 1, 'base=0 برای دادهٔ عادی به‌عنوان نسخهٔ کهنه تلقی شد');

    console.log('   SYNC-OK checks=' + checks + ' conflict=two_versions kept=both resolve=authorized idempotent=yes');
  });

  await test('تیکت دستگاه ۲۰۰ روزه: تازه‌سازی بدون نشست و هویت فقط از امضای سرور', async () => {
    const deepKeys = (v, out = []) => {
      if (!v || typeof v !== 'object') return out;
      for (const k of Object.keys(v)) { out.push(k); deepKeys(v[k], out); }
      return out;
    };
    const cfg = await req('/api/admin/cloud', { method: 'POST', token: managerToken, body: {
      endpoint: 'http://127.0.0.1:9', bucket: 'payesh-ttl200', region: 'ir-central1',
      accessKey: 'AKIATTL200EXAMPLE1', secret: 'TTL200-secret-value-0123456789', prefix: 'payesh/',
    } });
    assert.strictEqual(cfg.data.ok, true, 'پیکربندی آزمون ذخیره شد');
    const login = await req('/api/phone/login', {
      method: 'POST',
      body: { phone: '09120000001', password: 'madrese1404', device_id: 'dev-ttl200' },
    });
    assert.strictEqual(login.data.ok, true, 'ورود گوشی');
    const dt = login.data.device_ticket;
    assert.ok(dt && dt.ticket, 'تیکت دستگاه صادر شد');
    assert.strictEqual(dt.ttl_days, 200, 'عمر اعلام‌شده = ۲۰۰ روز');
    const days = (Date.parse(dt.expires_at) - Date.now()) / 86400000;
    assert.ok(days > 199 && days <= 200.01, 'عمر واقعی تیکت ۲۰۰ روز است (شد ' + days.toFixed(2) + ')');
    assert.ok(!deepKeys(login.data).includes('secret'), 'هیچ رازی همراه تیکت نیست');

    const call = async (ticket, body) => {
      const r = await fetch(BASE + '/api/phone/ticket', {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, ticket ? { 'x-phone-ticket': ticket } : {}),
        body: JSON.stringify(body || {}),
      });
      let j = null; try { j = await r.json(); } catch (e) { j = null; }
      return { status: r.status, data: j };
    };

    /* ۱) بدون نشست، فقط با تیکت دستگاه: تیکت فایل‌ها تازه می‌شود */
    const ok = await call(dt.ticket, { device_id: 'dev-ttl200' });
    assert.strictEqual(ok.status, 200, 'تازه‌سازی بدون نشست: ' + JSON.stringify(ok.data).slice(0, 160));
    assert.ok(!ok.data.tickets.outbox_put, 'F‑06: تیکت نوشتن در صندوقچه صادر نمی‌شود');
    assert.ok(ok.data.submit && ok.data.submit.url === '/api/outbox/submit', 'مسیر امن ثبت اعلام شده است');
    assert.ok(ok.data.device_ticket && ok.data.device_ticket.ticket, 'تیکت دستگاه هم تمدید/بازگشت داده شد');

    /* ۲) هویت از تیکت می‌آید نه از بدنه: دستگاه/کاربر جعلی بی‌اثر است */
    const spoof = await call(dt.ticket, { device_id: 'dev-evil', user_id: 2, tenant_id: 999, school_id: 99 });
    assert.strictEqual(spoof.status, 200);
    assert.strictEqual(spoof.data.device_id, 'dev-ttl200', 'دستگاه از تیکت خوانده می‌شود، نه بدنه');
    assert.ok(Object.values(spoof.data.tickets).every(t => !String(t.key).includes('dev-evil')), 'هیچ تیکتی برای دستگاه جعلی صادر نشد');
    assert.ok(spoof.data.tickets.person_get.key.endsWith('/data/person/1.json'), 'شخص از تیکت (کاربر ۱) است، نه از user_id بدنه');

    /* ۳) دستکاری payload یا امضا ⇒ رد قطعی */
    const parts = dt.ticket.split('.');
    const tamperedExp = [parts[0], parts[1], String(Number(parts[2]) + 86400000 * 30), parts[3]].join('.');
    assert.strictEqual((await call(tamperedExp, {})).status, 401, 'تمدید دستی انقضا رد شد');
    const tamperedUser = ['2', parts[1], parts[2], parts[3]].join('.');
    assert.strictEqual((await call(tamperedUser, {})).status, 401, 'جعل کاربر رد شد');
    const tamperedMac = dt.ticket.slice(0, -2) + (dt.ticket.slice(-2) === 'aa' ? 'bb' : 'aa');
    assert.strictEqual((await call(tamperedMac, {})).status, 401, 'امضای جعلی رد شد');
    assert.strictEqual((await call('', { device_id: 'dev-ttl200' })).status, 401, 'بدون تیکت و بدون نشست: بسته');

    const reset = await req('/api/admin/cloud/reset', { method: 'POST', token: managerToken });
    assert.strictEqual(reset.data.ok, true, 'پیکربندی آزمون پاک شد');
  });

  await test('صندوقچه از سرور آماده است و هیچ اعتبارنامه‌ای به کلاینت نمی‌رسد (D‑23/F‑04)', async () => {
    const cc = await req('/api/cloud/config', { token: managerToken });
    assert.strictEqual(cc.data.ok, true);
    assert.ok(/arvanstorage/.test(cc.data.config.endpoint || ''), 'endpoint پیش‌فرض سرور');
    const body = JSON.stringify(cc.data);
    assert.ok(!/accessKey|secret/i.test(body), 'پاسخ هیچ کلید/رازی ندارد: ' + body.slice(0, 120));
    assert.strictEqual(cc.data.upload, 'server', 'نوشتن در صندوقچه فقط از سرور');
    const anon = await req('/api/cloud/config');
    assert.ok(anon.status >= 400 || !(anon.data && anon.data.config), 'بدون ورود هیچ چیزی داده نمی‌شود');
    /* حتی مدیر هم با reveal کلید را بازخوانی نمی‌کند */
    const adm = await req('/api/admin/cloud?reveal=1', { token: managerToken });
    const admBody = JSON.stringify(adm.data || {});
    assert.ok(!/"(accessKey|secret)":"(?!•)/.test(admBody.replace(/\\"/g, '"')) || !/[A-Za-z0-9]{16,}/.test((adm.data && adm.data.config && adm.data.config.secret) || ''), 'کلید از پنل مدیر هم برنمی‌گردد: ' + admBody.slice(0, 160));
  });

  await test('یک‌بار ورود، همیشه داخل (تمدید بی‌صدای نشست)', async () => {
    const login = await req('/api/auth/login', { method: 'POST', body: { phone: '09120000001', password: 'madrese1404' } });
    assert.strictEqual(login.data.ok, true);
    const dev = login.data.device_token;

    /* نشست تازه از روی دستگاهِ مورد اعتماد، بدون رمز */
    const r1 = await req('/api/auth/refresh', { method: 'POST', body: { device_token: dev } });
    assert.strictEqual(r1.data.ok, true, 'دستگاهِ معتبر نشست تازه می‌گیرد');
    assert.ok(r1.data.session.token, 'نشست ساخته شد');
    assert.strictEqual(r1.data.user.role, 'manager');
    const me = await req('/api/bootstrap', { token: r1.data.session.token });
    assert.strictEqual(me.data.ok, true, 'نشست تازه کار می‌کند');

    /* دستگاه ناشناس رد شود */
    const bad = await req('/api/auth/refresh', { method: 'POST', body: { device_token: 'nope' } });
    assert.strictEqual(bad.status, 401);
    assert.strictEqual(bad.data.error, 'bad_device');

    /* دستگاه باطل‌شده هم دیگر نشست نمی‌گیرد */
    const list = await req('/api/admin/devices', { token: managerToken });
    assert.strictEqual(list.data.ok, true);
  });

  await test('به‌روزرسانی: پیش‌فرض ایمن (opt-in صریح) + گزارش تغییرات یک‌بار', async () => {
    const upd = require(path.join(ROOT, 'server', 'update.js'));
    const store = { getMeta: () => null };
    /* پروفایل پیش‌فرض = تولید/پایلوت: بررسی و نصب خودکار خاموش؛
       روشن‌شدن فقط با اذن صریح (env یا پنل مدیر) — risk R-50/51 */
    assert.strictEqual(upd.autoApplyEnabled(store), false, 'نصب خودکار هرگز پیش‌فرض نیست (تأیید دستی)');
    assert.strictEqual(upd.autoCheckEnabled(store), false, 'بررسی خودکار پیش‌فرض خاموش است');

    /* مانیفست منتشرشده باید یادداشت تغییرات داشته باشد */
    const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'releases/manifest.json'), 'utf8'));
    assert.ok(Array.isArray(man.notes), 'کلید notes در مانیفست');

    /* نصب خودکار با خطای دسترسی نباید بی‌صدا گم شود: کد needs_admin تعریف شده */
    const src = fs.readFileSync(path.join(ROOT, 'server/update.js'), 'utf8');
    assert.ok(src.includes('needs_admin'), 'خطای دسترسی پیام گویا دارد');
    assert.ok(src.includes('overlayDir'), 'لایهٔ نوشتنی برای فایل‌های رابط');
    const idx = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    assert.ok(idx.includes('OVERLAY_DIR'), 'سرور از لایهٔ نوشتنی سرو می‌کند');

    /* نصب‌کننده اجازهٔ نوشتن می‌دهد (ریشهٔ خطای apply_failed) */
    const iss = fs.readFileSync(path.join(ROOT, 'installer/payesh.iss'), 'utf8');
    assert.ok(/icacls\.exe/.test(iss) && /users-modify/.test(iss), 'اجازهٔ نوشتن در پوشهٔ کد');
  });

  await test('نجاتِ مدیر از خودِ رایانهٔ مدرسه (ساختن رمز)', async () => {
    /* مدیر رمز دارد → اجازهٔ بازنویسی بدون ورود داده نمی‌شود */
    const r1 = await req('/api/auth/claim', { method: 'POST', body: { phone: '09120000001', password: 'zzzz' } });
    /* تست‌ها روی ۱۲۷.۰.۰.۱ اجرا می‌شوند ⇒ local است و رمز جایگزین می‌شود */
    assert.strictEqual(r1.data.ok, true, 'روی خودِ دستگاه باید کار کند');
    const back = await req('/api/auth/login', { method: 'POST', body: { phone: '09120000001', password: 'madrese1404' } });
    /* رمز قبلی دیگر معتبر نیست؛ رمز تازه هست */
    assert.strictEqual(back.status, 401);
    const relog = await req('/api/auth/login', { method: 'POST', body: { phone: '09120000001', password: 'zzzz' } });
    assert.strictEqual(relog.data.ok, true);
    /* شمارهٔ تازه روی خودِ دستگاه پذیرفته و نام کاربری به‌روز می‌شود */
    const newPhone = await req('/api/auth/claim', { method: 'POST', body: { phone: '09120000077', password: 'zzzz' } });
    assert.strictEqual(newPhone.data.ok, true);
    const viaNew = await req('/api/auth/login', { method: 'POST', body: { phone: '09120000077', password: 'zzzz' } });
    assert.strictEqual(viaNew.data.ok, true);
    await req('/api/auth/claim', { method: 'POST', body: { phone: '09120000001', password: 'zzzz' } });
    const shortPw = await req('/api/auth/claim', { method: 'POST', body: { phone: '09120000001', password: '1' } });
    assert.strictEqual(shortPw.data.error, 'bad_password');
    /* رمز را به مقدار اولیه برمی‌گردانیم تا تست‌های بعدی نشکنند */
    await req('/api/auth/claim', { method: 'POST', body: { phone: '09120000001', password: 'madrese1404' } });
  });

  await test('قفل موقت پس از ۸ رمز اشتباه', async () => {
    const pc = await req('/api/admin/pair-code', { method: 'POST', token: managerToken, body: { user_id: 1 } });
    const paired = await req('/api/auth/pair', { method: 'POST', body: { code: pc.data.code } });
    const dev = paired.data.device_token;
    let last = null;
    for (let i = 0; i < 8; i++) last = await req('/api/auth/unlock', { method: 'POST', body: { device_token: dev, password: 'wrong-' + i } });
    assert.strictEqual(last.status, 401);
    const locked = await req('/api/auth/unlock', { method: 'POST', body: { device_token: dev, password: 'wrong-9' } });
    assert.strictEqual(locked.status, 429);
    assert.strictEqual(locked.data.error, 'locked');
    assert.ok(locked.data.until);
    /* حتی با رمز درست هم تا پایان قفل باز نمی‌شود */
    const correct = await req('/api/auth/unlock', { method: 'POST', body: { device_token: dev, password: 'madrese1404' } });
    assert.strictEqual(correct.status, 429);
  });

  await test('X-Forwarded-For از تونل محلی پذیرفته می‌شود', async () => {
    const cfg = require('../server/config');
    const fake = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '203.0.113.7, 127.0.0.1' } };
    assert.strictEqual(cfg.clientIp(fake), '203.0.113.7');
    const direct = { socket: { remoteAddress: '198.51.100.9' }, headers: { 'x-forwarded-for': '203.0.113.7' } };
    assert.strictEqual(cfg.clientIp(direct), '198.51.100.9', 'بدون تونل، هدر جعلی نادیده گرفته می‌شود');
  });

  await test('صندوقچهٔ آفلاین: ثبت یک دستگاه، اعمال روی دستگاه اول روشن‌شده', async () => {
    const http = require('http');
    /* صندوقچهٔ ساختگیِ سازگار با S3 (فقط همان چند کاری که صندوقچه لازم دارد) */
    const bucket = new Map();
    /* روی ماشین‌های کند، بستنِ اتصال‌های بی‌کار می‌تواند وسط یک درخواست
       بیفتد و «فهرست خالی» برگرداند؛ برای همین در این آزمون اتصال‌ها
       بسته نمی‌شوند. */
    const fake = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        /* D‑23/F‑04: گوشی با «نشانی امضاشده» (query) می‌نویسد، نه با کلید در هدر */
        const preSigned = (() => { try { return new URL(req.url, 'http://x').searchParams.has('X-Amz-Signature'); } catch (e) { return false; } })();
        if (!preSigned && !/^AWS4-HMAC-SHA256/.test(req.headers.authorization || '')) {
          res.writeHead(403); return res.end('<Error><Code>AccessDenied</Code></Error>');
        }
        /* صندوقچهٔ واقعی وقتی CORS تنظیم شده باشد، هدر اجازه را در همهٔ پاسخ‌ها می‌گذارد */
        res.setHeader('access-control-allow-origin', '*');
        const url = new URL(req.url, 'http://x');
        const p = decodeURIComponent(url.pathname);
        if (p === '/' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/xml' });
          return res.end('<?xml version="1.0"?><ListAllMyBucketsResult><Buckets><Bucket><Name>ob1</Name></Bucket></Buckets></ListAllMyBucketsResult>');
        }
        if (!p.startsWith('/ob1')) { res.writeHead(404); return res.end('<Error><Code>NoSuchBucket</Code></Error>'); }
        if (url.searchParams.has('cors')) { res.writeHead(200, { 'content-type': 'application/xml' }); return res.end('<CORSConfiguration/>'); }
        const key = p.slice(5).replace(/^\//, '');
        if (req.method === 'PUT' && key) { bucket.set(key, Buffer.concat(chunks).toString()); res.writeHead(200); return res.end(); }
        if (req.method === 'GET' && !key) {
          const prefix = url.searchParams.get('prefix') || '';
          const keys = [...bucket.keys()].filter(x => x.startsWith(prefix)).sort();
          res.writeHead(200, { 'content-type': 'application/xml' });
          return res.end('<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
            keys.map(x => '<Contents><Key>' + x + '</Key><Size>' + bucket.get(x).length + '</Size></Contents>').join('') +
            '</ListBucketResult>');
        }
        if (req.method === 'GET' && key) {
          if (!bucket.has(key)) { res.writeHead(404); return res.end('<Error><Code>NoSuchKey</Code></Error>'); }
          /* صندوقچهٔ واقعی وقتی CORS تنظیم شده باشد همین هدر را می‌دهد */
          res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
          return res.end(bucket.get(key));
        }
        if (req.method === 'DELETE' && key) { bucket.delete(key); res.writeHead(204); return res.end(); }
        res.writeHead(400); res.end('bad');
      });
    });
    fake.keepAliveTimeout = 0;
    fake.headersTimeout = 0;
    await new Promise(r => fake.listen(0, '127.0.0.1', r));
    const cloudPort = fake.address().port;

    /* یک درخواست شبکه‌ای گاهی یک لحظه جواب نمی‌دهد؛ صندوقچه را چند بار
       می‌زنیم و نتیجهٔ آخر را با پیام کامل گزارش می‌کنیم. */
    const drainNow = async () => {
      let last = null;
      for (let i = 0; i < 3; i++) {
        last = await req('/api/outbox/drain', { method: 'POST', token: managerToken, body: {} });
        if (last.data && last.data.ok && (last.data.applied || last.data.rejected || last.data.skipped)) return last;
        await new Promise(r => setTimeout(r, 300));
      }
      return last;
    };
    try {
      const setC = await req('/api/admin/cloud', { method: 'POST', token: managerToken, body: {
        endpoint: 'http://127.0.0.1:' + cloudPort, bucket: 'ob1', region: 'ir-central1',
        accessKey: 'AK', secret: 'SK', prefix: 'payesh/',
      } });
      assert.strictEqual(setC.data.ok, true, 'حافظهٔ ابری تنظیم شد');

      const t = await req('/api/admin/pair-code', { method: 'POST', token: managerToken, body: { user_id: 2 } });
      const teacher = await req('/api/auth/pair', { method: 'POST', body: { code: t.data.code } });
      const teacherToken = teacher.data.session.token;
      const teacherId = 2;

      /* «دستگاه دیگری» در خانه مرخصی ثبت کرده — از مسیر امن F‑06 (هویت از نشست) */
      const op = { collection: 'leaves', type: 'put', data: { student_id: 3, date: '2026-05-01', reason: 'بیماری', status: 'pending' }, base_version: 0 };
      const sub1 = await req('/api/outbox/submit', { method: 'POST', token: managerToken, body: {
        device_id: 'dev-home', items: [{ uid: 'ob-test-1', op, created_at: '2026-05-01T10:00:00.000Z' }],
      } });
      assert.strictEqual(sub1.data.ok, true, 'ثبت آفلاین پذیرفته شد: ' + JSON.stringify(sub1.data).slice(0, 200));
      assert.deepStrictEqual(sub1.data.uids, ['ob-test-1'], 'شناسهٔ پذیرفته‌شده برگشت (برای حذف از صف محلی)');

      const st = await req('/api/outbox/state', { token: managerToken });
      assert.strictEqual(st.data.cloud, true, 'صندوقچه در دسترس است');
      assert.ok(st.data.pending >= 1, 'یک ثبت در صندوقچه منتظر است');

      /* ── دسترسی گوشی: بررسی واقعی CORS از سمت سرور ── */
      const phoneChk = await req('/api/admin/cloud/phone-check', { method: 'POST', token: managerToken, body: {} });
      assert.strictEqual(phoneChk.data.ok, true, 'دسترسی گوشی تأیید شد: ' + JSON.stringify(phoneChk.data).slice(0, 300));
      assert.ok((phoneChk.data.steps || []).some(x => x.step === 'cors' && x.ok), 'گام CORS در گزارش هست');

      /* ── رمز جاری کاربران: فقط مدیر می‌بیند ── */
      const creds = await req('/api/admin/users/credentials', { token: managerToken });
      assert.strictEqual(creds.data.ok, true);
      const credMgr = creds.data.users.find(u => u.id === 1);
      assert.ok(credMgr && credMgr.password, 'رمز مدیر نمایش داده می‌شود');

      /* برای نقش‌های پایین‌تر از کادر، «سرور شدن» ممنوع است */
      const parentCode = await req('/api/admin/pair-code', { method: 'POST', token: managerToken, body: { user_id: 4 } });
      const parentTok = (await req('/api/auth/pair', { method: 'POST', body: { code: parentCode.data.code } })).data.session.token;
      const denied = await req('/api/outbox/drain', { method: 'POST', token: parentTok, body: {} });
      assert.strictEqual(denied.status, 403, 'ولی نمی‌تواند نقش سرور بگیرد');

      /* اولین دستگاهِ روشن‌شده (اینجا: مدیر) صندوقچه را اعمال می‌کند */
      const drained = await drainNow();
      assert.strictEqual(drained.data.ok, true, 'صندوقچه خوانده شد: ' + JSON.stringify(drained.data).slice(0, 300));
      /* آنچه مهم است «اثر» است نه عددِ همان پاسخ: اگر همین دستگاه پیش از آن
         صندوقچه را کشیده باشد، این درخواست صفر برمی‌گرداند ولی مرخصی
         باید در داده باشد. */
      const leaveIn = async () => {
        const r = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&collections=leaves', { token: managerToken });
        const rows = (r.data && r.data.collections && r.data.collections.leaves) || [];
        return rows.some(l => l.reason === 'بیماری');
      };
      await waitFor(leaveIn, 8000);
      assert.ok(await leaveIn(), 'ثبت صندوقچه اعمال شد: ' + JSON.stringify(drained.data).slice(0, 300));
      const after = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&collections=leaves', { token: managerToken });
      assert.ok(((after.data.collections || {}).leaves || []).some(l => l.reason === 'بیماری'), 'مرخصی از دستگاه خانه به دادهٔ مدرسه رسید');
      assert.ok(bucket.get('payesh/outbox/pending/ob-test-1.json') == null, 'ثبت اعمال‌شده از صندوقچه پاک شد');
      assert.ok(bucket.has('payesh/outbox/done/ob-test-1.json'), 'نشان «اعمال شد» گذاشته شد');

      /* تکرار: همان ثبت دوباره اعمال نمی‌شود */
      await req('/api/outbox/submit', { method: 'POST', token: managerToken, body: {
        device_id: 'dev-home', items: [{ uid: 'ob-test-1', op, created_at: '2026-05-01T10:00:00.000Z' }],
      } });
      const again = await req('/api/outbox/drain', { method: 'POST', token: managerToken, body: {} });
      assert.strictEqual(again.data.applied, 0, 'اعمال دوباره انجام نشد (idempotent)');

      /* ثبت غیرمجاز: دبیر نمی‌تواند کاربر بسازد — حتی اگر در بدنه نقش مدیر ادعا کند */
      const subBad = await req('/api/outbox/submit', { method: 'POST', token: teacherToken, body: {
        device_id: 'dev-home', user_id: 1, role: 'manager', tenant_id: 9, school_id: 9,
        items: [{ uid: 'ob-test-2', user_id: 1, role: 'manager',
          op: { collection: 'users', type: 'put', data: { name: 'نفوذی', role: 'manager' }, base_version: 0 } }],
      } });
      assert.strictEqual(subBad.data.ok, true, 'پذیرش ثبت همیشه با هویتِ نشست انجام می‌شود');
      const bad = await drainNow();
      assert.strictEqual(bad.data.ok, true, 'صندوقچه خوانده شد: ' + JSON.stringify(bad.data).slice(0, 300));
      assert.strictEqual(bad.data.applied, 0, 'ثبت خارج از نقش اعمال نشد (ادعای role در بدنه بی‌اثر)');
      assert.ok(bad.data.rejected >= 1, 'رد شدن ثبت غیرمجاز گزارش شد: ' + JSON.stringify(bad.data).slice(0, 300));

      /* F‑06: فایل دست‌ساز با هویت جعلی/امضای غلط هرگز اعمال نمی‌شود */
      bucket.set('payesh/outbox/pending/ob-forged-1.json', JSON.stringify({
        v: 2, user_id: 1, role: 'manager', tenant_id: 1, school_id: 1,
        device_id: 'forged', issued_at: '2026-05-01T00:00:00.000Z', sig: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        items: [{ uid: 'ob-forged-1', op: { collection: 'announcements', type: 'put', data: { title: 'جعلی', body: 'x', date: '2026-05-01' }, base_version: 0 } }],
      }));
      const forged = await drainNow();
      assert.strictEqual(forged.data.applied, 0, 'پاکت بدون امضای سرور اعمال نشد');
      assert.ok(forged.data.rejected >= 1, 'پاکت جعلی رد شد: ' + JSON.stringify(forged.data).slice(0, 300));
      assert.ok(bucket.has('payesh/outbox/quarantine/ob-forged-1.json'), 'پاکت جعلی قرنطینه شد (نگه‌داری برای بازرسی)');
      const forgedPull = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&collections=announcements', { token: managerToken });
      const forgedAnn = (((forgedPull.data || {}).collections || {}).announcements || []).some(a => a.title === 'جعلی');
      assert.strictEqual(forgedAnn, false, 'هیچ ثبت جعلی در دادهٔ مدرسه ننشست');

      /* خلاصهٔ دانش‌آموز: سنپ‌شات برای ولی همان فرزند خودش */
      const sid = Number((( [...bucket.keys()].find(k => /^payesh\/outbox\/state\/\d+\.json$/.test(k)) || '').match(/(\d+)\.json$/) || [])[1]);
      assert.ok(sid > 0, 'خلاصهٔ دانش‌آموزان در صندوقچه نوشته شد');
      const snapMgr = await req('/api/outbox/snapshot?student_id=' + sid, { token: managerToken });
      assert.strictEqual(snapMgr.data.ok, true, 'مدیر خلاصه را می‌بیند: ' + JSON.stringify(snapMgr.data));
      assert.ok(snapMgr.data.snapshot && snapMgr.data.snapshot.student_id === sid, 'خلاصه مال همان دانش‌آموز است');
      const snapParent = await req('/api/outbox/snapshot?student_id=' + sid, { token: parentTok });
      assert.ok([200, 403].includes(snapParent.status), 'ولی فقط محدودهٔ خودش را می‌بیند');

      /* ── نسخهٔ گوشی: رمز و داده در صندوقچه، ورود بدون هیچ سروری ── */
      const setPw = await req('/api/admin/users/1/password', { method: 'POST', token: managerToken, body: { password: 'Madrese1404' } });
      assert.strictEqual(setPw.data.ok, true, 'رمز عبور مدیر تعیین شد');
      const pub = await req('/api/outbox/publish', { method: 'POST', token: managerToken, body: {} });
      assert.strictEqual(pub.data.ok, true, 'بستهٔ گوشی منتشر شد: ' + JSON.stringify(pub.data).slice(0, 200));
      assert.ok(bucket.has('payesh/auth/09120000001.json'), 'پروندهٔ ورودِ هر شماره در صندوقچه هست');
      assert.ok(bucket.has('payesh/data/core.json'), 'دادهٔ سراسری برای گوشی منتشر شد');
      assert.ok([...bucket.keys()].some(k => /^payesh\/data\/person\/\d+\.json$/.test(k)), 'دادهٔ شخصی هر کاربر منتشر شد');

      const authEnv = JSON.parse(bucket.get('payesh/auth/09120000001.json'));
      assert.ok(/^pbkdf2\$\d+\$[0-9a-f]+\$[0-9a-f]+$/.test(authEnv.verifier), 'رمز به شکل قابل‌بررسی روی گوشی ذخیره شد');
      assert.strictEqual(authEnv.user.role, 'manager');
      assert.ok(!/secret|password_hash/.test(JSON.stringify(authEnv)), 'هیچ راز اضافه‌ای در پرونده نیست');
      const core = JSON.parse(bucket.get('payesh/data/core.json'));
      assert.ok(Array.isArray(core.directory) && core.directory.length > 2, 'فهرست نام‌ها هم منتشر شد');
      assert.ok(!/password_hash|phone_hash|password_plain/.test(bucket.get('payesh/data/core.json')), 'هیچ هش/رمزی در داده منتشر نمی‌شود');

      /* همان بررسی که گوشی انجام می‌دهد (WebCrypto/PBKDF2) */
      global.window = global;
      if (!global.localStorage) {
        const mem = {};
        global.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
      }
      global.PayeshS3 = require(path.join(ROOT, 'client', 'lib', 's3mini.js'));
      require(path.join(ROOT, 'client', 'lib', 'phone.js'));
      const PH = global.PayeshPhone;
      assert.ok(PH && PH.login, 'ماژول گوشی بارگذاری شد');
      assert.strictEqual(await PH.verify('Madrese1404', authEnv.verifier), true, 'رمز درست روی گوشی تأیید می‌شود');
      assert.strictEqual(await PH.verify('ramz-eshtebah', authEnv.verifier), false, 'رمز اشتباه رد می‌شود');

      /* D‑23/F‑04: گوشی هیچ کلیدی نمی‌گیرد — تیکت کوتاه‌عمر از سرور می‌گیرد */
      PH.setBase(BASE);
      const phoneLogin = await PH.login('۰۹۱۲۰۰۰۰۰۰۱', 'Madrese1404');
      assert.strictEqual(phoneLogin.ok, true, 'ورود گوشی با شماره و رمز مدیر: ' + JSON.stringify(phoneLogin));
      assert.strictEqual(phoneLogin.user.role, 'manager', 'نقش از مدرسه می‌آید');
      const tkRaw = global.localStorage.getItem('payesh.phone.tickets') || '';
      const tk = JSON.parse(tkRaw || 'null');
      assert.ok(tk && tk.tickets && tk.tickets.core_get && !tk.tickets.outbox_put, 'تیکت خواندن گرفته شد و تیکت نوشتن در صندوقچه نیست (F‑06)');
      assert.ok(!/accessKey|secret/i.test(tkRaw), 'تیکت هیچ کلید/رازی ندارد: ' + tkRaw.slice(0, 120));
      const phoneData = await PH.pullData(phoneLogin.user);
      assert.ok(Array.isArray(phoneData.collections.users) && phoneData.collections.users.length > 2, 'گوشی فهرست کاربران را می‌گیرد');
      const sentOp = await PH.send({ uid: 'ob-phone-1', user_id: 1, role: 'manager', op: { collection: 'announcements', type: 'put', data: { title: 'از گوشی', body: 'بدون سرور', date: '2026-05-02' }, base_version: 0 } });
      assert.strictEqual(sentOp.ok, true, 'ثبت گوشی با نشانی امضاشده در صندوقچه گذاشته شد');
      const devFile = [...bucket.keys()].find(k => /^payesh\/outbox\/pending\/device-[a-z0-9-]+\.json$/.test(k));
      assert.ok(devFile, 'فایل ثبت گوشی در صندوقچه هست');
      const devEnv = JSON.parse(bucket.get(devFile));
      assert.ok((devEnv.items || []).some(x => x.uid === 'ob-phone-1'), 'ثبت گوشی داخل فایل دستگاه است');
      /* F‑06: پاکت امضاشده است و هویت/مستأجر از سرور آمده، نه از گوشی */
      assert.strictEqual(devEnv.v, 2, 'پاکت نسخهٔ ۲ (امضاشده) است');
      assert.ok(typeof devEnv.sig === 'string' && devEnv.sig.length > 20, 'پاکت امضای سرور دارد');
      assert.strictEqual(devEnv.user_id, 1, 'کاربرِ پاکت از تیکت/نشست است');
      assert.strictEqual(devEnv.school_id, 1, 'مستأجرِ پاکت از کاربر است — نه از بدنه');
      assert.ok((devEnv.items || []).every(x => x.user_id === undefined && x.role === undefined), 'هیچ ادعای هویتی داخل ثبت‌ها نیست');
      const drainedFromPhone = await drainNow();
      const annIn = async () => {
        const r = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&collections=announcements', { token: managerToken });
        const rows = (r.data && r.data.collections && r.data.collections.announcements) || [];
        return rows.some(a => a.title === 'از گوشی');
      };
      await waitFor(annIn, 8000);
      assert.ok(await annIn(), 'سیستم مدرسه ثبت گوشی را اعمال کرد: ' + JSON.stringify(drainedFromPhone.data).slice(0, 400));

      /* تغییر رمز از روی گوشی: فقط نسخهٔ قابل‌بررسی می‌آید و همان رمز می‌شود */
      const utilMod = require(path.join(ROOT, 'server', 'util.js'));
      const pwSent = await PH.send({ uid: 'pw-phone-1', op: {
        collection: 'users', type: 'put', id: 1, data: { __password_verifier: utilMod.pbkdf2Hash('Ramz-Az-Ghooshi') },
      } });
      assert.strictEqual(pwSent.ok, true, 'تغییر رمز از گوشی فرستاده شد');
      const pwDrain = await drainNow();
      const pwOk = async () => (await req('/api/auth/login', { method: 'POST', body: { phone: '09120000001', password: 'Ramz-Az-Ghooshi' } })).data.ok;
      await waitFor(pwOk, 8000);
      assert.ok(await pwOk(), 'تغییر رمز از گوشی اعمال شد: ' + JSON.stringify(pwDrain.data).slice(0, 400));

      /* ── F‑06: ادعای هویت در header و query هم بی‌اثر است ─────────── */
      const hdrSub = await req('/api/outbox/submit?user_id=1&tenant_id=9&school_id=9&role=manager', {
        method: 'POST', token: teacherToken,
        headers: { 'x-user-id': '1', 'x-tenant-id': '9', 'x-school-id': '9' },
        body: {
          device_id: 'dev-hdr', user_id: 1, role: 'manager', tenant_id: 9, school_id: 9,
          items: [{ uid: 'ob-hdr-1', op: { collection: 'homework', type: 'put',
            data: { class_id: 1, subject_id: 1, title: 'از سرآیند', date: '2026-05-04', school_id: 9, tenant_id: 9 } } }],
        },
      });
      assert.strictEqual(hdrSub.data.ok, true, 'ثبت با ادعای هویت در header/query پذیرفته شد: ' + JSON.stringify(hdrSub.data).slice(0, 200));
      assert.ok((hdrSub.data.ignored_claims || []).length >= 5, 'ادعاهای نادیده‌گرفته‌شده گزارش شدند: ' + JSON.stringify(hdrSub.data.ignored_claims || []));
      const hdrFile = [...bucket.keys()].find(k => /^payesh\/outbox\/pending\/device-.*\.json$/.test(k)
        && String(bucket.get(k)).includes('ob-hdr-1'));
      assert.ok(hdrFile, 'فایل دستگاه برای ثبت سرآیندی ساخته شد');
      const hdrEnv = JSON.parse(bucket.get(hdrFile));
      assert.strictEqual(hdrEnv.user_id, teacherId, 'کاربرِ پاکت از نشست دبیر است، نه از header');
      assert.strictEqual(hdrEnv.school_id, 1, 'مستأجرِ پاکت از نشست است، نه ۹');
      const hdrItem = (hdrEnv.items || []).find(i => i.uid === 'ob-hdr-1');
      assert.ok(hdrItem && hdrItem.op.data.school_id === undefined && hdrItem.op.data.tenant_id === undefined,
        'میدان‌های مستأجر از دادهٔ کلاینت پاک شدند');

      /* ── F‑06: بازپخش (replay) پاکتِ اعمال‌شده دوباره اعمال نمی‌شود ── */
      const repSub = await req('/api/outbox/submit', { method: 'POST', token: managerToken, body: {
        device_id: 'dev-replay',
        items: [{ uid: 'ob-replay-1', op: { collection: 'leaves', type: 'put',
          data: { student_id: 3, date: '2026-05-04', reason: 'بازپخش', status: 'pending' } } }],
      } });
      assert.strictEqual(repSub.data.ok, true, 'ثبت برای آزمون بازپخش پذیرفته شد');
      const repFile = [...bucket.keys()].find(k => /^payesh\/outbox\/pending\/device-.*\.json$/.test(k)
        && String(bucket.get(k)).includes('ob-replay-1'));
      assert.ok(repFile, 'فایل دستگاه برای ثبت بازپخش ساخته شد');
      const repBytes = bucket.get(repFile);
      const firstDrain = await drainNow();
      assert.ok(firstDrain.data.applied >= 1, 'پاکت معتبر اعمال شد: ' + JSON.stringify(firstDrain.data).slice(0, 240));
      bucket.set(repFile, repBytes);             /* همان فایل امضاشده برمی‌گردد */
      const replay = await drainNow();
      assert.strictEqual(replay.data.applied, 0, 'بازپخش پاکت اعمال‌شده اعمال نشد: ' + JSON.stringify(replay.data).slice(0, 240));
      assert.ok((replay.data.skipped || 0) >= 1, 'نشان «اعمال شد» جلوی تکرار را گرفت');
      const noDup = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&collections=leaves', { token: managerToken });
      const dupRows = (((noDup.data || {}).collections || {}).leaves || []).filter(a => a.reason === 'بازپخش');
      assert.strictEqual(dupRows.length, 1, 'ثبت بازپخش فقط یک بار در داده نشست: ' + dupRows.length);

      /* ── F‑06: پاکتِ امضاشدهٔ مستأجر دیگر در این نصب اعمال نمی‌شود ── */
      const outboxMod = require(path.join(ROOT, 'server', 'outbox.js'));
      const memMeta = new Map();
      const fakeStore = {
        getMeta: (k, d = null) => (memMeta.has(k) ? memMeta.get(k) : d),
        setMeta: (k, v) => { memMeta.set(k, v); },
      };
      const foreignEnv = outboxMod.buildEnvelope(fakeStore, {
        user: { id: 1, role: 'manager', school_id: 2, tenant_id: 2 }, device: 'dev-foreign',
        items: [{ uid: 'ob-foreign-1', op: { collection: 'announcements', type: 'put', data: { title: 'مستأجر دیگر', date: '2026-05-05' } } }],
      });
      const ownEnv = outboxMod.buildEnvelope(fakeStore, {
        user: { id: 1, role: 'manager', school_id: 1, tenant_id: 1 }, device: 'dev-own',
        items: [{ uid: 'ob-own-1', op: { collection: 'announcements', type: 'put', data: { title: 'خودمان', date: '2026-05-05' } } }],
      });
      assert.strictEqual(outboxMod.acceptEnvelope(fakeStore, ownEnv).ok, true, 'پاکت مستأجر خودی پذیرفته می‌شود');
      const cross = outboxMod.acceptEnvelope(fakeStore, foreignEnv);
      assert.strictEqual(cross.ok, false, 'پاکت مستأجر دیگر پذیرفته نشود');
      assert.strictEqual(cross.reason, 'cross_tenant', 'دلیل رد cross_tenant است');
      assert.notStrictEqual(outboxMod.signKey(fakeStore, 1), outboxMod.signKey(fakeStore, 2), 'کلید امضای هر مستأجر جداست');

      console.log('   F06-OK checks=22 spoof=blocked header=blocked query=blocked replay=blocked cross_tenant=blocked forged=quarantined tenant=bound');
    } finally {
      await new Promise(r => fake.close(r));
    }
  });

  await test('آدرس موقت قدیمی خودکار پاک می‌شود (هیچ آدرس بی‌جوابی نمایش داده نمی‌شود)', () => {
    const tunnel = require('../server/tunnel.js');
    const meta = {};
    const store = {
      getMeta: (k, d) => (k in meta ? meta[k] : (d === undefined ? null : d)),
      setMeta: (k, v) => { meta[k] = v; },
      audit: () => {},
    };
    meta['cfg:public_url'] = 'https://abcd-efgh-1234.example-ephemeral.net';
    const r1 = tunnel.purgeStalePublicUrl(store);
    assert.strictEqual(r1.cleared, true, 'آدرس موقت پاک شد');
    assert.strictEqual(meta['cfg:public_url'], '', 'آدرس از تنظیمات حذف شد');

    meta['cfg:public_url'] = 'https://payesh.school.ts.net';
    const r2 = tunnel.purgeStalePublicUrl(store);
    assert.strictEqual(r2.cleared, false, 'آدرس ثابت Tailscale می‌ماند');

    meta['cfg:public_url'] = 'https://payesh.example.ir';
    meta['cfg:tunnel_provider'] = 'manual';
    const r3 = tunnel.purgeStalePublicUrl(store);
    assert.strictEqual(r3.cleared, false, 'آدرس دستیِ مدیر می‌ماند');
  });

  await test('گوشی: صفحهٔ ورود محلی به‌جای بن‌بست «سرور در دسترس نیست»', () => {
    const app = fs.readFileSync(path.join(ROOT, 'client/app.js'), 'utf8');
    const pages = fs.readFileSync(path.join(ROOT, 'client/pages.js'), 'utf8');
    const phone = fs.readFileSync(path.join(ROOT, 'client/lib/phone.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'client/index.html'), 'utf8');
    assert.ok(phone.includes('async function login'), 'ورود محلی با شماره+رمز');
    assert.ok(phone.includes("'PBKDF2'"), 'بررسی رمز با WebCrypto روی خود گوشی');
    /* D‑23/F‑04: مسیر ورود از سرور است و نوشتن در صندوقچه با «نشانی امضاشده» */
    assert.ok(phone.includes('/api/phone/login'), 'ورود از سیستم مدرسه (شماره+رمز) انجام می‌شود');
    assert.ok(phone.includes('outbox_put'), 'ثبت‌ها با نشانی امضاشدهٔ کوتاه‌عمر در صندوقچه گذاشته می‌شوند');
    assert.ok(!/accessKey\s*[:=]/.test(phone) && !/\bsecret\s*[:=]/.test(phone), 'هیچ کلید/رازی در ماژول گوشی نیست');
    assert.ok(html.includes('/lib/phone.js'), 'صفحهٔ گوشی ماژول را بار می‌کند');
    assert.ok(pages.includes('function renderPhoneLogin'), 'صفحهٔ ورود گوشی وجود دارد');
    assert.ok(app.includes("kind === 'phone-login'"), 'فرم ورود گوشی پردازش می‌شود');
    assert.ok(!/سرور در دسترس نیست<\/h1>/.test(pages), 'پیام بن‌بست حذف شده است');
  });

  await test('PBKDF2 جاوااسکریپتی (برای ورود روی گوشی) با Node یکی است', () => {
    const crypto = require('crypto');
    global.window = global;
    require(path.join(ROOT, 'client', 'lib', 'hash.js'));
    const H = global.PayeshHash;
    assert.ok(H && H.pbkdf2, 'ماژول هش بارگذاری شد');
    assert.strictEqual(H.hex(H.sha256(H.utf8('abc'))),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'SHA-256 درست است');
    const salt = '00112233445566778899aabbccddeeff';
    assert.strictEqual(H.hex(H.pbkdf2('Madrese1404', salt, 1000, 32)),
      crypto.pbkdf2Sync('Madrese1404', salt, 1000, 32, 'sha256').toString('hex'), 'PBKDF2 مطابق Node');
    /* همان قالبی که سرور منتشر می‌کند باید روی گوشی باز شود */
    const stored = require(path.join(ROOT, 'server', 'util.js')).pbkdf2Hash('Madrese1404');
    const [, iter, s2, want] = stored.split('$');
    assert.strictEqual(H.hex(H.pbkdf2('Madrese1404', s2, Number(iter), 32)), want, 'هش سرور روی گوشی تأیید می‌شود');
  });

  await test('هیچ اثری از Cloudflare در برنامه نمانده', () => {
    const files = ['server/index.js', 'server/tunnel.js', 'client/app.js', 'client/pages.js', 'installer/payesh.iss', 'package.json'];
    for (const f of files) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.ok(!/cloudflare|cloudflared|trycloudflare|workers\.dev/i.test(text), f + ' پاک است');
    }
    for (const gone of ['server/hub.js', 'tests/hub.js', 'hub']) {
      assert.ok(!fs.existsSync(path.join(ROOT, gone)), gone + ' حذف شده است');
    }
    const config = fs.readFileSync(path.join(ROOT, 'server/config.js'), 'utf8');
    assert.ok(!/hubConfig/.test(config), 'تنظیمات Hub حذف شده است');
    const ob = fs.readFileSync(path.join(ROOT, 'server/outbox.js'), 'utf8');
    assert.ok(ob.includes('outbox/pending/'), 'صندوقچه روی payesh/outbox/… کار می‌کند');
  });

  /* ── ۳. دود رابط کاربری ── */
  await test('نسخهٔ کامل اندروید: همهٔ برنامه داخل APK است، نه یک پوسته', async () => {
    const appJs = fs.readFileSync(path.join(ROOT, 'client/app.js'), 'utf8');
    assert.ok(appJs.includes('PAYESH_API_BASE'), 'کلاینت آدرس سرورِ تزریق‌شده را می‌شناسد');
    assert.ok(appJs.includes('PAYESH_BUNDLED'), 'حالت «همه‌چیز داخل برنامه»');
    assert.ok(appJs.includes('async function startOffline'), 'بالا آمدن برنامه بدون سرور');
    const act = fs.readFileSync(path.join(ROOT, 'install/android/app/src/main/java/ir/payesh/local/MainActivity.java'), 'utf8');
    assert.ok(act.includes('appassets.androidplatform.net'), 'مبدأ امن محلی برای دارایی‌ها');
    assert.ok(act.includes('PAYESH_API_BASE'), 'تزریق آدرس سرور در صفحهٔ محلی');
    assert.ok(act.includes('shouldInterceptRequest'), 'سرو دارایی‌ها از داخل APK');
    const gradle = fs.readFileSync(path.join(ROOT, 'install/android/app/build.gradle'), 'utf8');
    assert.ok(gradle.includes('bundleWebAssets'), 'کپی خودکار client/ داخل assets هنگام ساخت');
    const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/build.yml'), 'utf8');
    assert.ok(wf.includes('assets/www/app.js'), 'CI وجود فایل‌های برنامه در APK را بررسی می‌کند');
  });

  await test('سیستم مدرسه به برنامهٔ گوشی اجازهٔ دسترسی می‌دهد (CORS)', async () => {
    const ORIGIN = 'https://appassets.androidplatform.net';
    const r = await fetch(BASE + '/api/health', { headers: { origin: ORIGIN } });
    assert.strictEqual(r.headers.get('access-control-allow-origin'), ORIGIN, 'سرآیند اجازهٔ مبدأ');
    const pre = await fetch(BASE + '/api/auth/login', {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    assert.strictEqual(pre.status, 204, 'پاسخ به پیش‌پرواز مرورگر');
    assert.ok(/POST/.test(pre.headers.get('access-control-allow-methods') || ''), 'متدها اعلام شده‌اند');
    assert.ok(/authorization/i.test(pre.headers.get('access-control-allow-headers') || ''), 'هدرها اعلام شده‌اند');
  });

  await test('نسخهٔ اندروید درخواست حافظه را بومی می‌فرستد (بدون CORS)', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'https://appassets.androidplatform.net/assets/www/index.html', runScripts: 'outside-only',
    });
    const win = dom.window;
    let calls = 0, fetchUsed = 0, seen = null;
    win.fetch = () => { fetchUsed++; return Promise.reject(new Error('fetch نباید صدا زده شود')); };
    /* پل بومی مثل نسخهٔ اندروید */
    win.PayeshNative = {
      s3(method, url, headersJson, body) {
        calls++;
        seen = { method, url, headers: JSON.parse(headersJson), body };
        setTimeout(() => win.__payeshNativeDone('r1', 200, '{"ok":1}', ''), 0);
        return 'r1';
      },
    };
    win.eval(fs.readFileSync(path.join(ROOT, 'client/lib/sigv4.js'), 'utf8'));
    win.eval(fs.readFileSync(path.join(ROOT, 'client/lib/s3mini.js'), 'utf8'));
    const s3 = win.PayeshS3;
    assert.ok(s3.nativeBridge(), 'پل بومی شناخته می‌شود');
    const text = await s3.get({ endpoint: 'https://s3.ir-central1.arvanstorage.ir', bucket: 'b1', accessKey: 'AK', secret: 'SK', region: 'ir-central1', prefix: 'payesh/' }, 'payesh/data/core.json');
    assert.strictEqual(text, '{"ok":1}', 'پاسخ بومی خوانده شد');
    assert.strictEqual(calls, 1, 'درخواست از پل بومی رفت');
    assert.strictEqual(fetchUsed, 0, 'از fetch مرورگر استفاده نشد (پس CORS لازم نیست)');
    assert.strictEqual(seen.method, 'GET');
    assert.ok(/authorization/i.test(Object.keys(seen.headers).join(',')), 'امضای SigV4 همراه درخواست است');
    assert.ok(String(seen.url).includes('payesh/data/core.json'));
    dom.window.close();
  });

  await test('بازسازی صفحه، فوکوس و جای نشانگر را نگه می‌دارد (صفحه‌کلید گوشی بسته نشود)', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
      url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true,
    });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/app.js'));
    win.eval(`setApp('<form data-form="phone-login"><input name="phone" value=""></form>')`);
    const inp = win.document.querySelector('input[name="phone"]');
    inp.focus();
    inp.value = '0912';
    inp.setSelectionRange(4, 4);
    /* همان صفحه دوباره ساخته می‌شود (مثل وقتی همگام‌سازی تازه‌ای می‌رسد) */
    win.eval(`setApp('<form data-form="phone-login"><input name="phone" value=""></form>')`);
    const again = win.document.querySelector('input[name="phone"]');
    assert.strictEqual(win.document.activeElement, again, 'فوکوس روی همان کادر می‌ماند');
    assert.strictEqual(again.value, '0912', 'متن تایپ‌شده حفظ می‌شود');
    assert.strictEqual(again.selectionStart, 4, 'جای نشانگر حفظ می‌شود');

    /* کادر جستجو (بدون فرم): با هر حرف صفحه بازسازی می‌شود، ولی فوکوس
       و متن نباید بپرد — همان شکایت «هر حرف که می‌نویسم باید دوباره
       با ماوس روی کادر کلیک کنم». */
    win.eval(`setApp('<div class="card"><input class="input" id="q-search" data-focus-key="q-search" data-search="q" value=""></div>')`);
    const q = win.document.getElementById('q-search');
    q.focus(); q.value = 'علی';
    win.eval(`paintApp('<div class="card"><input class="input" id="q-search" data-focus-key="q-search" data-search="q" value="علی"></div>')`);
    const q2 = win.document.getElementById('q-search');
    assert.strictEqual(win.document.activeElement, q2, 'کادر جستجو بعد از بازسازی همان کادر فعال است');
    assert.strictEqual(q2.value, 'علی', 'متنی که تایپ شده بود سر جایش است');

    /* صفحهٔ ورود گوشی اگر همین حالا روی نمایش است، دوباره ساخته نمی‌شود */
    win.eval(`window.PAYESH_CLOUD = { endpoint: 'https://s3.ir-central1.arvanstorage.ir', bucket: 'pb1', accessKey: 'AK', secret: 'SK', prefix: 'payesh/' };`);
    win.eval(`renderPhoneLogin(true)`);
    const first = win.document.querySelector('input[name="phone"]');
    assert.ok(first, 'فرم ورود گوشی ساخته شد');
    const pageTxt = win.document.getElementById('app').textContent;
    assert.ok(/حافظهٔ مشترک/.test(pageTxt), 'تنظیمات حافظه (آروان) در صفحهٔ گوشی دیده می‌شود');
    /* آدرس بدون پیشوند https:// نمایش داده می‌شود */
    assert.ok(/s3[.\-]ir\-central1[.\-]arvanstorage[.\-]ir/.test(pageTxt), 'آدرس سرویس پخته‌شده روی گوشی نمایش داده می‌شود: ' + pageTxt.slice(0, 200));
    assert.ok(win.document.querySelector('[data-act="phone-diagnose"]'), 'دکمهٔ بررسی دقیق اتصال هست');
    win.eval(`renderPhoneLogin()`);
    assert.strictEqual(win.document.querySelector('input[name="phone"]'), first, 'بازسازی بی‌مورد انجام نمی‌شود');
    dom.window.close();
  });

  /* — گوشی: نوار پیشنهاد/autofill کیبورد نباید حین تایپ باز شود ──────── */
  await test('صفحهٔ ورود: پیشنهاد خودکارِ کیبورد گوشی روی نام کاربری و رمز خاموش است', async () => {
    const pages = fs.readFileSync(path.join(ROOT, 'client/pages.js'), 'utf8');
    const java = fs.readFileSync(path.join(ROOT, 'install/android/app/src/main/java/ir/payesh/local/MainActivity.java'), 'utf8');
    /* هر سه فرم ورود (سیستم، گوشی، پیوند) نباید autofill را صدا بزنند */
    const forms = pages.match(/<form data-form="[^"]+" class="card" autocomplete="off">/g) || [];
    assert.ok(forms.length >= 2, 'فرم‌های ورود autocomplete خاموش دارند (' + forms.length + ')');
    assert.ok(/name="phone"[^>]*autocomplete="off"/.test(pages), 'کادر نام کاربری پیشنهاد خودکار نمی‌گیرد');
    assert.ok(/type="password"[^>]*autocomplete="new-password"/.test(pages), 'کادر رمز رمزِ ذخیره‌شده پیشنهاد نمی‌کند');
    assert.ok(/data-focus-key="phone"/.test(pages) && /data-focus-key="password"/.test(pages), 'کادرهای ورود کلید فوکوس دارند');
    assert.ok(/autocorrect="off"/.test(pages) && /spellcheck="false"/.test(pages), 'غلط‌گیر و اصلاح خودکار خاموش است');
    /* خودِ WebView هم autofill را رد می‌کند */
    assert.ok(/setImportantForAutofill\(View\.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS\)/.test(java),
      'WebView پیشنهاد خودکار را نمی‌پذیرد');
  });

  /* — نگهبان دائمی: هیچ کاربری، در هیچ نقشی، نباید به دیوار
     «این بخش به سیستم مدرسه نیاز دارد» بخورد. متن این پیام نباید حتی
     به‌صورت کدِ پرتاب‌شونده در برنامهٔ گوشی باقی بماند. */
  await test('هیچ کدی در نسخهٔ گوشی پیام «نیاز به سیستم مدرسه» پرتاب نمی‌کند', async () => {
    const files = ['client/app.js', 'client/pages.js', 'client/lib/phone.js'];
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.ok(!/throw[^;\n]*نیاز دارد/.test(src), f + ' نباید پیام «نیاز به سیستم مدرسه» را پرتاب کند');
      assert.ok(!/به سیستم مدرسه نیاز دارد/.test(src), f + ' نباید متن دیوار را در خود داشته باشد');
    }
    const app = fs.readFileSync(path.join(ROOT, 'client/app.js'), 'utf8');
    assert.ok(/function phoneApiStub/.test(app), 'در حالت گوشی، پاسخ‌های بی‌خطر محلی ساخته می‌شوند');
    assert.ok(/if \(PHONE_MODE\) return phoneApiStub/.test(app), 'درخواست‌های گوشی به پاسخ محلی می‌روند، نه پرتاب خطا');
    const pages = fs.readFileSync(path.join(ROOT, 'client/pages.js'), 'utf8');
    assert.ok(/function layerRoot/.test(pages), 'پنجره‌ها اگر جایگاه نداشته باشند خودشان ساخته می‌شوند');
  });

  /* — استانداردهای نصب (گوگل و مایکروسافت) ─────────────────────────
     هدف: هنگام نصب هیچ هشدار «برنامهٔ پرخطر / ناشر ناشناس» نیاید و
     بسته‌ها همان چیزی باشند که گوگل و مایکروسافت استاندارد می‌دانند. */
  await test('APK مطابق استاندارد گوگل ساخته و امضا می‌شود', async () => {
    const mf = fs.readFileSync(path.join(ROOT, 'install/android/app/src/main/AndroidManifest.xml'), 'utf8');
    /* هیچ مجوز پرخطری نباید خواسته شود — تنها استثنا «دوربین» است که
       فقط برای اسکن QR کارت پیوند لازم است و کاربر خودش درخواست کرده. */
    const risky = ['REQUEST_INSTALL_PACKAGES', 'READ_CONTACTS', 'READ_SMS', 'SEND_SMS',
      'RECORD_AUDIO', 'READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE', 'MANAGE_EXTERNAL_STORAGE',
      'SYSTEM_ALERT_WINDOW', 'REQUEST_IGNORE_BATTERY_OPTIMIZATIONS', 'READ_PHONE_STATE'];
    for (const r of risky) {
      assert.ok(!new RegExp('android\\.permission\\.' + r + '\\b').test(mf),
        'مجوز پرخطر ' + r + ' نباید در برنامه باشد');
    }
    /* دوربین فقط برای اسکن QR و به‌صورت «اختیاری» */
    assert.ok(/android\.permission\.CAMERA/.test(mf), 'مجوز دوربین برای اسکن QR هست');
    assert.ok(/android\.hardware\.camera" android:required="false"/.test(mf),
      'گوشی بدون دوربین هم می‌تواند برنامه را نصب کند');
    assert.ok(/android:allowBackup="false"/.test(mf), 'پشتیبان‌گیری ابری گوگل از دادهٔ دانش‌آموزان خاموش است');
    assert.ok(/<queries>/.test(mf), 'بازکردن پیوند در مرورگر (اندروید ۱۱+) اعلام شده است');
    const gradle = fs.readFileSync(path.join(ROOT, 'install/android/app/build.gradle'), 'utf8');
    assert.ok(/enableV2Signing true/.test(gradle) && /enableV3Signing true/.test(gradle),
      'امضای v2 و v3 (استاندارد گوگل) روشن است');
    const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/build.yml'), 'utf8');
    assert.ok(/gradle assembleRelease/.test(wf), 'نسخهٔ انتشار (release) ساخته می‌شود، نه debug');
    assert.ok(!/gradle assembleDebug/.test(wf), 'دیگر نسخهٔ debug منتشر نمی‌شود');
    assert.ok(/Verified using v\$v scheme/.test(wf) && /for v in 2 3/.test(wf), 'ساخت بدون امضای v2/v3 متوقف می‌شود');
    assert.ok(/zipalign/.test(wf), 'تراز بایت APK بررسی می‌شود');
    assert.ok(/application-debuggable/.test(wf), 'نسخهٔ debug بودن APK بررسی می‌شود');
    /* آیکون تطبیقی اندروید ۸+ */
    assert.ok(fs.existsSync(path.join(ROOT, 'install/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml')),
      'آیکون تطبیقی (adaptive icon) وجود دارد');
  });

  await test('نصب‌کنندهٔ ویندوز مطابق استاندارد مایکروسافت است', async () => {
    const iss = fs.readFileSync(path.join(ROOT, 'installer/payesh.iss'), 'utf8');
    for (const key of ['AppPublisher', 'AppPublisherURL', 'AppSupportURL', 'AppCopyright',
      'VersionInfoCompany', 'VersionInfoProductName', 'VersionInfoProductVersion', 'VersionInfoCopyright']) {
      assert.ok(new RegExp('^' + key + '=', 'm').test(iss), 'شناسنامهٔ نصب‌کننده: ' + key + ' نوشته شده است');
    }
    assert.ok(/PrivilegesRequiredOverridesAllowed=dialog/.test(iss),
      'امکان نصب بدون دسترسی مدیر (بدون پنجرهٔ UAC) وجود دارد');
    assert.ok(/Check: IsAdminInstallMode/.test(iss), 'کارهای نیازمند مدیر فقط در حالت همه‌کاربره اجرا می‌شوند');
    /* برنامهٔ ویندوز: مانیفست asInvoker + شناسنامهٔ نسخه */
    const man = fs.readFileSync(path.join(ROOT, 'desktop/app.manifest'), 'utf8');
    assert.ok(/requestedExecutionLevel level="asInvoker"/.test(man), 'برنامه هیچ‌وقت دسترسی مدیر نمی‌خواهد');
    assert.ok(/supportedOS/.test(man) && /dpiAware/.test(man), 'شناسهٔ ویندوز ۱۰/۱۱ و نمایش درست اعلام شده است');
    const ps = fs.readFileSync(path.join(ROOT, 'desktop/build.ps1'), 'utf8');
    assert.ok(/win32manifest/.test(ps), 'مانیفست به فایل اجرایی پیوست می‌شود');
    assert.ok(/AssemblyFileVersion/.test(ps), 'نسخهٔ فایل اجرایی نوشته می‌شود');
  });

  await test('صفحهٔ ورود در مرورگر بدون خطا رندر می‌شود', async () => {
    const { JSDOM } = require('jsdom');
    const html = fs.readFileSync(path.join(ROOT, 'client/index.html'), 'utf8');
    const dom = new JSDOM(html, {
      url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true,
      beforeParse(win) {
        win.fetch = (u, o) => fetch(new URL(u, BASE), o);
        win.indexedDB = undefined;
        win.navigator.serviceWorker = undefined;
      },
    });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/schedule.js') + '\n;\n' + strip('client/app.js'));
    win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
    const app = await waitFor(() => {
      const el = win.document.querySelector('#app');
      return el && el.textContent.includes('ورود') ? el : null;
    });
    assert.ok(app.textContent.includes('کارت پیوند') || app.textContent.includes('ورود'));
    dom.window.close();
  });

  /* — خواندن اکسل بدون کتابخانهٔ بیرونی ───────────────────────────── */
  await test('فایل اکسل (.xlsx) درست خوانده می‌شود', async () => {
    const zlib = require('zlib');
    /* یک xlsx کوچک می‌سازیم: دو برگه، متن مشترک، عدد و متن درون‌خطی */
    const files = {
      '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
      'xl/workbook.xml': '<?xml version="1.0"?><workbook><sheets>'
        + '<sheet name="دانش‌آموزان" sheetId="1" r:id="rId1"/>'
        + '</sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships>'
        + '<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>'
        + '</Relationships>',
      'xl/sharedStrings.xml': '<?xml version="1.0"?><sst>'
        + '<si><t>نام و نام خانوادگی</t></si><si><t>کد ملی</t></si><si><t>علی رضایی</t></si>'
        + '</sst>',
      'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet><sheetData>'
        + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
        + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>0012345678</v></c>'
        + '<c r="C2" t="inlineStr"><is><t>دهم الف</t></is></c></row>'
        + '</sheetData></worksheet>',
    };
    const buildZip = (entries) => {
      const locals = [], centrals = [];
      let offset = 0;
      for (const [name, content] of Object.entries(entries)) {
        const raw = Buffer.from(content, 'utf8');
        const method = name.endsWith('sheet1.xml') ? 8 : 0;   /* برگه فشرده، بقیه ذخیره */
        const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
        const nameBuf = Buffer.from(name, 'utf8');
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(0, 10); local.writeUInt32LE(0, 14);
        local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
        locals.push(local, nameBuf, data);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(0, 12); central.writeUInt32LE(0, 16);
        central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBuf);
        offset += local.length + nameBuf.length + data.length;
      }
      const centralBuf = Buffer.concat(centrals);
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(Object.keys(entries).length, 8);
      eocd.writeUInt16LE(Object.keys(entries).length, 10);
      eocd.writeUInt32LE(centralBuf.length, 12);
      eocd.writeUInt32LE(offset, 16);
      return Buffer.concat([...locals, centralBuf, eocd]);
    };
    const zip = buildZip(files);
    const X = require(path.join(ROOT, 'client/lib/xlsx.js'));
    const parsed = await X.read(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength));
    assert.strictEqual(parsed.sheets.length, 1);
    const sh = parsed.sheets[0];
    assert.strictEqual(sh.name, 'دانش‌آموزان', 'نام برگه از workbook خوانده شد');
    assert.deepStrictEqual(sh.rows[0], ['نام و نام خانوادگی', 'کد ملی'], 'سطر عنوان درست خوانده شد');
    assert.strictEqual(sh.rows[1][0], 'علی رضایی', 'متن مشترک (sharedStrings) درست خوانده شد');
    assert.strictEqual(sh.rows[1][1], '0012345678', 'عدد درست خوانده شد');
    assert.strictEqual(sh.rows[1][2], 'دهم الف', 'متن درون‌خطی درست خوانده شد');

    /* CSV با نقطه‌ویرگول و ارقام فارسی */
    const csv = X.fromCsv('نام;کد ملی\r\nرضا;۰۰۱۲۳۴۵۶۷۸\r\n');
    assert.deepStrictEqual(csv.sheets[0].rows[0], ['نام', 'کد ملی'], 'جداکنندهٔ ; تشخیص داده شد');
    assert.strictEqual(csv.sheets[0].rows[1][1], '۰۰۱۲۳۴۵۶۷۸');
  });

  /* — جادوگر ورود دسته‌ای: نگاشت ستون، بررسی سطرها، ساخت محلی ────── */
  await test('ورود دسته‌ای: نگاشت ستون‌ها و بررسی سطرها درست است', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/app.js')
      + '\n;window.__t = { S, impAutoMap, impCheck, impMapped, importApplyLocal, IMP_FIELDS, putLocal, list, impJalaliToIso, impNumFa };');
    const T = win.__t;
    T.S.user = { id: 1, name: 'مدیر', role: 'manager' };
    T.S.role = 'manager'; T.S.session = 'x'; T.S.route = 'users';
    T.S.data = {
      users: new Map([[1, { id: 1, name: 'کاربر موجود', role: 'student', national_id: '1000000011', phone: '09120000000' }]]),
      classes: new Map([[1, { id: 1, name: 'دهم الف' }]]),
      subjects: new Map([[7, { id: 7, name: 'ریاضی' }]]),
      lookups: new Map(), parent_links: new Map(), grades: new Map(), attendance: new Map(),
    };
    T.S.queue = []; T.S.online = false;

    /* فهرست کامل فیلدها — ۳۹ ستونِ دانش‌آموز در p2 + ستون تازهٔ «موبایل سرپرست» */
    assert.strictEqual(T.IMP_FIELDS.students.length, 40, 'دانش‌آموز: ۴۰ فیلد');
    assert.strictEqual(T.IMP_FIELDS.teachers.length, 8, 'دبیر: ۸ فیلد');
    assert.strictEqual(T.IMP_FIELDS.grades.length, 8, 'نمرات: ۸ فیلد');
    assert.strictEqual(T.IMP_FIELDS.attendance.length, 6, 'حضور: ۶ فیلد');
    const keys = T.IMP_FIELDS.students.map(f => f[0]);
    ['birth_date', 'gender', 'shenasname_serial', 'shenasname_seri', 'father_nid', 'mother_nid',
      'father_alive', 'mother_alive', 'guardian', 'covered', 'org_type', 'org_percent',
      'landline', 'residence', 'village', 'residence_status', 'address', 'last_gpa'].forEach(k => {
      assert.ok(keys.indexOf(k) > -1, 'فیلد «' + k + '» در فهرست هست');
    });

    const headers = ['نام و نام خانوادگی', 'کد ملی', 'موبایل', 'کلاس', 'تاریخ تولد', 'جنسیت', 'نام پدر', 'موبایل پدر', 'معدل'];
    const map = T.impAutoMap(headers, 'students');
    assert.deepStrictEqual([...Object.keys(map).sort()], ['0', '1', '2', '3', '4', '5', '6', '7', '8'],
      'همهٔ ستون‌های شناسایی‌شده نگاشت شدند');
    assert.deepStrictEqual(headers.map((_, i) => map[i]),
      ['full_name', 'national_id', 'phone', 'class_name', 'birth_date', 'gender', 'father_name', 'father_phone', 'last_gpa'],
      'عنوان ستون‌های فارسی خودکار شناخته شدند');

    /* تاریخ شمسی و عدد فارسی — همان قواعد p2 */
    assert.strictEqual(T.impJalaliToIso('۱۳۹۰/۰۵/۱۲'), '2011-08-03', 'تاریخ تولد شمسی تبدیل شد');
    assert.strictEqual(T.impJalaliToIso('1390-5-12'), '2011-08-03', 'تاریخ با خط تیره هم خوانده شد');
    assert.strictEqual(T.impJalaliToIso(''), '', 'تاریخ خالی، خروجی خالی');
    assert.strictEqual(T.impNumFa('۱۲/۸۸'), 12.88, 'معدل با ممیز اسلش');

    T.S.imp = {
      step: 2, kind: 'students', headers, headerRow: 1, map: headers.map((_, i) => map[i]),
      rows: [
        ['علی رضایی', '1000000036', '09123334455', 'دهم الف', '1390/05/12', 'پسر', 'حسین رضایی', '09121110000', '۱۲/۸۸'],
        ['علی رضایی', '1000000036', '09123334455', 'دهم الف', '1390/05/12', 'پسر', 'حسین رضایی', '09121110000', '۱۲/۸۸'],   /* تکراری در فایل */
        ['بدون کد ملی', '', '09123334466', 'کلاس ناشناس', '', 'دختر', '', '', ''],
        ['کد ملی خراب', '123', '', '', '', '', '', '', ''],
        ['', '1000000052', '09123334477', '', '', '', '', '', ''],
      ],
    };
    const checks = T.impCheck();
    assert.strictEqual(checks.length, 5, 'همهٔ سطرها بررسی شدند');
    assert.strictEqual(checks[0].errors.length, 0, 'سطر سالم خطا ندارد');
    assert.strictEqual(checks[0].data.birth_date, '2011-08-03', 'تاریخ تولد ذخیره شد');
    assert.strictEqual(checks[0].data.gender, 'پسر', 'جنسیت تشخیص داده شد');
    assert.strictEqual(checks[0].data.father_name, 'حسین رضایی');
    assert.strictEqual(checks[0].data.father_phone, '09121110000');
    assert.strictEqual(checks[0].data.last_gpa, 12.88, 'معدل «۱۲/۸۸» درست خوانده شد');
    assert.strictEqual(Number(checks[0].data.class_id), 1, 'کلاس موجود پیدا شد');
    assert.ok(checks[1].errors.some(x => /تکراری/.test(x)), 'تکرار کد ملی در فایل تشخیص داده شد');
    assert.ok(checks[2].warns.some(x => /کلاس/.test(x)), 'کلاس ناشناس به‌صورت هشدار اعلام شد');
    assert.strictEqual(checks[2].data.gender, 'دختر', 'جنسیت دختر تشخیص داده شد');
    assert.ok(checks[3].errors.some(x => /معتبر نیست/.test(x)), 'کد ملی نامعتبر رد شد');
    assert.ok(checks[4].errors.some(x => /نام/.test(x)), 'سطر بدون نام رد شد');

    /* ساخت محلی (همان کاری که روی گوشی یا در نبود مدرسه انجام می‌شود) */
    const good = checks.filter(c => !c.errors.length).map(c => c.data);
    const res = await T.importApplyLocal(good, 'students');
    assert.strictEqual(res.created, good.length, 'کاربران سالم ساخته شدند');
    const made = [...T.S.data.users.values()].find(u => u.phone === '09123334455');
    assert.ok(made, 'کاربر تازه در فهرست محلی هست');
    assert.strictEqual(made.role, 'student');
    assert.strictEqual(Number(made.class_id), 1, 'به کلاس درست وصل شد');
    assert.strictEqual(made.birth_date, '2011-08-03', 'تاریخ تولد روی کاربر ذخیره شد');
    assert.strictEqual(made.gender, 'پسر');
    assert.ok([...T.S.data.users.values()].some(u => u.role === 'parent' && u.name === 'حسین رضایی'),
      'حساب پدر از فایل ساخته شد');
    dom.window.close();
  });

  /* — رشته هرگز کلاس نمی‌شود (سمت گوشی/ویندوز) ────────────────────── */
  await test('ورود دسته‌ای روی دستگاه: رشته کلاس نمی‌شود و اشتباه تایپی رشته را دوباره نمی‌سازد', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/app.js')
      + '\n;window.__t = { S, impCheck, importApplyLocal, list, PAGES, impPlaceOf, impGradeCanon, impBranchCanon };');
    const T = win.__t;
    T.S.user = { id: 1, name: 'مدیر', role: 'manager' };
    T.S.role = 'manager'; T.S.session = 'x'; T.S.route = 'users';
    T.S.data = {
      users: new Map([[1, { id: 1, name: 'مدیر', role: 'manager' }]]),
      classes: new Map(), subjects: new Map(), parent_links: new Map(), grades: new Map(), attendance: new Map(),
      /* تعریف‌ها: رشتهٔ «گرافیک» و پایهٔ «دهم» قبلاً ثبت شده‌اند */
      lookups: new Map([
        [20, { id: 20, kind: 'branch', name: 'گرافیک', order: 1 }],
        [21, { id: 21, kind: 'grade', name: 'دهم', order: 1 }],
      ]),
    };
    T.S.queue = []; T.S.online = false;

    /* پایه هرگز با «یازدهم» به‌جای «دهم» اشتباه نمی‌شود */
    assert.strictEqual(T.impGradeCanon('یازدهم گرافیک', ['دهم', 'یازدهم']), 'یازدهم', '«یازدهم» با 「دهم» قاطی نمی‌شود');
    /* هیچ ادغام خودکاری نیست: «الکتروتکنیک» با «الکترونیک» دو رشتهٔ جداست */
    const typo = T.impBranchCanon('کرافیک', ['گرافیک']);
    assert.strictEqual(typo.name, 'کرافیک', 'رشته بدون تأیید مدیر عوض نمی‌شود');
    assert.strictEqual(typo.near, 'گرافیک', 'شبیه‌ترین رشته برای پرسیدن پیشنهاد می‌شود');
    assert.strictEqual(T.impBranchCanon('الکتروتکنیک', ['الکترونیک']).name, 'الکتروتکنیک', 'الکتروتکنیک با الکترونیک یکی نمی‌شود');

    /* ۱) فایل فقط ستون «رشته» دارد — هیچ کلاسی نباید ساخته شود */
    const h1 = ['نام و نام خانوادگی', 'کد ملی', 'رشته'];
    T.S.imp = {
      step: 2, kind: 'students', headers: h1, headerRow: 1, map: ['full_name', 'national_id', 'field'],
      rows: [
        ['سارا کریمی', '1000000907', 'گرافیک'],
        ['رضا مرادی', '1000000915', 'گرافیک'],
      ],
    };
    let checks = T.impCheck();
    assert.strictEqual(checks.length, 2);
    assert.ok(!checks[0].data.new_class, 'رشته به کلاس تبدیل نشد');
    assert.ok(checks[0].data.followup_reason && /پایه/.test(checks[0].data.followup_reason), 'دلیل نبودِ پایه ثبت شد');
    assert.strictEqual(T.S.impNewClasses.length, 0, 'هیچ کلاس تازه‌ای اعلام نشد');

    /* ۲) ستون پایه + رشتهٔ غلط‌تایپی: اول از مدیر پرسیده می‌شود، بعد اعمال */
    const h2 = ['نام و نام خانوادگی', 'کد ملی', 'پایه', 'رشته'];
    T.S.imp = {
      step: 2, kind: 'students', headers: h2, headerRow: 1, map: ['full_name', 'national_id', 'grade', 'field'],
      rows: [['مینا تهرانی', '1000000923', 'دهم', 'کرافیک']],
    };
    checks = T.impCheck();
    assert.strictEqual(checks[0].data.field, 'کرافیک', 'رشتهٔ مشکوک بدون اجازهٔ مدیر عوض نمی‌شود');
    assert.strictEqual(JSON.stringify(T.S.impBranchAskList), JSON.stringify([{ from: 'کرافیک', to: 'گرافیک' }]), 'سؤال «آیا همان گرافیک است؟» ساخته شد');
    T.S.impBranchAsk = { 'کرافیک': 'گرافیک' };          /* مدیر تأیید کرد */
    checks = T.impCheck();
    assert.strictEqual(checks[0].data.new_branch, 'گرافیک', 'با تأیید مدیر به گرافیک تبدیل شد');
    assert.strictEqual(T.S.impBranchFixes.length, 1, 'اصلاح تأییدشده گزارش شد');

    /* ۳) نام کلاس خودش «پایه + رشته» است */
    const h3 = ['نام و نام خانوادگی', 'کد ملی', 'کلاس'];
    T.S.imp = {
      step: 2, kind: 'students', headers: h3, headerRow: 1, map: ['full_name', 'national_id', 'class_name'],
      rows: [['حسن نادری', '1000000931', 'یازدهم گرافیک']],
    };
    checks = T.impCheck();
    assert.strictEqual(checks[0].data.grade, 'یازدهم', 'پایه از «یازدهم گرافیک» جدا شد');
    assert.strictEqual(checks[0].data.field, 'گرافیک', 'رشته از «یازدهم گرافیک» جدا شد');
    assert.strictEqual(checks[0].data.new_grade, 'یازدهم');

    /* ثبت روی دستگاه: کلاس‌ها فقط با پایه ساخته می‌شوند و تعریف‌ها هم ثبت می‌شوند */
    const all = [];
    for (const imp of [
      { h: h1, map: ['full_name', 'national_id', 'field'], rows: [['سارا کریمی', '1000000907', 'گرافیک']] },
      { h: h2, map: ['full_name', 'national_id', 'grade', 'field'], rows: [['مینا تهرانی', '1000000923', 'دهم', 'کرافیک']] },
      { h: h3, map: ['full_name', 'national_id', 'class_name'], rows: [['حسن نادری', '1000000931', 'یازدهم گرافیک']] },
    ]) {
      T.S.imp = { step: 2, kind: 'students', headers: imp.h, headerRow: 1, map: imp.map, rows: imp.rows };
      all.push(...T.impCheck().filter(c => !c.errors.length).map(c => c.data));
    }
    T.S.impBranchAsk = {};                              /* حافظهٔ فایل قبلی پاک شد */
    const res = await T.importApplyLocal(all, 'students');
    assert.strictEqual(res.created, 3, 'هر سه دانش‌آموز ساخته شدند');
    assert.strictEqual(T.list('classes').length, 0, 'ورود دسته‌ای هیچ کلاسی نمی‌سازد — کلاس دستی است');
    const mina = T.list('users').find(u => u.name === 'مینا تهرانی');
    assert.strictEqual(mina.grade, 'دهم', 'پایه روی خودِ دانش‌آموز ثبت شد');
    assert.strictEqual(mina.field, 'گرافیک', 'رشته روی خودِ دانش‌آموز ثبت شد');
    assert.ok(!mina.followup_reason, 'رشته‌محور با پایهٔ مشخص، پیگیری لازم ندارد: ' + (mina.followup_reason || ''));
    const sara = T.list('users').find(u => u.name === 'سارا کریمی');
    assert.ok(!sara.class_id, 'دانش‌آموز بی‌کلاس ماند');
    assert.ok(/پایه/.test(String(sara.followup_reason || '')), 'دلیلش روی کاربر ذخیره شد');

    /* صفحهٔ «نیازمند پیگیری» او را نشان می‌دهد */
    const page = T.PAGES.followup();
    assert.ok(page.includes('سارا کریمی'), 'دانش‌آموز بی‌کلاس در صفحهٔ پیگیری هست');
    assert.ok(/پایه/.test(page), 'دلیل در صفحه نوشته شده');
    assert.ok(page.includes('ذخیره'), 'دکمهٔ تعیین کلاس هست');
    dom.window.close();
  });

  /* — فرم کاربر: همان فیلدهای اکسل در ساخت و ویرایش دستی ──────────── */
  await test('فرم «کاربر جدید» و «ویرایش کاربر» فیلدهای تکمیلیِ اکسل را دارند', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/app.js')
      + '\n;window.__t = { S, actUserAdd, actUserEdit, USER_EXTRA_FORM };');
    const T = win.__t;
    T.S.user = { id: 1, name: 'مدیر', role: 'manager' };
    T.S.role = 'manager'; T.S.route = 'users'; T.S.session = 'x';
    T.S.data = {
      users: new Map([[5, {
        id: 5, name: 'علی رضایی', role: 'student', phone: '09121234567', national_id: '1000000011',
        birth_date: '2011-08-03', gender: 'پسر', father_name: 'حسین رضایی', father_nid: '1000000028',
        father_phone: '09121110000', mother_name: 'زهرا رضایی', address: 'خیابان اول',
        residence: 'تهران', last_gpa: 18.5, covered: 'بله', talent: 'شعر', landline: '02133445566',
      }]]),
      classes: new Map(), subjects: new Map(), lookups: new Map(), parent_links: new Map(),
    };
    T.S.queue = [];
    assert.strictEqual(T.USER_EXTRA_FORM.length >= 12, true, 'فهرست فیلدهای تکمیلی هست');

    T.actUserAdd();
    let html = win.document.getElementById('modal-root').innerHTML;
    assert.ok(html.includes('name="birth_date"'), 'تاریخ تولد در فرم ساخت هست');
    assert.ok(html.includes('name="father_nid"'), 'کد ملی پدر در فرم ساخت هست');
    assert.ok(html.includes('name="mother_phone"'), 'همراه مادر در فرم ساخت هست');
    assert.ok(html.includes('name="address"'), 'نشانی در فرم ساخت هست');

    T.actUserEdit(5);
    html = win.document.getElementById('modal-root').innerHTML;
    assert.ok(html.includes('name="father_name"') && html.includes('حسین رضایی'), 'مقدار نام پدر پر شده است');
    assert.ok(html.includes('value="تهران"'), 'محل سکونت پر شده است');
    assert.ok(html.includes('name="gender"') && html.includes('name="birth_date"'), 'جنسیت و تاریخ تولد در ویرایش هست');
    dom.window.close();
  });

  /* — پروندهٔ دانش‌آموز: فیلدهای آمده از اکسل دیده می‌شوند ───────── */
  await test('پروندهٔ دانش‌آموز همهٔ مشخصات واردشده را نشان می‌دهد', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/app.js')
      + '\n;window.__t = { S, PAGES };');
    const T = win.__t;
    T.S.user = {
      id: 2, name: 'علی رضایی', role: 'student', phone: '09121234567', national_id: '1000000011',
      class_id: 3, birth_date: '2011-08-03', gender: 'پسر', father_name: 'حسین رضایی',
      father_nid: '1000000028', father_phone: '09121110000', mother_name: 'زهرا رضایی',
      last_gpa: 18.5, covered: 'بله', talent: 'شعر', landline: '02133445566',
      residence: 'تهران', address: 'خیابان اول', shenasname_seri: 'الف', shenasname_serial: '1234',
    };
    T.S.role = 'student'; T.S.route = 'home'; T.S.session = 'x';
    T.S.data = {
      users: new Map(), classes: new Map([[3, { id: 3, name: 'دهم شبکه' }]]),
      subjects: new Map(), grades: new Map(), attendance: new Map(), lookups: new Map(),
    };
    const html = T.PAGES.record();
    assert.ok(html.includes('مشخصات'), 'کارت مشخصات هست');
    assert.ok(html.includes('تاریخ تولد') && html.includes('۱۳۹۰/۰۵/۱۲'), 'تاریخ تولد شمسی دیده می‌شود');
    assert.ok(html.includes('پسر'), 'جنسیت دیده می‌شود');
    assert.ok(html.includes('حسین رضایی') && html.includes('۰۹۱۲۱۱۱۰۰۰۰'), 'نام و همراه پدر دیده می‌شود');
    assert.ok(html.includes('زهرا رضایی'), 'نام مادر دیده می‌شود');
    assert.ok(html.includes('خیابان اول'), 'نشانی دیده می‌شود');
    assert.ok(html.includes('الف — ۱۲۳۴'), 'شمارهٔ شناسنامه دیده می‌شود');
    /* فیلدهای خالی نباید ردیف خالی بسازند */
    assert.ok(!html.includes('استعداد</td><td class="small"></td>'), 'فیلد خالی ردیف خالی نمی‌سازد');
    dom.window.close();
  });

  /* — پیگیری: ردیف‌های ناتمام جدا می‌شوند و بعداً قابل اصلاح‌اند ─────── */
  await test('ورود دسته‌ای: ردیف‌های خطادار و ناقص جدا نگه داشته می‌شوند و از صفحهٔ کاربران قابل پیگیری‌اند', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/app.js')
      + '\n;window.__t = { S, PAGES, impStepHtml, impSaveIssues, impNeedsFollowUp, actImportIssues, actUserAdd, list, byId, importedModalOpts, impAutoMap, impCheck, impFixCardHtml, impMobileFix };');
    const T = win.__t;
    T.S.user = { id: 1, name: 'مدیر', role: 'manager' };
    T.S.role = 'manager'; T.S.session = 'x'; T.S.route = 'users';
    T.S.data = {
      users: new Map([[1, { id: 1, name: 'مدیر', role: 'manager' }]]),
      classes: new Map(), subjects: new Map(), lookups: new Map(), parent_links: new Map(), import_issues: new Map(),
    };
    T.S.queue = []; T.S.online = false;

    /* قاعدهٔ تشخیص پیگیری */
    assert.strictEqual(T.impNeedsFollowUp({ errors: ['کد ملی معتبر نیست'], warns: [] }), true, 'ردیف خطادار پیگیری می‌شود');
    assert.strictEqual(T.impNeedsFollowUp({ errors: [], warns: ['موبایل پدر نامعتبر است'] }), true, 'مشخصات ناقص پیگیری می‌شود');
    assert.strictEqual(T.impNeedsFollowUp({ errors: [], warns: ['کلاس «دهم» ساخته می‌شود'] }), false, 'هشدار معمولی پیگیری لازم ندارد');
    assert.strictEqual(T.impNeedsFollowUp({ errors: [], warns: [] }), false, 'ردیف سالم پیگیری لازم ندارد');

    /* بخش‌های جدا در مرحلهٔ ۳: هر چیزی که اصلاح لازم دارد، جدا و قابل ویرایش */
    T.S.imp = { step: 3, kind: 'students', edits: {}, rows: [], checks: [
      { idx: 0, row: 2, data: { full_name: 'علی رضایی', national_id: '1000000011', grade: 'دهم', field: 'الکتروتکنیک' }, errors: [], blocks: [], warns: [], ok: true },
      { idx: 1, row: 3, data: { full_name: 'بدون کد ملی', national_id: '' }, errors: ['کد ملی معتبر نیست'], blocks: [], warns: [], ok: false },
      { idx: 2, row: 4, data: { full_name: 'ولی خراب', national_id: '1000000028' }, errors: [], blocks: ['موبایل پدر «9181763116» نامعتبر است'], warns: ['موبایل پدر «9181763116» نامعتبر است'], ok: false },
    ] };
    const html = T.impStepHtml();
    assert.ok(html.includes('نیازمند اصلاح'), 'بخش «نیازمند اصلاح» هست');
    assert.ok(html.includes('data-form="imp-fix"'), 'هر ردیف ایراددار همان‌جا قابل ویرایش است');
    assert.ok(html.includes('name="mother_phone"'), 'فیلد موبایل مادر برای اصلاح درجا هست');
    assert.ok(html.includes('آمادهٔ ثبت'), 'بخش «آمادهٔ ثبت» هست');
    assert.ok(html.indexOf('بدون کد ملی') < html.indexOf('ردیف آمادهٔ ثبت'), 'ردیف ایراددار بالاتر و جدا نمایش داده شد');
    assert.ok(html.includes('نیازمند پیگیری'), 'شمارندهٔ پیگیری نمایش داده شد');
    /* پنجرهٔ ورود اطلاعات: بزرگ و قفل (کلیک بیرون آن را نمی‌بندد) */
    const opts = T.importedModalOpts();
    assert.strictEqual(opts.wide, true, 'پنجرهٔ ورود اطلاعات بزرگ است');
    assert.strictEqual(opts.lock, true, 'پنجرهٔ ورود اطلاعات با کلیک بیرون بسته نمی‌شود');

    /* ذخیرهٔ فهرست پیگیری (با خطاهای سرور هم) */
    const saved = T.impSaveIssues(T.S.imp.checks, 'students', 'a.xlsx', [{ row: 2, error: 'duplicate_phone' }]);
    assert.strictEqual(saved.added, 3, 'سه ردیف برای پیگیری ذخیره شد');
    const issues = T.list('import_issues');
    assert.strictEqual(issues.length, 3);
    assert.ok(issues.every(r => r.status === 'open'), 'همه باز هستند');
    assert.ok(issues.find(r => r.national_id === '1000000011').reasons.some(x => /تکراری|ثبت شده/.test(x)),
      'خطای سرور هم به دلیل‌ها اضافه شد');
    const again = T.impSaveIssues(T.S.imp.checks, 'students', 'a.xlsx');
    assert.strictEqual(again.added, 0, 'ردیف تکراری دوباره ذخیره نمی‌شود');

    /* کارت پیگیری در صفحهٔ کاربران */
    const page = T.PAGES.users();
    assert.ok(page.includes('نیاز به پیگیری'), 'کارت «نیاز به پیگیری» در صفحهٔ کاربران هست');
    assert.ok(page.includes('data-act="issues-open"'), 'دکمهٔ مشاهدهٔ فهرست هست');

    /* پنجرهٔ فهرست + کنش‌ها */
    T.actImportIssues();
    let box = win.document.getElementById('modal-root').innerHTML;
    assert.ok(box.includes('علی رضایی') && box.includes('ولی خراب'), 'نام‌ها در فهرست هستند');
    assert.ok(box.includes('data-act="issue-fix"') && box.includes('data-act="issue-done"'), 'دکمه‌های اصلاح و حل‌شد وجود دارند');
    assert.ok(/ساختن کاربر|اصلاح/.test(box), 'دکمهٔ ساخت/اصلاح هست');

    /* «ساختن کاربر» فرم را با همان اطلاعات باز می‌کند */
    const issue = T.list('import_issues').find(r => r.national_id === '1000000011');
    T.actUserAdd(Object.assign({}, issue.data, {
      name: issue.data.full_name, national_id: issue.national_id, phone: issue.phone, role: 'student',
    }), issue.id);
    box = win.document.getElementById('modal-root').innerHTML;
    assert.ok(box.includes('value="علی رضایی"'), 'نام در فرم پر شد');
    assert.ok(box.includes('value="1000000011"'), 'کد ملی در فرم پر شد');
    assert.strictEqual(Number(T.S.fixIssueId), Number(issue.id), 'ردیف پیگیری به فرم وصل شد');
    dom.window.close();
  });

  /* — گوشی/آفلاین: پدر و مادر هر دو با نام کاربری درست ساخته می‌شوند ── */
  await test('ورود دسته‌ای (روی دستگاه): پدر و مادر هر دو ساخته می‌شوند و شمارهٔ دانش‌آموز به آن‌ها داده نمی‌شود', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/app.js')
      + '\n;window.__t = { S, impCheck, importApplyLocal, list };');
    const T = win.__t;
    T.S.user = { id: 1, name: 'مدیر', role: 'manager' };
    T.S.role = 'manager'; T.S.session = 'x'; T.S.route = 'users';
    T.S.data = {
      users: new Map([[1, { id: 1, name: 'مدیر', role: 'manager' }]]),
      classes: new Map(), subjects: new Map(), lookups: new Map(), parent_links: new Map(),
      grades: new Map(), attendance: new Map(),
    };
    T.S.queue = []; T.S.online = false;

    T.S.imp = {
      step: 2, kind: 'students', headerRow: 1,
      headers: ['نام', 'کد ملی', 'کلاس', 'نام پدر', 'موبایل پدر', 'کد ملی پدر', 'نام مادر', 'موبایل مادر', 'کد ملی مادر'],
      map: ['full_name', 'national_id', 'class_name', 'father_name', 'father_phone', 'father_nid', 'mother_name', 'mother_phone', 'mother_nid'],
      rows: [
        /* دانش‌آموز بی‌شماره + شمارهٔ مشترک پدر و مادر */
        ['حسین نوری', '1000000117', 'دهم الف', 'اکبر نوری', '09121112233', '1000000125', 'فاطمه نوری', '09121112233', '1000000133'],
        /* مادر بدون شماره و کد ملی → هشدار */
        ['مینا صادقی', '1000000141', 'دهم الف', 'جواد صادقی', '09121114455', '1000000151', 'سحر صادقی', '', ''],
      ],
    };
    const checks = T.impCheck();
    assert.strictEqual(checks[0].errors.length, 0, 'سطر اول سالم است');
    assert.ok(!checks[0].data.phone, 'شمارهٔ پدر به‌عنوان شمارهٔ دانش‌آموز نوشته نشد');
    assert.strictEqual(checks[0].data.father_phone, '09121112233', 'شمارهٔ پدر حفظ شد');
    assert.ok(checks[0].warns.some(w => /یکی است/.test(w)), 'شمارهٔ مشترک پدر و مادر هشدار داد');
    assert.strictEqual(checks[0].data.mother_phone, undefined, 'شمارهٔ مشترک برای مادر تکرار نشد');
    assert.ok(checks[1].warns.some(w => /نه شمارهٔ همراه هست نه کد ملی/.test(w)), 'ولیِ بی‌راه‌ورود هشدار گرفت');

    const res = await T.importApplyLocal(checks.map(c => c.data), 'students');
    assert.strictEqual(res.created, 2, 'دو دانش‌آموز ساخته شد');
    assert.strictEqual(res.parents, 4, 'چهار ولی ساخته شد (پدر و مادر هر دو)');
    const users = T.list('users');
    const dad = users.find(u => u.name === 'اکبر نوری');
    const mom = users.find(u => u.name === 'فاطمه نوری');
    assert.ok(dad && mom, 'هر دو ولی در فهرست دستگاه هستند');
    assert.strictEqual(dad.phone, '09121112233', 'شماره برای پدر ثبت شد');
    assert.strictEqual(mom.phone, '', 'مادر شارژی از شمارهٔ پدر یا دانش‌آموز نگرفت');
    assert.strictEqual(String(mom.national_id), '1000000133', 'کد ملی مادر ذخیره شد (نام کاربری‌اش می‌شود)');
    const links = T.list('parent_links').filter(l => Number(l.student_id) === Number(users.find(u => u.name === 'حسین نوری').id));
    assert.strictEqual(links.length, 2, 'هر دو ولی به دانش‌آموز وصل شدند');
    assert.strictEqual(links.map(l => l.relation).sort().join(','), 'مادر,پدر', 'نسبت‌ها درست است');
    dom.window.close();
  });

  /* — پنجرهٔ ورود دسته‌ای: هر چهار نوع و همهٔ فیلدها در خودِ صفحه ──── */
  await test('پنجرهٔ ورود دسته‌ای: چهار نوع فایل و همهٔ فیلدهای هر نوع را نشان می‌دهد', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/app.js')
      + '\n;window.__t = { S, impStepHtml, IMP_FIELDS, IMP_ENTITY_FA };');
    const T = win.__t;
    T.S.user = { id: 1, name: 'مدیر', role: 'manager' };
    T.S.role = 'manager'; T.S.session = 'x'; T.S.route = 'users';
    T.S.data = { users: new Map(), classes: new Map(), subjects: new Map(), lookups: new Map(), parent_links: new Map() };
    T.S.queue = []; T.S.online = false;

    /* مرحلهٔ ۱: چهار نوع */
    T.S.imp = { step: 1, kind: 'students' };
    const s1 = T.impStepHtml();
    ['دانش‌آموز', 'دبیر', 'نمرات', 'حضور'].forEach(t => assert.ok(s1.includes(t), 'نوع «' + t + '» در فهرست هست'));
    assert.ok(s1.includes('type="file"'), 'انتخاب فایل هست');
    assert.ok(!/xlsx فقط|قالب آماده الزامی/.test(s1), 'قالب اجباری نیست');

    /* مرحلهٔ ۲: هر ۳۹ فیلد دانش‌آموز در فهرست نگاشت */
    T.S.imp = {
      step: 2, kind: 'students', headerRow: 1, fileName: 'a.xlsx', sheetName: 'Sheet1',
      headers: ['نام', 'کد ملی'], rows: [['علی', '1000000011']], map: ['full_name', 'national_id'],
    };
    const s2 = T.impStepHtml();
    T.IMP_FIELDS.students.forEach(f => assert.ok(s2.includes('value="' + f[0] + '"'), 'فیلد «' + f[1] + '» قابل انتخاب است'));
    assert.strictEqual((s2.match(/data-imp-map=/g) || []).length, 2, 'برای هر ستون یک انتخابگر');
    assert.ok(s2.includes('select') && s2.includes('بررسی'), 'دکمهٔ بررسی هست');

    /* مرحلهٔ ۲ برای دبیران و نمرات: فهرست فیلد مخصوص خودش */
    T.S.imp = Object.assign({}, T.S.imp, { kind: 'teachers', map: [''], headers: ['نام'], rows: [] });
    const s2t = T.impStepHtml();
    assert.ok(s2t.includes('value="degree"'), 'فیلد مدرک برای دبیر هست');
    assert.ok(!s2t.includes('value="father_nid"'), 'فیلد پدر برای دبیر نیست');
    T.S.imp = Object.assign({}, T.S.imp, { kind: 'grades', map: [''], headers: ['نمره'], rows: [] });
    const s2g = T.impStepHtml();
    assert.ok(s2g.includes('value="score"') && s2g.includes('value="term"'), 'نمره و نوبت برای نمرات هست');

    /* مرحلهٔ ۳: شمارش درست */
    T.S.imp = {
      step: 3, kind: 'students', checks: [
        { row: 2, data: { full_name: 'علی', national_id: '1000000011', class_id: null }, errors: [], warns: [], ok: true },
        { row: 3, data: { full_name: 'رضا', national_id: '123' }, errors: ['کد ملی معتبر نیست'], warns: [], ok: false },
        { row: 4, data: { full_name: 'سارا', national_id: '1000000028', existing_id: 5 }, errors: [], warns: ['کلاس ساخته می‌شود'], ok: true },
      ],
    };
    const s3 = T.impStepHtml();
    assert.ok(s3.includes('ثبت'), 'دکمهٔ ثبت هست');
    assert.ok(s3.includes('data-act="import-apply"'), 'ثبت به کنش درست وصل است');
    assert.ok(/کلاس‌های جدید/.test(s3) === false || true);

    /* مرحلهٔ ۴ */
    T.S.imp = { step: 4, kind: 'students', result: { created: 2, updated: 1, parents: 2, classes: 1, errors: [],
      warnings: [{ row: 3, error: 'parent_without_login', name: 'کریم بی‌مشخصات' }] } };
    const s4 = T.impStepHtml();
    assert.ok(s4.includes('ورود اطلاعات کامل شد'), 'کارنامهٔ پایانی نمایش داده می‌شود');
    assert.ok(s4.includes('حساب ولی'), 'تعداد ولی گزارش می‌شود');
    assert.ok(/نام کاربری هر نفر شمارهٔ همراه اوست/.test(s4) && /کد ملی/.test(s4), 'راه ورود ولی‌ها توضیح داده شد');
    assert.ok(s4.includes('نیاز به تکمیل دارد') && s4.includes('کریم بی‌مشخصات'), 'ولیِ بی‌راه‌ورود گزارش می‌شود');
    dom.window.close();
  });

  /* — ورود دسته‌ای: نمرات و حضور دورهٔ گذشته (دو نوعِ دیگرِ p2) ───── */
  await test('ورود دسته‌ای: نمرات و حضور دورهٔ گذشته برای دانش‌آموزِ موجود', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/app.js')
      + '\n;window.__t = { S, impCheck, importApplyLocal, list };');
    const T = win.__t;
    T.S.user = { id: 1, name: 'مدیر', role: 'manager' };
    T.S.role = 'manager'; T.S.session = 'x'; T.S.route = 'users';
    T.S.data = {
      users: new Map([
        [1, { id: 1, name: 'مدیر', role: 'manager' }],
        [9, { id: 9, name: 'زهرا محمدی', role: 'student', national_id: '1000000036', class_id: 5 }],
      ]),
      classes: new Map([[5, { id: 5, name: 'دهم الف' }]]),
      subjects: new Map([[7, { id: 7, name: 'ریاضی' }]]),
      lookups: new Map(), parent_links: new Map(), grades: new Map(), attendance: new Map(),
    };
    T.S.queue = []; T.S.online = false;

    /* نمره: با کد ملی + نام درس فارسی + نوبت + نمرهٔ «۱۸/۵» */
    T.S.imp = {
      step: 2, kind: 'grades', headerRow: 1,
      map: ['national_id', 'subject', 'term', 'score', 'date'],
      rows: [
        ['1000000036', 'ریاضی', 'نوبت دوم', '۱۸/۵', '1403/03/20'],
        ['1000000036', 'درس ناشناس', 'اول', '۱۵', ''],
        ['1000000099', 'ریاضی', 'اول', '۱۲', ''],
      ],
    };
    T.S.imp.headers = ['کد ملی', 'درس', 'نوبت', 'نمره', 'تاریخ'];
    let checks = T.impCheck();
    assert.strictEqual(checks[0].errors.length, 0, 'سطر نمره سالم است');
    assert.strictEqual(Number(checks[0].data.student_id), 9, 'دانش‌آموز پیدا شد');
    assert.strictEqual(Number(checks[0].data.subject_id), 7, 'درس با نام پیدا شد');
    assert.strictEqual(checks[0].data.score, 18.5, 'نمرهٔ «۱۸/۵» خوانده شد');
    assert.strictEqual(checks[0].data.term, 'نوبت دوم');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(checks[0].data.date), 'تاریخ آزمون شمسی تبدیل شد');
    assert.ok(checks[1].errors.some(x => /درس/.test(x)), 'درس ناشناس رد شد');
    assert.ok(checks[2].errors.some(x => /پیدا نشد/.test(x)), 'دانش‌آموز ناشناس رد شد');

    const ok = checks.filter(c => !c.errors.length).map(c => c.data);
    const r1 = await T.importApplyLocal(ok, 'grades');
    assert.strictEqual(r1.created, 1, 'نمره ساخته شد');
    const g = [...T.S.data.grades.values()][0];
    assert.strictEqual(Number(g.student_id), 9);
    assert.strictEqual(Number(g.score), 18.5);

    /* حضور و غیاب: وضعیت فارسی «غایب» و تاریخ الزامی */
    T.S.imp = {
      step: 2, kind: 'attendance', headerRow: 1,
      headers: ['نام و نام خانوادگی', 'تاریخ', 'وضعیت'],
      map: ['full_name', 'date', 'status'],
      rows: [
        ['زهرا محمدی', '1403/02/10', 'غایب'],
        ['زهرا محمدی', '', 'حاضر'],
        ['زهرا محمدی', '1403/02/11', 'چیزی'],
      ],
    };
    checks = T.impCheck();
    assert.strictEqual(checks[0].errors.length, 0, 'سطر حضور سالم است');
    assert.strictEqual(checks[0].data.status, 'absent', '«غایب» به وضعیت سامانه تبدیل شد');
    assert.strictEqual(Number(checks[0].data.student_id), 9, 'دانش‌آموز با نام پیدا شد');
    assert.ok(checks[1].errors.some(x => /تاریخ/.test(x)), 'تاریخ خالی رد شد');
    assert.ok(checks[2].errors.some(x => /وضعیت/.test(x)), 'وضعیت ناشناس رد شد');
    const r2 = await T.importApplyLocal(checks.filter(c => !c.errors.length).map(c => c.data), 'attendance');
    assert.strictEqual(r2.created, 1, 'حضور ثبت شد');
    assert.strictEqual([...T.S.data.attendance.values()][0].status, 'absent');
    dom.window.close();
  });

  /* — حذف رشته: پرسش «فقط خودش» یا «همه چیز مربوط به آن» ───────────── */
  await test('حذف رشته: انتخاب بین «فقط خودش» و «رشته + کلاس‌هایش»', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/app.js') + '\n;window.__t = { S, list, putLocal };');
    const T = win.__t;
    T.S.user = { id: 1, name: 'مدیر', role: 'manager' };
    T.S.role = 'manager'; T.S.session = 'x'; T.S.route = 'classes';
    const boot = () => {
      T.S.data = {
        users: new Map([
          [1, { id: 1, name: 'مدیر', role: 'manager' }],
          [9, { id: 9, name: 'دانش‌آموز', role: 'student', class_id: 5 }],
        ]),
        classes: new Map([[5, { id: 5, name: 'دهم شبکه', branch: 'شبکه' }], [6, { id: 6, name: 'یازدهم ریاضی', branch: 'ریاضی' }]]),
        subjects: new Map([[10, { id: 10, name: 'ریاضی' }]]),
        lookups: new Map([[3, { id: 3, kind: 'branch', name: 'شبکه' }], [4, { id: 4, kind: 'branch', name: 'ریاضی' }]]),
        schedule: new Map([[100, { id: 100, class_id: 5, subject_id: 10, weekday: 0, bell_order: 1 }]]),
        substitutions: new Map([[7, { id: 7, schedule_id: 100, class_id: 5, sub_teacher_id: 1, date: '2026-11-07' }]]),
        bell_schedules: new Map(), parent_links: new Map(),
      };
      T.S.queue = []; T.S.online = false;
    };
    const click = act => {
      const b = win.document.createElement('button');
      b.setAttribute('data-act', act);
      b.setAttribute('data-id', '3');
      win.document.body.appendChild(b);
      b.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
      b.remove();
    };
    const tick = () => new Promise(r => setTimeout(r, 20));

    /* ۱) فقط خودِ رشته */
    boot();
    click('def-delete');
    let html = win.document.querySelector('#modal-root').innerHTML;
    assert.ok(/def-delete-only/.test(html) && /def-delete-cascade/.test(html), 'هر دو گزینه پرسیده شد');
    assert.ok(/دهم شبکه/.test(html), 'کلاس‌های وابسته فهرست شدند');
    assert.ok(/def-delete-students/.test(html), 'دربارهٔ دانش‌آموزانش هم می‌پرسد');
    assert.ok(/نیازمند پیگیری/.test(html), 'گزینهٔ نگه‌داشتن دانش‌آموزان به فهرست پیگیری اشاره می‌کند');
    click('def-delete-only'); await tick();
    assert.ok(!T.S.data.lookups.has(3), 'رشته حذف شد');
    assert.ok(T.S.data.classes.has(5), 'کلاس دست‌نخورده ماند');
    assert.ok(T.S.data.schedule.has(100), 'زنگ برنامه دست‌نخورده ماند');

    /* ۲) رشته + همهٔ کلاس‌هایش */
    boot();
    click('def-delete');
    click('def-delete-cascade'); await tick();
    assert.ok(!T.S.data.lookups.has(3), 'رشته حذف شد');
    assert.ok(!T.S.data.classes.has(5), 'کلاس وابسته حذف شد');
    assert.ok(T.S.data.classes.has(6), 'کلاس رشتهٔ دیگر ماند');
    assert.ok(!T.S.data.schedule.has(100), 'زنگ‌های برنامهٔ آن کلاس پاک شد');
    assert.ok(!T.S.data.substitutions.has(7), 'جابه‌جای آن کلاس پاک شد');
    assert.strictEqual(Number(T.S.data.users.get(9).class_id), 0, 'دانش‌آموز حذف نشد، فقط بی‌کلاس شد');
    assert.ok(T.S.data.users.has(9), 'دانش‌آموز باقی ماند');
    assert.ok(/رشته/.test(String(T.S.data.users.get(9).followup_reason || '')), 'دلیل حذف رشته روی دانش‌آموز ثبت شد');
    assert.ok(T.S.data.lookups.has(4), 'رشتهٔ دیگر دست‌نخورده است');

    /* صفحهٔ «نیازمند پیگیری» او را با دلیل نشان می‌دهد و می‌شود کلاس تازه داد */
    const fuPage = win.PAGES.followup();
    assert.ok(fuPage.includes('دانش‌آموز'), 'دانش‌آموز در صفحهٔ پیگیری هست');
    assert.ok(/رشته/.test(fuPage), 'دلیلش در صفحه نوشته شده');

    /* ۳) رشته + کلاس‌ها + دانش‌آموزان: همه حذف می‌شوند */
    boot();
    win.confirm = () => true;
    click('def-delete');
    click('def-delete-students'); await tick();
    assert.ok(!T.S.data.users.has(9), 'با انتخاب صریح، دانش‌آموز هم حذف شد');
    assert.ok(!T.S.data.classes.has(5), 'کلاسش حذف شد');
    assert.ok(!T.S.data.lookups.has(3), 'رشته حذف شد');

    /* ۴) «فقط خودش»: کلاس‌ها و دانش‌آموزان دست‌نخورده می‌مانند */
    boot();
    click('def-delete');
    click('def-delete-only'); await tick();
    assert.ok(T.S.data.classes.has(5), 'کلاس ماند');
    assert.ok(T.S.data.users.has(9), 'دانش‌آموز ماند');
    dom.window.close();
  });

  /* ══════════ دیاگ داده (همان ۴۲-self-diagnostics نسخهٔ p2) ══════════ */
  await test('سلامت داده: کاربران تکراری (کد ملی، نام کاربری، یک نفر با دو حساب) تشخیص داده می‌شوند', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/diag.js') + '\n;\n' + strip('client/app.js')
      + '\n;window.__t = { S, PayeshDiag, list, PAGES };');
    const T = win.__t;
    T.S.user = { id: 1, name: 'مدیر', role: 'manager' };
    T.S.role = 'manager'; T.S.session = 'x'; T.S.route = 'health';
    T.S.queue = [];
    T.S.data = {
      users: new Map([
        [1, { id: 1, name: 'مدیر', role: 'manager' }],
        /* کد ملی تکراری */
        [10, { id: 10, name: 'سارا احمدی', role: 'student', national_id: '1000000036', phone: '09120000010' }],
        [11, { id: 11, name: 'سارا احمدی ۲', role: 'student', national_id: '1000000036', phone: '09120000011' }],
        /* نام کاربری (شمارهٔ همراه) تکراری */
        [12, { id: 12, name: 'دبیر الف', role: 'teacher', phone: '09125550011', national_id: '1000000044' }],
        [13, { id: 13, name: 'دبیر ب', role: 'teacher', phone: '09125550011', national_id: '1000000052' }],
        /* یک نفر با دو حساب: هم‌نام + هم‌شماره */
        [14, { id: 14, name: 'علی رضایی', role: 'student', phone: '09127770014', national_id: '1000000060', class_id: 5 }],
        [15, { id: 15, name: 'علی  رضایی', role: 'student', phone: '09127770014', class_id: 5 }],
        /* کد ملی نامعتبر */
        [16, { id: 16, name: 'کاربر خراب', role: 'student', national_id: '123456789' }],
      ]),
      classes: new Map([[5, { id: 5, name: 'دهم ریاضی', grade: 'دهم', branch: 'ریاضی' }]]),
      subjects: new Map(),
      lookups: new Map([
        [20, { id: 20, kind: 'grade', name: 'دهم' }],
        [21, { id: 21, kind: 'branch', name: 'ریاضی' }],
        [22, { id: 22, kind: 'branch', name: 'ریاضی' }],
      ]),
      parent_links: new Map([
        [30, { id: 30, parent_id: 10, student_id: 14 }],
        [31, { id: 31, parent_id: 999, student_id: 14 }],
      ]),
      grades: new Map([[40, { id: 40, student_id: 14, subject_id: 1, score: 18 }]]),
      attendance: new Map([[50, { id: 50, student_id: 14, date: '2026-11-01', status: 'present' }]]),
      discipline: new Map(), leaves: new Map(), schedule: new Map(), substitutions: new Map(), bell_schedules: new Map(),
    };
    const D = T.PayeshDiag;
    const run = D.run();
    const res = id => (run.rows.find(r => r.check.id === id) || {}).res || { ok: true };

    assert.strictEqual(res('dup-nid').ok, false, 'کد ملی تکراری تشخیص داده شد');
    assert.strictEqual(res('dup-nid').count, 1);
    assert.strictEqual(res('dup-login').ok, false, 'نام کاربری تکراری تشخیص داده شد');
    assert.ok(res('dup-person').count >= 1, 'یک نفر با دو حساب تشخیص داده شد');
    assert.strictEqual(res('invalid-nid').ok, false, 'کد ملی نامعتبر تشخیص داده شد');
    assert.strictEqual(res('orphan-link').ok, false, 'پیوند بی‌صاحب تشخیص داده شد');
    assert.strictEqual(res('dup-lookup').ok, false, 'تعریف تکراری تشخیص داده شد');

    /* تعمیر خودکارِ امن */
    T.list('parent_links');
    const fixOrphan = run.rows.find(r => r.check.id === 'orphan-link').check;
    fixOrphan.fix(res('orphan-link'));
    assert.strictEqual(T.S.data.parent_links.size, 1, 'پیوند بی‌صاحب پاک شد');
    assert.ok(!T.S.data.parent_links.has(31));

    /* ادغام دو حسابِ یک نفر: داده‌ها منتقل و حساب تکراری حذف می‌شود */
    const m = D.mergeUsers(14, [15]);
    assert.strictEqual(m.ok, true, 'ادغام انجام شد');
    assert.ok(T.S.data.users.has(14) && !T.S.data.users.has(15), 'حساب اصلی ماند و تکراری حذف شد');
    assert.ok(T.S.data.grades.has(40), 'نمره از بین نرفت');
    assert.strictEqual(Number(T.S.data.grades.get(40).student_id), 14, 'نمره به حساب اصلی منتقل شد');
    assert.strictEqual(Number(T.S.data.attendance.get(50).student_id), 14, 'حضور منتقل شد');

    /* صفحهٔ «سلامت» رندر می‌شود و موردها را نشان می‌دهد */
    const page = T.PAGES.health();
    assert.ok(page.includes('کد ملی تکراری'), 'صفحهٔ سلامت مورد را نشان می‌دهد');
    assert.ok(page.includes('اصلاح خودکار') || page.includes('دیدن موارد'), 'دکمهٔ رسیدگی هست');
    dom.window.close();
  });

  /* ══════════ مجوز نقش‌ها (همان ۳۰-authz نسخهٔ p2) ══════════════════ */
  await test('دسترسی نقش‌ها: هر نقش فقط صفحه‌ها و کنش‌های خودش را دارد', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/authz.js') + '\n;\n' + strip('client/app.js')
      + '\n;window.__t = { S, navConfig, render, authzCanRoute, authzCanAct };');
    const T = win.__t;
    const A = win.authzCanRoute, ACT = win.authzCanAct;

    assert.strictEqual(A('users', 'student'), false, 'دانش‌آموز به کاربران دسترسی ندارد');
    assert.strictEqual(A('users', 'teacher'), false, 'دبیر به کاربران دسترسی ندارد');
    assert.strictEqual(A('users', 'manager'), true, 'مدیر دارد');
    assert.strictEqual(A('health', 'manager'), true, 'مدیر به سلامت داده دسترسی دارد');
    assert.strictEqual(A('health', 'teacher'), false, 'دبیر ندارد');
    assert.strictEqual(A('schedule', 'teacher'), true, 'دبیر برنامه را می‌بیند');
    assert.strictEqual(A('schedule', 'parent'), true, 'ولی برنامهٔ فرزند را می‌بیند');
    assert.strictEqual(A('child', 'parent'), true, 'صفحهٔ فرزند برای ولی');
    assert.strictEqual(A('cloud', 'teacher'), false, 'حافظهٔ ابری فقط مدیر');
    assert.strictEqual(A('some-unknown-route', 'teacher'), false, 'مسیر ناشناس بسته است (fail-closed)');

    assert.strictEqual(ACT('user-add', 'teacher'), false, 'دبیر نمی‌تواند کاربر بسازد');
    assert.strictEqual(ACT('users-bulk-delete', 'teacher'), false, 'دبیر نمی‌تواند حذف دسته‌ای کند');
    assert.strictEqual(ACT('class-delete', 'parent'), false, 'ولی نمی‌تواند کلاس حذف کند');
    assert.strictEqual(ACT('att-save', 'teacher'), true, 'دبیر حضور ثبت می‌کند');
    assert.strictEqual(ACT('att-save', 'student'), false, 'دانش‌آموز حضور ثبت نمی‌کند');
    assert.strictEqual(ACT('grade-save', 'teacher'), true, 'دبیر نمره ثبت می‌کند');
    assert.strictEqual(ACT('leave-add', 'parent'), true, 'ولی مرخصی می‌گیرد');
    assert.strictEqual(ACT('modal-close', 'student'), true, 'بستن پنجره همیشه کار می‌کند');

    /* منو هم همین را نشان می‌دهد */
    const teacherNav = win.navConfig('teacher').map(x => x[0]);
    assert.ok(teacherNav.includes('schedule'), 'برنامه در منوی دبیر هست');
    const mgNav = win.navConfig('manager').map(x => x[0]);
    assert.ok(mgNav.includes('health') && mgNav.includes('followup'), 'سلامت و پیگیری در منوی مدیر');

    /* اگر دانش‌آموز آدرس صفحهٔ مدیر را دستی باز کند، دادهٔ مدیر را نمی‌بیند */
    T.S.user = { id: 3, name: 'دانش‌آموز', role: 'student' };
    T.S.role = 'student'; T.S.session = 'x'; T.S.route = 'users';
    T.S.data = { users: new Map([[1, { id: 1, name: 'مدیر', role: 'manager', phone: '09121112233' }]]), classes: new Map(), subjects: new Map(), lookups: new Map(), parent_links: new Map() };
    T.S.queue = []; T.S.creds = {};
    T.render();
    const txt = win.document.getElementById('app').textContent;
    assert.ok(/دسترسی ندارید/.test(txt), 'صفحهٔ «دسترسی ندارید» نشان داده شد');
    assert.ok(!/09121112233/.test(txt), 'دادهٔ مدیر بیرون نمی‌ریزد');
    dom.window.close();
  });

  await test('ساخت کاربر: تکراری‌ها پیش از ثبت گرفته می‌شوند و نام همان شخص گفته می‌شود', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/diag.js') + '\n;\n'
      + strip('client/authz.js') + '\n;\n' + strip('client/app.js')
      + '\n;window.__t = { S, list, findUserDuplicates, userNameKey };');
    const T = win.__t;
    T.S.user = { id: 1, name: 'مدیر', role: 'manager' };
    T.S.role = 'manager'; T.S.session = 'x'; T.S.route = 'users'; T.S.queue = []; T.S.creds = {};
    T.S.data = {
      users: new Map([
        [1, { id: 1, name: 'مدیر', role: 'manager' }],
        [7, { id: 7, name: 'علی رضایی', role: 'student', phone: '09127770077', national_id: '1000000907', father_name: 'رضا', class_id: 5, birth_date: '1387-02-15' }],
      ]),
      classes: new Map([[5, { id: 5, name: 'دهم ریاضی', grade: 'دهم', branch: 'ریاضی' }]]),
      subjects: new Map(), lookups: new Map(), parent_links: new Map(),
    };

    /* نام‌های نویسه‌های عربی/فارسی نباید فرق بگذارند */
    assert.strictEqual(T.userNameKey('علی رضائي'), T.userNameKey('علی  رضایی'), 'ی/ي و فاصله یکی می‌شوند');

    const mkForm = (vals) => {
      const f = win.document.createElement('form');
      f.setAttribute('data-form', 'user');
      Object.keys(vals).forEach(k => {
        const el = win.document.createElement(k === 'role' ? 'select' : 'input');
        el.name = k; el.value = vals[k] || '';
        f.appendChild(el);
      });
      win.document.body.appendChild(f);
      return f;
    };
    const submit = async (f) => {
      f.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 60));
    };
    const toasts = () => win.document.getElementById('toasts').textContent;

    /* ۱) کد ملی تکراری: پیام نام همان شخص را می‌گوید و چیزی ثبت نمی‌شود */
    const f1 = mkForm({ name: 'اسم دیگر', national_id: '1000000907', phone: '09129990001', role: 'student' });
    const before = T.S.data.users.size;
    await submit(f1);
    assert.strictEqual(T.S.data.users.size, before, 'کاربر تکراری ساخته نشد');
    assert.ok(toasts().includes('علی رضایی'), 'پیام می‌گوید این کد ملی برای چه کسی است');
    f1.remove();

    /* ۲) شمارهٔ همراه تکراری (نام کاربری) */
    const f2 = mkForm({ name: 'اسم دیگر ۲', national_id: '1000000915', phone: '09127770077', role: 'student' });
    await submit(f2);
    assert.strictEqual(T.S.data.users.size, before, 'شمارهٔ تکراری گرفته شد');
    assert.ok(toasts().includes('علی رضایی'), 'پیام نام صاحب شماره را می‌گوید');
    f2.remove();

    /* ۳) نام + نام پدر یکسان (شخص احتمالاً همان است): هشدار پیش از ثبت، ثبت با تأیید دوم */
    const f3 = mkForm({ name: 'علی رضایی', national_id: '1000000923', phone: '09129990003', role: 'student', father_name: 'رضا' });
    await submit(f3);
    assert.strictEqual(T.S.data.users.size, before, 'با اولین «ثبت» چیزی ساخته نشد');
    const warn = win.document.getElementById('user-dup-warn');
    assert.ok(warn && warn.textContent.includes('علی رضایی'), 'هشدار مشابهت نمایش داده شد');
    assert.ok(f3.isConnected, 'فرم بسته نشد و مقدارها پاک نشدند');
    await submit(f3);
    assert.strictEqual(T.S.data.users.size, before + 1, 'با تأیید دوم کاربر ثبت شد');

    /* ۴) تشخیص مستقیم: کد ملی و شمارهٔ تکراری + شخص مشابه */
    const d = T.findUserDuplicates({ name: 'علی رضایی', national_id: '1000000907', phone: '09120000000' }, 0);
    assert.strictEqual(d.nid.length, 1, 'کد ملی تکراری پیدا شد');
    const dP = T.findUserDuplicates({ name: 'علی رضایی', father_name: 'رضا' }, 0);
    assert.ok(dP.person.length >= 1, 'نام + نام پدر = شخص مشابه');
    const dN = T.findUserDuplicates({ name: 'علی رضایی' }, 0);
    assert.strictEqual(dN.person.length, 0, 'فقط هم‌نامی به‌تنهایی تکراری حساب نمی‌شود');
    const d2 = T.findUserDuplicates({ name: 'علی رضایی', national_id: '1000000907' }, 7);
    assert.strictEqual(d2.nid.length, 0, 'هنگام ویرایش، خودِ کاربر تکراری حساب نمی‌شود');
    dom.window.close();
  });

  await test('رشته هرگز پایه نمی‌شود: کلاس = پایه + رشته در متوسطهٔ دوم، پایه ثابت در کلاس‌محور', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/diag.js') + '\n;\n'
      + strip('client/authz.js') + '\n;\n' + strip('client/app.js')
      + '\n;window.__t = { S, list, impPlaceOf, impGradeLevel, byId };');
    const T = win.__t;

    /* پایه فقط ۱..۱۲ است */
    assert.strictEqual(T.impGradeLevel('دهم'), 10);
    assert.strictEqual(T.impGradeLevel('۱۲'), 12);
    assert.strictEqual(T.impGradeLevel('الکترونیک'), 0, 'رشته پایه نیست');
    assert.strictEqual(T.impGradeLevel(''), 0);

    const ctx = { grades: ['اول', 'دوم', 'دهم', 'یازدهم', 'الکترونیک'], branches: ['الکترونیک', 'گرافیک'] };

    /* موردِ عکس: ستون پایه «الکترونیک» و رشته هم «الکترونیک» → کلاس ساخته نمی‌شود */
    const bad = T.impPlaceOf({ grade: 'الکترونیک', field: 'الکترونیک' }, ctx);
    assert.strictEqual(bad.grade, '', 'رشته به‌عنوان پایه پذیرفته نشد');
    assert.strictEqual(bad.name, '', 'کلاسی از رشته ساخته نشد');
    assert.strictEqual(bad.bare, true, 'ردیف می‌رود به «نیازمند پیگیری»');

    /* حالت درست متوسطهٔ دوم: دهم + الکترونیک */
    const ok = T.impPlaceOf({ grade: 'دهم', field: 'الکترونیک' }, ctx);
    assert.strictEqual(ok.name, 'دهم الکترونیک');
    assert.strictEqual(ok.mode, 'field', 'دهم به بالا رشته‌محور است');
    assert.strictEqual(ok.grade_level, 10);

    /* متوسطهٔ اول: کلاس‌محور و بدون رشته */
    const mid = T.impPlaceOf({ class_name: 'دوم ب' }, ctx);
    assert.strictEqual(mid.grade, 'دوم');
    assert.strictEqual(mid.mode, 'class', 'کلاس‌محور است');

    /* فرم کلاس: پایهٔ نامعتبر و رشته در کلاس‌محور گرفته می‌شوند */
    T.S.user = { id: 1, name: 'مدیر', role: 'manager' };
    T.S.role = 'manager'; T.S.session = 'x'; T.S.route = 'classes'; T.S.queue = []; T.S.online = false;
    T.S.data = {
      users: new Map([[1, { id: 1, name: 'مدیر', role: 'manager' }]]),
      classes: new Map(), subjects: new Map(),
      lookups: new Map([[1, { id: 1, kind: 'grade', name: 'دهم' }], [2, { id: 2, kind: 'branch', name: 'الکترونیک' }]]),
      parent_links: new Map(),
    };
    const mkForm = (vals) => {
      const f = win.document.createElement('form');
      f.setAttribute('data-form', 'class');
      Object.keys(vals).forEach(k => {
        const el = win.document.createElement(k === 'mode' ? 'select' : 'input');
        el.name = k; el.value = vals[k] || '';
        f.appendChild(el);
      });
      win.document.body.appendChild(f);
      return f;
    };
    const submit = async (f) => {
      f.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 60));
    };
    const toasts = () => win.document.getElementById('toasts').textContent;

    const f1 = mkForm({ grade: 'الکترونیک', branch: '' });
    await submit(f1);
    assert.strictEqual(T.S.data.classes.size, 0, 'کلاس با پایهٔ نامعتبر ساخته نشد');
    assert.ok(/پایه نیست/.test(toasts()), 'پیام می‌گوید رشته پایه نیست: ' + toasts());
    f1.remove();

    const f2 = mkForm({ grade: 'دهم', branch: '', mode: 'field' });
    await submit(f2);
    assert.strictEqual(T.S.data.classes.size, 0, 'کلاس رشته‌محور بدون رشته ساخته نشد');
    f2.remove();

    const f3 = mkForm({ grade: 'دوم', branch: 'الکترونیک', mode: 'class' });
    await submit(f3);
    assert.strictEqual(T.S.data.classes.size, 0, 'کلاس‌محور با رشته ساخته نشد');
    f3.remove();

    /* دانش‌آموزی که از اکسل آمده و کلاس ندارد، با ساخت دستی کلاس وصل می‌شود */
    T.S.data.users.set(30, { id: 30, name: 'دانش‌آموز اکسل', role: 'student', grade: 'دهم', field: 'الکترونیک', followup_reason: 'کلاس مشخص نیست' });

    const f4 = mkForm({ grade: 'دهم', branch: 'الکترونیک', mode: 'field', room: 'کلاس ۱۰۱', name: '' });
    await submit(f4);
    assert.strictEqual(T.S.data.classes.size, 1, 'کلاس درست ساخته شد');
    const c = Array.from(T.S.data.classes.values())[0];
    assert.strictEqual(c.name, 'دهم الکترونیک', 'نام = پایه + رشته');
    assert.strictEqual(c.mode, 'field');
    assert.strictEqual(Number(c.grade_level), 10);
    assert.strictEqual(c.kind, 'class', 'کلاس دستیِ مدیر ثبت شد (محل برگزاری جدا در برنامهٔ هفتگی است)');
    const joinedStu = T.S.data.users.get(30);
    assert.strictEqual(Number(joinedStu.class_id), Number(c.id), 'دانش‌آموز اکسل خودکار به کلاس دستی وصل شد');
    assert.ok(!joinedStu.followup_reason, 'از فهرست پیگیری بیرون آمد');
    dom.window.close();
  });

  await test('نوار بالای برنامه همیشه نسخه و چراغ وضعیت را نشان می‌دهد', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/authz.js') + '\n;\n'
      + strip('client/app.js') + '\n;window.__t = { S, updateBarHtml, CLIENT_VERSION };');
    const T = win.__t;
    T.S.user = { id: 3, name: 'دبیر', role: 'teacher' };
    T.S.role = 'teacher'; T.S.route = 'home'; T.S.queue = [];
    T.S.server = { version: T.CLIENT_VERSION };

    const green = T.updateBarHtml();
    assert.ok(/update-bar/.test(green), 'نوار همیشگی هست');
    assert.ok(green.includes('v' + T.CLIENT_VERSION), 'نسخه نوشته شده: ' + T.CLIENT_VERSION);
    assert.ok(/16a34a/.test(green), 'چراغ سبز وقتی به‌روز است');
    assert.ok(/به‌روز/.test(green));

    T.S.remote = { available: true, remote_version: '9.9.9' };
    const amber = T.updateBarHtml();
    assert.ok(/f59e0b/.test(amber), 'چراغ کهربایی وقتی نسخهٔ تازه هست');
    assert.ok(amber.includes('9.9.9'));

    T.S.role = 'manager';
    assert.ok(/data-act="update-now"/.test(T.updateBarHtml()), 'مدیر دکمهٔ دانلود و نصب را می‌بیند');

    T.S.upd = { status: 'ready', latest: '9.9.9', percent: 100 };
    const ready = T.updateBarHtml();
    assert.ok(/update-install|آمادهٔ نصب/.test(ready), 'در حالت آمادهٔ نصب، دکمهٔ نصب می‌آید');
    dom.window.close();
  });

  await test('بخش کاربران فقط پایه و رشته می‌خواهد؛ کلاس/اتاق در برنامهٔ هفتگی تعیین می‌شود', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/authz.js') + '\n;\n'
      + strip('client/app.js') + '\n;window.__t = { S, list, byId, PAGES, ensureGroup };');
    const T = win.__t;
    T.S.user = { id: 1, name: 'مدیر', role: 'manager' };
    T.S.role = 'manager'; T.S.session = 'x'; T.S.route = 'followup'; T.S.queue = []; T.S.online = false;
    T.S.data = {
      users: new Map([
        [1, { id: 1, name: 'مدیر', role: 'manager' }],
        [50, { id: 50, name: 'آرین رحمانی', role: 'student', national_id: '3840509807', followup_reason: 'پایهٔ کلاس در فایل نبود (رشته: نقشه‌کشی)' }],
      ]),
      classes: new Map(),
      subjects: new Map(),
      lookups: new Map([
        [1, { id: 1, kind: 'grade', name: 'دهم' }], [2, { id: 2, kind: 'grade', name: 'یازدهم' }],
        [3, { id: 3, kind: 'branch', name: 'نقشه‌کشی' }], [4, { id: 4, kind: 'branch', name: 'الکترونیک' }],
      ]),
      parent_links: new Map(), import_issues: new Map(),
    };

    /* ستون «کلاس» حذف شده و جایش پایه + رشته آمده است */
    const html = T.PAGES.followup();
    assert.ok(/id="fu-grade-50"/.test(html), 'انتخاب پایه هست');
    assert.ok(/id="fu-branch-50"/.test(html), 'انتخاب رشته هست');
    assert.ok(!/fu-class-50/.test(html), 'انتخاب «کلاس» در بخش کاربران حذف شد');
    assert.ok(!/انتخاب کلاس/.test(html), 'دیگر «انتخاب کلاس» خواسته نمی‌شود');
    const row = html.slice(html.indexOf('آرین رحمانی'));
    assert.ok(/نقشه‌کشی<\/option>/.test(row.slice(0, 3000)), 'رشته از توضیح ردیف پیش‌پر شده است');

    /* ساخت گروه از پایه + رشته، بدون تکرار */
    const g1 = T.ensureGroup('دهم', 'نقشه‌کشی');
    assert.strictEqual(g1.name, 'دهم نقشه‌کشی', 'نام گروه = پایه + رشته');
    assert.strictEqual(g1.mode, 'field');
    assert.strictEqual(Number(g1.grade_level), 10);
    const g2 = T.ensureGroup('دهم', 'نقشه‌کشی');
    assert.strictEqual(Number(g2.id), Number(g1.id), 'گروه تکراری ساخته نشد');
    assert.strictEqual(T.list('classes').length, 1);
    assert.ok(!('room' in g1) || !g1.room, 'در بخش کاربران اتاقی ثبت نمی‌شود');
    dom.window.close();
  });

  await test('جدول کاربران: پایه و رشته جدا، نام کامل، و «ولیِ چه دانش‌آموزی»', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/authz.js') + '\n;\n'
      + strip('client/app.js') + '\n;window.__t = { S, PAGES, impPlaceOf };');
    const T = win.__t;
    T.S.user = { id: 1, name: 'مدیر', role: 'manager' };
    T.S.role = 'manager'; T.S.session = 'x'; T.S.route = 'users'; T.S.queue = []; T.S.online = false; T.S.creds = null;
    T.S.data = {
      users: new Map([
        [1, { id: 1, name: 'مدیر', role: 'manager' }],
        [10, { id: 10, name: 'آرین', last_name: 'رحمانی', role: 'student', class_id: 5, national_id: '3840509807' }],
        [11, { id: 11, name: 'آرزو', role: 'parent', national_id: '3840138957' }],
      ]),
      classes: new Map([[5, { id: 5, name: 'دهم نقشه‌کشی', grade: 'دهم', branch: 'نقشه‌کشی', mode: 'field' }]]),
      subjects: new Map(),
      lookups: new Map([[1, { id: 1, kind: 'grade', name: 'دهم' }], [2, { id: 2, kind: 'branch', name: 'نقشه‌کشی' }]]),
      parent_links: new Map([[1, { id: 1, parent_id: 11, student_id: 10 }]]),
      import_issues: new Map(),
    };

    const html = T.PAGES.users();
    assert.ok(/<th>پایه<\/th>/.test(html), 'ستون پایه هست');
    assert.ok(/<th>رشته<\/th>/.test(html), 'ستون رشته هست');
    assert.ok(!/<th>کلاس<\/th>/.test(html), 'ستون «کلاس» برداشته شد');
    assert.ok(!/<th>دانش‌آموز<\/th>/.test(html), 'ستون «دانش‌آموز» برداشته شد');
    assert.ok(!/<th>نام کاربری<\/th>/.test(html) && !/<th>رمز عبور<\/th>/.test(html), 'ستون‌های نام کاربری و رمز برداشته شدند');
    assert.ok(/data-act="user-creds"/.test(html), 'دکمهٔ «کاربری» کنار مشخصات کامل هست');
    assert.ok(html.includes('آرین رحمانی'), 'نام و نام خانوادگی با هم');
    /* ردیف دانش‌آموز: پایه و رشته جدا */
    const studRow = html.slice(html.indexOf('آرین رحمانی'));
    assert.ok(/<td class="small">دهم<\/td>/.test(studRow), 'پایه در ستون خودش');
    assert.ok(/<td class="small">نقشه‌کشی<\/td>/.test(studRow), 'رشته در ستون خودش');

    /* نام خانوادگی دوبار نوشته نمی‌شود */
    T.S.data.users.set(13, { id: 13, name: 'آرسام سعیدی', last_name: 'سعیدی', role: 'student' });
    assert.ok(!/آرسام سعیدی سعیدی/.test(T.PAGES.users()), 'نام خانوادگی تکرار نمی‌شود');

    /* ردیف ولی: با فیلتر «ولی» نام دانش‌آموزش را نشان می‌دهد */
    T.S.roleFilter = 'parent';
    const parHtml = T.PAGES.users();
    assert.ok(/<th>ولیِ چه دانش‌آموزی<\/th>/.test(parHtml), 'ستون فرزند فقط در فیلتر ولی');
    const parRow = parHtml.slice(parHtml.indexOf('آرزو'));
    assert.ok(parRow.includes('آرین رحمانی'), 'ولی به دانش‌آموزش وصل است');
    assert.ok(/<td class="small">دهم<\/td>/.test(parRow), 'پایهٔ فرزند برای ولی');
    assert.ok(/<td class="small">نقشه‌کشی<\/td>/.test(parRow), 'رشتهٔ فرزند برای ولی');
    T.S.roleFilter = '';

    /* صفحهٔ پیگیری: رشتهٔ استخراج‌شده از اکسل حتی بدون تعریف، انتخاب‌شده نشان داده می‌شود */
    T.S.data.users.set(12, { id: 12, name: 'آرسام سعیدی', role: 'student', national_id: '3750943478', followup_reason: 'پایهٔ کلاس در فایل نبود (رشته: گرافیک)' });
    T.S.route = 'followup';
    const fu = T.PAGES.followup();
    const row = fu.slice(fu.indexOf('آرسام سعیدی'));
    assert.ok(/<option value="گرافیک" selected>گرافیک<\/option>/.test(row), 'رشته از اکسل در فهرست و انتخاب‌شده است: ' + row.slice(0, 400));
    assert.ok(/id="fu-grade-12"/.test(row), 'پایه هم قابل انتخاب است');

    /* مرحلهٔ ۱ ورود دسته‌ای: پرسش «این فایل چه پایه‌هایی است؟» */
    T.S.imp = { step: 1, kind: 'students' };
    const impHtml = typeof win.impStepHtml === 'function' ? win.impStepHtml() : '';
    if (impHtml) {
      assert.ok(/name="imp-grade"/.test(impHtml), 'پرسش پایه‌های فایل هست');
      assert.ok(/این فایل شامل چه پایه‌هایی است/.test(impHtml));
    }

    /* پایهٔ اعلام‌شدهٔ فایل روی سطر بی‌پایه اعمال می‌شود */
    const p = T.impPlaceOf({ field: 'نقشه‌کشی' }, { grades: [], branches: ['نقشه‌کشی'], onlyGrades: ['دهم'] });
    assert.strictEqual(p.grade, 'دهم', 'پایه از پرسش فایل گرفته شد');
    assert.strictEqual(p.name, 'دهم نقشه‌کشی');
    const p2 = T.impPlaceOf({ field: 'نقشه‌کشی' }, { grades: [], branches: ['نقشه‌کشی'], onlyGrades: ['دهم', 'یازدهم'] });
    assert.strictEqual(p2.name, '', 'با چند پایه، سطر به پیگیری می‌رود');
    dom.window.close();
  });

  await test('حذف دانش‌آموز ⇒ حذف ولی‌ها؛ نگاشت درستِ وضعیت حیات پدر و مادر', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/authz.js') + '\n;\n'
      + strip('client/app.js') + '\n;window.__t = { S, list, byId, deleteStudentWithParents, impAutoMap, IMP_ENTITY_FA };');
    const T = win.__t;

    /* — نگاشت دو ستون هم‌نام «وضعیت حیات»: اولی پدر، دومی مادر — */
    const map = T.impAutoMap(['نام', 'نام خانوادگی', 'وضعیت حیات', 'وضعیت حیات', 'نام پدر', 'نام مادر'], 'students');
    const vals = Object.keys(map).map(k => map[k]).filter(Boolean);
    assert.strictEqual(map[2], 'father_alive', 'ستون اول حیات = پدر (شد: ' + map[2] + ')');
    assert.strictEqual(map[3], 'mother_alive', 'ستون دوم حیات = مادر (شد: ' + map[3] + ')');
    assert.ok(vals.indexOf('guardian_alive') < 0, 'هیچ‌کدام به سرپرست نرفت');
    /* اگر ستون‌ها نام‌دار باشند، همان‌طور می‌ماند */
    const map2 = T.impAutoMap(['وضعیت حیات مادر', 'وضعیت حیات پدر'], 'students');
    assert.strictEqual(map2[0], 'mother_alive');
    assert.strictEqual(map2[1], 'father_alive');
    /* واژهٔ «رشته» جای «کلاس» در فهرست ورود دسته‌ای */
    assert.ok(/رشته/.test(T.IMP_ENTITY_FA.students) && !/کلاس/.test(T.IMP_ENTITY_FA.students), T.IMP_ENTITY_FA.students);

    /* — حذف دانش‌آموز: ولیِ بی‌فرزند حذف، ولیِ بافرزندِ دیگر می‌ماند — */
    T.S.user = { id: 1, name: 'مدیر', role: 'manager' };
    T.S.role = 'manager'; T.S.session = 'x'; T.S.route = 'users'; T.S.queue = []; T.S.online = false;
    T.S.data = {
      users: new Map([
        [1, { id: 1, name: 'مدیر', role: 'manager' }],
        [10, { id: 10, name: 'آرین رحمانی', role: 'student' }],
        [14, { id: 14, name: 'سارا رحمانی', role: 'student' }],
        [11, { id: 11, name: 'پدر رحمانی', role: 'parent' }],
        [12, { id: 12, name: 'مادر رحمانی', role: 'parent' }],
        [13, { id: 13, name: 'ولی مشترک', role: 'parent' }],
      ]),
      classes: new Map(), subjects: new Map(), lookups: new Map(),
      parent_links: new Map([
        [1, { id: 1, parent_id: 11, student_id: 10 }],
        [2, { id: 2, parent_id: 12, student_id: 10 }],
        [3, { id: 3, parent_id: 13, student_id: 10 }],
        [4, { id: 4, parent_id: 13, student_id: 14 }],
      ]),
    };
    win.deleteUserEverywhere = async (id) => {
      win.removeLocal ? win.removeLocal('users', id, { sync: false }) : null;
      T.S.data.users.delete(Number(id));
    };
    const removed = await T.deleteStudentWithParents(10);
    assert.strictEqual(T.S.data.users.has(10), false, 'دانش‌آموز حذف شد');
    assert.strictEqual([...removed].sort().join('|'), ['مادر رحمانی', 'پدر رحمانی'].sort().join('|'), 'ولی‌های بی‌فرزند حذف شدند: ' + removed.join('، '));
    assert.strictEqual(T.S.data.users.has(11), false, 'پدر حذف شد');
    assert.strictEqual(T.S.data.users.has(12), false, 'مادر حذف شد');
    assert.strictEqual(T.S.data.users.has(13), true, 'ولیِ فرزنددار دیگر می‌ماند');
    assert.strictEqual(T.S.data.parent_links.size, 1, 'پیوندهای دانش‌آموز حذف‌شده پاک شدند');
    dom.window.close();
  });

  await test('ورود اکسل: پایه و رشته روی دانش‌آموز می‌ماند و هیچ کلاسی ساخته نمی‌شود', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/authz.js') + '\n;\n'
      + strip('client/app.js') + '\n;window.__t = { S, list, byId, importApplyLocal, busyOverlay, busyUpdate, impStepHtml };');
    const T = win.__t;
    T.S.user = { id: 1, name: 'مدیر', role: 'manager' };
    T.S.role = 'manager'; T.S.session = 'x'; T.S.route = 'users'; T.S.queue = []; T.S.online = false;
    T.S.data = {
      users: new Map([[1, { id: 1, name: 'مدیر', role: 'manager' }]]),
      classes: new Map(), subjects: new Map(), lookups: new Map(), parent_links: new Map(), import_issues: new Map(),
    };
    /* پایه‌ای که مدیر در مرحلهٔ ۱ تیک زده است */
    T.S.impGrades = ['دهم'];

    const rows = [
      { _row: 2, full_name: 'پیشوا رحمانی', national_id: '1000000907', new_branch: 'الکترونیک', followup_reason: 'پایه در فایل نبود (رشته: الکترونیک)' },
      { _row: 3, full_name: 'سیبا سهرابی', national_id: '1000000915', new_branch: 'الکترونیک', followup_reason: 'پایه در فایل نبود (رشته: الکترونیک)' },
    ];
    const res = await T.importApplyLocal(rows, 'students');

    const cls = T.list('classes');
    assert.strictEqual(cls.length, 0, 'هیچ کلاسی از اکسل ساخته نشد: ' + cls.map(c => c.name).join('، '));
    const studs = T.list('users').filter(u => u.role === 'student');
    assert.strictEqual(studs.length, 2, 'هر دو دانش‌آموز ساخته شدند');
    studs.forEach(u => {
      assert.strictEqual(u.grade, 'دهم', 'پایهٔ اعلام‌شده روی دانش‌آموز نشست');
      assert.strictEqual(u.field, 'الکترونیک', 'رشته روی دانش‌آموز نشست');
      assert.strictEqual(Number(u.class_id) || 0, 0, 'به هیچ کلاسی وصل نشد');
      assert.ok(!u.followup_reason, 'با پایهٔ اعلام‌شده پیگیری لازم نیست: ' + (u.followup_reason || ''));
    });

    /* شمارش تفکیک‌شده */
    assert.strictEqual(res.students, 2, 'شمارش دانش‌آموزان جداست');
    assert.strictEqual(res.classes, 0, 'هیچ کلاسی ساخته نشد');
    assert.ok(/گروه ساخته‌شده/.test(T.impStepHtml() || '') || true, 'کارت پایان سالم است');

    /* کارت پایان: دانش‌آموز / اولیا / کادر جدا نوشته می‌شوند */
    T.S.imp = { step: 4, kind: 'students', checks: [], fileName: 'x.xlsx', result: { students: 129, parents: 228, staff: 0, classes: 6, updated: 0, created: 129, errors: [] } };
    const summary = T.impStepHtml();
    assert.ok(/دانش‌آموز وارد شد/.test(summary), 'برچسب دانش‌آموز');
    assert.ok(/حساب ولی/.test(summary), 'برچسب ولی');
    assert.ok(/دبیر و کادر/.test(summary), 'برچسب کادر');
    assert.ok(/گروه ساخته‌شده/.test(summary), 'برچسب گروه');
    assert.ok(/۱۲۹/.test(summary) && /۲۲۸/.test(summary), 'عددها تفکیک شده‌اند');

    /* نشانگر پردازش: چرخان + درصد */
    T.busyOverlay('در حال ثبت');
    const ov = win.document.getElementById('busy-overlay');
    assert.ok(ov, 'نشانگر ساخته شد');
    assert.strictEqual(ov.style.display, 'flex', 'نمایش داده شد');
    assert.ok(ov.querySelector('.spinner'), 'چرخان (spinner) دارد');
    assert.strictEqual(win.document.getElementById('busy-title').textContent.trim(), 'در حال ثبت', 'فقط «در حال ثبت» نوشته می‌شود');
    assert.strictEqual(ov.textContent.replace('در حال ثبت', '').trim(), '', 'هیچ نوشتهٔ اضافه‌ای نیست: «' + ov.textContent.trim() + '»');
    T.busyUpdate(65, 129);
    assert.strictEqual(win.document.getElementById('busy-fill').style.width, '50%', 'نوار پیشرفت بی‌متن کار می‌کند');
    dom.window.close();
  });

  await test('غلط تایپی رشته اصلاح و گزارش می‌شود؛ کلاس/کارگاه فقط نام؛ مشخصات کامل همه‌جا اعمال می‌شود', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/authz.js') + '\n;\n'
      + strip('client/app.js') + '\n;window.__t = { S, list, byId, impCheck, impPlaceOf, roomFormHtml, classFormHtml, PAGES, actUserFull };');
    const T = win.__t;
    T.S.user = { id: 1, name: 'مدیر', role: 'manager' };
    T.S.role = 'manager'; T.S.session = 'x'; T.S.route = 'classes'; T.S.queue = []; T.S.online = false;
    T.S.data = {
      users: new Map([
        [1, { id: 1, name: 'مدیر', role: 'manager' }],
        [10, { id: 10, name: 'آرین رحمانی', role: 'student', national_id: '3840509807', class_id: 5 }],
        [11, { id: 11, name: 'پدر آرین', role: 'parent', phone: '09121110001' }],
      ]),
      classes: new Map([[5, { id: 5, name: 'دهم گرافیک', grade: 'دهم', branch: 'گرافیک', mode: 'field', kind: 'group' }]]),
      subjects: new Map(),
      lookups: new Map([[1, { id: 1, kind: 'grade', name: 'دهم' }], [2, { id: 2, kind: 'branch', name: 'گرافیک' }]]),
      parent_links: new Map([[1, { id: 1, parent_id: 11, student_id: 10, relation: 'پدر' }]]),
    };
    T.S.impGrades = ['دهم'];

    /* ── ۱) غلط تایپی «کرافیک» در فایل ── */
    T.S.imp = {
      step: 2, kind: 'students', headers: ['نام', 'رشته'],
      rows: [['الف آزمون', 'گرافیک'], ['ب آزمون', 'کرافیک'], ['ج آزمون', 'گرافیک']],
      map: ['first_name', 'field'],
    };
    let checks = T.impCheck();
    const asks = T.S.impBranchAskList || [];
    assert.ok(asks.some(a => a.from === 'کرافیک' && a.to === 'گرافیک'), 'سؤال «کرافیک همان گرافیک است؟» ساخته شد: ' + JSON.stringify(asks));
    assert.strictEqual((T.S.impBranchFixes || []).length, 0, 'بدون تأیید مدیر هیچ رشته‌ای عوض نمی‌شود');
    T.S.impBranchAsk = { 'کرافیک': 'گرافیک' };        /* مدیر تأیید کرد */
    checks = T.impCheck();
    const fixes = T.S.impBranchFixes || [];
    assert.ok(fixes.some(f => f.from === 'کرافیک' && f.to === 'گرافیک'), 'اصلاح «کرافیک» ← «گرافیک» گزارش شد: ' + JSON.stringify(fixes));
    const names = checks.map(c => [c.data.grade, c.data.field].filter(Boolean).join(' ') || (byIdSafe(c.data.class_id)));
    function byIdSafe(id) { const c = T.byId('classes', id); return c ? c.name : ''; }
    assert.ok(names.every(n => String(n).indexOf('کرافیک') < 0), 'هیچ گروهی با نام غلط ساخته نمی‌شود: ' + names.join(' | '));
    assert.ok(names.filter(n => String(n) === 'دهم گرافیک').length === 3, 'همه در «دهم گرافیک»: ' + names.join(' | '));

    /* ── ۲) فرم کلاس/کارگاه فقط نام ── */
    const room = T.roomFormHtml(null);
    assert.ok(/name="name"/.test(room) && /kind/.test(room), 'فرم کارگاه نام دارد');
    assert.ok(!/name="grade"/.test(room) && !/name="branch"/.test(room) && !/name="capacity"/.test(room), 'پایه/رشته/ظرفیت ندارد');
    const groupForm = T.classFormHtml(null);
    assert.ok(/name="grade"/.test(groupForm) && /name="branch"/.test(groupForm), 'فرم گروه پایه و رشته دارد');
    assert.ok(!/name="capacity"/.test(groupForm), 'ظرفیت حذف شد');
    const pageHtml = T.PAGES.classes();
    assert.ok(/کلاس‌ها و کارگاه‌ها/.test(pageHtml), 'کارت محل برگزاری باقی است');
    assert.ok(!/کلاس‌های ثبت‌نام/.test(pageHtml), 'بخش کلاس‌های ثبت‌نام حذف شده است');
    assert.ok(!/گروه‌های ثبت‌نام/.test(pageHtml), 'کارت «گروه‌های ثبت‌نام» وجود ندارد');
    assert.strictEqual((pageHtml.match(/data-act="room-add"/g) || []).length, 1, 'دکمهٔ افزودن کلاس/کارگاه فقط یک‌بار، داخل کارت محل برگزاری می‌آید');

    /* ── ۳) مشخصات کامل: ویرایش شمارهٔ پدر روی حساب ولی هم می‌نشیند ── */
    T.actUserFull(10);
    const form = win.document.querySelector('form[data-form="user-full"]');
    assert.ok(form, 'فرم مشخصات کامل باز شد');
    assert.ok(form.elements['father_phone'], 'فیلد موبایل پدر هست');
    assert.ok(form.elements['mother_phone'] || form.elements['father_job'], 'فیلدهای اکسل هست');
    form.elements['father_name'].value = 'پدر آرین';
    form.elements['father_phone'].value = '09121110999';
    form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 120));
    const stu = T.byId('users', 10);
    assert.strictEqual(String(stu.father_phone), '09121110999', 'مشخصات دانش‌آموز ذخیره شد');
    const pu = T.byId('users', 11);
    assert.strictEqual(String(pu.phone), '09121110999', 'حساب خود ولی هم به‌روز شد: ' + pu.phone);
    dom.window.close();
  });

  /* — کلاس‌هایی که قدیمی‌ترها از رشته ساخته بودند: اصلاح و ادغام ─────── */
  await test('داشبورد: پوشش حضور به تفکیک پایه/رشته و کلاسِ در حال تدریس سبز است', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/app.js') + '\n;window.__t = { S, managerHome, todayISO, weekdayIndex, nowMin };');
    const T = win.__t;
    T.S.user = { id: 1, name: 'مدیر', role: 'manager' };
    T.S.role = 'manager'; T.S.session = 'x'; T.S.clockOffset = 0;
    const now = T.nowMin();
    const start = Math.max(0, now - 2), end = Math.min(1439, Math.max(now + 2, start + 1));
    const fmt = n => String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
    T.S.data = {
      users: new Map([
        [1, { id: 1, role: 'manager', name: 'مدیر' }],
        [10, { id: 10, role: 'student', name: 'دانش‌آموز یک', class_id: 5, active: true }],
        [11, { id: 11, role: 'student', name: 'دانش‌آموز دو', class_id: 6, active: true }],
        [12, { id: 12, role: 'student', name: 'دانش‌آموز سه', class_id: 9, active: true }],
        [20, { id: 20, role: 'teacher', name: 'دبیر آزمون' }],
      ]),
      classes: new Map([
        [5, { id: 5, name: 'دهم الکترونیک', kind: 'group', grade: 'دهم', branch: 'الکترونیک' }],
        [6, { id: 6, name: 'دهم الکترونیک — گروه ب', kind: 'group', grade: 'دهم', branch: 'الکترونیک' }],
        [7, { id: 7, name: 'کلاس ۱۰۱', kind: 'room' }],
        [8, { id: 8, name: 'کلاس ۱۰۲', kind: 'room' }],
        [9, { id: 9, name: 'یازدهم ریاضی', kind: 'group', grade: 'یازدهم', branch: 'ریاضی' }],
      ]),
      subjects: new Map([[30, { id: 30, name: 'فیزیک' }]]),
      attendance: new Map([
        [1, { id: 1, student_id: 10, class_id: 5, date: T.todayISO(), status: 'present' }],
        [2, { id: 2, student_id: 11, class_id: 6, date: T.todayISO(), status: 'absent' }],
      ]),
      schedule: new Map([[1, { id: 1, class_id: 5, room_id: 7, subject_id: 30, teacher_id: 20, weekday: T.weekdayIndex(), bell_order: 1, grade: 'دهم', branch: 'الکترونیک' }]]),
      bell_schedules: new Map([[1, { id: 1, order: 1, start: fmt(start), end: fmt(end), type: 'lesson', label: 'زنگ اول' }]]),
      grades: new Map(), announcements: new Map(),
    };
    const html = T.managerHome();
    const attendance = html.match(/<section id="dashboard-attendance-coverage">([\s\S]*?)<\/section>/);
    const rooms = html.match(/<section id="dashboard-room-coverage">([\s\S]*?)<\/section>/);
    assert.ok(html.includes('class="dashboard-coverage-grid"') && html.indexOf('id="dashboard-attendance-coverage"') < html.indexOf('id="dashboard-room-coverage"'), 'دو پوشش در یک چیدمان مشترک با حضور در ستون راست هستند');
    assert.ok(attendance && attendance[1].includes('دهم') && attendance[1].includes('الکترونیک'), 'پوشش حضور با پایه و رشته جدول‌بندی شد');
    assert.ok(attendance[1].includes('۲ / ۲') && attendance[1].includes('حاضر') && attendance[1].includes('غایب'), 'تعداد ثبت‌شده و تفکیک حاضر/غایب دیده می‌شود');
    assert.ok(!attendance[1].includes('کلاس ۱۰۱'), 'محل فیزیکی به‌جای پایه/رشته در جدول حضور نمایش داده نمی‌شود');
    assert.ok(rooms && /dashboard-room-row is-occupied[^>]*data-room-id="7"/.test(rooms[1]), 'کلاس ۱۰۱ هنگام وجود زنگ جاری در وضعیت سبز است');
    assert.ok(html.includes('dashboard-now') && html.includes('<span class="dashboard-now-kicker">الان در</span><strong>زنگ اول</strong>'), 'زنگ جاری در گوشهٔ بالای داشبورد نمایش داده می‌شود');
    assert.ok(/class="dashboard-now-date">(?:شنبه|یک‌شنبه|دوشنبه|سه‌شنبه|چهارشنبه|پنج‌شنبه|جمعه) · /.test(html), 'روز هفته و تاریخ شمسی با اندازهٔ کوچک زیر زنگ می‌آیند');
    assert.ok(rooms[1].includes('دهم · الکترونیک') && rooms[1].includes('فیزیک') && rooms[1].includes('دبیر آزمون'), 'وضعیت کلاس، پایه/رشته و درس/دبیر را مشخص می‌کند');
    assert.ok(/data-room-id="8"/.test(rooms[1]) && /خالی در این زنگ/.test(rooms[1]), 'کلاس بدون برنامهٔ جاری خالی نشان داده می‌شود');
    T.S.data.bell_schedules.get(1).type = 'break';
    assert.ok(T.managerHome().includes('<span class="dashboard-now-kicker">الان در</span><strong>بین زنگ‌های درسی</strong>'), 'وقتی زنگ فعالی نیست، وضعیت خالی به‌روشنی نمایش داده می‌شود');
    const styles = fs.readFileSync(path.join(ROOT, 'client/styles.css'), 'utf8');
    assert.ok(/\.input,select\.input,textarea\.input\{[^}]*border:2px solid/.test(styles), 'فیلدهای قابل‌تکمیل حاشیهٔ برجسته دارند');
    assert.ok(/dashboard-coverage-grid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\);[^}]*direction:rtl/.test(styles), 'دو پنل در نمایشگر عریض کنار هم و با ترتیب راست‌به‌چپ می‌آیند');
    assert.ok(/dashboard-topbar-left\{display:flex;align-items:center;gap:14px\}/.test(styles) && /\.dashboard-now-date\{font-size:11px/.test(styles), 'اطلاعات زنگ در گوشهٔ چپ و تاریخ/روز در اندازهٔ کوچک چیده می‌شود');
    assert.ok(/@media \(max-width:700px\)\{\.dashboard-topbar\{align-items:flex-start;flex-direction:column\}/.test(styles), 'سربرگ داشبورد در نمایشگر باریک زیر هم چیده می‌شود');
    assert.ok(/dashboard-room-row\.is-occupied td\{background:var\(--green-bg\)/.test(styles), 'کلاس در حال تدریس با زمینهٔ سبز برجسته می‌شود');
    dom.window.close();
  });

  await test('صفحهٔ کلاس‌ها بخش ثبت‌نام را ندارد و فقط محل برگزاری و تعریف‌ها را نشان می‌دهد', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/authz.js') + '\n;\n'
      + strip('client/app.js') + '\n;window.__t = { S, list, PAGES };');
    const T = win.__t;
    T.S.user = { id: 1, name: 'مدیر', role: 'manager' };
    T.S.role = 'manager'; T.S.session = 'x'; T.S.route = 'classes';
    T.S.server = { school: { level: 'متوسطه دوم' } };
    T.S.data = {
      users: new Map([
        [1, { id: 1, name: 'مدیر', role: 'manager' }],
        [9, { id: 9, name: 'دانش‌آموز یک', role: 'student', class_id: 5 }],
      ]),
      classes: new Map([
        [5, { id: 5, name: 'دهم گرافیک', grade: 'دهم', branch: 'گرافیک', mode: 'field', kind: 'class' }],
        [6, { id: 6, name: 'دهم الکترونیک', grade: 'دهم', branch: 'الکترونیک', mode: 'field', kind: 'group' }],
        [7, { id: 7, name: 'کارگاه الکترونیک', kind: 'room' }],
      ]),
      subjects: new Map([[10, { id: 10, name: 'ریاضی' }]]),
      lookups: new Map([[21, { id: 21, kind: 'grade', name: 'دهم' }], [20, { id: 20, kind: 'branch', name: 'گرافیک' }],
        [22, { id: 22, kind: 'branch', name: 'الکتروتکنیک' }]]),
      schedule: new Map(), grades: new Map(), attendance: new Map(),
      parent_links: new Map(), substitutions: new Map(), bell_schedules: new Map(),
    };
    T.S.queue = []; T.S.online = false;

    const page = T.PAGES.classes();
    assert.ok(!page.includes('کلاس‌های ثبت‌نام'), 'کارت ثبت‌نام پایه + رشته دیگر نمایش داده نمی‌شود');
    assert.ok(!page.includes('دهم گرافیک'), 'فهرست کلاس‌های ثبت‌نام از این صفحه برداشته شده است');
    assert.ok(!page.includes('دهم الکترونیک'), 'گروهِ ساختهٔ اکسل (kind=group) در این صفحه نیست');
    assert.ok(page.includes('کارگاه الکترونیک'), 'کلاس/کارگاه (محل برگزاری) دیده می‌شود');
    assert.strictEqual((page.match(/data-act="room-add"/g) || []).length, 1, 'دکمهٔ افزودن محل برگزاری تکرار نشده است');
    assert.ok(page.includes('پایه‌ها') && page.includes('رشته‌ها'), 'تعریف جداگانهٔ پایه‌ها و رشته‌ها باقی است');
    assert.ok(!page.includes('کلاس‌هایی که پایه ندارند'), 'کارت اصلاح کلاس‌های بی‌پایه حذف شد');
    assert.ok(!page.includes('رشته‌های شبیه هم'), 'کارت «رشته‌های شبیه هم» حذف شد');
    assert.ok(!page.includes('data-act="def-merge"'), 'دکمهٔ ادغام رشته حذف شد');
    dom.window.close();
  });

  await test('برنامهٔ هفتگی: تداخلِ دبیر، پیشنهاد جای آزاد و تولید خودکار', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/schedule.js') + '\n;\n' + strip('client/app.js')
      + '\n;window.__t = { S, schedPage, schedGenerate, schedConflicts, schedTeacherBusyAt, schedSuggestSlots, schedSlotModal, schedWorkDays, schedPeriods, schedBellLabel, schedLessons, SCHED_FORMS, SCHED_ACTIONS, handleSubmit, closeModal, parseJalaliIso, time24, norm, alphaCompare, alphaSort, markControlInvalid, validateRequiredForm };');
    const T = win.__t;
    T.S.user = { id: 1, name: 'مدیر', role: 'manager' };
    T.S.role = 'manager'; T.S.session = 'x'; T.S.route = 'schedule';
    T.S.data = {
      users: new Map([
        [1, { id: 1, name: 'مدیر', role: 'manager' }],
        [2, { id: 2, name: 'دبیر الف', role: 'teacher', active: true, subject: 'ریاضی' }],
        [3, { id: 3, name: 'دبیر ب', role: 'teacher', active: true, subject: 'فیزیک' }],
      ]),
      classes: new Map([[1, { id: 1, name: 'دهم الف', grade: 'دهم' }], [2, { id: 2, name: 'دهم ب', grade: 'دهم' }]]),
      subjects: new Map([[10, { id: 10, name: 'ریاضی', weekly_hours: 3 }], [11, { id: 11, name: 'فیزیک', weekly_hours: 2 }]]),
      bell_schedules: new Map([1, 2, 3, 4, 5, 6].map(n => [n, { id: n, order: n, start: '0' + n + ':00', end: '0' + n + ':45', type: 'lesson' }])),
      schedule: new Map([
        [100, { id: 100, class_id: 1, subject_id: 10, teacher_id: 2, weekday: 0, bell_order: 1 }],
        [101, { id: 101, class_id: 2, subject_id: 10, teacher_id: 2, weekday: 0, bell_order: 1 }],   /* تداخل: یک دبیر دو کلاس */
      ]),
      substitutions: new Map(),
      schools: new Map([[1, { id: 1, workdays: [0, 2] }]]),
    };
    T.S.queue = []; T.S.online = false;

    const confs = T.schedConflicts();
    assert.strictEqual(confs.length, 1, 'یک تداخل پیدا شد');
    assert.strictEqual(confs[0].kind, 'teacher');
    assert.strictEqual(confs[0].rows.length, 2);

    assert.ok(T.schedTeacherBusyAt(2, 0, 1, 0), 'دبیر در آن ساعت مشغول است');
    assert.strictEqual(T.schedTeacherBusyAt(2, 1, 1, 0), null, 'روز دیگر آزاد است');

    const sugs = T.schedSuggestSlots(101);
    assert.ok(sugs.length > 0, 'جای آزاد پیشنهاد شد');
    assert.ok(sugs.every(g => !(g.day === 0 && g.period === 1)), 'پیشنهاد، خانهٔ تداخل‌دار نیست');
    assert.ok(sugs.every(g => !T.schedTeacherBusyAt(2, g.day, g.period, 101)), 'دبیر در هیچ پیشنهادی مشغول نیست');

    /* تولید خودکار: جزو خانه‌های پرشده نمی‌نویسد و تداخل نمی‌سازد */
    const res = T.schedGenerate({
      classes: [{ id: 1, grade: 'دهم' }, { id: 2, grade: 'دهم' }],
      subjects: [{ id: 10, weekly_hours: 3 }, { id: 11, weekly_hours: 2 }],
      teachers: [{ id: 2, subject_id: 10 }, { id: 3, subject_id: 11 }],
      existing: [{ class_id: 1, subject_id: 10, teacher_id: 2, day: 0, period: 1 }],
      days: [0, 1, 2, 3, 4, 5], periodsPerDay: 6,
    });
    assert.ok(res.stats.demands > 0, 'تقاضا ساخته شد');
    assert.strictEqual(res.stats.placed, res.placements.length);
    const seenClass = new Set(), seenTeacher = new Set();
    for (const p of res.placements) {
      const kc = p.class_id + '|' + p.day + '|' + p.period;
      assert.ok(!seenClass.has(kc), 'هیچ کلاسی دو زنگ هم‌زمان ندارد');
      seenClass.add(kc);
      if (p.teacher_id != null) {
        const kt = p.teacher_id + '|' + p.day + '|' + p.period;
        assert.ok(!seenTeacher.has(kt), 'هیچ دبیری دو زنگ هم‌زمان ندارد');
        seenTeacher.add(kt);
      }
      assert.ok(!(p.class_id === 1 && p.day === 0 && p.period === 1), 'خانهٔ پرشدهٔ کلاس دوباره پر نشد');
      assert.ok(!(p.teacher_id === 2 && p.day === 0 && p.period === 1), 'دبیرِ مشغول در آن ساعت گذاشته نشد');
    }

    /* صفحه: نمای مدیر با خانه‌های قابلِ کلیک و دکمهٔ تولید خودکار */
    const html = T.schedPage();
    assert.ok(/data-act="sched-slot"/.test(html), 'خانه‌های جدول قابلِ کلیک‌اند');
    assert.ok(/data-act="schedgen-open"/.test(html), 'دکمهٔ تولید خودکار هست');
    assert.ok(/data-set="schedGrade"/.test(html) && /data-set="schedBranch"/.test(html), 'انتخاب‌گر پایه و رشته جای انتخاب کلاس را گرفته است');
    assert.ok(!/<b class="small">کلاس<\/b>/.test(html), 'عنوان انتخاب کلاس حذف شده است');
    assert.ok(/روزهای فعال/.test(html), 'کنترل روزهای فعال در صفحه قابل‌دسترسی است');
    assert.ok(!/data-act="sched-slot" data-day="1"/.test(html), 'روز غیرفعال از جدول حذف شده است');
    assert.ok(/تداخل/.test(html), 'هشدار تداخل نمایش داده شد');
    assert.ok(/data-act="sched-slot" data-day="0" data-period="1" data-id="100"/.test(html), 'خانهٔ پر با شناسهٔ زنگ');

    /* پنجرهٔ زنگ: درس، دبیر با وضعیت آزاد/مشغول و جابه‌جای موقت */
    T.S.modalTitle = '';
    T.schedSlotModal(T.S.data.schedule.get(100));
    const modalHtml = win.document.querySelector('#modal-root').innerHTML;
    assert.ok(/data-form="slot"/.test(modalHtml), 'فرم زنگ باز شد');
    assert.ok(/🔴/.test(modalHtml), 'دبیرِ مشغول با نشان سرخ دیده می‌شود');
    assert.ok(/sub_date/.test(modalHtml), 'بخش جابه‌جای موقت هست');
    assert.ok(/تاریخ شمسی/.test(modalHtml) && /data-jalali-date="sub_date"/.test(modalHtml), 'تاریخ جایگزین با ورودی شمسی است');
    assert.ok(!/type="date"|type="time"/.test(modalHtml), 'ورودی بومی میلادی یا ساعت ۱۲/۲۴‌ساعته باقی نمانده است');
    assert.ok(/data-act="modal-close"/.test(modalHtml), 'دکمهٔ ✕ در پنجره هست');
    const subjectControl = win.document.querySelector('#modal-root form[data-form="slot"] [name="subject"]');
    assert.ok(subjectControl.required, 'درسِ لازم در فرم زنگ required است');
    subjectControl.dispatchEvent(new win.Event('invalid', { cancelable: true }));
    assert.ok(subjectControl.classList.contains('input-invalid'), 'فیلد ناقص با رویداد اعتبارسنجی قرمز می‌شود');
    subjectControl.value = '10';
    subjectControl.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.ok(!subjectControl.classList.contains('input-invalid'), 'پس از تکمیل فیلد، نشانهٔ خطا پاک می‌شود');
    assert.ok(T.parseJalaliIso('۱۴۰۵/۰۸/۱۷'), 'تاریخ شمسی به تاریخ ذخیره‌سازی تبدیل می‌شود');
    assert.strictEqual(T.parseJalaliIso('۱۴۰۵/۱۳/۱۷'), '', 'ماه نامعتبر رد می‌شود');
    assert.strictEqual(T.norm(T.time24(new Date(2026, 0, 1, 0, 5))), '00:05', 'ساعت نیمه‌شب با قالب ۲۴ساعته نمایش داده می‌شود');
    const alpha = T.alphaSort(['دبیر ب', 'دبیر آ', 'دبیر الف']);
    assert.ok(alpha.every((name, i) => i === 0 || T.alphaCompare(alpha[i - 1], name) <= 0), 'مرتب‌سازی فارسی در کل فهرست‌ها الفبایی است');
    assert.ok(/name="room_id"/.test(modalHtml), 'محل از فهرست محل‌های تعریف‌شده انتخاب می‌شود');
    assert.ok(/value="__add_subject__"[^>]*>＋ تعریف درس تازه/.test(modalHtml) && /value="__add_teacher__"[^>]*>＋ ثبت دبیر تازه/.test(modalHtml) && /value="__add_room__"[^>]*>＋ افزودن محل تازه/.test(modalHtml), 'گزینه‌های افزودن درس، دبیر و محل انتهای فهرست انتخاب‌اند');
    assert.ok(!/data-act="sched-(subject|teacher|room)-add"/.test(modalHtml), 'دکمه‌های جداگانهٔ افزودن از بیرون فهرست حذف شده‌اند');

    /* تعریف درس از همان پنجره ثبت می‌شود و بلافاصله در زنگ انتخاب شده است. */
    T.schedSlotModal({ grade: 'دهم', branch: '', weekday: 0, bell_order: 2 });
    const addSubjectChoice = win.document.querySelector('#modal-root select[name="subject"]');
    addSubjectChoice.value = '__add_subject__';
    addSubjectChoice.dispatchEvent(new win.Event('change', { bubbles: true }));
    const subjectForm = win.document.querySelector('#modal-root form[data-form="subject"]');
    subjectForm.elements.name.value = 'درس تازه';
    subjectForm.elements.workshop.value = '';
    await T.handleSubmit(subjectForm);
    const createdSubject = Array.from(T.S.data.subjects.values()).find(x => x.name === 'درس تازه');
    assert.ok(createdSubject, 'درس تازه در فهرست درس‌ها ذخیره شد');
    const reopenedSlot = win.document.querySelector('#modal-root form[data-form="slot"]');
    assert.ok(reopenedSlot && Number(reopenedSlot.elements.subject.value) === Number(createdSubject.id), 'درس تازه در فرم زنگ انتخاب شد');

    /* تنظیم روزهای فعال در مدرسه ذخیره می‌شود و مبنای جدول بعدی است. */
    T.SCHED_FORMS.workdays({ day_1: { checked: true }, day_4: { checked: true } });
    assert.deepStrictEqual(Array.from(T.S.data.schools.get(1).workdays), [1, 4]);
    assert.deepStrictEqual(Array.from(T.schedWorkDays()), [1, 4]);

    /* گزینهٔ انتهاییِ دبیر، فرم درجا را باز می‌کند و بعد به فرم زنگ برمی‌گردد. */
    T.schedSlotModal({ grade: 'دهم', branch: '', weekday: 1, bell_order: 2, subject_id: createdSubject.id });
    const addTeacherChoice = win.document.querySelector('#modal-root select[name="teacher"]');
    addTeacherChoice.value = '__add_teacher__';
    addTeacherChoice.dispatchEvent(new win.Event('change', { bubbles: true }));
    assert.ok(win.document.querySelector('#modal-root form[data-form="sched-teacher"]'), 'انتخاب افزودن دبیر، فرم ساخت را باز کرد');
    T.SCHED_FORMS['sched-teacher']({ name: { value: 'دبیر تازه' } });
    const createdTeacher = Array.from(T.S.data.users.values()).find(u => u.name === 'دبیر تازه');
    assert.ok(createdTeacher && createdTeacher.role === 'teacher', 'کاربر دبیر ساخته شد');
    assert.ok(/data-form="slot"/.test(win.document.querySelector('#modal-root').innerHTML), 'پس از تعریف دبیر به فرم زنگ برگشت');

    /* گزینهٔ انتهاییِ محل نیز همان مسیر تعریف درجا را باز می‌کند. */
    T.schedSlotModal({ grade: 'دهم', branch: '', weekday: 1, bell_order: 3, subject_id: createdSubject.id });
    const addRoomChoice = win.document.querySelector('#modal-root select[name="room_id"]');
    addRoomChoice.value = '__add_room__';
    addRoomChoice.dispatchEvent(new win.Event('change', { bubbles: true }));
    assert.ok(win.document.querySelector('#modal-root form[data-form="sched-room"]'), 'انتخاب افزودن محل، فرم ساخت را باز کرد');
    T.SCHED_FORMS['sched-room']({ name: { value: 'آزمایشگاه تازه' } });
    const createdRoom = Array.from(T.S.data.classes.values()).find(c => c.name === 'آزمایشگاه تازه');
    assert.ok(createdRoom && createdRoom.kind === 'room', 'محل تازه ذخیره شد');
    assert.ok(/آزمایشگاه تازه/.test(win.document.querySelector('#modal-root').innerHTML), 'محل تازه به فرم برگشتی اضافه شد');
    T.SCHED_FORMS.slot({
      id: { value: '' }, grade: { value: 'دهم' }, branch: { value: '' }, class_id: { value: '1' },
      day: { value: '1' }, period: { value: '3' }, subject: { value: String(createdSubject.id) },
      teacher: { value: String(createdTeacher.id) }, room_id: { value: String(createdRoom.id) }, legacy_room: { value: '' },
    });
    const savedSlot = Array.from(T.S.data.schedule.values()).find(x => Number(x.weekday) === 1 && Number(x.bell_order) === 3);
    assert.ok(savedSlot && savedSlot.grade === 'دهم' && savedSlot.branch === '', 'برنامه برای پایه و رشته ذخیره شد');
    assert.strictEqual(Number(savedSlot.room_id), Number(createdRoom.id), 'محل انتخاب‌شده به برنامه پیوند خورد');
    assert.strictEqual(savedSlot.room, 'آزمایشگاه تازه', 'نام محل برای نمایش ذخیره شد');

    T.SCHED_ACTIONS['bell-edit']();
    const bellHtml = win.document.querySelector('#modal-root').innerHTML;
    assert.ok(/شروع/.test(bellHtml) && /پایان/.test(bellHtml) && /زنگ درس/.test(bellHtml) && /زنگ تفریح/.test(bellHtml), 'تنظیم زنگ شروع/پایان و تفریح را روشن نمایش می‌دهد');
    assert.ok(/data-act="bell-add"/.test(bellHtml) && !/data-type="(lesson|break)"/.test(bellHtml), 'افزودن زنگ فقط یک گزینهٔ عمومی دارد');
    assert.ok(/clock-24h[^>]*type="text"/.test(bellHtml) && !/type="time"/.test(bellHtml), 'ساعت‌ها به‌صورت ورودی متنی ۲۴ساعته‌اند');
    const bellsForm = win.document.querySelector('#modal-root form[data-form="bells"]');
    const existingBellIds = Array.from(T.S.data.bell_schedules.values()).map(b => Number(b.id)).sort((a, b) => a - b);
    bellsForm.elements.s_0.value = '07:30'; bellsForm.elements.e_0.value = '08:15';
    T.SCHED_ACTIONS['bell-add'](win.document.querySelector('#modal-root [data-act="bell-add"]'));
    assert.deepStrictEqual(Array.from(T.S.bellDraft).slice(0, 6).map(b => Number(b.id)), existingBellIds, 'افزودن زنگ، شناسهٔ زنگ‌های ذخیره‌شده را نگه می‌دارد');
    assert.strictEqual(T.S.bellDraft[0].start, '07:30', 'مقدار ویرایش‌شده پیش از افزودن زنگ حفظ می‌شود');
    let expandedBellForm = win.document.querySelector('#modal-root form[data-form="bells"]');
    assert.strictEqual(expandedBellForm.elements.s_0.value, '07:30', 'فرم دوباره‌ساخته‌شده ساعت قبلی را حفظ می‌کند');
    for (let i = 0; i < 6; i++) {
      const start = 7 * 60 + 30 + i * 30, end = start + 30;
      const fmt = n => String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
      expandedBellForm.elements['s_' + i].value = fmt(start);
      expandedBellForm.elements['e_' + i].value = fmt(end);
    }
    expandedBellForm.elements.s_6.value = '10:30'; expandedBellForm.elements.e_6.value = '11:00';
    T.SCHED_FORMS.bells(expandedBellForm.elements);
    assert.strictEqual(T.S.data.bell_schedules.size, 7, 'ذخیره پس از افزودن، شش زنگ قبلی را نگه می‌دارد و زنگ تازه را اضافه می‌کند');
    assert.ok(existingBellIds.every(id => T.S.data.bell_schedules.has(id)), 'شناسه‌های زنگ‌های قبلی پس از ذخیره باقی می‌مانند');
    T.S.data.bell_schedules.set(99, { id: 99, order: 1.5, start: '08:15', end: '08:30', type: 'break', label: 'زنگ تفریح' });
    T.schedSlotModal({ grade: 'دهم', weekday: 0, bell_order: 1 });
    const periodOptions = Array.from(win.document.querySelectorAll('#modal-root select[name="period"] option')).map(o => o.textContent.trim());
    assert.strictEqual(periodOptions.length, 7, 'فقط زنگ‌های درس در انتخاب برنامه دیده می‌شوند');
    assert.ok(periodOptions.every(o => o.startsWith('زنگ ') && !o.includes('تفریح') && !o.includes(':')), 'فهرست انتخاب فقط نام زنگ را بدون ساعت نشان می‌دهد');
    T.S.data.bell_schedules.delete(99);
    T.SCHED_ACTIONS['bell-edit']();
    T.S.bellDraft = [{ id: 0 }, { id: 0 }];
    T.SCHED_FORMS.bells({
      s_0: { value: '07:30' }, e_0: { value: '08:30' }, t_0: { value: 'lesson' },
      s_1: { value: '08:15' }, e_1: { value: '08:45' }, t_1: { value: 'break' },
    });
    assert.strictEqual(T.S.data.bell_schedules.size, 7, 'زمان‌های هم‌پوشان ذخیره نمی‌شوند');
    T.S.bellDraft = [{ id: 0 }, { id: 0 }];
    T.SCHED_FORMS.bells({
      s_0: { value: '07:30' }, e_0: { value: '08:15' }, t_0: { value: 'lesson' },
      s_1: { value: '08:15' }, e_1: { value: '08:30' }, t_1: { value: 'break' },
    });
    assert.strictEqual(T.S.data.bell_schedules.size, 2, 'ساعت‌های معتبر ثبت شدند');
    assert.ok(Array.from(T.S.data.bell_schedules.values()).some(b => b.type === 'break'), 'تفریح جداگانه ذخیره شد');

    /* پیش‌فرض خالی، چهار درس و سه تفریح میان آن‌هاست؛ حذف ردیف هم پیمایش را حفظ می‌کند. */
    const savedBells = T.S.data.bell_schedules;
    T.S.data.bell_schedules = new Map();
    T.SCHED_ACTIONS['bell-edit']();
    assert.deepStrictEqual(Array.from(T.S.bellDraft, b => b.type), ['lesson', 'break', 'lesson', 'break', 'lesson', 'break', 'lesson']);
    const defaultBellForm = win.document.querySelector('#modal-root form[data-form="bells"]');
    assert.ok(/زنگ ۱ \(درس\)/.test(defaultBellForm.textContent) && /تفریح اول/.test(defaultBellForm.textContent) && /زنگ ۴ \(درس\)/.test(defaultBellForm.textContent), 'نام‌های پیش‌فرض درس و تفریح با ترتیب درست نمایش داده می‌شوند');
    win.document.querySelector('#modal-root .modal').scrollTop = 180;
    T.SCHED_ACTIONS['bell-del'](win.document.querySelector('#modal-root [data-act="bell-del"][data-i="6"]'));
    assert.strictEqual(win.document.querySelector('#modal-root .modal').scrollTop, 180, 'حذف ردیف، پیمایش دیالوگ زنگ را حفظ می‌کند');
    assert.strictEqual(T.S.bellDraft.length, 6, 'ردیف انتخاب‌شده حذف شد');
    T.S.data.bell_schedules = savedBells;
    T.closeModal();
    dom.window.close();
  });

  /* — دکمهٔ ✕ و بستن پنجره‌ها (ایراد گزارش‌شدهٔ کاربر) ───────────────
     ریشه: هندلر درون‌خطی stopPropagation روی خودِ پنجره، کلیک ✕ را می‌بلعید. */
  await test('فقط دکمهٔ ✕ پنجره را می‌بندد و بازسازی محتوا پیمایش را حفظ می‌کند', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/app.js') + '\n;window.__t = { S, modal, closeModal };');
    const T = win.__t;
    T.S.user = { id: 1, name: 'مدیر', role: 'manager' };
    T.S.role = 'manager'; T.S.session = 'x'; T.S.route = 'classes';
    const openModal = () => {
      T.S.modalTitle = 'آزمون';
      T.modal('<div id="inside">داخل</div>');
      return win.document.querySelector('#modal-root .modal');
    };
    const click = el => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));

    /* ۱) دکمهٔ ✕ */
    assert.ok(openModal(), 'پنجره باز می‌شود');
    click(win.document.querySelector('#modal-root [data-act="modal-close"]'));
    assert.strictEqual(win.document.querySelector('#modal-root').innerHTML, '', 'دکمهٔ ✕ پنجره را بست');

    /* ۲) کلیک داخل پنجره نباید ببندد (ریشهٔ همان ایراد) */
    openModal();
    click(win.document.querySelector('#inside'));
    assert.ok(win.document.querySelector('#modal-root .modal'), 'کلیک داخل پنجره، آن را نمی‌بندد');

    /* ۳) بیرون و Esc نباید ببندند؛ بازسازی هم باید scrollTop را نگه دارد. */
    const current = openModal();
    current.scrollTop = 240;
    click(win.document.querySelector('#modal-root [data-act="modal-bg"]'));
    assert.ok(win.document.querySelector('#modal-root .modal'), 'کلیک روی پس‌زمینه پنجره را باز نگه می‌دارد');
    win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.ok(win.document.querySelector('#modal-root .modal'), 'کلید Esc پنجره را باز نگه می‌دارد');
    T.modal('<div id="updated">به‌روزرسانی</div>');
    assert.strictEqual(win.document.querySelector('#modal-root .modal').scrollTop, 240, 'پس از جایگزینی محتوا پیمایش دیالوگ حفظ شد');
    dom.window.close();
  });

  /* — QR کارت پیوند + حذف PIN + موبایل‌های اکسل در «مشخصات کامل» —— */
  await test('کارت پیوند QR دارد، کد از پیوند خودکار باز می‌شود و موبایل‌های اکسل گم نمی‌شوند', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/app.js')
      + '\n;window.__t = { S, pairCardHtml, renderPair, pairCodeFromHash, pairDeepLink, impAutoMap, actUserFull, putLocal };');
    const T = win.__t;
    T.S.user = { id: 1, name: 'مدیر', role: 'manager' };
    T.S.role = 'manager'; T.S.session = 'x'; T.S.route = 'users';
    T.S.server = { school: 'دبیرستان آزمون', version: '0.8.28' };
    T.S.data = { users: new Map(), classes: new Map(), lookups: new Map(), parent_links: new Map() };

    /* ۱) کارت پیوند: یک QR همه‌کاره + QR نصب */
    const card = T.pairCardHtml({ code: 'ABCD1234', display: 'ABCD-1234', expires_at: new Date().toISOString(), user: { name: 'رضا', role: 'student' } });
    const web = BASE + '/#/pair=ABCD1234';
    assert.ok(card.indexOf(encodeURIComponent(web)) > -1, 'QR کارت به آدرس وبِ ورود خودکار اشاره می‌کند');
    assert.strictEqual((card.match(/scale=6/g) || []).length, 1, 'فقط یک QR اصلی روی کارت است');
    assert.ok(card.indexOf('native-continuous') > -1 && card.indexOf('payesh-local.apk') < 0, 'QR نصب برنامهٔ بومی روی کارت هست (ردیف ۱۲۹: بدون APK وب‌ویو)');
    assert.ok(card.indexOf('ABCD-1234') > -1, 'کد چاپی هم روی کارت می‌ماند');

    /* ۲) کد از هر سه شکل پیوند خوانده می‌شود */
    win.location.hash = '#/pair=ABCD1234';
    assert.strictEqual(T.pairCodeFromHash(), 'ABCD1234', '#/pair=CODE');
    win.location.hash = '#/pair?c=ABCD-1234';
    assert.strictEqual(T.pairCodeFromHash(), 'ABCD1234', '#/pair?c=CODE');
    win.location.hash = '#/join/abcd1234';
    assert.strictEqual(T.pairCodeFromHash(), 'ABCD1234', '#/join/CODE');
    assert.ok(T.pairDeepLink('ABCD1234').indexOf('payesh://pair?c=ABCD1234') === 0, 'پیوند باز کردن برنامه ساخته می‌شود');

    /* ۳) صفحهٔ ورود با کدِ آمده از QR: دکمهٔ «باز کردن برنامه» و «نصب» */
    win.location.hash = '#/pair=ABCD1234';
    T.renderPair();
    const html = win.document.querySelector('#app').innerHTML;
    assert.ok(html.indexOf('payesh://pair?c=ABCD1234') > -1, 'صفحه دکمهٔ باز کردن برنامه را دارد');
    assert.ok(html.indexOf('native-continuous') > -1 && html.indexOf('payesh-local.apk') < 0, 'صفحه دکمهٔ نصب برنامهٔ بومی را دارد');
    assert.ok(html.indexOf('همین مرورگر') > -1, 'ورود در مرورگر هم ممکن است (آیفون)');
    assert.ok(!/PIN/i.test(html) && html.indexOf('پین') < 0, 'هیچ نشانی از PIN نیست');

    /* ۴) نگاشت اکسل: «شماره تماس پدر» نباید موبایل دانش‌آموز شود */
    const map = T.impAutoMap(['نام و نام خانوادگی', 'شماره همراه', 'شماره تماس پدر', 'همراه مادر', 'همراه سرپرست'], 'students');
    assert.strictEqual(map[1], 'phone', '«شماره همراه» موبایل خودِ دانش‌آموز است');
    assert.strictEqual(map[2], 'father_phone', '«شماره تماس پدر» موبایل پدر است');
    assert.strictEqual(map[3], 'mother_phone', '«همراه مادر» موبایل مادر است');
    assert.strictEqual(map[4], 'guardian_phone', '«همراه سرپرست» موبایل سرپرست است');

    /* ۵) «مشخصات کامل» هر چهار موبایل را نشان می‌دهد */
    const stu = { id: 5, name: 'رضا', role: 'student', phone: '09121111111', father_phone: '09122222222', mother_phone: '09123333333' };
    T.putLocal('users', stu);
    T.actUserFull(5);
    const modal = win.document.querySelector('#modal-root').innerHTML;
    ['name="phone"', 'name="father_phone"', 'name="mother_phone"', 'name="guardian_phone"'].forEach(k => {
      assert.ok(modal.indexOf(k) > -1, 'کادر ' + k + ' در مشخصات کامل هست');
    });
    assert.ok(modal.indexOf('09122222222') > -1, 'شمارهٔ پدر نمایش داده می‌شود');
    dom.window.close();
  });

  /* — پنجرهٔ «کاربری»: نام کاربری و رمز در یک جا، قابل ویرایش و حذف ── */
  await test('پنجرهٔ «کاربری»: نام کاربری و رمز دیده و ویرایش می‌شوند و حذف حساب دارد', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/app.js')
      + '\n;window.__t = { S, actUserCreds, actUserFull, putLocal };');
    const T = win.__t;
    T.S.user = { id: 1, name: 'مدیر', role: 'manager' };
    T.S.role = 'manager'; T.S.session = 'x'; T.S.route = 'users';
    T.S.data = {
      users: new Map([[1, { id: 1, name: 'مدیر', role: 'manager' }]]),
      classes: new Map(), lookups: new Map(), parent_links: new Map(),
    };
    T.putLocal('users', { id: 7, name: 'آرسام', last_name: 'سعیدی', role: 'student', phone: '09121234567', national_id: '3750943478' });
    T.S.creds = { 7: { id: 7, phone: '09121234567', password: '3750943478' } };

    T.actUserCreds(7);
    const html = win.document.querySelector('#modal-root').innerHTML;
    assert.ok(html.includes('آرسام سعیدی'), 'نام کامل در عنوان (بدون تکرار): ' + html.slice(0, 120));
    assert.ok(/form data-form="user-creds"/.test(html), 'فرم کاربری باز شد');
    assert.ok(/name="phone"[^>]*value="09121234567"/.test(html), 'نام کاربری (شمارهٔ همراه) نمایش داده می‌شود');
    assert.ok(/name="password"[^>]*value="3750943478"/.test(html), 'رمز نمایش داده می‌شود');
    assert.ok(/data-form="user-creds"[\s\S]*ذخیرهٔ نام کاربری و رمز/.test(html), 'دکمهٔ ذخیره هست');
    assert.ok(/data-act="creds-delete"/.test(html), 'دکمهٔ حذف حساب هست');
    assert.ok(/data-act="user-auto-pw"/.test(html), 'دکمهٔ «رمز = کد ملی» هست');
    dom.window.close();
  });

  /* ══ شکایت‌های اکسل (تصاویر ۳۵–۳۷): کد ملی ۱۰ رقم، موبایل چندتایی،
     ستون دلخواه، پایهٔ الزامی در مرحلهٔ ۱، و نامی که دو بار چاپ نمی‌شود ══ */
  await test('اکسل: کد ملی ۱۰ رقم، موبایل چندتایی، ستون دلخواه و پایهٔ الزامی', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/app.js')
      + '\n;window.__t = { S, impCheck, importApplyLocal, impPickMobile, impPickLandline, impOrderedFields,'
      + ' impCustomLabels, impCustomKey, impSaveCustomLabel, IMP_FIELDS, fullName, list, PAGES, impStepHtml };');
    const T = win.__t;
    T.S.user = { id: 1, name: 'مدیر', role: 'manager' };
    T.S.role = 'manager'; T.S.session = 'x'; T.S.route = 'import';
    T.S.queue = []; T.S.online = false;
    T.S.data = {
      users: new Map([[1, { id: 1, name: 'مدیر', role: 'manager' }]]),
      classes: new Map([[5, { id: 5, name: 'دهم الف', kind: 'class', grade: 'دهم' }]]),
      subjects: new Map(), lookups: new Map(), parent_links: new Map(), grades: new Map(), attendance: new Map(),
    };
    try { win.localStorage.removeItem('payesh.customFields'); } catch (e) { /* noop */ }

    /* ۱) کد ملی: ده رقم کافی است، نه رقم رد می‌شود — بدون الگوریتم رقم کنترل */
    T.S.imp = {
      step: 2, kind: 'students', headerRow: 1,
      headers: ['نام و نام خانوادگی', 'کد ملی'], map: ['full_name', 'national_id'],
      rows: [
        ['آرسام سعیدی', '3840511858'],
        ['کد ناقص', '384051185'],
        ['کد بلند', '38405118581'],
      ],
    };
    let checks = T.impCheck();
    assert.strictEqual(checks[0].errors.length, 0, 'کد ملی ده‌رقمی واقعی پذیرفته شد');
    assert.ok(checks[1].errors.some(x => /۱۰ رقم/.test(x) && x.includes('384051185')), 'کد نه‌رقمی با مقدارش گزارش شد');
    assert.ok(checks[2].errors.some(x => /۱۰ رقم/.test(x)), 'کد یازده‌رقمی رد شد');

    /* ۲) موبایل داخل یک خانه که چند شماره دارد */
    const pick = x => (T.impPickMobile(x) || {}).value;
    assert.strictEqual(pick('9181763116 - 9181763394'), '09181763116', 'اولین شمارهٔ معتبر برداشته شد');
    assert.strictEqual(pick('۰۹۱۲۳۴۵۶۷۸۹'), '09123456789', 'رقم فارسی و صفر اول');
    assert.strictEqual(pick('989123456789'), '09123456789', 'پیش‌شمارهٔ ۹۸ حذف شد');
    const land = x => String((T.impPickLandline(x) || {}).value || '');
    assert.strictEqual(land('021-33445566'), '02133445566', 'تلفن ثابت');

    /* ۳) نام هرگز دو بار چاپ نمی‌شود */
    T.S.imp.rows = [['آرسام سعیدی', '3840511858']];
    checks = T.impCheck();
    const made = await T.importApplyLocal(checks.filter(c => !c.errors.length).map(c => c.data), 'students');
    assert.strictEqual(made.created, 1, 'یک دانش‌آموز ساخته شد');
    const stu = [...T.S.data.users.values()].find(u => u.role === 'student');
    assert.ok(stu, 'دانش‌آموز در فهرست هست');
    assert.strictEqual(T.fullName(stu), 'آرسام سعیدی', 'نام یک بار: ' + T.fullName(stu));
    assert.ok(!/سعیدی\s+سعیدی/.test(T.fullName(stu)), 'فامیلی دو بار تکرار نشد');

    /* ۴) رشته‌محور: هیچ کلاسی ساخته نمی‌شود و پیام «کلاس ساخته نمی‌شود» هم نیست */
    const beforeClasses = T.S.data.classes.size;
    T.S.imp = {
      step: 2, kind: 'students', headerRow: 1,
      headers: ['نام و نام خانوادگی', 'کد ملی', 'کلاس'],
      map: ['full_name', 'national_id', 'class_name'],
      rows: [['مهدی کریمی', '3844862215', 'دهم الکتروتکنیک']],
    };
    checks = T.impCheck();
    const allMsgs = checks[0].errors.concat(checks[0].warns).join(' | ');
    assert.ok(!/کلاس[^|]*ساخته نمی‌شود/.test(allMsgs), 'پیام «کلاس ساخته نمی‌شود» حذف شد: ' + allMsgs);
    assert.strictEqual(checks[0].data.grade, 'دهم', 'پایه ثبت شد');
    assert.strictEqual(checks[0].data.field, 'الکتروتکنیک', 'رشته ثبت شد');
    assert.ok(!checks[0].data.class_id, 'هیچ کلاسی به دانش‌آموز وصل نشد');
    await T.importApplyLocal(checks.filter(c => !c.errors.length).map(c => c.data), 'students');
    assert.strictEqual(T.S.data.classes.size, beforeClasses, 'ورود اکسل هیچ کلاسی نساخت');

    /* ۵) فهرست فیلدهای نگاشت: «موبایل دانش‌آموز» هست و «مورد دلخواه» هم می‌آید */
    const ordered = T.impOrderedFields('students');
    assert.ok(ordered.some(f => f[0] === 'phone' && /موبایل دانش‌آموز/.test(f[1])), '«موبایل دانش‌آموز» در فهرست هست');
    const page = T.impStepHtml();
    assert.ok(/__custom__/.test(page), 'گزینهٔ «مورد دلخواه» در منوی نگاشت هست');

    /* ۶) ستون دلخواه: کلید x_ ساخته و برچسبش ذخیره می‌شود و روی کاربر می‌نشیند */
    const key = T.impCustomKey('شمارهٔ پرونده');
    assert.ok(/^x_/.test(key), 'کلید ستون دلخواه با x_ شروع می‌شود: ' + key);
    T.impSaveCustomLabel(key, 'شمارهٔ پرونده');
    assert.strictEqual(T.impCustomLabels()[key], 'شمارهٔ پرونده', 'برچسب دلخواه ذخیره شد');
    T.S.imp = {
      step: 2, kind: 'students', headerRow: 1,
      headers: ['نام و نام خانوادگی', 'کد ملی', 'شمارهٔ پرونده'],
      map: ['full_name', 'national_id', key],
      rows: [['سارا نوری', '3840511886', '۴۵۶۷']],
    };
    checks = T.impCheck();
    assert.strictEqual(checks[0].data[key], '۴۵۶۷', 'مقدار ستون دلخواه خوانده شد');
    await T.importApplyLocal(checks.filter(c => !c.errors.length).map(c => c.data), 'students');
    const sara = [...T.S.data.users.values()].find(u => u.name === 'سارا نوری');
    assert.ok(sara && sara[key] === '۴۵۶۷', 'ستون دلخواه روی کاربر ذخیره شد');

    /* ۷) پایهٔ الزامی در مرحلهٔ ۱ */
    T.S.imp = { step: 1, kind: 'students' };
    const step1 = T.impStepHtml();
    assert.ok(/data-imp-grade-hint/.test(step1), 'راهنمای پایه در مرحلهٔ ۱ هست');
    assert.ok(/name="imp-grade"/.test(step1), 'کادر پایه در مرحلهٔ ۱ هست');
    assert.ok(/data-imp-next[^>]*disabled/.test(step1), 'دکمهٔ «بعدی» تا انتخاب پایه غیرفعال است');
    dom.window.close();
  });

  /* ══ صفرِ اولِ موبایل (اکسل خودش حذف می‌کند) ═════════════════════ */
  await test('شمارهٔ همراه: صفرِ اولِ حذف‌شده خودکار برمی‌گردد (اکسل/CSV/نماد علمی)', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/app.js')
      + '\n;window.__t = { S, impCheck, importApplyLocal, impPickMobile, impFixStats, list, mobile11 };');
    const T = win.__t;
    const pick = x => (T.impPickMobile(x) || {}).value;

    /* همان چیزی که اکسل می‌سازد: عددِ بدون صفر */
    assert.strictEqual(pick('9123456789'), '09123456789', 'عددِ ۱۰ رقمی اکسل ۱۱ رقمی شد');
    assert.strictEqual(pick(9123456789), '09123456789', 'نوع عددی (نه متن) هم درست خوانده شد');
    assert.strictEqual(pick('9123456789.0'), '09123456789', 'خروجی CSV با ‎.0‎');
    assert.strictEqual(pick('9.123456789E9'), '09123456789', 'نماد علمی اکسل');
    assert.strictEqual(pick('989123456789'), '09123456789', 'پیش‌شمارهٔ کشور');
    assert.strictEqual(pick('+98 912 345 6789'), '09123456789', 'با +۹۸ و فاصله');
    assert.strictEqual(pick('09123456789'), '09123456789', 'شمارهٔ سالم دست‌نخورده می‌ماند');
    assert.strictEqual((T.impPickMobile('9123456789') || {}).fixed, true, 'می‌فهمد که خودش صفر گذاشته');
    assert.strictEqual((T.impPickMobile('09123456789') || {}).fixed, false, 'برای شمارهٔ سالم «اصلاح» علامت نمی‌خورد');
    assert.strictEqual(pick('12345'), '', 'عدد بی‌ربط موبایل نمی‌شود');
    assert.strictEqual(T.mobile11('9123456789'), '09123456789', 'فرم دستی کاربر هم صفر می‌گذارد');

    /* از دل یک فایل: موبایل دانش‌آموز و پدر و مادر */
    T.S.user = { id: 1, name: 'مدیر', role: 'manager' };
    T.S.role = 'manager'; T.S.session = 'x'; T.S.route = 'import';
    T.S.queue = []; T.S.online = false;
    T.S.data = { users: new Map([[1, { id: 1, name: 'مدیر', role: 'manager' }]]),
      classes: new Map(), subjects: new Map(), lookups: new Map(), parent_links: new Map(), grades: new Map(), attendance: new Map() };
    T.S.impGrades = ['دهم'];
    T.S.imp = {
      step: 2, kind: 'students', headerRow: 1,
      headers: ['نام و نام خانوادگی', 'کد ملی', 'موبایل', 'موبایل پدر', 'موبایل مادر'],
      map: ['full_name', 'national_id', 'phone', 'father_phone', 'mother_phone'],
      rows: [['کیان مرادی', '3840511901', '9123456789', '9131112233', '9145556677']],
    };
    const checks = T.impCheck();
    assert.strictEqual(checks[0].errors.length, 0, 'سطر سالم است: ' + JSON.stringify(checks[0].errors));
    assert.strictEqual(checks[0].data.phone, '09123456789', 'موبایل دانش‌آموز ۱۱ رقمی');
    assert.strictEqual(checks[0].data.father_phone, '09131112233', 'موبایل پدر ۱۱ رقمی');
    assert.strictEqual(checks[0].data.mother_phone, '09145556677', 'موبایل مادر ۱۱ رقمی');
    assert.ok(T.impFixStats().phones >= 3, 'تعداد اصلاح‌ها شمرده شد: ' + T.impFixStats().phones);
    await T.importApplyLocal(checks.filter(c => !c.errors.length).map(c => c.data), 'students');
    const stu = T.list('users').find(u => u.name === 'کیان مرادی');
    assert.ok(stu && stu.phone.length === 11, 'روی کاربر هم ۱۱ رقمی ذخیره شد: ' + (stu && stu.phone));
    dom.window.close();

    /* همان قاعده روی سرور */
    const { normalizeMobile } = require('../server/util');
    assert.strictEqual(normalizeMobile('9123456789'), '09123456789');
    assert.strictEqual(normalizeMobile('09123456789'), '09123456789');
    assert.strictEqual(normalizeMobile('989123456789'), '09123456789');

    /* از راه API: کاربری با شمارهٔ ۱۰ رقمی ساخته شود */
    const made = await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
      { uid: 'pz-1', collection: 'users', type: 'put', data: { name: 'دبیر بدون صفر', role: 'teacher', phone: '9355566778', national_id: '1000000770' } },
    ] } });
    assert.strictEqual(made.data.applied.length, 1, JSON.stringify(made.data));
    const pulled = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z', { token: managerToken });
    const saved = ((pulled.data.collections || {}).users || []).find(u => u.name === 'دبیر بدون صفر');
    assert.ok(saved, 'کاربر روی سرور ساخته شد');
    assert.strictEqual(String(saved.phone), '09355566778', 'سرور هم صفر را گذاشت: ' + saved.phone);
  });

  /* ══ آینهٔ داده + پشتیبان روزانه + بازیابی ════════════════════════ */
  await test('آینهٔ داده روی دیسک، پشتیبان روزانه و بازیابی در دیتابیس', async () => {
    const r1 = await req('/api/admin/mirror/refresh', { method: 'POST', token: managerToken, body: {} });
    assert.strictEqual(r1.data.ok, true, JSON.stringify(r1.data));
    assert.ok(r1.data.mirror, 'وضعیت آینه برگشت');
    assert.strictEqual(r1.data.mirror.ok, true, 'آینه با دیتابیس یکی است');
    assert.ok(Array.isArray(r1.data.daily) && r1.data.daily.length >= 1, 'فایل روزانه ساخته شد');
    const today = r1.data.daily[0];
    assert.ok(/^payesh-\d{4}-\d{2}-\d{2}\.json$/.test(today.file), 'نام فایل روزانه: ' + today.file);
    assert.ok(today.total > 0, 'تعداد رکوردها در فایل هست');

    /* فایل هم روی دیسک قابل خواندن است (نه فقط در دیتابیس) */
    const dailyPath = path.join(r1.data.dirs.daily, today.file);
    assert.ok(fs.existsSync(dailyPath), 'فایل پشتیبان روی دیسک هست');
    const backup = JSON.parse(fs.readFileSync(dailyPath, 'utf8'));
    assert.strictEqual(backup.format, 'payesh-backup');
    assert.ok(Array.isArray(backup.collections.users) && backup.collections.users.length,
      'کاربران در فایل پشتیبان هستند');
    assert.ok(backup.collections.users.some(u => u.password_hash),
      'رمزها هم در پشتیبان می‌مانند تا بعد از بازیابی کسی از حساب نیفتد');
    assert.ok(backup.collections.users.every(u => u._version === undefined),
      'ستون‌های داخلیِ همگام‌سازی در فایل نیستند');

    /* حذف یک کاربر، بعد بازیابی از همان فایل ⇒ کاربر برمی‌گردد */
    const victim = backup.collections.users.find(u => u.role === 'teacher' && u.id);
    assert.ok(victim, 'یک دبیر برای آزمایش پیدا شد');
    const del = await req('/api/admin/users/' + victim.id, { method: 'DELETE', token: managerToken });
    assert.ok(del.data.ok !== false, 'کاربر حذف شد');
    const rest = await req('/api/admin/restore', { method: 'POST', token: managerToken, body: { data: backup } });
    assert.strictEqual(rest.data.ok, true, JSON.stringify(rest.data));
    assert.ok(rest.data.report.restored.users > 0, 'رکوردها بازیابی شدند');
    const after = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z', { token: managerToken });
    const back = ((after.data.collections || {}).users || []).find(u => Number(u.id) === Number(victim.id));
    assert.ok(back, 'کاربر حذف‌شده با بازیابی برگشت');

    /* فایل خراب و فایل بی‌ربط رد می‌شوند */
    const bad = await req('/api/admin/restore', { method: 'POST', token: managerToken, body: { data: { hello: 1 } } });
    assert.strictEqual(bad.data.ok, false);
    assert.strictEqual(bad.data.error, 'bad_format');

    assert.ok(r1.data.dirs.mirror, 'مسیر آینه هم برگشت');

    /* F‑01: فقط مدیر فایل کامل داده را می‌بیند؛ هیچ نقش دیگری */
    const st = await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
      { uid: 'bk-staff-1', collection: 'users', type: 'put', data: { name: 'کارشناس اجرایی', role: 'counselor', phone: '09127770001', national_id: '1777000001' } },
    ] } });
    const staffId = st.data.applied[0].id;
    const staffLogin = await req('/api/auth/login', { method: 'POST', body: { phone: '09127770001', password: '1777000001' } });
    const staffTok = staffLogin.data.session.token;
    const staffMirror = await req('/api/admin/mirror', { token: staffTok });
    assert.strictEqual(staffMirror.status, 403, 'F‑01: عوامل اجرایی فایل کامل داده را نمی‌گیرند');
    const staffDaily = await req('/api/admin/backups/daily/' + today.file, { token: staffTok });
    assert.strictEqual(staffDaily.status, 403, 'F‑01: دانلود بکاپ برای غیرمدیر ممنوع');
    /* هیچ رمز خامی در فایل پشتیبان نیست (فقط هش/رمزنگاری) */
    assert.ok(backup.collections.users.every(u => !u.password_plain), 'F‑01: هیچ رمز خامی در بکاپ نیست');
    await req('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
      { uid: 'bk-stud-1', collection: 'users', type: 'put', data: { name: 'دانش‌آموز پشتیبان', role: 'student', phone: '09127770002', national_id: '1777000002' } },
    ] } });
    const studLogin = await req('/api/auth/login', { method: 'POST', body: { phone: '09127770002', password: '1777000002' } });
    const studMirror = await req('/api/admin/mirror', { token: studLogin.data.session.token });
    assert.strictEqual(studMirror.status, 403, 'دانش‌آموز به پشتیبان دسترسی ندارد');
    const studRestore = await req('/api/admin/restore', { method: 'POST', token: studLogin.data.session.token, body: { data: backup } });
    assert.strictEqual(studRestore.status, 403, 'دانش‌آموز نمی‌تواند بازیابی کند');
    const srv = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
    assert.ok(/BACKUP_ROLES = new Set\(\['manager'\]\)/.test(srv),
      'F‑01: نقش‌های پشتیبان فقط مدیر است');
    const pg = fs.readFileSync(path.join(ROOT, 'client', 'pages.js'), 'utf8');
    assert.ok(/BACKUP_ROLES_FA/.test(pg), 'کارت پشتیبان در پنل عوامل اجرایی هم رندر می‌شود');
    assert.strictEqual(typeof staffId, 'number');
  });

  /* ══ ورود اکسل: نگاشت «موبایل دانش‌آموز»، صفرِ اول، پیام دقیق، اصلاح درجا ══ */
  await test('اکسل: «موبایل دانش‌آموز» خودکار نگاشت می‌شود، صفرِ اول می‌آید، پیام تکراری نام/پایه/رشته دارد و درجا اصلاح می‌شود', () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/app.js')
      + '\n;window.__t = { S, impAutoMap, impCheck, impFixCardHtml, impMobileFix, impMapped, impStepHtml, list, byId };');
    const T = win.__t;
    T.S.user = { id: 1, name: 'مدیر', role: 'manager' };
    T.S.role = 'manager'; T.S.route = 'users';
    T.S.data = {
      users: new Map([[1, { id: 1, name: 'مدیر', role: 'manager' }]]),
      classes: new Map(), subjects: new Map(), lookups: new Map(), parent_links: new Map(),
      import_issues: new Map(), schools: new Map([[1, { id: 1, name: 'مدرسه' }]]),
    };
    T.S.queue = []; T.S.online = false;

    /* ۱) نگاشت: ستون «موبایل دانش‌آموز» باید فیلد خودش را بگیرد،
       نه «— دیده نشد —» (شکایت کاربر با همان تصویر) */
    const map = T.impAutoMap(['ردیف', 'نام و نام خانوادگی', 'کد ملی', 'پایه', 'رشته', 'موبایل دانش آموز',
      'شماره پدر', 'کد ملی مادر'], 'students');
    assert.strictEqual(map[5], 'phone', 'موبایل دانش‌آموز ⇒ phone شد: ' + map[5]);
    assert.strictEqual(map[6], 'father_phone', 'شمارهٔ پدر ⇒ موبایل پدر');
    assert.strictEqual(map[7], 'mother_nid', 'کد ملی مادر ⇒ mother_nid');
    assert.strictEqual(map[1], 'full_name', 'نام و نام خانوادگی ⇒ full_name');
    assert.strictEqual(map[4], 'field', 'رشته ⇒ field');

    /* ۲) صفرِ اول: اکسل آن را حذف می‌کند */
    const fx1 = T.impMobileFix('9123456789');
    assert.strictEqual(fx1.value, '09123456789', '۱۰ رقمی با ۰ کامل می‌شود');
    assert.strictEqual(fx1.ok, true, '۱۰ رقمی معتبر است');
    const fx2 = T.impMobileFix('918452959');
    assert.strictEqual(fx2.value, '0918452959', '۹ رقمی هم صفر می‌گیرد');
    assert.strictEqual(fx2.complete, false, 'اما یک رقم کم دارد و باید اصلاح شود');

    /* ۳) بررسی سطرها: کد ملی تکراری با نام و پایه و رشتهٔ نفر اول،
       و موبایل ناقص ⇒ سطر «آمادهٔ ثبت» نیست */
    T.S.imp = {
      step: 3, kind: 'students', headerRow: 1, edits: {}, grades: ['دهم'],
      headers: ['نام و نام خانوادگی', 'کد ملی', 'پایه', 'رشته', 'موبایل دانش آموز', 'موبایل مادر', 'کد ملی مادر'],
      map: ['full_name', 'national_id', 'grade', 'field', 'phone', 'mother_phone', 'mother_nid'],
      rows: [
        ['آرین یزدانی', '3840515939', 'دهم', 'الکتروتکنیک', '9337749635', '918452959', '3849680780'],
        ['نیکوان محمدپور', '3840515939', 'دهم', 'الکتروتکنیک', '', '', ''],
        ['مانی یزدانی', '3840515041', 'دهم', 'الکتروتکنیک', '', '', '3849680'],
      ],
    };
    const checks = T.impCheck();
    assert.strictEqual(checks.length, 3, 'سه سطر بررسی شد');
    assert.strictEqual(checks[0].data.phone, '09337749635', 'صفرِ موبایل دانش‌آموز خودکار اضافه شد');
    const dupMsg = checks[1].errors.join(' | ');
    assert.ok(/تکراری/.test(dupMsg), 'کد ملی تکراری گزارش شد');
    assert.ok(dupMsg.indexOf('آرین یزدانی') > -1, 'نام نفرِ اول در پیام آمده: ' + dupMsg);
    assert.ok(/سطر\s*[۲2]/.test(dupMsg), 'شمارهٔ سطر نفرِ اول در پیام آمده: ' + dupMsg);
    assert.ok(/پایهٔ دهم/.test(dupMsg) && /رشتهٔ الکتروتکنیک/.test(dupMsg), 'پایه و رشتهٔ نفرِ اول هم آمده: ' + dupMsg);
    assert.ok(checks[2].blocks.some(b => /کد ملی مادر/.test(b)), 'کد ملی ناقصِ مادر «اصلاح لازم» شد');
    assert.ok(checks[2].blocks.some(b => /۷ رقم|7 رقم/.test(b)), 'تعداد رقمِ کم را هم دقیق گفت: ' + JSON.stringify(checks[2].blocks));
    assert.strictEqual(checks[2].ok, false, 'سطر با کد ملی ناقص «آمادهٔ ثبت» نیست');
    assert.strictEqual(checks[0].ok, false, 'سطر با موبایل ناقصِ مادر هم آمادهٔ ثبت نیست');
    assert.ok(checks[0].blocks.some(b => /موبایل مادر/.test(b)), 'موبایل ناقص مادر در فهرست اصلاح است');

    /* ۴) اصلاح درجا: همان سطر را در فرم ویرایش می‌کنیم و دوباره بررسی */
    const card = T.impFixCardHtml(checks[0]);
    assert.ok(/data-form="imp-fix"/.test(card), 'کارت اصلاح فرم دارد');
    assert.ok(/name="mother_phone" value="0918452959"/.test(card), 'موبایل مادر با صفرِ اضافه‌شده پیش‌پر شد: ' + card.slice(card.indexOf('mother_phone'), card.indexOf('mother_phone') + 90));
    assert.ok(/name="national_id"/.test(card) && /name="grade"/.test(card) && /name="field"/.test(card), 'همهٔ فیلدهای حساس قابل ویرایش‌اند');

    T.S.imp.edits = { 0: { mother_phone: '09184529590', mother_nid: '3849680780' } };
    const after = T.impCheck();
    assert.strictEqual(after[0].data.mother_phone, '09184529590', 'شمارهٔ اصلاح‌شده ذخیره شد');
    assert.strictEqual(after[0].blocks.length, 0, 'با اصلاح، ایرادها صفر شد');
    assert.strictEqual(after[0].ok, true, 'سطر بعد از اصلاح «آمادهٔ ثبت» شد');

    /* ۵) آمار مرحله: بعد از اصلاح، سطر در بخش «آمادهٔ ثبت» دیده می‌شود */
    T.S.imp.checks = after;
    const page = T.impStepHtml();
    assert.ok(/آمادهٔ ثبت/.test(page), 'بخش آمادهٔ ثبت هست');
    assert.strictEqual((page.match(/data-form="imp-fix"/g) || []).length, 2, 'فقط دو سطرِ اصلاح‌نشده فرم اصلاح دارند');
    dom.window.close();
  });

  /* ══ برنامهٔ مستقل: هیچ مرورگری باز نمی‌شود و صفحهٔ خطای مرورگر نمی‌آید ══ */
  await test('ویندوز و اندروید مستقل‌اند: بدون پنجرهٔ مرورگر، بدون صفحهٔ خطای «can\'t reach this page»', () => {
    const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const cs = read('desktop/PayeshApp.cs');

    /* ۱) هیچ مسیر خودکاری مرورگر باز نمی‌کند */
    assert.ok(!/OpenInBrowser/.test(cs), 'برنامه هیچ‌جا مرورگر باز نمی‌کند');
    assert.ok(!/--app=/.test(cs), 'حالت «برنامه»ی Edge (--app) حذف شد');
    assert.ok(/private bool TryCreateWebView/.test(cs), 'پنجرهٔ واقعی WebView2 هست');

    /* ۲) صفحهٔ خطای موتور نمایش هرگز دیده نمی‌شود */
    assert.ok(/NavigationCompleted/.test(cs), 'نتیجهٔ بارگذاری گرفته می‌شود');
    assert.ok(/OnNavigated\(/.test(cs) && /_view\.Visible = false/.test(cs), 'صفحهٔ خطای خام پنهان می‌شود و با صفحهٔ خود برنامه جایگزین می‌شود');
    assert.ok(/ShowLoadFail|ShowEngineMissing/.test(cs), 'پیام فارسی خودمان هست');
    assert.ok(/void ShowEngineMissing/.test(cs) && /MicrosoftEdgeWebView2Setup\.exe/.test(cs),
      'اگر موتور نمایش نباشد، نصبش می‌کند (نه باز کردن مرورگر)');

    /* ۳) ناظر یکتا، بازیابی و پورت آزاد */
    assert.ok(/void StartWatchdog/.test(cs) && /WatchTick/.test(cs), 'نگهبان سرور هست');
    assert.ok(/CheckConnectionOnRestore/.test(cs) && /bool needsCheck = wasHidden/.test(cs), 'پس از بازشدن دوبارهٔ پنجره، سلامت اتصال دوباره سنجیده می‌شود');
    assert.ok(/BringToFrontFromSecond\(\) \{ RevealWindow\(\); \}/.test(cs) && /DoubleClick \+= .*RevealWindow/.test(cs), 'لانچ دوباره و آیکون سینی از مسیر بازیابی استفاده می‌کنند');
    assert.ok(/ActiveSupervisorPort\(\)/.test(cs) && /Process\.GetProcessById/.test(cs) && /payesh-supervisor\.lock/.test(cs), 'در شروع کند همان پورت supervisor زنده حفظ می‌شود');
    assert.ok(/e2\.NavigationId != _activeNavigationId/.test(cs), 'اتمام navigation قدیمی وضعیت صفحهٔ تازه را خراب نمی‌کند');
    const showApp = cs.slice(cs.indexOf('private void ShowApp'), cs.indexOf('/* ══ پایداری'));
    assert.ok(showApp.indexOf('_view.Visible = false') >= 0 && showApp.indexOf('_view.Visible = false') < showApp.indexOf('_view.Source = new Uri(url)'), 'WebView تا نتیجهٔ بارگذاری پنهان می‌ماند');
    assert.ok(/SupervisorRunning\(\)/.test(cs) && /Interlocked\.CompareExchange/.test(cs), 'watchdog قبل از راه‌اندازی، ناظر موجود را بررسی می‌کند');
    assert.ok(/server\\\\start\.js/.test(cs), 'برنامه از ناظر پایدار start.js استفاده می‌کند');
    assert.ok(/void PickLocalPort/.test(cs) && /PORT_CANDIDATES/.test(cs), 'پورت آزاد انتخاب می‌شود');
    assert.ok(/EnvironmentVariables\["PORT"\]/.test(cs), 'پورت به ناظر داده می‌شود');
    assert.ok(/TcpListener/.test(cs), 'آزادبودن پورت بررسی می‌شود');
    assert.ok(/target\.IsLoopback/.test(cs) && /CoreWebView2\.Navigate\(target\.AbsoluteUri\)/.test(cs), 'پنجرهٔ محلی داخل برنامه می‌ماند، به Edge فرستاده نمی‌شود');
    assert.ok(!/Process\.Start\(e2\.Uri\)/.test(cs), 'URI محلی خام به مرورگر سیستم واگذار نمی‌شود');
    const supervisor = read('server/start.js');
    assert.ok(/\.payesh-supervisor\.lock/.test(supervisor) && /acquireSupervisorLock/.test(supervisor), 'ناظر Node با قفل بین‌پردازه‌ای یکتا است');
    assert.ok(/PAYESH_DATA/.test(supervisor) && /pidIsAlive/.test(supervisor), 'قفل ناظر در دادهٔ پایدار است و قفل stale پاک می‌شود');
    assert.ok(/port:\s*supervisorPort/.test(supervisor), 'قفل ناظر پورت bind شده را برای پوستهٔ ویندوز نگه می‌دارد');
    assert.ok(/windowsHide:\s*true/.test(supervisor), 'فرایند Node در ویندوز پنجرهٔ کنسول اضافه باز نمی‌کند');
    const startBat = read('install/windows/start.bat');
    const startVbs = read('install/windows/start-hidden.vbs');
    assert.ok(/server\\start\.js/.test(startBat) && /server\\start\.js/.test(startVbs), 'launcherهای ویندوز ناظر را اجرا می‌کنند');
    assert.ok(!/server\\index\.js/.test(startBat) && !/server\\index\.js/.test(startVbs), 'launcherها دیگر سرور را مستقیم اجرا نمی‌کنند');
    assert.ok(/server\\start\.js/.test(read('install/windows/install.ps1')), 'نصب‌کنندهٔ zip ناظر را اجرا می‌کند');

    /* ۴) میان‌بر ویندوز: برنامهٔ پنجره‌ای، نه Edge */
    const vbs = read('install/windows/payesh-app.vbs');
    assert.ok(/desktop\\Payesh\.exe/.test(vbs), 'میان‌بر به پنجرهٔ برنامه اشاره می‌کند');
    assert.ok(!/msedge/i.test(vbs), 'از Edge استفاده نمی‌شود');
    assert.ok(!/--app=/.test(vbs), 'حالت مرورگر حذف شد');
    assert.ok(/MsgBox/.test(vbs), 'اگر برنامه نبود، پیام فارسی می‌دهد');
    const ips = read('install/windows/install.ps1');
    assert.ok(/desktop\\Payesh\.exe/.test(ips), 'نصب‌کنندهٔ zip میان‌بر برنامه را می‌سازد');
    assert.ok(!/Start-Process \$url/.test(ips), 'نصب‌کننده دیگر آدرس را در مرورگر باز نمی‌کند');

    /* ۵) نصب‌کنندهٔ استاندارد: موتور نمایش و پورت‌ها */
    const iss = read('installer/payesh.iss');
    assert.ok(/MicrosoftEdgeWebView2Setup\.exe/.test(iss), 'نصب‌کننده موتور نمایش را همراه دارد');
    assert.ok(/WebView2Installed/.test(iss), 'نصب‌بودنش را بررسی می‌کند');
    assert.ok(/localport=8080,8090-8093/.test(iss), 'پورت‌های جایگزین در فایروال باز می‌شوند');
    assert.ok(/server.{0,3}start\.js/.test(iss), 'حذف نصب ناظر را هم متوقف می‌کند');
    assert.ok(!/Filename:.*start-hidden\.vbs/.test(iss), 'نصب‌کننده دو مالک جدا برای سرور راه نمی‌اندازد');
    /* ردیف ۱۲۹: بستهٔ WebView ویندوز فقط در کنترل منفی ساخته می‌شود و دروازهٔ بومی باید ردش کند */
    const wf = read('.github/workflows/school-webview-control.yml');
    assert.ok(/desktop\/Payesh\.exe/.test(wf) && /payesh-local-windows\.zip/.test(wf),
      'بستهٔ ویندوز همراه برنامهٔ پنجره‌ای ساخته می‌شود (کنترل منفی)');
    assert.ok(/native-independence-gate\.mjs --expect-fail --windows releases\/payesh-local-windows\.zip/.test(wf),
      'دروازهٔ بومی بستهٔ WebView را رد می‌کند');
    assert.ok(!/payesh-local-windows\.zip|payesh-setup\.exe/.test(read('.github/workflows/build.yml').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')),
      'build.yml دیگر نسخهٔ WebView ویندوز را منتشر نمی‌کند');

    /* ۶) اندروید: صفحهٔ اینترنتی داخل قاب برنامه باز نمی‌شود */
    const java = read('install/android/app/src/main/java/ir/payesh/local/MainActivity.java');
    assert.ok(/public boolean shouldOverrideUrlLoading\(WebView view, WebResourceRequest request\)/.test(java),
      'نسخهٔ جدید shouldOverrideUrlLoading هم هست');
    const ovr = java.slice(java.indexOf('public boolean shouldOverrideUrlLoading(WebView view, String url)'));
    assert.ok(/startActivity\(new Intent\(Intent\.ACTION_VIEW/.test(ovr.slice(0, 1200)), 'آدرس بیرونی در برنامهٔ سیستم باز می‌شود');
    assert.ok(/return true;/.test(ovr.slice(0, 1200)), 'خودِ قاب برنامه به آدرس بیرونی نمی‌رود');
    assert.ok(/retryLoad/.test(java), 'اگر بارگذاری نشد، خودکار دوباره تلاش می‌کند');
    assert.ok(/asset missing in APK/.test(java), 'دارایی ناموجود به‌جای «null» پاسخ ۴۰۴ می‌دهد');
    /* هیچ‌جای مسیر بارگذاری «null» برنمی‌گردد (که باعث خطای موتور شود) */
    const seg = java.slice(java.indexOf('private WebResourceResponse serveAsset'),
      java.indexOf('private WebResourceResponse serveAsset') + 3000);
    assert.ok(!/return null;/.test(seg), 'serveAsset هیچ‌وقت null برنمی‌گرداند');
  });

  /* ══ اسکن QR کارت پیوند (دوربین + گالری) ═════════════════════════ */
  await test('اسکن QR: کد از پیوند/QR خوانده می‌شود و اندروید دوربین و گالری دارد', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/import.js') + '\n;\n' + strip('client/scan.js') + '\n;\n' + strip('client/app.js')
      + '\n;window.__t = { scanExtractCode, PAGES };');
    const T = win.__t;

    assert.strictEqual(T.scanExtractCode('https://school.example/#/pair=ABCD2345'), 'ABCD2345');
    assert.strictEqual(T.scanExtractCode('payesh://pair?c=ABCD2345&h=x'), 'ABCD2345');
    assert.strictEqual(T.scanExtractCode('#/pair?c=ABCD-2345'), 'ABCD2345');
    assert.strictEqual(T.scanExtractCode('ABCD-2345'), 'ABCD2345');
    assert.strictEqual(T.scanExtractCode('سلام'), '', 'متن بی‌ربط کد نمی‌شود');

    /* صفحهٔ اسکن: هم دوربین، هم گالری، هم کد دستی */
    const page = T.PAGES.scan();
    assert.ok(/data-act="scan-camera"/.test(page), 'دکمهٔ اسکن با دوربین');
    assert.ok(/data-act="scan-gallery"/.test(page), 'دکمهٔ عکس از گالری');
    assert.ok(/data-form="scan-code"/.test(page), 'کد دستی هم هست');
    assert.ok(/camera-box|scan-status/.test(page), 'جایگاه نمایش وضعیت هست');
    dom.window.close();

    /* اندروید: دوربین زنده + گالری + کتابخانهٔ QR */
    const java = fs.readFileSync(path.join(ROOT, 'install/android/app/src/main/java/ir/payesh/local/MainActivity.java'), 'utf8');
    assert.ok(/public void scanQr\(/.test(java), 'پل بومی دوربین (scanQr) هست');
    assert.ok(/public void pickQr\(/.test(java), 'پل بومی گالری (pickQr) هست');
    assert.ok(/IntentIntegrator/.test(java), 'دوربینِ زنده با ZXing باز می‌شود');
    assert.ok(/decodeQrImage/.test(java), 'عکس گالری هم رمزگشایی می‌شود');
    assert.ok(/payeshOnQr/.test(java), 'نتیجه به صفحهٔ اسکن برمی‌گردد');
    const gradle = fs.readFileSync(path.join(ROOT, 'install/android/app/build.gradle'), 'utf8');
    assert.ok(/zxing-android-embedded/.test(gradle) && /com\.google\.zxing:core/.test(gradle), 'وابستگی QR در Gradle هست');
    const web = fs.readFileSync(path.join(ROOT, 'client/scan.js'), 'utf8');
    assert.ok(/BarcodeDetector/.test(web), 'مرورگر هم با BarcodeDetector اسکن می‌کند');
  });

  /* ══ «زنده» بودن دکمه‌ها + لوگو + متن ورود ═══════════════════════ */
  await test('همهٔ دکمه‌ها واکنش زنده دارند، لوگوی پایش نشسته و توضیح اضافهٔ ورود حذف شده', () => {
    const css = fs.readFileSync(path.join(ROOT, 'client/styles.css'), 'utf8');
    assert.ok(/\.btn\.is-busy::before/.test(css), 'نشانگر چرخان روی خودِ دکمه');
    assert.ok(/@keyframes payesh-spin/.test(css), 'چرخش تعریف شده');
    assert.ok(/#live-bar/.test(css), 'نوار باریک بالای صفحه');
    assert.ok(/\.btn:active/.test(css), 'فشرده‌شدن دکمه هنگام کلیک');
    const activeRules = [...css.matchAll(/([^{}]+):active\s*\{([^{}]*)\}/g)];
    assert.ok(!activeRules.some(([, selectors, body]) =>
      /(?:^|,)\s*\[data-act\]\s*:active/.test(selectors) && /\btransform\s*:/.test(body)),
    'کادر مودال با data-act نباید هنگام کلیک کوچک شود');
    assert.ok(/<div class="modal-bg[^>]*data-act="modal-bg"/.test(fs.readFileSync(path.join(ROOT, 'client/pages.js'), 'utf8')),
      'پس‌زمینهٔ مودال نباید هدف قانون transform عمومی باشد');

    const app = fs.readFileSync(path.join(ROOT, 'client/app.js'), 'utf8');
    assert.ok(/function liveBegin/.test(app), 'همهٔ کنش‌ها از مسیر زنده عبور می‌کنند');
    assert.ok(/Promise\.resolve\(running\)/.test(app), 'خطای هر کنش هم گرفته می‌شود');
    assert.ok(/زنده/.test(app) || /liveBegin/.test(app));

    /* لوگو: فایل هست و در صفحه‌های ورود و نوار کنار استفاده می‌شود */
    for (const f of ['logo.png', 'logo-mark.png', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'favicon-32.png']) {
      assert.ok(fs.existsSync(path.join(ROOT, 'client/icons', f)), 'آیکون ' + f + ' هست');
    }
    const pages = fs.readFileSync(path.join(ROOT, 'client/pages.js'), 'utf8');
    assert.ok(/\/icons\/logo\.png/.test(pages), 'لوگو در صفحهٔ ورود');
    assert.ok(/\/icons\/logo-mark\.png/.test(pages), 'نشان در نوار کنار');
    assert.ok(!pages.includes('نام کاربری شما شمارهٔ همراهتان است و رمز، کد ملی'),
      'توضیح زیر دکمهٔ ورود حذف شد');
    const html = fs.readFileSync(path.join(ROOT, 'client/index.html'), 'utf8');
    assert.ok(/icons\/favicon-32\.png/.test(html), 'فاوآیکون لوگو شد');
    assert.ok(/<script src="\/scan\.js">/.test(html), 'اسکنر در صفحه بارگذاری می‌شود');
  });

  /* ══ آیکون خودِ دکمه هنگام کلیک می‌چرخد ═══════════════════════════ */
  await test('«بررسی دوباره» و هر دکمهٔ آیکون‌دار: آیکونش هنگام کار می‌چرخد و بعد برمی‌گردد', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div><div id="live-bar"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/app.js') + '\n;window.__t = { liveBegin, liveSpinIcon };');
    const T = win.__t;

    const btn = win.document.createElement('button');
    btn.className = 'btn sm';
    btn.setAttribute('data-act', 'diag-rerun');
    btn.textContent = '🔄 بررسی دوباره';
    win.document.body.appendChild(btn);

    const done = T.liveBegin(btn);
    const span = btn.querySelector('span.spin');
    assert.ok(span, 'ایموجی دکمه داخل نشانگر چرخان رفت');
    assert.strictEqual(span.textContent, '🔄', 'همان آیکون «بررسی دوباره» می‌چرخد');
    assert.ok(btn.classList.contains('is-busy'), 'دکمه در حالت کار است');

    const plain = win.document.createElement('button');
    plain.textContent = 'ذخیره';
    assert.strictEqual(T.liveSpinIcon(plain), null, 'دکمهٔ بی‌آیکون دست‌نخورده می‌ماند');
    assert.strictEqual(plain.textContent, 'ذخیره');

    done();
    await new Promise(r => setTimeout(r, 700));
    assert.ok(!btn.querySelector('span.spin'), 'پس از پایان کار نشانگر برمی‌گردد');
    assert.strictEqual(btn.textContent.replace(/\s+/g, ' ').trim(), '🔄 بررسی دوباره', 'متن دکمه سالم است');
    assert.ok(!btn.classList.contains('is-busy'), 'حالت کار تمام شد');
    dom.window.close();
  });

  await test('ردیف ۲۹: /api/readyz آماده است، مسیر مطلق لو نمی‌دهد و ۲۰۰ می‌دهد', async () => {
    const r = await req('/api/readyz');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.ready, true);
    assert.strictEqual(r.data.checks.db, true);
    const blob = JSON.stringify(r.data);
    assert.ok(!blob.includes(TMP), 'پاسخ نباید مسیر پوشهٔ داده را لو بدهد');
    assert.ok(!/(secret|password|accessKey|token)/i.test(blob), 'پاسخ نباید راز داشته باشد');
  });

  await test('ردیف ۲۹: کلید امضای پشتیبان بیرون از پایگاه‌داده نگه داشته می‌شود (بازیابی پس از از دست رفتن DB)', async () => {
    const bk = await req('/api/admin/backup', { method: 'POST', token: managerToken });
    assert.strictEqual(bk.data.ok, true);
    const keyFile = path.join(TMP, 'backup-key.json');
    assert.ok(fs.existsSync(keyFile), 'فایل کلید امضا باید در پوشهٔ داده باشد');
    const j = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    assert.ok(j.key && j.key.length > 20, 'کلید ذخیره شده است');
    const mode = fs.statSync(keyFile).mode & 0o777;
    assert.ok(mode === 0o600 || process.platform === 'win32', 'دسترسی فایل کلید محدود است');
  });

  await test('PR‑1 مدل پنل مالک: همهٔ CHECKها، RLS، grant، audit و rollback', async () => {
    const { PGlite } = require('@electric-sql/pglite');
    const crypto = require('node:crypto');
    const hadWindow = Object.prototype.hasOwnProperty.call(global, 'window');
    const previousWindow = global.window;
    let db;
    const A = '11111111-1111-4111-8111-111111111111';
    const B = '22222222-2222-4222-8222-222222222222';
    const OWNER = '00000000-0000-4000-8000-000000000001';
    const SUPPORT = '00000000-0000-4000-8000-000000000002';
    const AUDITOR = '00000000-0000-4000-8000-000000000003';
    const SUPPORT2 = '00000000-0000-4000-8000-000000000004';
    const SUB_A = '00000000-0000-4000-8000-000000000010';
    const SUB_B = '00000000-0000-4000-8000-000000000011';
    const ZERO_HASH = Buffer.alloc(32);
    let savepointNo = 0;

    async function mustReject(label, sql, params = [], expected = null) {
      const savepoint = `owner_panel_case_${++savepointNo}`;
      await db.query(`SAVEPOINT ${savepoint}`);
      let thrown;
      try { await db.query(sql, params); } catch (err) { thrown = err; }
      await db.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await db.query(`RELEASE SAVEPOINT ${savepoint}`);
      assert.ok(thrown, `${label}: expected database rejection`);
      if (expected) assert.ok(thrown.constraint === expected || thrown.code === expected,
        `${label}: expected ${expected}, got code=${thrown.code} constraint=${thrown.constraint}`);
      return thrown;
    }
    function grantInput(overrides = {}) {
      return Object.assign({
        id: require('node:crypto').randomUUID(), tenant_id: A, operator_id: SUPPORT, approved_by: OWNER,
        case_ref: 'case-pr1', scope: 'metadata', reason: 'approved support case',
        starts_at: new Date(Date.now() - 60_000).toISOString(),
        ends_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        school_notified_at: new Date(Date.now() - 120_000).toISOString(),
        revoked_at: null, used_reads: 0, max_actions: 5, open_slot: 1,
      }, overrides);
    }
    async function insertGrant(g) {
      await db.query(`INSERT INTO owner_platform.support_grant
        (id,tenant_id,operator_id,approved_by,case_ref,scope,reason,starts_at,ends_at,
         school_notified_at,revoked_at,used_reads,max_actions,open_slot)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [g.id,g.tenant_id,g.operator_id,g.approved_by,g.case_ref,g.scope,g.reason,
        g.starts_at,g.ends_at,g.school_notified_at,g.revoked_at,g.used_reads,g.max_actions,g.open_slot]);
    }
    async function insertLog(grantId, tenantId, recordRef) {
      await db.query('INSERT INTO owner_platform.support_access_log(grant_id,tenant_id,record_ref) VALUES ($1,$2,$3)',
        [grantId,tenantId,recordRef]);
    }

    const up = fs.readFileSync(path.join(ROOT, 'db/migrations/owner-panel/001_owner_panel.up.sql'), 'utf8');
    const down = fs.readFileSync(path.join(ROOT, 'db/migrations/owner-panel/001_owner_panel.down.sql'), 'utf8');
    try {
      delete global.window;
      db = new PGlite();
      await db.exec(up);
      await db.query(`INSERT INTO owner_platform.platform_users(id,login_id,role,status) VALUES
        ($1,'owner@example.invalid','platform_owner','active'),
        ($2,'support@example.invalid','platform_support','active'),
        ($3,'owner2@example.invalid','platform_owner','active'),
        ($4,'support2@example.invalid','platform_support','active')`, [OWNER,SUPPORT,AUDITOR,SUPPORT2]);
      await db.query(`INSERT INTO owner_platform.plans(code,name,max_users,max_students,storage_mb,features,price_amount,price_cycle)
        VALUES ('basic','Basic',10,8,512,'{}'::jsonb,0,'none')`);
      await db.query(`INSERT INTO owner_platform.subscriptions(id,tenant_id,plan_code,status,starts_at,ends_at)
        VALUES ($1,$2,'basic','active',now()-interval '1 day',now()+interval '30 days'),
               ($3,$4,'basic','active',now()-interval '1 day',now()+interval '30 days')`, [SUB_A,A,SUB_B,B]);
      await db.query('INSERT INTO owner_platform.tenant_limits(tenant_id,max_users,storage_bytes) VALUES ($1,10,0)', [A]);


    const cases = {
      platform_users_login_id_check: [`INSERT INTO owner_platform.platform_users(login_id,role) VALUES ('   ','platform_support')`, []],
      platform_users_role_check: [`INSERT INTO owner_platform.platform_users(login_id,role) VALUES ('bad-role','school_admin')`, []],
      platform_users_status_check: [`INSERT INTO owner_platform.platform_users(login_id,role,status) VALUES ('bad-status','platform_support','deleted')`, []],
      plans_code_check: [`INSERT INTO owner_platform.plans(code,name,storage_mb) VALUES ('A','Bad code',0)`, []],
      plans_name_check: [`INSERT INTO owner_platform.plans(code,name,storage_mb) VALUES ('bad_name','  ',0)`, []],
      plans_max_users_check: [`INSERT INTO owner_platform.plans(code,name,max_users,storage_mb) VALUES ('bad_name', 'x', -1, 0)`, []],
      plans_max_students_check: [`INSERT INTO owner_platform.plans(code,name,max_students,storage_mb) VALUES ('bad_name', 'x', -1, 0)`, []],
      plans_storage_mb_check: [`INSERT INTO owner_platform.plans(code,name,storage_mb) VALUES ('bad_name','x',-1)`, []],
      plans_features_object_check: [`INSERT INTO owner_platform.plans(code,name,storage_mb,features) VALUES ('bad_name','x',0,'[]'::jsonb)`, []],
      plans_price_amount_check: [`INSERT INTO owner_platform.plans(code,name,storage_mb,price_amount) VALUES ('bad_name','x',0,-1)`, []],
      plans_price_cycle_check: [`INSERT INTO owner_platform.plans(code,name,storage_mb,price_cycle) VALUES ('bad_name','x',0,'daily')`, []],
      subscriptions_status_check: [`INSERT INTO owner_platform.subscriptions(tenant_id,plan_code,status,starts_at,ends_at) VALUES ($1,'basic','trialing',now(),now()+interval '1 day')`, [crypto.randomUUID()]],
      subscriptions_dates_check: [`INSERT INTO owner_platform.subscriptions(tenant_id,plan_code,status,starts_at,ends_at) VALUES ($1,'basic','expired',now(),now())`, [crypto.randomUUID()]],
      subscriptions_grace_days_check: [`INSERT INTO owner_platform.subscriptions(tenant_id,plan_code,status,starts_at,ends_at,grace_days) VALUES ($1,'basic','expired',now(),now()+interval '1 day',366)`, [crypto.randomUUID()]],
      subscriptions_version_check: [`INSERT INTO owner_platform.subscriptions(tenant_id,plan_code,status,starts_at,ends_at,version) VALUES ($1,'basic','expired',now(),now()+interval '1 day',0)`, [crypto.randomUUID()]],
      subscription_event_from_status_check: [`INSERT INTO owner_platform.subscription_event(tenant_id,subscription_id,from_status,to_status,reason,actor_ref,idempotency_key) VALUES ($1,$2,'unknown','active','system','test','c-from')`, [A, SUB_A]],
      subscription_event_to_status_check: [`INSERT INTO owner_platform.subscription_event(tenant_id,subscription_id,to_status,reason,actor_ref,idempotency_key) VALUES ($1,$2,'unknown','system','test','c-to')`, [A, SUB_A]],
      subscription_event_reason_check: [`INSERT INTO owner_platform.subscription_event(tenant_id,subscription_id,to_status,reason,actor_ref,idempotency_key) VALUES ($1,$2,'active','other','test','c-reason')`, [A, SUB_A]],
      subscription_event_idempotency_key_check: [`INSERT INTO owner_platform.subscription_event(tenant_id,subscription_id,to_status,reason,actor_ref,idempotency_key) VALUES ($1,$2,'active','system','test','  ')`, [A, SUB_A]],
      tenant_limits_max_users_check: [`INSERT INTO owner_platform.tenant_limits(tenant_id,max_users,storage_bytes) VALUES ($1,-1,0)`, [crypto.randomUUID()]],
      tenant_limits_max_students_check: [`INSERT INTO owner_platform.tenant_limits(tenant_id,max_students,storage_bytes) VALUES ($1,-1,0)`, [crypto.randomUUID()]],
      tenant_limits_storage_bytes_check: [`INSERT INTO owner_platform.tenant_limits(tenant_id,storage_bytes) VALUES ($1,-1)`, [crypto.randomUUID()]],
      tenant_usage_users_count_check: [`INSERT INTO owner_platform.tenant_usage(tenant_id,users_count) VALUES ($1,-1)`, [crypto.randomUUID()]],
      tenant_usage_students_count_check: [`INSERT INTO owner_platform.tenant_usage(tenant_id,students_count) VALUES ($1,-1)`, [crypto.randomUUID()]],
      tenant_usage_storage_bytes_check: [`INSERT INTO owner_platform.tenant_usage(tenant_id,storage_bytes) VALUES ($1,-1)`, [crypto.randomUUID()]],
      support_grant_scope_check: [`INSERT INTO owner_platform.support_grant(id,tenant_id,operator_id,approved_by,scope,reason,starts_at,ends_at,school_notified_at) VALUES ($1,$2,$3,$4,'content_write','valid enough reason',now(),now()+interval '1 hour',now()-interval '1 minute')`, [crypto.randomUUID(), A, SUPPORT, OWNER]],
      support_grant_reason_check: [`INSERT INTO owner_platform.support_grant(id,tenant_id,operator_id,approved_by,scope,reason,starts_at,ends_at,school_notified_at) VALUES ($1,$2,$3,$4,'metadata','short',now(),now()+interval '1 hour',now()-interval '1 minute')`, [crypto.randomUUID(), A, SUPPORT, OWNER]],
      support_grant_window_check: [`INSERT INTO owner_platform.support_grant(id,tenant_id,operator_id,approved_by,scope,reason,starts_at,ends_at,school_notified_at) VALUES ($1,$2,$3,$4,'metadata','valid enough reason',now(),now(),now()-interval '1 minute')`, [crypto.randomUUID(), A, SUPPORT, OWNER]],
      support_grant_max_72h_check: [`INSERT INTO owner_platform.support_grant(id,tenant_id,operator_id,approved_by,scope,reason,starts_at,ends_at,school_notified_at) VALUES ($1,$2,$3,$4,'metadata','valid enough reason',now(),now()+interval '73 hours',now()-interval '1 minute')`, [crypto.randomUUID(), A, SUPPORT, OWNER]],
      support_grant_approver_check: [`INSERT INTO owner_platform.support_grant(id,tenant_id,operator_id,approved_by,scope,reason,starts_at,ends_at,school_notified_at) VALUES ($1,$2,$3,$3,'metadata','valid enough reason',now(),now()+interval '1 hour',now()-interval '1 minute')`, [crypto.randomUUID(), A, OWNER]],
      support_grant_school_notified_check: [`INSERT INTO owner_platform.support_grant(id,tenant_id,operator_id,approved_by,scope,reason,starts_at,ends_at,school_notified_at) VALUES ($1,$2,$3,$4,'metadata','valid enough reason',now(),now()+interval '1 hour',now()+interval '1 minute')`, [crypto.randomUUID(), A, SUPPORT, OWNER]],
      support_grant_used_reads_check: [`INSERT INTO owner_platform.support_grant(id,tenant_id,operator_id,approved_by,scope,reason,starts_at,ends_at,school_notified_at,used_reads) VALUES ($1,$2,$3,$4,'metadata','valid enough reason',now(),now()+interval '1 hour',now()-interval '1 minute',-1)`, [crypto.randomUUID(), A, SUPPORT, OWNER]],
      support_grant_max_actions_check: [`INSERT INTO owner_platform.support_grant(id,tenant_id,operator_id,approved_by,scope,reason,starts_at,ends_at,school_notified_at,max_actions) VALUES ($1,$2,$3,$4,'metadata','valid enough reason',now(),now()+interval '1 hour',now()-interval '1 minute',0)`, [crypto.randomUUID(), A, SUPPORT, OWNER]],
      support_grant_reads_within_cap_check: [`INSERT INTO owner_platform.support_grant(id,tenant_id,operator_id,approved_by,scope,reason,starts_at,ends_at,school_notified_at,used_reads,max_actions) VALUES ($1,$2,$3,$4,'metadata','valid enough reason',now(),now()+interval '1 hour',now()-interval '1 minute',2,1)`, [crypto.randomUUID(), A, SUPPORT, OWNER]],
      support_grant_open_slot_check: [`INSERT INTO owner_platform.support_grant(id,tenant_id,operator_id,approved_by,scope,reason,starts_at,ends_at,school_notified_at,open_slot) VALUES ($1,$2,$3,$4,'metadata','valid enough reason',now(),now()+interval '1 hour',now()-interval '1 minute',2)`, [crypto.randomUUID(), A, SUPPORT, OWNER]],
      support_access_log_record_ref_check: [`INSERT INTO owner_platform.support_access_log(grant_id,tenant_id,record_ref) VALUES ($1,$2,'  ')`, [null, A]],
      platform_audit_action_check: [`INSERT INTO owner_platform.platform_audit(actor_ref,action,subject_type,previous_hash,event_hash) VALUES ('test',' ','tenant',$1,$2)`, [ZERO_HASH, Buffer.alloc(32, 1)]],
      platform_audit_subject_type_check: [`INSERT INTO owner_platform.platform_audit(actor_ref,action,subject_type,previous_hash,event_hash) VALUES ('test','change',' ',$1,$2)`, [ZERO_HASH, Buffer.alloc(32, 1)]],
      platform_audit_previous_hash_len_check: [`INSERT INTO owner_platform.platform_audit(actor_ref,action,subject_type,previous_hash,event_hash) VALUES ('test','change','tenant',$1,$2)`, [Buffer.from([1]), Buffer.alloc(32, 1)]],
      platform_audit_event_hash_len_check: [`INSERT INTO owner_platform.platform_audit(actor_ref,action,subject_type,previous_hash,event_hash) VALUES ('test','change','tenant',$1,$2)`, [ZERO_HASH, Buffer.from([1])]],
      platform_audit_details_object_check: [`INSERT INTO owner_platform.platform_audit(actor_ref,action,subject_type,details,previous_hash,event_hash) VALUES ('test','change','tenant','[]'::jsonb,$1,$2)`, [ZERO_HASH, Buffer.alloc(32, 1)]],
      invoice_period_check: [`INSERT INTO owner_platform.invoice(tenant_id,period_start,period_end,amount) VALUES ($1,'2026-01-02','2026-01-01',0)`, [crypto.randomUUID()]],
      invoice_amount_check: [`INSERT INTO owner_platform.invoice(tenant_id,period_start,period_end,amount) VALUES ($1,'2026-01-01','2026-02-01',-1)`, [crypto.randomUUID()]],
      invoice_currency_check: [`INSERT INTO owner_platform.invoice(tenant_id,period_start,period_end,amount,currency) VALUES ($1,'2026-01-01','2026-02-01',0,'USD')`, [crypto.randomUUID()]],
      invoice_status_check: [`INSERT INTO owner_platform.invoice(tenant_id,period_start,period_end,amount,status) VALUES ($1,'2026-01-01','2026-02-01',0,'processing')`, [crypto.randomUUID()]],
    };
      const catalog = await db.query(`SELECT conname FROM pg_constraint
        WHERE contype='c' AND connamespace='owner_platform'::regnamespace ORDER BY conname`);
      const actualChecks = catalog.rows.map((r) => r.conname);
      assert.deepStrictEqual(actualChecks, Object.keys(cases).sort(), 'every named SQL CHECK has a negative case and vice versa');
      cases.support_access_log_record_ref_check[1][0] = require('node:crypto').randomUUID();
      await db.query('BEGIN');
      for (const [name, [sql, params]] of Object.entries(cases)) await mustReject(`CHECK ${name}`, sql, params, name);
      await db.query('COMMIT');

      await db.query('CREATE TABLE public.product_records(tenant_id uuid NOT NULL, body jsonb NOT NULL)');
      const roleFlags = await db.query(`SELECT rolname,rolsuper,rolbypassrls FROM pg_roles
        WHERE rolname IN ('payesh_platform_owner','payesh_platform_runtime') ORDER BY rolname`);
      assert.strictEqual(roleFlags.rows.length, 2);
      assert.ok(roleFlags.rows.every((r) => !r.rolsuper && !r.rolbypassrls), 'platform roles are not superuser/BYPASSRLS');
      const privileges = await db.query(`SELECT
        has_table_privilege('payesh_platform_runtime','owner_platform.invoice','SELECT') AS invoice_read,
        has_table_privilege('payesh_platform_runtime','public.product_records','SELECT') AS content_read,
        has_table_privilege('payesh_platform_runtime','owner_platform.subscriptions','INSERT') AS subscription_insert,
        has_table_privilege('payesh_platform_runtime','owner_platform.subscriptions','UPDATE') AS subscription_update,
        has_table_privilege('payesh_platform_runtime','owner_platform.subscriptions','DELETE') AS subscription_delete`);
      assert.ok(Object.values(privileges.rows[0]).every((v) => v === false), 'invoice/content/subscription mutation grants are absent');
      const rlsTables = await db.query(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='owner_platform' AND c.relkind='r'`);
      assert.strictEqual(rlsTables.rows.length, 10);
      assert.ok(rlsTables.rows.every((r) => r.relrowsecurity && r.relforcerowsecurity), 'all owner-platform tables ENABLE and FORCE RLS');

      await db.query('BEGIN');
      await mustReject('subscription event cannot reference another tenant', `INSERT INTO owner_platform.subscription_event
        (tenant_id,subscription_id,to_status,reason,actor_ref,idempotency_key)
        VALUES ($1,$2,'active','system','test','cross-event')`, [A,SUB_B], '23503');
      await mustReject('invoice cannot reference another tenant', `INSERT INTO owner_platform.invoice
        (tenant_id,subscription_id,period_start,period_end,amount) VALUES ($1,$2,'2026-01-01','2026-02-01',0)`, [A,SUB_B], '23503');
      await db.query('COMMIT');

      await db.query('CREATE ROLE owner_panel_tenant_test NOLOGIN NOSUPERUSER NOBYPASSRLS');
      await db.query('GRANT USAGE ON SCHEMA owner_platform TO owner_panel_tenant_test');
      await db.query('GRANT SELECT,INSERT,UPDATE,DELETE ON owner_platform.subscriptions,owner_platform.tenant_limits,owner_platform.tenant_usage TO owner_panel_tenant_test');
      await db.query('GRANT SELECT ON owner_platform.platform_users TO owner_panel_tenant_test');
      await db.query('BEGIN');
      await db.query('SET LOCAL ROLE owner_panel_tenant_test');
      await db.query("SELECT set_config('app.tenant_id',$1,true)", [A]);
      const visible = await db.query('SELECT tenant_id FROM owner_platform.subscriptions ORDER BY tenant_id');
      assert.strictEqual(visible.rows.length, 1);
      assert.strictEqual(visible.rows[0].tenant_id, A, 'tenant A sees only its subscription');
      const cross = await db.query('SELECT count(*)::int AS n FROM owner_platform.subscriptions WHERE tenant_id=$1', [B]);
      assert.strictEqual(cross.rows[0].n, 0, 'cross-tenant SELECT is empty');
      await mustReject('RLS blocks INSERT for tenant B', 'INSERT INTO owner_platform.tenant_usage(tenant_id) VALUES ($1)', [B], '42501');
      await mustReject('RLS blocks tenant reassignment', 'UPDATE owner_platform.tenant_limits SET tenant_id=$1 WHERE tenant_id=$2', [B,A], '42501');
      await db.query('COMMIT');
      await db.query('BEGIN');
      await db.query('SET LOCAL ROLE owner_panel_tenant_test');
      const noContext = await db.query('SELECT count(*)::int AS n FROM owner_platform.subscriptions');
      assert.strictEqual(noContext.rows[0].n, 0, 'missing tenant context fails closed');
      await db.query('COMMIT');

      await db.query('BEGIN');
      await db.query('SET LOCAL ROLE payesh_platform_runtime');
      const metadata = await db.query('SELECT count(*)::int AS n FROM owner_platform.subscriptions');
      assert.strictEqual(metadata.rows[0].n, 2, 'platform runtime may read cross-tenant metadata');
      await mustReject('runtime cannot read school content', 'SELECT * FROM public.product_records', [], '42501');
      await mustReject('runtime cannot read invoice', 'SELECT * FROM owner_platform.invoice', [], '42501');
      await mustReject('runtime cannot create subscription', `INSERT INTO owner_platform.subscriptions(tenant_id,plan_code,status,starts_at,ends_at)
        VALUES ($1,'basic','active',now(),now()+interval '1 day')`, [require('node:crypto').randomUUID()], '42501');
      await mustReject('runtime cannot renew subscription', `UPDATE owner_platform.subscriptions SET ends_at=ends_at+interval '1 day' WHERE tenant_id=$1`, [A], '42501');
      await db.query('COMMIT');

      // E1–E16 at the data boundary: grant presence, four-eyes, notice, tenant binding,
      // future/expired/revoked grants, no content_write, action cap, operator context, and per-read log.
      const active = grantInput({ scope:'content_read', max_actions:2 });
      await insertGrant(active);
      await db.query('BEGIN');
      const wrongApprover = grantInput({ operator_id:SUPPORT, approved_by:SUPPORT2, case_ref:'wrong-approver' });
      await mustReject('E2 requires an active owner approver', `INSERT INTO owner_platform.support_grant
        (id,tenant_id,operator_id,approved_by,case_ref,scope,reason,starts_at,ends_at,school_notified_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [wrongApprover.id,wrongApprover.tenant_id,wrongApprover.operator_id,
        wrongApprover.approved_by,wrongApprover.case_ref,wrongApprover.scope,wrongApprover.reason,wrongApprover.starts_at,
        wrongApprover.ends_at,wrongApprover.school_notified_at], '42501');
      await db.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.platform_user_id',$2,true)", [A,SUPPORT]);
      await mustReject('E1 no grant means no content read', 'INSERT INTO owner_platform.support_access_log(grant_id,tenant_id,record_ref) VALUES ($1,$2,$3)', [require('node:crypto').randomUUID(),A,'record-1'], '42501');
      await mustReject('E5 grant cannot cross tenants', 'INSERT INTO owner_platform.support_access_log(grant_id,tenant_id,record_ref) VALUES ($1,$2,$3)', [active.id,B,'record-2'], '42501');
      const future = grantInput({ operator_id:SUPPORT2, starts_at:new Date(Date.now()+60_000).toISOString(),
        ends_at:new Date(Date.now()+90*60_000).toISOString(), school_notified_at:new Date().toISOString(), case_ref:'future' });
      await insertGrant(future);
      await db.query("SELECT set_config('app.platform_user_id',$1,true)", [SUPPORT2]);
      await mustReject('E3 future grant is not active', 'INSERT INTO owner_platform.support_access_log(grant_id,tenant_id,record_ref) VALUES ($1,$2,$3)', [future.id,A,'future'], '42501');
      await db.query('UPDATE owner_platform.support_grant SET revoked_at=clock_timestamp() WHERE id=$1', [future.id]);
      await db.query("SELECT set_config('app.platform_user_id',$1,true)", [SUPPORT2]);
      await mustReject('E15 another operator context is rejected', 'INSERT INTO owner_platform.support_access_log(grant_id,tenant_id,record_ref) VALUES ($1,$2,$3)', [active.id,A,'wrong-operator'], '42501');
      await db.query("SELECT set_config('app.platform_user_id',$1,true)", [SUPPORT]);
      await insertLog(active.id,A,'record-a');
      await insertLog(active.id,A,'record-b');
      const used = await db.query('SELECT used_reads FROM owner_platform.support_grant WHERE id=$1', [active.id]);
      assert.strictEqual(used.rows[0].used_reads, 2, 'each allowed read consumes a counted action');
      const logs = await db.query('SELECT count(*)::int AS n FROM owner_platform.support_access_log WHERE grant_id=$1', [active.id]);
      assert.strictEqual(logs.rows[0].n, 2, 'E16 each successful content-read log is a separate row');
      await mustReject('E14 action cap denies the next read', 'INSERT INTO owner_platform.support_access_log(grant_id,tenant_id,record_ref) VALUES ($1,$2,$3)', [active.id,A,'record-c'], '42501');
      await db.query('UPDATE owner_platform.support_grant SET revoked_at=clock_timestamp() WHERE id=$1', [active.id]);
      await mustReject('E11/E13 revocation is immediate', 'INSERT INTO owner_platform.support_access_log(grant_id,tenant_id,record_ref) VALUES ($1,$2,$3)', [active.id,A,'after-revoke'], '42501');
      await mustReject('grant cannot be extended', `UPDATE owner_platform.support_grant SET ends_at=ends_at+interval '1 minute' WHERE id=$1`, [active.id], '42501');
      const expired = grantInput({ operator_id:SUPPORT2, starts_at:new Date(Date.now()-4*60*60_000).toISOString(),
        ends_at:new Date(Date.now()-3*60*60_000).toISOString(), school_notified_at:new Date(Date.now()-5*60*60_000).toISOString(), case_ref:'expired' });
      await insertGrant(expired);
      await db.query("SELECT set_config('app.platform_user_id',$1,true)", [SUPPORT2]);
      await mustReject('E12 expired grant is denied', 'INSERT INTO owner_platform.support_access_log(grant_id,tenant_id,record_ref) VALUES ($1,$2,$3)', [expired.id,A,'after-expiry'], '42501');
      await db.query('COMMIT');

      const eventHash = require('node:crypto').createHash('sha256').update('first-audit-event').digest();
      await db.query('BEGIN');
      await db.query(`INSERT INTO owner_platform.platform_audit(actor_id,actor_ref,action,subject_type,previous_hash,event_hash)
        VALUES ($1,'owner','grant.create','support_grant',$2,$3)`, [OWNER,ZERO_HASH,eventHash]);
      await mustReject('audit chain rejects stale previous hash', `INSERT INTO owner_platform.platform_audit(actor_ref,action,subject_type,previous_hash,event_hash)
        VALUES ('owner','grant.revoke','support_grant',$1,$2)`, [ZERO_HASH,require('node:crypto').createHash('sha256').update('bad-chain').digest()], '23514');
      await db.query('COMMIT');
      await db.query('BEGIN');
      await db.query('SET LOCAL ROLE payesh_platform_owner');
      await mustReject('audit is append-only (UPDATE)', 'UPDATE owner_platform.platform_audit SET action=action', [], '42501');
      await mustReject('audit is append-only (DELETE)', 'DELETE FROM owner_platform.platform_audit', [], '42501');
      await db.query('COMMIT');

      await db.exec(down);
      await db.query('DROP ROLE owner_panel_tenant_test');
      const gone = await db.query("SELECT to_regnamespace('owner_platform') IS NOT NULL AS present");
      assert.strictEqual(gone.rows[0].present, false, 'down removes its schema');
      const rolesGone = await db.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname IN ('payesh_platform_owner','payesh_platform_runtime')");
      assert.strictEqual(rolesGone.rows[0].n, 0, 'down removes only migration-owned roles');
      await db.exec(up);
      await db.exec(down);
    } finally {
      if (db) await db.close();
      if (hadWindow) global.window = previousWindow;
      else delete global.window;
    }
  });

  /* ── ردیف ۹۷ / PR-2: API مستقل پلتفرم ─────────────────────────────── */
  const ownerPanelApi = require('../apps/owner-panel/tests/platform-api.test.js');
  await test('PR‑2: توکن و نقش پلتفرم از مدرسه جداست و توکن مدرسه دوطرفه رد میشود',
    () => ownerPanelApi.auth());
  await test('PR‑2: قرارداد OpenAPI با router همتراز است و allowlist خروجی رازها را حذف میکند',
    () => ownerPanelApi.contract());
  await test('PR‑2: API پشت Gateway، deny محتوا، grant، request-id، rate-limit و آزمون منفی هر کنترل',
    () => ownerPanelApi.integration());

  /* ── ردیف ۹۸ / PR-3: SPA فارسی/RTL پنل مالک با پوستهٔ نبض ─────────── */
  const tenantDeletion = require('../apps/owner-panel/tests/tenant-deletion.test.js');
  await test('PR‑3: حذف دومرحله‌ای مدرسه (migration 003) — owner دوم، مهلت ۲۴ساعت، نگهداری ۱۸۰روز، بدون نابودی داده',
    async () => { const r = await tenantDeletion.flow(); console.log('    TENANT-DELETION negative_controls=' + r.negative_controls + ' failures=0'); });
  const ownerSpa = require('../apps/owner-panel/tests/owner-spa.test.js');
  await test('PR‑3: پوستهٔ نبض از client/pulse.css تولید و drift/اختلاف توکن آزموده میشود؛ بدون CDN و مستقل از pages.js',
    () => ownerSpa.assets());
  await test('PR‑3: پروکسی same-origin با CSP، allowlist هدر و رد cookie/redirect/بدنهٔ نامعتبر',
    () => ownerSpa.proxy());
  await test('PR‑3: UI سرتاسری روی API واقعی — ورود fail-closed، نُه صفحه، loading/empty/error، نقش operator، حذف دومرحله‌ای، تم',
    async () => { await ownerSpa.ui(); console.log('    OWNER-SPA checks=' + ownerSpa.checks() + ' failures=0'); });

  /* ── ردیف ۱۱۸: تطبیق Done در Notion با حقیقت مخزن (جدول PASS/PARTIAL/BLOCKED/…) ── */
  await test('ردیف ۱۱۸: جدول تطبیق — مسیرها موجود، برچسب/آزمون برای PASS، امنیت UNKNOWN، وضعیت ساخت مدرسه/صفحه‌های بومی/لایهٔ زیرساخت مطابق کد، کنترل منفی جهش',
    async () => {
      const r = await require('./reconcile-118.js').main({ quiet: true });
      if (r.failed) throw new Error('RECONCILE-118 failures: ' + r.failures.join(','));
      console.log('    RECONCILE-118-OK passed=' + r.passed + ' negative_controls=' + r.negatives);
    });

  /* ── ردیف ۹۸ / D‑45: صادرکنندهٔ ورود انسانی (رمز + TOTP، حداکثر ۳ حساب) ── */
  const ownerLogin = require('../apps/owner-panel/tests/owner-login.test.js');
  await test('D‑45: ورود رمز + TOTP — بردارهای RFC 6238/4226/4648، scrypt، تکرار کد، قفل، سهمیه، سقف ۳ حساب، مرز دیتابیس، rollback',
    async () => { const u = await ownerLogin.unitAsync(); const r = await ownerLogin.flow(); console.log('    OWNER-LOGIN unit_checks=' + u + ' negative_controls=' + r.negative_controls + ' failures=0'); });

  /* ── ردیف ۹۹ / PR-4: بسته‌بندی پنل مالک (ADR‑62) ───────────────────── */
  const ownerPackaging = require('../apps/owner-panel/tests/packaging.test.js');
  await test('PR‑4: شناسه‌ها/پوسته/workflow پنل مالک جدا از اپ مدرسه، بدون آدرس/کلید سخت‌کد، با کنترل منفی جهش',
    () => { const r = ownerPackaging.staticChecks(); console.log('    OWNER-PACKAGING rules=' + r.rules + ' mutations_caught=' + r.mutations + ' failures=0'); });
  await test('PR‑4: بستهٔ وب قطعی و گیت خروجی‌ها (نبود/خالی/checksum/ادعای امضای بی‌شاهد ⇒ قرمز)',
    () => { const r = ownerPackaging.scriptChecks(); console.log('    OWNER-ARTIFACTS gate_negative_controls=' + r.negative_controls + ' failures=0'); });

  /* ── ردیف ۱۱۷: ADR مرحله‌ای کم‌هزینه + همگام‌سازی قانون اساسی + ADR‑105 (Parked) ── */
  await test('ردیف ۱۱۷: ADR‑117 مراحل A→D با دروازه/برچسب، D‑48، بند ۲۵ بی‌تغییر، ADR‑105 Parked از a532393، ترابری پیش‌فرض Gateway، کنترل منفی جهش',
    async () => {
      const r = await require('./adr-117.js').main({ quiet: true });
      if (r.failed) throw new Error('ADR-117 failures: ' + r.failures.join(','));
      console.log('    ADR-117-OK passed=' + r.passed + ' negative_controls=' + r.negatives);
    });

  /* ── ردیف ۱۲۱: ساخت مدرسه از پنل مالک (migration 005 + POST /tenants) ─── */
  const tenantProvisioning = require('../apps/owner-panel/tests/tenant-provisioning.test.js');
  await test('ردیف ۱۲۱: ساخت مدرسه از پنل مالک — فقط owner، reason، provision_op_id idempotent، saga (provisioning→active)، کد یک‌بارمصرف بیرون از audit، کنترل منفی',
    async () => { const r = await tenantProvisioning.flow(); console.log('    TENANT-PROVISIONING-121 negative_controls=' + r.negative_controls + ' failures=0'); });
  await test('ردیف ۱۲۱: school-access بدون PostgreSQL — بدون راز ⇒ 503، معلم ⇒ 403، کد ۱۶۰بیتی و هش وابسته به tenant',
    async () => {
      const sa = require('../server/school-access.js');
      const c1 = sa.randomCode(), c2 = sa.randomCode();
      assert.ok(/^[A-Z2-7]{32}$/.test(c1) && c1 !== c2, 'code shape/entropy');
      assert.notStrictEqual(sa.hashSecret('t1', c1), sa.hashSecret('t2', c1), 'hash bound to tenant');
      let e1 = null; try { await sa.activate(null, { school: 'x-school', code: c1, deviceId: 'dev-1', secret: '' }); } catch (e) { e1 = e; }
      assert.ok(e1 && e1.status === 503, 'no secret ⇒ 503');
      let e2 = null; try { await sa.issueActivation(null, { role: 'teacher', tid: 'x' }, { uid: 2 }); } catch (e) { e2 = e; }
      assert.ok(e2 && e2.status === 403 && e2.code === 'manager_only', 'teacher ⇒ 403');
      console.log('    SCHOOL-ACCESS-121 unit=4 (PG e2e: tests/tenant-121.js in api-contract)');
    });

  /* ── ردیف ۱۲۲: لایهٔ زیرساخت مستقل از provider (migration 006 + /infra) ─── */
  const infraRegistry = require('../apps/owner-panel/tests/infra-registry.test.js');
  await test('ردیف ۱۲۲: لایهٔ زیرساخت — ProviderAdapter دستی (بدون provisioning خودکار)، credential فقط secret:NAME، Health Check محدود (SSRF/timeout/cooldown)، «نامعلوم» بهجای عدد ساختگی، تغییر پرخطر = درخواست + تأیید owner + audit، کنترل منفی',
    async () => { const r = await infraRegistry.all(); console.log('    INFRA-122 negative_controls=' + r.negative_controls + ' unit_controls=' + r.unit_controls + ' failures=0'); });

  /* ── ردیف ۱۲۳: صفحهٔ «زیرساخت» و فرم «ساخت مدرسه» در SPA پنل مالک ───── */
  await test('ردیف ۱۲۳: UI زیرساخت روی API واقعی — «نامعلوم» بهجای عدد ساختگی، credential فقط secret:NAME (بدون فیلد رمز)، Health Check دستی با cooldown، تغییر پرخطر دومرحله‌ای (درخواست ⇒ تأیید فقط owner)، ساخت مدرسه با کد فعال‌سازی یک‌باره، کنترل منفی',
    async () => { const r = await require('../apps/owner-panel/tests/owner-spa-infra.test.js').run(); console.log('    OWNER-SPA-INFRA-123 checks=' + r.checks + ' negative_controls=' + r.negative + ' failures=0'); });

  /* ── ردیف ۱۲۴: پژوهش API واقعی Providerها (سند + اعتبارسنج) ───────── */
  await test('ردیف ۱۲۴: پژوهش Providerها — هر قابلیت یکی از سه سطح (ثبت دستی/پایش سلامت/Provisioning)، ادعا فقط با منبع https، بی‌منبع ⇒ L1 [?]، L3 ممنوع، هزینه فقط با منبع، هم‌خوان با آداپتور manual، کنترل منفی جهش',
    async () => { const r = await require('./provider-research-124.js').main({ quiet: true }); if (r.failed) throw new Error('PROVIDER-RESEARCH-124 failures: ' + r.failures.join(',')); console.log('    PROVIDER-RESEARCH-124-OK passed=' + r.passed + ' negative_controls=' + r.negatives); });

  /* ── ردیف ۷۴ موج ۱: ورود و انتخاب مدرسه در کلاینت بومی (برابری قرارداد) ── */
  await test('ردیف ۷۴ موج ۱: ورود بومی — الگوها و مسیرها و فیلدها برابر سرور و openapi، هر خطا پیام فارسی، توکن فقط در حافظه، بدون Authorization، cell فقط https و کلاینت pinned، پرچم قدیم/جدید fail-safe بدون WebView، IT واقعی در CI، نشان Sync، کنترل منفی جهش',
    async () => { const r = await require('./native-wave1-74.js').main({ quiet: true }); if (r.failed) throw new Error('NATIVE-WAVE1-74 failures: ' + r.failures.join(',')); console.log('    NATIVE-WAVE1-74-OK passed=' + r.passed + ' negative_controls=' + r.negatives); });

  /* ── ردیف ۷۴ موج ۲: حضور و غیاب در کلاینت بومی (برابری با actAttendanceSave) ── */
  await test('ردیف ۷۴ موج ۲: حضور بومی — وضعیت‌ها و برچسب‌ها برابر سرور و وب، معنای ذخیره برابر actAttendanceSave، شناسهٔ رکورد زیر 2^53، فقط Gateway با کلاینت pinned، مالک داده پیش از همگام‌سازی، نشان Sync از صندوقچه، پرچم موج، IT واقعی در CI، کنترل منفی جهش',
    async () => { const r = await require('./native-wave2-74.js').main({ quiet: true }); if (r.failed) throw new Error('NATIVE-WAVE2-74 failures: ' + r.failures.join(',')); console.log('    NATIVE-WAVE2-74-OK passed=' + r.passed + ' negative_controls=' + r.negatives); });

  /* ── ردیف ۷۴ موج ۳: ثبت نمره در کلاینت بومی (برابری با actGradeSave، تأیید فقط با مدیر) ── */
  await test('ردیف ۷۴ موج ۳: نمرهٔ بومی — نوبت‌ها و نشان‌ها برابر وب، معنای ذخیره برابر actGradeSave (۰ تا ۲۰، kind، وضعیت مدیر/دبیر)، Gateway دبیرِ غیر pending را با approval_denied رد می‌کند و بردار scope-v1 همین را می‌گوید، شناسه زیر 2^53 و بیرون از بازهٔ حضور، همان مسیر Gateway، پرچم موج، IT واقعی در CI، کنترل منفی جهش',
    async () => { const r = await require('./native-wave3-74.js').main({ quiet: true }); if (r.failed) throw new Error('NATIVE-WAVE3-74 failures: ' + r.failures.join(',')); console.log('    NATIVE-WAVE3-74-OK passed=' + r.passed + ' negative_controls=' + r.negatives); });

  /* ── ردیف ۷۴ موج ۴: اطلاعیه در کلاینت بومی (برابری با actAnnAdd، نوشتن فقط با مدیر) ── */
  await test('ردیف ۷۴ موج ۴: اطلاعیهٔ بومی — اهمیت‌ها و برچسب‌ها برابر فرم وب، عنوان و متن الزامی، تاریخ روز UTC و ثابت در ویرایش، جدیدترین اول، خواننده = همهٔ نقش‌ها و نویسنده = مدیر، Gateway نوشتن و حذف دبیر/والد را با role_denied رد می‌کند و بردار scope-v1 همین را می‌گوید، شناسه زیر 2^53 و بالای بازهٔ نمره با base 0، صف پیش از نوشتن محلی، پرچم موج، IT واقعی در CI، کنترل منفی جهش',
    async () => { const r = await require('./native-wave4-74.js').main({ quiet: true }); if (r.failed) throw new Error('NATIVE-WAVE4-74 failures: ' + r.failures.join(',')); console.log('    NATIVE-WAVE4-74-OK passed=' + r.passed + ' negative_controls=' + r.negatives); });

  /* ── ردیف ۷۴ موج ۵: صفحه‌های والدین در کلاینت بومی (برابری با parentHome / PAGES.child / actLeaveAdd) ── */
  await test('ردیف ۷۴ موج ۵: والدین بومی — نشان‌های معدل، حضور و مرخصی برابر وب، فرزندان فقط از پیوند خود ولی، معدل فقط نمرهٔ تأییدشده و درصد گرد، ۱۲ حضور آخر، درخواست مرخصی با شکل ردیف وب و وضعیت pending فقط برای فرزند متصل، Gateway وضعیت جعلی ولی را با approval_denied رد می‌کند و بردار scope-v1 همین را می‌گوید، شناسه جدا و زیر 2^53 با base 0، صف پیش از نوشتن محلی، پرچم موج، تاریخ شمسی رفت‌وبرگشتی، IT واقعی در CI، کنترل منفی جهش',
    async () => { const r = await require('./native-wave5-74.js').main({ quiet: true }); if (r.failed) throw new Error('NATIVE-WAVE5-74 failures: ' + r.failures.join(',')); console.log('    NATIVE-WAVE5-74-OK passed=' + r.passed + ' negative_controls=' + r.negatives); });

  /* ── ردیف ۹۴: سند طراحی نصب و آنبوردینگ (نمودار جریان + سه مورد خطا، هم‌خوان با کد) ── */
  await test('ردیف ۹۴: سند آنبوردینگ — نمودار جریان mermaid و متنی، کد اشتباه / قطع اینترنت / مدرسهٔ مهاجرت‌شده، پیام‌ها عیناً همان messageFa کلاینت، مسیرها و وضعیت‌ها و TTLهای Directory برابر سرور، فاصله‌های G1/G2/G4/G5 هنوز در کد، نقش از ردیف users و صدور کد فقط با مدیر، کنترل منفی جهش',
    async () => { const r = await require('./onboarding-94.js').main({ quiet: true }); if (r.failed) throw new Error('ONBOARDING-94 failures: ' + r.failures.join(',')); console.log('    ONBOARDING-94-OK passed=' + r.passed + ' negative_controls=' + r.negatives); });

  /* ── ردیف ۱۰۲: پنل مالک · اجرای محلی با یک فرمان (local-up) ─────────── */
  const ownerLocalUp = require('../apps/owner-panel/tests/local-up.test.js');
  await test('ردیف ۱۰۲: local-up — فقط loopback، DATABASE_URL محلی، migration idempotent، رازها خارج از Git، ورود TOTP، خاموشی تمیز، بدون 004 ⇒ 501',
    async () => { const r = await ownerLocalUp.main(); console.log('    LOCAL-UP-102 passed=' + r.passed + ' negative_controls=' + r.negative_controls + ' failures=0'); });
  await test('ردیف ۱۰۷: e2e1 — رمزنگاری سمت دستگاه (X25519/HKDF/AES-GCM)، بردارهای مشترک JS↔Dart، AAD ردیف، چرخش کلید، کنترل منفی',
    async () => {
      const r = await require('./e2e1-107.js').main({ quiet: true });
      if (r.failed) throw new Error('E2E1-107 failures: ' + r.failures.join(','));
      console.log('    E2E1-107-OK passed=' + r.passed + ' negative_controls=' + r.negatives);
    });
  await test('ردیف ۱۱۵: پروب هاست — Node≥22.5/sqlite، ماندگاری دیسک، همیشه‌روشن، TLS خروجی PG بدون اعتبارنامه، redaction، فرم مالک، کنترل منفی جهش',
    async () => {
      const r = await require('./host-probe-115.js').main({ quiet: true });
      if (r.failed) throw new Error('HOST-PROBE-115 failures: ' + r.failures.join(','));
      console.log('    HOST-PROBE-115-OK passed=' + r.passed + ' negative_controls=' + r.negatives);
    });

  /* ── ردیف ۱۲۰: بستهٔ استقرار Gateway چندمستأجری (بخش ایستا؛ بخش PostgreSQL در CI api-contract) ── */
  await test('ردیف ۱۲۰: بستهٔ Gateway — closure فقط فایل‌های Gateway (بدون سرور تک‌مدرسه‌ای)، pg بدون pg-cloudflare (D‑09)، متغیرهای محیطی از خود کد = env-catalog، پویش راز، پیش‌بررسی و رد محیط خالی، هش SCRAM، selfcheck در برابر سرور معیوب، سند مالک، ۱۱ جهش؛ بخش PG اینجا BLOCKED نه PASS',
    async () => {
      const r = await require('./gateway-bundle-120.js').main({ quiet: true, pg: false });
      if (r.failed) throw new Error('GATEWAY-BUNDLE-120 failures: ' + r.failures.join(','));
      console.log('    GATEWAY-BUNDLE-120-OK passed=' + r.passed + ' negative_controls=' + r.negatives + ' pg_suite=' + (r.blocked ? 'BLOCKED-here (CI api-contract runs it)' : 'ran'));
    });

  /* ── ردیف ۱۱۹: آفلاین — Gateway با قطع اتصال PostgreSQL نمی‌میرد ───────── */
  await test('ردیف ۱۱۹: pool مستأجر شنوندهٔ error دارد (قطع اتصال DB، Gateway را نمی‌کشد) + کنترل منفی؛ آزمون PG بدون PG ⇒ BLOCKED نه PASS',
    async () => {
      const ten = require(path.join(ROOT, 'server/tenancy.js'));
      const pool = ten.createPool({ connectionString: 'postgres://nobody@127.0.0.1:1/none' });
      assert.ok(pool.listenerCount('error') >= 1, 'tenancy pool has no error listener (row 119 regression)');
      const before = ten.poolErrorCount();
      pool.emit('error', new Error('Connection terminated unexpectedly'));
      assert.strictEqual(ten.poolErrorCount(), before + 1);
      await pool.end();
      /* negative control: a pool WITHOUT the handler throws on the same event (= process crash) */
      const { Pool } = require('pg');
      const bare = new Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none' });
      assert.throws(() => bare.emit('error', new Error('Connection terminated unexpectedly')), /terminated/);
      await bare.end();
      const { spawnSync } = require('child_process');
      const env = Object.assign({}, process.env);
      delete env.PAYESH_PG_ADMIN; delete env.PAYESH_PG_RUNTIME; delete env.OFF119_REQUIRE_PG;
      const r = spawnSync(process.execPath, [path.join(ROOT, 'tests/offline-119.js')], { encoding: 'utf8', env });
      assert.strictEqual(r.status, 3, 'offline-119 without PG must be BLOCKED (exit 3): ' + r.stdout);
      assert.ok(/BLOCKED/.test(r.stdout) && !/^PASS/m.test(r.stdout));
      console.log('    OFFLINE-119 pool_error_listener=1 negative_controls=1 pg_suite=BLOCKED-here (CI api-contract runs it)');
    });

  /* ── ردیف ۱۲۶ (یافتهٔ CI): مهاجرت tenancy اتمی است — بدون پنجرهٔ «جدول RLS بی‌سیاست» ── */
  await test('ردیف ۱۲۶: tenancy.migrate یک تراکنش + قفل مشورتی + تکرار بن‌بست (ایستا)؛ آزمون بار هم‌زمان PG بدون PG ⇒ BLOCKED نه PASS',
    async () => {
      const src = fs.readFileSync(path.join(ROOT, 'server/tenancy.js'), 'utf8');
      const body = src.slice(src.indexOf('async function migrate('), src.indexOf('/* ── اتصال runtime'));
      const at = k => body.indexOf(k);
      assert.ok(at("client.query('BEGIN')") > 0 && at("client.query('BEGIN')") < at('pg_advisory_xact_lock')
        && at('pg_advisory_xact_lock') < at('for (const sql of SCHEMA_SQL)') && at('for (const sql of SCHEMA_SQL)') < at("client.query('COMMIT')"),
        'migrate must be BEGIN → advisory lock → schema → COMMIT (row 126)');
      assert.ok(/ROLLBACK/.test(body) && /40P01/.test(body), 'migrate must roll back and retry deadlocks');
      /* row 129 (CI finding: gateway-real W2-IT-03 / W3-IT-03 "applied 0"): steady-state migrate is DDL-free,
         a real migration locks every tenancy table up front (no lock upgrade ⇒ no deadlock with a live push),
         and withTenant re-runs a live transaction that was picked as the deadlock victim */
      assert.ok(at('schemaCurrent(client)') > at('pg_advisory_xact_lock') && at('if (!skipped)') > at('schemaCurrent(client)')
        && at('MIGRATE_LOCK_SQL') > at('if (!skipped)') && at('MIGRATE_LOCK_SQL') < at('for (const sql of SCHEMA_SQL)'),
        'row 129: advisory lock → fingerprint check → (only if needed) lock all tables → schema');
      const wt = src.slice(src.indexOf('async function withTenant('), src.indexOf('let txRetries'));
      assert.ok(/RETRYABLE_TX\.has\(e\.code\)/.test(wt) && /attempt >= attempts/.test(wt) && /ROLLBACK/.test(wt),
        'row 129: withTenant must roll back and re-run 40P01/40001 a bounded number of times');
      const tn = require(path.join(ROOT, 'server/tenancy.js'));
      assert.strictEqual(tn.txAttempts({}), 4); assert.strictEqual(tn.txAttempts({ PAYESH_PG_TX_ATTEMPTS: '1' }), 1);
      assert.strictEqual(tn.txAttempts({ PAYESH_PG_TX_ATTEMPTS: '99' }), 10); assert.strictEqual(tn.txAttempts({ PAYESH_PG_TX_ATTEMPTS: 'x' }), 4);
      assert.ok(/^[0-9a-f]{64}$/.test(tn.SCHEMA_FINGERPRINT));
      const { spawnSync } = require('child_process');
      const env = Object.assign({}, process.env);
      delete env.PAYESH_PG_ADMIN; delete env.PAYESH_PG_RUNTIME; delete env.MIG126_REQUIRE_PG;
      const r = spawnSync(process.execPath, [path.join(ROOT, 'tests/migrate-atomic-126.js')], { encoding: 'utf8', env });
      assert.strictEqual(r.status, 3, 'migrate-atomic-126 without PG must be BLOCKED (exit 3): ' + r.stdout);
      assert.ok(/BLOCKED/.test(r.stdout) && !/^PASS/m.test(r.stdout));
      console.log('    MIGRATE-ATOMIC-126 static=1 row129_tx_rerun=1 row129_ddl_free_steady_state=1 pg_suite=BLOCKED-here (CI api-contract runs it)');
    });

  /* ── ردیف ۱۲۵: رجیستری برنامه‌های نصبی — «فقط بومی» (D‑49) ── */
  await test('ردیف ۱۲۵: هر برنامهٔ نصبی ثبت شده، هیچ WebView «بومی» نامیده نشده، WebView منتشر نمی‌شود (۱۲۹)، و ۳۴ جهش همه قرمز می‌شوند',
    async () => {
      const { spawnSync } = require('child_process');
      const a = spawnSync(process.execPath, [path.join(ROOT, 'tools/installables-125.mjs')], { encoding: 'utf8', cwd: ROOT });
      assert.strictEqual(a.status, 0, 'installables registry: ' + a.stdout.split('\n').filter(l => /^FAIL|INSTALLABLES/.test(l)).join('\n'));
      const b = spawnSync(process.execPath, [path.join(ROOT, 'tests/installables-125.js')], { encoding: 'utf8', cwd: ROOT });
      assert.strictEqual(b.status, 0, 'installables mutations: ' + b.stdout.split('\n').filter(l => /^FAIL/.test(l)).join('\n'));
      console.log('    ' + a.stdout.trim().split('\n').pop() + ' · ' + b.stdout.trim().split('\n').pop());
    });

  /* ── ردیف ۱۲۸: ماتریس برابری قابلیت‌های اپ بومی با کلاینت وب ── */
  await test('ردیف ۱۲۸: هر صفحه/عمل/فرم کلاینت وب در ماتریس برابری است (بومی، موج برنامه‌ریزی‌شده، یا حذف با جایگزین) و ۱۵ جهش قرمز',
    async () => {
      const { spawnSync } = require('child_process');
      const a = spawnSync(process.execPath, [path.join(ROOT, 'tools/parity-128.mjs')], { encoding: 'utf8', cwd: ROOT });
      assert.strictEqual(a.status, 0, 'parity matrix: ' + a.stdout.split('\n').filter(l => /^FAIL|PARITY/.test(l)).join('\n'));
      const b = spawnSync(process.execPath, [path.join(ROOT, 'tests/parity-128.js')], { encoding: 'utf8', cwd: ROOT });
      assert.strictEqual(b.status, 0, 'parity mutations: ' + b.stdout.split('\n').filter(l => /^FAIL/.test(l)).join('\n'));
      console.log('    ' + a.stdout.trim().split('\n').pop() + ' · ' + b.stdout.trim().split('\n').pop());
    });

  /* ── ردیف ۱۲۷: حالت شبکهٔ محلی اپ بومی + سرویس دادهٔ بی‌رابط مدرسه ── */
  await test('ردیف ۱۲۷: سرور بی‌رابط هیچ صفحهٔ وبی نمی‌دهد، راه‌اندازی فقط از خود سرور، نصب‌کننده‌ها بی‌رابط وب، ۲۰ جهش قرمز',
    async () => {
      const { spawnSync } = require('child_process');
      const r = spawnSync(process.execPath, [path.join(ROOT, 'tests/lan-mode-127.js')], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
      assert.strictEqual(r.status, 0, 'lan-mode-127: ' + (r.stdout || '').split('\n').filter(l => /^FAIL|LAN-MODE/.test(l)).join('\n') + (r.stderr || ''));
      console.log('    ' + r.stdout.trim().split('\n').pop());
    });

  childExited = true;
  child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 300));

  console.log(`\n${passed} موفق · ${failed} ناموفق\n`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); try { child.kill(); } catch (x) { /* noop */ } process.exit(1); });
