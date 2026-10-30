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

/* ── فایل‌های کلاینت ── */
const files = walk(CLIENT)
  .filter(f => !f.startsWith('icons/') || /\.png$/.test(f))
  .sort()
  .map(f => ({ path: f, sha256: sha(path.join(CLIENT, f)), size: fs.statSync(path.join(CLIENT, f)).size }));

const manifest = {
  version: VERSION,
  built_at: new Date().toISOString(),
  shell: { android: VERSION },
  files,
  total_size: files.reduce((a, f) => a + f.size, 0),
};

fs.writeFileSync(path.join(RELEASES, 'manifest.json'), JSON.stringify(manifest, null, 2));

/* تاریخچه: نسخه‌های قبلی دست‌نخورده می‌مانند تا دلتا محاسبه شود */
const histFile = path.join(HISTORY, VERSION + '.json');
if (!fs.existsSync(histFile)) fs.writeFileSync(histFile, JSON.stringify(manifest, null, 2));

console.log(`📦 manifest نسخهٔ ${VERSION} — ${files.length} فایل، ${(manifest.total_size / 1024).toFixed(1)}KB`);

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

['server', 'client', 'install', 'package.json', 'README.md'].forEach(copy);
fs.mkdirSync(path.join(stage, 'releases'), { recursive: true });
fs.copyFileSync(path.join(RELEASES, 'manifest.json'), path.join(stage, 'releases', 'manifest.json'));
fs.mkdirSync(path.join(stage, 'releases', 'history'), { recursive: true });
fs.copyFileSync(histFile, path.join(stage, 'releases', 'history', path.basename(histFile)));

/* فایل‌های حذف‌شدنی در بسته نباشند */
for (const junk of ['data', 'node_modules', '.git']) {
  fs.rmSync(path.join(stage, junk), { recursive: true, force: true });
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
const t = spawnSync('tar', ['-czf', tgz, '-C', ROOT, 'server', 'client', 'install', 'package.json', 'README.md', 'releases/manifest.json'], {});
if (t.status === 0) console.log(`🐧 payesh-local-src-${VERSION}.tar.gz`);

console.log('✅ آماده است.');
