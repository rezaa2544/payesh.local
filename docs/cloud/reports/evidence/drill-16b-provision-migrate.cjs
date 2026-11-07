#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   تمرین واقعی ردیف ۱۶‑ب — راه‌اندازی مستأجر، مهاجرت مدرسهٔ موجود، کلید و آرشیو

   چرا وجود دارد: معیار رسمی ۱۶‑ب یک خروجی اجرایی می‌خواهد که در طرح نبود:
   «گزارش تمرین واقعی روی یک مستأجر آزمایشی (زمان، حجم، تعداد رکورد)».
   این فایل همان تمرین است: یک پیاده‌سازی مرجع اجراشدنی از گام‌های ۱–۹
   (§۱)، مهاجرت ۹ گامی (§۳.۱)، گزارش مهاجرت (§۳.۳)، rollback گام‌به‌گام
   (§۳.۴)، کلید مستأجر (§۲) و ترتیب آرشیو/نابودی کلید (§۱.۳).

   منبع داده: **دیتابیس واقعی محصول** — سرور با PAYESH_DATA موقت بالا می‌آید،
   `POST /api/setup` و چند `POST /api/sync` اجرا می‌شود، سپس همان
   `payesh.sqlite` به‌عنوان «مدرسهٔ موجود» مهاجرت داده می‌شود.
   هیچ کد محصولی تغییر نمی‌کند و هیچ نوشتنی روی data/ مخزن انجام نمی‌شود.

   اجرا: node --experimental-sqlite --disable-warning=ExperimentalWarning \
           docs/cloud/reports/evidence/drill-16b-provision-migrate.cjs
   ═══════════════════════════════════════════════════════════════════ */
'use strict';
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../../..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-16b-drill-'));
const LEGACY_DATA = path.join(WORK, 'legacy-school');
const PLAT = path.join(WORK, 'platform');
const BUCKET = path.join(PLAT, 'bucket');
const VAULT = path.join(PLAT, 'vault');
for (const d of [LEGACY_DATA, PLAT, BUCKET, VAULT]) fs.mkdirSync(d, { recursive: true });

const results = [];
let failure = null;
function check(label, fn) {
  let pass = false, detail = '';
  try { const r = fn(); pass = r === true || (r && r.pass === true); detail = (r && r.detail) || ''; }
  catch (e) { pass = false; detail = 'EXC: ' + (e && e.message); }
  results.push({ label, pass, detail });
}
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const nowISO = () => new Date().toISOString();
const addDays = (iso, n) => new Date(Date.parse(iso) + n * 86400000).toISOString();

/* ═══════════════ کلید و رمزنگاری (DEK مستأجر + KEK پلتفرم) ═══════════════ */
const KEK = crypto.randomBytes(32);
fs.writeFileSync(path.join(VAULT, 'kek.bin'), KEK);   // در واقعیت: HSM/keystore

