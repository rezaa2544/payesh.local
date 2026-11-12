# گزارش صف — ردیف ۱۲۵: فهرست همهٔ برنامه‌های نصبی + قانون «فقط بومی» + Gate ثبت‌نام در CI

| | |
|---|---|
| تاریخ | ۱۴۰۵/۰۸/۲۲ · 2026‑11‑12 |
| شاخه | فقط `main` (به دستور مأموریت) |
| commit | `f33a12f` رجیستری + بررسی + workflow + گزارش |
| برچسب‌ها | [S] = در محیط آزمایشی ARENA یا CI · [M] = روی هاست یا دستگاه واقعی |
| فهرست همهٔ گزارش‌ها | [`QUEUE-LOG.md`](QUEUE-LOG.md) |
| سند تصمیم | D‑49 + [`../126-adr-native-owner-panel.md`](../126-adr-native-owner-panel.md) (ADR‑126، §۷)؛ ADR‑62 لغو شد |
| رجیستری | [`../125-installables.json`](../125-installables.json) |
| بررسی | `tools/installables-125.mjs` · `tests/installables-125.js` · `.github/workflows/installables.yml` · `tests/run.js` |
| ردیف قبلی | [`QUEUE-126-REPORT.md`](QUEUE-126-REPORT.md) (۱۲۶ زودتر بسته شد) |

## ۱. خلاصه

- همهٔ برنامه‌های نصبی مخزن فهرست و در یک رجیستری ماشین‌خوان ثبت شدند. این شامل پروژه‌های Android، نصب‌کننده‌ها، پوسته‌های دسکتاپ، اسکریپت‌ها و فایل‌های اجرایی ثبت‌شده است: **۱۲ ورودی** و **۲۴ نقطهٔ ورود** کشف‌شده.
- قانون «فقط بومی» از قبل در D‑49 / ADR‑126 تصویب شده است و استثنای WebView پنل مالک را لغو کرده است. این ردیف آن را **قابل اجرا در CI** کرد.
- **وضع امروز، صادقانه:** پنل مالک و اپ بومی مدرسه بومی‌اند. اما **دو برنامهٔ مدرسه که هنوز روی کانال `continuous` منتشر می‌شوند WebView هستند:** `payesh-setup.exe` / `payesh-local-windows.zip` و `payesh-local.apk`.
  - این دو در رجیستری «WebView، در انتظار حذف در ردیف ۱۲۹» ثبت شده‌اند.
  - CI اجازه نمی‌دهد «بومی» نامیده شوند یا به کانال بومی بروند.

## ۲. فهرست برنامه‌های نصبی

| برنامه (id رجیستری) | سکو | مخاطب | رابط | HTML/JS | موتور مرورگر در اجرا | Node برای UI | بدون مرورگر | انتشار | وضعیت |
|---|---|---|---|---|---|---|---|---|---|
| پنل مالک (`owner-native-android`) | Android | مالک | Flutter | خیر | خیر | خیر | بله | `owner-continuous`: `payesh-owner.apk` | ✅ بومی؛ هم‌ارز کامل با WebView قبلی (ردیف ۱۲۶) |
| پنل مالک (`owner-native-windows`) | Windows | مالک | Flutter Win32 | خیر | خیر | خیر | بله | `owner-continuous`: `payesh-owner-setup.exe`، `payesh-owner-windows.zip` | ✅ بومی؛ ارتقای درجا از WebView2 |
| اپ مدرسه/کاربر (`school-native-android`) | Android | مدرسه + کاربر | Flutter | خیر | خیر | خیر | بله | `native-v*`: `payesh-native.apk`/`.aab` | ✅ بومی؛ ⚠️ ناقص: فقط Gateway، حدود ۲۶ مجموعه کم دارد (ردیف ۱۲۸)، حالت LAN ندارد (ردیف ۱۲۷) |
| اپ مدرسه/کاربر (`school-native-windows`) | Windows | مدرسه + کاربر | Flutter Win32 | خیر | خیر | خیر | بله | `native-v*`: `payesh-native-windows.zip` (setup.exe فقط artifact CI) | ✅ بومی؛ ⚠️ همان کمبودها |
| اپ مدرسه (`school-webview-windows`) | Windows | مدرسه + کاربر | WebView2 + `node.exe` + `client/` | **بله** | **بله** | **بله** | **خیر** | `continuous` و `v*`: `payesh-setup.exe`، `payesh-local-windows.zip` | ⛔ WebView؛ حذف در ردیف ۱۲۹ |
| اپ مدرسه (`school-webview-android`) | Android | مدرسه + کاربر | `android.webkit.WebView` | **بله** | **بله** | خیر | **خیر** | `continuous` و `v*`: `payesh-local.apk` | ⛔ WebView؛ حذف در ردیف ۱۲۹ |
| نصب لینوکس (`school-linux-server-install`) | Linux | مدرسه | سرور Node + مرورگر | **بله** | **بله** | **بله** | **خیر** | منتشر نمی‌شود (فقط داخل مخزن/zip) | ⛔ جایگزین: حالت LAN بومی (ردیف ۱۲۷) |
| پنل مالک قدیمی (`owner-webview-android-control`، `owner-webview-windows-control`) | Android / Windows | مالک | WebView / WebView2 | بله | بله | خیر | خیر | — | فقط کنترل منفی CI |
| fixtureهای منجمد پنل مالک (`owner-webview-fixtures`) | Android + Windows | مالک | WebView / WebView2 | بله | بله | خیر | خیر | — | ورودی آزمون + منبع ارتقا |
| zip ثبت‌شده در `releases/` (`school-webview-release-zips`) | Windows | مدرسه | WebView2 + Node | بله | بله | بله | خیر | (همان zip بالا؛ فایل bot) | ⛔ با ردیف ۱۲۹ |
| بستهٔ سرور ابری (`cloud-server-bundle`) | سرور | اپراتور | بدون UI روی دستگاه | — | — | — | — | `continuous`: `payesh-cloud.zip` | سرور است، نه برنامهٔ نصبی کاربر |

