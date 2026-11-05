'use strict';
/* ═══════════════════════════════════════════════════════════════════
   به‌روزرسانی درجا (In-place update)
   ───────────────────────────────────────────────────────────────────
   مشکل قدیمی: برای هر تغییر باید کل بسته دوباره دانلود می‌شد.
   حالا خود برنامه، نسخهٔ منتشرشده را می‌بیند و فقط فایل‌های
   تغییرکرده را می‌گیرد:
      ۱) مانیفست دور (releases/manifest.json) خوانده می‌شود
      ۲) با مانیفست نصب‌شده روی همین سیستم مقایسه می‌شود (هش sha256)
      ۳) فقط فایل‌های متفاوت دانلود و «ابتدا در پوشهٔ موقت» ذخیره می‌شوند
      ۴) هش همه بررسی می‌شود؛ اگر یکی ناجور بود هیچ‌چیز اعمال نمی‌شود
      ۵) نسخهٔ قبلی در data/backups/update-<ver>/ نگه داشته می‌شود (بازگشت)
      ۶) فایل‌ها جای‌گذاری می‌شوند؛ اگر کد سرور عوض شده باشد راه‌اندازی مجدد
   هیچ داده‌ای (data/) لمس نمی‌شود؛ فقط کد برنامه.
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const { nowISO } = require('./util');

const REPO = 'rezaa2544/payesh.local';

/* چند آینه: اگر یکی در دسترس نبود بعدی امتحان می‌شود.
   مدیر می‌تواند از پنل، آینهٔ خودش را بگذارد (مثلاً Worker ابری خودش). */
const DEFAULT_BASES = [
  `https://raw.githubusercontent.com/${REPO}/main/`,
  `https://cdn.jsdelivr.net/gh/${REPO}@main/`,
  `https://fastly.jsdelivr.net/gh/${REPO}@main/`,
];

const CHECK_TTL = 10 * 60_000;      /* نتیجهٔ بررسی ۱۰ دقیقه معتبر است */
const FAIL_TTL = 60_000;            /* خطای شبکه را هم بیش از این تکرار نکن */
const MAX_FILE = 4 * 1024 * 1024;   /* هیچ فایل تک‌فایلی از این بزرگ‌تر نیست */
const DOWNLOAD_CONCURRENCY = 4;

/* مسیرهایی که اجازهٔ نوشتن دارند — هر چیز دیگری رد می‌شود */
const ALLOWED_PREFIX = ['client/', 'server/', 'hub/', 'docs/'];
const ALLOWED_FILE = ['package.json', 'start.bat', 'start.sh', 'README.md'];

function appRoot() {
  return process.env.PAYESH_APP_ROOT || path.resolve(__dirname, '..');
}
function releasesDir() { return path.join(appRoot(), 'releases'); }
function dataDir() { return process.env.PAYESH_DATA || path.join(appRoot(), 'data'); }
/* جای نوشتنی برای فایل‌های رابط، وقتی پوشهٔ نصب محافظت‌شده است */
function overlayDir() { return path.join(dataDir(), 'app'); }
function canWrite(target) {
  try { fs.accessSync(target, fs.constants.W_OK); return true; } catch (e) { return false; }
}
function updatesDir() { return path.join(dataDir(), 'updates'); }
function backupsDir() { return path.join(dataDir(), 'backups'); }

/* ── مانیفست نصب‌شده (روی دیسک) ────────────────────────────────────── */
function localManifest() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(releasesDir(), 'manifest.json'), 'utf8'));
    if (!Array.isArray(j.files)) j.files = [];
    return j;
  } catch (e) {
    return { version: '0.0.0', built_at: null, files: [] };
  }
}

/* ── آینه‌ها ───────────────────────────────────────────────────────── */
function bases(store) {
  const custom = String(process.env.PAYESH_UPDATE_BASE || (store && cfg.getMeta(store, 'update_base')) || '').trim();
  const list = custom ? [custom] : DEFAULT_BASES.slice();
  return list.map(b => b.replace(/\/+$/, '') + '/');
}
function sourceLabel(store) {
  const custom = String(process.env.PAYESH_UPDATE_BASE || (store && cfg.getMeta(store, 'update_base')) || '').trim();
  return custom ? 'دستی' : 'پیش‌فرض';
}

