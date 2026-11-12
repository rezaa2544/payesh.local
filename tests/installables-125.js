// Row 125 — the installables registry is complete and honest, and every rule turns CI red when broken.
// Real repository first (must be clean), then in-memory mutations (each must be caught with its code).
'use strict';
const path = require('node:path');
const assert = require('node:assert');

(async () => {
  const root = path.join(__dirname, '..');
  const m = await import(path.join(root, 'tools', 'installables-125.mjs'));
  const base = m.loadRepo(root);
  const registry = JSON.parse(base.read(m.REGISTRY));
  const criterion = JSON.parse(base.read(m.CRITERION));
  let failures = 0;
  const ok = (id, cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${id}  ${msg}`); if (!cond) failures++; };

  // ---- the real repository ----
  const real = m.check(base.files, base.read, registry, criterion);
  for (const f of real.failures) console.log('  ' + f);
  ok('IN-01', real.failures.length === 0, `real repository passes (${registry.entries.length} entries, ${real.discovered.length} discovered, ${real.assets.length} workflow assets)`);
  const kinds = new Set(real.discovered.map((d) => d.kind));
  ok('IN-02', ['android-project', 'windows-installer', 'desktop-shell', 'install-script', 'tracked-binary', 'launcher'].every((k) => kinds.has(k)),
    `discovery sees every kind present in the repo (${[...kinds].sort().join(', ')})`);
  const ids = registry.entries.map((e) => e.id);
  ok('IN-03', ['owner-native-android', 'owner-native-windows', 'school-native-android', 'school-native-windows', 'school-webview-windows', 'school-webview-android'].every((i) => ids.includes(i)),
    'the six shipping programs are registered');
  const stillWebView = registry.entries.filter((e) => e.declared === 'webview' && e.published.length).map((e) => e.id).sort();
  ok('IN-04', JSON.stringify(stillWebView) === JSON.stringify(['school-webview-android', 'school-webview-windows']),
    `only the school WebView builds are still published, both marked for removal in row 129 (${stillWebView.join(', ')})`);

  // ---- mutations ----
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const run = (id, code, desc, { add = {}, edit = {}, del = [], reg, crit } = {}) => {
    const files = base.files.filter((f) => !del.includes(f)).concat(Object.keys(add).filter((f) => !base.files.includes(f)));
    const read = (f) => (f in add ? add[f] : f in edit ? edit[f](base.read(f)) : base.read(f));
    const r = m.check(files, read, reg ? reg(clone(registry)) : registry, crit ? crit(clone(criterion)) : criterion);
    const hit = r.failures.filter((x) => x.startsWith(code + ' '));
    ok(id, hit.length > 0, `${desc} → ${hit[0] || 'NOT CAUGHT ' + JSON.stringify(r.failures.slice(0, 2))}`);
  };
  const wfPublish = (asset) => `name: x\non: push\njobs:\n  p:\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh release upload continuous out/${asset} --clobber\n`;

  run('MU-01', 'I-03', 'new Android project not in the registry', { add: { 'apps/kiosk/android/app/src/main/AndroidManifest.xml': '<manifest/>' } });
  run('MU-02', 'I-03', 'new Inno installer not in the registry', { add: { 'installer/kiosk.iss': '[Setup]\nAppName=Kiosk\n' } });
  run('MU-03', 'I-03', 'new C# WebView2 desktop shell', { add: { 'kiosk/Kiosk.cs': 'using Microsoft.Web.WebView2.WinForms;\nclass K { static void Main() {} }' } });
  run('MU-04', 'I-03', 'Electron package.json', { add: { 'apps/desk/package.json': '{"devDependencies":{"electron":"^30.0.0"}}' } });
  run('MU-05', 'I-03', 'Capacitor config', { add: { 'apps/mobile/capacitor.config.json': '{"appId":"ir.payesh.x","webDir":"www"}' } });
  run('MU-06', 'I-03', 'Tauri config', { add: { 'apps/desk/src-tauri/tauri.conf.json': '{}' } });
  run('MU-07', 'I-03', 'tracked installable binary nobody registered', { add: { 'misc/payesh-school.apk': 'PK' } });
  run('MU-08', 'I-03', 'new Flutter desktop runner (linux) not registered', { add: { 'apps/payesh/kiosk/linux/runner/main.cc': 'int main(){}' } });
  run('MU-09', 'I-04', 'workflow builds an asset nobody claims', { add: { '.github/workflows/kiosk.yml': wfPublish('payesh-kiosk.apk') } });
  run('MU-10', 'I-05', 'school WebView APK re-declared native (honest flags flipped too)', {
    reg: (r) => { const e = r.entries.find((x) => x.id === 'school-webview-android'); Object.assign(e, { declared: 'native', status: 'published-native', html_css_js_ui: false, browser_engine_at_runtime: false, node_for_ui: false, runs_without_browser: true, published: [], gate_evidence: [] }); return r; } });
  run('MU-11', 'I-01', 'school WebView APK declared native while flags still say WebView', {
    reg: (r) => { r.entries.find((x) => x.id === 'school-webview-android').declared = 'native'; return r; } });
  run('MU-12', 'I-05', 'webview_flutter import added to the native owner app', {
    edit: { 'apps/payesh/owner/lib/main.dart': (t) => "import 'package:webview_flutter/webview_flutter.dart';\n" + t } });
  run('MU-13', 'I-05', 'flutter_inappwebview dependency in a shared native package', {
    edit: { 'apps/payesh/packages/payesh_ui/pubspec.yaml': (t) => t.replace(/dependencies:\n/, 'dependencies:\n  flutter_inappwebview: ^6.0.0\n') } });
  run('MU-14', 'I-05', 'native school installer ships node.exe', {
    edit: { 'apps/payesh/app/windows/installer/payesh-native.iss': (t) => t + '\n[Files]\nSource: "..\\bundle\\node.exe"; DestDir: "{app}"\n' } });
  run('MU-15', 'I-05', 'WebView2 linked into the native Windows runner', {
    edit: { 'apps/payesh/owner/windows/runner/main.cpp': (t) => '#include <WebView2.h>\n' + t } });
  run('MU-16', 'I-05', 'index.html bundled into the native app', { add: { 'apps/payesh/app/android/app/src/main/assets/www/index.html': '<html></html>' } });
  run('MU-17', 'I-06', 'owner Android gate line turned into a negative control (--expect-fail)', {
    edit: { '.github/workflows/native-client.yml': (t) => t.replace('native-independence-gate.mjs --android owner-out/payesh-owner.apk', 'native-independence-gate.mjs --expect-fail --android owner-out/payesh-owner.apk') } });
  run('MU-18', 'I-10', 'owner publisher no longer runs the gate', {
    edit: { '.github/workflows/owner-native-publish.yml': (t) => t.split('\n').filter((l) => !l.includes('native-independence-gate.mjs')).join('\n') } });
  run('MU-19', 'I-07', 'build.yml starts publishing the WebView owner web bundle', {
    edit: { '.github/workflows/build.yml': (t) => t + '\n      - run: gh release upload continuous out/payesh-owner-web.zip --clobber\n' } });
  run('MU-20', 'I-08', 'a WebView entry published to owner-continuous', {
    reg: (r) => { r.entries.find((x) => x.id === 'school-webview-android').published.push({ workflow: '.github/workflows/build.yml', tag: 'owner-continuous', asset: 'payesh-local.apk' }); return r; } });
  run('MU-21', 'I-09', 'gate criterion loses node.exe', { crit: (c) => { c.windows.forbidden_files = c.windows.forbidden_files.filter((x) => x !== 'node.exe'); return c; } });
  run('MU-22', 'I-09', 'gate criterion stops forbidding WebView.loadUrl', { crit: (c) => { c.android.forbidden_method_refs[0].names = c.android.forbidden_method_refs[0].names.filter((x) => x !== 'loadUrl'); return c; } });
  run('MU-23', 'I-09', 'gate criterion drops assets/www/', { crit: (c) => { c.android.forbidden_entries = c.android.forbidden_entries.filter((x) => x !== 'assets/www/'); return c; } });
  run('MU-24', 'I-01', 'published WebView entry not marked pending-removal', {
    reg: (r) => { r.entries.find((x) => x.id === 'school-webview-windows').status = 'published'; return r; } });
  run('MU-25', 'I-02', 'registry source path that does not exist', {
    reg: (r) => { r.entries.find((x) => x.id === 'owner-native-android').sources.push('apps/payesh/ghost/'); return r; } });
  run('MU-26', 'I-03', 'deleting a registry entry leaves its installer unregistered', {
    reg: (r) => { r.entries = r.entries.filter((x) => x.id !== 'owner-webview-windows-control'); return r; } });
  run('MU-28', 'I-03', 'second installer inside an already-registered directory', { add: { 'apps/payesh/owner/windows/installer/payesh-owner-webview.iss': '[Setup]\n' } });
  run('MU-29', 'I-02', 'registry entrypoint for a file that was deleted', { del: ['installer/payesh.iss'] });
  run('MU-27', 'I-05', 'Android WebView constructed in a native app Kotlin file', {
    add: { 'apps/payesh/app/android/app/src/main/kotlin/ir/payesh/app/Web.kt': 'import android.webkit.WebView\nclass W(c: android.content.Context) { val w = WebView(context) }' } });

  console.log(failures ? `INSTALLABLES-125-TEST-FAILED failures=${failures}` : 'INSTALLABLES-125-TEST-OK checks=4 mutations=29');
  assert.strictEqual(failures, 0);
})().catch((e) => { console.error(e); process.exit(1); });
