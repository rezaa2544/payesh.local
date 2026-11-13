// به‌روزرسانی درجای پنل مالک — هستهٔ مشترک در payesh_update (ردیف ۱۴۸؛ همان کد برنامهٔ
// مدرسه). اینجا فقط مشخصات انتشار پنل مالک است:
//   • مانیفست: owner-continuous/owner-update.json (فقط از GitHub، TLS)؛
//   • فایل‌ها: owner-files/<sha>.gz — اول از آینهٔ صندوقچهٔ آروان (payesh/updates/owner/)؛
//   • اندروید: owner-continuous/payesh-owner.apk (درون برنامه دانلود و نصب می‌شود).

import 'package:payesh_update/core.dart';

// فقط هستهٔ Dart خالص: tool/update_e2e.dart با `dart run` (بدون Flutter) همین را وارد می‌کند.
export 'package:payesh_update/core.dart';

const String ownerUpdateSchema = 'payesh-owner-update/1';
const String ownerRepo = 'rezaa2544/payesh.local';
const String mirrorPrefix = 'payesh/updates/owner/';
const String ownerExe = 'payesh_owner.exe';

/// شمارهٔ ساخت همین برنامه (CI: `--dart-define=PAYESH_OWNER_BUILD=<run_number>`).
const int ownerBuild = int.fromEnvironment('PAYESH_OWNER_BUILD');

/// دو بخش اول نسخه (همان `version:` در pubspec.yaml). بخش سوم = شمارهٔ ساخت CI، پس با هر
/// تغییرِ منتشرشده نسخه هم عوض می‌شود و به‌روزرسانی آن را می‌بیند (CI: `--build-name`).
const String ownerVersionBase = '1.1';

const UpdateChannel ownerChannel = UpdateChannel(
  id: 'owner',
  schema: ownerUpdateSchema,
  manifest:
      'https://github.com/$ownerRepo/releases/download/owner-continuous/owner-update.json',
  blobs: 'https://github.com/$ownerRepo/releases/download/owner-files/',
  apk:
      'https://github.com/$ownerRepo/releases/download/owner-continuous/payesh-owner.apk',
  exeName: ownerExe,
  stagingFolder: 'PayeshOwner',
  versionBase: ownerVersionBase,
  build: ownerBuild,
);

final Uri defaultManifestUrl = ownerChannel.manifestUrl;
final Uri defaultBlobBase = ownerChannel.blobBase;

/// اندروید: بستهٔ کامل آخرین نسخه (همان انتشار owner-continuous).
final Uri defaultApkUrl = ownerChannel.apkUrl;

/// نسخهٔ نمایشی یک ساخت: `1.1.<build>`.
String versionOf(int build) => ownerChannel.versionOf(build);

/// نسخهٔ همین برنامه (نوار بالا).
final String ownerVersion = ownerChannel.version;

typedef OwnerUpdateManifest = UpdateManifest;
