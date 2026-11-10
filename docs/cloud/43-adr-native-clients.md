# ADR‑43: فناوری کلاینت بومی مدرسه (Flutter/Dart) و جهت «برنامهٔ مستقل»

| مورد | مقدار |
|---|---|
| شناسه | **ADR‑43** (نام این سند). تصمیم در Decision Log با شناسهٔ **D‑43** و پرسش باز **O‑25** ثبت می‌شود. |
| وضعیت | **پذیرفته شد. مالک صریحاً امضا کرد** (D‑43 — APPROVED · ۱۴۰۵/۰۸/۱۹). |
| ردیف Notion | ۶۲. همین سند پیش‌شرط ردیف‌های ۶۳ و ۶۹ تا ۷۵ است. ردیف ۸۱ مکمل آن است. |
| مجری | ARENA سند را نوشت و OWNER امضا کرد (O‑25). |
| مبنا | قانون اساسی: بند ۴ «یک هستهٔ کلاینت، چند سکو»، بند ۲۵ «مسیر داده فقط از Gateway»، §۴.۵.۱، §۱۴. همچنین ADR‑31 (موتور محلی) و ADR‑62 (استثنای WebView فقط برای پنل مالک). |
| پیاده‌سازی | `apps/payesh/` و `tools/native-independence-gate.mjs`، با معیار ماشین‌خوان `docs/cloud/43-native-independence.json` و workflow `.github/workflows/native-client.yml`. |

## ۱. متن تصمیم مالک (D‑43)

> D‑43 — APPROVED. گزینهٔ Flutter برای معماری کلاینت مستقل Payesh تصویب می‌شود.
> - Flutter/Dart فناوری مشترک Android و Windows است.
> - WebView و Browser Wrapper در اپ مدرسه ممنوع است.
> - وابستگی به Node.js در بستهٔ نهایی کلاینت ممنوع است.
> - خروجی‌ها مستقل‌اند: Android APK/AAB و Windows EXE.
> - Build و تست در GitHub Actions انجام می‌شود.
> - API، Gateway، Directory، Cell Routing و معماری Backend موجود حفظ می‌شوند.
> - Offline/Sync، امنیت، Tenant Isolation و Evidence Gate کامل رعایت می‌شوند.
> - این تصمیم در قانون اساسی معماری و ADR‑43 ثبت می‌شود.
>
> امضای D‑43 مجوز آغاز برنامه‌ریزی و اجرای ردیف‌های ۶۳ و ۶۹ تا ۷۵ است. هر مرحله فقط با Evidence معتبر و Gate مستقل تأیید می‌شود. هیچ ادعای Native بودنی بدون بررسی خروجی واقعی Build پذیرفته نیست.

## ۲. وضعیت فعلی (با شاهد کد روی `main`)

| سکو | پوستهٔ امروز | شاهد در مخزن |
|---|---|---|
| Windows | WinForms + **WebView2**، به‌همراه **node.exe** قابل‌حمل که سرور محلی را اجرا می‌کند | `desktop/PayeshApp.cs`؛ مرحلهٔ «آوردن Node قابل حمل» در `.github/workflows/build.yml` |
| Android | Activity + **WebView** با پل جاوااسکریپت | `install/android/app/src/main/java/ir/payesh/local/MainActivity.java` |
| UI مشترک | حدود **۱۱٬۲۶۳** خط HTML/JS بدون build | `wc -l client/*.js client/*.html` (روی `1adf241`) |

بنابراین امروز هر دو سکو در عمل «مرورگر داخل یک پنجره» هستند. ادعای «برنامهٔ مستقل» با این وضعیت پذیرفته نیست.

## ۳. مقایسهٔ گزینه‌ها

| معیار | **A) Flutter/Dart** (انتخاب‌شده) | B) Kotlin (Android) + WinUI 3 (Windows) | C) ادامهٔ پوستهٔ WebView |
|---|---|---|---|
| استقلال بومی (نبود WebView/Node) | ✅ موتور رندر خودِ Flutter؛ بدون WebView و Node | ✅ | ❌ ذاتاً WebView است |
| یک هسته، چند سکو (بند ۴) | ✅ یک کد Dart برای Android و Windows (و بعداً iOS) | ❌ دو کد جدا، رفتار واگرا | ✅ ولی غیربومی |
| فارسی/RTL و فونت | ✅ `Directionality` و `intl`، فونت بسته‌بندی‌شده | ✅ | ✅ |
| هزینهٔ بازنویسی | متوسط: یک بار | زیاد: دو بار | صفر |
| امنیت ذخیرهٔ محلی | ✅ Android Keystore و Windows DPAPI از طریق plugin | ✅ | ◐ محدود به مرورگر |
| ساخت و آزمون در CI روی GitHub runner | ✅ ‏`ubuntu-latest` برای APK و `windows-latest` برای EXE | ✅ ولی دو زنجیره | ✅ |
| نگهداری | یک تیم و یک زبان | دو زبان و دو چرخهٔ انتشار | پایین، اما با بدهی معماری |

**پیشنهاد پیش‌فرض ARENA گزینهٔ A بود و مالک همان را امضا کرد.**

## ۴. آنچه حفظ و آنچه بازنویسی می‌شود

