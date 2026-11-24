# گزارش ۱۰ — CI پایگاه داده روی PostgreSQL واقعی

> **وضعیت پس از push (2026-11-24 10:02Z):** push انجام شد؛ main = `92466ec0`؛ CI سبز (#862)؛ build 200 و سرور 0.9.32 منتشر شدند و هش/امضا با شواهد برابر است. نصب روی کاربران هنوز دیده نشده؛ آزمون بی‌صدای گوشی BLOCKED (گوشی وصل نبود)؛ serv00 مرکزی به‌روز نشد. جزئیات: گزارش ۰۱ §۷.

SHA: `bd447dc4` (+ D-01/D-02). بازپخش: `scripts/ci-pg-suite.py` همهٔ گام‌های کار `native-contract` در `.github/workflows/api-contract.yml` را **عیناً** اجرا می‌کند (همان env و همان فرمان). `scripts/ci-native-it.py` همین کار را برای کارهای یکپارچگیِ `native-client.yml` می‌کند.
**PostgreSQL آزمایشگاه: 17.11 (سرور واقعی و جداگانه، `127.0.0.1:5432`). CI از postgres:16 استفاده می‌کند.**

## ۱. تفکیک صریح: Postgres واقعی / تعبیه‌شده / شبیه‌سازی
| دسته | معنی | آزمون‌ها |
|---|---|---|
| **[R-PG] PostgreSQL واقعی** | فرایند سرور Postgres 17.11، اتصال TCP، نقش‌ها و RLS واقعی | DB-02، DB-03، DB-05، DB-06، DB-07، DB-08 (بخش PG)، DB-11..21، NI-14، NI-15، و بخش پایگاه دادهٔ DB-09/DB-10 |
| **بار شبیه‌سازی‌شده روی Postgres واقعی** | پایگاه داده واقعی است ولی **کلاینت‌ها ساختگی‌اند** (CI خودش برچسب «[S] simulated» زده است) | DB-09 (بار Gateway)، DB-10 (بار مسیر مستقیم) — گزارش ۱۱ |
| **[EMB] PGlite تعبیه‌شده** | Postgres کامپایل‌شده به WASM درون همان پردازه. **سرور Postgres واقعی نیست** | NI-18 ‏(`OWNER-NATIVE-IT-OK steps=14 db=pglite`) |
| **[SIM] بردار / شبیه‌ساز** | بدون پایگاه دادهٔ واقعی: بردارهای قرارداد، شبیه‌ساز S3 و سرور مرکزی | DB-01 (بردارهای مشترک)، DB-04 (واحد)، CH-04/05، sim-s3 روی PC (گزارش ۱۲) |
| **SQLite (پایگاه دادهٔ واقعی محصول مدرسه)** | سرور مدرسه با SQLite کار می‌کند. این شبیه‌سازی نیست، موتور تولید همین است | REG-01/02، ID65، FIX-D04-D05، NI-10..12، همهٔ آزمون‌های گوشی و ویندوز |

## ۲. گام‌های CI ‏native-contract روی PG17 — همه EXIT 0
| ID | گام CI | سطح | شاهد |
|---|---|---|---|
| DB-01 | بردارهای مشترک (تعارض، دامنه، نسخه) | [SIM] | `evidence/DB-01.log` |
| DB-02 | همهٔ endpointهای بومی در برابر JSON Schema (سرور مدرسه + Gateway/Directory روی PG) | [R-PG] | `evidence/DB-02.log` |
| DB-03 | Directory: جابه‌جایی مدرسه بین دو cell هنگام نوشتن کلاینت | [R-PG] | `evidence/DB-03.log` |
| DB-04 | ابزار انتقال ردیف ۵۴ (واحد) | [SIM] | `evidence/DB-04.log` |
| DB-05 | سخت‌سازی Gateway: SIGTERM drain، ‏429 Retry-After، kill-switch | [R-PG] | `evidence/DB-05.log` |
| DB-06 | آفلاین ۱۱۹: Gateway از drop شدن DB جان سالم به در می‌برد؛ outbox دقیقاً یک بار؛ جهش‌ها | [R-PG] | `evidence/DB-06.log` |
| DB-07 | ‏`tenancy.migrate` اتمی زیر نوشتن زنده، کنترل منفی | [R-PG] | `evidence/DB-07.log` |
| DB-08 | رمزنگاری فیلدی AEAD (SQLite + PostgreSQL)، آزمون منفی dump | [R-PG] | `evidence/DB-08.log` |
| DB-09 | بار Gateway (ردیف ۸۲) | بار شبیه‌سازی‌شده + [R-PG] | `evidence/DB-09.log` |
| DB-10 | بار مسیر مستقیم (ردیف ۸۲) — ‏۱۰/۱۰ پس از D-01 | بار شبیه‌سازی‌شده + [R-PG] | `evidence/DB-10.log` |
| DB-11 | گیت migration: ‏expand ← migrate ← contract | [R-PG] | `evidence/DB-11.log` |
| DB-12 | هویت مسیر مستقیم + RLS | [R-PG] | `evidence/DB-12.log` |
| DB-13 | رمزنگاری سمت دستگاه، اعطای کلید، چرخش | [R-PG] | `evidence/DB-13.log` |
| DB-14 | همگام‌سازی مستقیم در SQL | [R-PG] | `evidence/DB-14.log` |
| DB-15 | pentest ‏RLS | [R-PG] | `evidence/DB-15.log` |
| DB-16 | تله‌متری بدون PII | [R-PG] | `evidence/DB-16.log` |
| DB-17 | حذف و خروجی حریم خصوصی | [R-PG] | `evidence/DB-17.log` |
| DB-18 | انتقال مستقیم | [R-PG] | `evidence/DB-18.log` |
| DB-19 | تمرین پشتیبان‌گیری و بازیابی (cluster تازه) | [R-PG] | `evidence/DB-19.log` |
| DB-20 | ساخت مدرسه ← tenant ← مدیر اولیه؛ بین مدرسه‌ها ۰ ردیف | [R-PG] | `evidence/DB-20.log` |
| DB-21 | بستهٔ Gateway ← استخراج ← selfcheck روی دو مدرسه | [R-PG] | `evidence/DB-21.log` |

- «skipped» در لاگ‌ها: همهٔ موارد درون توضیح آزمون‌های PASS هستند یا `skipped=0`. هیچ رد شدن واقعی وجود ندارد.
- کارهای یکپارچگی native-client روی PG17: ‏NI-14 ‏(`GATEWAY-REAL-OK`، موج‌های ۱ تا ۵ با کنترل منفی) و NI-15 ‏(`OFFLINE-119 … data_loss=0 duplicate=0`). گزارش ۰۷.
- **پس از اصلاح D-04/D-05:** کل همین مجموعه روی همان PG17 دوباره اجرا شد (DBR-01..21) ← `evidence/DBR-*.log`.

## ۳. یافته: D-01 (آزمون، Low) — فقط روی PG17 دیده شد
`tests/load-82-direct.js` ‏LDD-09 فقط متن طرح اجرای PG16 (`$N`) را می‌پذیرفت. PG17 همان طرح را `(InitPlan N).colM` می‌نویسد. regex حالا هر دو شکل را می‌پذیرد، کنترل منفی هم هر دو را پوشش می‌دهد، و DB-10 ‏۱۰/۱۰ روی PG17 است. **CI روی PG16 این را نمی‌دید.** پیشنهاد: در CI یک ماتریس PG16/17 اضافه شود.

## ۴. محدودیت
- نسخهٔ PG آزمایشگاه (17) با CI (16) فرق دارد. سبز بودن روی 17 سبز بودن روی 16 را اثبات نمی‌کند. (روی 16، CI ‏#199 در `api-contract` سبز بود.)
- RAM ‏sandbox ‏۲ GB و ۲ هسته است. اعداد کارایی DB-09/10 به سخت‌افزار تولید تعمیم داده نمی‌شوند.
