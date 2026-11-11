'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 95 — release gate negative tests

   Proves the release gate is fail-closed:
     RG-01  every gate success (rehearsal) ⇒ RELEASE-GATE-OK, manual PENDING
     RG-02  ANY single gate job failure / cancelled / skipped / missing ⇒ BLOCKED
     RG-03  ANY single native sub-job (gate-controls, android, windows, …) not
            success or absent ⇒ BLOCKED (the aggregate alone is not trusted)
     RG-04  empty / null / garbage needs ⇒ every gate BLOCKED
     RG-05  a config with no gates ⇒ BLOCKED
     RG-06  workflow wiring: verdict needs exactly the configured jobs, runs
            always(), publish requires a green verdict, native-client.yml
            exports every configured sub-result
     RG-07  CLI: exit 0 + OK on green, exit 1 + BLOCKED on one red gate
     RG-08  release mode: signoff missing / unticked item / result≠PASS /
            wrong tag / rc_sha not an ancestor / product changed after rc ⇒
            BLOCKED; a complete signoff with docs-only change ⇒ OK
     RG-09  owner checklist has M1…M6, all [M]; the template lists each
     SB-01…SB-09  SBOM: real tree OK + byte-deterministic; every violation
            class (forbidden pkg, no integrity, foreign registry, no sha256,
            unpinned git, path outside repo, missing / empty lockfile) ⇒ FAIL
     MUT-*  mutation controls: four reverted checks in the gate are each caught

   Run: node tests/release-gate-95.js        (CI: release-gate.yml + build.yml)
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const GATE = path.join(ROOT, 'tools/release-gate-95.mjs');
const SBOM = path.join(ROOT, 'tools/sbom-95.mjs');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/release/95-release-gate.json'), 'utf8'));
const NODE = process.execPath;

