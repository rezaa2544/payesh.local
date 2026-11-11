# ۸۰ — گزارش خطا و تلمتری با رضایت (opt-in) و بدون PII

> وضعیت: پیاده‌سازی و آزموده (ردیف ۸۰) روی PostgreSQL واقعی. ارسال **فقط از مسیر مستقیم** (ردیف ۱۱۰)، نه Gateway (یادداشت Notion).
> قرارداد: [`contracts/telemetry-v1.schema.json`](../cloud/contracts/telemetry-v1.schema.json) · کلاینت: `client/telemetry.js` · سرور: `db/migrations/direct/0007_direct_telemetry` (`payesh_direct.telemetry_ingest`) · آزمون: `tests/telemetry-80.js` (TM-01..TM-14) · CI: `api-contract.yml` گام «Telemetry without PII (row 80)».

## ۱. ساختار رویداد = allowlist بسته
| فیلد | نوع/الگو | توضیح |
|---|---|---|
| `v` | 1 | نسخهٔ قرارداد |
| `type` | `error` \| `crash` \| `sync_failure` \| `perf` | |
| `code` | `^[a-z][a-z0-9_.]{0,63}$` | کد ماشینی خطا (مثل `DirectError.code`) — **هرگز متن پیام** |
| `where` | `^[a-z][a-z0-9_./-]{0,63}$` | شناسهٔ صفحه/مؤلفه |
| `platform` | `android` \| `windows` \| `web` | |
| `app_version` | semver | |
| `count` | عدد صحیح ۰..۹۹۹۹۹۹ | |
| `duration_ms` | عدد صحیح | |

هیچ فیلدی برای نام، کد ملی، تلفن، ایمیل، نشانی، شناسهٔ کاربر/دانش‌آموز/مدرسه/دستگاه یا متن آزاد وجود ندارد. مدرسه و دستگاه از **توکن** می‌آیند، نه از رویداد.

## ۲. سه لایه، یک allowlist
1. **کلاینت** (`client/telemetry.js`): رویداد از فیلدهای مجاز **از نو ساخته** می‌شود؛ `message`، `stack`، `name`، `national_id`، `phone`… هرگز کپی نمی‌شوند. از یک `Error` فقط `code` می‌ماند. رشتهٔ دارای ۷+ رقم پیاپی، `@` یا فاصله دور ریخته می‌شود.
2. **سرور** (`telemetry_ingest`، SECURITY DEFINER): هر کلید بیرون از allowlist ⇒ کل دسته رد (`field_not_allowed`)؛ مقدار مشکوک ⇒ `pii_suspected`؛ نوع/الگوی نادرست ⇒ `bad_value`.
3. **جدول** `telemetry_event`: فقط ستون‌های تایپ‌شده؛ هیچ ستون jsonb/متن آزاد. کلاینت هیچ دسترسی مستقیمی به جدول‌ها ندارد (RLS بدون policy، بدون grant).

آزمون TM-01 برابری سه لایه را می‌سنجد و **TM-03 (منفی)**: افزودن `national_id`، `student_name`، `phone`، `message`، باز کردن schema یا افزودن ستون jsonb ⇒ قرمز (۶ جهش). TM-14: اگر بررسی allowlist از تابع برداشته شود، رویداد با `national_id` پذیرفته می‌شود (کنترل باربر است).

## ۳. رضایت (opt-in)
- پیش‌فرض **خاموش**؛ کلید محلی `payesh.telemetry.consent = "1"`. بدون رضایت هیچ چیز ثبت یا ارسال نمی‌شود و لغو رضایت صف را همان لحظه پاک می‌کند (TM-04).
- سرور هم بدون `p_consent = true` رد می‌کند (`consent_required`) — دفاع در عمق (TM-10).
- اتصال کلید رضایت به صفحهٔ تنظیمات اپ (وب/بومی) بخشی از موج‌های صفحات ردیف ۷۴ است؛ ماژول و API آن (`setConsent`) آماده است.

## ۴. محدودیت نرخ
| سقف | مقدار |
|---|---|
| رویداد در هر فراخوانی | ۲۰ (`too_many_events`) |
| هر دستگاه | ۶۰ در ساعت (`telemetry_rate_limited`، دستهٔ اتمی) |
| هر مدرسه | ۲۰۰۰ در ساعت |
کلاینت هم همین سقف‌ها را رعایت می‌کند (TM-06)؛ سرور مرجع است (TM-11).

## ۵. ارسال
فقط `provider.rpc('telemetry_ingest', [events, true])` روی مسیر مستقیم (`client/provider-postgrest.js` این RPC را allowlist کرده). بدون provider مستقیم، گزارشگر هیچ کاری نمی‌کند؛ مسیری در Gateway وجود ندارد. پنتست ردیف ۱۰۹ روی 0007 اجرا می‌شود و `telemetry_ingest` تنها RPC افزوده است (PT-07).

## ۶. شواهد [S]
`docs/cloud/reports/evidence/80-telemetry.txt` — `TELEMETRY-80-OK checks=14` روی PostgreSQL 16.9؛ به‌علاوهٔ `RLS109_TO=0007` (PT-01..PT-10 سبز، ۲۳ RPC)، `direct-sync-108` روی 0007، `transport-110` و مانور بازیابی ۱۱۱ (`BACKUP-DRILL-111-OK`).

## ۷. OWNER
- سیاست نگه‌داری رویدادها (پیشنهاد: ۹۰ روز) و اینکه چه کسی گزارش‌ها را در پنل مالک می‌بیند.
- متن رضایت‌نامهٔ کاربر (فارسی) برای صفحهٔ تنظیمات.
