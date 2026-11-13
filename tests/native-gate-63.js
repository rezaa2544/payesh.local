'use strict';
/* Row 63 — tests for tools/native-independence-gate.mjs
   Run: node tests/native-gate-63.js
   Synthetic packages (built with the gate's own buildDex/buildZip writers) prove each rule fires
   and that a clean bundle passes; the frozen 0.9.2 Windows release (install/legacy-webview-fixtures/) must FAIL (negative control).
   Real CI build output is checked separately in .github/workflows/native-client.yml. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GATE = path.join(ROOT, 'tools/native-independence-gate.mjs');
const REL_092 = path.join(ROOT, 'install/legacy-webview-fixtures/payesh-local-windows-0.9.2.zip');
const REL_092_SHA = 'b4c3d4ed143b5d33057eddaebd24d8aa396829de909c01caae9f355d706d6e7e';

let passed = 0, failed = 0;
async function t(id, name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${id} ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${id} ${name} — ${String(e && e.message || e).slice(0, 300)}`); }
}
const run = args => spawnSync(process.execPath, [GATE, ...args], { encoding: 'utf8' });

(async () => {
  const g = await import(GATE);
  const crit = g.loadCriterion();
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'native-gate-'));
  const W = 'Landroid/webkit/WebView;';
  const flutterLike = {
    classes: ['Lio/flutter/embedding/android/FlutterActivity;', 'Lir/payesh/school/payesh_app/MainActivity;'],
    methodRefs: [{ cls: 'Lio/flutter/embedding/android/FlutterActivity;', name: '<init>' }],
    // the bare type string may appear (platform views / accessibility) — must NOT fail on its own
    extraStrings: [W],
  };
  const apk = (dexSpec, extra = {}) => g.buildZip(Object.assign({
    'AndroidManifest.xml': 'x', 'classes.dex': g.buildDex(dexSpec),
    'assets/flutter_assets/AssetManifest.bin': 'a', 'lib/arm64-v8a/libflutter.so': 'so', 'lib/arm64-v8a/libapp.so': 'so',
  }, extra));
  const winClean = { 'payesh_app.exe': Buffer.from('MZ native exe'), 'flutter_windows.dll': Buffer.from('MZ dll'), 'data/icudtl.dat': 'i', 'data/app.so': 'a', 'data/flutter_assets/AssetManifest.bin': 'b' };

  console.log('\nnative-independence-gate (row 63)\n');

  await t('NG-01', 'criterion is the machine-readable source (id/version/android/windows)', () => {
    assert.strictEqual(crit.id, 'ADR-43/native-independence');
    assert.ok(crit.version >= 1 && crit.android && crit.windows);
    assert.ok(crit.android.forbidden_method_refs.some(r => r.class === W && r.names.includes('loadUrl')));
  });
  await t('NG-02', 'DEX parser round-trips strings, types and method refs', () => {
    const d = g.parseDex(g.buildDex({ classes: ['La/B;'], methodRefs: [{ cls: W, name: 'loadUrl' }], extraStrings: ['hello'] }));
    assert.ok(d.strings.includes('hello'));
    assert.ok(d.types.includes(W));
    assert.ok(d.methods.some(m => m.cls === W && m.name === 'loadUrl'));
    assert.ok(d.classes.includes('La/B;'));
  });
  await t('NG-03', 'clean Flutter-like APK passes (bare WebView type string is tolerated)', () => {
    const r = g.checkAndroid(apk(flutterLike), crit);
    assert.deepStrictEqual(r.violations, []);
  });
  await t('NG-04', 'clean Flutter-like AAB (base/ prefix, multidex) passes', () => {
    const b = g.buildZip({ 'base/manifest/AndroidManifest.xml': 'x', 'base/dex/classes.dex': g.buildDex(flutterLike), 'base/dex/classes2.dex': g.buildDex({ classes: ['La/C;'] }) });
    const r = g.checkAndroid(b, crit);
    assert.deepStrictEqual(r.violations, []);
    assert.strictEqual(r.stats.dex, 2);
  });
  for (const name of ['<init>', 'loadUrl', 'loadData', 'loadDataWithBaseURL', 'evaluateJavascript', 'postUrl']) {
    await t('NG-1x', `WebView->${name} method ref FAILS`, () => {
      const r = g.checkAndroid(apk({ ...flutterLike, methodRefs: [...flutterLike.methodRefs, { cls: W, name }] }), crit);
      assert.ok(r.violations.some(v => v.includes(`${W}->${name}`)), JSON.stringify(r.violations));
    });
  }
  await t('NG-17', 'JS bridge method ref FAILS', () => {
    const bridge = ['add', 'Javascript', 'Interface'].join('');
    const r = g.checkAndroid(apk({ ...flutterLike, methodRefs: [{ cls: W, name: bridge }] }), crit);
    assert.ok(r.violations.some(v => v.includes(`->${bridge}`)));
  });
  await t('NG-18', 'WebViewClient / WebChromeClient construction FAILS', () => {
    const r = g.checkAndroid(apk({ ...flutterLike, methodRefs: [{ cls: 'Landroid/webkit/WebViewClient;', name: '<init>' }, { cls: 'Landroid/webkit/WebChromeClient;', name: '<init>' }] }), crit);
    assert.strictEqual(r.violations.length, 2, JSON.stringify(r.violations));
  });
  await t('NG-19', 'Capacitor / Cordova / androidx.webkit classes FAIL', () => {
    for (const c of ['Lcom/getcapacitor/Bridge;', 'Lorg/apache/cordova/CordovaWebView;', 'Landroidx/webkit/WebViewCompat;']) {
      const r = g.checkAndroid(apk({ ...flutterLike, classes: [...flutterLike.classes, c] }), crit);
      assert.ok(r.violations.some(v => v.includes(c)), c);
    }
  });
  await t('NG-20', 'bundled web UI entries FAIL (assets/www/, assets/public/index.html)', () => {
    assert.ok(g.checkAndroid(apk(flutterLike, { 'assets/www/index.html': '<html>' }), crit).violations.some(v => v.includes('assets/www/')));
    assert.ok(g.checkAndroid(apk(flutterLike, { 'assets/public/index.html': '<html>' }), crit).violations.length === 1);
    const aab = g.buildZip({ 'base/dex/classes.dex': g.buildDex(flutterLike), 'base/assets/www/app.js': 'x' });
    assert.ok(g.checkAndroid(aab, crit).violations.some(v => v.includes('assets/www/')));
  });
  await t('NG-21', 'APK without classes.dex / non-zip is an input error (not a pass)', () => {
    assert.throws(() => g.checkAndroid(g.buildZip({ 'AndroidManifest.xml': 'x' }), crit), /no classes/);
    assert.throws(() => g.checkAndroid(Buffer.from('not a zip at all'), crit));
  });
  await t('NG-30', 'clean Flutter-like Windows bundle (zip and directory) passes', () => {
    assert.deepStrictEqual(g.checkWindows(g.buildZip(winClean), crit).violations, []);
    const dir = path.join(TMP, 'win');
    for (const [n, c] of Object.entries(winClean)) { fs.mkdirSync(path.dirname(path.join(dir, n)), { recursive: true }); fs.writeFileSync(path.join(dir, n), c); }
    assert.deepStrictEqual(g.checkWindows(dir, crit).violations, []);
  });
  await t('NG-31', 'Windows: node.exe / WebView2Loader.dll / WebView2 managed dlls FAIL (case-insensitive)', () => {
    for (const f of ['runtime2/node.exe', 'WebView2Loader.DLL', 'Microsoft.Web.WebView2.Core.dll']) {
      const r = g.checkWindows(g.buildZip({ ...winClean, [f]: Buffer.from('MZ') }), crit);
      assert.ok(r.violations.some(v => v.startsWith('file ')), f + ' ' + JSON.stringify(r.violations));
    }
  });
  await t('NG-32', 'Windows: runtime/ and node_modules/ dirs, client/index.html, server/index.js FAIL', () => {
    for (const f of ['runtime/x.bin', 'node_modules/a/index.js', 'client/index.html', 'server/index.js']) {
      const r = g.checkWindows(g.buildZip({ ...winClean, [f]: 'x' }), crit);
      assert.ok(r.violations.length >= 1, f);
    }
  });
  await t('NG-33', 'Windows: exe importing the WebView2 loader (ASCII and UTF-16LE) FAILS', () => {
    for (const enc of ['latin1', 'utf16le']) {
      const exe = Buffer.concat([Buffer.from('MZ....'), Buffer.from('WebView2Loader.dll', enc)]);
      const r = g.checkWindows(g.buildZip({ ...winClean, 'payesh_app.exe': exe }), crit);
      assert.ok(r.violations.some(v => v.startsWith('binary ')), enc);
    }
  });
  await t('NG-34', 'Windows: bundle without any .exe FAILS (not standalone)', () => {
    const { 'payesh_app.exe': _x, ...noExe } = winClean;
    assert.ok(g.checkWindows(g.buildZip(noExe), crit).violations.some(v => v.startsWith('no .exe')));
  });
  await t('NG-40', 'released 0.9.2 Windows zip (sha-pinned) FAILS via the CLI', () => {
    const b = fs.readFileSync(REL_092);
    assert.strictEqual(crypto.createHash('sha256').update(b).digest('hex'), REL_092_SHA);
    const r = run(['--windows', REL_092]);
    assert.strictEqual(r.status, 1, r.stdout);
    assert.ok(/FAIL windows .*sha256=b4c3d4ed/.test(r.stdout));
    assert.ok(/no \.exe in bundle/.test(r.stdout) && /server\/index\.js/.test(r.stdout));
    assert.ok(/NATIVE-GATE-FAIL/.test(r.stdout));
  });
  await t('NG-41', 'CLI --expect-fail: OK on dirty inputs, BROKEN when a clean input slips in', () => {
    const dirty = path.join(TMP, 'dirty.apk'); fs.writeFileSync(dirty, apk({ ...flutterLike, methodRefs: [{ cls: W, name: 'loadUrl' }] }));
    const clean = path.join(TMP, 'clean.apk'); fs.writeFileSync(clean, apk(flutterLike));
    let r = run(['--expect-fail', '--android', dirty, '--windows', REL_092]);
    assert.strictEqual(r.status, 0, r.stdout); assert.ok(/NEGATIVE-CONTROL-OK/.test(r.stdout));
    r = run(['--expect-fail', '--android', dirty, clean]);
    assert.strictEqual(r.status, 1); assert.ok(/NEGATIVE-CONTROL-BROKEN/.test(r.stdout));
  });
  await t('NG-42', 'CLI exit codes: clean=0 (NATIVE-GATE-OK), missing file=2, --json is parseable', () => {
    const clean = path.join(TMP, 'clean2.apk'); fs.writeFileSync(clean, apk(flutterLike));
    const winz = path.join(TMP, 'win.zip'); fs.writeFileSync(winz, g.buildZip(winClean));
    let r = run(['--android', clean, '--windows', winz]);
    assert.strictEqual(r.status, 0, r.stdout); assert.ok(/NATIVE-GATE-OK/.test(r.stdout));
    r = run(['--android', path.join(TMP, 'nope.apk')]);
    assert.strictEqual(r.status, 2); assert.ok(/NATIVE-GATE-INPUT-ERROR/.test(r.stdout));
    r = run(['--json', '--android', clean]);
    const j = JSON.parse(r.stdout); assert.strictEqual(j.report[0].verdict, 'PASS'); assert.ok(/^[0-9a-f]{64}$/.test(j.report[0].sha256));
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed) { console.log('NATIVE-GATE-63-TEST-FAIL'); process.exit(1); }
  console.log('NATIVE-GATE-63-TEST-OK');
})();
