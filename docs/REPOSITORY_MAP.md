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
| [`apps/payesh/`](../apps/payesh/) | **اپ بومی مدرسه** (Flutter/Dart، Android + Windows، بدون WebView و Node) — بخش ۶ | اپ مدرسه — ADR‑43 / D‑43 |
| [`apps/owner-panel/`](../apps/owner-panel/) | **پنل مالک پلتفرم** — اپ مستقل (بخش ۲) | پنل مالک — ADR‑62 |
| [`db/migrations/`](../db/migrations/) | مهاجرت‌های PostgreSQL مقصد: `owner-panel/` (001–004)، [`direct/`](../db/migrations/direct/) (مسیر مستقیم ADR‑105، 0001–0007، ردیف‌های ۸۰/۸۲/۸۶/۱۰۶–۱۰۹) و `slice-*` نمونه‌ها · [`db/fixtures/`](../db/fixtures/) | لایهٔ مقصد |
| [`prototype/`](../prototype/) | نمونه‌های عمودی مأموریت‌های ۱۷–۲۱ (نه محصول) | نمونه |
| [`tests/`](../tests/) | آزمون‌های اجرایی؛ `npm test` = [`tests/run.js`](../tests/run.js) | همه |
| [`tools/`](../tools/) · [`scripts/`](../scripts/) · [`bench/`](../bench/) | ابزار شاهد/اندازه‌گیری، ساخت نسخه، بنچمارک | همه |
| [`deploy/`](../deploy/) | استقرار سرور مقصد (env نمونه، بکاپ، پایش) | لایهٔ مقصد |
| [`site/`](../site/) | صفحهٔ ایستای دانلود/به‌روزرسانی `payeshschool.ir` روی GitHub Pages (بدون سرور، بدون Cloudflare)؛ ساخت با `tools/landing-114.mjs` — [سند ۱۱۴](cloud/114-landing-pages-dns.md) | انتشار — ردیف ۱۱۴ |
| [`releases/`](../releases/) | مانیفست نسخه‌ها (commit ربات پس از هر ادغام در main) | اپ مدرسه |
| [`samples/`](../samples/) · `data/` (git-ignored، در زمان اجرا ساخته می‌شود) | نمونهٔ CSV ورود دسته‌ای · دادهٔ محلی اجرا، مثل کلید عمومی پشتیبان (`backup-key.json`، بدون راز) | اپ مدرسه |
| [`openapi.yaml`](../openapi.yaml) | قرارداد API؛ هم‌خوانی با کد را `tests/openapi-drift-81.js` می‌سنجد (ردیف ۸۱) | قرارداد |
| [`docs/`](./) | `00` قانون اساسی · [`cloud/`](cloud/) اسناد ابری و ADRها · [`cloud/contracts/`](cloud/contracts/) قراردادهای ماشین‌خوان · [`security/`](security/) · [`release/`](release/) · [`cloud/reports/evidence/`](cloud/reports/evidence/) شواهد خام · `01..05` تاریخی | مستند |
| [`.github/workflows/`](../.github/workflows/) | [`build.yml`](../.github/workflows/build.yml) (مدرسه) · [`native-client.yml`](../.github/workflows/native-client.yml) (اپ بومی) · [`api-contract.yml`](../.github/workflows/api-contract.yml) (قرارداد + PostgreSQL واقعی) · [`release-gate.yml`](../.github/workflows/release-gate.yml) (دروازهٔ انتشار، ردیف ۹۵) · [`owner-panel.yml`](../.github/workflows/owner-panel.yml) (پنل مالک) · [`pages.yml`](../.github/workflows/pages.yml) (صفحهٔ ایستا، استقرار دستی با دروازهٔ مالک، ردیف ۱۱۴) | CI |

## ۲. `apps/owner-panel/` — پنل مالک پلتفرم

مستقل از اپ مدرسه: بدون `client/pages.js`، بدون `server/auth.js`، شناسهٔ نصب جدا (`ir.payesh.owner`، AppId جدا). استثنای WebView فقط برای همین ابزار مدیریتی است (D‑44، [ADR‑62](cloud/62-adr-owner-panel-packaging.md))؛ ردیف ۶۳ و استقلال بومی اپ مدرسه تغییر نمی‌کند.