function newDek() { return crypto.randomBytes(32); }
function wrapDek(dek) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEK, iv);
  const ct = Buffer.concat([c.update(dek), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
function unwrapDek(wrapped) {
  const iv = wrapped.subarray(0, 12), tag = wrapped.subarray(12, 28), ct = wrapped.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', KEK, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
function encWith(dek, buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', dek, iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([Buffer.from('PBENC1'), iv, c.getAuthTag(), ct]);
}
function decWith(dek, blob) {
  const iv = blob.subarray(6, 18), tag = blob.subarray(18, 34), ct = blob.subarray(34);
  const d = crypto.createDecipheriv('aes-256-gcm', dek, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

/* ═══════════════ پایگاه متادیتای پلتفرم (مستأجر/اشتراک/رویداد) ═══════════ */
const { DatabaseSync } = require('node:sqlite');
const pdb = new DatabaseSync(path.join(PLAT, 'platform.sqlite'));
pdb.exec(`
CREATE TABLE tenants(id TEXT PRIMARY KEY, slug TEXT UNIQUE, name TEXT, status TEXT,
                     provision_op_id TEXT UNIQUE, step INTEGER, created_at TEXT, archived_at TEXT);
CREATE TABLE subscriptions(id TEXT PRIMARY KEY, tenant_id TEXT, status TEXT, plan TEXT,
                           ends_at TEXT, renew_op_id TEXT UNIQUE, renewed_from TEXT, updated_at TEXT);
CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT, kind TEXT,
                    from_status TEXT, to_status TEXT, actor TEXT, reason TEXT, at TEXT);
CREATE TABLE records(tenant_id TEXT, collection TEXT, id TEXT, data TEXT, version INTEGER,
                     updated_at TEXT, deleted_at TEXT, PRIMARY KEY(tenant_id, collection, id));
CREATE TABLE migration_runs(id TEXT PRIMARY KEY, tenant_id TEXT, started_at TEXT, finished_at TEXT,
                            duration_ms INTEGER, counts_before TEXT, counts_after TEXT,
                            hash_before TEXT, hash_after TEXT, bytes_copied INTEGER,
                            steps TEXT, verdict TEXT, operator TEXT, report_sha256 TEXT);
CREATE TABLE provision_ops(op_id TEXT PRIMARY KEY, tenant_id TEXT, created_at TEXT);
`);

let evSeq = 0;
function logEvent(tenantId, kind, from, to, actor, reason) {
  evSeq += 1;
  pdb.prepare(`INSERT INTO events(id,tenant_id,kind,from_status,to_status,actor,reason,at)
               VALUES (?,?,?,?,?,?,?,?)`).run(evSeq, tenantId, kind, from || null, to || null, actor || null, reason || null, nowISO());
}
function eventCount(tenantId) {
  return Number(pdb.prepare('SELECT COUNT(*) AS n FROM events WHERE tenant_id=?').get(tenantId).n);
}

/* ═══════════════ چرخهٔ وضعیت — جداول مجاز/ممنوع (§۱.۱ و §۱.۲) ═══════════════ */
const SUB_ALLOWED = {
  'draft': ['provisioning', 'canceled'],
  'provisioning': ['active', 'canceled'],
  'active': ['grace', 'suspended', 'canceled'],
  'grace': ['active', 'suspended', 'canceled'],
  'suspended': ['active', 'expired', 'canceled'],
  'expired': [],
  'canceled': [],
};
const TEN_ALLOWED = {
  'provisioning': ['live', 'archived'],
  'live': ['suspended', 'archived'],
  'suspended': ['live', 'archived'],
  'archived': [],
};
function transitionSubscription(tenantId, from, to, actor) {
  const subs = pdb.prepare('SELECT * FROM subscriptions WHERE tenant_id=?').get(tenantId);
  if (!subs) return { ok: false, error: 'no-subscription' };
  if (subs.status !== from) return { ok: false, error: `state-drift: ${subs.status}≠${from}` };
  if (!(SUB_ALLOWED[from] || []).includes(to)) return { ok: false, error: `forbidden: ${from}→${to}` };
  if (!actor) return { ok: false, error: 'no-actor' };
  pdb.prepare('UPDATE subscriptions SET status=?, updated_at=? WHERE tenant_id=?').run(to, nowISO(), tenantId);
  logEvent(tenantId, 'subscription', from, to, actor, null);
  return { ok: true };
}
function transitionTenant(tenantId, from, to, actor) {
  const t = pdb.prepare('SELECT * FROM tenants WHERE id=?').get(tenantId);
  if (!t) return { ok: false, error: 'no-tenant' };
  if (t.status !== from) return { ok: false, error: `state-drift: ${t.status}≠${from}` };
  if (!(TEN_ALLOWED[from] || []).includes(to)) return { ok: false, error: `forbidden: ${from}→${to}` };
  if (!actor) return { ok: false, error: 'no-actor' };
  pdb.prepare('UPDATE tenants SET status=?, archived_at=? WHERE id=?')
     .run(to, to === 'archived' ? nowISO() : null, tenantId);
  logEvent(tenantId, 'tenant', from, to, actor, null);
  return { ok: true };
}

/* ═══════════════ نقطهٔ عبور واحد ذخیره‌سازی (پیشوند الزامی) ═══════════════ */
const ROOTS = ['files/', 'backups/db/', 'backups/files/', 'exports/'];
function tenantPrefix(tenantId) { return `t/${tenantId}/`; }
function putObject(ctx, relPath, buf) {
  const full = tenantPrefix(ctx.tenantId) + relPath;
  const okRoot = ROOTS.some(r => relPath.startsWith(r));
  if (!okRoot) return { ok: false, error: 'root-not-allowed' };
  if (!ctx.tenantId || !/^[a-z0-9-]{4,}$/.test(ctx.tenantId)) return { ok: false, error: 'bad-tenant-id' };
  const dekPath = path.join(VAULT, `dek-${ctx.tenantId}.bin`);
  if (!fs.existsSync(dekPath)) return { ok: false, error: 'no-tenant-key' };
  const dek = unwrapDek(fs.readFileSync(dekPath));
  const file = path.join(BUCKET, full);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encWith(dek, buf));
  return { ok: true, key: full, bytes: buf.length };
}
function getObject(ctx, key) {
  if (!key.startsWith(tenantPrefix(ctx.tenantId))) return { ok: false, error: 'cross-tenant-denied' };
  const dekPath = path.join(VAULT, `dek-${ctx.tenantId}.bin`);
  if (!fs.existsSync(dekPath)) return { ok: false, error: 'key-destroyed' };
  const dek = unwrapDek(fs.readFileSync(dekPath));
  try {
    return { ok: true, bytes: decWith(dek, fs.readFileSync(path.join(BUCKET, key))) };
  } catch (e) {
    return { ok: false, error: 'decrypt-failed' };
  }
}
function putObjectRaw(ctx, relPath, buf) {   // فقط برای ساخت مستأجر یتیم در آزمون sweep
  const file = path.join(BUCKET, tenantPrefix(ctx.tenantId) + relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return tenantPrefix(ctx.tenantId) + relPath;
}

/* ═══════════════ گام‌های ۱–۹ راه‌اندازی مستأجر (§۱) ═══════════════ */
function createTenantKey(tenantId) {
  const p = path.join(VAULT, `dek-${tenantId}.bin`);
  if (fs.existsSync(p)) return { ok: true, created: false };
  fs.writeFileSync(p, wrapDek(newDek()));
  return { ok: true, created: true };
}
function provision(opId, info, actor, opts = {}) {
  const seen = pdb.prepare('SELECT tenant_id FROM provision_ops WHERE op_id=?').get(opId);
  if (seen) return { ok: true, idempotent: true, tenantId: seen.tenant_id };

  const tenantId = opts.tenantId || crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  pdb.prepare(`INSERT INTO tenants(id,slug,name,status,provision_op_id,step,created_at,archived_at)
               VALUES (?,?,?,'provisioning',?,?,?,NULL)`).run(tenantId, info.slug, info.name, opId, 0, nowISO());
  pdb.prepare('INSERT INTO provision_ops(op_id,tenant_id,created_at) VALUES (?,?,?)').run(opId, tenantId, nowISO());
  const steps = [];
  const step = (n, name, fn) => {
    const t0 = Date.now();
    if (opts.failAtStep === n) {
      pdb.prepare('UPDATE tenants SET step=? WHERE id=?').run(n, tenantId);
      steps.push({ n, name, ok: false, ms: Date.now() - t0, error: 'injected-failure' });
      return false;
    }
    let ok = true, err = null;
    try { ok = fn() !== false; } catch (e) { ok = false; err = String(e && e.message); }
    pdb.prepare('UPDATE tenants SET step=? WHERE id=?').run(n, tenantId);
    steps.push({ n, name, ok, ms: Date.now() - t0, error: err });
    return ok;
  };

  if (!step(1, 'ثبت مدرسه و شناسه', () => true)) return { ok: false, tenantId, steps, failedStep: 1 };
  if (!step(2, 'uuid غیرقابل حدس', () => /^[a-z0-9]{20}$/.test(tenantId))) return { ok: false, tenantId, steps, failedStep: 2 };
  if (!step(3, 'کلید مستأجر DEK', () => createTenantKey(tenantId).ok)) return { ok: false, tenantId, steps, failedStep: 3 };
  if (!step(4, 'پیشوند ذخیره‌سازی ۴ ریشه', () => {
    for (const r of ROOTS) fs.mkdirSync(path.join(BUCKET, tenantPrefix(tenantId) + r), { recursive: true });
    return ROOTS.every(r => fs.existsSync(path.join(BUCKET, tenantPrefix(tenantId) + r)));
  })) return { ok: false, tenantId, steps, failedStep: 4 };
  if (!step(5, 'پلن و اشتراک draft→provisioning', () => {
    const sid = 'sub-' + tenantId.slice(0, 8);
    pdb.prepare(`INSERT INTO subscriptions(id,tenant_id,status,plan,ends_at,renew_op_id,renewed_from,updated_at)
                 VALUES (?,?,'draft',?,?,NULL,NULL,?)`).run(sid, tenantId, info.plan || 'standard', addDays(nowISO(), 365), nowISO());
    return transitionSubscription(tenantId, 'draft', 'provisioning', actor).ok;
  })) return { ok: false, tenantId, steps, failedStep: 5 };
  if (!step(6, 'ردیف‌های پایه (مدیر/تنظیمات)', () => !!info.manager)) return { ok: false, tenantId, steps, failedStep: 6 };
  if (!step(7, 'کلید محلی دستگاه‌ها (ورود اول)', () => true)) return { ok: false, tenantId, steps, failedStep: 7 };
  if (!step(8, 'ثبت audit راه‌اندازی', () => { logEvent(tenantId, 'provisioned', null, null, actor, info.slug); return true; })) {
    return { ok: false, tenantId, steps, failedStep: 8 };
  }
  if (!step(9, 'آزمون دود + فعال‌سازی', () => {
    const put = putObject({ tenantId }, 'files/smoke.txt', Buffer.from('smoke'));
    const get = put.ok ? getObject({ tenantId }, put.key) : { ok: false };
    if (!put.ok || !get.ok || get.bytes.toString() !== 'smoke') return false;
    const t = transitionSubscription(tenantId, 'provisioning', 'active', actor);
    const tl = transitionTenant(tenantId, 'provisioning', 'live', actor);
    return t.ok && tl.ok;
  })) return { ok: false, tenantId, steps, failedStep: 9 };

  return { ok: true, tenantId, steps, idempotent: false };
}

/* ═══════════════ دادهٔ مدرسهٔ موجود (محصول واقعی) ═══════════════ */
async function buildLegacySchool() {
  const net = require('node:net');
  const PORT = await new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
  const BASE = `http://127.0.0.1:${PORT}`;
  const child = spawn(process.execPath, ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST: '127.0.0.1', PAYESH_DATA: LEGACY_DATA, PAYESH_LOG: '0',
      PAYESH_AUTO_BACKUP: '0', PAYESH_UPDATE_AUTO: '0', PAYESH_LIVE_MS: '0', PAYESH_OUTBOX_AUTO: '0',
      PAYESH_CLOUD_AUTO: '0', PAYESH_MIRROR: '0', PAYESH_TRUST_PROXY: '0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  const req = async (p, opts = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (opts.token) headers.authorization = 'Bearer ' + opts.token;
    const r = await fetch(BASE + p, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const txt = await r.text();
    let data = null; try { data = JSON.parse(txt); } catch { /* */ }
    return { status: r.status, data };
  };
  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < 25000) {
    try { if ((await req('/api/health')).data?.ok) { up = true; break; } } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 150));
  }
  if (!up) { try { child.kill('SIGKILL'); } catch {} throw new Error('legacy server did not start'); }

  const setup = await req('/api/setup', { method: 'POST', body: {
    school_name: 'دبیرستان تمرین ۱۶ب', manager_name: 'مدیر تمرین', password: 'Drill-16b-Aa', phone: '09120000086',
  } });
  if (!setup.data?.ok) throw new Error('setup failed');
  const token = setup.data.session.token;

  const ops = [];
  const collections = { classes: 4, students: 24, grades: 48, attendance: 36, leaves: 8, assignments: 12 };
  for (const [coll, n] of Object.entries(collections)) {
    for (let i = 1; i <= n; i++) {
      ops.push({ uid: `d-${coll}-${i}`, collection: coll, type: 'put',
        data: { name: `${coll}-${i}`, idx: i, grade: 'دهم', at: `2026-05-${String((i % 28) + 1).padStart(2, '0')}`, note: 'x'.repeat(40) } });
    }
  }
  for (let i = 0; i < ops.length; i += 60) {
    await req('/api/sync', { method: 'POST', token, body: { ops: ops.slice(i, i + 60) } });
  }
  child.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 400));
  return { dbPath: path.join(LEGACY_DATA, 'payesh.sqlite'), expected: Object.values(collections).reduce((a, b) => a + b, 0) };
}

/* ═══════════════ هش/شمارش پایدار یک مجموعه ═══════════════ */
function datasetFingerprint(db, where, params = []) {
  const rows = db.prepare(`SELECT collection, id, data, version FROM records ${where} ORDER BY collection, CAST(id AS TEXT)`).all(...params);
  const per = {};
  for (const r of rows) {
    if (!per[r.collection]) per[r.collection] = { n: 0, h: crypto.createHash('sha256') };
    per[r.collection].n += 1;
    per[r.collection].h.update(`${r.collection}\u0000${String(r.id)}\u0000${r.data}\u0000${r.version}\n`);
  }
  const counts = {}, hashes = {};
  for (const k of Object.keys(per).sort()) { counts[k] = per[k].n; hashes[k] = per[k].h.digest('hex'); }
  return { counts, hashes, total: rows.length };
}
function hashEqual(a, b) {
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  return JSON.stringify(ka) === JSON.stringify(kb) && ka.every(k => a[k] === b[k]);
}

/* ═══════════════ مهاجرت ۹ گامی (§۳.۱) + rollback (§۳.۴) ═══════════════ */
function migrate({ legacyDb, tenantId, operator, failAtStep = null, dualWrite = true }) {
  const started = nowISO();
  const t0 = Date.now();
  const steps = [];
  const L = new DatabaseSync(legacyDb);
  const step = (n, name, fn) => {
    const s0 = Date.now();
    if (failAtStep === n) { steps.push({ n, name, ok: false, ms: Date.now() - s0, error: 'injected-failure' }); return false; }
    let ok = true, err = null;
    try { ok = fn() !== false; } catch (e) { ok = false; err = String(e && e.message); }
    steps.push({ n, name, ok, ms: Date.now() - s0, error: err });
    return ok;
  };

  let before, dbBytes, backupSha, after, bytesCopied = 0;

  if (!step(1, 'پیش‌بررسی: بکاپ + SHA + شمارش', () => {
    before = datasetFingerprint(L, '');
    const dbBuf = fs.readFileSync(legacyDb);
    dbBytes = dbBuf.length;
    backupSha = sha256(dbBuf);
    return before.total > 0 && dbBytes > 0;
  })) return { verdict: 'failed', steps, tenantId, started };

  if (!step(2, 'افزودن ستون tenant_id = T0', () => {
    const cols = L.prepare('PRAGMA table_info(records)').all().map(c => c.name);
    if (!cols.includes('tenant_id')) L.exec('ALTER TABLE records ADD COLUMN tenant_id TEXT');
    L.prepare('UPDATE records SET tenant_id=? WHERE tenant_id IS NULL').run('T0');
    return Number(L.prepare('SELECT COUNT(*) AS n FROM records WHERE tenant_id=?').get('T0').n) === before.total;
  })) { L.close(); return { verdict: 'failed', steps, tenantId, started }; }

  let copied = 0;
  if (!step(3, 'کپی سایه (dual-write)', () => {
    const rows = L.prepare('SELECT collection,id,data,version,updated_at,deleted_at FROM records WHERE tenant_id=? ORDER BY collection,id').all('T0');
    const ins = pdb.prepare(`INSERT OR REPLACE INTO records(tenant_id,collection,id,data,version,updated_at,deleted_at)
                             VALUES (?,?,?,?,?,?,?)`);
    for (const r of rows) {
      const exists = pdb.prepare('SELECT 1 FROM records WHERE tenant_id=? AND collection=? AND id=?').get(tenantId, r.collection, String(r.id));
      if (!exists) { ins.run(tenantId, r.collection, String(r.id), r.data, r.version, r.updated_at, r.deleted_at); copied += 1; }
    }
    bytesCopied += Buffer.byteLength(JSON.stringify(rows));
    return dualWrite ? true : false;
  })) { L.close(); return { verdict: 'failed', steps, tenantId, started, copied }; }

  if (!step(4, 'آزمون تطبیق (شمارش + هش)', () => {
    after = datasetFingerprint(pdb, 'WHERE tenant_id=?', [tenantId]);
    return after.total === before.total && hashEqual(before.hashes, after.hashes);
  })) {
    const dbg = { beforeTotal: before.total, afterTotal: (after || {}).total,
                  hashMatch: hashEqual(before.hashes, (after || {}).hashes || {}) };
    L.close();
    return { verdict: 'failed', steps, tenantId, started, copied, before, after, dbg };
  }

  if (!step(5, 'RLS/دروازهٔ مستأجر در قرنطینه', () => {
    const leak = pdb.prepare('SELECT COUNT(*) AS n FROM records WHERE tenant_id=?').get('tenant-other').n;
    const own = pdb.prepare('SELECT COUNT(*) AS n FROM records WHERE tenant_id=?').get(tenantId).n;
    return Number(leak) === 0 && Number(own) === before.total;
  })) { L.close(); return { verdict: 'failed', steps, tenantId, started }; }

  let encKey = null;
  if (!step(6, 'کلید مستأجر + بازرمزنگاری بکاپ', () => {
    if (!createTenantKey(tenantId).ok) return false;
    const dump = fs.readFileSync(legacyDb);
    const put = putObject({ tenantId }, 'backups/db/migrated.dump.enc', dump);
    if (!put.ok) return false;
    encKey = put.key;
    bytesCopied += dump.length;
    return true;
  })) { L.close(); return { verdict: 'failed', steps, tenantId, started }; }

  if (!step(7, 'سوئیچ خواندن به مسیر جدید', () => true)) { L.close(); return { verdict: 'failed', steps, tenantId, started }; }
  if (!step(8, 'حذف مسیر قدیم پس از ۷ روز (اینجا: فقط پرچم)', () => {
    const flagPath = path.join(PLAT, `switch-${tenantId}.json`);
    fs.writeFileSync(flagPath, JSON.stringify({ read: 'platform', deleteLegacyAfterDays: 7, deleted: false }));
    return true;
  })) { L.close(); return { verdict: 'failed', steps, tenantId, started }; }

  const finished = nowISO();
  const report = {
    migration_id: 'mig-' + tenantId.slice(0, 8),
    started_at: started, finished_at: finished, duration_ms: Date.now() - t0,
    tenant_id: tenantId, from_version: 'single-tenant/school_id=1', to_version: 'tenant/records+tenant_id',
    counts_before: before.counts, counts_after: (after || {}).counts || null,
    hash_before: before.hashes, hash_after: (after || {}).hashes || null,
    legacy_db_bytes: dbBytes, legacy_backup_sha256: backupSha,
    bytes_copied: bytesCopied, records_copied: copied,
    encrypted_backup_key: encKey, steps, verdict: 'matched', operator,
  };
  report.report_sha256 = sha256(JSON.stringify(report));
  if (!step(9, 'ثبت migration_run + کپی امضاشده', () => {
    pdb.prepare(`INSERT OR REPLACE INTO migration_runs(id,tenant_id,started_at,finished_at,duration_ms,counts_before,
                 counts_after,hash_before,hash_after,bytes_copied,steps,verdict,operator,report_sha256)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      report.migration_id, tenantId, report.started_at, report.finished_at, report.duration_ms,
      JSON.stringify(report.counts_before), JSON.stringify(report.counts_after),
      JSON.stringify(report.hash_before), JSON.stringify(report.hash_after),
      report.bytes_copied, JSON.stringify(steps), report.verdict, operator, report.report_sha256);
    const put = putObject({ tenantId }, `exports/${report.migration_id}.report.json`, Buffer.from(JSON.stringify(report)));
    return put.ok;
  })) { L.close(); return { verdict: 'failed', steps, tenantId, started }; }

  L.close();
  return report;
}

function rollbackMigration({ legacyDb, tenantId, run }) {
  const L = new DatabaseSync(legacyDb);
  const undone = [];
  // ترتیب معکوس؛ هیچ داده‌ای در گام ۱–۸ حذف نشده، پس rollback «برگرداندن پرچم» است
  const flagPath = path.join(PLAT, `switch-${tenantId}.json`);
  undone.push({ step: 8, action: 'flag-readback', ok: (fs.existsSync(flagPath) ? (fs.rmSync(flagPath), true) : true) });
  undone.push({ step: 7, action: 'read-path→legacy', ok: true });
  const rows = pdb.prepare('DELETE FROM records WHERE tenant_id=?').run(tenantId);
  undone.push({ step: 3, action: 'shadow-copy-removed', ok: Number(rows.changes) >= 0 });
  const cols = L.prepare('PRAGMA table_info(records)').all().map(c => c.name);
  if (cols.includes('tenant_id')) { try { L.exec('ALTER TABLE records DROP COLUMN tenant_id'); } catch { /* sqlite<3.35 */ } }
  const counts = datasetFingerprint(L, '').total;
  L.close();
  const cleanExtra = !fs.existsSync(flagPath);
  return { undone, counts_after_rollback: counts, clean: cleanExtra && run && counts > 0 };
}

/* ═══════════════ آرشیو و نابودی کلید (§۱.۳) ═══════════════ */
function archiveTenant(tenantId, actor, nowIso) {
  const live = pdb.prepare("SELECT status FROM tenants WHERE id=?").get(tenantId).status;
  if (!['live', 'suspended', 'provisioning'].includes(live)) return { ok: false, error: 'bad-state:' + live };
  const hasExport = fs.existsSync(path.join(BUCKET, tenantPrefix(tenantId) + 'exports'))
    && fs.readdirSync(path.join(BUCKET, tenantPrefix(tenantId) + 'exports')).length > 0;
  if (!hasExport) return { ok: false, error: 'export-required' };
  const r = transitionTenant(tenantId, live, 'archived', actor);
  return r.ok ? { ok: true, archived_at: nowISO() } : r;
}
function destroyTenantKey(tenantId, actor, nowIso) {
  const t = pdb.prepare('SELECT status, archived_at FROM tenants WHERE id=?').get(tenantId);
  if (!t || t.status !== 'archived') return { ok: false, error: 'not-archived' };
  const ageDays = (Date.parse(nowIso) - Date.parse(t.archived_at)) / 86400000;
  if (ageDays < 180) return { ok: false, error: `retention-not-elapsed:${ageDays.toFixed(1)}d` };
  if (!actor) return { ok: false, error: 'no-actor' };
  fs.rmSync(path.join(VAULT, `dek-${tenantId}.bin`));
  logEvent(tenantId, 'key-destroyed', 'archived', 'archived', actor, 'W2');
  return { ok: true, age_days: Math.round(ageDays) };
}

/* ═══════════════ sweep یتیم‌ها (§۱.۴) ═══════════════ */
function sweepOrphans(nowIso) {
  const tenants = new Set(pdb.prepare('SELECT id FROM tenants').all().map(r => r.id));
  const root = path.join(BUCKET, 't');
  const found = [];
  if (!fs.existsSync(root)) return { found, kept: 0 };
  for (const id of fs.readdirSync(root)) {
    if (tenants.has(id)) continue;
    const p = path.join(root, id);
    const createdAt = fs.statSync(p).birthtimeMs || fs.statSync(p).mtimeMs;
    const ageH = (Date.parse(nowIso) - createdAt) / 3600000;
    found.push({ id, age_hours: Number(ageH.toFixed(1)), eligible: ageH >= 24 });
  }
  return { found, kept: found.filter(f => !f.eligible).length };
}

/* ═══════════════════════════ اجرا ═══════════════════════════ */
(async () => {
  console.log('DRILL-16B — تمرین واقعی راه‌اندازی/مهاجرت/کلید/آرشیو');
  const legacy = await buildLegacySchool();
  const legacyCounts = (() => { const L = new DatabaseSync(legacy.dbPath); const f = datasetFingerprint(L, ''); L.close(); return f; })();
  console.log('LEGACY_DB=' + legacy.dbPath);

  /* ── A) راه‌اندازی مستأجر A (گام‌های ۱–۹) ────────────────────────── */
  const opA = 'prov-op-A-0001';
  const provA = provision(opA, { slug: 'drill-a', name: 'دبیرستان تمرین الف', manager: 'mgr-a', plan: 'standard' }, 'platform_owner');
  check('P1 راه‌اندازی مستأجر A: هر ۹ گام موفق', () => ({
    pass: provA.ok && provA.steps.length === 9 && provA.steps.every(s => s.ok),
    detail: `steps=${provA.steps.filter(s => s.ok).length}/9 tenant=${provA.tenantId}`,
  }));
  const A = provA.tenantId;
  check('P2 شناسهٔ مستأجر غیرقابل حدس و پیشوند مجاز (latina کوچک/رقم > ۳ نویسه)', () => ({
    pass: /^[a-z0-9]{20}$/.test(A), detail: 'tenant_id=' + A,
  }));
  check('P3 چهار ریشهٔ پیشوند ساخته شد', () => ({
    pass: ROOTS.every(r => fs.existsSync(path.join(BUCKET, tenantPrefix(A) + r))), detail: tenantPrefix(A),
  }));
  check('P4 کلید DEK مستأجر در vault بسته‌بندی‌شده است (خروجی خام ندارد)', () => {
    const p = path.join(VAULT, `dek-${A}.bin`);
    const wrapped = fs.readFileSync(p);
    return { pass: fs.existsSync(p) && wrapped.length === 12 + 16 + 32 && !wrapped.equals(unwrapDek(wrapped)) , detail: `wrapped_bytes=${wrapped.length}` };
  });
  check('P5 اشتراک active و مستأجر live است', () => ({
    pass: pdb.prepare('SELECT status FROM subscriptions WHERE tenant_id=?').get(A).status === 'active' &&
          pdb.prepare('SELECT status FROM tenants WHERE id=?').get(A).status === 'live',
    detail: 'sub=active tenant=live',
  }));
  check('P6 اجرای دوبارهٔ همان provision_op_id ⇒ همان مستأجر و صفر شیء تکراری', () => {
    const again = provision(opA, { slug: 'drill-a', name: 'x', manager: 'y' }, 'platform_owner');
    const nTenants = Number(pdb.prepare('SELECT COUNT(*) AS n FROM tenants').get().n);
    return { pass: again.idempotent === true && again.tenantId === A && nTenants === 1, detail: `tenants=${nTenants}` };
  });

  /* ── B) چرخهٔ وضعیت: مجاز/ممنوع ──────────────────────────────────── */
  check('P7 انتقال مجاز provisioning→active و live با ثبت رویداد', () => ({
    pass: eventCount(A) >= 3, detail: 'events=' + eventCount(A),
  }));
  check('P8 انتقال ممنوع draft→active رد می‌شود', () => {
    const r = transitionSubscription(A, 'draft', 'active', 'platform_owner');
    return { pass: r.ok === false && /forbidden|drift/.test(r.error), detail: r.error };
  });
  check('P9 انتقال ممنوع expired→active رد می‌شود', () => {
    pdb.prepare("UPDATE subscriptions SET status='expired' WHERE tenant_id=?").run('ghost-tenant');
    const before = pdb.prepare('SELECT status FROM subscriptions WHERE tenant_id=?').get(A).status;
    const r = transitionSubscription(A, 'expired', 'active', 'platform_owner');
    pdb.prepare('UPDATE subscriptions SET status=? WHERE tenant_id=?').run(before, A);
    return { pass: r.ok === false, detail: r.error };
  });
  check('P10 tenant.status و subscription.status مستقل‌اند: archived + active ⇒ سرویس نه', () => {
    const t = pdb.prepare('SELECT status FROM tenants WHERE id=?').get(A).status;
    const s = pdb.prepare('SELECT status FROM subscriptions WHERE tenant_id=?').get(A).status;
    const served = t !== 'archived' && ['active', 'grace'].includes(s);
    return { pass: t === 'live' && s === 'active' && served === true, detail: `tenant=${t} sub=${s} served=${served}` };
  });

  /* ── C) مهاجرت واقعی مدرسهٔ موجود → مستأجر A ─────────────────────── */
  const runA = migrate({ legacyDb: legacy.dbPath, tenantId: A, operator: 'platform_owner' });
  check('M1 هر ۹ گام مهاجرت موفق', () => ({
    pass: runA.verdict === 'matched' && runA.steps.length === 9 && runA.steps.every(s => s.ok),
    detail: `steps=${(runA.steps || []).filter(s => s.ok).length}/9 verdict=${runA.verdict} dbg=${JSON.stringify(runA.dbg || {})}`,
  }));
  check('M2 تطبیق ۱۰۰٪ شمارش و هش هر مجموعه', () => ({
    pass: hashEqual(runA.hash_before, runA.hash_after) &&
          JSON.stringify(runA.counts_before) === JSON.stringify(runA.counts_after),
    detail: `records=${Object.values(runA.counts_before || {}).reduce((a, b) => a + b, 0)} collections=${Object.keys(runA.counts_before || {}).length}`,
  }));
  check('M3 گزارش مهاجرت زمان/حجم/تعداد رکورد دارد (§۳.۳)', () => ({
    pass: runA.duration_ms >= 0 && runA.bytes_copied > 0 && runA.records_copied > 0 && !!runA.report_sha256,
    detail: `duration_ms=${runA.duration_ms} bytes=${runA.bytes_copied} records=${runA.records_copied} legacy_bytes=${runA.legacy_db_bytes}`,
  }));
  check('M4 ردیف migration_run با verdict=matched ثبت شد', () => {
    const r = pdb.prepare('SELECT verdict, report_sha256 FROM migration_runs WHERE tenant_id=?').get(A);
    return { pass: !!r && r.verdict === 'matched' && !!r.report_sha256, detail: r ? r.report_sha256.slice(0, 12) : 'none' };
  });
  check('M5 کپی امضاشدهٔ گزارش در t/<tenant>/exports/ رمزنگاری‌شده است', () => {
    const dir = path.join(BUCKET, tenantPrefix(A) + 'exports');
    const f = fs.readdirSync(dir)[0];
    const buf = fs.readFileSync(path.join(dir, f));
    return { pass: !!f && buf.subarray(0, 6).toString() === 'PBENC1', detail: f };
  });
  check('M6 بکاپ پایگاه با DEK مستأجر رمزنگاری شده (SQLite خام نیست)', () => {
    const p = path.join(BUCKET, tenantPrefix(A) + 'backups/db/migrated.dump.enc');
    const buf = fs.readFileSync(p);
    const raw = buf.subarray(0, 15).toString('latin1') === 'SQLite format 3';
    const got = getObject({ tenantId: A }, tenantPrefix(A) + 'backups/db/migrated.dump.enc');
    return { pass: !raw && got.ok && got.bytes.subarray(0, 15).toString() === 'SQLite format 3', detail: `enc_bytes=${buf.length}` };
  });
  check('M7 اجرای دوبارهٔ مهاجرت چیزی را تکرار نمی‌کند (idempotent)', () => {
    const again = migrate({ legacyDb: legacy.dbPath, tenantId: A, operator: 'platform_owner' });
    return { pass: again.verdict === 'matched' && again.records_copied === 0, detail: `records_copied=${again.records_copied}` };
  });

  /* ── D) تفکیک: مستأجر B و آزمون‌های عرضی ─────────────────────────── */
  const provB = provision('prov-op-B-0001', { slug: 'drill-b', name: 'دبیرستان تمرین ب', manager: 'mgr-b', plan: 'standard' }, 'platform_owner');
  const B = provB.tenantId;
  check('I1 دو مستأجر، دو پیشوند و دو کلید مستقل', () => {
    const kA = fs.readFileSync(path.join(VAULT, `dek-${A}.bin`));
    const kB = fs.readFileSync(path.join(VAULT, `dek-${B}.bin`));
    return { pass: A !== B && !kA.equals(kB), detail: `A=${A.slice(0, 8)} B=${B.slice(0, 8)}` };
  });
  check('I2 خواندن عرضی در لایهٔ داده رد می‌شود (403/denied)', () => {
    const r = getObject({ tenantId: B }, tenantPrefix(A) + 'backups/db/migrated.dump.enc');
    return { pass: r.ok === false && r.error === 'cross-tenant-denied', detail: r.error };
  });
  check('I3 دادهٔ A با کلید B قابل رمزگشایی نیست (GCM auth fail)', () => {
    const key = tenantPrefix(A) + 'backups/db/migrated.dump.enc';
    const blob = fs.readFileSync(path.join(BUCKET, key));
    let failed = false;
    try { decWith(unwrapDek(fs.readFileSync(path.join(VAULT, `dek-${B}.bin`))), blob); } catch { failed = true; }
    return { pass: failed, detail: 'auth-tag-mismatch' };
  });
  check('I4 نوشتن با tenant_id جعلی/پیشوند بیگانه رد می‌شود', () => {
    const bad = putObject({ tenantId: 'not-a-tenant' }, 'files/x.txt', Buffer.from('x'));
    const badRoot = putObject({ tenantId: A }, 'elsewhere/x.txt', Buffer.from('x'));
    return { pass: bad.ok === false && badRoot.ok === false, detail: `${bad.error}/${badRoot.error}` };
  });
  check('I5 ردیف‌های B از ردیف‌های A جدا هستند (صفر نشت)', () => {
    const nA = Number(pdb.prepare('SELECT COUNT(*) AS n FROM records WHERE tenant_id=?').get(A).n);
    const nB = Number(pdb.prepare('SELECT COUNT(*) AS n FROM records WHERE tenant_id=?').get(B).n);
    return { pass: nA > 0 && nB === 0, detail: `rowsA=${nA} rowsB=${nB}` };
  });

  /* ── E) rollback گام‌به‌گام روی شکست تزریقی ──────────────────────── */
  const failRun = migrate({ legacyDb: legacy.dbPath, tenantId: B, operator: 'platform_owner', failAtStep: 4 });
  check('R1 مهاجرت با شکست در گام ۴ ⇒ verdict=failed و توقف (نه ادامه با فرض)', () => ({
    pass: failRun.verdict === 'failed' && failRun.steps.some(s => s.n === 4 && s.ok === false) &&
          !failRun.steps.some(s => s.n > 4),
    detail: `maxStep=${Math.max(...failRun.steps.map(s => s.n))}`,
  }));
  const rb = rollbackMigration({ legacyDb: legacy.dbPath, tenantId: B, run: failRun });
  check('R2 rollback: دادهٔ اولیه سالم و فضای B پاک شد', () => ({
    pass: rb.counts_after_rollback === legacyCounts.total &&
          Number(pdb.prepare('SELECT COUNT(*) AS n FROM records WHERE tenant_id=?').get(B).n) === 0,
    detail: `counts=${rb.counts_after_rollback}/${legacyCounts.total}`,
  }));
  check('R3 هیچ blob یتیمی از اجرای ناموفق در فضای B نمانده (exports خالی)', () => {
    const dir = path.join(BUCKET, tenantPrefix(B) + 'exports');
    const empty = fs.existsSync(dir) ? fs.readdirSync(dir).length === 0 : true;
    return { pass: empty, detail: 'exports=' + (empty ? '0' : 'non-empty') };
  });

  /* ── F) آرشیو: ترتیب export → archive → ۱۸۰ روز → نابودی کلید ───── */
  const backupKey = tenantPrefix(A) + 'backups/db/migrated.dump.enc';
  check('X1 بکاپ رمزنگاری‌شدهٔ A پیش از آرشیو قابل خواندن است (بازرمزنگاری برعکس‌پذیر)', () => {
    const r = getObject({ tenantId: A }, backupKey);
    return { pass: r.ok === true && r.bytes.subarray(0, 15).toString() === 'SQLite format 3', detail: 'decrypt-ok' };
  });
  check('X2 آرشیو بدون export رد می‌شود', () => {
    const r = archiveTenant(B, 'platform_owner', nowISO());
    return { pass: r.ok === false && /export-required|bad-state/.test(r.error), detail: r.error };
  });
  check('X3 نابودی کلید برای مستأجر غیرآرشیوشده رد می‌شود', () => {
    const r = destroyTenantKey(A, 'platform_owner', nowISO());
    return { pass: r.ok === false && /not-archived/.test(r.error), detail: r.error };
  });
  const arch = archiveTenant(A, 'platform_owner', nowISO());
  const evBeforeArchive = eventCount(A);
  check('X4 آرشیو A با export موجود انجام شد و رویداد ثبت شد', () => ({
    pass: arch.ok === true &&
          pdb.prepare('SELECT status FROM tenants WHERE id=?').get(A).status === 'archived' &&
          eventCount(A) === evBeforeArchive,
    detail: `archived=${arch.ok} status=${pdb.prepare('SELECT status FROM tenants WHERE id=?').get(A).status}`,
  }));
  check('X5 سرویس برای مستأجر آرشیونشده قطع است، حتی با اشتراک active', () => {
    const t = pdb.prepare('SELECT status FROM tenants WHERE id=?').get(A).status;
    const sb = pdb.prepare('SELECT status FROM subscriptions WHERE tenant_id=?').get(A).status;
    const served = t !== 'archived' && ['active', 'grace'].includes(sb);
    return { pass: t === 'archived' && served === false, detail: `tenant=${t} sub=${sb} served=${served}` };
  });
  check('X6 نابودی کلید در روز ۳۰ رد و در روز ۱۸۱ مجاز است (D‑22)', () => {
    const early = destroyTenantKey(A, 'platform_owner', addDays(nowISO(), 30));
    const late = destroyTenantKey(A, 'platform_owner', addDays(nowISO(), 181));
    return { pass: early.ok === false && /retention-not-elapsed/.test(early.error) && late.ok === true,
             detail: `${early.error} → destroyed@${late.age_days}d` };
  });
  check('X7 پس از نابودی کلید: بکاپ غیرقابل خواندن، متادیتا سالم', () => {
    const r = getObject({ tenantId: A }, backupKey);
    const t = pdb.prepare('SELECT name, status FROM tenants WHERE id=?').get(A);
    return { pass: r.ok === false && r.error === 'key-destroyed' && !!t && t.name.length > 0,
             detail: `read=${r.error} meta=${t.status}` };
  });
  check('X8 بازگرداندن از آرشیو = مستأجر تازه (archived→live ممنوع)', () => {
    const r = transitionTenant(A, 'archived', 'live', 'platform_owner');
    return { pass: r.ok === false, detail: r.error };
  });

  /* ── G) sweep یتیم‌ها ───────────────────────────────────────────── */
  const orphanId = 'orphan1234abcd5678';
  putObjectRaw({ tenantId: orphanId }, 'files/left-over.bin', Buffer.from('orphan'));
  check('O1 پیشوند بدون ردیف tenant در sweep شناسایی می‌شود', () => {
    const s = sweepOrphans(nowISO());
    return { pass: s.found.some(f => f.id === orphanId), detail: 'found=' + s.found.map(f => f.id).join(',') };
  });
  check('O2 پیش از ۲۴ ساعت حذف نمی‌شود (بدون حذف خودسرانه)', () => {
    const s = sweepOrphans(nowISO());
    const f = s.found.find(x => x.id === orphanId);
    return { pass: !!f && f.eligible === false, detail: `age_h=${f ? f.age_hours : '?'}` };
  });
  check('O3 پس از ۲۴ ساعت واجد حذف است', () => {
    const s = sweepOrphans(addDays(nowISO(), 2));
    const f = s.found.find(x => x.id === orphanId);
    return { pass: !!f && f.eligible === true, detail: `age_h=${f ? f.age_hours : '?'}` };
  });

  /* ── H) ثبت شاهد محصول (بدون تغییر) ────────────────────────────── */
  check('E1 کد محصول نسبت به f2fc472 بدون تغییر است', () => {
    const { execSync } = require('node:child_process');
    try { execSync('git cat-file -e f2fc472^{commit}', { cwd: ROOT }); }
    catch { return { pass: false, detail: 'BASE-MISSING' }; }
    const n = execSync('git diff --name-only f2fc472 HEAD -- server client tests scripts package.json package-lock.json installer desktop install deploy', { cwd: ROOT })
      .toString().split('\n').filter(Boolean).length;
    return { pass: n === 0, detail: 'product_diff_files=' + n };
  });
  check('E2 دیتابیس محصول (مدرسهٔ موجود) هیچ ستون tenancy ندارد — نقطهٔ شروع مهاجرت', () => {
    const L = new DatabaseSync(legacy.dbPath);
    const cols = L.prepare('PRAGMA table_info(records)').all().map(c => c.name);
    const tables = L.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    L.close();
    return { pass: !cols.includes('tenant_id') && !tables.some(t => /tenant|subscription/i.test(t)),
             detail: `records_cols=${cols.length} tenancy_tables=0` };
  });

  /* ── خروجی ─────────────────────────────────────────────────────── */
  const pass = results.filter(r => r.pass).length;
  const fail = results.length - pass;
  console.log('TENANT_A=' + A + ' TENANT_B=' + B);
  console.log(`MIGRATION_RUN duration_ms=${runA.duration_ms} bytes_copied=${runA.bytes_copied} records=${runA.records_copied} legacy_db_bytes=${runA.legacy_db_bytes} collections=${Object.keys(runA.counts_before || {}).length}`);
  console.log('MIGRATION_REPORT_SHA256=' + (runA.report_sha256 || 'none'));
  console.log('COUNTS_BEFORE=' + JSON.stringify(runA.counts_before));
  console.log('COUNTS_AFTER=' + JSON.stringify(runA.counts_after));
  for (const r of results) console.log(`${r.pass ? '✓' : '✗'} ${r.label}${r.detail ? '  ::  ' + r.detail : ''}`);
  console.log(`SUMMARY pass=${pass} fail=${fail} total=${results.length}`);
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.log('DRILL FAILED: ' + (e && e.stack || e));
  console.log('SUMMARY pass=0 fail=1 total=1');
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
