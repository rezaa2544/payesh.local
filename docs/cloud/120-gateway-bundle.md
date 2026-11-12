# ۱۲۰ — بستهٔ استقرار Gateway چندمستأجری + PostgreSQL + selfcheck + runbook

> **وضعیت:** بخش [S] (ساخت بسته، پیش‌بررسی، ابزار مدیریت، selfcheck سرتاسری روی PostgreSQL محلی/CI) انجام شده است.
> **بخش [M] (اجرا روی هاست واقعی با HTTPS عمومی) NOT RUN است.** این بخش به نتیجهٔ پروب هاست در ردیف ۱۱۶ (کار مالک، ابزار ردیف ۱۱۵) وابسته است.
> برچسب‌ها: **[S]** یعنی در sandbox یا CI اجرا و سنجیده شد. **[M]** یعنی باید روی میزبان واقعی اجرا شود. **NOT RUN** یعنی اجرا نشده و ادعایی دربارهٔ آن نداریم.
> امنیت: تا ردیف ۹۲ (آزمون نفوذ T2) وضعیت امنیتی **UNKNOWN** است.

## ۰. این بسته چیست و چه نیست

- **هست:** Gateway چندمستأجری (`server/gateway.js`). همهٔ مدرسه‌ها با جداسازی RLS در یک PostgreSQL هستند. API پنل مالک (`/api/platform/v1`) و ساخت مدرسه (ردیف ۱۲۱) پشت همین Gateway سرو می‌شوند.
- **نیست:** سرور تک‌مدرسه‌ای `server/index.js` (SQLite). راهنمای آن در `deploy/README.md` است. ساخت بسته عمداً هر فایل سرور تک‌مدرسه‌ای (`server/index.js`، `server/db.js`، `server/tunnel.js`، …) را **رد** می‌کند.
- **بدون Cloudflare (D‑09):** بستهٔ اختیاری `pg-cloudflare` هرگز داخل بسته نمی‌رود. selfcheck هم اگر پاسخی از Cloudflare عبور کرده باشد (`cf-ray` یا `server: cloudflare`) آن را **FAIL** می‌کند.
- **بدون هزینهٔ پنهان (D‑40):** بسته به هیچ سرویس پولی وصل نمی‌شود. PostgreSQL مدیریت‌شده، دامنه یا VPS فقط با تأیید کتبی مالک تهیه می‌شود.

## ۱. پیش‌نیازها

| مورد | حداقل | توضیح |
|---|---|---|
| Node.js | ۲۲ | `start.cjs` با نسخهٔ پایین‌تر بالا نمی‌آید (کد خروج ۲). |
| PostgreSQL | ۱۴ یا بالاتر | روی همان هاست، یا مدیریت‌شده (ردیف ۱۱۳). در CI روی نسخهٔ ۱۶ و در sandbox روی ۱۷ سنجیده شد. |
| اتصال مدیر | نقشی با `CREATEROLE` که مالک دیتابیس باشد | فقط برای `admin.cjs`. Gateway در حال اجرا هرگز این اتصال را ندارد. |
| HTTPS | گواهی معتبر (Let’s Encrypt یا SSL پنل) | **[M]**. روی نشانی عمومی بدون https، selfcheck شکست می‌خورد. |

## ۲. ساخت بسته (روی رایانهٔ خودتان یا CI)

```bash
npm ci
node scripts/build-gateway-bundle.mjs
# خروجی:
#   .build/gateway-bundle/payesh-gateway/              ← پوشهٔ آماده
#   .build/gateway-bundle/payesh-gateway-<نسخه>.tar.gz
#   .build/gateway-bundle/payesh-gateway-<نسخه>.zip   ← اگر دستور zip نصب باشد
```

