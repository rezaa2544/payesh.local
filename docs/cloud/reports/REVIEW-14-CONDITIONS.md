# بستن شرط‌های ردیف ۱۴ (CC‑14‑۱..۵) — دور ۵

| | |
|---|---|
| ردیف صف | **۱۴** — تعارض، هم‌گرایی و «نیازمند تصمیم» (فاز ۲، **P0**، `Review`) |
| شناسهٔ صفحه | `410ba74e-cd98-81cd-977f-f3009c9b28da` |
| معیار رسمی | ۱۱/۱۱ AC (`docs/cloud/14-conflict-convergence.md` §۸) — بازبینی Channel 0 (`REVIEW-14.md`): **PASS WITH CORRECTIONS** + پنج شکاف امروز (E‑14‑۱..۵) |
| شرط‌های بسته‌شده | **CC‑14‑۱، CC‑14‑۲، CC‑14‑۳، CC‑14‑۴، CC‑14‑۵** (هر پنج شرط باز) |
| SHA مبنا | **`28e52782b18113e870cd32b0ca388de755051be0`** (`git rev-parse HEAD` در شروع دور؛ = `origin/main`) |
| کد محصول | **۰ فایل** — `git diff --name-only f2fc472 HEAD -- server client tests scripts package.json package-lock.json installer desktop install deploy` = ۰ |
| حکم این دور | **شرط‌ها CLOSED · PASS** (دروازه `CC14-OK` · کنترل منفی `NEGATIVE-OK 7/7`) |

> **مرز ادعا:** F‑08 (server‑wins + LWW بی‌قید در محصول) **باز** است. آنچه اثبات شد، رفتار **مقصد** در نمونهٔ فنی ۱۹ است — همان «جای اثبات»ی که شرط‌ها تعیین کرده بودند.

---

## ۱. چرا ۱۴؟

۱) صف زندهٔ Notion: `Backlog`/`Ready`/`In Progress`/`Blocked` = ۰؛ ردیف‌های غیر‑`Done` همه `Review` هستند.
۲) ترتیب فاز ۲: ۱۲ → ۱۲‑ب → ۱۳ → **۱۴** → ۱۵ → ۱۶ → ۱۶‑ب؛ ۱۲ و ۱۳ در دورهای قبل بسته شدند.
۳) **۱۴ بالاترین اولویت (P0) بین ردیف‌های باقی‌مانده با شرط اجراپذیر است**؛ پنج شرطش صریحاً به «۱۸/۲۰‑ب» ارجاع داشتند و هیچ‌کدام به تصمیم مالک گره نخورده‌اند (برخلاف ۰۱‑ب، ۱۵، ۱۶، ۱۶‑ب).

---

## ۲. کاری که انجام شد

| # | کار | جای تغییر |
|---|---|---|
| ۱ | افزودن ۴ برچسب اجرایی: audit تلاش بازنده (`conflict.open` با `op_id`)، پیوستگی زنجیرهٔ `prev_hash`، حفظ دو نسخه **پس از حل**، حذف‌نشدن ردیف تعارض پس از حل | `prototype/slice-19/tests/run.js` (۴۴ → ۴۸) |
| ۲ | Manifest ۲۹ برچسب حداقلی برای پنج شرط (عین متن خروجی آزمون) | `docs/cloud/reports/evidence/cc14-required-labels.txt` |
| ۳ | دروازهٔ fail-closed: اجرای نمونه، تطابق SUMMARY با شمارش واقعی، بررسی برچسب‌ها، ثبت هش کد آزمون و اثر انگشت محصول | `gen-cc14-evidence.sh` ⇒ `cc14-gate.txt` |
| ۴ | کنترل منفی: ۶ سناریوی شاهد ناقص/جعلی + ۱ کنترل مثبت | `verify-cc14-negative.sh` ⇒ `cc14-negative.txt` |
| ۵ | بازتولید شاهد منتشرشدهٔ نمونهٔ ۱۹ | `slice-19-conflict.txt` ⇒ `SUMMARY pass=48 fail=0` |
| ۶ | ثبت بستن شرط‌ها در سند طراحی | `docs/cloud/14-conflict-convergence.md` §۹ + وضعیت سرصفحه |

---

## ۳. نگاشت شرط → شاهد (شمارش دروازه)

