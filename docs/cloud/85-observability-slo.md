# ردیف ۸۵: مشاهده‌پذیری سمت سرور (لاگ ساختاری، متریک Prometheus، هشدار و SLO)

> تاریخ: ۱۴۰۵/۰۸/۲۰ (2026-11-11) · مجری: ARENA (کد و آزمون) · OWNER: محل pager و on-call (D-42)

## ۱. چه چیزی تحویل شد

| بخش | فایل | توضیح |
|---|---|---|
| لاگ JSON بدون PII | `server/logger.js` | هر خط یک شیء JSON است: `ts, level, service, event, request_id, school_id, …` |
| شناسهٔ درخواست | `server/index.js`، `server/gateway.js` | هر پاسخ سرآیند `X-Request-Id` دارد. شناسهٔ مبهمِ فرستاده‌شده تکرار می‌شود، و شناسهٔ PII‌مانند (تلفن، کد ملی، ایمیل) یا بدشکل با UUID تازه جایگزین می‌شود. |
| شناسهٔ مدرسه | همان دو فایل | سرور مدرسه: `school_id` کاربرِ احرازشده (برای درخواست بی‌نشست `null`). Gateway: `tid` از توکن امضاشده. |
| متریک | `server/metrics.js` → `/metrics` | هیستوگرام `payesh_http_request_duration_seconds` و سنجه‌های SLO: `payesh_slo_availability_burn_rate`، `payesh_slo_latency_burn_rate`، `payesh_slo_latency_good_ratio`، `payesh_http_latency_p95_seconds`، `payesh_slo_objective_*` |
| تعریف SLO (کد) | `server/slo.js` | تنها منبع اهداف |
| قواعد هشدار (کد) | `deploy/monitoring/slo-85.yml` | با گرامر ردیف ۴۹، و ارزیابی با `tools/alerts-49.mjs` |
| دروازهٔ منفی | `tools/log-pii-scan-85.mjs` | نشت PII در لاگ ⇒ خروج ۱ (قرمز) |
| آزمون | `tests/observability-85.js` (`npm run test:observability85`) | ۱۲ بررسی (OB85-01..12) شامل سه mutant |

## ۲. قاعدهٔ «بدون PII»: دو لایهٔ مستقل

1. **فهرست مجاز کلیدها (`SAFE_KEYS`).** هر فیلدی که نامش در فهرست نیست حذف می‌شود و فقط شمارش آن (`dropped_keys`) ثبت می‌شود. یعنی `body`، `name`، `phone` یا `national_code` هیچ‌وقت به stdout نمی‌رسند. این لایه برای چیزهایی مثل نام شخص لازم است که هیچ regexی آن‌ها را تشخیص نمی‌دهد.
2. **پاک‌سازی مقدار.** هر رشته‌ای که از لایهٔ اول عبور کند (مسیر، پیام خطا، detail) از نظر این الگوها بررسی می‌شود: کد ملی ۱۰ رقمی، موبایل، ایمیل، Bearer، JWT، رازهای hex/base64 بلند، و جفت‌های `password=…`/`phone=…`. ارقام فارسی و عربی پیش از بررسی به ASCII برگردانده می‌شوند.

موارد زیر **اصلاً** لاگ نمی‌شوند: بدنهٔ درخواست، query string، سرآیندهای Authorization و User-Agent، و stack trace. در خطای ۵۰۰ فقط پیامِ پاک‌سازی‌شده ثبت می‌شود.

`PAYESH_LOG=0` فقط info/warn را خاموش می‌کند. خطاها همیشه به stderr می‌روند.

## ۳. اهداف SLO (از `server/slo.js`)

| SLO | هدف | دوره | SLI |
|---|---|---|---|
| availability | 99.5٪ | ۳۰ روز | پاسخ‌های غیر 5xx تقسیم بر کل |
| latency | 95٪ | ۳۰ روز | پاسخ‌های ≤ ۱۰۰۰ ms تقسیم بر کل |

**نرخ مصرف بودجه (burn rate)** = سهم بد در پنجرهٔ ۵ دقیقه ÷ (۱ − هدف). عدد ۱ یعنی کل بودجه دقیقاً در طول دوره مصرف می‌شود.

<a id="fast-burn"></a>
### مصرف سریع (critical، `for: 2m`): burn > 14.4

۱۴٫۴ برابر یعنی ۲٪ بودجهٔ ۳۰ روزه در یک ساعت مصرف می‌شود. اقدام فوری:
- `/readyz` را بررسی کنید.
- آخرین لاگ‌های `level:"error"` را بخوانید و آن‌ها را با `request_id` به خط‌های `event:"http"` وصل کنید.
- اگر انتشار تازه‌ای انجام شده، به نسخهٔ قبل برگردید.

<a id="slow-burn"></a>
### مصرف کند (warning، `for: 30m`): burn > 6

۶ برابر یعنی ۵٪ بودجه در ۶ ساعت. این مورد را در ساعات کاری رسیدگی کنید. روند `payesh_http_requests_total{class="5xx"}` و `payesh_slo_latency_good_ratio` را ببینید.

<a id="p95"></a>
### صدک ۹۵ (warning، `for: 10m`): p95 > 1.5s

این هشدار SLO نیست و فقط برای سلامت عمومی است. دنبالهٔ کندی را نشان می‌دهد حتی وقتی ترکیب درخواست‌ها آن را در نسبت SLI پنهان کند. اقدام: `payesh_pg_pool_wait_seconds`، `payesh_disk_free_pct` و اندازهٔ صف همگام‌سازی را بررسی کنید.

> محدودیت آگاهانه: ارزیاب محلی فقط `<metric> <op> <number>` را می‌شناسد و پنجره‌اش ۵ دقیقه است. برای همین، جفت پنجرهٔ بلند و کوتاهِ SRE Workbook با «پنجرهٔ کوتاه + `for:`» تقریب زده شده است. فایل برای Prometheus واقعی هم معتبر است.

### سنجه‌های پایش زندهٔ پنل مالک (ردیف ۱۳۰)

`payesh_net_rx_bytes_total` و `payesh_net_tx_bytes_total` بایت واقعی سوکت‌های HTTP هستند (در keep-alive فقط اختلاف شمرده می‌شود). `payesh_cpu_usage_pct` درصد CPU میزبان از scrape قبلی است. `payesh_memory_used_pct`، `payesh_cpu_cores` و `payesh_process_resident_bytes` هم اضافه شدند. داشبورد پنل مالک اگر Endpoint ‎`/metrics` ثبت شده باشد، این‌ها را هر ۵ ثانیه می‌خواند (ADR 126 §۱۴). شاهد: OB85-13.

## ۴. شواهد و اجرا

- `npm run test:observability85` در CI (`build.yml`، دروازهٔ ردیف ۸۵) اجرا می‌شود.
- شاهد: `docs/cloud/reports/evidence/observability-85.txt`.
- آزمون منفی: لاگ واقعی سرور با PII کاشته‌شده، کلید ناشناخته یا بدون `school_id` ⇒ دروازه قرمز می‌شود. سه mutant از `server/logger.js` (پاک‌سازی خاموش، فهرست مجاز خاموش، بررسی request-id خاموش) همگی گرفته می‌شوند.

## ۵. خارج از محدودهٔ ARENA (OWNER)

- مقصد واقعی pager و چرخهٔ on-call (D-42). ارزیاب از `ALERT_WEBHOOK` پشتیبانی می‌کند، اما تعیین مقصد و مالک انسانی با مالک است.
- نگه‌داری و چرخش لاگ در میزبان تولید (journald، فایل یا جمع‌آوری مرکزی).