اسکریپت این کارها را خودکار انجام می‌دهد و در صورت بروز هر مشکل متوقف می‌شود (کد خروج ۱):
- از نقطه‌های ورود شروع می‌کند و همهٔ `require`های نسبی را فایل‌به‌فایل دنبال می‌کند. فایل‌هایی که با `path.join(__dirname, …)` خوانده می‌شوند (مثل `openapi.json`) هم برداشته می‌شوند. **فقط همین فایل‌ها** در بسته قرار می‌گیرند.
- از `node_modules` فقط درخت تولیدی `pg` را برمی‌دارد، بدون وابستگی‌های اختیاری. پس بسته بدون `npm install` روی هاست کار می‌کند.
- هر متغیر محیطی را که کد می‌خواند با `deploy/gateway/env-catalog.json` مقایسه می‌کند. اگر متغیری در کد باشد و در فهرست نباشد، یا برعکس، بسته ساخته نمی‌شود.
- هر چیزی را که شبیه راز باشد پیدا می‌کند و ساخت را متوقف می‌کند: نشانی دیتابیس همراه رمز، کلید خصوصی، توکن GitHub، فایل `.env`، یا مقدار پرشدهٔ یک متغیر رازدار در `gateway.env.example`.
- در `BUNDLE-MANIFEST.json`، sha256 همهٔ فایل‌ها و شناسهٔ commit را ثبت می‌کند.

محتوای بسته: `gateway-start.cjs` (فایل شروع)، `server/…` (فقط فایل‌های Gateway)، `apps/owner-panel/server/…`، `deploy/gateway/{start.cjs,admin.cjs,selfcheck.mjs,env-catalog.json,payesh-gateway.service}`، `db/migrations/owner-panel/*.sql`، `node_modules/` (۱۳ بستهٔ درخت pg)، `gateway.env.example`، `START-HERE.txt` و همین سند.

## ۳. آماده‌سازی دیتابیس (یک‌بار، با اتصال مدیر)

ابتدا یک دیتابیس خالی بسازید. اگر PostgreSQL روی هاست است، از psql یا پنل استفاده کنید. اگر مدیریت‌شده است، از کنسول همان سرویس. سپس در پوشهٔ بسته:

```bash
export PAYESH_PG_ADMIN='postgres://<نقش-مدیر>:<رمز>@<میزبان>:5432/<دیتابیس>?sslmode=require'

# ۱) طرح چندمستأجری (RLS اجباری روی ۸ جدول) + migrationهای پنل مالک (۰۰۱ تا ۰۰۶)
node deploy/gateway/admin.cjs migrate
#    اجرای دوباره بی‌خطر است: فقط موارد تازه اعمال می‌شوند. اگر فایلی که قبلاً اعمال شده
#    تغییر کرده باشد (sha256 متفاوت)، اجرا متوقف می‌شود.

# ۲) دو نقش ورود جدا برای Gateway
export PAYESH_RUNTIME_PASSWORD="$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")"
export PAYESH_PLATFORM_LOGIN_PASSWORD="$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")"
node deploy/gateway/admin.cjs logins
#    فقط هش SCRAM-SHA-256 به سرور فرستاده می‌شود (مثل \password در psql)، پس رمز خام در
#    لاگ PostgreSQL نمی‌ماند. خروجی، الگوی دو نشانی را با <PASSWORD> به جای رمز چاپ می‌کند.
#    این دو رمز را همین حالا در مدیر رمز خودتان ذخیره کنید.

# ۳) بررسی فقط‌خواندنی
node deploy/gateway/admin.cjs check
#    باید «GW-ADMIN check OK» ببینید. این بررسی تأیید می‌کند که هیچ‌یک از دو نقش SUPERUSER یا
#    BYPASSRLS نیست، RLS روی همهٔ جدول‌های مستأجر اجباری است، نقش runtime به owner_platform
#    دسترسی ندارد و همهٔ migrationها با همان sha256 اعمال شده‌اند.

# ۴) نخستین حساب پنل مالک (رمز + TOTP، حداکثر ۳ حساب، D‑45)
node deploy/gateway/admin.cjs create-owner --login-id <شناسهٔ-شما>
#    رمز بدون نمایش پرسیده می‌شود. یک URI از نوع otpauth:// فقط همین یک بار چاپ می‌شود؛
#    همان لحظه آن را در Authenticator ثبت کنید.

unset PAYESH_PG_ADMIN PAYESH_RUNTIME_PASSWORD PAYESH_PLATFORM_LOGIN_PASSWORD
```

