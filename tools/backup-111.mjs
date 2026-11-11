#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   Row 111 (ADR-105, Proposed) — backup OUTSIDE the provider and a restore
   drill: encrypted, timestamped pg_dump of the direct path + restore on a
   local PostgreSQL.

   Commands
     keygen  --out-dir D
         X25519 backup key pair: D/payesh-backup.pub (public, may live on the
         backup machine) and D/payesh-backup.private.key (0600 — keep OFFLINE,
         with the owner; needed only to restore).
     dump    --pub FILE|B64U --out-dir D [--source-env NAME]
         Source connection string from the environment (default
         PAYESH_BACKUP_SOURCE_URL) — never from argv, never logged. The role
         must bypass RLS (record/sync_* have FORCED row security). Streams
         pg_dump -Fc (schema payesh_direct + the migration ledger) straight
         into the encryptor: no plaintext dump touches the backup disk.
         Writes payesh-backup-<UTC>.e2b + .json sidecar (sha256, no secrets).
     verify  --file F [--key K]
         Without a key: size + sha256 against the sidecar. With the private
         key: full decryption, every chunk authenticated, end marker present.
     restore --file F --key K [--target-env NAME] [--create-roles]
         Decrypts (temp files 0600, wiped), pg_restore --single-transaction
         --exit-on-error into the target (env PAYESH_RESTORE_TARGET_URL), then
         checks row counts, RLS flags, policies, functions and the migration
         ledger against the snapshot sealed inside the backup.
     prune   --dir D [--keep 7] [--monthly 6] [--dry-run]
         Retention: the newest N backups + the newest of each of the last M
         months; everything else (and its sidecar) is deleted.
     status  --dir D [--max-age-hours 36]
         Monitoring: exit 1 when there is no backup, the newest one is older
         than the limit (e.g. the provider paused the project and dumps stopped)
         or fails its checksum.
     drill   [--fresh-cluster]
         The restore drill of the AC on local PostgreSQL (PAYESH_PG_ADMIN):
         seeds a school through the real direct-path RPCs, keygen, dump,
         tamper / truncate / wrong-key refusals, restore into an empty
         database (or a brand-new cluster with --fresh-cluster and
         PAYESH_PG_BIN), then uses the restored copy as a device would (RLS,
         sync_pull, decryption) and writes a new version. One `DRILL {json}`
         line per step, exit 0 only if every check passed. Label [S].

   Container (v1): "PB111\x01" | u32 header length | header JSON (clear:
   format, created_at, recipient kid, ephemeral public key, salt) | records.
   Record = u32 length | AES-256-GCM(key, nonce = 0^4 ‖ counter_be64,
   aad = sha256(header) ‖ counter ‖ final-flag). key = HKDF-SHA256(
   X25519(eph, recipient), salt, "payesh/backup-111|v1|<kid>"). Plaintext
   records: [kind][part][data] — 'D' data of part n, 'E' the final record
   (manifest: parts, sizes, sha256, snapshot). Reordering, truncation,
   a flipped bit or the wrong key all fail closed.
   ═══════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAGIC = Buffer.from('PB111\x01', 'latin1');
const FORMAT = 'payesh-backup-111';
const CHUNK = 1 << 20;
const SCHEMA = 'payesh_direct';
const LEDGER = 'public.payesh_schema_migrations';
const ROLES = ['payesh_direct_owner', 'payesh_direct_client'];
/* the same attributes as migration 0001 — never LOGIN, never BYPASSRLS */
const CREATE_ROLE = {
  payesh_direct_owner: 'CREATE ROLE payesh_direct_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',
  payesh_direct_client: 'CREATE ROLE payesh_direct_client NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',
};

class BackupError extends Error { constructor(code, msg) { super(msg || code); this.code = code; } }

