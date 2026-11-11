# ردیف ۱۱۰ — Transport مستقیم در کلاینت‌ها، پشت پرچم `PAYESH_TRANSPORT=direct` (پیش‌فرض خاموش)

| | |
|---|---|
| مبنا | ADR‑105. ADR هنوز پیشنهاد (Proposed) است و تا امضای مالک (ردیف ۱۰۵) تصمیم به حساب نمی‌آید. اصل ۲۵ (D‑36: تنها مسیر داده Gateway است) تا آن زمان پابرجاست. به همین دلیل مسیر مستقیم **پیش‌فرض خاموش** است. |
| وابستگی | ردیف ۱۰۶ (هویت و RLS)، ۱۰۷ (e2e1)، ۱۰۸ (`sync_push`/`sync_pull`)، ۱۰۹ (پنتست و write ticket). |
| JS | لایهٔ transport در `client/transport.js` و لایهٔ provider در `client/provider-postgrest.js`. پروتکل از ردیف ۱۰۸ است: `tools/direct-sync.js`. |
| Dart | `apps/payesh/packages/payesh_sync/lib/src/direct_transport.dart`، شامل `selectTransport`، `DirectProvider`/`PostgrestProvider` و `DirectTransport`. |
| آزمون | `tests/transport-110.js` (TR‑01..08). TR‑06..08 روی PostgreSQL واقعی و پشت یک شبیه‌ساز سازگار با PostgREST اجرا می‌شوند. CI: گام «Direct transport (row 110)» در `api-contract`. Dart: `payesh_sync/test/direct_transport_test.dart` در job `dart` از `native-client`. |
| برچسب | **[S]**. هیچ ارائه‌دهندهٔ مدیریت‌شده‌ای (Supabase واقعی) لمس نشده است. |
| امنیت | `UNKNOWN` (D‑41). |

## دو لایه

```
outbox (client/outbox-web.js | SqliteOutbox) ── drain(send) ──► transport.push(ops)
                                                                │
                      ┌──────────── gateway (پیش‌فرض) ──────────┤
                      │  POST /api/sync · GET /api/v1/pull       │
                      │  (Dart: GatewayTransport، ردیف ۷۵)       │
                      │                                          │
                      └──────────── direct (فقط با پرچم) ───────┘
                         DirectSync / DirectTransport: e2e1، OCC، uid، تصمیم stale روی دستگاه
                                     │  rpc(fn, args)
                                     ▼
                         provider: PostgrestProvider ── POST {url}/rest/v1/rpc/<fn>
```

- **Transport** پروتکل همگام‌سازی را می‌شناسد، ولی هیچ URL، کلید یا HTTPای نمی‌شناسد. TR‑01 این را روی متن فایل بررسی می‌کند.
- **Provider** فقط یک متد دارد: `rpc(fn, args)`. از outbox، convergence یا رمزنگاری خبر ندارد. اگر ارائه‌دهنده عوض شود (میزبان مدیریت‌شدهٔ دیگر، یا pg مستقیم در آزمون)، فقط همین لایه عوض می‌شود.
- فقط ۹ RPC در allowlist قابل فراخوانی‌اند و پارامترها با نام فرستاده می‌شوند. هر تابع دیگری (مثلاً `bootstrap_school` یا `create_user`) هرگز از دستگاه خارج نمی‌شود.

## انتخاب مسیر

| `PAYESH_TRANSPORT` | نتیجه |
|---|---|
| تنظیم‌نشده / `gateway` | Gateway (همان رفتار امروز) |
| `direct` | مسیر مستقیم. اگر provider پیکربندی نشده باشد خطای `direct_not_configured` برمی‌گردد. **هیچ بازگشت بی‌صدا به Gateway وجود ندارد.** |
| هر مقدار دیگر (غلط تایپی) | Gateway، با `valid=false` تا برنامه هشدار بدهد |

در Dart مقدار از `--dart-define=PAYESH_TRANSPORT=…` یا متغیر محیطی خوانده می‌شود.

## هیچ کلید سرویس در کلاینت

آنچه کلاینت نگه می‌دارد فقط این دو است:

- **کلید عمومی پروژه** (publishable یا anon). این کلید به‌تنهایی به نقش anon می‌رسد که هیچ دسترسی‌ای ندارد (ردیف ۱۰۹، `N-anon-role`).
- **توکن خود کاربر** (JWT با `sub` و `device_id`).

سه لایه دفاع:

1. **رد در زمان اجرا** (JS و Dart). این‌ها پیش از ارسال هر بایتی رد می‌شوند و تعداد درخواست ارسالی صفر می‌ماند:
   - کلید `sb_secret_…`؛
   - JWT با نقش ممتاز (service role، `supabase_admin`، `postgres`)؛
   - JWT غیر anon به‌عنوان کلید کلاینت؛
   - توکن ممتاز به‌جای توکن کاربر.
2. **پویش ایستا** (TR‑04). همهٔ فایل‌های `client/**`، `apps/payesh/app/lib` و `apps/payesh/packages/*/lib` پویش می‌شوند. الگوهای ممنوع:
   - نام نقش سرویس؛
   - `sb_secret_`؛
   - نقش‌های ادمین؛
   - متغیرهای اعتبارنامهٔ دیتابیس سرور؛
   - URL ‏`postgres://…@`؛
   - هر JWT لفظی غیر anon.

   پویشگر با ۶ کنترل مثبت کاشته‌شده اثبات می‌شود. تنها استثنا فهرست‌های ردِ خودِ این ردیف‌اند که با `key-guard-110` علامت خورده‌اند و تعدادشان دقیقاً ۴ نشانه است.
