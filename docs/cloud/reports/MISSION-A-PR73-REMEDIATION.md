# مأموریت A — اصلاح PR #73 و یکپارچگی شواهد

| | |
|---|---|
| دستور | Channel 0 — Control & Integration · تاریخ ۱۴۰۴/۰۸/۱۵ / 2026‑11‑06 |
| HEAD آغازین | `13c44d4a95bdc3d8ee9a813289d9db4d909a1274` |
| SHA پایهٔ ممیزی | `f2fc472c643a52d393b3160405e1581bda64da25` |
| SHA بستهٔ ممیزی | `04e06364992f1a89313fe3b74b6cb45417cbd604` |
| SHA اصلاحات این مأموریت | `__REMEDIATION_SHA__` (C1) — تنها فایل‌های شاهد/گزارش پس از آن |
| تغییر کد محصول | **۰ فایل** (`git diff f2fc472 HEAD -- server client tests installer scripts desktop`) |
| دروازهٔ فاز ۳ | **بسته** |

---

## ۱. خلاصهٔ اجرایی

| سنجه | مقدار |
|---|---|
| یافته‌های بازبینی بررسی‌شده | **۵** (A‑01…A‑05) |
| PASS (اصلاح‌شده + شاهد بازپخش‌پذیر) | **۵** |
| FAIL | **۰** |
| UNKNOWN | **۰** |
| BLOCKED | **۰** (محیط PostgreSQL با بستهٔ embedded تأمین شد و آزمون واقعی اجرا شد) |
| REVIEW (نیازمند بازبینی مستقل انسانی) | **کل PR** |

**ریشهٔ واقعی A‑01:** فایل لاگ آزمون وجود داشت ولی **هرگز commit نشده بود**، چون `.gitignore` خط ۳۴ قاعدهٔ `*.log` دارد. portanto ادعای ۸۸ آزمون در مخزن شاهد نداشت. اصلاح: قاعدهٔ استثنا + افزودن لاگ واقعی + اسکریپت اجرای مجدد + دروازهٔ fail-closed.

**دستاورد فراتر از حداقل:** برای A‑02 فقط اصلاح متن کافی نبود؛ با نصب PostgreSQL واقعی (بستهٔ `@embedded-postgres/linux-x64` در `/tmp`، خارج از مخزن) آزمون اجرایی RLS با نقش runtime واقعی اجرا و **۱۴/۱۴ PASS** ثبت شد.

---

## ۲. تصمیم O‑10 (گزینهٔ A)

| مورد | مقدار |
|---|---|
| تصمیم | **O‑10 = گزینهٔ A** — ادامهٔ توسعه در همان مخزن `rezaa2544/payesh.local` |
| ثبت در Decision Log | **D‑29** در `docs/00-PAYESH-CLOUD-CONSTITUTION.md` §۵ |
| پرسش باز | O‑10 در §۱۱ به «پاسخ داده شد» تغییر کرد |
| مرز کد | §۵.۱ سند ۱۲: «کد پایهٔ ممیزی‌شده» vs «پیاده‌سازی مقصد» + قواعد عدم اختلاط |
| فایل‌های به‌روزشده | قانون اساسی (v1.6) · `12-multitenant-architecture.md` (§۵.۱، §۶) · `PACKAGE-2-3-REPORT.md` |
| پیشنهاد حذف‌شده | «مخزن تازه + قرارداد مشترک» دیگر پیشنهاد جاری نیست |

> این تصمیم **مجوز تغییر معماری تک‌مدرسه‌ای فعلی نیست**؛ فقط محل ساخت را تعیین می‌کند.

---

## ۳. یکپارچگی PR #73

| سنجه | مقدار | شاهد |
|---|---|---|
| فایل‌های تغییرکرده نسبت به پایهٔ ممیزی | **۴۴** (۴۳ افزوده + ۱ تغییر `README.md` + ۰ حذف) | `mission-a-pr73-integrity.txt` |
| فایل‌های تغییرکرده در GitHub | ۴۴ (۴۷۷۵ افزوده / ۰ حذف) | `gh pr view 73 --json files` |
| تغییرات کد محصول | **۰** | همان شاهد، بخش «تغییر کد محصول» |
| SHAهای ذکرشده در اسناد | ۱۳ بررسی شد، **۰ نامعتبر** | همان |
| مسیرهای فایل ارجاع‌شده | ۳۲ بررسی شد، **۰ ناموجود** | همان |
| CI روی HEAD آغازین | `build-and-release` = **CANCELLED** · نصب‌کننده = SKIPPED · CodeRabbit = SKIPPED | `gh run list`, `gh pr view` |
| بازبینی مستقل | ۱ Review با وضعیت `COMMENTED` (کنترل‌پلین) — **نه Approve** | `gh pr view 73 --json reviews` |
| کامنت‌های حل‌نشده | CodeRabbit هیچ بازبینی‌ای اجرا نکرد (repo < ۱۰ ستاره) | همان |

