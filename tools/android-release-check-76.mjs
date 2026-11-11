#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   Android release check — row 76 (native APK/AAB in CI)

   Reads the RAW output of the Android SDK tools run on the real build
   output (CI: native-client.yml job `android`) and decides whether the
   artefact is a distributable release or only a rehearsal:

     AR-01  package name = policy.application_id
     AR-02  targetSdkVersion >= policy.min_target_sdk (Google Play: 36 since 2026-08-31)
     AR-03  minSdkVersion >= policy.min_sdk
     AR-04  not debuggable (no `application-debuggable` in aapt2 badging)
     AR-05  apksigner: "Verifies" and the v2 or v3 scheme verified (v1-only is refused)
     AR-06  exactly one signer
     AR-07  permissions ⊆ policy.allowed_permissions (+ the AndroidX per-app
            DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION)
     AR-08  release mode: signer is NOT the Android debug certificate, and equals
            --expect-cert-sha256 when given (owner-pinned fingerprint)
     AR-09  AAB (jarsigner -verify -certs): "jar verified." and, in release
            mode, not the Android debug certificate

   Modes:
     --mode release    the owner key must have signed it (AR-08) — exit 0 only then
     --mode rehearsal  debug signing allowed; the verdict says NOT FOR DISTRIBUTION

   Usage:
     node tools/android-release-check-76.mjs --badging aapt2-badging.txt --certs apksigner.txt
        [--aab-jarsigner jarsigner.txt] [--policy docs/cloud/76-android-release.json]
        [--mode release|rehearsal] [--expect-cert-sha256 HEX]
   Last line: ANDROID-RELEASE-76-OK mode=… | ANDROID-RELEASE-76-FAIL violations=N
   ═══════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_POLICY_FILE = path.join(HERE, '..', 'docs', 'cloud', '76-android-release.json');
const DEBUG_DN = /CN=Android Debug\b/i;

export function parseBadging(text) {
  const t = String(text || '');
  const pkg = /^package: name='([^']+)'(?:.*?versionCode='([^']*)')?(?:.*?versionName='([^']*)')?/m.exec(t);
  const num = re => { const m = re.exec(t); return m ? Number(m[1]) : null; };
  const perms = [...t.matchAll(/^uses-permission: name='([^']+)'/gm)].map(m => m[1]);
  return {
    package: pkg ? pkg[1] : null, versionCode: pkg ? pkg[2] || null : null, versionName: pkg ? pkg[3] || null : null,
    minSdk: num(/^(?:minSdkVersion|sdkVersion):'(\d+)'/m), targetSdk: num(/^targetSdkVersion:'(\d+)'/m),
    debuggable: /^application-debuggable\b/m.test(t), permissions: [...new Set(perms)].sort(),
  };
}