| مسیر | چیست | ردیف/PR |
|---|---|---|
| [`apps/owner-panel/server/`](../apps/owner-panel/server/) | API `/api/platform/v1` پشت Gateway: `platform-api.js`، `owner-auth.js` (رمز scrypt + TOTP، D‑45)، `openapi.json`، `static-server.js` | PR‑2 · ۹۸ |
| [`apps/owner-panel/web/`](../apps/owner-panel/web/) | SPA فارسی/RTL با تم نبض (`theme.css` از `client/pulse.css`)، بدون CDN/فونت/اسکریپت خارجی | PR‑3 · ۹۸ |
| [`apps/owner-panel/scripts/`](../apps/owner-panel/scripts/) | `gen-theme.js`، `package-web.js` + `zip-lite.js`، `check-owner-artifacts.js` (گیت خروجی‌ها)، `create-operator.js` (حساب اپراتور روی سرور) | PR‑3/4/5 |
| [`apps/owner-panel/tests/`](../apps/owner-panel/tests/) | `platform-api` · `owner-spa` · `owner-spa-infra` (۱۲۳) · `owner-login` · `tenant-deletion` · `packaging` (P1–P7) | همه |
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
| PR‑6 نقشه/ROADMAP/Ground Truth | ۱۰۱ | #167 → `4821842` | [owner-panel-pr6-101-map.txt](cloud/reports/evidence/owner-panel-pr6-101-map.txt) | Done |
| آزمون محلی loopback (`local-up`) | ۱۰۲ | #182 | `docs/cloud/102-owner-local-up.md` (در همان PR) | در صف ادغام |

## ۴. Ground Truth — پنل مالک (فقط آنچه شاهد دارد)

برچسب‌ها: `[M]` ماشینی/کد · `[S]` شاهد خام · `[E]` محیط/اجرا · `[A]` ادعا · `[?]` نامشخص.

| ادعا | شاهد | برچسب |
|---|---|---|
| `npm test` سبز: pass=112 fail=0 (عدد زندهٔ هر commit در همین لاگ است؛ این سند هرگز بیش از لاگ ادعا نمی‌کند — `tests/repo-map-93.js` RM-05) | [mission-05-tests-run.log](cloud/reports/evidence/mission-05-tests-run.log) | `[M]` |
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

## ۵. کلاینت بومی مدرسه (D‑43) و تحویل میدانی (D‑47)

| مسیر | چیست | ردیف |
|---|---|---|
| [`cloud/43-adr-native-clients.md`](cloud/43-adr-native-clients.md) | ADR‑43: Flutter/Dart برای Android و Windows؛ بدون WebView و بدون Node.js در بستهٔ کلاینت | ۶۲ |
| [`cloud/43-native-independence.json`](cloud/43-native-independence.json) | معیار ماشین‌خوان استقلال بومی که گیت ردیف ۶۳ می‌خواند | ۶۲، ۶۳ |
| [`cloud/79-adr-notification-channel.md`](cloud/79-adr-notification-channel.md) | ADR‑79: Polling هوشمند برای اعلان (D‑46 / O‑26) | ۷۹ |
| [`cloud/reports/owner-handover-real-world.md`](cloud/reports/owner-handover-real-world.md) | گام‌های میدانی ردیف‌های ۴۶/۵۰/۵۱/۵۵/۵۷ که به مالک تحویل شد (D‑47) | ۴۶، ۵۰، ۵۱، ۵۵، ۵۷ |
| [`cloud/reports/evidence/run-onsystem-46-57.sh`](cloud/reports/evidence/run-onsystem-46-57.sh) | اجرای دوبارهٔ بخش روی‌سیستم این ردیف‌ها (شاهد: `onsystem-46-57.txt`) | ۴۶، ۵۰، ۵۱، ۵۵، ۵۷ |
| [`cloud/72-device-threat-model.md`](cloud/72-device-threat-model.md) · [`cloud/73-design-system.md`](cloud/73-design-system.md) · [`cloud/75-gateway-client.md`](cloud/75-gateway-client.md) | ذخیره‌سازی امن دستگاه · سیستم طراحی · کلاینت Gateway | ۷۲، ۷۳، ۷۵ |

## ۶. `apps/payesh/` — اپ بومی مدرسه (Flutter، ADR‑43)

یک کدبیس Flutter/Dart برای APK/AAB اندروید و EXE ویندوز؛ بدون WebView، بدون Node.js در بسته؛ فقط با API/Gateway موجود حرف می‌زند ([`openapi.yaml`](../openapi.yaml)، [`sync-v1.md`](cloud/contracts/sync-v1.md)، [`native-api-v1.md`](cloud/contracts/native-api-v1.md)). دروازهٔ استقلال بومی (ردیف ۶۳): [`tools/native-independence-gate.mjs`](../tools/native-independence-gate.mjs) روی خروجی واقعی.

