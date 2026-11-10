#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   بستهٔ وب پنل مالک — payesh-owner-web.zip · PR‑4 · ردیف ۹۹ · ADR‑62
   محتوا (زیر پوشهٔ payesh-owner-web/):
     web/**                    SPA ایستا (همان apps/owner-panel/web)
     server/static-server.js   سرور ایستا + پروکسی same-origin (بدون وابستگی)
     START-HERE.txt            راه‌اندازی
     BUILD-INFO.json           commit، نسخه و sha256 هر فایل
   بدون آدرس/توکن/کلید؛ upstream فقط از PAYESH_PLATFORM_UPSTREAM خوانده می‌شود.
   قطعی: commit یکسان ⇒ zip بایت‌به‌بایت یکسان.

   اجرا: node apps/owner-panel/scripts/package-web.js --out <zip> [--commit <sha>]
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildZip } = require('./zip-lite.js');

const APP = path.resolve(__dirname, '..');
const ROOT = path.resolve(APP, '..', '..');
const PREFIX = 'payesh-owner-web/';
const EXCLUDE = /(^|\/)(\.DS_Store|Thumbs\.db|.*\.map)$/;

function walk(dir, base = dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full, base));
    else if (ent.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

const sha = b => crypto.createHash('sha256').update(b).digest('hex');

function collect({ commit = '', version } = {}) {
  const files = [];
  for (const rel of walk(path.join(APP, 'web')).sort()) {
    if (EXCLUDE.test(rel)) continue;
    files.push({ name: 'web/' + rel, data: fs.readFileSync(path.join(APP, 'web', rel)) });
  }
  files.push({ name: 'server/static-server.js', data: fs.readFileSync(path.join(APP, 'server', 'static-server.js')) });
  const v = version || JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  files.push({ name: 'START-HERE.txt', data: Buffer.from([
    'پنل مالک پایش — بستهٔ وب (فقط برای مالک پلتفرم)',
    '==============================================',
    '',
    'نیاز: Node.js 22 یا بالاتر. هیچ وابستگی npm لازم نیست.',
    '',
    '  PAYESH_PLATFORM_UPSTREAM=https://<gateway-پلتفرم> \\',
    '  PAYESH_OWNER_PANEL_PORT=8095 node server/static-server.js',
    '',
    'سپس همان مبدأ را در مرورگر یا در اپ ویندوز/Android پنل مالک وارد کنید.',
    'بدون PAYESH_PLATFORM_UPSTREAM، API با 503 upstream_not_configured بسته می‌ماند.',
    'برای دسترسی از بیرون، این سرور را پشت HTTPS قرار دهید؛ اپ‌ها فقط https می‌پذیرند.',
    '',
    'این بسته امضای دیجیتال ندارد؛ صحت را با SHA256SUMS همان انتشار بسنجید.',
    'نصب/اجرای واقعی روی دستگاه مالک هنوز تأیید نشده است [?].',
    '',
  ].join('\n'), 'utf8') });
  const manifest = files.map(f => ({ path: f.name, size: f.data.length, sha256: sha(f.data) }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  files.push({ name: 'BUILD-INFO.json', data: Buffer.from(JSON.stringify({
    name: 'payesh-owner-web', version: v, commit: String(commit || ''), adr: 'ADR-62', files: manifest,
  }, null, 2) + '\n', 'utf8') });
  return files.map(f => ({ name: PREFIX + f.name, data: f.data }));
}

function build(opts = {}) {
  return buildZip(collect(opts));
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const out = path.resolve(arg('out', path.join(ROOT, 'releases', 'owner', 'payesh-owner-web.zip')));
  const buf = build({ commit: arg('commit', process.env.GITHUB_SHA || '') });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
  console.log(`OWNER-WEB-ZIP ${path.basename(out)} bytes=${buf.length} sha256=${sha(buf)}`);
}

module.exports = { build, collect, PREFIX };
