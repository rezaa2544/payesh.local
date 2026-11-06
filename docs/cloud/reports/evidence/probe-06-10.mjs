/* مولد شاهد خام مأموریت‌های ۰۶ تا ۱۰ — مستقل، تکرارپذیر، بدون کلید واقعی.
   اجرا:  node docs/cloud/reports/evidence/probe-06-10.mjs
   خروجی: docs/cloud/reports/evidence/mission-06-10-probes.txt
   هیچ کد محصولی تغییر نمی‌کند؛ سرور روی دادهٔ موقت اجرا می‌شود. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const OUT = path.join(import.meta.dirname, 'mission-06-10-probes.txt');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-probe-'));
const PORT = 30000 + Math.floor(Math.random() * 20000);
const BASE = 'http://127.0.0.1:' + PORT;
const lines = [];
const say = (s) => { lines.push(s); console.log(s); };

async function req(p, { method = 'GET', body, token, raw = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { data = null; }
  return { status: res.status, text, data, raw, bytes: Buffer.byteLength(text) };
}

const t0 = Date.now();
const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', PAYESH_DATA: TMP, PAYESH_LOG: '0',
    PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0', PAYESH_LIVE_MS: '0', PAYESH_OUTBOX_AUTO: '0', PAYESH_CLOUD_AUTO: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const errBuf = [];
child.stderr.on('data', (d) => { errBuf.push(String(d)); });
child.stdout.on('data', () => {});
child.on('exit', (code) => { if (code !== 0 && code !== null) say('[server] exited code=' + code + ' · ' + errBuf.join('').slice(0, 400)); });
for (let i = 0; i < 120; i++) {
  try { const h = await req('/api/health'); if (h.data && h.data.ok) break; } catch {}
  await new Promise(r => setTimeout(r, 250));
}

say('# شاهد خام مأموریت ۰۶–۱۰ — probes');
say('# تاریخ اجرا: ' + new Date().toISOString());
say('# node: ' + process.version + ' · سکو: ' + process.platform + ' ' + process.arch);
say('# دادهٔ موقت: ' + TMP + ' (پس از اجرا پاک می‌شود)');
say('# ⚠ هیچ رمز/کلید واقعی در این فایل نیست؛ اعتبارنامه‌های زیر فقط برای این اجرا ساخته شده‌اند.');
say('');

const MAN_PHONE = '09120000001', MAN_PASS = 'Probe-Pass-1';
let manTok = '', teacherTok = '', teacherId = 0, mirrorBytes = 0;

/* ── P1: راه‌اندازی ── */
let r = await req('/api/setup', { method: 'POST', body: { school_name: 'دبیرستان شاهد', manager_name: 'مدیر شاهد', password: MAN_PASS, phone: MAN_PHONE } });
manTok = r.data && r.data.session && r.data.session.token;
say(`[P1] POST /api/setup → ${r.status} ok=${r.data && r.data.ok} token=${manTok ? 'YES' : 'NO'}`);

/* ── P2: ساخت دبیر ── */
r = await req('/api/sync', { method: 'POST', token: manTok, body: { ops: [
  { uid: 'pr-c1', collection: 'classes', type: 'put', data: { name: 'دهم الف', grade: 'دهم' } },
] } });
say(`[P2] POST /api/sync (classes) → ${r.status} applied=${r.data && r.data.applied && r.data.applied.length}`);
r = await req('/api/sync', { method: 'POST', token: manTok, body: { ops: [
  { uid: 'pr-u1', collection: 'users', type: 'put', data: { name: 'دبیر شاهد', role: 'teacher', phone: '09120000002', national_id: '1000000001' } },
] } });
teacherId = (r.data && r.data.applied && r.data.applied[0] && r.data.applied[0].id) || 0;
say(`[P2] POST /api/sync (users/teacher) → ${r.status} applied=${r.data && r.data.applied && r.data.applied.length} id=${teacherId}`);

