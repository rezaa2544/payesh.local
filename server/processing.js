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
const { execFile } = require('child_process');
const MAX_REST_MS = 5000;

const state = { paused: false, cpu: null, source: 'default', at: null };

/* ── ردیف ۱۹۱: سقف قطعی ویندوز (Job Object با CPU rate HARD_CAP) ──────────────
   «سقف ۲۰٪» یعنی خود ویندوز اجازه نمی‌دهد این سرور (و فرایندهای فرزندش) بیش از ۲۰٪ کل
   توان همهٔ هسته‌ها را بگیرد — نه فقط استراحت بین کارها. Node به API ویندوز دسترسی مستقیم
   ندارد ⇒ یک PowerShell کوتاه Job Objectِ نام‌دار «PayeshCpuCap-<pid>» را می‌سازد/باز
   می‌کند، همین فرایند را در آن می‌گذارد و نرخ را تنظیم می‌کند (Job تا وقتی این فرایند زنده
   است می‌ماند). سیستم‌عامل‌های دیگر ⇒ همان روش نرم (استراحت بین کارها). */
const osCap = { mode: 'none', cpu: null, at: null, error: null };
let capRunner = null;   /* آزمون‌ها: (script) => Promise<string> */
let capBusy = null;
let capWanted;

function capScript(pid, cpu) {
  /* «بدون سقف» = همان Job با نرخ ۱۰۰٪ (ویندوز ControlFlags=0 را برای Jobِ دارای نرخ نمی‌پذیرد) */
  const flags = 0x1 | 0x4;
  const rate = cpu == null ? 10000 : Math.max(1, Math.min(100, cpu)) * 100;
  return [
    "$ErrorActionPreference='Stop'",
    'Add-Type -TypeDefinition @"',
    'using System; using System.Runtime.InteropServices;',
    'public static class PayeshJob {',
    ' [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateJobObjectW(IntPtr a, string n);',
    ' [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr j, int c, ref CR i, int l);',
    ' [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);',
    ' [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(int a, bool i, int pid);',
    ' [DllImport("kernel32.dll", SetLastError=true)] public static extern bool IsProcessInJob(IntPtr p, IntPtr j, out bool r);',
    ' [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GetCurrentProcess();',
    ' [DllImport("kernel32.dll", SetLastError=true)] public static extern bool DuplicateHandle(IntPtr sp, IntPtr h, IntPtr tp, out IntPtr d, uint a, bool i, uint o);',
    ' [StructLayout(LayoutKind.Sequential)] public struct CR { public uint Flags; public uint Rate; }',
    '}',
    '"@',
    "$j=[PayeshJob]::CreateJobObjectW([IntPtr]::Zero,'PayeshCpuCap-" + pid + "')",
    "if($j -eq [IntPtr]::Zero){ 'CAP-NOJOB'; exit 2 }",
    '$h=[PayeshJob]::OpenProcess(0x1F0FFF,$false,' + pid + ')',
    '$in=$false; [void][PayeshJob]::IsProcessInJob($h,$j,[ref]$in)',
    /* تازه ساخته شد ⇒ یک دستگیره در خود سرور هم گذاشته می‌شود تا نام Job با بسته شدن این
       PowerShell از بین نرود و دفعهٔ بعد همان Job (نه یک Job تودرتوی تازه) تنظیم شود */
    "if(-not $in){ if(-not [PayeshJob]::AssignProcessToJobObject($j,$h)){ 'CAP-ASSIGN-FAIL'; exit 3 }; $d=[IntPtr]::Zero; [void][PayeshJob]::DuplicateHandle([PayeshJob]::GetCurrentProcess(),$j,$h,[ref]$d,0,$false,2) }",
    '$i=New-Object PayeshJob+CR; $i.Flags=' + flags + '; $i.Rate=' + rate,
    "if([PayeshJob]::SetInformationJobObject($j,15,[ref]$i,8)){ 'CAP-OK' } else { 'CAP-FAIL'; exit 4 }",
  ].join('\n');
}

function defaultRunner(script) {
  return new Promise((resolve) => {
    /* EncodedCommand (UTF-16LE base64): بدون هیچ دردسر نقل‌قول در خط فرمان ویندوز */
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
      { windowsHide: true, timeout: 60_000 }, (err, stdout) => resolve(String(stdout || '') + (err ? ' ERR ' + err.message : '')));
  });
}

/** سقف سیستم‌عامل را با [cpu] هم‌گام کن (فقط ویندوز یا با اجراکنندهٔ آزمون). */
function syncOsCap(cpu = state.cpu, { platform = process.platform, pid = process.pid } = {}) {
  const want = cpu == null || cpu >= 100 ? null : cpu;
  if (!capRunner && platform !== 'win32') { osCap.mode = 'soft'; osCap.cpu = want; return Promise.resolve(osCap); }
  if (want === capWanted && capBusy) return capBusy;
  if (want === capWanted && (osCap.mode === 'hard' || (want == null && osCap.mode !== 'error'))) return Promise.resolve(osCap);
  if (want == null && osCap.mode === 'none') { capWanted = null; return Promise.resolve(osCap); }
  capWanted = want;
  const run = capRunner || defaultRunner;
  const job = (capBusy || Promise.resolve()).then(() => run(capScript(pid, want))).then((out) => {
    const ok = /CAP-OK/.test(out);
    osCap.mode = ok ? (want == null ? 'none' : 'hard') : 'error';
    osCap.cpu = want;
    osCap.at = new Date().toISOString();
    osCap.error = ok ? null : String(out).trim().slice(0, 200);
    if (!ok) capWanted = undefined;
    return osCap;
  }).catch((e) => { osCap.mode = 'error'; osCap.error = String(e && e.message || e).slice(0, 200); capWanted = undefined; return osCap; })
    .finally(() => { if (capBusy === job) capBusy = null; });
  capBusy = job;
  return job;
}

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
  if (!process.env.PAYESH_NO_OS_CAP) syncOsCap().catch(() => {});
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
  return { paused: state.paused, cpu_pct: state.cpu, source: state.source, at: state.at,
    os_cap: { mode: osCap.mode, cpu: osCap.cpu, at: osCap.at, error: osCap.error } };
}

function _reset() {
  state.paused = false; state.cpu = null; state.source = 'default'; state.at = null;
  osCap.mode = 'none'; osCap.cpu = null; osCap.at = null; osCap.error = null; capWanted = undefined; capBusy = null;
}
function _setCapRunner(fn) { capRunner = fn; }

/* شروع: فقط محیط (تا اولین خواندن سیاست) */
apply(null);

module.exports = { apply, paused, cpuPct, busyCpu, restMs, throttle, status, validProc, envOverride, syncOsCap, capScript, MIN_CPU, MAX_REST_MS, _reset, _setCapRunner };
