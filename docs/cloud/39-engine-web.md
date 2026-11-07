# موتور دادهٔ مرورگری (IndexedDB) و سنجهٔ ۱۰۰هزار ردیف — ردیف ۳۹

| | |
|---|---|
| ردیف | ۳۹ (فاز ۳ — نمونهٔ فنی) · وابسته به ۳۱ |
| وضعیت | **بخشی**: موتور و آزمون درستی نوشته و سبز است؛ **سنجهٔ Chrome/WebView و گوشی میان‌رده هنوز اجرا نشده** ⇒ ردیف Done نمی‌شود |
| کد محصول | `client/engine-web.js` (موتور IndexedDB) · `bench/39/index.html` (سنجه) · `tools/serve-bench.mjs` (سرور ایستا) |
| آزمون درستی | `npm run test:engine` → `tests/engine-web.js` — EW‑01..EW‑10 (۱۰/۱۰، با `fake-indexeddb`) |
| سنجهٔ کارایی | `npm run bench:39` → اجرای `bench/39` در Chrome/WebView واقعی (خارج از این محیط) |

---

## ۱. مسئله

امروز UI کل دیتاست را به‌صورت **یک blob** در IndexedDB (`idbSet('data', …)`) نگه می‌دارد. با ۱۰۰هزار ردیف این کار یعنی ساختن و پارس کردن یک JSON چند ده‌مگابایتی در حافظه و کندی محسوس در هر به‌روزرسانی. ردیف ۳۹ می‌خواهد موتور داده در مرورگر/WebView بماند، اما ردیف‌به‌ردیف و قابل پرس‌وجو.

## ۲. API موتور (همان کاری که صفحه‌ها می‌خواهند)

| متد | کار |
|---|---|
| `open(name)` | باز کردن/ساختن دیتابیس (store `rows` + ایندکس‌های `collection`، `refs`، `updated`) |
| `put(collection, id, data, {version, updated_at})` | درج/به‌روزرسانی یک ردیف |
| `putMany(rows)` / `loadChunked(rows, {chunk})` | درج دسته‌ای در یک تراکنش به‌ازای هر چانک |
| `get(collection, id)` · `count(collection)` | خواندن یک ردیف / شمارش کالکشن (با ایندکس، نه اسکن) |
| `list(collection, {limit, offset})` | صفحه‌بندی پایدار |
| `byRef(collection, field, value)` | «همهٔ حضور و غیاب این کلاس» — ایندکس `multiEntry` روی `*_id`ها |
| `since(collection, isoTime)` | ردیف‌های تغییریافته برای همگام‌سازی |
| `del(collection, id)` · `clear()` · `stats()` | حذف، پاک‌سازی، آمار |

`client/engine-web.js` هیچ وابستگی‌ای ندارد (فقط IndexedDB استاندارد)؛ در Node با `fake-indexeddb` و در مرورگر با IndexedDB واقعی اجرا می‌شود.

## ۳. آزمون درستی (اجراشده در این مخزن)

```
EW-01  store + ایندکس‌ها                       ✅
EW-02  put/get با نسخه                          version=3
EW-03  byRef روی کلیدهای *_id                   class1=2 student11=2
EW-04  list با limit/offset                     rows=200/201/202
EW-05  since برای همگام‌سازی                     changed=1
EW-06  حذف و count                              remaining=1
EW-07  بارگذاری دسته‌ای ۱۲٬۰۰۰ ردیف              rows=12000 ms=339
EW-08  پرس‌وجوی ایندکسی روی حجم بالا             class=1 rows=302 ms=84
EW-09  ماندگاری بین دو باز/بسته                  rows=12005
EW-10  stats به‌تفکیک کالکشن                     total=12005
ENGINE-WEB-OK
```

> عددهای بالا **کارایی واقعی مرورگر نیستند**: `EW-07/۰۸` روی `fake-indexeddb` در Node اندازه‌گیری شده‌اند و فقط «درستی مسیر» را ثابت می‌کنند. برای AC ردیف ۳۹ باید همین موتور در Chrome دسکتاپ و Android WebView با ۱۰۰هزار ردیف اجرا و زمان/حافظه ثبت شود.

## ۴. سنجهٔ ۱۰۰هزار ردیف (`bench/39`)

`bench/39/index.html` همان موتور را بار می‌کند و این‌ها را ثبت می‌کند: زمان باز شدن، زمان بارگذاری ۱۰۰هزار ردیف و ردیف/ثانیه، زمان `count`، پرس‌وجوی ایندکسی، صفحه‌بندی، `since`، زمان باز شدن مجدد (ماندگاری روی دیسک) و اولین `get`، حافظهٔ JS (`performance.memory` و در صورت وجود `measureUserAgentSpecificMemory`)، `storage.estimate`، و **کالیبراسیون CPU** (`calib_ms`) تا سرعت فقط در کنار قدرت پردازنده معنا شود.

خروجی: JSON در صفحه + `window.__BENCH39__` + عنوان صفحه `BENCH39-OK` + دکمهٔ دانلود/کپی.

### اجرا در محیط واقعی (خارج از سندباکس)

```bash
npm run bench:39                     # سرور ایستا روی http://127.0.0.1:8788
# Chrome دسکتاپ (یک‌بار بدون throttle و یک‌بار با CPU throttling ۴× در DevTools):
#   http://127.0.0.1:8788/bench/39/index.html?autorun=1&rows=100000&label=chrome-desktop
# Android WebView/Chrome روی همان شبکه:
#   http://<IP-دستگاه>:8788/bench/39/index.html?autorun=1&rows=100000&label=android-webview
```

سپس فایل‌های JSON را در `docs/cloud/reports/evidence/` بگذارید (`bench-39-chrome-desktop-<date>.json`، `bench-39-android-webview-<date>.json`). **تا وقتی این دو فایل نباشد، ردیف ۳۹ پاس نیست.**

## ۵. آنچه هنوز اثبات نشده

- اجرا و اندازه‌گیری در Chrome/WebView واقعی (AC دوم و سوم ردیف ۳۹).
- اینکه UI فعلی کامل روی این موتور سوار شده باشد (این ردیف برش «حضور و غیاب» را ممکن می‌کند؛ اتصال کامل صفحه‌ها کار ردیف بعدی است).
- حافظهٔ کل فرایند مرورگر در حجم‌های بزرگ‌تر (۳۰۰–۵۰۰ هزار ردیف) و رفتار eviction در اندروید.
- وضعیت امنیتی سامانه همچنان **UNKNOWN** است.
