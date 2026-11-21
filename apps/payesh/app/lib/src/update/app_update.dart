// ردیف ۱۴۸: به‌روزرسانی برنامهٔ مدرسه — همان هستهٔ پنل مالک (payesh_update):
//   • ویندوز: فقط فایل‌های تغییرکرده از native-continuous/app-update.json + app-files، اعمال
//     پس از بسته شدن، بررسی هش، بازگشت خودکار اگر نسخهٔ تازه بالا نیاید، و باز شدن دوباره؛
//   • اندروید (ردیف ۱۶۵، تصمیم مالک — توزیع مستقیم، نه Google Play): بستهٔ کامل
//     payesh-native.apk درون برنامه دانلود و با هش بررسی می‌شود و نصب‌کنندهٔ سیستم مستقیم باز
//     می‌شود (مثل پنل مالک)؛ پس از نصب، گیرندهٔ MY_PACKAGE_REPLACED بازش می‌کند.

import 'package:payesh_core/io.dart' show isWeb32;
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
  // Row 169 (D-50): the 32-bit Windows edition updates from its own channel (its files are
  // the CEF shell + the web build), never from the 64-bit app's manifest.
  manifest: isWeb32
      ? 'https://github.com/$appRepo/releases/download/win32-continuous/app32-update.json'
      : 'https://github.com/$appRepo/releases/download/native-continuous/app-update.json',
  blobs: isWeb32
      ? 'https://github.com/$appRepo/releases/download/app32-files/'
      : 'https://github.com/$appRepo/releases/download/app-files/',
  apk:
      'https://github.com/$appRepo/releases/download/native-continuous/payesh-native.apk',
  exeName: 'payesh_app.exe',
  stagingFolder: isWeb32 ? 'PayeshNative32' : 'PayeshNative',
  versionBase: appVersionBase,
  build: appBuild,
);
