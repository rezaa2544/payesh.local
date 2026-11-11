#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   SBOM gate — row 95 (release gate)

   Builds a CycloneDX 1.5 JSON SBOM from the lockfiles that define what a
   release ships (package-lock.json for the Node server/web client and every
   pubspec.lock of the native Flutter workspace) and fails closed when the
   bill of materials cannot be trusted:

     SB-01  a lockfile listed in the config is missing or unparsable
     SB-02  a lockfile yields zero components
     SB-03  an npm package has no version, no registry URL or no sha512 integrity
     SB-04  a hosted pub package has no version or no sha256
     SB-05  a git pub package is not pinned to a full commit (resolved-ref)
     SB-06  a path pub package points outside the repository
     SB-07  a forbidden WebView / JS-engine / Node-embedding package is present
     SB-08  the same purl appears twice with different hashes

   Usage:
     node tools/sbom-95.mjs [--root DIR] [--out FILE] [--lock npm:PATH] [--lock pub:PATH] ...
   Without --lock the default set is used (package-lock.json + apps/payesh/pubspec.lock).
   Output is deterministic: components sorted by purl; the timestamp is
   SOURCE_DATE_EPOCH (or the HEAD commit time) so the same tree gives the same bytes.
   Last line: SBOM-95-OK components=N … | SBOM-95-FAIL violations=N
   ═══════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DEFAULT_LOCKS = [
  { kind: 'npm', file: 'package-lock.json' },
  { kind: 'pub', file: 'apps/payesh/pubspec.lock' },
];

/* Same family list as the native-client "No WebView / JS-engine package" step
   (row 63) — kept in one regex so the two gates cannot drift apart silently. */
export const FORBIDDEN = /^(webview[a-z0-9_-]*|[a-z0-9_-]*[_-]webview[a-z0-9_-]*|flutter_inappwebview[a-z0-9_]*|flutter_js|flutter_qjs|nodejs[a-z0-9_-]*|capacitor[a-z0-9_-]*|@capacitor\/.*|cordova[a-z0-9_-]*|electron|nw|puppeteer|playwright)$/i;

function bad(list, id, msg) { list.push(`${id} ${msg}`); }

/* Minimal pubspec.lock reader: the file is machine-written YAML with a fixed
   two-space layout, so a line parser is exact and needs no YAML dependency. */
export function parsePubLock(text) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  let inPk = false, cur = null, inDesc = false;
  const unq = v => v.trim().replace(/^"(.*)"$/, '$1');
  for (const ln of lines) {
    if (/^packages:\s*$/.test(ln)) { inPk = true; continue; }
    if (/^\S/.test(ln)) { inPk = false; cur = null; continue; }
    if (!inPk) continue;
    let m;
    if ((m = /^ {2}([A-Za-z0-9_]+):\s*$/.exec(ln))) { cur = { name: m[1], description: {} }; out.push(cur); inDesc = false; continue; }
    if (!cur) continue;
    if ((m = /^ {4}description:\s*(.*)$/.exec(ln))) { inDesc = m[1].trim() === ''; if (!inDesc) cur.description = { value: unq(m[1]) }; continue; }
    if (inDesc && (m = /^ {6}([a-z0-9_-]+):\s*(.*)$/.exec(ln))) { cur.description[m[1]] = unq(m[2]); continue; }
    if ((m = /^ {4}([a-z_]+):\s*(.*)$/.exec(ln))) { inDesc = false; cur[m[1]] = unq(m[2]); }
  }
  return out;
}

