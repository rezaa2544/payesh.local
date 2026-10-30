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

function hubConfig(store) {
  return {
    url: normalizeUrl(process.env.PAYESH_HUB_URL || getMeta(store, 'hub_url')),
    enabled: process.env.PAYESH_HUB_ENABLED === '1' || !!getMeta(store, 'hub_enabled'),
  };
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

/** فقط وقتی درخواست از خود سیستم/تونل محلی می‌آید به X-Forwarded-For اعتماد کن */
function trustProxyFor(remoteAddress) {
  if (process.env.PAYESH_TRUST_PROXY === '0') return false;
  const ip = String(remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '';
}

function clientIp(req) {
  const direct = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (trustProxyFor(direct)) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff.replace(/^::ffff:/, '');
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
  publicUrl, hubConfig, instanceId, lanUrls, clientIp, tunnelStatus, normalizeUrl,
  getMeta, setMeta, trustProxyFor,
};
