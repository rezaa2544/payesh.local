# بستن شرط‌های ردیف ۱۳ (CC‑13‑۱..۴) — دور ۵

| | |
|---|---|
| ردیف صف | **۱۳** — کش امن و صف آفلاین در معماری مقصد (فاز ۲، `Review`) |
| شناسهٔ صفحه | `410ba74e-cd98-81c8-a18e-f2044cc2b946` |
| معیار پذیرش | ۹/۹ (`docs/cloud/13-secure-cache-offline-queue.md` §۸) — در بازبینی Channel 0 (`REVIEW-13.md`) حکم **PASS WITH CORRECTIONS** داشت |
| شرط‌های بسته‌شده | **CC‑13‑۱، CC‑13‑۲، CC‑13‑۳، CC‑13‑۴** (هر چهار شرط باز) |
| SHA مبنا | **`ef2859d91ec0e605585ad6d6a8f382d4a6c17c5c`** (`git rev-parse HEAD` در شروع دور) |
| کد محصول | **۰ فایل** — `git diff --name-only f2fc472 HEAD -- server client tests scripts package.json package-lock.json installer desktop install deploy` = ۰ |
| حکم این دور | **شرط‌ها CLOSED · PASS** (دروازه = `CC13-OK` · کنترل منفی = `NEGATIVE-OK 7/7`) |

> **مرز ادعا:** این سند «Design PASS» را به «Runtime PASS محصول» تبدیل نمی‌کند. F‑07/F‑09 در محصول **باز** می‌مانند؛ آنچه اثبات شد، **رفتار اجرایی در نمونهٔ فنی ۱۸/۲۰‑ب** است که خودِ شرط‌ها آن را «جای اثبات» تعیین کرده بودند.

---

## ۱. چرا ۱۳؟

۱) صف زندهٔ Notion به‌تفکیک وضعیت خوانده شد: `Backlog`/`Ready`/`In Progress`/`Blocked` = **۰ ردیف**؛ تنها ردیف‌های غیر‑`Done`، یازده ردیف `Review` هستند.
۲) ترتیب فاز ۲: ۱۲ → ۱۲‑ب → **۱۳** → ۱۴ → ۱۵ → ۱۶ → ۱۶‑ب. ردیف ۱۲ در دور قبل بسته شد (CC‑12‑1).
۳) از میان ردیف‌های باقی‌مانده، **۱۳ تنها ردیفی است که هر چهار شرط بازش با شاهد اجراییِ موجود (۱۸ + ۲۰‑ب) قابل بستن است و هیچ شرطش به تصمیم مالک گره نخورده** — برخلاف ۰۱‑ب (P‑01b‑۱..۴)، ۱۵ (BC‑15‑۱)، ۱۶ (دو تصمیم مالک) و ۱۶‑ب (BC‑16B‑۱/۲).

---

## ۲. کاری که انجام شد

| # | کار | جای تغییر |
|---|---|---|
| ۱ | پیاده‌سازی منبع بنر «نیازمند بررسی»: getterهای `needsReview` و `banner` (`needs_review` > `queue_full` > `queue_pressure`) | `prototype/slice-18/client-queue.js` |
| ۲ | افزودن ۹ برچسب اجرایی: قرارداد `server_time`/`offset` (پاسخ ۲۰۰، پاسخ ۴۰۱، ساعت یکنوا) + بنرهای فشار صف و نیازمند‑بررسی | `prototype/slice-18/tests/run.js` (۴۰ → ۴۹) |
| ۳ | Manifest برچسب‌های حداقلی هر شرط (۲۴ ردیف، عین متن خروجی آزمون) | `docs/cloud/reports/evidence/cc13-required-labels.txt` |
| ۴ | دروازهٔ fail-closed: اجرای دو نمونه، تطابق SUMMARY با شمارش واقعی، بررسی برچسب‌ها، ثبت هش کد آزمون‌شده | `gen-cc13-evidence.sh` ⇒ `cc13-gate.txt` |
| ۵ | کنترل منفی: ۶ سناریوی شاهد ناقص/جعلی + ۱ کنترل مثبت | `verify-cc13-negative.sh` ⇒ `cc13-negative.txt` |
| ۶ | بازتولید شاهد منتشرشدهٔ نمونهٔ ۱۸ با شمارش تازه | `slice-18-queue-cache.txt` ⇒ `SUMMARY pass=49 fail=0` |

---

## ۳. نگاشت شرط → شاهد (عین شمارش دروازه)

