# ردیف ۱۱۹ — ۲۰ سناریوی آفلاین روی مسیر پیش‌فرض داده (Gateway)

> وضعیت: **PASS [S]** برای ۲۰ سناریو (CI/محلی، Gateway و PostgreSQL واقعی، خطای شبکهٔ واقعی روی TCP).
> **[M] هیچ‌کدام** — آزمون روی گوشی واقعی، قطع برق دستگاه و میزبان واقعی **NOT RUN** است (فهرست OWNER).
> تاریخ: ۱۴۰۵/۰۸/۲۰ · شاخه: `arena/offline-119` · قانون اساسی بند ۲۵ (فقط Gateway)، D‑28 (تعارض = بررسی انسانی)، O‑26 (اعلان با polling).

## ۱) مسیر داده‌ای که آزموده شد

```
اپ بومی (Flutter) ── SqliteOutbox (فایل SQLite، ماندگار) ── AutoSync (اجرای خودکار صف)
      │                                                         │ push/pull
      ▼                                                         ▼
 GatewaySync (پیش‌فرض، PAYESH_TRANSPORT≠direct) ──HTTP──► server/gateway.js ──► PostgreSQL (RLS، نقش runtime)
            ▲ پروکسی خطای TCP (قطع/blackhole/429/5xx/کندی)          ▲ پروکسی خطای TCP (DB down)
```

مسیر مستقیم (ردیف‌های ۱۰۶–۱۱۱) پشت `PAYESH_TRANSPORT=direct` و خاموش می‌ماند و در این ردیف تغییری نکرد.

## ۲) معیار PASS (برای هر سناریو)

بدون از دست رفتن داده · pending پس از ری‌استارت می‌ماند · بدون تکرار (فید append-only سرور: هر شناسه یک نسخه) · ترتیب حفظ ·
همگام‌سازی خودکار · تعارض برای بررسی نگه داشته می‌شود · بدون نشت بین مدرسه‌ها · وضعیت برای کاربر قابل‌دیدن · بدون طوفان تلاش مجدد.
شمارندهٔ کل در پایان اجرا چاپ و در CI گیت می‌شود:
`OFFLINE-119 scenarios=20 data_loss=0 duplicate=0 order_violations=0 cross_tenant=0`

## ۳) جدول سناریوها

