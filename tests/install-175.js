'use strict';
/* ═══════════════════════════════════════════════════════════
   ردیف ۱۷۵ — هشدار امنیتی هنگام نصب (ویندوز و اندروید)، بدون هزینه و بدون هویت ناشر خارجی
     A175-01 اندروید ۱۲+: به‌روزرسانی خودِ برنامه با جلسهٔ PackageInstaller و
             USER_ACTION_NOT_REQUIRED، با نگهبان SDK_INT >= S و بازگشت به نصب‌کنندهٔ سیستم.
     A175-02 دو برنامه (مدرسه و مالک) همان کد را دارند (جز نام بسته).
     A175-03 مانیفست‌ها: UPDATE_PACKAGES_WITHOUT_USER_ACTION، گیرندهٔ نتیجه exported=false،
             REQUEST_INSTALL_PACKAGES هنوز هست (اجازهٔ یک‌بارهٔ اندروید).
     A175-04 Dart: پاسخ `silent` پذیرفته و پیام «برنامه چند لحظه بسته می‌شود» نشان داده می‌شود.
     W175-01 get-payesh.ps1: فقط ASCII، هش با SHA256SUMS (بسته در خطا)، نصب بی‌صدا و بدون UAC،
             نام فایل‌ها همان فایل‌های منتشرشده، نصب‌کننده‌ها per-user.
     W175-02 README/صفحهٔ دانلود/یادداشت انتشار راه بی‌هشدار را نشان می‌دهند.
   ═══════════════════════════════════════════════════════════ */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
