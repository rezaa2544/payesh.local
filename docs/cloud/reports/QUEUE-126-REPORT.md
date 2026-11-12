# گزارش صف — ردیف ۱۲۶: پنل مالک بومی (Flutter، Windows + Android) به‌جای WebView2 و Android WebView

| | |
|---|---|
| تاریخ | ۱۴۰۵/۰۸/۲۲ · 2026‑11‑12 |
| شاخه | فقط `main` (بدون شاخه یا worktree، به دستور مأموریت) |
| commitها | `1699eb8` اپ و API و CI · `80d5424` نقشهٔ مخزن + NU78-05 · `8d15f1d` جابه‌جایی انتشار به بومی + fixtureهای منفی + D‑49/ADR‑126 · `3a3b8ad` مهاجرت اتمی tenancy (یافتهٔ CI) · `c1e414c` نگاشت sha-map |
| برچسب‌ها | [S] = در محیط آزمایشی ARENA یا CI · [M] = روی هاست یا دستگاه واقعی |
| فهرست همهٔ گزارش‌ها | [`QUEUE-LOG.md`](QUEUE-LOG.md) |
| سند تصمیم | [`../126-adr-native-owner-panel.md`](../126-adr-native-owner-panel.md) (ADR‑126، D‑49؛ ADR‑62 لغو شد) |
| ردیف قبلی | [`QUEUE-120-REPORT.md`](QUEUE-120-REPORT.md) |

## ۱. خلاصه

پنل مالک دیگر وب‌سایتی در مرورگر پنهان نیست. روی Android و Windows یک اپ **Flutter/Dart** است (`apps/payesh/owner`) و نسخهٔ WebView از انتشار برداشته شد.

| | پیش از ردیف ۱۲۶ | پس از ردیف ۱۲۶ |
|---|---|---|
| Android `payesh-owner.apk` | `android.webkit.WebView` روی `web/app.js` | Flutter (`ir.payesh.owner`)؛ دروازهٔ بومی PASS |
| Windows `payesh-owner-setup.exe` | WinForms + WebView2 | `payesh_owner.exe` (Flutter) + Inno Setup؛ بدون WebView2/Node |
| انتشار `owner-continuous` | `owner-panel.yml`: exe و APK WebView + `payesh-owner-web.zip` | فقط `owner-native-publish.yml`: مجموعهٔ بومی؛ فایل وب حذف شد |
| ساخت‌های WebView | منتشر می‌شدند | فقط کنترل منفی CI؛ دروازه باید آن‌ها را **رد** کند |

## ۲. چه ساخته شد

- **`apps/payesh/packages/payesh_owner_api`** (Dart خالص): قرارداد `/api/platform/v1`، نقش‌ها و CAPS، جدول خطاها و قواعد، هم‌ارز `web/app.js`.
- **`apps/payesh/owner`** (Flutter): ورود رمز + TOTP و ۹ صفحه (داشبورد، مدارس، پلن، سقف و مصرف، سلامت، زیرساخت، اپراتورها، ممیزی، گزارش)، با همان قواعد وب:
  - حذف دومرحله‌ای چهارچشمی؛ کد فعال‌سازی یک‌بارنمایش.
  - تأیید مالک برای عملیات پرخطر زیرساخت، با تایپ دوبارهٔ شناسه.
  - دلیل حداقل ۱۰ نویسه برای هر تغییر.
  - توکن فقط در حافظه؛ آدرس سرور ماندگار.
  - طرح گوشی با کشو و طرح دسکتاپ با NavigationRail.
- **ارتقای درجا:**
  - Android: همان `applicationId` و همان کلید مالک، versionCode = `100000 + run`.
  - Windows: همان AppId و پوشهٔ پنل قدیمی؛ `[InstallDelete]` فایل‌های WebView2 را پاک می‌کند و `origin.txt` می‌ماند.
- **CI** (`native-client.yml`):
  - `owner-native-it`: IT روی سرور واقعی مالک.
  - `owner-android`: APK/AAB، دروازه، aapt2، apksigner، کنترل fail-closed امضا، ارتقای درجا.
  - `owner-windows`: EXE، zip، نصب‌کننده، ارتقا از WebView، اجرا، حذف.
  - همهٔ این‌ها شرط `native-gate` هستند.
