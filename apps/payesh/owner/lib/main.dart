import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';

import 'src/app.dart';
import 'src/helper/helper_service.dart';
import 'src/platform.dart';
import 'src/update/update_service.dart';

/// پنل مالک بومی (ردیف ۱۲۶): رابط Flutter، بدون WebView و Node.js.
/// اول ورود محلی بدون اینترنت، بعد تنظیم دیتابیس (S3 آروان)؛ سرور پلتفرم اختیاری است.
void main(List<String> args) {
  WidgetsFlutterBinding.ensureInitialized();
  final secure = platformSecureStore();
  // ردیف ۱۴۸: --update-from <dir> / --update-now (پشتیبانی و آزمون سرتاسری CI)
  final ua = UpdateArgs.parse(args);
  final updater = OwnerUpdater(
    secure: secure,
    manifestUrl: ua.manifest('owner-update.json'),
    blobBase: ua.blobs('owner-files'),
    // اندروید: APK درون برنامه دانلود و با نصب‌کنندهٔ سیستم نصب می‌شود
    apkInstaller: Platform.isAndroid ? const ChannelApkInstaller() : null,
    openUrl: platformOpenUrl,
  );
  runApp(
    OwnerApp(
      store: platformSettingsStore(),
      httpFactory: IoOwnerHttp.new,
      secure: secure,
      // سرور کمکی: پیش‌فرض روشن (قابل توقف موقت در «تنظیمات»)
      helper: OwnerHelperService(secure: secure),
      updater: updater,
      openUrl: platformOpenUrl,
      // ردیف ۱۵۵: پشتیبان کامل دیتابیس روی دیسک همین سیستم
      backupDir: () async {
        try {
          return Directory('${await platformDataDir()}/owner-backup');
        } on Object {
          return null;
        }
      },
    ),
  );
  if (ua.now) {
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => unawaited(runUpdateNow(updater)),
    );
  }
}
