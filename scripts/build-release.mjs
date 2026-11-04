#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────────
   ساخت نسخه:
     ۱) هش sha256 همهٔ فایل‌های کلاینت
     ۲) releases/manifest.json  (نسخهٔ جاری + فایل‌ها)
     ۳) releases/history/<ver>.json  (برای محاسبهٔ دلتا)
     ۴) releases/payesh-local-windows-<ver>.zip
   اجرا: node scripts/build-release.mjs [--version 0.2.0]
   ─────────────────────────────────────────────────────────────────── */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = path.join(ROOT, 'client');
const RELEASES = path.join(ROOT, 'releases');
const HISTORY = path.join(RELEASES, 'history');

const args = process.argv.slice(2);
const vIdx = args.indexOf('--version');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = vIdx >= 0 ? args[vIdx + 1] : pkg.version;

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}
function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

fs.mkdirSync(RELEASES, { recursive: true });
fs.mkdirSync(HISTORY, { recursive: true });

/* ── فایل‌هایی که «درجا» به‌روزرسانی می‌شوند ──────────────────────────
   کلاینت + کد سرور + Hub + اسکریپت اجرا. هر فایل با مسیر کامل مخزن
   (client/app.js، server/index.js، …) تا آپدیت بتواند هر دو طرف را
   جدا و فقط با هش تغییرکرده‌ها بفرستد. */
const MANIFEST_DIRS = ['client', 'server', 'hub'];
const MANIFEST_FILES = ['package.json', 'start.bat', 'start.sh', 'install.bat', 'uninstall.bat'];

const kindOf = rel => (rel.startsWith('client/') ? 'client' : rel.startsWith('docs/') ? 'docs' : 'server');

const files = [
  ...MANIFEST_DIRS.flatMap(dir =>
    walk(path.join(ROOT, dir))
      .filter(f => !f.startsWith('icons/') || /\.png$/.test(f))
      .map(f => ({ path: dir + '/' + f, abs: path.join(ROOT, dir, f) }))),
  ...MANIFEST_FILES
    .filter(f => fs.existsSync(path.join(ROOT, f)))
    .map(f => ({ path: f, abs: path.join(ROOT, f) })),
]
  .sort((a, b) => (a.path < b.path ? -1 : 1))
  .map(f => ({ path: f.path, kind: kindOf(f.path), sha256: sha(f.abs), size: fs.statSync(f.abs).size }));

const sum = (list, pick) => list.filter(pick).reduce((a, f) => a + f.size, 0);
const manifest = {
  version: VERSION,
  built_at: new Date().toISOString(),
  shell: { android: VERSION },
  files,
  counts: {
    client: files.filter(f => f.kind === 'client').length,
    server: files.filter(f => f.kind === 'server').length,
  },
  client_size: sum(files, f => f.kind === 'client'),
  server_size: sum(files, f => f.kind === 'server'),
  total_size: files.reduce((a, f) => a + f.size, 0),
};

fs.writeFileSync(path.join(RELEASES, 'manifest.json'), JSON.stringify(manifest, null, 2));

/* تاریخچه: برای هر شمارهٔ نسخه یک «عکس فوری» نگه می‌داریم تا دلتا محاسبه شود.
   اگر فایل‌های یک نسخهٔ منتشرشده تغییر کنند، باید شمارهٔ نسخه بالا برود. */
const histFile = path.join(HISTORY, VERSION + '.json');
if (fs.existsSync(histFile)) {
  const prev = JSON.parse(fs.readFileSync(histFile, 'utf8'));
  const prevMap = new Map((prev.files || []).map(f => [f.path, f.sha256]));
  const diff = files.filter(f => prevMap.get(f.path) !== f.sha256).length;
  if (diff && !process.env.FORCE) {
    console.error(`\n⛔ نسخهٔ ${VERSION} قبلاً ساخته شده و ${diff} فایل تغییر کرده است.`);
    console.error('   شمارهٔ نسخه را بالا ببرید (npm version patch) یا با FORCE=1 اجرا کنید.\n');
    process.exit(1);
  }
}
fs.writeFileSync(histFile, JSON.stringify(manifest, null, 2));

console.log(`📦 manifest نسخهٔ ${VERSION} — ${files.length} فایل (کلاینت ${manifest.counts.client}، سرور ${manifest.counts.server})، ${(manifest.total_size / 1024).toFixed(1)}KB`);

/* ── بستهٔ ویندوز ── */
const stage = path.join(ROOT, '.build', 'stage');
fs.rmSync(path.join(ROOT, '.build'), { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

const copy = (rel) => {
  const src = path.join(ROOT, rel);
  const dst = path.join(stage, rel);
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
};

['server', 'client', 'install', 'hub', 'package.json', 'README.md',
 'start.bat', 'start.sh', 'install.bat', 'uninstall.bat', 'docs'].forEach(copy);
fs.mkdirSync(path.join(stage, 'releases'), { recursive: true });
fs.copyFileSync(path.join(RELEASES, 'manifest.json'), path.join(stage, 'releases', 'manifest.json'));
fs.mkdirSync(path.join(stage, 'releases', 'history'), { recursive: true });
fs.copyFileSync(histFile, path.join(stage, 'releases', 'history', path.basename(histFile)));

/* فایل‌های حذف‌شدنی در بسته نباشند */
for (const junk of ['data', 'node_modules', '.git']) {
  fs.rmSync(path.join(stage, junk), { recursive: true, force: true });
}

/* فقط آخرین بسته‌ها در پوشهٔ releases بمانند (تاریخچهٔ هش‌ها می‌ماند) */
for (const f of fs.readdirSync(RELEASES)) {
  if (/^payesh-local-(windows|src)-.*\.(zip|tar\.gz)$/.test(f) && !f.includes(VERSION)) {
    fs.rmSync(path.join(RELEASES, f), { force: true });
  }
}

const zipName = `payesh-local-windows-${VERSION}.zip`;
const zipPath = path.join(RELEASES, zipName);
fs.rmSync(zipPath, { force: true });
const r = spawnSync('zip', ['-r', '-q', '-9', zipPath, '.'], { cwd: stage });
if (r.status !== 0) {
  console.warn('⚠️  zip در دسترس نیست؛ بستهٔ ویندوز ساخته نشد.');
} else {
  const kb = (fs.statSync(zipPath).size / 1024).toFixed(0);
  console.log(`🪟 ${zipName} — ${kb}KB`);
  /* راهنمای نسخه‌ها برای صفحهٔ اول */
  const list = fs.readdirSync(RELEASES).filter(f => /^payesh-local-windows-.*\.zip$/.test(f)).sort().reverse();
  fs.writeFileSync(path.join(RELEASES, 'windows.json'), JSON.stringify({ latest: zipName, files: list }, null, 2));
}

/* ── بستهٔ سورس (بدون data) برای لینوکس/داکر ── */
const tgz = path.join(RELEASES, `payesh-local-src-${VERSION}.tar.gz`);
fs.rmSync(tgz, { force: true });
const t = spawnSync('tar', ['-czf', tgz, '-C', ROOT, 'server', 'client', 'install', 'hub', 'docs',
  'package.json', 'README.md', 'install.bat', 'start.bat', 'start.sh', 'releases/manifest.json'], {});
if (t.status === 0) console.log(`🐧 payesh-local-src-${VERSION}.tar.gz`);

console.log('✅ آماده است.');
