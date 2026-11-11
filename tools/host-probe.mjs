#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۱۱۵ — «پروب هاست»: هاست ابری فعلی چه چیزی واقعاً می‌دهد؟
   (مرحلهٔ A؛ تصمیم نهایی پس از اجرای واقعی در ردیف ۱۱۶ گرفته می‌شود)

   سه راه اجرا (راهنمای فارسی: docs/cloud/115-host-probe.md):
     ۱) با دسترسی ترمینال/SSH روی هاست:
          node host-probe.mjs                     → گزارش JSON روی خروجی
          node host-probe.mjs --pg-host db.example.com:5432
          node host-probe.mjs --public-url https://payeshschool.ir
     ۲) بدون ترمینال، به‌صورت «اپ Node» در پنل هاست:
          فایل شروع: host-probe-start.cjs  (یا: node host-probe.mjs --serve)
          سپس آدرس اپ را در مرورگر باز کنید؛ گزارش فارسی + /probe.json
     ۳) اصلاً نمی‌شود اجرا کرد: فرم tools/host-probe-form.html را باز کنید
        و آنچه پنل هاست نشان می‌دهد را وارد کنید (source=owner_panel؛
        مقدار واردشده [M] «خوانده‌شده از پنل»، خالی/نمی‌دانم → [?]).

   قیدها (AC ردیف ۱۱۵):
     • هیچ وابستگی بیرونی؛ روی Node قدیمی هم اجرا می‌شود تا نسخهٔ قدیمی را گزارش کند.
     • هیچ اعتبارنامه‌ای جایی فرستاده نمی‌شود: پروب PostgreSQL فقط ۸ بایت
       SSLRequest می‌فرستد و بعد فقط دست‌دهی TLS — نه نام کاربر، نه رمز، نه پایگاه.
     • خروجی redacted است: مقدار متغیرهای محیطی حساس، userinfo در URL، توکن‌ها.
     • هر مورد برچسب دارد: [M] سنجیده روی همین هاست · [?] نامعلوم/اجرانشده.
   ═══════════════════════════════════════════════════════════════════ */
import os from 'os';
import fs from 'fs';
import path from 'path';
import net from 'net';
import tls from 'tls';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

export const SCHEMA = 'payesh-host-probe/1';
export const TOOL_VERSION = '1.0.0';
export const NODE_MIN = [22, 5, 0];
export const LABELS = ['M', '?'];
export const CHECK_IDS = [
  'node_version', 'node_sqlite', 'runtime', 'cpu', 'memory', 'disk_free', 'disk_persistence',
  'always_on', 'port', 'https', 'outbound_tls_pg', 'outbound_https', 'local_postgres', 'logs', 'backup',
];
/* موارد لازم برای «Gateway روی همین هاست» (ردیف ۱۲۰). PostgreSQL یکی از دو راه را می‌خواهد. */
export const REQUIRED_FOR_GATEWAY = ['node_version', 'node_sqlite', 'disk_persistence', 'always_on', 'https'];
export const PG_SSL_REQUEST = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f]);

const MB = 1024 * 1024;

function check(id, title_fa, label, status, value, detail_fa, owner_action_fa) {
  const c = { id, title_fa, label, status, value: value === undefined ? null : value, detail_fa: detail_fa || '' };
  if (owner_action_fa) c.owner_action_fa = owner_action_fa;
  return c;
}

/* ── نسخهٔ Node ───────────────────────────────────────────────────── */
export function parseVersion(v) {
  const m = String(v || '').replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export function cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; }
  return 0;
}
export function checkNodeVersion(version) {
  const v = parseVersion(version);
  if (!v) return check('node_version', 'نسخهٔ Node', '?', 'unknown', String(version || ''), 'نسخه خوانده نشد');
  const ok = cmpVersion(v, NODE_MIN) >= 0;
  return check('node_version', 'نسخهٔ Node', 'M', ok ? 'pass' : 'fail', v.join('.'),
    ok ? 'برنامه Node ≥ 22.5 می‌خواهد و این هاست دارد.' : 'برنامه Node ≥ 22.5 می‌خواهد (node:sqlite)؛ این نسخه کافی نیست.',
    ok ? '' : 'در پنل هاست نسخهٔ Node را روی 22 (یا بالاتر) بگذارید؛ اگر گزینه نیست، همین را گزارش کنید.');
}
export async function checkNodeSqlite(importer, flagRunner) {
  const imp = importer || (() => import('node:sqlite'));
  try {
    const m = await imp();
    const ok = !!(m && (m.DatabaseSync || (m.default && m.default.DatabaseSync)));
    return check('node_sqlite', 'ماژول node:sqlite', 'M', ok ? 'pass' : 'fail', { available: ok, needs_flag: false }, ok ? 'در دسترس است.' : 'ماژول بارگذاری شد ولی DatabaseSync ندارد.');
  } catch (e) {
    /* Node 22.5–22.12: فقط با پرچم --experimental-sqlite (دستور شروع برنامه همین پرچم را دارد) */
    const run = flagRunner || (() => execFileSync(process.execPath, ['--experimental-sqlite', '-e', "require('node:sqlite').DatabaseSync||process.exit(3)"], { timeout: 8000, stdio: 'ignore' }));
    try {
      run();
      return check('node_sqlite', 'ماژول node:sqlite', 'M', 'pass', { available: true, needs_flag: true }, 'با پرچم --experimental-sqlite در دسترس است (دستور شروع برنامه همین پرچم را دارد).');
    } catch (_) {
      return check('node_sqlite', 'ماژول node:sqlite', 'M', 'fail', { available: false }, 'در دسترس نیست: ' + String(e && e.code || e && e.message || e).slice(0, 120),
        'نسخهٔ Node را به 22.5 یا بالاتر ارتقا دهید.');
    }
  }
}

