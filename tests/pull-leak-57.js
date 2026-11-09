'use strict';
/* ═════════════════════════════════════════════════════════════════
   آزمون رگرسیون ردیف ۵۷ — نشت فیلدهای حساس کاربران به نقش غیرمدیر

   چه چیزی واقعی است؟
     • سرور محصول (server/index.js) به‌صورت فرایند جدا، دیتابیس SQLite
       واقعی و دایرکتوری دادهٔ موقت — همان باینری تولید.
     • نقش‌های معلم/والد/دانش‌آموز واقعاً از طریق /api/v1/pull می‌کشند
       و هر فیلدی که می‌بینند بازرسی می‌شود.
     • کنترل مثبت: مدیر باید password_hash/password_enc و کد ملی را ببیند
       (در غیر این صورت «پاکسازی» همه‌چیز را خراب کرده ایم).

   مرحلهٔ دوم (P0 بازبینی مستقل): علاوه بر فیلدهای رازگونه،
     فیلدهای هویتی/حریم‌خصوصی (national_id، father_nid/mother_nid،
     shenasname_serial/seri، phone، landline، address و فیلدهای تماس
     اصلی) نباید به نقش غیرمدیر برسند — مگر در ردیفِ خودِ کاربر
     (دادهٔ خودش نشت نیست). مسیر /api/students/:id و بستهٔ گوشی
     (outbox.personData) هم همین‌طور.

   چه چیزی ادعا نمی‌شود: مسیرهای ابری نیاز به PostgreSQL واقعی دارند
   و در اینجا اجرا نمی‌شوند (NOT-RUN؛ پاکسازی change-feed در
   server/tenancy.js با همان allowlist بسته شده است).

   اجرا: npm run test:pull57
   ═════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const policy = require(path.join(ROOT, 'server', 'policy.js'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-pl57-'));
const METRICS_TOKEN = 'pl57-metrics-token';

let passed = 0, failed = 0;
const failures = [];
async function check(id, desc, fn) {
  const t0 = Date.now();
  try {
    const d = await fn();
    passed++;
    console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}  (${Date.now() - t0}ms)`);
  } catch (e) {
    failed++; failures.push(id);
    console.log(`FAIL  ${id}  ${desc}  → ${String((e && (e.message || e.stack)) || e).slice(0, 400)}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

class Proc {
  constructor(script, dataDir, extraEnv = {}) {
    this.script = script;
    this.env = Object.assign({}, process.env, {
      PORT: '0', HOST: '127.0.0.1', PAYESH_DATA: dataDir, PAYESH_LOG: '0',
      PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0',
      PAYESH_LIVE_MS: '0', PAYESH_OUTBOX_AUTO: '0', PAYESH_CLOUD_AUTO: '0',
    }, extraEnv);
  }
  async start() {
    this.port = await freePort();
    this.env.PORT = String(this.port);
    const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', this.script], {
      cwd: ROOT, env: this.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.on('data', d => process.env.VERBOSE && process.stdout.write(d));
    child.stderr.on('data', d => process.env.VERBOSE && process.stderr.write(d));
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const r = await this.http('/api/health');
        if (r.status === 200 && r.data && r.data.ok) return this;
        /* Gateway محصول /api/health ندارد — /healthz زنده‌بودن فرایند است */
        const z = await this.http('/healthz');
        if (z.status === 200) return this;
      } catch (e) { /* در حال بالا آمدن */ }
      if (child.exitCode != null) throw new Error('فرایند زود قطع شد: exit=' + child.exitCode);
      await new Promise(r => setTimeout(r, 150));
    }
    throw new Error('سرور بالا نیامد');
  }
  http(p, { method = 'GET', token, body, raw = false } = {}) {
    return new Promise((resolve, reject) => {
      const headers = Object.assign({ 'content-type': 'application/json' }, raw ? {} : {});
      if (token) headers.authorization = 'Bearer ' + token;
      const req = require('http').request({ host: '127.0.0.1', port: this.port, path: p, method, headers, agent: false }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (raw) return resolve({ status: res.statusCode, text: buf.toString('utf8'), headers: res.headers });
          let data = null;
          try { data = JSON.parse(buf.toString('utf8')); } catch (e) { data = null; }
          resolve({ status: res.statusCode, data, text: buf.toString('utf8'), headers: res.headers });
        });
      });
      req.on('error', reject);
      if (body != null) req.write(JSON.stringify(body));
      req.end();
    });
  }
  async kill() {
    if (!this.child) return;
    try { this.child.kill('SIGKILL'); } catch (e) { /* noop */ }
    await new Promise(r => setTimeout(r, 200));
  }
}

