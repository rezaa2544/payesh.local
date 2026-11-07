'use strict';
/* ═══════════════════════════════════════════════════════════════════════
   سنجش واقعی گلوگاه poll — ردیف ۰۴ (AC‑۱۰) و شرط CC‑12‑3 ردیف ۱۲

   چه کاری می‌کند:
     یک نمونهٔ **واقعی** از محصول (server/index.js، بدون هیچ تغییر کد) روی
     پورت آزاد و پوشهٔ دادهٔ موقت بالا می‌آورد، مدیر را می‌سازد، و سپس
     K «دستگاه» مجازی را با الگوی طراحی‌شده (poll هر ۱ ثانیه) به
     `/api/v1/pull` می‌فرستد و تأخیر/خطا/CPU را اندازه می‌گیرد.

   چه چیزی را اثبات می‌کند:
     • ادعای ۰۴ «RPS_poll = دستگاه‌های آنلاین ÷ ۱s و poll غالب است»
       به‌جای فرض، **اندازه‌گیری محلی** می‌شود.
     • شرط CC‑12‑3 (محیط آزمون بار، تصمیم مالک O‑07 = «محلی موقت»)
       با یک خط پایهٔ محلی پر می‌شود — **بدون هیچ ادعای مقیاس تولیدی**.
     • آستانهٔ شکست صریح است: p95 ≥ ۱۰۰۰ms یعنی poll بعدی روی poll قبلی
       می‌افتد؛ همان لحظه «ظرفیت این میزبان» تمام است.

   اجرا:
     node docs/cloud/reports/evidence/bench-poll-load.cjs
     node … --devices=1,8,32,96 --seconds=8
   خروجی ماشین‌خوان:
     BENCH devices=8 reqs=64 ok=64 errors=0 p50_ms=… p95_ms=… p99_ms=… rps=… cpu_pct=…
     BENCH-CAP max_ok_devices=… threshold_ms=1000
   ═══════════════════════════════════════════════════════════════════════ */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ARGS = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
}));
const DEVICES = String(ARGS.devices || '1,8,32,96').split(',').map(Number).filter(n => n > 0);
const SECONDS = Number(ARGS.seconds || 6);
const THRESHOLD_MS = Number(ARGS.threshold_ms || 1000);
const POLL_MS = Number(ARGS.poll_ms || 1000);

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

/* CPU فرزند از /proc — برای این‌که «تأخیر» فقط نتیجهٔ ازدحام شبکه نباشد */
function childCpuMs(pid) {
  try {
    const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop().split(' ');
    const utime = Number(st[11]), stime = Number(st[12]);
    return (utime + stime) * 10; /* ticks → ms (USER_HZ=100) */
  } catch (e) { return null; }
}

async function startServer() {
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-bench-'));
  const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning',
    path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), HOST: '127.0.0.1', PAYESH_DATA: data, PAYESH_LOG: '0',
      PAYESH_CLOUD_AUTO: '0', PAYESH_OUTBOX_AUTO: '0', PAYESH_UPDATE_AUTO: '0',
      PAYESH_AUTO_BACKUP: '0', PAYESH_NO_RESTART: '1',
      NODE_ENV: 'production',
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
    } catch (e) { /* سرور هنوز بالا نیامده */ }
    if (Date.now() - t0 > 30000) throw new Error('سرور بالا نیامد: ' + log.slice(-400));
    await sleep(150);
  }
  const stop = () => { try { child.kill('SIGKILL'); } catch (e) {} try { fs.rmSync(data, { recursive: true, force: true }); } catch (e) {} };
  return { base, child, stop, port };
}

async function oneRound(base, token, devices) {
  const lat = [];
  let errors = 0;
  const stopAt = Date.now() + SECONDS * 1000;
  const cpu0 = childCpuMs(token.pid);
  const t0 = Date.now();

  async function device() {
    while (Date.now() < stopAt) {
      const s = Date.now();
      try {
        const r = await fetch(base + '/api/v1/pull?collections=users&since=1970-01-01T00:00:00.000Z',
          { headers: { authorization: 'Bearer ' + token.value } });
        const body = await r.text();
        if (!r.ok) errors++;
        else if (!body.includes('"ok"')) errors++;
        lat.push(Date.now() - s);
      } catch (e) { errors++; lat.push(Date.now() - s); }
      const wait = POLL_MS - (Date.now() - s);
      if (wait > 0) await sleep(wait);
    }
  }
  await Promise.all(Array.from({ length: devices }, device));
  const wall = (Date.now() - t0) / 1000;
  const cpu1 = childCpuMs(token.pid);
  const sorted = lat.slice().sort((a, b) => a - b);
  return {
    devices,
    reqs: lat.length,
    ok: lat.length - errors,
    errors,
    p50: pct(sorted, 50),
    p95: pct(sorted, 95),
    p99: pct(sorted, 99),
    max: sorted[sorted.length - 1] || 0,
    rps: +(lat.length / wall).toFixed(2),
    cpu_pct: (cpu0 != null && cpu1 != null) ? +(((cpu1 - cpu0) / (wall * 1000)) * 100).toFixed(1) : null,
    wall: +wall.toFixed(2),
  };
}

async function main() {
  const results = [];
  for (const devices of DEVICES) {
    const srv = await startServer();
    try {
      const setup = await fetch(srv.base + '/api/setup', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ school_name: 'مدرسهٔ سنجش', manager_name: 'مدیر سنجش', phone: '09120000099', password: '123456' }),
      }).then(r => r.json());
      if (!setup || !setup.ok) throw new Error('setup: ' + JSON.stringify(setup));
      const login = await fetch(srv.base + '/api/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: '09120000099', password: '123456' }),
      }).then(r => r.json());
      const token = { value: login.session.token, pid: srv.child.pid };
      const r = await oneRound(srv.base, token, devices);
      results.push(r);
      console.log(`BENCH devices=${r.devices} reqs=${r.reqs} ok=${r.ok} errors=${r.errors} ` +
        `p50_ms=${r.p50} p95_ms=${r.p95} p99_ms=${r.p99} max_ms=${r.max} rps=${r.rps} ` +
        `cpu_pct=${r.cpu_pct == null ? 'n/a' : r.cpu_pct} wall_s=${r.wall}`);
    } finally {
      srv.stop();
    }
    await sleep(400);
  }

  const okDevices = results.filter(r => r.errors === 0 && r.p95 < THRESHOLD_MS).map(r => r.devices);
  const maxOk = okDevices.length ? Math.max(...okDevices) : 0;
  const firstBad = results.find(r => r.errors > 0 || r.p95 >= THRESHOLD_MS);
  console.log(`BENCH-CAP max_ok_devices=${maxOk} threshold_ms=${THRESHOLD_MS} ` +
    `first_fail_devices=${firstBad ? firstBad.devices : 'none'} ` +
    `node=${process.version} cpus=${os.cpus().length} platform=${process.platform}`);
  console.log(`BENCH-CLAIM scope=local_single_host no_production_scale_claim=1 ` +
    `poll_ms=${POLL_MS} machines=${os.cpus().length}`);
  const bad = results.length === 0 || maxOk === 0;
  process.exit(bad ? 1 : 0);
}

main().catch(e => { console.error('BENCH-ERROR ' + String(e && e.message || e)); process.exit(1); });