function autoCheckEnabled(store) {
  if (process.env.PAYESH_UPDATE_AUTO === '0') return false;
  const v = store ? cfg.getMeta(store, 'update_auto') : null;
  return v === null || v === undefined ? true : !!v;
}
function autoApplyEnabled(store) {
  /* پیش‌فرض روشن: کاربر می‌خواهد نسخهٔ تازه بی‌صدا نصب شود و فقط گزارش تغییرات را ببیند */
  const v = store ? cfg.getMeta(store, 'update_auto_apply') : null;
  return v === null || v === undefined ? true : !!v;
}

/* ── شبکه ─────────────────────────────────────────────────────────── */
async function get(url, { timeoutMs = 10_000, binary = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      cache: 'no-store',
      headers: { 'user-agent': 'payesh-local-updater' },
    });
    if (!res.ok) { const e = new Error('http_' + res.status); e.status = res.status; throw e; }
    if (binary) return Buffer.from(await res.arrayBuffer());
    return await res.text();
  } finally { clearTimeout(timer); }
}

function errText(e) {
  if (!e) return 'unknown';
  if (e.name === 'AbortError') return 'timeout';
  if (e.status) return 'HTTP ' + e.status;
  return String(e.message || e);
}

/* ── خواندن مانیفست دور (با کش) ───────────────────────────────────── */
let cache = { at: 0, value: null, ttl: 0 };