## ۴. متغیرهای محیطی Gateway

فهرست کامل و توضیح هر متغیر در `gateway.env.example` آمده است، که از روی `deploy/gateway/env-catalog.json` ساخته می‌شود و با خود کد همگام می‌ماند. برای شروع فقط این‌ها لازم‌اند:

| متغیر | لازم؟ | مقدار |
|---|---|---|
| `PGURL` | بله | `postgres://payesh_runtime:<رمز runtime>@<میزبان>:5432/<دیتابیس>?sslmode=require` |
| `GW_SECRET` | بله | دست‌کم ۳۲ نویسهٔ تصادفی (`randomBytes(32)`) |
| `PAYESH_PLATFORM_PGURL` | برای پنل مالک | `postgres://payesh_platform_login:<رمز پلتفرم>@…` — **نباید** با `PGURL` یکی باشد |
| `PAYESH_PLATFORM_TOKEN_SECRET` | برای پنل مالک | دست‌کم ۳۲ نویسه و متفاوت از `GW_SECRET` |
| `PAYESH_METRICS_TOKEN` | توصیه‌شده | توکن `/metrics` روی میزبان عمومی |
| `PORT` / `HOST` | اختیاری | پنل خودش PORT را می‌دهد. پشت Nginx: `HOST=127.0.0.1` |

**جای رازها:** در هاست پنلی، بخش «Environment variables» پنل. در VPS، فایل `/etc/payesh/gateway.env` با مالک root و مجوز `600`، بیرون از پوشهٔ برنامه. **هرگز** فایل پرشده را در Git، چت یا تیکت نگذارید. `PAYESH_PG_ADMIN` نباید در محیط دائمی Gateway باشد؛ اگر باشد، پیش‌بررسی هشدار می‌دهد.

## ۵. بالا آوردن

### راه الف — پنل هاست با «Setup Node.js App» (cPanel/DirectAdmin/Plesk/Passenger)
۱. فایل `payesh-gateway-<نسخه>.zip` (یا tar.gz) را در یک پوشهٔ تازه بارگذاری و باز کنید.
۲. Node نسخهٔ ۲۲ یا بالاتر را انتخاب کنید. Application root همان پوشه و **Startup file** برابر `gateway-start.cjs` باشد.
۳. متغیرهای بخش ۴ را در پنل وارد کنید.
۴. اپ را Start کنید. در لاگ پنل باید `gateway_listening` را ببینید. اگر `GW-PREFLIGHT REFUSED` دیدید، به بخش ۸ بروید.

### راه ب — VPS با systemd
```bash
sudo useradd --system --home /opt/payesh-gateway --shell /usr/sbin/nologin payesh
sudo mkdir -p /etc/payesh
sudo tar -xzf payesh-gateway-<نسخه>.tar.gz -C /opt          # ⇒ /opt/payesh-gateway
sudo install -m 600 -o root -g root /dev/null /etc/payesh/gateway.env     # سپس با ویرایشگر پر کنید
sudo cp /opt/payesh-gateway/deploy/gateway/payesh-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now payesh-gateway
systemctl status payesh-gateway ; journalctl -u payesh-gateway -f
```
در فایل unit، `ExecStartPre` همان پیش‌بررسی (`gateway-start.cjs --check`) را اجرا می‌کند. با `SIGTERM`، Gateway درخواست‌های در جریان را تخلیه می‌کند و بعد خاموش می‌شود.

