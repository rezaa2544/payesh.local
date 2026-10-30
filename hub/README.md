# Hub ابری پایش (اختیاری)

برای وقتی که **سیستم مدرسه خاموش است** ولی ولی/دانش‌آموز می‌خواهد آخرین وضعیت را ببیند یا درخواست مرخصی ثبت کند.
رایگان است (Cloudflare Workers + D1: تا ۱۰۰٬۰۰۰ درخواست در روز).

## استقرار (۱۰ دقیقه، یک‌بار)

```bash
npm i -g wrangler          # یا: npx wrangler
wrangler login
wrangler d1 create payesh_hub
# شناسهٔ چاپ‌شده را در wrangler.toml جای PASTE_D1_DATABASE_ID بگذارید
wrangler d1 execute payesh_hub --remote --file=schema.sql
wrangler secret put SCHOOL_KEY     # کلید را از پنل مدیر ← شبکه بردارید
wrangler deploy
```

آدرسی مثل `https://payesh-hub.<account>.workers.dev` می‌گیرید؛ آن را در پنل مدیر ← «شبکه» در بخش Hub ذخیره و فعال کنید.

## چه چیزی رد و بدل می‌شود؟

| مسیر | طرف | محتوا |
|---|---|---|
| `POST /v1/push` | مدرسه → Hub | خلاصهٔ هر دانش‌آموز (بدون کد ملی، بدون نمرهٔ خام دیگران) |
| `GET /v1/family` | گوشی ولی → Hub | فقط خلاصهٔ فرزند خودش |
| `POST /v1/outbox` | گوشی ولی → Hub | درخواست مرخصی در صف |
| `GET /v1/outbox` + `ack` | مدرسه ← Hub | کشیدن و تأیید درخواست‌ها هنگام روشن شدن |

توکن هر خانواده از سمت مدرسه با `HMAC(SCHOOL_KEY, "family:<student_id>")` ساخته می‌شود؛ Hub فقط `sha256` آن را ذخیره می‌کند.