| شرط | برچسب‌های لازم | دیده‌شده | نمونه |
|---|---|---|---|
| **CC‑13‑۱** — `server_time` و قاعدهٔ ساعت (§۳.۲.۳) | ۸ | **۸/۸ ✓** | ۱۸ |
| **CC‑13‑۲** — ثبت `orphaned` سمت سرور، نه فقط `ack_unknown` کلاینت | ۵ | **۵/۵ ✓** | ۱۸ + ۲۰‑ب (`I6`) |
| **CC‑13‑۳** — پنجرهٔ sync-on-revoke پیش از W2 | ۴ | **۴/۴ ✓** | ۱۸ |
| **CC‑13‑۴** — سقف ۲۰۰۰ و بنر «نیازمند بررسی» | ۷ | **۷/۷ ✓** | ۱۸ + ۲۰‑ب (`S6`) |

```
slice-18:  pass=49 fail=0
slice-20b: pass=71 fail=0
CC-13-1 required=8 verified=8
CC-13-2 required=5 verified=5
CC-13-3 required=4 verified=4
CC-13-4 required=7 verified=7
CC13-OK
```

**دروازه چه چیزی را رد می‌کند (کنترل منفی، ۷/۷):** حذف یک برچسب لازم · برچسب با `✗` · SUMMARY ادعایی ناهم‌خوان با بدنه · کد خروج غیرصفر · Manifest با برچسب ناموجود · Manifest غایب — همه با `CC13-FAIL` رد شدند؛ خروجی سالم پذیرفته شد.

---

## ۴. معیارهای پذیرش ۱۳

| AC | موضوع | Design | Runtime (نمونهٔ فنی) |
|---|---|---|---|
| AC‑1 | کش امن با TTL ۷ روز/پایان نشست | PASS | PASS (۱۸: TTL ۷ روز، پایان نشست، wipe تغییر مدرسه) |
| AC‑2 | صف پایدار، idempotent، retry سنجیده | PASS | PASS (۱۸: بازپخش همان `op_id`، ۴۰۹ ordering، `retry_wait`) |
| AC‑3 | بدون حذف خودکار (D‑27) | PASS | PASS (۱۸: ۲۰۰۰/۲۰۰۱ و ماندن قدیمی‌ترین op) |
| AC‑4 | رفع F‑07/F‑09 (در مقصد) | PASS | **PASS در نمونه؛ محصول باز** |
| AC‑5 | بازیابی کرش | PASS | PASS (`ack_unknown` نه `applied`) |
| AC‑6 | کلید محلی طبق تصمیم ۰۳ | PASS | PASS (نابودی کلید = W2) |
| AC‑7 | هم‌راستا با ۰۹ و ۱۲ | PASS | — |
| AC‑8 | `review` پس از ۳۰ روز با حفظ payload و تصمیم ثبت‌شده | PASS | PASS (۳۱ روز ⇒ review، `queue_decision`) |
| AC‑9 | ابطال دستگاه: تعیین تکلیف صف پیش از W2، بدون ACK کاذب | PASS | PASS (آنلاین/آفلاین، `orphaned` + متادیتا) |

**۹/۹ — طرح + شاهد اجرایی.** «F‑07/F‑09 رفع شد» در محصول **ادعا نمی‌شود**.

---

## ۵. دروازه‌های مخزن روی همین SHA

| دروازه | فرمان | نتیجه |
|---|---|---|
| آزمون محصول | `bash docs/cloud/reports/evidence/run-tests-evidence.sh` | `pass=88 fail=0 registered=88 exit=0` |
| دروازهٔ شاهد ممیزی | `bash docs/cloud/reports/evidence/gen-audit-evidence.sh` | **`EVIDENCE-OK`** · `body_sha256=49f64894…` |
| بستن بازبینی | `bash docs/cloud/reports/evidence/gen-review-closure.sh` | **`REVIEW-CLOSURE-OK`** · `checks_passed=13` |
| شرط‌های ۱۳ | `bash docs/cloud/reports/evidence/gen-cc13-evidence.sh` | **`CC13-OK`** |
| کنترل منفی ۱۳ | `bash docs/cloud/reports/evidence/verify-cc13-negative.sh` | **`NEGATIVE-OK`** · `pass=7 fail=0` |
| نمونه‌های ۱۷/۱۸/۱۹/۲۰/۲۰‑ب/۲۱ | `node prototype/slice-<n>/tests/run.js` | `35 / 49 / 44 / 61 / 71 / 58` — همه `fail=0` |

---

## ۶. گام اجرایی بعدی

**۱۴** (P0، فاز ۲، `Review`) — شرط‌های CC‑14‑۱..۵ آن هم به ۱۸/۱۹/۲۰‑ب ارجاع داده شده‌اند و اکنون شاهد اجرایی‌شان موجود است؛ سپس ۱۵ (وابسته به تصمیم مالک در §۶)، ۱۶ (دو تصمیم مالک) و ۱۶‑ب (وابسته به ۱۲ و ۰۱‑ب).

هیچ مأموریت تازه‌ای ساخته نشد، هیچ مرحلهٔ تازه‌ای تعریف نشد و کد محصول تغییر نکرد.