HTTPS با Nginx و Certbot (Let’s Encrypt رایگان است و به Cloudflare نیازی نیست):
```nginx
server {
  server_name api.<دامنهٔ-شما>;
  location / { proxy_pass http://127.0.0.1:5660; proxy_set_header Host $host;
               proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; client_max_body_size 2m; }
}
# sudo certbot --nginx -d api.<دامنهٔ-شما>
```

## ۶. بررسی سرتاسری

```bash
# پیش‌بررسی بدون بالا آوردن (همان قواعدی که هنگام شروع اعمال می‌شود)
node gateway-start.cjs --check                 # GW-PREFLIGHT OK

# بررسی سریع از بیرون (بدون ساختن داده)
node deploy/gateway/selfcheck.mjs https://api.<دامنهٔ-شما>

# بررسی کامل: ابتدا در پنل مالک دو مدرسهٔ «آزمایشی» بسازید و کد یک‌بارمصرف مدیر هر دو را بردارید
node deploy/gateway/selfcheck.mjs https://api.<دامنهٔ-شما> \
     --school test-a --code <کد مدرسهٔ ۱> --school2 test-b --code2 <کد مدرسهٔ ۲>
```

| شناسه | چه چیزی | سبز یعنی |
|---|---|---|
| S01 | `/healthz` | فرایند زنده است |
| S02 | `/readyz` | DB وصل است و زمینهٔ مستأجر فقط درون تراکنش می‌ماند (نشت پس از COMMIT ندارد) |
| S03 / S04 | pull بدون توکن یا با توکن جعلی | هر دو ۴۰۱ (fail-closed) |
| S05 | API پنل مالک | پیکربندی شده است؛ بدون توکن ۴۰۱ می‌دهد، نه ۵۰۳ |
| S06 | HTTPS | https یعنی PASS. http روی loopback فقط WARN است ([S] محلی). http عمومی FAIL است |
| S07 | Cloudflare | هیچ نشانه‌ای در پاسخ‌ها نیست (D‑09) |
| S08 | زمان پاسخ | کمتر از ۱٫۵ ثانیه |
| S09 | فعال‌سازی | مدیر مدرسهٔ ۱ با کد یک‌بارمصرف وارد می‌شود |
| S10 | نوشتن و خواندن | یک رکورد نشانه نوشته و دوباره خوانده می‌شود |
| S11 | جداسازی | مدرسهٔ ۲ رکورد نشانهٔ مدرسهٔ ۱ را **نمی‌بیند** |
| S12 | پاک‌سازی | رکورد نشانه حذف می‌شود |

کدهای یک‌بارمصرف را خود selfcheck مصرف می‌کند. اجرای دوباره با همان کدها در S09 شکست می‌خورد، و این رفتار درست است. کدها و توکن‌ها هرگز چاپ نمی‌شوند. پس از بررسی، مدرسه‌های آزمایشی را از پنل تعلیق کنید. حذف دومرحله‌ای است و ۲۴ ساعت تأخیر دارد.

## ۷. به‌روزرسانی و بازگشت

۱. بستهٔ تازه را بسازید و در پوشهٔ **جدید** باز کنید (مثلاً `/opt/payesh-gateway-<نسخه>`).
۲. `admin.cjs migrate` را با اتصال مدیر اجرا کنید. migrationها افزایشی و idempotent هستند.
۳. پیوند یا پوشهٔ سرویس را به نسخهٔ جدید تغییر دهید و `systemctl restart payesh-gateway` را اجرا کنید (تخلیهٔ تمیز). در پنل: Restart.
۴. selfcheck را اجرا کنید.
**بازگشت:** سرویس را به پوشهٔ قبلی برگردانید. migrationهای پنل مالک فایل `down` دارند، ولی بدون پشتیبان تأییدشده و تأیید مالک روی دادهٔ واقعی اجرا نکنید (`db/migrations/owner-panel/README.md`).

## ۸. عیب‌یابی پیش‌بررسی