| # | سناریو | آزمون | نتیجه | شاهد خام (خط PASS) |
|---|---|---|---|---|
| S01 | قطع اینترنت **قبل** از ارسال | `O119-S01` | PASS [S] | `refused=2 server_rows=0 status="آفلاین — 5 مورد در صف ارسال"` |
| S02 | **بازگشت** اینترنت → ارسال خودکار | `O119-S02` | PASS [S] | `data_loss=0 duplicate=0 order=ok rows=5` |
| S03 | قطع **حین** ارسال (وسط درخواست) | `O119-S03` | PASS [S] | `first=network … rows=5` (نوشتن ناقص صفر) |
| S04 | قطع **بعد** از ارسال (سرور اعمال کرد، پاسخ گم شد) | `O119-S04` | PASS [S] | `retry_verdicts=duplicate×5 … duplicate=0` |
| S05 | **Gateway down** (kill) و بازگشت | `O119-S05` | PASS [S] | `down=network … rows=5` |
| S06 | **DB down** (پروکسی PG رد می‌کند) | `O119-S06` | PASS [S] | `stopped={quota_unavailable} attempts=5>maxAttempts blocked=0` |
| S07 | **429** + Retry-After | `O119-S07` | PASS [S] | `stopped=rate_limited next_at≥+2000ms` |
| S08 | **5xx** (500/502/503) | `O119-S08` | PASS [S] | `4×5xx attempts=4>maxAttempts blocked=0` |
| S09 | **timeout** (blackhole) | `O119-S09` | PASS [S] | `error=timeout … rows=3` |
| S10 | **ازدحام** (لینک کند، ۳۰۰ عملیات) | `O119-S10` | PASS [S] | `batches=3 … rows=300` |
| S11 | **ری‌استارت اپ** وسط ارسال (SIGKILL پروسهٔ جدا) | `O119-S11` | PASS [S] | `killed=SIGKILL recovered=10 … duplicate=0` |
| S12 | ری‌استارت در حالت آفلاین (بستن/بازکردن فایل صف) | `O119-S12` | PASS [S] | `reopened pending=5` |
| S13 | **اجرای خودکار صف** (فقط enqueue) | `O119-S13` | PASS [S] | `phases={idle, queued, syncing}` |
| S14 | **retry عملیاتِ قبلاً اجراشده** | `O119-S14` | PASS [S] | `duplicate×5 … version=1` |
| S15 | **ترتیب وابسته** (کلاس ← برنامهٔ کلاس) | `O119-S15` | PASS [S] | `early_claimed=0 seq(class) < seq(dependent)` |
| S16 | **تعارض دو دستگاه** | `O119-S16` | PASS [S] | `review=[conflict, superseded]`، سرور v2 دستگاه ۱ |
| S17 | **نشت بین مدرسه‌ها** | `O119-S17` | PASS [S] | `leaked_a_rows=0` |
| S18 | **مجوز دادهٔ حساس** (ولی: فقط نمرهٔ فرزند خودش) | `O119-S18` | PASS [S] | `parent_grades=[2402] forbidden_requests=3 status="1 مورد نیاز به بررسی دارد"` |
| S19 | **قطع دوباره وسط همگام‌سازی** (بعد از ۲ از ۶ دسته) | `O119-S19` | PASS [S] | `first_applied=50 resent=100 (dup_verdicts=25)` |
| S20 | **بدون طوفان** (۸ دستگاه، قطع ۵ ثانیه) | `O119-S20` | PASS [S] | `attempts_during_5s_outage≈43 (8 devices)`، بازگشت = دقیقاً ۸ درخواست |

اجرای محلی (همین شاخه): `+30: All tests passed!` (۲۰ سناریو + ۱۰ آزمون AutoSync)، در ۵ اجرای پیاپی پایدار بعد از اصلاح معیار S20.

## ۴) باگ‌هایی که این آزمون‌ها پیدا کردند و اصلاح شدند

| باگ | اثر در تولید | اصلاح | آزمون منفی (با برگرداندن اصلاح قرمز می‌شود) |
|---|---|---|---|
| **Gateway با قطع اتصال PostgreSQL می‌مرد** — رویداد `error` در pool مستأجر شنونده نداشت | ری‌استارت/failover پایگاه داده ⇒ کل Gateway و همهٔ مدرسه‌ها آفلاین تا ری‌استارت دستی | `server/tenancy.js` `createPool`: شنوندهٔ `error` + شمارنده | `O119-S06` (Dart)، `OFF119-G01` (Node؛ جهش preload بدون شنونده ⇒ crash)، `run.js` ردیف ۱۱۹ |
| خطاهای گذرا (بدون شبکه/429/5xx/timeout) بعد از `maxAttempts` صف را **blocked** می‌کردند | یک قطعی طولانی ⇒ عملیات «نیاز به بررسی» بدون تقصیر کاربر، همگام‌سازی خودکار متوقف | `fail(..., transient)` در Dart و وب؛ گذرا هرگز block نمی‌کند | conformance `outbox-v1` (۲ بردار جدید)، `M-S4`، `OFF119-G03` |
| عملیات بعدی از عملیاتِ قبلیِ در backoff **جلو می‌زد** | ترتیب وابسته (کلاس قبل از برنامه) می‌شکست | سد FIFO در `claim` (Dart و وب) | conformance، `O119-S15`، `OFF119-G04` |
| AutoSync چرخهٔ «هیچ‌چیز claim نشد» را **موفقیت** حساب می‌کرد | نشان دادن «همگام/در صف» در حالی که سرور در دسترس نیست | فقط رفت‌وبرگشت واقعی شاهد دسترسی است | `auto_sync_test` (جهش `M-A1`)، `O119-S20` |
| دو ویرایش هم‌دسته از یک رکورد هر دو «conflict» می‌شدند | دو تصمیم متناقض برای یک رکورد در فهرست بررسی | اولی `conflict`، بقیه `superseded` | `O119-S16` (جهش `M-S2`) |
| timeout به «network» خلاصه می‌شد | پیام وضعیت نادقیق | دلیل `timeout` جدا ثبت می‌شود | `O119-S09` (جهش `M-S3`) |

