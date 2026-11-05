#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   بررسی سلامت استقرار — بعد از بالا آوردن روی هر میزبانی اجرا کنید:
       node deploy/selfcheck.mjs https://payesh.example.ir
   چه چیزهایی را چک می‌کند:
     • پاسخ /api/health و اینکه واقعاً «پایش» است (نه صفحهٔ خطای هاست)
     • نسخهٔ سرور و آدرس عمومی اعلام‌شده
     • یکتایی نمونه (instance) و اینکه چند نمونه پشت هم نیست
     • سرعت پاسخ (برای شبکهٔ ایران مهم است)
   ═══════════════════════════════════════════════════════════════════ */
const base = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const c = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', x: '\x1b[0m' };
let bad = 0;
const pass = m => console.log(`  ${c.g}✓${c.x} ${m}`);
const fail = m => { bad++; console.log(`  ${c.r}✗${c.x} ${m}`); };
const warn = m => console.log(`  ${c.y}!${c.x} ${m}`);

console.log(`\n▶ بررسی ${base}\n`);

async function get(pathname) {
  const t0 = Date.now();
  const r = await fetch(base + pathname, { headers: { 'user-agent': 'PayeshSelfCheck/1.0' } });
  const text = await r.text();
  return { status: r.status, text, ms: Date.now() - t0, headers: r.headers };
}

try {
  const h = await get('/api/health');
  if (h.status !== 200) fail(`/api/health کد ${h.status} برگرداند`);
  else pass(`/api/health پاسخ داد (${h.ms}ms)`);

  let j = {};
  try { j = JSON.parse(h.text); } catch (e) { fail('پاسخ health JSON معتبر نبود'); }
  if (j.ok === true) pass('ok=true');
  if (j.name === 'payesh-local' || /payesh/i.test(JSON.stringify(j))) pass('این همان سامانهٔ پایش است');
  else fail(`نشانهٔ پایش نیست (name=${j.name})`);
  if (j.instance) pass(`شناسهٔ نمونه: ${String(j.instance).slice(0, 12)}…`);
  if (j.version) pass(`نسخهٔ سرور: ${j.version}`);
  if (j.setup_done === false) warn('هنوز راه‌اندازی نشده — آدرس را در مرورگر باز کنید و مدرسه را بسازید');
  else if (j.setup_done === true) pass('مدرسه ساخته شده است');
  if (j.public_url) pass(`آدرس عمومی اعلام‌شده: ${j.public_url}`);
  else warn('آدرس عمومی تنظیم نشده — PAYESH_PUBLIC_URL یا پنل مدیر ← شبکه');

  if (h.ms > 1500) warn(`پاسخ کند است (${h.ms}ms) — برای کاربران ایران بررسی کنید`);
  else pass('سرعت پاسخ خوب است');

  const st = await get('/api/update/check?current=0.0.1');
  if (st.status === 200) {
    const s = JSON.parse(st.text);
    pass(`کانال به‌روزرسانی کار می‌کند (${(s.changed || []).length} فایل تغییرکرده)`);
  } else fail(`/api/update/check کد ${st.status}`);

  const home = await get('/');
  if (home.status === 200 && /payesh|پایش/i.test(home.text)) pass('صفحهٔ اصلی بارگذاری می‌شود');
  else fail('صفحهٔ اصلی درست برنگشت');

  const cfg = await get('/manifest.webmanifest');
  if (cfg.status === 200) pass('PWA (نصب روی گوشی) در دسترس است');
  else warn('manifest پیدا نشد (برای نصب PWA مهم است)');
} catch (e) {
  fail(`اتصال برقرار نشد: ${e.message}`);
  console.log(`\n${c.d}اگر روی ابر است: آیا سرویس روشن است؟ آیا آدرس https درست است؟${c.x}`);
}

console.log(bad === 0 ? `\n${c.g}✅ همه‌چیز سالم است.${c.x}\n` : `\n${c.r}${bad} مشکل پیدا شد.${c.x}\n`);
process.exit(bad === 0 ? 0 : 1);
