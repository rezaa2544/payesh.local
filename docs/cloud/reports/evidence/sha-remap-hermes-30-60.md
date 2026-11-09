# نگاشت SHA و وضعیت شاخه‌ها — ردیف‌های ۳۰–۶۰

**تاریخ برداشت طبق محیط نشست:** ۲۰۲۶-۱۰-۳۰ UTC · **مرجع فعلی هنگام استخراج:** `origin/main` @ `15d2ab758ea0bc3df4bc1301f979f0d738c7d400`.

> فهرست شاخه‌ها فقط یک عکس لحظه‌ای است و پس از هر push یا rebase کهنه می‌شود؛ مرجع زنده برای SHA شاخه‌ها `git ls-remote origin 'refs/heads/hermes/*'` است. وضعیت PR از GitHub REST گرفته شده است.

## ۱) هفت نگاشت تاریخی PR #131

هفت SHA جدید با `git merge-base --is-ancestor <SHA> origin/main` تأیید شدند؛ هر فرمان exit 0 داد. هفت SHA قدیمی با GitHub API (`GET /repos/rezaa2544/payesh.local/commits/<SHA>`) همگی HTTP 422 و پیام `No commit found for SHA` دادند. خود SHAهای قدیمی و نگاشت‌ها دست‌نخورده حفظ شده‌اند.

| SHA قدیمیِ گزارش محلی | SHA ادغام‌شده | موضوع | تأیید روی `origin/main` |
|---|---|---|---|
| `91614a0` | `ae79f99` | ردیف ۵۵: سقف نمونهٔ مرکزی PostgreSQL واقعی | `ON_ORIGIN_MAIN` |
| `6b40039` | `4915222` | ردیف ۵۵: نهایی‌سازی Go/No-Go | `ON_ORIGIN_MAIN` |
| `498a6cf` | `8a8a6da` | ردیف ۵۱: ریشه‌یابی ریستارت پایلوت | `ON_ORIGIN_MAIN` |
| `3c9fca0` | `6952442` | ردیف‌های ۴۵/۴۶/۵۰: دروازه‌ها روی PostgreSQL واقعی | `ON_ORIGIN_MAIN` |
| `4e54e8e` | `39f7aa8` | ردیف ۵۷: پنتست خودکار | `ON_ORIGIN_MAIN` |
| `e16d93f` | `ce12a6a` | ردیف ۵۷: رفع نشت `password_enc` | `ON_ORIGIN_MAIN`؛ سیاست تکمیلی در PR #135 |
| `8a0e940` | `338f2a4` | ردیف‌های ۵۱/۵۷: تصمیم مالک | `ON_ORIGIN_MAIN` |

**خروجی خام تأیید:** هفت مورد بالا هرکدام `ON_ORIGIN_MAIN`؛ هفت SHA قدیمی هرکدام HTTP 422 با پیام `No commit found for SHA`.

## ۲) شاخه‌های Hermes روی GitHub

خروجی دقیق `git ls-remote origin 'refs/heads/hermes/*'` در برداشت بالا:

```text
fbf1f461fe7cdb51d49776ffe1d9f89d6f9efdd4  refs/heads/hermes/fix-57-leak
5f505e410d223e2bffccde5d6879de662f2efaa7  refs/heads/hermes/historical-gates
ce02a962508c1dcb9b44e5350467798260dbd8de  refs/heads/hermes/labels-55-docs
934b2919db1db71294420fd2e8300180eb4362c9  refs/heads/hermes/owner-rows-51-58
338f2a44931dd5343cdbd7910ac22c2b437cc668  refs/heads/hermes/recover-rows-45-58
ecd67a6277ffe585e29942a536284241b693843a  refs/heads/hermes/risks-50-51
254af5f5028a102775cdbec27259ba7b0150a648  refs/heads/hermes/sha-remap
```

| شاخه | SHA زنده | PR | وضعیت واقعی PR / merge SHA |
|---|---|---|---|
| `hermes/fix-57-leak` | `fbf1f461fe7cdb51d49776ffe1d9f89d6f9efdd4` | #135 | ادغام‌شده؛ `38934721a1ddd6f790407515f7e45859e8867fef` |
| `hermes/labels-55-docs` | `ce02a962508c1dcb9b44e5350467798260dbd8de` | #136 | ادغام‌شده؛ `1c0c4f52f7a2163797e83e5602fd9942bdbadd6c` |
| `hermes/risks-50-51` | `ecd67a6277ffe585e29942a536284241b693843a` | #137 | باز؛ شاخهٔ قدیمی و متعارض، جایگزینی در حال آماده‌سازی روی شاخهٔ فعال |
| `hermes/sha-remap` | `254af5f5028a102775cdbec27259ba7b0150a648` | #138 | بسته؛ گزارش جایگزین در PR #143 ادغام شد (`15d2ab758ea0bc3df4bc1301f979f0d738c7d400`) |
| `hermes/historical-gates` | `5f505e410d223e2bffccde5d6879de662f2efaa7` | #140 | بسته؛ کار جایگزین در PR #142 ادغام شد (`afca62a5cfc4ef5c86e6abe86c120bcd9670382e`) |
| `hermes/owner-rows-51-58` | `934b2919db1db71294420fd2e8300180eb4362c9` | #114 | ادغام‌شده؛ `803b2a7706507f4ca9babd79ec67621dcb8ca680` |
| `hermes/recover-rows-45-58` | `338f2a44931dd5343cdbd7910ac22c2b437cc668` | #131 | ادغام‌شده؛ `892206f650eeac95777f7beb7d27601aaa2f75c2` |

در همین برداشت، PR #141 با merge SHA `3bc8b90727852ca7f3a70df8d8c5a5a17b5deb5b`، PR #142 با `afca62a5cfc4ef5c86e6abe86c120bcd9670382e` و PR #143 با `15d2ab758ea0bc3df4bc1301f979f0d738c7d400` ادغام شده‌اند.

## ۳) جمع‌بندی

- ادعای قدیمی «هر هفت SHA قدیمی روی GitHub هستند» نادرست بود؛ برای هر هفت SHA قدیمی REST پاسخ `422 No commit found for SHA` داد، درحالی‌که هر هفت SHA جایگزین روی `origin/main` هستند.
- #135، #136، #141، #142 و #143 ادغام شده‌اند؛ #137 هنوز باز است و شاخهٔ قدیمی آن متعارض است. #138 بسته شد و #140 بسته شد.
- پس از هر ادغام یا rebase باید این جدول با `git ls-remote` و GitHub REST دوباره ساخته شود؛ این سند مرجع زندهٔ شاخه‌ها نیست.
