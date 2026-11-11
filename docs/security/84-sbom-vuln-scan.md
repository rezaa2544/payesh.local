# ردیف ۸۴ — SBOM در هر build و اسکن آسیب‌پذیری با آستانهٔ شکست

| | |
|---|---|
| ابزار | `tools/osv-scan-84.mjs` (بدون وابستگی؛ Node 20+) |
| سیاست و استثناها | `tools/osv-policy-84.json` |
| SBOM | `tools/sbom-95.mjs` (CycloneDX 1.5، ردیف ۹۵) — npm **و** pub |
| آزمون | `node tests/vuln-scan-84.js` ⇒ `VULN-84-OK checks=15` |
| کنترل منفی npm audit | `tests/security-scan-48.js` SS-11 / SS-11b |
| CI | `build.yml` (هر build) · `release-gate.yml` (job `sbom`) |
| شاهد [S] | `docs/cloud/reports/evidence/vuln-84.txt`، `vuln-84-osv-report.json` |

## ۱) چه چیزی اسکن می‌شود

1. در **هر build** (`build-and-release`، هر push روی main و شاخه‌های `arena/**`) و در دروازهٔ انتشار
   (`release-gate`) یک SBOM با قالب CycloneDX از قفل‌فایل‌های عرضه‌شونده ساخته می‌شود:
   `package-lock.json` (سرور/کلاینت وب) و `apps/payesh/pubspec.lock` (کلاینت بومی Flutter).
   این SBOM به‌صورت artifact (`sbom-84` / `sbom`) با SHA-256 نگه‌داری می‌شود.
2. هر جزء رجیستری (npm و pub.dev) در پایگاه **OSV** (`api.osv.dev`، همان منبع `osv-scanner`)
   پرس‌وجو می‌شود. `npm audit` فقط npm را می‌بیند؛ OSV بستهٔ Dart/Flutter را هم پوشش می‌دهد.
   جزءهای path/sdk (بسته‌های درون مخزن و SDK فلاتر) در OSV نیستند و فقط شمرده می‌شوند (`not_in_osv`).
3. `npm audit` همچنان در دروازهٔ ردیف ۴۸ اجرا می‌شود (G1: صفر high/critical در وابستگی تولیدی؛
   G2: یافتهٔ dev فقط با مدخل allowlist دارای دلیل و `expires`).

## ۲) آستانهٔ شکست

| دسته | آستانه | توضیح |
|---|---|---|
| جزء عرضه‌شده (`scope=required`) | **HIGH و بالاتر ⇒ قرمز** (OSV-01) | هر چیزی که در APK/EXE/سرور می‌رود |
| جزء dev/CI (`scope=excluded`) | **CRITICAL ⇒ قرمز** (OSV-02) | HIGH گزارش می‌شود ولی build را نمی‌بندد؛ ردیف ۴۸ هم npm dev را جدا تریاژ می‌کند |
| شدت نامعلوم | مثل HIGH (OSV-03) | هیچ آگهی بی‌امتیازی بی‌صدا رد نمی‌شود |
| OSV در دسترس نیست / پاسخ خراب | exit 2 ⇒ قرمز (OSV-05) | fail-closed؛ پاسخ صفحه‌بندی‌شده هم پذیرفته نمی‌شود |
| آگهی withdrawn | نادیده | |

شدت: اول برچسب GHSA (`database_specific.severity` — همان چیزی که npm audit نشان می‌دهد)، سپس بالاترین
امتیاز CVSS v3.x که خود ابزار طبق فرمول FIRST حساب می‌کند (VS-01 با بردارهای مرجع).

## ۳) استثنای مستند

استثنا فقط در `tools/osv-policy-84.json` و فقط به این شکل:

```json
{ "id": "GHSA-xxxx-xxxx-xxxx", "package": "name", "reason": "چرا قابل‌قبول است (حداقل ۲۰ نویسه)",
  "owner": "چه کسی پاسخ‌گوست", "expires": "YYYY-MM-DD" }
```

