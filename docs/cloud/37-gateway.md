# Gateway نازک و بی‌حالت برای sync — ردیف ۳۷

| | |
|---|---|
| ردیف | ۳۷ (فاز ۳ — نمونهٔ فنی) · وابسته به ردیف ۳۶ (change-feed) |
| وضعیت | **اجراشده و آزموده روی PostgreSQL واقعی** (۱۹ بررسی Gateway + ۱۲/۱۲ عدم رگرسیون) |
| کد محصول | `server/gateway.js` (فرایند جدا) + `server/tenancy.js` (`applyOps` / `takeQuota` / `readiness` / جدول‌های `product_ops`, `gateway_quota`) |
| آزمون | `tests/gateway-pg.js` — GW‑01..GW‑19 روی ۲ نمونهٔ Gateway + ۲ نمونهٔ کم‌سهمیه + ۱ نمونهٔ بی‌DB |
| شاهد | `docs/cloud/reports/evidence/gateway-37.txt` (پایان: `GATEWAY-37-OK`) |
| اجرا | `npm run test:gateway` (اگر PostgreSQL جاسازی‌شده نباشد ⇒ `BLOCKED` با کد ۳، نه PASS) |

---

## ۱. چرا «نازک و بی‌حالت»

Gateway فقط سه کار می‌کند: **احراز** (توکن امضاشدهٔ نشست)، **زمینهٔ مستأجر** (فقط از توکن، داخل تراکنش) و **اعمال سقف‌ها**. هیچ داده‌ای در حافظهٔ نمونه نگه نمی‌دارد، پس هر نمونه می‌تواند هر درخواستی را در هر لحظه سرو کند و پشت load-balancer هر دو نمونه هم‌ارزند:

- **idempotency در دیتابیس**: جدول `product_ops (tenant_id, uid)` — تکرار همان عملیات، حتی روی **نمونهٔ دیگر**، `duplicate` است و feed رشد نمی‌کند (GW‑07، GW‑08).
- **سهمیهٔ نرخ در دیتابیس**: `gateway_quota (tenant_id, device_id, window_start) → hits` — پنجره مشترک بین نمونه‌ها؛ ۴۲۹ روی هر دو نمونه یکسان اعمال می‌شود (GW‑14).
- **صفحه‌بندی بی‌حالت**: نشانگر، خودِ `seq` است؛ پیمایش بین دو نمونه هر ردیف را دقیقاً یک‌بار می‌دهد (GW‑09).

```
کلاینت → هر نمونه Gateway → BEGIN; set_config('app.tenant_id', …, true); <RLS>; COMMIT
                              └─ product_change_feed (pull) · product_ops + جداول محصول (push)
```

## ۲. مسیرها

| متد | مسیر | کار |
|---|---|---|
| GET | `/healthz` | زنده‌بودن **فرایند** فقط: `200 {ok, instance, uptime_s}` — بدون لمس DB |
| GET | `/readyz` | آمادگی **واقعی**: DB + بررسی این‌که `set_config(..., true)` در تراکنش محدود می‌ماند و پس از commit نشت نمی‌کند ⇒ `200 {ready, tenant_scoped:true, leaked_after_commit:false}`؛ وگرنه `503 {error:{code:'not_configured'|'db_unavailable'}}` |
| GET | `/api/gw/v1/pull?since_seq=&limit=&collection=` | خواندن change-feed همان مستأجر، `limit` تا `GW_PULL_MAX` کلمپ می‌شود (`clamped_limit` + `limits` در پاسخ) |
| POST | `/api/gw/v1/push` | بدنه `{ops:[{uid, collection, id, type:'put'|'del', data, base_version}]}` ⇒ `{applied, duplicates, conflicts, counts}` |

- `tenant_id` هرگز از query، بدنه یا هدر خوانده نمی‌شود. سنجهٔ GW‑05: هدر `X-Tenant` و `tenant_id` در بدنه بی‌اثرند (`A=1 B=0`).
- تفکیک liveness/readiness واقعی است: نمونهٔ بدون DB باید `healthz=200` و `readyz=503` بدهد (GW‑03).

## ۳. سقف‌ها (پیش از لمس دیتابیس)

| سقف | مقدار پیش‌فرض | پاسخ در تخلف |
|---|---|---|
| اندازهٔ بدنه (`GW_MAX_BODY`) | ۱MiB | `413 body_too_large` |
| تعداد عملیات هر push (`MAX_OPS_PER_REQUEST`) | ۲۰۰ | `413 too_many_ops` |
| payload هر عملیات (`MAX_OP_BYTES`) | ۶۴KiB | `413 op_too_large` |
| ردیف‌های pull (`GW_PULL_MAX`) | ۱۰۰۰ | کلمپ (نه خطا) + `clamped_limit` |
| سهمیهٔ نرخ (`GW_QUOTA_MAX` / `GW_QUOTA_WINDOW_SEC`) | ۱۲۰ در ۶۰ ثانیه | `429 rate_limited` + `retry_after_ms` + هدرهای `x-ratelimit-limit/remaining/reset` |

**اتمی‌بودن دسته:** یک عملیات نامعتبر (`bad_uid`, `bad_id`, `unknown_collection`, `op_too_large`) کل دسته را رد می‌کند و **هیچ** ردیفی نوشته نمی‌شود (GW‑16). هر دسته، یک تراکنش با یک زمینهٔ مستأجر است (GW‑19 مهاجرت: `statements=59`, `tables=2`).

