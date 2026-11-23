'use strict';
/* ═══════════════════════════════════════════════════════════════════
   پیکربندی شبکه — چون هر کاربر اینترنت خودش را دارد، سامانه باید یک
   «آدرس عمومی ثابت» داشته باشد و همه فقط از همان وارد شوند.
   ═══════════════════════════════════════════════════════════════════ */
const os = require('os');
const crypto = require('crypto');

const KEYS = {
  public_url: '',
  hub_url: '',
  hub_enabled: false,
  instance_id: '',
};

function getMeta(store, key) {
  const v = store.getMeta('cfg:' + key, null);
  return v == null ? KEYS[key] : v;
}
function setMeta(store, key, value) {
  store.setMeta('cfg:' + key, value);
  return value;
}

function normalizeUrl(raw) {
  let u = String(raw == null ? '' : raw).trim();
  if (!u) return '';
  u = u.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { new URL(u); } catch (e) { return ''; }
  return u;
}

/** آدرس عمومی رسمی (env اولویت دارد تا مدیر بتواند بدون UI هم تنظیم کند) */
function publicUrl(store) {
  const env = normalizeUrl(process.env.PAYESH_PUBLIC_URL || '');
  if (env) return env;
  return normalizeUrl(getMeta(store, 'public_url'));
}

function instanceId(store) {
  let id = getMeta(store, 'instance_id');
  if (!id) {
    id = crypto.randomBytes(8).toString('hex');
    setMeta(store, 'instance_id', id);
  }
  return id;
}

function lanUrls(port) {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] || []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(`http://${addr.address}:${port}`);
    }
  }
  return out;
}

/* ردیف ۱۷۳: پروکسی معکوسِ جدا (کانتینر درگاه HTTPS در داکر، nginx روی سیستم دیگر) از نشانی
   loopback نمی‌آید ⇒ پیش‌تر همهٔ کاربران «یک نشانی» (نشانی پروکسی) دیده می‌شدند و سقف‌های نرخ
   (ثبت‌نام ۵ در ساعت، ورود) همه را با هم می‌بست. PAYESH_TRUST_PROXY = فهرست IP/CIDR (IPv4) جدا با
   ویرگول، مثل «172.16.0.0/12,10.0.0.5». مقدار 0 = هیچ پروکسی (حتی loopback). */
function ipv4Num(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some(x => x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function proxyRules(raw) {
  const out = [];
  for (const part of String(raw || '').split(',').map(x => x.trim()).filter(Boolean)) {
    const [ip, bits] = part.split('/');
    const n = ipv4Num(ip);
    if (n !== null) {
      const b = bits === undefined ? 32 : Number(bits);
      if (Number.isInteger(b) && b >= 8 && b <= 32) out.push({ n, mask: b === 32 ? 0xFFFFFFFF : (0xFFFFFFFF << (32 - b)) >>> 0 });
    } else if (bits === undefined && /^[0-9a-f:]+$/i.test(part)) out.push({ ip6: part.toLowerCase() });
  }
  return out;
}
/** فقط وقتی درخواست از خود سیستم/تونل محلی (یا پروکسی معرفی‌شده) می‌آید به X-Forwarded-For اعتماد کن */
function knownProxy(remoteAddress, env = process.env.PAYESH_TRUST_PROXY) {
  if (env === '0') return false;
  const ip = String(remoteAddress || '').replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1' || ip === '') return true;
  if (!env || env === '1') return false;
  const n = ipv4Num(ip);
  return proxyRules(env).some(r => (r.ip6 ? r.ip6 === ip.toLowerCase() : n !== null && ((n & r.mask) >>> 0) === ((r.n & r.mask) >>> 0)));
}
/* «1» (همان معنای deploy/gateway/env-catalog.json): «پشت پروکسی خودم هستم» ⇒ هر همتای مستقیم
   پروکسی است، ولی فقط یک گام — نشانی کاربر = راست‌ترین X-Forwarded-For (نه سمت چپِ جعل‌پذیر) */
function trustProxyFor(remoteAddress) {
  const env = process.env.PAYESH_TRUST_PROXY;
  if (env === '1') return true;
  return knownProxy(remoteAddress, env);
}

function clientIp(req) {
  /* ردیف ۱۶۵: درخواستی که از تونل (درگاه ورودی عمومی) آمده — نشانی واقعی را تونل می‌گوید */
  if (req.__public) {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return (cf || xff || 'tunnel').replace(/^::ffff:/, '').slice(0, 64);
  }
  const direct = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (trustProxyFor(direct)) {
    /* ردیف ۱۷۳: پروکسی (nginx، Passenger serv00، درگاه HTTPS) نشانی را به «انتهای» X-Forwarded-For
       می‌افزاید و هرچه کاربر خودش فرستاده سمت چپ می‌ماند؛ پس از راست، اولین نشانی‌ای که خودش
       پروکسیِ مورد اعتماد نیست = کاربر واقعی. پیش‌تر سمت چپ‌ترین برداشته می‌شد ⇒ هر کس با یک
       هدر جعلی از سقف‌های نرخ (ثبت‌نام ۵ در ساعت، ورود) فرار می‌کرد (شبیه‌سازی داکر). */
    const hops = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim().replace(/^::ffff:/, '')).filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) if (i === 0 || !knownProxy(hops[i])) return hops[i].slice(0, 64);
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (real) return real;
  }
  return direct;
}

/** بررسی زندهٔ تونل: آیا آدرس عمومی همین سرور را می‌بیند؟ */
let tunnelCache = { at: 0, value: null };
async function tunnelStatus(store, { force = false } = {}) {
  const now = Date.now();
  if (!force && tunnelCache.value && now - tunnelCache.at < 30_000) return tunnelCache.value;

  const pub = publicUrl(store);
  if (!pub) {
    tunnelCache = { at: now, value: { configured: false, reachable: false } };
    return tunnelCache.value;
  }
  const started = Date.now();
  let value;
  try {
    const res = await fetch(pub + '/api/health', {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
      headers: { 'x-payesh-probe': 'tunnel' },
    });
    const j = await res.json();
    value = {
      configured: true,
      reachable: true,
      same_server: j.instance === instanceId(store),
      version: j.version || null,
      latency_ms: Date.now() - started,
      checked_at: new Date().toISOString(),
    };
  } catch (e) {
    value = {
      configured: true,
      reachable: false,
      error: String((e && e.name) === 'TimeoutError' ? 'timeout' : (e && e.message) || 'failed'),
      latency_ms: Date.now() - started,
      checked_at: new Date().toISOString(),
    };
  }
  tunnelCache = { at: now, value };
  return value;
}

module.exports = {
  publicUrl, instanceId, lanUrls, clientIp, tunnelStatus, normalizeUrl,
  getMeta, setMeta, trustProxyFor,
};