3. **RLS و INVOKER در دیتابیس** (ردیف‌های ۱۰۶ تا ۱۰۹). حتی کلید درست هم بیش از دامنهٔ خود کاربر چیزی باز نمی‌کند.

## کار آفلاین بدون تغییر

همان outbox با همان قرارداد (`drain({send})`، حذف پس از تأیید، backoff، uid ثابت) استفاده می‌شود. فقط `send` عوض می‌شود. نتایج TR‑06 روی PostgreSQL واقعی:

- **قطع شبکه:** ۴ عملیات در صف ماندند و صفر درخواست فرستاده شد.
- **وصل شدن دوباره:** ۳ عملیات اعمال شد.
- **عملیات بدون id:** گزارش شد (`direct_id_required`) و بی‌صدا دور ریخته نشد.
- **تکرار یک uid تأییدشده:** `duplicate` برگشت و نوشتن دوم انجام نشد.
- **دستگاه دوم:** feed را کشید و متن ساده را در موتور IndexedDB خود داشت.
- **دیتابیس:** فقط `e2e1.` نگه می‌دارد.

TR‑07:

- فیلد manual در دو طرف ← تعارض (هر دو نسخه نگه داشته می‌شود).
- فیلد auto در دو طرف ← ادغام روی دستگاه و یک نسخهٔ جدید با هر دو تغییر.

در Dart همین سناریوها با `SqliteOutbox` و `SqliteEngine` و یک دیتابیس جعلی با معنای OCC/uid ردیف ۱۰۸ آزموده می‌شوند. درخواست PostgREST روی HTTP واقعی (`HttpServer`) آزموده می‌شود.

**تفاوت شناخته‌شدهٔ Dart:** قواعد ادغام فیلدی `server/convergence.js` هنوز به Dart پورت نشده‌اند. پس `DirectTransport` در Dart برای هر put کهنه (stale) حکم محافظه‌کارانهٔ **conflict** می‌دهد: نسخهٔ محلی با AAD تعارض رمز می‌شود و برای تصمیم مدیر می‌ماند. هرگز نسخهٔ جدیدتر سرور را بازنویسی نمی‌کند. حذفِ کهنه نسخهٔ فعلی را حذف می‌کند، چون حذف‌های outbox طبق Sync v1 پایه ندارند. نتیجه: در Dart تعارض بیشتر است، ولی هیچ داده‌ای از دست نمی‌رود. پورت convergence کار بعدی است.

## حالت Gateway همچنان کار می‌کند

- انتخاب پیش‌فرض Gateway است (TR‑01). در حالت پیش‌فرض، factory مسیر مستقیم حتی صدا زده نمی‌شود.
- `gatewayTransport` دقیقاً همان دو فراخوانی `client/app.js` را می‌سازد. TR‑05 هم آن‌ها را مقایسه می‌کند و هم ثابت می‌کند `app.js` تغییری نکرده است.
- `npm test` ‏۱۱۱/۱۱۱ ماند.
- در Dart، `GatewayTransport` و همهٔ آزمون‌های ردیف ۷۵ (`gateway_it_test`، `pinning_test`، `data_path_test`) دست‌نخورده‌اند.

## pinning

`PostgrestProvider.pinned(GatewayConfig …)` همان سازوکار pinning ردیف ۷۵ را به کار می‌برد: https، دست‌کم دو SPKI pin، و بررسی pin پیش از ارسال هر بایت. مقادیر pin ارائه‌دهندهٔ واقعی کار مالک است (OWNER). کلید TLS ارائه‌دهندهٔ مدیریت‌شده ممکن است بدون اطلاع قبلی عوض شود؛ این خطر باید پیش از روشن کردن پرچم در نسخهٔ تولیدی سنجیده شود.

## محدودیت‌ها

- **رابط وب (`client/app.js`) فقط Gateway است.** مسیر مستقیم به e2e1 نیاز دارد که در JS از `crypto` نود استفاده می‌کند. پورت WebCrypto در دامنهٔ این ردیف نیست. موتور JS (outbox و IndexedDB) و transport در Node آزموده شده‌اند.
- شبیه‌ساز PostgREST جای PostgREST/Supabase واقعی را نمی‌گیرد. اعتبارسنجی JWT واقعی، نگاشت نقش‌ها و rate limit لبهٔ ارائه‌دهنده آزموده نشده‌اند (**[M]/OWNER**: نیاز به پروژهٔ واقعی دارد).
- شناسهٔ رکورد جدید در مسیر مستقیم باید روی دستگاه تخصیص یابد، چون سرور id نمی‌دهد. عملیات `localId` بدون id فعلاً `direct_id_required` گزارش می‌شوند.
- ردیف ۷۵ (`docs/cloud/75-gateway-client.md`) با یک بخش کوتاه دربارهٔ این پرچم به‌روز شد.

## اجرا

```
PAYESH_PG_ADMIN=postgres://postgres@127.0.0.1:5432/payesh_c64 TR110_REQUIRE_PG=1 \
  node --experimental-sqlite tests/transport-110.js
(cd apps/payesh/packages/payesh_sync && dart test test/direct_transport_test.dart)
```
