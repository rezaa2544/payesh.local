#!/usr/bin/env node
// Row 125 — registry of every installable Payesh program + the "native only" rule (D-49) as a CI check.
//
// Registry: docs/cloud/125-installables.json (the only declaration of what is native and what is WebView).
// This checker is pure (file list + reader in, failures out) so tests/installables-125.js can mutate the
// repository in memory and prove that each rule turns red.
//
// Failure codes
//   I-01 registry schema / honesty flags (declared=native but html/browser/node flags say otherwise, a
//        WebView entry that is published — row 129 —, …)
//   I-02 registry source path matches no tracked file
//   I-03 UNREGISTERED installable: Android project, Windows installer, desktop shell, web wrapper,
//        install script or tracked installable binary not covered by any registry entry
//   I-04 UNREGISTERED asset: a workflow builds/publishes an installable asset no entry claims
//   I-05 declared native but the sources use a WebView / browser engine / web UI / Node-for-UI
//   I-06 declared native but no CI line runs tools/native-independence-gate.mjs (without --expect-fail)
//   I-07 a publishing workflow mentions a WebView/legacy asset that the registry does not declare as
//        published by that workflow (after row 129 no WebView entry may be published at all)
//   I-08 a native-only channel (owner-continuous, native-v*, native-continuous) carries a non-native entry
//   I-11 the download page (site/index.html) links a file that is not published by a native entry on a
//        native-only channel (row 129)
//   I-09 the gate criterion (docs/cloud/43-native-independence.json) was weakened below the frozen baseline
//   I-10 a native entry is published by a workflow that neither runs the gate nor reuses native-client.yml
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const REGISTRY = 'docs/cloud/125-installables.json';
export const CRITERION = 'docs/cloud/43-native-independence.json';

// Frozen at row 125. The criterion may grow; it may never lose any of these.
export const BASELINE = {
  'android.forbidden_class_prefixes': ['Landroidx/webkit/', 'Lcom/getcapacitor/', 'Lorg/apache/cordova/', 'Lio/ionic/'],
  'android.forbidden_strings': ['addJavascriptInterface'],
  'android.forbidden_entries': ['assets/www/', 'assets/public/index.html', 'assets/index.html'],
  'android.forbidden_method_refs': ['Landroid/webkit/WebView;', 'Landroid/webkit/WebViewClient;', 'Landroid/webkit/WebChromeClient;'],
  'windows.forbidden_files': ['node.exe', 'webview2loader.dll', 'microsoft.web.webview2.core.dll', 'microsoft.web.webview2.winforms.dll', 'microsoft.web.webview2.wpf.dll'],
  'windows.forbidden_dirs': ['runtime/', 'node_modules/'],
  'windows.forbidden_binary_strings': ['WebView2Loader.dll', 'CreateCoreWebView2Environment'],
  'windows.forbidden_entries': ['client/index.html', 'server/index.js'],
  'windows.require_exe': [true],
};

