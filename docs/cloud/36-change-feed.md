# change-feed هر مدرسه در PostgreSQL — ردیف ۳۶

| | |
|---|---|
| ردیف | ۳۶ (فاز ۳ — نمونهٔ فنی) · پیش‌نیاز ردیف ۳۷ (Gateway) |
| وضعیت | **اجراشده و آزموده روی PostgreSQL واقعی** (۱۷ بررسی، ۰ ناموفق) |
| کد محصول | `server/tenancy.js` — جدول `product_change_feed` + `listFeed` / `pruneFeed` / `compressFeed` / `feedStats` |
| آزمون | `tests/change-feed-pg.js` (۱۵ سنجه) + عدم رگرسیون `tests/tenancy-pg.js` (۱۲/۱۲) |
| شاهد | `docs/cloud/reports/evidence/change-feed-36.txt` (پایان: `CHANGE-FEED-36-OK`) |
| اجرا | `npm run test:feed` (اگر PostgreSQL نباشد ⇒ `BLOCKED` با کد ۳، نه PASS) |

---

## ۱. چرا seq و نه `updated_at`

مهر زمانی برای صفحه‌بندی کافی نیست: دو تغییر در یک میلی‌ثانیه با شرط `updated_at > since` از دست می‌روند — همان نقصی که در شبیه‌سازی سال تحصیلی **W‑04** اندازه‌گیری شد (۵۰۰ ردیف گم‌شده از ۳٬۵۰۰ ردیف هم‌مهر). راه‌حل: یک توالی عددی صعودی.

```sql
seq        bigserial      -- سراسری؛ برای هر مدرسه ⇒ زیرتوالی اکیداً صعودی
tenant_id  uuid           -- مستأجر فقط از زمینهٔ تراکنش (RLS)
collection text
record_id  bigint
op         text CHECK (op IN ('put','del'))
version    integer        -- همان نسخهٔ OCC ردیف اصلی
data       jsonb          -- payload کامل (برای tombstone: null)
data_gz    bytea          -- همان payload پس از فشرده‌سازی (data خالی می‌شود)
at         timestamptz    -- زمان ثبت تغییر (برای retention)
```

**اتمی‌بودن:** درج feed داخل همان تراکنشِ نوشتن ردیف اصلی انجام می‌شود (`upsertProduct` / `deleteProduct`). پس یا هر دو ثبت می‌شوند یا هیچ‌کدام؛ تعارض OCC (۴۰۹) هیچ ردیف feed نمی‌سازد — سنجهٔ CF‑13.

## ۲. pull = یک کوئری ایندکس‌دار

```sql
select seq, collection, record_id, op, version, data, data_gz, at
  from product_change_feed
 where seq > $1 and ($2::text is null or collection = $2)
 order by seq asc
 limit $3 + 1        -- +1 برای تشخیص more
```

ایندکس `product_change_feed_cursor_idx (tenant_id, seq)` دقیقاً همین مسیر را پوشش می‌دهد؛ برنامهٔ اجرا در CF‑09 با `EXPLAIN` بررسی می‌شود (Index Scan روی همان ایندکس).

**بدون حفره/تکرار:** سنجهٔ CF‑05 کل feed را با `limit=7` صفحه‌به‌صفحه می‌خواند و مجموعهٔ seqها را با خواندن یک‌باره مقایسه می‌کند — برابری کامل. CF‑03 هم ۲۵ نوشتن پشت‌سرهم می‌سازد و صعود اکید و یکتایی seq را می‌سنجد (span پیوسته ۱..۲۶).

## ۳. retention و فشرده‌سازی (سیاست تعریف‌شده)

