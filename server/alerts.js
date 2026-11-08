'use strict';
/* ═══════════════════════════════════════════════════════════════════
   کانال هشدار سامانه — ردیف ۵۸ (Pager/On-call واقعی)

   یک «رویداد هشدار» را می‌گیرد، در دفتر حسابرسی ثابت می‌کند و از طریق
   یک کانال واقعی (تلگرام Bot API) می‌فرستد. توکن/چت از محیط خوانده
   می‌شوند تا هرگز در مخزن قرار نگیرند:
     PAYESH_ALERT_TELEGRAM_TOKEN  توکن بات (مثلاً همان بات مدرسه)
     PAYESH_ALERT_CHAT            شناسهٔ چت دریافت‌کننده (کاربر/گروه)
     PAYESH_ALERT_PROXY           (اختیاری) پراکسی برای شبکه‌های محدودشده
     PAYESH_ALERT_DIR             (اختیاری) پوشهٔ دفتر حسابرسی

   سطوح جدول‌بندی شده با معیارهای توقف پایلوت (ردیف ۵۱):
     S1  بحرانی    — سیستم پایین / نشت داده / data_loss>0
     S2  مهم       — افت کیفیت جدی (بازگشت مداوم ۵xx، تأخیر همگام‌سازی >۱۰x)
     S3  هشدار     — انحراف از آستانهٔ بودجه/ظرفیت
     S4  اطلاع     — رویدادهای اطلاع‌رسانی

   ارسال: fetch به‌صورت پیش‌فرض؛ اگر پراکسی تنظیم شده باشد از curl استفاده
   می‌شود (بدون وابستگی خارجی، روی ویندوز/لینوکس CI).

   اجرای دستی (آزمون واقعی): node server/alerts.js send --level S4 --title t --body b

   این ماژول فقط «کانال» است؛ قواعد هشدار (چه چیزی، کِی) متعلق به ردیف ۴۹ است.
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LEVELS = { S1: 'بحرانی', S2: 'مهم', S3: 'هشدار', S4: 'اطلاع' };
const DEDUPE_WINDOW_MS = 5 * 60 * 1000; // پنجرهٔ یکسان‌سازی
const RETRIES = 2;                       // ۳ تلاش کل (۱ + ۲ بازگشت)
const EMOJI = { S1: '🔴', S2: '🟠', S3: '🟡', S4: '🔵' };

const token = () => process.env.PAYESH_ALERT_TELEGRAM_TOKEN || '';
const chat = () => process.env.PAYESH_ALERT_CHAT || '';
const proxy = () => process.env.PAYESH_ALERT_PROXY || '';
const apiBase = () => (process.env.PAYESH_ALERT_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');

/* دفتر حسابرسی: همهٔ رویدادها حتی ارسال‌نشده — این «ثبت»ِ AC است */
function auditDir() {
  return process.env.PAYESH_ALERT_DIR || path.join(process.cwd(), 'alerts-audit');
}
function auditAppend(entry) {
  const d = auditDir();
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* فقط‌خواندنی: رها می‌شود */ }
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  try { fs.appendFileSync(path.join(d, 'alerts.jsonl'), line, 'utf8'); } catch (e) { /* noop */ }
  return entry;
}

/* فرمت پیام: سطح + عنوان + بدنه + مهر زمانی */
function format(level, title, body) {
  const lv = LEVELS[level] || level;
  const stamp = new Date().toISOString();
  return `${EMOJI[level] || '⚪️'} [${level} ${lv}] ${title}\n\n${body || ''}\n\n_${stamp}_`;
}

/* ارسال از طریق curl وقتی پراکسی تنظیم شده (خروجی JSON را برمی‌گرداند) */
function sendViaCurl(url, payload) {
  const args = ['-s', '--max-time', '30', '-X', 'POST', url,
    '-H', 'Content-Type: application/json', '-d', JSON.stringify(payload)];
  if (proxy()) args.splice(2, 0, '-x', proxy());
  const out = execFileSync('curl', args, { encoding: 'utf8', shell: false });
  return JSON.parse(out || '{}');
}

async function sendViaTelegram(level, title, body) {
  if (!token() || !chat()) return { sent: false, reason: 'not-configured' };
  const url = `${apiBase()}/bot${token()}/sendMessage`;
  const payload = { chat_id: chat(), text: format(level, title, body), parse_mode: 'Markdown' };
  let lastErr = null, attempts = 0;
  for (let i = 1; i <= RETRIES + 1; i++) {
    attempts = i;
    try {
      const res = proxy()
        ? sendViaCurl(url, payload)
        : await (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).json();
      if (res && res.ok) {
        return { sent: true, attempt: attempts, message_id: res.result && res.result.message_id, date: res.result && res.result.date };
      }
      lastErr = (res && res.description) || 'telegram-api-error';
      const code = res && res.error_code;
      // خطای محتوایی کاربر (۴xx): بازگشت بی‌فایده است؛ ۵xx: بازگشت می‌کنیم
      if (code >= 400 && code < 500) break;
    } catch (e) {
      lastErr = String(e.message || e).slice(0, 120);
    }
    if (i <= RETRIES) await new Promise(r => setTimeout(r, 1000 * i));
  }
  return { sent: false, reason: 'send-failed', error: lastErr, attempts };
}

/* یکسان‌سازی ساده درون پروسه: کلید یکسان در پنجره فقط یک بار ارسال می‌شود */
const _seen = new Map(); // key -> ts
function _dedupe(key) {
  const now = Date.now();
  for (const [k, ts] of _seen) if (now - ts > DEDUPE_WINDOW_MS) _seen.delete(k);
  if (key && _seen.has(key)) return false;
  if (key) _seen.set(key, now);
  return true;
}

/* notify: نقطهٔ ورود اصلی (ردیف ۴۹ قواعد خود را به این تابع وصل می‌کنند) */
async function notify({ level = 'S4', key = null, title = '', body = '' } = {}) {
  const first = _dedupe(key);
  const ev = { level, key, title, body };
  if (!first) {
    auditAppend({ ...ev, sent: false, reason: 'deduped' });
    return { sent: false, reason: 'deduped' };
  }
  const r = await sendViaTelegram(level, title, body);
  auditAppend({ ...ev, ...r });
  return r;
}

/* خط فرمان: node server/alerts.js send --level S4 --title t --body b
   یا:      node server/alerts.js test   (یک پیام آزمایشی شمارش‌شده) */
if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
  let p;
  if (argv[0] === 'test') {
    p = notify({ level: 'S4', key: 'manual-test', title: 'پایش — هشدار آزمایشی', body: 'این یک پیام آزمایشی سامانهٔ پایش است (ردیف ۵۸).' });
  } else {
    p = notify({ level: opt('level', 'S4'), key: opt('key', null), title: opt('title', '(بدون عنوان)'), body: opt('body', '') });
  }
  p.then(r => {
    // توکن هرگز چاپ نمی‌شود
    console.log(JSON.stringify({ ok: !!r.sent, ...r, token_present: !!token(), chat_present: !!chat() }));
    process.exit(r.sent ? 0 : 3);
  }).catch(e => { console.error('fatal:', String(e.message || e).slice(0, 200)); process.exit(4); });
}

module.exports = { notify, format, LEVELS, auditAppend, _dedupe };