/* ── منابع ────────────────────────────────────────────────────────── */
function readText(p) { try { return fs.readFileSync(p, 'utf8').trim(); } catch (_) { return null; } }
export function cgroupLimits(read) {
  const r = read || readText;
  const out = { cpu_quota: null, memory_limit_bytes: null };
  const cpuMax = r('/sys/fs/cgroup/cpu.max');
  if (cpuMax) { const [q, p] = cpuMax.split(/\s+/); if (q !== 'max' && Number(p) > 0) out.cpu_quota = Number(q) / Number(p); }
  else {
    const q = Number(r('/sys/fs/cgroup/cpu/cpu.cfs_quota_us')); const p = Number(r('/sys/fs/cgroup/cpu/cpu.cfs_period_us'));
    if (q > 0 && p > 0) out.cpu_quota = q / p;
  }
  const memMax = r('/sys/fs/cgroup/memory.max') || r('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  if (memMax && memMax !== 'max') { const n = Number(memMax); if (n > 0 && n < 2 ** 60) out.memory_limit_bytes = n; }
  return out;
}
export function checkCpu(cpus, quota) {
  const n = Array.isArray(cpus) ? cpus.length : 0;
  const eff = quota ? Math.min(n || quota, quota) : n;
  if (!eff) return check('cpu', 'پردازنده', '?', 'unknown', null, 'تعداد هسته خوانده نشد');
  return check('cpu', 'پردازنده', 'M', eff >= 1 ? 'pass' : 'warn',
    { cores_visible: n, cgroup_quota: quota || null, effective: Math.round(eff * 100) / 100, model: n ? String(cpus[0].model || '').slice(0, 60) : null },
    eff >= 1 ? 'حداقل یک هستهٔ مؤثر.' : 'کمتر از یک هستهٔ کامل سهمیه دارد؛ زیر بار کند می‌شود.');
}
export function checkMemory(totalBytes, freeBytes, limitBytes) {
  const eff = limitBytes ? Math.min(totalBytes, limitBytes) : totalBytes;
  if (!eff) return check('memory', 'حافظه', '?', 'unknown', null, 'حافظه خوانده نشد');
  const mb = Math.round(eff / MB);
  const status = mb >= 512 ? 'pass' : mb >= 256 ? 'warn' : 'fail';
  return check('memory', 'حافظه', 'M', status,
    { effective_mb: mb, host_total_mb: Math.round(totalBytes / MB), host_free_mb: Math.round(freeBytes / MB), cgroup_limit_mb: limitBytes ? Math.round(limitBytes / MB) : null },
    status === 'pass' ? 'حداقل ۵۱۲ مگابایت.' : status === 'warn' ? 'بین ۲۵۶ تا ۵۱۲ مگابایت؛ فقط برای آزمایش.' : 'کمتر از ۲۵۶ مگابایت؛ Gateway پایدار نمی‌ماند.');
}
export function diskFree(dir, deps) {
  const d = deps || {};
  const statfs = d.statfs !== undefined ? d.statfs : (fs.statfsSync ? fs.statfsSync : null);
  try {
    if (statfs) { const s = statfs(dir); return { free_bytes: Number(s.bavail) * Number(s.bsize), total_bytes: Number(s.blocks) * Number(s.bsize), via: 'statfs' }; }
  } catch (_) { /* fall through */ }
  try {
    const run = d.exec || ((cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }));
    const lines = String(run('df', ['-Pk', dir])).trim().split('\n');
    const f = lines[lines.length - 1].split(/\s+/);
    return { free_bytes: Number(f[3]) * 1024, total_bytes: Number(f[1]) * 1024, via: 'df' };
  } catch (_) { return null; }
}
export function checkDiskFree(info) {
  if (!info || !(info.free_bytes >= 0)) return check('disk_free', 'فضای دیسک', '?', 'unknown', null, 'فضای آزاد خوانده نشد', 'فضای دیسک پلن را از پنل هاست بخوانید.');
  const mb = Math.round(info.free_bytes / MB);
  const status = mb >= 1024 ? 'pass' : mb >= 200 ? 'warn' : 'fail';
  return check('disk_free', 'فضای دیسک', 'M', status, { free_mb: mb, total_mb: Math.round(info.total_bytes / MB), via: info.via },
    status === 'pass' ? 'حداقل ۱ گیگابایت آزاد.' : status === 'warn' ? 'کمتر از ۱ گیگابایت؛ برای داده و بکاپ محلی کم است.' : 'کمتر از ۲۰۰ مگابایت.');
}

