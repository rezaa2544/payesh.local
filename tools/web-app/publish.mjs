#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
//  Row 199 — publishes the browser edition of the school app (the SAME `flutter build web`
//  output the 32-bit Windows edition ships, apps/payesh/app/build/web) to the website bucket
//  behind https://app.payeshschool.ir (Arvan Object Storage, website mode, public-read policy).
//
//  usage: node tools/web-app/publish.mjs <build/web dir>
//  env:   PAYESH_WEB_S3_ACCESS_KEY, PAYESH_WEB_S3_SECRET            (never printed)
//         PAYESH_WEB_S3_ENDPOINT (default https://s3.ir-central1.arvanstorage.ir)
//         PAYESH_WEB_BUCKET      (default payesh-app)
//         PAYESH_WEB_DRY=1       only check the folder, upload nothing
//
//  Fail-closed:
//   · the folder must be a real Flutter build of the school app (flutter_bootstrap.js with
//     useLocalCanvasKit, main.dart.js, payesh_idb.js, sqlite3mc.wasm, canvaskit) — never a stub;
//   · Arvan's CDN in front of the domain caches every file except HTML, `no-cache` or not
//     (main.dart.js stayed the old build after a publish). So each build goes under its own
//     folder v/<version>-<build>-<hash>/ (immutable, cacheable) and only the root index.html —
//     never cached — changes: its <base href> points at the new folder, so a reload IS the
//     update. version.json is also kept at the root for status checks;
//   · every file is uploaded with its content type (application/wasm for streaming compile);
//   · index.html goes LAST, so a visitor never gets a new page with old scripts;
//   · the previous build's folder is kept (open tabs still load their lazy files), older ones go;
//   · the old «دریافت برنامه» page, if it is still the bucket's index.html, is kept as
//     download/index.html (https://app.payeshschool.ir/download/);
//   · keys the new build no longer has are deleted afterwards (download/ and payesh/ kept);
//   · every uploaded object is read back (HEAD: size + content type) and the public URL of
//     index.html + version.json is fetched unsigned — else exit ≠ 0.
// ═══════════════════════════════════════════════════════════════════
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2];
if (!DIR || !fs.existsSync(path.join(DIR, 'index.html'))) fail('usage: publish.mjs <build/web dir>');
const ENDPOINT = process.env.PAYESH_WEB_S3_ENDPOINT || 'https://s3.ir-central1.arvanstorage.ir';
const BUCKET = process.env.PAYESH_WEB_BUCKET || 'payesh-app';
const AK = process.env.PAYESH_WEB_S3_ACCESS_KEY || '';
const SK = process.env.PAYESH_WEB_S3_SECRET || '';
const DRY = process.env.PAYESH_WEB_DRY === '1';
const KEEP = ['download/', 'payesh/'];

function fail(m) { console.error('WEB-APP-PUBLISH-FAIL ' + m); process.exit(1); }

// ── 1) the folder is the real school app ──
const must = ['index.html', 'main.dart.js', 'flutter_bootstrap.js', 'flutter.js', 'payesh_idb.js', 'sqlite3mc.wasm',
  'version.json', 'canvaskit/canvaskit.js', 'canvaskit/canvaskit.wasm', 'assets/FontManifest.json'];
for (const f of must) if (!fs.existsSync(path.join(DIR, f))) fail('missing ' + f);
const boot = fs.readFileSync(path.join(DIR, 'flutter_bootstrap.js'), 'utf8');
if (!boot.includes('"useLocalCanvasKit":true')) fail('flutter_bootstrap.js must use the local CanvasKit');
const index = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
if (!index.includes('flutter_bootstrap.js') || !index.includes('payesh_idb.js')) fail('index.html is not the school app');
if (!fs.readFileSync(path.join(DIR, 'assets/FontManifest.json'), 'utf8').includes('Vazirmatn')) fail('Vazirmatn font missing');
const version = JSON.parse(fs.readFileSync(path.join(DIR, 'version.json'), 'utf8'));
if (fs.statSync(path.join(DIR, 'main.dart.js')).size < 1_000_000) fail('main.dart.js too small');
if (!/<base href="\/">/.test(index)) fail('index.html must have <base href="/"> (flutter build web default)');
const BUILD_ID = [version.version, version.build_number || '0',
  crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, 'main.dart.js'))).update(boot).digest('hex').slice(0, 10)].join('-');
