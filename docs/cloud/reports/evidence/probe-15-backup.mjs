#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   پروب مأموریت ۱۵ — رفتار اجرایی «بکاپ و بازیابی» در کد امروز
   (بدون تغییر کد محصول؛ دیتابیس موقت، فایل‌ها فقط در TMP)

   چه چیزی را ثابت می‌کند:
     N1  فایل بکاپ روی دیسک، SQLite خام است (بدون رمزنگاری) — AC «بکاپ رمزنگاری‌شده»
     N2  همان فایل، password_hash کاربران را به‌صورت خوانا دارد (نسخهٔ اعتبارنامه)
     N3  بازیابی با نقش غیرمدیر مجاز است (BACKUP_ROLES چهار نقش) — F‑02
     N4  همان نقش با payload دست‌کاری‌شده، نقش دانش‌آموز را به manager ارتقا می‌دهد
     N5  هیچ مانیفست/امضا/هش اجباری نیست: payload با ادعای هش غلط پذیرفته می‌شود
     N6  replace=true با payload کوچک، ردیف‌های خارج از فایل را حذف می‌کند (تخریب)
     N7  ردیف audit بازیابی، هویت عامل (user_id) ندارد

   اجرا:  node --experimental-sqlite --disable-warning=ExperimentalWarning \
            docs/cloud/reports/evidence/probe-15-backup.mjs
   ═══════════════════════════════════════════════════════════════════ */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-m15-'));

const results = [];
function rec(id, title, data) { results.push({ id, title, data }); }

async function freePort() {
  const net = await import('node:net');
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    PORT: String(PORT), HOST: '127.0.0.1', PAYESH_DATA: TMP, PAYESH_LOG: '0',
    PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0', PAYESH_LIVE_MS: '0',
    PAYESH_OUTBOX_AUTO: '0', PAYESH_CLOUD_AUTO: '0', PAYESH_MIRROR: '0', PAYESH_TRUST_PROXY: '0',
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', () => {});

async function req(p, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = 'Bearer ' + opts.token;
  const res = await fetch(BASE + p, {
    method: opts.method || 'GET', headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

async function waitFor(fn, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fn(); if (r) return r; } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 120));
  }
  throw new Error('server did not start');
}

