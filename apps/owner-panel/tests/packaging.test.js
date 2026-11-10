'use strict';
/* ═══════════════════════════════════════════════════════════════════
   آزمون ایستای بسته‌بندی پنل مالک — PR‑4 · ردیف ۹۹ · ADR‑62
   هر قاعده یک تابع روی نقشهٔ فایل‌هاست تا بتوان آن را با جهش (mutation)
   درون حافظه قرمز کرد: هر قاعده حداقل یک کنترل منفی دارد.
     P1  شناسه‌ها جدا از اپ مدرسه (applicationId، AppId، پوشه، میان‌بر، exe، مانیفست)
     P2  بدون آدرس/توکن/کلید سخت‌کد در پوسته‌ها
     P3  قیود امنیتی پوسته (پل JS، TLS، cleartext، backup، debuggable، مجوز)
     P4  workflow: نام‌های ثابت، گیت، شرط انتشار، Secretهای جدا، بدون continue-on-error
     P5  ADR‑62 موجود و صریحاً «ردیف ۶۳ تغییر نمی‌کند»؛ فایل‌های اپ مدرسه
         به پنل مالک ارجاع نمی‌دهند
     P6  قطعیت بستهٔ وب + خودآزمایی گیت خروجی‌ها
   اجرا: node apps/owner-panel/tests/packaging.test.js
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const F = {
  ownerGradle: 'apps/owner-panel/android/app/build.gradle',
  ownerManifest: 'apps/owner-panel/android/app/src/main/AndroidManifest.xml',
  ownerNsc: 'apps/owner-panel/android/app/src/main/res/xml/network_security_config.xml',
  ownerStrings: 'apps/owner-panel/android/app/src/main/res/values/strings.xml',
  ownerActivity: 'apps/owner-panel/android/app/src/main/java/ir/payesh/owner/MainActivity.java',
  ownerOrigin: 'apps/owner-panel/android/app/src/main/java/ir/payesh/owner/OriginPolicy.java',
  ownerSettings: 'apps/owner-panel/android/settings.gradle',
  ownerCs: 'apps/owner-panel/desktop/PayeshOwner.cs',
  ownerWinManifest: 'apps/owner-panel/desktop/app.manifest',
  ownerBuildPs1: 'apps/owner-panel/desktop/build.ps1',
  ownerIss: 'apps/owner-panel/installer/payesh-owner.iss',
  workflow: '.github/workflows/owner-panel.yml',
  adr: 'docs/cloud/62-adr-owner-panel-packaging.md',
  schoolGradle: 'install/android/app/build.gradle',
  schoolIss: 'installer/payesh.iss',
  schoolWinManifest: 'desktop/app.manifest',
  schoolBuildYml: '.github/workflows/build.yml',
  schoolBuildPs1: 'desktop/build.ps1',
};

function load() {
  const files = {};
  for (const [k, rel] of Object.entries(F)) files[k] = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^\uFEFF/, '');
  return files;
}

const one = (re, s, label) => {
  const m = re.exec(s);
  if (!m) throw new Error(`${label}: not found`);
  return m[1];
};
const issValue = (iss, key) => one(new RegExp(`^${key}=(.+)$`, 'm'), iss, key).trim();

/* ── قواعد ─────────────────────────────────────────────────────────── */
const RULES = {
  P1_android_id(f) {
    const ownerId = one(/applicationId\s+"([^"]+)"/, f.ownerGradle, 'owner applicationId');
    const ownerNs = one(/namespace\s+'([^']+)'/, f.ownerGradle, 'owner namespace');
    const schoolId = one(/applicationId\s+"([^"]+)"/, f.schoolGradle, 'school applicationId');
    assert.equal(ownerId, 'ir.payesh.owner', 'owner applicationId must be ir.payesh.owner');
    assert.equal(ownerNs, ownerId, 'owner namespace must equal applicationId');
    assert.notEqual(ownerId, schoolId, 'owner applicationId must differ from the school app');
    assert.ok(!/ir\.payesh\.local/.test(f.ownerGradle + f.ownerManifest + f.ownerActivity), 'school package must not appear in the owner app');
    assert.match(f.ownerSettings, /rootProject\.name\s*=\s*"PayeshOwner"/);
  },
  P1_windows_id(f) {
    const ownerAppId = issValue(f.ownerIss, 'AppId').toUpperCase();
    const schoolAppId = issValue(f.schoolIss, 'AppId').toUpperCase();
    assert.match(ownerAppId, /^\{\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/, 'owner AppId GUID');
    assert.notEqual(ownerAppId, schoolAppId, 'owner AppId must differ from the school installer');
    assert.equal(issValue(f.ownerIss, 'DefaultDirName'), '{localappdata}\\Programs\\PayeshOwner');
    assert.notEqual(issValue(f.ownerIss, 'DefaultDirName'), issValue(f.schoolIss, 'DefaultDirName'));
    assert.equal(issValue(f.ownerIss, 'OutputBaseFilename'), 'payesh-owner-setup');
    assert.equal(issValue(f.ownerIss, 'PrivilegesRequired'), 'lowest');
    const ownerName = one(/#define AppName "([^"]+)"/, f.ownerIss, 'owner AppName');
    const schoolName = one(/#define AppName "([^"]+)"/, f.schoolIss, 'school AppName');
    assert.notEqual(ownerName, schoolName, 'shortcut/app name must differ');
    assert.match(f.ownerIss, /#define AppExeName "PayeshOwner\.exe"/);
    assert.ok(!/Payesh\.exe"|\\desktop\\Payesh\.exe|\.build\\win\\/.test(f.ownerIss), 'owner installer must not ship school binaries');
    const ownerAsm = one(/assemblyIdentity[^>]*name="([^"]+)"/, f.ownerWinManifest, 'owner manifest');
    const schoolAsm = one(/assemblyIdentity[^>]*name="([^"]+)"/, f.schoolWinManifest, 'school manifest');
    assert.notEqual(ownerAsm, schoolAsm, 'win32 manifest identity must differ');
    assert.match(f.ownerBuildPs1, /PayeshOwner\.exe/);
    assert.ok(!/PayeshApp\.cs/.test(f.ownerBuildPs1), 'owner build must not compile the school app source');
  },
  P2_no_hardcoded(f) {
    const URL_RE = /https?:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}[^\s"'<)]*/g;
    const ALLOW = [/^https?:\/\/schemas\.(android|microsoft)\.com\//, /^http:\/\/schemas\.microsoft\.com\/SMI\//];
    for (const k of ['ownerGradle', 'ownerManifest', 'ownerNsc', 'ownerStrings', 'ownerActivity', 'ownerOrigin', 'ownerCs']) {
      for (const m of f[k].matchAll(URL_RE)) {
        if (!ALLOW.some(a => a.test(m[0]))) throw new Error(`P2 hardcoded URL in ${F[k]}: ${m[0]}`);
      }
    }
    const SECRET_RE = [
      /\b(?:storePassword|keyPassword)\s+['"][^'"]{4,}['"]/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /\b(?:ghp|github_pat|gho)_[A-Za-z0-9_]{20,}/,
      /\bBearer\s+[A-Za-z0-9._-]{16,}/,
      /\/p\s+['"][^'"$]{4,}['"]/,
    ];
    for (const k of Object.keys(F).filter(k => k.startsWith('owner') || k === 'workflow')) {
      for (const re of SECRET_RE) if (re.test(f[k])) throw new Error(`P2 literal credential in ${F[k]}: ${re}`);
    }
    for (const n of ['PAYESH_OWNER_KEYSTORE_B64', 'PAYESH_OWNER_KEYSTORE_PASS', 'PAYESH_OWNER_KEY_PASS', 'PAYESH_OWNER_WIN_PFX_B64', 'PAYESH_OWNER_WIN_PFX_PASS']) {
      for (const m of f.workflow.matchAll(new RegExp(`${n}\\s*:\\s*(.+)$`, 'gm'))) {
        assert.match(m[1].trim(), /^\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}$/, `P2 ${n} must come only from secrets.*`);
      }
    }
  },
  P3_android_hardening(f) {
    assert.ok(!/addJavascriptInterface/.test(f.ownerActivity), 'no JS bridge');
    assert.ok(!/\.proceed\s*\(/.test(f.ownerActivity), 'TLS errors must never proceed');
    assert.match(f.ownerActivity, /onReceivedSslError[\s\S]{0,200}handler\.cancel\(\)/);
    assert.match(f.ownerActivity, /setAllowFileAccess\(false\)/);
    assert.match(f.ownerActivity, /setAllowContentAccess\(false\)/);
    assert.match(f.ownerActivity, /MIXED_CONTENT_NEVER_ALLOW/);
    assert.match(f.ownerActivity, /FLAG_SECURE/);
    assert.match(f.ownerActivity, /setWebContentsDebuggingEnabled\(false\)/);
    assert.match(f.ownerActivity, /OriginPolicy\.sameOrigin\(url, origin\)\) return false;\s*\n[^\n]*\n\s*return true;/, 'off-origin navigation must be blocked');
    assert.ok(!/setAllow(File|Content|UniversalAccessFromFile|FileAccessFromFile)\w*\(true\)/.test(f.ownerActivity));
    assert.match(f.ownerManifest, /android:allowBackup="false"/);
    assert.match(f.ownerManifest, /android:usesCleartextTraffic="false"/);
    const perms = [...f.ownerManifest.matchAll(/uses-permission android:name="([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual(perms, ['android.permission.INTERNET'], 'only INTERNET permission');
    assert.ok(!/android:debuggable="true"/.test(f.ownerManifest));
    assert.match(f.ownerGradle, /release\s*\{[\s\S]*?debuggable false/);
    assert.match(f.ownerNsc, /<base-config cleartextTrafficPermitted="false">/);
    const cleartextDomains = [...f.ownerNsc.matchAll(/<domain[^>]*>([^<]+)<\/domain>/g)].map(m => m[1]).sort();
    assert.deepEqual(cleartextDomains, ['127.0.0.1', 'localhost'], 'cleartext only for loopback');
    assert.match(f.ownerOrigin, /scheme\.equals\("https"\)/);
  },
  P3_windows_hardening(f) {
    for (const re of [/AreDevToolsEnabled = false/, /AreHostObjectsAllowed = false/, /IsWebMessageEnabled = false/,
      /NewWindowRequested[^;]*a\.Handled = true/, /DownloadStarting[^;]*a\.Cancel = true/,
      /PermissionRequested[^;]*CoreWebView2PermissionState\.Deny/, /ServerCertificateErrorAction\.Cancel/,
      /core\.NavigationStarting \+= delegate \(object o, CoreWebView2NavigationStartingEventArgs a\)\s*\{\s*if \(!OriginPolicy\.SameOrigin\(a\.Uri, origin\)\) a\.Cancel = true;/,
      /core\.FrameNavigationStarting \+= delegate \(object o, CoreWebView2NavigationStartingEventArgs a\)\s*\{\s*if \(!OriginPolicy\.SameOrigin\(a\.Uri, origin\)\) a\.Cancel = true;/]) {
      assert.match(f.ownerCs, re, `P3 windows: ${re}`);
    }
    assert.ok(!/AddHostObjectToScript|PostWebMessage|AddScriptToExecuteOnDocumentCreated/.test(f.ownerCs), 'no JS bridge in WebView2 shell');
    assert.ok(!/ServerCertificateErrorAction\.AlwaysAllow/.test(f.ownerCs));
    assert.match(f.ownerWinManifest, /level="asInvoker"/);
  },
  P4_workflow(f) {
    const w = f.workflow;
    for (const n of ['payesh-owner-setup.exe', 'payesh-owner.apk', 'payesh-owner-web.zip', 'SHA256SUMS']) {
      assert.ok(w.includes(n), `P4 fixed artifact name missing: ${n}`);
    }
    assert.ok(!/continue-on-error:\s*true/.test(w), 'P4 continue-on-error is forbidden');
    assert.match(w, /group: payesh-owner-\$\{\{ github\.ref \}\}/);
    assert.match(w, /needs: \[owner-web, owner-android, owner-windows\]\n\s+if: always\(\)/, 'gate must run even when a build fails');
    assert.match(w, /if \[ "\$r" != "success" \]; then echo "::error::[^"]*"; exit 1; fi/, 'any failed build must turn the gate red');
    assert.match(w, /check-owner-artifacts\.js verify --dir dist --commit "\$GITHUB_SHA"/);
    assert.match(w, /check-owner-artifacts\.js --self-test/);
    for (const m of w.matchAll(/if-no-files-found:\s*(\w+)/g)) assert.equal(m[1], 'error', 'missing upload must fail');
    const pub = one(/(- name: انتشار آزمایشی[\s\S]*)$/, w, 'publish step');
    assert.match(pub, /^- name: [^\n]*\n\s+if: github\.ref == 'refs\/heads\/main'\n/, 'publish only on main');
    assert.match(pub, /cp dist\/SHA256SUMS\.release pub\/SHA256SUMS/, 'published SHA256SUMS must cover only eligible files');
    assert.match(pub, /grep -q "  \$name\\\$" dist\/SHA256SUMS\.release/, 'exe/apk published only if release-eligible');
    assert.match(pub, /--prerelease/);
    assert.ok(!/gh release (create|upload) continuous\b/.test(w), 'must not write to the school continuous release');
    assert.ok(!/secrets\.PAYESH_(KEYSTORE|KEY_)/.test(w), 'school signing secrets must not be used');
    assert.ok(!/install\/android|installer\/payesh\.iss|desktop\\build\.ps1|desktop\/build\.ps1(?!\S)/.test(w.replace(/apps\\owner-panel\\desktop\\build\.ps1/g, '')), 'workflow must not build school paths');
    assert.match(w, /apksigner" verify "\$APK" >\/dev\/null 2>&1; then\s*\n\s*echo "::error::/, 'unsigned APK must be proven unsigned');
    assert.match(w, /\$s\.Status -ne 'NotSigned'/, 'unsigned exe must be proven unsigned');
    assert.match(w, /\$s\.Status -ne 'Valid'/, 'signed exe must verify as Valid');
  },
  P5_adr_and_boundary(f) {
    assert.match(f.adr, /^# ADR‑62 /m, 'ADR header must carry ADR‑62');
    assert.ok(!/^#.*\bD[‑-]62\b/m.test(f.adr), 'ADR must not call itself D‑62');
    assert.match(f.adr, /ردیف ۶۳ و دروازهٔ استقلال بومی کلاینت مدرسه تغییر نمی‌کند و تضعیف نمی‌شود/);
    assert.match(f.adr, /فقط برای ابزار مدیریتی مالک پلتفرم/);
    assert.match(f.adr, /D‑44/);
    assert.ok(!/owner-panel|PayeshOwner|payesh-owner/.test(f.schoolBuildYml + f.schoolIss + f.schoolGradle + f.schoolBuildPs1), 'school build files must not reference the owner panel');
  },
};

/* ── جهش‌ها: هر کدام باید دقیقاً قاعدهٔ خودش را قرمز کند ───────────── */
const MUTATIONS = [
  ['P1_android_id', 'ownerGradle', s => s.replace('applicationId "ir.payesh.owner"', 'applicationId "ir.payesh.local"')],
  ['P1_windows_id', 'ownerIss', s => s.replace(/^AppId=.*$/m, 'AppId={{7C4E2A51-9F3B-4E7A-9C21-5B8A1D3E6F02}')],
  ['P1_windows_id', 'ownerIss', s => s.replace(/^DefaultDirName=.*$/m, 'DefaultDirName={autopf}\\Payesh')],
  ['P1_windows_id', 'ownerWinManifest', s => s.replace('Payesh.Owner.Desktop', 'Payesh.Local.Desktop')],
  ['P2_no_hardcoded', 'ownerActivity', s => s.replace('web.loadUrl(origin + "/");', 'web.loadUrl("https://owner.payesh.example.com/");')],
  ['P2_no_hardcoded', 'ownerCs', s => s.replace('string saved = null;', 'string saved = "https://owner.payesh.example.com";')],
  ['P2_no_hardcoded', 'ownerGradle', s => s.replace('storePassword ownerSigning.storePassword', ['storePassword', " 'synthetic-not-a-secret'"].join(''))],
  ['P2_no_hardcoded', 'workflow', s => s.replace('PAYESH_OWNER_KEY_PASS: ${{ secrets.PAYESH_OWNER_KEY_PASS }}', 'PAYESH_OWNER_KEY_PASS: literal-value')],
  ['P3_android_hardening', 'ownerActivity', s => s.replace('configure(web);', 'configure(web); web.addJavascriptInterface(new Object(), "bridge");')],
  ['P3_android_hardening', 'ownerActivity', s => s.replace('handler.cancel();', 'handler.proceed();')],
  ['P3_android_hardening', 'ownerManifest', s => s.replace('<uses-permission android:name="android.permission.INTERNET" />', '<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.CAMERA" />')],
  ['P3_android_hardening', 'ownerNsc', s => s.replace('<base-config cleartextTrafficPermitted="false">', '<base-config cleartextTrafficPermitted="true">')],
  ['P3_windows_hardening', 'ownerCs', s => s.replace('s.AreHostObjectsAllowed = false;', 's.AreHostObjectsAllowed = true;')],
  ['P3_windows_hardening', 'ownerCs', s => s.replace('if (!OriginPolicy.SameOrigin(a.Uri, origin)) a.Cancel = true;', 'if (false) a.Cancel = true;')],
  ['P3_windows_hardening', 'ownerCs', s => s.split('if (!OriginPolicy.SameOrigin(a.Uri, origin)) a.Cancel = true;').join('#X#').replace('#X#', 'if (!OriginPolicy.SameOrigin(a.Uri, origin)) a.Cancel = true;').replace('#X#', '{ }')],
  ['P4_workflow', 'workflow', s => s.replace("        if: github.ref == 'refs/heads/main'\n        env:\n          GH_TOKEN", '        env:\n          GH_TOKEN')],
  ['P4_workflow', 'workflow', s => s.replace('      - name: گیت خروجی‌ها (fail-closed)\n', '      - name: گیت خروجی‌ها (fail-closed)\n        continue-on-error: true\n')],
  ['P4_workflow', 'workflow', s => s.replace('cp dist/SHA256SUMS.release pub/SHA256SUMS', 'cp dist/SHA256SUMS pub/SHA256SUMS')],
  ['P4_workflow', 'workflow', s => s.replace('    if: always()\n    permissions:', '    permissions:')],
  ['P4_workflow', 'workflow', s => s.replace(/if-no-files-found: error/, 'if-no-files-found: warn')],
  ['P5_adr_and_boundary', 'adr', s => s.replace('ردیف ۶۳ و دروازهٔ استقلال بومی کلاینت مدرسه تغییر نمی‌کند و تضعیف نمی‌شود', 'ردیف ۶۳ برای پنل مالک بازنگری می‌شود')],
  ['P5_adr_and_boundary', 'schoolBuildYml', s => s + '\n# payesh-owner-setup.exe\n'],
];

let CHECKS = 0;
function runRules(files) {
  for (const [name, fn] of Object.entries(RULES)) { fn(files); CHECKS++; }
}

function staticChecks() {
  CHECKS = 0;
  const files = load();
  runRules(files);
  let caught = 0;
  for (const [rule, key, mutate] of MUTATIONS) {
    const mutated = Object.assign({}, files, { [key]: mutate(files[key]) });
    assert.notEqual(mutated[key], files[key], `mutation for ${rule}/${key} did not apply`);
    assert.throws(() => RULES[rule](mutated), undefined, `mutation on ${key} was not caught by ${rule}`);
    caught++;
  }
  return { rules: Object.keys(RULES).length, mutations: caught };
}

function scriptChecks() {
  const { build, collect } = require('../scripts/package-web.js');
  const { readZip } = require('../scripts/zip-lite.js');
  const a = build({ commit: 'f'.repeat(40) });
  const b = build({ commit: 'f'.repeat(40) });
  const sha = x => crypto.createHash('sha256').update(x).digest('hex');
  assert.equal(sha(a), sha(b), 'web zip must be deterministic');
  const c = build({ commit: 'e'.repeat(40) });
  assert.notEqual(sha(a), sha(c), 'commit must be embedded (negative control)');
  const m = readZip(a);
  for (const need of ['web/index.html', 'web/app.js', 'web/theme.css', 'server/static-server.js', 'BUILD-INFO.json', 'START-HERE.txt']) {
    assert.ok(m.has('payesh-owner-web/' + need), 'web zip missing ' + need);
  }
  assert.ok(![...m.keys()].some(k => /client\/|pages\.js|node_modules|\.env/.test(k)), 'web zip must contain only owner-panel files');
  const info = JSON.parse(m.get('payesh-owner-web/BUILD-INFO.json'));
  assert.equal(info.commit, 'f'.repeat(40));
  assert.equal(info.files.length, collect().length - 1);
  const gate = require('../scripts/check-owner-artifacts.js');
  const neg = gate.selfTest();
  assert.ok(neg >= 15, 'artifact gate must keep ≥15 negative controls');
  return { zip_sha256: sha(a), negative_controls: neg };
}

function all() {
  const s = staticChecks();
  const z = scriptChecks();
  console.log(`OWNER-PACKAGING rules=${s.rules} mutations_caught=${s.mutations} gate_negative_controls=${z.negative_controls} failures=0`);
  return Object.assign({}, s, z);
}

module.exports = { staticChecks, scriptChecks, all, RULES, MUTATIONS, load };

if (require.main === module) {
  try { all(); } catch (e) { console.error('OWNER-PACKAGING FAIL', e && e.message); process.exit(1); }
}