- SPA وب سرور مالک (`apps/owner-panel/server`) یک وب‌سایت روی سرور است، نه برنامهٔ نصبی. در رجیستری نیست، چون چیزی روی دستگاه کاربر نصب نمی‌کند.
- قابلیت‌های کامل نسخهٔ WebView مدرسه مرجع ماتریس هم‌ارزی ردیف ۱۲۸ است. تا آن ماتریس سبز نشود، WebView مدرسه برداشته نمی‌شود، تا قابلیتی حذف نشود.

## ۳. تصمیم (ADR)

- **D‑49** در قانون اساسی نسخهٔ ۱٫۱۸ و **ADR‑126** با ردیف ۱۲۶ ثبت شدند. پیش از این ردیف تصویب شده بودند:
  - هیچ اپ نصبی پایش نباید HTML/CSS/JS، WebView2، Android WebView، پوستهٔ مرورگر یا «مرورگر پنهان + Node + سرور محلی» باشد؛
  - استثنای WebView پنل مالک (D‑44 / ADR‑62) **لغو** شده است.
- این ردیف ADR تازه‌ای نساخت تا دو منبع حقیقت پیدا نشود. به‌جای آن §۷ «اجرای ماشینی» را به ADR‑126 افزود و رجیستری را منبع ماشین‌خوان آن کرد.

## ۴. رجیستری و Gate در CI

`docs/cloud/125-installables.json` برای هر برنامه این‌ها را ثبت می‌کند:

- مسیرهای منبع؛
- **نقاط ورود دقیق** (فایل نصب‌کننده، manifest، runner و…؛ پیشوند پوشه کافی نیست)؛
- فناوری رابط و پرچم‌های صادقانه؛
- artifactها و کانال انتشار؛
- خط CI ای که دروازهٔ بومی را روی همان فایل اجرا می‌کند؛
- ردیف حذف (برای WebView).

`tools/installables-125.mjs` در این حالت‌ها قرمز می‌شود:

| کد | قرمز وقتی… |
|---|---|
| I‑01 | ورودی «بومی» است ولی پرچم‌ها HTML/مرورگر/Node می‌گویند؛ یا WebView منتشرشده‌ای «در انتظار حذف + ردیف» ندارد |
| I‑02 | مسیر یا نقطهٔ ورود رجیستری در مخزن نیست |
| I‑03 | **ثبت‌نشده:** پروژهٔ Android، نصب‌کنندهٔ Inno/NSIS/WiX/MSIX، پوستهٔ C# یا Flutter runner، Electron/Capacitor/Cordova/Tauri، اسکریپت نصب یا launcher، یا apk/exe/msi ثبت‌شده که در هیچ ورودی نیست |
| I‑04 | workflow فایل نصبی‌ای می‌سازد که هیچ ورودی مالکش نیست |
| I‑05 | **WebView «بومی» نامیده شده:** منابع ورودی بومی import یا وابستگی WebView (Dart/pubspec/Kotlin/Java/Gradle)، WebView2 در runner یا CMake، `node.exe`/WebView2/وب در `Source:` نصب‌کننده، اجرای URL مرورگر، یا `index.html`/`assets/www` دارند |
| I‑06 | ورودی بومی هیچ خط CI ای ندارد که `native-independence-gate.mjs` را **بدون** `--expect-fail` روی artifactش اجرا کند |
| I‑07 | workflow انتشار فایلی فقط-WebView را منتشر می‌کند که در رجیستری برای همان workflow اعلام نشده |
| I‑08 | کانال فقط-بومی (`owner-continuous`، `native-v*`) ورودی غیربومی دارد |
| I‑09 | **تضعیف دروازه:** معیار `43-native-independence.json` چیزی از خط پایهٔ منجمد ردیف ۱۲۵ از دست داده (node.exe، WebView2Loader، assets/www، متدهای WebView و…) |
| I‑10 | ورودی بومی را workflow ای منتشر می‌کند که نه دروازه را اجرا می‌کند و نه `native-client.yml` را صدا می‌زند |