function cleanup(code) {
  try { child.kill('SIGKILL'); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(code);
}

try {
  await waitFor(async () => (await req('/api/health')).data?.ok);

  const setup = await req('/api/setup', { method: 'POST', body: {
    school_name: 'دبیرستان پروب ۱۵', manager_name: 'مدیر پروب', password: 'Probe-15-Aa', phone: '09120000015',
  } });
  if (!setup.data?.ok) throw new Error('setup failed: ' + JSON.stringify(setup.data));
  const mTok = setup.data.session.token;

  /* دادهٔ پایه: کلاس، دانش‌آموز، دبیر، دو نمره */
  const mk = await req('/api/sync', { method: 'POST', token: mTok, body: { ops: [
    { uid: 'b-c1', collection: 'classes', type: 'put', data: { name: 'دهم پروب ۱۵', grade: 'دهم' } },
    { uid: 'b-u1', collection: 'users', type: 'put', data: { name: 'دانش‌آموز پروب', role: 'student', phone: '09121110015', national_id: '1000000015' } },
    { uid: 'b-u2', collection: 'users', type: 'put', data: { name: 'دبیر پروب', role: 'teacher', phone: '09122220015', national_id: '1000000025' } },
  ] } });
  const classId = mk.data.applied[0].id, studentId = mk.data.applied[1].id, teacherId = mk.data.applied[2].id;

  const g = await req('/api/sync', { method: 'POST', token: mTok, body: { ops: [
    { uid: 'b-g1', collection: 'grades', type: 'put', data: { class_id: classId, student_id: studentId, subject_id: 1, term: 'n1', score: 18 } },
    { uid: 'b-g2', collection: 'grades', type: 'put', data: { class_id: classId, student_id: studentId, subject_id: 2, term: 'n1', score: 17 } },
  ] } });
  const gradeId = g.data.applied[0].id;

  /* N1 — بکاپ واقعی و بررسی بایت‌های اول */
  const bak = await req('/api/admin/backup', { method: 'POST', token: mTok });
  const list = await req('/api/admin/backups', { token: mTok });
  const files = list.data?.files || [];
  const newest = files[0];
  let header = '', isPlaintext = false, hasEncEnvelope = false, sizeBytes = 0;
  if (newest) {
    const buf = fs.readFileSync(path.join(TMP, 'backups', newest));
    header = buf.subarray(0, 15).toString('latin1');
    isPlaintext = header === 'SQLite format 3';
    sizeBytes = buf.length;
    hasEncEnvelope = !!(bak.data && /enc|gpg|aes|iv/i.test(JSON.stringify(bak.data)));
  }
  rec('N1', 'قالب فایل بکاپ', {
    backup_ok: !!bak.data?.ok, files: files.length, newest: newest ? 'payesh-*.sqlite' : null,
    magic: header.replace(/\0/g, '\\0'), plaintext_sqlite: isPlaintext,
    encrypted_envelope_in_response: hasEncEnvelope, size_bytes: sizeBytes,
  });

  /* N2 — اعتبارنامهٔ خوانا داخل همان فایل */
  let pwHashes = 0, userRows = 0;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const bdb = new DatabaseSync(path.join(TMP, 'backups', newest));
    const rows = bdb.prepare("SELECT id, data FROM records WHERE collection='users' AND deleted_at IS NULL").all();
    userRows = rows.length;
    for (const r of rows) {
      const d = JSON.parse(r.data || '{}');
      if (d.password_hash) pwHashes += 1;
    }
    bdb.close();
  } catch (e) { rec('N2e', 'خطا در خواندن بکاپ', { error: String(e.message).slice(0, 60) }); }
  rec('N2', 'اعتبارنامه در فایل بکاپ', { user_rows: userRows, rows_with_password_hash: pwHashes });

  /* ورود دبیر */
  const tLogin = await req('/api/auth/login', { method: 'POST', body: { phone: '09122220015', password: '1000000025' } });
  const tTok = tLogin.data?.session?.token || null;

  /* N3 — بازیابی با نقش دبیر (غیرمدیر) */
  const tRestore = await req('/api/admin/restore', { method: 'POST', token: tTok, body: {
    data: { format: 'payesh-backup', collections: {} },
  } });
  rec('N3', 'بازیابی با نقش دبیر', {
    teacher_token: !!tTok, status: tRestore.status, ok: !!tRestore.data?.ok,
    error: tRestore.data?.error || null,
  });

  /* N4 — payload دست‌کاری‌شده: نقش دانش‌آموز ⇒ manager (توسط همان دبیر) */
  const usersPayload = await (async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(TMP, 'payesh.sqlite'));
    const rows = db.prepare("SELECT id, data FROM records WHERE collection='users' AND deleted_at IS NULL").all();
    db.close();
    return rows.map(r => Object.assign({ id: Number(r.id) }, JSON.parse(r.data || '{}')));
  })();
  const tampered = usersPayload.map(u => (Number(u.id) === Number(studentId) ? Object.assign({}, u, { role: 'manager' }) : u));
  const esc = await req('/api/admin/restore', { method: 'POST', token: tTok, body: {
    data: { format: 'payesh-backup', collections: { users: tampered } },
  } });
  const roleAfter = await (async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(TMP, 'payesh.sqlite'));
    const r = db.prepare("SELECT data FROM records WHERE collection='users' AND id=?").get(studentId);
    db.close();
    return r ? JSON.parse(r.data).role : null;
  })();
  rec('N4', 'بازیابی payload دست‌کاری‌شده', {
    restore_ok: !!esc.data?.ok, users_restored: esc.data?.report?.restored?.users ?? null,
    student_role_after: roleAfter, escalation: roleAfter === 'manager',
  });

  /* N5 — ادعای هش غلط/مانیفست جعلی: آیا بررسی می‌شود؟ */
  const fakeManifest = await req('/api/admin/restore', { method: 'POST', token: mTok, body: {
    data: { format: 'payesh-backup', collections: {}, manifest: { sha256: 'deadbeef', signature: 'none' } },
  } });
  rec('N5', 'مانیفست جعلی', {
    status: fakeManifest.status, ok: !!fakeManifest.data?.ok,
    integrity_verified: false, error: fakeManifest.data?.error || null,
  });

  /* N6 — replace=true با payload کوچک ⇒ حذف ردیف‌های خارج از فایل */
  const before = await (async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(TMP, 'payesh.sqlite'));
    const n = db.prepare("SELECT COUNT(*) AS n FROM records WHERE collection='grades' AND deleted_at IS NULL").get();
    db.close();
    return Number(n.n);
  })();
  const destructive = await req('/api/admin/restore', { method: 'POST', token: mTok, body: {
    replace: true,
    data: { format: 'payesh-backup', collections: { grades: [] } },
  } });
  const after = await (async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(TMP, 'payesh.sqlite'));
    const n = db.prepare("SELECT COUNT(*) AS n FROM records WHERE collection='grades' AND deleted_at IS NULL").get();
    db.close();
    return Number(n.n);
  })();
  rec('N6', 'بازیابی replace=true با فایل ناقص', {
    grades_before: before, grades_after: after,
    replaced_reported: destructive.data?.report?.replaced ?? null,
    rows_destroyed: before - after,
  });

  /* N7 — هویت عامل در audit بازیابی */
  let auditCols = [], restoreAudit = null;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(TMP, 'payesh.sqlite'));
    auditCols = db.prepare("PRAGMA table_info(audit)").all().map(c => c.name);
    restoreAudit = db.prepare("SELECT * FROM audit WHERE action='restore' ORDER BY id DESC LIMIT 1").get() || null;
    db.close();
  } catch (e) { rec('N7e', 'خطا در audit', { error: String(e.message).slice(0, 60) }); }
  rec('N7', 'ردیف audit بازیابی', {
    columns: auditCols,
    has_actor_column: auditCols.includes('user_id'),
    last_restore_role: restoreAudit ? (restoreAudit.role ?? null) : null,
    last_restore_user_id: restoreAudit ? (restoreAudit.user_id ?? null) : null,
    actor_recorded: !!restoreAudit && restoreAudit.user_id != null,
  });

  const sha = (() => { try { return execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); } catch { return 'unknown'; } })();

  console.log('PROBE-15-BACKUP — رفتار اجرایی کد امروز');
  console.log('SHA=' + sha);
  console.log('TEMP_DB=isolated (not repository data/)');
  for (const r of results) console.log(`${r.id} | ${r.title} | ${JSON.stringify(r.data)}`);

  const by = id => results.find(r => r.id === id)?.data || {};
  const expectations = {
    'N1': by('N1').plaintext_sqlite === true && by('N1').encrypted_envelope_in_response === false,
    'N2': by('N2').rows_with_password_hash > 0,
    'N3': by('N3').status === 200 && by('N3').ok === true,
    'N4': by('N4').escalation === true,
    'N5': by('N5').status === 200 && by('N5').ok === true,
    'N6': by('N6').rows_destroyed > 0,
    'N7': by('N7').has_actor_column === true && by('N7').last_restore_user_id === null,
  };
  const bad = Object.entries(expectations).filter(([, ok]) => !ok).map(([k]) => k);
  console.log('EXPECTATIONS=' + (bad.length ? 'MISMATCH:' + bad.join(',') : 'ALL-MET'));
} catch (e) {
  console.log('PROBE FAILED: ' + (e && e.message));
  cleanup(1);
}
cleanup(0);
