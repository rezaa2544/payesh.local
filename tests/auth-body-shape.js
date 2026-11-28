'use strict';
/* ═══════════════════════════════════════════════════════════════════
   رگرسیون یافتهٔ Schemathesis (۲۰۲۶-۱۱-۲۸): بدنهٔ JSON معتبر ولی غیرآبجکت
   (null، عدد، رشته، آرایه) در مسیرهای auth باید ۴۰۰ bad_json بدهد، نه ۵۰۰.
   رفتار بدنهٔ آبجکت ({} ⇒ ۴۰۰ با خطای دامنه) و JSON خراب (⇒ ۴۰۰ bad_json)
   بی‌تغییر می‌ماند.
   اجرا: node --experimental-sqlite tests/auth-body-shape.js
   خط آخر: AUTH-BODY-SHAPE-OK checks=N | AUTH-BODY-SHAPE-FAIL failures=N
   ═══════════════════════════════════════════════════════════════════ */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-abs-'));
const ROUTES = ['/api/auth/login', '/api/auth/claim', '/api/auth/transfer/redeem', '/api/auth/unlock'];
const NON_OBJECT = ['null', '-6718', '"x"', '[]', '[{"phone":"09120000000"}]', 'true'];

let checks = 0, failures = 0;
const ok = (id, cond, msg) => { checks++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${id}  ${msg}`); if (!cond) failures++; };

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer(); s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

(async () => {
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST: '127.0.0.1', PAYESH_DATA: TMP, PAYESH_LOG: '0',
      PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0', PAYESH_LIVE_MS: '0', PAYESH_OUTBOX_AUTO: '0', PAYESH_CLOUD_AUTO: '0',
    }),
  });
  let errOut = '';
  child.stderr.on('data', (d) => { errOut += String(d); });
  try {
    const t0 = Date.now();
    for (;;) {
      try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch (e) { /* not up yet */ }
      if (Date.now() - t0 > 20000) throw new Error('server did not start: ' + errOut.slice(-400));
      await new Promise((r) => setTimeout(r, 150));
    }
    const post = async (route, raw) => {
      const r = await fetch(BASE + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
      let data = null; try { data = await r.json(); } catch (e) { data = null; }
      return { status: r.status, data };
    };
    for (const route of ROUTES) {
      for (const raw of NON_OBJECT) {
        const r = await post(route, raw);
        ok('ABS-01', r.status === 400 && r.data && r.data.error === 'bad_json', `${route} body=${raw} → ${r.status} ${r.data && r.data.error}`);
      }
      const bad = await post(route, '{"phone":');
      ok('ABS-02', bad.status === 400 && bad.data && bad.data.error === 'bad_json', `${route} broken JSON → ${bad.status} ${bad.data && bad.data.error}`);
      const empty = await post(route, '{}');
      ok('ABS-03', empty.status >= 400 && empty.status < 500 && empty.data && empty.data.error !== 'bad_json',
        `${route} {} → ${empty.status} ${empty.data && empty.data.error} (domain error, unchanged)`);
    }
    /* سرور پس از همهٔ این‌ها سالم است (هیچ ۵۰۰ یا کرشی نبود) */
    const h = await fetch(BASE + '/api/health');
    ok('ABS-04', h.ok, 'server still healthy');
    ok('ABS-05', !/TypeError|Cannot destructure|Cannot read prop/.test(errOut), 'no handler TypeError in server stderr');
  } catch (e) {
    ok('ABS-00', false, String(e && e.message || e));
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log(failures ? `AUTH-BODY-SHAPE-FAIL failures=${failures}` : `AUTH-BODY-SHAPE-OK checks=${checks}`);
  process.exit(failures ? 1 : 0);
})();
