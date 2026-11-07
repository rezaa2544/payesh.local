'use strict';
/* ═══════════════════════════════════════════════════════════════════════
   سنجش بار واقعی «خواندن/نوشتن هم‌زمان» — ردیف ۲۹ (Capacity / HA / DR)

   چه می‌کند:
     یک نمونهٔ **واقعی** از محصول (server/index.js بدون هیچ تغییر) روی پورت
     آزاد و پوشهٔ دادهٔ موقت بالا می‌آورد، مدیر را می‌سازد، دادهٔ واقعی
     (دانش‌آموز + حضور) می‌نویسد، و سپس K کارگر هم‌زمان ترکیبی از
       • خواندن  → GET /api/v1/pull
       • نوشتن   → POST /api/sync (op واقعی)
     می‌فرستد و p50/p95/p99 جدا برای خواندن و نوشتن، نرخ خطا، CPU، RSS و
     «سقف ظرفیت این میزبان» را اندازه می‌گیرد.

   چه چیزی را **اثبات نمی‌کند** (صریح):
     • مقیاس تولیدی چندسروری، شبکهٔ واقعی، یا SLA.
     • هزینهٔ ابر واقعی: عدد هزینه فقط از منابع **اندازه‌گیری‌شدهٔ همین
       میزبان** با یک فرض قیمت اعلام‌شده محاسبه می‌شود (ASSUMPTION).

   اجرا:
     node --experimental-sqlite docs/cloud/reports/evidence/capacity/mixed-load.cjs
     node … --concurrency=1,8,32 --seconds=6 --out=<file>
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

const LEVELS = String(ARGS.concurrency || '1,8,32').split(',').map(Number).filter(n => n > 0);
const SECONDS = Number(ARGS.seconds || 6);
const READ_SHARE = Math.min(0.95, Math.max(0.05, Number(ARGS.read_share || 0.7)));
const SEED_STUDENTS = Number(ARGS.seed_students || 240);
const SEED_ATTENDANCE = Number(ARGS.seed_attendance || 1800);
const P95_READ_MAX = Number(ARGS.p95_read_max || 300);   /* هدف C‑1 سند ۰۴ */
const P95_WRITE_MAX = Number(ARGS.p95_write_max || 800); /* هدف C‑2 سند ۰۴ */
const ERR_RATE_MAX = Number(ARGS.err_rate_max || 1);     /* درصد */
/* فرض قیمت — **فرض** است، نه تعهد؛ فقط برای تبدیل منابع اندازه‌گیری‌شده به هزینه */
const EUR_PER_VCPU_HOUR = Number(ARGS.eur_vcpu_hour || 0.026);
const EUR_PER_GB_HOUR = Number(ARGS.eur_gb_hour || 0.0044);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const s = require('net').createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}
function cpuMs(pid) {
  try {
    const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop().split(' ');
    return (Number(st[11]) + Number(st[12])) * 10;
  } catch (e) { return null; }
}
function rssMb(pid) {
  try {
    const m = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? +(Number(m[1]) / 1024).toFixed(1) : null;
  } catch (e) { return null; }
}

async function boot() {
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-load-'));
  const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning',
    path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), HOST: '127.0.0.1', PAYESH_DATA: data, PAYESH_LOG: '0',
      PAYESH_CLOUD_AUTO: '0', PAYESH_OUTBOX_AUTO: '0', PAYESH_UPDATE_AUTO: '0',
      PAYESH_AUTO_BACKUP: '0', PAYESH_NO_RESTART: '1', NODE_ENV: 'production',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += String(d); });
  child.stderr.on('data', d => { log += String(d); });
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(base + '/api/health');
      const j = await r.json();
      if (j && j.ok) break;
    } catch (e) { /* بالا نیامده */ }
    if (Date.now() - t0 > 30000) throw new Error('server did not start: ' + log.slice(-500));
    await sleep(120);
  }
  return {
    base, child, data, port,
    stop() { try { child.kill('SIGKILL'); } catch (e) {} try { fs.rmSync(data, { recursive: true, force: true }); } catch (e) {} },
  };
}

