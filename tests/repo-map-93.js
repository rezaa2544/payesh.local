'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 93 — docs/REPOSITORY_MAP.md is current, consistent and link-clean.
                                                           RM-01 .. RM-07
   AC (Notion row 93): the map covers apps/payesh as it is now; ROADMAP and
   Ground Truth are consistent; every link is valid.

     RM-01  every tracked top-level directory is linked from the map
     RM-02  every directory of apps/payesh/, apps/payesh/app/ (runners) and
            apps/payesh/packages/ is linked from the map
     RM-03  every relative link resolves — REPOSITORY_MAP.md, docs/README.md,
            README.md, apps/payesh/README.md
     RM-04  ROADMAP: every "#PR → `sha`" in the map is a real commit that is an
            ancestor of HEAD (no invented merges); no stale "همین PR"
     RM-05  Ground Truth: the claimed `npm test` pass count is never above the
            count in mission-05-tests-run.log
     RM-06  apps/payesh/README.md lists exactly the packages that exist (no
            phantom package, none missing)
     RM-07  negative controls: each rule turns red on a mutated copy
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
function check(id, desc, fn) {
  try { const d = fn(); passed++; console.log(`PASS  ${id}  ${desc}  → ${d === undefined ? 'ok' : d}`); }
  catch (e) { failed++; console.log(`FAIL  ${id}  ${desc}  → ${String((e && e.message) || e)}`); }
}
function git(args) { return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }); }

const dirs = (rel) => fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'build' && d.name !== 'node_modules')
  .map(d => d.name)
  .filter(n => git(['ls-files', '--', path.posix.join(rel, n)]).stdout.trim() !== '');

function topLevel() {
  const out = git(['ls-files']);
  if (out.status !== 0) throw new Error('git ls-files failed');
  return [...new Set(out.stdout.split('\n').filter(f => f.includes('/')).map(f => f.split('/')[0]))]
    .filter(d => !d.startsWith('.')).sort();
}

const TRACKED = (() => {
  const set = new Set();
  for (const f of git(['ls-files']).stdout.split('\n').filter(Boolean)) {
    set.add(f);
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'));
  }
  return set;
})();

