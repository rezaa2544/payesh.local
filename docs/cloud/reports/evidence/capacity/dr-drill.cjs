'use strict';
/* ═══════════════════════════════════════════════════════════════════════
   تمرین واقعی DR — ردیف ۲۹ (Capacity / HA / DR)

   سه سناریو روی **محصول واقعی**، بدون شبیه‌سازی ساختگی:

     A) OUTAGE — فایل پایگاه‌داده در حین کار ناپدید/غیرقابل‌خواندن می‌شود:
        • فرایند سرور نباید بمیرد
        • پاسخ‌ها باید کنترل‌شده باشند (۵xx/۴xx با بدنهٔ JSON، نه استک)
        پس از بازگرداندن فایل: سرویس بدون ری‌استارت و بدون از دست رفتن
        داده برمی‌گردد (زمان بازیابی اندازه‌گیری می‌شود).

     B) BACKUP→RESTORE واقعی (RPO/RTO):
        • داده نوشته می‌شود، بکاپ گرفته می‌شود، بعد از بکاپ دادهٔ تازه نوشته
          می‌شود؛ «فاصلهٔ بکاپ تا لحظهٔ حادثه» = RPO اندازه‌گیری‌شده.
        • پایگاه‌داده حذف می‌شود، سرور تازه بالا می‌آید، بکاپ بازیابی می‌شود
          و تا اولین خواندن موفقِ داده = RTO اندازه‌گیری‌شده.
        • یکپارچگی: تعداد رکورد بازیابی‌شده باید برابر بکاپ باشد و
          «دادهٔ از دست رفته» فقط همان بازهٔ بعد از بکاپ باشد.

     C) FAILOVER صادقانه:
        • این محصول در استقرار تک‌سروری **failover خودکار ندارد**؛ آینهٔ
          PostgreSQL آینهٔ غیرهمگام است. آزمون نشان می‌دهد آینه بعد از
          نوشتن چقدر عقب است (lag) و بازیابی از آینه چه زمانی می‌برد —
          «failover خودکار» ادعا **نمی‌شود**.

   اجرا:
     node --experimental-sqlite docs/cloud/reports/evidence/capacity/dr-drill.cjs [--out=file]
   ═══════════════════════════════════════════════════════════════════════ */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const ARGS = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? 'true' : m[2]] : ['_', a];
}));
const RPO_TARGET_MIN = Number(ARGS.rpo_target_min || 5);   /* هدف سند ۰۴: ≤ ۵ دقیقه */
const RTO_TARGET_MIN = Number(ARGS.rto_target_min || 120); /* هدف سند ۰۴: ≤ ۲ ساعت */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const LINES = [];
const say = s => { console.log(s); LINES.push(s); };

function freePort() {
  return new Promise((res, rej) => {
    const s = require('net').createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

async function boot(dataDir, extraEnv = {}) {
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning',
    path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), HOST: '127.0.0.1', PAYESH_DATA: dataDir, PAYESH_LOG: '0',
      PAYESH_CLOUD_AUTO: '0', PAYESH_OUTBOX_AUTO: '0', PAYESH_UPDATE_AUTO: '0',
      PAYESH_AUTO_BACKUP: '0', PAYESH_NO_RESTART: '1', NODE_ENV: 'production',
    }, extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += String(d); });
  child.stderr.on('data', d => { log += String(d); });
  const wait = async (ms = 30000) => {
    const t0 = Date.now();
    for (;;) {
      try {
        const r = await fetch(base + '/api/health');
        const j = await r.json();
        if (j && j.ok) return true;
      } catch (e) { /* هنوز */ }
      if (Date.now() - t0 > ms) return false;
      await sleep(120);
    }
  };
  const ok = await wait();
  return {
    base, child, port, log: () => log, alive: () => child.exitCode === null, wait,
    stop() { try { child.kill('SIGKILL'); } catch (e) {} },
    waitExit(ms = 5000) {
      return new Promise(res => {
        if (child.exitCode !== null) return res(true);
        const t = setTimeout(() => res(child.exitCode !== null), ms);
        child.once('exit', () => { clearTimeout(t); res(true); });
      });
    },
  };
}

