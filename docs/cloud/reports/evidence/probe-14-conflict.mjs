#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   پروب مأموریت ۱۴ — رفتار اجرایی «تعارض» در کد امروز (بدون تغییر کد محصول)

   چه چیزی را ثابت می‌کند (همه با سرور واقعی، دیتابیس موقت، بدون دست‌زدن به data/):
     N1  تعارض واقعی: op با base_version کهنه ⇒ 409-like پاسخ conflicts (رفتار درست)
     N2  اما هیچ رکورد تعارضی در پایگاه ذخیره نمی‌شود (نبود audit trail برای تلاش بازنده)
     N3  op بدون base_version ⇒ نوشتن بی‌قید (last-write-wins واقعی)
     N4  op با base_version = 0 ⇒ نوشتن بی‌قید (همان مسیر؛ کلاینت واقعی برای رمز همین را می‌فرستد)
     N5  دورزدن مجوز: نقش بدون حق نوشتن، در مسیر تعارض **کل ردیف سرور** را می‌گیرد
         (چون بررسی تعارض پیش از gate نقش/اسکوپ است)
     N6  همان نقش با base_version درست ⇒ rejected (پس gate وجود دارد، ولی مسیر تعارض از آن رد می‌شود)

   خروجی: ساختار ثابت (بدون مهر زمان/پورت/توکن) تا بازتولید بایت‌به‌بایت ممکن باشد.
   اجرا:  node --experimental-sqlite --disable-warning=ExperimentalWarning \
            docs/cloud/reports/evidence/probe-14-conflict.mjs
   ═══════════════════════════════════════════════════════════════════ */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-m14-'));

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
    school_name: 'دبیرستان پروب ۱۴', manager_name: 'مدیر پروب', password: 'Probe-14-Aa', phone: '09120000014',
  } });
  if (!setup.data?.ok) throw new Error('setup failed: ' + JSON.stringify(setup.data));
  const mTok = setup.data.session.token;

  /* کلاس و دانش‌آموز */
  const mk = await req('/api/sync', { method: 'POST', token: mTok, body: { ops: [
    { uid: 'p-c1', collection: 'classes', type: 'put', data: { name: 'دهم پروب', grade: 'دهم' } },
    { uid: 'p-u1', collection: 'users', type: 'put', data: { name: 'دانش‌آموز پروب', role: 'student', phone: '09121110014', national_id: '1000000014' } },
  ] } });
  const applied = mk.data.applied;
  const classId = applied[0].id, studentId = applied[1].id;

  /* ردیف نمره */
  const g = await req('/api/sync', { method: 'POST', token: mTok, body: { ops: [
    { uid: 'p-g1', collection: 'grades', type: 'put', data: { class_id: classId, student_id: studentId, subject_id: 1, term: 'n1', score: 18 } },
  ] } });
  const gradeId = g.data.applied[0].id;
  const v1 = g.data.applied[0].version;

  /* pull واقعی از مسیر موجود: /api/v1/pull */
  const pullVia = async () => req('/api/v1/pull?since=1970-01-01T00:00:00.000Z&collections=grades', { token: mTok });

  /* N1/N2 — تعارض با نسخهٔ کهنه */
  const fresh = await req('/api/sync', { method: 'POST', token: mTok, body: { ops: [
    { uid: 'p-g2', collection: 'grades', type: 'put', id: gradeId, base_version: v1, data: { score: 19 } },
  ] } });
  const v2 = fresh.data.applied[0].version;

  const stale = await req('/api/sync', { method: 'POST', token: mTok, body: { ops: [
    { uid: 'p-g3', collection: 'grades', type: 'put', id: gradeId, base_version: v1, data: { score: 15 } },
  ] } });
  const conflictReturned = (stale.data.conflicts || []).length;
  const conflictHasServerRow = !!(stale.data.conflicts?.[0]?.server);

  /* N3 — بدون base_version */
  const noBase = await req('/api/sync', { method: 'POST', token: mTok, body: { ops: [
    { uid: 'p-g4', collection: 'grades', type: 'put', id: gradeId, data: { score: 12 } },
  ] } });
  const noBaseApplied = (noBase.data.applied || []).length;
  const vAfterNoBase = noBase.data.applied?.[0]?.version ?? null;

  /* N4 — base_version = 0 (مسیر واقعی کلاینت برای رمز) */
  const zeroBase = await req('/api/sync', { method: 'POST', token: mTok, body: { ops: [
    { uid: 'p-g5', collection: 'grades', type: 'put', id: gradeId, base_version: 0, data: { score: 11 } },
  ] } });
  const zeroBaseApplied = (zeroBase.data.applied || []).length;

  const finalRow = await pullVia();
  const gradeRows = finalRow.data?.collections?.grades || finalRow.data?.data?.grades || [];
  const rowNow = gradeRows.find(x => Number(x.id) === Number(gradeId));

  /* N5/N6 — دورزدن مجوز از مسیر تعارض */
  const sLogin = await req('/api/auth/login', { method: 'POST', body: { phone: '09121110014', password: '1000000014' } });
  const sTok = sLogin.data?.session?.token || null;

  let bypassConflicts = null, bypassServerSeen = null, withCorrectBase = null;
  if (sTok) {
    const bypass = await req('/api/sync', { method: 'POST', token: sTok, body: { ops: [
      { uid: 'p-g6', collection: 'grades', type: 'put', id: gradeId, base_version: 1, data: { score: 5 } },
    ] } });
    bypassConflicts = (bypass.data.conflicts || []).length;
    const srv = bypass.data.conflicts?.[0]?.server || null;
    bypassServerSeen = srv ? Object.keys(srv).sort().join(',') : null;

    const lastVer = rowNow?._version ?? null;
    const ok = await req('/api/sync', { method: 'POST', token: sTok, body: { ops: [
      { uid: 'p-g7', collection: 'grades', type: 'put', id: gradeId, base_version: lastVer, data: { score: 5 } },
    ] } });
    withCorrectBase = { applied: (ok.data.applied || []).length, rejected: (ok.data.rejected || []).map(r => r.error) };
  }

  /* N2 — پایگاه: آیا جدول/ردیف تعارض وجود دارد؟ */
  let conflictTable = null;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(TMP, 'payesh.sqlite'));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    conflictTable = tables.filter(t => /confl/i.test(t));
    const auditFor = db.prepare("SELECT COUNT(*) AS n FROM audit WHERE collection='grades'").get();
    rec('N2a', 'جدول تعارض در پایگاه', { tables_total: tables.length, conflict_tables: conflictTable });
    rec('N2b', 'ردیف audit برای grades', { audit_rows: Number(auditFor.n) });
    db.close();
  } catch (e) {
    rec('N2a', 'جدول تعارض در پایگاه', { error: String(e.message).slice(0, 80) });
  }

  rec('N1', 'تعارض با base_version کهنه', {
    conflicts: conflictReturned, server_row_in_response: conflictHasServerRow,
    score_after_fresh_write: 19, version_after_fresh: v2,
  });
  rec('N3', 'op بدون base_version (LWW واقعی)', { applied: noBaseApplied, version_after: vAfterNoBase });
  rec('N4', 'op با base_version=0 (LWW واقعی)', { applied: zeroBaseApplied });
  rec('N5', 'نقش بدون حق نوشتن در مسیر تعارض', {
    student_token: !!sTok, conflicts: bypassConflicts,
    fields_returned_in_server_object: bypassServerSeen,
  });
  rec('N6', 'همان نقش با base_version درست', withCorrectBase);
  rec('N0', 'وضعیت نهایی ردیف', { score: rowNow?.score ?? null, version: rowNow?._version ?? null });

  const sha = (() => { try { return execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); } catch { return 'unknown'; } })();

  console.log('PROBE-14-CONFLICT — رفتار اجرایی کد امروز');
  console.log('SHA=' + sha);
  console.log('TEMP_DB=isolated (not repository data/)');
  for (const r of results) console.log(`${r.id} | ${r.title} | ${JSON.stringify(r.data)}`);

  const expectations = {
    'N1': conflictReturned === 1 && conflictHasServerRow === true,
    'N2a': Array.isArray(conflictTable) && conflictTable.length === 0,
    'N3': noBaseApplied === 1,
    'N4': zeroBaseApplied === 1,
    'N5': bypassConflicts === 1 && !!bypassServerSeen,
    'N6': withCorrectBase && withCorrectBase.applied === 0 && withCorrectBase.rejected.length === 1,
  };
  const bad = Object.entries(expectations).filter(([, ok]) => !ok).map(([k]) => k);
  console.log('EXPECTATIONS=' + (bad.length ? 'MISMATCH:' + bad.join(',') : 'ALL-MET'));
  console.log('EXIT=' + (bad.length ? 1 : 0));
  cleanup(bad.length ? 1 : 0);
} catch (e) {
  console.error('PROBE-FAILED: ' + String(e.message || e).slice(0, 300));
  cleanup(2);
}
