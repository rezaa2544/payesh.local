# ADR‑169 — نسخهٔ ویندوز ۳۲ بیتی (web32) — D‑50

| | |
|---|---|
| وضعیت | **پذیرفته** — دستور مالک، ردیف ۱۶۹ (۱۴۰۵/۰۸/۲۶): «همه فایل های نصبی ویندوز باید ورژن 32 بیتی رو هم داشته باشن» |
| تصمیم | **D‑50** (قانون اساسی) — استثنای محدود کنار D‑49 |
| انتخاب مالک | گزینهٔ «همان کد و همان ظاهر» (نه پوستهٔ سبک پنل وب) |

## مسئله

Flutter موتور ویندوز ۳۲ بیتی ندارد (Dart #45222، #59698؛ فقط x64 و arm64). اپ مدرسه و پنل مالک بومی (D‑49) فقط
`payesh_app.exe` / `payesh_owner.exe` ۶۴ بیتی دارند و روی ویندوز ۷/۸/۱۰ ۳۲ بیتی اجرا نمی‌شوند. سرویس دادهٔ مدرسه از قبل
یک نصب‌کنندهٔ مشترک x86+x64 دارد.

## تصمیم

نسخهٔ ۳۲ بیتی ویندوز = **همان کد Flutter/Dart** (همان `lib/`، همان ظاهر، همان پروتکل سرور، همان قالب دیتابیس)
که با `flutter build web` به JavaScript ترجمه و در یک برنامهٔ **۳۲ بیتی Chromium 109 (CEF)** نشان داده می‌شود —
Chromium 109 آخرین نسخهٔ سازگار با ویندوز ۷ است.

| بخش | کجا |
|---|---|
| لایهٔ `dart:io` برای وب (فایل، HTTP با fetch، zlib، Platform، Process) | `apps/payesh/packages/payesh_core/lib/io.dart` ← `src/io/web/` |
| SQLite رمزنگاری‌شده (SQLite3MC wasm، همان ChaCha20 و همان `PRAGMA hexkey`) روی فایل واقعی | `apps/payesh/packages/payesh_data/lib/src/sqlite/sqlite_web.dart` (VFS `multipleciphers-payesh-host`) |
| DPAPI از طریق برنامهٔ میزبان | `payesh_secure/lib/src/win32_dpapi_web.dart` |
| برنامهٔ ۳۲ بیتی (پنجره، `window.payeshHost`، سرو فایل‌های وب بدون شبکه از `http://payesh.localhost/`) | `tools/web32/shell/` (CMake، `-A Win32`، `/MT`) |
| نصب‌کننده (per-user، AppId جدا، پوشهٔ `PayeshNative32` / `PayeshOwner32`) | `tools/web32/installer/payesh-web32.iss` |
| دروازه روی خروجی واقعی (PE ۳۲ بیتی، runtime کامل، ساخت وب همین اپ، بدون node.exe/WebView2) | `tools/web32/web32-gate.mjs` |
| آزمون سرتاسری روی برنامهٔ **نصب‌شده** (قرارداد میزبان، CORS، رابط Flutter، دیتابیس رمزنگاری‌شده، خروج) | `tools/web32/e2e.mjs` |
| CI و انتشار | `.github/workflows/win32-edition.yml` ← `win32-publish.yml` (کانال `win32-continuous`) |
| به‌روزرسانی خودکار تفاضلی | `app32-update.json` + `app32-files`، `owner32-update.json` + `owner32-files` |

## مرزها (چرا D‑49 تضعیف نمی‌شود)

1. کانال‌های بومی (`native-continuous`، `owner-continuous`، `native-v*`) دست نمی‌خورند و فقط بومی می‌مانند (I‑08).
2. رجیستری نوع جدید `web32-compat` دارد (I‑12): فقط `windows-x86`، فقط با `policy: D-50`، پرچم‌های صادق
   (`html_css_js_ui` و `browser_engine_at_runtime` = true)، ساخته‌شده از همان `lib/` دوقلوی بومی (`same_code_as`)،
   فقط روی `win32-continuous` با `win32-publish.yml` و با دروازهٔ web32 روی همان فایل منتشرشده.
3. Node.js، سرور محلی و WebView2 در بسته ممنوع است؛ رابط، همان کد Flutter است نه یک وب‌سایت.
4. پیوندهای دارای پین SPKI (Gateway/مستقیم) در وب قابل بررسی نیستند، پس در نسخهٔ ۳۲ بیتی **بسته شکست می‌خورند**
   (هرگز بدون پین وصل نمی‌شوند). TLS با ریشه‌های خود Chromium (Chrome Root Store) بررسی می‌شود، نه ریشه‌های کهنهٔ ویندوز ۷.
5. صفحهٔ دانلود و README، نسخهٔ ۳۲ بیتی را جدا در دستهٔ «ویندوز ۳۲ بیتی» نشان می‌دهند؛ روی ویندوز ۶۴ بیتی نسخهٔ ۶۴ بیتی توصیه می‌شود.

## پیامدها

- اندازهٔ نصب بزرگ‌تر (~۲۰۰ مگابایت باز، به‌خاطر Chromium).
- هر تغییر در `apps/payesh/**` هر دو نسخه را می‌سازد؛ e2e نسخهٔ ۳۲ بیتی در CI روی ویندوز اجرا می‌شود.
- اگر روزی Flutter موتور ۳۲ بیتی ویندوز داشته باشد، D‑50 لغو و نسخهٔ ۳۲ بیتی بومی می‌شود.
