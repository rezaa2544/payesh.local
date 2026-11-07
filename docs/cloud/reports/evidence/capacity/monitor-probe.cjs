'use strict';
/* ═══════════════════════════════════════════════════════════════════════
   پروب مانیتورینگ/هشدار — ردیف ۲۹

   محصول را بالا می‌آورد، سپس:
     ۱) `scripts/healthcheck.mjs` روی سرویس سالم ⇒ باید ۰ (ok) بدهد
     ۲) `/api/readyz` باید ۲۰۰ و ready=true بدهد
     ۳) پس از مرگ سرویس ⇒ healthcheck باید ۲ (بحرانی) بدهد (نه ۰)
     ۴) کهنگی بکاپ/آینه با آستانهٔ خیلی سخت ⇒ باید هشدار بدهد (نه ساکت)
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = s => console.log(s);
const LINES = [];
const out = s => { say(s); LINES.push(s); };

let failures = 0;
const fail = m => { failures++; out('MON-FAIL ' + m); };

function freePort() {
  return new Promise((res, rej) => {
    const s = require('net').createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

function runHealthcheck(base, extra = []) {
  return new Promise(res => {
    const cp = spawn(process.execPath, [path.join(ROOT, 'scripts', 'healthcheck.mjs'), '--url=' + base, '--timeout_ms=2500'].concat(extra),
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = '';
    cp.stdout.on('data', d => { o += String(d); });
    cp.stderr.on('data', d => { e += String(d); });
    cp.on('close', code => res({ code, stdout: o.trim(), stderr: e.trim() }));
  });
}

(async () => {
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-mon-'));
  const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning',
    path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), HOST: '127.0.0.1', PAYESH_DATA: data, PAYESH_LOG: '0',
      PAYESH_CLOUD_AUTO: '0', PAYESH_OUTBOX_AUTO: '0', PAYESH_UPDATE_AUTO: '0', PAYESH_NO_RESTART: '1',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += String(d); });
  child.stderr.on('data', d => { log += String(d); });

  try {
    for (let i = 0; i < 200; i++) {
      try { const j = await (await fetch(base + '/api/health')).json(); if (j && j.ok) break; } catch (e) {}
      await sleep(100);
    }
    await fetch(base + '/api/setup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ school_name: 'مدرسهٔ پایش', manager_name: 'مدیر پایش', phone: '09120000500', password: '123456' }),
    });

    const rz = await (await fetch(base + '/api/readyz')).json();
    out(`MON-READYZ status=${rz && rz.ready ? 200 : 503} db=${rz && rz.checks && rz.checks.db} ` +
      `writable=${rz && rz.checks && rz.checks.data_writable} disk_free_pct=${rz && rz.checks && rz.checks.disk_free_pct} ` +
      `backup_age_s=${rz && rz.checks && rz.checks.backup_age_s}`);
    if (!rz || !rz.ready) fail('readyz not ready on a healthy instance');
    const blob = JSON.stringify(rz || {});
    if (blob.includes(data)) fail('readyz leaks the absolute data dir');
    if (/(secret|password|accessKey|token)/i.test(blob)) fail('readyz leaks a secret-looking field');

    const hc = await runHealthcheck(base);
    out(`MON-HEALTHY exit=${hc.code} out=${hc.stdout.slice(0, 220)}`);
    if (hc.code !== 0) fail('healthcheck is not happy on a healthy instance');

    /* کهنگی: آستانهٔ صفر ⇒ باید هشدار بدهد (پروپ ساکت نیست) */
    const strict = await runHealthcheck(base, ['--backup_stale_h=0', '--disk_min=100']);
    out(`MON-STRICT exit=${strict.code} out=${strict.stdout.slice(0, 220)}`);
    if (strict.code === 0) fail('healthcheck stayed silent with impossible thresholds');

    child.kill('SIGKILL');
    await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r));
    await sleep(300);
    const down = await runHealthcheck(base);
    out(`MON-DOWN exit=${down.code} out=${down.stdout.slice(0, 160)}`);
    if (down.code !== 2) fail('healthcheck did not go critical when the service is down');
  } catch (e) {
    fail('probe threw: ' + String(e && e.message || e));
  } finally {
    try { child.kill('SIGKILL'); } catch (e) {}
    try { fs.rmSync(data, { recursive: true, force: true }); } catch (e) {}
  }

  out(`MON-ALERTS scope=external_probe thresholds=doc16_section6 no_pager_integration=1`);
  out(`MON-PROBE-${failures === 0 ? 'OK' : 'FAIL'} failures=${failures}`);

  if (ARGS.out) {
    fs.writeFileSync(ARGS.out, [
      '# شاهد خام مانیتورینگ/هشدار — ردیف ۲۹',
      `generated_at: ${new Date().toISOString()}`,
      `node ${process.version} ${process.platform}`,
      ...LINES,
      '',
      'NOTE: این یک پروب اجرایی است، نه سرویس پیجر؛ اتصال به پیجر مسئولیت استقرار است.',
      `EXIT=${failures === 0 ? 0 : 1}`,
    ].join('\n') + '\n');
    console.log('→ ' + ARGS.out);
  }
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('MON-ERROR ' + String(e && e.message || e)); process.exit(1); });
