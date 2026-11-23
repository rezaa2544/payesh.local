'use strict';
/* ═══════════════════════════════════════════════════════════
   ردیف ۱۷۴ — کارهای باز مالک که به Arena سپرده شد
     R61-01  فهرست گواهی‌های ابطال‌شده: کلید افشاشدهٔ قدیمی (D646…) در آن است.
     R61-02  هر چهار مرحلهٔ امضای release (build، اپ مدرسه، اپ مالک native، پنل مالک)
             پس از اعتبارسنجی keystore، tools/signing-revoked-check.sh را اجرا می‌کنند.
     R61-03  کنترل منفی: keystore مصنوعیِ فهرست‌شده ⇒ رد (۱)؛ همان keystore با فهرست واقعی ⇒ قبول (۰)؛
             رمز خالی ⇒ خطای استفاده (۲)؛ هیچ رمزی در خروجی چاپ نمی‌شود.
     R61-04  هیچ فایل keystore در مخزن tracked نیست.
     R91-RTL نوار به‌روزرسانی «نسخهٔ X» (نه vX که کنار رقم فارسی «۷» خوانده می‌شد) و «روز، تاریخ» با «،».
     ADR-105 تصمیم مالک ثبت شده: مسیر مستقیم فعال نمی‌شود، پیش‌فرض Gateway/API و سرور مرکزی؛
             انتخاب transport بی‌تغییر (پیش‌فرض gateway).
   ═══════════════════════════════════════════════════════════ */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const LEAKED = 'D646302BDFAE9495C8726C3D582F5816DCA5401E2CFB77B137C845CFF6B2E36E';
