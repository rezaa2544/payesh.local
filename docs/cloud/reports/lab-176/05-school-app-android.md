# گزارش ۰۵ — اپ مدرسه روی اندروید

اپ: school-lab-17601/17602 (SHA `bd447dc4`) روی POCO X7 Pro / Android 16 **[R-DEV]**، در برابر سرور مدرسهٔ آزمایشگاهی 0.9.31 در کانتینر روی PC **[R-SRV]** از راه `adb reverse` (بدون اینترنت؛ گزارش ۰۲).

| ID | آزمون | نتیجه | شاهد |
|---|---|---|---|
| AND-LOGIN-01 | ورود دبیر (`09000001761`) با رمز | PASS: صفحهٔ خانه باز شد؛ ‏fwd دو اتصال به school:8080 نشان داد | `evidence/pc/android/DRV-AND-LOGIN-01.txt` |
| AND-ATT-01 | ثبت حضور کلاس | PASS | `evidence/pc/android/DRV-AND-ATT-01.txt` |
| AND-OFF-01 | سرور در دسترس نیست → دانش‌آموز ۲ غایب، دانش‌آموز ۱ تأخیر | PASS: «۲ رکورد ذخیره شد» و نوار «۲ تغییر در صف» | `evidence/pc/android/DRV-AND-OFF-01.txt` |
| AND-OFF-02 | بستن اجباری و بازکردن دوباره، آفلاین | PASS: نشست ماند و صف ۲ ماند | `evidence/pc/android/DRV-AND-OFF-02-restart.txt` |
| AND-REBOOT-01 | راه‌اندازی مجدد گوشی، آفلاین | PASS: صف ۲ ماند؛ پس از ری‌بوت جداسازی دوباره اثبات شد | `evidence/pc/android/AND-REBOOT-01.txt`، `DRV-AND-REBOOT-01*.txt` |
| AND-SYNC-01 | برگشت اتصال → همگام‌سازی | PASS: صف ۰؛ سرور ۲ رکورد (id ‏…0004 غایب، …0003 تأخیر)، تکراری ۰؛ همگام‌سازی دوم باز هم ۲ رکورد (idempotent) | `evidence/pc/android/DRV-AND-SYNC-01.txt`، `DRV-AND-SYNC-01-idem.txt` |
| AND-REC-01 | توقف ناگهانی سرور (`docker stop`) هنگام آنلاین بودن → ثبت → برگشت سرور | PASS: نوار «سیستم مدرسه در دسترس نیست» ← پس از برگشت «متصل · صف ۰»؛ pull سرور ۲۰ رکورد، attendance ‏۴ | `evidence/pc/android/AND-REC-01.txt`، `DRV-AND-REC-01-after.txt` |
| AND-PERF-01 | شروع سرد و حافظه | مقدار ثبت شد (گزارش ۱۱): شروع سرد میانه ۴۳۰ ms، PSS ‏۱۶۱٫۶ MB | `evidence/pc/android/AND-PERF-01.txt` |
| AND-CRASH-01 | crash/ANR | PASS، ۰ | `evidence/pc/android/AND-CRASH-NET-01.txt` |
| FL-04 | همهٔ آزمون‌های واحد/ویجت اپ (`flutter test --coverage --concurrency=1`) | PASS: ‏`+240: All tests passed!`، پوشش ۹۰٫۷٪ | `evidence/FL-04-test-app.log`، `FL-07-coverage-check.log` |

## یافته‌ها
- **D-03 (Low):** روز حضور با تاریخ تقویم UTC محاسبه می‌شود (`attendance_controller.dart:48`). ثبت بین ۰۰:۰۰ تا ۰۳:۳۰ تهران به روز قبل می‌رود. دیده‌شده: رکورد 2026-11-23 در حالی که تاریخ گوشی ۳ آذر (2026-11-24) بود.
- **D-06 (Low):** برچسب «نسخه» در زبانهٔ سیستم وقتی آنلاین است نسخهٔ سرور (0.9.31) و وقتی آفلاین است 0.2.0 را نشان می‌دهد، در حالی که نسخهٔ نصب‌شده 0.2.17602 بود (`system_screen.dart:475`).
- مشاهده (بازتولید نشد): درست پس از ری‌استارت گوشی، با سرور قطع، یک بار «متصل» نمایش داده شد. همگام‌سازی خودکار بعدی آن را اصلاح کرد.
- اعتبار FL-04: تلاش اول با کمبود حافظهٔ sandbox کشته شد و **نامعتبر** علامت خورد (`FL-04-test-app.attempt1-INFRA-OOM.log`). نتیجهٔ بالا از اجرای دوم و تنهاست. در dmesg هیچ kill تازه‌ای نیست.