**نکتهٔ اختلاف با دستور:** در دستور «۴۲ فایل» آمده بود؛ شمارش واقعی GitHub و git هر دو **۴۴** است (اختلاف = دو فایل شاهد که در دستور شمرده نشده). ثبت شد، پنهان نشد.

---

## ۴. A‑01 — شاهد خام آزمون‌ها

| مورد | مقدار |
|---|---|
| فرمان | `bash docs/cloud/reports/evidence/run-tests-evidence.sh` → `npm test` (`node --experimental-sqlite --disable-warning=ExperimentalWarning tests/run.js`) |
| SHA اجرا | `13c44d4a95bdc3d8ee9a813289d9db4d909a1274` |
| اثر انگشت کد محصول | `497e1cbda8e733268b0bc8e339f01270f2d910dee84fe2f08a348d632d9272c5` |
| محیط | Linux 6.1.158+ x86_64 · Node v22.22.3 · `payesh-local@0.8.35` |
| زمان | `2026-11-06T17:06:32Z` (UTC) |
| نتیجه | **pass=88 · fail=0 · EXIT=0** — از خود خروجی خام استخراج شده، نه از سند |
| فایل | `docs/cloud/reports/evidence/mission-05-tests-run.log` (اکنون **tracked** در گیت) |

**علت اصلی:** `.gitignore:34` قاعدهٔ `*.log` ⇒ فایل ساخته می‌شد ولی هرگز commit نمی‌شد.
**اصلاح:** استثنای `.gitignore` (`!docs/cloud/reports/evidence/*.log`) + commit واقعی لاگ + اسکریپت اجرای مجدد.

**دروازهٔ fail-closed (اثبات‌شده):**

| حالت | انتظار | نتیجهٔ واقعی |
|---|---|---|
| لاگ وجود ندارد | `exit=3` | ✅ 3 |
| لاگ خراب (`SUMMARY pass=5 fail=2 EXIT=1`) | غیرصفر | ✅ 1 |
| لاگ واقعی | `exit=0` | ✅ 0 |

شاهد: `mission-a-evidence-gate-behaviour.txt` (اسکریپت `verify-evidence-gate-negative.sh`).

**افزوده:** اسکریپت `gen-audit-evidence.sh` بازنویسی شد تا (۱) نبود/خرابی لاگ را به exit غیرصفر تبدیل کند، (۲) ادعای اسناد ۰۵/۱۱ را با عدد واقعی مقایسه کند، (۳) اثر انگشت کد محصول لاگ را با HEAD تطبیق دهد (تا شاهد پس از هر commit مستندات معتبر بماند).

**محدودیت:** اجرا روی محیط sandbox (Linux/Node 22.22.3) است؛ اجرای CI گیت‌هاب شاهد جداگانه دارد و لغو شده بود — نه سبز.

---

## ۵. A‑02 — PostgreSQL RLS

### ۵.۱ اصلاح طراحی

| مورد بازبینی | اصلاح |
|---|---|
| مالکیت جدول | نقش runtime `payesh_app` **غیرمالک**؛ مالکیت فقط `payesh_owner` (NOLOGIN) |
| `BYPASSRLS` | `NOBYPASSRLS` صریح + آزمون N9 |
| `FORCE ROW LEVEL SECURITY` | برای همهٔ جداول tenant‑scoped (§۲.۳) |
| تنظیم context | `set_config('app.tenant_id', $1, true)` به‌جای `SET LOCAL ... = $1` (که پارامتر نمی‌پذیرد) |
| سیاست‌ها | SELECT/INSERT/UPDATE/DELETE جدا + `WITH CHECK` در INSERT/UPDATE |
| استخر اتصال | `is_local=true` + `DISCARD ALL`؛ آزمون نشت روی یک اتصال (N10) |
| fail-closed | context مفقود/خالی/نامعتبر ⇒ صفر ردیف یا خطا؛ بدون fallback |

### ۵.۲ نتیجهٔ آزمون واقعی — **۱۴/۱۴ PASS**

PostgreSQL **18.6** واقعی (بستهٔ `@embedded-postgres/linux-x64@18.6.0-beta.19` در `/tmp`، خارج از مخزن؛ **وابستگی محصول نیست**).