- **کجا اجرا می‌شود:**
  - `.github/workflows/installables.yml`: روی هر push و PR، **بدون فیلتر مسیر**، چون نصب‌کنندهٔ تازه ممکن است هر جای درخت ظاهر شود؛
  - `tests/run.js`: آزمون شمارهٔ ۱۳۰، در build-and-release.
- **کنترل منفی:** `tests/installables-125.js` بررسی را روی مخزن واقعی اجرا می‌کند (باید سبز باشد)، سپس **۲۹ جهش درون‌حافظه‌ای** می‌سازد و هر کدام باید با کد درستش قرمز شود. نمونه‌ها:
  - APK مدرسه WebView «بومی» اعلام شود → I‑05 روی `MainActivity.java`؛
  - `webview_flutter` به پنل مالک اضافه شود → I‑05؛
  - `node.exe` در نصب‌کنندهٔ بومی → I‑05؛
  - خط دروازهٔ owner به `--expect-fail` تبدیل شود → I‑06؛
  - `payesh-owner-web.zip` در build.yml منتشر شود → I‑07؛
  - WebView به `owner-continuous` برود → I‑08؛
  - `node.exe` یا `loadUrl` یا `assets/www/` از معیار حذف شود → I‑09؛
  - نصب‌کنندهٔ دوم کنار یک نصب‌کنندهٔ ثبت‌شده اضافه شود → I‑03.
- **یافتهٔ خود آزمون:** نسخهٔ اول پوشه‌ها را با پیشوند می‌پوشاند، و جهش MU‑02 (نصب‌کنندهٔ تازه در `installer/`) **رد نشد**. رجیستری به «نقطهٔ ورود دقیق» تغییر کرد و MU‑02/MU‑28 حالا قرمز می‌شوند.
  - یافتهٔ دوم: `install.bat`، `start.bat` و `start.sh` در ریشهٔ مخزن (launcherهای بستهٔ WebView) در فهرست اولیه نبودند. کشف آن‌ها را پیدا کرد و حالا ثبت شده‌اند.

## ۵. شواهد

| | نتیجه |
|---|---|
| [S] محلی `node tools/installables-125.mjs` | `INSTALLABLES-125-OK entries=12 native=4 webview_still_published=2 discovered=24` |
| [S] محلی `node tests/installables-125.js` | `INSTALLABLES-125-TEST-OK checks=4 mutations=29` |
| [S] محلی آزمون‌های وابسته | repo-map-93، adr-117، adr-ids-60، release-gate-95، android-release-76، evidence-sha-89، owner packaging (۳۹ جهش)، landing-114: همه OK |
| [S] CI روی `f33a12f` | `installables-registry` **43228418079** ✅ (`INSTALLABLES-125-OK …` + `INSTALLABLES-125-TEST-OK checks=4 mutations=29`) · `build-and-release` **43228417967** ✅ (tests-run 130/130) |

## ۶. باز / بعدی

- **ردیف ۱۲۷:** حالت LAN و نصب‌کنندهٔ بومی مدرسه برای Windows، جایگزین `school-linux-server-install` و بخش «سرور محلی» WebView.
- **ردیف ۱۲۸:** ماتریس هم‌ارزی و حدود ۲۶ صفحهٔ مجموعهٔ کم‌مانده در اپ بومی مدرسه.
- **ردیف ۱۲۹:** `build.yml` و Pages به بومی سوئیچ می‌کنند و `payesh-setup.exe`، `payesh-local-windows.zip` و `payesh-local.apk` WebView از `continuous` برداشته می‌شوند.
  - پس از آن، رجیستری این ورودی‌ها را به `negative-control` تغییر می‌دهد. IN‑04 فهرست «هنوز منتشرشده» را دقیقاً می‌سنجد، پس هر تغییری باید آگاهانه باشد.
- **مسدود (مالک):** کلید امضای APK مدرسه و PFX ویندوز (Authenticode) در Secrets نیستند.
