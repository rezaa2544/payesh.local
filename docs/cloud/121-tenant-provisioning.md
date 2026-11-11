# ردیف ۱۲۱ — ساخت مدرسه از پنل مالک ← tenant اختصاصی ← مدیر اولیه (سرتاسری)

> وضعیت: **PASS [S]** (CI و محلی، با Gateway واقعی و PostgreSQL واقعی، در یک دیتابیس تازه برای هر اجرا).
> هیچ بخشی **[M]** نیست: اجرا روی میزبان واقعی و با گوشی واقعی **NOT RUN** است و به ردیف‌های ۱۱۶ و ۱۲۰ (OWNER/Blocked) وابسته است.
> امنیت: **UNKNOWN** تا pentest انسانی انجام شود (ردیف ۹۲). آزمون‌های منفی این ردیف جای pentest را نمی‌گیرند.
> تاریخ: ۱۴۰۵/۰۸/۲۰ · شاخه: `arena/tenant-121` · مبنا: 16b §1 و §1.4، 12b، قانون اساسی بند ۲۵ (فقط Gateway)، D‑45.

## ۱) شکاف‌های پنل ↔ tenant پیش از این ردیف (و اینکه چه شدند)

| # | شکاف | پیش از ۱۲۱ | پس از ۱۲۱ |
|---|---|---|---|
| G1 | مسیری برای ساخت مدرسه وجود نداشت | فقط `GET /tenants` بود؛ tenant_id فقط در `subscriptions` بود | `POST /api/platform/v1/tenants` فقط برای owner، با reason، `provision_op_id` و saga سه‌مرحله‌ای |
| G2 | رجیستری مدرسه وجود نداشت | هیچ نگاشت slug ↔ tenant نبود | `owner_platform.tenant_registry` (migration 005) و `gw_school` در دیتابیس مدرسه |
| G3 | مدیر اولیه ساخته نمی‌شد | ردیف users در tenant تازه نبود | `users#1` با `role=manager` زیر RLS همان tenant ساخته می‌شود |
| G4 | مسیر ورود کاربر مدرسه در Gateway نبود | `directory.issueSession` را فقط آزمون صدا می‌زد | `POST /api/gw/v1/session/activate` و `/session/refresh`، و `POST /api/gw/v1/admin/activation-codes` برای مدیر |
| G5 | پنل نمی‌توانست بدون دسترسی به داده، داده‌ای در مدرسه بنویسد | — | پنل فقط hook تزریق‌شدهٔ Gateway را صدا می‌زند. نقش پلتفرم روی جداول مدرسه **هیچ** grant ندارد |

## ۲) مسیر داده

```
پنل مالک (owner، TOTP) ── POST /api/platform/v1/tenants {provision_op_id, slug, display_name, manager_name, plan_code, reason}
   │ ۱) تراکنش پلتفرم: provision_tenant()  → registry + subscription(provisioning) + limits + audit «tenant.provision»
   │ ۲) hook مدرسه (نقش runtime مدرسه، FORCE RLS روی tenant تازه): gw_school + users#1 (مدیر) + کد یک‌بارمصرف
   │ ۳) تراکنش پلتفرم: activate_tenant()   → subscription(active) + audit «tenant.activate»
   ▼
کد فعال‌سازی ۳۲ نویسه‌ای (۱۶۰ بیت) فقط یک بار به owner برمی‌گردد (no-store، بیرون از audit) ── خارج از سامانه به مدیر داده می‌شود
   ▼
اپ مدیر ── POST /api/gw/v1/session/activate {school, code, device_id}
   → توکن مدرسه (tid از رجیستری، role و uid از ردیف users خود مدرسه، نه از درخواست) + راز دستگاه (یک بار)
   ▼
مدیر ── push users#N ── POST /api/gw/v1/admin/activation-codes {uid} ── کاربر جدید activate می‌کند ── همان tenant
```

