#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   payesh-local — سرور مدرسه
   Node 22 + SQLite (node:sqlite). بدون وابستگی خارجی.
   ex: node --experimental-sqlite server/index.js
   ═══════════════════════════════════════════════════════════════════ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');

const { openStore } = require('./db');
const auth = require('./auth');
const sync = require('./sync');
const policy = require('./policy');
const { nowISO, json, normDigits, validNationalId } = require('./util');

const ROOT = path.resolve(__dirname, '..');
const CLIENT_DIR = path.join(ROOT, 'client');
const RELEASES_DIR = path.join(ROOT, 'releases');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.PAYESH_DATA || path.join(ROOT, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const store = openStore(path.join(DATA_DIR, 'payesh.sqlite'));

/* ── نسخه و آپدیت ─────────────────────────────────────────────────── */
function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(RELEASES_DIR, 'manifest.json'), 'utf8'));
  } catch (e) {
    return { version: '0.0.0', built_at: null, files: [] };
  }
}
function readHistory(version) {
  try {
    return JSON.parse(fs.readFileSync(path.join(RELEASES_DIR, 'history', version + '.json'), 'utf8'));
  } catch (e) { return null; }
}
function updateCheck(current) {
  const latest = readManifest();
  const cur = readHistory(current);
  if (cur && cur.version === latest.version) {
    return { ok: true, up_to_date: true, version: latest.version, server_time: nowISO() };
  }
  const known = new Map((cur ? cur.files : []).map(f => [f.path, f.sha256]));
  const changed = (latest.files || []).filter(f => known.get(f.path) !== f.sha256);
  const removed = [...known.keys()].filter(p => !(latest.files || []).some(f => f.path === p));
  return {
    ok: true,
    up_to_date: false,
    version: latest.version,
    built_at: latest.built_at,
    changed,
    removed,
    total_size: changed.reduce((a, f) => a + (f.size || 0), 0),
    full_size: (latest.files || []).reduce((a, f) => a + (f.size || 0), 0),
    server_time: nowISO(),
  };
}

/* ── نشست ─────────────────────────────────────────────────────────── */
function actorFrom(req) {
  const h = String(req.headers.authorization || '');
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const s = auth.verifySession(store, token);
  if (!s) return null;
  return { user: s.user, role: s.user.role, device: s.device, session: s.session };
}

/* ── محدودیت ساده نرخ (در حافظه) ───────────────────────────────────── */
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start > windowMs) { b = { start: now, n: 0 }; buckets.set(key, b); }
  b.n++;
  return b.n <= max;
}

/* ── بدنهٔ درخواست ────────────────────────────────────────────────── */
function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('bad_json')); }
    });
    req.on('error', reject);
  });
}

/* ── فایل‌های استاتیک ─────────────────────────────────────────────── */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.apk': 'application/vnd.android.package-archive', '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};

function safeJoin(base, target) {
  const p = path.normalize(path.join(base, target));
  return p.startsWith(path.normalize(base)) ? p : null;
}

