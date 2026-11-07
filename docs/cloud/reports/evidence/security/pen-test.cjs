#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   Security Gate — ردیف ۲۸ · آزمون نفوذ مستقل روی مسیرهای محصول
   ───────────────────────────────────────────────────────────────────
   این هارنس به‌جای «باور به مستند»، خودِ محصول را بالا می‌آورد و از
   بیرون (HTTP) به آن حمله می‌کند. هر بررسی یک حکم PASS/FAIL چاپ می‌کند
   و هیچ بررسی‌ای «فرضی» نیست.

   دامنه (طبق AC ردیف ۲۸):
     auth/session · authorization · tenant · storage · outbox · restore ·
     cache · export  — همراه IDOR و privilege escalation.

   اجرا:  node --experimental-sqlite docs/cloud/reports/evidence/security/pen-test.cjs
   خروجی: docs/cloud/reports/evidence/security-penetration.txt (با --out)
   ═══════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../../../../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-sec-'));
const DB = path.join(TMP, 'payesh.sqlite');
const OUT = (() => {
  const i = process.argv.indexOf('--out');
  return i > 0 ? path.resolve(process.argv[i + 1]) : null;
})();

let PORT = 0;
let BASE = '';
const LINES = [];
let PASS = 0, FAIL = 0, SKIP = 0;
const RESULTS = [];

function log(s) { LINES.push(s); if (!OUT) console.log(s); }
function ok(id, title, detail) {
  PASS++;
  RESULTS.push({ id, title, verdict: 'PASS', detail: detail || null });
  log(`PASS  ${id}  ${title}${detail ? '  → ' + detail : ''}`);
}
function bad(id, title, detail) {
  FAIL++;
  RESULTS.push({ id, title, verdict: 'FAIL', detail: detail || null });
  log(`FAIL  ${id}  ${title}${detail ? '  → ' + detail : ''}`);
}
function skip(id, title, why) {
  SKIP++;
  RESULTS.push({ id, title, verdict: 'SKIP', detail: why || null });
  log(`SKIP  ${id}  ${title}  → ${why || ''}`);
}
function check(id, title, cond, detail) { cond ? ok(id, title, detail) : bad(id, title, detail); }