async function remoteManifest(store, { force = false } = {}) {
  const now = Date.now();
  if (!force && cache.value !== undefined && now - cache.at < (cache.ttl || CHECK_TTL)) {
    return Object.assign({}, cache.value, { cached: true });
  }
  const errors = [];
  for (const base of bases(store)) {
    const url = base + 'releases/manifest.json' + (force ? '?t=' + now : '');
    try {
      const txt = await get(url, { timeoutMs: 9000 });
      const j = JSON.parse(txt);
      if (!j || !j.version || !Array.isArray(j.files)) { errors.push(base + ' → مانیفست نامعتبر'); continue; }
      const value = { ok: true, base, manifest: j, errors, fetched_at: nowISO() };
      cache = { at: now, value, ttl: CHECK_TTL };
      return Object.assign({}, value, { cached: false });
    } catch (e) {
      errors.push(base.replace(/^https?:\/\//, '').split('/')[0] + ' → ' + errText(e));
    }
  }
  const value = { ok: false, base: null, manifest: null, errors, fetched_at: nowISO() };
  cache = { at: now, value, ttl: FAIL_TTL };     /* خطا را کوتاه نگه دار */
  return Object.assign({}, value, { cached: false });
}

/* ── مسیر امن ─────────────────────────────────────────────────────── */
function isUpdatable(p) {
  const rel = String(p || '').replace(/\\/g, '/');
  if (!rel || rel.includes('..') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false;
  if (!/^[A-Za-z0-9._\-\/]+$/.test(rel)) return false;
  if (ALLOWED_FILE.includes(rel)) return true;
  return ALLOWED_PREFIX.some(pre => rel.startsWith(pre) && rel.length > pre.length);
}
function isServerPath(p) {
  const rel = String(p || '');
  return rel.startsWith('server/') || rel.startsWith('hub/') || ALLOWED_FILE.includes(rel);
}
function kindOf(p) {
  const rel = String(p || '');
  if (rel.startsWith('client/')) return 'client';
  if (rel.startsWith('docs/')) return 'docs';
  return 'server';
}
function clientRel(p) { return String(p || '').replace(/^client\//, ''); }

function cmpVersion(a, b) {
  const pa = String(a || '0').split(/[.+-]/).map(Number);
  const pb = String(b || '0').split(/[.+-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/* ── نقشهٔ به‌روزرسانی ────────────────────────────────────────────── */
async function plan(store, { force = false } = {}) {
  const local = localManifest();
  const rm = await remoteManifest(store, { force });
  if (!rm.ok) {
    return {
      ok: false, available: false, error: 'source_unreachable',
      errors: rm.errors, checked_at: rm.fetched_at,
      local_version: local.version, source: sourceLabel(store),
    };
  }
  const remote = rm.manifest;
  const localMap = new Map((local.files || []).map(f => [f.path, f.sha256]));
  const remotePaths = new Set((remote.files || []).map(f => f.path));

  const changed = (remote.files || [])
    .filter(f => isUpdatable(f.path) && localMap.get(f.path) !== f.sha256)
    .map(f => ({ path: f.path, sha256: f.sha256, size: Number(f.size) || 0, kind: kindOf(f.path) }));

  const removed = [...localMap.keys()]
    .filter(p => !remotePaths.has(p) && isUpdatable(p));

  const newer = cmpVersion(remote.version, local.version) > 0;
  const available = changed.length > 0 || removed.length > 0 || newer;

  const client = changed.filter(f => f.kind === 'client')
    .map(f => ({ path: clientRel(f.path), sha256: f.sha256, size: f.size }));
  const server = changed.filter(f => f.kind !== 'client');
  const bytes = a => a.reduce((s, f) => s + (f.size || 0), 0);
  const restart = server.length > 0 || removed.some(isServerPath);

  return {
    ok: true,
    available,
    _manifest: remote,
    notes: remote.notes || [],
    local_version: local.version,
    remote_version: remote.version,
    built_at: remote.built_at || null,
    changed, removed, client, server,
    counts: { changed: changed.length, client: client.length, server: server.length, removed: removed.length },
    total_size: bytes(changed),
    client_size: bytes(client),
    server_size: bytes(server),
    needs_restart: restart,
    source: rm.base,
    source_kind: sourceLabel(store),
    errors: rm.errors,
    checked_at: nowISO(),
    cached: !!rm.cached,
    _manifest: remote,
  };
}

/* ── وضعیت اجرا (برای نمایش پیشرفت در پنل) ────────────────────────── */
let running = false;
let progress = { state: 'idle', version: null, done: 0, total: 0, bytes: 0, started_at: null, finished_at: null, error: null };

function status() {
  return { running, progress, last_check: lastCheck };
}

/* ── دانلود و بررسی هش ────────────────────────────────────────────── */
async function downloadOne(base, file, stageRoot) {
  const url = base + file.path;
  const buf = await get(url, { timeoutMs: 20_000, binary: true });
  if (buf.length > MAX_FILE) throw new Error('too_large:' + file.path);
  if (Number(file.size) && buf.length !== Number(file.size)) throw new Error('size_mismatch:' + file.path);
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (file.sha256 && got !== file.sha256) throw new Error('hash_mismatch:' + file.path);
  const dest = path.join(stageRoot, file.path);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return buf.length;
}

async function downloadAll(base, changed, stageRoot) {
  let i = 0, done = 0, bytes = 0;
  const workers = Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, changed.length || 1) }, async () => {
    while (i < changed.length) {
      const f = changed[i++];
      const n = await downloadOne(base, f, stageRoot);
      done++; bytes += n;
      progress = Object.assign({}, progress, { done, bytes });
    }
  });
  await Promise.all(workers);
  return { done, bytes };
}

/* ── اعمال ────────────────────────────────────────────────────────── */
async function apply(store, { force = true, by = 'manager' } = {}) {
  if (running) return { ok: false, error: 'busy', progress };
  running = true;
  progress = { state: 'checking', version: null, done: 0, total: 0, bytes: 0, started_at: nowISO(), finished_at: null, error: null };
  const root = appRoot();
  let stage = null;
  try {
    const p = await plan(store, { force });
    if (!p.ok) {
      progress = Object.assign({}, progress, { state: 'error', error: 'source_unreachable', finished_at: nowISO() });
      return { ok: false, error: 'source_unreachable', errors: p.errors || [] };
    }
    if (!p.available) {
      progress = { state: 'idle', version: p.local_version, done: 0, total: 0, bytes: 0, started_at: null, finished_at: nowISO(), error: null };
      return { ok: true, applied: false, up_to_date: true, version: p.local_version };
    }
    if (!p.changed.length && !p.removed.length) {
      progress = { state: 'idle', version: p.remote_version, done: 0, total: 0, bytes: 0, started_at: null, finished_at: nowISO(), error: null };
      return { ok: true, applied: false, up_to_date: true, version: p.remote_version };
    }

    const version = p.remote_version;
    stage = path.join(updatesDir(), version);
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });

    progress = Object.assign({}, progress, { state: 'downloading', version, total: p.changed.length });
    try {
      await downloadAll(p.source, p.changed, stage);
    } catch (e) {
      /* هیچ فایلی از برنامه هنوز دست نخورده است */
      progress = Object.assign({}, progress, { state: 'error', error: errText(e), finished_at: nowISO() });
      fs.rmSync(stage, { recursive: true, force: true });
      return { ok: false, error: 'download_failed', detail: errText(e), version };
    }

    /* ── نسخهٔ فعلی را کنار بگذار (برای بازگشت) ── */
    progress = Object.assign({}, progress, { state: 'applying' });
    const backupDir = path.join(backupsDir(), 'update-' + version);
    fs.rmSync(backupDir, { recursive: true, force: true });
    fs.mkdirSync(backupDir, { recursive: true });
    const local = localManifest();
    fs.writeFileSync(path.join(backupDir, '_manifest.json'), JSON.stringify(local, null, 2));

    const touched = p.changed.map(f => f.path).concat(p.removed);
    const backedUp = [];
    for (const rel of touched) {
      const src = path.join(root, rel);
      if (!isUpdatable(rel) || !fs.existsSync(src)) continue;
      const dst = path.join(backupDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      backedUp.push(rel);
    }
    /* ── جای‌گذاری فایل‌های جدید ── */
    const written = [];
    const overlaid = [];
    const blocked = [];
    for (const f of p.changed) {
      const src = path.join(stage, f.path);
      const dst = path.join(root, f.path);
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        const tmp = dst + '.new-' + process.pid;
        fs.copyFileSync(src, tmp);
        fs.renameSync(tmp, dst);
        written.push(f.path);
        continue;
      } catch (e) {
        /* پوشهٔ نصب محافظت‌شده (مثل Program Files) → لایهٔ نوشتنی در data/app */
        if (!(e && (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EBUSY'))) throw e;
      }
      if (!isUpdatable(f.path)) throw new Error('update_not_writable');
      if (f.kind === 'client') {
        const dst2 = path.join(overlayDir(), f.path);
        fs.mkdirSync(path.dirname(dst2), { recursive: true });
        fs.copyFileSync(src, dst2);
        overlaid.push(f.path);
      } else {
        blocked.push(f.path);
      }
    }
    if (blocked.length && !written.length && !overlaid.length) {
      return { ok: false, error: 'needs_admin', detail: blocked.slice(0, 5).join(', '),
        files: blocked.length };
    }

    /* ── حذف فایل‌هایی که در نسخهٔ نو نیستند ── */
    const deleted = [];
    for (const rel of p.removed) {
      const dst = path.join(root, rel);
      try { fs.unlinkSync(dst); deleted.push(rel); } catch (e) { /* نبود */ }
    }

    /* ── مانیفست و تاریخچهٔ محلی ── */
    const remote = p._manifest || remoteManifestCache() || {};
    fs.mkdirSync(releasesDir(), { recursive: true });
    fs.writeFileSync(path.join(releasesDir(), 'manifest.json'), JSON.stringify(remote, null, 2));
    const histDir = path.join(releasesDir(), 'history');
    fs.mkdirSync(histDir, { recursive: true });
    fs.writeFileSync(path.join(histDir, version + '.json'), JSON.stringify(remote, null, 2));

    const record = {
      version, from_version: p.local_version, files: written.length + overlaid.length, removed: deleted.length,
      bytes: progress.bytes, restart: p.needs_restart, at: nowISO(), by,
      source: p.source, errors: p.errors || [], backed_up: backedUp.length,
      overlaid: overlaid.length, blocked: blocked.length,
      notes: (p._manifest && p._manifest.notes) || [],
    };
    if (store) {
      store.setMeta('update:last', record);
      store.setMeta('update:checked', { available: false, at: nowISO(), version });
      try { store.audit({ role: by, action: 'update_applied', collection: 'system', after: record }); } catch (e) { /* noop */ }
    }
    progress = { state: 'done', version, done: p.changed.length, total: p.changed.length, bytes: record.bytes, started_at: progress.started_at, finished_at: nowISO(), error: null };
    fs.rmSync(stage, { recursive: true, force: true });

    return {
      ok: true, applied: true, version, from_version: p.local_version,
      files: written.length + overlaid.length, removed: deleted.length, bytes: record.bytes,
      restart: !!p.needs_restart, source: p.source,
      overlaid: overlaid.length, blocked: blocked.length,
      notes: record.notes,
    };
  } catch (e) {
    progress = Object.assign({}, progress, { state: 'error', error: errText(e), finished_at: nowISO() });
    return { ok: false, error: 'apply_failed', detail: errText(e) };
  } finally {
    running = false;
  }
}

function remoteManifestCache() {
  return cache && cache.value && cache.value.manifest ? cache.value.manifest : null;
}

/* ── بازگشت به نسخهٔ قبلی ─────────────────────────────────────────── */
function rollback(store) {
  const last = store ? store.getMeta('update:last', null) : null;
  if (!last || !last.version) return { ok: false, error: 'nothing_to_rollback' };
  const backupDir = path.join(backupsDir(), 'update-' + last.version);
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(backupDir, '_manifest.json'), 'utf8')); }
  catch (e) { return { ok: false, error: 'backup_missing' }; }

  const root = appRoot();
  const restored = [];
  const walk = (dir, base = dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, base); continue; }
      const rel = path.relative(base, full).split(path.sep).join('/');
      if (rel === '_manifest.json' || !isUpdatable(rel)) continue;
      const dst = path.join(root, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(full, dst);
      restored.push(rel);
    }
  };
  try { walk(backupDir); } catch (e) { return { ok: false, error: 'backup_missing' }; }

  fs.writeFileSync(path.join(releasesDir(), 'manifest.json'), JSON.stringify(manifest, null, 2));
  store.setMeta('update:last', { rolled_back: true, version: last.version, to_version: manifest.version, at: nowISO(), files: restored.length });
  return { ok: true, rolled_back: true, version: manifest.version, files: restored.length, restart: true };
}

/* ── بررسی خودکار دوره‌ای ─────────────────────────────────────────── */
let timer = null;
let lastCheck = null;

async function tick(store, { onApply } = {}) {
  try {
    const p = await plan(store, { force: true });
    lastCheck = { at: nowISO(), available: !!p.available, version: p.remote_version || null, error: p.ok ? null : p.error };
    if (store) store.setMeta('update:checked', lastCheck);
    if (p.ok && p.available && autoApplyEnabled(store) && typeof onApply === 'function') {
      await onApply(p);
    }
    return p;
  } catch (e) {
    return { ok: false, available: false, error: errText(e) };
  }
}

function start(store, { onApply, everyMs = 15 * 60_000 } = {}) {
  if (timer) clearInterval(timer);
  /* اولین بررسی کمی بعد از بالا آمدن سرور (تا راه‌اندازی کند نشود) */
  setTimeout(() => { if (autoCheckEnabled(store)) tick(store, { onApply }).catch(() => {}); }, 12_000).unref?.();
  timer = setInterval(() => {
    if (!autoCheckEnabled(store)) return;
    tick(store, { onApply }).catch(() => {});
  }, everyMs);
  timer.unref?.();
  return timer;
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = {
  plan, apply, rollback, status, start, stop, tick,
  localManifest, remoteManifest, bases, appRoot,
  autoCheckEnabled, autoApplyEnabled, isUpdatable, cmpVersion,
};
