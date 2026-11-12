'use strict';
/* ═══════════════════════════════════════════════════════════════════
   پیروی سرور مدرسه از «دیتابیس» پنل مالک — بدون اینکه کلیدی به گوشی/رایانهٔ کاربران برسد.

   پنل مالک هر بار که دیتابیس را ذخیره می‌کند، در صندوقچهٔ فعلی (و صندوقچهٔ قبلی، اگر عوض
   شده باشد) فایل <prefix>control/cloud.json را می‌نویسد. محتوای آن (آدرس، صندوقچه، کلیدها)
   با AES-256-GCM و کلیدی که از Secret Key همان صندوقچه (HKDF-SHA256) ساخته می‌شود مهر
   شده است؛ یعنی فقط کسی که همین حالا به آن صندوقچه دسترسی دارد (سرورهای مدرسه) می‌تواند
   بازش کند. کاربران هیچ‌وقت کلید نمی‌گیرند: برنامه‌هایشان با سرور مدرسه کار می‌کنند و سرور
   همه‌چیز را در صندوقچه می‌نویسد (live.js / outbox.js / بکاپ).

   این ماژول هر دقیقه همان فایل را می‌خواند؛ اگر نسخه (rev) تازه‌تر بود، اتصال تازه را
   می‌آزماید، تنظیم سرور را عوض می‌کند و در صندوقچهٔ تازه «رسید» می‌گذارد:
   <prefix>control/ack/<server_id>.json — پنل مالک از روی همین رسیدها نشان می‌دهد کدام
   سرورها پیرو شده‌اند. اگر اتصال تازه کار نکند، سرور روی همان قبلی می‌ماند و رسید خطا
   را در صندوقچهٔ قبلی می‌نویسد.

   قالب و بردار آزمون: docs/cloud/contracts/cloud-control-vectors.json (همان را
   apps/payesh/owner/lib/src/local/cloud_control.dart هم بازتولید می‌کند).
   ═══════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const os = require('os');
const s3mem = require('./s3mem');

const KIND = 'payesh-cloud-control';
const CONTROL_KEY = 'control/cloud.json';
const ACK_DIR = 'control/ack/';
const SALT = Buffer.from('payesh/cloud-control', 'utf8');
const INFO = Buffer.from('v1', 'utf8');
const INTERVAL_MS = 60_000;
const HEARTBEAT_MS = 6 * 60 * 60_000;
const META_REV = 'cloud:control_rev';
const META_ID = 'cloud:server_id';
const META_ACK_AT = 'cloud:control_ack_at';

class ControlError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
function unb64u(s, len) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) throw new ControlError('bad_format');
  const b = Buffer.from(s, 'base64url');
  if (b64u(b) !== s || (len != null && b.length !== len)) throw new ControlError('bad_format');
  return b;
}

function keyFor(secret) {
  if (typeof secret !== 'string' || !secret) throw new ControlError('no_key');
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), SALT, INFO, 32));
}
const aadFor = (rev) => Buffer.from(KIND + '/v1/' + rev, 'utf8');

/* آدرس: فقط https (و http فقط روی همین رایانه، برای آزمون‌ها) */
function endpointOk(e) {
  try {
    const u = new URL(e);
    if (u.username || u.password || u.search || u.hash) return false;
    if (u.pathname && u.pathname !== '/') return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]');
  } catch (e2) { return false; }
}
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const KEY_RE = /^[^\s]{3,256}$/;

/* محتوای بازشده را می‌سنجد و به شکل تنظیم s3mem برمی‌گرداند */
function validConfig(plain) {
  if (!plain || typeof plain !== 'object' || plain.v !== 1) throw new ControlError('bad_config');
  const c = {
    endpoint: String(plain.endpoint || '').replace(/\/+$/, ''),
    region: String(plain.region || ''),
    bucket: String(plain.bucket || ''),
    prefix: String(plain.prefix || 'payesh/'),
    pathStyle: true,
    accessKey: String(plain.accessKey || ''),
    secret: String(plain.secret || ''),
  };
  if (!endpointOk(c.endpoint) || !BUCKET_RE.test(c.bucket) || !KEY_RE.test(c.accessKey) || !KEY_RE.test(c.secret)) {
    throw new ControlError('bad_config');
  }
  if (c.region && !/^[a-z0-9-]{2,40}$/.test(c.region)) throw new ControlError('bad_config');
  if (!/^[A-Za-z0-9._-]+\/$/.test(c.prefix)) throw new ControlError('bad_config');
  return c;
}

/* مهر: plainText دقیقاً همان رشتهٔ JSON است (برای بردار آزمون مشترک با Dart) */
function sealText(secret, rev, plainText, nonce) {
  const n = nonce ? Buffer.from(nonce) : crypto.randomBytes(12);
  if (n.length !== 12) throw new ControlError('bad_nonce');
  const c = crypto.createCipheriv('aes-256-gcm', keyFor(secret), n);
  c.setAAD(aadFor(rev));
  const ct = Buffer.concat([c.update(Buffer.from(plainText, 'utf8')), c.final(), c.getAuthTag()]);
  return { v: 1, kind: KIND, rev, alg: 'HKDF-SHA256/A256GCM', nonce: b64u(n), ct: b64u(ct) };
}

function seal(secret, rev, config, nonce) {
  const plain = JSON.stringify({
    v: 1, rev, endpoint: config.endpoint, region: config.region || '', bucket: config.bucket,
    prefix: config.prefix || 'payesh/', accessKey: config.accessKey, secret: config.secret,
  });
  return sealText(secret, rev, plain, nonce);
}

