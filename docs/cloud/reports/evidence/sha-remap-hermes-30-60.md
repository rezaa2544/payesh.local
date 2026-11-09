# نگاشت SHA — گزارش ردیف‌های ۳۰–۶۰ (هرمس)

**تاریخ:** ۱۴۰۵-۰۸-۱۹ (۲۰۲۶-۱۱-۰۹) · **مرجع:** `origin/main` @ `6c92167`
**دلیل:** گزارش قدیمی نوشته بود «هر ۷ SHA روی main تأیید شد». این **نادرست** بود: SHAهای قدیمی هرگز روی GitHub نبودند؛ محتوا با SHAهای جدید (پس از rebase روی `origin/main` ۲۹fc553) از طریق PR #131 ادغام شد.

## ۱) کامیت‌های بازیابی‌شده (PR #131 —MERGED)

| SHA قدیمی (گزارش محلی) | SHA جدید روی main | موضوع | دستور تأیید | وضعیت |
|---|---|---|---|---|
| `91614a0` | `ae79f99` | ردیف ۵۵: سقف نمونهٔ مرکزی PG واقعی | `git branch -r --contains ae79f99` → `origin/main` ✓ | ادغام‌شده |
| `6b40039` | `4915222` | ردیف ۵۵: نهایی‌سازی Go/No-Go | `git branch -r --contains 4915222` → `origin/main` ✓ | ادغام‌شده |
| `498a6cf` | `8a8a6da` | ردیف ۵۱: ریشه‌یابی ریستارت پایلوت | `git branch -r --contains 8a8a6da` → `origin/main` ✓ | ادغام‌شده |
| `3c9fca0` | `6952442` | ردیف ۴۵/۴۶/۵۰: دروازه‌ها روی PG واقعی | `git branch -r --contains 6952442` → `origin/main` ✓ | ادغام‌شده |
| `4e54e8e` | `39f7aa8` | ردیف ۵۷: پنتست خودکار کامل | `git branch -r --contains 39f7aa8` → `origin/main` ✓ | ادغام‌شده |
| `e16d93f` | `ce12a6a` | ردیف ۵۷: رفع یک‌خطی نشت password_enc | `git branch -r --contains ce12a6a` → `origin/main` ✓ | ادغام‌شده (رفع کامل allowlist در PR #135) |
| `8a0e940` | `338f2a4` | ردیف ۵۱/۵۷: ثبت تصمیم رسمی مالک | `git branch -r --contains 338f2a4` → `origin/main` ✓ | ادغام‌شده |

**تأیید کلی:** همهٔ SHAهای جدول بالا پاسخ `git branch -r --contains <sha> | grep origin/main` مثبت می‌دهند (اجرای ۱۴۰۵-۰۸-۱۹). SHAهای قدیمی (`91614a0` … `8a0e940`) **روی GitHub وجود ندارند** — `git ls-remote origin` و `git branch -r --contains` برای آن‌ها خروجی خالی می‌دهند.

## ۲) شاخه‌های باز (پس از PR #131)

| شاخه | SHA روی GitHub (`git ls-remote origin <branch>`) | PR | وضعیت (۱۴۰۵-۰۸-۱۹) |
|---|---|---|---|
| `hermes/fix-57-leak` | `fe130ae9efad3570913caca2f88640761a1cc840` | #135 | OPEN — allowlist کامل نشت + کار A (national_id) |
| `hermes/labels-55-docs` | `e464e5c6f3ed55a2f4ccf990802c55afe1a2771a` | #136 | OPEN — اصلاح برچسب‌ها + سند ۵۵ |
| `hermes/risks-50-51` | `6747d0780b7b575a5ae2e8b8798bbcc96d439258` | #137 | OPEN — پیش‌فرض ایمن آپدیت + رفع تایمر + ریسک RPO |

## ۳) جمع‌بندی صادقانه

- محتوای ۷ کامیت گم‌شده به‌صورت **SHAهای جدید** روی `main` تأیید شد (نه SHAهای قدیمی).
- سه کار همچنان «OPEN» هستند تا ادغام توسط مالک/Arena؛ تا آن زمان روی main: allowlist کامل نشستگی نیست، سند ۵۵ هنوز متن قدیم دارد، پیش‌فرض ایمن به‌روزرسانی اعمال نشده.
- این فایل خود به‌عنوان شاخهٔ `hermes/sha-remap` (PR جداگانه) ارائه می‌شود.
