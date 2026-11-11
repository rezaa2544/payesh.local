# ۷۶ — انتشار امضاشدهٔ Android (APK/AAB) از CI

> وضعیت: پیاده‌سازی و آزموده در CI (ردیف ۷۶). نصب روی دستگاه واقعی = **OWNER**. کلید امضا متعلق به OWNER است (ردیف ۶۱/۷۸) — این ردیف هیچ کلیدی نمی‌سازد و در مخزن هیچ کلید یا رمزی نیست.

## ۱. چه چیزی ساخته می‌شود
- workflow: `.github/workflows/native-client.yml` (job اندروید) که از `release-gate.yml` با `secrets: inherit` صدا زده می‌شود.
- خروجی: `app-release.apk`، `app-release.aab`، `SHA256SUMS-android`، `native-out/android-release-76.txt` (گزارش خام بررسی انتشار).
- `build.gradle.kts`: امضا **فقط از متغیر محیطی** (`PAYESH_KEYSTORE` = مسیر فایل موقت، `PAYESH_KEYSTORE_PASS`، `PAYESH_KEY_ALIAS`، `PAYESH_KEY_PASS`)، PKCS12، امضای v2/v3، `isDebuggable=false`.
- `AndroidManifest.xml`: مجوز `INTERNET` (manifest انتشار قبلاً آن را نداشت ⇒ اپ انتشار نمی‌توانست به سرور وصل شود).

## ۲. Secrets و Variables (تنظیم توسط OWNER)
| نام | نوع | کاربرد |
|---|---|---|
| `PAYESH_KEYSTORE_B64` | Secret | keystore (PKCS12) به base64؛ در `$RUNNER_TEMP` باز و در پایان job پاک می‌شود |
| `PAYESH_KEYSTORE_PASS` | Secret | رمز keystore |
| `PAYESH_KEY_ALIAS` | Secret | alias کلید |
| `PAYESH_KEY_PASS` | Secret | رمز کلید |
| `PAYESH_SIGNING_ROTATION_APPROVED` | Variable | باید `true` باشد تا امضای انتشار فعال شود (درگاه آگاهانهٔ OWNER، هم‌راستا با ردیف ۶۱) |
| `PAYESH_ANDROID_CERT_SHA256` | Variable (اختیاری) | پین اثرانگشت گواهی؛ اگر تنظیم شود، APK با گواهی دیگر رد می‌شود |

## ۳. دو حالت
- **rehearsal** (پیش‌فرض، بدون Secrets): ساخت با امضای debug، همهٔ بررسی‌ها اجرا می‌شود، گزارش `distributable=false`. برای PR و شاخه‌ها.
- **release**: با Secrets و Variable بالا؛ `PAYESH_NATIVE_REQUIRE_RELEASE_SIGNING=true` ⇒ اگر امضای انتشار در دسترس نباشد Gradle با `PAYESH-SIGNING-REQUIRED` می‌شکند (شکست بسته). روی برچسب `native-v*` ساخت بدون امضای انتشار **خطا** است.
- کنترل شکست بسته در هر اجرا: یک ساخت عمداً بدون Secrets با همان پرچم اجرا می‌شود و باید `SIGNING-REQUIRED-CONTROL-OK` بدهد.

## ۴. بررسی انتشار — `tools/android-release-check-76.mjs`
ورودی: خروجی خام `aapt2 dump badging`، `apksigner verify --print-certs -v`، `jarsigner -verify` و سیاست `docs/cloud/76-android-release.json`.

| شناسه | قاعده |
|---|---|
| AR-01 | package name = `ir.payesh.school.payesh_app` (سیاست) |
| AR-02 | targetSdk ≥ 36 (الزام Google Play از ۲۰۲۶-۰۸-۳۱) |
| AR-03 | minSdk ≥ 24 |
| AR-04 | `application-debuggable` نباشد |
| AR-05 | apksigner: امضای v2/v3 تأییدشده |
| AR-06 | دقیقاً یک امضاکننده |
| AR-07 | مجوزها ⊆ allowlist سیاست (`INTERNET` + مجوز داخلی AndroidX) |
| AR-08 | حالت release: امضاکننده گواهی debug نیست و در صورت تنظیم، با پین SHA-256 برابر است |
| AR-09 | AAB با `jarsigner -verify -certs` تأییدشده |

خط آخر: `ANDROID-RELEASE-76-OK … distributable=true|false` یا `ANDROID-RELEASE-76-FAIL`؛ آرگومان بد ⇒ exit 2. دروازهٔ ۶۳ (`native-gate-63`) روی همان خروجی اجرا می‌شود.

## ۵. آزمون
`node tests/android-release-76.js` — ۲۵ بررسی: AR-OK-1/2/3، **۱۶ منفی** (AR-N1..N16: targetSdk قدیمی، debuggable، گواهی debug در release، فقط v1، مجوز اضافه، پین نادرست، AAB امضانشده، آرگومان بد، دو گواهی یا پین نادرست در قالب خروجی apksigner 37…) و W-1..W-6 (سیم‌کشی workflow/Gradle: هیچ کدی پیش از `plugins {}`، رمز لیترال نیست، keystore در مخزن نیست، پاک‌کردن p12). `tools/check-android-signing-safety.cjs` هم سبز است.

## ۶. OWNER
1. ساخت/نگهداری keystore انتشار و تنظیم Secrets بالا (ردیف ۶۱ — کلید هرگز به ARENA داده نمی‌شود).
2. `PAYESH_SIGNING_ROTATION_APPROVED=true` و در صورت تمایل `PAYESH_ANDROID_CERT_SHA256`.
3. نصب APK روی دستگاه واقعی Android (۸ تا ۱۶) و ورود/همگام‌سازی — برچسب M.
