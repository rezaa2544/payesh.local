#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   Row 120 — build the deployable bundle of the MULTI-TENANT Gateway
   (server/gateway.js + owner-panel platform API + admin/selfcheck tools),
   not the single-school server/index.js.

     node scripts/build-gateway-bundle.mjs [--out DIR] [--no-archive]
     → DIR/payesh-gateway/            (default DIR = .build/gateway-bundle)
     → DIR/payesh-gateway-<ver>.tar.gz (+ .zip when `zip` exists)

   What goes in (and only that):
     · the static require-closure of the entry points (relative requires
       followed file by file; a dynamic require outside the known entry
       files fails the build)
     · db/migrations/owner-panel/*.sql, the systemd unit, the owner doc
     · node_modules: the production dependency tree of `pg` WITHOUT optional
       dependencies (pg-cloudflare is never shipped — D-09)
     · generated: gateway-start.cjs, package.json, gateway.env.example
       (from deploy/gateway/env-catalog.json), START-HERE.txt,
       BUNDLE-MANIFEST.json (sha256 of every file)
   Refusals (exit 1): a file of the single-school server or tunnel in the
   closure, an env var used by the code but missing from the catalog (or
   the reverse), anything that looks like a secret, any *cloudflare*
   package, a dynamic require.
   ═══════════════════════════════════════════════════════════════════ */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BUNDLE_NAME = 'payesh-gateway';

/* entry points: start.cjs/admin.cjs load these through path.join(ROOT, …), so they are listed explicitly */
export const ENTRIES = [
  'deploy/gateway/start.cjs',
  'deploy/gateway/admin.cjs',
  'deploy/gateway/selfcheck.mjs',
  'server/gateway.js',
  'server/tenancy.js',
  'server/directory.js',
  'apps/owner-panel/scripts/create-operator.js',
];
/* files whose path.join(ROOT, …) requires are covered by ENTRIES above */
export const DYNAMIC_OK = new Set(['deploy/gateway/start.cjs', 'deploy/gateway/admin.cjs']);
/* the single-school server (SQLite, tunnel) must never ride along */
export const FORBIDDEN = ['server/index.js', 'server/db.js', 'server/start.js', 'server/tunnel.js', 'server/seed.js', 'server/sync.js', 'server/auth.js'];
export const EXTRA_FILES = [
  'deploy/gateway/env-catalog.json',
  'deploy/gateway/payesh-gateway.service',
  'docs/cloud/120-gateway-bundle.md',
  'db/migrations/owner-panel/README.md',
];

function strip(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** Static closure of relative requires/imports. */
export function closure(entries = ENTRIES, root = ROOT) {
  const files = new Set(), external = new Set(), dynamic = [];
  const resolveRel = (from, spec) => {
    let p = path.resolve(path.dirname(from), spec);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    for (const ext of ['.js', '.cjs', '.mjs', '.json']) if (fs.existsSync(p + ext)) return p + ext;
    const idx = path.join(p, 'index.js');
    if (fs.existsSync(idx)) return idx;
    throw new Error(`cannot resolve ${spec} from ${path.relative(root, from)}`);
  };
  const walk = (abs) => {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (files.has(rel)) return;
    files.add(rel);
    if (!/\.(c|m)?js$/.test(abs)) return;   /* assets (json, …) are copied, not parsed */
    const src = strip(fs.readFileSync(abs, 'utf8'));
    const specs = [];
    for (const m of src.matchAll(/\brequire\(\s*([^)]*?)\s*\)/g)) specs.push(m[1]);
    for (const m of src.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?(['"][^'"]+['"])/gm)) specs.push(m[1]);
    for (const m of src.matchAll(/\bimport\(\s*([^)]*?)\s*\)/g)) specs.push(m[1]);
    /* runtime assets read next to the module: path.join(__dirname, 'a', 'b.json') with literal parts */
    for (const m of src.matchAll(/\bpath\.(?:join|resolve)\(\s*__dirname\s*((?:,\s*['"][^'"]+['"]\s*)+)\)/g)) {
      const parts = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]);
      const asset = path.resolve(path.dirname(abs), ...parts);
      if (fs.existsSync(asset) && fs.statSync(asset).isFile()) walk(asset);
    }
    for (const a of specs) {
      const lit = a.match(/^['"]([^'"]+)['"]$/);
      if (!lit) { dynamic.push(`${rel}: ${a.slice(0, 80)}`); continue; }
      const s = lit[1];
      if (s.startsWith('.')) walk(resolveRel(abs, s));
      else external.add(s.startsWith('node:') ? s : s.split('/')[0].startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]);
    }
  };
  for (const e of entries) walk(path.resolve(root, e));
  return { files: [...files].sort(), external: [...external].sort(), dynamic };
}