async function api(base, p, { method = 'GET', token, body } = {}) {
  const r = await fetch(base + p, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) { j = null; }
  return { status: r.status, body: j, text };
}

async function seed(srv) {
  const setup = await api(srv.base, '/api/setup', {
    method: 'POST',
    body: { school_name: 'مدرسهٔ بار', manager_name: 'مدیر بار', phone: '09120000100', password: '123456' },
  });
  if (!setup.body || !setup.body.ok) throw new Error('setup failed: ' + setup.text.slice(0, 200));
  const login = await api(srv.base, '/api/auth/login', {
    method: 'POST', body: { phone: '09120000100', password: '123456' },
  });
  const token = login.body && login.body.session && login.body.session.token;
  if (!token) throw new Error('login failed: ' + login.text.slice(0, 200));

  let seq = 0;
  const push = async ops => {
    const r = await api(srv.base, '/api/sync', { method: 'POST', token, body: { ops } });
    if (!r.body || r.body.ok !== true) throw new Error('seed op failed: ' + r.text.slice(0, 200));
    return r;
  };

  /* دانش‌آموز */
  const studentIds = [];
  for (let i = 0; i < SEED_STUDENTS; i += 80) {
    const ops = [];
    for (let k = i; k < Math.min(SEED_STUDENTS, i + 80); k++) {
      ops.push({
        uid: 'seed-s-' + (++seq), collection: 'users', type: 'put',
        data: { name: 'دانش‌آموز ' + k, role: 'student', class_id: (k % 6) + 1, phone: '0935000' + String(1000 + k), active: true },
        base_version: 0,
      });
    }
    const r = await push(ops);
    for (const a of (r.body.applied || [])) if (a.id) studentIds.push(a.id);
  }
  /* حضور */
  for (let i = 0; i < SEED_ATTENDANCE; i += 100) {
    const ops = [];
    for (let k = i; k < Math.min(SEED_ATTENDANCE, i + 100); k++) {
      ops.push({
        uid: 'seed-a-' + (++seq), collection: 'attendance', type: 'put',
        data: { student_id: studentIds[k % Math.max(1, studentIds.length)], date: '2026-10-' + String((k % 28) + 1).padStart(2, '0'), status: k % 7 === 0 ? 'absent' : 'present' },
        base_version: 0,
      });
    }
    await push(ops);
  }
  return { token, students: studentIds.length, attendance: SEED_ATTENDANCE, seq };
}

async function round(srv, token, level) {
  const readLat = [];
  const writeLat = [];
  let readErr = 0, writeErr = 0;
  let readN = 0, writeN = 0;
  const pid = srv.child.pid;
  const cpu0 = cpuMs(pid);
  const rss0 = rssMb(pid);
  let rssMax = rss0 || 0;
  const t0 = Date.now();
  const stopAt = t0 + SECONDS * 1000;

  const sampler = setInterval(() => { const v = rssMb(pid); if (v && v > rssMax) rssMax = v; }, 250);
  let seq = 0;

  async function worker(w) {
    while (Date.now() < stopAt) {
      const isRead = Math.random() < READ_SHARE;
      const s = Date.now();
      try {
        if (isRead) {
          const r = await api(srv.base, '/api/v1/pull?collections=attendance&since=1970-01-01T00:00:00.000Z', { token });
          readN++;
          if (!r.body || r.body.ok !== true) readErr++;
          readLat.push(Date.now() - s);
        } else {
          const r = await api(srv.base, '/api/sync', {
            method: 'POST', token,
            body: {
              ops: [{
                uid: `load-w-${level}-${w}-${++seq}-${Date.now()}`, collection: 'attendance', type: 'put',
                data: { student_id: 1, date: '2026-11-07', status: 'present', note: 'load' }, base_version: 0,
              }],
            },
          });
          writeN++;
          if (!r.body || r.body.ok !== true) writeErr++;
          writeLat.push(Date.now() - s);
        }
      } catch (e) {
        if (isRead) { readErr++; readN++; readLat.push(Date.now() - s); }
        else { writeErr++; writeN++; writeLat.push(Date.now() - s); }
      }
    }
  }
  await Promise.all(Array.from({ length: level }, (_, i) => worker(i)));
  clearInterval(sampler);
  const wall = (Date.now() - t0) / 1000;
  const cpu1 = cpuMs(pid);
  const rs = readLat.slice().sort((a, b) => a - b);
  const ws = writeLat.slice().sort((a, b) => a - b);
  const total = readN + writeN;
  const errs = readErr + writeErr;
  return {
    level,
    read: { n: readN, err: readErr, p50: pct(rs, 50), p95: pct(rs, 95), p99: pct(rs, 99), max: rs[rs.length - 1] || 0 },
    write: { n: writeN, err: writeErr, p50: pct(ws, 50), p95: pct(ws, 95), p99: pct(ws, 99), max: ws[ws.length - 1] || 0 },
    rps: +(total / wall).toFixed(1),
    err_rate: +(100 * errs / Math.max(1, total)).toFixed(2),
    cpu_pct: (cpu0 != null && cpu1 != null) ? +(((cpu1 - cpu0) / (wall * 1000)) * 100).toFixed(1) : null,
    rss_start_mb: rss0, rss_max_mb: rssMax || null,
    wall_s: +wall.toFixed(2),
  };
}