## ۵) کنترل‌های منفی (جهش) — همه قرمز شدند و برگردانده شدند

`M-A1` چرخهٔ خالی = موفقیت · `M-A2` notifyOnline بدون spread · `M-A3` enqueue بدون زمان‌بندی · `M-A4` نادیده گرفتن backoff (طوفان) ·
`M-A5` بدون وضعیت attention · `M-S1` حذف شنوندهٔ error pool · `M-S2` حذف یکتاسازی تعارض · `M-S3` حذف دلیل timeout ·
`M-S4` گذرا هم block کند · وب: بازگرداندن `client/outbox-web.js` ⇒ ۲ بردار conformance قرمز · Node: Gateway با شنوندهٔ حذف‌شده می‌میرد (`OFF119-G01`).

## ۶) وضعیت قابل‌دیدن برای کاربر

`AutoSync.status` (Stream) و `current`: `idle` «همگام» · `syncing` «در حال همگام‌سازی…» · `queued` «N مورد در صف ارسال» ·
`offline` «آفلاین — N مورد در صف ارسال» · `attention` «N مورد نیاز به بررسی دارد»، به‌همراه `lastSuccessAt`، `nextAttemptAt`، `lastError`.
اتصال به نشان وضعیت (`StatusBadge` در payesh_ui) در صفحات بومی ردیف ۷۴ انجام می‌شود — **تا آن زمان UI بومی وضعیت را نشان نمی‌دهد** (PARTIAL).

## ۷) اجرای دوباره

```bash
# Dart (اپ بومی) — نیاز به PostgreSQL محلی/CI
cd apps/payesh/packages/payesh_sync
PAYESH_OFFLINE_IT=1 PAYESH_PG_ADMIN=postgres://postgres@127.0.0.1:5432/<db> \
PAYESH_PG_RUNTIME=postgres://payesh_runtime@127.0.0.1:5432/<db> \
dart test --reporter expanded test/offline_119_test.dart test/auto_sync_test.dart
# Node (Gateway + outbox وب)
PAYESH_PG_ADMIN=… PAYESH_PG_RUNTIME=… node tests/offline-119.js
```

CI: `native-client.yml` job `gateway-real` (گام «payesh_sync offline scenarios»، گیت: بدون skip، ۲۰ خط PASS، شمارندهٔ صفر) و
`api-contract.yml` (گام «Row 119 offline»، `OFF119_REQUIRE_PG=1`).

## ۸) NOT RUN و ریسک باقی‌مانده

- **NOT RUN [M]:** گوشی/تبلت واقعی، قطع برق یا kill توسط سیستم‌عامل، شبکهٔ همراه واقعی ایران، میزبان واقعی (ردیف ۱۱۶/۱۲۰).
- **NOT RUN:** مسیر TLS جلوی Gateway در این سناریوها (pinning جداگانه در `pinning_test`/ردیف ۷۵ آزموده شده)؛ مسیر مستقیم (Parked).
- **ریسک:** spread بازگشت فقط با Random بذرگذاری‌شده و زمان‌بندی محلی اثبات شده، نه با هزاران دستگاه واقعی؛
  اندازهٔ صف با سقف ۵۰۰۰ — پر شدن صف در قطعی بسیار طولانی `queue_full` می‌دهد و باید در UI ردیف ۷۴ نمایش داده شود.
- **ریسک:** حل تعارض خودکار نیست (D‑28)؛ فهرست بررسی (`sync_review`) تا ساخت صفحهٔ آن در ردیف ۷۴ فقط در داده وجود دارد.
- امنیت: **UNKNOWN** تا pentest انسانی (ردیف ۹۲).
