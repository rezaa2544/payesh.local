# گزارش صف — ردیف ۱۲۹: انتشار و صفحهٔ دانلود فقط بومی (حذف WebView مدرسه از انتشار)

| | |
|---|---|
| تاریخ | ۱۴۰۵/۰۸/۲۲ · 2026‑11‑12 |
| شاخه | فقط `main` (به دستور مأموریت؛ بدون PR) |
| commitها | کد `0bd6c46` · مانیفست `d47d7e0` · فهرست مجاز D‑35 `65712f8` · شاهد `8566d83` · یافتهٔ CI (بن‌بست مهاجرت) `37ad9df` + `fdeca30` · سقف SAST `b005f01` + شاهد `a0c28be` (tests-run 132/132 در هر مرحله) |
| CI | روی `a0c28be`: native-client `43289219901` ✅ · build-and-release `43289219964` ✅ · api-contract `43289220013` ✅ · installables-registry `43289219866` ✅ · school-webview-control `43289219894` ✅ |
| انتشار | `school-native-publish` [`43289003449`](https://github.com/rezaa2544/payesh.local/actions/runs/43289003449) ✅ → `native-continuous` (از native-client سبز [`43285985755`](https://github.com/rezaa2544/payesh.local/actions/runs/43285985755) روی `fdeca30`) |
| برچسب‌ها | [S] = در محیط آزمایشی ARENA یا CI · [M] = روی هاست یا دستگاه واقعی |
| فهرست همهٔ گزارش‌ها | [`QUEUE-LOG.md`](QUEUE-LOG.md) |
| ردیف قبلی | [`QUEUE-128-REPORT.md`](QUEUE-128-REPORT.md) |

## ۱. خلاصه

- انتشار و صفحهٔ دانلود فقط فایل‌هایی را عرضه می‌کنند که **روی همان فایل** از Native Gate گذشته‌اند.
- هیچ فایل WebView با نام یا برچسب «بومی» منتشر نمی‌شود؛ WebView مدرسه فقط به‌عنوان **کنترل منفی** ساخته می‌شود و منتشر نمی‌شود.
- APK مدرسه فقط با کلید مالک (ردیف ۶۱) منتشر می‌شود. این کلید نیست، پس Android **BLOCKED** است و هیچ APK منتشر نشده است.
- CI نصب واقعی ویندوز را نشان می‌دهد: نصب بی‌صدا ← Gate روی برنامهٔ نصب‌شده ← حذف (`installer-77.txt` با `INSTALLER-77-OK install+gate+uninstall`). ناشر پیش از انتشار این را دوباره بررسی می‌کند.

## ۲. کانال‌های انتشار (وضعیت زنده پس از اجرا)

| کانال | تنها نویسنده | محتوا |
|---|---|---|
| `native-continuous` | `school-native-publish.yml` | `payesh-native-setup.exe` · `payesh-native-windows.zip` · `SHA256SUMS` · `school-native-status.json` — **بدون APK** |
| `continuous` | `build.yml` | فقط `manifest.json` و `payesh-cloud.zip` (هیچ WebView و هیچ APK) |
| `owner-continuous` | ناشر پنل مالک (ردیف ۱۲۶) | بدون تغییر |

- `SHA256SUMS` روی فایل‌های دانلودشده: `payesh-native-setup.exe: OK` · `payesh-native-windows.zip: OK`.
- `school-native-status.json`: `"kind": "native-flutter"`، `"webview": false`، `"commit": "fdeca30…"`، `"android": "BLOCKED — no owner signing key (row 61) …"`.
- لاگ ناشر: `NATIVE-GATE-OK` روی artifactها پیش از بارگذاری و دوباره روی فایل‌های منتشرشده، و در پایان `SCHOOL-NATIVE-PUBLISH-OK 130 android=BLOCKED`.
- صفحهٔ دانلود (`site/index.html`)، `client/install.html` و کارت جفت‌سازی `pages.js` فقط به `native-continuous` اشاره می‌کنند. Android فقط پیوند برچسب انتشار را نشان می‌دهد، نه APK.
- سرویس دادهٔ اختیاری LAN (ردیف ۱۲۷) `node.exe` دارد و از Gate نمی‌گذرد، پس فقط artifact در CI است و منتشر نمی‌شود.

## ۳. Gateهایی که این را قفل می‌کنند

| بررسی‌کننده | چه چیزی را قفل می‌کند |
|---|---|
| `tools/installables-125.mjs` (رجیستری v2، I‑01..I‑11، ۳۴ جهش) | ممنوعیت ورود WebView منتشرشده (I‑01)، کانال فقط بومی (I‑08)، ناشر Gate‌شده که نام فایل را صریح می‌آورد (I‑10)، پیوندهای سایت (I‑11) |
| `tests/landing-114.js` (۸ بررسی) | صفحهٔ دانلود فقط فایل‌های بومی و Android = BLOCKED |
| `school-webview-control.yml` | ساخت WebView2 + node.exe مدرسه با توکن فقط‌خواندنی؛ Gate باید **رد** کند (`--expect-fail`) |
| `native-client.yml` (gate-controls) | APK وب‌ویوی قبلی (`install/legacy-webview-fixtures/`، SHA‑256 قفل) ⇒ `NATIVE-GATE-NEGATIVE-CONTROL-OK` |
| `build.yml` | `CONTINUOUS-129-OK`؛ مرحلهٔ کنترل منفی APK فقط با امضای آماده اجرا می‌شود |

## ۴. یافتهٔ CI: بن‌بست مهاجرت با push زنده (Gateway IT ناپایدار)

- روی `8566d83` کار «Dart Gateway client — pinned TLS against the REAL Gateway + PostgreSQL» قرمز شد (W3‑IT‑03: applied 0، W3‑IT‑08: conflicts 0). همین کار پیش‌تر هم روی `00618d8` (W2‑IT‑03/04) و `8d15f1d` (W2‑IT‑01..04) ناپایدار شده بود، پس ریشه پیش از ۱۲۹ بود.
- **ریشه:** هشت فایل IT هم‌زمان اجرا می‌شوند و هر هارنس `tenancy.migrate()` را روی پایگاه مشترک صدا می‌زند. مهاجرت ردیف ۱۲۶ (یک تراکنش + قفل مشورتی) قفل‌های جدول را دستور به دستور ارتقا می‌داد. یک push زنده با ACCESS SHARE در صف ROW EXCLUSIVE می‌ماند و بن‌بست Postgres (40P01) رخ می‌داد. گاهی **push زنده** قربانی می‌شد، پاسخ 503 بود و صندوقچه در انتظار می‌ماند.
- بازتولید [S]: حلقهٔ مهاجرت هم‌زمان با مجموعهٔ ۸ فایلی CI شکست‌های انبوه `deadlock detected` داد. بدون حلقه، ۳ از ۳ سبز بود.
- **اصلاح در محصول** (`server/tenancy.js`)، نه پنهان‌کردن در آزمون:
  1. **مهاجرت حالت پایدار بی‌DDL است.** پشت همان قفل مشورتی، اثرانگشت `SCHEMA_SQL` در `payesh_tenancy_schema` مقایسه می‌شود. اگر برابر باشد، هر ۸ جدول مستأجر FORCE RLS و سیاست داشته باشند و هر دو نقش موجود باشند، هیچ قفل جدولی گرفته نمی‌شود. هر انحرافی (مثلاً سیاست حذف‌شده) ⇒ اجرای کامل و ترمیم.
  2. **مهاجرت واقعی همهٔ جدول‌ها را از ابتدا قفل می‌کند** (ACCESS EXCLUSIVE، یک ترتیب ثابت، متن SQL ثابت با `%I`) ⇒ ارتقای قفل و بن‌بست حذف می‌شود.
  3. **`withTenant` تراکنش قربانی را کامل دوباره اجرا می‌کند** (فقط 40P01/40001، حداکثر `PAYESH_PG_TX_ATTEMPTS`، پیش‌فرض ۴، سقف ۱۰). هر ۲۹ فراخوانی بررسی شد. `rekeyFields` شمارنده‌اش را درون closure صفر می‌کند.
- آزمون‌ها (`tests/migrate-atomic-126.js`، در CI api-contract):

| شناسه | نتیجه [S] |
|---|---|
| M126‑05 | ۳ مهاجرت اجباری + ۶ push چندجدولی واقعی: `deadlock_victims=0 other=0 migrate_failed=0` (حدود ۲۳۰۰ push، حدود ۳۵۰ مهاجرت) |
| M126‑06 | **کنترل منفی:** مهاجرت ردیف ۱۲۶ زیر همان بار ⇒ `40P01 deadlock detected` |
| M126‑07 | بن‌بست قطعی: پیش‌فرض ⇒ هر دو commit با یک اجرای دوباره. **منفی** `PAYESH_PG_TX_ATTEMPTS=1` ⇒ دقیقاً یک 40P01 |
| M126‑08 | حالت پایدار `skipped=true` زیر تراکنش زنده (حدود ۲ms، بدون انتظار)؛ سیاست حذف‌شده ⇒ اجرای کامل و ترمیم |

- مجموعهٔ ۸ فایلی CI در کنار **۲۳۴۴ مهاجرت اجباری هم‌زمان**: `+65: All tests passed!`، `errors 0`، هیچ deadlock.
- اولین push اصلاح، دروازهٔ SAST ردیف ۴۸ را قرمز کرد (`payesh-sql-string-concat` 21 > سقف 20، به خاطر یک `lock table ${…}`). به‌جای بالا بردن سقف، دستور قفل به متن ثابت تبدیل شد و نگهبان هنگام بارگذاری هم‌خوانی آن را با فهرست ثابت‌ها تضمین می‌کند. نتیجهٔ محلی با semgrep 1.184.0: `SECURITY-48-OK`.
- `PAYESH_PG_TX_ATTEMPTS` در `deploy/gateway/env-catalog.json` ثبت شد (GB‑02).

## ۵. آزمون‌ها [S]

| مجموعه | نتیجه |
|---|---|
| `npm test` | 132/132 |
| `migrate-atomic-126` روی PG 17 واقعی | `MIGRATE-ATOMIC-126-OK` (۸/۸) |
| `gateway-bundle-120` با PG | `GATEWAY-BUNDLE-120 OK passed=17` |
| `security-scan-48` با semgrep | `SECURITY-48-OK` (۱۳/۱۳) |
| `contract-vectors-64`، `gateway-67`، `offline-119`، `load-82`، `tenant-121`، `field-crypto-87`، `directory-66`، `cell-transfer-54`، `native-wave1..3-74`، `gateway-pg` | همه سبز روی PG واقعی |
| Gateway IT (۸ فایل Dart) | 65/65 تمیز، زیر حلقهٔ مهاجرت عادی و زیر حلقهٔ مهاجرت اجباری |
| رجیستری/صفحهٔ دانلود | `INSTALLABLES-125-OK entries=14 native=4 webview_still_published=0` · `INSTALLABLES-125-TEST-OK checks=4 mutations=34` · `LANDING-114-OK checks=8` |

## ۶. باقی‌مانده (مسدود به دست مالک، با شاهد)

| ردیف | وضعیت | شاهد |
|---|---|---|
| ۶۱ — APK مدرسه | **BLOCKED** (کلید امضای مالک نیست) | `school-native-status.json` → `"android": "BLOCKED — no owner signing key (row 61)"`؛ لاگ ناشر `android=BLOCKED`؛ مرحلهٔ کنترل منفی APK در build-and-release رد شد چون امضا آماده نیست |
| Authenticode ویندوز | **BLOCKED** (اسرار `PAYESH_WIN_PFX_*` نیست) | `school-native-status.json` → `"windows": "… Authenticode: BLOCKED unless PAYESH_WIN_PFX_* secrets exist"` |
| ۱۱۶ / ۱۲۰ — هاست واقعی Gateway [M] | منتظر مالک | فقط [S] در CI (`GATEWAY-BUNDLE-120 OK`) |
| ۹۱ — آزمون روی دستگاه و سرور واقعی مدرسه [M] | منتظر مالک | — |
