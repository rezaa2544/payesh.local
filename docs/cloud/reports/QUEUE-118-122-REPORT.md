# گزارش صف — ادغام ردیف‌های ۱۱۸، ۱۱۹، ۱۲۱ و ۱۲۲

| | |
|---|---|
| تاریخ | ۱۴۰۵/۰۸/۲۱ · 2026‑11‑11 |
| main پس از این دور | `e1ef50a` (PR #201) |
| برچسب‌ها | [S] = در محیط آزمایشی ARENA یا CI · [M] = روی هاست یا دستگاه واقعی |
| فهرست همهٔ گزارش‌ها | [`QUEUE-LOG.md`](QUEUE-LOG.md) |

## ۱. خلاصه

هر چهار PR باز به ترتیب صف و فقط پس از CI سبز در `main` ادغام شدند (D‑39). ردیف‌های ۱۱۸، ۱۱۹، ۱۲۱ و ۱۲۲ در Notion **Done** شدند و Evidence هرکدام لینک PR است.

| ردیف | موضوع | PR | commit ادغام | `npm test` هنگام ادغام | CI |
|---|---|---|---|---|---|
| ۱۱۸ | تطبیق Done با Repo Truth | [#198](https://github.com/rezaa2544/payesh.local/pull/198) | `62fb129` | ۱۱۵/۱۱۵ | build‑and‑release 43112747840 سبز |
| ۱۱۹ | ۲۰ سناریوی آفلاین روی مسیر Gateway | [#199](https://github.com/rezaa2544/payesh.local/pull/199) | `1e2cdcf` | ۱۱۶/۱۱۶ | build‑and‑release 43115989966، native‑client 43115995172، api‑contract 43115995414 سبز |
| ۱۲۱ | ساخت مدرسه ← tenant اختصاصی + مدیر اولیه | [#200](https://github.com/rezaa2544/payesh.local/pull/200) | `832ecff` | ۱۱۸/۱۱۸ | ۲۳ check run سبز |
| ۱۲۲ | لایهٔ زیرساخت مستقل از provider | [#201](https://github.com/rezaa2544/payesh.local/pull/201) | `e1ef50a` | ۱۱۹/۱۱۹ | ۲۱ check run سبز |

## ۲. شاهد هر ردیف

**ردیف ۱۱۸**
- `node tests/reconcile-118.js` نتیجه داد: `RECONCILE-118 OK passed=7 negative_controls=10`.
- سند: [`../118-reconciliation.md`](../118-reconciliation.md).

**ردیف ۱۱۹**
- Dart: `OFFLINE-119 scenarios=20 data_loss=0 duplicate=0 order_violations=0 cross_tenant=0`.
- Node: `OFFLINE-119-NODE passed=5 negative_controls=2`.
- سند: [`../119-offline.md`](../119-offline.md).

**ردیف ۱۲۱**
- PostgreSQL 17.11 محلی (بازاجرا پس از ادغام با main): `TENANT-121 passed=8 failed=0 negative_controls=28`.
- PGlite: `negative_controls=25`.
- سند: [`../121-tenant-provisioning.md`](../121-tenant-provisioning.md).

**ردیف ۱۲۲**
- آزمون: `INFRA-122 negative_controls=84 unit_controls=31 failures=0`.
- جهش: `MUTANTS-122 total=17 red=17 survived=0`.
- PostgreSQL 17.11: ‏001..005 up، سپس 006 up → down → up بدون خطا. هر ۷ جدول `infra_*` با RLS.
- `LOCAL-UP-102 passed=9 negative_controls=30`.
- `OPENAPI-DRIFT-81-OK code_routes=114`.
- `ANDROID-SIGNING-SAFETY-OK`.
- `SECURITY-48-OK` (۱۳/۱۳).
- سند: [`../122-infra-layer.md`](../122-infra-layer.md).

## ۳. اصلاح‌هایی که هنگام ادغام لازم شد

| مورد | علت | اصلاح |
|---|---|---|
| گزارش ۱۱۸، R10 | کلاینت بومی اکنون AutoSync (polling با backoff) دارد | R10 همچنان PARTIAL [S] است، چون هنوز هیچ صفحهٔ بومی اعلان را نشان نمی‌دهد (ردیف ۷۴) |
| گزارش ۱۱۸، R12 | ۲۰ سناریوی ۱۱۹ اجرا شد | NOT RUN ← **PASS [S]** |
| گزارش ۱۱۸، R26 | ابزار پروب با #196 در main است | ستون Notion و گام بعد به‌روز شد |
| گزارش ۱۱۸، R09 | مسیر `POST /tenants` اکنون هست | NOT IMPLEMENTED ← **PARTIAL [S]**: API هست، فرم SPA نیست (ردیف ۱۲۳) |
| گزارش ۱۱۸، R08 | migration 006 و API زیرساخت هست | NOT IMPLEMENTED ← **PARTIAL [S]**: صفحهٔ UI با ردیف ۱۲۳، API واقعی provider با ردیف ۱۲۴ |
| `tests/reconcile-118.js` | بررسی «لایهٔ provider» هر migration شمارهٔ 005 را می‌پذیرفت؛ 005 به ساخت مدرسه رسید و نتیجه مثبت کاذب می‌شد | بررسی اکنون دنبال migration `*_infra_*` می‌گردد. جهش‌های M1 و M10 دوطرفه شدند |
| `server/tenancy.js` | تعارض exportها بین #199 و #200 | اجتماع هر دو مجموعه (`SCHOOL_TABLE`، `CRED_TABLE`، `upsertInTx`، `createPool`، `poolErrorCount`) |
| مانیفست انتشار | تغییر فایل‌های بسته‌بندی‌شده (`client/outbox-web.js`، `server/gateway.js`) | بازسازی مانیفست با `build-release` روی هر شاخه |
| شاخهٔ ۱۲۲ | squash‑merge شدن #200 روی شاخهٔ پشته‌ای ۶ تعارض ساخت | شاخه روی main تازه دوباره ساخته شد (محتوای یکسان، `git diff` خالی) و همهٔ آزمون‌ها دوباره اجرا شد |
| `docs/REPOSITORY_MAP.md` §۷ | ردیف‌های ادغام‌شده در جدول نبودند | ۱۱۵، ۱۱۷، ۱۱۸، ۱۱۹ و ۱۲۱ اضافه شدند (RM‑04 سبز) |

## ۴. هنوز اجرا نشده (NOT RUN [M])

- **هاست واقعی:** Health Check، استقرار Gateway و پروب هاست به ردیف‌های ۱۱۶ (OWNER) و ۱۲۰ (Blocked) وابسته‌اند.
- **پایگاه و provider:** PostgreSQL مدیریت‌شده (۱۱۳) و هر API واقعی provider (۱۲۴) هنوز آزموده نشده‌اند.
- **دستگاه و شبکه:** دستگاه واقعی، کشتن برنامه توسط سیستم‌عامل و شبکهٔ موبایل ایران آزموده نشده‌اند.
- **امنیت:** وضعیت تا pentest انسانی (۹۲) **UNKNOWN** است.

## ۵. صف بعدی

۱۲۳ (صفحهٔ «زیرساخت» و فرم «ساخت مدرسه» در SPA پنل مالک) ← ۱۲۴ ← ۷۴ ← ۹۴.
- ردیف ۱۱۶ با OWNER است (Backlog).
- ردیف ۱۲۰ تا ۱۱۶ Blocked است.