function npmComponents(root, file, v) {
  let lock;
  try { lock = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')); } catch (e) { bad(v, 'SB-01', `${file}: ${e.code || e.message}`); return []; }
  const pk = lock && lock.packages;
  if (!pk || typeof pk !== 'object') { bad(v, 'SB-01', `${file}: no "packages" map (lockfileVersion ${lock && lock.lockfileVersion})`); return []; }
  const comps = [];
  for (const [key, p] of Object.entries(pk)) {
    if (!key) continue; /* the root project itself */
    if (p.link) continue; /* workspace symlink — its target is listed separately */
    const name = p.name || key.replace(/^.*node_modules\//, '');
    if (FORBIDDEN.test(name)) bad(v, 'SB-07', `npm ${name}: forbidden WebView/JS-engine/Node-embedding package`);
    if (!p.version) { bad(v, 'SB-03', `npm ${name}: no version`); continue; }
    if (!/^https:\/\/registry\.npmjs\.org\//.test(p.resolved || '')) bad(v, 'SB-03', `npm ${name}@${p.version}: resolved is not the npm registry (${p.resolved || 'none'})`);
    const im = /^sha512-([A-Za-z0-9+/=]+)$/.exec(p.integrity || '');
    if (!im) { bad(v, 'SB-03', `npm ${name}@${p.version}: no sha512 integrity`); continue; }
    const hex = Buffer.from(im[1], 'base64').toString('hex');
    const ns = name.startsWith('@') ? encodeURIComponent(name.split('/')[0]) + '/' + name.split('/')[1] : name;
    comps.push({
      type: 'library', name, version: p.version,
      purl: `pkg:npm/${ns}@${p.version}`,
      scope: p.dev ? 'excluded' : 'required',
      hashes: [{ alg: 'SHA-512', content: hex }],
      licenses: p.license ? [/^[A-Za-z0-9.+-]+$/.test(String(p.license)) ? { license: { id: String(p.license) } } : { expression: String(p.license) }] : undefined,
      externalReferences: [{ type: 'distribution', url: p.resolved }],
      properties: [{ name: 'payesh:lockfile', value: file }],
    });
  }
  return comps;
}

function pubComponents(root, file, v) {
  let text;
  try { text = fs.readFileSync(path.join(root, file), 'utf8'); } catch (e) { bad(v, 'SB-01', `${file}: ${e.code || e.message}`); return []; }
  const pk = parsePubLock(text);
  const comps = [];
  for (const p of pk) {
    if (FORBIDDEN.test(p.name)) bad(v, 'SB-07', `pub ${p.name}: forbidden WebView/JS-engine/Node-embedding package`);
    const base = { type: 'library', name: p.name, version: p.version || '', scope: p.dependency === 'direct dev' ? 'excluded' : 'required', properties: [{ name: 'payesh:lockfile', value: file }, { name: 'pub:source', value: p.source || '' }, { name: 'pub:dependency', value: p.dependency || '' }] };
    if (p.source === 'hosted') {
      if (!p.version) { bad(v, 'SB-04', `pub ${p.name}: no version`); continue; }
      if (!/^[0-9a-f]{64}$/.test(p.description.sha256 || '')) { bad(v, 'SB-04', `pub ${p.name}@${p.version}: no sha256`); continue; }
      comps.push(Object.assign(base, {
        purl: `pkg:pub/${p.name}@${p.version}`, hashes: [{ alg: 'SHA-256', content: p.description.sha256 }],
        externalReferences: [{ type: 'distribution', url: (p.description.url || 'https://pub.dev') + '/packages/' + p.name }],
      }));
    } else if (p.source === 'git') {
      const ref = p.description['resolved-ref'] || '';
      if (!/^[0-9a-f]{40}$/.test(ref)) { bad(v, 'SB-05', `pub ${p.name}: git dependency not pinned to a commit (resolved-ref=${ref || 'none'})`); continue; }
      comps.push(Object.assign(base, { purl: `pkg:pub/${p.name}@${p.version}?vcs_url=${encodeURIComponent((p.description.url || '') + '@' + ref)}` }));
    } else if (p.source === 'path') {
      const abs = path.resolve(path.dirname(path.join(root, file)), p.description.path || '');
      if (!(abs + path.sep).startsWith(path.resolve(root) + path.sep)) { bad(v, 'SB-06', `pub ${p.name}: path dependency outside the repository (${p.description.path})`); continue; }
      comps.push(Object.assign(base, { purl: `pkg:pub/${p.name}@${p.version || '0.0.0'}?repository_path=${encodeURIComponent(path.relative(root, abs).split(path.sep).join('/'))}` }));
    } else if (p.source === 'sdk') {
      comps.push(Object.assign(base, { purl: `pkg:pub/${p.name}@${p.version || '0.0.0'}?sdk=${encodeURIComponent(p.description.value || 'flutter')}` }));
    } else {
      bad(v, 'SB-04', `pub ${p.name}: unknown source "${p.source || ''}"`);
    }
  }
  return comps;
}

function sourceDate(root) {
  if (process.env.SOURCE_DATE_EPOCH) return new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString();
  try { return new Date(Number(execFileSync('git', ['-C', root, 'log', '-1', '--format=%ct'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) * 1000).toISOString(); } catch (e) { return '1970-01-01T00:00:00.000Z'; }
}

export function buildSbom({ root = process.cwd(), locks = DEFAULT_LOCKS } = {}) {
  const violations = [];
  const all = [];
  const perLock = [];
  for (const l of locks) {
    const c = l.kind === 'npm' ? npmComponents(root, l.file, violations) : l.kind === 'pub' ? pubComponents(root, l.file, violations) : (bad(violations, 'SB-01', `${l.file}: unknown kind ${l.kind}`), []);
    if (!c.length && !violations.some(x => x.startsWith('SB-01') && x.includes(l.file))) bad(violations, 'SB-02', `${l.file}: zero components`);
    perLock.push({ file: l.file, kind: l.kind, components: c.length });
    all.push(...c);
  }
  const byPurl = new Map();
  for (const c of all) {
    const h = JSON.stringify(c.hashes || []);
    if (byPurl.has(c.purl)) {
      if (byPurl.get(c.purl).h !== h) bad(violations, 'SB-08', `${c.purl}: listed twice with different hashes`);
      continue; /* npm nests the same version under several parents — dedupe */
    }
    byPurl.set(c.purl, { c, h });
  }
  const components = [...byPurl.values()].map(x => x.c).sort((a, b) => (a.purl < b.purl ? -1 : a.purl > b.purl ? 1 : 0))
    .map(c => Object.assign({ 'bom-ref': c.purl }, JSON.parse(JSON.stringify(c))));
  const lockDigest = crypto.createHash('sha256');
  for (const l of locks) { try { lockDigest.update(l.file + '\0' + fs.readFileSync(path.join(root, l.file))); } catch (e) { lockDigest.update(l.file + '\0missing'); } }
  const sbom = {
    bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
    serialNumber: 'urn:uuid:' + uuidFrom(lockDigest.digest('hex')),
    metadata: {
      timestamp: sourceDate(root),
      tools: { components: [{ type: 'application', name: 'payesh sbom-95', version: '1' }] },
      component: { type: 'application', name: 'payesh', 'bom-ref': 'payesh' },
      properties: perLock.map(p => ({ name: `payesh:lock:${p.file}`, value: `${p.kind} components=${p.components}` })),
    },
    components,
  };
  return { sbom, violations, perLock };
}

function uuidFrom(hex) {
  const h = hex.slice(0, 32).split('');
  h[12] = '5'; h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

function main(argv) {
  let root = process.cwd(), out = null; const locks = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = path.resolve(argv[++i]);
    else if (argv[i] === '--out') out = argv[++i];
    else if (argv[i] === '--lock') { const [kind, ...f] = String(argv[++i]).split(':'); locks.push({ kind, file: f.join(':') }); }
  }
  const { sbom, violations, perLock } = buildSbom({ root, locks: locks.length ? locks : DEFAULT_LOCKS });
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, JSON.stringify(sbom, null, 2) + '\n'); }
  for (const p of perLock) console.log(`lock ${p.kind} ${p.file} components=${p.components}`);
  for (const x of violations) console.log('FAIL  ' + x);
  const shipped = sbom.components.filter(c => c.scope !== 'excluded').length;
  if (violations.length) { console.log(`SBOM-95-FAIL violations=${violations.length}`); return 1; }
  console.log(`SBOM-95-OK components=${sbom.components.length} shipped=${shipped} format=CycloneDX-1.5${out ? ' out=' + out : ''}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
