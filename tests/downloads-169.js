#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 169 — every download, categorized, from ONE source (tools/release/downloads.mjs).

     DP-01  the README block equals the generator output (no hand edits, no drift)
     DP-02  every file linked by the README block and the «دانلودها» release body is uploaded by its
            publisher (ALLOWED / SERVER_ALLOWED sets of the publishing workflows) — straight file links only
     DP-03  categories in order: Windows 64-bit · Windows 32-bit · Android · cloud; every Windows program
            (school app, owner panel, data service) has a Windows 64-bit AND a Windows 32-bit download
            (row 169: «همه فایل های نصبی ویندوز باید ورژن 32 بیتی رو هم داشته باشن»); Android has both apps
     DP-04  the release body lists every technical release as «do not download» and links no release page
     DP-05  downloads-page.yml: runs after every publisher, keeps the release Latest and on top, checks the
            README block, titles the technical releases
     DP-06  mutants: each forbidden change turns its check red
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const assert = (c, m) => { if (!c) throw new Error(m); };
let passed = 0, failed = 0;
const results = [];
function check(id, desc, fn) {
  try { const d = fn(); passed++; results.push(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; results.push(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e)}`); }
}

function setOf(yml, key) {
  const line = yml.split('\n').find((l) => new RegExp(`^\\s+${key}="`).test(l));
  assert(line, `no ${key}= line`);
  return new Set(line.match(new RegExp(`${key}="([^"]*)"`))[1].split(/\s+/).filter(Boolean));
}
function publishers(f) {
  return {
    'native-continuous': setOf(f.school, 'ALLOWED'),
    'school-server-continuous': setOf(f.school, 'SERVER_ALLOWED'),
    'owner-continuous': setOf(f.owner, 'ALLOWED'),
    continuous: setOf(f.cloud, 'ALLOWED'),
    ...(f.win32 ? { 'win32-continuous': setOf(f.win32, 'ALLOWED') } : {}),
  };
}

const RULES = {
  inSync(f, M) {
    const cur = M.readmeBlockOf(f.readme);
    assert(cur, 'README has no downloads block');
    assert(cur === M.readmeBlock(), 'README downloads block differs from tools/release/downloads.mjs (run --write-readme)');
    return cur.split('\n').length + ' lines';
  },
  published(f, M, body) {
    const pubs = publishers(f);
    const re = /\]\((https:\/\/github\.com\/[^)\s]+)\)/g;
    const texts = [['README', M.readmeBlockOf(f.readme) || ''], ['release body', body]];
    const bad = []; let n = 0;
    for (const [name, t] of texts) {
      for (const m of t.matchAll(re)) {
        n++;
        const u = m[1].match(/^https:\/\/github\.com\/rezaa2544\/payesh\.local\/releases\/download\/([^/]+)\/([^/]+)$/);
        if (!u) { bad.push(`${name}: not a direct file link: ${m[1]}`); continue; }
        const set = pubs[u[1]];
        if (!set) bad.push(`${name}: unknown channel ${u[1]}`);
        else if (!set.has(u[2])) bad.push(`${name}: ${u[1]}/${u[2]} is not uploaded by its publisher`);
      }
    }
    assert(n > 0, 'no links');
    assert(bad.length === 0, bad.join(' | '));
    return n + ' links';
  },
  categories(M) {
    const ids = M.CATEGORIES.map((c) => c.id);
    for (const want of ['win64', 'win32', 'android']) assert(ids.includes(want), 'missing category ' + want);
    assert(ids.indexOf('win64') < ids.indexOf('win32') && ids.indexOf('win32') < ids.indexOf('android'), 'order: win64, win32, android');
    const apps = (id) => new Set(M.CATEGORIES.find((c) => c.id === id).rows.map((r) => r.app));
    const winApps = ['school', 'owner', 'server'];
    for (const a of winApps) assert(apps('win64').has(a), `win64 lacks ${a}`);
    const miss32 = winApps.filter((a) => !apps('win32').has(a));
    assert(miss32.length === 0, 'Windows 32-bit download missing for: ' + miss32.join(', '));
    for (const a of ['school', 'owner']) assert(apps('android').has(a), `android lacks ${a}`);
    for (const c of M.CATEGORIES) for (const r of c.rows) assert(M.APPS[r.app], 'unknown app ' + r.app);
    return ids.join(' → ') + (miss32.length ? ` (win32 pending: ${miss32.join(', ')})` : '');
  },
  technical(M, body) {
    for (const t of ['app-files', 'owner-files', 'app32-files', 'owner32-files']) assert(body.includes('`' + t + '`'), 'technical release not listed: ' + t);
    assert(/دستی دانلود نکنید/.test(body), 'no «do not download» note');
    assert(!/\/releases\/(tag|latest)\b|\/releases\)/.test(body), 'release body links a release page');
    return M.TECHNICAL.length + ' technical';
  },
  workflow(f) {
    const w = f.page;
    assert(w, 'no .github/workflows/downloads-page.yml');
    for (const p of ['school-native-publish', 'owner-native-publish', 'build-and-release', 'win32-publish']) assert(new RegExp(`workflows:\\s*\\[[^\\]]*\\b${p}\\b`).test(w), 'not triggered by ' + p);
    assert(/conclusion == 'success'/.test(w), 'must run only after a successful publisher');
    assert(/downloads\.mjs --check/.test(w), 'README block not checked');
    assert(/--release-body/.test(w), 'body not generated');
    assert(/gh release create "\$T"[^\n]*--latest/.test(w) && /gh release edit "\$T"[^\n]*--latest/.test(w), 'release must be marked Latest');
    assert(/--prerelease=false/.test(w), 'downloads must not be a prerelease');
    assert(/newest" != "\$T"[\s\S]*gh release delete "\$T"/.test(w), 'not recreated on top when another release is newer');
    assert(/releases\/latest[\s\S]*::error::Latest release/.test(w), 'Latest not verified');
    assert(/app-files\|⚙️ فنی/.test(w) && /owner-files\|⚙️ فنی/.test(w), 'technical releases not titled');
    return 'ok';
  },
};

