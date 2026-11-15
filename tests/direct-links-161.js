#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 161 — every download link goes STRAIGHT to the file.

     DL-01  every release link in the user-facing surfaces (README, site/, client/,
            server/, install/, Flutter lib/) is releases/download/<tag>/<file> —
            never a release page (releases, releases/tag/…, releases/latest)
     DL-02  each <tag>/<file> is really uploaded by its publisher (the ALLOWED set of
            school-native-publish.yml / owner-native-publish.yml / build.yml)
     DL-03  no third-party "download page" (tailscale.com/download, nodejs.org/…/download,
            …) — the installer file itself is linked
     DL-04  the school APK is linked everywhere the school app is offered (README,
            download site, install page, QR/pairing card)
     DL-05  mutants: each forbidden change turns the matching check red
     DL-06  (PAYESH_LIVE_LINKS=1 only) each link answers with a file, not an HTML page
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPO = 'rezaa2544/payesh.local';
let passed = 0, failed = 0;
const pending = [];
function check(id, desc, fn) {
  pending.push((async () => {
    try { const d = await fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
    catch (e) { failed++; console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e)}`); }
  }));
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── the surfaces a person can click / scan / be sent to ───────────────
function walk(dir, exts, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) { if (!/^(node_modules|build|\.dart_tool|test|fixtures)$/.test(e.name)) walk(rel, exts, out); }
    else if (exts.includes(path.extname(e.name))) out.push(rel);
  }
  return out;
}
function surfaces() {
  const files = ['README.md'];
  walk('site', ['.html', '.js'], files);
  walk('client', ['.html', '.js'], files);
  walk('server', ['.js'], files);
  walk('install', ['.ps1', '.sh', '.html', '.md'], files);
  for (const app of ['app', 'owner']) walk(`apps/payesh/${app}/lib`, ['.dart'], files);
  walk('apps/payesh/packages', ['.dart'], files).length;
  return [...new Set(files)].filter((f) => !/\/test\//.test(f));
}

// ── publishers: tag → the exact set of files they leave on the release ──
function allowedSet(yml) {
  const line = yml.split('\n').find((l) => /^\s+ALLOWED="/.test(l));
  assert(line, 'no ALLOWED= line');
  return new Set(line.match(/ALLOWED="([^"]*)"/)[1].split(/\s+/).filter(Boolean));
}
// row 163: the school database server has its own channel, written by the same publisher
function serverAllowedSet(yml) {
  const line = yml.split('\n').find((l) => /^\s+SERVER_ALLOWED="/.test(l));
  assert(line, 'no SERVER_ALLOWED= line');
  return new Set(line.match(/SERVER_ALLOWED="([^"]*)"/)[1].split(/\s+/).filter(Boolean));
}
function publishers(over = {}) {
  return {
    'native-continuous': allowedSet(over.school || read('.github/workflows/school-native-publish.yml')),
    'school-server-continuous': serverAllowedSet(over.school || read('.github/workflows/school-native-publish.yml')),
    'owner-continuous': allowedSet(over.owner || read('.github/workflows/owner-native-publish.yml')),
    continuous: allowedSet(over.cloud || read('.github/workflows/build.yml')),
  };
}
// content-addressed blob bases for the in-app delta updater (not a link a person opens)
const BLOB_BASES = new Set(['app-files', 'owner-files']);

const REL_RE = /https:\/\/github\.com\/(?:rezaa2544\/payesh\.local|\$\{?\w+\}?)\/releases(?:\/[^\s"'`)<>\\]*)?/g;
function releaseLinks(text) { return [...text.matchAll(REL_RE)].map((m) => m[0].replace(/[.,;:]+$/, '')); }

function checkReleaseLinks(files, pubs) {
  const bad = [];
  let n = 0;
  for (const [name, text] of files) {
    for (const url of releaseLinks(text)) {
      n++;
      const m = url.match(/\/releases\/download\/([^/]+)\/(.*)$/);
      if (!m) { bad.push(`${name}: release page instead of a file: ${url}`); continue; }
      const [, tag, file] = m;
      if (file === '' && BLOB_BASES.has(tag) && /\.dart$/.test(name)) continue; // updater blob base
      if (file === '' || file.includes('/')) { bad.push(`${name}: not a file: ${url}`); continue; }
      const set = pubs[tag];
      if (!set) { bad.push(`${name}: unknown release channel ${tag}: ${url}`); continue; }
      if (!set.has(file)) bad.push(`${name}: ${tag}/${file} is not uploaded by its publisher`);
    }
  }
  assert(bad.length === 0, bad.join(' | '));
  return n;
}

// third-party landing pages that look like downloads but are not files
const LANDING = [
  /https?:\/\/(?:www\.)?tailscale\.com\/download\b/i,
  /https?:\/\/(?:www\.)?nodejs\.org\/(?:[a-z-]+\/)?download\/?(?=["'\s)`]|$)/i,
  /https?:\/\/github\.com\/[^/\s"']+\/[^/\s"']+\/releases\/latest(?![\w/-]*\/download\/)/i,
  /https?:\/\/(?:www\.)?microsoft\.com\/[^\s"']*\/download\/?(?=["'\s)`]|$)/i,
  /https?:\/\/developer\.microsoft\.com\/[^\s"']*webview2\/?(?=["'\s)`#]|$)/i,
];
function checkNoLandingPages(files) {
  const bad = [];
  for (const [name, text] of files) for (const re of LANDING) { const m = text.match(re); if (m) bad.push(`${name}: ${m[0]}`); }
  assert(bad.length === 0, 'download page instead of the file: ' + bad.join(' | '));
  return files.length + ' files';
}

const APK = `https://github.com/${REPO}/releases/download/native-continuous/payesh-native.apk`;
function checkApkOffered(t) {
  const need = {
    'README.md': (s) => s.includes(`](${APK})`),
    'site/index.html': (s) => s.includes(`data-asset="payesh-native.apk" href="${APK}"`),
    'client/install.html': (s) => /id="apk-link" href="([^"]+)"/.test(s) && s.match(/id="apk-link" href="([^"]+)"/)[1] === APK,
    'client/pages.js': (s) => s.includes(`const NATIVE_APK_URL = '${APK}';`) && (s.match(/const apk = NATIVE_APK_URL;/g) || []).length >= 2,
  };
  const miss = Object.entries(need).filter(([f, ok]) => !ok(t[f])).map(([f]) => f);
  assert(miss.length === 0, 'APK not linked directly in: ' + miss.join(', '));
  return Object.keys(need).length + ' places';
}

async function live(urls) {
  const bad = [];
  for (const u of urls) {
    try {
      const r = await fetch(u, { method: 'GET', redirect: 'follow', headers: { Range: 'bytes=0-0' } });
      const ct = r.headers.get('content-type') || '';
      if (!(r.status === 200 || r.status === 206) || /text\/html/i.test(ct)) bad.push(`${u} → ${r.status} ${ct}`);
      try { await r.body?.cancel(); } catch { /* ignore */ }
    } catch (e) { bad.push(`${u} → ${e.message}`); }
  }
  assert(bad.length === 0, bad.join(' | '));
  return urls.length + ' links answer with a file';
}

(async () => {
  const list = surfaces();
  const files = list.map((f) => [f, read(f)]);
  const T = Object.fromEntries(files);
  const pubs = publishers();

  check('DL-01', 'release links are releases/download/<tag>/<file>, never a release page', () => {
    const n = checkReleaseLinks(files, Object.fromEntries(Object.keys(pubs).map((k) => [k, { has: () => true }])));
    return `${n} links in ${files.length} files`;
  });
  check('DL-02', 'each linked file is uploaded by its publisher (ALLOWED set)', () => {
    checkReleaseLinks(files, pubs);
    return Object.entries(pubs).map(([k, v]) => `${k}=${v.size}`).join(' ');
  });
  check('DL-03', 'no third-party download page — the installer file itself', () => checkNoLandingPages(files));
  check('DL-04', 'school APK linked directly wherever the school app is offered', () => {
    assert(pubs['native-continuous'].has('payesh-native.apk'), 'school-native-publish.yml does not always publish payesh-native.apk');
    const yml = read('.github/workflows/school-native-publish.yml');
    assert(/School APK not release-signed[^\n]*\n\s+exit 1/.test(yml), 'publisher must fail closed without a release-signed APK');
    return checkApkOffered(T);
  });
  check('DL-05', 'mutants: each forbidden change turns its check red', () => {
    const swap = (f, a, b) => files.map(([n, t]) => [n, n === f ? t.split(a).join(b) : t]);
    const TAG = `https://github.com/${REPO}/releases/tag/native-continuous`;
    const mutants = [
      ['README Android → release page', () => checkReleaseLinks(swap('README.md', APK, TAG), pubs)],
      ['site → /releases/latest', () => checkReleaseLinks(swap('site/index.html', APK, `https://github.com/${REPO}/releases/latest`), pubs)],
      ['client → bare /releases', () => checkReleaseLinks(swap('client/install.html', APK, `https://github.com/${REPO}/releases`), pubs)],
      ['file the publisher never uploads', () => checkReleaseLinks(swap('README.md', 'payesh-owner.apk)', 'payesh-owner-debug.apk)'), pubs)],
      ['APK dropped from the school publisher', () => checkReleaseLinks(files, publishers({ school: read('.github/workflows/school-native-publish.yml').replace(/ payesh-native\.apk/g, '') }))],
      ['Tailscale landing page', () => checkNoLandingPages(swap('server/tunnel.js', 'https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe', 'https://tailscale.com/download/windows'))],
      ['Node.js landing page', () => checkNoLandingPages([['x.html', '<a href="https://nodejs.org/en/download/">node</a>']])],
      ['QR card APK → release page', () => checkApkOffered({ ...T, 'client/pages.js': T['client/pages.js'].replace(APK, TAG) })],
      ['install page APK → release page', () => checkApkOffered({ ...T, 'client/install.html': T['client/install.html'].replace(APK, TAG) })],
    ];
    const survived = [];
    for (const [name, fn] of mutants) { let red = false; try { fn(); } catch { red = true; } if (!red) survived.push(name); }
    assert(survived.length === 0, 'mutants survived: ' + survived.join(', '));
    return `${mutants.length}/${mutants.length} mutants red`;
  });
  if (process.env.PAYESH_LIVE_LINKS === '1') {
    check('DL-06', 'live: every linked file answers with a file (not HTML)', () => {
      const urls = new Set();
      for (const [n, t] of files) for (const u of releaseLinks(t)) if (!/\$/.test(u) && !u.endsWith('/') && !/\.dart$/.test(n)) urls.add(u);
      urls.add('https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe');
      return live([...urls].sort());
    });
  }
  for (const p of pending) await p();
  console.log(failed ? `DIRECT-LINKS-161-FAIL failed=${failed}` : `DIRECT-LINKS-161-OK checks=${passed}`);
  process.exit(failed ? 1 : 0);
})();
