# ردیف ۸۶: مهاجرت و ارتقای نسخهٔ اسکیمای پایگاه‌دادهٔ مرکزی (expand → migrate → contract)

> تاریخ: ۱۴۰۵/۰۸/۲۰ (2026-11-11) · مجری: ARENA · وابسته به ردیف ۶۷ (Gateway بی‌حالت + drain)

## ۱. ابزار

| بخش | فایل |
|---|---|
| موتور مهاجرت | `server/migrator.js` |
| CLI | `tools/migrate-86.mjs` (`lint`, `status`, `up`, `rollback --to`, `set-client-floor`) |
| مهاجرت‌های محصول | `db/migrations/central/` (اکنون `0001_baseline` که طرح idempotent موجود `server/tenancy.js` را «می‌پذیرد») |
| مشق نمونه | `db/fixtures/migrations-86/`: تغییر نام `phone` به `mobile` در ۴ گام |
| آزمون | `tests/migrations-86.js` (`npm run test:migrations86`)، روی PostgreSQL واقعی |
| CI | `api-contract.yml`، گام «Migrations gate (row 86)» روی سرویس `postgres:16` با `MG86_REQUIRE_PG=1` |

اتصال: `PAYESH_MIGRATE_URL` (یا `PAYESH_PG_ADMIN`)، با نقش مدیر یا مالک جدول‌ها.

## ۲. قالب فایل

```
NNNN_slug.up.sql     -- phase: expand|migrate|contract
                     -- transaction: false            (برای CONCURRENTLY)
                     -- batch: true                   (migrate: تکرار تا ۰ ردیف)
                     -- requires_client_floor: X.Y.Z  (فقط contract)
NNNN_slug.down.sql   برای expand و migrate الزامی است. contract برگشت‌ناپذیر است.
NNNN_slug.js         مهاجرت JS: { phase, up(client), down?(client) }
```

دفتر ثبت مهاجرت‌ها `payesh_schema_migrations (track, id, phase, checksum, applied_at, duration_ms, rows)` است. هر پوشه یک `track` دارد که به‌طور پیش‌فرض نام پوشه است.

## ۳. سه مرحله و قاعدهٔ هر کدام

1. **expand (افزایشی):** ستون nullable، جدول تازه، ایندکس `CONCURRENTLY` و تریگر همگام‌ساز. کد N-1 بدون تغییر کار می‌کند.
2. **migrate (جابه‌جایی داده):** backfill دسته‌ای با `LIMIT`. هر دسته یک تراکنش کوتاه است، پس قفل طولانی ساخته نمی‌شود.
3. **contract (حذف):** فقط با `--allow-contract`، و فقط وقتی «کف نسخهٔ کلاینت» ثبت‌شده (`set-client-floor`) دست‌کم برابر `requires_client_floor` باشد. یعنی پیش از حذف ستون، کلاینت N-1 کنار گذاشته شده است.

**lint، پیش از هر اتصالی (رد ⇒ هیچ تغییری در DB):** این موارد در expand و migrate ممنوع‌اند:
- `DROP TABLE/COLUMN/SCHEMA`، `TRUNCATE`، `RENAME`
- `ALTER … TYPE`، `SET NOT NULL`، و `ADD COLUMN … NOT NULL` بدون `DEFAULT`
- `DELETE/UPDATE` بدون `WHERE`
- `CREATE INDEX` بدون `CONCURRENTLY` روی جدولی که از قبل وجود دارد، و `DROP INDEX`

علاوه بر این، `CONCURRENTLY` باید با `transaction: false` بیاید و هر down الزامی باید موجود باشد.

**حفاظ‌های زمان اجرا:**
- checksum فایلِ اعمال‌شده عوض شده باشد ⇒ رد.
- شناسهٔ اعمال‌شده‌ای که در این نسخه نیست (DB جلوتر از کد است) ⇒ رد.
- ترتیب با حفره ⇒ رد.
- قفل advisory: مهاجر دوم ⇒ `locked`.
- `lock_timeout` (پیش‌فرض ۳ ثانیه) و `statement_timeout`: مهاجرتی که قفل نگیرد زود کنار می‌کشد و صف درخواست‌ها پشت آن نمی‌ماند.

## ۴. روال انتشار بدون downtime (با Gateway ردیف ۶۷)

1. `node tools/migrate-86.mjs lint` (در CI هم اجرا می‌شود).
2. `up` روی expand و migrate، پیش از استقرار نسخهٔ N. نسخهٔ N-1 همچنان سرویس می‌دهد، که آزمون MG-06 و MG-07 با نویسندهٔ هم‌زمان N-1 و خطای صفر آن را نشان می‌دهند.
3. استقرار N به‌صورت rolling. Gateway با drain (ردیف ۶۷) درخواست‌های در جریان را تمام می‌کند.
4. وقتی هیچ کلاینت قدیمی‌تری مجاز نیست: `set-client-floor X.Y.Z`. این گام **OWNER** است.
5. `up --allow-contract`.
6. اگر پیش از contract مشکلی پیش آمد: `rollback --to <id>`. آزمون MG-09 نشان می‌دهد پس از برگشت، N-1 همهٔ داده را می‌خواند، از جمله ردیف‌هایی که N نوشته بود.

## ۵. شواهد

`docs/cloud/reports/evidence/migrations-86.txt` شامل این‌هاست:
- خروجی ۱۶ بررسی (MG-01..16)
- شمار ردیف‌ها و دسته‌های backfill
- زمان کنار کشیدن در برابر قفل
- سه mutant کشته‌شده از `server/migrator.js`

## ۶. خارج از محدودهٔ ARENA (OWNER)

- اجرای `up` روی پایگاه‌دادهٔ تولید و انتخاب پنجرهٔ انتشار.
- تصمیم و ثبت `set-client-floor`، یعنی کنار گذاشتن نسخه‌های قدیمی کلاینت در گیت نسخه (ردیف ۶۴/۶۷).
