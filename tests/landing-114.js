#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 114 — static download/update page (payeshschool.ir on GitHub Pages).

     LP-01  site files exist; fa/RTL; strict CSP (no unsafe-eval, no remote hosts)
     LP-02  no external resource is loaded (scripts, styles, fonts, images, fetch)
     LP-03  no Cloudflare anywhere in the page, the build tool or the workflow (D-09)
     LP-04  every download link points at an asset that school-native-publish.yml
            really uploads to "native-continuous" after the native gate (row 129);
            no WebView file, no APK while the owner key is missing
     LP-05  build output is exactly the expected files; version.json carries only
            version + built_at from releases/manifest.json
     LP-06  workflow: manual deploy only, OWNER gate variable, main only,
            first-party actions only, read-only default token
     LP-07  DNS doc: GitHub Pages records only, domain verification, HTTPS,
            no CNAME file committed before the domain is active
     LP-08  mutants: each forbidden change turns the matching check red
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'site');
const TOOL = path.join(ROOT, 'tools/landing-114.mjs');
const WF = path.join(ROOT, '.github/workflows/pages.yml');
const PUBLISH_WF = path.join(ROOT, '.github/workflows/school-native-publish.yml');
const DOC = path.join(ROOT, 'docs/cloud/114-landing-pages-dns.md');
const RELEASE_BASE = 'https://github.com/rezaa2544/payesh.local/releases/download/native-continuous/';
const WEBVIEW_ASSETS = ['payesh-local.apk', 'payesh-setup.exe', 'payesh-local-windows.zip'];
const LINK_HOSTS = new Set(['github.com']);
const GH_A = ['185.199.108.153', '185.199.109.153', '185.199.110.153', '185.199.111.153'];
const GH_AAAA = ['2606:50c0:8000::153', '2606:50c0:8001::153', '2606:50c0:8002::153', '2606:50c0:8003::153'];

let passed = 0, failed = 0;
async function check(id, desc, fn) {
  try { const d = await fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e)}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const read = p => fs.readFileSync(p, 'utf8');

// ── pure checks (also used by the mutants) ──────────────────────────
function checkCsp(html) {
  const m = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
  assert(m, 'no CSP meta');
  const csp = m[1];
  assert(/default-src '(self|none)'/.test(csp), 'default-src must be self/none');
  assert(!/unsafe-eval/.test(csp), 'unsafe-eval in CSP');
  assert(!/https?:|\*/.test(csp), 'remote host or wildcard in CSP');
  assert(/base-uri 'none'/.test(csp) && /form-action 'none'/.test(csp), 'base-uri/form-action must be none');
  return csp.split(';').length + ' directives';
}