/* باز کردن پاکت؛ هر خطا ⇒ ControlError (بدون جزئیات رمزنگاری) */
function openText(secret, env) {
  if (!env || typeof env !== 'object' || env.v !== 1 || env.kind !== KIND || env.alg !== 'HKDF-SHA256/A256GCM') {
    throw new ControlError('bad_format');
  }
  const rev = env.rev;
  if (!Number.isSafeInteger(rev) || rev <= 0) throw new ControlError('bad_format');
  const n = unb64u(env.nonce, 12);
  const ct = unb64u(env.ct);
  if (ct.length < 17) throw new ControlError('bad_format');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', keyFor(secret), n);
    d.setAAD(aadFor(rev));
    d.setAuthTag(ct.subarray(ct.length - 16));
    return { rev, text: Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString('utf8') };
  } catch (e) {
    throw new ControlError('open_failed');
  }
}

function open(secret, env) {
  const { rev, text } = openText(secret, env);
  let plain;
  try { plain = JSON.parse(text); } catch (e) { throw new ControlError('bad_config'); }
  if (!plain || plain.rev !== rev) throw new ControlError('bad_config');
  return { rev, config: validConfig(plain) };
}

function serverId(store) {
  let id = store.getMeta(META_ID, '');
  if (!/^[a-f0-9]{16}$/.test(id || '')) {
    id = crypto.randomBytes(8).toString('hex');
    store.setMeta(META_ID, id);
  }
  return id;
}

const sameTarget = (a, b) => a.endpoint === b.endpoint && a.bucket === b.bucket && a.prefix === b.prefix &&
  a.accessKey === b.accessKey && a.secret === b.secret && (a.region || '') === (b.region || '');

async function writeAck(store, cfg, info) {
  const id = serverId(store);
  let version = null;
  try { version = require('../package.json').version; } catch (e) { /* بی‌نسخه */ }
  const body = Object.assign({
    v: 1, server_id: id, host: os.hostname().slice(0, 64), version, at: new Date().toISOString(),
    bucket: cfg.bucket, endpoint: cfg.endpoint,
  }, info);
  await s3mem.put(cfg, cfg.prefix + ACK_DIR + id + '.json', JSON.stringify(body));
  store.setMeta(META_ACK_AT, String(Date.now()));
}

let firstPoll = true;

/* یک دور: خواندن فرمان، اعمال اگر تازه است، رسید. خروجی برای لاگ/آزمون. */
async function poll(store, opts = {}) {
  const log = opts.log || (() => {});
  let cfg;
  try { cfg = await s3mem.ensureBucket(store); } catch (e) { return { state: 'not_configured' }; }
  if (!cfg || !cfg.enabled) return { state: 'not_configured' };
  const applied = Number(store.getMeta(META_REV, '0')) || 0;
  let text;
  try {
    text = await s3mem.get(cfg, cfg.prefix + CONTROL_KEY);
  } catch (e) {
    if (e && e.status === 404) return { state: 'none' };
    return { state: 'unreachable', detail: String((e && (e.detail || e.message)) || '').slice(0, 200) };
  }
  let next;
  try {
    let env;
    try { env = JSON.parse(text); } catch (e) { throw new ControlError('bad_format'); }
    next = open(cfg.secret, env);
  } catch (e) {
    return { state: 'invalid', code: e.code || 'bad_format' };
  }
  const heartbeat = async (state) => {
    const last = Number(store.getMeta(META_ACK_AT, '0')) || 0;
    if (firstPoll || opts.forceAck || Date.now() - last > HEARTBEAT_MS) {
      try { await writeAck(store, cfg, { rev: Math.max(applied, next.rev), ok: true }); } catch (e) { /* بعداً */ }
    }
    return { state, rev: next.rev };
  };
  try {
    if (next.rev <= applied) return await heartbeat('current');
    const target = s3mem.normalize(Object.assign({}, next.config));
    if (sameTarget(target, cfg)) {
      store.setMeta(META_REV, String(next.rev));
      return await heartbeat('current');
    }
    /* اتصال تازه را پیش از جابه‌جایی می‌آزماییم */
    try {
      await s3mem.list(target, { max: 1, prefix: target.prefix + 'control/' });
    } catch (e) {
      const err = String((e && e.message) || e).slice(0, 200);
      try { await writeAck(store, cfg, { rev: next.rev, ok: false, error: err }); } catch (e2) { /* بعداً */ }
      log('[cloud] تنظیم تازهٔ پنل مالک کار نکرد؛ روی قبلی می‌مانیم: ' + err);
      return { state: 'rejected', rev: next.rev, error: err };
    }
    s3mem.usingMeta(store).set(Object.assign({}, target, { source: 'owner' }));
    store.setMeta(META_REV, String(next.rev));
    try { store.audit({ role: 'system', action: 'cloud_control_apply', collection: 'meta' }); } catch (e) { /* حسابرسی اختیاری */ }
    try { await writeAck(store, target, { rev: next.rev, ok: true }); } catch (e) { /* بعداً */ }
    log('[cloud] دیتابیس طبق پنل مالک عوض شد: ' + target.bucket + ' · ' + target.endpoint);
    return { state: 'applied', rev: next.rev, bucket: target.bucket };
  } finally {
    firstPoll = false;
  }
}

let timer = null;
function start(store, { everyMs = INTERVAL_MS, log = (m) => console.log(m) } = {}) {
  if (timer) return;
  const tick = () => poll(store, { log }).catch(() => {});
  setTimeout(tick, 5000).unref();
  timer = setInterval(tick, everyMs);
  timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = {
  KIND, CONTROL_KEY, ACK_DIR, INTERVAL_MS, ControlError,
  keyFor, seal, sealText, open, openText, validConfig, poll, start, stop, serverId,
  _resetForTests() { firstPoll = true; },
};
