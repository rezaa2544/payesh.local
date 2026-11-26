'use strict';
/* ═══════════════════════════════════════════════════════════════════════
   Row 191 — «همه‌چیز واقعی»: سقف درصد پردازنده با Job Object ویندوز قطعی می‌شود.

   RC-01  سقف ۲۰ ⇒ اسکریپت PowerShell با EncodedCommand و نرخ 2000 (HARD_CAP=5)؛ وضعیت hard
   RC-02  همان سقف دوباره ⇒ هیچ اجرای تازه‌ای (Job ثابت)؛ سقف ۴۰ ⇒ همان Job با نرخ 4000
   RC-03  برداشتن سقف ⇒ همان Job با نرخ 10000 (نه ControlFlags=0) و وضعیت none
   RC-04  اسکریپت دستگیرهٔ Job را در خود سرور می‌گذارد (DuplicateHandle) تا Job تودرتو ساخته نشود
   RC-05  شکست سیستم‌عامل ⇒ وضعیت error با پیام و تلاش دوباره در خواندن بعدی سیاست
   RC-06  غیر ویندوز ⇒ soft (فقط استراحت بین کارها) و هیچ اجرایی
   Run: node tests/real-cpu-191.js
   ═══════════════════════════════════════════════════════════════════════ */
const assert = require('node:assert');
process.env.PAYESH_NO_OS_CAP = '1';
const P = require('../server/processing');

let passed = 0;
async function check(id, name, fn) {
  try { await fn(); passed++; console.log('ok   ' + id + ' ' + name); } catch (e) { console.log('FAIL ' + id + ' ' + name + ': ' + (e && e.stack || e)); process.exitCode = 1; }
}

(async () => {
  const runs = [];
  let answer = 'CAP-OK';
  P._setCapRunner(async (script) => { runs.push(script); return answer; });
  const opt = { platform: 'win32', pid: 4242 };

  await check('RC-01', 'سقف ۲۰ ⇒ Job با نرخ 2000 و HARD_CAP', async () => {
    P._reset();
    const st = await P.syncOsCap(20, opt);
    assert.strictEqual(runs.length, 1);
    assert.match(runs[0], /PayeshCpuCap-4242/);
    assert.match(runs[0], /\$i\.Flags=5; \$i\.Rate=2000/);
    assert.match(runs[0], /SetInformationJobObject\(\$j,15,/);
    assert.strictEqual(st.mode, 'hard');
    assert.strictEqual(st.cpu, 20);
  });
  await check('RC-02', 'همان سقف ⇒ بی‌اجرا؛ ۴۰ ⇒ همان Job با 4000', async () => {
    await P.syncOsCap(20, opt);
    assert.strictEqual(runs.length, 1);
    const st = await P.syncOsCap(40, opt);
    assert.strictEqual(runs.length, 2);
    assert.match(runs[1], /\$i\.Rate=4000/);
    assert.match(runs[1], /PayeshCpuCap-4242/);
    assert.strictEqual(st.cpu, 40);
  });
  await check('RC-03', 'بدون سقف ⇒ نرخ 10000 و وضعیت none', async () => {
    const st = await P.syncOsCap(null, opt);
    assert.strictEqual(runs.length, 3);
    assert.match(runs[2], /\$i\.Flags=5; \$i\.Rate=10000/);
    assert.strictEqual(st.mode, 'none');
    assert.strictEqual(st.cpu, null);
  });
  await check('RC-04', 'دستگیرهٔ Job در خود سرور (بی‌Job تودرتو)', async () => {
    assert.match(runs[0], /DuplicateHandle\(\[PayeshJob\]::GetCurrentProcess\(\),\$j,\$h,/);
    assert.match(runs[0], /IsProcessInJob\(\$h,\$j,\[ref\]\$in\)/);
  });
  await check('RC-05', 'شکست ⇒ error و تلاش دوباره', async () => {
    answer = 'CAP-ASSIGN-FAIL';
    let st = await P.syncOsCap(30, opt);
    assert.strictEqual(st.mode, 'error');
    assert.match(st.error, /ASSIGN-FAIL/);
    answer = 'CAP-OK';
    st = await P.syncOsCap(30, opt);
    assert.strictEqual(st.mode, 'hard');
    assert.strictEqual(P.status().os_cap.mode, 'hard');
  });
  await check('RC-06', 'غیر ویندوز ⇒ soft بی‌اجرا', async () => {
    P._setCapRunner(null);
    P._reset();
    const n = runs.length;
    const st = await P.syncOsCap(20, { platform: 'linux', pid: 1 });
    assert.strictEqual(st.mode, 'soft');
    assert.strictEqual(runs.length, n);
  });
  console.log('REAL-CPU-191 passed=' + passed + '/6');
})();
