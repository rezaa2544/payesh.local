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
  const headers = { 'content-type': 'application/json' };
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
  await test('کد ملی ایرانی درست اعتبارسنجی می‌شود', () => {
    const { validNationalId } = require('../server/util');
    assert.strictEqual(validNationalId('1000000001'), true);
    assert.strictEqual(validNationalId('1111111111'), false);
    assert.strictEqual(validNationalId('123'), false);
  });

  /* ── ۲. سرور واقعی ── */
  PORT = await freePort();
  BASE = 'http://127.0.0.1:' + PORT;
  const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT, env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST: '127.0.0.1', PAYESH_DATA: TMP, PAYESH_LOG: '0',
      PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0',
      /* آزمون‌های این فایل قطعی و دستی‌اند؛ حلقه‌های خودکار (۱ ثانیه‌ای و
         صندوقچه) در test:live و test:restart آزموده می‌شوند و این‌جا خاموش‌اند
         تا با درخواست‌های دستی آزمون مسابقه ندهند (روی ماشین کند، ۴۰ ثانیه). */
      PAYESH_LIVE_MS: '0', PAYESH_OUTBOX_AUTO: '0', PAYESH_CLOUD_AUTO: '0',
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
  await test('راه‌اندازی اولیه و ساخت مدیر', async () => {
    const r = await req('/api/setup', { method: 'POST', body: {
      school_name: 'دبیرستان آزمون', manager_name: 'مدیر آزمون', pin: '1234', phone: '09120000001',
    } });
    assert.strictEqual(r.data.ok, true);
    assert.ok(r.data.session.token);
    managerToken = r.data.session.token;
    const again = await req('/api/setup', { method: 'POST', body: { school_name: 'x', manager_name: 'y', pin: '1234' } });
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
    const paired = await req('/api/auth/pair', { method: 'POST', body: { code: pc.data.code, pin: '4321' } });
    assert.strictEqual(paired.data.ok, true);
    assert.ok(paired.data.session.token);

    const dup = await req('/api/auth/pair', { method: 'POST', body: { code: pc.data.code, pin: '4321' } });
    assert.strictEqual(dup.data.ok, false);
    assert.strictEqual(dup.data.error, 'code_used');
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
      const pair = await req('/api/auth/pair', { method: 'POST', body: { code: teacher.code, pin: '1' } });
      if (pair.data && pair.data.session) {
        const denied = await req('/api/sync', { method: 'POST', token: pair.data.session.token, body: { ops: [
          { uid: 'lk4', collection: 'lookups', type: 'put', data: { kind: 'grade', name: 'دستکاری' } },
        ] } });
        const applied = (denied.data.applied || []).length;
        assert.strictEqual(applied, 0, 'نقش غیرمدیر نمی‌تواند تعریف اضافه کند');
      }
    }
  });

  await test('قفل PIN: رمز غلط رد، رمز درست قبول', async () => {
    const pc = await req('/api/admin/pair-code', { method: 'POST', token: managerToken, body: { user_id: 1 } });
    const p = await req('/api/auth/pair', { method: 'POST', body: { code: pc.data.code, pin: '5555' } });
    const bad = await req('/api/auth/unlock', { method: 'POST', body: { device_token: p.data.device_token, pin: '0000' } });
    assert.strictEqual(bad.status, 401);
    const ok = await req('/api/auth/unlock', { method: 'POST', body: { device_token: p.data.device_token, pin: '5555' } });
    assert.strictEqual(ok.data.ok, true);
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
    assert.strictEqual(set.data.password, 'newpass1234', 'پاسخ، رمز تازه را برمی‌گرداند');

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

  await test('اپلیکیشن اندروید: آدرس سرویس را خودش پیدا می‌کند (بدون پرسش از کاربر)', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'android-config.json'), 'utf8'));
    assert.strictEqual(cfg.app, 'payesh-local');
    assert.strictEqual(typeof cfg.url, 'string', 'کلید url باید باشد (حتی خالی)');

    const main = fs.readFileSync(path.join(ROOT, 'install/android/app/src/main/java/ir/payesh/local/MainActivity.java'), 'utf8');
    assert.ok(main.includes('BuildConfig.PAYESH_URL'), 'آدرس پخته‌شده در APK');
    assert.ok(main.includes('CONFIG_URLS'), 'پیکربندی مرکزی مخزن');
    assert.ok(/void scanLan\(/.test(main), 'جستجوی خودکار در شبکه');
    assert.ok(/verifyThenOpen\(/.test(main), 'بررسی سریع آدرس‌ها و رفتن به بعدی');
    assert.ok(main.includes('appassets.androidplatform.net'), 'دارایی‌های برنامه از داخل APK');

    /* شروع برنامه نباید مستقیم آدرس بپرسد — همان شکایتی که کاربر داشت */
    const onCreate = main.slice(main.indexOf('protected void onCreate'), main.indexOf('private int dp('));
    assert.ok(onCreate.includes('boot();'), 'شروع برنامه اتصال خودکار است');
    const asksOnStart = onCreate.split('\n').some(l => l.trim() === 'askServer();');
    assert.ok(!asksOnStart, 'در اولین اجرا آدرس پرسیده نمی‌شود (فقط دکمهٔ اضطراری)');

    /* ── امضای ثابت: بدون آن، گوشی نسخهٔ تازه را روی قبلی نصب نمی‌کند ── */
    const gradleTxt = fs.readFileSync(path.join(ROOT, 'install/android/app/build.gradle'), 'utf8');
    assert.ok(/payesh-signing\.p12/.test(gradleTxt), 'کلید امضای ثابت در ساخت استفاده می‌شود');
    assert.ok(/buildTypes\s*\{[\s\S]*debug\s*\{[\s\S]*signingConfig signingConfigs\.stable/.test(gradleTxt),
      'نسخهٔ debug هم با همان کلید ثابت امضا می‌شود (وگرنه نصب روی نسخهٔ قبلی رد می‌شود)');
    assert.ok(fs.existsSync(path.join(ROOT, 'install/android/payesh-signing.p12')), 'فایل کلید امضا در مخزن هست');

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
    const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/build.yml'), 'utf8');
    assert.ok(ci.includes('desktop\\build.ps1'), 'CI برنامه را می‌سازد');
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

      /* صندوقچهٔ پیش‌فرض داخل برنامه: بدون هیچ تایپی باید آماده باشد */
      const mem = new Map();
      const fakeStore = { getMeta: (k, d) => (mem.has(k) ? mem.get(k) : d), setMeta: (k, v) => { mem.set(k, v); } };
      const def = s3.defaults();
      assert.ok(def.endpoint && def.accessKey && def.secret, 'کلیدهای پیش‌فرض داخل برنامه هست');
      assert.equal(def.source, 'default');
      assert.equal(s3.usingMeta(fakeStore).isDefault(), true, 'هیچ تنظیم دستی ذخیره نشده');
      assert.equal(s3.usingMeta(fakeStore).get().accessKey, def.accessKey, 'پیش‌فرض برمی‌گردد');

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

    const r = await req('/api/auth/transfer/redeem', { method: 'POST', body: { code: t.data.code, pin: '4321' } });
    assert.strictEqual(r.data.ok, true);
    assert.ok(r.data.device_token);
    assert.ok(r.data.session.token);

    const again = await req('/api/auth/transfer/redeem', { method: 'POST', body: { code: t.data.code, pin: '4321' } });
    assert.strictEqual(again.data.error, 'code_used');

    const bad = await req('/api/auth/transfer/redeem', { method: 'POST', body: { code: 'nope', pin: '4321' } });
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

  await test('PIN با ارقام فارسی هم ثبت می‌شود (باگ تکرار راه‌اندازی)', async () => {
    const pc = await req('/api/admin/pair-code', { method: 'POST', token: managerToken, body: { user_id: 1 } });
    const paired = await req('/api/auth/pair', { method: 'POST', body: { code: pc.data.code, pin: '۴۳۲۱' } });
    assert.strictEqual(paired.data.ok, true, 'PIN فارسی پذیرفته شود');
    const unlock = await req('/api/auth/unlock', { method: 'POST', body: { device_token: paired.data.device_token, pin: '4321' } });
    assert.strictEqual(unlock.data.ok, true, 'همان PIN با ارقام انگلیسی هم کار کند');
  });


  await test('صندوقچه برای هر دستگاهِ واردشده آماده است (بدون تایپ کلید)', async () => {
    const cc = await req('/api/cloud/config', { token: managerToken });
    assert.strictEqual(cc.data.ok, true);
    assert.ok(/arvanstorage/.test(cc.data.config.endpoint || ''), 'endpoint پیش‌فرض داخل برنامه');
    assert.ok(cc.data.config.accessKey && cc.data.config.secret, 'کلید پیش‌فرض هست');
    const anon = await req('/api/cloud/config');
    assert.ok(anon.status >= 400 || !(anon.data && anon.data.config), 'بدون ورود، کلید داده نمی‌شود');
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

  await test('به‌روزرسانی: پیش‌فرض خودکار + گزارش تغییرات یک‌بار', async () => {
    const upd = require(path.join(ROOT, 'server', 'update.js'));
    const store = { getMeta: () => null };
    assert.strictEqual(upd.autoApplyEnabled(store), true, 'نصب خودکار پیش‌فرض روشن است');
    assert.strictEqual(upd.autoCheckEnabled(store), true, 'بررسی خودکار پیش‌فرض روشن است');

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

  await test('قفل موقت پس از ۸ PIN اشتباه', async () => {
    const pc = await req('/api/admin/pair-code', { method: 'POST', token: managerToken, body: { user_id: 1 } });
    const paired = await req('/api/auth/pair', { method: 'POST', body: { code: pc.data.code, pin: '5555' } });
    const dev = paired.data.device_token;
    let last = null;
    for (let i = 0; i < 8; i++) last = await req('/api/auth/unlock', { method: 'POST', body: { device_token: dev, pin: '0000' } });
    assert.strictEqual(last.status, 401);
    const locked = await req('/api/auth/unlock', { method: 'POST', body: { device_token: dev, pin: '0000' } });
    assert.strictEqual(locked.status, 429);
    assert.strictEqual(locked.data.error, 'locked');
    assert.ok(locked.data.until);
    /* حتی با PIN درست هم تا پایان قفل باز نمی‌شود */
    const correct = await req('/api/auth/unlock', { method: 'POST', body: { device_token: dev, pin: '5555' } });
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
    const fake = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        if (!/^AWS4-HMAC-SHA256/.test(req.headers.authorization || '')) {
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
    await new Promise(r => fake.listen(0, '127.0.0.1', r));
    const cloudPort = fake.address().port;
    try {
      const setC = await req('/api/admin/cloud', { method: 'POST', token: managerToken, body: {
        endpoint: 'http://127.0.0.1:' + cloudPort, bucket: 'ob1', region: 'ir-central1',
        accessKey: 'AK', secret: 'SK', prefix: 'payesh/',
      } });
      assert.strictEqual(setC.data.ok, true, 'حافظهٔ ابری تنظیم شد');

      const t = await req('/api/admin/pair-code', { method: 'POST', token: managerToken, body: { user_id: 2 } });
      const teacher = await req('/api/auth/pair', { method: 'POST', body: { code: t.data.code, pin: '2222' } });
      const teacherToken = teacher.data.session.token;
      const teacherId = 2;

      /* «دستگاه دیگری» در خانه مرخصی ثبت کرده — رکورد مستقیم در صندوقچه */
      const op = { collection: 'leaves', type: 'put', data: { student_id: 3, date: '2026-05-01', reason: 'بیماری', status: 'pending' }, base_version: 0 };
      bucket.set('payesh/outbox/pending/ob-test-1.json', JSON.stringify({
        v: 1, uid: 'ob-test-1', user_id: 1, role: 'manager', device_id: 'dev-home', op, created_at: '2026-05-01T10:00:00.000Z',
      }));

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
      const parentTok = (await req('/api/auth/pair', { method: 'POST', body: { code: parentCode.data.code, pin: '1234' } })).data.session.token;
      const denied = await req('/api/outbox/drain', { method: 'POST', token: parentTok, body: {} });
      assert.strictEqual(denied.status, 403, 'ولی نمی‌تواند نقش سرور بگیرد');

      /* اولین دستگاهِ روشن‌شده (اینجا: مدیر) صندوقچه را اعمال می‌کند */
      const drained = await req('/api/outbox/drain', { method: 'POST', token: managerToken, body: {} });
      assert.strictEqual(drained.data.ok, true);
      assert.ok(drained.data.applied >= 1, 'ثبت صندوقچه اعمال شد: ' + JSON.stringify(drained.data.details || drained.data));
      const after = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&collections=leaves', { token: managerToken });
      assert.ok(after.data.collections.leaves.some(l => l.reason === 'بیماری'), 'مرخصی از دستگاه خانه به دادهٔ مدرسه رسید');
      assert.ok(bucket.get('payesh/outbox/pending/ob-test-1.json') == null, 'ثبت اعمال‌شده از صندوقچه پاک شد');
      assert.ok(bucket.has('payesh/outbox/done/ob-test-1.json'), 'نشان «اعمال شد» گذاشته شد');

      /* تکرار: همان ثبت دوباره اعمال نمی‌شود */
      bucket.set('payesh/outbox/pending/ob-test-1.json', JSON.stringify({
        v: 1, uid: 'ob-test-1', user_id: 1, role: 'manager', device_id: 'dev-home', op, created_at: '2026-05-01T10:00:00.000Z',
      }));
      const again = await req('/api/outbox/drain', { method: 'POST', token: managerToken, body: {} });
      assert.strictEqual(again.data.applied, 0, 'اعمال دوباره انجام نشد (idempotent)');

      /* ثبت غیرمجاز: دبیر نمی‌تواند کاربر بسازد */
      bucket.set('payesh/outbox/pending/ob-test-2.json', JSON.stringify({
        v: 1, uid: 'ob-test-2', user_id: teacherId, role: 'teacher', device_id: 'dev-home',
        op: { collection: 'users', type: 'put', data: { name: 'نفوذی', role: 'manager' }, base_version: 0 },
      }));
      const bad = await req('/api/outbox/drain', { method: 'POST', token: managerToken, body: {} });
      assert.strictEqual(bad.data.applied, 0, 'ثبت خارج از نقش اعمال نشد');
      assert.ok(bad.data.rejected >= 1, 'رد شدن ثبت غیرمجاز گزارش شد');

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

      /* ورود کامل گوشی: از صندوقچه، بدون هیچ درخواستی به سرور */
      PH.saveConfig(require(path.join(ROOT, 'client', 'lib', 's3mini.js')).normalize({
        endpoint: 'http://127.0.0.1:' + cloudPort, bucket: 'ob1', region: 'ir-central1',
        accessKey: 'AK', secret: 'SK', prefix: 'payesh/',
      }));
      const phoneLogin = await PH.login('۰۹۱۲۰۰۰۰۰۰۱', 'Madrese1404');
      assert.strictEqual(phoneLogin.ok, true, 'ورود گوشی با شماره و رمز مدیر: ' + JSON.stringify(phoneLogin));
      assert.strictEqual(phoneLogin.user.role, 'manager', 'نقش از مدرسه می‌آید');
      const phoneData = await PH.pullData(phoneLogin.user);
      assert.ok(Array.isArray(phoneData.collections.users) && phoneData.collections.users.length > 2, 'گوشی فهرست کاربران را می‌گیرد');
      const sentOp = await PH.send({ uid: 'ob-phone-1', user_id: 1, role: 'manager', op: { collection: 'announcements', type: 'put', data: { title: 'از گوشی', body: 'بدون سرور', date: '2026-05-02' }, base_version: 0 } });
      assert.strictEqual(sentOp.ok, true, 'ثبت گوشی در صندوقچه گذاشته شد');
      assert.ok(bucket.has('payesh/outbox/pending/ob-phone-1.json'), 'فایل ثبت گوشی در صندوقچه هست');
      const drainedFromPhone = await req('/api/outbox/drain', { method: 'POST', token: managerToken, body: {} });
      assert.ok(drainedFromPhone.data.applied >= 1, 'سیستم مدرسه ثبت گوشی را اعمال کرد');

      /* تغییر رمز از روی گوشی: فقط نسخهٔ قابل‌بررسی می‌آید و همان رمز می‌شود */
      const utilMod = require(path.join(ROOT, 'server', 'util.js'));
      bucket.set('payesh/outbox/pending/pw-phone-1.json', JSON.stringify({
        v: 1, uid: 'pw-phone-1', user_id: 1, role: 'manager', device_id: 'phone-x',
        op: { collection: 'users', type: 'put', id: 1, data: { __password_verifier: utilMod.pbkdf2Hash('Ramz-Az-Ghooshi') } },
      }));
      const pwDrain = await req('/api/outbox/drain', { method: 'POST', token: managerToken, body: {} });
      assert.ok(pwDrain.data.applied >= 1, 'تغییر رمز از گوشی اعمال شد');
      const pwLogin = await req('/api/auth/login', { method: 'POST', body: { phone: '09120000001', password: 'Ramz-Az-Ghooshi' } });
      assert.strictEqual(pwLogin.data.ok, true, 'رمزِ تعیین‌شده روی گوشی روی سرور کار می‌کند');
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
    assert.ok(phone.includes("'auth/'"), 'پروندهٔ ورود از صندوقچه خوانده می‌شود');
    assert.ok(phone.includes("'outbox/pending/'"), 'ثبت‌ها مستقیم در صندوقچه گذاشته می‌شوند');
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
    /* هیچ مجوز پرخطری نباید خواسته شود */
    const risky = ['REQUEST_INSTALL_PACKAGES', 'READ_CONTACTS', 'READ_SMS', 'SEND_SMS', 'CAMERA',
      'RECORD_AUDIO', 'READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE', 'MANAGE_EXTERNAL_STORAGE',
      'SYSTEM_ALERT_WINDOW', 'REQUEST_IGNORE_BATTERY_OPTIMIZATIONS', 'READ_PHONE_STATE'];
    for (const r of risky) {
      assert.ok(!new RegExp('android\\.permission\\.' + r + '\\b').test(mf),
        'مجوز پرخطر ' + r + ' نباید در برنامه باشد');
    }
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
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/app.js')
      + '\n;window.__t = { S, impAutoMap, impCheck, impMapped, importApplyLocal, putLocal, list };');
    const T = win.__t;
    T.S.user = { id: 1, name: 'مدیر', role: 'manager' };
    T.S.role = 'manager'; T.S.session = 'x'; T.S.route = 'users';
    T.S.data = {
      users: new Map([[1, { id: 1, name: 'کاربر موجود', role: 'student', national_id: '1000000011', phone: '09120000000' }]]),
      classes: new Map([[1, { id: 1, name: 'دهم الف' }]]),
      subjects: new Map(), lookups: new Map(), parent_links: new Map(),
    };
    T.S.queue = []; T.S.online = false;

    const headers = ['نام و نام خانوادگی', 'کد ملی', 'موبایل', 'کلاس'];
    const map = T.impAutoMap(headers);
    assert.deepStrictEqual([...map], ['full_name', 'national_id', 'phone', 'class_name'],
      'عنوان ستون‌های فارسی خودکار شناخته شدند');

    T.S.imp = {
      step: 2, kind: 'students', headers, map,
      rows: [
        ['علی رضایی', '1000000036', '09123334455', 'دهم الف'],
        ['علی رضایی', '1000000036', '09123334455', 'دهم الف'],   /* تکراری در فایل */
        ['بدون کد ملی', '', '09123334466', 'کلاس ناشناس'],
        ['کد ملی خراب', '123', '', ''],
        ['', '1000000052', '09123334477', ''],
      ],
    };
    const checks = T.impCheck();
    assert.strictEqual(checks.length, 5, 'همهٔ سطرها بررسی شدند');
    assert.strictEqual(checks[0].errors.length, 0, 'سطر سالم خطا ندارد');
    assert.ok(checks[0].warns.length === 0, 'سطر سالم هشدار ندارد');
    assert.ok(checks[1].errors.some(x => /در سطر ۲ هم آمده/.test(x)), 'تکرار کد ملی در فایل تشخیص داده شد');
    assert.ok(checks[2].warns.some(x => /کلاس/.test(x)), 'کلاس ناشناس به‌صورت هشدار اعلام شد');
    assert.ok(checks[2].warns.some(x => /همراه ندارد/.test(x)) === false, 'شمارهٔ همراه دارد');
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
    assert.ok(T.S.data.lookups.has(4), 'رشتهٔ دیگر دست‌نخورده است');
    dom.window.close();
  });

  /* — برنامهٔ هفتگی (پیاده‌سازیِ p2): تداخل، پیشنهاد، تولیدِ خودکار و خانه‌های قابلِ کلیک ─ */
  await test('برنامهٔ هفتگی: تداخلِ دبیر، پیشنهاد جای آزاد و تولید خودکار', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html lang="fa" dir="rtl"><body><div id="app"></div><div id="toasts"></div><div id="modal-root"></div></body></html>',
      { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const strip = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^'use strict';?\s*/m, '');
    win.eval(strip('client/pages.js') + '\n;\n' + strip('client/schedule.js') + '\n;\n' + strip('client/app.js')
      + '\n;window.__t = { S, schedPage, schedGenerate, schedConflicts, schedTeacherBusyAt, schedSuggestSlots, schedSlotModal, closeModal };');
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
    assert.ok(/تداخل/.test(html), 'هشدار تداخل نمایش داده شد');
    assert.ok(/data-act="sched-slot" data-day="0" data-period="1" data-id="100"/.test(html), 'خانهٔ پر با شناسهٔ زنگ');

    /* پنجرهٔ زنگ: درس، دبیر با وضعیت آزاد/مشغول و جابه‌جای موقت */
    T.S.modalTitle = '';
    T.schedSlotModal(T.S.data.schedule.get(100));
    const modalHtml = win.document.querySelector('#modal-root').innerHTML;
    assert.ok(/data-form="slot"/.test(modalHtml), 'فرم زنگ باز شد');
    assert.ok(/🔴/.test(modalHtml), 'دبیرِ مشغول با نشان سرخ دیده می‌شود');
    assert.ok(/sub_date/.test(modalHtml), 'بخش جابه‌جای موقت هست');
    assert.ok(/data-act="modal-close"/.test(modalHtml), 'دکمهٔ ✕ در پنجره هست');
    T.closeModal();
    dom.window.close();
  });

  /* — دکمهٔ ✕ و بستن پنجره‌ها (ایراد گزارش‌شدهٔ کاربر) ───────────────
     ریشه: هندلر درون‌خطی stopPropagation روی خودِ پنجره، کلیک ✕ را می‌بلعید. */
  await test('دکمهٔ ✕ و Esc و پس‌زمینه، پنجره را می‌بندند', async () => {
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

    /* ۳) کلیک روی پس‌زمینهٔ تیره */
    click(win.document.querySelector('#modal-root [data-act="modal-bg"]'));
    assert.strictEqual(win.document.querySelector('#modal-root').innerHTML, '', 'کلیک روی پس‌زمینه پنجره را بست');

    /* ۴) کلید Esc */
    openModal();
    win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.strictEqual(win.document.querySelector('#modal-root').innerHTML, '', 'کلید Esc پنجره را بست');
    dom.window.close();
  });

  childExited = true;
  child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 300));

  console.log(`\n${passed} موفق · ${failed} ناموفق\n`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); try { child.kill(); } catch (x) { /* noop */ } process.exit(1); });
