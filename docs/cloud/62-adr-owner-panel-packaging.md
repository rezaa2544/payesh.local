# ADR‑62 — بسته‌بندی پنل مالک: استثنای WebView فقط برای پنل مالک

| مورد | مقدار |
|---|---|
| شناسه | **ADR‑62** (نام سند؛ ثبت تصمیم در Decision Log = **D‑44** / **O‑27**) |
| وضعیت | **پذیرفته — تصمیم صریح مالک (O‑27 = گزینهٔ A)** · ۱۴۰۵/۰۸/۱۹ |
| ردیف Notion | ۹۹ — پنل مالک · PR‑4 (workflow بسته‌بندی) |
| مبنا | `docs/cloud/61-owner-panel-app-proposal.md` §۴ (O‑27 پیشنهادی، بند ۲، ۳ و ۵)؛ قانون اساسی §۴.۸ و §۱۴ |
| پیاده‌سازی | `.github/workflows/owner-panel.yml` · `apps/owner-panel/{android,desktop,installer,scripts}` · `apps/owner-panel/tests/packaging.test.js` |

## 1. تصمیم

مالک گزینهٔ A سند ۶۱ را برای O‑27 انتخاب کرد: پنل مالک سه خروجی جدا دارد که هر سه یک پوستهٔ **نازک** روی همان SPA ایستای `apps/owner-panel/web` (PR‑3) هستند:

| خروجی (نام ثابت) | ساخت | پوسته |
|---|---|---|
| `payesh-owner-setup.exe` | Inno Setup روی `windows-latest` | WinForms + **WebView2** (`PayeshOwner.exe`) |
| `payesh-owner.apk` | Gradle/AGP روی `ubuntu-latest` | Activity + **Android WebView** |
| `payesh-owner-web.zip` | اسکریپت قطعی Node | SPA + `server/static-server.js` (بدون وابستگی) |
| `SHA256SUMS` | گیت `owner-gate` | قالب `sha256sum` |

## 2. دامنهٔ استثنا (و آنچه تغییر نمی‌کند)

- **استثنای WebView فقط برای ابزار مدیریتی مالک پلتفرم است.** هیچ کاربر مدرسه این اپ را نصب نمی‌کند.
- **ردیف ۶۳ و دروازهٔ استقلال بومی کلاینت مدرسه تغییر نمی‌کند و تضعیف نمی‌شود.** این ADR هیچ معیار، آستانه یا فهرست مجاز آن دروازه را عوض نمی‌کند و نمی‌تواند به‌عنوان سابقه برای اپ مدرسه استناد شود.
- O‑09 (پشتهٔ کلاینت مدرسه) **باز می‌ماند**؛ این تصمیم پاسخ آن نیست.
- O‑25 / ADR‑43 (انتخاب فناوری کلاینت، ردیف ۹۰) **باز می‌ماند**؛ D‑43 برای آن رزرو است.
- فایل‌های اپ مدرسه (`desktop/`, `install/android/`, `installer/payesh.iss`, `.github/workflows/build.yml`) در این PR تغییر نکرده‌اند.

## 3. قیود امنیتی پوسته (آزمون می‌شوند)