/* ── keys ── */
const b64u = b => Buffer.from(b).toString('base64url');
const unb64u = s => Buffer.from(String(s).trim(), 'base64url');
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
function x25519Keys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(12), priv: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(16) };
}
const pubObj = raw => crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: 'der', type: 'spki' });
const privObj = raw => crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: 'der', type: 'pkcs8' });
const kidOf = pub => 'pb111:' + crypto.createHash('sha256').update(pub).digest('hex').slice(0, 16);
function deriveKey(ephPriv, recipPub, salt, kid) {
  const shared = crypto.diffieHellman({ privateKey: privObj(ephPriv), publicKey: pubObj(recipPub) });
  if (shared.every(b => b === 0)) throw new BackupError('bad_key', 'degenerate shared secret');
  return Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from('payesh/backup-111|v1|' + kid), 32));
}
function readKey(v, len, what) {
  const s = fs.existsSync(String(v)) ? fs.readFileSync(String(v), 'utf8') : String(v);
  const b = unb64u(s.replace(/^#.*$/mg, '').trim());
  if (b.length !== len) throw new BackupError('bad_key', what + ' must be ' + len + ' bytes (base64url)');
  return b;
}

/* ── container writer / reader ── */
function aadOf(hh, n, final) {
  const a = Buffer.alloc(41); hh.copy(a, 0); a.writeBigUInt64BE(BigInt(n), 32); a[40] = final ? 1 : 0; return a;
}
function nonceOf(n) { const b = Buffer.alloc(12); b.writeBigUInt64BE(BigInt(n), 4); return b; }
class Sealer {
  constructor(fd, recipPub, meta) {
    this.fd = fd; this.n = 0;
    const eph = x25519Keys(), salt = crypto.randomBytes(16), kid = kidOf(recipPub);
    this.key = deriveKey(eph.priv, recipPub, salt, kid);
    const header = Buffer.from(JSON.stringify(Object.assign({ format: FORMAT, v: 1, kid, eph: b64u(eph.pub), salt: b64u(salt), chunk: CHUNK }, meta)));
    const len = Buffer.alloc(4); len.writeUInt32BE(header.length);
    this.hh = crypto.createHash('sha256').update(header).digest();
    this.hash = crypto.createHash('sha256');
    this.size = 0;
    this.write(Buffer.concat([MAGIC, len, header]));
    this.header = JSON.parse(header);
  }
  write(b) { fs.writeSync(this.fd, b); this.hash.update(b); this.size += b.length; }
  record(plain, final) {
    const c = crypto.createCipheriv('aes-256-gcm', this.key, nonceOf(this.n));
    c.setAAD(aadOf(this.hh, this.n, final));
    const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    this.write(Buffer.concat([len, body]));
    this.n++;
  }
  data(part, buf) {
    for (let o = 0; o < buf.length; o += CHUNK - 2) this.record(Buffer.concat([Buffer.from([0x44, part]), buf.subarray(o, o + CHUNK - 2)]), false);
  }
  finish(manifest) { this.record(Buffer.concat([Buffer.from([0x45, 0]), Buffer.from(JSON.stringify(manifest))]), true); }
}
function readHeader(buf) {
  if (buf.length < 10 || !buf.subarray(0, 6).equals(MAGIC)) throw new BackupError('bad_format', 'not a payesh backup (magic)');
  const hl = buf.readUInt32BE(6);
  if (hl > 65536 || 10 + hl > buf.length) throw new BackupError('bad_format', 'header length');
  const hb = buf.subarray(10, 10 + hl);
  let h; try { h = JSON.parse(hb); } catch (e) { throw new BackupError('bad_format', 'header json'); }
  if (h.format !== FORMAT || h.v !== 1) throw new BackupError('bad_format', 'unsupported format/version');
  return { h, hh: crypto.createHash('sha256').update(hb).digest(), off: 10 + hl };
}
/* decrypt the whole container → { header, manifest, parts: Map(part → Buffer[]) } */
function openContainer(file, privRaw, onData) {
  const buf = fs.readFileSync(file);
  const { h, hh, off } = readHeader(buf);
  const pub = crypto.createPublicKey(privObj(privRaw)).export({ type: 'spki', format: 'der' }).subarray(12);
  if (kidOf(pub) !== h.kid) throw new BackupError('wrong_key', 'backup was sealed to ' + h.kid + ', key is ' + kidOf(pub));
  const key = deriveKey(privRaw, unb64u(h.eph), unb64u(h.salt), h.kid);
  let p = off, n = 0, manifest = null;
  const sizes = new Map(), hashes = new Map();
  while (p < buf.length) {
    if (manifest) throw new BackupError('bad_format', 'data after the end marker');
    if (p + 4 > buf.length) throw new BackupError('truncated', 'record length cut');
    const len = buf.readUInt32BE(p); p += 4;
    if (len < 18 || len > CHUNK + 64 || p + len > buf.length) throw new BackupError('truncated', 'record ' + n + ' cut');
    const body = buf.subarray(p, p + len); p += len;
    let plain = null;
    for (const final of [false, true]) {
      try {
        const d = crypto.createDecipheriv('aes-256-gcm', key, nonceOf(n));
        d.setAAD(aadOf(hh, n, final)); d.setAuthTag(body.subarray(len - 16));
        plain = Buffer.concat([d.update(body.subarray(0, len - 16)), d.final()]);
        if (final !== (plain[0] === 0x45)) throw new BackupError('bad_format', 'end flag mismatch');
        break;
      } catch (e) { if (e instanceof BackupError) throw e; plain = null; }
    }
    if (!plain) throw new BackupError('auth_failed', 'record ' + n + ' failed authentication (tampered, reordered or wrong key)');
    if (plain[0] === 0x44) {
      const part = plain[1], data = plain.subarray(2);
      sizes.set(part, (sizes.get(part) || 0) + data.length);
      if (!hashes.has(part)) hashes.set(part, crypto.createHash('sha256'));
      hashes.get(part).update(data);
      if (onData) onData(part, data);
    } else if (plain[0] === 0x45) manifest = JSON.parse(plain.subarray(2));
    else throw new BackupError('bad_format', 'record kind');
    n++;
  }
  if (!manifest) throw new BackupError('truncated', 'end marker missing (backup truncated)');
  manifest.parts.forEach((pt, i) => {
    const got = hashes.has(i) ? hashes.get(i).digest('hex') : crypto.createHash('sha256').digest('hex');
    if ((sizes.get(i) || 0) !== pt.size || got !== pt.sha256) throw new BackupError('manifest_mismatch', 'part ' + pt.name + ' size/sha256');
  });
  return { header: h, manifest, records: n };
}

/* ── connection strings: from env only, handed to pg tools via PG* env ── */
function connEnv(url) {
  let u;
  try { u = new URL(url); } catch (e) { throw new BackupError('bad_url', 'connection string is not a URL'); }
  const local = ['localhost', '127.0.0.1', '::1', '[::1]', ''].includes(u.hostname);
  const e = { PGHOST: u.hostname || '127.0.0.1', PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username || 'postgres'), PGDATABASE: decodeURIComponent(u.pathname.slice(1) || 'postgres') };
  if (u.password) e.PGPASSWORD = decodeURIComponent(u.password);
  e.PGSSLMODE = u.searchParams.get('sslmode') || (local ? 'disable' : 'require');
  return e;
}
const redact = url => { try { const u = new URL(url); if (u.password) u.password = '***'; return u.host + u.pathname; } catch (e) { return '<invalid>'; } };
function pgClient(url) {
  const { Client } = require('pg');
  const c = new Client({ connectionString: url, ssl: connEnv(url).PGSSLMODE === 'disable' ? false : { rejectUnauthorized: connEnv(url).PGSSLMODE === 'verify-full' } });
  c.on('error', () => {});
  return c;
}
function toolVersion(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (r.status !== 0) throw new BackupError('tool_missing', bin + ' not found (install the PostgreSQL client tools)');
  return r.stdout.trim();
}
const PGBIN = n => (process.env.PAYESH_PG_CLIENT_BIN ? path.join(process.env.PAYESH_PG_CLIENT_BIN, n) : n);

/* what must survive a restore: counts, RLS flags, policies, functions, ledger */
async function snapshot(c) {
  const tables = (await c.query(`SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY 1`, [SCHEMA])).rows;
  const counts = {};
  /* exact counts with a constant statement: the table names come from pg_class and are quoted by format(%I) */
  const cnt = await c.query(`SELECT c.relname, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint AS n
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY 1`, [SCHEMA]);
  for (const r of cnt.rows) counts[r.relname] = Number(r.n);
  const policies = Number((await c.query('SELECT count(*) AS n FROM pg_policies WHERE schemaname = $1', [SCHEMA])).rows[0].n);
  const functions = Number((await c.query(`SELECT count(*) AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1`, [SCHEMA])).rows[0].n);
  const grants = Number((await c.query(`SELECT count(*) AS n FROM information_schema.role_table_grants WHERE table_schema = $1 AND grantee = 'payesh_direct_client'`, [SCHEMA])).rows[0].n);
  const ledger = (await c.query("SELECT id FROM public.payesh_schema_migrations WHERE track = 'direct' ORDER BY id").catch(() => ({ rows: [] }))).rows.map(r => r.id);
  return { tables: tables.map(t => ({ name: t.relname, rls: t.rls, forced: t.forced })), counts, policies, functions, grants, ledger };
}
function diffSnap(a, b) {
  const out = [];
  for (const k of ['tables', 'counts', 'policies', 'functions', 'grants', 'ledger']) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k);
  return out;
}

