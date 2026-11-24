# گزارش ۱۲ — آشوب و تاب‌آوری

SHA: `bd447dc4`.

| ID | سطح | آشوب تزریق‌شده | نتیجه | شاهد |
|---|---|---|---|---|
| AND-REC-01 | [R-DEV]+[R-SRV] | ‏`docker stop` سرور مدرسه وقتی گوشی آنلاین بود | PASS: صف ← برگشت ← صف ۰، دادهٔ سرور سالم | `evidence/pc/android/AND-REC-01.txt` |
| AND-REBOOT-01 | [R-DEV] | ری‌بوت گوشی با صف پر | PASS | `evidence/pc/android/AND-REBOOT-01.txt` |
| AND-OFF-02 | [R-DEV] | بستن اجباری اپ وسط صف | PASS | `evidence/pc/android/DRV-AND-OFF-02-restart.txt` |
| WIN-OFF/REC-01 | [R-DEV] | قطع و وصل relay | PASS، همگام‌سازی خودکار پس از ۱۲ s | گزارش ۰۸ |
| NI-15 | [R-SRV]+[R-PG] | خطای TCP جلوی Gateway **و** PostgreSQL، SIGKILL و ری‌استارت Gateway، کشتن پردازهٔ اپ وسط درخواست (۲۰ سناریو) | PASS: ‏`data_loss=0 duplicate=0 order_violations=0 cross_tenant=0` | `evidence/NI-15.log` |
| NI-10 | [R-SRV] | کشتن سرور ← op می‌ماند ← ری‌استارت ← دقیقاً یک بار | PASS | `evidence/NI-10.log` |
| DB-05 | [R-PG] | SIGTERM drain، ‏429 با Retry-After، kill-switch | PASS | `evidence/DB-05.log` |
| DB-06 | [R-PG] | drop شدن DB زیر Gateway | PASS | `evidence/DB-06.log` |
| DB-07 | [R-PG] | migration هم‌زمان زیر نوشتن زنده | PASS | `evidence/DB-07.log` |
| DB-19 | [R-PG] | پشتیبان‌گیری و بازیابی روی cluster تازه | PASS | `evidence/DB-19.log` |
| CH-01 | [R-SRV] | آشوب ۴۷ | PASS ‏`CHAOS-47-OK` | `evidence/CH-01-chaos47.log` |
| CH-02 | [R-SRV] | تعارض ۴۱ | PASS ‏`CONFLICT-41-OK` | `evidence/CH-02-conflict41.log` |
| CH-03 | [R-SRV] | ری‌استارت (مثل به‌روزرسانی) | PASS ‏۸/۰ | `evidence/CH-03-restart.log` |
| SEC-06 | [R-SRV] | fuzz همگرایی | PASS | `evidence/SEC-06-fuzz83.log` |
| SIM-S3 | **[SIM]** | شبیه‌سازی داکر ردیف ۱۷۳ روی PC (S3 شبیه‌سازی‌شده، سرور مرکزی شبیه‌سازی‌شده با جلوی TLS) | ‏`SIM-OK 28/28` در ۳۰۹ s؛ نسخهٔ lite هم 28/28 در ۳۱۷ s | `evidence/pc/sim-s3/`، `evidence/pc/sim-s3-lite/` |
| LAB-RECOVER-CAP-01 | [R-SRV] | کاربر مدیر روی سقف دستگاه قفل شد | PASS: مسیر نجات loopback کار کرد | `evidence/pc/LAB-RECOVER-CAP-01.txt` |

## یافته‌ها
- در هیچ تزریقی داده گم نشد، تکراری نشد و به مدرسهٔ دیگر نشت نکرد.
- SIM-S3 فقط **شبیه‌ساز** است و چیزی را دربارهٔ S3 یا سرور مرکزی واقعی اثبات نمی‌کند (serv00 در CI پیکربندی نشده و هر بار skip می‌شود؛ گزارش ۱۴).
- **ناپایداری CI (D-07، آزمون، Low):** گام `sim-173 S173-07` در build-and-release روی `bd447dc4` با `429 rate_limited` شکست خورد. علت در کد آزمون تأیید شد (`tests/sim-173.js` حدود خط ۲۲۱):
  - حلقه تا آمدن مدرسهٔ میزبانی‌شده، `/api/auth/refresh` را تا ۱۰۰ بار، هر ۱۵۰ میلی‌ثانیه صدا می‌زند.
  - هر تلاش از سهمیهٔ `rateLimit('refresh:'+ip, 60, 60_000)` در `server/index.js:657` کم می‌کند.
  - روی runner کند، بیش از ۶۰ تلاش در یک دقیقه انجام می‌شود و refresh نهایی که اثبات دارد ۴۲۹ می‌گیرد.
  - این نقص آزمون است، نه محصول: محدودکننده درست کار می‌کند. پیش از push بعدی باید پایدار شود (گزارش ۱۳).
- نقطهٔ کور: قطع برق یا پر شدن دیسک روی PC مدرسه هنگام نوشتن آزموده نشد (BLOCKED: روی دستگاه واقعی کاربر خطرناک است).