/* ── ماندگاری دیسک (نشانگر روی دیسک + شناسهٔ بوت) ───────────────────── */
export function bootId(read) {
  const b = (read || readText)('/proc/sys/kernel/random/boot_id');
  if (b) return b;
  return 'up-' + Math.round((Date.now() - os.uptime() * 1000) / 60000);
}
export function checkPersistence(dataDir, ctx) {
  const c = ctx || {};
  const now = c.now || Date.now();
  const boot = c.bootId || bootId();
  const pid = c.pid || process.pid;
  const dir = path.join(dataDir, '.payesh-probe');
  const file = path.join(dir, 'marker.json');
  const tmpLike = (c.isTmp || (d => /^(\/tmp|\/var\/tmp|\/dev\/shm)(\/|$)/.test(d)))(path.resolve(dataDir));
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { prev = null; }
  const runs = (prev && Array.isArray(prev.runs) ? prev.runs : []).slice(-50);
  const value = { data_dir_is_tmp: tmpLike, previous_runs: runs.length };
  try {
    fs.mkdirSync(dir, { recursive: true });
    runs.push({ at: new Date(now).toISOString(), boot_id_hash: hash8(boot), pid });
    fs.writeFileSync(file, JSON.stringify({ schema: SCHEMA + '#marker', first_seen: (prev && prev.first_seen) || new Date(now).toISOString(), runs }, null, 1));
  } catch (e) {
    return check('disk_persistence', 'ماندگاری دیسک پس از ری‌استارت', 'M', 'fail', value, 'روی پوشهٔ داده نمی‌شود نوشت: ' + String(e.code || e.message),
      'در پنل هاست یک پوشهٔ ماندگار (Persistent storage) بسازید و PAYESH_DATA را به آن بدهید.');
  }
  if (tmpLike) return check('disk_persistence', 'ماندگاری دیسک پس از ری‌استارت', 'M', 'fail', value, 'پوشهٔ داده زیر /tmp است و با ری‌استارت پاک می‌شود.', 'PAYESH_DATA را به مسیر ماندگار ببرید.');
  const older = runs.slice(0, -1);
  if (!older.length) {
    return check('disk_persistence', 'ماندگاری دیسک پس از ری‌استارت', '?', 'unknown', value, 'اجرای نخست: نشانگر نوشته شد. هنوز ری‌استارتی دیده نشده.',
      'اپ (و اگر می‌شود خود هاست) را ری‌استارت کنید و دوباره پروب را اجرا کنید؛ اگر نشانگر مانده باشد این مورد [M] سبز می‌شود.');
  }
  const bh = hash8(boot);
  const rebooted = older.some(r => r.boot_id_hash !== bh);
  const restarted = older.some(r => r.pid !== pid);
  value.survived = rebooted ? 'host_reboot' : restarted ? 'process_restart' : 'same_process';
  if (rebooted) return check('disk_persistence', 'ماندگاری دیسک پس از ری‌استارت', 'M', 'pass', value, 'نشانگر پس از ری‌بوت هاست باقی ماند.');
  if (restarted) {
    return check('disk_persistence', 'ماندگاری دیسک پس از ری‌استارت', 'M', 'warn', value,
      'نشانگر در اجرای بعدی (فرایند تازه) باقی ماند؛ ری‌بوت خود هاست یا استقرار مجدد هنوز دیده نشده.',
      'از پنل اپ را «Restart/Redeploy» کنید (و اگر می‌شود سرور را ری‌بوت کنید) و دوباره اجرا کنید؛ سبز فقط پس از ری‌بوت دیده‌شده.');
  }
  return check('disk_persistence', 'ماندگاری دیسک پس از ری‌استارت', '?', 'unknown', value, 'همان فرایند؛ ری‌استارتی بین دو اجرا رخ نداده.', 'اپ را ری‌استارت کنید و دوباره اجرا کنید.');
}

/* ── همیشه‌روشن بودن (ضربان هر ۶۰ ثانیه در حالت serve) ─────────────── */
export const HEARTBEAT_MS = 60000;
export const MIN_OBSERVE_MS = 30 * 60000;
export const GAP_MS = 3 * HEARTBEAT_MS;
export function analyzeHeartbeats(stamps, now, procUptimeSec, hostUptimeSec) {
  const t = (stamps || []).map(Number).filter(n => n > 0).sort((a, b) => a - b);
  const value = { samples: t.length, observed_minutes: 0, gaps: 0, longest_gap_minutes: 0, process_uptime_min: Math.round((procUptimeSec || 0) / 60), host_uptime_min: Math.round((hostUptimeSec || 0) / 60) };
  if (t.length < 2 || (t[t.length - 1] - t[0]) < MIN_OBSERVE_MS) {
    value.observed_minutes = t.length > 1 ? Math.round((t[t.length - 1] - t[0]) / 60000) : 0;
    return check('always_on', 'همیشه‌روشن (خواب پس از بی‌کاری)', '?', 'unknown', value, 'کمتر از ۳۰ دقیقه ضربان ثبت شده؛ قضاوت ممکن نیست.',
      'پروب را در حالت --serve روی هاست نگه دارید (ترجیحاً ۲۴ ساعت، بدون باز کردن صفحه) و سپس /probe.json را باز کنید.');
  }
  let longest = 0; let gaps = 0;
  for (let i = 1; i < t.length; i++) { const g = t[i] - t[i - 1]; if (g > GAP_MS) { gaps++; } if (g > longest) longest = g; }
  const tail = now - t[t.length - 1]; if (tail > GAP_MS) { gaps++; if (tail > longest) longest = tail; }
  value.observed_minutes = Math.round((t[t.length - 1] - t[0]) / 60000);
  value.gaps = gaps; value.longest_gap_minutes = Math.round(longest / 60000);
  if (gaps) {
    return check('always_on', 'همیشه‌روشن (خواب پس از بی‌کاری)', 'M', 'fail', value,
      'فرایند در ' + gaps + ' بازه اجرا نمی‌شد (طولانی‌ترین ' + value.longest_gap_minutes + ' دقیقه) — هاست بعد از بی‌کاری می‌خواباند یا ری‌استارت می‌کند.',
      'در پنل دنبال «Always On / همیشه روشن» بگردید؛ بدون آن Gateway برای اعلان و همگام‌سازی قابل اتکا نیست.');
  }
  return check('always_on', 'همیشه‌روشن (خواب پس از بی‌کاری)', 'M', 'pass', value, 'در ' + value.observed_minutes + ' دقیقه مشاهده، هیچ وقفه‌ای بیش از ۳ دقیقه دیده نشد.');
}
export function readHeartbeats(dataDir) {
  const t = readText(path.join(dataDir, '.payesh-probe', 'heartbeat.log'));
  return t ? t.split('\n').map(Number).filter(n => n > 0) : [];
}
export function appendHeartbeat(dataDir, now) {
  const dir = path.join(dataDir, '.payesh-probe'); const f = path.join(dir, 'heartbeat.log');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(f, String(now || Date.now()) + '\n');
  const lines = readHeartbeats(dataDir); if (lines.length > 20000) fs.writeFileSync(f, lines.slice(-10000).join('\n') + '\n');
}