| سیاست | مقدار پیش‌فرض | کران | چه می‌کند |
|---|---|---|---|
| پنجرهٔ نگه‌داری (`keep_days`) | **۳۰ روز** | ۱..۳۶۵ | `POST /product/feed/prune` — حذف ردیف‌های قدیمی‌تر، فقط همان مستأجر (RLS) |
| پنجرهٔ داغ (`hot_days`) | **۷ روز** | ۱..۳۶۵ | `POST /product/feed/compress` — gzip روی payload ردیف‌های قدیمی و خالی‌کردن `jsonb` |

- فشرده‌سازی **شفاف** است: `feedPayload()` هنگام خواندن، `data_gz` را باز می‌کند؛ کلاینت همان شیء قبلی را می‌بیند (سنجهٔ CF‑15: برابری کامل payload و idempotent بودن اجرای دوم).
- اندازهٔ واقعی در اجرای شاهد: `ratio=0.091` و `saved=2012B` روی یک payload نمونه — یعنی ~۹٪ حجم اولیه.
- هر دو عملیات **فقط با نقش مدیر** مجازند؛ دبیر ۴۰۳ می‌گیرد (CF‑11، CF‑16) و مقدار خارج از کران ۴۰۰ (CF‑12، CF‑16).

## ۴. RLS

- `ENABLE` + `FORCE ROW LEVEL SECURITY` روی جدول، سیاست `product_change_feed_isolation` با `tenant_id = current_setting('app.tenant_id', true)::uuid` و `WITH CHECK` همان.
- نقش runtime مالک جدول نیست و `BYPASSRLS` ندارد؛ بدون زمینهٔ مستأجر **صفر ردیف** می‌بیند (CF‑08) — نه همهٔ ردیف‌ها.
- feed مستأجر B هیچ ردیفی از A نشان نمی‌دهد و برعکس (CF‑07)؛ retention مستأجر A ردیف‌های B را پاک نمی‌کند (CF‑10).

## ۵. اندازه‌گیری اجرای واقعی (این مخزن)

```
CF-01  جدول + RLS اجباری + سیاست + ۳ ایندکس              ✓
CF-03  ۲۵ نوشتن ⇒ seq صعودی و بی‌هم‌مهر                    rows=26 unique=26 span=1..26
CF-05  صفحه‌بندی limit=7 ⇒ هر ردیف دقیقاً یک‌بار           pages=3 rows=27
CF-10  retention ⇒ فقط ردیف‌های کهنهٔ همان مستأجر          deleted=3 legacyB=2
CF-14  ۳۰۰ نوشتن                                        ≈۳۴۸ write/s روی یک میزبان محلی
CF-15  فشرده‌سازی                                        ratio=0.091 saved=2012B
F05    عدم رگرسیون tenancy/RLS                            pass=12 fail=0
CHANGE-FEED-36-OK
```

> محدودیت صریح: این اعداد روی **یک میزبان محلی** و PostgreSQL جاسازی‌شده اندازه‌گیری شده‌اند؛ ادعای مقیاس تولیدی یا HA نیست. عملیات `mirror`/`outbox` ابری همچنان خاموش است و ارقام صف/تأخیر در ردیف ۴۹ سنجیده می‌شوند.

## ۶. مسیرهای محصول

| متد | مسیر | نقش | خروجی |
|---|---|---|---|
| GET | `/api/cloud/tenancy/product/feed?since_seq=&limit=&collection=` | هر نقش مجاز | `rows[]`, `count`, `more`, `next_seq`, `limits` |
| GET | `/api/cloud/tenancy/product/feed/stats` | هر نقش | `count`, `max_seq`, `oldest_at` (بدون افشای داده) |
| POST | `/api/cloud/tenancy/product/feed/prune` | مدیر | `deleted`, `remaining`, `keep_days` |
| POST | `/api/cloud/tenancy/product/feed/compress` | مدیر | `compressed`, `raw_bytes`, `gz_bytes`, `ratio` |

`tenant_id` هرگز از query/body/هدر خوانده نمی‌شود؛ فقط از توکن امضاشدهٔ نشست (همان قاعدهٔ ردیف ۲۶).
