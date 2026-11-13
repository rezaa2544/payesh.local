#!/usr/bin/env node
// مانیفست به‌روزرسانی پنل مالک (ADR 126 §۱۲) — فقط فایل‌های تغییرکرده دانلود می‌شوند.
//
//   node tools/owner-update-manifest.mjs --dir <Release> --out <owner-out> --build <run_number> --commit <sha>
//        [--android <payesh-owner.apk>] [--check <owner-update.json> --blobs <dir>] [--name owner|app]
//
// ردیف ۱۴۸: --name app ⇒ همان قالب برای برنامهٔ مدرسه: schema 'payesh-app-update/1'،
// <out>/app-update.json و <out>/app-files/ (پیش‌فرض owner — رفتار قبلی بدون تغییر).
//
// خروجی:
//   <out>/owner-update.json   {schema:'payesh-owner-update/1', build, commit, files:[{path,sha256,size,gz_size}], android?}
//   <out>/owner-files/<sha256>.gz   هر فایل یک بار (gzip قطعی: mtime=0) — نام = هش محتوای اصلی
// --check: مانیفست موجود را با پوشهٔ blobs بازبینی می‌کند (هر blob باز و هش می‌شود) — پیش از انتشار.
// Last line: OWNER-UPDATE-MANIFEST-OK files=N bytes=B gz=G  |  OWNER-UPDATE-MANIFEST-FAIL <why>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const NAMES = { owner: 'payesh-owner-update/1', app: 'payesh-app-update/1' };
const MAX_FILES = 4000;
const MAX_FILE = 256 * 1024 * 1024;
/* همان قاعدهٔ owner_update.dart (_pathRe) */
const PATH_RE = /^[A-Za-z0-9._+\-]+(\/[A-Za-z0-9._+\-]+)*$/;
/* فایل‌های نصب‌کننده نه بخشی از برنامه‌اند و نه باید بازنویسی شوند */
const SKIP = [/^unins\d+\.(exe|dat|msg)$/i];

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const fail = (why) => { console.log('OWNER-UPDATE-MANIFEST-FAIL ' + why); process.exit(1); };
const NAME = args.name || 'owner';
if (!NAMES[NAME]) fail('--name ' + NAME);
const SCHEMA = NAMES[NAME];
const MANIFEST = NAME + '-update.json';
const BLOBS = NAME + '-files';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function check(manifestFile, blobs) {
  const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (m.schema !== SCHEMA) fail('schema');
  if (!Number.isSafeInteger(m.build) || m.build <= 0) fail('build');
  if (!/^[0-9a-f]{40}$/.test(m.commit || '')) fail('commit');
  if (!Array.isArray(m.files) || !m.files.length || m.files.length > MAX_FILES) fail('files');
  const seen = new Set();
  let bytes = 0, gz = 0;
  for (const f of m.files) {
    if (!PATH_RE.test(f.path) || f.path.split('/').some(p => p === '.' || p === '..')) fail('path ' + f.path);
    if (seen.has(f.path.toLowerCase())) fail('duplicate ' + f.path);
    seen.add(f.path.toLowerCase());
    const blob = path.join(blobs, f.sha256 + '.gz');
    if (!fs.existsSync(blob)) fail('missing blob ' + f.sha256);
    const g = fs.readFileSync(blob);
    if (g.length !== f.gz_size) fail('gz_size ' + f.path);
    const raw = zlib.gunzipSync(g);
    if (raw.length !== f.size || sha(raw) !== f.sha256) fail('hash ' + f.path);
    bytes += f.size; gz += f.gz_size;
  }
  if (m.android && (!/^[0-9a-f]{64}$/.test(m.android.sha256) || !(m.android.size > 0))) fail('android');
  return { files: m.files.length, bytes, gz };
}

if (args.check) {
  const r = check(args.check, args.blobs || path.join(path.dirname(args.check), BLOBS));
  console.log(`OWNER-UPDATE-MANIFEST-OK files=${r.files} bytes=${r.bytes} gz=${r.gz}`);
  process.exit(0);
}

const dir = args.dir, out = args.out;
const build = Number(args.build);
const commit = String(args.commit || '');
if (!dir || !fs.statSync(dir).isDirectory()) fail('--dir');
if (!out) fail('--out');
if (!Number.isSafeInteger(build) || build <= 0) fail('--build');
if (!/^[0-9a-f]{40}$/.test(commit)) fail('--commit');

const list = [];
(function walk(rel) {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) walk(r);
    else if (e.isFile() && !SKIP.some(re => re.test(r))) list.push(r);
  }
})('');
if (!list.length || list.length > MAX_FILES) fail('file count ' + list.length);

const blobs = path.join(out, BLOBS);
fs.mkdirSync(blobs, { recursive: true });
const files = [];
for (const p of list) {
  if (!PATH_RE.test(p)) fail('unsupported path ' + p);
  const raw = fs.readFileSync(path.join(dir, p));
  if (raw.length > MAX_FILE) fail('too large ' + p);
  const h = sha(raw);
  const gz = zlib.gzipSync(raw, { level: 9 }); /* Node: سرآیند gzip با mtime=0 ⇒ قطعی */
  const b = path.join(blobs, h + '.gz');
  if (!fs.existsSync(b)) fs.writeFileSync(b, gz);
  files.push({ path: p, sha256: h, size: raw.length, gz_size: gz.length });
}
const m = { schema: SCHEMA, build, commit, files };
if (args.android) {
  const a = fs.readFileSync(args.android);
  m.android = { sha256: sha(a), size: a.length };
}
fs.writeFileSync(path.join(out, MANIFEST), JSON.stringify(m, null, 1) + '\n');
const r = check(path.join(out, MANIFEST), blobs);
console.log(`OWNER-UPDATE-MANIFEST-OK files=${r.files} bytes=${r.bytes} gz=${r.gz}`);