/* ── پورت و HTTPS ─────────────────────────────────────────────────── */
export function checkPort(env, listening) {
  const p = env && env.PORT;
  if (listening) return check('port', 'پورت ورودی', 'M', 'pass', { env_port_set: !!p, listening_port: listening }, 'پروب روی پورتی که هاست داد گوش داد و درخواست گرفت.');
  if (p) return check('port', 'پورت ورودی', 'M', 'pass', { env_port_set: true, env_port: String(p).replace(/[^0-9]/g, '').slice(0, 6) }, 'هاست متغیر PORT را می‌دهد.');
  return check('port', 'پورت ورودی', '?', 'unknown', { env_port_set: false }, 'متغیر PORT تعریف نشده (اجرای ترمینالی).', 'پروب را با --serve به‌عنوان اپ Node در پنل اجرا کنید.');
}
export function cloudflareSignals(headers) {
  const h = headers || {}; const sig = [];
  const get = k => { const v = h[k] !== undefined ? h[k] : h[k.toLowerCase()]; return v === undefined ? '' : String(v); };
  if (get('cf-ray')) sig.push('cf-ray');
  if (/cloudflare/i.test(get('server'))) sig.push('server:cloudflare');
  if (get('cf-cache-status')) sig.push('cf-cache-status');
  if (get('cf-connecting-ip')) sig.push('cf-connecting-ip');
  return sig;
}
export function checkHttps(input) {
  const i = input || {};
  const cf = cloudflareSignals(i.headers);
  if (cf.length) {
    return check('https', 'HTTPS عمومی', 'M', 'fail', { cloudflare_signals: cf }, 'نشانهٔ Cloudflare دیده شد؛ طبق بند ۱۳ و D‑09 ممنوع است.', 'Cloudflare را از مسیر دامنه/هاست حذف کنید.');
  }
  if (i.via === 'request') {
    const ok = i.forwardedProto === 'https' || i.encrypted === true;
    return check('https', 'HTTPS عمومی', 'M', ok ? 'pass' : 'fail', { observed_proto: ok ? 'https' : 'http' },
      ok ? 'این صفحه از راه HTTPS باز شد.' : 'این صفحه با http باز شد؛ HTTPS فعال نیست یا تحمیل نمی‌شود.',
      ok ? '' : 'در پنل هاست گواهی SSL (مثلاً Let’s Encrypt رایگان) را فعال و «Force HTTPS» را روشن کنید، سپس صفحه را با https باز کنید.');
  }
  if (i.via === 'public_url') {
    if (i.error) return check('https', 'HTTPS عمومی', 'M', 'fail', { error: i.error }, 'اتصال HTTPS به آدرس عمومی ناموفق بود.');
    const ok = i.authorized === true && i.status > 0;
    return check('https', 'HTTPS عمومی', 'M', ok ? 'pass' : 'fail', { http_status: i.status, cert_valid: i.authorized === true, tls_protocol: i.protocol || null, cert_valid_to: i.validTo || null },
      ok ? 'گواهی معتبر است و آدرس پاسخ داد.' : 'گواهی TLS معتبر نیست (یا پاسخی نیامد).');
  }
  return check('https', 'HTTPS عمومی', '?', 'unknown', null, 'NOT-RUN: نه آدرس عمومی داده شد نه پروب از مرورگر باز شد.', 'یا با --public-url https://… اجرا کنید یا حالت --serve را از راه https باز کنید.');
}

