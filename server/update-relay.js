'use strict';
/* ═══════════════════════════════════════════════════════════════════
   ردیف ۱۹۷-Q05 — رلهٔ به‌روزرسانی برنامه‌ها از راه سرور مدرسه
   ───────────────────────────────────────────────────────────────────
   یافتهٔ F26: روی دادهٔ همراه (همراه اول) HTTPS گیت‌هاب فیلتر است؛ با Lantern هم مسیر direct
   در sing-box با DNS EOF می‌افتد ⇒ برنامهٔ گوشی/ویندوز هیچ‌وقت مانیفست و APK را نمی‌گرفت، در
   حالی که همگام‌سازی با همین سرور مدرسه کار می‌کرد. حالا سرور مدرسه (که خودش به GitHub
   می‌رسد) همان فایل‌های انتشار را بایت‌به‌بایت جلو می‌گذارد:

     GET /api/update-relay/<tag>/<name>
       مانیفست‌ها:  native-continuous/app-update.json · win32-continuous/app32-update.json ·
                    owner-continuous/owner-update.json · win32-continuous/owner32-update.json
       APK:        native-continuous/payesh-native.apk · owner-continuous/payesh-owner.apk
       فایل‌ها:     app-files/<sha256>.gz · app32-files/… · owner-files/… · owner32-files/…

   قواعد:
     • فقط همین نام‌ها؛ هر چیز دیگری 404 بی‌آنکه به GitHub درخواستی برود.
     • فایل‌های تکه‌ای فقط اگر در مانیفست همان کانال باشند (درخواست هش دلخواه ⇒ 404).
     • APK فقط پس از بررسی اندازه و SHA-256 مانیفست؛ فایل‌های .gz پس از باز کردن و بررسی هش.
     • مانیفست ۲ دقیقه تازه می‌ماند؛ اگر GitHub در دسترس نبود نسخهٔ ذخیره‌شده (حداکثر ۱۴ روز)
       با سرآیند x-payesh-relay: stale داده می‌شود.
     • برنامه هم همهٔ هش‌ها را دوباره بررسی می‌کند؛ اندروید هم فقط APK با همان امضا را نصب می‌کند.
   هیچ رازی، نشستی یا داده‌ای از مدرسه در این مسیر نیست.
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

/* مانیفست هر کانال ⇒ پوشهٔ فایل‌های تکه‌ای و APK آن. نشانی‌ها کامل نوشته شده‌اند تا دروازهٔ
   ردیف ۱۶۱ (tests/direct-links-161.js) هر کدام را با فهرست بارگذاری ناشرش بسنجد. */
const LINKS = [
  { manifest: 'https://github.com/rezaa2544/payesh.local/releases/download/native-continuous/app-update.json', blobs: 'app-files', apk: 'https://github.com/rezaa2544/payesh.local/releases/download/native-continuous/payesh-native.apk' },
  { manifest: 'https://github.com/rezaa2544/payesh.local/releases/download/win32-continuous/app32-update.json', blobs: 'app32-files', apk: null },
  { manifest: 'https://github.com/rezaa2544/payesh.local/releases/download/owner-continuous/owner-update.json', blobs: 'owner-files', apk: 'https://github.com/rezaa2544/payesh.local/releases/download/owner-continuous/payesh-owner.apk' },
  { manifest: 'https://github.com/rezaa2544/payesh.local/releases/download/win32-continuous/owner32-update.json', blobs: 'owner32-files', apk: null },
];
const REL = u => u.slice(u.indexOf('/releases/download/') + '/releases/download/'.length);
/* `<tag>/<name>` نسبی به پایهٔ انتشار */
const CHANNELS = LINKS.map(l => ({ manifest: REL(l.manifest), blobs: l.blobs, apk: l.apk ? REL(l.apk) : null }));
const UPSTREAM = LINKS[0].manifest.slice(0, LINKS[0].manifest.length - CHANNELS[0].manifest.length);
const PREFIX = '/api/update-relay/';

const MANIFEST_TTL = 2 * 60_000;
const STALE_MAX = 14 * 24 * 3600_000;
const MANIFEST_MAX = 4 * 1024 * 1024;
const APK_MAX = 200 * 1024 * 1024;
const BLOB_MAX = 64 * 1024 * 1024;
const BLOB_RE = /^[a-f0-9]{64}\.gz$/;
const SHA_RE = /^[a-f0-9]{64}$/;