/** Every env var name the given files read: process.env.X, env.X, process.env['X']. */
export function scanEnv(files, root = ROOT) {
  const names = new Set();
  for (const rel of files) {
    if (!/\.(c|m)?js$/.test(rel)) continue;
    const src = strip(fs.readFileSync(path.join(root, rel), 'utf8'));
    for (const m of src.matchAll(/\b(?:process\.)?env\.([A-Z][A-Z0-9_]+)\b/g)) names.add(m[1]);
    for (const m of src.matchAll(/\bprocess\.env\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g)) names.add(m[1]);
  }
  return names;
}

export function envDrift(files, catalog, root = ROOT) {
  const used = scanEnv(files, root);
  const listed = new Set(catalog.vars.map(v => v.name));
  return { used: [...used].sort(), missing: [...used].filter(n => !listed.has(n)).sort(), stale: [...listed].filter(n => !used.has(n)).sort() };
}

/** Production dependency tree of `pkg` (no optional/peer deps), as node_modules-relative dirs. */
export function prodDeps(pkg = 'pg', root = ROOT) {
  const out = new Set();
  const visit = (name, fromDir) => {
    let dir = null;
    for (let d = fromDir; ; d = path.dirname(d)) {
      const cand = path.join(d, 'node_modules', name);
      if (fs.existsSync(path.join(cand, 'package.json'))) { dir = cand; break; }
      if (d === path.dirname(d) || !d.startsWith(root)) break;
    }
    if (!dir) throw new Error('dependency not installed: ' + name + ' (run npm ci)');
    const rel = path.relative(root, dir).split(path.sep).join('/');
    if (out.has(rel)) return;
    out.add(rel);
    const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pj.dependencies || {})) visit(dep, dir);
  };
  visit(pkg, root);
  return [...out].sort();
}

const SECRET_PATTERNS = [
  ['db_url_with_password', /postgres(?:ql)?:\/\/[^\s:@/'"`<>]+:[^\s@'"`<>$]{3,}@/],
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
  ['github_token', /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/],
  ['aws_key', /\bAKIA[0-9A-Z]{16}\b/],
  ['otpauth_secret', /otpauth:\/\/totp\/[^\s'"`]*secret=[A-Z2-7]{16,}/],
];

/** Look for secrets in a staged directory. Returns [{ file, kind }]. */
export function scanSecrets(dir, catalog) {
  const found = [];
  const secretVars = new Set(catalog.vars.filter(v => v.secret).map(v => v.name));
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name);
      const rel = path.relative(dir, abs).split(path.sep).join('/');
      if (ent.isDirectory()) { walk(abs); continue; }
      if (/^\.env(\..*)?$/.test(ent.name) || /\.(pem|key|p12|pfx|jks|keystore)$/.test(ent.name)) found.push({ file: rel, kind: 'secret_file_name' });
      if (fs.statSync(abs).size > 2 * 1024 * 1024) continue;
      const text = fs.readFileSync(abs, 'utf8');
      for (const [kind, re] of SECRET_PATTERNS) if (re.test(text)) found.push({ file: rel, kind });
      if (/\.env\.example$|\.service$/.test(ent.name)) {
        for (const m of text.matchAll(/^\s*(?:Environment=)?"?([A-Z][A-Z0-9_]+)=([^\n"]*)/gm)) {
          if (secretVars.has(m[1]) && m[2].trim() && !/<[^<>]+>/.test(m[2])) found.push({ file: rel, kind: 'secret_value:' + m[1] });
        }
      }
    }
  };
  walk(dir);
  return found;
}

