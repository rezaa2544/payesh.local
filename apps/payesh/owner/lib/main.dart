import 'package:flutter/material.dart';
import 'package:payesh_owner_api/payesh_owner_api.dart';

import 'src/app.dart';
import 'src/platform.dart';

/// پنل مالک بومی (ردیف ۱۲۶): رابط Flutter، بدون WebView و Node.js.
/// اول ورود محلی بدون اینترنت، بعد تنظیم دیتابیس (S3 آروان)؛ سرور پلتفرم اختیاری است.
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(
    OwnerApp(
      store: platformSettingsStore(),
      httpFactory: IoOwnerHttp.new,
      secure: platformSecureStore(),
    ),
  );
}
