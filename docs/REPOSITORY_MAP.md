# نقشهٔ مخزن — `rezaa2544/payesh.local`

> مرجع نهایی [قانون اساسی](00-PAYESH-CLOUD-CONSTITUTION.md) است؛ این فایل فقط «کجا چیست» و «چه چیزی با شاهد اثبات شده» را نگه می‌دارد.
> هر پیوند نسبیِ این فایل و هر شاهد پنل مالک با `base_sha=` را گیت `P7_repo_map` در
> [`apps/owner-panel/tests/packaging.test.js`](../apps/owner-panel/tests/packaging.test.js) در `npm test` می‌سنجد (ردیف ۱۰۱).

## ۱. پوشه‌های سطح بالا

| مسیر | چیست | مرز |
|---|---|---|
| [`server/`](../server/) | سرور مدرسه (Node + SQLite): مسیرها، نشست، مجوز، sync، صندوقچهٔ ابری، Gateway | اپ مدرسه |
| [`client/`](../client/) | کلاینت وب مدرسه بدون build (`app.js`، `pages.js`، `pulse.css`) | اپ مدرسه |
| [`desktop/`](../desktop/) · [`installer/`](../installer/) · [`install/`](../install/) | پوستهٔ ویندوز مدرسه، Inno Setup مدرسه، اپ اندروید بومی مدرسه | اپ مدرسه — ردیف ۶۳ |
| [`apps/owner-panel/`](../apps/owner-panel/) | **پنل مالک پلتفرم** — اپ مستقل (بخش ۲) | پنل مالک — ADR‑62 |
| [`db/migrations/`](../db/migrations/) | مهاجرت‌های PostgreSQL مقصد: `owner-panel/` (001–004) و `slice-*` نمونه‌ها | لایهٔ مقصد |
| [`prototype/`](../prototype/) | نمونه‌های عمودی مأموریت‌های ۱۷–۲۱ (نه محصول) | نمونه |
| [`tests/`](../tests/) | آزمون‌های اجرایی؛ `npm test` = [`tests/run.js`](../tests/run.js) | همه |
| [`tools/`](../tools/) · [`scripts/`](../scripts/) · [`bench/`](../bench/) | ابزار شاهد/اندازه‌گیری، ساخت نسخه، بنچمارک | همه |
| [`deploy/`](../deploy/) | استقرار سرور مقصد (env نمونه، بکاپ، پایش) | لایهٔ مقصد |
| [`releases/`](../releases/) | مانیفست نسخه‌ها (commit ربات پس از هر ادغام در main) | اپ مدرسه |
| [`docs/`](./) | `00` قانون اساسی · [`cloud/`](cloud/) اسناد ابری و ADRها · [`cloud/reports/evidence/`](cloud/reports/evidence/) شواهد خام · `01..05` تاریخی | مستند |
| [`.github/workflows/`](../.github/workflows/) | [`build.yml`](../.github/workflows/build.yml) (مدرسه) · [`owner-panel.yml`](../.github/workflows/owner-panel.yml) (پنل مالک) | CI |

## ۲. `apps/owner-panel/` — پنل مالک پلتفرم

مستقل از اپ مدرسه: بدون `client/pages.js`، بدون `server/auth.js`، شناسهٔ نصب جدا (`ir.payesh.owner`، AppId جدا). استثنای WebView فقط برای همین ابزار مدیریتی است (D‑44، [ADR‑62](cloud/62-adr-owner-panel-packaging.md))؛ ردیف ۶۳ و استقلال بومی اپ مدرسه تغییر نمی‌کند.

| مسیر | چیست | ردیف/PR |
|---|---|---|
| [`apps/owner-panel/server/`](../apps/owner-panel/server/) | API `/api/platform/v1` پشت Gateway: `platform-api.js`، `owner-auth.js` (رمز scrypt + TOTP، D‑45)، `openapi.json`، `static-server.js` | PR‑2 · ۹۸ |
| [`apps/owner-panel/web/`](../apps/owner-panel/web/) | SPA فارسی/RTL با تم نبض (`theme.css` از `client/pulse.css`)، بدون CDN/فونت/اسکریپت خارجی | PR‑3 · ۹۸ |
| [`apps/owner-panel/scripts/`](../apps/owner-panel/scripts/) | `gen-theme.js`، `package-web.js` + `zip-lite.js`، `check-owner-artifacts.js` (گیت خروجی‌ها)، `create-operator.js` (حساب اپراتور روی سرور) | PR‑3/4/5 |
| [`apps/owner-panel/tests/`](../apps/owner-panel/tests/) | `platform-api` · `owner-spa` · `owner-login` · `tenant-deletion` · `packaging` (P1–P7) | همه |
| [`apps/owner-panel/android/`](../apps/owner-panel/android/) | پوستهٔ اندروید مالک (`ir.payesh.owner`، فقط INTERNET، same-origin) — خروجی `payesh-owner.apk` فقط امضاشده | PR‑4 · ۹۹ |
| [`apps/owner-panel/desktop/`](../apps/owner-panel/desktop/) · [`apps/owner-panel/installer/`](../apps/owner-panel/installer/) | پوستهٔ ویندوز (WebView2) و Inno Setup مالک — خروجی `payesh-owner-setup.exe` (بدون امضای کد) | PR‑4 · ۹۹ |
| [`db/migrations/owner-panel/`](../db/migrations/owner-panel/) | 001 مدل داده/RLS · 002 API · 003 حذف چهارچشمی + ۲۴ ساعت · 004 ورود (رمز + TOTP، سقف ۳ اپراتور) | PR‑1/2/3 |
| [`.github/workflows/owner-panel.yml`](../.github/workflows/owner-panel.yml) | ساخت exe/APK/وب، گیت fail-closed، SHA256SUMS، انتشار در `owner-continuous` | PR‑4/5 |

