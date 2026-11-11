#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   Rows 76 + 77 — native release packaging: unit + wiring tests

   tools/android-release-check-76.mjs is fed RAW-format outputs of aapt2 /
   apksigner / jarsigner (the CI job feeds the real ones from the real APK/AAB):
     AR-OK-1  owner-signed release passes, distributable=true
     AR-OK-2  debug-signed rehearsal passes, distributable=false, NOT FOR DISTRIBUTION
     AR-N1..  NEGATIVE: debug cert in release mode, pinned cert mismatch,
              targetSdk below Google Play, debuggable, unsigned, v1-only,
              two signers, extra permission, missing INTERNET, wrong package,
              AAB unverified, AAB debug-signed in release mode, bad input
   Wiring (rows 76/77):
     W-1  build.gradle.kts signs only from env, fail-closed flag, no secrets in repo
     W-2  release manifest declares INTERNET (release build can reach the Gateway)
     W-3  native-client.yml: secrets → temp keystore, fail-closed control, release
          check on the real APK/AAB, tag ⇒ release-signed only
     W-4  Inno Setup script: own AppId, per-user, bundle only, no node/WebView2
     W-5  windows job: app-local MSVC, ISCC, silent install → gate 63 on the installed
          app → dumpbin MSVC check → uninstall; Authenticode only with Secrets
     W-6  release-gate passes secrets to the native workflow; policy matches Play
   Last line: NATIVE-RELEASE-76-77-OK checks=N | NATIVE-RELEASE-76-77-FAILED
   ═══════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools/android-release-check-76.mjs');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