function create({ dataDir, fetchImpl, now = () => Date.now(), upstream = UPSTREAM } = {}) {
  const dir = path.join(dataDir, 'update-relay');
  const doFetch = fetchImpl || ((u, o) => fetch(u, o));
  const inflight = new Map();
  const stats = { manifest: 0, stale: 0, apk: 0, blob: 0, upstream: 0, rejected: 0 };

  const mkdir = d => { try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* بعداً */ } };
  const safeName = rel => rel.replace(/[^A-Za-z0-9._-]/g, '_');

  /* یک بار در هر زمان برای هر کلید (چند گوشی هم‌زمان ⇒ یک دانلود) */
  function once(key, fn) {
    const cur = inflight.get(key);
    if (cur) return cur;
    const p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  async function upstreamGet(rel, { max, timeoutMs }) {
    stats.upstream++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await doFetch(upstream + rel + (rel.endsWith('.json') ? `?t=${now()}` : ''), {
        signal: ctrl.signal,
        redirect: 'follow',
        cache: 'no-store',
        headers: { 'user-agent': 'payesh-update-relay/1' },
      });
      if (res.status === 404) { const e = new Error('upstream_404'); e.status = 404; throw e; }
      if (!res.ok) { const e = new Error('upstream_http_' + res.status); e.status = 502; throw e; }
      const len = Number(res.headers && res.headers.get ? res.headers.get('content-length') : NaN);
      if (Number.isFinite(len) && len > max) { const e = new Error('too_large'); e.status = 502; throw e; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > max) { const e = new Error('too_large'); e.status = 502; throw e; }
      return buf;
    } catch (e) {
      if (e.name === 'AbortError') { const t = new Error('upstream_timeout'); t.status = 504; throw t; }
      if (!e.status) e.status = 502;
      throw e;
    } finally { clearTimeout(timer); }
  }

  function parseManifest(buf) {
    let j;
    try { j = JSON.parse(buf.toString('utf8')); } catch (e) { return null; }
    if (!j || typeof j !== 'object' || typeof j.schema !== 'string' || !/^payesh-[a-z0-9-]+\/\d+$/.test(j.schema)) return null;
    if (!Array.isArray(j.files)) return null;
    return j;
  }

  /* مانیفست: تازه از GitHub (۲ دقیقه کش) یا نسخهٔ ذخیره‌شده اگر GitHub نرسید */
  async function manifest(rel, { force = false } = {}) {
    const file = path.join(dir, 'm', safeName(rel));
    let st = null;
    try { st = fs.statSync(file); } catch (e) { st = null; }
    const age = st ? now() - st.mtimeMs : Infinity;
    if (!force && st && age < MANIFEST_TTL) {
      const buf = fs.readFileSync(file);
      const j = parseManifest(buf);
      if (j) return { buf, json: j, stale: false };
    }
    return once('m:' + rel, async () => {
      try {
        const buf = await upstreamGet(rel, { max: MANIFEST_MAX, timeoutMs: 20_000 });
        const json = parseManifest(buf);
        if (!json) { const e = new Error('bad_manifest'); e.status = 502; throw e; }
        mkdir(path.dirname(file));
        const tmp = file + '.' + process.pid + '.tmp';
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, file);
        return { buf, json, stale: false };
      } catch (e) {
        if (st && age < STALE_MAX) {
          const buf = fs.readFileSync(file);
          const json = parseManifest(buf);
          if (json) { stats.stale++; return { buf, json, stale: true }; }
        }
        throw e;
      }
    });
  }

  function apkInfo(json) {
    const a = json.android || json.apk;
    if (!a || typeof a !== 'object' || !SHA_RE.test(String(a.sha256 || '')) || !(a.size > 0)) return null;
    return { sha256: a.sha256, size: a.size };
  }

  async function apkFile(ch) {
    const m = await manifest(ch.manifest);
    const info = apkInfo(m.json);
    if (!info) { const e = new Error('no_apk'); e.status = 404; throw e; }
    if (info.size > APK_MAX) { const e = new Error('too_large'); e.status = 502; throw e; }
    const base = path.basename(ch.apk, '.apk');
    const file = path.join(dir, 'apk', `${base}-${info.sha256}.apk`);
    if (fs.existsSync(file)) return file;
    return once('a:' + info.sha256, async () => {
      const buf = await upstreamGet(ch.apk, { max: APK_MAX, timeoutMs: 15 * 60_000 });
      const h = crypto.createHash('sha256').update(buf).digest('hex');
      if (buf.length !== info.size || h !== info.sha256) {
        stats.rejected++;
        const e = new Error('apk_hash_mismatch'); e.status = 502; throw e;
      }
      mkdir(path.dirname(file));
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);
      /* فقط آخرین APK هر برنامه */
      for (const f of fs.readdirSync(path.dirname(file))) {
        if (f.startsWith(base + '-') && f.endsWith('.apk') && path.join(path.dirname(file), f) !== file) {
          try { fs.unlinkSync(path.join(path.dirname(file), f)); } catch (e) { /* بعداً */ }
        }
      }
      return file;
    });
  }

  async function blobFile(ch, name) {
    const sha = name.slice(0, 64);
    const file = path.join(dir, 'b', name);
    if (fs.existsSync(file)) return file;
    let m = await manifest(ch.manifest);
    let listed = m.json.files.some(f => f && f.sha256 === sha);
    if (!listed && !m.stale) { m = await manifest(ch.manifest, { force: true }); listed = m.json.files.some(f => f && f.sha256 === sha); }
    if (!listed) { const e = new Error('not_listed'); e.status = 404; throw e; }
    return once('b:' + name, async () => {
      const gz = await upstreamGet(`${ch.blobs}/${name}`, { max: BLOB_MAX, timeoutMs: 5 * 60_000 });
      let raw;
      try { raw = zlib.gunzipSync(gz); } catch (e) { stats.rejected++; const x = new Error('bad_gzip'); x.status = 502; throw x; }
      if (crypto.createHash('sha256').update(raw).digest('hex') !== sha) {
        stats.rejected++;
        const e = new Error('blob_hash_mismatch'); e.status = 502; throw e;
      }
      mkdir(path.dirname(file));
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, gz);
      fs.renameSync(tmp, file);
      return file;
    });
  }

  /* فایل‌های تکه‌ای قدیمی‌تر از ۴۵ روز پاک می‌شوند (هر بار حداکثر روزی یک بار) */
  let prunedAt = 0;
  function prune() {
    if (now() - prunedAt < 24 * 3600_000) return;
    prunedAt = now();
    const d = path.join(dir, 'b');
    let names = [];
    try { names = fs.readdirSync(d); } catch (e) { return; }
    for (const f of names) {
      try {
        const p = path.join(d, f);
        if (now() - fs.statSync(p).mtimeMs > 45 * 24 * 3600_000) fs.unlinkSync(p);
      } catch (e) { /* بعداً */ }
    }
  }

  /* نام درخواست‌شده ⇒ نوع و کانال (یا null) */
  function resolve(rel) {
    for (const ch of CHANNELS) {
      if (rel === ch.manifest) return { kind: 'manifest', ch };
      if (ch.apk && rel === ch.apk) return { kind: 'apk', ch };
      if (rel.startsWith(ch.blobs + '/')) {
        const name = rel.slice(ch.blobs.length + 1);
        return BLOB_RE.test(name) ? { kind: 'blob', ch, name } : null;
      }
    }
    return null;
  }

  function sendBuf(req, res, buf, headers) {
    res.writeHead(200, Object.assign({ 'content-length': buf.length, 'x-content-type-options': 'nosniff' }, headers));
    res.end(req.method === 'HEAD' ? undefined : buf);
  }

  function sendStream(req, res, file, headers) {
    const st = fs.statSync(file);
    res.writeHead(200, Object.assign({ 'content-length': st.size, 'x-content-type-options': 'nosniff' }, headers));
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }

  function fail(res, status, error) {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error }));
  }

  /* true ⇒ پاسخ داده شد */
  async function handle(req, res, url) {
    if (!url.pathname.startsWith(PREFIX)) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') { fail(res, 405, 'method_not_allowed'); return true; }
    const rel = url.pathname.slice(PREFIX.length);
    const r = resolve(rel);
    if (!r) { fail(res, 404, 'not_found'); return true; }
    try {
      if (r.kind === 'manifest') {
        const m = await manifest(r.ch.manifest);
        stats.manifest++;
        sendBuf(req, res, m.buf, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-payesh-relay': m.stale ? 'stale' : 'fresh',
        });
      } else if (r.kind === 'apk') {
        const f = await apkFile(r.ch);
        stats.apk++;
        sendStream(req, res, f, { 'content-type': 'application/vnd.android.package-archive', 'cache-control': 'no-cache' });
      } else {
        const f = await blobFile(r.ch, r.name);
        stats.blob++;
        prune();
        sendStream(req, res, f, { 'content-type': 'application/gzip', 'cache-control': 'public, max-age=31536000, immutable' });
      }
    } catch (e) {
      fail(res, e.status || 502, String(e.message || 'relay_failed'));
    }
    return true;
  }

  return { handle, resolve, manifest, stats, dir };
}

module.exports = { create, CHANNELS, PREFIX, UPSTREAM };
