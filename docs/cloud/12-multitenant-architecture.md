# مأموریت ۱۲ — طراحی معماری چندمستأجری و دیتاسنتر مرجع

| | |
|---|---|
| وظیفه | ۱۲ (فاز ۲) · وابسته به ۰۷، ۰۸، ۰۹، ۱۰، ۱۱ · مبنای تصمیم: **D‑07 (گزینهٔ A + RLS)** |
| وضعیت | **REVIEW** — طراحی، نه پیاده‌سازی؛ کد محصول تغییر نکرد · **A‑02: اصلاح + اجرای واقعی ۱۴/۱۴** · **A‑05 اعمال شد** (D‑29) |
| ورودی شاهد | `11-gap-report.md` §۳/§۴ · `mission-06-10-probes.txt` |
| شاهد ساختاری | `docs/cloud/reports/evidence/mission-12-16b-structure.txt` |

> این طراحی عمداً **کد فعلی را وصله نمی‌کند**. مسیر دوم نوشتن (F‑06)، کلید ابر در کلاینت (F‑04) و بازیابی به‌عنوان مسیر ارتقا (F‑02) در طراحی جدید «امکان‌ناپذیر» می‌شوند، نه «مسدود».

---

## ۱. اجزای مقصد

| # | جزء | مسئولیت | چه چیزی را **نمی‌کند** |
|---|---|---|---|
| ۱ | **Edge / TLS** | خاتمهٔ TLS، محدودیت نرخ پایه، مسیریابی | مجوزدهی |
| ۲ | **Auth Service** | ورود، نشست، دستگاه، ابطال، MFA پنل پلتفرم | تصمیم دربارهٔ دادهٔ مدرسه |
| ۳ | **Tenant Resolver (میدل‌ور)** | حل `tenant_id` **از نشست**، بارگذاری اشتراک | پذیرش `tenant_id` از بدنه |
| ۴ | **API (Core)** | مسیرهای `/api/*`، gate اشتراک/سقف، audit | دسترسی مستقیم به پایگاه |
| ۵ | **Data Access Layer (choke‑point)** | تنها مسیر مجاز پرس‌وجو؛ تنظیم `app.tenant_id` در هر تراکنش | پرس‌وجوی خام در کد محصول |
| ۶ | **PostgreSQL + RLS** | مرجع نهایی داده | سرویس‌دهی به کلاینت بدون API |
| ۷ | **Sync/Outbox Service** | صف، `applied_ops`، ترتیب، تعارض | پذیرش هویت از بدنه |
| ۸ | **Object Storage (Arvan)** | فایل/بکاپ با پیشوند `t/<tenant>/` | تحویل کلید دائمی به کلاینت |
| ۹ | **Platform Panel** | پنل مالک/اپراتور/پشتیبان | دسترسی به محتوا (D‑21) |
| ۱۰ | **Audit/Telemetry** | رویداد زنجیره‌هش، متریک، هشدار | ذخیرهٔ محتوای آموزشی |

---

## ۲. قاعدهٔ «یک نقطهٔ عبور» (اجرای D‑07 بند ۱)

### ۲.۰ نقش‌های پایگاه داده (تفکیک اجباری)

| نقش | نوع | مالک جدول؟ | `BYPASSRLS`؟ | کاربرد |
|---|---|---|---|---|
| `payesh_owner` | NOLOGIN | **بله** | خیر | فقط مهاجرت/DDL؛ هرگز در مسیر درخواست |
| `payesh_app` | LOGIN | **خیر** | **خیر** | تنها نقشی که API با آن به پایگاه وصل می‌شود |
| `payesh_readonly` | LOGIN | خیر | خیر | گزارش/پشتیبانی فنی بدون محتوا (D‑21) |
| `payesh_platform` | LOGIN | خیر | خیر | سرویس پلتفرم برای جداول سطح پلتفرم |

```sql
-- یک‌بار، توسط اپراتور (نه در کد محصول)
CREATE ROLE payesh_owner NOLOGIN;                 -- مالک اشیا
CREATE ROLE payesh_app   LOGIN PASSWORD '…' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO payesh_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO payesh_app;
ALTER DEFAULT PRIVILEGES FOR ROLE payesh_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO payesh_app;
-- هیچ GRANT مالکیت و هیچ عضویت در payesh_owner به payesh_app داده نمی‌شود
```

