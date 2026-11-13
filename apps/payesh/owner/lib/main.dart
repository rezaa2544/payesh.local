import 'package:flutter/material.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';

import 'src/app.dart';
import 'src/helper/helper_service.dart';
import 'src/platform.dart';
import 'src/update/update_service.dart';

/// پنل مالک بومی (ردیف ۱۲۶): رابط Flutter، بدون WebView و Node.js.
/// اول ورود محلی بدون اینترنت، بعد تنظیم دیتابیس (S3 آروان)؛ سرور پلتفرم اختیاری است.
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final secure = platformSecureStore();
  runApp(
    OwnerApp(
      store: platformSettingsStore(),
      httpFactory: IoOwnerHttp.new,
      secure: secure,
      // سرور کمکی: پیش‌فرض روشن (قابل توقف موقت در «تنظیمات»)
      helper: OwnerHelperService(secure: secure),
      updater: OwnerUpdater(secure: secure),
      openUrl: platformOpenUrl,
    ),
  );
}