function checkNoExternalLoads(name, text) {
  const bad = [];
  // resources the browser loads by itself
  const loadRe = /<(script|img|iframe|source|audio|video|embed|object)\b[^>]*\b(?:src|data)\s*=\s*"([^"]*)"/gi;
  for (const m of text.matchAll(loadRe)) if (/^(https?:)?\/\//i.test(m[2])) bad.push(`${m[1]} ${m[2]}`);
  const linkRe = /<link\b[^>]*\bhref\s*=\s*"([^"]*)"/gi;
  for (const m of text.matchAll(linkRe)) if (/^(https?:)?\/\//i.test(m[1])) bad.push(`link ${m[1]}`);
  for (const m of text.matchAll(/url\(\s*['"]?([^'")]+)/gi)) if (/^(https?:)?\/\//i.test(m[1])) bad.push(`css url ${m[1]}`);
  for (const m of text.matchAll(/@import\s+(?:url\()?\s*['"]?([^'");]+)/gi)) bad.push(`@import ${m[1]}`);
  for (const m of text.matchAll(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(\s*['"`]([^'"`]+)/g)) {
    if (/^(https?:|wss?:)?\/\//i.test(m[1])) bad.push(`request ${m[1]}`);
  }
  // navigation links: https only, allow-listed hosts only
  for (const m of text.matchAll(/<a\b[^>]*\bhref\s*=\s*"([^"]*)"/gi)) {
    const href = m[1];
    if (!/^(https?:)?\/\//i.test(href)) continue;
    let u; try { u = new URL(href.startsWith('//') ? 'https:' + href : href); } catch { bad.push(`a ${href}`); continue; }
    if (u.protocol !== 'https:') bad.push(`a not https ${href}`);
    else if (!LINK_HOSTS.has(u.hostname)) bad.push(`a host ${u.hostname}`);
  }
  assert(bad.length === 0, `${name}: ${bad.join(' | ')}`);
}

const CF_RE = /cloudflare|cdnjs|cf-ipcountry|cf-ray|workers\.dev|pages\.dev|cloudflareinsights|1\.1\.1\.1|\b104\.(1[6-9]|2[0-9]|3[01])\.\d+\.\d+|\b172\.(6[4-9]|7[01])\.\d+\.\d+/i;
function checkNoCloudflare(name, text) {
  // The only allowed mention is the policy statement itself ("no Cloudflare").
  const m = text.replace(/\bno Cloudflare\b/gi, '').match(CF_RE);
  assert(!m, `${name}: Cloudflare reference "${m && m[0]}"`);
}

function releaseAssets(publishYml) {
  // Names the native publisher ends native-continuous with (the ALLOWED set it asserts). Only the
  // set that holds WITHOUT the owner signing key counts, so the page never links a missing APK.
  const names = new Set();
  const line = publishYml.split('\n').find((l) => /^\s+ALLOWED="/.test(l));
  if (line) for (const n of line.match(/ALLOWED="([^"]*)"/)[1].split(/\s+/)) if (n) names.add(n);
  return names;
}
function checkDownloadLinks(html, assets) {
  const links = [...html.matchAll(/<a\b[^>]*\bdata-asset="([^"]+)"[^>]*\bhref="([^"]+)"/g)];
  assert(links.length >= 2, 'expected EXE and zip links, got ' + links.length);
  for (const [, asset, href] of links) {
    assert(href === RELEASE_BASE + asset, `link for ${asset} is ${href}`);
    assert(!WEBVIEW_ASSETS.includes(asset), `${asset} is a retired WebView build (row 129)`);
    assert(assets.has(asset), `${asset} is not uploaded to native-continuous by school-native-publish.yml`);
  }
  for (const m of html.matchAll(/releases\/download\/([^/"]+)\//g)) assert(m[1] === 'native-continuous', 'download link on channel ' + m[1]);
  const kinds = links.map(l => path.extname(l[1]));
  for (const k of ['.exe', '.zip']) assert(kinds.includes(k), 'missing ' + k + ' link');
  return links.map(l => l[1]).join(', ');
}

function checkWorkflow(yml) {
  const on = yml.match(/^on:\n((?:[ ]{2}.*\n|\n)*)/m);
  assert(on, 'no on: block');
  const triggers = [...on[1].matchAll(/^ {2}([a-z_]+):/gm)].map(m => m[1]).sort();
  assert(JSON.stringify(triggers) === JSON.stringify(['pull_request', 'workflow_dispatch']),
    'triggers must be workflow_dispatch + pull_request only, got ' + triggers.join(','));
  assert(/^permissions:\n {2}contents: read\n/m.test(yml), 'default token must be contents: read');
  const uses = [...yml.matchAll(/uses:\s*([^\s@]+)@/g)].map(m => m[1]);
  assert(uses.length > 0 && uses.every(u => u.startsWith('actions/')), 'third-party action: ' + uses.filter(u => !u.startsWith('actions/')).join(','));
  const deploy = yml.slice(yml.indexOf('\n  deploy:'));
  assert(deploy.length > 10, 'no deploy job');
  const gate = (deploy.match(/^ {4}if:\s*(.+)$/m) || [])[1] || '';
  for (const need of ["github.event_name == 'workflow_dispatch'", "vars.PAYESH_PAGES_ENABLED == 'true'", "github.ref == 'refs/heads/main'"]) {
    assert(gate.includes(need), 'deploy gate lacks ' + need);
  }
  assert(!/\|\|/.test(gate), 'deploy gate must be a plain AND');
  assert(/pages: write/.test(deploy) && /id-token: write/.test(deploy), 'deploy needs pages/id-token write only there');
  const checkJob = yml.slice(yml.indexOf('\n  check:'), yml.indexOf('\n  deploy:'));
  assert(!/pages: write|id-token: write|contents: write/.test(checkJob), 'check job must not get write scopes');
  assert(/node tests\/landing-114\.js/.test(checkJob), 'check job must run this test');
  return 'triggers=' + triggers.join('+') + ' uses=' + uses.length;
}

function checkDnsDoc(doc) {
  for (const ip of GH_A) assert(doc.includes(ip), 'doc lacks A ' + ip);
  for (const ip of GH_AAAA) assert(doc.includes(ip), 'doc lacks AAAA ' + ip);
  assert(/www\s*\|\s*CNAME\s*\|\s*`?rezaa2544\.github\.io\.?`?/.test(doc), 'doc lacks www CNAME rezaa2544.github.io');
  // every IPv4 in a DNS table row must be a GitHub Pages address
  for (const row of doc.split('\n').filter(l => /^\|\s*(@|www|_github-pages-challenge)/.test(l))) {
    for (const ip of row.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || []) assert(GH_A.includes(ip), 'non-GitHub IP in DNS table: ' + ip);
    assert(!/proxied|proxy/i.test(row), 'DNS row must not be proxied: ' + row.trim());
  }
  assert(/_github-pages-challenge-rezaa2544/.test(doc), 'doc lacks the domain-verification TXT record');
  assert(/Enforce HTTPS/.test(doc), 'doc lacks Enforce HTTPS');
  assert(/D‑09|D-09/.test(doc), 'doc must cite D-09');
  return 'A=4 AAAA=4 CNAME+TXT';
}

(async () => {
  const html = read(path.join(SITE, 'index.html'));
  const notFound = read(path.join(SITE, '404.html'));
  const vjs = read(path.join(SITE, 'version.js'));
  const publishYml = read(PUBLISH_WF);
  const wf = read(WF);
  const doc = read(DOC);

  await check('LP-01', 'site files exist; fa/RTL; strict CSP on every page', () => {
    assert(/<html lang="fa" dir="rtl">/.test(html) && /<html lang="fa" dir="rtl">/.test(notFound), 'pages must be fa/rtl');
    assert(/name="viewport"/.test(html), 'no viewport meta');
    assert(/name="referrer" content="no-referrer"/.test(html), 'no referrer policy');
    return checkCsp(html) + ' / 404: ' + checkCsp(notFound);
  });

  await check('LP-02', 'no external resource is loaded (scripts, styles, fonts, images, fetch)', () => {
    checkNoExternalLoads('index.html', html);
    checkNoExternalLoads('404.html', notFound);
    checkNoExternalLoads('version.js', vjs);
    assert(/credentials:\s*'omit'/.test(vjs), 'version.js must not send cookies');
    return 'index, 404, version.js clean';
  });

  await check('LP-03', 'no Cloudflare in the page, build tool or workflow (D-09)', () => {
    const files = ['index.html', '404.html', 'version.js'].map(f => ['site/' + f, read(path.join(SITE, f))]);
    files.push(['tools/landing-114.mjs', read(TOOL)]);
    files.push(['.github/workflows/pages.yml', wf]);
    for (const [n, t] of files) checkNoCloudflare(n, t);
    return files.length + ' files';
  });

  await check('LP-04', 'download links point at native files school-native-publish.yml uploads to "native-continuous"', () => {
    const assets = releaseAssets(publishYml);
    assert(assets.has('payesh-native-setup.exe') && assets.has('payesh-native-windows.zip') && !assets.has('payesh-native.apk'),
      'could not read the native set from school-native-publish.yml: ' + [...assets]);
    return checkDownloadLinks(html, assets);
  });

  await check('LP-05', 'build output is exactly the expected files; version.json = version + built_at', async () => {
    const mod = await import(pathToFileURL(TOOL).href);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lp114-'));
    try {
      const files = mod.build(out);
      assert(JSON.stringify(files) === JSON.stringify(['.nojekyll', '404.html', 'index.html', 'logo-mark.png', 'version.js', 'version.json']), 'files: ' + files);
      assert(!files.includes('CNAME'), 'no CNAME before the domain is active');
      const v = JSON.parse(read(path.join(out, 'version.json')));
      const m = JSON.parse(read(path.join(ROOT, 'releases/manifest.json')));
      assert(JSON.stringify(Object.keys(v)) === JSON.stringify(['version', 'built_at']), 'extra keys: ' + Object.keys(v));
      assert(v.version === m.version, 'version mismatch');
      // a broken manifest is refused rather than published
      const badM = path.join(out, 'bad.json');
      fs.writeFileSync(badM, JSON.stringify({ version: '1.2', built_at: 'x' }));
      let threw = false; try { mod.versionInfo(badM); } catch { threw = true; }
      assert(threw, 'bad manifest version accepted');
      return `${files.length} files, version ${v.version}`;
    } finally { fs.rmSync(out, { recursive: true, force: true }); }
  });

  await check('LP-06', 'workflow: manual + OWNER-gated deploy, main only, first-party actions', () => checkWorkflow(wf));

  await check('LP-07', 'DNS doc: GitHub Pages records only, verification TXT, HTTPS; no CNAME committed', () => {
    assert(!fs.existsSync(path.join(SITE, 'CNAME')), 'site/CNAME must not exist before the domain is active');
    return checkDnsDoc(doc);
  });

  await check('LP-08', 'mutants: each forbidden change turns its check red', () => {
    const assets = releaseAssets(publishYml);
    const mutants = [
      ['remote script (cdnjs)', () => checkNoExternalLoads('m', html.replace('<script src="version.js">', '<script src="https://cdnjs.cloudflare.com/x.js">'))],
      ['Cloudflare analytics beacon', () => checkNoCloudflare('m', html + '<script defer src="https://static.cloudflareinsights.com/beacon.min.js"></script>')],
      ['remote web font', () => checkNoExternalLoads('m', html.replace('<style>', '<style>@import url("https://fonts.googleapis.com/css2?family=Vazirmatn");'))],
      ['protocol-relative image', () => checkNoExternalLoads('m', html.replace('src="logo-mark.png"', 'src="//example.ir/logo.png"'))],
      ['plain-http download link', () => checkNoExternalLoads('m', html.replace(RELEASE_BASE + 'payesh-native-setup.exe', 'http://github.com/x.exe'))],
      ['download from another host', () => checkNoExternalLoads('m', html.replace(RELEASE_BASE + 'payesh-native-setup.exe', 'https://mirror.example.com/payesh.exe'))],
      ['link to an asset the publisher never uploads', () => checkDownloadLinks(html.replace(/payesh-native-windows\.zip/g, 'payesh-debug.zip'), assets)],
      ['WebView setup linked under the native channel (row 129)', () => checkDownloadLinks(html.replace(/payesh-native-setup\.exe/g, 'payesh-setup.exe'), new Set([...assets, 'payesh-setup.exe']))],
      ['link back to the old continuous release', () => checkDownloadLinks(html.replace(RELEASE_BASE + 'payesh-native-windows.zip', 'https://github.com/rezaa2544/payesh.local/releases/download/continuous/payesh-native-windows.zip'), assets)],
      ['APK link while the owner key is missing', () => checkDownloadLinks(html.replace('</main>', `<a data-asset="payesh-native.apk" href="${RELEASE_BASE}payesh-native.apk">apk</a></main>`), assets)],
      ['third-party fetch in version.js', () => checkNoExternalLoads('m', vjs.replace("fetch('version.json'", "fetch('https://api.example.com/v'"))],
      ['CSP with unsafe-eval', () => checkCsp(html.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"))],
      ['CSP allowing a remote host', () => checkCsp(html.replace("connect-src 'self'", "connect-src 'self' https://api.example.com"))],
      ['deploy on every push', () => checkWorkflow(wf.replace('on:\n  workflow_dispatch:', 'on:\n  push:\n  workflow_dispatch:'))],
      ['deploy without the OWNER gate', () => checkWorkflow(wf.replace(" && vars.PAYESH_PAGES_ENABLED == 'true' && github.ref", ' && github.ref'))],
      ['third-party deploy action', () => checkWorkflow(wf.replace('actions/deploy-pages@v4', 'peaceiris/actions-gh-pages@v4'))],
      ['write token for the check job', () => checkWorkflow(wf.replace('    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4', '    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n    steps:\n      - uses: actions/checkout@v4'))],
      ['Cloudflare nameserver hint in the workflow', () => checkNoCloudflare('m', wf + '\n# dns: ns1.cloudflare.com\n')],
      ['Cloudflare IP in the DNS table', () => checkDnsDoc(doc.replace(/\| @ \| A \| 185\.199\.108\.153 \|/, '| @ | A | 104.21.5.9 |'))],
    ];
    const survived = [];
    for (const [name, fn] of mutants) { let red = false; try { fn(); } catch { red = true; } if (!red) survived.push(name); }
    assert(survived.length === 0, 'mutants survived: ' + survived.join(', '));
    return `${mutants.length}/${mutants.length} mutants red`;
  });

  console.log(failed === 0 ? `LANDING-114-OK checks=${passed}` : `LANDING-114-FAIL passed=${passed} failed=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();
