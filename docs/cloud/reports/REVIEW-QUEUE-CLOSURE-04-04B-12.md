# بستن صف — تصمیم‌های مالک (D‑30…D‑33) و شرایط ردیف ۱۲

| | |
|---|---|
| ردیف‌ها | **۰۴** (`410ba74e-cd98-81cd-9bca-e6ebf1f8ad5f`) · **۰۴‑ب** (`410ba74e-cd98-8101-98c6-c09dd074d91b`) · **۱۲** (`410ba74e-cd98-8113-b767-d865b3bf85d6`) |
| ورودی | صف زنده: تنها سه ردیف غیر‑`Done` مانده بود؛ هر سه منتظر تصمیم مالک یا شاهد تازه |
| تصمیم‌های مالک (۱۴۰۴/۰۸/۱۶) | **D‑30** O‑06 تأیید سناریوهای ۱۰/۵۰/۲۰۰ · **D‑31** O‑07 محیط آزمون = محلی موقت · **D‑32** O‑14 سقف پلن‌ها = الف · **D‑33** O‑18 قیمت‌گذاری = ج |
| شاهد تازه | نخستین **سنجش واقعی poll روی خود محصول** (بدون تغییر کد): خط پایهٔ ۳۸۴ دستگاه روی ۲ vCPU |
| کد محصول | **۰ فایل** (`git diff f2fc472 HEAD -- server client tests scripts …` خالی) |
| دروازه | `CC12-CLOSURE-OK` (۱۸ بررسی) · کنترل منفی `NEGATIVE-OK` ۱۴/۱۴ |

> **مرز ادعا:** این دور «ظرفیت» یا «مقیاس تولیدی» نمی‌سازد. اعداد، خط پایهٔ **یک میزبان محلی تک‌مستأجری** هستند؛ F‑04/F‑06 باز می‌مانند و Gate فاز ۳ بسته است.

---

## ۱. کاری که انجام شد

| # | کار | شاهد |
|---|---|---|
| ۱ | ثبت پاسخ مالک به چهار پرسش باز در Decision Log و جدول §۱۱ قانون اساسی (D‑30…D‑33) | `docs/00-PAYESH-CLOUD-CONSTITUTION.md` |
| ۲ | ساخت **ابزار سنجش بار واقعی**: سرور محصول را با پوشهٔ دادهٔ موقت بالا می‌آورد، مدیر می‌سازد و K «دستگاه» با الگوی poll هر ۱ ثانیه به `/api/v1/pull` می‌فرستد؛ p50/p95/p99/خطا/CPU/RPS | `docs/cloud/reports/evidence/bench-poll-load.cjs` |
| ۳ | اجرای پویش کامل ۱→۷۶۸ دستگاه + سه تکرار در سطح زانو | `mission-12-cc3-load-baseline.txt` |
| ۴ | ثبت خط پایه در سند ۰۴ (§۲.۱) و ارتقای حکم ۰۴ به **۱۴/۱۴ PASS (طراحی)** | `docs/cloud/04-capacity-and-availability.md` |
| ۵ | ثبت تصمیم O‑14/O‑18 در سند ۰۴‑ب و ارتقای حکم به **PASS (طراحی)** | `docs/cloud/04b-plan-caps-usage-model.md` |
| ۶ | بستن **CC‑12‑3** (محیط بار) و **CC‑12‑4** (نقشهٔ نهایی مسیرها از ۱۶‑ب) و نگه‌داشتن **CC‑12‑2** به‌صورت صریح `PARTIAL` | `docs/cloud/12-multitenant-architecture.md` §۶.۱ |
| ۷ | دروازهٔ fail-closed + کنترل منفی | `gen-cc12-closure.sh` · `verify-cc12-closure-negative.sh` |

## ۲. شاهد خام

```
$ node docs/cloud/reports/evidence/bench-poll-load.cjs --devices=1,8,32,96,192,384,768 --seconds=6
BENCH devices=1   ... errors=0 p95_ms=6    rps=1.0
BENCH devices=8   ... errors=0 p95_ms=12   rps=8.0
BENCH devices=32  ... errors=0 p95_ms=51   rps=31.9
BENCH devices=96  ... errors=0 p95_ms=158  rps=95.5
BENCH devices=192 ... errors=0 p95_ms=244  rps=190.0
BENCH devices=384 ... errors=0 p95_ms=486  rps=380.1     ← خط پایهٔ محافظه‌کارانه
BENCH devices=768 ... errors=0 p95_ms=914  rps=661.4
BENCH-CAP max_ok_devices=768 threshold_ms=1000

$ (سه تکرار در سطح ۷۶۸)
BENCH devices=768 ... p95_ms=1628 · 1582 · 1572   ← زانو تأیید شد
```

`bash docs/cloud/reports/evidence/gen-cc12-closure.sh` ⇒ `CC12-CLOSURE-OK` (`cap=768`, `p95@384=486ms`, `knee=1572..1628ms`)
`bash docs/cloud/reports/evidence/verify-cc12-closure-negative.sh` ⇒ `NEGATIVE-OK` (۱۴/۱۴؛ ۱۳ شاهد دست‌کاری‌شده رد شد)

## ۳. وضعیت نهایی ردیف‌ها

| ردیف | پیش از دور | پس از دور |
|---|---|---|
| **۰۴** | ۱۲/۱۲ `REVIEW` (O‑06 باز) | **۱۴/۱۴ `PASS`** — O‑06 با D‑30 بسته، گلوگاه poll اندازه‌گیری‌شده |
| **۰۴‑ب** | ۹/۹ `REVIEW` (O‑14/O‑18 باز) | **۹/۹ `PASS`** — O‑14 = الف (D‑32)، O‑18 = ج (D‑33) |
| **۱۲** | ۸/۸ `REVIEW`؛ شرایط ۱/۴ بسته | **۸/۸ `PASS` (طراحی)**؛ شرایط **۳/۴** بسته — تنها **CC‑12‑2** باز می‌ماند |

**چرا CC‑12‑2 بسته نشد:** «اجرای RLS از مسیر محصول» به **تغییر `server/`** نیاز دارد و Gate فاز ۳ بسته است. هر ادعای خلاف این، ادعای محصول بدون محصول می‌شد؛ پس صریحاً `PARTIAL` ثبت شد.

## ۴. مرز صداقت

- اعداد bar=single-host/single-tenant هستند؛ هیچ SLA/HA/ظرفیت تولیدی استخراج نشد.
- `F‑04` (کلید ابر در کلاینت) و `F‑06` (مسیر دوم نوشتن) **باز** و روی HEAD بازاثبات‌شده‌اند.
- وضعیت امنیتی طبق §۱۰.۲: `UNKNOWN`.
- «PASS طراحی» هر سه ردیف یعنی معیار پذیرش در سطح سند+شاهد برآورده است، نه آمادگی عملیاتی.

---

`docs/cloud/reports/REVIEW-QUEUE-CLOSURE-04-04B-12.md` · دروازه: `cc12-closure-gate.txt` · کنترل منفی: `cc12-closure-negative.txt`