/* ── پروب PostgreSQL: فقط SSLRequest + دست‌دهی TLS ─────────────────── */
export function parsePgTarget(s) {
  if (!s) return null;
  let str = String(s).trim();
  let port = 5432;
  const m = str.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:?#]+)(?::(\d+))?/i); // userinfo دور ریخته می‌شود
  if (m) return { host: m[1], port: m[2] ? Number(m[2]) : 5432 };
  str = str.replace(/^.*@/, '');
  const hp = str.match(/^\[?([^\]\s/]+?)\]?(?::(\d+))?$/);
  if (!hp) return null;
  if (hp[2]) port = Number(hp[2]);
  return { host: hp[1], port };
}
export function pgTlsProbe(target, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 8000;
  return new Promise(resolve => {
    const t0 = Date.now();
    let done = false; let sock = null; let tsock = null;
    const finish = r => { if (done) return; done = true; clearTimeout(timer); try { if (tsock) tsock.destroy(); } catch (_) {} try { if (sock) sock.destroy(); } catch (_) {} r.ms = Date.now() - t0; resolve(r); };
    const timer = setTimeout(() => finish({ stage: 'timeout', ok: false }), timeoutMs);
    sock = net.connect({ host: target.host, port: target.port });
    sock.once('error', e => finish({ stage: 'tcp', ok: false, error: String(e.code || e.message) }));
    sock.once('connect', () => {
      sock.write(PG_SSL_REQUEST);
      sock.once('data', buf => {
        const b = String.fromCharCode(buf[0]);
        if (b === 'N') return finish({ stage: 'ssl_refused', ok: false });
        if (b !== 'S') return finish({ stage: 'not_postgres', ok: false });
        sock.removeAllListeners('error');
        tsock = tls.connect({ socket: sock, servername: net.isIP(target.host) ? undefined : target.host, rejectUnauthorized: false, ca: o.ca });
        tsock.once('error', e => finish({ stage: 'tls', ok: false, error: String(e.code || e.message) }));
        tsock.once('secureConnect', () => {
          const cert = tsock.getPeerCertificate() || {};
          finish({ stage: 'tls_ok', ok: true, protocol: tsock.getProtocol(), authorized: tsock.authorized === true, auth_error: tsock.authorizationError ? String(tsock.authorizationError) : null, cert_valid_to: cert.valid_to || null });
        });
      });
    });
  });
}
export function checkOutboundPg(target, result) {
  if (!target) {
    return check('outbound_tls_pg', 'دسترسی خروجی TLS به PostgreSQL بیرونی', '?', 'unknown', null, 'NOT-RUN: نشانی میزبان PostgreSQL داده نشد.',
      'فقط «نام میزبان» پایگاه داده (بدون رمز) را با --pg-host بدهید؛ مثلاً --pg-host db.example.com:5432');
  }
  const value = { host_hash: hash8(target.host), port: target.port, stage: result.stage, ms: result.ms, tls_protocol: result.protocol || null, cert_chain_valid: result.authorized === true };
  if (result.ok) {
    return check('outbound_tls_pg', 'دسترسی خروجی TLS به PostgreSQL بیرونی', 'M', result.authorized ? 'pass' : 'warn', value,
      result.authorized ? 'از این هاست دست‌دهی TLS با PostgreSQL انجام شد (بدون ارسال اعتبارنامه).' : 'TLS برقرار شد ولی زنجیرهٔ گواهی با CAهای Node تأیید نشد (' + (result.auth_error || '') + ').');
  }
  const why = { tcp: 'اتصال TCP برقرار نشد (' + (result.error || '') + ') — احتمالاً پورت خروجی بسته است.', timeout: 'زمان اتصال تمام شد — احتمالاً فایروال خروجی.', ssl_refused: 'سرور TLS را رد کرد.', not_postgres: 'پاسخ مقصد PostgreSQL نیست.', tls: 'دست‌دهی TLS شکست خورد (' + (result.error || '') + ').' }[result.stage] || result.stage;
  return check('outbound_tls_pg', 'دسترسی خروجی TLS به PostgreSQL بیرونی', 'M', 'fail', value, why, 'از پشتیبانی هاست بپرسید آیا اتصال خروجی به پورت 5432 مجاز است.');
}
export function tlsHandshake(host, port, timeoutMs) {
  return new Promise(resolve => {
    const t0 = Date.now(); let done = false;
    const s = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false });
    const fin = r => { if (done) return; done = true; clearTimeout(tm); try { s.destroy(); } catch (_) {} r.ms = Date.now() - t0; resolve(r); };
    const tm = setTimeout(() => fin({ ok: false, error: 'timeout' }), timeoutMs || 8000);
    s.once('error', e => fin({ ok: false, error: String(e.code || e.message) }));
    s.once('secureConnect', () => fin({ ok: true, authorized: s.authorized === true, protocol: s.getProtocol() }));
  });
}
export function checkOutboundHttps(r) {
  if (!r) return check('outbound_https', 'دسترسی خروجی HTTPS (کانال به‌روزرسانی)', '?', 'unknown', null, 'NOT-RUN (--no-network).');
  if (!r.ok) return check('outbound_https', 'دسترسی خروجی HTTPS (کانال به‌روزرسانی)', 'M', 'fail', { error: r.error, ms: r.ms }, 'اتصال خروجی TLS به github.com:443 برقرار نشد.');
  return check('outbound_https', 'دسترسی خروجی HTTPS (کانال به‌روزرسانی)', 'M', r.authorized ? 'pass' : 'warn', { ms: r.ms, tls_protocol: r.protocol, cert_chain_valid: r.authorized },
    r.authorized ? 'دست‌دهی TLS با github.com:443 موفق بود (بدون درخواست HTTP).' : 'TLS برقرار شد ولی گواهی تأیید نشد (احتمال پروکسی/بازرسی).');
}
export function tcpOpen(host, port, timeoutMs) {
  return new Promise(resolve => {
    let done = false; const s = net.connect({ host, port });
    const fin = ok => { if (done) return; done = true; clearTimeout(tm); try { s.destroy(); } catch (_) {} resolve(ok); };
    const tm = setTimeout(() => fin(false), timeoutMs || 1500);
    s.once('connect', () => fin(true)); s.once('error', () => fin(false));
  });
}
export function whichAll(names, envPath) {
  const dirs = String(envPath || '').split(path.delimiter).filter(Boolean);
  const found = {};
  for (const n of names) {
    found[n] = dirs.some(d => { try { return fs.statSync(path.join(d, n)).isFile(); } catch (_) { return false; } });
  }
  return found;
}
export function checkLocalPostgres(portOpen, bins) {
  const value = { localhost_5432_open: portOpen, binaries: bins };
  if (portOpen) return check('local_postgres', 'PostgreSQL روی خود هاست', 'M', 'pass', value, 'روی 127.0.0.1:5432 سرویسی گوش می‌دهد (چیزی فرستاده نشد).');
  if (bins.psql || bins.postgres) return check('local_postgres', 'PostgreSQL روی خود هاست', 'M', 'warn', value, 'ابزار PostgreSQL نصب است ولی سرویسی روی 5432 محلی نیست.', 'در پنل ببینید «PostgreSQL Databases» دارد یا نه.');
  return check('local_postgres', 'PostgreSQL روی خود هاست', '?', 'unknown', value, 'روی هاست PostgreSQL محلی دیده نشد (ممکن است روی میزبان جدا باشد).', 'در پنل ببینید بخش «PostgreSQL» هست یا فقط MySQL؛ نام میزبان را با --pg-host بدهید.');
}