| آزمون | انتظار | نتیجه |
|---|---|---|
| N0 مالکیت جدول | `owner=payesh_owner` | PASS |
| N1 context=A | ۱۰ ردیف | PASS |
| N1b پرس‌وجوی صریح B | ۰ ردیف | PASS |
| N2 UPDATE روی B | ۰ ردیف | PASS |
| N3 DELETE روی B | ۰ ردیف | PASS |
| N4 INSERT با tenant=B | خطای RLS | PASS |
| N5 جابه‌جایی tenant A→B | خطای RLS | PASS |
| N6 بدون context | ۰ ردیف | PASS |
| N6b cast خام `''::uuid` | خطا | PASS |
| N7 مالک جدول (FORCE) | ۱۰ ردیف | PASS |
| N8 `SET ROLE payesh_owner` | رد | PASS |
| N9 SUPERUSER/BYPASSRLS | `false/false` | PASS |
| N10 دو مستأجر روی یک اتصال | ۱۰/۱۰ بدون نشت | PASS |
| N11 صحت دادهٔ B | ۱۰/۱۰ سالم | PASS |

**یافتهٔ تازهٔ آزمون (ثبت در سند ۱۲ §۲.۵):** GUC محلی پس از پایان تراکنش به **رشتهٔ خالی** برمی‌گردد نه `NULL`؛ بنابراین سیاست باید `nullif(current_setting('app.tenant_id', true), '')::uuid` باشد، وگرنه هر پرس‌وجوی بدون context با خطای cast می‌شکند.

**دامنهٔ اثبات:** پایگاه مستقل `payesh_rls`، نه پایگاه محصول و نه کد محصول. یکپارچگی با لایهٔ داده و آزمون نشت محصولی در **۲۰/۲۰‑ب** باقی است (D‑25).
**حکم:** `EXECUTED` برای الگو · `NOT YET PRODUCT-VERIFIED`.

---

## ۶. A‑03 — چرخهٔ اشتراک

| مورد | وضعیت |
|---|---|
| جست‌وجوی `trialing` در مخزن | ۱ مورد در `16b` (گام ۵) — **اشتباه مستندسازی** |
| اصلاح | `draft → provisioning` در گام ۵؛ وضعیت تازه فقط پس از گام ۹ |
| جدول انتقال | §۱.۱ سند ۱۶‑ب: ۱۰ انتقال مجاز با مجوز و شرط |
| انتقال‌های ممنوع | `draft→active`, `provisioning→grace/suspended`, `expired→active`, `canceled→*`, هر انتقال بدون `subscription_event` |
| `trialing` | **حذف شد**؛ اگر دورهٔ آزمایشی لازم شد، در `plan`/`ends_at` بیان شود + تصمیم انسانی O‑14 (وضعیت تازه خودسرانه ممنوع) |
| idempotency | `provision_op_id` یکتا + گام‌های idempotent + ادامه از گام شکست‌خورده |

منبع چرخهٔ مصوب: قانون اساسی §۴.۷ (`draft → provisioning → active → (grace) → suspended → expired | canceled`).

---

## ۷. A‑04 — صف پس از ۳۰ روز

| الزام D‑27 | پیاده‌سازی در سند ۱۳ |
|---|---|
| وضعیت پس از ۳۰ روز | **`review`** (جدید، جدا از `rejected` و `quarantined`) |
| حفظ payload | کامل + `payload_hash`؛ فقط فشرده‌سازی مجاز |
| حذف خودکار | **ممنوع** — `review` تا تصمیم انسان می‌ماند |
| retry خودکار | **ندارد** در `review`/`quarantined` |
| بررسی و تعیین تکلیف | `queue_decision(op_id, actor, action, reason, ts)` + `audit`؛ حل‌کنندهٔ مجاز طبق ماتریس ۰۷ |
| ابطال دستگاه | ترتیب قطعی: W1 → تعیین تکلیف صف → W2 → W3؛ نتیجهٔ نامعلوم = `UNKNOWN`/`ORPHANED`، هرگز ACK |
| هشدار سقف | ۹۰٪ هشدار · ۱۰۰٪ توقف پذیرش جدید (نه حذف) |

وضعیت‌ها: `pending · sending · applied · rejected · conflict · retry_wait · review · quarantined · ack_unknown · orphaned` (۱۰ وضعیت، با جدول معنا و مالک تغییر).

---

## ۸. A‑05 — اعمال O‑10

| فایل | تغییر |
|---|---|
| `docs/00-PAYESH-CLOUD-CONSTITUTION.md` | v1.6 · **D‑29** در Decision Log · O‑10 در §۱۱ = پاسخ‌داده‌شده · بند «مرز مخزن» در §۴.۱ |
| `docs/cloud/12-multitenant-architecture.md` | §۵.۱ مرز کد پایه/مقصد (با قید «نام نهایی پس از بررسی build/CI») · §۶ O‑10 = تصمیم‌گرفته |
| `docs/cloud/reports/PACKAGE-2-3-REPORT.md` | O‑10 حذف از فهرست تصمیم‌های باز · به‌روزرسانی حکم‌ها |

