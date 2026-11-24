# گزارش ۰۴ — نصب و ارتقای اندروید

دستگاه: POCO X7 Pro ‏(2412DPC0AG، `rodin_global`)، Android 16 / HyperOS، سریال `NVCYXCF6YHKNFIJF`. SHA اپ: `bd447dc4`.

| ID | سطح | آزمون | نتیجه | شاهد |
|---|---|---|---|---|
| INS-01 | [R-DEV] | نصب owner-lab-17601 (HyperOS «نصب از راه USB» با لمس تأیید از adb UI) | PASS | `evidence/pc/android/INS-01-owner-install.txt`، `INS-owner17601.txt` |
| INS-02 | [R-DEV] | نصب school-lab-17601 | PASS | `evidence/pc/android/INS-school17601.txt` |
| AND-UPG-01 | [R-DEV] | ارتقای درجا 0.2.17601 ← 0.2.17602 (`adb install -r`) با دادهٔ موجود | PASS: ‏`Performing Streamed Install Success`؛ پس از ارتقا نشست حفظ شد («کاربر: دبیر آزمایشگاه · نقش: دبیر»)، صف ۰، دادهٔ حضور سر جایش | `evidence/pc/android/INS-school17602-upgrade.txt`، `DRV-AND-UPG-01.txt` |
| AND-CRASH-01 | [R-DEV] | بافرهای crash/main/system/events و dropbox برای UIDهای آزمایشگاه | PASS: ‏`FATAL EXCEPTION / ANR … 0`، dropbox ‏0 | `evidence/pc/android/AND-CRASH-NET-01.txt` |
| R175-VERIFY | [R-DEV] | آیا اپ‌های **واقعی** کاربر آخرین نسخهٔ منتشرشده را دارند؟ (sha256 فایل `base.apk` نصب‌شده در برابر APK منتشرشده) | PASS: مدرسه 0.2.198، sha256 ‏`3ee1e1ef…87f4` (31,145,327 B) = منتشرشده؛ مالک 1.1.198، ‏`e0a44543…39f2` (27,698,457 B) = منتشرشده | `evidence/R175-phone-vs-published.txt` |
| R175-SILENT | [R-DEV] | به‌روزرسانی بی‌صدای اندروید ۱۲+ از 198 به نسخهٔ بعد | **BLOCKED**: نسخهٔ بعدی‌ای منتشر نشده است. ‏#199 با workflow_dispatch اجرا شد و دروازهٔ `event == 'push'` کارهای انتشار را رد کرد. فقط مجوز `UPDATE_PACKAGES_WITHOUT_USER_ACTION granted=true` روی گوشی تأیید شده است | گزارش ۰۳ §۴، Notion ردیف ۱۷۵ (Review) |

## یافته‌ها
- HyperOS برای نصب از USB تأیید روی صفحه می‌خواهد (رفتار سیستم‌عامل است، نه نقص).
- ارتقا امضای یکسان (debug) را حفظ کرد. ارتقا با امضای متفاوت آزموده نشد (BLOCKED: کلید release بیرون از آزمایشگاه است).
- اپ‌های واقعی کاربر در کل آزمایشگاه دست‌نخورده ماندند. نسخه و `lastUpdate` قبل و بعد یکسان است (2026-11-23 23:13).
- Play Protect: هشداری ثبت نشد، ولی هدفمند هم آزموده نشد (اسکن دستی انجام نشد).
