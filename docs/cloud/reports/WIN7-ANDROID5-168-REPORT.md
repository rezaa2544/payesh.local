# ردیف ۱۶۸ — نصب و اجرای همهٔ برنامه‌ها روی ویندوز ۷ تا ۱۱ و اندروید ۵٫۰ به بالا (v0.9.22)

**درخواست مالک (۲۰۲۶‑۱۱‑۱۷):** «برنامه ها روی ویندوز 7 نصب نمیشن. باید کاری کرد که برنامه ها روی همه ورژن های ویندوز و همچنین روی همه ورژن های اندروید بدون محدودیت و با سلامت کامل کار کنن و نصب بشن.»

**دامنهٔ تأییدشده (پاسخ مالک):**
- ویندوز ۷ هم ۳۲ بیتی و هم ۶۴ بیتی.
- هر سه برنامه: سرور دیتابیس مدرسه (سرویس داده)، برنامهٔ مدرسه و پنل مالک.
- کف اندروید ۵٫۰ (API 21). اندروید ۴ ممکن نیست و مالک پذیرفت.

## علت ریشه‌ای
**ویندوز:**
- نصب‌کننده‌ها `MinVersion=10.0` داشتند، پس روی ۷ و ۸ اصلاً نصب نمی‌شدند.
- برداشتن این قید کافی نبود. Flutter ۳٫۲۰ به بعد ویندوز ۷/۸ را رها کرده است و این وارداتِ Win8+ را دارد:
  - `flutter_windows.dll`: `GetHostNameW`، `PathAllocCanonicalize` و `PathCch*`، `RtlAdd/DeleteGrowableFunctionTable`، `GetCurrentThreadStackLimits`، `WaitOnAddress` و `WakeByAddressSingle`.
  - `msvcp140.dll`: `GetSystemTimePreciseAsFileTime`، `CopyFile2` و `CreateFile2`.
  - Node 22 (سرویس داده): `EventSetInformation` و `GetSystemTimePreciseAsFileTime`.
- ویندوز ۷ بدون KB2999226، UCRT ندارد.
- مخزن گواهی ویندوز ۷ کهنه است و اتصال TLS به GitHub و S3 و Let's Encrypt شکست می‌خورد.
- اسکریپت‌های نصب و به‌روزرسانی از PowerShell 5 و `Register-ScheduledTask` (Win8+) استفاده می‌کردند، ولی ویندوز ۷ فقط PowerShell 2.0 دارد.

**اندروید:**
- minSdk برنامه‌ها ۲۳ و ۲۴ بود.
- embedding استاندارد Flutter روی API 21–23 از کار می‌افتد.
- `libflutter.so` ۶۴ بیتی فقط GNU hash دارد، و linker اندروید ۵ بدون SysV `DT_HASH` آن را بار نمی‌کند (`empty/missing DT_HASH`).
- `.so` آمادهٔ sqlite3 روی API 21/22 بار نمی‌شود.
- AES در Keystore از API 23 است.
- نصب به‌روزرسانی زیر API 24 به `file://` نیاز دارد.
- اندروید پیش از ۷٫۱ گواهی ISRG Root X1 ندارد.
- اندروید پیش از ۷ فقط امضای v1 را بررسی می‌کند.

## راه‌حل
### ویندوز ۷ SP1، ۸ و ۸٫۱ (همه با همان نصب‌کننده)
- **`tools/win7/pw7shim.c` ← `pw7.dll`:** هر تابع Win8+ اول تابع اصلی سیستم را می‌جوید (پس روی ۸ تا ۱۱ رفتار تغییری نمی‌کند). روی ۷ جایگزین سازگار را اجرا می‌کند.
  - selftest: x64 ۱۶۴/۱۶۴ و x86 ۱۶۲/۱۶۲. با `PAYESH_W7SHIM_FORCE=1` جایگزین‌ها روی ویندوز ۱۰ هم آزموده شدند.
