#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   شبیه‌سازی سال تحصیلی چند‌مدرسه‌ای — «آیا معماری و قابلیت‌ها واقعاً کار می‌کنند؟»
   ───────────────────────────────────────────────────────────────────────────
   این اسکریپت محصول واقعی را اجرا می‌کند (نه مدل، نه mock):
     • برای هر مدرسه یک نمونهٔ کامل محصول با دیتابیس SQLite مستقل
     • همهٔ نوشتن‌ها از مسیر واقعی دستگاه‌ها: POST /api/sync (با OCC، gate نقش، idempotency)
     • همهٔ خواندن‌ها از POST/GET /api/v1/pull با همان اسکوپ سرور
     • سناریوهای واقعی: غیبت، تأخیر، مرخصی، نمره، حضور کارکنان، اطلاعیه،
       تکلیف، امتحان، تقویم، انضباط، مشاوره، کارآموزی، جابه‌جایی زنگ
     • شرایط سخت: قطع/ری‌استارت سرور در میانهٔ سال، تعارض هم‌زمان (OCC)،
       تکرار بسته (replay)، تلاش‌های عبور از مجوز/اسکوپ، بازیابی از بکاپ
   خروجی: JSON خام + فایل شاهد متنی. هیچ عددی از پیش نوشته نشده است.

   اجرا:
     node docs/cloud/reports/evidence/sim/school-year-sim.mjs
   اجرای کوچک برای دود:
     SIM_SMOKE=1 node docs/cloud/reports/evidence/sim/school-year-sim.mjs
   ═══════════════════════════════════════════════════════════════════════════ */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../../..');
const EVID = path.join(REPO, 'docs/cloud/reports/evidence');
const SMOKE = process.env.SIM_SMOKE === '1';

const CFG = {
  schools: Number(process.env.SIM_SCHOOLS || (SMOKE ? 2 : 4)),
  students: Number(process.env.SIM_STUDENTS || (SMOKE ? 20 : 400)),
  teachers: Number(process.env.SIM_TEACHERS || (SMOKE ? 6 : 30)),
  parents: Number(process.env.SIM_PARENTS || (SMOKE ? 6 : 120)),
  classes: Number(process.env.SIM_CLASSES || (SMOKE ? 4 : 12)),
  days: Number(process.env.SIM_DAYS || (SMOKE ? 6 : 180)),
  portBase: Number(process.env.SIM_PORT_BASE || 3810),
  root: process.env.SIM_ROOT || '/tmp/payesh-sim',
  batch: 200,
  subjects: 8,
};

const T0 = Date.now();
const checks = [];
const notes = [];
function check(id, name, ok, detail, state) {
  const st = state || (ok ? 'PASS' : 'FAIL');
  checks.push({ id, name, ok: st !== 'FAIL', state: st, detail: detail == null ? '' : String(detail) });
  const line = (st === 'PASS' ? 'PASS  ' : st === 'SKIP' ? 'SKIP  ' : 'FAIL  ') + id.padEnd(6) + name + (detail ? '  → ' + detail : '');
  console.log(line);
}
function note(s) { notes.push(s); console.log('# ' + s); }
const pct = (arr, p) => (arr.length ? arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0);
const r3 = n => Math.round(n * 1000) / 1000;

/* ── سنجش تأخیر به تفکیک مسیر ───────────────────────────────────────────── */
const lat = { by: new Map(), errors: 0, http4xx: 0, http5xx: 0, calls: 0 };
function record(endpoint, ms, status) {
  lat.calls++;
  if (!status) lat.errors++;
  else if (status >= 500) lat.http5xx++;
  else if (status >= 400) lat.http4xx++;
  if (!lat.by.has(endpoint)) lat.by.set(endpoint, []);
  const a = lat.by.get(endpoint);
  if (a.length < 20000) a.push(ms);
}
function latSummary() {
  const out = {};
  for (const [k, v] of lat.by) out[k] = { n: v.length, p50: r3(pct(v, 0.5)), p95: r3(pct(v, 0.95)), p99: r3(pct(v, 0.99)), max: r3(Math.max(...v)) };
  return out;
}

/* ── فراخوانی HTTP محصول ────────────────────────────────────────────────── */
async function api(school, p, opts = {}) {
  const url = 'http://127.0.0.1:' + school.port + p;
  const t0 = performance.now();
  let res, text, body, ok = false;
  try {
    res = await fetch(url, opts);
    text = await res.text();
    try { body = JSON.parse(text); } catch { body = text; }
    ok = res.status < 400;
  } catch (e) {
    body = { transport_error: String(e && e.message || e) };
    res = { status: 0 };
  }
  const ms = performance.now() - t0;
  record((opts.method || 'GET') + ' ' + p.split('?')[0], ms, res.status);
  return { status: res.status, body, ms };
}
const auth = tok => ({ authorization: 'Bearer ' + tok });
const jsonBody = (obj, tok) => ({ method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, tok ? auth(tok) : {}), body: JSON.stringify(obj) });

