# مأموریت ۱۲ — طراحی معماری چندمستأجری و دیتاسنتر مرجع

| | |
|---|---|
| وظیفه | ۱۲ (فاز ۲) · وابسته به ۰۷، ۰۸، ۰۹، ۱۰، ۱۱ · مبنای تصمیم: **D‑07 (گزینهٔ A + RLS)** |
| وضعیت | **REVIEW** — طراحی، نه پیاده‌سازی؛ کد محصول تغییر نکرد |
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

```ts
// لایهٔ داده — تنها راه دسترسی
async function withTenant(session, fn) {
  if (!session?.tenant_id) throw new Denied('tenant_required');
  return db.tx(async (t) => {
    await t.query("SET LOCAL app.tenant_id = $1", [session.tenant_id]);
    await t.query("SET LOCAL app.user_id   = $1", [session.user_id]);
    await t.query("SET LOCAL app.role      = $1", [session.role]);
    return fn(t);
  });
}
```

قواعد:
1. هیچ ماژول محصول `db.query` خام ندارد؛ فقط `withTenant`.
2. `tenant_id` در بدنهٔ درخواست **خوانده نمی‌شود**؛ اگر آمد و با نشست نخواند ⇒ `403 tenant_mismatch`.
3. آزمون CI (۲۰‑ب): هر کوئری بدون `withTenant` ⇒ خطای lint/timeout مصنوعی.
4. RLS دومین لایه است، نه لایهٔ اول: خطای کد نباید به نشت تبدیل شود.

### ۲.۱ نمونهٔ سیاست RLS

```sql
ALTER TABLE records ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON records
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

ALTER TABLE users  ENABLE ROW LEVEL SECURITY;   -- همان الگو
ALTER TABLE audit  ENABLE ROW LEVEL SECURITY;   -- tenant_id اجباری
```

جداول سطح پلتفرم (`tenant`, `plan`, `subscription`, `support_grant`, `platform_user`) از RLS مستثنا هستند ولی فقط از مسیر سرویس پلتفرم با نقش `platform_*` قابل خواندن‌اند.

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

---

## ۶. تصمیم‌های باز مرتبط

| شناسه | پرسش | اثر بر ۱۲ |
|---|---|---|
| **O‑10** | دیتاسنتر از همین مخزن رشد کند یا مخزن تازه با همان قراردادها؟ | ساختار پوشه و CI؛ **پیشنهاد: مخزن تازه، قرارداد مشترک** |
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

**حکم: ۷/۷ — REVIEW.**