قواعد سخت:
1. `payesh_app` **مالک هیچ جدولی نیست** (مالکیت = `payesh_owner`) ⇒ RLS برایش اعمال می‌شود.
2. `payesh_app` هیچ‌گاه `BYPASSRLS` ندارد؛ superuser برای درخواست‌های عادی ممنوع.
3. هر جدول tenant‑scoped علاوه بر `ENABLE` باید `FORCE ROW LEVEL SECURITY` بگیرد تا حتی مالک هم مشمول سیاست باشد.
4. اگر نقش runtime به هر دلیل مالک شود، `FORCE` جلوی دور زدن را می‌گیرد؛ ولی قاعدهٔ ۱ همچنان اجباری است (دفاع دوگانه).
5. `payesh_app` مجوز `TRUNCATE`، `REFERENCES` و `CREATE` روی schema ندارد.

### ۲.۱ تراکنش و تنظیم context (fail-closed)

```ts
// لایهٔ داده — تنها راه دسترسی. tenant از نشست، نه از بدنهٔ درخواست.
async function withTenant(session, fn) {
  if (!session?.tenant_id || !isUuid(session.tenant_id)) throw new Denied('tenant_required');
  return pool.tx(async (t) => {                       // BEGIN
    // set_config(..., is_local = true) => فقط تا پایان همین تراکنش
    await t.query("SELECT set_config('app.tenant_id', $1, true)", [session.tenant_id]);
    await t.query("SELECT set_config('app.user_id',   $1, true)", [session.user_id]);
    await t.query("SELECT set_config('app.role',      $1, true)", [session.role]);
    // تأیید اینکه context واقعاً نشست: اگر NULL بود، ادامه نده
    const { rows } = await t.query("SELECT current_setting('app.tenant_id', true) AS t");
    if (!rows[0]?.t) throw new Denied('tenant_context_missing');
    return fn(t);                                     // COMMIT/ROLLBACK => context خودکار پاک
  });
}
```

| مورد | رفتار تعریف‌شده |
|---|---|
| context مفقود | `current_setting('app.tenant_id', true)` = `NULL` ⇒ مقایسهٔ `tenant_id = NULL` نادرست ⇒ **صفر ردیف**؛ INSERT/UPDATE با `WITH CHECK` **رد** |
| context خالی (`''`) | **یافتهٔ آزمون واقعی:** پس از پایان تراکنش، GUC به `''` برمی‌گردد (نه `NULL`)؛ بنابراین سیاست باید `nullif(..., '')::uuid` باشد. با cast خام `''::uuid` هر پرس‌وجو **خطا** می‌دهد (fail-closed ولی پرصدا) |
| context نامعتبر | همان بالا (خطای cast) — هیچ fallback وجود ندارد |
| پایان تراکنش | `is_local=true` ⇒ مقدار به‌طور خودکار برمی‌گردد؛ نیازی به `RESET` دستی نیست |
| `SET LOCAL x = $1` | **ممنوع** — PostgreSQL پارامتر را در `SET` نمی‌پذیرد؛ روش مجاز `set_config(..., true)` است |
| `SET` سطح نشست | **ممنوع** — می‌تواند در استخر اتصال به درخواست بعدی نشت کند |

### ۲.۲ استخر اتصال (connection pooling)

- حالت پیشنهادی: **transaction pooling** با `server_reset_query = DISCARD ALL` (یا معادل آن در کتابخانهٔ pool: `RESET ALL` پیش از تحویل مجدد اتصال).
- چون `is_local=true` است، حتی پیش از reset هم context به تراکنش بعدی نمی‌رسد؛ reset دومین لایه است.
- اتصال‌های `payesh_app` سقف و timeout دارند؛ هیچ اتصال مشترک بین مستأجرها در سطح «نشست» نگه داشته نمی‌شود.
- آزمون: دو درخواست متوالی با دو مستأجر روی **همان اتصال فیزیکی** ⇒ درخواست دوم نباید هیچ ردیفی از مستأجر اول ببیند.

### ۲.۳ سیاست‌ها (هر فرمان جداگانه)

