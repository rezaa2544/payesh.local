# موتور دادهٔ مرورگری (IndexedDB) و سنجهٔ ۱۰۰هزار ردیف — ردیف ۳۹

| | |
|---|---|
| ردیف | ۳۹ (فاز ۳ — نمونهٔ فنی) · وابسته به ۳۱ (`ADR-31`) |
| وضعیت | **PASS (Done)**: موتور، آزمون درستی (`EW-01..EW-10`) و ۴ اجرای واقعی ۱۰۰هزار ردیفی روی Chrome 157 دسکتاپ (عادی + CPU 4×) و گوشی اندروید (`POCO X7 Pro`) ثبت و راستی‌آزمایی شده است (`EW-11..EW-14`) |
| کد محصول | `client/engine-web.js` (موتور IndexedDB) · `bench/39/index.html` (سنجه) · `tools/serve-bench.mjs` (سرور ایستا) |
| آزمون درستی و شاهد | `npm run test:engine` → `tests/engine-web.js` — `EW‑01..EW‑14` (`14/14 PASS`) · `docs/cloud/reports/evidence/engine-web-39.txt` |
| شواهد خام مرورگر/گوشی | `docs/cloud/reports/evidence/bench-39-{chrome-desktop,chrome-desktop-run2,chrome-desktop-cpu4,android-webview}.json` |

---

## ۱. مسئله

پیش از این ردیف، UI کل دیتاست را به‌صورت **یک blob** در IndexedDB (`idbSet('data', …)`) نگه می‌داشت. با ۱۰۰هزار ردیف این کار یعنی ساختن و پارس کردن یک JSON چند ده‌مگابایتی در حافظه و کندی محسوس در هر به‌روزرسانی. ردیف ۳۹ موتور داده را در مرورگر/WebView به‌صورت ردیف‌به‌ردیف، ایندکس‌شده و قابل پرس‌وجو پیاده‌سازی می‌کند.

## ۲. API موتور (همان کاری که صفحه‌ها می‌خواهند)

| متد | کار |
|---|---|
| `open(name)` | باز کردن/ساختن دیتابیس (store `rows` + ایندکس‌های `collection`، `refs`، `updated`) |
| `put(collection, id, data, {version, updated_at})` | درج/به‌روزرسانی یک ردیف |
| `putMany(rows)` / `loadChunked(rows, {chunk})` | درج دسته‌ای در یک تراکنش به‌ازای هر چانک (`chunk=2000`) |
| `get(collection, id)` · `count(collection)` | خواندن یک ردیف / شمارش کالکشن (با ایندکس، نه اسکن) |
| `list(collection, {limit, offset})` | صفحه‌بندی پایدار |
| `byRef(collection, field, value)` | «همهٔ حضور و غیاب این کلاس» — ایندکس `multiEntry` روی `*_id`ها |
| `since(collection, isoTime)` | ردیف‌های تغییریافته برای همگام‌سازی |
| `del(collection, id)` · `clear()` · `stats()` | حذف، پاک‌سازی، آمار |

`client/engine-web.js` هیچ وابستگی خارجی ندارد (فقط IndexedDB استاندارد W3C)؛ در Node با `fake-indexeddb` و در مرورگر/WebView با IndexedDB واقعی اجرا می‌شود.

## ۳. نتایج اندازه‌گیری واقعی ۱۰۰٬۰۰۰ ردیف `[M]`

هر ۴ اجرا با `rows_requested=100000` و `chunk=2000` روی موتور واقعی مرورگر/گوشی (غیر Headless) انجام شده و خروجی خام آن‌ها در `docs/cloud/reports/evidence/bench-39-*.json` ثبت شده است:

| محیط اجرا | کالیبراسیون CPU (`calib_ms`) | بارگذاری ۱۰۰٬۰۰۰ ردیف (`load_ms` / `rows/s`) | `count(100k)` | پرس‌وجوی ایندکسی (`class_id=1`، ۲۵۰۰ ردیف) | صفحه‌بندی (`۵۰` ردیف) | بازگشایی مجدد + اولین `get` | حافظهٔ JS (`used_mb`) | حجم دیسک (`usage_mb`) | حکم |
|---|---|---|---|---|---|---|---|---|---|
| **Chrome 157 Desktop — نوبت ۱** (Win32، 8 هسته، 16GB) | `1062 ms` | `72,086 ms` (`1,387 rows/s`) | `555 ms` | `262 ms` | `12 ms` | `1 ms` + `1 ms` | `24.9 MB` (از `11.6 MB`) | `53.0 MB` | `BENCH39-OK` |
| **Chrome 157 Desktop — نوبت ۲** (Win32، 8 هسته، 16GB) | `908 ms` | `50,728 ms` (`1,971 rows/s`) | `581 ms` | `207 ms` | `10 ms` | `0 ms` + `1 ms` | `26.1 MB` (از `1.3 MB`) | `63.6 MB` | `BENCH39-OK` |
| **Chrome 157 Desktop — CPU 4× Throttle** | `4063 ms` (`3.8×`) | `136,563 ms` (`732 rows/s`) | `532 ms` | `888 ms` | `18 ms` | `1 ms` + `2 ms` | `52.5 MB` (از `33.2 MB`) | `63.1 MB` | `BENCH39-OK` |
| **Android 16 — POCO X7 Pro** (Chrome/WebView 156، 8 هسته، 8GB) | `428 ms` | `21,830 ms` (`4,581 rows/s`) | `186 ms` | `168 ms` | `8 ms` | `2 ms` + `1 ms` | `9.5 MB` (از `1.4 MB`) | `—` | `BENCH39-OK` |

## ۴. آزمون درستی و کنترل منفی (`EW-01..EW-14`)

- `EW-01..EW-10`: درستی کامل API (`open`, `put`, `get`, `byRef`, `list`, `since`, `del`, `loadChunked`, ماندگاری بعد از `close/open`, `stats`).
- `EW-11..EW-13`: راستی‌آزمایی خودکار هر ۴ فایل شاهد واقعی (`count=100000`، `stat_after_reopen=100000`، `first_get_found=true`، مرورگر غیر Headless، کالیبراسیون واقعی CPU 4×، و حافظهٔ محدود).
- `EW-14` (کنترل منفی): رد شدن خودکار فایل شاهد در صورت `HeadlessChrome`، شمارش کمتر از ۱۰۰هزار، `verdict !== BENCH39-OK` یا نبود اثر واقعی CPU throttle.

## ۵. مرز صداقت

- اندازه‌گیری‌های بالا روی ۱۰۰هزار ردیف در Chrome 157 دسکتاپ (عادی و 4× CPU throttle) و گوشی اندروید (`POCO X7 Pro`) واقعی است (`[M]`).
- رفتار eviction مرورگر در صورت پر شدن کامل دیسک دستگاه و حجم‌های بسیار بزرگ‌تر (۵۰۰هزار+ ردیف) خارج از دامنهٔ این سنجه است.
- وضعیت امنیتی کلی سامانه همچنان **UNKNOWN** است.
