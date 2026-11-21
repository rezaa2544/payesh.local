#!/usr/bin/env node
// Row 169 (D-50) — gate for the 32-bit Windows edition (web32). Inspects the REAL assembled
// folder or the published .zip, never source:
//   * the program (payesh_app.exe | payesh_owner.exe) and libcef.dll are 32-bit PE files
//     (machine 0x014c), so they run on 32-bit Windows 7 SP1 – 10;
//   * the Chromium runtime files are complete (CEF 109: icudtl.dat, snapshots, paks, fa locale);
//   * web\ is a Flutter web build of THIS app: index.html → flutter_bootstrap.js → main.dart.js
//     using window.payeshHost, CanvasKit present, no CDN (fonts/CanvasKit local);
//     school app: sqlite3mc.wasm with the pinned SHA-256 (encrypted database);
//   * nothing that D-49 forbids for the native channels sneaks in: no node.exe, no Node server,
//     no WebView2, no node_modules — the UI is the same Flutter code as the 64-bit build.
// Usage: node tools/web32/web32-gate.mjs --app app|owner <dir|zip> [--version 0.2.N]
// Last line: WEB32-GATE-OK app=<id> files=N bytes=B | WEB32-GATE-FAIL <why>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readZip } from '../native-independence-gate.mjs';

export const SQLITE3MC_SHA256 = '408a1d9bf8071bfb6e91aba005e6c8e2072c240784e1d199bbd7eb441dd5ea94';
const EXE = { app: 'payesh_app.exe', owner: 'payesh_owner.exe' };
const RUNTIME = [
  'libcef.dll', 'chrome_elf.dll', 'icudtl.dat', 'resources.pak', 'chrome_100_percent.pak',
  'chrome_200_percent.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'libEGL.dll',
  'libGLESv2.dll', 'locales/fa.pak', 'locales/en-US.pak',
];
const WEB = ['web/index.html', 'web/flutter_bootstrap.js', 'web/flutter.js', 'web/main.dart.js',
  'web/canvaskit/canvaskit.wasm', 'web/canvaskit/chromium/canvaskit.wasm', 'web/assets/FontManifest.json'];
const FORBIDDEN = [/(^|\/)node\.exe$/i, /(^|\/)node_modules\//i, /(^|\/)WebView2Loader\.dll$/i,
  /Microsoft\.Web\.WebView2/i, /(^|\/)server\/index\.js$/i, /(^|\/)client\/index\.html$/i];

export function peMachine(buf) {
  if (buf.length < 64 || buf.readUInt16LE(0) !== 0x5a4d) return null;
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 6 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) return null;
  return buf.readUInt16LE(pe + 4);
}

export function gate(files, app, version) {
  const bad = [];
  const has = (p) => files.has(p);
  const exe = EXE[app];
  if (!exe) return ['unknown --app ' + app];
  for (const p of [exe, ...RUNTIME, ...WEB]) if (!has(p)) bad.push('missing ' + p);
  for (const p of files.keys()) for (const re of FORBIDDEN) if (re.test(p)) bad.push('forbidden ' + p);
  for (const p of [exe, 'libcef.dll', 'chrome_elf.dll']) {
    if (!has(p)) continue;
    const m = peMachine(files.get(p)());
    if (m !== 0x014c) bad.push(`${p} is not a 32-bit (x86) program (machine 0x${(m ?? 0).toString(16)})`);
  }
  if (has('web/index.html') && !/flutter_bootstrap\.js/.test(files.get('web/index.html')().toString('utf8'))) bad.push('index.html does not start Flutter');
  if (has('web/main.dart.js')) {
    const js = files.get('web/main.dart.js')().toString('latin1');
    if (!js.includes('payeshHost')) bad.push('main.dart.js does not use window.payeshHost (not the web32 build)');
  }
  if (has('web/flutter_bootstrap.js') && !/"useLocalCanvasKit":\s*true/.test(files.get('web/flutter_bootstrap.js')().toString('utf8'))) {
    bad.push('CanvasKit would load from a CDN (build with --no-web-resources-cdn)');
  }
  if (app === 'app') {
    if (!has('web/sqlite3mc.wasm')) bad.push('missing web/sqlite3mc.wasm (encrypted database)');
    else {
      const h = crypto.createHash('sha256').update(files.get('web/sqlite3mc.wasm')()).digest('hex');
      if (h !== SQLITE3MC_SHA256) bad.push('sqlite3mc.wasm sha256 ' + h);
    }
  }
  if (version && has('web/version.json')) {
    const v = JSON.parse(files.get('web/version.json')().toString('utf8'));
    if (`${v.version}` !== version) bad.push(`web/version.json version ${v.version} != ${version}`);
  }
  return bad;
}

function load(input) {
  const files = new Map();
  if (fs.statSync(input).isDirectory()) {
    (function walk(rel) {
      for (const e of fs.readdirSync(path.join(input, rel), { withFileTypes: true })) {
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) walk(r);
        else files.set(r, () => fs.readFileSync(path.join(input, r)));
      }
    })('');
  } else {
    const z = readZip(fs.readFileSync(input));
    for (const e of z.entries) {
      if (e.name.endsWith('/')) continue;
      files.set(e.name.replace(/\\/g, '/'), () => z.data(e));
    }
  }
  return files;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const a = process.argv.slice(2);
  const app = a[a.indexOf('--app') + 1];
  const vi = a.indexOf('--version');
  const version = vi >= 0 ? a[vi + 1] : null;
  const input = a.filter((x, i) => !x.startsWith('--') && a[i - 1] !== '--app' && a[i - 1] !== '--version')[0];
  if (!input || !fs.existsSync(input)) { console.log('WEB32-GATE-FAIL no input'); process.exit(2); }
  const files = load(input);
  const bad = gate(files, app, version);
  let bytes = 0;
  for (const f of files.values()) bytes += f().length;
  if (bad.length) { for (const b of bad) console.log('  ✗ ' + b); console.log('WEB32-GATE-FAIL ' + bad.length + ' problem(s)'); process.exit(1); }
  console.log(`WEB32-GATE-OK app=${app} files=${files.size} bytes=${bytes}`);
}