**حفظ می‌شود (هیچ تغییری در قرارداد نیست):**
- سرور و قراردادهای API: `server/*`، قرارداد Sync v1 (`docs/cloud/contracts/sync-v1.md`)، Gateway (ردیف ۳۷)، Directory و Cell Routing (ردیف ۴۳)، اسکوپ نقش سمت سرور (۳۸)، سیاست تعارض (۴۱ و D‑28)، و RLS و جداسازی مستأجر (D‑07).
- پنل مالک و استثنای WebView آن (ADR‑62 و D‑44). این ADR آن را عوض نمی‌کند.
- اپ وب و پوسته‌های فعلی تا پایان مهاجرت (ردیف ۷۴) **کار می‌کنند و حذف نمی‌شوند**. پوستهٔ قدیمی تنها پس از عبور کلاینت بومی از گیت ۶۳ و پایلوت کنار می‌رود و این کار تصمیم جداگانهٔ مالک است.

**بازنویسی می‌شود (در `apps/payesh/`):**

| بسته | نقش | ردیف |
|---|---|---|
| `packages/payesh_core` | مدل‌ها، کدهای خطا، ارقام فارسی، تقویم جلالی (Dart خالص) | ۶۹، ۷۳ |
| `packages/payesh_data` | موتور SQLite محلی با همان قرارداد موتور وب (`put/putMany/del/get/count/list/byRef/since/stats`) و مهاجرت طرح | ۷۰ |
| `packages/payesh_sync` | کلاینت Sync v1: صندوقچهٔ ماندگار، idempotency، backoff و همگرایی LWW | ۷۱ |
| `packages/payesh_secure` | ذخیرهٔ امن توکن و کلید رمزنگاری پایگاه محلی (Android Keystore و Windows DPAPI) | ۷۲ |
| `packages/payesh_ui` | سیستم طراحی: RTL، تقویم جلالی، فونت، تم روشن/تیره، دسترس‌پذیری | ۷۳ |
| `packages/payesh_net` | کلاینت API نسخه‌دار، retry/timeout و پین‌کردن گواهی با پین پشتیبان | ۷۵ |
| `app/` | اپ Flutter (Android و Windows) با صفحات به ترتیب ارزش | ۶۹، ۷۴ |

**بازبینی ADR‑31 (ثبت صریح تعارض، بدون لغو بی‌صدا):** ADR‑31 گزینهٔ A (SQLite‑WASM در مرورگر) را برای کلاینت مرورگری آینده نگه داشته بود. ADR‑43 برای **کلاینت بومی** گزینهٔ C همان سند را اجرا می‌کند: SQLite بومی داخل بستهٔ Android و Windows، با همان قرارداد موتور. گزینهٔ A برای کلاینت مرورگری بدون نصب همچنان در وضعیت ADR‑31 باقی است و این سند آن را لغو نمی‌کند.

## ۵. معیار «استقلال بومی» (ماشین‌خوان)

معیار در `docs/cloud/43-native-independence.json` تعریف شده است. گیت ردیف ۶۳ (`tools/native-independence-gate.mjs`) فقط همین فایل را می‌خواند. خلاصهٔ معیار:

- **Android (APK/AAB):** در جدول `method_ids` هیچ فایل `classes*.dex` نباید فراخوانی‌ای به `Landroid/webkit/WebView;` (سازنده، `loadUrl`، `loadData*`، `addJavascriptInterface`، `evaluateJavascript`) وجود داشته باشد. کلاس‌های `androidx.webkit`، Capacitor و Cordova هم ممنوع‌اند. داخل بسته هم نباید `assets/www/` یا `assets/public/index.html` باشد.
- **Windows (پوشهٔ build یا zip):** دست‌کم یک `.exe` لازم است. فایل‌های `node.exe`، `WebView2Loader.dll`، `Microsoft.Web.WebView2.*.dll`، پوشهٔ `runtime/` و رشتهٔ `WebView2Loader.dll` داخل باینری‌ها ممنوع‌اند.
- **کنترل منفی اجباری:** بستهٔ WebView واقعی امروز باید **رد شود**، وگرنه گیت خودش نامعتبر است.

## ۶. قیود اجرایی

1. ARENA فقط مخزن را می‌خواند و از CI استفاده می‌کند. این ADR **فرض نمی‌کند** Flutter SDK روی ماشین Arena اجرا شود. هر Build و هر آزمون Flutter در GitHub Actions اجرا می‌شود. آزمون‌های Dart خالص را می‌توان روی هر ماشینی تکرار کرد.
2. هیچ کلید، رمز یا URL ثابت سرور داخل بسته نیست (بند ۲۲ و D‑23). آدرس مدرسه از Directory گرفته می‌شود و اندروید هرگز آدرس سرور نمی‌پرسد.
3. امضای انتشار APK مدرسه (ردیف ۶۱) **خارج از این ADR است** و به تصمیم بعدی مالک موکول شده است. خروجی CI فعلاً debug-signed یا unsigned است و «انتشار» نامیده نمی‌شود.
4. وضعیت امنیت همچنان `UNKNOWN` است (§۱۰.۲). استقلال بومی اثبات امنیت نیست.
5. هر ردیف (۶۳، ۶۹ تا ۷۵) شاهد جداگانه در `docs/cloud/reports/evidence/` و CI سبز مستقل لازم دارد.