| کد | معنی | کار |
|---|---|---|
| `pgurl_missing` / `gw_secret_missing` / `gw_secret_weak` | متغیر لازم نیست یا کوتاه است | بخش ۴ |
| `platform_same_principal` / `platform_secret_reused` | پنل مالک و مدرسه نقش یا کلید مشترک دارند | دو نقش و دو کلید جدا |
| `role_bypasses_rls` (کد خروج ۳) | `PGURL` با نقش SUPERUSER یا BYPASSRLS وصل شده؛ RLS اعمال نمی‌شود | از `payesh_runtime` و `admin.cjs logins` استفاده کنید |
| `schema_missing` / `platform_schema_missing` | migration اجرا نشده | `admin.cjs migrate` و سپس `logins` |
| `db_unreachable` (کد خروج ۳) | اتصال برقرار نشد | میزبان/پورت/فایروال/`sslmode` را بررسی کنید. اگر DB خارج از هاست است، باز بودن پورت خروجی 5432 را از پشتیبانی بپرسید (پروب ۱۱۵) |
| `unknown_var` (هشدار) | متغیری با پیشوند `GW_`/`PAYESH_` در فهرست نیست | احتمالاً غلط تایپی است؛ `env-catalog.json` را ببینید |

## ۹. آنچه سنجیده شد [S] و آنچه NOT RUN [M]

**[S] — `tests/gateway-bundle-120.js`** (بخش ایستا در `npm test`، بخش PostgreSQL در CI `api-contract` روی postgres:16):
- ساخت بسته، closure (بدون فایل تک‌مدرسه‌ای)، نبود `pg-cloudflare`، sha256 همهٔ فایل‌های مانیفست.
- برابری متغیرهای محیطی کد با فهرست (کنترل منفی: متغیر تازه یا متغیر کهنه).
- پویش راز (۵ راز کاشته‌شده پیدا شد و الگوهای `<…>` اشتباهاً گرفته نشدند).
- قواعد پیش‌بررسی و رد شدن بستهٔ بازشده با محیط خالی (کد خروج ۲).
- تأیید هش SCRAM با کد SASL خود pg.
- selfcheck در برابر سرورهای ساختگی معیوب (نشت جداسازی، Cloudflare، نشت زمینهٔ مستأجر، پذیرش توکن جعلی، پنل خاموش): همه FAIL شدند.
- ۱۱ جهش (mutant) که همه شکست خوردند (killed).
- روی PostgreSQL واقعی، بستهٔ بازشده **بیرون از مخزن**: migrate، اجرای دوباره، رد migration دست‌کاری‌شده، logins و check، رد superuser (کد خروج ۳؛ جهش بدون این کنترل آن را می‌پذیرد)، ساخت مالک، ورود با رمز + TOTP، پلن، دو مدرسه، selfcheck کامل (S09 تا S12 سبز، S06 = WARN)، رد کدهای تکراری، تخلیه با SIGTERM، و مشترک بودن دفتر migration با local-up.
- محدودیت [S]: در sandbox و CI احراز PostgreSQL از نوع `trust` است. پس ورود واقعی با رمز SCRAM فقط از راه شبیه‌سازی SASL سنجیده شد، نه با یک سرور `scram-sha-256`.

**NOT RUN [M]** (به ردیف ۱۱۶ و هاست واقعی وابسته است):
- بالا آوردن روی هاست واقعی (پنل یا VPS)، HTTPS عمومی با گواهی معتبر، و S06 = PASS.
- PostgreSQL روی خود هاست یا مدیریت‌شده (ردیف ۱۱۳) با `sslmode=require` و احراز SCRAM واقعی.
- ماندگاری و «همیشه‌روشن» بودن، تأخیر از شبکهٔ ایران، و لاگ پنل.
- آزمون نفوذ (ردیف ۹۲). وضعیت امنیتی **UNKNOWN** است.
