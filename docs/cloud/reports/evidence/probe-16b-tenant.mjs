#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   پروب مأموریت ۱۶‑ب — شاهد اجرایی «چندمستأجری/کلید/چرخهٔ عمر» در کد امروز
   (بدون تغییر کد محصول؛ دیتابیس و فایل‌ها در mktemp)

   چه چیزی را ثابت می‌کند:
     T1  طرح پایگاه ستون tenant_id ندارد؛ حتی school_id ستون نیست (فقط فیلد JSON)
     T2  فقط یک مدرسه ممکن است (setup دوم رد می‌شود) — چندمستأجری در API نیست
     T3  چیدمان ذخیره‌سازی پیشوند `t/<tenant>/` ندارد (mirror/backups/daily سراسری)
     T4  بکاپ رمزنگاری‌شده/کلید per-tenant وجود ندارد (SQLite خام)
     T5  جدول اشتراک/پلن/چرخهٔ عمر وجود ندارد ⇒ انتقال‌های ممنوع قابل‌اجرا نیست
 
     T6  school_id ارسالی کلاینت حفظ می‌شود (نبود برچسب اجباری سمت سرور)
     T7  ابتدایی‌ترین idempotency (uid) کار می‌کند: تکرار op ⇒ یک ردیف، پاسخ تکراری

   اجرا:  node --experimental-sqlite --disable-warning=ExperimentalWarning \
            docs/cloud/reports/evidence/probe-16b-tenant.mjs
   ═══════════════════════════════════════════════════════════════════ */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-m16b-'));

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
    school_name: 'دبیرستان پروب ۱۶ب', manager_name: 'مدیر پروب', password: 'Probe-16b-Aa', phone: '09120000026',
  } });
  if (!setup.data?.ok) throw new Error('setup failed: ' + JSON.stringify(setup.data));
  const mTok = setup.data.session.token;

  /* T1 — طرح پایگاه */
  let cols = {}, tables = [];
  {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(TMP, 'payesh.sqlite'));
    tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name).sort();
    for (const t of ['records', 'sessions', 'audit']) {
      cols[t] = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    }
    db.close();
  }
  rec('T1', 'طرح پایگاه', {
    tables,
    records_columns: cols.records,
    has_tenant_column_anywhere: Object.values(cols).some(list => list.includes('tenant_id')),
    has_school_column: Object.values(cols).some(list => list.includes('school_id')),
    tenancy_tables: tables.filter(t => /tenant|subscription|plan/i.test(t)),
  });

  /* T2 — setup دوم */
  const second = await req('/api/setup', { method: 'POST', body: {
    school_name: 'مدرسهٔ دوم پروب', manager_name: 'مدیر دوم', password: 'Probe-16b-Bb', phone: '09120000027',
  } });
  rec('T2', 'راه‌اندازی مدرسهٔ دوم', {
    status: second.status, ok: !!second.data?.ok, error: second.data?.error || null,
  });

  /* T5 — جدول اشتراک/پلن */
  rec('T5', 'چرخهٔ عمر در پایگاه', {
    subscription_tables: tables.filter(t => /subscription|plan|tenant/i.test(t)),
  });

  /* T4 — بکاپ و کلید */
  const bak = await req('/api/admin/backup', { method: 'POST', token: mTok });
  const list = await req('/api/admin/backups', { token: mTok });
  const newest = (list.data?.files || [])[0] || null;
  let plaintext = false, hasEncFile = false;
  if (newest) {
    const buf = fs.readFileSync(path.join(TMP, 'backups', newest));
    plaintext = buf.subarray(0, 15).toString('latin1') === 'SQLite format 3';
    hasEncFile = (list.data?.files || []).some(f => /\.enc$/.test(f));
  }
  rec('T4', 'بکاپ/کلید', {
    backup_ok: !!bak.data?.ok, plaintext_sqlite: plaintext, enc_files: hasEncFile,
  });

  /* T3 — چیدمان ذخیره‌سازی (پس از ساخت بکاپ) */
  const dirs = fs.readdirSync(TMP, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  const hasTenantPrefixDir = fs.existsSync(path.join(TMP, 't'));
  rec('T3', 'چیدمان ذخیره‌سازی', { data_dirs: dirs, has_t_prefix: hasTenantPrefixDir });

  /* T6 — school_id ارسالی کلاینت */
  const injected = await req('/api/sync', { method: 'POST', token: mTok, body: { ops: [
    { uid: 'tb-u1', collection: 'users', type: 'put', data: {
      name: 'دانش‌آموز مرزی', role: 'student', phone: '09121110026', national_id: '1000000026', school_id: 999,
    } },
  ] } });
  const newId = injected.data?.applied?.[0]?.id ?? null;
  let storedSchoolId = null;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(TMP, 'payesh.sqlite'));
    const r = db.prepare("SELECT data FROM records WHERE collection='users' AND id=?").get(newId);
    if (r) storedSchoolId = JSON.parse(r.data).school_id ?? null;
    db.close();
  } catch (e) { /* noop */ }
  rec('T6', 'school_id ارسالی کلاینت', {
    applied: (injected.data?.applied || []).length,
    school_id_stored: storedSchoolId,
    client_value_preserved: storedSchoolId === 999,
  });

  /* T7 — idempotency uid */
  const ops = { ops: [{ uid: 'tb-idem-1', collection: 'classes', type: 'put', data: { name: 'کلاس تکرار', grade: 'دهم' } }] };
  const first = await req('/api/sync', { method: 'POST', token: mTok, body: ops });
  const again = await req('/api/sync', { method: 'POST', token: mTok, body: ops });
  const firstId = first.data?.applied?.[0]?.id ?? null;
  const duplicateFlag = again.data?.applied?.[0]?.duplicate === true;
  let rowsWithName = -1;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(TMP, 'payesh.sqlite'));
    rowsWithName = Number(db.prepare("SELECT COUNT(*) AS n FROM records WHERE collection='classes' AND data LIKE '%کلاس تکرار%' AND deleted_at IS NULL").get().n);
    db.close();
  } catch (e) { /* noop */ }
  rec('T7', 'idempotency با uid', {
    first_applied: (first.data?.applied || []).length, first_id: firstId,
    second_applied: (again.data?.applied || []).length, second_duplicate_flag: duplicateFlag,
    rows_with_name: rowsWithName,
  });

  const sha = (() => { try { return execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); } catch { return 'unknown'; } })();

  console.log('PROBE-16B-TENANT — رفتار اجرایی کد امروز');
  console.log('SHA=' + sha);
  console.log('TEMP_DB=isolated (not repository data/)');
  for (const r of results) console.log(`${r.id} | ${r.title} | ${JSON.stringify(r.data)}`);

  const by = id => results.find(r => r.id === id)?.data || {};
  const expectations = {
    'T1': by('T1').has_tenant_column_anywhere === false && by('T1').has_school_column === false && by('T1').tenancy_tables.length === 0,
    'T2': by('T2').ok === false && second.status >= 400,
    'T3': by('T3').has_t_prefix === false,
    'T4': by('T4').plaintext_sqlite === true && by('T4').enc_files === false,
    'T5': by('T5').subscription_tables.length === 0,
    'T6': by('T6').client_value_preserved === false && by('T6').school_id_stored === 1,
    'T7': by('T7').second_duplicate_flag === true && by('T7').rows_with_name === 1,
  };
  const bad = Object.entries(expectations).filter(([, ok]) => !ok).map(([k]) => k);
  console.log('EXPECTATIONS=' + (bad.length ? 'MISMATCH:' + bad.join(',') : 'ALL-MET'));
} catch (e) {
  console.log('PROBE FAILED: ' + (e && e.message));
  cleanup(1);
}
cleanup(0);