- **بازیابی (saga):** اگر سمت مدرسه شکست بخورد، پاسخ `502 school_provisioning_failed` است و tenant در وضعیت `provisioning` می‌ماند. تکرار همان درخواست با همان `provision_op_id` به همان tenant می‌رسد و فعالش می‌کند. هیچ tenant دوم یا مدیر دومی ساخته نمی‌شود. اگر مدیر قبلاً فعال شده باشد، تکرار کد تازه نمی‌دهد.
- **رازها:** کدها و رازهای دستگاه فقط به‌صورت `sha256(tenant ':' secret)` ذخیره می‌شوند. هیچ‌کدام در لاگ، audit یا خروجی آزمون چاپ نمی‌شوند.
- **دفاع لایه‌ای:** هر کوئری `school-access` علاوه بر FORCE RLS، tenant را صریحاً در شرط می‌آورد. برای یافتن tenant از روی slug پیش از ورود، فقط `gw_resolve_school()` (SECURITY DEFINER) استفاده می‌شود که یک uuid برمی‌گرداند و فهرست‌پذیر نیست. slug نادرست و کد نادرست هر دو یک پاسخ 401 یکسان می‌گیرند.

## ۳) آزمون‌ها و خروجی خام [S]

**بخش PGlite** (در `npm test`): `node apps/owner-panel/tests/tenant-provisioning.test.js`

```
TENANT-PROVISIONING-121 negative_controls=25 failures=0
```

**بخش سرتاسری با PostgreSQL واقعی** (CI: `api-contract`، گام «Row 121»، `T121_REQUIRE_PG=1`):

```sh
PAYESH_PG_ADMIN=postgres://postgres@127.0.0.1:5432/payesh_c64 \
PAYESH_PG_RUNTIME=postgres://payesh_runtime@127.0.0.1:5432/payesh_c64 node tests/tenant-121.js
```

```
PASS  T121-E01  owner creates two schools → two dedicated tenants, active, one-time codes
PASS  T121-E02  initial manager activates → school token (tid A, role manager from DB); code is one-time
PASS  T121-E03  manager A creates a teacher + data in the same school; teacher activates in A and reads A  → teacher pulled 2 rows of A
PASS  T121-E04  cross-school: B's manager sees 0 rows of A and cannot issue a code for A's user  → B_rows=1 rows_of_A_seen_by_B=0
PASS  T121-E05  privilege: teacher cannot issue codes or promote itself; forged/expired tokens 401
PASS  T121-E06  refresh: device secret → token (role re-read); deactivated user → refresh 401
PASS  T121-E07  data layer: runtime with tenant B sees 0 rows of A; permissive-policy mutant is detected  → B_sees_A={"gw_school":0,"gw_credential":0,"product_records":0} mutant_sees=4
PASS  T121-E08  platform controls over HTTP: operator/forged 403, short reason 400, replay 200 without new code
TENANT-121 passed=8 failed=0 negative_controls=28
```

بدون PostgreSQL، آزمون `BLOCKED` چاپ می‌کند و با کد 3 خارج می‌شود. با `T121_REQUIRE_PG=1` همین حالت شکست حساب می‌شود.

### کنترل‌های منفی (هر کدام با برگرداندن اصلاح قرمز می‌شود)

جهش‌ها یکی‌یکی روی کد اعمال شدند و هر دو آزمون دوباره اجرا شدند. خروجی خام:

| جهش (برگرداندن کنترل) | نتیجه |
|---|---|
| M1 حذف بررسی `manager_only` در صدور کد | RED: `T121-E05` |
| M2 گرفتن نقش از درخواست به‌جای ردیف users | RED: `E03, E04, E05, E06` |
| M3 کد فعال‌سازی چندبارمصرف (حذف `used_at is null`) | RED: `E02, E04` |
| M4 حذف `require_actor` در `provision_tenant` | RED: `E08` و PGlite |
| M5 خاموش‌کردن جداسازی RLS روی `gw_credential` | RED: `E07` |
| M6 حذف idempotency با `provision_op_id` | RED: `E08` و PGlite |
| M7 کاربر غیرفعال همچنان refresh می‌گیرد | RED: `E06` |
| M8 فعال‌سازی subscription پیش از موفقیت سمت مدرسه | RED: `E08` و PGlite |