function files(over = {}) {
  const page = path.join(ROOT, '.github/workflows/downloads-page.yml');
  const w32 = path.join(ROOT, '.github/workflows/win32-publish.yml');
  return {
    readme: read('README.md'),
    school: read('.github/workflows/school-native-publish.yml'),
    owner: read('.github/workflows/owner-native-publish.yml'),
    cloud: read('.github/workflows/build.yml'),
    win32: fs.existsSync(w32) ? fs.readFileSync(w32, 'utf8') : null,
    page: fs.existsSync(page) ? fs.readFileSync(page, 'utf8') : null,
    ...over,
  };
}

function runAll(M, f, body) {
  const out = {};
  for (const [k, fn] of Object.entries({
    inSync: () => RULES.inSync(f, M), published: () => RULES.published(f, M, body), categories: () => RULES.categories(M),
    technical: () => RULES.technical(M, body), workflow: () => RULES.workflow(f),
  })) { try { fn(); out[k] = true; } catch { out[k] = false; } }
  return out;
}

(async () => {
  const M = await import(path.join(ROOT, 'tools/release/downloads.mjs'));
  const f = files();
  const body = M.releaseBody({ school_build: 1, owner_build: 1, data_service: '0.0.0', commit: 'abc' });
  check('DP-01', 'README downloads block = generator output', () => RULES.inSync(f, M));
  check('DP-02', 'every linked file is uploaded by its publisher (README + release body)', () => RULES.published(f, M, body));
  check('DP-03', 'categories win64 → win32 → android; every Windows program in 64 AND 32 bit', () => RULES.categories(M));
  check('DP-04', 'technical releases marked «do not download»; no release-page links', () => RULES.technical(M, body));
  check('DP-05', 'downloads-page.yml keeps the release Latest and on top after every publisher', () => RULES.workflow(f));

  // DP-06 — mutants (each must turn exactly its rule red)
  const swap = (s, a, b) => { assert(s.includes(a), 'mutation did not apply: ' + a.slice(0, 60)); return s.split(a).join(b); };
  const mutants = [
    ['inSync', 'hand-edited README block', () => [{ ...M }, files({ readme: swap(f.readme, '⤓ `payesh-native.apk`', '⤓ app') }), body]],
    ['published', 'link to a file nobody uploads', () => [M, f, swap(body, 'owner-continuous/payesh-owner.apk', 'owner-continuous/payesh-owner-debug.apk')]],
    ['published', 'release page instead of the file', () => [M, f, swap(body, 'releases/download/native-continuous/payesh-native.apk', 'releases/tag/native-continuous')]],
    ['categories', 'Windows 32-bit category removed', () => [{ ...M, CATEGORIES: M.CATEGORIES.filter((c) => c.id !== 'win32') }, f, body]],
    ['categories', 'school app without a 32-bit download', () => [{ ...M, CATEGORIES: M.CATEGORIES.map((c) => (c.id === 'win32' ? { ...c, rows: c.rows.filter((r) => r.app !== 'school') } : c)) }, f, body]],
    ['published', '32-bit link to a file win32-publish does not upload', () => [M, f, swap(body, 'win32-continuous/payesh-owner32-setup.exe', 'win32-continuous/payesh-owner32-debug.exe')]],
    ['categories', 'owner panel without a 64-bit download', () => [{ ...M, CATEGORIES: M.CATEGORIES.map((c) => (c.id === 'win64' ? { ...c, rows: c.rows.filter((r) => r.app !== 'owner') } : c)) }, f, body]],
    ['technical', 'technical release not listed', () => [M, f, swap(body, '`owner-files`', '`x`')]],
    ['workflow', 'release not marked Latest', () => [M, files({ page: swap(f.page, 'create "$T" -R "$R" --target main --latest', 'create "$T" -R "$R" --target main') }), body]],
    ['workflow', 'not kept on top', () => [M, files({ page: swap(f.page, 'gh release delete "$T"', 'echo') }), body]],
    ['workflow', 'runs after failed publishers too', () => [M, files({ page: swap(f.page, "conclusion == 'success'", "conclusion != 'x'") }), body]],
  ];
  const caught = [];
  for (const [rule, name, mk] of mutants) {
    check('DP-06', `mutant «${name}» turns ${rule} red`, () => {
      const [m2, f2, b2] = mk();
      const r = runAll(m2, f2, b2);
      assert(r[rule] === false, `${rule} stayed green`);
      caught.push(name);
      return 'red';
    });
  }
  for (const l of results) console.log(l);
  console.log(failed ? `DOWNLOADS-169-FAIL checks=${passed + failed} failed=${failed}` : `DOWNLOADS-169-OK checks=${passed} mutants=${caught.length}`);
  process.exit(failed ? 1 : 0);
})();