- **`tools/win7/w7patch.mjs`:**
  - وارداتِ فهرست `win8plus-apis.json` را به `pw7.dll` می‌برد.
  - نسخهٔ OS/subsystem را به ۶٫۰ برمی‌گرداند و checksum را دوباره می‌سازد.
  - `--scan` تضمین می‌کند هیچ واردات Win8+ نمانده باشد. `--verify` (`PW7-VERIFY-OK`) تطابق صادرات shim را بررسی می‌کند.
- **`tools/win7/w7-package.ps1` (`W7-PACKAGE-OK`):** UCRT را app-local کنار exe می‌گذارد و smoke اجرای exe و node را انجام می‌دهد.
- **TLS:** ۱۱۸ ریشهٔ Mozilla همراه برنامه است (`legacy_windows_trust` و `mozilla_roots` در payesh_secure) و در `le_trust`، `s3_client` و هر دو `main.dart` به‌کار می‌رود.
- **سرویس داده:**
  - نسخهٔ x64 و **x86**، هر دو با Node وصله‌شده.
  - `NODE_SKIP_PLATFORM_CHECK` را `pw7.dll` تنظیم می‌کند.
  - کار زمان‌بندی‌شده با COM `RegisterTask` ثبت می‌شود و کشتن node با `Get-WmiObject` است.
