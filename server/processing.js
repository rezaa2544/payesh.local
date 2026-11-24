'use strict';
/* ═════════════════════════════════════════════════════════════════
   ردیف ۱۷۷ — «کنترل پردازش» سرور دادهٔ مدرسه (همتای پنل مالک: power/processing_card.dart)

   مالک در پنل «توقف پردازش» و «سقف درصد CPU» را می‌گذارد؛ این تنظیم در همان «سیاست
   زیرساخت» رمزشدهٔ دیتابیس (control/infra-policy.json، فیلد اختیاری proc = {paused, cpu})
   ثبت می‌شود و این سرور هر بار که سیاست را می‌خواند (helper-jobs.readPolicy، حداکثر هر
   ۶۰ ثانیه یک‌بار) پیرو می‌شود. متغیرهای محیطی بر سیاست مقدم‌اند:
     PAYESH_PROC_PAUSED=1      توقف کارهای سنگین پس‌زمینه روی همین سرور
     PAYESH_CPU_PCT=10..100    سقف درصد CPU همین سرور

   «توقف» یعنی: بکاپ خودکار، آینهٔ ابری، بررسی بیرونی دوره‌ای و کارهای کمکیِ زمان‌بندی‌شده
   اجرا نمی‌شوند. کار کاربران (API) و همگام‌سازی داده (live / outbox) هرگز متوقف نمی‌شود.
   «سقف CPU» یعنی: (۱) آستانهٔ «شلوغ» همین سرور همان سقف است — بالاتر از آن، کار سنگین به
   سرورهای کمکی می‌رود؛ (۲) کارهای سنگینی که همین‌جا اجرا می‌شوند بین گام‌ها به نسبت سقف
   استراحت می‌کنند (چرخهٔ کار: کار t ⇒ استراحت t×(۱۰۰−سقف)/سقف).
   ═════════════════════════════════════════════════════════════════ */

const MIN_CPU = 10;
const MAX_REST_MS = 5000;

const state = { paused: false, cpu: null, source: 'default', at: null };

function envOverride(env = process.env) {
  const out = {};
  if (env.PAYESH_PROC_PAUSED === '1' || env.PAYESH_PROC_PAUSED === 'true') out.paused = true;
  else if (env.PAYESH_PROC_PAUSED === '0' || env.PAYESH_PROC_PAUSED === 'false') out.paused = false;
  const c = Number(env.PAYESH_CPU_PCT);
  if (env.PAYESH_CPU_PCT && Number.isInteger(c) && c >= MIN_CPU && c <= 100) out.cpu = c;
  return out;
}

/** proc معتبر سیاست؟ (نبودنش هم معتبر است = پیش‌فرض) */
function validProc(p) {
  if (p === undefined) return true;
  return !!p && typeof p === 'object' && typeof p.paused === 'boolean' &&
    (p.cpu === undefined || p.cpu === null || (Number.isInteger(p.cpu) && p.cpu >= MIN_CPU && p.cpu <= 100));
}

/** از سیاست تازه‌خوانده‌شده (یا null) پیروی کن؛ محیط مقدم است. */
function apply(policy, env = process.env) {
  const proc = policy && validProc(policy.proc) ? policy.proc : undefined;
  const e = envOverride(env);
  state.paused = e.paused !== undefined ? e.paused : !!(proc && proc.paused);
  state.cpu = e.cpu !== undefined ? e.cpu : (proc && Number.isInteger(proc.cpu) ? proc.cpu : null);
  state.source = (e.paused !== undefined || e.cpu !== undefined) ? 'env' : (proc ? 'policy' : 'default');
  state.at = new Date().toISOString();
  return status();
}

const paused = () => state.paused;
const cpuPct = () => state.cpu;

/** آستانهٔ «شلوغ» CPU (۰ تا ۱)؛ بدون سقف ⇒ [fallback]. */
function busyCpu(fallback) {
  return state.cpu == null ? fallback : state.cpu / 100;
}

/** استراحتِ پس از [workMs] کار، تا میانگین مصرف از سقف بالاتر نرود. */
function restMs(workMs) {
  if (state.cpu == null || state.cpu >= 100 || !(workMs > 0)) return 0;
  return Math.min(MAX_REST_MS, Math.round(workMs * (100 - state.cpu) / state.cpu));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function throttle(workMs) {
  const ms = restMs(workMs);
  if (ms > 0) await sleep(ms);
  return ms;
}

function status() {
  return { paused: state.paused, cpu_pct: state.cpu, source: state.source, at: state.at };
}

function _reset() { state.paused = false; state.cpu = null; state.source = 'default'; state.at = null; }

/* شروع: فقط محیط (تا اولین خواندن سیاست) */
apply(null);

module.exports = { apply, paused, cpuPct, busyCpu, restMs, throttle, status, validProc, envOverride, MIN_CPU, MAX_REST_MS, _reset };
