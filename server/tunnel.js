'use strict';
/* ═══════════════════════════════════════════════════════════════════
   تونل عمومی — «هر کاربر با اینترنت خودش، از هر کجا»
   ───────────────────────────────────────────────────────────────────
   مدرسه معمولاً IP ثابت و پورت باز ندارد (CGNAT). راه رایگان و بدون
   دامنه: یک تونل خروجی از خود سیستم مدرسه.

     • Tailscale Funnel → آدرس ثابت https://<machine>.<tailnet>.ts.net
   (تونل‌های ابری خارجی عمداً پشتیبانی نمی‌شوند: در ایران در دسترس نیستند
    و آدرسشان هم با هر بار روشن شدن عوض می‌شود.)

   این ماژول ابزارها را پیدا می‌کند، تونل را روشن می‌کند، آدرس عمومی را
   می‌گیرد و خودکار در تنظیمات ذخیره می‌کند تا:
     – آدرس روی همهٔ گوشی‌ها/مرورگرها یکی باشد (در /api/health)
     – APK اندروید همان را یاد بگیرد
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const cfg = require('./config');
const { nowISO } = require('./util');

const TS_PATHS = [
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
  '/usr/bin/tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale',
];

/* ── ابزارها ──────────────────────────────────────────────────────── */
function locate(envKey, candidates, name) {
  const custom = process.env[envKey];
  if (custom && fs.existsSync(custom)) return custom;
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (e) { /* noop */ }
  }
  return null;
}

function hasCommand(cmd) {
  /* جست‌وجوی سبک در PATH بدون اجرای فرمان */
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try { if (fs.existsSync(path.join(dir, cmd + ext))) return path.join(dir, cmd + ext); } catch (e) { /* noop */ }
    }
  }
  return null;
}

function tailscaleBin() {
  return locate('PAYESH_TAILSCALE_BIN', TS_PATHS, 'tailscale') || hasCommand('tailscale');
}
/* هیچ تونل ابری خارجی دیگری پشتیبانی نمی‌شود */

/* ── اجرا ─────────────────────────────────────────────────────────── */
function run(bin, args, { timeout = 20_000 } = {}) {
  return new Promise(resolve => {
    execFile(bin, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && err.code != null ? err.code : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: err ? String(err.message || err) : null,
      });
    });
  });
}

/* ── وضعیت Tailscale ─────────────────────────────────────────────── */
let tsCache = { at: 0, value: null };

async function tailscaleStatus({ force = false } = {}) {
  const bin = tailscaleBin();
  if (!bin) return { installed: false, bin: null, logged_in: false, url: null, funnel: false };
  if (!force && tsCache.value && Date.now() - tsCache.at < 20_000) return tsCache.value;

  let url = null, loggedIn = false, online = false, err = null;
  const st = await run(bin, ['status', '--json'], { timeout: 12_000 });
  if (st.ok) {
    try {
      const j = JSON.parse(st.stdout);
      const dns = (j.Self && j.Self.DNSName) || '';
      loggedIn = String(j.BackendState || '') === 'Running';
      online = loggedIn;
      if (dns) url = 'https://' + String(dns).replace(/\.$/, '');
    } catch (e) { err = 'bad_json'; }
  } else {
    err = st.stderr.trim() || st.error;
  }

  /* آیا Funnel روشن است؟ (ساده و مقاوم: خروجی متنی) */
  let funnel = false;
  const fs2 = await run(bin, ['funnel', 'status'], { timeout: 12_000 });
  if (fs2.ok) {
    const text = (fs2.stdout + '\n' + fs2.stderr);
    funnel = /https:\/\/[^\s]+/.test(text) && !/No serve config|not enabled|no funnel/i.test(text);
    if (!url) {
      const m = text.match(/https:\/\/[^\s]+/);
      if (m) url = m[0].replace(/\/+$/, '');
    }
  }

  const value = {
    installed: true, bin, logged_in: loggedIn, online, funnel, url,
    error: err, checked_at: nowISO(),
  };
  tsCache = { at: Date.now(), value };
  return value;
}

/* ── روشن/خاموش کردن Funnel ──────────────────────────────────────── */
async function enableFunnel(port = 8080) {
  const bin = tailscaleBin();
  if (!bin) return { ok: false, error: 'tailscale_not_installed' };
  const st = await tailscaleStatus({ force: true });
  if (!st.logged_in) return { ok: false, error: 'tailscale_not_logged_in', hint: 'tailscale up' };

  /* نحو جدید و قدیم هر دو امتحان می‌شوند */
  let r = await run(bin, ['funnel', '--bg', String(port)], { timeout: 45_000 });
  if (!r.ok) r = await run(bin, ['funnel', String(port), 'on'], { timeout: 45_000 });
  if (!r.ok) {
    return { ok: false, error: 'funnel_failed', detail: (r.stderr || r.error || '').slice(0, 400) };
  }
  const after = await tailscaleStatus({ force: true });
  if (!after.url) return { ok: false, error: 'no_url' };
  return { ok: true, url: after.url, provider: 'tailscale' };
}

