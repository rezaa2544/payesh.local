# ردیف ۴۹ — پایش و هشدار (probe + متریک + قاعدهٔ هشدار + تحویل)

| | |
|---|---|
| ردیف | ۴۹ (P1، فاز ۴ — Operations) · پیش‌نیاز: ۳۷ (Gateway) |
| وضعیت | **اجراشده — «آماده، اثبات‌نشده» برای Pager بیرونی (OWNER، ردیف ۵۸)** |
| آزمون | `npm run test:observability49` ⇒ `OB checks=19 pass=19 fail=0` |
| دروازه | `node tools/alerts-49.mjs --check-rules` ⇒ `ALERTS-49-CHECK rules=10 groups=2` |
| شاهد خام | `docs/cloud/reports/evidence/observability-49.txt` (بازتولید: `bash docs/cloud/reports/evidence/run-49-observability.sh`) |
| نقطهٔ اتصال Pager | `ALERT_WEBHOOK=<url>` — تا تنظیم نشود، تحویل فقط در فایل ثبت می‌شود |

> ادعای این ردیف: **زنجیرهٔ هشدار از خرابی واقعی تا تحویل HTTP کار می‌کند.**
> ادعای اثبات‌نشده: **هیچ Pager بیرونی وصل نیست و on-call تعیین نشده** — آن
> بخش مالک انسانی دارد (ردیف ۵۸) و تا آن زمان وضعیت «آماده، اثبات‌نشده» است.

---

## ۱) سه قطعه، سه اثبات

| قطعه | کد | چطور اثبات می‌شود |
|---|---|---|
| پروب | `/healthz` (زنده‌بودن، بدون وابستگی) · `/readyz` (آمادگی: DB + نوشتن داده + فضای دیسک) — مدرسه و Gateway هر دو | OB-01..OB-03، OB-11، OB-19 |
| متریک | `/metrics` قالب متن Prometheus 0.0.4، از وضعیت واقعی نه از شمارندهٔ ساختگی | OB-04..OB-09، بخش ۳ شاهد |
| هشدار | `deploy/monitoring/alerts-49.yml` + ارزیاب `tools/alerts-49.mjs` با `for:`/تکرار/resolve و تحویل HTTP | OB-12..OB-18 |

`/api/readyz` قدیمی (ردیف ۲۹) دست‌نخورده مانده و همان عدد را می‌دهد؛ محاسبهٔ
آمادگی از مسیر readyz به یک تابع مشترک (`readinessChecks()`) منتقل شد تا
«دو عدد متناقض» ممکن نباشد. OB-11 همین را قفل می‌کند.

## ۲) قرارداد متریک (بدون برچسب هویتی)

| سنجه | معنی | منبع واقعی |
|---|---|---|
| `payesh_up` | نمونه زنده است | ثابت ۱ در پاسخ موفق |
| `payesh_uptime_seconds` | عمر فرایند | `process.uptime()` |
| `payesh_ready` | آمادگی واقعی | همان تابع readyz |
| `payesh_db_up` / `payesh_data_writable` | خواندن DB / نوشتن داده | `store.get()` و `fs.access(W_OK)` |
| `payesh_disk_free_pct` | فضای آزاد | `statfs` |
| `payesh_backup_age_seconds` / `payesh_mirror_age_seconds` | عمر پشتیبان/آینه | mtime جدیدترین فایل |
| `payesh_sync_lag_seconds` | بیشترین فاصلهٔ «آخرین تماس دستگاه» تا الان | جدول `devices.last_seen_at` |
| `payesh_sync_devices_total` | دستگاه‌های فعال (بدون ابطال) | همان جدول |
| `payesh_sync_queue_depth` | ردیف‌های منتظر در صندوقچهٔ ماندگار | شمارش `outbox/pending/*.json` |
| `payesh_http_requests_total{class}` | شمارش پاسخ‌ها بر کلاس | `res.on('finish')` روی هر پاسخ واقعی |
| `payesh_http_error_ratio` | سهم ۵xx در ۵ دقیقهٔ گذشته | همان رویدادها |
| `payesh_pg_pool_wait_seconds` | زمان گرفتن اتصال از pool | اندازه‌گیری acquire در scrape (Gateway) |
| `payesh_pg_pool_total/idle/waiting` | وضعیت pool | شمارنده‌های driver (Gateway) |
| `payesh_db_connections` | اتصال‌های فعال PostgreSQL | `pg_stat_activity` (Gateway) |

**چرا هیچ برچسب هویتی نیست:** متریک معمولاً بی‌محافظ می‌ماند (Prometheus
مستقیم scrape می‌کند). اگر `student_id` یا `device_id` برچسب می‌شد، کارت
شناسایی دانش‌آموزان به یک endpoint بی‌احراز هویت منتقل می‌شد. OB-07 همین را
قفل می‌کند: متن scrape نباید توکن/رمز/مسیر داده/`@` داشته باشد.
اگر خواستید scrape محدود شود: `PAYESH_METRICS_TOKEN` را تنظیم کنید.

## ۳) آستانه‌ها و دلیل عددی

