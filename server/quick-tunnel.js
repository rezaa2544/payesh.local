'use strict';
/* ═══════════════════════════════════════════════════════════════════
   تونل رایگان Cloudflare (Quick Tunnel، بدون حساب و بدون تأیید) — ردیف ۱۶۵
   ───────────────────────────────────────────────────────────────────
   فقط یکی از «حالت‌های اتصال» است که مالک در پنل مالک (زیرساخت ← حالت اتصال) انتخاب
   می‌کند (tunnel.js). وقتی روشن است:
     • cloudflared را با نسخهٔ سنجاق‌شده اجرا می‌کنیم؛ فایل فقط وقتی اجرا می‌شود که SHA-256
       آن دقیقاً همان مقدار منتشرشدهٔ Cloudflare باشد (PIN). اگر روی رایانه نبود، از همان
       نشانی رسمی GitHub دانلود و پیش از اجرا سنجیده می‌شود. نصب‌کننده چیزی اضافه نمی‌کند.
     • پروتکل http2 (روی بسیاری از شبکه‌ها و VPNها QUIC/UDP بسته است).
     • تونل به «درگاه ورودی عمومی» سرور وصل می‌شود (127.0.0.1:PAYESH_TUNNEL_PORT)، نه درگاه
       اصلی؛ هر درخواستی که از آن درگاه بیاید «از بیرون» حساب می‌شود (راه‌اندازی اول، نجات
       مدیر و مسیر دیسک فقط از خود رایانه‌اند و از تونل بسته‌اند — index.js isLocalReq).
     • نشانی *.trycloudflare.com با هر بار روشن شدن عوض می‌شود؛ به کاربر نشان داده نمی‌شود:
       سرور آن را بی‌درنگ در فهرست نشانی‌های دیتابیس (discovery.js) اعلام می‌کند و برنامه‌ها
       خودشان پیدایش می‌کنند. اگر فرایند بیفتد یا نشانی جواب ندهد، دوباره روشن می‌شود.
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { spawn } = require('child_process');

/* نسخهٔ سنجاق‌شده و SHA-256 منتشرشده در یادداشت انتشار رسمی cloudflared */
const PIN = {
  version: '2026.11.0',
  files: {
    'win32-x64': { name: 'cloudflared-windows-amd64.exe', sha256: 'd5c1d82031da6253dcdcff64c944cd0fe063016edeb2e4fd088075fc9bd52d0a', size: 55397592 },
    'linux-x64': { name: 'cloudflared-linux-amd64', sha256: '51f7c68b57ed7269164075d7e789efce5b59355982f06392deeb037d982a51fd', size: 40283099 },
  },
};
const URL_RE = /https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com/i;
const MAX_BYTES = 90 * 1024 * 1024;

const platformKey = (p = process.platform, a = process.arch) => `${p}-${a}`;
const pinFor = (key = platformKey()) => PIN.files[key] || null;
const downloadUrl = (pin) => `https://github.com/cloudflare/cloudflared/releases/download/${PIN.version}/${pin.name}`;

/** اولین نشانی quick tunnel در یک خط گزارش cloudflared (فقط *.trycloudflare.com). */
function parseUrl(text) {
  const m = String(text || '').match(URL_RE);
  return m ? m[0].toLowerCase() : null;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

/* نتیجهٔ سنجش هر فایل (اندازه + زمان) نگه داشته می‌شود تا هر بار ۵۵ مگابایت هش نشود */
const verified = new Map();
async function verifyFile(file, pin) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return false; }
  if (!st.isFile() || (pin.size && st.size !== pin.size)) return false;
  const k = `${file}|${st.size}|${st.mtimeMs}|${st.ctimeMs}|${st.ino}`;
  if (verified.has(k)) return verified.get(k);
  let ok = false;
  try { ok = (await sha256File(file)) === pin.sha256; } catch (e) { ok = false; }
  verified.set(k, ok);
  return ok;
}

function get(url, { redirects = 5, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'payesh-server' }, timeout: timeoutMs }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url);
        if (next.protocol !== 'https:') return reject(new Error('insecure_redirect'));
        return resolve(get(next.toString(), { redirects: redirects - 1, timeoutMs }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('http_' + res.statusCode)); }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** دانلود نسخهٔ سنجاق‌شده به [dest]؛ فقط اگر SHA-256 درست بود جایگزین می‌شود. */
async function download(dest, pin, { fetchStream = get } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  const res = await fetchStream(downloadUrl(pin));
  await new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    let n = 0;
    const out = fs.createWriteStream(tmp);
    res.on('data', d => {
      n += d.length;
      if (n > MAX_BYTES) { res.destroy(new Error('too_large')); return; }
      h.update(d);
    });
    res.on('error', e => { out.destroy(); reject(e); });
    out.on('error', reject);
    out.on('finish', () => {
      if (h.digest('hex') !== pin.sha256) { try { fs.unlinkSync(tmp); } catch (e) { /* noop */ } return reject(new Error('sha_mismatch')); }
      resolve();
    });
    res.pipe(out);
  });
  fs.renameSync(tmp, dest);
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
  return dest;
}

/**
 * مسیر cloudflared سنجیده‌شده: PAYESH_CLOUDFLARED ← کنار برنامه (bin/) ← پوشهٔ داده (bin/)؛
 * اگر هیچ‌کدام نبود (و دانلود مجاز بود) نسخهٔ سنجاق‌شده را در پوشهٔ داده می‌گذارد.
 */
