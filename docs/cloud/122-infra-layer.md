# ردیف ۱۲۲: لایهٔ زیرساخت مستقل از provider (Control Plane)

**وضعیت:** پیاده‌سازی و آزمون [S] انجام شده است. اجرای واقعی [M] روی هاست، provider و PG مدیریت‌شده انجام نشده است (NOT RUN).

**مرجع:** صف ۸ برنامهٔ نهایی مالک و AC ردیف ۱۲۲ در Notion.

**وابستگی‌ها:**
- ردیف ۱۲۱ (migration 005 را گرفته است)
- ردیف ۱۲۳ (صفحهٔ «زیرساخت» در UI)
- ردیف ۱۲۴ (پژوهش API واقعی provider)

## ۱. چه چیزی ساخته شد

| جزء | مسیر | توضیح |
|---|---|---|
| Migration | `db/migrations/owner-panel/006_infra_registry.{up,down}.sql` | ۷ جدول با forced RLS دارد و نقش runtime روی آن‌ها فقط SELECT دارد. هر نوشتن از یکی از ۷ تابع SECURITY DEFINER می‌گذرد که همه با `require_actor` محافظت شده‌اند. |
| ProviderAdapter | `apps/owner-panel/server/infra.js` | قرارداد `describe / capabilities / capacity / usage / provision` برای host، vps، vpc، db، storage و other. **تنها adapter موجود `manual` است.** این adapter برای ظرفیت و مصرف `{value:null,label:'?'}` برمی‌گرداند و `provision()` را با `provider_not_supported` رد می‌کند. |
| Health Check محدود | `infra.checkEndpoint` | فقط یک GET یا یک اتصال TCP انجام می‌دهد، با timeout حداکثر ۱۰ ثانیه. redirect دنبال نمی‌شود، بدنهٔ پاسخ نه خوانده و نه ذخیره می‌شود و خطا فقط به‌صورت کد کوتاه ثبت می‌شود. برای جلوگیری از SSRF، آدرس‌های loopback، خصوصی، link-local، metadata (169.254.169.254) و ULA رد می‌شوند. نام DNS یک بار resolve می‌شود و اتصال به همان IP می‌رود. این محدودیت را فقط `PAYESH_INFRA_ALLOW_PRIVATE=1` روی هاست اپراتور برمی‌دارد. |
| API | `apps/owner-panel/server/platform-api.js` و `openapi.json` | `GET /infra` · `POST /infra/{providers,services,endpoints,metrics}` · `POST /infra/endpoints/{id}/check` · `GET/POST /infra/changes` · `POST /infra/changes/{id}/approve` |
| آزمون | `apps/owner-panel/tests/infra-registry.test.js` | روی PGlite با migrationهای 001..006 و API واقعی با نقش runtime اجرا می‌شود. checker اسکریپتی است و واحدهای `infra.js` با سوکت‌های محلی آزموده می‌شوند. |

## ۲. کنترل‌ها و نگاشت به AC

1. **ProviderAdapter (host/vps/vpc/db):** قرارداد با `assertAdapter` اعمال می‌شود. adapter ناقص یا با kind ناشناخته رد می‌شود.
2. **ثبت دستی:**
   - `api_mode` فقط `manual` است و `api` پاسخ `501 provider_api_not_implemented` می‌گیرد.
   - عددی با `source=provider_api` هم در API (501) و هم در دیتابیس (42501) رد می‌شود.
3. **Credential هرگز در UI، Log یا Repo نیست.** روش انتخاب‌شده **ارجاع به Secret** است:
   - بدنه فقط `credential_ref: "secret:NAME"` را می‌پذیرد. هر کلید خام (`password`، `api_key`، `token`، `secret`، `connection_string` و …) با `400 credentials_not_accepted` رد می‌شود.
   - ارجاعی غیر از الگوی `secret:NAME` با `400 credential_must_be_reference` رد می‌شود و CHECK دیتابیس هم همین قاعده را تکرار می‌کند.
   - endpoint با `user:password@` هم در API (400) و هم در دیتابیس (CHECK) رد می‌شود.
   - پاسخ‌ها فقط `credential: reference|none` و نام ارجاع را برمی‌گردانند. آزمون یک مقدار canary را در env می‌گذارد و ثابت می‌کند که در خروجی `/infra`، در audit و در ورودی checker دیده نمی‌شود.
4. **عملیات پرخطر = تأیید مالک + Audit.** این عملیات عبارت‌اند از غیرفعال یا فعال‌کردن provider، تغییر مرجع credential و غیرفعال‌کردن endpoint.
   - فقط از مسیر `infra_change_request` انجام می‌شوند و درخواست به‌تنهایی هیچ چیزی را تغییر نمی‌دهد.
   - تأیید فقط با `platform_owner` است و یک بار اجرا می‌شود.
   - اپراتور تأیید کند: 403 `role_forbidden`. توکن جعلی با claim مالک: 42501 در دیتابیس.
   - درخواست و تأیید هرکدام یک ردیف در audit زنجیره‌هش می‌سازند.
   - ثبت provider، سرویس، endpoint و معیار، و باز و بسته‌شدن هشدار هم audit می‌شوند.
   - Health Checkها یکی‌یکی audit نمی‌شوند و تاریخچه‌شان append-only است.
