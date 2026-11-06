# بستن شرط CC-12-1 ردیف ۱۲ — بازتولیدپذیری اثبات RLS (دور ۵)

| | |
|---|---|
| ردیف صف | **۱۲** — معماری چندمستأجری و مرجعیت دیتاسنتر (فاز ۲، **P0**، `Review`) |
| شناسهٔ صفحه | `410ba74e-cd98-8113-b767-d865b3bf85d6` |
| کاری که بسته شد | **CC-12-1** — «نتیجهٔ ۱۴/۱۴ RLS باید بازتولیدپذیر باشد: فرمان، نسخهٔ PG، اسکریپت و خروجی با SHA» |
| SHA مبنا | **`66984432e2566ba2cef400f8db1b6230debc6887`** (`git rev-parse HEAD` در شروع دور) |
| کد محصول | **۰ فایل** — `git diff --name-only f2fc472 HEAD -- server client tests scripts package.json package-lock.json installer desktop install deploy` = ۰ |
| حکم این دور | **CC-12-1 = CLOSED · PASS** (دروازهٔ fail-closed + کنترل منفی ۸/۸) |

> **مرز ادعا:** این سند «Design PASS» را به «Runtime PASS» تبدیل نمی‌کند. محصول امروز **تک‌مستأجری** است (F‑05 باز) و هیچ ادعای ظرفیت/SLA/دروازهٔ امنیتی در این دور مطرح نشده است.

---

## ۱. چرا این ردیف و این شرط؟

۱) صف زندهٔ Notion در این دور دوباره پرس‌وجو شد (به‌تفکیک وضعیت، بدون فیلتر ترکیبی): `Backlog` = ۰، `Ready` = ۰، `In Progress` = ۰، `Blocked` = ۰. تنها ردیف‌های غیر‑`Done`، یازده ردیف `Review` هستند.
۲) در میان ردیف‌های `Review`، **۱۲** بالاترین اولویت (P0) در پایین‌ترین فاز (۲) است و وابستگی‌هایش برآورده‌اند (۰۱‑ب `Review` سند موجود؛ ۱۱ `Review` سند موجود؛ ۲۰‑ب `Done`).
۳) بازبینی مستقل این ردیف (`REVIEW-12-12B.md`) حکم **PASS WITH CONDITIONS** داد و شرط **CC-12-1** را صریحاً «اثبات دیروز برای دروازهٔ فردا کافی نیست؛ بازتولیدپذیری لازم است» نوشت. این شرط در دور قبل **باز** ماند، چون باینری‌های PostgreSQL آن نشست از بین رفته بود.
۴) بنابراین گام اجراییِ واقعی صف، «بستن همین شرط با شاهد بازتولیدپذیر» است — نه مأموریت تازه، نه مرحلهٔ تازه.

---

## ۲. کاری که انجام شد

| # | کار | فایل/ابزار |
|---|---|---|
| ۱ | سخت‌سازی آزمون اجرایی: ثبت **نسخهٔ PG**، **هش SHA-256 هر دو اسکریپت آزمون** و **اثر انگشت درخت محصول** در سرصفحهٔ شاهد | `docs/cloud/reports/evidence/rls-execution-test.sh` |
| ۲ | افزودن `RLS_TEST_OUT` تا شاهد تاریخی (`mission-a-rls-execution.txt` با SHA `0afa729`) **بازنویسی نشود** و شاهد تازه در فایل جدا نوشته شود | همان فایل |
| ۳ | اجرای واقعی روی **PostgreSQL ۱۶.۲** (باینری مستقل، خارج از مخزن، نصب از مسیر PyPI) و تولید ۱۴/۱۴ | `docs/cloud/reports/evidence/mission-12-cc1-rls-repro.txt` |
| ۴ | دروازهٔ **fail-closed** با ۱۱ بررسی: EXIT، خط TOTAL، شمارش واقعی خطوط PASS/FAIL، تطابق نسخهٔ سرصفحه با سرورِ واقعی، هش ابزار، اثر انگشت محصول | `docs/cloud/reports/evidence/gen-cc12-1-evidence.sh` → `cc12-1-gate.txt` |
| ۵ | **کنترل منفی**: ۷ نوع شاهد دست‌کاری‌شده + ۱ کنترل مثبت؛ دروازه نباید PASS بدهد | `docs/cloud/reports/evidence/verify-cc12-1-negative.sh` → `cc12-1-negative.txt` |

**چرا نسخهٔ ۱۶.۲ ارزش اثباتی دارد:** اجرای تاریخی روی PostgreSQL **۱۸.۶** بود؛ این اجرا روی یک **major version مستقل** همان ۱۴ حکم را داد. یعنی نتیجه به نسخهٔ موتور گره نخورده است — چیزی که CC-12-1 دقیقاً می‌خواست.

---

## ۳. شاهد خام — عین اعداد

