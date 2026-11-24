# گزارش ۰۴ — نصب و ارتقای اندروید

> **وضعیت پس از push (2026-11-24 10:02Z):** push انجام شد؛ main = `92466ec0`؛ CI سبز (#862)؛ build 200 و سرور 0.9.32 منتشر شدند و هش/امضا با شواهد برابر است. نصب روی کاربران هنوز دیده نشده؛ آزمون بی‌صدای گوشی BLOCKED (گوشی وصل نبود)؛ serv00 مرکزی به‌روز نشد. جزئیات: گزارش ۰۱ §۷.

دستگاه: POCO X7 Pro ‏(2412DPC0AG، `rodin_global`)، Android 16 / HyperOS، سریال `NVCYXCF6YHKNFIJF`. SHA اپ: `bd447dc4`.

| ID | سطح | آزمون | نتیجه | شاهد |
|---|---|---|---|---|
| INS-01 | [R-DEV] | نصب owner-lab-17601 (HyperOS «نصب از راه USB» با لمس تأیید از adb UI) | PASS | `evidence/pc/android/INS-01-owner-install.txt`، `INS-owner17601.txt` |
| INS-02 | [R-DEV] | نصب school-lab-17601 | PASS | `evidence/pc/android/INS-school17601.txt` |
| AND-UPG-01 | [R-DEV] | ارتقای درجا 0.2.17601 ← 0.2.17602 (`adb install -r`) با دادهٔ موجود | PASS: ‏`Performing Streamed Install Success`؛ پس از ارتقا نشست حفظ شد («کاربر: دبیر آزمایشگاه · نقش: دبیر»)، صف ۰، دادهٔ حضور سر جایش | `evidence/pc/android/INS-school17602-upgrade.txt`، `DRV-AND-UPG-01.txt` |
| AND-CRASH-01 | [R-DEV] | بافرهای crash/main/system/events و dropbox برای UIDهای آزمایشگاه | PASS: ‏`FATAL EXCEPTION / ANR … 0`، dropbox ‏0 | `evidence/pc/android/AND-CRASH-NET-01.txt` |
| R175-VERIFY | [R-DEV] | آیا اپ‌های **واقعی** کاربر آخرین نسخهٔ منتشرشده را دارند؟ (sha256 فایل `base.apk` نصب‌شده در برابر APK منتشرشده) | PASS: مدرسه 0.2.198، sha256 ‏`3ee1e1ef…87f4` (31,145,327 B) = منتشرشده؛ مالک 1.1.198، ‏`e0a44543…39f2` (27,698,457 B) = منتشرشده | `evidence/R175-phone-vs-published.txt` |
| R175-SILENT | [R-DEV] | به‌روزرسانی بی‌صدای اندروید ۱۲+ از 198 به نسخهٔ بعد | **BLOCKED** (تا پیش از push؛ وضعیت تازه در بخش «پس از push»): نسخهٔ بعدی‌ای منتشر نشده بود. ‏#199 با workflow_dispatch اجرا شد و دروازهٔ `event == 'push'` کارهای انتشار را رد کرد. فقط مجوز `UPDATE_PACKAGES_WITHOUT_USER_ACTION granted=true` روی گوشی تأیید شده است | گزارش ۰۳ §۴، Notion ردیف ۱۷۵ (Review) |

## یافته‌ها
- HyperOS برای نصب از USB تأیید روی صفحه می‌خواهد (رفتار سیستم‌عامل است، نه نقص).
- ارتقا امضای یکسان (debug) را حفظ کرد. ارتقا با امضای متفاوت آزموده نشد (BLOCKED: کلید release بیرون از آزمایشگاه است).
- اپ‌های واقعی کاربر در کل آزمایشگاه دست‌نخورده ماندند. نسخه و `lastUpdate` قبل و بعد یکسان است (2026-11-23 23:13).
- Play Protect: هشداری ثبت نشد، ولی هدفمند هم آزموده نشد (اسکن دستی انجام نشد).

## پس از push (2026-11-24 10:02Z)
| ID | سطح | آزمون | نتیجه | شاهد |
|---|---|---|---|---|
| R175-SILENT / PP-07 | [R-DEV] | به‌روزرسانی بی‌صدای 198 ← 200 روی گوشی آزمایشگاه (فقط‌خواندنی: `dumpsys package`، logcat؛ بدون پاک‌کردن داده یا حذف نصب) | **BLOCKED**: build 200 اکنون منتشر شده، ولی گوشی `NVCYXCF6YHKNFIJF` به PC وصل نبود (`adb devices` خالی؛ هیچ دستگاه ADB/USB حاضر نبود) | `raw/post-push/PP-07-phone-silent-update.txt` |
| PP-06 | [R-SRV] | آیا به‌روزرسانی خودکار کاربران شروع شده؟ | **هنوز شاهدی نیست**: شمار دانلود `payesh-native.apk` و `payesh-owner.apk` برابر ۱ است (همان دانلود راستی‌آزمایی) | `raw/post-push/PP-06-release-assets-*.txt` |

- پیش‌شرط‌های ارتقا برقرار است: امضاکنندهٔ یکسان با 198، versionCode بالاتر (مالک 100198 ← 100200)، مانیفست درست، و مجوز `UPDATE_PACKAGES_WITHOUT_USER_ACTION` روی گوشی.
- برای رفع BLOCKED: گوشی با USB وصل و قفلش باز شود، سپس فقط بررسی فقط‌خواندنی نسخه پس از اجرای عادی اپ انجام شود.