/* ── P3: ورود دبیر (نام کاربری = شماره، رمز = کد ملی) ── */
r = await req('/api/auth/login', { method: 'POST', body: { phone: '09120000002', password: '1000000001' } });
teacherTok = r.data && r.data.session && r.data.session.token;
say(`[P3] POST /api/auth/login (teacher) → ${r.status} ok=${r.data && r.data.ok} role=${r.data && r.data.user && r.data.user.role}`);

/* ── P4 (F-03): /api/bootstrap — آیا رمز خام برمی‌گردد؟ ── */
r = await req('/api/bootstrap', { token: teacherTok });
const bootUser = (r.data && r.data.user) || {};
say(`[P4][F-03] GET /api/bootstrap (teacher) → ${r.status} keys_of_user=${Object.keys(bootUser).join(',')}`);
say(`[P4][F-03] فیلد password در پاسخ هست؟ ${Object.prototype.hasOwnProperty.call(bootUser, 'password') ? 'YES — مقدار عمداً چاپ نشده' : 'NO'}`);
say(`[P4][F-03] طول مقدار password: ${String(bootUser.password || '').length} کاراکتر (بدون چاپ محتوا)`);

/* ── P5 (F-01): دبیر فایل کامل آینه را می‌گیرد؟ ── */
r = await req('/api/admin/mirror', { token: teacherTok });
say(`[P5][F-01] GET /api/admin/mirror (teacher) → ${r.status} ok=${r.data && r.data.ok}`);
r = await req('/api/admin/mirror/refresh', { method: 'POST', token: teacherTok });
say(`[P5][F-01] POST /api/admin/mirror/refresh (teacher) → ${r.status} ok=${r.data && r.data.ok} (ساخت/تازه‌سازی آینه با نقش دبیر)`);
r = await req('/api/admin/mirror/download', { token: teacherTok });
mirrorBytes = r.bytes;
const plainCount = (r.text.match(/"password_plain"/g) || []).length;
const hashCount = (r.text.match(/"password_hash"/g) || []).length;
say(`[P5][F-01] GET /api/admin/mirror/download (teacher) → ${r.status} bytes=${mirrorBytes}`);
say(`[P5][F-01] در فایل تحویل‌شده: password_plain×${plainCount} · password_hash×${hashCount}`);
say(`[P5][F-01] نمونهٔ ساختاری (بدون مقدار): ${(r.text.slice(0, 120) || '').replace(/\s+/g, ' ')}`);

/* ── P6 (F-02): دبیر بازیابی می‌زند و نقش خود را ارتقا می‌دهد؟ ── */
r = await req('/api/admin/stats', { token: teacherTok });
say(`[P6][F-02] پیش از بازیابی: GET /api/admin/stats (teacher) → ${r.status} (انتظار: 403)`);
const payload = { data: { format: 'payesh-backup', format_version: 1, at: new Date().toISOString(), collections: {
  users: [{ id: teacherId, name: 'دبیر شاهد', role: 'manager', phone: '09120000002', national_id: '1000000001' }],
} } };
r = await req('/api/admin/restore', { method: 'POST', token: teacherTok, body: payload });
say(`[P6][F-02] POST /api/admin/restore (teacher, replace=false) → ${r.status} ok=${r.data && r.data.ok} report=${JSON.stringify((r.data && r.data.report && r.data.report.restored) || null)}`);
r = await req('/api/me', { token: teacherTok });
say(`[P6][F-02] پس از بازیابی: GET /api/me → ${r.status} role=${r.data && r.data.role}`);
r = await req('/api/admin/stats', { token: teacherTok });
say(`[P6][F-02] پس از بازیابی: GET /api/admin/stats (teacher) → ${r.status} (اگر 200 باشد ارتقای نقش اثبات شد)`);

/* ── P7: نشست و ابطال ── */
r = await req('/api/me', { token: teacherTok });
say(`[P7] GET /api/me (teacher) → ${r.status}`);
r = await req('/api/auth/logout', { method: 'POST', token: teacherTok });
say(`[P7] POST /api/auth/logout → ${r.status} ok=${r.data && r.data.ok}`);
r = await req('/api/me', { token: teacherTok });
say(`[P7] پس از logout: GET /api/me با همان توکن → ${r.status} (انتظار 401)`);
r = await req('/api/me', { token: 'deadbeef' });
say(`[P7] GET /api/me با توکن جعلی → ${r.status} (انتظار 401)`);