async function freePort() {
  return new Promise(res => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

async function req(pathname, opts = {}) {
  const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
  if (opts.token) headers.authorization = 'Bearer ' + opts.token;
  const res = await fetch(BASE + pathname, {
    method: opts.method || 'GET', headers,
    body: opts.body === undefined ? undefined : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)),
    redirect: 'manual',
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  return { status: res.status, data, text, headers: res.headers };
}

async function waitUp() {
  for (let i = 0; i < 200; i++) {
    try { const r = await req('/api/health'); if (r.data && r.data.ok) return true; } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('server did not start');
}

/* ── صندوقچهٔ ابری جعلی (SigV4 ساده) تا مسیرهای outbox/storage آزموده شوند ── */
function fakeS3() {
  const bucket = new Map();
  const srv = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', c => chunks.push(c));
    rq.on('end', () => {
      const u = new URL(rq.url, 'http://x');
      const signed = u.searchParams.has('X-Amz-Signature');
      if (!signed && !/^AWS4-HMAC-SHA256/.test(rq.headers.authorization || '')) {
        rs.writeHead(403); return rs.end('<Error><Code>AccessDenied</Code></Error>');
      }
      rs.setHeader('access-control-allow-origin', '*');
      const p = decodeURIComponent(u.pathname);
      if (p === '/' && rq.method === 'GET') {
        rs.writeHead(200, { 'content-type': 'application/xml' });
        return rs.end('<?xml version="1.0"?><ListAllMyBucketsResult><Buckets><Bucket><Name>sec1</Name></Bucket></Buckets></ListAllMyBucketsResult>');
      }
      if (!p.startsWith('/sec1')) { rs.writeHead(404); return rs.end('<Error><Code>NoSuchBucket</Code></Error>'); }
      if (u.searchParams.has('cors')) { rs.writeHead(200, { 'content-type': 'application/xml' }); return rs.end('<CORSConfiguration/>'); }
      const key = p.slice(5).replace(/^\//, '');
      if (rq.method === 'PUT' && key) { bucket.set(key, Buffer.concat(chunks).toString()); rs.writeHead(200); return rs.end(); }
      if (rq.method === 'GET' && !key) {
        const prefix = u.searchParams.get('prefix') || '';
        const keys = [...bucket.keys()].filter(x => x.startsWith(prefix)).sort();
        rs.writeHead(200, { 'content-type': 'application/xml' });
        return rs.end('<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
          keys.map(x => '<Contents><Key>' + x + '</Key><Size>' + bucket.get(x).length + '</Size></Contents>').join('') +
          '</ListBucketResult>');
      }
      if (rq.method === 'GET' && key) {
        if (!bucket.has(key)) { rs.writeHead(404); return rs.end('<Error><Code>NoSuchKey</Code></Error>'); }
        rs.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
        return rs.end(bucket.get(key));
      }
      if (rq.method === 'DELETE' && key) { bucket.delete(key); rs.writeHead(204); return rs.end(); }
      rs.writeHead(400); rs.end('bad');
    });
  });
  srv.keepAliveTimeout = 0;
  return new Promise(res => srv.listen(0, '127.0.0.1', () => res({ srv, bucket, port: srv.address().port })));
}

/* علامت هش/رمز که هرگز نباید در پاسخ‌ها دیده شود */
const SECRET_MARKS = /accessKey|secret_key|"secret"|password_hash|phone_hash|BEGIN PRIVATE KEY|AKIA[0-9A-Z]{12,}/i;

(async () => {
  const started = new Date().toISOString();
  const s3 = await fakeS3();
  PORT = await freePort();
  BASE = 'http://127.0.0.1:' + PORT;
  const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST: '127.0.0.1', PAYESH_DATA: TMP, PAYESH_LOG: '0',
      PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0',
      PAYESH_LIVE_MS: '0', PAYESH_OUTBOX_AUTO: '0', PAYESH_CLOUD_AUTO: '0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let fail = null;
  let childLog = '';
  child.stdout.on('data', d => { childLog += String(d); });
  child.stderr.on('data', d => { childLog += String(d); if (process.env.VERBOSE) process.stderr.write(d); });

  const cleanup = () => {
    try { child.kill('SIGKILL'); } catch (e) { /* */ }
    try { s3.srv.close(); } catch (e) { /* */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* */ }
  };

  try {
    await waitUp();

    /* ── ۰) زمینه: مدیر، دبیر، ولی، دانش‌آموز ─────────────────────────── */
    const MGR_PW = 'Sec-Mgr-1404';
    const setup = await req('/api/setup', { method: 'POST', body: {
      school_name: 'دبیرستان امنیت', manager_name: 'مدیر امنیت', password: MGR_PW, phone: '09121110000',
    } });
    if (!setup.data || !setup.data.ok) throw new Error('setup failed: ' + setup.text.slice(0, 200));
    let mgrTok = setup.data.session.token;

    /* کاربران آزمون با نوشتنِ مدیر ساخته می‌شوند (همان مسیر محصول) */
    const mk = (uid, data) => ({ uid, collection: 'users', type: 'put', data, base_version: 0 });
    const mkRes = await req('/api/sync', { method: 'POST', token: mgrTok, body: { ops: [
      mk('sec-u-teacher', { name: 'دبیر امنیت', role: 'teacher', phone: '09121110001', active: true }),
      mk('sec-u-parent', { name: 'ولی امنیت', role: 'parent', phone: '09121110002', active: true }),
      mk('sec-u-student', { name: 'دانش‌آموز امنیت', role: 'student', phone: '09121110003', active: true, class_id: 1 }),
      mk('sec-u-student2', { name: 'دانش‌آموز دیگر', role: 'student', phone: '09121110004', active: true, class_id: 2 }),
      mk('sec-u-temp', { name: 'کاربر موقت', role: 'teacher', phone: '09121110005', active: true }),
    ] } });
    if (!mkRes.data || !(mkRes.data.applied || []).length) {
      throw new Error('user seed rejected: ' + mkRes.text.slice(0, 400));
    }

    const mgrPull0 = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&collections=users,parent_links', { token: mgrTok });
    let users0 = ((mgrPull0.data || {}).collections || {}).users || [];
    const byPhone = ph => users0.find(u => String(u.phone || '') === ph);
    const teacher = byPhone('09121110001');
    const parent = byPhone('09121110002');
    const student = byPhone('09121110003');
    const otherStudent = byPhone('09121110004');
    const tempUser = byPhone('09121110005');
    if (!users0.length) throw new Error('pull returned no users: ' + mgrPull0.text.slice(0, 300));
    if (!teacher || !parent || !student || !otherStudent || !tempUser) {
      throw new Error('users not created: ' + JSON.stringify(users0.map(u => [u.id, u.role, u.phone])));
    }

    /* پیوند ولی↔فرزند (فقط فرزند خودش) */
    const linkRes = await req('/api/sync', { method: 'POST', token: mgrTok, body: { ops: [
      { uid: 'sec-link-1', collection: 'parent_links', type: 'put', data: { parent_id: Number(parent.id), student_id: Number(student.id), relation: 'father' }, base_version: 0 },
    ] } });
    const links0 = (((await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&collections=parent_links', { token: mgrTok })).data || {}).collections || {}).parent_links || [];
    const myKids = new Set(links0.filter(l => Number(l.parent_id) === Number(parent.id)).map(l => Number(l.student_id)));
    const ownKid = Number(student.id);
    const foreignStudent = otherStudent;

    const pair = async id => {
      const c = await req('/api/admin/pair-code', { method: 'POST', token: mgrTok, body: { user_id: id } });
      const s = await req('/api/auth/pair', { method: 'POST', body: { code: c.data.code } });
      return s.data.session.token;
    };
    const teacherTok = await pair(teacher.id);
    const parentTok = await pair(parent.id);
    const studentTok = await pair(student.id);

    /* ══ A) auth/session ══════════════════════════════════════════════ */
    const wrongPw = await req('/api/auth/login', { method: 'POST', body: { phone: '09121110000', password: 'ghalat-1404' } });
    check('S-01', 'رمز اشتباه ⇒ 401 و بدون نشست', wrongPw.status === 401 && !(wrongPw.data && wrongPw.data.session),
      'status=' + wrongPw.status);

    const goodLogin = await req('/api/auth/login', { method: 'POST', body: { phone: '09121110000', password: MGR_PW } });
    const tokA = goodLogin.data && goodLogin.data.session && goodLogin.data.session.token;
    check('S-02', 'ورود درست نشست می‌دهد', !!tokA, tokA ? 'token-length=' + tokA.length : 'no token');

    const tampered = tokA.slice(0, -1) + (tokA.slice(-1) === 'a' ? 'b' : 'a');
    const tamperedRes = await req('/api/me', { token: tampered });
    check('S-03', 'توکن دست‌کاری‌شده ⇒ 401', tamperedRes.status === 401, 'status=' + tamperedRes.status);

    const bogus = crypto.randomBytes(24).toString('hex');
    const bogusRes = await req('/api/me', { token: bogus });
    check('S-04', 'توکن ساختگی ⇒ 401', bogusRes.status === 401, 'status=' + bogusRes.status);

    const noTok = await req('/api/me');
    check('S-05', 'بدون توکن ⇒ 401', noTok.status === 401, 'status=' + noTok.status);

    /* ابطال با logout */
    const tokB = (await req('/api/auth/login', { method: 'POST', body: { phone: '09121110000', password: MGR_PW } })).data.session.token;
    const meB = await req('/api/me', { token: tokB });
    const outB = await req('/api/auth/logout', { method: 'POST', token: tokB, body: {} });
    const meAfter = await req('/api/me', { token: tokB });
    check('S-06', 'نشست پس از logout باطل می‌شود',
      meB.status === 200 && outB.status === 200 && meAfter.status === 401,
      `before=${meB.status} logout=${outB.status} after=${meAfter.status}`);

    /* ابطال همه با revoke-all */
    const tokC = (await req('/api/auth/login', { method: 'POST', body: { phone: '09121110000', password: MGR_PW } })).data.session.token;
    const rv = await req('/api/auth/revoke-all', { method: 'POST', token: tokC, body: {} });
    const meC = await req('/api/me', { token: tokC });
    check('S-07', 'revoke-all نشست‌های قبلی را باطل می‌کند',
      rv.status === 200 && meC.status === 401, `revoke=${rv.status} after=${meC.status}`);

    /* نشستِ منقضی در پایگاه‌داده ⇒ رد */
    mgrTok = (await req('/api/auth/login', { method: 'POST', body: { phone: '09121110000', password: MGR_PW } })).data.session.token;
    const expTok = (await req('/api/auth/login', { method: 'POST', body: { phone: '09121110000', password: MGR_PW } })).data.session.token;
    const expHash = crypto.createHash('sha256').update(expTok).digest('hex');
    const { openStore } = require(path.join(ROOT, 'server', 'db.js'));
    const db2 = openStore(DB);
    db2.db.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').run('2000-01-01T00:00:00.000Z', expHash);
    const expRes = await req('/api/me', { token: expTok });
    check('S-08', 'نشست منقضی ⇒ 401', expRes.status === 401, 'status=' + expRes.status);

    /* کاربر غیرفعال ⇒ نشستش بی‌اثر می‌شود */
    const disTok = (await req('/api/admin/pair-code', { method: 'POST', token: mgrTok, body: { user_id: tempUser.id } })).data.code;
    if (!disTok) throw new Error('pair code for temp user failed: ' + (await req('/api/admin/pair-code', { method: 'POST', token: mgrTok, body: { user_id: tempUser.id } })).text.slice(0, 200));
    const disSession = (await req('/api/auth/pair', { method: 'POST', body: { code: disTok } })).data.session.token;
    const beforeDis = await req('/api/me', { token: disSession });
    db2.db.prepare('UPDATE records SET data=? WHERE collection=? AND id=?').run(
      JSON.stringify(Object.assign({}, tempUser, { active: false })), 'users', Number(tempUser.id));
    const afterDis = await req('/api/me', { token: disSession });
    check('S-09', 'کاربر غیرفعال‌شده فوراً از دسترسی می‌افتد',
      beforeDis.status === 200 && afterDis.status === 401, `before=${beforeDis.status} after=${afterDis.status}`);

    /* نرخ‌محدودی ورود */
    let limited = false;
    for (let i = 0; i < 26; i++) {
      const r = await req('/api/auth/login', { method: 'POST', body: { phone: '09121110000', password: 'bad-' + i } });
      if (r.status === 429) { limited = true; break; }
    }
    check('S-10', 'حملهٔ حدس رمز محدود می‌شود (429)', limited, limited ? '429 seen' : 'no 429 after 26 tries');

    /* ══ B) authorization / privilege escalation ═════════════════════ */
    const tAdmin = await req('/api/admin/settings', { method: 'POST', token: teacherTok, body: { name: 'x' } });
    check('S-11', 'دبیر به تنظیمات مدیریتی دسترسی ندارد', tAdmin.status === 403, 'status=' + tAdmin.status);

    const tExport = await req('/api/admin/export?collection=users', { token: teacherTok });
    check('S-12', 'دبیر به خروجی CSV کاربران دسترسی ندارد', tExport.status === 403, 'status=' + tExport.status);

    const tCreds = await req('/api/admin/users/credentials', { token: teacherTok });
    check('S-13', 'دبیر گاوصندوق رمزها را نمی‌بیند', tCreds.status === 403, 'status=' + tCreds.status);

    /* ارتقای نقش از راه بدنه: دبیر می‌خواهد مدیر بسازد */
    const before = (await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&collections=users', { token: mgrTok })).data.collections.users;
    const mgrCountBefore = before.filter(u => u.role === 'manager').length;
    const esc = await req('/api/sync', { method: 'POST', token: teacherTok, body: {
      ops: [{ uid: 'sec-esc-1', collection: 'users', type: 'put', data: { name: 'مدیر جعلی', role: 'manager', active: true, phone: '09129999999', national_id: '1999999999' }, base_version: 0 }],
    } });
    const after = (await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&collections=users', { token: mgrTok })).data.collections.users;
    const mgrCountAfter = after.filter(u => u.role === 'manager').length;
    check('S-14', 'ارتقای نقش با نوشتن مستقیم (privilege escalation) رد می‌شود',
      mgrCountAfter === mgrCountBefore, `managers ${mgrCountBefore}→${mgrCountAfter} rejected=${JSON.stringify((esc.data || {}).rejected || []).slice(0, 120)}`);

    const pDrain = await req('/api/outbox/drain', { method: 'POST', token: parentTok, body: {} });
    check('S-15', 'ولی اجازهٔ drain صندوقچه ندارد', pDrain.status === 403, 'status=' + pDrain.status);

    /* ══ C) IDOR ══════════════════════════════════════════════════════ */
    const idor1 = await req('/api/students/' + foreignStudent.id, { token: parentTok });
    check('S-16', 'IDOR: ولی پروندهٔ دانش‌آموز غیرمرتبط را نمی‌بیند', idor1.status === 403, 'status=' + idor1.status);

    const idor2 = await req('/api/outbox/snapshot?student_id=' + foreignStudent.id, { token: parentTok });
    check('S-17', 'IDOR: خلاصهٔ دانش‌آموز غیرمرتبط ۴۰۳', idor2.status === 403, 'status=' + idor2.status);

    const ownRead = ownKid ? await req('/api/students/' + ownKid, { token: parentTok }) : { status: 0 };
    check('S-18', 'ولی فرزند خودش را می‌بیند (شاهدِ مثبت IDOR)', ownKid && ownRead.status !== 403,
      'own=' + ownKid + ' status=' + ownRead.status);

    const stWrite = await req('/api/sync', { method: 'POST', token: studentTok, body: {
      ops: [{ uid: 'sec-st-1', collection: 'grades', type: 'put', data: { student_id: Number(student.id), value: 20 }, base_version: 0 }],
    } });
    const stApplied = ((stWrite.data || {}).applied || []).length;
    check('S-19', 'دانش‌آموز نمی‌تواند نمره بنویسد', stApplied === 0,
      'applied=' + stApplied + ' rejected=' + JSON.stringify((stWrite.data || {}).rejected || []).slice(0, 120));

    const stUsers = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&collections=users', { token: studentTok });
    const stRows = ((stUsers.data || {}).collections || {}).users || [];
    const leaksStaff = stRows.some(u => ['manager', 'teacher', 'staff', 'vice'].includes(u.role) && u.id !== Number(student.id));
    check('S-20', 'دانش‌آموز فهرست کامل کارکنان را نمی‌گیرد', !leaksStaff,
      'rows=' + stRows.length + ' roles=' + JSON.stringify([...new Set(stRows.map(u => u.role))]));

    /* ══ D) storage / phone tickets ══════════════════════════════════ */
    const setCloud = await req('/api/admin/cloud', { method: 'POST', token: mgrTok, body: {
      endpoint: 'http://127.0.0.1:' + s3.port, bucket: 'sec1', region: 'ir-central1',
      accessKey: 'AKSEC', secret: 'SKSECRET-VALUE', prefix: 'payesh/',
    } });
    check('S-21', 'پیکربندی صندوقچه با مدیر انجام می‌شود', setCloud.data && setCloud.data.ok, 'ok=' + !!(setCloud.data && setCloud.data.ok));

    const cfgRes = await req('/api/cloud/config', { token: mgrTok });
    check('S-22', 'پاسخ پیکربندی ابری هیچ کلید/رمزی برنمی‌گرداند', !SECRET_MARKS.test(cfgRes.text),
      'leak=' + (cfgRes.text.match(SECRET_MARKS) || ['none'])[0]);

    const phoneLogin = await req('/api/phone/login', { method: 'POST', body: { phone: '09121110000', password: MGR_PW, device_id: 'sec-dev-1' } });
    const phoneText = JSON.stringify(phoneLogin.data || {});
    const ticketOk = phoneLogin.status === 200 && phoneLogin.data && phoneLogin.data.ok;
    check('S-23', 'ورود گوشی بدون هیچ کلید ذخیره‌سازی انجام می‌شود', ticketOk && !SECRET_MARKS.test(phoneText),
      'leak=' + (phoneText.match(SECRET_MARKS) || ['none'])[0]);

    const ttlDays = (() => {
      const dt = phoneLogin.data && phoneLogin.data.device_ticket;
      const exp = dt && dt.expires_at;
      if (!exp) return null;
      return Math.round((Date.parse(exp) - Date.now()) / 86400000);
    })();
    check('S-24', 'عمر تیکت دستگاه ≤ ۲۰۰ روز (تصمیم مالک)',
      ttlDays !== null && ttlDays > 0 && ttlDays <= 201, 'ttl_days=' + ttlDays);

    const coreGet = phoneLogin.data && phoneLogin.data.tickets && phoneLogin.data.tickets.core_get;
    check('S-25', 'تیکت فایل فقط به کلید مشخص و بدون رمز صادر می‌شود',
      !!coreGet && !/secret/i.test(JSON.stringify(coreGet)),
      coreGet ? 'key=' + coreGet.key + ' expires=' + coreGet.expires_at : 'no ticket');

    const baked = fs.readFileSync(path.join(ROOT, 'client', 'cloud-baked.js'), 'utf8');
    check('S-26', 'باندل کلاینت هیچ اعتبارنامهٔ ذخیره‌سازی ندارد (D‑23)', !SECRET_MARKS.test(baked),
      'leak=' + (baked.match(SECRET_MARKS) || ['none'])[0]);

    /* ══ E) outbox ═══════════════════════════════════════════════════ */
    const subNoAuth = await req('/api/outbox/submit', { method: 'POST', body: { items: [] } });
    check('S-27', 'ثبت در صندوقچه بدون نشست/تیکت ⇒ 401', subNoAuth.status === 401, 'status=' + subNoAuth.status);

    s3.bucket.set('payesh/outbox/pending/sec-forged.json', JSON.stringify({
      v: 2, user_id: 1, role: 'manager', tenant_id: 1, school_id: 1, device_id: 'forged',
      issued_at: '2026-01-01T00:00:00.000Z', sig: 'A'.repeat(43),
      items: [{ uid: 'sec-forged-1', op: { collection: 'announcements', type: 'put', data: { title: 'جعلی امنیتی', date: '2026-01-01' } } }],
    }));
    const drain1 = await req('/api/outbox/drain', { method: 'POST', token: mgrTok, body: {} });
    const applied1 = (drain1.data || {}).applied;
    const quarantined = s3.bucket.has('payesh/outbox/quarantine/sec-forged.json');
    check('S-28', 'پاکت جعلی صندوقچه اعمال نمی‌شود و قرنطینه می‌گردد',
      applied1 === 0 && quarantined, `applied=${applied1} quarantined=${quarantined}`);

    const spoof = await req('/api/outbox/submit', { method: 'POST', token: teacherTok, body: {
      user_id: 1, role: 'manager', tenant_id: 9, school_id: 9,
      items: [{ uid: 'sec-spoof-1', op: { collection: 'leaves', type: 'put', data: { student_id: Number(ownKid || otherStudent.id), date: '2026-02-01', reason: 'spoof', status: 'pending', school_id: 9 } } }],
    } });
    const devFiles = [...s3.bucket.keys()].filter(k => /^payesh\/outbox\/pending\/device-.*\.json$/.test(k) && String(s3.bucket.get(k)).includes('sec-spoof-1'));
    const spoofEnv = devFiles.length ? JSON.parse(s3.bucket.get(devFiles[0])) : null;
    check('S-29', 'ادعای هویت/مستأجر کلاینت در پاکت نمی‌نشیند',
      !!spoofEnv && Number(spoofEnv.user_id) === Number(teacher.id) && Number(spoofEnv.school_id) === 1
        && Number((spoof.data || {}).ignored_claims ? (spoof.data.ignored_claims.length) : 0) >= 1,
      spoofEnv ? `env.user=${spoofEnv.user_id} env.school=${spoofEnv.school_id} ignored=${((spoof.data || {}).ignored_claims || []).join(',')}` : 'no device file');

    /* ══ F) restore / backup ═════════════════════════════════════════ */
    const tRestore = await req('/api/admin/restore', { method: 'POST', token: teacherTok, body: { data: {} } });
    check('S-30', 'دبیر نمی‌تواند بازیابی کند', tRestore.status === 403, 'status=' + tRestore.status);

    const trav = await req('/api/admin/backups/' + encodeURIComponent('../payesh.sqlite'), { token: mgrTok });
    check('S-31', 'پیمایش مسیر در دانلود بکاپ بسته است', trav.status === 404 || trav.status === 400,
      'status=' + trav.status);

    const bkBak = await req('/api/admin/backup', { method: 'POST', token: mgrTok, body: {} });
    const usersBeforeRestore = (await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&collections=users', { token: mgrTok })).data.collections.users.length;
    const badRestore = await req('/api/admin/restore', { method: 'POST', token: mgrTok, body: { data: { collections: { users: 'not-an-array' } } } });
    const usersAfterRestore = (await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&collections=users', { token: mgrTok })).data.collections.users.length;
    check('S-32', 'بازیابیِ خراب داده را پاک نمی‌کند (نسخهٔ ایمنی + خطای کنترل‌شده)',
      bkBak.data && bkBak.data.ok && badRestore.status === 400 && usersAfterRestore === usersBeforeRestore,
      `backup=${bkBak.status} restore=${badRestore.status} users ${usersBeforeRestore}→${usersAfterRestore}`);

    /* ══ G) cache / export ═══════════════════════════════════════════ */
    const expMgr = await req('/api/admin/export?collection=users', { token: mgrTok });
    const csv = expMgr.text || '';
    check('S-33', 'خروجی CSV مدیر هیچ هش/رمز/کلیدی ندارد',
      expMgr.status === 200 && !SECRET_MARKS.test(csv) && !/password_hash|phone_hash/.test(csv),
      'status=' + expMgr.status + ' bytes=' + csv.length);

    const badColl = await req('/api/admin/export?collection=__nope__', { token: mgrTok });
    check('S-34', 'خروجی مجموعهٔ ناشناس بسته است', badColl.status === 400, 'status=' + badColl.status);

    const meRes = await req('/api/me', { token: mgrTok });
    check('S-35', 'پاسخ /api/me هیچ هش/رازی ندارد', !SECRET_MARKS.test(meRes.text),
      'leak=' + (meRes.text.match(SECRET_MARKS) || ['none'])[0]);

    const cachePull = await req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&collections=users', { token: teacherTok });
    check('S-36', 'کش همگام‌سازی هش رمز/تلفن ندارد', !SECRET_MARKS.test(cachePull.text),
      'leak=' + (cachePull.text.match(SECRET_MARKS) || ['none'])[0]);

    /* ══ H) نشتِ خطا و سرآیندها ══════════════════════════════════════ */
    const badJson = await req('/api/auth/login', { method: 'POST', body: '{not-json' });
    check('S-37', 'بدنهٔ خراب ⇒ خطای کنترل‌شده بدون ردپای سرور',
      [400, 401].includes(badJson.status) && !/\/home\/|at Object\.|node:internal/.test(badJson.text),
      'status=' + badJson.status);

    const hdr = await req('/api/health');
    const hOk = hdr.headers.get('referrer-policy') === 'no-referrer'
      && /geolocation=\(\)/.test(hdr.headers.get('permissions-policy') || '')
      && hdr.headers.get('x-content-type-options') === 'nosniff';
    check('S-38', 'سرآیندهای امنیتی پایه روی پاسخ‌ها هستند', hOk,
      `ref=${hdr.headers.get('referrer-policy')} perm=${(hdr.headers.get('permissions-policy') || '').slice(0, 24)} nosniff=${hdr.headers.get('x-content-type-options')}`);

    const corsAny = hdr.headers.get('access-control-allow-origin');
    check('S-39', 'CORS با اعتبارنامهٔ وحشی باز نیست',
      !(corsAny === '*' && hdr.headers.get('access-control-allow-credentials') === 'true'),
      `acao=${corsAny || 'none'} creds=${hdr.headers.get('access-control-allow-credentials') || 'none'}`);

    const noStore = await req('/api/admin/users/credentials', { token: mgrTok });
    check('S-40', 'گاوصندوق رمزها فقط با مدیر و بدون کش شدن',
      noStore.status === 200 && /no-store/i.test(noStore.headers.get('cache-control') || ''),
      `status=${noStore.status} cache=${noStore.headers.get('cache-control') || 'none'}`);

    db2.close();
  } catch (e) {
    fail = e;
    bad('S-XX', 'اجرای هارنس', String((e && e.stack) || e).slice(0, 300) + ' | child: ' + childLog.slice(-600));
  } finally {
    cleanup();
  }

  const finished = new Date().toISOString();
  log('');
  log(`SECURITY-PEN pass=${PASS} fail=${FAIL} skip=${SKIP} at=${finished}`);
  log(`# started_utc: ${started}`);
  log(`# node: ${process.version} · os: ${os.platform()} ${os.release()} ${os.arch()}`);
  log(`# checks: ${RESULTS.length}`);
  log(`EXIT=${fail ? 1 : (FAIL ? 1 : 0)}`);

  if (OUT) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, [
      '# Security Gate — آزمون نفوذ مستقل روی مسیرهای محصول (ردیف ۲۸)',
      '# تولید: node --experimental-sqlite docs/cloud/reports/evidence/security/pen-test.cjs --out <file>',
      '# دامنه: auth/session · authorization · tenant · storage · outbox · restore · cache · export',
      '# هشدار: PASS در این فایل یعنی «این حملات مشخص دفع شد»، نه «محصول امن است».',
      '# وضعیت امنیت طبق §۱۰.۲ قانون اساسی: UNKNOWN (مبتنی بر شاهد).',
      '',
      ...LINES,
      '',
      '# ---- raw json ----',
      JSON.stringify({ generated_at: finished, pass: PASS, fail: FAIL, skip: SKIP, results: RESULTS }, null, 2),
    ].join('\n') + '\n');
  }
  process.exit(fail || FAIL ? 1 : 0);
})();