## ۳. نقشهٔ راه پنل مالک (هم‌تراز با [سند ۶۱ §۶](cloud/61-owner-panel-app-proposal.md) و صف Notion)

| مرحله | ردیف Notion | PR → ادغام | شاهد | وضعیت |
|---|---|---|---|---|
| PR‑0 پیشنهاد | — | #158 → `7766d06` | [سند ۶۱](cloud/61-owner-panel-app-proposal.md) | Done |
| PR‑1 مدل داده/RLS | — | #160 → `1947d3e` | [owner-panel-pr1-self-review.txt](cloud/reports/evidence/owner-panel-pr1-self-review.txt) | Done |
| PR‑2 API پلتفرم | — | #161 → `66edad0` | [owner-panel-pr2-self-review.txt](cloud/reports/evidence/owner-panel-pr2-self-review.txt) | Done |
| PR‑3 SPA + حذف چهارچشمی | ۹۸ | #162 → `d16aea8` | [owner-panel-pr3-98.txt](cloud/reports/evidence/owner-panel-pr3-98.txt) | Done |
| PR‑3 ورود D‑45 | ۹۸ | #165 → `82def46` | [owner-panel-pr3-98-login.txt](cloud/reports/evidence/owner-panel-pr3-98-login.txt) | Done |
| PR‑4 بسته‌بندی | ۹۹ | #163 → `37aaceb` | [owner-panel-pr4-99.txt](cloud/reports/evidence/owner-panel-pr4-99.txt) | Done |
| PR‑5 لینک‌های README | ۱۰۰ | #166 → `3696837` | [owner-panel-pr5-100-readme.txt](cloud/reports/evidence/owner-panel-pr5-100-readme.txt) | Done |
| PR‑6 نقشه/ROADMAP/Ground Truth | ۱۰۱ | همین PR | [owner-panel-pr6-101-map.txt](cloud/reports/evidence/owner-panel-pr6-101-map.txt) | همین PR |

## ۴. Ground Truth — پنل مالک (فقط آنچه شاهد دارد)

برچسب‌ها: `[M]` ماشینی/کد · `[S]` شاهد خام · `[E]` محیط/اجرا · `[A]` ادعا · `[?]` نامشخص.

| ادعا | شاهد | برچسب |
|---|---|---|
| `npm test` سبز: pass=110 fail=0 | [mission-05-tests-run.log](cloud/reports/evidence/mission-05-tests-run.log) | `[M]` |
| SPA مستقل، هشت صفحه، loading/empty/error، آزمون منفی نقش operator، تم روشن/تیره | [owner-panel-pr3-98.txt](cloud/reports/evidence/owner-panel-pr3-98.txt) | `[M]` |
| اختلاف توکن‌ها (radius/muted/line/primary-2) با آزمون ثبت شده | همان | `[M]` |
| ورود رمز + TOTP، قفل پس از ۵ شکست، سقف ۳ اپراتور در DB | [owner-panel-pr3-98-login.txt](cloud/reports/evidence/owner-panel-pr3-98-login.txt) | `[M]` |
| APK مالک در CI امضاشده و تأییدشده (v2+v3، یک امضاکننده، cert SHA‑256 `d35afba3…0b138321`) | لاگ CI گیت خروجی‌ها + همان شاهد | `[S]` |
| exe مالک بدون امضای کد؛ SmartScreen هشدار می‌دهد | [owner-panel-pr5-100-readme.txt](cloud/reports/evidence/owner-panel-pr5-100-readme.txt) | `[M]` |
| نام لینک‌های README = نام خروجی‌های workflow | `P6_readme_links` | `[M]` |
| ۴ لینک README پس از انتشار `3696837` پاسخ 200 می‌دهند و SHA‑256 دانلودها = `SHA256SUMS`؛ گواهی APK منتشرشده = کلید مالک | [owner-panel-pr6-101-map.txt](cloud/reports/evidence/owner-panel-pr6-101-map.txt) | `[S]` |
| migration 004 و `create-operator.js` روی سرور واقعی اجرا شده | — (کار مالک) | `[?]` NOT-RUN |
| نصب و آزمون روی دستگاه واقعی (ویندوز/اندروید) | — | `[?]` |
| وضعیت امنیتی | پنتست انسانی انجام نشده (§۱۰.۲) | `UNKNOWN` |
| اپ مدرسه، ردیف ۶۳ و `build.yml` از پنل مالک مستقل‌اند | `P5_adr_and_boundary` | `[M]` |