export function parseApksigner(text) {
  const t = String(text || '');
  const scheme = v => { const m = new RegExp(`^Verified using ${v} scheme[^:]*:\\s*(true|false)`, 'm').exec(t); return m ? m[1] === 'true' : false; };
  const signers = [...t.matchAll(/^Signer #(\d+) certificate DN:\s*(.+)$/gm)].map(m => ({ n: Number(m[1]), dn: m[2].trim() }));
  for (const s of signers) {
    const m = new RegExp(`^Signer #${s.n} certificate SHA-256 digest:\\s*([0-9a-fA-F:]+)`, 'm').exec(t);
    s.sha256 = m ? m[1].replace(/:/g, '').toLowerCase() : null;
  }
  const count = /^Number of signers:\s*(\d+)/m.exec(t);
  return {
    verifies: /^Verifies\s*$/m.test(t) && !/^DOES NOT VERIFY/m.test(t),
    v1: scheme('v1'), v2: scheme('v2'), v3: scheme('v3'),
    signerCount: count ? Number(count[1]) : signers.length, signers,
  };
}

export function parseJarsigner(text) {
  const t = String(text || '');
  return {
    verified: /^jar verified\.\s*$/m.test(t) && !/jar is unsigned/i.test(t),
    debug: DEBUG_DN.test(t),
  };
}

export function check({ badging, certs, aab = null, policy, mode = 'rehearsal', expectCert = null }) {
  const v = [];
  const bad = (id, msg) => v.push(`${id} ${msg}`);
  const b = parseBadging(badging);
  const c = parseApksigner(certs);
  if (!['release', 'rehearsal'].includes(mode)) bad('AR-00', `unknown mode ${mode}`);
  if (!b.package) bad('AR-01', 'aapt2 badging has no package line (wrong input?)');
  else if (b.package !== policy.application_id) bad('AR-01', `package ${b.package} != ${policy.application_id}`);
  if (b.targetSdk === null) bad('AR-02', 'no targetSdkVersion in badging');
  else if (b.targetSdk < policy.min_target_sdk) bad('AR-02', `targetSdkVersion ${b.targetSdk} < ${policy.min_target_sdk} (Google Play requirement)`);
  if (b.minSdk === null) bad('AR-03', 'no minSdkVersion in badging');
  else if (b.minSdk < policy.min_sdk) bad('AR-03', `minSdkVersion ${b.minSdk} < ${policy.min_sdk}`);
  if (b.debuggable) bad('AR-04', 'APK is debuggable');
  if (!c.verifies) bad('AR-05', 'apksigner did not print "Verifies"');
  if (!(c.v2 || c.v3)) bad('AR-05', `no v2/v3 signature verified (v1=${c.v1} v2=${c.v2} v3=${c.v3})`);
  if (c.signerCount !== 1 || c.signers.length !== 1) bad('AR-06', `expected exactly one signer, got ${c.signerCount}/${c.signers.length}`);
  const allowed = new Set(policy.allowed_permissions || []);
  const dyn = `${policy.application_id}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`;
  const extra = b.permissions.filter(p => !allowed.has(p) && p !== dyn);
  if (extra.length) bad('AR-07', `permissions outside the allowlist: ${extra.join(', ')}`);
  for (const req of policy.required_permissions || []) if (!b.permissions.includes(req)) bad('AR-07', `required permission missing: ${req}`);
  const signer = c.signers[0] || { dn: '', sha256: null };
  const debugSigned = DEBUG_DN.test(signer.dn);
  if (mode === 'release') {
    if (debugSigned) bad('AR-08', `release mode but signed with the Android debug certificate (${signer.dn})`);
    if (expectCert && signer.sha256 !== String(expectCert).replace(/:/g, '').toLowerCase()) bad('AR-08', `signer SHA-256 ${signer.sha256} != pinned ${expectCert}`);
  }
  let j = null;
  if (aab !== null) {
    j = parseJarsigner(aab);
    if (!j.verified) bad('AR-09', 'AAB: jarsigner did not print "jar verified."');
    if (mode === 'release' && j.debug) bad('AR-09', 'AAB signed with the Android debug certificate');
  }
  return {
    ok: v.length === 0, mode, violations: v,
    facts: { package: b.package, versionName: b.versionName, versionCode: b.versionCode, minSdk: b.minSdk, targetSdk: b.targetSdk, debuggable: b.debuggable, permissions: b.permissions, schemes: { v1: c.v1, v2: c.v2, v3: c.v3 }, signer_dn: signer.dn, signer_sha256: signer.sha256, debug_signed: debugSigned, aab_verified: j ? j.verified : null },
    distributable: v.length === 0 && mode === 'release' && !debugSigned,
  };
}

export function main(argv) {
  const a = { mode: 'rehearsal', policy: DEFAULT_POLICY_FILE, badging: null, certs: null, aab: null, expect: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--badging') a.badging = argv[++i];
    else if (k === '--certs') a.certs = argv[++i];
    else if (k === '--aab-jarsigner') a.aab = argv[++i];
    else if (k === '--policy') a.policy = argv[++i];
    else if (k === '--mode') a.mode = argv[++i];
    else if (k === '--expect-cert-sha256') a.expect = argv[++i] || null;
    else { console.log(`ANDROID-RELEASE-76-FAIL unknown argument ${k}`); return 2; }
  }
  if (!a.badging || !a.certs) { console.log('ANDROID-RELEASE-76-FAIL --badging and --certs are required'); return 2; }
  let policy, badging, certs, aab = null;
  try {
    policy = JSON.parse(fs.readFileSync(a.policy, 'utf8'));
    badging = fs.readFileSync(a.badging, 'utf8');
    certs = fs.readFileSync(a.certs, 'utf8');
    if (a.aab) aab = fs.readFileSync(a.aab, 'utf8');
  } catch (e) { console.log(`ANDROID-RELEASE-76-FAIL cannot read input: ${e.message}`); return 2; }
  const r = check({ badging, certs, aab, policy, mode: a.mode, expectCert: a.expect });
  const f = r.facts;
  console.log(`package=${f.package} version=${f.versionName}+${f.versionCode} minSdk=${f.minSdk} targetSdk=${f.targetSdk} (policy >= ${policy.min_target_sdk}) debuggable=${f.debuggable}`);
  console.log(`permissions=${f.permissions.join(',') || '-'}`);
  console.log(`signature v1=${f.schemes.v1} v2=${f.schemes.v2} v3=${f.schemes.v3} signer="${f.signer_dn}" sha256=${f.signer_sha256} debug_signed=${f.debug_signed}${f.aab_verified === null ? '' : ' aab_verified=' + f.aab_verified}`);
  for (const x of r.violations) console.log('FAIL  ' + x);
  if (!r.ok) { console.log(`ANDROID-RELEASE-76-FAIL violations=${r.violations.length} mode=${r.mode}`); return 1; }
  console.log(r.distributable
    ? `ANDROID-RELEASE-76-OK mode=release distributable=true signer_sha256=${f.signer_sha256}`
    : `ANDROID-RELEASE-76-OK mode=rehearsal distributable=false — debug-signed rehearsal, NOT FOR DISTRIBUTION (owner key: row 61)`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
