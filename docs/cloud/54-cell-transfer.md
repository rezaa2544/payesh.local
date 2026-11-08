# ردیف ۵۴ — مهاجرت یکسان چند cell و انتقال مدرسه بین دیتابیس‌ها

**وضعیت:** Done (ابزار + آزمون + شاهد روی دو دیتابیس مستقل). اجرای چند میزبان/provider واقعی = **OWNER** (۴۶/۵۶).
**شاهد خام:** [`reports/evidence/cell-transfer-54.txt`](reports/evidence/cell-transfer-54.txt) —
بازتولید: `bash docs/cloud/reports/evidence/run-54-cell-transfer.sh`

## دروازهٔ فعال‌سازی (شرط صریح ردیف)

ابزار تا وقتی `PAYESH_CELL_TRANSFER_ENABLED=1` نباشد کار نمی‌کند و با کد ۳ خارج می‌شود
(`CT-01`). این همان شرط AC است: «ابزار فقط وقتی فعال شود که ردیف ۴۶ نیاز به دیتابیس دوم را
نشان داد.» شاهد ردیف ۴۶ هنوز نیاز قطعی را نشان نداده (سقف در pool بود، نه در تعداد DB)، پس
مسیر **بسته** است و باز کردنش تصمیم OWNER است.

## ۱) migration یکسان روی همهٔ cellها

`node tools/cell-transfer-54.mjs --cells <url1>,<url2>,...`

- هر cell با **همان** `tenancy.migrate` مهاجرت می‌شود (هیچ SQL دستی دوم).
- اثر انگشت اسکیما از `information_schema.columns` + `pg_policies` (ستون‌ها، نوع، nullable،
  default، سیاست‌های RLS) گرفته می‌شود؛ همهٔ cellها باید sha256 یکسان بدهند.
- idempotency: migration دو بار اجرا و اثر انگشت بار دوم مقایسه می‌شود.

نتیجهٔ شاهد: دو cell، **۲۴ ستون و ۴ سیاست** یکسان، `fingerprint=32cfe5e4…046`، `idempotent=true` → `CELL-MIGRATE-54-OK`.

## ۲) انتقال مدرسه با توقف نوشتن

`--transfer --tenant <uuid> --from <url> --to <url>`

| گام | چه می‌کند |
|---|---|
| schema | اثر انگشت مبدأ و مقصد باید یکی باشد، وگرنه انتقال انجام نمی‌شود |
| freeze | یک ردیف در `payesh_transfer_freeze` (مبدأ)؛ Gateway روی هر push `409 write_frozen` می‌دهد |
| copy | `product_records`، `product_change_feed`، `product_ops`، `gateway_quota` با `on conflict do nothing` |
| reconcile | سه‌لایه (زیر) |
| rollback | در شکست تطبیق، همان batch در مقصد حذف می‌شود |

**بدون lock نشستی** (`CT-08`): توقف نوشتن یک ردیف داده است، نه `advisory_lock`/`FOR UPDATE`؛
پس با transaction pooling ردیف ۴۵ سازگار است.

## ۳) reconciliation سه‌لایه

| لایه | چه چیزی مقایسه می‌شود | چه خطایی را می‌گیرد |
|---|---|---|
| ۱ | تعداد ردیف هر جدول | انتقال ناقص/دوباره |
| ۲ | sha256 محتوای مرتب‌شدهٔ هر جدول | تعداد برابر ولی محتوای متفاوت |
| ۳ | `seq` (change-feed) / `version` رکورد به رکورد | جا افتادن یک رکورد در میانه |

هر سه لایه در آزمون با **کنترل منفی** سنجیده شده‌اند (`CT-03`…`CT-06`): اختلاف تعداد، اختلاف
محتوا با تعداد برابر، و اختلاف seq هرکدام واقعاً قرمز می‌شوند.

## ۴) اندازه‌گیری واقعی (دو دیتابیس مستقل روی PostgreSQL ۱۶٫۲)

| گام | نتیجه |
|---|---|
| migration هر دو cell | اثر انگشت یکسان، idempotent → `CELL-MIGRATE-54-OK` |
| push قبل از توقف | `200` · `cell_a records=5 feed=5` |
| push در حین توقف | **`409` `write_frozen`** |
| انتقال | `product_records=5 feed=5 ops=5 quota=1` · سه لایه `ok=true` · `CELL-TRANSFER-54-OK` |
| rollback همان batch | `removed=16` · `cell_b records=0 feed=0` |
| رگرسیون | `۹۶ موفق · ۰ ناموفق` |

## آنچه ادعا نمی‌شود

- دو «cell» روی یک PostgreSQL محلی‌اند (دو دیتابیس مستقل با نقش اجرایی جدا). cell روی
  میزبان/provider دیگر و آزمون تأخیر شبکه = OWNER (۴۶/۵۶).
- انتقال به‌صورت «کپی + توقف نوشتن» انجام می‌شود، نه logical replication پیوسته؛ برای مهاجرت
  یک مدرسه (نه failover) کافی است، اما پنجرهٔ توقف با حجم داده بزرگ می‌شود.
- حجم داده در شاهد کوچک است (۵ رکورد)؛ RTO/RPO این مسیر اندازه‌گیری نشده — ردیف ۵۰.
