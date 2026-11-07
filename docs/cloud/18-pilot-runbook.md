# ۱۸ — Runbook پایلوت چند‌مدرسه‌ای (ردیف ۳۰)

> این سند **فرایند عملیاتی** پایلوت است: فراهم‌سازی مستأجر، مهاجرت مدرسهٔ موجود،
> تطبیق (reconciliation)، بازگشت (rollback)، پایش، معیار توقف و تصمیم Go/No-Go.
> شاهد اجرایی: `docs/cloud/reports/evidence/cc-pilot-gate.txt` ·
> دریل خام: `pilot-migration-drill.txt` · پایش: `pilot-tenant-monitoring.txt`.

## ۱. دامنهٔ این پایلوت (و آن‌چه نیست)

| هست | نیست |
|---|---|
| دو مستأجر (مدرسه) هم‌زمان روی PostgreSQL واقعی، از مسیر خود محصول | خوشهٔ تولیدی چند‌ناحیه‌ای |
| مهاجرت مدرسهٔ موجود از SQLite به جدول چندمستأجری + تطبیق محتوا | مهاجرت دادهٔ مشتری واقعی بدون پنجرهٔ توافق‌شده |
| بازگشت (rollback) واقعیِ محدود به مستأجر | بازگشت خودکار (auto-failback) |
| پایش per-tenant با ابزار اجرایی + معیار توقف | پیجر/on-call شبانه‌روزی (تصمیم مالک، BC‑16‑۲) |
| ترافیک مصنوعی و کنترل‌شده | بار واقعی مدارس در ساعات اوج |

## ۲. پیش‌نیازها (قبل از هر پایلوت)

1. `cc-security-gate.txt` سبز (ردیف ۲۸) — بدون آن پایلوت شروع نمی‌شود.
2. `cc-capacity-gate.txt` سبز (ردیف ۲۹) — RPO/RTO اندازه‌گیری‌شده.
3. `f05-product-tenancy.txt` با `F05-PG-OK checks=12` — جداسازی مستأجر از مسیر محصول.
4. PostgreSQL مقصد + نقش runtime غیرمالک + کلید امضای توکن مستأجر (`PAYESH_TENANCY_SECRET`).
5. نسخهٔ پشتیبان از منبع (SQLite مدرسه) پیش از مهاجرت — منبع هرگز حذف نمی‌شود.

## ۳. فراهم‌سازی مستأجر تازه

```bash
# ۱) طرح پایگاه‌داده (همان تابع محصول؛ نه SQL دستی)
PAYESH_TENANCY_ADMIN_URL=postgres://postgres@HOST/payesh node server/tenancy.js --migrate

# ۲) توکن مستأجر (صدور در دامنهٔ پنل مالک پلتفرم انجام می‌شود)
node -e "const t=require('./server/tenancy');console.log(t.signToken({tid:process.argv[1],role:'manager',uid:'u1',did:'d1',iat:Date.now(),exp:Date.now()+900000}, process.env.PAYESH_TENANCY_SECRET))" <TENANT_UUID>

# ۳) درج دادهٔ آغازین از مسیر محصول
curl -sS -X POST https://HOST/api/cloud/tenancy/product \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"collection":"classes","id":1,"data":{"name":"هفتم الف"}}'
```

**قاعدهٔ سخت:** `tenant_id` فقط از توکن می‌آید؛ هدر `x-tenant` یا فیلد `tenant_id`
در بدنه اثر ندارد (آزمون PL‑06 همین را می‌سنجد).

## ۴. مهاجرت مدرسهٔ موجود (کنترل‌شده)

```bash
# ۰) پشتیبان منبع
cp "$PAYESH_DATA/payesh.sqlite" "/backup/payesh-$(date -u +%Y%m%dT%H%M%SZ).sqlite"

# ۱) خشک‌شدن نوشتن: مدرسه در حالت «نوشتن متوقف» (کلاینت‌ها فقط poll)
# ۲) مهاجرت (idempotent؛ چند بار اجرا بی‌خطر است)
PAYESH_TENANCY_ADMIN_URL=postgres://postgres@HOST/payesh \
  node scripts/tenancy-migrate-product.js --db "$PAYESH_DATA/payesh.sqlite" --tenant <TENANT_UUID> --apply

# ۳) تطبیق (بخش ۵) — تا سبز نشود، نوشتن در مقصد باز نمی‌شود
```

زمان اجرای مهاجرت به تعداد ردیف بستگی دارد؛ برای دادهٔ پایلوت (< ۱۰ هزار ردیف)
در حد چند ثانیه است. برای دادهٔ بزرگ‌تر، اجرای مرحله‌ای و شمارش در هر مرحله لازم است.

## ۵. Reconciliation (تطبیق) — شرط عبور

تطبیق سه لایه دارد و **هر سه** باید برابر باشند:

