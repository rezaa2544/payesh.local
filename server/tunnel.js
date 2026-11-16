'use strict';
/* ═══════════════════════════════════════════════════════════════════
   تونل عمومی — «هر کاربر با اینترنت خودش، از هر کجا»
   ───────────────────────────────────────────────────────────────────
   مدرسه معمولاً IP ثابت و پورت باز ندارد (CGNAT). راه رایگان و بدون
   دامنه: یک تونل خروجی از خود سیستم مدرسه.

     • Tailscale Funnel → آدرس ثابت https://<machine>.<tailnet>.ts.net (بار اول تأیید صاحب حساب)
     • تونل رایگان Cloudflare (quick-tunnel.js) → بدون حساب و بدون تأیید؛ نشانی متغیر که فقط
       در فهرست نشانی‌های دیتابیس اعلام می‌شود و برنامه‌ها خودشان پیدایش می‌کنند.

   ردیف ۱۶۵ — «حالت اتصال» را مالک در پنل مالک (زیرساخت ← حالت اتصال، ستون راست) انتخاب
   می‌کند و در همان فهرست نشانی‌ها (pub/school-servers.json → connect.mode) می‌نویسد؛ هر سرور
   مدرسه آن را می‌خواند (discovery.js) و تونل‌ها را مطابقش روشن/خاموش می‌کند:
     auto        سرور مرکزی مالک (اگر تعریف شده) + Tailscale اگر آماده بود، وگرنه Cloudflare
     cloudflare  فقط تونل رایگان Cloudflare
     tailscale   فقط Tailscale Funnel
     central     هیچ تونلی روی سرورهای مدرسه؛ برنامه‌ها فقط سرور مرکزی مالک (و شبکهٔ داخلی)
     lan         فقط شبکهٔ داخلی مدرسه؛ هیچ نشانی عمومی اعلام نمی‌شود
   همهٔ تونل‌ها به «درگاه ورودی عمومی» (127.0.0.1:PAYESH_TUNNEL_PORT) وصل‌اند که درخواستش
   هرگز «از خود رایانه» حساب نمی‌شود (index.js isLocalReq).

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

// ردیف ۱۶۱: دانلود مستقیم نصب‌کنندهٔ ویندوز Tailscale (نه صفحهٔ معرفی tailscale.com/download)
const TAILSCALE_WIN_URL = 'https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe';

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
/* Cloudflare در quick-tunnel.js است (فقط وقتی حالت اتصال اجازه بدهد) */

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

/* پیوند تأیید یک‌بارهٔ Funnel در خروجی tailscale (فقط login.tailscale.com) */
function funnelEnableUrl(text) {
  const m = String(text || '').match(/https:\/\/login\.tailscale\.com\/f\/funnel\?[A-Za-z0-9=&_.-]{1,200}/);
  return m ? m[0] : null;
}
let lastAttempt = { at: null, ok: null, error: null, enable_url: null };
/* وضعیت تونل برای رسید سرور در دیتابیس (cloud-control.writeAck) — بدون راز */
function hint() { return Object.assign({}, lastAttempt); }
/* ── روشن/خاموش کردن Funnel ──────────────────────────────────────── */
async function enableFunnel(port = 8080) {
  const bin = tailscaleBin();
  if (!bin) return { ok: false, error: 'tailscale_not_installed' };
  const st = await tailscaleStatus({ force: true });
  if (!st.logged_in) return { ok: false, error: 'tailscale_not_logged_in', hint: 'tailscale up' };

  /* نحو جدید و قدیم هر دو امتحان می‌شوند */
  let r = await run(bin, ['funnel', '--bg', '--yes', String(port)], { timeout: 45_000 });
  if (!r.ok && /flag provided but not defined|unknown flag/i.test(`${r.stdout || ''}${r.stderr || ''}`)) {
    r = await run(bin, ['funnel', '--bg', String(port)], { timeout: 45_000 });
  }
  if (!r.ok && !funnelEnableUrl(`${r.stdout || ''}${r.stderr || ''}`)) r = await run(bin, ['funnel', String(port), 'on'], { timeout: 45_000 });
  if (!r.ok) {
    /* ردیف ۱۶۴: بار اول Tailscale می‌گوید «Funnel روی tailnet روشن نیست» و یک پیوند تأیید می‌دهد
       که صاحب حساب Tailscale باید یک بار باز کند. پیوند را نگه می‌داریم تا پنل مالک
       (زیرساخت ← سرور) دکمه‌اش را نشان دهد؛ بعد از تأیید، تلاش بعدی خودکار روشن می‌شود. */
    const text = String(r.stdout || '') + '\n' + String(r.stderr || '');
    const enableUrl = funnelEnableUrl(text);
    lastAttempt = { at: nowISO(), ok: false, error: enableUrl ? 'funnel_not_enabled' : 'funnel_failed', enable_url: enableUrl };
    return { ok: false, error: lastAttempt.error, enable_url: enableUrl, detail: (r.stderr || r.error || '').slice(0, 400) };
  }
  const after = await tailscaleStatus({ force: true });
  if (!after.url) return { ok: false, error: 'no_url' };
  lastAttempt = { at: nowISO(), ok: true, error: null, enable_url: null };
  return { ok: true, url: after.url, provider: 'tailscale' };
}