```
postgres: PostgreSQL 16.2
seed: [{"tenant_id":"1111…","n":10},{"tenant_id":"2222…","n":10}]
PASS  N0  مالک جدول ≠ نقش runtime
PASS  N9  نقش runtime بدون SUPERUSER/BYPASSRLS
PASS  N1  context=A ⇒ فقط ۱۰ ردیف A
PASS  N1b context=A و پرس‌وجوی صریح B ⇒ صفر ردیف
PASS  N2  UPDATE روی B با context=A ⇒ صفر ردیف
PASS  N3  DELETE روی B با context=A ⇒ صفر ردیف
PASS  N4  INSERT با tenant_id=B در context=A ⇒ رد
PASS  N5  UPDATE که tenant را A→B می‌برد ⇒ رد
PASS  N6  بدون context ⇒ صفر ردیف (fail-closed)
PASS  N6b cast خام ''::uuid خطا می‌دهد ⇒ الزام nullif()
PASS  N7  FORCE RLS: مالک هم فقط ۱۰ ردیف A را می‌بیند
PASS  N8  runtime نمی‌تواند SET ROLE payesh_owner
PASS  N10 دو مستأجر پشت‌سرهم روی یک اتصال ⇒ بدون نشت
PASS  N11 هیچ ردیفی از B تغییر/حذف نشد

TOTAL 14 · FAIL 0        EXIT=0
```

| ادعا | مقدار | شاهد |
|---|---|---|
| اجرای ۱۴ حکم روی PG ۱۶.۲ | `14/14`, `EXIT=0` | `mission-12-cc1-rls-repro.txt` |
| دروازه | **`CC12-1-OK`** (۱۱ بررسی) | `cc12-1-gate.txt` |
| کنترل منفی | **`NEGATIVE-OK`** — `pass=8 fail=0` (۷ رد + ۱ قبول کنترل مثبت) | `cc12-1-negative.txt` |
| هش ابزار آزمون (`.cjs`) | `ff515cb5c4652afad9a16bdd5b71d03642ded26488561fbad5c010778b4e1b35` | سرصفحهٔ شاهد |
| هش ابزار آزمون (`.sh`) | `e3760f120eb06b7a1b916a72fde954f93a58b25e0e1a2b26b2dad6a882b671f1` | سرصفحهٔ شاهد |
| اثر انگشت محصول | `6270f8a8ecff7874ec6b24cb7fc24fcce9b62915041d28c97aeeff4851560309` | سرصفحهٔ شاهد = HEAD |

**دستور بازتولید (روی همین SHA):**

```bash
# ۱) باینری PostgreSQL بیرون از مخزن (نمونه: بستهٔ PyPI «pgserver» ⇒ PG 16.2)
python3 -m venv /tmp/pgvenv && /tmp/pgvenv/bin/pip install pgserver
P=/tmp/pgvenv/lib/python3.11/site-packages/pgserver/pginstall
mkdir -p /tmp/pgtest/node_modules/@embedded-postgres/linux-x64/native
ln -sfn $P/bin  /tmp/pgtest/node_modules/@embedded-postgres/linux-x64/native/bin
ln -sfn $P/lib  /tmp/pgtest/node_modules/@embedded-postgres/linux-x64/native/lib
ln -sfn $P/share /tmp/pgtest/node_modules/@embedded-postgres/linux-x64/native/share
(cd /tmp/pgtest && npm init -y && npm install pg)

# ۲) اجرای آزمون و دروازه‌ها (ترتیب اجباری)
RLS_TEST_OUT=docs/cloud/reports/evidence/mission-12-cc1-rls-repro.txt \
  bash docs/cloud/reports/evidence/rls-execution-test.sh          # ⇒ TOTAL 14 · FAIL 0
bash docs/cloud/reports/evidence/gen-cc12-1-evidence.sh           # ⇒ CC12-1-OK
bash docs/cloud/reports/evidence/verify-cc12-1-negative.sh        # ⇒ NEGATIVE-OK
```

---

## ۴. معیارهای پذیرش ردیف ۱۲ — وضعیت به‌تفکیک

| AC | موضوع | Design | Runtime | شاهد |
|---|---|---|---|---|
| ۱ | نمودار معماری + ADR | **PASS** | — (طرح) | `docs/cloud/12-multitenant-architecture.md` §۲–§۳ |
| ۲ | مدل `tenant` (فیلد/کلید/unique) | **PASS** | UNKNOWN | همان، §۲.۱–۲.۶ (`UNIQUE(tenant_id, op_id)` برای `applied_ops`) |
| ۳ | جریان read/write و نقطهٔ عبور واحد | **PASS** | UNKNOWN | §۴.۱ (حذف مسیر دوم نوشتن) |
| ۴ | مرزهای امنیتی: نقش‌های PG، `FORCE RLS`، `nullif()` | **PASS** | **PASS (آزمون مستقل)** | **این دور:** ۱۴/۱۴ روی PG ۱۶.۲ + دروازه |
| ۵ | سوءاستفادهٔ متقابل مستأجر (نشت/نوشتن/تغییر tenant) منفی | **PASS** | **PASS (آزمون مستقل)** | N1…N11 |
| ۶ | بدون فرض ظرفیت بی‌نهایت | **PASS** | — | §۶ + ارجاع به ۰۴/۰۴‑ب |
| ۷ | جداسازی از کد ممیزی‌شده (D‑29) | **PASS** | PASS (۰ فایل تغییر) | diff محصول = ۰ |
| ۸ | وابستگی‌ها و مسیر مهاجرت ثبت‌شده | **PASS** | — | §۳ و §۵ |