| لایه | چه چیزی مقایسه می‌شود | ابزار |
|---|---|---|
| تعداد | تعداد ردیف هر کالکشن در منبع و مقصد | `pilot-drill.cjs` (`PILOT-RECON`) |
| محتوا | هش SHA‑256 محتوای کانونیکال (کلیدهای مرتب، حذف `tenant_id`/`school_id`) | همان |
| هویت | `collection + id + version + deleted` برای هر ردیف | همان |

قاعدهٔ عبور: `missing=0 · extra=0 · differed=0 · source_hash == target_hash`.
اگر ناهمخوانی باشد ⇒ **پایلوت متوقف** (S2) و مقصد پاک (rollback) می‌شود.

## ۶. Re-apply و idempotency

اجرای دوبارهٔ `--apply` باید همان نتیجه را بدهد (بدون ردیف تکراری، بدون تغییر هش).
این در دریل دو بار پشت سر هم اجرا و سپس تطبیق می‌شود (`match=1`).

## ۷. Rollback

```bash
PAYESH_TENANCY_ADMIN_URL=postgres://postgres@HOST/payesh PAYESH_TENANCY_CONFIRM=1 \
  node scripts/tenancy-migrate-product.js --tenant <TENANT_UUID> --rollback
```

قواعد:
- فقط ردیف‌های **همان مستأجر** حذف می‌شوند؛ مستأجرهای دیگر دست‌نخورده می‌مانند.
- منبع SQLite **دست‌نخورده** می‌ماند (مرجع از دست نمی‌رود) و باید همان هش قبلی را بدهد.
- بازگشت بیش از ۵ دقیقه یا اثرگذاری روی مستأجر دیگر ⇒ توقف پایلود (S4).
- پس از بازگشت، مقصد آن مستأجر «خالیِ تأییدشده» است و تنها با تصمیم صریح می‌توان دوباره مهاجرت کرد.

## ۸. پایش (per-tenant)

```bash
# در کرون هر ۵ دقیقه؛ خروج ۰ سالم، ۲ نقض آستانه، ۳ خطای ابزار
PAYESH_TENANCY_PG=postgres://payesh_runtime@HOST/payesh \
  node scripts/pilot-tenant-report.mjs --tenant=<UUID1>,<UUID2> --min-rows=1 --max-age-s=604800
```

خروجی JSON شامل: تعداد ردیف هر مستأجر و هر کالکشن، سن آخرین نوشتن،
`cross_tenant_visible` (باید ۰ باشد)، و `rls_enforced` (باید true باشد).
پایش پایهٔ سرویس (readyz/healthcheck) از ردیف ۲۹ می‌آید
(`GET /api/readyz` و `node scripts/healthcheck.mjs --url=…`).

## ۹. معیارهای توقف (Stop criteria) — خودکار

| # | معیار | آستانه | اگر نقض شد |
|---|---|---|---|
| **S1** | نشت بین‌مستأجری (خواندن/نوشتن/حذف) | ۰ مورد | توقف فوری، بازگشت، گزارش حادثه |
| **S2** | ناهمخوانی reconciliation | ۰ مورد | پایلوت متوقف؛ rollback مقصد |
| **S3** | از دست رفتن دادهٔ منبع | ۰ مورد | توقف؛ بازیابی از پشتیبان منبع |
| **S4** | بازگشت (rollback) خارج از محدودهٔ مستأجر یا > ۵ دقیقه | ۰ خطا | توقف؛ بررسی دستی |
| **S5** | `rls_enforced=false` روی جدول محصول | ۰ مورد | توقف فوری |
| **S6** | مستأجر بدون ردیف یا کهنه‌تر از آستانه | ۰ مورد | هشدار P1/P2، بررسی پیش از ادامه |

اجرای خودکار: `gen-pilot-gate.sh` (خطوط `PILOT-STOP … verdict=PASS|BREACH`).

## ۱۰. Go/No-Go

تصمیم با **مالک** است؛ این runbook فقط دادهٔ تصمیم را تولید می‌کند.
سند تصمیم: `docs/cloud/reports/PILOT-GO-NO-GO.md` — شامل حکم، شرایط، و شاهد هر معیار.

## ۱۱. Escalation

| شدت | چه کسی | چه زمانی |
|---|---|---|
| P0 (S1/S3/S5) | مالک پلتفرم | فوری؛ پایلوت همان لحظه متوقف |
| P1 (S2/S4/S6-empty) | اپراتور پایلوت | ≤ ۱ ساعت؛ بدون تأیید، ادامه ممنوع |
| P2 (کهنگی/کندی) | اپراتور | روز کاری بعد |

## ۱۲. محدودیت‌های صادقانهٔ این دور

- PostgreSQL در دریل **موقت و محلی** است (باینری بیرون از مخزن)، نه خوشهٔ تولیدی.
- دو مستأجر آزمایشی‌اند؛ «۱۰۰ مدرسهٔ واقعی» اثبات نشده است.
- مهاجرت روی دادهٔ کوچک (چند صد ردیف) سنجیده شده؛ زمان مهاجرت در مقیاس بزرگ اندازه‌گیری نشده.
- پیجر/on-call تعریف نشده (BC‑16‑۲)؛ پایش «ابزار» دارد، «مردم» نه.