**قیدهای حفظ‌شده:** ساختار پیشنهادی (`cloud/`, `platform/`, `packages/contracts/`) صریحاً **پیشنهاد** است تا وابستگی‌های `package.json`/`Dockerfile`/CI/`installer` بررسی و نام نهایی تصویب شود.

---

## ۹. ماتریس شواهد

| شناسه | نتیجه | شاهد | SHA | فرمان | زمان (UTC) | محیط | مسیر |
|---|---|---|---|---|---|---|---|
| A‑01 | **PASS** | لاگ خام ۸۸/۰/EXIT=0 | `13c44d4` + اثر انگشت `497e1cb…` | `bash …/run-tests-evidence.sh` | 2026‑11‑06T17:06:32Z | Linux x86_64 · Node 22.22.3 | `docs/cloud/reports/evidence/mission-05-tests-run.log` |
| A‑01‑neg | **PASS** | ۳/۳ حالت (missing/corrupt/ok) | همان | `bash …/verify-evidence-gate-negative.sh` | 2026‑11‑06T17:07Z | همان | `…/mission-a-evidence-gate-behaviour.txt` |
| A‑01‑gate | **PASS** | MATCH: بله · EVIDENCE-OK | HEAD جاری | `bash …/gen-audit-evidence.sh` | جاری | همان | `…/mission-05-11-structure.txt` |
| A‑02 | **PASS** (اجرا) | ۱۴/۱۴ آزمون RLS | HEAD جاری | `bash …/rls-execution-test.sh` | 2026‑11‑06T17:1xZ | PG 18.6 · node‑pg 8 | `…/mission-a-rls-execution.txt` |
| A‑03 | **PASS** (سند) | §۱.۱ جدول انتقال + حذف `trialing` | HEAD جاری | `grep -rn trialing docs/` | — | — | `docs/cloud/16b-…md` |
| A‑04 | **PASS** (سند) | §۳.۲/۳.۲.۱/۳.۲.۲ | HEAD جاری | `sed -n '/۳.۲/…'` | — | — | `docs/cloud/13-…md` |
| A‑05 | **PASS** (سند) | D‑29 + §۵.۱ + O‑10 | HEAD جاری | `grep -n 'D‑29' docs/00-…md` | — | — | قانون اساسی، سند ۱۲، گزارش بسته |
| PR‑INT | **PASS** | ۴۴ فایل · ۰ کد محصول · ۱۳ SHA · ۳۲ مسیر | `f2fc472..HEAD` | `bash …/review-pr73-integrity.sh` | جاری | — | `…/mission-a-pr73-integrity.txt` |
| CI | **NOT GREEN** | `CANCELLED` روی `13c44d4` | `13c44d4` | `gh run list` | — | GitHub Actions | — |
| Notion | **PASS/بخش‌ی** | یادداشت‌های A‑01…A‑05 + O‑10 | — | — | — | Notion API | بخش ۱۰ |

---

## ۱۰. ریسک‌های باقی‌مانده

| # | ریسک | وضعیت |
|---|---|---|
| R1 | RLS در **کد محصول** یکپارچه نشده (فقط الگو اثبات شد) | باز — مالک: ۲۰‑ب |
| R2 | F‑04/F‑06 (کلید Storage در کلاینت، مسیر دوم نوشتن) هنوز در کد | باز — P0، پیش از هر نمونه‌سازی |
| R3 | CI روی HEAD آغازین Cancelled بود؛ پس از این push باید سبز/قرمز واقعی ثبت شود | در حال بررسی |
| R4 | تکرارپذیری آزمون RLS به باینری embedded در `/tmp` وابسته است؛ در محیط بدون آن ⇒ `BLOCKED` (نه PASS) | مستند |
| R5 | بستهٔ PostgreSQL ۱۸.۶ **beta** است؛ برای آزمون الگو کافی، برای production باید نسخهٔ پایدار تأیید شود | مستند |
| R6 | تصمیم‌های باز تجاری/محیطی (O‑07, O‑09, O‑14, O‑15, O‑17, O‑18, P‑01b) | باز — نیازمند انسان |
| R7 | ادعای «۴۲ فایل» در دستور با واقعیت «۴۴» اختلاف داشت | ثبت شد |

---

## ۱۱. پیشنهاد

**`READY FOR INDEPENDENT REVIEW`** — با قیدهای صریح:
- CI روی SHA نهایی باید دیده و ثبت شود (سبز/قرمز؛ لغو‌شده = سبز نیست).
- A‑02 در سطح الگو اثبات شده، نه در محصول.
- Gate فاز ۳ **بسته** است و این مأموریت آن را باز نمی‌کند.

**MERGE توسط Arena انجام نمی‌شود.**