function check(id, title, fn) {
  try { const n = fn(); pass++; console.log(`PASS  ${id}  ${title}${n ? '  → ' + n : ''}`); }
  catch (e) { fail++; console.log(`FAIL  ${id}  ${title}  → ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }

const OWNER_SHA = 'a1'.repeat(32);
const badging = (o = {}) => [
  `package: name='${o.pkg || 'ir.payesh.school.payesh_app'}' versionCode='${o.vc || '42'}' versionName='0.1.0' platformBuildVersionName='16' platformBuildVersionCode='36' compileSdkVersion='36' compileSdkVersionCodename='16'`,
  `minSdkVersion:'${o.min || 24}'`,
  `targetSdkVersion:'${o.target || 36}'`,
  ...(o.perms || ['android.permission.INTERNET', 'ir.payesh.school.payesh_app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION']).map(p => `uses-permission: name='${p}'`),
  "application-label:'payesh_app'",
  "application: label='payesh_app' icon='res/mipmap-mdpi-v4/ic_launcher.png'",
  ...(o.debuggable ? ['application-debuggable'] : []),
  "launchable-activity: name='ir.payesh.school.payesh_app.MainActivity'  label='' icon=''",
  "native-code: 'arm64-v8a' 'armeabi-v7a' 'x86_64'",
].join('\n') + '\n';
const signer = (n, dn, sha) => `Signer #${n} certificate DN: ${dn}\nSigner #${n} certificate SHA-256 digest: ${sha}\nSigner #${n} certificate SHA-1 digest: ${'b2'.repeat(20)}\nSigner #${n} certificate MD5 digest: ${'c3'.repeat(16)}\n`;
const certs = (o = {}) => (o.unsigned ? 'DOES NOT VERIFY\nERROR: Missing META-INF/MANIFEST.MF\n' : 'Verifies\n')
  + `Verified using v1 scheme (JAR signing): ${o.v1 === undefined ? false : o.v1}\n`
  + `Verified using v2 scheme (APK Signature Scheme v2): ${o.v2 === undefined ? true : o.v2}\n`
  + `Verified using v3 scheme (APK Signature Scheme v3): ${o.v3 === undefined ? true : o.v3}\n`
  + 'Verified using v3.1 scheme (APK Signature Scheme v3.1): false\nVerified using v4 scheme (APK Signature Scheme v4): false\nVerified for SourceStamp: false\n'
  + `Number of signers: ${o.signers ? o.signers.length : 1}\n`
  + (o.signers || [[o.dn || 'CN=Payesh Owner, O=Payesh Local, C=IR', o.sha || OWNER_SHA]]).map((s, i) => signer(i + 1, s[0], s[1].match(/../g).join(':').toUpperCase())).join('');
const DEBUG = ['C=US, O=Android, CN=Android Debug', 'd4'.repeat(32)];
const jar = (o = {}) => o.unsigned ? 'jar is unsigned.\n' : `\ns k      1234 Mon Jan 01 00:00:00 UTC 2026 base/manifest/AndroidManifest.xml\n\n      >>> Signer\n      X.509, ${o.debug ? 'C=US, O=Android, CN=Android Debug' : 'CN=Payesh Owner, O=Payesh Local, C=IR'}\n      [certificate is valid from 1/1/26 to 1/1/51]\n\njar verified.\n`;

function run(b, c, j, args = []) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ar76-'));
  fs.writeFileSync(path.join(d, 'b.txt'), b); fs.writeFileSync(path.join(d, 'c.txt'), c);
  const extra = j === null ? [] : (fs.writeFileSync(path.join(d, 'j.txt'), j), ['--aab-jarsigner', path.join(d, 'j.txt')]);
  const r = spawnSync(process.execPath, [TOOL, '--badging', path.join(d, 'b.txt'), '--certs', path.join(d, 'c.txt'), ...extra, ...args], { encoding: 'utf8' });
  fs.rmSync(d, { recursive: true, force: true });
  const out = r.stdout + r.stderr;
  return { code: r.status, out, last: out.trim().split('\n').pop() };
}
const neg = (id, title, b, c, j, args, needle) => check(id, `NEGATIVE: ${title}`, () => {
  const r = run(b, c, j, args);
  assert(r.code === 1 && /^ANDROID-RELEASE-76-FAIL/.test(r.last), `exit ${r.code}: ${r.last}`);
  assert(r.out.includes(needle), `no "${needle}" in output: ${r.out.slice(-300)}`);
  return needle;
});

console.log(`# rows 76/77 native release packaging — node ${process.version}`);

check('AR-OK-1', 'owner-signed release APK + AAB passes, distributable', () => {
  const r = run(badging(), certs(), jar(), ['--mode', 'release', '--expect-cert-sha256', OWNER_SHA]);
  assert(r.code === 0 && r.last.includes('mode=release distributable=true'), `${r.code}: ${r.last}`);
  return r.last;
});
check('AR-OK-2', 'debug-signed rehearsal passes but is labelled NOT FOR DISTRIBUTION', () => {
  const r = run(badging(), certs({ signers: [DEBUG] }), jar({ debug: true }), ['--mode', 'rehearsal']);
  assert(r.code === 0 && r.last.includes('distributable=false') && r.last.includes('NOT FOR DISTRIBUTION'), `${r.code}: ${r.last}`);
  return 'rehearsal';
});
neg('AR-N1', 'release mode with the Android debug certificate', badging(), certs({ signers: [DEBUG] }), jar(), ['--mode', 'release'], 'AR-08');
neg('AR-N2', 'release mode, signer differs from the owner-pinned fingerprint', badging(), certs({ sha: 'e5'.repeat(32) }), jar(), ['--mode', 'release', '--expect-cert-sha256', OWNER_SHA], 'pinned');
neg('AR-N3', 'targetSdk 35 (below Google Play 2026)', badging({ target: 35 }), certs(), jar(), ['--mode', 'release'], 'AR-02');
neg('AR-N4', 'debuggable APK', badging({ debuggable: true }), certs(), jar(), ['--mode', 'release'], 'AR-04');
neg('AR-N5', 'unsigned / not verifying APK', badging(), certs({ unsigned: true }), jar(), ['--mode', 'rehearsal'], 'AR-05');
neg('AR-N6', 'v1-only (JAR) signature', badging(), certs({ v1: true, v2: false, v3: false }), jar(), ['--mode', 'release'], 'no v2/v3');
neg('AR-N7', 'two signers', badging(), certs({ signers: [['CN=A', OWNER_SHA], ['CN=B', 'f6'.repeat(32)]] }), jar(), ['--mode', 'release'], 'AR-06');
neg('AR-N8', 'permission outside the allowlist (READ_CONTACTS)', badging({ perms: ['android.permission.INTERNET', 'android.permission.READ_CONTACTS'] }), certs(), jar(), ['--mode', 'release'], 'READ_CONTACTS');
neg('AR-N9', 'release build without INTERNET', badging({ perms: [] }), certs(), jar(), ['--mode', 'release'], 'required permission missing');
neg('AR-N10', 'wrong application id', badging({ pkg: 'com.example.app' }), certs(), jar(), ['--mode', 'release'], 'AR-01');
neg('AR-N11', 'AAB not verified by jarsigner', badging(), certs(), jar({ unsigned: true }), ['--mode', 'release'], 'AR-09');
neg('AR-N12', 'AAB debug-signed in release mode', badging(), certs(), jar({ debug: true }), ['--mode', 'release'], 'AAB signed with the Android debug');
neg('AR-N13', 'garbage instead of aapt2 output', 'hello\n', certs(), null, ['--mode', 'rehearsal'], 'no package line');
check('AR-N14', 'NEGATIVE: missing inputs / unknown flag ⇒ exit 2', () => {
  const a = spawnSync(process.execPath, [TOOL, '--badging', '/nonexistent'], { encoding: 'utf8' });
  const b = spawnSync(process.execPath, [TOOL, '--bogus'], { encoding: 'utf8' });
  assert(a.status === 2 && b.status === 2, `${a.status}/${b.status}`);
  return 'exit 2';
});

/* build-tools 37 changed `apksigner verify --print-certs`: "V2 Signer: certificate DN: …" instead of "Signer #1 …".
   The fixtures are REAL apksigner 37.0 output (throwaway test key, CN=Test) — CI failed AR-06 on this format. */
const FIX37 = f => fs.readFileSync(path.join(ROOT, 'tests/fixtures/apksigner-37', f), 'utf8');
const SHA37 = '3e97c784c7d7f0c7b8733ac64fce3b1591342201795253651cd03f41b45390eb';
check('AR-OK-3', 'real apksigner 37 output (v2-only and v2+v3): exactly one signer, pinned digest matches', () => {
  for (const f of ['v2-only.txt', 'v2-v3.txt']) {
    const r = run(badging(), FIX37(f), jar(), ['--mode', 'release', '--expect-cert-sha256', SHA37]);
    assert(r.code === 0 && r.last.includes(`signer_sha256=${SHA37}`), `${f}: ${r.code}: ${r.last}`);
  }
  return 'v2-only, v2+v3';
});
neg('AR-N15', 'apksigner 37 format with two different certificates', badging(),
  FIX37('v2-only.txt') + 'V3.1 Signer: certificate DN: CN=Other\nV3.1 Signer: certificate SHA-256 digest: ' + 'f6'.repeat(32) + '\n',
  jar(), ['--mode', 'release'], 'AR-06');
neg('AR-N16', 'apksigner 37 format, signer differs from the owner pin', badging(), FIX37('v2-v3.txt'), jar(),
  ['--mode', 'release', '--expect-cert-sha256', OWNER_SHA], 'pinned');

check('W-1', 'build.gradle.kts: signing only from env, fail-closed flag, v2/v3, not debuggable', () => {
  const g = read('apps/payesh/app/android/app/build.gradle.kts');
  for (const n of ['PAYESH_KEYSTORE', 'PAYESH_KEYSTORE_PASS', 'PAYESH_KEY_ALIAS', 'PAYESH_KEY_PASS']) assert(g.includes(`System.getenv("${n}")`) || g.includes(`"${n}"`), `${n} not read from env`);
  assert(g.includes('PAYESH_NATIVE_REQUIRE_RELEASE_SIGNING') && g.includes('PAYESH-SIGNING-REQUIRED') && g.includes('GradleException'), 'no fail-closed switch');
  assert(/enableV2Signing = true/.test(g) && /enableV3Signing = true/.test(g) && /isDebuggable = false/.test(g), 'v2/v3 / debuggable not set');
  assert(!/storePassword\s*=\s*"/.test(g) && !/keyPassword\s*=\s*"/.test(g), 'literal password in gradle');
  assert(g.indexOf('plugins {') < g.indexOf('PAYESH_KEYSTORE'), 'code before the plugins {} block (Kotlin DSL forbids it)');
  const tracked = spawnSync('git', ['-C', ROOT, 'ls-files', 'apps/payesh'], { encoding: 'utf8' }).stdout.split('\n');
  assert(!tracked.some(f => /\.(jks|keystore|p12|pfx)$/i.test(f)), 'a keystore is tracked under apps/payesh');
  return 'env-only signing';
});
check('W-2', 'release manifest declares INTERNET', () => {
  const m = read('apps/payesh/app/android/app/src/main/AndroidManifest.xml');
  assert(/<uses-permission android:name="android.permission.INTERNET"\s*\/>/.test(m), 'INTERNET missing in src/main');
  return 'ok';
});
const wf = read('.github/workflows/native-client.yml');
check('W-3', 'native-client.yml android: secrets → temp keystore, fail-closed control, real-APK check, tag ⇒ release only', () => {
  for (const n of ['secrets.PAYESH_KEYSTORE_B64', 'payesh-native-signing.p12', 'keytool -list', 'PAYESH_NATIVE_REQUIRE_RELEASE_SIGNING=true flutter build apk', 'SIGNING-REQUIRED-CONTROL-OK',
    'aapt2" dump badging', 'apksigner" verify --verbose --print-certs', 'jarsigner -verify -certs', 'tools/android-release-check-76.mjs', "refs/tags/native-v*", 'rm -f "$RUNNER_TEMP/payesh-native-signing.p12"', 'node tests/android-release-76.js']) {
    assert(wf.includes(n), `missing: ${n}`);
  }
  return 'ok';
});
check('W-4', 'Inno Setup script: own AppId, per-user, bundle only, refuses node/WebView2', () => {
  const iss = read('apps/payesh/app/windows/installer/payesh-native.iss');
  assert(iss.includes('{{F022A94A-885F-4620-9730-3E5EF0086EBE}'), 'AppId');
  assert(!iss.includes('7C4E2A51-9F3B-4E7A-9C21-5B8A1D3E6F02') && !/^AppId=\{\{20AE76FD/m.test(iss), 'foreign AppId used');
  assert(/PrivilegesRequired=lowest/.test(iss) && /\{localappdata\}\\Programs\\PayeshNative/.test(iss), 'not per-user');
  assert(/runner\\Release/.test(iss) && /recursesubdirs/.test(iss), 'does not package the Flutter Release bundle');
  assert(/#error WebView2Loader\.dll/.test(iss) && /#error node\.exe/.test(iss), 'no build-time refusal of node/WebView2');
  assert(!/node\.exe"; DestDir|WebView2Loader\.dll"; DestDir|client\\/i.test(iss), 'installer ships node/WebView2/web UI');
  return 'ok';
});
check('W-5', 'windows job: MSVC app-local, ISCC, silent install → gate 63 + dumpbin on installed app → uninstall, Authenticode only with Secrets', () => {
  for (const n of ['Microsoft.VC143.CRT', 'vcruntime140_1.dll', 'choco install innosetup', 'payesh-native.iss', "'/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/CURRENTUSER'",
    'node tools/native-independence-gate.mjs --windows "$dir"', 'dumpbin', 'MSVC-APP-LOCAL-OK', 'unins000.exe', 'INSTALLER-77-OK', 'secrets.PAYESH_WIN_PFX_B64', "steps.wsign.outputs.ready == 'true'", 'Get-AuthenticodeSignature', 'NotSigned', 'SHA256SUMS-installer']) {
    assert(wf.includes(n), `missing: ${n}`);
  }
  const iMsvc = wf.indexOf('App-local MSVC runtime'), iGate = wf.indexOf('Native gate on the REAL Windows bundle'), iIscc = wf.indexOf('Build payesh-native-setup.exe');
  assert(iMsvc > 0 && iMsvc < iGate && iGate < iIscc, 'step order: MSVC copy → bundle gate → installer');
  assert(/runs-on: windows-latest/.test(wf), 'not on windows-latest');
  return 'ok';
});
check('W-6', 'release-gate passes secrets to the native workflow; policy = Google Play 2026', () => {
  const rg = read('.github/workflows/release-gate.yml');
  assert(/uses: \.\/\.github\/workflows\/native-client\.yml\n(?:\s*#.*\n)*\s*secrets: inherit/.test(rg), 'native job does not inherit secrets');
  const pol = JSON.parse(read('docs/cloud/76-android-release.json'));
  assert(pol.min_target_sdk >= 36 && pol.application_id === 'ir.payesh.school.payesh_app' && pol.required_permissions.includes('android.permission.INTERNET'), JSON.stringify(pol));
  return `min_target_sdk=${pol.min_target_sdk}`;
});

console.log(`checks=${pass + fail} pass=${pass} fail=${fail}`);
console.log(fail ? 'NATIVE-RELEASE-76-77-FAILED' : `NATIVE-RELEASE-76-77-OK checks=${pass}`);
process.exit(fail ? 1 : 0);