let pass = 0; const fails = [];
function t(id, fn) {
  try { fn(); pass++; console.log('PASS ' + id); }
  catch (e) { fails.push(id); console.log('FAIL ' + id + ': ' + (e && e.message)); }
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const KT = {
  school: 'apps/payesh/app/android/app/src/main/kotlin/ir/payesh/school/payesh_app/UpdateInstaller.kt',
  owner: 'apps/payesh/owner/android/app/src/main/kotlin/ir/payesh/owner/UpdateInstaller.kt',
};
const MF = {
  school: 'apps/payesh/app/android/app/src/main/AndroidManifest.xml',
  owner: 'apps/payesh/owner/android/app/src/main/AndroidManifest.xml',
};
const PS1 = 'install/windows/get-payesh.ps1';

t('A175-01 Android 12+ self-update session without the installer screen, with fallback', () => {
  for (const f of Object.values(KT)) {
    const s = read(f);
    assert.ok(/if \(Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.S\) \{\s*try \{\s*commitSession\(file\)\s*return "silent"/.test(s), f + ': guarded session path');
    assert.ok(s.includes('setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)'), f + ': no user action');
    assert.ok(s.includes('params.setAppPackageName(activity.packageName)'), f + ': own package only');
    assert.ok(/@TargetApi\(Build\.VERSION_CODES\.S\)\s*private fun commitSession/.test(s), f + ': API annotation');
    assert.ok(s.includes('session.abandon()'), f + ': failed session is abandoned');
    assert.ok(/activity\.startActivity\(viewIntent\(activity, file\)\)\s*return "started"/.test(s), f + ': classic fallback');
    // the receiver: confirmation if Android asks, fallback on failure, nothing on success/cancel
    assert.ok(s.includes('class InstallStatusReceiver : BroadcastReceiver()'), f + ': receiver');
    assert.ok(s.includes('PackageInstaller.STATUS_PENDING_USER_ACTION ->'), f + ': pending user action handled');
    assert.ok(s.includes('PackageInstaller.STATUS_SUCCESS, PackageInstaller.STATUS_FAILURE_ABORTED -> return'), f + ': success/cancel');
    assert.ok(/if \(!UpdateInstaller\.NAME\.matches\(name\)\) return/.test(s), f + ': fallback only for the update file name');
    // the mutable PendingIntent targets our own receiver explicitly
    assert.ok(/Intent\(activity, InstallStatusReceiver::class\.java\)\s*\.setPackage\(activity\.packageName\)/.test(s), f + ': explicit intent');
    // still the same hash-checked file from the private cache only
    assert.ok(s.includes('throw IllegalArgumentException("apk outside the update cache")'), f + ': cache check kept');
  }
});

t('A175-02 school and owner apps share the same installer code', () => {
  // only the package line and the historical row-148/165 header lines may differ
  const keep = (f) => read(f).split('\n').filter((l) => !/^package |Row 148|row 165|in-app update on Android/.test(l));
  const a = keep(KT.school);
  const b = keep(KT.owner);
  assert.deepStrictEqual(a, b);
});

t('A175-03 manifests declare the permission and a private result receiver', () => {
  for (const f of Object.values(MF)) {
    const s = read(f);
    assert.ok(s.includes('<uses-permission android:name="android.permission.UPDATE_PACKAGES_WITHOUT_USER_ACTION"/>'), f);
    assert.ok(s.includes('<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES"/>'), f);
    assert.ok(/<receiver\s+android:name="\.InstallStatusReceiver"\s+android:exported="false"\/>/.test(s), f + ': receiver not exported');
  }
  // Android 16 requires target SDK >= 34 for installs without user action: both apps follow Flutter's default (36)
  assert.ok(read('apps/payesh/app/android/app/build.gradle.kts').includes('targetSdk = flutter.targetSdkVersion'));
  assert.ok(read('apps/payesh/owner/android/app/build.gradle.kts').includes('targetSdk = flutter.targetSdkVersion'));
});

t('A175-04 Dart accepts `silent` and tells the user the app closes for the update', () => {
  const u = read('apps/payesh/packages/payesh_update/lib/src/updater.dart');
  assert.ok(/r == 'silent'\) \{\s*silentInstall = true;/.test(u));
  assert.ok(/else if \(r != 'started'\) \{\s*throw UpdateException\('install', r\);/.test(u), 'unknown answers still fail');
  const l = read('apps/payesh/packages/payesh_update/lib/src/update_light.dart');
  assert.strictEqual((l.match(/برنامه چند لحظه بسته می‌شود؛ سپس دوباره بازش کنید/g) || []).length, 2);
  assert.ok(read('apps/payesh/owner/lib/src/update/update_card.dart').includes('برنامه چند لحظه بسته می‌شود؛ سپس دوباره بازش کنید.'));
});

t('W175-01 get-payesh.ps1: ASCII, SHA256SUMS fail-closed, silent per-user install of the published files', () => {
  const raw = fs.readFileSync(path.join(ROOT, PS1));
  assert.ok(raw.every((b) => b === 10 || b === 13 || (b >= 32 && b < 127)), 'ASCII only (irm | iex + Windows PowerShell 5.1)');
  const s = raw.toString('utf8');
  assert.ok(s.includes("$ErrorActionPreference = 'Stop'"));
  assert.ok(s.includes('Get-File $spec.Sums $sums') && s.includes('Get-File $spec.Url $setup'));
  assert.ok(/if \(-not \$want -or \$want -notmatch '\^\[0-9a-f\]\{64\}\$'\) \{ throw/.test(s), 'not listed ⇒ throw');
  assert.ok(/if \(\$got -ne \$want\) \{ throw/.test(s), 'mismatch ⇒ throw');
  assert.ok(s.indexOf('if ($got -ne $want)') < s.indexOf('Start-Process -FilePath $setup'), 'hash checked before running');
  assert.ok(s.includes("'/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'"));
  assert.ok(!/RunAs|-Verb/.test(s), 'never elevates');
  const pairs = [['native-continuous', 'payesh-native-setup.exe', '.github/workflows/school-native-publish.yml', 'apps/payesh/app/windows/installer/payesh-native.iss', 'PayeshNative', 'payesh_app.exe'],
    ['owner-continuous', 'payesh-owner-setup.exe', '.github/workflows/owner-native-publish.yml', 'apps/payesh/owner/windows/installer/payesh-owner-native.iss', 'PayeshOwner', 'payesh_owner.exe']];
  for (const [tag, file, wf, iss, dir, exe] of pairs) {
    const url = `https://github.com/rezaa2544/payesh.local/releases/download/${tag}/`;
    assert.ok(s.includes(`File = '${file}'; Dir = '${dir}'; Exe = '${exe}'`), file + ' mapping');
    assert.ok(s.includes(`Url = '${url}${file}'`) && s.includes(`Sums = '${url}SHA256SUMS'`), file + ' direct links');
    assert.ok(read(wf).includes(file), wf + ' publishes ' + file);
    const i = read(iss);
    assert.ok(/^PrivilegesRequired=lowest$/m.test(i), iss + ': per-user, no UAC');
    assert.ok(i.includes('DefaultDirName={localappdata}\\Programs\\' + dir), iss + ': install folder');
  }
});

t('W175-02 README, download page and release notes show the warning-free install', () => {
  const cmd = 'irm https://raw.githubusercontent.com/rezaa2544/payesh.local/main/install/windows/get-payesh.ps1 | iex';
  assert.ok(read('README.md').includes(cmd));
  assert.ok(read('tools/release/downloads.mjs').includes(cmd));
  assert.ok(read('site/index.html').includes(cmd));
  assert.ok(read('.github/workflows/school-native-publish.yml').includes(cmd));
  assert.ok(read('.github/workflows/owner-native-publish.yml').includes('get-payesh.ps1))) -App owner'));
});

console.log(`INSTALL-175 ${fails.length ? 'FAIL' : 'OK'} pass=${pass} fail=${fails.length}`);
process.exit(fails.length ? 1 : 0);