const RULES = {
  coverTop(f) {
    const miss = f.top.filter(d => !(f.map.includes('](../' + d + '/') || (d === 'docs' && f.map.includes('](./)'))));
    if (miss.length) throw new Error('top-level directories missing from the map: ' + miss.join(', '));
    return `${f.top.length} directories`;
  },
  coverPayesh(f) {
    const want = [
      ...f.payesh.filter(d => d !== 'packages').map(d => 'apps/payesh/' + d + '/'), /* packages/ is covered package by package */
      ...f.runners.map(d => 'apps/payesh/app/' + d + '/'),
      ...f.packages.map(d => 'apps/payesh/packages/' + d + '/'),
    ];
    const miss = want.filter(w => !f.map.includes('](../' + w + ')'));
    if (miss.length) throw new Error('apps/payesh paths missing: ' + miss.join(', '));
    return want.length + ' paths';
  },
  links(f) {
    let n = 0;
    for (const [doc, text] of Object.entries(f.docs)) {
      const base = path.dirname(path.join(ROOT, doc));
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const u = m[1];
        if (/^(https?:|#|mailto:)/.test(u)) continue;
        const t = path.resolve(base, decodeURI(u.split('#')[0]));
        if (!t.startsWith(ROOT) || !fs.existsSync(t)) throw new Error(`broken link in ${doc}: ${u}`);
        /* must also exist in a fresh checkout: a git-ignored local dir (e.g. data/) is a broken link in CI */
        const rel = path.relative(ROOT, t).split(path.sep).join('/');
        if (rel && !TRACKED.has(rel)) throw new Error(`link to an untracked/ignored path in ${doc}: ${u}`);
        n++;
      }
    }
    return n + ' relative links';
  },
  roadmap(f) {
    if (/\|\s*همین PR\s*\|/.test(f.map)) throw new Error('stale "همین PR" in the map');
    const merges = [...f.map.matchAll(/#(\d+) → `([0-9a-f]{7,40})`/g)];
    if (merges.length < 20) throw new Error('roadmap too small: ' + merges.length);
    for (const [, pr, sha] of merges) {
      if (!f.isAncestor(sha)) throw new Error(`#${pr} → ${sha} is not an ancestor of HEAD`);
    }
    return merges.length + ' merges verified';
  },
  groundTruth(f) {
    const claim = f.map.match(/`npm test` سبز: pass=(\d+) fail=0/);
    const log = f.testsLog.match(/pass=(\d+) fail=0/g);
    if (!claim) throw new Error('Ground Truth npm test claim missing');
    if (!log) throw new Error('no pass= line in mission-05-tests-run.log');
    const actual = Math.max(...log.map(x => Number(x.match(/\d+/)[0])));
    if (Number(claim[1]) > actual) throw new Error(`map claims pass=${claim[1]} but the log shows ${actual}`);
    return `claim=${claim[1]} log=${actual}`;
  },
  readmePackages(f) {
    const listed = [...new Set([...f.payeshReadme.matchAll(/\| `packages\/([a-z_]+)`/g)].map(m => m[1]))].sort();
    const real = [...f.packages].sort();
    if (JSON.stringify(listed) !== JSON.stringify(real)) throw new Error(`README packages ${listed} ≠ real ${real}`);
    return real.join(',');
  },
};

function load() {
  const map = rd('docs/REPOSITORY_MAP.md');
  const shallow = git(['rev-parse', '--is-shallow-repository']).stdout.trim() === 'true';
  return {
    map,
    top: topLevel(),
    payesh: dirs('apps/payesh'),
    runners: dirs('apps/payesh/app').filter(d => ['android', 'windows'].includes(d)),
    packages: dirs('apps/payesh/packages'),
    docs: { 'docs/REPOSITORY_MAP.md': map, 'docs/README.md': rd('docs/README.md'), 'README.md': rd('README.md'), 'apps/payesh/README.md': rd('apps/payesh/README.md') },
    testsLog: rd('docs/cloud/reports/evidence/mission-05-tests-run.log'),
    payeshReadme: rd('apps/payesh/README.md'),
    shallow,
    isAncestor: (sha) => {
      /* a shallow clone cannot prove ancestry; CI (build.yml) checks out with fetch-depth: 0 */
      if (shallow && process.env.RM93_REQUIRE_GIT !== '1') return true;
      return git(['merge-base', '--is-ancestor', sha, 'HEAD']).status === 0;
    },
  };
}

console.log('\nRow 93: repository map — coverage, links, roadmap and Ground Truth consistency\n');
const f = load();
check('RM-01', 'every tracked top-level directory is linked from the map', () => RULES.coverTop(f));
check('RM-02', 'apps/payesh (app, runners, every package, tool) is covered', () => RULES.coverPayesh(f));
check('RM-03', 'every relative link resolves (map, docs/README, README, apps/payesh/README)', () => RULES.links(f));
check('RM-04', 'ROADMAP: every "#PR → sha" is an ancestor of HEAD; no stale "همین PR"', () => RULES.roadmap(f) + (f.shallow ? ' (shallow clone: existence only)' : ''));
check('RM-05', 'Ground Truth npm test claim ≤ the raw log', () => RULES.groundTruth(f));
check('RM-06', 'apps/payesh/README lists exactly the existing packages', () => RULES.readmePackages(f));

const MUTANTS = [
  ['coverTop', 'map', s => s.split('](../tools/').join('](../')],
  ['coverPayesh', 'map', s => s.split('](../apps/payesh/packages/payesh_ui/)').join('](../apps/payesh/)')],
  ['links', 'map', s => s.replace('](cloud/82-load-test.md)', '](cloud/82-load-test-missing.md)')],
  ['links', 'map', s => s.replace('](cloud/82-load-test.md)', '](../.git/HEAD)')],   /* exists on disk but is not tracked (like the git-ignored data/) */
  ['roadmap', 'map', s => s.replace('#181 → `9b06ff4`', '#181 → `deadbee`')],
  ['roadmap', 'map', s => s.replace('| در صف ادغام |', '| همین PR |')],
  ['groundTruth', 'map', s => s.replace(/`npm test` سبز: pass=\d+/, '`npm test` سبز: pass=9999')],
  ['readmePackages', 'payeshReadme', s => s + '\n| `packages/payesh_net` | phantom | 75 |\n'],
];
check('RM-07', 'negative controls: each mutant turns exactly its rule red', () => {
  let caught = 0;
  const strict = Object.assign({}, f, { isAncestor: (sha) => git(['cat-file', '-e', sha + '^{commit}']).status === 0 && (f.shallow || git(['merge-base', '--is-ancestor', sha, 'HEAD']).status === 0) });
  for (const [rule, key, mut] of MUTANTS) {
    const g = Object.assign({}, strict, { [key]: mut(strict[key]) });
    if (key === 'map') g.docs = Object.assign({}, strict.docs, { 'docs/REPOSITORY_MAP.md': g.map });
    let red = false;
    try { RULES[rule](g); } catch (e) { red = true; }
    if (!red) throw new Error(`mutant for ${rule} was not caught`);
    caught++;
  }
  return `${caught}/${MUTANTS.length} caught`;
});

console.log(`\nchecks=${passed + failed} pass=${passed} fail=${failed}`);
console.log(failed ? 'REPO-MAP-93-FAILED' : `REPO-MAP-93-OK checks=${passed}`);
process.exit(failed ? 1 : 0);