- **به‌روزرسانی درون برنامه (`delta.dart`):** اسکریپت جایگزینی با PowerShell 2.0 سازگار است (بدون `[ordered]` و `ConvertTo-Json`). آزمون واقعی روی PS 2.0 و PS 5.1 با مسیر فارسی: ok، rollback و alive همه سبز (۲۲/۲۲).
- **نصب‌کننده‌ها:** هر سه نصب‌کنندهٔ جاری `MinVersion=6.1sp1` دارند (Inno 6.5+).
- **محدودیت:** برنامهٔ مدرسه و پنل مالک **فقط ۶۴ بیتی**‌اند. Dart/Flutter خروجی ۳۲ بیتی ویندوز ندارد (Dart #45222 و #59698). روی ویندوز ۳۲ بیتی فقط سرور دیتابیس اجرا می‌شود و برنامه‌ها از گوشی یا رایانهٔ ۶۴ بیتی به آن وصل می‌شوند.

### اندروید ۵٫۰ (API 21) به بالا
- **`tools/android21/build-repo.py`:** مخزن Maven محلی embedding و engine را با این تغییرها می‌سازد:
  - embedding وصله‌شده برای API 21.
  - `libflutter.so` (arm64 و x86_64) strip‌شده، با جدول **SysV DT_HASH** در یک PT_LOAD تازه. با llvm-readelf تأیید شد و strip دوم هم آن را نگه می‌دارد.
  - `libjnigraphics` ← `libpayeshw21.so` (`pw21shim.c`).
- **`apps/payesh/android21.gradle`:** minSdk 21 و امضای v1+v2+v3.
- **SQLite3MC 2.6.1:** از منبع ساخته می‌شود (`apps/payesh/third_party/sqlite3mc-2.6.1`، sha256 ثبت‌شده).
- **Kotlin:**
  - `KeystoreSecureStore`: روی API کمتر از ۲۳ از کلید RSA پوشاننده استفاده می‌کند.
  - `UpdateInstaller`: روی API کمتر از ۲۴ از `file://` استفاده می‌کند.
- **TLS:** ریشه‌های Mozilla روی اندروید کمتر از ۷٫۱ بار می‌شوند.
- **دروازه‌های CI:**
  - `check-so-api.py --api 21`: هیچ نماد بیرون از bionic API 21 نباشد و `DT_HASH` باشد.
  - `AR-03`: minSdk ≥ 21.
  - `AR-05`: v2/v3، و v1 وقتی minSdk < 24.
  - **اجرای واقعی روی شبیه‌ساز** API 21 (اندروید 5.0.2) و API 23.

## آزمون‌ها و شواهد
- **native-client روی `073e496` (run 44152496169) — همهٔ jobها سبز:**
  - Windows release + نصب‌کننده با بسته‌بندی Win7.
  - پنل مالک Windows.
  - Android APK/AAB هر دو برنامه با دروازه‌های API 21.
  - **«Android 5.0 (API 21) emulator — school app + owner app start»**.
  - «Android 6.0 (API 23) emulator».
  - native-gate.
- **شبیه‌ساز API 21 (run 44146263442):** `ANDROID-EMULATOR-SMOKE-OK api=21 abi=x86_64`.
  - برنامهٔ مدرسه صفحهٔ «ورود به پایش» را رسم کرد (pid 2622، ۲۲۳۷ رنگ).
  - پنل مالک «تعریف حساب مالک» را رسم کرد (pid 2768، ۷۱۶ رنگ).
  - هر دو زنده ماندند و focus مال خودشان بود.
- **build-and-release روی `073e496`:** سبز. شامل `tests/run.js` ۱۴۹/۱۴۹، repo-map، release-gate، landing و installables.
- **انتشار:** school-native-publish و owner-native-publish سبز. انتشارهای `native-continuous`، `owner-continuous` و `school-server-continuous` به 0.9.22 به‌روز شدند (`caa0226`).
- **آزمون‌های واحد:** اپ ۲۲۵، پنل مالک ۲۸۱، payesh_sync ۲۸۷، payesh_secure ۵۲، payesh_update ۲۲، android-release-76 ۲۸ و lan-mode-127.
- **رایانهٔ ویندوز ۱۰ مالک** (با `PAYESH_W7SHIM_FORCE=1` که مسیر جایگزینِ ویندوز ۷ را اجبار می‌کند): برنامهٔ مدرسه و پنل مالک پنجرهٔ Flutter را زنده نشان دادند. سرویس داده با node وصله‌شده: `/api/health` ۲۰۰.

## انتشار
- **main:**
  - ویندوز: `a0b3e74` و `fced29d`.
  - اندروید: `446aea6`، `95b9599`، `f771450` و `8764472` (DT_HASH).
  - نقشهٔ مخزن: `a663067`.
  - نسخهٔ 0.9.22: `b62658c`، مانیفست `2d6505e`، evidence `073e496` و مانیفست انتشار `caa0226`.
- بدون PR، به دستور مأموریت.
- **رایانهٔ مدرسه (۲۰۲۶‑۱۱‑۱۷):** هر سه نصب‌کننده از انتشارهای GitHub دانلود شدند و هش SHA256 هر سه با `SHA256SUMS` خواند. نصب بی‌صدا هر سه با exit 0 تمام شد.
  - **سرویس داده 0.9.22:** `/api/health` می‌گوید `version=0.9.22 ok=True`. کار زمان‌بندی‌شده `Running` است. node 22.14.0 با `pw7.dll` کنارش.
  - **اپ مدرسه 0.2.182 و پنل مالک 1.1.182:** هر دو `pw7.dll`، `ucrtbase.dll` و ۴۵ `api-ms-win-*.dll` دارند.
  - با `PAYESH_W7SHIM_FORCE=1` (مسیر ویندوز ۷) روی میز کار پنهان هر دو `PW7RUN-ALIVE` با پنجرهٔ `FLUTTER_RUNNER_WIN32_WINDOW` دادند.

## محدودیت‌های باقی‌مانده (غیرممکن یا بیرون از کنترل)
- **ویندوز ۳۲ بیتی:** فقط سرور دیتابیس. Flutter ۳۲ بیتی ویندوز وجود ندارد.
- **ویندوز ۷ بدون SP1 و ویندوز XP/Vista:** پشتیبانی نمی‌شوند (Inno Setup و runtime).
- **اندروید ۴٫x:** ممکن نیست (کف موتور Flutter API 21 است).
- **روی ویندوز ۷:**
  - Cloudflare quick tunnel و Tailscale Funnel اجرا نمی‌شوند. LAN و سرور مرکزی مالک کار می‌کنند.
  - هشدار تلگرام **از پشت پراکسی** (نیازمند `curl.exe`) در دسترس نیست. بدون پراکسی کار می‌کند.