5. **عدد ساختگی ممنوع:**
   - بدون داده، هر ۱۰ معیار `value=null, label='?'` هستند و endpointی که هنوز بررسی نشده `health.state='unknown'` دارد.
   - عدد بدون برچسب `M` یا `E` رد می‌شود (400).
   - در دیتابیس، CHECK شرط `value IS NULL ⇔ label='?'` را اعمال می‌کند.
6. **بدون retry storm:** بین دو بررسی دستی هر endpoint دست‌کم ۳۰ ثانیه فاصله لازم است (429 `check_cooldown`). این محدودیت جدا از rate-limit عمومی API است.
7. **هشدار:** سه شکست پیاپی یک هشدار `endpoint_down` باز می‌کند و برای هر endpoint حداکثر یک هشدار باز وجود دارد. نخستین موفقیت هشدار را می‌بندد.
8. **هیچ ادعای Provisioning خودکار:** `GET /infra` همیشه `provisioning.automated=false` برمی‌گرداند و adapter دستی `provision()` را رد می‌کند.

## ۳. تکرار و خروجی خام

```sh
source /work/bin/env.sh   # Node 22
node apps/owner-panel/tests/infra-registry.test.js
# INFRA-122 negative_controls=84 unit_controls=31 failures=0
```

اعمال روی PostgreSQL 17 واقعی (پایگاه محلی یک‌بارمصرف، [S]):

```
PG17 001..005 up OK · 006 up OK · 006 down OK · 006 up OK
infra_* tables = 7 · rowsecurity=true برای هر ۷ جدول
```

این آزمون بخشی از `npm test` است (`tests/run.js`، بخش «ردیف ۱۲۲»).

## ۴. آزمون جهش

در هر جهش یک کنترل حذف شده و آزمون باید قرمز شود:

| # | جهش | نتیجه |
|---|---|---|
| M01 | پذیرش کلید credential خام | RED |
| M02 | حذف اعتبارسنجی `credential_ref` در API | RED |
| M03 | خاموش‌کردن محافظ SSRF | RED |
| M04 | adapter دستی ظرفیت ساختگی برمی‌گرداند | RED |
| M05 | اپراتور می‌تواند تأیید کند (API و DB) | RED |
| M06 | `metricView` به‌جای null مقدار 0 برمی‌گرداند | RED |
| M07 | حذف cooldown بررسی | RED |
| M08 | حذف append-only تاریخچهٔ Health | RED |
| M09 | هشدار پس از ۲ شکست | RED |
| M10 | نمایش مقدار Secret در خروجی | RED |
| M11 | تأیید چندبارمصرف می‌شود | RED |
| M12 | پذیرش `api_mode=api` | RED |
| M13 | adapter دستی provision می‌کند | RED |
| M14 | مجازشدن IPv6 ULA | RED |
| M15 | مجازشدن userinfo در endpoint (API) | RED |
| M16 | حذف CHECK دیتابیس برای `credential_ref` | RED |
| M17 | حذف CHECK دیتابیس «عدد ⇔ برچسب» | RED |

نتیجه: `MUTANTS-122 total=17 red=17 survived=0`. اجراکننده و خروجی خام بیرون از مخزن و در فضای کار عامل نگه داشته می‌شوند.

## ۵. NOT RUN و ریسک باقی‌مانده

**NOT RUN [M]:**
- Health Check واقعی روی هاست RadCloud یا Gateway واقعی (وابسته به ۱۱۶ و ۱۲۰)
- PG مدیریت‌شده (۱۱۳)
- هر API واقعی provider (۱۲۴)
- UI صفحهٔ زیرساخت (۱۲۳)

**محدودیت‌ها:**
- Health Check فقط دستی است و از API فعال می‌شود. زمان‌بند دوره‌ای ندارد و آن را ۱۲۳ و پس از آن با polling اضافه می‌کنند (O‑26).
- ظرفیت و مصرف تا ثبت دستی یا تا ردیف ۱۲۴ «نامعلوم» می‌مانند.

**ریسک‌ها:**
- DNS rebinding بین resolve و اتصال با pin کردن IP پوشش داده شده است. SNI و بررسی گواهی همچنان روی hostname انجام می‌شود.
- رفتار پراکسی‌های خروجی هاست بررسی نشده است [?].
- امنیت تا pentest انسانی (۹۲) **UNKNOWN** است.

**کار مالک:** تعریف Secretهای ارجاع‌شده (`secret:NAME`) روی هاست با OWNER است و در مخزن انجام نمی‌شود.

> پژوهش API واقعی Providerها (ردیف ۱۲۴): [`124-provider-api-research.md`](124-provider-api-research.md) — سه سطح L1/L2/L3، L3 ممنوع، آداپتور `manual` پیش‌فرض می‌ماند.