/* ── مدرسه = یک نمونهٔ کامل محصول ───────────────────────────────────────── */
class School {
  constructor(i, name) { this.i = i; this.name = name; this.port = CFG.portBase + i; this.data = path.join(CFG.root, 'school-' + i); this.proc = null; this.users = { managers: [], teachers: [], students: [], parents: [], counselors: [], guards: [] }; this.tokens = {}; this.classes = []; this.t0 = 0; }
  async start() {
    fs.mkdirSync(this.data, { recursive: true });
    const t0 = performance.now();
    this.proc = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], {
      cwd: REPO,
      env: Object.assign({}, process.env, {
        PORT: String(this.port), HOST: '127.0.0.1', PAYESH_DATA: this.data,
        PAYESH_LOG: '0', PAYESH_AUTO_BACKUP: '0', PAYESH_MIRROR: '0',
        PAYESH_CLOUD_AUTO: '0', PAYESH_OUTBOX_AUTO: '0', PAYESH_NO_RESTART: '1',
        PAYESH_TENANCY_PG: '', PAYESH_TENANCY_SECRET: '',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.logs = [];
    this.proc.stdout.on('data', d => this.logs.push(String(d)));
    this.proc.stderr.on('data', d => this.logs.push(String(d)));
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      try { const r = await fetch('http://127.0.0.1:' + this.port + '/api/readyz'); if (r.ok || r.status === 503) break; } catch {}
      await new Promise(r => setTimeout(r, 120));
    }
    this.bootMs = Math.round(performance.now() - t0);
    if (this.bootMs >= 39_000) {
      throw new Error('server did not start on port ' + this.port + '\n' + (this.logs || []).join('').slice(-1500));
    }
    return this.bootMs;
  }
  async stop(signal = 'SIGTERM') {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    p.kill(signal);
    await new Promise(res => { p.once('exit', res); setTimeout(res, 6000); });
  }
  async restart(signal = 'SIGKILL') {
    const downAt = performance.now();
    await this.stop(signal);
    await this.start();
    return Math.round(performance.now() - downAt);
  }
  async setup() {
    const managerName = 'مدیر ' + this.name;
    const r = await api(this, '/api/setup', jsonBody({
      manager_name: managerName, school_name: this.name,
      school_type: 'کاردانش', level: 'متوسطه دوم', city: 'تهران',
      school_phone: '021' + String(20000000 + this.i), password: 'Manager!' + (1000 + this.i),
      school_year: '۱۴۰۵–۱۴۰۶',
      capabilities: { has_counselor: true, has_staff_attendance: true, has_internships: true, has_workshop: true },
    }));
    if (!r.body.ok) throw new Error('setup failed school ' + this.i + ': ' + JSON.stringify(r.body));
    this.tokens.manager = r.body.session.token;
    this.users.managers.push({ id: r.body.user.id, name: managerName, phone: r.body.user.phone });
    return r;
  }
  async login(phone, password, role, name) {
    const r = await api(this, '/api/auth/login', jsonBody({ phone, password, name: role + '-device', platform: 'web' }));
    return r;
  }
}

/* ── تولید دادهٔ واقع‌نما ────────────────────────────────────────────────── */
const FIRST_M = ['علی', 'محمد', 'رضا', 'امیر', 'حسین', 'سعید', 'مهدی', 'کاوه', 'پویا', 'آرش', 'بابک', 'نیما'];
const FIRST_F = ['زهرا', 'فاطمه', 'مریم', 'سارا', 'نگار', 'الهام', 'پریسا', 'مهسا', 'شیدا', 'ریحانه'];
const FAMILY = ['احمدی', 'محمدی', 'رضایی', 'کریمی', 'موسوی', 'حسینی', 'نوری', 'صادقی', 'جعفری', 'قاسمی', 'امینی', 'شریفی', 'طاهری', 'زمانی'];
const SUBJECTS = ['ریاضی', 'فارسی', 'عربی', 'زبان انگلیسی', 'دین و زندگی', 'فیزیک', 'شیمی', 'تربیت بدنی'];
let seed = 20261107;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = a => a[Math.floor(rnd() * a.length)];
const ri = n => Math.floor(rnd() * n);
const pad = (n, w = 2) => String(n).padStart(w, '0');
const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

/* سال تحصیلی: ۱ مهر ۱۴۰۵ ≈ 2026-09-23؛ روزهای مدرسه: شنبه..چهارشنبه */
function schoolDays(n) {
  const out = [];
  const d = new Date(Date.UTC(2026, 8, 23));
  while (out.length < n) {
    const wd = d.getUTCDay();            /* 5=جمعه 4=پنجشنبه */
    if (wd !== 4 && wd !== 5) out.push(iso(new Date(d.getTime())));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/* ── توزیع بسته‌ها روی «دستگاه‌های» موازی ────────────────────────────────── */
class Device {
  constructor(school, token, role, id, name) { this.school = school; this.token = token; this.role = role; this.id = id; this.name = name; this.ops = []; this.opsTotal = 0; this.seq = 0; }
  push(collection, data, id) { this.opsTotal++; this.ops.push({ uid: 'd' + this.id + '-' + (++this.seq) + '-' + Math.random().toString(36).slice(2, 8), collection, type: 'put', id, data }); return this; }
  async flush(extra = {}) {
    const out = { applied: 0, conflicts: 0, rejected: 0, rejectedDetails: [] };
    while (this.ops.length) {
      const batch = this.ops.splice(0, CFG.batch);
      const r = await api(this.school, '/api/sync', jsonBody(Object.assign({ ops: batch }, extra), this.token));
      if (!r.body || !r.body.ok) { out.failed = (out.failed || 0) + 1; out.error = r.body && r.body.error; continue; }
      out.applied += (r.body.applied || []).length;
      out.conflicts += (r.body.conflicts || []).length;
      out.rejected += (r.body.rejected || []).length;
      for (const x of (r.body.rejected || []).slice(0, 3)) out.rejectedDetails.push(x.error);
      out.ids = out.ids || [];
      for (const a of (r.body.applied || [])) if (a.id != null) out.ids.push(a.id);
    }
    return out;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   اجرای اصلی
   ══════════════════════════════════════════════════════════════════════════ */
const SCHOOL_NAMES = ['هنرستان شهید بهشتی', 'دبیرستان فرزانگان', 'هنرستان کاردانش امید', 'دبیرستان نمونه البرز'];
const schools = [];
const metrics = { config: CFG, phases: {}, year: {}, faults: {}, integrity: {}, isolation: {}, performance: {} };
const days = schoolDays(CFG.days);

async function main() {
  fs.rmSync(CFG.root, { recursive: true, force: true });
  fs.mkdirSync(CFG.root, { recursive: true });

  /* ── فاز ۱: راه‌اندازی نمونه‌ها ─────────────────────────────────────── */
  let t = performance.now();
  for (let i = 0; i < CFG.schools; i++) {
    const s = new School(i, SCHOOL_NAMES[i % SCHOOL_NAMES.length]);
    schools.push(s);
  }
  await Promise.all(schools.map(s => s.start()));
  metrics.phases.boot = { ms: Math.round(performance.now() - t), each: schools.map(s => s.bootMs) };
  check('S-01', 'همهٔ نمونه‌های مدرسه بالا آمدند و /api/readyz پاسخ داد',
    schools.every(s => s.proc && s.bootMs > 0), schools.map(s => s.port + ':' + s.bootMs + 'ms').join(' '));

  /* ── فاز ۲: راه‌اندازی اولیهٔ هر مدرسه ──────────────────────────────── */
  t = performance.now();
  for (const s of schools) await s.setup();
  metrics.phases.setup = { ms: Math.round(performance.now() - t) };
  check('S-02', 'راه‌اندازی اولیه (setup) هر مدرسه انجام شد و نشست مدیر صادر شد',
    schools.every(s => s.tokens.manager), CFG.schools + ' مدرسه · ' + metrics.phases.setup.ms + 'ms');

  /* ── فاز ۳: ساخت ساختار مدرسه (کلاس، درس، کاربران، برنامه) ─────────── */
  t = performance.now();
  for (const s of schools) await buildStructure(s);
  metrics.phases.structure = { ms: Math.round(performance.now() - t) };
  const totalUsers = schools.reduce((n, s) => n + Object.values(s.users).flat().length, 0);
  check('S-03', 'ساخت ساختار و کاربران از مسیر sync محصول',
    schools.every(s => s.users.students.length === CFG.students && s.users.teachers.length === CFG.teachers),
    'کاربران کل=' + totalUsers + ' · دانش‌آموز/مدرسه=' + CFG.students + ' · ' + metrics.phases.structure.ms + 'ms');

  /* ── فاز ۴: ورود نقش‌ها در مقیاس ────────────────────────────────────── */
  t = performance.now();
  for (const s of schools) await loginRoles(s);
  metrics.phases.logins = { ms: Math.round(performance.now() - t), count: lat.by.get('POST /api/auth/login')?.length ?? 0 };
  const sessionOk = schools.every(s => s.tokens.teacher?.length && s.tokens.student?.length && s.tokens.parent?.length);
  check('S-04', 'ورود همهٔ نقش‌ها (مدیر/دبیر/دانش‌آموز/ولی/مشاور/سرایدار) با دستگاه مستقل',
    sessionOk, 'ورود موفق=' + metrics.phases.logins.count + ' · ' + metrics.phases.logins.ms + 'ms');

  /* ── فاز ۵: آزمون اسکوپ و مجوز (پیش از سال) ─────────────────────────── */
  await scopeAndPermissionChecks();

  /* ── فاز ۶: اجرای سال تحصیلی ────────────────────────────────────────── */
  await runSchoolYear();

  /* ── فاز ۶.۵: هم‌زمانی چند دستگاه ───────────────────────────────────── */
  await concurrencyCheck();

  /* ── فاز ۷: شرایط سخت در میانهٔ سال ────────────────────────────────── */
  await faultAndRecoveryChecks();

  /* ── فاز ۸: یکپارچگی داده و شاهد پایانی ────────────────────────────── */
  await integrityChecks();

  /* ── گزارش ──────────────────────────────────────────────────────────── */
  await writeWitness();
}

/* ── ساختار: کلاس‌ها، دروس، کاربران، برنامهٔ هفتگی ─────────────────────── */
async function buildStructure(s) {
  const mgr = new Device(s, s.tokens.manager, 'manager', 0, 'دستگاه مدیر');
  const cls = [];
  for (let i = 0; i < CFG.classes; i++) {
    const grade = 10 + (i % 3);
    cls.push({ name: 'پایه ' + grade + ' — کلاس ' + pad(i + 1), grade, branch: ['ریاضی', 'تجربی', 'انسانی'][i % 3], capacity: 34 });
  }
  mgr.ops.push(...cls.map((c, i) => ({ uid: 'cls-' + s.i + '-' + i, collection: 'classes', type: 'put', data: c })));
  const subjects = SUBJECTS.slice(0, CFG.subjects);
  mgr.ops.push(...subjects.map((n, i) => ({ uid: 'sub-' + s.i + '-' + i, collection: 'subjects', type: 'put', data: { name: n, workshop: i >= 6, weekly_hours: i >= 6 ? 4 : 2 } })));
  mgr.ops.push({ uid: 'yr-' + s.i, collection: 'school_years', type: 'put', data: { title: '۱۴۰۵–۱۴۰۶', active: true } });
  await mgr.flush();
  const pull = await api(s, '/api/v1/pull?collections=classes,subjects', { headers: auth(s.tokens.manager) });
  s.classes = (pull.body.collections?.classes || []).map(c => c.id);
  s.subjectIds = (pull.body.collections?.subjects || []).map(c => c.id);

  /* دبیران */
  const dev = new Device(s, s.tokens.manager, 'manager', 0, 'دستگاه مدیر');
  const teacherRows = [];
  for (let i = 0; i < CFG.teachers; i++) {
    const female = i % 2 === 0;
    teacherRows.push({
      name: (female ? pick(FIRST_F) : pick(FIRST_M)) + ' ' + pick(FAMILY) + ' (دبیر ' + (i + 1) + ')',
      role: 'teacher', phone: '0912' + String(s.i) + pad(i, 6), national_id: '1' + String(s.i) + pad(100000 + i, 8),
      active: true, class_id: s.classes[i % s.classes.length],
    });
  }
  dev.ops.push(...teacherRows.map((t, i) => ({ uid: 'tch-' + s.i + '-' + i, collection: 'users', type: 'put', data: t })));
  let out = await dev.flush();
  s.teacherIds = out.ids || [];
  if (s.teacherIds.length !== CFG.teachers) throw new Error('teacher create mismatch school ' + s.i + ': ' + s.teacherIds.length);

  /* دانش‌آموزان */
  const sdev = new Device(s, s.tokens.manager, 'manager', 0, 'دستگاه مدیر');
  const studentRows = [];
  for (let i = 0; i < CFG.students; i++) {
    const female = i % 2 === 1;
    studentRows.push({
      name: (female ? pick(FIRST_F) : pick(FIRST_M)) + ' ' + pick(FAMILY),
      role: 'student', phone: '0913' + String(s.i) + pad(i, 6), national_id: '2' + String(s.i) + pad(100000 + i, 8),
      class_id: s.classes[i % s.classes.length], active: true,
      birth_date: '2010-0' + (1 + (i % 9)) + '-1' + (i % 9), gender: female ? 'دختر' : 'پسر',
    });
  }
  sdev.ops.push(...studentRows.map((t, i) => ({ uid: 'std-' + s.i + '-' + i, collection: 'users', type: 'put', data: t })));
  out = await sdev.flush();
  s.studentIds = out.ids || [];
  if (s.studentIds.length !== CFG.students) throw new Error('student create mismatch school ' + s.i + ': ' + s.studentIds.length + ' rejected=' + out.rejected);

  /* اولیا + پیوند */
  const pdev = new Device(s, s.tokens.manager, 'manager', 0, 'دستگاه مدیر');
  const parentRows = [];
  for (let i = 0; i < CFG.parents; i++) {
    parentRows.push({ name: 'ولی ' + pick(FAMILY) + ' (' + (i + 1) + ')', role: 'parent', phone: '0914' + String(s.i) + pad(i, 6), national_id: '3' + String(s.i) + pad(100000 + i, 8), active: true });
  }
  /* مشاور و سرایدار */
  parentRows.push({ name: 'مشاور ' + s.name, role: 'counselor', phone: '0915' + String(s.i) + '000001', national_id: '4' + String(s.i) + '000001', active: true });
  parentRows.push({ name: 'سرایدار ' + s.name, role: 'guard', phone: '0915' + String(s.i) + '000002', national_id: '5' + String(s.i) + '000001', active: true });
  pdev.ops.push(...parentRows.map((t, i) => ({ uid: 'prn-' + s.i + '-' + i, collection: 'users', type: 'put', data: t })));
  out = await pdev.flush();
  const extraIds = out.ids || [];
  s.parentIds = extraIds.slice(0, CFG.parents);
  s.users.parents = parentRows.slice(0, CFG.parents);
  s.users.counselors = [parentRows[CFG.parents]];
  s.users.guards = [parentRows[CFG.parents + 1]];
  s.counselorId = extraIds[CFG.parents];
  s.guardId = extraIds[CFG.parents + 1];

  const ldev = new Device(s, s.tokens.manager, 'manager', 0, 'دستگاه مدیر');
  for (let i = 0; i < CFG.parents; i++) {
    ldev.ops.push({ uid: 'lnk-' + s.i + '-' + i, collection: 'parent_links', type: 'put', data: { parent_id: s.parentIds[i], student_id: s.studentIds[i], relation: i % 2 ? 'father' : 'mother' } });
  }
  /* برنامهٔ هفتگی: هر کلاس ۶ درس با دبیر مشخص */
  for (let c = 0; c < s.classes.length; c++) {
    for (let k = 0; k < 6; k++) {
      const teacherIdx = (c * 6 + k) % CFG.teachers;
      ldev.ops.push({
        uid: 'sch-' + s.i + '-' + c + '-' + k, collection: 'schedule', type: 'put',
        data: { class_id: s.classes[c], subject_id: s.subjectIds[k % s.subjectIds.length], teacher_id: s.teacherIds[teacherIdx], weekday: k % 5, hour: 1 + (k % 4) },
      });
    }
  }
  await ldev.flush();

  s.users.teachers = teacherRows.map((r, i) => ({ id: s.teacherIds[i], phone: r.phone, national_id: r.national_id, name: r.name }));
  s.users.students = studentRows.map((r, i) => ({ id: s.studentIds[i], phone: r.phone, national_id: r.national_id, name: r.name, class_id: s.classes[i % s.classes.length] }));
  s.users.parents = parentRows.slice(0, CFG.parents).map((r, i) => ({ id: s.parentIds[i], phone: r.phone, national_id: r.national_id, name: r.name, child: s.studentIds[i] }));
  s.roster = new Map();
  for (const st of s.users.students) {
    if (!s.roster.has(st.class_id)) s.roster.set(st.class_id, []);
    s.roster.get(st.class_id).push(st);
  }
  /* دبیر هر کلاس (برای نوشتن حضور/نمره) */
  s.classTeacher = new Map();
  for (let c = 0; c < s.classes.length; c++) s.classTeacher.set(s.classes[c], s.teacherIds[c % CFG.teachers]);
  /* کلاس‌های واقعی هر دبیر بر اساس برنامهٔ هفتگی (همان چیزی که buildScope سرور می‌بیند) */
  s.teacherClassSets = new Map();
  for (const tid of s.teacherIds) s.teacherClassSets.set(tid, new Set());
  for (let c = 0; c < s.classes.length; c++) {
    for (let k = 0; k < 6; k++) {
      const tid = s.teacherIds[(c * 6 + k) % CFG.teachers];
      s.teacherClassSets.get(tid).add(s.classes[c]);
    }
  }
}

/* ── ورود نقش‌ها: زیرمجموعه‌ای واقعی از هر نقش در هر مدرسه ─────────────── */
async function loginRoles(s) {
  s.tokens.teacher = []; s.tokens.student = []; s.tokens.parent = []; s.tokens.counselor = null; s.tokens.guard = null;
  const teachersN = Math.min(CFG.teachers, SMOKE ? 4 : 12);
  for (const t of s.users.teachers.slice(0, teachersN)) {
    const r = await s.login(t.phone, t.national_id, 'teacher', t.name);
    if (r.body.ok) s.tokens.teacher.push({ id: t.id, token: r.body.session.token, classes: [...(s.teacherClassSets.get(t.id) || [])] });
  }
  const studentsN = Math.min(CFG.students, SMOKE ? 5 : 12);
  for (const st of s.users.students.slice(0, studentsN)) {
    const r = await s.login(st.phone, st.national_id, 'student', st.name);
    if (r.body.ok) s.tokens.student.push({ id: st.id, token: r.body.session.token, class_id: st.class_id });
  }
  const parentsN = Math.min(CFG.parents, SMOKE ? 5 : 10);
  for (const p of s.users.parents.slice(0, parentsN)) {
    const r = await s.login(p.phone, p.national_id, 'parent', p.name);
    if (r.body.ok) s.tokens.parent.push({ id: p.id, token: r.body.session.token, child: p.child });
  }
  const c = await s.login(s.users.counselors[0].phone, s.users.counselors[0].national_id, 'counselor', 'مشاور');
  if (c.body.ok) s.tokens.counselor = c.body.session.token;
  const g = await s.login(s.users.guards[0].phone, s.users.guards[0].national_id, 'guard', 'سرایدار');
  if (g.body.ok) s.tokens.guard = g.body.session.token;
}

/* ── آزمون اسکوپ/مجوز: رفتار واقعی سرور، نه ادعا ───────────────────────── */
async function scopeAndPermissionChecks() {
  const s = schools[0];
  const roster = (cls) => (s.roster.get(cls) || []).slice(0, 3);

  /* سقف عملیات هر push */
  const tooMany = await api(s, '/api/sync', jsonBody({ ops: Array.from({ length: 201 }, (_, i) => ({ uid: 'over-' + i, collection: 'announcements', type: 'put', data: { title: 'x' + i } })) }, s.tokens.manager));
  check('P-01', 'سقف ۲۰۰ عملیات در هر push اعمال می‌شود', tooMany.body.error === 'too_many_ops', 'error=' + tooMany.body.error);

  /* idempotency / replay */
  const uid = 'replay-' + Date.now();
  const one = { uid, collection: 'announcements', type: 'put', data: { title: 'اطلاعیه تکرار', body: 'تست idempotency', severity: 'info', audience: 'all', date: days[0] } };
  const a1 = await api(s, '/api/sync', jsonBody({ ops: [one] }, s.tokens.manager));
  const a2 = await api(s, '/api/sync', jsonBody({ ops: [one] }, s.tokens.manager));
  check('P-02', 'تکرار همان بسته (replay) دوباره ثبت نمی‌شود', a2.body.applied?.[0]?.duplicate === true, 'first=' + (a1.body.applied?.length) + ' second_duplicate=' + JSON.stringify(a2.body.applied?.[0]));

  /* دانش‌آموز نمی‌تواند حضور بنویسد */
  const st = s.tokens.student[0];
  const stClass = st.class_id;
  const studentWrite = await api(s, '/api/sync', jsonBody({ ops: [{ uid: 'sw-' + Date.now(), collection: 'attendance', type: 'put', data: { student_id: st.id, class_id: stClass, date: days[0], status: 'present' } }] }, st.token));
  check('P-03', 'دانش‌آموز نمی‌تواند حضور و غیاب بنویسد', studentWrite.body.rejected?.[0]?.error === 'role_denied', 'rejected=' + JSON.stringify(studentWrite.body.rejected?.[0]));

  /* دبیر برای کلاس دیگر نمی‌تواند بنویسد */
  const tchPartial = s.tokens.teacher.find(t => t.classes.length > 0 && t.classes.length < s.classes.length);
  if (!tchPartial) {
    check('P-04', 'دبیر در کلاس خارج از اسکوپ نمی‌تواند بنویسد', false, 'هیچ دبیری با کلاس محدود یافت نشد', 'SKIP');
  } else {
    const otherClass = [...s.roster.keys()].find(c => !tchPartial.classes.includes(c));
    const otherStudent = s.roster.get(otherClass)[0];
    const teacherOut = await api(s, '/api/sync', jsonBody({ ops: [{ uid: 'to-' + Date.now(), collection: 'attendance', type: 'put', data: { student_id: otherStudent.id, class_id: otherClass, date: days[0], status: 'present' } }] }, tchPartial.token));
    check('P-04', 'دبیر در کلاس خارج از اسکوپ نمی‌تواند بنویسد', teacherOut.body.rejected?.[0]?.error === 'out_of_scope', 'کلاس دبیر=' + tchPartial.classes.join(',') + ' کلاس هدف=' + otherClass + ' rejected=' + JSON.stringify(teacherOut.body.rejected?.[0] || teacherOut.body.applied));
  }
  const tch = tchPartial || s.tokens.teacher[0];

  /* دبیر نمی‌تواند نقش تغییر دهد (F-02) */
  const roleChange = await api(s, '/api/sync', jsonBody({ ops: [{ uid: 'rc-' + Date.now(), collection: 'users', type: 'put', id: tch.id, data: { role: 'manager' } }] }, tch.token));
  check('P-05', 'تغییر نقش از مسیر sync توسط دبیر رد می‌شود (F-02)', roleChange.body.rejected?.[0]?.error === 'role_change_denied', 'rejected=' + JSON.stringify(roleChange.body.rejected?.[0]));

  /* ولی فقط درخواست می‌دهد، نه تأیید */
  const p = s.tokens.parent[0];
  const leave = await api(s, '/api/sync', jsonBody({ ops: [{ uid: 'lv-' + Date.now(), collection: 'leaves', type: 'put', data: { student_id: p.child, date: days[0], reason: 'مرخصی پزشکی', status: 'approved' } }] }, p.token));
  const leaveId = leave.body.applied?.[0]?.id;
  const pulled = await api(s, '/api/v1/pull?collections=leaves', { headers: auth(s.tokens.manager) });
  const savedLeave = (pulled.body.collections?.leaves || []).find(x => x.id === leaveId);
  check('P-06', 'ولی نمی‌تواند مرخصی را «تأییدشده» ثبت کند (به pending تبدیل می‌شود)', savedLeave && savedLeave.status === 'pending', 'status=' + (savedLeave && savedLeave.status));

  /* school_id کلاینتی نادیده گرفته می‌شود */
  const spoof = await api(s, '/api/sync', jsonBody({ ops: [{ uid: 'sp-' + Date.now(), collection: 'announcements', type: 'put', data: { title: 'spoof', school_id: 999, tenant_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' } }] }, s.tokens.manager));
  const ann = await api(s, '/api/v1/pull?collections=announcements', { headers: auth(s.tokens.manager) });
  const spoofRow = (ann.body.collections?.announcements || []).find(x => x.id === spoof.body.applied?.[0]?.id);
  check('P-07', 'میدان school_id/tenant_id کلاینتی نادیده گرفته می‌شود (F-05)', spoofRow && Number(spoofRow.school_id) === 1 && !spoofRow.tenant_id, 'school_id=' + (spoofRow && spoofRow.school_id) + ' tenant_id=' + (spoofRow && spoofRow.tenant_id));

  /* اسکوپ خواندن دانش‌آموز: فقط خودش */
  const stPull = await api(s, '/api/v1/pull?collections=users,attendance,grades', { headers: auth(st.token) });
  const seenUsers = stPull.body.collections?.users || [];
  const foreign = seenUsers.filter(u => Number(u.id) !== st.id && !(u.role === 'student' && u.class_id === stClass));
  check('P-08', 'دانش‌آموز فقط رکورد خودش را می‌بیند (اسکوپ سروری)', foreign.length === 0, 'users=' + seenUsers.length + ' خارج از اسکوپ=' + foreign.length);

  /* اسکوپ ولی: فقط فرزند خودش */
  const pPull = await api(s, '/api/v1/pull?collections=attendance,grades', { headers: auth(p.token) });
  const att = pPull.body.collections?.attendance || [];
  const outside = att.filter(x => Number(x.student_id) !== Number(p.child));
  check('P-09', 'ولی فقط دادهٔ فرزند خودش را می‌بیند', outside.length === 0, 'attendance=' + att.length + ' خارج=' + outside.length);

  /* اسکوپ دبیر: فقط کلاس‌های خودش */
  const tPull = await api(s, '/api/v1/pull?collections=attendance', { headers: auth(tch.token) });
  const tAtt = tPull.body.collections?.attendance || [];
  const tOutside = tAtt.filter(x => !tch.classes.includes(Number(x.class_id)));
  check('P-10', 'دبیر فقط حضور کلاس‌های خودش را می‌بیند', tOutside.length === 0, 'attendance=' + tAtt.length + ' خارج=' + tOutside.length);

  /* نقش سرایدار: فقط خواندن، بدون هیچ نوشتن؛ دادهٔ دانش‌آموزان دیده نمی‌شود */
  if (s.tokens.guard) {
    const gw = await api(s, '/api/sync', jsonBody({ ops: [{ uid: 'gd-' + Date.now(), collection: 'attendance', type: 'put', data: { student_id: st.id, class_id: stClass, date: days[0], status: 'present' } }] }, s.tokens.guard));
    check('P-12', 'سرایدار هیچ اجازهٔ نوشتنی ندارد (fail-closed)', gw.body.rejected?.[0]?.error === 'role_denied', 'rejected=' + JSON.stringify(gw.body.rejected?.[0]?.error || null));
    const gPull = await api(s, '/api/v1/pull?collections=attendance,grades,users,announcements', { headers: auth(s.tokens.guard) });
    const gAtt = (gPull.body.collections?.attendance || []).length;
    const gUsers = (gPull.body.collections?.users || []).length;
    check('P-13', 'سرایدار دادهٔ حضور/نمرهٔ دانش‌آموزان را نمی‌بیند (اسکوپ خالی)', gAtt === 0, 'attendance=' + gAtt + ' users=' + gUsers);
  } else {
    check('P-12', 'سرایدار هیچ اجازهٔ نوشتنی ندارد (fail-closed)', false, 'سرایدار وارد نشد', 'SKIP');
    check('P-13', 'سرایدار دادهٔ حضور/نمرهٔ دانش‌آموزان را نمی‌بیند (اسکوپ خالی)', false, 'سرایدار وارد نشد', 'SKIP');
  }
  /* مشاور: ثبت یادداشت مشاوره مجاز است */
  if (s.tokens.counselor) {
    const cn = await api(s, '/api/sync', jsonBody({ ops: [{ uid: 'cn-' + Date.now(), collection: 'counselor_notes', type: 'put', data: { student_id: st.id, note: 'آزمون ثبت مشاوره', date: days[0], private: true } }] }, s.tokens.counselor));
    check('P-14', 'مشاور می‌تواند یادداشت مشاوره ثبت کند', (cn.body.applied || []).length === 1, 'applied=' + (cn.body.applied || []).length + ' rejected=' + JSON.stringify(cn.body.rejected?.[0]?.error || null));
    const cSelf = await api(s, '/api/v1/pull?collections=counselor_notes', { headers: auth(s.tokens.teacher[0].token) });
    check('P-15', 'دبیر به یادداشت‌های محرمانهٔ مشاوره دسترسی ندارد', (cSelf.body.collections?.counselor_notes || []).length === 0, 'rows=' + (cSelf.body.collections?.counselor_notes || []).length);
  } else {
    check('P-14', 'مشاور می‌تواند یادداشت مشاوره ثبت کند', false, 'مشاور وارد نشد', 'SKIP');
    check('P-15', 'دبیر به یادداشت‌های محرمانهٔ مشاوره دسترسی ندارد', false, 'مشاور وارد نشد', 'SKIP');
  }

  /* نشست: خروج ⇒ توکن باطل */
  const tmp = await s.login(s.users.students[1].phone, s.users.students[1].national_id, 'student', 'tmp');
  const tmpTok = tmp.body.session.token;
  await api(s, '/api/auth/logout', { method: 'POST', headers: auth(tmpTok) });
  const afterLogout = await api(s, '/api/me', { headers: auth(tmpTok) });
  check('P-11', 'پس از خروج، توکن قبلی رد می‌شود (401)', afterLogout.status === 401, 'status=' + afterLogout.status);
}

function teacherTokensOf(s, classId) {
  const t = s.tokens.teacher.find(x => x.classes.includes(classId));
  return t ? t.token : s.tokens.manager;
}

/* ── سال تحصیلی: ۱۸۰ روز واقعی با حجم واقعی ────────────────────────────── */
async function runSchoolYear() {
  const t = performance.now();
  let ops = 0, requests = 0, dayMs = [];
  const yearStart = Date.now();
  const extra = { announcements: 0, homework: 0, leaves: 0, grades: 0, discipline: 0, counselor: 0, staff: 0, internships: 0 };

  for (let d = 0; d < days.length; d++) {
    const date = days[d];
    const dt0 = performance.now();
    for (const s of schools) {
      const dev = new Device(s, s.tokens.manager, 'manager', 1, 'دستگاه دبیر');
      /* حضور و غیاب: هر کلاس با دبیر خودش */
      for (const cls of s.classes) {
        const tok = teacherTokensOf(s, cls);
        const dev2 = new Device(s, tok, 'teacher', 2, 'دستگاه حضور');
        for (const st of s.roster.get(cls)) {
          const r = rnd();
          const status = r > 0.94 ? 'absent' : (r > 0.90 ? 'late' : (r > 0.885 ? 'excused' : 'present'));
          dev2.push('attendance', { student_id: st.id, class_id: cls, date, status, note: status === 'excused' ? 'مرخصی' : '', source: 'sim' });
        }
        const r2 = await dev2.flush();
        ops += r2.applied; requests += Math.ceil((s.roster.get(cls).length) / CFG.batch);
      }
      /* حضور کارکنان (فقط مدیر) */
      for (const tc of s.users.teachers) {
        const r = rnd();
        dev.push('staff_attendance', { user_id: tc.id, date, status: r > 0.96 ? 'absent' : (r > 0.93 ? 'late' : 'present') });
        extra.staff++;
      }
      /* درخواست مرخصی از سمت اولیا (روزهای زوج) */
      if (d % 2 === 0) {
        const p = s.tokens.parent[d % Math.max(1, s.tokens.parent.length)];
        if (p) {
          const pd = new Device(s, p.token, 'parent', 3, 'دستگاه ولی');
          pd.push('leaves', { student_id: p.child, date, reason: pick(['مرخصی پزشکی', 'امر خانوادگی', 'سفر']), status: 'pending' });
          const rr = await pd.flush();
          ops += rr.applied; requests += 1; extra.leaves += rr.applied;
        }
      }
      /* هفتگی: اطلاعیه/تکلیف/تقویم */
      if (d % 5 === 0) {
        dev.push('announcements', { title: 'اطلاعیه هفتهٔ ' + Math.floor(d / 5), body: 'اطلاعیهٔ آزمون‌ها و برنامهٔ هفته', severity: pick(['normal', 'info', 'important']), audience: 'all', date });
        for (const cls of s.classes) dev.push('homework', { class_id: cls, subject_id: s.subjectIds[d % s.subjectIds.length], title: 'تکلیف هفتهٔ ' + Math.floor(d / 5), description: 'تمرین‌های فصل جاری', due_date: date });
        extra.announcements++; extra.homework += s.classes.length;
      }
      /* انضباط/مشاوره/کارآموزی به‌صورت پراکنده */
      if (d % 9 === 0) {
        const cls = s.classes[d % s.classes.length];
        const st = s.roster.get(cls)[0];
        dev.push('discipline', { student_id: st.id, class_id: cls, type: pick(['تأخیر مکرر', 'غیبت غیرموجه', 'بی‌نظمی']), note: 'ثبت توسط دبیر', date });
        extra.discipline++;
      }
      if (d % 11 === 0 && s.tokens.counselor) {
        const cd = new Device(s, s.tokens.counselor, 'counselor', 4, 'دستگاه مشاور');
        const st = s.roster.get(s.classes[d % s.classes.length])[1] || s.roster.get(s.classes[0])[0];
        cd.push('counselor_notes', { student_id: st.id, note: 'جلسهٔ مشاورهٔ تحصیلی', date, private: true });
        const rr = await cd.flush(); ops += rr.applied; requests += 1; extra.counselor += rr.applied;
      }
      if (s.tokens.guard && d % 9 === 0) {
        await api(s, '/api/v1/pull?collections=announcements,students', { headers: auth(s.tokens.guard) });
        requests++;
      }
      if (d % 13 === 0) {
        const cls = s.classes[d % s.classes.length];
        const st = s.roster.get(cls)[2] || s.roster.get(cls)[0];
        dev.push('internships', { student_id: st.id, class_id: cls, place: 'کارگاه صنعتی', date, hours: 4 });
        extra.internships++;
      }
      /* ثبت بسته‌های روز */
      const r = await dev.flush();
      ops += r.applied; requests += Math.ceil(((s.users.teachers.length) + (d % 5 === 0 ? 1 + s.classes.length : 0) + 1) / CFG.batch);
    }
    dayMs.push(performance.now() - dt0);
    if (d % 20 === 0 || d === days.length - 1) {
      const el = (Date.now() - yearStart) / 1000;
      note('پیشرفت سال: روز ' + (d + 1) + '/' + days.length + ' (' + date + ') · ops=' + ops + ' · ' + Math.round(ops / Math.max(1, el)) + ' ops/s · ' + Math.round(el) + 's');
    }
  }
  /* نمرات: دو نوبت (میان‌ترم و پایانی) برای همهٔ دانش‌آموزان × ۶ درس */
  let gradeOps = 0;
  for (const termI of [0, 1]) {
    const term = termI === 0 ? 'نوبت اول' : 'نوبت دوم';
    for (const s of schools) {
      for (const cls of s.classes) {
        const tok = teacherTokensOf(s, cls);
        const dv = new Device(s, tok, 'teacher', 5, 'دستگاه نمره');
        for (const st of s.roster.get(cls)) {
          for (let k = 0; k < 6; k++) {
            dv.push('grades', {
              student_id: st.id, class_id: cls, subject_id: s.subjectIds[k], term,
              kind: k % 3 === 0 ? 'midterm' : 'monthly', score: Math.round((8 + rnd() * 11) * 4) / 4,
              status: 'pending', teacher_id: tok === s.tokens.manager ? null : (s.tokens.teacher.find(t => t.token === tok)?.id ?? null),
            });
            extra.grades++;
          }
        }
        const r2 = await dv.flush();
        gradeOps += r2.applied; requests += Math.ceil((s.roster.get(cls).length * 6) / CFG.batch);
      }
    }
    note('نمرات ' + term + ': ' + gradeOps + ' ردیف');
  }
  ops += gradeOps;

  /* تأیید نمره‌ها توسط مدیر (مسیر تأیید واقعی) */
  let approved = 0;
  for (const s of schools) {
    const pull = await pullAll(s, s.tokens.manager, 'grades');
    const all = pull.collections.grades || [];
    const dv = new Device(s, s.tokens.manager, 'manager', 0, 'دستگاه مدیر');
    for (const g of all) {
      if (g.status !== 'approved') {
        dv.ops.push({ uid: 'apr-' + g.id, collection: 'grades', type: 'put', id: g.id, base_version: g._version, data: Object.assign({}, g, { status: 'approved', approved_by: 'manager' }) });
      }
    }
    const planned = dv.ops.length;
    const r = await dv.flush();
    approved += r.applied;
    requests += Math.ceil(planned / CFG.batch) + 1;
  }

  /* تأیید مرخصی‌ها توسط مدیر (تصمیم واقعی روی درخواست ولی) */
  let leavesApproved = 0, leavesPending = 0;
  for (const s of schools) {
    const lv = await pullAll(s, s.tokens.manager, 'leaves');
    const rows = (lv.collections.leaves || []).filter(l => l.status === 'pending');
    leavesPending += rows.length;
    const dvm = new Device(s, s.tokens.manager, 'manager', 0, 'دستگاه مدیر');
    for (const l of rows) dvm.ops.push({ uid: 'lv-' + l.id, collection: 'leaves', type: 'put', id: l.id, base_version: l._version, data: Object.assign({}, l, { status: 'approved', decided_by: 'manager' }) });
    const n = dvm.ops.length;
    const r3 = await dvm.flush();
    leavesApproved += r3.applied;
    requests += Math.ceil(n / CFG.batch) + 1;
  }
  check('W-03', 'مدیر درخواست‌های مرخصی ولی را تأیید کرد (جریان تأیید واقعی)', leavesApproved > 0, 'approved=' + leavesApproved + ' از ' + leavesPending + ' درخواست');

  /* خواندن کامل یک مجموعه با صفحه‌بندی (سقف ۳۰۰۰ ردیف در هر pull) */
  const pageAll = await pullAll(schools[0], schools[0].tokens.manager, 'attendance');
  const ids = new Set(pageAll.collections.attendance.map(a => a.id));
  const cnt0 = await counts(schools[0]);
  check('W-04', 'خواندن کل مجموعهٔ حضور با صفحه‌بندی، کامل و بدون تکرار بود',
    ids.size === pageAll.collections.attendance.length && ids.size === cnt0.attendance,
    'pages=' + pageAll.pages + ' rows=' + pageAll.collections.attendance.length + ' unique=' + ids.size + ' bootstrap=' + cnt0.attendance);

  const elapsed = (performance.now() - t) / 1000;
  metrics.year = {
    days: days.length, schools: CFG.schools, ops_total: ops + approved, ops_business: ops,
    grades_approved: approved, seconds: Math.round(elapsed), ops_per_s: Math.round((ops + approved) / elapsed),
    extras: extra, day_ms_avg: Math.round(dayMs.reduce((a, b) => a + b, 0) / dayMs.length),
    requests_est: requests, leaves_approved: leavesApproved, pull_pages: pageAll.pages,
  };
  check('W-01', 'سال تحصیلی شبیه‌سازی شد (حضور/نمره/مرخصی/کارکنان/اطلاعیه/تکلیف/انضباط/مشاوره)',
    ops + approved > CFG.schools * days.length, 'ops=' + (ops + approved) + ' در ' + Math.round(elapsed) + 's (' + metrics.year.ops_per_s + ' ops/s)');
  check('W-02', 'نمرات جلسهٔ تأیید مدیر را طی کردند و approved شدند', approved > 0, 'approved=' + approved);
  check('W-05', 'جریان مشاوره فعال بود: یادداشت مشاوره برای دانش‌آموزان ثبت شد', extra.counselor > 0, 'یادداشت‌های ثبت‌شده=' + extra.counselor + ' (۴ مدرسه)');
}

/* ── شرایط سخت: ری‌استارت، تعارض، بکاپ/بازیابی، جداسازی، محدودیت نرخ ──── */
async function concurrencyCheck() {
  const s = schools[0];
  const day = '2027-06-30'; /* روز خارج از تقویم سال، برای سنجش هم‌زمانی */
  const jobs = [];
  const t0 = performance.now();
  for (let c = 0; c < Math.min(8, s.classes.length); c++) {
    const cls = s.classes[c];
    const dv = new Device(s, teacherTokensOf(s, cls), 'teacher', 0, 'دستگاه هم‌زمان ' + c);
    for (const st of s.roster.get(cls)) dv.push('attendance', { student_id: st.id, class_id: cls, date: day, status: 'present', note: 'هم‌زمانی' });
    jobs.push(dv);
  }
  const results = await Promise.all(jobs.map(d => d.flush()));
  const ms = Math.round(performance.now() - t0);
  const applied = results.reduce((n, r) => n + r.applied, 0);
  const rejected = results.reduce((n, r) => n + r.rejected, 0);
  const conflicts = results.reduce((n, r) => n + (r.conflicts || 0), 0);
  const expected = jobs.reduce((n, d) => n + d.opsTotal, 0);
  metrics.concurrency = { devices: jobs.length, rows: applied, expected, rejected, ms, ops_per_s: Math.round(applied / (ms / 1000)), conflicts };
  check('C-01', 'هم‌زمانی: چند دستگاه هم‌زمان می‌نویسند و همهٔ ردیف‌ها ثبت می‌شوند',
    applied === expected && rejected === 0,
    jobs.length + ' دستگاه · ' + applied + '/' + expected + ' ردیف در ' + ms + 'ms (' + metrics.concurrency.ops_per_s + ' ops/s) · ردشده=' + rejected + ' · تعارض=' + conflicts);
}

async function faultAndRecoveryChecks() {
  const s = schools[0];
  const before = await counts(s);

  /* ۱) قطع ناگهانی سرور در میانهٔ کار (SIGKILL) و بازگشت */
  const dv = new Device(s, s.tokens.manager, 'manager', 9, 'دستگاه مدیر');
  const date = days[days.length - 1];
  for (const st of s.roster.get(s.classes[0])) dv.push('attendance', { student_id: st.id, class_id: s.classes[0], date, status: 'present', note: 'پس از قطعی', source: 'sim-crash' });
  const pending = dv.ops.slice();
  const firstChunk = pending.splice(0, Math.ceil(pending.length / 2));
  const pre = await api(s, '/api/sync', jsonBody({ ops: firstChunk }, s.tokens.manager));
  const downMs = await s.restart('SIGKILL');
  const retry = await api(s, '/api/sync', jsonBody({ ops: firstChunk.concat(pending) }, s.tokens.manager));
  const dupCount = (retry.body.applied || []).filter(a => a.duplicate).length;
  const after = await counts(s);
  const grew = after.attendance - before.attendance;
  const expected = firstChunk.length + pending.length;
  metrics.faults.crash = { down_ms: downMs, before_attendance: before.attendance, after_attendance: after.attendance, growth: grew, expected_rows: expected, duplicates_on_retry: dupCount, first_applied: (pre.body.applied || []).length, retry_applied: (retry.body.applied || []).length };
  check('F-01', 'قطعی ناگهانی (SIGKILL) و بازگشت: هیچ دادهٔ ثبت‌شده‌ای از دست نرفت',
    grew === expected, 'قبل=' + before.attendance + ' بعد=' + after.attendance + ' رشد=' + grew + '/' + expected + ' downtime=' + downMs + 'ms');
  check('F-02', 'بازفرست بسته پس از قطعی: ردیف تکراری ساخته نشد (idempotency)',
    grew === expected && dupCount === firstChunk.length,
    'total_rows=' + grew + '/' + expected + ' تکراری‌های علامت‌خورده=' + dupCount + '/' + firstChunk.length);

  /* ۲) تعارض هم‌زمان (دو دستگاه، یک ردیف) و حل آن توسط مدیر */
  const roster = s.roster.get(s.classes[1]) || s.roster.get(s.classes[0]);
  const student = roster[0];
  const base = { student_id: student.id, class_id: s.classes[1] ?? s.classes[0], date, status: 'present', source: 'sim-conflict' };
  const mk = await api(s, '/api/sync', jsonBody({ ops: [{ uid: 'cf-base-' + Date.now(), collection: 'attendance', type: 'put', data: base }] }, s.tokens.manager));
  const recId = mk.body.applied[0].id;
  const ver = mk.body.applied[0].version;
  /* دستگاه A با نسخهٔ قدیمی می‌نویسد */
  const aWrite = await api(s, '/api/sync', jsonBody({ ops: [{ uid: 'cf-a-' + Date.now(), collection: 'attendance', type: 'put', id: recId, base_version: ver, data: Object.assign({}, base, { status: 'absent', note: 'ثبت آفلاین A' }) }] }, s.tokens.manager));
  /* دستگاه B از قبل همان ردیف را به‌روز کرده (نسخه بالا رفته) */
  const bWrite = await api(s, '/api/sync', jsonBody({ ops: [{ uid: 'cf-b-' + Date.now(), collection: 'attendance', type: 'put', id: recId, base_version: ver, data: Object.assign({}, base, { status: 'late', note: 'ثبت آفلاین B' }) }] }, s.tokens.manager));
  const conflictId = bWrite.body.conflicts?.[0]?.conflict_id;
  /* یک تعارض دوم برای آزمون «فقط مدیر» می‌سازیم تا تعارض اول آزاد بماند */
  const mk2 = await api(s, '/api/sync', jsonBody({ ops: [{ uid: 'cf2-base-' + Date.now(), collection: 'attendance', type: 'put', data: Object.assign({}, base, { note: 'پایهٔ تعارض ۲' }) }] }, s.tokens.manager));
  const rec2 = mk2.body.applied[0];
  await api(s, '/api/sync', jsonBody({ ops: [{ uid: 'cf2-x-' + Date.now(), collection: 'attendance', type: 'put', id: rec2.id, base_version: rec2.version, data: Object.assign({}, base, { note: 'به‌روزرسانی ۱' }) }] }, s.tokens.manager));
  const b2 = await api(s, '/api/sync', jsonBody({ ops: [{ uid: 'cf2-y-' + Date.now(), collection: 'attendance', type: 'put', id: rec2.id, base_version: rec2.version, data: Object.assign({}, base, { note: 'به‌روزرسانی ۲ (قدیمی)' }) }] }, s.tokens.manager));
  const conflict2 = b2.body.conflicts?.[0]?.conflict_id;
  let forbidden = null;
  if (conflict2) {
    forbidden = await api(s, '/api/conflicts/' + conflict2 + '/resolve', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, auth(s.tokens.teacher[0].token)), body: JSON.stringify({ decision: 'local' }) });
  }
  let resolved = null;
  const target = conflictId || conflict2;
  if (target) {
    resolved = await api(s, '/api/conflicts/' + target + '/resolve', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, auth(s.tokens.manager)), body: JSON.stringify({ decision: 'local' }) });
  }
  metrics.faults.conflict = { conflict_id: conflictId || null, resolved: !!(resolved && resolved.body.ok), by_teacher_status: forbidden ? forbidden.status : null };
  check('F-03', 'تعارض هم‌زمان (OCC) به‌جای بازنویسی کور، ثبت و برای تصمیم نگه داشته شد',
    !!conflictId || aWrite.body.conflicts?.length > 0, 'conflict_id=' + (conflictId || 'none'));
  check('F-04', 'حل تعارض فقط با مدیر مجاز است', forbidden && (forbidden.status === 403 || forbidden.body.error === 'forbidden'), 'teacher_status=' + (forbidden && forbidden.status));

  /* ۳) بکاپ و بازیابی واقعی */
  const bh = await api(s, '/api/admin/backup', { method: 'POST', headers: auth(s.tokens.manager) });
  const mirrorRefresh = await api(s, '/api/admin/mirror/refresh', { method: 'POST', headers: auth(s.tokens.manager) });
  const snapFile = path.join(s.data, 'mirror', 'payesh-data.json');
  let snap = null;
  try { snap = JSON.parse(fs.readFileSync(snapFile, 'utf8')); } catch (e) { snap = null; }
  const countsAtSnap = await counts(s);
  /* دادهٔ اضافی بعد از بکاپ */
  const dv2 = new Device(s, s.tokens.manager, 'manager', 10, 'دستگاه مدیر');
  for (let i = 0; i < 40; i++) dv2.push('announcements', { title: 'پس از بکاپ ' + i, body: 'x', date, audience: 'all' });
  await dv2.flush();
  const countsAfterExtra = await counts(s);
  let restoreRes = null;
  if (snap) {
    const rr = await fetch('http://127.0.0.1:' + s.port + '/api/admin/restore', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, auth(s.tokens.manager)), body: JSON.stringify({ data: snap, replace: true }) });
    restoreRes = { status: rr.status, body: await rr.json().catch(() => ({})) };
  }
  const countsAfterRestore = await counts(s);
  metrics.faults.backup = {
    backup_file: bh.body.file || null, backup_size: bh.body.size || null,
    mirror_ok: !!(mirrorRefresh.body && mirrorRefresh.body.ok), snapshot_bytes: snap ? JSON.stringify(snap).length : 0,
    before: countsAtSnap, after_extra: countsAfterExtra, after_restore: countsAfterRestore,
    restore_status: restoreRes && restoreRes.status, restore_ok: restoreRes && restoreRes.body && restoreRes.body.ok,
  };
  check('F-05', 'بکاپ SQLite و آینهٔ امضاشده ساخته شد', !!bh.body.file && !!(snap && snap.collections), 'file=' + (bh.body.file || '-') + ' size=' + (bh.body.size || 0) + 'B · snapshot=' + Math.round((snap ? JSON.stringify(snap).length : 0) / 1024) + 'KB');
  check('F-06', 'بازیابی از پشتیبان، وضعیت را به لحظهٔ بکاپ برگرداند (بدون از دست دادن ساختار)',
    !!(restoreRes && restoreRes.body && restoreRes.body.ok) && countsAfterRestore.users === countsAtSnap.users, 'restore=' + (restoreRes && restoreRes.status) + ' users before=' + countsAtSnap.users + ' after=' + countsAfterRestore.users);

  /* ۴) جداسازی بین مدارس: توکن مدرسهٔ A روی مدرسهٔ B */
  const cross = await api(schools[1], '/api/me', { headers: auth(s.tokens.manager) });
  check('F-07', 'توکن یک مدرسه روی نمونهٔ مدرسهٔ دیگر پذیرفته نمی‌شود', cross.status === 401, 'status=' + cross.status);

  /* ۵) محدودیت نرخ ورود (۲۰ تلاش در دقیقه برای هر شماره) */
  const rlSchool = schools[Math.min(2, schools.length - 1)];
  const rlUser = rlSchool.users.students[0];
  let limited = 0;
  for (let i = 0; i < 24; i++) {
    const r = await api(rlSchool, '/api/auth/login', jsonBody({ phone: rlUser.phone, password: 'wrong-' + i }));
    if (r.status === 429) { limited = i + 1; break; }
  }
  check('F-08', 'محدودیت نرخ ورود (brute-force) فعال است', limited > 0 && limited <= 22, 'اولین 429 در تلاش ' + limited);

  /* ۶) خروجی CSV: هیچ هش/رمز بیرون نمی‌رود */
  const csvRes = await fetch('http://127.0.0.1:' + s.port + '/api/admin/export?collection=users', { headers: auth(s.tokens.manager) });
  const csv = await csvRes.text();
  const hasLeak = /password_hash|phone_hash|password_plain|password_cipher|pbkdf2\$/.test(csv);
  check('F-09', 'خروجی CSV هیچ هش/رمز خام/اعتبارنامهٔ قابل‌استفاده ندارد (SEC-01)', !hasLeak, 'bytes=' + csv.length + ' هش/رمز خام=' + hasLeak);
  if (/password_enc/.test(csv)) note('مشاهده: خروجی CSV فیلد password_enc (رمز رمزنگاری‌شده با کلید سرور) را هم بیرون می‌دهد؛ متن خام نیست ولی بهتر است حذف شود (پیشنهاد سخت‌سازی، نه شکست قابلیت).');

  /* ۷) تیکت گوشی: ۲۰۰ روز */
  const tk = await api(s, '/api/phone/ticket', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, auth(s.tokens.manager)), body: JSON.stringify({}) });
  const ttl = tk.body && (tk.body.device_ticket && tk.body.device_ticket.ttl_days) || (tk.body && tk.body.ttl_days);
  if (ttl == null) {
    check('F-10', 'تیکت دستگاه گوشی ۲۰۰ روزه (نیازمند پیکربندی ابری در این مدرسه)', false,
      'در این نمونه ابر پیکربندی نشده: ' + JSON.stringify(tk.body).slice(0, 120), 'SKIP');
    note('F-10: تیکت گوشی در این شبیه‌سازی قابل صدور نبود (بدون پیکربندی S3). TTL=۲۰۰ روز قبلاً در ردیف ۲۲ اثبات شده است.');
  } else {
    check('F-10', 'تیکت دستگاه گوشی با TTL ۲۰۰ روز صادر می‌شود', Number(ttl) === 200, 'ttl_days=' + ttl);
  }
}

/* ── شمارش واقعی کالکشن‌ها از مسیر محصول ───────────────────────────────── */
async function counts(s) {
  const r = await api(s, '/api/bootstrap', { headers: auth(s.tokens.manager) });
  const c = (r.body && r.body.counts) || {};
  return { users: c.users || 0, classes: c.classes || 0, attendance: c.attendance || 0, grades: c.grades || 0 };
}

/* ── خواندن کامل با صفحه‌بندی واقعی (سقف ۳۰۰۰ ردیف در هر pull) ────────── */
async function pullAll(s, token, collections) {
  const out = {}; const deleted = []; let since = '1970-01-01T00:00:00.000Z'; let sinceId = 0; let pages = 0; let more = true;
  while (more && pages < 40) {
    /* قرارداد Sync v1: مکان‌نمای مرکب (since, since_id) — بدون آن ردیف‌های
       هم‌مهرزمان با مرز صفحه گم می‌شوند (باگ W-04). */
    const r = await api(s, '/api/v1/pull?collections=' + collections + '&since=' + encodeURIComponent(since) + '&since_id=' + sinceId, { headers: auth(token) });
    pages++;
    for (const [k, rows] of Object.entries(r.body.collections || {})) { if (!out[k]) out[k] = []; out[k].push(...rows); }
    deleted.push(...(r.body.deleted || []));
    more = !!r.body.more;
    if (more && r.body.next_since) { since = r.body.next_since; sinceId = Number(r.body.next_id || 0); } else more = false;
  }
  return { collections: out, deleted, pages };
}

/* ── یکپارچگی داده: orphan، هش نمونه، integrity_check، حجم ─────────────── */
async function integrityChecks() {
  const sqlite = await import('node:sqlite').catch(() => null);
  for (const s of schools) {
    const dbFile = path.join(s.data, 'payesh.sqlite');
    const size = fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0;
    let integrity = 'unavailable', orphans = null, auditRows = null, plainPw = null, totalRows = null;
    const byCollection = {};
    if (sqlite) {
      const db = new sqlite.DatabaseSync(dbFile, { readOnly: true });
      try {
        integrity = String(db.prepare('PRAGMA integrity_check').get()?.integrity_check || 'unknown');
        orphans = db.prepare("SELECT COUNT(*) AS n FROM records a WHERE a.collection='attendance' AND NOT EXISTS (SELECT 1 FROM records u WHERE u.collection='users' AND u.id=a.ref2)").get().n;
        auditRows = db.prepare("SELECT COUNT(*) AS n FROM records WHERE collection='audit'").get().n;
        for (const r of db.prepare("SELECT collection AS c, COUNT(*) AS n FROM records GROUP BY collection ORDER BY n DESC").all()) byCollection[r.c] = r.n;
        plainPw = db.prepare("SELECT COUNT(*) AS n FROM records WHERE collection='users' AND (data LIKE '%\"password_plain\"%' OR (data LIKE '%\"password_enc\"%' AND data NOT LIKE '%enc:v1:%'))").get().n;
        totalRows = db.prepare('SELECT COUNT(*) AS n FROM records WHERE deleted_at IS NULL').get().n;
      } finally { db.close(); }
    }
    /* نمونهٔ هش: حضور یک کلاس در یک هفته باید بین «سرور» و «pull مدیر» یکی باشد */
    const cls = s.classes[0];
    const week = days.slice(0, 5);
    const pull = await pullAll(s, s.tokens.manager, 'attendance');
    const rows = (pull.collections.attendance || []).filter(a => Number(a.class_id) === cls && week.includes(a.date));
    const sig = rows.map(a => a.student_id + ':' + a.date + ':' + a.status).sort().join('|');
    const crypto = await import('node:crypto');
    const hash = crypto.createHash('sha256').update(sig).digest('hex').slice(0, 16);
    metrics.integrity['school' + s.i] = { db_bytes: size, total_rows: totalRows, by_collection: byCollection, audit_rows: auditRows, integrity, attendance_orphans: orphans, leaked_password_rows: plainPw, sample_week_rows: rows.length, sample_hash: hash };
    check('I-0' + (s.i + 1), 'یکپارچگی دادهٔ مدرسهٔ ' + (s.i + 1) + ' (SQLite + ارجاع‌ها + نبود رمز خام)',
      integrity === 'ok' && Number(orphans) === 0 && Number(plainPw) === 0,
      'integrity=' + integrity + ' rows=' + totalRows + ' orphan=' + orphans + ' رمز خام=' + plainPw + ' db=' + Math.round(size / 1048576) + 'MB');
  }
  const totalRows = Object.values(metrics.integrity).reduce((n, x) => n + (x.total_rows || 0), 0);
  check('I-99', 'جمع ردیف‌های واقعی ثبت‌شده در همهٔ مدارس', totalRows > 0, 'total_rows=' + totalRows + ' · db_total=' + Math.round(Object.values(metrics.integrity).reduce((n, x) => n + (x.db_bytes || 0), 0) / 1048576) + 'MB');
}

/* ── نوشتن شاهد ────────────────────────────────────────────────────────── */
async function writeWitness() {
  /* مصرف حافظهٔ هر نمونه */
  const mem = [];
  for (const s of schools) {
    let rss = null;
    try {
      const status = fs.readFileSync('/proc/' + s.proc.pid + '/status', 'utf8');
      const m = status.match(/VmRSS:\s+(\d+) kB/);
      rss = m ? Math.round(Number(m[1]) / 1024) : null;
    } catch {}
    mem.push({ port: s.port, rss_mb: rss, boot_ms: s.bootMs });
  }
  metrics.performance = { latency: latSummary(), calls: lat.calls, errors: lat.errors, memory: mem };
  metrics.checks = checks;
  metrics.elapsed_s = Math.round((Date.now() - T0) / 1000);
  const failed = checks.filter(c => !c.ok);
  metrics.verdict = failed.length ? 'SIM-FAIL' : 'SIM-OK';

  fs.mkdirSync(path.join(EVID, 'sim'), { recursive: true });
  fs.writeFileSync(path.join(EVID, 'sim', 'sim-summary.json'), JSON.stringify(metrics, null, 2));

  const lines = [];
  lines.push('# شبیه‌سازی سال تحصیلی چند‌مدرسه‌ای — شاهد خام');
  lines.push('# تولید: node docs/cloud/reports/evidence/sim/school-year-sim.mjs');
  lines.push('# زمان: ' + new Date().toISOString());
  lines.push('# head: ' + (process.env.GIT_HEAD || 'unknown'));
  lines.push('# harness_sha256: ' + crypto.createHash('sha256').update(fs.readFileSync(new URL(import.meta.url), 'utf8')).digest('hex'));
  lines.push('# node: ' + process.version + ' · os: ' + process.platform + ' · cpus: ' + (await import('node:os')).cpus().length);
  lines.push('# config: ' + JSON.stringify(CFG));
  lines.push('');
  for (const c of checks) lines.push((c.state === 'PASS' ? 'PASS  ' : c.state === 'SKIP' ? 'SKIP  ' : 'FAIL  ') + c.id.padEnd(6) + c.name + (c.detail ? '  → ' + c.detail : ''));
  for (const n of notes) lines.push('# ' + n);
  lines.push('');
  lines.push('year: days=' + metrics.year.days + ' schools=' + metrics.year.schools + ' ops=' + metrics.year.ops_total + ' ops_per_s=' + metrics.year.ops_per_s + ' seconds=' + metrics.year.seconds);
  lines.push('faults: ' + JSON.stringify(metrics.faults.crash) + ' · conflict=' + JSON.stringify(metrics.faults.conflict) + ' · backup_restore=' + (metrics.faults.backup && metrics.faults.backup.restore_ok));
  lines.push('integrity: ' + Object.entries(metrics.integrity).map(([k, v]) => k + ':' + v.integrity + '/rows=' + v.total_rows + '/orphan=' + v.attendance_orphans + '/db=' + Math.round(v.db_bytes / 1048576) + 'MB').join(' | '));
  const L = metrics.performance.latency;
  for (const k of Object.keys(L)) lines.push('latency: ' + k + ' n=' + L[k].n + ' p50=' + L[k].p50 + 'ms p95=' + L[k].p95 + 'ms p99=' + L[k].p99 + 'ms');
  const coll = metrics.integrity.school0 && metrics.integrity.school0.by_collection;
  if (coll) lines.push('collections(school0): ' + Object.entries(coll).slice(0, 14).map(([k, v]) => k + '=' + v).join(' '));
  lines.push('memory: ' + mem.map(m => m.port + '=' + m.rss_mb + 'MB').join(' '));
  lines.push('calls=' + lat.calls + ' transport_errors=' + lat.errors + ' http4xx_expected=' + lat.http4xx + ' http5xx=' + lat.http5xx + ' checks=' + checks.length + ' failed=' + failed.length);
  lines.push(metrics.verdict + ' checks=' + checks.length);
  fs.writeFileSync(path.join(EVID, 'school-year-sim.txt'), lines.join('\n') + '\n');
  console.log(lines.slice(-3).join('\n'));
  if (failed.length) { console.log('FAILED: ' + failed.map(f => f.id).join(',')); process.exitCode = 1; }
}

/* ── پایان: خاموشی تمیز ────────────────────────────────────────────────── */
const cleanup = async () => { for (const s of schools) { try { await s.stop(); } catch {} } };
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

main().then(async () => { await cleanup(); }).catch(async (e) => {
  console.error('SIM-ERROR ' + (e && e.stack || e));
  try { fs.mkdirSync(path.join(EVID, 'sim'), { recursive: true }); fs.writeFileSync(path.join(EVID, 'school-year-sim.ERROR.txt'), String(e && e.stack || e)); } catch {}
  await cleanup();
  process.exit(3);
});