const ASSET_RE = /payesh[-A-Za-z0-9_.]*?\.(?:apk|aab|exe|msi|msix|appx|dmg|deb|rpm|AppImage|zip)\b/g;
export const normAsset = (n) => n.replace(/-\d+(?:\.\d+)+(?=\.[A-Za-z]+$)/, '-<ver>');
const stripComments = (txt) => txt.split('\n').map((l) => (/^\s*#/.test(l) ? '' : l)).join('\n');

// ---------- discovery ----------
const SHELL_RUNNERS = /(^|\/)(windows\/runner\/main\.cpp|linux\/(runner\/)?main\.cc|linux\/(runner\/)?my_application\.cc|macos\/Runner\/AppDelegate\.swift|ios\/Runner\/AppDelegate\.swift)$/;
const WRAPPER_FILES = /(^|\/)(capacitor\.config\.(json|ts|js)|tauri\.conf\.json|electron-builder\.(json|ya?ml)|forge\.config\.(js|cjs|ts)|ionic\.config\.json)$/;
const WRAPPER_DEPS = /"(electron|@capacitor\/core|@capacitor\/android|cordova|cordova-android|@tauri-apps\/api|@tauri-apps\/cli|nw|neutralinojs)"\s*:/;
const BINARY = /\.(apk|aab|exe|msi|msix|appx|dmg|deb|rpm|AppImage)$/i;

export function discover(files, read) {
  const out = [];
  for (const f of files) {
    if (f.includes('node_modules/')) continue;
    let kind = null;
    if (/(^|\/)src\/main\/AndroidManifest\.xml$/.test(f)) kind = 'android-project';
    else if (/\.(iss|nsi|wxs)$/i.test(f) || /(appxmanifest|\.msixmanifest)$/i.test(f)) kind = 'windows-installer';
    else if (/\.csproj$/.test(f) || SHELL_RUNNERS.test(f)) kind = 'desktop-shell';
    else if (/\.cs$/.test(f)) {
      const t = read(f);
      if (/static\s+(?:async\s+)?(?:void|int|Task(?:<int>)?)\s+Main\s*\(/.test(t) || /WebView2/.test(t)) kind = 'desktop-shell';
    } else if (WRAPPER_FILES.test(f)) kind = 'web-wrapper';
    else if (/(^|\/)config\.xml$/.test(f) && /<widget[\s>]/.test(read(f))) kind = 'web-wrapper';
    else if (/(^|\/)package\.json$/.test(f) && WRAPPER_DEPS.test(read(f))) kind = 'web-wrapper';
    else if (/(^|\/)install\.(sh|ps1|bat|cmd)$/.test(f)) kind = 'install-script';
    else if (/^[^/]*\.(bat|cmd|command|sh|ps1)$/.test(f) && /^(start|run|launch|payesh)/i.test(f)) kind = 'launcher';
    else if (/\.(vbs|desktop|lnk)$/i.test(f)) kind = 'launcher';
    else if (BINARY.test(f) || /^releases\/.*\.zip$/.test(f)) kind = 'tracked-binary';
    if (kind) out.push({ kind, path: f });
  }
  return out;
}

export function workflowAssets(files, read) {
  const out = [];
  for (const f of files.filter((x) => /^\.github\/workflows\/.*\.ya?ml$/.test(x))) {
    const names = new Set((stripComments(read(f)).match(ASSET_RE) || []).map(normAsset));
    for (const n of names) out.push({ workflow: f, asset: n });
  }
  return out;
}

export const isPublisher = (txt) => /gh release (?:upload|create)|softprops\/action-gh-release/.test(stripComments(txt));

// ---------- native static scan (real usage, not prose) ----------
const NATIVE_RULES = [
  { ext: /\.dart$/, re: /^\s*(?:import|export)\s+['"]package:(webview_flutter|flutter_inappwebview|webview_windows|webview_cef|desktop_webview_window|flutter_webview_plugin|webview_all)[/'"]/m, why: 'Dart WebView package import' },
  { ext: /pubspec\.yaml$/, re: /^\s+(webview_flutter|flutter_inappwebview|webview_windows|webview_cef|desktop_webview_window|flutter_webview_plugin|webview_all|flutter_js)\s*:/m, why: 'pubspec WebView/JS-engine dependency' },
  { ext: /pubspec\.yaml$/, re: /^\s+-\s+\S*(www\/|\.html?\b)/m, why: 'web UI bundled as Flutter asset' },
  { ext: /\.(java|kt)$/, re: /import\s+(android\.webkit\.(WebView|WebViewClient|WebChromeClient)|androidx\.webkit\.)|new\s+WebView\s*\(|\bWebView\s*\(\s*(this|context|ctx)|\.loadUrl\s*\(|addJavascriptInterface/, why: 'Android WebView usage' },
  { ext: /\.(gradle|kts)$/, re: /androidx\.webkit:webkit|com\.getcapacitor|org\.apache\.cordova|io\.ionic/, why: 'WebView/hybrid Gradle dependency' },
  { ext: /\.(cpp|cc|h|hpp)$/, re: /#include\s*[<"][^>"]*WebView2|CreateCoreWebView2Environment|ICoreWebView2/, why: 'WebView2 in native runner' },
  { ext: /CMakeLists\.txt$|\.cmake$/, re: /WebView2(Loader)?|Microsoft\.Web\.WebView2/, why: 'WebView2 linked in CMake' },
  { ext: /\.cs$/, re: /using\s+Microsoft\.Web\.WebView2|new\s+WebView2\s*\(/, why: 'WebView2 C# shell' },
  { ext: /\.iss$/, re: /^\s*Source:\s*"[^"]*(node\.exe|WebView2|node_modules|\\runtime\\|client\\index\.html|server\\index\.js)/mi, why: 'installer ships Node / WebView2 / web UI' },
  { ext: /\.iss$/, re: /^\s*Filename:\s*"https?:\/\//mi, why: 'installer launches a browser URL' },
  { ext: /AndroidManifest\.xml$/, re: /android:name="[^"]*(WebView|Capacitor|Cordova|BridgeActivity)[^"]*"/, why: 'WebView/hybrid activity in manifest' },
];

export function nativeViolations(files, read, entry) {
  const v = [];
  const mine = files.filter((f) => entry.sources.some((s) => f === s || (s.endsWith('/') && f.startsWith(s))));
  for (const f of mine) {
    if (/(^|\/)(test|integration_test|web)\//.test(f.slice(f.indexOf('/') + 1)) && !/pubspec\.yaml$/.test(f)) continue;
    if (/(^|\/)assets\/(www|public)\//.test(f) || /\.html?$/i.test(f)) { v.push(`${f}: web UI file inside a native app`); continue; }
    for (const r of NATIVE_RULES) {
      if (!r.ext.test(f)) continue;
      const t = read(f);
      if (t && r.re.test(t)) v.push(`${f}: ${r.why}`);
    }
  }
  return v;
}

// ---------- the check ----------
const DECLARED = new Set(['native', 'webview', 'server']);
const REQUIRED = ['id', 'title_fa', 'platform', 'audience', 'declared', 'status', 'sources', 'entrypoints', 'ui', 'html_css_js_ui', 'browser_engine_at_runtime', 'node_for_ui', 'runs_without_browser', 'capabilities', 'artifacts', 'published', 'row'];

// exact path only (a version number in a file name is normalised to <ver>)
const covers = (entry, p) => (entry.entrypoints || []).some((s) => p === s || normAsset(p) === s);
const chanMatch = (pat, tag) => (pat.endsWith('*') ? tag.startsWith(pat.slice(0, -1)) : pat === tag);

export function check(files, read, registry, criterion) {
  const F = [];
  const fail = (code, msg) => F.push(`${code} ${msg}`);
  const entries = registry.entries || [];
  const ids = new Set();

  // I-01 / I-02
  for (const e of entries) {
    for (const k of REQUIRED) if (!(k in e)) fail('I-01', `${e.id || '?'}: missing field ${k}`);
    if (ids.has(e.id)) fail('I-01', `duplicate id ${e.id}`); ids.add(e.id);
    if (!DECLARED.has(e.declared)) fail('I-01', `${e.id}: declared must be native|webview|server`);
    if (e.declared === 'native') {
      if (e.html_css_js_ui || e.browser_engine_at_runtime || e.node_for_ui || !e.runs_without_browser)
        fail('I-01', `${e.id}: declared native but html/browser/node flags say WebView`);
      if (/webview|negative-control|fixture/i.test(e.status)) fail('I-01', `${e.id}: declared native with WebView status "${e.status}"`);
    }
    if (e.declared === 'webview') {
      if (!(e.html_css_js_ui || e.browser_engine_at_runtime || e.node_for_ui)) fail('I-01', `${e.id}: declared webview but every WebView flag is false`);
      // row 129: the last WebView builds were removed from Release — a WebView entry may never be published again
      if ((e.published || []).length) fail('I-01', `${e.id}: WebView entry is published (row 129: WebView builds may only be negative controls / fixtures)`);
      if (/pending-removal/.test(e.status)) fail('I-01', `${e.id}: status "${e.status}" — nothing is pending removal after row 129`);
    }
    if (e.declared === 'server' && e.html_css_js_ui) fail('I-01', `${e.id}: declared server but has an HTML UI on the device`);
    for (const s of e.sources || []) if (!files.some((f) => f === s || f.startsWith(s))) fail('I-02', `${e.id}: source ${s} matches no tracked file`);
    for (const s of e.entrypoints || []) if (!files.some((f) => f === s || normAsset(f) === s)) fail('I-02', `${e.id}: entrypoint ${s} is not a tracked file`);
  }

  // I-03
  const found = discover(files, read);
  for (const d of found) if (!entries.some((e) => covers(e, d.path))) fail('I-03', `unregistered ${d.kind}: ${d.path}`);

  // I-04
  const wa = workflowAssets(files, read);
  const owners = (a) => entries.filter((e) => (e.artifacts || []).includes(a) || (e.published || []).some((p) => p.asset === a));
  for (const { workflow, asset } of wa) if (!owners(asset).length) fail('I-04', `unregistered asset ${asset} in ${workflow}`);

  // I-05 / I-06
  for (const e of entries.filter((x) => x.declared === 'native')) {
    for (const v of nativeViolations(files, read, e)) fail('I-05', `${e.id}: ${v}`);
    if ((e.artifacts || []).length) {
      const ev = e.gate_evidence || [];
      if (!ev.length) fail('I-06', `${e.id}: no gate_evidence`);
      for (const g of ev) {
        const t = files.includes(g.workflow) ? stripComments(read(g.workflow)) : '';
        const ok = t.split('\n').some((l) => l.includes('native-independence-gate.mjs') && l.includes(g.line_contains) && !l.includes('--expect-fail'));
        if (!ok) fail('I-06', `${e.id}: ${g.workflow} has no gate line containing ${JSON.stringify(g.line_contains)} (without --expect-fail)`);
      }
    }
  }

  // I-07 / I-10
  for (const wf of files.filter((x) => /^\.github\/workflows\/.*\.ya?ml$/.test(x))) {
    const raw = read(wf); if (!isPublisher(raw)) continue;
    for (const { asset } of wa.filter((x) => x.workflow === wf)) {
      const os = owners(asset); if (!os.length) continue;
      if (os.some((e) => e.declared === 'native' && (e.published || []).some((p) => p.workflow === wf && p.asset === asset))) continue;
      if (os.some((e) => e.declared !== 'native' && (e.published || []).some((p) => p.workflow === wf && p.asset === asset))) continue;
      if (os.every((e) => e.declared !== 'native')) fail('I-07', `${wf} ships WebView/legacy asset ${asset} that no entry declares as published by this workflow`);
    }
  }
  for (const e of entries.filter((x) => x.declared === 'native')) {
    for (const p of e.published || []) {
      const t = files.includes(p.workflow) ? stripComments(read(p.workflow)) : '';
      if (!t) { fail('I-10', `${e.id}: publisher ${p.workflow} missing`); continue; }
      const gated = t.split('\n').some((l) => l.includes('native-independence-gate.mjs') && !l.includes('--expect-fail'))
        || /uses:\s*\.\/\.github\/workflows\/native-client\.yml/.test(t);
      if (!gated) fail('I-10', `${e.id}: ${p.workflow} publishes ${p.asset} without running the native gate`);
      if (!t.includes(p.asset)) fail('I-10', `${e.id}: ${p.workflow} never mentions ${p.asset}`);
    }
  }

  // I-08
  for (const e of entries) for (const p of e.published || [])
    if ((registry.native_only_channels || []).some((c) => chanMatch(c, p.tag)) && e.declared !== 'native')
      fail('I-08', `${e.id} (${e.declared}) published to native-only channel ${p.tag}`);

  // I-11 (row 129) — every download link on the page must be a native entry's file on a native-only channel
  const SITE = 'site/index.html';
  if (files.includes(SITE)) {
    const html = read(SITE);
    const links = [...html.matchAll(/href="https:\/\/github\.com\/[^/"]+\/[^/"]+\/releases\/download\/([^/"]+)\/([^"]+)"/g)];
    const installable = (a) => /\.(apk|aab|exe|msi|msix|appx|dmg|deb|rpm|AppImage|zip)$/i.test(a);
    const nativeOnly = (tag) => (registry.native_only_channels || []).some((c) => chanMatch(c, tag));
    for (const [, tag, asset] of links) {
      if (!nativeOnly(tag)) { fail('I-11', `${SITE} links ${tag}/${asset} — the page may link only native-only channels`); continue; }
      if (!installable(asset)) continue; // SHA256SUMS / status json
      if (!entries.some((e) => e.declared === 'native' && (e.published || []).some((p) => p.asset === asset && chanMatch(p.tag, tag))))
        fail('I-11', `${SITE} links ${tag}/${asset}, which is not a native file on a native-only channel`);
    }
    for (const m of html.matchAll(/data-asset="([^"]+)"/g))
      if (installable(m[1]) && !entries.some((e) => e.declared === 'native' && (e.published || []).some((p) => p.asset === m[1])))
        fail('I-11', `${SITE} data-asset ${m[1]} is not published by a native entry`);
  }

  // I-09
  for (const [key, want] of Object.entries(BASELINE)) {
    const [plat, field] = key.split('.');
    let have = criterion?.[plat]?.[field];
    if (field === 'forbidden_method_refs') have = (have || []).map((r) => r.class);
    if (field === 'require_exe') have = [have];
    for (const w of want) if (!(have || []).includes(w)) fail('I-09', `criterion ${key} lost ${JSON.stringify(w)}`);
  }
  if (criterion?.android?.forbidden_method_refs) {
    const wv = criterion.android.forbidden_method_refs.find((r) => r.class === 'Landroid/webkit/WebView;');
    for (const n of ['<init>', 'loadUrl', 'loadData', 'loadDataWithBaseURL', 'addJavascriptInterface', 'evaluateJavascript', 'postUrl'])
      if (!wv || !wv.names.includes(n)) fail('I-09', `criterion WebView method ${n} removed`);
  }

  return { failures: F, discovered: found, assets: wa };
}

// ---------- CLI ----------
export function loadRepo(root) {
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const cache = new Map();
  const read = (f) => {
    if (!cache.has(f)) { let t = ''; try { t = fs.readFileSync(path.join(root, f), 'utf8'); } catch { /* deleted in worktree */ } cache.set(f, t); }
    return cache.get(f);
  };
  return { files, read };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.cwd();
  const { files, read } = loadRepo(root);
  const registry = JSON.parse(read(REGISTRY));
  const criterion = JSON.parse(read(CRITERION));
  const r = check(files, read, registry, criterion);
  const yes = (b) => (b ? 'yes' : 'no');
  console.log('id | platform | audience | declared | status | HTML/JS UI | browser engine | Node for UI | without browser | published');
  for (const e of registry.entries)
    console.log([e.id, e.platform, e.audience, e.declared, e.status, yes(e.html_css_js_ui), yes(e.browser_engine_at_runtime), yes(e.node_for_ui), yes(e.runs_without_browser), (e.published || []).map((p) => `${p.tag}:${p.asset}`).join(' ') || '-'].join(' | '));
  console.log(`discovered=${r.discovered.length} workflow_assets=${r.assets.length}`);
  for (const f of r.failures) console.log('FAIL ' + f);
  const nat = registry.entries.filter((e) => e.declared === 'native').length;
  const wv = registry.entries.filter((e) => e.declared === 'webview' && (e.published || []).length).length;
  console.log(r.failures.length ? `INSTALLABLES-125-FAILED failures=${r.failures.length}`
    : `INSTALLABLES-125-OK entries=${registry.entries.length} native=${nat} webview_still_published=${wv} discovered=${r.discovered.length}`);
  process.exit(r.failures.length ? 1 : 0);
}