async function main() {
  const out = [];
  const started = new Date().toISOString();
  console.log(`# LOAD-MIXED ردیف ۲۹ — ترکیب خواندن ${(READ_SHARE * 100).toFixed(0)}٪ / نوشتن ${(100 - READ_SHARE * 100).toFixed(0)}٪`);
  console.log(`# host cpus=${os.cpus().length} mem_gb=${(os.totalmem() / 1e9).toFixed(1)} node=${process.version} platform=${process.platform}`);
  console.log(`# thresholds p95_read<=${P95_READ_MAX}ms p95_write<=${P95_WRITE_MAX}ms err_rate<=${ERR_RATE_MAX}%`);

  for (const level of LEVELS) {
    const srv = await boot();
    try {
      const seeded = await seed(srv);
      const r = await round(srv, seeded.token, level);
      r.seeded = { students: seeded.students, attendance: seeded.attendance };
      out.push(r);
      console.log(`LOAD level=${r.level} reqs=${r.read.n + r.write.n} read_n=${r.read.n} write_n=${r.write.n} ` +
        `read_p50=${r.read.p50} read_p95=${r.read.p95} read_p99=${r.read.p99} ` +
        `write_p50=${r.write.p50} write_p95=${r.write.p95} write_p99=${r.write.p99} ` +
        `rps=${r.rps} err_rate=${r.err_rate}% cpu_pct=${r.cpu_pct == null ? 'n/a' : r.cpu_pct} ` +
        `rss_max_mb=${r.rss_max_mb == null ? 'n/a' : r.rss_max_mb}`);
    } finally {
      srv.stop();
    }
    await sleep(300);
  }

  const good = out.filter(r => r.err_rate <= ERR_RATE_MAX && r.read.p95 <= P95_READ_MAX && r.write.p95 <= P95_WRITE_MAX);
  const maxOk = good.length ? Math.max(...good.map(r => r.level)) : 0;
  const firstBad = out.find(r => r.err_rate > ERR_RATE_MAX || r.read.p95 > P95_READ_MAX || r.write.p95 > P95_WRITE_MAX);

  /* سقف ظرفیت: هر کارگر ≈ یک دستگاه فعال؛ کاربر «هم‌زمان» = همان عدد */
  console.log(`LOAD-CAP max_ok_concurrency=${maxOk} first_fail=${firstBad ? firstBad.level : 'none'} ` +
    `p95_read_max=${P95_READ_MAX} p95_write_max=${P95_WRITE_MAX}`);

  /* هزینه: فقط از منابع اندازه‌گیری‌شده؛ فرض قیمت صریح */
  const best = out.find(r => r.level === maxOk) || out[out.length - 1];
  const vcpu = Math.max(1, Math.ceil(((best.cpu_pct || 100) / 100) * 1)); /* ۱ vCPU مبنا */
  const ramGb = Math.max(1, Math.ceil((best.rss_max_mb || 256) / 1024));
  const hourly = (vcpu * EUR_PER_VCPU_HOUR) + (ramGb * EUR_PER_GB_HOUR);
  console.log(`LOAD-COST vcpu=${vcpu} ram_gb=${ramGb} eur_hour=${hourly.toFixed(4)} ` +
    `eur_month_host=${(hourly * 730).toFixed(2)} eur_month_per_100_closed_loop_workers=${((hourly * 730 * 100) / Math.max(1, maxOk)).toFixed(2)} ` +
    `max_closed_loop_workers=${maxOk}`);
  console.log(`LOAD-ASSUMPTION price_basis=eur_per_vcpu_hour:${EUR_PER_VCPU_HOUR},eur_per_gb_hour:${EUR_PER_GB_HOUR} ` +
    `scope=local_single_host no_sla_claim=1 no_network_simulation=1`);
  console.log(`LOAD-MIXED-OK levels=${out.length} max_ok=${maxOk} at=${new Date().toISOString()}`);

  if (ARGS.out) {
    const lines = [
      '# شاهد خام سنجش بار ترکیبی — ردیف ۲۹ (Capacity/HA/DR)',
      `generated_at: ${started}`,
      `host: cpus=${os.cpus().length} mem_gb=${(os.totalmem() / 1e9).toFixed(1)} node=${process.version} ${process.platform}`,
      `mix: read_share=${READ_SHARE} write_share=${(1 - READ_SHARE).toFixed(2)} seconds=${SECONDS}`,
      `thresholds: p95_read<=${P95_READ_MAX}ms p95_write<=${P95_WRITE_MAX}ms err_rate<=${ERR_RATE_MAX}%`,
      '',
      'مفهوم max_ok_concurrency: تعداد «کارگر بسته» با صفر زمان فکر (بدترین حالت). هر کارگر در حلقهٔ بی‌وقفه',
      'درخواست می‌فرستد؛ این با «دستگاه واقعی که هر ۱ ثانیه poll می‌کند» یکی نیست (برای آن: بنچ poll).',
      '',
      'level  read_n  write_n  read_p50  read_p95  read_p99  write_p50  write_p95  write_p99  rps   err%  cpu%  rss_max_mb',
      ...out.map(r => `LOAD level=${r.level} reqs=${r.read.n + r.write.n} read_n=${r.read.n} write_n=${r.write.n} ` +
        `read_p50=${r.read.p50} read_p95=${r.read.p95} read_p99=${r.read.p99} ` +
        `write_p50=${r.write.p50} write_p95=${r.write.p95} write_p99=${r.write.p99} ` +
        `rps=${r.rps} err_rate=${r.err_rate}% cpu_pct=${r.cpu_pct == null ? 'n/a' : r.cpu_pct} ` +
        `rss_max_mb=${r.rss_max_mb == null ? 'n/a' : r.rss_max_mb}`),
      '',
      `LOAD-CAP max_ok_concurrency=${maxOk} first_fail=${firstBad ? firstBad.level : 'none'}`,
      `LOAD-COST vcpu=${vcpu} ram_gb=${ramGb} eur_month_host=${(hourly * 730).toFixed(2)} eur_month_per_100_closed_loop_workers=${((hourly * 730 * 100) / Math.max(1, maxOk)).toFixed(2)} max_closed_loop_workers=${maxOk}`,
      `LOAD-ASSUMPTION price_basis=eur_per_vcpu_hour:${EUR_PER_VCPU_HOUR},eur_per_gb_hour:${EUR_PER_GB_HOUR} scope=local_single_host no_sla_claim=1 no_network_simulation=1`,
      '',
      'NOTE: این اعداد ظرفیت «همین میزبان محلی» است؛ هیچ ادعای مقیاس تولیدی یا SLA نیست.',
      `EXIT=${maxOk > 0 ? 0 : 1}`,
    ];
    fs.writeFileSync(ARGS.out, lines.join('\n') + '\n');
    console.log('→ ' + ARGS.out);
  }

  process.exit(maxOk > 0 ? 0 : 1);
}

main().catch(e => { console.error('LOAD-ERROR ' + String(e && e.message || e)); process.exit(1); });
