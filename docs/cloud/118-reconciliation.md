# ۱۱۸ — تطبیق «Done» در Notion با حقیقت مخزن (گزارش طبق ساختار §۱۹)

> تاریخ: ۱۴۰۵/۰۸/۲۰ (2026-11-11) · مجری: ARENA · آزمون: `tests/reconcile-118.js` (RC-01..07)
>
> برچسب‌ها: **[M]** واقعی · **[S]** شبیه‌سازی، CI یا محلی · **[E]** برآورد · **[A]** فرض · **[?]** نامعلوم.
> وضعیت امنیت تا پنتست انسانی **UNKNOWN** است (D‑41).
>
> **قاعدهٔ این جدول:** هر ادعا یک مسیر واقعی در مخزن و یک آزمون دارد. آزمون RC چند ردیف را مستقیم با خود مخزن می‌سنجد (ساخت مدرسه، صفحه‌های بومی، لایهٔ ارائه‌دهنده، بستهٔ استقرار Gateway، polling بومی، امنیت). اگر مخزن تغییر کند و این سند به‌روز نشود، آزمون قرمز می‌شود.

## ۱. وضعیت فعلی

| مورد | مقدار |
|---|---|
| شاخهٔ مرجع | `main` |
| SHA پایه | `32461d13fdcf552cbf4bb125b372c759c01e3cab` |
| PRهای باز همین دور | #196 (ردیف ۱۱۵، پروب هاست) و #197 (ردیف ۱۱۷، ADR‑117 + D‑48 + ADR‑105 Parked) |
| آزمون‌ها روی main | `npm test` ۱۱۲/۱۱۲ [S] |
| CI | در لحظهٔ نوشتن این سند، GitHub Actions دچار **قطعی گسترده (major outage)** است. CI این PRها هنوز تمام نشده (**NOT RUN**) و ادغام منتظر CI سبز می‌ماند (D‑39). |
| به‌روزرسانی پس از ادغام | #196، #197 و #198 با CI سبز ادغام شدند. R10 و R12 همراه ردیف ۱۱۹ (#199)، R26 پس از ادغام #196، ، R09 همراه ردیف ۱۲۱ (#200) و R08 همراه ردیف ۱۲۲ (#201) به‌روز شدند؛ ردیف ۱۲۳ (صفحهٔ «زیرساخت» و فرم «ساخت مدرسه» در SPA) R09 را PASS [S] کرد و بخش UI از R08 را بست. |

## ۲. سنجش «شواهد اولیهٔ کاربر»