async function ensureBinary({ dataDir, appDir = path.join(__dirname, '..'), allowDownload = true, fetchStream } = {}) {
  const pin = pinFor();
  if (!pin) return { ok: false, error: 'unsupported_platform' };
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const cands = [process.env.PAYESH_CLOUDFLARED, path.join(appDir, 'bin', exe), dataDir && path.join(dataDir, 'bin', exe)].filter(Boolean);
  for (const c of cands) if (await verifyFile(c, pin)) return { ok: true, bin: c };
  if (!allowDownload || !dataDir) return { ok: false, error: 'not_installed' };
  try {
    const dest = path.join(dataDir, 'bin', exe);
    await download(dest, pin, { fetchStream });
    return (await verifyFile(dest, pin)) ? { ok: true, bin: dest, downloaded: true } : { ok: false, error: 'sha_mismatch' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 80) };
  }
}

/**
 * یک quick tunnel زنده با روشن‌شدن دوبارهٔ خودکار.
 *   start() ⇒ cloudflared را بالا می‌آورد؛ وقتی نشانی و «Registered tunnel connection» دیده شد
 *   onUrl(url) صدا زده می‌شود. اگر فرایند افتاد، با فاصلهٔ ۵، ۱۵، ۶۰… ثانیه دوباره روشن می‌شود.
 *   check() ⇒ <url>/healthz؛ سه شکست پشت‌سرهم ⇒ روشن کردن دوباره (نشانی تازه).
 */
class QuickTunnel {
  constructor({ bin, port, spawnImpl = spawn, onUrl = () => {}, onState = () => {}, probe = probeHealth, now = Date.now } = {}) {
    Object.assign(this, { bin, port, spawnImpl, onUrl, onState, probe, now });
    this.proc = null;
    this.url = null;
    this.state = 'off';
    this.error = null;
    this.restarts = 0;
    this.fails = 0;
    this.at = null;
    this.wanted = false;
    this.timer = null;
  }

  info() {
    return { state: this.state, url: this.url, error: this.error, restarts: this.restarts, at: this.at, version: PIN.version };
  }

  _set(state, error = null) {
    this.state = state;
    this.error = error;
    this.at = new Date(this.now()).toISOString();
    try { this.onState(this.info()); } catch (e) { /* noop */ }
  }

  start() {
    this.wanted = true;
    if (this.proc) return;
    clearTimeout(this.timer);
    this._set('starting');
    let seen = null;
    let registered = false;
    const args = ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${this.port}`];
    let p;
    try {
      p = this.spawnImpl(this.bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      this._set('error', 'spawn_failed');
      return this._again();
    }
    this.proc = p;
    const onLine = (chunk) => {
      const text = String(chunk || '');
      seen = seen || parseUrl(text);
      if (/Registered tunnel connection/i.test(text)) registered = true;
      if (seen && registered && this.url !== seen) {
        this.url = seen;
        this.fails = 0;
        this._set('on');
        try { this.onUrl(seen); } catch (e) { /* noop */ }
      }
      if (/429 Too Many Requests|rate.?limit/i.test(text)) this.error = 'rate_limited';
    };
    p.stdout && p.stdout.on('data', onLine);
    p.stderr && p.stderr.on('data', onLine);
    p.on('error', () => { /* exit می‌آید */ });
    p.on('exit', () => {
      if (this.proc !== p) return;
      this.proc = null;
      const was = this.url;
      this.url = null;
      if (was) { try { this.onUrl(null); } catch (e) { /* noop */ } }
      if (!this.wanted) return this._set('off');
      this._set('error', this.error || 'exited');
      this._again();
    });
  }

  _again() {
    if (!this.wanted) return;
    this.restarts++;
    const wait = [5_000, 15_000, 60_000, 120_000, 300_000][Math.min(this.restarts - 1, 4)];
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.start(), wait);
    this.timer.unref?.();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.timer);
    const p = this.proc;
    this.proc = null;
    const was = this.url;
    this.url = null;
    if (p) { try { p.kill(); } catch (e) { /* noop */ } }
    if (was) { try { this.onUrl(null); } catch (e) { /* noop */ } }
    if (this.state !== 'off') this._set('off');
  }

  /** نشانی جواب می‌دهد؟ سه شکست پشت‌سرهم ⇒ دوباره روشن (با نشانی تازه). */
  async check() {
    if (!this.url || !this.proc) return null;
    const ok = await this.probe(this.url).catch(() => false);
    if (ok) { this.fails = 0; return true; }
    this.fails++;
    if (this.fails >= 3) {
      this.fails = 0;
      const p = this.proc;
      this.error = 'unreachable';
      try { p && p.kill(); } catch (e) { /* exit ⇒ روشن کردن دوباره */ }
    }
    return false;
  }
}

function probeHealth(url, { timeoutMs = 15_000 } = {}) {
  return new Promise(resolve => {
    const req = https.get(url.replace(/\/+$/, '') + '/healthz', { timeout: timeoutMs, headers: { 'user-agent': 'payesh-server' } }, res => {
      let body = '';
      res.on('data', d => { if (body.length < 2000) body += d; });
      res.on('end', () => {
        try { resolve(res.statusCode === 200 && JSON.parse(body).ok === true); } catch (e) { resolve(false); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(false));
  });
}

module.exports = { PIN, URL_RE, platformKey, pinFor, downloadUrl, parseUrl, verifyFile, download, ensureBinary, QuickTunnel, probeHealth };
