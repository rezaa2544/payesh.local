# ردیف ۱۶۱ — همهٔ پیوندهای دانلود مستقیم به خودِ فایل

> درخواست مالک (۲۰۲۶‑۱۱‑۱۵): «لینک‌های دانلود در مخزن را بررسی کن. باید مستقیم بروند برای دانلود فایل مورد نظر. همه باید به این صورت باشند.»

## ۱. بررسی (پیش از تغییر)

همهٔ پیوندهای انتشار در سطح‌هایی که کاربر می‌بیند یا اسکن می‌کند (README، `site/`، `client/`، `server/`، `install/` و `lib/` اپ‌های Flutter) استخراج و با `curl -L -r 0-0` آزموده شدند:

| پیوند | نتیجه |
|---|---|
| `owner-continuous/payesh-owner-setup.exe` ، `payesh-owner.apk` ، `payesh-owner-windows.zip` ، `SHA256SUMS` | ✅ مستقیم (206، application/octet-stream یا vnd.android.package-archive) |
| `native-continuous/payesh-native-setup.exe` ، `payesh-native-windows.zip` ، `SHA256SUMS` | ✅ مستقیم |
| `continuous/payesh-cloud.zip` | ✅ مستقیم |
| **اندروید اپ مدرسه/کاربر** — `releases/tag/native-continuous` در README، `site/index.html`، `client/install.html` و دو جا در `client/pages.js` (کارت QR/کد پیوند و راهنمای اسکن) | ❌ **صفحهٔ انتشار**، نه فایل — و آن انتشار اصلاً APK نداشت |
| `https://tailscale.com/download/windows` در `server/tunnel.js` و `client/pages.js` («دسترسی از بیرون») | ❌ صفحهٔ معرفی، نه نصب‌کننده |

ریشهٔ مورد اندروید: APK مدرسه فقط با Secretهای جداگانهٔ `PAYESH_KEYSTORE_*` امضا می‌شد که هرگز تنظیم نشده بودند (در مخزن فقط `PAYESH_OWNER_*` هست). پس `school-native-publish` همیشه «android: BLOCKED» می‌نوشت و APK منتشر نمی‌شد. به‌روزرسانی درون‌برنامه‌ای اندروید اپ مدرسه (`app_update.dart` ← `native-continuous/payesh-native.apk`) هم به همین دلیل ۴۰۴ می‌گرفت.

## ۲. تغییرات

| فایل | تغییر |
|---|---|
| `.github/workflows/native-client.yml` | اگر `PAYESH_KEYSTORE_*` نباشد، APK/AAB مدرسه با **همان کلید مالک** (`PAYESH_OWNER_*`، ردیف ۶۱) امضا می‌شود؛ خروجی `source=owner/school`. APK مدرسه هرگز با کلید دیگری منتشر نشده، پس چرخش امضاکننده‌ای نیست؛ درگاه `PAYESH_SIGNING_ROTATION_APPROVED` برای کلید جداگانه می‌ماند. کنترل شکست بستهٔ Gradle دست‌نخورده است. |
| `.github/workflows/school-native-publish.yml` | APK بخش اجباری انتشار است: بدون APK امضاشده با کلید انتشار ⇒ `exit 1` (شکست بسته). مجموعهٔ `ALLOWED` بی‌شرط شامل `payesh-native.apk` است؛ متن انتشار به‌روز شد. |
| `README.md` ، `site/index.html` ، `client/install.html` | دکمهٔ اندروید ⇐ `releases/download/native-continuous/payesh-native.apk` |
| `client/pages.js` | ثابت‌های `NATIVE_APK_URL` و `TAILSCALE_WIN_URL`؛ هر دو کارت QR مستقیم به APK |
| `server/tunnel.js` | `download` ⇐ `https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe` (همیشه به آخرین نصب‌کنندهٔ ویندوز هدایت می‌شود) |
| `tests/direct-links-161.js` (تازه) | DL-01..05 (+ DL-06 زنده با `PAYESH_LIVE_LINKS=1`) |
| `tests/landing-114.js` | LP-04: APK الزامی، پیوند صفحهٔ انتشار ممنوع؛ دو جهش تازه (۲۰/۲۰ قرمز) |
| `tests/run.js` ، `.github/workflows/installables.yml` ، `package.json` (`check`) | اجرای آزمون تازه |
| `docs/cloud/125-installables.json` ، `docs/cloud/76-android-release.md` | توضیح جایگزین کلید مالک و شکست بسته |
| نسخه | 0.9.15 (`package.json`، `package-lock.json`، `RELEASE_NOTES.json`) |

## ۳. آزمون تازه — `tests/direct-links-161.js`

- **DL-01** هر پیوند انتشار `releases/download/<کانال>/<فایل>` است — نه `releases`، `releases/tag/…` یا `releases/latest` (۲۴۴ فایل، ۲۲ پیوند).
- **DL-02** هر `<کانال>/<فایل>` در مجموعهٔ `ALLOWED` ناشرِ همان کانال است (school-native-publish / owner-native-publish / build.yml).
- **DL-03** هیچ «صفحهٔ دانلود» شخص ثالث (tailscale.com/download، nodejs.org/…/download، …).
- **DL-04** APK مدرسه در README، سایت، صفحهٔ نصب و کارت QR مستقیم پیوند شده و ناشر بدون آن شکست می‌خورد.
- **DL-05** ۹ جهش، همه قرمز.
- **DL-06** (زنده) هر پیوند پاسخ فایل می‌دهد، نه HTML.

## ۴. نتایج

| مورد | نتیجه |
|---|---|
| کامیت‌ها (main، بدون PR) | `fdcc0cb` تغییرات · `b6eb711` فایل‌های انتشار 0.9.15 · `ed270ea` فهرست مجاز D‑35 · شاهد `e1a5a18` |
| `npm test` | **۱۴۵/۱۴۵** (EVIDENCE-OK، EVIDENCE-SHA-89-OK) |
| آزمون‌های هدف | DIRECT-LINKS-161-OK (۵ بررسی، ۹/۹ جهش) · LANDING-114-OK (۲۰/۲۰ جهش) · INSTALLABLES-125-OK · NATIVE-RELEASE-76-77-OK · packaging.test.js پنل مالک |
| CI روی `e1a5a18` | build-and-release، native-client، api-contract، school-webview-control، installables-registry — همه سبز |
| انتشار | school-native-publish و owner-native-publish روی `74aa5e1` سبز؛ `school-native-status.json`: run 166، «payesh-native.apk — release-signed with the owner key (row 61)» |
| بررسی زنده (DL-06) | ۱۰/۱۰ پیوند فایل برمی‌گردانند؛ `payesh-native.apk` ← 200، `application/vnd.android.package-archive`، ۶۵٫۵ MB |

## ۵. باقی‌مانده

- نصب‌کننده‌های ویندوز هنوز امضای کد (Authenticode) ندارند؛ دانلود مستقیم است، ولی SmartScreen هشدار می‌دهد (Secretهای `PAYESH_WIN_PFX_*` / `PAYESH_OWNER_WIN_PFX_*` با مالک).
- پیوندهای قدیمی در گزارش‌ها و شاهدهای تاریخی (`docs/cloud/reports/**`) عمداً دست‌نخورده‌اند؛ سند تاریخی‌اند، نه پیوند دانلود.