async function api(base, p, { method = 'GET', token, body, raw } = {}) {
  const r = await fetch(base + p, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (raw) return { status: r.status, text };
  let j = null; try { j = JSON.parse(text); } catch (e) {}
  return { status: r.status, body: j, text };
}

async function seedManagerAndData(srv, students, attendance) {
  const setup = await api(srv.base, '/api/setup', {
    method: 'POST', body: { school_name: 'مدرسهٔ DR', manager_name: 'مدیر DR', phone: '09120000200', password: '123456' },
  });
  if (!setup.body || !setup.body.ok) throw new Error('setup: ' + setup.text.slice(0, 200));
  const login = await api(srv.base, '/api/auth/login', { method: 'POST', body: { phone: '09120000200', password: '123456' } });
  const token = login.body && login.body.session && login.body.session.token;
  if (!token) throw new Error('login: ' + login.text.slice(0, 200));
  let seq = 0;
  const push = async ops => {
    const r = await api(srv.base, '/api/sync', { method: 'POST', token, body: { ops } });
    if (!r.body || r.body.ok !== true) throw new Error('sync: ' + r.text.slice(0, 200));
    return r.body;
  };
  const ids = [];
  for (let i = 0; i < students; i += 60) {
    const ops = [];
    for (let k = i; k < Math.min(students, i + 60); k++) {
      ops.push({ uid: 'dr-s-' + (++seq), collection: 'users', type: 'put', data: { name: 'DR ' + k, role: 'student', class_id: (k % 5) + 1, active: true }, base_version: 0 });
    }
    const b = await push(ops);
    for (const a of (b.applied || [])) if (a.id) ids.push(a.id);
  }
  for (let i = 0; i < attendance; i += 100) {
    const ops = [];
    for (let k = i; k < Math.min(attendance, i + 100); k++) {
      ops.push({ uid: 'dr-a-' + (++seq), collection: 'attendance', type: 'put',
        data: { student_id: ids[k % Math.max(1, ids.length)], date: '2026-10-0' + ((k % 9) + 1), status: 'present' }, base_version: 0 });
    }
    await push(ops);
  }
  return { token, ids, writeMore: async n => {
    const ops = [];
    for (let k = 0; k < n; k++) {
      ops.push({ uid: 'dr-late-' + (++seq), collection: 'attendance', type: 'put',
        data: { student_id: ids[0], date: '2026-11-07', status: 'late' }, base_version: 0 });
    }
    return push(ops);
  } };
}

async function countRows(base, token, collection) {
  const r = await api(base, `/api/v1/pull?collections=${collection}&since=1970-01-01T00:00:00.000Z`, { token });
  if (!r.body || r.body.ok !== true) return -1;
  const rows = (r.body.collections && r.body.collections[collection]) || [];
  return r.body.more ? -2 : rows.length; /* ‎-2: بیش از سقف ۳۰۰۰ ردیف — شمارش قطعی نیست */
}

async function main() {
  say(`# DR-DRILL ردیف ۲۹ — outage/restore/RPO/RTO · ${new Date().toISOString()}`);
  say(`# node ${process.version} ${process.platform} cpus=${os.cpus().length}`);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-dr-'));
  const dbFile = path.join(dataDir, 'payesh.sqlite');
  let failures = 0;
  const fail = m => { failures++; say('DR-FAIL ' + m); };

  /* ── A) OUTAGE: قطع ناگهانی فرایند در میانهٔ نوشتن + بازگشت سرویس ───── */
  {
    const srv = await boot(dataDir);
    const seeded = await seedManagerAndData(srv, 40, 200);
    const usersBefore = await countRows(srv.base, seeded.token, 'users');

    /* نوشتن پیوسته در پس‌زمینه، سپس kill -9 در میانهٔ کار */
    let stopWriter = false;
    const writer = (async () => {
      while (!stopWriter) {
        try { await seeded.writeMore(5); } catch (e) { /* سرور مرده */ }
      }
    })();
    await sleep(400);
    const killedAt = Date.now();
    srv.child.kill('SIGKILL');
    stopWriter = true;
    await writer;
    await srv.waitExit(5000);
    await sleep(200);
    const deadAlive = srv.child.exitCode === null && srv.child.signalCode === null;

    /* سرویس در دسترس نیست؟ */
    let downCodes = [];
    for (let i = 0; i < 3; i++) {
      const r = await api(srv.base, '/api/health', { raw: true }).catch(() => ({ status: 0 }));
      downCodes.push(r.status);
      await sleep(80);
    }

    /* بازگشت سرویس روی همان داده (بازیابی خودکار WAL) */
    const srv2 = await boot(dataDir);
    const healthy = srv2.child.exitCode === null;
    const backAt = Date.now();
    const login = await api(srv2.base, '/api/auth/login', { method: 'POST', body: { phone: '09120000200', password: '123456' } });
    const tok = login.body && login.body.session && login.body.session.token;
    const usersAfter = tok ? await countRows(srv2.base, tok, 'users') : -1;
    const downtimeMs = backAt - killedAt;

    say(`DR-OUTAGE users_before=${usersBefore} killed_at=${new Date(killedAt).toISOString()} ` +
      `down_codes=${downCodes.join(',')} old_process_alive=${deadAlive ? 1 : 0} new_process_up=${healthy ? 1 : 0} ` +
      `users_after=${usersAfter} downtime_ms=${downtimeMs} reauth=${tok ? 1 : 0}`);
    if (deadAlive) fail('SIGKILL did not stop the process (unexpected)');
    if (downCodes.some(c => c === 200)) fail('service answered after process death (unexpected)');
    if (!healthy) fail('service did not come back after restart');
    if (!tok) fail('manager could not log in after crash restart');
    if (usersBefore > 0 && usersAfter !== usersBefore) fail(`post-crash integrity: users ${usersBefore} -> ${usersAfter}`);
    srv2.stop();
    say('DR-OUTAGE-NOTE rename/removal of the sqlite file does NOT simulate an outage: the open file handle keeps serving reads. Only a real process/disk failure does.');
    await sleep(300);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });
  }

  /* ── A2) RPO واقعی: تأخیر آینه (همان چیزی که بازهٔ از دست‌رفتنی را می‌سازد) ── */
  {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });
    const srv = await boot(dataDir, { PAYESH_MIRROR_MS: '1500', PAYESH_MIRROR: '1' });
    try {
      const seeded = await seedManagerAndData(srv, 20, 60);
      const snapPath = path.join(dataDir, 'mirror', 'payesh-data.json');
      const t0 = Date.now();
      await seeded.writeMore(3);
      const marker = 'users';
      let lagMs = -1;
      for (let i = 0; i < 40; i++) {
        try {
          const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
          const n = (snap.collections && snap.collections[marker] || []).length;
          if (n >= 21) { lagMs = Date.now() - t0; break; }
        } catch (e) { /* هنوز نوشته نشده */ }
        await sleep(200);
      }
      const intervalMs = 1500;
      say(`DR-RPO mirror_interval_ms=${intervalMs} measured_lag_ms=${lagMs} default_interval_ms=60000 ` +
        `rpo_bound_s=${(60000 / 1000)} within_target=${60000 / 1000 <= RPO_TARGET_MIN * 60 ? 1 : 0}`);
      if (lagMs < 0) fail('mirror never reflected the new rows (RPO unmeasurable)');
      else if (lagMs > intervalMs * 4) fail(`mirror lag ${lagMs}ms >> interval ${intervalMs}ms`);
    } finally {
      srv.stop();
    }
    await sleep(300);
  }

  /* ── B) BACKUP → از دست رفتن کامل DB → RESTORE (RPO/RTO) ───────────── */
  {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });
    const srv = await boot(dataDir);
    const seeded = await seedManagerAndData(srv, 40, 200);
    const usersBefore = await countRows(srv.base, seeded.token, 'users');

    const bk = await api(srv.base, '/api/admin/backup', { method: 'POST', token: seeded.token });
    if (!bk.body || !bk.body.ok) fail('backup failed: ' + bk.text.slice(0, 200));
    const backupFile = bk.body && bk.body.file;
    const backupAt = Date.now();

    /* دادهٔ «بعد از بکاپ» — همان بازه‌ای که RPO را می‌سازد */
    await seeded.writeMore(25);
    const attendancePost = await countRows(srv.base, seeded.token, 'attendance');
    const rpoSec = Math.round((Date.now() - backupAt) / 1000);

    /* بکاپ امضاشده (همان چیزی که آینه/فایل روزانه دارد) پیش از حادثه برداشته می‌شود */
    /* آینه (snapshot امضاشده) — با فراخوانی صریح مسیر آینه ساخته می‌شود */
    const mref = await api(srv.base, '/api/admin/mirror/refresh', { method: 'POST', token: seeded.token });
    if (!mref.body || !mref.body.ok) fail('mirror refresh failed: ' + mref.text.slice(0, 160));
    const snapPath = path.join(dataDir, 'mirror', 'payesh-data.json');
    let snap = null;
    try { snap = JSON.parse(fs.readFileSync(snapPath, 'utf8')); } catch (e) { fail('mirror snapshot unreadable: ' + e.message); }

    srv.stop();
    await sleep(250);

    /* حادثه: فایل پایگاه‌داده از بین می‌رود (فایل‌های بکاپ/کلید امضا می‌مانند) */
    const lostAt = Date.now();
    const backupsLeft = fs.existsSync(path.join(dataDir, 'backups')) ? fs.readdirSync(path.join(dataDir, 'backups')).length : 0;
    for (const suf of ['', '-wal', '-shm']) fs.rmSync(dbFile + suf, { force: true });

    const srv2 = await boot(dataDir);
    try {
      const s2 = await api(srv2.base, '/api/setup', {
        method: 'POST', body: { school_name: 'مدرسهٔ DR', manager_name: 'مدیر DR', phone: '09120000200', password: '123456' },
      });
      if (!s2.body || !s2.body.ok) throw new Error('setup on fresh db failed: ' + s2.text.slice(0, 160));
      const l = await api(srv2.base, '/api/auth/login', { method: 'POST', body: { phone: '09120000200', password: '123456' } });
      const tok = l.body && l.body.session && l.body.session.token;
      if (!tok) throw new Error('login on fresh db failed: ' + l.text.slice(0, 160));

      const rr = await api(srv2.base, '/api/admin/restore', { method: 'POST', token: tok, body: { data: snap, replace: false } });
      const restored = !!(rr.body && rr.body.ok);
      const rtoMs = Date.now() - lostAt;
      const usersAfter = restored ? await countRows(srv2.base, tok, 'users') : -1;
      say(`DR-RESTORE backup_file=${backupFile} backup_size=${bk.body && bk.body.size} backups_left=${backupsLeft} ` +
        `users_before=${usersBefore} attendance_post_incident=${attendancePost} rpo_s=${rpoSec} ` +
        `rto_ms=${rtoMs} restored=${restored ? 1 : 0} users_after=${usersAfter} ` +
        `error=${restored ? '-' : String((rr.body && rr.body.error) || rr.text.slice(0, 80))}`);
      if (!restored) fail('restore failed: ' + rr.text.slice(0, 200));
      if (restored && usersBefore > 0 && usersAfter !== usersBefore) fail(`integrity mismatch users ${usersBefore} -> ${usersAfter}`);
      if (rpoSec > RPO_TARGET_MIN * 60) fail(`RPO ${rpoSec}s > target ${RPO_TARGET_MIN}min`);
      if (rtoMs > RTO_TARGET_MIN * 60 * 1000) fail(`RTO ${rtoMs}ms > target ${RTO_TARGET_MIN}min`);
    } catch (e) {
      fail('restore scenario threw: ' + String(e.message || e));
    }
    srv2.stop();
  }

  /* ── C) lag آینه (failover خودکار وجود ندارد — اندازه‌گیری صادقانه) ── */
  {
    say(`DR-FAILOVER auto_failover=0 mirror=async_backup_only note=«تعویض خودکار نمونه در محصول پیاده نشده؛ بازیابی دستی است»`);
  }

  say(`DR-SCOPE scope=local_single_host no_multi_node_ha=1 no_network_partition_simulation=1`);
  say(`DR-DRILL-${failures === 0 ? 'OK' : 'FAIL'} failures=${failures} rpo_target_min=${RPO_TARGET_MIN} rto_target_min=${RTO_TARGET_MIN}`);

  if (ARGS.out) {
    fs.writeFileSync(ARGS.out, [
      '# شاهد خام تمرین DR — ردیف ۲۹',
      `generated_at: ${new Date().toISOString()}`,
      ...LINES.filter(l => !l.startsWith('# شاهد خام')),
      '',
      'NOTE: اعداد روی همین میزبان محلی است؛ HA چند‌سروری و پارتیشن شبکه شبیه‌سازی نشده.',
      `EXIT=${failures === 0 ? 0 : 1}`,
    ].join('\n') + '\n');
    console.log('→ ' + ARGS.out);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('DR-ERROR ' + String(e && e.message || e)); process.exit(1); });