**تعارض OCC** روی مسیر Gateway خطا نیست: پاسخ `200` با `conflicts` است و ردیف feed نمی‌سازد (GW‑15) — همان قاعدهٔ ردیف ۲۶/۳۶.

> نکتهٔ عملیاتی که در آزمون به آن برخوردیم: در HTTP/1.1 قطع سوکت هنگام بدنهٔ بزرگ به «خطای شبکه» در کلاینت تبدیل می‌شود، نه `413`. Gateway بدنهٔ اضافی را تخلیه می‌کند و `413` واقعی با `connection: close` می‌دهد (GW‑11).

## ۴. احراز

- بدنه/هدر توکن با همان `verifyToken` ردیف ۲۶/۲۸ بررسی می‌شود (HMAC، انقضا، نوع نشست).
- بدون توکن `401 unauthorized`، توکن دست‌کاری‌شده `401 unauthorized`، منقضی `401 token_expired` (GW‑04).
- توکنِ نامعتبر **پیش از** هیچ کوئری‌ای رد می‌شود؛ نمونهٔ بدون تنظیم (`not_configured`) هم مسیرهای داده را سرو نمی‌کند (GW‑03).

## ۵. اندازه‌گیری اجرای واقعی (این مخزن)

```
GW-01  دو نمونهٔ مستقل                                     gw-5641 & gw-5642
GW-02  /readyz واقعی: DB + set_config تراکنشی             tenant_scoped=yes leaked=no
GW-07  تکرار همان دستهٔ ۵تایی                             duplicates=5 feed=6
GW-08  تکرار روی نمونهٔ دیگر                              cross-instance duplicate=yes
GW-09  پیمایش limit=2 بین دو نمونه                        هر ردیف دقیقاً یک‌بار
GW-13  limit > GW_PULL_MAX                                clamped=50
GW-14  سهمیه بین نمونه‌ها مشترک                            429 روی هر دو + hits در DB
GW-18  ۳۰۰ عملیات در دسته‌های ۵۰تایی                       300 ops · 406ms ≈739 op/s
GW-19  مهاجرت Gateway                                     statements=59 tables=2 RLS force=on
F05    عدم رگرسیون tenancy/RLS (پایگاه‌دادهٔ تازه)          pass=12 fail=0
GATEWAY-37-OK
```

> محدودیت صریح: اعداد روی **یک میزبان محلی** با PostgreSQL جاسازی‌شده و دو فرایند Node اندازه‌گیری شده‌اند؛ ادعای مقیاس تولیدی، HA یا تأخیر شبکه نیست. این ارقام برای ظرفیت‌سنجی ردیف ۴۹ قابل استناد نیستند.

## ۶. اجرا و پیکربندی

```bash
PGURL=postgres://… GW_SECRET=<≥۱۶ کاراکتر> PORT=5660 node server/gateway.js
```

`GW_SECRET` (یا `PAYESH_TENANCY_SECRET`)، `GW_MAX_BODY`، `GW_QUOTA_MAX`، `GW_QUOTA_WINDOW_SEC`، `GW_PULL_MAX`، `GW_INSTANCE`، `HOST` قابل تنظیم‌اند. بدون `PGURL` یا با راز کوتاه، نمونه بالا می‌آید ولی `not_configured` است — عمداً: `healthz` سبز می‌ماند تا probe‌ها فرایند را نکشند، اما `readyz` و مسیرهای داده ۵۰۳ می‌دهند.

### ۶٫۱ سخت‌سازی عملیاتی (ردیف ۶۷)

- **تخلیهٔ نرم با SIGTERM**: پذیرش اتصال تازه قطع، `readyz` ← `503 draining`، درخواست‌های در جریان کامل و commit می‌شوند، سپس poolها بسته و خروج با کد ۰. پس از `GW_DRAIN_TIMEOUT_MS` (پیش‌فرض ۲۵۰۰۰) سوکت‌های باقی‌مانده قطع و خروج با کد ۲.
- **شناسهٔ درخواست**: هر پاسخ `X-Request-Id` دارد (شناسهٔ خوش‌فرم فراخوان بازتاب می‌شود، وگرنه UUID تازه). لاگ دسترسی JSON یک خط برای هر درخواست، بدون query string و بدون توکن؛ `GW_ACCESS_LOG=0` آن را خاموش می‌کند.
- **۴۲۹ با Retry-After**: سهمیهٔ هر (مستأجر، دستگاه) و سقف اختیاری کل مستأجر `GW_TENANT_QUOTA_MAX`؛ بدنه `scope: device|tenant` دارد.
- **کلید قطع ویژگی**: `PAYESH_FEATURE_KILL` (مثلاً `push` یا `pull@<0.2.0`) ← `503 feature_disabled` + `Retry-After` پیش از احراز و دیتابیس؛ کلید قطع نسخهٔ کلاینت همان `PAYESH_CLIENT_KILL` است (۴۲۶).
- قرارداد کامل: `docs/cloud/contracts/native-api-v1.md` §۶ · آزمون: `tests/gateway-67.js`.

## ۷. آنچه در این ردیف اثبات نشد

- مقیاس چند ماشینی واقعی، load-balancer و TLS — در محیط محلی قابل سنجش نیست (ردیف ۴۹).
- مقاومت در برابر خطای شبکه/تأخیر واقعی موبایل؛ فقط سقف‌ها و بی‌حالتی منطقی آزموده شد.
- وضعیت امنیتی سامانه همچنان **UNKNOWN** است؛ این ردیف یک جزء را می‌سنجد، نه کل سطح حمله را.
