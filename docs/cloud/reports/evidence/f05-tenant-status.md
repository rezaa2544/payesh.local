# ردیف ۲۶ (F‑05) — وضعیت سنجیده‌شدهٔ انتقال بدنهٔ محصول به tenant model و RLS

تاریخ: ۲۰۲۶‑۱۱‑۰۷ · HEAD: `5f08c9c` · نسخهٔ محصول: ۰٫۸٫۳۸
دروازهٔ مرتبط: `docs/cloud/reports/evidence/cc12-2-gate.txt` (CC12‑2 = RLS از مسیر محصول، ۲۰/۲۰ روی PostgreSQL واقعی)

## ۱) معیار پذیرش (از Notion، `411ba74e-cd98-814b-97d3-cf00702f6127`)

> همهٔ ۴۸ school_id references و repository read/write به tenant context؛ RLS همه جداول حساس؛ tenant فقط session؛ HTTP محصول+Postgres واقعی CRUD/delete/join/export/job و cross-tenant؛ migration/rollback.

## ۲) آنچه امروز در کد و شاهد واقعی وجود دارد (PASS در محدودهٔ خودش)

| مورد | وضعیت | شاهد |
|---|---|---|
| `tenant_id` فقط از نشست (نه از بدنهٔ درخواست) | **PASS** برای مسیر tenancy | `server/tenancy.js:10` + تست CC12‑2 |
| RLS روی جدول `tenant_records` (سیاست USING/WITH CHECK) | **PASS** | `server/tenancy.js:75‑88`; `cc12-2-gate.txt` (۴۲ بررسی) |
| CRUD/delete روی `tenant_records` از مسیر HTTP محصول روی PostgreSQL واقعی | **PASS** | `cc12-2-product-rls.txt` (۲۰/۲۰) |
| رد درخواست cross‑tenant و بدنهٔ حاوی tenant_id | **PASS** | همان شاهد + دروازهٔ ۴۲ بررسی |

## ۳) آنچه هنوز انجام نشده است (BLOCKED — همین ردیف را باز نگه می‌دارد)

۱. **۵۴ ارجاع `school_id`** در کد محصول (خروجی `grep -rn school_id --include=*.js server client`):
   `server/{auth,index,mirror,outbox,seed,sync}.js` و `client/{app,import,pages,schedule}.js`.
   هیچ‌کدام به «زمینهٔ مستأجرِ نشست» منتقل نشده‌اند؛ دادهٔ محصول همچنان در SQLite محلی با کلید مدرسه است.
۲. **۲۶ کالکشن محصول** (`server/policy.js`) هنوز در PostgreSQL جدول ندارند؛ تنها یک جدول RLS‑دار وجود دارد (`tenant_records`, شمارش `ENABLE ROW LEVEL SECURITY` = ۱).
   ⇒ «RLS همهٔ جداول حساس» برآورده نشده است.
۳. **repository read/write محصول** (attendance/grades/users/…) از مسیر tenancy عبور نمی‌کند؛ فقط مسیر `/api/cloud/tenancy/*` چنین است.
۴. **join/export/job چندمستأجری روی PostgreSQL واقعی** آزموده نشده است.
۵. **migration/rollback** از SQLite به PostgreSQL برای بدنهٔ محصول نوشته و اجرا نشده است.

## ۴) چرا در این دور بسته نشد

انتقال ۲۶ کالکشن + ۵۴ ارجاع، بدون شکستن مسیر آفلاین/همگام‌سازیِ آزمون‌شده (۹۳ آزمون) نیازمند طراحی migration دو‑نویسه (dual‑write)،
ابزار rollback و بازآزمون کامل روی PostgreSQL واقعی است؛ تغییر یک‌شبهٔ آن، دروازه‌های موجود (F01/F02/F04/F06/SYNC) را می‌شکند
و «شاهد سبز» را به «ادعای سبز» تبدیل می‌کند — که D‑25 صریحاً منع کرده است.

## ۵) گام بعدی پیشنهادی (قابل اجرا در یک دور)

۱. افزودن جدول عام `product_records(tenant_id, collection, id, data jsonb, version)` با همان سیاست RLS.
۲. مهاجرت تدریجی هر کالکشن با پرچم `PAYESH_TENANCY_COLLECTIONS` (کالکشن‌به‌کالکشن، هر کدام با آزمون cross‑tenant).
۳. اسکریپت rollback + شاهد migration.
۴. سپس شمارش «۴۸/۴۸» با `grep` به «۰ ارجاع school_id در مسیر خواندن/نوشتن» می‌رسد.