| هشدار | آستانه | `for` | چرا این عدد |
|---|---|---|---|
| <a id="payeshdown"></a>`PayeshDown` | `payesh_up < 1` | ۱m | یک scrape ناموفق نویز است؛ ۶۰ ثانیه یعنی چهار scrape پیاپی |
| <a id="payeshnotready"></a>`PayeshNotReady` | `payesh_ready < 1` | ۲m | write/DB موقتی (قفل WAL، دیسک پر لحظه‌ای) نباید صفحه بزند |
| <a id="payeshsynclag"></a>`PayeshSyncLag` | `> 900s` | ۱۰m | روز مدرسه با وقفهٔ ۱۵ دقیقه‌ای همگام‌سازی جلو می‌رود |
| <a id="payeshqueuebacklog"></a>`PayeshQueueBacklog` | `> 200` | ۱۵m | ۲۰۰ ردیف ≈ یک روز کاری یک مدرسهٔ متوسط |
| <a id="payeshhttperrors"></a>`PayeshHttpErrors` | `> 0.05` | ۵m | ۵٪ خطای سرور را کاربر به‌صورت «سیستم کار نمی‌کند» می‌بیند |
| <a id="payeshdbdown"></a>`PayeshDbDown` | `payesh_db_up < 1` | ۲m | جدا از not-ready تا علت از قبل مشخص باشد |
| <a id="payeshdisklow"></a>`PayeshDiskLow` | `< 10%` | ۱۵m | آستانهٔ readyz روی ۵٪ است؛ ۱۰٪ هشدار زودهنگام |
| <a id="payeshbackupstale"></a>`PayeshBackupStale` | `> 25h` | ۶۰m | پشتیبان روزانهٔ ۲۴ساعته + یک ساعت ارفاق |
| <a id="payeshpoolwait"></a>`PayeshPoolWait` | `> 1s` | ۵m | انتظار بیش از یک ثانیه برای اتصال = اشباع pool |
| <a id="payeshdbconnectionshigh"></a>`PayeshDbConnectionsHigh` | `> 80` | ۵m | سقف عملی PostgreSQL کوچک ۱۰۰؛ ۸۰ هشدار پیش از برخورد |

## ۴) چرخهٔ هشدار (و چرا «هشدار طوفانی» نداریم)

```
نقض آستانه → pending (تا رسیدن for) → firing (یک اعلان) →
   تکرار در پنجرهٔ --repeat (پیش‌فرض ۳۰۰s) → suppressed (بدون رکورد تازه) →
   بازگشت به وضعیت سالم → resolved
```

- `for:` بدون ورودیِ همیشگی (state) بی‌معناست؛ ارزیاب state را در فایل JSON
  نگه می‌دارد (`--state`) — OB-14 نشان می‌دهد pending در t0 و firing در t0+2m.
- هر رویداد در sink (JSONL) با مقدار، آستانه، severity و runbook ثبت می‌شود؛
  OB-14 محتوای رکورد را بررسی می‌کند، نه فقط چاپ ترمینال را.
- OB-16 قفل می‌کند که تکرار ۴۰ ثانیه‌ای داخل پنجرهٔ ۶۰۰ ثانیه‌ای **هیچ رکورد
  تازه‌ای** نمی‌سازد (یک اعلان، صفر طوفان).
- OB-18 کنترل منفی است: قاعدهٔ خارج از گرامر (`rate(...[5m])`) و متریک غایب
  هر دو باید ارزیاب را با کد ۲ بشکنند — وگرنه دروازهٔ سبزِ بی‌معنا.

## ۵) گرامر محدودِ عبارت — و چرا

عبارت‌ها فقط `<metric> <op> <number>` هستند (`>`, `<`, `>=`, `<=`, `==`).
دلیل: همین فایل را Prometheus هم می‌خواند؛ اگر عبارتی بنویسیم که Prometheus
می‌فهمد ولی ارزیاب ما نمی‌تواند بسنجد، در آزمون سبز می‌ماند و در خرابی واقعی
هیچ‌کس نمی‌داند. OB-12 تضمین می‌کند هر قاعدهٔ فایل، در همین گرامر تجزیه شود
و `severity` و `runbook` و `for>0` داشته باشد.

## ۶) آنچه این ردیف ادعا **نمی‌کند**

- **هیچ Pager بیرونی وصل نیست** (PagerDuty/تلگرام/SMS) و **on-call تعیین
  نشده**. OB-17 فقط زنجیره را روی یک گیرندهٔ HTTP محلی اثبات می‌کند:
  اگر `ALERT_WEBHOOK` تنظیم شود، ارسال به همان مسیر انجام می‌شود.
- هشدارِ تحویل‌نشده **بی‌صدا نمی‌ماند**: ارزیاب با کد ۳ می‌شکند
  (`ALERTS-49-DELIVERY-FAILED`). این یعنی خرابیِ خودِ مسیر هشدار هم دیده می‌شود.
- هیچ جعبه‌ابزار آمادهٔ Grafana/Alertmanager مستقر نشده است؛ قاعده‌ها
  استاندارد Prometheus‌اند تا هر جا مستقر شوند، اما استقرارشان OWNER است.