**تفسیر دقیق:** AC‑های ۴ و ۵ در **آزمون مستقلِ لایهٔ داده** اثبات شدند (RLS واقعی)، نه از مسیر محصول؛ AC‑های ۲/۳ همچنان **UNKNOWN در Runtime** هستند، چون محصول امروز `tenant_id` ندارد. هیچ‌کدام از این‌ها «رفع F‑05» نیست.

---

## ۵. وضعیت چهار شرط بازبینی

| شرط | وضعیت این دور | توضیح |
|---|---|---|
| **CC-12-1** — بازتولیدپذیری ۱۴/۱۴ | **CLOSED** | اجرای مستقل روی PG ۱۶.۲ + دروازهٔ fail-closed + کنترل منفی ۸/۸ |
| **CC-12-2** — اجرای RLS از مسیر محصول، نه اسکریپت جدا | **PARTIAL — شاهد موجود در ۲۰‑ب** | `prototype/slice-20b` (۷۱/۷۱) دروازهٔ مستأجر را روی **لایهٔ مقصدِ نمونه** اثبات کرد؛ اما آن نمونه، `server/` محصول نیست. **ادعای محصول مطرح نمی‌شود** |
| **CC-12-3** — محیط آزمون بار (O‑07) | **BLOCKED‑ON-OWNER** | بدون تصمیم مالک دربارهٔ محیط/هزینه، «جداسازی زیر بار واقعی» اندازه‌گیری نمی‌شود |
| **CC-12-4** — نام نهایی پوشه‌ها | **وابسته به ۱۶‑ب** (`Review`) | تا نهایی‌شدن ساختار، هیچ مسیر محصولی ساخته/تغییر نمی‌شود |

---

## ۶. گام اجرایی بعدی

۱) **`۱۶‑ب`** (P1، فاز ۲، `Review`) — تنها ردیفی که CC-12-4 به آن گره خورده؛ با بسته‌شدن آن، شرایط ۱۲ کامل می‌شود.
۲) تصمیم مالک برای **O‑07** (محیط آزمون بار) — تنها قفل بیرونیِ باقی‌مانده روی ۱۲.

هیچ مأموریت تازه‌ای در این دور ساخته نشد و هیچ ردیفی به `Done` منتقل نشد؛ تغییر وضعیت فقط با شاهد و اجازهٔ مالک انجام می‌شود.

---

## ۷. دروازه‌های مخزن روی همین SHA (خام)

| دروازه | فرمان | نتیجه |
|---|---|---|
| آزمون محصول | `bash docs/cloud/reports/evidence/run-tests-evidence.sh` | `pass=88 fail=0 registered=88 exit=0` |
| دروازهٔ شاهد ممیزی | `bash docs/cloud/reports/evidence/gen-audit-evidence.sh` | **`EVIDENCE-OK`** · `sha=6698443…` · `body_sha256=49f64894…` |
| بستن بازبینی | `bash docs/cloud/reports/evidence/gen-review-closure.sh` | **`REVIEW-CLOSURE-OK`** · `checks_passed=13` |
| شرط CC-12-1 | `bash docs/cloud/reports/evidence/gen-cc12-1-evidence.sh` | **`CC12-1-OK`** (۱۱ بررسی) |
| کنترل منفی CC-12-1 | `bash docs/cloud/reports/evidence/verify-cc12-1-negative.sh` | **`NEGATIVE-OK`** · `pass=8 fail=0` |
| نمونه‌های ۱۷/۱۸/۱۹/۲۰/۲۰‑ب/۲۱ | `node prototype/slice-<n>/tests/run.js` | `35 / 40 / 44 / 61 / 71 / 58` — همه `fail=0` |

> نکتهٔ محیطی ثبت‌شده: اجرای نخست `npm test` در این نشست ۳۴ خطا داد، چون `node_modules` نصب نبود (`Cannot find module 'jsdom'/'pngjs'/'java-parser'`). پس از `npm ci` همان SHA به `88/0` رسید؛ شاهد ناموفق حذف شد و در سابقهٔ مخزن ثبت نشد. این خطا رگرسیون محصول نبود.