/* فیلد رازگونهٔ دیده‌شده — هم الگوی policy و هم فهرست صریح ردیف ۵۷ */
function leakedKeys(row) {
  const bad = [];
  for (const k of Object.keys(row || {})) {
    if (policy.isSecretField(k)) bad.push(k);
  }
  for (const k of ['password_hash', 'password_enc', 'password_plain', 'phone_hash', '__password_verifier', 'pin_hash']) {
    if (row && row[k] !== undefined && !bad.includes(k)) bad.push(k);
  }
  return bad;
}

/* فیلدهای هویتی/حریم‌خصوصی (P0 مرحلهٔ دوم) — در ردیفِ دیگران ممنوع */
const IDENTITY_FIELDS = ['national_id', 'father_nid', 'mother_nid', 'shenasname_serial',
  'shenasname_seri', 'phone', 'father_phone', 'mother_phone', 'landline', 'address',
  'residence', 'village', 'residence_status'];
function leakedIdentityKeys(row) {
  return Object.keys(row || {}).filter(k => IDENTITY_FIELDS.includes(k));
}

(async () => {
  const dataDir = path.join(WORK, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const srv = await new Proc('server/index.js', dataDir, { PAYESH_METRICS_TOKEN: METRICS_TOKEN }).start();

  try {
    /* ── راه‌اندازی مدرسه و کاربران هر نقش ────────────────────────── */
    let managerToken = null;
    await check('PL-00', 'راه‌اندازی اولیه و نشست مدیر', async () => {
      const r = await srv.http('/api/setup', { method: 'POST', body: {
        school_name: 'مدرسه آزمون ۵۷', manager_name: 'مدیر ۵۷',
        password: 'Rooz-57-Secure', phone: '09120000050',
      } });
      assert(r.data && r.data.ok === true, 'setup ok نیست: ' + JSON.stringify(r.data));
      managerToken = r.data.session.token;
      return 'manager session ok';
    });

    const ids = {};
    await check('PL-01', 'ساخت کلاس/معلم/دانش‌آموز/والد + پیوندها', async () => {
      /* کلاس اول ساخته می‌شود تا دانش‌آموز class_id بگیرد — دبیرِ کلاس
         از طریق schedule ردیف دانش‌آموز را در اسکوپ می‌بیند */
      const cls = await srv.http('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
        { uid: 'c57', collection: 'classes', type: 'put', data: { name: 'دهم ۵۷', grade: 'دهم' } },
      ] } });
      assert((cls.data.applied || []).length === 1, 'کلاس ساخته نشد');
      ids.class = Number(cls.data.applied[0].id);

      const mk = await srv.http('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
        { uid: 't57', collection: 'users', type: 'put', data: { name: 'دبیر ۵۷', role: 'teacher', phone: '09120000057', national_id: '1000000057' } },
        /* دانش‌آموز با فیلدهای هویتی کامل (کد ملی پدر/مادر، شناسنامه، نشانی)
           — تا نشتِ آن‌ها به دبیر/ولی سنجیده شود */
        { uid: 's57', collection: 'users', type: 'put', data: {
          name: 'دانش‌آموز ۵۷', role: 'student', phone: '09120000058', national_id: '1000000058',
          class_id: ids.class,
          father_nid: '2000000058', mother_nid: '2000000059',
          shenasname_serial: '۵۶۷۸۹', shenasname_seri: 'ب۱۲',
          father_phone: '09120000061', mother_phone: '09120000062',
          landline: '0215550000', address: 'خیابان آزمون ۵۷',
          residence: 'تهران', village: '', residence_status: 'با والدین',
        } },
        { uid: 'p57', collection: 'users', type: 'put', data: { name: 'والد ۵۷', role: 'parent', phone: '09120000059', national_id: '1000000059' } },
      ] } });
      assert((mk.data.applied || []).length === 3, 'سه کاربر ساخته نشد: ' + JSON.stringify(mk.data));
      const byUid = {};
      (mk.data.applied || []).forEach(a => { byUid[a.uid] = Number(a.id); });
      ids.teacher = byUid.t57; ids.student = byUid.s57; ids.parent = byUid.p57;
      const link = await srv.http('/api/sync', { method: 'POST', token: managerToken, body: { ops: [
        { uid: 'l57', collection: 'parent_links', type: 'put', data: { parent_id: ids.parent, student_id: ids.student } },
        { uid: 'sc57', collection: 'schedule', type: 'put', data: { class_id: ids.class, teacher_id: ids.teacher, weekday: 'sat', lesson: 'ریاضی' } },
      ] } });
      assert((link.data.applied || []).length === 2, 'پیوندها ساخته نشد');
      return `teacher=${ids.teacher} student=${ids.student} parent=${ids.parent} class=${ids.class}`;
    });

    const loginAs = async (phone, pw) => {
      const r = await srv.http('/api/auth/login', { method: 'POST', body: { phone, password: pw } });
      assert(r.data && r.data.ok === true, 'ورود ناموفق برای ' + phone + ': ' + JSON.stringify(r.data));
      return r.data.session.token;
    };
    let teacherTok, studentTok, parentTok;
    await check('PL-02', 'ورود هر سه نقش غیرمدیر (رمز پیش‌فرض = کد ملی)', async () => {
      teacherTok = await loginAs('09120000057', '1000000057');
      studentTok = await loginAs('09120000058', '1000000058');
      parentTok = await loginAs('09120000059', '1000000059');
      return '3 sessions';
    });

    const SINCE = '1970-01-01T00:00:00.000Z';

    /* ── آزمون اصلی: هیچ فیلد رازگونه‌ای برای نقش غیرمدیر نیست ─────── */
    for (const [role, tok] of [['teacher', () => teacherTok], ['parent', () => parentTok], ['student', () => studentTok]]) {
      await check(`PL-1${role === 'teacher' ? '0' : role === 'parent' ? '1' : '2'}`, `pull users برای نقش ${role}: هیچ فیلد رمزی نیست`, async () => {
        const r = await srv.http('/api/v1/pull?since=' + encodeURIComponent(SINCE) + '&collections=users', { token: tok() });
        assert(r.status === 200, 'status=' + r.status);
        const rows = ((r.data && r.data.collections) || {}).users || [];
        assert(rows.length > 0, role + ': هیچ ردیف کاربری دریافت نشد (اسکوپ خالی)');
        const leaks = [];
        rows.forEach(u => leakedKeys(u).forEach(k => leaks.push(u.id + '.' + k)));
        assert(leaks.length === 0, 'نشت به ' + role + ': ' + leaks.join(', '));
        /* سالم بودن داده: فیلدهای شناسنامه‌ای هنوز هستند */
        const me = rows.find(u => Number(u.id) === Number(role === 'teacher' ? ids.teacher : role === 'parent' ? ids.parent : ids.student));
        assert(me && me.name && me.role === role, role + ': ردیف خودش ناقص است: ' + JSON.stringify(me));
        assert(me && me.national_id, role + ': کد ملیِ خودش دیده نمی‌شود (دادهٔ self)');
        /* P0 مرحلهٔ دوم: فیلدهای هویتیِ دیگران نباید دیده شوند —
           حتی درون اسکوپ (دانش‌آموزِ کلاسِ دبیر، فرزندِ ولی). */
        const idLeaks = [];
        rows.forEach(u => {
          if (Number(u.id) === Number(me.id)) return;
          leakedIdentityKeys(u).forEach(k => idLeaks.push(u.id + '.' + k));
        });
        assert(idLeaks.length === 0, 'نشت هویتی به ' + role + ': ' + idLeaks.join(', '));
        return `${rows.length} ردیف، همه پاک‌سازی‌شده`;
      });
    }

    /* ── والد فرزندش را می‌بیند — و بدون هیچ فیلد رمزی/هویتی ─────── */
    await check('PL-13', 'والد ردیف فرزند را می‌بیند و بدون فیلد رمزی/هویتی است', async () => {
      const r = await srv.http('/api/v1/pull?since=' + encodeURIComponent(SINCE) + '&collections=users', { token: parentTok });
      const rows = ((r.data && r.data.collections) || {}).users || [];
      const kid = rows.find(u => Number(u.id) === Number(ids.student));
      assert(kid, 'والد فرزندش را در pull نمی‌بیند');
      assert(leakedKeys(kid).length === 0, ' در ردیف فرزند فیلد راز هست: ' + leakedKeys(kid).join(', '));
      const idLeaks = leakedIdentityKeys(kid);
      assert(idLeaks.length === 0, 'ولی فیلدهای هویتی فرزند را می‌بیند: ' + idLeaks.join(', '));
      return 'child visible, no secrets, no identity fields';
    });

    /* ── دبیرِ کلاس ردیف دانش‌آموز را می‌بیند — بدون فیلدهای هویتی ── */
    await check('PL-14', 'دبیرِ کلاس ردیف دانش‌آموز را می‌بیند، فیلد هویتی ندارد', async () => {
      const r = await srv.http('/api/v1/pull?since=' + encodeURIComponent(SINCE) + '&collections=users', { token: teacherTok });
      const rows = ((r.data && r.data.collections) || {}).users || [];
      const stu = rows.find(u => Number(u.id) === Number(ids.student));
      assert(stu, 'دبیر دانش‌آموزِ کلاس خودش را در pull نمی‌بیند (اسکوپ)');
      assert(leakedIdentityKeys(stu).length === 0,
        'دبیر فیلدهای هویتی دانش‌آموز را می‌بیند: ' + leakedIdentityKeys(stu).join(', '));
      assert(stu.name && Number(stu.class_id) === Number(ids.class), 'ردیف دانش‌آموز ناقص است');
      return 'student in scope, identity scrubbed';
    });

    /* ── مسیر پروندهٔ دانش‌آموز: دبیر می‌بیند ولی بدون هویتی‌ها ──── */
    await check('PL-15', '/api/students/:id برای دبیر: فیلد هویتی نیست', async () => {
      const r = await srv.http('/api/students/' + ids.student, { token: teacherTok });
      assert(r.status === 200, 'دبیر به پروندهٔ دانش‌آموز دسترسی ندارد: status=' + r.status);
      const stu = (r.data && r.data.student) || {};
      assert(stu.name, 'پروندهٔ دانش‌آموز خالی است');
      const idLeaks = leakedIdentityKeys(stu);
      assert(idLeaks.length === 0, 'دبیر از مسیر /api/students/:id فیلدهای هویتی می‌بیند: ' + idLeaks.join(', '));
      return 'identity scrubbed on student endpoint';
    });

    /* ── بستهٔ گوشی (outbox.personData): خودش کامل، فرزند مینیمال ─── */
    await check('PL-16', 'outbox.personData: me هویتیِ خودش را دارد، children مینیمال', async () => {
      const outbox = require(path.join(ROOT, 'server', 'outbox.js'));
      /* بدون پایگاه داده: روی یک سناریوی فرضی بررسی می‌کنیم */
      const fakeStore = {
        all: (c) => c === 'parent_links' ? [{ parent_id: 5, student_id: 7 }] : [],
        get: (c, id) => {
          if (c !== 'users') return null;
          if (Number(id) === 5) return { id: 5, name: 'ولی', role: 'parent', phone: '0912', national_id: 'NID5', address: 'ADR' };
          if (Number(id) === 7) return { id: 7, name: 'فرزند', role: 'student', national_id: 'NID7', phone: '0913' };
          return null;
        },
      };
      const pd = outbox.personData(fakeStore, { id: 5, role: 'parent', active: true });
      assert(pd.me && pd.me.national_id === 'NID5', 'me: هویتیِ خودش باید بماند');
      assert(pd.me && pd.me.address === 'ADR', 'me: نشانیِ خودش باید بماند');
      assert(!leakedKeys(pd.me).length, 'me: فیلد راز دارد: ' + leakedKeys(pd.me).join(','));
      assert(Array.isArray(pd.children) && pd.children.length === 1, 'children: فرزند نیست');
      const kid = pd.children[0];
      assert(!('national_id' in kid) && !('phone' in kid) && !('address' in kid),
        'children: فیلد هویتی دارد: ' + Object.keys(kid).join(','));
      return 'me=self identity, children minimal';
    });

    /* ── کنترل مثبت: مدیر همچنان رمزها و هویتی‌ها را می‌بیند ──────── */
    await check('PL-20', 'کنترل مثبت: مدیر password_hash، password_enc و national_id را می‌بیند', async () => {
      const r = await srv.http('/api/v1/pull?since=' + encodeURIComponent(SINCE) + '&collections=users', { token: managerToken });
      const rows = ((r.data && r.data.collections) || {}).users || [];
      const mgr = rows.find(u => Number(u.id) === 1);
      assert(mgr, 'ردیف مدیر در pull نیست');
      assert(mgr.password_hash, 'مدیر password_hash را نمی‌بیند (کنترل مثبت شکست خورد)');
      assert(mgr.password_enc, 'مدیر password_enc را نمی‌بیند (کنترل مثبت شکست خورد)');
      /* کنترل مثبتِ هویتی: پاک‌سازی فقط نقش‌محور است، نه حذفِ کلی */
      const stu = rows.find(u => Number(u.id) === Number(ids.student));
      assert(stu && stu.national_id === '1000000058', 'مدیر national_id دانش‌آموز را نمی‌بیند');
      assert(stu && stu.father_nid === '2000000058', 'مدیر father_nid دانش‌آموز را نمی‌بیند');
      assert(stu && stu.shenasname_serial === '۵۶۷۸۹', 'مدیر shenasname_serial را نمی‌بیند');
      return 'manager keeps full user rows';
    });

    /* ── مسیر خروجی CSV: هم بسته‌شدن و هم نقش‌بندی ───────────────── */
    await check('PL-30', 'خروجی CSV: نقش غیرمدیر ۴۰۳ است', async () => {
      const r = await srv.http('/api/admin/export?collection=users', { token: teacherTok });
      assert(r.status === 403, 'دبیر export گرفت: status=' + r.status);
      return '403 for teacher';
    });
    await check('PL-31', 'خروجی CSV مدیر: هیچ(password_enc|password_hash|phone_hash) در متن نیست', async () => {
      const r = await srv.http('/api/admin/export?collection=users', { token: managerToken, raw: true });
      assert(r.status === 200, 'status=' + r.status);
      const txt = r.text || '';
      assert(!/password_enc|password_hash|password_plain|phone_hash|__password_verifier/.test(txt),
        'رمز در CSV هست: ' + txt.split('\n')[0]);
      assert(/national_id/.test(txt), 'کد ملی (فیلد شناسنامه‌ای) در CSV managerial هست');
      return 'csv clean, identity fields kept';
    });

    /* ── S4: /api/health مسیر سرور را لو نمی‌دهد ─────────────────── */
    await check('PL-40', 'S4: /api/health بدون data_dir/db_file و بدون مسیر مطلق', async () => {
      const r = await srv.http('/api/health', { raw: true });
      assert(r.status === 200, 'status=' + r.status);
      const j = r.data || JSON.parse(r.text);
      assert(!('data_dir' in j), 'data_dir هنوز در /api/health هست');
      assert(!('db_file' in j), 'db_file هنوز در /api/health هست');
      assert(!r.text.includes(WORK) && !r.text.includes(dataDir), 'مسیر مطلق سرور در پاسخ هست: ' + r.text);
      assert(j.ok === true && 'public_url' in j, 'ساختار پاسخ سلامت خراب شد');
      return 'health clean';
    });

    /* ── S4: /metrics بدون توکن ۴۰۱، با توکن ۲۰۰ ───────────────── */
    await check('PL-50', 'S4: /metrics بدون توکن ۴۰۱ می‌گیرد (سرور محصول)', async () => {
      const r = await srv.http('/metrics', { raw: true });
      assert(r.status === 401, 'metrics بدون توکن ۲۰۰ داد: status=' + r.status);
      return '401';
    });
    await check('PL-51', 'S4: /metrics با توکن (هدر و کوئری) ۲۰۰ می‌دهد', async () => {
      const h = await srv.http('/metrics', { token: METRICS_TOKEN, raw: true });
      assert(h.status === 200, 'metrics با Bearer: status=' + h.status);
      assert(/payesh_up/.test(h.text), 'متن متریک نیست');
      const q = await srv.http('/metrics?token=' + METRICS_TOKEN, { raw: true });
      assert(q.status === 200, 'metrics با ?token: status=' + q.status);
      return '200 header+query';
    });

    /* ── همان در Gateway ابری ───────────────────────────────────── */
    await check('PL-60', 'S4: Gateway /metrics با توکن ۴۰۱/۲۰۰ می‌دهد', async () => {
      const gwData = path.join(WORK, 'gw');
      fs.mkdirSync(gwData, { recursive: true });
      const gw = await new Proc('server/gateway.js', gwData, { PGURL: '', GW_SECRET: '', PAYESH_METRICS_TOKEN: METRICS_TOKEN }).start();
      try {
        const h = await gw.http('/healthz', { raw: true });
        assert(h.status === 200, 'gateway healthz=' + h.status);
        const no = await gw.http('/metrics', { raw: true });
        assert(no.status === 401, 'gateway metrics بدون توکن: status=' + no.status);
        const yes = await gw.http('/metrics', { token: METRICS_TOKEN, raw: true });
        assert(yes.status === 200 && /payesh_up/.test(yes.text), 'gateway metrics با توکن ۲۰۰ نیست');
        return 'gateway 401/200';
      } finally { await gw.kill(); }
    });

    /* ─ـ درGate بدون توکن (همان پیش‌فرض قبلی) باز است ───────────── */
    await check('PL-61', 'Gateway /metrics بدون تنظیم توکن باز می‌ماند (بدون رگرسیون)', async () => {
      const gwData = path.join(WORK, 'gw2');
      fs.mkdirSync(gwData, { recursive: true });
      const gw = await new Proc('server/gateway.js', gwData, { PGURL: '', GW_SECRET: '' }).start();
      try {
        const r = await gw.http('/metrics', { raw: true });
        assert(r.status === 200, 'gateway metrics (بی‌توکن) باید باز باشد: status=' + r.status);
        return '200 as before';
      } finally { await gw.kill(); }
    });

    /* ── یکپارچگی allowlist با policy ──────────────────────────── */
    await check('PL-70', 'policy.scrubUser: فقط فیلدهای مجاز می‌مانند', async () => {
      const out = policy.scrubUser({
        id: 1, name: 'x', national_id: '1', password_hash: 'h', password_enc: 'enc:v1:x',
        phone_hash: 'h', password_plain: 'p', __password_verifier: 'v', secret: 's',
        token: 't', pin_hash: 'p', school_id: 1,
        _version: 3, father_name: 'اکبر', phone: '0912', address: 'نشانی',
      });
      const keys = Object.keys(out).sort().join(',');
      assert(!/password|phone_hash|verifier|secret|token|pin/.test(keys), 'فیلد رازگونه باقی ماند: ' + keys);
      assert(out._version === 3, '_version حفظ نشد');
      assert(out.father_name === 'اکبر', 'فیلد تکمیلی حذف شد');
      /* مرحلهٔ دوم (P0): هویتی‌ها در حالت پیش‌فرض حذف می‌شوند */
      assert(!('national_id' in out) && !('phone' in out) && !('address' in out),
        'فیلد هویتی در حالت پیش‌فرض باقی ماند: ' + keys);
      /* keepIdentity فقط برای ردیف خودِ کاربر */
      const self = policy.scrubUser({ id: 1, national_id: '1', phone: '0912', address: 'ن' }, { keepIdentity: true });
      assert(self.national_id === '1' && self.phone === '0912', 'keepIdentity کار نمی‌کند');
      /* scrubUserFor: ردیف خودش vs ردیف دیگران */
      const forSelf = policy.scrubUserFor({ id: 1 }, { id: 1, national_id: '1', phone: '0912' });
      const forOther = policy.scrubUserFor({ id: 1 }, { id: 2, national_id: '2', phone: '0913' });
      assert(forSelf.national_id === '1', 'scrubUserFor: ردیف خودش باید هویتی داشته باشد');
      assert(!('national_id' in forOther) && !('phone' in forOther), 'scrubUserFor: ردیف دیگران هویتی دارد');
      return keys;
    });
  } finally {
    await srv.kill();
  }

  console.log(`\nPL checks=${passed + failed} pass=${passed} fail=${failed}`);
  if (failures.length) console.log('failures: ' + failures.join(', '));
  console.log(failed === 0 ? 'PULL-LEAK-57-OK' : 'PULL-LEAK-57-FAILED');
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', (e && e.stack) || e); process.exit(1); });