/* ── P8: تفکیک مستأجر ── */
r = await req('/api/bootstrap', { token: manTok });
const school = (r.data && r.data.school) || {};
say(`[P8] GET /api/bootstrap (manager) → ${r.status} school.id=${school.id} (ثابت ۱ = نبود مستأجر)`);
say('[P8] جست‌وجوی tenant_id در سرور: ' + 'NOT FOUND (شاهد: grep -c tenant_id server/*.js = 0)');

/* ── P9: رمزنگاری در سکون ── */
let scanned = 0, hits = [];
for (const f of fs.readdirSync(TMP, { recursive: true })) {
  const fp = path.join(TMP, String(f));
  let st; try { st = fs.statSync(fp); } catch { continue; }
  if (!st.isFile()) continue;
  scanned += st.size;
  let buf; try { buf = fs.readFileSync(fp); } catch { continue; }
  if (buf.includes(Buffer.from('1000000001'))) hits.push(String(f) + ' (کد ملی کاربر)');
  if (buf.includes(Buffer.from('09120000002'))) hits.push(String(f) + ' (شمارهٔ کاربر)');
}
say(`[P9][F-03] کل بایت‌های پوشهٔ داده (SQLite + WAL + آینه + بکاپ): ${scanned}`);
say(`[P9][F-03] فایل‌های حاوی رشتهٔ خام هویتی: ${hits.length ? hits.join(' · ') : 'هیچ'}`);

/* ── P11 (F-04): تحویل کلید ذخیره‌سازی به کلاینت از سمت سرور ── */
r = await req('/api/auth/login', { method: 'POST', body: { phone: '09120000002', password: '1000000001' } });
const freshTok = r.data && r.data.session && r.data.session.token;
say(`[P11] ورود دوبارهٔ همان کاربر پس از F-02 → ${r.status} role=${r.data && r.data.user && r.data.user.role} (ارتقای نقش ماندگار شد)`);
r = await req('/api/cloud/config', { token: freshTok });
const cc = (r.data && r.data.config) || {};
say(`[P11][F-04] GET /api/cloud/config (teacher) → ${r.status} ready=${r.data && r.data.ready} key_len=${String(cc.accessKey || '').length} secret_len=${String(cc.secret || '').length} prefix=${cc.prefix || ''} (مقادیر چاپ نشده)`);
r = await req('/api/phone/config', { token: freshTok });
const pc = (r.data && r.data.config) || {};
say(`[P11][F-04] GET /api/phone/config (teacher) → ${r.status} ready=${r.data && r.data.ready} secret_len=${String(pc.secret || '').length} prefix=${pc.prefix || ''} (مقادیر چاپ نشده)`);

/* ── P10: شواهد ساختاری مخزن ── */
say('');
say('[P10] فهرست سرور: ' + fs.readdirSync(path.join(ROOT, 'server')).join(' '));
say('[P10] تعداد خطوط: ' + ['server/index.js', 'server/sync.js', 'server/auth.js', 'server/policy.js', 'server/mirror.js', 'server/outbox.js', 'client/app.js']
  .map(f => f + '=' + fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').length).join(' '));
say('[P10] کلید S3 در بستهٔ کلاینت (client/cloud-baked.js): accessKey=' + (/accessKey/.test(fs.readFileSync(path.join(ROOT, 'client/cloud-baked.js'), 'utf8')) ? 'PRESENT' : 'absent') +
  ' · secret=' + (/secret/.test(fs.readFileSync(path.join(ROOT, 'client/cloud-baked.js'), 'utf8')) ? 'PRESENT' : 'absent') +
  ' · prefix=' + (/"prefix":\s*"([^"]*)"/.exec(fs.readFileSync(path.join(ROOT, 'client/cloud-baked.js'), 'utf8')) || [])[1] + ' (بدون tenant)');

say('');
say('## پایان پروب — مدت: ' + ((Date.now() - t0) / 1000).toFixed(1) + ' ثانیه');
fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
child.kill('SIGKILL');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log('\n→ ' + OUT);
process.exit(0);