- `id` یک آگهی مشخص است (GHSA، CVE یا شناسهٔ OSV؛ alias هم پذیرفته می‌شود) برای **یک** بسته — استثنای کلی بسته وجود ندارد.
- `expires` حداکثر `max_exception_days` (۹۰) روز جلوتر؛ بعد از آن استثنا دیگر چیزی را پنهان نمی‌کند (VS-05).
- استثنای ناقص (بی‌مالک، دلیل کوتاه، تاریخ نامعتبر/دور) خودش دروازه را قرمز می‌کند (OSV-04، VS-06).
- استثنایی که با هیچ یافته‌ای جور نیست با `STALE` گزارش می‌شود تا حذف شود (VS-11).
- وضعیت فعلی: **صفر استثنا** در OSV و **صفر مدخل** در `tools/deps-allowlist.json` (ردیف ۴۸).

## ۴) آنچه در این ردیف اصلاح شد

`npm audit` پیش از این ردیف ۷ یافتهٔ HIGH در زنجیرهٔ dev (`java-parser → chevrotain → lodash-es/lodash`)
داشت که با allowlist تا 2026-12-31 پذیرفته شده بود (Code Injection در `_.template` و Prototype Pollution
در `_.unset/_.omit`). اکنون `package.json` با `overrides` نسخهٔ `lodash` و `lodash-es` را روی 4.18.1
(اصلاح‌شده، سازگار با 4.x) می‌گذارد؛ `npm audit` ⇒ `found 0 vulnerabilities` و مدخل‌های allowlist حذف شدند.
چون درخت واقعی دیگر یافته ندارد، کنترل منفی ردیف ۴۸ (SS-11) حالا خودش یک وابستگی عمداً آسیب‌پذیر را در
کپی موقت `package-lock.json` تزریق می‌کند.

## ۵) آزمون منفی با وابستگی عمداً آسیب‌پذیر

`tests/fixtures/vuln-84/` قفل‌فایل‌هایی با وابستگی‌های عمداً آسیب‌پذیر دارد (فقط داده؛ هرگز نصب نمی‌شوند):

| بسته | اکوسیستم | scope | آگهی | انتظار |
|---|---|---|---|---|
| lodash 4.17.15 | npm | عرضه‌شده | GHSA-35jh-r3h4-6jhm و … (HIGH) | قرمز OSV-01 |
| dio 4.0.0 | pub | عرضه‌شده | GHSA-9324-jv53-9cc8 / CVE-2021-31402 (HIGH) | قرمز OSV-01 |
| minimist 1.2.5 | npm | dev | GHSA-xvch-5gv4-984h (CRITICAL) | قرمز OSV-02 |
| collection 1.19.1 | pub | — | — | بدون یافته |
| lodash 4.18.1 (`clean-package-lock.json`) | npm | عرضه‌شده | — | سبز |

- در CI همین fixture با OSV **زنده** و `--expect-fail` اجرا می‌شود؛ اگر دروازه آن را رد نکند job قرمز است.
- آزمون‌های آفلاین با پاسخ ضبط‌شدهٔ OSV (`osv-recorded.json`) اجرا می‌شوند تا بدون شبکه هم قابل تکرار باشند.

## ۶) اجرا

```bash
node tools/sbom-95.mjs --out sbom.cdx.json
node tools/osv-scan-84.mjs --sbom sbom.cdx.json --out osv-84-report.json     # 0 سبز · 1 قرمز · 2 خطای زیرساخت
node tools/osv-scan-84.mjs --root tests/fixtures/vuln-84 --lock npm:package-lock.json --lock pub:pubspec.lock --expect-fail
node tests/vuln-scan-84.js            # VULN84_REQUIRE_LIVE=1 در CI: بدون OSV ⇒ قرمز
```

## ۷) مرز ARENA / OWNER

- همه‌چیز این ردیف در CI و بدون راز اجرا می‌شود؛ هیچ کلید یا توکنی لازم نیست (API عمومی OSV).
- **OWNER**: تأیید هر استثنای آینده (فیلد `owner`) و تصمیم دربارهٔ Dependabot/اعلان ایمیلی GitHub (تنظیمات مخزن).