/** Refusal rules of the bundle (pure; unit-tested with crafted inputs). */
export function guard(cl, deps, catalog, root = ROOT) {
  const problems = [];
  for (const f of FORBIDDEN) if (cl.files.includes(f)) problems.push('single-school file in closure: ' + f);
  for (const d of cl.dynamic) if (!DYNAMIC_OK.has(d.split(':')[0])) problems.push('dynamic require: ' + d);
  const BUILTIN = ['crypto', 'fs', 'path', 'http', 'https', 'net', 'os', 'zlib', 'dns', 'url', 'child_process'];
  for (const e of cl.external) if (!e.startsWith('node:') && !BUILTIN.includes(e) && e !== 'pg') problems.push('unexpected external module: ' + e);
  const drift = envDrift(cl.files, catalog, root);
  if (drift.missing.length) problems.push('env vars used but not in env-catalog.json: ' + drift.missing.join(', '));
  if (drift.stale.length) problems.push('env-catalog.json lists vars the code no longer reads: ' + drift.stale.join(', '));
  for (const d of deps) if (/cloudflare/i.test(d)) problems.push('cloudflare package in bundle: ' + d);
  return problems;
}

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function envExample(catalog) {
  const L = ['# Payesh multi-tenant Gateway — environment (row 120).',
    '# Generated from deploy/gateway/env-catalog.json. Fill the <...> values in your host panel or in',
    '# /etc/payesh/gateway.env (chmod 600, outside the app folder). NEVER commit the filled file.', ''];
  for (const need of ['required', 'recommended', 'optional', 'admin']) {
    L.push(`# ── ${need} ──`);
    for (const v of catalog.vars.filter(x => x.need === need)) {
      L.push(`# ${v.fa}`);
      const value = v.secret ? `<${v.name.toLowerCase()}>` : v.default;
      L.push(`${need === 'required' || need === 'recommended' ? '' : '# '}${v.name}=${value}`);
    }
    L.push('');
  }
  return L.join('\n');
}

const START_HERE = (ver) => `پایش — Gateway چندمستأجری (ردیف ۱۲۰) · نسخهٔ ${ver}
══════════════════════════════════════════════════════
راهنمای کامل گام‌به‌گام: docs/cloud/120-gateway-bundle.md (همین بسته)

۱) Node 22 یا بالاتر.  PostgreSQL 14 یا بالاتر (روی همین میزبان یا مدیریت‌شده).
۲) یک‌بار، با اتصال مدیر:
     PAYESH_PG_ADMIN=postgres://<admin>:<pass>@<host>/<db> node deploy/gateway/admin.cjs migrate
     PAYESH_PG_ADMIN=… PAYESH_RUNTIME_PASSWORD=… PAYESH_PLATFORM_LOGIN_PASSWORD=… node deploy/gateway/admin.cjs logins
     PAYESH_PG_ADMIN=… node deploy/gateway/admin.cjs create-owner --login-id <شناسهٔ شما>
     PAYESH_PG_ADMIN=… node deploy/gateway/admin.cjs check
۳) متغیرهای محیطی: gateway.env.example (فقط required و recommended).
۴) فایل شروع (Startup file): gateway-start.cjs     ·   systemd: deploy/gateway/payesh-gateway.service
   پیش‌بررسی بدون بالا آمدن:  node gateway-start.cjs --check
۵) بررسی سرتاسری:  node deploy/gateway/selfcheck.mjs https://<نشانی>
   (برای آزمون کامل دو مدرسهٔ آزمایشی در پنل بسازید و --school/--code بدهید)

Cloudflare ممنوع (D-09). هر سرویس پولی فقط با تأیید کتبی مالک (D-40).
`;