کنترل‌های منفی درون‌خطی (در هر اجرا) شامل این موارد است:
- operator ⇒ 403، و claim جعلی owner ⇒ 403 با `data_layer=42501`. owner غیرفعال و support ⇒ 403.
- reason کوتاه، `provision_op_id` نامعتبر، slug بد و طرح ناموجود یا بایگانی‌شده ⇒ 400.
- نبود hook مدرسه ⇒ 503 بدون هیچ نوشتنی. استفادهٔ دوباره از op برای slug دیگر ⇒ 409، و slug تکراری با op تازه ⇒ 409.
- درج مستقیم در `tenant_registry` با نقش runtime ⇒ 42501.
- کد مدرسهٔ A در مدرسهٔ B ⇒ 401، و slug ناموجود ⇒ همان 401.
- مدیر B برای کاربر A کد بگیرد ⇒ 404 (RLS).
- ارتقای خودسرانهٔ معلم ⇒ 403 و نقش در دیتابیس بی‌تغییر می‌ماند.
- توکن با راز دیگر یا منقضی ⇒ 401. refresh با دستگاه یا مدرسهٔ دیگر ⇒ 401.
- توکن مدرسه روی API پلتفرم ⇒ 401. کد در audit یا `gw_credential` به‌صورت خام دیده نمی‌شود.
- rollback migration 005 ⇒ مسیر بسته می‌شود (fail-closed).

## ۴) NOT-RUN و ریسک باقیمانده

- **NOT RUN [M]:** میزبان واقعی (ردیف ۱۱۶ OWNER، ردیف ۱۲۰ Blocked)، گوشی واقعی، و PostgreSQL مدیریت‌شدهٔ رایگان (ردیف ۱۱۳ OWNER).
- **NOT RUN:** صفحهٔ UI «ساخت مدرسه» در SPA پنل مالک. API و قرارداد OpenAPI آماده است. فرم آن به ردیف ۱۲۳ (صفحهٔ زیرساخت و مدیریت) یا یک PR جدا سپرده شده است.
- **NOT RUN:** پاک‌سازی رازها هنگام حذف مدرسه. حذف دومرحله‌ای (migration 003) فقط subscription را لغو می‌کند و داده را نگه می‌دارد (D‑22).
- **محدود [A]:** فرض شده Gateway و پایگاه پلتفرم در یک cell هستند. hook سمت مدرسه همان pool مدرسهٔ همین Gateway است. برای چند cell، باید از Directory (ردیف ۶۶) استفاده کرد تا cell انتخاب شود.
- **ریسک:**
  - کد فعال‌سازی ۷ روز اعتبار دارد و تا وقتی مصرف یا جایگزین نشده، هر کسی که آن را داشته باشد مدیر می‌شود. انتقال امن کد به مدیر بر عهدهٔ owner است.
  - برای مسیرهای session هنوز سهمیهٔ نرخ جدا وجود ندارد. آنتروپی ۱۶۰ بیتی کد، حدس‌زدن را بی‌اثر می‌کند [A]، ولی سهمیهٔ IP پیشنهاد می‌شود.
  - ابطال توکن‌های صادرشده تا انقضای ۱۲ ساعته‌شان طول می‌کشد. refresh همان لحظه رد می‌شود.
- **ادعاهای ممنوع رعایت شده:** «تأمین خودکار زیرساخت» ادعا نمی‌شود، چون هیچ API واقعی ارائه‌دهنده‌ای صدا زده نمی‌شود (ردیف ۱۲۴). «امنیت tenant» فقط در حد همین آزمون‌های منفی [S] است.

## ۵) شمارهٔ migration

ردیف ۱۲۱ شمارهٔ `005` را گرفت (`005_tenant_provisioning`)، پس لایهٔ زیرساخت مستقل از ارائه‌دهنده در ردیف ۱۲۲ با `006` شروع می‌شود. این تغییر در یادداشت Notion ردیف ۱۲۲ ثبت شده است.