1. **قفل مبدأ:** مبدأ سرور در اولین اجرا از کاربر پرسیده می‌شود؛ فقط `https://host[:port]` (بدون مسیر/پرس‌وجو/userinfo). استثنا فقط `http://localhost` و `http://127.0.0.1` برای توسعه. هر ناوبری، frame، پنجرهٔ جدید یا دانلود خارج از مبدأ مسدود است (`OriginPolicy` در Java و C#، هر دو با ۲۱ مورد آزمون یکسان).
2. **بدون پل JS:** Android بدون `addJavascriptInterface`؛ WebView2 با `AreHostObjectsAllowed=false` و `IsWebMessageEnabled=false`.
3. **TLS:** خطای گواهی ⇒ لغو (`handler.cancel()` / `ServerCertificateErrorAction.Cancel`)؛ Android: `cleartextTrafficPermitted="false"` جز loopback، `MIXED_CONTENT_NEVER_ALLOW`.
4. **بدون آدرس/توکن/کلید سخت‌کد.** هیچ URL سرور در APK یا exe پخته نمی‌شود (CI رشته‌های dex/arsc را می‌سنجد).
5. Android: `allowBackup=false`، فقط مجوز `INTERNET`، `debuggable=false`، `FLAG_SECURE`، بدون دسترسی فایل/محتوا. ویندوز: DevTools خاموش، مجوزها (دوربین/مکان/…) رد، autofill/ذخیرهٔ رمز خاموش، نصب بدون UAC فقط برای کاربر جاری.

## 4. شناسه‌های جدا از اپ مدرسه

| مورد | پنل مالک | اپ مدرسه |
|---|---|---|
| Android `applicationId`/`namespace` | `ir.payesh.owner` | `ir.payesh.local` |
| Inno `AppId` | `{20AE76FD-560D-41ED-B6F5-7F66F3308129}` | `{7C4E2A51-9F3B-4E7A-9C21-5B8A1D3E6F02}` |
| پوشهٔ نصب | `{localappdata}\Programs\PayeshOwner` | `{autopf}\Payesh` |
| میان‌بر / نام برنامه | «پنل مالک پایش» | «پایش-لوکال» |
| فایل اجرایی | `PayeshOwner.exe` | `Payesh.exe` |
| مانیفست ویندوز | `Payesh.Owner.Desktop` | `Payesh.Local.Desktop` |
| دادهٔ کاربر | `%LOCALAPPDATA%\PayeshOwner` | جدا |

## 5. امضا و انتشار

- نام Secretها (فقط نام؛ مقدار هرگز در مخزن/گزارش نمی‌آید): Android `PAYESH_OWNER_KEYSTORE_B64`, `PAYESH_OWNER_KEYSTORE_PASS`, `PAYESH_OWNER_KEY_ALIAS`, `PAYESH_OWNER_KEY_PASS`؛ ویندوز `PAYESH_OWNER_WIN_PFX_B64`, `PAYESH_OWNER_WIN_PFX_PASS`. این‌ها عمداً با Secretهای اپ مدرسه (`PAYESH_KEYSTORE_*`) مشترک نیستند.
- **بدون Secret:** exe و APK ساخته می‌شوند ولی «امضانشده / فقط آزمایشی» برچسب می‌خورند؛ CI ثابت می‌کند واقعاً امضا ندارند (`apksigner verify` باید شکست بخورد؛ Authenticode باید `NotSigned` باشد) و **هرگز منتشر نمی‌شوند**.
- **Secret موجود ولی نامعتبر ⇒ قرمز.** امضاشده یعنی: APK با v2+v3 و اثر انگشت گواهی؛ exe با `Get-AuthenticodeSignature = Valid`. گیت هر ادعای «signed» بدون این شاهد را رد می‌کند.
- انتشار فقط روی `main` و فقط در prerelease `owner-continuous` با عنوان «انتشار رسمی نیست»: بستهٔ وب و `SHA256SUMS` همیشه؛ exe/APK فقط اگر امضای تأییدشده دارند (وگرنه asset قبلی حذف می‌شود). همهٔ خروجی‌ها، امضاشده یا نه، در artifact آزمایشی `payesh-owner-test-only` می‌مانند.

## 6. گیت (fail-closed)

`apps/owner-panel/scripts/check-owner-artifacts.js` در job `owner-gate`: نبودن هر خروجی، فایل خالی/کوچک، نوع فایل نادرست، ناهمخوانی sha256 با meta همان job، ساختار ناقص (APK بدون dex/manifest؛ zip بدون index/app/static-server یا با commit دیگر)، ادعای امضای بی‌شاهد، یا فایل ناشناخته ⇒ **قرمز**. شکست هر یک از سه job ساخت هم گیت را قرمز می‌کند. خودآزمایی گیت ۱۵ کنترل منفی دارد.

## 7. آنچه این ADR اثبات نمی‌کند

- نصب و اجرای واقعی روی دستگاه مالک (ویندوز/Android): **OWNER / تأییدنشده [?]**. فقط نصب/حذف بی‌صدا روی runner ویندوز CI اجرا می‌شود.
- امضای واقعی: تا تنظیم Secretها توسط مالک **وجود ندارد**؛ هیچ ادعای امضا یا انتشار رسمی نمی‌شود.
- ورود واقعی (O‑17): فرم ورود همچنان fail-closed است (`login_unavailable`).
- امنیت: **UNKNOWN** تا پنتست انسانی مستقل (D‑41).