| ادعا | حکم | شاهد |
|---|---|---|
| در `apps/payesh/app/lib` فقط `main.dart`، `src/app.dart` و `src/secure/` هست | **تأیید** | ۴ فایل: `main.dart`، `src/app.dart`، `src/secure/android_keystore_store.dart`، `src/secure/local_storage.dart`. منطق در بسته‌های `apps/payesh/packages/*` است (موتور، صندوقچه، همگام‌سازی، UI، امن)، ولی **هیچ صفحهٔ کاربردی‌ای وجود ندارد**. |
| پنل مالک کد provider/infra ندارد | **تأیید** | در `apps/owner-panel/server` و `web` هیچ ثبت ارائه‌دهنده یا سلامت زیرساختی نیست. migrationهای پنل فقط تا `004` هستند. |
| مسیر هاست فقط Node + SQLite تک‌مدرسه‌ای است | **تأیید، با یک قید** | راه ۱ در `deploy/README.md` همان `server/index.js` (SQLite، تک‌مدرسه) را مستقر می‌کند. Gateway چندمستأجری روی PostgreSQL **در کد هست** (`server/gateway.js`، `server/tenancy.js`)، ولی هیچ بسته یا سند استقراری برای آن در `deploy/` نیست. ردیف ۱۲۰ این کار را انجام می‌دهد. |
| شاهد ردیف‌های ۷۶ و ۷۷ از امضاکنندهٔ آزمایشی است [S] | **تأیید** | `docs/cloud/reports/evidence/76-android-release.txt`. کلید واقعی با مالک است (ردیف‌های ۶۱ و ۹۱). |
| شاهد CI دروازهٔ بومی ردیف ۶۳ واقعی است | **تأیید** (طبق دستور، زیر سؤال نرفت) | `docs/cloud/reports/evidence/native-63-69-70-ci.txt` |
| ردیف‌های ۱۰۶ تا ۱۱۱ روی PG محلی [S] هستند و امنیت UNKNOWN است | **تأیید** | شواهد `direct-*-10x.txt` و `rls-pentest-109.txt`، همه [S]. مسیر مستقیم Parked است (D‑48، PR #197). |

## ۳. جدول تطبیق

معنای وضعیت‌ها:
- **PASS:** با آزمون و شاهد اثبات شده، با برچسب ذکرشده.
- **PARTIAL:** بخشی اثبات شده؛ شکاف در ستون مربوط آمده.
- **BLOCKED:** وابستگی برآورده نشده است.
- **NOT IMPLEMENTED:** کدی وجود ندارد.
- **UNKNOWN:** با شواهد فعلی قابل حکم نیست.
- **NOT RUN:** سنجیده نشده است.

<!-- RECONCILIATION-TABLE:BEGIN -->
| ID | نیاز مالک | وضعیت مخزن | Notion | مسیر | آزمون | شاهد | شکاف | ریسک | گام بعد |
|---|---|---|---|---|---|---|---|---|---|
| R01 | اپ بومی Flutter (D‑43) با خروجی واقعی | PARTIAL [S] | ۶۳، ۶۹–۷۳، ۷۵: Done | `apps/payesh/app/lib/main.dart` | `tests/native-gate-63.js` | `docs/cloud/reports/evidence/native-63-69-70-ci.txt` | پوسته، بسته‌ها و موج ۱ صفحه‌ها (ورود و انتخاب مدرسه) هست؛ صفحه‌های داده (حضور، نمره، اطلاعیه، والدین) نیست | ادعای «اپ کامل» بی‌پایه است | ردیف ۷۴ |
| R02 | موتور محلی SQLite رمزشده روی دستگاه | PASS [S] | ۷۰، ۷۲: Done | `apps/payesh/packages/payesh_data/lib/src/sqlite_engine.dart` | `tests/conformance-engine-70.js` | `docs/cloud/reports/evidence/native-72-ci.txt` | آزمون روی دستگاه واقعی نیست | رفتار روی گوشی‌های ضعیف [?] | دستگاه واقعی = OWNER [M] |
| R03 | صندوقچهٔ ماندگار و همگام‌سازی (outbox، sync) | PASS [S] | ۴۰، ۷۱: Done | `apps/payesh/packages/payesh_sync/lib/src/outbox.dart` | `tests/conformance-outbox-71.js` | `docs/cloud/reports/evidence/native-71-ci.txt` | در هیچ صفحه‌ای به کار نرفته | — | ردیف‌های ۷۴ و ۱۱۹ |
| R04 | Gateway/API بی‌حالت به‌عنوان ترابری پیش‌فرض (بند ۲۵) | PASS [S] | ۳۷، ۶۷: Done | `server/gateway.js` | `tests/gateway-67.js` | `docs/cloud/reports/evidence/gateway-67.txt` | روی هاست واقعی اجرا نشده | ظرفیت هاست [?] | ردیف‌های ۱۱۶ و ۱۲۰ |
| R05 | مسیر مستقیم فقط پشت `PAYESH_TRANSPORT=direct`، پیش‌فرض خاموش | PASS [S] | ۱۱۰: Done | `client/transport.js` | `tests/transport-110.js` | `docs/cloud/reports/evidence/direct-transport-110.txt` | — | فعال‌سازی ناخواسته؛ کنترل با ADR‑05 در PR #197 | امضای ADR‑105 = OWNER |
| R06 | PostgreSQL مرکزی با RLS، هر مدرسه یک tenant | PASS [S] | ۱۲، CC‑12‑2: Done | `server/tenancy.js` | `tests/tenancy-pg.js` | `docs/cloud/reports/evidence/cc12-2-product-rls.txt` | روی PG واقعی هاست یا مدیریت‌شده اجرا نشده | امنیت UNKNOWN | ردیف‌های ۱۲۰ و ۹۲ |
| R07 | مرحلهٔ A روی هاست فعلی (Gateway چندمستأجری) | BLOCKED | ۱۲۰: Done [S] (#218)؛ ۱۱۶: Backlog | `deploy/gateway/start.cjs` `scripts/build-gateway-bundle.mjs` `deploy/gateway/payesh-gateway.service` | `tests/gateway-bundle-120.js` | `docs/cloud/120-gateway-bundle.md` | بستهٔ استقرار Gateway، پیش‌بررسی، ابزار مدیر و selfcheck ساخته و روی PostgreSQL در CI سنجیده شد [S]؛ اجرا روی هاست واقعی با HTTPS عمومی NOT RUN [M] | هاست ممکن است همیشه‌روشن نباشد یا دیسکش نماند | پروب هاست ۱۱۶ (OWNER) و سپس اجرای بستهٔ ۱۲۰ روی همان هاست [M] |
| R08 | پنل مالک به‌عنوان Control Plane (ارائه‌دهنده، سلامت، ظرفیت، هشدار) | PARTIAL [S] | ۱۲۲: Done، ۱۲۳: Done، ۱۲۴: Done | `apps/owner-panel/server/infra.js` `apps/owner-panel/web/app.js` | `apps/owner-panel/tests/infra-registry.test.js` `apps/owner-panel/tests/owner-spa-infra.test.js` | `docs/cloud/122-infra-layer.md` `docs/cloud/123-owner-infra-ui.md` `docs/cloud/124-provider-api-research.md` | API، migration 006 و صفحهٔ «زیرساخت» در SPA (ثبت دستی، Health Check دستی، هشدار، درخواست/تأیید مالک) هست؛ هیچ API واقعی ارائه‌دهنده‌ای وصل نیست؛ پژوهش ۱۲۴ برای RadCloud (هاست فعلی) هیچ API عمومی پیدا نکرد [?] و آروان/پارس‌پک/Neon/Supabase فقط در سطح L2 (خواندنی) پیشنهاد شده‌اند و ظرفیت/مصرف فقط با ثبت دستی [M]/[E] پر می‌شود | عدد ساختگی ممنوع؛ ظرفیت تا ثبت دستی «نامعلوم» | مستند رسمی RadCloud یا انتخاب Provider از مالک [OWNER]؛ سپس آداپتور خواندنی L2 |
| R09 | ساخت مدرسه از پنل ← tenant + مدیر اولیه | PASS [S] | ۱۲۱: Done، ۱۲۳: Done | `apps/owner-panel/server/platform-api.js` `apps/owner-panel/web/app.js` | `apps/owner-panel/tests/tenant-provisioning.test.js` `tests/tenant-121.js` `apps/owner-panel/tests/owner-spa-infra.test.js` | `docs/cloud/121-tenant-provisioning.md` `docs/cloud/123-owner-infra-ui.md` | API و saga با PostgreSQL واقعی و فرم «ساخت مدرسه» در SPA (فقط مالک، تلاش دوباره با همان provision_op_id، کد فعال‌سازی فقط یک بار) آزموده شده؛ اجرای روی میزبان واقعی [M] انجام نشده | — | — |
| R10 | اعلان با Polling هوشمند (D‑46) | PARTIAL [S] | ۷۹: Done، ۱۱۹: Done | `apps/payesh/packages/payesh_sync/lib/src/auto_sync.dart` | `tests/sync-cost-42.js` `apps/payesh/packages/payesh_sync/test/auto_sync_test.dart` | `docs/cloud/119-offline.md` | کلاینت وب poll تطبیقی دارد و کلاینت بومی AutoSync (polling با backoff) دارد (۱۱۹)؛ هنوز هیچ صفحهٔ بومی اعلان را نشان نمی‌دهد | — | ردیف ۷۴ |
| R11 | ورود و ممیزی پنل مالک (D‑45) | PASS [S] | ۹۸: Done | `apps/owner-panel/server/owner-auth.js` | `apps/owner-panel/tests/owner-login.test.js` | `docs/cloud/reports/evidence/owner-panel-pr3-98-login.txt` | — | امنیت UNKNOWN | ردیف ۹۲ |
| R12 | ۲۰ سناریوی آفلاین (قطعی، 429/5xx، ری‌استارت، تعارض…) | PASS [S] | ۱۱۹: Done | `client/outbox-web.js` | `tests/offline-119.js` `apps/payesh/packages/payesh_sync/test/offline_119_test.dart` | `docs/cloud/119-offline.md` | روی دستگاه واقعی و هاست واقعی اجرا نشده | رفتار شبکهٔ واقعی موبایل [?] | دستگاه واقعی = OWNER [M] |
| R13 | تعارض و هم‌گرایی | PASS [S] | ۴۱، ۸۳: Done | `server/convergence.js` | `tests/convergence-fuzz-83.js` | `docs/cloud/reports/evidence/convergence-fuzz-83.txt` | — | — | — |
| R14 | انتشار امضاشدهٔ اندروید و ویندوز | PARTIAL [S] | ۷۶، ۷۷: Done | `tests/android-release-76.js` | `tests/android-release-76.js` | `docs/cloud/reports/evidence/76-android-release.txt` | امضاکنندهٔ آزمایشی | APK امضانشده منتشر نمی‌شود (D‑44) | ۶۱ و ۹۱ (OWNER) |
| R15 | امنیت | UNKNOWN | ۴۸، ۵۷، ۱۰۹: Done · ۹۲: باز | `tests/security-scan-48.js` | `tests/rls-pentest-109.js` | `docs/cloud/reports/evidence/rls-pentest-109.txt` | پنتست انسانی انجام نشده | — | ۹۲ (OWNER) |
| R16 | بکاپ و بازیابی | PARTIAL [S] | ۵۰، ۱۱۱: Done | `tools/backup-111.mjs` | `tools/backup-drill-111.mjs` | `docs/cloud/reports/evidence/backup-drill-111.txt` | روی PG واقعی مالک اجرا نشده | از دست رفتن داده | ۱۲۰ و سپس مانور [M] |
| R17 | به‌روزرسانی خودکار امضاشده | PASS [S] | ۷۸: Done | `apps/payesh/packages/payesh_secure/lib/src/native_update.dart` | `tests/native-update-78.js` | `docs/cloud/reports/evidence/78-native-update.txt` | کلید امضا با مالک است | — | — |
| R18 | تله‌متری فقط با رضایت و بدون PII | PASS [S] | ۸۰: Done | `docs/security/80-telemetry.md` | `tests/telemetry-80.js` | `docs/cloud/reports/evidence/80-telemetry.txt` | — | — | — |
| R19 | حذف و خروجی داده (حریم خصوصی) | PASS [S] | ۸۸: Done | `server/privacy.js` | `tests/privacy-88.js` | `docs/cloud/reports/evidence/88-privacy.txt` | — | — | — |
| R20 | پایش و SLO | PARTIAL [S] | ۸۵: Done | `server/slo.js` | `tests/observability-85.js` | `docs/cloud/reports/evidence/observability-85.txt` | روی هاست واقعی اجرا نشده | — | ردیف ۱۲۰ |
| R21 | ظرفیت و بار (بدون ادعای نامحدود، ممنوع) | PARTIAL [S] | ۸۲: Done | `tools/load-82.mjs` | `tests/load-82.js` | `docs/cloud/reports/evidence/load-82.txt` | عدد [M] روی هدف واقعی وجود ندارد | ادعای ظرفیت | ۸۲ با `PAYESH_T2_MANAGED_DB=1` (OWNER) |
| R22 | صفحهٔ دانلود `payeshschool.ir` | PARTIAL [S] | ۱۱۴: Done | `tools/landing-114.mjs` | `tests/landing-114.js` | `docs/cloud/reports/evidence/114-landing.txt` | منتشر نشده؛ DNS با مالک است | — | DNS (OWNER) |
| R23 | صفحه‌های بومی (ورود و مدرسه ← حضور ← نمره ← اطلاعیه ← والدین) | PASS [S] | ۷۴: هر ۵ موج ادغام — #207، #209، #211، #212، #214 | `apps/payesh/app/lib/src/login/session_controller.dart` `apps/payesh/packages/payesh_sync/lib/src/attendance.dart` `apps/payesh/packages/payesh_sync/lib/src/grades.dart` `apps/payesh/packages/payesh_sync/lib/src/notices.dart` `apps/payesh/packages/payesh_sync/lib/src/family.dart` | `apps/payesh/app/test/login_wave1_test.dart` `apps/payesh/app/test/attendance_wave2_test.dart` `apps/payesh/app/test/grades_wave3_test.dart` `apps/payesh/app/test/notices_wave4_test.dart` `apps/payesh/app/test/family_wave5_test.dart` `apps/payesh/packages/payesh_sync/test/school_access_it_test.dart` `apps/payesh/packages/payesh_sync/test/attendance_it_test.dart` `apps/payesh/packages/payesh_sync/test/grades_it_test.dart` `apps/payesh/packages/payesh_sync/test/notices_it_test.dart` `apps/payesh/packages/payesh_sync/test/family_it_test.dart` | `docs/cloud/74-native-wave1-login.md` `docs/cloud/74-native-wave2-attendance.md` `docs/cloud/74-native-wave3-grades.md` `docs/cloud/74-native-wave4-notices.md` `docs/cloud/74-native-wave5-parents.md` | هر ۵ موج (ورود و انتخاب مدرسه، حضور و غیاب، نمره، اطلاعیه، والدین) با Directory و Gateway واقعی [S]؛ Gateway تأیید نمره و نوشتن اطلاعیه را فقط برای مدیر می‌پذیرد و تأیید مرخصی به دست ولی را رد می‌کند (`approval_denied`، `role_denied`)؛ نصب روی دستگاه واقعی، صفحه‌خوان و شبکهٔ واقعی NOT RUN [M] | — | آزمون دستگاه واقعی [M] پس از ردیف ۱۲۰ |
| R24 | RTL، تقویم جلالی، تم روشن و تیره | PASS [S] | ۷۳: Done | `apps/payesh/packages/payesh_ui/lib/src/jalali.dart` | `tests/conformance-jalali-73.js` | `docs/cloud/reports/evidence/native-73-75-ci.txt` | در صفحه‌های ورود موج ۱ به کار رفته (RTL، توکن‌ها)؛ صفحه‌های داده هنوز نیست | — | ردیف ۷۴ |
| R25 | بدون Cloudflare (D‑09) | PASS [S] | ۱۱۴: Done | `site/index.html` | `tests/landing-114.js` | `docs/cloud/reports/evidence/114-landing.txt` | پروب هاست هم آن را می‌سنجد (PR #196) | — | — |
| R26 | پروب هاست (۱۱۵) و اجرای آن روی هاست واقعی (۱۱۶) | NOT RUN | ۱۱۵: Done · ۱۱۶: Backlog | `deploy/selfcheck.mjs` | — | — | ابزار با #196 در main است؛ اجرای واقعی روی هاست با OWNER است | — | ۱۱۶ (OWNER) |
| R27 | سند نصب و راه‌اندازی | PARTIAL [S] | ۹۴: Done (#215)؛ ۱۲۰: Done [S] (#218) | `docs/05-install-and-updates.md` `docs/cloud/94-onboarding-design.md` `docs/cloud/120-gateway-bundle.md` | `tests/onboarding-94.js` `tests/gateway-bundle-120.js` | — | سند طراحی آنبوردینگ (۹۴) و راهنمای گام‌به‌گام استقرار Gateway برای مالک (۱۲۰، با آزمون کلیدواژه و نبود راز) هست [S]؛ اجرای راهنما روی هاست واقعی NOT RUN [M] | پیاده‌سازی آنبوردینگ منتظر O‑21 است | اجرای راهنمای ۱۲۰ پس از ۱۱۶ [M]، سپس آنبوردینگ پس از O‑21 |
<!-- RECONCILIATION-TABLE:END -->

### اصلاح وضعیت‌های Notion در همین ردیف
- ۱۱۵ و ۱۱۷: **Review** (PR باز؛ CI به‌خاطر قطعی GitHub Actions تمام نشده).
- ۱۲۰: **Blocked**، چون به ۱۱۶ (OWNER) وابسته است.
- **هیچ ردیف Done‌ای با AC خودش در تضاد یافت نشد.** همهٔ Doneها با برچسب درست ثبت شده‌اند ([S] یا «بخش میدانی به مالک تحویل شد» طبق D‑47). اما «Done» در Notion به معنای «کار ARENA تمام شد» است، **نه** «روی هاست واقعی [M] کار می‌کند». ستون «وضعیت مخزن» بالا همین فاصله را نشان می‌دهد.

## ۴. بخش آفلاین (جدا)

| سنجه | وضعیت | شاهد |
|---|---|---|
| صندوقچهٔ ماندگار با lease، backoff+jitter، ack پس از تصمیم سرور (وب و Dart) | PASS [S] | `tests/outbox-40.js`، `tests/conformance-outbox-71.js` |
| ۱۴ سناریوی آشوب: قطع پیش از ارسال، وسط درخواست، وسط پاسخ، blackhole، کشتن سرور | PASS [S] روی `server/index.js`، تک‌مدرسه | `docs/cloud/reports/evidence/chaos-47.txt` (`data_loss=0 duplicate=0 cross_tenant=0`) |
| هم‌گرایی تعارض (fuzz) | PASS [S] | `docs/cloud/reports/evidence/convergence-fuzz-83.txt` |
| **۲۰ سناریوی ردیف ۱۱۹ روی مسیر پیش‌فرض Gateway + PostgreSQL** (قطعی پیش، حین و پس از ارسال؛ Backend، DB یا Gateway پایین؛ 429؛ 5xx؛ timeout؛ ازدحام؛ ری‌استارت اپ یا دستگاه؛ برگشت شبکه؛ اجرای خودکار صف؛ تکرار عملیاتِ اجراشده؛ ترتیب وابسته؛ تعارض دو دستگاه؛ مجوز دادهٔ حساس؛ قطعی دوباره وسط همگام‌سازی) | PASS [S] (Gateway + PostgreSQL، کلاینت Dart و وب) | `docs/cloud/119-offline.md` (`OFFLINE-119 scenarios=20 data_loss=0 duplicate=0 order_violations=0 cross_tenant=0`) |
| آزمون روی دستگاه واقعی | **NOT RUN** (OWNER [M]) | — |

**حکم:** ۲۰ سناریوی ردیف ۱۱۹ روی مسیر پیش‌فرض PASS [S] است. ادعای «آفلاین کامل» تا آزمون دستگاه واقعی [M] **مجاز نیست**.

## ۵. معماری نهایی (ADR‑117، D‑48)

```
[اپ Flutter روی دستگاه]                       [پنل مالک = Control Plane]
  SQLite رمزشده (موتور محلی)                     ثبت ارائه‌دهنده، سلامت، ظرفیت، هشدار، ممیزی (۱۲۲/۱۲۳)
  outbox ماندگار ── push idempotent (op_id) ──┐   ساخت مدرسه ← tenant + مدیر (۱۲۱)
  مکان‌نمای pull ماندگار ◄── change-feed ──┐   │
                                          │   ▼
                         [Gateway/API بی‌حالت، HTTPS، بدون Cloudflare]
                          احراز هویت · اسکوپ نقش · tenant_id · سهمیه · 429/Retry-After · kill-switch
                                          │  SET app.tenant_id در هر تراکنش
                                          ▼
                         [PostgreSQL مرکزی + RLS (هر مدرسه یک tenant)]
                          روی هاست اگر ممکن باشد، وگرنه ردهٔ رایگان مدیریت‌شده (D‑40)
                                          │
                                          ▼
                         بکاپ رمزشدهٔ بیرون از ارائه‌دهنده + مانور بازیابی (۱۱۱)
```

**بازیابی:**
- قطع شبکه، Gateway یا DB ← صف روی دستگاه می‌ماند و با backoff و jitter دوباره فرستاده می‌شود. وضعیت برای کاربر دیده می‌شود.
- تکرار عملیات ← با `op_id` idempotent است.
- از دست رفتن DB ← بازیابی از بکاپ بیرونی، سپس pull دوباره با مکان‌نما.
- مسیر مستقیم فقط با امضای ADR‑105 (Parked).

## ۶. برنامهٔ تکمیل، هزینه و دروازه‌ها

| گام | ردیف | مجری | هزینه | دروازه |
|---|---|---|---|---|
| پروب هاست | ۱۱۵ ← ۱۱۶ | ARENA ← OWNER | ۰ [A] | حکم `ready`، بدون blocker [M] |
| ADR مرحله‌ای + D‑48 | ۱۱۷ | ARENA | ۰ | ADR‑01..07 |
| سناریوهای آفلاین | ۱۱۹ | ARENA | ۰ | ۲۰ سناریو PASS یا NOT-RUN صریح [S] |
| ساخت مدرسه ← tenant | ۱۲۱ | ARENA | ۰ | آزمون منفی: کاربر مدرسهٔ دیگر ۰ ردیف می‌بیند [S] |
| لایهٔ زیرساخت + صفحهٔ «زیرساخت» | ۱۲۲، ۱۲۳ | ARENA | ۰ | «نامعلوم» به‌جای عدد ساختگی؛ تأیید مالک و ممیزی برای عملیات پرخطر |
| پژوهش API ارائه‌دهنده‌ها | ۱۲۴ | ARENA | ۰ | منبع رسمی برای هر ادعا [E] |
| استقرار Gateway روی هاست | ۱۲۰ | ARENA (پس از ۱۱۶) | ۰ [A] | selfcheck [M] |
| صفحه‌های بومی | ۷۴ (موج ۱: ورود ✓ [S]) | ARENA | ۰ | هر موج یک PR با CI سبز |
| سند نصب | ۹۴ | ARENA | ۰ | پس از ۱۲۰ و ۷۴ |
| کلید و Secret، DNS، پنتست، دستگاه واقعی، PG رایگان | ۶۱، ۹۱، ۹۲، ۱۱۳، ۱۱۶ | **OWNER** | ۰ تا هر هزینه‌ای که با تأیید کتبی پذیرفته شود | — |
| مراحل C و D | — | فقط با تأیید کتبی | T2 حدود ۲۳ تا ۴۵ €/ماه [E] · T3 حدود ۸۹ تا ۳۰۰ €/ماه [E] (ADR‑34) | [M] روی هدف |

**ریسک باقی‌مانده:**
- امنیت UNKNOWN است.
- هیچ عدد [M] روی هاست واقعی نیست.
- دسترسی از شبکهٔ ایران به هر ارائه‌دهندهٔ بیرونی [?] است.
- اپ بومی هنوز صفحهٔ کاربردی ندارد.