- **انتشار:**
  - `owner-native-publish.yml` تنها نویسندهٔ `owner-continuous` است.
  - `owner-panel.yml` منتشر نمی‌کند و `contents: write` ندارد.
  - `apps/owner-panel/legacy-webview-fixtures/`: آخرین APK و setup.exe WebView با SHA‑256 قفل شده‌اند (فقط کنترل منفی).
- **قواعد معماری:** D‑49 در قانون اساسی (نسخهٔ ۱٫۱۸)، ADR‑126، بنر لغو در ADR‑62، پاسخ نهایی O‑27، README و نقشهٔ مخزن.

## ۳. شواهد CI [S]

| اجرا | نتیجه |
|---|---|
| [native-client 43223892311](https://github.com/rezaa2544/payesh.local/actions/runs/43223892311) روی `f854863` | **همهٔ jobها سبز در تلاش اول**، از جمله `native-gate` |
| [owner-native-publish 43225796131](https://github.com/rezaa2544/payesh.local/actions/runs/43225796131) | `removing non-native asset: payesh-owner-web.zip` · دروازه PASS روی APK و zip پیش و پس از انتشار · `OWNER-NATIVE-PUBLISH-OK 120` |
| [api-contract 43223892404](https://github.com/rezaa2544/payesh.local/actions/runs/43223892404) | `MIGRATE-ATOMIC-126-OK` روی PostgreSQL 16 |
| [native-client 43221593207](https://github.com/rezaa2544/payesh.local/actions/runs/43221593207) (`8d15f1d`) | jobهای مالک سبز (gateway-real به‌خاطر همان race بخش ۵ قرمز بود) |

نشانگرهای کلیدی از لاگ همین اجراها:
- `OWNER-NATIVE-IT-OK steps=14 db=pglite`: اپ بومی در برابر Gateway واقعی، API پلتفرم و مهاجرت‌ها.
- `OWNER-SIGNING-REQUIRED-CONTROL-OK`: بدون کلید، ساخت release متوقف می‌شود.
- APK بومی:
  - `package: name='ir.payesh.owner' versionCode='100119'`، فقط مجوز INTERNET، غیر debuggable.
  - امضای v2+v3 با `CN=Payesh Owner Panel, O=Payesh, C=IR`.
- `OWNER-ANDROID-UPGRADE-OK same-signer versionCode 31->100119`: گواهی امضای APK بومی و APK قدیمی WebView یکی است (`d35afba3…8321`).
- Windows:
  - نصب WebView قدیمی ← `NATIVE-GATE-NEGATIVE-CONTROL-OK` روی پوشهٔ نصب‌شده (فایل‌های WebView2 یافت شد).
  - نصب بومی روی آن ← `NATIVE-GATE-OK` روی پوشهٔ نصب‌شده.
  - `RUN-OK title=پنل مالک پایش` بدون ماژول WebView2/Node، با `flutter_windows.dll`.
  - `OWNER-INSTALLER-OK upgrade-from-webview=True install+gate+run+uninstall`.

بازبینی مستقل بیرون از CI: فایل‌های منتشرشده دانلود شدند.
- `sha256sum -c` OK.
- دروازهٔ بومی PASS روی APK و zip.
- APK هیچ `assets/www`، `index.html` یا WebView ندارد.
- `owner-native-status.json` = `{"kind":"native-flutter","webview":false,"commit":"f854863…"}`.
- هر چهار لینک README پاسخ می‌دهند.

## ۴. آزمون‌های محلی [S]

| آزمون | نتیجه |
|---|---|
| `flutter test` اپ مالک | 20/20، پوشش 87.7% |
| `payesh_owner_api` | 20/20، پوشش 82.6%؛ IT روی سرور واقعی PASS |
| `packaging.test.js` | `rules=9 mutations_caught=39 failures=0` (P4 و P6 برای سیاست بومی وارونه شدند) |
| `owner-spa`، `owner-login`، `local-up` | 140 بررسی / 0 خطا · بدون خطا · `LOCAL-UP-102-OK` |
| `tests/adr-117.js` | 7/7، 10 جهش (D‑49 آخرین تصمیم، نسخهٔ ۱٫۱۸) |
| `tests/migrate-atomic-126.js` (PG 17) | 4/4؛ کنترل منفی مهاجرت قدیمی را شکست |
| `offline-119`، `gateway-67`، `tenant-121` (PG 17) | سبز (18/18، 8/8 با 28 کنترل منفی) |
| `npm test` (شاهد) | `pass=129 fail=0 registered=129` · `EVIDENCE-SHA-89-OK` |

## ۵. یافتهٔ CI: مهاجرت tenancy اتمی نبود (رفع شد)

- **نشانه:** شکست‌های مکرر gateway-real («503 quota_unavailable»). تا امروز با اجرای دوباره رد می‌شد.
- **علت ریشه‌ای**، از لاگ PostgreSQL: `new row violates row-level security policy for table "gateway_quota"`.
  - `tenancy.migrate()` دستور به دستور و بیرون از تراکنش اجرا می‌شد.
  - میان `DROP POLICY` و `CREATE POLICY`، جدول FORCE RLS بی‌سیاست می‌ماند و هر نوشتن رد می‌شد.
- **اثر در محصول:** همین پنجره در هر استقرار چرخشی یا راه‌اندازی دوبارهٔ یک نمونهٔ Gateway، هنگام سرویس‌دهی نمونهٔ دیگر، باز می‌شد. دو مهاجرت هم‌زمان هم یکدیگر را می‌شکستند (42710 / tuple concurrently updated).
- **بازتولید پیش از رفع:** ۶۶۸ نوشتنِ ردشده و ۱۵ شکست مهاجرت در ۸ ثانیه.
- **رفع:** یک تراکنش + `pg_advisory_xact_lock` + تکرار روی بن‌بست (40P01).
- **پس از رفع:** حدود ۳۲٬۰۰۰ نوشتن و ۵۱۶ مهاجرت هم‌زمان، با **۰** رد و **۰** شکست.
- **آزمون دائمی:** `tests/migrate-atomic-126.js` در api-contract اجباری است و مهاجرت قدیمی کنترل منفی آن است. gateway-real پس از رفع در تلاش اول سبز شد.
- هیچ دروازه یا آزمونی تضعیف نشد.

## ۶. NOT RUN [M] و مسدودها

- **Authenticode ویندوز — BLOCKED (مالک):** Secretهای `PAYESH_WIN_PFX_*` نیستند. setup.exe امضانشده با توضیح SmartScreen و SHA256SUMS منتشر می‌شود.
- **دستگاه واقعی (ردیف ۹۱) — BLOCKED:**
  - ارتقای درجای APK روی گوشی واقعی اجرا نشده است. CI شرط‌های لازم را اثبات کرده است: امضای یکسان و versionCode بالاتر.
  - نصب ویندوز روی runner واقعی Windows اجرا شد، نه روی رایانهٔ مالک.
- **`payesh-owner-web.zip`** دیگر در انتشار پنل مالک نیست. SPA وب همچنان روی خود سرور مالک سرو می‌شود و بستهٔ وب artifact CI است.

## ۷. آفلاین‌محوری

- کلاینت مالک دادهٔ مدرسه را نگه نمی‌دارد و هر عمل آن، عملی مدیریتی روی سرور است. پس صف محلی ندارد و هنگام قطع اتصال پیام خطای روشن می‌دهد.
- صف محلی و آفلاین‌محوری اپ مدرسه دست نخورد. gateway-real (تلاش اول) و `offline-119` سبزند.
- رفع بخش ۵ همان مسیر همگام‌سازی را در استقرار چندنمونه‌ای پایدارتر می‌کند.

## ۸. اثر بر سایر ردیف‌ها و گام بعد

- **۱۲۵:** فهرست ماشین‌خوان اپ‌های نصبی، و آزمونی که برچسب «بومی» روی هر خروجی WebView را رد کند.
- **۱۲۷–۱۲۹:** اپ‌های **مدرسه** در انتشار `continuous` (`payesh-setup.exe`، `payesh-local-windows.zip`، `payesh-local.apk`) هنوز WebView/Node هستند.
  - این ردیف‌ها حالت مستقیم LAN، صفحه‌های جاافتادهٔ اپ بومی مدرسه (حدود ۲۶ کالکشن)، و جابه‌جایی `build.yml` و Pages به خروجی بومی را انجام می‌دهند.
  - امضای APK مدرسه (ردیف ۶۱) BLOCKED است: Secret نیست.