```sql
-- نمونه: records
ALTER TABLE records ENABLE ROW LEVEL SECURITY;
ALTER TABLE records FORCE  ROW LEVEL SECURITY;

CREATE POLICY records_select ON records FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY records_insert ON records FOR INSERT
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY records_update ON records FOR UPDATE
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY records_delete ON records FOR DELETE
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

همین الگو برای `users`, `sessions`, `audit`, `applied_ops`, `conflict`, `files` تکرار می‌شود.
نکته‌های اجرایی:
- `WITH CHECK` در INSERT/UPDATE اجباری است؛ بدون آن، نوشتن با `tenant_id` جعلی ممکن می‌شود.
- `UPDATE` هم `USING` و هم `WITH CHECK` لازم دارد (جابه‌جایی ردیف به مستأجر دیگر باید رد شود).
- `FOR ALL` به‌تنهایی کافی نیست چون کنترل SELECT/INSERT را یکسان می‌کند؛ سیاست‌ها جدا نوشته می‌شوند.
- جداول سطح پلتفرم (`tenant`, `plan`, `subscription`, `support_grant`, `platform_user`) RLS ندارند، ولی تنها با نقش `payesh_platform` و از سرویس پلتفرم در دسترس‌اند؛ `payesh_app` روی آن‌ها فقط `SELECT` محدود (بدون محتوا) دارد و `support_grant` خودش با سیاست `tenant_id` محافظت می‌شود.

### ۲.۴ ماتریس آزمون منفی (طراحی — اجرا نشده)

| # | آزمون | نقش اجراکننده | انتظار |
|---|---|---|---|
| N1 | خواندن ردیف مستأجر B با context مستأجر A | `payesh_app` | ۰ ردیف |
| N2 | به‌روزرسانی ردیف مستأجر B | `payesh_app` | ۰ ردیف / `WITH CHECK` رد |
| N3 | حذف ردیف مستأجر B | `payesh_app` | ۰ ردیف |
| N4 | INSERT با `tenant_id` مستأجر B در حالی که context = A | `payesh_app` | خطای `new row violates row-level security policy` |
| N5 | UPDATE که `tenant_id` را از A به B تغییر می‌دهد | `payesh_app` | رد |
| N6 | کوئری بدون تنظیم context | `payesh_app` | ۰ ردیف (نه خطا — پس لایهٔ داده باید خطا بدهد) |
| N6b | cast خام `::uuid` بدون `nullif` | `payesh_app` | خطای cast ⇒ الزام `nullif` در سیاست |
| N7 | همان کوئری‌ها با `payesh_owner` (مالک) | `payesh_owner` | **باز هم محدود** (اثر `FORCE ROW LEVEL SECURITY`) |
| N8 | تلاش `SET ROLE payesh_owner` از `payesh_app` | `payesh_app` | رد (بدون عضویت) |
| N9 | `SHOW is_superuser` / `pg_roles.rolbypassrls` برای `payesh_app` | `payesh_app` | `off` / `f` |
| N10 | دو مستأجر پشت‌سرهم روی یک اتصال استخر | `payesh_app` | بدون نشت context |

### ۲.۵ وضعیت اثبات (به‌روزشده پس از مأموریت A)

> **`EXECUTED` — ۱۴/۱۴ PASS روی PostgreSQL 18.6 واقعی.**
> شاهد خام: `docs/cloud/reports/evidence/mission-a-rls-execution.txt` · اسکریپت بازپخش: `rls-execution-test.sh` + `rls-execution-test.cjs`.
> آزمون‌های N0, N1, N1b, N2, N3, N4, N5, N6, N6b, N7, N8, N9, N10, N11 همه PASS.
>
> **دامنهٔ اثبات (محدود و صریح):** این آزمون روی یک پایگاه **مستقل** (`payesh_rls`) با همان الگوی نقش/سیاست/تراکنش اجرا شد، نه روی پایگاه محصول و نه داخل کد محصول. بنابراین:
> - ✅ الگوی RLS (نقش غیرمالک، بدون BYPASSRLS، `FORCE`, `set_config(...,true)`, `nullif`) **عملاً کار می‌کند**.
> - ⛔ هنوز اثبات نشده: یکپارچگی با لایهٔ دادهٔ محصول، رفتار زیر بار، و آزمون نشت در ۲۰‑ب روی کد واقعی.
> - طبق D‑25، «طرح + آزمون مستقل» ≠ «امنیت سیستم محصول».
>
> **یافتهٔ تازهٔ آزمون (ثبت‌شده):** GUC محلی پس از پایان تراکنش به رشتهٔ خالی برمی‌گردد؛ بدون `nullif(..., '')`، هر پرس‌وجوی بدون context خطای cast می‌دهد. سیاست‌های بالا این را پوشش می‌دهند.

---

---

## ۳. مدل داده (تفاوت با امروز)

| امروز | مقصد |
|---|---|
| جدول عمومی `records(collection, id, data JSON)` با `school_id=1` | همان الگو + ستون اجباری `tenant_id uuid NOT NULL` در **همهٔ** ردیف‌ها |
| `id` سراسری | `id` مستقل + ایندکس `(tenant_id, collection, id)` |
| `sync_log(uid)` سراسری | `applied_ops(op_id, tenant_id, result_json, status, committed_at)` با `UNIQUE(tenant_id, op_id)` |
| بکاپ فایل روی دیسک مدرسه | بکاپ در فضای `t/<tenant>/backups/` + کپی رمزنگاری‌شده با کلید مستأجر |
| `sessions(token_hash, device_id, user_id)` | + `tenant_id` + `absolute_expires_at` + `idle_expires_at` |
| `audit(...)` | + `tenant_id` + `prev_hash`/`hash` (زنجیره) + خروجی بیرونی |

**مسیر مهاجرت (بدون تغییر داده):** افزودن `tenant_id` با مقدار پیش‌فرض `T0` برای مدرسهٔ اول؛ سپس backfill؛ سپس `NOT NULL` + RLS. این کار در ۱۶‑ب گام‌به‌گام آمده است.

---

## ۴. مسیرهای خواندن و نوشتن (مرجع واحد — پاسخ ۰۸)

### ۴.۱ نوشتن
```
client → POST /api/sync (Bearer session)
      → AuthService.verify (نشست، دستگاه، tenant، اشتراک)
      → TenantResolver  (state gate: active/grace)
      → QuotaGate       (سقف داخل تراکنش)
      → Policy.canWriteRow (نقش × مالکیت × اسکوپ)
      → withTenant: BEGIN
            INSERT/UPDATE ردیف با tenant_id از نشست
            INSERT INTO applied_ops(op_id, tenant_id, result_json) ON CONFLICT DO NOTHING
         COMMIT
      → پاسخ: همان نتیجهٔ ذخیره‌شده (تکرار ⇒ همان پاسخ)
