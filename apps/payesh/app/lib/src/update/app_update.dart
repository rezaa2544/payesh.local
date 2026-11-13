// ردیف ۱۴۸: به‌روزرسانی برنامهٔ مدرسه — همان هستهٔ پنل مالک (payesh_update):
//   • ویندوز: فقط فایل‌های تغییرکرده از native-continuous/app-update.json + app-files، اعمال
//     پس از بسته شدن، بررسی هش، بازگشت خودکار اگر نسخهٔ تازه بالا نیاید، و باز شدن دوباره؛
//   • اندروید: بستهٔ کامل payesh-native.apk با مرورگر سیستم (برنامهٔ مدرسه خودش بسته نصب
//     نمی‌کند — سیاست Google Play)؛ پس از نصب، گیرندهٔ MY_PACKAGE_REPLACED بازش می‌کند.

import 'package:payesh_update/payesh_update.dart';

const String appUpdateSchema = 'payesh-app-update/1';
const String appRepo = 'rezaa2544/payesh.local';

/// شمارهٔ ساخت (CI: `--dart-define=PAYESH_APP_BUILD=<run_number>`)؛ ۰ ⇒ ساخت محلی بدون به‌روزرسانی.
const int appBuild = int.fromEnvironment('PAYESH_APP_BUILD');

/// دو بخش اول نسخه (همان `version:` در pubspec.yaml).
const String appVersionBase = '0.2';

const UpdateChannel appChannel = UpdateChannel(
  id: 'app',
  schema: appUpdateSchema,
  manifest:
      'https://github.com/$appRepo/releases/download/native-continuous/app-update.json',
  blobs: 'https://github.com/$appRepo/releases/download/app-files/',
  apk:
      'https://github.com/$appRepo/releases/download/native-continuous/payesh-native.apk',
  exeName: 'payesh_app.exe',
  stagingFolder: 'PayeshNative',
  versionBase: appVersionBase,
  build: appBuild,
);