let pass = 0; const fails = [];
async function t(id, fn) {
  try { await fn(); pass++; console.log('PASS ' + id); }
  catch (e) { fails.push(id); console.log('FAIL ' + id + ': ' + (e && e.message)); }
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

(async () => {
  await t('R61-01 revoked list holds the leaked certificate', () => {
    const j = JSON.parse(read('docs/cloud/revoked-signing-certs.json'));
    assert.strictEqual(j.schema, 'payesh-revoked-signing-certs/1');
    assert.ok(Array.isArray(j.revoked) && j.revoked.some((r) => r.sha256 === LEAKED), 'leaked fingerprint missing');
    for (const r of j.revoked) assert.match(r.sha256, /^[0-9A-F]{64}$/);
  });

  await t('R61-02 every release-signing step runs the revoked-certificate gate', () => {
    const want = { '.github/workflows/build.yml': ['PAYESH_KEYSTORE_PASS'],
      '.github/workflows/native-client.yml': ['PAYESH_KEYSTORE_PASS', 'PAYESH_OWNER_KEYSTORE_PASS'],
      '.github/workflows/owner-panel.yml': ['PAYESH_OWNER_KEYSTORE_PASS'] };
    for (const [f, vars] of Object.entries(want)) {
      const s = read(f);
      const calls = s.split('\n').filter((l) => /bash tools\/signing-revoked-check\.sh /.test(l));
      assert.strictEqual(calls.length, vars.length, f + ': expected ' + vars.length + ' gate call(s), got ' + calls.length);
      vars.forEach((v, i) => assert.ok(calls[i].trim().endsWith(' ' + v), f + ': gate #' + (i + 1) + ' must read ' + v));
      // the gate sits after the keytool validation and before the keystore path is exported
      let from = 0;
      for (let i = 0; i < vars.length; i++) {
        const k = s.indexOf('keytool -list', from), g = s.indexOf('signing-revoked-check.sh', k), e = s.indexOf('>> "$GITHUB_ENV"', k);
        assert.ok(k > 0 && g > k && e > g, f + ': gate #' + (i + 1) + ' must run between keytool validation and GITHUB_ENV export');
        from = e + 1;
      }
    }
  });

  await t('R61-03 negative control: a listed certificate is refused, an unlisted one accepted', () => {
    if (spawnSync('openssl', ['version']).status !== 0) { console.log('    SKIP openssl missing'); return; }
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r61-'));
    try {
      const pw = crypto.randomBytes(12).toString('hex');
      const env = { ...process.env, R61_STORE_PW: pw };
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(d, 'k.pem'), '-out', path.join(d, 'c.pem'), '-days', '2', '-subj', '/CN=r61-synthetic'], { stdio: 'ignore' });
      execFileSync('openssl', ['pkcs12', '-export', '-inkey', path.join(d, 'k.pem'), '-in', path.join(d, 'c.pem'), '-out', path.join(d, 's.p12'), '-passout', 'env:R61_STORE_PW', '-name', 'x'], { stdio: 'ignore', env });
      const fp = execFileSync('openssl', ['x509', '-in', path.join(d, 'c.pem'), '-noout', '-fingerprint', '-sha256'], { encoding: 'utf8' }).split('=')[1].replace(/[:\s]/g, '').toUpperCase();
      fs.writeFileSync(path.join(d, 'list.json'), JSON.stringify({ schema: 'payesh-revoked-signing-certs/1', revoked: [{ sha256: fp }] }));
      const run = (extra) => spawnSync('bash', [path.join(ROOT, 'tools/signing-revoked-check.sh'), path.join(d, 's.p12'), 'R61_STORE_PW'], { encoding: 'utf8', env: { ...env, ...extra } });
      const bad = run({ PAYESH_REVOKED_CERTS_FILE: path.join(d, 'list.json') });
      assert.strictEqual(bad.status, 1, 'listed cert must be refused: ' + bad.stdout + bad.stderr);
      assert.ok(/SIGNING-REVOKED:/.test(bad.stdout));
      const ok = run({});
      assert.strictEqual(ok.status, 0, 'unlisted cert must pass: ' + ok.stdout + ok.stderr);
      assert.ok(/SIGNING-REVOKED-OK certs=1/.test(ok.stdout));
      const empty = run({ R61_STORE_PW: '' });
      assert.strictEqual(empty.status, 2, 'empty password var must be a usage error');
      for (const r of [bad, ok, empty]) assert.ok(!(r.stdout + r.stderr).includes(pw), 'password must never be printed');
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });

  await t('R61-04 no keystore file is tracked', () => {
    const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n');
    const ks = files.filter((f) => /\.(p12|pfx|jks|keystore)$/i.test(f));
    assert.deepStrictEqual(ks, []);
  });

  await t('ADR-105 owner decision recorded; transport default stays gateway', () => {
    const s = read('docs/cloud/105-owner-decision.md');
    assert.ok(/## ۹\. تصمیم مالک/.test(s), 'decision section missing');
    assert.ok(/\*\*Parked/.test(s) && s.includes('PAYESH_TRANSPORT=direct'));
    assert.ok(s.includes('فعال نمی‌شود') && s.includes('سرور مرکزی'), 'decision must keep the direct path off and name the central server');
    const tr = require(path.join(ROOT, 'client', 'transport.js'));
    const sel = tr.selectTransport || tr.transportMode || Object.values(tr).find((f) => typeof f === 'function' && /PAYESH_TRANSPORT/.test(String(f)));
    assert.ok(typeof sel === 'function', 'transport selector not found');
    assert.strictEqual(sel({}).mode, 'gateway');
    assert.strictEqual(sel({ PAYESH_TRANSPORT: 'drect' }).mode, 'gateway');
  });

  await t('R91-RTL version and weekday/date stay unambiguous in RTL (no Latin v before digits, «،» not «·»)', () => {
    const pulse = read('apps/payesh/app/lib/src/pulse/pulse.dart');
    const pages = read('client/pages.js');
    const rep = read('apps/payesh/app/lib/src/reports/reports_screen.dart');
    assert.ok(!/text: 'v\$\{u\.channel\.versionOf/.test(pulse), 'pulse update bar still prefixes «v»');
    assert.ok(pulse.includes("TextSpan(text: 'نسخهٔ ')"), 'pulse update bar must say «نسخهٔ»');
    assert.ok(!/class="ltr">v\$\{/.test(pages), 'web update bar still prefixes «v»');
    assert.ok(!/J_DAYS\[[a-zA-Z]+\] \+ ' · '/.test(pages), 'web weekday/date still uses «·»');
    assert.ok(!/jDays\[[a-z]\.weekday\]\} · /.test(rep), 'native weekday/date still uses «·»');
  });

  console.log((fails.length ? 'OWNER-ROWS-174 FAIL ' : 'OWNER-ROWS-174 PASS ') + `(${pass}/${pass + fails.length})`);
  process.exit(fails.length ? 1 : 0);
})();