const PREFIX = `v/${BUILD_ID}/`;
const rootIndex = Buffer.from(index.replace('<base href="/">', `<base href="/${PREFIX}">`), 'utf8');

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const built = walk(DIR).map((p) => ({ p, rel: path.relative(DIR, p).split(path.sep).join('/') }))
  .filter((f) => !f.rel.endsWith('.symbols') && f.rel !== '.last_build_id' && f.rel !== 'index.html');
const IMMUTABLE = 'public, max-age=31536000, immutable';
// every object: { key, data() , size, type, cache }
const files = [
  ...built.map((f) => ({ key: PREFIX + f.rel, data: () => fs.readFileSync(f.p), size: fs.statSync(f.p).size, cache: IMMUTABLE })),
  { key: 'version.json', data: () => fs.readFileSync(path.join(DIR, 'version.json')), size: fs.statSync(path.join(DIR, 'version.json')).size, cache: 'no-cache' },
  { key: 'index.html', data: () => rootIndex, size: rootIndex.length, cache: 'no-cache' },
];
const total = files.reduce((n, f) => n + f.size, 0);
console.log(`folder ok: ${files.length} files, ${(total / 1048576).toFixed(1)} MB, version ${version.version}+${version.build_number || ''}, folder ${PREFIX}`);
if (DRY) { console.log('WEB-APP-PUBLISH-DRY-OK'); process.exit(0); }
if (!AK || !SK) fail('PAYESH_WEB_S3_ACCESS_KEY / PAYESH_WEB_S3_SECRET not set');

// ── 2) SigV4 (path style) ──
const host = new URL(ENDPOINT).host, region = 'us-east-1';
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const sha = (d) => crypto.createHash('sha256').update(d).digest('hex');
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const keyPath = (k) => '/' + BUCKET + (k ? '/' + k.split('/').map(enc).join('/') : '');

async function s3(method, key, { q = {}, body = Buffer.alloc(0), headers = {} } = {}) {
  const amz = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''), day = amz.slice(0, 8);
  const qs = Object.keys(q).sort().map((k) => enc(k) + '=' + enc(q[k])).join('&');
  const ph = sha(body);
  const hdr = { host, 'x-amz-content-sha256': ph, 'x-amz-date': amz };
  for (const [k, v] of Object.entries(headers)) hdr[k.toLowerCase()] = String(v);
  const names = Object.keys(hdr).sort();
  const canon = [method, keyPath(key), qs, names.map((n) => n + ':' + hdr[n].trim() + '\n').join(''), names.join(';'), ph].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const sig = crypto.createHmac('sha256', hmac(hmac(hmac(hmac('AWS4' + SK, day), region), 's3'), 'aws4_request'))
    .update(['AWS4-HMAC-SHA256', amz, scope, sha(canon)].join('\n')).digest('hex');
  const h = { ...hdr, authorization: `AWS4-HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}` };
  delete h.host;
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`https://${host}${keyPath(key)}${qs ? '?' + qs : ''}`, { method, headers: h, body: method === 'PUT' ? body : undefined, signal: AbortSignal.timeout(180_000) });
      const buf = Buffer.from(await r.arrayBuffer());
      if (r.status >= 500 && i < 4) throw new Error('HTTP ' + r.status);
      return { status: r.status, headers: r.headers, body: buf };
    } catch (e) {
      if (i >= 4) throw e;
      await new Promise((z) => setTimeout(z, 2000 * (i + 1)));
    }
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream', '.frag': 'application/octet-stream', '.webmanifest': 'application/manifest+json',
};
const typeOf = (k) => TYPES[path.extname(k).toLowerCase()] || (k.endsWith('NOTICES') ? 'text/plain; charset=utf-8' : 'application/octet-stream');