```
**هیچ مسیر دیگری وجود ندارد.** صندوقچهٔ ابری، فایل مشترک، یا آپلود مستقیم کلاینت = حذف از معماری.

### ۴.۲ خواندن
```
client → GET /api/v1/pull?since=… (Bearer)
      → نشست/tenant → policy.buildScope(نقش)
      → withTenant + RLS → فیلتر اسکوپ ردیف → دلتا
```
کش محلی کلاینت فقط «نسخهٔ خواندنیِ همان اسکوپ» است و هرگز مرجع نیست (۰۳ §۱).

---

## ۵. جداسازی مستأجر در همهٔ لایه‌ها (بند ۲۱)

| لایه | الزام |
|---|---|
| پایگاه داده | `tenant_id NOT NULL` + RLS + ایندکس مرکب |
| کش دستگاه | پیشوند `tenant` در نام دیتابیس/کلید؛ هنگام تغییر مدرسه پاک‌سازی |
| صف عملیات | هر op با `tenant_id`؛ ارسال به مستأجر متفاوت ⇒ رد |
| فضای ذخیره‌سازی | `t/<tenant>/…` اجباری؛ کلید مستأجر جدا (۱۶‑ب) |
| لاگ/audit | `tenant_id` در هر ردیف؛ جست‌وجوی متقاطع ممنوع |
| کش سرور | کلید کش شامل `tenant_id` |


### ۵.۱ مرز «کد پایهٔ مورد ممیزی» و «پیاده‌سازی مقصد» (D‑29 / O‑10 گزینهٔ A)

| ناحیه | مسیرهای امروز | قاعده |
|---|---|---|
| کد پایهٔ ممیزی‌شده | `server/`, `client/`, `installer/`, `desktop/`, `scripts/`, `tests/` | تا باز شدن دروازهٔ فاز ۳ **دست‌نخورده**؛ فقط خواندن برای ممیزی |
| پیاده‌سازی مقصد | مسیرهای تازه (پیشنهادی: `cloud/` برای سرویس، `cloud/db/` برای مهاجرت‌ها، `packages/contracts/` برای قراردادهای مشترک، `platform/` برای پنل مالک) | ساخت فقط پس از باز شدن دروازه و با ابزار ساخت مستقل |
| مستندات و شواهد | `docs/` | همان‌جا می‌ماند؛ مرجع تصمیم و شاهد |

قواعد مرزبندی:
1. **مخزن یکی است** (D‑29)؛ ولی کد مقصد نباید داخل `server/` یا `client/` فعلی رشد کند — خطر قاطی‌شدن «کد ممیزی‌شده» با «کد تازه‌ساخته» و بی‌اعتبار شدن ممیزی.
2. نام نهایی پوشه‌ها **پس از** بررسی وابستگی‌ها نهایی می‌شود: `package.json` (اسکریپت‌های `test`, `build:release`, `check`)، `Dockerfile`/`docker-compose.yml`، `.github/workflows/build.yml` (ساخت ویندوز/APK)، `installer/` و `install/`؛ تا زمانی که این‌ها بررسی نشوند، ساختار بالا **پیشنهاد** است نه تعهد.
3. قراردادهای مشترک (schema/پیام‌ها) نسخه‌دار می‌شوند؛ تغییر آن‌ها نیازمند ثبت در Decision Log.
4. ابزار ساخت مقصد نباید مسیر انتشار فعلی (ریلیز `continuous`، `RELEASE_NOTES.json`, `releases/`) را بشکند؛ آزمون: اجرای CI موجود پس از هر افزودن پوشه باید سبز بماند.
5. هیچ کد محصولی در این مرحله نوشته نمی‌شود؛ این بند فقط مرز را تعریف می‌کند.

---

## ۶. تصمیم‌های باز مرتبط

| شناسه | پرسش | اثر بر ۱۲ |
|---|---|---|
| ~~O‑10~~ | **تصمیم‌گرفته‌شده (D‑29): گزینهٔ A — همین مخزن.** ساخت مخزن تازه یا انتقال پروژه ممنوع | §۵.۱ (مرز کد) |
| O‑09 | پشتهٔ کلاینت | فقط لایهٔ کلاینت را متأثر می‌کند، نه سرور |
| O‑07 | محیط آزمون | اثبات RLS/بار را ممکن می‌کند |

---

## ۷. آنچه در این طراحی «عمداً» نیست

- مهاجرت داده اجرایی (در ۱۶‑ب).
- HA و هزینه (در ۱۶).
- پنل مالک (در ۱۲‑ب).
- کش/صف جزئیات (در ۱۳) و تعارض (۱۴).
- کد. این سند **طرح** است و تا Gate فاز ۳ هیچ خط محصولی نوشته نمی‌شود.

---

## ۸. ماتریس پذیرش ۱۲

| # | خواسته | جای پاسخ | وضعیت |
|---|---|---|---|
| AC‑1 | معماری مرکزی multi‑tenant با گزینهٔ A | §۱، §۲ | ✅ |
| AC‑2 | `tenant_id` و RLS | §۲، §۲.۱، §۳ | ✅ |
| AC‑3 | مرجع دادهٔ مرکزی | §۴ | ✅ |
| AC‑4 | مسیرهای read/write | §۴.۱، §۴.۲ | ✅ |
| AC‑5 | رفع ساختاری F‑05/F‑06 | §۲ (نقطهٔ عبور)، §۴ (حذف مسیر دوم) | ✅ |
| AC‑6 | مسیر خروج به B/C حفظ شود | §۳ (ستون مستقل + امکان export) | ✅ |
| AC‑7 | وابستگی‌ها ثبت شده | §۶ | ✅ |
| AC‑8 | سخت‌سازی RLS + اجرای واقعی منفی | §۲.۰–§۲.۵ | ✅ **اجرا شد: ۱۴/۱۴ PASS (PG 18.6)** |

**حکم: ۸/۸ — REVIEW** (AC‑8: اجرا شده روی پایگاه مستقل؛ یکپارچگی با محصول در ۲۰‑ب).
