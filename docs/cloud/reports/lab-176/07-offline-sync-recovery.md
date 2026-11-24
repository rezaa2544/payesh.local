# گزارش ۰۷ — آفلاین، همگام‌سازی و بازیابی

SHA: `bd447dc4` (اجراهای NI-* روی همان SHA به‌همراه اصلاح D-04/D-05).

## ۱. روی دستگاه واقعی — [R-DEV] در برابر [R-SRV] آزمایشگاهی
| ID | سناریو | نتیجه | شاهد |
|---|---|---|---|
| AND-OFF-01/02 | ثبت آفلاین، بستن اجباری، بازکردن | PASS: صف ۲ ماند | گزارش ۰۵ |
| AND-REBOOT-01 | ری‌بوت گوشی با صف پر | PASS: صف ۲ ماند | `evidence/pc/android/AND-REBOOT-01.txt` |
| AND-SYNC-01 | برگشت شبکه | PASS: سرور ۲ رکورد، تکراری ۰؛ تکرار همگام‌سازی idempotent بود | `evidence/pc/android/DRV-AND-SYNC-01*.txt` |
| AND-REC-01 | کرش سرور هنگام آنلاین بودن | PASS: صف ← پس از برگشت «متصل · صف ۰» | `evidence/pc/android/AND-REC-01.txt` |
| WIN-OFF-01 | ویندوز: قطع relay ← تأخیر دانش‌آموز ← ثبت | PASS: «۱ تغییر در صف مانده» | گزارش ۰۸ |
| WIN-REC-01 | برگشت relay بدون اتصال دستی | PASS: همگام‌سازی خودکار **۱۲ ثانیه** بعد؛ همان id، تکراری ۰ | `evidence/pc/win/WIN-REC-01-pull.txt` |
| X-DEV-01 | دیده‌شدن ثبت گوشی روی ویندوز | PASS: کارت کلاس «ثبت شده» و جمع برگه = سرور (حاضر ۲) | گزارش ۰۸ |

## ۲. کلاینت Dart واقعی در برابر سرور واقعی — sandbox
| ID | سطح | سناریو (گام CI ‏native-client، عین YAML) | نتیجه | شاهد |
|---|---|---|---|---|
| NI-10 | [R-SRV] | ‏payesh_sync ⇄ `server/index.js`: push آفلاین فقط یک بار اعمال می‌شود، uid تکراری، pull به SQLite، توکن بد ← صف، کشتن سرور ← op می‌ماند ← ری‌استارت ← دقیقاً یک بار | PASS ‏`SYNC-REAL-SERVER-OK` (+8، بدون رد شده) | `evidence/NI-10.log` |
| NI-11 | [R-SRV] | حالت LAN با سرور headless: ورود، صف آفلاین، چرخش توکن و ابطال replay | PASS ‏`LAN-REAL-SERVER-OK` (‏`NATIVE-LAN-IT passed=7 negative_controls=12`) | `evidence/NI-11.log` |
| NI-12 | [R-SRV] | صفحه‌های مدیریت مدرسه: نوشتن آفلاین ← صف ← اعمال؛ ردهای سمت سرور به‌عنوان کنترل منفی | PASS ‏`ADMIN-REAL-SERVER-OK tests=34` | `evidence/NI-12.log` |
| NI-15 | [R-SRV]+[R-PG] | **۲۰ سناریوی آفلاین** روی مسیر پیش‌فرض داده: خطای TCP واقعی جلوی Gateway و PostgreSQL، SIGKILL و ری‌استارت Gateway، کشتن پردازهٔ اپ وسط درخواست | PASS ‏`OFFLINE-119 scenarios=20 data_loss=0 duplicate=0 order_violations=0 cross_tenant=0` | `evidence/NI-15.log` |
| CH-01 | [R-SRV] | آشوب (row 47) | PASS ‏`CHAOS-47-OK` | `evidence/CH-01-chaos47.log` |
| CH-02 | [R-SRV] | تعارض (row 41) | PASS ‏`CONFLICT-41-OK` | `evidence/CH-02-conflict41.log` |
| CH-03 | [R-SRV] | ری‌استارت سرور: داده می‌ماند، uid تکراری دوباره اعمال نمی‌شود، EADDRINUSE رخ نمی‌دهد | PASS ‏۸/۰ | `evidence/CH-03-restart.log` |
| CH-04/05 | [SIM] بردار | قرارداد همگام‌سازی سرور و کلاینت | PASS ‏۲۲/۰ و ۸/۰ | `evidence/CH-04-contract.log`، `CH-05-contract-client.log` |
| DB-06 | [R-PG] | Gateway از drop شدن DB جان سالم به در می‌برد؛ outbox گذرا/FIFO/دقیقاً یک بار، با جهش‌ها | PASS | `evidence/DB-06.log` |

## ۳. یافته‌ها
- در هیچ سناریویی، نه روی دستگاه واقعی نه در sandbox، داده گم یا تکراری نشد.
- **۱۱۵ آزمون یکپارچگی** در اجرای واحدِ `payesh_sync` عمداً رد می‌شوند (به `PAYESH_SERVER_IT`، `GW_IT` و `OFFLINE_IT` نیاز دارند). همهٔ آن‌ها در NI-10..15 با سرور و Postgres واقعی اجرا شدند و هیچ‌کدام رد نشد. CI همین را با `grep '~[0-9]+'` تضمین می‌کند.
- محدودیت: قطع شبکه روی دستگاه واقعی با قطع `adb reverse` یا relay شبیه‌سازی شد، نه با قطع واقعی Wi-Fi مدرسه.