/* ── Runtime، لاگ، بکاپ ───────────────────────────────────────────── */
export function detectRuntime(env, exists, read) {
  const e = env || {}; const ex = exists || (p => { try { fs.accessSync(p); return true; } catch (_) { return false; } });
  const r = read || readText;
  const sig = [];
  if (Object.keys(e).some(k => /^PASSENGER_/.test(k))) sig.push('passenger');
  if (ex('/usr/local/cpanel')) sig.push('cpanel');
  if (ex('/usr/local/psa')) sig.push('plesk');
  if (ex('/usr/local/directadmin')) sig.push('directadmin');
  if (ex('/.dockerenv') || /docker|kubepods|containerd/.test(r('/proc/1/cgroup') || '')) sig.push('container');
  if (e.KUBERNETES_SERVICE_HOST) sig.push('kubernetes');
  if (e.PM2_HOME || e.pm_id !== undefined) sig.push('pm2');
  if (e.INVOCATION_ID) sig.push('systemd');
  if (e.IISNODE_VERSION) sig.push('iisnode');
  const osr = r('/etc/os-release') || '';
  const pretty = (osr.match(/^PRETTY_NAME="?([^"\n]*)"?/m) || [])[1] || null;
  const value = { platform: process.platform, arch: process.arch, distro: pretty, signals: sig };
  return check('runtime', 'محیط اجرا', sig.length ? 'M' : '?', sig.length ? 'pass' : 'unknown', value,
    sig.length ? 'نوع محیط از نشانه‌ها تشخیص داده شد: ' + sig.join('، ') : 'نشانهٔ شناخته‌شده‌ای از پنل/کانتینر دیده نشد.',
    sig.length ? '' : 'نام و نوع پنل هاست (cPanel، DirectAdmin، Plesk، اختصاصی RadCloud …) را بنویسید.');
}
export function checkLogs(dataDir, stdoutKind) {
  const dir = path.join(dataDir, '.payesh-probe');
  let writable = false;
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'log-write-test'), 'ok'); writable = true; } catch (_) { writable = false; }
  const value = { stdout: stdoutKind, app_dir_log_writable: writable };
  return check('logs', 'لاگ', writable ? 'M' : '?', writable ? 'warn' : 'unknown', value,
    'نوشتن فایل لاگ در پوشهٔ داده ' + (writable ? 'ممکن است' : 'ممکن نیست') + '؛ اینکه پنل خروجی برنامه را نگه می‌دارد یا نه از داخل برنامه قابل سنجش نیست.',
    'در پنل ببینید «Logs / Error log» برای اپ Node هست و چند روز نگه داشته می‌شود.');
}
export function stdoutKind() {
  try { const s = fs.fstatSync(1); return s.isFIFO() ? 'pipe' : s.isFile() ? 'file' : s.isCharacterDevice() ? 'tty' : s.isSocket() ? 'socket' : 'other'; } catch (_) { return 'unknown'; }
}
export function checkBackup(bins) {
  const value = { pg_dump: !!bins.pg_dump, crontab: !!bins.crontab, tar: !!bins.tar };
  return check('backup', 'بکاپ', '?', 'unknown', value,
    'ابزارهای موجود روی هاست [M] فهرست شد؛ وجود بکاپ خودکار پنل و امکان بازیابی آزمایش‌شده از داخل برنامه قابل سنجش نیست (بند ۱۶).',
    'در پنل ببینید «Backup» خودکار دارد؟ هر چند وقت؟ چند نسخه؟ دانلودپذیر است؟ (بکاپ بدون بازیابی آزمایش‌شده، بکاپ نیست.)');
}