/* ── dump ── */
function runToBuffer(bin, args, env, onChunk) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { env: Object.assign({}, process.env, env), stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stdout.on('data', onChunk);
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => reject(new BackupError('tool_missing', bin + ': ' + e.message)));
    p.on('close', code => (code === 0 ? resolve() : reject(new BackupError('pg_dump_failed', bin + ' exit ' + code + ': ' + err.slice(0, 400)))));
  });
}
export async function dump({ sourceUrl, pubRaw, outDir, now = new Date() }) {
  const ver = toolVersion(PGBIN('pg_dump'));
  const c = pgClient(sourceUrl);
  await c.connect();
  let snap, role;
  try {
    role = (await c.query('SELECT rolsuper OR rolbypassrls AS ok, current_user AS who FROM pg_roles WHERE rolname = current_user')).rows[0];
    if (!role || !role.ok) throw new BackupError('backup_role_needs_bypassrls', 'the backup role must bypass RLS (FORCED row security on record / sync_*), otherwise the dump would be partial');
    snap = await snapshot(c);
    snap.server_version = (await c.query('SHOW server_version')).rows[0].server_version;
  } finally { await c.end().catch(() => {}); }
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const name = `payesh-backup-${stamp}.e2b`;
  const file = path.join(outDir, name), tmp = file + '.partial';
  const fd = fs.openSync(tmp, 'wx', 0o600);
  const t0 = Date.now();
  const parts = [];
  try {
    const s = new Sealer(fd, pubRaw, { created_at: now.toISOString(), tool: 'tools/backup-111.mjs' });
    const env = connEnv(sourceUrl);
    const jobs = [['schema', ['-Fc', '--no-password', '-n', SCHEMA]], ['ledger', ['-Fc', '--no-password', '-t', LEDGER]]];
    for (let i = 0; i < jobs.length; i++) {
      const h = crypto.createHash('sha256'); let size = 0; let pending = [];
      let pendingLen = 0;
      const flush = () => { if (pendingLen) { const b = Buffer.concat(pending); s.data(i, b); h.update(b); size += b.length; pending = []; pendingLen = 0; } };
      await runToBuffer(PGBIN('pg_dump'), jobs[i][1], env, d => { pending.push(d); pendingLen += d.length; if (pendingLen >= CHUNK - 2) flush(); });
      flush();
      parts.push({ name: jobs[i][0], format: 'pg_dump -Fc', size, sha256: h.digest('hex') });
    }
    s.finish({ format: FORMAT, created_at: now.toISOString(), pg_dump: ver, source: { server_version: snap.server_version, role_bypassrls: true }, parts, snapshot: snap });
    fs.closeSync(fd);
    fs.renameSync(tmp, file);
    const side = { file: name, format: FORMAT, v: 1, created_at: now.toISOString(), size: s.size, sha256: s.hash.digest('hex'), recipient: s.header.kid, records: s.n };
    fs.writeFileSync(file.replace(/\.e2b$/, '.json'), JSON.stringify(side, null, 2) + '\n', { mode: 0o644 });
    return { file, sidecar: side, parts, snapshot: snap, ms: Date.now() - t0 };
  } catch (e) {
    try { fs.closeSync(fd); } catch (x) { /* closed */ }
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export function verifyFile(file, privRaw) {
  const side = JSON.parse(fs.readFileSync(file.replace(/\.e2b$/, '.json'), 'utf8'));
  const buf = fs.readFileSync(file);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (buf.length !== side.size || sha !== side.sha256) throw new BackupError('checksum_mismatch', 'file differs from its sidecar (size/sha256)');
  readHeader(buf);
  if (!privRaw) return { checksum: true };
  const o = openContainer(file, privRaw);
  return { checksum: true, decrypted: true, records: o.records, parts: o.manifest.parts.map(p => p.name), created_at: o.manifest.created_at };
}

/* ── restore ── */
export async function restore({ file, privRaw, targetUrl, createRoles = false }) {
  const ver = toolVersion(PGBIN('pg_restore'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-restore-'));
  fs.chmodSync(dir, 0o700);
  const fds = new Map();
  const t0 = Date.now();
  try {
    const o = openContainer(file, privRaw, (part, data) => {
      if (!fds.has(part)) fds.set(part, fs.openSync(path.join(dir, 'part' + part + '.dump'), 'wx', 0o600));
      fs.writeSync(fds.get(part), data);
    });
    for (const fd of fds.values()) fs.closeSync(fd);
    fds.clear();
    const c = pgClient(targetUrl);
    await c.connect();
    try {
      const exists = (await c.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [SCHEMA])).rowCount;
      const ledger = (await c.query("SELECT to_regclass('public.payesh_schema_migrations') AS t")).rows[0].t;
      if (exists || ledger) throw new BackupError('target_not_empty', 'target already has ' + (exists ? 'schema ' + SCHEMA : 'a migration ledger') + ' — restore into an empty database');
      const missing = [];
      for (const r of ROLES) if (!(await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [r])).rowCount) missing.push(r);
      if (missing.length && !createRoles) throw new BackupError('roles_missing', 'roles missing on target: ' + missing.join(', ') + ' (use --create-roles)');
      for (const r of missing) await c.query(CREATE_ROLE[r]);
    } finally { await c.end().catch(() => {}); }
    const env = connEnv(targetUrl);
    const run = (bin, args) => spawnSync(PGBIN(bin), args, { env: Object.assign({}, process.env, env), encoding: 'utf8', maxBuffer: 64 << 20 });
    /* pg_restore newer than the target server (e.g. client 17 → server 16) emits
       `SET transaction_timeout`, which an older server rejects. Then: archive →
       SQL script (pg_restore -f), drop only that SET line, apply with psql in
       ONE transaction with ON_ERROR_STOP. Same objects, same data. */
    const major = s => Number((String(s).match(/(\d+)(?:\.\d+)?/) || [0, 0])[1]);
    const toolMajor = major(ver);
    const c3 = pgClient(targetUrl); await c3.connect();
    const serverMajor = Math.floor(Number((await c3.query('SHOW server_version_num')).rows[0].server_version_num) / 10000);
    await c3.end().catch(() => {});
    const viaScript = toolMajor > serverMajor;
    o.manifest.parts.forEach((pt, i) => {
      const part = path.join(dir, 'part' + i + '.dump');
      if (!viaScript) {
        const r = run('pg_restore', ['--no-password', '--exit-on-error', '--single-transaction', '-d', env.PGDATABASE, part]);
        if (r.status !== 0) throw new BackupError('pg_restore_failed', pt.name + ': ' + String(r.stderr).slice(0, 600));
        return;
      }
      const sql = part + '.sql';
      const g = run('pg_restore', ['-f', sql, part]);
      if (g.status !== 0) throw new BackupError('pg_restore_failed', pt.name + ' (script): ' + String(g.stderr).slice(0, 600));
      const txt = fs.readFileSync(sql, 'utf8').replace(/^SET transaction_timeout = [^;]*;$/m, '-- (row 111) SET transaction_timeout removed: target server ' + serverMajor + ' < pg_restore ' + toolMajor);
      fs.writeFileSync(sql, txt, { mode: 0o600 });
      const r = run('psql', ['-X', '-q', '--no-password', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-d', env.PGDATABASE, '-f', sql]);
      if (r.status !== 0) throw new BackupError('pg_restore_failed', pt.name + ' (psql): ' + String(r.stderr).slice(0, 600));
    });
    const c2 = pgClient(targetUrl);
    await c2.connect();
    let snap;
    try { snap = await snapshot(c2); } finally { await c2.end().catch(() => {}); }
    const diff = diffSnap(o.manifest.snapshot, snap);
    if (diff.length) throw new BackupError('restore_mismatch', 'restored database differs in: ' + diff.join(', '));
    return { ms: Date.now() - t0, pg_restore: ver, via: viaScript ? `psql script (pg_restore ${toolMajor} > server ${serverMajor})` : 'pg_restore', manifest: o.manifest, snapshot: snap, records: o.records };
  } finally {
    for (const fd of fds.values()) { try { fs.closeSync(fd); } catch (e) { /* closed */ } }
    for (const f of fs.readdirSync(dir)) {           /* overwrite, then delete the plaintext */
      const p = path.join(dir, f); const n = fs.statSync(p).size;
      try { const fd = fs.openSync(p, 'r+'); fs.writeSync(fd, Buffer.alloc(Math.min(n, 1 << 24))); fs.closeSync(fd); } catch (e) { /* best effort */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ── retention ── */
export function prune({ dir, keep = 7, monthly = 6, dryRun = false }) {
  const files = fs.readdirSync(dir).filter(f => /^payesh-backup-\d{8}T\d{6}Z\.e2b$/.test(f)).sort().reverse();
  const keepSet = new Set(files.slice(0, keep));
  const months = new Map();
  for (const f of files) { const m = f.slice(14, 20); if (!months.has(m)) months.set(m, f); }
  [...months.values()].slice(0, monthly).forEach(f => keepSet.add(f));
  const del = files.filter(f => !keepSet.has(f));
  if (!dryRun) for (const f of del) { fs.rmSync(path.join(dir, f)); fs.rmSync(path.join(dir, f.replace(/\.e2b$/, '.json')), { force: true }); }
  return { kept: [...keepSet].sort(), deleted: del };
}

/* ── monitoring: is the newest backup fresh enough and intact? ── */
export function status({ dir, maxAgeHours = 36, now = Date.now() }) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^payesh-backup-\d{8}T\d{6}Z\.e2b$/.test(f)).sort() : [];
  if (!files.length) return { ok: false, error: 'no_backup', dir };
  const newest = files[files.length - 1];
  const m = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(newest);
  const at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const ageH = Math.round((now - at) / 36e5 * 10) / 10;
  let intact = true, error = null;
  try { verifyFile(path.join(dir, newest), null); } catch (e) { intact = false; error = e.code; }
  const ok = intact && ageH <= maxAgeHours;
  return { ok, newest, age_hours: ageH, max_age_hours: maxAgeHours, intact, count: files.length, error: error || (ok ? null : 'backup_too_old') };
}

/* ── CLI ── */
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag = n => argv.includes('--' + n);
function needEnv(name) { const v = process.env[name]; if (!v) throw new BackupError('env_missing', `set ${name} (connection strings are read from the environment, never argv)`); return v; }

async function main() {
  const cmd = argv[0];
  if (cmd === 'keygen') {
    const dir = arg('out-dir'); if (!dir) throw new BackupError('usage', '--out-dir required');
    fs.mkdirSync(dir, { recursive: true });
    const k = x25519Keys();
    const pubF = path.join(dir, 'payesh-backup.pub'), privF = path.join(dir, 'payesh-backup.private.key');
    fs.writeFileSync(privF, '# payesh backup PRIVATE key (X25519) — keep offline; needed only to restore\n' + b64u(k.priv) + '\n', { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(pubF, b64u(k.pub) + '\n', { mode: 0o644, flag: 'wx' });
    console.log(JSON.stringify({ ok: true, kid: kidOf(k.pub), public: pubF, private: privF }));
  } else if (cmd === 'dump') {
    const pub = readKey(arg('pub') || '', 32, 'public key');
    const src = needEnv(arg('source-env', 'PAYESH_BACKUP_SOURCE_URL'));
    const r = await dump({ sourceUrl: src, pubRaw: pub, outDir: arg('out-dir', 'backups') });
    console.log(JSON.stringify({ ok: true, source: redact(src), file: r.file, size: r.sidecar.size, sha256: r.sidecar.sha256, ms: r.ms, counts: r.snapshot.counts }));
  } else if (cmd === 'verify') {
    const f = arg('file'); const k = arg('key');
    console.log(JSON.stringify(Object.assign({ ok: true, file: f }, verifyFile(f, k ? readKey(k, 32, 'private key') : null))));
  } else if (cmd === 'restore') {
    const tgt = needEnv(arg('target-env', 'PAYESH_RESTORE_TARGET_URL'));
    const r = await restore({ file: arg('file'), privRaw: readKey(arg('key') || '', 32, 'private key'), targetUrl: tgt, createRoles: flag('create-roles') });
    console.log(JSON.stringify({ ok: true, target: redact(tgt), ms: r.ms, via: r.via, counts: r.snapshot.counts, ledger: r.snapshot.ledger }));
  } else if (cmd === 'prune') {
    console.log(JSON.stringify(Object.assign({ ok: true }, prune({ dir: arg('dir', 'backups'), keep: Number(arg('keep', 7)), monthly: Number(arg('monthly', 6)), dryRun: flag('dry-run') }))));
  } else if (cmd === 'status') {
    const r = status({ dir: arg('dir', 'backups'), maxAgeHours: Number(arg('max-age-hours', 36)) });
    console.log(JSON.stringify(r));
    if (!r.ok) process.exitCode = 1;
  } else if (cmd === 'drill') {
    const { drill } = await import('./backup-drill-111.mjs');
    const ok = await drill({ freshCluster: flag('fresh-cluster') });
    process.exitCode = ok ? 0 : 1;
  } else {
    console.log('usage: backup-111.mjs keygen|dump|verify|restore|prune|status|drill  (see the header of this file)');
    process.exitCode = 2;
  }
}
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch(e => { console.error(JSON.stringify({ ok: false, error: e.code || 'error', message: String(e.message).slice(0, 500) })); process.exitCode = 1; });

export { Sealer, BackupError, x25519Keys, kidOf, b64u, openContainer, snapshot, connEnv, redact, readHeader, ROLES, SCHEMA };