export function build({ outDir = path.join(ROOT, '.build', 'gateway-bundle'), archive = true, log = console.log } = {}) {
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy/gateway/env-catalog.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const cl = closure();
  const deps = prodDeps('pg');
  const problems = guard(cl, deps, catalog);
  if (problems.length) return { ok: false, problems };

  const stage = path.join(outDir, BUNDLE_NAME);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const copy = (rel) => { const dst = path.join(stage, rel); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(path.join(ROOT, rel), dst); };
  for (const f of cl.files) copy(f);
  for (const f of EXTRA_FILES) copy(f);
  for (const f of fs.readdirSync(path.join(ROOT, 'db/migrations/owner-panel'))) if (f.endsWith('.sql')) copy('db/migrations/owner-panel/' + f);
  /* runtime files + licence only: package docs (README/CHANGELOG) carry example connection strings */
  const keepDep = (src) => { const b = path.basename(src); return !/\.(md|markdown)$/i.test(b) || /^licen[cs]e/i.test(b); };
  for (const d of deps) fs.cpSync(path.join(ROOT, d), path.join(stage, d), { recursive: true, filter: keepDep });
  const pgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/pg/package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(stage, 'gateway-start.cjs'),
    "'use strict';\n/* Startup file for host panels / Passenger / systemd (row 120). See START-HERE.txt. */\nrequire('./deploy/gateway/start.cjs').main();\n");
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
    name: BUNDLE_NAME, version: pkg.version, private: true, description: 'Payesh multi-tenant Gateway bundle (row 120)',
    main: 'gateway-start.cjs', engines: { node: '>=22' },
    scripts: { start: 'node gateway-start.cjs', check: 'node gateway-start.cjs --check', selfcheck: 'node deploy/gateway/selfcheck.mjs' },
    dependencies: { pg: pgVersion },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(stage, 'gateway.env.example'), envExample(catalog));
  fs.writeFileSync(path.join(stage, 'START-HERE.txt'), START_HERE(pkg.version));

  const secrets = scanSecrets(stage, catalog);
  if (secrets.length) return { ok: false, problems: secrets.map(s => `secret-like content: ${s.file} (${s.kind})`) };

  const listing = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) walk(abs);
      else listing.push({ path: path.relative(stage, abs).split(path.sep).join('/'), bytes: fs.statSync(abs).size, sha256: sha256(abs) });
    }
  };
  walk(stage);
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const manifest = { bundle: BUNDLE_NAME, version: pkg.version, row: 120, git_sha: git.status === 0 ? git.stdout.trim() : 'unknown',
    entry: 'gateway-start.cjs', node: '>=22', dependencies: deps.map(d => d.replace(/^node_modules\//, '')),
    excluded: ['pg-cloudflare (optional; Cloudflare runtime only — D-09)', 'server/index.js and the single-school SQLite server'],
    env_vars: catalog.vars.length, files: listing };
  fs.writeFileSync(path.join(stage, 'BUNDLE-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');

  const archives = [];
  if (archive) {
    const tgz = path.join(outDir, `${BUNDLE_NAME}-${pkg.version}.tar.gz`);
    fs.rmSync(tgz, { force: true });
    const t = spawnSync('tar', ['-czf', tgz, '-C', outDir, BUNDLE_NAME]);
    if (t.status === 0) archives.push(tgz); else problems.push('tar failed: ' + String(t.stderr || '').slice(0, 120));
    const zipPath = path.join(outDir, `${BUNDLE_NAME}-${pkg.version}.zip`);
    fs.rmSync(zipPath, { force: true });
    const z = spawnSync('zip', ['-r', '-q', '-9', zipPath, BUNDLE_NAME], { cwd: outDir });
    if (!z.error && z.status === 0) archives.push(zipPath);
  }
  log(`GATEWAY-BUNDLE ${problems.length ? 'FAILED' : 'OK'} files=${listing.length + 1} closure=${cl.files.length} deps=${deps.length} env=${catalog.vars.length} → ${path.relative(ROOT, stage) || stage}`);
  for (const a of archives) log('  archive: ' + (path.relative(ROOT, a) || a));
  return { ok: problems.length === 0, problems, stage, manifest, archives, closure: cl, deps };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--out');
  const r = build({ outDir: i >= 0 ? path.resolve(args[i + 1]) : undefined, archive: !args.includes('--no-archive') });
  if (!r.ok) { for (const p of r.problems) console.error('  ✗ ' + p); console.error('GATEWAY-BUNDLE FAILED'); process.exit(1); }
}
