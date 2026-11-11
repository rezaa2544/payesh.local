#!/usr/bin/env node
// Row 114 — builds the static download/update page for GitHub Pages.
//
//   node tools/landing-114.mjs build --out _site
//
// Output is plain files only: site/*, the logo, and version.json, which is
// taken from releases/manifest.json (version + built_at only, nothing else).
// There is no server, no Cloudflare (D-09) and no third-party asset. The
// custom domain (payeshschool.ir) is set by the OWNER in the repository Pages
// settings after the domain is active; see docs/cloud/114-landing-pages-dns.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SITE_DIR = path.join(ROOT, 'site');
export const SITE_FILES = ['index.html', '404.html', 'version.js'];
export const LOGO = path.join(ROOT, 'client', 'icons', 'logo-mark.png');
export const RELEASE_BASE = 'https://github.com/rezaa2544/payesh.local/releases/download/continuous/';
// Hosts the page may link to (plain navigation, never loaded as a resource).
export const LINK_HOSTS = ['github.com'];

export function versionInfo(manifestPath = path.join(ROOT, 'releases', 'manifest.json')) {
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.version)) {
    throw new Error('releases/manifest.json: bad version');
  }
  const built = typeof m.built_at === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(m.built_at) ? m.built_at : null;
  return { version: m.version, built_at: built };
}

export function build(outDir, { manifestPath } = {}) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of SITE_FILES) fs.copyFileSync(path.join(SITE_DIR, f), path.join(outDir, f));
  fs.copyFileSync(LOGO, path.join(outDir, 'logo-mark.png'));
  fs.writeFileSync(path.join(outDir, 'version.json'), JSON.stringify(versionInfo(manifestPath)) + '\n');
  // Jekyll is not needed and would hide files that start with "_".
  fs.writeFileSync(path.join(outDir, '.nojekyll'), '');
  return fs.readdirSync(outDir).sort();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const outIdx = rest.indexOf('--out');
  if (cmd !== 'build' || outIdx < 0 || !rest[outIdx + 1]) {
    console.error('usage: node tools/landing-114.mjs build --out <dir>');
    process.exit(2);
  }
  const files = build(path.resolve(rest[outIdx + 1]));
  console.log('LANDING-114-BUILD-OK files=' + files.join(','));
}