/** باز کردن صفحهٔ ورود Tailscale (مرورگر روی همان سیستم باز می‌شود) */
function login() {
  const bin = tailscaleBin();
  if (!bin) return { ok: false, error: 'tailscale_not_installed', download: TAILSCALE_WIN_URL };
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
      download: TAILSCALE_WIN_URL,
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

/* ── ردیف ۱۶۵: حالت اتصال و مدیر تونل‌ها ─────────────────────────── */
const MODES = Object.freeze(['auto', 'cloudflare', 'tailscale', 'central', 'lan']);
const META_MODE = 'connect_mode';
const META_URLS = 'connect_urls';

function connectMode(store) {
  const m = store ? cfg.getMeta(store, META_MODE) : null;
  return MODES.includes(m) ? m : 'auto';
}

/** حالت انتخاب‌شدهٔ مالک را ثبت می‌کند؛ true اگر عوض شد (و بی‌درنگ اعمال می‌شود). */
function setConnectMode(store, mode, { by = 'owner' } = {}) {
  if (!MODES.includes(mode) || connectMode(store) === mode) return false;
  cfg.setMeta(store, META_MODE, mode);
  try { store.audit({ role: 'system', action: 'connect_mode', collection: 'system', after: { mode, by } }); } catch (e) { /* noop */ }
  if (mgr.store === store) setImmediate(() => reconcile().catch(() => {}));
  return true;
}

/** نشانی‌های عمومی که الان اعلام می‌شوند (بهترین اول، فقط https). */
function publicUrls(store) {
  try {
    const v = JSON.parse(cfg.getMeta(store, META_URLS) || '[]');
    return Array.isArray(v) ? v.filter(u => typeof u === 'string' && /^https:\/\//.test(u)).slice(0, 4) : [];
  } catch (e) { return []; }
}

const mgr = {
  store: null, port: 8080, ingress: 8091, dataDir: null, cf: null, cfInfo: { state: 'off', url: null, error: null },
  tsUrl: null, lastFunnelTry: 0, onChange: () => {}, timer: null, checkTimer: null, busy: false,
  cloudflare: null,
};

function cfMod() { return mgr.cloudflare || (mgr.cloudflare = require('./quick-tunnel')); }

async function ensureCloudflare() {
  if (mgr.cf) { mgr.cf.start(); return; }
  const b = await cfMod().ensureBinary({ dataDir: mgr.dataDir });
  if (!b.ok) { mgr.cfInfo = { state: 'error', url: null, error: b.error, at: nowISO() }; return; }
  mgr.cf = new (cfMod().QuickTunnel)({
    bin: b.bin, port: mgr.ingress,
    onState: (info) => { mgr.cfInfo = info; },
    onUrl: () => { reconcileSoon(); },
  });
  mgr.cf.start();
}

function stopCloudflare() {
  if (mgr.cf) mgr.cf.stop();
  if (mgr.cfInfo.state !== 'off') mgr.cfInfo = Object.assign({}, mgr.cfInfo, { state: 'off', url: null });
}

let soon = null;
function reconcileSoon() {
  clearTimeout(soon);
  soon = setTimeout(() => reconcile().catch(() => {}), 500);
  soon.unref?.();
}

/** یک دور: تونل‌ها را با حالت فعلی هماهنگ می‌کند و نشانی‌های اعلام‌شده را تازه می‌کند. */
async function reconcile() {
  const store = mgr.store;
  if (!store || mgr.busy) return null;
  mgr.busy = true;
  try {
    const mode = connectMode(store);
    const auto = autoEnabled(store);
    let tsUrl = null;
    let ts = null;
    try { ts = await tailscaleStatus(); } catch (e) { ts = null; }
    if (mode === 'auto' || mode === 'tailscale') {
      if (ts && ts.funnel && ts.url) tsUrl = ts.url;
      else if (auto && ts && ts.installed && ts.logged_in && Date.now() - mgr.lastFunnelTry > 10 * 60_000) {
        mgr.lastFunnelTry = Date.now();
        const r = await enableFunnel(mgr.ingress);
        if (r.ok && r.url) tsUrl = r.url;
      }
    } else if (ts && ts.funnel && cfg.getMeta(store, 'connect_ts_ours') === '1') {
      await disableFunnel(mgr.ingress);
      cfg.setMeta(store, 'connect_ts_ours', '');
    }
    if (tsUrl) cfg.setMeta(store, 'connect_ts_ours', '1');
    mgr.tsUrl = tsUrl;

    /* Cloudflare فقط پشت درگاه ورودی عمومی (هرگز مستقیم به درگاه اصلی) */
    const wantCf = auto && mgr.ingress !== mgr.port && process.env.PAYESH_CLOUDFLARE !== '0'
      && (mode === 'cloudflare' || (mode === 'auto' && !tsUrl));
    if (wantCf) await ensureCloudflare(); else stopCloudflare();
    const cfUrl = wantCf && mgr.cf ? mgr.cf.url : null;

    const custom = cfg.getMeta(store, 'tunnel_provider') === 'custom' ? (cfg.publicUrl(store) || null) : null;
    const urls = mode === 'lan' ? [] : [...new Set([custom, tsUrl, cfUrl].filter(Boolean).map(u => String(u).replace(/\/+$/, '')))];
    const before = JSON.stringify(publicUrls(store));
    cfg.setMeta(store, META_URLS, JSON.stringify(urls));
    if (!custom) {
      cfg.setMeta(store, 'public_url', urls[0] || '');
      cfg.setMeta(store, 'tunnel_provider', urls[0] ? (urls[0] === tsUrl ? 'tailscale' : 'cloudflare') : '');
    }
    if (before !== JSON.stringify(urls)) {
      if (urls[0]) console.log('[tunnel] نشانی عمومی: ' + urls.join(' · ') + ' (حالت ' + mode + ')');
      try { mgr.onChange(urls); } catch (e) { /* noop */ }
    }
    return { mode, urls };
  } finally {
    mgr.busy = false;
  }
}

/** وضعیت برای رسید سرور (پنل مالک) — بدون هیچ راز. */
function connectInfo(store) {
  return {
    mode: connectMode(store),
    public_urls: publicUrls(store),
    cloudflare: { state: mgr.cfInfo.state || 'off', url: mgr.cfInfo.url || null, error: mgr.cfInfo.error || null, at: mgr.cfInfo.at || null },
    tailscale: { url: mgr.tsUrl || null, enable_url: lastAttempt ? lastAttempt.enable_url || null : null },
  };
}

function start(store, { everyMs = 2 * 60_000, port = 8080, ingressPort = null, dataDir = null, onChange = null } = {}) {
  Object.assign(mgr, { store, port, ingress: ingressPort || port, dataDir: dataDir || mgr.dataDir });
  if (onChange) mgr.onChange = onChange;
  const delay = Number(process.env.PAYESH_TUNNEL_DELAY || 8_000);
  const t0 = setTimeout(() => reconcile().catch(() => {}), delay);
  t0.unref?.();
  if (mgr.timer) clearInterval(mgr.timer);
  mgr.timer = setInterval(() => reconcile().catch(() => {}), everyMs);
  mgr.timer.unref?.();
  if (mgr.checkTimer) clearInterval(mgr.checkTimer);
  mgr.checkTimer = setInterval(() => { if (mgr.cf) mgr.cf.check().catch(() => {}); }, 2 * 60_000);
  mgr.checkTimer.unref?.();
  return { ok: true };
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  if (mgr.timer) clearInterval(mgr.timer);
  if (mgr.checkTimer) clearInterval(mgr.checkTimer);
  mgr.timer = null;
  mgr.checkTimer = null;
  stopCloudflare();
}

/* آدرس‌های موقتیِ نسخه‌های قدیمی را پاک می‌کنیم تا برنامه هیچ آدرسی را که
   کار نمی‌کند نشان ندهد. فقط آدرس Tailscale (ساختهٔ خودمان) و آدرس دستیِ
   مدیر می‌مانند. */
function purgeStalePublicUrl(store) {
  /* ردیف ۱۶۵: نشانی‌های تونل دور قبل اعتبار ندارند؛ دور اول reconcile دوباره می‌سازدشان */
  try { cfg.setMeta(store, META_URLS, '[]'); } catch (e) { /* noop */ }
  const prev = cfg.publicUrl(store);
  if (!prev) return { cleared: false, url: '' };
  const provider = String(cfg.getMeta(store, 'tunnel_provider') || '');
  let keep = false;
  try {
    keep = /\.ts\.net$/i.test(new URL(prev).hostname) || provider === 'custom' || provider === 'manual';
  } catch (e) { keep = false; }
  if (keep) return { cleared: false, url: prev };
  cfg.setMeta(store, 'public_url', '');
  cfg.setMeta(store, 'tunnel_provider', '');
  try { store.audit({ role: 'system', action: 'public_url_cleared', collection: 'system', after: { url: prev } }); } catch (e) { /* noop */ }
  return { cleared: true, url: prev };
}

module.exports = {
  MODES, connectMode, setConnectMode, publicUrls, connectInfo, reconcile,
  __mgrForTest: () => mgr,
  funnelEnableUrl, hint,
  purgeStalePublicUrl,
  status, refresh, start, stop, autoStart, autoEnabled,
  enableFunnel, disableFunnel, login,
  tailscaleStatus, tailscaleBin,
  rememberPublicUrl,
};