function sendFile(req, res, filePath, opts = {}) {
  let st;
  try { st = fs.statSync(filePath); } catch (e) { return false; }
  if (!st.isFile()) return false;
  const ext = path.extname(filePath).toLowerCase();
  const etag = '"' + crypto.createHash('sha1')
    .update(String(st.size) + ':' + String(st.mtimeMs)).digest('hex').slice(0, 20) + '"';
  const noStore = opts.noStore || false;

  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'etag': etag,
    'cache-control': noStore ? 'no-store' : 'no-cache',
    'x-content-type-options': 'nosniff',
  };
  if (opts.download) headers['content-disposition'] = `attachment; filename="${path.basename(filePath)}"`;

  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return true; }

  const isText = /^(text\/|application\/(json|manifest))/.test(headers['content-type']);
  const accept = String(req.headers['accept-encoding'] || '');
  let body = fs.readFileSync(filePath);
  if (isText && body.length > 500) {
    if (/\bbr\b/.test(accept)) { body = zlib.brotliCompressSync(body); headers['content-encoding'] = 'br'; }
    else if (/\bgzip\b/.test(accept)) { body = zlib.gzipSync(body); headers['content-encoding'] = 'gzip'; }
  }
  headers['content-length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

/* ── تبدیل رکورد کاربر برای کلاینت ─────────────────────────────────── */
function userRow(u) {
  return {
    id: u.id, name: u.name, role: u.role, phone: u.phone, national_id: u.national_id || '',
    class_id: u.class_id || null, subject: u.subject || '', active: u.active !== false,
    position: u.position || '', created_at: u.created_at || null,
  };
}

/* ── مسیرهای API ──────────────────────────────────────────────────── */
async function api(req, res, url, ip) {
  const p = url.pathname;
  const q = url.searchParams;
  const m = req.method;

  /* سلامت — کلاینت با همین حالت سروری را تشخیص می‌دهد */
  if (p === '/api/health' && m === 'GET') {
    return json({
      ok: true, name: 'payesh-local', version: readManifest().version,
      time: nowISO(), server_time: nowISO(), uptime_s: Math.round(process.uptime()),
      setup_done: !auth.needsSetup(store), school: (store.get('schools', 1) || {}).name || null,
    });
  }

  if (p === '/api/version' && m === 'GET') {
    const mf = readManifest();
    return json({ ok: true, version: mf.version, built_at: mf.built_at, shell: mf.shell || null });
  }

  if (p === '/api/update/check' && m === 'GET') {
    return json(updateCheck(String(q.get('current') || '0.0.0')));
  }

  if (p === '/api/setup/state' && m === 'GET') {
    return json({ ok: true, needs_setup: auth.needsSetup(store), version: readManifest().version });
  }

  if (p === '/api/setup' && m === 'POST') {
    if (!rateLimit('setup:' + ip, 10, 60_000)) return json({ ok: false, error: 'rate_limited' }, 429);
    const body = await readBody(req);
    const r = auth.setup(store, body);
    if (!r.ok) return json(r, 400);
    return json(r);
  }

  if (p === '/api/auth/pair' && m === 'POST') {
    if (!rateLimit('pair:' + ip, 20, 60_000)) return json({ ok: false, error: 'rate_limited' }, 429);
    const body = await readBody(req);
    const r = auth.pair(store, body);
    if (!r.ok) return json(r, 400);
    return json(r);
  }

  if (p === '/api/auth/unlock' && m === 'POST') {
    if (!rateLimit('unlock:' + ip, 30, 60_000)) return json({ ok: false, error: 'rate_limited' }, 429);
    const body = await readBody(req);
    const r = auth.unlock(store, body);
    if (!r.ok) return json(r, 401);
    return json(r);
  }

  /* از این‌جا به بعد نیاز به نشست */
  const actor = actorFrom(req);
  if (!actor && p.startsWith('/api/')) return json({ ok: false, error: 'unauthorized' }, 401);

  if (p === '/api/me' && m === 'GET') {
    return json({ ok: true, user: userRow(actor.user), role: actor.role, device_id: actor.device ? actor.device.id : null });
  }

  if (p === '/api/auth/logout' && m === 'POST') {
    auth.logout(store, actor.session);
    return json({ ok: true });
  }

  if (p === '/api/auth/pin' && m === 'POST') {
    const body = await readBody(req);
    const r = auth.changePin(store, actor.device, body.pin);
    return json(r, r.ok ? 200 : 400);
  }

  if (p === '/api/bootstrap' && m === 'GET') {
    const school = store.get('schools', 1) || {};
    const year = store.all('school_years').find(y => y.active) || {};
    return json({
      ok: true, server_time: nowISO(),
      school: { id: 1, name: school.name, type: school.type, level: school.level, city: school.city, capabilities: school.capabilities || {} },
      year: { title: year.title || '' },
      user: userRow(actor.user), role: actor.role,
      counts: {
        users: store.count('users'), classes: store.count('classes'),
        attendance: store.count('attendance'), grades: store.count('grades'),
      },
      version: readManifest().version,
    });
  }

  if (p === '/api/v1/pull' && m === 'GET') {
    const out = sync.pull(store, actor, { since: q.get('since'), collections: q.get('collections') });
    return json(out);
  }

  if (p === '/api/sync' && m === 'POST') {
    const body = await readBody(req, 8 * 1024 * 1024);
    const out = sync.push(store, actor, body, { device_id: actor.device ? actor.device.id : null, ip });
    return json(out);
  }

  /* پروندهٔ یک دانش‌آموز با اسکوپ */
  const sm = p.match(/^\/api\/students\/(\d+)$/);
  if (sm && m === 'GET') {
    const id = Number(sm[1]);
    const scope = policy.buildScope(store, actor.user);
    if (!scope.all && !scope.studentIds.has(id)) return json({ ok: false, error: 'out_of_scope' }, 403);
    const u = store.get('users', id);
    if (!u || u.role !== 'student') return json({ ok: false, error: 'not_found' }, 404);
    return json({
      ok: true, student: userRow(u),
      attendance: store.byRef('attendance', 'ref2', id),
      grades: store.byRef('grades', 'ref2', id),
      internships: store.byRef('internships', 'ref2', id),
    });
  }

  /* ── مدیر ── */
  if (p.startsWith('/api/admin/') && actor.role !== 'manager') {
    return json({ ok: false, error: 'forbidden' }, 403);
  }

  if (p === '/api/admin/stats' && m === 'GET') {
    const today = new Date().toISOString().slice(0, 10);
    const att = store.all('attendance').filter(a => a.date === today);
    const present = att.filter(a => a.status === 'present').length;
    const students = store.count('users', " AND json_extract(data,'$.role')='student'");
    return json({
      ok: true, today, students,
      attendance_today: att.length,
      present_today: present,
      absent_today: att.filter(a => a.status === 'absent').length,
      late_today: att.filter(a => a.status === 'late').length,
      grades_pending: store.count('grades', " AND json_extract(data,'$.status')='pending'"),
      devices: store.db.prepare('SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL').get().n,
      audit: store.recentAudit(15),
      stats: store.stats(),
      version: readManifest().version,
    });
  }

  if (p === '/api/admin/pair-code' && m === 'POST') {
    const body = await readBody(req);
    const r = auth.createPairCode(store, Number(body.user_id), actor.user.id);
    return json(r, r.ok ? 200 : 400);
  }

  if (p === '/api/admin/devices' && m === 'GET') return json({ ok: true, devices: auth.listDevices(store) });

  const dm = p.match(/^\/api\/admin\/devices\/([a-f0-9]+)$/);
  if (dm && m === 'DELETE') {
    auth.revokeDevice(store, dm[1]);
    store.audit({ user_id: actor.user.id, role: 'manager', action: 'device_revoke', collection: 'devices' });
    return json({ ok: true });
  }

  if (p === '/api/admin/audit' && m === 'GET') {
    return json({ ok: true, rows: store.recentAudit(Number(q.get('limit') || 100)) });
  }

  if (p === '/api/admin/backup' && m === 'POST') {
    const file = store.backupTo(BACKUP_DIR, 48);
    return json({ ok: true, file: path.basename(file), size: fs.statSync(file).size });
  }
  if (p === '/api/admin/backups' && m === 'GET') {
    let files = [];
    try { files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.sqlite')).sort().reverse(); } catch (e) { /* noop */ }
    return json({ ok: true, files, dir: BACKUP_DIR });
  }
  const bm = p.match(/^\/api\/admin\/backups\/([A-Za-z0-9._-]+)$/);
  if (bm && m === 'GET') {
    const f = safeJoin(BACKUP_DIR, bm[1]);
    if (!f || !sendFile(req, res, f, { download: true, noStore: true })) return json({ ok: false, error: 'not_found' }, 404);
    return null;
  }

  /* ورود دسته‌ای کاربران (CSV از سمت کلاینت پارس می‌شود) */
  if (p === '/api/admin/import' && m === 'POST') {
    const body = await readBody(req, 8 * 1024 * 1024);
    return json(importUsers(body));
  }

  if (p === '/api/admin/export' && m === 'GET') {
    const collection = String(q.get('collection') || 'users');
    if (!policy.collectionAllowed(collection)) return json({ ok: false, error: 'bad_collection' }, 400);
    const rows = store.all(collection);
    return { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${collection}.csv"` }, body: toCSV(rows) };
  }

  if (p === '/api/admin/settings' && m === 'POST') {
    const body = await readBody(req);
    const s = store.get('schools', 1) || {};
    const patch = {};
    if (body.name) patch.name = String(body.name).slice(0, 80);
    if (body.city != null) patch.city = String(body.city).slice(0, 60);
    if (body.capabilities) patch.capabilities = Object.assign({}, s.capabilities || {}, body.capabilities);
    const saved = store.update('schools', 1, patch);
    return json({ ok: true, school: saved });
  }

  return json({ ok: false, error: 'not_found' }, 404);
}

/* ── ورود دسته‌ای ─────────────────────────────────────────────────── */
function importUsers(body) {
  const kind = body.kind === 'staff' ? 'staff' : 'students';
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const created = [];
  const errors = [];
  const existingNid = new Set(store.all('users').map(u => normDigits(u.national_id)).filter(Boolean));

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const name = String(r.name || r.full_name || '').trim();
    const nid = normDigits(r.national_id || r.nid || '');
    const phone = normDigits(r.phone || r.mobile || '');
    if (!name) { errors.push({ row: i + 2, error: 'missing_name' }); continue; }
    if (nid && !validNationalId(nid)) { errors.push({ row: i + 2, error: 'bad_national_id', nid }); continue; }
    if (nid && existingNid.has(nid)) { errors.push({ row: i + 2, error: 'duplicate_national_id', nid }); continue; }

    let classId = null;
    if (kind === 'students' && r.class_name) {
      const cls = store.all('classes').find(c => String(c.name).trim() === String(r.class_name).trim());
      if (cls) classId = cls.id;
      else errors.push({ row: i + 2, error: 'class_not_found', class_name: r.class_name, warning: true });
    }

    const u = store.insert('users', {
      name, role: kind === 'staff' ? (r.role || 'teacher') : 'student',
      national_id: nid, phone, class_id: classId,
      subject: String(r.subject || ''), position: String(r.position || ''),
      active: true, school_id: 1, created_at: nowISO(),
    });
    if (nid) existingNid.add(nid);
    created.push(userRow(u));

    /* اگر دانش‌آموز است و نام/تلفن ولی آمده، حساب ولی و پیوند ساخته شود */
    if (kind === 'students' && (r.parent_name || r.parent_phone)) {
      const pName = String(r.parent_name || 'ولی ' + name).trim();
      const pPhone = normDigits(r.parent_phone || '');
      let parent = store.all('users').find(u2 => u2.role === 'parent' && pPhone && normDigits(u2.phone) === pPhone);
      if (!parent) {
        parent = store.insert('users', { name: pName, role: 'parent', phone: pPhone, active: true, school_id: 1, created_at: nowISO() });
      }
      store.insert('parent_links', { parent_id: parent.id, student_id: u.id, relation: r.relation || 'father', created_at: nowISO() });
    }
  }
  store.audit({ role: 'manager', action: 'import_' + kind, collection: 'users', after: { count: created.length } });
  return { ok: true, created: created.length, errors, users: created };
}

function toCSV(rows) {
  if (!rows.length) return '\uFEFF';
  const keys = [...new Set(rows.flatMap(r => Object.keys(r).filter(k => !k.startsWith('_'))))];
  const esc = v => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s;          /* ضد تزریق فرمول */
    return '"' + s.replace(/"/g, '""') + '"';
  };
  return '\uFEFF' + [keys.join(','), ...rows.map(r => keys.map(k => esc(r[k])).join(','))].join('\n');
}

/* ── سرور ─────────────────────────────────────────────────────────── */
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  let url;
  try { url = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
  catch (e) { res.writeHead(400).end(); return; }

  /* سرآیندهای امنیتی پایه */
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'geolocation=(), microphone=(), camera=()');

  try {
    if (url.pathname.startsWith('/api/')) {
      const out = await api(req, res, url, ip);
      if (out && !res.writableEnded) {
        const body = out.body !== undefined ? out.body : JSON.stringify(out);
        const headers = Object.assign({ 'content-type': 'application/json; charset=utf-8' }, out.headers || {});
        if (out.body === undefined && !headers['content-type']) headers['content-type'] = 'application/json; charset=utf-8';
        res.writeHead(out.status || 200, headers);
        res.end(body);
      }
      return;
    }

    /* دانلودها (نصب‌کننده‌ها و APK) */
    if (url.pathname.startsWith('/downloads/')) {
      const rel = url.pathname.replace('/downloads/', '');
      const file = safeJoin(RELEASES_DIR, rel);
      if (file && sendFile(req, res, file, { download: false })) return;
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }

    /* صفحهٔ نصب */
    if (url.pathname === '/install') {
      if (sendFile(req, res, path.join(CLIENT_DIR, 'install.html'))) return;
    }

    /* لینک کارت پیوند: /join/ABCD-EFGH */
    if (url.pathname.startsWith('/join/')) {
      if (sendFile(req, res, path.join(CLIENT_DIR, 'index.html'), { noStore: true })) return;
    }

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const file = safeJoin(CLIENT_DIR, rel);
    if (file && sendFile(req, res, file, { noStore: /\.(html|js|webmanifest)$/.test(rel) })) return;

    /* SPA fallback */
    if (sendFile(req, res, path.join(CLIENT_DIR, 'index.html'), { noStore: true })) return;
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  } catch (e) {
    const code = String(e.message || e) === 'body_too_large' ? 413 : 500;
    if (code === 500) console.error('[ERR]', url.pathname, e);
    if (!res.writableEnded) res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    if (!res.writableEnded) res.end(JSON.stringify({ ok: false, error: code === 413 ? 'body_too_large' : 'server_error' }));
  } finally {
    if (process.env.PAYESH_LOG !== '0') {
      const ms = Date.now() - started;
      if (ms > 300 || url.pathname.startsWith('/api/')) {
        console.log(`${req.method} ${url.pathname} ${res.statusCode} ${ms}ms`);
      }
    }
  }
});