| مسیر | چیست | ردیف |
|---|---|---|
| [`apps/payesh/app/`](../apps/payesh/app/) | اپ Flutter (runner اندروید و ویندوز)، `lib/src/app.dart`، آزمون ویجت و SecureStore | ۶۹، ۷۲ |
| [`apps/payesh/app/android/`](../apps/payesh/app/android/) | runner اندروید: `ir.payesh.school.payesh_app`، targetSdk 36، امضای انتشار فقط از env/Secrets | ۷۲، ۷۶ |
| [`apps/payesh/app/windows/`](../apps/payesh/app/windows/) | runner ویندوز + `installer/payesh-native.iss` (نصب per-user، AppId جدا) | ۷۲، ۷۷ |
| [`apps/payesh/packages/payesh_core/`](../apps/payesh/packages/payesh_core/) | Dart خالص: شناسه‌ها، ساعت، ثابت‌های API، کدهای خطا | ۶۹ |
| [`apps/payesh/packages/payesh_data/`](../apps/payesh/packages/payesh_data/) | موتور دادهٔ محلی SQLite (رمزنگاری‌شده) با همان قرارداد `client/engine-web.js` | ۷۰، ۷۲ |
| [`apps/payesh/packages/payesh_sync/`](../apps/payesh/packages/payesh_sync/) | صندوق خروجی آفلاین + کلاینت Sync v1؛ ترابری HTTP/Gateway/مستقیم و پین گواهی (کلاینت Gateway ردیف ۷۵ هم همین‌جاست — بستهٔ جداگانهٔ `payesh_net` ساخته نشد) | ۷۱، ۷۵، ۱۱۰ |
| [`apps/payesh/packages/payesh_secure/`](../apps/payesh/packages/payesh_secure/) | SecureStore (Keystore/DPAPI)، مدیر کلید پایگاه، رمزنگاری سمت دستگاه e2e1 | ۷۲، ۱۰۷ |
| [`apps/payesh/packages/payesh_ui/`](../apps/payesh/packages/payesh_ui/) | سیستم طراحی: توکن‌ها، تم روشن/تیره، RTL، تاریخ جلالی، فونت Vazirmatn | ۷۳ |
| [`apps/payesh/tool/`](../apps/payesh/tool/) | `coverage_check.dart` (دروازهٔ پوشش در CI) | ۶۹ |

## ۷. نقشهٔ راه کلاینت بومی و ابر (هم‌تراز با صف Notion)

فقط ردیف‌های ادغام‌شده با commit ادغام؛ هر commit باید جد `main` باشد (`tests/repo-map-93.js` RM-04).

