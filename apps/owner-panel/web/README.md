# پنل مالک پلتفرم — SPA فارسی/RTL (PR‑3 · ردیف ۹۸)

اپ ایستا و مستقل برای پنل مالک. **هیچ وابستگی اجرایی به `client/pages.js` یا هیچ فایل `client/*` ندارد**، از CDN، فونت یا اسکریپت خارجی استفاده نمی‌کند و فقط با `/api/platform/v1` روی همان مبدأ حرف می‌زند (API مستقل PR‑2).

| فایل | نقش |
|---|---|
| `index.html` | پوسته، `lang="fa-IR" dir="rtl"`، CSP سخت در meta |
| `app.js` | SPA بدون build (هش‌روتر، بدون `innerHTML`/`eval`) |
| `app.css` | چیدمان؛ **فقط** متغیرهای پوسته، بدون رنگ مستقیم |
| `theme.css` | **تولیدشده** از `client/pulse.css` — دستی ویرایش نشود |
| `manifest.webmanifest` | `theme_color=#0d9488`، `background_color=#eef7f5` (برابر `--primary`/`--bg` نبض؛ آزمون می‌شود) |
| `icons/*` | کپی بایت‌به‌بایت از `client/icons/` (آزمون می‌شود) |

## پوستهٔ «نبض» و آزمون drift

```
node apps/owner-panel/scripts/gen-theme.js          # بازتولید theme.css از client/pulse.css
node apps/owner-panel/scripts/gen-theme.js --check  # فقط بررسی (THEME-OK / THEME-DRIFT)
```

`theme.css` سه حالت دارد: روشن (`:root`)، تاریکِ سیستم‌عامل مگر کاربر «روشن» را انتخاب کرده باشد (`:root:not([data-theme="light"])`)، و تاریکِ صریح (`:root[data-theme="dark"]`). دکمهٔ «پوسته» بین سیستم ← روشن ← تاریک می‌چرخد و فقط همین ترجیح را در `localStorage` نگه می‌دارد.

### اختلاف توکن‌ها (سند ۶۱ §3.1) — ثبت‌شده، حل‌نشده

| توکن | حالت | `client/pulse.css` (به‌کاررفته) | prompt (به‌کارنرفته) |
|---|---|---|---|
| `--radius` | روشن | `18px` | `16px` |
| `--muted` | تاریک | `#91b1a8` | `#7fa39a` |
| `--line` | تاریک | `#203b35` | `#16302b` |
| `--primary-2` | تاریک | `#2dd4bf` | `#0d9488` |

این PR مقدار فایل فعلی `pulse.css` را به‌کار می‌برد و ادعای «تطابق دقیق با نبض» نمی‌کند. جدول در `scripts/gen-theme.js` (`TOKEN_DISCREPANCIES`) است و آزمون بررسی می‌کند (۱) هر ردیف هنوز همین وضع را دارد و (۲) مقدار prompt به پوسته نشت نکرده است. انتخاب نهایی با مالک است.

## اجرای محلی

```
PAYESH_PLATFORM_UPSTREAM=http://127.0.0.1:<gateway-port> \
PAYESH_OWNER_PANEL_PORT=8095 node apps/owner-panel/server/static-server.js
```

`static-server.js` پنل را روی مبدأ جدا از اپ مدرسه سرو می‌کند و `/api/platform/v1/*` را به Gateway می‌فرستد: CSP و هدرهای امنیتی، allowlist هدر (`authorization`, `content-type`, `accept`, `x-request-id`)، حذف cookie در هر دو جهت، رد redirect و پاسخ غیر JSON، رد بدنهٔ POST نامعتبر/غیر JSON/بیش از ۳۲KB، و بدون `PAYESH_PLATFORM_UPSTREAM` پاسخ `503 upstream_not_configured`.

## صفحه‌ها و اختیار

ورود + TOTP، داشبورد، مدارس، پلن و اشتراک، سقف و مصرف، سلامت، اپراتورها و مجوز، گزارش، ممیزی. هر صفحه حالت `loading` / `empty` / `error` دارد.

| عمل | owner | operator | support | مرجع نهایی |
|---|---|---|---|---|
| تمدید اشتراک، پلن جدید، کاربر جدید، تأیید/ابطال grant | ✓ | — | — | API (`needRole`) + `require_actor()` |
| تعلیق مدرسه | ✓ | ✓ | — | API |
| درخواست grant | — | ✓ | ✓ | API + قید چهارچشمی دیتابیس |
| درخواست حذف مدرسه | دکمه دارد؛ سرور **همیشه** `403 tenant_deletion_disabled` | — | — | API |

پنهان‌کردن دکمه امنیت نیست؛ آزمون عمداً gate UI را برای operator باز می‌کند و نشان می‌دهد سرور همچنان رد می‌کند.

## باز / NOT-RUN

- **ورود انسانی:** صادرکنندهٔ توکن با رمز + TOTP در API وجود ندارد (O‑17/O‑27 باز). فرم ورود به `POST /api/platform/v1/auth/login` می‌فرستد، پاسخ ۴۰۴ فعلی را صادقانه «ورود ممکن نیست» نشان می‌دهد و هیچ نشستی نمی‌سازد (fail-closed). توکن فقط در حافظه است؛ بازخوانی صفحه یعنی ورود دوباره.
- **حذف مدرسه:** گردش واقعی چهارچشمی، مهلت ۲۴ساعتهٔ بازگشت/اطلاع و نگهداری داده در سرور پیاده نشده؛ UI فقط دیالوگ و دلیل/تأیید دوباره را دارد و نتیجهٔ ۴۰۳ سرور را نشان می‌دهد.
- **فونت Vazirmatn:** در مخزن نیست؛ از فونت سیستم (Tahoma/Segoe UI) استفاده می‌شود تا هیچ فونت خارجی بارگیری نشود.
- سلامت جداگانهٔ هر مدرسه، گزارش‌های سروری (`/reports/*`) و تغییر سقف از UI در API وجود ندارند.
- آزمون مرورگر واقعی (Playwright/دستگاه)، استقرار پشت TLS و پنتست انسانی: **NOT-RUN**. امنیت: **UNKNOWN**.