| شرط | شکاف امروز (FAIL فعلی) | برچسب لازم | دیده‌شده |
|---|---|---|---|
| **CC‑14‑۱** | server‑wins و دورریختن نسخهٔ محلی | ۶/۶ | **۶** |
| **CC‑14‑۲** | حذف خاموش op بازنده | ۵/۵ | **۵** |
| **CC‑14‑۳** | LWW بی‌قید (`base_version` غایب/صفر) | ۴/۴ | **۴** |
| **CC‑14‑۴** | دورزدن مجوز + نشت مقدار در پاسخ تعارض | ۸/۸ | **۸** |
| **CC‑14‑۵** | نبود audit برای تلاش بازنده | ۶/۶ | **۶** |

```
slice-19: pass=48 fail=0
CC-14-1 required=6 verified=6
CC-14-2 required=5 verified=5
CC-14-3 required=4 verified=4
CC-14-4 required=8 verified=8
CC-14-5 required=6 verified=6
CC14-OK
```

**کنترل منفی (۷/۷):** حذف یک برچسب · برچسب با `✗` · SUMMARY ناهم‌خوان با بدنه · کد خروج غیرصفر · Manifest با برچسب ناموجود · Manifest غایب ⇒ همه `CC14-FAIL`؛ خروجی سالم پذیرفته شد.

---

## ۴. معیارهای پذیرش ۱۴ (طرح در برابر اجرا)

| AC | موضوع | Design | Runtime (نمونهٔ فنی ۱۹) |
|---|---|---|---|
| AC‑1 | هر دو نسخه حفظ می‌شوند | PASS | **PASS** (در همان ردیف، پس از حل و پس از `orphaned`) |
| AC‑2 | تصمیم‌گیرندهٔ مجاز | PASS | **PASS** (۴۰۳ نقش/اسکوپ + حل مجاز با اسناد تصمیم) |
| AC‑3 | `base_version` | PASS | **PASS** (`base_version_required`، رد `0` روی ردیف موجود) |
| AC‑4 | audit کامل | PASS | **PASS** (زنجیرهٔ `prev_hash` + `audit_id` + `raised_by_op_id`) |
| AC‑5 | رفع F‑08 | PASS (در مقصد) | **PASS در نمونه؛ محصول باز** (پروب N1 نشان داد امروز server‑wins است) |
| AC‑6 | هم‌گرایی/ترتیب | PASS | **PASS** (determinism ترتیب فیلدها + idempotency بازپخش) |
| AC‑7 | تعامل با ابطال/صف | PASS | **PASS** (`orphaned` پس از W2، بدون حذف) |
| AC‑8 | قواعد per‑entity قابل آزمون | PASS | **PASS** (parity ۱۰/۱۰ با ماتریس §۲.۱) |
| AC‑9 | بدون LWW بی‌توجیه | PASS | **PASS** |
| AC‑10 | بدون دورزدن مجوز در مسیر تعارض | PASS | **PASS** (پاسخ فقط متادیتا، مجوزدهی دوباره در حل) |
| AC‑11 | audit trail پایدار | PASS | **PASS** |

---

## ۵. دروازه‌های مخزن روی همین SHA

| دروازه | فرمان | نتیجه |
|---|---|---|
| آزمون محصول | `bash docs/cloud/reports/evidence/run-tests-evidence.sh` | `pass=88 fail=0 registered=88 exit=0` |
| دروازهٔ شاهد ممیزی | `bash docs/cloud/reports/evidence/gen-audit-evidence.sh` | **`EVIDENCE-OK`** |
| بستن بازبینی | `bash docs/cloud/reports/evidence/gen-review-closure.sh` | **`REVIEW-CLOSURE-OK` 13/13** |
| شرط‌های ۱۴ | `bash docs/cloud/reports/evidence/gen-cc14-evidence.sh` | **`CC14-OK`** |
| کنترل منفی ۱۴ | `bash docs/cloud/reports/evidence/verify-cc14-negative.sh` | **`NEGATIVE-OK` 7/7** |
| نمونه‌ها | `node prototype/slice-<n>/tests/run.js` | `۳۵ / ۴۹ / ۴۸ / ۶۱ / ۷۱ / ۵۸` — همه `fail=0` |

---

## ۶. گام اجرایی بعدی

**۱۵** (P1، فاز ۲) — شرط `BC‑15‑۱` آن **BLOCKED‑ON‑OWNER** است (انتخاب «snapshot یا replica آفلاین»)، پس قبل از آن ردیف **۱۲‑ب** (P0، فاز ۲، `PASS WITH CORRECTIONS` بدون شرط بازِ باقی‌مانده) برای بسته‌شدن نهایی بررسی می‌شود؛ سپس ۱۶ (دو تصمیم مالک) و ۱۶‑ب.

هیچ مأموریت یا مرحلهٔ تازه‌ای ساخته نشد و کد محصول تغییر نکرد.