let pass = 0, fail = 0;
const results = [];
function check(id, title, fn) {
  try {
    const note = fn();
    pass++; results.push({ id, ok: true });
    console.log(`PASS  ${id}  ${title}${note ? '  → ' + note : ''}`);
  } catch (e) {
    fail++; results.push({ id, ok: false });
    console.log(`FAIL  ${id}  ${title}  ✗ ${e.message}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }

function allJobs(cfg) { return [...new Set(cfg.gates.flatMap(g => g.jobs))]; }
function greenNeeds(cfg) {
  const n = {};
  for (const j of allJobs(cfg)) n[j] = { result: 'success', outputs: {} };
  const subs = {};
  for (const g of cfg.gates) for (const [j, list] of Object.entries(g.sub || {})) for (const s of list) (subs[j] = subs[j] || new Set()).add(s);
  for (const [j, set] of Object.entries(subs)) n[j].outputs.results = [...set].map(s => `${s}=success`).join(',');
  return n;
}
const clone = o => JSON.parse(JSON.stringify(o));

async function suite(G, S, { quiet = false } = {}) {
  /* Returns the id list of failing checks — used both for the real run and
     for the mutation controls (a mutant must turn its target check red). */
  const red = [];
  const run = (id, title, fn) => {
    if (quiet) { try { fn(); } catch (e) { red.push(id); } return; }
    check(id, title, fn);
    if (!results[results.length - 1].ok) red.push(id);
  };
  const ev = (needs, extra = {}) => G.evaluate(Object.assign({ config: CONFIG, needs, mode: 'rehearsal', root: ROOT, sha: 'test' }, extra));

  run('RG-01', 'every gate success (rehearsal) ⇒ RELEASE-GATE-OK; manual [M] checklist PENDING', () => {
    const r = ev(greenNeeds(CONFIG));
    assert(r.ok, 'expected OK, got: ' + r.blocked.join(' | '));
    assert(/RELEASE-GATE-OK gates_pass=7\/7 manual=PENDING/.test(r.text), 'summary line missing:\n' + r.text);
    assert(/MANUAL .*PENDING .*items=M1,M2,M3,M4,M5,M6/.test(r.text), 'manual items not listed');
    return `gates=${r.gates.length}`;
  });

  run('RG-02', 'ANY single gate job failure / cancelled / skipped / missing ⇒ BLOCKED and the gate is named', () => {
    let n = 0;
    for (const g of CONFIG.gates) for (const j of g.jobs) for (const bad of ['failure', 'cancelled', 'skipped', 'missing']) {
      const needs = clone(greenNeeds(CONFIG));
      if (bad === 'missing') delete needs[j]; else needs[j].result = bad;
      const r = ev(needs);
      assert(!r.ok, `${g.id}/${j}=${bad} was NOT blocked`);
      assert(r.blocked.some(b => b.startsWith(g.id + ':')), `${g.id} not named for ${j}=${bad}`);
      assert(/RELEASE-GATE-BLOCKED/.test(r.text), 'no BLOCKED line');
      n++;
    }
    return `${n} single-failure cases blocked`;
  });

  run('RG-03', 'ANY single native sub-job (row 63 gate, android, windows, conformance) not success or absent ⇒ BLOCKED', () => {
    let n = 0;
    for (const g of CONFIG.gates) for (const [j, list] of Object.entries(g.sub || {})) for (const s of list) for (const bad of ['failure', 'skipped', 'absent']) {
      const needs = clone(greenNeeds(CONFIG));
      const parts = needs[j].outputs.results.split(',').filter(p => !p.startsWith(s + '='));
      if (bad !== 'absent') parts.push(`${s}=${bad}`);
      needs[j].outputs.results = parts.join(',');
      const r = ev(needs);
      assert(!r.ok && r.blocked.some(b => b.startsWith(g.id + ':')), `${g.id} ${j}/${s}=${bad} was NOT blocked`);
      n++;
    }
    const noOut = clone(greenNeeds(CONFIG)); delete noOut.native.outputs;
    assert(!ev(noOut).ok, 'native without outputs was NOT blocked');
    return `${n + 1} sub-job cases blocked`;
  });

  run('RG-04', 'empty / null / garbage needs ⇒ every gate BLOCKED', () => {
    for (const needs of [{}, null, 'x', [], { native: 'success' }, { native: { result: 'SUCCESS' } }]) {
      const r = ev(needs);
      assert(!r.ok, 'not blocked for ' + JSON.stringify(needs));
      assert(r.gates.every(g => !g.ok), 'some gate passed for ' + JSON.stringify(needs));
    }
  });

  run('RG-05', 'a config with no gates (or a gate with no jobs) ⇒ BLOCKED', () => {
    assert(!G.evaluate({ config: Object.assign({}, CONFIG, { gates: [] }), needs: greenNeeds(CONFIG), mode: 'rehearsal', root: ROOT }).ok, 'empty gate list passed');
    const c2 = clone(CONFIG); c2.gates[0].jobs = [];
    assert(!G.evaluate({ config: c2, needs: greenNeeds(CONFIG), mode: 'rehearsal', root: ROOT }).ok, 'gate without jobs passed');
    assert(!G.evaluate({ config: CONFIG, needs: greenNeeds(CONFIG), mode: 'publish-anyway', root: ROOT }).ok, 'unknown mode passed');
  });

  run('RG-08', 'release mode: missing / incomplete / stale signoff ⇒ BLOCKED; complete docs-only signoff ⇒ OK', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-rg95-'));
    try {
      const g = (...a) => execFileSync('git', ['-C', tmp, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
      fs.mkdirSync(path.join(tmp, 'docs/release/signoff'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'server'), { recursive: true });
      fs.copyFileSync(path.join(ROOT, CONFIG.owner_checklist), path.join(tmp, CONFIG.owner_checklist));
      fs.writeFileSync(path.join(tmp, 'server/app.js'), 'v1\n');
      g('add', '-A'); g('commit', '-qm', 'rc');
      const rc = g('rev-parse', 'HEAD');
      const tag = 'native-v1.2.3';
      const ids = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'];
      const signoff = (o = {}) => [
        `tag: ${o.tag || tag}`, `rc_sha: ${o.rc || rc}`, `owner: ${o.owner === undefined ? 'Owner' : o.owner}`, `date: ${o.date || '2026-11-11'}`, `result: ${o.result || 'PASS'}`, '',
        ...ids.map(i => `- [${(o.unticked || []).includes(i) ? ' ' : 'x'}] **${i}** checked`),
      ].join('\n') + '\n';
      const at = (txt, { commitProduct = false } = {}) => {
        g('checkout', '-q', '--detach', rc);
        fs.mkdirSync(path.join(tmp, 'docs/release/signoff'), { recursive: true });
        if (txt !== null) fs.writeFileSync(path.join(tmp, `docs/release/signoff/${tag}.md`), txt);
        else fs.rmSync(path.join(tmp, `docs/release/signoff/${tag}.md`), { force: true });
        if (commitProduct) fs.writeFileSync(path.join(tmp, 'server/app.js'), 'v2\n');
        g('add', '-A'); try { g('commit', '-qm', 'signoff'); } catch (e) { /* nothing to commit */ }
        return G.evaluate({ config: CONFIG, needs: greenNeeds(CONFIG), mode: 'release', tag, root: tmp, sha: 'test' });
      };
      const cases = [
        ['no signoff', at(null), /signoff .* missing/],
        ['M3 unticked', at(signoff({ unticked: ['M3'] })), /item M3 not ticked/],
        ['result FAIL', at(signoff({ result: 'FAIL' })), /result: "FAIL"/],
        ['empty owner', at(signoff({ owner: '' })), /owner: empty/],
        ['bad date', at(signoff({ date: 'tomorrow' })), /date: "tomorrow"/],
        ['short rc_sha', at(signoff({ rc: rc.slice(0, 12) })), /not a full commit sha/],
        ['rc_sha not ancestor', at(signoff({ rc: 'f'.repeat(40) })), /not an ancestor|git check failed/],
        ['product changed after rc', at(signoff(), { commitProduct: true }), /product changed after the device-tested build/],
      ];
      for (const [name, r, re] of cases) {
        assert(!r.ok, `${name}: NOT blocked`);
        assert(r.blocked.some(b => re.test(b)), `${name}: reason missing (${r.blocked.join(' | ')})`);
      }
      const wrongTag = G.evaluate({ config: CONFIG, needs: greenNeeds(CONFIG), mode: 'release', tag: 'v1.2.3', root: tmp });
      assert(!wrongTag.ok && wrongTag.blocked.some(b => /does not start with native-v/.test(b)), 'non-native tag not blocked');
      const good = at(signoff());
      assert(good.ok, 'complete signoff blocked: ' + good.blocked.join(' | '));
      assert(/RELEASE-GATE-OK gates_pass=7\/7 manual=PASS — publish allowed/.test(good.text), 'OK line wrong:\n' + good.text);
      const redGate = clone(greenNeeds(CONFIG)); redGate.sbom.result = 'failure';
      g('checkout', '-q', '--detach', 'HEAD');
      assert(!G.evaluate({ config: CONFIG, needs: redGate, mode: 'release', tag, root: tmp }).ok, 'signed-off release with a red gate was NOT blocked');
      return `${cases.length + 2} blocked, 1 allowed`;
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
  return red;
}

(async () => {
  const G = await import(pathToFileURL(GATE).href);
  const S = await import(pathToFileURL(SBOM).href);

  await suite(G, S);

  check('RG-06', 'workflow wiring: verdict needs = configured jobs, if: always(), publish only on green verdict, native-client exports every sub-result', () => {
    const wf = fs.readFileSync(path.join(ROOT, CONFIG.workflow), 'utf8');
    const jobs = allJobs(CONFIG);
    for (const j of jobs) assert(new RegExp(`^  ${j}:\\s*$`, 'm').test(wf), `job ${j} missing in ${CONFIG.workflow}`);
    const vm = /^  verdict:\s*\n(?:    .*\n)*?    needs: \[([^\]]*)\]/m.exec(wf);
    assert(vm, 'verdict needs not found');
    const needs = vm[1].split(',').map(s => s.trim()).filter(Boolean).sort();
    assert(JSON.stringify(needs) === JSON.stringify([...jobs].sort()), `verdict needs ${needs} ≠ configured ${[...jobs].sort()}`);
    const verdictBlock = wf.slice(wf.indexOf('\n  verdict:'), wf.indexOf('\n  publish:'));
    assert(/\n    if: always\(\)/.test(verdictBlock), 'verdict must run if: always()');
    assert(/NEEDS_JSON: \$\{\{ toJSON\(needs\) \}\}/.test(verdictBlock), 'verdict must pass toJSON(needs)');
    assert(/tools\/release-gate-95\.mjs/.test(verdictBlock), 'verdict must run the gate script');
    const pub = wf.slice(wf.indexOf('\n  publish:'));
    assert(/needs: \[verdict\]/.test(pub) && /needs\.verdict\.result == 'success'/.test(pub), 'publish must depend on a green verdict');
    assert(!/softprops\/action-gh-release|gh release create/.test(wf.slice(0, wf.indexOf('\n  publish:'))), 'something publishes before the verdict');
    const nc = fs.readFileSync(path.join(ROOT, '.github/workflows/native-client.yml'), 'utf8');
    assert(/^  workflow_call:/m.test(nc), 'native-client.yml has no workflow_call trigger');
    assert(/results:\s*\n\s*(description:.*\n\s*)?value: \$\{\{ jobs\.native-gate\.outputs\.results \}\}/.test(nc), 'native-client.yml does not export results');
    for (const g of CONFIG.gates) for (const list of Object.values(g.sub || {})) for (const s of list) {
      assert(nc.includes(`${s}=\${{ needs.${s}.result }}`), `native-client results output lacks ${s}`);
    }
    const ac = fs.readFileSync(path.join(ROOT, '.github/workflows/api-contract.yml'), 'utf8');
    assert(/^  workflow_call:/m.test(ac), 'api-contract.yml has no workflow_call trigger');
    return `${jobs.length} jobs wired`;
  });

  check('RG-07', 'CLI: exit 0 + RELEASE-GATE-OK on green; exit 1 + RELEASE-GATE-BLOCKED on one red gate', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-rg95cli-'));
    try {
      const f = path.join(tmp, 'needs.json');
      fs.writeFileSync(f, JSON.stringify(greenNeeds(CONFIG)));
      const ok = spawnSync(NODE, [GATE, '--needs', f, '--root', ROOT, '--out', path.join(tmp, 's.txt'), '--json', path.join(tmp, 's.json')], { encoding: 'utf8', env: Object.assign({}, process.env, { GITHUB_STEP_SUMMARY: '' }) });
      assert(ok.status === 0 && /RELEASE-GATE-OK/.test(ok.stdout), 'green run: exit ' + ok.status + '\n' + ok.stdout + ok.stderr);
      assert(fs.readFileSync(path.join(tmp, 's.txt'), 'utf8') === ok.stdout, 'summary file ≠ stdout');
      assert(JSON.parse(fs.readFileSync(path.join(tmp, 's.json'), 'utf8')).ok === true, 'json summary not ok');
      const red = greenNeeds(CONFIG); red.labels.result = 'failure';
      fs.writeFileSync(f, JSON.stringify(red));
      const bad = spawnSync(NODE, [GATE, '--needs', f, '--root', ROOT], { encoding: 'utf8', env: Object.assign({}, process.env, { GITHUB_STEP_SUMMARY: '' }) });
      assert(bad.status === 1 && /RELEASE-GATE-BLOCKED/.test(bad.stdout) && /G5-labels-55: labels=failure/.test(bad.stdout), 'red run: exit ' + bad.status + '\n' + bad.stdout);
      const none = spawnSync(NODE, [GATE, '--root', ROOT], { encoding: 'utf8', env: Object.assign({}, process.env, { NEEDS_JSON: '', GITHUB_STEP_SUMMARY: '' }) });
      assert(none.status === 1, 'no input must block');
      return 'exit 0 / 1 / 1';
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  check('RG-09', 'owner checklist lists M1…M6, each tagged [M]; the signoff template lists every item', () => {
    const txt = fs.readFileSync(path.join(ROOT, CONFIG.owner_checklist), 'utf8');
    const ids = G.checklistItems(txt);
    assert(JSON.stringify(ids) === JSON.stringify(['M1', 'M2', 'M3', 'M4', 'M5', 'M6']), 'items: ' + ids);
    for (const k of ['real Android phone', 'apksigner', 'real Windows PC', 'signtool', 'rollback']) assert(txt.includes(k), `checklist lacks "${k}"`);
    const tpl = fs.readFileSync(path.join(ROOT, CONFIG.signoff_dir, 'TEMPLATE.md'), 'utf8');
    for (const i of ids) assert(tpl.includes(`**${i}**`), `template lacks ${i}`);
    assert(/^result: FAIL$/m.test(tpl), 'template must default to result: FAIL');
    return ids.join(',');
  });

  /* ── SBOM ── */
  const sbomDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-sb95-'));
  const npmLock = pk => JSON.stringify({ lockfileVersion: 3, packages: Object.assign({ '': { name: 'x', version: '1.0.0' } }, pk) });
  const goodNpm = { 'node_modules/a': { version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz', integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64') } };
  const pubLock = body => `# Generated by pub\npackages:\n${body}sdks:\n  dart: ">=3.0.0 <4.0.0"\n`;
  const hosted = (n, sha = 'a'.repeat(64)) => `  ${n}:\n    dependency: transitive\n    description:\n      name: ${n}\n      sha256: "${sha}"\n      url: "https://pub.dev"\n    source: hosted\n    version: "1.0.0"\n`;
  const sb = (files, locks) => {
    const d = fs.mkdtempSync(path.join(sbomDir, 'c-'));
    for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); }
    return S.buildSbom({ root: d, locks });
  };
  const L = [{ kind: 'npm', file: 'package-lock.json' }, { kind: 'pub', file: 'app/pubspec.lock' }];
  try {
    check('SB-01', 'real tree: CycloneDX 1.5 from package-lock.json + apps/payesh/pubspec.lock, no violations, byte-deterministic', () => {
      const a = S.buildSbom({ root: ROOT }); const b = S.buildSbom({ root: ROOT });
      assert(!a.violations.length, a.violations.join(' | '));
      assert(a.sbom.bomFormat === 'CycloneDX' && a.sbom.specVersion === '1.5', 'not CycloneDX 1.5');
      assert(JSON.stringify(a.sbom) === JSON.stringify(b.sbom), 'two runs differ');
      for (const c of a.sbom.components) {
        assert(c.purl && c.name && c['bom-ref'] === c.purl, 'component without purl: ' + JSON.stringify(c).slice(0, 80));
        const src = (c.properties || []).find(p => p.name === 'pub:source');
        if (!src || src.value === 'hosted') assert(c.hashes && c.hashes[0] && /^[0-9a-f]{64,128}$/.test(c.hashes[0].content), 'no hash: ' + c.purl);
      }
      assert(a.perLock.every(p => p.components > 0), 'a lockfile produced 0 components');
      return a.perLock.map(p => `${p.file}=${p.components}`).join(' ') + ` total=${a.sbom.components.length}`;
    });
    const viol = (name, files, re) => check(name, `SBOM negative: ${re.source.replace(/\\/g, '')}`, () => {
      const r = sb(files, L);
      assert(r.violations.some(v => re.test(v)), 'not detected; got: ' + (r.violations.join(' | ') || 'none'));
    });
    const okPub = pubLock(hosted('collection'));
    viol('SB-02', { 'package-lock.json': npmLock(Object.assign({ 'node_modules/electron': goodNpm['node_modules/a'] }, goodNpm)), 'app/pubspec.lock': okPub }, /^SB-07 npm electron/);
    viol('SB-03', { 'package-lock.json': npmLock(goodNpm), 'app/pubspec.lock': pubLock(hosted('collection') + hosted('webview_flutter')) }, /^SB-07 pub webview_flutter/);
    viol('SB-04', { 'package-lock.json': npmLock({ 'node_modules/b': { version: '1.0.0', resolved: 'https://registry.npmjs.org/b/-/b-1.0.0.tgz' } }), 'app/pubspec.lock': okPub }, /^SB-03 npm b@1.0.0: no sha512 integrity/);
    viol('SB-05', { 'package-lock.json': npmLock({ 'node_modules/c': Object.assign({}, goodNpm['node_modules/a'], { resolved: 'https://evil.example/c.tgz' }) }), 'app/pubspec.lock': okPub }, /^SB-03 npm c@1.0.0: resolved is not the npm registry/);
    viol('SB-06', { 'package-lock.json': npmLock(goodNpm), 'app/pubspec.lock': pubLock(hosted('collection', '')) }, /^SB-04 pub collection@1.0.0: no sha256/);
    viol('SB-07', { 'package-lock.json': npmLock(goodNpm), 'app/pubspec.lock': pubLock(hosted('collection') + '  g:\n    dependency: "direct main"\n    description:\n      path: "."\n      ref: main\n      resolved-ref: main\n      url: "https://github.com/x/g.git"\n    source: git\n    version: "1.0.0"\n') }, /^SB-05 pub g: git dependency not pinned/);
    viol('SB-08', { 'package-lock.json': npmLock(goodNpm), 'app/pubspec.lock': pubLock(hosted('collection') + '  p:\n    dependency: "direct main"\n    description:\n      path: "../../outside"\n      relative: true\n    source: path\n    version: "1.0.0"\n') }, /^SB-06 pub p: path dependency outside the repository/);
    viol('SB-09', { 'app/pubspec.lock': pubLock('') }, /^SB-01 package-lock\.json|^SB-02 app\/pubspec\.lock: zero components/);
    check('SB-10', 'SBOM CLI: exit 1 + SBOM-95-FAIL on a forbidden package; exit 0 + SBOM-95-OK on the real tree', () => {
      const d = fs.mkdtempSync(path.join(sbomDir, 'cli-'));
      fs.writeFileSync(path.join(d, 'package-lock.json'), npmLock(Object.assign({ 'node_modules/flutter_js': goodNpm['node_modules/a'] }, goodNpm)));
      const bad = spawnSync(NODE, [SBOM, '--root', d, '--lock', 'npm:package-lock.json'], { encoding: 'utf8' });
      assert(bad.status === 1 && /SBOM-95-FAIL/.test(bad.stdout), 'bad: exit ' + bad.status + ' ' + bad.stdout);
      const ok = spawnSync(NODE, [SBOM, '--root', ROOT, '--out', path.join(d, 'sbom.json')], { encoding: 'utf8' });
      assert(ok.status === 0 && /SBOM-95-OK components=\d+/.test(ok.stdout), 'ok: exit ' + ok.status + ' ' + ok.stdout);
      return ok.stdout.trim().split('\n').pop();
    });
  } finally { fs.rmSync(sbomDir, { recursive: true, force: true }); }

  /* ── mutation controls: revert one check in the gate ⇒ its test must go red ── */
  if (!process.env.RG95_NO_MUTANTS) {
    const src = fs.readFileSync(GATE, 'utf8');
    const MUTANTS = [
      ['MUT-job-result', "if (r !== 'success') ok = false;", '/* mutant */', 'RG-02'],
      ['MUT-sub-result', "if (sr !== 'success') ok = false;", '/* mutant */', 'RG-03'],
      ['MUT-missing-is-success', ": 'missing';\n      src.push", ": 'success';\n      src.push", 'RG-02'],
      ['MUT-signoff-ticks', 'problems.push(`signoff item ${id} not ticked`);', 'void 0; /* mutant */', 'RG-08'],
      ['MUT-product-diff', 'if (outside.length) problems.push', 'if (false) problems.push', 'RG-08'],
    ];
    const mdir = fs.mkdtempSync(path.join(os.tmpdir(), 'payesh-rg95mut-'));
    try {
      let killed = 0;
      for (const [id, from, to, target] of MUTANTS) {
        const n = src.split(from).length - 1;
        if (n !== 1) { check(id, `mutant applies exactly once`, () => { throw new Error(`pattern found ${n}×`); }); continue; }
        let mutated = src.replace(from, to);
        if (id === 'MUT-signoff-ticks') {
          const box = "if (/^- \\[ \\] /m.test(text)) problems.push('signoff has unticked boxes');";
          if (mutated.split(box).length !== 2) throw new Error('MUT-signoff-ticks: box check pattern not found exactly once');
          mutated = mutated.replace(box, '');
        }
        const f = path.join(mdir, `${id}.mjs`);
        fs.writeFileSync(f, mutated);
        const MG = await import(pathToFileURL(f).href);
        const red = await suite(MG, S, { quiet: true });
        check(id, `revert in tools/release-gate-95.mjs ⇒ ${target} red`, () => {
          assert(red.includes(target), `mutant survived; red=[${red.join(',')}]`);
          killed++;
          return `red=[${red.join(',')}]`;
        });
      }
      console.log(`mutants_killed=${killed}/${MUTANTS.length}`);
    } finally { fs.rmSync(mdir, { recursive: true, force: true }); }
  }

  console.log(`\nRG checks=${pass + fail} pass=${pass} fail=${fail}`);
  if (fail) { console.log('RELEASE-GATE-95-FAILED'); process.exitCode = 1; } else console.log('RELEASE-GATE-95-OK');
})().catch(e => { console.error(e); process.exitCode = 1; });