/* ── redaction ────────────────────────────────────────────────────── */
export function hash8(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8); }
const SENSITIVE_ENV = /(PASS|PWD|SECRET|TOKEN|KEY|CRED|AUTH|DATABASE_URL|PGURL|DSN|COOKIE|SESSION|PRIVATE)/i;
export function redactString(s, env) {
  let out = String(s); let hits = 0;
  const rep = (re, to) => { out = out.replace(re, function () { hits++; return typeof to === 'function' ? to.apply(null, arguments) : to; }); };
  const e = env || {};
  for (const k of Object.keys(e)) {
    const v = e[k];
    if (SENSITIVE_ENV.test(k) && typeof v === 'string' && v.length >= 4) { const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); rep(new RegExp(esc, 'g'), '***'); }
  }
  rep(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:"]+):([^\s/@"]+)@/gi, (_m, a) => a + '***:***@');
  rep(/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)(\s*[=:]\s*)([^\s&",]+)/gi, (_m, a, b) => a + b + '***');
  rep(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '***');
  rep(/\b(ghp|gho|ghs|github_pat|sk|pk|xox[bpa])_[A-Za-z0-9_]{12,}\b/g, '***');
  return { text: out, hits };
}
export function redactReport(report, env) {
  const r = redactString(JSON.stringify(report), env);
  const obj = JSON.parse(r.text);
  obj.redaction = { applied: true, hits: r.hits, rules: ['sensitive-env-values', 'url-userinfo', 'key=value', 'jwt', 'token-prefixes'] };
  return obj;
}

/* ── اجرای کامل ───────────────────────────────────────────────────── */
export function verdict(checks) {
  const by = Object.fromEntries(checks.map(c => [c.id, c]));
  const blockers = []; const unknown = [];
  for (const id of REQUIRED_FOR_GATEWAY) {
    const c = by[id]; if (!c) { unknown.push(id); continue; }
    if (c.status === 'fail') blockers.push(id); else if (c.status !== 'pass') unknown.push(id);
  }
  const pg = [by.outbound_tls_pg, by.local_postgres].filter(Boolean);
  if (pg.some(c => c.status === 'pass')) { /* یکی کافی است */ } else if (pg.length && pg.every(c => c.status === 'fail')) blockers.push('postgres_reachable'); else unknown.push('postgres_reachable');
  const state = blockers.length ? 'not_ready' : unknown.length ? 'incomplete' : 'ready';
  return { gateway_on_this_host: state, blockers, unknown, note_fa: 'این حکم فقط آمادگی فنی مرحلهٔ A را خلاصه می‌کند؛ تصمیم معماری با ردیف‌های ۱۱۶/۱۱۷/۱۲۰ و مالک است.' };
}
export async function runProbe(o) {
  const opt = o || {};
  const env = opt.env || process.env;
  const dataDir = path.resolve(opt.dataDir || env.PAYESH_DATA || path.join(process.cwd(), 'data'));
  const net_ = opt.network !== false;
  const lim = cgroupLimits(opt.read);
  const checks = [];
  checks.push(checkNodeVersion(opt.nodeVersion || process.versions.node));
  checks.push(await checkNodeSqlite(opt.sqliteImporter, opt.sqliteFlagRunner));
  checks.push(detectRuntime(env, opt.exists, opt.read));
  checks.push(checkCpu(os.cpus(), lim.cpu_quota));
  checks.push(checkMemory(os.totalmem(), os.freemem(), lim.memory_limit_bytes));
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) { /* reported by persistence */ }
  checks.push(checkDiskFree(diskFree(dataDir, opt.diskDeps)));
  checks.push(checkPersistence(dataDir, opt.persistenceCtx));
  checks.push(analyzeHeartbeats(opt.heartbeats || readHeartbeats(dataDir), opt.now || Date.now(), process.uptime(), os.uptime()));
  checks.push(checkPort(env, opt.listeningPort));
  if (opt.request) checks.push(checkHttps(Object.assign({ via: 'request' }, opt.request)));
  else if (opt.publicUrl && net_) checks.push(checkHttps(Object.assign({ via: 'public_url' }, await fetchPublic(opt.publicUrl))));
  else checks.push(checkHttps({}));
  const target = parsePgTarget(opt.pgHost || env.PAYESH_PROBE_PG_HOST);
  checks.push(checkOutboundPg(target, target && net_ ? await pgTlsProbe(target, { timeoutMs: opt.timeoutMs }) : { stage: 'not_run' }));
  if (target && !net_) checks[checks.length - 1] = checkOutboundPg(null);
  checks.push(checkOutboundHttps(net_ ? await tlsHandshake(opt.updateHost || 'github.com', 443, opt.timeoutMs) : null));
  const bins = whichAll(['psql', 'postgres', 'pg_dump', 'crontab', 'tar'], env.PATH);
  checks.push(checkLocalPostgres(net_ ? await tcpOpen('127.0.0.1', 5432) : false, bins));
  checks.push(checkLogs(dataDir, stdoutKind()));
  checks.push(checkBackup(bins));
  const report = {
    schema: SCHEMA, tool_version: TOOL_VERSION, source: 'probe', generated_at: new Date(opt.now || Date.now()).toISOString(),
    host_id_hash: hash8(os.hostname()), mode: opt.mode || 'cli',
    labels_legend_fa: { M: 'سنجیده روی همین هاست', '?': 'نامعلوم یا اجرانشده (NOT-RUN)' },
    checks, verdict: verdict(checks),
  };
  return redactReport(report, env);
}
export function fetchPublic(url) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch (_) { return resolve({ error: 'bad_url' }); }
    if (u.protocol !== 'https:') return resolve({ error: 'not_https_url' });
    const req = https.request({ method: 'HEAD', host: u.hostname, port: u.port || 443, path: '/', rejectUnauthorized: false, timeout: 8000, headers: { 'user-agent': 'PayeshHostProbe/' + TOOL_VERSION } }, res => {
      const s = res.socket; const cert = s.getPeerCertificate ? s.getPeerCertificate() : {};
      resolve({ status: res.statusCode, headers: res.headers, authorized: s.authorized === true, protocol: s.getProtocol ? s.getProtocol() : null, validTo: cert && cert.valid_to });
      res.resume();
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', e => resolve({ error: String(e.code || e.message) }));
    req.end();
  });
}