| ردیف Notion | موضوع | PR → ادغام | سند |
|---|---|---|---|
| ۶۲، ۷۹، ۴۶، ۵۰، ۵۱، ۵۵، ۵۷ | ADR‑43، اعلان، تحویل میدانی | #168 → `ea949bf` | [`cloud/43-adr-native-clients.md`](cloud/43-adr-native-clients.md) |
| ۸۱ | OpenAPI drift | #169 → `0d223fb` | [`openapi.yaml`](../openapi.yaml) |
| ۶۳، ۷۰ | دروازهٔ بومی، موتور داده | #170 → `7337f22` | [`cloud/43-native-independence.json`](cloud/43-native-independence.json) |
| ۷۱ | صندوق خروجی + Sync | #171 → `a1d4c5d` | [`cloud/contracts/sync-v1.md`](cloud/contracts/sync-v1.md) |
| ۷۲ | ذخیره‌سازی امن دستگاه | #172 → `4ecdb64` | [`cloud/72-device-threat-model.md`](cloud/72-device-threat-model.md) |
| ۷۳، ۷۵، ۶۹ | سیستم طراحی، کلاینت Gateway، اسکلت اپ | #173 → `2fc2f74` | [`cloud/75-gateway-client.md`](cloud/75-gateway-client.md) |
| ۶۴–۶۷ | قرارداد بومی، هویت دستگاه، دایرکتوری، Gateway | #174 → `68d2f6d` | [`cloud/65-device-identity.md`](cloud/65-device-identity.md) |
| ۹۵ | دروازهٔ انتشار | #175 → `ece72ae` | [`release-gate.yml`](../.github/workflows/release-gate.yml) |
| ۸۷ | رمزنگاری فیلد | #176 → `761fa79` | [`security/87-field-encryption.md`](security/87-field-encryption.md) |
| ۸۹ | base_sha شواهد | #177 → `906564b` | [`cloud/89-evidence-sha.md`](cloud/89-evidence-sha.md) |
| ۸۵ | مشاهده‌پذیری/SLO | #178 → `08cdc7a` | [`cloud/85-observability-slo.md`](cloud/85-observability-slo.md) |
| ۸۶ | مهاجرت‌ها | #179 → `7a0e827` | [`cloud/86-migrations.md`](cloud/86-migrations.md) |
| ۸۳ | fuzz همگرایی | #180 → `44e7c3f` | [`cloud/83-convergence-fuzz.md`](cloud/83-convergence-fuzz.md) |
| ۸۲ | آزمون بار (مستقیم + Gateway) | #181 → `9b06ff4` | [`cloud/82-load-test.md`](cloud/82-load-test.md) |
| ۱۰۶ | هویت + RLS مسیر مستقیم | #183 → `45ae7bf` | [`cloud/106-direct-identity-rls.md`](cloud/106-direct-identity-rls.md) |
| ۱۰۷ | رمزنگاری سمت دستگاه | #184 → `d0a046c` | [`cloud/107-e2e-encryption.md`](cloud/107-e2e-encryption.md) |
| ۱۰۸ | همگام‌سازی در SQL | #185 → `6f9b434` | [`cloud/108-direct-sync.md`](cloud/108-direct-sync.md) |
| ۱۰۹ | پنتست RLS | #186 → `38bb14a` | [`cloud/109-rls-pentest.md`](cloud/109-rls-pentest.md) |
| ۱۱۰ | ترابری مستقیم | #187 → `5e577f5` | [`cloud/110-direct-transport.md`](cloud/110-direct-transport.md) |
| ۱۱۱ | پشتیبان + مانور بازیابی | #188 → `0afd5c7` | [`cloud/111-backup-restore.md`](cloud/111-backup-restore.md) |
| ۸۴ | SBOM + اسکن آسیب‌پذیری | #189 → `64191e1` | [`security/84-sbom-vuln-scan.md`](security/84-sbom-vuln-scan.md) |
| ۱۰۲ | اجرای محلی پنل مالک | #182 → `2849ed3` | [`cloud/102-owner-local-up.md`](cloud/102-owner-local-up.md) |
| ۸۸ | حذف/خروجی داده (حریم خصوصی) | #191 → `2cc75d8` | [`security/88-privacy-delete-export.md`](security/88-privacy-delete-export.md) |
| ۸۰ | تله‌متری با رضایت (ترابری مستقیم، بدون PII) | #193 → `863e9ce` | [`security/80-telemetry.md`](security/80-telemetry.md) |
| ۷۸ | به‌روزرسانی خودکار امضاشده (Ed25519) | #194 → `3bb3ef9` | [`cloud/78-native-auto-update.md`](cloud/78-native-auto-update.md) |
| ۷۶، ۷۷ | انتشار امضاشدهٔ APK/AAB اندروید و نصب‌کنندهٔ ویندوز | #190 → `d1df3a3` | [`cloud/76-android-release.md`](cloud/76-android-release.md) · [`cloud/77-windows-installer.md`](cloud/77-windows-installer.md) |
| ۱۱۴ | صفحهٔ ایستای دانلود + سند DNS | #195 → `4044d16` | [`cloud/114-landing-pages-dns.md`](cloud/114-landing-pages-dns.md) |
| ۱۱۵ | پروب هاست (`tools/host-probe.mjs`) | #196 → `09e2ab4` | [`cloud/115-host-probe.md`](cloud/115-host-probe.md) |
| ۱۱۷ | ADR مرحله‌ای کم‌هزینه + D‑48 | #197 → `4cc72fe` | [`cloud/117-adr-staged-low-cost.md`](cloud/117-adr-staged-low-cost.md) |
| ۱۱۸ | تطبیق Done با Repo Truth | #198 → `62fb129` | [`cloud/118-reconciliation.md`](cloud/118-reconciliation.md) |
| ۱۱۹ | ۲۰ سناریوی آفلاین روی مسیر Gateway | #199 → `1e2cdcf` | [`cloud/119-offline.md`](cloud/119-offline.md) |
| ۱۲۱ | ساخت مدرسه ← tenant اختصاصی + مدیر اولیه | #200 → `832ecff` | [`cloud/121-tenant-provisioning.md`](cloud/121-tenant-provisioning.md) |
| ۱۲۲ | لایهٔ زیرساخت مستقل از provider | #201 → `e1ef50a` | [`cloud/122-infra-layer.md`](cloud/122-infra-layer.md) |

ردیف‌های باز (۷۴، ۹۳ — همین نقشه، ۹۴، ۱۱۲ و ردیف‌های OWNER/Z: ۹۱، ۹۲، ۱۰۵، ۱۱۳، ۶۱؛ ۱۰۳ و ۱۰۴ منسوخ‌شده با ADR‑105) در صف Notion پیگیری می‌شوند و پس از ادغام به این جدول افزوده می‌شوند.
