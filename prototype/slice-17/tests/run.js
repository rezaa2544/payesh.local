'use strict';
// آزمون خودکار نمونهٔ ۱۷ — دسترسی مجاز/غیرمجاز + جداسازی tenant
// اجرا: node prototype/slice-17/tests/run.js
// خروجی: هر ادعا یک خط ✓/✗ و شمارش نهایی؛ کد خروج ۱ اگر هر ادعایی شکست بخورد.

const { build, PLATFORM_TENANT } = require('../app');

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : ' — ' + detail}`);
}

async function main() {
  const app = build();
  const { server, seed } = app;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (path, { method = 'GET', token, body, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, json, text };
  };

  const login = async (username, password, extra = {}) =>
    call('/api/login', { method: 'POST', body: { username, password, ...extra } });

  // ---------- ۱) ورود ----------
  const okLogin = await login('manager.a', 'Manager!Pass1');
  check('ورود مدیر مدرسهٔ الف موفق و توکن صادر می‌شود', okLogin.status === 200 && !!okLogin.json.token, JSON.stringify(okLogin.json));
  const tokA = okLogin.json.token;

  const badPass = await login('manager.a', 'wrong-password');
  check('گذرواژهٔ غلط ⇒ 401 (بدون افشای وجود کاربر)', badPass.status === 401 && badPass.json.error === 'invalid_credentials', JSON.stringify(badPass.json));

  const unknown = await login('does-not-exist', 'x');
  check('کاربر ناشناس ⇒ همان 401 عمومی', unknown.status === 401 && unknown.json.error === 'invalid_credentials');

  const tenantHint = await login('manager.a', 'Manager!Pass1', { tenant_id: app.tenants[1].id });
  check('هینت مستأجر ناهم‌خوان ⇒ 401 (tenant از ورودی تصمیم نمی‌گیرد)', tenantHint.status === 401);

  // ---------- ۲) توکن ----------
  const noToken = await call('/api/grades');
  check('بدون توکن ⇒ 401', noToken.status === 401 && noToken.json.error === 'unauthenticated');

  const tampered = await call('/api/grades', { token: tokA.slice(0, -2) + 'xx' });
  check('توکن دست‌کاری‌شده ⇒ 401 bad_signature', tampered.status === 401 && tampered.json.reason === 'bad_signature', JSON.stringify(tampered.json));

  const me = await call('/api/me', { token: tokA });
  check('/api/me فقط role/tenant نشست را برمی‌گرداند', me.status === 200 && me.json.tenant_id === app.tenants[0].id && me.json.role === 'manager');

  // ---------- ۳) دامنهٔ خواندن: مدیر / دبیر / ولی / هنرجو / نگهبان ----------
  const gManager = await call('/api/grades', { token: tokA });
  check('مدیر: خواندن کل مدرسه (۲ نمره)', gManager.status === 200 && gManager.json.scope === 'S3' && gManager.json.count === 2, JSON.stringify(gManager.json));

  const tTok = (await login('teacher.a', 'Teacher!Pass1')).json.token;
  const gTeacher = await call('/api/grades', { token: tTok });
  check('دبیر: فقط کلاس خودش (۱ از ۲)', gTeacher.status === 200 && gTeacher.json.scope === 'S2' && gTeacher.json.count === 1, JSON.stringify(gTeacher.json));

  const pTok = (await login('parent.a', 'Parent!Pass1')).json.token;
  const gParent = await call('/api/grades', { token: pTok });
  check('ولی: فقط فرزند خودش (S1)', gParent.status === 200 && gParent.json.scope === 'S1' && gParent.json.count === 1);

  const sTok = (await login('student.a', 'Student!Pass1')).json.token;
  const gStudent = await call('/api/grades', { token: sTok });
  check('هنرجو: فقط ردیف خودش (S0)', gStudent.status === 200 && gStudent.json.scope === 'S0' && gStudent.json.count === 1);

  const gTok = (await login('guard.a', 'Guard!Pass1')).json.token;
  const gGuard = await call('/api/grades', { token: gTok });
  check('نگهبان: نمره ممنوع ⇒ 403 default_deny', gGuard.status === 403 && gGuard.json.reason === 'default_deny', JSON.stringify(gGuard.json));

  // ---------- ۴) نوشتن ----------
  const otherClassStudent = seed.A.students[1].id;
  const wTeacherDeny = await call('/api/grades', { method: 'POST', token: tTok, body: { student_id: otherClassStudent, subject: 'ریاضی', score: 20 } });
  check('دبیر: نوشتن برای هنرجوی کلاس دیگر ⇒ 403 out_of_scope', wTeacherDeny.status === 403 && wTeacherDeny.json.reason === 'out_of_scope', JSON.stringify(wTeacherDeny.json));

  const wTeacherOk = await call('/api/grades', { method: 'POST', token: tTok, body: { student_id: seed.A.students[0].id, subject: 'ریاضی', score: 19 } });
  check('دبیر: نوشتن برای هنرجوی کلاس خودش ⇒ 201', wTeacherOk.status === 201 && !!wTeacherOk.json.id);

  const wStudent = await call('/api/grades', { method: 'POST', token: sTok, body: { student_id: seed.A.students[0].id, subject: 'x', score: 20 } });
  check('هنرجو: نوشتن نمره ممنوع ⇒ 403 no_permission', wStudent.status === 403 && wStudent.json.reason === 'no_permission', JSON.stringify(wStudent.json));

  const wVice = await call('/api/grades', { method: 'POST', token: tokA, body: { student_id: otherClassStudent, subject: 'ادبیات', score: 17 } });
  check('مدیر: نوشتن در هر کلاس مدرسه ⇒ 201', wVice.status === 201);

  // ---------- ۵) جداسازی tenant (اصل موضوع) ----------
  const tokB = (await login('manager.b', 'Manager!Pass1')).json.token;
  const gB = await call('/api/grades', { token: tokB });
  check('مدیر مدرسهٔ ب فقط ۲ نمرهٔ خودش را می‌بیند (نه ۳ نمرهٔ الف)', gB.status === 200 && gB.json.count === 2, JSON.stringify(gB.json));
  const idsB = new Set(gB.json.items.map((i) => i.id));
  const overlap = gManager.json.items.filter((i) => idsB.has(i.id));
  check('هیچ شناسهٔ نمره‌ای بین دو مستأجر مشترک نیست', overlap.length === 0);

  const crossRead = await call(`/api/grades?tenant_id=${app.tenants[0].id}`, { token: tokB });
  check('کوئری tenant_id مستأجر دیگر نادیده گرفته می‌شود (همان ۲ ردیف)', crossRead.status === 200 && crossRead.json.count === 2);

  const crossHeader = await call('/api/grades', { token: tokB, headers: { 'x-tenant': app.tenants[0].id } });
  check('هدر X-Tenant جعلی اثری ندارد', crossHeader.status === 200 && crossHeader.json.count === 2);

  const crossWriteBody = await call('/api/grades', {
    method: 'POST', token: tokB,
    body: { tenant_id: app.tenants[0].id, student_id: seed.A.students[0].id, subject: 'ریاضی', score: 20 },
  });
  check('نوشتن روی هنرجوی مستأجر دیگر با tenant_id جعلی ⇒ 404 (رد در لایهٔ RLS)', crossWriteBody.status === 404, JSON.stringify(crossWriteBody.json));

  const bRowsAfter = await call('/api/grades', { token: tokB });
  check('پس از تلاش متقابل، شمارش مستأجر ب تغییر نکرد', bRowsAfter.json.count === 2);

  // ---------- ۶) نقش‌های پلتفرم: Default Deny روی دادهٔ مدرسه ----------
  const sup = await login('support', 'Support!Pass1');
  check('پشتیبان فنی: ورود مجاز', sup.status === 200 && sup.json.role === 'platform_support');
  const supGrades = await call('/api/grades', { token: sup.json.token });
  check('پشتیبان فنی: نمرات مدارس ممنوع ⇒ 403', supGrades.status === 403);
  const supHealth = await call('/api/platform/health', { token: sup.json.token });
  check('پشتیبان فنی: فرادادهٔ سلامت مجاز ⇒ 200 metadata_only', supHealth.status === 200 && supHealth.json.note === 'metadata_only');

  // ---------- ۷) ابطال و انقضا ----------
  const tmpTok = (await login('manager.a', 'Manager!Pass1')).json.token;
  const logout = await call('/api/logout', { method: 'POST', token: tmpTok });
  const afterLogout = await call('/api/me', { token: tmpTok });
  check('خروج ⇒ توکن ابطال و بعدش 401 revoked', logout.status === 200 && afterLogout.status === 401 && afterLogout.json.reason === 'revoked');

  // ---------- ۸) رویدادنگاری زنجیره‌ای ----------
  const audit = await call('/api/audit', { token: tokA });
  check('مدیر: رویدادهای مدرسه + زنجیرهٔ سالم', audit.status === 200 && audit.json.count > 5 && audit.json.chain_ok === true, JSON.stringify(audit.json));
  const auditB = await call('/api/audit', { token: tTok });
  check('دبیر: رویداد مدرسه ممنوع ⇒ 403', auditB.status === 403);

  // ---------- ۹) پنل نقش‌محور ----------
  const panelManager = await call('/panel', { token: tokA });
  const panelStudent = await call('/panel', { token: sTok });
  const panelGuard = await call('/panel', { token: gTok });
  check('پنل مدیر: منوی «گزارش رویدادها» و «ثبت نمره» دارد', panelManager.text.includes('گزارش رویدادها') && panelManager.text.includes('ثبت نمره'));
  check('پنل هنرجو: بدون «ثبت نمره» و بدون «گزارش رویدادها»', !panelStudent.text.includes('ثبت نمره') && !panelStudent.text.includes('گزارش رویدادها'));
  check('پنل نگهبان: هیچ منوی نمره‌ای ندارد', !panelGuard.text.includes('نمرات'));

  // ---------- ۱۰) انقضای نشست با ساعت تزریقی (absolute / idle) ----------
  {
    let clock = 1_700_000_000_000;
    const app2 = build({ now: () => clock });
    await new Promise((r) => app2.server.listen(0, '127.0.0.1', r));
    const base2 = `http://127.0.0.1:${app2.server.address().port}`;
    const call2 = async (path, token) => {
      const res = await fetch(base2 + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    const li = await fetch(base2 + '/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'manager.a', password: 'Manager!Pass1' }),
    });
    const t2 = (await li.json()).token;
    check('انقضا: توکن تازه معتبر است', (await call2('/api/me', t2)).status === 200);

    clock += 31 * 60_000; // ۳۱ دقیقه بی‌کاری
    const idle = await call2('/api/me', t2);
    check('انقضا: بی‌کاری بیش از ۳۰ دقیقه ⇒ 401 expired_idle', idle.status === 401 && idle.json.reason === 'expired_idle', JSON.stringify(idle.json));

    const li2 = await fetch(base2 + '/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'manager.a', password: 'Manager!Pass1' }),
    });
    const t3 = (await li2.json()).token;
    // هر ۲۰ دقیقه یک بار استفاده تا از انقضای مطلق ۸ ساعت عبور کنیم
    for (let i = 0; i < 25; i++) { clock += 20 * 60_000; await call2('/api/me', t3); }
    const abs = await call2('/api/me', t3);
    check('انقضا: سقف مطلق ۸ ساعت حتی با استفادهٔ پیوسته ⇒ 401 expired_absolute', abs.status === 401 && abs.json.reason === 'expired_absolute', JSON.stringify(abs.json));

    check('توکن خام ذخیره نمی‌شود (فقط hash)', [...app2.sessions.rows.keys()].every((k) => /^[0-9a-f]{64}$/.test(k)));
    app2.server.close();
  }

  server.close();

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n${passed} موفق · ${failed} ناموفق`);
  console.log(`SUMMARY pass=${passed} fail=${failed} total=${results.length}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