/** باز کردن صفحهٔ ورود Tailscale (مرورگر روی همان سیستم باز می‌شود) */
function login() {
  const bin = tailscaleBin();
  if (!bin) return { ok: false, error: 'tailscale_not_installed', download: 'https://tailscale.com/download/windows' };
  try {
    const child = spawn(bin, ['up'], { windowsHide: false, detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true, message: 'مرورگر برای ورود به Tailscale باز می‌شود' };
  } catch (e) {
    return { ok: false, error: 'spawn_failed', detail: String(e.message || e) };
  }
}

async function disableFunnel(port = 8080) {
  const bin = tailscaleBin();
  if (!bin) return { ok: false, error: 'tailscale_not_installed' };
  await run(bin, ['funnel', String(port), 'off'], { timeout: 20_000 });
  await run(bin, ['funnel', 'reset'], { timeout: 20_000 });
  tsCache = { at: 0, value: null };
  return { ok: true };
}

/* تونل ابری خارجی حذف شده است — فقط Tailscale Funnel */

/* ── وضعیت کلی برای پنل ──────────────────────────────────────────── */
function rememberPublicUrl(store, url, provider) {
  if (!url) return null;
  const clean = String(url).replace(/\/+$/, '');
  const prev = cfg.getMeta(store, 'public_url');
  if (prev !== clean) {
    cfg.setMeta(store, 'public_url', clean);
    try {
      store.audit({ role: 'system', action: 'public_url_auto', collection: 'system', after: { url: clean, provider } });
    } catch (e) { /* noop */ }
  }
  cfg.setMeta(store, 'tunnel_provider', provider || 'manual');
  return clean;
}

async function status(store) {
  const ts = await tailscaleStatus();
  const current = cfg.publicUrl(store) || '';
  const provider = current
    ? (/\.ts\.net$/i.test(new URL(current).hostname) ? 'tailscale' : 'custom')
    : (ts.funnel ? 'tailscale' : 'none');

  return {
    ok: true,
    public_url: current || null,
    provider,
    tailscale: {
      installed: ts.installed,
      logged_in: !!ts.logged_in,
      funnel: !!ts.funnel,
      url: ts.url || null,
      error: ts.error || null,
      download: 'https://tailscale.com/download/windows',
    },
    can_enable: !!ts.installed,
    checked_at: nowISO(),
  };
}

/* ── تشخیص خودکار در زمان راه‌اندازی ─────────────────────────────── */
let timer = null;
async function refresh(store, { quiet = true } = {}) {
  try {
    /* آدرس دستی مدیر (provider=custom) همیشه مقدم است */
    const saved = cfg.publicUrl(store) || '';
    if (saved && cfg.getMeta(store, 'tunnel_provider') === 'custom') {
      return { ok: true, url: saved, provider: 'custom', skipped: true };
    }
    const ts = await tailscaleStatus();
    if (ts.funnel && ts.url) {
      rememberPublicUrl(store, ts.url, 'tailscale');
      return { ok: true, url: ts.url, provider: 'tailscale' };
    }
    if (!quiet) return { ok: true, url: null };
    return { ok: false, url: null };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ── راه‌اندازی خودکار ─────────────────────────────────────────────
   هدف: «هر کاربر با اینترنت خودش» بدون اینکه مدیر دنبال دکمه بگردد.
   اگر آدرس عمومی تنظیم نشده باشد و یکی از ابزارها نصب باشد، خودش:
     • Tailscale را (اگر وارد شده) با Funnel بالا می‌آورد → آدرس ثابت  */
function autoEnabled(store) {
  if (process.env.PAYESH_TUNNEL_AUTO === '0') return false;
  if (process.env.PAYESH_TUNNEL_AUTO === '1') return true;
  const v = store ? cfg.getMeta(store, 'tunnel_auto') : null;
  return v === null || v === undefined ? true : !!v;
}

let autoRunning = false;
async function autoStart(store, port) {
  if (!autoEnabled(store)) return { ok: false, error: 'auto_disabled' };
  if (cfg.publicUrl(store)) return { ok: true, skipped: true, url: cfg.publicUrl(store) };
  if (autoRunning) return { ok: false, error: 'in_progress' };
  autoRunning = true;
  try {
    return await autoStartOnce(store, port);
  } finally {
    autoRunning = false;
  }
}

async function autoStartOnce(store, port) {

  const ts = await tailscaleStatus({ force: true });
  if (ts.installed && ts.logged_in) {
    const r = await enableFunnel(port);
    if (r.ok && r.url) {
      rememberPublicUrl(store, r.url, 'tailscale');
      return { ok: true, provider: 'tailscale', url: r.url };
    }
  }
  return { ok: false, error: 'no_tool', hint: 'Tailscale را نصب و وارد شوید' };
}

function start(store, { everyMs = 10 * 60_000, port = 8080 } = {}) {
  const tick = () => { refresh(store).catch(() => {}); };
  setTimeout(tick, 8_000).unref?.();
  /* چند ثانیه بعد از بالا آمدن، خودش تونل را روشن کن (اگر ممکن بود).
     اگر ابزار تازه نصب شده/وارد نشده باشد، چند بار دیگر هم تلاش می‌کند:
     مثلاً نصب Tailscale یا ورود مدیر. */
  const delay = Number(process.env.PAYESH_TUNNEL_DELAY || 15_000);
  const attempt = (n) => {
    autoStart(store, port)
      .then(r => {
        if (r && r.ok && r.url) { console.log('[tunnel] آدرس عمومی خودکار: ' + r.url); return; }
        if (n < 10) setTimeout(() => attempt(n + 1), 60_000).unref?.();
      })
      .catch(() => { if (n < 10) setTimeout(() => attempt(n + 1), 60_000).unref?.(); });
  };
  setTimeout(() => attempt(1), delay).unref?.();
  if (timer) clearInterval(timer);
  timer = setInterval(tick, everyMs);
  timer.unref?.();
  return { ok: true };
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  status, refresh, start, stop, autoStart, autoEnabled,
  enableFunnel, disableFunnel, login,
  tailscaleStatus, tailscaleBin,
  rememberPublicUrl,
};