/* پاک‌سازی دوره‌ای + بکاپ خودکار */
setInterval(() => { try { auth.prune(store); } catch (e) { /* noop */ } }, 60 * 60 * 1000).unref();
if (process.env.PAYESH_AUTO_BACKUP !== '0') {
  setInterval(() => {
    try { store.backupTo(BACKUP_DIR, 48); } catch (e) { console.error('[backup]', e.message); }
  }, 60 * 60 * 1000).unref();
  try { store.backupTo(BACKUP_DIR, 48); } catch (e) { /* noop */ }
}

function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  const ips = lanAddresses();
  const mf = readManifest();
  console.log('');
  console.log('  پایش-لوکال  ·  نسخهٔ ' + mf.version);
  console.log('  ─────────────────────────────────────────');
  console.log('  آدرس روی همین سیستم : http://localhost:' + PORT);
  ips.forEach(ip => console.log('  آدرس در شبکهٔ مدرسه : http://' + ip + ':' + PORT));
  console.log('  داده               : ' + path.join(DATA_DIR, 'payesh.sqlite'));
  console.log('  بکاپ               : ' + BACKUP_DIR);
  console.log('  راه‌اندازی         : ' + (auth.needsSetup(store) ? 'انجام نشده — از مرورگر اول را انجام دهید' : 'انجام شده'));
  console.log('');
});

process.on('SIGINT', () => { store.close(); process.exit(0); });
process.on('SIGTERM', () => { store.close(); process.exit(0); });