/* ── گزارش فارسی (HTML بدون اسکریپت و بدون منبع بیرونی) ──────────────── */
const esc = s => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function renderHtml(report) {
  const color = { pass: '#1b7f3b', warn: '#a66a00', fail: '#b3261e', unknown: '#555' };
  const fa = { pass: 'سبز', warn: 'هشدار', fail: 'قرمز', unknown: 'نامعلوم' };
  const rows = report.checks.map(c => `<tr><td>${esc(c.title_fa)}</td><td style="color:${color[c.status]};font-weight:bold">${fa[c.status]}</td><td>[${esc(c.label)}]</td><td>${esc(c.detail_fa)}${c.owner_action_fa ? '<br><small>کار شما: ' + esc(c.owner_action_fa) + '</small>' : ''}</td></tr>`).join('');
  return '<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">'
    + '<title>پروب هاست پایش</title><style>body{font-family:Tahoma,sans-serif;margin:16px;line-height:1.7}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px;vertical-align:top}pre{direction:ltr;text-align:left;background:#f4f4f4;padding:8px;white-space:pre-wrap;word-break:break-all}</style></head><body>'
    + `<h1>پروب هاست پایش</h1><p>حکم مرحلهٔ A: <b>${esc(report.verdict.gateway_on_this_host)}</b> — ${esc(report.verdict.note_fa)}</p>`
    + '<table><tr><th>مورد</th><th>وضعیت</th><th>برچسب</th><th>توضیح</th></tr>' + rows + '</table>'
    + '<h2>متن زیر را کامل کپی کنید و برای ما بفرستید (رازی در آن نیست)</h2><p>یا فایل <a href="probe.json">probe.json</a> را دانلود کنید.</p>'
    + '<pre>' + esc(JSON.stringify(report, null, 1)) + '</pre></body></html>';
}

/* ── حالت serve (اپ Node در پنل هاست) ──────────────────────────────── */
export function serve(o) {
  const opt = o || {};
  const env = opt.env || process.env;
  const dataDir = path.resolve(opt.dataDir || env.PAYESH_DATA || path.join(process.cwd(), 'data'));
  const key = env.PAYESH_PROBE_KEY || '';
  const ttlMs = (opt.ttlHours || 72) * 3600000; const started = Date.now();
  try { appendHeartbeat(dataDir); } catch (_) { /* reported by checks */ }
  const ticker = setInterval(() => { try { appendHeartbeat(dataDir); } catch (_) {} }, opt.heartbeatMs || HEARTBEAT_MS);
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }); res.end(body); };
    if (req.method !== 'GET') return send(405, 'text/plain; charset=utf-8', 'method not allowed');
    if (u.pathname === '/healthz') return send(200, 'text/plain; charset=utf-8', 'ok');
    if (Date.now() - started > ttlMs) return send(410, 'text/plain; charset=utf-8', 'پروب منقضی شده؛ این اپ را از پنل حذف کنید.');
    if (key && u.searchParams.get('key') !== key) return send(403, 'text/plain; charset=utf-8', 'key لازم است');
    if (u.pathname !== '/' && u.pathname !== '/probe.json') return send(404, 'text/plain; charset=utf-8', 'not found');
    const report = await runProbe(Object.assign({}, opt, { env, dataDir, mode: 'serve', listeningPort: server.address().port,
      request: { forwardedProto: String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase(), encrypted: !!req.socket.encrypted, headers: req.headers } }));
    if (u.pathname === '/probe.json') return send(200, 'application/json; charset=utf-8', JSON.stringify(report, null, 1));
    return send(200, 'text/html; charset=utf-8', renderHtml(report));
  });
  server.on('close', () => clearInterval(ticker));
  return new Promise(resolve => server.listen(opt.port !== undefined ? opt.port : Number(env.PORT || 8080), opt.bind || '0.0.0.0', () => resolve(server)));
}

/* ── CLI ──────────────────────────────────────────────────────────── */
export function parseArgs(argv) {
  const a = { network: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--serve') a.serve = true;
    else if (k === '--no-network') a.network = false;
    else if (k === '--pg-host') a.pgHost = argv[++i];
    else if (k === '--public-url') a.publicUrl = argv[++i];
    else if (k === '--data') a.dataDir = argv[++i];
    else if (k === '--port') a.port = Number(argv[++i]);
    else if (k === '--ttl-hours') a.ttlHours = Number(argv[++i]);
    else if (k === '--help' || k === '-h') a.help = true;
  }
  return a;
}
export async function main(argv) {
  const a = parseArgs(argv || []);
  if (a.help) { console.log('node host-probe.mjs [--serve] [--pg-host HOST[:PORT]] [--public-url https://...] [--data DIR] [--no-network]'); return 0; }
  if (a.serve) {
    const s = await serve(a);
    console.log('payesh host-probe listening on port ' + s.address().port + ' (open the app URL in a browser)');
    return 0;
  }
  const r = await runProbe(a);
  console.log(JSON.stringify(r, null, 1));
  return 0;
}
const isMain = (() => { try { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch (_) { return false; } })();
if (isMain) main(process.argv.slice(2)).then(c => { if (c) process.exitCode = c; }, e => { console.error(String(e && e.stack || e)); process.exitCode = 2; });