// ── 3) keep the old downloads page; remember which build folder is live now ──
const old = await s3('GET', 'index.html');
const liveBase = old.status === 200 ? ((old.body.toString('utf8').match(/<base href="\/([^"]*)">/) || [])[1] ?? null) : null;
if (old.status === 200 && !old.body.toString('utf8').includes('flutter_bootstrap.js')) {
  const r = await s3('PUT', 'download/index.html', { body: old.body, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-amz-acl': 'public-read' } });
  if (r.status !== 200) fail('keeping the downloads page: HTTP ' + r.status);
  console.log('kept the previous page as download/index.html');
}

// ── 4) upload (index.html last) ──
let done = 0;
const queue = files.filter((f) => f.key !== 'index.html' && f.key !== 'version.json');
async function put(f) {
  const body = f.data();
  const r = await s3('PUT', f.key, { body, headers: { 'content-type': typeOf(f.key), 'cache-control': f.cache, 'x-amz-acl': 'public-read' } });
  if (r.status !== 200) fail(`PUT ${f.key}: HTTP ${r.status} ${r.body.toString().slice(0, 200)}`);
  done++;
}
await Promise.all(Array.from({ length: 6 }, async () => { for (let f; (f = queue.shift());) await put(f); }));
await put(files.find((f) => f.key === 'version.json'));
await put(files.find((f) => f.key === 'index.html'));
console.log(`uploaded ${done} files`);

// ── 5) delete what the new build no longer has ──
const want = new Set(files.map((f) => f.key));
async function listAll() {
  const out = new Map();
  for (let marker = ''; ;) {
    const r = await s3('GET', '', { q: marker ? { marker } : {} });
    if (r.status !== 200) fail('LIST: HTTP ' + r.status);
    const x = r.body.toString();
    const rows = [...x.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => [
      (m[1].match(/<Key>([^<]+)<\/Key>/) || [])[1]?.replace(/&amp;/g, '&'),
      Number((m[1].match(/<Size>(\d+)<\/Size>/) || [])[1]),
    ]).filter((e) => e[0]);
    for (const [k, n] of rows) out.set(k, n);
    if (!/<IsTruncated>true<\/IsTruncated>/.test(x) || !rows.length) break;
    marker = rows[rows.length - 1][0];
  }
  return out;
}
const listed = [...(await listAll()).keys()];
// the build that was live until a moment ago stays one more round (tabs opened before the swap)
const keepPrev = (k) => liveBase === '' ? !k.startsWith('v/') : (liveBase && liveBase.startsWith('v/') && k.startsWith(liveBase));
let removed = 0;
for (const k of listed) {
  if (want.has(k) || KEEP.some((p) => k.startsWith(p)) || keepPrev(k)) continue;
  const r = await s3('DELETE', k);
  if (r.status !== 204 && r.status !== 200) fail(`DELETE ${k}: HTTP ${r.status}`);
  removed++;
}
console.log(`removed ${removed} stale objects`);

// ── 6) read back: sizes from the listing (Arvan's HEAD has no usable content-length), types by HEAD ──
const sizes = await listAll();
for (const f of files) {
  const size = sizes.get(f.key);
  if (size !== f.size) fail(`read-back ${f.key}: size ${size} ≠ ${f.size}`);
  const r = await s3('HEAD', f.key);
  if (r.status !== 200) fail(`read-back ${f.key}: HTTP ${r.status}`);
  if (!String(r.headers.get('content-type') || '').startsWith(typeOf(f.key).split(';')[0])) fail(`content type of ${f.key}: ${r.headers.get('content-type')}`);
}
const pub = `https://${BUCKET}.${host}`;
const pi = await fetch(pub + '/index.html', { cache: 'no-store' });
const pv = await fetch(pub + '/version.json', { cache: 'no-store' });
const pit = await pi.text();
const pvj = await pv.json().catch(() => ({}));
if (pi.status !== 200 || !pit.includes('flutter_bootstrap.js')) fail('public index.html is not the app (HTTP ' + pi.status + ')');
if (!pit.includes(`<base href="/${PREFIX}">`)) fail('public index.html does not point at ' + PREFIX);
const pm = await fetch(`${pub}/${PREFIX}main.dart.js`, { method: 'HEAD' });
if (pm.status !== 200) fail(`public ${PREFIX}main.dart.js: HTTP ${pm.status}`);
if (pvj.version !== version.version) fail(`public version.json ${pvj.version} ≠ ${version.version}`);
console.log(`WEB-APP-PUBLISH-OK bucket=${BUCKET} files=${files.length} version=${version.version}+${version.build_number || ''} folder=${PREFIX} url=${pub}/`);
